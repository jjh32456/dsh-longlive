// activity/index.js — shared-brain activity stream wiring (1.6.1, event-level).
//
// Producer: `session/event` writes into <memoryRoot>/.longlive/board/activity.jsonl.
//   - `tool/call` (and `tool/result` with isError) refresh this turn's 「最近动作」
//     row immediately, as 「工具：目标」 (e.g. 「pwsh：libtv 锚图 S08-S10」), so a
//     sibling session sees a >10-minute turn while it is still running. Same-key
//     refreshes are throttled to ≤1 write/10s; a merge bumps the row's `seq`
//     (touchSeq) so the injection cursor below actually sees the refresh.
//   - `turn/end` writes the local-rule conclusion row (user gist · assistant
//     conclusion · latest tool action, ≤140 chars) as before.
// No model call, no session-log scan, no tool invocation.
//
// Consumer: `agent/pre-step` (step 1) → inject only rows with seq greater than
// this session's lastSeenSeq, other sessions only, at most `maxItems` rows and
// at most `injectMaxChars` characters (header/footer included). No rows means
// no write — zero token cost. Because every event-level refresh bumps seq, the
// cursor never gets stuck behind a long turn's first row.
//
// Failure policy: every path is wrapped; a broken board, a missing lock, a
// privacy verdict or a host without @deepseek-ai/dsh-llm just skips this
// feature. A turn is never blocked by the activity stream.

import path from 'node:path';

import { isUserAuthoredMessage } from '../truncate-visible.js';
import {
  assertInjectionSource,
  injectionSource,
  insertionIndex,
  isHumanMessage,
  textOfMessage,
} from '../identity/inject-position.js';
import { privacyScan as defaultPrivacyScan } from '../recall/privacy.mjs';
import { startPrestepPhase, notePrestepDegrade } from '../metrics/prestep-latency.mjs';
import {
  ACTIVITY_HINT_MARK,
  ACTIVITY_REFRESH_THROTTLE_MS,
  buildActivityKey,
  buildActivityText,
  buildToolActivityText,
  charLength,
  classifyKind,
  clip,
  oneLine,
  renderActivityHint,
  selectActivities,
  shortSessionId,
} from './model.js';
import {
  THINKING_HINT_MARK,
  extractThinkingText,
  isThinkingPayloadSafe,
  renderThinkingHint,
  selectThinkingActivities,
  summarizeThinking,
} from './thinking.js';
import {
  ACTIVITY_SESSION_RE,
  activityBoardFile,
  createActivityStore,
  readJsonFile,
  writeJsonAtomic,
} from './store.js';

export const ACTIVITY_STATE_VERSION = 1;
export const ACTIVITY_STATE_DIR = path.join('.longlive', 'bridge');

export const ACTIVITY_DEFAULTS = Object.freeze({
  // 1.8.0 product default: real-time shared memory is ON by default; users opt
  // out with an explicit `enabled: false` (never by omission).
  enabled: true,
  injectMaxChars: 300,
  maxItems: 5,
});

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/** Pure normalizer; the config schema uses the same defaults. */
export function normalizeActivityConfig(input = {}) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  return {
    // Default ON (1.8.0): only a literal false opts out.
    enabled: raw.enabled !== false,
    injectMaxChars: clampInt(raw.injectMaxChars, ACTIVITY_DEFAULTS.injectMaxChars, 60, 2000),
    maxItems: clampInt(raw.maxItems, ACTIVITY_DEFAULTS.maxItems, 1, 10),
    createUserMessage: typeof raw.createUserMessage === 'function' ? raw.createUserMessage : undefined,
  };
}

export function activityStateFile(memoryRoot, sessionId) {
  return path.join(String(memoryRoot ?? ''), ACTIVITY_STATE_DIR, `${sessionId}.activity.json`);
}

export function emptyActivityState(sessionId) {
  return {
    v: ACTIVITY_STATE_VERSION,
    sessionId,
    lastSeenSeq: 0,
    lastInjectedSeq: 0,
    lastInjectedAt: null,
    injectedTurns: 0,
    resets: 0,
    lastResetAt: null,
    updatedAt: null,
  };
}

