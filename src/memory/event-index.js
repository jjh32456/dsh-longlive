// src/memory/event-index.js — M2-A：统一 memory event 模型 + 事件索引（SQLite FTS5）
//
// 依据提案 §1.1 / §2.2 / §9.1（v2.6.3）与 FTS5-MEMGAP-EVIDENCE（任务）：
//   * L1 事件索引是 L0 会话日志的**派生**：可整体删除后仅凭 L0 重建（硬验收）；
//   * 主查询入口 = SQLite FTS5（node:sqlite 内置，本机 3.53.4 / FTS5=1）；
//   * 双表：`events_fts` = trigram(raw_text) 覆盖中文 ≥3 字子串/版本号/ID/日期；
//           `events_terms` = unicode61(term_text 预分词 bigram + aliases) 补 2 字 CJK；
//   * 单写管道：一条 EventRecord 在同一个事务里写 events + events_fts + events_terms，
//     并追加派生 JSONL 审计层 `events.audit.jsonl`（可导出/diff/迁移）；
//   * 幂等：同一 (id, digest) 重放不产生新行；会话副本按 visible-messages digest 去重。
//
// 本模块只读 L0（绝不写 .dsh/sessions），所有落盘都在 <memoryRoot>/.longlive/index/。

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decompressFrame, deriveMessagesDigest, parseSession, splitFrames, stableStringify } from '../codec.js';
import { appendJsonLine } from '../util/append-store.js';
import { extractTerms, termTextOf, aliasesOf, buildFtsCandidates } from './fts-query.js';
import { makeSessionTurnAnchor, turnDigest } from './anchors.js';

const require = createRequire(import.meta.url);
let sqliteModule = null;

/** Lazy node:sqlite loader: keeps the module loadable on hosts without it. */
function sqlite() {
  if (sqliteModule === null) sqliteModule = require('node:sqlite');
  return sqliteModule;
}

// S8: import 放在 SQLite loader 之后（ESM 合法），与同文件顶部 S1 的
// append-store import 错开，降低两个补丁在同一文件同一区域的文本冲突。
import { extractTopicPhrases } from './topic-phrases.js';
import { DEFAULT_TIERING, TIER_SCHEMA, resolveTierPolicy, buildTierHint, isBusyError } from './tiers.js';

export const INDEX_DIRNAME = 'index';
export const EVENTS_DB = 'events.db';
export const EVENTS_AUDIT = 'events.audit.jsonl';
export const FRAMES_DIR = 'frames';
export const BUILD_STATE = 'build-state.json';
export const EVENT_SCHEMA = 'events/v1';
// S8: 2 = 新增 topic_phrases_json（向后兼容：老库自动 ALTER，老记录读成 []）。
export const INDEX_SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  seq_start INTEGER,
  seq_end INTEGER,
  time_start INTEGER,
  time_end INTEGER,
  project TEXT,
  kind TEXT,
  summary TEXT,
  topics_json TEXT,
  terms_json TEXT,
  topic_phrases_json TEXT,
  tier TEXT,
  counts_json TEXT,
  anchors_json TEXT,
  digest TEXT NOT NULL,
  built_at INTEGER,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session_turn ON events(session_id, turn);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(time_end);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(id UNINDEXED, raw_text, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS events_terms USING fts5(id UNINDEXED, term_text, aliases, tokenize='unicode61');
`;

export class IndexError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function indexPaths(memoryRoot) {
  const root = path.resolve(String(memoryRoot ?? ''));
  const dir = path.join(root, '.longlive', INDEX_DIRNAME);
  return {
    root,
    dir,
    db: path.join(dir, EVENTS_DB),
    audit: path.join(dir, EVENTS_AUDIT),
    framesDir: path.join(dir, FRAMES_DIR),
    buildState: path.join(dir, BUILD_STATE),
  };
}

function nowIso(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function textOf(event) {
  const parts = event?.data?.content;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function classifyKind(corpus, counts) {
  const text = String(corpus ?? '');
  if (/(决定|拍板|裁定|结论|选型|方案|定稿|通过)/.test(text)) return 'conclusion';
  if (/(事故|故障|报错|失败|回归|broken|error|crash)/i.test(text)) return 'incident';
  if (/(计划|下一步|待办|排期|里程碑)/.test(text)) return 'plan';
  if (counts.toolCalls > 0) return 'ops';
  return 'chat';
}

function rawTextFor(record) {
  const parts = [
    `[${record.kind}] ${record.summary}`,
    Array.isArray(record.terms) ? record.terms.join(' ') : '',
    Array.isArray(record.topics) ? record.topics.join(' ') : '',
    Array.isArray(record.topicPhrases) ? record.topicPhrases.join(' ') : '',
    record.project ?? '',
  ];
  return parts.filter((part) => typeof part === 'string' && part !== '').join('\n').slice(0, 20000);
}

function parseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    turn: row.turn,
    seqStart: row.seq_start,
    seqEnd: row.seq_end,
    timeStart: row.time_start,
    timeEnd: row.time_end,
    project: row.project,
    kind: row.kind,
    summary: row.summary,
    topics: safeJson(row.topics_json, []),
    terms: safeJson(row.terms_json, []),
    topicPhrases: safeJson(row.topic_phrases_json, []),
    counts: safeJson(row.counts_json, {}),
    anchors: safeJson(row.anchors_json, []),
    digest: row.digest,
    builtAt: row.built_at,
    source: row.source,
    tier: row.tier ?? null,
    ...(typeof row.rank === 'number' ? { rank: row.rank } : {}),
  };
}

function safeJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new IndexError('E_EVENT_INVALID', 'event must be an object');
  if (typeof record.id !== 'string' || record.id === '') throw new IndexError('E_EVENT_ID', 'event.id required');
  if (typeof record.sessionId !== 'string' || record.sessionId === '') {
    throw new IndexError('E_EVENT_SESSION', 'event.sessionId required');
  }
  if (!Number.isInteger(record.turn) || record.turn < 0) throw new IndexError('E_EVENT_TURN', 'event.turn required');
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) {
    throw new IndexError('E_EVENT_DIGEST', 'event.digest required (sha256 hex)');
  }
}

/**
 * Open (and lazily create) the event index.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {() => Date} [options.now]
 * @param {string} [options.dbPath] override for tests
 */
/**
 * v3 §5.5/§6.4：只读扫描路径（1–2 字兜底）+ tier 谓词（同型改造，M9/MINOR-3）。
 * Read-only event search used by memory_recall/status surfaces. Opens the DB
 * with `readOnly: true` when supported; never creates the index or changes WAL.
 */
export function searchEventsReadOnly({ memoryRoot = '', query = '', limit = 5, tier = 'auto', currentSessionId = '', sessionId = '', kind = '', tiering = DEFAULT_TIERING, nowMs = Date.now() } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') return { ok: false, code: 'E_MEMORY_ROOT', rows: [] };
  const paths = indexPaths(root);
  if (!fs.existsSync(paths.db)) return { ok: false, code: 'E_EVENTS_INDEX_MISSING', rows: [] };
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return { ok: true, rows: [], strategy: 'empty-query' };
  const { warmCutoff, hotCutoff, warmDays } = tierCutoffs(nowMs, tiering);
  const suppressedCap = Math.max(1, Math.min(1000, Number(tiering?.suppressedCap ?? DEFAULT_TIERING.suppressedCap) || DEFAULT_TIERING.suppressedCap));
  const mode = String(tiering?.mode ?? DEFAULT_TIERING.mode);
  let db = null;
  try {
    const { DatabaseSync } = sqlite();
    try {
      db = new DatabaseSync(paths.db, { readOnly: true });
    } catch {
      db = new DatabaseSync(paths.db);
    }
    db.exec('PRAGMA busy_timeout = 2000');
    let busyTimeoutMs = 2000;
    try { const row = db.prepare('PRAGMA busy_timeout').get(); if (Number.isFinite(Number(row?.timeout))) busyTimeoutMs = Number(row.timeout); } catch { /* older sqlite */ }
    // v4 §6.5-2 / Z7：off 不读 meta（只探列）
    let state;
    if (mode === 'off') {
      // MINOR-1（round1）：off 的列探测失败也不许解释成"无列"（M5 的读失败语义同样适用）。
      let hasTierColumn = false;
      try {
        hasTierColumn = db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'tier');
      } catch (error) {
        const busy = isBusyError(error);
        return {
          ok: false,
          code: busy ? 'E_INDEX_QUERY_BUSY' : 'E_INDEX_QUERY_FAILED',
          retryable: busy,
          detail: { where: 'table_info', errcode: error?.errcode ?? null, errstr: error?.errstr ?? String(error?.message ?? error) },
          rows: [],
          stats: { strategy: 'readonly-scan', busyTimeoutMs },
        };
      }
      state = { ok: true, hasTierColumn, passAtMs: null, passAtRaw: null, labelsSource: null };
    } else {
      state = readTierState(db, { nowMs, tiering });
    }
    if (state.ok === false) {
      return { ok: false, code: state.code, retryable: Boolean(state.retryable), detail: state.detail, rows: [], stats: { strategy: 'readonly-scan', busyTimeoutMs } };
    }
    const policy = resolveTierPolicy({
      mode: tiering.mode,
      requested: tier,
      hasTierColumn: state.hasTierColumn,
      passAtMs: state.passAtMs,
      labelsSource: state.labelsSource,
      maxStaleHours: tiering.maxStaleHours ?? DEFAULT_TIERING.maxStaleHours,
      nowMs,
      hasReader: Boolean(currentSessionId),
    });
    if (policy.error) return { ok: false, code: policy.error, rows: [], message: `tier request rejected: ${tier}` };
    const reader = currentSessionId ? String(currentSessionId) : null;
    const sessionFilter = String(sessionId ?? '').trim();
    const kindFilter = String(kind ?? '').trim();
    const columns = state.hasTierColumn
      ? ['id', 'session_id', 'turn', 'kind', 'summary', 'terms_json', 'anchors_json', 'digest', 'time_end', 'tier']
      : ['id', 'session_id', 'turn', 'kind', 'summary', 'terms_json', 'anchors_json', 'digest', 'time_end'];
    const selectCols = state.hasTierColumn
      ? 'id, session_id, turn, kind, summary, terms_json, anchors_json, digest, time_end, tier'
      : 'id, session_id, turn, kind, summary, terms_json, anchors_json, digest, time_end';
    const rows = db.prepare(`SELECT ${selectCols} FROM events`).all();
    const terms = q.split(/\s+/u).filter(Boolean);
    const scored = [];
    let matchedTotal = 0;
    let visibleCount = 0;
    for (const row of rows) {
      let termsList = [];
      try { termsList = JSON.parse(row.terms_json ?? '[]'); } catch { /* corrupt row */ }
      const haystack = `${row.summary ?? ''} ${Array.isArray(termsList) ? termsList.join(' ') : ''}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
        if (String(row.summary ?? '').toLowerCase().includes(term)) score += 2;
      }
      if (score <= 0) continue;
      if (sessionFilter && !String(row.session_id ?? '').includes(sessionFilter)) continue;
      if (kindFilter && String(row.kind ?? '') !== kindFilter) continue;
      matchedTotal += 1;                                     // v4 §6.11：过滤 session/kind 后、tier 前
      const tierValue = state.hasTierColumn ? (row.tier ?? null) : null;
      if (policy.filtering && !rowVisible(tierValue, row.session_id, row.time_end, policy, { warmCutoff, hotCutoff, reader })) {
        continue;                                            // 被挡：不占 20 行窗口
      }
      visibleCount += 1;
      let anchors = [];
      try { anchors = JSON.parse(row.anchors_json ?? '[]'); } catch { /* corrupt */ }
      scored.push({
        id: row.id,
        sessionId: row.session_id,
        turn: row.turn,
        kind: row.kind,
        summary: row.summary ?? '',
        terms: Array.isArray(termsList) ? termsList : [],
        anchor: Array.isArray(anchors) ? anchors[0] ?? null : null,
        tier: tierValue,
        timeEnd: row.time_end ?? null,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    const suppressed = Math.max(0, matchedTotal - visibleCount);
    const capped = suppressed > suppressedCap;
    const coldSuppressed = policy.filtering ? Math.min(suppressedCap, suppressed) : 0;
    // ★ M-A6：同 searchEventsFts——off 不读 meta ⇒ 这组字段缺席。
    const tierMetaFields = mode === 'off' ? {} : {
      tierPassAt: state.passAtRaw,
      tierStale: Boolean(policy.stale),
      tierLabelsUsable: Boolean(policy.labelsUsable),
      tierLabelsSource: state.labelsSource,
    };
    const fields = {
      tierFilter: policy.tierFilter ?? null,
      tierApplied: Boolean(policy.filtering),
      suppressedBasis: policy.suppressedBasis ?? null,
      coldSuppressed,
      coldSuppressedCapped: capped,
      suppressedCountStrategy: policy.filtering ? 'scan' : null,
      ...tierMetaFields,
      queryDegraded: false,
      queryDegradedCode: null,
      warmDays,
    };
    const hint = buildTierHint({ ...fields, hits: scored.length, suppressedCap });
    return {
      ok: true,
      rows: scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 5))),
      strategy: 'readonly-scan',
      matched: scored.length,
      matchedTotal,
      visibleCount,
      ...fields,
      hint,
      stats: { strategy: 'readonly-scan', countStrategy: policy.filtering ? 'scan' : null, columns, scan: { columns }, matchedTotal, visibleCount, busyTimeoutMs },
    };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_EVENTS_READ', message: String(error?.message ?? error), rows: [] };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

