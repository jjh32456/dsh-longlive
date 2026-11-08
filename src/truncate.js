// dsh-longlive — truncation core.
//
// Hard flow (SPEC §3). Every step either fully succeeds or leaves the original
// session file byte-identical:
//
//   read -> split frames -> parse -> plan cut at a turn/start boundary
//        -> build candidate (renumber seq, remap references, keep title,
//           drop agent/inbox/* = live-inbox traffic that a resumed session
//           must not inherit)
//        -> prove deriveMessages digest unchanged
//        -> prove inbox projection replays from an empty inbox
//        -> verify backup exists with the right sha256
//        -> write *.tmp -> re-read/verify tmp -> atomic rename
//        -> re-read final -> ledger (or restore from backup + rollback.json)
//
// Nothing here reads message content beyond the fields needed to fold the
// Surface and hash the visible messages.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseSession,
  encodeSession,
  deriveMessagesDigest,
  assertContiguous,
  foldSurface,
  sha256,
  MESSAGE_TYPES,
} from './codec.js';
import { ensureBackup, verifyBackup } from './backup.js';

export const DEFAULT_KEEP_EVENTS = 20000;
export const RECENT_WRITE_WINDOW_MS = 60_000;
export const EVENTS_PER_FRAME = 2000;
export const CONFIRM_WORD = 'TRUNCATE';
export const INBOX_GUARD_WINDOW = 100;
// The session log's file name, and therefore the root of every backup name.
// Kept local so this module never imports the tool layer (tools.js imports us).
export const SESSION_FILENAME = 'session.v4.jsonl.zstd';

export const ERROR_CODES = {
  NOT_FOUND: 'SESSION_NOT_FOUND',
  RECENT_WRITE: 'SESSION_RECENT_WRITE',
  LOCKED: 'SESSION_LOCKED',
  FILE_BUSY: 'VISIBLE_FILE_BUSY',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  BACKUP_MISSING: 'BACKUP_MISSING',
  BACKUP_MISMATCH: 'BACKUP_SHA256_MISMATCH',
  NO_BOUNDARY: 'NO_TURN_BOUNDARY',
  CONVERSATION_CHANGED: 'VISIBLE_CONVERSATION_CHANGED',
  INBOX_INVALID: 'INBOX_PROJECTION_INVALID',
  IS_BACKUP: 'IS_BACKUP',
  TMP_VERIFY: 'TMP_VERIFY_FAILED',
  POST_VERIFY: 'POST_WRITE_VERIFY_FAILED',
  CHANGED: 'SESSION_CHANGED',
  CORRUPT: 'SESSION_CORRUPT',
  BAD_ARGUMENT: 'BAD_ARGUMENT',
};

export function sessionError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/** Types stored only for logging; dropping them cannot change the Surface. */
const LOG_ONLY_TYPES = new Set(['compaction/prune']);

/**
 * Live agent-inbox traffic. A resumed session projects the inbox from an empty
 * state, so splices that assumed items carried over from before the cut would
 * throw `invalid persisted inbox splice at session seq N` (the 2026-10-30 bug).
 * Dropping them is conservative: they are not part of the visible conversation.
 */
export function isInboxEvent(event) {
  return typeof event.type === 'string' && event.type.startsWith('agent/inbox/');
}

