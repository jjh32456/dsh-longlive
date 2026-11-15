// src/handoff/index.js — cross-session handoff card wiring (02, v4).
//
// Producer (`session/event`): after every completed turn, merge a locally
//   extracted delta (goal / decided / open / next / lastAction) into the
//   source session's per-session latest card under
//   `<memoryRoot>/.longlive/bridge/<safeSrc>.handoff-card.json`. Local rules
//   only — no model call, no session-log scan. Only user-authored messages are
//   carried (`isUserAuthoredMessage`), so an injected card can never become the
//   next card's goal ("card begets card").
//
// Consumer (`agent/pre-step`, step 1 / turn 1): read at most `maxIndexFiles`
//   latest cards, run the five gates (cwd → liveness → relevance/substance/
//   continuation-intent → budget → claim), then splice ONE hidden ≤281-code-point
//   message into the first-step payload. per-session O_EXCL claim makes it
//   once-per-session across processes; the per-card claim is pid-recoverable
//   before the splice and fail-closed afterwards. Anything unreadable/unjudgeable
//   simply does not inject (fail-closed); a turn is never blocked.
//
// Default OFF: `handoff.enabled` must be the literal boolean `true` (or the
// profile config row must carry it); `DSH_LONGLIVE_DISABLE_HANDOFF=1|true` is
// the independent kill switch. `dryRun:true` selects/audits but never claims or
// injects, so a first enablement can be watched before the real switch.

import path from 'node:path';

import { isSubagentSession } from '../identity/index.js';
import { isUserAuthoredMessage } from '../truncate-visible.js';
import { privacyScan as defaultPrivacyScan } from '../recall/privacy.mjs';
import { notePrestepDegrade, startPrestepPhase } from '../metrics/prestep-latency.mjs';
import { messageTextOf, toolSummaryOf } from '../activity/index.js';
import {
  assertInjectionSource,
  injectionSource,
  insertionIndex,
  isHumanMessage,
  isInjectedMessage,
  textOfMessage,
} from '../identity/inject-position.js';
import {
  AUDIT_SCHEMA,
  HANDOFF_ANCHOR_MAX_CHARS,
  HANDOFF_DECIDED_MAX,
  HANDOFF_FOOTER,
  HANDOFF_HEAD_RE,
  HANDOFF_INTENT_SEMANTICS,
  HANDOFF_MAX_CHARS,
  HANDOFF_MIN_CHARS,
  HANDOFF_RENDER_MAX,
  HANDOFF_SCHEMA,
  charLengthOf,
  contentHashOf,
  buildCardDelta,
  cardIdOf,
  hash8,
  isActiveSessionId,
  mergeLatestCard,
  renderHandoffCard,
  sanitizeCardFields,
  selectCandidate,
} from './model.js';
import {
  appendAudit,
  claimCard,
  claimSession,
  finalizeCardClaim,
  finalizeSessionClaim,
  handoffArchiveFile,
  handoffAuditFile,
  latestCardFile,
  markCardSpliced,
  maybeTrimAuditBoard,
  pruneCards,
  pruneClaims,
  readHandoffBoard,
  readLatestCard,
  readLatestCards,
  readLiveRow,
  releaseCardClaim,
  releaseSessionClaim,
  resetTrimThrottle,
  sessionClaimFile,
  writeLatestCardAtomic,
} from './store.js';

// ------------------------------------------------------------------ config (§8)

export const HANDOFF_DEFAULTS = Object.freeze({
  enabled: false, // hard constraint ①: never changes 1.8.3 behaviour unless opted in
  dryRun: false,
  maxChars: HANDOFF_MAX_CHARS,
  maxAgeHours: 24,
  firstTurnOnly: true,
  inject: true,
  write: true,
  decidedMax: HANDOFF_DECIDED_MAX,
  relevanceContainShort: 0.4,
  relevanceDiceLong: 0.2,
  intentBypass: true,
  intentFreshMinutes: 60,
  intentSemantics: HANDOFF_INTENT_SEMANTICS,
  maxIndexFiles: 64,
  auditWindowRows: 500,
  privacyScan: true,
  trimMinIntervalMs: 60_000,
});

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInt(value, fallback, min, max) {
  return Math.floor(clampNumber(value, fallback, min, max));
}

/**
 * Normalise the `handoff` config block. Bad values never throw (a typo cannot
 * keep the plugin from loading); `enabled` stays OFF unless it is literally
 * `true`, and the env kill switch wins over everything.
 */
