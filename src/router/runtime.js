// R1 runtime adapter: judge memory-tool calls with the pure router and record
// the decision, without changing what the tool actually does.
//
//   routerRuntime: 'off'    -> not even imported into the hot path (no judgement)
//   routerRuntime: 'shadow' -> judge + append one JSONL record, behaviour identical
//   routerRuntime: 'on'     -> additionally refuse high-risk WRITE calls
//
// Design notes (see DESIGN.md):
//   * Shadow mode must be observationally invisible: same return value, same
//     thrown error object, no added latency beyond one route() + one append.
//   * On mode is deliberately narrow: reads (memory_recall) are never refused,
//     and a dry-run memory_forget (no confirm:"FORGET") is not a delete.
//   * Any failure here is contained: a broken router can never crash a tool. In
//     shadow a failed judgement is recorded and the call proceeds unchanged; in
//     on a failed judgement refuses write calls (fail-closed) but not reads.
//
// This module has no host dependency at all: it is imported by tools.js and by
// plain `node --test` suites, so everything is injected through options.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { route, ruleById } from './route.js';

// Longlive Router 1.1.0 service seam. Product code (src/index.js) imports the
// Router only through this module, which keeps the R1 topology test's single
// seam (`src/index.js -> src/router/runtime.js`) intact.
export { createRouterService } from './service/service.mjs';
export { normalizeRouterConfig } from './service/config.mjs';
export { createRouterTools } from './service/tools.mjs';

export const RUNTIME_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_RUNTIME_MODE = 'off';
export const STATE_FILE_NAME = 'router-runtime.jsonl';
export const MAX_RECORDS_DEFAULT = 1000;
export const ROUTE_REFUSED_CODE = 'E_ROUTE_REFUSED';

// Tools whose arguments R1 knows how to judge. `memory_save` is owned by the
// engram side, not by this plugin, so it is reachable only through the host
// guard (see `guard()` and DESIGN.md §3 C).
export const INTERCEPTED_TOOLS = Object.freeze([
  'memory_save',
  'memory_recall',
  'memory_consolidate',
  'memory_forget',
]);

// Only these can mutate the store; `memory_recall` is read-only and must never
// be refused, not even when the rule table is unreadable.
export const WRITE_TOOLS = Object.freeze(['memory_save', 'memory_consolidate', 'memory_forget']);

/**
 * Coerce a config value into a known mode. Anything unrecognised falls back to
 * `off` (never to `on`): a typo in the profile must not start refusing calls.
 */
export function normalizeMode(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_RUNTIME_MODE;
  const mode = String(value).trim().toLowerCase();
  return RUNTIME_MODES.includes(mode) ? mode : DEFAULT_RUNTIME_MODE;
}

/**
 * Where the rolling record lives: explicit path wins, else
 * `<memoryRoot>/.longlive/router-runtime.jsonl`.
 *
 * 1.2.0 moved the default under `.longlive/` so every passive audit artifact
 * (filter decisions, guard records, live rows) shares one hidden root. The
 * panel reads both the old top-level file and this one, so an upgraded host
 * with an old file keeps working; new records always go to `.longlive/`.
 */
export function resolveStatePath(options = {}) {
  if (typeof options.statePath === 'string' && options.statePath.trim()) return resolve(options.statePath);
  const root = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() ? options.memoryRoot : null;
  return root ? resolve(join(root, '.longlive', STATE_FILE_NAME)) : null;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function defaultNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

const FLAG_KEYS = new Set(['confirm', 'apply', 'action', 'name', 'slug', 'room', 'status', 'since', 'topK', 'dryRun']);

/**
 * Flatten the arguments into the single lowercase string `route()` reads. R1
 * matches keywords (substring) over `text`, and none of the memory rules has a
 * `match.tool` entry, so both the tool name and the values must be present.
 */
export function buildJudgeText(tool, args) {
  const parts = [String(tool || '')];
  const seen = new Set();
  const push = (value, limit) => {
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    parts.push(text.slice(0, limit));
  };
  const walk = (value, key, depth) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      // Flag values are recorded as `k=v` so a reader can tell "confirm=FORGET"
      // from a stray word; the router only does substring matching either way.
      if (FLAG_KEYS.has(key)) push(`${key}=${value}`, 160);
      else push(value, 200);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      if (FLAG_KEYS.has(key)) push(`${key}=${value}`, 80);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 12)) walk(item, key, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value).slice(0, 24)) walk(childValue, childKey, depth + 1);
    }
  };
  walk(args, '', 0);
  return parts.join(' ').toLowerCase().slice(0, 2000);
}

