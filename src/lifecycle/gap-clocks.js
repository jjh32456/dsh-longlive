// src/lifecycle/gap-clocks.js — M2-B / PLAN §2.7（Lead 2026-11-07 修订版，双时钟）
//
// 两个**独立**的一等记忆，不许合并：
//   memory-gap（记忆写入空窗）= bootAt − 记忆内容文件最后写入时间
//     白名单：topics/*.md、journal/*.md、handover/*.md、flow/**/*.md、STATE.md、
//             .longlive/records.jsonl、.longlive/distill/*.jsonl
//     排除：.longlive/{hot-truncate,router,filter,live,board,bridge,tool-output}、
//           sessions/、外部记忆库、logs/、backups/、index/（逐文件 stat，绝不用目录 mtime）
//     整秒口径：floorSec(bootAt) − floorSec(lastContentWriteAt)
//   host-gap（宿主中断）= bootAt − 上次生命周期记录（缺失时退化为上一会话最后**事件**）
//     端点写死：floorSec(bootAt) − floorSec(lastSessionEventAt)，标 uncertain:true
//
// 11-06 用例 #1（fixture 写死，单测断言）：
//   bootAt      = 2026-11-06T20:36:24.799+08:00（c045 createdAt）
//   lastWrite   = 2026-11-06T14:10:33.351+08:00（handover/2026-11-06-发布计划.md）
//   memoryGap   = 23,151,448 ms（精确）/ 23,151 s（floor）= 6 小时 25 分 51 秒
//   lastSessionEventAt = 2026-11-06T20:28:59.113+08:00（e219 job/registered seq=13051）
//   hostGap     = 445,000 ms（floor 口径）= 7 分 25 秒
//
// 本模块是纯函数 + 只读扫描，不写任何文件（写 journal/事件由 lifecycle/index.js 负责）。

import fs from 'node:fs';
import path from 'node:path';

import { parseSession } from '../codec.js';

export const MS_MINUTE = 60_000;
export const HOST_GAP_WARN_MS = 3 * MS_MINUTE;
export const MEMORY_GAP_WARN_MS = 30 * MS_MINUTE;

/** memory-gap 内容白名单（rel 前缀，统一 `/` 分隔，相对 memoryRoot）。 */
export const MEMORY_CONTENT_PATTERNS = Object.freeze([
  /^topics\/[^/]+\.md$/,
  /^journal\/[^/]+\.md$/,
  /^handover\/[^/]+\.md$/,
  /^flow\/.*\.md$/,
  /^STATE\.md$/,
  /^\.longlive\/records\.jsonl$/,
  /^\.longlive\/distill\/[^/]+\.jsonl$/,
]);

export function isMemoryContentRel(rel) {
  const normalized = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '' || normalized.split('/').includes('..')) return false;
  return MEMORY_CONTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function floorSec(ms) {
  return Math.floor(Number(ms) / 1000);
}

