/**
 * D1 — measure one turn's working set.
 *
 * The function is pure: it takes a session event slice and returns one ledger
 * row.  It never reads files, never trims and never throws on malformed input.
 * The caller (`src/metrics/index.mjs`) handles persistence and calibration.
 *
 * Layer rules (also documented in docs/METRICS.md):
 *   fixed       every live system/message + request tools JSON + host-injected
 *               user context + developer/message
 *   recent      real conversation whose turn is inside the keepTurns window
 *   recall      auto-recall injections (`【自动想起】`)
 *   conclusion  boot card (`【开机卡】`) and/or board lastConclusion
 *   carried     real conversation older than the window (still in the request
 *               because D2/D3 trimming is intentionally not implemented)
 */

import { foldSurface } from '../codec.js';
import {
  estimateMessageTokens,
  estimateToolsTokens,
  ESTIMATOR_ID,
} from './estimate.mjs';
import {
  classifyMessage,
  messageOfEvent,
  recallIdsFromMessage,
  dedupeIds,
} from './classify.mjs';

export const METRICS_VERSION = 1;

export const DEFAULT_TARGET_TOKENS = 40000;
export const DEFAULT_LAYER_TARGETS = Object.freeze({
  fixed: 25000,
  recent: 12000,
  recall: 2000,
  conclusion: 1000,
});
export const DEFAULT_KEEP_TURNS = 12;
export const DEFAULT_FACTOR = 1;
export const FACTOR_MIN = 0.5;
export const FACTOR_MAX = 2;

export const DEGRADE_ORDER = Object.freeze([
  Object.freeze({ step: 1, action: 'drop-tool-outputs', layer: 'recent', implemented: false, owner: 'D2' }),
  Object.freeze({ step: 2, action: 'drop-old-turns', layer: 'recent', implemented: false, owner: 'D3' }),
  Object.freeze({ step: 3, action: 'trim-recall', layer: 'recall', implemented: false, owner: 'D1-followup' }),
  Object.freeze({ step: 4, action: 'trim-conclusion', layer: 'conclusion', implemented: false, owner: 'A2-followup' }),
  Object.freeze({ step: 5, action: 'trim-tool-definitions', layer: 'fixed', implemented: false, owner: 'D6' }),
]);

const LAYER_KEYS = Object.freeze(['fixed', 'recent', 'recall', 'conclusion']);

function asInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function asNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampFactor(value) {
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, asNumber(value, DEFAULT_FACTOR)));
}

/**
 * Normalize the `metrics` block of the plugin config.
 * `metrics: false` disables the recorder; `metrics.enabled === false` does too.
 */
export function normalizeMetricsConfig(input) {
  const raw = input === false
    ? { enabled: false }
    : input !== null && typeof input === 'object' && input.metrics !== undefined
      ? input.metrics
      : input;
  const source = raw === false || raw === null || typeof raw !== 'object' ? {} : raw;
  const enabled = raw !== false && source.enabled !== false;
  const targetTokens = asInteger(source.targetTokens, DEFAULT_TARGET_TOKENS) || DEFAULT_TARGET_TOKENS;
  const keepTurns = asInteger(source.keepTurns, DEFAULT_KEEP_TURNS) || DEFAULT_KEEP_TURNS;
  const initialFactor = clampFactor(source.initialFactor ?? DEFAULT_FACTOR);

  let layerTargets;
  if (source.layerTargets !== null && typeof source.layerTargets === 'object') {
    layerTargets = {};
    for (const key of LAYER_KEYS) {
      layerTargets[key] = asInteger(source.layerTargets[key], 0);
    }
  } else {
    // If only targetTokens was changed, keep the documented 62.5/30/5/2.5 %
    // split.  If it is the default, use the exact published numbers.
    const ratio = targetTokens / DEFAULT_TARGET_TOKENS;
    layerTargets = {};
    for (const key of LAYER_KEYS) {
      layerTargets[key] = Math.round(DEFAULT_LAYER_TARGETS[key] * ratio);
    }
  }

  return {
    enabled,
    targetTokens,
    keepTurns,
    layerTargets,
    initialFactor,
  };
}

