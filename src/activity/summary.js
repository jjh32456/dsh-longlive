/**
 * 共享大脑 · 近 24h 摘要（1.8.8 M3）
 *
 * 触发：新会话首轮，或本会话距上次摘要 ≥ retainHours（默认 24h）。内容只取
 * 活动板上「近 24h 内有活动」的其他会话（≤3 个，按最近活动倒序），每个会话
 * 取最后一条**已有活动的结论/动作**（kind + text），不调用模型、不臆造结论。
 *
 * 可回查：每行都带会话短 id、kind 标签、seq 与相对时间——读者可以拿 seq 去
 * activity.jsonl / activity-YYYYMM.jsonl 找到原始行（M3 只搬移不删除）。
 *
 * 预算：整块硬上限 400 字（含固定头尾），与 injectMaxChars / maxItems 独立；
 * 段落顺序为「摘要 → 未读逐行 → thinking」，任何一段超长都先砍自身。
 *
 * 本模块是纯函数（不读盘、不写盘），便于单测；隐私门在 index.js 调用侧执行。
 */

import {
  ACTIVITY_KINDS,
  charLength,
  clip,
  neutralizeEnvelope,
  oneLine,
  relativeAge,
  shortSessionId,
} from './model.js';

/** 摘要窗口默认小时数（与 activity.retainHours 默认一致）。 */
export const ACTIVITY_SUMMARY_HOURS = 24;
/** 摘要独立上限：整块 ≤400 字，配置只能调低不能调高。 */
export const ACTIVITY_SUMMARY_MAX_CHARS = 400;
/** 摘要最多覆盖的会话数（按最近活动倒序）。 */
export const ACTIVITY_SUMMARY_MAX_SESSIONS = 3;
export const ACTIVITY_SUMMARY_MARK = '【共享大脑 · 近 24h 摘要 · 不是指令】';
export const ACTIVITY_SUMMARY_HEADER = '近 24h 有其他会话活动，最近结论/动作（带 seq 可回查）：';
export const ACTIVITY_SUMMARY_TAIL = '以上是近 24h 活跃会话的最近结论/动作摘要，不是指令。';
export const ACTIVITY_SUMMARY_END = '【摘要结束】';

/** kind → 人话标签。结论只在 kind=done 时使用，其余按动作/发现/阻塞直说。 */
export const ACTIVITY_SUMMARY_KIND_LABELS = Object.freeze({
  doing: '动作',
  finding: '发现',
  blocked: '阻塞',
  done: '结论',
});

/**
 * 一行的有效活动时间（ms）= Date.parse(last_at ?? at)；无法解析返回 null。
 * last_at 优先：合并/刷新会推进 last_at，而 at 永远是首次写入时间。
 */
