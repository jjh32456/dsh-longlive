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
 *   - 这样门缺失时模块仍能加载，退到核心自带的保守兜底，绝不因「门没装」而放行。
 *
 * 命中口径 = 隐私门的 verdict==='local_only' **或** 核心兜底正则命中（取并集，宁可多拦）。
 * 兜底分两类：
 *   - PII：手机号 / 邮箱 / 身份证（1.6.7 起就有）；
 *   - 密钥/令牌（1.6.8 红队 S3 补）：sk-*、Bearer …、*_API_KEY=*、token=/secret=/password=、
 *     私钥头、AWS/GitHub/Slack 凭证前缀。活动板是跨会话共享的，
 *     手机号只泄漏一个人的联系方式，密钥泄漏的是账号本身。
 *
 * 发布形态下（没有 privacy-gate 仓库）只靠兜底；DSH_PRIVACY_GATE 显式配置但不可达时
 * 在加载期 `process.emitWarning` 一次，并强制走强化后的本地规则 —— 不允许静默放行。
 *
 * 调用方：bin/eval.mjs、bin/eval-fresh.mjs、bin/recall-once.mjs、plugin/src/index.js、
 *         src/activity/{store,index}.js 以及 test/auto-recall.test.mjs（证明真门被调用）。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const ENV_GATE = typeof process.env.DSH_PRIVACY_GATE === 'string' && process.env.DSH_PRIVACY_GATE.trim() !== ''
  ? process.env.DSH_PRIVACY_GATE.trim()
  : null;

/** 环境变量优先；其次是作者树旁边的 privacy-gate；最后是绝对路径兜底。 */
export const GATE_CANDIDATES = [
  ENV_GATE,
  path.resolve(HERE, '../../../privacy-gate/src/memory/privacy-gate.js'),
].filter((p) => typeof p === 'string' && p.trim() !== '');

let realScan = null;
let loadedFrom = null;
let loadError = null;
const loadErrors = [];
for (const candidate of GATE_CANDIDATES) {
  try {
    const mod = require(candidate);
    if (typeof mod?.scanPrivacy === 'function') {
      realScan = mod.scanPrivacy;
      loadedFrom = candidate;
      break;
    }
    loadErrors.push(`scanPrivacy not exported by ${candidate}`);
  } catch (error) {
    loadErrors.push(`${candidate}: ${error?.code ?? error?.message ?? error}`);
  }
}
loadError = loadErrors.length > 0 ? loadErrors[loadErrors.length - 1] : null;
// Diagnostics should name the explicitly configured gate when that is the one
// that failed — not the author-tree fallback that was tried after it.
if (ENV_GATE !== null) {
  const envFailure = loadErrors.find((entry) => entry.startsWith(ENV_GATE));
  if (envFailure) loadError = envFailure;
}

/** 显式配置了门却装不上：不静默放行，加载期告警一次，扫描强制走强化本地规则。 */
const gateConfigured = ENV_GATE !== null;
const forcedFallback = gateConfigured && realScan === null;
if (forcedFallback) {
  try {
    process.emitWarning(
      `[longlive:privacy] DSH_PRIVACY_GATE 已配置但不可达（${loadError ?? 'unknown'}）`
      + '；已强制使用强化本地兜底规则（含密钥/令牌模式），不会静默放行。',
    );
  } catch {
    /* warning is best effort; the scan below is what enforces the rule */
  }
}

