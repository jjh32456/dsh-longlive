// R1 Router-A — 规则层（纯函数）；出错即停，绝不放行。
//
// 契约见 R1-DESIGN.md §2.1 / §3.3 / §5：
//   route({
//     caseId?, turn?,
//     kind?: 'tool' | 'memory' | 'session',       // 旧入口字段
//     text? | utterance?,                          // 旧入口用 text，新契约用 utterance
//     ctx?: { tokens?, zone?, activeWorkers?, openRows? },
//     candidates?: Array<string | { tool?, name? }>,
//     override? | overrides?: Array<{ ruleId, reason, by?, at?, action? }>,
//   }) -> {
//     caseId, turn,
//     decisions: Array<{ kind, action, args, ruleId, evidence, writeScope, target, tool, needsHuman, confidence }>,
//     needsHuman, confidence, matchedRule, matchedRules,
//     overrides, overrideAudit, errors,
//     decision: { target, tool }, target, tool,        // 旧输出契约的兼容别名
//     level, ctx, failClosed?,
//   }
//
// target 取值：core 目标（topics/journal/procedures/live/none）+ adapter 注册的第三方目标
// decision.kind 取值：tool | memory | session | reply
//
// 四条硬性质：
//   1. 纯净：不读时钟、不写盘、不碰网络；同样输入（含 override.at）永远同样输出。
//   2. 全函数：任何畸形输入（null / 非字符串 / getter 炸弹 / 10 万字符）退化为 none，不抛错。
//   3. 可解释：每条决定带 ruleId + evidence（规则表:行 / policy:文档 §节 / ctx:字段）。
//   4. 可兼容：decisions[] 是新的有序契约；decision/target/tool 是旧契约的别名，旧测试不改。
//
// 冲突消解（§2.1）：规则按 priority 降序。**同优先级同时命中不再按文件顺序判定**：
// 判为歧义（E_ROUTE_AMBIGUOUS），整单 refuse 交人判断。
//
// fail-closed（2026-11-03 修 R1 静默放行）：规则/别名文件缺失、JSON 损坏、结构或字段错误、
// 未知 action/kind、ctx 缺字段/类型错、override 指向不存在规则、writeScope 越界、
// 决策或规则数量爆炸、以及任何内部异常，一律返回一条 refuse 决策 + needsHuman=true +
// 结构化 errors（具体错误码），不允许「空 decisions + needsHuman=false」把「没判断」交给调用方。
//
// confidence 是匹配强度的确定映射，不是概率：
//   候选工具名精确命中 -> 1
//   >= 2 个关键词命中   -> 1
//   恰好 1 个关键词命中 -> 0.75
//   纯 ctx 触发         -> 0.9
//   无匹配              -> 0

import { readFileSync } from 'node:fs';
import {
  E_ROUTE_POLICY_INVALID,
  E_ROUTE_PROFILE_UNKNOWN,
  POLICY_PROFILE_DEFAULT,
  configuredPolicyProfileName,
  loadPolicyProfile,
} from '../policy-profile.js';
import {
  loadAdapterAliases,
  loadAdapterRoutingRules,
  isExternalMemoryTarget,
} from '../adapters/registry.js';

const CORE_TARGETS = ['topics', 'journal', 'procedures', 'live', 'none'];
const ADAPTER_ROUTING = loadAdapterRoutingRules();
export const TARGETS = Object.freeze([
  ...CORE_TARGETS,
  ...(ADAPTER_ROUTING.targets || []).filter((target) => !CORE_TARGETS.includes(target)),
]);

// adapter 侧规则/别名数据不可用时：核心照常跑，只记录降级（不 fail-closed）。
export const ADAPTER_DEGRADED = Object.freeze([
  ...(ADAPTER_ROUTING.degraded ? ADAPTER_ROUTING.errors.map((error) => ({ ...error })) : []),
]);

export const KINDS = Object.freeze(['tool', 'memory', 'session', 'reply']);

export const LEVELS = Object.freeze(['X', 'D', 'H']);

// 失败码：R1 的全部 judge 只用这一张表里的码，前缀统一 E_ROUTE_；
// J8 起有两个跨层码（身份同意），按判定原文命名，不套 E_ROUTE_ 前缀。
export const ERROR_CODES = Object.freeze({
  ISOLATION: 'E_ROUTE_ISOLATION',
  SHAPE: 'E_ROUTE_SHAPE',
  ORDER: 'E_ROUTE_ORDER',
  ACTION: 'E_ROUTE_ACTION',
  REFUSAL: 'E_ROUTE_REFUSAL',
  EVIDENCE: 'E_ROUTE_EVIDENCE',
  OVERRIDE_UNJUSTIFIED: 'E_ROUTE_OVERRIDE_UNJUSTIFIED',
  OVERRIDE_UNKNOWN: 'E_ROUTE_OVERRIDE_UNKNOWN',
  SCOPE: 'E_ROUTE_SCOPE',
  AUDIT: 'E_ROUTE_AUDIT',
  HUMAN: 'E_ROUTE_HUMAN',
  POLICY: 'E_ROUTE_POLICY',
  LEVEL: 'E_ROUTE_LEVEL',
  CONTRACT: 'E_ROUTE_CONTRACT',
  DETERMINISM: 'E_ROUTE_DETERMINISM',
  FORBIDDEN: 'E_ROUTE_FORBIDDEN',
  BRIEF: 'E_ROUTE_BRIEF',
  // ── fail-closed（2026-11-03） ───────────────────────────────────────────
  RULES_UNAVAILABLE: 'E_ROUTE_RULES_UNAVAILABLE',
  RULES_INVALID: 'E_ROUTE_RULES_INVALID',
  ALIASES_UNAVAILABLE: 'E_ROUTE_ALIASES_UNAVAILABLE',
  ALIASES_INVALID: 'E_ROUTE_ALIASES_INVALID',
  RULE_FIELD: 'E_ROUTE_RULE_FIELD',
  RULE_UNKNOWN: 'E_ROUTE_RULE_UNKNOWN',
  AMBIGUOUS: 'E_ROUTE_AMBIGUOUS',
  CTX_MISSING: 'E_ROUTE_CTX_MISSING',
  CTX_TYPE: 'E_ROUTE_CTX_TYPE',
  EXPLOSION: 'E_ROUTE_EXPLOSION',
  // ── J8（2026-11-03）：身份同意 ────────────────────────────────────────
  IDENTITY_CONSENT_REQUIRED: 'E_IDENTITY_CONSENT_REQUIRED',
  SELF_CONSENT: 'E_SELF_CONSENT',
  // ── 策略 profile（2026-11-03）：默认 generic，家规可选 ──────────────────
  PROFILE_UNKNOWN: E_ROUTE_PROFILE_UNKNOWN,
  POLICY_INVALID: E_ROUTE_POLICY_INVALID,
});

