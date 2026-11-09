// src/util/append-store.js — S1（rc.7 整合线）：统一的追加写封装。
//
// 目标（审计报告 P1-10）：
//   * 单写锁：每个 append 目标一个 `<file>.lock` 租约（holder + pid + acquiredAt +
//     expiresAt，复用 src/memory/lock.js 的 O_EXCL 语义），过期可接管；
//   * fsync：写入后 fsync，崩溃不丢已确认的行；
//   * 坏行隔离：追加前检查文件尾，遇到半行/坏 JSON 尾先搬到 quarantine 目录并告警，
//     再把文件截到最后一条完整行，绝不把新行接在坏行后面；
//   * 结构化错误：永不抛出；失败返回 `{ok:false, code, error:{code,message}}`；
//   * 失败不再静默：logger.warn + 进程内计数，并（在提供 healthRoot 时）把计数写进
//     `.longlive/metrics/write-health.json`（面板 #9 write-health 路由可读）。
//
// 该模块只做文件 IO，不持有业务语义；业务行格式由调用方决定（一行一个 JSON）。

import fs from 'node:fs';
import path from 'node:path';

import { acquireLease, releaseLease } from '../memory/lock.js';

export const APPEND_STORE_SCHEMA = 'append-store/v1';
export const DEFAULT_APPEND_LOCK_TTL_MS = 30_000;
export const DEFAULT_APPEND_LOCK_WAIT_MS = 3_000;
export const DEFAULT_QUARANTINE_DIRNAME = '.longlive/quarantine';

let logger = null;
let clock = () => Date.now();

const stats = {
  attempts: 0,
  ok: 0,
  failed: 0,
  locked: 0,
  bytes: 0,
  quarantined: 0,
  byLabel: Object.create(null),
  lastError: null,
};

function bumpLabel(label, ok) {
  const key = typeof label === 'string' && label !== '' ? label : 'append';
  const slot = stats.byLabel[key] ?? (stats.byLabel[key] = { attempts: 0, ok: 0, failed: 0 });
  slot.attempts += 1;
  if (ok) slot.ok += 1; else slot.failed += 1;
}

/** Install the plugin logger (and a test clock). Safe to call more than once. */
export function configureAppendStore(options = {}) {
  if (options.logger && typeof options.logger.warn === 'function') logger = options.logger;
  else if (typeof options.logger === 'function') logger = { warn: options.logger };
  if (typeof options.now === 'function') clock = options.now;
  return { ok: true };
}

/** Test hook: clear the in-process counters. */
export function resetAppendStats() {
  stats.attempts = 0;
  stats.ok = 0;
  stats.failed = 0;
  stats.locked = 0;
  stats.bytes = 0;
  stats.quarantined = 0;
  stats.byLabel = Object.create(null);
  stats.lastError = null;
}

/** Snapshot of the counters (status / metrics / doctor read this). */
export function getAppendStats() {
  return {
    schema: APPEND_STORE_SCHEMA,
    attempts: stats.attempts,
    ok: stats.ok,
    failed: stats.failed,
    locked: stats.locked,
    bytes: stats.bytes,
    quarantined: stats.quarantined,
    byLabel: JSON.parse(JSON.stringify(stats.byLabel)),
    lastError: stats.lastError,
  };
}

function warn(message) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(`[append-store] ${message}`);
    else if (logger && typeof logger === 'function') logger(`[append-store] ${message}`);
  } catch {
    /* logging a write failure must not create another one */
  }
}

function nowMs(now) {
  try {
    const value = typeof now === 'function' ? now() : (now === undefined ? clock() : now);
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  } catch {
    return Date.now();
  }
}

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.round(ms)));
  } catch {
    /* Atomics.wait unavailable (exotic runtime): fall back to a bounded busy spin */
    const end = Date.now() + Math.max(1, Math.round(ms));
    while (Date.now() < end) { /* spin */ }
  }
}

function sanitizeName(name) {
  return String(name ?? 'append').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'append';
}

function quarantinePathFor(directory, file, label) {
  const stamp = new Date(nowMs()).toISOString().replace(/[:.]/g, '-');
  return path.join(directory, `${sanitizeName(path.basename(file))}.${sanitizeName(label)}.${stamp}.${process.pid}.bad`);
}

/**
 * Move an incomplete/corrupt tail to the quarantine directory and truncate the
 * file back to its last complete line. Returns `{quarantined, file, bytes}`.
 * Never throws.
 */
