// src/role/relationships.js — 角色内核 · relationship graph（v2.8 §16.3 ③）
//
// 设计口径（§16.3）：
//   - `.longlive/role/relationships.json`：nodes `{personId,tier,confidence,updatedAt}`，
//     edges `{personId→personId, relation, lastSeenAt}`；tier ∈ stranger|familiar|trusted|intimate；
//   - 动作 G7 `relationship.update`（人判 + reason≥10字 + CAS + 审计 + 可回退标记）；
//   - 接口：`relationshipTier → recall 排序权重乘子 {1.0,1.05,1.1,1.15}`
//     （只排序，不改事实真值/保护谓词）。
//
// 任务书扩到「用户-项目-会话-事件」关系：本文件用统一的 `from/to` 字符串标识，
// 项目/会话/事件写成 `project:<name>`、`session:<id>`、`event:<id>` 形态（schema 不变）；
// person 节点额外记录称呼 `appellations[]`（老大/主人等）。
//
// 读写纪律：写路径校验 + CAS + 审计（append-only `.longlive/role/audit.jsonl`），
// 读路径永不抛；坏文件降级为 present:false/degraded:true。

import {
  RoleError, ROLE_CODES, appendJsonl, ensureRoleDir, iso, nowMs, readJsonSafe, readJsonlSafe, rolePaths, tryRolePaths, writeJsonAtomic,
} from './store.js';

export const RELATIONSHIPS_SCHEMA = 'relationships/v1';
export const RELATIONSHIP_TIERS = Object.freeze(['stranger', 'familiar', 'trusted', 'intimate']);
/** 三接口之一：tier → recall 排序权重乘子（只影响排序）。 */
export const TIER_WEIGHTS = Object.freeze({
  stranger: 1.0,
  familiar: 1.05,
  trusted: 1.1,
  intimate: 1.15,
});
/** 新关系的默认置信度（人判更新 tier 时未显式给 confidence 的落点）。 */
export const TIER_CONFIDENCE = Object.freeze({
  stranger: 0.3,
  familiar: 0.55,
  trusted: 0.8,
  intimate: 0.95,
});
export const RELATIONSHIP_DEFAULTS = Object.freeze({
  tier: 'stranger',
  multiplier: TIER_WEIGHTS.stranger,
  confidence: TIER_CONFIDENCE.stranger,
  appellationMax: 20,
  appellationChars: 40,
  edgesMax: 200,
});
export const RELATIONSHIP_CODES = Object.freeze({
  PARAMS: ROLE_CODES.PARAMS,
  TIER: 'E_RELATIONSHIP_TIER',
  PERSON: 'E_RELATIONSHIP_PERSON',
  REASON: 'E_RELATIONSHIP_REASON',
  CAS: ROLE_CODES.CAS_CONFLICT,
  CORRUPT: ROLE_CODES.CORRUPT,
});

function relationshipError(code, message, details = undefined) {
  const error = new RoleError(code, message, details);
  error.status = code === RELATIONSHIP_CODES.CAS ? 409 : 422;
  return error;
}

export function isRelationshipTier(value) {
  return RELATIONSHIP_TIERS.includes(String(value ?? ''));
}

/** Tier → recall weight multiplier; invalid tier degrades to stranger's 1.0. */
export function relationshipTierMultiplier(tier) {
  const key = String(tier ?? '');
  return Object.prototype.hasOwnProperty.call(TIER_WEIGHTS, key) ? TIER_WEIGHTS[key] : TIER_WEIGHTS.stranger;
}

function normalizePersonId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id === '' || Array.from(id).length > 120) {
    throw relationshipError(RELATIONSHIP_CODES.PERSON, `personId 非法：${JSON.stringify(value)}`);
  }
  return id;
}

function normalizeReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (Array.from(reason).length < 10) {
    throw relationshipError(RELATIONSHIP_CODES.REASON, 'relationship.update 需要 reason（≥10 字的人判理由）。');
  }
  return reason;
}