// 策略 1：休息 vs 终止的机器口径由生效 profile 提供（generic 默认，owner 可补充词表）。
// REST_RE 命中且 STOP_RE 不命中才算「可恢复的短暂暂停」。
function escapeMarker(marker) {
  return String(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markersRegex(markers) {
  const list = Array.isArray(markers)
    ? markers.filter((marker) => typeof marker === 'string' && marker.trim()).map((marker) => marker.trim())
    : [];
  if (!list.length) return null;
  return new RegExp(list.map((marker) => escapeMarker(marker)).join('|'), 'i');
}

// 硬上限：展开后的决策数、规则表条数、同优先级竞争规则数。
export const LIMITS = Object.freeze({
  maxRules: 200,
  maxDecisions: 32,
  maxCompeting: 32,
});

// 规则表不可用时，refuse 决策的合成 ruleId（真实规则表里不存在，便于审计识别）。
export const FAILCLOSED_RULE_ID = 'R-ROUTER-FAILCLOSED';

// 证据里的规则定义位置：repo 相对路径，judge 用它回读文件核对行号。
export const RULE_TABLE_PATH = 'src/router/routing-rules.json';

const RULES_URL = new URL('./routing-rules.json', import.meta.url);
const ALIASES_URL = new URL('./aliases.json', import.meta.url);

// 通用默认策略在模块加载期就读：读不到/不合法由 LOAD_ERRORS 统一 fail-closed。
const GENERIC_LOAD = loadPolicyProfile(POLICY_PROFILE_DEFAULT);

function textOr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function makeError(code, message, detail = {}) {
  return { code, message, ...detail };
}

function safeGet(object, key) {
  try {
    return object[key];
  } catch {
    return undefined;
  }
}

// ── 动作名归一（aliases.json） ────────────────────────────────

function nameVariants(name) {
  const raw = textOr(name).toLowerCase();
  if (!raw) return [];
  return Array.from(new Set([raw, raw.replace(/_/g, '.'), raw.replace(/\./g, '_')]));
}

// 别名文件是动作白名单：读不到/解析不了/结构不对 → 整份不可用（fail-closed）。
export function loadAliases() {
  let text = '';
  try {
    text = readFileSync(ALIASES_URL, 'utf8');
  } catch (cause) {
    return {
      entries: [],
      byVariant: new Map(),
      errors: [makeError(ERROR_CODES.ALIASES_UNAVAILABLE, `aliases.json 读取失败：${cause.code || cause.message}，拒绝路由`)],
    };
  }
  let table;
  try {
    table = JSON.parse(text);
  } catch (cause) {
    return {
      entries: [],
      byVariant: new Map(),
      errors: [makeError(ERROR_CODES.ALIASES_INVALID, `aliases.json JSON 解析失败：${cause.message}`)],
    };
  }
  const list = table && Array.isArray(table.actions) ? table.actions : null;
  if (!list || list.length === 0) {
    return {
      entries: [],
      byVariant: new Map(),
      errors: [makeError(ERROR_CODES.ALIASES_INVALID, 'aliases.json 的 actions 必须是非空数组')],
    };
  }
  const byVariant = new Map();
  const entries = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        entries: [],
        byVariant: new Map(),
        errors: [makeError(ERROR_CODES.ALIASES_INVALID, 'aliases.json 的 actions 里有非对象条目')],
      };
    }
    const canonical = textOr(raw.canonical);
    if (!canonical) {
      return {
        entries: [],
        byVariant: new Map(),
        errors: [makeError(ERROR_CODES.ALIASES_INVALID, 'aliases.json 有条目缺 canonical')],
      };
    }
    if (seen.has(canonical)) {
      return {
        entries: [],
        byVariant: new Map(),
        errors: [makeError(ERROR_CODES.ALIASES_INVALID, `aliases.json 里 canonical 重复：${canonical}`)],
      };
    }
    seen.add(canonical);
    if (raw.legacy !== undefined && typeof raw.legacy !== 'string') {
      return {
        entries: [],
        byVariant: new Map(),
        errors: [makeError(ERROR_CODES.ALIASES_INVALID, `aliases.json 里 ${canonical} 的 legacy 必须是字符串`)],
      };
    }
    const legacy = textOr(raw.legacy) || canonical;
    if (raw.aliases !== undefined) {
      if (!Array.isArray(raw.aliases) || raw.aliases.some((alias) => typeof alias !== 'string')) {
        return {
          entries: [],
          byVariant: new Map(),
          errors: [makeError(ERROR_CODES.ALIASES_INVALID, `aliases.json 里 ${canonical} 的 aliases 必须是字符串数组`)],
        };
      }
    }
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.filter((alias) => alias.trim()).map((alias) => alias.trim())
      : [];
    entries.push({ canonical, legacy, aliases });
    for (const name of [canonical, legacy, ...aliases]) {
      for (const variant of nameVariants(name)) {
        if (!byVariant.has(variant)) byVariant.set(variant, canonical);
      }
    }
  }
  // M2-E：并入 adapter 提供的动作别名（旧工具名兼容也在 adapter 侧）。
  const adapterAliases = loadAdapterAliases();
  for (const raw of adapterAliases.actions) {
    const canonical = textOr(raw && raw.canonical);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    const legacy = textOr(raw && raw.legacy) || canonical;
    const aliases = Array.isArray(raw && raw.aliases) ? raw.aliases.filter((alias) => typeof alias === 'string' && alias.trim()).map((alias) => alias.trim()) : [];
    entries.push({ canonical, legacy, aliases });
    for (const name of [canonical, legacy, ...aliases]) {
      for (const variant of nameVariants(name)) {
        if (!byVariant.has(variant)) byVariant.set(variant, canonical);
      }
    }
  }
  return { entries, byVariant, errors: [], adapterErrors: adapterAliases.errors };
}

export const ALIASES = loadAliases();

export function canonicalAction(name) {
  if (typeof name !== 'string') return null;
  for (const variant of nameVariants(name)) {
    const hit = ALIASES.byVariant.get(variant);
    if (hit) return hit;
  }
  return null;
}

export function legacyAction(name) {
  const canonical = canonicalAction(name);
  if (!canonical) return null;
  const entry = ALIASES.entries.find((item) => item.canonical === canonical);
  return entry ? entry.legacy : canonical;
}

// ── 规则表 ────────────────────────────────────────────────────

function ruleLines(text) {
  const map = new Map();
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*"id":\s*"([^"]+)"/.exec(lines[index]);
    if (match && !map.has(match[1])) map.set(match[1], index + 1);
  }
  return map;
}

function normalizeScope(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim());
}

function normalizeEvidence(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim());
}

// 把校验过的 profile 编译成路由层使用的形状。
function policyFromProfile(policy) {
  return {
    profile: policy.name,
    compressAt: policy.thresholds.compressAt,
    redAt: policy.thresholds.redAt,
    dispatchAt: policy.thresholds.dispatchAt,
    taskboardAt: policy.thresholds.taskboardAt,
    thresholds: { ...policy.thresholds },
    allow: policy.writeScope.allowPrefixes.slice(),
    ask: policy.ask,
    rest: policy.rest,
    privacy: policy.privacy,
    distill: policy.distill,
    identity: policy.identity,
    limits: policy.limits,
    rulings: policy.rulings || [],
    raw: policy,
  };
}

// generic 都坏了的时候用的保守占位：allow=[] 让任何 writeScope 都越界，route 由 LOAD_ERRORS 拒单。
function invalidPolicy(code, message) {
  return Object.freeze({
    profile: POLICY_PROFILE_DEFAULT,
    compressAt: 0,
    redAt: 0,
    dispatchAt: Number.MAX_SAFE_INTEGER,
    taskboardAt: Number.MAX_SAFE_INTEGER,
    allow: [],
    ask: { maxQuestions: 1, maxCandidates: 3, guessAllowed: false, missing: [], prompt: '' },
    rest: {
      markers: [],
      terminators: [],
      kind: 'TEMPORARY',
      resumable: true,
      terminal: false,
      resumePoint: '',
      resumePointRequired: true,
      pendingTask: 'keep',
      forbiddenActions: [],
    },
    privacy: { markers: [], store: 'memory/private/', dataClass: 'LOCAL_ONLY', retention: 'LOCAL', echoBack: false, networkCalls: 0, uploadAllowed: false },
    distill: { preferDistill: true, deleteBeforeConfirm: false, requireSupersedes: true, maxQuestions: 1 },
    identity: { consentHolder: 'assistant', userConsentCounts: false, requireQuote: true, requireQuoteId: true },
    limits: LIMITS,
    rulings: [],
    errors: [makeError(code, message)],
  });
}

function basePolicy() {
  return GENERIC_LOAD.ok ? policyFromProfile(GENERIC_LOAD.policy) : invalidPolicy(GENERIC_LOAD.code, GENERIC_LOAD.message);
}

// 规则表里的 `$policy:<a.b.c>` 在生效 profile 上展开；展开失败 = 整表不可用（不静默留一个永不命中的字符串）。
function expandPolicyRefs(value, policy) {
  if (typeof value === 'string') {
    const match = /^\$policy:([A-Za-z0-9_.]+)$/.exec(value);
    if (!match) return value;
    let cursor = policy;
    for (const part of match[1].split('.')) {
      if (!cursor || typeof cursor !== 'object' || !(part in cursor)) {
        throw new Error(`无法解析策略引用 ${value}`);
      }
      cursor = cursor[part];
    }
    return cursor && typeof cursor === 'object' ? JSON.parse(JSON.stringify(cursor)) : cursor;
  }
  if (Array.isArray(value)) return value.map((entry) => expandPolicyRefs(entry, policy));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, entry] of Object.entries(value)) next[key] = expandPolicyRefs(entry, policy);
    return next;
  }
  return value;
}

let RULE_TABLE_RAW = null;
let RULE_TABLE_TEXT = '';
let ACTIVE_RUNTIME = null;
const RUNTIME_CACHE = new Map();

export function runtimeFor(name) {
  const requested = typeof name === 'string' && name.trim() ? name.trim() : configuredPolicyProfileName();
  const cached = RUNTIME_CACHE.get(requested);
  if (cached) return cached;
  const loaded = loadPolicyProfile(requested);
  let runtime;
  if (!loaded.ok) {
    runtime = {
      name: requested,
      policy: basePolicy(),
      limits: LIMITS,
      rules: [],
      fallbacks: [],
      byId: new Map(),
      errors: [makeError(loaded.code, loaded.message, { profile: requested })],
    };
  } else {
    const policy = policyFromProfile(loaded.policy);
    const errors = [];
    let rules = [];
    let fallbacks = [];
    if (RULE_TABLE_TEXT) {
      try {
        const expanded = expandPolicyRefs(RULE_TABLE_RAW || {}, policy);
        const result = validateRuleTable(expanded, RULE_TABLE_TEXT, { aliases: ALIASES, policy });
        rules = attachAdapterRuleMeta(result.rules);
        fallbacks = result.fallbacks || [];
        errors.push(...result.errors);
      } catch (cause) {
        errors.push(makeError(ERROR_CODES.POLICY_INVALID, `策略引用展开失败：${cause && cause.message ? cause.message : String(cause)}`, {
          profile: requested,
        }));
      }
    }
    runtime = {
      name: requested,
      policy,
      limits: policy.limits,
      rules,
      fallbacks,
      byId: new Map([...rules, ...fallbacks].map((rule) => [rule.id, rule])),
      errors,
    };
  }
  RUNTIME_CACHE.set(requested, runtime);
  return runtime;
}