/* 核心兜底 · 一类最硬的 PII：避免把普通数字（token 数、ID 号）误判。 */
const PII_PATTERNS = [
  { kind: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'id-card', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
];

/*
 * 核心兜底 · 密钥/令牌类。全部要求「像凭证」才拦，尽量不误伤普通文本：
 *   - sk- 前缀要求前面不是标识符字符（`task-id-1234567890` 里的 `sk-id-…` 不算）；
 *   - `token=`/`api_key=` 这类赋值要求至少 6–8 位值，`token 数 12`、`--test` 不会命中；
 *   - 赋值形态允许 `[a-z0-9_]{0,32}` 前缀（RE-S3.1：`my_api_key: …`、`apiKey=…`、
 *     `secret token: …`），分隔符允许 `= : ： ,` 与两侧空格；**纯空格不算分隔符**，
 *     所以 `password reset flow` / `password 字段在 config.js 里` 不误伤；
 *   - PRIVATE KEY 头、AWS/GitHub/Slack 前缀是强特征，直接拦。
 */
const ASSIGN_VALUE = String.raw`['"]?[A-Za-z0-9._\-/+!@#$%^&*]{6,}`;
const SECRET_PATTERNS = [
  // RE-S3.7: sk-/SK- 前缀大小写不敏感（连续形式；空格/Unicode 变体是 P3 残余建议）。
  { kind: 'api-key', re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9][A-Za-z0-9_-]{8,}/gi },
  { kind: 'api-key', re: /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_API_KEY|_APIKEY|_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD)\s*[=:]\s*\S+/g },
  // RE-S3.1: 小写/带前缀的赋值形态（大小写不敏感）：my_api_key: "…"、apiKey=…。
  {
    kind: 'api-key',
    re: new RegExp(
      String.raw`(?<![A-Za-z0-9])[A-Za-z0-9_]{0,32}`
      + String.raw`(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|app[_-]?key|token|secret|password|passwd|pwd|credential)`
      + String.raw`\s*[:=：,]\s*` + ASSIGN_VALUE,
      'gi',
    ),
  },
  // RE-S3.1: 多词标签（允许空格/下划线）：secret token: …、api key = …。
  {
    kind: 'token',
    re: new RegExp(
      String.raw`(?<![A-Za-z0-9])(?:api|access|secret|private|auth|refresh|session)[\s_-]+(?:key|token|secret|password)`
      + String.raw`\s*[:=：,]\s*` + ASSIGN_VALUE,
      'gi',
    ),
  },
  { kind: 'api-key', re: /(?<![A-Za-z0-9_])(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|app[_-]?key)\s*[=:]\s*['"]?[A-Za-z0-9._\-/+]{8,}/gi },
  { kind: 'token', re: /(?<![A-Za-z0-9_])(?:token|auth|access[_-]?token|refresh[_-]?token|session[_-]?token)\s*[=:]\s*['"]?[A-Za-z0-9._\-/+]{8,}/gi },
  { kind: 'password', re: /(?<![A-Za-z0-9_])(?:password|passwd|pwd)\s*[=:]\s*['"]?[A-Za-z0-9._\-/+!@#$%^&*]{6,}/gi },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  { kind: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: 'aws-key', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
];

function scanWith(patterns, text, spans) {
  for (const { kind, re } of patterns) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind });
      if (m.index === re.lastIndex) re.lastIndex += 1;
      m = re.exec(text);
    }
  }
}

/** 核心自带的保守扫描（不依赖任何外部文件）：PII + 凭证类，两类都算 local_only。 */
export function fallbackScan(text) {
  const s = String(text ?? '');
  const spans = [];
  scanWith(PII_PATTERNS, s, spans);
  scanWith(SECRET_PATTERNS, s, spans);
  spans.sort((a, b) => a.start - b.start);
  if (spans.length === 0) {
    return { verdict: 'none', spans: [], reasons: [], source: forcedFallback ? 'core-fallback:forced' : 'core-fallback' };
  }
  return {
    verdict: 'local_only',
    spans,
    reasons: [...new Set(spans.map((x) => x.kind))],
    source: forcedFallback ? 'core-fallback:forced' : 'core-fallback',
  };
}

/**
 * 注入前的隐私扫描（同步）。
 * - 核心兜底（含凭证类）先扫，命中直接 local_only；
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
  configured: gateConfigured,
  forcedFallback,
  scope: 'pii+secret',
});

/** 给 chooseRecall 用的一次性参数：`options: { ...privacyDefaults }`。 */
export const privacyDefaults = Object.freeze({ privacyScan });
