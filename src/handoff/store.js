// src/handoff/store.js — the handoff card's file layer (02, v4).
//
// Two derived areas under <memoryRoot>/.longlive (no new top-level directory):
//   bridge/<safeSrc>.handoff-card.json      per-session latest card
//   bridge/<safeSelf>.handoff.json          per-session O_EXCL claim (unique gate)
//   bridge/handoff-claim-<cardId>.json      per-card claim (pid-recoverable)
//   board/handoff.jsonl (+ handoff-YYYYMM.jsonl)  append-only audit board
//
// Boundedness (N6/M4): every audit append is followed by a throttled trim
// (`maybeTrimAuditBoard`); once the board exceeds 256 KiB it is streamed from
// the *head*, the rows that roll out of a 500-row window are archived by month
// with an idempotency key (`h`), and the line count is proven conserved before
// the main file is rewritten (fail-closed: on any doubt, no rewrite).
//
// Nothing here throws for IO failures: every function returns {ok, code}.
// `readLiveRow` is the only cross-module reader (live.js `liveGet`), and it is
// wrapped so a corrupt/locked row becomes a fail-closed `unreadable`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import { liveGet } from '../live.js';
import { isInsideRoot } from '../memory/paths.js';
import { safeSessionId } from '../identity/card-marker.js';
import { appendJsonLine } from '../util/append-store.js';
import {
  AUDIT_SCHEMA,
  HANDOFF_CARD_RETENTION_EXTRA_MS,
  HANDOFF_CLAIM_GRACE_MS,
  HANDOFF_DEFAULT_MAX_AGE_MS,
  HANDOFF_MAX_CLAIM_ATTEMPTS,
  HANDOFF_TRIM_ARCHIVE_TAIL_BYTES,
  HANDOFF_TRIM_MIN_INTERVAL_MS,
  charLengthOf,
  cardIdOf,
  hash8,
  lineHashOf,
} from './model.js';

export const BUNDLE_DIR = path.join('.longlive', 'bridge');
export const BOARD_DIR = path.join('.longlive', 'board');
export const LATEST_CARD_SUFFIX = '.handoff-card.json';
export const SESSION_CLAIM_SUFFIX = '.handoff.json';
export const CARD_CLAIM_PREFIX = 'handoff-claim-';
export const AUDIT_FILE_NAME = 'handoff.jsonl';
export const ARCHIVE_FILE_RE = /^handoff-(\d{6})\.jsonl$/;
export const LATEST_CARD_MAX_BYTES = 16 * 1024;
export const TRIM_CHUNK_BYTES = 256 * 1024;
export const TRIM_MAX_BYTES = 256 * 1024;
export const TRIM_WINDOW_ROWS = 500;
export const ARCHIVE_MAX_BATCH = 200;
export const AUDIT_TAIL_BYTES = 64 * 1024;
export const AUDIT_TAIL_LIMIT = 50;
export const PRUNE_LIMIT = 128;

const trimThrottle = new Map(); // memoryRoot -> last trim attempt (ms)

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function resolvedRoot(memoryRoot) {
  const raw = typeof memoryRoot === 'string' ? memoryRoot.trim() : '';
  if (raw === '') return null;
  try {
    return path.resolve(raw);
  } catch {
    return null;
  }
}

/** Resolve one derived file and prove it stays inside <memoryRoot>/.longlive. */
function inside(root, file) {
  if (root === null) return null;
  const resolved = path.resolve(file);
  try {
    if (!isInsideRoot(root, resolved)) return null;
  } catch {
    return null;
  }
  return resolved;
}

export function handoffBoardDir(memoryRoot) {
  const root = resolvedRoot(memoryRoot);
  return root === null ? null : inside(root, path.join(root, BOARD_DIR));
}

export function handoffAuditFile(memoryRoot) {
  const root = resolvedRoot(memoryRoot);
  return root === null ? null : inside(root, path.join(root, BOARD_DIR, AUDIT_FILE_NAME));
}

export function handoffArchiveFile(memoryRoot, monthKey) {
  const root = resolvedRoot(memoryRoot);
  const month = /^\d{6}$/.test(String(monthKey ?? '')) ? String(monthKey) : '000000';
  return root === null ? null : inside(root, path.join(root, BOARD_DIR, `handoff-${month}.jsonl`));
}

export function latestCardFile(memoryRoot, sessionId) {
  const root = resolvedRoot(memoryRoot);
  if (root === null) return null;
  const safe = safeSessionId(sessionId);
  return inside(root, path.join(root, BUNDLE_DIR, `${safe}${LATEST_CARD_SUFFIX}`));
}

export function sessionClaimFile(memoryRoot, sessionId) {
  const root = resolvedRoot(memoryRoot);
  if (root === null) return null;
  const safe = safeSessionId(sessionId);
  return inside(root, path.join(root, BUNDLE_DIR, `${safe}${SESSION_CLAIM_SUFFIX}`));
}

