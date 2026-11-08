// src/role/writeprotect.js — 1.8.0 / v2.8.1 §16.8 A/E：宿主私有写保护 + HMAC 侧车 + 四元边界
//
// 设计（§16.8）：
//   A. `.longlive/role/**`、`.longlive/working/**` 等数据「模型与子脑不可写」：
//      ① 宿主进程独占写（tmp + rename + fsync）；② 每文件 HMAC 侧车
//      `<file>.hmac` = HMAC-SHA256(auditKey, canonical bytes)，读时校验，失败
//      → `E_INTEGRITY_TAMPER` 且拒绝加载；③ 模型工具/子脑直写 → `E_WRITE_DENY`。
//   E. 四元边界 sessionId/userId/projectId/readers[]：私密帧拒绝 `E_FRAME_PRIVATE`；
//      role 文件带 subject/readers，跨用户读取被拒（宿主例外）。
//
// 密钥：宿主内存 auditKey 优先（与 panel-auth 同源）；未注入时从
// `<memoryRoot>/.longlive/.hostkey` 取（首启生成，0600 权限，宿主私有目录约定）。
// 该 key 与内容分开存放且不在任何响应/日志里出现；残余风险见 docs/ROLE.md。
//
// 纯本地、失败静默：写路径抛结构化错误；读路径由调用方决定降级。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isInsideRoot, memoryError } from '../memory/paths.js';
import { RoleError, ROLE_CODES, iso } from './base.js';

export const WRITEPROTECT_SCHEMA = 'hostwrite/v1';
export const SIDECAR_SUFFIX = '.hmac';
export const HOST_KEY_FILE = '.hostkey';
/** Host-injected audit key wins over the persisted fallback key file. */
export const AUDIT_KEY_ENV = 'DSH_LONGLIVE_AUDIT_KEY';
export const WRITE_CODES = Object.freeze({
  WRITE_DENY: 'E_WRITE_DENY',
  NO_CAP: 'E_NO_CAP',
  TAMPER: 'E_INTEGRITY_TAMPER',
  SIDECAR: 'E_SIDECAR_INVALID',
  FRAME_PRIVATE: 'E_FRAME_PRIVATE',
  ACCESS_DENIED: 'E_ACCESS_DENIED',
  SUBJECT: 'E_SUBJECT_INVALID',
});
export const ROLE_SUBJECT_FIELDS = Object.freeze(['sessionId', 'userId', 'projectId', 'readers']);
/** §16.8 A：模型/子脑永远不是 host writer。 */
export const HOST_ACTORS = Object.freeze(['host', 'panel']);

function writeError(code, message, status = 403, details = undefined) {
  const error = new RoleError(code, message, details);
  error.status = status;
  return error;
}

/** Host-only actor gate: anything else is a model/subagent direct write. */
export function assertHostWrite(actorKind) {
  const actor = String(actorKind ?? 'host');
  if (!HOST_ACTORS.includes(actor)) {
    throw writeError(WRITE_CODES.WRITE_DENY, `模型/子脑不可直写宿主私有数据（actor=${actor}）；请走宿主写路径。`);
  }
  return true;
}

function hostKeyPath(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot ?? '')), '.longlive', HOST_KEY_FILE);
}

