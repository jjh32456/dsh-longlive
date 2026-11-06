// Session identity for the longlive plugin.
//
// The plugin runs at the profile root, so it has no `ctx.session` / `ctx.agent`
// of its own. The host still gives every tool call an explicit caller: the
// second `execute(args, exec)` argument carries the live Agent
// (`exec.agent.session.header.id`), built by dsh-agent-loop from
// `ctx.agents.requireInitiator()`. That is route 1 below and the only route
// this plugin treats as authoritative.
//
// Outside a tool call there is no caller: `currentInitiator()` returns
// `undefined` in timers and event callbacks by design (dsh-agent README:
// "the boundary is process-local attribution only"). Auto-heartbeat therefore
// binds the id at tool-call time and only *refreshes* already-bound rows later.
//
// Every route is read inside `try/catch`: identity must never turn a tool call
// into a crash, and a missing id must stay `null` so the existing explicit
// errors (`无法确定当前会话 id ...`) are preserved.

/** Resolution sources, most reliable first. */
export const IDENTITY_SOURCES = Object.freeze([
  'exec.agent',
  'agents.currentInitiator',
  'ctx.agent',
  'env.DSH_SESSION_ID',
  'none',
]);

function cleanId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The SessionId carried by one live Agent.
 *
 * `session.header.id` is the persisted header id, `session.id` the live one and
 * `agent.id` the agent's own SessionId; they are expected to agree, and any one
 * of them is a real id rather than a guess.
 */
export function sessionIdOfAgent(agent) {
  if (agent == null || typeof agent !== 'object') return null;
  try {
    return cleanId(agent.session?.header?.id)
      ?? cleanId(agent.session?.id)
      ?? cleanId(agent.id);
  } catch {
    return null;
  }
}

/** The SessionId carried by a tool-execution context (`exec`). */
export function sessionIdOfExec(exec) {
  if (exec == null || typeof exec !== 'object') return null;
  const fromAgent = sessionIdOfAgent(exec.agent);
  if (fromAgent) return fromAgent;
  try {
    return cleanId(exec.session?.id) ?? cleanId(exec.sessionId);
  } catch {
    return null;
  }
}

function initiatorOf(ctx) {
  if (ctx == null || typeof ctx !== 'object') return null;
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null;
    return agents != null && typeof agents.currentInitiator === 'function'
      ? agents.currentInitiator()
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the session that is calling right now.
 *
 * @param {object} [options]
 * @param {object|null} [options.ctx] live Cordis context (optional; used for
 *   the agents service and the legacy ctx-guess routes)
 * @param {object|null} [options.exec] tool-execution context (route 1)
 * @param {object} [options.env] environment to read the last-resort id from
 * @returns {{id: string|null, source: string}}
 */
export function resolveCurrentSessionId({ ctx = null, exec = null, env = process.env } = {}) {
  const fromExec = sessionIdOfExec(exec);
  if (fromExec) return { id: fromExec, source: 'exec.agent' };

  const fromInitiator = sessionIdOfAgent(initiatorOf(ctx));
  if (fromInitiator) return { id: fromInitiator, source: 'agents.currentInitiator' };

  // Legacy guesses: kept for preset-scoped contexts that really do carry an
  // agent; at the profile root all of these are undefined.
  try {
    const fromCtx = sessionIdOfAgent(ctx?.agent)
      ?? cleanId(ctx?.session?.id)
      ?? cleanId(ctx?.agent?.sessionId)
      ?? cleanId(ctx?.sessionId);
    if (fromCtx) return { id: fromCtx, source: 'ctx.agent' };
  } catch {
    /* fall through */
  }

  // Last resort only: dsh-shell-env injects DSH_SESSION_ID per shell call, so a
  // host process may not have it, and a value inherited from a launching shell
  // may be stale. It is still better than refusing to name a session when no
  // host contract is available.
  let fromEnv = null;
  try {
    fromEnv = cleanId(env?.DSH_SESSION_ID);
  } catch {
    fromEnv = null;
  }
  if (fromEnv) return { id: fromEnv, source: 'env.DSH_SESSION_ID' };

  return { id: null, source: 'none' };
}
