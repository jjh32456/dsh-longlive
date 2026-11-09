// 0.7.5 — automatic visible truncation at turn boundaries: log / dryrun / request.
//
// The request is built from a snapshot re-read right before the write, not from
// the turn/end read: the app keeps appending for a few milliseconds after
// turn/end (observed: 295 -> 298 events in 8 ms), and a plan computed from the
// stale read describes a file that no longer exists. The plan therefore records
// `snapshotEvents` / `snapshotMessages` / `snapshotAt`, and the watchdog
// (scripts/auto-truncate-run.ps1) reports how far the actual cut drifted from
// them in its result JSON.
//
// One evaluation per session per `cooldownMinutes`; the trigger is the host's
// `turn/end` event (see heartbeat.js, which already owns the `session/event`
// listener). The modes are deliberately shaped like the manual tool:
//
//   log     — parse + plan only; appends one JSON line; never opens the session
//             log for writing;
//   dryrun  — the full plan path (`truncateVisibleSession({dryRun:true})`) plus
//             the plan in the same log; still no write to the session log;
//   request — plan, then atomically write a request file for an out-of-app
//             orchestrator. It never writes the session log. A config that still
//             says "apply" is treated as "request" and recorded in the log as
//             modeAlias:"apply->request"; there is no in-app write mode any more.
//
// Why apply had to go: the running host keeps the session in memory and its
// writer on the old sequence. Rewriting the file underneath it produces a
// sequence gap and a torn JSONL record on the next append (the 0.7.0 round
// measured 77 -> 3532). Only an out-of-app process, after the host has exited,
// may cut the file — scripts/truncate-cli.mjs, driven by auto-truncate-run.ps1.
//
// The estimate is intentionally blunt: `MESSAGE_TYPES` data JSON / 4, the same
// heuristic the tool reports. It counts host-injected `user/message` blocks as
// message text, so it can overshoot. Per the 0.7.1 spec that is not a reason to
// skip: the configured threshold is the only decision rule, and every log line
// records the estimate basis explicitly.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseSession } from './codec.js';
import { appendJsonlRotated, normalizeLogRotation } from './log-rotation.js';
import { recordAutoTruncateStatus } from './auto-truncate-status.js';
import {
  CONTEXT_WINDOW_TOKENS,
  INPUT_COMPACT_AT_TOKENS,
  OUTPUT_RESERVE_NORMAL_TOKENS,
  SAFETY_TOKENS,
  THRESHOLD_POLICY_WARNING,
  classifyFoldFailure,
  evaluateFoldTrigger,
  evaluateTruncateBudget,
  foldRetrySchedule,
  thresholdEnforceability,
} from './policy/threshold-policy.js';
import {
  DEFAULT_BOUNDARY_RETRIES,
  DEFAULT_FIRST_USER_CAP_CHARS,
  nextArchivePath,
  planVisibleTruncation,
  readInflight,
  resolveVisibleCut,
  sessionEstimate,
  truncateVisibleSession,
} from './truncate-visible.js';

// 1.6.0 safety default (abuse assessment §4.1): automatic truncation is off
// unless a profile opts in. The default mode is dryrun, so even an explicit
// `autoTruncate: {}` cannot cut a session by accident; `mode:'request'` also
// requires enabled:true, and the runner additionally needs the watchdog.
export const AUTO_TRUNCATE_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'dryrun',
  tokensThreshold: INPUT_COMPACT_AT_TOKENS,
  minTurns: 12,
  cooldownMinutes: 60,
  keepTurns: 12,
  keepTokens: 80_000,
  // 0.8.0-rc.11: the carried first user message is bounded, and an unstable
  // boundary is retried by dropping one more turn at a time.
  firstUserCapChars: DEFAULT_FIRST_USER_CAP_CHARS,
  boundaryRetries: DEFAULT_BOUNDARY_RETRIES,
  // app.exe / app.profile written into the request file for the orchestrator.
  // An empty appExe means "use process.execPath" (inside Electron that is the
  // running app; under node it is node.exe, which a test or a dry run can read).
  appExe: '',
  profile: 'desktop',
});

export const AUTO_TRUNCATE_MODES = Object.freeze(['log', 'dryrun', 'request']);
// 0.7.0's in-app write mode. Accepted at parse time only to be rewritten to
// request; it is never executed and never written to the session log.
export const AUTO_TRUNCATE_LEGACY_MODES = Object.freeze(['apply']);

export const AUTO_TRUNCATE_STATE_FILE = 'auto-truncate-state.json';
export const AUTO_TRUNCATE_LOG_DIR = 'logs';
export const AUTO_TRUNCATE_LOG_FILE = 'auto-truncate.log';
export const AUTO_TRUNCATE_REQUEST_FILE = 'auto-truncate.request.json';

export const AUTO_ESTIMATE_BASIS =
  'MESSAGE_TYPES data JSON/4 (same heuristic as session_truncate_visible); host-injected user/message rows count too';

export const AUTO_TRUNCATE_ERRORS = Object.freeze({
  BAD_CONFIG: 'AUTO_BAD_CONFIG',
  BAD_MODE: 'AUTO_BAD_MODE',
  LOG_WRITE: 'AUTO_LOG_WRITE',
  EVALUATE: 'AUTO_EVALUATE_FAILED',
});

const MAX_STATE_SESSIONS = 200;
const MAX_SEEN_SESSIONS = 256;

function autoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function asPositiveInt(name, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw autoError(AUTO_TRUNCATE_ERRORS.BAD_CONFIG,
      `autoTruncate.${name} must be an integer >= ${min} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Merge the raw plugin config (`config.autoTruncate`) with the defaults.
 *
 * Invalid values throw instead of being silently clamped: a typo in `mode`
 * must not turn "apply" into "log" (or the reverse) behind the operator's back.
 */
export function normalizeAutoTruncateConfig(raw) {
  if (raw == null) return { ...AUTO_TRUNCATE_DEFAULTS };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw autoError(AUTO_TRUNCATE_ERRORS.BAD_CONFIG, 'autoTruncate must be an object');
  }
  const merged = { ...AUTO_TRUNCATE_DEFAULTS, ...raw };
  if (typeof merged.enabled !== 'boolean') {
    throw autoError(AUTO_TRUNCATE_ERRORS.BAD_CONFIG,
      `autoTruncate.enabled must be boolean (got ${JSON.stringify(merged.enabled)})`);
  }
  // 0.7.0 configs say "apply". Rewrite them to the request mode *before* the
  // mode check, and remember the alias so every log line names what happened.
  // A typo like "APPLY" still throws: only the exact legacy word is accepted.
  if (AUTO_TRUNCATE_LEGACY_MODES.includes(merged.mode)) {
    merged.mode = 'request';
    merged.modeAlias = 'apply->request';
  } else {
    delete merged.modeAlias;
  }
  if (!AUTO_TRUNCATE_MODES.includes(merged.mode)) {
    throw autoError(AUTO_TRUNCATE_ERRORS.BAD_MODE,
      `autoTruncate.mode must be one of ${AUTO_TRUNCATE_MODES.join('|')} `
      + `(legacy ${AUTO_TRUNCATE_LEGACY_MODES.join('|')} is accepted as request; got ${JSON.stringify(merged.mode)})`);
  }
  if (typeof merged.appExe !== 'string') {
    throw autoError(AUTO_TRUNCATE_ERRORS.BAD_CONFIG,
      `autoTruncate.appExe must be a string (got ${JSON.stringify(merged.appExe)})`);
  }
  merged.appExe = merged.appExe.trim();
  if (typeof merged.profile !== 'string' || merged.profile.trim() === '') {
    throw autoError(AUTO_TRUNCATE_ERRORS.BAD_CONFIG,
      `autoTruncate.profile must be a non-empty string (got ${JSON.stringify(merged.profile)})`);
  }
  merged.profile = merged.profile.trim();
  asPositiveInt('tokensThreshold', merged.tokensThreshold, 1);
  asPositiveInt('minTurns', merged.minTurns, 1);
  asPositiveInt('cooldownMinutes', merged.cooldownMinutes, 0);
  asPositiveInt('keepTurns', merged.keepTurns, 1);
  asPositiveInt('keepTokens', merged.keepTokens, 1);
  asPositiveInt('firstUserCapChars', merged.firstUserCapChars, 1);
  asPositiveInt('boundaryRetries', merged.boundaryRetries, 0);
  // 1.8.1-rc.7 diagnostics log rotation is an optional passthrough block. It is
  // deliberately absent from AUTO_TRUNCATE_DEFAULTS so the settings schema node
  // count stays stable; when present it is validated here, otherwise the shared
  // log-rotation defaults (8 MiB / 14 days / 5 files / daily) apply.
  if (merged.logMaxBytes !== undefined) asPositiveInt('logMaxBytes', merged.logMaxBytes, 64 * 1024);
  if (merged.logMaxFiles !== undefined) asPositiveInt('logMaxFiles', merged.logMaxFiles, 1);
  if (merged.logMaxAgeDays !== undefined) {
    if (!Number.isInteger(merged.logMaxAgeDays) || merged.logMaxAgeDays < 0) {
      throw autoError(AUTO_TRUNCATE_ERRORS.BAD_CONFIG,
        `autoTruncate.logMaxAgeDays must be an integer >= 0 (got ${JSON.stringify(merged.logMaxAgeDays)})`);
    }
  }
  if (merged.logRotateDaily !== undefined && typeof merged.logRotateDaily !== 'boolean') {
    throw autoError(AUTO_TRUNCATE_ERRORS.BAD_CONFIG,
      `autoTruncate.logRotateDaily must be boolean (got ${JSON.stringify(merged.logRotateDaily)})`);
  }
  return merged;
}

export function autoTruncatePaths(memoryRoot) {
  const root = path.join(memoryRoot, '.longlive');
  return {
    statePath: path.join(root, AUTO_TRUNCATE_STATE_FILE),
    logDir: path.join(root, AUTO_TRUNCATE_LOG_DIR),
    logPath: path.join(root, AUTO_TRUNCATE_LOG_DIR, AUTO_TRUNCATE_LOG_FILE),
    requestPath: path.join(root, AUTO_TRUNCATE_LOG_DIR, AUTO_TRUNCATE_REQUEST_FILE),
  };
}

function emptyState() {
  return { version: 1, sessions: {} };
}

/** Tolerant read: a missing/corrupt state file just means "no prior runs". */
export function readAutoTruncateState(memoryRoot) {
  try {
    const raw = fs.readFileSync(autoTruncatePaths(memoryRoot).statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed;
    }
    return emptyState();
  } catch {
    return emptyState();
  }
}

function writeAutoTruncateState(memoryRoot, state) {
  const { statePath } = autoTruncatePaths(memoryRoot);
  const entries = Object.entries(state.sessions);
  if (entries.length > MAX_STATE_SESSIONS) {
    entries.sort((a, b) => (b[1]?.lastEvaluatedAt ?? 0) - (a[1]?.lastEvaluatedAt ?? 0));
    state.sessions = Object.fromEntries(entries.slice(0, MAX_STATE_SESSIONS));
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, statePath);
}

/**
 * Atomically publish the request: write a sibling tmp file, then rename it over
 * the final name. A reader sees either the old file or the complete new one.
 *
 * The tmp write is inside the try so a short/failed write (ENOSPC, quota,
 * antivirus) removes the partial file instead of leaving a 12-byte request that
 * the next evaluation would quarantine forever.
 */
function writeRequestAtomic(fsImpl, requestPath, request) {
  const dir = path.dirname(requestPath);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmp = `${requestPath}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(request, null, 2)}\n`;
  const cleanup = () => {
    try { fsImpl.unlinkSync(tmp); } catch { /* nothing left to clean */ }
  };
  try {
    fsImpl.writeFileSync(tmp, body);
    fsImpl.renameSync(tmp, requestPath);
  } catch (error) {
    cleanup();
    throw error;
  }
  return { requestPath, tmp, bytes: Buffer.byteLength(body) };
}

/**
 * A corrupt request is evidence, not a permanent blocker: move it aside under a
 * timestamped name, then let this evaluation publish a fresh request.
 */
function quarantineRequestFile(fsImpl, requestPath, now) {
  const dir = path.dirname(requestPath);
  const stampText = new Date(now).toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-')
    .replace(/:/g, '');
  const stem = path.basename(requestPath).replace(/\.json$/i, '');
  let target = path.join(dir, `${stem}.corrupt-${stampText}.json`);
  for (let n = 1; fsImpl.existsSync(target); n += 1) {
    target = path.join(dir, `${stem}.corrupt-${stampText}-${n}.json`);
  }
  try {
    fsImpl.renameSync(requestPath, target);
    return { ok: true, from: requestPath, to: target };
  } catch (error) {
    return { ok: false, from: requestPath, error: error?.code ?? error?.message ?? String(error) };
  }
}

/**
 * Read an existing request without ever overwriting it. `null` means "absent";
 * any other failure returns a marker object so the caller can refuse to write
 * (a corrupt or unreadable request is still someone's pending request).
 */
function readRequestFile(fsImpl, requestPath) {
  let raw;
  try {
    raw = fsImpl.readFileSync(requestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { unreadable: true, code: error?.code ?? null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { corrupt: true };
  } catch {
    return { corrupt: true };
  }
}

/** Append exactly one JSON line; returns the line length or throws. */
export function appendAutoTruncateLog(memoryRoot, entry, options = {}) {
  const { logDir, logPath } = autoTruncatePaths(memoryRoot);
  fs.mkdirSync(logDir, { recursive: true });
  const written = appendJsonlRotated(logPath, entry, normalizeLogRotation(options));
  return { logPath, line: '', bytes: written.bytes, rotated: written.rotated, rotatedTo: written.rotatedTo };
}

/**
 * Locate `<home>/sessions/<scope>/<id>/session.v4.jsonl.zstd`. The host event
 * gives us an id, not a path; the plugin is root-scoped, so this scan replaces
 * guessing a scope name.
 */
export function findSessionFile(home, sessionId) {
  if (typeof home !== 'string' || home === '' || typeof sessionId !== 'string') return null;
  const sessionsRoot = path.join(home, 'sessions');
  let scopes;
  try {
    scopes = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, scope.name, sessionId, 'session.v4.jsonl.zstd');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this scope */
    }
  }
  return null;
}

function clockMs(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : Date.now();
}

function percentileDrop(before, after) {
  if (!before) return 0;
  return Number((((before - after) / before) * 100).toFixed(2));
}

/**
 * Create the per-plugin truncator. `onTurnEnd` is sync and never throws: the
 * host calls it from the `session/event` feed, where an exception would be a
 * host-level failure for a maintenance side task.
 */
export function createAutoTruncator(options = {}) {
  const memoryRoot = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== ''
    ? options.memoryRoot.trim()
    : null;
  const home = options.home ?? null;
  const config = normalizeAutoTruncateConfig(options.autoTruncate);
  // fold.triggerTokens is the 1.8.3 policy mapping; autoTruncate.tokensThreshold
  // remains the explicit truncation override when present.
  if (options.autoTruncate?.tokensThreshold === undefined
    && Number.isInteger(options.fold?.triggerTokens) && options.fold.triggerTokens > 0) {
    config.tokensThreshold = options.fold.triggerTokens;
  }
  const now = options.now ?? Date.now;
  const fsImpl = options.fs ?? fs;
  // Written into the request so the orchestrator knows what to close, restart
  // and verify. Inside Electron process.execPath IS the app; a test or dry run
  // can override it. pluginDir is the package root (where scripts/ lives).
  const appExe = config.appExe !== ''
    ? config.appExe
    : (typeof process.execPath === 'string' ? process.execPath : '');
  const pluginDir = options.pluginDir
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : null;
  const policyEnforceability = thresholdEnforceability();
  if (logger && config.enabled) {
    // 1.8.3: expose the policy-vs-enforceability boundary once per startup.
    logger.warn(`[threshold-policy] ${THRESHOLD_POLICY_WARNING}`);
  }
  const logOptions = {
    maxBytes: config.logMaxBytes,
    maxAgeDays: config.logMaxAgeDays,
    maxFiles: config.logMaxFiles,
    rotateDaily: config.logRotateDaily,
  };
  const appendLog = (entry) => appendAutoTruncateLog(memoryRoot, entry, logOptions);

  // Publish an initial status immediately so a panel can show mode=dryrun (and
  // "no evaluation yet") before the first turn/end. A write failure only warns.
  if (memoryRoot) {
    try {
      recordAutoTruncateStatus(memoryRoot, {
        mode: config.mode,
        enabled: config.enabled,
        thresholds: {
          tokensThreshold: config.tokensThreshold,
          minTurns: config.minTurns,
          keepTurns: config.keepTurns,
          keepTokens: config.keepTokens,
          boundaryRetries: config.boundaryRetries,
        },
        outcome: 'startup',
      }, { now: clockMs(now) });
    } catch (error) {
      if (logger) logger.warn(`[auto-truncate] initial status write failed: ${error?.message ?? error}`);
    }
  }

  const seen = new Map();
  const foldWarnings = new Set();
  const truncateWarnings = new Map();

  function rememberTurn(sessionId, turn) {
    seen.set(sessionId, turn);
    while (seen.size > MAX_SEEN_SESSIONS) {
      seen.delete(seen.keys().next().value);
    }
  }

  function stateFor(sessionId) {
    const state = readAutoTruncateState(memoryRoot);
    return state.sessions?.[sessionId] ?? null;
  }

  function markEvaluated(sessionId, at, turn, estimate, outcome, policy = null) {
    const state = readAutoTruncateState(memoryRoot);
    state.sessions[sessionId] = {
      lastEvaluatedAt: at,
      lastTurn: turn ?? null,
      tokens: estimate.tokens,
      turns: estimate.turns,
      mode: config.mode,
      status: outcome,
      ...(policy ? {
        outputReserveMode: policy.outputReserveMode ?? 'normal',
        outputReserveTokens: policy.outputReserveTokens ?? OUTPUT_RESERVE_NORMAL_TOKENS,
        lastPolicyAction: policy.action ?? null,
      } : {}),
    };
    writeAutoTruncateState(memoryRoot, state);
  }

  function baseEntry({ sessionId, sessionPath, at, estimate, threshold }) {
    return {
      time: new Date(at).toISOString(),
      sessionId,
      sessionPath,
      mode: config.mode,
      // 1.8.3 shared-window budget: input estimate, actual-output estimate (when
      // supplied by the host) and the reserve used for this decision.
      estimatedInputTokens: estimate.tokens,
      estimatedOutputTokens: threshold.actualOutputTokens ?? null,
      outputReserveTokens: threshold.reserveTokens ?? OUTPUT_RESERVE_NORMAL_TOKENS,
      actual_output_tokens: threshold.actualOutputTokens ?? null,
      finish_reason: threshold.finishReason ?? null,
      truncated: threshold.truncated === true,
      reserve_class: threshold.reserveMode ?? 'long',
      fold_failed: threshold.foldFailureReason ?? null,
      fold_busy: threshold.foldFailureReason === 'busy',
      fold_retry_at: threshold.foldRetryAt ?? null,
      fold_retry_turn: threshold.foldRetryTurn ?? null,
      // Fold (host compaction) and truncate (direct cut) are separate events.
      foldTriggered: threshold.foldTriggered === true,
      foldBeforeTokens: estimate.tokens,
      foldAfterTokens: null,
      truncateReason: threshold.policyAction === 'handoff' ? threshold.policyReason : null,
      truncateExecution: threshold.policyAction === 'handoff' ? 'NEXT_SAFE_OFFLINE' : null,
      escalation_exit: threshold.policyAction === 'handoff' ? 'restart-or-external-visible-truncate' : null,
      restart_required: threshold.policyAction === 'handoff',
      escalation_round: threshold.escalationRound ?? null,
      truncatePending: threshold.policyAction === 'handoff',
      truncateHandoffLine: threshold.inputHardLimitTokens ?? null,
      finishReason: typeof threshold.finishReason === 'string' ? threshold.finishReason : null,
      truncated: threshold.truncated === true,
      foldFailed: threshold.foldFailed === true,
      foldFailureReason: threshold.foldFailureReason ?? null,
      foldRetryNextTurn: threshold.foldRetryNextTurn === true,
      truncateBeforeTokens: estimate.tokens,
      truncateAfterTokens: null,
      ...(threshold.policy ? { policy: threshold.policy } : {}),
      ...(config.modeAlias ? { modeAlias: config.modeAlias } : {}),
      estimate: {
        tokens: estimate.tokens,
        turns: estimate.turns,
        events: estimate.events,
        messages: estimate.messages,
        userMessages: estimate.userMessages,
        basis: AUTO_ESTIMATE_BASIS,
      },
      threshold,
    };
  }

  /**
   * Evaluate one finished turn.
   *
   * @param {object} info
   * @param {string} info.sessionId  host session id (already lowercase)
   * @param {number} [info.turn]     `event.data.turn`
   * @param {string} [info.sessionPath] explicit path (tests); otherwise resolved
   * @returns {object} a small status record (never throws)
   */
  function evaluateOnTurnEnd(info = {}) {
    const status = { status: 'skipped' };
    try {
      const sessionId = typeof info.sessionId === 'string' ? info.sessionId : '';
      if (!config.enabled) return { ...status, reason: 'disabled' };
      if (!memoryRoot) return { ...status, reason: 'no-memory-root' };
      if (sessionId === '') return { ...status, reason: 'no-session-id' };

      const turn = Number.isInteger(info.turn) ? info.turn : null;
      // One turn, one evaluation: a repeated turn/end (host replay) costs
      // nothing. Across restarts the cooldown is the next line of defence.
      if (turn !== null && seen.get(sessionId) === turn) {
        return { ...status, reason: 'duplicate-turn', turn };
      }
      if (turn !== null) rememberTurn(sessionId, turn);

      const at = clockMs(now);
      const prior = stateFor(sessionId);
      const cooldownMs = config.cooldownMinutes * 60_000;
      if (prior && Number.isFinite(prior.lastEvaluatedAt) && at - prior.lastEvaluatedAt < cooldownMs) {
        return {
          ...status,
          reason: 'cooldown',
          retryAfterMs: cooldownMs - (at - prior.lastEvaluatedAt),
        };
      }

      const sessionPath = info.sessionPath ?? findSessionFile(home, sessionId);
      if (!sessionPath) return { ...status, reason: 'session-file-not-found' };

      let inflight = null;
      try {
        inflight = readInflight(sessionPath);
      } catch {
        // A corrupt record means "someone may be writing"; skip rather than
        // race a half-finished operation.
        return { ...status, reason: 'inflight-unreadable' };
      }
      if (inflight) return { ...status, reason: 'inflight' };

      const buf = fsImpl.readFileSync(sessionPath);
      const parsed = parseSession(buf);
      const estimate = sessionEstimate(parsed);
      const actualOutputTokens = Number.isFinite(Number(info.actualOutputTokens)) && Number(info.actualOutputTokens) >= 0
        ? Number(info.actualOutputTokens)
        : null;
      const longOutput = prior?.outputReserveMode === 'long' ? true : null;
      const foldFailure = info.foldOutcome ? classifyFoldFailure(info.foldOutcome) : null;
      const foldRetry = foldFailure ? foldRetrySchedule({ turn: Number.isInteger(turn) ? turn : 0, now: at }) : null;
      const fold = evaluateFoldTrigger({ inputTokens: estimate.tokens });
      const policy = evaluateTruncateBudget({
        inputTokens: estimate.tokens,
        actualOutputTokens,
        longOutput,
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        safetyTokens: SAFETY_TOKENS,
      });
      const requiresCut = policy.action === 'handoff';
      let truncateWarningRound = 0;
      if (requiresCut) {
        truncateWarningRound = (truncateWarnings.get(sessionId) ?? 0) + 1;
        truncateWarnings.set(sessionId, truncateWarningRound);
      }
      if (foldFailure && logger) {
        logger.warn(`[fold-policy] fold ${foldFailure.reason}: retry next turn (not silent)`);
      }
      if (fold.triggered && logger) {
        // Fold needs host compaction; the plugin only records/warns here.
        logger.warn(`[fold-policy] input=${fold.inputTokens} >= fold.triggerTokens=${fold.triggerTokens}; `
          + 'host compaction is required, but this plugin cannot force a fold in the current pre-step');
      }
      if (requiresCut && logger && (truncateWarningRound === 1 || truncateWarningRound % 3 === 0)) {
        logger.warn(`[truncate-policy] 升级出口/重启建议：必须重启或外部执行 visible-truncate; `
          + `reason=${policy.reason} input=${policy.inputTokens} reserve=${policy.reserveTokens} `
          + `safety=${policy.safetyTokens} round=${truncateWarningRound} (NEXT_SAFE_OFFLINE; no in-turn block)`);
      }
      const threshold = {
        tokens: config.tokensThreshold,
        minTurns: config.minTurns,
        // 1.8.3 shared-window budget: policy compact at 350K and the hard
        // input+reserve+safety line both trigger; pure output-over-reserve only
        // warns and raises the next-turn reserve.
        exceeded: (estimate.tokens >= config.tokensThreshold && estimate.turns > config.minTurns) || requiresCut,
        actualOutputTokens,
        reserveTokens: policy.outputReserveTokens,
        reserveMode: policy.reserveMode ?? 'long',
        inputHardLimitTokens: policy.inputHardLimitTokens,
        policyAction: policy.action,
        policyReason: policy.reason,
        escalationRound: truncateWarningRound || null,
        escalationExit: requiresCut ? 'restart-or-external-visible-truncate' : null,
        foldTriggered: fold.triggered,
        finishReason: typeof info.finishReason === 'string' ? info.finishReason : null,
        truncated: info.truncated === true,
        foldFailed: foldFailure?.foldFailed === true,
        foldFailureReason: foldFailure?.reason ?? null,
        foldRetryNextTurn: foldFailure?.retryNextTurn === true,
        foldRetryAt: foldRetry?.retryAt ?? null,
        foldRetryTurn: foldRetry?.retryTurn ?? null,
        outputOverReserve: policy.outputOverReserve,
        nextReserveMode: policy.reserveMode === 'long' || policy.action === 'switch-long-output-or-segment' ? 'long' : 'normal',
        policy: {
          action: policy.action,
          reason: policy.reason,
          inputTokens: policy.inputTokens,
          reserveTokens: policy.reserveTokens,
          inputHardLimitTokens: policy.inputHardLimitTokens,
          safetyTokens: policy.safetyTokens,
          outputOverReserve: policy.outputOverReserve,
          enforced: policyEnforceability.enforced,
          hostMaxTokensConfigurable: policyEnforceability.hostMaxTokensConfigurable,
        },
      };

      // Below the threshold the evaluation still consumes the cooldown window:
      // the spec's debounce is per-session evaluation, not per-action.
      markEvaluated(sessionId, at, turn, estimate, threshold.exceeded ? 'over' : 'below', {
        outputReserveMode: threshold.nextReserveMode,
        outputReserveTokens: policy.outputReserveTokens,
        action: policy.action,
      });
      if (actualOutputTokens !== null && (policy.action === 'switch-long-output-or-segment' || policy.outputOverReserve || policy.action === 'handoff')) {
        // 1.8.3: never silently ignore an actual output that outgrew its
        // reserve; the next turn uses the long-output reserve.
        if (logger) {
          logger.warn(`[threshold-policy] actual_output=${actualOutputTokens} reserve=${policy.outputReserveTokens} `
            + `input=${policy.inputTokens}; next-turn reserve=long (${INPUT_COMPACT_AT_TOKENS / 1000}K compact line); `
            + `action=${policy.action}`);
        }
      }
      if (!threshold.exceeded) {
        return {
          ...status,
          ...(foldFailure ? { status: 'fold-warning', foldFailure } : {}),
          ...(policy.action === 'switch-long-output-or-segment' ? { status: 'policy-warning' } : {}),
          reason: policy.action === 'switch-long-output-or-segment' ? 'actual-output-over-reserve' : 'below-threshold',
          estimate, threshold, policy,
        };
      }

      const common = baseEntry({ sessionId, sessionPath, at, estimate, threshold });

      if (config.mode === 'log') {
        const plan = planVisibleTruncation(parsed, {
          keepTurns: config.keepTurns,
          keepTokens: config.keepTokens,
          firstUserCapChars: config.firstUserCapChars,
        });
        const entry = {
          ...common,
          action: plan.needed ? 'planned' : 'none',
          session: {
            origin: parsed.header?.origin ?? null,
            parentSession: parsed.header?.parentSession ?? null,
          },
          plan: plan.needed
            ? {
              needed: true,
              feasible: plan.feasible,
              cut: {
                turn: plan.cutTurn,
                startSeq: plan.cutTurnStartSeq,
                droppedTurns: plan.droppedTurnCount,
                keptTurns: plan.keptTurnCount,
              },
              projected: {
                dropEvents: plan.dropped.events,
                dropTokens: plan.dropped.tokens,
                dropPercent: percentileDrop(plan.original.tokens, plan.original.tokens - plan.dropped.tokens),
                // 0.8.0-rc.11: this is the estimate of the *rewritten* log
                // (head + archive card + capped carry + kept turns), not
                // original minus dropped, which used to omit all synthetics.
                afterTokensEstimate: plan.budget?.afterTokens
                  ?? Math.max(0, plan.original.tokens - plan.dropped.tokens),
                keepTokens: plan.keepTokens,
                fits: plan.budget?.fits ?? null,
              },
              budget: plan.budget ?? null,
              firstUserMessage: plan.firstUserMessage,
              firstUserCarry: plan.firstUserCarry ?? null,
              firstUserMessageNote: plan.firstUserMessageNote ?? null,
              infeasible: plan.infeasible ?? null,
            }
            : { needed: false, reason: plan.reason },
        };
        const written = appendLog(entry);
        return { status: 'logged', action: entry.action, logPath: written.logPath, entry };
      }

      if (config.mode === 'dryrun') {
        const result = truncateVisibleSession(sessionPath, {
          dryRun: true,
          keepTurns: config.keepTurns,
          keepTokens: config.keepTokens,
          firstUserCapChars: config.firstUserCapChars,
          boundaryRetries: config.boundaryRetries,
          now: at,
          // Dry runs do not archive, so no diag row is written here; passing the
          // root keeps the option surface uniform for the real CLI/manual path.
          memoryRoot,
          turn,
          logger,
          diagOptions: logOptions,
        });
        if (result.feasible === false) {
          // 0.8.0-rc.11: an infeasible dry run is a result, not an exception.
          // It must appear in auto-truncate.log with the attempts, otherwise a
          // failing planner is indistinguishable from "nothing to do".
          const entry = {
            ...common,
            action: 'dryrun-infeasible',
            dryRun: true,
            feasible: false,
            code: result.code,
            reason: result.reason,
            attempts: result.attempts,
            limit: result.limit ?? result.plan?.infeasible?.limit ?? null,
            session: {
              origin: parsed.header?.origin ?? null,
              parentSession: parsed.header?.parentSession ?? null,
            },
            plan: { needed: true, feasible: false, reason: result.reason },
            wroteSessionFile: false,
          };
          const written = appendLog(entry);
          return {
            status: 'dryrun-infeasible',
            action: entry.action,
            code: entry.code,
            logPath: written.logPath,
            entry,
            limit: entry.limit ?? null,
          };
        }
        const entry = {
          ...common,
          action: result.needed ? 'dryrun-planned' : 'none',
          dryRun: true,
          feasible: true,
          session: {
            origin: parsed.header?.origin ?? null,
            parentSession: parsed.header?.parentSession ?? null,
          },
          plan: result.needed
            ? {
              needed: true,
              feasible: true,
              cut: result.cut,
              dropped: result.dropped,
              kept: result.kept,
              after: result.after,
              budget: result.budget ?? null,
              attempts: result.attempts ?? null,
              droppedTurns: result.droppedTurns?.length ?? 0,
              keptTurnsDetail: result.keptTurns?.length ?? 0,
              archivePath: result.archivePath,
              firstUserMessage: result.firstUserMessage ?? null,
              firstUserCarry: result.firstUserCarry ?? null,
              firstUserMessageNote: result.firstUserMessageNote ?? null,
            }
            : { needed: false, reason: result.reason ?? null },
          wroteSessionFile: false,
        };
        const written = appendLog(entry);
        return { status: 'dryrun', action: entry.action, logPath: written.logPath, entry };
      }

      // request: plan, then hand the actual file operation to an out-of-app
      // orchestrator. Nothing below may open the session log for writing: the
      // running host still holds the old sequence in memory, so an in-process
      // rewrite would corrupt its next append (0.7.0 measured 77 -> 3532).
      // The turn/end snapshot above was taken a few milliseconds before this
      // point, and the app keeps appending right after turn/end: a VM run read
      // 295 events / 91 messages when the request was written, the app appended
      // seq 295-297 eight milliseconds later, and the watchdog then cut the 298
      // event file, so the request's estimate and plan were three events short of
      // what actually ran. Re-read the file once, here, and build both from the
      // same snapshot the watchdog will meet. One extra I/O buys a plan that
      // cannot be stale by construction.
      let snapshotParsed = parsed;
      let snapshotEstimate = estimate;
      let snapshotAt = new Date(at).toISOString();
      let snapshotSource = 'turn-end';
      try {
        const freshParsed = parseSession(fsImpl.readFileSync(sessionPath));
        if (freshParsed.header?.id === parsed.header?.id) {
          snapshotParsed = freshParsed;
          snapshotEstimate = sessionEstimate(freshParsed);
          snapshotAt = new Date(clockMs(now)).toISOString();
          snapshotSource = 'pre-request';
        }
      } catch (error) {
        // A failed re-read must not invent numbers: keep the turn/end snapshot
        // and say which one the request was built from.
        snapshotSource = `turn-end (re-read failed: ${error?.code ?? error?.message ?? String(error)})`;
      }

      const plan = planVisibleTruncation(snapshotParsed, {
        keepTurns: config.keepTurns,
        keepTokens: config.keepTokens,
        firstUserCapChars: config.firstUserCapChars,
      });
      const sessionInfo = {
        origin: snapshotParsed.header?.origin ?? parsed.header?.origin ?? null,
        parentSession: snapshotParsed.header?.parentSession ?? parsed.header?.parentSession ?? null,
      };
      const { requestPath } = autoTruncatePaths(memoryRoot);

      // Single-flight: a request already waiting for the orchestrator is never
      // overwritten. The log records the pending one, then this evaluation ends.
      // A corrupt request (half-written JSON from an older build, a killed
      // writer) is quarantined and replaced: one bad byte must not block every
      // future evaluation forever.
      let existing = readRequestFile(fsImpl, requestPath);
      let quarantine = null;
      if (existing !== null && existing.corrupt) {
        quarantine = quarantineRequestFile(fsImpl, requestPath, at);
        if (quarantine.ok) existing = null;
      }
      if (existing !== null) {
        const entry = {
          ...common,
          action: 'request-pending',
          requestPending: true,
          requestPath,
          requestId: typeof existing.requestId === 'string' ? existing.requestId : null,
          pendingAt: typeof existing.at === 'string' ? existing.at : null,
          pendingState: existing.corrupt
            ? 'corrupt'
            : (existing.unreadable ? 'unreadable' : 'valid'),
          quarantine: quarantine && !quarantine.ok ? quarantine : null,
          session: sessionInfo,
          plan: plan.needed
            ? {
              needed: true,
              cut: {
                turn: plan.cutTurn,
                startSeq: plan.cutTurnStartSeq,
                droppedTurns: plan.droppedTurnCount,
                keptTurns: plan.keptTurnCount,
              },
              projected: {
                dropEvents: plan.dropped.events,
                dropTokens: plan.dropped.tokens,
                afterTokensEstimate: plan.budget?.afterTokens
                  ?? Math.max(0, plan.original.tokens - plan.dropped.tokens),
              },
            }
            : { needed: false, reason: plan.reason },
          wroteSessionFile: false,
        };
        const written = appendLog(entry);
        return {
          status: 'request-pending',
          action: entry.action,
          requestId: entry.requestId,
          requestPath,
          logPath: written.logPath,
          entry,
        };
      }

      // 0.8.0-rc.11: verify the cut by building it before writing a request.
      // rc.10 wrote the request from a plan that could not be stabilized, and
      // the failure only surfaced later (or was swallowed entirely). A request
      // now carries a cut that has already encoded cleanly, or a readable
      // `request-infeasible` log line instead of a silently impossible plan.
      const resolved = resolveVisibleCut(snapshotParsed, {
        keepTurns: config.keepTurns,
        keepTokens: config.keepTokens,
        firstUserCapChars: config.firstUserCapChars,
        boundaryRetries: config.boundaryRetries,
        archivePath: nextArchivePath(path.resolve(sessionPath), at),
        now: at,
      });

      if (!resolved.needed) {
        const entry = {
          ...common,
          action: 'none',
          session: sessionInfo,
          plan: { needed: false, reason: resolved.plan?.reason ?? plan.reason },
          pendingState: quarantine?.ok ? 'quarantined' : undefined,
          quarantinedFile: quarantine?.ok ? quarantine.to : undefined,
          wroteSessionFile: false,
        };
        const written = appendLog(entry);
        return {
          status: 'request-none',
          action: entry.action,
          requestPath,
          logPath: written.logPath,
          entry,
        };
      }

      if (!resolved.feasible) {
        const entry = {
          ...common,
          action: 'request-infeasible',
          feasible: false,
          code: resolved.code,
          reason: resolved.reason,
          attempts: resolved.attempts,
          requestPath,
          session: sessionInfo,
          plan: { needed: true, feasible: false, reason: resolved.reason },
          pendingState: quarantine?.ok ? 'quarantined' : undefined,
          quarantinedFile: quarantine?.ok ? quarantine.to : undefined,
          wroteSessionFile: false,
        };
        const written = appendLog(entry);
        return {
          status: 'request-infeasible',
          action: entry.action,
          code: entry.code,
          requestPath,
          logPath: written.logPath,
          entry,
        };
      }

      const verified = resolved.plan;
      const verifiedAfterTokens = resolved.built?.tokens
        ?? verified.budget?.afterTokens
        ?? Math.max(0, verified.original.tokens - verified.dropped.tokens);

      const request = {
        version: 1,
        requestId: crypto.randomUUID(),
        at: new Date(at).toISOString(),
        sessionPath: path.resolve(sessionPath),
        sessionId,
        reason: 'tokens-over-threshold',
        estimate: {
          tokens: snapshotEstimate.tokens,
          threshold: threshold.tokens,
          events: snapshotEstimate.events,
          messages: snapshotEstimate.messages,
          source: snapshotSource,
        },
        plan: {
          cut: verified.cutTurn,
          dropped: verified.dropped.events,
          kept: verified.kept.events,
          keepTurns: config.keepTurns,
          keepTokens: config.keepTokens,
          firstUserCapChars: verified.firstUserCapChars,
          attempts: resolved.attempts.length,
          feasible: true,
          // The estimate of the rewritten log (head + archive card + capped
          // carry + kept turns), which is what the next turn will actually pay.
          projectedTokens: verifiedAfterTokens,
          // What the plan was computed from. The watchdog compares these two
          // against the file it actually cut and reports any difference in its
          // result JSON, so a plan that aged can never look like a match.
          snapshotEvents: snapshotEstimate.events,
          snapshotMessages: snapshotEstimate.messages,
          snapshotAt,
        },
        app: {
          exe: appExe,
          profile: config.profile,
        },
        pluginDir,
      };

      try {
        writeRequestAtomic(fsImpl, requestPath, request);
      } catch (error) {
        const failure = {
          ...common,
          action: 'request-failed',
          code: error?.code ?? 'AUTO_REQUEST_WRITE',
          message: error?.message ?? String(error),
          requestPath,
          pendingState: quarantine?.ok ? 'quarantined' : undefined,
          quarantinedFile: quarantine?.ok ? quarantine.to : undefined,
          wroteSessionFile: false,
        };
        try {
          const written = appendLog(failure);
          return { status: 'request-failed', code: failure.code, logPath: written.logPath, entry: failure };
        } catch (logError) {
          return { status: 'request-failed', code: failure.code, logError: logError.message };
        }
      }

      const entry = {
        ...common,
        action: 'request-written',
        requestId: request.requestId,
        requestPath,
        request,
        pendingState: quarantine?.ok ? 'quarantined' : undefined,
        quarantinedFile: quarantine?.ok ? quarantine.to : undefined,
        session: sessionInfo,
        plan: {
          needed: true,
          snapshot: {
            source: snapshotSource,
            at: snapshotAt,
            events: snapshotEstimate.events,
            messages: snapshotEstimate.messages,
          },
          cut: {
            turn: verified.cutTurn,
            startSeq: verified.cutTurnStartSeq,
            droppedTurns: verified.droppedTurnCount,
            keptTurns: verified.keptTurnCount,
          },
          projected: {
            dropEvents: verified.dropped.events,
            dropTokens: verified.dropped.tokens,
            dropPercent: percentileDrop(verified.original.tokens, verifiedAfterTokens),
            afterTokensEstimate: verifiedAfterTokens,
          },
        },
        wroteSessionFile: false,
      };
      const written = appendLog(entry);
      return {
        status: 'request-written',
        action: entry.action,
        requestId: request.requestId,
        requestPath,
        logPath: written.logPath,
        entry,
      };
    } catch (error) {
      // 0.8.0-rc.11: an unexpected failure is a recorded outcome now. rc.10
      // returned {status:'error'} to a caller that ignored it, and wrote
      // nothing to auto-truncate.log — so a broken planner looked exactly like
      // a quiet session. This never throws: if the log itself cannot be
      // written, the code/message still travel in the return value.
      const code = error?.code ?? AUTO_TRUNCATE_ERRORS.EVALUATE;
      const message = error?.message ?? String(error);
      const entry = {
        time: new Date(clockMs(now)).toISOString(),
        sessionId: info?.sessionId ?? null,
        sessionPath: info?.sessionPath ?? null,
        mode: config.mode,
        action: 'error',
        code,
        message,
        details: error?.details ?? null,
        attempts: error?.attempts ?? error?.details?.attempts ?? null,
        wroteSessionFile: false,
      };
      let logPath = null;
      let logError = null;
      if (memoryRoot) {
        try {
          logPath = appendLog(entry).logPath;
        } catch (writeError) {
          logError = writeError?.message ?? String(writeError);
        }
      }
      return {
        status: 'error',
        reason: 'exception',
        code,
        message,
        entry,
        logPath,
        ...(logError ? { logError } : {}),
      };
    }
  }

  function publishStatus(result, info) {
    if (!memoryRoot) return null;
    const entry = result?.entry ?? null;
    const status = result?.status ?? 'unknown';
    const action = entry?.action ?? null;
    const overExceeded = Boolean(result?.threshold?.exceeded || entry?.threshold?.exceeded);
    const infeasible = /infeasible/u.test(status) || /infeasible/u.test(action ?? '');
    const error = status === 'error' || action === 'error' || status === 'request-failed' || action === 'request-failed';
    const skipped = status === 'skipped';
    const delta = { evaluations: skipped ? 0 : 1 };
    if (skipped) delta.skipped = 1;
    else if (overExceeded) delta.over = 1;
    else if (infeasible) delta.infeasible = 1;
    else if (error) delta.error = 1;
    else if (status === 'logged') delta.logged = 1;
    else if (status === 'dryrun') delta.dryrun = 1;
    else if (status === 'request-written') delta.requestWritten = 1;
    else if (status === 'request-pending') delta.requestPending = 1;
    else if (status === 'request-none') delta.noop = 1;
    if (infeasible) delta.infeasible = 1;
    if (error) delta.error = 1;

    const at = new Date(clockMs(now)).toISOString();
    const overSample = overExceeded ? {
      sessionId: info?.sessionId ?? null,
      tokens: entry?.estimate?.tokens ?? result?.estimate?.tokens ?? null,
      turns: entry?.estimate?.turns ?? result?.estimate?.turns ?? null,
      turn: Number.isInteger(info?.turn) ? info.turn : entry?.lastTurn ?? null,
      at,
    } : null;
    const lastError = error ? {
      at,
      sessionId: info?.sessionId ?? null,
      code: result?.code ?? entry?.code ?? 'AUTO_EVALUATE_FAILED',
      message: String(result?.message ?? entry?.message ?? result?.reason ?? 'error').slice(0, 500),
    } : null;
    const lastInfeasible = infeasible ? {
      at,
      sessionId: info?.sessionId ?? null,
      code: result?.code ?? entry?.code ?? 'AUTO_INFEASIBLE',
      reason: String(result?.reason ?? entry?.reason ?? entry?.message ?? 'infeasible').slice(0, 500),
      limit: result?.limit ?? entry?.limit ?? null,
    } : null;
    const warning = error
      ? `evaluation error: ${lastError.code} ${lastError.message}`
      : (infeasible
        ? `infeasible cut: ${lastInfeasible.code} ${lastInfeasible.reason}`
        : (overExceeded
          ? `session ${info?.sessionId ?? '?'} is over threshold (${result?.threshold?.tokens ?? entry?.threshold?.tokens ?? '?'} tokens)`
          : null));
    let published = null;
    try {
      published = recordAutoTruncateStatus(memoryRoot, {
        mode: config.mode,
        enabled: config.enabled,
        thresholds: {
          tokensThreshold: config.tokensThreshold,
          minTurns: config.minTurns,
          keepTurns: config.keepTurns,
          keepTokens: config.keepTokens,
          boundaryRetries: config.boundaryRetries,
        },
        delta,
        outcome: result?.status ?? 'unknown',
        overSample,
        error: lastError,
        infeasible: lastInfeasible,
        warning,
      }, { now: clockMs(now) });
    } catch (statusError) {
      if (logger) logger.warn(`[auto-truncate] status write failed: ${statusError?.message ?? statusError}`);
    }
    if (warning && logger) logger.warn(`[auto-truncate] ${warning}`);
    return published;
  }

  // Public entry: evaluate, then always publish the operator-visible status.
  // evaluateOnTurnEnd never throws; the status publish is also guarded so a
  // broken status file can never fail the host's turn/end feed.
  function onTurnEnd(info = {}) {
    const result = evaluateOnTurnEnd(info);
    try {
      publishStatus(result, info);
    } catch (error) {
      if (logger) logger.warn(`[auto-truncate] status publish failed: ${error?.message ?? error}`);
    }
    return result;
  }

  return {
    config,
    onTurnEnd,
    evaluate: onTurnEnd,
    logPath: memoryRoot ? autoTruncatePaths(memoryRoot).logPath : null,
    statePath: memoryRoot ? autoTruncatePaths(memoryRoot).statePath : null,
    requestPath: memoryRoot ? autoTruncatePaths(memoryRoot).requestPath : null,
    statusPath: memoryRoot ? path.join(memoryRoot, '.longlive', 'auto-truncate-status.json') : null,
    appExe,
    pluginDir,
    logger,
  };
}
