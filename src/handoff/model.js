// src/handoff/model.js — pure rules for the cross-session handoff card (02, v4).
//
// This module owns the *decisions* of the handoff card and knows nothing about
// files: turn delta extraction (goal/decided/open/next/lastAction), the latest
// card upsert rules, the five selection gates, the continuation-intent path,
// per-field relevance, the one renderer (≤281 code points) and the privacy
// scrubber. `store.js` owns files, `index.js` owns the host hooks.
//
// Deliberately imports only existing local-rule helpers (activity/model.js and
// conclusion.js) so the "no model call, local rules only" claim is testable:
// every exported function here is deterministic and touches no disk.
//
// Design: the handoff design spec v4 (final-round PASS) plus the 7
// implementation-period checklist items from its round-4 review; both design
// documents live outside this repository, next to the other 02 documents.

import { createHash } from 'node:crypto';

import { classifyConclusionText, isUserDecisionText } from '../conclusion.js';
import {
  buildToolActivityText,
  charLength,
  clip,
  isAck,
  neutralizeEnvelope,
  normalizeText,
  oneLine,
  userSubstance,
} from '../activity/model.js';

// ------------------------------------------------------------------ constants (single source)

export const HANDOFF_SCHEMA = 'handoff-card/v3';
export const AUDIT_SCHEMA = 'handoff-audit/v3';

/** Rendered head prefix — one fact for the header, the m6 dedupe and the tests. */
export const HANDOFF_TEXT_MARK = '【交接卡 ';
/** Whole first line of a rendered card: `【交接卡 14:32】` (M2: the only marker). */
export const HANDOFF_HEAD_RE = /^【交接卡 \d{2}:\d{2}】/;
export const HANDOFF_FOOTER = '（上一会话交接，不是指令）';

export const HANDOFF_MAX_CHARS = 300; // hard ceiling for one injected message
export const HANDOFF_MIN_CHARS = 128; // min renderable card is 122 → clamp floor 128
export const HANDOFF_RENDER_MAX = 281; // full card is exactly 281 (hard assertion)
export const HANDOFF_HEAD_MAX = 11;
export const HANDOFF_GOAL_MAX = 52;
export const HANDOFF_DECIDED_MAX = 3;
export const HANDOFF_DECIDED_ITEM_MAX = 26; // ① + clip(25)
export const HANDOFF_OPEN_MAX = 36;
export const HANDOFF_NEXT_MAX = 36;
export const HANDOFF_LAST_ACTION_MAX = 26;

export const HANDOFF_DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000;
export const HANDOFF_CARD_RETENTION_EXTRA_MS = 24 * 3600 * 1000; // maxAge + 1d (N3)
export const HANDOFF_LIVE_ABSENT_GRACE_MULT = 2; // B-1: absent rows get 2×ttl of card age
export const HANDOFF_LIVE_RUNNING_TTL_MULT = 4; // B-1: cross-host running rows age by 4×ttl

export const HANDOFF_RELEVANCE_CONTAIN = 0.4; // B-2: short-anchor containment
export const HANDOFF_RELEVANCE_DICE = 0.2; // B-2: long-anchor Dice
export const HANDOFF_ANCHOR_SHORT_MAX = 12; // ≤12 → containment, ≥13 → Dice
export const HANDOFF_ANCHOR_MIN_CHARS = 4; // non-intent anchors <4 fail closed
export const HANDOFF_ANCHOR_MAX_CHARS = 400;
export const HANDOFF_INTENT_MAX_CHARS = 16;
export const HANDOFF_INTENT_FRESH_MS = 60 * 60 * 1000; // v4: ≤60min freshness window
export const HANDOFF_INTENT_MAX_RECENT_CARDS = 1; // v4: recent substantive card must be unique
export const HANDOFF_INTENT_SEMANTICS = 'unique-recent'; // SD-1 S-A default; 'latest' needs sign-off
export const HANDOFF_MIN_SUBSTANCE_CHARS = 24;
export const HANDOFF_MAX_CLAIM_ATTEMPTS = 8;
export const HANDOFF_CLAIM_GRACE_MS = 5000;
export const HANDOFF_TRIM_MIN_INTERVAL_MS = 60 * 1000;
export const HANDOFF_TRIM_ARCHIVE_TAIL_BYTES = 64 * 1024;
export const CLOCK_TOLERANCE_MS = 5000;

export const HANDOFF_CIRCLED = Object.freeze(['①', '②', '③']);

// §7 decided line: one prefix and a 3-code-point separator between items.
// Accounting and rendering read these same two constants (no second copy).
const DECIDED_PREFIX = '已结论：';
const DECIDED_SEPARATOR = ' / ';

/** Continuation-intent vocabulary (B-2: ACK table widened, ≤16 code points only). */
export const HANDOFF_CONTINUATION_WORDS = Object.freeze([
  '继续', '接着', '刚才', '上面', '上一轮', '上一回', '那个', '回到', '重来', '往下', '然后',
  '再继续', '继续吧', '接着来', '接着做', '继续做', '还有呢', '还有',
]);

/** M1: this regex MUST stay legal ECMAScript (v3 shipped `\b?` = SyntaxError). */
export const HANDOFF_TRIVIAL_GOAL_RE = /^(?:只回复|回复.{0,8}个?字|你好|hi|测试|外派测试|收到|好的|ok)(?![A-Za-z0-9])/i;

const COMPLETED_RE = /(?:已完成|完成|搞定|收工|全部通过|没有下一步|都做完了)/;
const NOT_DONE_RE = /(?:未完成|没完成|没有完成|尚未|还没)/;
const OPEN_SIGNAL_RE = /(?:待定|未定|待确认|需要确认|卡在|阻塞|不确定)/;
const NEXT_START_RE = /^(?:下一步|接下来|然后)/;

