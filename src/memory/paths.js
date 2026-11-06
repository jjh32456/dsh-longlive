// Memory-layer path guard.
//
// One resolver for every memory tool, so `memoryRoot` and the older `memRoot`
// key can never point at two different stores. Resolution order:
//
//   1. config.memoryRoot
//   2. config.memRoot                  (backward-compatible alias)
//   3. $DSH_LONGLIVE_MEMORY_ROOT
//   4. $DSH_MEM                        (the pre-0.7.3 name, still honoured)
//   5. <DSH home>/longlive-memory      (derived default; created on demand)
//
// A derived default is created (mkdir -p); an explicitly configured path is
// NOT: pointing `memoryRoot` at a typo must fail loudly, not silently grow a
// new empty store next to the intended one. `strictMemoryRoot: true` (or
// $DSH_LONGLIVE_STRICT_MEMORY_ROOT=1) removes step 5 and restores the old
// "unset root is an error" behaviour.
//
// All other paths (cards, reports, backups) go through `resolveInside`, so a
// `..` traversal or an absolute path on another drive is rejected with
// `E_PATH_OUTSIDE_ROOT` before any read or write happens.

import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from '../home.js';

export const PATH_CODES = Object.freeze({
  ROOT_UNSET: 'E_MEMORY_ROOT_UNSET',
  ROOT_MISSING: 'E_MEMORY_ROOT_MISSING',
  ROOT_NOT_DIR: 'E_MEMORY_ROOT_NOT_DIR',
  PATH_OUTSIDE_ROOT: 'E_PATH_OUTSIDE_ROOT',
  BAD_ARGUMENT: 'E_BAD_ARGUMENT',
});

