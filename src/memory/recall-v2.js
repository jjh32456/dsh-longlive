// src/memory/recall-v2.js — M2-C：多路召回+证据门+确定性快答通道（memory_recall_v2）
//
// 两段式第一段（§3.2）：检索 ≤1s，返回带锚点/引文的 hits + confidence + speed 字段；
// 证据门（§3.3.2）：
//   * 无命中 => confidence 'none'，不回退猜测（E_NO_EVIDENCE）
//   * 多命中/分数接近/冲突 => 降级 model 路径，fastAnswer=null
//   * 唯一高置信命中 + 值类型匹配（版本/路径/时间/数字）=> 快答通道：
//     答案=原文引用+坐标，**不生成**；fail-safe：任何不确定都回退模型
//
// 本模块只读；fastAnswer 是确定性拼装，可逐字节复现。

import { memoryError, memoryRootFromConfig } from './paths.js';
import { memoryRecall } from './recall.js';
import { scanCards } from './index.js';
import { appendAuditRecord } from './audit-records.js';
import { searchAutoCards } from './auto-cards.js';

export const RECALL_V2_SCHEMA = 'memory-recall-v2/v1';
export const FAST_ANSWER_MAX_CHARS = 300;

const VALUE_PATTERNS = Object.freeze([
  { type: 'version', re: /v?\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?/u },
  { type: 'path', re: /(?:[A-Za-z]:[\\/]|\/)[^\s，。；;）)】\]]+|(?:[\w.-]+[\\/])+[\w.-]+\.(?:md|mjs|js|json|jsonl|ps1|tgz|txt|html)\b/u },
  { type: 'time', re: /\d{1,2}:\d{2}(?::\d{2})?|\d{4}-\d{2}-\d{2}/u },
  { type: 'number', re: /\d+(?:\.\d+)?\s*(?:MB|GB|KB|ms|秒|分钟|小时|条|轮|个|%|分)?/u },
]);

export const FAST_ANSWER_TARGETS = Object.freeze({
  version: 0.9,
  path: 0.9,
  time: 0.85,
  number: 0.8,
});

/** Detect the value type a question is asking for (or null => not fast eligible). */
export function questionValueType(question) {
  const text = String(question ?? '');
  if (/版本号?|version|tag/i.test(text)) return 'version';
  if (/路径|文件(?:名|在哪)|放哪|在哪(?:个)?文件|哪个文件/i.test(text)) return 'path';
  if (/几点|时间|日期|什么时候|哪天|多久|多少分钟|空窗/i.test(text)) return 'time';
  if (/多少|几个|数量|大小|多大|多久|几轮|几条|百分比|%/.test(text)) return 'number';
  // no explicit ask type: only allow a value literal present in the question
  for (const { type, re } of VALUE_PATTERNS) if (re.test(text)) return type;
  return null;
}

export function detectValueType(text) {
  const value = String(text ?? '');
  for (const { type, re } of VALUE_PATTERNS) if (re.test(value)) return type;
  return null;
}

function excerptValueMatches(questionType, excerpt) {
  if (questionType === null) return false;
  for (const { type, re } of VALUE_PATTERNS) {
    if (type !== questionType) continue;
    return re.test(String(excerpt ?? ''));
  }
  return false;
}

/**
 * Evidence gate: decide confidence / fast eligibility / fallback. Fail-safe: any
 * uncertainty => model path, never a guessed fast answer.
 */
