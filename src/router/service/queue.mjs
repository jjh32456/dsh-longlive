// WP4a · proposal queue (DESIGN §3.4/§5.2/§5.4, K21/K25/K16).
//
// queue.json is a derived view: proposals are the row truth, the WAL is the
// assignment truth. rebuild() reconciles all three exactly as DESIGN §5.4 says:
//   - queued proposal without a WAL queue.assign → keep the proposal, re-issue a
//     TAIL ticket and append queue.assign.recovered (M-13, never delete);
//   - orphan queue entry → drop the entry + audit queue.reconcile;
//   - seqCounter = max(WAL ticket, proposal ticket, queue ticket) + 1.
//
// Aging/expiry transitions are applied to proposal files (rev CAS style) and
// then the queue file is rebuilt. This module never writes canonical memory.

import fs from 'node:fs';
import path from 'node:path';

import {
  QUEUE_MAX_BYTES,
  QUEUE_MAX_ENTRIES,
  countNonTerminal,
  readProposal,
  readQueueFile,
  scanProposalDir,
  updateProposalStrict,
  writeJsonStrict,
  StoreError,
} from './store.mjs';
import { ETA_DEFAULTS_MS } from './proposals.mjs';
import { sha256Hex } from './paths.mjs';

export const QUEUE_STATE_GLOSSARY = Object.freeze({
  queued: '待确认',
  approved: '已准待写',
  applying: '正在写',
  'blocked-on-user': '请主人裁决',
  expired: '已过期（不计入队列）',
});

const PRIORITY_INDEX = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 });

export function priorityIndex(priority) {
  return PRIORITY_INDEX[priority] ?? 3;
}

export function priorityName(index) {
  return Object.keys(PRIORITY_INDEX).find((name) => PRIORITY_INDEX[name] === index) ?? 'P3';
}

export function ticketNumber(ticket) {
  const match = /^q-(\d{4,})$/u.exec(String(ticket ?? ''));
  return match ? Number(match[1]) : 0;
}

export function ticketName(seq) {
  return `q-${String(seq).padStart(4, '0')}`;
}

export function computeSeqCounter(...tickets) {
  let max = 0;
  for (const ticket of tickets.flat(Infinity)) {
    max = Math.max(max, ticketNumber(ticket));
  }
  return max + 1;
}

function proposalValue(proposal) {
  const { __file, ...value } = proposal ?? {};
  return value;
}

/** Same order as DESIGN §5.2: effectivePriority → queuedAt → ticket. */
export function sortQueueEntries(entries) {
  return [...entries].sort((a, b) => {
    const byPriority = priorityIndex(a.effectivePriority) - priorityIndex(b.effectivePriority);
    if (byPriority !== 0) return byPriority;
    const at = Date.parse(a.queuedAt ?? 0);
    const bt = Date.parse(b.queuedAt ?? 0);
    if (at !== bt) return at - bt;
    return ticketNumber(a.ticket) - ticketNumber(b.ticket);
  });
}

export class QueueManager {
  constructor({ paths, config = {}, wal = null, audit = null, now = () => new Date(), logger = null } = {}) {
    this.paths = paths;
    this.vaultDir = paths?.vaultDir;
    this.proposalsDir = paths?.proposalsDir ?? path.join(this.vaultDir, 'proposals');
    this.queueFile = path.join(this.proposalsDir, 'queue.json');
    this.config = config;
    this.wal = wal;
    this.audit = audit;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.logger = logger;
  }