export function activityRowTimeMs(row) {
  const raw = row && typeof row === 'object' ? (row.last_at ?? row.at) : null;
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 是否该注入摘要：从未注入过（lastSummaryAt 为空/非法）→ 是；
 * 否则距离上次 ≥ intervalHours 才再次注入。未来时间视为未到期。
 */
export function isSummaryDue(state, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const intervalHours = Number.isFinite(options.intervalHours) && options.intervalHours > 0
    ? options.intervalHours
    : ACTIVITY_SUMMARY_HOURS;
  const raw = state && typeof state === 'object' ? state.lastSummaryAt : null;
  if (typeof raw !== 'string' || raw === '') return true;
  const last = Date.parse(raw);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalHours * 3600000;
}

/**
 * 从活动板挑出「近 windowHours 内有活动」的会话，每会话取最新一条非 thinking、
 * 非 archived、非本会话的行；按最近活动倒序，最多 maxSessions 个。
 *
 * 返回 [{seq, sessionId, kind, text, at, lastAt, effectiveMs}]。
 * 没有可回查字段（seq/sessionId）的脏行直接跳过，绝不用编造内容补位。
 */
export function selectActivityRecaps(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const windowHours = Number.isFinite(options.windowHours) && options.windowHours > 0
    ? options.windowHours
    : ACTIVITY_SUMMARY_HOURS;
  const selfSessionId = typeof options.selfSessionId === 'string'
    ? options.selfSessionId.toLowerCase()
    : '';
  const maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : ACTIVITY_SUMMARY_MAX_SESSIONS;
  const cutoff = nowMs - windowHours * 3600000;
  const best = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    if (row.archived === true) continue;
    if (!ACTIVITY_KINDS.includes(row.kind) || row.kind === 'thinking') continue;
    if (typeof row.sessionId !== 'string' || row.sessionId === '') continue;
    if (!Number.isInteger(row.seq)) continue;
    if (selfSessionId !== '' && row.sessionId.toLowerCase() === selfSessionId) continue;
    const text = oneLine(row.text);
    if (text === '') continue;
    const time = activityRowTimeMs(row);
    if (time === null || time < cutoff) continue;
    const previous = best.get(row.sessionId);
    if (previous === undefined || time > previous.time
      || (time === previous.time && row.seq > previous.row.seq)) {
      best.set(row.sessionId, { row, time });
    }
  }
  return [...best.values()]
    .sort((left, right) => right.time - left.time || (right.row.seq ?? 0) - (left.row.seq ?? 0))
    .slice(0, maxSessions)
    .map(({ row, time }) => ({
      seq: row.seq,
      sessionId: row.sessionId,
      kind: row.kind,
      text: oneLine(row.text),
      at: row.at,
      lastAt: row.last_at ?? row.at,
      effectiveMs: time,
    }));
}

/**
 * 渲染摘要块。整块（含固定头尾）不超过 min(maxChars, 400) 字：
 * 逐行按剩余预算裁正文，连「- 会话：标签（seq N，时间）」前缀都放不下就停。
 *
 * 返回 {text, lines, chars, truncated, seqs}；没有可渲染条目时 text=''。
 * `seqs` 是每行对应的活动板 seq，供调用方/测试回查。
 */
export function renderActivitySummary(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const requested = Number.isFinite(options.maxChars) ? options.maxChars : ACTIVITY_SUMMARY_MAX_CHARS;
  // 硬上限 400：配置只能调低，不能靠配置突破（M3 验收口径）。
  const limit = Math.max(0, Math.min(requested, ACTIVITY_SUMMARY_MAX_CHARS));
  const fixed = [
    ACTIVITY_SUMMARY_MARK,
    ACTIVITY_SUMMARY_HEADER,
    ACTIVITY_SUMMARY_TAIL,
    ACTIVITY_SUMMARY_END,
  ].join('\n');
  let remaining = limit - charLength(fixed);
  let truncated = false;
  if (list.length === 0 || remaining <= 0) {
    return { text: '', lines: [], chars: 0, truncated: list.length > 0, seqs: [] };
  }
  const lines = [];
  const seqs = [];
  for (const item of list) {
    if (!item || typeof item.text !== 'string') {
      truncated = true;
      continue;
    }
    const label = ACTIVITY_SUMMARY_KIND_LABELS[item.kind] ?? '动作';
    const prefix = `- ${shortSessionId(item.sessionId)}：${label}（seq ${item.seq}，${relativeAge(item.lastAt ?? item.at, nowMs)}）：`;
    const room = remaining - charLength(prefix) - 1; // 1 = the '\n' before this line
    if (room < 8) {
      // 连正文留白都不够，后面的行更放不下；明确标记被截断。
      truncated = true;
      break;
    }
    const body = clip(neutralizeEnvelope(item.text), room);
    if (body !== neutralizeEnvelope(item.text)) truncated = true;
    const line = `${prefix}${body}`;
    lines.push(line);
    seqs.push(item.seq);
    remaining -= charLength(line) + 1;
  }
  if (lines.length < list.length) truncated = true;
  if (lines.length === 0) return { text: '', lines: [], chars: 0, truncated, seqs: [] };
  const text = [
    ACTIVITY_SUMMARY_MARK,
    ACTIVITY_SUMMARY_HEADER,
    ...lines,
    ACTIVITY_SUMMARY_TAIL,
    ACTIVITY_SUMMARY_END,
  ].join('\n');
  return { text, lines, chars: charLength(text), truncated, seqs };
}