export function readActivityState(memoryRoot, sessionId) {
  const read = readJsonFile(activityStateFile(memoryRoot, sessionId));
  const value = read.ok ? read.value : null;
  if (!value || value.v !== ACTIVITY_STATE_VERSION || value.sessionId !== sessionId) {
    return emptyActivityState(sessionId);
  }
  return {
    ...emptyActivityState(sessionId),
    ...value,
    lastSeenSeq: Number.isInteger(value.lastSeenSeq) && value.lastSeenSeq >= 0 ? value.lastSeenSeq : 0,
    lastInjectedSeq: Number.isInteger(value.lastInjectedSeq) && value.lastInjectedSeq >= 0 ? value.lastInjectedSeq : 0,
    injectedTurns: Number.isInteger(value.injectedTurns) && value.injectedTurns >= 0 ? value.injectedTurns : 0,
    resets: Number.isInteger(value.resets) && value.resets >= 0 ? value.resets : 0,
  };
}

function textBlocks(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

function messageTextOf(event) {
  const data = event?.data ?? {};
  const message = data.message && typeof data.message === 'object' ? data.message : data;
  return textBlocks(message?.content);
}

function sessionIdOfMessage(session, event) {
  const raw = session?.id
    ?? session?.header?.id
    ?? event?.sessionId
    ?? '';
  if (typeof raw !== 'string') return '';
  const id = raw.trim().toLowerCase();
  return ACTIVITY_SESSION_RE.test(id) ? id : '';
}

function toolSummaryOf(data) {
  const name = oneLine(data?.name ?? 'tool');
  const args = data?.arguments;
  let snippet = '';
  if (typeof args === 'string' && args.trim() !== '') {
    let parsed = null;
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      for (const key of ['command', 'cmd', 'path', 'file_path', 'query', 'pattern', 'glob', 'description', 'prompt', 'url']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim() !== '') {
          snippet = value;
          break;
        }
      }
    }
    if (snippet === '') snippet = args;
  }
  return { name, summary: clip(oneLine(snippet), 44) };
}

function headerOf(payload) {
  const agent = payload?.agent;
  return agent?.session?.header ?? agent?.header ?? payload?.session?.header ?? {};
}

function sessionOf(payload) {
  const agent = payload?.agent;
  return agent?.session ?? payload?.session ?? null;
}

function preStepSessionId(payload) {
  const header = headerOf(payload);
  const agent = payload?.agent;
  const raw = header.id ?? agent?.sessionId ?? sessionOf(payload)?.id ?? payload?.sessionId;
  if (typeof raw !== 'string') return '';
  const id = raw.trim().toLowerCase();
  return ACTIVITY_SESSION_RE.test(id) ? id : '';
}

function normalizeOrigin(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function maxSeqOf(entries) {
  let max = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (Number.isInteger(entry?.seq) && entry.seq > max) max = entry.seq;
  }
  return max;
}

async function resolveCreateUserMessage(explicit) {
  if (typeof explicit === 'function') return explicit;
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    return typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null;
  } catch {
    return null;
  }
}

/**
 * Create the stream object. `enabled` + `memoryRoot` are the only switches;
 * everything else is a budget. Tests drive `onSessionEvent` / `maybeInject`
 * directly, which is the same path the hooks use.
 */
