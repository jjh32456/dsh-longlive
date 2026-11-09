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

export const INDEX_DIRNAME = 'index';
export const EVENTS_DB = 'events.db';
export const EVENTS_AUDIT = 'events.audit.jsonl';
export const FRAMES_DIR = 'frames';
export const BUILD_STATE = 'build-state.json';
export const EVENT_SCHEMA = 'events/v1';
// S8: 2 = 新增 topic_phrases_json（向后兼容：老库自动 ALTER，老记录读成 []）。
export const INDEX_SCHEMA_VERSION = 2;

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
 * Read-only event search used by memory_recall/status surfaces. Opens the DB
 * with `readOnly: true` when supported; never creates the index or changes WAL.
 */
export function searchEventsReadOnly({ memoryRoot = '', query = '', limit = 5 } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') return { ok: false, code: 'E_MEMORY_ROOT', rows: [] };
  const paths = indexPaths(root);
  if (!fs.existsSync(paths.db)) return { ok: false, code: 'E_EVENTS_INDEX_MISSING', rows: [] };
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return { ok: true, rows: [], strategy: 'empty-query' };
  let db = null;
  try {
    const { DatabaseSync } = sqlite();
    try {
      db = new DatabaseSync(paths.db, { readOnly: true });
    } catch {
      // Older Node builds may not accept readOnly; a query-only handle is still
      // safe because this function never calls write statements.
      db = new DatabaseSync(paths.db);
    }
    const rows = db.prepare('SELECT id, session_id, turn, kind, summary, terms_json, anchors_json, digest FROM events').all();
    const terms = q.split(/\s+/u).filter(Boolean);
    const scored = [];
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
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    return { ok: true, rows: scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 5))), strategy: 'readonly-scan' };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_EVENTS_READ', message: String(error?.message ?? error), rows: [] };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
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
  // A brand-new/empty DB will get the current SCHEMA (which already has the
  // column), so only an existing events table can be genuinely missing it.
  let hasTopicPhrases = true;
  try {
    const eventsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
    if (eventsTable) {
      const columns = db.prepare('PRAGMA table_info(events)').all();
      hasTopicPhrases = columns.some((column) => column.name === 'topic_phrases_json');
      const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
      const metaSchema = hasMeta ? (db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v ?? null) : null;
      needsMigration = dbExisted && (!hasTopicPhrases || userVersion < INDEX_SCHEMA_VERSION
        || metaSchema === `${EVENT_SCHEMA}/1` || metaSchema === null);
    }
  } catch (error) {
    db.close();
    migrationDiag({ event: 'inspect-failed', dbPath, code: error?.code ?? null, message: String(error?.message ?? error) });
    throw new IndexError('E_INDEX_UNAVAILABLE', `event index schema inspection failed: ${error?.message ?? error}`, {
      dbPath, cause: error?.code ?? String(error),
    });
  }

  let backupPath = null;
  const backupSuffixes = ['-wal', '-shm'];
  const backupSidecars = [];
  let restoreBackup = null;
  if (needsMigration) {
    backupPath = `${dbPath}.bak-${nowIso(now).replace(/[:.]/g, '-')}`;
    try {
      // Checkpoint first so the main DB is a complete snapshot; sidecars are
      // copied too when SQLite keeps them, and restored as a set on failure.
      try { db.exec('PRAGMA wal_checkpoint(FULL)'); } catch { /* best effort */ }
      fs.copyFileSync(dbPath, backupPath);
      for (const suffix of backupSuffixes) {
        const from = `${dbPath}${suffix}`;
        if (!fs.existsSync(from)) continue;
        const to = `${backupPath}${suffix}`;
        fs.copyFileSync(from, to);
        backupSidecars.push(to);
      }
      migrationDiag({ event: 'backup-created', dbPath, backupPath, sidecars: backupSidecars });
      restoreBackup = () => {
        try { db.close(); } catch { /* already closed */ }
        fs.copyFileSync(backupPath, dbPath);
        for (const suffix of backupSuffixes) {
          const from = `${backupPath}${suffix}`;
          const to = `${dbPath}${suffix}`;
          if (fs.existsSync(from)) fs.copyFileSync(from, to);
          else if (fs.existsSync(to)) fs.rmSync(to, { force: true });
        }
      };
    } catch (error) {
      try { db.close(); } catch { /* ignore */ }
      migrationDiag({ event: 'backup-failed', dbPath, backupPath, code: error?.code ?? null, message: String(error?.message ?? error) });
      throw new IndexError('E_INDEX_MIGRATION_BACKUP', `event index migration backup failed: ${error?.message ?? error}`, {
        dbPath, backupPath, cause: error?.code ?? String(error),
      });
    }
  }

  try {
    db.exec(SCHEMA);
    if (!hasTopicPhrases) db.exec('ALTER TABLE events ADD COLUMN topic_phrases_json TEXT');
    db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
    db.prepare("INSERT INTO meta(k, v) VALUES('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(`${EVENT_SCHEMA}/${INDEX_SCHEMA_VERSION}`);
    db.prepare("INSERT INTO meta(k, v) VALUES('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(String(INDEX_SCHEMA_VERSION));
    if (needsMigration) {
      db.prepare("INSERT INTO meta(k, v) VALUES('last_migration_backup', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        .run(String(backupPath ?? ''));
      db.prepare("INSERT INTO meta(k, v) VALUES('last_migration_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        .run(nowIso(now));
      migrationDiag({ event: 'migration-applied', dbPath, backupPath, version: INDEX_SCHEMA_VERSION });
    }
  } catch (error) {
    if (restoreBackup) {
      try { restoreBackup(); } catch (restoreError) {
        migrationDiag({ event: 'restore-failed', dbPath, backupPath, code: restoreError?.code ?? null, message: String(restoreError?.message ?? restoreError) });
      }
    } else {
      try { db.close(); } catch { /* ignore */ }
    }
    migrationDiag({ event: 'migration-failed', dbPath, backupPath, code: error?.code ?? null, message: String(error?.message ?? error) });
    throw new IndexError('E_INDEX_MIGRATION', `event index migration failed: ${error?.message ?? error}`, {
      dbPath, backupPath, restored: Boolean(restoreBackup), cause: error?.code ?? String(error),
    });
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
    db.exec('BEGIN IMMEDIATE');
    try {
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
      db.exec('ROLLBACK');
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

  return { memoryRoot, paths, dbPath, upsertEvent, deleteSession, search, listEvents, count, getEvent, stats, getMeta, setMeta, close };
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