/** Distribute `total` over `parts` with largest remainders; keeps sum exact. */
export function scaleToTotal(parts, total) {
  const keys = Object.keys(parts === null || typeof parts !== 'object' ? {} : parts);
  const out = {};
  for (const key of keys) out[key] = 0;
  if (keys.length === 0 || !Number.isFinite(total) || total <= 0) return out;
  const sum = keys.reduce((acc, key) => acc + Math.max(0, asNumber(parts[key], 0)), 0);
  if (sum <= 0) return out;

  const exact = keys.map((key) => (Math.max(0, asNumber(parts[key], 0)) * total) / sum);
  const floors = exact.map((value) => Math.floor(value));
  let allotted = floors.reduce((acc, value) => acc + value, 0);
  const order = keys
    .map((key, index) => ({ index, fraction: exact[index] - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  let cursor = 0;
  while (allotted < total && order.length > 0) {
    floors[order[cursor % order.length].index] += 1;
    allotted += 1;
    cursor += 1;
  }
  for (let index = 0; index < keys.length; index += 1) out[keys[index]] = floors[index];
  return out;
}

/** Build seq -> turn, filling in message events that omit `data.turn`. */
export function buildTurnMap(events) {
  const map = new Map();
  let current = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue;
    if (Number.isInteger(event.data?.turn)) current = event.data.turn;
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) current = event.data.turn;
    if (Number.isInteger(event.seq)) map.set(event.seq, current);
  }
  return map;
}

function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const inputTokens = asInteger(usage.inputTokens, 0);
  const outputTokens = asInteger(usage.outputTokens, 0);
  const cacheReadTokens = asInteger(usage.cacheReadTokens, 0);
  const cacheWriteTokens = asInteger(usage.cacheWriteTokens, 0);
  const totalTokens = asInteger(usage.totalTokens, inputTokens + outputTokens + cacheReadTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    requestInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

function findRequestHeader(events, explicit) {
  if (explicit !== null && typeof explicit === 'object') return explicit;
  let header = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'request/header' && event.data?.header !== null && typeof event.data.header === 'object') {
      header = event.data.header;
    }
  }
  return header;
}

function budgetFor(layers, carried, config) {
  const target = config.targetTokens;
  const layerTargets = config.layerTargets;
  const layersOver = {};
  for (const key of LAYER_KEYS) {
    layersOver[key] = layers[key] > layerTargets[key];
  }
  const over = layers[LAYER_KEYS[0]] + layers[LAYER_KEYS[1]] + layers[LAYER_KEYS[2]] + layers[LAYER_KEYS[3]] + carried > target;
  return {
    target,
    layers: { ...layerTargets },
    over,
    overBy: Math.max(0, layers[LAYER_KEYS[0]] + layers[LAYER_KEYS[1]] + layers[LAYER_KEYS[2]] + layers[LAYER_KEYS[3]] + carried - target),
    layersOver,
    order: DEGRADE_ORDER.map((entry) => entry.action),
    triggered: over,
    applied: [],
    note: 'measure-only: D2/D3 trimming is not implemented; this row records the overage, it never cuts content.',
  };
}

/**
 * Measure one turn.
 *
 * @param {object} input
 * @param {object[]} input.events      session events, already cut at the final
 *                                     assistant usage event (exclusive)
 * @param {number} input.turn
 * @param {string} input.sessionId
 * @param {object|null} [input.requestHeader] canonical header ({config,tools})
 * @param {object} [input.config]      normalized or raw metrics config
 * @param {object|null} [input.actualUsage]
 * @param {string} [input.lastConclusion]
 * @param {string} [input.source]      'live' | 'sample'
 * @param {number} [input.factor]      calibration factor used for this row
 * @param {number} [input.calibrationSamples]
 * @param {string|Date} [input.now]
 * @returns {object} ledger row; never throws for malformed message content
 */
