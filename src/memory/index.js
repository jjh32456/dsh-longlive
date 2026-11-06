// INDEX.md regeneration.
//
// Only the region between the two generated markers is rewritten. Everything a
// human wrote outside them is copied byte-for-byte. The tool is dry-run by
// default; `apply: true` is the only path that writes. Two consecutive applies
// differ only in the generated timestamp line, so the section is idempotent.
//
// Legacy cards (no frontmatter) are real cards: they get defaults and a row,
// because the index's completeness rule is "scanned card count == generated row
// count" — dropping them would silently lose memory.
//
// Procedures get their own 「程序性」 table. They are counted in `cards` but
// never repeated in the topics/journal table, so one card still means one row.

import fs from 'node:fs';
import path from 'node:path';

import { memoryRootFromConfig, resolveInside, relativePath, memoryError } from './paths.js';
import { parseFrontmatter, dayString, isoStamp } from './frontmatter.js';
import {
  appendAudit, listMarkdownFiles, updateState, writeFileAtomic,
} from './state.js';
import { PROCEDURES_DIR, scanProcedures } from './procedure.js';

export const BEGIN_GENERATED = '<!-- BEGIN GENERATED -->';
export const END_GENERATED = '<!-- END GENERATED -->';
export const INDEX_FILE = 'INDEX.md';
export const PROCEDURES_HEADING = `### 程序性（${PROCEDURES_DIR}/）`;

const SCAN_DIRS = ['topics', 'journal'];

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function firstHeading(body) {
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(raw);
    if (match) return collapse(match[1]);
  }
  return null;
}

function firstSummaryLine(body) {
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^<!--/.test(line) || /^-->$/.test(line)) continue;
    if (/^\|/.test(line) || /^-{3,}$/.test(line)) continue;
    const cleaned = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\|/g, '/')
      .trim();
    if (cleaned) return cleaned.slice(0, 60);
  }
  return '（空）';
}

function readCard(root, abs) {
  const text = fs.readFileSync(abs, 'utf8');
  const parsed = parseFrontmatter(text);
  const rel = relativePath(root, abs);
  const title = collapse(parsed.fields.title || firstHeading(parsed.body) || path.basename(abs, '.md')) || '（无题）';
  return {
    abs,
    rel,
    title,
    summary: firstSummaryLine(parsed.body),
    legacy: parsed.legacy,
    fields: parsed.fields,
  };
}

/** All cards under `topics/` and `journal/`, sorted for a stable index. */
export function scanCards(root) {
  const cards = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of listMarkdownFiles(root, dir)) {
      cards.push(readCard(root, abs));
    }
  }
  cards.sort((left, right) => {
    if (right.fields.salience !== left.fields.salience) return right.fields.salience - left.fields.salience;
    const leftUsed = left.fields.last_used ?? '';
    const rightUsed = right.fields.last_used ?? '';
    if (rightUsed !== leftUsed) return rightUsed.localeCompare(leftUsed);
    return left.rel.localeCompare(right.rel);
  });
  return cards;
}

function cell(value) {
  return collapse(value).replace(/\|/g, '\\|');
}

function procedureRow(card) {
  const trigger = card.trigger?.length > 0 ? card.trigger.join(', ') : '（无）';
  return `| ${cell(card.name)} | ${cell(trigger)} | ${card.rel} | ${card.strength} | ${card.version} |`;
}

function statusCounts(cards) {
  const counts = { active: 0, locked: 0, archived: 0 };
  for (const card of cards) {
    const status = card.fields?.status ?? 'active';
    if (status in counts) counts[status] += 1;
    else counts.active += 1;
  }
  return counts;
}

/**
 * The generated section: one table for topics/journal cards, then a separate
 * 「程序性」 table. A procedure card has `procedure: true` and is written only
 * to the second table, so it never shows up twice.
 */
export function buildGeneratedSection(allCards, now = new Date()) {
  const cards = allCards.filter((card) => card.procedure !== true);
  const procedures = allCards.filter((card) => card.procedure === true);
  const legacy = allCards.filter((card) => card.legacy).length;
  const counts = statusCounts(allCards);
  const rows = cards.map((card) => `| ${cell(card.title)} | ${cell(card.summary)} | ${card.rel} | ${card.fields.salience} | ${card.fields.strength} |`);
  return [
    BEGIN_GENERATED,
    `<!-- generated: ${isoStamp(now)} -->`,
    `<!-- cards: ${allCards.length} · legacy: ${legacy} · procedures: ${procedures.length} · active: ${counts.active} · locked: ${counts.locked} · archived: ${counts.archived} -->`,
    '| 标题 | 一句话 | 路径 | salience | strength |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    PROCEDURES_HEADING,
    '',
    '| 名称 | 触发 | 路径 | strength | 版本 |',
    '| --- | --- | --- | --- | --- |',
    ...procedures.map(procedureRow),
    END_GENERATED,
  ].join('\n');
}

/**
 * Count data rows in a generated section. There are two tables now, so the
 * header is recognised structurally (a row followed by a `| ---` separator)
 * instead of by its label; a data row is never followed by a separator row.
 */
