// src/ui/routes-readonly.js — M2-F 面板只读数据面（16 条 /api/longlive/*）
//
// 契约（MEMORY-RECALL-V2-PROPOSAL v2.6.3 §12.3 / §12.7-G2/G3/G4 / §12.11-R9）：
//   16 条只读路由，全部过同一道能力令牌门（panel-auth），面板只走 HTTP、
//   不直连 SQLite、不读 `.longlive/` 之外的路径。
//   #16 GET /api/longlive/integrity 返回 R8 manifest 校验状态；ok=false 时
//   **只读展示保留**，动作面由 actions.js 判 401 E_PANEL_INTEGRITY。
//
// 本模块可在无宿主环境直接构造（契约测试用 createReadonlyRouter + handle）；
// 宿主接线见 registerReadonlyRoutes（复用 src/ui/routes.js 的 ctx.inject 模式）。
// 数据文件缺失一律给 `present:false` 空态，绝不抛错、绝不新增文件。

import fs from 'node:fs';
import path from 'node:path';

import { listRecords } from '../memory/records.js';
import { unifiedConflicts } from '../memory/conflicts.js';
import { readEvidenceChain } from '../memory/evidence-chain.js';
import { listBanks, readClaims } from '../memory/governance.js';
import { appendAuditRecord, normalizeAuditRecordRow } from '../memory/audit-records.js';
import { readPrestepSummary } from '../metrics/store.mjs';
import { readChannels } from '../role/channels.js';
import { readAttentionView, readPersonalityView, readRelationshipsView } from '../role/readers.js';

import { REVIEW_SCHEMA, normalizeReviewRow } from './actions.js';

export const READONLY_SCHEMA_VERSION = 1;
export const READONLY_BODY_LIMIT = 16 * 1024;
export const EVENTS_LIMIT_MAX = 200;
export const LOG_LIMIT_MAX = 200;

/** Producer module that will fill each file in later M2 slices (Gate-1 honesty). */
/** R4 P1-6：27 条只读路由的显式 id 预留表（先冻结名字与 id，实现按表注册，不改号段）。 */
export const ROUTE_ID_BY_NAME = Object.freeze({
  flags: 1,
  board: 2,
  status: 3,
  live: 4,
  activity: 5,
  'evidence/latest': 6,
  gap: 7,
  'recall-log': 8,
  'write-health': 9,
  review: 10,
  events: 11,
  distill: 12,
  archive: 13,
  protection: 14,
  'anchor/:anchorId': 15,
  integrity: 16,
  records: 17,
  // 18–23 activity-writer（治理/连续性）：claims / evidence/:claimId / banks / conflicts / audit/records / frames
  claims: 18,
  'evidence/:claimId': 19,
  banks: 20,
  conflicts: 21,
  'audit/records': 22,
  frames: 23,
  // 24–26 state-truth（角色内核）：attention / relationships / personality
  attention: 24,
  relationships: 25,
  personality: 26,
  // 27 release-check：channels
  channels: 27,
})