/** Read the persisted host key file, or null when absent. */
export function readHostKeyFile(memoryRoot) {
  try {
    const text = fs.readFileSync(hostKeyPath(memoryRoot), 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** Host-injected key from the environment (never written to disk by this module). */
export function readHostKeyEnv(env = process.env) {
  const value = env?.[AUDIT_KEY_ENV];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Resolve a key for read verification without creating anything:
 * host-injected env/auditKey first, then the persisted fallback file.
 * Missing everything => null (callers fail closed).
 */
export function readHostKey(memoryRoot, { auditKey = null, env = process.env } = {}) {
  const envKey = readHostKeyEnv(env);
  if (envKey !== null) return envKey;
  if (Buffer.isBuffer(auditKey) || typeof auditKey === 'string') {
    const key = Buffer.isBuffer(auditKey) ? auditKey.toString('hex') : String(auditKey);
    if (key.trim() !== '') return key.trim();
  }
  return readHostKeyFile(memoryRoot);
}

/**
 * Keys a read path may verify against: host env key, injected auditKey, then
 * the persisted fallback key file. Writers seal with the first available key.
 */
export function hostKeyCandidates(memoryRoot, { auditKey = null, env = process.env } = {}) {
  const candidates = [];
  const envKey = readHostKeyEnv(env);
  if (envKey !== null) candidates.push(envKey);
  if (Buffer.isBuffer(auditKey) || typeof auditKey === 'string') {
    const key = Buffer.isBuffer(auditKey) ? auditKey.toString('hex') : String(auditKey);
    if (key.trim() !== '' && !candidates.includes(key.trim())) candidates.push(key.trim());
  }
  const fileKey = readHostKeyFile(memoryRoot);
  if (fileKey !== null && !candidates.includes(fileKey)) candidates.push(fileKey);
  return candidates;
}

/**
 * Resolve the host write key: env DSH_LONGLIVE_AUDIT_KEY > injected auditKey >
 * persisted fallback `<memoryRoot>/.longlive/.hostkey` (created on first use).
 */
export function resolveHostKey(memoryRoot, { auditKey = null, env = process.env } = {}) {
  const envKey = readHostKeyEnv(env);
  if (envKey !== null) return envKey;
  if (Buffer.isBuffer(auditKey) || typeof auditKey === 'string') {
    const key = Buffer.isBuffer(auditKey) ? auditKey.toString('hex') : String(auditKey);
    if (key.trim() !== '') return key;
  }
  const file = hostKeyPath(memoryRoot);
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text !== '') return text;
  } catch {
    /* create below */
  }
  const key = crypto.randomBytes(32).toString('hex');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* windows best effort */ }
  return key;
}

export function hmacFor(key, text) {
  return crypto.createHmac('sha256', key).update(String(text ?? ''), 'utf8').digest('hex');
}

export function sidecarPath(file) {
  return `${file}${SIDECAR_SUFFIX}`;
}

function writeAtomicRaw(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const readBack = fs.readFileSync(file, 'utf8');
  if (readBack !== text) throw writeError(WRITE_CODES.TAMPER, `写后读回不一致：${file}`, 500);
  return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

/**
 * Host-only protected write: atomic file + HMAC sidecar over the exact bytes.
 * Refuses model/subagent actors and paths outside the memory root.
 */
export function writeProtectedFile({ memoryRoot, file, text, auditKey = null, actorKind = 'host' }) {
  assertHostWrite(actorKind);
  const root = path.resolve(String(memoryRoot ?? ''));
  if (!isInsideRoot(root, path.resolve(file))) {
    throw memoryError(ROLE_CODES.PATH_OUTSIDE_ROOT, `写保护路径越界：${file}`);
  }
  const key = resolveHostKey(root, { auditKey });
  const written = writeAtomicRaw(file, text);
  const hmac = hmacFor(key, text);
  writeAtomicRaw(sidecarPath(file), `${JSON.stringify({
    schema: WRITEPROTECT_SCHEMA,
    alg: 'HMAC-SHA256',
    file: path.basename(file),
    bytes: written.bytes,
    sha256: written.sha256,
    hmac,
    sealedAt: iso(Date.now()),
  }, null, 2)}\n`);
  return { ok: true, file, bytes: written.bytes, sha256: written.sha256, hmac };
}

/** Host-only protected JSON write. */
export function writeProtectedJson({ memoryRoot, file, value, auditKey = null, actorKind = 'host' }) {
  return writeProtectedFile({
    memoryRoot,
    file,
    text: `${JSON.stringify(value, null, 2)}\n`,
    auditKey,
    actorKind,
  });
}

/** Host-only protected JSONL append: append + re-seal the whole file sidecar. */
export function appendProtectedJsonl({ memoryRoot, file, row, auditKey = null, actorKind = 'host' }) {
  assertHostWrite(actorKind);
  const root = path.resolve(String(memoryRoot ?? ''));
  if (!isInsideRoot(root, path.resolve(file))) {
    throw memoryError(ROLE_CODES.PATH_OUTSIDE_ROOT, `写保护路径越界：${file}`);
  }
  const key = resolveHostKey(root, { auditKey });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(row)}\n`;
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, line, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* append fsync best effort */ }
  } finally {
    fs.closeSync(fd);
  }
  const text = fs.readFileSync(file, 'utf8');
  const hmac = hmacFor(key, text);
  writeAtomicRaw(sidecarPath(file), `${JSON.stringify({
    schema: WRITEPROTECT_SCHEMA,
    alg: 'HMAC-SHA256',
    file: path.basename(file),
    bytes: Buffer.byteLength(text, 'utf8'),
    hmac,
    sealedAt: iso(Date.now()),
  }, null, 2)}\n`);
  return { ok: true, file, bytes: Buffer.byteLength(line, 'utf8'), hmac };
}

/**
 * Verify one file against its sidecar. Returns {ok, code, tampered}.
 * Missing sidecar on a missing file = clean absence; missing sidecar on an
 * existing file = `E_SIDECAR_INVALID` (unprotected content must not load).
 */
export function verifyProtectedFile({ memoryRoot, file, auditKey = null }) {
  const root = path.resolve(String(memoryRoot ?? ''));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, absent: true, tampered: false };
    return { ok: false, absent: false, tampered: true, code: WRITE_CODES.TAMPER, error: error?.code ?? 'EREAD' };
  }
  let sidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath(file), 'utf8'));
  } catch {
    return {
      ok: false, absent: false, tampered: true, code: WRITE_CODES.SIDECAR,
      message: `缺少/不可读 HMAC 侧车：${sidecarPath(file)}（拒绝加载未受保护的宿主私有内容）`,
    };
  }
  const candidates = hostKeyCandidates(root, { auditKey });
  // 读路径不创建 key 文件：没有可用 key 时 fail-safe 按 tampered 处理。
  const matched = typeof sidecar?.hmac === 'string'
    && candidates.some((key) => hmacFor(key, text) === sidecar.hmac);
  if (!matched) {
    return { ok: false, absent: false, tampered: true, code: WRITE_CODES.TAMPER, message: 'HMAC 校验失败（文件被篡改或侧车不匹配）' };
  }
  return { ok: true, absent: false, tampered: false, text, sha256: sidecar.sha256 ?? null };
}

/** Read + verify protected JSON, parsing on success. */
export function readProtectedJsonValue({ memoryRoot, file, auditKey = null }) {
  const verify = verifyProtectedFile({ memoryRoot, file, auditKey });
  if (!verify.ok) return { ok: false, absent: verify.absent === true, code: verify.code, tampered: true, message: verify.message };
  if (verify.absent) return { ok: true, absent: true, value: null };
  try {
    return { ok: true, absent: false, value: JSON.parse(verify.text) };
  } catch {
    return { ok: false, absent: false, code: WRITE_CODES.TAMPER, tampered: true, message: '受保护文件 JSON 解析失败' };
  }
}

/** Read + verify protected JSONL. */
export function readProtectedJsonl({ memoryRoot, file, auditKey = null, limit = 10_000 }) {
  const verify = verifyProtectedFile({ memoryRoot, file, auditKey });
  if (!verify.ok) return { ok: false, absent: verify.absent === true, code: verify.code, tampered: true, rows: [], bad: 0, message: verify.message };
  if (verify.absent) return { ok: true, absent: true, rows: [], bad: 0, total: 0 };
  const rows = [];
  let bad = 0;
  for (const line of verify.text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { ok: true, absent: false, rows: rows.slice(-limit), total: rows.length, bad };
}

/** Serialize a value to the canonical text used by the sidecar. */
export function protectedJsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ------------------------------------------------------------------ 四元边界
//
// §16.8 E：sessionId/userId/projectId/readers[]。private 帧或 readers 不含调用者
// 时，跨用户读取被拒（host/panel 例外——它们持能力令牌）。

/** Normalize one subject (missing fields are null, readers is a string array). */
export function normalizeRoleSubject(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const readers = Array.isArray(value.readers)
    ? [...new Set(value.readers.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()))]
    : [];
  const field = (name) => (typeof value[name] === 'string' && value[name].trim() !== '' ? value[name].trim() : null);
  const subject = {
    sessionId: field('sessionId'),
    userId: field('userId'),
    projectId: field('projectId'),
    readers,
  };
  if (value.private === true) subject.private = true;
  return subject;
}

/** True when the caller may read this subject's data. Host/panel always may. */
export function isSubjectReadable(subject, caller = {}) {
  const actorKind = String(caller?.actorKind ?? 'host');
  if (HOST_ACTORS.includes(actorKind)) return { ok: true, reason: 'host' };
  const norm = normalizeRoleSubject(subject ?? {});
  const userId = typeof caller?.userId === 'string' && caller.userId.trim() !== '' ? caller.userId.trim() : null;
  if (norm.private === true && userId === null) return { ok: false, code: WRITE_CODES.FRAME_PRIVATE, reason: 'private' };
  if (norm.readers.length > 0) {
    if (userId !== null && norm.readers.includes(userId)) return { ok: true, reason: 'reader' };
    return { ok: false, code: WRITE_CODES.ACCESS_DENIED, reason: 'readers' };
  }
  // No explicit reader list: the subject owner is the only non-host reader.
  if (norm.userId !== null && userId !== norm.userId) {
    return { ok: false, code: WRITE_CODES.ACCESS_DENIED, reason: 'owner-only' };
  }
  if (norm.userId !== null && userId === null) {
    return { ok: false, code: WRITE_CODES.ACCESS_DENIED, reason: 'owner-only' };
  }
  return { ok: true, reason: 'open' };
}

/** Throwing variant used by read paths that must fail closed. */
export function assertSubjectReadable(subject, caller = {}) {
  const verdict = isSubjectReadable(subject, caller);
  if (!verdict.ok) {
    throw writeError(verdict.code, `跨用户读取被拒（${verdict.reason}）：subject=${JSON.stringify(normalizeRoleSubject(subject ?? {}))}`, 403);
  }
  return true;
}

/** Frame-specific: `private` frames without a matching reader → E_FRAME_PRIVATE. */
export function assertFrameReadable(frame, caller = {}) {
  const subject = normalizeRoleSubject(frame?.subject ?? { sessionId: frame?.sessionId ?? null });
  const verdict = isSubjectReadable(subject, caller);
  if (!verdict.ok && (verdict.code === WRITE_CODES.FRAME_PRIVATE || subject.private === true)) {
    throw writeError(WRITE_CODES.FRAME_PRIVATE, `私密帧拒绝读取（sessionId=${subject.sessionId ?? '?'}，caller=${caller?.userId ?? '?'}）`, 403);
  }
  if (!verdict.ok) {
    throw writeError(WRITE_CODES.ACCESS_DENIED, `跨用户帧读取被拒（${verdict.reason}）`, 403);
  }
  return true;
}

/** Fill the four-element subject for a frame/frame-like record (host write). */
export function attachFrameSubject(frame, { subject = {}, readers = [], userId = null, projectId = null } = {}) {
  const merged = normalizeRoleSubject({
    sessionId: subject.sessionId ?? frame?.sessionId ?? null,
    userId: subject.userId ?? userId,
    projectId: subject.projectId ?? projectId,
    readers: Array.isArray(subject.readers) ? subject.readers : readers,
    private: subject.private === true || frame?.private === true,
  });
  return { ...frame, subject: merged };
}