export function cardClaimFile(memoryRoot, cardId) {
  const root = resolvedRoot(memoryRoot);
  if (root === null) return null;
  const safe = String(cardId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return inside(root, path.join(root, BUNDLE_DIR, `${CARD_CLAIM_PREFIX}${safe}.json`));
}

export function monthKeyOf(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) return '000000';
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function hostname() {
  const name = os.hostname();
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'unknown-host';
}

function sameHost(host) {
  return typeof host === 'string' && host.trim().toLowerCase() === hostname().toLowerCase();
}

function pidAliveOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function isoOf(ms) {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/**
 * tmp + fsync + read-back + rename for one JSON document.
 * Read-back happens on the tmp file, before the rename, so a short write never
 * replaces the previous good file.
 */
function writeAtomicJson(file, value) {
  const dir = path.dirname(file);
  if (!ensureDir(dir)) return { ok: false, code: 'E_HANDOFF_WRITE' };
  const text = `${JSON.stringify(value)}\n`;
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (readText(tmp) !== text) {
      unlinkQuiet(tmp);
      return { ok: false, code: 'E_HANDOFF_WRITE_READBACK' };
    }
    fs.renameSync(tmp, file);
    return { ok: true, path: file, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    unlinkQuiet(tmp);
    return { ok: false, code: error?.code ?? 'E_HANDOFF_WRITE' };
  }
}

// ------------------------------------------------------------------ latest cards

/**
 * Read one per-session latest card. Bounded to 16 KiB; a missing file is
 * `{ok:true, present:false}`, a malformed/oversized one is `{ok:false}`.
 */
export function readLatestCard(memoryRoot, sessionId) {
  const file = latestCardFile(memoryRoot, sessionId);
  if (file === null) return { ok: false, present: false, code: 'E_HANDOFF_NO_ROOT' };
  const stat = statOrNull(file);
  if (stat === null) return { ok: true, present: false, file };
  if (!stat.isFile() || stat.size > LATEST_CARD_MAX_BYTES) {
    return { ok: false, present: true, file, code: 'E_HANDOFF_CORRUPT' };
  }
  const text = readText(file);
  if (text === null) return { ok: false, present: true, file, code: 'E_HANDOFF_READ' };
  let card;
  try {
    card = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, present: true, file, code: 'E_HANDOFF_CORRUPT' };
  }
  return { ok: true, present: true, file, card, sessionId };
}

/**
 * Read the newest N latest-card files. mtime-descending and bounded — the
 * consumer never reads the audit board or an unbounded directory.
 */
export function readLatestCards(memoryRoot, options = {}) {
  const root = resolvedRoot(memoryRoot);
  const dir = root === null ? null : inside(root, path.join(root, BUNDLE_DIR));
  if (dir === null) return { ok: false, code: 'E_HANDOFF_NO_ROOT', cards: [] };
  const maxFiles = clampInt(options.maxFiles, 64, 8, 256);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, cards: [], scanned: 0 };
    return { ok: false, code: error?.code === 'ENOENT' ? 'E_HANDOFF_READ' : 'E_HANDOFF_READ', cards: [] };
  }
  const candidates = [];
  for (const entry of names) {
    if (!entry.isFile() || !entry.name.endsWith(LATEST_CARD_SUFFIX)) continue;
    if (entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name);
    const stat = statOrNull(file);
    if (stat === null) continue;
    candidates.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const cards = [];
  let bad = 0;
  for (const candidate of candidates.slice(0, maxFiles)) {
    const fileSessionId = path.basename(candidate.file).slice(0, -LATEST_CARD_SUFFIX.length);
    if (candidate.size > LATEST_CARD_MAX_BYTES) {
      bad += 1;
      continue;
    }
    const text = readText(candidate.file);
    if (text === null) {
      bad += 1;
      continue;
    }
    let card;
    try {
      card = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      bad += 1;
      continue;
    }
    // gate 0's file-name check: the safe name we read must round-trip to the id
    // stored inside the card (a copy of someone else's card is not a candidate).
    if (safeSessionId(card?.source?.sessionId) !== fileSessionId) {
      bad += 1;
      continue;
    }
    cards.push({
      card,
      cardId: cardIdOf({ sessionId: card?.source?.sessionId, turn: card?.turn }),
      file: candidate.file,
      fileSessionId,
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
    });
  }
  return { ok: true, cards, scanned: candidates.length, bad };
}

/** Atomic tmp+fsync+read-back+rename write of one latest card. */
export function writeLatestCardAtomic(memoryRoot, card) {
  if (!card || typeof card !== 'object' || typeof card.source?.sessionId !== 'string') {
    return { ok: false, code: 'E_HANDOFF_WRITE' };
  }
  const file = latestCardFile(memoryRoot, card.source.sessionId);
  if (file === null) return { ok: false, code: 'E_HANDOFF_NO_ROOT' };
  return writeAtomicJson(file, card);
}

// ------------------------------------------------------------------ audit board