export function evidenceGate({ hits = [], question = '' } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) {
    return { pass: false, confidence: 'none', fastEligible: false, code: 'E_NO_EVIDENCE', fallback: 'model', reason: 'no-hit' };
  }
  if (list.some((hit) => hit?.conflict === true) || list.some((hit) => hit?.anchor?.status === 'conflict')) {
    return { pass: true, confidence: 'low', fastEligible: false, code: 'E_EVIDENCE_CONFLICT', fallback: 'model', reason: 'conflict' };
  }
  const questionType = questionValueType(question);
  const withValue = list.filter((hit) => excerptValueMatches(questionType, hit?.quote ?? hit?.excerpt ?? ''));
  if (list.length > 1) {
    const top = Number(list[0]?.score ?? 0);
    const second = Number(list[1]?.score ?? 0);
    const close = Number.isFinite(top) && Number.isFinite(second) && Math.abs(top - second) < 0.1;
    if (questionType !== null && withValue.length === 1 && !close) {
      return { pass: true, confidence: 'high', fastEligible: true, code: null, fallback: null, reason: 'single-value-hit' };
    }
    return { pass: true, confidence: close ? 'low' : 'medium', fastEligible: false, code: close ? 'E_EVIDENCE_AMBIGUOUS' : null, fallback: 'model', reason: close ? 'ambiguous' : 'multi-hit' };
  }
  const only = list[0];
  const anchorStatus = only?.anchor?.status ?? 'live';
  if (anchorStatus !== 'live') {
    return { pass: false, confidence: 'low', fastEligible: false, code: 'E_ANCHOR_NOT_LIVE', fallback: 'model', reason: 'stale-anchor' };
  }
  if (questionType !== null && withValue.length === 1) {
    return { pass: true, confidence: 'high', fastEligible: true, code: null, fallback: null, reason: 'single-value-hit' };
  }
  return { pass: true, confidence: 'medium', fastEligible: false, code: null, fallback: 'model', reason: 'value-type-mismatch' };
}

/** Deterministic fast answer: quote + coordinate, no generation. */
export function buildFastAnswer({ question = '', hit = null, gate = null } = {}) {
  if (!hit || (gate && gate.fastEligible !== true)) return null;
  const quote = String(hit.quote ?? hit.excerpt ?? '').replace(/\s+/gu, ' ').trim();
  if (quote === '') return null;
  const anchor = hit.anchor ?? {};
  const coordinateParts = [];
  if (typeof hit.card === 'string') coordinateParts.push(hit.card);
  if (typeof anchor.file === 'string') coordinateParts.push(anchor.file);
  if (Number.isInteger(anchor.turn)) coordinateParts.push(`第 ${anchor.turn} 轮`);
  const coordinate = coordinateParts.length > 0 ? coordinateParts.join(' · ') : '卡锚点';
  const valueType = detectValueType(quote) ?? questionValueType(question);
  const text = `${quote}（坐标：${coordinate}）`.slice(0, FAST_ANSWER_MAX_CHARS);
  return { text, quote, anchor, valueType, confidence: 'high', deterministic: true, question: String(question ?? '').slice(0, 120) };
}

