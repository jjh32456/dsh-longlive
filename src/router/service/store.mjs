// WP3 durable proposal store.
//
// DESIGN §3.1/§3.2 put everything derived under `<vault>/proposals/`; this
// module owns the file-level half of that contract:
//   - strict atomic JSON write (tmp -> fsync -> rename -> read-back byte/sha)
//   - proposal directory scan / read-by-id / non-terminal quota
//   - append-only WAL lines used by the ticket allocator
//   - queue.json read-back (the queue view is derived; the WAL wins)
//
// It never creates a directory unless a write is requested, so the default-off
// surface (routerEnabled=false, routerProposalEnabled=false) keeps zero disk
// side effects. Arithmetic lives in proposals.mjs, not here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureDir, sha256Hex } from './paths.mjs';

export const PROPOSAL_VERSION = 1;
export const PROPOSAL_FILE_MAX_BYTES = 16 * 1024; // DESIGN §3.3: 单文件 ≤16 KB（content 4,000 字 + 元数据）
export const PROPOSAL_TARGET_MAX_BYTES = 256 * 1024;
export const QUEUE_MAX_BYTES = 64 * 1024;
export const QUEUE_MAX_ENTRIES = 200;

export const PROPOSAL_ID_RE = /^p-\d{8}T\d{6}-[0-9a-f]{6}$/u;

export const PROPOSAL_STATUSES = Object.freeze([
  'pending',
  // Legacy 1.1.0 alias. New proposals are written as `pending`, but a vault
  // produced by 1.1.0 must stay readable after an in-place upgrade.
  'queued',
  'approved',
  'applying',
  'blocked-on-user',
  'done',
  'rejected',
  'conflict',
  'superseded',
  'rolled_back',
  'cancelled',
  'expired',
]);

export const TERMINAL_PROPOSAL_STATUSES = Object.freeze([
  'done',
  'rejected',
  'conflict',
  'superseded',
  'rolled_back',
  'cancelled',
  'expired',
]);

const TERMINAL = new Set(TERMINAL_PROPOSAL_STATUSES);

export function isTerminalProposalStatus(status) {
  return TERMINAL.has(status);
}

export class StoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.name = 'StoreError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function readText(file) {
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return { ok: false, error: error?.code ?? 'E_READ', message: error?.message ?? String(error) };
  }
}

/**
 * Strict durable JSON write. Unlike paths.writeJsonAtomic this verifies the
 * FINAL path after rename and throws `E_STORE_READBACK` when the bytes on disk
 * no longer match what was written (DESIGN §5.3 already-write detection).
 */
export function writeJsonStrict(file, value, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 5;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  const digest = sha256Hex(text);
  const dir = path.dirname(file);
  if (!ensureDir(dir)) throw new StoreError('E_STORAGE', `cannot create ${dir}`, { file });
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        try { fs.fsyncSync(fd); } catch { /* fsync is best effort on some filesystems */ }
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      fs.renameSync(tmp, file);
      const back = readText(file);
      if (!back.ok || back.text !== text || Buffer.byteLength(back.text, 'utf8') !== bytes || sha256Hex(back.text) !== digest) {
        throw new StoreError('E_STORE_READBACK', `read-back mismatch for ${file}`, { file, bytes, sha256: digest });
      }
      return { ok: true, file, bytes, sha256: digest };
    } catch (error) {
      lastError = error;
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      if (error?.code === 'E_STORE_READBACK') break;
    }
  }
  throw lastError instanceof StoreError
    ? lastError
    : new StoreError(lastError?.code ?? 'E_STORAGE', lastError?.message ?? String(lastError ?? 'write failed'), {
      file,
      bytes,
      sha256: digest,
    });
}

/**
 * D-CR13: the 16 KB cap is on the COMPLETE serialized proposal JSON, not just
 * `content`. Both the write path and the read path enforce it.
 */
