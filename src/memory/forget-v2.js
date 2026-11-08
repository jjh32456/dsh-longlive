// src/memory/forget-v2.js — M2-D：forget v2 门面（propose / execute / restore）
//
// 设计依据 §4.6（归档仅纯噪声/重复，重要事件永禁；沿用 forget.js 的备份→三问→
// rename→审计，不重写 forget.js）：
//   * propose = forget.js dry-run（只读，不建目录、不写审计）；
//   * execute = forget.js 执行（需 confirm:"FORGET"；保护卡由 retention 拒绝）；
//   * restore = 从 tombstones.md 的 recoverable 目标或 epochs/ 把卡移回原路径，
//     只 rename、不删除，写 1 行恢复审计（生命周期上「忘/恢复」两条审计）。
//
// 本模块不注册工具（见 Lead 拍板：不 expose 新工具）；入口在 admin 脚本。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendAuditRecord, resolveAuditKey, verifyAuditChain } from './audit-records.js';
import { memoryForget, DECAY_RULES } from './forget.js';
import { memoryError, memoryRootFromConfig, relativePath, resolveInside } from './paths.js';
import { isProtectedPath } from './retention.js';
import { readCardAnchors } from './card-anchors.js';
import {
  appendAudit, ensureDir, epochsDir, sha256File, tombstonesPath, writeFileAtomic,
} from './state.js';

export const FORGET_V2_SCHEMA = 'forget-v2/v1';
export const PURE_NOISE_PATTERNS = Object.freeze([
  /^\.longlive\/tool-output\//,
  /^\.tmp-test\//,
  /(^|\/)diag\//,
  /(^|\/)tmp\//,
]);

/** Pure-noise whitelist for the v2 archive path; anything else is never auto-archived. */
export function isPureNoisePath(relPath) {
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel === '') return false;
  return PURE_NOISE_PATTERNS.some((pattern) => pattern.test(rel));
}

/** Read-only proposal (delegates to forget.js dry-run). */
export function proposeForget(args = {}, config = {}) {
  return memoryForget({ ...args, confirm: undefined }, config);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function hmacHex(key, text) {
  return crypto.createHmac('sha256', key).update(String(text), 'utf8').digest('hex');
}

const TOMB_SIG_RE = /\s*\|\s*tombstonePrevHash:\s*(genesis|[0-9a-f]{64})\s*\|\s*tombstoneHash:\s*([0-9a-f]{64})\s*\|\s*tombstoneHmac:\s*([0-9a-f]{64})$/;

function signTombstoneLine(line, { key, previousHash }) {
  if (typeof key !== 'string' || key === '') throw new Error('E_NO_KEY');
  const hash = sha256Hex(`${previousHash}\n${line}`);
  const hmac = hmacHex(key, hash);
  return {
    line: `${line} | tombstonePrevHash: ${previousHash} | tombstoneHash: ${hash} | tombstoneHmac: ${hmac}`,
    hash,
  };
}

/** Verify every tombstone line: signature required, chain must be continuous. */
export function verifyTombstoneLedger(root, key) {
  const file = tombstonesPath(root);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    return { ok: false, code: 'E_TOMBSTONE_MISSING', lines: 0 };
  }
  let previous = 'genesis';
  let lines = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith('- ')) continue;
    lines += 1;
    const match = raw.match(TOMB_SIG_RE);
    if (!match) return { ok: false, code: 'E_TOMBSTONE_UNSIGNED', line: lines };
    const base = raw.slice(0, match.index);
    const expectedHash = sha256Hex(`${previous}\n${base}`);
    if (match[2] !== expectedHash) return { ok: false, code: 'E_TOMBSTONE_CHAIN_BROKEN', line: lines };
    if (match[1] !== previous) return { ok: false, code: 'E_TOMBSTONE_CHAIN_BROKEN', line: lines };
    const expectedHmac = hmacHex(key, expectedHash);
    if (match[3] !== expectedHmac) return { ok: false, code: 'E_TOMBSTONE_HMAC_INVALID', line: lines };
    previous = match[2];
  }
  return { ok: true, code: 'OK', lines, lastHash: previous };
}

function lastSignedTombstoneHash(text) {
  let previous = 'genesis';
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.startsWith('- ')) continue;
    const match = raw.match(TOMB_SIG_RE);
    if (match) previous = match[2];
  }
  return previous;
}

function auditDenied({ root, action, recordId, code, extra = {}, now, skipHead = false }) {
  try {
    appendAuditRecord({
      memoryRoot: root,
      action,
      recordId: recordId ?? null,
      readerTier: 'host',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
      extra: { code, ...extra },
      skipHead,
    });
  } catch { /* denial audit best effort; fail closed regardless */ }
}

