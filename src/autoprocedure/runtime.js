// src/autoprocedure/runtime.js — autoProcedure 编排（v0.3 §3.1 调度 / §3.6 并发）。
//
// 生命周期：
//   registerAutoProcedure()：`enabled:false` 时立即返回（零注册、零读盘、零定时器）；
//   `session/event` 的 turn/end 回调只做字段过滤 + schedule()，绝不解析、绝不 IO；
//   真正的采样/蒸馏/写盘在 setTimeout(0..delayMs) 的异步 drain 里。
//
// 每会话一个可重置定时器（新 turn/end 重排），`ctx.effect` 负责清理；同一时刻
// 最多 1 个 drain（staging 目录下的 `.autoprocedure.drain.lock` 第二 key）。
// 重启丢队列是可接受损失（stalled 计数兜底）。
//
// 每个 drain 是一次「尝试」：先写 `sample` 账本行，最后恰好写一行终态
// （draft / reject / stale 之一，N3）。失败原因可枚举，绝不静默。

import {
  AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES,
} from './config.js';
import { autoProcedurePaths } from './paths.js';
import { makeRunId, autoProcedureHolder, acquireWithRetry, releaseSafe } from './locks.js';
import {
  makeLedgerRow, appendLedgerRow, readLedgerRows,
  draftsToday, llmUsageToday, evaluateStalled,
} from './ledger.js';
import {
  readSessionFile, findTurnSample, AutoProcedureSampleError, SAMPLE_CODES,
} from './session-reader.js';
import { buildRuleDraft } from './rules.js';
import { verifyEvidence, verifyEvidenceSet } from './evidence.js';
import { runLocalLint } from './lint.js';
import { sanitizeFragment, sanitizeCandidateBody } from './privacy.js';
import {
  buildSidecar, writeCandidate, applyRetention, listStagedCandidates, composeSectionsText,
} from './candidate.js';
import { buildLlmPrompt, callLlmOnce, parseLlmCandidateOutput, reserveLlmBudget } from './llm.js';
import { normalizeAutoProcedureConfig } from './config.js';
import { dayString } from '../memory/frontmatter.js';

export const SPOT_CHECK_LIMIT = 5;
export const SPOT_CHECK_SKIP_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function warn(logger, message) {
  try {
    if (typeof logger?.warn === 'function') logger.warn(`[autoprocedure] ${message}`);
    else if (typeof logger === 'function') logger(message);
  } catch {
    /* a log line must never be the reason a turn fails */
  }
}

function toDate(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  } catch {
    return new Date();
  }
}

function msOf(now) {
  return toDate(now).getTime();
}

function mapErrorReason(error) {
  if (error instanceof AutoProcedureSampleError) {
    return error.code === SAMPLE_CODES.TOO_BIG ? 'too_big' : 'parse';
  }
  return 'io';
}

/**
 * Create the runtime object. Pure: does not touch the disk.
 * `enabled:false` leaves memoryRoot null so even an accidental call cannot read.
 */
export function createAutoProcedureRuntime({
  config = {},
  memoryRoot = null,
  home = null,
  now = () => new Date(),
  logger = null,
  deps = {},
} = {}) {
  const normalized = normalizeAutoProcedureConfig(config);
  const cfg = normalized.config;
  const runtime = {
    enabled: cfg.enabled,
    registered: false,
    config: cfg,
    warnings: normalized.warnings,
    memoryRoot: cfg.enabled && typeof memoryRoot === 'string' && memoryRoot.trim() !== '' ? memoryRoot.trim() : null,
    home: typeof home === 'string' && home !== '' ? home : null,
    now,
    logger,
    deps,
    ctx: null,
    states: new Map(),
    lastError: null,
    ackWritten: false,
    retentionDone: false,
    lastRetentionDay: null,
  };
  initializeRuntime(runtime);
  return runtime;
}

