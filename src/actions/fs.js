// src/actions/fs.js — 动作层私有文件原语（1.6.9 Gate-1）
//
// 动作/审计/证据只写宿主私有目录：`<memoryRoot>/.longlive/{actions,evidence,distill,protected.json,...}`。
// 全部写入走 tmp + fsync + 读回校验 + rename；读取对坏行只计数不抛错。
// 不依赖任何第三方包，不联网。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ACTIONS_DIR = 'actions';
export const GENESIS_HASH = '0'.repeat(64);

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex');
}

/** HMAC-SHA256 hex. Used by the audit chain and the evidence signature. */
export function hmacHexFor(key, text) {
  return crypto.createHmac('sha256', key).update(String(text), 'utf8').digest('hex');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Atomic JSON write (tmp + fsync + read-back + rename). */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* best effort on some filesystems */
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  const readBack = fs.readFileSync(tmp, 'utf8');
  if (readBack !== text) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error('E_WRITE_READBACK');
  }
  fs.renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(text, 'utf8') };
}

export function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, code: error?.code === 'ENOENT' ? 'ENOENT' : (error?.code ?? 'E_READ') };
  }
}

/** Append one JSON line, fsynced. Returns the byte offset before the append. */
export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  const text = `${JSON.stringify(value)}\n`;
  const before = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* best effort */
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  return { file, bytes: Buffer.byteLength(text, 'utf8'), offset: before };
}

/** Read JSONL defensively: `{rows, bad, exists}`; never throws on bad lines. */
export function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { rows: [], bad: 0, exists: false, code: error?.code === 'ENOENT' ? 'ENOENT' : (error?.code ?? 'E_READ') };
  }
  const rows = [];
  let bad = 0;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  return { rows, bad, exists: true };
}

/** Atomic JSONL rewrite (tmp + read-back + rename). */
export function writeJsonlAtomic(file, rows) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const text = Array.isArray(rows) && rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* best effort */
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  const readBack = fs.readFileSync(tmp, 'utf8');
  if (readBack !== text) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error('E_WRITE_READBACK');
  }
  fs.renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(text, 'utf8') };
}

export function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${prefix}_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

/** Directory of this memory root's private action state. */
export function actionsDir(memoryRoot) {
  return path.join(String(memoryRoot ?? ''), '.longlive', ACTIONS_DIR);
}
