// 实例锁（DESIGN §2.2）。
//
// 同一份 vault 只允许一个 RouterService 活跃；不同进程/主机抢锁失败时进入 standby，
// 不做任何账本/审计读操作。锁文件是用户可写的 JSON，和账本一样只防误并发，不防同用户
// 蓄意伪造——能力边界见 REPORT。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCK_LEASE_MS = 30000;
export const LOCK_RENEW_MS = 10000;
export const STANDBY_RETRY_MS = 15000;
/** D-CR9: a reclaim mutex older than this may be taken over when its pid is dead. */
export const RECLAIM_STALE_MIN_MS = 30000;

function nonce() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(12).toString('hex');
}

function isoNow(ms) {
  return new Date(ms).toISOString();
}

/** Synchronous bounded sleep (append() is synchronous by contract). */
export function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 1000));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin: Atomics unavailable */ }
  }
}

export function defaultHost() {
  try { return os.hostname(); } catch { return 'unknown'; }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * D-CR6/D-CR9: a small exclusive file lock with an owner identity and the same
 * five-step controlled takeover as tick.lock. Used for `locks/wal.lock` (and
 * generic reclaim mutexes); every holder is `{v,pid,host,startedAt,nonce}`.
 *
 * Acquisition never steals a fresh lock. A stale lock is only taken over after
 * a reclaim mutex is created and the observed bytes are re-compared (CAS); the
 * old file is renamed to `<evidencePrefix><ts>` as evidence, never unlinked.
 */
export class OwnerLock {
  constructor({
    file,
    reclaimFile = null,
    evidencePrefix = null,
    staleMs = RECLAIM_STALE_MIN_MS,
    host = defaultHost(),
    pid = process.pid,
    now = () => new Date(),
    audit = null,
    logger = null,
    label = 'owner',
  } = {}) {
    if (typeof file !== 'string' || file === '') throw new Error('OwnerLock: file is required');
    this.file = file;
    this.dir = path.dirname(file);
    this.reclaimFile = reclaimFile ?? `${file}.reclaim`;
    this.evidencePrefix = evidencePrefix ?? `${path.basename(file)}.reclaimed-`;
    this.staleMs = Number.isFinite(staleMs) ? Math.max(1, Math.trunc(staleMs)) : RECLAIM_STALE_MIN_MS;
    this.host = host;
    this.pid = pid;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.audit = audit;
    this.logger = logger;
    this.label = label;
    this.own = null;
    this.reclaimOwn = null;
  }

  #nowMs() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  }

  #auditSafe(kind, data) {
    try { this.audit?.(kind, data); } catch { /* audit never blocks a lock */ }
  }

  #stamp() {
    return isoNow(this.#nowMs()).replace(/[:.]/gu, '-');
  }

  read(file = this.file) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  #fileAgeMs(file = this.file) {
    try { return Math.max(0, this.#nowMs() - fs.statSync(file).mtimeMs); } catch { return 0; }
  }

  #holderAgeMs(holder) {
    const started = Date.parse(holder?.startedAt ?? '');
    return Number.isFinite(started) ? Math.max(0, this.#nowMs() - started) : this.#fileAgeMs();
  }

  #isExpired(holder) {
    return this.#holderAgeMs(holder) > this.staleMs;
  }

  /** local holder must be a dead pid; a foreign holder can only age out. */
  #isStale(holder) {
    if (!holder) return this.#fileAgeMs() > this.staleMs;
    if (!this.#isExpired(holder)) return false;
    if (holder.host === this.host) return !pidAlive(holder.pid);
    return true;
  }

  #writeOwn() {
    const payload = {
      v: 1,
      pid: this.pid,
      host: this.host,
      startedAt: isoNow(this.#nowMs()),
      nonce: nonce(),
    };
    const fd = fs.openSync(this.file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
      try { fs.fsyncSync(fd); } catch { /* best effort */ }
    } finally {
      fs.closeSync(fd);
    }
    const back = this.read();
    if (!back || back.nonce !== payload.nonce || back.pid !== this.pid) {
      try { fs.unlinkSync(this.file); } catch { /* only our bytes */ }
      return null;
    }
    this.own = back;
    return back;
  }

  #reclaimHolderStale(holder) {
    if (!holder) return this.#fileAgeMs(this.reclaimFile) > this.staleMs;
    if (!this.#isExpired(holder)) return false;
    if (holder.host === this.host) return !pidAlive(holder.pid);
    return true;
  }

  /** Create the reclaim mutex, taking over a stale (dead-holder) one once. */
  #acquireReclaimMutex() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.reclaimFile, 'wx', 0o600);
        const payload = {
          v: 1,
          pid: this.pid,
          host: this.host,
          startedAt: isoNow(this.#nowMs()),
          nonce: nonce(),
        };
        try {
          fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
          try { fs.fsyncSync(fd); } catch { /* best effort */ }
        } finally {
          fs.closeSync(fd);
        }
        this.reclaimOwn = payload;
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const holder = this.read(this.reclaimFile);
        if (!this.#reclaimHolderStale(holder)) return false;
        const evidence = `${this.reclaimFile}.reclaimed-${this.#stamp()}`;
        try {
          fs.renameSync(this.reclaimFile, evidence);
        } catch {
          return false;
        }
        this.#auditSafe(`${this.label}.reclaim_lock.reclaimed`, {
          evidence: path.basename(evidence),
          oldPid: holder?.pid ?? null,
          oldStartedAt: holder?.startedAt ?? null,
        });
      }
    }
    return false;
  }

  #releaseReclaimMutex() {
    const own = this.reclaimOwn;
    this.reclaimOwn = null;
    if (!own) return;
    const current = this.read(this.reclaimFile);
    if (!current || current.nonce !== own.nonce) return;
    try { fs.unlinkSync(this.reclaimFile); } catch { /* already gone */ }
  }

  #takeOver(observed) {
    if (!this.#acquireReclaimMutex()) {
      this.#auditSafe(`${this.label}.reclaim_busy`, {});
      return { ok: false, reason: 'reclaim-busy' };
    }
    try {
      const current = this.read();
      if (observed) {
        if (!current || current.pid !== observed.pid
          || current.startedAt !== observed.startedAt
          || current.nonce !== observed.nonce) {
          return { ok: false, reason: 'busy' };
        }
      } else if (current) {
        return { ok: false, reason: 'busy' };
      }
      const evidence = path.join(this.dir, `${this.evidencePrefix}${this.#stamp()}`);
      if (current || fs.existsSync(this.file)) fs.renameSync(this.file, evidence);
      const own = this.#writeOwn();
      if (!own) return { ok: false, reason: 'busy' };
      this.#auditSafe(`${this.label}.reclaimed`, {
        oldPid: observed?.pid ?? null,
        oldHost: observed?.host ?? null,
        oldStartedAt: observed?.startedAt ?? null,
        evidence: path.basename(evidence),
      });
      return { ok: true, reclaimed: Boolean(observed), evidence: path.basename(evidence), owner: own };
    } finally {
      this.#releaseReclaimMutex();
    }
  }

  /**
   * Try to own the lock, retrying briefly. Returns {ok:true} or
   * {ok:false, reason:'busy'|'reclaim-busy'}. Never throws for contention.
   */
  acquire({ waitMs = 2000, retryMs = 10 } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const deadline = this.#nowMs() + waitMs;
    for (;;) {
      let own = null;
      try {
        own = this.#writeOwn();
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      if (own) return { ok: true, owner: own };
      const current = this.read();
      if (this.#isStale(current)) {
        const taken = this.#takeOver(current);
        if (taken.ok) return taken;
        if (taken.reason === 'reclaim-busy') return taken;
      }
      if (this.#nowMs() >= deadline) {
        return { ok: false, reason: 'busy', holder: current };
      }
      sleepSync(Math.max(1, retryMs));
    }
  }

  /** Release only our own bytes (nonce identity check). */
  release() {
    const own = this.own;
    this.own = null;
    if (!own) return { ok: true, released: false };
    const current = this.read();
    if (!current || current.nonce !== own.nonce) return { ok: false, released: false };
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
    return { ok: true, released: true };
  }
}

