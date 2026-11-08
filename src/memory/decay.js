// src/memory/decay.js — M2-D：衰减提案 / 合并（merge）/ 提升（promote）
//
// 设计依据 MEMORY-RECALL-V2-PROPOSAL §4.4（触发：时间衰减/重复合并/consolidation/manual）
// 与 §4.5（merge/distill/promote，无删除）：
//   * 衰减只提案、不直接删：同主题事件 90 天未被任何卡/记录引用 → 可合并为 distill
//     摘要（真正的蒸馏由 distill.js 执行；本模块只出 plan）；
//   * merge：重复 digest/同内容 → 保留 1 条主记录 + 其余登记 duplicateOf；旧卡
//     移到 `archive/merged/`（先备份、rename，不删除）；保护卡/重要事件拒绝合并；
//   * promote：新事实成立 → append 新版本（claimVersion+1、supersedes 链、CAS
//     expectedVersion），旧版本永久保留；rollback 只切 active 指针。
//
// 与 forget.js/retention.js 的接口保持最小：只 import 保护判定与既有记录写入器，
// 不重写它们。

import fs from 'node:fs';
import path from 'node:path';

import { appendAuditRecord } from './audit-records.js';
import { appendRecordLine } from './capture.js';
import { memoryError, relativePath, resolveInside } from './paths.js';
import { isProtectedPath } from './retention.js';
import { appendAudit, backupInto, ensureDir, sha256Text, writeFileAtomic } from './state.js';

