// edges.js — 1.8.11 记忆网络边表（recall-edges/v1）
//
// 与 links.jsonl 分开：links 是「词→卡」的检索边，edges 是「卡→卡」的语义边。
// 存储：<memoryRoot>/.longlive/recall/edges.jsonl，一行一条边。
// 读路径 fail-open：文件缺失/坏行只计数，不抛、不影响既有召回。

import fs from 'node:fs';
import path from 'node:path';
import { normalizeCardPath } from './links.mjs';
import { estimateTokens } from './recall-core.mjs';
import { isHistoricalQuery } from '../memory/lifecycle.js';

export { isHistoricalQuery };

export const EDGES_SCHEMA = 'recall-edges/v1';
export const EDGE_TYPES = Object.freeze([
  'supersedes',
  'superseded_by',
  'deprecated_by',
  'conflicts_with',
  'answers_with',
  'derived_from',
  'mentions',
  'same_topic',
]);
// 1-hop 扩展的优先级（越小越先注入）。
export const EXPAND_PRIORITY = Object.freeze({
  deprecated_by: 0,
  conflicts_with: 1,
  superseded_by: 2,
  answers_with: 3,
});
// 历史查询词判定统一走 src/memory/lifecycle.js 的 isHistoricalQuery（D9 单一实现）。