function holderKey(holder) {
  if (!holder || typeof holder !== 'object') return null;
  return [
    holder.pid ?? null,
    holder.host ?? null,
    holder.runId ?? null,
    holder.nonce ?? null,
    holder.startedAt ?? null,
  ].join('|');
}

function sameHolder(a, b) {
  return holderKey(a) === holderKey(b);
}

export class InstanceLock {
  constructor({
    file,
    runId,
    host = defaultHost(),
    pid = process.pid,
    leaseMs = LOCK_LEASE_MS,
    now = () => new Date(),
  } = {}) {
    if (!file) throw new Error('InstanceLock: file is required');
    this.file = file;
    this.runId = runId ?? `run-${pid}`;
    this.host = host;
    this.pid = pid;
    this.leaseMs = leaseMs;
    this.now = now;
    this.owned = false;
    this.takeover = false;
    this.previous = null;
    this.evidence = null;
    this.nonce = null;
  }

  #nowMs() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  }

  #fileAgeMs() {
    try { return Math.max(0, this.#nowMs() - fs.statSync(this.file).mtimeMs); } catch { return 0; }
  }

  #holderInfo(existing) {
    if (!existing || typeof existing !== 'object') return null;
    const heartbeat = Date.parse(existing.heartbeatAt ?? existing.startedAt ?? '');
    const fresh = Number.isFinite(heartbeat) && this.#nowMs() - heartbeat < this.leaseMs;
    const sameHost = typeof existing.host === 'string' ? existing.host === this.host : true;
    const alive = sameHost ? pidAlive(existing.pid) : true;
    return { ...existing, fresh, alive, sameHost, heartbeat };
  }

