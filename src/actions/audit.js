// src/actions/audit.js — HMAC 链式审计（M2-G / §12.4 / §12.7）
//
// 一行一个 JSON：
//   {seq,ts,actorId,action,target,beforeHash,afterHash,prevHash,hmac}
// - seq 严格 +1（从 1 起），prevHash 链接上一行 hmac（首行 GENESIS）；
// - hmac = HMAC-SHA256(auditKey, 规范化前 8 字段)，auditKey **仅宿主内存**；
// - 逆序/断链/篡改 → E_AUDIT_BROKEN（校验失败，绝不静默）；
// - actorId 只记哈希前缀，正文不记（隐私）。
// 审计 key 不落盘：跨重启延续审计链需要独立服务账号 + OS 凭据库（§13 第二层，1.6.9 不做）。

import path from 'node:path';

import { GENESIS_HASH, actionsDir, appendJsonl, hmacHexFor, readJsonl, sha256Hex, stableStringify } from './fs.js';

export const AUDIT_SCHEMA = 'audit/v1';
export const AUDIT_FILE = 'actions.log';

export class AuditError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const AUDIT_FILE_NAME = AUDIT_FILE;

export function auditFilePath(memoryRoot) {
  return path.join(actionsDir(memoryRoot), AUDIT_FILE_NAME);
}

/** Canonical string of the 8 signed fields (order fixed; target stringified stably). */
export function canonicalAuditBody(entry) {
  return [
    String(entry.seq),
    String(entry.ts),
    String(entry.actorId),
    String(entry.action),
    stableStringify(entry.target ?? null),
    String(entry.beforeHash ?? ''),
    String(entry.afterHash ?? ''),
    String(entry.prevHash ?? ''),
  ].join('\n');
}

/** Host-only actor identity: hashed prefix only, never the raw id. */
export function hashActorId(raw) {
  return `host:${sha256Hex(String(raw ?? 'host')).slice(0, 8)}`;
}

const hmacFor = hmacHexFor;

/**
 * Create the audit chain writer/verifier.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {Buffer|string} options.auditKey host-memory key (32B Buffer preferred)
 * @param {() => Date} [options.now]
 * @returns {{append:Function, readAll:Function, verify:Function, latest:Function, file:string}}
 */
export function createAuditLog(options = {}) {
  const memoryRoot = String(options.memoryRoot ?? '');
  const auditKey = options.auditKey;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const file = auditFilePath(memoryRoot);

  function readAll() {
    const read = readJsonl(file);
    return { rows: Array.isArray(read.rows) ? read.rows : [], bad: read.bad ?? 0, exists: read.exists === true };
  }

  function verify(rows = readAll().rows) {
    let prevHash = GENESIS_HASH;
    let prevSeq = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const entry = rows[index];
      if (entry === null || typeof entry !== 'object') {
        return { ok: false, code: 'E_AUDIT_BROKEN', at: index, reason: 'not-an-object' };
      }
      if (entry.seq !== prevSeq + 1) {
        return { ok: false, code: 'E_AUDIT_BROKEN', at: index, reason: `seq ${entry.seq} != ${prevSeq + 1}` };
      }
      if (entry.prevHash !== undefined && entry.prevHash !== prevHash) {
        return { ok: false, code: 'E_AUDIT_BROKEN', at: index, reason: 'prevHash mismatch' };
      }
      const expected = hmacFor(auditKey, canonicalAuditBody(entry));
      if (entry.hmac !== expected) {
        return { ok: false, code: 'E_AUDIT_BROKEN', at: index, reason: 'hmac mismatch' };
      }
      prevHash = entry.hmac;
      prevSeq = entry.seq;
    }
    return { ok: true, rows: rows.length, lastSeq: prevSeq, lastHash: prevHash };
  }

  function append({ actorId = 'host', action, target = null, beforeHash = '', afterHash = '' } = {}) {
    const current = readAll();
    const checked = verify(current.rows);
    if (!checked.ok) throw new AuditError('E_AUDIT_BROKEN', '审计链已损坏：拒绝继续追加。', checked);
    const seq = (current.rows.length > 0 ? current.rows[current.rows.length - 1].seq : 0) + 1;
    const prevHash = current.rows.length > 0 ? current.rows[current.rows.length - 1].hmac : GENESIS_HASH;
    const entry = {
      seq,
      ts: now().toISOString(),
      actorId: String(actorId),
      action: String(action),
      target,
      beforeHash: String(beforeHash ?? ''),
      afterHash: String(afterHash ?? ''),
      prevHash,
    };
    entry.hmac = hmacFor(auditKey, canonicalAuditBody(entry));
    const written = appendJsonl(file, entry);
    return { ok: true, seq, entry, file, offset: written.offset };
  }

  function latest() {
    const { rows } = readAll();
    return rows.length > 0 ? rows[rows.length - 1] : null;
  }

  return { file, readAll, verify, append, latest };
}