function activeRuntime() {
  return ACTIVE_RUNTIME || runtimeFor(POLICY_PROFILE_DEFAULT);
}

// writeScope 白名单：盘符、绝对路径、..、~、前缀外一律拒绝。
// 导出给测试与 judge 之外的工具复用（judge 有自己的同口径实现，避免循环依赖）。
export function writeScopeErrors(scope, policy) {
  const effective = policy || activeRuntime().policy;
  if (!Array.isArray(scope)) return ['writeScope 必须是数组'];
  const errors = [];
  const allow = Array.isArray(effective.allow) ? effective.allow : [];
  for (const raw of scope) {
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push(`writeScope 含空/非字符串条目：${JSON.stringify(raw)}`);
      continue;
    }
    const entry = raw.trim();
    if (/^[A-Za-z]:/.test(entry)) {
      errors.push(`writeScope 不得是盘符路径：${entry}`);
      continue;
    }
    if (entry.startsWith('/') || entry.startsWith('\\')) {
      errors.push(`writeScope 不得是绝对路径：${entry}`);
      continue;
    }
    if (entry.includes('..')) {
      errors.push(`writeScope 不得含 ..：${entry}`);
      continue;
    }
    if (entry.includes('~')) {
      errors.push(`writeScope 不得含 ~：${entry}`);
      continue;
    }
    if (!allow.some((prefix) => entry.startsWith(prefix))) {
      errors.push(`writeScope 不在允许前缀内（${allow.join('/')}）：${entry}`);
    }
  }
  return errors;
}

function validateCtxMatcher(raw, push, where) {
  if (raw === undefined) return false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(ERROR_CODES.RULE_FIELD, `${where} 必须是对象`);
    return false;
  }
  const known = new Set(['tokensGte', 'activeWorkersGte', 'openRowsGte', 'zoneIn']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      push(ERROR_CODES.RULE_FIELD, `${where} 含未知字段 ${key}（写错字段名会让门控静默失效）`);
    }
  }
  let conditions = 0;
  for (const key of ['tokensGte', 'activeWorkersGte', 'openRowsGte']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
      push(ERROR_CODES.RULE_FIELD, `${where}.${key} 必须是有限数字`);
    } else {
      conditions += 1;
    }
  }
  if (raw.zoneIn !== undefined) {
    if (!Array.isArray(raw.zoneIn) || raw.zoneIn.length === 0 || raw.zoneIn.some((zone) => typeof zone !== 'string' || !zone.trim())) {
      push(ERROR_CODES.RULE_FIELD, `${where}.zoneIn 必须是非空字符串数组`);
    } else {
      conditions += 1;
    }
  }
  if (conditions === 0 && !Object.keys(raw).length) push(ERROR_CODES.RULE_FIELD, `${where} 没有任何 ctx 条件`);
  return conditions > 0;
}

// 一条决定模板：结构不完整 = 整表拒收（半条决定比没有决定更危险）。
function validateTemplate(raw, where, policy, push) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push(ERROR_CODES.RULE_FIELD, `${where} 必须是对象`);
    return null;
  }
  let ok = true;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
  if (!kind) {
    push(ERROR_CODES.RULE_FIELD, `${where}.kind 缺失`);
    ok = false;
  } else if (!KINDS.includes(kind)) {
    push(ERROR_CODES.RULE_UNKNOWN, `${where}.kind 未知：${raw.kind}`);
    ok = false;
  }

  const actionRaw = typeof raw.action === 'string' ? raw.action.trim() : '';
  let action = null;
  if (!actionRaw) {
    push(ERROR_CODES.RULE_FIELD, `${where}.action 缺失`);
    ok = false;
  } else {
    action = canonicalAction(actionRaw);
    if (!action) {
      push(ERROR_CODES.RULE_UNKNOWN, `${where}.action 未知：${raw.action}`);
      ok = false;
    }
  }

  const target = typeof raw.target === 'string' ? raw.target.trim() : '';
  if (!target) {
    push(ERROR_CODES.RULE_FIELD, `${where}.target 缺失`);
    ok = false;
  } else if (!TARGETS.includes(target)) {
    push(ERROR_CODES.RULE_UNKNOWN, `${where}.target 未知：${raw.target}`);
    ok = false;
  }

  if (raw.args !== undefined && (!raw.args || typeof raw.args !== 'object' || Array.isArray(raw.args))) {
    push(ERROR_CODES.RULE_FIELD, `${where}.args 必须是对象`);
    ok = false;
  }
  // tool: null 是「这条决定不绑工具」的合法写法（reply/memory 决定），只拒其它非字符串。
  if (raw.tool !== undefined && raw.tool !== null && typeof raw.tool !== 'string') {
    push(ERROR_CODES.RULE_FIELD, `${where}.tool 必须是字符串或 null`);
    ok = false;
  }
  if (raw.needsHuman !== undefined && typeof raw.needsHuman !== 'boolean') {
    push(ERROR_CODES.RULE_FIELD, `${where}.needsHuman 必须是布尔`);
    ok = false;
  }
  if (raw.evidence !== undefined) {
    if (!Array.isArray(raw.evidence) || raw.evidence.some((entry) => typeof entry !== 'string')) {
      push(ERROR_CODES.RULE_FIELD, `${where}.evidence 必须是字符串数组`);
      ok = false;
    }
  }
  if (raw.writeScope !== undefined) {
    if (!Array.isArray(raw.writeScope)) {
      push(ERROR_CODES.RULE_FIELD, `${where}.writeScope 必须是数组`);
      ok = false;
    } else {
      if (raw.writeScope.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        push(ERROR_CODES.RULE_FIELD, `${where}.writeScope 含空/非字符串条目`);
        ok = false;
      }
      for (const issue of writeScopeErrors(raw.writeScope, policy)) {
        push(ERROR_CODES.SCOPE, `${where} 越界：${issue}`);
      }
    }
  }
  return ok ? { kind, action, target } : null;
}

function normalizeTemplate(raw) {
  const kind = textOr(raw.kind).toLowerCase();
  const action = canonicalAction(raw.action);
  const target = textOr(raw.target);
  const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {};
  const hasTool = Object.prototype.hasOwnProperty.call(raw, 'tool');
  const explicitTool = hasTool ? textOr(raw.tool) : '';
  return Object.freeze({
    kind,
    action,
    target,
    args,
    tool: hasTool ? (explicitTool || null) : legacyAction(action),
    writeScope: normalizeScope(raw.writeScope),
    evidence: normalizeEvidence(raw.evidence),
    needsHuman: raw.needsHuman === true,
  });
}

function normalizeCtxMatcher(raw) {
  const matcher = {};
  if (typeof raw.tokensGte === 'number' && Number.isFinite(raw.tokensGte)) matcher.tokensGte = raw.tokensGte;
  if (typeof raw.activeWorkersGte === 'number' && Number.isFinite(raw.activeWorkersGte)) {
    matcher.activeWorkersGte = raw.activeWorkersGte;
  }
  if (typeof raw.openRowsGte === 'number' && Number.isFinite(raw.openRowsGte)) matcher.openRowsGte = raw.openRowsGte;
  if (Array.isArray(raw.zoneIn)) {
    const zones = raw.zoneIn.filter((z) => typeof z === 'string' && z.trim()).map((z) => z.trim().toLowerCase());
    if (zones.length) matcher.zoneIn = zones;
  }
  return Object.keys(matcher).length ? matcher : null;
}

function normalizeRule(raw, order, line) {
  const id = textOr(raw.id);
  const match = raw.match && typeof raw.match === 'object' ? raw.match : {};
  const keywords = Array.isArray(match.keywords)
    ? match.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  const notKeywords = Array.isArray(match.notKeywords)
    ? match.notKeywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  const requireKeywords = Array.isArray(match.requireKeywords)
    ? match.requireKeywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim())
    : [];
  const matchTool = textOr(match.tool) || null;
  const level = textOr(raw.level).toUpperCase();
  return Object.freeze({
    id,
    order,
    line,
    priority: raw.priority,
    category: textOr(raw.category),
    level: LEVELS.includes(level) ? level : 'X',
    kind: (textOr(match.kind) || '*').toLowerCase(),
    keywords,
    keywordKeys: keywords.map((k) => k.toLowerCase()),
    notKeywords,
    notKeywordKeys: notKeywords.map((k) => k.toLowerCase()),
    requireKeywords,
    requireKeys: requireKeywords.map((k) => k.toLowerCase()),
    matchTool,
    matchToolKey: matchTool ? matchTool.toLowerCase() : null,
    matchCtx: normalizeCtxMatcher(match.ctx || {}),
    ctxOnly: match.ctxOnly === true,
    before: (raw.before || []).map(normalizeTemplate),
    decision: normalizeTemplate(raw.decision),
    after: (raw.after || []).map(normalizeTemplate),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    policyRef: textOr(raw.policyRef),
    policyTitle: textOr(raw.policyTitle),
    policyQuote: textOr(raw.policyQuote),
    target: textOr(raw.decision.target),
    tool: normalizeTemplate(raw.decision).tool,
  });
}

