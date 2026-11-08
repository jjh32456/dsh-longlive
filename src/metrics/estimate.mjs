/**
 * D1/D4 — token estimation primitives.
 *
 * The harness does not hand plugins a tokenizer.  Every layer number in the
 * ledger is therefore an ESTIMATE unless the provider usage is attached:
 *
 *     tokens = ceil(CJK_chars * 1 + other_chars / 3.5)
 *
 * That is the baseline documented in `docs/METRICS.md`.  The ledger keeps the
 * raw value and a calibration factor so the operator can see both the
 * documented estimate and the factor-corrected forecast.
 *
 * No imports: this file is pure and directly unit-testable.
 */

export const ESTIMATOR_ID = 'cjk*1+other/3.5';
export const CHARS_PER_TOKEN = 3.5;

// CJK Unified Ideographs (+ Ext A), compatibility ideographs, CJK punctuation
// and full-width forms, kana and hangul.  This matches the intent of the
// existing recall estimator while keeping the documented /3.5 divisor.
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3040-\u30FF\uAC00-\uD7AF]/g;

/** Count CJK code points (non-overlapping, surrogate-safe enough for BMP). */
export function countCjk(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const matches = text.match(CJK_RE);
  return matches === null ? 0 : matches.length;
}

/**
 * Estimate tokens for one string.
 * Empty / non-string / nullish input is 0, never NaN.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const cjk = countCjk(text);
  const other = text.length - cjk;
  return Math.ceil(cjk + other / CHARS_PER_TOKEN);
}

/**
 * Text of a model-visible content value.
 *
 * `reasoning` blocks are intentionally ignored: they are model-internal and
 * are not part of the measured request on this provider.  Tool calls do count
 * because their name + arguments are serialized into the request.
 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      case 'tool-call': {
        const name = typeof block.name === 'string' ? block.name : '';
        const args = typeof block.arguments === 'string'
          ? block.arguments
          : block.arguments === undefined ? '' : JSON.stringify(block.arguments);
        parts.push(`${name}${args}`);
        break;
      }
      case 'tool-result':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      default:
        // reasoning / image / unknown blocks do not contribute here.
        break;
    }
  }
  return parts.join('\n');
}

/** Text of one surface message (role is irrelevant). */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  return contentText(message.content);
}

/**
 * Estimate one message.  A non-empty message carries a small role/envelope
 * overhead (4 tokens) so a request with many tiny turns is not undercounted.
 */
export function estimateMessageTokens(message) {
  const text = messageText(message);
  if (text === '') return 0;
  return 4 + estimateTokens(text);
}

/**
 * Estimate a tool-schema array.  The host serializes the canonical header's
 * `tools` value as JSON into the request, so JSON length is the right proxy.
 */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  let json;
  try {
    json = JSON.stringify(tools);
  } catch {
    return 0;
  }
  if (typeof json !== 'string' || json.length === 0) return 0;
  return 4 + estimateTokens(json);
}
