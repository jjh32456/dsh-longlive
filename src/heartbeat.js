// Auto-heartbeat for the "正在" live registry.
//
// Two clocks keep a bound row fresh without the caller passing sessionId:
//   1. turn lifecycle — `session/event` with `turn/start` / `turn/end` for a
//      session this writer has already bound;
//   2. a fallback interval (`heartbeatMs`, default 15 s, `0` disables), which
//      is what keeps the row fresh through long tool calls and idle stretches.
//
// Identity is bound, never guessed: the id comes from a tool call's explicit
// `exec.agent` (see identity.js). Turn events and the timer only refresh ids
// already in that bound set, so a root-scoped plugin observing every session
// can never heartbeat somebody else's row.
//
// Every write is best effort: a missing/corrupt row, an unset memoryRoot or a
// racing writer must never fail a tool call or crash the host.

import { liveTouch, liveUpdate } from './live.js';
import { resolveCurrentSessionId } from './identity.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const MAX_BOUND_SESSIONS = 64;

function cleanId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // The live registry's own id rule, applied non-throwing here: a bad id from
  // an environment variable is simply not a session we can bind.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * @param {object} [options]
 * @param {object|null} [options.ctx] host context (used for `session/event`)
 * @param {string} [options.memoryRoot] live-registry root; absent disables writes
 * @param {number} [options.heartbeatMs] fallback interval; `0` disables all
 *   automatic writes (binding still happens through the tool resolver)
 * @param {() => (Date|number)} [options.now] clock injection for tests
 * @param {Function} [options.touch] `liveTouch` injection for tests
 * @param {Function} [options.update] `liveUpdate` injection for tests (first
 *   registration of a session that has no row yet)
 * @param {Function} [options.setInterval] timer injection for tests
 * @param {Function} [options.clearInterval]
 * @param {Function} [options.resolve] `(exec) => {id, source}` injection
 */