/** Keep the recorded arguments small and JSON-safe; never throw on odd shapes. */
export function summarizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { value: String(args ?? null).slice(0, 120) };
  const out = {};
  for (const [key, value] of Object.entries(args).slice(0, 12)) {
    if (typeof value === 'string') out[key] = value.length > 160 ? `${value.slice(0, 160)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = `[${value.length}]`;
    else out[key] = '<object>';
  }
  return out;
}

/**
 * Which rule's action is the *deciding* one. `decisions[]` also carries the
 * rule's `before` steps (e.g. R-MEM-DISTILL starts with `engram.search`), so
 * `decisions[0]` is not the verdict; the rule table is the source of truth.
 */
function primaryAction(result) {
  const ruleId = result && typeof result.matchedRule === 'string' ? result.matchedRule : null;
  if (ruleId) {
    const rule = ruleById(ruleId);
    if (rule && rule.decision && typeof rule.decision.action === 'string') return rule.decision.action;
  }
  const decisions = Array.isArray(result?.decisions) ? result.decisions : [];
  const wanted = result?.decision?.tool ?? null;
  const hit = decisions.find((entry) => entry && entry.ruleId === ruleId && (entry.tool ?? null) === wanted);
  if (hit && typeof hit.action === 'string') return hit.action;
  const fallback = decisions.find((entry) => entry && entry.ruleId === ruleId);
  return fallback && typeof fallback.action === 'string' ? fallback.action : null;
}

/**
 * High-risk classification for `on` mode. Only three families may be refused:
 * deleting store content, changing identity, writing the real store.
 */
export function classifyRisk({ tool, args, matchedRule, action, failClosed = false }) {
  const reasons = [];
  if (failClosed) reasons.push('fail-closed');
  if (matchedRule === 'R-GUARD-REAL' || action === 'guard.refuse') reasons.push('real-store');
  if (
    matchedRule === 'R-ID-CONSENT' ||
    action === 'engram.profile.edit' ||
    (typeof action === 'string' && action.startsWith('identity.'))
  ) {
    reasons.push('identity');
  }
  // A memory_forget without confirm:"FORGET" only previews; it deletes nothing.
  const confirm = args && typeof args === 'object' ? args.confirm : undefined;
  const forgetDryRun = tool === 'memory_forget' && confirm !== 'FORGET';
  if (!forgetDryRun) {
    if (tool === 'memory_forget') reasons.push('delete');
    else if (matchedRule === 'R-MEM-DISTILL') reasons.push('delete');
    else if (typeof action === 'string' && (action === 'memory.delete' || action === 'engram.forget')) reasons.push('delete');
  }
  const level = reasons.includes('real-store')
    ? 'real-store'
    : reasons.includes('identity')
      ? 'identity'
      : reasons.includes('delete')
        ? 'delete'
        : reasons.includes('fail-closed')
          ? 'fail-closed'
          : 'none';
  return { level, reasons };
}

/**
 * The panel contract (§6) exposes `action` as allow|deny|ask, while the R1
 * decision action is a semantic verb (`memory.distillPropose`, ...). Keep the
 * verb in `decision.action` and put the contract value at the top level.
 */
function contractAction(described, guardVerdict) {
  if (guardVerdict === 'deny' || described.action === 'guard.refuse') return 'deny';
  if (described.needsHuman) return 'ask';
  return 'allow';
}

function contractFields(tool, described, guardVerdict, callText, outcome) {
  return {
    subject: tool,
    action: contractAction(described, guardVerdict),
    level: described.level,
    matchedRule: described.ruleId,
    confidence: described.confidence,
    needsHuman: described.needsHuman,
    callText,
    status: outcome.status,
    errors: described.errors,
  };
}

function refusalMessage({ tool, ruleId, level, needsHuman, reasons = [] }) {  const reason = reasons.length ? reasons.join('+') : 'high-risk';
  return (
    `${ROUTE_REFUSED_CODE}: ${tool} refused by the R1 router ` +
    `(risk=${reason}, rule=${ruleId ?? 'none'}, level=${level ?? 'null'}, needsHuman=${needsHuman === true}). ` +
    'The underlying tool was not called. Set routerRuntime to "shadow" to record without enforcing.'
  );
}

function routeRefusedError(details) {
  const error = new Error(refusalMessage(details));
  error.code = ROUTE_REFUSED_CODE;
  error.details = details;
  return error;
}

/**
 * One JSONL sink with a hard line cap. Rotation keeps the newest `maxRecords`
 * lines and replaces the file atomically (tmp + rename), so a crash never
 * leaves a half-written record set.
 */
function createRecordStore({ statePath, maxRecords, onError }) {
  let count = null;
  let appendsSinceCheck = 0;

  function countLines() {
    try {
      const text = readFileSync(statePath, 'utf8');
      return text ? text.split('\n').filter(Boolean).length : 0;
    } catch (error) {
      if (error && error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  function rotationCheck() {
    appendsSinceCheck += 1;
    if (appendsSinceCheck < 64) return;
    appendsSinceCheck = 0;
    try {
      // Bounds growth if another writer appended behind our back.
      if (statSync(statePath).size > maxRecords * 4096) count = countLines();
    } catch {
      /* size probe is best effort */
    }
  }

  function rotate() {
    const lines = readFileSync(statePath, 'utf8').split('\n').filter(Boolean);
    const kept = lines.slice(-maxRecords);
    const tmp = `${statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
    renameSync(tmp, statePath);
    count = kept.length;
  }

  function append(record) {
    if (!statePath) return false;
    try {
      if (count === null) count = countLines();
      mkdirSync(dirname(statePath), { recursive: true });
      appendFileSync(statePath, `${JSON.stringify(record)}\n`, 'utf8');
      count += 1;
      if (count > maxRecords) rotate();
      rotationCheck();
      return true;
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        /* reporting a broken sink must not break the tool */
      }
      return false;
    }
  }

  return {
    append,
    get path() {
      return statePath;
    },
    get lineCount() {
      return count;
    },
  };
}