export const READONLY_ROUTES = Object.freeze([
  { id: 1, path: '/api/longlive/flags', schema: 'flags/v1', producer: 'src/ui/flags.js + host configEditor', dynamic: false },
  { id: 2, path: '/api/longlive/board', schema: 'board/v1', producer: 'src/activity/index.js', dynamic: false },
  { id: 3, path: '/api/longlive/status', schema: 'status/v1', producer: 'src/engine-status.js + src/heartbeat.js', dynamic: false },
  { id: 4, path: '/api/longlive/live', schema: 'live/v1', producer: 'src/live.js + heartbeat', dynamic: false },
  { id: 5, path: '/api/longlive/activity', schema: 'activity/v1', producer: 'src/activity/store.js', dynamic: false },
  { id: 6, path: '/api/longlive/evidence/latest', schema: 'evidence-package/v1', producer: 'M2-C pre-step recall pipeline', dynamic: false },
  { id: 7, path: '/api/longlive/gap', schema: 'gap/v1', producer: 'M2-B lifecycle/gap-clocks.js', dynamic: false },
  { id: 8, path: '/api/longlive/recall-log', schema: 'recall-log/v1', producer: 'M2-C recall pipeline', dynamic: false },
  { id: 9, path: '/api/longlive/write-health', schema: 'write-health/v1', producer: 'M2-B capture writer', dynamic: false },
  { id: 10, path: '/api/longlive/review', schema: 'review/v1', producer: 'M2-D maintenance/review queue', dynamic: false },
  { id: 11, path: '/api/longlive/events', schema: 'events/v1', producer: 'M2-A event index', dynamic: false },
  { id: 12, path: '/api/longlive/distill', schema: 'distill/v1', producer: 'M2-D distiller', dynamic: false },
  { id: 13, path: '/api/longlive/archive', schema: 'archive/v1', producer: 'M2-D forget/archive flow', dynamic: false },
  { id: 14, path: '/api/longlive/protection', schema: 'protection/v1', producer: 'M2-B protection predicate writer', dynamic: false },
  { id: 15, path: '/api/longlive/anchor/:anchorId', schema: 'anchor/v1', producer: 'M2-A/M2-C anchor liveness', dynamic: true },
  { id: 16, path: '/api/longlive/integrity', schema: 'integrity/v1', producer: 'host package manager + loader verifier', dynamic: false },
  { id: 17, path: '/api/longlive/records', schema: 'records/v1', producer: 'M2-B records writer（evidence[]/sourceTier/conflict）', dynamic: false },
  { id: 18, path: '/api/longlive/claims', schema: 'claims/v1', producer: 'M2-B governance.js readClaims', dynamic: false },
  { id: 19, path: '/api/longlive/evidence/:claimId', schema: 'evidence-chain/v1', producer: 'M2-B evidence-chain.js', dynamic: true },
  { id: 20, path: '/api/longlive/banks', schema: 'banks/v1', producer: 'M2-B governance.js listBanks', dynamic: false },
  { id: 21, path: '/api/longlive/conflicts', schema: 'conflicts/v1', producer: 'M2-B conflicts.js unifiedConflicts', dynamic: false },
  { id: 22, path: '/api/longlive/audit/records', schema: 'audit-records/v1', producer: 'M2-B read/write audit（.longlive/audit/records.jsonl）', dynamic: false },
  { id: 23, path: '/api/longlive/frames', schema: 'frames/v1', producer: 'M2-B working-frame frame stack', dynamic: false },
  // #24–#26 角色内核（v2.8 §16.3；state-truth 生产者：src/role/*）。
  { id: 24, path: '/api/longlive/attention', schema: 'attention/v1', producer: 'src/role/attention.js（state-truth）', dynamic: false },
  { id: 25, path: '/api/longlive/relationships', schema: 'relationships/v1', producer: 'src/role/relationships.js（state-truth）', dynamic: false },
  { id: 26, path: '/api/longlive/personality', schema: 'personality/v1', producer: 'src/role/personality.js（state-truth）', dynamic: false },
  // #27 channels：release-check 注册（state-truth 只提供 src/role/channels.js#readChannels 读取器）。
  { id: 27, path: '/api/longlive/channels', schema: 'channels/v1', producer: 'src/role/channels.js#readChannels（state-truth 读取器）+ release-check 注册 #27', dynamic: false },
]);

/** G3 detail route lives under #12 (one logical route, exact list + `/<id>`). */
export const DISTILL_DETAIL_PREFIX = '/api/longlive/distill/';
export const ANCHOR_DETAIL_PREFIX = '/api/longlive/anchor/';
export const EVIDENCE_DETAIL_PREFIX = '/api/longlive/evidence/';

export class ReadonlyRouteError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ReadonlyRouteError';
    this.code = code;
    this.status = status;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return { ok: false, code: 'ENOENT' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: 'E_PARSE' };
  }
}

