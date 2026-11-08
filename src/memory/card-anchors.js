// src/memory/card-anchors.js — 1.8.0 precision-card ↔ source backlinks (sidecar).
//
// Precisely curated cards (topics/journal/handover/flow markdown) keep their
// prose untouched. Provenance lives in `.longlive/index/card-anchors.jsonl`:
//   { schema, rel, sourceEventIds[], anchors[], legacy, at, hash, prevLineHash, sig }
//
// Every line is hash-chained and HMAC-signed with the host key
// (`<memoryRoot>/.longlive/.hostkey`). Readers verify the chain + signature;
// tampered/replayed/duplicate rows fail closed (E_CHAIN_TAMPERED) and are
// audited. Unsigned legacy rows are `untrusted`, never silently accepted.

import fs from 'node:fs';
import path from 'node:path';

import { hmacHexFor, sha256Hex, stableStringify } from '../actions/fs.js';
import { readHostKey, resolveHostKey } from '../role/writeprotect.js';
import { updateExtras } from './frontmatter.js';

export const CARD_ANCHOR_SCHEMA = 'card-anchor/v1';
export const CARD_ANCHORS_REL = path.join('.longlive', 'index', 'card-anchors.jsonl');
export const GENESIS_HASH = '0'.repeat(64);
export const CARD_AUDIT_REL = path.join('.longlive', 'index', 'card-audit.jsonl');

let cache = null;

export function cardAnchorsPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), CARD_ANCHORS_REL);
}

