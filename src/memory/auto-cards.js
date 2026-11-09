// src/memory/cards.js — 1.8.0 AutoCard: EventRecord → append-only index card.
//
// Minimal deterministic distillation: no LLM, no network, no mutation of the
// event index. One card per turn EventRecord, keyed by eventId; repeated
// captureTurn calls never append a second line for the same eventId.
//
// Card shape (spec):
//   { schema, cardId, eventId, sessionId, turn, at, kind, title, terms,
//     anchor: { sessionId, turn, seqStart, seqEnd, digest } }
//
// anchor is a copied projection of EventRecord.anchors[0] (the session_turn
// anchor), so a card can always be verified back against the original turn.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { openEventIndex } from './event-index.js';
import { acquireLease, releaseLease } from './lock.js';
import { resolveHostKey, readHostKey } from '../role/writeprotect.js';
import { priorityFor } from './card-priority.js';

export const AUTO_CARD_SCHEMA = 'auto-card/v1';
export const CARDS_REL = path.join('.longlive', 'index', 'cards.jsonl');
export const CARD_TITLE_MAX = 80;
export const CARD_ANCHOR_HINT_MAX = 60;

let cache = null;

export function cardsPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), CARDS_REL);
}

/** Cheap count for INDEX/status surfaces (does not verify signatures). */
export function countAutoCards(memoryRoot) {
  try {
    const raw = fs.readFileSync(cardsPathOf(memoryRoot), 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) if (line.trim() !== '') count += 1;
    return count;
  } catch {
    return 0;
  }
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function macHex(key, text) {
  return crypto.createHmac('sha256', key).update(String(text), 'utf8').digest('hex');
}

/** Canonical signed payload: every trusted card field except the signature. */
export function autoCardPayload(card) {
  return {
    schema: card?.schema ?? AUTO_CARD_SCHEMA,
    cardId: card?.cardId ?? '',
    eventId: card?.eventId ?? '',
    sourceEventId: card?.sourceEventId ?? card?.eventId ?? '',
    sessionId: card?.sessionId ?? '',
    turn: card?.turn ?? null,
    at: card?.at ?? '',
    kind: card?.kind ?? '',
    title: card?.title ?? '',
    terms: Array.isArray(card?.terms) ? card.terms : [],
    anchor: card?.anchor ?? null,
    salience: card?.salience ?? 1,
    retention: card?.retention ?? null,
  };
}

export function signAutoCard(card, auditKey) {
  if (!auditKey) return { ...card, sig: null };
  return { ...card, sig: macHex(auditKey, JSON.stringify(autoCardPayload(card))) };
}

function oneLine(text, max = 160) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

/**
 * S8: card terms = event terms + event topicPhrases (deduped, one line each,
 * max 20). Old events have no topicPhrases, so old cards keep the same terms.
 * Used by BOTH makeAutoCard and trustedCardFromEvent so the HMAC payload is
 * re-derivable after an upgrade (old cards stay valid).
 */
export function mergedCardTerms(record) {
  const source = [
    ...(Array.isArray(record?.terms) ? record.terms : []),
    ...(Array.isArray(record?.topicPhrases) ? record.topicPhrases : []),
  ];
  const out = [];
  const seen = new Set();
  for (const value of source) {
    const term = oneLine(value, 40);
    if (term === '' || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * S8: card title keeps the event summary; topicPhrases get a short prefix so a
 * theme word survives the 80-char title cap. Old events (no topicPhrases)
 * derive exactly the old title.
 */
export function cardTitleOf(record) {
  const phrases = (Array.isArray(record?.topicPhrases) ? record.topicPhrases : [])
    .map((phrase) => oneLine(phrase, 24))
    .filter((phrase) => phrase !== '');
  // 长短语（≥3 字）优先，避免「版本、简介」这类短噪音挤掉主题；最多 2 个。
  const long = phrases.filter((phrase) => Array.from(phrase).length >= 3);
  const short = phrases.filter((phrase) => Array.from(phrase).length < 3);
  const picked = [...long, ...short].slice(0, 2);
  const prefix = picked.length > 0 ? `${picked.join('、')}：` : '';
  return oneLine(`${prefix}${record?.summary ?? ''}`, CARD_TITLE_MAX);
}

export function cardIdOf(eventId) {
  return `card:${sha256Hex(String(eventId ?? '')).slice(0, 16)}`;
}

/** Full-file SHA-256: any byte change invalidates the cache, even mid-file. */
export function sampleContentHash(file, size = null) {
  try {
    return sha256Hex(fs.readFileSync(file));
  } catch {
    return '';
  }
}

function anchorOf(record) {
  const anchor = Array.isArray(record?.anchors) && record.anchors.length > 0 ? record.anchors[0] : null;
  if (!anchor || typeof anchor !== 'object') return null;
  if (typeof anchor.sessionId !== 'string' || anchor.sessionId === '') return null;
  if (!Number.isInteger(anchor.turn) || !Number.isInteger(anchor.seqStart) || !Number.isInteger(anchor.seqEnd)) return null;
  if (typeof anchor.digest !== 'string' || !/^[0-9a-f]{64}$/.test(anchor.digest)) return null;
  // Copy only stable anchor fields (no status mutation is written here).
  return {
    sessionId: anchor.sessionId,
    turn: anchor.turn,
    seqStart: anchor.seqStart,
    seqEnd: anchor.seqEnd,
    digest: anchor.digest,
  };
}

/** Pure EventRecord → AutoCard (or null when the record is not anchorable). */
export function makeAutoCard(record, { now = () => new Date(), auditKey = null } = {}) {
  if (!record || typeof record !== 'object') return null;
  const eventId = typeof record.id === 'string' ? record.id : '';
  const anchor = anchorOf(record);
  if (eventId === '' || anchor === null) return null;
  // Turn 0 is the session preamble (system/tool scaffolding), not a user turn.
  if (!Number.isInteger(record.turn) || record.turn < 1) return null;
  const atMs = Number.isFinite(record.timeEnd) ? record.timeEnd
    : (Number.isFinite(record.timeStart) ? record.timeStart : now().getTime());
  const title = cardTitleOf(record);
  const terms = mergedCardTerms(record);
  const priority = priorityFor({ kind: oneLine(record.kind, 40) || 'chat', source: 'auto' });
  return {
    schema: AUTO_CARD_SCHEMA,
    cardId: cardIdOf(eventId),
    eventId,
    sourceEventId: eventId,
    sessionId: String(record.sessionId ?? anchor.sessionId),
    turn: Number.isInteger(record.turn) ? record.turn : anchor.turn,
    at: new Date(atMs).toISOString(),
    kind: oneLine(record.kind, 40) || 'chat',
    title,
    terms,
    anchor,
    // Event cards decay fast but are never physically deleted (append-only,
    // no forget execution); salience is intentionally lower than curated cards.
    salience: priority.salience,
    retention: priority.retention,
    ...(auditKey ? { sig: macHex(auditKey, JSON.stringify(autoCardPayload({
      schema: AUTO_CARD_SCHEMA,
      cardId: cardIdOf(eventId),
      eventId,
      sourceEventId: eventId,
      sessionId: String(record.sessionId ?? anchor.sessionId),
      turn: Number.isInteger(record.turn) ? record.turn : anchor.turn,
      at: new Date(atMs).toISOString(),
      kind: oneLine(record.kind, 40) || 'chat',
      title,
      terms,
      anchor,
      salience: priority.salience,
      retention: priority.retention,
    }))) } : {}),
  };
}

export function readAutoCards(memoryRoot) {
  const file = cardsPathOf(memoryRoot);
  let stat = null;
  try { stat = fs.statSync(file); } catch { cache = { file: null, mtimeMs: 0, size: 0, contentHash: '', cards: [] }; return cache.cards; }
  const contentHash = sampleContentHash(file, stat.size);
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size
    && cache.contentHash === contentHash) return cache.cards;
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const card = JSON.parse(line);
      if (!card || typeof card.cardId !== 'string' || typeof card.eventId !== 'string') continue;
      // Reject injection-shaped raw rows early (the trusted read path also
      // verifies the HMAC + EventRecord; this keeps inspection APIs inert).
      const unsafe = (value) => typeof value === 'string' && /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u.test(value);
      const unsafeAnchor = card.anchor && typeof card.anchor.sessionId === 'string' && unsafe(card.anchor.sessionId);
      const unsafeTerms = Array.isArray(card.terms) && card.terms.some((term) => unsafe(term));
      if (unsafe(card.title) || unsafeTerms || unsafeAnchor) continue;
      out.push(card);
    } catch { /* corrupt line is skipped; append-only file is never rewritten */ }
  }
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, contentHash, cards: out };
  return out;
}