function normalizeAppellations(value, existing = []) {
  const merged = new Map();
  for (const item of [...existing, ...(Array.isArray(value) ? value : [])]) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text === '') continue;
    const clipped = Array.from(text).slice(0, RELATIONSHIP_DEFAULTS.appellationChars).join('');
    merged.set(clipped, clipped);
  }
  return [...merged.values()].slice(-RELATIONSHIP_DEFAULTS.appellationMax);
}

function normalizeEdge(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const from = typeof raw.from === 'string' ? raw.from.trim() : '';
  const to = typeof raw.to === 'string' ? raw.to.trim() : '';
  const relation = typeof raw.relation === 'string' ? raw.relation.trim() : '';
  if (from === '' || to === '' || relation === '') return null;
  const lastSeenAt = typeof raw.lastSeenAt === 'string' && Number.isFinite(Date.parse(raw.lastSeenAt))
    ? raw.lastSeenAt
    : null;
  return { from, to, relation, lastSeenAt };
}

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.personId !== 'string' || raw.personId.trim() === '') return null;
  const tier = isRelationshipTier(raw.tier) ? String(raw.tier) : RELATIONSHIP_DEFAULTS.tier;
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : TIER_CONFIDENCE[tier] ?? RELATIONSHIP_DEFAULTS.confidence;
  return {
    personId: raw.personId.trim(),
    tier,
    confidence,
    updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null,
    version: Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : (raw.updatedAt ? 1 : 0),
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((item) => typeof item === 'string').slice(0, 20) : [],
    appellations: normalizeAppellations(raw.appellations),
  };
}

/** Read the graph; nodes always as an array (legacy object-map tolerated). */
export function readRelationships({ memoryRoot, caller = null, auditKey = null } = {}) {
  const paths = tryRolePaths(memoryRoot);
  if (paths === null) {
    return {
      schema: RELATIONSHIPS_SCHEMA,
      present: false,
      degraded: true,
      updatedAt: null,
      nodes: [],
      edges: [],
      count: 0,
      code: 'E_RELATIONSHIPS_ABSENT',
    };
  }
  const read = readJsonSafe(paths.relationships, { memoryRoot, auditKey, caller });
  if (read.tampered === true || read.denied === true) {
    return {
      schema: RELATIONSHIPS_SCHEMA,
      present: false,
      degraded: true,
      tampered: read.tampered === true,
      denied: read.denied === true,
      subject: read.subject ?? null,
      updatedAt: null,
      nodes: [],
      edges: [],
      count: 0,
      code: read.code,
      message: read.message ?? null,
    };
  }
  if (!read.ok || !read.value || typeof read.value !== 'object') {
    return {
      schema: RELATIONSHIPS_SCHEMA,
      present: read.present === true,
      degraded: read.present === true,
      updatedAt: null,
      nodes: [],
      edges: [],
      count: 0,
      code: read.present === true ? 'E_RELATIONSHIPS_CORRUPT' : 'E_RELATIONSHIPS_ABSENT',
    };
  }
  const rawNodes = Array.isArray(read.value.nodes)
    ? read.value.nodes
    : (read.value.nodes && typeof read.value.nodes === 'object'
      ? Object.entries(read.value.nodes).map(([personId, node]) => ({ personId, ...(node ?? {}) }))
      : []);
  const nodes = [];
  let bad = 0;
  for (const raw of rawNodes) {
    const node = normalizeNode(raw);
    if (node === null) { bad += 1; continue; }
    nodes.push(node);
  }
  const edges = [];
  for (const raw of Array.isArray(read.value.edges) ? read.value.edges : []) {
    const edge = normalizeEdge(raw);
    if (edge === null) { bad += 1; continue; }
    edges.push(edge);
  }
  nodes.sort((left, right) => left.personId.localeCompare(right.personId));
  return {
    schema: RELATIONSHIPS_SCHEMA,
    present: true,
    degraded: bad > 0,
    updatedAt: typeof read.value.updatedAt === 'string' ? read.value.updatedAt : null,
    nodes,
    edges,
    count: nodes.length,
    bad,
    subject: read.value.subject ?? null,
    code: bad > 0 ? 'E_RELATIONSHIPS_PARTIAL' : 'OK',
  };
}