export const DECAY_SCHEMA = 'decay/v1';
export const PROMOTE_SCHEMA = 'promote/v1';
export const MERGE_SCHEMA = 'merge/v1';
export const VERSIONS_DIR = '.longlive/versions';
export const MERGE_ARCHIVE_DIR = '.longlive/archive/merged';
export const DECAY_POLICY = Object.freeze({
  unreferencedDays: 90,
  strict: true,
  dailyCap: 50,
  mergeNoiseOnly: true,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayOf(value) {
  if (typeof value === 'string' && ISO_DAY_RE.test(value.slice(0, 10))) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function daysSince(day, now = new Date()) {
  const left = dayOf(day);
  const right = dayOf(now);
  if (left === null || right === null) return null;
  return Math.floor((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / DAY_MS);
}

function norm(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。；：！？、,.!?;:…—–\-_/\\()()[\]{}"'"'`]+/g, '')
    .trim()
    .toLowerCase();
}

function contentKeyOf(record) {
  const raw = record?.content ?? record?.text ?? record?.gist ?? '';
  return sha256Text(norm(raw));
}

/** Pure decay score for one assertion/card: older + weaker => more decayed. */
export function decayScore(record, now = new Date()) {
  const day = record?.lastUsed ?? record?.last_used ?? record?.createdAt ?? null;
  const ageDays = day === null ? null : daysSince(day, now);
  const strength = Number.isFinite(record?.strength) ? Number(record.strength) : 3;
  const useCount = Number.isInteger(record?.useCount) ? record.useCount : 0;
  return { ageDays, strength, useCount, decayed: ageDays !== null && ageDays > DECAY_POLICY.unreferencedDays && strength <= 3 && useCount === 0 };
}

/**
 * Time-decay proposals (read-only): same-topic records unreferenced for >90 days
 * become distill candidates. Never deletes, never writes.
 */
export function proposeDecay({ records = [], cards = [], now = new Date(), days = DECAY_POLICY.unreferencedDays, cap = DECAY_POLICY.dailyCap } = {}) {
  const topics = new Map();
  const immune = [];
  for (const record of records) {
    const topic = norm(record?.subject?.entity ?? record?.subject ?? record?.topic ?? record?.kind ?? 'unknown');
    const references = Array.isArray(record?.referencedBy) ? record.referencedBy : [];
    const day = record?.lastUsed ?? record?.last_used ?? null;
    const ageDays = day === null ? null : daysSince(day, now);
    if (Number(record?.salience) >= 5 || record?.state === 'locked' || references.length > 0 || ageDays === null || ageDays <= days) {
      immune.push({ id: record?.id ?? null, reason: ageDays === null ? 'no-date' : ageDays <= days ? `age=${ageDays}<=${days}` : 'protected-or-referenced' });
      continue;
    }
    const bucket = topics.get(topic) ?? { topic, ids: [], ageDays };
    bucket.ids.push(record.id);
    bucket.ageDays = Math.max(bucket.ageDays, ageDays);
    topics.set(topic, bucket);
  }
  for (const card of cards) {
    if (isProtectedPath({ memoryRoot: card.memoryRoot ?? '', relPath: card.rel ?? '' })) {
      immune.push({ id: card.rel ?? null, reason: 'protected-card' });
      continue;
    }
    const topic = norm(card.fields?.tags?.[0] ?? card.title ?? 'unknown');
    const ageDays = daysSince(card.fields?.last_used ?? null, now);
    if (ageDays === null || ageDays <= days) continue;
    const bucket = topics.get(topic) ?? { topic, ids: [], ageDays };
    bucket.ids.push(card.rel);
    bucket.ageDays = Math.max(bucket.ageDays, ageDays);
    topics.set(topic, bucket);
  }
  const proposals = [...topics.values()]
    .filter((bucket) => bucket.ids.length > 0)
    .sort((left, right) => right.ageDays - left.ageDays)
    .slice(0, cap)
    .map((bucket) => ({
      action: 'distill',
      topic: bucket.topic,
      sourceIds: [...bucket.ids].sort(),
      ageDays: bucket.ageDays,
      reason: `同主题 ${bucket.ids.length} 条事件 ${bucket.ageDays} 天未被引用（>${days}）→ 可合成为 distill 摘要（原文保留）`,
    }));
  return { schema: DECAY_SCHEMA, policy: { ...DECAY_POLICY, days, cap }, proposals, immune, executed: false };
}

/** Duplicate groups by normalized content: keep first, mark the rest duplicateOf. */
export function mergePlan({ records = [] } = {}) {
  const groups = new Map();
  for (const record of records) {
    if (!record || record.state === 'superseded' || record.state === 'archived') continue;
    const key = contentKeyOf(record);
    if (key === sha256Text('')) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }
  const plans = [];
  for (const [digest, bucket] of groups) {
    if (bucket.length < 2) continue;
    const [keep, ...duplicates] = bucket;
    plans.push({
      action: 'merge',
      digest,
      keep: {
        id: keep.id ?? null,
        rel: keep.rel ?? null,
        content: keep.content ?? null,
        anchors: Array.isArray(keep.anchors) ? keep.anchors : [],
        sourceEventIds: Array.isArray(keep.sourceEventIds) ? keep.sourceEventIds : [],
      },
      duplicates: duplicates.map((record) => ({
        id: record.id ?? null,
        rel: record.rel ?? null,
        anchors: Array.isArray(record.anchors) ? record.anchors : [],
        sourceEventIds: Array.isArray(record.sourceEventIds) ? record.sourceEventIds : [],
      })),
      mergeId: `merge:${digest.slice(0, 16)}`,
    });
  }
  return { schema: MERGE_SCHEMA, plans, policy: { archiveMerged: MERGE_ARCHIVE_DIR, noDelete: true } };
}

function auditRow({ root, action, recordId, extra, now }) {
  try {
    appendAuditRecord({
      memoryRoot: root,
      action,
      recordId,
      readerTier: 'host',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      at: now.toISOString(),
      extra,
    });
  } catch {
    /* best effort: audit failure must not abort an already-recorded move */
  }
}

/**
 * Apply a merge plan. Records: append one merge row (no delete). Cards: back up +
 * rename duplicates into `archive/merged/`; protected cards are refused.
 */
export function applyMerge({ root, plan, now = new Date(), by = 'decay:v1' } = {}) {
  const memoryRoot = String(root ?? '');
  if (memoryRoot === '') throw memoryError('E_MEMORY_ROOT', 'applyMerge requires root');
  if (!plan || plan.action !== 'merge') throw memoryError('E_MERGE_PLAN', 'merge plan 必须是 mergePlan 的产物');
  const duplicates = Array.isArray(plan.duplicates) ? plan.duplicates : [];
  const moved = [];
  for (const duplicate of duplicates) {
    if (typeof duplicate.rel === 'string' && duplicate.rel !== '') {
      if (isProtectedPath({ memoryRoot, relPath: duplicate.rel })) {
        throw memoryError('E_PROTECTED', `保护卡拒绝合并/归档：${duplicate.rel}（误杀率必须 0）`);
      }
      const source = resolveInside(memoryRoot, duplicate.rel);
      if (!fs.existsSync(source)) continue;
      ensureDir(memoryRoot, MERGE_ARCHIVE_DIR);
      const target = resolveInside(memoryRoot, path.join(MERGE_ARCHIVE_DIR, path.basename(duplicate.rel)));
      if (fs.existsSync(target)) continue;
      const backup = backupInto(memoryRoot, source, path.join('.longlive', 'backups'), { now });
      fs.renameSync(source, target);
      moved.push({ rel: duplicate.rel, archived: relativePath(memoryRoot, target), backup: backup.rel, sha256: backup.sha256 });
    }
  }
  const mergeRow = {
    id: plan.mergeId,
    kind: 'merge',
    state: 'merged',
    content: `duplicate merge: keep=${plan.keep?.id ?? plan.keep?.rel ?? 'unknown'} duplicates=${duplicates.length}`,
    duplicateOf: plan.keep?.id ?? plan.keep?.rel ?? null,
    supersedes: duplicates.map((duplicate) => duplicate.id ?? duplicate.rel).filter(Boolean),
    anchors: [
      ...(Array.isArray(plan.keep?.anchors) ? plan.keep.anchors : []),
      ...duplicates.flatMap((duplicate) => (Array.isArray(duplicate.anchors) ? duplicate.anchors : [])),
    ],
    sourceEventIds: [
      ...(Array.isArray(plan.keep?.sourceEventIds) ? plan.keep.sourceEventIds : []),
      ...duplicates.flatMap((duplicate) => (Array.isArray(duplicate.sourceEventIds) ? duplicate.sourceEventIds : [])),
    ],
    backup: moved.map((item) => ({ rel: item.rel, path: item.backup, sha256: item.sha256 })),
    archived: moved.map((item) => ({ rel: item.rel, archived: item.archived })),
    createdAt: now.toISOString(),
    audit: { by, reason: 'duplicate-digest-merge', moved: moved.length },
  };
  const written = appendRecordLine({ memoryRoot, record: mergeRow });
  appendAudit(memoryRoot, { action: 'memory_merge', object: mergeRow.id, result: `duplicates=${duplicates.length} moved=${moved.length}`, now });
  auditRow({
    root: memoryRoot,
    action: 'merge',
    recordId: mergeRow.id,
    extra: {
      keep: mergeRow.duplicateOf,
      keepAnchors: Array.isArray(plan.keep?.anchors) ? plan.keep.anchors : [],
      duplicates: duplicates.length,
      duplicateAnchors: duplicates.flatMap((duplicate) => (Array.isArray(duplicate.anchors) ? duplicate.anchors : [])),
      moved,
      backup: mergeRow.backup,
      archived: mergeRow.archived,
      anchors: mergeRow.anchors,
    },
    now,
  });
  return { ok: true, schema: MERGE_SCHEMA, mergeId: mergeRow.id, keep: mergeRow.duplicateOf, moved, record: mergeRow, written };
}

function promoteDirOf(root, id) {
  return path.join(path.resolve(String(root)), VERSIONS_DIR, 'records', `${sha256Text(String(id)).slice(0, 12)}.jsonl`);
}

export function promoteHistory({ root, id } = {}) {
  const file = promoteDirOf(root, id);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { id, file, version: null, versions: [] };
    throw error;
  }
  const versions = raw.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  return { id, file, version: versions.at(-1)?.claimVersion ?? null, versions };
}

/**
 * Promote a new assertion: append claimVersion+1 with supersedes chain (CAS on
 * expectedVersion). Old versions stay on disk; rollback only moves the pointer.
 */
export function promoteRecord({ root, record, supersedes = null, expectedVersion = null, by = 'decay:v1', reason = '', now = new Date() } = {}) {
  const memoryRoot = String(root ?? '');
  if (memoryRoot === '') throw memoryError('E_MEMORY_ROOT', 'promoteRecord requires root');
  if (!record || typeof record.id !== 'string' || record.id === '') throw memoryError('E_PROMOTE_RECORD', 'promote 需要 record.id');
  const history = promoteHistory({ root: memoryRoot, id: record.id });
  const applied = history.versions.at(-1) ?? null;
  const currentVersion = applied?.claimVersion ?? 0;
  if (expectedVersion !== null && expectedVersion !== currentVersion) {
    throw memoryError('E_CAS_VERSION', `promote CAS 失败：期望 v${expectedVersion}，当前 v${currentVersion}`);
  }
  const version = currentVersion + 1;
  const row = {
    ...record,
    schema: PROMOTE_SCHEMA,
    id: record.id,
    claimVersion: version,
    prevVersion: applied ? `${record.id}@v${currentVersion}` : null,
    supersedes: supersedes ? [supersedes] : (record.supersedes ?? []),
    state: record.state ?? 'active',
    audit: { by, reason, createdAt: now.toISOString() },
    updatedAt: now.toISOString(),
  };
  const file = promoteDirOf(memoryRoot, record.id);
  ensureDir(memoryRoot, path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  appendAudit(memoryRoot, { action: 'memory_promote', object: `${record.id}@v${version}`, result: `supersedes=${row.supersedes.join(',') || '-'} by=${by}`, now });
  auditRow({ root: memoryRoot, action: 'promote', recordId: record.id, extra: { claimVersion: version, supersedes: row.supersedes, prevVersion: row.prevVersion }, now });
  return { ok: true, schema: PROMOTE_SCHEMA, id: record.id, claimVersion: version, prevVersion: row.prevVersion, supersedes: row.supersedes, file, record: row };
}

export function promoteRollback({ root, id, toVersion, by = 'admin', reason = '', now = new Date() } = {}) {
  const memoryRoot = String(root ?? '');
  const history = promoteHistory({ root: memoryRoot, id });
  const target = history.versions.find((row) => row.claimVersion === toVersion);
  if (!target) throw memoryError('E_CHAIN_NO_VERSION', `promote 链 ${id} 没有 v${toVersion}`);
  const file = history.file;
  const pointer = path.join(path.resolve(memoryRoot), VERSIONS_DIR, 'records', 'index.json');
  let index = { schema: 'promote-index/v1', entries: {} };
  try {
    index = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  } catch { /* first write */ }
  index.entries[id] = { file: path.basename(file), activeVersion: toVersion, updatedAt: now.toISOString() };
  writeFileAtomic(memoryRoot, pointer, `${JSON.stringify(index, null, 2)}\n`, { backup: false, now });
  appendAudit(memoryRoot, { action: 'memory_promote_rollback', object: `${id}->v${toVersion}`, result: `by=${by} reason=${reason || '-'}`, now });
  auditRow({ root: memoryRoot, action: 'promote_rollback', recordId: id, extra: { toVersion, by, reason }, now });
  return { ok: true, id, activeVersion: toVersion, file };
}
