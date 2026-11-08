#!/usr/bin/env node
/**
 * R1 影子模式（shadow mode）—— 只记录，不执行。
 *
 * 定位：R1 的 route() 是一层纯决策函数，本身不执行任何工具。但在把 R1 接到
 * 真实执行链路之前，不能仅凭 route() 的输出就放行——故障注入实验（见
 * test/router-faults.mjs）已经证明：规则表被删/损坏、action 写错、override
 * 指错规则、决策数爆炸等情况下，route() 会静默返回空结果或错误的可执行决定。
 *
 * 所以本文件做三件事，且只做三件事：
 *   1. 调 route() 拿判定；
 *   2. 用 guard() 独立复核这份判定（fail-closed：任何可疑一律 needsHuman）；
 *   3. 把「输入 + 判定 + 复核结果」追加到 decisions-<date>.jsonl。
 *
 * 硬约束（代码结构保证，不是开关）：
 *   - 没有 exec/spawn/child_process/http/fetch 任何引用；
 *   - 唯一的写操作 appendJsonl()，目标被限制在 outDir 之内；
 *   - 不读外部记忆库 / profile / <memory-root>，ctx 只来自调用方注入。
 *
 * 用法见 SHADOW-RUN.md；`node src/router/shadow.mjs --help`。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pluginEvidencePrefixes } from '../adapters/registry.js';
import { fileURLToPath } from 'node:url';

import { RULES, route } from './route.js';
import { loadFixtures, fixtureInput } from './judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = process.env.R1_SHADOW_DIR || path.join(process.cwd(), 'shadow-out');
const SHADOW_MODE = 'dry'; // 只有一种模式：记录。没有 execute 分支。
const MAX_DECISIONS = 8;
const MIN_RULES = 14;
const BENIGN_TOOL_ACTIONS = new Set(['acp_status', 'guard.dryRun']);

export const SHADOW_CODES = Object.freeze({
  TABLE: 'E_SHADOW_TABLE',
  UNMATCHED: 'E_SHADOW_UNMATCHED',
  SCOPE: 'E_SHADOW_SCOPE',
  EXPLOSION: 'E_SHADOW_EXPLOSION',
  AMBIGUOUS: 'E_SHADOW_AMBIGUOUS',
  CTX: 'E_SHADOW_CTX',
  OVERRIDE: 'E_SHADOW_OVERRIDE',
  ACTION: 'E_SHADOW_ACTION',
  RECORD: 'E_SHADOW_RECORD',
});

export { SHADOW_MODE, MAX_DECISIONS, MIN_RULES };

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function textOr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function shaLike(value) {
  // 轻量稳定哈希：只用于采样与去重，不做安全用途。
  let h = 2166136261;
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function err(code, message, extra = {}) {
  return { code, message, ...extra };
}

function isInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// 1. 规则表体检：表坏了，任何判定都不可信 → 直接拒绝
// ---------------------------------------------------------------------------

export function checkTable(rules = RULES) {
  const errors = [];
  if (!Array.isArray(rules)) {
    return { ok: false, errors: [err(SHADOW_CODES.TABLE, '规则表不是数组：无法判定，拒绝')] };
  }
  if (rules.length < MIN_RULES) {
    errors.push(err(SHADOW_CODES.TABLE, `规则表只有 ${rules.length} 条（< ${MIN_RULES}）：疑似文件缺失/损坏，拒绝`, {
      count: rules.length,
    }));
  }
  const seen = new Set();
  let lastPriority = Number.POSITIVE_INFINITY;
  for (const rule of rules) {
    if (!rule || !textOr(rule.id)) {
      errors.push(err(SHADOW_CODES.TABLE, '存在无 id 的规则：拒绝'));
      continue;
    }
    if (seen.has(rule.id)) errors.push(err(SHADOW_CODES.TABLE, `规则 id 重复：${rule.id}`, { ruleId: rule.id }));
    seen.add(rule.id);
    if (!Number.isFinite(rule.priority)) {
      errors.push(err(SHADOW_CODES.TABLE, `规则 ${rule.id} priority 非法`, { ruleId: rule.id }));
    } else if (rule.priority > lastPriority) {
      errors.push(err(SHADOW_CODES.TABLE, `规则 ${rule.id} 优先级未降序（表可能被改坏）`, { ruleId: rule.id }));
    } else {
      lastPriority = rule.priority;
    }
    if (!rule.decision || !textOr(rule.decision.action)) {
      errors.push(err(SHADOW_CODES.TABLE, `规则 ${rule.id} 无 decision.action`, { ruleId: rule.id }));
    }
    if (!textOr(rule.reason)) {
      errors.push(err(SHADOW_CODES.TABLE, `规则 ${rule.id} 无 reason（审计要求）`, { ruleId: rule.id }));
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 2. 歧义与 ctx 缺失：route() 只看第一条命中的规则，影子层要看见全部竞争者
// ---------------------------------------------------------------------------

function readCandidates(input) {
  if (!input || typeof input !== 'object') return [];
  const raw = input.candidates;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
    .filter(Boolean);
}

function readContext(input) {
  const src = input && typeof input === 'object' && input.ctx && typeof input.ctx === 'object' ? input.ctx : {};
  const out = { raw: src };
  if (typeof src.tokens === 'number' && Number.isFinite(src.tokens)) out.tokens = src.tokens;
  if (typeof src.activeWorkers === 'number' && Number.isFinite(src.activeWorkers)) out.activeWorkers = src.activeWorkers;
  if (typeof src.openRows === 'number' && Number.isFinite(src.openRows)) out.openRows = src.openRows;
  if (typeof src.zone === 'string' && src.zone.trim()) out.zone = src.zone.trim().toLowerCase();
  return out;
}

function evaluateCtxStrict(matcher, ctx) {
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

function ctxFieldPresent(matcher, ctx) {
  // 只看「字段在不在、类型对不对」，不看阈值——用来区分「条件不满足」和「ctx 没给」。
  const missing = [];
  if (!matcher) return missing;
  if (typeof matcher.tokensGte === 'number' && typeof ctx.tokens !== 'number') missing.push('tokens');
  if (typeof matcher.activeWorkersGte === 'number' && typeof ctx.activeWorkers !== 'number') {
    missing.push('activeWorkers');
  }
  if (typeof matcher.openRowsGte === 'number' && typeof ctx.openRows !== 'number') missing.push('openRows');
  if (Array.isArray(matcher.zoneIn) && typeof ctx.zone !== 'string') missing.push('zone');
  return missing;
}

export function competingRules(input, rules = RULES) {
  const text = textOr(input && (input.utterance ?? input.text)).toLowerCase();
  const kind = textOr(input && input.kind).toLowerCase();
  const candidates = readCandidates(input);
  const ctx = readContext(input);
  const hitsList = [];
  for (const rule of rules) {
    if (kind && rule.kind !== '*' && rule.kind !== kind) continue;
    const hits = (rule.keywordKeys || []).filter((k) => k && text.includes(k));
    const toolHit = Boolean(rule.matchToolKey && candidates.includes(rule.matchToolKey));
    const ctxOk = evaluateCtxStrict(rule.matchCtx, ctx);
    const missingCtx = rule.matchCtx ? ctxFieldPresent(rule.matchCtx, ctx) : [];
    let matched = false;
    if (rule.ctxOnly) matched = ctxOk === true;
    else if (hits.length || toolHit) matched = ctxOk !== false;
    if (!matched) continue;
    hitsList.push({
      ruleId: rule.id,
      priority: rule.priority,
      action: rule.decision.action,
      kind: rule.decision.kind,
      hits: hits.length,
      toolHit,
      ctxMissing: missingCtx,
    });
  }
  return hitsList;
}

// 关键词命中但 ctx 字段缺/类型错：这类规则被 route() 静默跳过，必须让人看见。
export function ctxWarnings(input, hits, rules = RULES) {
  const warnings = [];
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const ctx = readContext(input);
  for (const rule of rules) {
    if (!rule.matchCtx) continue;
    const text = textOr(input && (input.utterance ?? input.text)).toLowerCase();
    const kind = textOr(input && input.kind).toLowerCase();
    if (kind && rule.kind !== '*' && rule.kind !== kind) continue;
    const hitsCount = (rule.keywordKeys || []).filter((k) => k && text.includes(k)).length;
    if (hitsCount === 0) continue;
    const missing = ctxFieldPresent(rule.matchCtx, ctx);
    if (missing.length === 0) continue;
    if (!byId.has(rule.id)) continue;
    warnings.push({
      ruleId: rule.id,
      missing,
      message: `规则 ${rule.id} 关键词命中，但 ctx.${missing.join('/')} 缺失或类型不对，route() 会静默跳过它`,
      actual: Object.fromEntries(missing.map((field) => [field, ctx.raw ? ctx.raw[field] ?? null : null])),
      hits: hitsCount,
    });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// 3. guard：对 route() 的判定做独立复核（fail-closed）
// ---------------------------------------------------------------------------

export function classifyDecision(decision) {
  const kind = textOr(decision && decision.kind);
  const action = textOr(decision && decision.action);
  if (kind === 'memory' || kind === 'session') return 'side-effect';
  if (kind === 'tool') return BENIGN_TOOL_ACTIONS.has(action) ? 'read-only' : 'side-effect';
  if (kind === 'reply') return 'no-write';
  return 'unknown';
}

export function guard(input, result, { rules = RULES, maxDecisions = MAX_DECISIONS } = {}) {
  const errors = [];
  const warnings = [];
  const table = checkTable(rules);
  errors.push(...table.errors);

  const decisions = Array.isArray(result && result.decisions) ? result.decisions : [];
  const hits = competingRules(input, rules);
  const ctxMissing = ctxWarnings(input, hits, rules);

  if (decisions.length === 0) {
    errors.push(
      err(SHADOW_CODES.UNMATCHED, '没有任何规则命中（空判定）：不允许默认执行，交人判断', {
        competing: hits.map((hit) => hit.ruleId),
      }),
    );
  }
  if (decisions.length > maxDecisions) {
    errors.push(
      err(SHADOW_CODES.EXPLOSION, `决策数 ${decisions.length} 超过上限 ${maxDecisions}：疑似规则表被污染，拒绝`, {
        count: decisions.length,
        limit: maxDecisions,
      }),
    );
  }

  // 歧义：>=2 条规则同时命中，且最高两条同优先级 → 谁是赢家只由文件顺序决定。
  if (hits.length > 1) {
    const sorted = [...hits].sort((a, b) => b.priority - a.priority || 0);
    const tie = sorted.filter((hit) => hit.priority === sorted[0].priority);
    if (tie.length > 1) {
      const actions = new Set(tie.map((hit) => `${hit.kind}:${hit.action}`));
      errors.push(
        err(SHADOW_CODES.AMBIGUOUS, `同优先级规则同时命中 ${tie.length} 条：${tie.map((h) => h.ruleId).join(', ')}`, {
          rules: tie.map((hit) => hit.ruleId),
          distinctActions: actions.size,
        }),
      );
    } else if (hits.length > 1) {
      warnings.push({
        code: SHADOW_CODES.AMBIGUOUS,
        message: `${hits.length} 条规则同时命中，route() 按优先级只取最高的一条：${sorted[0].ruleId}`,
        rules: hits.map((hit) => hit.ruleId),
        distinctActions: new Set(hits.map((hit) => `${hit.kind}:${hit.action}`)).size,
      });
    }
  }

  for (const warning of ctxMissing) {
    errors.push(err(SHADOW_CODES.CTX, warning.message, { ruleId: warning.ruleId, missing: warning.missing }));
  }

  for (const decision of decisions) {
    const action = textOr(decision.action);
    if (!action) {
      errors.push(err(SHADOW_CODES.ACTION, '决策缺少 action：拒绝', { ruleId: decision.ruleId || null }));
    }
    for (const scope of Array.isArray(decision.writeScope) ? decision.writeScope : []) {
      if (!validWriteScope(scope)) {
        errors.push(
          err(SHADOW_CODES.SCOPE, `writeScope 越界：${scope}`, { ruleId: decision.ruleId || null, scope }),
        );
      }
    }
  }

  // override：route() 找不到 ruleId 时会静默改第一条决策——影子层必须点名。
  const applied = result && result.overrideAudit ? result.overrideAudit.applied : 0;
  if (applied > 0) {
    const ruleIds = new Set(rules.map((rule) => rule.id));
    for (const record of (result.overrides || [])) {
      const target = textOr(record && record.ruleId);
      if (!ruleIds.has(target)) {
        errors.push(err(SHADOW_CODES.OVERRIDE, `override 指向不存在的规则 ${target}：route() 会改到第一条决策上`, {
          ruleId: target,
        }));
      }
    }
  }

  // route() 自己报的错一律升级为拒绝。
  for (const error of (result && result.errors) || []) {
    errors.push(err(textOr(error.code) || SHADOW_CODES.RECORD, textOr(error.message) || 'route() 报错', {
      ruleId: error.ruleId || null,
      source: 'route',
    }));
  }

  const sideEffects = decisions.filter((decision) => classifyDecision(decision) === 'side-effect');
  const needsHuman = Boolean(result && result.needsHuman) || errors.length > 0;
  return {
    ok: errors.length === 0,
    mode: SHADOW_MODE,
    needsHuman,
    errors,
    warnings,
    competing: hits,
    ctxMissing,
    counts: {
      decisions: decisions.length,
      sideEffects: sideEffects.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    // 影子层的最终动作：永远不是「执行」。
    action: errors.length > 0 ? 'refuse' : 'record-only',
  };
}

// writeScope 判定与 judge.mjs 的 validateWriteScope 同一套口径（此处不 import judge，
// 避免影子层把 judge 的耦合带进来；两边一致性由 test/router-shadow.test.mjs 对齐断言）。
export function validWriteScope(scope) {
  const value = textOr(scope);
  if (!value) return true; // 空 = 不写
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (value.includes('..')) return false;
  if (value.includes('~')) return false;
  const prefixes = ['memory/', ...pluginEvidencePrefixes(), 'taskboard:', 'sandbox:', 'evidence:', 'fixtures:'];
  return prefixes.some((prefix) => value.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// 4. 采样（稳定哈希：同一 seed + caseId 永远同组，双跑可复现）
// ---------------------------------------------------------------------------

export function sampleHit(key, { rate = 1, seed = 'r1-shadow' } = {}) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r >= 1) return true;
  if (r <= 0) return false;
  const bucket = parseInt(shaLike(`${seed}:${key}`).slice(0, 4), 16) / 0xffff;
  return bucket < r;
}

// ---------------------------------------------------------------------------
// 5. 单条分析 + 记录
// ---------------------------------------------------------------------------

export function analyze(input, { rules = RULES, routeImpl = route } = {}) {
  const result = routeImpl(input);
  const verdict = guard(input, result, { rules });
  return {
    caseId: (result && result.caseId) || (input && input.caseId) || null,
    turn: (result && result.turn) ?? (input && input.turn) ?? null,
    input: {
      utterance: textOr(input && (input.utterance ?? input.text)),
      kind: textOr(input && input.kind) || null,
      candidates: readCandidates(input),
      ctx: readContext(input).raw || {},
    },
    decision: {
      matchedRule: result.matchedRule,
      matchedRules: result.matchedRules,
      target: result.target,
      confidence: result.confidence,
      needsHuman: result.needsHuman,
      decisions: (result.decisions || []).map((decision) => ({
        kind: decision.kind,
        action: decision.action,
        ruleId: decision.ruleId,
        writeScope: decision.writeScope,
        needsHuman: decision.needsHuman === true,
        confidence: decision.confidence,
      })),
      errors: (result.errors || []).map((error) => ({ code: error.code, message: error.message })),
      overrideAudit: result.overrideAudit,
    },
    guard: verdict,
  };
}

export function toRecord(analysis, { at = new Date().toISOString() } = {}) {
  return {
    ts: at,
    mode: SHADOW_MODE,
    caseId: analysis.caseId,
    turn: analysis.turn,
    input: analysis.input,
    decision: analysis.decision,
    guard: {
      ok: analysis.guard.ok,
      needsHuman: analysis.guard.needsHuman,
      action: analysis.guard.action,
      errors: analysis.guard.errors,
      warnings: analysis.guard.warnings,
      competing: analysis.guard.competing,
      counts: analysis.guard.counts,
    },
    human: { verdict: null, note: '' },
  };
}

// ---------------------------------------------------------------------------
// 6. 指标
// ---------------------------------------------------------------------------

function rate(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10; // 百分比，一位小数
}

export function computeMetrics(records) {
  const list = Array.isArray(records) ? records : [];
  const total = list.length;
  const by = { needsHuman: 0, guardReject: 0, ambiguous: 0, ctxMissing: 0, unmatched: 0, scope: 0, override: 0, explosion: 0 };
  const byRule = {};
  const byAction = {};
  const decisionCounts = [];
  let confidenceSum = 0;
  let confidenceN = 0;
  for (const record of list) {
    const guardErrors = (record.guard && record.guard.errors) || [];
    if (record.guard && record.guard.needsHuman) by.needsHuman += 1;
    if (record.guard && record.guard.action === 'refuse') by.guardReject += 1;
    if (guardErrors.some((error) => error.code === SHADOW_CODES.AMBIGUOUS)) by.ambiguous += 1;
    if (guardErrors.some((error) => error.code === SHADOW_CODES.CTX)) by.ctxMissing += 1;
    if (guardErrors.some((error) => error.code === SHADOW_CODES.UNMATCHED)) by.unmatched += 1;
    if (guardErrors.some((error) => error.code === SHADOW_CODES.SCOPE)) by.scope += 1;
    if (guardErrors.some((error) => error.code === SHADOW_CODES.OVERRIDE)) by.override += 1;
    if (guardErrors.some((error) => error.code === SHADOW_CODES.EXPLOSION)) by.explosion += 1;
    const rule = (record.decision && record.decision.matchedRule) || '(none)';
    byRule[rule] = (byRule[rule] || 0) + 1;
    const decisions = (record.decision && record.decision.decisions) || [];
    decisionCounts.push(decisions.length);
    for (const decision of decisions) {
      const key = `${decision.kind}:${decision.action}`;
      byAction[key] = (byAction[key] || 0) + 1;
    }
    if (typeof record.decision?.confidence === 'number') {
      confidenceSum += record.decision.confidence;
      confidenceN += 1;
    }
  }
  const sorted = [...decisionCounts].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
  return {
    total,
    rates: {
      needsHuman: rate(by.needsHuman, total),
      guardReject: rate(by.guardReject, total),
      ambiguous: rate(by.ambiguous, total),
      ctxMissing: rate(by.ctxMissing, total),
      unmatched: rate(by.unmatched, total),
      scope: rate(by.scope, total),
      override: rate(by.override, total),
      explosion: rate(by.explosion, total),
    },
    counts: by,
    byRule,
    byAction,
    decisionsPerTurn: { p50: pct(50), p95: pct(95), max: sorted.length ? sorted[sorted.length - 1] : 0 },
    avgConfidence: confidenceN ? Math.round((confidenceSum / confidenceN) * 1000) / 1000 : null,
  };
}

export function computeMetricsFromFile(file) {
  const text = readFileSync(file, 'utf8');
  const records = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { records: records.length, metrics: computeMetrics(records) };
}

// ---------------------------------------------------------------------------
// 7. 人工判读抽样与一致性打分
// ---------------------------------------------------------------------------

function priorityScore(record) {
  let score = 0;
  const guardErrors = (record.guard && record.guard.errors) || [];
  if (guardErrors.length) score += 10;
  if (guardErrors.some((error) => error.code === SHADOW_CODES.AMBIGUOUS)) score += 5;
  if (guardErrors.some((error) => error.code === SHADOW_CODES.UNMATCHED)) score += 4;
  if (guardErrors.some((error) => error.code === SHADOW_CODES.CTX)) score += 3;
  if (record.guard && record.guard.needsHuman) score += 2;
  return score;
}

export function pickReviewSample(records, size = 20) {
  const n = Math.max(0, Number(size) || 0);
  if (!n) return [];
  const ranked = records.map((record, index) => ({ record, index, score: priorityScore(record) }));
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  // 高风险优先，剩余名额用等距抽样补足，保证覆盖到「正常」样本。
  const head = ranked.slice(0, n);
  if (head.length >= n) return head.map((entry) => entry.record);
  const rest = ranked.slice(head.length);
  const picked = [...head];
  const need = n - head.length;
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, need)));
  for (let i = 0; i < rest.length && picked.length < n; i += step) picked.push(rest[i]);
  return picked.map((entry) => entry.record);
}

export function scoreReview(records) {
  const reviewed = records.filter((record) => record.human && ['agree', 'disagree'].includes(record.human.verdict));
  const disagree = reviewed.filter((record) => record.human.verdict === 'disagree');
  return {
    reviewed: reviewed.length,
    agree: reviewed.length - disagree.length,
    disagree: disagree.length,
    disagreeRate: rate(disagree.length, reviewed.length),
    disagreements: disagree.map((record) => ({
      caseId: record.caseId,
      turn: record.turn,
      utterance: record.input && record.input.utterance,
      shadowRule: record.decision && record.decision.matchedRule,
      note: record.human.note,
    })),
  };
}

// ---------------------------------------------------------------------------
// 8. 落盘（唯一写入口，锁在 outDir 内）
// ---------------------------------------------------------------------------

export function resolveOutDir(outDir = DEFAULT_OUT) {
  return path.resolve(outDir);
}

export function decisionsPath(outDir, date) {
  return path.join(resolveOutDir(outDir), `decisions-${date}.jsonl`);
}

function assertInside(target, outDir) {
  if (!isInside(target, outDir)) {
    throw new Error(`shadow 只允许写 ${outDir}，拒绝写 ${target}`);
  }
}

export function appendRecords(records, { outDir = DEFAULT_OUT, date, at = new Date() } = {}) {
  const dir = resolveOutDir(outDir);
  const stamp = date || at.toISOString().slice(0, 10);
  const file = decisionsPath(dir, stamp);
  assertInside(file, dir);
  mkdirSync(dir, { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  if (!body) return { file, written: 0 };
  appendFileSync(file, `${body}\n`, 'utf8');
  return { file, written: records.length };
}

export function writeJsonl(file, records) {
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return file;
}

export function reviewPath(outDir, date) {
  return path.join(resolveOutDir(outDir), `review-${date}.jsonl`);
}

// ---------------------------------------------------------------------------
// 9. 批量运行
// ---------------------------------------------------------------------------

export function inputsFromFixtures(dir) {
  const { fixtures, errors } = loadFixtures(dir || path.join(HERE, 'fixtures'));
  if (errors.length) {
    return { inputs: [], errors };
  }
  return { inputs: fixtures.map((fixture) => ({ ...fixtureInput(fixture), source: `fixture:${fixture.id}` })), errors: [] };
}

export function runShadow(inputs, {
  outDir = DEFAULT_OUT,
  date,
  rate = 1,
  seed = 'r1-shadow',
  record = true,
  now = () => new Date(),
} = {}) {
  const at = now();
  const stamp = date || at.toISOString().slice(0, 10);
  const analyzed = [];
  const skipped = [];
  for (const input of inputs) {
    const key = `${input.caseId ?? ''}:${input.turn ?? ''}:${shaLike(textOr(input.utterance ?? input.text))}`;
    if (!sampleHit(key, { rate, seed })) {
      skipped.push(key);
      continue;
    }
    const analysis = analyze(input);
    analyzed.push(toRecord(analysis, { at: at.toISOString() }));
  }
  const written = record && analyzed.length
    ? appendRecords(analyzed, { outDir, date: stamp, at })
    : { file: null, written: 0 };
  return {
    date: stamp,
    total: inputs.length,
    sampled: analyzed.length,
    skipped: skipped.length,
    records: analyzed,
    metrics: computeMetrics(analyzed),
    out: written,
    mode: SHADOW_MODE,
  };
}

// ---------------------------------------------------------------------------
// 10. CLI
// ---------------------------------------------------------------------------

const HELP = `R1 影子模式（只记录，不执行）

  node src/router/shadow.mjs [选项]

  --from-fixtures        用 19 条 fixtures 跑一遍（默认）
  --input <file>         读取 .jsonl / .json 输入（每行 {caseId,turn,utterance,kind,ctx,candidates}）
  --out <dir>            记录目录（默认 ${DEFAULT_OUT}）
  --date YYYY-MM-DD      记录文件名日期（默认今天）
  --sample <0..1>        采样率（默认 1，稳定哈希，双跑一致）
  --seed <str>           采样种子（默认 r1-shadow）
  --no-record            只算指标，不写文件
  --print                逐条打印到 stdout
  --review-sample <n>    额外产出 review-<date>.jsonl（待人工判读）
  --score-review <file>  读人工判读后的 jsonl，算不一致率
  --metrics <file>       从已记录 jsonl 重算指标
  --json                 机器可读输出
  --help

  本命令没有任何执行分支：不会调工具、不会写记忆库、不会碰外部记忆库/profile。
`;

function parseArgs(argv) {
  const options = {
    fromFixtures: false,
    input: null,
    out: DEFAULT_OUT,
    date: null,
    sample: 1,
    seed: 'r1-shadow',
    record: true,
    print: false,
    reviewSample: 0,
    scoreReview: null,
    metrics: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--from-fixtures': options.fromFixtures = true; break;
      case '--input': options.input = argv[++i]; break;
      case '--out': options.out = argv[++i]; break;
      case '--date': options.date = argv[++i]; break;
      case '--sample': options.sample = Number(argv[++i]); break;
      case '--seed': options.seed = argv[++i]; break;
      case '--no-record': options.record = false; break;
      case '--print': options.print = true; break;
      case '--review-sample': options.reviewSample = Number(argv[++i]) || 0; break;
      case '--score-review': options.scoreReview = argv[++i]; break;
      case '--metrics': options.metrics = argv[++i]; break;
      case '--json': options.json = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        throw new Error(`未知参数：${arg}（影子模式没有 --execute；它不会执行任何东西）`);
    }
  }
  return options;
}

function readInputs(file) {
  const text = readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.jsonl')) {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`${file}:${index + 1} JSON 解析失败：${error.message}`);
        }
      });
  }
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.inputs) ? parsed.inputs : null;
  if (!list) throw new Error(`${file} 不是数组，也没有 inputs[]`);
  return list;
}

export function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.scoreReview) {
    const records = readInputs(options.scoreReview);
    const score = scoreReview(records);
    process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
    return 0;
  }
  if (options.metrics) {
    const result = computeMetricsFromFile(options.metrics);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  let inputs;
  if (options.input) {
    inputs = readInputs(options.input);
  } else {
    const loaded = inputsFromFixtures();
    if (loaded.errors.length) {
      process.stderr.write(`fixtures 读取失败：${JSON.stringify(loaded.errors)}\n`);
      return 1;
    }
    inputs = loaded.inputs;
  }

  const run = runShadow(inputs, {
    outDir: options.out,
    date: options.date,
    rate: options.sample,
    seed: options.seed,
    record: options.record,
  });

  if (options.reviewSample > 0) {
    const picked = pickReviewSample(run.records, options.reviewSample);
    const file = reviewPath(options.out, run.date);
    writeJsonl(file, picked);
    run.review = { file, size: picked.length };
  }

  if (options.print) {
    for (const record of run.records) {
      const guardCodes = record.guard.errors.map((error) => error.code).join(',') || '-';
      process.stdout.write(
        `${record.caseId || '-'}\t${record.decision.matchedRule || '(none)'}\t${record.guard.action}\t${guardCodes}\t${record.input.utterance.slice(0, 48)}\n`,
      );
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      mode: run.mode,
      date: run.date,
      total: run.total,
      sampled: run.sampled,
      skipped: run.skipped,
      out: run.out,
      review: run.review || null,
      metrics: run.metrics,
    }, null, 2)}\n`);
  } else {
    process.stdout.write([
      `R1 SHADOW（${run.mode}）— ${run.date}`,
      `输入 ${run.total} 条 · 采样 ${run.sampled} 条 · 跳过 ${run.skipped} 条`,
      `needsHuman ${run.metrics.rates.needsHuman}% · guard 拒绝 ${run.metrics.rates.guardReject}% · 歧义 ${run.metrics.rates.ambiguous}% · ctx 缺失 ${run.metrics.rates.ctxMissing}%`,
      run.out.file ? `记录 → ${run.out.file}（${run.out.written} 条）` : '未落盘（--no-record）',
      run.review ? `人工判读抽样 → ${run.review.file}（${run.review.size} 条）` : '',
    ].filter(Boolean).join('\n') + '\n');
  }
  return 0;
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`shadow 失败：${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