export function createActivityStream(options = {}) {
  const cfg = normalizeActivityConfig(options);
  // 1.8.0: thinking summaries are an independent, default-off injection switch.
  // The write side also requires it, so off is byte-for-byte the 1.7.4 behaviour.
  const thinkingInjection = options.thinkingInjection === true;
  const memoryRoot = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== ''
    ? path.resolve(options.memoryRoot)
    : null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const privacyScan = typeof options.privacyScan === 'function' ? options.privacyScan : defaultPrivacyScan;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const stats = {
    turns: 0,
    events: 0,
    written: 0,
    refreshed: 0,
    merged: 0,
    distilled: 0,
    throttled: 0,
    injected: 0,
    skipped: 0,
    privacy: 0,
    resets: 0,
    errors: 0,
    thinkingWritten: 0,
    thinkingInjected: 0,
  };
  const sessions = new Map();
  // `${sessionId}|${key}` → { at: ms, kind } — 同 key 节流 ≤1 次刷新/10s.
  const refreshes = new Map();
  const disposers = [];
  const store = memoryRoot ? createActivityStore({ memoryRoot, now, privacyScan }) : null;
  const enabled = cfg.enabled === true && store !== null;

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        turn: null,
        userText: '',
        assistantText: '',
        tool: null,
        toolCalls: 0,
        thinkingTurn: null,
        thinkingWritten: false,
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function clearSessionRefreshes(sessionId) {
    const prefix = `${sessionId}|`;
    for (const key of refreshes.keys()) {
      if (key.startsWith(prefix)) refreshes.delete(key);
    }
  }

  /**
   * Event-level write: one refresh per tool call, as 「工具：目标」.
   *
   * Same-key refreshes are throttled to one per ACTIVITY_REFRESH_THROTTLE_MS —
   * a 12-call burst must not append 12 near-identical rows. A tool error may
   * skip the window once (kind escalation to blocked), after that it throttles
   * like everything else. The store merge bumps `seq`, which is what lets the
   * consumer's seq-only cursor pick the update up.
   */
  function writeToolActivity(state, { isError = false } = {}) {
    const tool = state.tool;
    if (!tool || typeof tool.name !== 'string' || tool.name.trim() === '') {
      return { written: false, reason: 'no-tool' };
    }
    const failed = isError === true || tool.isError === true;
    const text = buildToolActivityText(tool, { isError: failed });
    if (text === '') return { written: false, reason: 'empty' };
    const key = buildActivityKey({
      userText: state.userText,
      assistantText: state.assistantText,
      tool,
    });
    const nowDate = now();
    const nowMs = nowDate.getTime();
    const refreshKey = `${state.sessionId}|${key}`;
    const last = refreshes.get(refreshKey) ?? null;
    const within = last !== null && Number.isFinite(nowMs) && nowMs - last.at < ACTIVITY_REFRESH_THROTTLE_MS;
    const escalating = failed && (last === null || last.kind !== 'blocked');
    if (within && !escalating) {
      stats.throttled += 1;
      return { written: false, reason: 'throttled' };
    }
    const kind = failed ? 'blocked' : classifyKind({ userText: state.userText, tool });
    const result = store.append(
      { sessionId: state.sessionId, kind, text, key, at: nowDate },
      { touchSeq: true, refreshText: true },
    );
    if (!result.ok) {
      if (result.code === 'E_PRIVACY') stats.privacy += 1;
      else stats.errors += 1;
      return { written: false, reason: result.code ?? 'error' };
    }
    refreshes.set(refreshKey, { at: nowMs, kind });
    if (result.action === 'distilled') stats.distilled += 1;
    else if (result.action === 'refreshed') stats.refreshed += 1;
    else if (result.action === 'merged') stats.merged += 1;
    else stats.written += 1;
    return {
      written: true,
      action: result.action,
      seq: result.seq,
      seqBumped: result.seqBumped === true,
      entry: result.entry,
    };
  }

  function writeTurn(state, reason, turn) {
    let text = buildActivityText({
      userText: state.userText,
      assistantText: state.assistantText,
      tool: state.tool,
    });
    let kind = classifyKind({
      userText: state.userText,
      assistantText: state.assistantText,
      tool: state.tool,
    });
    if (reason === 'failed') {
      kind = 'blocked';
      if (text === '') text = '回合失败（已记录为 blocked）';
    }
    if (text === '') {
      stats.skipped += 1;
      return { written: false, reason: 'empty' };
    }
    const candidate = {
      sessionId: state.sessionId,
      kind,
      text,
      key: buildActivityKey({
        userText: state.userText,
        assistantText: state.assistantText,
        tool: state.tool,
      }),
      at: now(),
    };
    // A conclusion merge also carries new information for sibling sessions:
    // bump seq and let the newest conclusion replace the turn's action text.
    const result = store.append(candidate, { touchSeq: true, refreshText: true });
    if (!result.ok) {
      if (result.code === 'E_PRIVACY') stats.privacy += 1;
      else stats.errors += 1;
      return { written: false, reason: result.code ?? 'error', turn };
    }
    if (result.action === 'distilled') stats.distilled += 1;
    else if (result.action === 'refreshed') stats.refreshed += 1;
    else if (result.action === 'merged') stats.merged += 1;
    else stats.written += 1;
    return { written: true, action: result.action, seqBumped: result.seqBumped === true, entry: result.entry, turn };
  }

  function onSessionEvent(session, event) {
    if (!enabled) return;
    try {
      const type = event?.type;
      if (typeof type !== 'string') return;
      const sessionId = sessionIdOfMessage(session, event);
      if (type === 'session/disposed') {
        if (sessionId !== '') {
          sessions.delete(sessionId);
          clearSessionRefreshes(sessionId);
        }
        return;
      }
      if (sessionId === '') return;
      const state = stateFor(sessionId);

      if (type === 'turn/start') {
        const turn = event?.data?.turn;
        state.turn = Number.isInteger(turn) ? turn : state.turn;
        state.userText = '';
        state.assistantText = '';
        state.tool = null;
        state.toolCalls = 0;
        state.thinkingTurn = null;
        state.thinkingWritten = false;
        // A new turn is new information: do not let the previous turn's 10s
        // window swallow its first tool action.
        clearSessionRefreshes(sessionId);
        return;
      }

      if (type === 'user/message') {
        if (!isUserAuthoredMessage(event)) return;
        const text = messageTextOf(event);
        if (text !== '') state.userText = text;
        return;
      }

      if (type === 'assistant/message') {
        const data = event?.data ?? {};
        const turn = data.turn;
        if (Number.isInteger(turn) && Number.isInteger(state.turn) && turn !== state.turn) return;
        const text = messageTextOf(event);
        if (text !== '') state.assistantText = text;
        // 1.8.0 thinking summaries: at most one row per session+turn; only when
        // the injection switch is on. Visible reasoning text exists or nothing
        // is written (no model call, no raw log rewrite).
        if (thinkingInjection) {
          const resolvedTurn = Number.isInteger(turn) ? turn : (Number.isInteger(state.turn) ? state.turn : null);
          const alreadyWritten = state.thinkingWritten
            && (state.thinkingTurn === resolvedTurn || resolvedTurn === null);
          if (!alreadyWritten) {
            const summary = summarizeThinking(extractThinkingText(data.message?.content));
            if (summary !== '') {
              const result = store.append(
                {
                  sessionId,
                  kind: 'thinking',
                  text: summary,
                  key: `thinking|${resolvedTurn ?? 'turn'}`,
                  at: now(),
                  turnRef: resolvedTurn,
                  charCount: charLength(summary),
                },
                { touchSeq: true, refreshText: false },
              );
              if (result.ok) {
                state.thinkingTurn = resolvedTurn;
                state.thinkingWritten = true;
                stats.thinkingWritten += 1;
              } else if (result.code === 'E_PRIVACY') {
                stats.privacy += 1;
              } else {
                stats.errors += 1;
              }
            }
          }
        }
        return;
      }

      if (type === 'tool/call') {
        state.toolCalls += 1;
        state.tool = { ...toolSummaryOf(event?.data), isError: false };
        // Event-level write: the sibling session sees the action while the
        // turn is still running (throttled inside writeToolActivity).
        stats.events += 1;
        writeToolActivity(state);
        return;
      }

      if (type === 'tool/result') {
        const data = event?.data ?? {};
        const message = data.message && typeof data.message === 'object' ? data.message : data;
        const isError = message?.isError === true || data.isError === true;
        if (isError) {
          if (!state.tool && typeof data.name === 'string' && data.name.trim() !== '') {
            state.tool = { ...toolSummaryOf(data), isError: true };
          }
          if (state.tool) {
            state.tool.isError = true;
            stats.events += 1;
            writeToolActivity(state, { isError: true });
          }
        }
        return;
      }

      if (type === 'turn/end') {
        const turn = event?.data?.turn;
        const reason = normalizeOrigin(event?.data?.reason?.kind);
        const resolved = Number.isInteger(turn) ? turn : state.turn;
        stats.turns += 1;
        if (reason === 'completed' || reason === 'failed') {
          writeTurn(state, reason, resolved);
        } else {
          stats.skipped += 1;
        }
        state.userText = '';
        state.assistantText = '';
        state.tool = null;
        state.toolCalls = 0;
        state.turn = Number.isInteger(resolved) ? resolved : null;
      }
    } catch {
      stats.errors += 1;
    }
  }

  function skip(reason) {
    stats.skipped += 1;
    return { injected: false, skipped: reason };
  }

  /**
   * One pre-step attempt. Returns {injected, skipped?, entries?}; never throws.
   */
  async function maybeInject(payload) {
    if (!enabled) return { injected: false, skipped: 'disabled' };
    if (Number(payload?.step) !== 1) return { injected: false, skipped: 'not-step-1' };
    const sessionId = preStepSessionId(payload);
    if (sessionId === '') return skip('no-session');
    if (normalizeOrigin(headerOf(payload).origin) === 'subagent') return skip('subagent');
    const messages = payload?.messages;
    if (!Array.isArray(messages)) return skip('no-messages');
    if (!messages.some((message) => isHumanMessage(message))) return skip('empty-turn');
    if (messages.some((message) => {
      const text = textOfMessage(message);
      return text.includes(ACTIVITY_HINT_MARK) || text.includes(THINKING_HINT_MARK);
    })) {
      return { injected: false, skipped: 'turn-already-injected' };
    }

    const read = store.read();
    if (!read.ok) return skip('board-unreadable');
    const state = readActivityState(memoryRoot, sessionId);
    const boardMax = maxSeqOf(read.entries);
    // Board reset (deleted/emptied/replaced-from-backup): the persisted seq-only
    // cursor can sit above every current row, so `seq > lastSeenSeq` would match
    // nothing forever. Falling back to 0 replays the current board instead of
    // stranding the sibling (RE-R15.5). The store's high-water sidecar normally
    // prevents this; this branch is the safety net for legacy/reset boards.
    const resetCursor = boardMax > 0 && state.lastSeenSeq > boardMax;
    if (resetCursor) stats.resets += 1;
    const effectiveSeen = resetCursor ? 0 : state.lastSeenSeq;
    const fresh = selectActivities(read.entries, {
      selfSessionId: sessionId,
      lastSeenSeq: effectiveSeen,
      maxItems: cfg.maxItems,
    });
    // 1.8.0: thinking summaries are selected separately and never mixed into
    // the normal activity lines (the cursor is the same lastSeenSeq).
    const freshThinking = thinkingInjection
      ? selectThinkingActivities(read.entries, {
        selfSessionId: sessionId,
        lastSeenSeq: effectiveSeen,
        maxItems: 5,
      })
      : [];
    if (fresh.length === 0 && freshThinking.length === 0) {
      return { injected: false, skipped: 'no-new', reset: resetCursor };
    }

    const allowed = [];
    for (const item of fresh) {
      try {
        const verdict = privacyScan(item.text);
        if (!verdict || verdict.verdict === 'local_only') {
          stats.privacy += 1;
          continue;
        }
      } catch {
        stats.privacy += 1;
        continue;
      }
      allowed.push(item);
    }
    const allowedThinking = [];
    for (const item of freshThinking) {
      const summary = summarizeThinking(item.text);
      if (summary === '' || !isThinkingPayloadSafe(summary)) {
        stats.privacy += 1;
        continue;
      }
      try {
        const verdict = privacyScan(summary);
        if (!verdict || verdict.verdict === 'local_only') {
          stats.privacy += 1;
          continue;
        }
      } catch {
        stats.privacy += 1;
        continue;
      }
      allowedThinking.push({ ...item, text: summary });
    }
    if (allowed.length === 0 && allowedThinking.length === 0) {
      return { injected: false, skipped: 'privacy' };
    }

    const parts = [];
    if (allowed.length > 0) {
      const rendered = renderActivityHint(allowed, {
        maxChars: cfg.injectMaxChars,
        maxItems: cfg.maxItems,
        nowMs: now().getTime(),
      });
      if (rendered.text !== '') parts.push(rendered.text);
    }
    if (allowedThinking.length > 0) {
      const thinkingText = renderThinkingHint(allowedThinking, { maxItems: 5 });
      if (thinkingText !== '') parts.push(thinkingText);
    }
    if (parts.length === 0) return skip('budget-empty');
    const text = parts.join('\n\n');

    const createUserMessage = await resolveCreateUserMessage(cfg.createUserMessage);
    if (typeof createUserMessage !== 'function') return skip('no-create-user-message');
    let message;
    try {
      message = assertInjectionSource(createUserMessage({
        role: 'user',
        content: [{ type: 'text', text }],
        source: injectionSource(),
      }));
    } catch {
      return skip('create-message-failed');
    }
    const index = insertionIndex(messages);
    if (index <= 0) return skip('no-human-message');
    try {
      messages.splice(index, 0, message);
    } catch {
      return skip('splice-failed');
    }

    const injectedItems = [...allowed, ...allowedThinking];
    const nextState = {
      ...state,
      lastSeenSeq: Math.max(effectiveSeen, maxSeqOf(read.entries)),
      lastInjectedSeq: maxSeqOf(injectedItems),
      lastInjectedAt: now().toISOString(),
      injectedTurns: state.injectedTurns + 1,
      resets: state.resets + (resetCursor ? 1 : 0),
      lastResetAt: resetCursor ? now().toISOString() : state.lastResetAt,
      updatedAt: now().toISOString(),
    };
    try {
      writeJsonAtomic(activityStateFile(memoryRoot, sessionId), nextState);
    } catch {
      /* state is an optimization; a failed write costs a repeat, not a turn */
    }
    stats.injected += 1;
    stats.thinkingInjected += allowedThinking.length;
    return {
      injected: true,
      sessionId,
      chars: charLength(text),
      reset: resetCursor,
      items: injectedItems.map((item) => ({ seq: item.seq, sessionId: item.sessionId, kind: item.kind })),
      thinkingItems: allowedThinking.length,
      text,
    };
  }

  function install(ctx) {
    if (!enabled || !ctx || typeof ctx.on !== 'function') return false;
    try {
      const dispose = ctx.on('session/event', (session, event) => onSessionEvent(session, event));
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      stats.errors += 1;
      logger(`[activity] session/event 监听注册失败：${error?.code ?? error?.message ?? error}`);
    }
    try {
      const dispose = ctx.on('agent/pre-step', async (payload, next) => {
        // B3: shared phase = shared-brain injection only (timing only).
        const sessionId = preStepSessionId(payload);
        const phase = startPrestepPhase(sessionId, payload?.turn, 'shared');
        try {
          await maybeInject(payload);
        } catch {
          stats.errors += 1;
          notePrestepDegrade(sessionId, payload?.turn, { kind: 'error', phase: 'shared', detail: 'E_ACTIVITY_PRE_STEP' });
        } finally {
          phase.end();
        }
        return typeof next === 'function' ? next() : undefined;
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      stats.errors += 1;
      logger(`[activity] agent/pre-step 监听注册失败：${error?.code ?? error?.message ?? error}`);
    }
    return true;
  }

  function dispose() {
    while (disposers.length > 0) {
      const disposer = disposers.pop();
      try {
        disposer();
      } catch {
        /* already disposed */
      }
    }
    sessions.clear();
    refreshes.clear();
  }

  return {
    enabled,
    memoryRoot,
    config: { ...cfg, thinkingInjection },
    stats,
    store,
    install,
    dispose,
    onSessionEvent,
    maybeInject,
    readState: (sessionId) => (enabled ? readActivityState(memoryRoot, sessionId) : emptyActivityState(sessionId)),
    boardFile: store?.boardFile ?? null,
  };
}

/**
 * Register the two hooks for the feature switch. A disabled stream registers
 * nothing and touches no file; a broken registration is a warning only.
 */
export function registerActivityStream(ctx, cfg = {}, options = {}) {
  const stream = createActivityStream({
    enabled: cfg.enabled !== false,
    memoryRoot: options.memoryRoot,
    injectMaxChars: cfg.injectMaxChars,
    maxItems: cfg.maxItems,
    thinkingInjection: cfg.thinkingInjection === true,
    createUserMessage: cfg.createUserMessage,
    now: options.now,
    privacyScan: options.privacyScan,
    logger: options.logger,
  });
  if (!stream.enabled) return stream;
  stream.install(ctx);
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => stream.dispose(), 'longlive.shared-brain-activity');
    } catch {
      /* a fake context may not own an effect scope */
    }
  }
  return stream;
}

export { ACTIVITY_HINT_MARK, ACTIVITY_REFRESH_THROTTLE_MS, shortSessionId, activityBoardFile };
export { THINKING_HINT_MARK, THINKING_KIND, THINKING_LINE_MAX, THINKING_MAX_ITEMS } from './thinking.js';
