// src/util/stale-locks.js — S1：陈旧锁清理（启动 / doctor 各跑一次）。
//
// 覆盖审计报告 P1-10 列出的两类遗留锁：
//   * `<...>.lock`（append / capture 的租约文件）；
//   * `<...>.lock.tmp-*`、`router.lock.tmp-*`（崩溃留下的临时锁）。
// 判定：文件 mtime 超过 `staleMs`（默认 30 分钟）即视为陈旧；删除前解析 JSON 租约，
// 若租约 expiresAt 仍在未来则保留（避免误删正在续期的持有者）。每次删除写一行审计
// 到 `.longlive/audit/lock-cleanup.jsonl`（经由 append-store，带 fsync），失败只告警。

import fs from 'node:fs';
import path from 'node:path';

import { appendJsonLine } from './append-store.js';

export const LOCK_CLEANUP_SCHEMA = 'lock-cleanup/v1';
export const LOCK_CLEANUP_AUDIT = path.join('.longlive', 'audit', 'lock-cleanup.jsonl');
export const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000;

const LOCK_FILE_RE = /(?:^|[\\/])(?:[^\\/]+\.lock|router\.lock\.tmp-[^\\/]+|[^\\/]+\.lock\.tmp-[^\\/]+)$/;

function envStaleMs(env) {
  const minutes = Number(env?.DSH_LONGLIVE_STALE_LOCK_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  return DEFAULT_STALE_LOCK_MS;
}

function walkLockFiles(root, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkLockFiles(abs, out, depth + 1);
    } else if (entry.isFile() && LOCK_FILE_RE.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/** Candidate lock files: the `.longlive` subtree plus top-level lock files. */
function collectLockCandidates(memoryRoot) {
  const root = path.resolve(memoryRoot);
  const out = [];
  const longlive = path.join(root, '.longlive');
  if (fs.existsSync(longlive)) walkLockFiles(longlive, out);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.isFile() && LOCK_FILE_RE.test(entry.name)) out.push(path.join(root, entry.name));
  }
  return [...new Set(out)];
}

function readLease(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Delete stale lock/tmp-lock files under `<memoryRoot>/.longlive` (plus the
 * memory root itself for legacy layouts). Never throws.
 *
 * @param {{memoryRoot:string, now?:Function, staleMs?:number, env?:object,
 *          logger?:object|Function, audit?:boolean}} options
 * @returns {{ok:boolean, scanned:number, removed:Array, kept:Array, errors:Array}}
 */
export function cleanupStaleLocks(options = {}) {
  const staleMs = Number.isFinite(Number(options.staleMs)) && Number(options.staleMs) > 0
    ? Number(options.staleMs)
    : envStaleMs(options.env ?? process.env);
  const now = (() => {
    try {
      const value = typeof options.now === 'function' ? options.now() : (options.now ?? Date.now());
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
    } catch {
      return Date.now();
    }
  })();
  const result = { ok: true, scanned: 0, removed: [], kept: [], errors: [] };
  const memoryRoot = typeof options.memoryRoot === 'string' ? options.memoryRoot.trim() : '';
  if (memoryRoot === '') return { ...result, ok: false, code: 'E_NO_MEMORY_ROOT' };

  const candidates = collectLockCandidates(path.resolve(memoryRoot));
  result.scanned = candidates.length;
  const auditRows = [];
  for (const file of candidates) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const ageMs = Math.max(0, now - stat.mtimeMs);
    if (ageMs < staleMs) {
      result.kept.push({ file: path.relative(memoryRoot, file).split(path.sep).join('/'), ageMs, reason: 'fresh' });
      continue;
    }
    const lease = readLease(file);
    const expiresAt = Number(lease?.expiresAt ?? 0);
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      result.kept.push({ file: path.relative(memoryRoot, file).split(path.sep).join('/'), ageMs, reason: 'lease-active', expiresAt });
      continue;
    }
    try {
      fs.rmSync(file, { force: true });
      const rel = path.relative(memoryRoot, file).split(path.sep).join('/');
      result.removed.push({ file: rel, ageMs, holder: lease?.holder ?? null, pid: lease?.pid ?? null });
      auditRows.push({
        schema: LOCK_CLEANUP_SCHEMA,
        at: new Date(now).toISOString(),
        action: 'remove-stale-lock',
        file: rel,
        ageMs,
        holder: lease?.holder ?? null,
        pid: lease?.pid ?? null,
      });
      try {
        options.logger?.warn?.(`[lock-cleanup] 清理陈旧锁：${rel}（age=${Math.round(ageMs / 1000)}s）`);
      } catch { /* logging must not fail cleanup */ }
    } catch (error) {
      result.errors.push({ file: path.relative(memoryRoot, file).split(path.sep).join('/'), error: String(error?.message ?? error) });
      result.ok = false;
    }
  }
  if (options.audit !== false && auditRows.length > 0) {
    const auditFile = path.join(path.resolve(memoryRoot), LOCK_CLEANUP_AUDIT);
    for (const row of auditRows) {
      appendJsonLine({ file: auditFile, row, label: 'lock-cleanup', healthRoot: memoryRoot, now: options.now, logger: options.logger });
    }
  }
  return result;
}