/** Tier for one person; missing/invalid store → stranger (never throws). */
export function relationshipTierOf({ memoryRoot, personId, caller = null, auditKey = null } = {}) {
  const graph = readRelationships({ memoryRoot, caller, auditKey });
  const hit = graph.nodes.find((node) => node.personId === String(personId ?? ''));
  return hit ? hit.tier : RELATIONSHIP_DEFAULTS.tier;
}

/** 三接口 #1（读侧）：personId → recall 排序权重乘子。 */
export function recallWeightFor({ memoryRoot, personId, caller = null, auditKey = null } = {}) {
  const tier = relationshipTierOf({ memoryRoot, personId, caller, auditKey });
  return { personId: typeof personId === 'string' ? personId : null, tier, multiplier: relationshipTierMultiplier(tier) };
}

/**
 * 三接口 #1（纯排序器）：把 relationshipTier 乘到 score 上再排序。
 * 只改变顺序与分数，不改变 item 内容/事实真值（调用方保留原对象字段）。
 * @param {Array<object>} items each item may carry `personId`/`actor` + numeric `score`
 * @param {{memoryRoot?:string, graph?:object, resolvePerson?:Function}} [options]
 */
export function applyRelationshipWeights(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const graph = options.graph && Array.isArray(options.graph.nodes)
    ? options.graph
    : readRelationships({ memoryRoot: options.memoryRoot, caller: options.caller ?? null, auditKey: options.auditKey ?? null });
  const tierByPerson = new Map(graph.nodes.map((node) => [node.personId, node.tier]));
  const resolvePerson = typeof options.resolvePerson === 'function'
    ? options.resolvePerson
    : (item) => (typeof item?.personId === 'string' && item.personId !== '' ? item.personId
      : (typeof item?.actor === 'string' ? item.actor : null));
  const decorated = list.map((item, index) => {
    const personId = resolvePerson(item);
    const tier = personId !== null && tierByPerson.has(personId) ? tierByPerson.get(personId) : RELATIONSHIP_DEFAULTS.tier;
    const multiplier = relationshipTierMultiplier(tier);
    const baseScore = typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0;
    return { item, index, personId, tier, multiplier, baseScore, score: baseScore * multiplier };
  });
  decorated.sort((left, right) => (right.score - left.score)
    || left.index - right.index);
  return {
    items: decorated.map((entry) => entry.item),
    ranked: decorated.map((entry) => ({
      personId: entry.personId,
      tier: entry.tier,
      multiplier: entry.multiplier,
      baseScore: entry.baseScore,
      score: entry.score,
    })),
    source: 'relationship',
  };
}

/** Monotonic audit seq (append-only role audit log). */
function nextAuditSeq(paths, options = {}) {
  const read = readJsonlSafe(paths.audit, { limit: 10_000, memoryRoot: options.memoryRoot, auditKey: options.auditKey ?? null });
  const rows = read.rows ?? [];
  let max = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const seq = rows[index]?.seq;
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max + 1;
}

function appendRoleAudit(paths, entry, options = {}) {
  const row = { seq: nextAuditSeq(paths, options), at: iso(Date.now()), ...entry };
  appendJsonl(paths.audit, row, { memoryRoot: options.memoryRoot, auditKey: options.auditKey ?? null, actorKind: options.actorKind ?? 'host' });
  return row;
}