export function normalizeHandoffConfig(input = {}, options = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const env = options && typeof options.env === 'object' && options.env !== null ? options.env : process.env;
  const disabledByEnv = env?.DSH_LONGLIVE_DISABLE_HANDOFF === '1' || env?.DSH_LONGLIVE_DISABLE_HANDOFF === 'true';
  const boolOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const semantics = raw.intentSemantics === 'latest' ? 'latest' : HANDOFF_INTENT_SEMANTICS;
  return {
    enabled: disabledByEnv ? false : raw.enabled === true,
    dryRun: raw.dryRun === true,
    maxChars: clampInt(raw.maxChars, HANDOFF_DEFAULTS.maxChars, HANDOFF_MIN_CHARS, HANDOFF_MAX_CHARS),
    maxAgeHours: clampInt(raw.maxAgeHours, HANDOFF_DEFAULTS.maxAgeHours, 1, 168),
    firstTurnOnly: boolOr(raw.firstTurnOnly, HANDOFF_DEFAULTS.firstTurnOnly),
    inject: boolOr(raw.inject, HANDOFF_DEFAULTS.inject),
    write: boolOr(raw.write, HANDOFF_DEFAULTS.write),
    decidedMax: clampInt(raw.decidedMax, HANDOFF_DEFAULTS.decidedMax, 1, HANDOFF_DECIDED_MAX),
    relevanceContainShort: clampNumber(raw.relevanceContainShort, HANDOFF_DEFAULTS.relevanceContainShort, 0.2, 0.8),
    relevanceDiceLong: clampNumber(raw.relevanceDiceLong, HANDOFF_DEFAULTS.relevanceDiceLong, 0.1, 0.6),
    intentBypass: boolOr(raw.intentBypass, HANDOFF_DEFAULTS.intentBypass),
    intentFreshMinutes: clampInt(raw.intentFreshMinutes, HANDOFF_DEFAULTS.intentFreshMinutes, 10, 180),
    intentSemantics: semantics,
    maxIndexFiles: clampInt(raw.maxIndexFiles, HANDOFF_DEFAULTS.maxIndexFiles, 8, 256),
    auditWindowRows: clampInt(raw.auditWindowRows, HANDOFF_DEFAULTS.auditWindowRows, 100, 2000),
    privacyScan: boolOr(raw.privacyScan, HANDOFF_DEFAULTS.privacyScan),
    trimMinIntervalMs: clampInt(raw.trimMinIntervalMs, HANDOFF_DEFAULTS.trimMinIntervalMs, 0, 3_600_000),
    createUserMessage: typeof raw.createUserMessage === 'function' ? raw.createUserMessage : undefined,
    killSwitch: disabledByEnv,
  };
}

// ------------------------------------------------------------------ small helpers

function nowFnOf(value) {
  if (typeof value === 'function') {
    return () => {
      const produced = value();
      return produced instanceof Date ? produced : new Date(Number.isFinite(produced) ? produced : Date.now());
    };
  }
  if (value instanceof Date || Number.isFinite(value)) {
    const frozen = value instanceof Date ? value.getTime() : Number(value);
    return () => new Date(frozen);
  }
  return () => new Date();
}

function headerOf(payload) {
  const agent = payload?.agent;
  return agent?.session?.header ?? agent?.header ?? payload?.session?.header ?? {};
}

function sessionObjectOf(payload) {
  const agent = payload?.agent;
  return agent?.session ?? payload?.session ?? null;
}

function preStepSessionId(payload) {
  const header = headerOf(payload);
  const agent = payload?.agent;
  const raw = header.id ?? agent?.sessionId ?? sessionObjectOf(payload)?.id ?? payload?.sessionId;
  if (typeof raw !== 'string') return '';
  const id = raw.trim().toLowerCase();
  return isActiveSessionId(id) ? id : '';
}

function sessionIdOfEvent(session, event) {
  const raw = session?.id ?? session?.header?.id ?? event?.sessionId ?? '';
  if (typeof raw !== 'string') return '';
  const id = raw.trim().toLowerCase();
  return isActiveSessionId(id) ? id : '';
}

function firstLineOf(text) {
  return String(text ?? '').trimStart().split('\n', 1)[0]?.trim() ?? '';
}

