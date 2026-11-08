// src/memory/records.js — M2-B 扩展 / v2.6.4 §14.1：records 数据治理最小集
//
// 每条机器断言（records.jsonl）在原有字段上增加：
//   evidence[]{anchorId, sha256, excerptRef, verifiedAt}   // 0..n，锚点引用
//   sourceTier ∈ user|host|agent|plugin                    // 写入来源分层
//   conflict/conflict_with[]                               // 同 subject 互斥断言标记
//   state ∈ active|superseded|forgotten|archived|restored|unverified
//
// 铁律：
//   * 旧 records 缺字段 → 读时默认 evidence=[] / sourceTier='agent' / state 由 status 推导，不崩；
//   * 写时非法 sourceTier → 拒收 `E_SOURCE_TIER`（读时非法值降级 agent 并标记 tierDefaulted）；
//   * 同 subject 互斥（正反极性，或同 attribute 不同 value）→ 两条都标 conflict + conflict_with；
//     回忆候选返回 conflicts[]，**不静默选一个**；
//   * 读审计：每次 recall/evidence 调用写 `.longlive/recall/log.jsonl` 一行，含 recordId（行数=调用数）。
//
// 纯文件模块（不依赖 SQLite/宿主），可被 #17 只读路由与 M2-C 召回共用。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isNegativeConclusion } from './cards.js';

export const RECORDS_SCHEMA = 'records/v1';
export const SOURCE_TIERS = Object.freeze(['user', 'host', 'agent', 'plugin']);
export const RECORD_STATES = Object.freeze(['active', 'superseded', 'forgotten', 'archived', 'restored', 'unverified']);
export const DEFAULT_SOURCE_TIER = 'agent';
export const AUDIT_SCHEMA = 'recall-log/v1';

export class RecordsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecordsError';
    this.code = code;
  }
}

export function recordsPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot ?? '')), '.longlive', 'records.jsonl');
}

export function recallLogPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot ?? '')), '.longlive', 'recall', 'log.jsonl');
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** R1 anchorId 规则（确定性、索引重建后不变）。 */
export function anchorIdOf(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  if (anchor.kind === 'file_line') {
    return `anc_${sha256Hex(`file|${anchor.rel}|${anchor.lineStart ?? 1}`).slice(0, 16)}`;
  }
  return `anc_${sha256Hex(`${anchor.sessionId ?? ''}|${anchor.turn ?? ''}|${anchor.seqStart ?? ''}`).slice(0, 16)}`;
}

/** Build evidence[] entries from anchors (0..n). */
export function evidenceFromAnchors(anchors, { verifiedAt = null } = {}) {
  if (!Array.isArray(anchors)) return [];
  return anchors
    .filter((anchor) => anchor && typeof anchor === 'object')
    .map((anchor) => ({
      anchorId: anchor.anchorId ?? anchorIdOf(anchor),
      sha256: anchor.digest ?? anchor.fileSha ?? null,
      excerptRef: anchor.kind === 'file_line'
        ? `file:${anchor.rel}:${anchor.lineStart ?? 1}-${anchor.lineEnd ?? anchor.lineStart ?? 1}`
        : `session:${anchor.sessionId ?? ''}#turn${anchor.turn ?? ''}`,
      verifiedAt,
    }))
    .filter((entry) => typeof entry.anchorId === 'string' && entry.anchorId !== '');
}

/** Write-path validation: invalid tier throws (no silent write). */
export function assertSourceTier(value, fallback = DEFAULT_SOURCE_TIER) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!SOURCE_TIERS.includes(value)) throw new RecordsError('E_SOURCE_TIER', `sourceTier 非法：${String(value)}（允许 ${SOURCE_TIERS.join('|')}）`);
  return value;
}

/** Read-path normalization: never throws, defaults are explicit. */
export function normalizeSourceTier(value, fallback = DEFAULT_SOURCE_TIER) {
  if (SOURCE_TIERS.includes(value)) return { sourceTier: value, tierDefaulted: false };
  return { sourceTier: fallback, tierDefaulted: value !== undefined && value !== null && value !== '' };
}

function normalizeState(row) {
  if (RECORD_STATES.includes(row?.state)) return row.state;
  const status = row?.status;
  if (status === 'superseded' || status === 'forgotten' || status === 'archived' || status === 'restored') return status;
  return 'active';
}

/** Read-side normalization (backward compatible with 1.6.8 records). */
export const ANCHOR_ID_RE = /^anc_[0-9a-f]{16}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