function truncationLedgerPath(sessionPath) {
  return path.join(path.dirname(sessionPath), 'truncate.json');
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** True when the first `window` retained events contain live inbox traffic. */
function inboxInWindow(events, index, window = INBOX_GUARD_WINDOW) {
  return events.slice(index, index + window).some(isInboxEvent);
}

export function planTruncation(parsed, { keepEvents = DEFAULT_KEEP_EVENTS } = {}) {
  const events = parsed.events;
  if (!Number.isInteger(keepEvents) || keepEvents < 1) {
    throw sessionError(ERROR_CODES.BAD_ARGUMENT, `keepEvents must be a positive integer (got ${keepEvents})`);
  }
  if (events.length <= keepEvents) return { needed: false, events: events.length, keepEvents };

  const naive = events.length - keepEvents;
  let index = naive;
  while (index < events.length && events[index].type !== 'turn/start') index += 1;
  if (index >= events.length) {
    throw sessionError(ERROR_CODES.NO_BOUNDARY,
      'cannot find a turn/start boundary inside the keep window; refusing to cut mid-turn');
  }

  // Dropping an event is only safe when it is already invisible in the
  // original Surface. Everything from the first visible message onward must
  // survive, so the cut can never be later than that node's seq.
  const visible = foldSurface(events).filter((node) => MESSAGE_TYPES.has(node.type));
  const firstVisibleSeq = visible.length > 0 ? visible[0].seq : events.length;
  let limitedByVisible = false;
  if (index > firstVisibleSeq) {
    let j = Math.min(firstVisibleSeq, events.length - 1);
    while (j >= 0 && events[j].type !== 'turn/start') j -= 1;
    if (j < 0) {
      throw sessionError(ERROR_CODES.NO_BOUNDARY,
        `no turn/start at or before the first visible message (seq ${firstVisibleSeq})`);
    }
    index = j;
    limitedByVisible = true;
  }

  const cutTurn = events[index].data?.turn;
  if (!Number.isInteger(cutTurn) || cutTurn < 1) {
    throw sessionError(ERROR_CODES.NO_BOUNDARY, `turn/start at seq ${index} has no usable turn number`);
  }
  return {
    needed: true,
    keepEvents,
    naiveCutIndex: naive,
    cutIndex: index,
    cutSeq: index,
    cutTurn,
    firstVisibleSeq,
    limitedByVisible,
    droppedEvents: index,
    retainedEvents: events.length - index,
    inboxInWindow: inboxInWindow(events, index),
  };
}

function compactionGroupId(event) {
  const data = event.data ?? {};
  if (event.type.startsWith('compaction/')) return data.compactionId ?? null;
  if (data.source && typeof data.source === 'object' && data.source.compactionId) {
    return data.source.compactionId;
  }
  return null;
}

function assertGroupsDoNotStraddleCut(events, cutIndex) {
  const groups = new Map();
  events.forEach((event, index) => {
    const id = compactionGroupId(event);
    if (!id) return;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(index);
  });
  for (const [id, members] of groups) {
    const before = members.filter((i) => i < cutIndex).length;
    const after = members.filter((i) => i >= cutIndex).length;
    if (before > 0 && after > 0) {
      throw sessionError(ERROR_CODES.NO_BOUNDARY,
        `compaction block ${id} straddles the cut (${before} before, ${after} after); ` +
        'choose a keepEvents value that keeps the whole compaction block');
    }
  }
}

function isProtectedHead(event) {
  return event.type === 'system/message' && event.surfaceOp === 'append';
}

function needsProtectedHead(retained) {
  return retained.some((e) => e.type === 'system/message' && (e.surfaceOp === 'append' || e.surfaceOp === undefined))
    && !retained.some(isProtectedHead);
}

/**
 * Replay `agent/inbox/spliced` over the empty projection state the host uses on
 * resume. Mirrors dsh-agent-loop: init {next-turn:[], next-step:[]}; a splice
 * must satisfy 0 <= start <= start+removedCount <= queue.length.
 */
export function checkInboxProjection(events) {
  const state = { 'next-turn': [], 'next-step': [] };
  let splices = 0;
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    splices += 1;
    const splice = event.data ?? {};
    const queue = state[splice.target];
    const removedCount = splice.removedCount ?? 0;
    const invalid = (why) => sessionError(ERROR_CODES.INBOX_INVALID,
      `invalid persisted inbox splice at session seq ${event.seq}: ${why}`);
    if (!Array.isArray(queue)) throw invalid(`unknown target ${JSON.stringify(splice.target)}`);
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > queue.length) {
      throw invalid(`start ${splice.start} is outside 0..${queue.length}`);
    }
    if (!Number.isSafeInteger(removedCount) || removedCount < 0 || splice.start + removedCount > queue.length) {
      throw invalid(`start ${splice.start} + removedCount ${removedCount} > ${queue.length} projected item(s)`);
    }
    if (!Array.isArray(splice.inserted)) throw invalid('inserted must be an array');
    queue.splice(splice.start, removedCount, ...splice.inserted);
    const ids = new Set();
    const merged = splice.target === 'next-turn'
      ? [...queue, ...state['next-step']]
      : [...state['next-turn'], ...queue];
    for (const message of merged) {
      const id = message && typeof message === 'object' ? message.id : undefined;
      if (id === undefined) continue;
      if (ids.has(id)) throw invalid(`message "${id}" is already pending`);
      ids.add(id);
    }
  }
  return { splices, ok: true };
}

/**
 * One rewrite pass: number the surviving events and remap every reference
 * against that numbering. Events whose references point at something that no
 * longer exists are reported as dropped; the caller removes them and runs
 * another pass, because dropping shifts the numbering the references were
 * computed against.
 */
