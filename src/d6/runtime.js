/**
 * D6 runtime — the Cordis side of the tool-surface trimmer.
 *
 * Design constraints, in order:
 *   1. The first `tools.resolve()` of a session must already see the reduced
 *      surface.  `agent/inbox/claimed` is emitted synchronously inside
 *      ReactLoopInbox.claim, before preStep calls tools.resolve, so this is the
 *      only hook that can freeze the allowlist in time on both host shapes.
 *      For a session restored after a host restart the first claim is turn N>1;
 *      the runtime still freezes there (once per process), see onClaimed.
 *   2. The allowlist is frozen for the session.  `tool_search` is the only
 *      operation allowed to grow it, and it grows by appending at the end.
 *   3. 0.2.2 filters through `agent.ctx.tools.restrict({deny})`; 0.2.1 does too
 *      when the service exists, and the `system-prompt/assemble` adapter keeps
 *      the same frozen set on hosts whose assemble result owns `tools`.
 *   4. Any unexpected input shape or thrown host call degrades to the full
 *      surface.  A broken filter must never cost the session its tools.
 */

import {
  assembleShape,
  filterAssembly,
  messageText,
  selectAllowlist,
} from './surface.js';
import { warnOnce } from '../host-version.js';

export const TOOL_SEARCH_NAME = 'tool_search';

/** The model-facing definition, exported so the budget test measures the real thing. */
export const TOOL_SEARCH_SPEC = {
  name: TOOL_SEARCH_NAME,
  description:
    'List tools trimmed from this session, or request one. Call with names to append them ' +
    'to the tool list; call with query to search. Added tools appear at the end on the next step.',
  // Host contract (`dsh-tools` `defineTool`): `parameters` is a map of argument
  // name -> *value schema*, not a JSON Schema object. Wrapping this in
  // {type:'object', properties} makes 0.2.2-rc.1 throw
  // "parameters.type must be a value schema object" while it builds the tool.
  parameters: {
    names: {
      type: 'array',
      items: { type: 'string' },
      description: 'Exact trimmed tool names to add.',
    },
    query: {
      type: 'string',
      description: 'Keyword search over trimmed tool names and descriptions.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum matches to list (1-20, default 8).',
    },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    // Host contract (`dsh-tools` pipeline.createSuccessResult): the return value
    // of `render` becomes the tool-result message `content` verbatim. 0.2.2
    // walks that content as typed blocks (dsh-llm `contentHasImage` calls
    // `content.some(...)`), so a string makes the host throw
    // "content.some is not a function". Every other tool in this package renders
    // through `OUTPUT_TEXT`; tool_search must use the same array-of-text-blocks
    // shape.
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
};

const MAX_MATCHES = 20;
const MAX_DESCRIPTION = 180;

function loggerOf(ctx) {
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('longlive') : ctx?.logger;
    return logger && typeof logger === 'object' ? logger : null;
  } catch {
    return null;
  }
}

function info(ctx, text) {
  const logger = loggerOf(ctx);
  if (logger && typeof logger.info === 'function') {
    try {
      logger.info(text);
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    console.log(`[dsh-longlive] ${text}`);
  } catch {
    /* a host without console must not break the plugin */
  }
}

function warn(ctx, text) {
  warnOnce(ctx, text);
}

/** A host message is a real user turn only when the host says so. */
function isRealUserMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  const kind = message.source?.kind;
  if (kind !== undefined && kind !== null && kind !== 'user') return false;
  if (message.role !== 'user' && kind !== 'user') return false;
  return messageText(message).trim().length > 0;
}

/** Visible model-facing schemas for one agent, with graceful fallbacks. */
function listTools(agent) {
  const tools = agent?.ctx?.tools;
  if (!tools) return [];
  try {
    if (typeof tools.schemas === 'function') {
      const value = tools.schemas(agent);
      if (Array.isArray(value)) return value;
    }
  } catch {
    /* try definitions()/view() below */
  }
  try {
    if (typeof tools.definitions === 'function') {
      const value = tools.definitions(agent);
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.tools)) return value.tools;
    }
  } catch {
    /* try view() below */
  }
  try {
    if (typeof tools.view === 'function') {
      const view = tools.view(agent);
      const visible = view?.visible;
      if (visible instanceof Map) {
        return [...visible.values()].map((entry) => entry?.definition ?? entry).filter(Boolean);
      }
      if (Array.isArray(visible)) return visible;
    }
  } catch {
    /* no visible schemas */
  }
  return [];
}

