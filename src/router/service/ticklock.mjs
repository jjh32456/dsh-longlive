// WP4a · tick.lock / issue-style exclusive lock (DESIGN §3.6, D30, K17).
//
// A second Router instance sharing one memoryRoot must never corrupt the WAL
// or duplicate tickets. Ticket issuance is already protected by issue.lock in
// proposals.mjs; the background tick is protected here.
//
// Contention is NOT an error: losing the lock means "skip this round". Dead
// holders are taken over with the five-step CAS protocol, and the old lock is
// renamed to tick.reclaimed-<ts> as evidence (never unlinked).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureDir } from './paths.mjs';

/** D-CR9: reclaim mutex residue is only stale after this floor (2x TTL, min 30s). */
export const RECLAIM_STALE_MIN_MS = 30_000;

function nonce() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export class TickLock {
  constructor({ file, reclaimFile = null, evidencePrefix = 'tick.reclaimed-', maxHoldMs = 240_000, now = () => new Date(), audit = null, logger = null } = {}) {
    this.file = file;
    this.dir = path.dirname(file);
    this.reclaimFile = reclaimFile ?? path.join(this.dir, 'tick.reclaim.lock');
    this.evidencePrefix = evidencePrefix;
    this.maxHoldMs = Number.isFinite(maxHoldMs) ? Math.max(1, Math.trunc(maxHoldMs)) : 240_000;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.audit = audit;
    this.logger = logger;
  }

  #auditSafe(kind, data) {
    try { this.audit?.(kind, data); } catch { /* ignore */ }
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  #writeOwn() {
    const payload = { v: 1, pid: process.pid, host: 'local', startedAt: nowIso() };
    const fd = fs.openSync(this.file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const back = this.read();
    if (!back || back.pid !== process.pid || back.startedAt !== payload.startedAt) {
      try { fs.unlinkSync(this.file); } catch { /* ignore */ }
      return null;
    }
    return back;
  }

  /**
   * Try to own the tick. Returns {ok:true} when this process may tick, and
   * {ok:false, reason:'busy'|'reclaim-busy'} when the round must be skipped.
   * Never throws for contention; a corrupt lock is treated as dead once the
   * stale grace has passed.
   */
  tryAcquire() {
    ensureDir(this.dir);
    try {
      // D-CR15: a failed read-back must not be reported as a successful acquire.
      const own = this.#writeOwn();
      if (!own) return { ok: false, reason: 'busy' };
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // Unreadable/zero-byte leftover younger than the grace period is still
        // someone else's failed attempt: skip instead of stealing.
        const current = this.read();
        if (!current && this.#mtimeAgeMs() < this.maxHoldMs) return { ok: false, reason: 'busy' };
      }
    }
    const current = this.read();
    if (!current) {
      // zero-byte leftover: only take it once stale, via the reclaim protocol
      if (this.#mtimeAgeMs() < this.maxHoldMs) return { ok: false, reason: 'busy' };
      return this.#takeOver(null);
    }
    const startedAt = Date.parse(current.startedAt ?? '');
    const stale = Number.isFinite(startedAt) && (this.now().getTime() - startedAt) > 2 * this.maxHoldMs;
    const dead = current.host === 'local' && !pidAlive(current.pid);
    if (current.host === 'local' && !dead && !stale && pidAlive(current.pid)) return { ok: false, reason: 'busy' };
    if (current.host !== 'local' && !stale) return { ok: false, reason: 'busy' };
    return this.#takeOver(current);
  }

  #mtimeAgeMs() {
    try {
      return this.now().getTime() - fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  #reclaimAgeMs(holder) {
    const started = Date.parse(holder?.startedAt ?? '');
    if (Number.isFinite(started)) return Math.max(0, this.now().getTime() - started);
    try { return Math.max(0, this.now().getTime() - fs.statSync(this.reclaimFile).mtimeMs); } catch { return 0; }
  }

  /**
   * D-CR9: a crash between "rename old lock" and "write new lock" leaves the
   * reclaim mutex behind forever. If it is older than max(2x TTL, 30s) and its
   * holder is a dead local pid (or an aged-out foreign holder), rename it to
   * evidence and retry. A live holder is never stolen.
   */
  #clearStaleReclaim() {
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(this.reclaimFile, 'utf8')); } catch { /* corrupt */ }
    const threshold = Math.max(2 * this.maxHoldMs, RECLAIM_STALE_MIN_MS);
    if (this.#reclaimAgeMs(holder) <= threshold) return false;
    if (holder && holder.host === 'local' && pidAlive(holder.pid)) return false;
    const stamp = nowIso().replace(/[:.]/gu, '-');
    const evidence = `${this.reclaimFile}.reclaimed-${stamp}`;
    try {
      fs.renameSync(this.reclaimFile, evidence);
    } catch {
      return false;
    }
    this.#auditSafe('tick.reclaim_lock.reclaimed', {
      evidence: path.basename(evidence),
      oldPid: holder?.pid ?? null,
      oldStartedAt: holder?.startedAt ?? null,
    });
    return true;
  }

  #openReclaim() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.reclaimFile, 'wx', 0o600);
        const payload = {
          v: 1,
          pid: process.pid,
          host: 'local',
          startedAt: nowIso(),
          nonce: nonce(),
        };
        try {
          fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (!this.#clearStaleReclaim()) return false;
      }
    }
    return false;
  }

  #takeOver(observed) {
    if (!this.#openReclaim()) {
      this.#auditSafe('tick.reclaim_busy', {});
      return { ok: false, reason: 'reclaim-busy' };
    }
    try {
      const current = this.read();
      if (observed) {
        if (!current || current.pid !== observed.pid || current.startedAt !== observed.startedAt) {
          return { ok: false, reason: 'busy' };
        }
      } else if (current && this.#mtimeAgeMs() < this.maxHoldMs) {
        return { ok: false, reason: 'busy' };
      }
      const stamp = nowIso().replace(/[:.]/gu, '-');
      const evidence = path.join(this.dir, `${this.evidencePrefix}${stamp}`);
      if (current) {
        fs.renameSync(this.file, evidence);
      } else if (fs.existsSync(this.file)) {
        fs.renameSync(this.file, evidence);
      }
      this.#auditSafe('tick.reclaim', {
        oldPid: observed?.pid ?? null,
        oldStartedAt: observed?.startedAt ?? null,
        evidence: path.basename(evidence),
      });
      try {
        // D-CR15: read-back failure inside takeover is a lost acquisition.
        const own = this.#writeOwn();
        if (!own) return { ok: false, reason: 'busy' };
      } catch (error) {
        if (error?.code === 'EEXIST') return { ok: false, reason: 'busy' };
        throw error;
      }
      return { ok: true, reclaimed: Boolean(observed), evidence: path.basename(evidence) };
    } finally {
      try { fs.unlinkSync(this.reclaimFile); } catch { /* our own mutex */ }
    }
  }

  release() {
    const current = this.read();
    if (!current) return { ok: true, released: false };
    if (current.pid !== process.pid) return { ok: false, code: 'E_LOCK_NOT_OWNER' };
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
    return { ok: true, released: true };
  }

  status() {
    const current = this.read();
    if (!current) return { held: false, pid: null, startedAt: null };
    return { held: true, pid: current.pid ?? null, startedAt: current.startedAt ?? null };
  }
}

export function createTickLock(options) {
  return new TickLock(options);
}
