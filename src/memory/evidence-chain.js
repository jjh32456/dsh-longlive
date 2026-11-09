// src/memory/evidence-chain.js — 1.8.0 / v2.8 §15.1-A2：证据版本链（append-only + 哈希链 + HMAC 签名）
//
// 设计（写死）：
//   * `<memoryRoot>/.longlive/evidence/chain/<claimId>.jsonl` 只追加：每行一个版本
//     {schema, claimId, op:'add'|'supersede'|'rollback', version, evidence{...}, prevLineHash,
//      at, by, hash, sig}；**任何旧行不许改**；新证据用 supersede 指向前版。
//   * version 单调 +1；调用方带 expectedVersion 时 CAS，不匹配 → E_EVIDENCE_VERSION_CONFLICT。
//   * 回滚 = 读旧版本、作为**新版本**再追加（不物理删）；旧版仍可读（回读接口按 version 取）。
//   * 哈希链：line.hash = sha256(stableStringify(除 hash/sig 外字段))；prevLineHash 串前一行；
//     sidecar `.head.json` 记 {version, headHash, count}（原子写）。
//   * 宿主私有写保护（复核 P1）：写必须带宿主内存 auditKey，签名 = HMAC-SHA256(auditKey, hash)；
//     无 key → E_NO_CAP；绕过 writer 直写/改行 → verifyChain 报 E_CHAIN_TAMPERED / E_HMAC_INVALID。
//
// 与 cards.js 的合并（避免两套真相）：conflict 判定复用 cards.isNegativeConclusion（见 conflicts.js），
// Claim/Record 只保留一套冲突结果，不再各算一套。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hmacHexFor, sha256Hex, stableStringify, writeJsonAtomic } from '../actions/fs.js';

export const EVIDENCE_CHAIN_SCHEMA = 'evidence-chain/v1';
export const EVIDENCE_CHAIN_DIR = 'evidence/chain';
export const EVIDENCE_OPS = Object.freeze(['add', 'supersede', 'rollback']);