/** 中文时长文本（验收用固定格式：X 小时 Y 分 Z 秒 / Y 分 Z 秒 / Z 秒）。 */
export function formatGapText(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function walkFiles(root, relBase = '', out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(full, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Last memory-content write strictly before bootAt (multi-file whitelist, per-file stat).
 * @returns {{atMs:number, rel:string, sources:Array<{rel:string, mtimeMs:number}>}|null}
 */
export function resolveMemoryWriteAt({ memoryRoot, bootAtMs }) {
  if (typeof memoryRoot !== 'string' || memoryRoot === '') return null;
  const boot = Number(bootAtMs);
  if (!Number.isFinite(boot)) return null;
  let candidates = [];
  try {
    candidates = walkFiles(path.resolve(memoryRoot));
  } catch {
    return null;
  }
  const sources = [];
  for (const rel of candidates) {
    if (!isMemoryContentRel(rel)) continue;
    let stat = null;
    try {
      stat = fs.statSync(path.join(memoryRoot, rel));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs >= boot) continue;
    sources.push({ rel, mtimeMs: stat.mtimeMs });
  }
  if (sources.length === 0) return null;
  sources.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
  return { atMs: sources[0].mtimeMs, rel: sources[0].rel, sources: sources.slice(0, 8) };
}

/**
 * Last session event strictly before bootAt, across the newest N session logs.
 * Used as the honest fallback when no lifecycle record exists (uncertain:true).
 */
export function resolveLastSessionEventAt({ sessionRoots, bootAtMs, limitSessions = 8 }) {
  const boot = Number(bootAtMs);
  const roots = (Array.isArray(sessionRoots) ? sessionRoots : [sessionRoots]).filter(Boolean);
  const logs = [];
  const stack = roots.map((root) => path.resolve(String(root)));
  const seen = new Set();
  while (stack.length > 0) {
    const dir = stack.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') {
        try {
          logs.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          /* skip unreadable log */
        }
      }
    }
  }
  if (logs.length === 0) return null;
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let best = null;
  for (const log of logs.slice(0, limitSessions)) {
    let parsed = null;
    try {
      parsed = parseSession(fs.readFileSync(log.file));
    } catch {
      continue;
    }
    for (const event of parsed.events) {
      const at = Number(event?.time);
      if (!Number.isFinite(at) || at >= boot) continue;
      if (best === null || at > best.atMs) best = { atMs: at, rel: log.file };
    }
  }
  return best;
}

function countActivityEvidence({ memoryRoot, fromMs, toMs }) {
  const out = { toolOutputs: 0, boardRows: 0, sessionEvents: 0 };
  // tool-output：窗口内落盘的 tool-output 归档（实测 3 个为用例 #1 的升级证据）
  const toolDir = path.join(memoryRoot, '.longlive', 'tool-output');
  for (const rel of walkFiles(toolDir)) {
    try {
      const stat = fs.statSync(path.join(toolDir, rel));
      if (stat.isFile() && stat.mtimeMs > fromMs && stat.mtimeMs <= toMs) out.toolOutputs += 1;
    } catch {
      /* skip */
    }
  }
  // board 行：窗口内的活动流行（按行内 at/ts 时间戳，缺时间戳的行不计）
  const boardFile = path.join(memoryRoot, '.longlive', 'board', 'activity.jsonl');
  try {
    for (const line of fs.readFileSync(boardFile, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Number(row?.at ?? row?.ts ?? row?.time);
      if (Number.isFinite(at) && at > fromMs && at <= toMs) out.boardRows += 1;
    }
  } catch {
    /* no board */
  }
  return out;
}

/** Compute both clocks (separate objects, never merged). */
export function computeGaps(options = {}) {
  const memoryRoot = typeof options.memoryRoot === 'string' ? path.resolve(options.memoryRoot) : '';
  const bootRaw = typeof options.bootAt === 'string' || typeof options.bootAt === 'number'
    ? new Date(options.bootAt).getTime()
    : Number(options.bootAtMs);
  const bootAtMs = Number.isFinite(bootRaw) ? bootRaw : Date.now();
  const sessionRoots = Array.isArray(options.sessionRoots) ? options.sessionRoots : [];
  const lifecycle = options.lifecycle ?? null;

  // ---- memory-gap ----
  const memoryWrite = options.memoryWriteAt !== undefined
    ? (options.memoryWriteAt === null ? null : { atMs: Number(options.memoryWriteAt), rel: 'injected', sources: [] })
    : resolveMemoryWriteAt({ memoryRoot, bootAtMs });
  let memoryGap;
  if (memoryWrite === null || !Number.isFinite(memoryWrite.atMs)) {
    memoryGap = {
      kind: 'unknown',
      gapMs: null,
      gapSec: null,
      gapText: 'unknown',
      from: null,
      to: new Date(bootAtMs).toISOString(),
      sources: [],
      activityEvidence: null,
      uncertain: true,
    };
  } else {
    const gapMsExact = bootAtMs - memoryWrite.atMs;
    const gapSec = floorSec(bootAtMs) - floorSec(memoryWrite.atMs);
    const evidence = options.activityEvidence ?? countActivityEvidence({
      memoryRoot,
      fromMs: memoryWrite.atMs,
      toMs: bootAtMs,
    });
    const activityCount = evidence.toolOutputs + evidence.boardRows + Number(evidence.sessionEvents ?? 0);
    const warn = gapSec * 1000 >= MEMORY_GAP_WARN_MS;
    memoryGap = {
      kind: warn && activityCount > 0 ? 'active-no-memory' : (warn ? 'gap' : 'ok'),
      gapMs: gapMsExact, // exact ms (fixture: 23,151,448)
      gapSec, // floor endpoints (fixture: 23,151)
      gapText: formatGapText(gapSec * 1000),
      from: new Date(memoryWrite.atMs).toISOString(),
      to: new Date(bootAtMs).toISOString(),
      sources: memoryWrite.sources,
      source: memoryWrite.rel,
      activityEvidence: evidence,
      activityCount,
      warn,
      uncertain: false,
    };
  }

  // ---- host-gap ----
  let hostFrom = null;
  let hostSource = null;
  let prevExitForm = lifecycle?.prevExitForm ?? 'unknown';
  let uncertain = false;
  if (Number.isFinite(options.lastSessionEventAtMs)) {
    hostFrom = Number(options.lastSessionEventAtMs);
    hostSource = options.lastSessionEventSource ?? 'injected-session-event';
    uncertain = true;
  } else if (lifecycle && Number.isFinite(lifecycle.lastShutdownAtMs)) {
    hostFrom = Number(lifecycle.lastShutdownAtMs);
    hostSource = 'lifecycle:shutdown';
  } else if (lifecycle && Number.isFinite(lifecycle.lastActivityAtMs)) {
    hostFrom = Number(lifecycle.lastActivityAtMs);
    hostSource = 'lifecycle:lastActivity';
    uncertain = true;
  } else if (sessionRoots.length > 0) {
    const lastEvent = resolveLastSessionEventAt({ sessionRoots, bootAtMs });
    if (lastEvent !== null) {
      hostFrom = lastEvent.atMs;
      hostSource = 'session-last-event';
      uncertain = true;
    }
  }
  let hostGap;
  if (hostFrom === null || !Number.isFinite(hostFrom)) {
    hostGap = {
      kind: 'unknown',
      gapMs: null,
      gapSec: null,
      gapText: 'unknown',
      from: null,
      to: new Date(bootAtMs).toISOString(),
      source: 'unknown',
      prevExitForm,
      uncertain: true,
    };
  } else {
    // floor 端点口径（fixture: 445,000ms / 445s）
    const gapSec = Math.max(0, floorSec(bootAtMs) - floorSec(hostFrom));
    hostGap = {
      kind: gapSec * 1000 >= HOST_GAP_WARN_MS ? 'gap' : 'ok',
      gapMs: gapSec * 1000,
      rawGapMs: Math.max(0, bootAtMs - hostFrom),
      gapSec,
      gapText: formatGapText(gapSec * 1000),
      from: new Date(hostFrom).toISOString(),
      to: new Date(bootAtMs).toISOString(),
      source: hostSource,
      prevExitForm,
      warn: gapSec * 1000 >= HOST_GAP_WARN_MS,
      uncertain,
    };
  }

  return {
    schema: 'gap-clocks/v1',
    bootAt: new Date(bootAtMs).toISOString(),
    memoryGap,
    hostGap,
    // 双钟分别记录、不合并（用例 #1：23,151,448 ms vs 445,000 ms）
    merged: false,
  };
}

/** Render the two boot-card lines (each ≤80 chars; host line is droppable). */
export function renderGapLines(gaps) {
  const lines = [];
  if (gaps?.memoryGap?.kind !== 'unknown') {
    const time = gaps.memoryGap.from?.slice(11, 19) ?? '?';
    const evidence = gaps.memoryGap.activityEvidence;
    const activityText = evidence && (evidence.toolOutputs + evidence.boardRows) > 0
      ? ` · 期间活动证据 ${evidence.toolOutputs + evidence.boardRows} 个`
      : '';
    lines.push(`▍记忆空窗 ${gaps.memoryGap.gapText}（上次记忆写入 ${time}${activityText}）`.slice(0, 80));
  }
  if (gaps?.hostGap?.kind !== 'unknown') {
    const from = gaps.hostGap.from?.slice(11, 19) ?? '?';
    const to = gaps.hostGap.to?.slice(11, 19) ?? '?';
    lines.push(`▍宿主中断 ${gaps.hostGap.gapText}（${from} → ${to} · 上次退出：${gaps.hostGap.prevExitForm ?? '未知'}）`.slice(0, 80));
  }
  return lines;
}