function initializeRuntime(runtime) {
  const deps = runtime.deps ?? {};
  const setTimeoutFn = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout;
  const clearTimeoutFn = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

  function stateFor(sessionId) {
    let state = runtime.states.get(sessionId);
    if (!state) {
      state = { timer: null, lastActivityAt: 0, lastTurn: null, drains: 0 };
      runtime.states.set(sessionId, state);
    }
    return state;
  }

  function clearTimer(state) {
    if (!state?.timer) return;
    try {
      clearTimeoutFn(state.timer);
    } catch {
      /* timer may already have fired */
    }
    state.timer = null;
  }

  function schedule(sessionId, turn) {
    if (!runtime.enabled || !runtime.registered) return null;
    const state = stateFor(sessionId);
    // D1/BLK-2: scheduling must NOT advance the idle clock — only a real
    // turn/end does (see onSessionEvent). Otherwise delayMs < idleMs would
    // re-arm forever and never sample.
    if (Number.isInteger(turn) && turn > 0) state.lastTurn = turn;
    clearTimer(state);
    const timer = setTimeoutFn(() => {
      state.timer = null;
      Promise.resolve()
        .then(() => runtime.drain(sessionId))
        .catch((error) => {
          runtime.lastError = String(error?.message ?? error);
        });
    }, Math.max(0, runtime.config.delayMs));
    if (typeof timer?.unref === 'function') timer.unref();
    state.timer = timer;
    return timer;
  }

  async function sampleWithRetry(sessionId) {
    const readFn = typeof deps.readSessionFile === 'function' ? deps.readSessionFile : readSessionFile;
    // D7: the cap is user-configurable (config.maxDecompressBytes) with a hard
    // ceiling in config.js; deps.maxDecompressedBytes stays as a test override.
    const configured = Number.isInteger(runtime.config.maxDecompressBytes) && runtime.config.maxDecompressBytes > 0
      ? runtime.config.maxDecompressBytes
      : AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES;
    const maxBytes = Number.isInteger(deps.maxDecompressedBytes) && deps.maxDecompressedBytes > 0
      ? deps.maxDecompressedBytes
      : configured;
    let lastError = null;
    // retry ≤1 (F3): a transient read/parse miss gets one more chance; too_big/oob does not.
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      try {
        return await readFn({
          home: runtime.home,
          sessionId,
          maxBytes,
          readFile: typeof deps.readFile === 'function' ? deps.readFile : null,
        });
      } catch (error) {
        lastError = error;
        if (error instanceof AutoProcedureSampleError && error.code === SAMPLE_CODES.TOO_BIG) throw error;
        if (error instanceof AutoProcedureSampleError && error.code === SAMPLE_CODES.MISSING) {
          // A file that does not exist yet is not retried forever: one retry only.
          if (attempt >= 1) throw error;
          continue;
        }
        if (attempt >= 1) throw error;
      }
    }
    throw lastError;
  }

  async function ensureLlmAck() {
    if (runtime.ackWritten || !runtime.config.llm.enabled) return false;
    runtime.ackWritten = true;
    appendLedgerRow({
      memoryRoot: runtime.memoryRoot,
      row: makeLedgerRow({
        kind: 'llm_enable_ack',
        model: null,
        now: runtime.now,
      }),
      now: toDate(runtime.now),
      append: typeof deps.appendLedger === 'function' ? deps.appendLedger : null,
    });
    return true;
  }

  function secondPrivacyGate(draft) {
    const options = { memoryRoot: runtime.memoryRoot ?? '', home: runtime.home ?? '' };
    const next = { ...draft, sections: { ...draft.sections } };
    const parts = [
      ['when', draft.sections.when],
      ['failureModes', draft.sections.failureModes],
      ['example', draft.sections.example],
    ];
    for (const [key, value] of parts) {
      const sanitized = sanitizeFragment(value, options);
      if (!sanitized.ok) return { ok: false, code: 'E_AP_PRIVACY_BODY', reasons: sanitized.reasons };
      next.sections[key] = sanitized.text;
    }
    const steps = [];
    for (const step of Array.isArray(draft.sections.steps) ? draft.sections.steps : []) {
      const sanitized = sanitizeFragment(step, options);
      if (!sanitized.ok) return { ok: false, code: 'E_AP_PRIVACY_BODY', reasons: sanitized.reasons };
      steps.push(sanitized.text);
    }
    if (steps.length === 0) return { ok: false, code: 'E_AP_NO_STEPS' };
    next.sections.steps = steps;
    const trigger = [];
    for (const word of Array.isArray(draft.trigger) ? draft.trigger : []) {
      const sanitized = sanitizeFragment(word, options);
      if (sanitized.ok && sanitized.text.trim() !== '') trigger.push(sanitized.text.trim());
    }
    if (trigger.length === 0) return { ok: false, code: 'E_AP_PRIVACY_TRIGGER' };
    next.trigger = trigger.slice(0, 5);
    const bodyGate = sanitizeCandidateBody(composeSectionsText(next.sections), options);
    if (!bodyGate.ok) return { ok: false, code: 'E_AP_PRIVACY_BODY', reasons: bodyGate.reasons };
    return { ok: true, draft: next };
  }

  async function maybePolish(draft, attemptId, sessionId, turn) {
    await ensureLlmAck();
    const appendRow = (row) => appendLedgerRow({
      memoryRoot: runtime.memoryRoot,
      row: makeLedgerRow({ ...row, attemptId, sessionId, turn, kind: 'llm', now: runtime.now }),
      now: toDate(runtime.now),
      append: typeof deps.appendLedger === 'function' ? deps.appendLedger : null,
    });
    // MAJ-5: 预算拒绝与 provider 失败都只影响「这一轮能否润色」，不影响「这一轮能否
    // 产出候选」。任何 LLM 侧的拒绝/失败都回落到本地 rules 草稿并如实记账，保证
    // 开启 B 模式后的候选数 >= 同配置 A 模式（开 B 只会更好、不会更少）。
    // `dailyLlmCalls` 统计的是真实 provider 调用尝试（成功、超时、不可用都算，预算
    // 拒绝本身不计），它与候选产出解耦：预算耗尽后只是不再调模型，本地草稿照常产。
    const fallbackToRules = (reason) => {
      appendRow({ reason, tokens: { in: 0, out: 0 }, model: null });
      return {
        stop: false,
        draft: { ...draft, generator: 'rules' },
        llm: { used: true, model: null, tokens: { in: 0, out: 0 } },
        llmNote: reason,
      };
    };
    const prompt = buildLlmPrompt({ sections: draft.sections, trigger: draft.trigger });
    if (!prompt.ok) {
      // Prompt 隐私门属于安全 fail-closed：宁可不润色也不把可疑文本送进模型。
      // 该分支不写 llm 行（没有发生 provider 调用），按 reject privacy 收口。
      return { stop: true, reason: 'privacy', detail: { code: prompt.code } };
    }
    const ledger = readLedgerRows(runtime.memoryRoot);
    if (!ledger.ok) return { stop: true, reason: 'io' };
    const usage = llmUsageToday(ledger.rows, { now: toDate(runtime.now) });
    const reserved = reserveLlmBudget({ usage, estimate: prompt.estimate, config: runtime.config.llm });
    if (!reserved.ok) return fallbackToRules('budget');
    const result = await callLlmOnce({
      ctx: runtime.ctx,
      prompt,
      timeoutMs: typeof deps.llmTimeoutMs === 'number' && deps.llmTimeoutMs > 0 ? deps.llmTimeoutMs : undefined,
      setTimeoutFn: typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout,
      clearTimeoutFn: typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout,
      now: runtime.now,
    });
    if (!result.ok) {
      const reason = result.code === 'E_LLM_TIMEOUT' ? 'llm_timeout' : 'llm_unavailable';
      // BLK-1/MAJ-5: enabling B must never lose the local draft. A provider failure
      // is booked on the `llm` row, then we fall back to the rules draft (never a
      // reject) so B mode can only add polish, not remove candidates.
      return fallbackToRules(reason);
    }
    appendRow({ reason: null, tokens: result.tokens, model: result.model });
    const parsed = parseLlmCandidateOutput(result.text);
    const llm = { used: true, model: result.model ?? null, tokens: result.tokens ?? { in: 0, out: 0 } };
    if (!parsed.ok) {
      // A malformed model answer never becomes a half-card: keep the local draft.
      return { stop: false, draft: { ...draft, generator: 'rules' }, llm, llmNote: parsed.code };
    }
    return { stop: false, draft: { ...draft, sections: parsed.sections, generator: 'llm' }, llm };
  }

  async function attempt({ sessionId, turn, attemptId }) {
    runtime.lastError = null;
    const sample = await sampleWithRetry(sessionId);
    const parsed = sample?.parsed;
    const turnSample = findTurnSample(parsed, turn);
    if (!turnSample) {
      throw new AutoProcedureSampleError(SAMPLE_CODES.TURN, `会话里找不到第 ${turn} 轮`);
    }
    const buildDraft = typeof deps.buildDraft === 'function' ? deps.buildDraft : buildRuleDraft;
    const built = await buildDraft({
      sessionId,
      turn,
      parsed,
      turnSample,
      minToolCalls: runtime.config.minToolCalls,
      memoryRoot: runtime.memoryRoot,
      home: runtime.home,
      now: toDate(runtime.now),
      readFile: typeof deps.readFile === 'function' ? deps.readFile : null,
    });
    if (!built?.eligible || !built.draft) {
      return {
        ok: false,
        reason: 'ineligible',
        detail: { ineligible: built?.reason ?? 'unknown', stats: built?.stats ?? null },
        dropped: built?.stats?.privacyDropped > 0 ? { privacy: built.stats.privacyDropped } : null,
      };
    }
    let draft = built.draft;
    let llmInfo = { used: false, model: null, tokens: { in: 0, out: 0 } };
    if (runtime.config.llm.enabled) {
      const polished = await maybePolish(draft, attemptId, sessionId, turn);
      if (polished.stop) {
        return { ok: false, reason: polished.reason, detail: polished.detail ?? null, dropped: null };
      }
      draft = polished.draft;
      llmInfo = polished.llm ?? llmInfo;
    }
    const gated = secondPrivacyGate(draft);
    if (!gated.ok) {
      return { ok: false, reason: 'privacy', detail: { code: gated.code }, dropped: { privacy: 1 } };
    }
    draft = gated.draft;
    const verification = verifyEvidenceSet(draft.evidence, {
      parsed,
      memoryRoot: runtime.memoryRoot,
      readFile: typeof deps.readFile === 'function' ? deps.readFile : null,
    });
    if (!verification.ok) {
      return { ok: false, reason: 'evidence', detail: { code: verification.code }, dropped: null };
    }
    const lint = runLocalLint({
      memoryRoot: runtime.memoryRoot,
      candidate: draft,
      evidenceResults: verification.results,
      at: toDate(runtime.now).toISOString(),
    });
    const risk = lint.issues.some((issue) => issue.code === 'DANGEROUS_ACTION') ? 'high' : 'low';
    const sidecar = buildSidecar({
      slug: draft.slug,
      createdAt: toDate(runtime.now).toISOString(),
      risk,
      generator: draft.generator,
      source: draft.source,
      evidence: draft.evidence,
      llm: llmInfo,
      lint,
      retentionDays: runtime.config.retentionDays,
      now: toDate(runtime.now),
    });
    const paths = autoProcedurePaths(runtime.memoryRoot);
    const holder = autoProcedureHolder({ runId: attemptId, sessionId });
    const staging = await acquireWithRetry({
      lockFile: paths.stagingLock,
      holder,
      sleep,
      acquire: typeof deps.acquireLease === 'function' ? deps.acquireLease : undefined,
      now: typeof deps.nowForLock === 'function' ? deps.nowForLock : undefined,
    });
    if (!staging.ok) {
      return { ok: false, reason: 'lock', detail: { code: staging.code }, dropped: null };
    }
    try {
      const written = writeCandidate({
        memoryRoot: runtime.memoryRoot,
        candidate: {
          name: draft.name,
          trigger: draft.trigger,
          salience: draft.salience,
          strength: draft.strength,
          lastUsed: draft.lastUsed,
          sections: draft.sections,
        },
        sidecar,
        now: toDate(runtime.now),
      });
      if (!written.ok) return { ok: false, reason: 'io', detail: { code: written.code, message: written.detail }, dropped: null };
      const dropped = built.stats?.privacyDropped > 0 ? { privacy: built.stats.privacyDropped } : null;
      return {
        ok: true,
        row: {
          candidateSlug: written.slug,
          generator: draft.generator,
          model: llmInfo.model ?? null,
          // Tokens are booked on the `llm` row only; the terminal row keeps zeros
          // so the ledger sum is not double-counted (D6)。
          tokens: { in: 0, out: 0 },
          dropped,
          lintVerdict: lint.verdict,
        },
      };
    } finally {
      releaseSafe(paths.stagingLock, holder);
    }
  }

  async function drain(sessionId) {
    if (!runtime.enabled || !runtime.registered) return { ok: false, code: 'E_AP_DISABLED' };
    const state = stateFor(sessionId);
    const nowMs = msOf(runtime.now);
    // D1/BLK-2: idle is measured from the last REAL turn/end (lastActivityAt),
    // never from a schedule. drain re-arms with schedule(), which no longer
    // moves the clock, so the remaining time strictly decreases and the next
    // fire actually samples (delayMs < idleMs included).
    if (runtime.config.idleMs > 0 && state.lastActivityAt > 0) {
      const remaining = runtime.config.idleMs - (nowMs - state.lastActivityAt);
      if (remaining > 0) {
        schedule(sessionId, state.lastTurn);
        return { ok: false, code: 'E_AP_IDLE_REARM', remaining };
      }
    }
    const turn = state.lastTurn;
    if (!Number.isInteger(turn) || turn < 1) return { ok: false, code: 'E_AP_NO_TURN' };
    const runId = makeRunId(runtime.now, typeof deps.random === 'function' ? deps.random : Math.random);
    const attemptId = `${sessionId}:${turn}:${runId}`;
    const appendRow = (row) => appendLedgerRow({
      memoryRoot: runtime.memoryRoot,
      row: makeLedgerRow({ ...row, attemptId, sessionId, turn, now: runtime.now }),
      now: toDate(runtime.now),
      append: typeof deps.appendLedger === 'function' ? deps.appendLedger : null,
    });
    let terminal = false;
    const finish = (kind, extra = {}) => {
      if (terminal) return;
      terminal = true;
      appendRow({ kind, reason: extra.reason ?? null, candidateSlug: extra.candidateSlug ?? null, generator: extra.generator ?? null, tokens: extra.tokens ?? null, model: extra.model ?? null, dropped: extra.dropped ?? null });
    };
    try {
      state.drains += 1;
      // N3: one sample row per attempt, always.
      appendRow({ kind: 'sample' });
      const ledger = readLedgerRows(runtime.memoryRoot);
      if (!ledger.ok) {
        finish('reject', { reason: 'io' });
        return { ok: false, code: 'E_AP_LEDGER_READ' };
      }
      const today = draftsToday(ledger.rows, { now: toDate(runtime.now) });
      if (today.total >= runtime.config.dailyCandidates) {
        finish('reject', { reason: 'quota', detail: undefined });
        return { ok: false, code: 'E_AP_DAILY_QUOTA', detail: { total: today.total } };
      }
      if ((today.bySession.get(sessionId) ?? 0) >= runtime.config.perSessionCandidates) {
        finish('reject', { reason: 'quota' });
        return { ok: false, code: 'E_AP_SESSION_QUOTA' };
      }
      const paths = autoProcedurePaths(runtime.memoryRoot);
      const holder = autoProcedureHolder({ runId, sessionId });
      const lock = await acquireWithRetry({
        lockFile: paths.drainLock,
        holder,
        sleep,
        acquire: typeof deps.acquireLease === 'function' ? deps.acquireLease : undefined,
      });
      if (!lock.ok) {
        finish('reject', { reason: 'lock', detail: { code: lock.code } });
        return { ok: false, code: lock.code, attempts: lock.attempts };
      }
      try {
        const outcome = await attempt({ sessionId, turn, attemptId });
        if (outcome.ok) {
          finish('draft', outcome.row);
          return { ok: true, attemptId, ...outcome.row };
        }
        finish('reject', {
          reason: outcome.reason,
          dropped: outcome.dropped ?? null,
        });
        return { ok: false, attemptId, reason: outcome.reason, detail: outcome.detail ?? null };
      } finally {
        releaseSafe(paths.drainLock, holder);
      }
    } catch (error) {
      runtime.lastError = String(error?.message ?? error);
      finish('reject', { reason: mapErrorReason(error) });
      const reason = mapErrorReason(error);
      return { ok: false, attemptId, reason, error: runtime.lastError };
    } finally {
      // F5: stalled evaluation point — in the async hook, reads only the ledger tail.
      try {
        evaluateStalled({ memoryRoot: runtime.memoryRoot, enabled: runtime.enabled, now: toDate(runtime.now) });
      } catch (error) {
        runtime.lastError = String(error?.message ?? error);
      }
      // Retention: at most once per local day, even if the host never restarts.
      try {
        const today = dayString(toDate(runtime.now));
        if (runtime.lastRetentionDay !== today) {
          runtime.lastRetentionDay = today;
          applyRetention({ memoryRoot: runtime.memoryRoot, now: toDate(runtime.now), retentionDays: runtime.config.retentionDays });
        }
      } catch (error) {
        runtime.lastError = String(error?.message ?? error);
      }
    }
  }

  async function start() {
    if (!runtime.enabled || !runtime.memoryRoot) return { ok: false, code: 'E_AP_DISABLED' };
    const out = { ok: true, ackWritten: false, retention: null, spotCheck: null, stalled: null };
    try {
      if (!runtime.retentionDone) {
        runtime.retentionDone = true;
        runtime.lastRetentionDay = dayString(toDate(runtime.now));
        out.retention = applyRetention({ memoryRoot: runtime.memoryRoot, now: toDate(runtime.now), retentionDays: runtime.config.retentionDays });
      }
    } catch (error) {
      warn(runtime.logger, `候选保留期检查失败：${error?.message ?? error}`);
    }
    try {
      out.ackWritten = await ensureLlmAck();
    } catch (error) {
      warn(runtime.logger, `llm_enable_ack 写入失败：${error?.message ?? error}`);
    }
    try {
      out.spotCheck = await spotCheckCandidates({
        memoryRoot: runtime.memoryRoot,
        home: runtime.home,
        now: toDate(runtime.now),
        limit: SPOT_CHECK_LIMIT,
        readFile: typeof deps.readFile === 'function' ? deps.readFile : null,
        readSessionFile: typeof deps.readSessionFile === 'function' ? deps.readSessionFile : readSessionFile,
      });
    } catch (error) {
      warn(runtime.logger, `候选证据抽查失败：${error?.message ?? error}`);
    }
    try {
      out.stalled = evaluateStalled({ memoryRoot: runtime.memoryRoot, enabled: runtime.enabled, now: toDate(runtime.now) });
    } catch (error) {
      warn(runtime.logger, `stalled 评估失败：${error?.message ?? error}`);
    }
    return out;
  }

  function dispose() {
    for (const state of runtime.states.values()) clearTimer(state);
    runtime.states.clear();
    runtime.registered = false;
  }

  function onSessionEvent(session, event) {
    // Contract: this callback only reads cheap event fields and calls schedule().
    // No parsing, no fs, no JSON, no locks.
    try {
      if (!runtime.enabled || !runtime.registered) return;
      if (event?.type !== 'turn/end') return;
      const data = event?.data ?? {};
      const kind = typeof data.reason?.kind === 'string' ? data.reason.kind.trim().toLowerCase() : '';
      if (kind !== 'completed') return;
      // F12 + N2: exclude router-origin turns in both observed shapes.
      if (data.origin === 'router' || data.task?.origin === 'router') return;
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (sessionId === '') return;
      const turn = Number.isInteger(data.turn) ? data.turn : null;
      // D1/BLK-2: the idle clock advances ONLY on a real, completed, non-router
      // turn/end. schedule() never touches it, so a re-armed drain cannot starve.
      stateFor(sessionId).lastActivityAt = msOf(runtime.now);
      schedule(sessionId, turn);
    } catch (error) {
      runtime.lastError = String(error?.message ?? error);
    }
  }

  function status() {
    return {
      enabled: runtime.enabled,
      registered: runtime.registered,
      hooks: runtime.registered ? ['session/event'] : [],
      memoryRootConfigured: runtime.memoryRoot !== null,
      config: runtime.config,
      warnings: runtime.warnings,
      lastError: runtime.lastError,
    };
  }

  Object.assign(runtime, { schedule, drain, start, dispose, onSessionEvent, status, ensureLlmAck });
}