function readJsonlLimited(file, limit) {
  const text = readText(file);
  if (text === null) return { present: false, rows: [], bad: 0 };
  const rows = [];
  let bad = 0;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  const max = Number.isInteger(limit) && limit > 0 ? limit : LOG_LIMIT_MAX;
  return { present: true, rows: rows.slice(-max), bad };
}

function readJsonDir(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { present: false, files: [], rows: [] };
  }
  const files = names.filter((name) => name.endsWith('.json')).sort();
  const rows = [];
  for (const name of files) {
    const read = readJson(path.join(dir, name));
    if (read.ok && read.value && typeof read.value === 'object') rows.push(read.value);
  }
  return { present: files.length > 0, files, rows };
}

function listLiveRows(memoryRoot) {
  return readJsonDir(path.join(String(memoryRoot ?? ''), '.longlive', 'live')).rows;
}

function boardRows(memoryRoot, limit = 500) {
  const read = readJsonlLimited(path.join(String(memoryRoot ?? ''), '.longlive', 'board', 'activity.jsonl'), limit);
  const rows = read.rows.filter((row) => row && Number.isInteger(row.seq) && typeof row.sessionId === 'string');
  rows.sort((a, b) => a.seq - b.seq);
  return { ...read, rows };
}

function createDefaultReaders(options) {
  const memoryRoot = options.memoryRoot;
  // §16.8 A：角色层 HMAC 侧车可能由 panel auditKey 或 host key file 任一写成；
  // 路由读透传宿主 auditKey（缺省走 key file），校验失败时 fail-safe 降级。
  const auditKey = options.auditKey ?? null;
  const now = options.now;
  const base = path.join(String(memoryRoot ?? ''), '.longlive');
  return {
    flags: () => (typeof options.flagsSnapshot === 'function'
      ? options.flagsSnapshot()
      : { schema: 'flags/v1', flags: {}, writable: false, note: 'host configEditor 未装配（测试/无宿主形态）' }),
    board: () => {
      const read = boardRows(memoryRoot);
      return {
        schema: 'board/v1',
        present: read.present,
        rows: read.rows,
        badLines: read.bad,
        maxSeq: read.rows.reduce((max, row) => (row.seq > max ? row.seq : max), 0),
      };
    },
    status: () => {
      const rows = listLiveRows(memoryRoot);
      return { schema: 'status/v1', present: rows.length > 0, sessions: rows, counts: { sessions: rows.length } };
    },
    live: () => {
      const rows = listLiveRows(memoryRoot);
      return { schema: 'live/v1', present: rows.length > 0, rows };
    },
    activity: () => {
      const board = boardRows(memoryRoot);
      const live = listLiveRows(memoryRoot);
      const bySession = new Map();
      for (const row of live) {
        const id = typeof row?.sessionId === 'string' ? row.sessionId : null;
        if (id === null) continue;
        bySession.set(id, { sessionId: id, goal: row.goal ?? null, state: row.state ?? null, lastAt: row.updatedAt ?? null, items: [] });
      }
      for (const row of board.rows.filter((item) => item.archived !== true).slice(-5)) {
        const id = row.sessionId;
        const entry = bySession.get(id) ?? { sessionId: id, goal: null, state: null, lastAt: null, items: [] };
        entry.items.push({ seq: row.seq, kind: row.kind, text: row.text, at: row.last_at ?? row.at });
        bySession.set(id, entry);
      }
      return { schema: 'activity/v1', present: bySession.size > 0, sessions: [...bySession.values()] };
    },
    evidenceLatest: () => {
      const read = readJson(path.join(base, 'evidence', 'latest.json'));
      if (!read.ok) return { schema: 'evidence-package/v1', present: false, code: read.code };
      const value = read.value ?? {};
      return {
        schema: 'evidence-package/v1',
        present: true,
        package: value.package ?? null,
        packageSha256: value.packageSha256 ?? null,
        writtenAt: value.writtenAt ?? null,
      };
    },
    gap: () => {
      const read = readJson(path.join(base, 'gap', 'latest.json'));
      if (!read.ok) return { schema: 'gap/v1', present: false, code: read.code };
      return { schema: 'gap/v1', present: true, ...read.value };
    },
    recallLog: (query) => {
      const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), LOG_LIMIT_MAX) : LOG_LIMIT_MAX;
      const read = readJsonlLimited(path.join(base, 'recall', 'log.jsonl'), limit);
      return { schema: 'recall-log/v1', present: read.present, entries: read.rows, badLines: read.bad };
    },
    writeHealth: () => {
      // B3: pre-step latency attribution lives next to write-health (read-only summary).
      const prestep = readPrestepSummary({ memoryRoot });
      const read = readJson(path.join(base, 'metrics', 'write-health.json'));
      if (!read.ok) return { schema: 'write-health/v1', present: false, code: read.code, prestep };
      return { schema: 'write-health/v1', present: true, ...read.value, prestep };
    },
    review: () => {
      const read = readJsonlLimited(path.join(base, 'review', 'queue.jsonl'), 500);
      const items = read.rows.map((row) => normalizeReviewRow(row));
      return { schema: REVIEW_SCHEMA, present: read.present, items, badLines: read.bad };
    },
    events: (query) => {
      if (typeof options.eventsReader === 'function') {
        const out = options.eventsReader(query);
        return { schema: 'events/v1', present: true, ...(out ?? {}) };
      }
      return {
        schema: 'events/v1',
        present: false,
        events: [],
        reason: 'E_EVENTS_INDEX_NOT_BUILT',
        note: 'M2-A 事件索引未建（Gate-1 只交付契约层，不直连 SQLite）。',
      };
    },
    distill: (query) => {
      const read = readJsonDir(path.join(base, 'distill'));
      const id = typeof query.id === 'string' ? query.id : '';
      if (id !== '') {
        const hit = read.rows.find((row) => row?.id === id);
        if (!hit) return { schema: 'distill/v1', present: false, code: 'E_DISTILL_NOT_FOUND' };
        return { schema: 'distill/v1', present: true, distill: hit };
      }
      return { schema: 'distill/v1', present: read.present, items: read.rows };
    },
    archive: () => {
      const dirRead = readJsonDir(path.join(base, 'archive', 'tombstones'));
      const tombstones = readText(path.join(String(memoryRoot ?? ''), 'tombstones.md'));
      const entries = dirRead.rows;
      return {
        schema: 'archive/v1',
        present: entries.length > 0 || (tombstones !== null && tombstones.trim() !== ''),
        entries,
        tombstonesPresent: tombstones !== null,
      };
    },
    protection: () => {
      const read = readJson(path.join(base, 'protected.json'));
      if (!read.ok) return { schema: 'protection/v1', present: false, default: 'protect', entries: [], version: 1 };
      const value = read.value ?? {};
      return {
        schema: 'protection/v1',
        present: true,
        default: value.default === 'protect' ? 'protect' : (value.default ?? 'protect'),
        version: Number.isInteger(value.version) ? value.version : 1,
        entries: Array.isArray(value.entries) ? value.entries : [],
      };
    },
    anchor: (params) => {
      const anchorId = typeof params.anchorId === 'string' ? params.anchorId : '';
      if (typeof options.anchorResolver === 'function') {
        const hit = options.anchorResolver(anchorId);
        if (!hit) return { schema: 'anchor/v1', present: false, code: 'E_ANCHOR_NOT_FOUND' };
        return { schema: 'anchor/v1', present: true, ...hit };
      }
      const read = readJsonlLimited(path.join(base, 'index', 'anchors.jsonl'), 1000);
      const hit = read.rows.find((row) => row?.anchorId === anchorId);
      if (!hit) return { schema: 'anchor/v1', present: false, code: 'E_ANCHOR_NOT_FOUND' };
      return { schema: 'anchor/v1', present: true, anchor: hit };
    },
    records: (query) => {
      const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), 500) : 200;
      const listed = listRecords({ memoryRoot, limit });
      // EA-15: L5 forgotten/archived rows stay visible as audit metadata but never
      // expose their body text through the panel records view.
      const items = listed.items.map((row) => {
        const state = row?.state;
        if (state === 'forgotten' || state === 'archived') {
          return { ...row, content: null, excerpt: null, body: null, redactedByState: state };
        }
        return row;
      });
      // EA-16/A5: panel record reads are audited (single source: audit/records.jsonl),
      // but only when real rows exist (fresh roots stay side-effect free).
      if (items.length > 0) {
        try {
          appendAuditRecord({ memoryRoot, action: 'read', recordId: null, readerTier: 'host', questionId: 'unknown', expectedTurns: null, answerText: null, extra: { route: '#17 records', total: listed.total } });
        } catch { /* read auditing must never break the panel */ }
      }
      return {
        schema: 'records/v1',
        present: listed.present,
        items,
        total: listed.total,
        conflicts: listed.conflicts,
        conflictsCount: listed.conflicts.length,
        unverified: listed.unverified,
        badLines: listed.badLines,
        ...(listed.present ? {} : { code: 'E_RECORDS_MISSING' }),
      };
    },
    // #18–#23 治理/连续性只读（v2.8 §15.1/§15.2；缺数据一律空态，不 500）。
    claims: (query = {}) => {
      const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), 500) : 200;
      const listed = readClaims({ memoryRoot, actor: { kind: 'host' } });
      const items = listed.items.slice(-limit);
      return { schema: 'claims/v1', present: listed.present, items, total: listed.items.length, badLines: listed.badLines, ...(listed.present ? {} : { code: 'E_CLAIMS_MISSING' }) };
    },
    evidenceChain: (params = {}) => {
      const claimId = typeof params.claimId === 'string' ? params.claimId : '';
      if (claimId === '') return { schema: 'evidence-chain/v1', present: false, code: 'E_CLAIM_ID', lines: [] };
      const chain = readEvidenceChain({ memoryRoot, claimId });
      return { schema: 'evidence-chain/v1', present: chain.present, claimId: chain.claimId, version: chain.version, count: chain.count, head: chain.head, integrityOk: chain.integrityOk, lines: chain.lines, ...(chain.present ? {} : { code: 'E_EVIDENCE_CHAIN_MISSING' }) };
    },
    banks: () => {
      const banks = listBanks({ memoryRoot });
      const custom = banks.filter((bank) => bank.builtin !== true);
      return { schema: 'banks/v1', present: custom.length > 0, items: custom, builtin: banks.filter((bank) => bank.builtin === true), total: banks.length, ...(custom.length > 0 ? {} : { code: 'E_BANKS_EMPTY' }) };
    },
    conflicts: (query = {}) => {
      const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), 500) : 200;
      const unified = unifiedConflicts({ memoryRoot });
      const conflicts = unified.conflicts.slice(0, limit);
      return { schema: 'conflicts/v1', present: unified.entries.length > 0, items: conflicts, entries: unified.entries.slice(0, limit), total: unified.conflicts.length, source: unified.source, ...(unified.entries.length > 0 ? {} : { code: 'E_CONFLICTS_EMPTY' }) };
    },
    auditRecords: (query = {}) => {
      const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), 1000) : 200;
      const read = readJsonlLimited(path.join(base, 'audit', 'records.jsonl'), limit);
      return { schema: 'audit-records/v1', present: read.present, items: read.rows.map((row) => normalizeAuditRecordRow(row)), badLines: read.bad, ...(read.present ? {} : { code: 'E_AUDIT_RECORDS_MISSING' }) };
    },
    frames: (query = {}) => {
      const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), 200) : 50;
      const dir = path.join(base, 'working');
      const items = [];
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.json') || name.startsWith('.')) continue;
          const value = readJson(path.join(dir, name));
          if (!value.ok || !value.value || typeof value.value !== 'object') continue;
          const frame = value.value;
          items.push({
            sessionId: frame.sessionId ?? name.replace(/\.json$/, ''),
            frameId: frame.frameId ?? null,
            frameNo: Number.isInteger(frame.frameNo) ? frame.frameNo : null,
            turnRange: Array.isArray(frame.turnRange) ? frame.turnRange : null,
            focus: frame.focus ?? null,
            ttlMs: Number.isInteger(frame.ttlMs) ? frame.ttlMs : null,
            lastUsedAt: frame.lastUsedAt ?? null,
            state: frame.state ?? null,
          });
        }
      } catch {
        /* missing working dir => honest empty state */
      }
      items.sort((a, b) => String(b.lastUsedAt ?? '').localeCompare(String(a.lastUsedAt ?? '')));
      return { schema: 'frames/v1', present: items.length > 0, items: items.slice(0, limit), total: items.length, ...(items.length > 0 ? {} : { code: 'E_FRAMES_EMPTY' }) };
    },
    // #24–#26 角色内核只读（v2.8 §16.3）：attention / relationships / personality。
    attention: (query = {}) => {
      const limit = Number.isInteger(query.limit) ? Math.min(Math.max(query.limit, 1), 200) : 50;
      return readAttentionView({ memoryRoot, now, limit, auditKey });
    },
    relationships: () => readRelationshipsView({ memoryRoot, now, auditKey }),
    personality: () => readPersonalityView({ memoryRoot, now, auditKey }),
    // #27 channels：只读状态（1.8.0 只做宿主内注册与只读，不接真实 QQ 协议，§16.7）。
    channels: () => readChannels({ memoryRoot, now, auditKey }),
    integrity: () => {
      if (options.integrity && typeof options.integrity.status === 'function') {
        return { schema: 'integrity/v1', ...options.integrity.status() };
      }
      return {
        schema: 'integrity/v1',
        ok: false,
        manifestVersion: null,
        checkedAt: now().toISOString(),
        files: [],
        lastError: 'E_INTEGRITY_NOT_WIRED',
      };
    },
  };
}

