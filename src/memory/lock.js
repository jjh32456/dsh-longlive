// src/memory/lock.js — M2-B / §2.4 / §5.3：跨进程写锁（lease）
//
// 语义抽自 `src/memory/maintenance.js` 的 O_EXCL 抢占：锁文件本身即租约
// `{holder, pid, acquiredAt, expiresAt}`；O_EXCL 创建保证跨进程唯一。
//   * 同一 holder 重复 acquire → 幂等返回（已持有）；
//   * 过期租约（expiresAt < now）→ 允许接管（staleTakenOver:true）；
//   * 活跃租约被别人持有 → `E_LOCKED`（不无限重试、不双写）。
// 用于：journal/records 追加、boot.json/shutdown.json、索引构建与 captureTurn。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

export class LockError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function readLease(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return value instanceof Date ? value.getTime() : Number(value);
}

/**
 * Acquire a lease. Returns { ok:true, holder, acquiredAt, expiresAt, staleTakenOver }
 * or throws LockError E_LOCKED with the current holder.
 */
export function acquireLease(lockFile, options = {}) {
  const file = path.resolve(String(lockFile));
  const holder = typeof options.holder === 'string' && options.holder !== '' ? options.holder : `pid-${process.pid}`;
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_LOCK_TTL_MS;
  const now = options.now;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acquiredAt = nowMs(now);
    const lease = { holder, pid: process.pid, acquiredAt, expiresAt: acquiredAt + ttlMs };
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(lease)}\n`, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, holder, acquiredAt, expiresAt: lease.expiresAt, lockFile: file, staleTakenOver: attempt > 0 };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new LockError('E_LOCK_IO', `无法创建锁文件：${error?.message ?? error}`);
      const current = readLease(file);
      const currentAt = Number(current?.expiresAt ?? 0);
      if (current && current.holder === holder) {
        return { ok: true, holder, acquiredAt: Number(current.acquiredAt) || acquiredAt, expiresAt: currentAt, lockFile: file, alreadyHeld: true };
      }
      if (!current || !Number.isFinite(currentAt) || currentAt < nowMs(now)) {
        // stale / corrupt lease: take it over exactly once
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* raced with another taker; loop retries once */
        }
        continue;
      }
      throw new LockError('E_LOCKED', `写锁被 ${current.holder} 持有（pid=${current.pid}）`, {
        holder: current.holder,
        pid: current.pid,
        expiresAt: currentAt,
      });
    }
  }
  throw new LockError('E_LOCKED', '写锁竞争失败（stale takeover 两次均被抢先）');
}

/** Release only if the recorded holder matches (never steal someone else's lease). */
export function releaseLease(lockFile, holder) {
  const file = path.resolve(String(lockFile));
  const current = readLease(file);
  if (!current) return { ok: true, released: false, reason: 'no-lease' };
  if (current.holder !== holder) {
    return { ok: false, released: false, reason: 'not-holder', holder: current.holder };
  }
  fs.rmSync(file, { force: true });
  return { ok: true, released: true };
}

export function leaseStatus(lockFile, options = {}) {
  const file = path.resolve(String(lockFile));
  const current = readLease(file);
  if (!current) return { present: false };
  const expiresAt = Number(current.expiresAt ?? 0);
  return {
    present: true,
    holder: current.holder,
    pid: current.pid,
    acquiredAt: current.acquiredAt,
    expiresAt,
    expired: Number.isFinite(expiresAt) ? expiresAt < nowMs(options.now) : true,
  };
}

/** Run `fn` while holding the lease; always releases when we acquired it. */
export function withLease(lockFile, options, fn) {
  const awaited = acquireLease(lockFile, options);
  try {
    return fn(awaited);
  } finally {
    if (!awaited.alreadyHeld) releaseLease(lockFile, awaited.holder);
  }
}
