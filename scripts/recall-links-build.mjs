#!/usr/bin/env node
/**
 * 1.8.8 M2 · 种子链路构建器
 *
 * 把「词 → 老记忆卡」的离线种子表（LINKS-SEED-v3.csv）转成运行时直连表
 * `<memoryRoot>/.longlive/recall/links.jsonl`，供 forced recall 的 link 路径按权重直连。
 *
 * 设计约束：
 *   - 幂等：同样的 CSV + 同样的已有表 → 输出字节不变（不重写、不写审计）。
 *   - 原子：写走 src/recall/links.mjs 的 tmp→rename，写前备份、写后追加审计行
 *     （`.longlive/recall/links-audit.jsonl`），返回 sha256 可复核。
 *   - 可回滚：`--rollback <备份文件>` 把备份原子写回；回滚也记审计行。
 *   - 不丢学习成果：只替换 source:"seed" 的边，source:"learned" 的边原样保留。
 *   - 不硬编码个人路径：CSV / 记忆根都从参数或环境变量来。
 *
 * 用法：
 *   node scripts/recall-links-build.mjs --csv <LINKS-SEED-v3.csv> --memory-root <记忆根> [--dry-run] [--json]
 *   node scripts/recall-links-build.mjs --csv <...> --out <links.jsonl> [--dry-run]
 *   node scripts/recall-links-build.mjs --rollback <links-backup.jsonl> --memory-root <记忆根>
 *
 * 记忆根优先级：--memory-root > $DSH_LONGLIVE_MEMORY_ROOT > $DSH_MEM。给了 --out 时：
 * 目标是 --out 指定的文件（审计 / 备份落在它同目录），记忆根仅用于归一化 cardPath；
 * 若 --out 以 `.longlive/recall/links.jsonl` 结尾且没给记忆根，也可以从它反推记忆根。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

import {
  LINKS_FILE_NAME,
  loadLinks,
  normalizeCardPath,
  normalizeLinksConfig,
  parseLinksText,
  serializeLinks,
  writeLinksStore,
} from '../src/recall/links.mjs';

const SCRIPT = 'recall-links-build';

const USAGE = `用法:
  node scripts/recall-links-build.mjs --csv <LINKS-SEED-v3.csv> --memory-root <记忆根> [--out <links.jsonl>] [--dry-run] [--json]
  node scripts/recall-links-build.mjs --rollback <备份 jsonl> --memory-root <记忆根> [--json]

选项:
  --csv <路径>           必填（构建模式）：LINKS-SEED-v3.csv 的路径
  --memory-root <路径>   记忆根（links.jsonl 落在 <记忆根>/.longlive/recall/ 下）
  --out <路径>           直接指定 links.jsonl 路径；缺省 = <记忆根>/.longlive/recall/links.jsonl
                         （给了 --out 时审计与备份落在该文件同目录）
  --dry-run              只统计与对比，不写文件、不写审计
  --json                 机器可读统计（stdout 只输出一个 JSON 对象）
  --rollback <路径>      把指定备份文件原子写回目标 links.jsonl（写前备份当前表 + 审计）
  --max-edges <n>        边数上限（缺省 5000；超出按 weight 从低到高淘汰）
  -h, --help             显示本帮助

说明:
  - 这是离线构建工具，不注册任何 hook、不读会话、不写记忆卡；只写 links.jsonl / links-audit.jsonl。
  - 构建只替换 source:"seed" 的边，运行期学出来的 source:"learned" 边保留。
`;

function parseArgs(argv) {
  const args = { csv: '', memoryRoot: '', out: '', dryRun: false, json: false, rollback: '', maxEdges: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--csv': args.csv = argv[++i] ?? ''; break;
      case '--memory-root': args.memoryRoot = argv[++i] ?? ''; break;
      case '--out': args.out = argv[++i] ?? ''; break;
      case '--dry-run': args.dryRun = true; break;
      case '--json': args.json = true; break;
      case '--rollback': args.rollback = argv[++i] ?? ''; break;
      case '--max-edges': args.maxEdges = Number(argv[++i]); break;
      case '-h':
      case '--help': args.help = true; break;
      default: throw new Error(`E_UNKNOWN_ARG：不认识的参数 ${arg}`);
    }
  }
  return args;
}

/** 极简 RFC4180 CSV 解析：支持引号包裹、"" 转义、CRLF；返回数组的数组。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

function headerIndex(header) {
  const map = new Map();
  header.forEach((name, index) => map.set(String(name).trim().toLowerCase(), index));
  return map;
}

function numberOrNull(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/** CSV 行 → 种子边（去重同 term+cardPath 取最大权重）。 */
export function seedEdgesFromRows(rows, { memoryRoot = '', maxEdges = 5000 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { edges: [], stats: { rows: 0, parsed: 0, skipped: 0, duplicates: 0 } };
  const idx = headerIndex(rows[0]);
  const need = ['term', 'cardpath', 'w'];
  for (const name of need) {
    if (!idx.has(name)) throw new Error(`E_CSV_HEADER：缺少列 ${name}`);
  }
  const byKey = new Map();
  let parsed = 0;
  let skipped = 0;
  let duplicates = 0;
  for (const cells of rows.slice(1)) {
    const term = String(cells[idx.get('term')] ?? '').trim();
    const rawCardPath = String(cells[idx.get('cardpath')] ?? '').trim();
    const weight = numberOrNull(cells[idx.get('w')]);
    if (term === '' || rawCardPath === '' || weight === null || weight <= 0) { skipped += 1; continue; }
    const cardPath = normalizeCardPath(rawCardPath, memoryRoot);
    const key = `${term}\u0000${cardPath}`;
    const edge = {
      term,
      cardPath,
      weight: Math.round(weight * 1000) / 1000,
      source: 'seed',
      evidence: {
        n: numberOrNull(cells[idx.get('n')] ?? ''),
        df: numberOrNull(cells[idx.get('df')] ?? ''),
        tier: String(cells[idx.get('tier')] ?? '').trim() || null,
        matchKind: String(cells[idx.get('matchkind')] ?? '').trim() || null,
        cooccurCount: numberOrNull(cells[idx.get('cooccurcount')] ?? ''),
      },
      createdAt: null,
      updatedAt: null,
    };
    parsed += 1;
    const previous = byKey.get(key);
    if (previous) {
      duplicates += 1;
      if (edge.weight > previous.weight) byKey.set(key, { ...edge, createdAt: previous.createdAt });
    } else {
      byKey.set(key, edge);
    }
  }
  let edges = [...byKey.values()];
  if (Number.isFinite(maxEdges) && maxEdges > 0 && edges.length > maxEdges) {
    edges.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term) || a.cardPath.localeCompare(b.cardPath));
    edges = edges.slice(0, maxEdges);
  }
  return {
    edges,
    stats: { rows: rows.length - 1, parsed, skipped, duplicates, edges: edges.length },
  };
}