/**
 * 校验整张规则表：任何一条规则有任何字段问题 → 整表拒收（不静默丢单条规则）。
 * @returns {{rules: Array, errors: Array}}
 */
export function validateRuleTable(table, text = '', options = {}) {
  const errors = [];
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    return { rules: [], errors: [makeError(ERROR_CODES.RULES_INVALID, 'routing-rules.json 顶层必须是对象')] };
  }
  if (!Array.isArray(table.rules)) {
    return { rules: [], errors: [makeError(ERROR_CODES.RULES_INVALID, 'routing-rules.json 的 rules 必须是数组')] };
  }
  if (table.rules.length === 0) {
    return { rules: [], errors: [makeError(ERROR_CODES.RULES_INVALID, 'routing-rules.json 没有任何规则：空表等于放行一切，拒绝')] };
  }
  const policy = options.policy || basePolicy();
  const maxRules = policy && policy.limits ? policy.limits.maxRules : LIMITS.maxRules;
  if (table.rules.length > maxRules) {
    return {
      rules: [],
      errors: [makeError(ERROR_CODES.EXPLOSION, `规则表 ${table.rules.length} 条，超过上限 ${maxRules}`, {
        count: table.rules.length,
        limit: maxRules,
      })],
    };
  }

  const lines = ruleLines(text);
  const seen = new Set();
  const rules = [];
  table.rules.forEach((raw, index) => {
    const ruleId = raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id.trim() : null;
    const where = `rules[${index}]${ruleId ? `(${ruleId})` : ''}`;
    const local = [];
    const push = (code, message) => local.push(makeError(code, message, ruleId ? { ruleId } : {}));

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(makeError(ERROR_CODES.RULE_FIELD, `${where} 必须是对象`, { index }));
      return;
    }
    if (!ruleId) push(ERROR_CODES.RULE_FIELD, `${where} 缺 id`);
    else if (seen.has(ruleId)) push(ERROR_CODES.RULE_FIELD, `${where} id 重复：${ruleId}`);
    if (ruleId) seen.add(ruleId);

    if (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority)) {
      push(ERROR_CODES.RULE_FIELD, `${where}.priority 必须是有限数字`);
    }

    const match = raw.match;
    let ctxValid = false;
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      push(ERROR_CODES.RULE_FIELD, `${where}.match 必须是对象`);
    } else {
      if (match.kind !== undefined && typeof match.kind !== 'string') {
        push(ERROR_CODES.RULE_FIELD, `${where}.match.kind 必须是字符串`);
      }
      let keywordCount = 0;
      if (match.keywords !== undefined) {
        if (!Array.isArray(match.keywords) || match.keywords.some((k) => typeof k !== 'string' || !k.trim())) {
          push(ERROR_CODES.RULE_FIELD, `${where}.match.keywords 必须是非空字符串数组`);
        } else {
          keywordCount = match.keywords.length;
        }
      }
      if (match.notKeywords !== undefined) {
        if (!Array.isArray(match.notKeywords) || match.notKeywords.some((k) => typeof k !== 'string' || !k.trim())) {
          push(ERROR_CODES.RULE_FIELD, `${where}.match.notKeywords 必须是非空字符串数组`);
        }
      }
      // requireKeywords：与 keywords 的「或」不同，这是「且」门——至少命中其中一个才
      // 算命中本规则。用于同一 tool 下按参数形态分流（dry-run / confirm / locked），
      // 否则 match.tool 会短路 keywords，优先级最高的那条会吃掉该工具的所有调用。
      if (match.requireKeywords !== undefined) {
        if (!Array.isArray(match.requireKeywords) || match.requireKeywords.some((k) => typeof k !== 'string' || !k.trim())) {
          push(ERROR_CODES.RULE_FIELD, `${where}.match.requireKeywords 必须是非空字符串数组`);
        } else {
          keywordCount += match.requireKeywords.length;
        }
      }
      if (match.tool !== undefined && typeof match.tool !== 'string') {
        push(ERROR_CODES.RULE_FIELD, `${where}.match.tool 必须是字符串`);
      }
      ctxValid = validateCtxMatcher(match.ctx, push, `${where}.match.ctx`);
      if (match.ctxOnly !== undefined && typeof match.ctxOnly !== 'boolean') {
        push(ERROR_CODES.RULE_FIELD, `${where}.match.ctxOnly 必须是布尔`);
      }
      if (match.ctxOnly === true && !ctxValid) {
        push(ERROR_CODES.RULE_FIELD, `${where} 是 ctxOnly 但没有可用的 match.ctx`);
      }
      const toolHit = typeof match.tool === 'string' && match.tool.trim();
      if (keywordCount === 0 && !toolHit && !ctxValid) {
        push(ERROR_CODES.RULE_FIELD, `${where} 没有任何匹配条件（keywords/tool/ctx 全空），永远不可能命中`);
      }
    }

    const decision = validateTemplate(raw.decision, `${where}.decision`, policy, push);
    for (const key of ['before', 'after']) {
      if (raw[key] === undefined) continue;
      if (!Array.isArray(raw[key])) {
        push(ERROR_CODES.RULE_FIELD, `${where}.${key} 必须是数组`);
        continue;
      }
      raw[key].forEach((template, templateIndex) => {
        validateTemplate(template, `${where}.${key}[${templateIndex}]`, policy, push);
      });
    }
    if (raw.level !== undefined) {
      const level = typeof raw.level === 'string' ? raw.level.trim().toUpperCase() : '';
      if (!LEVELS.includes(level)) push(ERROR_CODES.RULE_FIELD, `${where}.level 未知：${raw.level}`);
    }

    if (local.length === 0 && decision) {
      rules.push(normalizeRule(raw, index, lines.get(ruleId) || 0));
    }
    errors.push(...local);
  });

  // 兜底规则（策略 5）：不进优先级队列，0 命中时由 route 的兜底分支直接取用。
  const fallbacks = [];
  if (table.fallbacks !== undefined) {
    if (!Array.isArray(table.fallbacks)) {
      errors.push(makeError(ERROR_CODES.RULES_INVALID, 'fallbacks 必须是数组'));
    } else {
      table.fallbacks.forEach((raw, index) => {
        const where = `fallbacks[${index}]`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          errors.push(makeError(ERROR_CODES.RULE_FIELD, `${where} 必须是对象`));
          return;
        }
        const id = textOr(raw.id);
        const local = [];
        const push = (code, message) => local.push(makeError(code, message, id ? { ruleId: id } : { index }));
        if (!id) push(ERROR_CODES.RULE_FIELD, `${where} 缺 id`);
        else if (seen.has(id)) push(ERROR_CODES.RULE_FIELD, `${where} id 与规则表重复：${id}`);
        if (id) seen.add(id);
        if (!raw.decision || typeof raw.decision !== 'object' || Array.isArray(raw.decision)) {
          push(ERROR_CODES.RULE_FIELD, `${where}.decision 必须是对象`);
        } else {
          validateTemplate(raw.decision, `${where}.decision`, policy, push);
        }
        if (!textOr(raw.reason)) push(ERROR_CODES.RULE_FIELD, `${where}.reason 不能为空`);
        if (!textOr(raw.policyRef)) push(ERROR_CODES.RULE_FIELD, `${where}.policyRef 不能为空`);
        if (!textOr(raw.policyTitle)) push(ERROR_CODES.RULE_FIELD, `${where}.policyTitle 不能为空`);
        if (!textOr(raw.policyQuote)) push(ERROR_CODES.RULE_FIELD, `${where}.policyQuote 不能为空`);
        if (local.length === 0) {
          fallbacks.push(Object.freeze({
            id,
            order: index,
            line: lines.get(id) || 0,
            priority: 0,
            category: textOr(raw.category),
            level: LEVELS.includes(textOr(raw.level).toUpperCase()) ? textOr(raw.level).toUpperCase() : 'X',
            kind: '*',
            keywords: [],
            keywordKeys: [],
            notKeywords: [],
            notKeywordKeys: [],
            matchTool: null,
            matchToolKey: null,
            matchCtx: null,
            ctxOnly: false,
            before: [],
            decision: normalizeTemplate(raw.decision),
            after: [],
            reason: textOr(raw.reason),
            policyRef: textOr(raw.policyRef),
            policyTitle: textOr(raw.policyTitle),
            policyQuote: textOr(raw.policyQuote),
            target: textOr(raw.decision.target),
            tool: normalizeTemplate(raw.decision).tool,
            fallback: true,
          }));
        }
        errors.push(...local);
      });
    }
  }

  if (errors.length) return { rules: [], fallbacks: [], errors };
  rules.sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
  return { rules, fallbacks, errors: [] };
}

/** 解析规则表文本并整表校验；JSON 损坏也是一个明确错误码，不是空表。 */
export function parseRuleTable(text, options = {}) {
  let table;
  try {
    table = JSON.parse(text);
  } catch (cause) {
    return { rules: [], errors: [makeError(ERROR_CODES.RULES_INVALID, `routing-rules.json JSON 解析失败：${cause.message}`)] };
  }
  const policy = options.policy || basePolicy();
  let expanded;
  try {
    expanded = expandPolicyRefs(table, policy);
  } catch (cause) {
    return { rules: [], errors: [makeError(ERROR_CODES.POLICY_INVALID, `策略引用展开失败：${cause && cause.message ? cause.message : String(cause)}`)] };
  }
  const result = validateRuleTable(expanded, text, { ...options, policy });
  return { ...result, fallbacks: result.fallbacks || [] };
}