export function quarantineBadTail(file, options = {}) {
  const resolved = path.resolve(String(file));
  const result = { quarantined: false, file: null, bytes: 0 };
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return result;
  }
  if (!stat.isFile() || stat.size === 0) return result;

  // Read the last chunk; a complete file always ends with '\n'.
  let chunk = '';
  try {
    const chunkSize = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(resolved, 'r');
    try {
      const buffer = Buffer.alloc(chunkSize);
      const read = fs.readSync(fd, buffer, 0, chunkSize, stat.size - chunkSize);
      chunk = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return result;
  }

  const lastNewline = chunk.lastIndexOf('\n');
  const tail = lastNewline >= 0 ? chunk.slice(lastNewline + 1) : chunk;
  if (tail === '') return result; // file ends on a line boundary
  const isCompleteJson = (() => {
    try {
      JSON.parse(tail);
      return true;
    } catch {
      return false;
    }
  })();
  if (isCompleteJson) {
    // A complete line that lost its trailing newline (crash between write and
    // newline): keep the data, just terminate it so the next append is a line.
    try {
      fs.appendFileSync(resolved, '\n', 'utf8');
      return { ...result, terminated: true };
    } catch {
      return result;
    }
  }

  const tailBytes = Buffer.byteLength(tail, 'utf8');
  if (tailBytes > stat.size) return result;
  const quarantineDir = options.quarantineDir
    ? path.resolve(String(options.quarantineDir))
    : path.join(path.dirname(path.dirname(resolved)), DEFAULT_QUARANTINE_DIRNAME.split('/').slice(1).join('/'));
  const target = quarantinePathFor(quarantineDir, resolved, options.label ?? 'append');
  try {
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ schema: 'append-quarantine/v1', source: resolved, label: options.label ?? 'append', bytes: tailBytes, at: new Date(nowMs()).toISOString() })}\n${tail}\n`, 'utf8');
    fs.truncateSync(resolved, stat.size - tailBytes);
  } catch (error) {
    warn(`坏行隔离失败 ${path.basename(resolved)}: ${error?.code ?? error?.message ?? error}`);
    return result;
  }
  stats.quarantined += 1;
  warn(`隔离坏行 ${tailBytes}B：${path.basename(resolved)} → ${target}`);
  return { quarantined: true, file: target, bytes: tailBytes };
}

/**
 * Run `fn` while holding the per-file lease. Returns `{ok:true, value}` or a
 * structured `{ok:false, code:'E_APPEND_LOCKED'}` after `waitMs`.
 */
export function withFileLock(file, fn, options = {}) {
  if (typeof fn !== 'function') return { ok: false, code: 'E_APPEND_ARGUMENT', error: { code: 'E_APPEND_ARGUMENT', message: 'withFileLock requires fn' } };
  const lockFile = options.lockFile ? path.resolve(String(options.lockFile)) : `${path.resolve(String(file))}.lock`;
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_APPEND_LOCK_TTL_MS;
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : DEFAULT_APPEND_LOCK_WAIT_MS;
  const holder = typeof options.holder === 'string' && options.holder !== ''
    ? options.holder
    : `append-${process.pid}-${nowMs(options.now)}-${Math.random().toString(36).slice(2, 8)}`;
  const deadline = nowMs(options.now) + waitMs;
  let lease = null;
  for (;;) {
    try {
      lease = acquireLease(lockFile, { holder, ttlMs, now: options.now });
      break;
    } catch (error) {
      if (error?.code !== 'E_LOCKED') {
        return { ok: false, code: 'E_APPEND_LOCK_IO', error: { code: error?.code ?? 'E_APPEND_LOCK_IO', message: String(error?.message ?? error) }, lockFile };
      }
      if (nowMs(options.now) >= deadline) {
        return { ok: false, code: 'E_APPEND_LOCKED', error: { code: 'E_APPEND_LOCKED', message: `写锁被占用：${lockFile}` }, lockFile };
      }
      sleepMs(Math.min(50, Math.max(5, deadline - nowMs(options.now))));
    }
  }
  try {
    return { ok: true, value: fn(lease) };
  } finally {
    try {
      releaseLease(lockFile, lease.holder);
    } catch {
      /* release is best effort; the lease expires on its own */
    }
  }
}

/**
 * Append one JSON line. Never throws.
 *
 * @param {{file:string,row:object,label?:string,fsync?:boolean,skipLock?:boolean,
 *          quarantineDir?:string,healthRoot?:string,lock?:object,now?:Function}} options
 * @returns {{ok:boolean,file:string,bytes?:number,code?:string,error?:object,
 *            quarantined?:boolean,quarantineFile?:string}}
 */
export function appendJsonLine(options = {}) {
  const file = options.file;
  if (typeof file !== 'string' || file.trim() === '') {
    stats.attempts += 1;
    stats.failed += 1;
    const error = { code: 'E_APPEND_ARGUMENT', message: 'appendJsonLine requires file' };
    stats.lastError = { ...error, at: new Date(nowMs(options.now)).toISOString() };
    return { ok: false, file: '', code: error.code, error };
  }
  const resolved = path.resolve(file);
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'append';
  stats.attempts += 1;
  const healthRoot = typeof options.healthRoot === 'string' && options.healthRoot !== '' ? options.healthRoot : null;

  const finish = (result) => {
    if (result.ok) {
      stats.ok += 1;
      stats.bytes += Number(result.bytes) || 0;
      bumpLabel(label, true);
    } else {
      stats.failed += 1;
      bumpLabel(label, false);
      if (result.code === 'E_APPEND_LOCKED') stats.locked += 1;
      stats.lastError = { code: result.code ?? 'E_APPEND_IO', message: String(result.error?.message ?? ''), at: new Date(nowMs(options.now)).toISOString() };
      warn(`${label} 追加失败（${result.code ?? 'E_APPEND_IO'}）：${path.basename(resolved)} — ${result.error?.message ?? ''}`);
      if (healthRoot) flushAppendHealth(healthRoot, { now: options.now });
    }
    return result;
  };

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    let body;
    try {
      body = JSON.stringify(options.row);
    } catch (error) {
      return finish({ ok: false, file: resolved, code: 'E_APPEND_JSON', error: { code: 'E_APPEND_JSON', message: String(error?.message ?? error) } });
    }
    if (typeof body !== 'string') {
      return finish({ ok: false, file: resolved, code: 'E_APPEND_JSON', error: { code: 'E_APPEND_JSON', message: 'row is not JSON-serializable' } });
    }
    const line = `${body}\n`;
    const write = () => {
      const repaired = quarantineBadTail(resolved, { label, quarantineDir: options.quarantineDir, now: options.now });
      const fd = fs.openSync(resolved, 'a');
      try {
        fs.writeSync(fd, line, null, 'utf8');
        if (options.fsync !== false) {
          try {
            fs.fsyncSync(fd);
          } catch (error) {
            return { ok: false, file: resolved, code: 'E_APPEND_FSYNC', error: { code: error?.code ?? 'E_APPEND_FSYNC', message: String(error?.message ?? error) }, quarantined: repaired.quarantined };
          }
        }
      } finally {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      return { ok: true, file: resolved, bytes: Buffer.byteLength(line, 'utf8'), quarantined: repaired.quarantined, quarantineFile: repaired.file };
    };
    if (options.skipLock === true) return finish(write());
    const locked = withFileLock(resolved, write, { ...(options.lock ?? {}), now: options.now });
    if (!locked.ok) return finish({ ok: false, file: resolved, code: locked.code, error: locked.error, lockFile: locked.lockFile });
    return finish(locked.value);
  } catch (error) {
    const code = error?.code === 'E_LOCKED' ? 'E_APPEND_LOCKED' : 'E_APPEND_IO';
    return finish({ ok: false, file: resolved, code, error: { code: error?.code ?? code, message: String(error?.message ?? error) } });
  }
}

/** Read JSON lines resiliently (bad lines counted, never fatal). */
export function readJsonLines(file, options = {}) {
  const resolved = path.resolve(String(file));
  let text = '';
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, file: resolved, present: false, rows: [], badLines: 0 };
    return { ok: false, file: resolved, present: false, rows: [], badLines: 0, code: error?.code ?? 'E_APPEND_READ', error: String(error?.message ?? error) };
  }
  const rows = [];
  const bad = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad.push(line);
    }
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
  return { ok: true, file: resolved, present: true, rows: limit > 0 ? rows.slice(-limit) : rows, badLines: bad.length };
}

/** Merge the append counters into `.longlive/metrics/write-health.json` (atomic). */
export function flushAppendHealth(memoryRoot, options = {}) {
  const root = typeof memoryRoot === 'string' ? memoryRoot.trim() : '';
  if (root === '') return { ok: false, code: 'E_NO_MEMORY_ROOT' };
  const file = path.join(path.resolve(root), '.longlive', 'metrics', 'write-health.json');
  let existing = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {
    existing = {};
  }
  const payload = {
    ...existing,
    schema: existing.schema ?? 'write-health/v1',
    appendStore: getAppendStats(),
    updatedAt: new Date(nowMs(options.now)).toISOString(),
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, file, code: error?.code ?? 'E_APPEND_HEALTH', error: String(error?.message ?? error) };
  }
}

export { stats as appendStats };
