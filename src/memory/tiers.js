// src/memory/tiers.js — 03 热温冷分层（recall tier）纯规则层。
// 内容：TIERS / TIER_SCHEMA / DEFAULT_TIERING（默认值唯一来源）/ normalizeTiering
// （归一化）/ resolveTierPolicy（读取策略唯一判据）/ buildTierHint（收窄提示唯一实现）/
// isBusyError（BUSY 分类）；零 I/O、不 import fs、无网络。
// 设计：designs/03-tiers.v4.md §3 / §6 + 附录 C（v4）；测试：impl/03/tests/run.mjs。

export const TIERS = Object.freeze(['hot', 'warm', 'cold']);
export const TIER_SCHEMA = 'tiers/v1';
/** meta.tier_* 键名（tiers-clear / status / health 共用，§7.1）。 */
export const TIER_PASS_META_KEYS = Object.freeze([
  'tier_schema', 'tier_pass_at', 'tier_labels_source', 'tier_counts', 'tier_pass_ms',
]);
export const TIER_FILTERS = Object.freeze(['off', 'shadow', 'auto', 'time-fallback', 'hot', 'warm', 'cold', 'all']);
const FILTERING = new Set(['auto', 'time-fallback', 'hot', 'warm', 'cold']);
export const isFilteringTierFilter = (tierFilter) => FILTERING.has(String(tierFilter));

/** 唯一默认值来源：配置读不到 / 键缺失 / 非法值时都回落到这里。 */
export const DEFAULT_TIERING = Object.freeze({
  mode: 'shadow',
  hotSessions: 3,
  hotTurns: 40,
  hotCardDays: 7,
  hotCardMax: 20,
  warmDays: 30,
  hotDays: 3,
  maxStaleHours: 72,
  suppressedCap: 200,
});

export function normalizeTiering(raw = {}) {
  const out = { ...DEFAULT_TIERING };
  const src = raw && typeof raw === 'object' ? raw : {};
  const int = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, Math.trunc(n)));
  };
  out.hotSessions = int(src.hotSessions, 1, 20, DEFAULT_TIERING.hotSessions);
  out.hotTurns = int(src.hotTurns, 1, 500, DEFAULT_TIERING.hotTurns);
  out.hotCardDays = int(src.hotCardDays, 1, 365, DEFAULT_TIERING.hotCardDays);
  out.hotCardMax = int(src.hotCardMax, 1, 200, DEFAULT_TIERING.hotCardMax);
  out.warmDays = int(src.warmDays, 1, 3650, DEFAULT_TIERING.warmDays);
  out.hotDays = int(src.hotDays, 1, 30, DEFAULT_TIERING.hotDays);
  out.maxStaleHours = int(src.maxStaleHours, 1, 720, DEFAULT_TIERING.maxStaleHours);
  out.suppressedCap = int(src.suppressedCap, 1, 1000, DEFAULT_TIERING.suppressedCap);
  const mode = String(src.mode ?? '');
  out.mode = ['off', 'shadow', 'filter'].includes(mode) ? mode : DEFAULT_TIERING.mode;
  const kill = String(process.env.DSH_LONGLIVE_TIER_OFF ?? '');
  if (kill === '1' || kill === 'true') out.mode = 'off';
  return out;
}

// ---- 附录 C（v4 逐字转写） ----
export function isBusyError(error) {
  const code = Number(error?.errcode ?? NaN);
  if (code === 5 || code === 6) return true;
  const text = String(error?.errstr ?? error?.message ?? '');
  return /database (?:table )?is locked/i.test(text);
}