  #auditSafe(kind, data) {
    try { this.audit?.(kind, data); } catch { /* ignore */ }
  }

  #scan() {
    return scanProposalDir(this.proposalsDir);
  }

  /**
   * D-CR7: every queue-driven proposal write is a rev CAS. On E_STATE_RACE the
   * fresh file is re-read and the mutation re-applied up to three times; a
   * mutation that is no longer valid for the new status throws instead of
   * overwriting a newer decision.
   */
  #writeProposal(proposal, mutate) {
    let expectedRev = proposal.rev ?? 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return updateProposalStrict(this.proposalsDir, proposal.id, expectedRev, mutate, { now: this.now() });
      } catch (error) {
        if (error?.code !== 'E_STATE_RACE' || error?.rev === undefined) throw error;
        const fresh = readProposal(this.proposalsDir, proposal.id);
        if (!fresh) throw error;
        expectedRev = fresh.rev;
      }
    }
    throw new StoreError('E_STATE_RACE', 'proposal kept changing during a queue transition', { id: proposal.id });
  }

  buildQueue(proposals, seqCounter, rev = 1) {
    const entries = [];
    for (const proposal of proposals) {
      if (proposal.status !== 'pending' && proposal.status !== 'approved' && proposal.status !== 'applying') continue;
      const queuedAt = proposal.queue?.queuedAt ?? proposal.createdAt;
      entries.push({
        ticket: proposal.queue?.ticket ?? null,
        proposalId: proposal.id,
        sessionId: proposal.origin?.sessionId ?? null,
        target: proposal.target,
        op: proposal.op,
        status: proposal.status,
        priority: proposal.queue?.priority ?? 'P3',
        effectivePriority: proposal.queue?.effectivePriority ?? proposal.queue?.priority ?? 'P3',
        queuedAt,
        waitMs: Math.max(0, this.now().getTime() - (Date.parse(queuedAt) || this.now().getTime())),
        attempts: proposal.queue?.attempts ?? 0,
        lease: proposal.queue?.lease ?? null,
      });
    }
    const sorted = sortQueueEntries(entries);
    const blocked = proposals
      .filter((proposal) => proposal.status === 'blocked-on-user')
      .map((proposal) => ({
        ticket: proposal.queue?.ticket ?? null,
        proposalId: proposal.id,
        reason: proposal.queue?.blockedReason ?? 'BLOCKED_ON_USER',
        since: proposal.queue?.deadlineAt ?? proposal.updatedAt ?? proposal.createdAt,
      }));
    const writer = sorted.find((entry) => entry.status === 'applying');
    const body = {
      v: 1,
      rev,
      seqCounter,
      generatedAt: this.now().toISOString(),
      writer: writer ? {
        ticket: writer.ticket,
        proposalId: writer.proposalId,
        sessionId: writer.sessionId,
        since: writer.queuedAt,
      } : null,
      entries: sorted.map((entry, index) => ({ ...entry, position: index + 1 })),
      blocked,
    };
    body.hash = `sha256:${sha256Hex(JSON.stringify(body))}`;
    return body;
  }

  #writeQueue(queue) {
    if (queue.entries.length > QUEUE_MAX_ENTRIES) {
      throw new StoreError('E_QUEUE_FULL', 'queue has too many entries', { entries: queue.entries.length });
    }
    const text = `${JSON.stringify(queue, null, 2)}\n`;
    if (Buffer.byteLength(text) > QUEUE_MAX_BYTES) {
      throw new StoreError('E_QUEUE_FULL', 'queue exceeds the size limit', { bytes: Buffer.byteLength(text) });
    }
    writeJsonStrict(this.queueFile, queue);
  }

  #readOldQueue() {
    return readQueueFile(this.queueFile);
  }

  /**
   * Reconcile proposals + WAL + queue. Safe to run every tick; only writes when
   * something actually changed (no queue churn on a healthy system).
   */
  rebuild() {
    const scan = this.#scan();
    const proposals = scan.proposals;
    const oldQueue = this.#readOldQueue();
    const walState = this.wal?.read() ?? { lines: [], broken: false, snapshot: null };
    const walLines = walState.lines;
    const walSnapshot = walState.snapshot ?? null;
    const summary = {
      ok: true,
      recovered: [],
      reconciled: [],
      orphans: [],
      broken: walState.broken === true,
      walBroken: walState.broken === true,
      seqCounter: 1,
      written: false,
    };
    let seqCounter = Math.max(
      1,
      Number.isInteger(oldQueue?.seqCounter) ? oldQueue.seqCounter : 1,
      Number.isInteger(walSnapshot?.seqCounter) ? walSnapshot.seqCounter : 1,
      ...(walSnapshot?.assignments ?? []).map((assignment) => ticketNumber(assignment.ticket) + 1),
      ...walLines.map((line) => ticketNumber(line.ticket) + 1),
      ...proposals.map((proposal) => ticketNumber(proposal.queue?.ticket) + 1),
    );

    if (!walState.broken && this.wal) {
      // Folded queue.assign events live in wal.snapshot.json (DESIGN §3.5);
      // replayable segments overlay them in seq order.
      const assigned = new Map();
      for (const assignment of walSnapshot?.assignments ?? []) {
        if (typeof assignment.proposalId !== 'string') continue;
        assigned.set(assignment.proposalId, {
          ticket: assignment.ticket ?? null,
          seq: assignment.seq ?? ticketNumber(assignment.ticket),
          source: 'snapshot',
        });
      }
      for (const line of walLines) {
        if (typeof line.proposalId !== 'string') continue;
        if (line.ev === 'queue.assign' || line.ev === 'queue.assign.recovered' || line.ev === 'queue.approve') {
          assigned.set(line.proposalId, { ...line, source: 'wal' });
        }
      }
      const active = proposals.filter((proposal) => proposal.status === 'pending'
        || proposal.status === 'approved' || proposal.status === 'applying');
      for (const proposal of active) {
        const assignment = assigned.get(proposal.id);
        if (assignment && assignment.ticket === proposal.queue?.ticket) continue;
        if (assignment?.ticket) {
          // WAL wins over proposal stateLog (DESIGN §3.5/§5.4): restore the
          // canonical ticket instead of minting a new one.
          const ticket = assignment.ticket;
          const previous = proposal.queue?.ticket ?? null;
          const updated = this.#writeProposal(proposal, (current) => ({
            queue: { ...current.queue, ticket, seq: ticketNumber(ticket) },
            stateLog: [...(current.stateLog ?? []), {
              at: this.now().toISOString(),
              from: current.status,
              to: current.status,
              by: 'router',
              note: 'wal.reconcile: ticket restored from WAL',
            }],
          }));
          proposal.queue = updated.queue;
          summary.reconciled.push({ proposalId: proposal.id, ticket, previous });
          this.#auditSafe('wal.reconcile', {
            proposalId: proposal.id,
            ticket,
            previous,
            source: assignment.source,
          });
          continue;
        }
        const nextTicket = ticketName(seqCounter);
        seqCounter += 1;
        const updated = this.#writeProposal(proposal, (current) => ({
          queue: { ...current.queue, ticket: nextTicket, seq: ticketNumber(nextTicket) },
          stateLog: [...(current.stateLog ?? []), {
            at: this.now().toISOString(),
            from: current.status,
            to: current.status,
            by: 'router',
            note: 'queue.assign.recovered: missing assign',
          }],
        }));
        proposal.queue = updated.queue;
        this.wal.append('queue.assign.recovered', {
          ticket: nextTicket,
          proposalId: proposal.id,
          sessionId: proposal.origin?.sessionId ?? null,
          op: proposal.op,
          target: proposal.target,
          reason: 'missing-assign',
        });
        summary.recovered.push({ proposalId: proposal.id, ticket: nextTicket });
        this.#auditSafe('queue.assign.recovered', { proposalId: proposal.id, ticket: nextTicket });
      }
    }

    const activeIds = new Set(proposals
      .filter((proposal) => proposal.status === 'pending' || proposal.status === 'approved' || proposal.status === 'applying' || proposal.status === 'blocked-on-user')
      .map((proposal) => proposal.id));
    if (oldQueue) {
      for (const entry of oldQueue.entries ?? []) {
        const proposal = proposals.find((candidate) => candidate.id === entry.proposalId);
        const orphan = !activeIds.has(entry.proposalId)
          || !proposal
          || (proposal.queue?.ticket ?? null) !== (entry.ticket ?? null);
        if (orphan) {
          summary.orphans.push({ ticket: entry.ticket, proposalId: entry.proposalId });
          this.#auditSafe('queue.reconcile', { ticket: entry.ticket, proposalId: entry.proposalId, reason: 'orphan' });
        }
      }
    }

    const queue = this.buildQueue(proposals, seqCounter, (Number.isInteger(oldQueue?.rev) ? oldQueue.rev : 0) + 1);
    const changed = !oldQueue
      || oldQueue.seqCounter !== queue.seqCounter
      || oldQueue.hash !== queue.hash
      || summary.recovered.length > 0
      || summary.orphans.length > 0
      || JSON.stringify(oldQueue.entries ?? []) !== JSON.stringify(queue.entries)
      || JSON.stringify(oldQueue.blocked ?? []) !== JSON.stringify(queue.blocked);
    if (changed) {
      this.#writeQueue(queue);
      summary.written = true;
    }
    summary.seqCounter = queue.seqCounter;
    summary.depth = queue.entries.length;
    summary.blocked = queue.blocked.length;
    summary.nonTerminal = countNonTerminal(proposals);
    return summary;
  }

  /**
   * Aging + deadline transitions. Runs after rebuild; writes each proposal once
   * per transition and audits it.
   */
  maintain() {
    const scan = this.#scan();
    const nowMs = this.now().getTime();
    const summary = { aged: [], expired: [], blocked: [], ok: true };
    const agingMs = Math.max(10, Number(this.config.agingSeconds ?? 120)) * 1000;
    const leaseWaitMs = Number(this.config.leaseWaitTimeoutMs ?? 300_000);
    const blockedTtlMs = Number(this.config.blockedOnUserTtlMs ?? 86_400_000);

    for (const proposal of scan.proposals) {
      const nowIso = this.now().toISOString();
      if (proposal.status === 'pending') {
        const waitMs = nowMs - (Date.parse(proposal.queue?.queuedAt ?? proposal.createdAt) || nowMs);
        const steps = Math.max(0, Math.floor(waitMs / agingMs));
        const currentSteps = Number.isInteger(proposal.queue?.agingSteps) ? proposal.queue.agingSteps : 0;
        const currentPriority = priorityIndex(proposal.queue?.effectivePriority ?? proposal.queue?.priority ?? 'P3');
        if (steps > currentSteps && currentPriority > 1) {
          const nextIndex = Math.max(1, currentPriority - (steps - currentSteps));
          const updated = this.#writeProposal(proposal, (current) => {
            if (current.status !== 'pending') throw new StoreError('E_STATE_RACE', 'proposal left pending during aging');
            return { queue: { ...current.queue, agingSteps: steps, effectivePriority: priorityName(nextIndex) } };
          });
          Object.assign(proposal, updated);
          summary.aged.push({ proposalId: proposal.id, effectivePriority: priorityName(nextIndex), agingSteps: steps });
          this.#auditSafe('queue.aging', { proposalId: proposal.id, ticket: proposal.queue?.ticket ?? null, from: priorityName(currentPriority), to: priorityName(nextIndex) });
        }
        const deadline = Date.parse(proposal.queue?.deadlineAt ?? '');
        if (Number.isFinite(deadline) && nowMs > deadline) {
          summary.expired.push(this.#expire(proposal, {
            from: 'pending',
            note: 'proposal-ttl',
            reason: 'proposal-ttl',
            blockedReason: 'PROPOSAL_TTL',
          }, nowIso));
        }
      } else if (proposal.status === 'approved') {
        const attempts = Number.isInteger(proposal.queue?.attempts) ? proposal.queue.attempts : 0;
        if (attempts >= 3) {
          this.#block(proposal, 'REPEATED_CONFLICT', blockedTtlMs, nowIso);
          summary.blocked.push({ proposalId: proposal.id, reason: 'REPEATED_CONFLICT' });
          continue;
        }
        const deadline = Date.parse(proposal.queue?.deadlineAt ?? '');
        if (Number.isFinite(deadline) && nowMs > deadline) {
          this.#block(proposal, 'LEASE_TIMEOUT', blockedTtlMs, nowIso);
          summary.blocked.push({ proposalId: proposal.id, reason: 'LEASE_TIMEOUT', waitedMs: nowMs - deadline + leaseWaitMs });
        }
      } else if (proposal.status === 'blocked-on-user') {
        const deadline = Date.parse(proposal.queue?.deadlineAt ?? '');
        if (Number.isFinite(deadline) && nowMs > deadline) {
          summary.expired.push(this.#expire(proposal, {
            from: 'blocked-on-user',
            note: 'blocked-on-user-ttl',
            reason: 'blocked-on-user-ttl',
          }, nowIso));
        }
      }
    }
    const rebuilt = this.rebuild();
    return { ...summary, broken: rebuilt.broken, walBroken: rebuilt.walBroken, rebuild: rebuilt };
  }

  /**
   * K-08 retention contract: expiry is a status transition, never a deletion.
   * The proposal body stays at `proposalsDir/<id>.json` after the ticket is
   * released, so an operator can still read what was proposed and why it
   * lapsed. The post-write existence probe is a tripwire, not cleanup: if any
   * future path removes the body, the audit trail says `proposal.retention_lost`
   * instead of the outbox silently shrinking.
   */
  #expire(proposal, { from, note, reason, blockedReason = null }, nowIso) {
    const next = this.#writeProposal(proposal, (current) => {
      if (current.status !== from) throw new StoreError('E_STATE_RACE', `proposal left ${from} during expiry`);
      return {
        status: 'expired',
        queue: {
          ...current.queue,
          lease: null,
          ...(blockedReason === null ? {} : { blockedReason }),
        },
        stateLog: [...(current.stateLog ?? []), { at: nowIso, from, to: 'expired', by: 'router', note }],
      };
    });
    Object.assign(proposal, next);
    const bodyKept = fs.existsSync(path.join(this.proposalsDir, `${next.id}.json`));
    if (!bodyKept) {
      this.#auditSafe('proposal.retention_lost', {
        proposalId: next.id,
        ticket: next.queue?.ticket ?? null,
        from,
        reason,
      });
    }
    this.#auditSafe('proposal.expired', {
      proposalId: next.id,
      ticket: next.queue?.ticket ?? null,
      from,
      reason,
      bodyKept,
    });
    return { proposalId: next.id, ticket: next.queue?.ticket ?? null, reason, bodyKept };
  }

  #block(proposal, reason, blockedTtlMs, nowIso) {
    const next = this.#writeProposal(proposal, (current) => {
      if (current.status !== 'approved') throw new StoreError('E_STATE_RACE', 'proposal left approved during block');
      return {
        status: 'blocked-on-user',
        queue: {
          ...current.queue,
          lease: null,
          blockedReason: reason,
          deadlineAt: new Date(this.now().getTime() + blockedTtlMs).toISOString(),
        },
        stateLog: [...(current.stateLog ?? []), { at: nowIso, from: 'approved', to: 'blocked-on-user', by: 'router', note: reason }],
      };
    });
    Object.assign(proposal, next);
    this.#auditSafe('proposal.blocked', { proposalId: proposal.id, ticket: proposal.queue?.ticket ?? null, reason });
  }

  /** Ordered queue view with position/etaMs (no proposal bodies). */
  view() {
    const scan = this.#scan();
    const oldQueue = this.#readOldQueue();
    const queue = this.buildQueue(scan.proposals, oldQueue?.seqCounter ?? computeSeqCounter(
      scan.proposals.map((proposal) => proposal.queue?.ticket),
    ), oldQueue?.rev ?? 1);
    const entries = queue.entries.map((entry, index) => ({
      ...entry,
      position: index + 1,
      etaMs: (index + 1) * (ETA_DEFAULTS_MS[entry.op] ?? 2000),
    }));
    return {
      ok: true,
      mode: 'queue',
      seqCounter: queue.seqCounter,
      depth: entries.length,
      etaMs: entries.reduce((sum, entry) => sum + (ETA_DEFAULTS_MS[entry.op] ?? 2000), 0),
      writer: queue.writer,
      entries,
      blocked: queue.blocked,
    };
  }
}

export function createQueueManager(options) {
  return new QueueManager(options);
}
