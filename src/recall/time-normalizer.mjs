// src/recall/time-normalizer.mjs — B2：时间归一化（相对/绝对 → 事件时间区间）
//
// 纪律：只用**注入的事件时间**（now），本文件不读系统时钟；无法解析返回 null，
// 绝不猜一个日期。用于召回排序的时间亲和与 memory_recall_v2 的时间过滤。

export const TIME_SCHEMA = 'time-normalizer/v1';
export const DEFAULT_TZ_OFFSET_MINUTES = 8 * 60; // Asia/Shanghai (no DST)
const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function tzOffset(options) {
  return Number.isInteger(options?.tzOffsetMinutes) ? options.tzOffsetMinutes : DEFAULT_TZ_OFFSET_MINUTES;
}

/** Day start (local offset) for a wall-clock instant. */
export function dayStartMs(ms, options = {}) {
  const offset = tzOffset(options) * 60 * 1000;
  return Math.floor((ms + offset) / DAY_MS) * DAY_MS - offset;
}

function dayRange(ms, options = {}) {
  const start = dayStartMs(ms, options);
  return { startMs: start, endMs: start + DAY_MS - 1 };
}

function localParts(ms, options = {}) {
  const offset = tzOffset(options) * 60 * 1000;
  const shifted = new Date(ms + offset);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(), // 0=Sunday
  };
}

function localMs(year, month, day, hour = 0, minute = 0, options = {}) {
  const offset = tzOffset(options) * 60 * 1000;
  return Date.UTC(year, month - 1, day, hour, minute) - offset;
}

function periodRange(ms, { unit, delta }, options = {}) {
  const p = localParts(ms, options);
  if (unit === 'day') {
    const start = localMs(p.year, p.month, p.day, 0, 0, options) + delta * DAY_MS;
    return { startMs: start, endMs: start + DAY_MS - 1 };
  }
  if (unit === 'week') {
    // Monday-based week
    const mondayOffset = (p.weekday + 6) % 7;
    const start = localMs(p.year, p.month, p.day, 0, 0, options) - mondayOffset * DAY_MS + delta * 7 * DAY_MS;
    return { startMs: start, endMs: start + 7 * DAY_MS - 1 };
  }
  if (unit === 'month') {
    const start = localMs(p.year, p.month + delta, 1, 0, 0, options);
    const end = localMs(p.year, p.month + delta + 1, 1, 0, 0, options) - 1;
    return { startMs: start, endMs: end };
  }
  if (unit === 'year') {
    const start = localMs(p.year + delta, 1, 1, 0, 0, options);
    const end = localMs(p.year + delta + 1, 1, 1, 0, 0, options) - 1;
    return { startMs: start, endMs: end };
  }
  return null;
}

function result(kind, startMs, endMs, raw, extra = {}) {
  return { schema: TIME_SCHEMA, kind, raw, startMs, endMs, ...extra };
}

/**
 * Normalize ONE time expression. `now` is required for relative expressions.
 * @returns {null|{schema,kind,raw,startMs,endMs}}
 */