/** Preferred environment variable; the one QUICKSTART/ERRORS document. */
export const MEMORY_ROOT_ENV = 'DSH_LONGLIVE_MEMORY_ROOT';
/** Pre-0.7.3 name. Kept so an existing install does not lose its store. */
export const LEGACY_MEMORY_ROOT_ENV = 'DSH_MEM';
/** Set to 1/true to disable the derived default. */
export const STRICT_MEMORY_ROOT_ENV = 'DSH_LONGLIVE_STRICT_MEMORY_ROOT';
/** Directory created under the DSH home when nothing is configured. */
export const DEFAULT_MEMORY_DIRNAME = 'longlive-memory';

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function truthy(value) {
  const text = nonEmpty(value).toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

/**
 * Describe where a memory root would come from, without touching the disk.
 * Shared with `src/tools.js` so `session_wake` / `lease_*` follow exactly the
 * same chain as `memory_*` (the 0.7.2 split sent one family to a fixed drive
 * and the other to E_MEMORY_ROOT_UNSET on the very same machine).
 */
export function memoryRootSetting(config = {}, env = process.env) {
  const fromConfig = nonEmpty(config?.memoryRoot);
  const fromAlias = nonEmpty(config?.memRoot);
  const fromEnv = nonEmpty(env?.[MEMORY_ROOT_ENV]);
  const fromLegacy = nonEmpty(env?.[LEGACY_MEMORY_ROOT_ENV]);
  const explicit = fromConfig || fromAlias || fromEnv || fromLegacy;
  const source = fromConfig ? 'config.memoryRoot'
    : fromAlias ? 'config.memRoot'
      : fromEnv ? MEMORY_ROOT_ENV
        : fromLegacy ? LEGACY_MEMORY_ROOT_ENV
          : 'default';
  const strict = config?.strictMemoryRoot === true || truthy(env?.[STRICT_MEMORY_ROOT_ENV]);
  return { explicit, source, strict };
}

/** `<DSH home>/longlive-memory`, honouring an explicit `config.home` (tests). */
export function defaultMemoryRoot(config = {}, env = process.env) {
  const configuredHome = nonEmpty(config?.home);
  const home = configuredHome ? path.resolve(configuredHome) : dshHome(env);
  return path.resolve(home, DEFAULT_MEMORY_DIRNAME);
}

/**
 * Resolve the configured memory root.
 *
 * Returns the absolute path of an existing directory. Throws a coded error
 * (`E_MEMORY_ROOT_UNSET` / `E_MEMORY_ROOT_MISSING` / `E_MEMORY_ROOT_NOT_DIR`)
 * whose message names the next action, never a bare ENOENT.
 */
export function memoryRootFromConfig(config = {}, env = process.env) {
  const setting = memoryRootSetting(config, env);
  let root;
  if (setting.explicit) {
    root = path.resolve(setting.explicit);
  } else {
    if (setting.strict) {
      throw memoryError(
        PATH_CODES.ROOT_UNSET,
        'memoryRoot 未配置（strictMemoryRoot 严格模式已开启）— 设置插件配置 memoryRoot、' +
        `${MEMORY_ROOT_ENV}（旧名 ${LEGACY_MEMORY_ROOT_ENV}），或关闭严格模式改用默认目录 ` +
        `<DSH home>/${DEFAULT_MEMORY_DIRNAME}`,
      );
    }
    root = defaultMemoryRoot(config, env);
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (error) {
      throw memoryError(
        PATH_CODES.ROOT_MISSING,
        `无法创建默认记忆根目录：${root} — 检查 $DSH_HOME 或用户目录的写权限，` +
        `或显式设置 memoryRoot / ${MEMORY_ROOT_ENV}（旧名 ${LEGACY_MEMORY_ROOT_ENV}）`,
        error,
      );
    }
  }
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch (error) {
    throw memoryError(
      PATH_CODES.ROOT_MISSING,
      `记忆根目录不存在：${root} — 创建该目录（mkdir -p），或把 memoryRoot / ` +
      `${MEMORY_ROOT_ENV}（旧名 ${LEGACY_MEMORY_ROOT_ENV}）指向一个已存在的目录；` +
      '插件不会替你创建显式配置的路径',
      error,
    );
  }
  if (!stat.isDirectory()) {
    throw memoryError(
      PATH_CODES.ROOT_NOT_DIR,
      `memoryRoot 不是目录：${root} — 指向一个目录（不要指向文件），或删掉同名文件后重试`,
    );
  }
  return root;
}

/** Build an Error with a stable `.code` the tools and tests can branch on. */
export function memoryError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** True when `target` is `root` itself or lives under it (no `..` escape). */
export function isInsideRoot(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const rel = path.relative(rootAbs, targetAbs);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolve a path through the nearest existing ancestor, so a target that does
 * not exist yet can still be checked against junctions and symlinks already on
 * disk. Returns the real path with the missing tail re-appended.
 */
export function realPathProbe(target) {
  const abs = path.resolve(target);
  let existing = abs;
  let tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native
        ? fs.realpathSync.native(existing)
        : fs.realpathSync(existing);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return abs;
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Resolve `target` (relative to the root, or absolute) and prove it stays
 * inside `root` both lexically and after resolving every existing junction or
 * symlink on the way. Throws `E_PATH_OUTSIDE_ROOT` for `..`, another drive, an
 * absolute path elsewhere, or a real path that escapes the root; never returns
 * a path the caller may not touch.
 *
 * The lexical path is returned unchanged (callers keep their stable names),
 * but the real-path check runs before any read or write.
 */
export function resolveInside(root, target) {
  if (typeof target !== 'string' || target.trim() === '' || target.includes('\0')) {
    throw memoryError(PATH_CODES.BAD_ARGUMENT, `拒绝空路径或非法路径：${JSON.stringify(target)}`);
  }
  const rootAbs = path.resolve(root);
  const targetAbs = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(rootAbs, target);
  if (!isInsideRoot(rootAbs, targetAbs)) {
    throw memoryError(
      PATH_CODES.PATH_OUTSIDE_ROOT,
      `拒绝越界路径：${targetAbs} 不在记忆根 ${rootAbs} 内 (E_PATH_OUTSIDE_ROOT)`,
    );
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync.native ? fs.realpathSync.native(rootAbs) : fs.realpathSync(rootAbs);
  } catch (error) {
    throw memoryError(
      PATH_CODES.ROOT_MISSING,
      `无法解析记忆根目录的真实路径：${rootAbs} — 目录不存在或不可访问`,
      error,
    );
  }
  const realTarget = realPathProbe(targetAbs);
  if (!isInsideRoot(realRoot, realTarget)) {
    throw memoryError(
      PATH_CODES.PATH_OUTSIDE_ROOT,
      `拒绝越界路径：${targetAbs} 的真实路径 ${realTarget} 不在记忆根 ${rootAbs} 的真实路径 ${realRoot} 内 (E_PATH_OUTSIDE_ROOT)`,
    );
  }
  return targetAbs;
}

/** Assert an already-resolved path is inside the root; returns it unchanged. */
export function assertInsideRoot(root, target) {
  return resolveInside(root, target);
}

/** POSIX-style path relative to the root, for reports and index rows. */
export function relativePath(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join('/');
}