export function writeProposalFile(file, value, options = {}) {
  const { __file, ...clean } = value ?? {};
  const text = `${JSON.stringify(clean, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > PROPOSAL_FILE_MAX_BYTES) {
    throw new StoreError('E_CONTENT_TOO_LARGE', `proposal JSON exceeds ${PROPOSAL_FILE_MAX_BYTES} bytes`, {
      file,
      limit: PROPOSAL_FILE_MAX_BYTES,
      actual: bytes,
    });
  }
  return writeJsonStrict(file, clean, options);
}

// R-02: cross-process compare-and-write. `<proposalsDir>/<id>.lock` is an
// inter-process mutex created with open(wx) (never a rename), so two writers
// can never both believe they own the read-check-write window. Lock holders
// that are provably gone (same-host dead pid, or a foreign-host lock older than
// the stale threshold) are moved to an evidence file, then the CAS is repeated.
const PROPOSAL_LOCK_STALE_MS = 5_000;
const PROPOSAL_LOCK_WAIT_MS = 2_000;
const PROPOSAL_LOCK_BACKOFF_MS = 25;

function sleepMs(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* bounded busy wait fallback */ }
  }
}

function localPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockRecord(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function lockIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  return [value.pid ?? '', value.host ?? '', value.nonce ?? '', value.startedAt ?? ''].join('|');
}

function proposalLockIsStale(file, holder, staleMs) {
  let stat = null;
  try { stat = fs.statSync(file); } catch { return true; }
  if (!(Date.now() - stat.mtimeMs > staleMs)) return false;
  if (!holder) return true; // unreadable payload that is already old
  const host = typeof holder.host === 'string' && holder.host !== '' ? holder.host : os.hostname();
  if (host === os.hostname()) return !localPidAlive(holder.pid);
  // A foreign host cannot be probed for pid liveness; age is the only evidence.
  return true;
}

/** Rename the observed stale lock out of the way, then verify the moved bytes. */
function reclaimProposalLock(file, observed) {
  const evidence = `${file}.reclaimed-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(file, evidence);
  } catch {
    return false;
  }
  const moved = readLockRecord(evidence);
  if (lockIdentity(moved) !== lockIdentity(observed)) {
    // A fresh holder raced in between; put its bytes back when the path is free.
    try {
      if (!fs.existsSync(file)) fs.renameSync(evidence, file);
    } catch { /* leave the evidence file; the owner still holds its own bytes */ }
    return false;
  }
  return true;
}

/**
 * Acquire `<proposalsDir>/<id>.lock` with open(wx), write+fsync+close, then read
 * back our own nonce. On contention wait in 25 ms steps for at most 2 s; stale
 * holders are reclaimed with a rename-to-evidence first. Failure to win the lock
 * is `E_STORAGE` with `retryable:true` (never a crash, never a silent write).
 */
function acquireProposalLock(proposalsDir, id, options = {}) {
  const file = proposalLockPath(proposalsDir, id);
  const waitMs = Number.isInteger(options.lockWaitMs) ? options.lockWaitMs : PROPOSAL_LOCK_WAIT_MS;
  const staleMs = Number.isInteger(options.lockStaleMs) ? options.lockStaleMs : PROPOSAL_LOCK_STALE_MS;
  const backoffMs = Number.isInteger(options.lockBackoffMs) ? options.lockBackoffMs : PROPOSAL_LOCK_BACKOFF_MS;
  const token = {
    pid: process.pid,
    host: os.hostname(),
    nonce: crypto.randomBytes(12).toString('hex'),
    startedAt: new Date().toISOString(),
  };
  if (!ensureDir(proposalsDir)) {
    throw new StoreError('E_STORAGE', `cannot create ${proposalsDir}`, { id, retryable: true });
  }
  const deadline = Date.now() + Math.max(0, waitMs);

  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new StoreError('E_STORAGE', `cannot lock proposal ${id}`, {
          id,
          cause: error?.code ?? 'E_LOCK',
          retryable: true,
        });
      }
      const holder = readLockRecord(file);
      if (proposalLockIsStale(file, holder, staleMs) && reclaimProposalLock(file, holder)) continue;
      if (Date.now() >= deadline) {
        throw new StoreError('E_STORAGE', `proposal ${id} is locked by another process`, {
          id,
          lock: holder ?? null,
          retryable: true,
        });
      }
      sleepMs(backoffMs);
      continue;
    }

    try {
      fs.writeFileSync(fd, `${JSON.stringify(token)}\n`, 'utf8');
      try { fs.fsyncSync(fd); } catch { /* fsync is best effort on some filesystems */ }
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(file); } catch { /* wx means these are our own bytes */ }
      throw new StoreError('E_STORAGE', `cannot write proposal lock ${id}`, {
        id,
        cause: error?.code ?? 'E_LOCK_WRITE',
        retryable: true,
      });
    }
    try { fs.closeSync(fd); } catch { /* ignore */ }

    const back = readLockRecord(file);
    if (!back || back.nonce !== token.nonce || lockIdentity(back) !== lockIdentity(token)) {
      // Our lock was reclaimed or replaced while we were writing: never unlink
      // a path we can no longer prove is ours.
      throw new StoreError('E_STORAGE', `proposal lock ${id} changed hands`, { id, retryable: true });
    }
    return { file, token };
  }
}