// M2-E：把 adapter 提供的规则按原表顺序插回核心规则表（_order = 迁移前下标）。
// 数据不可用/结构异常时 fail-safe：只用核心规则，degraded 记录在 ADAPTER_DEGRADED。
// adapter 规则的定义行/文件：evidence 必须能回到真实文件，而不是核心规则表。
const ADAPTER_RULE_META = (() => {
  const lines = new Map();
  const sources = new Map();
  for (const item of ADAPTER_ROUTING.items || []) {
    const text = typeof item.text === 'string' ? item.text : '';
    const sourcePath = typeof item.sourcePath === 'string' ? item.sourcePath : '';
    for (const [id, line] of ruleLines(text)) {
      if (!lines.has(id)) lines.set(id, line);
      if (sourcePath && !sources.has(id)) sources.set(id, sourcePath);
    }
  }
  return { lines, sources };
})();

function attachAdapterRuleMeta(rules) {
  return rules.map((rule) => {
    const line = ADAPTER_RULE_META.lines.get(rule.id);
    if (!line) return rule;
    const sourcePath = ADAPTER_RULE_META.sources.get(rule.id) || RULE_TABLE_PATH;
    return Object.freeze({ ...rule, line, sourcePath });
  });
}

function mergeAdapterRuleTable(table, coreText = '') {
  const coreRules = Array.isArray(table.rules) ? table.rules : [];
  const loaded = ADAPTER_ROUTING;
  // 核心表本身坏了（rules 非数组/空表）时不要把 adapter 规则补进去掩盖故障：
  // 让核心校验按原来的 fail-closed 语义报错。
  if (!Array.isArray(table.rules) || table.rules.length === 0) {
    return { table, text: coreText };
  }
  if (!loaded.ok || !Array.isArray(loaded.rules) || loaded.rules.length === 0) {
    return { table, text: coreText };
  }
  const adapterByOrder = new Map();
  for (const rule of loaded.rules) {
    const order = rule && Number.isInteger(rule._order) ? rule._order : null;
    if (order === null || adapterByOrder.has(order)) continue;
    const clean = { ...rule };
    delete clean._order;
    adapterByOrder.set(order, clean);
  }
  const mergedRules = [];
  let cursor = 0;
  const total = coreRules.length + adapterByOrder.size;
  for (let index = 0; index < total; index += 1) {
    if (adapterByOrder.has(index)) mergedRules.push(adapterByOrder.get(index));
    else if (cursor < coreRules.length) mergedRules.push(coreRules[cursor++]);
  }
  while (cursor < coreRules.length) mergedRules.push(coreRules[cursor++]);
  const adapterTargets = (loaded.targets || []).filter((target) => typeof target === 'string');
  const targets = Array.isArray(table.targets) ? [...new Set([...table.targets, ...adapterTargets])] : table.targets;
  const mergedTable = { ...table, targets, rules: mergedRules };
  // 行号映射：核心表在前、adapter 规则行号不可考时给 0（evidence 里保留 ruleId 仍可审计）。
  let text = coreText + '\n' + JSON.stringify({ rules: mergedRules.slice(coreRules.length) });
  return { table: mergedTable, text };
}

function loadRulesResult() {
  // 别名不可用时不再逐条报「未知 action」：那只是同一个根因的 17 次回声。
  if (ALIASES.errors.length) return { rules: [], fallbacks: [], errors: [] };
  if (!GENERIC_LOAD.ok) return { rules: [], fallbacks: [], errors: [] };
  let text = '';
  try {
    text = readFileSync(RULES_URL, 'utf8');
  } catch (cause) {
    return {
      rules: [],
      errors: [makeError(ERROR_CODES.RULES_UNAVAILABLE, `routing-rules.json 读取失败：${cause.code || cause.message}，拒绝路由`)],
    };
  }
  let table;
  try {
    table = JSON.parse(text);
  } catch (cause) {
    return { rules: [], fallbacks: [], errors: [makeError(ERROR_CODES.RULES_INVALID, `routing-rules.json JSON 解析失败：${cause.message}`)] };
  }
  RULE_TABLE_RAW = table;
  RULE_TABLE_TEXT = text;
  const policy = policyFromProfile(GENERIC_LOAD.policy);
  try {
    const merged = mergeAdapterRuleTable(table, text);
    RULE_TABLE_RAW = merged.table;
    RULE_TABLE_TEXT = merged.text;
    const expanded = expandPolicyRefs(merged.table, policy);
    const result = validateRuleTable(expanded, merged.text, { aliases: ALIASES, policy });
    return { ...result, rules: attachAdapterRuleMeta(result.rules), fallbacks: result.fallbacks || [] };
  } catch (cause) {
    return {
      rules: [],
      fallbacks: [],
      errors: [makeError(ERROR_CODES.POLICY_INVALID, `策略引用展开失败：${cause && cause.message ? cause.message : String(cause)}`)],
    };
  }
}

const RULES_RESULT = loadRulesResult();

// 读表 + 整表校验 + 排序。导出给测试做规则表完整性断言。
export function loadRules() {
  return RULES_RESULT.rules;
}

export const RULES = Object.freeze(RULES_RESULT.rules);

// 兜底规则（策略 5）：R-SES-ASK 不在 RULES 里，不参与优先级竞争，0 命中时单独取用。
export const FALLBACKS = Object.freeze(RULES_RESULT.fallbacks || []);

const ASK_FALLBACK = FALLBACKS.find((rule) => rule.id === 'R-SES-ASK') || null;
// 模块加载期就存在的拒绝理由（文件缺失/损坏/字段错误）。route() 每次调用都先看它。
export const LOAD_ERRORS = Object.freeze([
  ...(GENERIC_LOAD.ok ? [] : [makeError(GENERIC_LOAD.code, GENERIC_LOAD.message)]),
  ...ALIASES.errors,
  ...RULES_RESULT.errors,
]);

export function ruleById(id) {
  const runtime = ACTIVE_RUNTIME || runtimeFor(POLICY_PROFILE_DEFAULT);
  if (runtime.byId.has(id)) return runtime.byId.get(id);
  return RULES.find((rule) => rule.id === id) || FALLBACKS.find((rule) => rule.id === id) || null;
}

// 通用默认策略编译出的 ctx 阈值/白名单（judge 与 CLI 的通用基线）。
export function loadPolicy() {
  return basePolicy();
}

export const POLICY = Object.freeze(basePolicy());

// 兼容导出：generic 基线的休息/终止词表；route 内部始终用生效 profile。
export const REST_RE = markersRegex(POLICY.rest.markers) || /(?!)/;
export const STOP_RE = markersRegex(POLICY.rest.terminators) || /(?!)/;

// ── 输入读取 ─────────────────────────────────────────────────

function readInput(input) {
  if (!input || typeof input !== 'object') return { kind: '', text: '' };
  let kind = '';
  let text = '';
  try {
    kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
    const raw = input.text !== undefined ? input.text : input.utterance;
    if (typeof raw === 'string') text = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') text = String(raw);
  } catch {
    return { kind: '', text: '' };
  }
  return { kind, text };
}

function readCandidates(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.candidates)) return [];
  const out = [];
  for (const candidate of input.candidates.slice(0, 64)) {
    if (typeof candidate === 'string') {
      const name = candidate.trim();
      if (name) out.push(name.toLowerCase());
      continue;
    }
    if (candidate && typeof candidate === 'object') {
      const name = textOr(candidate.tool) || textOr(candidate.name);
      if (name) out.push(name.toLowerCase());
    }
  }
  return out;
}

/**
 * 读 ctx，同时把「缺字段」与「类型错」记下来——这两类绝不能被当成「没命中」。
 * @returns {{ctx: object, raw: object|null, problems: Array<{code,field,message,got?}>}}
 */
export function readCtxReport(input) {
  const ctx = {};
  const problems = [];
  let raw = null;
  if (!input || typeof input !== 'object') return { ctx, raw, problems };
  try {
    raw = input.ctx;
  } catch {
    return { ctx, raw: null, problems };
  }
  if (raw === undefined || raw === null) return { ctx, raw: null, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(makeError(ERROR_CODES.CTX_TYPE, `ctx 必须是对象，收到 ${raw === null ? 'null' : typeof raw}`, {
      field: 'ctx',
      got: Array.isArray(raw) ? 'array' : typeof raw,
    }));
    return { ctx, raw: null, problems };
  }
  for (const key of ['tokens', 'activeWorkers', 'openRows']) {
    const value = safeGet(raw, key);
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      ctx[key] = value;
      continue;
    }
    problems.push(makeError(ERROR_CODES.CTX_TYPE, `ctx.${key} 必须是有限数字，收到 ${Array.isArray(value) ? 'array' : typeof value}`, {
      field: key,
      got: Array.isArray(value) ? 'array' : typeof value,
    }));
  }
  const zone = safeGet(raw, 'zone');
  if (zone !== undefined && zone !== null) {
    if (typeof zone === 'string' && zone.trim()) ctx.zone = zone.trim().toLowerCase();
    else {
      problems.push(makeError(ERROR_CODES.CTX_TYPE, `ctx.zone 必须是非空字符串，收到 ${Array.isArray(zone) ? 'array' : typeof zone}`, {
        field: 'zone',
        got: Array.isArray(zone) ? 'array' : typeof zone,
      }));
    }
  }
  return { ctx, raw, problems };
}

