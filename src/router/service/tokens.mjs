// Token 估算（DESIGN §3.6）。
//
// 本阶段不引入 tokenizer：CJK 字符按 1 token、其他字符按 4 字符 1 token，
// 再乘 1.05 的安全系数并向上取整。它只用于预算预留和上下文裁剪，不用于计费。

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

export const TOKEN_SAFETY = 1.05;

export function isCjkChar(char) {
  return CJK_RE.test(char);
}

/**
 * @param {unknown} input
 * @returns {number} 非负整数
 */
export function estimateTokens(input) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_RE.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.max(0, Math.ceil((cjk + other / 4) * TOKEN_SAFETY));
}

export function countChars(input) {
  return Array.from(String(input ?? '')).length;
}

/**
 * 按 token 预算截断文本；返回值带 truncated 标记。
 * 保证返回文本自身的 estimateTokens <= maxTokens（除非 maxTokens 小到连一个字符都放不下）。
 *
 * @param {unknown} input
 * @param {number} maxTokens
 * @param {{marker?:string, minChars?:number}} [options]
 * @returns {{text:string,tokens:number,chars:number,truncated:boolean}}
 */
export function truncateToTokens(input, maxTokens, options = {}) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const limit = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;
  if (limit === 0) return { text: '', tokens: 0, chars: 0, truncated: true };
  const chars = Array.from(text);
  if (estimateTokens(text) <= limit) {
    return { text, tokens: estimateTokens(text), chars: chars.length, truncated: false };
  }
  const marker = typeof options.marker === 'string' ? options.marker : '…';
  const minChars = Number.isInteger(options.minChars) && options.minChars > 0 ? options.minChars : 0;
  let low = Math.min(minChars, chars.length);
  let high = chars.length;
  let best = low;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = chars.slice(0, mid).join('') + (mid < chars.length ? marker : '');
    if (estimateTokens(candidate) <= limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  let out = chars.slice(0, best).join('');
  if (best < chars.length) out += marker;
  // marker 可能把结果顶出预算：必要时再退一个字符。
  while (out.length > 0 && estimateTokens(out) > limit) out = Array.from(out).slice(0, -2).join('') + marker;
  return {
    text: out,
    tokens: estimateTokens(out),
    chars: Array.from(out).length,
    truncated: true,
  };
}

/**
 * 任务载荷裁剪：保留头部 60% + 尾部 20%，中间用标记替代（DESIGN §3.5 第 3 步）。
 * @param {string} input
 * @param {number} maxChars
 * @returns {{text:string,truncated:boolean,removed:number}}
 */
export function headTailTruncate(input, maxChars) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { text: '', truncated: text.length > 0, removed: Array.from(text).length };
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, truncated: false, removed: 0 };
  const headCount = Math.max(1, Math.floor(maxChars * 0.6));
  const tailCount = Math.max(0, Math.floor(maxChars * 0.2));
  const removed = chars.length - headCount - tailCount;
  const marker = `…[truncated ${removed} chars]…`;
  const head = chars.slice(0, headCount).join('');
  const tail = tailCount > 0 ? chars.slice(chars.length - tailCount).join('') : '';
  return { text: `${head}${marker}${tail}`, truncated: true, removed };
}
