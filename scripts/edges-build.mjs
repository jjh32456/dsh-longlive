#!/usr/bin/env node
/**
 * 1.8.11 · 记忆网络边表构建器（recall-edges/v1）
 *
 * 从可复核的离线来源推导「卡 → 卡」语义边，写入
 * `<memoryRoot>/.longlive/recall/edges.jsonl`（或 --out 指定的文件），供召回层的
 * 1-hop 边扩展（expandEdges）与 backlinks 使用。
 *
 * 三个来源（都可单独关掉）：
 *   1) 卡面显式边：frontmatter 里以边类型命名的 key（supersedes / conflicts_with / …）
 *      以及 `edges:` 里的简写项（`<type>: <path>` 或裸路径 → mentions）。
 *   2) 卡体 [[wikilink]] → mentions 边（只记「这张卡引用了那张卡」，不推断方向语义）。
 *   3) links.jsonl 共现：同一 term 下权重最高的若干张卡两两连 same_topic 边
 *      （弱关联元数据，固定 confidence 0.5；same_topic 不参与注入扩展）。
 *   4) 决策记录：lifecycle-plan.json 的 `edges[]`（机器可读、带 evidence/quote）。
 *
 * 诚实边界（写进统计输出，不许在验收里含糊）：
 *   - LINKS-SEED-v3.csv 不在本地可及目录；本构建器**不重建 links.jsonl**，
 *     也不消费 CSV。six-stem 这类新卡进入 link 表只能靠运行期学习边或 edges 扩展。
 *   - 目标卡不存在 / 路径归一化失败的边丢进 dropped + badRefs 并计数。
 *   - 本工具不读会话、不改记忆卡、不改 frontmatter（lifecycle 迁移归迁移器）。
 *
 * 设计约束：
 *   - 幂等：同样的输入 + 同样的已有表 → 输出字节不变（不重写、不写审计）；
 *     已有表里不是本构建器产出的边原样保留。
 *   - 原子：tmp → fsync → rename；写前把旧表备份到 `backups/`，
 *     写后追加一行审计到 `edges-audit.jsonl`。
 *   - 不硬编码个人路径：记忆根来自参数或环境变量。
 *
 * 用法：
 *   node scripts/edges-build.mjs --memory-root <记忆根> [--dry-run] [--json]
 *   node scripts/edges-build.mjs --memory-root <记忆根> --out <edges.jsonl> [--dry-run]
 *   node scripts/edges-build.mjs --rollback <备份文件> --memory-root <记忆根>
 *
 * 记忆根优先级：--memory-root > $DSH_LONGLIVE_MEMORY_ROOT > $DSH_MEM，
 * 给了 --out 且它以 `.longlive/recall/edges.jsonl` 结尾时也可以从它反推。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../src/recall/cards.mjs';
import { normalizeCardPath, parseLinksText } from '../src/recall/links.mjs';
import {
  EDGES_SCHEMA,
  EDGE_TYPES,
  dedupeEdges,
  edgeKey,
  normalizeEdge,
  parseEdgesText,
  serializeEdges,
  symmetrizeEdges,
} from '../src/recall/edges.js';

const SCRIPT = 'edges-build';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

const DEFAULTS = Object.freeze({
  cardsDirs: ['topics', 'procedures', 'handover'],
  maxTerms: 50, // 取权重总和最高的前 N 个 term 做共现
  maxCardsPerTerm: 5, // 每个 term 取权重最高的前 N 张卡
  maxSameTopic: 200, // same_topic 边总数上限
  frontmatterConfidence: 0.8, // 作者显式写下的边
  wikilinkConfidence: 0.5, // 只是引用，不推断语义
  linksConfidence: 0.5, // 同词共现，弱关联（schema 默认值，不发明强度）
});

const USAGE = `用法:
  node scripts/edges-build.mjs --memory-root <记忆根> [--out <edges.jsonl>] [--dry-run] [--json]
  node scripts/edges-build.mjs --rollback <备份 jsonl> --memory-root <记忆根> [--json]

选项:
  --memory-root <路径>        记忆根（缺省读 $DSH_LONGLIVE_MEMORY_ROOT / $DSH_MEM）
  --out <路径>                边表输出路径（缺省 <记忆根>/.longlive/recall/edges.jsonl）
  --plan <路径>               lifecycle-plan.json（缺省：<记忆根>/.longlive/lifecycle-plan.json，
                              再退到本包 src/memory/lifecycle-plan.json）
  --links-file <路径>         links.jsonl（缺省 <记忆根>/.longlive/recall/links.jsonl）
  --cards-dirs <a,b>          扫卡目录（缺省 topics,procedures,handover）
  --max-terms <n>             共现取前 N 个 term（缺省 ${DEFAULTS.maxTerms}）
  --max-cards-per-term <n>    每个 term 取前 N 张卡（缺省 ${DEFAULTS.maxCardsPerTerm}）
  --max-same-topic <n>        same_topic 边总数上限（缺省 ${DEFAULTS.maxSameTopic}）
  --no-cards                  不读卡面（显式边 / wikilink）
  --no-links                  不读 links.jsonl 共现
  --no-plan                   不读 lifecycle-plan.json
  --dry-run                   只统计与对比，不写文件、不写审计
  --json                      机器可读统计（stdout 只输出一个 JSON 对象）
  --rollback <路径>           把指定备份原子写回目标边表（写前备份当前表 + 审计）
  -h, --help                  显示本帮助

来源说明:
  - 卡面：frontmatter 边 key（${EDGE_TYPES.filter((t) => t !== 'same_topic').join(' / ')}）与 body [[wikilink]]。
  - links.jsonl 共现 → same_topic（不参与注入扩展，只进网络/backlinks）。
  - lifecycle-plan.json 的 edges[] 是决策记录（显式机器可读）。
  - 本机没有 LINKS-SEED-v3.csv；本工具不重建 links.jsonl，也不消费 CSV。
`;

function parseArgs(argv) {
  const args = {
    memoryRoot: '',
    out: '',
    plan: '',
    linksFile: '',
    cardsDirs: '',
    maxTerms: null,
    maxCardsPerTerm: null,
    maxSameTopic: null,
    noCards: false,
    noLinks: false,
    noPlan: false,
    dryRun: false,
    json: false,
    rollback: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--memory-root': args.memoryRoot = argv[++i] ?? ''; break;
      case '--out': args.out = argv[++i] ?? ''; break;
      case '--plan': args.plan = argv[++i] ?? ''; break;
      case '--links-file': args.linksFile = argv[++i] ?? ''; break;
      case '--cards-dirs': args.cardsDirs = argv[++i] ?? ''; break;
      case '--max-terms': args.maxTerms = Number(argv[++i]); break;
      case '--max-cards-per-term': args.maxCardsPerTerm = Number(argv[++i]); break;
      case '--max-same-topic': args.maxSameTopic = Number(argv[++i]); break;
      case '--no-cards': args.noCards = true; break;
      case '--no-links': args.noLinks = true; break;
      case '--no-plan': args.noPlan = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--json': args.json = true; break;
      case '--rollback': args.rollback = argv[++i] ?? ''; break;
      case '-h':
      case '--help': args.help = true; break;
      default: throw new Error(`E_UNKNOWN_ARG：不认识的参数 ${arg}`);
    }
  }
  return args;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toPosix(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function relToRoot(abs, root) {
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return toPosix(abs);
  return toPosix(rel);
}

function clip(text, maxChars = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, Math.max(1, maxChars - 1))}…` : flat;
}

function toList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => toList(item));
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text === '' ? [] : [text];
  }
  return [];
}

/** 相对卡路径（posix、以 .md 结尾、不得是绝对/上级路径）；失败返回 ''。 */
function resolveCardRef(ref, memoryRoot) {
  const raw = String(ref ?? '').trim();
  if (raw === '' || /^https?:\/\//i.test(raw) || raw.startsWith('#')) return '';
  let rel = normalizeCardPath(raw, memoryRoot);
  if (rel === '') return '';
  rel = rel.replace(/^\/+/, '');
  if (path.isAbsolute(rel) || /^[A-Za-z]:\//.test(rel)) return '';
  if (!rel.includes('/')) return ''; // 裸文件名歧义，不猜
  if (!/\.[A-Za-z0-9]+$/.test(rel)) rel += '.md';
  if (rel.split('/').some((segment) => segment === '..' || segment === '.')) return '';
  return rel;
}

function walkMarkdown(dirAbs, prefix = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkMarkdown(path.join(dirAbs, entry.name), rel));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(rel);
  }
  return out;
}

