// src/ui/actions.js — M2-G 面板动作面（preview → apply → audit → undo）
//
// 契约（MEMORY-RECALL-V2-PROPOSAL v2.6.3 §12.4 / §12.7）：
//   - 18 个动作名（唯一权威词表，未知动作 400 `E_ACTION_UNKNOWN`）；
//   - 四段：preview（60s TTL，不落库）→ apply（CAS + 幂等 + 私有目录执行 + HMAC 审计）
//     → audit（GET 只读链）→ undo（24h 窗口、不可再 undo）；
//   - 待判队列状态机：pending→approved|rejected|returned → applied|failed → undone；
//     pending→expired（超审批窗，保护态只读）；expired→pending 仅人工 review.reopen；
//   - 权限：HTTP/工具/CLI 同一 `actionGate()`（能力令牌 + actor 绑定 + subagent 403）；
//   - 完整性：每次动作前跑 `integrity.checkBeforeAction()`，失败 401 `E_PANEL_INTEGRITY`；
//   - evidence 私有写：`.longlive/evidence/latest.json`，仅宿主签名可写；
//   - 面板未装/无有效令牌 → 动作队列 `paused`，禁止自动 apply（R12）。
//
// 所有落盘都在宿主私有目录 `<memoryRoot>/.longlive/` 下，绝不写 profile/第三方目录。

import fs from 'node:fs';
import path from 'node:path';

import { hashActorId } from '../actions/audit.js';
import {
  actionsDir,
  newId,
  readJsonFile,
  readJsonl,
  sha256Hex,
  stableStringify,
  writeJsonAtomic,
  writeJsonlAtomic,
} from '../actions/fs.js';
import { EvidenceError } from '../actions/evidence.js';
import { RELATIONSHIP_TIERS, readRelationships, restoreRelationship, updateRelationship } from '../role/relationships.js';
import { readClaims } from '../memory/governance.js';

/** The only 18 action names the panel may send (§12.7-G7; relationship.update @ v2.8 §16.3). */
export const ACTION_NAMES = Object.freeze([
  'approve',
  'reject',
  'return',
  'promote',
  'merge',
  'distill',
  'archive',
  'restore',
  'undo',
  'apply',
  'annotate',
  'dry-run',
  'distill.rollback',
  'protection.add',
  'protection.remove',
  'review.reopen',
  'conflict.arbitrate',
  'relationship.update',
]);

export const REVIEW_STATES = Object.freeze([
  'pending', 'approved', 'rejected', 'returned', 'applied', 'failed', 'undone', 'expired',
]);

export const PREVIEW_TTL_MS = 60_000;
export const UNDO_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MAX = 1000;
export const REVIEW_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIONS_SCHEMA = 'actions/v1';
export const REVIEW_SCHEMA = 'review/v1';

/** Actions that may not be undone (§12.7-G7). */
const NOT_UNDOABLE = new Set(['restore', 'undo', 'annotate', 'dry-run', 'distill.rollback', 'review.reopen']);

/** reason must be ≥10 chars for the human-decided actions. */
const REASON_ACTIONS = new Set(['reject', 'return', 'distill.rollback', 'protection.add', 'protection.remove', 'review.reopen', 'relationship.update']);

export class PanelActionError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'PanelActionError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function nowIso(clock) {
  try {
    return clock().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function hashOf(value) {
  return sha256Hex(stableStringify(value ?? null));
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PanelActionError('E_PARAMS', `${label} 必须是对象。`, 422);
  }
}

function requireString(value, label, min = 1) {
  if (typeof value !== 'string' || value.length < min) {
    throw new PanelActionError('E_PARAMS', `${label} 缺失或长度不足（≥${min}）。`, 422);
  }
  return value;
}

function parseVersion(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new PanelActionError('E_PARAMS', 'expectedVersion 必须是非负整数。', 422);
  }
  return value;
}

