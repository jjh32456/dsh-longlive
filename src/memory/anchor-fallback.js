// src/memory/anchor-fallback.js — stale anchor → hot-truncate archive fallback.
//
// A session/turn anchor can become stale after a visible truncation: the live
// session log no longer contains the original turn, but hot-truncate archived
// every cut event under `.longlive/hot-truncate/*.jsonl` before touching the
// surface. This module locates that archive and returns a read-only recovery
// handle; it never rewrites the session or the anchor.

import fs from 'node:fs';
import path from 'node:path';

import { resolveInside } from './paths.js';

export const ANCHOR_FALLBACK_SCHEMA = 'anchor-fallback/v1';

function listArchives(memoryRoot) {
  const dir = resolveInside(memoryRoot, path.join('.longlive', 'hot-truncate'));
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function parseHeader(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    const header = JSON.parse(first);
    if (header?.kind !== 'hot-truncate/header') return null;
    return header;
  } catch {
    return null;
  }
}

/** Find the archive that cut a given session/turn. */
export function findHotTruncateFallback({ memoryRoot = '', sessionId = '', turn = null } = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '' || typeof sessionId !== 'string' || sessionId === '') return null;
  for (const file of listArchives(root)) {
    const header = parseHeader(file);
    if (!header || header.sessionId !== sessionId) continue;
    const cutTurns = Array.isArray(header.cutTurns) ? header.cutTurns : [];
    const hit = cutTurns.find((item) => Number(item.turn) === Number(turn));
    if (hit) {
      return {
        schema: ANCHOR_FALLBACK_SCHEMA,
        ok: true,
        source: 'hot-truncate-archive',
        archivePath: file,
        sessionId,
        turn,
        cut: hit,
        header,
      };
    }
  }
  return null;
}

/**
 * Read the archived events for one turn. Returns [] when the archive cannot be
 * parsed; callers should treat that as "fallback unavailable", not as live data.
 */
export function readArchivedTurn({ archivePath = '', turn = null } = {}) {
  try {
    const lines = fs.readFileSync(archivePath, 'utf8').split('\n');
    const out = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      let row = null;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.kind === 'hot-truncate/header') continue;
      const rowTurn = row?.turn ?? row?.data?.turn;
      if (Number(rowTurn) === Number(turn)) out.push(row);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve an anchor through a caller-provided live reader, then archive fallback.
 * deps.readLive(anchor) -> { found, state, ... } (may throw/return null).
 */
export function resolveAnchorWithFallback({ memoryRoot = '', anchor = null, readLive = null } = {}) {
  if (!anchor || typeof anchor !== 'object') return { ok: false, code: 'E_ANCHOR_REQUIRED' };
  let live = null;
  try { live = typeof readLive === 'function' ? readLive(anchor) : null; } catch { live = null; }
  if (live?.state === 'live' || live?.found === true && live?.state !== 'stale' && live?.state !== 'missing') {
    return { ok: true, schema: ANCHOR_FALLBACK_SCHEMA, source: 'live', live, recovered: false };
  }
  const fallback = findHotTruncateFallback({ memoryRoot, sessionId: anchor.sessionId, turn: anchor.turn });
  if (!fallback) {
    return {
      ok: false,
      schema: ANCHOR_FALLBACK_SCHEMA,
      source: 'none',
      code: live?.state === 'missing' ? 'E_ANCHOR_MISSING' : 'E_ANCHOR_STALE_NO_ARCHIVE',
      live,
    };
  }
  const archivedEvents = readArchivedTurn({ archivePath: fallback.archivePath, turn: anchor.turn });
  return {
    ...fallback,
    source: 'hot-truncate-archive',
    recovered: true,
    live,
    archivedEvents,
    note: 'read-only fallback: original events from hot-truncate archive; session file is unchanged',
  };
}