function tierCutoffs(nowMs, tiering) {
  const warmDays = Number(tiering?.warmDays ?? DEFAULT_TIERING.warmDays);
  const hotDays = Number(tiering?.hotDays ?? DEFAULT_TIERING.hotDays);
  return { warmDays, warmCutoff: nowMs - warmDays * 86400000, hotCutoff: nowMs - hotDays * 86400000 };
}

/** 附录 B：三套谓词（label / time / label-explicit）；cutoff 内联避免绑定顺序坑。 */
function tierPredicate(policy, { warmCutoff, hotCutoff, reader }) {
  if (!policy.filtering) return { sql: '', binds: [] };
  if (policy.sqlKind === 'label') {
    const binds = [];
    let sql = "e.tier IN ('hot','warm')";
    if (reader) { sql += ' OR e.session_id = ?'; binds.push(reader); }
    if (reader) { sql += ` OR (e.tier IS NULL AND (e.time_end >= ${warmCutoff} OR e.session_id = ?))`; binds.push(reader); } else { sql += ` OR (e.tier IS NULL AND e.time_end >= ${warmCutoff})`; }
    return { sql: ` AND (${sql})`, binds };
  }
  if (policy.sqlKind === 'time') {
    const binds = [];
    let sql = `e.time_end >= ${warmCutoff}`;
    if (reader) { sql += ' OR e.session_id = ?'; binds.push(reader); }
    return { sql: ` AND (${sql})`, binds };
  }
  // label-explicit（附录 B ③；hot 叠 overlay，warm/cold 不叠）
  const wanted = String(policy.requested);
  const binds = [wanted, wanted];
  let sql = `e.tier = ? OR (e.tier IS NULL AND ? = CASE WHEN e.time_end >= ${hotCutoff} THEN 'hot' WHEN e.time_end >= ${warmCutoff} THEN 'warm' ELSE 'cold' END)`;
  if (policy.overlay && reader) { sql += ' OR e.session_id = ?'; binds.push(reader); }
  return { sql: ` AND (${sql})`, binds };
}

/** JS 侧同义词（只读扫描路径用；与 tierPredicate 的语义一一对应）。 */
function rowVisible(tierValue, sessionId, timeEnd, policy, { warmCutoff, hotCutoff, reader }) {
  const t = timeEnd ?? null;
  const isReader = reader !== null && String(sessionId) === reader;
  const computed = t !== null && t >= hotCutoff ? 'hot' : (t !== null && t >= warmCutoff ? 'warm' : 'cold');
  if (policy.sqlKind === 'label') return ['hot', 'warm'].includes(tierValue) || isReader || (tierValue === null && (computed !== 'cold' || isReader));
  if (policy.sqlKind === 'time') return computed !== 'cold' || isReader;
  const explicit = String(policy.requested);
  if (tierValue === explicit) return true;
  if (tierValue === null && computed === explicit) return true;
  if (policy.overlay && isReader) return true;
  return false;
}

/**
 * FTS5 fast path over the same derived index (v3 §6.4 重写版):
 *  - busy_timeout=2000 on the read-only handle;
 *  - per-attempt error recording (no `catch { rows=[] }`);
 *  - all-attempts-failed => ok:false (never a fake empty);
 *  - same-attempt double COUNT for coldSuppressed (M10).
 */