function rewritePass(work, { cutIndex, cutTurn, hasHead, dropOldSeqs = new Set(), chainFinalOldSeq = null }) {
  const map = new Map();
  work.forEach((w, i) => { if (!w.inserted) map.set(w.oldSeq, i); });
  const mapOne = (oldSeq) => (oldSeq < 0 ? map.get(oldSeq) : oldSeq < cutIndex ? undefined : map.get(oldSeq));
  const out = [];
  const droppedIndexes = new Set();

  work.forEach((w, index) => {
    // Prompt-chain events are folded into the carried head; their old targets
    // are gone, so they must not survive as nodes of their own.
    if (!w.inserted && dropOldSeqs.has(w.oldSeq)) {
      droppedIndexes.add(index);
      return;
    }
    const event = structuredClone(w.event);
    if (w.inserted) {
      // Only the carried system head is a Surface node that has to sit inside
      // turn/step 1; the seeded-observability marker keeps its own shape.
      if (event.type === 'system/message') {
        event.data = { ...(event.data ?? {}), turn: 1, step: 1 };
        event.__insertedHead = true;
      }
    }
    // The chain's last rewrite is retargeted onto the carried head: it deletes
    // the head node and takes the head's original position in the Surface, so
    // the visible conversation keeps the order it had before the truncation.
    const isChainFinal = w.oldSeq === chainFinalOldSeq;
    if (isChainFinal) event.__chainFinal = true;
    let lost = false;

    if (!isChainFinal && event.surfaceOp && typeof event.surfaceOp === 'object') {
      const start = event.surfaceOp.startSeq ?? event.surfaceOp.start;
      const end = event.surfaceOp.endSeq ?? event.surfaceOp.end;
      // A negative range is a carried throwaway node (see buildTruncated): it
      // always survives, so it maps like any other kept reference.
      if (end < cutIndex && end >= 0) {
        // Every node this replacement covered is gone and nothing carried it
        // across, so the replacement cannot stay legal.
        lost = true;
      } else {
        const mappedStart = start < cutIndex && start >= 0 ? 0 : mapOne(start);
        const mappedEnd = mapOne(end);
        if (mappedStart === undefined || mappedEnd === undefined || mappedEnd < mappedStart) lost = true;
        else event.surfaceOp = { op: 'replace', startSeq: mappedStart, endSeq: mappedEnd };
      }
    }

    if (Array.isArray(event.sourceEventSeqs)) {
      const mapped = [];
      for (const ref of event.sourceEventSeqs) {
        const at = mapOne(ref);
        if (at !== undefined) mapped.push(at);
      }
      const unique = [...new Set(mapped)].sort((a, b) => a - b);
      if (unique.length > 0) event.sourceEventSeqs = unique;
      else delete event.sourceEventSeqs;
    }

    const data = event.data;
    if (!lost && data && typeof data === 'object') {
      if (typeof data.throughSeq === 'number') {
        const at = mapOne(data.throughSeq);
        if (at === undefined) lost = true;
        else data.throughSeq = Math.min(at, out.length - 1);
      }
      if (Array.isArray(data.shadowedSeqs)) {
        data.shadowedSeqs = [...new Set(data.shadowedSeqs.map((s) => mapOne(s)).filter((v) => v !== undefined))]
          .sort((a, b) => a - b);
      }
      if (data.shadowedRange) {
        const start = data.shadowedRange.start;
        const end = data.shadowedRange.end;
        if (end < cutIndex) {
          delete data.shadowedRange;
        } else {
          const mappedStart = start < cutIndex ? 0 : mapOne(start);
          const mappedEnd = mapOne(end);
          if (mappedStart === undefined || mappedEnd === undefined || mappedEnd < mappedStart) lost = true;
          else data.shadowedRange = { start: mappedStart, end: mappedEnd };
        }
      }
      if (Array.isArray(data.messageSeqs)) {
        data.messageSeqs = [...new Set(data.messageSeqs.map((s) => mapOne(s)).filter((v) => v !== undefined))]
          .sort((a, b) => a - b);
      }
      if (typeof data.headerSeq === 'number') {
        const at = mapOne(data.headerSeq);
        if (at === undefined) delete data.headerSeq;
        else data.headerSeq = at;
      }
      if (typeof data.sourceEventSeq === 'number') {
        const at = mapOne(data.sourceEventSeq);
        if (at === undefined) delete data.sourceEventSeq;
        else data.sourceEventSeq = at;
      }
      if (!w.inserted && typeof data.turn === 'number') data.turn -= cutTurn - 1;
    }

    if (lost) droppedIndexes.add(index);
    else out.push(event);
  });

  out.forEach((event, index) => { event.seq = index; });
  const headFinal = out.findIndex((event) => event.__insertedHead === true);
  for (const event of out) delete event.__insertedHead;
  if (headFinal >= 0) {
    for (const event of out) {
      if (event.__chainFinal !== true) continue;
      event.surfaceOp = { op: 'replace', startSeq: headFinal, endSeq: headFinal };
      event.sourceEventSeqs = [headFinal];
      delete event.__chainFinal;
    }
    // The host requires the very first Surface node to be the protected system
    // message. A replacement whose range was clamped to 0 (because it started
    // before the cut) must not swallow that head, so start it after the head.
    for (const event of out) {
      const op = event.surfaceOp;
      if (op && typeof op === 'object' && op.startSeq < headFinal && op.endSeq > headFinal) {
        event.surfaceOp = { op: 'replace', startSeq: headFinal + 1, endSeq: op.endSeq };
      }
    }
  }

  return { events: out, droppedIndexes };
}

/**
 * A seeded v4 log carries its inherited cut as a marker EVENT rather than a
 * header field: one `session/end-seed` row with `data.inherited === true`, and
 * the decoders derive `inheritedEventCount` from the LAST such row.
 *
 * `@deepseek-ai/dsh-session-format-v1-to-v2` finish(): a seeded header without
 * one throws "released v2 seeded Session lacks an inherited end-seed marker";
 * an unseeded header that still has one throws "released v2 unseeded Session
 * contains an inherited end-seed marker". v3-to-v4 repeats the rule as "format
 * v4 seeded header disagrees with its last inherited end-seed marker", and
 * `dsh-session`'s constructor refuses a second marker after the inherited cut.
 * Truncation must therefore rewrite this metadata together with the events.
 *
 * (Defined here, not imported: truncate-visible.js imports this module.)
 */
function isInheritedSeedMarker(event) {
  return Boolean(event)
    && event.type === 'session/end-seed'
    && event.data !== null
    && typeof event.data === 'object'
    && event.data.inherited === true;
}