export function createAutoHeartbeat(options = {}) {
  const {
    ctx = null,
    memoryRoot,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    now,
    touch = liveTouch,
    update = liveUpdate,
    setInterval: setIntervalFn = globalThis.setInterval,
    clearInterval: clearIntervalFn = globalThis.clearInterval,
    resolve = (exec) => resolveCurrentSessionId({ ctx, exec }),
    onTurnEnd = null,
  } = options;

  const root = typeof memoryRoot === 'string' && memoryRoot.trim() !== ''
    ? memoryRoot.trim()
    : null;
  const interval = typeof heartbeatMs === 'number' ? heartbeatMs : Number(heartbeatMs);
  // Only a finite positive interval enables automatic writes; 0/invalid = off.
  const enabled = Number.isFinite(interval) && interval > 0;

  const bound = new Set();
  let timer = null;
  let disposeListener = null;
  let started = false;
  let stopped = false;

  function bind(sessionId) {
    const id = cleanId(sessionId);
    if (!id) return false;
    bound.add(id);
    // Bound set is small in practice (one per session that called us); the cap
    // only stops a pathological host from pinning memory forever.
    while (bound.size > MAX_BOUND_SESSIONS) {
      const oldest = bound.values().next().value;
      bound.delete(oldest);
    }
    return true;
  }

  function stamp() {
    return typeof now === 'function' ? now() : now;
  }

  function touchOne(id, { kind, detail, lastAction = true } = {}) {
    if (!enabled || root == null || typeof touch !== 'function') {
      return { ok: false, status: 'disabled' };
    }
    const config = { memoryRoot: root, lastAction };
    const at = stamp();
    if (at !== undefined) config.now = at;
    if (typeof kind === 'string') config.kind = kind;
    if (typeof detail === 'string') config.detail = detail;
    try {
      return touch(id, config);
    } catch {
      // Heartbeat is liveness decoration, never the task: swallow and move on.
      return { ok: false, status: 'error' };
    }
  }

  /**
   * First sight of a session: create its row. This is the one deliberate
   * write-on-read in the plugin — the live table learns "I am this session"
   * the moment the session uses a longlive tool, instead of waiting for a
   * caller to pass sessionId (which nobody can know from inside a tool).
   * `liveUpdate` supplies the schema defaults; the row starts `running`
   * because a tool call is, by definition, an active turn.
   */
  function registerOne(id, { kind, detail } = {}) {
    if (!enabled || root == null || typeof update !== 'function') {
      return { ok: false, status: 'disabled' };
    }
    const args = { sessionId: id, state: 'running' };
    if (typeof kind === 'string' || typeof detail === 'string') {
      args.last_action = { kind, detail };
    }
    const config = { memoryRoot: root };
    const at = stamp();
    if (at !== undefined) config.now = at;
    try {
      return update(args, config);
    } catch {
      return { ok: false, status: 'error' };
    }
  }

  /**
   * Called by the tool wrapper on every longlive tool invocation: resolve the
   * explicit caller, bind it, and refresh its row (creating it on first use).
   */
  function autoTouch(exec, toolName) {
    if (!enabled) return null;
    let resolved = null;
    try {
      resolved = resolve(exec);
    } catch {
      resolved = null;
    }
    const id = cleanId(resolved?.id);
    if (!id) return null;
    bind(id);
    const lastAction = {
      kind: 'tool',
      detail: `longlive 工具调用：${typeof toolName === 'string' ? toolName : 'unknown'}`,
    };
    const touched = touchOne(id, lastAction);
    // No row yet -> this tool call is the session's self-registration. Keep
    // the same last_action so the row does not look like a bare "create".
    if (touched?.status === 'absent') return registerOne(id, lastAction);
    return touched;
  }

  function onSessionEvent(session, event) {
    let id = null;
    try {
      id = cleanId(session?.id) ?? cleanId(session?.header?.id);
    } catch {
      id = null;
    }
    // Auto-truncation watches every session in this agent's scope, not only
    // the ones bound to the live registry: a session that never called a
    // longlive tool can still grow past the threshold. It runs before the
    // `enabled` gate so `heartbeatMs:0` (live writes off) does not also turn
    // maintenance off.
    if (typeof onTurnEnd === 'function' && event?.type === 'turn/end' && id) {
      try {
        onTurnEnd({ session, event, sessionId: id, turn: event?.data?.turn });
      } catch {
        /* automation is best effort; never fail the host feed */
      }
    }
    if (!enabled) return;
    if (!id || !bound.has(id)) return;
    const type = event?.type;
    if (type !== 'turn/start' && type !== 'turn/end') return;
    const turn = event?.data?.turn;
    touchOne(id, {
      kind: 'turn',
      detail: turn == null ? type : `${type} #${turn}`,
    });
  }

  function tick() {
    if (!enabled) return;
    for (const id of [...bound]) {
      // A timer tick is pure liveness: it must not rewrite last_action or make
      // an idle session look like it just did something.
      touchOne(id, { lastAction: false });
    }
  }

  function start() {
    if (started || stopped) return false;
    started = true;
    if (ctx != null && typeof ctx.on === 'function') {
      try {
        const disposer = ctx.on('session/event', onSessionEvent);
        if (typeof disposer === 'function') disposeListener = disposer;
      } catch {
        disposeListener = null;
      }
    }
    if (enabled && root != null && typeof setIntervalFn === 'function') {
      timer = setIntervalFn(tick, interval);
      if (timer != null && typeof timer.unref === 'function') {
        // Never hold the process open just to heartbeat.
        timer.unref();
      }
    }
    return true;
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    if (timer != null && typeof clearIntervalFn === 'function') {
      try {
        clearIntervalFn(timer);
      } catch {
        /* already gone */
      }
    }
    timer = null;
    if (typeof disposeListener === 'function') {
      try {
        disposeListener();
      } catch {
        /* already disposed with the plugin fiber */
      }
    }
    disposeListener = null;
    return true;
  }

  return {
    bind,
    autoTouch,
    onSessionEvent,
    start,
    stop,
    touchOne,
    boundIds: () => [...bound],
    isEnabled: () => enabled,
    intervalMs: () => (enabled ? interval : 0),
  };
}