// __countFault: 仅测试用的内部注入位（M-A4 / Y10；不经配置、不进工具面，§2.2-11 显式例外）。
export function searchEventsFts({ memoryRoot = '', query = '', limit = 8, sessionId = '', kind = '', tier = 'auto', currentSessionId = '', tiering = DEFAULT_TIERING, nowMs = Date.now(), __countFault = false } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (!root) return { ok: false, code: 'E_MEMORY_ROOT', rows: [] };
  const paths = indexPaths(root);
  if (!fs.existsSync(paths.db)) return { ok: false, code: 'E_EVENTS_INDEX_MISSING', rows: [] };
  const q = String(query ?? '').trim();
  if (!q) return { ok: true, rows: [], strategy: 'empty-query' };
  const cap = Math.max(1, Math.min(100, Number(limit) || 8));
  const suppressedCap = Math.max(1, Math.min(1000, Number(tiering?.suppressedCap ?? DEFAULT_TIERING.suppressedCap) || DEFAULT_TIERING.suppressedCap));
  const sessionFilter = String(sessionId ?? '').trim();
  const kindFilter = String(kind ?? '').trim();
  const extra = [];
  const tailBinds = [];
  if (sessionFilter) {
    const escaped = sessionFilter.replace(/[!%_]/g, (ch) => `!${ch}`);
    extra.push("e.session_id LIKE ? ESCAPE '!'");
    tailBinds.push(`%${escaped}%`);
  }
  if (kindFilter) { extra.push('e.kind = ?'); tailBinds.push(kindFilter); }
  const tail = extra.length ? ` AND ${extra.join(' AND ')}` : '';
  const textLength = [...q].length;
  const attempts = [];
  if (textLength >= 3) attempts.push({ strategy: 'trigram', table: 'events_fts' });
  attempts.push({ strategy: 'terms', table: 'events_terms' });
  const term = `"${q.replace(/"/g, '""')}"`;
  const { warmCutoff, hotCutoff, warmDays } = tierCutoffs(nowMs, tiering);
  const mode = String(tiering?.mode ?? DEFAULT_TIERING.mode);
  let db = null;
  try {
    const { DatabaseSync } = sqlite();
    try {
      db = new DatabaseSync(paths.db, { readOnly: true });
    } catch {
      db = new DatabaseSync(paths.db);
    }
    db.exec('PRAGMA busy_timeout = 2000');
    let busyTimeoutMs = 2000;
    try { const row = db.prepare('PRAGMA busy_timeout').get(); if (Number.isFinite(Number(row?.timeout))) busyTimeoutMs = Number(row.timeout); } catch { /* older sqlite */ }
    // ★ M5/Z7：off 不读 meta（只探列）；显式 tier 在 off 下仍按 A7b 抛/生效
    let state;
    if (mode === 'off') {
      // MINOR-1（round1）：off 的列探测失败也不许解释成"无列"（M5 的读失败语义同样适用）。
      let hasTierColumn = false;
      try {
        hasTierColumn = db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'tier');
      } catch (error) {
        const busy = isBusyError(error);
        return {
          ok: false,
          code: busy ? 'E_INDEX_QUERY_BUSY' : 'E_INDEX_QUERY_FAILED',
          retryable: busy,
          detail: { where: 'table_info', errcode: error?.errcode ?? null, errstr: error?.errstr ?? String(error?.message ?? error) },
          rows: [],
          tierFilter: null,
          queryDegraded: false,
          stats: { strategy: 'none', busyTimeoutMs, attempts: [] },
        };
      }
      state = { ok: true, hasTierColumn, passAtMs: null, passAtRaw: null, labelsSource: null };
    } else {
      state = readTierState(db, { nowMs, tiering });
    }
    if (state.ok === false) {
      // v4 §6.5-3：绝不解释成 no-tier-column / no-pass-meta，绝不静默切 time-fallback
      return {
        ok: false,
        code: state.code,
        retryable: Boolean(state.retryable),
        detail: state.detail,
        message: `tier state unavailable: ${state.code}`,
        rows: [],
        tierFilter: null,
        queryDegraded: false,
        stats: { strategy: 'none', busyTimeoutMs, attempts: [] },
      };
    }
    const policy = resolveTierPolicy({
      mode: tiering.mode,
      requested: tier,
      hasTierColumn: state.hasTierColumn,
      passAtMs: state.passAtMs,
      labelsSource: state.labelsSource,
      maxStaleHours: tiering.maxStaleHours ?? DEFAULT_TIERING.maxStaleHours,
      nowMs,
      hasReader: Boolean(currentSessionId),
    });
    if (policy.error) {
      return { ok: false, code: policy.error, rows: [], message: `tier request rejected: ${tier}`, tierFilter: null, stats: { strategy: 'none', busyTimeoutMs, attempts: [] } };
    }
    const reader = currentSessionId ? String(currentSessionId) : null;
    const tp = tierPredicate(policy, { warmCutoff, hotCutoff, reader });
    const selectCols = state.hasTierColumn
      ? 'e.id, e.session_id, e.turn, e.kind, e.summary, e.time_end, e.tier'
      : 'e.id, e.session_id, e.turn, e.kind, e.summary, e.time_end';   // ★ M4：无列库 SELECT 里没有 tier
    const columnsFor = state.hasTierColumn
      ? ['e.id', 'e.session_id', 'e.turn', 'e.kind', 'e.summary', 'e.time_end', 'e.tier']
      : ['e.id', 'e.session_id', 'e.turn', 'e.kind', 'e.summary', 'e.time_end'];
    const selectSql = (a) => `SELECT ${selectCols} FROM ${a.table} f JOIN events e ON e.id = f.id WHERE ${a.table} MATCH ?${tail}${tp.sql} ORDER BY bm25(${a.table}) LIMIT ?`;
    const countSql = (a, withPred) => `SELECT COUNT(*) AS n FROM ${a.table} f JOIN events e ON e.id = f.id WHERE ${a.table} MATCH ?${tail}${withPred ? tp.sql : ''}`;
    let rows = [];
    const attemptErrors = [];
    let strategy = 'none';
    let successCount = 0;
    for (const attempt of attempts) {
      try {
        const got = db.prepare(selectSql(attempt)).all(term, ...tailBinds, ...tp.binds, cap);
        successCount += 1;
        strategy = attempt.strategy;
        if (got.length > 0) { rows = got; break; }         // ★ 命中路径不变（不影响计数）
        strategy = `${attempt.strategy}-empty`;
      } catch (error) {
        attemptErrors.push({ strategy: attempt.strategy, code: error?.code ?? null, errcode: error?.errcode ?? null, busy: isBusyError(error) });
      }
    }
    // ★ M-A6：off 不读 meta（Z7），因此这组字段"省略"而不是伪造 stale:true；
    //   口径写死为"省略"（round4 M-A6 二选一），C8/Z8 的 off 分支按缺席断言。
    const tierMetaFields = mode === 'off' ? {} : {
      tierPassAt: state.passAtRaw,
      tierStale: Boolean(policy.stale),
      tierLabelsUsable: Boolean(policy.labelsUsable),
      tierLabelsSource: state.labelsSource,
    };
    const baseFields = {
      tierFilter: policy.tierFilter ?? null,
      tierApplied: Boolean(policy.filtering),
      suppressedBasis: policy.suppressedBasis ?? null,
      coldSuppressed: 0,
      coldSuppressedCapped: false,
      suppressedCountStrategy: null,
      ...tierMetaFields,
      queryDegraded: attemptErrors.length > 0,
      queryDegradedCode: attemptErrors[0]?.code ?? null,
      warmDays,
    };
    // §6.5-5：rows===0 且所有 attempt 都抛错 => ok:false（绝不假空）
    if (rows.length === 0 && successCount === 0) {
      const busy = attemptErrors.length > 0 && attemptErrors.every((e) => e.busy);
      return {
        ok: false,
        code: busy ? 'E_INDEX_QUERY_BUSY' : 'E_INDEX_QUERY_FAILED',
        retryable: busy,
        message: `FTS query failed (${attemptErrors.map((e) => `${e.strategy}:${e.code}`).join(', ')})`,
        detail: { attemptErrors },
        rows: [],
        ...baseFields,
        stats: { strategy, busyTimeoutMs, attempts: [] },
      };
    }
    // ★★ B1-①：计数与命中路径彻底解耦——逐 attempt 独立 total/visible，按 hidden 取 argmax。
    let coldSuppressed = 0;
    let capped = false;
    let countStrategy = null;
    let countTotal = null;
    let countVisible = null;
    let countMs = 0;
    const attemptStats = [];
    if (policy.filtering) {
      const countStarted = Date.now();
      let bestHidden = -1;
      for (const attempt of attempts) {
        const st = { strategy: attempt.strategy, columns: columnsFor.slice(), predicate: policy.sqlKind ?? 'none', total: null, visible: null, hidden: null, error: null };
        attemptStats.push(st);
        try {
          if (__countFault) throw Object.assign(new Error('injected count fault (test only)'), { code: 'E_INJECTED_COUNT_FAULT' });
          const total = Number(db.prepare(countSql(attempt, false)).get(term, ...tailBinds)?.n ?? 0);
          const visible = Number(db.prepare(countSql(attempt, true)).get(term, ...tailBinds, ...tp.binds)?.n ?? 0);
          st.total = total;
          st.visible = visible;
          st.hidden = Math.max(0, total - visible);
          if (st.hidden > bestHidden) {
            bestHidden = st.hidden;
            countStrategy = attempt.strategy;
            countTotal = total;
            countVisible = visible;
          }
        } catch (error) {
          const busy = isBusyError(error);
          st.error = { code: error?.code ?? null, errcode: error?.errcode ?? null, busy };
          attemptErrors.push({ strategy: `${attempt.strategy}-count`, code: error?.code ?? null, errcode: error?.errcode ?? null, busy });
        }
      }
      countMs = Date.now() - countStarted;
      if (bestHidden >= 0) {
        capped = bestHidden > suppressedCap;
        coldSuppressed = Math.min(suppressedCap, bestHidden);
      } else {
        coldSuppressed = null;            // 全部 COUNT 失败 => 无法统计（不是 0）
      }
    }
    const degraded = attemptErrors.length > 0;
    const fields = {
      ...baseFields,
      coldSuppressed,
      coldSuppressedCapped: capped,
      suppressedCountStrategy: countStrategy,
      queryDegraded: degraded,
      queryDegradedCode: degraded
        ? (attemptErrors.some((e) => e.busy) ? 'E_INDEX_QUERY_BUSY' : 'E_INDEX_QUERY_FAILED')
        : null,
    };
    const hint = buildTierHint({ ...fields, hits: rows.length, suppressedCap });
    return {
      ok: true,
      strategy,
      matched: rows.length,
      rows: rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        turn: row.turn,
        kind: row.kind,
        summary: row.summary ?? '',
        tier: state.hasTierColumn ? (row.tier ?? null) : null,   // ★ M4：映射条件化
        timeEnd: row.time_end ?? null,
      })),
      ...fields,
      hint,
      stats: { strategy, countStrategy, countTotal, countVisible, countMs, busyTimeoutMs, attempts: attemptStats },
    };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_EVENTS_READ', message: String(error?.message ?? error), rows: [] };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

// ===== v3 附录 A.1–A.4（逐字转写；仅把 countMainBackups 导出给红队断言用） =====
const MIGRATION_PHASE = Object.freeze({
  BEGIN: 'begin', RESCAN: 'rescan', BACKUP: 'backup',
  SCHEMA: 'schema', ALTER: 'alter', BACKFILL: 'backfill', META: 'meta', COMMIT: 'commit',
});

function safeClose(db) {
  try { db.close(); } catch { /* already closed */ }
}

