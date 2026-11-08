// WP4a · proposal WAL (DESIGN §3.5/§5.4/§5.10/§3.7).
//
// One append-only line per state transition, fsync'd before canonical or the
// proposal file is touched. Replay verifies the prev/hash chain and stops at
// the first broken line: it never guesses what came after a break.
//
// Segmentation (DESIGN §3.5): the active file rotates to
// `wal.<firstSeq>.jsonl` when it reaches 2 MB or 5,000 lines, and the newest
// three archived segments are kept. Before rotating, non-terminal proposals,
// their queue.assign summaries, seqCounter, the queue head and the latest
// apply.begin are folded into `wal.snapshot.json` (atomic tmp+fsync+rename+
// read-back). Replay starts from that snapshot and continues through the
// archived segments by seq, then the active file, verifying prev/hash across
// every segment boundary.
//
// Pruning only runs after a successful snapshot: a line may be dropped when it
// is older than seven days AND terminal (its event type or its proposal is
// terminal). lease.expired / apply.conflict / restore.required / rollback.*
// are never dropped. Every dropped line is first written to the audit archive;
// without an audit callback nothing is pruned (no silent loss of incident
// evidence).
//
// WAL is the source of truth for assignment/apply decisions. This module never
// edits proposal files and never writes canonical memory.

import fs from 'node:fs';
import path from 'node:path';

import {
  appendJsonLineDurable,
  isTerminalProposalStatus,
  readQueueFile,
  readWalLines,
  scanProposalDir,
  StoreError,
  writeJsonStrict,
} from './store.mjs';
import { OwnerLock, RECLAIM_STALE_MIN_MS } from './lock.mjs';
import { sha256Hex, writeTextAtomic } from './paths.mjs';

export const WAL_EVENT_TYPES = Object.freeze([
  'queue.assign',
  'queue.assign.recovered',
  'queue.approve',
  'queue.cancel',
  'queue.reconcile',
  'lease.acquire',
  'lease.renew',
  'lease.release',
  'lease.expired',
  'apply.begin',
  'apply.abort',
  'apply.done',
  'apply.conflict',
  'restore.required',
  'rollback.begin',
  'rollback.done',
]);

/** DESIGN §3.5: rotate at 2 MB (configurable lower bound 256 KB) or 5,000 lines. */
export const WAL_MAX_LINES = 5000;
/** DESIGN §3.5: keep the newest three archived segments (active + 3 = 2 MB×4). */
export const WAL_KEEP_SEGMENTS = 3;
/** DESIGN §3.5: terminal events older than seven days may be folded away. */
export const WAL_PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WAL_SNAPSHOT_VERSION = 1;

/** Incident records that are never pruned, regardless of age. */
export const WAL_NEVER_PRUNE_EVENTS = Object.freeze([
  'lease.expired',
  'apply.conflict',
  'restore.required',
  'rollback.begin',
  'rollback.done',
]);

/** Events that terminate their own audit row (safe to prune when old). */
const WAL_TERMINAL_EVENTS = new Set([
  'queue.cancel',
  'lease.release',
  'apply.done',
  'apply.abort',
]);

const SEGMENT_RE = /^wal\.(\d+)\.jsonl$/u;
const QUEUE_ASSIGN_EVENTS = new Set([
  'queue.assign',
  'queue.assign.recovered',
  'queue.approve',
]);
const APPLY_BEGIN_EVENTS = new Set(['apply.begin', 'rollback.begin']);

function ticketNumber(ticket) {
  const match = /^q-(\d{4,})$/u.exec(String(ticket ?? ''));
  return match ? Number(match[1]) : 0;
}

/** Recompute the line hash exactly as proposals.mjs writes it. */
export function walLineHash(line) {
  const { prev = '', hash, ...body } = line ?? {};
  return `sha256:${sha256Hex(`${prev}\n${JSON.stringify(body)}`)}`;
}