/** True when the card's anchor is exactly the EventRecord's primary anchor. */
export function validateAutoCardRecord(card, event, auditKey = null) {
  if (!card || !event) return { ok: false, code: 'E_CARD_EVENT_MISSING' };
  if (!auditKey || typeof card.sig !== 'string' || card.sig === '') return { ok: false, code: 'E_CARD_UNSIGNED' };
  const expectedSig = macHex(auditKey, JSON.stringify(autoCardPayload(card)));
  if (card.sig !== expectedSig) return { ok: false, code: 'E_CARD_SIG_INVALID' };
  if (typeof card.eventId !== 'string' || card.eventId !== event.id) return { ok: false, code: 'E_CARD_EVENT_MISMATCH' };
  if (card.sourceEventId !== event.id) return { ok: false, code: 'E_CARD_SOURCE_MISMATCH' };
  if (card.cardId !== cardIdOf(card.eventId)) return { ok: false, code: 'E_CARD_ID_MISMATCH' };
  const anchor = card.anchor;
  const expected = Array.isArray(event.anchors) ? event.anchors[0] : null;
  if (!anchor || !expected) return { ok: false, code: 'E_CARD_ANCHOR_MISSING' };
  for (const key of ['sessionId', 'turn', 'seqStart', 'seqEnd', 'digest']) {
    if (anchor[key] !== expected[key]) return { ok: false, code: 'E_CARD_ANCHOR_MISMATCH' };
  }
  if (anchor.digest !== event.digest) return { ok: false, code: 'E_CARD_DIGEST_MISMATCH' };
  return { ok: true, code: 'OK' };
}