/** M4：只数"主备份"，-wal/-shm 是同一组的一部分，不算独立份数。 */
export function countMainBackups(dbPath) {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak-`;
  let count = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      if (name.endsWith('-wal') || name.endsWith('-shm')) continue;
      let info = null;
      try { info = fs.statSync(path.join(dir, name)); } catch { info = null; }   // EPERM/ENOENT -> 不算
      if (info !== null && info.isFile()) count += 1;                            // ★ M3
    }
  } catch { /* unreadable dir -> 0 */ }
  return count;
}

/**
 * MINOR-9（round1）：同一毫秒的两次迁移不得互相覆盖备份——主备份名已存在（普通文件）
 * 时加序号；目录占位是故障（A5-①），不绕开，交给 copyFileSync 抛 EISDIR。
 */
function backupPathFor(dbPath, now) {
  const base = `${dbPath}.bak-${nowIso(now).replace(/[:.]/g, '-')}`;
  let candidate = base;
  for (let index = 1; index <= 99; index += 1) {
    let info = null;
    try { info = fs.lstatSync(candidate); } catch { info = null; }
    if (info === null) return candidate;            // 名字空闲
    if (info.isDirectory()) return candidate;       // 目录占位：保持"备份失败"语义（A5-①）
    candidate = `${base}-${index}`;                 // 同毫秒已有一份主备份
  }
  return `${base}-${Date.now()}`;
}

/** M2：调用方必须已持写锁（BEGIN IMMEDIATE）；-shm 不备份。失败时清掉已写文件。 */
function createIndexBackup(dbPath, now, migrationDiag) {
  const backupPath = backupPathFor(dbPath, now);
  const written = [backupPath];                    // ★ MINOR-3：先登记再拷贝，partial 也能被清
  try {
    fs.copyFileSync(dbPath, backupPath);            // 持锁 ⇒ 一致快照
    const wal = `${dbPath}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      written.push(`${backupPath}-wal`);
      fs.copyFileSync(wal, `${backupPath}-wal`);
    }
    migrationDiag({ event: 'backup-created', dbPath, backupPath, bytes: fs.statSync(backupPath).size });
    return { path: backupPath, files: written.slice() };
  } catch (error) {
    // 目录占位时 rmSync 会抛 EISDIR 并被吞掉 ⇒ 目录保留（A5-① 的"目录仍存在"断言）。
    for (const file of written) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
    migrationDiag({ event: 'backup-failed', dbPath, backupPath, code: error?.code ?? null });
    throw error;
  }
}

/**
 * MINOR-8（round4）：restore 会覆盖主库 + -wal 并删除 -shm。若其它进程/句柄仍持有该库，
 * 它们看到的是旧 inode / 旧 WAL —— restore 之后这些读者必须重新 open（宿主场景：重启或
 * 下一次工具调用）。本轮只在同进程 live 句柄上验证（A5b），跨进程语义未测（设计 §16-13）。
 */
function restoreIndexBackup(db, backup, dbPath) {
  safeClose(db);
  fs.copyFileSync(backup.path, dbPath);
  const backupWal = `${backup.path}-wal`;
  if (fs.existsSync(backupWal)) fs.copyFileSync(backupWal, `${dbPath}-wal`);
  else { try { fs.rmSync(`${dbPath}-wal`, { force: true }); } catch { /* ignore */ } }
  // -shm 是瞬态索引：删掉，SQLite 下次 open 自动重建（A9 验证）
  try { fs.rmSync(`${dbPath}-shm`, { force: true }); } catch { /* ignore */ }
}

function removeIndexBackup(backup) {
  for (const file of backup.files) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
}

function setMetaRaw(target, key, value) {
  target
    .prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(key, String(value));
}

function backfillTierColumn(db, now, warmDays = DEFAULT_TIERING.warmDays) {
  const cutoff = now().getTime() - warmDays * 86400000;
  db.prepare(`
    UPDATE events SET tier = CASE
      WHEN session_id IN (
        SELECT session_id FROM events GROUP BY session_id HAVING MAX(time_end) >= ?
      ) THEN 'warm'
      ELSE 'cold'
    END
    WHERE tier IS NULL
  `).run(cutoff);
  const left = db.prepare('SELECT COUNT(*) AS n FROM events WHERE tier IS NULL').get().n;
  if (left !== 0) {
    throw new IndexError('E_TIER_LABEL_INVALID', `tier backfill left ${left} rows NULL`, { left });
  }
}

function migrateEventIndex(db, ctx) {
  const { dbPath, now, migrationDiag, setMetaRaw: setMetaImpl, backfillTierColumn: backfill } = ctx;

  // ★★ H2：以下状态全部声明在 try 之前；catch 只读不声明 ★★
  let began = false;
  let phase = MIGRATION_PHASE.BEGIN;
  let preVersion = null;
  let backup = null;
  let restored = false;

  try {
    // ① M2(v4)：这里不再 checkpoint——写锁下 主库 + 非空 -wal 就是一致快照，
    //    且迁移写入只进 WAL（事务 ROLLBACK ⇒ 主库字节不动）⇒ 可逐字节还原。
    // ② 先拿锁，再备份（M2）：持写锁 ⇒ 备份期间无并发提交
    db.exec('BEGIN IMMEDIATE');
    began = true;
    phase = MIGRATION_PHASE.RESCAN;

    // ③ 事务内重探测（挡"两个进程各持旧探测结果"）
    const liveCols = db.prepare('PRAGMA table_info(events)').all();
    const liveHasTier = liveCols.length === 0 ? true : liveCols.some((c) => c.name === 'tier');
    const liveHasTP = liveCols.length === 0 ? true : liveCols.some((c) => c.name === 'topic_phrases_json');
    preVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);

    // ④ 备份
    phase = MIGRATION_PHASE.BACKUP;
    backup = createIndexBackup(dbPath, now, migrationDiag);

    // ⑤ DDL（顺序钉死）
    phase = MIGRATION_PHASE.SCHEMA;
    db.exec(SCHEMA);
    phase = MIGRATION_PHASE.ALTER;
    if (!liveHasTP) db.exec('ALTER TABLE events ADD COLUMN topic_phrases_json TEXT');
    if (!liveHasTier) db.exec('ALTER TABLE events ADD COLUMN tier TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_tier ON events(tier)');

    phase = MIGRATION_PHASE.BACKFILL;
    if (!liveHasTier) backfill(db, now);

    phase = MIGRATION_PHASE.META;
    db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
    setMetaImpl(db, 'schema', `${EVENT_SCHEMA}/${INDEX_SCHEMA_VERSION}`);
    setMetaImpl(db, 'schema_version', String(INDEX_SCHEMA_VERSION));
    setMetaImpl(db, 'tier_schema', TIER_SCHEMA);
    setMetaImpl(db, 'tier_pass_at', nowIso(now));
    setMetaImpl(db, 'tier_labels_source', 'backfill');   // MINOR-3/4：回填标签不被 filter 信任
    // 观察①（round1 判词 §6）：applied_migrations 只写不读——迁移判据是 user_version +
    // 事务内列重探 + meta.schema（单源实现，设计未要求读取；见 NOTES 观察①）。
    setMetaImpl(db, 'applied_migrations', JSON.stringify([TIER_SCHEMA]));
    setMetaImpl(db, 'last_migration_backup', backup.path);
    setMetaImpl(db, 'last_migration_at', nowIso(now));

    phase = MIGRATION_PHASE.COMMIT;
    db.exec('COMMIT');
    began = false;
    migrationDiag({ event: 'migration-applied', dbPath, backupPath: backup.path, version: INDEX_SCHEMA_VERSION });
    return { backupPath: backup.path, restored: false };
  } catch (error) {
    // ⑥ 回滚：只在自己 BEGIN 之后
    if (began) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } }
    began = false;

    // ⑦ restore 判定：只读 try 外声明的变量（H2 的错误在此被永久消除）
    let liveVersion = NaN;
    try { liveVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? NaN); } catch { /* ignore */ }
    const versionNotAdvanced = !Number.isFinite(liveVersion)
      || preVersion === null || liveVersion <= preVersion;
    if (backup !== null && versionNotAdvanced) {
      try { restoreIndexBackup(db, backup, dbPath); restored = true; } catch (restoreError) {
        migrationDiag({ event: 'restore-failed', dbPath, code: restoreError?.code ?? null });
      }
    }
    // ⑧ M3：restore 成功 ⇒ 备份与 live 等价，立即删（失败重试不增长）；否则保留并标注
    if (restored) removeIndexBackup(backup);
    safeClose(db);

    // ⑨ 错误码只在事务外封装一次（H2 核心）
    const code = phase === MIGRATION_PHASE.BEGIN ? 'E_INDEX_MIGRATION_BUSY'
      : phase === MIGRATION_PHASE.BACKUP ? 'E_INDEX_MIGRATION_BACKUP'
        : 'E_INDEX_MIGRATION';
    // MINOR-10（round1）：补回 1.8.3 的 migration-failed 可审计行（只含阶段/错误码，不含正文）。
    migrationDiag({
      event: 'migration-failed', dbPath, phase, code,
      restored, backupRetained: backup !== null && !restored,
      cause: error?.code ?? String(error),
    });
    throw new IndexError(code, `event index migration failed at ${phase}: ${error?.message ?? error}`, {
      dbPath,
      phase,
      preVersion,
      liveVersion: Number.isFinite(liveVersion) ? liveVersion : null,
      backupPath: backup?.path ?? null,
      backupFiles: backup?.files ?? null,
      restored,
      backupRetained: backup !== null && !restored,
      retryable: phase === MIGRATION_PHASE.BEGIN,
      cause: error?.code ?? String(error),
    });
  }
}

