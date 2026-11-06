// Card manifest: one small JSON file that says what the card store looked like
// when it was last written.
//
// B3 asks for `<memoryRoot>/.longlive/manifest.json` with, per card,
// `{path, sha256, written_at, source}`, plus a verify function a startup check
// can call. The manifest is a *snapshot*, not an authority: a card whose bytes
// no longer match its recorded sha256 is reported as `changed`, never rewritten.
//
// Why this shape:
//   * `path` is POSIX-relative to memoryRoot, so the file is portable and does
//     not leak an absolute Windows path;
//   * `sha256` is over the UTF-8 bytes, exactly like `sha256File`;
//   * `written_at`/`source` come from the B3 provenance extras when present;
//     for legacy cards the file mtime is the only honest fallback;
//   * cards that could not be parsed are still tracked (sha over the raw text)
//     so an edit to a broken card is visible, not invisible.
//
// The manifest itself is never written by `verifyManifest`; rebuilding is an
// explicit `refreshManifest` call. That keeps verification read-only.

import fs from 'node:fs';
import path from 'node:path';

import { memoryError, relativePath, resolveInside } from './paths.js';
import { parseFrontmatter } from './frontmatter.js';
import {
  LONGLIVE_DIR, listMarkdownFiles, readJsonFile, sha256File, sha256Text, writeFileAtomic,
} from './state.js';
import { readProvenance } from './provenance.js';

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_VERSION = 1;

/** Directories scanned for cards. Kept here so cards.js and tests share one list. */
export const CARD_DIRS = Object.freeze(['topics', 'journal', 'procedures']);

/** `<memoryRoot>/.longlive/manifest.json`. */
export function manifestPath(root) {
  return path.join(root, LONGLIVE_DIR, MANIFEST_FILE);
}

