// Single source of truth for the package version.
//
// The version is stated exactly once: `package.json#version`. Everything else
// (the packer, the acceptance suite, release checks) reads it through this
// module. A second literal anywhere in the tree is how 0.7.1 kept shipping as
// "expected version" long after package.json moved on, so `validateVersion`
// rejects anything that is not a plain MAJOR.MINOR.PATCH release tag and the
// callers refuse to build rather than guess.
//
// Only Node built-ins are used: the package has no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository/package root, resolved from this file, never from the cwd. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json');

/** Plain release versions, plus the `-rc.N` release-candidate suffix: no `v`
 *  prefix, no build metadata, no other prerelease identifiers. */
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/;

export const VERSION_CODES = Object.freeze({
  PACKAGE_UNREADABLE: 'PACKAGE_JSON_UNREADABLE',
  VERSION_INVALID: 'BAD_PACKAGE_VERSION',
});

function versionError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Validate a claimed version. Returns the exact string so callers record what
 * they checked instead of re-deriving it.
 *
 * `where` only decorates the error message (e.g. "package.json").
 */
export function validateVersion(value, where = 'package.json') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw versionError(
      VERSION_CODES.VERSION_INVALID,
      `${where}: version must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  if (!VERSION_PATTERN.test(value)) {
    throw versionError(
      VERSION_CODES.VERSION_INVALID,
      `${where}: invalid version ${JSON.stringify(value)} — expected MAJOR.MINOR.PATCH ` +
      '(for example 0.7.2) or MAJOR.MINOR.PATCH-rc.N (for example 0.8.0-rc.3); ' +
      'build metadata and other prerelease tags are not accepted by the packer',
    );
  }
  return value;
}

/** Read and parse `<root>/package.json`; never falls back to another file. */
export function readPackageManifest(root = PACKAGE_ROOT) {
  const file = path.join(path.resolve(root), 'package.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw versionError(
      VERSION_CODES.PACKAGE_UNREADABLE,
      `cannot read ${file} (${error?.code ?? error?.message})`,
      error,
    );
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('package.json must contain a JSON object');
    }
    return parsed;
  } catch (error) {
    throw versionError(
      VERSION_CODES.PACKAGE_UNREADABLE,
      `cannot parse ${file}: ${error?.message ?? String(error)}`,
      error,
    );
  }
}

/** The validated version of the package rooted at `root`. */
export function readPackageVersion(root = PACKAGE_ROOT) {
  const manifest = readPackageManifest(root);
  return validateVersion(manifest.version, path.join(path.resolve(root), 'package.json'));
}

/**
 * The version this checkout ships. Import-time resolution is deliberate: a
 * broken or malformed package.json must fail the packer and the suite loudly
 * instead of silently packing "undefined".
 */
export const VERSION = readPackageVersion(PACKAGE_ROOT);
