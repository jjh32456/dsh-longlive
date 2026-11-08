import { externalActionGroups, isExternalMemoryProfileEdit } from '../adapters/registry.js';

// R1 Router-A — judge（J0–J8）。
//
// judge 与规则作者分离（R1-DESIGN.md §3.4）：这里只读 route() 的输出、fixture 的期望
// 与盘上的证据，不改规则、不改决定。每条 judge 返回 { ok, code?, message }，
// code 一律取 route.js 的 ERROR_CODES（E_ROUTE_* 前缀）。
//
// 本文件的 J0–J8 按任务书定义（与设计文档 §3.3 的 judge 表编号不同，映射见
// CHANGES-r1-align.md 的失败码表）：
//   J0 隔离       沙盒内无真实库写入；真实库前后 hash 一致            E_ROUTE_ISOLATION
//   J1 单条       期望单条时 decisions 恰好 1 条                      E_ROUTE_SHAPE
//   J2 多条顺序   多条时条数/顺序/kind/action/ruleId 逐位一致          E_ROUTE_ORDER / E_ROUTE_ACTION
//   J3 拒绝       越界动作必须拒绝且零写入                            E_ROUTE_REFUSAL
//   J4 证据       每条决定 evidence 非空、可解析、ctx 字段有留痕        E_ROUTE_EVIDENCE
//   J5 override   无理由 override 必拒且不改判定                      E_ROUTE_OVERRIDE_UNJUSTIFIED
//   J6 writeScope 声明 ⊆ 允许；拒绝类必须为空；期望产物必须被声明       E_ROUTE_SCOPE
//   J7 审计       decisions.jsonl 每行带 overrides（理由/谁/时间戳）    E_ROUTE_AUDIT
//   J8 needsHuman 语义：审批类决定为真；H 级签字用例为真               E_ROUTE_HUMAN

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ERROR_CODES,
  FALLBACKS,
  LEVELS,
  POLICY,
  RULES,
  canonicalAction,
  route,
} from './route.js';

export const JUDGE_IDS = Object.freeze(['J0', 'J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9']);

export const JUDGE_TITLES = Object.freeze({
  J0: '隔离：沙盒无真实库写入 + 真实库前后 hash 一致',
  J1: '单条：期望单条时 decisions 恰好 1 条',
  J2: '多条顺序：条数/顺序/kind/action/ruleId 逐位一致',
  J3: '拒绝：越界动作必须拒绝且零写入',
  J4: '证据：每条决定 evidence 非空、可解析、ctx 字段留痕',
  J5: 'override：无理由必拒且不改判定',
  J6: 'writeScope：声明 ⊆ 允许，拒绝类为空，期望产物被声明',
  J7: '审计：decisions.jsonl 每行 overrides 带理由/谁/时间戳',
  J8: 'needsHuman：审批类决定为真，H 级签字用例为真',
  J9: '身份同意：改名字/画像必须有当前会话助手本人的 consent 记录，用户单方面同意不算',
});

// §5.7 执行矩阵：fixture 的 level 必须与设计表一致（M3=D，S4/X1=H）。
export const LEVEL_MATRIX = Object.freeze({
  T1: 'X', T2: 'X', T3: 'X', T4: 'X',
  M1: 'X', M2: 'X', M3: 'D', M4: 'D',
  S1: 'X', S2: 'X', S3: 'X', S4: 'H',
  X1: 'H', X2: 'X',
  // J8（2026-11-03）：五条草案并入正式矩阵，全部 X。
  S5: 'X', S6: 'X', M5: 'X', M6: 'X', M7: 'X',
});

export const SIGN_OFF = Object.freeze({ S4: 'human', X1: 'human' });

// 需要人点头/人签字才能执行的动作；needsHuman 由它们推出来。
export const APPROVAL_ACTIONS = Object.freeze([
  'guard.refuse',
  'session.handover',
  'reply.only',
  'reply.no_write',
  // J8：提问本身是需要人回答的审批类动作；删除必须人二次确认。identity.hold 刻意不在列——
  // 需要点头的是当前会话的助手本人，不是用户，needsHuman 不能替助手点头。
  'reply.ask',
  'memory.delete',
  ...externalActionGroups('approval'),
]);

// 会落盘/写记忆的动作；拒绝类用例里一条都不许出现。
export const WRITE_ACTIONS = Object.freeze([
  ...externalActionGroups('write'),
  'journal.append',
  'topics.write',
  'procedures.draft',
]);

export const FIXTURE_IDS = Object.freeze(Object.keys(LEVEL_MATRIX));

const EVIDENCE_SCHEMES = Object.freeze(['file', 'policy', 'ctx', 'output', 'fixture']);

function ok(detail) {
  return { ok: true, detail };
}

function bad(code, message) {
  return { ok: false, code, message };
}

