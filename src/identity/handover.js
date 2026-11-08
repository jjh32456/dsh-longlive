// identity-router v0 — 开机卡（open card）核心
//
// 纯函数优先：解析 / 选卡 / 截断 / 拼装都不碰全局状态，方便单测。
// 只有 collectOpenCard / readTextFile / listHandoverCards 做只读文件 IO。
//
// 数据来源只允许两处（v0 硬边界，见 DESIGN.md）：
//   <memoryRoot>/STATE.md
//   <memoryRoot>/handover/*.md
// 绝不写 memoryRoot。

import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from '../home.js';
import { DEFAULT_MEMORY_DIRNAME } from '../memory/paths.js';

/** 默认记忆根：<DSH home>/longlive-memory，与 memory_* 工具同一条解析链。
 *  可用 config.memoryRoot / DSH_IDENTITY_MEMORY_ROOT / DSH_LONGLIVE_MEMORY_ROOT 覆盖。 */
export const DEFAULT_MEMORY_ROOT = path.join(dshHome(), DEFAULT_MEMORY_DIRNAME);

/** 开机卡默认上限（按 Unicode 码点计，一个汉字 = 1）。 */
export const DEFAULT_MAX_CHARS = 800;

/** STATE.md 里要抓的三节（精确名，允许末尾括号注释）。 */
export const STATE_SECTIONS = Object.freeze({
  where: '我在哪',
  waiting: '在等什么',
  recent: '最近三件',
});

/** 卡片里缺失内容时的占位，不编造。 */
export const MISSING_TEXT = '（STATE.md 里没有这一节）';

/** 文件读不到时的统一返回，不抛异常。 */
const EMPTY_READ = Object.freeze({ ok: false, text: '', error: 'ENOENT' });

/**
 * 统一换行并去掉 BOM。BOM 是这台机器上踩过的坑：带 BOM 的 JSON 会被宿主拒绝，
 * 文本卡虽然宽松，但解析标题时 BOM 会粘在第一个 '#' 前面。
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeText(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * 按 Unicode 码点计数，避免把 emoji / 代理对算成两个字。
 * @param {unknown} input
 * @returns {number}
 */
export function charLength(input) {
  return Array.from(typeof input === 'string' ? input : String(input ?? '')).length;
}

/**
 * 按码点截断；超长时保留 max-1 个字符再加省略号，返回值长度恒 <= max。
 * @param {unknown} input
 * @param {number} max
 * @returns {{text: string, truncated: boolean}}
 */
export function truncateChars(input, max) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const chars = Array.from(text);
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (chars.length <= limit) return { text, truncated: false };
  if (limit <= 0) return { text: '', truncated: true };
  const body = chars.slice(0, limit - 1).join('').replace(/\s+$/u, '');
  return { text: `${body}…`, truncated: true };
}

