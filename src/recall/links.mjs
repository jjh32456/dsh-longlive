/**
 * 1.8.8 M2「链路层」：term → 卡路径 的本地可学习链路表。
 *
 * 目标（用户原话）：我说我要做什么，就直连老记忆。链路表是「词 → 卡」的直连边，
 * 运行时只做**字面命中**（用户消息里出现 term 就把它关联的卡放进候选），
 * 不做语义猜测；语义档由 recall-core 的既有打分器补漏。
 *
 * 存储：`<memoryRoot>/.longlive/recall/links.jsonl`，一行一条边：
 *   {"term":"编曲","cardPath":"topics/arrange-assets.md","weight":13.63,
 *    "source":"seed","evidence":{"n":93,"df":6,"tier":"primary","matchKind":"title",
 *      "count":93,"sessions":[],"lastUsedAt":"...","decayedPeriods":0},
 *    "createdAt":"...","updatedAt":"..."}
 *
 * 隐私边界（写进 docs/AUTO-RECALL.md）：
 *   - 只存 term / 卡路径 / 计数 / 时间，**不存用户原句**；
 *   - 卡路径是记忆根内相对路径（POSIX 斜杠），跨机器可迁移；
 *   - 审计行同样只记 term、卡路径、权重变化，不记原句。
 *
 * 写回纪律：tmp → rename 原子写；写前备份（backups/links-<ts>.jsonl，保留 5 份）；
 * 每次写追加 `.longlive/recall/links-audit.jsonl` 一行。文件损坏/不可解析时
 * 一律 fail-open：本次不用链路、**不回写**（避免把用户数据覆盖成空表）。
 */

import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const LINKS_SCHEMA = 'recall-links/v1';
export const LINKS_DIR_REL = join('.longlive', 'recall');
export const LINKS_FILE_NAME = 'links.jsonl';
export const LINKS_AUDIT_FILE_NAME = 'links-audit.jsonl';
export const LINKS_BACKUP_DIR_NAME = 'backups';
export const LINKS_KEEP_BACKUPS = 5;

