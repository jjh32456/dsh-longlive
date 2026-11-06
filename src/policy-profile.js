// 策略 profile 加载器：generic 是唯一默认层，owner profile 只能在其上收窄或补充。
// 这一层刻意放在 src/router 之外：判定层（route.js）可以 import 它，
// 但产品代码（index.js）不需要 import 任何带 router 字样的模块。
import { readFileSync } from 'node:fs';

export const POLICY_PROFILE_DEFAULT = 'generic';
export const POLICY_PROFILE_BASE = 'generic';
export const POLICY_PROFILE_SOURCE = 'J8-RULINGS-2026-11-03';
export const POLICY_PROFILE_DIR = new URL('./router/policies/', import.meta.url);

export const E_ROUTE_PROFILE_UNKNOWN = 'E_ROUTE_PROFILE_UNKNOWN';
export const E_ROUTE_POLICY_INVALID = 'E_ROUTE_POLICY_INVALID';

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE_KEYS = new Set([
  '$schema', 'name', 'description', 'version', 'source', 'failClosed', 'extends', 'rulings',
  'thresholds', 'limits', 'ask', 'privacy', 'rest', 'distill', 'revise', 'identity', 'writeScope'
]);
const OVERLAY_KEYS = new Set([
  '$schema', 'name', 'description', 'version', 'extends', 'source', 'failClosed', 'rulings',
  'thresholds', 'limits', 'ask', 'privacy', 'rest', 'distill', 'revise', 'identity', 'writeScope'
]);
const SECTION_KEYS = {
  thresholds: ['principle', 'compressAt', 'redAt', 'dispatchAt', 'taskboardAt'],
  limits: ['principle', 'maxRules', 'maxDecisions', 'maxCompeting'],
  ask: ['principle', 'maxQuestions', 'maxCandidates', 'guessAllowed', 'missing', 'prompt'],
  privacy: ['principle', 'markers', 'extraMarkers', 'store', 'dataClass', 'retention', 'echoBack', 'networkCalls', 'uploadAllowed'],
  rest: ['principle', 'markers', 'terminators', 'kind', 'resumable', 'terminal', 'resumePoint', 'resumePointRequired', 'pendingTask', 'forbiddenActions'],
  distill: ['principle', 'preferDistill', 'deleteBeforeConfirm', 'requireSupersedes', 'maxQuestions'],
  revise: ['principle', 'needsHuman'],
  identity: ['principle', 'consentHolder', 'userConsentCounts', 'requireQuote', 'requireQuoteId'],
  writeScope: ['principle', 'note', 'allowPrefixes']
};

let configuredName = POLICY_PROFILE_DEFAULT;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) return false;
  if (!allowEmpty && value.length === 0) return false;
  return value.every(isNonEmptyString);
}

function uniquePrefixes(list) {
  return [...new Set(list)];
}

function unknownKeys(object, allowed) {
  return Object.keys(object).filter((key) => !allowed.includes(key));
}