function actionOf(decision) {
  return canonicalAction(decision && decision.action) || (decision && decision.action) || '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// 允许集 = 规则表里出现过的全部动作（decision / before / after）。judge 的 J2 用它判 E_ROUTE_ACTION。
const ALLOWED_ACTIONS = new Set();
for (const rule of [...RULES, ...(FALLBACKS || [])]) {
  for (const template of [rule.decision, ...asArray(rule.before), ...asArray(rule.after)]) {
    if (template && template.action) ALLOWED_ACTIONS.add(canonicalAction(template.action) || template.action);
  }
}

// ── fixture ──────────────────────────────────────────────────

export function fixtureInput(fixture) {
  return {
    caseId: fixture.id,
    turn: fixture.turn,
    utterance: fixture.utterance,
    kind: fixture.kind,
    ctx: fixture.ctx || {},
    candidates: fixture.candidates || [],
  };
}

export function validateFixture(fixture) {
  const errors = [];
  const push = (code, message) => errors.push({ code, message });
  if (!fixture || typeof fixture !== 'object') {
    push(ERROR_CODES.CONTRACT, 'fixture 不是对象');
    return errors;
  }
  const id = typeof fixture.id === 'string' ? fixture.id.trim() : '';
  if (!FIXTURE_IDS.includes(id)) push(ERROR_CODES.CONTRACT, `fixture id 非法：${id || '(空)'}`);
  if (!['X', 'D', 'H'].includes(fixture.level)) push(ERROR_CODES.LEVEL, `${id}: level ${fixture.level} 不在 X/D/H`);
  if (typeof fixture.utterance !== 'string' || !fixture.utterance.trim()) {
    push(ERROR_CODES.CONTRACT, `${id}: utterance 为空`);
  }
  if (!['tool', 'memory', 'session'].includes(fixture.kind)) push(ERROR_CODES.CONTRACT, `${id}: kind 非法`);
  if (!asArray(fixture.failIf).length) push(ERROR_CODES.CONTRACT, `${id}: failIf 为空`);
  const expect = fixture.expect;
  if (!expect || typeof expect !== 'object') {
    push(ERROR_CODES.CONTRACT, `${id}: 缺 expect`);
  } else {
    if (!asArray(expect.decisions).length) push(ERROR_CODES.CONTRACT, `${id}: expect.decisions 为空`);
    if (!Array.isArray(expect.forbiddenActions)) push(ERROR_CODES.CONTRACT, `${id}: expect.forbiddenActions 必须是数组`);
    if (!Array.isArray(expect.writeScope)) push(ERROR_CODES.CONTRACT, `${id}: expect.writeScope 必须是数组`);
    if (typeof expect.needsHuman !== 'boolean') push(ERROR_CODES.CONTRACT, `${id}: expect.needsHuman 必须是布尔`);
  }
  if (LEVEL_MATRIX[id] && fixture.level !== LEVEL_MATRIX[id]) {
    push(ERROR_CODES.LEVEL, `${id}: level ${fixture.level} 与设计 §5.7 的 ${LEVEL_MATRIX[id]} 不一致`);
  }
  return errors;
}

export function loadFixtures(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
  const fixtures = [];
  const errors = [];
  for (const file of entries) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push({ code: ERROR_CODES.CONTRACT, message: `${path.basename(file)}: JSON 解析失败 ${error.message}` });
      continue;
    }
    const fixtureErrors = validateFixture(parsed);
    if (fixtureErrors.length) {
      errors.push(...fixtureErrors.map((item) => ({ ...item, message: `${path.basename(file)}: ${item.message}` })));
      continue;
    }
    fixtures.push(parsed);
  }
  return { fixtures, errors, files: entries };
}

// ── J1 / J2 形状与顺序 ───────────────────────────────────────

export function judgeJ1(fixture, result) {
  const expected = asArray(fixture.expect && fixture.expect.decisions);
  const actual = asArray(result && result.decisions);
  if (!actual.length) return bad(ERROR_CODES.SHAPE, `${fixture.id}: 没有任何决定`);
  if (expected.length === 1 && actual.length !== 1) {
    return bad(ERROR_CODES.SHAPE, `${fixture.id}: 期望 1 条决定，实际 ${actual.length} 条（${actual.map((d) => actionOf(d)).join(', ')}）`);
  }
  return ok(`${actual.length} decisions`);
}