export function measureTurn(input = {}) {
  const events = Array.isArray(input.events) ? input.events.filter((event) => event !== null && typeof event === 'object') : [];
  const config = normalizeMetricsConfig(input.config ?? {});
  const turn = asInteger(input.turn, 0);
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  const factor = clampFactor(input.factor ?? DEFAULT_FACTOR);
  const calibrationSamples = asInteger(input.calibrationSamples, 0);
  const source = input.source === 'sample' ? 'sample' : 'live';
  const now = input.now instanceof Date
    ? input.now.toISOString()
    : typeof input.now === 'string' && input.now !== ''
      ? input.now
      : new Date().toISOString();

  const turnMap = buildTurnMap(events);
  const nodes = foldSurface(events);
  const header = findRequestHeader(events, input.requestHeader);

  let systemTokens = 0;
  let injectedTokens = 0;
  let developerTokens = 0;
  let recentTokens = 0;
  let recallTokens = 0;
  let conclusionTokens = 0;
  let carriedTokens = 0;
  let recallMessages = 0;
  let conclusionMessages = 0;
  let recentMessages = 0;
  let carriedMessages = 0;
  const recallIds = [];

  for (const node of nodes) {
    const message = messageOfEvent(node.event);
    if (message === null) continue;
    const tokens = estimateMessageTokens(message);
    const kind = classifyMessage(message);
    const role = typeof message.role === 'string' ? message.role : '';
    const messageTurn = Number.isInteger(node.event?.data?.turn)
      ? node.event.data.turn
      : (turnMap.get(node.seq) ?? 0);

    if (kind === 'fixed') {
      if (role === 'system') systemTokens += tokens;
      else if (role === 'developer') developerTokens += tokens;
      else injectedTokens += tokens;
      continue;
    }
    if (kind === 'recall') {
      recallTokens += tokens;
      recallMessages += 1;
      for (const id of recallIdsFromMessage(message)) recallIds.push(id);
      continue;
    }
    if (kind === 'conclusion') {
      conclusionTokens += tokens;
      conclusionMessages += 1;
      continue;
    }
    if (kind === 'conversation') {
      const inside = messageTurn > 0 && messageTurn <= turn && messageTurn > turn - config.keepTurns;
      if (inside) {
        recentTokens += tokens;
        recentMessages += 1;
      } else {
        carriedTokens += tokens;
        carriedMessages += 1;
      }
      continue;
    }
    // Unknown roles still occupy the request; account for them honestly.
    carriedTokens += tokens;
    carriedMessages += 1;
  }

  const toolsTokens = estimateToolsTokens(header?.tools);
  let fixedRaw = systemTokens + toolsTokens + injectedTokens + developerTokens;

  // A board conclusion is only counted when no boot-card message already
  // carries it, otherwise the same text would be counted twice.
  let lastConclusionTokens = 0;
  if (conclusionMessages === 0 && typeof input.lastConclusion === 'string' && input.lastConclusion.trim() !== '') {
    lastConclusionTokens = estimateMessageTokens({ role: 'user', content: input.lastConclusion });
    conclusionTokens += lastConclusionTokens;
  }

  const rawParts = {
    fixed: fixedRaw,
    recent: recentTokens,
    recall: recallTokens,
    conclusion: conclusionTokens,
    carried: carriedTokens,
  };
  const rawTotal = rawParts.fixed + rawParts.recent + rawParts.recall + rawParts.conclusion + rawParts.carried;
  const total = rawTotal > 0 ? Math.round(rawTotal * factor) : 0;
  const scaled = scaleToTotal(rawParts, total);

  const layers = {
    fixed: scaled.fixed ?? 0,
    recent: scaled.recent ?? 0,
    recall: scaled.recall ?? 0,
    conclusion: scaled.conclusion ?? 0,
  };
  const carried = scaled.carried ?? 0;
  const ids = dedupeIds(recallIds);

  const actual = normalizeUsage(input.actualUsage);
  const reconciliation = actual !== null && actual.requestInputTokens > 0
    ? {
      available: true,
      rawEstimate: rawTotal,
      actualInput: actual.requestInputTokens,
      delta: total - actual.requestInputTokens,
      deltaPct: Number((((total - actual.requestInputTokens) / actual.requestInputTokens) * 100).toFixed(2)),
      within5pct: Math.abs((total - actual.requestInputTokens) / actual.requestInputTokens) <= 0.05,
      method: 'layered estimate * calibration factor vs provider usage (input + cacheRead + cacheWrite)',
    }
    : {
      available: false,
      rawEstimate: rawTotal,
      actualInput: null,
      delta: null,
      deltaPct: null,
      within5pct: null,
      method: 'no provider usage on the final assistant message',
    };

  const cacheHitRate = actual !== null && actual.inputTokens + actual.cacheReadTokens > 0
    ? Number((actual.cacheReadTokens / (actual.inputTokens + actual.cacheReadTokens)).toFixed(4))
    : null;

  return {
    v: METRICS_VERSION,
    at: now,
    sessionId,
    turn,
    layers,
    total,
    recallCount: ids.length,
    recallIds: ids.map((id) => id.path || id.title),
    carried,
    components: {
      system: systemTokens,
      tools: toolsTokens,
      injected: injectedTokens,
      developer: developerTokens,
      lastConclusion: lastConclusionTokens,
      recentTurns: countTurns(nodes, turnMap, turn, config.keepTurns),
    },
    counts: {
      recallMessages,
      conclusionMessages,
      recentMessages,
      carriedMessages,
    },
    raw: {
      layers: { ...rawParts },
      total: rawTotal,
      estimator: ESTIMATOR_ID,
      factor,
    },
    actual,
    reconciliation,
    calibration: {
      factor,
      samples: calibrationSamples,
    },
    cacheHitRate,
    budget: budgetFor(layers, carried, config),
    tokenSource: calibrationSamples > 0 || factor !== DEFAULT_FACTOR ? 'estimate-calibrated' : 'estimate-cold',
    source,
  };
}