function appendRawLine(file, line) {
  const dir = path.dirname(file);
  if (!ensureDir(dir)) return { ok: false, code: 'E_HANDOFF_WRITE' };
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${line}\n`, null, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* best effort */ }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_HANDOFF_WRITE' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Append one audit row. No正文, no plaintext cwd — the caller builds the row.
 * Adds the M4 idempotency key `h`, then runs the throttled boundedness trim.
 */
export function appendAudit(memoryRoot, row) {
  const file = handoffAuditFile(memoryRoot);
  if (file === null) return { ok: false, code: 'E_HANDOFF_NO_ROOT' };
  let withHash;
  try {
    withHash = { ...row, h: lineHashOf(JSON.stringify(row)) };
  } catch {
    withHash = { ...row };
  }
  const result = appendJsonLine({ file, row: withHash, label: 'handoff', healthRoot: memoryRoot ?? undefined });
  try {
    maybeTrimAuditBoard(memoryRoot);
  } catch {
    /* trim is opportunistic; the append already happened */
  }
  return result;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** Read only the board's tail (panel/acceptance); never the whole file. */
export function readAuditTail(memoryRoot, options = {}) {
  const file = handoffAuditFile(memoryRoot);
  if (file === null) return { ok: false, present: false, rows: [], lines: 0, code: 'E_HANDOFF_NO_ROOT' };
  const stat = statOrNull(file);
  if (stat === null) return { ok: true, present: false, rows: [], lines: 0, file };
  if (!stat.isFile()) return { ok: false, present: false, rows: [], lines: 0, code: 'E_HANDOFF_READ' };
  const maxBytes = clampInt(options.maxBytes, AUDIT_TAIL_BYTES, 1024, 4 * 1024 * 1024);
  const limit = clampInt(options.limit, AUDIT_TAIL_LIMIT, 1, 500);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { ok: false, present: false, rows: [], lines: 0, code: 'E_HANDOFF_READ' };
  }
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const chunk = fs.readSync(fd, buffer, read, length - read, start + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    let bad = 0;
    const rows = [];
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (parsed === null) bad += 1;
      else rows.push(parsed);
    }
    return { ok: true, present: true, file, rows: rows.slice(-limit), lines: lines.length, bad, bytes: stat.size };
  } catch {
    return { ok: false, present: false, rows: [], lines: 0, code: 'E_HANDOFF_READ' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** Read only the month archive's tail and rebuild its idempotency-key set. */
export function readArchiveTail(memoryRoot, monthKey, options = {}) {
  const file = handoffArchiveFile(memoryRoot, monthKey);
  if (file === null) return { ok: false, rows: [], count: 0, code: 'E_HANDOFF_NO_ROOT' };
  const stat = statOrNull(file);
  if (stat === null) return { ok: true, file, rows: [], count: 0 };
  if (!stat.isFile()) return { ok: false, file, rows: [], count: 0, code: 'E_HANDOFF_READ' };
  const maxBytes = clampInt(options.maxBytes, HANDOFF_TRIM_ARCHIVE_TAIL_BYTES, 1024, 4 * 1024 * 1024);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { ok: false, file, rows: [], count: 0, code: 'E_HANDOFF_READ' };
  }
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const chunk = fs.readSync(fd, buffer, read, length - read, start + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    let count = 0;
    const rows = [];
    for (const line of lines) {
      count += 1;
      const parsed = parseJsonLine(line);
      const h = parsed && typeof parsed.h === 'string' && parsed.h !== '' ? parsed.h : lineHashOf(line);
      rows.push({ h });
    }
    return { ok: true, file, rows, count, bytes: stat.size };
  } catch {
    return { ok: false, file, rows: [], count: 0, code: 'E_HANDOFF_READ' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Full-stream index of one month archive: total line count + the set of
 * idempotency keys. Used when the cheap tail window cannot prove that a batch
 * was already archived (the tail-only check in the v4 design cannot prove
 * idempotency for batches older than the tail window, which is exactly the
 * "archive append succeeded, main rename failed" crash case). Bounded by
 * `maxBytes`; above it the caller must fail closed (no rewrite, retry later).
 */
export function readArchiveIndex(memoryRoot, monthKey, options = {}) {
  const file = handoffArchiveFile(memoryRoot, monthKey);
  if (file === null) return { ok: false, code: 'E_HANDOFF_NO_ROOT', keys: new Set(), count: 0 };
  const stat = statOrNull(file);
  if (stat === null) return { ok: true, file, keys: new Set(), count: 0, bytes: 0 };
  if (!stat.isFile()) return { ok: false, code: 'E_HANDOFF_READ', keys: new Set(), count: 0, file };
  const cap = clampInt(options.maxBytes, 32 * 1024 * 1024, 1024, 256 * 1024 * 1024);
  if (stat.size > cap) return { ok: false, code: 'E_HANDOFF_TRIM_ARCHIVE_UNVERIFIED', keys: new Set(), count: 0, file };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { ok: false, code: 'E_HANDOFF_READ', keys: new Set(), count: 0, file };
  }
  try {
    const buffer = Buffer.allocUnsafe(TRIM_CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    const keys = new Set();
    let count = 0;
    let carry = '';
    const pushLine = (line) => {
      const value = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (value.trim() === '') return;
      count += 1;
      const parsed = parseJsonLine(value);
      keys.add(parsed && typeof parsed.h === 'string' && parsed.h !== '' ? parsed.h : lineHashOf(value));
    };
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      position += read;
      carry += decoder.write(buffer.subarray(0, read));
      let newline = carry.indexOf('\n');
      while (newline !== -1) {
        pushLine(carry.slice(0, newline));
        carry = carry.slice(newline + 1);
        newline = carry.indexOf('\n');
      }
    }
    carry += decoder.end();
    if (carry.trim() !== '') pushLine(carry);
    return { ok: true, file, keys, count, bytes: stat.size };
  } catch {
    return { ok: false, code: 'E_HANDOFF_READ', keys: new Set(), count: 0, file };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Append archive lines with the M4 idempotency key. All keys already present →
 * nothing written; some present → only the missing ones; if the proof of
 * idempotency is unavailable → E_HANDOFF_TRIM_ARCHIVE_UNVERIFIED (the caller
 * must not rewrite the main file).
 *
 * The v4 tail-window guard is kept as the cheap first check; when it cannot
 * prove the batch (or cannot prove that new lines are really new), a bounded
 * full-archive index decides instead, so the V15 "archive appended, rename
 * crashed, re-run must not duplicate" case is genuinely idempotent.
 */
export function appendArchiveIdempotent(memoryRoot, monthKey, entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return { ok: true, appended: 0, idemSkipped: 0 };
  const file = handoffArchiveFile(memoryRoot, monthKey);
  if (file === null) return { ok: false, code: 'E_HANDOFF_NO_ROOT', appended: 0, idemSkipped: 0 };
  const tail = readArchiveTail(memoryRoot, monthKey, { maxBytes: options.tailBytes ?? HANDOFF_TRIM_ARCHIVE_TAIL_BYTES });
  if (!tail.ok) {
    return { ok: false, code: 'E_HANDOFF_TRIM_ARCHIVE_UNVERIFIED', appended: 0, idemSkipped: 0, file };
  }
  let known = new Set(tail.rows.map((row) => row.h));
  const allKnownByTail = list.every((entry) => known.has(entry.h));
  if (allKnownByTail) {
    return { ok: true, appended: 0, idemSkipped: list.length, file };
  }
  const index = readArchiveIndex(memoryRoot, monthKey, { maxBytes: options.fullScanMaxBytes });
  if (!index.ok) {
    return {
      ok: false,
      code: index.code === 'E_HANDOFF_READ' ? 'E_HANDOFF_TRIM_ARCHIVE_UNVERIFIED' : (index.code ?? 'E_HANDOFF_TRIM_ARCHIVE_UNVERIFIED'),
      appended: 0,
      idemSkipped: 0,
      file,
    };
  }
  known = index.keys;
  const missing = list.filter((entry) => !known.has(entry.h));
  if (missing.length === 0) {
    return { ok: true, appended: 0, idemSkipped: list.length, file };
  }
  let appended = 0;
  for (const chunk of chunkBy(missing, ARCHIVE_MAX_BATCH)) {
    const text = chunk.map((entry) => `${entry.line}\n`).join('');
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, text, null, 'utf8');
      try { fs.fsyncSync(fd); } catch { /* best effort */ }
      appended += chunk.length;
    } catch (error) {
      return { ok: false, code: error?.code ?? 'E_HANDOFF_WRITE', appended, idemSkipped: list.length - missing.length, file };
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  return { ok: true, appended, idemSkipped: list.length - missing.length, file };
}

function chunkBy(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

/**
 * N6/M4 trim: stream the whole board from the head in fixed chunks, keep the
 * last `windowRows` complete lines, archive the rolled-out lines by `at` month
 * (idempotent by `h`), prove `completeLines === archivedRows + kept`, then
 * tmp+fsync+read-back+rename the main file. Any doubt → no rewrite.
 */
export function trimAuditBoard(memoryRoot, options = {}) {
  const file = handoffAuditFile(memoryRoot);
  if (file === null) return { ok: false, trimmed: false, code: 'E_HANDOFF_NO_ROOT' };
  const stat = statOrNull(file);
  if (stat === null) return { ok: true, trimmed: false, skipped: true, reason: 'absent' };
  if (!stat.isFile()) return { ok: false, trimmed: false, code: 'E_HANDOFF_READ' };
  const windowRows = clampInt(options.windowRows, TRIM_WINDOW_ROWS, 100, 2000);
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();

  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { ok: false, trimmed: false, code: 'E_HANDOFF_READ' };
  }

  const ring = [];
  const overflowByMonth = new Map();
  let completeLines = 0;
  let parsed = 0;
  let bad = 0;
  let carry = '';
  const decoder = new StringDecoder('utf8');

  const pushLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') return;
    completeLines += 1;
    const obj = parseJsonLine(line);
    if (obj === null) bad += 1;
    else parsed += 1;
    const entry = {
      line,
      h: obj && typeof obj.h === 'string' && obj.h !== '' ? obj.h : lineHashOf(line),
    };
    ring.push(entry);
    while (ring.length > windowRows) {
      const out = ring.shift();
      const month = monthKeyOf(objForMonth(out.line, nowMs));
      if (!overflowByMonth.has(month)) overflowByMonth.set(month, []);
      overflowByMonth.get(month).push(out);
    }
  };

  try {
    const buffer = Buffer.allocUnsafe(TRIM_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      position += read;
      carry += decoder.write(buffer.subarray(0, read));
      let newline = carry.indexOf('\n');
      while (newline !== -1) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        pushLine(line);
        newline = carry.indexOf('\n');
      }
    }
    carry += decoder.end();
  } catch {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    return { ok: false, trimmed: false, code: 'E_HANDOFF_READ' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }

  const tailPartial = carry;
  const months = [...overflowByMonth.keys()].sort();
  let archivedRows = 0;
  let idemSkipped = 0;
  for (const month of months) {
    const entries = overflowByMonth.get(month);
    for (const batch of chunkBy(entries, ARCHIVE_MAX_BATCH)) {
      const archived = appendArchiveIdempotent(memoryRoot, month, batch);
      if (!archived.ok) {
        return {
          ok: false,
          trimmed: false,
          code: archived.code ?? 'E_HANDOFF_TRIM_ARCHIVE_UNVERIFIED',
          lines: completeLines,
          parsed,
          bad,
          archived: archivedRows,
          kept: ring.length,
          months,
          tailPartial: tailPartial !== '',
        };
      }
      archivedRows += batch.length;
      idemSkipped += archived.idemSkipped ?? 0;
    }
  }

  if (completeLines !== archivedRows + ring.length) {
    return {
      ok: false,
      trimmed: false,
      code: 'E_HANDOFF_TRIM_MISMATCH',
      lines: completeLines,
      parsed,
      bad,
      archived: archivedRows,
      kept: ring.length,
      months,
      tailPartial: tailPartial !== '',
    };
  }

  const body = ring.map((entry) => entry.line).join('\n');
  let expected = ring.length === 0
    ? tailPartial
    : `${body}\n${tailPartial}`;
  // The crashed tail is a half line. Terminate it before the `op:'trim'` audit
  // row is appended, otherwise the two would fuse into one corrupt line. The
  // partial bytes themselves are preserved exactly (newline appended after).
  if (tailPartial !== '') expected = `${expected}\n`;
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.trim-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  let tmpFd;
  try {
    tmpFd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(tmpFd, expected, null, 'utf8');
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    tmpFd = undefined;
    if (readText(tmp) !== expected) {
      unlinkQuiet(tmp);
      return { ok: false, trimmed: false, code: 'E_HANDOFF_TRIM_MISMATCH', lines: completeLines, parsed, bad, archived: archivedRows, kept: ring.length, months };
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    if (tmpFd !== undefined) {
      try { fs.closeSync(tmpFd); } catch { /* already closed */ }
    }
    unlinkQuiet(tmp);
    return { ok: false, trimmed: false, code: error?.code ?? 'E_HANDOFF_WRITE', lines: completeLines, parsed, bad, archived: archivedRows, kept: ring.length, months };
  }

  const result = {
    ok: true,
    trimmed: true,
    skipped: false,
    lines: completeLines,
    parsed,
    bad,
    archived: archivedRows,
    kept: ring.length,
    months,
    tailPartial: tailPartial !== '',
    idemSkipped,
    droppedPrefixBytes: 0,
  };
  try {
    appendAudit(memoryRoot, {
      schema: AUDIT_SCHEMA,
      op: 'trim',
      at: isoOf(nowMs),
      lines: completeLines,
      parsed,
      bad,
      archived: archivedRows,
      kept: ring.length,
      months,
      tailPartial: tailPartial !== '',
      idemSkipped,
      droppedPrefixBytes: 0,
    });
  } catch {
    /* the trim itself succeeded; a failed trim-audit row is not fatal */
  }
  return result;
}

function objForMonth(line, nowMs) {
  const parsed = parseJsonLine(line);
  if (parsed && typeof parsed.at === 'string') {
    const at = Date.parse(parsed.at);
    if (Number.isFinite(at)) return at;
  }
  return nowMs;
}

/**
 * Trigger point wired into every append (M4): only when the board exceeds
 * 256 KiB, at most once per `minIntervalMs` per memoryRoot.
 */
export function maybeTrimAuditBoard(memoryRoot, options = {}) {
  const file = handoffAuditFile(memoryRoot);
  if (file === null) return { ok: false, trimmed: false, skipped: true, reason: 'no-root' };
  const stat = statOrNull(file);
  if (stat === null) return { ok: true, trimmed: false, skipped: true, reason: 'absent' };
  if (stat.size <= TRIM_MAX_BYTES) return { ok: true, trimmed: false, skipped: true, reason: 'small' };
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const minInterval = clampInt(options.minIntervalMs, HANDOFF_TRIM_MIN_INTERVAL_MS, 0, 3_600_000);
  const root = resolvedRoot(memoryRoot) ?? '';
  const last = trimThrottle.get(root);
  if (last !== undefined && nowMs - last < minInterval) {
    return { ok: true, trimmed: false, skipped: true, reason: 'throttled' };
  }
  trimThrottle.set(root, nowMs);
  return trimAuditBoard(memoryRoot, {
    windowRows: options.windowRows,
    now: nowMs,
  });
}

/** Test/acceptance helper: forget the in-process trim throttle. */
export function resetTrimThrottle() {
  trimThrottle.clear();
}

// ------------------------------------------------------------------ claims

function createExclusive(file, body) {
  const dir = path.dirname(file);
  if (!ensureDir(dir)) return { ok: false, code: 'E_HANDOFF_CLAIM' };
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return { ok: false, code: 'E_ALREADY_CLAIMED' };
    return { ok: false, code: error?.code ?? 'E_HANDOFF_CLAIM' };
  }
  try {
    fs.writeSync(fd, `${JSON.stringify(body)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
    return { ok: true, path: file };
  } catch (error) {
    unlinkQuiet(file);
    return { ok: false, code: error?.code ?? 'E_HANDOFF_CLAIM' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function readClaim(file) {
  const text = readText(file);
  if (text === null) return { ok: false, code: 'E_HANDOFF_READ' };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return { ok: false, code: 'E_HANDOFF_CORRUPT' };
    return { ok: true, value };
  } catch {
    return { ok: false, code: 'E_HANDOFF_CORRUPT' };
  }
}

function rewriteClaim(file, value) {
  return writeAtomicJson(file, value);
}

/** Per-session claim (unique gate; never auto-reclaimed). */
export function claimSession(memoryRoot, sessionId, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const file = sessionClaimFile(memoryRoot, sessionId);
  if (file === null) return { ok: false, code: 'E_HANDOFF_NO_ROOT' };
  const created = createExclusive(file, {
    v: 3,
    kind: 'session',
    sessionId,
    pid: process.pid,
    host: hostname(),
    state: 'claimed',
    claimedAt: isoOf(nowMs),
  });
  if (!created.ok) return created;
  return {
    ok: true,
    path: file,
    sessionId,
    pid: process.pid,
    host: hostname(),
    claimedAt: nowMs,
  };
}

export function finalizeSessionClaim(claim, options = {}) {
  if (!claim?.ok || typeof claim.path !== 'string') return { ok: false, code: 'E_HANDOFF_NO_CLAIM' };
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const body = {
    v: 3,
    kind: 'session',
    sessionId: claim.sessionId,
    pid: claim.pid ?? process.pid,
    host: claim.host ?? hostname(),
    state: 'injected',
    cardId: options.cardId ?? null,
    sourceSessionId: options.sourceSessionId ?? null,
    chars: Number.isInteger(options.chars) ? options.chars : null,
    claimedAt: isoOf(claim.claimedAt),
    at: isoOf(nowMs),
  };
  const written = rewriteClaim(claim.path, body);
  return written.ok ? { ok: true, path: claim.path } : { ok: false, code: written.code ?? 'E_HANDOFF_FINALIZE' };
}

export function releaseSessionClaim(claim) {
  if (!claim?.ok || typeof claim.path !== 'string') return { ok: false, code: 'E_HANDOFF_NO_CLAIM' };
  return { ok: unlinkQuiet(claim.path) };
}

/**
 * M5 fallback for an unreadable (empty/half) per-card claim: the card is gone
 * or expired, and the claim file is older than the grace window → reclaim it.
 */
export function recoverUnreadableCardClaim(file, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : HANDOFF_DEFAULT_MAX_AGE_MS;
  const cardAtMs = Number.isFinite(options.cardAtMs) ? options.cardAtMs : 0;
  const cardFile = typeof options.cardFile === 'string' ? options.cardFile : null;
  const stat = statOrNull(file);
  if (stat === null) return { ok: true, deleted: false, reason: 'absent' };
  if (nowMs - stat.mtimeMs <= HANDOFF_CLAIM_GRACE_MS) {
    return { ok: true, deleted: false, reason: 'too-new' };
  }
  const cardGone = cardFile === null || statOrNull(cardFile) === null;
  const cardExpired = cardAtMs + maxAgeMs + HANDOFF_CARD_RETENTION_EXTRA_MS < nowMs;
  if (!cardGone && !cardExpired) {
    return { ok: true, deleted: false, reason: 'card-valid' };
  }
  return { ok: unlinkQuiet(file), deleted: true, reason: cardGone ? 'card-gone' : 'card-expired' };
}

/** Per-card claim with pid/empty-body recovery (N2 + M5). */
export function claimCard(memoryRoot, cardId, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  let file = cardClaimFile(memoryRoot, cardId);
  if (file === null) return { ok: false, code: 'E_HANDOFF_NO_ROOT' };
  const bodyOf = (sessionId) => ({
    v: 3,
    kind: 'card',
    cardId,
    sessionId,
    pid: process.pid,
    host: hostname(),
    state: 'claimed',
    claimedAt: isoOf(nowMs),
  });
  const created = createExclusive(file, bodyOf(options.sessionId ?? null));
  if (created.ok) {
    return { ok: true, path: file, cardId, pid: process.pid, host: hostname(), claimedAt: nowMs };
  }
  if (created.code !== 'E_ALREADY_CLAIMED') return created;

  const existing = readClaim(file);
  if (!existing.ok) {
    const recovered = recoverUnreadableCardClaim(file, {
      now: nowMs,
      cardAtMs: options.cardAtMs,
      maxAgeMs: options.maxAgeMs,
      cardFile: options.cardFile,
    });
    if (!recovered.deleted) return { ok: false, code: 'E_ALREADY_CLAIMED' };
    const retried = createExclusive(file, bodyOf(options.sessionId ?? null));
    if (!retried.ok) return retried;
    return { ok: true, path: file, cardId, pid: process.pid, host: hostname(), claimedAt: nowMs };
  }
  const value = existing.value;
  if (value.state === 'injected') return { ok: false, code: 'E_ALREADY_CLAIMED' };
  const claimedAtMs = Date.parse(String(value.claimedAt ?? ''));
  if (value.state === 'claimed'
    && sameHost(value.host)
    && pidAliveOf(value.pid) === false
    && Number.isFinite(claimedAtMs)
    && nowMs - claimedAtMs > HANDOFF_CLAIM_GRACE_MS) {
    if (unlinkQuiet(file)) {
      const retried = createExclusive(file, bodyOf(options.sessionId ?? null));
      if (!retried.ok) return retried;
      return { ok: true, path: file, cardId, pid: process.pid, host: hostname(), claimedAt: nowMs };
    }
  }
  return { ok: false, code: 'E_ALREADY_CLAIMED' };
}

/** Before splicing: record that the message may already be in the payload. */
export function markCardSpliced(claim, options = {}) {
  if (!claim?.ok || typeof claim.path !== 'string') return { ok: false, code: 'E_HANDOFF_NO_CLAIM' };
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const body = {
    v: 3,
    kind: 'card',
    cardId: claim.cardId,
    sessionId: claim.sessionId ?? options.sessionId ?? null,
    pid: claim.pid ?? process.pid,
    host: claim.host ?? hostname(),
    state: 'spliced',
    claimedAt: isoOf(claim.claimedAt),
    splicedAt: isoOf(nowMs),
  };
  const written = rewriteClaim(claim.path, body);
  return written.ok ? { ok: true, path: claim.path } : { ok: false, code: written.code ?? 'E_HANDOFF_WRITE' };
}

export function finalizeCardClaim(claim, options = {}) {
  if (!claim?.ok || typeof claim.path !== 'string') return { ok: false, code: 'E_HANDOFF_NO_CLAIM' };
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const body = {
    v: 3,
    kind: 'card',
    cardId: claim.cardId,
    sessionId: claim.sessionId ?? options.sessionId ?? null,
    pid: claim.pid ?? process.pid,
    host: claim.host ?? hostname(),
    state: 'injected',
    claimedAt: isoOf(claim.claimedAt),
    at: isoOf(nowMs),
  };
  const written = rewriteClaim(claim.path, body);
  return written.ok ? { ok: true, path: claim.path } : { ok: false, code: written.code ?? 'E_HANDOFF_FINALIZE' };
}

export function releaseCardClaim(claim) {
  if (!claim?.ok || typeof claim.path !== 'string') return { ok: false, code: 'E_HANDOFF_NO_CLAIM' };
  return { ok: unlinkQuiet(claim.path) };
}

// ------------------------------------------------------------------ prune

function listClaimFiles(memoryRoot) {
  const root = resolvedRoot(memoryRoot);
  const dir = root === null ? null : inside(root, path.join(root, BUNDLE_DIR));
  if (dir === null) return { card: [], session: [], dir: null };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { card: [], session: [], dir };
  }
  const card = [];
  const session = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith(CARD_CLAIM_PREFIX) && entry.name.endsWith('.json')) {
      card.push(path.join(dir, entry.name));
    } else if (entry.name.endsWith(SESSION_CLAIM_SUFFIX)) {
      session.push(path.join(dir, entry.name));
    }
  }
  return { card, session, dir };
}

