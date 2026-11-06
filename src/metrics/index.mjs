/**
 * D1/D4 — live recorder.
 *
 * Registered from `src/index.js` after the opt-in features.  It listens on
 * `session/event`, and on every `turn/end` appends one row to
 * `<memoryRoot>/.longlive/metrics/turns.jsonl`.
 *
 * Hard rules:
 *   - measure only: no trimming, no rewriting, no errors leaking into a turn;
 *   - the final request is reconstructed at the last assistant usage event,
 *     using the same Surface fold as the rest of the plugin;
 *   - if the host gives no usage, the row still records estimates and
 *     `reconciliation.available=false`.
 */

import {
  measureTurn,
  normalizeMetricsConfig,
  clampFactor,
  DEFAULT_FACTOR,
} from './measure.mjs';
import {
  appendTurnRow,
  readCalibration,
  writeCalibration,
  readLastConclusion,
  ledgerPath,
} from './store.mjs';

/** The message events whose Surface fold is the request. */
export function snapshotSessionEvents(session) {
  if (session !== null && typeof session === 'object' && typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents();
      if (Array.isArray(events)) return events;
    } catch {
      return null;
    }
  }
  if (session !== null && typeof session === 'object' && Array.isArray(session.events)) {
    return session.events;
  }
  return null;
}

/** Last assistant message for `turn` carrying provider usage. */
export function findUsageEvent(events, turn) {
  let found = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'assistant/message') continue;
    if (!Number.isInteger(event.data?.turn) || event.data.turn !== turn) continue;
    if (event.data.usage === null || typeof event.data.usage !== 'object') continue;
    found = event;
  }
  return found;
}

/** Latest request header at or before `cutSeq`. */
export function findRequestHeader(events, cutSeq = Number.POSITIVE_INFINITY) {
  let header = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (!Number.isInteger(event?.seq) || event.seq >= cutSeq) continue;
    if (event.type === 'request/header' && event.data?.header !== null && typeof event.data.header === 'object') {
      header = event.data.header;
    }
  }
  return header;
}

function sessionIdOf(session, event) {
  if (session !== null && typeof session === 'object') {
    if (typeof session.id === 'string' && session.id !== '') return session.id;
    if (typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId;
  }
  if (typeof event?.data?.sessionId === 'string' && event.data.sessionId !== '') return event.data.sessionId;
  return '';
}

/**
 * Register the recorder.  Returns a small handle for tests.
 *
 * @param {object} ctx host context (needs `on`)
 * @param {object} config plugin config
 * @param {{memoryRoot?:string|null, now?:()=>Date, appendRow?:Function}} [deps]
 */
export function registerMetrics(ctx, config, deps = {}) {
  const cfg = normalizeMetricsConfig(config);
  const memoryRoot = typeof deps.memoryRoot === 'string' && deps.memoryRoot.trim() !== ''
    ? deps.memoryRoot
    : '';
  if (cfg.enabled !== true) return { enabled: false, reason: 'disabled' };
  if (memoryRoot === '') return { enabled: false, reason: 'memory-root-unset' };
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    return { enabled: false, reason: 'no-ctx' };
  }

  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const append = typeof deps.appendRow === 'function'
    ? deps.appendRow
    : (row) => appendTurnRow(row, { memoryRoot });
  const seen = new Set();

  const onSessionEvent = (session, event) => {
    try {
      if (event?.type !== 'turn/end') return;
      const turn = event.data?.turn;
      if (!Number.isInteger(turn) || turn < 0) return;
      const sessionId = sessionIdOf(session, event);
      const key = `${sessionId}:${turn}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 8192) seen.clear();

      const events = snapshotSessionEvents(session);
      if (!Array.isArray(events)) return;

      const usageEvent = findUsageEvent(events, turn);
      const cutSeq = usageEvent ? usageEvent.seq : Number.POSITIVE_INFINITY;
      const requestEvents = Number.isFinite(cutSeq)
        ? events.filter((item) => !Number.isInteger(item?.seq) || item.seq < cutSeq)
        : events;
      const explicitHeader = session !== null && typeof session === 'object' && typeof session.requestHeader === 'function'
        ? session.requestHeader()
        : null;
      const requestHeader = explicitHeader !== null && typeof explicitHeader === 'object'
        ? explicitHeader
        : findRequestHeader(events, cutSeq);

      const calibration = readCalibration(memoryRoot);
      const factor = clampFactor(calibration.factor ?? DEFAULT_FACTOR);
      const row = measureTurn({
        events: requestEvents,
        turn,
        sessionId,
        requestHeader,
        config: { ...cfg, keepTurns: cfg.keepTurns },
        actualUsage: usageEvent?.data?.usage ?? null,
        lastConclusion: readLastConclusion({ memoryRoot, sessionId }),
        factor,
        calibrationSamples: calibration.samples ?? 0,
        now: now(),
        source: 'live',
      });

      const written = append(row);
      if (written?.ok !== true) return;

      const actualInput = row?.reconciliation?.actualInput;
      const rawTotal = row?.raw?.total;
      if (Number.isFinite(actualInput) && actualInput > 0 && Number.isFinite(rawTotal) && rawTotal > 0) {
        const rawSum = (calibration.rawSum ?? 0) + rawTotal;
        const actualSum = (calibration.actualSum ?? 0) + actualInput;
        writeCalibration(memoryRoot, {
          factor: actualSum / rawSum,
          samples: (calibration.samples ?? 0) + 1,
          rawSum,
          actualSum,
          keepTurns: cfg.keepTurns,
          updatedAt: row.at,
        });
      }
    } catch {
      // Metrics must never break a turn.  A missing row is visible in the
      // ledger; a thrown error here is not.
    }
  };

  let dispose = null;
  try {
    const result = ctx.on('session/event', onSessionEvent);
    if (typeof result === 'function') dispose = result;
  } catch {
    return { enabled: false, reason: 'register-failed' };
  }

  return {
    enabled: true,
    memoryRoot,
    ledgerPath: ledgerPath(memoryRoot),
    config: cfg,
    onSessionEvent,
    dispose,
  };
}