/**
 * Build the runtime adapter.
 *
 * @param {object} options
 * @param {'off'|'shadow'|'on'} [options.mode='off']
 * @param {string} [options.statePath]  explicit JSONL path
 * @param {string} [options.memoryRoot] used when `statePath` is absent
 * @param {number} [options.maxRecords=1000]
 * @param {string[]} [options.ownTools]  names registered by this plugin (guard skips them)
 * @param {boolean} [options.recordAllTools=false] shadow mode: also judge tools
 *        outside INTERCEPTED_TOOLS (still record-only — never refuse)
 * @param {(error: Error) => void} [options.onError] record-sink failure reporter
 * @param {Function} [options.routeImpl] test seam, defaults to the real router
 * @param {Function} [options.now]       test seam, monotonic milliseconds
 */
export function createRouterRuntime(options = {}) {
  const requested = options.mode;
  const mode = normalizeMode(requested);
  const modeInvalid =
    requested !== undefined && requested !== null && requested !== '' && String(requested).trim().toLowerCase() !== mode;
  const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0 ? options.maxRecords : MAX_RECORDS_DEFAULT;
  const statePath = resolveStatePath(options);
  const ownTools = new Set(Array.isArray(options.ownTools) ? options.ownTools.filter((name) => typeof name === 'string') : []);
  const routeImpl = typeof options.routeImpl === 'function' ? options.routeImpl : route;
  const now = typeof options.now === 'function' ? options.now : defaultNow;
  const onError = options.onError;
  const recordAllTools = options.recordAllTools === true;

  const store = createRecordStore({ statePath, maxRecords, onError });
  const stats = { judged: 0, recorded: 0, denied: 0, errors: 0, lastLatencyMs: null };

  const enabled = mode !== 'off';

  function judge(tool, args) {
    const started = now();
    try {
      const result = routeImpl({ kind: 'memory', text: buildJudgeText(tool, args), candidates: [tool], ctx: {} });
      return { ok: true, result, latencyMs: round3(now() - started) };
    } catch (error) {
      return { ok: false, error, latencyMs: round3(now() - started) };
    }
  }

  function write(record) {
    const ok = store.append(record);
    if (ok) stats.recorded += 1;
    return ok;
  }

  function baseRecord(tool, args, judged) {
    const result = judged.ok ? judged.result : null;
    const ruleId = result && typeof result.matchedRule === 'string' ? result.matchedRule : null;
    const failClosed = judged.ok ? result?.failClosed === true : true;
    const action = judged.ok ? primaryAction(result) : 'guard.refuse';
    const risk = classifyRisk({ tool, args, matchedRule: failClosed ? 'R-ROUTER-FAILCLOSED' : ruleId, action, failClosed });
    return {
      ruleId: failClosed ? 'R-ROUTER-FAILCLOSED' : ruleId,
      action: judged.ok ? action : 'guard.refuse',
      level: judged.ok ? (result?.level ?? null) : null,
      needsHuman: judged.ok ? result?.needsHuman === true : true,
      confidence: judged.ok ? (typeof result?.confidence === 'number' ? result.confidence : 0) : 0,
      failClosed,
      errors: judged.ok && Array.isArray(result?.errors) ? result.errors.map((e) => (e && e.code) || String(e)) : judged.ok ? [] : ['E_ROUTE_EXCEPTION'],
      target: judged.ok ? (result?.target ?? null) : null,
      decisionTool: judged.ok ? (result?.decision?.tool ?? null) : null,
      risk,
    };
  }

  function shouldDeny(tool, described) {
    if (mode !== 'on') return false;
    if (!WRITE_TOOLS.includes(tool)) return false;
    if (described.failClosed) return true;
    return described.risk.level !== 'none';
  }

  /**
   * Wrap one tool invocation. Returns whatever the tool returns when the mode
   * is off or the tool is not intercepted — synchronously, so `off` is a true
   * no-op. In shadow/on it resolves to the tool's value or rejects with the
   * tool's original error.
   */
  function intercept(tool, args, run) {
    if (!enabled) return run();
    // Shadow mode is the passive observer: with recordAllTools it also sees
    // the plugin's own session/memory surface. `on` keeps the narrow R1 scope
    // so enabling enforcement cannot start refusing unrelated tools.
    const inScope = INTERCEPTED_TOOLS.includes(tool) || (mode === 'shadow' && recordAllTools);
    if (!inScope) return run();
    const startedAt = now();
    const judged = judge(tool, args);
    const described = baseRecord(tool, args, judged);
    const deny = shouldDeny(tool, described);
    const ts = new Date().toISOString();
    const callText = buildJudgeText(tool, args);
    stats.judged += 1;
    stats.lastLatencyMs = judged.latencyMs;

    if (deny) {
      stats.denied += 1;
      const details = {
        tool,
        ruleId: described.ruleId,
        level: described.level,
        needsHuman: described.needsHuman,
        risk: described.risk.level,
        reasons: described.risk.reasons,
        latencyMs: judged.latencyMs,
      };
      write({
        ts,
        mode,
        tool,
        ...contractFields(tool, described, 'deny', buildJudgeText(tool, args), { status: 'denied' }),
        call: { text: buildJudgeText(tool, args), args: summarizeArgs(args) },
        decision: {
          matchedRule: described.ruleId,
          ruleId: described.ruleId,
          action: described.action,
          level: described.level,
          target: described.target,
          tool: described.decisionTool,
          needsHuman: described.needsHuman,
          confidence: described.confidence,
          failClosed: described.failClosed,
          errors: described.errors,
        },
        risk: described.risk,
        guard: { verdict: 'deny', reason: refusalMessage(details) },
        outcome: { status: 'denied', ms: 0 },
        latencyMs: judged.latencyMs,
        totalMs: round3(now() - startedAt),
      });
      return Promise.reject(routeRefusedError(details));
    }

    return (async () => {
      let result;
      let failure = null;
      try {
        result = await run();
      } catch (error) {
        failure = error;
      }
      const totalMs = round3(now() - startedAt);
      write({
        ts,
        mode,
        tool,
        ...contractFields(tool, described, 'allow', buildJudgeText(tool, args), { status: failure ? 'error' : 'ok' }),
        call: { text: buildJudgeText(tool, args), args: summarizeArgs(args) },
        decision: {
          matchedRule: described.ruleId,
          ruleId: described.ruleId,
          action: described.action,
          level: described.level,
          target: described.target,
          tool: described.decisionTool,
          needsHuman: described.needsHuman,
          confidence: described.confidence,
          failClosed: described.failClosed,
          errors: described.errors,
        },
        risk: described.risk,
        guard: { verdict: 'allow', reason: null },
        outcome: failure
          ? { status: 'error', code: (failure && failure.code) || (failure && failure.name) || 'Error', ms: totalMs }
          : { status: 'ok', ms: totalMs },
        latencyMs: judged.latencyMs,
        totalMs,
      });
      if (failure) throw failure;
      return result;
    })();
  }

  /**
   * Host `tools.guard` adapter for intercepted tools this plugin does NOT
   * register (currently engram's `memory_save`). Synchronous by contract; the
   * guard returns a reason string to deny and `undefined` to allow. It never
   * throws: an exception here would fail the whole tool surface.
   */
  function guard(tool, args) {
    if (!enabled || !INTERCEPTED_TOOLS.includes(tool) || ownTools.has(tool)) return undefined;
    try {
      const judged = judge(tool, args);
      const described = baseRecord(tool, args, judged);
      const deny = shouldDeny(tool, described);
      stats.judged += 1;
      stats.lastLatencyMs = judged.latencyMs;
      const details = {
        tool,
        ruleId: described.ruleId,
        level: described.level,
        needsHuman: described.needsHuman,
        risk: described.risk.level,
        reasons: described.risk.reasons,
        latencyMs: judged.latencyMs,
      };
      if (deny) stats.denied += 1;
      write({
        ts: new Date().toISOString(),
        mode,
        tool,
        source: 'guard',
        ...contractFields(tool, described, deny ? 'deny' : 'allow', buildJudgeText(tool, args), { status: deny ? 'denied' : 'pre-only' }),
        call: { text: buildJudgeText(tool, args), args: summarizeArgs(args) },
        decision: {
          matchedRule: described.ruleId,
          ruleId: described.ruleId,
          action: described.action,
          level: described.level,
          target: described.target,
          tool: described.decisionTool,
          needsHuman: described.needsHuman,
          confidence: described.confidence,
          failClosed: described.failClosed,
          errors: described.errors,
        },
        risk: described.risk,
        guard: { verdict: deny ? 'deny' : 'allow', reason: deny ? refusalMessage(details) : null },
        outcome: { status: deny ? 'denied' : 'pre-only', ms: 0 },
        latencyMs: judged.latencyMs,
        totalMs: judged.latencyMs,
      });
      return deny ? refusalMessage(details) : undefined;
    } catch {
      // Fail closed for writes only; a read must never be blocked by our bug.
      if (mode === 'on' && WRITE_TOOLS.includes(tool)) {
        return `${ROUTE_REFUSED_CODE}: ${tool} refused because the router failed to judge the call.`;
      }
      return undefined;
    }
  }

  /** True when the host guard should own this name (not registered by us). */
  function handles(name) {
    return enabled && INTERCEPTED_TOOLS.includes(name) && !ownTools.has(name);
  }

  return {
    mode,
    modeInvalid,
    maxRecords,
    enabled,
    statePath,
    ownTools: [...ownTools],
    intercept,
    guard,
    handles,
    stats: () => ({ ...stats, mode, statePath }),
    /** Test/diagnostic helper: the record a judge would produce, without IO. */
    describe: (tool, args) => baseRecord(tool, args, judge(tool, args)),
  };
}
