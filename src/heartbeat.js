// Auto-heartbeat for the "正在" live registry.
//
// Two clocks keep a row fresh without the caller passing sessionId:
//   1. turn lifecycle — `session/event` with `turn/start` / `turn/end`. The
//      event itself carries the session id, so turn boundaries maintain EVERY
//      non-subagent session's row (R4.5), bound or not; a missing row is
//      created on the first boundary (128-row cap respected, R4.3);
//   2. a fallback interval (`heartbeatMs`, default 15 s, `0` disables), which
//      keeps rows of sessions bound by a longlive tool call fresh through long
//      tool calls and idle stretches. It never fabricates rows.
//
// Turn boundaries are a state machine, not a heartbeat: `turn/start` writes
// `state='running'` plus the turn number, `turn/end` writes
// `idle`/`waiting`/`blocked` plus the turn number (R4.3). It is event driven,
// so it still runs when the fallback timer is off (`heartbeatMs: 0`); a timer
// tick, by contrast, only renews `heartbeatAt` and never touches state or
// `last_action`.
//
// Every write is best effort: a missing/corrupt row, an unset memoryRoot, a
// full registry or a racing writer must never fail a tool call or crash the
// host.

import { liveGet, liveList, liveTouch, liveUpdate } from './live.js';
import { resolveCurrentSessionId } from './identity.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const MAX_BOUND_SESSIONS = 64;
/** DESIGN §2.1 live-row cap; mirrored here so turn boundaries cannot blow it up. */
export const MAX_LIVE_ROWS = 128;

/**
 * R4.3 pure state machine: state a live row must carry when a turn starts.
 * @returns {'running'}
 */
export function stateForTurnStart() {
  return 'running';
}

/**
 * R4.3 pure state machine: state a live row must carry when a turn ends.
 * `waiting`/`blocked` are user-facing promises and survive the turn boundary;
 * anything else falls back to `idle`.
 * @param {unknown} priorState declared state read before the turn/end write
 * @returns {'idle'|'waiting'|'blocked'}
 */
export function stateForTurnEnd(priorState) {
  return priorState === 'waiting' || priorState === 'blocked' ? priorState : 'idle';
}

/**
 * Pure description of the live-row patch caused by one turn boundary. Kept
 * separate from I/O so the state machine can be pinned without a registry.
 * @param {'turn/start'|'turn/end'} type
 * @param {{turn?:unknown, priorState?:unknown}} [options]
 * @returns {{state:string, turn:number|null, kind:'turn', detail:string}}
 */
