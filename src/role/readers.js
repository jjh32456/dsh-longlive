// src/role/readers.js — 角色内核只读投影（供 §12.3 路由 #24–#27 使用）
//
// 只读：不建目录、不修复文件、不写审计；坏文件降级为 present/degraded 标记，
// 绝不让面板/注入因为一个坏行而崩。路由注册在 src/ui/routes-readonly.js：
//   #24 attention/v1     -> readAttentionView
//   #25 relationships/v1 -> readRelationshipsView
//   #26 personality/v1   -> readPersonalityView
//   #27 channels/v1      -> readChannelsView（生产者按 v2.8 归 release-check）

import { orderAttentionRows, ATTENTION_SCHEMA, normalizeAttentionRow } from './attention.js';
import { nowMs, readJsonlSafe, tryRolePaths } from './store.js';
import {
  RELATIONSHIPS_SCHEMA, RELATIONSHIP_DEFAULTS, TIER_WEIGHTS, readRelationships,
} from './relationships.js';
import { PERSONALITY_SCHEMA, PERSONALITY_DEFAULTS, readPersonality } from './personality.js';
import { CHANNELS_SCHEMA, readChannels } from './channels.js';

function isoOrNull(value, fallbackMs) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  return Number.isFinite(fallbackMs) ? new Date(fallbackMs).toISOString() : null;
}

/** `attention/v1`：items[]{id,priority,kind,subject,at,source,effectivePriority,aged} */
export function readAttentionView({ memoryRoot, limit = 50, now = () => new Date(), caller = null, auditKey = null } = {}) {
  const paths = tryRolePaths(memoryRoot);
  if (paths === null) {
    return {
      schema: ATTENTION_SCHEMA,
      version: 1,
      present: false,
      degraded: false,
      bad: 0,
      count: 0,
      total: 0,
      items: [],
      code: 'E_ATTENTION_ABSENT',
      readAt: isoOrNull(null, nowMs(now())),
    };
  }
  const read = readJsonlSafe(paths.attention, { limit: 10_000, memoryRoot, auditKey });
  if (read.tampered === true) {
    return {
      schema: ATTENTION_SCHEMA,
      present: false,
      degraded: true,
      tampered: true,
      bad: 0,
      count: 0,
      total: 0,
      items: [],
      code: read.code ?? 'E_INTEGRITY_TAMPER',
      readAt: isoOrNull(null, nowMs(now())),
    };
  }
  const rows = [];
  let bad = read.bad ?? 0;
  for (const raw of read.rows) {
    const row = normalizeAttentionRow(raw);
    if (row) rows.push(row);
    else bad += 1;
  }
  const ordered = orderAttentionRows(rows, { now: nowMs(now()) });
  const items = ordered.slice(0, limit).map((row) => ({
    id: row.id,
    priority: row.priority,
    kind: row.kind,
    subject: row.subject,
    at: row.at,
    source: row.source,
    effectivePriority: row.effectivePriority,
    aged: row.aged,
  }));
  return {
    schema: ATTENTION_SCHEMA,
    version: 1,
    present: read.present === true,
    degraded: bad > 0,
    bad,
    count: items.length,
    total: rows.length,
    items,
    code: bad > 0 ? 'E_ATTENTION_PARTIAL' : (read.present === false ? 'E_ATTENTION_ABSENT' : 'OK'),
    readAt: isoOrNull(null, nowMs(now())),
  };
}

/** `relationships/v1`：nodes[]{personId,tier,confidence,updatedAt,version,appellations},edges[] */
export function readRelationshipsView({ memoryRoot, now = () => new Date(), caller = null, auditKey = null } = {}) {
  const graph = readRelationships({ memoryRoot, caller, auditKey });
  return {
    schema: RELATIONSHIPS_SCHEMA,
    version: 1,
    present: graph.present,
    degraded: graph.degraded,
    tampered: graph.tampered === true,
    denied: graph.denied === true,
    updatedAt: graph.updatedAt,
    subject: graph.subject ?? null,
    count: graph.count,
    nodes: graph.nodes.map((node) => ({
      personId: node.personId,
      tier: node.tier,
      confidence: node.confidence,
      updatedAt: node.updatedAt,
      version: node.version,
      appellations: [...node.appellations],
    })),
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, relation: edge.relation, lastSeenAt: edge.lastSeenAt })),
    tierWeights: { ...TIER_WEIGHTS },
    defaultTier: RELATIONSHIP_DEFAULTS.tier,
    code: graph.code,
    readAt: isoOrNull(null, nowMs(now())),
  };
}

/** `personality/v1`：{snapshotId,version,retentionBias,tone,createdAt,sources} */
export function readPersonalityView({ memoryRoot, now = () => new Date(), caller = null, auditKey = null } = {}) {
  const read = readPersonality({ memoryRoot, caller, auditKey });
  const snapshot = read.snapshot;
  return {
    schema: PERSONALITY_SCHEMA,
    version: 1,
    present: read.present,
    degraded: read.degraded,
    tampered: read.tampered === true,
    denied: read.denied === true,
    subject: read.subject ?? snapshot?.subject ?? null,
    snapshotId: snapshot?.snapshotId ?? null,
    version: snapshot?.version ?? 0,
    retentionBias: snapshot?.retentionBias ?? { ...PERSONALITY_DEFAULTS.retentionBias },
    tone: snapshot?.tone ?? PERSONALITY_DEFAULTS.tone,
    createdAt: snapshot?.createdAt ?? null,
    sources: snapshot?.sources ?? [],
    defaults: read.defaults,
    code: read.code,
    readAt: isoOrNull(null, nowMs(now())),
  };
}

/** `channels/v1`（route #27；生产者按 v2.8 归 release-check，本函数供其复用）。 */
export function readChannelsView({ memoryRoot, now = () => new Date(), caller = null, auditKey = null } = {}) {
  const view = readChannels({ memoryRoot, now, caller, auditKey });
  return { ...view, schema: CHANNELS_SCHEMA, version: 1 };
}

export const ROLE_READERS = Object.freeze({
  attention: readAttentionView,
  relationships: readRelationshipsView,
  personality: readPersonalityView,
  channels: readChannelsView,
});