// §6.5 strict assistant decision gate (N4). `结论是` is deliberately excluded.
const STRICT_START = /^(?:那么?|那|好[，,]?|行[，,]?|嗯[，,]?\s*)?(?:决定|拍板|敲定|定稿|就这么|就这样|定了|最终方案|最后决定)/u;
const STRICT_REJECT = /(?:如果|要是|若是|要么|建议|商量|考虑|同意|是否|要不要|行不行|好不好|可能|也许|假设|待定|再定|没定|决定权|由你决定|你来决定|取决于|吗\s*[？?]?$|[？?]\s*$)/u;

// §6.6 privacy scrubbers (the domain list; the PII/key gate is injected).
const SENSITIVE_DOMAIN_RE = /(?:体检|病历|诊断|工资|薪资|年终奖|银行卡|身份证|护照|住址|收货地址|密码|验证码|生日|私钥|api[_-]?key|access[_-]?token|secret)/i;
const RELATION_DOMAIN_RE = /(?:我|你)(?:的)?(?:老婆|老公|媳妇|丈夫|孩子|儿子|女儿|爸|妈|家人|父母|女朋友|男朋友)/;

const ACTIVE_SESSION_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// ------------------------------------------------------------------ tiny helpers

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function charLengthOf(value) {
  return charLength(value);
}