/** Collect the card ids that still have a readable latest card on disk. */
function existingCardIds(memoryRoot) {
  const root = resolvedRoot(memoryRoot);
  const bundle = root === null ? null : inside(root, path.join(root, BUNDLE_DIR));
  const ids = new Set();
  if (bundle === null) return ids;
  let entries;
  try {
    entries = fs.readdirSync(bundle, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(LATEST_CARD_SUFFIX) || entry.name.startsWith('.')) continue;
    const file = path.join(bundle, entry.name);
    const stat = statOrNull(file);
    if (stat === null || stat.size > LATEST_CARD_MAX_BYTES) continue;
    const text = readText(file);
    if (text === null) continue;
    try {
      const card = JSON.parse(text);
      ids.add(cardIdOf({ sessionId: card?.source?.sessionId, turn: card?.turn }));
    } catch {
      /* corrupt card: no id */
    }
  }
  return ids;
}

/**
 * Clean per-card claims for expired cards / dead owners; per-session claims are
 * reported only (never auto-deleted). Unreadable card claims follow the M5 rule.
 */
export function pruneClaims(memoryRoot, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : HANDOFF_DEFAULT_MAX_AGE_MS;
  const limit = clampInt(options.limit, PRUNE_LIMIT, 1, 500);
  const { card: cardFiles, session: sessionFiles } = listClaimFiles(memoryRoot);
  const liveIds = existingCardIds(memoryRoot);
  let scanned = 0;
  let deleted = 0;
  let errors = 0;
  let reported = 0;
  for (const file of cardFiles) {
    if (scanned >= limit) break;
    scanned += 1;
    const stat = statOrNull(file);
    if (stat === null) continue;
    const cardId = path.basename(file).slice(CARD_CLAIM_PREFIX.length, -'.json'.length);
    const existing = readClaim(file);
    if (!existing.ok) {
      const expired = stat.mtimeMs + maxAgeMs + HANDOFF_CARD_RETENTION_EXTRA_MS < nowMs;
      if (!liveIds.has(cardId) || expired) {
        if (unlinkQuiet(file)) deleted += 1;
        else errors += 1;
      }
      continue;
    }
    const value = existing.value;
    const claimedAtMs = Date.parse(String(value.claimedAt ?? ''));
    const expired = Number.isFinite(claimedAtMs) && claimedAtMs + maxAgeMs + HANDOFF_CARD_RETENTION_EXTRA_MS < nowMs;
    const deadOwner = value.state === 'claimed' && sameHost(value.host) && pidAliveOf(value.pid) === false;
    if (value.state === 'claimed' && (expired || deadOwner)) {
      if (unlinkQuiet(file)) deleted += 1;
      else errors += 1;
    } else if (value.state === 'spliced' || value.state === 'injected') {
      reported += 1;
    }
  }
  reported += sessionFiles.length;
  return { ok: true, kind: 'claims', scanned, deleted, errors, reported };
}

