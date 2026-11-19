// src/autoprocedure/ledger.js — 记账、计数与 stalled 告警（D6。
//
// 唯一账本：`.longlive/logs/auto-procedure.jsonl`（append-store：单写锁 + fsync）。
// 固定字段：at, day, attemptId, sessionId, turn, kind, reason?, tokens{in,out},
//           model?, candidateSlug?, generator?, dropped?
// `turns.jsonl` 永远不写（N3：运行前后字节不变）。
//
// N3 账本语义（红队 18:15 澄清）：一次尝试会写多行（sample / llm / draft|reject），
// 不要断言「总行数 = 尝试次数」。改为：
//   * 每行带 attemptId；
//   * 每个 attemptId 恰好 1 行终态（draft / reject / stale 三者之一）；
//   * sample 行数 = 尝试数；terminal 行数 = 尝试数；llm / llm_enable_ack 独立计数；
//   * 独立 stale（周期抽查报告，没有 attemptId）单独计数。
//
// 计数与告警只记状态码/计数，不记内容（C 条）。stalled 状态写到既有的
// `.longlive/memory-state.json` 的 `autoProcedure` 字段，形状：
//   { state: "stalled"|"ok", lastDraftAt, drafted7d, rejectTop }
// 连续 7 天 drafted=0 且 enabled=true 且账本已运行 ≥7 天 → stalled；
// rejectTop 里带同一原因连续出现的天数（≥3 天即可作为「需要处理的失败」上报）。

import { appendJsonLine, readJsonLines } from '../util/append-store.js';
import { dayString } from '../memory/frontmatter.js';
import { readState, updateState } from '../memory/state.js';
import { autoProcedurePaths } from './paths.js';
import { AUTOPROCEDURE_STALLED_DAYS, AUTOPROCEDURE_REPEAT_REJECT_DAYS } from './config.js';

export const LEDGER_SCHEMA = 'auto-procedure/v1';
export const LEDGER_KINDS = Object.freeze(['sample', 'draft', 'reject', 'llm', 'stale', 'llm_enable_ack']);
export const TERMINAL_KINDS = Object.freeze(['draft', 'reject', 'stale']);
export const REJECT_REASONS = Object.freeze([
  // v0.3 §3.9 枚举
  'privacy', 'evidence', 'budget', 'llm_timeout', 'llm_unavailable', 'parse', 'too_big',
  // 实现层失败原因（非内容）：不计入内容隐私面，只用于对账
  'ineligible', 'lock', 'quota', 'io',
]);
export const LLM_REASONS = Object.freeze(['output_unusable']);
/**
 * D2：这类 reject 是「配置/前置条件」而不是「需要人工处理的失败」，
 * 保留在 rejectTop 的计数里（可观测性不降），但不算进连续 ≥3 天的告警天数。
 */