function warnOnceFactory(logger) {
  const seen = new Set();
  return (key, message) => {
    if (seen.has(key)) return;
    seen.add(key);
    try {
      logger(message);
    } catch {
      /* logging must never break a turn */
    }
  };
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

function compactTrace(trace) {
  if (!Array.isArray(trace)) return [];
  return trace.slice(0, 8).map((entry) => ({
    sessionId: entry?.sessionId ?? null,
    cardId: entry?.cardId ?? null,
    code: entry?.code ?? null,
    skipped: entry?.skipped ?? null,
    cwd: entry?.gates?.cwd === true,
    live: entry?.gates?.live ?? null,
    relevance: entry?.gates?.relevance
      ? {
        kind: entry.gates.relevance.kind,
        score: entry.gates.relevance.score,
        field: entry.gates.relevance.field,
        threshold: entry.gates.relevance.threshold,
        pass: entry.gates.relevance.pass,
        ...(entry.gates.relevance.intent ? { intent: entry.gates.relevance.intent } : {}),
      }
      : null,
  }));
}

// ------------------------------------------------------------------ stream

/**
 * Build the handoff stream. Everything is injected (memoryRoot / now /
 * privacyScan / createUserMessage / hooks) so tests drive the exact same code
 * path the host hooks use.
 */
export function createHandoffStream(options = {}) {
  const cfg = normalizeHandoffConfig(options.cfg ?? options);
  const rawRoot = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== ''
    ? options.memoryRoot
    : (typeof options.cfg?.memoryRoot === 'string' ? options.cfg.memoryRoot : null);
  let memoryRoot = null;
  try {
    memoryRoot = rawRoot === null ? null : path.resolve(rawRoot);
  } catch {
    memoryRoot = null;
  }
  const now = nowFnOf(options.now);
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const warnOnce = warnOnceFactory(logger);
  const privacyGate = cfg.privacyScan
    ? (typeof options.privacyScan === 'function' ? options.privacyScan : defaultPrivacyScan)
    : null;
  const hooks = options.hooks && typeof options.hooks === 'object' ? options.hooks : {};
  const explicitFactory = typeof options.createUserMessage === 'function'
    ? options.createUserMessage
    : (typeof cfg.createUserMessage === 'function' ? cfg.createUserMessage : undefined);
  const hook = (name) => (ctx) => {
    const fn = hooks[name];
    if (typeof fn !== 'function') return;
    fn(ctx);
  };
  const maxAgeMs = cfg.maxAgeHours * 3600 * 1000;
  const enabled = cfg.enabled === true && memoryRoot !== null;
  const sessions = new Map();
  const fired = new Set();
  const stats = {
    turns: 0,
    events: 0,
    writeOk: 0,
    writeSkip: 0,
    cards: 0,
    injected: 0,
    skipped: 0,
    skippedByCode: {},
    claims: 0,
    errors: 0,
    lastError: null,
  };

  function nowMs() {
    return now().getTime();
  }

  function countSkip(code) {
    stats.skipped += 1;
    const key = code ?? 'none';
    stats.skippedByCode[key] = (stats.skippedByCode[key] ?? 0) + 1;
  }

  function audit(op, fields) {
    try {
      return appendAudit(memoryRoot, {
        schema: AUDIT_SCHEMA,
        op,
        at: new Date(nowMs()).toISOString(),
        ...fields,
      });
    } catch (error) {
      stats.errors += 1;
      stats.lastError = { code: error?.code ?? 'E_HANDOFF_WRITE', at: new Date(nowMs()).toISOString() };
      return { ok: false, code: error?.code ?? 'E_HANDOFF_WRITE' };
    }
  }

  function auditSkip(sessionId, code, extra = {}) {
    countSkip(code);
    return audit('skip', { sessionId, code, ...extra });
  }

  function auditWriteSkip(sessionId, turn, code, card) {
    stats.writeSkip += 1;
    return audit('write-skip', {
      sessionId,
      turn,
      cardId: cardIdOf({ sessionId, turn }),
      code,
      goalChars: charLengthOf(card?.goal ?? ''),
      goalHash: hash8(card?.goal ?? ''),
      decidedN: Array.isArray(card?.decided) ? card.decided.length : 0,
      substantiveChars: card?.substantiveChars ?? 0,
    });
  }

  // ---- producer -----------------------------------------------------------

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { sessionId, turn: null, userText: '', assistantText: '', tool: null, cwd: null, completedTurns: 0 };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function produce(state, turn, atMs) {
    const cwd = typeof state.cwd === 'string' ? state.cwd.trim() : '';
    if (cwd === '') {
      warnOnce('no-cwd', '[handoff] 生产侧取不到 session.header.cwd — 本轮不写卡（E_HANDOFF_NO_CWD）。');
      return auditWriteSkip(state.sessionId, turn, 'E_HANDOFF_NO_CWD', null);
    }
    const oldRead = readLatestCard(memoryRoot, state.sessionId);
    const oldCard = oldRead.ok && oldRead.present ? oldRead.card : null;
    if (oldRead.ok === false && oldRead.present) {
      audit('write-skip', {
        sessionId: state.sessionId,
        turn,
        code: 'E_HANDOFF_CORRUPT',
        note: 'old-card-unreadable',
      });
    }
    const delta = buildCardDelta({
      turn,
      userText: state.userText,
      assistantText: state.assistantText,
      tool: state.tool,
      // `completed` here means "the assistant says the work is finished" (N10),
      // not merely "the turn ended with reason=completed".
    });
    const sanitized = sanitizeCardFields(delta, { privacyScan: privacyGate });
    const merged = mergeLatestCard(oldCard, {
      ...sanitized,
      turn,
      // completedTurns counts every completed turn of this session, including
      // the no-delta ACK turns whose card write is skipped (V3 expects 3 after
      // three completed rounds even when the middle one wrote nothing).
      completedTurns: Math.max(state.completedTurns, (oldCard?.source?.completedTurns ?? 0) + 1),
      sessionId: state.sessionId,
      cwd,
      cwdHash: hash8(cwd),
      at: new Date(atMs).toISOString(),
    });
    if (merged.replay) return { written: false, skipped: 'replay' };
    if (merged.empty) return auditWriteSkip(state.sessionId, turn, 'E_HANDOFF_EMPTY', merged.card);
    if (merged.trivial) return auditWriteSkip(state.sessionId, turn, 'E_HANDOFF_TRIVIAL', merged.card);
    if (!merged.changed) return auditWriteSkip(state.sessionId, turn, 'E_HANDOFF_NO_DELTA', merged.card);
    // Bounded maintenance rides on the write path (N3/M4).
    try { pruneCards(memoryRoot, { now: atMs, maxAgeMs }); } catch { /* best effort */ }
    try { pruneClaims(memoryRoot, { now: atMs, maxAgeMs }); } catch { /* best effort */ }
    const written = writeLatestCardAtomic(memoryRoot, merged.card);
    if (!written.ok) {
      stats.errors += 1;
      stats.lastError = { code: written.code ?? 'E_HANDOFF_WRITE', at: new Date(atMs).toISOString() };
      return audit('write', {
        sessionId: state.sessionId,
        turn,
        cardId: cardIdOf({ sessionId: state.sessionId, turn }),
        code: written.code ?? 'E_HANDOFF_WRITE',
        ok: false,
      });
    }
    stats.writeOk += 1;
    stats.cards = Math.max(stats.cards, 1);
    return audit('write', {
      sessionId: state.sessionId,
      turn,
      cardId: cardIdOf({ sessionId: state.sessionId, turn }),
      cwdHash: merged.card.source.cwdHash,
      goalChars: charLengthOf(merged.card.goal),
      goalHash: hash8(merged.card.goal),
      decidedN: merged.card.decided.length,
      substantiveChars: merged.card.substantiveChars,
      chars: merged.card.substantiveChars,
    });
  }

  function onSessionEvent(session, event) {
    if (!enabled || cfg.write !== true) return;
    try {
      const type = event?.type;
      if (typeof type !== 'string') return;
      if (isSubagentSession(session)) return; // M8/N7
      const sessionId = sessionIdOfEvent(session, event);
      if (type === 'session/disposed') {
        if (sessionId !== '') sessions.delete(sessionId);
        return;
      }
      if (sessionId === '') return;
      const state = stateFor(sessionId);
      const header = session?.header ?? session?.session?.header ?? {};
      if (typeof header.cwd === 'string' && header.cwd.trim() !== '') {
        const nextCwd = header.cwd.trim();
        if (state.cwd !== null && state.cwd !== nextCwd) {
          // E_HANDOFF_CWD_DRIFT: same session id, different cwd (abnormal). Audit
          // it and use the new value; the cwd gate compares against the card.
          audit('write-skip', { sessionId, code: 'E_HANDOFF_CWD_DRIFT' });
        }
        state.cwd = nextCwd;
      }

      if (type === 'turn/start') {
        const turn = event?.data?.turn;
        state.turn = Number.isInteger(turn) ? turn : state.turn;
        state.userText = '';
        state.assistantText = '';
        state.tool = null;
        return;
      }
      if (type === 'user/message') {
        // N9: only a host-proven user-authored message may become a card goal.
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
        return;
      }
      if (type === 'tool/call') {
        state.tool = { ...toolSummaryOf(event?.data), isError: false };
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
          if (state.tool) state.tool.isError = true;
        }
        return;
      }
      if (type === 'turn/end') {
        const turn = event?.data?.turn;
        const reason = typeof event?.data?.reason?.kind === 'string'
          ? event.data.reason.kind.trim().toLowerCase()
          : '';
        const resolved = Number.isInteger(turn) ? turn : state.turn;
        stats.turns += 1;
        if (reason === 'completed' && Number.isInteger(resolved) && resolved > 0) {
          state.completedTurns += 1;
          produce(state, resolved, nowMs());
        }
        state.userText = '';
        state.assistantText = '';
        state.tool = null;
        state.turn = Number.isInteger(resolved) ? resolved : null;
      }
    } catch (error) {
      stats.errors += 1;
      stats.lastError = { code: error?.code ?? 'E_HANDOFF_PRODUCER', at: new Date(nowMs()).toISOString() };
    }
  }

  // ---- consumer -----------------------------------------------------------

  function skipResult(skipped, decision, extra = {}) {
    const code = typeof extra.code === 'string'
      ? extra.code
      : (typeof skipped === 'string' && skipped.startsWith('E_') ? skipped : null);
    const { code: _ignored, ...rest } = extra;
    void _ignored;
    return { injected: false, skipped, code, decision, ...rest };
  }

  async function injectOnce(payload, next) {
    const pass = typeof next === 'function'
      ? next
      : async () => ({ kind: 'ok', messages: payload?.messages });
    if (!enabled || cfg.inject !== true) {
      return skipResult('disabled', await pass());
    }
    if (Number(payload?.step) !== 1) return skipResult('not-step-1', await pass());
    if (cfg.firstTurnOnly && payload?.turn !== 1) return skipResult('not-first-turn', await pass());
    const sessionId = preStepSessionId(payload);
    if (sessionId === '') return skipResult('no-session', await pass());
    if (isSubagentSession({ header: headerOf(payload) })) return skipResult('subagent', await pass());
    if (isSubagentSession(sessionObjectOf(payload))) return skipResult('subagent', await pass());
    const messages = payload?.messages;
    if (!Array.isArray(messages)) return skipResult('no-messages', await pass());
    if (fired.has(sessionId)) {
      auditSkip(sessionId, 'E_HANDOFF_ALREADY_FIRED');
      return skipResult('already-fired', await pass());
    }
    const anchorMessage = messages.find((message) => isHumanMessage(message));
    if (!anchorMessage) {
      auditSkip(sessionId, 'E_HANDOFF_NO_ANCHOR');
      notePrestepDegrade(sessionId, payload?.turn, { kind: 'handoff-skip', phase: 'handoff', detail: 'E_HANDOFF_NO_ANCHOR' });
      return skipResult('no-anchor', await pass());
    }
    const anchorText = textOfMessage(anchorMessage);
    // m6: never inject a second card into a context that already has one.
    const alreadyInContext = messages.some((message) => isInjectedMessage(message)
      && HANDOFF_HEAD_RE.test(firstLineOf(textOfMessage(message))));
    if (alreadyInContext) {
      auditSkip(sessionId, 'E_HANDOFF_ALREADY_IN_CONTEXT');
      return skipResult('already-in-context', await pass(), { code: 'E_HANDOFF_ALREADY_IN_CONTEXT' });
    }
    const header = headerOf(payload);
    const selfCwd = typeof header.cwd === 'string' ? header.cwd : '';
    const atMs = nowMs();
    const listing = readLatestCards(memoryRoot, { maxFiles: cfg.maxIndexFiles });
    if (!listing.ok) {
      auditSkip(sessionId, listing.code ?? 'E_HANDOFF_READ');
      return skipResult('read-failed', await pass());
    }
    if (listing.cards.length === 0) {
      auditSkip(sessionId, 'E_HANDOFF_NO_CARD');
      return skipResult('no-card', await pass());
    }
    const selection = selectCandidate({
      cards: listing.cards,
      selfSessionId: sessionId,
      selfCwd,
      nowMs: atMs,
      maxAgeMs,
      liveOf: (sourceSessionId) => readLiveRow(memoryRoot, sourceSessionId, { now: atMs }),
      anchorText,
      intentBypass: cfg.intentBypass,
      intentSemantics: cfg.intentSemantics,
      intentFreshMs: cfg.intentFreshMinutes * 60 * 1000,
      relevanceContainShort: cfg.relevanceContainShort,
      relevanceDiceLong: cfg.relevanceDiceLong,
    });
    const gatesForAudit = {
      candidates: compactTrace(selection.trace),
      intent: selection.intent ?? null,
    };
    if (!selection.card) {
      const code = selection.code ?? 'E_HANDOFF_IRRELEVANT';
      auditSkip(sessionId, code, {
        gates: gatesForAudit,
        targetSessionId: selection.trace?.[0]?.sessionId ?? null,
      });
      notePrestepDegrade(sessionId, payload?.turn, { kind: 'handoff-skip', phase: 'handoff', detail: code });
      return skipResult(code, await pass(), { gates: gatesForAudit });
    }
    const chosenTrace = (selection.trace ?? []).find((entry) => entry.cardId === selection.cardId) ?? null;
    const injectGates = {
      cwd: true,
      live: chosenTrace?.gates?.live ?? null,
      relevance: {
        ...selection.relevance,
        intent: selection.intent ?? null,
      },
    };
    if (cfg.dryRun) {
      audit('dry-run', {
        sessionId,
        sourceSessionId: selection.card.source.sessionId,
        cardId: selection.cardId,
        cwdHash: selection.card.source.cwdHash,
        chars: renderHandoffCard(selection.card, { maxChars: cfg.maxChars }).chars,
        gates: injectGates,
        dryRun: true,
      });
      stats.skipped += 1;
      return { injected: false, skipped: 'dry-run', dryRun: true, cardId: selection.cardId, gates: injectGates, decision: await pass() };
    }

    // gate 7: per-session unique claim.
    const sessionClaim = claimSession(memoryRoot, sessionId, { now: atMs });
    if (!sessionClaim.ok) {
      auditSkip(sessionId, sessionClaim.code ?? 'E_HANDOFF_ALREADY_CLAIMED', {
        sourceSessionId: selection.card.source.sessionId,
        cardId: selection.cardId,
      });
      notePrestepDegrade(sessionId, payload?.turn, {
        kind: 'handoff-skip',
        phase: 'handoff',
        detail: sessionClaim.code ?? 'E_HANDOFF_ALREADY_CLAIMED',
      });
      return skipResult(sessionClaim.code ?? 'E_HANDOFF_ALREADY_CLAIMED', await pass());
    }
    stats.claims += 1;
    const ranked = Array.isArray(selection.ranked) ? selection.ranked.slice(0, 8) : [];
    let lastCode = 'E_HANDOFF_ALL_CARDS_CLAIMED';
    let lastBudget = null;
    for (const candidate of ranked) {
      try {
        hook('beforeCardClaim')({ cardId: candidate.cardId, sessionId, file: candidate.file ?? null });
      } catch (error) {
        lastCode = 'E_HANDOFF_CARD_CLAIMED_OTHER';
        continue;
      }
      const cardClaim = claimCard(memoryRoot, candidate.cardId, {
        now: atMs,
        cardAtMs: candidate.atMs,
        maxAgeMs,
        cardFile: candidate.file ?? latestCardFile(memoryRoot, candidate.card.source.sessionId),
        sessionId,
      });
      if (!cardClaim.ok) {
        audit('claim', {
          sessionId,
          sourceSessionId: candidate.card.source.sessionId,
          cardId: candidate.cardId,
          code: cardClaim.code ?? 'E_ALREADY_CLAIMED',
        });
        lastCode = cardClaim.code ?? 'E_HANDOFF_ALREADY_CLAIMED';
        continue;
      }
      stats.claims += 1;
      audit('claim', {
        sessionId,
        sourceSessionId: candidate.card.source.sessionId,
        cardId: candidate.cardId,
        pid: process.pid,
      });
      const rendered = renderHandoffCard(candidate.card, { maxChars: cfg.maxChars });
      if (rendered.empty) {
        releaseCardClaim(cardClaim);
        auditSkip(sessionId, 'E_HANDOFF_EMPTY', { sourceSessionId: candidate.card.source.sessionId, cardId: candidate.cardId });
        lastCode = 'E_HANDOFF_EMPTY';
        continue;
      }
      if (rendered.chars > cfg.maxChars || rendered.withinMax !== true) {
        releaseCardClaim(cardClaim);
        lastBudget = { chars: rendered.chars, maxChars: cfg.maxChars };
        auditSkip(sessionId, 'E_HANDOFF_OVER_BUDGET', { sourceSessionId: candidate.card.source.sessionId, cardId: candidate.cardId, chars: rendered.chars });
        lastCode = 'E_HANDOFF_OVER_BUDGET';
        continue;
      }
      // Record "the payload may already contain this message" *before* the splice.
      try {
        hook('beforeSplice')({ cardId: candidate.cardId, sessionId, file: candidate.file ?? null });
      } catch (error) {
        // In-process failure before the splice evidence exists: the card claim is
        // safely releasable (nothing was spliced), so try the next candidate.
        releaseCardClaim(cardClaim);
        lastCode = error?.code ?? 'E_HANDOFF_WRITE';
        continue;
      }
      const spliced = markCardSpliced(cardClaim, { now: atMs, sessionId });
      if (!spliced.ok) {
        releaseCardClaim(cardClaim);
        lastCode = spliced.code ?? 'E_HANDOFF_WRITE';
        continue;
      }
      const factory = await resolveCreateUserMessage(explicitFactory);
      if (typeof factory !== 'function') {
        releaseCardClaim(cardClaim);
        releaseSessionClaim(sessionClaim);
        auditSkip(sessionId, 'E_HANDOFF_NO_FACTORY', { sourceSessionId: candidate.card.source.sessionId, cardId: candidate.cardId });
        return skipResult('no-factory', await pass());
      }
      let message;
      try {
        message = assertInjectionSource(factory({
          role: 'user',
          content: [{ type: 'text', text: rendered.text }],
          source: injectionSource(),
        }));
      } catch {
        releaseCardClaim(cardClaim);
        releaseSessionClaim(sessionClaim);
        auditSkip(sessionId, 'E_HANDOFF_INJECT_REJECTED', { sourceSessionId: candidate.card.source.sessionId, cardId: candidate.cardId });
        return skipResult('create-message-failed', await pass());
      }
      const index = insertionIndex(messages);
      if (index <= 0) {
        releaseCardClaim(cardClaim);
        releaseSessionClaim(sessionClaim);
        auditSkip(sessionId, 'E_HANDOFF_NO_ANCHOR', { sourceSessionId: candidate.card.source.sessionId, cardId: candidate.cardId });
        return skipResult('no-human-message', await pass());
      }
      try {
        messages.splice(index, 0, message);
      } catch {
        releaseCardClaim(cardClaim);
        releaseSessionClaim(sessionClaim);
        auditSkip(sessionId, 'E_HANDOFF_WRITE', { sourceSessionId: candidate.card.source.sessionId, cardId: candidate.cardId });
        return skipResult('splice-failed', await pass());
      }
      const withdraw = () => {
        const at = messages.indexOf(message);
        if (at !== -1) messages.splice(at, 1);
      };
      let decision;
      try {
        decision = await pass();
      } catch (error) {
        withdraw();
        releaseCardClaim(cardClaim);
        releaseSessionClaim(sessionClaim);
        audit('release', {
          sessionId,
          sourceSessionId: candidate.card.source.sessionId,
          cardId: candidate.cardId,
          code: 'E_HANDOFF_INJECT_REJECTED',
        });
        throw error;
      }
      if (!decision || decision.kind === 'reject') {
        withdraw();
        releaseCardClaim(cardClaim);
        releaseSessionClaim(sessionClaim);
        audit('release', {
          sessionId,
          sourceSessionId: candidate.card.source.sessionId,
          cardId: candidate.cardId,
          code: 'E_HANDOFF_INJECT_REJECTED',
        });
        return skipResult('rejected', decision);
      }
      // ---- accept boundary: finalize failures are warnings, never releases ----
      fired.add(sessionId);
      stats.injected += 1;
      let finalizeFailure = null;
      try {
        hook('beforeFinalize')({ cardId: candidate.cardId, sessionId, file: candidate.file ?? null });
      } catch (error) {
        finalizeFailure = { code: error?.code ?? 'E_HANDOFF_FINALIZE', claimState: 'spliced' };
      }
      if (finalizeFailure === null) {
        const sessionFinal = finalizeSessionClaim(sessionClaim, {
          now: atMs,
          cardId: candidate.cardId,
          sourceSessionId: candidate.card.source.sessionId,
          chars: rendered.chars,
        });
        if (!sessionFinal.ok) finalizeFailure = { code: sessionFinal.code ?? 'E_HANDOFF_FINALIZE', claimState: 'claimed' };
      }
      if (finalizeFailure === null) {
        const cardFinal = finalizeCardClaim(cardClaim, { now: atMs, sessionId });
        if (!cardFinal.ok) finalizeFailure = { code: cardFinal.code ?? 'E_HANDOFF_FINALIZE', claimState: 'spliced' };
      }
      if (finalizeFailure !== null) {
        stats.errors += 1;
        stats.lastError = { code: finalizeFailure.code, at: new Date(atMs).toISOString() };
        warnOnce(`finalize-failed:${candidate.cardId}`, `[handoff] finalize 失败（${finalizeFailure.code}）：占位 claim 保留，不释放。`);
        audit('finalize-failed', {
          sessionId,
          sourceSessionId: candidate.card.source.sessionId,
          cardId: candidate.cardId,
          claimState: finalizeFailure.claimState,
          code: finalizeFailure.code,
        });
      }
      audit('inject', {
        sessionId,
        sourceSessionId: candidate.card.source.sessionId,
        cardId: candidate.cardId,
        cwdHash: candidate.card.source.cwdHash,
        chars: rendered.chars,
        gates: injectGates,
        pid: process.pid,
      });
      return { injected: true, decision, cardId: candidate.cardId, chars: rendered.chars, gates: injectGates, intent: selection.intent ?? null };
    }
    // nothing could be claimed/rendered → no message was injected, release is safe.
    releaseSessionClaim(sessionClaim);
    auditSkip(sessionId, 'E_HANDOFF_ALL_CARDS_CLAIMED', { gates: gatesForAudit, ...(lastBudget ? { budget: lastBudget } : {}) });
    notePrestepDegrade(sessionId, payload?.turn, { kind: 'handoff-skip', phase: 'handoff', detail: lastCode });
    return skipResult('all-claimed', await pass(), { code: 'E_HANDOFF_ALL_CARDS_CLAIMED', lastCode });
  }

  async function maybeInject(payload, next) {
    try {
      return await injectOnce(payload, next);
    } catch (error) {
      const sessionId = preStepSessionId(payload);
      stats.errors += 1;
      stats.lastError = { code: error?.code ?? 'E_HANDOFF_PRE_STEP', at: new Date(nowMs()).toISOString() };
      notePrestepDegrade(sessionId, payload?.turn, { kind: 'handoff-skip', phase: 'handoff', detail: error?.code ?? 'E_HANDOFF_PRE_STEP' });
      throw error;
    }
  }

  // ---- wiring -------------------------------------------------------------

  const disposers = [];

  function install(ctx) {
    if (!enabled || !ctx || typeof ctx.on !== 'function') return false;
    // Startup: bounded board + expired cards/claims (never blocks loading).
    try {
      resetTrimThrottle();
      maybeTrimAuditBoard(memoryRoot, { now: nowMs(), minIntervalMs: 0, windowRows: cfg.auditWindowRows });
    } catch { /* best effort */ }
    try { pruneCards(memoryRoot, { now: nowMs(), maxAgeMs }); } catch { /* best effort */ }
    try { pruneClaims(memoryRoot, { now: nowMs(), maxAgeMs }); } catch { /* best effort */ }
    try {
      const dispose = ctx.on('session/event', (session, event) => onSessionEvent(session, event));
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      stats.errors += 1;
      logger(`[handoff] session/event 监听注册失败：${error?.code ?? error?.message ?? error}`);
    }
    try {
      const dispose = ctx.on('agent/pre-step', async (payload, next) => {
        const sessionId = preStepSessionId(payload);
        const phase = startPrestepPhase(sessionId, payload?.turn, 'handoff');
        try {
          const result = await injectOnce(payload, next);
          return result?.decision;
        } catch (error) {
          stats.errors += 1;
          stats.lastError = { code: error?.code ?? 'E_HANDOFF_PRE_STEP', at: new Date(nowMs()).toISOString() };
          notePrestepDegrade(sessionId, payload?.turn, {
            kind: 'handoff-skip',
            phase: 'handoff',
            detail: error?.code ?? 'E_HANDOFF_PRE_STEP',
          });
          throw error;
        } finally {
          try { phase.end(); } catch { /* timing only */ }
        }
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      stats.errors += 1;
      logger(`[handoff] agent/pre-step 监听注册失败：${error?.code ?? error?.message ?? error}`);
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
    fired.clear();
  }

  return {
    enabled,
    memoryRoot,
    config: { ...cfg },
    stats,
    install,
    dispose,
    onSessionEvent,
    maybeInject,
    injectOnce,
    prune: () => {
      const now = nowMs();
      const cards = pruneCards(memoryRoot, { now, maxAgeMs });
      const claims = pruneClaims(memoryRoot, { now, maxAgeMs });
      const trim = maybeTrimAuditBoard(memoryRoot, { now, minIntervalMs: 0, windowRows: cfg.auditWindowRows });
      return { cards, claims, trim };
    },
    paths: {
      audit: handoffAuditFile(memoryRoot),
      archive: (monthKey) => handoffArchiveFile(memoryRoot, monthKey),
      card: (sessionId) => latestCardFile(memoryRoot, sessionId),
      sessionClaim: (sessionId) => sessionClaimFile(memoryRoot, sessionId),
    },
    board: () => {
      try {
        return readHandoffBoard(memoryRoot, { now: nowMs() });
      } catch {
        return { present: false, rows: [], counts: {}, cards: [] };
      }
    },
  };
}



// ------------------------------------------------------------------ wiring helper

/**
 * Register the handoff feature. Mirrors `registerActivityStream`: a disabled
 * stream registers nothing, reads nothing and logs nothing.
 */
export function registerHandoffCard(ctx, cfg = {}, options = {}) {
  const stream = createHandoffStream({
    cfg,
    memoryRoot: options.memoryRoot,
    now: options.now,
    privacyScan: options.privacyScan,
    createUserMessage: cfg.createUserMessage ?? options.createUserMessage,
    hooks: options.hooks,
    logger: options.logger,
  });
  if (!stream.enabled) return stream;
  if (typeof ctx?.on !== 'function') return stream;
  stream.install(ctx);
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => stream.dispose(), 'longlive.handoff-card');
    } catch {
      /* a fake context may not own an effect scope */
    }
  }
  return stream;
}

export { HANDOFF_MAX_CHARS, HANDOFF_MIN_CHARS, HANDOFF_RENDER_MAX, HANDOFF_FOOTER, HANDOFF_SCHEMA };
