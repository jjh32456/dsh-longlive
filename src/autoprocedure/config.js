// src/autoprocedure/config.js — autoProcedure 配置归一化（v0.3 §3.10）。
//
// 默认关闭：`enabled:false` 时调用方必须在 register 之前返回，不注册 hook、
// 不建目录、不读任何文件（除宿主已加载的配置）。归一化本身是纯函数，没有任何
// IO；非法值回落到默认值并给出 warning，绝不让宿主加载失败。
//
// 键与默认值严格按 PLAN-v0.3 §3.10：
//   autoProcedure: { enabled:false, delayMs:600000, idleMs:60000, minToolCalls:8,
//                    perSessionCandidates:1, dailyCandidates:3, retentionDays:30,
//                    llm: { enabled:false, dailyTokenBudget:30000,
//                           perCallTokenCap:15000, dailyLlmCalls:2 } }
//
// 1.8.6 增量（DECISIONS-1.8.6-IMPL D7 / MAJ-2）：`maxDecompressBytes` 用户可配，
// 让解压后文本 > 8 MiB 的长会话不必恒 reject too_big。默认仍是 8 MiB；
// 有 64 MiB 硬上限保护（超过按 hard cap 截断并给 warning）。

export const AUTOPROCEDURE_CONFIG_SCHEMA = 'autoprocedure-config/v1';

export const AUTOPROCEDURE_DEFAULTS = Object.freeze({
  enabled: false,
  delayMs: 600000,
  idleMs: 60000,
  minToolCalls: 8,
  perSessionCandidates: 1,
  dailyCandidates: 3,
  retentionDays: 30,
  maxDecompressBytes: 8 * 1024 * 1024,
  llm: Object.freeze({
    enabled: false,
    dailyTokenBudget: 30000,
    perCallTokenCap: 15000,
    dailyLlmCalls: 2,
  }),
});

/** F3：解压后会话文本上限（字节）。超过即 reject reason=too_big。 */
export const AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
/** D7：配置硬上限，防止一次配置错误把内存打爆。 */
export const AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_HARD_CAP = 64 * 1024 * 1024;
/** D7：配置下限，低于它没有实际采样意义。 */
export const AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_MIN = 64 * 1024;

/** F1：自动流程锁参数（TTL 60s，失败重试 3×500ms，超时放弃并计数）。 */
export const AUTOPROCEDURE_LOCK_TTL_MS = 60_000;
export const AUTOPROCEDURE_LOCK_RETRIES = 3;
export const AUTOPROCEDURE_LOCK_RETRY_DELAY_MS = 500;

/** 本模块自己的本地日/时钟口径由调用方注入，这里只声明窗口常量。 */
export const AUTOPROCEDURE_STALLED_DAYS = 7;
export const AUTOPROCEDURE_REPEAT_REJECT_DAYS = 3;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, fallback, min, max, key, warnings) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    warnings.push({
      code: 'E_AP_CONFIG',
      key,
      message: `${key} 必须是 ${min}..${max} 的整数 — 收到 ${JSON.stringify(value)}，已回落默认值 ${fallback}`,
    });
    return fallback;
  }
  return number;
}

function clampBytes(value, fallback, key, warnings) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_MIN) {
    warnings.push({
      code: 'E_AP_CONFIG',
      key,
      message: `${key} 必须是 ${AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_MIN}..${AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_HARD_CAP} 的整数字节数 — 收到 ${JSON.stringify(value)}，已回落默认值 ${fallback}`,
    });
    return fallback;
  }
  if (number > AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_HARD_CAP) {
    warnings.push({
      code: 'E_AP_CONFIG',
      key,
      message: `${key} 超过硬上限 ${AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_HARD_CAP}，已按硬上限截断`,
    });
    return AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES_HARD_CAP;
  }
  return number;
}

/**
 * Normalise the `autoProcedure` block. Pure: no IO, no host access.
 *
 * @param {object} raw  raw config row (`config.autoProcedure`)
 * @returns {{config: object, warnings: Array<{code:string,key:string,message:string}>}}
 */
export function normalizeAutoProcedureConfig(raw) {
  const warnings = [];
  const source = isPlainObject(raw) ? raw : {};
  const llmSource = isPlainObject(source.llm) ? source.llm : {};
  const defaults = AUTOPROCEDURE_DEFAULTS;

  const config = {
    enabled: source.enabled === true,
    delayMs: clampInt(source.delayMs, defaults.delayMs, 0, 86_400_000, 'autoProcedure.delayMs', warnings),
    idleMs: clampInt(source.idleMs, defaults.idleMs, 0, 86_400_000, 'autoProcedure.idleMs', warnings),
    minToolCalls: clampInt(source.minToolCalls, defaults.minToolCalls, 0, 1000, 'autoProcedure.minToolCalls', warnings),
    perSessionCandidates: clampInt(source.perSessionCandidates, defaults.perSessionCandidates, 1, 100, 'autoProcedure.perSessionCandidates', warnings),
    dailyCandidates: clampInt(source.dailyCandidates, defaults.dailyCandidates, 1, 100, 'autoProcedure.dailyCandidates', warnings),
    retentionDays: clampInt(source.retentionDays, defaults.retentionDays, 1, 3650, 'autoProcedure.retentionDays', warnings),
    maxDecompressBytes: clampBytes(source.maxDecompressBytes, defaults.maxDecompressBytes, 'autoProcedure.maxDecompressBytes', warnings),
    llm: {
      // B 模式必须显式 llm.enabled:true；缺省或任何非 true 值都等于关闭。
      enabled: llmSource.enabled === true,
      dailyTokenBudget: clampInt(llmSource.dailyTokenBudget, defaults.llm.dailyTokenBudget, 0, 10_000_000, 'autoProcedure.llm.dailyTokenBudget', warnings),
      perCallTokenCap: clampInt(llmSource.perCallTokenCap, defaults.llm.perCallTokenCap, 0, 10_000_000, 'autoProcedure.llm.perCallTokenCap', warnings),
      dailyLlmCalls: clampInt(llmSource.dailyLlmCalls, defaults.llm.dailyLlmCalls, 0, 100, 'autoProcedure.llm.dailyLlmCalls', warnings),
    },
  };
  return { config, warnings };
}