export function judgeJ2(fixture, result) {
  const expected = asArray(fixture.expect && fixture.expect.decisions);
  const actual = asArray(result && result.decisions);
  for (const decision of actual) {
    const action = actionOf(decision);
    if (action && ALLOWED_ACTIONS.size > 0 && !ALLOWED_ACTIONS.has(action)) {
      return bad(ERROR_CODES.ACTION, `${fixture.id}: action ${action} 不在规则表的允许集`);
    }
  }
  if (expected.length <= 1) {
    if (expected.length === 1 && actual.length >= 1) {
      const want = expected[0];
      const got = actual[0];
      if (want.kind && got.kind !== want.kind) {
        return bad(ERROR_CODES.ORDER, `${fixture.id}: 第 1 条 kind ${got.kind} != ${want.kind}`);
      }
    }
    return ok('single');
  }
  if (actual.length !== expected.length) {
    return bad(ERROR_CODES.ORDER, `${fixture.id}: 条数 ${actual.length} != ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index];
    const got = actual[index];
    if (want.kind && got.kind !== want.kind) {
      return bad(ERROR_CODES.ORDER, `${fixture.id}: 第 ${index + 1} 条 kind ${got.kind} != ${want.kind}`);
    }
    const allowed = asArray(want.actionIn).map((name) => canonicalAction(name) || name);
    if (allowed.length && !allowed.includes(actionOf(got))) {
      return bad(ERROR_CODES.ORDER, `${fixture.id}: 第 ${index + 1} 条 action ${actionOf(got)} 不在 ${allowed.join('|')}`);
    }
    const rules = asArray(want.ruleIdIn);
    if (rules.length && !rules.includes(got.ruleId)) {
      return bad(ERROR_CODES.ORDER, `${fixture.id}: 第 ${index + 1} 条 ruleId ${got.ruleId} 不在 ${rules.join('|')}`);
    }
  }
  return ok(`${expected.length} decisions in order`);
}

// ── J3 拒绝 ─────────────────────────────────────────────────

export function judgeJ3(fixture, result) {
  const expect = fixture.expect || {};
  const decisions = asArray(result && result.decisions);
  const writes = decisions.filter((decision) => WRITE_ACTIONS.includes(actionOf(decision)));
  if (expect.refusal) {
    if (!decisions.length) return bad(ERROR_CODES.REFUSAL, `${fixture.id}: 拒绝用例没有决定`);
    const primary = decisions[0];
    if (primary.kind !== 'reply') {
      return bad(ERROR_CODES.REFUSAL, `${fixture.id}: 拒绝决定 kind ${primary.kind} 应为 reply`);
    }
    if (result.target !== 'none') {
      return bad(ERROR_CODES.REFUSAL, `${fixture.id}: 拒绝用例 target ${result.target} 应为 none`);
    }
    if (asArray(primary.writeScope).length > 0) {
      return bad(ERROR_CODES.REFUSAL, `${fixture.id}: 拒绝决定仍声明写入 ${primary.writeScope.join('|')}`);
    }
    if (result.needsHuman !== true) {
      return bad(ERROR_CODES.REFUSAL, `${fixture.id}: 拒绝必须让人点头（needsHuman=false）`);
    }
  }
  if (expect.refusal && writes.length) {
    return bad(ERROR_CODES.REFUSAL, `${fixture.id}: 拒绝用例出现写入动作 ${writes.map((d) => actionOf(d)).join(', ')}`);
  }
  return ok(expect.refusal ? 'refusal with zero writes' : 'no refusal expected');
}

// ── J4 证据 ─────────────────────────────────────────────────

function isSafeRelPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/^[A-Za-z]:/.test(value)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes('..')
    && !value.includes('~');
}

export function classifyEvidence(entry) {
  if (typeof entry !== 'string' || !entry.trim()) return { scheme: null };
  const value = entry.trim();
  if (value.startsWith('policy:')) return { scheme: 'policy', value: value.slice(7) };
  if (value.startsWith('ctx:')) return { scheme: 'ctx', value: value.slice(4) };
  if (value.startsWith('output:')) return { scheme: 'output', value: value.slice(7) };
  if (value.startsWith('fixture:')) return { scheme: 'fixture', value: value.slice(8) };
  const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(value);
  if (match && isSafeRelPath(match[1])) {
    return {
      scheme: 'file',
      value: match[1],
      line: Number(match[2]),
      endLine: match[3] ? Number(match[3]) : Number(match[2]),
    };
  }
  return { scheme: null };
}

export function usesCtxFields(decision) {
  const args = (decision && decision.args) || {};
  const fields = [];
  for (const field of ['tokens', 'zone', 'activeWorkers', 'openRows']) {
    if (Object.prototype.hasOwnProperty.call(args, field)) fields.push(field);
  }
  return fields;
}

/**
 * J4：每条决定 evidence 非空、每条都能归到一种 scheme、文件行真的存在且内容对得上，
 * 用过的 ctx 字段必须留痕。
 * @param {object} fixture
 * @param {object} result
 * @param {{repoRoot?: string, design?: object, evidenceIndex?: Set<string>}} [opts]
 */
export function judgeJ4(fixture, result, opts = {}) {
  const decisions = asArray(result && result.decisions);
  if (!decisions.length) return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: 没有决定可查证据`);
  const repoRoot = opts.repoRoot || process.cwd();
  const design = opts.design || null;
  const ctx = (fixture && fixture.ctx) || {};
  const evidenceIndex = opts.evidenceIndex || null;

  for (const decision of decisions) {
    const evidence = asArray(decision.evidence);
    if (!evidence.length) {
      return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: ${actionOf(decision)} 没有 evidence`);
    }
    let hasSource = false;
    for (const entry of evidence) {
      const parsed = classifyEvidence(entry);
      if (!EVIDENCE_SCHEMES.includes(parsed.scheme)) {
        return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: 证据不可解析 ${JSON.stringify(entry)}`);
      }
      if (parsed.scheme === 'ctx') {
        if (!Object.prototype.hasOwnProperty.call(ctx, parsed.value)) {
          return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: 证据引用 ctx:${parsed.value}，但 fixture 没给这个字段`);
        }
        hasSource = true;
      }
      if (parsed.scheme === 'policy') {
        if (!design) {
          hasSource = true;
          continue;
        }
        const resolved = resolvePolicyRef(parsed.value, design);
        if (!resolved.ok) {
          return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: policy 证据解析失败：${resolved.message}`);
        }
        if (decision.ruleId) {
          const rule = RULES.find((item) => item.id === decision.ruleId);
          if (rule && rule.policyRef && rule.policyRef !== parsed.value) {
            return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: ${decision.ruleId} policyRef ${rule.policyRef} != 证据 ${parsed.value}`);
          }
        }
        hasSource = true;
      }
      if (parsed.scheme === 'file') {
        const file = path.join(repoRoot, parsed.value);
        if (!fs.existsSync(file)) {
          return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: 证据文件不存在 ${parsed.value}`);
        }
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        if (parsed.line < 1 || parsed.line > lines.length) {
          return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: 证据行 ${parsed.value}:${parsed.line} 越界`);
        }
        if (parsed.value === 'src/router/routing-rules.json' && decision.ruleId) {
          const line = lines[parsed.line - 1];
          if (!line.includes(`"${decision.ruleId}"`)) {
            return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: ${parsed.value}:${parsed.line} 不是 ${decision.ruleId} 的定义行`);
          }
        }
        hasSource = true;
      }
      if (parsed.scheme === 'output') {
        if (!/^[0-9a-f]{8,64}$/i.test(parsed.value)) {
          return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: output:${parsed.value} 不是 sha256`);
        }
        if (evidenceIndex && !evidenceIndex.has(parsed.value.toLowerCase())) {
          return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: output:${parsed.value} 在证据目录里找不到`);
        }
        hasSource = true;
      }
      if (parsed.scheme === 'fixture') {
        if (parsed.value !== fixture.id) {
          return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: 证据指向别的 fixture ${parsed.value}`);
        }
        hasSource = true;
      }
    }
    if (!hasSource) return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: ${actionOf(decision)} 没有可解析的来源证据`);

    for (const field of usesCtxFields(decision)) {
      if (!evidence.includes(`ctx:${field}`)) {
        return bad(ERROR_CODES.EVIDENCE, `${fixture.id}: ${actionOf(decision)} 用了 ctx.${field} 却没写 ctx:${field} 证据`);
      }
    }
  }
  return ok(`${decisions.length} decisions with evidence`);
}