export class Wal {
  constructor({
    file,
    audit = null,
    logger = null,
    maxBytes = 2097152,
    maxLines = WAL_MAX_LINES,
    keepSegments = WAL_KEEP_SEGMENTS,
    pruneAgeMs = WAL_PRUNE_MAX_AGE_MS,
    lockFile = null,
    lockWaitMs = 5000,
    lockStaleMs = RECLAIM_STALE_MIN_MS,
    now = () => new Date(),
  } = {}) {
    this.file = file;
    this.audit = audit;
    this.logger = logger;
    this.dir = path.dirname(file);
    this.snapshotFile = path.join(this.dir, 'wal.snapshot.json');
    // D-CR6: one cross-process lock covers "read lastSeq/lastHash -> append" and
    // rotation. proposals/ lives under <vault>/proposals, so the lock lives at
    // <vault>/locks/wal.lock (custom layouts keep it next to the WAL dir).
    const lockParent = path.basename(this.dir) === 'proposals' ? path.dirname(this.dir) : this.dir;
    this.lockFile = lockFile ?? path.join(lockParent, 'locks', 'wal.lock');
    this.lockWaitMs = Number.isFinite(lockWaitMs) && lockWaitMs >= 0 ? Math.trunc(lockWaitMs) : 5000;
    this.lock = new OwnerLock({
      file: this.lockFile,
      evidencePrefix: 'wal.lock.reclaimed-',
      staleMs: lockStaleMs,
      now,
      label: 'wal.lock',
      audit: (kind, data) => this.#auditSafe(kind, data),
      logger,
    });
    this.maxBytes = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 2097152;
    this.maxLines = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : WAL_MAX_LINES;
    this.keepSegments = Number.isInteger(keepSegments) && keepSegments >= 0 ? keepSegments : WAL_KEEP_SEGMENTS;
    this.pruneAgeMs = Number.isFinite(pruneAgeMs) && pruneAgeMs >= 0 ? pruneAgeMs : WAL_PRUNE_MAX_AGE_MS;
    this.now = typeof now === 'function' ? now : () => new Date();
  }