export function normalizeTimeExpr(expr, { now = null, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES } = {}) {
  const raw = String(expr ?? '').trim();
  if (raw === '') return null;
  const options = { tzOffsetMinutes };
  const nowMs = toMs(now);
  // absolute YYYY-MM-DD / YYYY/MM/DD
  let m = raw.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/u);
  if (m) {
    const range = dayRange(localMs(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, options), options);
    return result('day', range.startMs, range.endMs, raw, { date: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` });
  }
  // YYYY-MM（月份）
  m = raw.match(/(\d{4})[-/年](\d{1,2})月?/u);
  if (m && !/(\d{1,2}):/u.test(raw)) {
    const start = localMs(Number(m[1]), Number(m[2]), 1, 0, 0, options);
    const end = localMs(Number(m[1]), Number(m[2]) + 1, 1, 0, 0, options) - 1;
    return result('month', start, end, raw);
  }
  // 今天/昨天/前天/明天/后天
  const relativeDays = { 今天: 0, 今日: 0, 昨天: -1, 昨日: -1, 前天: -2, 明天: 1, 后天: 2 };
  for (const [word, delta] of Object.entries(relativeDays)) {
    if (raw.includes(word)) {
      if (nowMs === null) return null;
      const range = periodRange(nowMs, { unit: 'day', delta }, options);
      return result('day', range.startMs, range.endMs, raw);
    }
  }
  // N 天前 / N 天后 / N 周前 / N 个月前
  m = raw.match(/(\d+)\s*(天|日|周|个?月|年)\s*(前|后)/u);
  if (m) {
    if (nowMs === null) return null;
    const n = Number(m[1]) * (m[3] === '前' ? -1 : 1);
    const unitMap = { 天: 'day', 日: 'day', 周: 'week', 月: 'month', 个月: 'month', 年: 'year' };
    const unit = unitMap[m[2].replace(/^个/u, '') === '月' ? '月' : m[2]];
    if (unit === 'day' && '天日'.includes(m[2])) {
      const start = dayStartMs(nowMs, options) + n * DAY_MS;
      return result('day', start, start + DAY_MS - 1, raw);
    }
    const range = periodRange(nowMs, { unit, delta: n }, options);
    if (range) return result(unit, range.startMs, range.endMs, raw);
    return null;
  }
  // 本周/这周/上周/下周
  const weekMap = { 本周: 0, 这周: 0, 上周: -1, 下周: 1 };
  for (const [word, delta] of Object.entries(weekMap)) {
    if (raw.includes(word)) {
      if (nowMs === null) return null;
      const range = periodRange(nowMs, { unit: 'week', delta }, options);
      return range ? result('week', range.startMs, range.endMs, raw) : null;
    }
  }
  // 上午/下午/晚上 + H 点（只给 day range + 时段边界）
  m = raw.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[点:：时]/u);
  if (m) {
    if (nowMs === null) return null;
    const hour = Number(m[2]);
    const bucket = m[1] ?? '';
    const normalizedHour = bucket === '下午' || bucket === '傍晚' || bucket === '晚上' ? (hour < 12 ? hour + 12 : hour) : hour;
    const p = localParts(nowMs, options);
    const start = localMs(p.year, p.month, p.day, Math.min(23, normalizedHour), 0, options);
    return result('instant', start, start + 60 * 60 * 1000 - 1, raw, { hour: normalizedHour });
  }
  // 刚才/刚刚/最近 → 最近 10 分钟（相对事件时间）
  if (/刚才|刚刚/u.test(raw)) {
    if (nowMs === null) return null;
    return result('instant', nowMs - 10 * 60 * 1000, nowMs, raw);
  }
  return null;
}

/** Extract non-overlapping time refs from free text (longest match first). */
export function extractTimeRefs(text, options = {}) {
  const value = typeof text === 'string' ? text : '';
  if (value.trim() === '') return [];
  const patterns = [
    /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/gu,
    /\d{4}[-/年]\d{1,2}月?/gu,
    /今天|今日|昨天|昨日|前天|明天|后天/gu,
    /\d+\s*(?:天|日|周|个?月|年)\s*(?:前|后)/gu,
    /本周|这周|上周|下周/gu,
    /(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*[点:：时]/gu,
    /刚才|刚刚/gu,
  ];
  const hits = [];
  for (const re of patterns) {
    for (const match of value.matchAll(re)) {
      const raw = match[0];
      const expr = normalizeTimeExpr(raw, options);
      if (!expr) continue;
      hits.push({ ...expr, index: match.index, length: raw.length });
    }
  }
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const out = [];
  let lastEnd = -1;
  for (const hit of hits) {
    if (hit.index < lastEnd) continue;
    out.push(hit);
    lastEnd = hit.index + hit.length;
  }
  return out;
}

/** Card date (YYYY-MM-DD / ISO / lastUsed) affinity against normalized refs. */
export function cardTimeAffinity(card, refs) {
  if (!card || !Array.isArray(refs) || refs.length === 0) return 0;
  const raw = card.date ?? card.createdAt ?? card.lastUsed ?? null;
  const ms = toMs(raw);
  if (ms === null) return 0;
  return refs.some((ref) => ms >= ref.startMs && ms <= ref.endMs) ? 1 : 0;
}
