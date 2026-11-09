// conclusion-drafts.js — A1 候选池（1.8.1）。
//
// A1 的原始产出只是蒸馏原料：append-only JSONL，位于
// `<memoryRoot>/.longlive/index/conclusion-drafts.jsonl`，不在 topics/ 下，
// 因此 recall / recall-v2 / INDEX.md 都不会直接读到它。
//
// 并发：每次 append 走 memory/lock.js 的跨进程 lease，并在持锁期间用
// tmp→rename 的锁文件 + 单行 append（fsync）保证多会话不丢行。
// 损坏：每行带 prevHash/lineHash，读取时逐行校验 JSON 与链；损坏会显式报告，
// 不会把半行当候选。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withLease } from './lock.js';

export const DRAFT_SCHEMA = 'conclusion-draft/v1';
export const DRAFT_STATUSES = Object.freeze(['pending', 'distilled', 'rejected', 'expired']);
export const DRAFT_FILE_REL = path.join('.longlive', 'index', 'conclusion-drafts.jsonl');
export const DRAFT_LOCK_REL = path.join('.longlive', 'index', 'conclusion-drafts.lock');
export const DRAFT_ARCHIVE_REL = path.join('.longlive', 'archive', 'conclusion-drafts');
export const DRAFT_DEFAULT_TTL_DAYS = 30;
export const DRAFT_MAX_TEXT = 2000;

const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function nowDate(value) {
  if (value instanceof Date) return value;
  const date = new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function draftsFile(root) {
  return path.join(root, DRAFT_FILE_REL);
}

export function draftsLockFile(root) {
  return path.join(root, DRAFT_LOCK_REL);
}

export function draftsArchiveDir(root) {
  return path.join(root, DRAFT_ARCHIVE_REL);
}

function canonicalLine(entry) {
  const copy = { ...entry };
  delete copy.lineHash;
  return JSON.stringify(copy);
}

function lineHashOf(entry) {
  return sha256(canonicalLine(entry));
}

function normalizeText(value, maxChars = DRAFT_MAX_TEXT) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return Array.from(text).slice(0, maxChars).join('');
}

function normalizeId(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function draftIdOf({ sessionId, turn, kind, text }) {
  return `draft:${sha256(`${sessionId}:${turn}:${kind}:${normalizeText(text)}`).slice(0, 20)}`;
}

/**
 * Read and verify the append-only journal. Returns
 * { ok, entries, latest, corrupt, errors }.
 * `latest` is a Map(id -> newest entry) for status transitions.
 */
export function readDrafts(root, { repair = false } = {}) {
  const file = draftsFile(root);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: true, entries: [], latest: new Map(), corrupt: false, errors: [] }; }
  const entries = [];
  const errors = [];
  let prevHash = null;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let entry;
    try { entry = JSON.parse(line); } catch {
      errors.push({ line: i + 1, code: 'E_DRAFT_JSON' });
      continue;
    }
    if (!entry || entry.schema !== DRAFT_SCHEMA || typeof entry.id !== 'string') {
      errors.push({ line: i + 1, code: 'E_DRAFT_SCHEMA' });
      continue;
    }
    const expected = lineHashOf(entry);
    if (entry.lineHash !== expected) errors.push({ line: i + 1, code: 'E_DRAFT_HASH' });
    if (prevHash !== null && entry.prevHash !== prevHash) errors.push({ line: i + 1, code: 'E_DRAFT_CHAIN' });
    prevHash = entry.lineHash ?? expected;
    entries.push(entry);
  }
  const latest = new Map();
  for (const entry of entries) latest.set(entry.id, entry);
  if (errors.length > 0 && repair) {
    try {
      const corruptPath = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, corruptPath);
    } catch { /* best effort evidence */ }
  }
  return { ok: errors.length === 0, entries, latest, corrupt: errors.length > 0, errors };
}