export function buildTruncated(parsed, plan) {
  const { header, events } = parsed;
  const cutIndex = plan.cutIndex;
  const cutTurn = plan.cutTurn;
  assertGroupsDoNotStraddleCut(events, cutIndex);

  const retainedOriginal = events.slice(cutIndex);
  // The host insists that the first Surface node of a log is a protected
  // system message. If the cut removes the original head, carry a copy of it
  // across, rewritten to the *final* prompt text: the head's replacement chain
  // (2160 -> 10466 -> ...) would otherwise dangle once its target seqs are gone,
  // and a rewrite retargeted onto the head would delete it.
  const originalHead = events.find(isProtectedHead) ?? null;
  let insertedHead = null;
  let chainFinalOldSeq = null;
  const dropOldSeqs = new Set();
  // The head is visible only through its replacement chain: a checkpoint may
  // shadow the head itself, and prompt rewrites replace it in turn. Copy the
  // head across only when the chain's final node is one of the visible surface
  // nodes; otherwise the copy would ADD a message to the conversation.
  const originalSurfaceSeqs = new Set(foldSurface(events).map((node) => node.seq));
  if (originalHead && originalHead.seq < cutIndex) {
    let node = originalHead.seq;
    let finalData = originalHead.data;
    const chain = [];
    for (const event of events) {
      if (event.type !== 'system/message' && event.type !== 'developer/message') continue;
      const op = event.surfaceOp;
      if (!op || typeof op !== 'object') continue;
      const start = op.startSeq ?? op.start;
      const end = op.endSeq ?? op.end;
      if (start <= node && node <= end) {
        node = event.seq;
        finalData = event.data;
        chain.push(event.seq);
      }
    }
    if (originalSurfaceSeqs.has(node)) {
      // The last rewrite stays behind and is retargeted onto the carried head,
      // so the message keeps its original position in the folded Surface.
      for (const seq of chain.slice(0, -1)) dropOldSeqs.add(seq);
      chainFinalOldSeq = chain.length > 0 ? chain[chain.length - 1] : null;
      if (chainFinalOldSeq !== null && chainFinalOldSeq < cutIndex) {
        dropOldSeqs.add(chainFinalOldSeq);
        chainFinalOldSeq = null;
      }
      insertedHead = { ...structuredClone(originalHead), data: structuredClone(finalData ?? {}) };
    }
  }

  // A compaction group whose whole shadowed range lies before the cut has
  // nothing left to shadow: everything it replaced was cut away. Keeping the
  // group would demand a surface span over nodes that no longer exist, so the
  // group is dropped and its checkpoint becomes a plain user message.
  const compactionIds = new Map();
  for (const event of events) {
    const data = event.data ?? {};
    const id = data.compactionId ?? data.source?.compactionId;
    if (!id) continue;
    if (!compactionIds.has(id)) compactionIds.set(id, []);
    compactionIds.get(id).push(event);
  }
  const mootCompactions = new Set();
  for (const [id, group] of compactionIds) {
    const targets = [];
    for (const event of group) {
      const data = event.data ?? {};
      if (Array.isArray(data.shadowedSeqs)) targets.push(...data.shadowedSeqs);
      const range = data.shadowedRange;
      if (range && typeof range.start === 'number') targets.push(range.start, range.end);
    }
    if (targets.length > 0 && targets.every((seq) => seq < cutIndex)) mootCompactions.add(id);
  }

  let work = retainedOriginal
    .filter((event) => !isInboxEvent(event))
    // No inherited marker may survive inside the kept window: it would announce
    // a cut at its own position, and the decoders insist the last such marker
    // equals the header's inherited cut. The single marker written below
    // replaces every one that used to live in the dropped prefix.
    .filter((event) => !isInheritedSeedMarker(event))
    .filter((event) => {
      const id = event.data?.compactionId ?? event.data?.source?.compactionId;
      return !(id !== undefined && mootCompactions.has(id) && event.type !== 'user/message');
    })
    .map((event) => ({ event: structuredClone(event), oldSeq: event.seq, inserted: false }));
  for (const wrap of work) {
    const data = wrap.event.data ?? {};
    if (data.source?.kind === 'compact-checkpoint' && mootCompactions.has(data.source.compactionId)) {
      wrap.event.surfaceOp = 'append';
      delete wrap.event.sourceEventSeqs;
    }
  }
  if (insertedHead) {
    const pos = work.findIndex((w) => w.event.type === 'step/start');
    work.splice(pos >= 0 ? pos + 1 : 0, 0, {
      event: structuredClone(insertedHead),
      oldSeq: insertedHead.seq,
      inserted: true,
    });
  }
  work = work.filter((w) => w.inserted || !LOG_ONLY_TYPES.has(w.event.type));

  // `delivery-accepted` acknowledges a seq that must still exist afterwards.
  const presentOld = new Set(work.filter((w) => !w.inserted).map((w) => w.oldSeq));
  work = work.filter((w) => {
    const through = w.event.data?.throughSeq;
    return !(typeof through === 'number' && (through < cutIndex || !presentOld.has(through)));
  });

  // A pruned tool result is a `replace` whose target lies before the cut. The
  // target went away with the prefix, so the replacement has nothing left to
  // name; the host rejects it outright. Drop the whole event: what it showed
  // was already filler left by pruning, and the log stays self-consistent.
  // This is exactly the strategy that resumed cleanly on the real session.
  work = work.filter((w) => {
    if (w.inserted) return true;
    const op = w.event.surfaceOp;
    if (!op || typeof op !== 'object') return true;
    const end = op.endSeq ?? op.end;
    if (typeof end !== 'number' || end >= cutIndex) return true;
    return w.event.type === 'system/message' || w.event.type === 'developer/message';
  });

  // Seeded logs: the inherited prefix is exactly what a prefix cut removes, so
  // the marker that described it has to be rewritten rather than dropped with
  // it. One fresh marker at index 0 declares an explicitly empty inherited
  // prefix - a shape `@deepseek-ai/dsh-subagent` documents as supported and the
  // decoder accepts (`inheritedEventCount === 0`). Clearing `isSeeded` instead
  // would silently re-label a detached child as a fresh session, and leaving
  // `isSeeded` with no marker is the 0.7.4 corruption.
  const seeded = header.isSeeded === true;
  let seedMarker = null;
  if (seeded) {
    seedMarker = { type: 'session/end-seed', inherited: true, index: 0, inheritedEventCount: 0 };
    work.unshift({
      event: { type: 'session/end-seed', time: Date.now(), data: { inherited: true } },
      oldSeq: -1,
      inserted: true,
    });
  }

  // Rewrite until stable: a pass may drop events whose references are gone,
  // and dropping shifts the numbering, so another pass is needed to check.
  const ctx = { cutIndex, cutTurn, hasHead: Boolean(insertedHead), dropOldSeqs, chainFinalOldSeq };
  let pass = { events: [], droppedIndexes: new Set() };
  for (let round = 0; round < 5; round += 1) {
    pass = rewritePass(work, ctx);
    if (pass.droppedIndexes.size === 0) break;
    work = work.filter((_, index) => !pass.droppedIndexes.has(index));
  }
  const out = pass.events;
  assertContiguous(out);

  // A resumed session projects its inbox from empty, so the kept window must
  // not open with live inbox traffic (the 2026-10-30 `invalid persisted inbox
  // splice` bug). We drop every agent/inbox/* event, so this is a guarantee.
  const opening = out.slice(0, INBOX_GUARD_WINDOW).filter(isInboxEvent);
  if (opening.length > 0) {
    throw sessionError(ERROR_CODES.INBOX_INVALID,
      `kept window still opens with ${opening.length} agent/inbox event(s); refusing to truncate`);
  }

  // A checkpoint whose replacement reached into the cut prefix names a range
  // that no longer starts on a surface node. Clamp it to the surviving surface
  // nodes it actually covers; if nothing is left to shadow, it becomes a plain
  // user message (the prefix it used to summarize is gone).
  {
    for (let at = 0; at < out.length; at += 1) {
      const event = out[at];
      if (event.type !== 'user/message') continue;
      if (event.data?.source?.kind !== 'compact-checkpoint') continue;
      const op = event.surfaceOp;
      if (!op || typeof op !== 'object') continue;
      const nodes = foldSurface(out.slice(0, at)).map((node) => node.seq);
      const startOk = nodes.includes(op.startSeq);
      const endOk = nodes.includes(op.endSeq);
      if (startOk && endOk) continue;
      const inside = nodes.filter((seq) => seq >= (startOk ? op.startSeq : 0) && seq <= op.endSeq);
      if (inside.length === 0) {
        event.surfaceOp = 'append';
        delete event.sourceEventSeqs;
        continue;
      }
      event.surfaceOp = { op: 'replace', startSeq: inside[0], endSeq: inside[inside.length - 1] };
      event.sourceEventSeqs = [...inside];
    }
  }

  // Compaction spans must name an exact contiguous slice of the folded
  // Surface. Dropping nodes inside a span leaves the mapped seq list short, and
  // a checkpoint that was retargeted onto the kept window shadows a different
  // span than the original summary did. Both are rebuilt here: a summary takes
  // the exact span its checkpoint replaces, and any span left over is trimmed
  // to the surviving nodes it still names.
  {
    for (let at = 0; at < out.length; at += 1) {
      const checkpoint = out[at];
      if (checkpoint.type !== 'user/message') continue;
      const compactionId = checkpoint.data?.source?.compactionId;
      if (compactionId === undefined) continue;
      const op = checkpoint.surfaceOp;
      if (!op || typeof op !== 'object') continue;
      const nodes = foldSurface(out.slice(0, at)).map((node) => node.seq);
      const startIndex = nodes.indexOf(op.startSeq);
      const endIndex = nodes.indexOf(op.endSeq);
      if (startIndex < 0 || endIndex < startIndex) continue;
      const slice = nodes.slice(startIndex, endIndex + 1);
      for (let back = 0; back < at; back += 1) {
        const summary = out[back];
        if (summary.type !== 'compaction/summary' && summary.type !== 'compaction/prune') continue;
        if (summary.data?.compactionId !== compactionId) continue;
        summary.data.shadowedSeqs = slice;
        summary.data.shadowedRange = { start: slice[0], end: slice[slice.length - 1] };
      }
    }
    const nodes = foldSurface(out).map((node) => node.seq);
    const nodeSet = new Set(nodes);
    const indexOf = new Map(nodes.map((seq, at) => [seq, at]));
    for (const event of out) {
      if (event.type !== 'compaction/summary' && event.type !== 'compaction/prune') continue;
      const data = event.data ?? {};
      const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.filter((seq) => nodeSet.has(seq)) : [];
      if (seqs.length === 0) continue;
      const lo = Math.min(...seqs);
      const hi = Math.max(...seqs);
      const slice = nodes.slice(indexOf.get(lo), indexOf.get(hi) + 1);
      if (slice.length !== seqs.length) continue;
      data.shadowedSeqs = [...slice];
      data.shadowedRange = { start: lo, end: hi };
    }
  }

  const headerOut = structuredClone(header);
  // The physical header line accepts a fixed key set (isHeaderLine in
  // dsh-session-persistence-jsonl) and has no inheritedEventCount field, so the
  // old `headerOut.inheritedEventCount = 0` never reached disk. The cut now
  // travels on `seedMarker`; keep `isSeeded` as it was and drop any in-memory
  // stray so an unknown key can never be encoded.
  delete headerOut.inheritedEventCount;

  return { header: headerOut, events: out, insertedHead: Boolean(insertedHead), seedMarker };
}

