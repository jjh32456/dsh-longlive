// src/metrics/prestep-latency.mjs — B3 时延责任归因（pre-step 编排器 observability）
//
// 目的：把「思考/回忆时间（t_question → t_evidence_ready）」拆成可归因的阶段：
//   boot（开机卡）/ shared（共享活动流）/ working（工作帧）/ recall（召回编排）/
//   inject（消息合并入 messages）/ budget（召回预算裁剪）
// 另记 degradations[]：gate 跳过 / embedding 回退 / 零命中 / 预算裁剪 / 异常 fail-open。
//
// 契约：**纯计时、零行为变化**。所有入口都吞异常并返回 no-op 计时器；metrics 未启用时
// 完全不写盘、不创建目录（registerMetrics 在入口调用 configurePrestepLatency）。
// 落盘：<memoryRoot>/.longlive/metrics/prestep.jsonl，每轮一行（sessionId+turn 幂等）。
// 面板/基准读取：readPrestepRows()；面板接线走 store.mjs#readPrestepSummary()。

import fs from 'node:fs';
import path from 'node:path';

export const PRESTEP_LATENCY_SCHEMA = 'prestep-latency/v1';
export const PRESTEP_SUMMARY_SCHEMA = 'prestep-summary/v1';
export const PRESTEP_FILE_NAME = 'prestep.jsonl';
export const PRESTEP_PHASES = Object.freeze(['boot', 'shared', 'working', 'recall', 'inject', 'budget', 'guard']);
export const PRESTEP_DEGRADES = Object.freeze([
  'gate-skip', 'embedding-fallback', 'zero-hit', 'budget-trim', 'error', 'factory-unavailable', 'frame-skip',
]);

const state = {
  enabled: false,
  memoryRoot: '',
  now: () => new Date(),
  pending: new Map(), // key -> entry
  finalized: new Map(), // key -> at (idempotency; bounded)
};
const MAX_ENTRIES = 2048;

function roundMs(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}
function nowMs() {
  if (typeof process.hrtime?.bigint === 'function') return process.hrtime.bigint();
  return BigInt(Date.now()) * 1_000_000n;
}
function elapsedMs(start) {
  if (start === null) return null;
  try {
    return Number(nowMs() - start) / 1e6;
  } catch {
    return null;
  }
}
function safeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : 'unknown';
}
function safeTurn(turn) {
  return Number.isFinite(Number(turn)) ? Number(turn) : null;
}
function turnKey(sessionId, turn) {
  return `${safeSessionId(sessionId)}:${safeTurn(turn) === null ? '?' : safeTurn(turn)}`;
}
function prestepFile(memoryRoot) {
  const root = typeof memoryRoot === 'string' && memoryRoot.trim() !== '' ? path.resolve(memoryRoot.trim()) : '';
  return root === '' ? '' : path.join(root, '.longlive', 'metrics', PRESTEP_FILE_NAME);
}
function trimMap(map) {
  while (map.size > MAX_ENTRIES) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

/**
 * Called once by metrics registration. `enabled:false` makes every helper a no-op
 * with zero disk IO; changing memoryRoot resets in-flight turn state.
 */
export function configurePrestepLatency(options = {}) {
  const memoryRoot = typeof options.memoryRoot === 'string' ? options.memoryRoot.trim() : '';
  if (memoryRoot !== state.memoryRoot) {
    state.pending.clear();
    state.finalized.clear();
  }
  state.enabled = options.enabled === true && memoryRoot !== '';
  state.memoryRoot = memoryRoot;
  state.now = typeof options.now === 'function' ? options.now : () => new Date();
  return { enabled: state.enabled, memoryRoot: state.memoryRoot };
}

export function prestepLatencyEnabled() {
  return state.enabled === true;
}

export function resetPrestepLatencyForTests() {
  state.pending.clear();
  state.finalized.clear();
  state.enabled = false;
  state.memoryRoot = '';
}

function getEntry(sessionId, turn) {
  const key = turnKey(sessionId, turn);
  let entry = state.pending.get(key);
  if (!entry) {
    entry = {
      key,
      sessionId: safeSessionId(sessionId),
      turn: safeTurn(turn),
      startedAt: state.now().toISOString(),
      phases: Object.fromEntries(PRESTEP_PHASES.map((name) => [name, null])),
      degrades: [],
      meta: {},
    };
    state.pending.set(key, entry);
    trimMap(state.pending);
  }
  return entry;
}

/** Open a phase timer; always safe to call. */
export function startPrestepPhase(sessionId, turn, phase) {
  if (!state.enabled || !PRESTEP_PHASES.includes(phase)) return { end() {} };
  let start = null;
  try {
    const entry = getEntry(sessionId, turn);
    start = nowMs();
    return {
      end(detail = null) {
        if (start === null) return;
        const ms = elapsedMs(start);
        start = null;
        if (!Number.isFinite(ms)) return;
        try {
          entry.phases[phase] = roundMs(ms);
          if (detail !== null && typeof detail === 'object') {
            for (const [name, value] of Object.entries(detail)) {
              if (name === 'degrades' && Array.isArray(value)) continue;
              entry.meta[name] = value;
            }
          }
        } catch { /* timing must never break a turn */ }
      },
    };
  } catch {
    return { end() {} };
  }
}

/** Record one degradation reason for this turn (unknown session/turn just creates the entry). */
export function notePrestepDegrade(sessionId, turn, input = {}) {
  if (!state.enabled) return false;
  try {
    const entry = getEntry(sessionId, turn);
    const kind = typeof input.kind === 'string' && input.kind !== '' ? input.kind : 'error';
    entry.degrades.push({
      kind,
      phase: typeof input.phase === 'string' && PRESTEP_PHASES.includes(input.phase) ? input.phase : null,
      detail: input.detail === undefined ? null : String(input.detail),
    });
    if (entry.degrades.length > 32) entry.degrades.splice(0, entry.degrades.length - 32);
    return true;
  } catch {
    return false;
  }
}

/** Merge metadata into this turn's row (e.g. budget tokens, injected paths). */
export function setPrestepMeta(sessionId, turn, meta = {}) {
  if (!state.enabled || meta === null || typeof meta !== 'object') return false;
  try {
    Object.assign(getEntry(sessionId, turn).meta, meta);
    return true;
  } catch {
    return false;
  }
}

function dominantOf(phases) {
  let name = null;
  let ms = -1;
  for (const key of PRESTEP_PHASES) {
    const value = phases[key];
    if (Number.isFinite(value) && value > ms) {
      name = key;
      ms = value;
    }
  }
  return { dominant: name, dominantMs: ms >= 0 ? roundMs(ms) : null };
}

/**
 * Write one row (idempotent per session:turn) and clear pending state.
 * Safe to call from any pre-step handler / metrics turn-end fallback.
 */
export function finalizePrestepTurn(sessionId, turn, options = {}) {
  if (!state.enabled) return null;
  const key = turnKey(sessionId, turn);
  if (state.finalized.has(key)) return null;
  let entry = state.pending.get(key);
  if (!entry) entry = getEntry(sessionId, turn);
  state.pending.delete(key);
  state.finalized.set(key, state.now().toISOString());
  trimMap(state.finalized);

  let ms = 0;
  let counted = 0;
  for (const name of PRESTEP_PHASES) {
    if (Number.isFinite(entry.phases[name])) {
      ms += entry.phases[name];
      counted += 1;
    }
  }
  const { dominant, dominantMs } = dominantOf(entry.phases);
  const row = {
    schema: PRESTEP_LATENCY_SCHEMA,
    at: state.now().toISOString(),
    sessionId: entry.sessionId,
    turn: entry.turn,
    phases: { ...entry.phases },
    dominant,
    dominantMs,
    ms: counted === 0 ? null : roundMs(ms),
    countedPhases: counted,
    degrades: entry.degrades,
    meta: entry.meta,
  };
  const file = prestepFile(typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== '' ? options.memoryRoot : state.memoryRoot);
  if (file === '') return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    return null;
  }
  return row;
}