const MUTEX_VALUE_GROUPS = Object.freeze([
  Object.freeze(['快速', '安全']),
  Object.freeze(['allow', 'deny']),
  Object.freeze(['允许', '禁止']),
  Object.freeze(['启用', '禁用']),
]);

/** NFKC normalize: full-width digits/quotes/space folded (EA-03). */
export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u3000\s]+/g, ' ').trim();
}

/** Structural validity of one evidence entry (EA-01: fake anchors are invalid). */
export function validateEvidenceEntry(entry) {
  if (!entry || typeof entry !== 'object') return { valid: false, code: 'E_EVIDENCE_NOT_OBJECT' };
  if (typeof entry.anchorId !== 'string' || !ANCHOR_ID_RE.test(entry.anchorId)) return { valid: false, code: 'E_ANCHOR_ID' };
  if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) return { valid: false, code: 'E_SHA256' };
  if (typeof entry.excerptRef !== 'string' || entry.excerptRef.trim() === '') return { valid: false, code: 'E_EXCERPT_REF' };
  return { valid: true, code: 'OK' };
}
export function normalizeRecord(row) {
  const value = row && typeof row === 'object' ? row : {};
  const tier = normalizeSourceTier(value.sourceTier);
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((entry) => entry && typeof entry === 'object').map((entry) => {
      const validity = validateEvidenceEntry(entry);
      return {
        anchorId: typeof entry.anchorId === 'string' ? entry.anchorId : null,
        sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
        excerptRef: typeof entry.excerptRef === 'string' ? entry.excerptRef : null,
        verifiedAt: entry.verifiedAt ?? null,
        valid: validity.valid,
        invalidCode: validity.valid ? null : validity.code,
      };
    })
    : [];
  return {
    id: typeof value.id === 'string' ? value.id : null,
    kind: typeof value.kind === 'string' ? value.kind : 'fact',
    content: typeof value.content === 'string' ? value.content : '',
    subject: typeof value.subject === 'string' && value.subject.trim() !== '' ? value.subject : null,
    attribute: typeof value.attribute === 'string' ? value.attribute : null,
    value: value.value !== undefined ? value.value : null,
    project: value.project ?? null,
    salience: Number.isInteger(value.salience) ? value.salience : 3,
    importance: typeof value.importance === 'number' ? value.importance : 0.5,
    state: normalizeState(value),
    createdAt: value.createdAt ?? null,
    lastUsed: value.lastUsed ?? null,
    useCount: Number.isInteger(value.useCount) ? value.useCount : 0,
    anchors: Array.isArray(value.anchors) ? value.anchors : [],
    evidence,
    sourceTier: tier.sourceTier,
    tierDefaulted: tier.tierDefaulted,
    conflict: value.conflict === true,
    conflict_with: Array.isArray(value.conflict_with) ? value.conflict_with : [],
    supersedes: Array.isArray(value.supersedes) ? value.supersedes : [],
    supersededBy: value.supersededBy ?? null,
    audit: value.audit && typeof value.audit === 'object' ? value.audit : {},
    // C3 扩展：无证据 / 证据结构非法（伪造 anchorId/sha256/excerptRef）=> unverified。
    unverified: evidence.length === 0 || evidence.some((entry) => entry.valid !== true),
    evidenceValid: evidence.length > 0 && evidence.every((entry) => entry.valid === true),
  };
}

function subjectKey(record) {
  const compact = (value) => normalizeText(value).toLowerCase().replace(/\s+/g, '');
  const subject = record.subject;
  if (subject && typeof subject === 'object') {
    const entity = compact(subject.entity);
    const attribute = compact(subject.attribute);
    if (entity === '') return null;
    return attribute === '' ? entity : entity + '::' + attribute;
  }
  const raw = subject ?? record.attribute ?? null;
  const normalized = compact(raw);
  return normalized === '' ? null : normalized;
}

function valueTokens(value) {
  return String(value ?? '').match(/\d+(?:\.\d+)*|[A-Za-z]+/g) ?? [];
}

function attributeOf(entry) {
  if (typeof entry?.attribute === 'string' && entry.attribute.trim() !== '') return entry.attribute;
  if (entry?.subject && typeof entry.subject === 'object' && typeof entry.subject.attribute === 'string') return entry.subject.attribute;
  return null;
}

function sameAttributeDifferentValue(a, b) {
  const attrA = attributeOf(a);
  const attrB = attributeOf(b);
  if (typeof attrA !== 'string' || typeof attrB !== 'string') return false;
  if (normalizeText(attrA).toLowerCase() !== normalizeText(attrB).toLowerCase()) return false;
  const left = normalizeText(a.value ?? a.content).toLowerCase();
  const right = normalizeText(b.value ?? b.content).toLowerCase();
  return left !== right;
}