/**
 * F5/D4: periodic, read-only spot-check of staged candidate evidence.
 * Failure only writes a `stale` ledger report — never changes a card, deletes a
 * file, or moves a directory. Candidates with a stale report in the last 30
 * days are skipped; at most `limit` per run.
 */
export async function spotCheckCandidates({
  memoryRoot,
  home = null,
  now = new Date(),
  limit = SPOT_CHECK_LIMIT,
  readFile = null,
  readSessionFile: readSession = readSessionFile,
} = {}) {
  const candidates = listStagedCandidates(memoryRoot);
  if (candidates.length === 0) return { checked: 0, stale: [], skipped: 0 };
  const ledger = readLedgerRows(memoryRoot);
  const rows = ledger.ok ? ledger.rows : [];
  const cutoff = msOf(now) - SPOT_CHECK_SKIP_DAYS * DAY_MS;
  const recentlyReported = new Set(rows
    .filter((row) => row?.kind === 'stale' && typeof row.candidateSlug === 'string'
      && Number.isFinite(Date.parse(String(row.at ?? ''))) && Date.parse(String(row.at ?? '')) >= cutoff)
    .map((row) => row.candidateSlug));
  const picked = candidates.filter((item) => !recentlyReported.has(item.slug)).slice(0, Math.max(1, limit));
  const stale = [];
  for (const item of picked) {
    const source = item.meta?.source ?? {};
    let parsed = null;
    try {
      const sampled = await readSession({ home, sessionId: source.sessionId });
      parsed = sampled?.parsed ?? null;
    } catch {
      parsed = null;
    }
    let code = null;
    for (const evidence of Array.isArray(item.meta?.evidence) ? item.meta.evidence : []) {
      if (!parsed) {
        code = 'E_EVIDENCE_SESSION_MISSING';
        break;
      }
      const verified = verifyEvidence({ evidence, parsed, memoryRoot, readFile });
      if (!verified.ok) {
        code = verified.code;
        break;
      }
    }
    if (code) {
      appendLedgerRow({
        memoryRoot,
        row: makeLedgerRow({
          kind: 'stale',
          attemptId: null,
          sessionId: typeof source.sessionId === 'string' ? source.sessionId : null,
          turn: Number.isInteger(source.turn) ? source.turn : null,
          candidateSlug: item.slug,
          reason: code,
          now,
        }),
        now: now instanceof Date ? now : new Date(now),
      });
      stale.push({ slug: item.slug, code });
    }
  }
  return { checked: picked.length, stale, skipped: candidates.length - picked.length };
}