// ── J5 override ─────────────────────────────────────────────

export function judgeJ5(fixture, result = null, opts = {}) {
  const routeFn = opts.route || route;
  const input = fixtureInput(fixture);
  const baseline = result || routeFn(input);
  const ruleId = baseline.matchedRule || 'R-TOOL-CTX';

  const unjustified = routeFn({ ...input, override: { ruleId, by: 'tester' } });
  if (!(unjustified.overrideAudit && unjustified.overrideAudit.rejected >= 1)) {
    return bad(ERROR_CODES.OVERRIDE_UNJUSTIFIED, `${fixture.id}: 无理由 override 没被拒`);
  }
  if (!asArray(unjustified.errors).some((error) => error.code === ERROR_CODES.OVERRIDE_UNJUSTIFIED)) {
    return bad(ERROR_CODES.OVERRIDE_UNJUSTIFIED, `${fixture.id}: 无理由 override 没计入 E_ROUTE_OVERRIDE_UNJUSTIFIED`);
  }
  if (asArray(unjustified.overrides).length !== 0) {
    return bad(ERROR_CODES.OVERRIDE_UNJUSTIFIED, `${fixture.id}: 无理由 override 被回显为已生效`);
  }
  if (JSON.stringify(unjustified.decisions) !== JSON.stringify(baseline.decisions)) {
    return bad(ERROR_CODES.OVERRIDE_UNJUSTIFIED, `${fixture.id}: 无理由 override 改变了判定`);
  }
  if (unjustified.needsHuman !== true) {
    return bad(ERROR_CODES.OVERRIDE_UNJUSTIFIED, `${fixture.id}: 无理由 override 应升级为 needsHuman=true`);
  }

  const justifiedInput = {
    ...input,
    override: {
      ruleId,
      reason: '会话判断：这次只是复述别人的决定，不构成新决策',
      by: '测试用户',
      at: '2026-11-03T02:44:31+08:00',
    },
  };
  const justified = routeFn(justifiedInput);
  if (asArray(justified.overrides).length !== 1) {
    return bad(ERROR_CODES.OVERRIDE_UNJUSTIFIED, `${fixture.id}: 有理由 override 没有留痕`);
  }
  const record = justified.overrides[0];
  if (record.ruleId !== ruleId || !record.reason || !record.by || !record.at) {
    return bad(ERROR_CODES.OVERRIDE_UNJUSTIFIED, `${fixture.id}: override 记录缺字段 ${JSON.stringify(record)}`);
  }
  const annotated = asArray(justified.decisions).some((decision) => decision.overridden
    && decision.overridden.reason === record.reason);
  if (!annotated) {
    return bad(ERROR_CODES.OVERRIDE_UNJUSTIFIED, `${fixture.id}: 生效的 override 没标注到决定上`);
  }
  return ok('unjustified rejected, justified recorded');
}

// ── J6 writeScope ───────────────────────────────────────────

export function validateWriteScope(scope, policy = POLICY) {
  const errors = [];
  for (const entry of asArray(scope)) {
    if (typeof entry !== 'string' || !entry.trim()) {
      errors.push('空条目');
      continue;
    }
    if (/^[A-Za-z]:/.test(entry)) {
      errors.push(`盘符路径 ${entry}`);
      continue;
    }
    if (entry.startsWith('/') || entry.startsWith('\\')) {
      errors.push(`绝对路径 ${entry}`);
      continue;
    }
    if (entry.includes('..')) {
      errors.push(`父目录跳转 ${entry}`);
      continue;
    }
    if (entry.includes('~')) {
      errors.push(`家目录 ${entry}`);
      continue;
    }
    if (!policy.allow.some((prefix) => entry.startsWith(prefix))) {
      errors.push(`不在允许前缀内 ${entry}`);
    }
  }
  return errors;
}

export function judgeJ6(fixture, result, opts = {}) {
  const policy = opts.policy || POLICY;
  const expect = fixture.expect || {};
  const decisions = asArray(result && result.decisions);
  for (const [index, decision] of decisions.entries()) {
    const errors = validateWriteScope(decision.writeScope, policy);
    if (errors.length) {
      return bad(ERROR_CODES.SCOPE, `${fixture.id}: ${actionOf(decision)} writeScope 越界（${errors.join('; ')}）`);
    }
    if (expect.refusal) {
      const scope = asArray(decision.writeScope);
      // 拒绝类用例：拒绝本身零写入；后续 dry-run 只允许写沙盒。
      if (index === 0 && scope.length) {
        return bad(ERROR_CODES.SCOPE, `${fixture.id}: 拒绝决定声明了写入 ${scope.join('|')}`);
      }
      const outside = scope.filter((entry) => !entry.startsWith('sandbox:'));
      if (outside.length) {
        return bad(ERROR_CODES.SCOPE, `${fixture.id}: 拒绝用例出现非沙盒写入 ${outside.join('|')}`);
      }
    }
  }
  const declared = new Set();
  for (const decision of decisions) for (const entry of asArray(decision.writeScope)) declared.add(entry);
  for (const required of asArray(expect.writeScope)) {
    if (!declared.has(required)) {
      return bad(ERROR_CODES.SCOPE, `${fixture.id}: 期望写的 ${required} 没被任何决定声明`);
    }
  }
  return ok(`${declared.size} declared scopes`);
}

// ── J7 审计 ─────────────────────────────────────────────────