/** Production gate: forget/restore must notice a broken audit chain, not only admins. */
function requireAuditChain(root, now, action, recordId) {
  const chain = verifyAuditChain({ memoryRoot: root });
  if (chain.ok !== true) {
    auditDenied({
      root,
      action,
      recordId,
      code: 'E_AUDIT_CHAIN_BROKEN',
      extra: { chainViolation: true, auditChain: chain },
      now,
      skipHead: true,
    });
    throw memoryError('E_AUDIT_CHAIN_BROKEN', '审计哈希链/头锚损坏：拒绝遗忘/恢复（fail-closed）', { auditChain: chain });
  }
  return chain;
}

function requireKey(root, now, action, recordId) {
  const resolved = resolveAuditKey(root);
  if (resolved.key === null) {
    auditDenied({ root, action, recordId, code: 'E_NO_KEY', extra: { hmacResidual: 'hostkey-unavailable' }, now });
    throw memoryError('E_NO_KEY', '遗忘执行/恢复需要宿主 auditKey（env 或 .longlive/.hostkey）；未提供 key，fail-closed');
  }
  return resolved.key;
}

function sourceAnchorFor(memoryRoot, rel) {
  try {
    const link = readCardAnchors(memoryRoot).get(String(rel ?? '').replace(/\\/g, '/'));
    const anchor = Array.isArray(link?.anchors) ? link.anchors.find((item) => item
      && (item.kind === 'session_turn' || item.kind === 'file_line')) : null;
    if (anchor) return { anchor, sourceEventIds: Array.isArray(link.sourceEventIds) ? link.sourceEventIds : [] };
  } catch { /* legacy sidecar unreadable: no fake anchor */ }
  return {
    anchor: { kind: 'legacy', status: 'missing', reason: 'no-explicit-source-anchor' },
    sourceEventIds: [],
  };
}

function richTombstoneLine({ prefix, moved, planned, source, rule, params }) {
  const backup = { path: moved.backupRel, sha256: moved.sha256 };
  return `${prefix} | ${moved.path} | ${moved.kind} | reason: ${planned.epitaph.reason}` +
    ` | affects: ${planned.epitaph.affects} | stillUseful: ${planned.epitaph.stillUseful}` +
    ` | recoverable: ${moved.destRel} | sha256: ${moved.sha256}` +
    ` | sourceAnchor: ${JSON.stringify(source.anchor)}` +
    ` | sourceEventIds: ${JSON.stringify(source.sourceEventIds)}` +
    ` | rule: ${JSON.stringify(rule)} | params: ${JSON.stringify(params)}` +
    ` | backup: ${JSON.stringify(backup)}`;
}

function enrichForgottenLedger({ root, result, anchorsByPath, args, now, key }) {
  const tombFile = tombstonesPath(root);
  if (!fs.existsSync(tombFile)) return { enriched: 0, missingLines: [] };
  let text = fs.readFileSync(tombFile, 'utf8');
  const lines = text.split(/\r?\n/);
  let previousSigned = lastSignedTombstoneHash(text);
  let enriched = 0;
  const missingLines = [];
  for (const moved of Array.isArray(result.archived) ? result.archived : []) {
    const planned = (Array.isArray(result.proposals) ? result.proposals : []).find((item) => item.path === moved.path);
    if (!planned) { missingLines.push(moved.path); continue; }
    const marker = ` | ${moved.path} | `;
    const index = lines.findIndex((line) => line.startsWith('- ') && line.includes(marker));
    if (index < 0) { missingLines.push(moved.path); continue; }
    const cut = lines[index].indexOf(marker);
    const prefix = lines[index].slice(0, cut);
    const source = anchorsByPath.get(moved.path) ?? sourceAnchorFor(root, moved.path);
    const params = {
      today: result.today ?? null,
      confirm: 'FORGET',
      by: typeof args?.by === 'string' && args.by !== '' ? args.by : 'admin',
      at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    };
    const unsigned = richTombstoneLine({ prefix, moved, planned, source, rule: DECAY_RULES, params });
    const signed = signTombstoneLine(unsigned, { key, previousHash: previousSigned });
    lines[index] = signed.line;
    previousSigned = signed.hash;
    enriched += 1;
    appendAuditRecord({
      memoryRoot: root,
      action: 'archive',
      recordId: moved.path,
      readerTier: 'host',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      at: params.at,
      extra: {
        forgetV2: 'tombstone-enriched',
        layer: 'L2',
        archived: moved.destRel,
        backup: { path: moved.backupRel, sha256: moved.sha256 },
        sha256: moved.sha256,
        sourceAnchor: source.anchor,
        sourceEventIds: source.sourceEventIds,
        rule: DECAY_RULES,
        params,
      },
    });
  }
  if (enriched > 0) {
    // Atomic rewrite + read-back verify after the append-only backup already exists.
    writeFileAtomic(root, tombFile, `${lines.join('\n')}`, { backup: false, now });
  }
  return { enriched, missingLines };
}