/** Compare the visible conversation before and after the candidate rewrite. */
export function assertSameConversation(parsed, candidate) {
  const before = deriveMessagesDigest(parsed.header, parsed.events);
  const after = deriveMessagesDigest(candidate.header, candidate.events);
  if (before.sha256 !== after.sha256) {
    throw sessionError(ERROR_CODES.CONVERSATION_CHANGED,
      'refusing to truncate: the kept window would change the visible conversation ' +
      `(${before.count} messages / ${before.sha256.slice(0, 12)} -> ${after.count} messages / ${after.sha256.slice(0, 12)}). ` +
      'Raise keepEvents so every still-visible message is kept.');
  }
  return { before, after };
}

function ensureTitle(events, originalEvents, cutIndex, map) {
  if (events.some((e) => e.type === 'session/title')) return false;
  let title = null;
  for (let i = originalEvents.length - 1; i >= 0; i -= 1) {
    if (originalEvents[i].type === 'session/title') { title = originalEvents[i]; break; }
  }
  if (!title) return false;
  const copy = structuredClone(title);
  copy.seq = events.length;
  if (Array.isArray(copy.data?.messageSeqs)) {
    copy.data.messageSeqs = copy.data.messageSeqs
      .filter((s) => s >= cutIndex && map.has(s))
      .map((s) => map.get(s));
  }
  events.push(copy);
  return true;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Windows-only exclusive-handle probe.
 *
 * `fs.openSync(path, 'r+')` succeeds while another process also has the file
 * open with share flags (a running DSH keeps its session log open), so it can
 * never tell "idle file" from "live owner". Opening with FileShare.None fails
 * when ANY other handle exists, which is the signal this guard needs. The probe
 * runs in a child process so the handle is released before we rename.
 *
 * Returns { ok, skipped?, detail? }: `skipped` means the probe itself is
 * unavailable (non-Windows, no PowerShell) and the caller falls back.
 */
function exclusiveWriteProbe(sessionPath) {
  if (process.platform !== 'win32') {
    return {
      ok: true,
      skipped: `non-windows: the exclusive-handle probe needs Windows PowerShell (FileShare.None); ` +
        `on ${process.platform} only the freshness window and fs.openSync('r+') guard this write`,
    };
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    '$handle=[System.IO.File]::Open($env:DSH_LIVE_PROBE_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)',
    '$handle.Dispose()',
    "Write-Output 'DSH_PROBE_FREE'",
  ].join('; ');
  let result;
  try {
    result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, DSH_LIVE_PROBE_PATH: sessionPath },
    });
  } catch (error) {
    return { ok: true, skipped: `probe-unavailable:${error.code ?? error.message}` };
  }
  if (result.error) return { ok: true, skipped: `probe-unavailable:${result.error.code ?? result.error.message}` };
  if (result.status === 0) return { ok: true };
  const raw = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('<Objs') && !line.startsWith('</Objs'))
    .slice(-3)
    .join(' ')
    .slice(0, 300);
  return { ok: false, detail: raw || (result.status === null ? 'probe-timeout' : `exit ${result.status}`) };
}

