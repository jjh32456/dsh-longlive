// src/memory/governance.js — 1.8.0 / v2.8 §15.1-A1：Claim / Evidence / Bank + 授权矩阵
//
// 三个实体（写死，后续 A2/A3/A4 在其上扩展）：
//   Claim    {id, bankId, subject:{entity,attribute}, content, kind, salience, sourceTier,
//             trustScore, evidence:{version, items[]}, conflict, conflict_with[], state}
//   Evidence {id, claimId, anchorId, sha256, excerptRef, verifier, verifiedAt, version,
//             supersedes, sourceDoc}
//   Bank     {bankId, scope:user|project|org, owner, readers[], writers[], auditors[]}
//
// 授权矩阵（§15.1，写死）：
//   user   read  {user,project,org}  write {user,project}            audit {user,project}
//   host   read  all                 write {project,org}             audit all
//   agent  read  {user}              write {user}  需人判 (requiresHumanReview)
//   plugin read  {user}              write {user}  需人判
//   越权 → E_BANK_FORBIDDEN + `.longlive/audit/bank.jsonl` 一行 denied（不静默）。
//
// 文件：
//   <memoryRoot>/.longlive/claims.jsonl           Claim 只追加（版本由 evidenceVersion 单调）
//   <memoryRoot>/.longlive/banks.json             自定义 bank 注册表（可缺省，内置三个默认 bank）
//   <memoryRoot>/.longlive/audit/bank.jsonl       越权/授权审计
// 旧 records.jsonl 保持只读兼容（listRecords 仍可读）；迁移脚本 migrate-180.mjs 写入 claims.jsonl。

import crypto from 'node:crypto';

import { appendAuditRecord } from './audit-records.js';
import { trustScoreAt } from './trust.js';
import fs from 'node:fs';
import path from 'node:path';

export const CLAIMS_SCHEMA = 'claims/v1';
export const BANKS_SCHEMA = 'banks/v1';
export const BANK_SCOPES = Object.freeze(['user', 'project', 'org']);
export const BANK_ACTIONS = Object.freeze(['read', 'write', 'audit']);
export const BANK_ROLES = Object.freeze(['user', 'host', 'agent', 'plugin']);
export const CLAIM_STATES = Object.freeze(['active', 'verified', 'disputed', 'superseded', 'archived', 'unverified']);

export const DEFAULT_BANKS = Object.freeze([
  { bankId: 'bank:user', scope: 'user', owner: 'user', readers: ['user', 'host'], writers: ['user'], auditors: ['user', 'host'] },
  { bankId: 'bank:project', scope: 'project', owner: 'project', readers: ['user', 'host'], writers: ['user', 'host'], auditors: ['user', 'host'] },
  { bankId: 'bank:org', scope: 'org', owner: 'org', readers: ['user', 'host'], writers: ['host'], auditors: ['host'] },
]);

/** Authorization matrix (role × action × scope) — written down, not policy-engine. */
export const BANK_MATRIX = Object.freeze({
  user: Object.freeze({
    read: Object.freeze(['user', 'project', 'org']),
    write: Object.freeze(['user', 'project']),
    audit: Object.freeze(['user', 'project']),
  }),
  host: Object.freeze({
    read: Object.freeze(['user', 'project', 'org']),
    write: Object.freeze(['project', 'org']),
    audit: Object.freeze(['user', 'project', 'org']),
  }),
  agent: Object.freeze({
    read: Object.freeze(['user']),
    write: Object.freeze(['user']),
    audit: Object.freeze([]),
  }),
  plugin: Object.freeze({
    read: Object.freeze(['user']),
    write: Object.freeze(['user']),
    audit: Object.freeze([]),
  }),
});

export class GovernanceError extends Error {
  constructor(code, message, detail = undefined, status = 403) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

export function claimsPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'claims.jsonl');
}

export function banksPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'banks.json');
}