/**
 * Create the read-only router (pure, no host wiring).
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {ReturnType<import('./panel-auth.js').createPanelAuth>} options.auth
 * @param {ReturnType<import('./panel-integrity.js').createIntegrityGuard>} [options.integrity]
 * @param {(query:object)=>object} [options.eventsReader]
 * @param {(anchorId:string)=>object|null} [options.anchorResolver]
 * @param {Buffer|string} [options.auditKey] host auditKey for role-layer HMAC sidecars
 * @param {() => object} [options.flagsSnapshot]
 * @param {() => Date} [options.now]
 */
export function createReadonlyRouter(options = {}) {
  const auth = options.auth;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const readers = createDefaultReaders({ ...options, now });

  function gate(request) {
    if (!auth || typeof auth.actionGate !== 'function') {
      throw new ReadonlyRouteError('E_NO_CAP', '宿主权限门未装配。', 401);
    }
    try {
      return auth.actionGate({
        source: request?.source ?? 'http',
        headers: request?.headers ?? {},
        actorKind: request?.actorKind ?? 'host',
      });
    } catch (error) {
      throw new ReadonlyRouteError(error.code ?? 'E_NO_CAP', error.message ?? '权限校验失败。', error.status ?? 401);
    }
  }

  function match(urlPath) {
    for (const route of READONLY_ROUTES) {
      if (!route.dynamic && route.path === urlPath) return { route, params: {}, query: {} };
    }
    const anchorPrefix = ANCHOR_DETAIL_PREFIX;
    if (urlPath.startsWith(anchorPrefix)) {
      const anchorId = decodeURIComponent(urlPath.slice(anchorPrefix.length));
      if (anchorId !== '') {
        return { route: READONLY_ROUTES.find((route) => route.id === 15), params: { anchorId } };
      }
    }
    // G3 distill detail: `/api/longlive/distill/<id>` belongs to logical route
    // #12 (it must not widen the documented route count: 16 -> 17 with #17 records).
    if (urlPath.startsWith(DISTILL_DETAIL_PREFIX) && urlPath.length > DISTILL_DETAIL_PREFIX.length) {
      const distillId = decodeURIComponent(urlPath.slice(DISTILL_DETAIL_PREFIX.length));
      if (distillId !== '' && !distillId.includes('/')) {
        return { route: READONLY_ROUTES.find((route) => route.id === 12), params: { id: distillId }, query: { id: distillId } };
      }
    }
    // #19 evidence chain detail: /api/longlive/evidence/<claimId> (exact /evidence/latest matched first).
    if (urlPath.startsWith(EVIDENCE_DETAIL_PREFIX) && urlPath.length > EVIDENCE_DETAIL_PREFIX.length) {
      const claimId = decodeURIComponent(urlPath.slice(EVIDENCE_DETAIL_PREFIX.length));
      if (claimId !== '' && !claimId.includes('/') && claimId !== 'latest') {
        return { route: READONLY_ROUTES.find((route) => route.id === 19), params: { claimId }, query: {} };
      }
    }
    return null;
  }

  /**
   * Handle one in-process read-only request.
   * @param {{method?:string, path:string, headers?:object, source?:string, actorKind?:string}} request
   * @returns {{status:number, body:object}}
   */
  function handle(request = {}) {
    const method = String(request.method ?? 'GET').toUpperCase();
    const rawPath = String(request.path ?? '');
    let url;
    try {
      url = new URL(rawPath, 'http://longlive.local');
    } catch {
      return { status: 400, body: { ok: false, error: { code: 'E_PATH', message: '非法请求路径。' } } };
    }
    const detail = match(url.pathname);
    const query = { ...(detail?.query ?? {}) };
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return {
        status: 405,
        body: { ok: false, error: { code: 'E_METHOD', message: `只读路由只支持 GET/HEAD（收到 ${method}）。` } },
        headers: { allow: 'GET, HEAD' },
      };
    }
    try {
      gate(request);
    } catch (error) {
      if (error instanceof ReadonlyRouteError) {
        return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
      }
      return { status: 401, body: { ok: false, error: { code: 'E_NO_CAP', message: '权限校验失败。' } } };
    }
    if (detail === null) {
      return { status: 404, body: { ok: false, error: { code: 'E_ROUTE_UNKNOWN', message: `未知只读路由：${url.pathname}` } } };
    }
    if (method === 'HEAD') {
      // HEAD passes the same capability gate; no body (same-origin probes).
      return { status: 200, body: null, headers: { 'content-type': 'application/json; charset=utf-8' } };
    }
    const { route, params } = detail;
    try {
      const data = readRoute(route, params, query);
      return {
        status: 200,
        body: {
          ok: true,
          present: data?.present !== false,
          generatedAt: now().toISOString(),
          ...data,
        },
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      };
    } catch (error) {
      if (error instanceof ReadonlyRouteError) {
        return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
      }
      return { status: 500, body: { ok: false, error: { code: 'E_READONLY_FAILED', message: error?.message ?? String(error) } } };
    }
  }

  /**
   * §16.8 / R4 P1-6：固定 id → handler 显式映射（不依赖数组顺序）。
   * 每条 route id 必须在表里有 handler；缺表 = 启动即抛，避免数组顺序漂移造成串路。
   */
  const HANDLERS_BY_ID = new Map([
    [1, (params, query) => readers.flags()],
    [2, (params, query) => readers.board()],
    [3, (params, query) => readers.status()],
    [4, (params, query) => readers.live()],
    [5, (params, query) => readers.activity()],
    [6, (params, query) => readers.evidenceLatest()],
    [7, (params, query) => readers.gap()],
    [8, (params, query) => readers.recallLog(query)],
    [9, (params, query) => readers.writeHealth()],
    [10, (params, query) => readers.review()],
    [11, (params, query) => readers.events(query)],
    [12, (params, query) => readers.distill(query)],
    [13, (params, query) => readers.archive()],
    [14, (params, query) => readers.protection()],
    [15, (params, query) => readers.anchor(params)],
    [16, (params, query) => readers.integrity()],
    [17, (params, query) => readers.records(query)],
    [18, (params, query) => readers.claims(query)],
    [19, (params) => readers.evidenceChain(params)],
    [20, (params, query) => readers.banks(query)],
    [21, (params, query) => readers.conflicts(query)],
    [22, (params, query) => readers.auditRecords(query)],
    [23, (params, query) => readers.frames(query)],
    [24, (params, query) => readers.attention(query)],
    [25, () => readers.relationships()],
    [26, () => readers.personality()],
    [27, () => readers.channels()],
  ]);
  for (const route of READONLY_ROUTES) {
    if (!HANDLERS_BY_ID.has(route.id)) {
      throw new ReadonlyRouteError('E_ROUTE_HANDLER_MISSING', `只读路由 #${route.id} 没有显式 handler（id 表与 READONLY_ROUTES 不一致）。`, 500);
    }
  }

  function readRoute(route, params, query) {
    const handler = HANDLERS_BY_ID.get(route.id);
    if (typeof handler !== 'function') {
      throw new ReadonlyRouteError('E_ROUTE_UNKNOWN', `未知只读路由 #${route.id}`, 404);
    }
    return handler(params, query);
  }

  return { handle, routes: READONLY_ROUTES, readers };
}

