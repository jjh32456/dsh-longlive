// src/role/interfaces.js — 角色内核 · 三接口契约（v2.8 §16.3 接口接线）
//
// 三接口（字段名/类型/默认值/错误码在这里冻结，测试直接断言本文件的常量）：
//   1) relationshipTier  → recall 排序权重乘子（只排序，不改事实真值/保护谓词）
//   2) attention          → kind=ops 优先级（只排序；与 recall 冲突时记忆事实优先）
//   3) personality snapshot → 遗忘偏好（retentionBias 只调阈值，不越权 protected/forbid）
//
// 消费方（记忆召回/遗忘/注入）可以直接 import 纯函数，也可以拿
// `createRoleInterfaces({memoryRoot})` 拿到与某个记忆根绑定的实现。

import { orderOpsItems, attentionPriorityOfKind, normalizeAttentionRow, ATTENTION_PRIORITIES } from './attention.js';
import {
  RELATIONSHIP_TIERS, TIER_WEIGHTS, applyRelationshipWeights, readRelationships, recallWeightFor, relationshipTierMultiplier,
} from './relationships.js';
import {
  PERSONALITY_SCHEMA, RETENTION_KINDS, applyRetentionBiasToRules, readPersonality, retentionBiasFor, toneProjection,
} from './personality.js';
import { nowMs, readJsonlSafe, tryRolePaths } from './store.js';

export const ROLE_INTERFACE_VERSION = '1.0.0';

/** 三接口契约描述（机器可读；测试用它锁字段名/类型/默认值/错误码）。 */
export const INTERFACE_CONTRACTS = Object.freeze({
  relationshipTierToRecallWeight: Object.freeze({
    id: 'relationshipTier->recallWeight',
    version: ROLE_INTERFACE_VERSION,
    fields: Object.freeze({
      tier: Object.freeze({ type: 'enum', values: RELATIONSHIP_TIERS, default: 'stranger' }),
      multiplier: Object.freeze({ type: 'number', default: TIER_WEIGHTS.stranger, table: TIER_WEIGHTS }),
    }),
    errors: Object.freeze(['E_RELATIONSHIP_TIER', 'E_ROLE_CAS_CONFLICT', 'E_ROLE_PARAMS']),
    guarantees: Object.freeze(['只影响召回排序', '不改变事实真值/保护谓词']),
  }),
  attentionToOpsPriority: Object.freeze({
    id: 'attention->kind=ops priority',
    version: ROLE_INTERFACE_VERSION,
    fields: Object.freeze({
      priority: Object.freeze({ type: 'enum', values: ATTENTION_PRIORITIES, default: 'P2' }),
      kind: Object.freeze({ type: 'enum', values: Object.freeze(['ops', 'user', 'tool', 'session', 'error']), default: 'ops' }),
      subject: Object.freeze({ type: 'string', default: '' }),
    }),
    errors: Object.freeze(['E_ROLE_PARAMS']),
    guarantees: Object.freeze(['只影响注入/面板顺序', '不改变召回内容', '与 recall 冲突时记忆事实优先']),
  }),
  personalitySnapshotToRetentionBias: Object.freeze({
    id: 'personality snapshot->retention bias',
    version: ROLE_INTERFACE_VERSION,
    fields: Object.freeze({
      snapshotId: Object.freeze({ type: 'string', default: null }),
      version: Object.freeze({ type: 'number', default: 0 }),
      retentionBias: Object.freeze({ type: 'map', keys: RETENTION_KINDS, value: Object.freeze({ type: 'number', default: 1.0, min: 0.8, max: 1.5 }) }),
      tone: Object.freeze({ type: 'string', default: 'neutral' }),
      createdAt: Object.freeze({ type: 'string', default: null }),
    }),
    errors: Object.freeze(['E_ROLE_PARAMS', 'E_ROLE_CORRUPT']),
    guarantees: Object.freeze(['只影响衰减阈值', '不越权 protected/forbid/immuneSalience']),
  }),
});

/** Read attention rows from disk without building the writer queue. */
export function readAttentionRows({ memoryRoot, limit = 10_000, auditKey = null } = {}) {
  const paths = tryRolePaths(memoryRoot);
  if (paths === null) return { rows: [], bad: 0, present: false, total: 0 };
  const read = readJsonlSafe(paths.attention, { limit, memoryRoot, auditKey });
  if (read.tampered === true) return { rows: [], bad: 0, present: false, total: 0, tampered: true, code: read.code ?? 'E_INTEGRITY_TAMPER' };
  const rows = [];
  let bad = 0;
  for (const raw of read.rows) {
    const row = normalizeAttentionRow(raw);
    if (row) rows.push(row);
    else bad += 1;
  }
  return { rows, bad, present: read.present, total: read.total ?? rows.length };
}

/**
 * Bind the three interfaces to one memory root (read-side helpers).
 * Writes stay in the owning modules (attention queue / updateRelationship /
 * generatePersonalitySnapshot) so consumers cannot bypass validation.
 */
export function createRoleInterfaces({ memoryRoot, now = () => new Date(), caller = null, auditKey = null } = {}) {
  const clock = () => nowMs(now());
  return {
    version: ROLE_INTERFACE_VERSION,
    memoryRoot,
    caller,
    contracts: INTERFACE_CONTRACTS,
    relationship: {
      tierOf: (personId) => {
        const graph = readRelationships({ memoryRoot, caller, auditKey });
        const hit = graph.nodes.find((node) => node.personId === String(personId ?? ''));
        return hit ? hit.tier : 'stranger';
      },
      multiplierForTier: (tier) => relationshipTierMultiplier(tier),
      recallWeightFor: (personId) => recallWeightFor({ memoryRoot, personId, caller, auditKey }),
      applyWeights: (items, options = {}) => applyRelationshipWeights(items, { memoryRoot, caller, auditKey, ...options }),
    },
    attention: {
      priorityOfKind: (kind) => attentionPriorityOfKind(kind),
      orderOps: (items, options = {}) => {
        const read = readAttentionRows({ memoryRoot, auditKey });
        return orderOpsItems(items, read.rows, { now: options.now ?? clock() });
      },
    },
    personality: {
      read: () => readPersonality({ memoryRoot, caller, auditKey }),
      snapshot: () => readPersonality({ memoryRoot, caller, auditKey }).snapshot,
      retentionBiasFor: (kind) => retentionBiasFor(kind, { snapshot: readPersonality({ memoryRoot, caller, auditKey }).snapshot }),
      decayThresholdsFor: (baseRules) => applyRetentionBiasToRules(baseRules, { snapshot: readPersonality({ memoryRoot, caller, auditKey }).snapshot }),
      toneProjection: () => toneProjection({ snapshot: readPersonality({ memoryRoot, caller, auditKey }).snapshot }),
    },
  };
}

export { PERSONALITY_SCHEMA };