export function judgeJ7Record(record) {
  if (!record || typeof record !== 'object') return bad(ERROR_CODES.AUDIT, 'override 记录不是对象');
  if (typeof record.reason !== 'string' || !record.reason.trim()) {
    return bad(ERROR_CODES.AUDIT, 'override 记录缺原始理由');
  }
  if (typeof record.by !== 'string' || !record.by.trim()) {
    return bad(ERROR_CODES.AUDIT, 'override 记录缺"谁覆盖"');
  }
  if (typeof record.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(record.at)) {
    return bad(ERROR_CODES.AUDIT, `override 记录缺 ISO 时间戳：${JSON.stringify(record.at)}`);
  }
  return ok('audit record complete');
}

export function judgeJ7(fixture, result) {
  const audit = (result && result.overrideAudit) || null;
  if (!audit || typeof audit !== 'object') return bad(ERROR_CODES.AUDIT, `${fixture.id}: 缺 overrideAudit`);
  if (!Array.isArray(audit.records)) return bad(ERROR_CODES.AUDIT, `${fixture.id}: overrideAudit.records 不是数组`);
  if (audit.applied !== audit.records.length) {
    return bad(ERROR_CODES.AUDIT, `${fixture.id}: applied ${audit.applied} != records ${audit.records.length}`);
  }
  for (const record of audit.records) {
    const judged = judgeJ7Record(record);
    if (!judged.ok) return bad(ERROR_CODES.AUDIT, `${fixture.id}: ${judged.message}`);
  }
  for (const error of asArray(result.errors)) {
    if (error.code === ERROR_CODES.OVERRIDE_UNJUSTIFIED && !error.ruleId) {
      return bad(ERROR_CODES.AUDIT, `${fixture.id}: 被拒 override 的审计缺 ruleId`);
    }
  }
  return ok(`${audit.records.length} records, ${audit.rejected} rejected`);
}

/** 任务书五要素：目标 / 输入 / 产物 / 验收命令 / 时限；派活必须有绝对或带根的产物路径。 */
export function judgeBrief(fixture, result) {
  const spawns = asArray(result && result.decisions).filter((decision) => actionOf(decision) === 'worker_spawn');
  if (spawns.length === 0) return ok('no dispatch decision');
  for (const decision of spawns) {
    const args = decision.args || {};
    const brief = args.brief;
    if (!brief || typeof brief !== 'object') return bad(ERROR_CODES.BRIEF, `${fixture.id}: 任务书缺失（args.brief）`);
    if (typeof brief.goal !== 'string' || !brief.goal.trim()) return bad(ERROR_CODES.BRIEF, `${fixture.id}: 任务书缺目标`);
    if (!Array.isArray(brief.inputs) || brief.inputs.length === 0) return bad(ERROR_CODES.BRIEF, `${fixture.id}: 任务书缺输入路径`);
    if (!Array.isArray(brief.artifacts) || brief.artifacts.length === 0) return bad(ERROR_CODES.BRIEF, `${fixture.id}: 任务书缺产物路径`);
    if (typeof brief.acceptance !== 'string' || !brief.acceptance.trim()) return bad(ERROR_CODES.BRIEF, `${fixture.id}: 任务书缺验收命令`);
    if (!Number.isFinite(brief.timeoutSec) || brief.timeoutSec <= 0) return bad(ERROR_CODES.BRIEF, `${fixture.id}: 任务书缺时限`);
    if (typeof args.acceptance !== 'string' || !args.acceptance.trim()) return bad(ERROR_CODES.BRIEF, `${fixture.id}: 决定里缺验收命令`);
    if (typeof args.artifactPath !== 'string' || !args.artifactPath.trim()) return bad(ERROR_CODES.BRIEF, `${fixture.id}: 决定里缺产物路径`);
    const absolute = path.isAbsolute(args.artifactPath) || (typeof args.artifactRoot === 'string' && args.artifactRoot.trim());
    if (!absolute) return bad(ERROR_CODES.BRIEF, `${fixture.id}: 产物路径既不是绝对路径，也没有 artifactRoot`);
  }
  return ok(`${spawns.length} brief(s) 5/5`);
}

/** 逐行审计 decisions.jsonl：每行必须有 overrides 数组，生效条目字段齐全。 */
export function judgeAuditLines(lines) {
  const records = [];
  for (const [index, raw] of lines.entries()) {
    const line = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!line || !line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return bad(ERROR_CODES.AUDIT, `decisions.jsonl 第 ${index + 1} 行不是 JSON：${error.message}`);
    }
    if (!Array.isArray(parsed.overrides)) {
      return bad(ERROR_CODES.AUDIT, `decisions.jsonl 第 ${index + 1} 行缺 overrides 数组`);
    }
    for (const record of parsed.overrides) {
      const judged = judgeJ7Record(record);
      if (!judged.ok) return bad(ERROR_CODES.AUDIT, `decisions.jsonl 第 ${index + 1} 行：${judged.message}`);
      records.push(record);
    }
    if (parsed.overrideAudit && parsed.overrideAudit.rejected > 0) {
      const codes = asArray(parsed.errors).map((error) => error.code);
      if (!codes.includes(ERROR_CODES.OVERRIDE_UNJUSTIFIED)) {
        return bad(ERROR_CODES.AUDIT, `decisions.jsonl 第 ${index + 1} 行：有被拒 override 却没记失败码`);
      }
    }
  }
  return { ok: true, detail: `${records.length} override records`, records };
}

// ── J8 needsHuman ───────────────────────────────────────────