/**
 * Execute forgets (confirm gate stays in forget.js). P0: tombstone lines carry
 * source anchor + backup sha + frozen rule/params; audit rows carry hash chain.
 */
export function executeForget(args = {}, config = {}) {
  const root = memoryRootFromConfig(config);
  const now = config.now instanceof Date ? config.now : new Date();
  const key = requireKey(root, now, 'forget-denied', null);
  requireAuditChain(root, now, 'forget-denied', null);
  const plan = proposeForget(args, config);
  const anchorsByPath = new Map();
  for (const item of Array.isArray(plan.proposals) ? plan.proposals : []) {
    anchorsByPath.set(item.path, sourceAnchorFor(root, item.path));
  }
  const result = memoryForget({ ...args, confirm: 'FORGET' }, config);
  if (result?.applied === true) {
    const enriched = enrichForgottenLedger({ root, result, anchorsByPath, args, now, key });
    return { ...result, tombstoneEnriched: enriched.enriched, tombstoneEnrichMissing: enriched.missingLines };
  }
  return result;
}

function parseJsonField(line, name) {
  const marker = `${name}: `;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const tail = line.slice(start + marker.length);
  // Structured fields are compact JSON and end at the next " | " delimiter.
  const end = tail.indexOf(' | ');
  const raw = (end >= 0 ? tail.slice(0, end) : tail).trim();
  try { return JSON.parse(raw); } catch { return null; }
}

function parseTombstoneFor(root, rel) {
  const file = tombstonesPath(root);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const normalized = String(rel).replace(/\\/g, '/');
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    if (!line.includes(`| ${normalized} |`)) continue;
    const recoverable = line.match(/recoverable:\s*([^|\n]+)/);
    const sha = line.match(/\bsha256:\s*([0-9a-f]{64})/);
    return {
      line,
      recoverable: recoverable ? recoverable[1].trim() : null,
      sha256: sha ? sha[1] : null,
      sourceAnchor: parseJsonField(line, 'sourceAnchor'),
      sourceEventIds: parseJsonField(line, 'sourceEventIds'),
      backup: parseJsonField(line, 'backup'),
    };
  }
  return null;
}

function auditRestore({ root, recordId, from, to, by, now }) {
  try {
    appendAuditRecord({
      memoryRoot: root,
      action: 'restore',
      recordId,
      readerTier: 'host',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      at: now.toISOString(),
      extra: { from, to, by },
    });
  } catch {
    /* audit best-effort; the rename already happened and audit.log records it */
  }
}

/**
 * Restore a forgotten card: tombstones.md 的 recoverable 目标优先，其次 epochs/。
 * 只 rename（不删、不覆盖已有卡），写 1 行恢复审计 + 1 行 audit.log。
 */