/** Trim a card date (YYYY-MM-DD / ISO) to ms; null when absent. */
function dateMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** memory_recall_v2 tool entry: multi-route recall + evidence gate + fast answer. */
export function recallV2(args = {}, config = {}) {
  const rawQuery = args?.query;
  if (typeof rawQuery !== 'string' || rawQuery.trim() === '') {
    throw memoryError('E_RECALL_EMPTY_QUERY', 'memory_recall_v2 需要 query（自然语言或关键词）。');
  }
  const query = rawQuery.trim();
  const topK = Math.max(1, Math.min(10, Number.isInteger(args?.topK) ? Number(args.topK) : 3));
  const includeForgotten = args?.includeForgotten === true;
  const project = typeof args?.project === 'string' && args.project.trim() !== '' ? args.project.trim() : null;
  const sinceMs = dateMs(args?.since);
  const untilMs = dateMs(args?.until);
  const root = memoryRootFromConfig(config);

  const recalled = memoryRecall({ query, topK: Math.max(topK, 5), status: includeForgotten ? 'any' : 'active' }, { memoryRoot: root });
  const cards = new Map((scanCards(root) || []).map((card) => [card.rel, card]));
  let hits = [];
  for (const row of Array.isArray(recalled.results) ? recalled.results : []) {
    if (row?.type === 'event') continue; // AutoCards are appended below, after curated cards.
    const card = cards.get(row.path);
    const cardFields = card?.fields ?? {};
    const cardStatus = cardFields.status ?? 'active';
    if (!includeForgotten && (cardStatus === 'archived' || cardStatus === 'forgotten')) continue;
    if (project !== null) {
      const fields = cardFields;
      const cardProject = typeof fields.project === 'string' ? fields.project : null;
      if (cardProject !== null && cardProject !== project) continue;
    }
    const ms = dateMs(card?.fields?.date ?? card?.date);
    if (sinceMs !== null && ms !== null && ms < sinceMs) continue;
    if (untilMs !== null && ms !== null && ms > untilMs) continue;
    const status = cardStatus;
    hits.push({
      card: row.path,
      anchor: { kind: 'file', file: row.path, line: null, status: status === 'archived' || status === 'forgotten' ? 'stale' : 'live' },
      quote: String(row.excerpt ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240),
      score: Number(row.score ?? 0),
    });
    if (hits.length >= topK) break;
  }
  const gate = evidenceGate({ hits, question: query });
  // 1.8.0 AutoCards: at most one event card supplements up to two curated hits;
  // the original turn coordinate and a session_original hint travel with it.
  const autoHits = searchAutoCards({ memoryRoot: root, query, limit: 3 }).slice(0, 1).map((card) => ({
    card: `auto:${card.cardId}`,
    cardId: card.cardId,
    eventId: card.eventId,
    kind: 'auto-card',
    anchor: { kind: 'session_turn', ...card.anchor, status: 'live' },
    quote: String(card.title ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240),
    score: 1,
    originalHint: `可读原文 session_original(turn=${card.anchor.turn})`,
    original: {
      sessionId: card.anchor.sessionId,
      turn: card.anchor.turn,
      how: `session_original(turn=${card.anchor.turn})`,
    },
  }));
  const curatedHits = hits.slice(0, Math.min(2, topK));
  hits = [...curatedHits, ...autoHits].slice(0, topK);
  const finalGate = evidenceGate({ hits, question: query });
  const fastAnswer = finalGate.fastEligible ? buildFastAnswer({ question: query, hit: hits[0], gate: finalGate }) : null;
  // §16.8-D: every recall entry writes one unified read-audit row (行数=调用数).
  try {
    appendAuditRecord({
      memoryRoot: root,
      action: 'read',
      recordId: hits.length > 0 ? hits.map((hit) => hit.card).join(',') : null,
      readerTier: typeof args?.readerTier === 'string' && args.readerTier !== '' ? args.readerTier : 'agent',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      extra: { entry: 'memory_recall_v2', count: hits.length, confidence: finalGate.confidence, fastAnswer: fastAnswer !== null },
    });
  } catch { /* read audit must never break recall */ }
  return {
    schema: RECALL_V2_SCHEMA,
    ok: true,
    query,
    topK,
    includeForgotten,
    confidence: finalGate.confidence,
    hits,
    didYouMean: [],
    slowPath: fastAnswer === null,
    fastAnswer,
    evidenceGate: finalGate,
    fallback: finalGate.fallback,
    ...(hits.length === 0 ? { status: 'empty', code: 'E_NO_EVIDENCE', hint: '没有可引用证据：请直说未找到，不要猜。' } : { status: 'ok' }),
    ...(finalGate.code ? { code: finalGate.code } : {}),
  };
}

/** Adapter for pre-step recall results (items from recall-core) → evidence package fastAnswer. */
export function fastAnswerFromRecallItems({ question = '', items = [] } = {}) {
  const hits = (Array.isArray(items) ? items : []).map((item) => ({
    card: item.path,
    anchor: { kind: 'file', file: item.path, line: null, status: 'live' },
    quote: String(item.excerpt ?? item.title ?? '').replace(/\s+/gu, ' ').trim(),
    score: Number(item.score ?? 0),
  }));
  const gate = evidenceGate({ hits, question });
  if (!gate.fastEligible) return { fastAnswer: null, gate };
  return { fastAnswer: buildFastAnswer({ question, hit: hits[0], gate }), gate };
}
