// @local/dsh-longlive — visible-conversation truncation
//
// `session_truncate` keeps the visible conversation byte-identical and only
// drops log-only rows. This module is the other tool: it deliberately removes
// whole turns from the *front* of the conversation, renumbers `seq`, and
// writes a synthetic archive card in front of the retained turns. The point is
// to make the context actually smaller (the host derives messages from the
// Surface, so removed turns stop being sent to the model).
//
// Safety rules:
//   * a turn is never split (cut only at `turn/start`);
//   * the first user-authored message survives (carried into the retained
//     segment when its original turn is dropped);
//   * the host's protected system prompt is copied to the new head;
//   * bytes are written tmp -> fsync -> rename, with an inflight record that a
//     later run can use to roll back a crash;
//   * a seeded session (one that forked another log, header.isSeeded) keeps
//     exactly one inherited `session/end-seed` marker at seq 0, because the
//     host decoder derives the inherited cut from the *last* such marker and
//     refuses a seeded header without one ("released v2 seeded Session lacks an
//     inherited end-seed marker"); the marker event is also the only carrier of
//     that number — the v4 header line has no inheritedEventCount field;
//   * every failure restores the backup and throws a specific code.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  compressFrame,
  parseSession,
  encodeSession,
  assertContiguous,
  deriveMessagesDigest,
  foldSurface,
  MESSAGE_TYPES,
  sha256,
} from './codec.js';
import { sessionError, formatBytes, isInboxEvent, assertNotLive } from './truncate.js';
import { ensureBackup, verifyBackup, sha256File } from './backup.js';

export const VISIBLE_CONFIRM_WORD = 'TRUNCATE-VISIBLE';
export const DEFAULT_KEEP_TURNS = 12;
export const DEFAULT_KEEP_TOKENS = 80_000;
export const INFLIGHT_FILENAME = '.truncate-visible-inflight.json';
export const LEDGER_FILENAME = 'truncate-visible.json';
export const ARCHIVE_DIR_SUFFIX = '.archive';
export const DEFAULT_EVENTS_PER_FRAME = 2000;
// 0.8.0-rc.11 (defect A): the carried first-user message is a *pointer* to the
// archive, not a second copy of it. rc.10 copied the whole text, so a
// 15,524-character prompt became a 35,738-byte synthetic card; the cut then
// still measured 8,633 tokens and the next turn wrote another request.
export const DEFAULT_FIRST_USER_CAP_CHARS = 4000;
// How many extra, earlier cuts to try when the retained window cannot be
// stabilized at the first boundary. Each retry drops one more whole turn.
export const DEFAULT_BOUNDARY_RETRIES = 3;
export const FIRST_USER_CARRY_HEADER = '[会话起点 · 已归档]';
// The rewritten log is accepted when it lands within 5% of keepTokens; the
// planner still targets keepTokens exactly and only uses this as a ceiling.
const BUDGET_SLACK = 1.05;

export const ERROR_CODES = Object.freeze({
  NOT_FOUND: 'VISIBLE_NOT_FOUND',
  BAD_ARGUMENT: 'VISIBLE_BAD_ARGUMENT',
  IS_BACKUP: 'VISIBLE_IS_BACKUP',
  CONFIRM_REQUIRED: 'VISIBLE_CONFIRM_REQUIRED',
  RECENT_WRITE: 'VISIBLE_RECENT_WRITE',
  LOCKED: 'VISIBLE_LOCKED',
  NO_PROTECTED_HEAD: 'VISIBLE_NO_PROTECTED_HEAD',
  REPLACEMENT_STRADDLES_CUT: 'VISIBLE_REPLACEMENT_STRADDLES_CUT',
  NO_BOUNDARY: 'VISIBLE_NO_BOUNDARY',
  TOKEN_BUDGET: 'VISIBLE_TOKEN_BUDGET',
  TMP_VERIFY: 'VISIBLE_TMP_VERIFY',
  POST_VERIFY: 'VISIBLE_POST_VERIFY',
  CHANGED: 'VISIBLE_CHANGED',
  BACKUP_MISSING: 'VISIBLE_BACKUP_MISSING',
  BACKUP_MISMATCH: 'VISIBLE_BACKUP_MISMATCH',
  INFLIGHT_CORRUPT: 'VISIBLE_INFLIGHT_CORRUPT',
  INFLIGHT_BACKUP_MISSING: 'VISIBLE_INFLIGHT_BACKUP_MISSING',
  ARCHIVE_EXISTS: 'VISIBLE_ARCHIVE_EXISTS',
  FAULT_INJECTED: 'VISIBLE_FAULT_INJECTED',
  ARCHIVE_VERIFY: 'VISIBLE_ARCHIVE_VERIFY',
});

function visibleError(code, message, cause) {
  return sessionError(code, message, cause);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export function estimateTokensFromChars(chars) {
  return Math.ceil(Math.max(0, chars) / 4);
}

function resolvePositiveInt(name, value, fallback) {
  const resolved = value ?? fallback;
  if (!(Number.isInteger(resolved) && resolved >= 1)) {
    throw visibleError(ERROR_CODES.BAD_ARGUMENT,
      `${name} must be an integer >= 1 (got ${JSON.stringify(value)})`);
  }
  return resolved;
}

/**
 * Build the synthetic "first user message" row that survives a cut.
 *
 * 0.8.0-rc.11 (defect A): the row is capped at `firstUserCapChars` (default
 * 4,000). Above the cap it keeps the prefix and points at the archive, because
 * the archive already holds the dropped prefix byte-for-byte. rc.10 copied the
 * whole text, so one 15,524-character prompt produced a 35,738-byte card and
 * the cut still exceeded keepTokens, which retriggered on the very next turn.
 *
 * The cap counts characters of the original text (not of the marker/header).
 * A surrogate pair at the boundary is never split.
 */
export function capFirstUserText(original, options = {}) {
  const capChars = resolvePositiveInt('firstUserCapChars',
    options.firstUserCapChars, DEFAULT_FIRST_USER_CAP_CHARS);
  const source = typeof original === 'string' ? original : String(original ?? '');
  const archivePath = options.archivePath ?? '(归档文件)';
  if (source.length <= capChars) {
    return {
      text: `${FIRST_USER_CARRY_HEADER}\n${source}`,
      capped: false,
      capChars,
      originalChars: source.length,
      keptChars: source.length,
      note: null,
    };
  }
  let cut = capChars;
  const last = source.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // do not split a surrogate pair
  const note = `…[首条消息过长，原文见 ${archivePath}]`;
  return {
    text: `${FIRST_USER_CARRY_HEADER}\n${source.slice(0, cut)}\n${note}`,
    capped: true,
    capChars,
    originalChars: source.length,
    keptChars: cut,
    note,
  };
}


function messageOf(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'user/message') return event.data ?? null;
  if (event.type === 'system/message' || event.type === 'developer/message'
    || event.type === 'assistant/message' || event.type === 'tool/result') {
    return event.data?.message ?? null;
  }
  return null;
}

function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function textOfEvent(event) {
  return textOfMessage(messageOf(event));
}

// Text signatures of blocks the host *injects* as user/message rows. They are
// prompt material, not something the user typed, so they must never be quoted
// back as "the first thing the user said".
//
// This list is the fallback, not the primary rule: the host gives real
// client-originated messages a `source.clientTimeZone` field (2723/2723 across
// the 182-session survey behind 0.7.0), while programmatic splices and the
// 2026-11-01 surgical checkpoint have none. See isUserAuthoredMessage below.
export const USER_TEXT_MARKERS = Object.freeze([
  /This is an automatically generated checkpoint/i,
  /Current runtime context/i,
  /<current_user_request\b/i,
  /<engram_profile\b/i,
  /<engram_memory_context\b/i,
  /<system-reminder\b/i,
  /\[Compressed conversation section\]/i,
  /background job[\s\S]{0,200}?\bfinished\b/i,
  /<available_skills\b/i,
  // Adjacent host/plugin envelopes observed in real logs; kept here so a future
  // wrapper cannot silently become "the user's first message" either.
  /You are the Team Lead/i,
  /Dream reviewed/i,
  /\[bili\]/i,
]);

/** True when `text` carries a known injected-block signature. */
export function looksLikeInjectedText(text) {
  if (typeof text !== 'string' || text === '') return false;
  return USER_TEXT_MARKERS.some((pattern) => pattern.test(text));
}

/**
 * Decide whether one session event is a message the *user* actually authored.
 *
 * Order matters:
 *   1. only `user/message` events qualify;
 *   2. `source.kind` must be `user` (not runtime-context, skill-catalog,
 *      compact-checkpoint, schedule, goal, tool-jobs, ...);
 *   3. positive host evidence wins: a non-empty `source.clientTimeZone` means
 *      the message was pushed through the client RPC and carries the client's
 *      zone. Every one of the 2723 real user messages in the 182-session
 *      survey has it; the only `kind:"user"` message with an `rpcId` but no
 *      zone was the 2026-11-01 surgical checkpoint;
 *   4. without that field, fall back to the text blacklist — a match is proof
 *      of machine text;
 *   5. anything still ambiguous returns false. Never carry what cannot be
 *      proven to be the user's own words (a missed carry is recoverable; a
 *      machine block presented as the user's words is not).
 */
export function isUserAuthoredMessage(event) {
  if (!event || event.type !== 'user/message') return false;
  const data = event.data;
  if (!data || typeof data !== 'object') return false;
  const source = data.source;
  if (!source || typeof source !== 'object' || source.kind !== 'user') return false;
  if (typeof source.clientTimeZone === 'string' && source.clientTimeZone.trim() !== '') return true;
  if (looksLikeInjectedText(textOfEvent(event))) return false;
  // No structured user-origin evidence and no disqualifying text signature:
  // still not provable, so it is not carried.
  return false;
}

function eventChars(event) {
  try {
    return JSON.stringify(event?.data ?? {}).length;
  } catch {
    return 0;
  }
}

function eventBytes(event) {
  return Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
}

function messageTokens(event) {
  const message = messageOf(event);
  if (!message) return 0;
  return estimateTokensFromChars(JSON.stringify(message).length);
}

function eventsTokens(events) {
  let total = 0;
  for (const event of events) if (MESSAGE_TYPES.has(event.type)) total += messageTokens(event);
  return total;
}

function eventsMessages(events) {
  return events.filter((event) => MESSAGE_TYPES.has(event.type)).length;
}

function eventsBytes(events) {
  let total = 0;
  for (const event of events) total += eventBytes(event);
  return total;
}

