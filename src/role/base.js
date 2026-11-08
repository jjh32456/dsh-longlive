// src/role/base.js — 角色内核基础类型（避免 store <-> writeprotect 循环依赖）
import crypto from 'node:crypto';

/** 角色层错误码（写路径抛 RoleError，读路径降级不抛）。 */
export const ROLE_CODES = Object.freeze({
  PARAMS: 'E_ROLE_PARAMS',
  DISABLED: 'E_ROLE_DISABLED',
  CAS_CONFLICT: 'E_ROLE_CAS_CONFLICT',
  CORRUPT: 'E_ROLE_CORRUPT',
  PATH_OUTSIDE_ROOT: 'E_PROFILE_OUTSIDE_ROOT',
});

export class RoleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'RoleError';
    this.code = code;
    this.status = code === ROLE_CODES.CAS_CONFLICT ? 409 : 422;
    if (details !== undefined) this.details = details;
  }
}

export function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Date.now();
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}
