// WP2 · L1 heartbeat writer + read-side projection.
//
// Write side:
//   session/created -> create the row immediately (state=idle, startedAt once)
//   turn end        -> renew heartbeatAt, update turn/goal/state; create if missing
//   cap 128         -> count rows whose effectiveState is not stale/dead; refuse
//                      a NEW row at the cap, audit `live.row_rejected`, warn.
//
// The row schema and the atomic tmp+read-back+rename protocol are reused from
// `src/live.js` (rc11 compatible). `effectiveState` below is a deliberately
// documented equivalent of `live.js:447-470`: same conditions, DESIGN §2.1
// branch order, same results; there is no second threshold set.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { liveList, liveUpdate, normalizeSessionId, pidAlive } from '../../live.js';
import { isoOrNull, nowDate } from './paths.mjs';

export const LIVE_TTL_MS = 60000;
export const ACTIVE_STATES = Object.freeze(['idle', 'running', 'waiting', 'blocked']);
export const ACTIVE_STATE_SET = new Set(ACTIVE_STATES);
export const NON_ACTIVE_STATES = new Set(['stale', 'dead', 'corrupt']);

export function isActiveState(state) {
  return ACTIVE_STATE_SET.has(state);
}

/**
 * DESIGN §2.1 effectiveState (first match wins):
 *   age <= ttl            -> running          (same as live.js:449-451)
 *   alive === false       -> dead             (live.js:452-454)
 *   age > 4 * ttl         -> dead             (live.js:455-457)
 *   age > 2 * ttl         -> stale            (live.js:458-462)
 *   otherwise             -> record.state     (live.js:463-468)
 * `alive` is only ever false for a same-host pid that is definitively gone;
 * remote hosts pass null and age purely by time.
 */
export function effectiveState(record, options = {}) {
  if (!record || typeof record !== 'object') return 'corrupt';
  const ttl = Number(record.ttlMs) > 0 ? Number(record.ttlMs) : LIVE_TTL_MS;
  const nowMs = nowDate(options.now ?? Date.now()).getTime();
  const heartbeat = Date.parse(record.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return 'corrupt';
  const age = Math.max(0, nowMs - heartbeat);
  if (age <= ttl) return 'running';
  const hostname = options.hostname ?? safeHostname();
  const sameHost = typeof record.host === 'string' && record.host.toLowerCase() === hostname.toLowerCase();
  const alive = options.alive !== undefined
    ? options.alive
    : (sameHost ? pidAlive(record.pid) : null);
  if (alive === false) return 'dead';
  if (age > 4 * ttl) return 'dead';
  if (age > 2 * ttl) return 'stale';
  return typeof record.state === 'string' ? record.state : 'corrupt';
}

function safeHostname() {
  try { return os.hostname(); } catch { return 'localhost'; }
}

export function scanLiveRows({ memoryRoot, now } = {}) {
  try {
    const listed = liveList({ includeDead: true }, { memoryRoot, now });
    return {
      ok: true,
      dir: listed.dir,
      entries: Array.isArray(listed.entries) ? listed.entries : [],
      counts: listed.counts ?? {},
    };
  } catch (error) {
    return {
      ok: false,
      dir: null,
      entries: [],
      counts: {},
      error: { code: error?.code ?? 'LIVE_UNREADABLE', message: error?.message ?? String(error) },
    };
  }
}

export function activeRows(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => !NON_ACTIVE_STATES.has(entry?.effectiveState));
}

export function countActive(entries) {
  return activeRows(entries).length;
}

/** A row's declared state at turn end: waiting/blocked are user-facing promises and survive. */
export function stateForTurnEnd(priorState) {
  return priorState === 'waiting' || priorState === 'blocked' ? priorState : 'idle';
}

function sessionIdOf(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = value.sessionId
    ?? value.id
    ?? value.session?.header?.id
    ?? value.session?.id
    ?? value.header?.id;
  try {
    return normalizeSessionId(raw);
  } catch {
    return null;
  }
}

/**
 * Small L1 writer used by RouterService. It never throws: a heartbeat problem
 * must not break a turn (§2.1 失败降级).
 */
