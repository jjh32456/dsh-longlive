// src/role/attention.js — 角色内核 · attention queue（v2.8 §16.3 ①）
//
// 设计口径（§16.3）：
//   - 数据：`.longlive/role/attention.jsonl`，append-only，行
//     `{id, priority:P0|P1|P2, kind:ops, subject, at, source}`；
//   - pre-step 按 priority 决定事件注入顺序（P0 先）；**不改变召回内容，只排序**；
//     与 recall 冲突时记忆事实优先（facts 由调用方排在最前，本模块只排 ops 项）；
//   - 接口：`attention → kind=ops 优先级`（导出 orderOpsItems / attentionPriorityOf）。
//
// 本文件补齐任务书要求的三件事：
//   1. 事件优先级权重：kind -> 基础 priority（ops/user→P1、tool/session→P2、error→P0），
//      显式 priority 优先；P0 抢占 = 排序时永远排在最前，与到达先后无关；
//   2. 队列容量：默认 50 行（`maxItems`），超出后压缩保留最新 50 行；
//   3. 老化：超过 `agingMs`（默认 30min）未消费的条目按 `demoteSteps` 降级
//      （P0→P1→P2，最低 P2），排序时同优先级内老化项排在新鲜项之后。
//
// 纯本地、失败静默：写失败由调用方吞掉；读坏行只计数不抛。

import fs from 'node:fs';
import crypto from 'node:crypto';

import {
  RoleError, ROLE_CODES, appendJsonl, ensureRoleDir, iso, nowMs, readJsonlSafe, rolePaths, writeJsonAtomic,
} from './store.js';
import { writeProtectedFile } from './writeprotect.js';

export const ATTENTION_SCHEMA = 'attention/v1';
export const ATTENTION_PRIORITIES = Object.freeze(['P0', 'P1', 'P2']);
export const ATTENTION_KINDS = Object.freeze(['ops', 'user', 'tool', 'session', 'error']);
/** 事件种类的基础优先级（显式 priority 覆盖它）。 */
export const KIND_BASE_PRIORITY = Object.freeze({
  error: 'P0',
  ops: 'P1',
  user: 'P1',
  tool: 'P2',
  session: 'P2',
});
export const ATTENTION_DEFAULTS = Object.freeze({
  maxItems: 50,
  agingMs: 30 * 60 * 1000,
  demoteSteps: 1,
  injectMaxItems: 3,
});
const PRIORITY_INDEX = Object.freeze({ P0: 0, P1: 1, P2: 2 });

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function normalizeAttentionConfig(input = {}) {
  const cfg = input && typeof input === 'object' ? input : {};
  return {
    maxItems: clampInt(cfg.maxItems, ATTENTION_DEFAULTS.maxItems, 1, 500),
    agingMs: clampInt(cfg.agingMs, ATTENTION_DEFAULTS.agingMs, 0, 7 * 24 * 60 * 60 * 1000),
    demoteSteps: clampInt(cfg.demoteSteps, ATTENTION_DEFAULTS.demoteSteps, 0, 2),
    injectMaxItems: clampInt(cfg.injectMaxItems, ATTENTION_DEFAULTS.injectMaxItems, 1, 20),
  };
}

export function isAttentionPriority(value) {
  return ATTENTION_PRIORITIES.includes(value);
}

/** Priority for one event kind; unknown kinds fall back to P2 (never crash). */
export function attentionPriorityOfKind(kind) {
  return KIND_BASE_PRIORITY[String(kind ?? '')] ?? 'P2';
}