export function resolveTierPolicy({
  mode = DEFAULT_TIERING.mode,
  requested = 'auto',
  hasTierColumn = false,
  passAtMs = null,
  labelsSource = null,
  maxStaleHours = DEFAULT_TIERING.maxStaleHours,
  nowMs = Date.now(),
  hasReader = false,
} = {}) {
  // MINOR-1：null/undefined = "没传" = auto；其余非白名单 = E_TIER_ARG
  const tier = requested === null || requested === undefined ? 'auto' : String(requested);
  if (!['auto', 'hot', 'warm', 'cold', 'all'].includes(tier)) {
    return { error: 'E_TIER_ARG', code: 'E_TIER_ARG', requested: String(requested) };
  }

  // ★ M6：这三块与 mode 无关，所有分支都带出去
  const passAtValid = Number.isFinite(passAtMs) && passAtMs > 0;
  const stale = !passAtValid || (nowMs - passAtMs) > maxStaleHours * 3600000;
  const labelsUsable = Boolean(hasTierColumn) && passAtValid && !stale && labelsSource === 'pass';
  const base = {
    hasTierColumn, passAtValid, stale, labelsUsable,
    labelsSource: labelsSource ?? null,
    reason: null,
  };
  const reasonOf = () => (!hasTierColumn ? 'no-tier-column'
    : !passAtValid ? 'no-pass-meta'
      : labelsSource !== 'pass' ? 'backfill-labels'
        : 'stale');

  if (tier === 'all') {
    return { ...base, tierFilter: 'all', filtering: false, overlay: false, sqlKind: null, annotateOnly: hasTierColumn };
  }

  if (tier !== 'auto') {
    if (!hasTierColumn) {
      return { ...base, error: 'E_TIER_SCHEMA_MISSING', code: 'E_TIER_SCHEMA_MISSING', requested: tier };
    }
    return {
      ...base, tierFilter: tier, filtering: true, sqlKind: 'label-explicit',
      overlay: tier === 'hot', requested: tier, suppressedBasis: 'tier',
    };
  }

  if (mode === 'off') {
    return { ...base, tierFilter: 'off', filtering: false, overlay: false, sqlKind: null, annotateOnly: false };
  }

  // ★ H3：shadow 永不过滤
  if (mode === 'shadow') {
    return { ...base, tierFilter: 'shadow', filtering: false, overlay: false, sqlKind: null, annotateOnly: hasTierColumn };
  }

  if (labelsUsable) {
    return { ...base, tierFilter: 'auto', filtering: true, overlay: true, sqlKind: 'label', suppressedBasis: 'tier' };
  }

  return {
    ...base, reason: reasonOf(), tierFilter: 'time-fallback', filtering: true,
    overlay: hasReader, sqlKind: 'time', suppressedBasis: 'time-window',
  };
}

export function buildTierHint({
  tierFilter = 'off',
  coldSuppressed = 0,
  coldSuppressedCapped = false,
  suppressedBasis = null,
  hits = 0,
  warmDays = DEFAULT_TIERING.warmDays,
  queryDegraded = false,
  queryDegradedCode = null,
  suppressedCap = DEFAULT_TIERING.suppressedCap,
  baseHint = '',
} = {}) {
  const filtering = isFilteringTierFilter(tierFilter);
  const parts = [];
  if (queryDegraded) {
    parts.push(`索引查询期间有一路 FTS 策略失败（${queryDegradedCode ?? 'unknown'}），本次结果可能不完整；建议重试。`);
  }
  if (filtering && coldSuppressed === null) {                 // ★ MINOR-6：null 不是 0
    parts.push('索引降级：本次无法统计被挡条数——结果可能不全，别据此判断「没记过」。');
  }
  const n = filtering && typeof coldSuppressed === 'number' && Number.isFinite(coldSuppressed)
    ? Math.max(0, coldSuppressed) : 0;
  if (n > 0) {
    if (hits === 0) parts.push('默认可见集合里没有命中，但不是「没记过」：');
    if (suppressedBasis === 'time-window') {
      parts.push(`另有 ${n} 条命中在默认时间窗口（warmDays=${warmDays} 天）之外，默认不返回；要查请重试 tier:'all'。`);
    } else if (suppressedBasis === 'tier') {
      // MINOR-4（round4）：显式 hot/warm/cold 的被挡行 = "不属于该层"，可能包含 hot 行，
      // 不能一律归因成"冷层还有"（只有 auto 的 hidden 才是冷层）。§6.4 文字同步按此实现。
      if (tierFilter === 'hot' || tierFilter === 'warm' || tierFilter === 'cold') {
        parts.push(`该层之外还有 ${n} 条命中，默认不返回；要查请重试 tier:'all'。`);
      } else {
        parts.push(`冷层还有 ${n} 条命中，默认不返回；要查冷层请重试 tier:'all'。`);
      }
    } else {
      // MINOR-2（round1）：basis 未知也绝不静默——fail-closed 通用句（不猜 tier 还是时间窗口）。
      parts.push(`另有 ${n} 条命中被当前可见范围挡住，默认不返回；要查请重试 tier:'all'。`);
    }
    if (coldSuppressedCapped) parts.push(`（只统计到 ${suppressedCap} 条上限）`);
  }
  const text = [baseHint, ...parts].filter(Boolean).join(' ').trim();
  // ★ B1-③：不过滤态 fail-closed 自检
  if (!filtering && /冷层还有|默认时间窗口|不是「没记过」/.test(text)) return String(baseHint ?? '').trim();
  return text;
}