/**
 * 合并：CSV 的 seed 边 + 已有 learned 边。
 * 同一 (term, cardPath) 的 seed 边沿用旧的 createdAt/updatedAt（幂等：内容不变则字节不变）。
 */
export function mergeSeedAndLearned(existingEdges, seedEdges, now = Date.now()) {
  const isoNow = new Date(now).toISOString();
  const previous = new Map();
  for (const edge of Array.isArray(existingEdges) ? existingEdges : []) {
    const key = `${edge.term}\u0000${edge.cardPath}`;
    previous.set(key, edge);
  }
  const merged = [];
  let added = 0;
  let kept = 0;
  for (const edge of seedEdges) {
    const key = `${edge.term}\u0000${edge.cardPath}`;
    const old = previous.get(key);
    if (old) {
      merged.push({
        ...edge,
        createdAt: old.createdAt ?? isoNow,
        updatedAt: old.weight === edge.weight ? (old.updatedAt ?? isoNow) : isoNow,
      });
      previous.delete(key);
      kept += 1;
    } else {
      merged.push({ ...edge, createdAt: isoNow, updatedAt: isoNow });
      added += 1;
    }
  }
  const learned = [];
  for (const edge of previous.values()) {
    if (edge.source === 'learned') {
      learned.push(edge);
    }
  }
  // learned 边排在后面，serializeLinks 统一排序，输出稳定。
  return { edges: [...merged, ...learned], stats: { added, kept, learnedPreserved: learned.length } };
}