/** Delete latest cards past `maxAge + 24h` (and their per-card claim). */
export function pruneCards(memoryRoot, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : HANDOFF_DEFAULT_MAX_AGE_MS;
  const limit = clampInt(options.limit, PRUNE_LIMIT, 1, 500);
  const root = resolvedRoot(memoryRoot);
  const bundle = root === null ? null : inside(root, path.join(root, BUNDLE_DIR));
  if (bundle === null) return { ok: true, kind: 'cards', scanned: 0, deleted: 0, errors: 0 };
  let entries;
  try {
    entries = fs.readdirSync(bundle, { withFileTypes: true });
  } catch {
    return { ok: true, kind: 'cards', scanned: 0, deleted: 0, errors: 0 };
  }
  let scanned = 0;
  let deleted = 0;
  let errors = 0;
  for (const entry of entries) {
    if (scanned >= limit) break;
    if (!entry.isFile() || !entry.name.endsWith(LATEST_CARD_SUFFIX) || entry.name.startsWith('.')) continue;
    scanned += 1;
    const file = path.join(bundle, entry.name);
    const stat = statOrNull(file);
    if (stat === null) continue;
    const text = readText(file);
    let card = null;
    if (text !== null) {
      try {
        card = JSON.parse(text);
      } catch {
        card = null;
      }
    }
    const atMs = Date.parse(String(card?.at ?? ''));
    const expired = !Number.isFinite(atMs) || atMs + maxAgeMs + HANDOFF_CARD_RETENTION_EXTRA_MS < nowMs;
    if (!expired) continue;
    if (!unlinkQuiet(file)) {
      errors += 1;
      continue;
    }
    deleted += 1;
    if (card && typeof card.source?.sessionId === 'string') {
      const claim = cardClaimFile(memoryRoot, cardIdOf({ sessionId: card.source.sessionId, turn: card.turn }));
      if (claim !== null) unlinkQuiet(claim);
    }
  }
  return { ok: true, kind: 'cards', scanned, deleted, errors };
}