/** 链路层默认值：全部偏保守（宁少插，不多插）。 */
export const LINKS_DEFAULTS = Object.freeze({
  enabled: true,
  learn: true,
  // 命中阈值：低于它的边不参与直连（衰减下来的旧边会自然掉出）。
  minWeight: 0.5,
  // 规格 §2.4：单 term ≤5 卡、单卡 ≤50 term、单轮 ≤5 卡。
  maxCardsPerTerm: 5,
  maxTermsPerCard: 50,
  maxCardsPerTurn: 5,
  // 文件规模上界（超出按权重裁掉最低的 learned 边，seed 边最后才动）。
  maxEdges: 5000,
  // 规格 §2.3：N 天未用衰减；每 N 天乘一次 factor。
  decayAfterDays: 30,
  decayFactor: 0.85,
  decayFloor: 0.01,
  // 反馈增量：确认 +1，否认 −1.5（否认比确认更可信：他明确说错就是错）。
  confirmDelta: 1,
  denyDelta: -1.5,
  // 单条摘要 token 上限（链路命中也要吃既有 budget）。
  maxExcerptTokens: 140,
  // 学习时单轮最多提多少个 term（防止长消息把表塞爆）。
  maxTermsPerTurn: 12,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** 归一化配置；未知值一律回落到默认（坏配置不许让召回整条挂掉）。 */
export function normalizeLinksConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const num = (input, fallback, min, max) => {
    const n = Number(input);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  return {
    enabled: value.enabled !== false,
    learn: value.learn !== false,
    minWeight: num(value.minWeight, LINKS_DEFAULTS.minWeight, 0, 1000),
    maxCardsPerTerm: Math.floor(num(value.maxCardsPerTerm, LINKS_DEFAULTS.maxCardsPerTerm, 1, 50)),
    maxTermsPerCard: Math.floor(num(value.maxTermsPerCard, LINKS_DEFAULTS.maxTermsPerCard, 1, 500)),
    maxCardsPerTurn: Math.floor(num(value.maxCardsPerTurn, LINKS_DEFAULTS.maxCardsPerTurn, 1, 5)),
    maxEdges: Math.floor(num(value.maxEdges, LINKS_DEFAULTS.maxEdges, 10, 100000)),
    decayAfterDays: num(value.decayAfterDays, LINKS_DEFAULTS.decayAfterDays, 1, 3650),
    decayFactor: num(value.decayFactor, LINKS_DEFAULTS.decayFactor, 0.1, 0.999),
    decayFloor: num(value.decayFloor, LINKS_DEFAULTS.decayFloor, 0, 1),
    confirmDelta: num(value.confirmDelta, LINKS_DEFAULTS.confirmDelta, 0.01, 100),
    denyDelta: num(value.denyDelta, LINKS_DEFAULTS.denyDelta, -100, -0.01),
    maxExcerptTokens: Math.floor(num(value.maxExcerptTokens, LINKS_DEFAULTS.maxExcerptTokens, 20, 1000)),
    maxTermsPerTurn: Math.floor(num(value.maxTermsPerTurn, LINKS_DEFAULTS.maxTermsPerTurn, 1, 100)),
  };
}

/** 记忆根下的链路文件路径。 */
export function linksPaths(memoryRoot) {
  const root = String(memoryRoot ?? '');
  const dir = join(root, LINKS_DIR_REL);
  return {
    dir,
    file: join(dir, LINKS_FILE_NAME),
    audit: join(dir, LINKS_AUDIT_FILE_NAME),
    backupDir: join(dir, LINKS_BACKUP_DIR_NAME),
  };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function iso(now) {
  const n = Number(now);
  return new Date(Number.isFinite(n) ? n : Date.now()).toISOString();
}

/** 卡路径归一化：反斜杠转 POSIX；绝对路径尽量折成记忆根相对路径。 */
export function normalizeCardPath(raw, memoryRoot = '') {
  let p = String(raw ?? '').trim().replace(/\\/g, '/');
  if (p === '') return '';
  const root = String(memoryRoot ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (root !== '' && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    p = p.slice(root.length + 1);
  }
  p = p.replace(/^\.\//, '').replace(/\/+/g, '/');
  // 折回记忆根内的已知顶层目录（seed 里可能带绝对前缀但根不同 / 盘符不同）。
  const marker = p.toLowerCase().lastIndexOf('/longlive-memory/');
  if (marker >= 0) p = p.slice(marker + '/longlive-memory/'.length);
  return p;
}

/** ASCII term 需要词边界，「编曲」这类 CJK term 直接子串命中。 */
const ASCII_TERM_RE = /^[A-Za-z0-9._-]+$/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * term 是否在文本里字面出现。
 * - CJK（含中英混排里带 CJK 的）→ 子串命中；
 * - 纯 ASCII term（ace/dsh/1.8.0）→ 要求前后不是字母数字下划线，避免
 *   `ace` 命中 `space`、`dsh` 命中 `dshxyz`。
 * @param {string} text
 * @param {string} term
 * @returns {boolean}
 */
export function termInText(text, term) {
  const hay = String(text ?? '');
  const needle = String(term ?? '');
  if (hay === '' || needle === '') return false;
  if (!ASCII_TERM_RE.test(needle)) return hay.includes(needle);
  const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(needle)}([^A-Za-z0-9_]|$)`, 'i');
  return re.test(hay);
}

/** 一条边的稳定 key。 */
export function edgeKey(term, cardPath) {
  return `${term}\u0000${cardPath}`;
}

function makeEdge({ term, cardPath, weight, source, evidence, createdAt, updatedAt }) {
  const t = String(term ?? '').trim();
  const p = String(cardPath ?? '').trim();
  if (t === '' || p === '') return null;
  const w = Number(weight);
  if (!Number.isFinite(w) || w <= 0) return null;
  const now = updatedAt ?? createdAt ?? new Date().toISOString();
  return {
    term: t,
    cardPath: p,
    weight: round3(w),
    source: source === 'learned' ? 'learned' : 'seed',
    evidence: evidence && typeof evidence === 'object' ? { ...evidence } : {},
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

/** 稳定的行序列化：字段顺序固定，测试可逐字节比对。 */
export function serializeEdge(edge) {
  return JSON.stringify({
    term: edge.term,
    cardPath: edge.cardPath,
    weight: edge.weight,
    source: edge.source,
    evidence: edge.evidence ?? {},
    createdAt: edge.createdAt,
    updatedAt: edge.updatedAt,
  });
}

/** 确定性序列化整张表（term 升序、cardPath 升序）。 */
export function serializeLinks(edges) {
  const list = Array.isArray(edges) ? edges.slice() : [];
  list.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : a.cardPath < b.cardPath ? -1 : a.cardPath > b.cardPath ? 1 : 0));
  return list.map((e) => `${serializeEdge(e)}\n`).join('');
}

/**
 * 解析 links.jsonl 文本；坏行计数而不是抛错（损坏 → fail-open）。
 * 同一 (term, cardPath) 重复时保留权重更高的一条，计数取最大。
 * @param {string} text
 * @param {{memoryRoot?:string}} [opts]
 * @returns {{edges:object[], bad:number, duplicates:number, lines:number}}
 */
export function parseLinksText(text, { memoryRoot = '' } = {}) {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  const map = new Map();
  let bad = 0;
  let duplicates = 0;
  let lineCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    lineCount += 1;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      bad += 1;
      continue;
    }
    if (!row || typeof row !== 'object') { bad += 1; continue; }
    const term = String(row.term ?? '').trim();
    const cardPath = normalizeCardPath(row.cardPath, memoryRoot);
    const weight = Number(row.weight);
    if (term === '' || cardPath === '' || !Number.isFinite(weight) || weight <= 0) { bad += 1; continue; }
    const evidence = row.evidence && typeof row.evidence === 'object' ? { ...row.evidence } : {};
    const edge = makeEdge({
      term,
      cardPath,
      weight,
      source: row.source,
      evidence,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : undefined,
    });
    if (!edge) { bad += 1; continue; }
    const key = edgeKey(edge.term, edge.cardPath);
    const existing = map.get(key);
    if (existing) {
      duplicates += 1;
      if (edge.weight > existing.weight) {
        edge.evidence = { ...existing.evidence, ...edge.evidence };
        map.set(key, edge);
      } else {
        existing.evidence = { ...(edge.evidence ?? {}), ...(existing.evidence ?? {}) };
      }
    } else {
      map.set(key, edge);
    }
  }
  const edges = [...map.values()];
  return { edges, bad, duplicates, lines: lineCount };
}

/**
 * 读取链路表。mtime+size 未变时直接用缓存（pre-step 每轮都会读）。
 * 任何异常都返回空表 + error 标记，绝不抛。
 * @param {object} args
 * @param {string} args.memoryRoot
 * @param {{path?:string,mtimeMs?:number,size?:number,store?:object}} [args.cache]
 * @returns {object} store
 */
export function loadLinks({ memoryRoot, cache } = {}) {
  const paths = linksPaths(memoryRoot);
  const empty = {
    schema: LINKS_SCHEMA,
    present: false,
    path: paths.file,
    bytes: 0,
    mtimeMs: 0,
    size: 0,
    edges: [],
    bad: 0,
    duplicates: 0,
    error: null,
    writable: true,
  };
  try {
    const stat = statSync(paths.file);
    if (cache && cache.path === paths.file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && cache.store) {
      return cache.store;
    }
    const text = readFileSync(paths.file, 'utf8');
    const parsed = parseLinksText(text, { memoryRoot });
    // 坏行过半视为损坏：不参与直连、也不允许回写覆盖。
    const corrupt = parsed.lines > 0 && parsed.bad > 0 && parsed.bad / parsed.lines > 0.5;
    const store = {
      ...empty,
      present: true,
      bytes: Buffer.byteLength(text, 'utf8'),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      edges: parsed.edges,
      bad: parsed.bad,
      duplicates: parsed.duplicates,
      error: corrupt ? 'E_LINKS_CORRUPT' : null,
      writable: !corrupt,
    };
    if (cache) {
      cache.path = paths.file;
      cache.mtimeMs = stat.mtimeMs;
      cache.size = stat.size;
      cache.store = store;
    }
    return store;
  } catch (error) {
    const code = error?.code ?? 'E_LINKS_READ';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      const store = { ...empty, error: null, present: false };
      if (cache) { cache.path = paths.file; cache.mtimeMs = 0; cache.size = -1; cache.store = store; }
      return store;
    }
    const store = { ...empty, error: 'E_LINKS_READ', writable: false, detail: String(error?.message ?? error) };
    if (cache) { cache.path = paths.file; cache.mtimeMs = 0; cache.size = -2; cache.store = store; }
    return store;
  }
}

/** 表里是否有需要衰减的边（只读判断，用于决定要不要触发一次维护写）。 */
export function linksNeedsDecay(store, { now = Date.now(), config = LINKS_DEFAULTS } = {}) {
  if (!store || !Array.isArray(store.edges) || store.edges.length === 0) return false;
  const cfg = normalizeLinksConfig(config);
  const nowMs = Number(now) || Date.now();
  return store.edges.some((edge) => {
    const last = Date.parse(edge.evidence?.lastUsedAt ?? edge.evidence?.lastAt ?? edge.updatedAt ?? edge.createdAt ?? '');
    if (!Number.isFinite(last)) return false;
    const periods = Math.floor((nowMs - last) / (cfg.decayAfterDays * DAY_MS));
    const applied = Number(edge.evidence?.decayedPeriods ?? 0) || 0;
    return periods > applied;
  });
}

/**
 * 按「N 天未用」对边衰减；已衰减过的周期不重复乘（evidence.decayedPeriods）。
 * @returns {{edges:object[], changes:object[]}}
 */
export function applyDecay(edges, { now = Date.now(), config = LINKS_DEFAULTS } = {}) {
  const cfg = normalizeLinksConfig(config);
  const nowMs = Number(now) || Date.now();
  const at = iso(nowMs);
  const changes = [];
  const next = (Array.isArray(edges) ? edges : []).map((edge) => {
    const last = Date.parse(edge.evidence?.lastUsedAt ?? edge.evidence?.lastAt ?? edge.updatedAt ?? edge.createdAt ?? '');
    if (!Number.isFinite(last)) return edge;
    const periods = Math.floor((nowMs - last) / (cfg.decayAfterDays * DAY_MS));
    const applied = Number(edge.evidence?.decayedPeriods ?? 0) || 0;
    if (periods <= applied) return edge;
    const factor = Math.pow(cfg.decayFactor, Math.min(periods - applied, 40));
    const nextWeight = round3(Math.max(cfg.decayFloor, edge.weight * factor));
    const updated = {
      ...edge,
      weight: nextWeight,
      updatedAt: at,
      evidence: { ...(edge.evidence ?? {}), decayedPeriods: periods, lastDecayAt: at },
    };
    changes.push({ term: edge.term, cardPath: edge.cardPath, from: edge.weight, to: nextWeight, delta: round3(nextWeight - edge.weight), reason: 'decay', periods: periods - applied });
    return updated;
  });
  return { edges: next, changes };
}

/**
 * 规格 §2.4 上限：单 term ≤5 卡、单卡 ≤50 term、总边数上界。
 * 超限时按权重升序裁掉，seed 边在同一权重下优先保留（seed 是基线证据）。
 * @returns {{edges:object[], dropped:object[]}}
 */
export function enforceCaps(edges, config = LINKS_DEFAULTS) {
  const cfg = normalizeLinksConfig(config);
  const dropped = [];
  const byTerm = new Map();
  for (const edge of edges) {
    const list = byTerm.get(edge.term);
    if (list) list.push(edge); else byTerm.set(edge.term, [edge]);
  }
  const kept = [];
  const orderOf = (edge) => (edge.source === 'seed' ? 0 : 1);
  const worse = (a, b) => (a.weight - b.weight) || (orderOf(b) - orderOf(a)) || (a.cardPath < b.cardPath ? -1 : 1);
  for (const [term, list] of byTerm) {
    const sorted = list.slice().sort(worse);
    const keep = sorted.slice(Math.max(0, sorted.length - cfg.maxCardsPerTerm));
    for (const edge of sorted.slice(0, Math.max(0, sorted.length - cfg.maxCardsPerTerm))) {
      dropped.push({ term, cardPath: edge.cardPath, weight: edge.weight, reason: 'term-card-cap' });
    }
    kept.push(...keep);
  }
  // 单卡 term 上限
  const byCard = new Map();
  for (const edge of kept) {
    const list = byCard.get(edge.cardPath);
    if (list) list.push(edge); else byCard.set(edge.cardPath, [edge]);
  }
  const kept2 = [];
  for (const [cardPath, list] of byCard) {
    const sorted = list.slice().sort(worse);
    const over = Math.max(0, sorted.length - cfg.maxTermsPerCard);
    for (const edge of sorted.slice(0, over)) dropped.push({ term: edge.term, cardPath, weight: edge.weight, reason: 'card-term-cap' });
    kept2.push(...sorted.slice(over));
  }
  // 总边数上界
  if (kept2.length <= cfg.maxEdges) return { edges: kept2, dropped };
  const sorted = kept2.slice().sort(worse);
  const over = kept2.length - cfg.maxEdges;
  for (const edge of sorted.slice(0, over)) dropped.push({ term: edge.term, cardPath: edge.cardPath, weight: edge.weight, reason: 'max-edges' });
  return { edges: sorted.slice(over), dropped };
}

/**
 * 把「上一轮注入 + 本轮反馈」落成权重变化（纯函数）。
 * - confirm：已有边 weight += confirmDelta；没有边则新建 learned 边（权重从 0 起 + confirmDelta）；
 * - deny：已有边 weight += denyDelta（可为负），跌到 ≤0 的边直接删；
 * - 无反馈：不动。
 * @param {object} args
 * @returns {{edges:object[], changes:object[], dropped:object[]}}
 */
export function applyFeedback({ edges, pending, feedback, now = Date.now(), config = LINKS_DEFAULTS, sessionId = '' } = {}) {
  const cfg = normalizeLinksConfig(config);
  const at = iso(now);
  const next = (Array.isArray(edges) ? edges : []).map((edge) => ({ ...edge, evidence: { ...(edge.evidence ?? {}) } }));
  const index = new Map(next.map((edge) => [edgeKey(edge.term, edge.cardPath), edge]));
  const changes = [];
  const dropped = [];
  if (feedback !== 'confirm' && feedback !== 'deny') return { edges: next, changes, dropped };
  const terms = Array.isArray(pending?.terms) ? pending.terms : [];
  const injected = Array.isArray(pending?.injected) ? pending.injected : [];
  const delta = feedback === 'confirm' ? cfg.confirmDelta : cfg.denyDelta;
  for (const card of injected) {
    const cardPath = normalizeCardPath(card?.path, '');
    if (cardPath === '') continue;
    for (const term of terms) {
      const key = edgeKey(term, cardPath);
      const existing = index.get(key);
      if (existing) {
        const from = existing.weight;
        const to = round3(from + delta);
        if (to <= 0) {
          dropped.push({ term, cardPath, weight: from, reason: 'deny-to-zero' });
          index.delete(key);
          changes.push({ term, cardPath, from, to: 0, delta, reason: feedback, removed: true });
          continue;
        }
        existing.weight = to;
        existing.updatedAt = at;
        existing.evidence = {
          ...existing.evidence,
          count: (Number(existing.evidence?.count ?? 0) || 0) + (feedback === 'confirm' ? 1 : 0),
          denyCount: (Number(existing.evidence?.denyCount ?? 0) || 0) + (feedback === 'deny' ? 1 : 0),
          lastAt: at,
          lastUsedAt: at,
          ...(sessionId ? { sessions: uniqSessions(existing.evidence?.sessions, sessionId) } : {}),
        };
        changes.push({ term, cardPath, from, to, delta, reason: feedback });
      } else if (feedback === 'confirm') {
        const edge = makeEdge({
          term,
          cardPath,
          weight: cfg.confirmDelta,
          source: 'learned',
          evidence: { count: 1, denyCount: 0, cooccurCount: 1, lastAt: at, lastUsedAt: at, sessions: sessionId ? [sessionId] : [] },
          createdAt: at,
          updatedAt: at,
        });
        if (edge) {
          index.set(key, edge);
          next.push(edge);
          changes.push({ term, cardPath, from: 0, to: edge.weight, delta: edge.weight, reason: 'learned' });
        }
      }
    }
  }
  const kept = next.filter((edge) => index.has(edgeKey(edge.term, edge.cardPath)));
  const capped = enforceCaps(kept, cfg);
  for (const item of capped.dropped) changes.push({ ...item, reason: item.reason, removed: true });
  return { edges: capped.edges, changes, dropped: [...dropped, ...capped.dropped] };
}

function uniqSessions(list, sessionId) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (!out.includes(sessionId)) out.push(sessionId);
  return out.slice(-10);
}

/** 对文本做 term 匹配：返回按 term 长度降序的命中项（对应多条边）。 */
export function matchTerms(text, edges, config = LINKS_DEFAULTS) {
  const cfg = normalizeLinksConfig(config);
  const byTerm = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge || Number(edge.weight) < cfg.minWeight) continue;
    const list = byTerm.get(edge.term);
    if (list) list.push(edge); else byTerm.set(edge.term, [edge]);
  }
  const matched = [];
  for (const [term, list] of byTerm) {
    if (!termInText(text, term)) continue;
    matched.push({ term, weight: Math.max(...list.map((e) => Number(e.weight) || 0)), edges: list });
  }
  matched.sort((a, b) => (Array.from(b.term).length - Array.from(a.term).length) || (b.weight - a.weight) || (a.term < b.term ? -1 : 1));
  return matched;
}

/**
 * term 命中 → 卡候选（按最大权重排序；同卡只留最高权重的一条边）。
 * @returns {{cards:{cardPath:string, term:string, weight:number, terms:string[]}[], matchedTerms:string[]}}
 */
export function linkCardsForText(text, edges, config = LINKS_DEFAULTS) {
  const cfg = normalizeLinksConfig(config);
  const matched = matchTerms(text, edges, cfg);
  const byCard = new Map();
  for (const hit of matched) {
    const sorted = hit.edges.slice().sort((a, b) => (b.weight - a.weight) || (a.cardPath < b.cardPath ? -1 : 1));
    // 单 term 最多 maxCardsPerTerm 张卡，防止一个高频词把本轮候选撑爆。
    for (const edge of sorted.slice(0, cfg.maxCardsPerTerm)) {
      const current = byCard.get(edge.cardPath);
      if (current) {
        current.weight = Math.max(current.weight, Number(edge.weight) || 0);
        if (!current.terms.includes(hit.term)) current.terms.push(hit.term);
      } else {
        byCard.set(edge.cardPath, { cardPath: edge.cardPath, term: hit.term, weight: Number(edge.weight) || 0, terms: [hit.term] });
      }
    }
  }
  const cards = [...byCard.values()].sort((a, b) => (b.weight - a.weight) || (a.cardPath < b.cardPath ? -1 : 1));
  return { cards: cards.slice(0, cfg.maxCardsPerTurn), matchedTerms: matched.map((m) => m.term), truncated: cards.length > cfg.maxCardsPerTurn };
}

/**
 * 从「本轮真实用户消息 + 本轮注入的卡」提候选 term（学习用，不含语义猜测）：
 *   a) 已有链路表里的 term 出现在消息里；
 *   b) 注入卡的 scope_in / aliases 词表里**字面出现**在消息里的词（长度 ≥2 以防噪声）。
 * @returns {string[]}
 */
export function extractLearningTerms({ messageText, injected = [], cards = [], edges = [], config = LINKS_DEFAULTS } = {}) {
  const cfg = normalizeLinksConfig(config);
  const text = String(messageText ?? '');
  if (text.trim() === '') return [];
  const out = [];
  const push = (term) => {
    const t = String(term ?? '').trim();
    if (t === '' || out.includes(t)) return;
    if (Array.from(t).length < 2) return;
    if (!termInText(text, t)) return;
    out.push(t);
  };
  for (const hit of matchTerms(text, edges, cfg)) push(hit.term);
  const cardIndex = new Map((Array.isArray(cards) ? cards : []).map((card) => [String(card?.path ?? ''), card]));
  for (const item of Array.isArray(injected) ? injected : []) {
    const card = cardIndex.get(normalizeCardPath(item?.path, ''));
    if (!card) continue;
    for (const phrase of [...(Array.isArray(card.scopeIn) ? card.scopeIn : []), ...(Array.isArray(card.aliases) ? card.aliases : [])]) {
      push(phrase);
      if (out.length >= cfg.maxTermsPerTurn) break;
    }
    if (out.length >= cfg.maxTermsPerTurn) break;
  }
  return out.slice(0, cfg.maxTermsPerTurn);
}

/**
 * 组装「上一轮注入的待学习记录」。只放内存（st.pendingLink），不落盘：
 * 没有下一轮反馈就没有学习，这是规格允许的边界（文档写明）。
 */
export function buildPendingLearning({ turn, messageText, injected = [], cards = [], edges = [], now = Date.now(), config = LINKS_DEFAULTS } = {}) {
  const terms = extractLearningTerms({ messageText, injected, cards, edges, config });
  if (terms.length === 0) return null;
  return {
    turn: Number(turn) || 0,
    at: iso(now),
    terms,
    // 只记路径/分数/来源，不记原句。
    injected: (Array.isArray(injected) ? injected : []).map((item) => ({
      path: String(item?.path ?? ''),
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
      source: item?.source === 'link' ? 'link' : item?.source === 'archive' ? 'archive' : 'file',
    })).filter((item) => item.path !== ''),
  };
}

function pruneBackups(backupDir) {
  try {
    const files = readdirSync(backupDir)
      .filter((name) => /^links-.*\.jsonl$/.test(name))
      .map((name) => ({ name, mtimeMs: statSync(join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of files.slice(LINKS_KEEP_BACKUPS)) {
      try { unlinkSync(join(backupDir, stale.name)); } catch { /* 备份清理失败不影响写入 */ }
    }
  } catch { /* 目录不存在等：忽略 */ }
}

/**
 * 原子写链路表：tmp → rename；写前备份；写后追加审计行。
 * file 缺省 = <memoryRoot>/.longlive/recall/links.jsonl；给 file 时按该文件所在目录
 * 落 links-audit.jsonl / backups/（构建器的 --out 用这条）。
 * @returns {{ok:boolean, path:string, bytes:number, sha256:string, backupPath:string|null, error?:string}}
 */
export function writeLinksStore({ memoryRoot, file = '', edges, now = Date.now(), auditRows = [], backup = true } = {}) {
  const base = linksPaths(memoryRoot);
  const customFile = String(file ?? '').trim();
  const paths = customFile === ''
    ? base
    : (() => {
        const dir = dirname(customFile);
        return { dir, file: customFile, audit: join(dir, LINKS_AUDIT_FILE_NAME), backupDir: join(dir, LINKS_BACKUP_DIR_NAME) };
      })();
  const at = iso(now);
  try {
    mkdirSync(paths.dir, { recursive: true });
    const content = serializeLinks(edges);
    let backupPath = null;
    if (backup && existsSync(paths.file)) {
      mkdirSync(paths.backupDir, { recursive: true });
      const stamp = at.replace(/[:.]/g, '-');
      backupPath = join(paths.backupDir, `links-${stamp}.jsonl`);
      try {
        copyFileSync(paths.file, backupPath);
        pruneBackups(paths.backupDir);
      } catch {
        backupPath = null; // 备份失败不阻塞主写入，但审计里会记 backup:false
      }
    }
    const tmp = join(paths.dir, `.${LINKS_FILE_NAME}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, paths.file);
    const digest = sha256(content);
    const rows = Array.isArray(auditRows) && auditRows.length > 0 ? auditRows : [{ action: 'write' }];
    appendClaims(paths.audit, rows.map((row) => ({ at, ...row, sha256: digest, edges: Array.isArray(edges) ? edges.length : 0 })));
    return { ok: true, path: paths.file, bytes: Buffer.byteLength(content, 'utf8'), sha256: digest, backupPath };
  } catch (error) {
    return { ok: false, path: paths.file, bytes: 0, sha256: '', backupPath: null, error: String(error?.code ?? error?.message ?? error) };
  }
}

function appendClaims(auditPath, rows) {
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    let payload = '';
    for (const row of rows) payload += `${JSON.stringify(row)}\n`;
    appendFileSync(auditPath, payload);
  } catch { /* 审计写失败不许影响主流程 */ }
}

/** 追加一条审计行（不写表时用，例如「链路损坏，跳过学习」）。 */
export function appendLinksAudit({ memoryRoot, rows = [] } = {}) {
  const paths = linksPaths(memoryRoot);
  appendClaims(paths.audit, rows.map((row) => ({ at: iso(Date.now()), ...row })));
  return paths.audit;
}

/**
 * 会话级维护：有旧边需要衰减时做一次「衰减 + 原子写 + 备份 + 审计」。
 * 每个会话只尝试一次（由调用方置位），失败只返回 ok:false，绝不抛。
 */
export function runLinkMaintenance({ memoryRoot, store, now = Date.now(), config = LINKS_DEFAULTS, sessionId = '' } = {}) {
  try {
    if (!store || store.error || store.writable === false) return { ok: false, skipped: true, reason: 'not-writable' };
    if (!linksNeedsDecay(store, { now, config })) return { ok: false, skipped: true, reason: 'no-decay' };
    const cfg = normalizeLinksConfig(config);
    const decayed = applyDecay(store.edges, { now, config: cfg });
    if (decayed.changes.length === 0) return { ok: false, skipped: true, reason: 'no-change' };
    const capped = enforceCaps(decayed.edges, cfg);
    const written = writeLinksStore({
      memoryRoot,
      edges: capped.edges,
      now,
      auditRows: [{ action: 'decay', sessionId, changes: decayed.changes, dropped: capped.dropped }],
    });
    return { ok: written.ok === true, written, changes: decayed.changes };
  } catch (error) {
    return { ok: false, error: String(error?.code ?? error?.message ?? error) };
  }
}

/** 只读摘要（面板/报告用）。 */
export function summarizeLinksStore(store) {
  const edges = Array.isArray(store?.edges) ? store.edges : [];
  const terms = new Set();
  const cards = new Set();
  let learned = 0;
  for (const edge of edges) {
    terms.add(edge.term);
    cards.add(edge.cardPath);
    if (edge.source === 'learned') learned += 1;
  }
  return {
    present: store?.present === true,
    error: store?.error ?? null,
    edges: edges.length,
    learnedEdges: learned,
    terms: terms.size,
    cards: cards.size,
    bytes: Number(store?.bytes ?? 0),
    bad: Number(store?.bad ?? 0),
  };
}
