// src/recall/shared-visibility.js — M2-C R1–R6：双我可见的共享可见块
//
// 新会话首轮 agent/pre-step 注入一块 ≤300 字的「共享可见块」（session-reference
// 隐藏消息），让当前会话看到**其它活体会话**的目标 / 末活动 / 最后真实用户消息 /
// 最后记忆写入 / 陈旧标记，无需读原始日志（R1：≤2s；R3：不拿心跳冒充实时）。
//
// 数据源：
//   - 活体表：liveList（与面板 #23 frames 同口径，src/live.js）
//   - 记忆写入：resolveMemoryWriteAt（与 memory-gap 同源，src/lifecycle/gap-clocks.js）
//   - 最后真实用户消息：事件索引（.longlive/index/events.db，kind=user），
//     无索引时退回 live 行扩展字段；两者都没有 => 不猜（lastUserMessage=null）
//
// 纪律：只读；失败静默（不阻断 turn）；隐私门命中整行丢弃；≤300 字；只首轮注入。

import { liveList } from '../live.js';
import { resolveMemoryWriteAt } from '../lifecycle/gap-clocks.js';

export const SHARED_VISIBILITY_SCHEMA = 'shared-visibility/v1';
export const SHARED_BLOCK_MAX_CHARS = 300;
export const GOAL_STALE_MS = 5 * 60 * 1000;
export const SESSION_STALE_MS = 30 * 60 * 1000;
export const ACK_WORDS = Object.freeze(['对', '好', '嗯', '收到', '可以', '是的', '行', '不错', '好的', '知道了', 'ok', 'OK']);
const ACK_RE = new RegExp(`^(?:${ACK_WORDS.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[。.!！?？~～ ]*$`, 'u');

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampText(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 「无信息量」判定：长度 <6 或命中 ack 词表（「对的」不是最后意图）。 */
export function isInformativeUserText(text) {
  const value = String(text ?? '').trim();
  if (value === '') return false;
  if ([...value].length < 6) return false;
  return !ACK_RE.test(value);
}

function isoWithOffset(ms, offsetMinutes = 480) {
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}.${pad(shifted.getUTCMilliseconds(), 3)}+08:00`;
}

function clockText(ms, offsetMinutes = 480) {
  if (!Number.isFinite(ms)) return '';
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function pickLastUserMessage(sessionId, lastUserMessages) {
  const entry = lastUserMessages?.[sessionId] ?? null;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.text !== 'string' || entry.text.trim() === '') return null;
  const text = clampText(entry.text, 80);
  const prev = Array.isArray(entry.prev)
    ? entry.prev.filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '').slice(0, 2).map((item) => ({ text: clampText(item.text, 60), at: item.at ?? null }))
    : [];
  return { text, at: entry.at ?? null, informative: isInformativeUserText(text), prev };
}

/**
 * Pure core: build the shared-visibility rows from live entries + injected data.
 * @returns {{schema,sessions:object[],injectedAt:string,count:number}|null}
 */
export function buildSharedVisibility({
  entries = [],
  currentSessionId = null,
  now = Date.now(),
  memoryWrite = null,
  lastUserMessages = {},
  projectOf = null,
  maxSessions = 2,
} = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const sessions = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.sessionId === currentSessionId) continue;
    if (entry.effectiveState === 'dead' || entry.effectiveState === 'corrupt') continue;
    const updatedMs = toMs(entry.updatedAt);
    const goalAtMs = toMs(entry.goalUpdatedAt) ?? updatedMs;
    const goalText = clampText(entry.goal, 80);
    const action = entry.last_action && typeof entry.last_action === 'object' ? entry.last_action : null;
    const actionAtMs = toMs(action?.at);
    const attribution = {
      present: entry.sessionId != null,
      // 归属校验 = 行里同时有 host+pid 证据；不拿心跳冒充实时（R3）。
      verified: typeof entry.host === 'string' && entry.host.trim() !== '' && Number.isInteger(entry.pid),
    };
    sessions.push({
      project: typeof projectOf === 'function' ? (projectOf(entry) ?? null) : (entry.project ?? null),
      sessionId: entry.sessionId,
      attribution,
      goal: goalText === '' ? null : {
        text: goalText,
        ageMs: Number.isFinite(goalAtMs) ? Math.max(0, nowMs - goalAtMs) : null,
        stale: !Number.isFinite(goalAtMs) || nowMs - goalAtMs > GOAL_STALE_MS,
      },
      lastAction: action === null ? null : {
        kind: clampText(action.kind ?? action.type ?? 'action', 24),
        detail: clampText(action.detail ?? action.summary ?? '', 120),
        at: isoWithOffset(actionAtMs),
        ageMs: Number.isFinite(actionAtMs) ? Math.max(0, nowMs - actionAtMs) : null,
        stale: !Number.isFinite(actionAtMs) || nowMs - actionAtMs > GOAL_STALE_MS,
      },
      lastUserMessage: pickLastUserMessage(entry.sessionId, lastUserMessages),
      lastMemoryWrite: memoryWrite && Number.isFinite(toMs(memoryWrite.atMs))
        ? {
          at: isoWithOffset(toMs(memoryWrite.atMs)),
          sourceFile: memoryWrite.rel ?? memoryWrite.sourceFile ?? null,
          gapSec: Number.isFinite(memoryWrite.gapSec) ? memoryWrite.gapSec : (Number.isFinite(toMs(memoryWrite.atMs)) ? Math.max(0, Math.floor((nowMs - toMs(memoryWrite.atMs)) / 1000)) : null),
        }
        : null,
      injectedAt: isoWithOffset(nowMs),
      stale: !Number.isFinite(updatedMs) || nowMs - updatedMs > SESSION_STALE_MS,
      effectiveState: entry.effectiveState ?? entry.state ?? null,
    });
    if (sessions.length >= Math.max(1, Number(maxSessions) || 2)) break;
  }
  if (sessions.length === 0) return null;
  return { schema: SHARED_VISIBILITY_SCHEMA, sessions, injectedAt: isoWithOffset(nowMs), count: sessions.length };
}

/** Render the ≤300-char hidden block. Privacy hits drop the whole line (never the turn). */
export function renderSharedVisibilityBlock(visibility, { maxChars = SHARED_BLOCK_MAX_CHARS, privacyScan = null } = {}) {
  if (!visibility || !Array.isArray(visibility.sessions) || visibility.sessions.length === 0) return '';
  const scan = typeof privacyScan === 'function' ? privacyScan : null;
  const safe = (text) => {
    if (typeof text !== 'string' || text === '') return '';
    if (scan !== null) {
      try {
        if (scan(text)?.verdict === 'local_only') return '';
      } catch { return ''; }
    }
    return text;
  };
  const lines = [`【共享可见 · 只读】现在 ${visibility.count} 个思维活着。`];
  let memoryWriteLine = '';
  for (const session of visibility.sessions) {
    const shortId = session.sessionId ? session.sessionId.slice(0, 18) : 'unknown';
    const project = session.project ? `（${session.project}）` : '';
    const goal = session.goal
      ? `目标：${safe(session.goal.text)}${session.goal.stale ? `（${ageText(session.goal.ageMs)}·陈旧）` : ''}`
      : '';
    const action = session.lastAction
      ? `末活动：${safe(session.lastAction.kind)}/${safe(session.lastAction.detail)}${Number.isFinite(session.lastAction.ageMs) ? `（${ageText(session.lastAction.ageMs)}）` : ''}`
      : '';
    const user = session.lastUserMessage
      ? `最后用户消息：「${safe(session.lastUserMessage.text)}」${session.lastUserMessage.informative ? '' : '（无信息量）'}${session.lastUserMessage.prev.length > 0 ? `；前一条：「${safe(session.lastUserMessage.prev[0].text)}」` : ''}`
      : '';
    const row = [shortId + project, goal, action, user].filter(Boolean).join('｜');
    if (row !== '') lines.push(`· ${row}`);
    if (session.lastMemoryWrite && session.lastMemoryWrite.sourceFile) {
      memoryWriteLine = `· 最后记忆写入 ${clockText(toMs(session.lastMemoryWrite.at))} · 来源 ${safe(String(session.lastMemoryWrite.sourceFile))}`;
    }
    if (session.stale && session.lastAction === null) lines.push('· （该会话已 >30 分钟无心跳，按陈旧处理）');
  }
  if (memoryWriteLine !== '') lines.push(memoryWriteLine);
  let text = lines.join('\n');
  if (text.length > maxChars && memoryWriteLine !== '') {
    // R1: the memory-write line is contract data (golden) — keep it even when
    // trimming the rest of the block to the ≤300-char budget.
    const header = lines[0];
    const bodyLines = lines.slice(1).filter((line) => line !== memoryWriteLine);
    let budget = maxChars - header.length - memoryWriteLine.length - 2;
    if (budget < 0) {
      text = `${header}\n${memoryWriteLine}`.slice(0, Math.max(0, maxChars - 1)) + '…';
      return text;
    }
    const kept = [];
    for (const line of bodyLines) {
      if (line.length <= budget) {
        kept.push(line);
        budget -= line.length + 1;
      } else {
        break;
      }
    }
    text = [header, ...kept, memoryWriteLine].join('\n');
  }
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  return text;
}

function readIndexLastUserMessages({ memoryRoot, sessionIds = [] } = {}) {
  const wanted = new Set(Array.isArray(sessionIds) ? sessionIds : []);
  if (wanted.size === 0) return {};
  try {
    // Lazy import keeps the module cheap when no index exists.
    const eventIndex = requireEventIndex();
    const dbPath = `${String(memoryRoot)}/.longlive/index/events.db`;
    if (!eventIndex || !dbPath) return {};
    const fs = requireFs();
    const path = requirePath();
    const resolved = path.resolve(String(memoryRoot));
    if (!fs.existsSync(path.join(resolved, '.longlive', 'index', 'events.db'))) return {};
    const index = eventIndex.openEventIndex({ memoryRoot: resolved });
    try {
      const rows = index.listEvents({ kind: 'user', limit: 200 });
      const out = {};
      for (const sessionId of wanted) {
        const own = rows.filter((row) => row.session_id === sessionId)
          .sort((a, b) => (toMs(b.time_end) ?? 0) - (toMs(a.time_end) ?? 0));
        if (own.length === 0) continue;
        const text = String(own[0].summary ?? '').trim();
        if (text === '') continue;
        out[sessionId] = {
          text,
          at: isoWithOffset(toMs(own[0].time_end)),
          prev: own.slice(1, 3).map((row) => ({ text: String(row.summary ?? '').trim(), at: isoWithOffset(toMs(row.time_end)) })),
        };
      }
      return out;
    } finally {
      index.close();
    }
  } catch {
    return {};
  }
}

// Node builtins are loaded lazily so the pure builders stay dependency-free at import time.
let cachedEventIndex = null;
let cachedFs = null;
let cachedPath = null;
function requireEventIndex() {
  return cachedEventIndex;
}
function requireFs() {
  return cachedFs;
}
function requirePath() {
  return cachedPath;
}
async function loadDeps() {
  try {
    cachedEventIndex = await import('../memory/event-index.js');
    cachedFs = await import('node:fs');
    cachedPath = await import('node:path');
  } catch {
    cachedEventIndex = null;
  }
}

/**
 * Production wrapper (read-only). Missing pieces degrade to null, never throw.
 * @returns {null|{schema,sessions,injectedAt,count,block}}
 */
export function sharedVisibility({ memoryRoot, currentSessionId = null, now = Date.now(), privacyScan = null, projectOf = null } = {}) {
  try {
    loadDepsSync();
    const nowMs = toMs(now) ?? Date.now();
    const listed = liveList({ includeDead: false }, { memoryRoot, now: nowMs });
    const entries = Array.isArray(listed?.entries) ? listed.entries : [];
    if (entries.length === 0) return null;
    let memoryWrite = null;
    try {
      const resolved = resolveMemoryWriteAt({ memoryRoot, bootAtMs: nowMs });
      if (resolved && Number.isFinite(resolved.atMs)) memoryWrite = { atMs: resolved.atMs, rel: resolved.rel };
    } catch { /* memory write is optional */ }
    const sessionIds = entries.map((entry) => entry.sessionId).filter((id) => id != null && id !== currentSessionId);
    const lastUserMessages = readIndexLastUserMessages({ memoryRoot, sessionIds });
    const visibility = buildSharedVisibility({ entries, currentSessionId, now: nowMs, memoryWrite, lastUserMessages, projectOf });
    if (visibility === null) return null;
    const block = renderSharedVisibilityBlock(visibility, { privacyScan });
    return block === '' ? null : { ...visibility, block };
  } catch {
    return null;
  }
}

// Resolve lazy deps synchronously via createRequire (fs/path) and a static import of the index.
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import * as eventIndexModule from '../memory/event-index.js';
function loadDepsSync() {
  cachedEventIndex = eventIndexModule;
  cachedFs = fsDefault;
  cachedPath = pathDefault;
}
