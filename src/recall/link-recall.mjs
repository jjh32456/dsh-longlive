/**
 * 1.8.8 M2 链路直连：把 links.mjs 的「词 → 卡」命中变成可注入的候选条目。
 *
 * 分工：
 *   - links.mjs 只管数据（存储/匹配/学习/原子写）；
 *   - 本模块只管「候选 → 注入条目」：查卡、隐私整卡丢弃、去重、预算、摘要；
 *   - 最终文本仍由 recall-core 的 renderInjection 渲染（不另造一套注入格式）。
 *
 * 隐私口径与既有召回完全一致（规格 §2.4）：
 *   - 卡 frontmatter `local_only` → 整卡丢弃；
 *   - title/path/excerpt 任一命中隐私扫描 → 默认整卡丢弃；privacyPolicy:'title'
 *     时把 excerpt 换成 [已隐藏]（与 chooseRecall 的既有语义一致）。
 */

import { estimateTokens, pickExcerpt, renderInjection, sanitizeDataText } from './recall-core.mjs';
import { defaultPrivacyScan } from './recall-core.mjs';
import { linkCardsForText, LINKS_DEFAULTS, normalizeCardPath, normalizeLinksConfig } from './links.mjs';

export const LINK_SOURCE = 'link';
export const LINK_REASON_TEXT = 'link';
const PRIVACY_HIDDEN_MARK = '[已隐藏]';
const PRIVACY_HIDDEN_PATH = '<hidden>';
const DEDUPE_CONTAINMENT = 0.6;

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * 链路权重（seed w 可到 13.63）→ 0..1 的相关度口径，便于与既有条目同栏显示。
 * 单调变换 w/(1+w)：w=1 → 0.5，w=13.63 → 0.932，排序不变。
 */
export function linkScore(weight) {
  const w = Math.max(0, Number(weight) || 0);
  return round3(w / (1 + w));
}

/** 扫描器返回什么形态都归一成 boolean；抛错按命中处理（fail-closed，与 recall-core 一致）。 */
function privacyBlocked(scan, text) {
  try {
    const result = scan(text);
    if (!result) return false;
    if (typeof result === 'string') return result === 'local_only';
    return result.verdict === 'local_only' || result.blocked === true;
  } catch {
    return true;
  }
}