/**
 * MAJOR-1（round1 判词）：非迁移 open 不得在"已是最新的库"上拿写锁。
 *  - 全新库（无 events 表）：SCHEMA + tier 索引 + 版本/meta 必须写（不存在可跳过的"最新"态）；
 *  - 已有 events 表：只补探测到的真实缺项，且补建一律 busy_timeout=0 —— 长写锁
 *    （A12：20 s）下补建立即 BUSY 并跳过（记诊断 schema-repair-skipped），open 本身
 *    不等待、不失败；全一致时这里一条写语句都不发（真·只读打开）。
 *  - 只有"非 BUSY"的补建失败才抛 E_INDEX_OPEN/E_INDEX_OPEN_BUSY（1.8.3 失败面不放大）。
 */
function ensureCurrentSchema(db, { dbPath, migrationDiag, setMetaRaw: setMetaImpl, probe = {} }) {
  const hasEventsTable = probe.hasEventsTable === true;
  const header = `${EVENT_SCHEMA}/${INDEX_SCHEMA_VERSION}`;
  const repairs = [];
  if (!hasEventsTable) {
    repairs.push({ what: 'schema', run: () => {
      db.exec(SCHEMA);
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_tier ON events(tier)');
    } });
  } else if (probe.hasTierIndex !== true) {
    repairs.push({ what: 'tier-index', run: () => db.exec('CREATE INDEX IF NOT EXISTS idx_events_tier ON events(tier)') });
  }
  if (probe.userVersion !== INDEX_SCHEMA_VERSION) {
    repairs.push({ what: 'user-version', run: () => db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`) });
  }
  if (probe.metaSchema !== header) {
    repairs.push({ what: 'meta-schema', run: () => {
      setMetaImpl(db, 'schema', header);
      setMetaImpl(db, 'schema_version', String(INDEX_SCHEMA_VERSION));
      setMetaImpl(db, 'tier_schema', TIER_SCHEMA);
    } });
  }
  if (repairs.length === 0) return;                    // ★ 已是最新：零写语句、零写锁（A12）
  const waitForWriter = !hasEventsTable;               // 建新库可以等锁；修复已有库绝不等待
  try {
    if (!waitForWriter) db.exec('PRAGMA busy_timeout = 0');
    for (const repair of repairs) {
      try {
        repair.run();
      } catch (error) {
        if (!waitForWriter && isBusyError(error)) {
          migrationDiag({ event: 'schema-repair-skipped', dbPath, what: repair.what, cause: error?.errcode ?? error?.code ?? null });
          continue;                                    // 长写锁：跳过补建，open 照常成功
        }
        throw error;
      }
    }
  } catch (error) {
    safeClose(db);
    const busy = isBusyError(error);
    throw new IndexError(busy ? 'E_INDEX_OPEN_BUSY' : 'E_INDEX_OPEN', `event index open (schema) failed: ${error?.message ?? error}`, {
      dbPath, cause: error?.code ?? String(error),
      retryable: busy,
      phase: 'ensure-schema',
    });
  } finally {
    try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* db already closed on the error path */ }
  }
}

/** v4 §6.5-2：三值判别式——"查不到"（ok:true）与"读失败"（ok:false）绝不混。 */
export function readTierState(db, { nowMs = Date.now(), tiering = DEFAULT_TIERING } = {}) {
  let hasTierColumn = false;
  try {
    hasTierColumn = db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'tier');
  } catch (error) {
    const busy = isBusyError(error);
    return {
      ok: false,
      code: busy ? 'E_INDEX_QUERY_BUSY' : 'E_INDEX_QUERY_FAILED',
      retryable: busy,
      detail: { where: 'table_info', errcode: error?.errcode ?? null, errstr: error?.errstr ?? String(error?.message ?? error) },
    };
  }
  try {
    const get = (key) => db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v ?? null;
    const passAtRaw = get('tier_pass_at');
    const parsed = passAtRaw === null ? NaN : Date.parse(passAtRaw);
    return {
      ok: true,
      hasTierColumn,
      passAtMs: Number.isFinite(parsed) ? parsed : null,
      passAtRaw,
      labelsSource: get('tier_labels_source'),
      tierSchema: get('tier_schema'),
      nowMs,
      tiering,
    };
  } catch (error) {
    const busy = isBusyError(error);
    return {
      ok: false,
      code: busy ? 'E_INDEX_QUERY_BUSY' : 'E_INDEX_QUERY_FAILED',
      retryable: busy,
      detail: { where: 'meta', errcode: error?.errcode ?? null, errstr: error?.errstr ?? String(error?.message ?? error) },
    };
  }
}

// ── 模块级内核：db / setMeta 全是形参（照抄到模块作用域也不会 ReferenceError）──
export function applyTierLabelsInner(db, setMeta, { labels, counts, nowMs, passAt }) {
  // MAJOR-3（round1）：BEGIN 也必须在 try 内——写锁下 BEGIN 的 BUSY 要映射成
  // E_TIER_BUSY（retryable），不能把裸 ERR_SQLITE_ERROR/errcode=5 漏给调用方。
  let began = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    began = true;
    db.exec('CREATE TEMP TABLE IF NOT EXISTS tier_stage (id TEXT PRIMARY KEY, tier TEXT)');
    db.exec('DELETE FROM tier_stage');
    const ins = db.prepare('INSERT INTO tier_stage(id, tier) VALUES(?, ?)');
    for (const [id, tier] of labels) ins.run(id, tier);   // MINOR-2：单事务单循环
    db.exec(`UPDATE events SET tier = (SELECT tier FROM tier_stage WHERE tier_stage.id = events.id)
             WHERE id IN (SELECT id FROM tier_stage)`);
    setMeta('tier_pass_at', new Date(passAt).toISOString());
    setMeta('tier_labels_source', 'pass');
    setMeta('tier_schema', TIER_SCHEMA);
    setMeta('tier_counts', JSON.stringify(counts));
    setMeta('tier_pass_ms', String(Math.max(0, nowMs - passAt)));
    db.exec('COMMIT');
    began = false;
  } catch (error) {
    if (began) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } }
    const busy = isBusyError(error);
    throw new IndexError(busy ? 'E_TIER_BUSY' : 'E_TIER_WRITE',
      `tier labels write failed: ${error?.message ?? error}`, {
        cause: error?.code ?? String(error), retryable: busy,
      });
  }
}

export function openEventIndex(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  if (memoryRoot === '') throw new IndexError('E_MEMORY_ROOT', 'memoryRoot required');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const paths = indexPaths(memoryRoot);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.framesDir, { recursive: true });
  const dbPath = options.dbPath ? path.resolve(options.dbPath) : paths.db;
  const dbExisted = fs.existsSync(dbPath);
  const { DatabaseSync } = sqlite();
  const migrationDiag = (row) => {
    try {
      const dir = path.join(memoryRoot, '.longlive', 'diagnostics');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'event-index-migration.jsonl'),
        `${JSON.stringify({ schema: 'event-index-migration/v1', at: nowIso(now), ...row })}\n`, 'utf8');
    } catch { /* diagnostics must never mask the real error */ }
  };
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    migrationDiag({ event: 'open-failed', dbPath, code: error?.code ?? null, message: String(error?.message ?? error) });
    throw new IndexError('E_INDEX_UNAVAILABLE', `event index open failed: ${error?.message ?? error}`, {
      dbPath, cause: error?.code ?? String(error),
    });
  }

  let needsMigration = false;
  // MAJOR-1（round1）：迁移判定与 open 分离——下方探测全只读；探测结果同时决定
  // "非迁移 open 还需不需要写"（已最新的库不得再拿写锁）。
  // A brand-new/empty DB will get the current SCHEMA (which already has the
  // column), so only an existing events table can be genuinely missing it.
  const schemaProbe = {
    hasEventsTable: false,
    hasTopicPhrases: true,
    hasTier: true,   // v3 A.3: same default-true guard as hasTopicPhrases
    hasTierIndex: false,
    userVersion: 0,
    metaSchema: null,
  };
  try {
    const eventsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
    if (eventsTable) {
      schemaProbe.hasEventsTable = true;
      const columns = db.prepare('PRAGMA table_info(events)').all();
      schemaProbe.hasTopicPhrases = columns.some((column) => column.name === 'topic_phrases_json');
      schemaProbe.hasTier = columns.some((column) => column.name === 'tier');
      schemaProbe.userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
      schemaProbe.metaSchema = hasMeta ? (db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v ?? null) : null;
      schemaProbe.hasTierIndex = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_tier'").get());
      needsMigration = dbExisted && (!schemaProbe.hasTopicPhrases || !schemaProbe.hasTier || schemaProbe.userVersion < INDEX_SCHEMA_VERSION
        || schemaProbe.metaSchema === `${EVENT_SCHEMA}/1` || schemaProbe.metaSchema === null);
    }
  } catch (error) {
    db.close();
    migrationDiag({ event: 'inspect-failed', dbPath, code: error?.code ?? null, message: String(error?.message ?? error) });
    throw new IndexError('E_INDEX_UNAVAILABLE', `event index schema inspection failed: ${error?.message ?? error}`, {
      dbPath, cause: error?.code ?? String(error),
    });
  }

  if (needsMigration) {
    // 观察②（round1 判词 §6）：返回值不再挂死变量——迁移结果只用于诊断，handle 不暴露。
    migrateEventIndex(db, { dbPath, now, migrationDiag, setMetaRaw, backfillTierColumn });
  } else {
    ensureCurrentSchema(db, { dbPath, migrationDiag, setMetaRaw, probe: schemaProbe });
  }
  let closed = false;

  function getMeta(key) {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key);
    return row ? row.v : null;
  }

  function setMeta(key, value) {
    db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, String(value));
  }

  /** v4 M1：handle 方法（闭包内 db/setMeta），落点即 :662 的返回对象字面量。
   *  M-A1（round4）：写成箭头属性而不是具名函数，静态 grep 只会命中带 db 形参的内核。 */
  const applyTierLabels = (args) => applyTierLabelsInner(db, setMeta, args);

  function appendAudit(record, action) {
    const line = {
      schema: 'events-audit/v1',
      id: record.id,
      sessionId: record.sessionId,
      turn: record.turn,
      digest: record.digest,
      kind: record.kind ?? null,
      anchors: record.anchors ?? [],
      builtAt: record.builtAt ?? Date.parse(nowIso(now)),
      source: record.source ?? 'rebuild',
      action,
    };
    // S1: append 失败不再静默 — append-store 统一加锁/fsync/坏行隔离，并记
    // logger.warn + 计数（write-health）。本审计层仍是派生数据：失败不阻断 upsert。
    return appendJsonLine({
      file: paths.audit,
      row: line,
      label: 'events.audit',
      healthRoot: paths.root,
      now,
      quarantineDir: path.join(paths.root, '.longlive', 'quarantine'),
    });
  }

  function upsertEvent(record, options2 = {}) {
    validateRecord(record);
    const existing = db.prepare('SELECT digest FROM events WHERE id = ?').get(record.id);
    if (existing && existing.digest === record.digest) {
      return { inserted: false, duplicated: true, id: record.id };
    }
    if (existing && existing.digest !== record.digest) {
      // Same id, different content: never overwrite silently. The conflict is
      // audited and the caller must treat it as a rejected write.
      appendAudit({ ...record, source: record.source ?? options2.source ?? 'upsert', anchors: record.anchors ?? [] }, 'id-digest-conflict');
      return { inserted: false, conflict: true, code: 'E_ID_DIGEST_CONFLICT', id: record.id };
    }
    const builtAt = Number.isInteger(record.builtAt) ? record.builtAt : Date.parse(nowIso(now));
    const source = record.source ?? options2.source ?? 'rebuild';
    const rawText = rawTextFor(record);
    const termText = termTextOf([record.summary, ...(record.topics ?? []), ...(record.terms ?? []), ...(record.topicPhrases ?? [])].join('\n')).slice(0, 12000);
    const aliases = [...new Set([...(aliasesOf(record.summary ?? '')), ...(record.aliases ?? [])])].join(' ').slice(0, 4000);
    const anchors = record.anchors ?? [];
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`
        INSERT INTO events
          (id, session_id, turn, seq_start, seq_end, time_start, time_end, project, kind,
           summary, topics_json, terms_json, topic_phrases_json, counts_json, anchors_json, digest, built_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id, turn = excluded.turn,
          seq_start = excluded.seq_start, seq_end = excluded.seq_end,
          time_start = excluded.time_start, time_end = excluded.time_end,
          project = excluded.project, kind = excluded.kind, summary = excluded.summary,
          topics_json = excluded.topics_json, terms_json = excluded.terms_json,
          topic_phrases_json = excluded.topic_phrases_json,
          counts_json = excluded.counts_json, anchors_json = excluded.anchors_json,
          digest = excluded.digest, built_at = excluded.built_at, source = excluded.source
      `).run(
        record.id, record.sessionId, record.turn,
        record.seqStart ?? null, record.seqEnd ?? null,
        record.timeStart ?? null, record.timeEnd ?? null,
        record.project ?? null, record.kind ?? null,
        record.summary ?? null,
        JSON.stringify(record.topics ?? []),
        JSON.stringify(record.terms ?? []),
        JSON.stringify(record.topicPhrases ?? []),
        JSON.stringify(record.counts ?? {}),
        JSON.stringify(anchors),
        record.digest, builtAt, source,
      );
      db.prepare('DELETE FROM events_fts WHERE id = ?').run(record.id);
      db.prepare('DELETE FROM events_terms WHERE id = ?').run(record.id);
      db.prepare('INSERT INTO events_fts(id, raw_text) VALUES(?, ?)').run(record.id, rawText);
      db.prepare('INSERT INTO events_terms(id, term_text, aliases) VALUES(?, ?, ?)').run(record.id, termText, aliases);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* BEGIN itself may have failed (BUSY) */ }
      throw new IndexError('E_INDEX_WRITE', `event index write failed: ${error.message}`, { id: record.id });
    }
    appendAudit({ ...record, builtAt, source, anchors }, existing ? 'update' : 'insert');
    setMeta('last_write_at', nowIso(now));
    setMeta('schema', `${EVENT_SCHEMA}/${INDEX_SCHEMA_VERSION}`);
    return { inserted: true, id: record.id };
  }

  function runCandidates(table, candidates, limit, kind) {
    for (const candidate of candidates) {
      let rows;
      try {
        const sql = kind
          ? `SELECT e.*, bm25(${table}) AS rank FROM ${table} JOIN events e ON e.id = ${table}.id WHERE ${table} MATCH ? AND e.kind = ? ORDER BY rank LIMIT ?`
          : `SELECT e.*, bm25(${table}) AS rank FROM ${table} JOIN events e ON e.id = ${table}.id WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`;
        rows = kind
          ? db.prepare(sql).all(candidate.match, kind, limit)
          : db.prepare(sql).all(candidate.match, limit);
      } catch {
        continue; // FTS syntax errors are expected for hostile input: try next candidate
      }
      if (rows.length > 0) return { rows: rows.map(parseRow), strategy: `${table}:${candidate.label}` };
    }
    return null;
  }

  /**
   * Query the index. Never throws for hostile queries: candidate chain + try/catch,
   *全失败返回 { ok:true, rows:[], code:'E_FTS_NO_MATCH' }。
   */
  function search(query, opts = {}) {
    const limit = Number.isInteger(opts.limit) ? Math.min(Math.max(opts.limit, 1), 100) : 10;
    const kind = typeof opts.kind === 'string' && opts.kind !== '' ? opts.kind : undefined;
    const candidates = buildFtsCandidates(query);
    const tried = [];
    if (candidates.normalized === '') {
      return { ok: true, schema: EVENT_SCHEMA, query: '', normalized: '', rows: [], code: 'E_FTS_EMPTY_QUERY', strategy: null, tried: [] };
    }
    for (const candidate of candidates.raw) tried.push(`events_fts:${candidate.label}`);
    const rawHit = runCandidates('events_fts', candidates.raw, limit, kind);
    if (rawHit) {
      return { ok: true, schema: EVENT_SCHEMA, query: String(query), normalized: candidates.normalized, rows: rawHit.rows, strategy: rawHit.strategy, tried };
    }
    for (const candidate of candidates.terms) tried.push(`events_terms:${candidate.label}`);
    const termHit = runCandidates('events_terms', candidates.terms, limit, kind);
    if (termHit) {
      return { ok: true, schema: EVENT_SCHEMA, query: String(query), normalized: candidates.normalized, rows: termHit.rows, strategy: termHit.strategy, tried };
    }
    return { ok: true, schema: EVENT_SCHEMA, query: String(query), normalized: candidates.normalized, rows: [], code: 'E_FTS_NO_MATCH', strategy: null, tried };
  }

  function listEvents(opts = {}) {
    const limit = Number.isInteger(opts.limit) ? Math.min(Math.max(opts.limit, 1), 500) : 20;
    const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
    const kind = typeof opts.kind === 'string' && opts.kind !== '' ? opts.kind : null;
    const rows = kind
      ? db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY time_end DESC, id ASC LIMIT ? OFFSET ?').all(kind, limit, offset)
      : db.prepare('SELECT * FROM events ORDER BY time_end DESC, id ASC LIMIT ? OFFSET ?').all(limit, offset);
    return rows.map(parseRow);
  }

  function count(opts = {}) {
    const kind = typeof opts.kind === 'string' && opts.kind !== '' ? opts.kind : null;
    const row = kind
      ? db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(kind)
      : db.prepare('SELECT COUNT(*) AS n FROM events').get();
    return row.n;
  }

  /** Read one EventRecord by id (AutoCard source-of-truth check). */
  function getEvent(id) {
    if (typeof id !== 'string' || id === '') return null;
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return row ? parseRow(row) : null;
  }

  function deleteSession(sessionId) {
    const rows = db.prepare('SELECT id FROM events WHERE session_id = ?').all(sessionId);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        db.prepare('DELETE FROM events_fts WHERE id = ?').run(row.id);
        db.prepare('DELETE FROM events_terms WHERE id = ?').run(row.id);
      }
      db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new IndexError('E_INDEX_DELETE', `session delete failed: ${error.message}`, { sessionId });
    }
    return { ok: true, removed: rows.length };
  }

  function stats() {
    const sizeOf = (file) => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    };
    return {
      schema: EVENT_SCHEMA,
      schemaVersion: INDEX_SCHEMA_VERSION,
      dbPath,
      // WAL means the main db file stays small until checkpoint: report the family.
      dbBytes: sizeOf(dbPath) + sizeOf(`${dbPath}-wal`) + sizeOf(`${dbPath}-shm`),
      events: count(),
      ftsRows: db.prepare('SELECT COUNT(*) AS n FROM events_fts').get().n,
      termRows: db.prepare('SELECT COUNT(*) AS n FROM events_terms').get().n,
      sessions: (() => {
        const row = db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM events').get();
        return row.n;
      })(),
      kinds: Object.fromEntries(db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind').all().map((row) => [row.kind, row.n])),
      lastWriteAt: getMeta('last_write_at'),
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { memoryRoot, paths, dbPath, upsertEvent, deleteSession, search, listEvents, count, getEvent, stats, getMeta, setMeta, applyTierLabels, close };
}

/** One-line summary: user first message kept whole (240 chars) + assistant tail 160. */
function summaryOf(userTexts, assistantTexts, topicPhrases = []) {
  const head = userTexts[0] ?? assistantTexts[0] ?? '';
  const tail = assistantTexts[assistantTexts.length - 1] ?? '';
  const parts = [
    String(head).replace(/\s+/g, ' ').trim().slice(0, 240),
    tail === '' ? '' : `→ ${String(tail).replace(/\s+/g, ' ').trim().slice(0, 160)}`,
  ].filter((part) => part !== '');
  const summary = parts.join(' ').slice(0, 480);
  return summary;
}

/** Deduped topicPhrases: user-marked phrases first, then turn-wide phrases. */
function topicPhrasesOf(userTexts, assistantTexts) {
  const userPhrases = extractTopicPhrases(userTexts, { limit: 8 });
  const allPhrases = extractTopicPhrases([...userTexts, ...assistantTexts], { limit: 12 });
  const out = [];
  const seen = new Set();
  for (const phrase of [...userPhrases, ...allPhrases]) {
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out.slice(0, 12);
}

/** Extract per-turn EventRecords from a parsed session. */
export function extractTurns(header, events, frames = [], texts = []) {
  const sessionId = typeof header?.id === 'string' && header.id !== ''
    ? header.id
    : (typeof header?.sessionId === 'string' && header.sessionId !== '' ? header.sessionId : null);
  if (sessionId === null) throw new IndexError('E_SESSION_ID', 'session header carries no id');
  const project = typeof header?.cwd === 'string' ? header.cwd : null;

  // Map seq -> frame index (frame 0 carries the header line).
  const seqToFrame = new Map();
  let lineNo = 0;
  (Array.isArray(texts) ? texts : []).forEach((text, frameIndex) => {
    for (const line of String(text).split('\n')) {
      if (line === '') continue;
      if (lineNo === 0) {
        lineNo = 1;
        continue;
      }
      seqToFrame.set(lineNo - 1, frameIndex);
      lineNo += 1;
    }
  });

  let currentTurn = 0;
  const groups = new Map();
  for (const event of events) {
    const turn = Number(event?.data?.turn);
    if (Number.isInteger(turn) && turn >= 0) currentTurn = turn;
    if (!groups.has(currentTurn)) groups.set(currentTurn, []);
    groups.get(currentTurn).push(event);
  }

  const out = [];
  for (const [turn, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const seqStart = list[0].seq;
    const seqEnd = list[list.length - 1].seq;
    const times = list.map((event) => Number(event?.time)).filter((value) => Number.isFinite(value));
    const userTexts = [];
    const assistantTexts = [];
    let toolCalls = 0;
    for (const event of list) {
      if (event.type === 'user/message' && event?.data?.source?.kind === 'user') userTexts.push(textOf(event));
      else if (event.type === 'assistant/message') assistantTexts.push(textOf(event));
      else if (event.type === 'tool/call') toolCalls += 1;
    }
    const corpus = [...userTexts, ...assistantTexts].filter((text) => text !== '').join('\n');
    const counts = { userMsgs: userTexts.length, assistantMsgs: assistantTexts.length, toolCalls };
    const kind = classifyKind(corpus, counts);
    // S8: 主题短语先从用户消息抽（引号/书名号/内容块/实体后缀），再从整轮补；
    // 老记录没有 topicPhrases，读取端按 [] 回落。
    const topicPhrases = topicPhrasesOf(userTexts, assistantTexts);
    const summary = summaryOf(userTexts, assistantTexts, topicPhrases);
    const terms = extractTerms(corpus, [sessionId, ...topicPhrases]);
    const topics = [...new Set([...topicPhrases, ...terms.filter((term) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(term))])].slice(0, 5);
    const digest = turnDigest(events, seqStart, seqEnd);
    const anchor = makeSessionTurnAnchor({ sessionId, turn, seqStart, seqEnd, digest, status: 'live' });
    const frameIndexes = [...new Set(list.map((event) => seqToFrame.get(event.seq)).filter((value) => Number.isInteger(value)))];
    out.push({
      id: `evt:${sessionId}:${turn}`,
      sessionId,
      turn,
      seqStart,
      seqEnd,
      timeStart: times.length > 0 ? Math.min(...times) : null,
      timeEnd: times.length > 0 ? Math.max(...times) : null,
      project,
      kind,
      topics,
      terms,
      topicPhrases,
      summary,
      counts,
      anchors: [anchor],
      digest,
      frameIndexes,
      rawText: rawTextFor({ kind, summary, terms, topics, topicPhrases, project }),
      source: 'rebuild',
    });
  }
  return out;
}

/** Recursively discover DSH session logs under the given roots. */
export function discoverSessionLogs(roots) {
  const out = [];
  const stack = (Array.isArray(roots) ? roots : [roots])
    .filter((root) => typeof root === 'string' && root !== '')
    .map((root) => path.resolve(root));
  const seen = new Set();
  while (stack.length > 0) {
    const dir = stack.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') {
        out.push({ file: full, sessionId: path.basename(dir) });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function defaultSessionRoots() {
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? path.resolve(process.env.DSH_HOME.trim())
    : path.join(os.homedir(), '.dsh');
  return [path.join(dshHome, 'sessions')];
}

/** Remove every derived index artifact (used by the delete-rebuild acceptance). */
export function deleteIndex(memoryRoot) {
  const paths = indexPaths(memoryRoot);
  const removed = [];
  for (const file of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`, paths.audit, paths.buildState]) {
    try {
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch {
      /* best effort */
    }
  }
  try {
    fs.rmSync(paths.framesDir, { recursive: true, force: true });
    removed.push(paths.framesDir);
  } catch {
    /* best effort */
  }
  return { ok: true, removed };
}

/**
 * Build (or incrementally extend) the event index from L0 session logs.
 * L0 is opened read-only; every write stays under <memoryRoot>/.longlive/index/.
 */
export function buildIndexFromSessions(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  if (memoryRoot === '') throw new IndexError('E_MEMORY_ROOT', 'memoryRoot required');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const started = Date.now();
  const sessionRoots = Array.isArray(options.sessionRoots) && options.sessionRoots.length > 0
    ? options.sessionRoots
    : defaultSessionRoots();
  const limitSessions = Number.isInteger(options.limitSessions) && options.limitSessions > 0
    ? options.limitSessions
    : Number.POSITIVE_INFINITY;
  if (options.rebuild === true) deleteIndex(memoryRoot);

  const paths = indexPaths(memoryRoot);
  const index = openEventIndex({ memoryRoot, now, ...(options.dbPath ? { dbPath: options.dbPath } : {}) });
  const logs = discoverSessionLogs(sessionRoots).slice(0, limitSessions);
  const built = [];
  const duplicates = [];
  const errors = [];
  let inserted = 0;
  let skipped = 0;
  let eventsIndexed = 0;
  const seenSessionDigests = new Map();

  for (const log of logs) {
    try {
      const buf = fs.readFileSync(log.file);
      const parsed = parseSession(buf);
      const stats = fs.statSync(log.file);
      const sessionId = typeof parsed.header?.id === 'string' && parsed.header.id !== ''
        ? parsed.header.id
        : log.sessionId;
      const sessionDigest = deriveMessagesDigest(parsed.header, parsed.events).sha256;
      const duplicateOf = seenSessionDigests.get(sessionDigest);
      if (duplicateOf !== undefined) {
        duplicates.push({ sessionId, duplicateOf, file: log.file });
        continue;
      }
      seenSessionDigests.set(sessionDigest, sessionId);
      const records = extractTurns(parsed.header, parsed.events, parsed.frames, parsed.texts);
      let sessionInserted = 0;
      for (const record of records) {
        record.builtAt = now().getTime();
        record.source = options.source ?? 'rebuild';
        const result = index.upsertEvent(record, { source: record.source });
        if (result.inserted) {
          inserted += 1;
          sessionInserted += 1;
        } else {
          skipped += 1;
        }
        eventsIndexed += 1;
      }
      fs.writeFileSync(path.join(paths.framesDir, `${sessionId}.json`), `${JSON.stringify({
        schema: 'frames/v1',
        sessionId,
        sessionDigest,
        logBytes: buf.length,
        logMtimeMs: stats.mtimeMs,
        logSha256: crypto.createHash('sha256').update(buf).digest('hex'),
        frames: parsed.frames.length,
        turns: records.map((record) => ({
          turn: record.turn,
          seqStart: record.seqStart,
          seqEnd: record.seqEnd,
          frames: record.frameIndexes,
        })),
      }, null, 2)}\n`, 'utf8');
      built.push({
        sessionId,
        dirSessionId: log.sessionId,
        headerId: sessionId,
        turns: records.length,
        inserted: sessionInserted,
        bytes: buf.length,
        logBytes: buf.length,
        logMtimeMs: stats.mtimeMs,
        lastSeq: parsed.events.length - 1,
        lastTurn: records.length > 0 ? records[records.length - 1].turn : -1,
        header: { id: parsed.header?.id ?? null, cwd: parsed.header?.cwd ?? null },
        sessionDigest,
        file: log.file,
      });
    } catch (error) {
      errors.push({ file: log.file, code: error?.code ?? 'E_SESSION_PARSE', message: String(error?.message ?? error) });
    }
  }

  const buildState = {
    schema: 'events-build-state/v1',
    builtAt: nowIso(now),
    schemaVersion: INDEX_SCHEMA_VERSION,
    memoryRoot,
    sessions: built.map((entry) => ({
      sessionId: entry.sessionId,
      dirSessionId: entry.dirSessionId ?? entry.sessionId,
      headerId: entry.headerId,
      turns: entry.turns,
      bytes: entry.bytes,
      logBytes: entry.logBytes,
      logMtimeMs: entry.logMtimeMs,
      lastSeq: entry.lastSeq,
      lastTurn: entry.lastTurn,
      header: entry.header,
      sessionDigest: entry.sessionDigest,
    })),
    duplicates,
    errors,
    stats: {
      sessionsScanned: logs.length,
      sessionsBuilt: built.length,
      duplicateSessions: duplicates.length,
      turns: eventsIndexed,
      inserted,
      skipped,
      errors: errors.length,
      durationMs: Date.now() - started,
    },
    generatedAt: nowIso(now),
  };
  fs.writeFileSync(paths.buildState, `${JSON.stringify(buildState, null, 2)}\n`, 'utf8');
  index.setMeta('build_state_at', buildState.builtAt);
  const finalStats = index.stats();
  index.close();
  return { ok: true, memoryRoot, paths, ...buildState.stats, duplicateSessions: duplicates.length, dbBytes: finalStats.dbBytes, built: built.length };
}

/** Panel read-only route #11 reader: list indexed events; undefined when no index. */
export function createEventsIndexReader(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const paths = indexPaths(memoryRoot);
  if (!fs.existsSync(paths.db)) return undefined;
  return function eventsReader(query = {}) {
    const index = openEventIndex({ memoryRoot, now });
    try {
      const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), 200) : 20;
      const offset = Number.isInteger(query.offset) && query.offset > 0 ? query.offset : 0;
      const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : undefined;
      const rows = index.listEvents({ limit, offset, kind });
      return {
        schema: EVENT_SCHEMA,
        events: rows,
        total: index.count({ kind }),
        limit,
        offset,
        generatedAt: now().toISOString(),
      };
    } finally {
      index.close();
    }
  };
}


/**
 * Parse appended tail frames (no session header line) starting at startSeq.
 * Host appends whole zstd frames, so (previous logBytes → new EOF) is frame aligned.
 */
export function parseSessionTail(buf, options = {}) {
  const startSeq = Number.isInteger(options.startSeq) ? options.startSeq : 0;
  const frames = splitFrames(buf);
  const texts = frames.map((frame) => decompressFrame(buf.subarray(frame.start, frame.end)));
  const events = [];
  for (const text of texts) {
    for (const line of String(text).split('\n')) {
      if (line === '') continue;
      let event = null;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new IndexError('E_TAIL_PARSE', 'tail line is not JSON: ' + error.message);
      }
      events.push(event);
    }
  }
  events.forEach((event, index) => {
    if (event.seq !== startSeq + index) {
      throw new IndexError('E_TAIL_SEQ', 'tail seq ' + event.seq + ' (expected ' + (startSeq + index) + '); log rewritten, not appended');
    }
  });
  return { frames, texts, events };
}

