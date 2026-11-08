// WP4b · apply nine-step write protocol (DESIGN §5.3a, F29/D31, K4/K8/K19/L-05).
//
// Steps (each numbered below in apply()):
//   1. acquire writer lease (fail → state "queued", not "busy")
//   2. re-read proposal from disk; it must still be approved
//   3. re-read target sha; it must equal baseSha, else conflict with zero writes
//   4. WAL apply.begin(baseSha, afterSha, snapshot) + fsync
//   5. snapshot original bytes to disk; verify sha == baseSha
//   6. write <target>.tmp-<proposalId>, fsync, close — no rename yet
//   7. last recheck: third target sha read + tmp complete; mismatch → delete tmp,
//      WAL apply.abort(owner-write-race), conflict, zero writes
//   8. rename + fsync(dir); readback must equal afterSha; else conflict +
//      RESTORE_REQUIRED (record actual sha, never auto-rollback, D31)
//   9. release lease, advance queue, audit
//
// Writers never "repair" conflicting targets. A snapshot is evidence, not a
// rollback trigger.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  appendJsonLineDurable,
  readProposal,
  readTargetSnapshot,
  scanProposalDir,
  updateProposalStrict,
  StoreError,
} from './store.mjs';import { ensureDir } from './paths.mjs';
import { sortQueueEntries } from './queue.mjs';
import { isSubagentCaller } from './caller.mjs';

const SNAPSHOT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

class TestCrash extends Error {
  constructor(phase) {
    super(`test crash at ${phase}`);
    this.code = 'E_TEST_CRASH';
    this.phase = phase;
  }
}

function isoNow(date) {
  return date.toISOString();
}

function sha256Buffer(buffer) {
  // Bare lowercase hex: the public contract compares it to the file digest the
  // host reports (N-01), and the `sha256:` prefix on persisted proposal content
  // is a different field (contentSha), not a target digest.
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function ensureTrailingNewline(text) {
  if (text === '') return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}

function trimTrailingBlank(text) {
  return text.replace(/\n+$/u, '');
}

/**
 * Deterministic content transforms for the five proposal ops. DESIGN §7.2 fixes
 * the targets but not the byte layout; this is the single documented layout.
 * - journal.append / topic.append: keep the file, add one blank line, append the
 *   content block at EOF (missing file gets a `# <basename>` header).
 * - state.section: replace the body of `## <title>` up to the next `## ` heading.
 * - index.row: append exactly one row line at EOF.
 * - handover.create: new file containing the content block.
 */
export function buildAfterContent(proposal, beforeText) {
  const op = proposal.op;
  const content = ensureTrailingNewline(String(proposal.content ?? ''));
  const before = String(beforeText ?? '');
  if (op === 'journal.append' || op === 'topic.append') {
    if (before.trim() === '') {
      const base = path.basename(proposal.target, '.md');
      return `# ${base}\n\n${content}`;
    }
    return `${trimTrailingBlank(before)}\n\n${content}`;
  }
  if (op === 'state.section') {
    const title = String(proposal.title ?? '').trim();
    if (!title) throw new StoreError('E_BAD_CONTENT', 'state.section is missing its section title');
    const lines = before.split('\n');
    const start = lines.findIndex((line) => line.trim() === `## ${title}`.trim());
    if (start === -1) throw new StoreError('E_BAD_CONTENT', `section not found: ${title}`);
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^##\s+/u.test(lines[index])) { end = index; break; }
    }
    const head = lines.slice(0, start + 1);
    const tail = lines.slice(end);
    const bodyLines = content.replace(/\n$/u, '').split('\n');
    const next = [...head, '', ...bodyLines, '', ...tail];
    return ensureTrailingNewline(next.join('\n').replace(/\n{3,}/gu, '\n\n'));
  }
  if (op === 'index.row') {
    const row = content.trim();
    if (!row.startsWith('|')) throw new StoreError('E_BAD_CONTENT', 'index.row content must be a table row');
    return `${trimTrailingBlank(before)}\n${row}\n`;
  }
  if (op === 'handover.create') {
    return content;
  }
  throw new StoreError('E_BAD_CONTENT', `unsupported op: ${op}`);
}

