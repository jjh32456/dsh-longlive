// RouterService 配置归一化（DESIGN §8.1，50 键）。
//
// 全部是扁平键；未知键忽略并留下 warning；任何一个值非法都退回默认值并留
// 下 warning，而不是让插件因为一个坏配置起不来（F13）。routerEnabled 只接受
// 布尔 true，字符串 "true" / 1 一律不算开启——这是「默认关闭」的最后一道闸。
//
// 写回只用新键：routerMergeEnabled -> routerL4MergeEnabled、
// routerProposalsEnabled -> routerProposalEnabled、routerLeaseTtlMs ->
// routerWriterLeaseMs 都只读旧键做迁移，归一化结果只带新键。

export const ROUTER_CONFIG_VERSION = 1;

export const ROUTER_DEFAULTS = Object.freeze({
  enabled: true,
  provider: 'deepseek-official',
  model: 'auto',
  tickMs: 60000,
  reflectOnTurn: true,
  reflectCoalesceMs: 300000,
  autonomy: 'report',
  allowAgent: false,
  maxTokensPerRun: 80000,
  maxTokensPerDay: 1000000,
  callMaxTokens: 2048,
  maxAttempts: 2,
  maxConsecutiveErrors: 3,
  anchorPath: '',
  stopFile: '',
  allowMissingAnchor: false,
  vaultDir: '',
  agentTimeoutMs: 15000,
  disposeTimeoutMs: 2000,
  flowSlice: 1200,
  sharedBoard: true,
  hintScope: 'root',
  hintTokens: 700,
  reflectHintTokens: 150,
  injectEveryTurns: 10,
  injectStateMaxSessions: 512,
  injectMaxPerSessionPerDay: 24,
  injectMaxTotalTokens: 12000,
  liveRowsMax: 128,
  boardMaxSessions: 5,
  proposalEnabled: true,
  applyEnabled: false,
  l4MergeEnabled: true,
  proposalMaxChars: 4000,
  proposalsPerSessionHour: 6,
  maxProposals: 200,
  agingSeconds: 120,
  leaseRenewMax: 2,
  leaseWaitTimeoutMs: 300000,
  blockedOnUserTtlMs: 86400000,
  proposalTtlH: 72,
  wakeEnabled: true,
  wakeCooldownMs: 600000,
  wakeDailyQuota: 20,
  wakeLogMaxBytes: 33554432,
  starvationAlertMs: 600000,
  queueMaxBytes: 65536,
  walMaxBytes: 2097152,
  writerLeaseMs: 120000,
  snapshotKeepDays: 30,
});