export function bankAuditPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'audit', 'bank.jsonl');
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha1Short(text, length = 12) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, length);
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Pure authorization decision.
 * @returns {{allowed:boolean, requiresHumanReview:boolean, role:string, action:string, scope:string, code:string}}
 */
export function canBankAccess({ role, action, scope }) {
  const roleKey = BANK_ROLES.includes(role) ? role : null;
  const actionKey = BANK_ACTIONS.includes(action) ? action : null;
  const scopeKey = BANK_SCOPES.includes(scope) ? scope : null;
  if (roleKey === null) return { allowed: false, requiresHumanReview: false, role, action, scope, code: 'E_BANK_ROLE' };
  if (actionKey === null) return { allowed: false, requiresHumanReview: false, role, action, scope, code: 'E_BANK_ACTION' };
  if (scopeKey === null) return { allowed: false, requiresHumanReview: false, role, action, scope, code: 'E_BANK_SCOPE' };
  const allowed = BANK_MATRIX[roleKey][actionKey].includes(scopeKey);
  const requiresHumanReview = allowed && roleKey !== 'user' && roleKey !== 'host' && actionKey === 'write';
  return { allowed, requiresHumanReview, role: roleKey, action: actionKey, scope: scopeKey, code: allowed ? 'OK' : 'E_BANK_FORBIDDEN' };
}