/**
 * 标题归一化：去掉 markdown 强调、前导编号、末尾括号注释与标点，压缩空白。
 * 目的：`## 我在哪（2026-11-03 更新）` 能匹配 `我在哪`，但 `我现在在哪` 不能。
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeHeading(input) {
  let title = normalizeText(input).trim();
  title = title.replace(/^\s*#{1,6}\s*/, '');
  title = title.replace(/\*\*|__|`/g, '');
  title = title.replace(/^\s*(?:\d+[.、)]|[一二三四五六七八九十]+、)\s*/, '');
  // 允许嵌套一层括号，循环剥掉末尾的「（...）」「(...)」。
  for (let i = 0; i < 3; i += 1) {
    const next = title.replace(/\s*[（(][^（）()]*[）)]\s*$/u, '').trim();
    if (next === title) break;
    title = next;
  }
  title = title.replace(/[：:]\s*$/u, '').trim();
  return title.replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * 解析 ATX 标题；代码围栏里的 `##` 不算标题（STATE.md 里有命令块）。
 * @param {unknown} markdown
 * @returns {Array<{level:number,title:string,line:number,content:string}>}
 */
export function extractSections(markdown) {
  const lines = normalizeText(markdown).split('\n');
  const sections = [];
  let current = null;
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const mark = fenceMatch[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      if (current) current.lines.push(line);
      continue;
    }
    if (fence !== null) {
      if (current) current.lines.push(line);
      continue;
    }

    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) {
      const title = heading[2].replace(/[ \t]+#+[ \t]*$/u, '').trim();
      current = { level: heading[1].length, title, line: index + 1, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  return sections.map((section) => ({
    level: section.level,
    title: section.title,
    line: section.line,
    content: section.lines.join('\n').trim(),
  }));
}

/**
 * 找一节。同名多份时优先 level 2（`##`），再按出现顺序取第一份。
 * @param {Array<{level:number,title:string,content:string,line:number}>} sections
 * @param {string} wanted
 * @returns {{level:number,title:string,content:string,line:number}|null}
 */
export function findSection(sections, wanted) {
  if (!Array.isArray(sections)) return null;
  const key = normalizeHeading(wanted);
  const matches = sections.filter((section) => normalizeHeading(section?.title) === key);
  if (matches.length === 0) return null;
  return matches.slice().sort((a, b) => {
    if (a.level === 2 && b.level !== 2) return -1;
    if (b.level === 2 && a.level !== 2) return 1;
    return a.line - b.line;
  })[0];
}

/**
 * 把一节 markdown 压成适合塞进 800 字的短文本。
 * 去掉代码块、表格分隔线、链接地址，保留要点与编号。
 * @param {unknown} markdown
 * @returns {string}
 */
export function cleanMarkdown(markdown) {
  const lines = normalizeText(markdown).split('\n');
  const out = [];
  let fence = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const mark = fenceMatch[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence !== null) continue;

    let text = line.trim();
    if (text === '') continue;
    if (/^<!--.*-->$/u.test(text)) continue;
    if (/^[-*_]{3,}$/u.test(text)) continue;
    if (/^\|?[\s:|-]+\|[\s:|-]*$/u.test(text) && text.includes('|')) continue;

    text = text
      .replace(/^>\s?/u, '')
      .replace(/^#{2,6}\s+/u, '')
      .replace(/^[-*+]\s+/u, '- ')
      .replace(/^\d+[.)]\s+/u, (match) => match.replace(/[.)]/u, '. '))
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/gu, ' ')
      .trim();

    if (text === '') continue;
    out.push(text);
  }

  return out.join('\n');
}

/**
 * 取一节并截断到预算。
 * @param {Array<{level:number,title:string,content:string,line:number}>} sections
 * @param {string} wanted
 * @param {number} maxChars
 * @returns {{text:string, found:boolean, truncated:boolean}}
 */
export function compactSection(sections, wanted, maxChars) {
  const section = findSection(sections, wanted);
  if (!section || section.content.trim() === '') {
    return { text: MISSING_TEXT, found: false, truncated: false };
  }
  const cleaned = cleanMarkdown(section.content);
  if (cleaned === '') return { text: MISSING_TEXT, found: false, truncated: false };
  const cut = truncateChars(cleaned, maxChars);
  return { text: cut.text, found: true, truncated: cut.truncated };
}

/**
 * 从文件名里取日期（`YYYY-MM-DD-...`）。取不到返回 null。
 * @param {unknown} name
 * @returns {number|null}
 */