function auditSidecar(memoryRoot, code, detail = null) {
  try {
    const file = path.join(path.resolve(String(memoryRoot)), CARD_AUDIT_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({
      schema: 'card-audit/v1',
      at: new Date().toISOString(),
      action: 'sidecar-tamper',
      code,
      detail,
    })}\n`, 'utf8');
  } catch { /* audit failure must not make the sidecar trusted */ }
}

function linkPayload(link) {
  return {
    schema: link?.schema ?? CARD_ANCHOR_SCHEMA,
    linkId: link?.linkId ?? '',
    rel: link?.rel ?? '',
    sourceEventIds: Array.isArray(link?.sourceEventIds) ? link.sourceEventIds : [],
    anchors: Array.isArray(link?.anchors) ? link.anchors : [],
    legacy: link?.legacy === true,
    at: link?.at ?? '',
  };
}

function lineHashOf(link) {
  return sha256Hex(stableStringify(linkPayload(link)));
}

function signHash(auditKey, hash) {
  return hmacHexFor(auditKey, hash);
}

export function linkIdOf(rel) {
  return `link:${sha256Hex(String(rel ?? '')).slice(0, 16)}`;
}

/** Raw (unverified) view, for migration/inspection tooling only. */
export function readCardAnchors(memoryRoot) {
  const file = cardAnchorsPathOf(memoryRoot);
  let stat = null;
  try { stat = fs.statSync(file); } catch { cache = { file: null, mtimeMs: 0, size: 0, links: new Map() }; return cache.links; }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.links;
  const links = new Map();
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return links; }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const link = JSON.parse(line);
      if (link && typeof link.rel === 'string') links.set(link.rel, link);
    } catch { /* corrupt line skipped; verified reader will reject the file */ }
  }
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, links };
  return links;
}

/**
 * Verify the whole sidecar. Any bad hash, broken prev link, invalid signature,
 * duplicate rel, or unsigned legacy row makes the sidecar untrusted.
 * No host key => fail closed: links are not returned.
 */
export function readVerifiedCardAnchors({ memoryRoot, auditKey = null } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  const file = cardAnchorsPathOf(root);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch {
    return { ok: true, trusted: fs.existsSync(file) === false, links: new Map(), code: null, reason: 'no-sidecar' };
  }
  let key = auditKey;
  if (!key) key = readHostKey(root);
  if (!key) {
    auditSidecar(root, 'E_NO_KEY');
    return { ok: false, trusted: false, links: new Map(), code: 'E_NO_KEY', reason: 'host key unavailable' };
  }
  const links = new Map();
  let prev = GENESIS_HASH;
  for (const lineText of raw.split('\n')) {
    if (lineText.trim() === '') continue;
    let line;
    try { line = JSON.parse(lineText); } catch {
      auditSidecar(root, 'E_CHAIN_TAMPERED', 'bad-json');
      return { ok: false, trusted: false, links: new Map(), code: 'E_CHAIN_TAMPERED', reason: 'bad-json' };
    }
    const hash = lineHashOf(line);
    if (line.hash !== hash) {
      auditSidecar(root, 'E_CHAIN_TAMPERED', 'hash-mismatch');
      return { ok: false, trusted: false, links: new Map(), code: 'E_CHAIN_TAMPERED', reason: 'hash-mismatch' };
    }
    if (line.prevLineHash !== prev) {
      auditSidecar(root, 'E_CHAIN_TAMPERED', 'prev-mismatch');
      return { ok: false, trusted: false, links: new Map(), code: 'E_CHAIN_TAMPERED', reason: 'prev-mismatch' };
    }
    if (typeof line.sig !== 'string' || signHash(key, hash) !== line.sig) {
      auditSidecar(root, 'E_CHAIN_TAMPERED', 'sig-mismatch');
      return { ok: false, trusted: false, links: new Map(), code: 'E_CHAIN_TAMPERED', reason: 'sig-mismatch' };
    }
    if (typeof line.rel !== 'string' || line.rel === '' || line.rel.startsWith('/') || line.rel.includes('..')) {
      auditSidecar(root, 'E_CHAIN_TAMPERED', 'bad-rel');
      return { ok: false, trusted: false, links: new Map(), code: 'E_CHAIN_TAMPERED', reason: 'bad-rel' };
    }
    if (links.has(line.rel)) {
      auditSidecar(root, 'E_CHAIN_TAMPERED', 'duplicate-rel');
      return { ok: false, trusted: false, links: new Map(), code: 'E_CHAIN_TAMPERED', reason: 'duplicate-rel' };
    }
    links.set(line.rel, { ...line, trusted: true });
    prev = line.hash;
  }
  return { ok: true, trusted: true, links, code: null, reason: 'ok' };
}

/**
 * Append one signed precision-card backlink. Idempotent by rel: the same rel is
 * never appended twice (duplicate rel would make the whole sidecar untrusted).
 */
export function appendCardAnchor({
  memoryRoot,
  rel,
  sourceEventIds = [],
  anchors = [],
  legacy = false,
  at = null,
  dryRun = false,
  auditKey = null,
} = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') throw new Error('E_MEMORY_ROOT: appendCardAnchor requires memoryRoot');
  const relText = String(rel ?? '').replace(/\\/g, '/');
  if (relText === '' || relText.startsWith('/') || relText.includes('..')) throw new Error(`E_CARD_REL: ${JSON.stringify(rel)}`);
  const existing = readCardAnchors(root);
  if (existing.has(relText)) return { ok: true, written: false, skipped: true, rel: relText };
  let key = auditKey;
  if (!key) { try { key = resolveHostKey(root); } catch { key = null; } }
  if (!key) throw new Error('E_NO_KEY: card-anchors write requires the host key');
  const prev = existing.size > 0 ? [...existing.values()][existing.size - 1]?.hash ?? GENESIS_HASH : GENESIS_HASH;
  const link = {
    schema: CARD_ANCHOR_SCHEMA,
    linkId: linkIdOf(relText),
    rel: relText,
    sourceEventIds: (Array.isArray(sourceEventIds) ? sourceEventIds : []).filter((id) => typeof id === 'string' && id !== ''),
    anchors: (Array.isArray(anchors) ? anchors : []).filter((anchor) => anchor && typeof anchor === 'object'),
    legacy: legacy === true || ((!sourceEventIds || sourceEventIds.length === 0) && (!anchors || anchors.length === 0)),
    at: at ?? new Date().toISOString(),
  };
  link.hash = lineHashOf(link);
  link.prevLineHash = prev;
  link.sig = signHash(key, link.hash);
  if (!dryRun) {
    const file = cardAnchorsPathOf(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(link)}\n`, 'utf8');
    cache = null;
  }
  return { ok: true, written: !dryRun, skipped: false, rel: relText, link, dryRun };
}

/** Write backlinks onto a precision card's frontmatter extras (new cards only). */
export function attachCardExtras({ memoryRoot, rel, sourceEventIds = [], anchors = [], legacy = false } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  const abs = path.resolve(root, String(rel ?? ''));
  if (!abs.startsWith(root + path.sep)) throw new Error('E_CARD_PATH: outside memoryRoot');
  const text = fs.readFileSync(abs, 'utf8');
  const extras = {
    sourceEventIds: JSON.stringify(sourceEventIds),
    anchors: JSON.stringify(anchors),
    ...(legacy ? { legacy: true } : {}),
  };
  const updated = updateExtras(text, extras);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, updated, 'utf8');
  fs.renameSync(tmp, abs);
  return { ok: true, rel, extras };
}
