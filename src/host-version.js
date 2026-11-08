// Best-effort host compatibility check.
//
// `engines.dsh` in package.json is the declared contract; this module is the
// runtime half of it. A package that only declares a range but never reads the
// host version leaves the user with tools that silently answer
// `status:"unavailable"` and no sentence explaining why (that is exactly what
// 0.7.2 did: probeService turned a missing service into null).
//
// Two rules keep this from becoming a new failure mode:
//   - an undetectable host version is NOT an error (the host may not expose
//     one in a given embedding); we say nothing and keep working;
//   - a detected mismatch warns once and continues. The plugin degrades, it
//     does not crash and does not refuse to load.
//
// The comparison is intentionally small and dependency-free (the package has
// no runtime dependencies and should not grow one for this): >=, <=, >, <, =,
// ^, ~, space-separated AND, || OR, and `*`. Pre-release tags are compared by
// their core version so a host reporting `0.2.1-rc.5` satisfies `>=0.2.0`.

import fs from 'node:fs';
import path from 'node:path';
import { readPackageManifest, PACKAGE_ROOT } from './version.js';

export const HOST_VERSION_ENV = 'DSH_HOST_VERSION';
/** Explicit override for the host manifest path (tests, unusual embeddings). */
export const HOST_PACKAGE_ENV = 'DSH_HOST_PACKAGE';
export const DEFAULT_HOST_RANGE = '>=0.2.0 <1.0.0';

/** The desktop host keeps this beside its package.json. */
const HOST_RUNTIME_FILE = 'desktop-runtime.json';

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?\s*(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|\*|x)$/i;

export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
    raw: value.trim(),
  };
}

function compareCore(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

function upperForCaret(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: version.patch + 1 };
}

function matchComparator(version, comparator) {
  const match = COMPARATOR_RE.exec(comparator.trim());
  if (!match) return false;
  const op = match[1] ?? '=';
  const text = match[2];
  if (text === '*' || /^x$/i.test(text)) return true;
  const target = parseVersion(text);
  if (!target) return false;
  const order = compareCore(version, target);
  switch (op) {
    case '>=': return order >= 0;
    case '<=': return order <= 0;
    case '>': return order > 0;
    case '<': return order < 0;
    case '=': return order === 0;
    case '^': {
      if (order < 0) return false;
      const cap = upperForCaret(target);
      return compareCore(version, cap) < 0;
    }
    case '~': {
      if (order < 0) return false;
      return compareCore(version, { major: target.major, minor: target.minor + 1, patch: 0 }) < 0;
    }
    default: return false;
  }
}

/** True when `version` (string) satisfies `range` (npm-ish, dependency-free). */
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const text = typeof range === 'string' ? range.trim() : '';
  if (!text) return true;
  return text.split('||').some((clause) => {
    const parts = clause.trim().split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every((part) => matchComparator(parsed, part));
  });
}

/** The range declared in package.json, or the built-in fallback. */
export function declaredHostRange(root = PACKAGE_ROOT) {
  try {
    const manifest = readPackageManifest(root);
    const range = manifest?.engines?.dsh;
    return typeof range === 'string' && range.trim() ? range.trim() : DEFAULT_HOST_RANGE;
  } catch {
    return DEFAULT_HOST_RANGE;
  }
}

function pickVersion(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.version === 'string') return value.version;
  return null;
}

/**
 * Candidate host manifests, in priority order. The desktop host runs the DSH
 * core inside Electron, so `process.resourcesPath` names the install root and
 * the core package.json lives inside the asar archive (Electron patches fs to
 * read it transparently). A plain Node process has no resourcesPath; there the
 * candidates below simply do not exist and detection falls through to
 * `unknown`, which is a normal result, not an error.
 */
export function hostPackageCandidates(options = {}) {
  const env = options.env ?? process.env;
  const resourcesPath = typeof options.resourcesPath === 'string'
    ? options.resourcesPath : process.resourcesPath;
  const execPath = typeof options.execPath === 'string' ? options.execPath : process.execPath;
  const found = [];
  const add = (file, origin) => {
    if (typeof file !== 'string' || !file.trim()) return;
    const absolute = path.resolve(file.trim());
    if (found.some((entry) => entry.path === absolute)) return;
    found.push({ path: absolute, origin });
  };

  add(options.configPath, 'config.hostPackagePath');
  add(env?.[HOST_PACKAGE_ENV], `env.${HOST_PACKAGE_ENV}`);

  if (typeof resourcesPath === 'string' && resourcesPath.trim()) {
    add(path.join(resourcesPath.trim(), 'app.asar', 'dsh', 'package.json'), 'process.resourcesPath');
    add(path.join(resourcesPath.trim(), 'app.asar', 'dsh', HOST_RUNTIME_FILE), 'process.resourcesPath');
  }
  if (typeof execPath === 'string' && execPath.trim()) {
    const resources = path.join(path.dirname(execPath.trim()), 'resources');
    add(path.join(resources, 'app.asar', 'dsh', 'package.json'), 'process.execPath');
    add(path.join(resources, 'app.asar', 'dsh', HOST_RUNTIME_FILE), 'process.execPath');
  }
  return found;
}