/** Latest live goal objective, if the goals service is not injected. */
function readGoal(agent) {
  try {
    const goal = agent?.ctx?.goals?.get?.(agent) ?? agent?.ctx?.goals?.get?.(agent?.session);
    const objective = goal?.objective ?? goal?.goal?.objective;
    const phase = goal?.phase ?? goal?.goal?.phase;
    if (typeof objective === 'string' && phase !== 'complete' && phase !== 'cleared') return objective;
  } catch {
    /* fall through to the event log */
  }
  try {
    const events = agent?.session?.snapshotEvents?.() ?? agent?.session?.eventsSnapshot?.();
    if (!Array.isArray(events)) return '';
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'goal/change') continue;
      const data = event.data ?? {};
      const goal = data.goal ?? data.change?.goal ?? null;
      if (!goal || typeof goal.objective !== 'string') continue;
      if (goal.phase === 'complete' || goal.phase === 'cleared') return '';
      return goal.objective;
    }
  } catch {
    /* a session without goals is the normal case */
  }
  return '';
}

function requestableNames(agent, names) {
  const tools = agent?.ctx?.tools;
  if (!tools || typeof tools.view !== 'function') return names;
  try {
    const view = tools.view(agent);
    const restrictable = view?.restrictableNames;
    if (restrictable instanceof Set) return names.filter((name) => restrictable.has(name));
    if (Array.isArray(restrictable)) return names.filter((name) => restrictable.includes(name));
  } catch {
    /* let restrict() report the real error */
  }
  return names;
}

/**
 * Apply the frozen allowlist as a host restriction.
 * Returns false when the host has no scoped restrict() (the 0.2.1 shape).
 */
function applyRestriction(agent, state, restrictions) {
  const tools = agent?.ctx?.tools;
  if (!tools || typeof tools.restrict !== 'function') return false;
  const deny = requestableNames(agent, state.deny);
  const old = state.restriction;
  let next = null;
  try {
    if (deny.length > 0) next = tools.restrict({ deny });
  } catch (error) {
    state.restriction = old;
    throw error;
  }
  state.restriction = next;
  if (next) restrictions.add(next);
  if (old) {
    restrictions.delete(old);
    try {
      old();
    } catch {
      /* disposal is best effort */
    }
  }
  state.applied = true;
  return true;
}