// 短键 -> 公开长键。顺序即 status/文档顺序，测试会断言键数。
export const ROUTER_CONFIG_KEYS = Object.freeze({
  enabled: 'routerEnabled',
  provider: 'routerProvider',
  model: 'routerModel',
  tickMs: 'routerTickMs',
  reflectOnTurn: 'routerReflectOnTurn',
  reflectCoalesceMs: 'routerReflectCoalesceMs',
  autonomy: 'routerAutonomy',
  allowAgent: 'routerAllowAgent',
  maxTokensPerRun: 'routerMaxTokensPerRun',
  maxTokensPerDay: 'routerMaxTokensPerDay',
  callMaxTokens: 'routerCallMaxTokens',
  maxAttempts: 'routerMaxAttempts',
  maxConsecutiveErrors: 'routerMaxConsecutiveErrors',
  anchorPath: 'routerAnchorPath',
  stopFile: 'routerStopFile',
  allowMissingAnchor: 'routerAllowMissingAnchor',
  vaultDir: 'routerVaultDir',
  agentTimeoutMs: 'routerAgentTimeoutMs',
  disposeTimeoutMs: 'routerDisposeTimeoutMs',
  flowSlice: 'routerFlowSlice',
  sharedBoard: 'routerSharedBoard',
  hintScope: 'routerHintScope',
  hintTokens: 'routerHintTokens',
  reflectHintTokens: 'routerReflectHintTokens',
  injectEveryTurns: 'routerInjectEveryTurns',
  injectStateMaxSessions: 'routerInjectStateMaxSessions',
  injectMaxPerSessionPerDay: 'routerInjectMaxPerSessionPerDay',
  injectMaxTotalTokens: 'routerInjectMaxTotalTokens',
  liveRowsMax: 'routerLiveRowsMax',
  boardMaxSessions: 'routerBoardMaxSessions',
  proposalEnabled: 'routerProposalEnabled',
  applyEnabled: 'routerApplyEnabled',
  l4MergeEnabled: 'routerL4MergeEnabled',
  proposalMaxChars: 'routerProposalMaxChars',
  proposalsPerSessionHour: 'routerProposalsPerSessionHour',
  maxProposals: 'routerMaxProposals',
  agingSeconds: 'routerAgingSeconds',
  leaseRenewMax: 'routerLeaseRenewMax',
  leaseWaitTimeoutMs: 'routerLeaseWaitTimeoutMs',
  blockedOnUserTtlMs: 'routerBlockedOnUserTtlMs',
  proposalTtlH: 'routerProposalTtlH',
  wakeEnabled: 'routerWakeEnabled',
  wakeCooldownMs: 'routerWakeCooldownMs',
  wakeDailyQuota: 'routerWakeDailyQuota',
  wakeLogMaxBytes: 'routerWakeLogMaxBytes',
  starvationAlertMs: 'routerStarvationAlertMs',
  queueMaxBytes: 'routerQueueMaxBytes',
  walMaxBytes: 'routerWalMaxBytes',
  writerLeaseMs: 'routerWriterLeaseMs',
  snapshotKeepDays: 'routerSnapshotKeepDays',
});

// 旧键 -> 新短键。只读迁移，写回只用新键（DESIGN §8.1 迁移注记）。
export const ROUTER_CONFIG_ALIASES = Object.freeze({
  routerMergeEnabled: 'l4MergeEnabled',
  mergeEnabled: 'l4MergeEnabled',
  routerProposalsEnabled: 'proposalEnabled',
  proposalsEnabled: 'proposalEnabled',
  routerLeaseTtlMs: 'writerLeaseMs',
  leaseTtlMs: 'writerLeaseMs',
});

// 已删除键：仍接受输入以免旧配置直接报错，但忽略并 warning。
export const ROUTER_CONFIG_REMOVED = Object.freeze(['routerMaxQueue', 'maxQueue']);

// 其它插件自己的键也以 router 开头，不能当成未知配置告警。
const NON_CONFIG_ROUTER_KEYS = new Set([
  'routerRuntime',
  'routerRuntimeStatePath',
  'routerRuntimeMaxRecords',
  'routerPolicyProfile',
  // v1 后台面配置块（src/router/face/config.mjs 自己归一化）。
  'routerFace',
  // Test-only seam; index.js rejects it outside a test build.
  'routerTestHooks',
]);

const INT_SPECS = Object.freeze({
  tickMs: [30000, 900000],
  reflectCoalesceMs: [60000, 3600000],
  maxTokensPerRun: [5000, 500000],
  maxTokensPerDay: [5000, 2000000],
  callMaxTokens: [256, 4096],
  maxAttempts: [1, 3],
  maxConsecutiveErrors: [1, 20],
  agentTimeoutMs: [1000, 120000],
  disposeTimeoutMs: [100, 30000],
  flowSlice: [0, 2000],
  injectEveryTurns: [1, 100],
  injectStateMaxSessions: [32, 4096],
  injectMaxPerSessionPerDay: [1, 200],
  injectMaxTotalTokens: [1000, 100000],
  liveRowsMax: [16, 1024],
  boardMaxSessions: [1, 12],
  proposalMaxChars: [500, 8000],
  proposalsPerSessionHour: [1, 60],
  maxProposals: [20, 1000],
  agingSeconds: [10, 600],
  leaseRenewMax: [0, 5],
  leaseWaitTimeoutMs: [1000, 1800000],
  blockedOnUserTtlMs: [3600000, 604800000],
  proposalTtlH: [1, 720],
  wakeCooldownMs: [60000, 3600000],
  wakeDailyQuota: [1, 200],
  wakeLogMaxBytes: [1048576, 268435456],
  starvationAlertMs: [60000, 86400000],
  queueMaxBytes: [8192, 1048576],
  walMaxBytes: [262144, 16777216],
  snapshotKeepDays: [1, 365],
});