/**
 * Refuse while the session looks live: held open, or modified recently.
 *
 * `onProbe` receives the raw probe result so a caller that reports on its
 * checks (live-target.js) can say "unverified on this platform" instead of
 * mistaking a skipped probe for proof that the handle is free.
 */
export function assertNotLive(sessionPath, {
  recentWriteWindowMs = RECENT_WRITE_WINDOW_MS,
  now = Date.now(),
  onProbe = null,
} = {}) {
  // Handle-level check first: this is the one that catches a running app even
  // when its last write is older than the freshness window (the 0.7.1 hole:
  // idle for 60 s -> the mtime guard waved the write through and tore the log).
  const probe = exclusiveWriteProbe(sessionPath);
  if (typeof onProbe === 'function') {
    try { onProbe(probe); } catch { /* a reporting hook must not change the verdict */ }
  }
  if (!probe.ok) {
    throw sessionError(ERROR_CODES.FILE_BUSY,
      `cannot take an exclusive write handle on the session log (${probe.detail}); ` +
      'another process — most likely the app running this session — still holds it. ' +
      'Close that app and retry; the plugin never kills a process.');
  }
  const stat = fs.statSync(sessionPath);
  const ageMs = now - stat.mtimeMs;
  // <= 0 disables the freshness guard (tests and deliberate maintenance runs).
  if (recentWriteWindowMs > 0 && ageMs < recentWriteWindowMs) {
    throw sessionError(ERROR_CODES.RECENT_WRITE,
      `session log changed ${Math.round(ageMs / 1000)} s ago (<= ${Math.round(recentWriteWindowMs / 1000)} s); ` +
      'a running session may be writing. Stop that session first; the plugin never truncates a live log.');
  }
  try {
    const fd = fs.openSync(sessionPath, 'r+');
    fs.closeSync(fd);
  } catch (error) {
    throw sessionError(ERROR_CODES.LOCKED,
      `cannot open the session log for writing (${error.code ?? error.message}); ` +
      'another process may hold it. Close it and retry; the plugin never kills a process.', error);
  }
}