export function sha1Hex(value) {
  return createHash('sha1').update(String(value ?? ''), 'utf8').digest('hex');
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/** 8-hex audit/panel digest (cwdHash / goalHash). */
export function hash8(value) {
  return sha256Hex(value).slice(0, 8);
}

/** `sha1(sessionId|turn)[:12]` — the per-card claim/audit identity. */
export function cardIdOf({ sessionId, turn } = {}) {
  const turnNumber = Number.isInteger(turn) ? turn : 0;
  return sha1Hex(`${String(sessionId ?? '')}|${turnNumber}`).slice(0, 12);
}

/** M4 idempotency key for one audit line: `sha1(normalize(line))[:16]`. */
export function lineHashOf(rawLine) {
  return sha1Hex(normalizeText(String(rawLine ?? ''))).slice(0, 16);
}

export function isActiveSessionId(value) {
  return typeof value === 'string' && ACTIVE_SESSION_RE.test(value);
}

/**
 * Windows absolute path → lowercase, backslash-separated, no trailing separator.
 * Only `X:\...` is accepted: UNC, relative, device and non-string values are
 * rejected (fail-closed for the cwd gate).
 */
export function normalizeCwd(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.includes('\0')) return null;
  if (/^(?:\\\\|\/\/)/.test(trimmed)) return null; // UNC share
  if (!/^[A-Za-z]:[\\/]/.test(trimmed)) return null; // drive-letter absolute only
  const unified = trimmed.replace(/\//g, '\\').replace(/\\{2,}/g, '\\').toLowerCase();
  if (/^[a-z]:\\$/.test(unified)) return unified; // drive root keeps its separator
  return unified.replace(/\\+$/u, '');
}

/** M1: legal ECMAScript; tested against Node v24.21.0 boundaries. */
export function isTrivialGoal(goal) {
  return HANDOFF_TRIVIAL_GOAL_RE.test(oneLine(goal));
}

// ------------------------------------------------------------------ text extraction (§6.5)

function sentencesOf(value) {
  const text = oneLine(value);
  if (text === '') return [];
  return text
    .split(/(?<=[。！？!?；;])/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function lastSentenceOf(value) {
  const list = sentencesOf(value);
  if (list.length > 0) return list[list.length - 1];
  return oneLine(value);
}

/** Strict assistant-side decision gate (N4). Exported so V14 locks it down. */
export function strictAssistantDecision(sentence) {
  const value = oneLine(sentence);
  if (value === '') return false;
  if (charLength(value) > 120) return false;
  if (value.includes('结论是')) return false;
  if (!STRICT_START.test(value)) return false;
  if (STRICT_REJECT.test(value)) return false;
  return true;
}

/**
 * The turn's decided items: user decision sentences (narrow `isUserDecisionText`
 * rule) plus assistant sentences that pass the strict gate. Text is stored
 * clipped to 25 code points; the caller sanitizes before merging.
 */
export function extractDecided(userText, assistantText, turn) {
  const turnNumber = Number.isInteger(turn) ? turn : 0;
  const out = [];
  const seen = new Set();
  const push = (sentence, src) => {
    const text = clip(oneLine(sentence), HANDOFF_DECIDED_ITEM_MAX - 1);
    if (text === '') return;
    const key = normalizeText(text);
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    out.push({ text, src, turn: turnNumber });
  };
  for (const sentence of sentencesOf(userText)) {
    if (isUserDecisionText(sentence)) push(sentence, 'user');
  }
  for (const sentence of sentencesOf(assistantText)) {
    if (classifyConclusionText(sentence) !== 'decision') continue;
    if (strictAssistantDecision(sentence)) push(sentence, 'marker');
  }
  return out;
}

/** `completed` = the assistant's last sentence says the work finished (N10). */
export function completedFromAssistant(assistantText) {
  const last = lastSentenceOf(assistantText);
  if (last === '' || /[？?]/.test(last)) return false;
  if (NOT_DONE_RE.test(last)) return false;
  return COMPLETED_RE.test(last);
}

/** open/next rules (§6.5): a question or a pending marker becomes 未决; else none. */
export function openNextFromAssistant(assistantText) {
  const last = lastSentenceOf(assistantText);
  if (last === '') return { open: '', next: '' };
  const isQuestion = /[？?]/.test(last);
  const hasPending = OPEN_SIGNAL_RE.test(last);
  const open = isQuestion || hasPending ? clip(last, HANDOFF_OPEN_MAX) : '';
  if (NEXT_START_RE.test(last)) return { open, next: clip(last, HANDOFF_NEXT_MAX) };
  return { open, next: open === '' ? '' : clip(`续：${open}`, HANDOFF_NEXT_MAX) };
}

/** sha1(normalize(goal|decided texts|open|next))[:12] — M3: no lastAction. */
export function contentHashOf({ goal = '', decided = [], open = '', next = '' } = {}) {
  const parts = [goal, ...(Array.isArray(decided) ? decided.map((item) => item?.text ?? '') : []), open, next];
  return sha1Hex(normalizeText(parts.join('|'))).slice(0, 12);
}

/**
 * The turn's incremental card delta (pure). `at` is an ISO string for the
 * `turn/end` instant; privacy scrubbing happens in index.js before merging.
 */
export function buildCardDelta({ turn, userText, assistantText, tool, completed } = {}) {
  const turnNumber = Number.isInteger(turn) ? turn : 0;
  const goal = clip(userSubstance(userText), HANDOFF_GOAL_MAX);
  const decided = extractDecided(userText, assistantText, turnNumber);
  const finished = completed === undefined ? completedFromAssistant(assistantText) : completed === true;
  const { open: rawOpen, next: rawNext } = openNextFromAssistant(assistantText);
  const open = finished ? '' : rawOpen;
  const next = finished ? '' : rawNext;
  const lastAction = clip(buildToolActivityText(tool), HANDOFF_LAST_ACTION_MAX);
  const substantiveChars = charLength(goal) + charLength(open) + charLength(next)
    + decided.reduce((sum, item) => sum + charLength(item.text), 0);
  return {
    turn: turnNumber,
    goal,
    decided,
    open,
    next,
    lastAction,
    completed: finished,
    substantiveChars,
    contentHash: contentHashOf({ goal, decided, open, next }),
  };
}

// ------------------------------------------------------------------ latest-card upsert (§6.2)

/** N10 minimum substance gate used by both the producer and the consumer. */
export function cardSubstantive(card) {
  const goalLength = charLength(card?.goal);
  const decided = Array.isArray(card?.decided) ? card.decided : [];
  const substantiveChars = goalLength + charLength(card?.open) + charLength(card?.next)
    + decided.reduce((sum, item) => sum + charLength(item?.text), 0);
  const completedTurns = Number.isInteger(card?.source?.completedTurns) ? card.source.completedTurns : 0;
  const gateA = completedTurns >= 2 || decided.length >= 1 || goalLength >= 12;
  const gateB = substantiveChars >= HANDOFF_MIN_SUBSTANCE_CHARS;
  const trivial = completedTurns < 2 && decided.length === 0 && isTrivialGoal(card?.goal);
  return gateA && gateB && !trivial;
}

function dedupeDecided(decided) {
  const byKey = new Map();
  for (const item of Array.isArray(decided) ? decided : []) {
    if (!item || typeof item.text !== 'string') continue;
    const text = clip(oneLine(item.text), HANDOFF_DECIDED_ITEM_MAX - 1);
    if (text === '') continue;
    const key = normalizeText(text);
    if (key === '') continue;
    // Last occurrence wins (a later turn re-states the same decision).
    byKey.set(key, {
      text,
      src: item.src === 'user' ? 'user' : 'marker',
      turn: Number.isInteger(item.turn) ? item.turn : 0,
    });
  }
  return [...byKey.values()]
    .sort((left, right) => left.turn - right.turn)
    .slice(-HANDOFF_DECIDED_MAX);
}

/**
 * Merge one turn delta into the session's latest card.
 *
 * Returns `{changed, replay, empty, trivial, completed, card}`. `changed:false`
 * means the content hash is unchanged (M3: lastAction excluded) and the caller
 * must write nothing at all — not even refresh `at`.
 */
export function mergeLatestCard(oldCard, delta = {}) {
  if (oldCard && Number.isInteger(oldCard.turn) && oldCard.turn >= (Number.isInteger(delta.turn) ? delta.turn : 0)) {
    return { changed: false, replay: true, empty: false, trivial: false, completed: false, card: oldCard };
  }
  const decided = dedupeDecided([...(Array.isArray(oldCard?.decided) ? oldCard.decided : []), ...(Array.isArray(delta.decided) ? delta.decided : [])]);
  const goal = delta.goal !== undefined && delta.goal !== '' ? clip(oneLine(delta.goal), HANDOFF_GOAL_MAX) : (oldCard?.goal ?? '');
  const completed = delta.completed === true;
  const deltaOpen = oneLine(delta.open ?? '');
  const deltaNext = oneLine(delta.next ?? '');
  const open = completed && deltaOpen === ''
    ? ''
    : (deltaOpen !== '' ? clip(deltaOpen, HANDOFF_OPEN_MAX) : (oldCard?.open ?? ''));
  const next = completed && deltaNext === ''
    ? ''
    : (deltaNext !== '' ? clip(deltaNext, HANDOFF_NEXT_MAX) : (oldCard?.next ?? ''));
  const lastAction = delta.lastAction !== undefined && delta.lastAction !== ''
    ? clip(oneLine(delta.lastAction), HANDOFF_LAST_ACTION_MAX)
    : (oldCard?.lastAction ?? '');
  const completedTurns = Number.isInteger(delta.completedTurns)
    ? delta.completedTurns
    : (Number.isInteger(oldCard?.source?.completedTurns) ? oldCard.source.completedTurns : 0) + 1;
  const at = typeof delta.at === 'string' && delta.at !== ''
    ? delta.at
    : (oldCard?.at ?? new Date().toISOString());
  const source = {
    sessionId: delta.sessionId ?? oldCard?.source?.sessionId ?? '',
    cwd: delta.cwd ?? oldCard?.source?.cwd ?? '',
    cwdHash: delta.cwdHash ?? oldCard?.source?.cwdHash ?? '',
    firstTurn: Number.isInteger(oldCard?.source?.firstTurn) ? oldCard.source.firstTurn : (Number.isInteger(delta.turn) ? delta.turn : 0),
    completedTurns,
  };
  const contentHash = contentHashOf({ goal, decided, open, next });
  const substantiveChars = charLength(goal) + charLength(open) + charLength(next)
    + decided.reduce((sum, item) => sum + charLength(item.text), 0);
  const card = {
    schema: HANDOFF_SCHEMA,
    source,
    goal,
    decided,
    open,
    next,
    lastAction,
    turn: Number.isInteger(delta.turn) ? delta.turn : 0,
    at,
    contentHash,
    substantiveChars,
  };
  const empty = goal === '' && decided.length === 0 && next === '' && open === '';
  const trivial = completedTurns < 2 && decided.length === 0 && (charLength(goal) < 8 || isTrivialGoal(goal));
  const changed = !oldCard || typeof oldCard.contentHash !== 'string' || oldCard.contentHash !== contentHash;
  if (!changed) {
    // M3: content unchanged → the caller writes NOTHING, so `at` and lastAction
    // must not be refreshed even in the returned object (an ACK turn with a tool
    // action must not make an old card look newer). completedTurns still counts.
    card.at = oldCard.at;
    card.lastAction = oldCard.lastAction;
  }
  return { changed, replay: false, empty, trivial, completed, card };
}

// ------------------------------------------------------------------ relevance gate (§6.3.2)

function bigramCounts(normalized) {
  const chars = Array.from(normalized);
  const counts = new Map();
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = chars[index] + chars[index + 1];
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function countOverlap(anchorCounts, fieldNormalized) {
  const chars = Array.from(fieldNormalized);
  const remaining = new Map(anchorCounts);
  let overlap = 0;
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = chars[index] + chars[index + 1];
    const available = remaining.get(gram) ?? 0;
    if (available > 0) {
      overlap += 1;
      remaining.set(gram, available - 1);
    }
  }
  return overlap;
}

/** Card fields scored by the relevance gate (never concatenated — per-field max). */
export function relevanceFieldsOf(card) {
  const fields = [];
  const push = (name, value) => {
    const normalized = normalizeText(value);
    if (normalized !== '') fields.push({ name, normalized });
  };
  push('goal', card?.goal);
  push('next', card?.next);
  push('open', card?.open);
  const decided = Array.isArray(card?.decided) ? card.decided : [];
  decided.forEach((item, index) => push(`decided${index + 1}`, item?.text));
  return fields;
}

/** `>=` semantics (the acceptance boundary tests pin 0.40/0.20). */
export function passesRelevanceThreshold(score, threshold) {
  return Number.isFinite(score) && Number.isFinite(threshold) && score >= threshold;
}

/**
 * Per-field relevance of the first real user message against one card.
 * Literal containment wins first (anchor ≥4), then short-anchor containment
 * (≤12) or long-anchor Dice (≥13). Returns `{kind, score, field, threshold, pass, code}`.
 */
export function relevanceOf(anchorText, card, options = {}) {
  const containThreshold = clampNumber(options.containShort, HANDOFF_RELEVANCE_CONTAIN, 0.2, 0.8);
  const diceThreshold = clampNumber(options.diceLong, HANDOFF_RELEVANCE_DICE, 0.1, 0.6);
  const anchor = normalizeText(oneLine(anchorText));
  const anchorLength = charLength(anchor);
  if (anchorLength === 0) {
    return { kind: 'none', score: 0, field: null, threshold: containThreshold, pass: false, code: 'E_HANDOFF_NO_ANCHOR' };
  }
  if (anchorLength > HANDOFF_ANCHOR_MAX_CHARS) {
    return { kind: 'none', score: 0, field: null, threshold: containThreshold, pass: false, code: 'E_HANDOFF_ANCHOR_TOO_LONG' };
  }
  const fields = relevanceFieldsOf(card);
  if (anchorLength >= HANDOFF_ANCHOR_MIN_CHARS) {
    const literal = fields.find((field) => field.normalized.includes(anchor));
    if (literal) {
      return { kind: 'literal', score: 1, field: literal.name, threshold: 0, pass: true };
    }
  }
  if (anchorLength < HANDOFF_ANCHOR_MIN_CHARS) {
    return { kind: 'none', score: 0, field: null, threshold: containThreshold, pass: false, code: 'E_HANDOFF_ANCHOR_TOO_SHORT' };
  }
  const kind = anchorLength <= HANDOFF_ANCHOR_SHORT_MAX ? 'containment' : 'dice';
  const threshold = kind === 'containment' ? containThreshold : diceThreshold;
  const anchorCounts = bigramCounts(anchor);
  const denominator = Math.max(1, anchorLength - 1);
  let best = { score: 0, field: null };
  for (const field of fields) {
    const overlap = countOverlap(anchorCounts, field.normalized);
    const score = kind === 'containment'
      ? overlap / denominator
      : (2 * overlap) / (denominator + Math.max(0, charLength(field.normalized) - 1));
    if (score > best.score) best = { score, field: field.name };
  }
  const pass = passesRelevanceThreshold(best.score, threshold);
  return {
    kind,
    score: best.score,
    field: best.field,
    threshold,
    pass,
    code: pass ? undefined : 'E_HANDOFF_IRRELEVANT',
  };
}

/** B-2 continuation intent: ACK or a short continuation word (≤16 code points). */
export function isContinuationIntent(anchorText) {
  const normalized = normalizeText(oneLine(anchorText));
  const length = charLength(normalized);
  if (length === 0 || length > HANDOFF_INTENT_MAX_CHARS) return false;
  if (isAck(anchorText)) return true;
  return HANDOFF_CONTINUATION_WORDS.some((word) => normalized.includes(word));
}

// ------------------------------------------------------------------ intent path (§6.3.3)

/**
 * v4 intent path decision. Cards must already have passed gates 0–4
 * (schema/self/time/cwd/live). MAJOR-2 fix: a thin-only candidate set returns
 * `E_HANDOFF_CARD_TOO_THIN` explicitly (not STALE); a stale/multi set returns
 * STALE/AMBIGUOUS and the caller falls back to the relevance gate.
 */
export function intentPathDecision({ cards, anchorText, nowMs, freshMs, cardSubstantiveFn, intentSemantics } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const freshWindow = Number.isFinite(freshMs) ? freshMs : HANDOFF_INTENT_FRESH_MS;
  const isSubstantive = typeof cardSubstantiveFn === 'function' ? cardSubstantiveFn : cardSubstantive;
  const substantive = list.filter((card) => isSubstantive(card));
  if (list.length > 0 && substantive.length === 0) {
    return { eligible: false, code: 'E_HANDOFF_CARD_TOO_THIN', fresh: false, recentN: 0, uniqueCardId: null };
  }
  const withAge = substantive.map((card) => {
    const atMs = Date.parse(String(card?.at ?? ''));
    return { card, atMs };
  }).filter((item) => Number.isFinite(item.atMs));
  const freshCards = withAge.filter((item) => now - item.atMs <= freshWindow);
  const recentN = freshCards.length;
  // SD-1 S-B ('latest') is an explicit non-default configuration: it still
  // requires the ≤fresh window, but drops the uniqueness requirement.
  if (intentSemantics === 'latest') {
    if (recentN === 0) {
      return { eligible: false, code: 'E_HANDOFF_INTENT_STALE', fresh: false, recentN: 0, uniqueCardId: null };
    }
    const sorted = [...freshCards].sort((left, right) => right.atMs - left.atMs);
    return {
      eligible: true,
      code: null,
      fresh: true,
      recentN,
      uniqueCardId: sorted[0]?.card?.cardId ?? sorted[0]?.cardId ?? null,
      semantics: 'latest',
    };
  }
  if (recentN === 0) {
    return { eligible: false, code: 'E_HANDOFF_INTENT_STALE', fresh: false, recentN: 0, uniqueCardId: null };
  }
  if (recentN >= 2) {
    return { eligible: false, code: 'E_HANDOFF_INTENT_AMBIGUOUS', fresh: true, recentN, uniqueCardId: null };
  }
  const only = freshCards[0].card;
  return {
    eligible: true,
    code: null,
    fresh: true,
    recentN: 1,
    uniqueCardId: only?.cardId ?? null,
    semantics: HANDOFF_INTENT_SEMANTICS,
  };
}

// ------------------------------------------------------------------ live gate (§6.3.1, B-1)

/**
 * v4 liveness gate: read the **declared** state first; only while it is
 * `running` does `pidAlive` decide. `effectiveState` is observation only and
 * must never be used as a release criterion.
 *
 * Input shape is `store.readLiveRow` output:
 *   {status:'ok', live:{state,pidAlive,sameHost,ttlMs,heartbeatAgeMs,effectiveState}}
 *   {status:'absent'} | {status:'unreadable', code}
 */
export function evaluateLiveGate(row, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cardAtMs = Number.isFinite(options.cardAtMs) ? options.cardAtMs : 0;
  if (!row || row.status === 'unreadable') {
    return {
      pass: false,
      code: 'E_HANDOFF_LIVE_UNREADABLE',
      kind: 'unreadable',
      state: null,
      ageMs: null,
      pidAlive: null,
      sameHost: null,
      ttlMs: null,
      effectiveState: null,
      decision: 'skip',
    };
  }
  if (row.status === 'absent') {
    const ttlMs = 60_000; // no row → no row-local ttl
    const pass = cardAtMs <= nowMs - HANDOFF_LIVE_ABSENT_GRACE_MULT * ttlMs;
    return {
      pass,
      code: pass ? null : 'E_HANDOFF_LIVE_ABSENT_TOO_NEW',
      kind: 'absent',
      state: null,
      ageMs: null,
      pidAlive: null,
      sameHost: null,
      ttlMs,
      effectiveState: null,
      decision: pass ? 'pass' : 'skip',
    };
  }
  const live = row.live ?? {};
  const ttlMs = Number.isInteger(live.ttlMs) && live.ttlMs > 0 ? live.ttlMs : 60_000;
  const ageMs = Number.isFinite(live.heartbeatAgeMs) ? live.heartbeatAgeMs : null;
  const state = typeof live.state === 'string' ? live.state : null;
  const pidAlive = live.pidAlive === undefined ? undefined : live.pidAlive;
  const observed = {
    state,
    ageMs,
    pidAlive,
    sameHost: typeof live.sameHost === 'boolean' ? live.sameHost : null,
    ttlMs,
    effectiveState: typeof live.effectiveState === 'string' ? live.effectiveState : null,
  };
  if (state === 'running') {
    if (pidAlive === true) {
      return { pass: false, code: 'E_HANDOFF_SOURCE_ALIVE', kind: 'live', ...observed, decision: 'skip' }; // 3a
    }
    if (pidAlive === null) {
      // 3b: cross-host / unknown pid → heartbeat only; >4×ttl means finished.
      const pass = ageMs !== null && ageMs > HANDOFF_LIVE_RUNNING_TTL_MULT * ttlMs;
      return {
        pass,
        code: pass ? null : 'E_HANDOFF_SOURCE_ALIVE',
        kind: 'live',
        ...observed,
        decision: pass ? 'pass' : 'skip',
      };
    }
    if (pidAlive === false) {
      return { pass: true, code: null, kind: 'live', ...observed, decision: 'pass' }; // 3c
    }
    // 3d: unknown shape = cannot judge = fail closed.
    return { pass: false, code: 'E_HANDOFF_SOURCE_ALIVE', kind: 'live', ...observed, decision: 'skip' };
  }
  // 3e: idle / waiting / blocked / any future declared state → finished turn.
  return { pass: true, code: null, kind: 'live', ...observed, decision: 'pass' };
}

// ------------------------------------------------------------------ candidate selection (§6.3)

function sortByScoreThenAt(left, right) {
  const scoreDiff = (right.relevance?.score ?? 0) - (left.relevance?.score ?? 0);
  if (scoreDiff !== 0) return scoreDiff;
  const atDiff = (right.atMs ?? 0) - (left.atMs ?? 0);
  if (atDiff !== 0) return atDiff;
  return String(left.cardId ?? '').localeCompare(String(right.cardId ?? ''));
}

function gateSchema(card) {
  if (!card || typeof card !== 'object') return 'E_HANDOFF_CORRUPT';
  if (card.schema !== HANDOFF_SCHEMA) return 'E_HANDOFF_CORRUPT';
  if (!card.source || typeof card.source !== 'object') return 'E_HANDOFF_CORRUPT';
  if (!isActiveSessionId(String(card.source.sessionId ?? ''))) return 'E_HANDOFF_CORRUPT';
  if (typeof card.contentHash !== 'string' || card.contentHash === '') return 'E_HANDOFF_CORRUPT';
  if (!Number.isFinite(Date.parse(String(card.at ?? '')))) return 'E_HANDOFF_CORRUPT';
  return null;
}

function skippedOf(code) {
  if (!code) return 'irrelevant';
  if (code === 'E_HANDOFF_CORRUPT') return 'corrupt';
  if (code === 'E_HANDOFF_SELF') return 'self';
  if (code === 'E_HANDOFF_EXPIRED') return 'expired';
  if (code === 'E_HANDOFF_CLOCK_FUTURE') return 'clock-future';
  return 'irrelevant';
}

function primaryCodeFromTrace(trace) {
  // Prefer the most informative non-corrupt code; corrupt/self/expired are
  // per-candidate facts, so the first candidate's code is the honest summary.
  for (const entry of trace) {
    if (entry.code) return entry.code;
  }
  return 'E_HANDOFF_IRRELEVANT';
}

/**
 * Five-gate card selection (§6.3). Pure: `liveOf(sessionId)` is injected and
 * must return the `readLiveRow` shape. Returns the chosen card, the ranked
 * candidates for the claim loop, the intent observation and a per-candidate
 * trace for the audit row.
 */
export function selectCandidate(input = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(input.maxAgeMs) ? input.maxAgeMs : HANDOFF_DEFAULT_MAX_AGE_MS;
  const liveOf = typeof input.liveOf === 'function' ? input.liveOf : () => ({ status: 'absent' });
  const selfCwd = normalizeCwd(input.selfCwd);
  const selfSessionId = String(input.selfSessionId ?? '');
  const anchorText = String(input.anchorText ?? '');
  const containShort = clampNumber(input.relevanceContainShort, HANDOFF_RELEVANCE_CONTAIN, 0.2, 0.8);
  const diceLong = clampNumber(input.relevanceDiceLong, HANDOFF_RELEVANCE_DICE, 0.1, 0.6);
  const intentEnabled = input.intentBypass !== false;
  const cards = Array.isArray(input.cards) ? input.cards : [];

  const trace = [];
  const passed = [];
  for (const entry of cards) {
    const card = entry && entry.card ? entry.card : entry;
    const fileSessionId = entry?.fileSessionId ?? null;
    const cardId = entry?.cardId ?? cardIdOf({ sessionId: card?.source?.sessionId, turn: card?.turn });
    const item = {
      sessionId: card?.source?.sessionId ?? null,
      cardId,
      code: null,
      skipped: null,
      gates: { cwd: false, live: null, relevance: null },
    };
    trace.push(item);

    let code = gateSchema(card);
    if (!code && fileSessionId && card.source.sessionId !== fileSessionId) code = 'E_HANDOFF_CORRUPT';
    if (code) {
      item.code = code;
      item.skipped = 'corrupt';
      continue;
    }
    // gate 1: never hand a session its own card back.
    if (selfSessionId !== '' && card.source.sessionId === selfSessionId) {
      item.code = 'E_HANDOFF_SELF';
      item.skipped = 'self';
      continue;
    }
    // gate 2: time.
    const atMs = Date.parse(card.at);
    if (atMs > nowMs + CLOCK_TOLERANCE_MS) {
      item.code = 'E_HANDOFF_CLOCK_FUTURE';
      item.skipped = 'clock-future';
      continue;
    }
    if (nowMs - atMs > maxAgeMs) {
      item.code = 'E_HANDOFF_EXPIRED';
      item.skipped = 'expired';
      continue;
    }
    // gate 3: cwd.
    const cardCwd = normalizeCwd(card.source?.cwd);
    if (cardCwd === null || selfCwd === null) {
      item.code = 'E_HANDOFF_NO_CWD';
      item.skipped = 'irrelevant';
      continue;
    }
    if (cardCwd !== selfCwd) {
      item.code = 'E_HANDOFF_CWD';
      item.skipped = 'irrelevant';
      continue;
    }
    item.gates.cwd = true;
    // gate 4: liveness (declared state first; effectiveState is observation only).
    const liveRow = liveOf(card.source.sessionId);
    const liveDecision = evaluateLiveGate(liveRow, { nowMs, cardAtMs: atMs });
    item.gates.live = {
      kind: liveDecision.kind,
      ageMs: liveDecision.ageMs,
      state: liveDecision.state,
      pidAlive: liveDecision.pidAlive,
      sameHost: liveDecision.sameHost,
      ttlMs: liveDecision.ttlMs,
      effectiveState: liveDecision.effectiveState,
      decision: liveDecision.decision,
    };
    if (!liveDecision.pass) {
      item.code = liveDecision.code;
      item.skipped = 'irrelevant';
      continue;
    }
    passed.push({ card, cardId, atMs, fileSessionId, trace: item });
  }

  const fail = (code, intent, scored) => {
    if (Array.isArray(scored)) {
      for (const entry of scored) {
        if (entry.p && entry.rel) entry.p.trace.gates.relevance = { ...entry.rel, intent };
      }
    }
    return { card: null, cardId: null, code, skipped: skippedOf(code), intent, ranked: [], trace };
  };

  if (passed.length === 0) {
    return { card: null, cardId: null, code: primaryCodeFromTrace(trace), skipped: skippedOf(primaryCodeFromTrace(trace)), intent: null, ranked: [], trace };
  }

  // gate 5: relevance / substance / continuation-intent.
  const anchorNormalized = normalizeText(oneLine(anchorText));
  const anchorLength = charLength(anchorNormalized);
  if (anchorLength === 0) return fail('E_HANDOFF_NO_ANCHOR', null, null);
  if (anchorLength > HANDOFF_ANCHOR_MAX_CHARS) return fail('E_HANDOFF_ANCHOR_TOO_LONG', null, null);

  const intent = intentEnabled && isContinuationIntent(anchorText);
  const intentInfo = {
    path: intent,
    fresh: false,
    unique: false,
    recentN: 0,
    code: null,
    fallbackCode: null,
    semantics: input.intentSemantics === 'latest' ? 'latest' : HANDOFF_INTENT_SEMANTICS,
  };
  const ranked = [];

  if (intent) {
    const decision = intentPathDecision({
      // The decision object identifies the card by `cardId`, which is derived
      // from the file name/turn at read time and is not stored inside the JSON.
      cards: passed.map((entry) => ({ ...entry.card, cardId: entry.cardId })),
      anchorText,
      nowMs,
      freshMs: input.intentFreshMs,
      intentSemantics: input.intentSemantics,
    });
    intentInfo.fresh = decision.fresh === true;
    intentInfo.unique = decision.eligible === true;
    intentInfo.recentN = Number.isInteger(decision.recentN) ? decision.recentN : 0;
    intentInfo.code = decision.code ?? null;
    if (decision.eligible) {
      const match = passed.find((entry) => entry.cardId === decision.uniqueCardId)
        ?? passed.find((entry) => entry.card === decision.uniqueCardId)
        ?? passed[0];
      const relevance = {
        kind: 'intent',
        score: 1,
        field: null,
        threshold: null,
        pass: true,
        intent: { fresh: true, unique: true, recentN: 1 },
      };
      match.trace.gates.relevance = relevance;
      ranked.push({ card: match.card, cardId: match.cardId, atMs: match.atMs, fileSessionId: match.fileSessionId, relevance });
      return { card: ranked[0].card, cardId: ranked[0].cardId, relevance, intent: intentInfo, ranked, trace };
    }
    // Not eligible → fall back to the relevance gate (B-2 3b: prefer a miss).
    const substantive = passed.filter((entry) => cardSubstantive(entry.card));
    if (substantive.length === 0) {
      return fail('E_HANDOFF_CARD_TOO_THIN', intentInfo, null);
    }
    const scored = substantive.map((entry) => ({
      p: entry,
      rel: relevanceOf(anchorText, entry.card, { containShort, diceLong }),
    })).sort(sortByScoreThenAt);
    intentInfo.fallbackCode = scored[0]?.rel?.code ?? null;
    const passing = scored.filter((entry) => entry.rel.pass === true);
    if (passing.length === 0) {
      // MAJOR-2 priority: intent-path code wins when the fallback also fails,
      // and the audit carries both codes (intent.code + relevance.fallbackCode).
      return fail(decision.code ?? scored[0]?.rel?.code ?? 'E_HANDOFF_IRRELEVANT', intentInfo, scored);
    }
    for (const entry of passing) {
      entry.p.trace.gates.relevance = { ...entry.rel, intent: intentInfo };
      ranked.push({ card: entry.p.card, cardId: entry.p.cardId, atMs: entry.p.atMs, fileSessionId: entry.p.fileSessionId, relevance: entry.rel });
    }
    return { card: ranked[0].card, cardId: ranked[0].cardId, relevance: ranked[0].relevance, intent: intentInfo, ranked, trace };
  }

  const substantive = passed.filter((entry) => cardSubstantive(entry.card));
  if (substantive.length === 0) {
    return fail('E_HANDOFF_CARD_TOO_THIN', intentInfo, null);
  }
  const scored = substantive.map((entry) => ({
    p: entry,
    rel: relevanceOf(anchorText, entry.card, { containShort, diceLong }),
  })).sort(sortByScoreThenAt);
  const passing = scored.filter((entry) => entry.rel.pass === true);
  if (passing.length === 0) {
    return fail(scored[0]?.rel?.code ?? 'E_HANDOFF_IRRELEVANT', intentInfo, scored);
  }
  for (const entry of passing) {
    entry.p.trace.gates.relevance = { ...entry.rel, intent: intentInfo };
    ranked.push({ card: entry.p.card, cardId: entry.p.cardId, atMs: entry.p.atMs, fileSessionId: entry.p.fileSessionId, relevance: entry.rel });
  }
  return { card: ranked[0].card, cardId: ranked[0].cardId, relevance: ranked[0].relevance, intent: intentInfo, ranked, trace };
}

// ------------------------------------------------------------------ renderer (§7, N5)

function formatHhmm(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '00:00';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * The only renderer. One hidden message, ≤281 code points for a full card,
 * footer never dropped, priority fill: head → footer → 目标 → 下一步 → 未决 →
 * 已结论① → 最近 → 已结论②③. No field is ever cut in half; every line and
 * every ` / `-separated item is charged its exact charLength (§7/N5).
 */
export function renderHandoffCard(card, options = {}) {
  const configured = clampNumber(options.maxChars, HANDOFF_MAX_CHARS, HANDOFF_MIN_CHARS, HANDOFF_MAX_CHARS);
  const budget = Math.min(configured, HANDOFF_RENDER_MAX);
  const atMs = Date.parse(String(card?.at ?? ''));
  const head = `${HANDOFF_TEXT_MARK}${formatHhmm(Number.isFinite(atMs) ? atMs : Date.now())}】`;
  const footer = HANDOFF_FOOTER;
  const goalLine = card?.goal ? `目标：${clip(oneLine(card.goal), HANDOFF_GOAL_MAX)}` : '';
  const openLine = card?.open ? `未决：${clip(oneLine(card.open), HANDOFF_OPEN_MAX)}` : '';
  const nextLine = card?.next ? `下一步：${clip(oneLine(card.next), HANDOFF_NEXT_MAX)}` : '';
  const lastLine = card?.lastAction ? `最近：${clip(oneLine(card.lastAction), HANDOFF_LAST_ACTION_MAX)}` : '';
  const decidedItems = (Array.isArray(card?.decided) ? card.decided : [])
    .filter((item) => item && typeof item.text === 'string' && oneLine(item.text) !== '')
    .slice(0, HANDOFF_DECIDED_MAX)
    .map((item) => clip(oneLine(item.text), HANDOFF_DECIDED_ITEM_MAX - 1));

  // Fixed cost: head + footer + the single newline between them.
  let used = charLength(head) + charLength(footer) + 1;
  const state = { goal: false, open: false, next: false, last: false, decided: 0 };
  const fits = (cost) => used + cost <= budget;

  // Priority 3: 目标 (new line: prefix+body+newline).
  if (goalLine !== '' && fits(charLength(goalLine) + 1)) {
    state.goal = true;
    used += charLength(goalLine) + 1;
  }
  // Priority 4: 下一步.
  if (nextLine !== '' && fits(charLength(nextLine) + 1)) {
    state.next = true;
    used += charLength(nextLine) + 1;
  }
  // Priority 5: 未决.
  if (openLine !== '' && fits(charLength(openLine) + 1)) {
    state.open = true;
    used += charLength(openLine) + 1;
  }
  // Priority 6: 已结论① (new line: `已结论：` + ① + text + newline).
  if (decidedItems.length > 0) {
    const firstCost = charLength(DECIDED_PREFIX) + charLength(HANDOFF_CIRCLED[0]) + charLength(decidedItems[0]) + 1;
    if (fits(firstCost)) {
      state.decided = 1;
      used += firstCost;
    }
  }
  // Priority 7: 最近.
  if (lastLine !== '' && fits(charLength(lastLine) + 1)) {
    state.last = true;
    used += charLength(lastLine) + 1;
  }
  // Priority 8/9: 已结论②③ (same line: ` / ` + 圈号 + text for each item).
  // Only when ① made it in: a budget-skipped ① is neither accounted for nor
  // rendered, and ②/③ never back-fill its slot (§7/N5, round-1 MAJOR-1).
  if (state.decided > 0) {
    for (let index = 1; index < decidedItems.length; index += 1) {
      const cost = charLength(DECIDED_SEPARATOR) + charLength(HANDOFF_CIRCLED[index]) + charLength(decidedItems[index]);
      if (!fits(cost)) break;
      state.decided += 1;
      used += cost;
    }
  }

  const lines = [head];
  if (state.goal) lines.push(goalLine);
  if (state.decided > 0) {
    const body = decidedItems.slice(0, state.decided).map((text, index) => `${HANDOFF_CIRCLED[index]}${text}`).join(DECIDED_SEPARATOR);
    lines.push(`${DECIDED_PREFIX}${body}`);
  }
  if (state.open) lines.push(openLine);
  if (state.next) lines.push(nextLine);
  if (state.last) lines.push(lastLine);
  lines.push(footer);
  const text = lines.join('\n');
  const chars = charLength(text);
  const contentLines = (state.goal ? 1 : 0) + state.decided + (state.open ? 1 : 0) + (state.next ? 1 : 0) + (state.last ? 1 : 0);
  const omitted = {
    goal: goalLine !== '' && !state.goal,
    open: openLine !== '' && !state.open,
    next: nextLine !== '' && !state.next,
    last: lastLine !== '' && !state.last,
    decided: Math.max(0, decidedItems.length - state.decided),
  };
  return {
    text: contentLines === 0 ? '' : text,
    chars: contentLines === 0 ? 0 : chars,
    empty: contentLines === 0,
    head,
    lines: contentLines === 0 ? [] : lines,
    omitted,
    budget,
    // Hard invariant: a rendered card must never exceed the published 281.
    withinMax: contentLines === 0 || chars <= HANDOFF_RENDER_MAX,
  };
}

// ------------------------------------------------------------------ privacy (§6.6)

/** Whole-field redaction: a sensitive/relationship domain hit drops the field. */
export function redactSensitive(value) {
  const text = String(value ?? '');
  if (text === '') return '';
  if (SENSITIVE_DOMAIN_RE.test(text)) return '';
  if (RELATION_DOMAIN_RE.test(text)) return '';
  return text;
}

/**
 * Scrub one card field: optional PII/key gate → domain redaction (whole field)
 * → one line → envelope neutralisation → clip. `privacyScan` is injected so
 * model.js stays IO-free and the unit tests stay deterministic.
 */
export function sanitizeField(value, limit, options = {}) {
  const raw = String(value ?? '');
  if (raw.trim() === '') return '';
  const scan = typeof options.privacyScan === 'function' ? options.privacyScan : null;
  if (scan) {
    let verdict = null;
    try {
      verdict = scan(raw);
    } catch {
      return '';
    }
    if (!verdict || verdict.verdict === 'local_only') return '';
  }
  const redacted = redactSensitive(raw);
  if (redacted === '') return '';
  return clip(neutralizeEnvelope(oneLine(redacted)), limit);
}

/** Scrub every stored field of a card-shaped object (delta or merged card). */
export function sanitizeCardFields(card, options = {}) {
  const limitDecided = HANDOFF_DECIDED_ITEM_MAX - 1;
  const out = {
    ...card,
    goal: sanitizeField(card?.goal, HANDOFF_GOAL_MAX, options),
    open: sanitizeField(card?.open, HANDOFF_OPEN_MAX, options),
    next: sanitizeField(card?.next, HANDOFF_NEXT_MAX, options),
    lastAction: sanitizeField(card?.lastAction, HANDOFF_LAST_ACTION_MAX, options),
    decided: (Array.isArray(card?.decided) ? card.decided : [])
      .map((item) => ({ ...item, text: sanitizeField(item?.text, limitDecided, options) }))
      .filter((item) => item.text !== ''),
  };
  out.contentHash = contentHashOf(out);
  out.substantiveChars = charLength(out.goal) + charLength(out.open) + charLength(out.next)
    + out.decided.reduce((sum, item) => sum + charLength(item.text), 0);
  return out;
}
