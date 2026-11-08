// src/memory/anchors.js — M2-A：锚点模型 / 校活 / 状态机
//
// 三种锚点（提案 §1.2，唯一允许）：
//   session_turn  { kind, sessionId, turn, seqStart, seqEnd, digest, status }
//   session_item  { kind, sessionId, turn, messageIndex? | toolCallId?, digest, status }
//   file_line     { kind, rel, lineStart, lineEnd, fileSha, status }
//
// 状态机：live（原文可读且 digest 匹配）→ stale（能定位但 digest/行号漂移）
//         → missing（原文不可达）；superseded 由上层（记录取代链）标记。
//
// digest 口径：对 turn 区间内事件做「投影后 stableStringify → sha256」，
// 投影掉截断会重编号的坐标（seq/turn/step/time/surfaceOp/…），所以同一段对话
// 在 seq 重排前后 digest 不变（提案 §1.1 设计要点）。

import crypto from 'node:crypto';

import { stableStringify } from '../codec.js';

export const ANCHOR_KINDS = Object.freeze(['session_turn', 'session_item', 'file_line']);
export const ANCHOR_STATES = Object.freeze(['live', 'stale', 'missing', 'superseded']);

const VOLATILE_KEYS = new Set([
  'seq', 'turn', 'step', 'time', 'surfaceOp',
  'startSeq', 'endSeq', 'start', 'end',
  'sourceEventSeqs', 'shadowedSeqs', 'shadowedRange', 'shadowedTokenCount',
  'messageSeqs', 'headerSeq', 'sourceEventSeq', 'throughSeq', 'compactionId',
]);

function projectValue(value) {
  if (Array.isArray(value)) return value.map(projectValue);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (VOLATILE_KEYS.has(key)) continue;
    out[key] = projectValue(value[key]);
  }
  return out;
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Deterministic digest of a turn's events.
 * Coordinate-only keys are projected out, so seq renumbering does not change it.
 */
export function turnDigest(events, seqStart, seqEnd) {
  const slice = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isInteger(event?.seq)
      && event.seq >= seqStart && event.seq <= seqEnd);
  const projected = slice.map((event) => ({
    type: event.type,
    data: projectValue(event.data ?? {}),
  }));
  return sha256Hex(stableStringify(projected));
}

export function makeSessionTurnAnchor({ sessionId, turn, seqStart, seqEnd, digest, status = 'live' }) {
  return cleanAnchor({
    kind: 'session_turn',
    sessionId,
    turn,
    seqStart,
    seqEnd,
    digest,
    status,
  });
}

export function makeSessionItemAnchor({ sessionId, turn, messageIndex, toolCallId, digest, status = 'live' }) {
  return cleanAnchor({
    kind: 'session_item',
    sessionId,
    turn,
    ...(Number.isInteger(messageIndex) ? { messageIndex } : {}),
    ...(typeof toolCallId === 'string' && toolCallId !== '' ? { toolCallId } : {}),
    digest,
    status,
  });
}

export function makeFileLineAnchor({ rel, lineStart, lineEnd, fileSha, status = 'live' }) {
  return cleanAnchor({ kind: 'file_line', rel, lineStart, lineEnd, fileSha, status });
}