export function restoreForgotten({ root, path: relPath, by = 'admin', now = new Date() } = {}) {
  const memoryRoot = String(root ?? '');
  if (memoryRoot === '') throw memoryError('E_MEMORY_ROOT', 'restoreForgotten requires root');
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel === '') throw memoryError('E_RESTORE_PATH', 'restore 需要原卡路径（topics/… 或 journal/…）');
  const target = resolveInside(memoryRoot, rel);
  if (fs.existsSync(target)) {
    throw memoryError('E_RESTORE_TARGET', `恢复目标已存在（不覆盖）：${rel}`);
  }
  const key = requireKey(memoryRoot, now, 'restore-denied', rel);
  requireAuditChain(memoryRoot, now, 'restore-denied', rel);
  const tomb = parseTombstoneFor(memoryRoot, rel);
  if (!tomb) {
    auditDenied({ root: memoryRoot, action: 'restore-denied', recordId: rel, code: 'E_TOMBSTONE_INCOMPLETE', extra: { reason: 'tombstone-missing' }, now });
    throw memoryError('E_TOMBSTONE_INCOMPLETE', `恢复被拒绝：tombstones.md 找不到 ${rel} 的完整条目`);
  }
  if (!tomb.backup || typeof tomb.backup.path !== 'string' || tomb.backup.path === ''
    || typeof tomb.backup.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tomb.backup.sha256)) {
    auditDenied({ root: memoryRoot, action: 'restore-denied', recordId: rel, code: 'E_TOMBSTONE_INCOMPLETE', extra: { reason: 'missing-backup-field', tombstone: tomb.line }, now });
    throw memoryError('E_TOMBSTONE_INCOMPLETE', `恢复被拒绝：tombstone 缺 backup{path,sha256}：${rel}`);
  }
  const ledger = verifyTombstoneLedger(memoryRoot, key);
  if (!ledger.ok) {
    auditDenied({ root: memoryRoot, action: 'restore-denied', recordId: rel, code: ledger.code, extra: { reason: 'tombstone-signature-chain', ledger }, now });
    throw memoryError(ledger.code, `恢复被拒绝：tombstone 签名/哈希链无效（${ledger.code}, line=${ledger.line ?? '-'}）`);
  }
  let backupVerified = null;
  {
    const expected = tomb.backup.sha256;
    let actual = null;
    try { actual = sha256File(resolveInside(memoryRoot, tomb.backup.path)); } catch { actual = null; }
    if (actual === null || actual !== expected) {
      auditDenied({
        root: memoryRoot,
        action: 'restore-denied',
        recordId: rel,
        code: 'E_RESTORE_BACKUP_MISMATCH',
        extra: { backup: tomb.backup, expectedSha256: expected, actualSha256: actual, sourceAnchor: tomb.sourceAnchor ?? null },
        now,
      });
      throw memoryError('E_RESTORE_BACKUP_MISMATCH', `恢复前备份校验失败：${rel}（backup=${tomb.backup.path}）`, {
        expectedSha256: expected,
        actualSha256: actual,
      });
    }
    backupVerified = true;
  }
  let from = null;
  let source = null;
  if (tomb?.recoverable) {
    const candidate = resolveInside(memoryRoot, tomb.recoverable);
    if (fs.existsSync(candidate)) {
      source = candidate;
      from = tomb.recoverable;
    }
  }
  if (!source) {
    const epochCandidate = path.join(epochsDir(memoryRoot), rel);
    if (fs.existsSync(epochCandidate)) {
      source = epochCandidate;
      from = relativePath(memoryRoot, epochCandidate);
    }
  }
  if (!source) throw memoryError('E_RESTORE_NOT_FOUND', `找不到可恢复的副本：${rel}（tombstones recoverable / epochs 均未命中）`);
  if (isProtectedPath({ memoryRoot, relPath: rel }) === true) {
    // 恢复本身是“加回”而不是“删除”，保护卡也允许恢复（保留 fail-safe 只在删除方向）。
  }
  ensureDir(memoryRoot, path.dirname(target));
  fs.renameSync(source, target);
  appendAudit(memoryRoot, { action: 'memory_forget_restore', object: rel, result: `from=${from} by=${by}`, now });
  auditRestore({ root: memoryRoot, recordId: rel, from, to: rel, by, now });
  try {
    appendAuditRecord({
      memoryRoot,
      action: 'restore',
      recordId: rel,
      readerTier: 'host',
      questionId: 'unknown',
      expectedTurns: null,
      answerText: null,
      at: now.toISOString(),
      extra: {
        forgetV2: 'restore-enriched',
        from,
        to: rel,
        by,
        backup: tomb?.backup ?? null,
        backupSha256: tomb?.backup?.sha256 ?? tomb?.sha256 ?? null,
        backupVerified,
        sourceAnchor: tomb?.sourceAnchor ?? null,
        sourceEventIds: tomb?.sourceEventIds ?? [],
      },
    });
  } catch { /* best effort; rename + audit.log already recorded */ }
  return { ok: true, schema: FORGET_V2_SCHEMA, status: 'restored', path: rel, from, to: rel, restored: true, backupVerified };
}

/** Facade: mode=propose|execute|restore. */
export function forgetV2({ mode = 'propose', path: relPath = null, by = 'admin', now = new Date(), ...rest } = {}, config = {}) {
  if (mode === 'propose') return { schema: FORGET_V2_SCHEMA, mode, ...proposeForget(rest, config) };
  if (mode === 'execute') return { schema: FORGET_V2_SCHEMA, mode, ...executeForget(rest, config) };
  if (mode === 'restore') return { schema: FORGET_V2_SCHEMA, mode, ...restoreForgotten({ root: config.memoryRoot, path: relPath, by, now }) };
  throw memoryError('E_FORGET_V2_MODE', `未知 mode=${mode}（propose|execute|restore）`);
}