// DESIGN 明文要求「夹回范围」而不是「非法回默认」的三把键。
const CLAMP_SPECS = Object.freeze({
  hintTokens: [200, 700],
  reflectHintTokens: [50, 150],
  writerLeaseMs: [60000, 120000],
});

const BOOL_KEYS = Object.freeze([
  'enabled',
  'reflectOnTurn',
  'allowAgent',
  'allowMissingAnchor',
  'sharedBoard',
  'proposalEnabled',
  'applyEnabled',
  'l4MergeEnabled',
  'wakeEnabled',
]);

const STRING_KEYS = Object.freeze([
  'anchorPath',
  'stopFile',
  'vaultDir',
]);

const ENUM_SPECS = Object.freeze({
  autonomy: ['report', 'draft'],
  hintScope: ['root', 'all', 'off'],
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pushWarning(warnings, warning) {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function boolValue(raw, key, warnings) {
  if (raw[key] === undefined) return ROUTER_DEFAULTS[key];
  if (raw[key] === true || raw[key] === false) return raw[key];
  pushWarning(warnings, `CONFIG_INVALID:${key}`);
  return ROUTER_DEFAULTS[key];
}

function intValue(raw, key, min, max, warnings) {
  if (raw[key] === undefined) return ROUTER_DEFAULTS[key];
  const value = raw[key];
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  pushWarning(warnings, `CONFIG_INVALID:${key}`);
  return ROUTER_DEFAULTS[key];
}

function clampValue(raw, key, min, max, warnings) {
  if (raw[key] === undefined) return ROUTER_DEFAULTS[key];
  const value = raw[key];
  if (!Number.isInteger(value)) {
    pushWarning(warnings, `CONFIG_INVALID:${key}`);
    return ROUTER_DEFAULTS[key];
  }
  if (value < min) {
    pushWarning(warnings, `CONFIG_CLAMPED:${key}`);
    return min;
  }
  if (value > max) {
    pushWarning(warnings, `CONFIG_CLAMPED:${key}`);
    return max;
  }
  return value;
}

function stringValue(raw, key, warnings) {
  if (raw[key] === undefined) return ROUTER_DEFAULTS[key];
  const value = raw[key];
  if (typeof value !== 'string') {
    pushWarning(warnings, `CONFIG_INVALID:${key}`);
    return ROUTER_DEFAULTS[key];
  }
  return value.trim();
}

function enumValue(raw, key, allowed, warnings) {
  if (raw[key] === undefined) return ROUTER_DEFAULTS[key];
  if (allowed.includes(raw[key])) return raw[key];
  pushWarning(warnings, `CONFIG_INVALID:${key}`);
  return ROUTER_DEFAULTS[key];
}

/**
 * 把插件 config 里的 router* 键归一化。纯函数：不读文件、不建目录、不写日志。
 *
 * 注意 provider/model 的空字符串会被保留：DESIGN §8.3 要求启动时以
 * E_NO_PROVIDER 失败，而不是悄悄换回默认模型。
 *
 * @param {object} config
 * @returns {object}
 */
export function normalizeRouterConfig(config) {
  const source = isPlainObject(config) ? config : {};
  const warnings = [];

  // 1) 先收集未知的 router* 键。插件还有 routerRuntime 等非配置键，排除。
  const knownLong = new Set(Object.values(ROUTER_CONFIG_KEYS));
  for (const key of Object.keys(ROUTER_CONFIG_ALIASES)) knownLong.add(key);
  for (const key of ROUTER_CONFIG_REMOVED) knownLong.add(key);
  for (const key of Object.keys(source)) {
    if (!key.startsWith('router')) continue;
    if (knownLong.has(key) || NON_CONFIG_ROUTER_KEYS.has(key)) continue;
    pushWarning(warnings, `CONFIG_UNKNOWN:${key}`);
  }

  // 2) 旧键迁移：新键优先；只写回新键。
  const raw = {};
  for (const [short, long] of Object.entries(ROUTER_CONFIG_KEYS)) {
    raw[short] = source[short] !== undefined ? source[short] : source[long];
  }
  for (const [oldKey, short] of Object.entries(ROUTER_CONFIG_ALIASES)) {
    if (raw[short] !== undefined) continue;
    if (source[oldKey] === undefined) continue;
    raw[short] = source[oldKey];
    pushWarning(warnings, `CONFIG_MIGRATED:${oldKey}`);
  }
  for (const removed of ROUTER_CONFIG_REMOVED) {
    if (source[removed] !== undefined) pushWarning(warnings, `CONFIG_DEPRECATED:${removed}`);
  }

  // 3) provider/model：空串保留，非字符串回默认。
  const provider = raw.provider === undefined
    ? ROUTER_DEFAULTS.provider
    : (typeof raw.provider === 'string'
      ? raw.provider.trim()
      : (pushWarning(warnings, 'CONFIG_INVALID:provider'), ROUTER_DEFAULTS.provider));
  const model = raw.model === undefined
    ? ROUTER_DEFAULTS.model
    : (typeof raw.model === 'string'
      ? raw.model.trim()
      : (pushWarning(warnings, 'CONFIG_INVALID:model'), ROUTER_DEFAULTS.model));

  // 3b) providerExplicit：WP5 必须在归一化之前记住「用户是否显式指定 provider」。
  // 归一化后的 provider 永远有值，不能再靠它判断。第二次归一化（index.js 已归一
  // 化过、服务内部又归一化）会看到布尔值，直接沿用，避免把默认值误判为显式。
  const providerExplicit = typeof source.providerExplicit === 'boolean'
    ? source.providerExplicit
    : (typeof raw.provider === 'string' && raw.provider.trim() !== '');

  // 4) 其余键。
  const result = {
    version: ROUTER_CONFIG_VERSION,
    enabled: boolValue(raw, 'enabled', warnings),
    provider,
    model,
    providerExplicit,
  };

  for (const key of Object.keys(ROUTER_CONFIG_KEYS)) {
    if (key === 'enabled' || key === 'provider' || key === 'model') continue;
    if (BOOL_KEYS.includes(key)) {
      result[key] = boolValue(raw, key, warnings);
    } else if (STRING_KEYS.includes(key)) {
      result[key] = stringValue(raw, key, warnings);
    } else if (ENUM_SPECS[key]) {
      result[key] = enumValue(raw, key, ENUM_SPECS[key], warnings);
    } else if (CLAMP_SPECS[key]) {
      result[key] = clampValue(raw, key, CLAMP_SPECS[key][0], CLAMP_SPECS[key][1], warnings);
    } else if (INT_SPECS[key]) {
      result[key] = intValue(raw, key, INT_SPECS[key][0], INT_SPECS[key][1], warnings);
    }
  }

  result.warnings = warnings;
  return result;
}

/**
 * 插件 config 使用 routerEnabled 等公开键；内部服务直接使用归一化后的短键。
 * 这里把两种形状统一起来，方便测试与调用方。
 *
 * @param {object} config
 * @returns {ReturnType<typeof normalizeRouterConfig>}
 */
export function normalizeRouterConfigFromPlugin(config = {}) {
  return normalizeRouterConfig(isPlainObject(config) ? config : {});
}