const warned = new Set();
function warnOnce(key, error) {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    console.warn(`[longlive] ${key}: ${error?.stack ?? error?.message ?? String(error)}`);
  } catch {
    /* logging must never break activation */
  }
}

/**
 * Register the 16 read-only routes on the host Web server.
 * A profile without a Web server simply gets no route; activation never depends on it.
 */
export function registerReadonlyRoutes(ctx, options = {}) {
  if (typeof ctx?.inject !== 'function') return false;
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx?.webServer;
      if (webServer === undefined || typeof webServer.register !== 'function') return;
      const router = createReadonlyRouter(options);
      const handleRequest = (req, res) => {
        const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
        const host = String(req?.headers?.host ?? 'longlive.local');
        const urlPath = String(req?.url ?? '/');
        const verdict = router.handle({
          method,
          path: `http://${host}${urlPath}`,
          headers: req?.headers ?? {},
          source: 'http',
        });
        if (verdict.body === null) {
          try {
            res.writeHead(verdict.status, verdict.headers ?? {});
            res.end();
          } catch {
            /* peer gone */
          }
          return;
        }
        const payload = JSON.stringify(verdict.body);
        try {
          res.writeHead(verdict.status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(payload),
            ...(verdict.headers ?? {}),
          });
          res.end(payload);
        } catch {
          try {
            res.destroy?.();
          } catch {
            /* peer gone */
          }
        }
      };
      for (const route of READONLY_ROUTES) {
        const registration = route.dynamic
          ? { kind: 'prefix', path: route.path.replace(/\/:anchorId$/, '/'), handler: handleRequest }
          : { kind: 'exact', path: route.path, handler: handleRequest };
        try {
          const dispose = webServer.register(registration);
          if (typeof dispose === 'function' && typeof webCtx.effect === 'function') {
            try {
              webCtx.effect(() => () => dispose(), `longlive: readonly route ${route.id}`);
            } catch {
              /* fake context without an effect scope */
            }
          }
        } catch (error) {
          warnOnce(`readonly route ${route.id} registration failed`, error);
        }
      }
      // G3 detail route (`/api/longlive/distill/<id>`) is served by a prefix
      // route so it does not widen the documented 16-route count.
      try {
        const dispose = webServer.register({ kind: 'prefix', path: DISTILL_DETAIL_PREFIX, handler: handleRequest });
        if (typeof dispose === 'function' && typeof webCtx.effect === 'function') {
          try {
            webCtx.effect(() => () => dispose(), 'longlive: distill detail route');
          } catch {
            /* fake context */
          }
        }
      } catch (error) {
        warnOnce('distill detail route registration failed', error);
      }
    });
    return true;
  } catch (error) {
    warnOnce('readonly route inject failed', error);
    return false;
  }
}
