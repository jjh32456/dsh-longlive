// src/ui/panel-integrity.js — M2-G 面板包完整性（R8 / §12.10-R8 / §12.11-R9）
//
// 宿主包管理器在安装/更新面板包时生成 `.integrity/manifest.sha256`
// （逐文件 `<sha256>  <relative-path>` + 末尾 `#hmac-sha256 <hex>`）。**关键**：
// manifest 用**宿主进程内存密钥**（`panelIntegrityKey`，boot 时 32B CSPRNG 生成、
// 进程退出即失）做 HMAC 锚定；校验时重算 HMAC。仅凭公开的逐文件 sha256 重写
// manifest 无法生成可通过校验的 HMAC —— 门不能自己给自己盖章。
//
// 本模块负责：
//   1) 加载时校验一次（createIntegrityGuard 构造即校验）；
//   2) 每次动作前再校验（checkBeforeAction）；
//   3) manifest 缺失 / 无签名 / HMAC 不符 / 文件不一致 → 动作全禁用 + 401
//      `E_PANEL_INTEGRITY`，**只读展示保留**（status 照常返回）。
// panelRoot 由宿主显式传入（默认 `<DSH_HOME>/longlive-panel`，见 panel-api.js，
// 不再落在 memoryRoot 里）。不要求 Authenticode 代码签名（Lead 已签残余风险）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INTEGRITY_DIR = '.integrity';
export const INTEGRITY_MANIFEST = 'manifest.sha256';
export const MANIFEST_VERSION = 'panel-integrity/v1';
export const HMAC_LINE_PREFIX = '#hmac-sha256 ';

export class PanelIntegrityError extends Error {
  constructor(message, status = 401, statusPayload = undefined) {
    super(message);
    this.name = 'PanelIntegrityError';
    this.code = 'E_PANEL_INTEGRITY';
    this.status = status;
    if (statusPayload !== undefined) this.statusPayload = statusPayload;
  }
}

