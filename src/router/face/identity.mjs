// routerFace v1 · 前后台共用身份文件。
//
// 规则（v1 边界，不要放宽）：
//   - 唯一来源是 `<memoryRoot>/IDENTITY.md`，前台 hint 与后台面读同一份；
//   - **只读**：这里没有写入函数，插件永远不会创建或改写它；
//   - 文件不存在 / 读失败 / 内容为空 → 用内置 DEFAULT_IDENTITY；
//   - 解析是宽松的「键：值」行，未知行忽略，绝不因为格式问题抛错。
//
// 支持两种键写法（中文全角冒号 / 英文半角冒号）：
//   名字 / name
//   称呼 / address
//   必须守的 / rules
//   说话方式 / voice

import fs from 'node:fs';

export const IDENTITY_FILE_NAME = 'IDENTITY.md';
export const IDENTITY_MAX_CHARS = 2000;
export const IDENTITY_LINE_MAX_CHARS = 120;

export const DEFAULT_IDENTITY = [
  '# IDENTITY（内置默认）',
  '名字：（未设置）',
  '称呼：（未设置）',
  '必须守的：不说假话；不确定就明说没查；不为讨好改结论',
  '说话方式：简洁、直接；有情绪可以说，但不要端着；错了直接认，不辩解',
].join('\n');

const KEY_ALIASES = new Map([
  ['名字', 'name'],
  ['name', 'name'],
  ['称呼', 'address'],
  ['address', 'address'],
  ['必须守的', 'rules'],
  ['必须遵守', 'rules'],
  ['rules', 'rules'],
  ['说话方式', 'voice'],
  ['voice', 'voice'],
]);

function clean(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateChars(text, maxChars) {
  const chars = Array.from(String(text ?? ''));
  if (!Number.isInteger(maxChars) || maxChars <= 0 || chars.length <= maxChars) return chars.join('');
  if (maxChars <= 1) return chars.slice(0, maxChars).join('');
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

/**
 * 读 IDENTITY.md。永不抛错；返回 source 让调用方知道是否用了默认值。
 *
 * @param {string|null} file
 * @returns {{text:string, source:'file'|'default', path:string|null, chars:number, warning?:string}}
 */
export function readIdentity(file) {
  if (!file) {
    return { text: DEFAULT_IDENTITY, source: 'default', path: null, chars: DEFAULT_IDENTITY.length };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const warning = error?.code === 'ENOENT' ? 'E_IDENTITY_MISSING' : 'E_IDENTITY_READ';
    return {
      text: DEFAULT_IDENTITY,
      source: 'default',
      path: file,
      chars: DEFAULT_IDENTITY.length,
      warning,
    };
  }
  const cleanText = text.replace(/^\uFEFF/u, '').trim();
  if (cleanText === '') {
    return { text: DEFAULT_IDENTITY, source: 'default', path: file, chars: DEFAULT_IDENTITY.length, warning: 'E_IDENTITY_EMPTY' };
  }
  const capped = truncateChars(cleanText, IDENTITY_MAX_CHARS);
  return {
    text: capped,
    source: 'file',
    path: file,
    chars: Array.from(capped).length,
    ...(capped !== cleanText ? { warning: 'E_IDENTITY_TOO_LONG' } : {}),
  };
}

/**
 * 解析「名字 / 称呼 / 必须守的 / 说话方式」四行。缺失的字段留空串。
 * 只认第一条匹配，后面的同名字段忽略（不覆盖）。
 */
export function parseIdentity(text) {
  const out = { name: '', address: '', rules: '', voice: '' };
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/^[-*]\s*/u, '');
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^([^:：]{1,16})\s*[:：]\s*(.+)$/u);
    if (!match) continue;
    const key = KEY_ALIASES.get(match[1].trim());
    if (!key || out[key] !== '') continue;
    const value = clean(match[2]).replace(/^[「『"']+|[」』"']+$/gu, '').trim();
    if (value !== '') out[key] = value;
  }
  return out;
}

/**
 * 把身份压成一行 hint 摘要（前台 hint 用）。
 * 只带名字、称呼和一条「必须守的」，把 700-token 预算留给共享板本身。
 */
export function renderIdentityLine(identityOrText, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : IDENTITY_LINE_MAX_CHARS;
  const parsed = typeof identityOrText === 'string'
    ? parseIdentity(identityOrText)
    : parseIdentity(identityOrText?.text ?? '');
  const parts = [];
  if (parsed.name) parts.push(parsed.name);
  if (parsed.address) parts.push(`称呼：${parsed.address}`);
  if (parsed.rules) parts.push(`守：${parsed.rules}`);
  if (parts.length === 0) return '';
  return `身份：${parts.join(' · ')}`.slice(0, maxChars);
}

export { truncateChars };
