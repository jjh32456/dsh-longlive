// WP4a · writer lease (DESIGN §3.6/§5.3, task K21/K26).
//
// A lease is a file created with O_EXCL, never "advisory". The holder identity
// is {sessionId,runId,pid,host}; only that identity may renew or release.
// Reclaim never unlinks a lease: it renames it to locks/reclaimed-<runId>-<ts>
// as evidence (kept 30 days by the operating rules; this module keeps them).
//
// Clock discipline: expiry is checked against BOTH expiresAt and
// acquiredAt+maxHoldMs, taking the larger, so a clock jump backwards cannot
// silently extend a lease forever.
//
// Expiry/crash outcomes are decided by the caller via DESIGN §5.4's three-way
// check — this module never decides the proposal state and never rolls back.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { StoreError } from './store.mjs';
import { ensureDir } from './paths.mjs';

export const LEASE_TTL_MIN_MS = 60_000;
export const LEASE_TTL_MAX_MS = 120_000;
/** D-CR9: minimum age before an abandoned reclaim mutex may be taken over. */
export const LEASE_RECLAIM_STALE_MIN_MS = 30_000;

function nonce() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex');
}

export function clampLeaseTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl)) return LEASE_TTL_MAX_MS;
  return Math.min(LEASE_TTL_MAX_MS, Math.max(LEASE_TTL_MIN_MS, Math.trunc(ttl)));
}

/** Hard cap from DESIGN §3.6: TTL + renewalsMax*(TTL/2). Never hardcode 240s. */
export function computeMaxHoldMs(ttlMs, renewalsMax = 2) {
  const ttl = clampLeaseTtl(ttlMs);
  const renewals = Number.isInteger(renewalsMax) ? Math.max(0, renewalsMax) : 2;
  return ttl + renewals * Math.floor(ttl / 2);
}

export function leasePidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function safeSegment(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 80) || 'unknown';
}

export class WriterLease {
  constructor({ file, lockDir = path.dirname(file), ttlMs = LEASE_TTL_MAX_MS, renewalsMax = 2, holder = {}, now = () => new Date(), audit = null, logger = null } = {}) {
    this.file = file;
    this.lockDir = lockDir;
    this.ttlMs = clampLeaseTtl(ttlMs);
    this.renewalsMax = Number.isInteger(renewalsMax) ? Math.max(0, renewalsMax) : 2;
    this.maxHoldMs = computeMaxHoldMs(this.ttlMs, this.renewalsMax);
    this.holder = {
      sessionId: holder.sessionId ?? null,
      runId: holder.runId ?? `run-${process.pid}-${Date.now().toString(36)}`,
      pid: Number.isInteger(holder.pid) ? holder.pid : process.pid,
      host: holder.host ?? 'local',
    };
    this.now = typeof now === 'function' ? now : () => new Date();
    this.audit = audit;
    this.logger = logger;
    this.lastWallMs = null;
    this.current = null;
  }