function appendLineLocked(root, entry, now) {
  const file = draftsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readDrafts(root);
  if (existing.corrupt) {
    const error = new Error(`候选池损坏，拒绝追加：${existing.errors[0]?.code ?? 'E_DRAFT_CORRUPT'}`);
    error.code = 'E_DRAFT_CORRUPT';
    throw error;
  }
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const last = lines.length > 0 ? JSON.parse(lines.at(-1)) : null;
  const line = {
    ...entry,
    schema: DRAFT_SCHEMA,
    at: nowDate(now).toISOString(),
    prevHash: last?.lineHash ?? null,
  };
  line.lineHash = lineHashOf(line);
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(line)}\n`, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* fsync unsupported is non-fatal */ }
  } finally {
    fs.closeSync(fd);
  }
  return line;
}

/**
 * Append one draft. Idempotent by id: if the id is already present, returns
 * { written:false, duplicate:true, entry }. The append is serialized by the
 * cross-process lock and fsynced.
 */
export function appendDraft(root, input = {}, { now = new Date(), holder = `conclusion-${process.pid}` } = {}) {
  const sessionId = String(input.sessionId ?? '').trim().toLowerCase();
  if (!SESSION_ID_RE.test(sessionId)) throw Object.assign(new Error('E_DRAFT_SESSION'), { code: 'E_DRAFT_SESSION' });
  const turn = Number(input.turn);
  if (!Number.isInteger(turn) || turn < 0) throw Object.assign(new Error('E_DRAFT_TURN'), { code: 'E_DRAFT_TURN' });
  const kind = input.kind === 'decision' ? 'decision' : 'fact';
  const text = normalizeText(input.text ?? input.excerpt ?? input.title);
  if (text === '') throw Object.assign(new Error('E_DRAFT_TEXT'), { code: 'E_DRAFT_TEXT' });
  const userText = normalizeText(input.userText ?? input.text ?? input.excerpt ?? input.title);
  if (userText === '') throw Object.assign(new Error('E_DRAFT_USER_TEXT'), { code: 'E_DRAFT_USER_TEXT' });
  const id = typeof input.id === 'string' && input.id.startsWith('draft:')
    ? input.id
    : draftIdOf({ sessionId, turn, kind, text });
  const existing = readDrafts(root).latest.get(id);
  if (existing) return { written: false, duplicate: true, entry: existing };
  const entry = {
    schema: DRAFT_SCHEMA,
    id,
    sessionId,
    turn,
    at: nowDate(now).toISOString(),
    kind,
    title: normalizeText(input.title ?? text, 160),
    excerpt: normalizeText(input.excerpt ?? text, 240),
    text,
    privacyVerdict: typeof input.privacyVerdict === 'string' ? input.privacyVerdict : 'ok',
    sourceHash: sha256(text),
    userText,
    userTextHash: sha256(userText),
    status: 'pending',
    sourceRole: input.sourceRole === 'assistant' ? 'assistant' : 'user',
  };
  const line = withLease(draftsLockFile(root), { holder, ttlMs: 30_000, now }, () => appendLineLocked(root, entry, now));
  return { written: true, duplicate: false, entry: line };
}

/** Append a status transition (never rewrite or delete earlier lines). */
export function transitionDraft(root, id, status, { reason = '', now = new Date(), holder = `conclusion-${process.pid}` } = {}) {
  const allowed = DRAFT_STATUSES.includes(status) ? status : null;
  if (allowed === null) throw Object.assign(new Error('E_DRAFT_STATUS'), { code: 'E_DRAFT_STATUS' });
  const current = readDrafts(root).latest.get(id);
  if (!current) throw Object.assign(new Error('E_DRAFT_NOT_FOUND'), { code: 'E_DRAFT_NOT_FOUND' });
  if (current.status === allowed) return { written: false, entry: current };
  const line = withLease(draftsLockFile(root), { holder, ttlMs: 30_000, now }, () => appendLineLocked(root, {
    ...current,
    status: allowed,
    statusReason: normalizeText(reason, 300),
    updatedAt: nowDate(now).toISOString(),
    lineHash: undefined,
    prevHash: undefined,
  }, now));
  return { written: true, entry: line };
}

/** Newest entries only, optionally filtered. */
export function listDrafts(root, { status = null } = {}) {
  const read = readDrafts(root);
  const rows = [...read.latest.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return status === null ? rows : rows.filter((entry) => entry.status === status);
}

/**
 * Move pending drafts older than ttlDays into `.longlive/archive/conclusion-drafts/`
 * (copy + status=expired; nothing is deleted). Returns { archived, ids, auditErrors }.
 */
export function archiveExpiredDrafts(root, {
  ttlDays = DRAFT_DEFAULT_TTL_DAYS, now = new Date(), holder = `conclusion-${process.pid}`,
} = {}) {
  const ttl = Number(ttlDays);
  const days = Number.isFinite(ttl) && ttl > 0 ? ttl : DRAFT_DEFAULT_TTL_DAYS;
  const at = nowDate(now);
  const cutoff = at.getTime() - days * 24 * 60 * 60 * 1000;
  const expired = listDrafts(root, { status: 'pending' }).filter((entry) => {
    const ts = Date.parse(String(entry.at ?? ''));
    return Number.isFinite(ts) && ts < cutoff;
  });
  if (expired.length === 0) return { archived: 0, ids: [], auditErrors: [] };
  const dir = draftsArchiveDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const archiveFile = path.join(dir, `${at.toISOString().slice(0, 10)}.jsonl`);
  const auditErrors = [];
  for (const entry of expired) {
    try {
      fs.appendFileSync(archiveFile, `${JSON.stringify({ ...entry, status: 'expired', archivedAt: at.toISOString() })}\n`, 'utf8');
      transitionDraft(root, entry.id, 'expired', { reason: `ttl:${days}d`, now: at, holder });
    } catch (error) {
      auditErrors.push({ id: entry.id, code: String(error?.code ?? error) });
    }
  }
  return { archived: expired.length - auditErrors.length, ids: expired.map((entry) => entry.id), auditErrors, archiveFile };
}

export { sha256 as draftSha256 };