function resolveMemoryRoot(args) {
  if (args.memoryRoot) return resolve(args.memoryRoot);
  const envRoot = process.env.DSH_LONGLIVE_MEMORY_ROOT || process.env.DSH_MEM || '';
  if (envRoot) return resolve(envRoot);
  if (args.out) {
    const abs = resolve(args.out);
    const suffix = join('.longlive', 'recall', LINKS_FILE_NAME);
    if (abs.endsWith(suffix)) return abs.slice(0, -suffix.length).replace(new RegExp(`${sep}$`), '');
  }
  return '';
}

function printStats(stats, { json }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(stats)}\n`);
    return;
  }
  const lines = [
    `[${SCRIPT}] ${stats.mode}${stats.dryRun ? ' (dry-run)' : ''}`,
    `  memoryRoot: ${stats.memoryRoot || '(未解析)'}`,
    `  links: ${stats.linksPath || '(未解析)'}`,
  ];
  if (stats.mode === 'build') {
    lines.push(
      `  CSV 行: ${stats.csv.rows} → 解析 ${stats.csv.parsed} / 跳过 ${stats.csv.skipped} / 重复 ${stats.csv.duplicates}`,
      `  边: ${stats.build.edges}（新增 ${stats.build.added} / 沿用 ${stats.build.kept} / 保留学习边 ${stats.build.learnedPreserved}）`,
      `  词: ${stats.build.terms} / 卡: ${stats.build.cards} / 权重区间: ${stats.build.minWeight}–${stats.build.maxWeight}`,
    );
  }
  lines.push(`  bytes: ${stats.bytes} / sha256: ${stats.sha256 || '(未写)'}`);
  lines.push(`  变化: ${stats.changed ? '是' : '否（幂等：字节未变，不重写）'}${stats.written ? ' · 已原子写入' : ''}`);
  if (stats.error) lines.push(`  错误: ${stats.error}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function statEdges(edges) {
  const terms = new Set();
  const cards = new Set();
  let minWeight = null;
  let maxWeight = null;
  for (const edge of edges) {
    terms.add(edge.term);
    cards.add(edge.cardPath);
    if (minWeight === null || edge.weight < minWeight) minWeight = edge.weight;
    if (maxWeight === null || edge.weight > maxWeight) maxWeight = edge.weight;
  }
  return { edges: edges.length, terms: terms.size, cards: cards.size, minWeight, maxWeight };
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
  const linksPath = args.out
    ? resolve(args.out)
    : memoryRoot
      ? join(memoryRoot, '.longlive', 'recall', LINKS_FILE_NAME)
      : '';

  // 回滚模式：把备份文件原子写回（写前备份当前表 + 审计 action:"rollback"）。
  if (args.rollback) {
    const rollbackFrom = resolve(args.rollback);
    if (!existsSync(rollbackFrom) || statSync(rollbackFrom).size === 0) {
      process.stderr.write(`${SCRIPT}: E_ROLLBACK_SOURCE：备份不存在或为空 ${rollbackFrom}\n`);
      return 1;
    }
    if (!linksPath) {
      process.stderr.write(`${SCRIPT}: E_NO_TARGET：回滚需要 --out 或 --memory-root（或 $DSH_LONGLIVE_MEMORY_ROOT）\n`);
      return 1;
    }
    const payload = readFileSync(rollbackFrom, 'utf8');
    const parsed = parseLinksText(payload, { memoryRoot });
    if (parsed.bad > 0) {
      process.stderr.write(`${SCRIPT}: E_ROLLBACK_CORRUPT：备份有 ${parsed.bad} 行解析失败，拒绝回滚\n`);
      return 1;
    }
    const written = writeLinksStore({
      memoryRoot,
      file: linksPath,
      edges: parsed.edges,
      auditRows: [{ action: 'rollback', from: rollbackFrom, bad: parsed.bad }],
      backup: true,
    });
    const stats = {
      mode: 'rollback',
      dryRun: false,
      memoryRoot,
      linksPath: written.path,
      rollbackFrom,
      ...statEdges(parsed.edges),
      bytes: written.bytes,
      sha256: written.sha256,
      backupPath: written.backupPath,
      written: written.ok === true,
      error: written.ok === true ? null : written.error,
    };
    printStats(stats, { json: args.json });
    return written.ok === true ? 0 : 1;
  }

  if (!args.csv) {
    process.stderr.write(`${SCRIPT}: E_NO_CSV：构建模式必须给 --csv <LINKS-SEED-v3.csv>\n\n${USAGE}`);
    return 2;
  }
  const csvPath = resolve(args.csv);
  if (!existsSync(csvPath)) {
    process.stderr.write(`${SCRIPT}: E_CSV_MISSING：找不到 ${csvPath}\n`);
    return 1;
  }
  if (!linksPath) {
    process.stderr.write(`${SCRIPT}: E_NO_MEMORY_ROOT：需要 --memory-root / --out，或 $DSH_LONGLIVE_MEMORY_ROOT\n`);
    return 1;
  }

  const config = normalizeLinksConfig({ ...(args.maxEdges ? { maxEdges: args.maxEdges } : {}) });
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const seeded = seedEdgesFromRows(rows, { memoryRoot, maxEdges: config.maxEdges });

  // 已有表：按 out 路径直接读（loadLinks 以 memoryRoot 定位；--out 自定义时退回 parseLinksText）。
  let existingEdges = [];
  let loadError = null;
  try {
    if (existsSync(linksPath)) {
      const parsed = parseLinksText(readFileSync(linksPath, 'utf8'), { memoryRoot });
      existingEdges = parsed.edges;
      if (parsed.bad > 0) loadError = `E_EXISTING_BAD_LINES:${parsed.bad}`;
    } else {
      const store = loadLinks({ memoryRoot, cache: {} });
      existingEdges = Array.isArray(store.edges) ? store.edges : [];
      if (store.error) loadError = store.error;
    }
  } catch (error) {
    loadError = String(error?.code ?? error?.message ?? error);
  }

  const merged = mergeSeedAndLearned(existingEdges, seeded.edges);
  const nextContent = serializeLinks(merged.edges);
  let previousContent = '';
  try { previousContent = existsSync(linksPath) ? readFileSync(linksPath, 'utf8') : ''; } catch { /* 读旧字节失败按空处理 */ }
  const changed = previousContent !== nextContent;
  const edgeStats = statEdges(merged.edges);

  let written = { ok: true, path: linksPath, bytes: 0, sha256: null, backupPath: null };
  if (!args.dryRun && changed) {
    written = writeLinksStore({
      memoryRoot,
      file: linksPath,
      edges: merged.edges,
      auditRows: [{
        action: 'build',
        csv: csvPath,
        csvRows: seeded.stats.rows,
        parsed: seeded.stats.parsed,
        skipped: seeded.stats.skipped,
        duplicates: seeded.stats.duplicates,
        added: merged.stats.added,
        kept: merged.stats.kept,
        learnedPreserved: merged.stats.learnedPreserved,
      }],
      backup: true,
    });
  }
  const contentSha = createHash('sha256').update(nextContent, 'utf8').digest('hex');
  const stats = {
    mode: 'build',
    dryRun: args.dryRun === true,
    memoryRoot,
    linksPath,
    csvPath,
    csv: seeded.stats,
    build: { ...edgeStats, ...merged.stats, edges: merged.edges.length },
    changed,
    written: args.dryRun ? false : (changed && written.ok === true),
    bytes: args.dryRun ? Buffer.byteLength(nextContent, 'utf8') : (written.bytes || Buffer.byteLength(nextContent, 'utf8')),
    sha256: written.sha256 || contentSha,
    backupPath: written.backupPath,
    loadError,
    error: args.dryRun ? null : (written.ok === true ? null : written.error),
  };
  printStats(stats, { json: args.json });
  if (args.dryRun) return 0;
  return written.ok === true ? 0 : 1;
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}

export { main };
