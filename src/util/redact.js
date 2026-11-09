// src/util/redact.js — S1：凭据类敏感原文 scrub（answer-audit / D2 tool-output 写入前）。
//
// 口径（审计报告 P0-2）：
//   * 只处理"凭据类"模式（token / api key / password / Bearer / 私钥块 / cookie /
//     AWS / GCP / npm / GitHub / Slack / HuggingFace / JWT / 连接串口令）；
//   * 命中替换为 `[REDACTED:<type>]`，原文不落盘、不进日志；
//   * 保留可审计用途：原文 sha256 + 长度 + 命中类型（由调用方写进 metadata）；
//   * 纯函数、无 IO，前后端共用安全。

import crypto from 'node:crypto';

export const REDACT_SCHEMA = 'redact/v1';

/**
 * Pattern list. Order matters: the private-key block must run before the
 * generic `api_key: "..."` assignment so a PEM body cannot be partially
 * matched by an inner token pattern.
 */
export const REDACTION_PATTERNS = Object.freeze([
  {
    type: 'private-key-block',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  {
    type: 'openai-key',
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    type: 'anthropic-key',
    re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    type: 'github-token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    type: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    type: 'aws-access-key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    type: 'aws-secret-key',
    re: /\baws_?secret_?access_?key\b\s*[:=]\s*['"]?[A-Za-z0-9/+=]{32,}['"]?/gi,
  },
  {
    type: 'google-api-key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    type: 'npm-token',
    re: /\bnpm_[A-Za-z0-9]{30,}\b/g,
  },
  {
    type: 'huggingface-token',
    re: /\bhf_[A-Za-z0-9]{20,}\b/g,
  },
  {
    type: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    type: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  {
    type: 'basic-auth',
    re: /\bBasic\s+[A-Za-z0-9+/=]{16,}/g,
  },
  {
    type: 'password-assignment',
    re: /\b(?:password|passwd|pwd)\b\s*[:=]\s*(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{6,})/gi,
  },
  {
    type: 'api-key-assignment',
    re: /\b(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization[_-]?key)\b\s*[:=]\s*(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[A-Za-z0-9._~+/=-]{12,})/gi,
  },
  {
    type: 'cookie',
    re: /\b(?:cookie|set-cookie)\b\s*[:=]\s*[^\n;]{8,}/gi,
  },
  {
    type: 'url-credentials',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/]+:[^@\s/]+@[^\s]+/gi,
  },
]);

export const DEFAULT_REDACTION = Object.freeze({
  enabled: true,
  auditRetentionDays: 30,
  toolOutputRetentionDays: 90,
});

/** Stable sha256 of the exact text handed in (hex). */
export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function emptyHits() {
  const out = {};
  return out;
}

function addHit(hits, type) {
  hits[type] = (hits[type] ?? 0) + 1;
}

function hitsToArray(hits) {
  return Object.entries(hits)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * Scrub one string.
 *
 * @param {string} text
 * @param {{patterns?:Array, enabled?:boolean}} [options]
 * @returns {{text:string,hits:Array<{type:string,count:number}>,hitCount:number,
 *            originalSha256:string, originalLength:number, redactedLength:number,
 *            changed:boolean}}
 */
export function scrubText(text, options = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const enabled = options.enabled !== false;
  const patterns = Array.isArray(options.patterns) ? options.patterns : REDACTION_PATTERNS;
  const originalSha256 = sha256Hex(source);
  if (!enabled || source === '') {
    return { text: source, hits: [], hitCount: 0, originalSha256, originalLength: source.length, redactedLength: source.length, changed: false };
  }
  const hits = emptyHits();
  let output = source;
  for (const pattern of patterns) {
    if (!pattern || !(pattern.re instanceof RegExp)) continue;
    pattern.re.lastIndex = 0;
    output = output.replace(pattern.re, () => {
      addHit(hits, pattern.type);
      return `[REDACTED:${pattern.type}]`;
    });
  }
  const list = hitsToArray(hits);
  return {
    text: output,
    hits: list,
    hitCount: list.reduce((sum, entry) => sum + entry.count, 0),
    originalSha256,
    originalLength: source.length,
    redactedLength: output.length,
    changed: output !== source,
  };
}

/**
 * Deep-scrub every string value inside a JSON-serializable value (keys kept).
 * Returns a structurally-cloned value plus aggregate hits and the sha256 of the
 * original serialized tree (for audit correlation).
 */
export function scrubJsonValue(value, options = {}) {
  const enabled = options.enabled !== false;
  const hits = emptyHits();
  let hitCount = 0;
  let originalSerialized = '';
  try {
    originalSerialized = JSON.stringify(value);
  } catch {
    originalSerialized = String(value);
  }
  const originalSha256 = sha256Hex(originalSerialized);
  const originalLength = originalSerialized.length;

  const walk = (input, depth) => {
    if (depth > 32) return input;
    if (typeof input === 'string') {
      const result = scrubText(input, options);
      for (const hit of result.hits) { hits[hit.type] = (hits[hit.type] ?? 0) + hit.count; }
      hitCount += result.hitCount;
      return result.text;
    }
    if (Array.isArray(input)) return input.map((entry) => walk(entry, depth + 1));
    if (input && typeof input === 'object') {
      const out = {};
      for (const [key, entry] of Object.entries(input)) out[key] = walk(entry, depth + 1);
      return out;
    }
    return input;
  };

  const scrubbed = enabled ? walk(value, 0) : value;
  const list = hitsToArray(hits);
  let redactedSerialized = '';
  try {
    redactedSerialized = JSON.stringify(scrubbed);
  } catch {
    redactedSerialized = '';
  }
  return {
    value: scrubbed,
    enabled,
    changed: hitCount > 0,
    hits: list,
    hitCount,
    originalSha256,
    originalLength,
    redactedLength: redactedSerialized.length,
  };
}

/** Redaction metadata block to persist in audit rows / sidecar files. */
export function redactionMetadata(result, { retentionDays = null, at = null } = {}) {
  const meta = {
    schema: REDACT_SCHEMA,
    applied: result?.enabled !== false && (result?.hitCount ?? 0) > 0,
    hits: Array.isArray(result?.hits) ? result.hits : [],
    hitCount: Number.isInteger(result?.hitCount) ? result.hitCount : 0,
    originalSha256: typeof result?.originalSha256 === 'string' ? result.originalSha256 : null,
    originalLength: Number.isInteger(result?.originalLength) ? result.originalLength : null,
    redactedLength: Number.isInteger(result?.redactedLength) ? result.redactedLength : null,
  };
  if (Number.isInteger(retentionDays) && retentionDays > 0) {
    meta.retentionDays = retentionDays;
    const base = at ? Date.parse(at) : Date.now();
    if (Number.isFinite(base)) meta.retainUntil = new Date(base + retentionDays * 24 * 60 * 60 * 1000).toISOString();
  }
  return meta;
}