export function edgesPaths(memoryRoot) {
  const dir = path.join(String(memoryRoot ?? ''), '.longlive', 'recall');
  return { dir, file: path.join(dir, 'edges.jsonl') };
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** evidence: null | string | { path, sha256?, lines?:[start,end], quote? } */
export function normalizeEvidence(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text === '' ? null : { path: text };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const evidence = {};
  const p = normalizeText(raw.path);
  if (p) evidence.path = p.replace(/\\/g, '/');
  if (typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(raw.sha256)) {
    evidence.sha256 = raw.sha256.toLowerCase();
  }
  if (Array.isArray(raw.lines) && raw.lines.length === 2) {
    const start = Number(raw.lines[0]);
    const end = Number(raw.lines[1]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start) {
      evidence.lines = [start, end];
    }
  }
  if (typeof raw.quote === 'string' && raw.quote.trim() !== '') {
    evidence.quote = raw.quote.trim();
  }
  return Object.keys(evidence).length > 0 ? evidence : null;
}

/** 归一化一条边；非法返回 null（调用方计入 dropped）。 */
export function normalizeEdge(raw, { memoryRoot = '' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const from = normalizeCardPath(raw.from ?? raw.source, memoryRoot);
  const to = normalizeCardPath(raw.to ?? raw.target, memoryRoot);
  const type = normalizeText(raw.type);
  if (!from || !to || from === to) return null;
  if (!EDGE_TYPES.includes(type)) return null;
  return {
    from,
    to,
    type,
    evidence: normalizeEvidence(raw.evidence),
    confidence: clampConfidence(raw.confidence),
    created_at: normalizeText(raw.created_at ?? raw.createdAt) || null,
    source: normalizeText(raw.source) || null,
  };
}

export function edgeKey(edge) {
  return `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
}

/** 去重：同 key 保留 confidence 更高的；持平保留先出现的。 */
export function dedupeEdges(edges) {
  const byKey = new Map();
  let deduped = 0;
  for (const edge of edges) {
    const key = edgeKey(edge);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, edge); continue; }
    deduped += 1;
    if (edge.confidence > prev.confidence) byKey.set(key, edge);
  }
  return { edges: [...byKey.values()], deduped };
}

/** supersedes ↔ superseded_by 对称补边（只补缺失方向）。 */
export function symmetrizeEdges(edges) {
  const keys = new Set(edges.map(edgeKey));
  const added = [];
  const pairs = { supersedes: 'superseded_by', superseded_by: 'supersedes' };
  for (const edge of edges) {
    const reverseType = pairs[edge.type];
    if (!reverseType) continue;
    const reverse = { ...edge, from: edge.to, to: edge.from, type: reverseType };
    const key = edgeKey(reverse);
    if (!keys.has(key)) { keys.add(key); added.push(reverse); }
  }
  return { edges: [...edges, ...added], added: added.length };
}

function buildIndex(edges) {
  const byFrom = new Map();
  const byTo = new Map();
  for (const edge of edges) {
    if (!byFrom.has(edge.from)) byFrom.set(edge.from, []);
    byFrom.get(edge.from).push(edge);
    if (!byTo.has(edge.to)) byTo.set(edge.to, []);
    byTo.get(edge.to).push(edge);
  }
  return { byFrom, byTo };
}

export function backlinksFor(cardPath, edges, { memoryRoot = '' } = {}) {
  const rel = normalizeCardPath(cardPath, memoryRoot);
  return edges.filter((edge) => edge.to === rel);
}

export function parseEdgesText(text, { memoryRoot = '' } = {}) {
  const edges = [];
  let badLines = 0;
  let dropped = 0;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    const edge = normalizeEdge(row, { memoryRoot });
    if (!edge) { dropped += 1; continue; }
    edges.push(edge);
  }
  const deduped = dedupeEdges(edges);
  const symmetric = symmetrizeEdges(deduped.edges);
  return {
    edges: symmetric.edges,
    stats: {
      parsed: edges.length,
      badLines,
      dropped,
      deduped: deduped.deduped,
      symmetrized: symmetric.added,
      kept: symmetric.edges.length,
    },
  };
}

/**
 * 读 edges.jsonl。mtime/size 缓存与 links.mjs 同款；坏文件 fail-open。
 * @returns {{present:boolean,path:string,edges:Array,stats:object,error:string|null}}
 */
export function loadEdges({ memoryRoot, cache } = {}) {
  const paths = edgesPaths(memoryRoot);
  const empty = {
    schema: EDGES_SCHEMA,
    present: false,
    path: paths.file,
    bytes: 0,
    mtimeMs: 0,
    size: 0,
    edges: [],
    stats: { parsed: 0, badLines: 0, dropped: 0, deduped: 0, symmetrized: 0, kept: 0 },
    error: null,
  };
  try {
    const stat = fs.statSync(paths.file);
    if (cache && cache.path === paths.file && cache.mtimeMs === stat.mtimeMs
      && cache.size === stat.size && cache.store) {
      return cache.store;
    }
    const text = fs.readFileSync(paths.file, 'utf8');
    const parsed = parseEdgesText(text, { memoryRoot });
    const store = {
      ...empty,
      present: true,
      bytes: Buffer.byteLength(text, 'utf8'),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      edges: parsed.edges,
      stats: parsed.stats,
    };
    if (cache) {
      cache.path = paths.file;
      cache.mtimeMs = stat.mtimeMs;
      cache.size = stat.size;
      cache.store = store;
    }
    return store;
  } catch (error) {
    const code = error?.code ?? 'E_EDGES_READ';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      const store = { ...empty, present: false };
      if (cache) { cache.path = paths.file; cache.mtimeMs = 0; cache.size = -1; cache.store = store; }
      return store;
    }
    return { ...empty, error: `E_EDGES_READ:${code}` };
  }
}

export function serializeEdges(edges) {
  return edges.map((edge) => JSON.stringify(edge)).join('\n') + '\n';
}

function cardMapOf(cards) {
  const map = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== 'object') continue;
    const key = normalizeCardPath(card.path ?? card.rel ?? card.abs ?? '', '');
    if (key) map.set(key, card);
  }
  return map;
}

function clipSentence(text, maxChars = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, Math.max(1, maxChars - 1))}…` : flat;
}

/** 目标卡正文首句（跳过 markdown 标题，剥列表符/引用符/[[wikilink]]）。 */
function firstBodySentence(card) {
  const body = typeof card?.body === 'string' ? card.body : '';
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const line = trimmed
      .replace(/^[-*>]\s*/, '')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .trim();
    if (line !== '') return clipSentence(line, 120);
  }
  return '';
}

// H3：扩展条目的 excerpt 不只是关系标签 + evidence.path，还要带一句可指认的具体话：
// evidence.quote 优先（边自己的证据句），其次目标卡 summary，再其次目标卡正文首句。
function relationSentence(edge, target) {
  const typeLabel = {
    deprecated_by: '已被取代',
    conflicts_with: '与此卡冲突',
    superseded_by: '被后续卡取代',
    answers_with: '回答该问题',
    derived_from: '派生自',
    supersedes: '取代了',
    mentions: '提及',
    same_topic: '同主题',
  }[edge.type] ?? edge.type;
  const evidence = edge.evidence?.path ? `，证据 ${edge.evidence.path}` : '';
  const quote = typeof edge.evidence?.quote === 'string' ? clipSentence(edge.evidence.quote, 120) : '';
  const summary = typeof target?.summary === 'string' && target.summary.trim() !== ''
    ? clipSentence(target.summary, 120)
    : '';
  const specific = quote || summary || firstBodySentence(target);
  return `${typeLabel}${evidence}${specific === '' ? '' : `：${specific}`}`;
}

/**
 * 1-hop 扩展。
 * @param {Array<{path:string,title?:string}>} baseItems 已召回项
 * @param {object} opts
 * @param {Array} opts.edges 归一化边
 * @param {number} opts.budget 剩余 token 预算
 * @param {Array} [opts.cards] 卡列表（title/summary）
 * @param {(cardPath:string)=>string|null} [opts.lifecycleOf] 返回 'canonical'|'historical'|null
 * @param {boolean} [opts.allowHistorical] 历史查询才放行 historical 目标
 * @param {string} [opts.queryText] 用于判断是否历史查询（allowHistorical 未显式给时）
 * @param {{memoryRoot?:string}} [opts.pathOptions]
 */
export function expandEdges(baseItems, {
  edges = [],
  budget = 2000,
  cards = [],
  lifecycleOf = null,
  allowHistorical,
  queryText = '',
  memoryRoot = '',
} = {}) {
  const allowHistory = allowHistorical ?? isHistoricalQuery(queryText);
  const cardsByPath = cardMapOf(cards);
  const { byFrom, byTo } = buildIndex(edges);
  const basePaths = new Set();
  for (const item of baseItems) {
    const rel = normalizeCardPath(item?.path ?? '', memoryRoot);
    if (rel) basePaths.add(rel);
  }
  const candidates = [];
  const walked = new Set();
  for (const item of baseItems) {
    const rel = normalizeCardPath(item?.path ?? '', memoryRoot);
    if (!rel) continue;
    const incident = [];
    for (const edge of byFrom.get(rel) ?? []) incident.push({ edge, target: edge.to });
    for (const edge of byTo.get(rel) ?? []) incident.push({ edge, target: edge.from });
    for (const { edge, target } of incident) {
      if (!(edge.type in EXPAND_PRIORITY)) continue;
      walked.add(edgeKey(edge));
      candidates.push({ edge, target, priority: EXPAND_PRIORITY[edge.type] });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority
    || b.edge.confidence - a.edge.confidence
    || edgeKey(a.edge).localeCompare(edgeKey(b.edge)));

  const items = [];
  const seen = new Set(basePaths);
  const dropped = [];
  let tokens = 0;
  let injected = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate.target)) continue;
    const card = cardsByPath.get(candidate.target);
    if (!card) { dropped.push({ path: candidate.target, reason: 'missing-card' }); continue; }
    const lifecycle = lifecycleOf ? lifecycleOf(candidate.target) : null;
    if (lifecycle === 'historical' && !allowHistory) {
      dropped.push({ path: candidate.target, reason: 'historical' });
      continue;
    }
    const title = String(card.title ?? card.fields?.title ?? candidate.target);
    const excerpt = relationSentence(candidate.edge, card);
    const text = `- 《${title}》（${candidate.target}）\n${excerpt}`;
    const cost = estimateTokens(text);
    if (tokens + cost > budget) { dropped.push({ path: candidate.target, reason: 'budget' }); continue; }
    tokens += cost;
    injected += 1;
    seen.add(candidate.target);
    items.push({
      path: candidate.target,
      title,
      score: 0,
      excerpt,
      lifecycle,
      edge: {
        from: candidate.edge.from,
        to: candidate.edge.to,
        type: candidate.edge.type,
        evidence: candidate.edge.evidence,
      },
    });
  }
  return {
    items,
    tokens,
    walked: walked.size,
    injected,
    dropped,
  };
}