export function manifestPathOf(panelRoot) {
  return path.join(String(panelRoot ?? ''), INTEGRITY_DIR, INTEGRITY_MANIFEST);
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hmacOfBody(body, signKey) {
  return crypto.createHmac('sha256', signKey).update(`${MANIFEST_VERSION}\n${body}`, 'utf8').digest('hex');
}

/** Parse manifest text: file lines + mandatory host-HMAC trailer. */
export function parseManifest(text) {
  const entries = [];
  const bad = [];
  let hmac = null;
  for (const line of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith(HMAC_LINE_PREFIX.trim())) {
      const value = trimmed.slice(HMAC_LINE_PREFIX.trim().length).trim();
      if (/^[0-9a-f]{64}$/i.test(value)) hmac = value.toLowerCase();
      else bad.push(trimmed);
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s{2}(.+)$/.exec(trimmed);
    if (!match) {
      bad.push(trimmed);
      continue;
    }
    entries.push({ sha256: match[1].toLowerCase(), path: match[2].trim() });
  }
  return { entries, bad, hmac };
}

/** The unsigned body (what the HMAC covers). */
function manifestBodyOf(panelRoot, files = undefined) {
  const root = path.resolve(String(panelRoot));
  let rels = files;
  if (!Array.isArray(rels)) {
    rels = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) {
          if (name.name === INTEGRITY_DIR) continue;
          walk(full);
        } else if (name.isFile()) {
          rels.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    walk(root);
  }
  rels.sort();
  return `${rels.map((rel) => `${sha256OfFile(path.join(root, rel))}  ${rel}`).join('\n')}\n`;
}

/**
 * Compute manifest text.
 *
 * - `computeManifest(panelRoot, { signKey })` → **host-signed** manifest (only the
 *   host has the in-memory key; this is what install/update writes).
 * - `computeManifest(panelRoot)` → public unsigned body only. Writing it back
 *   does NOT pass validation (no host key ⇒ no valid HMAC): `E_MANIFEST_UNSIGNED`.
 */
export function computeManifest(panelRoot, options = {}) {
  if (Array.isArray(options)) {
    // legacy shape: computeManifest(root, files[]) -> unsigned body
    return manifestBodyOf(panelRoot, options);
  }
  const body = manifestBodyOf(panelRoot, options.files);
  if (options.signKey === undefined || options.signKey === null) return body;
  return `${body}${HMAC_LINE_PREFIX}${hmacOfBody(body, options.signKey)}\n`;
}

/**
 * Create the integrity guard.
 *
 * @param {object} options
 * @param {string} options.panelRoot installed panel package root (outside memoryRoot).
 * @param {Buffer|string} options.signKey host-memory panelIntegrityKey (required).
 * @param {() => Date} [options.now]
 * @returns guard with `status()`, `loadedStatus`, `checkBeforeAction()`,
 *          `writeSignedManifest()` (host install/update helper).
 */
export function createIntegrityGuard(options = {}) {
  const panelRoot = typeof options.panelRoot === 'string' && options.panelRoot.trim() !== ''
    ? path.resolve(options.panelRoot)
    : null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const signKey = options.signKey;

  function fail(code, checkedAt, extra = {}) {
    return { ok: false, manifestVersion: null, checkedAt, files: [], lastError: code, ...extra };
  }

  function verifyNow() {
    const checkedAt = now().toISOString();
    if (panelRoot === null) return fail('E_PANEL_ROOT_UNKNOWN', checkedAt);
    if (signKey === undefined || signKey === null || (typeof signKey === 'string' && signKey === '')
      || (Buffer.isBuffer(signKey) && signKey.length === 0)) {
      return fail('E_INTEGRITY_KEY_MISSING', checkedAt);
    }
    const file = manifestPathOf(panelRoot);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return fail('E_MANIFEST_MISSING', checkedAt);
    }
    const parsed = parseManifest(text);
    if (parsed.hmac === null) {
      // Garbage manifest vs. a well-formed but *unsigned* file list (the public
      // `computeManifest()` rewrite attack): both fail closed, with distinct codes.
      const invalid = parsed.bad.length > 0 || parsed.entries.length === 0;
      return fail(invalid ? 'E_MANIFEST_INVALID' : 'E_MANIFEST_UNSIGNED', checkedAt);
    }
    // Recompute the HMAC over the exact body the manifest declares (entries +
    // paths in file order — the signed form is canonical sorted). A public
    // recompute of file hashes cannot know the host key, so rewriting the file
    // list alone never validates.
    const bodyText = `${parsed.entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`;
    const expected = hmacOfBody(bodyText, signKey);
    if (expected !== parsed.hmac) {
      return fail('E_MANIFEST_HMAC_INVALID', checkedAt);
    }
    if (parsed.bad.length > 0 || parsed.entries.length === 0) {
      return fail(parsed.bad.length > 0 ? 'E_MANIFEST_INVALID' : 'E_MANIFEST_EMPTY', checkedAt);
    }
    const files = [];
    let ok = true;
    let lastError = null;
    for (const entry of parsed.entries) {
      const target = path.resolve(panelRoot, entry.path);
      if (target !== panelRoot && !target.startsWith(`${panelRoot}${path.sep}`)) {
        ok = false;
        lastError = 'E_MANIFEST_PATH_ESCAPE';
        files.push({ path: entry.path, ok: false, sha256: null });
        continue;
      }
      let actual = null;
      try {
        actual = sha256OfFile(target);
      } catch {
        ok = false;
        lastError = lastError ?? 'E_FILE_MISSING';
        files.push({ path: entry.path, ok: false, sha256: null });
        continue;
      }
      const match = actual === entry.sha256;
      if (!match) {
        ok = false;
        lastError = 'E_FILE_MISMATCH';
      }
      files.push({ path: entry.path, ok: match, sha256: actual });
    }
    return {
      ok,
      manifestVersion: `panel+hmac:${parsed.hmac.slice(0, 16)}`,
      checkedAt,
      files,
      lastError,
    };
  }

  /**
   * Host-only install/update helper: hash the current files and write a manifest
   * signed with the in-memory host key. A caller without the key cannot produce
   * a valid manifest, so this function is unusable as a bypass.
   */
  function writeSignedManifest() {
    if (panelRoot === null) {
      return { ok: false, code: 'E_PANEL_ROOT_UNKNOWN' };
    }
    if (signKey === undefined || signKey === null) {
      return { ok: false, code: 'E_INTEGRITY_KEY_MISSING' };
    }
    const text = computeManifest(panelRoot, { signKey });
    const file = manifestPathOf(panelRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    const parsed = parseManifest(text);
    return { ok: true, path: file, hmac: parsed.hmac, body: text };
  }

  const loadedStatus = verifyNow();

  function checkBeforeAction() {
    const status = verifyNow();
    if (!status.ok) {
      throw new PanelIntegrityError('面板包完整性校验失败：动作已全部禁用（只读展示保留）。', 401, status);
    }
    return status;
  }

  return {
    panelRoot,
    loadedStatus,
    status: verifyNow,
    checkBeforeAction,
    writeSignedManifest,
    manifestPath: panelRoot === null ? null : manifestPathOf(panelRoot),
    hasHostKey: signKey !== undefined && signKey !== null,
  };
}
