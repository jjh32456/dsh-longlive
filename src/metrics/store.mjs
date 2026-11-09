/**
 * D4 — the turn ledger on disk.
 *
 * Layout:
 *   <memoryRoot>/.longlive/metrics/turns.jsonl   one JSON object per line
 *   <memoryRoot>/.longlive/metrics/state.json    cumulative calibration state
 *
 * Every write is best-effort and returns `{ok:false,code}` instead of throwing:
 * a metrics failure must never break a turn (D1: over-budget is a record, not
 * an error).
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonLine } from '../util/append-store.js';
import { summarizeRows, clampFactor, DEFAULT_FACTOR, DEFAULT_KEEP_TURNS } from './measure.mjs';
import { PRESTEP_FILE_NAME, readPrestepRows, summarizePrestepRows } from './prestep-latency.mjs';

export const METRICS_DIR_NAME = 'metrics';
export const TURNS_FILE_NAME = 'turns.jsonl';
export const STATE_FILE_NAME = 'state.json';
export const PRESTEP_FILE = PRESTEP_FILE_NAME;
export const LEDGER_VERSION = 1;

export function metricsDir(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot.trim() === '') return '';
  return path.join(path.resolve(memoryRoot), '.longlive', METRICS_DIR_NAME);
}

export function ledgerPath(memoryRoot) {
  const dir = metricsDir(memoryRoot);
  return dir === '' ? '' : path.join(dir, TURNS_FILE_NAME);
}

export function calibrationPath(memoryRoot) {
  const dir = metricsDir(memoryRoot);
  return dir === '' ? '' : path.join(dir, STATE_FILE_NAME);
}

export function prestepLedgerPath(memoryRoot) {
  const dir = metricsDir(memoryRoot);
  return dir === '' ? '' : path.join(dir, PRESTEP_FILE_NAME);
}

/**
 * B3: read the pre-step latency ledger (`.longlive/metrics/prestep.jsonl`).
 * Best-effort, never throws; corrupt lines are counted in `skipped`.
 */
export function readPrestepLedger(options = {}) {
  return readPrestepRows({ memoryRoot: options.memoryRoot, limit: options.limit });
}

/**
 * B3: deterministic pre-step latency summary for the panel.
 * Activity-writer A6 wiring: add `prestep: readPrestepSummary({ memoryRoot })` to the
 * #9 write-health reader response (see B3 handoff), no new route id needed.
 */
export function readPrestepSummary(options = {}) {
  const rows = readPrestepRows({ memoryRoot: options.memoryRoot, limit: options.limit }).rows;
  return summarizePrestepRows(rows);
}

/** Append one row.  Never throws. S1: 单写锁 + fsync + 坏行隔离（append-store）。 */
export function appendTurnRow(row, options = {}) {
  const memoryRoot = options.memoryRoot;
  const file = ledgerPath(memoryRoot);
  if (file === '') return { ok: false, code: 'E_MEMORY_ROOT_UNSET', path: '' };
  if (row === null || typeof row !== 'object') return { ok: false, code: 'E_INVALID_ROW', path: file };
  const written = appendJsonLine({
    file,
    row,
    label: 'metrics.turns',
    healthRoot: memoryRoot,
    now: options.now,
    quarantineDir: path.join(path.resolve(String(memoryRoot)), '.longlive', 'quarantine'),
  });
  if (!written.ok) {
    return { ok: false, code: written.code === 'E_APPEND_LOCKED' ? 'E_LEDGER_LOCKED' : 'E_LEDGER_WRITE', path: file, message: written.error?.message ?? written.code ?? 'append failed' };
  }
  return { ok: true, path: file, bytes: written.bytes };
}

function compareAt(a, b) {
  const left = typeof a === 'string' ? a : '';
  const right = typeof b === 'string' ? b : '';
  return left.localeCompare(right);
}

/**
 * Read the ledger.  Corrupt lines are counted and skipped, never fatal.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {string} [options.sessionId] exact match
 * @param {number} [options.limit] keep the newest N rows (0/undefined = all)
 * @param {string} [options.since] ISO lower bound (inclusive)
 * @param {string} [options.until] ISO upper bound (inclusive)
 * @returns {{ok:boolean,path:string,exists:boolean,rows:object[],total:number,skipped:number,bytes:number,code?:string}}
 */