/** Read raw rows, newest last. Corrupt lines skipped; never throws. */
export function readPrestepRows(options = {}) {
  const file = prestepFile(options.memoryRoot);
  if (file === '') return { ok: false, code: 'E_MEMORY_ROOT_UNSET', path: '', rows: [], total: 0, skipped: 0 };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, path: file, rows: [], total: 0, skipped: 0, exists: false };
    return { ok: false, code: 'E_PRESTEP_READ', path: file, rows: [], total: 0, skipped: 0, message: String(error?.message ?? error) };
  }
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object' && row.schema === PRESTEP_LATENCY_SCHEMA) rows.push(row);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
  const kept = limit > 0 ? rows.slice(-limit) : rows;
  return { ok: true, path: file, exists: true, rows: kept, total: rows.length, skipped };
}

function avg(values) {
  if (values.length === 0) return null;
  return roundMs(values.reduce((sum, value) => sum + value, 0) / values.length);
}
function p50(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return roundMs(sorted[Math.floor((sorted.length - 1) / 2)]);
}

/** Deterministic summary for the panel (#9 write-health `prestep` field) / benchmarks. */
export function summarizePrestepRows(rows = []) {
  const phases = {};
  for (const name of PRESTEP_PHASES) {
    const values = [];
    for (const row of rows) {
      const value = row?.phases?.[name];
      if (Number.isFinite(value)) values.push(value);
    }
    phases[name] = { count: values.length, avgMs: avg(values), p50Ms: p50(values), maxMs: values.length > 0 ? roundMs(Math.max(...values)) : null };
  }
  const dominantCounts = {};
  const degradeCounts = {};
  let lastAt = null;
  for (const row of rows) {
    if (typeof row.dominant === 'string' && row.dominant !== '') dominantCounts[row.dominant] = (dominantCounts[row.dominant] ?? 0) + 1;
    for (const item of Array.isArray(row.degrades) ? row.degrades : []) {
      if (typeof item?.kind === 'string') degradeCounts[item.kind] = (degradeCounts[item.kind] ?? 0) + 1;
    }
    if (typeof row.at === 'string' && (lastAt === null || row.at > lastAt)) lastAt = row.at;
  }
  return {
    schema: PRESTEP_SUMMARY_SCHEMA,
    count: rows.length,
    lastAt,
    phases,
    dominantCounts,
    degradeCounts,
  };
}
