// src/autoprocedure/locks.js — 跨进程锁的自动流程封装（F1）。
//
// 复用 src/memory/lock.js 的 O_EXCL lease，不自己造锁：
//   * holder 必须唯一：`autoprocedure:<pid>:<runId>:<sessionId>`（禁止常量
//     holder，否则同 holder 幂等会造出「假互斥」）；
//   * 自动流程：失败重试 3 × 500ms、TTL 60s、超时放弃本次并计数；
//   * 拆两把锁：staging 锁（写 staging 时持有）与 procedures 锁（只约束写
//     `procedures/` 的一方）。**自动流程只取 staging 锁，从不取 procedures 锁**；
//     procedures 锁在本版本没有生产写者，手动 `memory_procedure save` 也不加锁，
//     因此后台流程不会阻塞手动转正（D6：删除了此前的「手动 save 等待 ≤5s」承诺，
//     因为该封装从未接线，承诺与事实不符）。
//   * 同一时刻只允许一个 drain：用 staging 锁目录下的第二个 key
//     `.autoprocedure.drain.lock` 保护。

import { acquireLease, releaseLease } from '../memory/lock.js';
import {
  AUTOPROCEDURE_LOCK_TTL_MS,
  AUTOPROCEDURE_LOCK_RETRIES,
  AUTOPROCEDURE_LOCK_RETRY_DELAY_MS,
} from './config.js';

export const LOCK_CODES = Object.freeze({
  BUSY: 'E_AP_LOCKED',
  IO: 'E_AP_LOCK_IO',
});

function safeNowMs(now) {
  try {
    const value = typeof now === 'function' ? now() : (now ?? Date.now());
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
  } catch {
    return Date.now();
  }
}

/** Unique run id (timestamp + pid + random suffix), ASCII only. */
export function makeRunId(now = Date.now(), random = Math.random) {
  const stamp = safeNowMs(now).toString(36);
  const noise = Math.floor(Math.abs(random()) * 0xffffffff).toString(36);
  return `${stamp}-${process.pid}-${noise}`.slice(0, 80);
}

/** holder = autoprocedure:<pid>:<runId>:<sessionId>（sessionId 只用于可读性）。 */
export function autoProcedureHolder({ runId, sessionId = 'none', pid = process.pid } = {}) {
  const safeSession = String(sessionId ?? 'none').replace(/[^\w.-]+/g, '_').slice(0, 80);
  return `autoprocedure:${pid}:${runId}:${safeSession}`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Acquire a lease with 3 × 500ms async retries (never blocks the host event loop).
 * @returns {Promise<{ok:true, lease:object, attempts:number}|{ok:false, code:string, error:object}>}
 */
export async function acquireWithRetry({
  lockFile,
  holder,
  ttlMs = AUTOPROCEDURE_LOCK_TTL_MS,
  retries = AUTOPROCEDURE_LOCK_RETRIES,
  delayMs = AUTOPROCEDURE_LOCK_RETRY_DELAY_MS,
  sleep = defaultSleep,
  acquire = acquireLease,
  now = Date.now,
} = {}) {
  let attempts = 0;
  let lastError = null;
  for (let i = 0; i <= retries; i += 1) {
    attempts += 1;
    try {
      const lease = acquire(lockFile, { holder, ttlMs, now });
      return { ok: true, lease, attempts };
    } catch (error) {
      lastError = error;
      if (error?.code !== 'E_LOCKED') {
        return { ok: false, code: LOCK_CODES.IO, error: { code: error?.code ?? 'E_AP_LOCK_IO', message: String(error?.message ?? error) }, attempts };
      }
      if (i < retries) await sleep(delayMs);
    }
  }
  return {
    ok: false,
    code: LOCK_CODES.BUSY,
    error: {
      code: 'E_AP_LOCKED',
      message: String(lastError?.message ?? 'lock busy'),
      holder: lastError?.detail?.holder ?? null,
    },
    attempts,
  };
}

/** Release a lease we hold; best effort (the lease expires on its own). */
export function releaseSafe(lockFile, holder) {
  try {
    return releaseLease(lockFile, holder);
  } catch {
    return { ok: false, released: false, reason: 'release-error' };
  }
}
