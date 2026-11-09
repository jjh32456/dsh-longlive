// Proactive recall: search memory cards without a vector store.
//
// The score is deliberately simple and reproducible: token hits in the title,
// tags and body, plus a character-bigram Dice similarity and a whole-query
// phrase bonus. No randomness, no time input, no new dependency — the same
// tree and the same query always produce byte-identical results.
//
// This tool is READ-ONLY. It never writes a file, never advances the index and
// never creates `.longlive/`. `locked` cards are searchable: being locked means
// "never decay or merge", not "hidden".

import { memoryError, memoryRootFromConfig } from './paths.js';
import { scanCards } from './index.js';
import { readVerifiedCardAnchors } from './card-anchors.js';
import { searchEventsReadOnly } from './event-index.js';

export const RECALL_DEFAULT_TOPK = 3;
export const RECALL_MAX_TOPK = 20;
export const RECALL_STATUSES = Object.freeze(['active', 'locked', 'archived', 'any']);

const CJK_RUN = /[\u3400-\u9fff]+/g;
const ASCII_WORD = /[a-z0-9_]{2,}/g;

/** Collapse whitespace for the 1-line excerpt. */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Tokens for scoring: ASCII words (>=2) plus CJK chars and their bigrams. */
export function recallTokens(text) {
  const lower = String(text ?? '').toLowerCase();
  const tokens = [];
  for (const match of lower.match(ASCII_WORD) ?? []) tokens.push(match);
  for (const run of lower.match(CJK_RUN) ?? []) {
    const chars = [...run];
    for (const char of chars) tokens.push(char);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

function countToken(tokens, token) {
  let count = 0;
  for (const item of tokens) if (item === token) count += 1;
  return count;
}

/** Dice coefficient over character bigrams (0..1); cheap fuzzy similarity. */
function diceBigrams(left, right) {
  const grams = (text) => {
    const chars = [...collapse(text).toLowerCase().replace(/\s+/g, '')];
    if (chars.length < 2) return chars;
    const out = [];
    for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
    return out;
  };
  const a = grams(left);
  const b = grams(right);
  if (a.length === 0 || b.length === 0) return 0;
  const pool = new Map();
  for (const gram of b) pool.set(gram, (pool.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of a) {
    const remaining = pool.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      pool.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

function uniqueQueryTokens(query) {
  return [...new Set(recallTokens(query))];
}

/**
 * Score one card against one query. Exported so the tests (and the mark-core
 * script) can reproduce a single number without going through the tool layer.
 */
export function scoreCard(query, card) {
  const tokens = uniqueQueryTokens(query);
  if (tokens.length === 0) return { score: 0, hits: [] };

  const titleText = collapse(card.title);
  const tagText = collapse((card.fields?.tags ?? []).join(' '));
  const bodyText = collapse(card.body ?? card.summary ?? '');
  const titleTokens = recallTokens(titleText);
  const tagTokens = recallTokens(tagText);
  const bodyTokens = recallTokens(bodyText);
  const normalizedQuery = collapse(query).toLowerCase();

  let score = 0;
  const hits = [];
  for (const token of tokens) {
    const inTitle = countToken(titleTokens, token) > 0;
    const inTags = countToken(tagTokens, token) > 0;
    const bodyCount = countToken(bodyTokens, token);
    if (inTitle) score += 5;
    if (inTags) score += 3;
    if (bodyCount > 0) score += Math.min(bodyCount, 3);
    if (inTitle || inTags || bodyCount > 0) hits.push(token);
  }

  if (normalizedQuery.length > 0 && titleText.toLowerCase().includes(normalizedQuery)) score += 6;
  if (normalizedQuery.length > 0 && bodyText.toLowerCase().includes(normalizedQuery)) score += 2;
  score += diceBigrams(normalizedQuery, `${titleText} ${bodyText}`) * 4;

  score = Math.round(score * 100) / 100;
  return { score, hits };
}

/** A short excerpt centered on the first matching token, in body order. */
function excerptFor(query, card) {
  const body = collapse(card.body ?? card.summary ?? '');
  if (body === '') return collapse(card.title).slice(0, 120);
  const lower = body.toLowerCase();
  let at = -1;
  for (const token of uniqueQueryTokens(query)) {
    const found = lower.indexOf(token.toLowerCase());
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return body.slice(0, 120);
  const start = Math.max(0, at - 40);
  const end = Math.min(body.length, at + 80);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return `${prefix}${body.slice(start, end)}${suffix}`;
}

function normalizeTopK(value) {
  if (value == null) return RECALL_DEFAULT_TOPK;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw memoryError('E_BAD_ARGUMENT', `topK 必须是 1..${RECALL_MAX_TOPK} 的整数，收到 ${JSON.stringify(value)}`);
  }
  const rounded = Math.trunc(value);
  return Math.min(RECALL_MAX_TOPK, Math.max(1, rounded));
}

function normalizeRoom(room) {
  if (room == null || room === '') return null;
  if (typeof room !== 'string') throw memoryError('E_BAD_ARGUMENT', 'room 必须是字符串，例如 "topics" 或 "journal"');
  const text = room.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (text === '' || text.startsWith('/') || text.includes('..')) {
    throw memoryError('E_BAD_ARGUMENT', `room 必须是记忆根下的相对目录（topics / journal / 子目录），收到「${room}」`);
  }
  return text;
}

function statusesFor(status) {
  if (status == null || status === '') return ['active', 'locked'];
  if (typeof status !== 'string' || !RECALL_STATUSES.includes(status)) {
    throw memoryError('E_BAD_ARGUMENT', `status 只能是 ${RECALL_STATUSES.join(' / ')}，收到「${status}」`);
  }
  if (status === 'any') return ['active', 'locked', 'archived'];
  return [status];
}

/**
 * `memory_recall` implementation.
 *
 * @param {{query?: string, topK?: number, room?: string, status?: string}} args
 * @param {{memoryRoot?: string, memRoot?: string}} config
 * @returns {object} `{ ok, status, query, topK, room, statuses, scanned, count, results }`
 */
export function memoryRecall(args, config = {}) {
  const rawQuery = args?.query;
  if (typeof rawQuery !== 'string' || rawQuery.trim() === '') {
    throw memoryError(
      'E_RECALL_EMPTY_QUERY',
      'memory_recall 需要 query（自然语言或关键词）— 例如 {"query":"听觉 训练","topK":3}',
    );
  }
  const query = rawQuery.trim();
  const topK = normalizeTopK(args?.topK);
  const room = normalizeRoom(args?.room);
  const statuses = statusesFor(args?.status);
  const root = memoryRootFromConfig(config);

  const scanned = scanCards(root);
  const sidecar = readVerifiedCardAnchors({ memoryRoot: root }).links;
  const results = [];
  for (const card of scanned) {
    const status = card.fields?.status ?? 'active';
    if (!statuses.includes(status)) continue;
    if (room && !(card.rel === room || card.rel.startsWith(`${room}/`))) continue;
    const { score, hits } = scoreCard(query, card);
    if (score <= 0 || hits.length === 0) continue;
    const link = sidecar.get(card.rel);
    results.push({
      path: card.rel,
      title: card.title,
      score,
      excerpt: excerptFor(query, card),
      ...(link && Array.isArray(link.sourceEventIds) && link.sourceEventIds.length > 0
        ? { sourceEventIds: link.sourceEventIds }
        : {}),
      ...(link && Array.isArray(link.anchors) && link.anchors.length > 0
        ? { anchors: link.anchors }
        : {}),
      ...(link?.legacy === true ? { legacy: true } : {}),
    });
  }

  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });

  // 1.8.2 D2: auto-card layer removed. Only curated markdown cards are
  // recalled; cards.jsonl stays as a cold read-only archive.
  const weighted = [...results].sort((left, right) => {
    const l = left.score * 1.12;
    const r = right.score * 1.12;
    if (r !== l) return r - l;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  const manualCap = Math.min(2, topK);
  const manualResults = weighted.slice(0, manualCap);
  const top = [...manualResults].slice(0, topK);


  const base = {
    ok: true,
    query,
    topK,
    room,
    statuses,
    scanned: scanned.length,
    scannedEvents: null,
    autoCards: null,
    eventFallback: null,
    count: top.length,
    results: top,
  };
  if (top.length === 0) {
    return {
      ...base,
      status: 'empty',
      code: 'E_RECALL_NO_MATCH',
      message: `没有卡片命中「${query}」— 换更短/更具体的关键词，或放宽 room/status 过滤；本次扫描 ${scanned.length} 张卡`,
    };
  }
  return { ...base, status: 'ok' };
}