/** Trusted content is re-derived from the EventRecord, never from the card file. */
export function trustedCardFromEvent(card, event) {
  const anchor = Array.isArray(event?.anchors) ? event.anchors[0] : null;
  const atMs = Number.isFinite(event?.timeEnd) ? event.timeEnd
    : (Number.isFinite(event?.timeStart) ? event.timeStart : Date.parse(card?.at ?? '') || 0);
  return {
    schema: AUTO_CARD_SCHEMA,
    cardId: cardIdOf(event.id),
    eventId: event.id,
    sourceEventId: event.id,
    sessionId: String(event.sessionId ?? anchor?.sessionId ?? ''),
    turn: Number.isInteger(event.turn) ? event.turn : anchor?.turn,
    at: new Date(atMs).toISOString(),
    kind: oneLine(event.kind, 40) || 'chat',
    title: cardTitleOf(event),
    terms: mergedCardTerms(event),
    anchor: anchor ? {
      sessionId: anchor.sessionId,
      turn: anchor.turn,
      seqStart: anchor.seqStart,
      seqEnd: anchor.seqEnd,
      digest: anchor.digest,
    } : null,
    salience: priorityFor({ kind: oneLine(event.kind, 40) || 'chat', source: 'auto' }).salience,
    retention: priorityFor({ kind: oneLine(event.kind, 40) || 'chat', source: 'auto' }).retention,
    sig: card?.sig ?? null,
  };
}

