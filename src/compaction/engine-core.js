// 热截断 / hot truncate — cut-only compaction, no model call.
//
// The host's compaction seam (`ctx.compaction`) is a service whose implementation
// decides *when* to compact and *how* a history span becomes one replacement
// node. This module is the policy-free core of a backend that only ever CUTS:
//
//   * a cut is a prefix of the current surface made of whole, already completed
//     turns older than the retention window (retainTurns / retainTokens);
//   * the original events are copied to a JSONL archive under
//     <memoryRoot>/.longlive/hot-truncate/ before the surface is touched;
//   * the replacement is one coverage-pointer user message (compact-checkpoint
//     provenance) and a normal compaction/start → summary → end lifecycle;
//   * no LLM is called and no event data is rewritten — only a surface replace
//     is appended, exactly like stock compaction.
//
// Everything in this file is host-free and testable with a mock Session/meter.
// `cut-engine.js` binds it to the real `@deepseek-ai/dsh-compaction` classes.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { memoryRootFromConfig } from '../memory/paths.js';
import { appendHotTruncateDiag, hotTruncateDiagOptions } from '../hot-truncate-diag.js';

/** Provider name recorded on every summary event this engine writes. */
export const PROVIDER = 'hot-truncate';
/** Model marker for "no model was called". */
export const MODEL = 'cut-only';
/** Archive schema version written in the JSONL header. */
export const ARCHIVE_SCHEMA = 1;
/** Subdirectory of the memory root that holds hot-truncate archives. */
export const ARCHIVE_SUBDIR = path.join('.longlive', 'hot-truncate');

export const MODES = Object.freeze(['off', 'cut', 'auto']);

