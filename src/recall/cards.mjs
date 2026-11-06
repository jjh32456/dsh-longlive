/**
 * cards.mjs — 把 <memoryRoot>/topics/*.md 读成 auto-recall 认识的卡对象。
 *
 * 这是唯一碰文件系统的地方；auto-recall.mjs 保持零依赖纯函数，方便单测与在宿主里复用。
 * 只读：本模块不写任何文件。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 极简 YAML frontmatter 解析器：只需要支持本仓库实际用到的形态
 * （`key: value`、`key: ["a","b"]` 可跨行、`key:` + `  - item` 块状列表）。
 *
 * v4：块状列表以前会被静默解析成 ''（scope_in 为空 → 卡变成 noScope，永不召回）。
 * 现在识别 `key:` 后续的 `- item` 行；`scope_*` 显式留空但没有任何子项时给 warning，
 * 由调用方（插件启动）打出来，不再假装解析成功。
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: src, hasFrontmatter: false, warnings: [] };

  const data = {};
  const warnings = [];
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value.startsWith('[')) {
      // 括号没闭合就往下续行，直到配平
      let depth = countBrackets(value);
      while (depth > 0 && i + 1 < lines.length) {
        i += 1;
        value += '\n' + lines[i];
        depth = countBrackets(value);
      }
      data[key] = coerce(value);
      continue;
    }
    if (value === '') {
      // YAML 块状列表：key:\n  - a\n  - b
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const item = lines[j].match(/^\s*-\s+(.*)$/);
        if (!item) break;
        const itemValue = unquoteScalar(item[1]);
        if (itemValue !== '') items.push(itemValue);
        j += 1;
      }
      if (items.length > 0) {
        data[key] = items;
        i = j - 1;
        continue;
      }
      if (SCOPE_KEYS.has(key)) {
        warnings.push(`${key}: 声明了 key 但块状列表没有任何 "- item" 子项，按空数组处理`);
      }
    }
    data[key] = coerce(value);
  }
  return { data, body: src.slice(m[0].length), hasFrontmatter: true, warnings };
}

/** 这些 key 期望是列表；显式留空多半是块状写法没被认出来。 */
const SCOPE_KEYS = new Set(['scope_in', 'scope_out', 'scope_aliases']);

function unquoteScalar(value) {
  const v = String(value ?? '').trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function countBrackets(s) {
  let depth = 0;
  let quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
  }
  return depth;
}

function parseList(value) {
  const v = String(value ?? '').trim();
  if (v === '' || v === '[]') return [];
  if (v.startsWith('[')) {
    try {
      const arr = JSON.parse(v.replace(/\n/g, ' '));
      if (Array.isArray(arr)) return arr.map((x) => String(x));
    } catch {
      /* fall through：非严格 JSON（单引号、尾逗号）用正则兜底 */
    }
    return [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)]
      .map((mm) => (mm[1] !== undefined ? mm[1] : mm[2]))
      .map((s) => s.replace(/\\"/g, '"'));
  }
  return v.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function coerce(value) {
  const v = String(value ?? '').trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith('[')) return parseList(v);
  return v.replace(/^["']|["']$/g, '');
}

/**
 * @param {string} raw 文件全文
 * @param {string} relPath 相对记忆根的路径（如 topics/ear.md）
 */
export function parseCard(raw, relPath) {
  const { data, body, hasFrontmatter, warnings } = parseFrontmatter(raw);
  const title = typeof data.title === 'string' && data.title.trim() !== ''
    ? data.title.trim()
    : path.basename(relPath, '.md');
  const localOnly = data.local_only === true || data.localOnly === true || data.local === true;
  return {
    path: String(relPath).replace(/\\/g, '/'),
    title,
    body,
    scopeIn: Array.isArray(data.scope_in) ? data.scope_in : [],
    scopeOut: Array.isArray(data.scope_out) ? data.scope_out : [],
    aliases: Array.isArray(data.scope_aliases) ? data.scope_aliases : [],
    salience: typeof data.salience === 'number' ? data.salience : null,
    strength: typeof data.strength === 'number' ? data.strength : null,
    date: typeof data.date === 'string' ? data.date : null,
    localOnly,
    hasFrontmatter,
    warnings,
  };
}

/**
 * 读卡目录。默认只读 `<root>/topics/*.md`；传 `dirs` 可一次读多目录
 * （例如 `['topics','handover']`，handover 交给路径级排除用）。
 * - `dir` 单目录模式保持旧行为：目录不存在就抛错；
 * - `dirs` 多目录模式：缺的目录跳过，一个都没读到才抛错。
 * 每张卡带 `dir`，`path` 恒为 `<dir>/<file>.md`。
 */
export function loadCards(memoryRoot, { dir = 'topics', dirs = null } = {}) {
  const list = Array.isArray(dirs) && dirs.length > 0 ? dirs : [dir];
  const multi = Array.isArray(dirs) && dirs.length > 0;
  const missing = [];
  const cards = [];
  for (const d of list) {
    const cardDir = path.join(memoryRoot, d);
    if (!fs.existsSync(cardDir)) {
      if (!multi) throw new Error(`card dir not found: ${cardDir}`);
      missing.push(cardDir);
      continue;
    }
    const files = fs.readdirSync(cardDir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
    for (const f of files) {
      const abs = path.join(cardDir, f);
      const card = parseCard(fs.readFileSync(abs, 'utf8'), `${d}/${f}`);
      card.dir = d;
      card.absPath = abs;
      card.noScope = card.scopeIn.length === 0 && card.aliases.length === 0;
      cards.push(card);
    }
  }
  if (cards.length === 0) {
    throw new Error(`card dir not found: ${missing.join(', ') || list.join(', ')}`);
  }
  return cards;
}

/** 卡片清单的紧凑视图（调试/CLI 用）。 */
export function summarizeCards(cards) {
  return cards.map((c) => ({
    path: c.path,
    dir: c.dir || String(c.path || '').split('/')[0],
    title: c.title,
    phrases: (c.scopeIn?.length || 0) + (c.aliases?.length || 0),
    localOnly: c.localOnly === true,
    noScope: c.noScope === true,
    bodyChars: (c.body || '').length,
  }));
}