export function newAttentionId(nowMsValue = Date.now()) {
  return `att_${nowMsValue.toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Validate/normalize one stored row; returns null when it cannot be trusted. */
export function normalizeAttentionRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null;
  if (id === null) return null;
  const priority = isAttentionPriority(raw.priority) ? raw.priority : null;
  if (priority === null) return null;
  const subject = typeof raw.subject === 'string' ? raw.subject : '';
  const at = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)) ? raw.at : null;
  if (at === null) return null;
  return {
    id,
    priority,
    kind: typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : 'ops',
    subject,
    at,
    source: typeof raw.source === 'string' ? raw.source : 'role.attention',
    seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
  };
}

/** Pure aging/demotion of one row; never mutates the stored row. */
export function ageAttentionRow(row, { now = Date.now(), agingMs = ATTENTION_DEFAULTS.agingMs, demoteSteps = ATTENTION_DEFAULTS.demoteSteps } = {}) {
  const atMs = Date.parse(row.at);
  const ageMs = Number.isFinite(atMs) ? Math.max(0, nowMs(now) - atMs) : 0;
  const aged = agingMs > 0 && ageMs > agingMs;
  const seed = PRIORITY_INDEX[row.priority] ?? PRIORITY_INDEX.P2;
  const index = aged ? Math.min(PRIORITY_INDEX.P2, seed + demoteSteps) : seed;
  return {
    ...row,
    ageMs,
    aged,
    effectivePriority: ATTENTION_PRIORITIES[index],
  };
}

/**
 * Stable injection order: effective priority first (P0 preempts), then fresh
 * before aged, then arrival order (`at` asc, `seq` asc). Pure: no IO.
 */
export function orderAttentionRows(rows, options = {}) {
  const cfg = normalizeAttentionConfig(options.config ?? options);
  const now = options.now ?? Date.now();
  const decorated = (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeAttentionRow(row))
    .filter(Boolean)
    .map((row) => ageAttentionRow(row, { now, agingMs: cfg.agingMs, demoteSteps: cfg.demoteSteps }));
  decorated.sort((left, right) => {
    const byPriority = (PRIORITY_INDEX[left.effectivePriority] ?? 2) - (PRIORITY_INDEX[right.effectivePriority] ?? 2);
    if (byPriority !== 0) return byPriority;
    if (left.aged !== right.aged) return left.aged ? 1 : -1;
    const byAt = String(left.at).localeCompare(String(right.at));
    if (byAt !== 0) return byAt;
    return (left.seq ?? 0) - (right.seq ?? 0) || left.id.localeCompare(right.id);
  });
  return decorated;
}

/**
 * The `attention → kind=ops` interface (pure): reorder ops items by their
 * attention priority. Facts are NOT handled here — the caller keeps memory
 * facts ahead of ops items (与 recall 冲突时记忆事实优先).
 * @param {Array<object>} opsItems items with `subject`/`id` matching attention rows
 * @param {Array<object>} attentionRows rows from the queue
 */
export function orderOpsItems(opsItems, attentionRows, options = {}) {
  const items = Array.isArray(opsItems) ? opsItems : [];
  const orderedRows = orderAttentionRows(attentionRows, options);
  const priorityBySubject = new Map();
  for (const row of orderedRows) {
    const key = row.subject !== '' ? row.subject : row.id;
    if (!priorityBySubject.has(key)) priorityBySubject.set(key, row.effectivePriority);
  }
  const decorated = items.map((item, index) => {
    const key = typeof item?.subject === 'string' && item.subject !== ''
      ? item.subject
      : (typeof item?.id === 'string' ? item.id : '');
    const explicit = isAttentionPriority(item?.attentionPriority) ? item.attentionPriority : null;
    const priority = explicit ?? priorityBySubject.get(key) ?? 'P2';
    return { item, index, priority, priorityIndex: PRIORITY_INDEX[priority] ?? 2 };
  });
  decorated.sort((left, right) => left.priorityIndex - right.priorityIndex || left.index - right.index);
  return {
    items: decorated.map((entry) => entry.item),
    priorities: decorated.map((entry) => entry.priority),
    unmatched: decorated.filter((entry) => !priorityBySubject.has(
      typeof entry.item?.subject === 'string' && entry.item.subject !== ''
        ? entry.item.subject
        : (typeof entry.item?.id === 'string' ? entry.item.id : ''),
    )).length,
    source: 'attention',
  };
}

/**
 * Append-only attention queue. Writing is best effort at the call site; the
 * queue itself validates arguments and throws RoleError on bad input (the
 * feature wiring swallows that, tests assert it).
 */
export function createAttentionQueue({ memoryRoot, now = () => new Date(), config = {}, auditKey = null, actorKind = 'host' } = {}) {
  const cfg = normalizeAttentionConfig(config);
  const root = memoryRoot;
  const paths = rolePaths(root);

  function readRows({ limit = 10_000 } = {}) {
    const read = readJsonlSafe(paths.attention, { limit, memoryRoot: root, auditKey });
    if (read.tampered === true) {
      return { present: true, rows: [], bad: 0, total: 0, tampered: true, code: read.code ?? ROLE_CODES.TAMPER };
    }
    const rows = [];
    for (const raw of read.rows) {
      const row = normalizeAttentionRow(raw);
      if (row) rows.push(row);
    }
    return { present: read.present, rows, bad: read.bad, total: read.total ?? rows.length, tampered: false };
  }

  function nextSeq(rows) {
    let max = 0;
    for (const row of rows) if (Number.isInteger(row.seq) && row.seq > max) max = row.seq;
    return max + 1;
  }

  function compact(rows) {
    if (rows.length <= cfg.maxItems) return { compacted: false, kept: rows.length };
    const keptRows = orderAttentionRows(rows, { now: now(), config: cfg })
      .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
      .slice(-cfg.maxItems);
    const text = `${keptRows.map((row) => JSON.stringify({
      id: row.id,
      priority: row.priority,
      kind: row.kind,
      subject: row.subject,
      at: row.at,
      source: row.source,
      seq: row.seq,
    })).join('\n')}\n`;
    writeProtectedFile({ memoryRoot: root, file: paths.attention, text, auditKey, actorKind });
    return { compacted: true, kept: keptRows.length };
  }

  /**
   * Record one event. `priority` wins over the kind table; `kind` defaults to
   * 'ops' (the v2.8 row schema names kind=ops explicitly).
   */
  function enqueue({
    priority = undefined,
    kind = 'ops',
    subject = '',
    source = 'role.attention',
    at = undefined,
  } = {}) {
    const resolvedKind = ATTENTION_KINDS.includes(String(kind)) ? String(kind) : 'ops';
    const resolvedPriority = priority === undefined ? attentionPriorityOfKind(resolvedKind) : priority;
    if (!isAttentionPriority(resolvedPriority)) {
      throw new RoleError(ROLE_CODES.PARAMS, `attention priority 非法：${JSON.stringify(priority)}（允许 ${ATTENTION_PRIORITIES.join('|')}）`);
    }
    if (typeof subject === 'string' && Array.from(subject).length > 200) {
      throw new RoleError(ROLE_CODES.PARAMS, 'attention subject 超过 200 字符');
    }
    const atMs = at === undefined
      ? nowMs(now())
      : (at instanceof Date ? at.getTime() : (typeof at === 'number' ? at : Date.parse(String(at))));
    if (!Number.isFinite(atMs)) throw new RoleError(ROLE_CODES.PARAMS, 'attention.at 不是可解析的时间');
    ensureRoleDir(root);
    const existing = readRows();
    const row = {
      id: newAttentionId(atMs),
      priority: resolvedPriority,
      kind: resolvedKind,
      subject: typeof subject === 'string' ? subject : '',
      at: iso(atMs),
      source: typeof source === 'string' && source !== '' ? source : 'role.attention',
      seq: nextSeq(existing.rows),
    };
    appendJsonl(paths.attention, row, { memoryRoot: root, auditKey, actorKind });
    const total = existing.rows.length + 1;
    const compaction = total > cfg.maxItems ? compact([...existing.rows, row]) : { compacted: false, kept: total };
    return { ok: true, row, seq: row.seq, compaction };
  }

  /** Rows in injection order (aged items demoted, P0 first). */
  function pending({ limit = cfg.maxItems, now: nowValue = undefined } = {}) {
    const read = readRows();
    const ordered = orderAttentionRows(read.rows, { now: nowValue ?? now(), config: cfg });
    return {
      ok: read.tampered !== true,
      items: ordered.slice(0, limit),
      total: read.rows.length,
      bad: read.bad,
      present: read.present,
      tampered: read.tampered === true,
      code: read.tampered === true ? (read.code ?? ROLE_CODES.TAMPER) : null,
    };
  }

  /** Read-only panel/route view (`attention/v1`). */
  function view({ limit = cfg.maxItems, now: nowValue = undefined } = {}) {
    const pendingItems = pending({ limit, now: nowValue });
    return {
      schema: ATTENTION_SCHEMA,
      present: pendingItems.present,
      count: pendingItems.items.length,
      total: pendingItems.total,
      bad: pendingItems.bad,
      tampered: pendingItems.tampered === true,
      degraded: pendingItems.tampered === true || pendingItems.bad > 0 || pendingItems.present === false,
      items: pendingItems.items.map((row) => ({
        id: row.id,
        priority: row.priority,
        kind: row.kind,
        subject: row.subject,
        at: row.at,
        source: row.source,
        effectivePriority: row.effectivePriority,
        aged: row.aged,
      })),
    };
  }

  /** Highest effective priority matching a subject (null when unknown). */
  function priorityFor(subject, { now: nowValue = undefined } = {}) {
    const pendingItems = pending({ limit: cfg.maxItems, now: nowValue });
    for (const row of pendingItems.items) if (row.subject === String(subject ?? '')) return row.effectivePriority;
    return null;
  }

  /** The ops ordering interface bound to this queue (pure result). */
  function orderOps(items, options = {}) {
    const read = readRows();
    return orderOpsItems(items, read.rows, { now: options.now ?? now(), config: cfg });
  }

  return {
    enqueue,
    pending,
    view,
    priorityFor,
    orderOps,
    config: cfg,
    paths,
    read: readRows,
  };
}