function countTurns(nodes, turnMap, turn, keepTurns) {
  const seen = new Set();
  for (const node of nodes) {
    const message = messageOfEvent(node.event);
    if (message === null || classifyMessage(message) !== 'conversation') continue;
    const messageTurn = Number.isInteger(node.event?.data?.turn)
      ? node.event.data.turn
      : (turnMap.get(node.seq) ?? 0);
    if (messageTurn > 0 && messageTurn <= turn && messageTurn > turn - keepTurns) seen.add(messageTurn);
  }
  return seen.size;
}

/** Median of a numeric array; empty -> 0. */
export function median(values) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

function percentile(values, p) {
  const list = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (list.length === 0) return 0;
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[index];
}

/** Compact rollup used by router_status and the panel. */
export function summarizeRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && typeof row === 'object');
  const totals = list.map((row) => asNumber(row.total, 0));
  const actuals = list
    .map((row) => asNumber(row.reconciliation?.actualInput, 0))
    .filter((value) => value > 0);
  const errors = list
    .map((row) => row.reconciliation?.deltaPct)
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.abs(value));
  const sessions = new Set(list.map((row) => row.sessionId).filter((value) => typeof value === 'string' && value !== ''));
  const layerMedians = {};
  for (const key of LAYER_KEYS) {
    layerMedians[key] = median(list.map((row) => row.layers?.[key]));
  }
  const cacheRates = list.map((row) => row.cacheHitRate).filter((value) => Number.isFinite(value));
  return {
    turns: list.length,
    sessions: sessions.size,
    firstAt: list.length > 0 ? list[0].at ?? null : null,
    lastAt: list.length > 0 ? list[list.length - 1].at ?? null : null,
    medianTotal: median(totals),
    avgTotal: totals.length > 0 ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
    p95Total: percentile(totals, 95),
    maxTotal: totals.length > 0 ? Math.max(...totals) : 0,
    layerMedians,
    actualCoverage: list.length > 0 ? Math.round((actuals.length / list.length) * 1000) / 1000 : 0,
    medianActual: median(actuals),
    medianAbsErrorPct: errors.length > 0 ? Number(median(errors).toFixed(2)) : null,
    within5Turns: list.filter((row) => row.reconciliation?.within5pct === true).length,
    overBudgetTurns: list.filter((row) => row.budget?.triggered === true).length,
    medianCacheHitRate: cacheRates.length > 0 ? Number(median(cacheRates).toFixed(4)) : null,
    last: list.length > 0 ? {
      at: list[list.length - 1].at ?? null,
      turn: list[list.length - 1].turn ?? null,
      total: asNumber(list[list.length - 1].total, 0),
      recallCount: asNumber(list[list.length - 1].recallCount, 0),
    } : null,
  };
}