/** Mutex value groups (EA-03): same subject + one token from opposite members => conflict. */
function mutexValueConflict(a, b) {
  const left = normalizeText(a.content + ' ' + (a.value ?? '')).toLowerCase();
  const right = normalizeText(b.content + ' ' + (b.value ?? '')).toLowerCase();
  for (const group of MUTEX_VALUE_GROUPS) {
    const leftHas = group.filter((token) => left.includes(token.toLowerCase()));
    const rightHas = group.filter((token) => right.includes(token.toLowerCase()));
    if (leftHas.length === 0 || rightHas.length === 0) continue;
    if (!leftHas.some((token) => rightHas.includes(token))) return true;
  }
  return false;
}

/**
 * Detect mutually exclusive assertions (pure; no disk IO).
 * Returns { conflicts:[{idA,idB,subject,why}], byId:Map<id,string[]> }.
 */
export function detectRecordConflicts(records) {
  const list = (Array.isArray(records) ? records : []).filter((record) => record && typeof record.id === 'string'
    && record.state !== 'superseded' && record.state !== 'forgotten');
  const bySubject = new Map();
  for (const record of list) {
    const key = subjectKey(record);
    if (key === null) continue;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(record);
  }
  const conflicts = [];
  const byId = new Map();
  for (const [subject, group] of bySubject) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (a.supersedes?.includes(b.id) || b.supersedes?.includes(a.id)) continue;
        if (a.supersededBy === b.id || b.supersededBy === a.id) continue;
        const opposite = isNegativeConclusion(normalizeText(a.content)) !== isNegativeConclusion(normalizeText(b.content));
        const differentValue = sameAttributeDifferentValue(a, b);
        const mutex = mutexValueConflict(a, b);
        if (!opposite && !differentValue && !mutex) continue;
        const why = opposite ? 'opposite-polarity' : (differentValue ? 'same-attribute-different-value' : 'mutex-value-group');
        conflicts.push({ idA: a.id, idB: b.id, subject, why });
        if (!byId.has(a.id)) byId.set(a.id, []);
        if (!byId.has(b.id)) byId.set(b.id, []);
        byId.get(a.id).push(b.id);
        byId.get(b.id).push(a.id);
      }
    }
  }
  return { conflicts, byId };
}

/** Read all records (read-only) and compute conflicts/unverified/state. */
export function listRecords({ memoryRoot, limit = 200 } = {}) {
  const file = recordsPathOf(memoryRoot);
  const items = [];
  const bad = [];
  let present = false;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
    present = true;
  } catch {
    text = '';
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      bad.push(line.slice(0, 120));
      continue;
    }
    items.push(normalizeRecord(row));
  }
  const { conflicts, byId } = detectRecordConflicts(items);
  for (const item of items) {
    const ids = byId.get(item.id) ?? [];
    item.conflict = ids.length > 0;
    item.conflict_with = ids;
  }
  const limited = Number.isInteger(limit) && limit > 0 ? items.slice(-limit) : items;
  return {
    schema: RECORDS_SCHEMA,
    present,
    items: limited,
    total: items.length,
    conflicts,
    unverified: items.filter((item) => item.unverified).length,
    badLines: bad,
    file,
  };
}

/** Append one audit line (one per recall/evidence call). */
export function appendRecallAudit({ memoryRoot, now = () => new Date(), query = '', recordId = null, recordIds = [], hit = false, conflicts = [], timings = null, source = 'records-query', extra = {} } = {}) {
  const value = typeof now === 'function' ? now() : new Date();
  const at = (value instanceof Date ? value : new Date(value)).toISOString();
  const line = {
    schema: AUDIT_SCHEMA,
    at,
    query: String(query ?? '').slice(0, 500),
    hit: hit === true,
    recordId: recordId ?? (recordIds.length > 0 ? recordIds[0] : null),
    recordIds: Array.isArray(recordIds) ? recordIds.slice(0, 50) : [],
    conflicts: Array.isArray(conflicts) ? conflicts.slice(0, 20) : [],
    source,
    timings: timings && typeof timings === 'object' ? timings : null,
    ...extra,
  };
  fs.mkdirSync(path.dirname(recallLogPathOf(memoryRoot)), { recursive: true });
  fs.appendFileSync(recallLogPathOf(memoryRoot), `${JSON.stringify(line)}\n`, 'utf8');
  return { ok: true, line, file: recallLogPathOf(memoryRoot) };
}