function safeScopePrefix(value) {
  if (!isNonEmptyString(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')) return false;
  if (value.includes('..') || value.includes('\\')) return false;
  return true;
}

function invalid(name, detail) {
  return {
    ok: false,
    name,
    code: E_ROUTE_POLICY_INVALID,
    message: `策略文件 ${name}.json 不合法：${detail}`
  };
}

function unknown(name) {
  return {
    ok: false,
    name,
    code: E_ROUTE_PROFILE_UNKNOWN,
    message: `未找到策略 profile「${name}」：可选值见 src/router/policies/*.json`
  };
}

function validateThresholds(base, section, where, fail) {
  if (!isObject(section)) return fail(`${where} 必须是对象`);
  const extra = unknownKeys(section, SECTION_KEYS.thresholds);
  if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
  for (const key of ['compressAt', 'redAt', 'dispatchAt', 'taskboardAt']) {
    if (section[key] === undefined) continue;
    if (!Number.isInteger(section[key])) return fail(`${where}.${key} 必须是整数`);
    if (section[key] < 0) return fail(`${where}.${key} 不能为负数`);
  }
  if (section.compressAt !== undefined && section.compressAt <= 0) return fail(`${where}.compressAt 必须 > 0`);
  const compressAt = section.compressAt ?? base.compressAt;
  const redAt = section.redAt ?? base.redAt;
  if (redAt <= compressAt) return fail(`${where}.redAt 必须大于 compressAt`);
  if (section.compressAt !== undefined && section.compressAt > base.compressAt) {
    return fail(`${where}.compressAt 不能放宽（> ${base.compressAt}）`);
  }
  if (section.redAt !== undefined && section.redAt > base.redAt) {
    return fail(`${where}.redAt 不能放宽（> ${base.redAt}）`);
  }
  if (section.dispatchAt !== undefined && section.dispatchAt < base.dispatchAt) {
    return fail(`${where}.dispatchAt 不能放宽（< ${base.dispatchAt}）`);
  }
  if (section.taskboardAt !== undefined && section.taskboardAt < base.taskboardAt) {
    return fail(`${where}.taskboardAt 不能放宽（< ${base.taskboardAt}）`);
  }
  return null;
}

function validateLimits(base, section, where, fail) {
  if (!isObject(section)) return fail(`${where} 必须是对象`);
  const extra = unknownKeys(section, SECTION_KEYS.limits);
  if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
  for (const key of ['maxRules', 'maxDecisions', 'maxCompeting']) {
    if (section[key] === undefined) continue;
    if (!Number.isInteger(section[key]) || section[key] < 1) return fail(`${where}.${key} 必须是正整数`);
    if (section[key] > base[key]) return fail(`${where}.${key} 不能放宽（> ${base[key]}）`);
  }
  return null;
}

function validateAsk(base, section, where, fail) {
  if (!isObject(section)) return fail(`${where} 必须是对象`);
  const extra = unknownKeys(section, SECTION_KEYS.ask);
  if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
  if (section.maxQuestions !== undefined) {
    if (!Number.isInteger(section.maxQuestions) || section.maxQuestions < 1 || section.maxQuestions > base.maxQuestions) {
      return fail(`${where}.maxQuestions 必须在 1..${base.maxQuestions}`);
    }
  }
  if (section.maxCandidates !== undefined) {
    if (!Number.isInteger(section.maxCandidates) || section.maxCandidates < 1 || section.maxCandidates > base.maxCandidates) {
      return fail(`${where}.maxCandidates 必须在 1..${base.maxCandidates}`);
    }
  }
  if (section.guessAllowed !== undefined && section.guessAllowed !== false) {
    return fail(`${where}.guessAllowed 不能改成 true（含糊必问）`);
  }
  if (section.missing !== undefined) {
    if (!isStringArray(section.missing)) return fail(`${where}.missing 必须是非空字符串数组`);
    const widened = section.missing.filter((item) => !base.missing.includes(item));
    if (widened.length) return fail(`${where}.missing 不能新增维度 ${widened.join(', ')}`);
  }
  if (section.prompt !== undefined && !isNonEmptyString(section.prompt)) return fail(`${where}.prompt 必须是非空字符串`);
  return null;
}

function validatePrivacy(base, section, where, fail) {
  if (!isObject(section)) return fail(`${where} 必须是对象`);
  const extra = unknownKeys(section, SECTION_KEYS.privacy);
  if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
  for (const key of ['markers', 'extraMarkers']) {
    if (section[key] !== undefined && !isStringArray(section[key])) return fail(`${where}.${key} 必须是字符串数组`);
  }
  if (section.echoBack !== undefined && section.echoBack !== false) return fail(`${where}.echoBack 不能改成 true`);
  if (section.networkCalls !== undefined && section.networkCalls !== 0) return fail(`${where}.networkCalls 必须为 0`);
  if (section.uploadAllowed !== undefined && section.uploadAllowed !== false) return fail(`${where}.uploadAllowed 必须为 false`);
  return null;
}

function validateRest(base, section, where, fail) {
  if (!isObject(section)) return fail(`${where} 必须是对象`);
  const extra = unknownKeys(section, SECTION_KEYS.rest);
  if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
  if (section.resumePoint !== undefined && !isNonEmptyString(section.resumePoint)) {
    return fail(`${where}.resumePoint 必须是非空字符串`);
  }
  if (section.resumePointRequired !== undefined && section.resumePointRequired !== true) {
    return fail(`${where}.resumePointRequired 不能改成 false`);
  }
  if (section.kind !== undefined && section.kind !== 'TEMPORARY') return fail(`${where}.kind 只能是 TEMPORARY`);
  if (section.resumable !== undefined && section.resumable !== true) return fail(`${where}.resumable 不能改成 false`);
  if (section.terminal !== undefined && section.terminal !== false) return fail(`${where}.terminal 不能改成 true`);
  if (section.forbiddenActions !== undefined) {
    if (!isStringArray(section.forbiddenActions)) return fail(`${where}.forbiddenActions 必须是字符串数组`);
    const missing = base.forbiddenActions.filter((item) => !section.forbiddenActions.includes(item));
    if (missing.length) return fail(`${where}.forbiddenActions 不能删项 ${missing.join(', ')}`);
  }
  return null;
}

function validateDistill(base, section, where, fail) {
  if (!isObject(section)) return fail(`${where} 必须是对象`);
  const extra = unknownKeys(section, SECTION_KEYS.distill);
  if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
  if (section.preferDistill !== undefined && section.preferDistill !== true) return fail(`${where}.preferDistill 不能改成 false`);
  if (section.deleteBeforeConfirm !== undefined && section.deleteBeforeConfirm !== false) {
    return fail(`${where}.deleteBeforeConfirm 不能改成 true`);
  }
  if (section.requireSupersedes !== undefined && section.requireSupersedes !== true) {
    return fail(`${where}.requireSupersedes 不能改成 false`);
  }
  if (section.maxQuestions !== undefined) {
    if (!Number.isInteger(section.maxQuestions) || section.maxQuestions < 1 || section.maxQuestions > base.maxQuestions) {
      return fail(`${where}.maxQuestions 必须在 1..${base.maxQuestions}`);
    }
  }
  return null;
}

function validateIdentity(section, where, fail) {
  if (!isObject(section)) return fail(`${where} 必须是对象`);
  const extra = unknownKeys(section, SECTION_KEYS.identity);
  if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
  if (section.consentHolder !== undefined && section.consentHolder !== 'assistant') {
    return fail(`${where}.consentHolder 只能是 assistant`);
  }
  if (section.userConsentCounts !== undefined && section.userConsentCounts !== false) {
    return fail(`${where}.userConsentCounts 不能改成 true`);
  }
  if (section.requireQuote !== undefined && section.requireQuote !== true) {
    return fail(`${where}.requireQuote 不能改成 false`);
  }
  if (section.requireQuoteId !== undefined && section.requireQuoteId !== true) {
    return fail(`${where}.requireQuoteId 只能收窄为 true`);
  }
  return null;
}

function validateWriteScope(base, section, where, fail) {
  if (!isObject(section)) return fail(`${where} 必须是对象`);
  const extra = unknownKeys(section, SECTION_KEYS.writeScope);
  if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
  if (section.allowPrefixes === undefined) return null;
  if (!isStringArray(section.allowPrefixes)) return fail(`${where}.allowPrefixes 必须是非空字符串数组`);
  const bad = section.allowPrefixes.filter((prefix) => !safeScopePrefix(prefix));
  if (bad.length) return fail(`${where}.allowPrefixes 含不安全前缀 ${bad.join(', ')}`);
  const widened = section.allowPrefixes.filter((prefix) => !base.allowPrefixes.includes(prefix));
  if (widened.length) return fail(`${where}.allowPrefixes 不能新增 ${widened.join(', ')}`);
  return null;
}

function validateBase(value, expectedName) {
  const fail = (detail) => invalid(expectedName, detail);
  if (!isObject(value)) return fail('根节点必须是对象');
  const extra = Object.keys(value).filter((key) => !BASE_KEYS.has(key));
  if (extra.length) return fail(`有未知字段 ${extra.join(', ')}`);
  if (value.name !== expectedName) return fail(`name 必须是「${expectedName}」`);
  if (value.failClosed !== true) return fail('failClosed 必须为 true');
  for (const key of ['thresholds', 'limits', 'ask', 'privacy', 'rest', 'distill', 'revise', 'identity', 'writeScope']) {
    if (!isObject(value[key])) return fail(`缺少 ${key} 段`);
  }
  const sectionFail = (detail) => fail(detail);
  let problem = validateThresholds(value.thresholds, value.thresholds, 'thresholds', sectionFail);
  if (problem) return problem;
  problem = validateLimits(value.limits, value.limits, 'limits', sectionFail);
  if (problem) return problem;
  problem = validateAsk(value.ask, value.ask, 'ask', sectionFail);
  if (problem) return problem;
  problem = validatePrivacy(value.privacy, value.privacy, 'privacy', sectionFail);
  if (problem) return problem;
  problem = validateRest(value.rest, value.rest, 'rest', sectionFail);
  if (problem) return problem;
  problem = validateDistill(value.distill, value.distill, 'distill', sectionFail);
  if (problem) return problem;
  problem = validateWriteScope(value.writeScope, value.writeScope, 'writeScope', sectionFail);
  if (problem) return problem;
  for (const key of ['compressAt', 'redAt', 'dispatchAt', 'taskboardAt']) {
    if (!Number.isInteger(value.thresholds[key])) return fail(`thresholds.${key} 必须是整数`);
  }
  for (const key of ['maxRules', 'maxDecisions', 'maxCompeting']) {
    if (!Number.isInteger(value.limits[key]) || value.limits[key] < 1) return fail(`limits.${key} 必须是正整数`);
  }
  if (!Number.isInteger(value.ask.maxQuestions) || value.ask.maxQuestions < 1) return fail('ask.maxQuestions 必须是正整数');
  if (!Number.isInteger(value.ask.maxCandidates) || value.ask.maxCandidates < 1) return fail('ask.maxCandidates 必须是正整数');
  if (value.ask.guessAllowed !== false) return fail('ask.guessAllowed 必须为 false');
  if (!isStringArray(value.ask.missing)) return fail('ask.missing 必须是非空字符串数组');
  if (!isNonEmptyString(value.ask.prompt)) return fail('ask.prompt 必须是非空字符串');
  if (!isStringArray(value.privacy.markers)) return fail('privacy.markers 必须是非空字符串数组');
  if (!safeScopePrefix(value.privacy.store)) return fail('privacy.store 必须是安全的相对路径');
  if (!isNonEmptyString(value.privacy.dataClass)) return fail('privacy.dataClass 必须是非空字符串');
  if (!isNonEmptyString(value.privacy.retention)) return fail('privacy.retention 必须是非空字符串');
  if (value.privacy.echoBack !== false) return fail('privacy.echoBack 必须为 false');
  if (value.privacy.networkCalls !== 0) return fail('privacy.networkCalls 必须为 0');
  if (value.privacy.uploadAllowed !== false) return fail('privacy.uploadAllowed 必须为 false');
  if (!isStringArray(value.rest.markers)) return fail('rest.markers 必须是非空字符串数组');
  if (!isStringArray(value.rest.terminators)) return fail('rest.terminators 必须是非空字符串数组');
  if (value.rest.kind !== 'TEMPORARY') return fail('rest.kind 必须是 TEMPORARY');
  if (value.rest.resumable !== true) return fail('rest.resumable 必须为 true');
  if (value.rest.terminal !== false) return fail('rest.terminal 必须为 false');
  if (!isNonEmptyString(value.rest.resumePoint)) return fail('rest.resumePoint 必须是非空字符串');
  if (value.rest.resumePointRequired !== true) return fail('rest.resumePointRequired 必须为 true');
  if (value.rest.pendingTask !== 'keep') return fail('rest.pendingTask 必须是 keep');
  if (!isStringArray(value.rest.forbiddenActions)) return fail('rest.forbiddenActions 必须是非空字符串数组');
  if (value.distill.preferDistill !== true) return fail('distill.preferDistill 必须为 true');
  if (value.distill.deleteBeforeConfirm !== false) return fail('distill.deleteBeforeConfirm 必须为 false');
  if (value.distill.requireSupersedes !== true) return fail('distill.requireSupersedes 必须为 true');
  if (value.revise.needsHuman !== false) return fail('revise.needsHuman 必须为 false');
  if (value.identity.consentHolder !== 'assistant') return fail('identity.consentHolder 必须是 assistant');
  if (value.identity.userConsentCounts !== false) return fail('identity.userConsentCounts 必须为 false');
  if (value.identity.requireQuote !== true) return fail('identity.requireQuote 必须为 true');
  if (typeof value.identity.requireQuoteId !== 'boolean') return fail('identity.requireQuoteId 必须是布尔值');
  if (!isStringArray(value.writeScope.allowPrefixes)) return fail('writeScope.allowPrefixes 必须是非空字符串数组');
  for (const prefix of value.writeScope.allowPrefixes) {
    if (!safeScopePrefix(prefix)) return fail(`writeScope.allowPrefixes 含不安全前缀 ${prefix}`);
  }
  return null;
}

function validateRulings(rulings, fail) {
  if (!Array.isArray(rulings) || rulings.length === 0) return fail('rulings 必须是非空数组');
  const ids = new Set();
  for (const [index, ruling] of rulings.entries()) {
    const where = `rulings[${index}]`;
    if (!isObject(ruling)) return fail(`${where} 必须是对象`);
    const extra = Object.keys(ruling).filter((key) => !['id', 'title', 'rule', 'source', 'quote'].includes(key));
    if (extra.length) return fail(`${where} 有未知字段 ${extra.join(', ')}`);
    for (const key of ['id', 'title', 'rule', 'source']) {
      if (!isNonEmptyString(ruling[key])) return fail(`${where}.${key} 必须是非空字符串`);
    }
    if (ruling.quote !== undefined && !isNonEmptyString(ruling.quote)) return fail(`${where}.quote 必须是非空字符串`);
    if (ruling.source !== POLICY_PROFILE_SOURCE) return fail(`${where}.source 必须是 ${POLICY_PROFILE_SOURCE}`);
    if (ids.has(ruling.id)) return fail(`${where}.id 重复：${ruling.id}`);
    ids.add(ruling.id);
  }
  return null;
}

function validateOverlay(value, base, expectedName) {
  const fail = (detail) => invalid(expectedName, detail);
  if (!isObject(value)) return fail('根节点必须是对象');
  const extra = Object.keys(value).filter((key) => !OVERLAY_KEYS.has(key));
  if (extra.length) return fail(`有未知字段 ${extra.join(', ')}`);
  if (value.name !== expectedName) return fail(`name 必须是「${expectedName}」`);
  if (value.extends !== POLICY_PROFILE_BASE) return fail(`extends 必须是 ${POLICY_PROFILE_BASE}`);
  if (value.failClosed !== undefined && value.failClosed !== true) return fail('failClosed 不能改成 false');
  const sections = ['thresholds', 'limits', 'ask', 'privacy', 'rest', 'distill', 'revise', 'identity', 'writeScope'];
  const declared = sections.filter((key) => value[key] !== undefined);
  if (declared.length === 0 && value.rulings === undefined) return fail('至少声明一个差异段或 rulings');
  const sectionFail = (detail) => fail(detail);
  let problem = null;
  if (value.thresholds !== undefined) problem = validateThresholds(base.thresholds, value.thresholds, 'thresholds', sectionFail);
  if (!problem && value.limits !== undefined) problem = validateLimits(base, value.limits, 'limits', sectionFail);
  if (!problem && value.ask !== undefined) problem = validateAsk(base.ask, value.ask, 'ask', sectionFail);
  if (!problem && value.privacy !== undefined) problem = validatePrivacy(base.privacy, value.privacy, 'privacy', sectionFail);
  if (!problem && value.rest !== undefined) problem = validateRest(base.rest, value.rest, 'rest', sectionFail);
  if (!problem && value.distill !== undefined) problem = validateDistill(base.distill, value.distill, 'distill', sectionFail);
  if (!problem && value.revise !== undefined) {
    if (!isObject(value.revise)) problem = fail('revise 必须是对象');
    else {
      const extraRevise = unknownKeys(value.revise, SECTION_KEYS.revise);
      if (extraRevise.length) problem = fail(`revise 有未知字段 ${extraRevise.join(', ')}`);
      else if (value.revise.needsHuman !== undefined && value.revise.needsHuman !== false) problem = fail('revise.needsHuman 不能改成 true');
    }
  }
  if (!problem && value.identity !== undefined) problem = validateIdentity(value.identity, 'identity', sectionFail);
  if (!problem && value.writeScope !== undefined) problem = validateWriteScope(base.writeScope, value.writeScope, 'writeScope', sectionFail);
  if (!problem && value.rulings !== undefined) problem = validateRulings(value.rulings, sectionFail);
  return problem;
}

export function mergePolicyProfile(base, overlay) {
  const merged = JSON.parse(JSON.stringify(base));
  merged.name = overlay.name;
  merged.extends = POLICY_PROFILE_BASE;
  merged.source = overlay.source || base.source;
  merged.rulings = overlay.rulings ? JSON.parse(JSON.stringify(overlay.rulings)) : [];
  if (overlay.description !== undefined) merged.description = overlay.description;

  if (overlay.thresholds) Object.assign(merged.thresholds, overlay.thresholds);
  if (overlay.limits) Object.assign(merged.limits, overlay.limits);
  if (overlay.ask) Object.assign(merged.ask, overlay.ask);
  if (overlay.privacy) {
    const markers = [
      ...base.privacy.markers,
      ...(overlay.privacy.markers || []),
      ...(overlay.privacy.extraMarkers || [])
    ];
    merged.privacy.markers = uniquePrefixes(markers);
    merged.privacy.extraMarkers = (overlay.privacy.extraMarkers || []).slice();
    if (overlay.privacy.echoBack !== undefined) merged.privacy.echoBack = overlay.privacy.echoBack;
    if (overlay.privacy.networkCalls !== undefined) merged.privacy.networkCalls = overlay.privacy.networkCalls;
    if (overlay.privacy.uploadAllowed !== undefined) merged.privacy.uploadAllowed = overlay.privacy.uploadAllowed;
  }
  if (overlay.rest) {
    if (overlay.rest.resumePoint !== undefined) merged.rest.resumePoint = overlay.rest.resumePoint;
    if (overlay.rest.forbiddenActions !== undefined) {
      merged.rest.forbiddenActions = uniquePrefixes([...base.rest.forbiddenActions, ...overlay.rest.forbiddenActions]);
    }
  }
  if (overlay.distill) Object.assign(merged.distill, overlay.distill);
  if (overlay.revise) Object.assign(merged.revise, overlay.revise);
  if (overlay.identity) Object.assign(merged.identity, overlay.identity);
  if (overlay.writeScope && overlay.writeScope.allowPrefixes !== undefined) {
    merged.writeScope.allowPrefixes = overlay.writeScope.allowPrefixes.slice();
  }
  return merged;
}

function readProfile(name, dir = POLICY_PROFILE_DIR) {
  const url = new URL(`${name}.json`, dir);
  let text;
  try {
    text = readFileSync(url, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { error: unknown(name) };
    return { error: invalid(name, `读取失败：${error && error.message ? error.message : String(error)}`) };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: invalid(name, `JSON 解析失败：${error && error.message ? error.message : String(error)}`) };
  }
}

// options.dir 只给测试用：指向另一份 policies/（URL），用来在 tmp 里放坏文件，
// 避免套件运行期间往包树写样本（P6 会给包树拍快照）。生产调用不传。
export function loadPolicyProfile(name = POLICY_PROFILE_DEFAULT, options = {}) {
  if (!isNonEmptyString(name) || !PROFILE_NAME_RE.test(name)) return unknown(String(name));
  const dir = options && options.dir ? options.dir : POLICY_PROFILE_DIR;
  const baseRead = readProfile(POLICY_PROFILE_BASE, dir);
  if (baseRead.error) return baseRead.error;
  const baseProblem = validateBase(baseRead.value, POLICY_PROFILE_BASE);
  if (baseProblem) return baseProblem;
  const base = baseRead.value;
  if (name === POLICY_PROFILE_BASE) {
    return { ok: true, name, policy: JSON.parse(JSON.stringify(base)), sources: [`${name}.json`] };
  }
  const overlayRead = readProfile(name, dir);
  if (overlayRead.error) return overlayRead.error;
  const overlayProblem = validateOverlay(overlayRead.value, base, name);
  if (overlayProblem) return overlayProblem;
  const policy = mergePolicyProfile(base, overlayRead.value);
  const mergedProblem = validateBase(policy, name);
  if (mergedProblem) return mergedProblem;
  return { ok: true, name, policy, sources: [`${POLICY_PROFILE_BASE}.json`, `${name}.json`] };
}

export function configurePolicyProfile(name) {
  const requested = name === undefined || name === null || name === '' ? POLICY_PROFILE_DEFAULT : name;
  configuredName = typeof requested === 'string' ? requested : String(requested);
  return loadPolicyProfile(configuredName);
}

export function configuredPolicyProfileName() {
  return configuredName;
}

export function resetPolicyProfileForTests() {
  configuredName = POLICY_PROFILE_DEFAULT;
}

export function isPolicyProfileName(name) {
  return isNonEmptyString(name) && PROFILE_NAME_RE.test(name);
}
