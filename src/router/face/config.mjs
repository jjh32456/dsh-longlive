// routerFace v1 · 配置归一化（纯函数：不读文件、不建目录、不写日志）。
//
// 配置形状（插件 config 里的一块，不使用 router* 长键别名）：
//
//   routerFace:
//     enabled: false            # 默认关闭；关闭时零定时器、零目录、零 IO
//     tickMs: 60000             # 30s .. 15min
//     dailyTokenBudget: 50000   # 每个本地日最多花多少 token
//     maxContextTokens: 30000   # 每个 tick 组装进 prompt 的硬上限
//     dryRun: true              # 默认只写 journal，不调 LLM
//     provider: ''              # 空 = 交给宿主的默认 provider
//     model: auto               # auto = 交给宿主解析
//     maxSuggestions: 3
//
// 严格布尔：只有 === true / === false 才算开/关，字符串 "true" 和 1 都会
// 回默认并留下警告。这与 RouterService 的既有约定一致，避免 YAML 手滑把
// 后台面打开。

export const FACE_CONFIG_VERSION = 1;

export const FACE_DEFAULTS = Object.freeze({
  enabled: true,
  tickMs: 60000,
  dailyTokenBudget: 50000,
  maxContextTokens: 30000,
  dryRun: true,
  provider: '',
  model: 'auto',
  maxSuggestions: 3,
});

export const FACE_CONFIG_KEYS = Object.freeze([
  'enabled',
  'tickMs',
  'dailyTokenBudget',
  'maxContextTokens',
  'dryRun',
  'provider',
  'model',
  'maxSuggestions',
]);

export const FACE_INT_SPECS = Object.freeze({
  tickMs: [30000, 900000],
  dailyTokenBudget: [1000, 5000000],
  maxContextTokens: [2000, 300000],
  maxSuggestions: [0, 10],
});

/** 一个 tick 组装上下文的硬预算；1200 只用于兜底，不来自配置。 */
export const FACE_HARD_CONTEXT_FLOOR = 2000;
export const FACE_JOURNAL_CONTEXT_ROWS = 5;
export const FACE_TODO_LIMIT = 10;
export const FACE_MAX_JOURNAL_CHARS = 400;
export const FACE_MAX_SUGGESTION_CHARS = 200;
export const FACE_MAX_HINT_CHARS = 300;
export const FACE_MAX_OUTPUT_TOKENS = 1024;
export const FACE_MAX_CONSECUTIVE_FAILURES = 3;
export const FACE_FIRST_TICK_MS = 3000;
export const FACE_TICK_TASK = 'router-face';
export const FACE_SESSION_HINT = 'root';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pushWarning(warnings, warning) {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function boolValue(raw, key, warnings) {
  if (raw[key] === undefined) return FACE_DEFAULTS[key];
  if (raw[key] === true || raw[key] === false) return raw[key];
  pushWarning(warnings, `FACE_CONFIG_INVALID:${key}`);
  return FACE_DEFAULTS[key];
}

function intValue(raw, key, min, max, warnings) {
  if (raw[key] === undefined) return FACE_DEFAULTS[key];
  const value = raw[key];
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  pushWarning(warnings, `FACE_CONFIG_INVALID:${key}`);
  return FACE_DEFAULTS[key];
}

function stringValue(raw, key, warnings) {
  if (raw[key] === undefined) return FACE_DEFAULTS[key];
  if (typeof raw[key] !== 'string') {
    pushWarning(warnings, `FACE_CONFIG_INVALID:${key}`);
    return FACE_DEFAULTS[key];
  }
  return raw[key].trim();
}

/**
 * 归一化 `config.routerFace`。
 *
 * @param {object|undefined|null} raw 插件 config 里的 routerFace 块
 * @param {{memoryRoot?: string|null}} [options] 只用于记录解析结果，不读文件
 * @returns {object} 归一化配置 + warnings + memoryRoot
 */
export function normalizeFaceConfig(raw, options = {}) {
  const warnings = [];
  const memoryRoot = typeof options.memoryRoot === 'string' && options.memoryRoot !== ''
    ? options.memoryRoot
    : null;
  let source = raw;
  if (raw === undefined || raw === null) {
    source = {};
  } else if (!isPlainObject(raw)) {
    pushWarning(warnings, 'FACE_CONFIG_NOT_OBJECT');
    source = {};
  }

  for (const key of Object.keys(source)) {
    if (!FACE_CONFIG_KEYS.includes(key)) pushWarning(warnings, `FACE_CONFIG_UNKNOWN:${key}`);
  }

  const result = {
    version: FACE_CONFIG_VERSION,
    enabled: boolValue(source, 'enabled', warnings),
    tickMs: intValue(source, 'tickMs', FACE_INT_SPECS.tickMs[0], FACE_INT_SPECS.tickMs[1], warnings),
    dailyTokenBudget: intValue(
      source,
      'dailyTokenBudget',
      FACE_INT_SPECS.dailyTokenBudget[0],
      FACE_INT_SPECS.dailyTokenBudget[1],
      warnings,
    ),
    maxContextTokens: intValue(
      source,
      'maxContextTokens',
      FACE_INT_SPECS.maxContextTokens[0],
      FACE_INT_SPECS.maxContextTokens[1],
      warnings,
    ),
    dryRun: boolValue(source, 'dryRun', warnings),
    provider: stringValue(source, 'provider', warnings),
    model: stringValue(source, 'model', warnings),
    maxSuggestions: intValue(
      source,
      'maxSuggestions',
      FACE_INT_SPECS.maxSuggestions[0],
      FACE_INT_SPECS.maxSuggestions[1],
      warnings,
    ),
  };
  if (result.model === '') result.model = FACE_DEFAULTS.model;
  // providerExplicit is consumed by resolveModelTarget; a value that survived
  // normalization must not be mistaken for a default.
  result.providerExplicit = result.provider !== '';
  result.memoryRoot = memoryRoot;
  result.warnings = warnings;
  return result;
}