function queryTokens(query) {
  const text = String(query ?? '').toLowerCase();
  const tokens = new Set(text.match(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]{2,4}/g) ?? []);
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.add(chars[i] + chars[i + 1]);
  }
  return [...tokens];
}

/**
 * Minimal records recall (basis for M2-C memory_recall_v2):
 * keyword/bigram match over content, returns candidates + conflicts[] + unverified flags,
 * and writes exactly one audit line per call (hit or not).
 */
export function queryRecords({ memoryRoot, query = '', limit = 10, now = () => new Date(), source = 'records-query' } = {}) {
  const started = Date.now();
  const listed = listRecords({ memoryRoot, limit: 500 });
  const tokens = queryTokens(query);
  const scored = listed.items
    .filter((item) => item.state === 'active')
    .map((item) => {
      const haystack = `${item.content} ${item.subject ?? ''} ${item.kind}`.toLowerCase();
      let score = 0;
      for (const token of tokens) if (haystack.includes(token)) score += 1;
      return { item, score };
    })
    .filter((entry) => tokens.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.createdAt ?? '').localeCompare(String(a.item.createdAt ?? '')));
  const items = scored.slice(0, limit).map((entry) => entry.item);
  const recordIds = items.map((item) => item.id).filter(Boolean);
  const conflictIds = new Set([...items.flatMap((item) => item.conflict_with), ...items.map((item) => item.id)]);
  const conflicts = listed.conflicts.filter((entry) => conflictIds.has(entry.idA) || conflictIds.has(entry.idB));
  appendRecallAudit({
    memoryRoot,
    now,
    query,
    recordId: recordIds[0] ?? null,
    recordIds,
    hit: items.length > 0,
    conflicts,
    timings: { totalMs: Date.now() - started },
    source,
  });
  return {
    schema: RECORDS_SCHEMA,
    query: String(query ?? ''),
    items,
    total: items.length,
    conflicts,
    unverified: items.filter((item) => item.unverified).length,
    code: items.length > 0 ? 'OK' : 'E_RECORDS_NO_MATCH',
  };
}

/** Recompute evidence liveness; returns a copy marked unverified when evidence is gone. */
export function verifyRecordEvidence(record, verifyOne) {
  const base = normalizeRecord(record);
  const results = base.evidence.map((entry) => {
    if (entry.valid !== true) return { ...entry, state: 'invalid' };
    let state = 'missing';
    try {
      state = typeof verifyOne === 'function' ? verifyOne(entry) : 'missing';
    } catch {
      state = 'missing';
    }
    return { ...entry, state };
  });
  const unverified = base.evidence.length === 0 || results.some((entry) => entry.state !== 'live');
  return { ...base, evidenceVerified: results, unverified };
}

/** Derive excerptRef from an anchor object (session_turn / file_line). */
export function excerptRefOf(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  if (anchor.kind === 'file_line') return 'file:' + anchor.rel + ':' + (anchor.lineStart ?? 1) + '-' + (anchor.lineEnd ?? anchor.lineStart ?? 1);
  if (anchor.sessionId !== undefined && anchor.turn !== undefined) return 'session:' + anchor.sessionId + '#turn' + anchor.turn;
  return null;
}

/** Write-path evidence evaluation (EA-01/EA-02): callers cannot self-declare verified. */
export function evaluateEvidenceForWrite(anchors, options = {}) {
  const verifiedAt = options.verifiedAt ?? null;
  const entries = (Array.isArray(anchors) ? anchors : []).map((anchor) => ({
    anchorId: anchor?.anchorId ?? anchorIdOf(anchor),
    sha256: anchor?.digest ?? anchor?.fileSha ?? null,
    excerptRef: excerptRefOf(anchor),
    verifiedAt,
  }));
  const checks = entries.map((entry) => {
    const validity = validateEvidenceEntry(entry);
    return { ...entry, valid: validity.valid, invalidCode: validity.valid ? null : validity.code };
  });
  const results = checks.map((entry) => {
    if (entry.valid !== true) return { ...entry, state: 'invalid' };
    let state = 'unverified';
    try {
      state = typeof options.verifyOne === 'function' ? options.verifyOne(entry) : 'unverified';
    } catch {
      state = 'missing';
    }
    return { ...entry, state };
  });
  return {
    evidence: checks,
    verified: checks.length > 0 && checks.every((entry) => entry.valid),
    verifiedLive: results.length > 0 && results.every((entry) => entry.state === 'live'),
    reasons: checks.filter((entry) => entry.valid !== true).map((entry) => entry.invalidCode),
  };
}

export { sha256Hex };