function readCtx(input) {
  return readCtxReport(input).ctx;
}

// override 只有同时给出 ruleId 与 reason 才留痕；没有理由的偏离直接丢弃并计
// E_ROUTE_OVERRIDE_UNJUSTIFIED——"悄悄绕开规则"不能是一种可用写法。
function readOverrides(input) {
  const applied = [];
  const rejected = [];
  if (!input || typeof input !== 'object') return { applied, rejected };
  let raw;
  try {
    raw = Array.isArray(input.overrides) ? input.overrides : (input.override ? [input.override] : []);
  } catch {
    return { applied, rejected };
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const ruleId = textOr(entry.ruleId);
    const reason = textOr(entry.reason);
    if (!ruleId || !reason) {
      rejected.push({
        ruleId: ruleId || null,
        reason: reason || '',
        code: ERROR_CODES.OVERRIDE_UNJUSTIFIED,
        message: 'override 缺 ruleId 或 reason：拒绝并丢弃，判定不变',
      });
      continue;
    }
    applied.push({
      ruleId,
      reason,
      by: textOr(entry.by) || 'caller',
      at: textOr(entry.at) || null,
      action: textOr(entry.action) || null,
    });
  }
  return { applied, rejected };
}

// ── 匹配 ─────────────────────────────────────────────────────

function countKeyHits(keys, normalized) {
  let hits = 0;
  for (const key of keys) {
    if (normalized.includes(key)) hits += 1;
  }
  return hits;
}

function countKeywordHits(rule, normalized) {
  return countKeyHits(rule.keywordKeys, normalized);
}

function evaluateCtx(matcher, ctx) {
  if (!matcher) return null;
  if (typeof matcher.tokensGte === 'number') {
    if (typeof ctx.tokens !== 'number' || ctx.tokens < matcher.tokensGte) return false;
  }
  if (typeof matcher.activeWorkersGte === 'number') {
    if (typeof ctx.activeWorkers !== 'number' || ctx.activeWorkers < matcher.activeWorkersGte) return false;
  }
  if (typeof matcher.openRowsGte === 'number') {
    if (typeof ctx.openRows !== 'number' || ctx.openRows < matcher.openRowsGte) return false;
  }
  if (Array.isArray(matcher.zoneIn)) {
    if (typeof ctx.zone !== 'string' || !matcher.zoneIn.includes(ctx.zone)) return false;
  }
  return true;
}

function confidenceFor(hits, toolHit, ctxOnly) {
  if (toolHit) return 1;
  if (ctxOnly) return 0.9;
  if (hits >= 2) return 1;
  return 0.75;
}

const CTX_FIELDS = Object.freeze([
  ['tokensGte', 'tokens', 'number'],
  ['activeWorkersGte', 'activeWorkers', 'number'],
  ['openRowsGte', 'openRows', 'number'],
  ['zoneIn', 'zone', 'string'],
]);

// 关键词命中、但 ctx 字段缺失/类型错：这是输入错误，不是「条件不满足」。
function ctxFieldIssues(rule, normalized, ctxReport) {
  const issues = [];
  for (const [matcherKey, field, expected] of CTX_FIELDS) {
    if (typeof rule.matchCtx[matcherKey] === 'undefined') continue;
    const rawValue = ctxReport.raw && typeof ctxReport.raw === 'object' ? safeGet(ctxReport.raw, field) : undefined;
    if (rawValue === undefined || rawValue === null) {
      issues.push(makeError(ERROR_CODES.CTX_MISSING, `规则 ${rule.id} 关键词命中，但 ctx.${field} 缺失：不能当成没命中`, {
        ruleId: rule.id,
        field,
      }));
      continue;
    }
    if (expected === 'number' ? !(typeof rawValue === 'number' && Number.isFinite(rawValue)) : typeof rawValue !== 'string') {
      issues.push(makeError(ERROR_CODES.CTX_TYPE, `规则 ${rule.id} 关键词命中，但 ctx.${field} 类型错误（应为 ${expected}，收到 ${typeof rawValue}）`, {
        ruleId: rule.id,
        field,
        got: Array.isArray(rawValue) ? 'array' : typeof rawValue,
      }));
    }
  }
  return issues;
}

function collectCtxIssues(parsed, minPriority = -Infinity) {
  const issues = [];
  const normalized = parsed.text.trim().toLowerCase();
  for (const rule of activeRuntime().rules) {
    if (!rule.matchCtx || rule.ctxOnly) continue;
    if (parsed.kind && rule.kind !== '*' && rule.kind !== parsed.kind) continue;
    // 只追「可能改变结果」的那部分：比当前胜出规则更低优先级的门控规则，
    // 本来就不会被选中，它的 ctx 缺失不构成歧义（否则一个普通词就会误伤整单）。
    if (rule.priority < minPriority) continue;
    if (countKeywordHits(rule, normalized) === 0 && countKeyHits(rule.requireKeys, normalized) === 0) continue;
    issues.push(...ctxFieldIssues(rule, normalized, parsed.ctxReport));
  }
  return issues;
}

function matchRules(parsed, candidates) {
  const normalized = parsed.text.trim().toLowerCase();
  const ctx = parsed.ctx;
  const matched = [];
  for (const rule of activeRuntime().rules) {
    if (parsed.kind && rule.kind !== '*' && rule.kind !== parsed.kind) continue;
    const hits = countKeywordHits(rule, normalized);
    const requireHits = countKeyHits(rule.requireKeys, normalized);
    const toolHit = Boolean(rule.matchToolKey && candidates.includes(rule.matchToolKey));
    const requireOk = rule.requireKeys.length === 0
      || (requireHits > 0 && (!rule.matchToolKey || toolHit));
    const ctxOk = evaluateCtx(rule.matchCtx, ctx);
    if (rule.ctxOnly) {
      if (ctxOk !== true) continue;
    } else {
      if (hits === 0 && !toolHit && rule.requireKeys.length === 0) continue;
      if (!requireOk) continue;
      if (ctxOk === false) continue;
    }
    matched.push({
      rule,
      hits: hits + requireHits,
      toolHit,
      confidence: confidenceFor(hits + requireHits, toolHit, rule.ctxOnly),
    });
  }
  return matched;
}

// ── 决定构造 ─────────────────────────────────────────────────

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || !entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function buildDecision(template, rule, confidence) {
  return {
    kind: template.kind,
    action: template.action,
    args: clone(template.args || {}),
    ruleId: rule.id,
    evidence: dedupe([
      ...template.evidence,
      rule.line ? `${rule.sourcePath || RULE_TABLE_PATH}:${rule.line}` : '',
      rule.policyRef ? `policy:${rule.policyRef}` : '',
    ]),
    writeScope: template.writeScope.slice(),
    target: template.target,
    tool: template.tool,
    needsHuman: template.needsHuman === true,
    confidence,
  };
}

// ctx 参与路由的落点：每个用了的字段都要在 evidence 里留 ctx:<field>。
function applyCtxToDecision(decision, ctx) {
  const args = decision.args;
  const add = (entry) => {
    if (!decision.evidence.includes(entry)) decision.evidence.push(entry);
  };
  if (decision.action === 'acp_status') {
    if (typeof ctx.tokens === 'number') {
      args.tokens = ctx.tokens;
      add('ctx:tokens');
    }
    if (typeof ctx.zone === 'string') {
      args.zone = ctx.zone;
      add('ctx:zone');
    }
  }
  if (decision.action === 'session.handover') {
    if (typeof ctx.tokens === 'number') {
      args.tokens = ctx.tokens;
      add('ctx:tokens');
    }
    if (typeof ctx.zone === 'string') {
      args.zone = ctx.zone;
      add('ctx:zone');
    }
  }
  if (decision.action === 'worker_spawn') {
    if (typeof ctx.activeWorkers === 'number') {
      add('ctx:activeWorkers');
      if (ctx.activeWorkers >= activeRuntime().policy.dispatchAt) {
        args.pool = 'existing';
        args.activeWorkers = ctx.activeWorkers;
      }
    }
    if (typeof ctx.openRows === 'number') {
      add('ctx:openRows');
      args.openRows = ctx.openRows;
    }
  }
  if (decision.action === 'taskboard.update') {
    if (typeof ctx.openRows === 'number') {
      add('ctx:openRows');
      args.openRows = ctx.openRows;
    }
  }
  if (decision.action === 'session.compact') {
    if (typeof ctx.tokens === 'number') {
      args.tokens = ctx.tokens;
      add('ctx:tokens');
    }
    if (typeof ctx.zone === 'string') {
      args.zone = ctx.zone;
      add('ctx:zone');
    }
  }
  return decision;
}

