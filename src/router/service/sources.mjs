// 上下文来源读取（DESIGN §4.1）。
//
// 只读四类材料：STATE.md 三节、最新一张非空 handover、INDEX.md 的行、topics 卡片摘要。
// v1 明确不读 journal 全文、不读 flow/current.md、不读会话记录——这条边界写在代码里，
// 不靠调用方自觉。

import fs from 'node:fs';
import path from 'node:path';

import { buildOpenCard, listHandoverCards, sortHandoverCards, summarizeHandover } from '../../identity/handover.js';

export const LIMITS = Object.freeze({
  stateBytes: 64 * 1024,
  handoverBytes: 64 * 1024,
  indexBytes: 32 * 1024,
  cardBytes: 64 * 1024,
  cardChars: 1200,
  indexRows: 12,
  indexRowChars: 80,
  cardsRead: 3,
  cardsKeep: 2,
  handoverCandidates: 20,
});

export const PLACEHOLDER = Object.freeze({
  missingSection: '（STATE.md 里没有这一节）',
  missingState: '（没有找到 STATE.md）',
  missingHandover: '（没有找到交接卡）',
  emptyIndex: '（INDEX.md 无可用行）',
  noCards: '（没有可用主题卡）',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读取文件，但最多读 maxBytes（DESIGN G3：10MB 文件也只读前 64KB）。
 * 读取两次并比较 size+mtime，最多重试 retries 次；不稳定时用第一次的文本并标记 unstable。
 *
 * @param {string} file
 * @param {{maxBytes?:number, stability?:boolean, waitMs?:number, retries?:number}} [options]
 * @returns {Promise<{ok:boolean,text:string,bytes:number,mtimeMs:number,truncated:boolean,unstable:boolean,error?:string}>}
 */
export async function readCappedFile(file, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : LIMITS.stateBytes;
  const stability = options.stability !== false;
  const waitMs = Number.isFinite(options.waitMs) && options.waitMs >= 0 ? options.waitMs : 50;
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : 3;

  const readOnce = () => {
    let stat;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) return { ok: false, error: 'ENOTFILE' };
    } catch (error) {
      return { ok: false, error: error?.code ?? 'ESTAT' };
    }
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const truncated = stat.size > maxBytes || bytes > maxBytes;
      const slice = buffer.subarray(0, Math.min(bytes, maxBytes));
      return {
        ok: true,
        text: slice.toString('utf8'),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        truncated,
      };
    } catch (error) {
      return { ok: false, error: error?.code ?? 'EREAD' };
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  };

  let first = readOnce();
  if (!first.ok) return { ...first, text: '', bytes: 0, mtimeMs: 0, truncated: false, unstable: false };
  if (!stability) return { ...first, unstable: false };

  let last = first;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (waitMs > 0) await sleep(waitMs);
    const next = readOnce();
    if (!next.ok) break;
    if (next.bytes === last.bytes && next.mtimeMs === last.mtimeMs) {
      last = next;
      return { ...next, unstable: false };
    }
    last = next;
  }
  // 文件一直在变：用第一次读到的内容，但明确告诉上层它不稳定。
  return { ...first, unstable: true };
}

function trimCell(value, maxChars = LIMITS.indexRowChars) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${Array.from(text).slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/**
 * 从 INDEX.md 的 Markdown 表格里取数据行。没有表格时退化为非空行（最多 12 行）。
 * @param {string} text
 * @returns {Array<{cells:string[],text:string}>}
 */
export function parseIndexRows(text) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const rows = [];
  let inTable = false;
  let tableHeaderSkipped = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
    if (!tableHeaderSkipped) {
      tableHeaderSkipped = true;
      continue;
    }
    if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell) || cell === '')) continue;
    rows.push({ cells, text: trimCell(cells.map((cell) => trimCell(cell)).join(' | '), LIMITS.indexRowChars) });
    if (rows.length >= LIMITS.indexRows) break;
  }
  if (rows.length === 0) {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      rows.push({ cells: [line], text: trimCell(line) });
      if (rows.length >= LIMITS.indexRows) break;
    }
  }
  return rows;
}