function sha256OfFile(abs, cache) {
  if (cache && cache.has(abs)) return cache.get(abs);
  let sha = null;
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      sha = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  } catch {
    sha = null;
  }
  if (cache) cache.set(abs, sha);
  return sha;
}

function withEvidenceSha(edge, memoryRoot, shaCache) {
  if (!edge || !edge.evidence || !edge.evidence.path) return edge;
  const abs = path.isAbsolute(edge.evidence.path)
    ? edge.evidence.path
    : path.join(memoryRoot, edge.evidence.path);
  const sha = sha256OfFile(abs, shaCache);
  if (!sha || edge.evidence.sha256 === sha) return edge;
  return { ...edge, evidence: { ...edge.evidence, sha256: sha } };
}

/** 在 frontmatter 行范围里定位某个 key / 某个值所在行，给 evidence.lines + quote。 */
function locateValueLine(lines, endLine, key, value) {
  const limit = Math.max(0, Math.min(endLine, lines.length));
  const keyRe = new RegExp(`^\\s*${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    if (keyRe.test(line) && String(line).includes(value)) return { line: i + 1, quote: clip(line) };
  }
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    if (String(line).includes(value) && /^\s*(?:-|[A-Za-z_]+\s*:)/.test(line)) {
      return { line: i + 1, quote: clip(line) };
    }
  }
  return null;
}

/**
 * 读卡目录：frontmatter 显式边 + `edges:` 简写 + body [[wikilink]] → mentions。
 * 目标卡是否存在在收尾时统一过滤（缺失 → dropped + badRefs）。
 */
function collectCardEdges({ memoryRoot, dirs, generatedAt, shaCache }) {
  const existsCache = new Map();
  const exists = (rel) => {
    if (existsCache.has(rel)) return existsCache.get(rel);
    const ok = fs.existsSync(path.join(memoryRoot, rel));
    existsCache.set(rel, ok);
    return ok;
  };
  const stats = {
    dirs: [...dirs],
    missingDirs: [],
    scanned: 0,
    noFrontmatter: 0,
    explicit: 0,
    shorthand: 0,
    wikilinks: 0,
    mentions: 0,
    bareLinks: 0,
    bareResolved: 0,
  };
  const rawEdges = [];
  const dropped = [];
  const badRefs = [];

  const files = [];
  for (const dir of dirs) {
    const abs = path.join(memoryRoot, dir);
    let ok = false;
    try { ok = fs.existsSync(abs) && fs.statSync(abs).isDirectory(); } catch { ok = false; }
    if (!ok) { stats.missingDirs.push(dir); continue; }
    for (const relFile of walkMarkdown(abs)) files.push({ rel: `${dir}/${relFile}`, abs: path.join(abs, relFile) });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  // 裸文件名 [[reuse-memory-before-build]]：只在全库唯一命中时解析；
  // 多个同名视为歧义，丢弃进 badRefs（不猜）。
  const byBasename = new Map();
  for (const file of files) {
    const name = path.basename(file.rel, '.md').toLowerCase();
    if (!byBasename.has(name)) byBasename.set(name, []);
    byBasename.get(name).push(file.rel);
  }
  const resolveRef = (ref) => {
    const viaPath = resolveCardRef(ref, memoryRoot);
    if (viaPath !== '') return viaPath;
    const raw = String(ref ?? '').trim().replace(/\\/g, '/');
    if (raw === '' || raw.includes('/') || /^https?:\/\//i.test(raw) || raw.startsWith('#')) return '';
    const hits = byBasename.get(raw.replace(/\.md$/i, '').toLowerCase()) ?? [];
    return hits.length === 1 ? hits[0] : '';
  };

  for (const file of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(file.abs, 'utf8');
    } catch (error) {
      dropped.push({ kind: 'card-read', from: file.rel, reason: String(error?.code ?? error) });
      continue;
    }
    stats.scanned += 1;
    const clean = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const lines = clean.split('\n');
    const parsed = parseFrontmatter(clean);
    if (!parsed.hasFrontmatter) stats.noFrontmatter += 1;
    let fmEnd = 0;
    if (parsed.hasFrontmatter) {
      for (let i = 1; i < lines.length; i += 1) {
        if (lines[i].trim() === '---') { fmEnd = i + 1; break; }
      }
    }
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};

    const pushExplicit = (type, refText, source) => {
      const to = resolveRef(refText);
      if (to === '') {
        dropped.push({ kind: source, from: file.rel, type, ref: clip(refText, 120), reason: 'bad-path' });
        badRefs.push({ kind: source, source: file.rel, ref: clip(refText, 120), reason: 'bad-path' });
        return;
      }
      const loc = locateValueLine(lines, fmEnd, type, String(refText).trim());
      rawEdges.push({
        from: file.rel,
        to,
        type,
        confidence: DEFAULTS.frontmatterConfidence,
        source,
        created_at: generatedAt,
        evidence: withEvidenceSha({
          path: file.rel,
          ...(loc ? { lines: [loc.line, loc.line], quote: loc.quote } : {}),
        }, memoryRoot, shaCache),
      });
    };

    // 1) 以边类型命名的 frontmatter key（作者显式写下）
    for (const type of EDGE_TYPES) {
      for (const ref of toList(data[type])) {
        pushExplicit(type, ref, 'card-frontmatter');
        stats.explicit += 1;
      }
    }
    // 2) `edges:` 简写项：`<type>: <path>` / `<type> <path>` / 裸路径 → mentions
    for (const item of toList(data.edges)) {
      const text = String(item).trim();
      const m = text.match(/^([a-z_]+)\s*[: ]\s*(.+)$/);
      if (m && EDGE_TYPES.includes(m[1])) {
        pushExplicit(m[1], m[2], 'card-frontmatter');
        stats.shorthand += 1;
        continue;
      }
      if (m && !m[1].includes('/')) {
        dropped.push({ kind: 'card-frontmatter', from: file.rel, ref: clip(text, 120), reason: 'unknown-type' });
        badRefs.push({ kind: 'card-frontmatter', source: file.rel, ref: clip(text, 120), reason: 'unknown-type' });
        continue;
      }
      pushExplicit('mentions', text, 'card-frontmatter');
      stats.shorthand += 1;
    }
    // 3) 卡体 [[wikilink]] → mentions（只记引用事实）
    for (let i = fmEnd; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes('[[')) continue;
      const re = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        const refText = m[1].trim();
        stats.wikilinks += 1;
        const to = resolveRef(refText);
        if (to === '') {
          stats.bareLinks += 1;
          badRefs.push({ kind: 'wikilink', source: file.rel, line: i + 1, ref: clip(refText, 120), reason: 'ambiguous-or-bad' });
          continue;
        }
        if (!refText.replace(/\\/g, '/').includes('/')) stats.bareResolved += 1;
        rawEdges.push({
          from: file.rel,
          to,
          type: 'mentions',
          confidence: DEFAULTS.wikilinkConfidence,
          source: 'card-wikilink',
          created_at: generatedAt,
          evidence: withEvidenceSha({ path: file.rel, lines: [i + 1, i + 1], quote: clip(line) }, memoryRoot, shaCache),
        });
        stats.mentions += 1;
      }
    }
  }

  // 目标卡存在性过滤（D5：目标不存在/坏路径丢 dropped 并计数）
  const edges = [];
  for (const edge of rawEdges) {
    if (!exists(edge.from)) {
      dropped.push({ kind: 'missing-source', from: edge.from, to: edge.to, type: edge.type, reason: 'missing-source' });
      continue;
    }
    if (!exists(edge.to)) {
      dropped.push({ kind: 'missing-target', from: edge.from, to: edge.to, type: edge.type, reason: 'missing-target' });
      badRefs.push({ kind: edge.source === 'card-wikilink' ? 'wikilink' : 'frontmatter', source: edge.from, ref: edge.to, reason: 'missing-target' });
      continue;
    }
    edges.push(edge);
  }
  return { edges, dropped, badRefs, stats };
}

/**
 * links.jsonl 共现 → same_topic（弱关联元数据，固定 confidence 0.5）。
 * 取权重总和最高的前 maxTerms 个 term；每个 term 取前 maxCardsPerTerm 张卡两两连边，
 * 方向按权重高→低（同权重按路径升序，保证确定性）。总数受 maxSameTopic 限制。
 */
function collectLinksEdges({ memoryRoot, linksFile, maxTerms, maxCardsPerTerm, maxSameTopic, generatedAt, shaCache }) {
  const stats = {
    present: false,
    path: linksFile,
    lines: 0,
    bad: 0,
    terms: 0,
    cards: 0,
    missingCards: 0,
    usedTerms: 0,
    pairs: 0,
    sameTopic: 0,
    skippedByCap: 0,
  };
  if (!fs.existsSync(linksFile)) return { edges: [], dropped: [], badRefs: [], stats };
  stats.present = true;
  let text = '';
  try {
    text = fs.readFileSync(linksFile, 'utf8');
  } catch (error) {
    return { edges: [], dropped: [{ kind: 'links-read', path: linksFile, reason: String(error?.code ?? error) }], badRefs: [], stats };
  }
  const parsed = parseLinksText(text, { memoryRoot });
  stats.lines = parsed.lines;
  stats.bad = parsed.bad;

  const cardOk = new Map();
  const byTerm = new Map();
  for (const edge of parsed.edges) {
    if (!cardOk.has(edge.cardPath)) cardOk.set(edge.cardPath, fs.existsSync(path.join(memoryRoot, edge.cardPath)));
    if (!cardOk.get(edge.cardPath)) continue;
    if (!byTerm.has(edge.term)) byTerm.set(edge.term, []);
    byTerm.get(edge.term).push({ cardPath: edge.cardPath, weight: edge.weight });
  }
  const badRefs = [];
  for (const [cardPath, ok] of cardOk) {
    if (!ok) badRefs.push({ kind: 'links', ref: cardPath, reason: 'missing-card' });
  }
  stats.cards = [...cardOk.keys()].length;
  stats.missingCards = badRefs.length;
  stats.terms = byTerm.size;

  const rows = [...byTerm.entries()].map(([term, cards]) => {
    cards.sort((a, b) => b.weight - a.weight || a.cardPath.localeCompare(b.cardPath));
    const total = cards.reduce((sum, card) => sum + card.weight, 0);
    return { term, cards, total };
  });
  rows.sort((a, b) => b.total - a.total || a.term.localeCompare(b.term));
  const picked = rows.slice(0, maxTerms);
  stats.usedTerms = picked.length;

  const linksRel = relToRoot(linksFile, memoryRoot);
  const evidenceBase = withEvidenceSha({ path: linksRel }, memoryRoot, shaCache);
  const edges = [];
  for (const row of picked) {
    const top = row.cards.slice(0, maxCardsPerTerm);
    for (let i = 0; i < top.length; i += 1) {
      for (let j = i + 1; j < top.length; j += 1) {
        const a = top[i];
        const b = top[j];
        const first = a.weight > b.weight || (a.weight === b.weight && a.cardPath <= b.cardPath) ? a : b;
        const second = first === a ? b : a;
        stats.pairs += 1;
        edges.push({
          from: first.cardPath,
          to: second.cardPath,
          type: 'same_topic',
          confidence: DEFAULTS.linksConfidence,
          source: 'links-cooccurrence',
          created_at: generatedAt,
          evidence: {
            ...evidenceBase,
            quote: `共现词「${clip(row.term, 60)}」：${first.cardPath}(w=${first.weight}) ↔ ${second.cardPath}(w=${second.weight})`,
          },
        });
      }
    }
  }
  let kept = edges;
  if (edges.length > maxSameTopic) {
    stats.skippedByCap = edges.length - maxSameTopic;
    kept = edges.slice(0, maxSameTopic);
  }
  stats.sameTopic = kept.length;
  return { edges: kept, dropped: [], badRefs, stats };
}

/**
 * 决策记录（lifecycle-plan/v1）的 edges[]：显式机器可读，带 evidence.path/lines/quote。
 * 目标卡还没迁移出来时按 D5 丢弃并计入 badRefs（迁移完成重建即自动出现）。
 */
function collectPlanEdges({ memoryRoot, planPath, generatedAt, shaCache }) {
  const stats = { present: false, path: planPath, schema: null, cards: 0, extracts: 0, edges: 0, kept: 0, missingTarget: 0 };
  if (!planPath || !fs.existsSync(planPath)) return { edges: [], dropped: [], badRefs: [], stats, plan: null };
  stats.present = true;
  let plan = null;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (error) {
    return { edges: [], dropped: [{ kind: 'plan-parse', path: planPath, reason: String(error?.message ?? error) }], badRefs: [], stats, plan: null };
  }
  stats.schema = typeof plan?.schema === 'string' ? plan.schema : null;
  stats.cards = Array.isArray(plan?.cards) ? plan.cards.length : 0;
  stats.extracts = Array.isArray(plan?.extracts) ? plan.extracts.length : 0;
  const rawEdges = Array.isArray(plan?.edges) ? plan.edges : [];
  stats.edges = rawEdges.length;
  const planGeneratedAt = typeof plan?.generated_at === 'string' ? plan.generated_at : generatedAt;

  const edges = [];
  const dropped = [];
  const badRefs = [];
  for (const raw of rawEdges) {
    const edge = normalizeEdge({
      ...raw,
      created_at: raw?.created_at ?? planGeneratedAt,
      source: raw?.source ?? 'lifecycle-plan/v1',
    }, { memoryRoot });
    if (!edge) {
      dropped.push({ kind: 'plan-edge', reason: 'invalid', raw: clip(JSON.stringify(raw), 160) });
      badRefs.push({ kind: 'plan-edge', ref: clip(JSON.stringify(raw), 120), reason: 'invalid' });
      continue;
    }
    const withSha = withEvidenceSha(edge, memoryRoot, shaCache);
    if (!fs.existsSync(path.join(memoryRoot, withSha.from))) {
      dropped.push({ kind: 'plan-edge', from: withSha.from, to: withSha.to, type: withSha.type, reason: 'missing-source' });
      badRefs.push({ kind: 'plan-edge', ref: withSha.from, reason: 'missing-source' });
      continue;
    }
    if (!fs.existsSync(path.join(memoryRoot, withSha.to))) {
      dropped.push({ kind: 'plan-edge', from: withSha.from, to: withSha.to, type: withSha.type, reason: 'missing-target' });
      badRefs.push({ kind: 'plan-edge', ref: withSha.to, reason: 'missing-target' });
      stats.missingTarget += 1;
      continue;
    }
    edges.push(withSha);
  }
  stats.kept = edges.length;
  return { edges, dropped, badRefs, stats, plan };
}

/**
 * INDEX.md 生成段里的路径引用审计（合并单元格 `a.md + b.md` 单独计数）。
 * 这是只读审计，不影响边表内容。
 */
function collectIndexRefs({ memoryRoot }) {
  const stats = { present: false, path: path.join(memoryRoot, 'INDEX.md'), refs: 0, uniqueRefs: 0, resolved: 0, unresolved: 0, mergedCells: 0 };
  const badRefs = [];
  const indexPath = stats.path;
  if (!fs.existsSync(indexPath)) return { stats, badRefs };
  stats.present = true;
  let text = '';
  try { text = fs.readFileSync(indexPath, 'utf8'); } catch (error) {
    return { stats: { ...stats, error: String(error?.code ?? error) }, badRefs };
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  let end = lines.length;
  const begin = lines.findIndex((line) => /<!--\s*BEGIN GENERATED\s*-->/i.test(line));
  const endIdx = lines.findIndex((line) => /<!--\s*END GENERATED\s*-->/i.test(line));
  if (begin >= 0 && endIdx > begin) { start = begin + 1; end = endIdx; }
  stats.scope = begin >= 0 && endIdx > begin ? 'generated' : 'whole-file';
  stats.linesScanned = Math.max(0, end - start);

  const refRe = /(?:^|[\s|`"'(（\[])((?:topics|procedures|handover|journal|flow|raw|archive|vault|index)\/[^\s|`"'<>()[\]{}，、；：（）]+?\.(?:md|json))/g;
  const unique = new Set();
  const seen = new Set();
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (/\.(?:md|json)\s*[+＋]\s*(?:topics|procedures|handover|journal|flow|raw|archive|vault|index)\//.test(line)) {
      stats.mergedCells += 1;
    }
    refRe.lastIndex = 0;
    let m;
    while ((m = refRe.exec(line)) !== null) {
      const ref = m[1];
      stats.refs += 1;
      unique.add(ref);
      const key = `${i + 1}\u0000${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ok = fs.existsSync(path.join(memoryRoot, ref));
      if (ok) {
        stats.resolved += 1;
      } else {
        stats.unresolved += 1;
        badRefs.push({ kind: 'index', line: i + 1, ref, reason: 'unresolved' });
      }
    }
  }
  stats.uniqueRefs = unique.size;
  return { stats, badRefs };
}

function summarizeRawEdges(edges) {
  const byType = {};
  const bySource = {};
  for (const edge of edges) {
    byType[edge.type] = (byType[edge.type] ?? 0) + 1;
    const source = edge.source ?? 'unknown';
    bySource[source] = (bySource[source] ?? 0) + 1;
  }
  return { byType, bySource };
}

function countBy(items, pick) {
  const out = {};
  for (const item of items) {
    const key = pick(item) ?? 'unknown';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function emailStamp(date = new Date()) {
  const iso = date.toISOString(); // 2026-11-26T13:00:00.000Z
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return { bytes: Buffer.byteLength(content, 'utf8'), sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
}

function backupExisting(file, recallDir) {
  const backupsDir = path.join(recallDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const base = `${path.basename(file, '.jsonl')}.${emailStamp()}.bak`;
  let target = path.join(backupsDir, base);
  for (let i = 1; fs.existsSync(target); i += 1) target = path.join(backupsDir, `${base.slice(0, -4)}-${i}.bak`);
  fs.copyFileSync(file, target);
  return target;
}

function appendAudit(recallDir, row) {
  fs.mkdirSync(recallDir, { recursive: true });
  fs.appendFileSync(path.join(recallDir, 'edges-audit.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

function findSeedCsv(memoryRoot) {
  const candidates = [
    path.join(memoryRoot, 'LINKS-SEED-v3.csv'),
    path.join(memoryRoot, '.longlive', 'recall', 'LINKS-SEED-v3.csv'),
    path.join(PACKAGE_ROOT, 'LINKS-SEED-v3.csv'),
    path.join(PACKAGE_ROOT, 'data', 'LINKS-SEED-v3.csv'),
    path.join(process.cwd(), 'LINKS-SEED-v3.csv'),
  ];
  const found = candidates.filter((file) => {
    try { return fs.existsSync(file) && fs.statSync(file).isFile(); } catch { return false; }
  });
  return { found: found.length > 0, candidates: found.length > 0 ? found.map((file) => toPosix(file)) : candidates.map((file) => toPosix(file)) };
}

function resolveMemoryRoot(args) {
  const explicit = String(args.memoryRoot ?? '').trim();
  if (explicit !== '') return path.resolve(explicit);
  const envRoot = String(process.env.DSH_LONGLIVE_MEMORY_ROOT ?? process.env.DSH_MEM ?? '').trim();
  if (envRoot !== '') return path.resolve(envRoot);
  if (args.out) {
    const out = path.resolve(args.out);
    const suffix = path.join('.longlive', 'recall', 'edges.jsonl');
    if (out.toLowerCase().endsWith(suffix.toLowerCase())) return path.resolve(out, '..', '..', '..');
  }
  return '';
}

/** 固定 evidence 字段顺序（path/sha256/lines/quote），保证同一语义图重复构建字节稳定。 */
function canonicalEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const out = { path: evidence.path };
  if (evidence.sha256) out.sha256 = evidence.sha256;
  if (Array.isArray(evidence.lines)) out.lines = evidence.lines.slice(0, 2).map(Number);
  if (evidence.quote) out.quote = evidence.quote;
  return out;
}

function printStats(stats, { json } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push(`[${SCRIPT}] ${stats.mode} (${stats.dryRun ? 'dry-run' : 'apply'})`);
  lines.push(`  memoryRoot: ${stats.memoryRoot}`);
  lines.push(`  out:        ${stats.outPath}${stats.existingPresent ? '' : '（不存在，将新建）'}`);
  lines.push(`  schema:     ${EDGES_SCHEMA}`);
  lines.push(`  plan:       ${stats.sources.plan.present ? `${stats.sources.plan.path}（${stats.sources.plan.kept}/${stats.sources.plan.edges} 条边生效，cards=${stats.sources.plan.cards} extracts=${stats.sources.plan.extracts}）` : `无（${stats.sources.plan.path || '未找到'}）`}`);
  lines.push(`  links:      ${stats.sources.links.present ? `${stats.sources.links.path}（lines=${stats.sources.links.lines} bad=${stats.sources.links.bad} terms=${stats.sources.links.terms} cards=${stats.sources.links.cards} → same_topic=${stats.sources.links.sameTopic}，用前 ${stats.sources.links.usedTerms} 个 term）` : `无（${stats.sources.links.path}）`}`);
  lines.push(`  cards:      dirs=${stats.sources.cards.dirs.join(',')} scanned=${stats.sources.cards.scanned} explicit=${stats.sources.cards.explicit} shorthand=${stats.sources.cards.shorthand} wikilinks=${stats.sources.cards.wikilinks} mentions=${stats.sources.cards.mentions}${stats.sources.cards.missingDirs.length > 0 ? `（缺目录: ${stats.sources.cards.missingDirs.join(',')}）` : ''}`);
  lines.push(`  seed CSV:   ${stats.seedCsv.found ? `存在但本构建器不消费（links.jsonl 即其产物）：${stats.seedCsv.candidates.join(', ')}` : '未找到（无种子 CSV；six-stem 进入 link 表只能靠运行期学习边或 edges 扩展，本工具不重建 links.jsonl）'}`);
  lines.push(`  INDEX:      ${stats.indexRefs.present ? `${stats.indexRefs.scope} 段 ${stats.indexRefs.linesScanned} 行，refs=${stats.indexRefs.refs} unique=${stats.indexRefs.uniqueRefs} resolved=${stats.indexRefs.resolved} unresolved=${stats.indexRefs.unresolved} mergedCells=${stats.indexRefs.mergedCells}` : '无 INDEX.md'}`);
  lines.push(`  build:      edges=${stats.build.edges} byType={${Object.entries(stats.build.byType).map(([k, v]) => `${k}:${v}`).join(', ')}} bySource={${Object.entries(stats.build.bySource).map(([k, v]) => `${k}:${v}`).join(', ')}}`);
  lines.push(`              deduped=${stats.build.deduped} symmetrized=${stats.build.symmetrized} preservedExisting=${stats.build.preservedExisting} existing={${stats.build.existing.present ? `present，parsed=${stats.build.existing.parsed} badLines=${stats.build.existing.badLines} dropped=${stats.build.existing.dropped} kept=${stats.build.existing.kept}` : '缺省空表'}}`);
  lines.push(`  changed:    ${stats.changed ? 'yes' : 'no (字节一致，幂等)'}  bytes=${stats.bytes} sha256=${stats.sha256}`);
  lines.push(`  dropped:    ${stats.dropped.count}${Object.keys(stats.dropped.byReason).length > 0 ? ` {${Object.entries(stats.dropped.byReason).map(([k, v]) => `${k}:${v}`).join(', ')}}` : ''}`);
  for (const item of stats.dropped.items.slice(0, 20)) {
    lines.push(`    - [${item.reason}] ${item.from ?? item.path ?? item.kind}${item.to ? ` → ${item.to}` : ''}${item.type ? ` (${item.type})` : ''}`);
  }
  if (stats.dropped.count > 20) lines.push(`    … 其余 ${stats.dropped.count - 20} 条见 --json`);
  lines.push(`  badRefs:    ${stats.badRefs.count}${Object.keys(stats.badRefs.byKind).length > 0 ? ` {${Object.entries(stats.badRefs.byKind).map(([k, v]) => `${k}:${v}`).join(', ')}}` : ''}`);
  for (const item of stats.badRefs.items.slice(0, 20)) {
    lines.push(`    - [${item.kind}] ${item.source ?? ''}${item.line ? `:${item.line}` : ''} ${item.ref}（${item.reason}）`);
  }
  if (stats.badRefs.count > 20) lines.push(`    … 其余 ${stats.badRefs.count - 20} 条见 --json`);
  lines.push(`  written:    ${stats.written ? `yes，backup=${stats.backupPath ?? '-'}，audit=${stats.auditPath ?? '-'}` : 'no'}`);
  for (const note of stats.notes) lines.push(`  note:       ${note}`);
  if (stats.error) lines.push(`  error:      ${stats.error}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const memoryRoot = resolveMemoryRoot(args);
  if (memoryRoot === '') {
    process.stderr.write(`${SCRIPT}: E_NO_MEMORY_ROOT：需要 --memory-root、--out，或 $DSH_LONGLIVE_MEMORY_ROOT\n`);
    return 1;
  }
  if (!fs.existsSync(memoryRoot)) {
    process.stderr.write(`${SCRIPT}: E_MEMORY_ROOT_MISSING：找不到记忆根 ${memoryRoot}\n`);
    return 1;
  }
  const recallDir = path.join(memoryRoot, '.longlive', 'recall');
  const outPath = args.out ? path.resolve(args.out) : path.join(recallDir, 'edges.jsonl');
  const linksFile = args.linksFile ? path.resolve(args.linksFile) : path.join(recallDir, 'links.jsonl');
  let planPath = args.plan ? path.resolve(args.plan) : path.join(recallDir, 'lifecycle-plan.json');
  if (!args.plan && !fs.existsSync(planPath)) {
    const packaged = path.join(PACKAGE_ROOT, 'src', 'memory', 'lifecycle-plan.json');
    if (fs.existsSync(packaged)) planPath = packaged;
  }

  // 回滚模式：把备份原子写回（写前备份当前表 + 审计）。
  if (args.rollback) {
    const rollbackFrom = path.resolve(args.rollback);
    if (!fs.existsSync(rollbackFrom) || fs.statSync(rollbackFrom).size === 0) {
      process.stderr.write(`${SCRIPT}: E_ROLLBACK_SOURCE：备份不存在或为空 ${rollbackFrom}\n`);
      return 1;
    }
    const payload = fs.readFileSync(rollbackFrom, 'utf8');
    const parsed = parseEdgesText(payload, { memoryRoot });
    if (parsed.stats.badLines > 0) {
      process.stderr.write(`${SCRIPT}: E_ROLLBACK_CORRUPT：备份有 ${parsed.stats.badLines} 行解析失败，拒绝回滚\n`);
      return 1;
    }
    const backupPath = fs.existsSync(outPath) ? backupExisting(outPath, path.dirname(outPath)) : null;
    // 回滚必须是字节级还原（备份里可能含 preserved 边、原始顺序与 evidence 字段序）；
    // 上面 parseEdgesText 只用于校验备份可用，不复用来重序列化。
    const written = atomicWrite(outPath, payload);
    appendAudit(path.dirname(outPath), {
      action: 'rollback',
      at: new Date().toISOString(),
      from: toPosix(rollbackFrom),
      out: toPosix(outPath),
      edges: parsed.edges.length,
      bytes: written.bytes,
      sha256: written.sha256,
      backupPath: backupPath ? toPosix(backupPath) : null,
    });
    const stats = {
      mode: 'rollback',
      dryRun: false,
      memoryRoot: toPosix(memoryRoot),
      outPath: toPosix(outPath),
      edges: parsed.edges.length,
      bytes: written.bytes,
      sha256: written.sha256,
      backupPath: backupPath ? toPosix(backupPath) : null,
      written: true,
      notes: [`回滚自 ${toPosix(rollbackFrom)}`],
    };
    if (args.json) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    } else {
      process.stdout.write([
        `[${SCRIPT}] rollback`,
        `  memoryRoot: ${stats.memoryRoot}`,
        `  out:        ${stats.outPath}`,
        `  from:       ${toPosix(rollbackFrom)}`,
        `  edges:      ${stats.edges}  bytes=${stats.bytes}  sha256=${stats.sha256}`,
        `  backup:     ${stats.backupPath ?? '-'}`,
        '',
      ].join('\n'));
    }
    return 0;
  }

  const generatedAt = new Date().toISOString();
  const shaCache = new Map();
  const cardsDirs = (args.cardsDirs ? String(args.cardsDirs).split(',') : DEFAULTS.cardsDirs)
    .map((dir) => dir.trim()).filter(Boolean);

  const cardsResult = args.noCards
    ? { edges: [], dropped: [], badRefs: [], stats: { dirs: [], missingDirs: [], scanned: 0, noFrontmatter: 0, explicit: 0, shorthand: 0, wikilinks: 0, mentions: 0, bareLinks: 0, disabled: true } }
    : collectCardEdges({ memoryRoot, dirs: cardsDirs, generatedAt, shaCache });
  const linksResult = args.noLinks
    ? { edges: [], dropped: [], badRefs: [], stats: { present: false, path: linksFile, disabled: true } }
    : collectLinksEdges({
      memoryRoot,
      linksFile,
      maxTerms: positiveInt(args.maxTerms, DEFAULTS.maxTerms),
      maxCardsPerTerm: positiveInt(args.maxCardsPerTerm, DEFAULTS.maxCardsPerTerm),
      maxSameTopic: positiveInt(args.maxSameTopic, DEFAULTS.maxSameTopic),
      generatedAt,
      shaCache,
    });
  const planResult = args.noPlan
    ? { edges: [], dropped: [], badRefs: [], stats: { present: false, path: planPath, disabled: true }, plan: null }
    : collectPlanEdges({ memoryRoot, planPath, generatedAt, shaCache });
  const indexResult = collectIndexRefs({ memoryRoot });

  const dropped = [...cardsResult.dropped, ...linksResult.dropped, ...planResult.dropped];
  const badRefs = [...cardsResult.badRefs, ...linksResult.badRefs, ...planResult.badRefs, ...indexResult.badRefs];

  // 已有表：只用来保留非本构建器产出的边 + 复用 created_at（幂等）。
  let existingEdges = [];
  let previousContent = '';
  let existingStats = { parsed: 0, badLines: 0, dropped: 0, deduped: 0, symmetrized: 0, kept: 0 };
  let existingPresent = false;
  if (fs.existsSync(outPath)) {
    try {
      previousContent = fs.readFileSync(outPath, 'utf8');
      const parsed = parseEdgesText(previousContent, { memoryRoot });
      existingEdges = parsed.edges;
      existingStats = parsed.stats;
      existingPresent = true;
    } catch (error) {
      dropped.push({ kind: 'existing-read', path: toPosix(outPath), reason: String(error?.code ?? error) });
    }
  }
  const existingByKey = new Map(existingEdges.map((edge) => [edgeKey(edge), edge]));

  const built = [...planResult.edges, ...cardsResult.edges, ...linksResult.edges];
  for (const edge of built) {
    if (edge.source === 'lifecycle-plan/v1') {
      // plan 自带 generated_at，本身就是确定值；只有缺失时才退化到本次时间。
      edge.created_at = edge.created_at ?? generatedAt;
      continue;
    }
    // 幂等：非 plan 边沿用已有表同 key 的 created_at；只有首次生成才用本次时间戳。
    const prev = existingByKey.get(edgeKey(edge));
    edge.created_at = prev?.created_at ?? edge.created_at ?? generatedAt;
  }
  const builtKeys = new Set(built.map((edge) => edgeKey(edge)));
  const preserved = existingEdges.filter((edge) => !builtKeys.has(edgeKey(edge)));
  const deduped = dedupeEdges([...built, ...preserved]);
  const symmetric = symmetrizeEdges(deduped.edges);
  const finalEdges = symmetric.edges
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: edge.type,
      evidence: canonicalEvidence(edge.evidence),
      confidence: edge.confidence,
      created_at: edge.created_at ?? null,
      source: edge.source ?? null,
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type));

  const content = serializeEdges(finalEdges);
  const bytes = Buffer.byteLength(content, 'utf8');
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const changed = previousContent !== content;

  let written = { ok: true, bytes: 0, sha256, backupPath: null };
  if (!args.dryRun && changed) {
    try {
      written.backupPath = existingPresent ? backupExisting(outPath, path.dirname(outPath)) : null;
      written = { ...atomicWrite(outPath, content), ok: true, backupPath: written.backupPath };
    } catch (error) {
      written = { ok: false, bytes: 0, sha256, backupPath: null, error: String(error?.message ?? error) };
    }
  }
  const auditPath = path.join(path.dirname(outPath), 'edges-audit.jsonl');
  if (!args.dryRun && changed && written.ok) {
    try {
      appendAudit(path.dirname(outPath), {
        action: 'build',
        at: generatedAt,
        memoryRoot: toPosix(memoryRoot),
        out: toPosix(outPath),
        edges: finalEdges.length,
        byType: summarizeRawEdges(finalEdges).byType,
        bySource: summarizeRawEdges(finalEdges).bySource,
        dropped: dropped.length,
        badRefs: badRefs.length,
        changed,
        bytes,
        sha256,
        planPath: planResult.stats.present ? toPosix(planPath) : null,
        planSha256: sha256OfFile(planPath, shaCache),
        linksPath: linksResult.stats.present ? toPosix(linksFile) : null,
        linksSha256: sha256OfFile(linksFile, shaCache),
        backupPath: written.backupPath ? toPosix(written.backupPath) : null,
      });
    } catch {
      /* 审计失败不影响边表本身，统计里记不到就别阻塞 */
    }
  }

  const sourceSummary = summarizeRawEdges(finalEdges);
  const stats = {
    schema: 'edges-build/v1',
    edgeSchema: EDGES_SCHEMA,
    mode: 'build',
    dryRun: args.dryRun === true,
    memoryRoot: toPosix(memoryRoot),
    outPath: toPosix(outPath),
    existingPresent,
    seedCsv: findSeedCsv(memoryRoot),
    sources: {
      cards: cardsResult.stats,
      links: linksResult.stats,
      plan: planResult.stats,
    },
    indexRefs: indexResult.stats,
    build: {
      edges: finalEdges.length,
      ...sourceSummary,
      deduped: deduped.deduped,
      symmetrized: symmetric.added,
      preservedExisting: preserved.length,
      existing: { present: existingPresent, ...existingStats },
    },
    dropped: {
      count: dropped.length,
      byReason: countBy(dropped, (item) => item.reason),
      items: dropped,
    },
    badRefs: {
      count: badRefs.length,
      byKind: countBy(badRefs, (item) => item.kind),
      items: badRefs,
    },
    changed,
    bytes,
    sha256,
    written: args.dryRun ? false : (changed && written.ok === true),
    backupPath: written.backupPath ? toPosix(written.backupPath) : null,
    auditPath: args.dryRun || !changed ? null : toPosix(auditPath),
    planPath: planResult.stats.present ? toPosix(planPath) : null,
    linksPath: linksResult.stats.present ? toPosix(linksFile) : null,
    notes: [
      '无种子 CSV：本构建器不重建 links.jsonl、不消费 LINKS-SEED-v3.csv；six-stem 等新卡进入 link 表只能靠运行期学习边或 edges 扩展。',
      'same_topic 由 links.jsonl 同词共现推导，固定 confidence 0.5（不发明强度），且不参与注入扩展（只进网络/backlinks）。',
      '目标卡不存在的边按 D5 丢弃并计入 dropped/badRefs；lifecycle-plan 里迁移目标卡缺卡时需先做迁移再重建。',
    ],
    error: written.ok === true ? null : written.error,
  };
  if (args.dryRun) stats.written = false;
  printStats(stats, { json: args.json });
  if (args.dryRun) return dropped.some((item) => item.kind === 'existing-read' || item.kind === 'links-read') ? 1 : 0;
  return written.ok === true ? 0 : 1;
}

const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}

export { main };