function readGraphFile(paths, options = {}) {
  const read = readJsonSafe(paths.relationships, { memoryRoot: options.memoryRoot, auditKey: options.auditKey ?? null });
  if (read.tampered === true) {
    return { v: 1, updatedAt: null, nodes: [], edges: [], corrupt: true, tampered: true };
  }
  if (!read.ok || !read.value || typeof read.value !== 'object') {
    return {
      v: 1,
      updatedAt: null,
      nodes: [],
      edges: [],
      corrupt: read.present === true,
      subject: null,
    };
  }
  const value = read.value;
  const rawNodes = Array.isArray(value.nodes)
    ? value.nodes
    : (value.nodes && typeof value.nodes === 'object'
      ? Object.entries(value.nodes).map(([personId, node]) => ({ personId, ...(node ?? {}) }))
      : []);
  const nodes = rawNodes.map(normalizeNode).filter(Boolean);
  const edges = (Array.isArray(value.edges) ? value.edges : []).map(normalizeEdge).filter(Boolean);
  return {
    v: 1,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    nodes,
    edges,
    corrupt: false,
    subject: value.subject ?? null,
  };
}

/**
 * Internal tier commit shared by `relationship.update` and its undo row:
 * validates + CAS + atomic write + exactly one audit row.
 */
function commitTierChange({
  memoryRoot,
  personId,
  tier,
  reason,
  expectedVersion,
  actor = 'host',
  confidence = undefined,
  appellations = undefined,
  edges = undefined,
  now = () => new Date(),
  auditAction = 'relationship.update',
  undoInfo = null,
  undoable = false,
  auditKey = null,
  actorKind = 'host',
  subject = undefined,
  userId = undefined,
  projectId = undefined,
  readers = undefined,
} = {}) {
  const id = normalizePersonId(personId);
  const nextTier = String(tier ?? '');
  if (!isRelationshipTier(nextTier)) {
    throw relationshipError(RELATIONSHIP_CODES.TIER, `tier 非法：${JSON.stringify(tier)}（允许 ${RELATIONSHIP_TIERS.join('|')}）`);
  }
  const decidedReason = normalizeReason(reason);
  const expected = Number.isInteger(expectedVersion) ? expectedVersion : 0;
  const paths = rolePaths(memoryRoot);
  const graph = readGraphFile(paths, { memoryRoot, auditKey });
  if (graph.tampered === true) {
    throw relationshipError('E_INTEGRITY_TAMPER', 'relationships.json HMAC 校验失败（被篡改或缺少侧车），拒绝写入并拒绝加载。');
  }
  if (graph.corrupt) {
    throw relationshipError(RELATIONSHIP_CODES.CORRUPT, 'relationships.json 损坏，拒绝在无法校验 CAS 的前提下写入（先人工修复/删除该文件）。');
  }
  const index = graph.nodes.findIndex((node) => node.personId === id);
  const current = index >= 0 ? graph.nodes[index] : null;
  const currentVersion = current ? (Number.isInteger(current.version) ? current.version : 0) : 0;
  if (expected !== currentVersion) {
    throw relationshipError(
      RELATIONSHIP_CODES.CAS,
      `版本冲突：expectedVersion=${expected} 当前=${currentVersion}（personId=${id}）`,
      { current: currentVersion, expected, personId: id },
    );
  }
  const timestamp = iso(nowMs(now()));
  const node = {
    personId: id,
    tier: nextTier,
    confidence: Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, Number(confidence)))
      : (current?.confidence ?? TIER_CONFIDENCE[nextTier] ?? RELATIONSHIP_DEFAULTS.confidence),
    updatedAt: timestamp,
    version: currentVersion + 1,
    aliases: current?.aliases ?? [],
    appellations: normalizeAppellations(appellations, current?.appellations ?? []),
  };
  const nextEdges = graph.edges.slice();
  for (const raw of Array.isArray(edges) ? edges : []) {
    const edge = normalizeEdge({ ...raw, lastSeenAt: raw?.lastSeenAt ?? timestamp });
    if (!edge) continue;
    const at = nextEdges.findIndex((item) => item.from === edge.from && item.to === edge.to && item.relation === edge.relation);
    if (at >= 0) nextEdges[at] = { ...nextEdges[at], lastSeenAt: edge.lastSeenAt };
    else nextEdges.push(edge);
  }
  if (nextEdges.length > RELATIONSHIP_DEFAULTS.edgesMax) nextEdges.splice(0, nextEdges.length - RELATIONSHIP_DEFAULTS.edgesMax);
  if (index >= 0) graph.nodes[index] = node;
  else graph.nodes.push(node);
  graph.nodes.sort((left, right) => left.personId.localeCompare(right.personId));
  ensureRoleDir(memoryRoot);
  const nextSubject = (subject !== undefined || userId !== undefined || projectId !== undefined || readers !== undefined)
    ? {
      sessionId: subject?.sessionId ?? graph.subject?.sessionId ?? null,
      userId: subject?.userId ?? userId ?? graph.subject?.userId ?? null,
      projectId: subject?.projectId ?? projectId ?? graph.subject?.projectId ?? null,
      readers: [
        ...(Array.isArray(graph.subject?.readers) ? graph.subject.readers : []),
        ...(Array.isArray(subject?.readers) ? subject.readers : []),
        ...(Array.isArray(readers) ? readers : []),
      ],
    }
    : undefined;
  writeJsonAtomic(paths.relationships, {
    v: 1,
    updatedAt: timestamp,
    nodes: graph.nodes,
    edges: nextEdges,
  }, { memoryRoot, auditKey, actorKind, subject: nextSubject });
  const audit = appendRoleAudit(paths, {
    action: auditAction,
    actor: typeof actor === 'string' && actor !== '' ? actor : 'host',
    personId: id,
    reason: decidedReason,
    before: { tier: current?.tier ?? null, version: currentVersion },
    after: { tier: nextTier, version: node.version },
    // `relationship.update` 行带 undo 回退标记；undo 行自身不再可 undo。
    undo: undoInfo ?? (undoable ? { previousTier: current?.tier ?? null, previousVersion: currentVersion } : null),
    source: 'role.relationships',
  }, { memoryRoot, auditKey, actorKind });
  return {
    ok: true,
    node,
    previous: { tier: current?.tier ?? null, version: currentVersion },
    undoable,
    auditSeq: audit.seq,
  };
}