  #auditSafe(kind, data) {
    try { this.audit?.(kind, data); } catch { /* audit never blocks the lease */ }
  }

  #logSafe(...args) {
    try { this.logger?.(...args); } catch { /* ignore */ }
  }

  /**
   * Monotonic-ish wall clock: a backwards jump is audited (lease.clock_skew)
   * and the previous wall time is reused, so time-based lease theft cannot
   * happen because the machine clock moved.
   */
  #nowMs() {
    const wall = this.now().getTime();
    if (this.lastWallMs !== null && wall < this.lastWallMs) {
      this.#auditSafe('lease.clock_skew', {
        wallMs: wall,
        previousMs: this.lastWallMs,
        deltaMs: this.lastWallMs - wall,
      });
      return this.lastWallMs;
    }
    this.lastWallMs = Math.max(this.lastWallMs ?? 0, wall);
    return wall;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Both conditions must be false for a lease to be considered expired. */
  isExpired(lease, at = this.#nowMs()) {
    if (!lease) return true;
    const expiresAt = Date.parse(lease.expiresAt ?? '');
    const acquiredAt = Date.parse(lease.acquiredAt ?? '');
    const until = Number.isFinite(expiresAt) ? expiresAt : -Infinity;
    const cap = Number.isFinite(acquiredAt) ? acquiredAt + this.maxHoldMs : Infinity;
    return at > until || at > cap;
  }

  #isOwn(lease) {
    return Boolean(lease)
      && lease?.holder?.runId === this.holder.runId
      && lease?.holder?.pid === this.holder.pid;
  }

  #readbackOwn(ticket) {
    const back = this.read();
    return Boolean(back)
      && back?.holder?.runId === this.holder.runId
      && back?.holder?.pid === this.holder.pid
      && back?.ticket === ticket;
  }

  #writeLease(value) {
    const tmp = path.join(this.lockDir, `.lease-${process.pid}-${Date.now().toString(36)}.tmp`);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    try {
      fs.fsyncSync(fs.openSync(this.lockDir, 'r'));
    } catch { /* directory fsync is best effort on Windows */ }
    return this.read();
  }

  /**
   * D-CR9: reclaim.lock is a mutex, not evidence. A crash can leave it behind
   * forever; take it over only when it is older than max(2x TTL, 30s) and its
   * holder is a dead local pid (or an aged-out foreign holder). The stale file
   * is renamed to *.reclaimed-<ts>, never unlinked.
   */
  #clearStaleReclaimMutex(reclaimFile) {
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(reclaimFile, 'utf8')); } catch { /* corrupt */ }
    const started = Date.parse(holder?.startedAt ?? '');
    let ageMs = null;
    if (Number.isFinite(started)) {
      ageMs = Math.max(0, this.#nowMs() - started);
    } else {
      try { ageMs = Math.max(0, this.#nowMs() - fs.statSync(reclaimFile).mtimeMs); } catch { ageMs = 0; }
    }
    const threshold = Math.max(2 * this.ttlMs, LEASE_RECLAIM_STALE_MIN_MS);
    if (!(ageMs > threshold)) return false;
    if (holder && holder.host === this.holder.host && leasePidAlive(holder.pid)) return false;
    const stamp = iso(this.#nowMs()).replace(/[:.]/gu, '-');
    const evidence = `${reclaimFile}.reclaimed-${stamp}`;
    try {
      fs.renameSync(reclaimFile, evidence);
    } catch {
      return false;
    }
    this.#auditSafe('lease.reclaim_lock.reclaimed', {
      evidence: path.basename(evidence),
      oldPid: holder?.pid ?? null,
      oldStartedAt: holder?.startedAt ?? null,
    });
    return true;
  }

  /** Create the reclaim mutex with an owner identity. Returns {fd,nonce} or null. */
  #openReclaimMutex(reclaimFile) {
    ensureDir(this.lockDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(reclaimFile, 'wx', 0o600);
        const payload = {
          v: 1,
          pid: this.holder.pid,
          host: this.holder.host,
          startedAt: iso(this.#nowMs()),
          nonce: nonce(),
        };
        try {
          fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return { fd: null, nonce: payload.nonce };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (!this.#clearStaleReclaimMutex(reclaimFile)) return null;
      }
    }
    return null;
  }

  #releaseReclaimMutex(reclaimFile, token) {
    if (!token) return;
    let current = null;
    try { current = JSON.parse(fs.readFileSync(reclaimFile, 'utf8')); } catch { return; }
    if (!current || current.nonce !== token.nonce) return;
    try { fs.unlinkSync(reclaimFile); } catch { /* only our own mutex */ }
  }

  /**
   * D-CR10: a lease is alive when the local pid is alive, and for a foreign
   * host when it has not expired. Never reclaim a live foreign lease.
   */
  #alive(lease, at = this.#nowMs()) {
    const holder = lease?.holder;
    if (!holder) return false;
    if (holder.host === this.holder.host) return leasePidAlive(holder.pid);
    return !this.isExpired(lease, at);
  }

  /**
   * Reclaim a zero-byte / unparsable lease left by a crashed writer. This is
   * evidence, not garbage: the bytes are renamed to reclaimed-corrupt-<ts>.json
   * under the same reclaim.lock mutex as the normal expiry protocol.
   */
  #reclaimCorrupt() {
    ensureDir(this.lockDir);
    const reclaimFile = path.join(this.lockDir, 'reclaim.lock');
    const token = this.#openReclaimMutex(reclaimFile);
    if (!token) return { ok: false, reason: 'reclaim-busy' };
    try {
      const current = this.read();
      if (current) return { ok: false, reason: 'changed' };
      if (!fs.existsSync(this.file)) return { ok: false, reason: 'gone' };
      const stamp = iso(this.#nowMs()).replace(/[:.]/gu, '-');
      const evidenceName = `reclaimed-corrupt-${stamp}.json`;
      fs.renameSync(this.file, path.join(this.lockDir, evidenceName));
      this.#auditSafe('lease.expired', {
        ticket: null, proposalId: null, holder: null, runId: null, pid: null,
        heldMs: null, renewals: null, evidence: evidenceName, reason: 'zero-or-corrupt',
      });
      return { ok: true, evidence: evidenceName };
    } catch (error) {
      return { ok: false, reason: 'reclaim-failed' };
    } finally {
      this.#releaseReclaimMutex(reclaimFile, token);
    }
  }

  /**
   * Acquire the lease. Returns {ok:true,lease} or {ok:false,code} — never a
   * half/zero-byte lease. On readback failure the own file is unlinked and the
   * acquisition retried once.
   */
  acquire({ ticket = null, proposalId = null } = {}) {
    ensureDir(this.lockDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const at = this.#nowMs();
      const existing = this.read();
      if (!existing && fs.existsSync(this.file)) {
        const reclaimed = this.#reclaimCorrupt();
        if (reclaimed.ok) continue;
        return { ok: false, code: 'E_LEASE_HELD' };
      }
      if (existing) {
        const holderAlive = this.#alive(existing, at);
        if (!this.isExpired(existing, at) && holderAlive) {
          return { ok: false, code: 'E_LEASE_HELD', holder: existing?.holder?.sessionId ?? null, lease: existing };
        }
        const reclaim = this.reclaim({ reason: this.isExpired(existing, at) ? 'expired' : 'dead-holder', observed: existing });
        if (!reclaim.ok) {
          return { ok: false, code: 'E_LEASE_HELD', holder: existing?.holder?.sessionId ?? null, lease: existing, reclaim: reclaim.reason };
        }
        continue;
      }
      const acquiredMs = at;
      const payload = {
        v: 1,
        holder: { ...this.holder },
        ticket,
        proposalId,
        acquiredAt: iso(acquiredMs),
        expiresAt: iso(acquiredMs + this.ttlMs),
        ttlMs: this.ttlMs,
        renewals: 0,
      };
      let fd = null;
      try {
        fd = fs.openSync(this.file, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
          fd = null;
        }
        if (!this.#readbackOwn(ticket)) {
          try { fs.unlinkSync(this.file); } catch { /* already gone */ }
          if (attempt === 0) continue;
          throw new StoreError('E_LEASE_WRITE', 'lease read-back did not match the holder');
        }
        this.current = this.read();
        this.#auditSafe('lease.acquire', {
          ticket,
          proposalId,
          sessionId: this.holder.sessionId,
          runId: this.holder.runId,
          pid: this.holder.pid,
          expiresAt: payload.expiresAt,
          ttlMs: this.ttlMs,
        });
        return { ok: true, lease: this.current };
      } catch (error) {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        if (error?.code === 'EEXIST') continue;
        // A failed write must not leave a zero-byte or half-written lease.
        try {
          const content = fs.readFileSync(this.file, 'utf8');
          if (content.trim() === '') fs.unlinkSync(this.file);
        } catch { /* no file left */ }
        if (attempt === 0 && error?.code !== 'E_LEASE_WRITE') continue;
        throw error;
      }
    }
    return { ok: false, code: 'E_LEASE_HELD' };
  }

  /**
   * Reclaim an expired/dead lease. Only reclaim.lock is unlinked afterwards;
   * the old lease is renamed to reclaimed-<runId>-<ts>.json as evidence.
   */
  reclaim({ reason = 'expired', observed = null, force = false } = {}) {
    ensureDir(this.lockDir);
    const reclaimFile = path.join(this.lockDir, 'reclaim.lock');
    const token = this.#openReclaimMutex(reclaimFile);
    if (!token) return { ok: false, reason: 'reclaim-busy' };
    try {
      const current = this.read();
      if (!current) return { ok: false, reason: 'gone' };
      // D-CR10: CAS on runId + expiresAt; pid/acquiredAt are diagnostics only.
      if (observed && (current?.holder?.runId !== observed?.holder?.runId
        || (observed?.expiresAt !== undefined && current?.expiresAt !== observed?.expiresAt))) {
        return { ok: false, reason: 'changed' };
      }
      const alive = this.#alive(current);
      if (!force && !this.isExpired(current) && alive) return { ok: false, reason: 'alive' };
      const stamp = iso(this.#nowMs()).replace(/[:.]/gu, '-');
      const evidenceName = `reclaimed-${safeSegment(current?.holder?.runId)}-${stamp}.json`;
      const evidence = path.join(this.lockDir, evidenceName);
      fs.renameSync(this.file, evidence);
      this.#auditSafe('lease.expired', {
        ticket: current?.ticket ?? null,
        proposalId: current?.proposalId ?? null,
        holder: current?.holder?.sessionId ?? null,
        runId: current?.holder?.runId ?? null,
        pid: current?.holder?.pid ?? null,
        heldMs: Date.parse(current?.acquiredAt ?? '') ? this.#nowMs() - Date.parse(current.acquiredAt) : null,
        renewals: Number.isInteger(current?.renewals) ? current.renewals : null,
        evidence: evidenceName,
        reason,
      });
      // K-02: the reclaim itself is an auditable lock action, not just the
      // expiry observation. Evidence has already been renamed into place.
      this.#auditSafe('lease.reclaimed', {
        ticket: current?.ticket ?? null,
        proposalId: current?.proposalId ?? null,
        holder: current?.holder?.sessionId ?? null,
        evidence: evidenceName,
        reason,
      });
      return { ok: true, evidence, evidenceName, lease: current };
    } catch (error) {
      throw error;
    } finally {
      // Only remove the reclaim mutex we created; never the evidence files.
      this.#releaseReclaimMutex(reclaimFile, token);
    }
  }

  /**
   * Maintenance entry: reclaim only when the current lease is expired or its
   * holder is a definitely-dead local pid. Returns {ok, reclaimed|reason}.
   */
  reclaimIfNeeded() {
    const current = this.read();
    if (!current) return { ok: true, reclaimed: false, reason: 'none' };
    if (!this.isExpired(current) && this.#alive(current)) {
      return { ok: true, reclaimed: false, reason: 'alive' };
    }
    return this.reclaim({ reason: this.isExpired(current) ? 'expired' : 'dead-holder', observed: current });
  }

  /** Extend by TTL/2; renewals are capped by renewalsMax (already at cap → void). */
  renew() {
    const at = this.#nowMs();
    const current = this.read();
    if (!current) return { ok: false, code: 'E_LEASE_MISSING' };
    if (!this.#isOwn(current)) return { ok: false, code: 'E_LEASE_NOT_OWNER' };
    if (this.isExpired(current, at)) return { ok: false, code: 'E_LEASE_EXPIRED' };
    const renewals = Number.isInteger(current.renewals) ? current.renewals : 0;
    if (renewals >= this.renewalsMax) return { ok: false, code: 'E_LEASE_MAX_HOLD' };
    const nextExpires = Math.min(
      Date.parse(current.expiresAt) + Math.floor(this.ttlMs / 2),
      Date.parse(current.acquiredAt) + this.maxHoldMs,
    );
    const next = {
      ...current,
      renewals: renewals + 1,
      expiresAt: iso(nextExpires),
    };
    const back = this.#writeLease(next);
    if (!back || back?.renewals !== next.renewals) {
      throw new StoreError('E_LEASE_WRITE', 'lease renewal read-back mismatch');
    }
    this.current = back;
    this.#auditSafe('lease.renew', {
      ticket: back.ticket,
      proposalId: back.proposalId,
      runId: this.holder.runId,
      renewals: back.renewals,
      expiresAt: back.expiresAt,
    });
    return { ok: true, lease: back };
  }

  /**
   * Holder self-check used before snapshot / tmp write / rename. A missing,
   * foreign or expired lease means the writer must stop (DESIGN §5.3).
   */
  check({ phase = null } = {}) {
    const current = this.read();
    if (!current) return { ok: false, code: 'E_LEASE_MISSING', phase };
    if (!this.#isOwn(current)) return { ok: false, code: 'E_LEASE_NOT_OWNER', phase };
    if (this.isExpired(current)) return { ok: false, code: 'E_LEASE_EXPIRED', phase };
    return { ok: true, lease: current, phase };
  }

  /** Release only our own lease, with a byte-level identity check. */
  release() {
    const current = this.read();
    if (!current) return { ok: true, released: false };
    if (!this.#isOwn(current)) return { ok: false, code: 'E_LEASE_NOT_OWNER' };
    fs.unlinkSync(this.file);
    let gone = false;
    try { fs.accessSync(this.file); } catch { gone = true; }
    if (!gone) throw new StoreError('E_LEASE_RELEASE', 'lease still exists after unlink');
    this.current = null;
    this.#auditSafe('lease.release', {
      ticket: current.ticket,
      proposalId: current.proposalId,
      runId: this.holder.runId,
      renewals: current.renewals,
    });
    return { ok: true, released: true };
  }

  status() {
    const lease = this.read();
    if (!lease) return { active: false, holder: null, since: null, renewals: 0, expiresAt: null };
    if (this.isExpired(lease)) return { active: false, holder: lease?.holder?.sessionId ?? null, since: lease.acquiredAt ?? null, renewals: lease.renewals ?? 0, expiresAt: lease.expiresAt ?? null };
    return {
      active: true,
      holder: lease?.holder?.sessionId ?? null,
      since: lease.acquiredAt ?? null,
      renewals: lease.renewals ?? 0,
      expiresAt: lease.expiresAt ?? null,
    };
  }
}

export function createWriterLease(options) {
  return new WriterLease(options);
}
