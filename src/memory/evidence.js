// src/memory/evidence.js — M2-C：每轮证据包生产者（.longlive/evidence/latest.json）
//
// 依据 §12.3 L1713：pre-step 回忆流水线在「证据就绪」后**原子写**
//   {schemaVersion:'evidence-package/v1', package:{queryId,query,timings{questionAt,
//    queueMs,prefetchAt,retrievedAt,evidenceReadyAt},anchors[],fastAnswer,status,fallback},
//    packageSha256, writtenAt}
// 写路径：tmp → fsync → rename（Windows 无目录 fsync，文件 fsync 已做）。
// 写失败抛出 `E_EVIDENCE_WRITE`，调用方必须继续注入（失败静默不阻断 turn）。
//
// 说明：N38 的「仅宿主可写 + HMAC」是**动作面私有写路径**（src/actions/evidence.js）；
// 本模块是回忆侧数据面生产者，只写 packageSha256 自校验包；若调用方传入宿主内存
// auditKey，则额外附 HMAC 签名（不落 key）。两者同一文件、同一 schema。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../actions/fs.js';

export const EVIDENCE_PACKAGE_SCHEMA = 'evidence-package/v1';
export const EVIDENCE_DIR = 'evidence';
export const EVIDENCE_FILE = 'latest.json';
export const EVIDENCE_SOURCE = 'pre-step-recall';

export class EvidenceWriteError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'EvidenceWriteError';
    this.code = code;
    this.status = 500;
    if (details !== undefined) this.details = details;
  }
}

export function evidenceLatestPath(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot ?? '')), '.longlive', EVIDENCE_DIR, EVIDENCE_FILE);
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Stable query id: deterministic for the same session+turn+query. */
export function evidenceQueryId({ sessionId = 'unknown', turn = 0, query = '' } = {}) {
  return `q_${sha256Hex(`${sessionId}|${Number(turn) || 0}|${String(query).slice(0, 500)}`).slice(0, 16)}`;
}

/** Build the package body (pure; no IO). */
export function buildEvidencePackage({
  sessionId = 'unknown',
  turn = 0,
  query = '',
  timings = {},
  anchors = [],
  status = 'no_evidence',
  fastAnswer = null,
  fallback = null,
} = {}) {
  const cleanAnchors = (Array.isArray(anchors) ? anchors : []).slice(0, 10).map((anchor) => ({
    anchorId: typeof anchor.anchorId === 'string' && anchor.anchorId !== '' ? anchor.anchorId : `anc_${sha256Hex(String(anchor.id ?? anchor.path ?? JSON.stringify(anchor))).slice(0, 16)}`,
    path: anchor.path ?? null,
    excerpt: String(anchor.excerpt ?? '').slice(0, 240),
    sha256: anchor.sha256 ?? sha256Hex(String(anchor.excerpt ?? '')),
    l0Status: anchor.l0Status ?? 'indexed',
    score: Number.isFinite(anchor.score) ? anchor.score : null,
  }));
  return {
    queryId: evidenceQueryId({ sessionId, turn, query }),
    query: String(query ?? '').slice(0, 600),
    timings: {
      questionAt: timings.questionAt ?? null,
      queueMs: Number.isFinite(timings.queueMs) ? timings.queueMs : 0,
      prefetchAt: timings.prefetchAt ?? null,
      retrievedAt: timings.retrievedAt ?? null,
      evidenceReadyAt: timings.evidenceReadyAt ?? null,
    },
    anchors: cleanAnchors,
    fastAnswer,
    status: typeof status === 'string' && status !== '' ? status : (cleanAnchors.length > 0 ? 'ready' : 'no_evidence'),
    fallback: fallback === null || fallback === undefined ? { used: false, reason: null } : fallback,
  };
}

/**
 * Atomic write: tmp -> fsync -> rename. Optionally HMAC-sign with a host-memory key.
 * @throws {EvidenceWriteError} code=E_EVIDENCE_WRITE on any filesystem failure.
 */
export function writeEvidencePackage({ memoryRoot, pkg, now = () => new Date(), auditKey = null } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') throw new EvidenceWriteError('E_EVIDENCE_WRITE', 'evidence 生产者缺 memoryRoot');
  const dir = path.join(root, '.longlive', EVIDENCE_DIR);
  const file = path.join(dir, EVIDENCE_FILE);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const packageSha256 = sha256Hex(stableStringify(pkg));
  const record = {
    schemaVersion: EVIDENCE_PACKAGE_SCHEMA,
    package: pkg,
    packageSha256,
    signature: null,
    signatureSource: 'none',
    writtenAt: (typeof now === 'function' ? now() : new Date()).toISOString(),
    source: EVIDENCE_SOURCE,
  };
  if (auditKey && (Buffer.isBuffer(auditKey) || typeof auditKey === 'string')) {
    record.signature = crypto.createHmac('sha256', auditKey).update(stableStringify(pkg)).digest('hex');
    record.signatureSource = 'host';
  }
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (error) {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new EvidenceWriteError('E_EVIDENCE_WRITE', `证据包写入失败：${error?.code ?? error?.message ?? error}`, { file, cause: String(error?.code ?? error?.message ?? error) });
  }
  return { ok: true, path: file, packageSha256 };
}

/** Read-only view used by tests and non-panel callers (route #6 has its own reader). */
export function readEvidencePackage(memoryRoot) {
  try {
    const record = JSON.parse(fs.readFileSync(evidenceLatestPath(memoryRoot), 'utf8'));
    const packageSha256 = record?.package === undefined ? null : sha256Hex(stableStringify(record.package));
    return {
      ok: true,
      present: true,
      schemaVersion: record.schemaVersion ?? null,
      package: record.package ?? null,
      packageSha256,
      recordedSha256: record.packageSha256 ?? null,
      sha256Valid: packageSha256 === record.packageSha256,
      writtenAt: record.writtenAt ?? null,
      source: record.source ?? null,
      signatureSource: record.signatureSource ?? null,
    };
  } catch (error) {
    return { ok: false, present: false, code: error?.code === 'ENOENT' ? 'E_EVIDENCE_MISSING' : 'E_EVIDENCE_CORRUPT' };
  }
}