// ------------------------------------------------------------------ live row

/**
 * Read one session's live row for the liveness gate. Everything that cannot be
 * read (corrupt JSON, symlink, locked file) becomes `unreadable` → skip.
 */
export function readLiveRow(memoryRoot, sessionId, options = {}) {
  const root = resolvedRoot(memoryRoot);
  if (root === null) return { status: 'unreadable', code: 'E_HANDOFF_NO_ROOT' };
  const canonical = String(sessionId ?? '').trim().toLowerCase();
  if (canonical === '') return { status: 'unreadable', code: 'E_HANDOFF_LIVE_UNREADABLE' };
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  try {
    const got = liveGet({ sessionId: canonical }, { memoryRoot: root, now: new Date(nowMs) });
    if (got?.status === 'absent') return { status: 'absent', file: got.file ?? null };
    if (!got?.ok || !got.live) {
      return { status: 'unreadable', code: 'E_HANDOFF_LIVE_UNREADABLE' };
    }
    return { status: 'ok', live: got.live, file: got.file ?? null };
  } catch (error) {
    return { status: 'unreadable', code: error?.code ?? 'E_HANDOFF_LIVE_UNREADABLE', message: String(error?.message ?? error) };
  }
}

// ------------------------------------------------------------------ board read model (§10)