/**
 * Read the log once and record the identity of exactly those bytes.
 *
 * The size and mtime are cheap tripwires, the sha256 is what decides: a writer
 * can append and keep the size identical (a replacement, not an append), so a
 * length-only check would overwrite new history without noticing.
 */
function readSnapshot(abs) {
  const buf = fs.readFileSync(abs);
  const stat = fs.statSync(abs);
  return {
    buf,
    size: buf.length,
    statSize: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(buf),
  };
}

/** Refuse to overwrite a log whose bytes are no longer the snapshot's bytes. */
function assertUnchanged(abs, snapshot) {
  let now;
  try {
    const buf = fs.readFileSync(abs);
    const stat = fs.statSync(abs);
    now = { size: buf.length, statSize: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(buf) };
  } catch (error) {
    throw sessionError(ERROR_CODES.CHANGED,
      `session log became unreadable while truncating (${error.code ?? error.message}); nothing was written`, error);
  }
  const changed = now.sha256 !== snapshot.sha256
    || now.size !== snapshot.size
    || now.mtimeMs !== snapshot.mtimeMs;
  if (changed) {
    throw sessionError(ERROR_CODES.CHANGED,
      'session log changed while truncating: ' +
      `${snapshot.size} B/${snapshot.sha256.slice(0, 12)} -> ${now.size} B/${now.sha256.slice(0, 12)}. ` +
      'Another writer appended or the file was replaced; refusing to rename over it so that write is not lost. ' +
      'Nothing was written — stop the writer and retry.');
  }
}

/**
 * Full truncation flow. `dryRun: true` (default) performs every read and
 * computation but writes nothing — no tmp, no backup, no ledger.
 */
