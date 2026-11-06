// WP2 shared paths + atomic JSON writer.
//
// Everything Router 1.1.0 writes lives under `<memoryRoot>/.longlive/`:
//   live/<sessionId>.json              L1 心跳行（rc11 schema，由 src/live.js 写）
//   router/board.json                 L2 活动板
//   router/index/roster.json          L1 roster 投影（只读投影，不是第二真相）
//   router/inject-state/<id>.json     L2 每会话注入状态（跨重启保留）
//
// 原子写协议与 rc11 一致：同目录唯一 tmp → 写 → fsync → 读回校验 → rename；
// 任何一步失败都返回 {ok:false}，绝不把半截 JSON 留在目标路径上。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROUTER_DIR_NAME = 'router';
export const BOARD_MAX_BYTES = 8192;
export const BOARD_VERSION = 1;
export const ROSTER_VERSION = 1;
export const INJECT_STATE_RETENTION_DAYS = 30;
export const WRITE_RETRIES = 5;

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function shortHash(text, length = 12) {
  return sha256Hex(text).slice(0, length);
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function nowDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : new Date();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date();
}

export function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = nowDate(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Local-day key (YYYY-MM-DD) — quotas roll over at local midnight. */
export function localDayKey(value) {
  const date = nowDate(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function routerPaths({ memoryRoot, vaultDir } = {}) {
  const vault = vaultDir
    ? path.resolve(vaultDir)
    : (memoryRoot ? path.join(path.resolve(memoryRoot), '.longlive', ROUTER_DIR_NAME) : null);
  const liveRoot = memoryRoot
    ? path.resolve(memoryRoot)
    // Custom vault without memoryRoot: vault is normally `<root>/.longlive/router`,
    // so its parent is the memory root that owns the live directory.
    : (vault ? path.dirname(vault) : null);
  return {
    vaultDir: vault,
    liveRoot,
    liveDir: liveRoot ? path.join(liveRoot, '.longlive', 'live') : null,
    // A1 writes one conclusion marker per session here; the board reads it as
    // focus[].lastConclusion. Lives next to live/ so both features share root.
    bridgeDir: liveRoot ? path.join(liveRoot, '.longlive', 'bridge') : null,
    boardFile: vault ? path.join(vault, 'board.json') : null,
    rosterFile: vault ? path.join(vault, 'index', 'roster.json') : null,
    injectStateDir: vault ? path.join(vault, 'inject-state') : null,
    proposalsDir: vault ? path.join(vault, 'proposals') : null,
  };
}

export function readJsonFile(file) {
  if (!file) return { ok: false, error: 'E_NO_PATH' };
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, value: JSON.parse(text), text, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (error) {
    return { ok: false, error: error?.code ?? 'E_READ', message: error?.message ?? String(error) };
  }
}

function writeFileDurable(file, text) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* fsync is best-effort on some filesystems */ }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Atomic JSON write: tmp -> read-back -> rename, with bounded retries.
 * Never throws; returns {ok,file,bytes,sha256,error}.
 */
export function writeJsonAtomic(file, value, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : WRITE_RETRIES;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  const sha256 = sha256Hex(text);
  const dir = path.dirname(file);
  let lastError = null;
  if (!ensureDir(dir)) return { ok: false, file, error: 'E_MKDIR', bytes, sha256 };
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileDurable(tmp, text);
      const readBack = fs.readFileSync(tmp, 'utf8');
      if (sha256Hex(readBack) !== sha256) throw new Error('read-back mismatch');
      fs.renameSync(tmp, file);
      return { ok: true, file, bytes, sha256 };
    } catch (error) {
      lastError = error;
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
  return {
    ok: false,
    file,
    bytes,
    sha256,
    error: lastError?.code ?? 'E_WRITE',
    message: lastError?.message ?? String(lastError ?? ''),
  };
}

export function writeTextAtomic(file, text, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : WRITE_RETRIES;
  const value = String(text ?? '');
  const bytes = Buffer.byteLength(value, 'utf8');
  const sha256 = sha256Hex(value);
  const dir = path.dirname(file);
  if (!ensureDir(dir)) return { ok: false, file, error: 'E_MKDIR' };
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileDurable(tmp, value);
      if (sha256Hex(fs.readFileSync(tmp, 'utf8')) !== sha256) throw new Error('read-back mismatch');
      fs.renameSync(tmp, file);
      return { ok: true, file, bytes, sha256 };
    } catch (error) {
      lastError = error;
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
  return { ok: false, file, bytes, sha256, error: lastError?.code ?? 'E_WRITE' };
}

export function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function hostName() {
  try { return os.hostname(); } catch { return 'localhost'; }
}
