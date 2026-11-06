/**
 * privacy.mjs — 把「现成隐私门」接进 auto-recall 的唯一适配层。
 *
 * 规则（不复制、不重写）：优先同步调用
 *   同级 privacy-gate 仓库（DSH_PRIVACY_GATE 可覆盖）的 scanPrivacy(text)
 * 返回 {verdict:'none'|'local_only', spans, reasons}。
 *
 * 为什么用 createRequire 而不是静态 import：
 *   - auto-recall 的核心要保持「零 import、可单测」；
 *   - 隐私门是 ESM，但 Node ≥22 支持同步 require(ESM)（本机 v24.21.0 已验证）；
 *   - 这样门缺失时模块仍能加载，退到核心自带的保守 PII 兜底，绝不因「门没装」而放行。
 *
 * 命中口径 = 隐私门的 verdict==='local_only' **或** 核心兜底正则命中（取并集，宁可多拦）。
 * 调用方：bin/eval.mjs、bin/eval-fresh.mjs、bin/recall-once.mjs、plugin/src/index.js
 *        以及 test/auto-recall.test.mjs（证明真门被调用）。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** 环境变量优先；其次是作者树旁边的 privacy-gate；最后是绝对路径兜底。 */
export const GATE_CANDIDATES = [
  process.env.DSH_PRIVACY_GATE,
  path.resolve(HERE, '../../../privacy-gate/src/memory/privacy-gate.js'),
].filter((p) => typeof p === 'string' && p.trim() !== '');

let realScan = null;
let loadedFrom = null;
let loadError = null;
for (const candidate of GATE_CANDIDATES) {
  try {
    const mod = require(candidate);
    if (typeof mod?.scanPrivacy === 'function') {
      realScan = mod.scanPrivacy;
      loadedFrom = candidate;
      break;
    }
    loadError = `scanPrivacy not exported by ${candidate}`;
  } catch (error) {
    loadError = `${candidate}: ${error?.code ?? error?.message ?? error}`;
  }
}

/* 核心兜底：只认三类最硬的 PII，避免把普通数字（token 数、ID 号）误判。 */
const PII_PATTERNS = [
  { kind: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'id-card', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
];

/** 核心自带的保守扫描（不依赖任何外部文件）。 */
export function fallbackScan(text) {
  const s = String(text ?? '');
  const spans = [];
  for (const { kind, re } of PII_PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(s);
    while (m !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind });
      if (m.index === re.lastIndex) re.lastIndex += 1;
      m = re.exec(s);
    }
  }
  spans.sort((a, b) => a.start - b.start);
  if (spans.length === 0) return { verdict: 'none', spans: [], reasons: [], source: 'core-fallback' };
  return {
    verdict: 'local_only',
    spans,
    reasons: [...new Set(spans.map((x) => x.kind))],
    source: 'core-fallback',
  };
}

/**
 * 注入前的隐私扫描（同步）。
 * - 隐私门可用 → 调它；门抛错 → fail-closed；
 * - 门说 none 但兜底正则命中 → 仍按命中处理（并集）。
 * @param {string} text
 * @returns {{verdict:'none'|'local_only', spans:object[], reasons:string[], source:string}}
 */
export function privacyScan(text) {
  const s = String(text ?? '');
  const local = fallbackScan(s);
  if (local.verdict === 'local_only') return local;
  if (!realScan) return local;
  try {
    const result = realScan(s);
    if (result && result.verdict === 'local_only') {
      return {
        verdict: 'local_only',
        spans: Array.isArray(result.spans) ? result.spans : [],
        reasons: Array.isArray(result.reasons) ? result.reasons : [],
        source: 'privacy-gate',
      };
    }
    return { verdict: 'none', spans: [], reasons: [], source: 'privacy-gate' };
  } catch (error) {
    return {
      verdict: 'local_only',
      spans: [],
      reasons: [`scan-error:${error?.code ?? error?.message ?? error}`],
      source: 'privacy-gate:error',
    };
  }
}

/** 诊断信息：门到底有没有装上（不打印任何敏感内容）。 */
export const privacyGateStatus = Object.freeze({
  loaded: realScan !== null,
  from: loadedFrom,
  error: realScan === null ? loadError : null,
});

/** 给 chooseRecall 用的一次性参数：`options: { ...privacyDefaults }`。 */
export const privacyDefaults = Object.freeze({ privacyScan });