export function truncateSession(sessionPath, options = {}) {
  const {
    keepEvents = DEFAULT_KEEP_EVENTS,
    dryRun = true,
    confirm,
    now = new Date(),
    recentWriteWindowMs = RECENT_WRITE_WINDOW_MS,
    eventsPerFrame = EVENTS_PER_FRAME,
  } = options;

  if (!sessionPath || typeof sessionPath !== 'string') {
    throw sessionError(ERROR_CODES.BAD_ARGUMENT, 'sessionPath is required');
  }
  const abs = path.resolve(sessionPath);
  if (!fs.existsSync(abs)) {
    throw sessionError(ERROR_CODES.NOT_FOUND,
      `session log not found: ${abs} — run session_health to list available sessions, ` +
      'or pass sessionId / session:"latest" instead of guessing a path. Nothing was written.');
  }
  // A backup is the rollback source, never a truncation target (N4). The tool
  // layer refuses this before calling in; the check lives here too so a direct
  // library call cannot eat the only way back.
  const baseName = path.basename(abs);
  if (baseName.startsWith(`${SESSION_FILENAME}.bak-`)) {
    throw sessionError(ERROR_CODES.IS_BACKUP,
      `refusing to truncate a backup: ${baseName} is a ${SESSION_FILENAME} backup. ` +
      `Point at ${SESSION_FILENAME}; the backup is the rollback source.`);
  }
  assertNotLive(abs, { recentWriteWindowMs });

  // One read, one snapshot: everything below is computed from these bytes, and
  // the same bytes are what the backup is written from (N1).
  const snapshot = readSnapshot(abs);
  const originalBuf = snapshot.buf;
  let parsed;
  try {
    parsed = parseSession(originalBuf);
  } catch (error) {
    throw sessionError(ERROR_CODES.CORRUPT,
      `${error.message} — the log was left untouched. Check session_health first; ` +
      'if the file is still being written, stop that session and retry.', error);
  }
  checkInboxProjection(parsed.events);

  const plan = planTruncation(parsed, { keepEvents });
  if (!plan.needed) {
    return {
      dryRun, needed: false, sessionPath: abs,
      beforeBytes: originalBuf.length, beforeEvents: parsed.events.length, keepEvents,
      message: `nothing to do: ${parsed.events.length} events <= keepEvents ${keepEvents}`,
    };
  }

  const candidate = buildTruncated(parsed, plan);
  const conversation = assertSameConversation(parsed, candidate);
  const map = new Map(parsed.events.slice(plan.cutIndex).map((e, i) => [e.seq, i]));
  const createdTitle = ensureTitle(candidate.events, parsed.events, plan.cutIndex, map);
  if (createdTitle) candidate.events.forEach((event, index) => { event.seq = index; });
  assertContiguous(candidate.events);
  const inbox = checkInboxProjection(candidate.events);

  const buffer = encodeSession(candidate.header, candidate.events, { eventsPerFrame });

  // The visibility guard can move the cut to the first turn boundary, where
  // the protected head is dropped and re-inserted: the rebuilt log then has
  // the same number of events as the original. Report that honestly as a
  // no-op — a dry run must never promise a cut the real run cannot shrink.
  if (candidate.events.length >= parsed.events.length) {
    return {
      dryRun, needed: false, sessionPath: abs, keepEvents,
      cutSeq: plan.cutSeq, cutTurn: plan.cutTurn,
      beforeBytes: originalBuf.length, afterBytes: buffer.length,
      beforeEvents: parsed.events.length, afterEvents: candidate.events.length,
      message: 'nothing to do: the safe cut at seq ' + plan.cutSeq +
        ' keeps every visible message and would not shrink the log (' +
        parsed.events.length + ' events -> ' + candidate.events.length + ' events)',
    };
  }

  const summary = {
    dryRun,
    needed: true,
    sessionPath: abs,
    cutSeq: plan.cutSeq,
    cutTurn: plan.cutTurn,
    advancedForInbox: plan.inboxInWindow ? 'dropped agent/inbox traffic in the kept window' : '',
    beforeBytes: originalBuf.length,
    afterBytes: buffer.length,
    beforeEvents: parsed.events.length,
    afterEvents: candidate.events.length,
    droppedEvents: parsed.events.length - candidate.events.length,
    insertedProtectedHead: candidate.insertedHead,
    createdTitle,
    inboxSplicesAfter: inbox.splices,
    beforeFirstSeq: parsed.events[0]?.seq ?? null,
    afterFirstSeq: candidate.events[0]?.seq ?? null,
    beforeLastType: parsed.events.at(-1)?.type ?? null,
    afterLastType: candidate.events.at(-1)?.type ?? null,
    deriveBefore: conversation.before,
    deriveAfter: conversation.after,
    message: `${formatBytes(originalBuf.length)} / ${parsed.events.length} events -> ` +
      `${formatBytes(buffer.length)} / ${candidate.events.length} events`,
  };

  if (dryRun) return summary;
  if (confirm !== CONFIRM_WORD) {
    throw sessionError(ERROR_CODES.CONFIRM_REQUIRED,
      `refusing to write: pass confirm:"${CONFIRM_WORD}" to actually truncate`);
  }

  // The backup is written from the snapshot buffer, not from a second read of
  // the log: a writer that appends in the meantime must not end up inside a
  // backup that claims to represent the bytes this plan was built from.
  let backup;
  try {
    backup = ensureBackup(abs, {
      date: now,
      sourceBuf: originalBuf,
      sha256: snapshot.sha256,
      size: snapshot.size,
    });
  } catch (error) {
    const code = error.code === 'ENOENT' ? ERROR_CODES.BACKUP_MISSING : ERROR_CODES.BACKUP_MISMATCH;
    throw sessionError(code, `backup failed: ${error.message}`, error);
  }
  const verified = verifyBackup(backup.file, backup.sha256);
  if (!verified.ok) {
    const code = String(verified.reason).includes('does not exist')
      ? ERROR_CODES.BACKUP_MISSING : ERROR_CODES.BACKUP_MISMATCH;
    throw sessionError(code, `backup missing or invalid: ${verified.reason}`);
  }

  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, buffer);
    const tmpParsed = parseSession(fs.readFileSync(tmp));
    if (tmpParsed.events.length !== candidate.events.length) {
      throw sessionError(ERROR_CODES.TMP_VERIFY,
        `tmp verification failed: ${tmpParsed.events.length} events != ${candidate.events.length}`);
    }
    const tmpDigest = deriveMessagesDigest(tmpParsed.header, tmpParsed.events).sha256;
    if (tmpDigest !== conversation.before.sha256) {
      throw sessionError(ERROR_CODES.TMP_VERIFY, 'tmp verification failed: visible conversation changed');
    }
    // Last gate before the rename: if anything changed since the snapshot, the
    // append we did not plan for would be destroyed by the rename. Refuse.
    assertUnchanged(abs, snapshot);
    fs.renameSync(tmp, abs);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }

  // After the rename the original only exists in the verified backup.
  try {
    const finalParsed = parseSession(fs.readFileSync(abs));
    if (finalParsed.events.length !== candidate.events.length) {
      throw sessionError(ERROR_CODES.POST_VERIFY,
        `post-write verification failed: ${finalParsed.events.length} events != ${candidate.events.length}`);
    }
    const finalDigest = deriveMessagesDigest(finalParsed.header, finalParsed.events).sha256;
    if (finalDigest !== conversation.before.sha256) {
      throw sessionError(ERROR_CODES.POST_VERIFY, 'post-write verification failed: visible conversation changed');
    }
  } catch (error) {
    fs.copyFileSync(backup.file, abs);
    writeJsonFile(path.join(path.dirname(abs), 'rollback.json'), {
      at: new Date().toISOString(),
      sessionPath: abs,
      reason: error.message,
      code: error.code ?? null,
      restoredFrom: backup.file,
      restoredSha256: backup.sha256,
    });
    throw sessionError(ERROR_CODES.POST_VERIFY, `${error.message}; original restored from ${backup.file}`, error);
  }

  const ledgerFile = truncationLedgerPath(abs);
  const ledger = readJsonFile(ledgerFile, { truncations: [] });
  ledger.truncations.push({
    at: new Date().toISOString(),
    beforeBytes: summary.beforeBytes,
    afterBytes: summary.afterBytes,
    beforeEvents: summary.beforeEvents,
    afterEvents: summary.afterEvents,
    cutSeq: summary.cutSeq,
    cutTurn: summary.cutTurn,
    backup: backup.file,
    backupSha256: backup.sha256,
  });
  if (ledger.truncations.length > 20) ledger.truncations = ledger.truncations.slice(-20);
  writeJsonFile(ledgerFile, ledger);

  return { ...summary, dryRun: false, backupFile: backup.file, backupSha256: backup.sha256 };
}