function appendBankAudit(memoryRoot, line) {
  try {
    fs.mkdirSync(path.dirname(bankAuditPathOf(memoryRoot)), { recursive: true });
    fs.appendFileSync(bankAuditPathOf(memoryRoot), `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    /* audit is best effort; the decision itself already failed closed */
  }
}

/** Assert access; denied access is audited with denied:true then throws E_BANK_FORBIDDEN. */
export function assertBankAccess({ memoryRoot, role, action, scope, actor = null, reason = '', now = () => new Date() } = {}) {
  const decision = canBankAccess({ role, action, scope });
  if (!decision.allowed) {
    appendBankAudit(memoryRoot, {
      schema: 'bank-audit/v1',
      at: nowIso(now),
      role: decision.role ?? role,
      action: decision.action ?? action,
      scope: decision.scope ?? scope,
      actor,
      allowed: false,
      denied: true,
      code: decision.code,
      reason,
    });
    throw new GovernanceError('E_BANK_FORBIDDEN', `bank 越权：role=${role} action=${action} scope=${scope}`, decision);
  }
  return decision;
}

/** Register/read custom banks; built-in three always available. */
export function listBanks({ memoryRoot }) {
  const builtIn = DEFAULT_BANKS.map((bank) => ({ ...bank, builtin: true }));
  let custom = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(banksPathOf(memoryRoot), 'utf8'));
    if (Array.isArray(parsed?.banks)) custom = parsed.banks;
  } catch {
    custom = [];
  }
  return [...builtIn, ...custom];
}

export function registerBank({ memoryRoot, bank, now = () => new Date() }) {
  const value = bank && typeof bank === 'object' ? bank : null;
  if (!value || typeof value.bankId !== 'string' || value.bankId === '') {
    throw new GovernanceError('E_BANK_ID', 'bank.bankId required', undefined, 400);
  }
  if (!BANK_SCOPES.includes(value.scope)) {
    throw new GovernanceError('E_BANK_SCOPE', `bank.scope 非法：${String(value.scope)}`, undefined, 400);
  }
  const banks = listBanks({ memoryRoot }).filter((entry) => entry.builtin !== true);
  const next = banks.filter((entry) => entry.bankId !== value.bankId);
  next.push({
    bankId: value.bankId,
    scope: value.scope,
    owner: value.owner ?? null,
    readers: Array.isArray(value.readers) ? value.readers : ['host'],
    writers: Array.isArray(value.writers) ? value.writers : ['host'],
    auditors: Array.isArray(value.auditors) ? value.auditors : ['host'],
    createdAt: value.createdAt ?? nowIso(now),
  });
  const file = banksPathOf(memoryRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: BANKS_SCHEMA, banks: next }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, banks: next, file };
}

/** Claim/Evidence entity normalization (backward compatible with v2.6.4 records). */
export function normalizeEvidence(entry, claimId = null) {
  const value = entry && typeof entry === 'object' ? entry : {};
  return {
    id: typeof value.id === 'string' ? value.id : `ev_${sha1Short(`${claimId ?? ''}|${value.anchorId ?? ''}|${value.sha256 ?? ''}`)}`,
    claimId: typeof value.claimId === 'string' ? value.claimId : claimId,
    anchorId: typeof value.anchorId === 'string' ? value.anchorId : null,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : null,
    excerptRef: typeof value.excerptRef === 'string' ? value.excerptRef : null,
    verifier: typeof value.verifier === 'string' ? value.verifier : null,
    verifiedAt: value.verifiedAt ?? null,
    version: Number.isInteger(value.version) ? value.version : 1,
    supersedes: typeof value.supersedes === 'string' ? value.supersedes : null,
    sourceDoc: typeof value.sourceDoc === 'string' ? value.sourceDoc : null,
  };
}

export function normalizeSubject(subject, fallbackId = null) {
  if (subject && typeof subject === 'object' && typeof subject.entity === 'string') {
    return {
      entity: subject.entity.trim().toLowerCase(),
      attribute: typeof subject.attribute === 'string' && subject.attribute.trim() !== '' ? subject.attribute.trim().toLowerCase() : null,
    };
  }
  const raw = typeof subject === 'string' && subject.trim() !== '' ? subject.trim().toLowerCase() : fallbackId;
  return { entity: raw ?? 'unknown', attribute: null };
}

export function normalizeClaim(row) {
  const value = row && typeof row === 'object' ? row : {};
  const claimId = typeof value.id === 'string' && value.id !== '' ? value.id : `clm_${sha1Short(JSON.stringify(value))}`;
  const evidenceItems = Array.isArray(value.evidence)
    ? value.evidence.map((entry) => normalizeEvidence(entry, claimId))
    : (Array.isArray(value.evidence?.items) ? value.evidence.items.map((entry) => normalizeEvidence(entry, claimId)) : []);
  const evidenceVersion = Number.isInteger(value.evidenceVersion)
    ? value.evidenceVersion
    : (Number.isInteger(value.evidence?.version) ? value.evidence.version : evidenceItems.length);
  return {
    schema: CLAIMS_SCHEMA,
    id: claimId,
    bankId: typeof value.bankId === 'string' && value.bankId !== '' ? value.bankId : 'bank:project',
    subject: normalizeSubject(value.subject, claimId),
    content: typeof value.content === 'string' ? value.content : '',
    kind: typeof value.kind === 'string' ? value.kind : 'fact',
    salience: Number.isInteger(value.salience) ? value.salience : 3,
    sourceTier: ['user', 'host', 'agent', 'plugin'].includes(value.sourceTier) ? value.sourceTier : 'host',
    trustScore: typeof value.trustScore === 'number' ? value.trustScore : null,
    verifyCount: Number.isInteger(value.verifyCount) ? value.verifyCount : 0,
    claimVersion: Number.isInteger(value.claimVersion) ? value.claimVersion : 1,
    supersedes: Array.isArray(value.supersedes) ? value.supersedes.map(Number).filter(Number.isInteger) : [],
    supersededBy: Number.isInteger(value.supersededBy) ? value.supersededBy : null,
    evidence: { version: evidenceVersion, items: evidenceItems },
    conflict: value.conflict === true,
    conflict_with: Array.isArray(value.conflict_with) ? value.conflict_with : [],
    state: CLAIM_STATES.includes(value.state) ? value.state : (['active', 'superseded', 'forgotten', 'archived', 'restored'].includes(value.status) ? value.status : 'active'),
    project: value.project ?? null,
    anchors: Array.isArray(value.anchors) ? value.anchors : [],
    review: value.review && typeof value.review === 'object' ? value.review : null,
    createdAt: value.createdAt ?? null,
    updatedAt: value.updatedAt ?? null,
    audit: value.audit && typeof value.audit === 'object' ? value.audit : {},
    legacy: value.legacy === true,
  };
}

export function readClaimsForHost({ memoryRoot }) {
  const file = claimsPathOf(memoryRoot);
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
    try {
      items.push(normalizeClaim(JSON.parse(line)));
    } catch {
      bad.push(line.slice(0, 120));
    }
  }
  // GOV-05: append-only rows keep every version; the read view marks older versions.
  const maxById = new Map();
  for (const item of items) {
    const version = Number.isInteger(item.claimVersion) ? item.claimVersion : 1;
    if (!maxById.has(item.id) || version > maxById.get(item.id)) maxById.set(item.id, version);
  }
  const marked = items.map((item) => {
    const max = maxById.get(item.id) ?? 1;
    const version = Number.isInteger(item.claimVersion) ? item.claimVersion : 1;
    if (version >= max) return item;
    return { ...item, state: ['forgotten', 'archived'].includes(item.state) ? item.state : 'superseded', supersededBy: max };
  });
  return { schema: CLAIMS_SCHEMA, present, items: marked, badLines: bad, file };
}

/**
 * GOV-02 read axis (A5): Claim reads require a host-injected actor AND are
 * filtered by the bank authorization matrix for that actor's role. An actor
 * that can read none of the present claims is refused with E_BANK_FORBIDDEN.
 */
export function readClaims({ memoryRoot, actor = null, now = () => new Date() }) {
  if (!actor || typeof actor.kind !== 'string' || actor.kind === '') {
    throw new GovernanceError('E_ACTOR_REQUIRED', '读 Claim 需要宿主 actor（禁止匿名读）。', undefined, 401);
  }
  const role = actor.kind;
  if (!BANK_ROLES.includes(role)) {
    throw new GovernanceError('E_BANK_FORBIDDEN', `未知 actor 角色：${role}`, undefined, 403);
  }
  const result = readClaimsForHost({ memoryRoot });
  const scopeOf = new Map(listBanks({ memoryRoot }).map((bank) => [bank.bankId, bank.scope]));
  const readable = [];
  const denied = [];
  for (const claim of result.items) {
    const scope = scopeOf.get(claim.bankId) ?? null;
    const decision = canBankAccess({ role, action: 'read', scope });
    if (decision.allowed) readable.push(claim);
    else denied.push({ id: claim.id, bankId: claim.bankId ?? null });
  }
  if (result.items.length > 0 && readable.length === 0) {
    appendBankAudit(memoryRoot, { schema: 'bank-audit/v1', at: nowIso(now), role, action: 'read', scope: null, allowed: false, denied: true, code: 'E_BANK_FORBIDDEN', deniedCount: denied.length, reason: 'read-axis' });
    auditRow(memoryRoot, { action: 'denied', recordId: denied[0]?.id ?? null, readerTier: role, now, extra: { code: 'E_BANK_FORBIDDEN', readAxis: true } });
    throw new GovernanceError('E_BANK_FORBIDDEN', `读轴越权：role=${role} 可读 0/${result.items.length} 条（bank/scope 授权矩阵拒绝）。`, { role, deniedCount: denied.length }, 403);
  }
  // A5: read auditing for answer/recall 生产路径 is written there (not on every
  // internal readClaims call — that would turn panel reads into audit noise).
  return { ...result, items: readable, total: result.items.length, deniedCount: denied.length };
}

/** Append a claim (idempotent by id: same id+content returns existing). */
export function appendClaim({ memoryRoot, claim, now = () => new Date() }) {
  const normalized = normalizeClaim({ ...claim, createdAt: claim?.createdAt ?? nowIso(now), updatedAt: nowIso(now) });
  const existing = readClaimsForHost({ memoryRoot }).items.find((item) => item.id === normalized.id);
  let next = normalized;
  if (existing) {
    const sameContent = existing.content === normalized.content
      && JSON.stringify(existing.evidence?.items ?? []) === JSON.stringify(normalized.evidence?.items ?? []);
    if (sameContent) {
      return { ok: true, appended: false, claim: existing, file: claimsPathOf(memoryRoot) };
    }
    // GOV-05: append-only version chain — v1 stays on disk, new row is claimVersion+1.
    const prevVersion = Number.isInteger(existing.claimVersion) ? existing.claimVersion : 1;
    next = normalizeClaim({
      ...normalized,
      claimVersion: prevVersion + 1,
      supersedes: [...new Set([...(existing.supersedes ?? []), prevVersion])],
      createdAt: existing.createdAt ?? normalized.createdAt,
      updatedAt: nowIso(now),
    });
  }
  const file = claimsPathOf(memoryRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(next)}\n`, 'utf8');
  return { ok: true, appended: true, claim: next, file };
}

/**
 * GOV-05 claim.verify — host-internal writer (NOT a panel action).
 * CAS on expectedVersion (== current max claimVersion); increments verifyCount,
 * recomputes trustScore server-side, appends a new version (append-only).
 */
export function claimVerify({ memoryRoot, claimId, expectedVersion, verifier = 'host', actor = null, now = () => new Date() } = {}) {
  const role = actor?.kind ?? null;
  if (role === null || role === '') throw new GovernanceError('E_ACTOR_REQUIRED', 'claim.verify 需要宿主 actor。', undefined, 401);
  if (role !== 'host') throw new GovernanceError('E_BANK_FORBIDDEN', 'claim.verify 只允许 host 内部写入器（不经面板动作面）。', { role }, 403);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new GovernanceError('E_EXPECTED_VERSION_REQUIRED', 'claim.verify 需要 expectedVersion（正整数 CAS）。', undefined, 400);
  }
  const id = String(claimId ?? '');
  if (id === '') throw new GovernanceError('E_CLAIM_ID', 'claim.verify 需要 claimId。', undefined, 400);
  const all = readClaimsForHost({ memoryRoot }).items.filter((item) => item.id === id);
  if (all.length === 0) throw new GovernanceError('E_CLAIM_NOT_FOUND', `claim 不存在：${id}`, undefined, 404);
  const latest = all.reduce((best, item) => ((item.claimVersion ?? 1) > (best.claimVersion ?? 1) ? item : best), all[0]);
  const currentVersion = Number.isInteger(latest.claimVersion) ? latest.claimVersion : 1;
  if (currentVersion !== expectedVersion) {
    throw new GovernanceError('E_CAS_CONFLICT', `claim 版本冲突：expected=${expectedVersion} current=${currentVersion}`, { expectedVersion, currentVersion }, 409);
  }
  const verifyCount = (Number.isInteger(latest.verifyCount) ? latest.verifyCount : 0) + 1;
  const score = trustScoreAt({ sourceTier: latest.sourceTier, verifyCount, createdAt: latest.createdAt, now });
  const next = normalizeClaim({
    ...latest,
    claimVersion: currentVersion + 1,
    verifyCount,
    trustScore: score.trustScore,
    supersedes: [...new Set([...(latest.supersedes ?? []), currentVersion])],
    updatedAt: nowIso(now),
    audit: { ...(latest.audit ?? {}), lastVerifiedBy: String(verifier), lastVerifiedAt: nowIso(now) },
  });
  const file = claimsPathOf(memoryRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(next)}\n`, 'utf8');
  auditRow(memoryRoot, { action: 'verify', recordId: id, readerTier: role, now, extra: { claimVersion: next.claimVersion, verifyCount, verifier: String(verifier) } });
  return { ok: true, claim: next, claimVersion: next.claimVersion, verifyCount, trustScore: next.trustScore, file };
}

/** Queue a claim awaiting human review (EA-09: never land it as active first). */
export function enqueueReview({ memoryRoot, item, now = () => new Date() }) {
  const file = path.join(path.resolve(String(memoryRoot)), '.longlive', 'review', 'queue.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ schema: 'review-queue/v1', state: 'pending', ...item, createdAt: nowIso(now) });
  fs.appendFileSync(file, `${line}\n`, 'utf8');
  return { file, item: JSON.parse(line) };
}

/** Reject client-supplied trust/state inputs (GOV-03 P0). */
export function assertNoTrustInput(claim) {
  const value = claim && typeof claim === 'object' ? claim : {};
  const forbidden = ['sourceTier', 'trustScore', 'verifyCount', 'claimVersion'].filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (forwardState(value.state)) forbidden.push('state');
  if (forbidden.length > 0) {
    throw new GovernanceError('E_TRUST_INPUT_FORBIDDEN', `trust/state 字段只能由服务端计算，禁止 payload 直传：${forbidden.join(',')}`, { forbidden }, 400);
  }
}

function forwardState(state) {
  return state !== undefined && state !== null && !['active', 'disputed'].includes(state);
}

function bankScopeOf(memoryRoot, bankId) {
  const bank = listBanks({ memoryRoot }).find((entry) => entry.bankId === bankId);
  return bank ? bank.scope : null;
}

function auditRow(memoryRoot, { action, recordId, readerTier, extra, now }) {
  try {
    appendAuditRecord({
      memoryRoot,
      action,
      recordId: recordId ?? null,
      readerTier: readerTier ?? null,
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      now,
      extra,
    });
  } catch {
    /* audit must not be silently lost: callers still fail closed on the primary path */
  }
}

/**
 * Write path (GOV-01/03): role + scope are SERVER-derived from the host actor
 * (token-bound); bank scope must agree with the requested scope; trust fields
 * are computed by the server and client-supplied values are rejected.
 */
export function writeClaim({ memoryRoot, claim, role: claimedRole = null, scope: claimedScope = null, actor = null, now = () => new Date() }) {
  // 1) actor is host-injected; missing actor never falls back to a role.
  if (!actor || typeof actor.kind !== 'string' || actor.kind === '') {
    auditRow(memoryRoot, { action: 'denied', recordId: claim?.id, readerTier: 'unknown', now, extra: { code: 'E_ACTOR_REQUIRED' } });
    throw new GovernanceError('E_ACTOR_REQUIRED', 'actor 必须由宿主注入（令牌绑定），缺省拒绝。', undefined, 401);
  }
  const role = actor.kind;
  // Caller-declared role/scope are NEVER trusted: any mismatch with the token actor
  // or the bank's scope is a forgery attempt (GOV-01).
  if (claimedRole !== null && claimedRole !== role) {
    auditRow(memoryRoot, { action: 'denied', recordId: claim?.id, readerTier: role, now, extra: { code: 'E_BANK_FORBIDDEN', claimedRole } });
    throw new GovernanceError('E_BANK_FORBIDDEN', `role 伪造：payload=${claimedRole} actor=${role}`, { claimedRole, role }, 403);
  }
  if (!BANK_ROLES.includes(role)) {
    auditRow(memoryRoot, { action: 'denied', recordId: claim?.id, readerTier: null, now, extra: { code: 'E_BANK_ROLE' } });
    throw new GovernanceError('E_BANK_ROLE', `未知 actor 角色：${role}`, undefined, 403);
  }
  const claimId = claim?.id ?? null;
  // 2) trust/state inputs must never come from the payload (denied attempt is audited).
  try {
    assertNoTrustInput(claim);
  } catch (error) {
    auditRow(memoryRoot, { action: 'denied', recordId: claim?.id ?? null, readerTier: role, now, extra: { code: error.code ?? 'E_TRUST_INPUT_FORBIDDEN' } });
    throw error;
  }
  // 3) bank/scope are server-derived: claim.bankId decides scope, caller cannot override.
  const bankId = typeof claim?.bankId === 'string' ? claim.bankId : 'bank:project';
  const scope = bankScopeOf(memoryRoot, bankId);
  if (scope === null) {
    auditRow(memoryRoot, { action: 'denied', recordId: claimId, readerTier: role, now, extra: { code: 'E_BANK_FORBIDDEN', bankId } });
    throw new GovernanceError('E_BANK_FORBIDDEN', `未知 bank：${bankId}`, { bankId }, 403);
  }
  if (claimedScope !== null && claimedScope !== scope) {
    auditRow(memoryRoot, { action: 'denied', recordId: claimId, readerTier: role, now, extra: { code: 'E_BANK_FORBIDDEN', claimedScope, bankId } });
    throw new GovernanceError('E_BANK_FORBIDDEN', `scope 伪造：payload=${claimedScope} bank=${bankId} scope=${scope}`, { claimedScope, bankId, scope }, 403);
  }
  const decision = canBankAccess({ role, action: 'write', scope });
  if (!decision.allowed) {
    appendBankAuditFor(memoryRoot, { role, scope, claimId, now });
    auditRow(memoryRoot, { action: 'denied', recordId: claimId, readerTier: role, now, extra: { code: 'E_BANK_FORBIDDEN', bankId, scope } });
    throw new GovernanceError('E_BANK_FORBIDDEN', `bank 越权：role=${role} bank=${bankId} scope=${scope}`, decision, 403);
  }
  // 4) server computes trust/state/sourceTier (client values already rejected).
  const score = trustScoreAt({ sourceTier: role, verifyCount: 0, createdAt: null, now });
  const normalized = normalizeClaim({
    ...claim,
    bankId,
    sourceTier: role,
    trustScore: score.trustScore,
    verifyCount: 0,
    claimVersion: 1,
    state: 'active',
  });
  if (decision.requiresHumanReview) {
    const queued = enqueueReview({ memoryRoot, now, item: { kind: 'claim', target: { kind: 'claim', id: normalized.id }, claim: normalized, reason: 'E_HUMAN_REVIEW_REQUIRED', requestedBy: role } });
    auditRow(memoryRoot, { action: 'review', recordId: normalized.id, readerTier: role, now, extra: { code: 'E_HUMAN_REVIEW_REQUIRED' } });
    return { ok: true, appended: false, queued: true, requiresHumanReview: true, code: 'E_HUMAN_REVIEW_REQUIRED', review: queued.item };
  }
  const result = appendClaim({ memoryRoot, claim: normalized, now });
  auditRow(memoryRoot, { action: 'write', recordId: normalized.id, readerTier: role, now, extra: { bankId, scope, trustScore: normalized.trustScore } });
  return { ...result, requiresHumanReview: false };
}

function appendBankAuditFor(memoryRoot, { role, scope, claimId, now }) {
  try {
    const dir = path.join(path.resolve(String(memoryRoot)), '.longlive', 'audit');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'bank.jsonl'), `${JSON.stringify({ schema: 'bank-audit/v1', at: nowIso(now), role, action: 'write', scope, allowed: false, denied: true, code: 'E_BANK_FORBIDDEN', recordId: claimId })}\n`, 'utf8');
  } catch {
    /* best effort */
  }
}

/** Map a runtime record (records.jsonl writer) to a Claim for the runtime consumer path. */
/** A5: server-derived producer tier. Incoming record.sourceTier is NEVER trusted. */
export function serverTierOfRecord(record) {
  const value = record && typeof record === 'object' ? record : {};
  const createdBy = String(value?.audit?.createdBy ?? '');
  if (createdBy === 'memory-note') return 'user';
  if (createdBy === 'activity-capture') return 'agent';
  if (createdBy.startsWith('capture')) return 'host';
  // Unknown producer => fail-safe agent (never silently escalate to host/user).
  return 'agent';
}

export function claimFromRecord(record, { now = () => new Date() } = {}) {
  const value = record && typeof record === 'object' ? record : {};
  const id = typeof value.id === 'string' && value.id.startsWith('clm_') ? value.id : `clm_${sha1Short(String(value.id ?? JSON.stringify(value)))}`;
  // A5: sourceTier + trustScore are SERVER-computed. Caller-supplied record.sourceTier/
  // trustScore/verifyCount/state are ignored (only evidence/anchors/content are data).
  const sourceTier = serverTierOfRecord(value);
  const createdAt = value.createdAt ?? nowIso(now);
  const score = trustScoreAt({ sourceTier, verifyCount: 0, createdAt, now });
  const bankId = sourceTier === 'user' || sourceTier === 'agent' || sourceTier === 'plugin' ? 'bank:user' : 'bank:project';
  return normalizeClaim({
    id,
    bankId,
    subject: value.subject ?? { entity: String(value.id ?? id) },
    content: value.content ?? '',
    kind: value.kind ?? 'fact',
    salience: value.salience,
    sourceTier,
    trustScore: score.trustScore,
    verifyCount: 0,
    claimVersion: 1,
    evidence: { version: Array.isArray(value.evidence) ? value.evidence.length : 0, items: Array.isArray(value.evidence) ? value.evidence : [] },
    state: 'active',
    project: value.project ?? null,
    anchors: Array.isArray(value.anchors) ? value.anchors : [],
    createdAt,
    updatedAt: nowIso(now),
    audit: { ...(value.audit ?? {}), bridgedFromRecords: true, serverDerivedTier: true },
  });
}

/** Runtime dual-write: every records write also lands a Claim + audit write row. */
export function appendClaimFromRecord({ memoryRoot, record, now = () => new Date() }) {
  const claim = claimFromRecord(record, { now });
  const result = appendClaim({ memoryRoot, claim, now });
  if (result.appended) {
    auditRow(memoryRoot, { action: 'write', recordId: claim.id, readerTier: claim.sourceTier, now, extra: { kind: 'claim-from-record', bridgeRecordId: record?.id ?? null } });
  }
  return { claim: result.claim ?? claim, appended: result.appended === true };
}

/** Migration helper: map one legacy records.jsonl row to a Claim (pure). */
export function claimFromLegacyRecord(row) {
  const value = row && typeof row === 'object' ? row : {};
  const legacyId = typeof value.id === 'string' ? value.id : `rec:${sha1Short(JSON.stringify(value))}`;
  const claimId = legacyId.startsWith('clm_') ? legacyId : `clm_${sha1Short(legacyId)}`;
  const evidenceItems = Array.isArray(value.evidence) ? value.evidence : [];
  return normalizeClaim({
    id: claimId,
    bankId: typeof value.bankId === 'string' ? value.bankId : 'bank:project',
    subject: value.subject ?? { entity: legacyId, attribute: null },
    content: value.content ?? '',
    kind: value.kind ?? 'fact',
    salience: value.salience,
    // 迁移不因缺字段提权：未知来源按 agent 处理（绝不升成 host）。
    sourceTier: ['user', 'host', 'agent', 'plugin'].includes(value.sourceTier) ? value.sourceTier : 'agent',
    trustScore: value.trustScore,
    evidence: {
      version: evidenceItems.length,
      items: evidenceItems.map((entry) => ({
        ...entry,
        verifier: entry.verifier ?? null,
        sourceDoc: entry.sourceDoc ?? 'records.jsonl',
      })),
    },
    conflict: value.conflict === true,
    conflict_with: Array.isArray(value.conflict_with) ? value.conflict_with : [],
    state: value.state ?? value.status ?? 'active',
    project: value.project ?? null,
    anchors: Array.isArray(value.anchors) ? value.anchors : [],
    review: value.review && typeof value.review === 'object' ? value.review : null,
    createdAt: value.createdAt ?? null,
    legacy: true,
    audit: {
      ...(value.audit ?? {}),
      migratedFrom: 'records.jsonl',
      migratedAt: nowIso(),
      sourceTierDefaulted: value.sourceTier === undefined,
    },
  });
}

export { sha256Hex };