/** Validate params for one action. Throws `E_PARAMS` / `E_TARGET_*` per §12.7/§12.10-R7. */
export function validateActionParams(action, target, params = {}) {
  if (!ACTION_NAMES.includes(action)) {
    throw new PanelActionError('E_ACTION_UNKNOWN', `未知动作：${action}`, 400);
  }
  requireObject(target ?? {}, 'target');
  requireObject(params, 'params');
  const p = params;
  if (REASON_ACTIONS.has(action)) {
    if (typeof p.reason !== 'string' || p.reason.trim().length < 10) {
      throw new PanelActionError('E_PARAMS', `${action} 需要 reason（≥10 字）。`, 422);
    }
  }
  switch (action) {
    case 'approve':
    case 'reject':
    case 'return':
      requireString(p.itemId ?? target.id, `${action}.itemId`);
      break;
    case 'review.reopen':
      requireString(p.reviewId ?? target.id, 'review.reopen.reviewId');
      break;
    case 'promote':
      requireString(p.distillId ?? target.id, 'promote.distillId');
      requireString(p.targetKind, 'promote.targetKind');
      break;
    case 'merge': {
      const eventIds = p.eventIds ?? target.eventIds;
      if (!Array.isArray(eventIds) || eventIds.length < 2 || eventIds.length > 10) {
        throw new PanelActionError('E_TARGET_EVENTIDS', 'merge.eventIds 必须是 2..10 个事件 id。', 422);
      }
      const primaryId = p.primaryId ?? target.primaryId;
      if (typeof primaryId !== 'string' || !eventIds.includes(primaryId)) {
        throw new PanelActionError('E_TARGET_EVENTIDS', 'merge.primaryId 必须是 eventIds 之一。', 422);
      }
      break;
    }
    case 'distill': {
      const sourceIds = p.sourceIds ?? target.sourceIds;
      if (!Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 20) {
        throw new PanelActionError('E_PARAMS', 'distill.sourceIds 必须是 1..20 个来源 id。', 422);
      }
      if (p.mode !== undefined && p.mode !== 'extractive') {
        throw new PanelActionError('E_PARAMS', 'distill.mode 只支持 extractive。', 422);
      }
      break;
    }
    case 'archive': {
      const recordId = p.recordId ?? target.recordId ?? target.id;
      if (typeof recordId !== 'string' || recordId === '') {
        throw new PanelActionError('E_TARGET_INCOMPLETE', 'archive.recordId 缺失（面板按钮禁用）。', 422);
      }
      const report = p.archiveReport ?? target.archiveReport;
      if (report === undefined) {
        throw new PanelActionError('E_TARGET_INCOMPLETE', 'archive.archiveReport 缺失（三问未填）。', 422);
      }
      for (const key of ['reason', 'affects', 'stillUseful', 'recoverable']) {
        if (report?.[key] === undefined || report?.[key] === null || report?.[key] === '') {
          throw new PanelActionError('E_ARCHIVE_REPORT_INCOMPLETE', `archiveReport.${key} 缺失。`, 422);
        }
      }
      if (typeof report.recoverable !== 'boolean') {
        throw new PanelActionError('E_ARCHIVE_REPORT_INCOMPLETE', 'archiveReport.recoverable 必须是布尔值。', 422);
      }
      break;
    }
    case 'restore':
      requireString(p.archiveId ?? target.id, 'restore.archiveId');
      break;
    case 'undo':
      requireString(p.actionId ?? target.id, 'undo.actionId');
      return; // undo endpoint path; no CAS on target
    case 'apply':
      requireString(p.previewId ?? target.previewId, 'apply.previewId');
      break;
    case 'annotate':
      requireString(p.note, 'annotate.note');
      if (p.note.length > 500) throw new PanelActionError('E_PARAMS', 'annotate.note 超过 500 字。', 422);
      if (p.visibility !== undefined && !['panel', 'audit'].includes(p.visibility)) {
        throw new PanelActionError('E_PARAMS', 'annotate.visibility 只能是 panel|audit。', 422);
      }
      break;
    case 'dry-run':
      if (typeof p.action !== 'string' || !ACTION_NAMES.includes(p.action)) {
        throw new PanelActionError('E_ACTION_UNKNOWN', 'dry-run.action 必须是已知动作。', 400);
      }
      break;
    case 'distill.rollback':
      requireString(p.distillId ?? target.id, 'distill.rollback.distillId');
      break;
    case 'protection.add':
      requireString(p.id ?? target.id, 'protection.add.id');
      requireString(p.kind ?? target.kind ?? 'record', 'protection.add.kind');
      break;
    case 'protection.remove':
      requireString(p.id ?? target.id, 'protection.remove.id');
      break;
    case 'conflict.arbitrate': {
      requireString(p.claimA ?? target.claimA, 'conflict.arbitrate.claimA');
      requireString(p.claimB ?? target.claimB, 'conflict.arbitrate.claimB');
      const resolution = p.resolution ?? target.resolution;
      if (!['preferA', 'preferB', 'both', 'disputed'].includes(resolution)) {
        throw new PanelActionError('E_PARAMS', 'conflict.arbitrate.resolution 必须是 preferA|preferB|both|disputed。', 422);
      }
      const expectedVersion = p.expectedVersion ?? target.expectedVersion;
      if (!Number.isInteger(expectedVersion)) {
        throw new PanelActionError('E_PARAMS', 'conflict.arbitrate 需要 expectedVersion（CAS 版本号；无版本源=422）。', 422);
      }
      break;
    }
    case 'relationship.update': {
      requireString(p.personId ?? target.personId ?? target.id, 'relationship.update.personId');
      const tier = p.tier ?? target.tier;
      if (!RELATIONSHIP_TIERS.includes(tier)) {
        throw new PanelActionError('E_PARAMS', `relationship.update.tier 必须是 ${RELATIONSHIP_TIERS.join('|')}。`, 422);
      }
      break;
    }
    default:
      break;
  }
}

/** Initial review row schema is §12.7-G1; incomplete/unknown rows stay visible but flagged. */
export function normalizeReviewRow(row) {
  const rawState = typeof row?.state === 'string' && row.state !== '' ? row.state : 'pending';
  return {
    id: typeof row?.id === 'string' ? row.id : '',
    kind: typeof row?.kind === 'string' ? row.kind : 'memory',
    salience: Number.isInteger(row?.salience) ? row.salience : 3,
    lastUsed: row?.lastUsed ?? null,
    target: row?.target ?? null,
    // Unknown states are preserved (never silently coerced): transitions on
    // them are rejected + audited (§12.4 "未知状态=FAIL").
    state: rawState,
    expiry: row?.expiry ?? null,
    decision: row?.decision ?? null,
    createdAt: row?.createdAt ?? null,
    source: row?.source ?? null,
    version: Number.isInteger(row?.version) ? row.version : 1,
    completeness: row?.target && typeof row.target === 'object' && row.target.version !== undefined ? 'complete' : 'partial',
  };
}

/**
 * Create the action service.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {ReturnType<import('./panel-auth.js').createPanelAuth>} options.auth
 * @param {ReturnType<import('./panel-integrity.js').createIntegrityGuard>} options.integrity
 * @param {ReturnType<import('../actions/audit.js').createAuditLog>} options.audit
 * @param {ReturnType<import('../actions/evidence.js').createEvidenceWriter>} [options.evidence]
 * @param {() => Date} [options.now]
 */