function cleanAnchor(anchor) {
  const out = {};
  for (const [key, value] of Object.entries(anchor)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

export function validateAnchor(anchor) {
  const errors = [];
  if (!anchor || typeof anchor !== 'object') return { ok: false, errors: ['E_ANCHOR_NOT_OBJECT'] };
  if (!ANCHOR_KINDS.includes(anchor.kind)) errors.push('E_ANCHOR_KIND');
  if (anchor.kind === 'session_turn') {
    if (typeof anchor.sessionId !== 'string' || anchor.sessionId === '') errors.push('E_ANCHOR_SESSION');
    if (!Number.isInteger(anchor.turn) || anchor.turn < 0) errors.push('E_ANCHOR_TURN');
    if (!Number.isInteger(anchor.seqStart) || !Number.isInteger(anchor.seqEnd)) errors.push('E_ANCHOR_SEQ');
    if (typeof anchor.digest !== 'string' || !/^[0-9a-f]{64}$/.test(anchor.digest)) errors.push('E_ANCHOR_DIGEST');
  } else if (anchor.kind === 'session_item') {
    if (typeof anchor.sessionId !== 'string' || anchor.sessionId === '') errors.push('E_ANCHOR_SESSION');
    if (!Number.isInteger(anchor.turn) || anchor.turn < 0) errors.push('E_ANCHOR_TURN');
    if (!Number.isInteger(anchor.messageIndex) && (typeof anchor.toolCallId !== 'string' || anchor.toolCallId === '')) {
      errors.push('E_ANCHOR_SELECTOR');
    }
  } else if (anchor.kind === 'file_line') {
    if (typeof anchor.rel !== 'string' || anchor.rel === '' || anchor.rel.includes('..')) errors.push('E_ANCHOR_REL');
    if (!Number.isInteger(anchor.lineStart) || anchor.lineStart < 1) errors.push('E_ANCHOR_LINE');
    if (!Number.isInteger(anchor.lineEnd) || anchor.lineEnd < anchor.lineStart) errors.push('E_ANCHOR_LINE');
    if (typeof anchor.fileSha !== 'string' || !/^[0-9a-f]{64}$/.test(anchor.fileSha)) errors.push('E_ANCHOR_FILESHA');
  }
  if (anchor.status !== undefined && !ANCHOR_STATES.includes(anchor.status)) errors.push('E_ANCHOR_STATUS');
  return { ok: errors.length === 0, errors };
}

/** Locate a turn's seq window from the event list (data.turn on turn/start|turn/end). */
export function turnWindowOf(events, turn) {
  const list = Array.isArray(events) ? events : [];
  let start = -1;
  let end = -1;
  for (const event of list) {
    if (Number(event?.data?.turn) !== turn) continue;
    if (start < 0) start = event.seq;
    end = event.seq;
  }
  if (start < 0) return null;
  return { seqStart: start, seqEnd: end };
}

/**
 * Verify one anchor against the original sources.
 *
 * deps.loadSession(sessionId) -> { header, events } | null
 * deps.readFile(rel) -> string | null
 *
 * Returns { state, code, detail, digest? }.
 */
export function verifyAnchor(anchor, deps = {}) {
  const validation = validateAnchor(anchor);
  if (!validation.ok) return { state: 'missing', code: 'E_ANCHOR_INVALID', errors: validation.errors };
  if (anchor.kind === 'session_turn' || anchor.kind === 'session_item') {
    let session = null;
    try {
      session = typeof deps.loadSession === 'function' ? deps.loadSession(anchor.sessionId) : null;
    } catch {
      session = null;
    }
    if (!session || !Array.isArray(session.events)) return { state: 'missing', code: 'E_SESSION_MISSING' };
    const window = turnWindowOf(session.events, anchor.turn);
    if (window === null) return { state: 'missing', code: 'E_TURN_MISSING' };
    const digest = turnDigest(session.events, window.seqStart, window.seqEnd);
    if (typeof anchor.digest === 'string' && anchor.digest !== '') {
      if (digest === anchor.digest) {
        return { state: 'live', code: 'OK', digest, window };
      }
      // The turn is locatable but its content no longer matches the anchor: the
      // log was re-numbered/replaced (stale), and the anchor must say so.
      return { state: 'stale', code: 'E_TURN_DIGEST_MISMATCH', digest, window };
    }
    if (anchor.kind === 'session_item') {
      const selectorOk = Number.isInteger(anchor.messageIndex) || typeof anchor.toolCallId === 'string';
      return selectorOk
        ? { state: 'stale', code: 'E_ITEM_DIGEST_UNCHECKED', digest, window }
        : { state: 'missing', code: 'E_ITEM_SELECTOR_MISSING' };
    }
    return { state: 'stale', code: 'E_TURN_DIGEST_UNCHECKED', digest, window };
  }

  // file_line: hash + line range.
  let text = null;
  try {
    text = typeof deps.readFile === 'function' ? deps.readFile(anchor.rel) : null;
  } catch {
    text = null;
  }
  if (typeof text !== 'string') return { state: 'missing', code: 'E_FILE_MISSING' };
  const fileSha = sha256Hex(text);
  const lines = text.split('\n');
  if (fileSha === anchor.fileSha) return { state: 'live', code: 'OK', fileSha, lines: lines.length };
  if (anchor.lineEnd > lines.length) {
    return { state: 'missing', code: 'E_FILE_TRUNCATED', fileSha, lines: lines.length };
  }
  return { state: 'stale', code: 'E_FILE_CHANGED', fileSha, lines: lines.length };
}

/** Apply a verification result to an anchor copy (state machine write-back). */
export function applyVerification(anchor, verification) {
  const status = ANCHOR_STATES.includes(verification?.state) ? verification.state : 'missing';
  return { ...anchor, status };
}