function auditInvalidCard(memoryRoot, card, result) {
  try {
    const file = path.join(path.resolve(String(memoryRoot)), '.longlive', 'index', 'card-audit.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({
      schema: 'card-audit/v1',
      at: new Date().toISOString(),
      action: 'drop',
      cardId: card?.cardId ?? null,
      eventId: card?.eventId ?? null,
      code: result?.code ?? 'E_CARD_INVALID',
    })}\n`, 'utf8');
  } catch { /* audit failure must not turn into a recall hit */ }
}

let verifiedCache = null;

/**
 * Production reader: only cards whose source EventRecord exists in events.db
 * and whose anchor/digest match that record are returned. Invalid cards are
 * dropped and audited; they never reach recall/injection.
 */
export function readVerifiedAutoCards({ memoryRoot } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  const file = cardsPathOf(root);
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  const dbPath = path.join(root, '.longlive', 'index', 'events.db');
  let dbStat;
  try { dbStat = fs.statSync(dbPath); } catch { return []; } // no source of truth => fail closed
  const contentHash = sampleContentHash(file, stat.size);
  const auditKey = readHostKey(root);
  const key = `${file}|${stat.mtimeMs}|${stat.size}|${contentHash}|${dbStat.mtimeMs}|${dbStat.size}|${auditKey ? sha256Hex(auditKey).slice(0, 16) : 'nokey'}`;
  if (verifiedCache && verifiedCache.key === key) return verifiedCache.cards;
  const cards = readAutoCards(root);
  if (!auditKey) {
    for (const card of cards) auditInvalidCard(root, card, { code: 'E_NO_KEY' });
    verifiedCache = { key, cards: [] };
    return [];
  }
  const index = openEventIndex({ memoryRoot: root });
  const verified = [];
  const seen = new Map();
  try {
    for (const card of cards) {
      if (seen.has(card.eventId)) {
        // The first valid signed card wins; a later forged duplicate can never
        // suppress the genuine card (write order alone is not authority).
        auditInvalidCard(root, card, { code: 'E_CARD_DUPLICATE' });
        continue;
      }
      const event = index.getEvent(card.eventId);
      const result = validateAutoCardRecord(card, event, auditKey);
      if (result.ok) {
        const trusted = trustedCardFromEvent(card, event);
        verified.push(trusted);
        seen.set(card.eventId, trusted);
      } else auditInvalidCard(root, card, result);
    }
  } finally {
    index.close();
  }
  verifiedCache = { key, cards: verified };
  return verified;
}

/**
 * Append cards for records, idempotent by eventId.
 * `dryRun` performs the same read/dedupe pass without writing.
 */
export function appendAutoCards({ memoryRoot, records, now = () => new Date(), dryRun = false, skipLock = false, resign = false } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') throw new Error('E_MEMORY_ROOT: appendAutoCards requires memoryRoot');
  const run = () => {
    const file = cardsPathOf(root);
    const existingCards = readAutoCards(root);
    const existing = new Map(existingCards.map((card) => [card.eventId, card]));
    const existingByCardId = new Map(existingCards.map((card) => [card.cardId, card]));
    let auditKey = null;
    try { auditKey = resolveHostKey(root); } catch { auditKey = null; }
    const cards = [];
    let skipped = 0;
    for (const record of Array.isArray(records) ? records : []) {
      const card = makeAutoCard(record, { now, auditKey });
      if (card === null) { skipped += 1; continue; }
      const sameCardId = existingByCardId.get(card.cardId);
      if (sameCardId && sameCardId.eventId !== card.eventId) {
        auditInvalidCard(root, card, { code: 'E_CARD_ID_COLLISION' });
        skipped += 1;
        continue;
      }
      const prior = existing.get(card.eventId);
      if (prior && !resign) {
        // A signed card may replace an old unsigned draft (migration redo);
        // otherwise eventId is already final.
        if (prior.sig && card.sig) { skipped += 1; continue; }
        if (prior.sig && !card.sig) { skipped += 1; continue; }
        if (!card.sig) { skipped += 1; continue; }
      }
      if (resign && !card.sig) { skipped += 1; continue; }
      existing.set(card.eventId, card);
      existingByCardId.set(card.cardId, card);
      cards.push(card);
    }
    if (!dryRun && cards.length > 0) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, cards.map((card) => JSON.stringify(card)).join('\n') + '\n', 'utf8');
    }
    return { ok: true, file, written: cards.length, skipped, cards, dryRun };
  };
  if (skipLock || dryRun) return run();
  const lockFile = path.join(root, '.longlive', 'memory', 'cards.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const holder = `cards-${process.pid}-${Date.now()}`;
  const deadline = Date.now() + 3000;
  let lease = null;
  for (;;) {
    try {
      lease = acquireLease(lockFile, { holder });
      break;
    } catch (error) {
      if (error?.code !== 'E_LOCKED' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return run();
  } finally {
    releaseLease(lockFile, holder);
  }
}

/** One-line anchor hint for injection, capped at 60 chars. */
export function anchorHintOf(card) {
  const anchor = card?.anchor;
  if (!anchor || typeof anchor.sessionId !== 'string' || !Number.isInteger(anchor.turn)) return '';
  const suffix = `#${anchor.turn}]`;
  const prefix = '[原文 ';
  const maxSession = Math.max(1, CARD_ANCHOR_HINT_MAX - prefix.length - suffix.length);
  const session = anchor.sessionId.length > maxSession ? anchor.sessionId.slice(0, maxSession) : anchor.sessionId;
  return `${prefix}${session}${suffix}`;
}

function bigrams(text) {
  const value = String(text ?? '').toLowerCase().replace(/\s+/gu, ' ').trim();
  const out = new Set();
  for (let i = 0; i < value.length - 1; i += 1) out.add(value.slice(i, i + 2));
  return out;
}

function cardScore(card, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return 0;
  const title = String(card.title ?? '').toLowerCase();
  const terms = Array.isArray(card.terms) ? card.terms.join(' ').toLowerCase() : '';
  let score = 0;
  if (title.includes(q)) score += 5;
  if (terms.includes(q)) score += 4;
  const qb = bigrams(q);
  const tb = bigrams(`${title} ${terms}`);
  if (qb.size > 0) {
    let hit = 0;
    for (const gram of qb) if (tb.has(gram)) hit += 1;
    score += (hit / qb.size) * 2;
  }
  return score;
}