function descriptionOf(value) {
  const text = typeof value?.description === 'string' ? value.description : '';
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

function matchTrimmed(state, args) {
  const trimmed = state.trimmed;
  const names = Array.isArray(args?.names) ? args.names.filter((name) => typeof name === 'string') : [];
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  const requestable = trimmed.filter((name) => !state.allow.has(name));
  let matches = [];
  if (names.length > 0) {
    const wanted = new Set(names);
    matches = requestable.filter((name) => wanted.has(name));
  } else if (query !== '') {
    const needle = query.toLowerCase();
    matches = requestable.filter((name) => {
      const tool = state.byName.get(name);
      return `${name} ${tool?.description ?? ''}`.toLowerCase().includes(needle);
    });
  } else {
    matches = requestable;
  }
  const limitValue = Number(args?.limit);
  const limit = Number.isFinite(limitValue) && limitValue > 0
    ? Math.min(Math.floor(limitValue), MAX_MATCHES)
    : 8;
  return matches.slice(0, limit);
}

function makeToolSearch(runtime) {
  return {
    ...TOOL_SEARCH_SPEC,
    // registerTools() owns the host-facing execute wrapper and calls invoke().
    invoke: (args, config) => runtime.toolSearch(args, config),
  };
}

/**
 * @param {{config?: object}} input
 */
export function createD6Runtime({ config = {} } = {}) {
  const d6 = config?.d6 ?? {};
  const dryRun = d6.dryRun === true;
  const logTrim = d6.log !== false;
  const states = new WeakMap();
  const restrictions = new Set();

  function stateFor(agent) {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return null;
    let state = states.get(agent);
    if (!state) {
      state = {
        frozen: false,
        task: 'general',
        allow: new Set(),
        deny: [],
        requested: [],
        trimmed: [],
        byName: new Map(),
        fullTools: [],
        applied: false,
        fallback: null,
        restriction: null,
        shape: null,
        restrictAvailable: true,
      };
      states.set(agent, state);
    }
    return state;
  }

  /**
   * Called from the synchronous `agent/inbox/claimed` listener.
   *
   * Freeze on the first real user turn this host process sees, not on literal
   * turn 1.  A session restored after a host restart resumes at turn N > 1, so
   * the old `turn > 1` guard meant it could never freeze: `tool_search` stayed
   * `D6_NOT_FROZEN` and the surface was never trimmed for the rest of its life
   * (G3, docs/CONFIG.md §1.4).  The `state.frozen` guard below keeps ordinary
   * sessions on the original "freeze once, never re-freeze" semantics.
   */
  function onClaimed(payload) {
    try {
      const agent = payload?.agent;
      const message = payload?.message;
      if (!agent) return;
      const state = stateFor(agent);
      if (!state || state.frozen) return;
      if (!isRealUserMessage(message)) return;

      state.frozen = true;
      let selection;
      let tools = [];
      try {
        const goal = readGoal(agent);
        tools = listTools(agent);
        selection = selectAllowlist({ goal, message, tools, config: d6 });
      } catch (error) {
        state.fallback = 'full';
        warn(payload?.agent?.ctx ?? null, `[d6] selection failed, keeping the full surface: ${error?.message ?? error}`);
        return;
      }

      state.task = selection.task;
      state.trimmed = selection.trimmed;
      state.fullTools = tools;
      state.byName = new Map(state.fullTools.map((tool) => [tool.name, tool]));
      state.allow = new Set(selection.allow);
      state.deny = requestableNames(agent, selection.trimmed);

      if (selection.fallback || selection.keepCount === 0) {
        state.fallback = 'full';
        warn(agent.ctx ?? null, '[d6] no tool survived the core filter, keeping the full surface');
        return;
      }

      if (logTrim) {
        const names = state.trimmed.length > 0 ? state.trimmed.join(',') : '-';
        info(
          agent.ctx ?? null,
          `[d6]${dryRun ? ' dry-run' : ''} task=${state.task} keep=${selection.keepCount} ` +
            `trim=${state.trimmed.length} shape=${state.shape ?? 'pending'} names=${names}`,
        );
      }
      if (dryRun) return;

      try {
        const applied = applyRestriction(agent, state, restrictions);
        state.restrictAvailable = applied;
        if (!applied) info(agent.ctx ?? null, '[d6] host has no tools.restrict(); using the 0.2.1 assemble adapter');
      } catch (error) {
        state.fallback = 'full';
        state.applied = false;
        warn(agent.ctx ?? null, `[d6] tools.restrict() failed, keeping the full surface: ${error?.message ?? error}`);
      }
    } catch (error) {
      warn(null, `[d6] claimed hook failed: ${error?.message ?? error}`);
    }
  }

  /** Called after the assemble waterfall's inner chain has produced a value. */
  function onAssemble(assembly, context) {
    try {
      const agent = context?.agent ?? context?.scope;
      const state = agent ? states.get(agent) : null;
      if (!state || !state.frozen) return assembly;
      const shape = assembleShape(assembly);
      if (state.shape === null) {
        state.shape = shape;
        info(agent.ctx ?? null, `[d6] assemble shape=${shape}`);
      }
      if (dryRun || state.fallback === 'full') return assembly;
      if (shape === '0.2.2') return assembly;
      const result = filterAssembly(assembly, {
        allow: state.allow,
        requested: state.requested,
        fullTools: state.fullTools,
      });
      if (result.fallback) {
        state.fallback = 'full';
        warn(agent.ctx ?? null, '[d6] assemble filter would be empty, keeping the full surface');
        return assembly;
      }
      return result.assembly;
    } catch (error) {
      try {
        warn(null, `[d6] assemble adapter failed, keeping the full surface: ${error?.message ?? error}`);
      } catch {
        /* ignore */
      }
      return assembly;
    }
  }

  /** The body of the model-facing `tool_search` tool. */
  function toolSearch(args, config) {
    try {
      const agent = config?.exec?.agent;
      const state = agent ? states.get(agent) : null;
      if (!state || !state.frozen) {
        return { ok: false, error: 'D6_NOT_FROZEN', message: 'tool_search is only available on a frozen D6 session.' };
      }
      if (dryRun) {
        return { ok: false, error: 'D6_DRY_RUN', message: 'D6 is in dry-run mode; the surface was not trimmed.' };
      }
      const matchedNames = matchTrimmed(state, args);
      const hasRequest = (Array.isArray(args?.names) && args.names.length > 0) || (typeof args?.query === 'string' && args.query.trim() !== '');
      const matched = matchedNames.map((name) => ({ name, description: descriptionOf(state.byName.get(name)) }));
      if (!hasRequest) {
        return {
          ok: true,
          task: state.task,
          matched,
          totalTrimmed: state.trimmed.length,
          hint: 'Pass names to append tools, or query to search.',
        };
      }
      if (matchedNames.length === 0) {
        return { ok: true, task: state.task, added: [], matched: [], totalTrimmed: state.trimmed.length };
      }

      const beforeAllow = new Set(state.allow);
      const beforeDeny = [...state.deny];
      const beforeRequested = [...state.requested];
      for (const name of matchedNames) {
        state.allow.add(name);
        if (!state.requested.includes(name)) state.requested.push(name);
        state.deny = state.deny.filter((entry) => entry !== name);
      }
      try {
        if (state.restrictAvailable) {
          const applied = applyRestriction(agent, state, restrictions);
          state.restrictAvailable = applied || state.restrictAvailable;
        }
      } catch (error) {
        state.allow = beforeAllow;
        state.deny = beforeDeny;
        state.requested = beforeRequested;
        return { ok: false, error: 'D6_ADD_FAILED', message: String(error?.message ?? error) };
      }
      return {
        ok: true,
        task: state.task,
        added: matchedNames,
        matched,
        totalTrimmed: state.trimmed.length,
        note: 'Added tools appear at the end of the tool list on the next step.',
      };
    } catch (error) {
      return { ok: false, error: 'D6_TOOL_SEARCH_FAILED', message: String(error?.message ?? error) };
    }
  }

  function dispose() {
    for (const restriction of restrictions) {
      try {
        restriction();
      } catch {
        /* ignore */
      }
    }
    restrictions.clear();
  }

  return { onClaimed, onAssemble, toolSearch, dispose, stateFor };
}

/**
 * Register D6 if (and only if) `config.d6.enabled === true`.
 *
 * @returns {{enabled: boolean, tools: object[], runtime?: object}}
 */
export function registerD6(ctx, config = {}) {
  if (config?.d6?.enabled !== true) return { enabled: false, tools: [] };
  const runtime = createD6Runtime({ config });
  const disposers = [];
  try {
    const dispose = ctx.on('agent/inbox/claimed', (payload) => runtime.onClaimed(payload));
    if (typeof dispose === 'function') disposers.push(dispose);
  } catch (error) {
    warn(ctx, `[d6] cannot listen for agent/inbox/claimed: ${error?.message ?? error}`);
  }
  try {
    const dispose = ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      let result = assembly;
      try {
        if (typeof next === 'function') result = await next();
      } catch (error) {
        warn(ctx, `[d6] inner assemble failed, keeping the full surface: ${error?.message ?? error}`);
        return assembly;
      }
      return runtime.onAssemble(result, context);
    });
    if (typeof dispose === 'function') disposers.push(dispose);
  } catch (error) {
    warn(ctx, `[d6] cannot listen for system-prompt/assemble: ${error?.message ?? error}`);
  }
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
        runtime.dispose();
      }, 'longlive.d6');
    } catch {
      /* fake context without an effect scope */
    }
  }
  return {
    enabled: true,
    tools: config?.d6?.dryRun === true ? [] : [makeToolSearch(runtime)],
    runtime,
  };
}