export function createLiveWriter(options = {}) {
  const memoryRoot = options.memoryRoot ?? null;
  const maxRows = Number.isInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : 128;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const audit = typeof options.audit === 'function' ? options.audit : () => {};
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : () => {};
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  let saturated = false;
  let lastReject = null;
  let lastWrite = null;

  function scan() {
    const result = scanLiveRows({ memoryRoot, now: now() });
    if (!result.ok) onWarning('LIVE_UNREADABLE');
    return result;
  }

  function write(args = {}) {
    const sessionId = sessionIdOf(args);
    if (!sessionId) return { ok: false, code: 'E_BAD_SESSION_ID' };
    const state = ACTIVE_STATE_SET.has(args.state) ? args.state : 'idle';
    const scanResult = scan();
    if (!scanResult.ok) return { ok: false, code: 'LIVE_UNREADABLE', sessionId };
    const own = scanResult.entries.find((entry) => entry.sessionId === sessionId && !entry.corrupt);
    const activeCount = countActive(scanResult.entries);

    if (!own && activeCount >= maxRows) {
      saturated = true;
      lastReject = { at: isoOrNull(now()), sessionId, activeCount, maxRows };
      try {
        audit('live.row_rejected', {
          session_id: sessionId,
          sessionId,
          reason: 'cap',
          active_count: activeCount,
          max_rows: maxRows,
          via: args.via ?? null,
        });
      } catch { /* audit failure must not break turn */ }
      onWarning('LIVE_ROWS_SATURATED');
      if (typeof args.onReject === 'function') args.onReject(lastReject);
      return { ok: false, code: 'LIVE_ROWS_SATURATED', sessionId, activeCount, maxRows };
    }

    const payload = {
      sessionId,
      state,
      ttlMs: LIVE_TTL_MS,
      last_action: args.lastAction ?? (
        args.reason === 'session/created'
          ? { kind: 'session', detail: 'session/created' }
          : { kind: 'turn', detail: `turn/end #${Number.isInteger(args.turn) ? args.turn : 0}` }
      ),
    };
    if (Number.isInteger(args.turn) && args.turn >= 0) payload.turn = args.turn;
    if (typeof args.goal === 'string' && args.goal.trim() !== '') payload.goal = args.goal;
    if (state === 'blocked' && typeof args.blocked_on === 'string') payload.blocked_on = args.blocked_on;

    try {
      const written = liveUpdate(payload, { memoryRoot, now: now() });
      saturated = false;
      lastWrite = {
        at: isoOrNull(now()),
        sessionId,
        created: written.created === true,
        effectiveState: written.effectiveState,
        via: args.via ?? null,
      };
      try {
        audit(written.created ? 'live.row.created' : 'live.row.renewed', {
          session_id: sessionId,
          sessionId,
          via: args.via ?? null,
          state,
          turn: payload.turn ?? null,
          effective_state: written.effectiveState,
        });
      } catch { /* ignore */ }
      return { ok: true, sessionId, created: written.created === true, effectiveState: written.effectiveState };
    } catch (error) {
      logger(`live row write failed for ${sessionId}: ${error?.code ?? error?.message ?? error}`);
      return { ok: false, code: error?.code ?? 'LIVE_WRITE_FAILED', sessionId };
    }
  }

  function renew(args = {}) {
    return write(args);
  }

  /**
   * Housekeeping only: delete same-host stale/dead rows, oldest heartbeat first,
   * and only while total rows exceed the cap. running/waiting/blocked/idle rows
   * and remote rows are never touched.
   */
  function evict({ limit = maxRows } = {}) {
    const scanResult = scan();
    if (!scanResult.ok) return { ok: false, evicted: 0, code: 'LIVE_UNREADABLE' };
    const entries = scanResult.entries;
    if (entries.length <= limit) return { ok: true, evicted: 0 };
    const candidates = entries
      .filter((entry) => (entry.effectiveState === 'stale' || entry.effectiveState === 'dead')
        && entry.sameHost === true && entry.file)
      .sort((a, b) => String(a.heartbeatAt ?? '').localeCompare(String(b.heartbeatAt ?? '')));
    let evicted = 0;
    for (const entry of candidates) {
      if (entries.length - evicted <= limit) break;
      try {
        fs.unlinkSync(entry.file);
        evicted += 1;
        try {
          audit('live.row.evicted', {
            session_id: entry.sessionId,
            sessionId: entry.sessionId,
            reason: entry.effectiveState,
            heartbeat_age_ms: entry.heartbeatAgeMs ?? null,
          });
        } catch { /* ignore */ }
      } catch (error) {
        logger(`live row evict failed for ${entry.sessionId}: ${error?.code ?? error?.message ?? error}`);
      }
    }
    return { ok: true, evicted };
  }

  return {
    write,
    renew,
    evict,
    scan,
    get maxRows() { return maxRows; },
    get saturated() { return saturated; },
    get lastReject() { return lastReject; },
    get lastWrite() { return lastWrite; },
  };
}

export { sessionIdOf, nowDate };