export const REJECT_ATTENTION_EXCLUDED = Object.freeze(['quota', 'ineligible']);
export const LEDGER_READ_LIMIT = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateOf(now) {
  const value = typeof now === 'function' ? now() : (now ?? Date.now());
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isoOf(now) {
  return dateOf(now).toISOString();
}

function msOf(now) {
  return dateOf(now).getTime();
}

/** Build the fixed-shape ledger row (undefined optionals are omitted). */
export function makeLedgerRow({
  attemptId = null,
  sessionId = null,
  turn = null,
  kind,
  reason = null,
  tokens = null,
  model = null,
  candidateSlug = null,
  generator = null,
  dropped = null,
  now = new Date(),
}) {
  const date = dateOf(now);
  const row = {
    schema: LEDGER_SCHEMA,
    at: date.toISOString(),
    day: dayString(date),
    kind: LEDGER_KINDS.includes(kind) ? kind : 'reject',
  };
  if (attemptId !== null) row.attemptId = attemptId;
  if (sessionId !== null) row.sessionId = sessionId;
  if (Number.isInteger(turn)) row.turn = turn;
  if (reason !== null) row.reason = String(reason);
  const inTokens = Number.isInteger(tokens?.in) ? tokens.in : 0;
  const outTokens = Number.isInteger(tokens?.out) ? tokens.out : 0;
  row.tokens = { in: inTokens, out: outTokens };
  if (model !== null) row.model = String(model);
  if (candidateSlug !== null) row.candidateSlug = String(candidateSlug);
  if (generator !== null) row.generator = String(generator);
  if (dropped && typeof dropped === 'object') {
    row.dropped = {};
    for (const [key, value] of Object.entries(dropped)) {
      if (Number.isInteger(value) && value > 0) row.dropped[key] = value;
    }
  }
  return row;
}

/** Append one row to the ledger via append-store (never throws). */
export function appendLedgerRow({ memoryRoot, row, now = null, append = null }) {
  // D2：reject/llm 的 reason 必须是固定枚举，未知 reason 不得落账本（不含自由文本）。
  // stale 行的 reason 是 E_ 开头的证据错误码（抽查报告），只允许代码形状。
  const kind = row?.kind;
  const reason = row?.reason;
  if (reason !== undefined && reason !== null) {
    if (kind === 'stale') {
      if (typeof reason !== 'string' || !/^E_[A-Z0-9_]{1,64}$/.test(reason)) {
        return { ok: false, code: 'E_AP_BAD_REASON', reason: String(reason) };
      }
    } else {
      const allowed = kind === 'llm' ? [...LLM_REASONS, ...REJECT_REASONS] : REJECT_REASONS;
      if (!allowed.includes(reason)) {
        return { ok: false, code: 'E_AP_BAD_REASON', reason: String(reason) };
      }
    }
  }
  const paths = autoProcedurePaths(memoryRoot);
  const at = now == null ? new Date() : now;
  const withTime = row.at ? row : { ...row, at: isoOf(at), day: dayString(dateOf(at)) };
  if (typeof append === 'function') return append(paths.ledger, withTime);
  return appendJsonLine({
    file: paths.ledger,
    row: withTime,
    label: 'auto-procedure',
    healthRoot: paths.root,
  });
}

/** Read the ledger; bad lines are counted, never fatal. */
export function readLedgerRows(memoryRoot, { limit = LEDGER_READ_LIMIT } = {}) {
  const paths = autoProcedurePaths(memoryRoot);
  const read = readJsonLines(paths.ledger, { limit });
  return {
    ok: read.ok,
    present: read.present,
    rows: read.rows,
    badLines: read.badLines,
    file: paths.ledger,
  };
}

function dayOfRow(row) {
  return typeof row?.day === 'string' && row.day !== '' ? row.day : String(row?.at ?? '').slice(0, 10);
}

/**
 * Counters for one ledger snapshot.
 * @returns {{rows:number, sampled:number, drafts:number, terminals:number,
 *   rejects:object, staleStandalone:number, llmCalls:number, acks:number,
 *   tokensIn:number, tokensOut:number, lastDraftAt:string|null,
 *   drafted7d:number, samples7d:number, firstAt:number|null,
 *   rejectTop:{reason:string,count:number,days:number}|null,
 *   attempts:number, terminalByAttempt:Map<string,string>, duplicateTerminals:string[]}}
 */
export function summarizeLedger(rows, { now = new Date(), windowDays = AUTOPROCEDURE_STALLED_DAYS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const nowMs = msOf(now);
  const windowStart = nowMs - windowDays * DAY_MS;
  const summary = {
    rows: list.length,
    sampled: 0,
    drafts: 0,
    terminals: 0,
    terminalByAttempt: new Map(),
    duplicateTerminals: [],
    attempts: 0,
    rejects: {},
    staleStandalone: 0,
    llmCalls: 0,
    acks: 0,
    tokensIn: 0,
    tokensOut: 0,
    lastDraftAt: null,
    drafted7d: 0,
    samples7d: 0,
    firstAt: null,
    rejectTop: null,
  };
  const attempts = new Set();
  const rejectReasons = new Map();
  const rejectDays = new Map();
  let firstMs = null;

  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const kind = row.kind;
    const at = Date.parse(String(row.at ?? ''));
    if (Number.isFinite(at) && (firstMs === null || at < firstMs)) firstMs = at;
    if (Number.isInteger(row.tokens?.in)) summary.tokensIn += row.tokens.in;
    if (Number.isInteger(row.tokens?.out)) summary.tokensOut += row.tokens.out;
    const attemptId = typeof row.attemptId === 'string' && row.attemptId !== '' ? row.attemptId : null;
    if (attemptId !== null) attempts.add(attemptId);

    if (kind === 'sample') {
      summary.sampled += 1;
      if (Number.isFinite(at) && at >= windowStart) summary.samples7d += 1;
      continue;
    }
    if (kind === 'llm_enable_ack') {
      summary.acks += 1;
      continue;
    }
    if (kind === 'llm') {
      summary.llmCalls += 1;
      continue;
    }
    if (kind === 'stale' && attemptId === null) {
      summary.staleStandalone += 1;
      continue;
    }
    if (!TERMINAL_KINDS.includes(kind)) continue;
    summary.terminals += 1;
    if (attemptId !== null) {
      if (summary.terminalByAttempt.has(attemptId)) summary.duplicateTerminals.push(attemptId);
      summary.terminalByAttempt.set(attemptId, kind);
    }
    if (kind === 'draft') {
      summary.drafts += 1;
      if (Number.isFinite(at) && at >= windowStart) summary.drafted7d += 1;
      if (summary.lastDraftAt === null || String(row.at ?? '') > String(summary.lastDraftAt)) {
        summary.lastDraftAt = String(row.at ?? '');
      }
      continue;
    }
    if (kind === 'reject') {
      const reason = typeof row.reason === 'string' && row.reason !== '' ? row.reason : 'unknown';
      summary.rejects[reason] = (summary.rejects[reason] ?? 0) + 1;
      const inWindow = Number.isFinite(at) && at >= windowStart;
      if (inWindow) {
        rejectReasons.set(reason, (rejectReasons.get(reason) ?? 0) + 1);
        // D2：quota/ineligible 只计数，不算「连续同因需处理」的天数。
        if (REJECT_ATTENTION_EXCLUDED.includes(reason)) continue;
        const day = dayOfRow(row);
        if (!rejectDays.has(reason)) rejectDays.set(reason, new Set());
        rejectDays.get(reason).add(day);
      }
    }
  }
  summary.attempts = attempts.size;
  summary.firstAt = firstMs;
  let best = null;
  for (const [reason, count] of rejectReasons.entries()) {
    const days = rejectDays.get(reason)?.size ?? 0;
    if (best === null || count > best.count || (count === best.count && reason < best.reason)) {
      best = { reason, count, days, needsAttention: days >= AUTOPROCEDURE_REPEAT_REJECT_DAYS };
    }
  }
  summary.rejectTop = best;
  return summary;
}

/** Drafts per local day, total and per session (for budget/quota checks). */
export function draftsToday(rows, { day = null, now = new Date() } = {}) {
  const targetDay = day ?? dayString(now instanceof Date ? now : new Date(now));
  let total = 0;
  const bySession = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== 'draft') continue;
    if (dayOfRow(row) !== targetDay) continue;
    total += 1;
    if (typeof row.sessionId === 'string' && row.sessionId !== '') {
      bySession.set(row.sessionId, (bySession.get(row.sessionId) ?? 0) + 1);
    }
  }
  return { day: targetDay, total, bySession };
}

