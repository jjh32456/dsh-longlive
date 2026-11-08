// Compaction-aware session analysis.
//
// A DSH compaction never deletes anything. It *appends* a `compaction/summary`
// event plus a checkpoint `user/message` whose `surfaceOp` replaces the shadowed
// span. The bytes stay in the log; only the model-visible surface shrinks.
//
// That gives two numbers every longevity tool has to tell apart:
//   shadowed  - how much history the model no longer sees
//   reclaimed - how much shadowed history has actually been deleted from disk
//
// A session can be heavily shadowed and still be 20 MB on disk; it can also be
// small on disk while showing the model its entire history (exactly the state
// that produced the 2026-10-30 payload overflow). Truncation is both safe and
// useful only *after* a compaction has shadowed a prefix, which is why health
// has to report both.

import fs from 'node:fs';
import { parseSession, foldSurface, MESSAGE_TYPES } from './codec.js';

/** Group every compaction-owned event by compactionId. */
function groupCompactions(events) {
  const groups = new Map();
  for (const event of events) {
    const data = event.data ?? {};
    const id = data.compactionId ?? data.source?.compactionId;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (!groups.has(id)) {
      groups.set(id, { id, starts: [], summaries: [], ends: [], checkpoints: [] });
    }
    const group = groups.get(id);
    if (event.type === 'compaction/start') group.starts.push(event);
    else if (event.type === 'compaction/summary') group.summaries.push(event);
    else if (event.type === 'compaction/end') group.ends.push(event);
    else if (data.source?.kind === 'compact-checkpoint') group.checkpoints.push(event);
  }
  return groups;
}

/**
 * A checkpoint's surface span, whichever field names the log used. The codec
 * accepts both `startSeq/endSeq` and `start/end` (codec.js:137, :161), and real
 * logs use the short pair — reading only the long pair made a compressed prefix
 * look like it had never been shadowed (F6).
 */
function spanOf(event) {
  const op = event?.surfaceOp;
  if (!op || typeof op !== 'object') return null;
  const num = (a, b) => (typeof op[a] === 'number' ? op[a] : typeof op[b] === 'number' ? op[b] : null);
  const start = num('startSeq', 'start');
  const end = num('endSeq', 'end');
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

/** Every stored seq inside an inclusive range, in log order. */
function seqsInRange(events, start, end) {
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return [];
  return events
    .filter((event) => typeof event.seq === 'number' && event.seq >= start && event.seq <= end)
    .map((event) => event.seq);
}

/**
 * Count the shadowed seqs that are *still physically in the log on disk*.
 *
 * The point is that "reclaimed" is a claim about the disk, so it has to be read
 * back from the disk. Any failure (missing file, unreadable, unparseable) is
 * reported as unverified — the caller then says `unknown` instead of guessing.
 */
function countStillOnDisk(filePath, seqs) {
  const wanted = new Set(seqs);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { verified: false, error: 'NOT_A_FILE' };
    const parsed = parseSession(fs.readFileSync(filePath));
    let stored = 0;
    const present = new Set();
    for (const event of parsed.events) {
      if (!wanted.has(event.seq)) continue;
      stored += 1;
      present.add(event.seq);
    }
    return { verified: true, stored, present, diskEvents: parsed.events.length };
  } catch (error) {
    return { verified: false, error: error?.code ?? error?.message ?? 'READ_FAILED' };
  }
}

/**
 * Describe what the log remembers about compaction.
 *
 * @param parsed - decoded session ({ header, events }).
 * @param options.filePath - the log's path on disk. When given, the analysis
 *   re-reads it so "reclaimed" is counted, not inferred. Without it the reclaim
 *   state is reported as `unknown`, never as `true`.
 * @returns structurally stable facts, no policy and no thresholds.
 */