export function readTurnLedger(options = {}) {
  const memoryRoot = options.memoryRoot;
  const file = ledgerPath(memoryRoot);
  if (file === '') {
    return { ok: false, code: 'E_MEMORY_ROOT_UNSET', path: '', exists: false, rows: [], total: 0, skipped: 0, bytes: 0 };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, path: file, exists: false, rows: [], total: 0, skipped: 0, bytes: 0 };
    }
    return { ok: false, code: 'E_LEDGER_READ', path: file, exists: false, rows: [], total: 0, skipped: 0, bytes: 0, message: String(error?.message ?? error) };
  }

  const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : '';
  const since = typeof options.since === 'string' ? options.since : '';
  const until = typeof options.until === 'string' ? options.until : '';
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;

  let skipped = 0;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      skipped += 1;
      continue;
    }
    if (sessionId !== '' && row.sessionId !== sessionId) continue;
    if (since !== '' && compareAt(row.at, since) < 0) continue;
    if (until !== '' && compareAt(row.at, until) > 0) continue;
    rows.push(row);
  }

  const total = rows.length;
  const kept = limit > 0 && rows.length > limit ? rows.slice(rows.length - limit) : rows;
  return {
    ok: true,
    path: file,
    exists: true,
    rows: kept,
    total,
    skipped,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

/** Compact rollup for router_status / the panel. */
export function readMetricsSummary(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 500;
  const ledger = readTurnLedger({ ...options, limit });
  if (ledger.ok !== true) {
    return {
      ok: false,
      code: ledger.code ?? 'E_LEDGER_READ',
      path: ledger.path ?? '',
      available: false,
      summary: summarizeRows([]),
    };
  }
  return {
    ok: true,
    path: ledger.path,
    exists: ledger.exists,
    available: ledger.rows.length > 0,
    skipped: ledger.skipped,
    summary: summarizeRows(ledger.rows),
  };
}

/**
 * Calibration state.  `factor` starts at 1.0 (documented /3.5 estimate) and
 * is the ratio of all observed actual input to all observed raw estimates:
 *   factor = clamp(0.5, 2, (actualSum + actual) / (rawSum + raw))
 * This is a cumulative ratio, not an EWMA: one sample already corrects the
 * systematic bias, and later samples only refine it.
 */
export function readCalibration(memoryRoot) {
  const file = calibrationPath(memoryRoot);
  const fallback = {
    v: LEDGER_VERSION,
    factor: DEFAULT_FACTOR,
    samples: 0,
    rawSum: 0,
    actualSum: 0,
    keepTurns: DEFAULT_KEEP_TURNS,
    updatedAt: null,
  };
  if (file === '') return { ok: false, code: 'E_MEMORY_ROOT_UNSET', path: '', exists: false, ...fallback };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') throw new Error('state is not an object');
    return {
      ok: true,
      path: file,
      exists: true,
      v: LEDGER_VERSION,
      factor: clampFactor(parsed.factor),
      samples: Number.isInteger(parsed.samples) && parsed.samples >= 0 ? parsed.samples : 0,
      rawSum: Number.isFinite(parsed.rawSum) && parsed.rawSum >= 0 ? parsed.rawSum : 0,
      actualSum: Number.isFinite(parsed.actualSum) && parsed.actualSum >= 0 ? parsed.actualSum : 0,
      keepTurns: Number.isInteger(parsed.keepTurns) && parsed.keepTurns > 0 ? parsed.keepTurns : DEFAULT_KEEP_TURNS,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, path: file, exists: false, ...fallback };
    return { ok: false, code: 'E_STATE_READ', path: file, exists: true, message: String(error?.message ?? error), ...fallback };
  }
}

/** Atomic state write (tmp -> rename), best-effort. */
export function writeCalibration(memoryRoot, state = {}) {
  const file = calibrationPath(memoryRoot);
  if (file === '') return { ok: false, code: 'E_MEMORY_ROOT_UNSET', path: '' };
  const payload = {
    v: LEDGER_VERSION,
    factor: clampFactor(state.factor),
    samples: Number.isInteger(state.samples) && state.samples >= 0 ? state.samples : 0,
    rawSum: Number.isFinite(state.rawSum) && state.rawSum >= 0 ? state.rawSum : 0,
    actualSum: Number.isFinite(state.actualSum) && state.actualSum >= 0 ? state.actualSum : 0,
    keepTurns: Number.isInteger(state.keepTurns) && state.keepTurns > 0 ? state.keepTurns : DEFAULT_KEEP_TURNS,
    updatedAt: typeof state.updatedAt === 'string' && state.updatedAt !== '' ? state.updatedAt : new Date().toISOString(),
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file, state: payload };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, code: 'E_STATE_WRITE', path: file, message: String(error?.message ?? error) };
  }
}

/**
 * Optional A2 compatibility: read `focus[].lastConclusion` from
 * `<memoryRoot>/.longlive/router/board.json`.  Today the field does not exist,
 * so this returns '' — a future board can start feeding the conclusion layer
 * without a schema change here.
 */
export function readLastConclusion({ memoryRoot, sessionId } = {}) {
  if (typeof memoryRoot !== 'string' || memoryRoot.trim() === '') return '';
  const file = path.join(path.resolve(memoryRoot), '.longlive', 'router', 'board.json');
  let board;
  try {
    board = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
  const focus = Array.isArray(board?.focus) ? board.focus : [];
  const row = (sessionId && focus.find((item) => item?.sessionId === sessionId))
    ?? focus.find((item) => typeof item?.lastConclusion === 'string' && item.lastConclusion.trim() !== '');
  return row !== null && typeof row?.lastConclusion === 'string' ? row.lastConclusion.trim() : '';
}