export function countGeneratedRows(section) {
  const lines = String(section ?? '').split('\n');
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('| ')) continue;
    if (/^\|\s*---/.test(line)) continue;
    if (/^\|\s*---/.test(lines[index + 1] ?? '')) continue;
    count += 1;
  }
  return count;
}

/**
 * Replace the generated region in `existing`, keeping all hand-written content
 * byte-for-byte. Missing markers append the section; half a pair is an error
 * because guessing where it ends would let the tool rewrite hand-written text.
 */
export function mergeGenerated(existing, section) {
  const before = String(existing ?? '');
  const begin = before.indexOf(BEGIN_GENERATED);
  const end = before.indexOf(END_GENERATED, Math.max(0, begin));
  if (begin >= 0 && end >= 0) {
    return before.slice(0, begin) + section + before.slice(end + END_GENERATED.length);
  }
  if (begin >= 0 || end >= 0) {
    throw memoryError(
      'E_INDEX_MARKERS',
      'INDEX.md 里只有一半生成标记 — 补成一对 BEGIN/END GENERATED，或在人工确认后删掉那一半',
    );
  }
  if (before.trim() === '') return `${section}\n`;
  const separator = before.endsWith('\n') ? '\n' : '\n\n';
  return `${before}${separator}${section}\n`;
}

function incomplete(cards, section) {
  const rows = countGeneratedRows(section);
  if (rows !== cards.length) {
    throw memoryError(
      'E_INDEX_INCOMPLETE',
      `索引完整性校验失败：扫描到 ${cards.length} 张卡，却只生成 ${rows} 行 — 拒绝写入`,
    );
  }
}

/**
 * memory_index: dry-run by default. `apply: true` rewrites only the generated
 * section, after backing INDEX.md up and verifying the write.
 */
export function memoryIndex(args = {}, config = {}) {
  const root = memoryRootFromConfig(config);
  const now = config.now instanceof Date ? config.now : new Date();
  const apply = args.apply === true;
  const core = scanCards(root);
  const { cards: procedures, invalid: invalidCards } = scanProcedures(root);
  const cards = [...core, ...procedures.map((card) => ({ ...card, procedure: true }))];
  const section = buildGeneratedSection(cards, now);
  const legacy = cards.filter((card) => card.legacy).length;
  const counts = statusCounts(cards);
  const invalid = invalidCards.length;
  incomplete(cards, section);

  const indexPath = resolveInside(root, INDEX_FILE);
  const existed = fs.existsSync(indexPath);
  const before = existed ? fs.readFileSync(indexPath, 'utf8') : '';
  const after = mergeGenerated(before, section);
  const changed = before !== after;

  if (!apply) {
    return {
      ok: true,
      status: 'dry-run',
      dryRun: true,
      applied: false,
      root,
      indexPath,
      cards: cards.length,
      legacy,
      procedures: procedures.length,
      invalid,
      ...counts,
      changed,
      generated: section,
      wouldWrite: after,
      message:
        `dry-run：扫描到 ${cards.length} 张卡（legacy ${legacy}，程序性 ${procedures.length}` +
        `${invalid > 0 ? `，坏卡 ${invalid}` : ''}）→ ${changed ? 'INDEX.md 会变化' : 'INDEX.md 已是最新'}；` +
        '加 apply:true 才落盘',
    };
  }

  const write = writeFileAtomic(root, indexPath, after, { backup: true, now });
  const readBack = fs.readFileSync(indexPath, 'utf8');
  if (readBack !== after) {
    throw memoryError('E_INDEX_VERIFY', `INDEX.md 写入后读回不一致：${indexPath}`);
  }
  updateState(root, { indexBuiltAt: now.toISOString() }, { now });
  appendAudit(root, {
    action: 'memory_index',
    object: INDEX_FILE,
    result: `cards=${cards.length} legacy=${legacy} procedures=${procedures.length} invalid=${invalid} changed=${changed}`,
    now,
  });
  return {
    ok: true,
    status: 'applied',
    dryRun: false,
    applied: true,
    root,
    indexPath,
    cards: cards.length,
    legacy,
    procedures: procedures.length,
    invalid,
    ...counts,
    changed,
    generated: section,
    backup: write.backup,
    backupRel: write.backupRel,
    sha256: write.sha256,
    indexBuiltAt: now.toISOString(),
    message:
      `已重建 INDEX.md：${cards.length} 行（legacy ${legacy}，程序性 ${procedures.length}` +
      `${invalid > 0 ? `，坏卡 ${invalid}` : ''}），备份 ${write.backupRel ?? '（首次创建，无旧文件）'}`,
  };
}

/** Read the generated region of an INDEX.md text, or null when absent. */
export function extractGeneratedSection(text) {
  const source = String(text ?? '');
  const begin = source.indexOf(BEGIN_GENERATED);
  if (begin < 0) return null;
  const end = source.indexOf(END_GENERATED, begin);
  if (end < 0) return null;
  return source.slice(begin, end + END_GENERATED.length);
}

/** Local-day helper re-exported for tests and reports. */
export { dayString };