function manifestVersion(manifest) {
  const direct = pickVersion(manifest);
  if (direct) return direct;
  const release = manifest && typeof manifest === 'object' ? manifest.release : null;
  return pickVersion(release);
}

/**
 * Read the first candidate that yields a parseable version.
 * Returns { version, source: 'hostPackage', path, origin } or null.
 * Unreadable/corrupt candidates are skipped silently: this is advisory.
 */
export function detectHostPackageVersion(options = {}) {
  const readFile = typeof options.readFile === 'function'
    ? options.readFile
    : (file) => fs.readFileSync(file, 'utf8');
  for (const candidate of hostPackageCandidates(options)) {
    try {
      const manifest = JSON.parse(readFile(candidate.path));
      const version = manifestVersion(manifest);
      if (version && parseVersion(version)) {
        return {
          version: version.trim(),
          source: 'hostPackage',
          path: candidate.path,
          origin: candidate.origin,
        };
      }
    } catch {
      /* missing, unreadable or corrupt manifest: try the next candidate */
    }
  }
  return null;
}

/**
 * Find the host version from the surfaces a Cordis plugin can see.
 * Returns { version, source, path? }. `version` is null when nothing usable
 * exists. `options.resourcesPath` / `options.execPath` / `options.readFile`
 * exist so tests can fake a host install without touching the real one.
 */
export function detectHostVersion(ctx, config = {}, env = process.env, options = {}) {
  // A Cordis context is a Proxy: reading a property that is not declared in
  // `inject` throws `cannot get property "..." without inject`. This check is
  // advisory, so every host-surface read must be best-effort. 0.7.3 read
  // ctx.version eagerly and took the whole plugin entry down in the web host.
  const read = (fn) => {
    try { return fn(); } catch { return undefined; }
  };
  const candidates = [
    ['ctx.version', read(() => ctx?.version)],
    ['ctx.get("version")', read(() => (typeof ctx?.get === 'function' ? ctx.get('version') : undefined))],
    ['ctx.app.version', read(() => ctx?.app?.version)],
    ['ctx.get("app").version', read(() => (typeof ctx?.get === 'function' ? ctx.get('app')?.version : undefined))],
    ['ctx.root.version', read(() => ctx?.root?.version)],
    ['config.hostVersion', config?.hostVersion],
    [`env.${HOST_VERSION_ENV}`, env?.[HOST_VERSION_ENV]],
  ];
  for (const [source, value] of candidates) {
    const version = pickVersion(value);
    if (version && parseVersion(version)) return { version: version.trim(), source };
  }
  // Last resort: the host's own manifest. This is the primary path on the
  // desktop host (0.2.1), whose Cordis context exposes no version property.
  const fromPackage = detectHostPackageVersion({
    configPath: config?.hostPackagePath,
    env,
    resourcesPath: options.resourcesPath,
    execPath: options.execPath,
    readFile: options.readFile,
  });
  if (fromPackage) return fromPackage;
  return { version: null, source: null };
}

/**
 * Compare a detected host version against the declared range.
 * Returns { ok, status: 'ok'|'unknown'|'mismatch', version, range, warning }.
 * `warning` is a complete user-facing sentence, or null.
 */
export function checkHostCompatibility(options = {}) {
  const range = typeof options.range === 'string' && options.range.trim()
    ? options.range.trim() : declaredHostRange(options.root);
  const version = pickVersion(options.version);
  if (!version || !parseVersion(version)) {
    return { ok: true, status: 'unknown', version: version ?? null, range, warning: null };
  }
  if (satisfies(version, range)) {
    return { ok: true, status: 'ok', version, range, warning: null };
  }
  const plugin = options.pluginVersion ? `dsh-longlive ${options.pluginVersion}` : 'dsh-longlive';
  return {
    ok: false,
    status: 'mismatch',
    version,
    range,
    warning: `宿主版本 ${version} 不在 ${plugin} 声明的 engines.dsh 区间 "${range}" 内 — ` +
      '插件会以降级模式继续加载（缺失的宿主服务对应的工具会返回 status:"unavailable"，不会崩溃）。' +
      `请升级/降级宿主到 ${range}，或安装与该宿主匹配的插件版本。`,
  };
}

const warned = new Set();

/** Emit `text` at most once per process through ctx.logger, else console.warn. */
export function warnOnce(ctx, text) {
  if (!text || warned.has(text)) return false;
  warned.add(text);
  let emitted = false;
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('longlive') : null;
    if (logger && typeof logger.warn === 'function') {
      logger.warn(text);
      emitted = true;
    }
  } catch {
    emitted = false;
  }
  if (!emitted) {
    try {
      console.warn(`[dsh-longlive] ${text}`);
    } catch {
      /* a host without console must not break the plugin */
    }
  }
  return true;
}
