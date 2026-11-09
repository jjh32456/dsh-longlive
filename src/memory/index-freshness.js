// src/memory/index-freshness.js — index freshness / lag / failure ledger.
//
// The old INDEX.md "generated at" timestamp only said when a scan ran; it did
// not say whether the scan saw the latest cards/events. This module separates:
//   * generatedAt: when INDEX.md was last written
//   * dataThroughAt: newest input mtime we can prove was considered
//   * indexLagMs:   dataThroughAt - generatedAt (index is behind data)
//   * dataAgeMs:    now - dataThroughAt (inputs are old but index is caught up)
// and writes the result into memory-state.json so STATUS/panel/tool callers can
// show "indexed through / lagging by" without inventing a health claim.

import fs from 'node:fs';
import path from 'node:path';

import { memoryRootFromConfig, resolveInside } from './paths.js';
import { readState, updateState } from './state.js';
import { cardsPathOf } from './auto-cards.js';

export const INDEX_FRESHNESS_SCHEMA = 'index-freshness/v1';
export const INDEX_FRESHNESS_STALE_MS = 5 * 60 * 1000;

function parseMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function countLines(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) if (line.trim() !== '') count += 1;
    return count;
  } catch {
    return 0;
  }
}

function indexPaths(root) {
  const longlive = resolveInside(root, '.longlive');
  return {
    indexDir: resolveInside(root, path.join('.longlive', 'index')),
    index: resolveInside(root, 'INDEX.md'),
    cards: cardsPathOf(root),
    events: resolveInside(root, path.join('.longlive', 'index', 'events.db')),
    audit: resolveInside(root, path.join('.longlive', 'index', 'events.audit.jsonl')),
    state: resolveInside(root, path.join('.longlive', 'memory-state.json')),
    longlive,
  };
}

/**
 * Pure-ish read-only freshness view. Never writes and never creates `.longlive`.
 */
export function getIndexFreshness({
  memoryRoot = '',
  now = new Date(),
  staleAfterMs = INDEX_FRESHNESS_STALE_MS,
} = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') {
    return {
      ok: false, schema: INDEX_FRESHNESS_SCHEMA, status: 'unknown',
      code: 'E_NO_MEMORY_ROOT', stale: true,
    };
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const nowAt = Number.isFinite(nowMs) ? nowMs : Date.now();
  const p = indexPaths(root);
  let state = {};
  let stateError = null;
  try { state = readState(root); } catch (error) { stateError = error?.code ?? String(error); }
  const generatedMs = parseMs(state.indexBuiltAt) ?? mtimeOf(p.index);
  const stateDataMs = parseMs(state.indexDataAt) ?? parseMs(state.lastCaptureAt);
  const dataCandidates = [
    stateDataMs,
    mtimeOf(p.cards),
    mtimeOf(p.events),
    mtimeOf(p.index),
  ].filter((value) => Number.isFinite(value));
  const dataMs = dataCandidates.length > 0 ? Math.max(...dataCandidates) : null;
  const indexLagMs = (Number.isFinite(generatedMs) && Number.isFinite(dataMs))
    ? Math.max(0, dataMs - generatedMs)
    : null;
  const dataAgeMs = Number.isFinite(dataMs) ? Math.max(0, nowAt - dataMs) : null;
  const lastError = typeof state.indexLastError === 'string' && state.indexLastError !== ''
    ? state.indexLastError
    : null;
  let status = 'fresh';
  if (stateError) status = 'error';
  else if (lastError) status = 'error';
  else if (!Number.isFinite(generatedMs) || !Number.isFinite(dataMs)) status = 'unknown';
  else if (indexLagMs > staleAfterMs) status = 'stale';
  // Legacy cold-archive diagnostic only; not used by recall/INDEX/panel stats.
  // D2 (1.8.2): cards.jsonl is no longer read or counted for freshness.
  const result = {
    ok: status === 'fresh' || status === 'stale',
    schema: INDEX_FRESHNESS_SCHEMA,
    status,
    healthy: status === 'fresh',
    stale: status !== 'fresh',
    generatedAt: iso(generatedMs),
    dataThroughAt: iso(dataMs),
    indexLagMs,
    dataAgeMs,
    staleAfterMs,
    lastError,
    lastErrorAt: typeof state.indexLastErrorAt === 'string' ? state.indexLastErrorAt : null,
    lastFailureCount: Number.isInteger(state.indexFailureCount) ? state.indexFailureCount : 0,
    lastRefreshAt: typeof state.indexLastRefreshAt === 'string' ? state.indexLastRefreshAt : null,
    paths: p,
    ...(stateError ? { stateError } : {}),
  };
  return result;
}