export function analyzeCompaction(parsed, options = {}) {
  const events = parsed.events ?? [];
  // Address events by seq, never by array index: a decoded log is contiguous,
  // but an edited or partially filtered one is not.
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const groups = groupCompactions(events);
  const surface = foldSurface(events);
  const surfaceSeqs = new Set(surface.map((node) => node.seq));
  const surfaceMessages = surface.filter((node) => MESSAGE_TYPES.has(node.type));

  const files = [];
  const seen = new Set();
  const fileShadowSeqs = new Map();
  for (const group of groups.values()) {
    const summary = group.summaries[0];
    const checkpoint = group.checkpoints[0];
    const data = summary?.data ?? {};
    // The summary records the shadowed span, but a checkpoint can outlive it
    // (a hand-edited log, or a summary lost to a bad truncation). The
    // checkpoint's own surfaceOp still shadowed that span, so recover the
    // measurement from the range rather than reporting zero.
    const checkpointSpan = spanOf(checkpoint);
    let shadowedSeqs = [];
    let measurementSource = 'none';
    if (Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.length > 0) {
      shadowedSeqs = data.shadowedSeqs;
      measurementSource = 'summary.shadowedSeqs';
    } else if (checkpointSpan) {
      shadowedSeqs = seqsInRange(events, checkpointSpan.start, checkpointSpan.end);
      measurementSource = 'checkpoint.surfaceOp';
    } else if (data.shadowedRange && typeof data.shadowedRange.start === 'number'
      && typeof data.shadowedRange.end === 'number') {
      shadowedSeqs = seqsInRange(events, data.shadowedRange.start, data.shadowedRange.end);
      measurementSource = 'summary.shadowedRange';
    }
    fileShadowSeqs.set(group.id, shadowedSeqs);
    for (const seq of shadowedSeqs) seen.add(seq);
    files.push({
      compactionId: group.id,
      startSeq: group.starts[0]?.seq ?? null,
      summarySeq: summary?.seq ?? null,
      checkpointSeq: checkpoint?.seq ?? null,
      closed: group.ends.length > 0,
      shadowedRange: data.shadowedRange ?? checkpointSpan,
      // How the count was obtained; 'none' means it could not be measured.
      shadowedSeqSource: measurementSource,
      shadowedEvents: shadowedSeqs.length,
      shadowedTokens: data.shadowedTokenCount ?? null,
      summaryChars: typeof data.summary?.[0]?.text === 'string' ? data.summary[0].text.length : 0,
      checkpointOnSurface: checkpoint ? surfaceSeqs.has(checkpoint.seq) : false,
      // A checkpoint with no summary still shadows through its surfaceOp, but
      // its span and token count are no longer recorded anywhere.
      metadataIncomplete: Boolean(checkpoint && !summary),
      // True when the shadowed events are still physically present, i.e. the
      // compaction saved context but not disk. Those are the reclaimable bytes.
      shadowedStillStored: shadowedSeqs.filter((seq) => bySeq.has(seq)).length,
      // Filled in from the disk re-read below; null when disk was not read.
      shadowedStillStoredOnDisk: null,
      checkpointChars: checkpoint
        ? JSON.stringify(checkpoint.data?.content ?? '').length
        : 0,
    });
  }

  const disk = typeof options.filePath === 'string' && options.filePath.length > 0
    ? countStillOnDisk(options.filePath, [...seen])
    : { verified: false, error: 'NO_FILE_PATH' };
  if (disk.verified) {
    for (const file of files) {
      const seqs = fileShadowSeqs.get(file.compactionId) ?? [];
      file.shadowedStillStoredOnDisk = seqs.filter((seq) => disk.present.has(seq)).length;
    }
  }

  const stored = events.length;
  const shadowedStored = [...seen].filter((seq) => bySeq.has(seq)).length;
  return {
    compactionFiles: files.length,
    closedCompactions: files.filter((f) => f.closed).length,
    checkpointsOnSurface: files.filter((f) => f.checkpointOnSurface).length,
    // History the model can no longer reach, in events and stored events.
    shadowedEvents: seen.size,
    shadowedEventsStillStored: shadowedStored,
    // A disk read is required before "reclaimed" may be true: the in-memory
    // event list cannot prove what the file no longer contains.
    diskVerified: disk.verified,
    diskError: disk.verified ? null : (disk.error ?? 'UNKNOWN'),
    shadowedEventsStillStoredOnDisk: disk.verified ? disk.stored : null,
    reclaimed: disk.verified ? disk.stored === 0 : 'unknown',
    shadowedTokens: files.reduce((sum, f) => sum + (f.shadowedTokens ?? 0), 0),
    visibleMessages: surfaceMessages.length,
    visibleFirstSeq: surfaceMessages[0]?.seq ?? null,
    storedEvents: stored,
    files,
  };
}

/**
 * One-line verdict a tool can hand to a model or a person.
 *
 * @param analysis - value from analyzeCompaction.
 * @returns short sentence naming the actionable state.
 */
export function describeCompaction(analysis) {
  if (analysis.compactionFiles === 0) {
    return 'never compacted: the model still sees the whole history, so truncation can only delete visible conversation. Run /compact first.';
  }
  if (analysis.checkpointsOnSurface === 0) {
    return 'compaction records exist but no checkpoint is on the surface: the model sees the whole history. Run /compact again.';
  }
  if (analysis.files.some((file) => file.metadataIncomplete)) {
    return 'compaction records are incomplete: a checkpoint survived without its summary, so the shadowed span can no longer be measured. Run /compact again to rewrite it.';
  }
  const visible = `${analysis.visibleMessages} messages remain visible`;
  // "Already gone from disk" is an assertion about the filesystem, so it needs a
  // real count. No count ⇒ say unknown instead of guessing (F6).
  if (analysis.shadowedEvents === 0) {
    return 'compacted: the shadowed span could not be measured (no shadowedSeqs and no usable checkpoint range), '
      + `so reclaim status is unknown; ${visible}.`;
  }
  if (analysis.reclaimed !== true && analysis.reclaimed !== false) {
    return `compacted: ${analysis.shadowedEvents} history events are shadowed `
      + `(${analysis.shadowedEventsStillStored} still stored), reclaim status unknown — `
      + `the log was not re-read from disk; ${visible}.`;
  }
  if (analysis.reclaimed === true) {
    return 'compacted and reclaimed: shadowed history is already gone from disk '
      + `(counted on disk: 0 of ${analysis.shadowedEvents} shadowed events remain); ${visible}.`;
  }
  const stored = analysis.shadowedEventsStillStoredOnDisk ?? analysis.shadowedEventsStillStored;
  return `compacted: ${analysis.shadowedEvents} history events are shadowed (${stored} still stored and reclaimable), `
    + `${visible}.`;
}
