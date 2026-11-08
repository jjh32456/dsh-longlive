import { optionalPeerNames as adapterOptionalPeerNames } from './adapters/registry.js';

// Optional runtime dependencies for dsh-longlive (0.8.0-rc.8).
//
// longlive has no hard runtime dependencies. It cooperates with optional
// external memory plugins (registered via src/adapters/) when one is installed
// in the host profile, but it must load and work without them. This module answers one question for the startup
// path and for scripts/longlive-doctor.mjs:
//
//   "Which DSH profiles are in scope, and is the optional peer enabled there?"
//
// Enabled means either an own key in the profile's `dependencies` (installed)
// or the package name in `dsh.profile.bundles` (enabled bundle). Nothing here
// throws: an unreadable or missing profile manifest is skipped, and a DSH home
// without profiles is reported as vacuously fine. Startup must never crash
// because an optional peer is absent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

/** The plugin itself — used to find profiles where longlive is enabled. */
export const LONGLIVE_PLUGIN = '@jjh32456/dsh-longlive';

/** Used only when package.json cannot be read or has no optional peers. */
export const KNOWN_OPTIONAL_PEERS = Object.freeze(adapterOptionalPeerNames());

let manifestCache = null;

function ownManifest() {
  if (manifestCache) return manifestCache;
  try {
    manifestCache = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  } catch {
    manifestCache = { peerDependenciesMeta: Object.fromEntries(KNOWN_OPTIONAL_PEERS.map((name) => [name, { optional: true }])) };
  }
  return manifestCache;
}

/**
 * Names of optional peers declared by a package manifest.
 * Falls back to the known peer when the manifest carries no
 * `peerDependenciesMeta.optional` entries.
 */
export function optionalPeerNames(manifest = ownManifest()) {
  const peers = manifest?.peerDependencies;
  const meta = manifest?.peerDependenciesMeta;
  const names = [];
  if (meta && typeof meta === 'object') {
    for (const [name, settings] of Object.entries(meta)) {
      if (settings?.optional === true && (!peers || Object.prototype.hasOwnProperty.call(peers, name))) {
        names.push(name);
      }
    }
  }
  return names.length > 0 ? names : KNOWN_OPTIONAL_PEERS.slice();
}

/** DSH home: explicit option, then $DSH_HOME, then <homedir>/.dsh. */
export function resolveDshHome(env = process.env) {
  const configured = env?.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), '.dsh');
}

/**
 * Read <home>/profiles/<name>/package.json.
 * Returns [{name, manifest, error}] sorted by name. Never throws: a missing
 * profiles directory is an empty list, an unreadable manifest keeps its row
 * with `manifest: null` and an `error`.
 */
export function scanProfiles(home) {
  const profilesDir = path.join(home, 'profiles');
  let entries;
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(profilesDir, entry.name, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      rows.push({ name: entry.name, manifest, error: null });
    } catch (error) {
      rows.push({ name: entry.name, manifest: null, error });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function bundleNames(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return [];
  return bundles
    .map((bundle) => (typeof bundle === 'string' ? bundle : bundle?.name))
    .filter((name) => typeof name === 'string' && name !== '');
}

function hasPackage(manifest, name) {
  if (!manifest || typeof manifest !== 'object') return false;
  const deps = manifest.dependencies;
  if (deps && typeof deps === 'object' && Object.prototype.hasOwnProperty.call(deps, name)) {
    return true;
  }
  return bundleNames(manifest).includes(name);
}

/**
 * One-line startup guidance for missing optional peers.
 *
 * Returns null when nothing is missing, so a healthy profile stays quiet.
 * Deliberately pure: the startup path must never install or prompt, only point
 * at the explicit `--setup` wizard, which prints a plan and asks for YES.
 */
export function formatMissingDepsWarning(missing) {
  const names = Array.isArray(missing)
    ? missing.filter((name) => typeof name === 'string' && name.trim() !== '')
    : [];
  if (names.length === 0) return null;
  return `可选依赖缺失：${names.join('、')}；安装运行 \`node scripts/longlive-doctor.mjs --setup\`（会先列清单再要你确认）`;
}

/**
 * Check the optional peers against the profiles that matter.
 *
 * Scope:
 *   1. explicit `options.profile` or $DSH_PROFILE -> that profile only;
 *   2. otherwise profiles where dsh-longlive is enabled, requiring the
 *      peer in every one of them;
 *   3. if longlive is enabled nowhere, every profile, accepting the peer if any
 *      profile has it.
 *
 * @returns {{ok: boolean, profile: string|null, missing: string[], present: string[]}}
 */
export function checkOptionalDeps(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ? path.resolve(options.home) : resolveDshHome(env);
  const dependencies = Array.isArray(options.dependencies) && options.dependencies.length > 0
    ? options.dependencies.slice()
    : optionalPeerNames(ownManifest());

  const rows = scanProfiles(home);
  const readable = rows.filter((row) => row.manifest && !row.error);

  // No profile directory at all: nothing to check, and startup must stay quiet.
  if (readable.length === 0) {
    return { ok: true, profile: null, missing: [], present: [] };
  }

  const requested = options.profile ?? env?.DSH_PROFILE;
  let scoped;
  let profile;
  let requireAll;
  if (typeof requested === 'string' && requested.trim() !== '') {
    scoped = readable.filter((row) => row.name === requested.trim());
    profile = requested.trim();
    requireAll = true;
  } else {
    const longliveProfiles = readable.filter((row) => hasPackage(row.manifest, LONGLIVE_PLUGIN));
    if (longliveProfiles.length > 0) {
      scoped = longliveProfiles;
      requireAll = true;
    } else {
      scoped = readable;
      requireAll = false;
    }
    profile = scoped.length === 1 ? scoped[0].name : scoped.map((row) => row.name).join(',');
  }

  const present = [];
  const missing = [];
  for (const dependency of dependencies) {
    const holds = scoped.filter((row) => hasPackage(row.manifest, dependency)).length;
    const ok = requireAll ? scoped.length > 0 && holds === scoped.length : holds > 0;
    (ok ? present : missing).push(dependency);
  }

  return { ok: missing.length === 0, profile: profile || null, missing, present };
}