function within24h(row, nowMs) {
  const at = Date.parse(String(row?.at ?? ''));
  return Number.isFinite(at) && nowMs - at <= 24 * 3600 * 1000 && nowMs - at >= -60_000;
}

/**
 * The `/api/longlive/board` handoff segment: tail rows (no prose), 24h counters
 * and a card summary. Never returns goal text or a plaintext cwd.
 */
export function readHandoffBoard(memoryRoot, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const limit = clampInt(options.limit, AUDIT_TAIL_LIMIT, 1, 200);
  const tail = readAuditTail(memoryRoot, { limit, maxBytes: AUDIT_TAIL_BYTES });
  const rows = Array.isArray(tail.rows) ? tail.rows : [];
  const counts = { written24h: 0, injected24h: 0, skipped24h: 0, claims24h: 0, intentInjected24h: 0 };
  for (const row of rows) {
    if (!within24h(row, nowMs)) continue;
    if (row.op === 'write') counts.written24h += 1;
    else if (row.op === 'inject') {
      counts.injected24h += 1;
      if (row?.gates?.relevance?.kind === 'intent') counts.intentInjected24h += 1;
    } else if (row.op === 'skip') counts.skipped24h += 1;
    else if (row.op === 'claim') counts.claims24h += 1;
  }
  const listed = readLatestCards(memoryRoot, { maxFiles: 64 });
  const cards = (listed.ok ? listed.cards : []).map((entry) => {
    const card = entry.card;
    const goal = typeof card?.goal === 'string' ? card.goal : '';
    return {
      sessionId: card?.source?.sessionId ?? '',
      cardId: entry.cardId,
      at: card?.at ?? null,
      turn: Number.isInteger(card?.turn) ? card.turn : null,
      cwdHash: typeof card?.source?.cwdHash === 'string' ? card.source.cwdHash : '',
      goalChars: charLengthOf(goal),
      goalHash: hash8(goal),
      decidedN: Array.isArray(card?.decided) ? card.decided.length : 0,
    };
  });
  return {
    present: tail.present === true || cards.length > 0,
    rows: rows.map(stripRowForPanel),
    counts,
    cards,
    badLines: Number.isInteger(tail.bad) ? tail.bad : 0,
  };
}

/** Defense in depth: the panel/API never receives prose or a plaintext cwd. */
function stripRowForPanel(row) {
  if (!row || typeof row !== 'object') return row;
  const { goal, goalPreview, cwd, text, ...rest } = row;
  void goal; void goalPreview; void cwd; void text;
  return rest;
}

export { HANDOFF_MAX_CLAIM_ATTEMPTS };
