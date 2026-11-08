// src/role/store.js — 角色内核共享文件层（v2.8 §16.3 + §16.8 A 写保护）
//
// 所有角色内核数据都落在 `<memoryRoot>/.longlive/role/` 下：
//   attention.jsonl      注意力队列（append-only；容量压缩由 attention.js 负责）
//   relationships.json   关系图（nodes/edges + CAS version + subject/readers 边界）
//   personality.json     人格快照（版本化 + subject/readers 边界）
//   channels.json        渠道注册表（只读状态 + 已注册适配器元数据）
//   audit.jsonl          角色层审计（追加：relationship.update / personality.snapshot …）
//
// §16.8 A：role/** 是宿主私有数据 —— 写路径必须有宿主身份（actorKind=host/panel）
// 并带 HMAC 侧车（`<file>.hmac`）；读路径校验侧车，篡改/缺侧车 → `E_INTEGRITY_TAMPER`
// 且拒绝加载。密钥与算法在 writeprotect.js；本文件把两者接到所有 role 读写上。
//
// 读路径永不抛：坏文件/篡改返回 degraded + code，让面板/注入降级而不是崩。

import fs from 'node:fs';
import path from 'node:path';

import { isInsideRoot, memoryError } from '../memory/paths.js';
import {
  ROLE_CODES as BASE_CODES, RoleError as BaseRoleError, iso, nowMs, sha256Hex,
} from './base.js';
import {
  appendProtectedJsonl,
  isSubjectReadable,
  normalizeRoleSubject,
  readProtectedJsonValue,
  readProtectedJsonl,
  verifyProtectedFile,
  writeProtectedJson,
} from './writeprotect.js';

export const ROLE_DIR = path.join('.longlive', 'role');
export const ROLE_SCHEMA_VERSION = 1;

/** 角色层错误码（写路径抛 RoleError，读路径降级不抛）。 */
export const ROLE_CODES = Object.freeze({
  ...BASE_CODES,
  TAMPER: 'E_INTEGRITY_TAMPER',
  WRITE_DENY: 'E_WRITE_DENY',
  ACCESS_DENIED: 'E_ACCESS_DENIED',
});
export { iso, nowMs, sha256Hex };
export const RoleError = BaseRoleError;

export function requireMemoryRoot(memoryRoot) {
  const root = typeof memoryRoot === 'string' && memoryRoot.trim() !== '' ? path.resolve(memoryRoot.trim()) : '';
  if (root === '') {
    throw new RoleError(ROLE_CODES.PARAMS, '角色内核需要 memoryRoot（<memoryRoot>/.longlive/role/）');
  }
  return root;
}

export function roleDir(memoryRoot) {
  return path.join(requireMemoryRoot(memoryRoot), ROLE_DIR);
}

export function roleFile(memoryRoot, name) {
  const file = path.join(roleDir(memoryRoot), name);
  if (!isInsideRoot(requireMemoryRoot(memoryRoot), file)) {
    throw memoryError(ROLE_CODES.PATH_OUTSIDE_ROOT, `角色层路径越界：${file}`);
  }
  return file;
}

export function rolePaths(memoryRoot) {
  const dir = roleDir(memoryRoot);
  return {
    dir,
    attention: path.join(dir, 'attention.jsonl'),
    relationships: path.join(dir, 'relationships.json'),
    personality: path.join(dir, 'personality.json'),
    channels: path.join(dir, 'channels.json'),
    audit: path.join(dir, 'audit.jsonl'),
    hostKey: path.join(path.dirname(path.dirname(dir)), '.hostkey'),
  };
}

/** `rolePaths` for read paths: null instead of throwing on a bad/unset root. */
export function tryRolePaths(memoryRoot) {
  try {
    return rolePaths(memoryRoot);
  } catch {
    return null;
  }
}