/** Persist a freshness/failure patch into memory-state.json (atomic). */
export function recordIndexFreshness({
  memoryRoot = '',
  patch = {},
  now = new Date(),
  staleAfterMs = INDEX_FRESHNESS_STALE_MS,
} = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') return { ok: false, code: 'E_NO_MEMORY_ROOT' };
  const current = readState(root);
  const nextPatch = {
    indexFreshness: patch.indexFreshness,
    indexLagMs: patch.indexLagMs,
    indexDataAt: patch.indexDataAt,
    indexLastRefreshAt: patch.indexLastRefreshAt,
    // indexAutoCards intentionally removed in 1.8.2: no panel/INDEX stat.
    ...(patch.indexBuiltAt ? { indexBuiltAt: patch.indexBuiltAt } : {}),
    ...('indexLastError' in patch ? { indexLastError: patch.indexLastError } : {}),
    ...(patch.indexLastErrorAt ? { indexLastErrorAt: patch.indexLastErrorAt } : {}),
    ...(Number.isInteger(patch.indexFailureCount) ? { indexFailureCount: patch.indexFailureCount } : {}),
  };
  for (const key of Object.keys(nextPatch)) {
    if (nextPatch[key] === undefined) delete nextPatch[key];
  }
  updateState(root, nextPatch, { now });
  return { ok: true, state: readState(root), freshness: getIndexFreshness({ memoryRoot: root, now, staleAfterMs }) };
}

/**
 * Record a failed refresh without throwing: capture must not lose the turn, but
 * the next status read has to show the failure.
 */
export function markIndexFailure({
  memoryRoot = '',
  error = null,
  now = new Date(),
  staleAfterMs = INDEX_FRESHNESS_STALE_MS,
} = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') return { ok: false, code: 'E_NO_MEMORY_ROOT' };
  let current = {};
  try { current = readState(root); } catch { current = {}; }
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const count = (Number.isInteger(current.indexFailureCount) ? current.indexFailureCount : 0) + 1;
  const code = String(error?.code ?? error?.name ?? 'E_INDEX_REFRESH');
  const message = String(error?.message ?? error ?? code);
  recordIndexFreshness({
    memoryRoot: root,
    now,
    staleAfterMs,
    patch: {
      indexFreshness: 'error',
      indexLastError: `${code}: ${message}`.slice(0, 500),
      indexLastErrorAt: at,
      indexFailureCount: count,
      indexLastRefreshAt: at,
    },
  });
  return { ok: false, code, message, failureCount: count, at };
}

/**
 * Called after capture has written events/cards. The caller injects the INDEX
 * writer so tests can exercise failure/retry without a second dependency cycle.
 */
export function refreshIndexAfterCapture({
  memoryRoot = '',
  now = new Date(),
  indexer = null,
  staleAfterMs = INDEX_FRESHNESS_STALE_MS,
} = {}) {
  const root = path.resolve(String(memoryRoot ?? ''));
  if (root === '') return { ok: false, code: 'E_NO_MEMORY_ROOT' };
  const at = now instanceof Date ? now : new Date(now);
  if (typeof indexer !== 'function') {
    const failure = markIndexFailure({ memoryRoot: root, error: new Error('E_NO_INDEXER'), now: at, staleAfterMs });
    return { ok: false, ...failure };
  }
  try {
    const indexed = indexer({ apply: true, ifChanged: true }, { memoryRoot: root, now: at });
    const freshness = getIndexFreshness({ memoryRoot: root, now: at, staleAfterMs });
    recordIndexFreshness({
      memoryRoot: root,
      now: at,
      staleAfterMs,
      patch: {
        indexFreshness: freshness.status,
        indexLagMs: freshness.indexLagMs,
        indexDataAt: freshness.dataThroughAt,
        indexLastRefreshAt: at.toISOString(),
        indexLastError: null,
        ...(indexed?.indexBuiltAt ? { indexBuiltAt: indexed.indexBuiltAt } : {}),
      },
    });
    return { ok: true, indexed, freshness };
  } catch (error) {
    const failure = markIndexFailure({ memoryRoot: root, error, now: at, staleAfterMs });
    return { ok: false, error, failure };
  }
}

/** Resolve memoryRoot exactly like every other memory_* caller. */
export function resolveFreshnessRoot(config = {}) {
  return memoryRootFromConfig(config);
}