export function createActionService(options = {}) {
  const memoryRoot = String(options.memoryRoot ?? '');
  const auth = options.auth;
  const integrity = options.integrity;
  const audit = options.audit;
  const evidence = options.evidence;
  // Role-layer data files are sealed with the host auditKey when the service has
  // one (panel path); otherwise the role layer falls back to the host key file.
  const roleAuditKey = options.auditKey ?? null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  // P1-2: all TTLs (preview 60s / undo 24h / review 7d) are enforced on a
  // monotonic clock anchored at service boot. A wall-clock rollback cannot
  // revive an expired preview/undo, and a forward jump cannot shorten or
  // extend an existing TTL. Wall time is only used for display/audit stamps,
  // plus the lastSeenWall watermark for rollback detection.
  const monoNow = typeof options.monoNow === 'function'
    ? options.monoNow
    : () => {
      const [seconds, nanoseconds] = process.hrtime();
      return seconds * 1000 + nanoseconds / 1e6;
    };
  const CLOCK_TOLERANCE_MS = Number.isFinite(options.clockToleranceMs) && options.clockToleranceMs >= 0
    ? options.clockToleranceMs
    : 5000;
  const bootMono = monoNow();
  const base = path.join(String(memoryRoot ?? ''), '.longlive');
  const reviewFile = path.join(base, 'review', 'queue.jsonl');
  const stateFile = path.join(base, 'actions', 'state.json');
  const protectionFile = path.join(base, 'protected.json');
  const conflictStateFile = path.join(base, 'conflicts', 'state.json');
  const idempotencyFile = path.join(base, 'actions', 'idempotency.jsonl');
  const queueFile = path.join(base, 'actions', 'queue.jsonl');
  const annotationsFile = path.join(base, 'annotations.jsonl');
  const distillDir = path.join(base, 'distill');
  const tombstonesDir = path.join(base, 'archive', 'tombstones');

  /** previewId → { action, target, params, diff, risks, expiresAt, createdAt } */
  const previews = new Map();
  /** idempotencyKey → { at, result } */
  const idempotency = new Map();

  function loadIdempotency() {
    const read = readJsonl(idempotencyFile);
    for (const row of read.rows) {
      if (typeof row?.key === 'string' && row.result !== undefined) {
        idempotency.set(row.key, { at: Number(row.at) || 0, result: row.result });
      }
    }
  }
  loadIdempotency();

  function readState() {
    const read = readJsonFile(stateFile);
    const state = read.ok && read.value && typeof read.value === 'object' ? read.value : {};
    return {
      v: 1,
      records: state.records && typeof state.records === 'object' ? state.records : {},
      distills: state.distills && typeof state.distills === 'object' ? state.distills : {},
      archives: state.archives && typeof state.archives === 'object' ? state.archives : {},
      actionRecords: state.actionRecords && typeof state.actionRecords === 'object' ? state.actionRecords : {},
      protectionVersion: Number.isInteger(state.protectionVersion) ? state.protectionVersion : 1,
      lastSeenWallMs: Number.isFinite(state.lastSeenWallMs) ? state.lastSeenWallMs : 0,
    };
  }

  function writeState(state) {
    writeJsonAtomic(stateFile, {
      v: 1,
      ...state,
      lastSeenWallMs: Math.max(Number(state.lastSeenWallMs) || 0, lastSeenWallMs),
      updatedAt: nowIso(now),
    });
  }

  // Boot anchor: persisted lastSeen wall watermark (from the previous boot) and
  // the current wall time; effective wall = anchor + monotonic elapsed.
  let lastSeenWallMs = 0;
  let bootWallMs = 0;
  {
    const initial = readState();
    bootWallMs = Math.max(Number(initial.lastSeenWallMs) || 0, now().getTime());
    lastSeenWallMs = bootWallMs;
  }

  function monoElapsedMs() {
    const value = monoNow();
    return Number.isFinite(value) ? Math.max(0, value - bootMono) : 0;
  }

  /** Wall time that cannot be moved by setting the OS clock. */
  function effectiveWallMs() {
    return bootWallMs + monoElapsedMs();
  }

  /**
   * Persisted wall watermark vs current wall: an obvious rollback fails closed
   * (E_CLOCK_ROLLBACK) and is audited. Small NTP corrections within tolerance
   * are accepted; monotonic TTLs make them harmless anyway.
   */
  function clockGuard() {
    const wall = now().getTime();
    if (Number.isFinite(wall) && lastSeenWallMs > 0 && wall + CLOCK_TOLERANCE_MS < lastSeenWallMs) {
      try {
        appendAudit('clock.rollback', { kind: 'clock', id: 'system-wall' }, { lastSeenWallMs }, { wall, rejected: true });
      } catch {
        /* audit best effort; still fail closed */
      }
      throw new PanelActionError(
        'E_CLOCK_ROLLBACK',
        `检测到系统时钟回拨（now=${new Date(wall).toISOString()} < lastSeen=${new Date(lastSeenWallMs).toISOString()}）：动作已拒绝并审计。`,
        409,
        { wall, lastSeenWallMs },
      );
    }
    if (Number.isFinite(wall) && wall > lastSeenWallMs) lastSeenWallMs = wall;
    return wall;
  }

  function readReview() {
    const read = readJsonl(reviewFile);
    return { rows: read.rows.map(normalizeReviewRow), bad: read.bad };
  }

  function writeReview(rows) {
    writeJsonlAtomic(reviewFile, rows);
  }

  function currentReviewState(row) {
    if (row.state === 'pending' && row.expiry !== null && row.expiry !== undefined) {
      const expiryMs = Date.parse(String(row.expiry));
      // effectiveWallMs() is boot-anchored + monotonic: setting the OS clock
      // back does not un-expire a review item, and a forward jump does not
      // expire it early.
      if (Number.isFinite(expiryMs) && effectiveWallMs() > expiryMs) return 'expired';
    }
    return row.state;
  }

  function findReviewRow(id) {
    const { rows } = readReview();
    const index = rows.findIndex((row) => row.id === id);
    return { rows, index, row: index >= 0 ? rows[index] : null };
  }

  function readProtection() {
    const read = readJsonFile(protectionFile);
    const value = read.ok && read.value && typeof read.value === 'object' ? read.value : {};
    return {
      version: Number.isInteger(value.version) ? value.version : 1,
      default: value.default === 'protect' ? 'protect' : (value.default ?? 'protect'),
      entries: Array.isArray(value.entries) ? value.entries : [],
    };
  }

  function writeProtection(protection) {
    writeJsonAtomic(protectionFile, {
      version: Number.isInteger(protection.version) ? protection.version : 1,
      default: protection.default ?? 'protect',
      entries: protection.entries ?? [],
      updatedAt: nowIso(now),
    });
  }

  function conflictKey(claimA, claimB) {
    return [String(claimA), String(claimB)].sort().join('|');
  }

  function readConflictState() {
    const read = readJsonFile(conflictStateFile);
    const value = read.ok && read.value && typeof read.value === 'object' ? read.value : {};
    return {
      version: Number.isInteger(value.version) ? value.version : 0,
      items: value.items && typeof value.items === 'object' ? value.items : {},
    };
  }

  function writeConflictState(state) {
    writeJsonAtomic(conflictStateFile, {
      version: Number.isInteger(state.version) ? state.version : 1,
      items: state.items ?? {},
      updatedAt: nowIso(now),
    });
  }

  function currentConflictVersion(claimA, claimB) {
    const state = readConflictState();
    const item = state.items[conflictKey(claimA, claimB)];
    return item && Number.isInteger(item.version) ? item.version : 0;
  }

  function resolveConflictEffect(claimA, claimB, resolution, actor) {
    const claims = readClaims({ memoryRoot, actor: { kind: 'host' } }).items;
    const hitA = claims.find((claim) => claim.id === claimA);
    const hitB = claims.find((claim) => claim.id === claimB);
    if (!hitA || !hitB) {
      throw new PanelActionError('E_TARGET_INCOMPLETE', `冲突双方必须都是已存在 Claim（${claimA} / ${claimB}）。`, 404);
    }
    const state = readConflictState();
    const key = conflictKey(claimA, claimB);
    const previous = state.items[key] ?? null;
    const next = {
      claimA,
      claimB,
      resolution,
      // 仲裁 ≠ 验证：这里只记录仲裁结论，绝不把 claims.state 改成 verified。
      arbitrationOnly: true,
      version: (previous && Number.isInteger(previous.version) ? previous.version : 0) + 1,
      resolvedAt: nowIso(now),
      actor: actor ?? 'host',
      history: [
        ...((previous && Array.isArray(previous.history)) ? previous.history.slice(-19) : []),
        { resolution, at: nowIso(now) },
      ],
    };
    state.items[key] = next;
    state.version = (Number.isInteger(state.version) ? state.version : 0) + 1;
    writeConflictState(state);
    return { key, previous, next };
  }

  function auditTarget(target) {
    return {
      kind: target?.kind ?? null,
      id: target?.id ?? null,
      version: target?.version ?? null,
    };
  }

  function appendAudit(action, target, before, after) {
    return audit.append({
      actorId: hashActorId('host'),
      action,
      target: auditTarget(target),
      beforeHash: hashOf(before),
      afterHash: hashOf(after),
    });
  }

  function gate(request) {
    if (!auth || typeof auth.actionGate !== 'function') {
      throw new PanelActionError('E_NO_CAP', '宿主权限门未装配。', 401);
    }
    let verdict;
    try {
      verdict = auth.actionGate({
        source: request?.source ?? 'http',
        headers: request?.headers ?? {},
        actorKind: request?.actorKind ?? 'host',
      });
    } catch (error) {
      throw new PanelActionError(error.code ?? 'E_NO_CAP', error.message ?? '权限校验失败。', error.status ?? 401);
    }
    // P1-2: wall-clock rollback fails closed before any state change (and is
    // audited); forward jumps never shorten/extend monotonic TTLs.
    clockGuard();
    if (integrity !== undefined && typeof integrity.checkBeforeAction === 'function') {
      try {
        integrity.checkBeforeAction();
      } catch (error) {
        throw new PanelActionError('E_PANEL_INTEGRITY', error.message ?? '面板完整性校验失败。', 401, error.statusPayload);
      }
    }
    // P1-2: actor 必须由宿主令牌注入；缺省拒绝，绝不回退成 'host' 默认值。
    if (typeof verdict?.actor !== 'string' || verdict.actor === '') {
      throw new PanelActionError('E_ACTOR_REQUIRED', 'actor 必须由宿主注入（令牌绑定），缺省拒绝。', 401);
    }
    return { actor: verdict.actor, source: verdict.source ?? 'http' };
  }

  function idempotentReplay(key) {
    if (typeof key !== 'string' || key === '') return null;
    const hit = idempotency.get(key);
    if (!hit) return null;
    // Monotonic when the entry was recorded in this process; wall clock is only
    // a fallback for rows loaded from a previous boot.
    const expired = Number.isFinite(hit.atMono)
      ? monoNow() - hit.atMono > IDEMPOTENCY_TTL_MS
      : now().getTime() - hit.at > IDEMPOTENCY_TTL_MS;
    if (expired) {
      idempotency.delete(key);
      return null;
    }
    return { ...hit.result, replayed: true };
  }

  function rememberIdempotent(key, result) {
    if (typeof key !== 'string' || key === '') return;
    const at = now().getTime();
    const atMono = monoNow();
    idempotency.set(key, { at, atMono, result });
    try {
      writeJsonAtomic(idempotencyFile, {
        key,
        at,
        atMono,
        result,
      });
    } catch {
      /* best effort; memory copy still prevents in-process replay */
    }
    if (idempotency.size > IDEMPOTENCY_MAX) {
      const oldest = [...idempotency.entries()].sort((a, b) => (a[1].atMono ?? a[1].at) - (b[1].atMono ?? b[1].at));
      for (const [oldKey] of oldest.slice(0, idempotency.size - IDEMPOTENCY_MAX)) idempotency.delete(oldKey);
    }
  }

  function recordAction(record) {
    const state = readState();
    state.actionRecords[record.actionId] = record;
    writeState(state);
  }

  function readAction(actionId) {
    const state = readState();
    return state.actionRecords[actionId] ?? null;
  }

  function planDiffFor(action, target, params) {
    const before = {
      action,
      target: auditTarget(target),
      params: { ...params },
    };
    const after = {
      action,
      effect: describeEffect(action, target, params),
    };
    const risks = [];
    if (['archive', 'promote', 'merge', 'distill'].includes(action)) risks.push('会改写记忆状态（可通过 undo 回滚）');
    if (action === 'protection.remove') risks.push('保护名单移除（重要事件永禁移除）');
    if (action === 'review.reopen') risks.push('仅允许 expired→pending');
    return { diff: { before, after }, risks };
  }

  function describeEffect(action, target, params) {
    switch (action) {
      case 'approve': return { reviewState: 'approved', itemId: params.itemId ?? target.id };
      case 'reject': return { reviewState: 'rejected', itemId: params.itemId ?? target.id };
      case 'return': return { reviewState: 'returned', itemId: params.itemId ?? target.id };
      case 'review.reopen': return { reviewState: 'pending', reviewId: params.reviewId ?? target.id };
      case 'promote': return { promote: params.distillId ?? target.id, targetKind: params.targetKind };
      case 'merge': return { merge: params.eventIds ?? target.eventIds, primaryId: params.primaryId ?? target.primaryId };
      case 'distill': return { distill: params.sourceIds ?? target.sourceIds, mode: 'extractive' };
      case 'archive': return { archive: params.recordId ?? target.recordId ?? target.id };
      case 'restore': return { restore: params.archiveId ?? target.id };
      case 'apply': return { apply: params.previewId ?? target.previewId };
      case 'annotate': return { annotate: target?.id ?? null, visibility: params.visibility ?? 'panel' };
      case 'distill.rollback': return { rollback: params.distillId ?? target.id };
      case 'protection.add': return { protection: 'add', id: params.id ?? target.id };
      case 'protection.remove': return { protection: 'remove', id: params.id ?? target.id };
      case 'conflict.arbitrate': return { conflict: [params.claimA, params.claimB].sort().join('|'), resolution: params.resolution, arbitrationOnly: true };
    case 'relationship.update': return {
        relationship: {
          personId: params.personId ?? target.personId ?? target.id,
          tier: params.tier ?? target.tier,
        },
      };
      case 'undo': return { undo: params.actionId ?? target.id };
      case 'dry-run': return { dryRun: params.action };
      default: return { noop: action };
    }
  }

  function currentVersionOf(action, target, params) {
    const id = params[idFieldFor(action)] ?? target?.id;
    if (['approve', 'reject', 'return', 'review.reopen'].includes(action)) {
      const { row } = findReviewRow(typeof id === 'string' ? id : '');
      return row ? row.version : undefined;
    }
    if (action === 'protection.add' || action === 'protection.remove') {
      const protection = readProtection();
      const entryId = params.id ?? target?.id;
      const hit = protection.entries.find((entry) => entry.id === entryId);
      return hit ? (entryVersion(hit)) : protection.version;
    }
    if (['promote', 'merge', 'distill', 'archive', 'restore'].includes(action)) {
      const state = readState();
      const recordId = params[idFieldFor(action)] ?? target?.id;
      const record = state.records[recordId] ?? state.distills[params.distillId ?? target?.id] ?? null;
      if (record !== null) return Number.isInteger(record.version) ? record.version : 1;
      return Number.isInteger(target?.version) ? (target.version - 1) : 0;
    }
    if (action === 'conflict.arbitrate') {
      const claimA = params.claimA ?? target?.claimA;
      const claimB = params.claimB ?? target?.claimB;
      return currentConflictVersion(claimA, claimB);
    }
    if (action === 'relationship.update') {
      const personId = params.personId ?? target?.personId ?? target?.id;
      // 同一张关系图可能由 panel auditKey 或 host key file 封签；CAS 读要透传服务 key，缺 key 时仍 fail-safe。
      const graph = readRelationships({ memoryRoot, auditKey: roleAuditKey });
      const node = graph.nodes.find((item) => item.personId === String(personId ?? ''));
      return node ? node.version : 0;
    }
    if (action === 'annotate') {
      // annotate does not change the record state; CAS is against the version
      // the panel saw in `target.version`.
      return Number.isInteger(target?.version) ? target.version : 0;
    }
    return Number.isInteger(target?.version) ? target.version : 0;
  }

  function idFieldFor(action) {
    switch (action) {
      case 'approve':
      case 'reject':
      case 'return': return 'itemId';
      case 'review.reopen': return 'reviewId';
      case 'promote': return 'distillId';
      case 'distill': return 'sourceIds';
      case 'archive': return 'recordId';
      case 'restore': return 'archiveId';
      case 'distill.rollback': return 'distillId';
      case 'protection.add':
      case 'protection.remove': return 'id';
      case 'conflict.arbitrate': return 'claimA';
      case 'relationship.update': return 'personId';
      case 'annotate': return 'targetId';
      default: return 'id';
    }
  }

  function entryVersion(entry) {
    return Number.isInteger(entry?.version) ? entry.version : 1;
  }

  function assertCas(action, target, params, expectedVersion) {
    const current = currentVersionOf(action, target, params);
    if (Number.isInteger(current) && expectedVersion !== current) {
      throw new PanelActionError('E_CAS_CONFLICT', `版本冲突：expectedVersion=${expectedVersion} 当前=${current}`, 409, { current, expectedVersion });
    }
    return current;
  }

  function applyEffect(action, target, params, actor) {
    const timestamp = nowIso(now);
    switch (action) {
      case 'approve':
      case 'reject':
      case 'return': {
        const itemId = params.itemId ?? target.id;
        const map = { approve: 'approved', reject: 'rejected', return: 'returned' };
        const { rows, index, row } = findReviewRow(itemId);
        if (index < 0) throw new PanelActionError('E_TARGET_INCOMPLETE', `review 条目不存在：${itemId}`, 404);
        const currentState = currentReviewState(row);
        if (!REVIEW_STATES.includes(currentState)) {
          // Unknown state = FAIL: audit the rejection, never transition it.
          appendAudit('review.invalid-state', target, { row }, { row, rejected: true });
          throw new PanelActionError('E_ILLEGAL_STATE', `review 条目状态未知：${currentState}（已审计并拒绝）。`, 409, { state: currentState });
        }
        if (currentState !== 'pending') {
          throw new PanelActionError('E_ILLEGAL_STATE', `review 条目状态 ${currentState} 不允许 ${action}（仅 pending）。`, 409, { state: currentState });
        }
        const before = { row: { ...row }, state: currentState };
        rows[index] = {
          ...row,
          state: map[action],
          version: row.version + 1,
          decision: { by: actor, at: timestamp, reason: params.reason ?? '' },
        };
        writeReview(rows);
        return { before, after: rows[index], version: rows[index].version, undoable: true };
      }
      case 'review.reopen': {
        const reviewId = params.reviewId ?? target.id;
        const { rows, index, row } = findReviewRow(reviewId);
        if (index < 0) throw new PanelActionError('E_TARGET_INCOMPLETE', `review 条目不存在：${reviewId}`, 404);
        const currentState = currentReviewState(row);
        if (!REVIEW_STATES.includes(currentState)) {
          appendAudit('review.invalid-state', target, { row }, { row, rejected: true });
          throw new PanelActionError('E_ILLEGAL_STATE', `review 条目状态未知：${currentState}（已审计并拒绝）。`, 409, { state: currentState });
        }
        if (currentState !== 'expired') {
          throw new PanelActionError('E_ILLEGAL_STATE', `review.reopen 只允许 expired→pending（当前 ${currentState}）。`, 409, { state: currentState });
        }
        const before = { row: { ...row }, state: currentState };
        rows[index] = {
          ...row,
          state: 'pending',
          version: row.version + 1,
          // Renewed window is anchored to the effective (monotonic) wall, so a
          // wall-clock rollback cannot re-expire/re-open items by itself.
          expiry: new Date(effectiveWallMs() + REVIEW_EXPIRY_MS).toISOString(),
          decision: { by: actor, at: timestamp, reason: params.reason ?? '' },
        };
        writeReview(rows);
        return { before, after: rows[index], version: rows[index].version, undoable: false };
      }
      case 'protect-add': // internal alias, never exposed
      case 'protection.add': {
        const entryId = params.id ?? target.id;
        const protection = readProtection();
        if (protection.entries.some((entry) => entry.id === entryId)) {
          throw new PanelActionError('E_ILLEGAL_STATE', `保护名单已包含 ${entryId}。`, 409);
        }
        const before = { protection: { ...protection, entries: protection.entries.map((entry) => ({ ...entry })) } };
        protection.entries.push({
          id: entryId,
          kind: params.kind ?? target.kind ?? 'record',
          reason: params.reason,
          by: actor,
          at: timestamp,
          version: 1,
          salience: Number.isInteger(params.salience) ? params.salience : 3,
          locked: params.locked === true,
        });
        protection.version += 1;
        writeProtection(protection);
        return { before, after: { protection }, version: protection.version, undoable: true };
      }
      case 'protection.remove': {
        const entryId = params.id ?? target.id;
        const protection = readProtection();
        const hit = protection.entries.find((entry) => entry.id === entryId);
        if (!hit) throw new PanelActionError('E_TARGET_INCOMPLETE', `保护名单不存在 ${entryId}。`, 404);
        if (hit.salience === 5 || hit.locked === true || hit.important === true) {
          throw new PanelActionError('E_PROTECTED', `重要事件永禁移除：${entryId}（salience==5/locked/important）。`, 409);
        }
        const before = { protection: { ...protection, entries: protection.entries.map((entry) => ({ ...entry })) } };
        protection.entries = protection.entries.filter((entry) => entry.id !== entryId);
        protection.version += 1;
        writeProtection(protection);
        return { before, after: { protection }, version: protection.version, undoable: true };
      }
      case 'archive': {
        const state = readState();
        const recordId = params.recordId ?? target.recordId ?? target.id;
        const record = state.records[recordId];
        if (!record) throw new PanelActionError('E_TARGET_INCOMPLETE', `记录不存在：${recordId}`, 404);
        const report = params.archiveReport ?? target.archiveReport;
        const before = { record: { ...record } };
        const archiveId = newId('arc');
        state.archives[archiveId] = {
          id: archiveId,
          recordId,
          report,
          state: 'archived',
          createdAt: timestamp,
        };
        state.records[recordId] = { ...record, state: 'archived', version: (record.version ?? 1) + 1, archiveId };
        writeState(state);
        try {
          writeJsonAtomic(path.join(tombstonesDir, `${archiveId}.json`), state.archives[archiveId]);
        } catch {
          /* private best effort; state is the source of truth for undo */
        }
        return { before, after: { record: state.records[recordId], archive: state.archives[archiveId] }, version: state.records[recordId].version, undoable: true, extra: { archiveId } };
      }
      case 'restore': {
        const state = readState();
        const archiveId = params.archiveId ?? target.id;
        const archive = state.archives[archiveId];
        if (!archive) throw new PanelActionError('E_TARGET_INCOMPLETE', `归档不存在：${archiveId}`, 404);
        const record = state.records[archive.recordId];
        if (!record) throw new PanelActionError('E_TARGET_INCOMPLETE', `归档指向的记录不存在：${archive.recordId}`, 404);
        const before = { record: { ...record }, archive: { ...archive } };
        state.records[archive.recordId] = { ...record, state: 'restored', version: (record.version ?? 1) + 1 };
        state.archives[archiveId] = { ...archive, state: 'restored', restoredAt: timestamp };
        writeState(state);
        return { before, after: { record: state.records[archive.recordId], archive: state.archives[archiveId] }, version: state.records[archive.recordId].version, undoable: false };
      }
      case 'promote': {
        const state = readState();
        const distillId = params.distillId ?? target.id;
        const distill = state.distills[distillId];
        if (!distill) throw new PanelActionError('E_TARGET_INCOMPLETE', `distill 不存在：${distillId}`, 404);
        const recordId = newId('rec');
        const before = { record: null, distill: { ...distill } };
        state.records[recordId] = {
          id: recordId,
          kind: params.targetKind ?? 'memory',
          version: 1,
          state: 'active',
          derivedFrom: distillId,
          createdAt: timestamp,
        };
        writeState(state);
        return { before, after: { record: state.records[recordId] }, version: 1, undoable: true, extra: { recordId } };
      }
      case 'merge': {
        const state = readState();
        const eventIds = params.eventIds ?? target.eventIds;
        const primaryId = params.primaryId ?? target.primaryId;
        const recordId = newId('rec');
        const before = { record: null };
        state.records[recordId] = {
          id: recordId,
          kind: 'merge',
          version: 1,
          state: 'active',
          eventIds,
          primaryId,
          createdAt: timestamp,
        };
        writeState(state);
        return { before, after: { record: state.records[recordId] }, version: 1, undoable: true, extra: { recordId } };
      }
      case 'distill': {
        const state = readState();
        const sourceIds = params.sourceIds ?? target.sourceIds;
        const distillId = newId('dst');
        const payload = {
          id: distillId,
          sources: sourceIds,
          mode: 'extractive',
          derivedFrom: sourceIds,
          version: 1,
          createdAt: timestamp,
        };
        state.distills[distillId] = { ...payload, state: 'active' };
        writeState(state);
        try {
          writeJsonAtomic(path.join(distillDir, `${distillId}.json`), payload);
        } catch {
          /* private best effort */
        }
        return { before: { distill: null }, after: { distill: state.distills[distillId] }, version: 1, undoable: true, extra: { distillId } };
      }
      case 'distill.rollback': {
        const state = readState();
        const distillId = params.distillId ?? target.id;
        const distill = state.distills[distillId];
        if (!distill) throw new PanelActionError('E_TARGET_INCOMPLETE', `distill 不存在：${distillId}`, 404);
        const before = { distill: { ...distill } };
        state.distills[distillId] = { ...distill, state: 'rolled_back', version: (distill.version ?? 1) + 1, rolledBackAt: timestamp };
        writeState(state);
        try {
          fs.rmSync(path.join(distillDir, `${distillId}.json`), { force: true });
        } catch {
          /* private best effort */
        }
        return { before, after: { distill: state.distills[distillId] }, version: state.distills[distillId].version, undoable: false };
      }
      case 'annotate': {
        const note = {
          id: newId('ann'),
          target: auditTarget(target),
          note: params.note,
          visibility: params.visibility ?? 'panel',
          by: actor,
          at: timestamp,
        };
        writeJsonAtomic(path.join(base, 'annotations.latest.json'), note);
        try {
          fs.appendFileSync(annotationsFile, `${JSON.stringify(note)}\n`, 'utf8');
        } catch {
          /* annotations are additive best effort */
        }
        return { before: { note: null }, after: { note }, version: null, undoable: false };
      }
      case 'apply': {
        const state = readState();
        const recordId = params.applyId ?? target.id;
        const record = state.records[recordId];
        if (!record) throw new PanelActionError('E_TARGET_INCOMPLETE', `待应用记录不存在：${recordId}`, 404);
        const before = { record: { ...record } };
        state.records[recordId] = { ...record, state: 'applied', version: (record.version ?? 1) + 1 };
        writeState(state);
        return { before, after: { record: state.records[recordId] }, version: state.records[recordId].version, undoable: true };
      }
      case 'conflict.arbitrate': {
        const claimA = params.claimA ?? target.claimA;
        const claimB = params.claimB ?? target.claimB;
        const resolution = params.resolution ?? target.resolution;
        const existing = readConflictState().items[conflictKey(claimA, claimB)];
        const before = { conflict: existing ? { ...existing } : { claimA, claimB, resolution: null, version: 0 } };
        const result = resolveConflictEffect(claimA, claimB, resolution, actor);
        return {
          before,
          after: { conflict: result.next },
          version: result.next.version,
          undoable: true,
          extra: { conflictKey: result.key, claimA, claimB },
        };
      }
      case 'relationship.update': {
        const personId = params.personId ?? target.personId ?? target.id;
        const result = updateRelationship({
          memoryRoot,
          personId,
          tier: params.tier ?? target.tier,
          reason: params.reason,
          expectedVersion: currentVersionOf('relationship.update', target, params),
          actor,
          appellations: params.appellations,
          edges: params.edges,
          now,
          auditKey: roleAuditKey,
        });
        return {
          before: { relationship: { personId, tier: result.previous.tier, version: result.previous.version } },
          after: { relationship: { personId, tier: result.node.tier, version: result.node.version } },
          version: result.node.version,
          undoable: true,
          extra: { personId, auditSeq: result.auditSeq },
        };
      }
      case 'undo': {
        throw new PanelActionError('E_ACTION_UNKNOWN', 'undo 请使用 POST /api/longlive/actions/undo。', 400);
      }
      default:
        throw new PanelActionError('E_ACTION_UNKNOWN', `未知动作：${action}`, 400);
    }
  }

  function inverseEffect(action, record) {
    switch (action) {
      case 'approve':
      case 'reject':
      case 'return': {
        const itemId = record.params.itemId ?? record.target.id;
        const { rows, index, row } = findReviewRow(itemId);
        if (index < 0 || !row) throw new PanelActionError('E_TARGET_INCOMPLETE', `review 条目不存在：${itemId}`, 404);
        const restoredState = record.effect.before.state;
        rows[index] = {
          ...row,
          state: restoredState,
          version: row.version + 1,
          decision: { by: 'host', at: nowIso(now), reason: 'undo' },
        };
        writeReview(rows);
        return { rows };
      }
      case 'protection.add': {
        const entryId = record.params.id ?? record.target.id;
        const protection = readProtection();
        protection.entries = protection.entries.filter((entry) => entry.id !== entryId);
        protection.version += 1;
        writeProtection(protection);
        return { protection };
      }
      case 'protection.remove': {
        const beforeEntries = record.effect.before.protection.entries;
        const protection = readProtection();
        protection.entries = beforeEntries;
        protection.version += 1;
        writeProtection(protection);
        return { protection };
      }
      case 'archive': {
        const state = readState();
        const archiveId = record.effect.after.archive.id;
        const archive = state.archives[archiveId];
        if (archive) {
          state.records[archive.recordId] = { ...record.effect.before.record, version: (record.effect.before.record.version ?? 1) + 1, state: 'restored' };
          state.archives[archiveId] = { ...archive, state: 'restored', restoredAt: nowIso(now) };
          writeState(state);
          try {
            fs.rmSync(path.join(tombstonesDir, `${archiveId}.json`), { force: true });
          } catch {
            /* best effort */
          }
        }
        return { state };
      }
      case 'promote':
      case 'merge': {
        const state = readState();
        const recordId = record.effect.extra?.recordId ?? record.effect.after.record?.id;
        if (recordId && state.records[recordId]) {
          state.records[recordId] = { ...state.records[recordId], state: 'rolled_back', version: (state.records[recordId].version ?? 1) + 1 };
          writeState(state);
        }
        return { state };
      }
      case 'distill': {
        const state = readState();
        const distillId = record.effect.extra?.distillId ?? record.effect.after.distill?.id;
        if (distillId && state.distills[distillId]) {
          state.distills[distillId] = { ...state.distills[distillId], state: 'undone', version: (state.distills[distillId].version ?? 1) + 1 };
          writeState(state);
          try {
            fs.rmSync(path.join(distillDir, `${distillId}.json`), { force: true });
          } catch {
            /* best effort */
          }
        }
        return { state };
      }
      case 'conflict.arbitrate': {
        const params = record.params ?? {};
        const claimA = params.claimA ?? record.target?.claimA;
        const claimB = params.claimB ?? record.target?.claimB;
        const before = record.effect?.before?.conflict ?? null;
        const state = readConflictState();
        const key = conflictKey(claimA, claimB);
        if (before && before.resolution) {
          state.items[key] = { ...before, version: (before.version ?? 0) + 1, resolvedAt: nowIso(now), actor: 'host', arbitrationOnly: true };
        } else {
          delete state.items[key];
        }
        state.version = (Number.isInteger(state.version) ? state.version : 0) + 1;
        writeConflictState(state);
        return { conflicts: state };
      }
      case 'relationship.update': {
        const params = record.params ?? {};
        const personId = params.personId ?? record.target?.personId ?? record.target?.id;
        const previousTier = record.effect?.before?.relationship?.tier ?? 'stranger';
        const restored = restoreRelationship({
          memoryRoot,
          personId,
          tier: previousTier,
          reason: '按审计记录回退 relationship.update（undo）。',
          expectedVersion: currentVersionOf('relationship.update', record.target ?? {}, params),
          actor: 'host',
          now,
          auditKey: roleAuditKey,
        });
        return { relationship: restored.node };
      }
      case 'restore':
      case 'annotate':
      case 'dry-run':
      case 'distill.rollback':
      case 'review.reopen':
      case 'undo':
        throw new PanelActionError('E_UNDO_NOT_ALLOWED', `${action} 不可 undo。`, 400);
      default:
        throw new PanelActionError('E_ACTION_UNKNOWN', `未知动作：${action}`, 400);
    }
  }

  function preview(request, body = {}) {
    const identity = gate(request);
    const action = body.action;
    const target = body.target ?? {};
    const params = body.params ?? {};
    validateActionParams(action, target, params);
    const timestamp = nowIso(now);
    if (action === 'dry-run') {
      const plan = planDiffFor(params.action, target, params);
      const auditRecord = appendAudit('dry-run', target, plan.diff.before, plan.diff.after);
      return {
        ok: true,
        dryRun: true,
        action: params.action,
        diff: plan.diff,
        risks: plan.risks,
        auditSeq: auditRecord.seq,
        actor: identity.actor,
      };
    }
    const plan = planDiffFor(action, target, params);
    const currentVersion = currentVersionOf(action, target, params);
    const previewId = newId('pvw');
    const expiresMono = monoNow() + PREVIEW_TTL_MS;
    // Display-only wall timestamp derived from the boot-anchored effective wall.
    const expiresAt = new Date(effectiveWallMs() + PREVIEW_TTL_MS).toISOString();
    previews.set(previewId, {
      action,
      target,
      params,
      diff: plan.diff,
      risks: plan.risks,
      currentVersion,
      actor: identity.actor,
      createdAt: timestamp,
      expiresAt,
      expiresMono,
    });
    return {
      ok: true,
      previewId,
      action,
      diff: plan.diff,
      risks: plan.risks,
      expiresAt,
      actor: identity.actor,
      currentVersion,
    };
  }

  function apply(request, body = {}) {
    const identity = gate(request);
    const replay = idempotentReplay(body.idempotencyKey);
    if (replay) return replay;
    const previewId = typeof body.previewId === 'string' ? body.previewId : '';
    const previewEntry = previews.get(previewId);
    if (!previewEntry) throw new PanelActionError('E_PREVIEW_UNKNOWN', 'previewId 不存在或已使用。', 409);
    // Monotonic TTL: wall-clock rollback cannot revive an expired preview and a
    // forward jump cannot expire it early.
    if (Number.isFinite(previewEntry.expiresMono) && monoNow() > previewEntry.expiresMono) {
      previews.delete(previewId);
      throw new PanelActionError('E_PREVIEW_EXPIRED', 'preview 已过期（60s TTL），请重新 preview。', 409);
    }
    previews.delete(previewId);
    const expectedVersion = parseVersion(body.expectedVersion);
    const { action, target, params } = previewEntry;
    if (action === 'undo') throw new PanelActionError('E_ACTION_UNKNOWN', 'undo 请使用 POST /api/longlive/actions/undo。', 400);
    assertCas(action, target, params, expectedVersion);
    let effect;
    try {
      effect = applyEffect(action, target, params, identity.actor);
    } catch (error) {
      if (error instanceof PanelActionError) throw error;
      throw new PanelActionError('E_ACTION_FAILED', error?.message ?? String(error), 500);
    }
    const actionId = newId('act');
    const auditRecord = appendAudit(action, target, effect.before, effect.after);
    const record = {
      actionId,
      action,
      target: auditTarget(target),
      before: effect.before,
      after: effect.after,
      effect,
      params,
      actor: identity.actor,
      state: 'applied',
      undoable: effect.undoable !== false && !NOT_UNDOABLE.has(action),
      undoExpiresMono: monoNow() + UNDO_TTL_MS,
      undoExpiresAt: new Date(effectiveWallMs() + UNDO_TTL_MS).toISOString(),
      auditSeq: auditRecord.seq,
      createdAt: nowIso(now),
      newVersion: effect.version,
    };
    recordAction(record);
    const result = {
      ok: true,
      actionId,
      status: 'applied',
      newVersion: record.newVersion,
      auditSeq: auditRecord.seq,
      replayed: false,
      actor: identity.actor,
    };
    rememberIdempotent(body.idempotencyKey, result);
    try {
      fs.appendFileSync(queueFile, `${JSON.stringify({ actionId, action, at: record.createdAt, status: 'applied', auditSeq: auditRecord.seq })}\n`, 'utf8');
    } catch {
      /* queue is a replay aid; audit is the source of truth */
    }
    return result;
  }

  function undo(request, body = {}) {
    const identity = gate(request);
    const replay = idempotentReplay(body.idempotencyKey);
    if (replay) return replay;
    const actionId = typeof body.actionId === 'string' ? body.actionId : '';
    const record = readAction(actionId);
    if (!record) throw new PanelActionError('E_ACTION_UNKNOWN', `动作不存在：${actionId}`, 404);
    if (record.state === 'undone') throw new PanelActionError('E_ILLEGAL_STATE', '该动作已 undo 过（不可再 undo）。', 409);
    if (record.undoable !== true) throw new PanelActionError('E_UNDO_NOT_ALLOWED', `${record.action} 不可 undo。`, 400);
    // Monotonic undo window: wall-clock rollback cannot revive an expired undo.
    if (!Number.isFinite(record.undoExpiresMono) || monoNow() > record.undoExpiresMono) {
      throw new PanelActionError('E_UNDO_EXPIRED', 'undo 窗口已过（24h）。', 409);
    }
    let effect;
    try {
      effect = inverseEffect(record.action, record);
    } catch (error) {
      if (error instanceof PanelActionError) throw error;
      throw new PanelActionError('E_ACTION_FAILED', error?.message ?? String(error), 500);
    }
    const auditRecord = appendAudit('undo', record.target, { action: record.action }, { action: record.action, undone: true });
    const state = readState();
    state.actionRecords[actionId] = { ...record, state: 'undone', undoneAt: nowIso(now), undoAuditSeq: auditRecord.seq };
    writeState(state);
    const result = {
      ok: true,
      actionId,
      status: 'undone',
      auditSeq: auditRecord.seq,
      replayed: false,
      actor: identity.actor,
      undoEffect: effect,
    };
    rememberIdempotent(body.idempotencyKey, result);
    return result;
  }

  function listActions(request, query = {}) {
    gate(request);
    const state = query.state;
    const { rows } = readReview();
    const normalized = rows.map((row) => ({ ...row, state: currentReviewState(row) }));
    const filtered = typeof state === 'string' && state !== '' ? normalized.filter((row) => row.state === state) : normalized;
    return { ok: true, schema: REVIEW_SCHEMA, items: filtered, total: filtered.length };
  }

  function readAudit(request, query = {}) {
    gate(request);
    const rows = audit.readAll();
    const verified = audit.verify(rows.rows);
    const since = Number.isInteger(query.seqSince) ? query.seqSince : (Number.parseInt(String(query.seqSince ?? ''), 10) || 0);
    const entries = rows.rows.filter((row) => Number.isInteger(row?.seq) && row.seq > since);
    return {
      ok: true,
      schema: 'audit/v1',
      chainOk: verified.ok,
      brokenAt: verified.ok ? null : verified.at,
      entries,
      lastSeq: verified.ok ? verified.lastSeq : null,
    };
  }

  function writeEvidence(request, pkg) {
    gate(request);
    if (!evidence || typeof evidence.submitSigned !== 'function') {
      throw new PanelActionError('E_NO_CAP', 'evidence 写入路径未装配。', 401);
    }
    const signature = hmacForEvidence(pkg);
    try {
      return evidence.submitSigned({ pkg, signature });
    } catch (error) {
      if (error instanceof EvidenceError) {
        throw new PanelActionError(error.code, error.message, error.status ?? 403);
      }
      throw error;
    }
  }

  // Host-internal: evidence signing goes through the same in-memory key the
  // audit chain uses; the model-facing `submitSigned` path never sees it.
  function hmacForEvidence(pkg) {
    if (!evidence || typeof evidence.signPackage !== 'function') {
      throw new PanelActionError('E_NO_CAP', 'evidence 签名 key 不可用。', 401);
    }
    return evidence.signPackage(pkg);
  }

  return {
    preview,
    apply,
    undo,
    listActions,
    readAudit,
    writeEvidence,
    // test seams
    previews,
    idempotency,
    reviewFile,
    queueFile,
    stateFile,
    now,
    previewTtlMs: PREVIEW_TTL_MS,
    undoWindowMs: UNDO_TTL_MS,
  };
}
