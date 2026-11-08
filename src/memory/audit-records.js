// src/memory/audit-records.js — 1.8.0 A5 前置：读/写审计行（#22 audit-records 生产者）
//
// 字段（v2.8.5 / answer-guard 口径）：
//   questionId   答题标识（answer-guard = ag-001…）；缺失时显式 'unknown'，绝不臆造
//   expectedTurns 该题期望覆盖的轮数（整数；缺失 null）
//   answerText    该次回答正文（缺失 null；不截断证据时由调用方保证完整）
// 每行 schema='audit-records/v1'，供 #22 /api/longlive/audit/records 只读展示。
//
// P0 遗忘链：每行追加 rowHash（sha256(canonical row)）与 prevRowHash（前一行链）；
// 若宿主 auditKey 可读（env / .hostkey），再附 HMAC-SHA256。缺 key 不阻塞写，
// 但显式标 hmac:null + hmacResidual:'hostkey-unavailable'，不冒充已签名。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../actions/fs.js';

export const AUDIT_RECORDS_SCHEMA = 'audit-records/v1';
export const AUDIT_HMAC_ENV = 'DSH_LONGLIVE_AUDIT_KEY';
const HOSTKEY_REL = ['.longlive', '.hostkey'];
const CHAIN_FIELDS = new Set(['rowHash', 'prevRowHash', 'hmac', 'hmacAlgo', 'hmacKey', 'hmacResidual']);

export function auditRecordsPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'audit', 'records.jsonl');
}

export function auditHeadPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'audit', 'records.head.json');
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function canonicalRow(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row)) {
    if (!CHAIN_FIELDS.has(key)) clean[key] = value;
  }
  return stableStringify(clean);
}

function rowHashOf(row) {
  return sha256Hex(canonicalRow(row));
}

/** Optional host key: env first, then the persisted fallback. Never creates a key. */
export function resolveAuditKey(memoryRoot, env = process.env) {
  const fromEnv = env?.[AUDIT_HMAC_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { key: fromEnv.trim(), source: 'env' };
  try {
    const text = fs.readFileSync(path.join(path.resolve(String(memoryRoot)), ...HOSTKEY_REL), 'utf8').trim();
    if (text !== '') return { key: text, source: 'hostkey-file' };
  } catch {
    /* absent: caller records the residual */
  }
  return { key: null, source: 'absent' };
}

function lastChain(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text === '') return { prevRowHash: 'genesis', seq: 0 };
    const lines = text.split(/\r?\n/);
    const lastRaw = lines[lines.length - 1];
    let last = null;
    try { last = JSON.parse(lastRaw); } catch { /* legacy/corrupt tail */ }
    return {
      prevRowHash: typeof last?.rowHash === 'string' && /^[0-9a-f]{64}$/.test(last.rowHash)
        ? last.rowHash
        : sha256Hex(lastRaw),
      seq: lines.length,
    };
  } catch {
    return { prevRowHash: 'genesis', seq: 0 };
  }
}