export class EvidenceChainError extends Error {
  constructor(code, message, detail = undefined, status = 403) {
    super(message);
    this.name = 'EvidenceChainError';
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function safeClaimId(claimId) {
  const raw = String(claimId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  if (raw === '') throw new EvidenceChainError('E_CLAIM_ID', 'claimId required', undefined, 400);
  return raw;
}

export function evidenceChainDirOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', EVIDENCE_CHAIN_DIR);
}

export function chainPathOf(memoryRoot, claimId) {
  return path.join(evidenceChainDirOf(memoryRoot), `${safeClaimId(claimId)}.jsonl`);
}

export function chainHeadPathOf(memoryRoot, claimId) {
  return path.join(evidenceChainDirOf(memoryRoot), `${safeClaimId(claimId)}.head.json`);
}

const HASH_FIELDS = ['schema', 'claimId', 'op', 'version', 'evidence', 'prevLineHash', 'at', 'by'];

/** Canonical hash: fixed field order, excludes transient/derived fields (hash/sig/integrityOk/...). */
function hashableLine(line) {
  const canonical = {};
  for (const field of HASH_FIELDS) canonical[field] = line?.[field] ?? null;
  return sha256Hex(stableStringify(canonical));
}

function lineHash(line) {
  return hashableLine(line);
}

function signLine(auditKey, hash) {
  return hmacHexFor(auditKey, hash);
}

/** Read the full append-only chain (tolerant of unreadable tail lines, flags bad). */
export function readEvidenceChain({ memoryRoot, claimId }) {
  const id = safeClaimId(claimId);
  const file = chainPathOf(memoryRoot, id);
  const lines = [];
  const bad = [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  let previousHash = 'genesis';
  let expectedVersion = 1;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let line = null;
    try {
      line = JSON.parse(raw);
    } catch {
      bad.push({ reason: 'E_JSON', line: raw.slice(0, 120) });
      continue;
    }
    const computed = hashableLine(line);
    const integrityOk = line.hash === computed && line.prevLineHash === previousHash && line.version === expectedVersion;
    lines.push({ ...line, integrityOk, computedHash: computed });
    previousHash = line.hash;
    expectedVersion += 1;
  }
  const head = lines.length > 0 ? lines[lines.length - 1] : null;
  return {
    schema: EVIDENCE_CHAIN_SCHEMA,
    claimId: id,
    file,
    present: lines.length > 0,
    lines,
    badLines: bad,
    head,
    version: head?.version ?? 0,
    headHash: head?.hash ?? null,
    count: lines.length,
    integrityOk: bad.length === 0 && lines.every((line) => line.integrityOk === true),
  };
}

/** Verify hash chain + HMAC for every line. */
export function verifyEvidenceChain({ memoryRoot, claimId, auditKey }) {
  const chain = readEvidenceChain({ memoryRoot, claimId });
  if (chain.badLines.length > 0) return { ok: false, code: 'E_CHAIN_TAMPERED', chain };
  let previousHash = 'genesis';
  let expectedVersion = 1;
  for (const line of chain.lines) {
    if (line.hash !== lineHash(line)) return { ok: false, code: 'E_EVIDENCE_CHAIN_BROKEN', legacyCode: 'E_CHAIN_TAMPERED', atVersion: line.version, chain };
    if (line.prevLineHash !== previousHash) return { ok: false, code: 'E_EVIDENCE_CHAIN_BROKEN', legacyCode: 'E_CHAIN_TAMPERED', atVersion: line.version, chain };
    if (line.version !== expectedVersion) return { ok: false, code: 'E_EVIDENCE_CHAIN_BROKEN', legacyCode: 'E_CHAIN_TAMPERED', atVersion: line.version, chain };
    // GOV-06 aliases: seq/prevHash/rowHmac must agree with the canonical fields.
    if (line.seq !== undefined && line.seq !== line.version) return { ok: false, code: 'E_EVIDENCE_CHAIN_BROKEN', legacyCode: 'E_CHAIN_TAMPERED', atVersion: line.version, chain };
    if (line.prevHash !== undefined && line.prevHash !== line.prevLineHash) return { ok: false, code: 'E_EVIDENCE_CHAIN_BROKEN', legacyCode: 'E_CHAIN_TAMPERED', atVersion: line.version, chain };
    if (line.rowHmac !== undefined && line.sig !== undefined && line.rowHmac !== line.sig) return { ok: false, code: 'E_EVIDENCE_CHAIN_BROKEN', legacyCode: 'E_CHAIN_TAMPERED', atVersion: line.version, chain };
    if (typeof auditKey === 'string' && auditKey !== '' && line.sig !== signLine(auditKey, line.hash)) {
      return { ok: false, code: 'E_HMAC_INVALID', atVersion: line.version, chain };
    }
    previousHash = line.hash;
    expectedVersion += 1;
  }
  return { ok: true, code: 'OK', version: chain.version, count: chain.count, headHash: chain.headHash };
}

function writeHead(memoryRoot, claimId, head) {
  try {
    writeJsonAtomic(chainHeadPathOf(memoryRoot, claimId), {
      schema: 'evidence-chain-head/v1',
      claimId,
      version: head?.version ?? 0,
      headHash: head?.hash ?? null,
      count: head ? head.version : 0,
      updatedAt: nowIso(),
    });
  } catch {
    /* sidecar is derivable from the chain */
  }
}

function appendLine({ memoryRoot, claimId, line }) {
  const dir = evidenceChainDirOf(memoryRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(chainPathOf(memoryRoot, claimId), `${JSON.stringify(line)}\n`, 'utf8');
}

function makeEvidence(evidence, claimId) {
  const value = evidence && typeof evidence === 'object' ? evidence : {};
  const id = typeof value.id === 'string' && value.id !== ''
    ? value.id
    : `ev_${sha1Short(`${claimId}|${value.anchorId ?? ''}|${value.sha256 ?? ''}|${value.excerptRef ?? ''}`)}`;
  return {
    id,
    claimId,
    anchorId: value.anchorId ?? null,
    sha256: value.sha256 ?? null,
    excerptRef: value.excerptRef ?? null,
    verifier: value.verifier ?? null,
    verifiedAt: value.verifiedAt ?? null,
    sourceDoc: value.sourceDoc ?? null,
    supersedes: value.supersedes ?? null,
  };
}

function sha1Short(text, length = 12) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, length);
}

/** Core host write: append one version (requires auditKey). */
export function appendEvidenceVersion({
  memoryRoot,
  claimId,
  auditKey,
  op = 'add',
  evidence,
  expectedVersion = null,
  at = undefined,
  by = 'host',
  now = () => new Date(),
}) {
  if (typeof auditKey !== 'string' || auditKey === '') {
    throw new EvidenceChainError('E_NO_CAP', '缺少宿主签名 key：证据链只允许宿主进程写。', undefined, 401);
  }
  if (!EVIDENCE_OPS.includes(op)) throw new EvidenceChainError('E_EVIDENCE_OP', `非法 op：${String(op)}`, undefined, 400);
  const id = safeClaimId(claimId);
  const chain = readEvidenceChain({ memoryRoot, claimId: id });
  if (chain.badLines.length > 0) {
    throw new EvidenceChainError('E_CHAIN_TAMPERED', '证据链已被篡改（坏行），拒绝继续写。', undefined, 409);
  }
  if (expectedVersion !== null && expectedVersion !== chain.version) {
    throw new EvidenceChainError('E_EVIDENCE_VERSION_CONFLICT', `expectedVersion=${expectedVersion} but head=${chain.version}`, undefined, 409);
  }
  const nextVersion = chain.version + 1;
  const version = {
    schema: EVIDENCE_CHAIN_SCHEMA,
    claimId: id,
    op,
    version: nextVersion,
    evidence: makeEvidence({ ...evidence, supersedes: evidence?.supersedes ?? chain.head?.evidence?.id ?? null }, id),
    prevLineHash: chain.headHash ?? 'genesis',
    at: at !== undefined ? at : nowIso(now),
    by: String(by).slice(0, 80),
  };
  version.hash = lineHash(version);
  version.sig = signLine(auditKey, version.hash);
  // GOV-06 compatibility aliases (probe expects seq/prevHash/rowHmac).
  version.seq = nextVersion;
  version.prevHash = version.prevLineHash;
  version.rowHmac = version.sig;
  appendLine({ memoryRoot, claimId: id, line: version });
  writeHead(memoryRoot, id, version);
  return { ok: true, claimId: id, op, version: nextVersion, line: version, chainVersion: nextVersion };
}

/** Host-side writer factory (module-private key: model/subagent has no key). */
export function createEvidenceChain({ memoryRoot, auditKey, now = () => new Date() }) {
  if (typeof auditKey !== 'string' || auditKey === '') {
    throw new EvidenceChainError('E_NO_CAP', 'evidence-chain 需要宿主 auditKey。', undefined, 401);
  }
  return {
    memoryRoot,
    append(input = {}) {
      return appendEvidenceVersion({ memoryRoot, auditKey, now, ...input });
    },
    supersede(input = {}) {
      return appendEvidenceVersion({ memoryRoot, auditKey, now, op: 'supersede', ...input });
    },
    /** Rollback = read old version + append it as a NEW version (never deletes). */
    rollback({ claimId, targetVersion, by = 'host' } = {}) {
      const chain = readEvidenceChain({ memoryRoot, claimId });
      const target = chain.lines.find((line) => line.version === targetVersion);
      if (!target) throw new EvidenceChainError('E_EVIDENCE_VERSION_MISSING', `版本 ${targetVersion} 不存在`, undefined, 404);
      const next = appendEvidenceVersion({
        memoryRoot,
        claimId,
        auditKey,
        now,
        op: 'rollback',
        evidence: { ...target.evidence, supersedes: chain.head?.evidence?.id ?? null, id: `ev_${sha1Short(`${target.evidence.id}|rollback|${chain.version + 1}`)}` },
        by,
        at: nowIso(now),
      });
      return { ...next, rolledBackTo: targetVersion, chainLength: next.chainVersion };
    },
    read({ claimId } = {}) {
      return readEvidenceChain({ memoryRoot, claimId });
    },
    verify({ claimId } = {}) {
      return verifyEvidenceChain({ memoryRoot, claimId, auditKey });
    },
  };
}

/** Derive current evidence version for claims (chain authoritative when present). */
export function attachEvidenceChain({ memoryRoot, claims }) {
  const list = Array.isArray(claims) ? claims : [];
  return list.map((claim) => {
    const chain = readEvidenceChain({ memoryRoot, claimId: claim.id });
    if (!chain.present) return claim;
    const headEvidence = chain.head?.evidence ?? null;
    return {
      ...claim,
      evidence: {
        version: chain.version,
        items: chain.lines
          .filter((line) => line.op !== 'rollback' || line === chain.head)
          .map((line) => line.evidence)
          .filter((entry) => entry && entry.id),
        head: headEvidence,
        chainIntegrityOk: chain.integrityOk,
      },
    };
  });
}

export { sha256Hex };