export function ensureRoleDir(memoryRoot) {
  const dir = roleDir(memoryRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function roleRootOf(file) {
  // <root>/.longlive/role/<file> -> <root>
  return path.dirname(path.dirname(path.dirname(path.resolve(file))));
}

/**
 * §16.8 A 写保护 JSON write（宿主身份 + HMAC 侧车）。
 * options: {memoryRoot, auditKey, actorKind, subject}
 * `subject`（§16.8 E 四元边界）会合并进文件顶层 subject 字段。
 */
export function writeJsonAtomic(file, value, options = {}) {
  const memoryRoot = options.memoryRoot ?? roleRootOf(file);
  let payload = value;
  if (options.subject && value && typeof value === 'object' && !Array.isArray(value)) {
    payload = { ...value, subject: normalizeRoleSubject({ ...(value.subject ?? {}), ...options.subject }) };
  }
  return writeProtectedJson({
    memoryRoot,
    file,
    value: payload,
    auditKey: options.auditKey ?? null,
    actorKind: options.actorKind ?? 'host',
  });
}

/** §16.8 A 写保护 JSONL append（宿主身份 + 全量侧车重签）。 */
export function appendJsonl(file, row, options = {}) {
  const memoryRoot = options.memoryRoot ?? roleRootOf(file);
  return appendProtectedJsonl({
    memoryRoot,
    file,
    row,
    auditKey: options.auditKey ?? null,
    actorKind: options.actorKind ?? 'host',
  });
}

/**
 * Read-only JSON with §16.8 A verification + §16.8 E subject/readers boundary.
 * Never throws. `options.caller={actorKind,userId}` enables the boundary
 * (default host/panel bypass). Returns {ok, present, value, tampered, denied, code}.
 */
export function readJsonSafe(file, options = {}) {
  try {
    const memoryRoot = options.memoryRoot ?? roleRootOf(file);
    const verified = readProtectedJsonValue({ memoryRoot, file, auditKey: options.auditKey ?? null });
    if (verified.ok) {
      if (verified.absent) return { ok: false, present: false, absent: true, value: null, tampered: false, denied: false, code: 'ENOENT' };
      const value = verified.value;
      if (options.caller && value && typeof value === 'object' && !Array.isArray(value) && value.subject) {
        const subject = normalizeRoleSubject(value.subject);
        const verdict = isSubjectReadable(subject, options.caller);
        if (!verdict.ok) {
          return {
            ok: false, present: false, absent: false, value: null,
            tampered: false, denied: true, code: verdict.code, subject,
            message: `跨用户读取被拒（${verdict.reason}）`,
          };
        }
      }
      return { ok: true, present: true, absent: false, value, tampered: false, denied: false, code: null };
    }
    return {
      ok: false, present: true, absent: false, value: null,
      tampered: true, denied: false, code: verified.code ?? ROLE_CODES.TAMPER, message: verified.message,
    };
  } catch (error) {
    return {
      ok: false, present: true, absent: false, value: null,
      tampered: true, denied: false, code: error?.code ?? ROLE_CODES.TAMPER, message: error?.message,
    };
  }
}

/** Read-only JSONL with §16.8 A verification. Never throws. */
export function readJsonlSafe(file, { limit = 500, memoryRoot = undefined, auditKey = null } = {}) {
  try {
    const root = memoryRoot ?? roleRootOf(file);
    const verified = readProtectedJsonl({ memoryRoot: root, file, auditKey, limit });
    if (!verified.ok) {
      return { present: true, rows: [], bad: 0, total: 0, tampered: true, code: verified.code ?? ROLE_CODES.TAMPER, error: verified.code };
    }
    if (verified.absent) return { present: false, rows: [], bad: 0, total: 0, tampered: false, error: 'ENOENT' };
    return { present: true, rows: verified.rows, bad: verified.bad, total: verified.total, tampered: false, error: null };
  } catch (error) {
    return { present: true, rows: [], bad: 0, total: 0, tampered: true, code: error?.code ?? ROLE_CODES.TAMPER, error: error?.code };
  }
}

/** Verify one protected file without parsing (host tamper probe / tests). */
export function verifyRoleFile(file, options = {}) {
  const memoryRoot = options.memoryRoot ?? roleRootOf(file);
  return verifyProtectedFile({ memoryRoot, file, auditKey: options.auditKey ?? null });
}

/** Read a profile-ish source file only when it stays inside the memory root. */
export function readInsideRoot(memoryRoot, candidate) {
  const root = requireMemoryRoot(memoryRoot);
  const resolved = path.resolve(String(candidate ?? ''));
  if (!isInsideRoot(root, resolved)) {
    return { ok: false, code: ROLE_CODES.PATH_OUTSIDE_ROOT, path: resolved };
  }
  try {
    const text = fs.readFileSync(resolved, 'utf8');
    return { ok: true, path: resolved, text: text.replace(/^\uFEFF/, ''), bytes: Buffer.byteLength(text, 'utf8') };
  } catch (error) {
    return { ok: false, code: error?.code === 'ENOENT' ? 'ENOENT' : (error?.code ?? 'EREAD'), path: resolved };
  }
}
