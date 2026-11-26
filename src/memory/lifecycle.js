// lifecycle.js — 1.8.11 记忆卡生命周期（独立于 status 的第二条轴）
//
// 契约（SPEC-1.8.11 D1 / 红队 E1）：
//   - 绝不读写 `status`；`status` 仍只有 active / locked / archived。
//   - `lifecycle` 缺失 = 普通卡（不写默认值；迁移只写需要降级的卡）。
//   - 只有两个值：canonical（现行口径）与 historical（历史口径）。
//   - 排序：canonical rank=0 / 普通 rank=1 / historical rank=2。
//
// 写入用 frontmatter.js 的 updateExtras(text, { lifecycle })（未知键走 extras）。

import fs from 'node:fs';
import path from 'node:path';

export const LIFECYCLE_VALUES = Object.freeze(['canonical', 'historical']);

/** @typedef {'canonical'|'historical'} Lifecycle */

export function normalizeLifecycleValue(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  return LIFECYCLE_VALUES.includes(text) ? text : null;
}

/**
 * 从卡片对象或 parseFrontmatter 结果里读 lifecycle。
 * 兼容形状：{ lifecycle } / { extras:{ lifecycle } } / { fields:{ lifecycle } }。
 * 非法值按 null（普通卡）处理，不抛——读路径必须 fail-open。
 */
export function readLifecycle(cardOrFrontmatter) {
  if (!cardOrFrontmatter || typeof cardOrFrontmatter !== 'object') return null;
  const direct = normalizeLifecycleValue(cardOrFrontmatter.lifecycle);
  if (direct) return direct;
  const extra = normalizeLifecycleValue(cardOrFrontmatter.extras?.lifecycle);
  if (extra) return extra;
  const field = normalizeLifecycleValue(cardOrFrontmatter.fields?.lifecycle);
  if (field) return field;
  return null;
}

export function isCanonical(card) {
  return readLifecycle(card) === 'canonical';
}

export function isHistorical(card) {
  return readLifecycle(card) === 'historical';
}

// 显式历史查询词：只有用户真的在问「以前/旧版/被取代」时，才允许历史卡不降权。
// 单一实现（D9）：recall/edges.js 与 memory/recall.js 都从这里取，不许两份正则。
const HISTORY_QUERY_RE = /以前|之前|旧版|旧口径|历史|被取代|原来的|早先|老版|上一版|作废/;

export function isHistoricalQuery(queryText) {
  return HISTORY_QUERY_RE.test(String(queryText ?? ''));
}

/**
 * 排序键：canonical=0 / 普通=1 / historical=2。
 * 接受卡片对象、路径字符串（配合 options.memoryRoot 解析相对路径）或 frontmatter。
 */
export function lifecycleRank(card, options = {}) {
  const value = typeof card === 'string'
    ? readCardLifecycle(card, options)
    : readLifecycle(card);
  if (value === 'canonical') return 0;
  if (value === 'historical') return 2;
  return 1;
}

/**
 * 从整篇卡文本里只取 lifecycle 行。
 * 不复用 memory/frontmatter.js 的 parseFrontmatter：那张解析器对 `scope_in:` 这类
 * 块状列表会抛 E_FRONTMATTER_MULTILINE（记忆卡自己用，但召回 topics 卡普遍是块状），
 * 读 lifecycle 不能让整张卡因为无关字段解析失败。这里只做「找 frontmatter 块 + 找一行」，
 * 与 cards.mjs 的宽容解析口径一致。
 */
export function readLifecycleFromText(text) {
  if (typeof text !== 'string') return null;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(src);
  if (!block) return null;
  const line = /^[ \t]*lifecycle[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(block[1]);
  return line ? normalizeLifecycleValue(line[1]) : null;
}

/**
 * 按路径读卡 lifecycle。读失败/文件不存在/坏 frontmatter 一律返回 null（fail-open），
 * 绝不因为读卡失败把普通卡当成 historical。
 * @param {string} cardPath 绝对路径，或相对 memoryRoot 的路径
 * @param {{memoryRoot?: string}} options
 */
export function readCardLifecycle(cardPath, options = {}) {
  if (typeof cardPath !== 'string' || cardPath.trim() === '') return null;
  let file = cardPath;
  if (!path.isAbsolute(file) && options.memoryRoot) {
    file = path.resolve(options.memoryRoot, file);
  }
  try {
    return readLifecycleFromText(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 给渲染层用：历史卡要带一行标注，现行卡不标注。 */
export function lifecycleLabel(card) {
  return isHistorical(card) ? '历史口径' : null;
}