function releaseProposalLock(handle) {
  if (!handle || !handle.file || !handle.token) return false;
  const holder = readLockRecord(handle.file);
  if (!holder || holder.nonce !== handle.token.nonce || holder.pid !== handle.token.pid) return false;
  try {
    fs.unlinkSync(handle.file);
    return true;
  } catch {
    return false;
  }
}

export function proposalLockPath(proposalsDir, id) {
  return path.join(proposalsDir, `${id}.lock`);
}

/**
 * D-CR7 + R-02: every proposal write point goes through one compare-then-write
 * helper under an inter-process mutex. `expectedRev` is the rev the caller read;
 * a mismatch is E_STATE_RACE and the file is left untouched. Callers retry with
 * a fresh read (bounded). Lock acquisition failure is a retryable E_STORAGE.
 */
export function updateProposalStrict(proposalsDir, id, expectedRev, mutate, options = {}) {
  if (typeof proposalsDir !== 'string' || proposalsDir === ''
    || typeof id !== 'string' || !PROPOSAL_ID_RE.test(id)) {
    throw new StoreError('E_TICKET_UNKNOWN', `proposal not found: ${id}`, { id });
  }
  let dirExists = false;
  try { dirExists = fs.statSync(proposalsDir).isDirectory(); } catch { dirExists = false; }
  if (!dirExists) throw new StoreError('E_TICKET_UNKNOWN', `proposal not found: ${id}`, { id });

  const lock = acquireProposalLock(proposalsDir, id, options);
  try {
    const current = readProposal(proposalsDir, id);
    if (!current) throw new StoreError('E_TICKET_UNKNOWN', `proposal not found: ${id}`, { id });
    const { __file, ...base } = current;
    if (expectedRev !== null && expectedRev !== undefined && base.rev !== expectedRev) {
      throw new StoreError('E_STATE_RACE', 'proposal changed since it was read', {
        id,
        rev: base.rev ?? null,
        expectedRev,
      });
    }
    const patch = typeof mutate === 'function' ? (mutate({ ...base }) ?? {}) : (mutate ?? {});
    const now = options.now instanceof Date ? options.now : (typeof options.now === 'function' ? options.now() : new Date());
    const next = {
      ...base,
      ...patch,
      rev: (base.rev ?? 0) + 1,
      updatedAt: now.toISOString(),
    };
    writeProposalFile(path.join(proposalsDir, `${id}.json`), next, options);
    return next;
  } finally {
    releaseProposalLock(lock);
  }
}