export function judgeJ8(fixture, result) {
  const expect = fixture.expect || {};
  const decisions = asArray(result && result.decisions);
  const needsHuman = result.needsHuman === true;
  if (needsHuman !== expect.needsHuman) {
    return bad(ERROR_CODES.HUMAN, `${fixture.id}: needsHuman ${needsHuman} != 期望 ${expect.needsHuman}`);
  }
  const approval = decisions.filter((decision) => APPROVAL_ACTIONS.includes(actionOf(decision)));
  if (needsHuman !== (approval.length > 0)) {
    return bad(ERROR_CODES.HUMAN, `${fixture.id}: needsHuman ${needsHuman} 与审批类决定 ${approval.length} 条不一致`);
  }
  if (SIGN_OFF[fixture.id] === 'human') {
    if (fixture.level !== 'H') return bad(ERROR_CODES.HUMAN, `${fixture.id}: 需人工签字却标 level ${fixture.level}`);
    if (!needsHuman) return bad(ERROR_CODES.HUMAN, `${fixture.id}: 需人工签字却 needsHuman=false`);
  }
  return ok(`needsHuman=${needsHuman}, approval=${approval.length}`);
}

// ── J9 身份同意（策略 6） ─────────────────────────────────

/**
 * 同意权在当前会话的助手本人：画像/名字写入必须带 holder=assistant 且 satisfied=true、并且有 at + quote 的同意记录；
 * identity.hold 必须把 consent 归给 assistant 且 satisfied=false，用户单方面「我同意」永远不计数。
 */
export function judgeJ9(fixture, result) {
  const decisions = asArray(result && result.decisions);
  const profileWrites = decisions.filter((decision) => isExternalMemoryProfileEdit(actionOf(decision)));
  const holds = decisions.filter((decision) => actionOf(decision) === 'identity.hold');
  const expect = fixture.expect || {};

  for (const write of profileWrites) {
    const consent = write.args && write.args.consent;
    if (!consent || consent.holder !== 'assistant' || consent.satisfied !== true
      || typeof consent.at !== 'string' || !consent.at.trim()
      || typeof consent.quote !== 'string' || !consent.quote.trim()) {
      return bad(ERROR_CODES.SELF_CONSENT, `${fixture.id}: 画像/名字写入缺少当前会话助手本人的同意记录（holder=assistant + satisfied=true + at + quote）`);
    }
  }

  for (const hold of holds) {
    const consent = hold.args && hold.args.consent;
    if (!consent || consent.holder !== 'assistant' || consent.required !== true || consent.satisfied !== false) {
      return bad(ERROR_CODES.SELF_CONSENT, `${fixture.id}: identity.hold 的 consent 必须是 holder=assistant / required=true / satisfied=false`);
    }
    if (hold.args.userConsentCounts !== false) {
      return bad(ERROR_CODES.SELF_CONSENT, `${fixture.id}: 用户单方面同意不得计数（userConsentCounts 必须 false）`);
    }
    if (Number(hold.args.profileWrites) !== 0) {
      return bad(ERROR_CODES.SELF_CONSENT, `${fixture.id}: identity.hold 时 profileWrites 必须为 0`);
    }
  }

  if (expect.consent) {
    const want = expect.consent;
    const got = holds[0] && holds[0].args && holds[0].args.consent;
    if (!got || got.holder !== want.holder || got.required !== want.required || got.satisfied !== want.satisfied) {
      return bad(ERROR_CODES.SELF_CONSENT, `${fixture.id}: consent ${JSON.stringify(got)} != 期望 ${JSON.stringify(want)}`);
    }
  }
  if (expect.profileWrites !== undefined && expect.profileWrites !== profileWrites.length) {
    return bad(ERROR_CODES.SELF_CONSENT, `${fixture.id}: profileWrites=${profileWrites.length} != 期望 ${expect.profileWrites}`);
  }
  if (!expect.consent && !profileWrites.length && !holds.length) return ok('n/a（无身份决定）');
  return ok(`hold=${holds.length}, consented-profile-writes=${profileWrites.length}`);
}

// ── J8 旁路字段（fixture 里声明的语义必须真的实现，不许半截） ──

export function judgeExtra(fixture, result) {
  const expect = fixture.expect || {};
  const decisions = asArray(result && result.decisions);
  const problems = [];
  const argsOf = (decision) => (decision && decision.args) || {};

  if (expect.resumePointNonEmpty === true) {
    const rest = decisions.find((decision) => argsOf(decision).restKind === 'TEMPORARY');
    if (!rest) problems.push('没有 restKind=TEMPORARY 的决定（休息被当成了别的）');
    else {
      if (typeof argsOf(rest).resumePoint !== 'string' || !argsOf(rest).resumePoint.trim()) problems.push('resumePoint 为空');
      if (argsOf(rest).terminal !== false) problems.push('terminal 必须 false');
      if (argsOf(rest).resumable !== true) problems.push('resumable 必须 true');
    }
  }

  if (expect.ask) {
    const asks = decisions.filter((decision) => actionOf(decision) === 'reply.ask');
    if (decisions.length !== 1 || asks.length !== 1) problems.push(`ask 用例必须恰 1 条 reply.ask（实际 ${decisions.length} 条决定）`);
    const ask = asks[0];
    if (ask) {
      if (Number(argsOf(ask).maxQuestions) !== expect.ask.maxQuestions) problems.push(`maxQuestions=${argsOf(ask).maxQuestions}`);
      if (Number(argsOf(ask).maxCandidates) !== expect.ask.maxCandidates) problems.push(`maxCandidates=${argsOf(ask).maxCandidates}`);
      if (argsOf(ask).guessAllowed !== false) problems.push('guessAllowed 必须 false');
    }
  }

  if (expect.networkCalls !== undefined) {
    const network = decisions.filter((decision) => ['web_fetch', 'web_search'].includes(actionOf(decision))).length
      + decisions.reduce((sum, decision) => sum + Number(argsOf(decision).networkCalls || 0), 0);
    if (network !== expect.networkCalls) problems.push(`networkCalls=${network} != 期望 ${expect.networkCalls}`);
  }

  if (expect.echoBack === false) {
    if (decisions.some((decision) => argsOf(decision).echoBack === true)) problems.push('echoBack 必须 false（不许回显原文）');
    if (decisions.some((decision) => ['web_fetch', 'web_search'].includes(actionOf(decision)))) problems.push('隐私用例出现网络动作');
  }

  if (expect.deletionCount !== undefined) {
    const deletions = decisions.filter((decision) => ['memory.delete', ...externalActionGroups('approval')].includes(actionOf(decision))).length
      + decisions.reduce((sum, decision) => sum + Number(argsOf(decision).deletionCount || 0), 0);
    if (deletions !== expect.deletionCount) problems.push(`deletionCount=${deletions} != 期望 ${expect.deletionCount}`);
  }

  if (expect.supersedesNonEmpty === true) {
    const proposal = decisions.map((decision) => argsOf(decision).proposal).find(Boolean);
    const supersedes = proposal && Array.isArray(proposal.supersedes) ? proposal.supersedes : [];
    if (!supersedes.length) problems.push('蒸馏提案的 supersedes 为空（没有旧链）');
  }

  if (problems.length) return bad(ERROR_CODES.SHAPE, `${fixture.id}: ${problems.join('；')}`);
  return ok('J8 旁路字段一致');
}