function extractTopicRef(text) {
  const match = String(text ?? '').match(/topics[\\/]([^\s|)\]`]+?\.md)/iu);
  return match ? match[1] : null;
}

function cardTokens(text) {
  const lower = String(text ?? '').toLowerCase();
  const words = lower.match(/[a-z0-9_]{2,}/gu) ?? [];
  const cjk = [];
  const chars = Array.from(lower);
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (/[\u4e00-\u9fff]/u.test(chars[i]) && /[\u4e00-\u9fff]/u.test(chars[i + 1])) {
      cjk.push(chars[i] + chars[i + 1]);
    }
  }
  return new Set([...words, ...cjk]);
}

function overlapScore(queryTokens, cardText) {
  const tokens = cardTokens(cardText);
  let hits = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) hits += 1;
  }
  return hits;
}

/**
 * 收集上下文来源。只读、不写、不抛；所有读取失败都变成可审计的 warning。
 *
 * @param {object} options
 * @param {string|null} options.memoryRoot
 * @param {object} [options.task]
 * @param {Date|number|string} [options.now]
 * @param {{enabled?:boolean,waitMs?:number,retries?:number}} [options.stability]
 * @returns {Promise<object>}
 */
export async function loadContextSources(options = {}) {
  const memoryRoot = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== ''
    ? path.resolve(options.memoryRoot)
    : null;
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const stability = {
    enabled: options.stability?.enabled !== false,
    waitMs: Number.isFinite(options.stability?.waitMs) ? options.stability.waitMs : 50,
    retries: Number.isInteger(options.stability?.retries) ? options.stability.retries : 3,
  };
  const readOpts = (maxBytes) => ({
    maxBytes,
    stability: stability.enabled,
    waitMs: stability.waitMs,
    retries: stability.retries,
  });

  const warnings = [];
  let unstable = false;

  if (!memoryRoot) {
    return {
      memoryRoot: null,
      stateText: '',
      stateFound: false,
      handover: null,
      handoverWarning: 'MEMORY_ROOT_MISSING',
      index: { text: PLACEHOLDER.emptyIndex, rows: [], stale: true, missingFiles: [] },
      cards: [],
      warnings: ['MEMORY_ROOT_MISSING'],
      unstable: false,
      now: safeNow.toISOString(),
    };
  }

  // STATE.md
  const statePath = path.join(memoryRoot, 'STATE.md');
  const stateRead = await readCappedFile(statePath, readOpts(LIMITS.stateBytes));
  if (stateRead.unstable) {
    unstable = true;
    warnings.push('STATE_UNSTABLE');
  }
  if (!stateRead.ok) warnings.push(stateRead.error === 'ENOENT' ? 'STATE_MISSING' : 'STATE_READ_FAILED');
  if (stateRead.truncated) warnings.push('STATE_BYTES_TRUNCATED');

  // 最新一张非空 handover；最新为空时向旧卡回退，并留下 HANDOVER_LATEST_EMPTY。
  let handover = null;
  let handoverWarning = null;
  const handoverDir = path.join(memoryRoot, 'handover');
  const cards = sortHandoverCards(listHandoverCards(handoverDir)).slice(0, LIMITS.handoverCandidates);
  for (let i = 0; i < cards.length; i += 1) {
    const entry = cards[i];
    const read = await readCappedFile(entry.path, readOpts(LIMITS.handoverBytes));
    if (read.unstable) {
      unstable = true;
      warnings.push(`HANDOVER_UNSTABLE:${entry.name}`);
    }
    if (!read.ok) continue;
    const summary = summarizeHandover(read.text, LIMITS.handoverBytes);
    if (summary.text.trim() !== '' || read.text.trim() !== '') {
      handover = { name: entry.name, text: read.text, mtimeMs: entry.mtimeMs, truncated: read.truncated };
      if (i > 0) handoverWarning = 'HANDOVER_LATEST_EMPTY';
      break;
    }
    if (i === 0) handoverWarning = 'HANDOVER_LATEST_EMPTY';
  }
  if (!handover && cards.length === 0) handoverWarning = 'HANDOVER_MISSING';

  // INDEX.md
  const indexPath = path.join(memoryRoot, 'INDEX.md');
  const indexRead = await readCappedFile(indexPath, readOpts(LIMITS.indexBytes));
  if (indexRead.unstable) {
    unstable = true;
    warnings.push('INDEX_UNSTABLE');
  }
  const indexRows = indexRead.ok ? parseIndexRows(indexRead.text) : [];
  const missingFiles = [];
  for (const row of indexRows) {
    for (const cell of row.cells) {
      const ref = extractTopicRef(cell);
      if (!ref) continue;
      const target = path.join(memoryRoot, 'topics', ref);
      if (!fs.existsSync(target)) missingFiles.push(ref);
    }
  }
  const index = {
    text: indexRows.length > 0 ? indexRows.map((row) => `| ${row.text} |`).join('\n') : PLACEHOLDER.emptyIndex,
    rows: indexRows,
    stale: !indexRead.ok || indexRows.length === 0,
    missingFiles,
    truncated: indexRead.truncated === true,
  };
  if (!indexRead.ok) warnings.push(indexRead.error === 'ENOENT' ? 'INDEX_MISSING' : 'INDEX_READ_FAILED');
  if (missingFiles.length > 0) warnings.push(`INDEX_MISSING_FILE:${missingFiles.slice(0, 3).join(',')}`);

  // topics：最多读 3 个文件，只取前 1,200 字符作为候选，再按相关度 + 新鲜度取前 2。
  const mergedState = buildOpenCard({
    stateText: stateRead.ok ? stateRead.text : null,
    handover: handover ? { text: handover.text, name: handover.name } : undefined,
    maxChars: 3200,
    now: safeNow,
  });
  const whereMatch = mergedState.text.match(/▍我在哪\n([\s\S]*?)(?=\n▍|$)/u);
  const taskText = [
    options.task?.type,
    options.task?.payload?.note,
    options.task?.payload?.question,
    whereMatch?.[1],
  ].filter(Boolean).join(' ');
  const queryTokens = cardTokens(taskText);

  const topicsDir = path.join(memoryRoot, 'topics');
  let topicEntries = [];
  try {
    topicEntries = fs.readdirSync(topicsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/iu.test(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => {
        const full = path.join(topicsDir, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
        return { name: entry.name, path: full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    topicEntries = [];
  }
  const selectedCards = [];
  for (const entry of topicEntries.slice(0, LIMITS.cardsRead)) {
    const read = await readCappedFile(entry.path, readOpts(LIMITS.cardBytes));
    if (!read.ok) {
      warnings.push(`CARD_UNREADABLE:${entry.name}`);
      continue;
    }
    if (read.unstable) {
      unstable = true;
      warnings.push(`CARD_UNSTABLE:${entry.name}`);
    }
    const candidate = Array.from(read.text).slice(0, LIMITS.cardChars).join('');
    const ageDays = Math.max(0, (safeNow.getTime() - entry.mtimeMs) / 86400000);
    const freshness = 1 / (1 + ageDays / 30);
    const score = overlapScore(queryTokens, candidate) * 2 + freshness;
    selectedCards.push({
      name: entry.name,
      path: entry.path,
      text: candidate,
      chars: Array.from(candidate).length,
      truncated: read.truncated || Array.from(read.text).length > LIMITS.cardChars,
      mtimeMs: entry.mtimeMs,
      score,
    });
  }
  selectedCards.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
  const keptCards = selectedCards.slice(0, LIMITS.cardsKeep);

  return {
    memoryRoot,
    statePath,
    stateText: stateRead.ok ? stateRead.text : '',
    stateFound: stateRead.ok && stateRead.text.trim() !== '',
    stateTruncated: stateRead.truncated === true,
    handover,
    handoverWarning,
    index,
    cards: keptCards,
    warnings,
    unstable,
    now: safeNow.toISOString(),
  };
}