// 纯 ctx 叠加建议：不抢主决策，只在其后追加"该收口了"的动作。
function ctxOverlays(ctx, decisions) {
  const overlays = [];
  const has = (action) => decisions.some((decision) => decision.action === action);
  const tokens = typeof ctx.tokens === 'number' ? ctx.tokens : null;
  const policy = activeRuntime().policy;
  const red = ctx.zone === 'red' || (tokens !== null && tokens >= policy.redAt);

  if (red && !has('session.handover')) {
    const rule = ruleById('R-SES-RED');
    if (rule) {
      const prelude = rule.before.find((item) => item.action === 'acp_status');
      if (prelude && !has('acp_status')) {
        overlays.push(applyCtxToDecision(buildDecision(prelude, rule, 0.9), ctx));
      }
      overlays.push(applyCtxToDecision(buildDecision(rule.decision, rule, 0.9), ctx));
    }
    return overlays;
  }

  const yellow = ctx.zone === 'yellow' || (tokens !== null && tokens >= policy.compressAt);
  if (yellow && !has('session.compact') && !has('session.handover')) {
    const rule = ruleById('R-SES-BUDGET');
    if (rule) overlays.push(applyCtxToDecision(buildDecision(rule.decision, rule, 0.9), ctx));
  }
  return overlays;
}

// 严格版：override 必须指向本次决定里真实存在的 ruleId，绝不贴到 decisions[0]。
function applyOverrides(decisions, applied) {
  for (const override of applied) {
    const target = decisions.find((decision) => decision.ruleId === override.ruleId);
    if (!target) continue;
    target.overridden = {
      ruleId: override.ruleId,
      reason: override.reason,
      by: override.by,
      at: override.at,
    };
    if (override.action) {
      const canonical = canonicalAction(override.action);
      if (canonical) {
        target.action = canonical;
        target.tool = legacyAction(canonical);
      }
    }
  }
  return decisions;
}

// ── 输出 ─────────────────────────────────────────────────────

function rejectedErrors(rejected) {
  return rejected.map((entry) => ({
    code: entry.code,
    message: entry.message,
    ruleId: entry.ruleId,
    reason: entry.reason,
  }));
}

function emptyResult(meta, overrides, rejected) {
  return {
    caseId: meta.caseId,
    turn: meta.turn,
    decisions: [],
    needsHuman: rejected.length > 0,
    confidence: 0,
    matchedRule: null,
    matchedRules: [],
    overrides: overrides.slice(),
    overrideAudit: {
      applied: overrides.length,
      rejected: rejected.length,
      records: overrides.slice(),
    },
    errors: rejectedErrors(rejected),
    decision: { target: 'none', tool: null },
    target: 'none',
    tool: null,
    level: null,
    ctx: meta.ctx,
    ruleIds: [],
  };
}

