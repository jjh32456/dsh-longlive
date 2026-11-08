// src/memory/fts-query.js — M2-A/K2：FTS5 查询构造与文本预分词
//
// 依据 `evidence/FTS5-MEMGAP-EVIDENCE.md`（任务 实测）：
//   * 裸 query 直接进 MATCH 必炸（`1.6.8` → syntax error near "."、`session-c045`
//     → no such column、`- " ( ) * OR AND NOT` 各有固定语法错）；
//   * trigram tokenizer 覆盖中文 ≥3 字子串 / 版本号 / ID / 日期，但 2 字 CJK 与
//     2 字 ASCII 不命中；
//   * unicode61 只匹配完整 token，需要**预分词列**：bigram + 别名（2 字 CJK 靠它）。
//
// 本模块只做「把任意用户问题变成若干条可安全执行的 MATCH 候选」，不打开数据库：
//   buildFtsCandidates(text) → { raw: [{label, match}], terms: [{label, match}] }
// 调用方（event-index）对每条候选 try/catch + 参数绑定，全部失败/无命中 → NO_MATCH。
//
// 安全规则：NFKC → 去控制符 → 双引号剥除 → 所有候选一律「整段双引号包裹」；
// FTS 运算符词（OR/AND/NOT/NEAR）因此都按字面词处理，不进入语法层。

export const MAX_QUERY_CHARS = 200;

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ASCII_WORD_RE = /[A-Za-z0-9_][A-Za-z0-9_.:/\\-]*/g;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const VERSION_RE = /\bv?\d+(?:\.\d+){1,3}\b/g;
const CJK_TOKEN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** NFKC + strip control chars + drop double quotes + collapse whitespace. */
export function normalizeQuery(input) {
  const text = String(input ?? '');
  let out = '';
  try {
    out = text.normalize('NFKC');
  } catch {
    out = text;
  }
  return out
    .replace(CONTROL_RE, ' ')
    .replace(/["\u201c\u201d\u2018\u2019]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_CHARS);
}

/** All CJK bigrams of a run (2-char windows, deduped, order preserved). */
export function cjkBigrams(run) {
  const chars = Array.from(String(run ?? ''));
  const out = [];
  const seen = new Set();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const bigram = chars[i] + chars[i + 1];
    if (!seen.has(bigram)) {
      seen.add(bigram);
      out.push(bigram);
    }
  }
  return out;
}

/** Pre-tokenized term column text for the unicode61 shadow table. */
export function termTextOf(text) {
  const normalized = normalizeQuery(text);
  if (normalized === '') return '';
  const tokens = [];
  const seen = new Set();
  const push = (token) => {
    if (token === '' || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const run of normalized.match(CJK_RUN_RE) ?? []) {
    for (const bigram of cjkBigrams(run)) push(bigram);
  }
  for (const word of normalized.match(ASCII_WORD_RE) ?? []) push(word.toLowerCase());
  return tokens.join(' ');
}

/** Alias expansions: versions get a `v`-twin, hyphen ids get their parts. */
export function aliasesOf(text) {
  const normalized = normalizeQuery(text);
  const out = new Set();
  for (const match of normalized.match(VERSION_RE) ?? []) {
    if (match.startsWith('v')) out.add(match.slice(1));
    else out.add(`v${match}`);
  }
  for (const word of normalized.match(ASCII_WORD_RE) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length >= 3 && lower.includes('-')) {
      const parts = lower.split('-').filter((part) => part !== '');
      if (parts.length >= 2) {
        out.add(parts[parts.length - 1]);
        out.add(parts.slice(0, 2).join('-'));
      }
    }
  }
  return [...out];
}

function escapeLiteral(text) {
  return `"${String(text ?? '').replace(/"/g, '')}"`;
}

function segmentsOf(normalized) {
  return normalized
    .split(/[\s,;，；。！？!?、]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '"');
}

function uniqueCandidates(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.match !== 'string' || item.match === '') continue;
    if (seen.has(item.match)) continue;
    seen.add(item.match);
    out.push(item);
  }
  return out;
}

/**
 * Build safe MATCH candidates for both FTS tables.
 *
 * raw  = events_fts (trigram): 整句 phrase → 分段 AND → 分段 OR
 * terms= events_terms (unicode61): bigram/word/alias AND → OR → 整句 phrase
 */
export function buildFtsCandidates(input) {
  const normalized = normalizeQuery(input);
  if (normalized === '') return { normalized, raw: [], terms: [] };

  const segments = segmentsOf(normalized);
  const raw = uniqueCandidates([
    { label: 'phrase', match: escapeLiteral(normalized) },
    segments.length > 1
      ? { label: 'and-segments', match: segments.map(escapeLiteral).join(' AND ') }
      : null,
    segments.length > 1
      ? { label: 'or-segments', match: segments.map(escapeLiteral).join(' OR ') }
      : null,
  ]);

  const words = (normalized.match(ASCII_WORD_RE) ?? []).map((word) => word.toLowerCase());
  const bigrams = [];
  for (const run of normalized.match(CJK_RUN_RE) ?? []) bigrams.push(...cjkBigrams(run));
  const aliases = aliasesOf(normalized);
  const tokens = [...new Set([...bigrams, ...words, ...aliases])].filter((token) => token.length >= 1);
  const orderedTokens = tokens.slice(0, 24);
  const terms = uniqueCandidates([
    orderedTokens.length > 1
      ? { label: 'and-terms', match: orderedTokens.map(escapeLiteral).join(' AND ') }
      : null,
    orderedTokens.length > 0
      ? { label: 'or-terms', match: orderedTokens.map(escapeLiteral).join(' OR ') }
      : null,
    orderedTokens.length > 1
      ? { label: 'or-terms-bigram', match: bigrams.map(escapeLiteral).join(' OR ') }
      : null,
    { label: 'phrase', match: escapeLiteral(normalized) },
  ]);

  return { normalized, raw, terms };
}

/** Extract the meaningful CJK/ASCII terms kept in EventRecord.terms. */
export function extractTerms(text, extra = []) {
  const normalized = normalizeQuery(text);
  const out = new Set(extra.filter((value) => typeof value === 'string' && value.trim() !== ''));
  for (const match of normalized.match(VERSION_RE) ?? []) out.add(match);
  for (const match of normalized.match(/\d{4}-\d{2}-\d{2}/g) ?? []) out.add(match);
  for (const match of normalized.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) ?? []) out.add(match);
  for (const match of normalized.match(/\b(?:session|task|evt|rec|rv)[-_:][A-Za-z0-9-]{2,}\b/gi) ?? []) out.add(match);
  for (const run of normalized.match(CJK_TOKEN_RE) ?? []) {
    if (Array.from(run).length >= 2 && Array.from(run).length <= 12) out.add(run);
  }
  return [...out].slice(0, 60);
}