/**
 * G7 `relationship.update`：人判关系等级更新。
 * - reason ≥10 字；tier 枚举；CAS：expectedVersion 必须等于当前节点 version（新节点=0）；
 * - 写 relationships.json（原子）+ 审计行（含 undo.previousTier，供 undo 回退标记）；
 * - 只改关系层，不改任何记忆事实/保护谓词。
 */
export function updateRelationship(options = {}) {
  const result = commitTierChange({
    ...options,
    auditAction: 'relationship.update',
    undoable: true,
  });
  return {
    ...result,
    undoable: true,
    undo: {
      action: 'relationship.update.undo',
      personId: result.node.personId,
      tier: result.previous.tier ?? 'stranger',
      expectedVersion: result.node.version,
    },
  };
}

/** Undo half of `relationship.update`: restore the previous tier as a new version. */
export function restoreRelationship({
  memoryRoot,
  personId,
  tier,
  reason = '按审计记录回退关系等级（relationship.update undo）',
  expectedVersion,
  actor = 'host',
  now = () => new Date(),
  auditKey = null,
  actorKind = 'host',
} = {}) {
  const result = commitTierChange({
    memoryRoot,
    personId,
    tier,
    reason,
    expectedVersion,
    actor,
    now,
    auditKey,
    actorKind,
    auditAction: 'relationship.update.undo',
    undoable: false,
  });
  return { ok: true, node: result.node, restoredTier: result.node.tier, auditSeq: result.auditSeq, undoable: false };
}

/** Appellation history for one person (称呼记录). */
export function appellationsOf({ memoryRoot, personId, caller = null, auditKey = null } = {}) {
  const graph = readRelationships({ memoryRoot, caller, auditKey });
  const hit = graph.nodes.find((node) => node.personId === String(personId ?? ''));
  return hit ? [...hit.appellations] : [];
}