export const DEFAULT_OPTIONS = Object.freeze({
  mode: 'cut',
  // Every cut rewrites the context prefix, which invalidates the model's
  // prefix cache: the next turn re-bills the remaining context at full price.
  // A 30k trigger cut once per turn; 300k keeps the cut about every dozen
  // turns, which is the point of this default. Keep 4 completed turns so the
  // model still has the immediately preceding conversation.
  retainTurns: 4,
  retainTokens: 8000,
  minCutTokens: 0,
  autoMinTokens: 350000,
  archiveDir: '',
  memoryRoot: '',
  memRoot: '',
  home: '',
  stock: null,
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`hot-truncate: ${name} must be an integer >= ${minimum}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize the plugin row config. Both `{ hotTruncate: {...} }` and the flat
 * object are accepted so a bundle patch can keep the row text short and an
 * existing profile can move the settings later without a rewrite.
 *
 * Unknown keys are ignored on purpose: this row lives beside the longlive
 * plugin's much larger config, and refusing unknown keys would make a bundle
 * overlay fail the whole plugin.
 */
export function normalizeOptions(raw = {}) {
  const source = isPlainObject(raw?.hotTruncate) ? raw.hotTruncate : (isPlainObject(raw) ? raw : {});
  const mode = source.mode === undefined ? DEFAULT_OPTIONS.mode : String(source.mode).toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`hot-truncate: mode must be one of ${MODES.join('|')}, got ${JSON.stringify(source.mode)}`);
  return Object.freeze({
    mode,
    retainTurns: positiveInteger(source.retainTurns ?? DEFAULT_OPTIONS.retainTurns, 'retainTurns', 0),
    retainTokens: positiveInteger(source.retainTokens ?? DEFAULT_OPTIONS.retainTokens, 'retainTokens', 0),
    minCutTokens: positiveInteger(source.minCutTokens ?? DEFAULT_OPTIONS.minCutTokens, 'minCutTokens', 0),
    autoMinTokens: positiveInteger(source.autoMinTokens ?? DEFAULT_OPTIONS.autoMinTokens, 'autoMinTokens', 0),
    archiveDir: textOrEmpty(source.archiveDir),
    memoryRoot: textOrEmpty(source.memoryRoot),
    memRoot: textOrEmpty(source.memRoot),
    home: textOrEmpty(source.home),
    strictMemoryRoot: source.strictMemoryRoot === true,
    stock: isPlainObject(source.stock) ? Object.freeze({ ...source.stock }) : null,
  });
}

/** Keys the stock `BasicCompactionEngine` accepts; the fallback filters to them. */
const STOCK_KEYS = Object.freeze([
  'thresholdRatio', 'retainRatio', 'retainTokens', 'summarizationProvider',
  'summarizationModel', 'maxTokens', 'compactionRetries', 'maxOverflowRetries',
  'modelPolicies', 'auto',
]);

/** A stock-compatible view of this row's config, for the fallback path. */
export function stockConfig(raw = {}) {
  const source = isPlainObject(raw?.hotTruncate) ? raw.hotTruncate : (isPlainObject(raw) ? raw : {});
  const explicit = isPlainObject(source.stock) ? source.stock : {};
  const out = {};
  for (const key of STOCK_KEYS) {
    if (explicit[key] !== undefined) out[key] = explicit[key];
    else if (source[key] !== undefined && !['mode', 'archiveDir', 'memoryRoot', 'memRoot', 'home', 'stock'].includes(key)) out[key] = source[key];
  }
  // BasicCompactionEngine defaults `auto` to true; keep automatic stock
  // compaction alive when hot truncate is disabled or falls back.
  if (out.auto === undefined) out.auto = true;
  return out;
}

/**
 * Resolve the archive directory. An explicit `archiveDir` (tests, forensic
 * runs) wins; otherwise the memory-root chain used by every longlive feature:
 * memoryRoot → memRoot → $DSH_LONGLIVE_MEMORY_ROOT → $DSH_MEM →
 * <DSH home>/longlive-memory.
 *
 * `memoryRootFromConfig` keeps its contract: an explicitly configured but
 * missing root throws instead of silently growing a second store. The derived
 * default is created on demand.
 */
export function resolveArchiveDir(options, env = process.env) {
  const explicit = textOrEmpty(options?.archiveDir);
  if (explicit) {
    const dir = path.resolve(explicit);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  const config = {
    memoryRoot: options?.memoryRoot ?? '',
    memRoot: options?.memRoot ?? '',
    home: options?.home ?? '',
    strictMemoryRoot: options?.strictMemoryRoot === true,
  };
  const root = memoryRootFromConfig(config, env);
  const dir = path.join(root, ARCHIVE_SUBDIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ---------------------------------------------------------------------------
// Turn facts
// ---------------------------------------------------------------------------

/** A user message that replaced a prior surface range (any compaction backend). */
export function isCheckpointEvent(event, isCompactCheckpointSource) {
  if (!event || event.type !== 'user/message') return false;
  const source = event.data?.source;
  if (!isPlainObject(source)) return false;
  if (typeof isCompactCheckpointSource === 'function') {
    try {
      if (isCompactCheckpointSource(source)) return true;
    } catch {
      // Fall through to the structural checks.
    }
  }
  if (source.kind === 'spine-checkpoint') return true;
  return source.kind === 'plugin' && source.plugin === 'compact';
}

/**
 * Read this session's immutable event snapshot through the host API.
 *
 * Host 0.2.2-rc.1's `Session` is an event-sourced object with a private `log`;
 * its public reads are `snapshotEvents(fromSeq, toSeqExclusive)` and
 * `eventAt(seq)`. There is no `events` property (reading one yields
 * `undefined`), which is why the first cut silently planned against an empty
 * table. Keep the array fallbacks only for old mocks/tests: the production
 * path is always `snapshotEvents()`.
 */
export function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    const events = session.snapshotEvents();
    if (Array.isArray(events)) return events;
  }
  if (Array.isArray(session?.log)) return session.log;
  if (Array.isArray(session?.events)) return session.events;
  return [];
}

/** Build the turn lookup tables in one pass over the immutable event log. */
export function turnTable(session) {
  const events = sessionEvents(session);
  const bySeq = new Map();
  const turnOfSeq = new Map();
  const turns = [];
  const byNumber = new Map();
  let open = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object' || typeof event.seq !== 'number') continue;
    bySeq.set(event.seq, event);
    if (event.type === 'turn/start') {
      open = {
        turn: event.data?.turn,
        startSeq: event.seq,
        endSeq: null,
        completed: false,
        reason: null,
      };
      turns.push(open);
      byNumber.set(open.turn, open);
    }
    if (open !== null) turnOfSeq.set(event.seq, open.turn);
    if (event.type === 'turn/end') {
      const target = byNumber.get(event.data?.turn) ?? open;
      if (target !== null && target !== undefined && target.endSeq === null) {
        target.endSeq = event.seq;
        target.reason = event.data?.reason?.kind ?? null;
        target.completed = target.reason === 'completed';
      }
      open = null;
    }
  }
  return { events, bySeq, turnOfSeq, turns, byNumber, totalTurns: turns.length };
}

/** The currently open turn number, or null when the log ends between turns. */
export function findOpenTurn(events) {
  let open = null;
  for (const event of events ?? []) {
    if (event?.type === 'turn/start') open = event.data?.turn ?? null;
    else if (event?.type === 'turn/end' && open === event.data?.turn) open = null;
  }
  return open;
}

/**
 * Reject an append while an unmatched compaction/start exists, except when a
 * later constructor-seed boundary proves that start belongs to an earlier
 * lifecycle (the stock seam's rule).
 */
export function activeCompactionStart(events) {
  let start = null;
  let end = null;
  let seed = null;
  for (const event of events ?? []) {
    if (event?.type === 'session/end-seed') seed = event.seq;
    else if (event?.type === 'compaction/start') start = event;
    else if (event?.type === 'compaction/end') end = event;
  }
  if (start === null) return null;
  if (end !== null && end.seq > start.seq) return null;
  if (seed !== null && seed > start.seq) return null;
  return start;
}

// ---------------------------------------------------------------------------
// Surface grouping and selection
// ---------------------------------------------------------------------------

function eventTokens(event, tokens) {
  const priced = tokens?.get(event?.seq);
  if (Number.isFinite(priced)) return priced;
  // Only used when the host token meter is unavailable. A conservative byte
  // estimate keeps the retention window from silently shrinking.
  try {
    const raw = event?.data?.message ?? event?.data ?? null;
    return Math.max(1, Math.ceil(String(JSON.stringify(raw) ?? '').length / 3));
  } catch {
    return 1;
  }
}

/**
 * Group the current surface into positional runs: completed/aborted turn
 * groups in surface order, with checkpoint replacements kept as their own
 * `checkpoint` groups so they never masquerade as a turn.
 */
export function surfaceGroups(session, table, isCheckpointSource) {
  const nodes = session?.surface?.nodes ?? [];
  const groups = [];
  let current = null;
  for (const seq of nodes) {
    const event = table.bySeq.get(seq);
    if (event === undefined) throw new Error(`hot-truncate: surface seq ${seq} has no session event`);
    if (isCheckpointEvent(event, isCheckpointSource)) {
      if (current !== null && current.kind === 'checkpoint') {
        current.seqs.push(seq);
      } else {
        current = { kind: 'checkpoint', turn: null, seqs: [seq], completed: false, known: true };
        groups.push(current);
      }
      continue;
    }
    const turn = table.turnOfSeq.get(seq);
    const info = turn === undefined ? undefined : table.byNumber.get(turn);
    const turnNumber = info === undefined ? 0 : turn;
    if (current === null || current.kind !== 'turn' || current.turn !== turnNumber) {
      current = {
        kind: 'turn',
        turn: turnNumber,
        seqs: [],
        completed: info?.completed === true,
        known: info !== undefined,
      };
      groups.push(current);
    }
    current.seqs.push(seq);
  }
  return groups;
}

function groupTokens(group, prices) {
  let total = 0;
  for (const seq of group.seqs) total += prices.get(seq);
  return total;
}

/**
 * Turns already archived by an earlier hot-truncate cut.
 *
 * The count is carried on the pointer's source (`hotTruncate.archivedTurns`)
 * instead of being re-derived from summary.shadowedSeqs: a summary span also
 * contains the old pointer node, whose seq maps to the turn that was OPEN when
 * that pointer was written — counting it would inflate M on every later cut.
 *
 * Scan the whole log, not only the live surface: a later stock compaction (or
 * a manual rollback to stock) can shadow our pointer, and the carried count
 * must survive that.
 */
export function archivedTurnsBefore(table) {
  let best = 0;
  for (const event of table.events) {
    if (event?.type !== 'user/message') continue;
    const carried = event.data?.source?.hotTruncate?.archivedTurns;
    if (Number.isInteger(carried) && carried > best) best = carried;
  }
  return best;
}

/** Text-only token estimate used before the real message exists. */
function roughPointerTokens(text) {
  // CJK text is roughly one token per character; English paths are cheaper.
  // Overestimating a little is the safe direction (it can only skip a tiny cut).
  return Math.ceil(text.length / 1.8) + 24;
}

/**
 * Select the oldest whole closed turns that sit outside the retention window.
 * Returns null when no safe cut exists; every such refusal reports a structured
 * reason through `helpers.onNoPlan` so a silently disabled hot truncate is
 * observable (the engine logs it once per reason).
 *
 * The leading run of `system/message` / `developer/message` nodes (the real
 * system prompt at host-protected position 0) is never moved. A `system/message`
 * re-injected by a host restart further inside the surface is an archived copy
 * of that same prompt (host-tolerated inside a replacement range). Checkpoint
 * nodes at the head of the span are folded into the same cut, which keeps
 * exactly one pointer.
 */
export function selectCutPlan(session, options, measurement, helpers = {}) {
  const table = helpers.table ?? turnTable(session);
  const groups = surfaceGroups(session, table, helpers.isCheckpointSource);
  const onNoPlan = typeof helpers.onNoPlan === 'function' ? helpers.onNoPlan : null;
  const noPlan = (reason, detail) => {
    try {
      onNoPlan?.({ reason, detail: detail === undefined ? null : detail });
    } catch {
      // Diagnostics never break a plan.
    }
    return null;
  };
  if (groups.length === 0) return noPlan('no-groups');
  const tokens = new Map();
  for (const node of measurement?.nodes ?? []) {
    if (node && typeof node.seq === 'number' && Number.isFinite(node.tokens)) tokens.set(node.seq, node.tokens);
  }
  const prices = {
    get(seq) {
      const price = tokens.get(seq);
      if (Number.isFinite(price)) return price;
      return eventTokens(table.bySeq.get(seq), tokens);
    },
  };

  // Walk backwards until the retained suffix satisfies BOTH limits. A turn
  // that is not completed counts toward the token budget but never toward the
  // completed-turn floor, so the retained suffix may temporarily hold a few
  // extra turns while a closed aborted turn sits inside the window.
  let keptTurns = 0;
  let keptTokens = 0;
  let boundary = -1;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    keptTokens += groupTokens(group, prices);
    if (group.kind === 'turn' && group.completed) keptTurns += 1;
    if (group.kind === 'turn' && group.completed
      && keptTurns >= options.retainTurns && keptTokens >= options.retainTokens) {
      boundary = index;
      break;
    }
  }
  if (boundary <= 0) return noPlan('not-enough-turns', { groups: groups.length });

  const surfaceNodes = session?.surface?.nodes ?? [];
  if (surfaceNodes.length === 0) return noPlan('no-surface');

  // 2026-11-06 1.6.7 hardening — no permanent barrier, no silent zero progress.
  //
  // 1.6.6 removed the aborted-turn freeze but treated every group without a
  // usable turn record as an immovable open group and stopped the span before
  // it. Three surface shapes then made the planner return null forever even
  // though whole closed turns older than the retention window existed:
  //   * a log truncated mid-turn leaves orphan messages at the surface head
  //     (no turn/start) — a turn===0 group at the head (red team E1);
  //   * the host appends a user/message between turns — a turn===0 group in
  //     the middle (red team E3);
  //   * a turn whose turn/end was lost by log truncation — turn N has no
  //     endSeq but later turns exist (red team E2).
  //
  // Rules now:
  //   * the whole LEADING run of system/message + developer/message nodes is
  //     never moved (head instructions; host-protected position 0);
  //   * a turn===0 group that carries a system/developer node is a head
  //     instruction zone and stays in place; a turn===0 group of plain messages
  //     is an orphan prefix and is archived with the cut (recoverable);
  //   * a group whose turn has no turn/end is the CURRENT turn only when it is
  //     the last started turn; an earlier turn without turn/end is abandoned
  //     (the log was truncated inside it) and is cuttable, archived through an
  //     inferred range up to the next turn/start;
  //   * the planner skips a blocked head barrier and cuts the next run of
  //     wholly-cuttable groups; if nothing is cuttable it reports the reason
  //     through onNoPlan instead of returning null silently.
  const groupStart = new Array(groups.length);
  const groupEnd = new Array(groups.length);
  const groupOfPosition = new Array(surfaceNodes.length);
  {
    let cursor = 0;
    for (let index = 0; index < groups.length; index += 1) {
      groupStart[index] = cursor;
      for (let offset = 0; offset < groups[index].seqs.length; offset += 1) groupOfPosition[cursor++] = index;
      groupEnd[index] = cursor - 1;
    }
  }
  const typeOfSeq = (seq) => table.bySeq.get(seq)?.type;
  const isInstructionSeq = (seq) => typeOfSeq(seq) === 'system/message' || typeOfSeq(seq) === 'developer/message';
  const protectedSeqs = new Set();
  {
    let position = 0;
    while (position < surfaceNodes.length && isInstructionSeq(surfaceNodes[position])) {
      protectedSeqs.add(surfaceNodes[position]);
      position += 1;
    }
  }
  const lastStarted = table.turns.length > 0 ? table.turns[table.turns.length - 1] : null;
  const turnInfoOf = (group) => (group.kind === 'turn' && group.turn !== 0 ? table.byNumber.get(group.turn) : undefined);
  const isCurrentTurnGroup = (group) => {
    if (group.kind !== 'turn' || group.turn === 0) return false;
    const info = table.byNumber.get(group.turn);
    if (info === undefined) return true;
    return info.endSeq === null && lastStarted !== null && info.turn === lastStarted.turn;
  };
  const isCuttableGroup = (group) => {
    if (group === undefined) return false;
    if (group.kind === 'checkpoint') return true;
    if (group.kind !== 'turn') return false;
    // A turn===0 group is either an orphan head zone (contains instructions) or
    // a stray message block between turns; only the latter may be archived.
    if (group.turn === 0) return !group.seqs.some((seq) => isInstructionSeq(seq));
    const info = table.byNumber.get(group.turn);
    if (info === undefined) return false;
    return !isCurrentTurnGroup(group);
  };
  // An abandoned turn (no turn/end, but a later turn/start exists) never got a
  // closing event; the archive range is inferred up to the next turn/start so
  // every one of its original events stays recoverable.
  const resolvedEndSeq = (group) => {
    const info = table.byNumber.get(group.turn);
    const lastSurfaceSeq = group.seqs[group.seqs.length - 1];
    if (info === undefined || !Number.isInteger(info.startSeq)) return lastSurfaceSeq;
    if (Number.isInteger(info.endSeq)) return info.endSeq;
    const next = table.turns.find((entry) => Number.isInteger(entry.startSeq) && entry.startSeq > info.startSeq);
    if (next === undefined) return lastSurfaceSeq;
    return Math.max(info.startSeq, next.startSeq - 1);
  };

  // The span starts after the protected head run and on a user/assistant node
  // (the pointer replaces one); a system copy skipped at the head of a turn
  // stays outside the span exactly like 1.6.6 — it is never moved out.
  let startIndex = 0;
  while (startIndex < surfaceNodes.length && protectedSeqs.has(surfaceNodes[startIndex])) startIndex += 1;
  while (startIndex < surfaceNodes.length) {
    const type = typeOfSeq(surfaceNodes[startIndex]);
    if (type === 'user/message' || type === 'assistant/message') break;
    startIndex += 1;
  }
  if (startIndex >= surfaceNodes.length) return noPlan('no-span-start');
  const firstGroup = groupOfPosition[startIndex];

  // Earliest run of consecutive cuttable groups that lies entirely before the
  // retention boundary and holds at least one real closed turn. Runs made only
  // of orphan messages/pointers are not worth a surface rewrite: skip them.
  let chosenStart = -1;
  let chosenEnd = -1;
  for (let index = firstGroup; index < boundary; index += 1) {
    if (!isCuttableGroup(groups[index])) continue;
    let runEnd = index;
    while (runEnd + 1 < boundary && isCuttableGroup(groups[runEnd + 1])) runEnd += 1;
    let realTurns = 0;
    for (let cursor = index; cursor <= runEnd; cursor += 1) {
      if (groups[cursor].kind === 'turn' && groups[cursor].turn !== 0) realTurns += 1;
    }
    if (realTurns > 0) { chosenStart = index; chosenEnd = runEnd; break; }
    index = runEnd;
  }
  if (chosenStart < 0) {
    return noPlan('blocked-prefix', {
      firstGroup,
      boundary,
      blocked: groups.slice(firstGroup, boundary).map((group) => `${group.kind}:${group.turn}:${group.completed}`),
    });
  }
  let spanStart = Math.max(startIndex, groupStart[chosenStart]);
  const endIndex = groupEnd[chosenEnd];
  if (endIndex < spanStart) return noPlan('empty-span', { chosenStart, chosenEnd });

  // A system/message node *inside* the span is a host-restart re-injection of
  // the same prompt; the host tolerates it inside a replacement range and it is
  // archived together with the old prefix (approved 1.6.6 behaviour).
  const shadowedSeqs = surfaceNodes.slice(spanStart, endIndex + 1);
  const shadowedSet = new Set(shadowedSeqs);
  const touchedGroups = groups.filter((group) => group.seqs.some((seq) => shadowedSet.has(seq)));
  if (touchedGroups.some((group) => isCurrentTurnGroup(group))) return noPlan('current-turn-touched');
  // No half turn: every touched turn group must be fully shadowed. The only
  // allowed exception is a system/developer copy skipped at the head of the
  // first group (it stays on the surface, never half-cut).
  for (const group of touchedGroups) {
    if (group.kind !== 'turn') continue;
    const missing = group.seqs.filter((seq) => !shadowedSet.has(seq));
    if (missing.some((seq) => !isInstructionSeq(seq))) return noPlan('split-group', { turn: group.turn });
  }
  const cutTurnGroups = touchedGroups.filter((group) => {
    if (group.kind !== 'turn' || group.turn === 0) return false;
    return !isCurrentTurnGroup(group);
  });
  if (cutTurnGroups.length === 0) return noPlan('no-turns', { chosenStart, chosenEnd });

  // Archive every original event of the cut turns, plus any checkpoint node and
  // orphan (turn===0) message that positionally lived inside the replaced span.
  const archivedSeqs = new Set();
  const archiveEvents = [];
  for (const group of cutTurnGroups) {
    const info = table.byNumber.get(group.turn);
    if (info === undefined || !Number.isInteger(info.startSeq)) continue;
    const endSeq = resolvedEndSeq(group);
    for (let seq = info.startSeq; seq <= endSeq; seq += 1) {
      const event = table.bySeq.get(seq);
      if (event === undefined || archivedSeqs.has(seq)) continue;
      archivedSeqs.add(seq);
      archiveEvents.push(event);
    }
  }
  for (const seq of shadowedSeqs) {
    if (archivedSeqs.has(seq)) continue;
    const event = table.bySeq.get(seq);
    if (event === undefined) continue;
    archivedSeqs.add(seq);
    archiveEvents.push(event);
  }
  archiveEvents.sort((left, right) => left.seq - right.seq);

  const cutTurns = cutTurnGroups.map((group) => {
    const info = table.byNumber.get(group.turn);
    const seqs = group.seqs.filter((seq) => shadowedSet.has(seq));
    return {
      turn: group.turn,
      firstSeq: seqs[0],
      lastSeq: seqs[seqs.length - 1],
      startSeq: info?.startSeq ?? seqs[0],
      endSeq: resolvedEndSeq(group),
      surfaceEvents: seqs.length,
      tokens: seqs.reduce((total, seq) => total + prices.get(seq), 0),
    };
  });
  const shadowedTokenCount = shadowedSeqs.reduce((total, seq) => total + prices.get(seq), 0);
  if (shadowedTokenCount <= 0) return noPlan('zero-token');

  const lastTouchedIndex = groups.indexOf(touchedGroups[touchedGroups.length - 1]);
  const retainedGroups = groups.slice(lastTouchedIndex + 1);
  const retainedTurns = retainedGroups.filter((group) => group.kind === 'turn' && group.completed).length;
  const retainedTokens = retainedGroups.reduce((total, group) => total + groupTokens(group, prices), 0);
  const archivedBefore = archivedTurnsBefore(table);
  const totalTurns = table.totalTurns;
  const archivedTurns = archivedBefore + cutTurns.length;

  const placeholderPath = '<archive>';
  const previewText = buildPointerText({
    totalTurns,
    archivedTurns,
    firstTurn: cutTurns[0].turn,
    lastTurn: cutTurns[cutTurns.length - 1].turn,
    cutTurnCount: cutTurns.length,
    shadowedTokenCount,
    surfaceEventCount: shadowedSeqs.length,
    eventCount: archiveEvents.length,
    archivePath: placeholderPath,
    sha256: '',
    retainTurns: options.retainTurns,
    retainTokens: options.retainTokens,
    retainedTurns,
  });
  const pointerTokens = roughPointerTokens(previewText);
  if (shadowedTokenCount < pointerTokens + options.minCutTokens) {
    return noPlan('pointer-too-large', { shadowedTokenCount, pointerTokens });
  }

  return {
    start: shadowedSeqs[0],
    end: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    shadowedTokenCount,
    cutTurns,
    archiveEvents,
    archivedSeqs,
    totalTurns,
    archivedBefore,
    archivedTurns,
    retainedTurns,
    retainedTokens,
    pointerTokens,
    cutSurfaceGroups: touchedGroups.length,
  };
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

function utcStamp(now) {
  const date = new Date(now);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    + `${pad(date.getUTCMilliseconds(), 3)}Z`;
}

function messageOf(event) {
  if (event?.type === 'user/message') return event.data;
  if (event?.type === 'assistant/message') return event.data?.message;
  if (event?.type === 'tool/result') return event.data?.message;
  return undefined;
}

/**
 * Append-only JSONL archive. Writes header + one line per original event +
 * footer, computes sha256 over the body bytes, fsyncs the file, then renames
 * the temp file into place. A collision gets a numeric suffix; no existing
 * archive is ever opened for writing, overwritten or removed.
 */
export function writeArchive({
  dir,
  table,
  plan,
  compactionId,
  sessionId = '',
  now = Date.now(),
  fsImpl = fs,
}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('hot-truncate: archive directory is missing');
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `${utcStamp(now)}-${String(compactionId).slice(0, 8)}`;
  let file = path.join(dir, `${base}.jsonl`);
  for (let suffix = 1; fsImpl.existsSync(file); suffix += 1) {
    file = path.join(dir, `${base}-${suffix}.jsonl`);
  }

  const lines = plan.archiveEvents.map((event) => {
    const record = {
      seq: event.seq,
      turn: table.turnOfSeq.get(event.seq) ?? null,
      type: event.type,
      time: event.time ?? null,
      data: event.data ?? null,
    };
    const message = messageOf(event);
    if (message !== undefined) record.message = message;
    return JSON.stringify(record);
  });
  const body = lines.map((line) => `${line}\n`).join('');
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const header = {
    kind: 'hot-truncate/header',
    schema: ARCHIVE_SCHEMA,
    at: new Date(now).toISOString(),
    sessionId: String(sessionId ?? ''),
    compactionId: String(compactionId),
    provider: PROVIDER,
    model: MODEL,
    cutTurns: plan.cutTurns,
    shadowedSeqs: plan.shadowedSeqs,
    eventCount: lines.length,
    bodySha256: sha256,
  };
  const footer = { kind: 'hot-truncate/footer', eventCount: lines.length, bodySha256: sha256 };
  const text = `${JSON.stringify(header)}\n${body}${JSON.stringify(footer)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const handle = fsImpl.openSync(tmp, 'wx', 0o600);
    try {
      fsImpl.writeFileSync(handle, text, 'utf8');
      fsImpl.fsyncSync(handle);
    } finally {
      fsImpl.closeSync(handle);
    }
    fsImpl.renameSync(tmp, file);
  } catch (error) {
    try {
      fsImpl.unlinkSync(tmp);
    } catch {
      // The temp file is cleanup, not an archive; leaving it is harmless.
    }
    throw error;
  }
  // Best effort: make the rename durable. Windows often refuses directory
  // handles; failure here does not invalidate the already-fsynced file.
  try {
    const dirHandle = fsImpl.openSync(dir, 'r');
    try {
      fsImpl.fsyncSync(dirHandle);
    } finally {
      fsImpl.closeSync(dirHandle);
    }
  } catch {
    // Not fatal; the file content was fsynced before the rename.
  }
  return { path: file, eventCount: lines.length, sha256, header, body };
}

// ---------------------------------------------------------------------------
// Pointer message
// ---------------------------------------------------------------------------

/**
 * The one user-visible replacement. The first line is the contract sentence
 * required by the defect item: total turns, archived turns, and where the
 * originals live. `session_original(turn=…)` keeps working because compaction
 * never deletes the log — only the surface is rewritten.
 */
export function buildPointerText(facts) {
  const {
    totalTurns, archivedTurns, firstTurn, lastTurn, cutTurnCount,
    shadowedTokenCount, surfaceEventCount, eventCount, archivePath, sha256,
    retainTurns, retainTokens, retainedTurns,
  } = facts;
  const range = firstTurn === lastTurn ? `第 ${firstTurn} 轮` : `第 ${firstTurn}–${lastTurn} 轮`;
  const lines = [
    `本会话共 ${totalTurns} 轮，其中 ${archivedTurns} 轮已压缩归档；需要原文用 session_original(turn=…) 或读归档路径：${archivePath}`,
    `本次热截断切掉${range}（${cutTurnCount} 轮 / ${shadowedTokenCount} tokens / ${surfaceEventCount} 个表面事件）；只切已结束且早于保留窗口的轮（含被中止/中断的旧轮），当前未完成的轮不切，切点之后的原文未动。`,
    `归档：${eventCount} 条原始事件（JSONL，每行含 seq/turn/原始消息）` + (sha256 ? `，sha256=${sha256.slice(0, 16)}…` : '') + '。',
    `保留窗口：最近 ${retainTurns} 个已完成轮、至少 ${retainTokens} tokens（本次保留 ${retainedTurns} 轮）。`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

function fallbackCreateUserMessage(input) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: input.content,
    source: input.source,
  });
}