function writeHead(memoryRoot, { rows, lastHash, now }) {
  const file = auditHeadPathOf(memoryRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = {
    schema: 'audit-head/v1',
    rows,
    lastHash,
    updatedAt: nowIso(now),
  };
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(head)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return head;
}

/** Read-side normalization: missing fields stay explicit (unknown/null), never fabricated. */
export function normalizeAuditRecordRow(row) {
  const value = row && typeof row === 'object' ? row : {};
  return {
    schema: AUDIT_RECORDS_SCHEMA,
    questionId: typeof value.questionId === 'string' && value.questionId !== '' ? value.questionId : 'unknown',
    expectedTurns: Number.isInteger(value.expectedTurns) && value.expectedTurns >= 0 ? value.expectedTurns : null,
    answerText: typeof value.answerText === 'string' ? value.answerText : null,
    recordId: typeof value.recordId === 'string' ? value.recordId : null,
    readerTier: typeof value.readerTier === 'string' ? value.readerTier : null,
    action: typeof value.action === 'string' ? value.action : 'read',
    at: typeof value.at === 'string' ? value.at : null,
  };
}

/** Append one audit row (fsync so a crash cannot lose an answered question's audit). */
export function appendAuditRecord(input = {}) {
  const memoryRoot = String(input.memoryRoot ?? '');
  if (memoryRoot === '') throw new Error('E_MEMORY_ROOT: appendAuditRecord requires memoryRoot');
  const row = {
    schema: AUDIT_RECORDS_SCHEMA,
    questionId: typeof input.questionId === 'string' && input.questionId !== '' ? input.questionId : 'unknown',
    expectedTurns: Number.isInteger(input.expectedTurns) && input.expectedTurns >= 0 ? input.expectedTurns : null,
    answerText: typeof input.answerText === 'string' ? input.answerText : null,
    recordId: typeof input.recordId === 'string' ? input.recordId : null,
    readerTier: typeof input.readerTier === 'string' ? input.readerTier : null,
    action: typeof input.action === 'string' ? input.action : 'read',
    at: typeof input.at === 'string' ? input.at : nowIso(input.now),
    ...(input.extra && typeof input.extra === 'object' ? input.extra : {}),
  };
  const file = auditRecordsPathOf(memoryRoot);
  const chain = lastChain(file);
  row.prevRowHash = chain.prevRowHash;
  row.rowHash = rowHashOf(row);
  const resolved = resolveAuditKey(memoryRoot);
  if (resolved.key !== null) {
    row.hmac = crypto.createHmac('sha256', resolved.key).update(row.rowHash, 'utf8').digest('hex');
    row.hmacAlgo = 'sha256';
    row.hmacKey = resolved.source;
  } else {
    row.hmac = null;
    row.hmacAlgo = 'sha256';
    row.hmacKey = null;
    row.hmacResidual = 'hostkey-unavailable';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(row)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (input.skipHead !== true) {
      writeHead(memoryRoot, { rows: chain.seq + 1, lastHash: row.rowHash, now: row.at });
    }
  } catch { /* head is an early-warning anchor; a head failure must not lose the row */ }
  return { ok: true, row, file, chain: { prevRowHash: row.prevRowHash, seq: chain.seq + 1 } };
}

/**
 * Verify the append-only audit hash chain (and HMAC when a key is available).
 * Legacy rows without rowHash are reported as legacy, not silently trusted.
 */
export function verifyAuditChain({ memoryRoot, auditKey = null } = {}) {
  const file = auditRecordsPathOf(memoryRoot);
  let text = '';
  let fileMissing = false;
  try { text = fs.readFileSync(file, 'utf8'); } catch { fileMissing = true; text = ''; }
  const rows = text.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  });
  let head = null;
  let headPresent = false;
  try {
    head = JSON.parse(fs.readFileSync(auditHeadPathOf(memoryRoot), 'utf8'));
    headPresent = true;
  } catch {
    head = null;
  }
  const errors = [];
  const lastParsed = [...rows].reverse().find((row) => row && typeof row.rowHash === 'string');
  if (headPresent) {
    if (!Number.isInteger(head?.rows) || head.rows !== rows.length) errors.push({ code: 'E_AUDIT_HEAD_ROWS', headRows: head?.rows ?? null, rows: rows.length });
    if (typeof head?.lastHash !== 'string' || head.lastHash !== (lastParsed?.rowHash ?? null)) {
      errors.push({ code: 'E_AUDIT_HEAD_LAST', headLastHash: head?.lastHash ?? null, lastHash: lastParsed?.rowHash ?? null });
    }
  }
  if (fileMissing && headPresent && head?.rows > 0) errors.push({ code: 'E_AUDIT_HEAD_ROWS', headRows: head.rows, rows: 0 });
  const key = auditKey !== null
    ? { key: String(auditKey), source: 'injected' }
    : resolveAuditKey(memoryRoot);
  let previous = null;
  let legacyRows = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) { errors.push({ index, code: 'E_JSON' }); continue; }
    if (typeof row.rowHash !== 'string') { legacyRows += 1; continue; }
    if (row.rowHash !== rowHashOf(row)) errors.push({ index, code: 'E_AUDIT_ROW_HASH' });
    // The first chained row may follow legacy rows; its prevRowHash is the
    // legacy-tail hash or genesis. Later rows must chain strictly.
    if (previous !== null && row.prevRowHash !== previous) errors.push({ index, code: 'E_AUDIT_CHAIN_PREV' });
    if (typeof row.hmac === 'string' && key.key !== null) {
      const expected = crypto.createHmac('sha256', key.key).update(row.rowHash, 'utf8').digest('hex');
      if (row.hmac !== expected) errors.push({ index, code: 'E_AUDIT_HMAC' });
    }
    previous = row.rowHash;
  }
  return {
    ok: errors.length === 0,
    file,
    present: true,
    rows: rows.length,
    legacyRows,
    headPresent,
    headRows: head?.rows ?? null,
    headLastHash: head?.lastHash ?? null,
    hmacKeySource: key.source,
    hmacKeyPresent: key.key !== null,
    errors,
  };
}