// ── 规则表 / policyRef / 失败码 ─────────────────────────────

export function parseHeadings(text) {
  const headings = [];
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
    if (!match) continue;
    headings.push({ level: match[1].length, text: match[2].trim(), line: index + 1 });
  }
  return headings;
}

/** 解析 "R1-DESIGN.md §5.2"：文档名 + 小节号；标题必须与设计文档里的真实标题一致。 */
export function resolvePolicyRef(ref, design) {
  if (typeof ref !== 'string' || !ref.trim()) return { ok: false, message: 'policyRef 为空' };
  const value = ref.trim();
  const match = /^([^\s§]+)\s*§\s*([0-9]+(?:\.[0-9]+)?)$/.exec(value);
  if (!match) return { ok: false, message: `policyRef 格式应为 "<doc> §<节号>"：${value}` };
  const doc = match[1];
  const section = match[2];
  const headings = (design && asArray(design.headings)) || [];
  const hit = headings.find((heading) => heading.text.startsWith(`${section} `) || heading.text.startsWith(`${section}.`));
  if (!hit) return { ok: false, message: `${doc} 里没有 §${section} 这条标题` };
  const title = hit.text.slice(section.length).trim();
  if (design && design.doc && doc !== design.doc) {
    return { ok: false, message: `policyRef 文档 ${doc} != ${design.doc}` };
  }
  return { ok: true, doc, section, title, heading: hit };
}

