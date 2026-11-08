// src/actions/evidence.js — evidence 私有写路径 + HMAC 验签（N38 三写 probe 的靶子）
//
// evidence 包只由宿主写：写盘前用**仅宿主内存**的 auditKey 签名，原子写
// `<memoryRoot>/.longlive/evidence/latest.json`，并把 `packageSha256` 一起落盘供复核。
// 模型/子脑没有 token、没有 auditKey：
//   - 走动作门 → 401 `E_NO_CAP`（见 panel-auth.js）；
//   - 伪造证据（自己拼 JSON + 假签名）→ 验签失败 `E_HMAC_INVALID`，不落盘、不覆盖真证据。
// 本模块不读取任何凭据文件，也不把 key 写进返回值。

import path from 'node:path';

import { hmacHexFor, readJsonFile, sha256Hex, stableStringify, writeJsonAtomic } from './fs.js';

export const EVIDENCE_SCHEMA = 'evidence-package/v1';
export const EVIDENCE_DIR = 'evidence';
export const EVIDENCE_FILE = 'latest.json';

export class EvidenceError extends Error {
  constructor(code, message, status = 403, details = undefined) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export function evidenceFilePath(memoryRoot) {
  return path.join(String(memoryRoot ?? ''), '.longlive', EVIDENCE_DIR, EVIDENCE_FILE);
}

function canonicalEvidencePayload(pkg) {
  return stableStringify(pkg ?? null);
}

/**
 * Create the host-side evidence writer.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {Buffer|string} options.auditKey host-memory signing key (never serialized)
 * @param {() => Date} [options.now]
 */
export function createEvidenceWriter(options = {}) {
  const memoryRoot = String(options.memoryRoot ?? '');
  const auditKey = options.auditKey;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const file = evidenceFilePath(memoryRoot);

  if (!auditKey) throw new EvidenceError('E_NO_CAP', '缺少宿主签名 key：evidence 只允许宿主进程写。', 401);

  function sign(pkg) {
    return hmacHexFor(auditKey, canonicalEvidencePayload(pkg));
  }

  function persist(pkg, signature, source) {
    const packageSha256 = sha256Hex(canonicalEvidencePayload(pkg));
    const record = {
      schemaVersion: EVIDENCE_SCHEMA,
      package: pkg,
      packageSha256,
      signature,
      signatureSource: source,
      writtenAt: now().toISOString(),
    };
    writeJsonAtomic(file, record);
    return {
      ok: true,
      path: file,
      packageSha256,
      fileSha256: sha256Hex(JSON.stringify(record)),
    };
  }

  /** Host path: sign with the in-memory key, then write (N38 host probe). */
  function writeHost(pkg) {
    if (pkg === null || typeof pkg !== 'object') {
      throw new EvidenceError('E_EVIDENCE_INVALID', 'evidence 包必须是对象。', 422);
    }
    return persist(pkg, sign(pkg), 'host');
  }

  /**
   * Any caller may submit a package + signature, but only a host-signed one
   * verifies. A forged signature fails closed with `E_HMAC_INVALID`.
   */
  function submitSigned({ pkg, signature } = {}) {
    if (pkg === null || typeof pkg !== 'object') {
      throw new EvidenceError('E_EVIDENCE_INVALID', 'evidence 包必须是对象。', 422);
    }
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) {
      throw new EvidenceError('E_HMAC_INVALID', 'evidence 签名缺失或格式非法：拒绝写入。', 403);
    }
    const expected = sign(pkg);
    if (signature.toLowerCase() !== expected) {
      throw new EvidenceError('E_HMAC_INVALID', 'evidence 验签失败：拒绝写入（真证据未被覆盖）。', 403);
    }
    return persist(pkg, expected, 'host');
  }

  /** Re-read + re-verify the on-disk evidence (used by probe/action returns). */
  function readLatest() {
    const read = readJsonFile(file);
    if (!read.ok) return { ok: false, present: false, code: read.code };
    const record = read.value;
    const packageSha256 = record?.package === undefined ? null : sha256Hex(canonicalEvidencePayload(record.package));
    const signatureValid = typeof record?.signature === 'string'
      && record.signature === sign(record.package);
    return {
      ok: signatureValid && packageSha256 === record.packageSha256,
      present: true,
      schemaVersion: record?.schemaVersion ?? null,
      package: record?.package ?? null,
      packageSha256,
      recordedSha256: record?.packageSha256 ?? null,
      signatureValid,
      writtenAt: record?.writtenAt ?? null,
    };
  }

  return { file, writeHost, submitSigned, readLatest, signPackage: sign };
}