function readFromOffset(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (offset >= size) return Buffer.alloc(0);
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, size - offset, offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Incremental build: unchanged logs are skipped; appended logs read ONLY the new
 * tail frames (from build-state.logBytes) and index just the new turns. Any doubt
 * (shrunk file, non-frame-aligned tail, tail starting mid-turn) falls back to a
 * full re-parse of that session — digest skip in upsertEvent stays as the safety net.
 */
export function buildIndexIncremental(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  if (memoryRoot === '') throw new IndexError('E_MEMORY_ROOT', 'memoryRoot required');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const started = Date.now();
  const sessionRoots = Array.isArray(options.sessionRoots) && options.sessionRoots.length > 0
    ? options.sessionRoots
    : defaultSessionRoots();
  const paths = indexPaths(memoryRoot);
  let previousState = null;
  try {
    previousState = JSON.parse(fs.readFileSync(paths.buildState, 'utf8'));
  } catch {
    previousState = null;
  }
  if (!previousState || !Array.isArray(previousState.sessions)) {
    const full = buildIndexFromSessions({
      memoryRoot,
      sessionRoots,
      now,
      ...(options.limitSessions ? { limitSessions: options.limitSessions } : {}),
    });
    return { ok: true, mode: 'full-fallback', ...full };
  }
  const index = openEventIndex({ memoryRoot, now, ...(options.dbPath ? { dbPath: options.dbPath } : {}) });
  const logs = discoverSessionLogs(sessionRoots).slice(0, Number.isInteger(options.limitSessions) ? options.limitSessions : Number.POSITIVE_INFINITY);
  const stateBySession = new Map(previousState.sessions.map((entry) => [entry.dirSessionId ?? entry.sessionId, { ...entry }]));
  const duplicates = Array.isArray(previousState.duplicates) ? [...previousState.duplicates] : [];
  const errors = [];
  const stats = {
    sessionsScanned: logs.length,
    sessionsUnchanged: 0,
    sessionsAppended: 0,
    sessionsRebuilt: 0,
    sessionsNew: 0,
    turns: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
  };

  const rebuildOne = (log, stat) => {
    const buf = fs.readFileSync(log.file);
    const parsed = parseSession(buf);
    const headerId = typeof parsed.header?.id === 'string' && parsed.header.id !== '' ? parsed.header.id : log.sessionId;
    index.deleteSession(headerId);
    const records = extractTurns(parsed.header, parsed.events, parsed.frames, parsed.texts);
    let inserted = 0;
    for (const record of records) {
      record.builtAt = now().getTime();
      record.source = 'incremental-rebuild';
      const result = index.upsertEvent(record, { source: record.source });
      if (result.inserted) inserted += 1;
    }
    stateBySession.set(log.sessionId, {
      sessionId: headerId,
      dirSessionId: log.sessionId,
      headerId,
      turns: records.length,
      bytes: buf.length,
      logBytes: buf.length,
      logMtimeMs: stat.mtimeMs,
      lastSeq: parsed.events.length - 1,
      lastTurn: records.length > 0 ? records[records.length - 1].turn : -1,
      header: { id: parsed.header?.id ?? null, cwd: parsed.header?.cwd ?? null },
      sessionDigest: deriveMessagesDigest(parsed.header, parsed.events).sha256,
    });
    stats.turns += records.length;
    stats.inserted += inserted;
    stats.skipped += records.length - inserted;
    return { records, inserted };
  };

  for (const log of logs) {
    let stat = null;
    try {
      stat = fs.statSync(log.file);
    } catch {
      continue;
    }
    const stateEntry = stateBySession.get(log.sessionId);
    if (stateEntry && stateEntry.logBytes === stat.size && stateEntry.logMtimeMs === stat.mtimeMs) {
      stats.sessionsUnchanged += 1;
      continue;
    }
    if (!stateEntry) {
      try {
        rebuildOne(log, stat);
        stats.sessionsNew += 1;
      } catch (error) {
        errors.push({ file: log.file, code: error?.code ?? 'E_INCREMENTAL', message: String(error?.message ?? error) });
      }
      continue;
    }
    if (stat.size < stateEntry.logBytes) {
      try {
        rebuildOne(log, stat);
        stats.sessionsRebuilt += 1;
      } catch (error) {
        errors.push({ file: log.file, code: error?.code ?? 'E_INCREMENTAL', message: String(error?.message ?? error) });
      }
      continue;
    }
    try {
      const tailBuf = readFromOffset(log.file, stateEntry.logBytes);
      if (tailBuf.length === 0) {
        stats.sessionsUnchanged += 1;
        continue;
      }
      const tail = parseSessionTail(tailBuf, { startSeq: stateEntry.lastSeq + 1 });
      const firstTurn = Number(tail.events[0]?.data?.turn);
      if (!Number.isInteger(firstTurn) || firstTurn <= (stateEntry.lastTurn ?? -1)) {
        rebuildOne(log, stat);
        stats.sessionsRebuilt += 1;
        continue;
      }
      const header = { id: stateEntry.headerId ?? log.sessionId, cwd: stateEntry.header?.cwd ?? null };
      const records = extractTurns(header, tail.events, tail.frames, tail.texts);
      let inserted = 0;
      for (const record of records) {
        record.builtAt = now().getTime();
        record.source = 'incremental-tail';
        const result = index.upsertEvent(record, { source: record.source });
        if (result.inserted) inserted += 1;
      }
      stateBySession.set(log.sessionId, {
        ...stateEntry,
        turns: (stateEntry.turns ?? 0) + records.length,
        logBytes: stat.size,
        logMtimeMs: stat.mtimeMs,
        lastSeq: tail.events[tail.events.length - 1].seq,
        lastTurn: records.length > 0 ? records[records.length - 1].turn : stateEntry.lastTurn,
      });
      stats.sessionsAppended += 1;
      stats.turns += records.length;
      stats.inserted += inserted;
      stats.skipped += records.length - inserted;
    } catch {
      try {
        rebuildOne(log, stat);
        stats.sessionsRebuilt += 1;
      } catch (error2) {
        errors.push({ file: log.file, code: error2?.code ?? 'E_INCREMENTAL', message: String(error2?.message ?? error2) });
      }
    }
  }

  stats.errors = errors.length;
  const buildState = {
    schema: 'events-build-state/v1',
    builtAt: nowIso(now),
    schemaVersion: INDEX_SCHEMA_VERSION,
    memoryRoot,
    mode: 'incremental',
    sessions: [...stateBySession.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    duplicates,
    errors,
    stats,
    durationMs: Date.now() - started,
  };
  fs.writeFileSync(paths.buildState, JSON.stringify(buildState, null, 2) + '\n', 'utf8');
  index.setMeta('build_state_at', buildState.builtAt);
  const finalStats = index.stats();
  index.close();
  return { ok: true, mode: 'incremental', memoryRoot, paths, ...stats, dbBytes: finalStats.dbBytes, durationMs: Date.now() - started };
}

export { stableStringify };