  #standby(holder, reason, code) {
    this.owned = false;
    this.takeover = false;
    this.previous = null;
    this.evidence = null;
    return {
      ok: false,
      state: 'standby',
      holder: holder ?? null,
      ...(reason ? { reason } : {}),
      ...(code ? { code } : {}),
    };
  }

  /** Atomic create: open(wx) -> write -> fsync -> close -> read back. */
  #createOnce() {
    const now = isoNow(this.#nowMs());
    const payload = {
      v: 1,
      pid: this.pid,
      host: this.host,
      runId: this.runId,
      nonce: nonce(),
      startedAt: now,
      heartbeatAt: now,
    };
    let fd = null;
    try {
      fd = fs.openSync(this.file, 'wx', 0o600);
    } catch (error) {
      return { ok: false, error };
    }
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
      try { fs.fsyncSync(fd); } catch { /* fsync is best effort on some filesystems */ }
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(this.file); } catch { /* only our own bytes: wx created it */ }
      return { ok: false, error };
    }
    try { fs.closeSync(fd); } catch { /* ignore */ }

    const back = readLock(this.file);
    if (!back || back.runId !== payload.runId || back.nonce !== payload.nonce) {
      return { ok: false, mismatch: true, holder: back ?? null };
    }
    this.nonce = payload.nonce;
    return { ok: true, holder: back };
  }

  /**
   * Rename the observed stale/dead lock to an evidence path, then verify by
   * re-reading the moved bytes (CAS). A fresh lock that raced in between is put
   * back untouched. Never unlinks a lock file.
   */
  #reclaim(observed) {
    const stamp = isoNow(this.#nowMs()).replace(/[:.]/gu, '-');
    const evidence = `${this.file}.reclaimed-${stamp}`;
    try {
      fs.renameSync(this.file, evidence);
    } catch (error) {
      if (error?.code === 'ENOENT') return { retry: true };
      return { retry: false, code: error?.code ?? 'E_RENAME' };
    }
    const moved = readLock(evidence);
    if (!sameHolder(moved, observed)) {
      try {
        if (!fs.existsSync(this.file)) fs.renameSync(evidence, this.file);
      } catch { /* the owner keeps its bytes; we simply standby */ }
      return { retry: false, raced: true };
    }
    this.takeover = Boolean(observed && observed.runId !== this.runId);
    this.previous = observed ?? null;
    this.evidence = path.basename(evidence);
    return { retry: true, evidence: this.evidence };
  }

  /**
   * 抢锁。返回 {ok, state:'acquired'|'standby', holder?, takeover?}。
   * - 用 open(wx) 原子创建；回读 runId/nonce 校验；
   * - 新鲜且活着的持有者：standby，不写锁；
   * - 只有 stale/dead 才接管，旧锁 rename 留证；
   * - 任何文件系统竞态都收敛为 standby，不抛出。
   */
  acquire() {
    this.takeover = false;
    this.previous = null;
    this.evidence = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch (error) {
      return this.#standby(null, 'mkdir-failed', error?.code);
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const created = this.#createOnce();
      if (created.ok) {
        this.owned = true;
        return {
          ok: true,
          state: 'acquired',
          takeover: this.takeover,
          previous: this.previous,
          ...(this.evidence ? { evidence: this.evidence } : {}),
        };
      }
      if (created.mismatch) return this.#standby(created.holder, 'readback-mismatch');
      if (created.error?.code !== 'EEXIST') {
        return this.#standby(null, 'create-failed', created.error?.code);
      }

      const existing = readLock(this.file);
      const holder = this.#holderInfo(existing);
      if (holder && holder.runId === this.runId) {
        // Re-entrant acquire / renewal of the same logical run.
        this.owned = true;
        this.nonce = holder.nonce ?? this.nonce;
        this.takeover = false;
        this.previous = holder;
        return { ok: true, state: 'acquired', takeover: false, previous: holder };
      }
      if (holder && holder.fresh && holder.alive) return this.#standby(holder, 'held');
      if (!holder && this.#fileAgeMs() < this.leaseMs) {
        // A fresh unreadable file is still another writer's partial write.
        return this.#standby(null, 'unreadable-young');
      }
      const reclaimed = this.#reclaim(holder);
      if (reclaimed.retry) continue;
      return this.#standby(readLock(this.file) ?? holder, reclaimed.raced ? 'reclaim-raced' : 'reclaim-failed', reclaimed.code);
    }
    return this.#standby(readLock(this.file), 'contended');
  }

  /** 只续自己的锁；锁已被别人接管时返回 false。 */
  renew() {
    if (!this.owned) return false;
    try {
      const existing = readLock(this.file);
      if (!existing || existing.runId !== this.runId) {
        this.owned = false;
        return false;
      }
      // Legacy locks may not carry a nonce; fall back to runId identity.
      if (this.nonce && existing.nonce && existing.nonce !== this.nonce) {
        this.owned = false;
        return false;
      }
      const now = isoNow(this.#nowMs());
      writeAtomic(this.file, { ...existing, heartbeatAt: now });
      const back = readLock(this.file);
      if (!back || back.runId !== this.runId || back.heartbeatAt !== now
        || (this.nonce && back.nonce && back.nonce !== this.nonce)) {
        this.owned = false;
        return false;
      }
      return true;
    } catch {
      this.owned = false;
      return false;
    }
  }

  read() {
    return readLock(this.file);
  }

  /** 只删自己的锁；无法证明归属时返回 false 且不动文件。 */
  release() {
    if (!this.owned) return false;
    let existing = null;
    try { existing = readLock(this.file); } catch { existing = null; }
    if (!existing) {
      this.owned = false;
      if (fs.existsSync(this.file)) return false;
      this.nonce = null;
      return true;
    }
    const sameRun = existing.runId === this.runId;
    const sameNonce = (this.nonce && existing.nonce) ? existing.nonce === this.nonce : sameRun;
    if (!sameRun || !sameNonce) {
      this.owned = false;
      return false;
    }
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
    this.owned = false;
    this.nonce = null;
    return true;
  }
}