function fallbackCheckpointSource(compactionId) {
  return Object.freeze({ kind: 'plugin', plugin: 'compact', compactionId });
}

function sessionKey(agent) {
  const id = agent?.session?.id;
  return typeof id === 'string' && id.length > 0 ? id : '__default__';
}

/**
 * Build the engine class around injected host primitives. In production
 * `cut-engine.js` passes the real imports; tests pass small mocks.
 *
 * Required: CompactionEngine (the abstract service base). Everything else has
 * a conservative fallback so a host minor-version difference degrades into a
 * working cut instead of a crash.
 */
export function createCutEngine(deps) {
  const {
    CompactionEngine,
    CompactionId = (id) => id,
    ManualCompactionError = null,
    compactCheckpointSource = fallbackCheckpointSource,
    createUserMessage = fallbackCreateUserMessage,
    toolPairingBalancedBefore = null,
    toolPairingBalancedAfter = null,
    isCompactCheckpointSource = null,
    contextOverflowCode = 'CONTEXT_WINDOW_EXCEEDED',
    archiveWriter = writeArchive,
    env = process.env,
  } = deps ?? {};
  if (typeof CompactionEngine !== 'function') throw new Error('hot-truncate: CompactionEngine is required');

  function manualError(code, message, cause) {
    if (typeof ManualCompactionError === 'function') {
      return new ManualCompactionError(code, message, cause === undefined ? undefined : { cause });
    }
    const error = new Error(message);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function isManualError(error) {
    return typeof ManualCompactionError === 'function' && error instanceof ManualCompactionError;
  }

  function estimateMessage(meter, message) {
    try {
      const value = meter?.estimateMessage?.(message);
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      // fall through
    }
    try {
      return roughPointerTokens(JSON.stringify(message));
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  return class HotTruncateEngine extends CompactionEngine {
    static inject = ['tokenMeter', 'sessions'];

    constructor(ctx, config) {
      super(ctx);
      this.options = normalizeOptions(config);
      this.active = new Set();
      this.warned = new Set();
      this.registerTriggers();
    }

    log(level, message) {
      const logger = this.ctx?.logger;
      try {
        if (typeof logger?.[level] === 'function') logger[level](message);
        else if (level === 'warn') console.error(message);
      } catch {
        // Logging never breaks a cut.
      }
    }

    warnOnce(key, message) {
      if (this.warned.has(key)) return;
      this.warned.add(key);
      this.log('warn', message);
    }

    registerTriggers() {
      const ctx = this.ctx;
      if (typeof ctx?.on !== 'function') return;
      // Pressure is the host's normal per-step gate. Our policy is simpler:
      // once a completed turn falls outside the retention window, cut it.
      try {
        ctx.on('agent/pre-step', async ({ agent, signal } = {}, next) => {
          try {
            if (!signal?.aborted) await this.compactIfNeeded(agent, 'pressure', signal);
          } catch (error) {
            this.log('warn', `hot-truncate: pre-step cut skipped: ${error?.message ?? error}`);
          }
          return typeof next === 'function' ? next() : undefined;
        });
      } catch (error) {
        this.warnOnce('trigger-pre-step', `hot-truncate: 无法注册 agent/pre-step：${error?.message ?? error}`);
      }
      // Stock registers this recovery path; cut-only must too, otherwise a
      // provider-confirmed overflow never reaches our gate.
      try {
        ctx.on('agent/request-error', async ({ agent, failure, signal } = {}, next) => {
          try {
            if (failure?.code !== contextOverflowCode || signal?.aborted) return typeof next === 'function' ? next() : undefined;
            const generation = agent?.session?.surface?.replaceGeneration ?? 0;
            await this.compactIfNeeded(agent, 'context-overflow', signal);
            if (signal?.aborted) return typeof next === 'function' ? next() : undefined;
            const after = agent?.session?.surface?.replaceGeneration ?? 0;
            if (after <= generation) return typeof next === 'function' ? next() : undefined;
            return { kind: 'retry' };
          } catch (error) {
            this.log('warn', `hot-truncate: overflow recovery skipped: ${error?.message ?? error}`);
            return typeof next === 'function' ? next() : undefined;
          }
        });
      } catch (error) {
        this.warnOnce('trigger-request-error', `hot-truncate: 无法注册 agent/request-error：${error?.message ?? error}`);
      }
      if (this.options.mode !== 'auto') return;
      try {
        ctx.on('agent/status', ({ agent, status } = {}) => {
          if (status !== 'idle' || !agent?.session) return;
          if (this.active.has(sessionKey(agent))) return;
          void this.autoCut(agent);
        });
      } catch (error) {
        this.warnOnce('trigger-status', `hot-truncate: 无法注册 agent/status：${error?.message ?? error}`);
      }
    }

    /** Price the current surface with the host meter, or a safe local estimate. */
    measure(session) {
      try {
        const measured = this.ctx?.tokenMeter?.measure?.(session);
        if (measured && Array.isArray(measured.nodes)) {
          const totalTokens = Number.isFinite(measured.totalTokens)
            ? measured.totalTokens
            : measured.nodes.reduce((sum, node) => sum + (Number(node?.tokens) || 0), 0);
          return { totalTokens, nodes: measured.nodes };
        }
      } catch {
        // The local estimate below is only a fallback.
      }
      const table = turnTable(session);
      const nodes = (session?.surface?.nodes ?? []).map((seq) => {
        const event = table.bySeq.get(seq);
        return { seq, tokens: eventTokens(event, null) };
      });
      return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0), nodes };
    }

    planFor(session, measurement = this.measure(session)) {
      const table = turnTable(session);
      return selectCutPlan(session, this.options, measurement, {
        table,
        isCheckpointSource: isCompactCheckpointSource,
        // "cut, or say why not": a refusal that would otherwise be silent is
        // logged once per reason (warnOnce) so a permanently disabled hot
        // truncate is always observable in the host log.
        onNoPlan: (info) => {
          const reason = String(info?.reason ?? 'unknown');
          const detail = info?.detail === undefined || info?.detail === null ? '' : ` ${JSON.stringify(info.detail)}`;
          this.warnOnce(`no-plan:${reason}`, `hot-truncate: 未切（${reason}）${detail}`);
        },
      });
    }

    /**
     * Automatic cut gate. Never throws: the host's turn must not be blocked
     * because a cut failed. Returns null when nothing safe can be cut.
     */
    async compactIfNeeded(agent, trigger, signal) {
      try {
        if (this.options.mode === 'off') return null;
        if (signal?.aborted) return null;
        const session = agent?.session;
        if (!session) return null;
        if (this.active.has(sessionKey(agent))) return null;
        // Automatic compaction events must be enclosed in the open turn; a
        // between-turn caller should use compactNow (manual) instead.
        if (findOpenTurn(sessionEvents(session)) === null) return null;
        const measurement = this.measure(session);
        // The per-step pressure path is automatic, so it must obey the same
        // trigger threshold as the idle path. Without this gate a long session
        // is cut once per completed turn no matter how large autoMinTokens is,
        // which is exactly the cache-invalidating behaviour 1.6.4 removes. An
        // explicit context-overflow recovery still cuts below the threshold:
        // surviving the failed request is more important than the cache.
        if (trigger !== 'context-overflow' && measurement.totalTokens < this.options.autoMinTokens) return null;
        const plan = this.planFor(session, measurement);
        if (plan === null) return null;
        if (activeCompactionStart(sessionEvents(session)) !== null) {
          this.warnOnce('busy-auto', 'hot-truncate: 已有未闭合的 compaction，自动热截断跳过这一轮');
          return null;
        }
        return await this.commit(agent, plan, { signal });
      } catch (error) {
        this.log('warn', `hot-truncate: 自动热截断失败，保留宿主原状态：${error?.message ?? error}`);
        return null;
      }
    }

    /**
     * Manual cut. The idle task is reserved synchronously through
     * `agent.runMaintenance` before any asynchronous work, matching the stock
     * backend's manual contract.
     */
    compactNow(agent, signal, sourceCommandId) {
      signal?.throwIfAborted?.();
      try {
        return agent.runMaintenance(async (agentSignal) => {
          const operationSignal = AbortSignal.any([agentSignal, signal]);
          try {
            operationSignal.throwIfAborted();
            const session = agent?.session;
            if (!session) return null;
            const plan = this.planFor(session);
            if (plan === null) return null;
            if (activeCompactionStart(sessionEvents(session)) !== null) {
              throw manualError('busy', 'hot-truncate: 已有未闭合的 compaction');
            }
            return await this.commit(agent, plan, {
              signal: operationSignal,
              sourceCommandId,
            });
          } catch (error) {
            if (agentSignal?.aborted && operationSignal.reason === agentSignal.reason) {
              throw manualError('cancelled', 'hot-truncate: 手动热截断被取消', error);
            }
            operationSignal.throwIfAborted();
            if (isManualError(error)) throw error;
            throw manualError('summary', 'hot-truncate: 手动热截断没有提交', error);
          }
        });
      } catch (error) {
        if (isManualError(error)) throw error;
        throw manualError('busy', 'hot-truncate: 手动热截断需要空闲的 agent', error);
      }
    }

    /**
     * Force one positional range. The cut-only policy still applies: the range
     * must be the plan this engine would have selected, so a direct caller can
     * never split a turn or cut inside the retention window.
     */
    async compactRegion(start, end, agent, signal) {
      signal?.throwIfAborted?.();
      const session = agent?.session;
      if (!session) throw new Error('hot-truncate: compactRegion requires agent.session');
      const plan = this.planFor(session);
      if (plan === null) throw new Error('hot-truncate: no safe completed-turn span to cut');
      if (plan.start !== start || plan.end !== end) {
        throw new Error('hot-truncate: compactRegion only cuts the selected oldest completed turns');
      }
      if (activeCompactionStart(sessionEvents(session)) !== null) throw manualError('busy', 'hot-truncate: 已有未闭合的 compaction');
      return this.commit(agent, plan, { signal });
    }

    /** Cut one plan. Archive first, then append start → summary → pointer → end. */
    async commit(agent, plan, { signal, sourceCommandId } = {}) {
      signal?.throwIfAborted?.();
      const session = agent.session;
      const key = sessionKey(agent);
      if (this.active.has(key)) return null;
      this.active.add(key);
      const compactionId = CompactionId(randomUUID());
      const openTurn = findOpenTurn(sessionEvents(session));
      const lifecycle = {
        compactionId,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        turn: openTurn,
      };
      let started = false;
      let closed = false;
      let archive = null;
      // 1.8.1-rc.7 audit P1-6: one durable diag row per hot-truncate archive.
      // The old path wrote only the pointer/log line; an archive without a
      // matching diag row was indistinguishable from an archive that never
      // happened when a later surface append failed.
      const diagStartedAt = Date.now();
      let diagRoot = this.options.memoryRoot || this.options.memRoot || '';
      let diagDone = false;
      let archiveWritten = false;
      const emitHotTruncateDiag = (result, extra = {}) => {
        if (!diagRoot || diagDone) return;
        diagDone = true;
        try {
          const written = appendHotTruncateDiag(diagRoot, {
            sessionId: String(session.id ?? ''),
            turn: Number.isInteger(openTurn) ? openTurn : null,
            plannedCut: {
              startSeq: plan.start,
              endSeq: plan.end,
              cutTurns: plan.cutTurns.map((entry) => entry.turn),
              firstTurn: plan.cutTurns[0]?.turn ?? null,
              lastTurn: plan.cutTurns[plan.cutTurns.length - 1]?.turn ?? null,
            },
            retainTurns: this.options.retainTurns,
            retainTokens: this.options.retainTokens,
            tokensBefore: plan.shadowedTokenCount + plan.retainedTokens,
            tokensCut: plan.shadowedTokenCount,
            tokensAfter: plan.retainedTokens,
            archivePath: archive?.path ?? null,
            archiveWritten,
            archiveBytes: archive?.path ? (() => { try { return fs.statSync(archive.path).size } catch { return null } })() : null,
            archiveEvents: archive?.eventCount ?? null,
            cutTurnCount: plan.cutTurns.length,
            result,
            ...extra,
            durationMs: Math.max(0, Date.now() - diagStartedAt),
          }, hotTruncateDiagOptions({}));
          if (!written.ok) this.log('warn', `hot-truncate diag write failed: ${written.error ?? 'unknown'}`);
        } catch (error) {
          this.log('warn', `hot-truncate diag threw: ${error?.message ?? error}`);
        }
      };
      try {
        // A whole completed turn is balanced by construction, but the host's
        // own predicate is the authority — a corrupt surface must stop the cut
        // before anything is written.
        if (typeof toolPairingBalancedBefore === 'function' || typeof toolPairingBalancedAfter === 'function') {
          const before = typeof toolPairingBalancedBefore === 'function' ? toolPairingBalancedBefore(session, plan.start) : true;
          const after = typeof toolPairingBalancedAfter === 'function' ? toolPairingBalancedAfter(session, plan.end) : true;
          if (before !== true || after !== true) throw new Error('hot-truncate: selected cut is not tool-pairing balanced');
        }
        const dir = resolveArchiveDir(this.options, env);
        if (!diagRoot) {
          // The shipped compaction row (cordis.patch.yml) does not repeat
          // memoryRoot; resolveArchiveDir has already chosen the real store.
          // Recover it from the standard <root>/.longlive/hot-truncate layout.
          const parent = path.dirname(dir);
          if (path.basename(dir) === 'hot-truncate' && path.basename(parent) === '.longlive') {
            diagRoot = path.dirname(parent);
          }
        }
        archive = archiveWriter({
          dir,
          table: turnTable(session),
          plan,
          compactionId,
          sessionId: String(session.id ?? ''),
          now: Date.now(),
        });
        if (!archive || typeof archive.path !== 'string') throw new Error('hot-truncate: archive writer returned no path');
        archiveWritten = true;
        const facts = {
          totalTurns: plan.totalTurns,
          archivedTurns: plan.archivedTurns,
          firstTurn: plan.cutTurns[0].turn,
          lastTurn: plan.cutTurns[plan.cutTurns.length - 1].turn,
          cutTurnCount: plan.cutTurns.length,
          shadowedTokenCount: plan.shadowedTokenCount,
          surfaceEventCount: plan.shadowedSeqs.length,
          eventCount: archive.eventCount,
          archivePath: archive.path,
          sha256: archive.sha256,
          retainTurns: this.options.retainTurns,
          retainTokens: this.options.retainTokens,
          retainedTurns: plan.retainedTurns,
        };
        const text = buildPointerText(facts);
        const summary = [{ type: 'text', text }];
        const pointerMessage = createUserMessage({
          content: summary,
          // Carry the cumulative count on the pointer itself. The source stays
          // a normal compact-checkpoint; `hotTruncate` is an extra field the
          // MessageSourceMap (merge-extensible) tolerates.
          source: {
            ...compactCheckpointSource(compactionId, sourceCommandId),
            hotTruncate: {
              archivedTurns: plan.archivedTurns,
              totalTurns: plan.totalTurns,
              archivePath: archive.path,
              retainTurns: this.options.retainTurns,
              retainTokens: this.options.retainTokens,
              cutTurns: plan.cutTurns.map((entry) => entry.turn),
            },
          },
        });
        const pointerTokens = estimateMessage(this.ctx?.tokenMeter, pointerMessage);
        if (pointerTokens + this.options.minCutTokens > plan.shadowedTokenCount) {
          throw new Error(`hot-truncate: pointer (${pointerTokens}) is not smaller than the cut (${plan.shadowedTokenCount}); leaving the surface alone`);
        }

        const startEvent = session.append('compaction/start', lifecycle);
        started = true;
        const summaryEvent = session.append('compaction/summary', {
          compactionId,
          ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
          summary,
          shadowedRange: { start: plan.start, end: plan.end },
          shadowedSeqs: [...plan.shadowedSeqs],
          shadowedTokenCount: plan.shadowedTokenCount,
          provider: PROVIDER,
          model: MODEL,
        });
        // The host's exact replace shape is `{op, startSeq, endSeq}` (three
        // own keys; `start`/`end` are rejected as `invalid replace surfaceOp`).
        session.append('user/message', pointerMessage, {
          surfaceOp: { op: 'replace', startSeq: plan.start, endSeq: plan.end },
          sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...plan.shadowedSeqs],
        });
        const endEvent = session.append('compaction/end', lifecycle);
        closed = true;
        if (openTurn === null && typeof this.ctx?.sessions?.flush === 'function') {
          await this.ctx.sessions.flush(session);
        }
        this.log('info', `hot-truncate: 切掉第 ${plan.cutTurns[0].turn}–${plan.cutTurns[plan.cutTurns.length - 1].turn} 轮，`
          + `${plan.shadowedSeqs.length} 事件 / ${plan.shadowedTokenCount} tokens，原文 ${archive.eventCount} 条 → ${archive.path}`);
        emitHotTruncateDiag('ok');
        return {
          compactionId,
          ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
          startSeq: startEvent.seq,
          summarySeq: summaryEvent.seq,
          endSeq: endEvent.seq,
          summary,
          shadowedRange: { start: plan.start, end: plan.end },
          shadowedSeqs: [...plan.shadowedSeqs],
          shadowedTokenCount: plan.shadowedTokenCount,
        };
      } catch (error) {
        if (started && !closed) {
          try {
            session.append('compaction/end', { ...lifecycle, error: error?.message ?? String(error) });
          } catch {
            // A failed close leaves the unmatched start visible, exactly like
            // the stock backend; the next cut refuses until a seed boundary.
          }
        }
        emitHotTruncateDiag('fail', {
          failReason: `${error?.code ?? 'HOT_TRUNCATE_FAILED'}: ${error?.message ?? String(error)}`,
        });
        throw error;
      } finally {
        this.active.delete(key);
      }
    }

    /** Mode=auto only: cut at idle, inside an agent maintenance window. */
    async autoCut(agent) {
      try {
        await agent.runMaintenance(async (agentSignal) => {
          const signal = AbortSignal.any([agentSignal, AbortSignal.timeout(30000)]);
          const measurement = this.measure(agent.session);
          if (measurement.totalTokens < this.options.autoMinTokens) return;
          const plan = this.planFor(agent.session, measurement);
          if (plan === null) return;
          await this.commit(agent, plan, { signal });
        });
      } catch (error) {
        this.log('warn', `hot-truncate: idle 热截断跳过：${error?.message ?? error}`);
      }
    }
  };
}