export class Applier {
  constructor({
    paths = null,
    vaultDir = paths?.vaultDir,
    memoryRoot = null,
    config = {},
    lease = null,
    wal = null,
    queue = null,
    wake = null,
    audit = null,
    now = () => new Date(),
    logger = null,
    testHooks = null,
    caller = {},
    onWarning = null,
  } = {}) {
    this.paths = paths;
    this.vaultDir = vaultDir;
    this.memoryRoot = memoryRoot ?? paths?.liveRoot ?? null;
    this.proposalsDir = paths?.proposalsDir ?? path.join(this.vaultDir, 'proposals');
    this.snapshotsDir = path.join(this.vaultDir, 'snapshots');
    this.snapshotManifest = path.join(this.snapshotsDir, 'manifest.jsonl');
    this.config = config;
    this.audit = audit;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.logger = logger;
    this.testHooks = testHooks && typeof testHooks === 'object' ? testHooks : null;
    this.caller = caller ?? {};
    this.onWarning = typeof onWarning === 'function' ? onWarning : null;
    this.runId = `apply-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.holder = {
      sessionId: this.caller.sessionId ?? 'owner-cli',
      runId: this.runId,
      pid: process.pid,
      host: 'local',
    };
    this.lease = lease;
    this.wal = wal;
    this.queue = queue;
    this.wake = wake;
  }

  #auditSafe(kind, data) {
    try { this.audit?.(kind, data); } catch { /* ignore */ }
  }

  #warn(code) {
    this.#auditSafe('warn', { code });
    // D-CR17: warnings must reach the service status, not only the audit log.
    try { this.onWarning?.(code); } catch { /* a warning sink must never break a write */ }
  }

  #scan() {
    return scanProposalDir(this.proposalsDir);
  }

  #injected(name) {
    const hooks = this.testHooks;
    if (!hooks) return false;
    const value = hooks[name];
    if (value === true) {
      hooks[name] = false;
      return true;
    }
    if (typeof value === 'function') return value() === true;
    return false;
  }

  #updateProposal(id, mutate, { expectRev = null } = {}) {
    return updateProposalStrict(this.proposalsDir, id, expectRev, (current) => {
      const next = mutate(current) ?? current;
      const { __file, ...clean } = next;
      return clean;
    }, { now: () => this.now() });
  }

  #readTarget(proposal) {
    const absolute = path.resolve(this.memoryRoot ?? path.dirname(this.proposalsDir), proposal.target);
    const snapshot = readTargetSnapshot(absolute);
    if (!snapshot.ok) return { ok: false, code: snapshot.code, message: snapshot.message ?? null };
    if (!snapshot.exists) return { ok: true, exists: false, sha256: null, bytes: 0, buffer: Buffer.alloc(0), text: '', absolute };
    const buffer = fs.readFileSync(absolute);
    return {
      ok: true,
      exists: true,
      sha256: sha256Buffer(buffer),
      bytes: buffer.length,
      buffer,
      text: buffer.toString('utf8'),
      absolute,
    };
  }

  #conflict(proposal, { code = 'E_BASE_MOVED', reason = 'base-moved', note = null, phase = null, extra = null } = {}) {
    const next = this.#updateProposal(proposal.id, (current) => ({
      ...current,
      status: 'conflict',
      queue: { ...current.queue, lease: null, blockedReason: null },
      conflict: { code, reason, phase, at: isoNow(this.now()), ...(extra ?? {}) },
      result: current.result ?? null,
      stateLog: [...(current.stateLog ?? []), {
        at: isoNow(this.now()),
        from: current.status,
        to: 'conflict',
        by: 'router',
        note: note ?? reason,
      }],
    }), { expectRev: proposal.rev });
    return next;
  }

  #tmpPath(absolute, proposalId) {
    return `${absolute}.tmp-${proposalId}`;
  }

  #fsyncDir(dir) {
    try {
      const fd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* directory fsync is best effort on Windows */ }
  }

  #snapshotName(proposal, target) {
    const stamp = isoNow(this.now()).replace(/[:.]/gu, '-');
    return path.join('snapshots', `${stamp}-${proposal.id}-${path.basename(target)}.bak`);
  }

  #writeSnapshot(proposal, target, buffer, baseSha, relative) {
    ensureDir(this.snapshotsDir);
    const file = path.join(this.vaultDir, relative);
    const fd = fs.openSync(file, 'w', 0o600);
    try {
      fs.writeFileSync(fd, buffer);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const back = fs.readFileSync(file);
    const actual = sha256Buffer(back);
    if (actual !== baseSha) throw new StoreError('E_SNAPSHOT', 'snapshot read-back sha mismatch', { expected: baseSha, actual });
    appendJsonLineDurable(this.snapshotManifest, {
      proposalId: proposal.id,
      target: proposal.target,
      beforeSha: baseSha,
      bytes: buffer.length,
      snapshot: relative,
      at: isoNow(this.now()),
    });
    return { file, relative };
  }

  #releaseLease() {
    try {
      return this.lease?.release?.() ?? { ok: true };
    } catch (error) {
      this.#auditSafe('lease.release_failed', { error: String(error?.message ?? error) });
      return { ok: false };
    }
  }

  #headApproved(proposals) {
    const approved = sortQueueEntries(proposals
      .filter((proposal) => proposal.status === 'approved')
      .map((proposal) => ({
        ticket: proposal.queue?.ticket ?? null,
        effectivePriority: proposal.queue?.effectivePriority ?? proposal.queue?.priority ?? 'P3',
        queuedAt: proposal.queue?.queuedAt ?? proposal.createdAt,
        proposal,
      })));
    return approved[0]?.proposal ?? null;
  }

  /**
   * Public read-only view of the queue head. Used by
   * service.requestApply to resolve a no-id apply/rollback before the
   * confirm check (D-CR3); the selection matches the one apply() uses.
   */
  headApproved() {
    return this.#headApproved(this.#scan().proposals);
  }

  /**
   * Apply exactly one approved proposal — only the queue head, never preempt.
   * Returns ok:false with a stable code on failure; a "queued" result is NOT an
   * error (design deletes the old E_LEASE_HELD outward code).
   */
  async apply(args = {}, options = {}) {
    // Guard: applying is an owner-level operation. The gate must look at the
    // per-call caller (D-CR2); the instance caller is only a fallback.
    if (this.config.applyEnabled !== true) return { ok: false, code: 'E_APPLY_DISABLED' };
    const caller = options?.caller ?? this.caller;
    if (isSubagentCaller(caller)) return { ok: false, code: 'E_NOT_MAIN_SESSION' };

    const scan = this.#scan();
    let proposal = null;
    if (args.id) {
      proposal = scan.proposals.find((candidate) => candidate.id === args.id) ?? null;
      if (!proposal) return { ok: false, code: 'E_TICKET_UNKNOWN', ticket: args.ticket ?? null };
      if (proposal.status !== 'approved') return { ok: false, code: 'E_BAD_STATE', id: proposal.id, state: proposal.status };
      const head = this.#headApproved(scan.proposals);
      if (head && head.id !== proposal.id) {
        return { ok: true, state: 'queued', id: proposal.id, ticket: proposal.queue?.ticket ?? null, position: null, message: 'waiting behind the queue head' };
      }
    } else {
      proposal = this.#headApproved(scan.proposals);
      if (!proposal) return { ok: true, state: 'idle', message: 'no approved proposal' };
      if (args.ticket && args.ticket !== proposal.queue?.ticket) {
        return { ok: false, code: 'E_TICKET_UNKNOWN', ticket: args.ticket };
      }
    }

    const ticket = proposal.queue?.ticket ?? null;
    const proposalId = proposal.id;

    // STEP 1 — acquire the writer lease. Failure is "still queued", never a busy
    // error. §5.6: wait at most the configured window, then degrade to
    // blocked-on-user/LEASE_TIMEOUT with the single timeout code E_WAIT_TIMEOUT.
    // Cap the in-process wait (a CLI apply must not hang for a five-minute lease
    // window); queue maintain still owns the long-window transition.
    let acquired = this.lease.acquire({ ticket, proposalId });
    // A short configured window (?5000ms) is an explicit caller request for the
    // bounded E_WAIT_TIMEOUT contract (L-04). The default long window keeps the
    // legacy non-blocking "queued" reply; queue.maintain owns that transition.
    const configuredWait = Number(this.config.leaseWaitTimeoutMs);
    const fastTimeout = Number.isFinite(configuredWait) && configuredWait > 0 && configuredWait <= 5000;
    if (!acquired.ok && fastTimeout) {
      const waitMs = Math.min(configuredWait, 1500);
      const deadline = Date.now() + waitMs;
      while (!acquired.ok && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        acquired = this.lease.acquire({ ticket, proposalId });
      }
    }
    if (!acquired.ok && !fastTimeout) {
      return { ok: true, state: 'queued', id: proposalId, ticket, holder: acquired.holder ?? null };
    }
    if (!acquired.ok) {
      const blockedTtlMs = Number(this.config.blockedOnUserTtlMs) || 86_400_000;
      const at = isoNow(this.now());
      const next = this.#updateProposal(proposalId, (current) => ({
        ...current,
        status: 'blocked-on-user',
        queue: {
          ...current.queue,
          lease: null,
          blockedReason: 'LEASE_TIMEOUT',
          deadlineAt: isoNow(new Date(this.now().getTime() + blockedTtlMs)),
        },
        reason: 'LEASE_TIMEOUT',
        stateLog: [...(current.stateLog ?? []), { at, from: 'approved', to: 'blocked-on-user', by: 'router', note: 'LEASE_TIMEOUT' }],
      }));
      this.#auditSafe('proposal.blocked', { proposalId, ticket, reason: 'LEASE_TIMEOUT' });
      return {
        ok: false,
        code: 'E_WAIT_TIMEOUT',
        state: 'blocked-on-user',
        reason: 'LEASE_TIMEOUT',
        id: proposalId,
        ticket,
        holder: acquired.holder ?? null,
        message: 'writer lease wait timed out; owner adjudication required',
        deadlineAt: next?.queue?.deadlineAt ?? null,
      };
    }
    this.wal.append('lease.acquire', { ticket, proposalId, runId: this.runId, pid: process.pid });

    let phase = 'validate';
    try {
      // STEP 2 — re-read from disk; it must still be approved (and not a stale rev).
      const fresh = readProposal(this.proposalsDir, proposalId);
      if (!fresh || fresh.status !== 'approved') {
        this.#releaseLease();
        return { ok: false, code: 'E_BAD_STATE', id: proposalId, state: fresh?.status ?? 'missing' };
      }
      proposal = fresh;

      // STEP 3 — target sha must equal baseSha. Any mismatch is a conflict with
      // zero writes (no snapshot, no tmp, no canonical touch).
      const target = this.#readTarget(proposal);
      if (!target.ok) {
        this.#conflict(proposal, { code: target.code, reason: 'target-unreadable', phase: 'validate' });
        this.#releaseLease();
        return { ok: false, code: target.code, id: proposalId, ticket, state: 'conflict' };
      }
      // Proposal digests are bare lowercase hex in 1.1.1; accept a legacy
      // `sha256:`-prefixed baseSha from a 1.1.0 vault without re-writing it.
      const baseSha = typeof proposal.baseSha === 'string'
        ? proposal.baseSha.replace(/^sha256:/u, '').toLowerCase()
        : (proposal.baseSha ?? null);
      if (target.exists) {
        if (!baseSha || target.sha256 !== baseSha) {
          this.#conflict(proposal, {
            code: 'E_BASE_MOVED',
            reason: 'base-moved',
            phase: 'validate',
            extra: { expectedSha: baseSha, actualSha: target.sha256 },
          });
          this.#auditSafe('apply.conflict', { proposalId, ticket, reason: 'base-moved', phase: 'validate', expectedSha: baseSha, actualSha: target.sha256 });
          this.#releaseLease();
          return { ok: false, code: 'E_BASE_MOVED', id: proposalId, ticket, state: 'conflict' };
        }
      } else if (baseSha) {
        this.#conflict(proposal, { code: 'E_TARGET_MISSING', reason: 'target-missing', phase: 'validate', extra: { expectedSha: baseSha, actualSha: null } });
        this.#releaseLease();
        return { ok: false, code: 'E_TARGET_MISSING', id: proposalId, ticket, state: 'conflict' };
      }

      let afterText;
      try {
        afterText = buildAfterContent(proposal, target.text);
      } catch (error) {
        this.#conflict(proposal, { code: 'E_BAD_CONTENT', reason: 'content-transform', phase: 'validate' });
        this.#releaseLease();
        return { ok: false, code: 'E_BAD_CONTENT', id: proposalId, ticket, state: 'conflict' };
      }
      const afterBuffer = Buffer.from(afterText, 'utf8');
      const afterSha = sha256Buffer(afterBuffer);
      const snapshotRelative = this.#snapshotName(proposal, target.absolute);

      const holderCheck = this.lease.check({ phase: 'pre-begin' });
      if (!holderCheck.ok) {
        this.#releaseLease();
        return { ok: false, code: holderCheck.code, id: proposalId, ticket, state: 'queued' };
      }

      // STEP 4 — WAL apply.begin + fsync BEFORE any canonical/dir side effect.
      this.wal.append('apply.begin', {
        ticket,
        proposalId,
        op: proposal.op,
        target: proposal.target,
        baseSha,
        afterSha,
        snapshot: snapshotRelative,
        bytesAfter: afterBuffer.length,
      });
      phase = 'begin';
      proposal = this.#updateProposal(proposalId, (current) => ({
        ...current,
        status: 'applying',
        queue: {
          ...current.queue,
          lease: {
            holder: this.holder.sessionId,
            pid: this.holder.pid,
            host: this.holder.host,
            runId: this.runId,
            acquiredAt: acquired.lease?.acquiredAt ?? isoNow(this.now()),
            expiresAt: acquired.lease?.expiresAt ?? null,
            renewals: 0,
          },
        },
        stateLog: [...(current.stateLog ?? []), {
          at: isoNow(this.now()),
          from: 'approved',
          to: 'applying',
          by: 'router',
          note: 'apply.begin',
        }],
      }), { expectRev: proposal.rev });

      // STEP 5 — snapshot original bytes and verify sha == baseSha.
      phase = 'snapshot';
      let snapshot = null;
      try {
        if (this.#injected('failSnapshot')) throw new StoreError('E_SNAPSHOT', 'injected snapshot failure');
        snapshot = this.#writeSnapshot(proposal, target.absolute, target.buffer, baseSha ?? sha256Buffer(Buffer.alloc(0)), snapshotRelative);
      } catch (error) {
        this.wal.append('apply.abort', { ticket, proposalId, reason: 'snapshot-failed', phase: 'snapshot' });
        this.#auditSafe('snapshot_failed', { proposalId, ticket, error: String(error?.message ?? error) });
        this.#auditSafe('apply.abort', { proposalId, ticket, reason: 'snapshot-failed', phase: 'snapshot' });
        this.#conflict(proposal, { code: 'E_SNAPSHOT_FAILED', reason: 'snapshot-failed', phase: 'snapshot' });
        this.#releaseLease();
        return { ok: false, code: 'E_SNAPSHOT_FAILED', id: proposalId, ticket, state: 'conflict' };
      }

      // STEP 6 — write tmp in the same directory, fsync + close. No rename yet.
      phase = 'tmp';
      const tmpFile = this.#tmpPath(target.absolute, proposalId);
      try {
        fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
        const fd = fs.openSync(tmpFile, 'w', 0o600);
        try {
          fs.writeFileSync(fd, afterBuffer);
          if (this.#injected('failFsync')) throw new StoreError('E_IO', 'injected fsync failure');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        if (this.#injected('failWriteAfter')) throw new TestCrash('after-tmp-write');
      } catch (error) {
        if (error instanceof TestCrash) throw error;
        try { fs.unlinkSync(tmpFile); } catch { /* no tmp */ }
        this.wal.append('apply.abort', { ticket, proposalId, reason: 'write-failed', phase: 'tmp-write' });
        this.#auditSafe('apply.abort', { proposalId, ticket, reason: 'write-failed', phase: 'tmp-write' });
        this.#conflict(proposal, { code: 'E_IO', reason: 'tmp-write-failed', phase: 'tmp-write' });
        this.#releaseLease();
        return { ok: false, code: 'E_IO', id: proposalId, ticket, state: 'conflict' };
      }

      // STEP 7 — final recheck: third target read + complete tmp. Any change means
      // an owner wrote during our window: delete tmp, zero canonical bytes.
      phase = 'recheck';
      const holderCheck2 = this.lease.check({ phase: 'pre-rename' });
      if (!holderCheck2.ok) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        this.wal.append('apply.abort', { ticket, proposalId, reason: 'lease-lost', phase: 'pre-rename' });
        this.#conflict(proposal, { code: holderCheck2.code, reason: 'lease-lost', phase: 'pre-rename' });
        return { ok: false, code: holderCheck2.code, id: proposalId, ticket, state: 'conflict' };
      }
      const finalTarget = this.#readTarget(proposal);
      const tmpBytes = (() => {
        try { return fs.statSync(tmpFile).size; } catch { return null; }
      })();
      // Consume the "skip one injection" hook without changing the outcome —
      // it exists so tests can prove the next apply is unaffected by a pending
      // force. forceInjection deliberately fails this recheck.
      this.#injected('skipInjectionOnce');
      const recheckOk = finalTarget.ok
        && ((!finalTarget.exists && !baseSha) || (finalTarget.exists && finalTarget.sha256 === baseSha))
        && tmpBytes === afterBuffer.length
        && !this.#injected('forceInjection');
      if (!recheckOk) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        this.wal.append('apply.abort', { ticket, proposalId, reason: 'owner-write-race', phase: 'pre-rename' });
        this.#auditSafe('apply.abort', { proposalId, ticket, reason: 'owner-write-race', phase: 'pre-rename' });
        this.#conflict(proposal, { code: 'E_BASE_MOVED', reason: 'owner-write-race', phase: 'pre-rename', extra: { expectedSha: baseSha, actualSha: finalTarget.ok ? finalTarget.sha256 : null } });
        this.#warn('OWNER_WRITE_RACE');
        this.#releaseLease();
        return { ok: false, code: 'E_BASE_MOVED', id: proposalId, ticket, state: 'conflict', reason: 'owner-write-race' };
      }

      // STEP 8 — rename into place, fsync dir, read back.
      phase = 'rename';
      let renameError = null;
      try {
        fs.renameSync(tmpFile, target.absolute);
        this.#fsyncDir(path.dirname(target.absolute));
      } catch (error) {
        renameError = error;
      }
      if (renameError) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        this.wal.append('apply.abort', { ticket, proposalId, reason: 'rename-failed', phase: 'rename' });
        this.#conflict(proposal, { code: 'E_IO', reason: 'rename-failed', phase: 'rename' });
        this.#releaseLease();
        return { ok: false, code: 'E_IO', id: proposalId, ticket, state: 'conflict' };
      }
      phase = 'readback';
      let actual = null;
      try {
        actual = sha256Buffer(fs.readFileSync(target.absolute));
      } catch {
        actual = null;
      }
      const readbackOk = !this.#injected('failReadback') && actual === afterSha;
      if (!readbackOk) {
        this.wal.append('apply.conflict', {
          ticket,
          proposalId,
          reason: 'readback-mismatch',
          phase: 'after-rename',
          expectedSha: afterSha,
          actualSha: actual,
        });
        this.wal.append('restore.required', {
          ticket,
          proposalId,
          reason: 'readback-mismatch',
          expectedSha: afterSha,
          actualSha: actual,
          snapshot: snapshot?.relative ?? snapshotRelative,
        });
        this.#auditSafe('apply.conflict', { proposalId, ticket, reason: 'readback-mismatch', phase: 'after-rename', expectedSha: afterSha, actualSha: actual });
        this.#warn('RESTORE_REQUIRED');
        const conflicted = this.#conflict(proposal, {
          code: 'RESTORE_REQUIRED',
          reason: 'readback-mismatch',
          phase: 'after-rename',
          extra: { expectedSha: afterSha, actualSha: actual, restoreRequired: true, snapshot: snapshot?.relative ?? snapshotRelative },
        });
        // Restore_required is recorded on the proposal; never auto-rollback (B-04).
        this.#updateProposal(proposalId, (current) => ({
          ...current,
          result: {
            appliedAt: null,
            beforeSha: baseSha,
            afterSha,
            bytesAdded: afterBuffer.length - (target.bytes ?? 0),
            snapshot: snapshot?.relative ?? snapshotRelative,
            restoreRequired: true,
            actualSha: actual,
          },
        }), { expectRev: conflicted.rev });
        this.#releaseLease();
        return { ok: false, code: 'E_RESTORE_REQUIRED', id: proposalId, ticket, state: 'conflict', restoreRequired: true, actualSha: actual };
      }

      // STEP 9 — WAL apply.done, proposal done, lease release, queue advance, audit.
      const result = {
        appliedAt: isoNow(this.now()),
        beforeSha: baseSha,
        afterSha,
        bytesAdded: afterBuffer.length - (target.bytes ?? 0),
        snapshot: snapshot.relative,
      };
      this.wal.append('apply.done', { ticket, proposalId, beforeSha: baseSha, afterSha, snapshot: snapshot.relative });
      this.#updateProposal(proposalId, (current) => ({
        ...current,
        status: 'done',
        queue: { ...current.queue, lease: null, blockedReason: null },
        result,
        conflict: null,
        stateLog: [...(current.stateLog ?? []), {
          at: isoNow(this.now()),
          from: 'applying',
          to: 'done',
          by: 'router',
          note: 'apply.done',
        }],
      }), { expectRev: proposal.rev });
      this.#auditSafe('apply.done', { proposalId, ticket, beforeSha: baseSha, afterSha, bytesAdded: result.bytesAdded });
      this.#releaseLease();
      this.queue?.rebuild?.();
      return { ok: true, state: 'done', id: proposalId, ticket, result };
    } catch (error) {
      if (error instanceof TestCrash) {
        // Simulated kill: leave tmp + applying + lease for restart recovery (K8).
        this.#auditSafe('apply.crash_simulated', { proposalId, ticket, phase: error.phase });
        throw error;
      }
      this.#auditSafe('apply.error', { proposalId, ticket, phase, error: String(error?.message ?? error) });
      try { this.#releaseLease(); } catch { /* ignore */ }
      throw error;
    }
  }

  /**
   * Owner rollback (DESIGN §5.9): only a done proposal whose target still equals
   * result.afterSha may be restored from its snapshot. Never auto-triggered.
   */
  async rollback(args = {}, options = {}) {
    if (this.config.applyEnabled !== true) return { ok: false, code: 'E_APPLY_DISABLED' };
    const caller = options?.caller ?? this.caller;
    if (isSubagentCaller(caller)) return { ok: false, code: 'E_NOT_MAIN_SESSION' };
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    let proposal = id ? readProposal(this.proposalsDir, id) : null;
    if (!proposal) return { ok: false, code: 'E_TICKET_UNKNOWN', ticket: args.ticket ?? null };
    if (proposal.status !== 'done') return { ok: false, code: 'E_BAD_STATE', id: proposal.id, state: proposal.status };
    const ticket = proposal.queue?.ticket ?? null;
    const result = proposal.result ?? {};
    // R-06: an apply that created a new file records beforeSha/baseSha = null.
    // Rolling it back means removing the file, not restoring empty bytes.
    const newFileApply = (result.baseSha ?? result.beforeSha ?? null) === null;

    // Side-effect-free first look: the target must still be exactly the bytes
    // this apply wrote, and the restore snapshot must be readable.
    const initial = this.#readTarget(proposal);
    if (!initial.ok || !initial.exists || initial.sha256 !== result.afterSha) {
      this.#auditSafe('rollback.base_moved', { proposalId: proposal.id, expectedSha: result.afterSha ?? null, actualSha: initial.ok ? initial.sha256 : null });
      return { ok: false, code: 'E_BASE_MOVED', id: proposal.id, ticket };
    }
    if (!result.snapshot) return { ok: false, code: 'E_SNAPSHOT_FAILED', id: proposal.id, ticket };
    const snapshotFile = path.join(this.vaultDir, result.snapshot);
    let before = null;
    try { before = fs.readFileSync(snapshotFile); } catch { before = null; }
    if (!before) return { ok: false, code: 'E_SNAPSHOT_FAILED', id: proposal.id, ticket };
    const beforeSha = sha256Buffer(before);
    const acquired = this.lease.acquire({ ticket, proposalId: proposal.id });
    if (!acquired.ok) return { ok: true, state: 'queued', id: proposal.id, ticket, holder: acquired.holder ?? null };

    try {
      // D-CR8: enter "applying" with rollback:true BEFORE rollback.begin, so a
      // crash at any later point is visible to recoverApplying().
      proposal = this.#updateProposal(proposal.id, (current) => ({
        ...current,
        status: 'applying',
        rollback: {
          active: true,
          runId: this.runId,
          startedAt: isoNow(this.now()),
          beforeSha,
          afterSha: result.afterSha ?? null,
          snapshot: result.snapshot,
          removeTarget: newFileApply,
        },
        queue: {
          ...current.queue,
          lease: {
            holder: this.holder.sessionId,
            pid: this.holder.pid,
            host: this.holder.host,
            runId: this.runId,
            acquiredAt: acquired.lease?.acquiredAt ?? isoNow(this.now()),
            expiresAt: acquired.lease?.expiresAt ?? null,
            renewals: 0,
          },
        },
        stateLog: [...(current.stateLog ?? []), {
          at: isoNow(this.now()),
          from: 'done',
          to: 'applying',
          by: 'router',
          note: 'rollback.begin',
        }],
      }), { expectRev: proposal.rev });

      this.wal.append('rollback.begin', {
        ticket,
        proposalId: proposal.id,
        beforeSha,
        afterSha: result.afterSha ?? null,
        snapshot: result.snapshot,
        removeTarget: newFileApply,
      });

      const absolute = initial.absolute;
      const tmp = this.#tmpPath(absolute, `rollback-${proposal.id}`);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      if (!newFileApply) {
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
          fs.writeFileSync(fd, before);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }

      // Final check after the tmp is durable, immediately before any canonical
      // write: lease still ours + target still afterSha. Zero bytes on failure.
      const holderCheck = this.lease.check({ phase: 'pre-rename' });
      if (!holderCheck.ok) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        this.wal.append('apply.abort', { ticket, proposalId: proposal.id, reason: 'lease-lost', phase: 'rollback-pre-rename' });
        this.#conflict(proposal, { code: holderCheck.code, reason: 'lease-lost', phase: 'rollback-pre-rename' });
        this.#releaseLease();
        return { ok: false, code: holderCheck.code, id: proposal.id, ticket, state: 'conflict' };
      }
      if (typeof this.testHooks?.onRollbackRecheck === 'function') {
        try { this.testHooks.onRollbackRecheck(); } catch { /* test seam only */ }
      }
      const finalTarget = this.#readTarget(proposal);
      const recheckOk = finalTarget.ok
        && finalTarget.exists
        && finalTarget.sha256 === result.afterSha
        && !this.#injected('forceRollbackInjection');
      if (!recheckOk) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        this.wal.append('apply.abort', { ticket, proposalId: proposal.id, reason: 'owner-write-race', phase: 'rollback-pre-rename' });
        this.#auditSafe('apply.abort', { proposalId: proposal.id, ticket, reason: 'owner-write-race', phase: 'rollback-pre-rename' });
        this.#conflict(proposal, {
          code: 'E_BASE_MOVED',
          reason: 'owner-write-race',
          phase: 'rollback-pre-rename',
          extra: { expectedSha: result.afterSha ?? null, actualSha: finalTarget.ok ? finalTarget.sha256 : null },
        });
        this.#warn('OWNER_WRITE_RACE');
        this.#releaseLease();
        return { ok: false, code: 'E_BASE_MOVED', id: proposal.id, ticket, state: 'conflict', reason: 'owner-write-race' };
      }

      // Evidence: snapshot the bytes being overwritten (still afterSha).
      const stamp = isoNow(this.now()).replace(/[:.]/gu, '-');
      const evidence = path.join('snapshots', `rollback-${stamp}-${proposal.id}-${path.basename(absolute)}.bak`);
      this.#writeSnapshot(proposal, absolute, finalTarget.buffer, result.afterSha, evidence);

      if (newFileApply) {
        // R-06 residual: the final sha recheck happens immediately before the
        // unlink too — a third-party write between recheck and removal must not
        // be silently deleted.
        let current = null;
        try { current = sha256Buffer(fs.readFileSync(absolute)); } catch { current = null; }
        if (current !== null && current !== result.afterSha) {
          this.#auditSafe('rollback.base_moved', { proposalId: proposal.id, expectedSha: result.afterSha ?? null, actualSha: current, phase: 'pre-unlink' });
          this.wal.append('apply.abort', { ticket, proposalId: proposal.id, reason: 'owner-write-race', phase: 'rollback-pre-unlink' });
          this.#conflict(proposal, { code: 'E_BASE_MOVED', reason: 'owner-write-race', phase: 'rollback-pre-unlink', extra: { expectedSha: result.afterSha ?? null, actualSha: current } });
          this.#releaseLease();
          return { ok: false, code: 'E_BASE_MOVED', id: proposal.id, ticket, state: 'conflict', reason: 'owner-write-race' };
        }
        // R-06: the apply created this file; rollback removes it. ENOENT already
        // satisfies the contract (someone else removed it).
        let removeError = null;
        try {
          fs.unlinkSync(absolute);
        } catch (error) {
          if (error?.code !== 'ENOENT') removeError = error;
        }
        this.#fsyncDir(path.dirname(absolute));
        if (this.#injected('failRollbackAfterRename')) throw new TestCrash('after-rollback-remove');

        let actual = null;
        let stillExists = false;
        try {
          actual = sha256Buffer(fs.readFileSync(absolute));
          stillExists = true;
        } catch {
          stillExists = false;
        }
        if (removeError && stillExists) {
          this.wal.append('apply.conflict', { ticket, proposalId: proposal.id, reason: 'rollback-remove-failed', expectedSha: null, actualSha: actual });
          this.#conflict(proposal, { code: 'RESTORE_REQUIRED', reason: 'rollback-remove-failed', phase: 'rollback', extra: { expectedSha: null, actualSha: actual, error: removeError?.code ?? null } });
          this.#warn('RESTORE_REQUIRED');
          this.#releaseLease();
          return { ok: false, code: 'E_RESTORE_REQUIRED', id: proposal.id, ticket, actualSha: actual };
        }
        if (stillExists) {
          this.wal.append('apply.conflict', { ticket, proposalId: proposal.id, reason: 'rollback-readback-mismatch', expectedSha: null, actualSha: actual });
          this.#conflict(proposal, { code: 'RESTORE_REQUIRED', reason: 'rollback-readback-mismatch', phase: 'rollback', extra: { expectedSha: null, actualSha: actual } });
          this.#warn('RESTORE_REQUIRED');
          this.#releaseLease();
          return { ok: false, code: 'E_RESTORE_REQUIRED', id: proposal.id, ticket, actualSha: actual };
        }
      } else {
        fs.renameSync(tmp, absolute);
        this.#fsyncDir(path.dirname(absolute));
        if (this.#injected('failRollbackAfterRename')) throw new TestCrash('after-rollback-rename');

        let actual = null;
        try { actual = sha256Buffer(fs.readFileSync(absolute)); } catch { actual = null; }
        if (actual !== beforeSha) {
          this.wal.append('apply.conflict', { ticket, proposalId: proposal.id, reason: 'rollback-readback-mismatch', expectedSha: beforeSha, actualSha: actual });
          this.#conflict(proposal, { code: 'RESTORE_REQUIRED', reason: 'rollback-readback-mismatch', phase: 'rollback', extra: { expectedSha: beforeSha, actualSha: actual } });
          this.#warn('RESTORE_REQUIRED');
          this.#releaseLease();
          return { ok: false, code: 'E_RESTORE_REQUIRED', id: proposal.id, ticket, actualSha: actual };
        }
      }

      // WAL first: a crash between WAL and the state flip is recovered from
      // rollback.begin (actual == beforeSha / target absent) without losing it.
      this.wal.append('rollback.done', newFileApply
        ? { ticket, proposalId: proposal.id, removed: true, restoredSha: null, snapshot: evidence }
        : { ticket, proposalId: proposal.id, restoredSha: beforeSha, snapshot: evidence });
      const updated = this.#updateProposal(proposal.id, (current) => ({
        ...current,
        status: 'rolled_back',
        rollback: {
          ...(current.rollback ?? {}),
          active: false,
          finishedAt: isoNow(this.now()),
          evidence,
          ...(newFileApply ? { removed: true } : {}),
        },
        queue: { ...current.queue, lease: null },
        result: {
          ...(current.result ?? {}),
          rolledBackAt: isoNow(this.now()),
          ...(newFileApply ? { removed: true, restoredSha: null } : { restoredSha: beforeSha }),
          rollbackSnapshot: evidence,
        },
        stateLog: [...(current.stateLog ?? []), {
          at: isoNow(this.now()),
          from: 'applying',
          to: 'rolled_back',
          by: caller?.kind === 'owner-cli' ? 'owner:cli' : (caller?.sessionId ?? 'router'),
          note: 'rollback.done',
        }],
      }), { expectRev: proposal.rev });
      this.#auditSafe('rollback.done', {
        proposalId: updated.id,
        ticket,
        ...(newFileApply ? { removed: true, restoredSha: null } : { restoredSha: beforeSha }),
        evidence,
      });
      this.#releaseLease();
      this.queue?.rebuild?.();
      return {
        ok: true,
        state: 'rolled_back',
        id: updated.id,
        ticket,
        ...(newFileApply ? { removed: true, restoredSha: null } : { restoredSha: beforeSha }),
        snapshot: evidence,
      };
    } catch (error) {
      if (error instanceof TestCrash) {
        this.#auditSafe('rollback.crash_simulated', { proposalId: proposal.id, ticket, phase: error.phase });
        throw error;
      }
      this.#releaseLease();
      throw error;
    }
  }

  /**
   * DESIGN §5.4 restart reconciliation for proposals stuck in "applying":
   * sha==baseSha → approved (attempts+1); sha==afterSha → done; otherwise
   * conflict + RESTORE_REQUIRED. Never auto-rollback.
   */
  recoverApplying() {
    const scan = this.#scan();
    const summary = { recovered: [], done: [], conflicts: [], rolledBack: [] };
    for (const proposal of scan.proposals) {
      if (proposal.status !== 'applying') continue;
      // A rotation may have folded apply.begin into wal.snapshot.json; fall
      // back to the snapshot's per-proposal begin record (DESIGN §3.5).
      const begin = this.wal.last((line) => (line.ev === 'apply.begin' || line.ev === 'rollback.begin')
        && line.proposalId === proposal.id)
        ?? this.wal.snapshotBegin?.(proposal.id)
        ?? null;
      const target = this.#readTarget(proposal);
      const actual = target.ok ? target.sha256 : null;
      if (!begin) {
        this.#updateProposal(proposal.id, (current) => ({
          ...current,
          status: 'approved',
          queue: { ...current.queue, lease: null, attempts: (current.queue?.attempts ?? 0) + 1 },
          stateLog: [...(current.stateLog ?? []), { at: isoNow(this.now()), from: 'applying', to: 'approved', by: 'router', note: 'recover: no apply.begin' }],
        }));
        this.wal.append('apply.abort', { ticket: proposal.queue?.ticket ?? null, proposalId: proposal.id, reason: 'recovered-no-begin', phase: 'recovery' });
        this.#auditSafe('proposal.recovered', { proposalId: proposal.id, outcome: 'approved', reason: 'no-begin' });
        summary.recovered.push(proposal.id);
        continue;
      }
      if (begin.ev === 'rollback.begin') {
        const beginBefore = begin.beforeSha ?? null;
        const beginAfter = begin.afterSha ?? null;
        if (beginBefore && actual === beginBefore) {
          // The rename landed, but the state flip did not: finish the rollback.
          this.#updateProposal(proposal.id, (current) => ({
            ...current,
            status: 'rolled_back',
            rollback: { ...(current.rollback ?? {}), active: false, finishedAt: isoNow(this.now()) },
            queue: { ...current.queue, lease: null },
            result: {
              ...(current.result ?? {}),
              rolledBackAt: isoNow(this.now()),
              restoredSha: beginBefore,
              recovered: true,
            },
            stateLog: [...(current.stateLog ?? []), { at: isoNow(this.now()), from: 'applying', to: 'rolled_back', by: 'router', note: 'recover: rollback applied' }],
          }));
          this.wal.append('rollback.done', { ticket: proposal.queue?.ticket ?? null, proposalId: proposal.id, restoredSha: beginBefore, recovered: true });
          this.#auditSafe('proposal.recovered', { proposalId: proposal.id, outcome: 'rolled_back', reason: 'rollback-applied' });
          summary.rolledBack.push(proposal.id);
          continue;
        }
        if (begin.removeTarget === true && actual === null) {
          // R-06: the new-file rollback removed the target but the state flip
          // did not land; finish it as a removal, not as an empty restore.
          this.#updateProposal(proposal.id, (current) => ({
            ...current,
            status: 'rolled_back',
            rollback: { ...(current.rollback ?? {}), active: false, removed: true, finishedAt: isoNow(this.now()) },
            queue: { ...current.queue, lease: null },
            result: {
              ...(current.result ?? {}),
              rolledBackAt: isoNow(this.now()),
              restoredSha: null,
              removed: true,
              recovered: true,
            },
            stateLog: [...(current.stateLog ?? []), { at: isoNow(this.now()), from: 'applying', to: 'rolled_back', by: 'router', note: 'recover: rollback removed target' }],
          }));
          this.wal.append('rollback.done', { ticket: proposal.queue?.ticket ?? null, proposalId: proposal.id, removed: true, restoredSha: null, recovered: true });
          this.#auditSafe('proposal.recovered', { proposalId: proposal.id, outcome: 'rolled_back', reason: 'rollback-removed' });
          summary.rolledBack.push(proposal.id);
          continue;
        }
        if (beginAfter && actual === beginAfter) {
          // The rename never happened: the proposal is still exactly as applied.
          this.#updateProposal(proposal.id, (current) => ({
            ...current,
            status: 'done',
            rollback: { ...(current.rollback ?? {}), active: false, aborted: true, finishedAt: isoNow(this.now()) },
            queue: { ...current.queue, lease: null },
            stateLog: [...(current.stateLog ?? []), { at: isoNow(this.now()), from: 'applying', to: 'done', by: 'router', note: 'recover: rollback did not land' }],
          }));
          this.wal.append('apply.abort', { ticket: proposal.queue?.ticket ?? null, proposalId: proposal.id, reason: 'rollback-target-unchanged', phase: 'recovery' });
          this.#auditSafe('proposal.recovered', { proposalId: proposal.id, outcome: 'done', reason: 'rollback-not-applied' });
          summary.done.push(proposal.id);
          continue;
        }
        this.wal.append('apply.conflict', {
          ticket: proposal.queue?.ticket ?? null,
          proposalId: proposal.id,
          reason: 'rollback-recovery-sha-mismatch',
          phase: 'recovery',
          expectedSha: begin.removeTarget === true ? null : (beginBefore ?? beginAfter ?? null),
          actualSha: actual,
        });
        this.wal.append('restore.required', {
          ticket: proposal.queue?.ticket ?? null,
          proposalId: proposal.id,
          reason: 'rollback-recovery-sha-mismatch',
          expectedSha: begin.removeTarget === true ? null : (beginBefore ?? beginAfter ?? null),
          actualSha: actual,
          snapshot: begin.snapshot ?? null,
        });
        this.#conflict(proposal, {
          code: 'RESTORE_REQUIRED',
          reason: 'rollback-recovery-sha-mismatch',
          phase: 'recovery',
          extra: { expectedSha: beginBefore ?? beginAfter ?? null, actualSha: actual, restoreRequired: true, snapshot: begin.snapshot ?? null, rollback: true },
        });
        this.#warn('RESTORE_REQUIRED');
        summary.conflicts.push(proposal.id);
        continue;
      }
      if (begin.afterSha && actual === begin.afterSha) {
        this.#updateProposal(proposal.id, (current) => ({
          ...current,
          status: 'done',
          queue: { ...current.queue, lease: null },
          result: {
            appliedAt: isoNow(this.now()),
            beforeSha: begin.baseSha ?? null,
            afterSha: begin.afterSha,
            bytesAdded: null,
            snapshot: begin.snapshot ?? null,
            recovered: true,
          },
          stateLog: [...(current.stateLog ?? []), { at: isoNow(this.now()), from: 'applying', to: 'done', by: 'router', note: 'recover: afterSha present' }],
        }));
        this.wal.append('apply.done', { ticket: proposal.queue?.ticket ?? null, proposalId: proposal.id, beforeSha: begin.baseSha ?? null, afterSha: begin.afterSha, recovered: true });
        this.#auditSafe('proposal.recovered', { proposalId: proposal.id, outcome: 'done' });
        summary.done.push(proposal.id);
        continue;
      }
      if ((begin.baseSha ?? null) === actual) {
        this.#updateProposal(proposal.id, (current) => ({
          ...current,
          status: 'approved',
          queue: { ...current.queue, lease: null, attempts: (current.queue?.attempts ?? 0) + 1 },
          stateLog: [...(current.stateLog ?? []), { at: isoNow(this.now()), from: 'applying', to: 'approved', by: 'router', note: 'recover: baseSha intact' }],
        }));
        this.wal.append('apply.abort', { ticket: proposal.queue?.ticket ?? null, proposalId: proposal.id, reason: 'recovered-base-intact', phase: 'recovery' });
        this.#auditSafe('proposal.recovered', { proposalId: proposal.id, outcome: 'approved', reason: 'base-intact' });
        summary.recovered.push(proposal.id);
        continue;
      }
      this.wal.append('apply.conflict', {
        ticket: proposal.queue?.ticket ?? null,
        proposalId: proposal.id,
        reason: 'recovery-sha-mismatch',
        phase: 'recovery',
        expectedSha: begin.afterSha ?? null,
        actualSha: actual,
      });
      this.wal.append('restore.required', {
        ticket: proposal.queue?.ticket ?? null,
        proposalId: proposal.id,
        reason: 'recovery-sha-mismatch',
        expectedSha: begin.afterSha ?? null,
        actualSha: actual,
        snapshot: begin.snapshot ?? null,
      });
      this.#conflict(proposal, {
        code: 'RESTORE_REQUIRED',
        reason: 'recovery-sha-mismatch',
        phase: 'recovery',
        extra: { expectedSha: begin.afterSha ?? null, actualSha: actual, restoreRequired: true, snapshot: begin.snapshot ?? null },
      });
      this.#warn('RESTORE_REQUIRED');
      summary.conflicts.push(proposal.id);
    }
    // A same-process recovery (test/restart seam) may still own the lease that
    // the crashed attempt acquired. Release it only when it is provably ours.
    const held = this.lease?.read?.() ?? null;
    if (held && held.holder?.runId === this.lease?.holder?.runId
      && (summary.recovered.length + summary.done.length + summary.conflicts.length + summary.rolledBack.length) > 0) {
      this.#releaseLease();
    }
    return summary;
  }

  /** Remove abandoned tmp files older than one hour (DESIGN §5.4). */
  cleanStaleTmp() {
    const scan = this.#scan();
    const removed = [];
    // Orphan proposal writes (`<id>.json.tmp-<pid>`) live in proposalsDir and
    // are invisible to the proposal scanner; L-02 requires them gone.
    try {
      for (const name of fs.readdirSync(this.proposalsDir)) {
        if (!name.includes('.tmp-')) continue;
        const file = path.join(this.proposalsDir, name);
        try {
          if (this.now().getTime() - fs.statSync(file).mtimeMs > TMP_MAX_AGE_MS) {
            fs.unlinkSync(file);
            removed.push(file);
          }
        } catch { /* raced */ }
      }
    } catch { /* no proposals dir yet */ }
    for (const proposal of scan.proposals) {
      const absolute = path.resolve(this.memoryRoot ?? path.dirname(this.proposalsDir), proposal.target);
      // Both the apply tmp and the rollback tmp live next to the target (D-CR8).
      for (const tmp of [this.#tmpPath(absolute, proposal.id), this.#tmpPath(absolute, `rollback-${proposal.id}`)]) {
        try {
          const stat = fs.statSync(tmp);
          if (this.now().getTime() - stat.mtimeMs > TMP_MAX_AGE_MS) {
            fs.unlinkSync(tmp);
            removed.push(tmp);
          }
        } catch { /* no tmp */ }
      }
    }
    return removed;
  }

  /** Remove evidence snapshots older than 30 days (kept as evidence before that). */
  cleanSnapshots() {
    let names = [];
    try { names = fs.readdirSync(this.snapshotsDir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.bak')) continue;
      const file = path.join(this.snapshotsDir, name);
      try {
        if (this.now().getTime() - fs.statSync(file).mtimeMs > SNAPSHOT_KEEP_MS) {
          fs.unlinkSync(file);
          removed += 1;
        }
      } catch { /* ignore */ }
    }
    return removed;
  }

  /**
   * One maintenance pass. Called while the caller holds tick.lock, so no other
   * Router tick can interleave. allowApply is decided by the service.
   */
  async maintain({ allowApply = false } = {}) {
    const summary = { lease: null, recovered: null, queue: null, apply: null, cleaned: 0, snapshotsRemoved: 0, walBroken: false };
    try {
      summary.lease = this.lease.reclaimIfNeeded();
    } catch (error) {
      this.#auditSafe('lease.reclaim_failed', { error: String(error?.message ?? error) });
    }
    try {
      summary.recovered = this.recoverApplying();
    } catch (error) {
      this.#auditSafe('apply.recover_failed', { error: String(error?.message ?? error) });
    }
    summary.cleaned = this.cleanStaleTmp().length;
    summary.snapshotsRemoved = this.cleanSnapshots();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        summary.queue = this.queue.maintain();
        break;
      } catch (error) {
        if (error?.code !== 'E_STATE_RACE' || attempt === 2) {
          this.#auditSafe('queue.maintain_failed', { error: String(error?.message ?? error) });
          break;
        }
      }
    }
    // Surface a chain break to service.mjs so it can raise WAL_BROKEN (§3.7).
    summary.walBroken = summary.queue?.walBroken === true
      || this.wal?.status?.().broken === true;
    if (allowApply && this.config.applyEnabled === true) {
      const approved = this.#scan().proposals.some((proposal) => proposal.status === 'approved');
      if (approved && !this.lease.read()) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            summary.apply = await this.apply({});
            break;
          } catch (error) {
            if (error?.code === 'E_TEST_CRASH') break;
            if (error?.code !== 'E_STATE_RACE' || attempt === 2) throw error;
          }
        }
      }
    }
    return summary;
  }

  /** Queue/lease/WAL snapshot for status.json (never includes proposal bodies). */
  status() {
    const scan = this.#scan();
    const counts = { pending: 0, queued: 0, applying: 0, blockedOnUser: 0, expired: 0 };
    let doneToday = 0;
    let conflicts = 0;
    let superseded = 0;
    const today = isoNow(this.now()).slice(0, 10);
    for (const proposal of scan.proposals) {
      if (proposal.status === 'pending') counts.pending += 1;
      else if (proposal.status === 'approved') counts.queued += 1;
      else if (proposal.status === 'applying') counts.applying += 1;
      else if (proposal.status === 'blocked-on-user') counts.blockedOnUser += 1;
      else if (proposal.status === 'expired') counts.expired += 1;
      if (proposal.status === 'conflict') conflicts += 1;
      if (proposal.status === 'superseded') superseded += 1;
      if (proposal.status === 'done' && String(proposal.result?.appliedAt ?? '').startsWith(today)) doneToday += 1;
    }
    const view = this.queue?.view?.() ?? { entries: [], blocked: [], seqCounter: 1, etaMs: 0, writer: null };
    return {
      proposals: { doneToday, conflicts, superseded, counts },
      queue: {
        seqCounter: view.seqCounter ?? 1,
        depth: view.entries?.length ?? 0,
        etaMs: view.etaMs ?? 0,
        starvation: false,
        writer: view.writer ?? null,
        blocked: (view.blocked ?? []).slice(0, 8),
      },
      lease: this.lease.status(),
      wal: this.wal.status(),
    };
  }
}

export function createApplier(options) {
  return new Applier(options);
}
