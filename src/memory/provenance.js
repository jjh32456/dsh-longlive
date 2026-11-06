// Card provenance: who wrote a memory card, in which turn, and when.
//
// B3 adds three frontmatter keys to every card written by this package:
//
//   source_session: <session id>      who wrote it (or `manual` / `unknown`)
//   source_turn:    <integer>         which turn of that session
//   written_at:     <ISO-8601 UTC>    when the card was written
//
// They are *extras* (unknown keys) to the card format, so they live after the
// fixed fields and survive `updateFrontmatter`. The rules are deliberately
// conservative:
//
//   * an existing value is never rewritten ("已有则保留");
//   * a value we cannot know honestly is written as `unknown` (or `manual` when
//     the caller is a human editing the store), never invented;
//   * values are single-line, because the frontmatter format is single-line.
//
// The module only builds the values; it does not know which cards exist. The
// conflict/manifest layers consume the same keys through `readProvenance`.

import { memoryError } from './paths.js';

/** Frontmatter keys owned by this module, in the order a new card writes them. */
export const SOURCE_KEYS = Object.freeze(['source_session', 'source_turn', 'written_at']);

/** No caller identity was available. A real value must never be guessed. */
export const UNKNOWN_SESSION = 'unknown';
export const UNKNOWN_TURN = 'unknown';
/** A human used the tool directly (no session/turn exists). */
export const MANUAL_SESSION = 'manual';

const MAX_SESSION_CHARS = 200;

function singleLine(key, value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (text === '') return '';
  if (text.length > MAX_SESSION_CHARS) {
    throw memoryError('E_BAD_ARGUMENT', `frontmatter 字段 ${key} 过长（>${MAX_SESSION_CHARS} 字符）`);
  }
  return text;
}

/** Normalize a session id; empty/absent becomes null, never a made-up id. */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return null;
  const text = singleLine('source_session', value);
  return text === '' ? null : text;
}

/** Normalize a turn: a non-negative integer, or null. Strings of digits work. */
export function normalizeTurn(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) ? String(number) : null;
  }
  return null;
}

function isoAt(at) {
  const date = at instanceof Date ? at : new Date(at ?? Date.now());
  if (Number.isNaN(date.getTime())) {
    throw memoryError('E_BAD_ARGUMENT', `written_at 需要合法时间，收到 ${JSON.stringify(at)}`);
  }
  return date.toISOString();
}

/**
 * Build the three values for a new write.
 *
 * `sessionId`/`turn` are optional; when the caller cannot provide them the
 * stamp stays honest with `unknown`. `at` controls `written_at`.
 */
export function sourceStamp({ sessionId = null, turn = null, at = new Date() } = {}) {
  return {
    source_session: normalizeSessionId(sessionId) ?? UNKNOWN_SESSION,
    source_turn: normalizeTurn(turn) ?? UNKNOWN_TURN,
    written_at: isoAt(at),
  };
}

/**
 * Merge a stamp into existing extras without changing any value that is
 * already there. Existing keys keep their insertion order; missing keys are
 * appended in SOURCE_KEYS order.
 */
export function stampExtras(existing = {}, { sessionId = null, turn = null, at = new Date() } = {}) {
  const extras = { ...(existing && typeof existing === 'object' ? existing : {}) };
  const fresh = sourceStamp({ sessionId, turn, at });
  for (const key of SOURCE_KEYS) {
    const current = extras[key];
    if (typeof current === 'string' && current.trim() !== '') continue;
    extras[key] = fresh[key];
  }
  return extras;
}

/** Read provenance out of parsed extras. Missing values stay null. */
export function readProvenance(extras = {}) {
  const session = typeof extras?.source_session === 'string' && extras.source_session.trim() !== ''
    ? extras.source_session.trim()
    : null;
  const turn = typeof extras?.source_turn === 'string' && extras.source_turn.trim() !== ''
    ? extras.source_turn.trim()
    : null;
  const writtenAt = typeof extras?.written_at === 'string' && extras.written_at.trim() !== ''
    ? extras.written_at.trim()
    : null;
  return {
    session,
    turn,
    written_at: writtenAt,
    complete: session !== null && turn !== null && writtenAt !== null,
  };
}