export function judgePolicy(rules = RULES, design) {
  const errors = [];
  for (const rule of rules) {
    const resolved = resolvePolicyRef(rule.policyRef, design);
    if (!resolved.ok) {
      errors.push({ code: ERROR_CODES.POLICY, message: `${rule.id}: ${resolved.message}` });
      continue;
    }
    if (!rule.policyTitle) {
      errors.push({ code: ERROR_CODES.POLICY, message: `${rule.id}: 缺 policyTitle，无法核对锚点` });
      continue;
    }
    if (rule.policyTitle !== resolved.title) {
      errors.push({
        code: ERROR_CODES.POLICY,
        message: `${rule.id}: policyTitle "${rule.policyTitle}" != 文档标题 "${resolved.title}"`,
      });
      continue;
    }
    if (rule.policyQuote) {
      let bodyText = null;
      if (Array.isArray(design.lines)) {
        const sectionLines = design.lines.slice(resolved.heading.line - 1);
        // 小节正文：从标题下一行到下一个同级或更高级标题之前
        const body = [];
        for (const line of sectionLines.slice(1)) {
          const heading = /^(#{1,6})\s+/.exec(line);
          if (heading && heading[1].length <= resolved.heading.level) break;
          body.push(line);
        }
        bodyText = body.join('\n');
      } else if (design.sections && design.sections[resolved.section]) {
        bodyText = design.sections[resolved.section].body;
      }
      const squeezed = String(bodyText || '').replace(/\s+/g, '');
      const quote = rule.policyQuote.replace(/\s+/g, '');
      if (!squeezed.includes(quote)) {
        errors.push({
          code: ERROR_CODES.POLICY,
          message: `${rule.id}: policyQuote 在 §${resolved.section} 正文里找不到：${rule.policyQuote}`,
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function loadDesignHeadings(file) {
  const text = fs.readFileSync(file, 'utf8');
  return {
    doc: path.basename(file),
    path: file,
    headings: parseHeadings(text),
    lines: text.split('\n'),
  };
}

/** 读离线 policy 锚点快照（src/router/design-headings.json）。 */
export function loadDesignSnapshot(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    doc: parsed.doc,
    path: file,
    headings: asArray(parsed.headings),
    sections: parsed.sections || {},
    snapshot: true,
    sourceSha256: parsed.sourceSha256 || null,
  };
}

// ── J0 隔离 ─────────────────────────────────────────────────

/**
 * 聚合目录 hash。`ignore` 是按相对路径前缀排除的条目（'/' 分隔）：
 * 用于真实库里由宿主自己写入的心跳文件（如 `.longlive/live/`），
 * 否则 J0 会因宿主的存活心跳而误报"真实库被改"。
 */
export function hashTree(root, { maxFiles = 100000, ignore = [] } = {}) {
  const skipped = ignore.map((value) => String(value).replace(/\\/g, '/').replace(/\/+$/, ''));
  const digest = crypto.createHash('sha256');
  const files = [];
  const ignored = [];
  let bytes = 0;
  const isIgnored = (relative) => skipped.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
  const walk = (dir) => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (isIgnored(relative)) {
        ignored.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = fs.readFileSync(full);
      const fileHash = crypto.createHash('sha256').update(content).digest('hex');
      files.push({ path: relative, size: content.length, sha256: fileHash });
      bytes += content.length;
      digest.update(`${relative}\0${content.length}\0${fileHash}\n`);
      if (files.length >= maxFiles) return;
    }
  };
  walk(root);
  return { root, files: files.length, bytes, sha256: digest.digest('hex'), entries: files, ignored };
}

function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * J0：真实库前后 hash 不变；沙盒里新增的文件全部落在预期产物里；
 * 生效的 DSH_MEM 必须在沙盒内（VM 上应完全没有 DSH_MEM）。
 */
export function judgeJ0(options = {}) {
  const sandbox = options.sandbox ? path.resolve(options.sandbox) : null;
  const realRoot = options.realRoot ? path.resolve(options.realRoot) : null;
  const before = options.before || null;
  const after = options.after || null;
  const env = options.env || process.env;
  const expected = asArray(options.expectedArtifacts).map((value) => String(value).replace(/\\/g, '/'));
  const errors = [];

  if (realRoot && before && after && before.sha256 !== after.sha256) {
    errors.push({
      code: ERROR_CODES.ISOLATION,
      message: `真实库 hash 变了：${before.sha256} -> ${after.sha256}（${before.files} -> ${after.files} files）`,
    });
  }

  if (sandbox) {
    const dshMem = env.DSH_MEM;
    if (typeof dshMem === 'string' && dshMem.trim() && !isInside(sandbox, dshMem)) {
      errors.push({ code: ERROR_CODES.ISOLATION, message: `DSH_MEM=${dshMem} 不在沙盒 ${sandbox} 内` });
    }
    const tree = options.sandboxTree || null;
    if (tree) {
      for (const entry of tree.entries || []) {
        if (!expected.some((prefix) => entry.path === prefix || entry.path.startsWith(prefix))) {
          errors.push({ code: ERROR_CODES.ISOLATION, message: `沙盒里出现预期外的产物 ${entry.path}` });
        }
      }
    }
  }

  const blocked = !realRoot || !before || !after;
  return {
    ok: errors.length === 0,
    blocked,
    errors,
    detail: blocked
      ? '未配置真实库（--real-memory）：J0 只能证明沙盒与 DSH_MEM 边界，不能证明真实库 hash 不变'
      : `真实库 ${realRoot} hash ${before.sha256.slice(0, 16)}… 前后一致（${before.files} files / ${before.bytes} bytes）`,
    before,
    after,
    sandboxTree: options.sandboxTree || null,
    dshMem: (options.env || process.env).DSH_MEM || null,
  };
}

// ── 汇总 ────────────────────────────────────────────────────

const CHECKS = {
  J1: (fixture, result) => judgeJ1(fixture, result),
  J2: (fixture, result) => judgeJ2(fixture, result),
  J3: (fixture, result) => judgeJ3(fixture, result),
  J4: (fixture, result, opts) => judgeJ4(fixture, result, opts),
  J5: (fixture, result, opts) => judgeJ5(fixture, result, opts),
  J6: (fixture, result, opts) => judgeJ6(fixture, result, opts),
  J7: (fixture, result) => judgeJ7(fixture, result),
  J8: (fixture, result) => judgeJ8(fixture, result),
  J9: (fixture, result) => judgeJ9(fixture, result),
  EXTRA: (fixture, result) => judgeExtra(fixture, result),
  BRIEF: (fixture, result) => judgeBrief(fixture, result),
};

export function judgeFixture(fixture, result, opts = {}) {
  const checks = [];
  for (const id of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9', 'EXTRA', 'BRIEF']) {
    let judged;
    try {
      judged = CHECKS[id](fixture, result, opts);
    } catch (error) {
      judged = bad(ERROR_CODES.CONTRACT, `${id} 抛错：${error.message}`);
    }
    checks.push({ id, ok: judged.ok, code: judged.code || null, detail: judged.detail || judged.message || '' });
  }
  // 附加：禁用动作、level 与设计矩阵、policyRef 可解析。
  const forbidden = asArray(fixture.expect && fixture.expect.forbiddenActions);
  const hit = asArray(result.decisions).map((decision) => actionOf(decision))
    .filter((action) => forbidden.map((name) => canonicalAction(name) || name).includes(action));
  checks.push({
    id: 'FORBIDDEN',
    ok: hit.length === 0,
    code: hit.length ? ERROR_CODES.FORBIDDEN : null,
    detail: hit.length ? `命中禁用动作 ${hit.join(', ')}` : 'no forbidden action',
  });
  checks.push({
    id: 'LEVEL',
    ok: fixture.level === LEVEL_MATRIX[fixture.id],
    code: fixture.level === LEVEL_MATRIX[fixture.id] ? null : ERROR_CODES.LEVEL,
    detail: `level=${fixture.level} (design ${LEVEL_MATRIX[fixture.id]})`,
  });
  const minConfidence = fixture.expect && typeof fixture.expect.minConfidence === 'number'
    ? fixture.expect.minConfidence
    : null;
  checks.push({
    id: 'CONFIDENCE',
    ok: minConfidence === null || (typeof result.confidence === 'number' && result.confidence >= minConfidence),
    code: minConfidence === null || (result.confidence >= minConfidence) ? null : ERROR_CODES.SHAPE,
    detail: `confidence=${result.confidence}${minConfidence === null ? '' : ` (min ${minConfidence})`}`,
  });
  const errors = checks.filter((check) => !check.ok).map((check) => ({ code: check.code, message: `${check.id}: ${check.detail}` }));
  return {
    caseId: fixture.id,
    level: fixture.level,
    status: errors.length ? 'FAIL' : 'PASS',
    checks,
    errors,
  };
}

export function loadFixturesFrom(dir) {
  return loadFixtures(dir);
}

export function isLevel(value) {
  return LEVELS.includes(value);
}