function bigrams(text) {
  const s = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  const chars = Array.from(s);
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** 与 recall-core 的 containment 同口径（候选摘要被已注入文本覆盖的比例）。 */
function containment(candidate, existing) {
  const a = bigrams(candidate);
  if (a.size === 0) return 0;
  const b = bigrams(existing);
  if (b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return round3(inter / a.size);
}

function isSamePath(a, b) {
  return normalizeCardPath(a, '') === normalizeCardPath(b, '');
}

/**
 * 从链路命中生成注入条目。
 * @param {object} args
 * @param {string} args.queryText 本轮**真实用户消息**原文（不是 buildQueryText 的拼接串）
 * @param {object} args.store loadLinks() 的返回值
 * @param {object[]} args.cards loadCards() 的卡片
 * @param {string[]} [args.seenPaths] 本轮已注入过的卡路径（路径级去重）
 * @param {string[]} [args.injectedTexts] 本轮已注入文本（文本级去重）
 * @param {object} [args.options]
 * @returns {{items:object[], matchedTerms:string[], tokens:number, stats:object}}
 */
export function selectLinkItems({
  queryText = '',
  store = null,
  cards = [],
  seenPaths = [],
  injectedTexts = [],
  options = {},
} = {}) {
  const cfg = normalizeLinksConfig(options.links ?? LINKS_DEFAULTS);
  const privacyScan = typeof options.privacyScan === 'function' ? options.privacyScan : defaultPrivacyScan;
  const privacyPolicy = options.privacyPolicy === 'title' ? 'title' : 'drop';
  const maxItems = Math.max(1, Math.min(5, Number(options.maxItems) || cfg.maxCardsPerTurn));
  const budgetTokens = Math.max(50, Math.min(2000, Number(options.budgetTokens) || 2000));
  const maxExcerptTokens = Math.max(40, Math.min(240, Number(options.maxExcerptTokens) || cfg.maxExcerptTokens));
  const stats = {
    candidates: 0,
    injected: 0,
    terms: 0,
    droppedByMissingCard: 0,
    droppedBySeen: 0,
    droppedByLocalOnly: 0,
    droppedByPrivacy: 0,
    droppedByDedupe: 0,
    droppedByBudget: 0,
    droppedByMaxItems: 0,
    redactedByPrivacy: 0,
  };
  const empty = { items: [], matchedTerms: [], tokens: 0, stats };
  if (!store || store.error || !Array.isArray(store.edges) || store.edges.length === 0) return empty;
  if (String(queryText ?? '').trim() === '' || !Array.isArray(cards) || cards.length === 0) return empty;

  const match = linkCardsForText(queryText, store.edges, cfg);
  stats.terms = match.matchedTerms.length;
  if (match.matchedTerms.length === 0) return { ...empty, matchedTerms: [] };

  const cardIndex = new Map();
  for (const card of cards) {
    cardIndex.set(normalizeCardPath(card?.path, ''), card);
  }
  const seen = new Set((Array.isArray(seenPaths) ? seenPaths : []).map((p) => normalizeCardPath(p, '')));
  const injectedList = Array.isArray(injectedTexts) ? injectedTexts : [];
  const items = [];
  let tokens = 0;
  for (const candidate of match.cards) {
    stats.candidates += 1;
    const card = cardIndex.get(normalizeCardPath(candidate.cardPath, ''));
    if (!card) { stats.droppedByMissingCard += 1; continue; }
    if (seen.has(normalizeCardPath(card.path, ''))) { stats.droppedBySeen += 1; continue; }
    if (card.localOnly === true) { stats.droppedByLocalOnly += 1; continue; }
    if (items.length >= maxItems) { stats.droppedByMaxItems += 1; continue; }

    const hits = candidate.terms.map((term) => ({ phrase: term, weight: 1.5 + Math.min(1, Array.from(term).length / 8) }));
    let excerpt = pickExcerpt(card, hits, maxExcerptTokens);
    let redacted = false;
    // 2026-11-26 P1-1 修：标题/路径命中一律整卡丢弃（与 recall-core.mjs:594-595 对齐）；
    // privacyPolicy='title' 只作用于「摘要命中」——摘要命中时保留标题 + [已隐藏]。
    if (privacyBlocked(privacyScan, card.title) || privacyBlocked(privacyScan, card.path)) {
      stats.droppedByPrivacy += 1;
      continue;
    }
    if (privacyBlocked(privacyScan, excerpt)) {
      if (privacyPolicy === 'title') {
        excerpt = PRIVACY_HIDDEN_MARK;
        redacted = true;
        stats.redactedByPrivacy += 1;
      } else {
        stats.droppedByPrivacy += 1;
        continue;
      }
    }
    if (!redacted && injectedList.length > 0) {
      const duplicated = injectedList.some((text) => containment(excerpt, text) >= DEDUPE_CONTAINMENT);
      if (duplicated) { stats.droppedByDedupe += 1; continue; }
    }

    const item = {
      path: normalizeCardPath(card.path, ''),
      title: String(card.title ?? card.path ?? ''),
      score: linkScore(candidate.weight),
      reason: LINK_REASON_TEXT,
      source: LINK_SOURCE,
      excerpt,
      link: { weight: candidate.weight, terms: candidate.terms.slice(0, 6) },
      ...(redacted ? { privacyRedacted: true } : {}),
    };
    const nextTokens = estimateTokens(renderInjection({ items: [...items, item] }, { privacyScan }));
    if (nextTokens > budgetTokens) { stats.droppedByBudget += 1; continue; }
    items.push(item);
    tokens = nextTokens;
  }
  stats.injected = items.length;
  return { items, matchedTerms: match.matchedTerms, tokens, stats };
}

/** 链路条目的标题行（link 场景下带上命中词，方便审计）。 */
export function renderLinkItemLine(item) {
  const path = privacyBlocked(defaultPrivacyScan, item.path) ? PRIVACY_HIDDEN_PATH : sanitizeDataText(item.path, 200);
  const terms = Array.isArray(item?.link?.terms) ? item.link.terms.join('/') : '';
  return `- 《${sanitizeDataText(item.title, 160)}》（${path} · 相关度 ${Number(item.score).toFixed(2)}${terms ? ` · 命中 ${sanitizeDataText(terms, 80)}` : ''}）`;
}