/**
 * Plugin entry: mount the listener. Disabled → no hook, no disk, no timer, no log.
 * @returns {{enabled:boolean, registered:boolean, reason?:string, hooks?:string[],
 *   runtime:object, started?:Promise<object>}}
 */
export function registerAutoProcedure(ctx, config = {}, {
  memoryRoot = null,
  home = null,
  now = null,
  logger = null,
  deps = {},
} = {}) {
  const runtime = createAutoProcedureRuntime({
    // Strict: only the host config tree `config.autoProcedure` is accepted (no
    // "treat the whole config as the autoProcedure subtree" fallback).
    config: config?.autoProcedure,
    memoryRoot,
    home,
    now: now ?? (() => new Date()),
    logger,
    deps,
  });
  if (!runtime.enabled) {
    return { enabled: false, registered: false, reason: 'disabled', hooks: [], runtime };
  }
  if (runtime.memoryRoot === null) {
    warn(runtime.logger, 'autoProcedure.enabled=true 但 memoryRoot 未配置 — 未注册（按 F11：warn + 不静默）');
    return { enabled: true, registered: false, reason: 'E_MEMORY_ROOT_UNSET', hooks: [], runtime };
  }
  if (typeof ctx?.on !== 'function') {
    warn(runtime.logger, 'autoProcedure 已启用但宿主 ctx 没有 on() — 未注册');
    return { enabled: true, registered: false, reason: 'E_NO_HOOK_SEAM', hooks: [], runtime };
  }
  runtime.ctx = ctx;
  let disposeHook = null;
  try {
    disposeHook = ctx.on('session/event', (session, event) => runtime.onSessionEvent(session, event));
  } catch (error) {
    warn(runtime.logger, `autoProcedure 监听注册失败：${error?.message ?? error}`);
    return { enabled: true, registered: false, reason: 'E_HOOK_FAILED', hooks: [], runtime };
  }
  runtime.registered = true;
  if (typeof disposeHook === 'function' && typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {
        try {
          runtime.dispose();
        } finally {
          disposeHook();
        }
      }, 'longlive.auto-procedure');
    } catch {
      /* fake context without an effect scope: process lifetime is fine */
    }
  }
  const started = runtime.start().catch((error) => {
    runtime.lastError = String(error?.message ?? error);
    return { ok: false, code: 'E_AP_START_FAILED' };
  });
  return { enabled: true, registered: true, reason: null, hooks: ['session/event'], runtime, started };
}
