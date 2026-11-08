// src/memory/conflicts.js — 1.8.0 / v2.8 §15.1-A2/A4：冲突检测唯一实现（避免两套真相）
//
// 目标：Claim（治理层）与 records（v2.6.4 遗留）共用同一套互斥判定，
// 以 cards.js 的极性词表为唯一词源；输出 conflicts[]{idA,idB,subject,why,source}。
// - subject 归一：entity（+attribute）小写、去空白；同 subject 才可能互斥；
// - 互斥：正反极性（cards.isNegativeConclusion 取反）或同 attribute 不同 value；
// - supersedes/supersededBy 链内不判冲突；非 active/verified 状态不参与；
// - 有 claims 时以 claims 为准（旧 records 是迁移来源），避免同一事实重复计数。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readClaims } from './governance.js';
import { detectRecordConflicts, listRecords } from './records.js';

export function conflictKeyOf(claimA, claimB) {
  return [String(claimA), String(claimB)].sort().join('|');
}

export function conflictIdOf(claimA, claimB) {
  const key = conflictKeyOf(claimA, claimB);
  return `cfl_${crypto.createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 12)}`;
}

export function conflictStatePathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'conflicts', 'state.json');
}

/** Persistent arbitration state (CAS version source for conflict.arbitrate). */
export function readConflictState({ memoryRoot }) {
  try {
    const value = JSON.parse(fs.readFileSync(conflictStatePathOf(memoryRoot), 'utf8'));
    return {
      version: Number.isInteger(value?.version) ? value.version : 0,
      items: value?.items && typeof value.items === 'object' ? value.items : {},
    };
  } catch {
    return { version: 0, items: {} };
  }
}

function resolutionState(item) {
  if (!item || typeof item.resolution !== 'string') return 'open';
  if (item.resolution === 'disputed') return 'disputed';
  if (item.resolution === 'both') return 'both';
  return 'resolved';
}

export const CONFLICT_SCHEMA = 'conflicts/v1';

function normalizeSubjectPart(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\u3000]+/g, '');
}

/**
 * Detect conflicts via the SINGLE implementation in records.js (EA-03: one source of truth).
 * Entries may be claims (subject object) or legacy records (subject string).
 */
export function detectConflicts(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const { conflicts, byId } = detectRecordConflicts(list);
  return {
    conflicts: conflicts.map((conflict) => ({ ...conflict, source: (list.find((entry) => entry.id === conflict.idA) ?? {}).source ?? null })),
    byId,
  };
}

/**
 * Unified view: claims preferred; legacy records only when no claims exist.
 * Every entry gets conflict/conflict_with flags computed here (one source of truth).
 */
export function unifiedConflicts({ memoryRoot }) {
  const claims = readClaims({ memoryRoot, actor: { kind: 'host' } }).items.map((claim) => ({ ...claim, source: 'claim' }));
  let pool = claims;
  if (pool.length === 0) {
    pool = listRecords({ memoryRoot }).items.map((record) => ({
      ...record,
      source: 'record',
      subject: record.subject ?? null,
    }));
  }
  const { conflicts: rawConflicts, byId } = detectConflicts(pool);
  const conflictState = readConflictState({ memoryRoot });
  const conflicts = rawConflicts.map((conflict) => {
    const key = conflictKeyOf(conflict.idA, conflict.idB);
    const item = conflictState.items[key] ?? null;
    return {
      ...conflict,
      conflictId: conflictIdOf(conflict.idA, conflict.idB),
      state: resolutionState(item),
      version: item && Number.isInteger(item.version) ? item.version : 0,
    };
  });
  const marked = pool.map((entry) => {
    const ids = byId.get(entry.id) ?? [];
    return { ...entry, conflict: ids.length > 0, conflict_with: ids };
  });
  return {
    schema: CONFLICT_SCHEMA,
    source: claims.length > 0 ? 'claim' : 'record',
    entries: marked,
    conflicts,
    total: conflicts.length,
  };
}