/** LLM budget/quota consumption for one local day.
 *
 * MAJ-5 语义：`calls` 统计的是**真实 provider 调用尝试**（成功、超时、不可用都算），
 * 预算拒绝本身（llm 行 reason='budget'）不计——它没有发生调用。该计数与候选产出
 * 解耦：次数/预算耗尽后只是不再调模型，本地 rules 草稿照常产出候选。
 */
export function llmUsageToday(rows, { day = null, now = new Date() } = {}) {
  const targetDay = day ?? dayString(now instanceof Date ? now : new Date(now));
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (dayOfRow(row) !== targetDay) continue;
    if (row?.kind === 'llm') {
      if (row.reason !== 'budget') calls += 1;
      tokensIn += Number.isInteger(row.tokens?.in) ? row.tokens.in : 0;
      tokensOut += Number.isInteger(row.tokens?.out) ? row.tokens.out : 0;
    }
  }
  return { day: targetDay, calls, tokensIn, tokensOut, tokens: tokensIn + tokensOut };
}

/** Read the persisted autoProcedure state block (tolerant; never throws). */
export function readAutoProcedureState(memoryRoot) {
  try {
    const state = readState(memoryRoot);
    const value = state?.autoProcedure;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Evaluate the stalled condition and persist it into memory-state.json.
 * Reads only the ledger tail (limit 5000) — no content, no session log.
 *
 * @returns {{ok:boolean, state:object|null, code?:string}}
 */
export function evaluateStalled({ memoryRoot, enabled = true, now = new Date() } = {}) {
  if (!enabled) return { ok: false, code: 'E_AP_DISABLED', state: null };
  const read = readLedgerRows(memoryRoot);
  if (!read.ok) return { ok: false, code: 'E_AP_LEDGER_READ', state: null };
  const summary = summarizeLedger(read.rows, { now });
  const nowMs = msOf(now);
  const runningLongEnough = summary.firstAt !== null && (nowMs - summary.firstAt) >= AUTOPROCEDURE_STALLED_DAYS * DAY_MS;
  const stalled = summary.drafted7d === 0 && runningLongEnough;
  const state = {
    state: stalled ? 'stalled' : 'ok',
    lastDraftAt: summary.lastDraftAt,
    drafted7d: summary.drafted7d,
    rejectTop: summary.rejectTop
      ? { reason: summary.rejectTop.reason, count: summary.rejectTop.count, days: summary.rejectTop.days }
      : null,
  };
  try {
    updateState(memoryRoot, { autoProcedure: state }, { now: now instanceof Date ? now : new Date(now) });
    return { ok: true, state, summary };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_AP_STATE_WRITE', state };
  }
}