export function turnBoundaryPlan(type, options = {}) {
  const kind = type === 'turn/end' ? 'turn/end' : 'turn/start';
  const state = kind === 'turn/start' ? stateForTurnStart() : stateForTurnEnd(options.priorState);
  const turn = Number.isInteger(options.turn) && options.turn >= 0 ? options.turn : null;
  return { state, turn, kind: 'turn', detail: turn == null ? kind : `${kind} #${turn}` };
}

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
 * @param {number} [options.heartbeatMs] fallback interval; `0` disables the
 *   timer and tool-call touches (binding still happens through the tool
 *   resolver). Turn-boundary state writes (`turn/start` → running + turn,
 *   `turn/end` → idle/waiting/blocked + turn) are event driven and keep
 *   working, because "no timer" is not "no state machine" (R4.3).
 * @param {() => (Date|number)} [options.now] clock injection for tests
 * @param {Function} [options.touch] `liveTouch` injection for tests
 * @param {Function} [options.update] `liveUpdate` injection for tests (first
 *   registration of a session that has no row yet)
 * @param {Function} [options.get] `liveGet` injection for tests (turn/end reads
 *   the prior declared state so waiting/blocked survive)
 * @param {number} [options.maxRows] live-row cap for rows created by turn
 *   boundaries (default 128, DESIGN §2.1)
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
    // Read side, used only to preserve waiting/blocked across turn/end.
    get = liveGet,
    maxRows = MAX_LIVE_ROWS,
    setInterval: setIntervalFn = globalThis.setInterval,
    clearInterval: clearIntervalFn = globalThis.clearInterval,
    resolve = (exec) => resolveCurrentSessionId({ ctx, exec }),
    onTurnEnd = null,
  } = options;

  const root = typeof memoryRoot === 'string' && memoryRoot.trim() !== ''
    ? memoryRoot.trim()
    : null;
  const interval = typeof heartbeatMs === 'number' ? heartbeatMs : Number(heartbeatMs);
  // Only a finite positive interval enables the fallback timer and the
  // tool-call touches; 0/invalid = those two off. Turn-boundary state writes
  // (R4.3) are event driven and deliberately independent of this flag.
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

  /**
   * Prior row snapshot for a turn boundary: does it exist, and what state does
   * it declare? Read-only; never throws. `known:false` means the read itself
   * failed, in which case we still attempt the write (liveUpdate is atomic and
   * the row keeps its prior values for omitted fields).
   */
  function readPriorRow(id) {
    if (root == null || typeof get !== 'function') return { known: false, found: false, state: null };
    const config = { memoryRoot: root };
    const at = stamp();
    if (at !== undefined) config.now = at;
    try {
      const got = get({ sessionId: id }, config);
      if (got?.ok === true) {
        return { known: true, found: true, state: typeof got.live?.state === 'string' ? got.live.state : null };
      }
      if (got?.status === 'absent') return { known: true, found: false, state: null };
      // corrupt/unreadable-but-present: it occupies a slot; a write repairs it.
      return { known: true, found: true, state: null };
    } catch {
      return { known: false, found: false, state: null };
    }
  }

  /** True when a NEW row may still be created without exceeding the 128 cap. */
  function hasRowCapacity() {
    if (root == null || typeof liveList !== 'function') return true;
    const config = { memoryRoot: root };
    const at = stamp();
    if (at !== undefined) config.now = at;
    try {
      const listed = liveList({ includeDead: true }, config);
      const scanned = Number.isInteger(listed?.scanned)
        ? listed.scanned
        : (Array.isArray(listed?.entries) ? listed.entries.length : 0);
      return scanned < maxRows;
    } catch {
      // Cannot tell -> do not create rows, but an existing row may be updated.
      return false;
    }
  }

  /** One best-effort live-row patch at a turn boundary (state + turn + action). */
  function writeTurnBoundary(id, { state, turn, kind, detail }) {
    if (root == null || typeof update !== 'function') return { ok: false, status: 'disabled' };
    const args = { sessionId: id, state, last_action: { kind, detail } };
    if (Number.isInteger(turn) && turn >= 0) args.turn = turn;
    const config = { memoryRoot: root };
    const at = stamp();
    if (at !== undefined) config.now = at;
    try {
      return update(args, config);
    } catch {
      // A state-machine write is decoration for other sessions, never the
      // turn itself: swallow and let the turn proceed.
      return { ok: false, status: 'error' };
    }
  }

  function onSessionEvent(session, event) {
    let id = null;
    let origin = null;
    try {
      id = cleanId(session?.id)
        ?? cleanId(session?.header?.id)
        ?? cleanId(event?.session?.id)
        ?? cleanId(event?.session?.header?.id);
      const header = session?.header ?? session?.session?.header ?? event?.session?.header ?? {};
      origin = typeof header.origin === 'string' ? header.origin : null;
    } catch {
      id = null;
    }
    // Auto-truncation watches every session in this agent's scope, not only
    // the ones bound to the live registry: a session that never called a
    // longlive tool can still grow past the threshold. It runs before the
    // live-state gate so `heartbeatMs:0` does not also turn maintenance off.
    if (typeof onTurnEnd === 'function' && event?.type === 'turn/end' && id) {
      try {
        onTurnEnd({ session, event, sessionId: id, turn: event?.data?.turn });
      } catch {
        /* automation is best effort; never fail the host feed */
      }
    }
    const type = event?.type;
    if (!id) return;
    if (type !== 'turn/start' && type !== 'turn/end') return;
    // R4.6: subagents are counted separately on the board; they never get a
    // live row from the heartbeat (same rule as the Router's L1 writer).
    if (origin === 'subagent') return;
    if (root == null || typeof update !== 'function') return;
    const turn = event?.data?.turn;
    // R4.5: the event carries the session id, so turn boundaries maintain
    // EVERY non-subagent session's row — a session that only runs native tools
    // (never calls a longlive tool, so it is never `bind`ed) must still switch
    // state/turn. Create the row on its first boundary, within the 128 cap.
    const prior = readPriorRow(id);
    if (!prior.found && !hasRowCapacity()) return;
    if (type === 'turn/start') {
      // R4.3 状态机：turn/start 立刻让 live 行 state: 'running' 并写入 turn 号
      // （liveUpdate 一次完成；与心跳 tick 无关，tick 只续 heartbeatAt）。
      const plan = turnBoundaryPlan('turn/start', { turn });
      writeTurnBoundary(id, plan);
      return;
    }
    // turn/end: idle/blocked/waiting 都落 turn 号；waiting/blocked 是给用户
    // 看的承诺，turn 结束不能把它抹成 idle。
    const endPlan = turnBoundaryPlan('turn/end', { turn, priorState: prior.state });
    writeTurnBoundary(id, endPlan);
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