export function dateFromHandoverName(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[-_. ]|$)/u.exec(String(name ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = new Date(year, month - 1, day).getTime();
  return Number.isFinite(value) ? value : null;
}

/**
 * 交接卡排序：文件名日期优先（这是卡片自称的日期），同日期按 mtime，再按名称。
 * 空日期（不合命名规范）排在最后，只按 mtime。
 * @param {Array<{name:string,mtimeMs?:number}>} entries
 * @returns {Array<{name:string,mtimeMs?:number}>}
 */
export function sortHandoverCards(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry.name === 'string' && /\.md$/iu.test(entry.name))
    .slice()
    .sort((a, b) => {
      const dateA = dateFromHandoverName(a.name);
      const dateB = dateFromHandoverName(b.name);
      if (dateA !== null && dateB !== null && dateA !== dateB) return dateB - dateA;
      if (dateA !== null && dateB === null) return -1;
      if (dateA === null && dateB !== null) return 1;
      const mtimeA = Number(a.mtimeMs) || 0;
      const mtimeB = Number(b.mtimeMs) || 0;
      if (mtimeA !== mtimeB) return mtimeB - mtimeA;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
}

/**
 * 多张里取最新一张。
 * @param {Array<{name:string,mtimeMs?:number}>} entries
 * @returns {{name:string,mtimeMs?:number}|null}
 */
export function selectLatestHandover(entries) {
  const sorted = sortHandoverCards(entries);
  return sorted.length > 0 ? sorted[0] : null;
}

/**
 * 只读读取文本文件，永不抛。
 * @param {string} filePath
 * @returns {{ok:boolean,text:string,error?:string}}
 */
export function readTextFile(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return { ...EMPTY_READ };
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return { ok: true, text: normalizeText(text) };
  } catch (error) {
    return { ok: false, text: '', error: error?.code ?? 'EREAD' };
  }
}

/**
 * 列出 handover 目录下的 .md 文件。目录不存在返回 []。
 * @param {string} handoverDir
 * @returns {Array<{name:string,path:string,mtimeMs:number}>}
 */
export function listHandoverCards(handoverDir) {
  if (typeof handoverDir !== 'string' || handoverDir.trim() === '') return [];
  let entries;
  try {
    entries = fs.readdirSync(handoverDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const cards = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/iu.test(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(handoverDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    cards.push({ name: entry.name, path: fullPath, mtimeMs: stat.mtimeMs });
  }
  return cards;
}

/**
 * 交接卡文件名 → 卡片里显示的短标签：去 .md、去开头日期、下划线转空格。
 * @param {unknown} name
 * @returns {string}
 */
export function handoverLabel(name) {
  return String(name ?? '')
    .replace(/\.md$/iu, '')
    .replace(/^\d{4}-\d{2}-\d{2}[-_ ]?/u, '')
    .replace(/_/gu, ' ')
    .trim();
}

/**
 * 交接卡摘要：优先取「一句话 / 摘要 / 结论」这一节，否则取标题后的开头。
 * @param {unknown} markdown
 * @param {number} maxChars
 * @returns {{text:string,title:string,truncated:boolean}}
 */
export function summarizeHandover(markdown, maxChars) {
  const text = normalizeText(markdown);
  if (text.trim() === '') return { text: '', title: '', truncated: false };
  const sections = extractSections(text);
  const titleSection = sections.find((section) => section.level === 1);
  const title = (titleSection?.title ?? '').trim();

  const preferredNames = ['一句话', '摘要', '结论', '现状锚点'];
  let body = '';
  for (const name of preferredNames) {
    const found = findSection(sections, name);
    if (found && found.content.trim() !== '') {
      body = cleanMarkdown(found.content);
      break;
    }
  }
  if (body === '') {
    // 没有小结节：取一级标题自己的正文（通常在第一个 ## 之前），再退到全文。
    body = cleanMarkdown(titleSection?.content ?? '');
    if (body === '') body = cleanMarkdown(text);
  }

  const prefix = title ? `《${title}》` : '';
  const joined = [prefix, body].filter(Boolean).join('：');
  const cut = truncateChars(joined, maxChars);
  return { text: cut.text, title, truncated: cut.truncated };
}

/**
 * 解析 STATE.md：返回各节原文与命中情况，不决定展示顺序。
 * @param {unknown} markdown
 * @returns {{title:string,sections:Array,found:Record<string,boolean>}}
 */
export function parseState(markdown) {
  const text = normalizeText(markdown);
  const sections = extractSections(text);
  const h1 = sections.find((section) => section.level === 1);
  const found = {};
  for (const [key, name] of Object.entries(STATE_SECTIONS)) {
    found[key] = Boolean(findSection(sections, name)?.content?.trim());
  }
  return { title: h1?.title ?? '', sections, found };
}

/**
 * 记忆根解析：显式 config > 各环境变量 > <DSH home>/longlive-memory。
 * 环境变量顺序与 src/memory/paths.js 一致：DSH_IDENTITY_MEMORY_ROOT（本模块旧名）
 * → DSH_LONGLIVE_MEMORY_ROOT → DSH_MEM，避免身份卡和 memory_* 读到两棵树。
 * @param {{memoryRoot?: string}} [config]
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function resolveMemoryRoot(config = {}, env = process.env) {
  const explicit = config?.memoryRoot;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim());
  const fromEnv = env?.DSH_IDENTITY_MEMORY_ROOT || env?.DSH_LONGLIVE_MEMORY_ROOT || env?.DSH_MEM;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.resolve(DEFAULT_MEMORY_ROOT);
}

/**
 * 把总预算按权重分给各节；保证每节至少 24 字（能放下一行占位）。
 * @param {Array<{key:string,weight:number}>} parts
 * @param {number} total
 * @returns {Record<string,number>}
 */
function allocateBudget(parts, total) {
  const weights = parts.reduce((sum, part) => sum + part.weight, 0);
  const budgets = {};
  let used = 0;
  for (const part of parts) {
    const value = Math.max(24, Math.floor((total * part.weight) / weights));
    budgets[part.key] = value;
    used += value;
  }
  // 超出的从最大的那一节扣，避免最后整体截断把交接卡整个切掉。
  let overflow = used - total;
  while (overflow > 0) {
    const largest = parts
      .slice()
      .sort((a, b) => budgets[b.key] - budgets[a.key])[0];
    if (!largest || budgets[largest.key] <= 24) break;
    budgets[largest.key] -= 1;
    overflow -= 1;
  }
  return budgets;
}

/**
 * R6.2: 「状态卡写于 X 分钟前」——X 是 STATE.md mtime 与 now 的差，不是卡片
 * 生成时间，也不是会话开始时间。拿不到 mtime 时返回 ''（宁可不写，不编造）。
 * @param {unknown} ageMs
 * @returns {string}
 */
export function stateCardAgeText(ageMs) {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return '';
  const minutes = Math.max(0, Math.round(ageMs / 60000));
  return `状态卡写于 ${minutes} 分钟前`;
}

/**
 * Resolve the STATE.md age in ms from explicit inputs, falling back to stat()
 * on `statePath`. Missing/unknown age returns null — the card then omits the
 * sentence instead of inventing a number.
 */
function resolveStateAgeMs(input, safeNow) {
  if (typeof input.stateAgeMs === 'number' && Number.isFinite(input.stateAgeMs)) {
    return Math.max(0, input.stateAgeMs);
  }
  let mtimeMs = typeof input.stateMtimeMs === 'number' && Number.isFinite(input.stateMtimeMs)
    ? input.stateMtimeMs
    : null;
  if (mtimeMs === null && typeof input.statePath === 'string' && input.statePath.trim() !== '') {
    try {
      mtimeMs = fs.statSync(input.statePath).mtimeMs;
    } catch {
      mtimeMs = null;
    }
  }
  if (mtimeMs === null) return null;
  return Math.max(0, safeNow.getTime() - mtimeMs);
}

/**
 * 生成开机卡。纯函数：所有输入显式传入，方便覆盖缺失/超长/中文路径等边界。
 * @param {{
 *   stateText?: string|null,
 *   handover?: {name?:string,text?:string}|null,
 *   maxChars?: number,
 *   now?: Date|number|string,
 *   statePath?: string,
 *   stateMtimeMs?: number,
 *   stateAgeMs?: number,
 *   handoverPath?: string,
 * }} [input]
 * @returns {{
 *   text:string, chars:number, truncated:boolean, warnings:string[],
 *   found:Record<string,boolean>, handoverName:string|null,
 *   stateAgeMinutes:number|null,
 * }}
 */
export function buildOpenCard(input = {}) {
  const maxChars = Number.isFinite(input.maxChars) && input.maxChars > 0
    ? Math.floor(input.maxChars)
    : DEFAULT_MAX_CHARS;
  const now = input.now instanceof Date
    ? input.now
    : new Date(input.now ?? Date.now());
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const stateAgeMs = resolveStateAgeMs(input, safeNow);
  const stateAgeMinutes = stateAgeMs === null ? null : Math.max(0, Math.round(stateAgeMs / 60000));
  const warnings = [];
  const stateText = typeof input.stateText === 'string' ? normalizeText(input.stateText) : '';
  if (input.stateText === null || input.stateText === undefined) warnings.push('STATE_MISSING');
  else if (stateText.trim() === '') warnings.push('STATE_EMPTY');

  const parsed = parseState(stateText);
  if (!parsed.found.where) warnings.push(`SECTION_MISSING:${STATE_SECTIONS.where}`);
  if (!parsed.found.waiting) warnings.push(`SECTION_MISSING:${STATE_SECTIONS.waiting}`);
  if (!parsed.found.recent) warnings.push(`SECTION_MISSING:${STATE_SECTIONS.recent}`);

  const handoverText = typeof input.handover?.text === 'string'
    ? normalizeText(input.handover.text)
    : '';
  const handoverName = typeof input.handover?.name === 'string' && input.handover.name.trim() !== ''
    ? input.handover.name.trim()
    : null;
  if (!input.handover) warnings.push('HANDOVER_MISSING');
  else if (handoverText.trim() === '') warnings.push('HANDOVER_EMPTY');

  const ageText = stateCardAgeText(stateAgeMs);
  const header = `【开机卡】${formatCardTime(safeNow)}${ageText === '' ? '' : ` · ${ageText}`}`;
  const headings = {
    where: '▍我在哪',
    waiting: '▍在等什么',
    recent: '▍最近三件',
    handover: '▍交接卡',
  };
  const overhead = charLength(header)
    + Object.values(headings).reduce((sum, value) => sum + charLength(value), 0)
    + 10;
  const usable = Math.max(80, maxChars - overhead);
  const budgets = allocateBudget([
    { key: 'where', weight: 1.1 },
    { key: 'waiting', weight: 0.9 },
    { key: 'recent', weight: 1.1 },
    { key: 'handover', weight: 1.3 },
  ], usable);

  const where = compactSection(parsed.sections, STATE_SECTIONS.where, budgets.where);
  const waiting = compactSection(parsed.sections, STATE_SECTIONS.waiting, budgets.waiting);
  const recent = compactSection(parsed.sections, STATE_SECTIONS.recent, budgets.recent);

  let handoverBody;
  let handoverTitle = '';
  if (handoverText.trim() === '') {
    handoverBody = { text: '（没有找到交接卡）', truncated: false };
  } else {
    const summary = summarizeHandover(handoverText, budgets.handover);
    handoverTitle = summary.title.trim();
    handoverBody = { text: summary.text, truncated: summary.truncated };
  }

  const lines = [
    header,
    headings.where,
    where.text,
    headings.waiting,
    waiting.text,
    headings.recent,
    recent.text,
    headings.handover,
    handoverName && handoverTitle === '' ? `《${handoverLabel(handoverName)}》` : '',
    handoverBody.text,
  ].filter((line) => line !== '');

  const joined = lines.join('\n');
  const cut = truncateChars(joined, maxChars);
  const sectionTruncated = where.truncated || waiting.truncated || recent.truncated || handoverBody.truncated;
  if (cut.truncated) warnings.push('CARD_TRUNCATED');
  else if (sectionTruncated) warnings.push('SECTION_TRUNCATED');

  return {
    text: cut.text,
    chars: charLength(cut.text),
    truncated: cut.truncated || sectionTruncated,
    warnings,
    found: { ...parsed.found, handover: handoverText.trim() !== '' },
    handoverName,
    stateAgeMinutes,
  };
}

/**
 * 本地时间 `YYYY-MM-DD HH:mm`，卡片头用。
 * @param {Date} date
 * @returns {string}
 */
export function formatCardTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 读 STATE + 最新一张非空 handover，生成开机卡。只读，不抛。
 * 最新卡片为空时向旧卡回退，并留下 HANDOVER_LATEST_EMPTY 警告。
 * @param {{
 *   memoryRoot?: string,
 *   statePath?: string,
 *   handoverDir?: string,
 *   handoverPath?: string,
 *   maxChars?: number,
 *   now?: Date|number|string,
 *   env?: Record<string,string|undefined>,
 * }} [options]
 * @returns {ReturnType<typeof buildOpenCard> & {
 *   statePath:string, handoverPath:string|null, errors:string[],
 * }}
 */
export function collectOpenCard(options = {}) {
  const memoryRoot = resolveMemoryRoot(options, options.env ?? process.env);
  const statePath = options.statePath
    ? path.resolve(options.statePath)
    : path.join(memoryRoot, 'STATE.md');
  const handoverDir = options.handoverDir
    ? path.resolve(options.handoverDir)
    : path.join(memoryRoot, 'handover');

  const errors = [];
  const stateRead = readTextFile(statePath);
  if (!stateRead.ok) errors.push(`STATE_READ_FAILED:${stateRead.error}`);
  // R6.2: the open card must say how old the state card is. Read the mtime
  // once here; a missing file leaves it unknown and the sentence is omitted.
  let stateMtimeMs = null;
  try {
    stateMtimeMs = fs.statSync(statePath).mtimeMs;
  } catch {
    stateMtimeMs = null;
  }

  let handover = null;
  let handoverPath = null;
  const explicit = options.handoverPath ? path.resolve(options.handoverPath) : null;

  if (explicit) {
    const read = readTextFile(explicit);
    if (read.ok && read.text.trim() !== '') {
      handover = { name: path.basename(explicit), text: read.text };
      handoverPath = explicit;
    } else {
      errors.push(`HANDOVER_READ_FAILED:${read.error ?? 'EMPTY'}`);
    }
  } else {
    const sorted = sortHandoverCards(listHandoverCards(handoverDir));
    for (const entry of sorted) {
      const read = readTextFile(entry.path);
      if (!read.ok) {
        errors.push(`HANDOVER_READ_FAILED:${read.error}`);
        continue;
      }
      if (read.text.trim() === '') continue;
      handover = { name: entry.name, text: read.text };
      handoverPath = entry.path;
      if (entry !== sorted[0]) errors.push('HANDOVER_LATEST_EMPTY');
      break;
    }
  }

  const card = buildOpenCard({
    stateText: stateRead.ok ? stateRead.text : null,
    handover,
    maxChars: options.maxChars,
    now: options.now,
    statePath,
    stateMtimeMs,
    handoverPath: handoverPath ?? undefined,
  });

  return {
    ...card,
    warnings: [...card.warnings, ...errors],
    statePath,
    handoverPath,
    errors,
  };
}
