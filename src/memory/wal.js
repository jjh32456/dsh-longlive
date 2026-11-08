// src/memory/wal.js — M2-B / §2.3：索引写入的 WAL（崩溃安全 + 可重放）
//
// 写路径：先 append 一条 pending intent → 执行真正的写入（DB 事务）→ append done。
// 进程中途崩溃时，下次启动 `replay()` 把 pending 条目重新执行（写入本身幂等），
// 所以不会出现「半行索引」。`compact()` 只保留未完成条目，控制文件体积。
//
// 文件：<memoryRoot>/.longlive/index/wal.jsonl
// 行：{schema:'wal/v1', walId, op, at, status:'pending'|'done'|'failed', payload, error?}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../codec.js';

export const WAL_SCHEMA = 'wal/v1';
export const WAL_MAX_BYTES = 2 * 1024 * 1024;

export function walPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'index', 'wal.jsonl');
}

export function walIdOf(entry) {
  return crypto.createHash('sha1').update(stableStringify(entry)).digest('hex').slice(0, 16);
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return value instanceof Date ? value.getTime() : Number(value);
}

export function createWal(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  const file = options.walPath ? path.resolve(options.walPath) : walPathOf(memoryRoot);
  const now = options.now;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function append(line) {
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return line;
  }

  /** Record an intent; returns the walId used to mark completion. */
  function begin(op, payload, extra = {}) {
    const entry = { op, payload };
    const walId = options.walId?.(entry) ?? walIdOf(entry);
    append({ schema: WAL_SCHEMA, walId, op, at: nowMs(now), status: 'pending', payload, ...extra });
    return walId;
  }

  function markDone(walId, extra = {}) {
    append({ schema: WAL_SCHEMA, walId, at: nowMs(now), status: 'done', ...extra });
    return { ok: true, walId };
  }

  function markFailed(walId, error, extra = {}) {
    append({ schema: WAL_SCHEMA, walId, at: nowMs(now), status: 'failed', error: String(error ?? 'unknown'), ...extra });
    return { ok: true, walId };
  }

  /** Fold the log: last status wins. */
  function fold() {
    const entries = new Map();
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return entries;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof row?.walId !== 'string') continue;
      const previous = entries.get(row.walId) ?? {};
      entries.set(row.walId, { ...previous, ...row, status: row.status ?? previous.status ?? 'pending' });
    }
    return entries;
  }

  function pending() {
    return [...fold().values()].filter((entry) => entry.status === 'pending');
  }

  function all() {
    return [...fold().values()];
  }

  function failed() {
    return [...fold().values()].filter((entry) => entry.status === 'failed');
  }

  /**
   * Replay every pending intent through `handler(entry)`. Handler must be idempotent.
   * Returns {ok, replayed, failed}.
   */
  function replay(handler) {
    if (typeof handler !== 'function') throw new Error('wal.replay requires handler(entry)');
    const results = { ok: true, replayed: 0, failed: 0, errors: [] };
    for (const entry of pending()) {
      try {
        handler(entry);
        markDone(entry.walId, { replayed: true });
        results.replayed += 1;
      } catch (error) {
        markFailed(entry.walId, error?.message ?? error);
        results.failed += 1;
        results.errors.push({ walId: entry.walId, op: entry.op, message: String(error?.message ?? error) });
      }
    }
    results.ok = results.failed === 0;
    return results;
  }

  /** Rewrite only pending lines (atomic tmp→rename); completed/failed rows dropped. */
  function compact() {
    const keep = pending();
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, keep.map((entry) => JSON.stringify(entry)).join('\n') + (keep.length > 0 ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, kept: keep.length };
  }

  function size() {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  return { file, begin, markDone, markFailed, pending, failed, all, replay, compact, size, fold };
}