  #auditSafe(kind, data) {
    try { this.audit?.(kind, data); } catch { /* audit never blocks the WAL */ }
  }

  /** Archived segments, ascending by their first seq. */
  listSegments() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const segments = [];
    for (const name of names) {
      const match = SEGMENT_RE.exec(name);
      if (!match) continue;
      segments.push({ name, file: path.join(this.dir, name), firstSeq: Number(match[1]) });
    }
    segments.sort((a, b) => a.firstSeq - b.firstSeq || a.name.localeCompare(b.name));
    return segments;
  }

  #rawLineCount(file) {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
    } catch {
      return 0;
    }
  }

  /** Parsed snapshot, or null. A corrupt snapshot is audited, never repaired. */
  readSnapshot() {
    let text = null;
    try {
      text = fs.readFileSync(this.snapshotFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#auditSafe('wal.snapshot_unreadable', { error: error?.code ?? 'E_READ' });
      return null;
    }
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || value.v !== WAL_SNAPSHOT_VERSION
        || !Number.isInteger(value.upToSeq) || value.upToSeq < 0
        || typeof value.lastHash !== 'string'
        || !Array.isArray(value.proposals) || !Array.isArray(value.assignments)) {
        throw new Error('invalid snapshot shape');
      }
      return value;
    } catch (error) {
      if (!this.snapshotCorruptionAudited) {
        this.snapshotCorruptionAudited = true;
        this.#auditSafe('wal.snapshot_corrupt', { error: String(error?.message ?? error) });
      }
      return null;
    }
  }

  #segmentFiles() {
    return this.listSegments().map((segment) => segment.file);
  }

  /**
   * Read snapshot base + archived segments + active file. Folded lines
   * (seq <= snapshot.upToSeq) are evidence, not replay input: only their own
   * hash is verified (pruning may leave gaps inside a folded segment). Lines
   * after the boundary are replayed strictly by seq/prev/hash, continuously
   * across segment boundaries.
   */
  read() {
    const snapshot = this.readSnapshot();
    const boundary = snapshot ? snapshot.upToSeq : 0;
    const files = [...this.#segmentFiles(), this.file];
    const lines = [];
    let lastSeq = boundary;
    let lastHash = snapshot ? snapshot.lastHash : '';
    let broken = false;
    let brokenAt = null;
    let error = null;
    let rawLines = 0;
    let parsedLines = 0;
    let boundaryLineSeen = false;
    let boundaryHashOk = true;
    let foldedBad = null;
    let readFailure = null;

    outer:
    for (const file of files) {
      rawLines += this.#rawLineCount(file);
      const read = readWalLines(file);
      if (read.error && read.error !== 'ENOENT') readFailure = read.error;
      parsedLines += read.lines.length;
      for (const line of read.lines) {
        if (boundary > 0 && Number.isInteger(line.seq) && line.seq <= boundary) {
          if (!Number.isInteger(line.seq) || typeof line.hash !== 'string' || line.hash !== walLineHash(line)) {
            foldedBad = foldedBad ?? { file: path.basename(file), seq: line.seq ?? null };
          }
          if (line.seq === boundary) {
            boundaryLineSeen = true;
            if (line.hash !== snapshot.lastHash) boundaryHashOk = false;
          }
          continue;
        }
        const expectedSeq = lastSeq + 1;
        if (!Number.isInteger(line.seq) || line.seq !== expectedSeq
          || String(line.prev ?? '') !== lastHash
          || typeof line.hash !== 'string' || line.hash !== walLineHash(line)) {
          broken = true;
          brokenAt = lines.length;
          break outer;
        }
        lines.push(line);
        lastSeq = line.seq;
        lastHash = line.hash;
      }
    }

    if (!broken && boundary > 0 && (!boundaryHashOk || foldedBad)) {
      broken = true;
      brokenAt = 0;
      error = foldedBad ? 'E_FOLDED_LINE' : 'E_SNAPSHOT_BOUNDARY';
    }
    // D-CR16: a failed read is itself a broken chain. Appending would restart
    // seq at 1 and destroy the remaining chain, so append/rotate must refuse.
    if (!broken && readFailure) {
      broken = true;
      brokenAt = lines.length;
      error = readFailure;
    }
    const skipped = Math.max(0, rawLines - parsedLines);
    if (skipped > 0 && !this.corruptionAudited) {
      // A half-written tail is dropped, not "repaired" (DESIGN §3.7/§5.4).
      this.corruptionAudited = true;
      this.#auditSafe('wal.corrupt', { skipped, file: path.basename(this.file) });
    }
    return {
      lines,
      broken,
      brokenAt,
      lastSeq,
      lastHash,
      error: error ?? readFailure ?? null,
      snapshot,
      segments: files.filter((file) => file !== this.file).map((file) => path.basename(file)),
      boundaryLineSeen,
    };
  }

  #activeStats() {
    let bytes = 0;
    try { bytes = fs.statSync(this.file).size; } catch { /* no file yet */ }
    const parsed = readWalLines(this.file).lines;
    return { bytes, lines: parsed.length, parsed };
  }

  #shouldRotate() {
    const stats = this.#activeStats();
    if (stats.lines === 0) return false;
    return stats.bytes >= this.maxBytes || stats.lines >= this.maxLines;
  }

  /**
   * Fold the replayable suffix into wal.snapshot.json.
   * Caller has verified the chain and is rotating the active file.
   */
  #buildSnapshot(state) {
    const old = state.snapshot;
    const proposals = scanProposalDir(this.dir).proposals;
    const nonTerminal = proposals.filter((proposal) => !isTerminalProposalStatus(proposal.status));
    const activeIds = new Set(nonTerminal.map((proposal) => proposal.id));

    const assignmentById = new Map();
    for (const assignment of old?.assignments ?? []) {
      if (assignment && typeof assignment.proposalId === 'string' && activeIds.has(assignment.proposalId)) {
        assignmentById.set(assignment.proposalId, assignment);
      }
    }
    const applyById = new Map();
    for (const proposal of old?.proposals ?? []) {
      if (proposal && activeIds.has(proposal.id) && proposal.apply) applyById.set(proposal.id, proposal.apply);
    }
    for (const line of state.lines) {
      if (typeof line.proposalId !== 'string' || !activeIds.has(line.proposalId)) continue;
      if (QUEUE_ASSIGN_EVENTS.has(line.ev)) {
        assignmentById.set(line.proposalId, {
          proposalId: line.proposalId,
          ticket: line.ticket ?? null,
          seq: ticketNumber(line.ticket),
        });
      }
      if (APPLY_BEGIN_EVENTS.has(line.ev)) {
        applyById.set(line.proposalId, {
          ev: line.ev,
          seq: line.seq,
          at: line.at ?? null,
          ticket: line.ticket ?? null,
          proposalId: line.proposalId,
          baseSha: line.baseSha ?? null,
          afterSha: line.afterSha ?? null,
          snapshot: line.snapshot ?? null,
        });
      }
    }

    const queue = readQueueFile(path.join(this.dir, 'queue.json'));
    let seqCounter = Math.max(
      1,
      Number.isInteger(old?.seqCounter) ? old.seqCounter : 1,
      Number.isInteger(queue?.seqCounter) ? queue.seqCounter : 1,
      ...state.lines.map((line) => ticketNumber(line.ticket) + 1),
      ...nonTerminal.map((proposal) => ticketNumber(proposal.queue?.ticket) + 1),
    );

    const head = queueHead(queue, nonTerminal);
    const snapshot = {
      v: WAL_SNAPSHOT_VERSION,
      at: this.now().toISOString(),
      upToSeq: state.lastSeq,
      lastSeq: state.lastSeq,
      lastHash: state.lastHash,
      lastAt: state.lines.at(-1)?.at ?? old?.lastAt ?? null,
      seqCounter,
      head,
      proposals: nonTerminal.map((proposal) => ({
        id: proposal.id,
        status: proposal.status,
        ticket: proposal.queue?.ticket ?? null,
        seq: proposal.queue?.seq ?? null,
        queuedAt: proposal.queue?.queuedAt ?? proposal.createdAt ?? null,
        priority: proposal.queue?.priority ?? null,
        effectivePriority: proposal.queue?.effectivePriority ?? proposal.queue?.priority ?? null,
        op: proposal.op ?? null,
        target: proposal.target ?? null,
        originSessionId: proposal.origin?.sessionId ?? null,
        updatedAt: proposal.updatedAt ?? proposal.createdAt ?? null,
        attempts: Number.isInteger(proposal.queue?.attempts) ? proposal.queue.attempts : 0,
        apply: applyById.get(proposal.id) ?? null,
      })),
      assignments: nonTerminal
        .filter((proposal) => assignmentById.has(proposal.id))
        .map((proposal) => {
          const assignment = assignmentById.get(proposal.id);
          return {
            proposalId: proposal.id,
            ticket: assignment.ticket ?? null,
            seq: assignment.seq ?? ticketNumber(assignment.ticket),
          };
        }),
      segments: this.#segmentFiles().map((file) => path.basename(file)),
    };
    return snapshot;
  }

  /**
   * D-CR6: cross-process mutual exclusion for the read-lastSeq -> append (and
   * rotate) window. The lock is held for the whole operation and released in
   * finally; a foreign/stale holder is only replaced through OwnerLock's
   * five-step controlled takeover.
   */
  #withWalLock(fn) {
    const acquired = this.lock.acquire({ waitMs: this.lockWaitMs });
    if (!acquired.ok) {
      this.#auditSafe('wal.lock_busy', {
        reason: acquired.reason,
        holderPid: acquired.holder?.pid ?? null,
      });
      throw new StoreError('E_WAL_BUSY', 'WAL lock is held by another writer', { reason: acquired.reason });
    }
    try {
      return fn();
    } finally {
      this.lock.release();
    }
  }

  /**
   * Rotate the active file, then fold before pruning. Order is crash-safe:
   * rename -> (snapshot) -> prune. A crash after rename but before snapshot
   * simply replays the archived segment on top of the old snapshot.
   */
  rotate(options = {}) {
    return this.#withWalLock(() => this.#rotateLocked(options));
  }

  #rotateLocked({ force = false } = {}) {
    const state = this.read();
    if (state.broken) {
      throw new StoreError('E_WAL_BROKEN', 'cannot rotate a broken WAL', { brokenAt: state.brokenAt });
    }
    const stats = this.#activeStats();
    if (stats.lines === 0) return { rotated: false, reason: 'empty', snapshot: null, pruned: [] };
    if (!force && stats.bytes < this.maxBytes && stats.lines < this.maxLines) {
      return { rotated: false, reason: 'below-threshold', snapshot: null, pruned: [] };
    }
    const firstSeq = stats.parsed[0].seq;
    const lastLine = state.lines.at(-1) ?? stats.parsed.at(-1);
    if (!Number.isInteger(firstSeq) || !lastLine) return { rotated: false, reason: 'empty', snapshot: null, pruned: [] };

    const target = path.join(this.dir, `wal.${firstSeq}.jsonl`);
    if (fs.existsSync(target)) {
      // Two segments with the same first seq mean the file state was already
      // inconsistent; do not overwrite evidence.
      const error = new StoreError('E_WAL_SEGMENT_EXISTS', `segment ${path.basename(target)} already exists`, { segment: target });
      this.#auditSafe('wal.rotate_failed', { segment: path.basename(target), error: error.message });
      throw error;
    }
    try {
      fs.renameSync(this.file, target);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // Another writer rotated first; re-read and continue on the new active.
        const reread = this.read();
        return { rotated: false, reason: 'raced', snapshot: reread.snapshot, pruned: [] };
      }
      this.#auditSafe('wal.rotate_failed', { error: error?.code ?? 'E_RENAME' });
      throw new StoreError(error?.code ?? 'E_RENAME', error?.message ?? 'WAL rotate failed', { segment: target });
    }
    // Make the active path exist again even before the next append.
    try { fs.closeSync(fs.openSync(this.file, 'a')); } catch { /* append recreates it */ }

    let snapshot = null;
    let snapshotError = null;
    try {
      snapshot = this.#buildSnapshot(state);
      writeJsonStrict(this.snapshotFile, snapshot);
      this.#auditSafe('wal.snapshot', {
        upToSeq: snapshot.upToSeq,
        seqCounter: snapshot.seqCounter,
        proposals: snapshot.proposals.length,
      });
    } catch (error) {
      snapshotError = error;
      // Old snapshot + archived segment still replay without loss; keep every
      // segment (no pruning) and retry the fold on the next rotation.
      this.#auditSafe('wal.snapshot_failed', { error: error?.code ?? 'E_SNAPSHOT', message: String(error?.message ?? error) });
    }
    const pruned = snapshotError ? [] : this.pruneSegments();
    this.#auditSafe('wal.rotate', {
      segment: path.basename(target),
      upToSeq: stats.parsed.at(-1).seq,
      snapshot: snapshot ? snapshot.upToSeq : null,
      pruned: pruned.length,
    });
    return {
      rotated: true,
      segment: path.basename(target),
      upToSeq: snapshot?.upToSeq ?? null,
      snapshot,
      snapshotError: snapshotError ? (snapshotError.code ?? 'E_SNAPSHOT') : null,
      pruned,
    };
  }

  /**
   * Drop older-than-seven-days terminal lines from segments beyond the newest
   * `keepSegments`. Never runs without a snapshot. Each dropped line is written
   * to the audit archive first; if the audit call fails the line stays.
   */
  pruneSegments() {
    if (!this.readSnapshot()) return [];
    const segments = this.listSegments();
    const excess = segments.length - this.keepSegments;
    if (excess <= 0) return [];
    const proposals = scanProposalDir(this.dir).proposals;
    const proposalsById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const cutoff = this.now().getTime() - this.pruneAgeMs;
    const pruned = [];
    for (const segment of segments.slice(0, excess)) {
      let text = null;
      try { text = fs.readFileSync(segment.file, 'utf8'); } catch { continue; }
      const kept = [];
      const dropped = [];
      for (const raw of text.split('\n')) {
        if (raw.trim() === '') continue;
        let line = null;
        try { line = JSON.parse(raw); } catch { kept.push(raw); continue; }
        if (!this.#prunable(line, proposalsById, cutoff)) {
          kept.push(raw);
          continue;
        }
        if (!this.#archivePrunedEvent(line)) {
          // No audit archive: keeping the line is the only way not to lose an
          // incident record silently.
          kept.push(raw);
          continue;
        }
        dropped.push(line);
      }
      if (dropped.length === 0) continue;
      if (kept.length === 0) {
        try {
          fs.unlinkSync(segment.file);
          pruned.push({ segment: segment.name, dropped: dropped.length, removed: true });
        } catch {
          continue;
        }
      } else {
        const written = writeTextAtomic(segment.file, `${kept.join('\n')}\n`);
        if (!written.ok) {
          this.#auditSafe('wal.prune_failed', { segment: segment.name, error: written.error ?? 'E_WRITE' });
          continue;
        }
        pruned.push({ segment: segment.name, dropped: dropped.length, removed: false });
      }
      this.#auditSafe('wal.pruned', {
        segment: segment.name,
        dropped: dropped.length,
        events: dropped.map((line) => line.ev),
        removed: kept.length === 0,
      });
    }
    return pruned;
  }

  #prunable(line, proposalsById, cutoff) {
    if (!line || typeof line !== 'object') return false;
    const ev = String(line.ev ?? '');
    if (WAL_NEVER_PRUNE_EVENTS.includes(ev) || ev.startsWith('rollback.')) return false;
    const at = Date.parse(line.at ?? '');
    if (!Number.isFinite(at) || at >= cutoff) return false;
    const proposal = typeof line.proposalId === 'string' ? proposalsById.get(line.proposalId) : null;
    if (proposal) return isTerminalProposalStatus(proposal.status);
    return WAL_TERMINAL_EVENTS.has(ev);
  }

  #archivePrunedEvent(line) {
    if (typeof this.audit !== 'function') return false;
    try {
      this.audit('wal.pruned_event', { event: line });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Append one event. Refuses to append onto a broken chain: a line after a
   * break would make the break permanent and un-replayable (DESIGN §5.4).
   */
  append(ev, payload = {}) {
    if (typeof ev !== 'string' || ev === '') throw new StoreError('E_BAD_EVENT', 'WAL event name is required');
    // D-CR6: everything from the length/read check through fsync is one
    // cross-process critical section, so two writers can never both claim
    // seq N (the 20/20 duplicate-seq repro).
    return this.#withWalLock(() => {
      // A crash can leave a half-written tail with no newline. Cut it back to the
      // last complete line before appending; never let a new valid line concatenate
      // onto the corrupt fragment (DESIGN §3.7/§5.4).
      try {
        const raw = fs.readFileSync(this.file, 'utf8');
        if (raw.length > 0 && !raw.endsWith('\n')) {
          const cut = raw.lastIndexOf('\n');
          fs.truncateSync(this.file, cut >= 0 ? Buffer.byteLength(raw.slice(0, cut + 1), 'utf8') : 0);
          this.#auditSafe('wal.truncated', { bytes: Buffer.byteLength(raw, 'utf8') - (cut >= 0 ? Buffer.byteLength(raw.slice(0, cut + 1), 'utf8') : 0) });
        }
      } catch { /* no file yet */ }
      let state = this.read();
      if (state.broken) {
        this.#auditSafe('wal.broken', { brokenAt: state.brokenAt, lastSeq: state.lastSeq, error: state.error ?? null });
        throw new StoreError('E_WAL_BROKEN', 'WAL chain is broken; replay/rebuild required before appending', {
          brokenAt: state.brokenAt,
          error: state.error ?? null,
        });
      }
      // Rotate BEFORE writing, so a full active segment never receives another
      // line (DESIGN §3.5 limits are per segment). Already inside the lock.
      if (this.#shouldRotate()) {
        this.#rotateLocked();
        state = this.read();
        if (state.broken) {
          this.#auditSafe('wal.broken', { brokenAt: state.brokenAt, lastSeq: state.lastSeq });
          throw new StoreError('E_WAL_BROKEN', 'WAL chain is broken after rotation', { brokenAt: state.brokenAt });
        }
      }
      const body = { seq: state.lastSeq + 1, at: new Date().toISOString(), ev, ...payload };
      const prev = state.lastHash;
      const hash = `sha256:${sha256Hex(`${prev}\n${JSON.stringify(body)}`)}`;
      const line = { ...body, prev, hash };
      appendJsonLineDurable(this.file, line);
      return line;
    });
  }

  /** Find the last event matching a predicate in the replayable suffix. */
  last(predicate) {
    const state = this.read();
    for (let index = state.lines.length - 1; index >= 0; index -= 1) {
      if (predicate(state.lines[index])) return state.lines[index];
    }
    return null;
  }

  /** Folded apply.begin/rollback.begin for one proposal (survives rotation). */
  snapshotBegin(proposalId) {
    const snapshot = this.readSnapshot();
    const proposal = (snapshot?.proposals ?? []).find((candidate) => candidate.id === proposalId);
    return proposal?.apply ?? null;
  }

  status() {
    let bytes = 0;
    let segments = 0;
    try {
      bytes = fs.statSync(this.file).size;
    } catch { /* no file yet */ }
    try {
      segments = fs.readdirSync(this.dir).filter((name) => /^wal(\.\d+)?\.jsonl$/u.test(name)).length;
    } catch { /* no dir yet */ }
    const state = this.read();
    return {
      lastSeq: state.lastSeq,
      lastAt: state.lines.at(-1)?.at ?? state.snapshot?.lastAt ?? null,
      bytes,
      segments,
      broken: state.broken,
    };
  }
}

function queueHead(queue, proposals) {
  const entry = Array.isArray(queue?.entries) ? queue.entries[0] : null;
  if (entry && typeof entry.ticket === 'string') {
    return { ticket: entry.ticket, proposalId: entry.proposalId ?? null };
  }
  const ordered = [...proposals].sort((a, b) => {
    const pa = priorityIndex(a.queue?.effectivePriority ?? a.queue?.priority);
    const pb = priorityIndex(b.queue?.effectivePriority ?? b.queue?.priority);
    if (pa !== pb) return pa - pb;
    const at = Date.parse(a.queue?.queuedAt ?? a.createdAt ?? '');
    const bt = Date.parse(b.queue?.queuedAt ?? b.createdAt ?? '');
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return ticketNumber(a.queue?.ticket) - ticketNumber(b.queue?.ticket);
  });
  const first = ordered[0];
  return first ? { ticket: first.queue?.ticket ?? null, proposalId: first.id } : null;
}

function priorityIndex(priority) {
  const order = ['P0', 'P1', 'P2', 'P3', 'P4'];
  const index = order.indexOf(String(priority ?? 'P3'));
  return index < 0 ? 3 : index;
}

export function createWal(options) {
  return new Wal(options);
}