// 出错即停：只给一条 refuse，needsHuman=true，错误码全部带出去。
function failClosedResult(meta, overrides, rejected, errors) {
  // 同一个问题可能同时从全局 ctx 检查和规则门控检查报出来，去重后再暴露给调用方。
  const allErrors = [...errors, ...rejectedErrors(rejected)];
  const seen = new Set();
  const uniqueErrors = allErrors.filter((error) => {
    const key = `${error.code}\u0000${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const codes = Array.from(new Set(uniqueErrors.map((error) => error.code)));
  const refuse = {
    kind: 'reply',
    action: 'guard.refuse',
    args: { failClosed: true, codes },
    ruleId: FAILCLOSED_RULE_ID,
    evidence: codes.map((code) => `fail-closed:${code}`),
    writeScope: [],
    target: 'none',
    tool: null,
    needsHuman: true,
    confidence: 0,
  };
  return {
    caseId: meta.caseId,
    turn: meta.turn,
    decisions: [refuse],
    needsHuman: true,
    confidence: 0,
    matchedRule: null,
    matchedRules: [],
    overrides: overrides.slice(),
    overrideAudit: {
      applied: overrides.length,
      rejected: rejected.length,
      records: overrides.slice(),
    },
    errors: uniqueErrors,
    decision: { target: 'none', tool: null },
    target: 'none',
    tool: null,
    level: null,
    ctx: meta.ctx,
    ruleIds: [FAILCLOSED_RULE_ID],
    failClosed: true,
  };
}

function ruleDecisions(rule, confidence, ctx) {
  const decisions = [];
  for (const template of rule.before) decisions.push(buildDecision(template, rule, confidence));
  decisions.push(buildDecision(rule.decision, rule, confidence));
  for (const template of rule.after) decisions.push(buildDecision(template, rule, confidence));
  for (const decision of decisions) applyCtxToDecision(decision, ctx);
  return decisions;
}

// 策略 1：把静态 rest 模板变成真实回复参数——只有 REST_RE 命中且 STOP_RE 不命中才叫「可恢复的暂停」。
// 词表、默认 resumePoint 都来自生效 profile（generic 默认；owner 可补充/改写）。
function applyRestToDecisions(decisions, normalized) {
  const restPolicy = activeRuntime().policy.rest;
  const restRe = markersRegex(restPolicy.markers);
  const stopRe = markersRegex(restPolicy.terminators);
  const restHit = restRe ? restRe.test(normalized) : false;
  const stopHit = stopRe ? stopRe.test(normalized) : false;
  for (const decision of decisions) {
    const rest = decision.args && decision.args.rest;
    if (!rest || typeof rest !== 'object') continue;
    delete decision.args.rest;
    if (!restHit || stopHit) continue;
    decision.args.restKind = rest.kind;
    decision.args.resumable = rest.resumable === true;
    decision.args.terminal = rest.terminal === true;
    decision.args.pendingTask = rest.pendingTask || 'keep';
    decision.args.resumePoint = typeof rest.resumePoint === 'string' && rest.resumePoint.trim()
      ? rest.resumePoint.trim()
      : restPolicy.resumePoint;
    decision.args.forbiddenActions = Array.isArray(rest.forbiddenActions) ? rest.forbiddenActions.slice() : [];
  }
  return decisions;
}

// 策略 6：同意权在当前会话的助手本人（consent.holder=assistant）。用户单方面请求（哪怕自己带了 consent 字段）永远不构成同意。
// owner profile 可再收窄为「必须引用原话 id（mNNNNN）」。
function readAssistantConsent(input, identity = activeRuntime().policy.identity) {
  const raw = input && typeof input === 'object' ? input.consent : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const holder = typeof raw.holder === 'string' ? raw.holder.trim().toLowerCase() : '';
  const at = typeof raw.at === 'string' ? raw.at.trim() : '';
  const quote = typeof raw.quote === 'string' ? raw.quote.trim() : '';
  const quoteId = typeof raw.quoteId === 'string' ? raw.quoteId.trim() : '';
  if (holder !== 'assistant' || !at || !quote) return null;
  if (identity.requireQuoteId === true && !/^m\d{5}$/.test(quoteId)) return null;
  const granted = { holder: 'assistant', required: true, satisfied: true, at, quote };
  if (quoteId) granted.quoteId = quoteId;
  return granted;
}

function applyConsentToDecisions(decisions, input) {
  if (!decisions.some((decision) => decision.args && decision.args.requiresConsent === true)) return decisions;
  const granted = readAssistantConsent(input);
  if (!granted) {
    const hold = decisions.find((decision) => decision.action === 'identity.hold');
    if (!hold) return decisions;
    hold.args.consent = { holder: 'assistant', required: true, satisfied: false };
    hold.args.errorCode = ERROR_CODES.IDENTITY_CONSENT_REQUIRED;
    return [hold];
  }
  const kept = [];
  for (const decision of decisions) {
    if (decision.action === 'identity.hold') continue;
    if (decision.args && decision.args.requiresConsent === true) {
      delete decision.args.requiresConsent;
      decision.args.consent = { ...granted };
      decision.needsHuman = false;
    }
    kept.push(decision);
  }
  return kept.length ? kept : decisions;
}

// 策略 5：0 命中兜底——只对会话意图发问；告别/终止语不发问（那不是含糊，是结束）。
function askFallbackResult(parsed, normalized) {
  const runtime = activeRuntime();
  const rule = runtime.byId.get('R-SES-ASK') || ASK_FALLBACK;
  const stopRe = markersRegex(runtime.policy.rest.terminators);
  if (!rule || parsed.kind !== 'session' || !normalized || (stopRe && stopRe.test(normalized))) return null;
  const decision = buildDecision(rule.decision, rule, 0);
  return {
    caseId: parsed.caseId,
    turn: parsed.turn,
    decisions: [decision],
    needsHuman: decision.needsHuman === true,
    confidence: 0,
    matchedRule: rule.id,
    matchedRules: [rule.id],
    overrides: [],
    overrideAudit: { applied: 0, rejected: 0, records: [] },
    errors: [],
    decision: { target: decision.target, tool: decision.tool ?? null },
    target: decision.target,
    tool: decision.tool ?? null,
    level: rule.level,
    ctx: parsed.ctx,
    ruleIds: [rule.id],
  };
}

function routeValidated(input, parsed, overrides, rejected) {
  const runtime = activeRuntime();
  const limits = runtime.limits;
  const ctx = parsed.ctx;
  const text = parsed.text;
  const normalized = text.trim().toLowerCase();
  const meta = { caseId: parsed.caseId, turn: parsed.turn, ctx };

  // 没有字、也没有 ctx：没什么可路由的（ctx-only 规则在下面另行处理）。
  if (!normalized && Object.keys(ctx).length === 0) {
    return emptyResult(meta, overrides, rejected);
  }

  // override 指向不存在的规则：整单拒绝，绝不改贴 decisions[0]。
  const unknownOverrides = overrides.filter((override) => !ruleById(override.ruleId));
  if (unknownOverrides.length) {
    return failClosedResult(meta, overrides, rejected, unknownOverrides.map((override) => makeError(
      ERROR_CODES.OVERRIDE_UNKNOWN,
      `override 指向不存在的规则 ${override.ruleId}：拒绝该 override，且不按它的意思改任何决策`,
      { ruleId: override.ruleId },
    )));
  }

  const candidates = readCandidates(input);
  const matches = matchRules(parsed, candidates);

  // 关键词命中了门控规则、但 ctx 缺字段/类型错：这不是「条件不满足」，不能静默当没命中。
  const ctxIssues = collectCtxIssues(parsed, matches.length ? matches[0].rule.priority : -Infinity);
  if (ctxIssues.length) return failClosedResult(meta, overrides, rejected, ctxIssues);

  const errors = [];
  if (matches.length > 0) {
    const topPriority = matches[0].rule.priority;
    const top = matches.filter((entry) => entry.rule.priority === topPriority);
    if (top.length > 1) {
      const rules = top.map((entry) => entry.rule.id);
      errors.push(makeError(
        ERROR_CODES.AMBIGUOUS,
        `同优先级规则同时命中，拒绝按文件顺序判定：${rules.join(', ')}`,
        { rules, priority: topPriority },
      ));
    }
  }
  if (matches.length > limits.maxCompeting) {
    errors.push(makeError(ERROR_CODES.EXPLOSION, `竞争规则 ${matches.length} 条，超过上限 ${limits.maxCompeting}`, {
      count: matches.length,
      limit: limits.maxCompeting,
    }));
  }
  if (errors.length) return failClosedResult(meta, overrides, rejected, errors);

  if (matches.length === 0) {
    const asked = askFallbackResult(parsed, normalized);
    if (asked) {
      const unmatched = overrides.filter((override) => !asked.decisions.some((decision) => decision.ruleId === override.ruleId));
      if (unmatched.length) {
        return failClosedResult(meta, overrides, rejected, unmatched.map((override) => makeError(
          ERROR_CODES.OVERRIDE_UNKNOWN,
          `override 指向的兜底规则 ${override.ruleId} 没有产生决策：拒绝该 override`,
          { ruleId: override.ruleId },
        )));
      }
      applyOverrides(asked.decisions, overrides);
      asked.overrides = overrides.slice();
      asked.overrideAudit = { applied: overrides.length, rejected: rejected.length, records: overrides.slice() };
      asked.errors = rejectedErrors(rejected);
      asked.needsHuman = asked.decisions.some((decision) => decision.needsHuman === true) || rejected.length > 0;
      asked.matchedRules = Array.from(new Set(asked.decisions.map((decision) => decision.ruleId)));
      return asked;
    }
    return emptyResult(meta, overrides, rejected);
  }

  const winner = matches[0];
  let decisions = ruleDecisions(winner.rule, winner.confidence, ctx);
  if (decisions.length > limits.maxDecisions) {
    return failClosedResult(meta, overrides, rejected, [makeError(
      ERROR_CODES.EXPLOSION,
      `规则 ${winner.rule.id} 展开 ${decisions.length} 条决策，超过上限 ${limits.maxDecisions}`,
      { count: decisions.length, limit: limits.maxDecisions, ruleId: winner.rule.id },
    )]);
  }

  decisions.push(...ctxOverlays(ctx, decisions));
  decisions = applyConsentToDecisions(applyRestToDecisions(decisions, normalized), input);
  if (decisions.length > limits.maxDecisions) {
    return failClosedResult(meta, overrides, rejected, [makeError(
      ERROR_CODES.EXPLOSION,
      `加上 ctx 叠加后决策 ${decisions.length} 条，超过上限 ${limits.maxDecisions}`,
      { count: decisions.length, limit: limits.maxDecisions },
    )]);
  }

  // writeScope 二次校验：任何一条越界都不执行。
  const scopeErrors = [];
  for (const decision of decisions) {
    for (const issue of writeScopeErrors(decision.writeScope, runtime.policy)) {
      scopeErrors.push(makeError(ERROR_CODES.SCOPE, `${decision.ruleId} ${decision.action} 的 writeScope 越界：${issue}`, {
        ruleId: decision.ruleId,
        action: decision.action,
      }));
    }
  }
  if (scopeErrors.length) return failClosedResult(meta, overrides, rejected, scopeErrors);

  // override 指向了存在、但本次没有产生决策的规则：同样拒绝（不能静默贴别人身上）。
  const unmatchedOverrides = overrides.filter((override) => !decisions.some((decision) => decision.ruleId === override.ruleId));
  if (unmatchedOverrides.length) {
    return failClosedResult(meta, overrides, rejected, unmatchedOverrides.map((override) => makeError(
      ERROR_CODES.OVERRIDE_UNKNOWN,
      `override 指向的规则 ${override.ruleId} 没有产生决策：拒绝该 override，不贴到别的决策上`,
      { ruleId: override.ruleId },
    )));
  }

  applyOverrides(decisions, overrides);

  const needsHuman = decisions.some((decision) => decision.needsHuman === true) || rejected.length > 0;
  const primary = decisions.find((decision) => decision.action === winner.rule.decision.action
    && decision.ruleId === winner.rule.id) || decisions[0];

  return {
    caseId: parsed.caseId,
    turn: parsed.turn,
    decisions,
    needsHuman,
    confidence: primary.confidence,
    matchedRule: winner.rule.id,
    matchedRules: Array.from(new Set(decisions.map((decision) => decision.ruleId))),
    overrides: overrides.slice(),
    overrideAudit: {
      applied: overrides.length,
      rejected: rejected.length,
      records: overrides.slice(),
    },
    errors: rejectedErrors(rejected),
    decision: { target: primary.target, tool: primary.tool ?? null },
    target: primary.target,
    tool: primary.tool ?? null,
    level: winner.rule.level,
    ctx,
    ruleIds: Array.from(new Set(decisions.map((decision) => decision.ruleId))),
  };
}

function readMeta(input) {
  const meta = { caseId: null, turn: null };
  if (!input || typeof input !== 'object') return meta;
  try {
    if (typeof input.caseId === 'string' && input.caseId.trim()) meta.caseId = input.caseId.trim();
    if (typeof input.turn === 'number' && Number.isFinite(input.turn)) meta.turn = input.turn;
  } catch {
    /* 元信息读不到不影响路由 */
  }
  return meta;
}

/**
 * 判断一次请求该怎么走：只做匹配，不做执行。
 * 出错即停：任何规则/输入/override/scope/数量/profile 问题都返回 refuse + needsHuman + 具体错误码。
 * @param {object} [input] 新契约 { caseId, turn, utterance, ctx, candidates, override }；旧契约 { kind, text }
 * @param {object} [options] { profile }: 本次生效的策略 profile；缺省用配置项 routerPolicyProfile
 * @returns {object} decisions[] + needsHuman，同时保留 decision/target/tool 兼容别名
 */
export function route(input, options = {}) {
  const meta = readMeta(input);
  let applied = [];
  let rejected = [];
  let ctxReport = { ctx: {}, raw: null, problems: [] };
  try {
    ACTIVE_RUNTIME = runtimeFor(options && typeof options === 'object' ? options.profile : undefined);
    ({ applied, rejected } = readOverrides(input));
    const read = readInput(input);
    ctxReport = readCtxReport(input);
    const parsed = {
      kind: read.kind,
      text: read.text,
      caseId: meta.caseId,
      turn: meta.turn,
      ctx: ctxReport.ctx,
      ctxReport,
    };
    const base = { caseId: parsed.caseId, turn: parsed.turn, ctx: parsed.ctx };

    if (ACTIVE_RUNTIME.errors.length) return failClosedResult(base, applied, rejected, ACTIVE_RUNTIME.errors);
    if (LOAD_ERRORS.length) return failClosedResult(base, applied, rejected, LOAD_ERRORS);

    // ctx 本身的类型错误：与命中哪条规则无关，直接拒。
    if (ctxReport.problems.length) return failClosedResult(base, applied, rejected, ctxReport.problems);

    return routeValidated(input, parsed, applied, rejected);
  } catch (cause) {
    return failClosedResult({ caseId: meta.caseId, turn: meta.turn, ctx: ctxReport.ctx }, applied, rejected, [makeError(
      ERROR_CODES.CONTRACT,
      `route 内部异常（按 fail-closed 处理）：${cause && cause.message ? cause.message : String(cause)}`,
    )]);
  }
}

export default route;