function readProposalValue(file, invalid) {
  const read = readText(file);
  if (!read.ok) {
    invalid.push({ file, error: read.error });
    return null;
  }
  if (Buffer.byteLength(read.text, 'utf8') > PROPOSAL_FILE_MAX_BYTES) {
    invalid.push({ file, error: 'E_CONTENT_TOO_LARGE' });
    return null;
  }
  let value = null;
  try {
    value = JSON.parse(read.text);
  } catch (error) {
    invalid.push({ file, error: 'E_PARSE', message: error?.message ?? String(error) });
    return null;
  }
  if (!value || typeof value !== 'object' || value.v !== PROPOSAL_VERSION
    || typeof value.id !== 'string' || !PROPOSAL_ID_RE.test(value.id)
    || typeof value.status !== 'string' || !PROPOSAL_STATUSES.includes(value.status)
    || !value.queue || typeof value.queue.ticket !== 'string') {
    invalid.push({ file, error: 'E_INVALID_PROPOSAL' });
    return null;
  }
  return value;
}

/**
 * Scan `<vault>/proposals/*.json`. Missing directory = empty result, never an
 * error and never a directory creation. Invalid files are counted and skipped,
 * never deleted or rewritten (DESIGN F17).
 */
export function scanProposalDir(dir) {
  if (typeof dir !== 'string' || dir === '') return { proposals: [], invalid: [], files: [] };
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return { proposals: [], invalid: [], files: [] };
    return { proposals: [], invalid: [{ file: dir, error: error?.code ?? 'E_READ' }], files: [] };
  }
  const proposals = [];
  const invalid = [];
  const files = [];
  for (const name of names) {
    const file = path.join(dir, name);
    files.push(file);
    const value = readProposalValue(file, invalid);
    if (value) proposals.push({ ...value, __file: file });
  }
  proposals.sort((a, b) => {
    const at = Date.parse(a.createdAt ?? '');
    const bt = Date.parse(b.createdAt ?? '');
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  });
  return { proposals, invalid, files };
}

/** Read one proposal by id; ids are validated so `../` can never escape. */
export function readProposal(dir, id) {
  if (typeof id !== 'string' || !PROPOSAL_ID_RE.test(id)) return null;
  const file = path.join(dir, `${id}.json`);
  const invalid = [];
  const value = readProposalValue(file, invalid);
  return value ? { ...value, __file: file } : null;
}

export function countNonTerminal(proposals) {
  return (Array.isArray(proposals) ? proposals : []).filter((p) => !isTerminalProposalStatus(p?.status)).length;
}

/** Append one JSON line and fsync it before returning (WAL ordering contract). */
export function appendJsonLineDurable(file, value) {
  const dir = path.dirname(file);
  if (!ensureDir(dir)) throw new StoreError('E_STORAGE', `cannot create ${dir}`, { file });
  const line = `${JSON.stringify(value)}\n`;
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, line, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* best effort */ }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return { bytes: Buffer.byteLength(line, 'utf8'), sha256: sha256Hex(line) };
}

export function readWalLines(file) {
  const read = readText(file);
  if (!read.ok) return { lines: [], error: read.error };
  const lines = [];
  for (const raw of read.text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object') lines.push(value);
    } catch {
      /* WP3 does not own WAL recovery; WP4 replays and marks wal.corrupt */
    }
  }
  return { lines };
}

export function readQueueFile(file) {
  const read = readText(file);
  if (!read.ok) return null;
  try {
    const value = JSON.parse(read.text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function readTargetSnapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { ok: false, code: 'E_PATH_DENIED', message: 'target is a symlink' };
    if (!stat.isFile()) return { ok: false, code: 'E_PATH_DENIED', message: 'target is not a regular file' };
    if (stat.size > PROPOSAL_TARGET_MAX_BYTES) {
      return { ok: false, code: 'E_CONTENT_TOO_LARGE', message: 'target exceeds 256 KB' };
    }
    const text = fs.readFileSync(file, 'utf8');
    return {
      ok: true,
      exists: true,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha256Hex(text),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, exists: false, bytes: 0, sha256: null };
    return { ok: false, code: error?.code === 'EACCES' ? 'E_PATH_DENIED' : 'E_STORAGE', message: error?.message };
  }
}