function clean(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function fileIso(abs) {
  try {
    return fs.statSync(abs).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * One manifest row for an existing card.
 *
 * A card with an unterminated frontmatter block still gets a row: `sha256` is
 * read over the raw bytes and `source` is null. Hiding it would let an edit to
 * a broken card go unnoticed.
 */
export function manifestEntry(root, abs, { now = new Date() } = {}) {
  const rel = relativePath(root, abs);
  const text = fs.readFileSync(abs, 'utf8');
  let extras = {};
  try {
    extras = parseFrontmatter(text).extras;
  } catch {
    // A broken card is still tracked by its bytes; provenance is unavailable.
    extras = {};
  }
  const provenance = readProvenance(extras);
  const source = provenance.session === null && provenance.turn === null
    ? null
    : { session: provenance.session, turn: provenance.turn };
  const writtenAt = provenance.written_at ?? fileIso(abs) ?? now.toISOString();
  return {
    path: rel,
    sha256: sha256Text(text),
    written_at: writtenAt,
    source,
  };
}

function byPath(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/** Build the manifest object without touching the disk. */
export function buildManifest(root, { now = new Date() } = {}) {
  const cards = [];
  const warnings = [];
  for (const dir of CARD_DIRS) {
    for (const abs of listMarkdownFiles(root, dir)) {
      try {
        cards.push(manifestEntry(root, abs, { now }));
      } catch (error) {
        warnings.push({ path: relativePath(root, abs), message: error?.message ?? String(error) });
      }
    }
  }
  cards.sort(byPath);
  return {
    version: MANIFEST_VERSION,
    generated_at: now.toISOString(),
    cards,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Write a manifest object atomically and prove the bytes read back. */
export function writeManifest(root, manifest, { now = new Date() } = {}) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw memoryError('E_BAD_ARGUMENT', 'writeManifest 需要 manifest 对象');
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const written = writeFileAtomic(root, manifestPath(root), text, { backup: false, now });
  return { ...written, manifest };
}

/** Rebuild the manifest from every card on disk and write it. */
export function refreshManifest(root, { now = new Date() } = {}) {
  const manifest = buildManifest(root, { now });
  return writeManifest(root, manifest, { now });
}

/**
 * Read `.longlive/manifest.json`. A missing file returns null; malformed JSON
 * throws `E_MANIFEST_CORRUPT` because pretending an unreadable manifest is an
 * empty one would make the next verification silently pass.
 */
export function readManifest(root) {
  const file = manifestPath(root);
  const raw = readJsonFile(file, 'E_MANIFEST_CORRUPT', file);
  if (raw == null) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw memoryError('E_MANIFEST_CORRUPT', `manifest 必须是对象：${file}`);
  }
  if (!Array.isArray(raw.cards)) {
    throw memoryError('E_MANIFEST_CORRUPT', `manifest.cards 必须是数组：${file}`);
  }
  return {
    version: Number.isInteger(raw.version) ? raw.version : MANIFEST_VERSION,
    generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : null,
    cards: raw.cards,
  };
}

function diskCards(root) {
  const found = new Map();
  for (const dir of CARD_DIRS) {
    for (const abs of listMarkdownFiles(root, dir)) {
      found.set(relativePath(root, abs), abs);
    }
  }
  return found;
}

/**
 * Compare the manifest in memory with the cards on disk.
 *
 * Returns `{ok, checked, changed, missing, untracked, invalid, manifestPath}`.
 * `changed` carries both hashes, because "the card changed" is only actionable
 * when the caller can see what it was expected to be.
 *
 * Read-only: this function never writes the manifest.
 */
export function verifyManifest(root, { manifest = undefined } = {}) {
  const file = manifestPath(root);
  const base = {
    ok: false,
    checked: 0,
    changed: [],
    missing: [],
    untracked: [],
    invalid: [],
    manifestPath: file,
  };
  let current;
  try {
    current = manifest === undefined ? readManifest(root) : manifest;
  } catch (error) {
    return { ...base, code: error?.code ?? 'E_MANIFEST_CORRUPT', message: error?.message ?? String(error) };
  }
  if (current == null) {
    // A missing manifest cannot prove anything. Every card on disk is untracked
    // rather than "fine": that is the honest answer for a startup check.
    const untracked = [...diskCards(root).keys()].sort();
    return {
      ...base,
      code: 'E_MANIFEST_MISSING',
      message: `manifest 不存在：${file} — 先跑一次 refreshManifest 建立基线`,
      untracked,
    };
  }

  const rows = Array.isArray(current.cards) ? current.cards : [];
  const tracked = new Set();
  for (const [index, row] of rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      base.invalid.push({ index, reason: 'row is not an object' });
      continue;
    }
    const rel = typeof row.path === 'string' ? row.path.trim() : '';
    const expected = typeof row.sha256 === 'string' ? row.sha256.trim().toLowerCase() : '';
    if (rel === '' || expected === '') {
      base.invalid.push({ index, path: rel || null, reason: 'path/sha256 missing' });
      continue;
    }
    if (tracked.has(rel)) {
      base.invalid.push({ index, path: rel, reason: 'duplicate manifest row' });
      continue;
    }
    tracked.add(rel);
    let abs;
    try {
      abs = resolveInside(root, rel);
    } catch (error) {
      base.invalid.push({ index, path: rel, reason: error?.message ?? String(error) });
      continue;
    }
    if (!fs.existsSync(abs)) {
      base.missing.push({ path: rel, expected_sha256: expected });
      continue;
    }
    base.checked += 1;
    const actual = sha256File(abs);
    if (actual !== expected) {
      base.changed.push({ path: rel, expected_sha256: expected, actual_sha256: actual });
    }
  }

  for (const rel of diskCards(root).keys()) {
    if (!tracked.has(rel)) base.untracked.push(rel);
  }
  base.untracked.sort();
  base.ok = base.changed.length === 0
    && base.missing.length === 0
    && base.untracked.length === 0
    && base.invalid.length === 0
    && base.code === undefined;
  base.consistent = base.ok;
  return base;
}