function firstLine(text, max = 80) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function stampForFile(ms) {
  // 20261102-080249, UTC; a stable, sortable archive name.
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function readSnapshot(sessionPath) {
  const buf = fs.readFileSync(sessionPath);
  const stat = fs.statSync(sessionPath);
  return {
    buf,
    size: buf.length,
    statSize: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(buf),
  };
}

function assertUnchanged(sessionPath, snapshot) {
  const stat = fs.statSync(sessionPath);
  const now = sha256File(sessionPath);
  if (stat.size !== snapshot.statSize || now !== snapshot.sha256) {
    throw visibleError(ERROR_CODES.CHANGED,
      `session log changed while planning (size ${snapshot.statSize} -> ${stat.size}, ` +
      `sha256 ${snapshot.sha256.slice(0, 12)}… -> ${now.slice(0, 12)}…); refusing to overwrite`);
  }
}

function writeDurable(file, buffer) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirBestEffort(dir) {
  // Windows cannot fsync a directory; POSIX can. The rename itself is atomic.
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    /* best effort only */
  }
}

function removeIfExists(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

export function inflightPathFor(sessionPath) {
  return path.join(path.dirname(sessionPath), INFLIGHT_FILENAME);
}

export function archiveDirFor(sessionPath) {
  return sessionPath + ARCHIVE_DIR_SUFFIX;
}

export function nextArchivePath(sessionPath, now = Date.now()) {
  const dir = archiveDirFor(sessionPath);
  const base = stampForFile(now);
  let candidate = path.join(dir, `${base}.jsonl.zstd`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}.jsonl.zstd`);
    n += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// turn model
// ---------------------------------------------------------------------------

/**
 * Split events into turns. Anything before the first `turn/start` is a
 * prelude (seed/permission events); it belongs to every prefix cut.
 */
export function turnsOf(events) {
  const turns = [];
  let current = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === 'turn/start') {
      current = {
        turn: typeof event.data?.turn === 'number' ? event.data.turn : turns.length + 1,
        startIndex: i,
        endIndex: i,
        startSeq: event.seq,
        endSeq: event.seq,
        startTime: typeof event.time === 'number' ? event.time : null,
        endTime: typeof event.time === 'number' ? event.time : null,
        events: 0,
        messages: 0,
        chars: 0,
        bytes: 0,
        tokens: 0,
        firstUserIndex: null,
        firstMessageIndex: null,
      };
      turns.push(current);
    }
    if (!current) continue;
    current.endIndex = i;
    current.endSeq = event.seq;
    if (typeof event.time === 'number') current.endTime = event.time;
    current.events += 1;
    current.chars += eventChars(event);
    current.bytes += eventBytes(event);
    if (MESSAGE_TYPES.has(event.type)) {
      current.messages += 1;
      current.tokens += messageTokens(event);
      if (current.firstMessageIndex === null) current.firstMessageIndex = i;
    }
    if (current.firstUserIndex === null && isUserAuthoredMessage(event)) current.firstUserIndex = i;
  }
  return { turns, preludeEvents: turns.length ? turns[0].startIndex : events.length };
}

function firstUserMessageIndex(events) {
  for (let i = 0; i < events.length; i += 1) {
    if (isUserAuthoredMessage(events[i])) return i;
  }
  return -1;
}

const NO_USER_MESSAGE_NOTE =
  '未找到真人消息（no user-authored message matched the host/user-origin check; injected blocks are never carried）';

/**
 * Cheap, side-effect-free estimate of a parsed log. Used by auto-truncate to
 * decide whether a session is worth planning at all.
 */
export function sessionEstimate(parsed) {
  const events = parsed?.events ?? [];
  const { turns } = turnsOf(events);
  return {
    bytes: parsed?.bytes ?? 0,
    events: events.length,
    messages: eventsMessages(events),
    tokens: eventsTokens(events),
    turns: turns.length,
    userMessages: events.filter((event) => isUserAuthoredMessage(event)).length,
  };
}

function protectedHeadIndex(events, cutIndex) {
  for (let i = 0; i < cutIndex; i += 1) {
    const event = events[i];
    if (event.type === 'system/message' && event.data?.message?.source?.kind === 'system-prompt') return i;
  }
  return -1;
}

// buildVisibleTruncated() rewrites a cut log to start with a completed
// synthetic turn 1 that carries the protected system prompt. That turn is not
// part of the conversation, so a later plan must not count it against
// keepTurns: otherwise re-running a truncation drops one more real turn every
// time while still reporting keepTurns=N.
function syntheticHeadTurnCount(events, turns) {
  if (!turns.length) return 0;
  const first = turns[0];
  if (first.startIndex !== 0 || first.firstUserIndex !== null) return 0;
  if (events[0]?.type !== 'turn/start' || events[1]?.type !== 'step/start') return 0;
  if (events[2]?.type !== 'system/message') return 0;
  if (events[2].data?.message?.source?.kind !== 'system-prompt') return 0;
  if (events[3]?.type !== 'step/end' || events[4]?.type !== 'turn/end') return 0;
  return 1;
}

function turnSummary(turns, index, events) {
  const turn = turns[index];
  let firstMessage = '';
  // Prefer the first message the user actually authored. A turn whose only
  // "user" row is an injected runtime-context block has no human first line;
  // never quote the injected block into the archive card or the report.
  const candidate = turn.firstUserIndex ?? turn.firstMessageIndex;
  if (candidate !== null) {
    const text = textOfEvent(events[candidate]);
    if (!looksLikeInjectedText(text)) firstMessage = firstLine(text, 70);
  }
  return {
    turn: turn.turn,
    startSeq: turn.startSeq,
    endSeq: turn.endSeq,
    startTime: turn.startTime,
    endTime: turn.endTime,
    events: turn.events,
    messages: turn.messages,
    tokens: turn.tokens,
    bytes: turn.bytes,
    firstMessage: firstMessage || '（无可见消息）',
  };
}

function findCompactionStraddle(events, cutIndex) {
  // A compaction group is compaction/start ... compaction/end. If the cut
  // falls inside one, move it to the turn that owns the group's start.
  for (let i = 0; i < cutIndex; i += 1) {
    if (events[i].type !== 'compaction/start') continue;
    for (let j = i + 1; j < events.length; j += 1) {
      if (events[j].type === 'compaction/end') {
        if (j >= cutIndex) return i;
        break;
      }
    }
  }
  return -1;
}

/**
 * Pick the first retained turn index from the two mirrors of the request:
 * keep the last `keepTurns` turns, and keep the last turns that fit
 * `keepTokens`. The later boundary wins (fewer turns kept), then it is moved
 * back until it starts on a turn that carries a user-authored message and does
 * not fall inside a compaction group.
 *
 * `extraDroppedTurns` is the 0.8.0-rc.11 downgrade lever: one more whole turn
 * is dropped, and the same guard rules are applied again. It can never return
 * a cut at or before the synthetic protected-head turn.
 */
function chooseBoundary({ turns, events, keepTurns, keepTokens, extraDroppedTurns = 0 }) {
  const syntheticHeadTurns = syntheticHeadTurnCount(events, turns);
  const keepTurnsCut = Math.max(0, turns.length - syntheticHeadTurns - keepTurns);

  // Walk backwards from the last turn while the suffix still fits the budget.
  // This yields the *earliest* boundary that fits; `max` below then picks the
  // later of the two boundaries as requested.
  let tokenCut = turns.length - 1;
  let tokenTotal = turns[tokenCut].tokens;
  while (tokenCut > 0 && tokenTotal + turns[tokenCut - 1].tokens <= keepTokens) {
    tokenCut -= 1;
    tokenTotal += turns[tokenCut].tokens;
  }

  // `cutTurnIndex` is the first *kept* turn, so dropping more turns moves the
  // boundary later. The retry path adds turns here; it must never move the cut
  // towards the head (that would keep more, not less).
  let cutTurnIndex = Math.max(syntheticHeadTurns + keepTurnsCut, tokenCut) + extraDroppedTurns;
  if (cutTurnIndex > turns.length - 1) cutTurnIndex = turns.length - 1;
  if (cutTurnIndex < 1) cutTurnIndex = 1;
  let changed = true;
  let guard = 0;
  while (changed && guard < 64) {
    changed = false;
    guard += 1;
    if (cutTurnIndex <= 0) break;
    if (cutTurnIndex >= turns.length) cutTurnIndex = turns.length - 1;
    const straddle = findCompactionStraddle(events, turns[cutTurnIndex].startIndex);
    if (straddle >= 0) {
      let owner = cutTurnIndex;
      while (owner > 0 && turns[owner].startIndex > straddle) owner -= 1;
      if (owner < cutTurnIndex) {
        cutTurnIndex = owner;
        changed = true;
        continue;
      }
    }
    if (turns[cutTurnIndex].firstUserIndex === null) {
      cutTurnIndex -= 1;
      changed = true;
    }
  }
  return { cutTurnIndex, syntheticHeadTurns, keepTurnsCut, tokenCut, tokenTotal };
}

/**
 * Estimate the *rewritten* log, not just the kept turns: the protected head
 * message, the archive card and the capped first-user carry are all part of
 * what the next turn pays for. 0.8.0-rc.11 uses this for the budget decision
 * (rc.10 subtracted only `dropped.tokens` from `original.tokens`, so synthetic
 * rows were free in the arithmetic and very expensive in the log).
 */
function projectCutTokens({ events, turns, cutTurnIndex, archivePath, firstUserCapChars, insertArchiveCard, carryFirstUserMessage, firstUserIndex }) {
  const cutIndex = turns[cutTurnIndex].startIndex;
  const kept = events.slice(cutIndex);
  const keptTokens = eventsTokens(kept);
  const headIndex = protectedHeadIndex(events, cutIndex);
  const headTokens = headIndex >= 0 ? messageTokens(events[headIndex]) : 0;

  let cardTokens = 0;
  if (insertArchiveCard !== false) {
    const droppedTurns = [];
    for (let i = 0; i < cutTurnIndex; i += 1) droppedTurns.push(turnSummary(turns, i, events));
    const cardText = buildArchiveCardText({
      droppedEvents: events.slice(0, cutIndex),
      droppedTurns,
      cutTurnIndex,
      archivePath: archivePath ?? '(归档文件)',
    });
    cardTokens = messageTokens(syntheticUserMessage({ id: 'archive-card-projection', text: cardText, now: 0 }));
  }

  let carryTokens = 0;
  let carry = null;
  if (carryFirstUserMessage !== false && Number.isInteger(firstUserIndex) && firstUserIndex >= 0 && firstUserIndex < cutIndex) {
    carry = capFirstUserText(textOfEvent(events[firstUserIndex]), { archivePath, firstUserCapChars });
    carryTokens = messageTokens(syntheticUserMessage({ id: 'archive-first-user-projection', text: carry.text, now: 0 }));
  }

  return {
    cutIndex,
    tokens: keptTokens + headTokens + cardTokens + carryTokens,
    keptTokens,
    headTokens,
    cardTokens,
    carryTokens,
    carry,
  };
}


// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

/**
 * Pick a turn boundary. Two independent boundaries are computed and the later
 * one wins (it keeps fewer turns):
 *   - keep the last `keepTurns` turns;
 *   - keep the last turns whose estimated tokens still fit `keepTokens`.
 * The boundary turn must contain a user-authored message; otherwise it moves
 * back one turn. `turn 1` is only pinned when it is also the first user turn —
 * a session whose first turn carries 80% of the context must still be cuttable.
 */
export function planVisibleTruncation(parsed, options = {}) {
  const keepTurns = options.keepTurns ?? DEFAULT_KEEP_TURNS;
  const keepTokens = options.keepTokens ?? DEFAULT_KEEP_TOKENS;
  if (!(Number.isInteger(keepTurns) && keepTurns >= 1)) {
    throw visibleError(ERROR_CODES.BAD_ARGUMENT, `keepTurns must be an integer >= 1 (got ${JSON.stringify(keepTurns)})`);
  }
  if (!(Number.isInteger(keepTokens) && keepTokens >= 1)) {
    throw visibleError(ERROR_CODES.BAD_ARGUMENT, `keepTokens must be an integer >= 1 (got ${JSON.stringify(keepTokens)})`);
  }
  const firstUserCapChars = resolvePositiveInt('firstUserCapChars',
    options.firstUserCapChars, DEFAULT_FIRST_USER_CAP_CHARS);
  const extraDroppedTurns = options.extraDroppedTurns ?? 0;
  if (!(Number.isInteger(extraDroppedTurns) && extraDroppedTurns >= 0)) {
    throw visibleError(ERROR_CODES.BAD_ARGUMENT,
      `extraDroppedTurns must be an integer >= 0 (got ${JSON.stringify(options.extraDroppedTurns)})`);
  }
  const archivePath = options.archivePath ?? null;
  const insertArchiveCard = options.insertArchiveCard !== false;
  const carryFirstUserMessage = options.carryFirstUserMessage !== false;
  const budgetCeiling = Math.ceil(keepTokens * BUDGET_SLACK);

  const events = parsed.events;
  const { turns } = turnsOf(events);
  const firstUserIndex = firstUserMessageIndex(events);
  const firstUserMessage = firstUserIndex >= 0
    ? { seq: events[firstUserIndex].seq, text: firstLine(textOfEvent(events[firstUserIndex]), 160), carried: false }
    : null;
  // "No human in this log" is a finding, not silence: the tool must say so
  // instead of silently falling back to an injected block.
  const firstUserMessageNote = firstUserIndex < 0 ? NO_USER_MESSAGE_NOTE : null;
  const original = {
    bytes: parsed.bytes,
    events: events.length,
    messages: eventsMessages(events),
    tokens: eventsTokens(events),
  };
  if (turns.length < 2) {
    return {
      needed: false,
      reason: `only ${turns.length} turn(s); nothing whole to drop`,
      keepTurns,
      keepTokens,
      original,
      firstUserMessage,
      firstUserMessageNote,
    };
  }

  const base = chooseBoundary({ turns, events, keepTurns, keepTokens });
  const { syntheticHeadTurns, keepTurnsCut, tokenCut } = base;

  if (keepTurnsCut === 0 && tokenCut <= syntheticHeadTurns) {
    return {
      needed: false,
      reason: 'already within keepTurns and keepTokens',
      keepTurns,
      keepTokens,
      original,
      firstUserMessage,
      firstUserMessageNote,
    };
  }

  let cutTurnIndex = chooseBoundary({ turns, events, keepTurns, keepTokens, extraDroppedTurns }).cutTurnIndex;

  // 0.8.0-rc.11 (defect A): budget on the rewritten log, not on the dropped
  // prefix. If the head + archive card + capped carry + kept turns still exceed
  // keepTokens, drop one more whole turn (move the cut later) and try again.
  let projection = projectCutTokens({
    events, turns, cutTurnIndex, archivePath, firstUserCapChars,
    insertArchiveCard, carryFirstUserMessage, firstUserIndex,
  });
  let budgetTrimSteps = 0;
  const projectBudgetTrims = [];
  while (projection.tokens > keepTokens && budgetTrimSteps < turns.length) {
    projectBudgetTrims.push({ cutTurn: turns[cutTurnIndex].turn, tokens: projection.tokens });
    budgetTrimSteps += 1;
    const next = chooseBoundary({
      turns, events, keepTurns, keepTokens,
      extraDroppedTurns: extraDroppedTurns + budgetTrimSteps,
    });
    if (next.cutTurnIndex <= cutTurnIndex) break;
    cutTurnIndex = next.cutTurnIndex;
    projection = projectCutTokens({
      events, turns, cutTurnIndex, archivePath, firstUserCapChars,
      insertArchiveCard, carryFirstUserMessage, firstUserIndex,
    });
  }

  // Cutting exactly at the synthetic head turn is legal (its prompt is copied
  // into the new head), so only index 0 is off-limits. Anything that still
  // cannot fit at the deepest legal cut is reported as TOKEN_BUDGET below,
  // never as "nothing to do" — rc.10 answered a budget failure with a noop.
  if (cutTurnIndex < syntheticHeadTurns) {
    return {
      needed: false,
      reason: 'only the synthetic protected-head turn could be dropped',
      keepTurns,
      keepTokens,
      original,
      firstUserMessage,
      firstUserMessageNote,
    };
  }

  if (cutTurnIndex <= 0) {
    return {
      needed: false,
      reason: 'no whole turn can be dropped while keeping a user-authored message and the protected head',
      keepTurns,
      keepTokens,
      original,
      firstUserMessage,
      firstUserMessageNote,
    };
  }

  const cutIndex = turns[cutTurnIndex].startIndex;
  const headIndex = protectedHeadIndex(events, cutIndex);
  const firstUserDropped = firstUserIndex >= 0 && firstUserIndex < cutIndex;
  const dropped = events.slice(0, cutIndex);
  const kept = events.slice(cutIndex);

  const droppedTurns = [];
  for (let i = 0; i < cutTurnIndex; i += 1) droppedTurns.push(turnSummary(turns, i, events));
  const keptTurns = [];
  for (let i = cutTurnIndex; i < turns.length; i += 1) keptTurns.push(turnSummary(turns, i, events));

  const firstUserText = firstUserDropped ? textOfEvent(events[firstUserIndex]) : null;
  const carryPreview = projection.carry;
  const fits = projection.tokens <= keepTokens;
  const feasible = projection.tokens <= budgetCeiling;

  return {
    needed: true,
    feasible,
    keepTurns,
    keepTokens,
    firstUserCapChars,
    cutIndex,
    cutSeq: cutIndex,
    cutTurn: turns[cutTurnIndex].turn,
    cutTurnIndex,
    cutTurnStartSeq: turns[cutTurnIndex].startSeq,
    cutTime: turns[cutTurnIndex].startTime,
    keptTurnCount: turns.length - cutTurnIndex,
    droppedTurnCount: cutTurnIndex,
    original,
    dropped: {
      bytes: eventsBytes(dropped),
      events: dropped.length,
      messages: eventsMessages(dropped),
      tokens: eventsTokens(dropped),
    },
    kept: {
      bytes: eventsBytes(kept),
      events: kept.length,
      messages: eventsMessages(kept),
      tokens: eventsTokens(kept),
    },
    droppedTurns,
    keptTurns,
    headSeq: headIndex >= 0 ? events[headIndex].seq : null,
    headPresent: headIndex >= 0,
    firstUserMessage: firstUserMessage
      ? { ...firstUserMessage, carried: firstUserDropped }
      : null,
    firstUserMessageNote,
    firstUserText,
    // What the carried row will actually say after the cap: the full text stays
    // in the archive, the rewritten log keeps a bounded prefix plus the path.
    firstUserCarry: carryPreview
      ? {
        capped: carryPreview.capped,
        capChars: carryPreview.capChars,
        originalChars: carryPreview.originalChars,
        keptChars: carryPreview.keptChars,
        text: carryPreview.text,
      }
      : null,
    budget: {
      keepTokens,
      ceiling: budgetCeiling,
      afterTokens: projection.tokens,
      keptTokens: projection.keptTokens,
      headTokens: projection.headTokens,
      cardTokens: projection.cardTokens,
      carryTokens: projection.carryTokens,
      fits,
      overBy: Math.max(0, projection.tokens - keepTokens),
      trimmedTurns: budgetTrimSteps,
      trims: projectBudgetTrims,
    },
    infeasible: feasible ? null : {
      code: ERROR_CODES.TOKEN_BUDGET,
      reason: `post-cut estimate ${projection.tokens} still exceeds keepTokens ${keepTokens} ` +
        `(ceiling ${budgetCeiling}) after dropping ${cutTurnIndex} turn(s); ` +
        'the carried first-user message is already capped',
      attempts: null,
    },
    carryFirstUserMessage: firstUserDropped && carryFirstUserMessage,
    insertArchiveCard,
  };
}

// ---------------------------------------------------------------------------
// archive card
// ---------------------------------------------------------------------------

function walkStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) walkStrings(item, out);
  }
  return out;
}

// 0.7.7: the former `PATH_RE` regular expression was removed. It backtracked
// catastrophically on a long run of separators that never reaches a recognised
// extension: `/a`*30 + `/zzz` took 28.8 s, a 6,766-character Windows path string
// from a real log 10.1 s, and a base64 PNG with 956 slashes never returned —
// all inside `extractPaths` before the dry-run report was returned.
//
// The scan below recognises exactly the language the pattern accepted:
//
//   prefix := [A-Za-z]:[\\/] | /
//   match  := prefix A+ '.' ext          A = [^"'<>\s|:*?]
//
// and keeps the pattern's leftmost/greedy semantics: the match ends at the last
// dot of the maximal A run that carries a recognised extension, and extensions
// are tried in declared order (so `a.json` still ends at `a.js`).
//
// Backslash UNC paths (`\\server\share\a.js`) are deliberately NOT added: the
// old matcher never recognised them, and widening the language would change the
// path set the archive card reports. `/`-prefixed UNC paths
// (`//server/share/a.js`) were matched before and still are.
const PATH_EXTENSIONS = Object.freeze([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'txt', 'log',
  'ps1', 'psm1', 'py', 'yml', 'yaml', 'zst', 'html', 'css', 'toml',
  'ini', 'cfg', 'zip', 'png', 'jpg', 'jpeg', 'wav', 'mp3',
]);

// `[^"'<>\s|:*?]` as a lookup table for ASCII, with the real class for the
// rest of Unicode (`\s` is Unicode-aware). Built once at import time.
const PATH_CHAR_ASCII = (() => {
  const table = new Uint8Array(128);
  const re = /[^"'<>\s|:*?]/;
  for (let code = 0; code < 128; code += 1) table[code] = re.test(String.fromCharCode(code)) ? 1 : 0;
  return table;
})();
const PATH_CHAR_WIDE = /[^"'<>\s|:*?]/;

function extensionLengthAt(text, dot) {
  for (const ext of PATH_EXTENSIONS) {
    const from = dot + 1;
    if (from + ext.length > text.length) continue;
    let matches = true;
    for (let i = 0; i < ext.length; i += 1) {
      if (text.charCodeAt(from + i) !== ext.charCodeAt(i)) { matches = false; break; }
    }
    if (matches) return ext.length;
  }
  return 0;
}

/**
 * Return every path-shaped substring `extractPaths` would take from `text`,
 * in order, scanning the string exactly once (O(text.length)).
 *
 * Exported for the regression suite; production callers go through
 * `extractPaths`/`buildArchiveCardText`.
 */
export function matchPathStrings(text) {
  if (typeof text !== 'string' || text.length < 3) return [];
  const length = text.length;
  const found = [];
  let cursor = 0;
  // Cache for the maximal path-character run that starts at `runStart`: where it
  // ends, and the last dot inside it that carries a recognised extension.
  let runStart = -1;
  let runEnd = -1;
  let runDot = -1;

  while (cursor < length) {
    let start = -1;
    let prefixLength = 0;
    for (let i = cursor; i < length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 0x2f /* / */) {
        start = i;
        prefixLength = 1;
        break;
      }
      if (((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
        && text.charCodeAt(i + 1) === 0x3a /* : */) {
        const separator = text.charCodeAt(i + 2);
        if (separator === 0x2f || separator === 0x5c /* \ */) {
          start = i;
          prefixLength = 3;
          break;
        }
      }
    }
    if (start < 0) break;
    const bodyStart = start + prefixLength;
    if (bodyStart >= length) break;

    let dot;
    if (bodyStart >= runStart && bodyStart < runEnd) {
      // Same run as the cached one: the cached last dot is still the last dot.
      dot = runDot >= bodyStart + 1 ? runDot : -1;
    } else {
      let end = bodyStart;
      while (end < length) {
        const code = text.charCodeAt(end);
        if (code < 128) {
          if (PATH_CHAR_ASCII[code] !== 1) break;
        } else if (!PATH_CHAR_WIDE.test(text[end])) {
          break;
        }
        end += 1;
      }
      let last = -1;
      for (let i = end - 1; i > bodyStart; i -= 1) {
        if (text.charCodeAt(i) === 0x2e /* . */ && extensionLengthAt(text, i) !== 0) {
          last = i;
          break;
        }
      }
      runStart = bodyStart;
      runEnd = end;
      runDot = last;
      dot = last;
    }

    if (dot < 0) {
      // No dot in this run can carry an extension: no candidate starting here
      // can match either, so resume one character in (the next prefix wins).
      cursor = start + 1;
      continue;
    }

    const end = dot + 1 + extensionLengthAt(text, dot);
    found.push(text.slice(start, end));
    cursor = end;
  }
  return found;
}

/** Paths mentioned by `droppedEvents`, most frequent first (archive card). */
export function extractPaths(droppedEvents, max = 8) {
  const counts = new Map();
  for (const event of droppedEvents) {
    for (const text of walkStrings(event.data)) {
      const matches = matchPathStrings(text);
      for (const raw of matches) {
        const normalized = raw.replace(/\\\\/g, '\\').replace(/\\/g, '/');
        if (normalized.length < 5 || normalized.length > 180) continue;
        const key = normalized.toLowerCase();
        counts.set(key, { path: normalized, count: (counts.get(key)?.count ?? 0) + 1 });
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, max)
    .map((item) => item.path);
}

function extractTopics({ droppedEvents, droppedTurns, cutTurnIndex }) {
  const topics = [];
  const seen = new Set();
  const push = (value) => {
    const text = firstLine(value, 72);
    if (!text || seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    topics.push(text);
  };

  // 1. Prefer a provider-generated title over the fallback (which is often just
  // the first user message cut at 12 characters).
  let fallbackTitle = null;
  for (const event of droppedEvents) {
    if (event.type !== 'session/title' || typeof event.data?.title !== 'string') continue;
    if (event.data.source?.kind === 'provider') {
      push(`标题：${event.data.title}`);
      fallbackTitle = null;
      break;
    }
    fallbackTitle ??= event.data.title;
  }
  if (fallbackTitle) push(`标题：${fallbackTitle}`);

  // 2. What the dropped turns actually did: the most frequent tools.
  const toolCounts = new Map();
  for (const event of droppedEvents) {
    if (event.type !== 'tool/call' || typeof event.data?.name !== 'string') continue;
    toolCounts.set(event.data.name, (toolCounts.get(event.data.name) ?? 0) + 1);
  }
  const rankedTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3);
  if (rankedTools.length) {
    push(`工具：${rankedTools.map(([name, count]) => `${name} ×${count}`).join('、')}`);
  }

  // 3. Files the dropped turns touched, as basenames.
  const bases = [];
  for (const full of extractPaths(droppedEvents, 60)) {
    const base = full.split('/').filter(Boolean).at(-1);
    if (!base || bases.some((item) => item.toLowerCase() === base.toLowerCase())) continue;
    bases.push(base);
    if (bases.length >= 3) break;
  }
  if (bases.length) push(`文件：${bases.join('、')}`);

  // 4. Commands named by tool-call arguments (deterministic, no model).
  const knownCommands = new Set([
    'node', 'python', 'python3', 'pwsh', 'powershell', 'cmd', 'bash', 'sh',
    'curl', 'git', 'npm', 'pnpm', 'npx', 'deno', 'bun', 'tar',
  ]);
  const commandCounts = new Map();
  for (const event of droppedEvents) {
    if (event.type !== 'tool/call' || typeof event.data?.arguments !== 'string') continue;
    let parsed = null;
    try { parsed = JSON.parse(event.data.arguments); } catch { continue; }
    const command = parsed?.command ?? parsed?.cmd ?? parsed?.script;
    if (typeof command !== 'string') continue;
    const first = command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '');
    if (!first || first.startsWith('$') || first.startsWith('-')) continue;
    const base = first.split(/[\\/]/).filter(Boolean).at(-1);
    if (!base) continue;
    const lower = base.toLowerCase();
    const isExe = /\.(exe|cmd|bat|ps1|py|js|mjs|cjs)$/i.test(base);
    if (!isExe && !knownCommands.has(lower)) continue;
    commandCounts.set(base, (commandCounts.get(base) ?? 0) + 1);
  }
  const rankedCommands = [...commandCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3);
  if (rankedCommands.length) {
    push(`命令：${rankedCommands.map(([name, count]) => `${name} ×${count}`).join('、')}`);
  }

  // 5. Only when the prefix has almost no tool activity, fall back to turn heads.
  for (const summary of droppedTurns) {
    if (topics.length >= 4) break;
    if (summary?.firstMessage && summary.firstMessage !== '（无可见消息）') push(summary.firstMessage);
  }

  while (topics.length < 3) {
    push(topics.length === 0 ? `早期 ${cutTurnIndex} 轮对话` : `早期对话记录（${topics.length + 1}）`);
  }
  return topics.slice(0, 5);
}

export function buildArchiveCardText({ droppedEvents, droppedTurns, cutTurnIndex, archivePath }) {
  const start = droppedTurns[0]?.startTime;
  const end = droppedTurns.at(-1)?.endTime;
  const topics = extractTopics({ droppedEvents, droppedTurns, cutTurnIndex });
  const paths = extractPaths(droppedEvents, 8);
  const lines = [];
  lines.push(`[已归档 ${formatTime(start)} → ${formatTime(end)}]`);
  lines.push('当时在做：');
  for (const topic of topics) lines.push(`- ${topic}`);
  if (paths.length) {
    lines.push('涉及文件：');
    for (const p of paths) lines.push(`- ${p}`);
  }
  lines.push(`原文归档：${archivePath}`);
  return lines.join('\n');
}

function syntheticUserMessage({ id, text, now }) {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    seq: 0,
    time: now,
    data: {
      id,
      role: 'user',
      source: { kind: 'archive-card' },
      content: [{ type: 'text', text }],
    },
  };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function cloneEvent(event) {
  return structuredClone(event);
}

function preFilterRetained(event) {
  if (isInboxEvent(event)) return false;
  return true;
}

/**
 * A seeded v4 log carries its inherited cut as a marker EVENT, not as a header
 * field: `session/end-seed` with `data.inherited === true`. The decoders derive
 * `inheritedEventCount` from the LAST such row and then require it to equal the
 * header's cut, so the row is load-bearing metadata rather than noise.
 *
 * `@deepseek-ai/dsh-session-format-v1-to-v2` (decoder `finish()`): a seeded
 * header without such a marker throws `released v2 seeded Session lacks an
 * inherited end-seed marker`; an unseeded header that still has one throws
 * `released v2 unseeded Session contains an inherited end-seed marker`.
 * v3-to-v4 adds `format v4 seeded header disagrees with its last inherited
 * end-seed marker`. Truncation has to rewrite this metadata with the log, not
 * around it.
 */
export function isInheritedSeedMarker(event) {
  return Boolean(event)
    && event.type === 'session/end-seed'
    && event.data !== null
    && typeof event.data === 'object'
    && event.data.inherited === true;
}

function remapReferences(event, map, cutIndex) {
  const op = event.surfaceOp;
  if (op && typeof op === 'object') {
    const start = op.startSeq ?? op.start;
    const end = op.endSeq ?? op.end;
    if (typeof start !== 'number' || typeof end !== 'number') return false;
    if (start < cutIndex || end < cutIndex) return false;
    if ('startSeq' in op) op.startSeq = map.get(start); else op.start = map.get(start);
    if ('endSeq' in op) op.endSeq = map.get(end); else op.end = map.get(end);
    if (typeof (op.startSeq ?? op.start) !== 'number') return false;
  }

  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return true;

  // Surface metadata lives on the event, not in data. A tool/result names the
  // tool/call it answers here; after a prefix cut both may survive, but the
  // number still points at the old seq unless it is remapped.
  if (Array.isArray(event.sourceEventSeqs)) {
    const values = event.sourceEventSeqs;
    if (values.every((value) => typeof value === 'number')) {
      const mapped = values
        .filter((value) => value >= cutIndex)
        .map((value) => map.get(value))
        .filter((value) => typeof value === 'number');
      if (mapped.length === 0) delete event.sourceEventSeqs;
      else event.sourceEventSeqs = mapped;
    }
  }

  for (const key of ['sourceEventSeq', 'headerSeq', 'throughSeq']) {
    if (typeof data[key] !== 'number') continue;
    if (data[key] < cutIndex) {
      if (key === 'throughSeq') return false;
      delete data[key];
    } else {
      const mapped = map.get(data[key]);
      if (typeof mapped !== 'number') return false;
      data[key] = mapped;
    }
  }

  for (const key of ['messageSeqs', 'shadowedSeqs', 'sourceEventSeqs']) {
    if (!Array.isArray(data[key])) continue;
    const values = data[key];
    if (values.some((value) => typeof value !== 'number')) continue; // encoded ranges: leave untouched
    if (values.some((value) => value < cutIndex)) {
      if (key === 'messageSeqs') return false;
      return false;
    }
    const mapped = values.map((value) => map.get(value));
    if (mapped.some((value) => typeof value !== 'number')) return false;
    data[key] = mapped;
  }

  const range = data.shadowedRange;
  if (range && typeof range === 'object') {
    const start = range.startSeq ?? range.start;
    const end = range.endSeq ?? range.end;
    if (typeof start === 'number' && typeof end === 'number') {
      if (start < cutIndex || end < cutIndex) return false;
      if ('startSeq' in range) range.startSeq = map.get(start); else range.start = map.get(start);
      if ('endSeq' in range) range.endSeq = map.get(end); else range.end = map.get(end);
    }
  }
  return true;
}

/**
 * Build the rewritten log. Only `seq` and references that pointed into the cut
 * prefix are changed; every other field of a retained event is preserved.
 */
export function buildVisibleTruncated(parsed, plan, options = {}) {
  const now = options.now ?? Date.now();
  const archivePath = options.archivePath;
  const events = parsed.events;
  const cutIndex = plan.cutIndex;

  if (!(Number.isInteger(cutIndex) && cutIndex > 0 && cutIndex < events.length)) {
    throw visibleError(ERROR_CODES.NO_BOUNDARY, `invalid cut index ${cutIndex}`);
  }

  // A replacement that starts before the cut cannot be preserved as-is; refuse
  // rather than silently changing which messages the Surface holds.
  for (let i = cutIndex; i < events.length; i += 1) {
    const event = events[i];
    const op = event.surfaceOp;
    if (op && typeof op === 'object') {
      const start = op.startSeq ?? op.start;
      if (typeof start === 'number' && start < cutIndex) {
        throw visibleError(ERROR_CODES.REPLACEMENT_STRADDLES_CUT,
          `retained event seq ${event.seq} replaces from seq ${start}, which is before the cut at ${cutIndex}`);
      }
    }
  }

  const dropped = events.slice(0, cutIndex);
  const droppedTurns = plan.droppedTurns ?? [];
  const synthetics = [];

  // Seeded sessions: the marker that used to sit inside the dropped prefix has
  // to be replaced, not carried. One fresh marker at index 0 declares an
  // explicitly empty inherited prefix - a shape `@deepseek-ai/dsh-subagent`
  // documents ("isSeeded - whether this child inherits a parent-log prefix,
  // including an explicitly empty one") and the decoder accepts, because the
  // derived count is simply 0.
  //
  // Keeping `isSeeded` with no marker was the 0.7.4 bug: the physical header
  // line has no inheritedEventCount field, so the decoder derived `undefined`
  // and refused the log with "released v2 seeded Session lacks an inherited
  // end-seed marker" (SessionFormatError, wrapped by the persistence layer as
  // SessionPersistenceCorruptionError). The CLI's own read-back only reparsed
  // with src/codec.js, which never looks at this metadata, so it stayed green.
  const seeded = parsed.header?.isSeeded === true;
  if (seeded) {
    synthetics.push({ type: 'session/end-seed', time: now, data: { inherited: true } });
  }

  const headIndex = protectedHeadIndex(events, cutIndex);
  if (headIndex < 0) {
    throw visibleError(ERROR_CODES.NO_PROTECTED_HEAD,
      'no system/message with source.kind="system-prompt" exists before the cut; ' +
      'the host requires a protected head, so nothing was written');
  }
  const head = cloneEvent(events[headIndex]);
  delete head.__remapped;
  // V4 enforces lifecycle relationships: a system/message is only legal inside
  // an open turn+step. Preserve the original prompt as a completed synthetic
  // turn 1, and renumber the retained turns to start at 2.
  head.data = { ...head.data, turn: 1, step: 1 };
  synthetics.push({ type: 'turn/start', time: now, data: { turn: 1 } });
  synthetics.push({ type: 'step/start', time: now, data: { turn: 1, step: 1 } });
  synthetics.push(head);
  synthetics.push({ type: 'step/end', time: now, data: { turn: 1, step: 1 } });
  // Real host turns always end with a reason object; the kinds seen in this
  // machine's session logs are completed / aborted / error / interrupted. The
  // host tolerates a missing one, but third-party consumers read
  // `event.data.reason.kind` and crash on `undefined`; a synthetic turn that
  // only exists because the prefix was dropped ended because of the truncation,
  // so that is the honest kind.
  synthetics.push({
    type: 'turn/end', time: now,
    data: { turn: 1, reason: { kind: 'truncated' } },
  });

  let cardText = null;
  if (plan.insertArchiveCard !== false) {
    cardText = buildArchiveCardText({
      droppedEvents: dropped,
      droppedTurns: droppedTurns.length ? droppedTurns : plan.droppedTurns ?? [],
      cutTurnIndex: plan.droppedTurnCount ?? 0,
      archivePath,
    });
    const cardId = `archive-card-${sha256(Buffer.from(cardText, 'utf8')).slice(0, 8)}`;
    synthetics.push(syntheticUserMessage({ id: cardId, text: cardText, now }));
  }

  let carryText = null;
  let carryInfo = null;
  if (plan.carryFirstUserMessage) {
    const firstIndex = firstUserMessageIndex(events);
    if (firstIndex >= 0 && firstIndex < cutIndex) {
      const original = textOfEvent(events[firstIndex]);
      // 0.8.0-rc.11 (defect A): bound the synthetic row. The archive keeps the
      // bytes; the live log keeps a prefix that names it.
      const capped = capFirstUserText(original, {
        archivePath,
        firstUserCapChars: plan.firstUserCapChars ?? options.firstUserCapChars ?? DEFAULT_FIRST_USER_CAP_CHARS,
      });
      carryText = capped.text;
      carryInfo = {
        capped: capped.capped,
        capChars: capped.capChars,
        originalChars: capped.originalChars,
        keptChars: capped.keptChars,
        note: capped.note,
      };
      const id = `archive-first-user-${sha256(Buffer.from(original, 'utf8')).slice(0, 8)}`;
      synthetics.push(syntheticUserMessage({ id, text: carryText, now }));
    }
  }

  const offset = synthetics.length;
  const turnShift = 2 - plan.cutTurn;
  const base = events.slice(cutIndex)
    // No inherited marker may survive inside the kept window: it would announce
    // a cut at its own (new) position and the decoder would refuse the log
    // ("session inherited event count must identify the final inherited
    // marker" / "format v4 seeded header disagrees with its last inherited
    // end-seed marker"). The single marker written above replaces all of them,
    // and an unseeded header may not carry one at all.
    .filter((event) => !isInheritedSeedMarker(event))
    .map((event) => {
      const clone = cloneEvent(event);
      if (clone.data && typeof clone.data === 'object' && typeof clone.data.turn === 'number') {
        clone.data.turn += turnShift;
      }
      return clone;
    });
  let dirty = base.filter(preFilterRetained);
  let result = dirty;
  let stable = false;
  let passes = 0;
  // 0.8.0-rc.11 (defect B): drops must be cumulative. rc.10 rebuilt `dirty`
  // from `base` on every pass and only remembered the current pass's drops, so
  // an event dropped in pass 1 was re-admitted in pass 2, dropped something
  // else instead, and the loop oscillated until the 8-pass cap:
  // "could not stabilize retained events (22 candidates, 21 survived)".
  // `removed` only grows, so this converges in at most base.length passes.
  const removed = new Set();
  const maxPasses = Number.isInteger(options.stabilizePasses) && options.stabilizePasses >= 1
    ? options.stabilizePasses
    : base.length + 2;
  for (; passes < maxPasses; passes += 1) {
    const map = new Map();
    dirty.forEach((event, index) => map.set(event.seq, offset + index));
    const next = [];
    const droppedSeqs = new Set();
    for (const event of dirty) {
      const candidate = cloneEvent(event);
      if (remapReferences(candidate, map, cutIndex)) next.push(candidate);
      else droppedSeqs.add(event.seq);
    }
    result = next;
    if (droppedSeqs.size === 0) {
      stable = true;
      break;
    }
    // Dropping an event shifts every later position, so the references mapped
    // in this pass are stale: rebuild the map and redo the whole pass.
    for (const seq of droppedSeqs) removed.add(seq);
    dirty = base.filter((event) => preFilterRetained(event) && !removed.has(event.seq));
  }
  if (!stable || dirty.length !== result.length) {
    const error = visibleError(ERROR_CODES.NO_BOUNDARY,
      `could not stabilize retained events (${dirty.length} candidates, ${result.length} survived) ` +
      `at cut turn ${plan.cutTurn ?? '?'} after ${passes} pass(es)`);
    error.details = {
      code: ERROR_CODES.NO_BOUNDARY,
      candidates: dirty.length,
      survived: result.length,
      passes,
      maxPasses,
      cutTurn: plan.cutTurn ?? null,
      cutTurnIndex: plan.cutTurnIndex ?? null,
      cutIndex,
      droppedDuringStabilization: removed.size,
    };
    throw error;
  }

  const composed = [...synthetics, ...result];
  composed.forEach((event, index) => { event.seq = index; });
  assertContiguous(composed);

  const firstSurface = foldSurface(composed)[0];
  if (!firstSurface || firstSurface.type !== 'system/message') {
    throw visibleError(ERROR_CODES.NO_PROTECTED_HEAD,
      'the rewritten log does not start with a system/message; refusing to write it');
  }

  const header = { ...parsed.header };
  // The physical header line accepts a fixed key set
  // (`dsh-session-persistence-jsonl` HEADER_REQUIRED_KEYS/HEADER_OPTIONAL_KEYS
  // via isHeaderLine) and has no inheritedEventCount field at all, so 0.7.4's
  // `header.inheritedEventCount = 0` was a no-op on every real log. The cut is
  // carried by the marker event above; drop any in-memory stray so an unknown
  // key can never be encoded.
  delete header.inheritedEventCount;
  const seedMarker = seeded
    ? { type: 'session/end-seed', inherited: true, index: 0, inheritedEventCount: 0 }
    : null;
  const buffer = encodeSession(header, composed, { eventsPerFrame: options.eventsPerFrame });
  const digest = deriveMessagesDigest(header, composed);

  return {
    header,
    seedMarker,
    events: composed,
    buffer,
    bytes: buffer.length,
    sha256: sha256(buffer),
    digest,
    messages: digest.count,
    tokens: eventsTokens(composed),
    retainedEvents: result.length,
    retainedMessages: eventsMessages(result),
    cardText,
    carryText,
    carryInfo,
    stabilizePasses: passes,
    headCopied: true,
    headSourceSeq: events[headIndex].seq,
    droppedSeqs: dropped.map((event) => event.seq),
  };
}

/**
 * Archive exactly the removed prefix, keeping the original JSON lines
 * byte-for-byte. The prefix already has seq 0..cut-1, so it remains a valid
 * log on its own (header + contiguous events).
 */
export function buildArchiveBuffer(parsed, plan, options = {}) {
  const cutIndex = plan.cutIndex;
  const rawLines = parsed.texts.join('').split('\n').filter((line) => line.length > 0);
  const headerLine = rawLines[0];
  const lines = [];
  for (let i = 0; i < cutIndex; i += 1) {
    const event = parsed.events[i];
    const raw = rawLines[event.seq + 1];
    lines.push(raw ?? JSON.stringify(event));
  }
  const out = [compressFrame(headerLine + '\n')];
  const perFrame = options.eventsPerFrame ?? DEFAULT_EVENTS_PER_FRAME;
  for (let i = 0; i < lines.length; i += perFrame) {
    out.push(compressFrame(lines.slice(i, i + perFrame).map((line) => line + '\n').join('')));
  }
  const buffer = Buffer.concat(out);
  return {
    buffer,
    bytes: buffer.length,
    sha256: sha256(buffer),
    events: lines.length,
    headerLine,
  };
}

// ---------------------------------------------------------------------------
// inflight / recovery
// ---------------------------------------------------------------------------

export function readInflight(sessionPath) {
  const file = inflightPathFor(sessionPath);
  if (!fs.existsSync(file)) return null;
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw visibleError(ERROR_CODES.INFLIGHT_CORRUPT,
      `inflight record ${file} is not valid JSON; refusing to guess (${error.message})`, error);
  }
  return { ...info, inflightPath: file };
}

function cleanupTmp(info) {
  for (const tmp of [info.tmpPath, info.restoreTmpPath]) {
    if (typeof tmp === 'string' && tmp.length > 0) removeIfExists(tmp);
  }
}

/**
 * Resolve a record left by a crash. The target's hash decides:
 *   expected -> the rename landed, finish by removing the record;
 *   before   -> nothing landed, finish by removing the record;
 *   other    -> restore the backup through tmp + rename, then verify.
 */
export function recoverInflight(sessionPath, options = {}) {
  const info = readInflight(sessionPath);
  if (!info) return { status: 'none', recovered: false };
  const target = info.target || sessionPath;
  if (!fs.existsSync(target)) {
    if (!info.backupPath || !fs.existsSync(info.backupPath)) {
      throw visibleError(ERROR_CODES.INFLIGHT_BACKUP_MISSING,
        `target ${target} is missing and the inflight backup ${info.backupPath ?? '(none)'} does not exist; ` +
        'restore it from your own backup before retrying');
    }
  } else {
    const current = sha256File(target);
    if (current === info.expectedSha256) {
      cleanupTmp(info);
      removeIfExists(info.inflightPath);
      return { status: 'completed', recovered: false, target, sha256: current };
    }
    if (current === info.beforeSha256) {
      cleanupTmp(info);
      removeIfExists(info.inflightPath);
      return { status: 'clean', recovered: false, target, sha256: current };
    }
  }

  if (!info.backupPath || !fs.existsSync(info.backupPath)) {
    throw visibleError(ERROR_CODES.INFLIGHT_BACKUP_MISSING,
      `cannot roll back ${target}: backup ${info.backupPath ?? '(none)'} is missing. ` +
      `Restore it manually from your own backup.`);
  }
  if (info.backupSha256) {
    const check = verifyBackup(info.backupPath, info.backupSha256);
    if (!check.ok) {
      throw visibleError(ERROR_CODES.BACKUP_MISMATCH,
        `cannot roll back ${target}: backup ${info.backupPath} failed verification (${check.reason})`);
    }
  }
  const restoreTmp = `${target}.restore-${process.pid}-${Date.now()}`;
  try {
    writeDurable(restoreTmp, fs.readFileSync(info.backupPath));
    const restoredSha = sha256File(restoreTmp);
    if (info.beforeSha256 && restoredSha !== info.beforeSha256) {
      throw visibleError(ERROR_CODES.BACKUP_MISMATCH,
        `restored bytes ${restoredSha} != before hash ${info.beforeSha256}`);
    }
    fs.renameSync(restoreTmp, target);
    fsyncDirBestEffort(path.dirname(target));
    const finalSha = sha256File(target);
    if (info.beforeSha256 && finalSha !== info.beforeSha256) {
      throw visibleError(ERROR_CODES.BACKUP_MISMATCH,
        `after restore, ${target} has sha256 ${finalSha}, expected ${info.beforeSha256}`);
    }
    cleanupTmp(info);
    removeIfExists(info.inflightPath);
    return {
      status: 'rolled-back',
      recovered: true,
      target,
      sha256: finalSha,
      backupPath: info.backupPath,
      archivePath: info.archivePath ?? null,
      startedAt: info.startedAt ?? null,
    };
  } finally {
    removeIfExists(restoreTmp);
  }
}

/**
 * Scan a DSH home for inflight records and recover each. Used at plugin start.
 * One bad record never prevents the others from being checked.
 */
export function sweepInflight(root, options = {}) {
  const results = [];
  if (!root || !fs.existsSync(root)) return results;
  const maxDepth = options.maxDepth ?? 6;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === INFLIGHT_FILENAME) {
        try {
          results.push({ file: full, ...recoverInflight(path.join(dir, 'session.v4.jsonl.zstd')) });
        } catch (error) {
          results.push({ file: full, status: 'error', code: error?.code ?? 'VISIBLE_RECOVERY_FAILED', message: error.message });
        }
      } else if (entry.isDirectory() && depth < maxDepth && !entry.name.endsWith(ARCHIVE_DIR_SUFFIX)) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// the operation
// ---------------------------------------------------------------------------

/**
 * Resolve a cut that both plans and *builds*: the boundary is only accepted
 * when the rewritten log can be encoded and lands within the token budget.
 *
 * 0.8.0-rc.11 (defect B): when the first boundary cannot be stabilized, retry
 * with one more whole turn dropped (up to `boundaryRetries`, default 3). The
 * old code threw `VISIBLE_NO_BOUNDARY` straight out of the build and
 * `onTurnEnd` swallowed it, so a dry run failed silently and the next turn
 * wrote another request. Now the failure is a value: the caller either gets a
 * feasible plan/built pair or a structured `{feasible:false, code, reason,
 * attempts}` and can log it.
 *
 * @returns {{feasible:boolean, needed:boolean, plan:object|null, built:object|null,
 *   attempts:Array, overBy:number, code?:string, reason?:string, error?:Error}}
 */
export function resolveVisibleCut(parsed, options = {}) {
  const keepTurns = options.keepTurns ?? DEFAULT_KEEP_TURNS;
  const keepTokens = options.keepTokens ?? DEFAULT_KEEP_TOKENS;
  const firstUserCapChars = resolvePositiveInt('firstUserCapChars',
    options.firstUserCapChars, DEFAULT_FIRST_USER_CAP_CHARS);
  const boundaryRetries = options.boundaryRetries ?? DEFAULT_BOUNDARY_RETRIES;
  if (!(Number.isInteger(boundaryRetries) && boundaryRetries >= 0)) {
    throw visibleError(ERROR_CODES.BAD_ARGUMENT,
      `boundaryRetries must be an integer >= 0 (got ${JSON.stringify(options.boundaryRetries)})`);
  }
  const archivePath = options.archivePath ?? null;
  const now = options.now ?? Date.now();
  const ceiling = Math.ceil(keepTokens * BUDGET_SLACK);

  const attempts = [];
  let lastPlan = null;
  let lastError = null;
  let previousCutIndex = null;

  for (let attempt = 0; attempt <= boundaryRetries; attempt += 1) {
    const plan = planVisibleTruncation(parsed, {
      keepTurns,
      keepTokens,
      firstUserCapChars,
      extraDroppedTurns: attempt,
      carryFirstUserMessage: options.carryFirstUserMessage,
      insertArchiveCard: options.insertArchiveCard,
      archivePath,
    });
    if (!plan.needed) {
      if (attempt === 0) return { feasible: true, needed: false, plan, built: null, attempts };
      break; // trimming walked past the last droppable turn
    }
    // The guards clamped the boundary at the last turn: retrying would repeat
    // the same plan, so stop and report what actually happened.
    if (previousCutIndex !== null && plan.cutTurnIndex === previousCutIndex) break;
    previousCutIndex = plan.cutTurnIndex;
    lastPlan = plan;

    if (plan.feasible === false) {
      lastError = visibleError(ERROR_CODES.TOKEN_BUDGET, plan.infeasible.reason);
      lastError.details = {
        code: ERROR_CODES.TOKEN_BUDGET,
        keepTokens,
        ceiling,
        tokens: plan.budget.afterTokens,
        candidates: null,
        survived: null,
        budget: plan.budget,
      };
      attempts.push({
        attempt,
        keepTurns,
        cutTurn: plan.cutTurn,
        cutIndex: plan.cutIndex,
        code: ERROR_CODES.TOKEN_BUDGET,
        tokens: plan.budget.afterTokens,
        overBy: plan.budget.overBy,
      });
      continue;
    }

    try {
      const built = buildVisibleTruncated(parsed, plan, {
        now,
        archivePath,
        eventsPerFrame: options.eventsPerFrame,
        stabilizePasses: options.stabilizePasses,
      });
      const overBy = Math.max(0, built.tokens - keepTokens);
      const within = built.tokens <= ceiling;
      attempts.push({
        attempt,
        keepTurns,
        cutTurn: plan.cutTurn,
        cutIndex: plan.cutIndex,
        tokens: built.tokens,
        overBy,
        stabilizePasses: built.stabilizePasses,
        code: within ? null : ERROR_CODES.TOKEN_BUDGET,
      });
      if (within) {
        return { feasible: true, needed: true, plan, built, attempts, overBy };
      }
      lastError = visibleError(ERROR_CODES.TOKEN_BUDGET,
        `post-cut estimate ${built.tokens} exceeds keepTokens ${keepTokens} (ceiling ${ceiling}) ` +
        `at cut turn ${plan.cutTurn}`);
      lastError.details = {
        code: ERROR_CODES.TOKEN_BUDGET,
        keepTokens,
        ceiling,
        tokens: built.tokens,
        cutTurn: plan.cutTurn,
        candidates: built.retainedMessages,
        survived: built.retainedEvents,
      };
    } catch (error) {
      if (error?.code !== ERROR_CODES.NO_BOUNDARY) throw error;
      lastError = error;
      attempts.push({
        attempt,
        keepTurns,
        cutTurn: plan.cutTurn,
        cutIndex: plan.cutIndex,
        code: error.code,
        candidates: error.details?.candidates ?? null,
        survived: error.details?.survived ?? null,
        passes: error.details?.passes ?? null,
      });
      // The next attempt drops one more whole turn and re-runs the guards.
    }
  }

  const code = lastError?.code ?? ERROR_CODES.NO_BOUNDARY;
  const reason = lastError?.message ?? 'no cut could be stabilized';
  const error = lastError ?? visibleError(code, reason);
  error.details = {
    ...(error.details ?? {}),
    code,
    attempts,
    keepTurns,
    keepTokens,
    firstUserCapChars,
    boundaryRetries,
  };
  error.attempts = attempts;
  return {
    feasible: false,
    needed: true,
    plan: lastPlan,
    built: null,
    attempts,
    code,
    reason,
    error,
  };
}

function ledgerFor(sessionPath) {
  return path.join(path.dirname(sessionPath), LEDGER_FILENAME);
}

function appendLedger(sessionPath, entry) {
  const file = ledgerFor(sessionPath);
  let ledger = { version: 1, truncations: [] };
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed.truncations)) ledger = { version: parsed.version ?? 1, truncations: parsed.truncations };
    } catch { /* replace a corrupt ledger, never block the write */ }
  }
  ledger.truncations.push(entry);
  if (ledger.truncations.length > 50) ledger.truncations = ledger.truncations.slice(-50);
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

// Test-only read seam: the suite makes the post-rename read return bytes that
// differ from what was written, so the read-back verification (and its rollback)
// is exercised on its own instead of failing earlier in the write. The file on
// disk keeps the bytes we wrote; only the value read here changes.
function readBackCorrupted(sessionPath) {
  const buf = Buffer.from(fs.readFileSync(sessionPath));
  if (buf.length > 0) buf[buf.length - 1] ^= 0x01;
  return buf;
}

function readbackVerify(sessionPath, expected, readFile = fs.readFileSync) {
  const buf = readFile(sessionPath);
  const actualSha = sha256(buf);
  if (actualSha !== expected.sha256) {
    throw visibleError(ERROR_CODES.POST_VERIFY,
      `read-back sha256 ${actualSha} != written ${expected.sha256}`);
  }
  const parsed = parseSession(buf);
  assertContiguous(parsed.events);
  if (parsed.events.length !== expected.events.length) {
    throw visibleError(ERROR_CODES.POST_VERIFY,
      `read-back has ${parsed.events.length} events, expected ${expected.events.length}`);
  }
  const digest = deriveMessagesDigest(parsed.header, parsed.events);
  if (digest.count !== expected.messages) {
    throw visibleError(ERROR_CODES.POST_VERIFY,
      `read-back derives ${digest.count} messages, expected ${expected.messages}`);
  }
  return { sha256: actualSha, events: parsed.events.length, messages: digest.count };
}

function restoreBackup(target, backupPath, expectedSha, log) {
  const tmp = `${target}.rollback-${process.pid}-${Date.now()}`;
  try {
    writeDurable(tmp, fs.readFileSync(backupPath));
    const got = sha256File(tmp);
    if (expectedSha && got !== expectedSha) {
      throw visibleError(ERROR_CODES.BACKUP_MISMATCH,
        `rollback copy ${got} != expected ${expectedSha}`);
    }
    fs.renameSync(tmp, target);
    fsyncDirBestEffort(path.dirname(target));
    const finalSha = sha256File(target);
    if (expectedSha && finalSha !== expectedSha) {
      throw visibleError(ERROR_CODES.BACKUP_MISMATCH,
        `after rollback ${target} has sha256 ${finalSha}, expected ${expectedSha}`);
    }
    log.push({ step: 'rollback', ok: true, backupPath, sha256: finalSha });
    return { ok: true, sha256: finalSha };
  } finally {
    removeIfExists(tmp);
  }
}

export function rollbackCommand(backupPath, target) {
  if (process.platform === 'win32') {
    return `Copy-Item -LiteralPath "${backupPath}" -Destination "${target}" -Force`;
  }
  return `cp -f "${backupPath}" "${target}"`;
}

/**
 * Main entry point. Defaults to a dry run; writing needs
 * `confirm: "TRUNCATE-VISIBLE"`.
 */
export function truncateVisibleSession(sessionPath, options = {}) {
  const dryRun = options.dryRun !== false;
  const keepTurns = options.keepTurns ?? DEFAULT_KEEP_TURNS;
  const keepTokens = options.keepTokens ?? DEFAULT_KEEP_TOKENS;
  const now = options.now ?? Date.now();
  const eventsPerFrame = options.eventsPerFrame ?? DEFAULT_EVENTS_PER_FRAME;
  const log = [];
  const abs = path.resolve(sessionPath);

  if (!fs.existsSync(abs)) {
    throw visibleError(ERROR_CODES.NOT_FOUND,
      `no such session log: ${abs} — run session_health to list sessions, or pass ` +
      'sessionId / session:"latest". Nothing was written.');
  }
  if (/\.bak-/.test(path.basename(abs))) {
    throw visibleError(ERROR_CODES.IS_BACKUP, `${path.basename(abs)} is a backup; point at session.v4.jsonl.zstd`);
  }
  if (!fs.statSync(abs).isFile()) {
    throw visibleError(ERROR_CODES.BAD_ARGUMENT, `not a regular file: ${abs}`);
  }
  if (!dryRun && options.confirm !== VISIBLE_CONFIRM_WORD) {
    throw visibleError(ERROR_CODES.CONFIRM_REQUIRED,
      `refusing to write: pass confirm:"${VISIBLE_CONFIRM_WORD}" (got ${JSON.stringify(options.confirm)})`);
  }

  if (!dryRun) {
    const stale = readInflight(abs);
    if (stale) {
      const recovered = recoverInflight(abs, { now });
      log.push({ step: 'recover-stale-inflight', ...recovered });
    }
  }

  const snapshot = readSnapshot(abs);
  const parsed = parseSession(snapshot.buf);
  const archivePath = nextArchivePath(abs, now);
  const resolved = resolveVisibleCut(parsed, {
    keepTurns,
    keepTokens,
    firstUserCapChars: options.firstUserCapChars,
    boundaryRetries: options.boundaryRetries,
    carryFirstUserMessage: options.carryFirstUserMessage,
    insertArchiveCard: options.insertArchiveCard,
    archivePath,
    now,
    eventsPerFrame,
    stabilizePasses: options.stabilizePasses,
  });

  if (!resolved.needed) {
    const noop = {
      ok: true,
      needed: false,
      feasible: true,
      status: 'noop',
      sessionPath: abs,
      keepTurns,
      keepTokens,
      reason: resolved.plan.reason,
      original: resolved.plan.original,
      before: { ...resolved.plan.original, sha256: snapshot.sha256 },
      firstUserMessage: resolved.plan.firstUserMessage ?? null,
      firstUserMessageNote: resolved.plan.firstUserMessageNote ?? null,
      archivePath: null,
    };
    noop.message = formatVisibleReport(noop);
    return noop;
  }

  if (!resolved.feasible) {
    const error = resolved.error;
    error.result = {
      sessionPath: abs,
      needed: true,
      feasible: false,
      archivePath: null,
      before: { ...sessionEstimate(parsed), sha256: snapshot.sha256 },
      attempts: resolved.attempts,
    };
    if (!dryRun) {
      // Writing mode: nothing is ever written on an infeasible cut.
      throw error;
    }
    const infeasible = {
      ok: false,
      needed: true,
      feasible: false,
      dryRun: true,
      applied: false,
      status: 'infeasible',
      sessionPath: abs,
      keepTurns,
      keepTokens,
      firstUserCapChars: resolved.plan?.firstUserCapChars ?? options.firstUserCapChars ?? DEFAULT_FIRST_USER_CAP_CHARS,
      code: resolved.code,
      reason: resolved.reason,
      attempts: resolved.attempts,
      cut: null,
      before: { ...sessionEstimate(parsed), sha256: snapshot.sha256 },
      // The report still needs these shapes; an empty plan is honest about it.
      droppedTurns: [],
      keptTurns: [],
      dropped: { bytes: 0, events: 0, messages: 0, tokens: 0 },
      kept: { bytes: 0, events: 0, messages: 0, tokens: 0 },
      after: null,
      archivePath: null,
      archive: null,
      log,
    };
    infeasible.message = formatVisibleReport(infeasible);
    return infeasible;
  }

  const plan = resolved.plan;
  const built = resolved.built;
  const archive = buildArchiveBuffer(parsed, plan, { eventsPerFrame });
  const result = {
    ok: true,
    needed: true,
    dryRun,
    applied: false,
    status: dryRun ? 'planned' : 'truncated',
    feasible: true,
    sessionPath: abs,
    keepTurns,
    keepTokens,
    firstUserCapChars: plan.firstUserCapChars,
    attempts: resolved.attempts,
    cut: {
      turn: plan.cutTurn,
      index: plan.cutIndex,
      startSeq: plan.cutTurnStartSeq,
      droppedTurns: plan.droppedTurnCount,
      keptTurns: plan.keptTurnCount,
    },
    droppedTurnCount: plan.droppedTurnCount,
    keptTurnCount: plan.keptTurnCount,
    droppedTurns: plan.droppedTurns,
    keptTurns: plan.keptTurns,
    before: { ...plan.original, sha256: snapshot.sha256 },
    dropped: plan.dropped,
    kept: plan.kept,
    after: {
      bytes: built.bytes,
      events: built.events.length,
      messages: built.messages,
      tokens: built.tokens,
      sha256: built.sha256,
    },
    retainedEvents: built.retainedEvents,
    retainedMessages: built.retainedMessages,
    archivePath,
    archive: { bytes: archive.bytes, events: archive.events, sha256: archive.sha256 },
    headCopied: built.headCopied,
    headSourceSeq: built.headSourceSeq,
    // Seeded sessions: the single inherited marker now written at index 0, or
    // null when the log is unseeded. Reported so the CLI/orchestrator can prove
    // the metadata was rewritten with the events.
    seedMarker: built.seedMarker,
    archiveCard: plan.insertArchiveCard ? { inserted: true, text: built.cardText } : { inserted: false },
    budget: plan.budget,
    firstUserMessage: plan.firstUserMessage
      ? { ...plan.firstUserMessage, carried: Boolean(built.carryText), carriedText: built.carryText }
      : null,
    firstUserCarry: plan.firstUserCarry ?? null,
    firstUserMessageNote: plan.firstUserMessageNote ?? null,
    backupPath: null,
    inflightPath: inflightPathFor(abs),
    log,
    rollback: null,
  };

  if (dryRun) {
    result.message = formatVisibleReport(result);
    return result;
  }

  assertNotLive(abs, { recentWriteWindowMs: options.recentWriteWindowMs ?? 60_000, now });
  assertUnchanged(abs, snapshot);

  const archiveDir = archiveDirFor(abs);
  fs.mkdirSync(archiveDir, { recursive: true });
  if (fs.existsSync(archivePath)) {
    throw visibleError(ERROR_CODES.ARCHIVE_EXISTS,
      `archive already exists: ${archivePath} — archives are never overwritten. ` +
      'Re-run with a different session, or move/rename the existing archive after checking it.');
  }
  writeDurable(archivePath, archive.buffer);
  const archiveCheck = parseSession(fs.readFileSync(archivePath));
  if (archiveCheck.events.length !== archive.events) {
    throw visibleError(ERROR_CODES.ARCHIVE_VERIFY,
      `archive has ${archiveCheck.events.length} events, expected ${archive.events}`);
  }
  log.push({ step: 'archive', ok: true, file: archivePath, bytes: archive.bytes, events: archive.events });

  const backup = ensureBackup(abs, {
    date: new Date(now),
    sourceBuf: snapshot.buf,
    sha256: snapshot.sha256,
    size: snapshot.size,
  });
  const backupCheck = verifyBackup(backup.file, snapshot.sha256);
  if (!backupCheck.ok) {
    throw visibleError(ERROR_CODES.BACKUP_MISMATCH,
      `backup ${backup.file} failed verification: ${backupCheck.reason}`);
  }
  result.backupPath = backup.file;
  result.rollback = rollbackCommand(backup.file, abs);
  log.push({ step: 'backup', ok: true, file: backup.file, created: backup.created });

  const tmpPath = `${abs}.truncate-visible.tmp-${process.pid}-${now}`;
  const inflight = {
    version: 1,
    kind: 'session-truncate-visible',
    target: abs,
    archivePath,
    backupPath: backup.file,
    backupSha256: snapshot.sha256,
    beforeSha256: snapshot.sha256,
    beforeSize: snapshot.size,
    expectedSha256: built.sha256,
    expectedSize: built.bytes,
    expectedEvents: built.events.length,
    expectedMessages: built.messages,
    tmpPath,
    phase: 'prepared',
    startedAt: new Date(now).toISOString(),
    keepTurns,
    keepTokens,
    cutTurn: plan.cutTurn,
    cutSeq: plan.cutIndex,
    droppedEvents: plan.dropped.events,
    droppedMessages: plan.dropped.messages,
    keptEvents: built.retainedEvents,
    keptMessages: built.retainedMessages,
    platform: process.platform,
    pid: process.pid,
  };
  const inflightPath = inflightPathFor(abs);
  writeDurable(inflightPath, Buffer.from(JSON.stringify(inflight, null, 2) + '\n', 'utf8'));
  log.push({ step: 'inflight', ok: true, file: inflightPath });

  const fault = (name) => {
    if (options.faultAt === name) {
      throw visibleError(ERROR_CODES.FAULT_INJECTED, `injected fault at ${name} (test only)`);
    }
  };

  try {
    fault('after-backup');

    writeDurable(tmpPath, built.buffer);
    const tmpBuf = fs.readFileSync(tmpPath);
    if (sha256(tmpBuf) !== built.sha256) {
      throw visibleError(ERROR_CODES.TMP_VERIFY, 'tmp file sha256 does not match the in-memory buffer');
    }
    const tmpParsed = parseSession(tmpBuf);
    if (tmpParsed.events.length !== built.events.length) {
      throw visibleError(ERROR_CODES.TMP_VERIFY,
        `tmp parses to ${tmpParsed.events.length} events, expected ${built.events.length}`);
    }
    const tmpDigest = deriveMessagesDigest(tmpParsed.header, tmpParsed.events);
    if (tmpDigest.count !== built.messages) {
      throw visibleError(ERROR_CODES.TMP_VERIFY,
        `tmp derives ${tmpDigest.count} messages, expected ${built.messages}`);
    }
    log.push({ step: 'tmp', ok: true, file: tmpPath, bytes: built.bytes });
    fault('after-tmp');

    assertUnchanged(abs, snapshot);
    fault('before-rename');

    fs.renameSync(tmpPath, abs);
    fsyncDirBestEffort(path.dirname(abs));
    log.push({ step: 'rename', ok: true, target: abs });
    fault('after-rename');

    const readBack = options.faultAt === 'after-rename-corrupt-readback'
      ? readBackCorrupted
      : undefined;
    const verified = readbackVerify(abs, {
      sha256: built.sha256,
      events: built.events,
      messages: built.messages,
    }, readBack);
    log.push({ step: 'read-back', ok: true, ...verified });

    removeIfExists(inflightPath);
    result.applied = true;
    result.backupPath = backup.file;
    result.rollback = rollbackCommand(backup.file, abs);
    result.readBack = verified;
    appendLedger(abs, {
      at: new Date(now).toISOString(),
      tool: 'session_truncate_visible',
      cutTurn: plan.cutTurn,
      cutSeq: plan.cutIndex,
      droppedTurns: plan.droppedTurnCount,
      keptTurns: plan.keptTurnCount,
      beforeBytes: snapshot.size,
      afterBytes: built.bytes,
      beforeMessages: plan.original.messages,
      afterMessages: built.messages,
      beforeTokens: plan.original.tokens,
      afterTokens: built.tokens,
      archivePath,
      backupPath: backup.file,
      beforeSha256: snapshot.sha256,
      afterSha256: built.sha256,
    });
    result.message = formatVisibleReport(result);
    return result;
  } catch (error) {
    // The target is only touched by the rename. If the rename already landed
    // and verification failed, restore the exact bytes we snapshotted.
    let restore = null;
    if (fs.existsSync(abs) && sha256File(abs) !== snapshot.sha256) {
      try {
        restore = restoreBackup(abs, backup.file, snapshot.sha256, log);
        result.restored = true;
        removeIfExists(inflightPath);
      } catch (rollbackError) {
        result.restoreError = { code: rollbackError?.code, message: rollbackError.message };
      }
    } else {
      removeIfExists(tmpPath);
      removeIfExists(inflightPath);
    }
    if (restore?.ok) result.rollback = rollbackCommand(backup.file, abs);
    log.push({ step: 'failed', ok: false, code: error?.code ?? 'VISIBLE_TRUNCATE_FAILED', message: error.message });
    result.log = log;
    error.result = result;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function percentDrop(before, after) {
  if (!before) return '0.0%';
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}

export function formatVisibleReport(result) {
  if (result && result.feasible === false) {
    const lines = [];
    lines.push('无法截断（infeasible，未写盘）：没有可稳定保留下来的边界');
    lines.push(`目标：${result.sessionPath}`);
    lines.push(`原因（${result.code ?? 'VISIBLE_NO_BOUNDARY'}）：${result.reason ?? 'unknown'}`);
    if (result.attempts?.length) {
      lines.push(`尝试：${result.attempts.length} 次（每次多删 1 轮）`);
      for (const attempt of result.attempts) {
        lines.push(`  #${attempt.attempt + 1} cut turn ${attempt.cutTurn ?? '?'}` +
          `${attempt.code ? ` → ${attempt.code}` : ''}` +
          `${Number.isInteger(attempt.candidates) ? `（${attempt.candidates} candidates, ${attempt.survived} survived）` : ''}` +
          `${Number.isInteger(attempt.tokens) ? ` tokens ${attempt.tokens}` : ''}`);
      }
    }
    if (result.before) {
      lines.push(`原始：${formatBytes(result.before.bytes)} / ${result.before.events} 事件 / ` +
        `${result.before.messages} 条消息 / ≈${result.before.tokens.toLocaleString('en-US')} token`);
    }
    lines.push('没有写归档、没有写备份、没有改动会话文件。');
    return lines.join('\n');
  }
  if (!result || result.needed === false) {
    const note = result?.firstUserMessageNote ? `；${result.firstUserMessageNote}` : '';
    return `无操作：${result?.reason ?? 'nothing to drop'}（${result?.sessionPath ?? ''}）${note}`;
  }
  const lines = [];
  lines.push(`${result.applied ? '已截断（宿主需重新加载）' : '预演（dry-run，未写盘）'}`);
  lines.push(`目标：${result.sessionPath}`);
  lines.push(`原始：${formatBytes(result.before.bytes)} / ${result.before.events} 事件 / ` +
    `${result.before.messages} 条消息 / ≈${result.before.tokens.toLocaleString('en-US')} token（MESSAGE_TYPES 的 data JSON/4 启发式）`);
  lines.push(`将删：turn 1–${result.cut.turn - 1}（seq 0–${result.cut.startSeq - 1}），` +
    `${result.droppedTurnCount ?? result.droppedTurns.length} 轮 / ${result.dropped.events} 事件 / ` +
    `${result.dropped.messages} 条消息 / 解压后 ${formatBytes(result.dropped.bytes)} / ` +
    `≈${result.dropped.tokens.toLocaleString('en-US')} token`);
  lines.push(`保留：turn ${result.cut.turn}–（seq ${result.cut.startSeq}–${result.before.events - 1}），` +
    `${result.keptTurnCount ?? result.keptTurns.length} 轮 / ${result.kept.events} 事件 / ` +
    `${result.kept.messages} 条消息`);
  if (result.firstUserMessage) {
    const note = result.firstUserMessage.carried
      ? '已复刻到保留段头'
      : '位于保留段内，未复刻';
    lines.push(`首条真人消息：seq ${result.firstUserMessage.seq}（${note}）：${result.firstUserMessage.text}`);
    if (result.firstUserCarry) {
      const carry = result.firstUserCarry;
      lines.push(`  复刻文本：${carry.keptChars}/${carry.originalChars} 字符` +
        `${carry.capped ? `（已截断，上限 ${carry.capChars}，原文见归档）` : '（未截断）'}`);
    }
  } else {
    lines.push(result.firstUserMessageNote ?? NO_USER_MESSAGE_NOTE);
  }
  if (result.budget) {
    lines.push(`预算：裁剪后 ≈${result.budget.afterTokens.toLocaleString('en-US')} token / ` +
      `keepTokens ${result.budget.keepTokens.toLocaleString('en-US')}` +
      `${result.budget.fits ? '（达标）' : `（超 ${result.budget.overBy}，在 ${Math.round((result.budget.ceiling / result.budget.keepTokens - 1) * 100)}% 余量内）`}` +
      `${result.budget.trimmedTurns ? `，为达标多删 ${result.budget.trimmedTurns} 轮` : ''}`);
  }
  lines.push('切割清单：');
  for (const turn of result.droppedTurns) {
    lines.push(`  turn ${turn.turn}  seq ${turn.startSeq}–${turn.endSeq}  ` +
      `${formatTime(turn.startTime)} → ${formatTime(turn.endTime)}  ` +
      `${turn.messages} 条消息  首条：${turn.firstMessage}`);
  }
  lines.push('保留轮：');
  for (const turn of result.keptTurns) {
    lines.push(`  turn ${turn.turn}  seq ${turn.startSeq}–${turn.endSeq}  ` +
      `${turn.messages} 条消息  首条：${turn.firstMessage}`);
  }
  lines.push(`头：${result.headCopied ? `已复制 system/message（原 seq ${result.headSourceSeq}）` : '无'}`);
  lines.push(`归档卡：${result.archiveCard.inserted ? '已插入 user/message：' : '未插入'}`);
  if (result.archiveCard.inserted) {
    for (const line of result.archiveCard.text.split('\n')) lines.push(`  ${line}`);
  }
  lines.push(`写后：${formatBytes(result.after.bytes)} / ${result.after.events} 事件 / ` +
    `${result.after.messages} 条消息 / ≈${result.after.tokens.toLocaleString('en-US')} token`);
  lines.push(`字节降幅：${percentDrop(result.before.bytes, result.after.bytes)}；` +
    `token 降幅：${percentDrop(result.before.tokens, result.after.tokens)}`);
  lines.push(`归档：${result.archivePath}（${formatBytes(result.archive.bytes)} / ${result.archive.events} 事件）`);
  if (result.backupPath) lines.push(`备份：${result.backupPath}`);
  lines.push(`回滚：${result.rollback ?? (result.backupPath ? rollbackCommand(result.backupPath, result.sessionPath) : '（dry-run 无备份）')}`);
  if (result.log?.some((entry) => entry.step === 'failed')) {
    lines.push('日志：');
    for (const entry of result.log) {
      lines.push(`  ${entry.step}: ${entry.ok === false ? 'FAILED' : 'ok'}${entry.code ? ` (${entry.code})` : ''}`);
    }
  }
  return lines.join('\n');
}
