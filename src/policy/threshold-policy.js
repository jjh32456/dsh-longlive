// 1.8.3 threshold policy — fixed numbers from THRESHOLD-FINAL-1.8.3.
//
// IMPORTANT: these are POLICY budgets, not API-enforced limits. The host does
// not expose the main model's max_tokens; only router face has a separate 1024
// cap. Therefore output reserves / hard limits below are used for planning,
// warning and segmentation; the only enforceable knobs are the existing
// autoTruncate.tokensThreshold and hotTruncate.autoMinTokens config keys.
//
// Evidence labels:
//   official: DeepSeek API docs, fetched 2026-11-09 (1M shared context window;
//             max_tokens 1..393216; finish_reason=length on overflow)
//   measured: local 1,443-turn sample (output P99 91,431 / max 179,567)
//   estimate: safety reserve / tokenizer + system-prompt headroom
//   unverified: whether max_tokens includes reasoning tokens (we assume yes);
//               exact input-overflow error shape.

export const CONTEXT_WINDOW_TOKENS = 1_000_000;
export const MAX_OUTPUT_TOKENS = 393_216;
export const SAFETY_TOKENS = 50_000;
export const OUTPUT_HARD_LIMIT_TOKENS = 350_000;
export const OUTPUT_RESERVE_NORMAL_TOKENS = 192_000;
export const OUTPUT_RESERVE_LONG_TOKENS = 350_000;
export const INPUT_COMPACT_AT_TOKENS = 350_000;
export const INPUT_HARD_LIMIT_NORMAL_TOKENS = 757_000; // trigger >=; 1M - 192K - 50K - 1K safety
export const INPUT_HARD_LIMIT_LONG_TOKENS = 599_000; // trigger >=; 1M - 350K - 50K - 1K safety

// Fold (host compaction; semantic summary) and truncate (direct cut; no summary)
// are distinct concepts. Keep the names separated at every layer.
export const FOLD_TRIGGER_TOKENS = INPUT_COMPACT_AT_TOKENS;
// Not implemented in 1.8.3: the compaction backend has no targetTokens option.
// Measured post-fold median is 52K; 84K is the v0.6 cost-neutral target and
// must not be claimed as achieved until targetTokens exists and is tested.
export const FOLD_MEASURED_MEDIAN_TOKENS = 52_000;
export const FOLD_TARGET_TOKENS = 84_000;
export const FOLD_TARGET_MIN_TOKENS = 52_000;
export const FOLD_TARGET_MAX_TOKENS = 84_000;
export const TRUNCATE_INPUT_HARD_CAP_NORMAL_TOKENS = INPUT_HARD_LIMIT_NORMAL_TOKENS;
export const TRUNCATE_INPUT_HARD_CAP_LONG_TOKENS = INPUT_HARD_LIMIT_LONG_TOKENS;
export const TRUNCATE_OUTPUT_MAX_TOKENS = OUTPUT_HARD_LIMIT_TOKENS;
export const TRUNCATE_SAFETY_TOKENS = SAFETY_TOKENS;
export const TRUNCATE_RESERVE_NORMAL_TOKENS = OUTPUT_RESERVE_NORMAL_TOKENS;
export const TRUNCATE_RESERVE_LONG_TOKENS = OUTPUT_RESERVE_LONG_TOKENS;

export const FOLD_DEFAULTS = Object.freeze({ triggerTokens: FOLD_TRIGGER_TOKENS });
export const TRUNCATE_DEFAULTS = Object.freeze({
  inputHardCapNormal: TRUNCATE_INPUT_HARD_CAP_NORMAL_TOKENS,
  inputHardCapLongOutput: TRUNCATE_INPUT_HARD_CAP_LONG_TOKENS,
  outputMaxTokens: TRUNCATE_OUTPUT_MAX_TOKENS,
  safetyTokens: TRUNCATE_SAFETY_TOKENS,
  reserveNormal: TRUNCATE_RESERVE_NORMAL_TOKENS,
  reserveLongOutput: TRUNCATE_RESERVE_LONG_TOKENS,
});

export function evaluateFoldTrigger({ inputTokens, triggerTokens = FOLD_TRIGGER_TOKENS } = {}) {
  const input = finiteNonNegative(inputTokens, 'inputTokens');
  return { triggered: input >= triggerTokens, inputTokens: input, triggerTokens };
}

export const THRESHOLD_DEFAULTS = Object.freeze({
  contextWindowTokens: CONTEXT_WINDOW_TOKENS,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  safetyTokens: SAFETY_TOKENS,
  outputHardLimitTokens: OUTPUT_HARD_LIMIT_TOKENS,
  outputReserveNormalTokens: OUTPUT_RESERVE_NORMAL_TOKENS,
  outputReserveLongTokens: OUTPUT_RESERVE_LONG_TOKENS,
  inputCompactAtTokens: INPUT_COMPACT_AT_TOKENS,
  inputHardLimitNormalTokens: INPUT_HARD_LIMIT_NORMAL_TOKENS,
  inputHardLimitLongTokens: INPUT_HARD_LIMIT_LONG_TOKENS,
});

export const THRESHOLD_EVIDENCE = Object.freeze({
  contextWindowTokens: 'official',
  maxOutputTokens: 'official',
  safetyTokens: 'estimate',
  outputHardLimitTokens: 'user-decision+official',
  outputReserveNormalTokens: 'measured',
  outputReserveLongTokens: 'user-decision',
  inputCompactAtTokens: 'measured+user-decision',
  inputHardLimitNormalTokens: 'formula',
  inputHardLimitLongTokens: 'formula',
  reasoningTokensIncluded: 'unverified-assumed-yes',
  hostMaxTokensEnforceable: false,
});

export const THRESHOLD_POLICY_WARNING = [
  'threshold policy: main-model max_tokens is not exposed by the host;',
  '350K/192K are planning reserves and segmentation triggers, not enforced API limits;',
  'fallback = fixed 350K reserve + 600K input hard cap when dynamic mode cannot be observed.',
].join(' ');

export function outputReserveTokens({ longOutput = false } = {}) {
  return longOutput ? OUTPUT_RESERVE_LONG_TOKENS : OUTPUT_RESERVE_NORMAL_TOKENS;
}

export function inputHardLimitTokens({ longOutput = false } = {}) {
  return longOutput ? INPUT_HARD_LIMIT_LONG_TOKENS : INPUT_HARD_LIMIT_NORMAL_TOKENS;
}

export const FOLD_RETRY_MIN_TURNS = 3;
export const FOLD_RETRY_MIN_MS = 30 * 60 * 1000; // 30min
export const FOLD_FAILURE_REASONS = Object.freeze(['failed', 'busy', 'no-backend', 'unavailable']);
export function classifyFoldFailure(reason) {
  const normalized = typeof reason === 'string' ? reason : 'failed';
  const known = FOLD_FAILURE_REASONS.includes(normalized) ? normalized : 'failed';
  return {
    foldFailed: true, reason: known, retryNextTurn: true, retryLimit: 1,
    retryMinTurns: FOLD_RETRY_MIN_TURNS, retryMinMs: FOLD_RETRY_MIN_MS,
    backoffMs: FOLD_RETRY_MIN_MS, silent: false,
  };
}

export function foldRetrySchedule({ turn = 0, now = Date.now() } = {}) {
  return { retryTurn: Number(turn) + FOLD_RETRY_MIN_TURNS, retryAt: Number(now) + FOLD_RETRY_MIN_MS };
}

export function thresholdEnforceability() {
  return Object.freeze({
    enforced: false,
    hostMaxTokensConfigurable: false,
    reason: 'host main-model max_tokens is not exposed; only router-face 1024 is configurable',
    fallback: Object.freeze({
      outputReserveTokens: OUTPUT_RESERVE_LONG_TOKENS,
      inputHardLimitTokens: INPUT_HARD_LIMIT_LONG_TOKENS,
    }),
  });
}

function finiteNonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return number;
}

/**
 * Evaluate the shared-context budget. Pure; no I/O, no session read.
 * Returns an action for the caller to implement elsewhere (compact/handoff).
 */
export function evaluateThresholds({
  inputTokens,
  actualOutputTokens = null,
  longOutput = null,
  contextWindowTokens = CONTEXT_WINDOW_TOKENS,
  safetyTokens = SAFETY_TOKENS,
} = {}) {
  const input = finiteNonNegative(inputTokens, 'inputTokens');
  const context = finiteNonNegative(contextWindowTokens, 'contextWindowTokens');
  const safety = finiteNonNegative(safetyTokens, 'safetyTokens');
  // At the 350K strategy line we cannot know the real output, so default to
  // the long-output reserve; 192K is only used when normal output is explicit.
  // Unknown output length defaults to the long-output reserve; 192K requires
  // an explicit normal-output task marker.
  const effectiveLong = longOutput === null ? true : longOutput === true;
  const reserve = outputReserveTokens({ longOutput: effectiveLong });
  const hardLimit = inputHardLimitTokens({ longOutput: effectiveLong });
  const totalWithReserve = input + reserve + safety;

  if (totalWithReserve >= context || input >= hardLimit) {
    return {
      action: 'handoff',
      reason: totalWithReserve >= context ? 'input+reserve+safety>=context' : 'input>=inputHardLimit',
      inputTokens: input, reserveTokens: reserve, safetyTokens: safety,
      inputHardLimitTokens: hardLimit, outputReserveTokens: reserve,
      reserveMode: effectiveLong ? 'long' : 'normal',
      outputOverReserve: false,
    };
  }
  let outputOverReserve = false;
  if (actualOutputTokens !== null) {
    const output = finiteNonNegative(actualOutputTokens, 'actualOutputTokens');
    outputOverReserve = output >= reserve;
    if (input + output + safety >= context) {
      return {
        action: 'handoff', reason: 'input+actualOutput+safety>=context',
        inputTokens: input, actualOutputTokens: output, reserveTokens: reserve,
        safetyTokens: safety, inputHardLimitTokens: hardLimit,
        outputReserveTokens: reserve, outputOverReserve: true,
      };
    }
  }
  if (outputOverReserve) {
    return {
      action: 'switch-long-output-or-segment', reason: 'actualOutput>=reserve',
      inputTokens: input, actualOutputTokens: Number(actualOutputTokens),
      reserveTokens: reserve, safetyTokens: safety,
      inputHardLimitTokens: hardLimit, outputReserveTokens: reserve,
      reserveMode: effectiveLong ? 'long' : 'normal',
      nextReserveMode: 'long',
      outputOverReserve: true,
    };
  }
  if (input >= INPUT_COMPACT_AT_TOKENS && input >= 0) {
    return {
      action: 'compact', reason: 'input>=inputCompactAt',
      inputTokens: input, reserveTokens: reserve, safetyTokens: safety,
      inputHardLimitTokens: hardLimit, outputReserveTokens: reserve,
      reserveMode: effectiveLong ? 'long' : 'normal',
      outputOverReserve: false,
    };
  }
  return {
    action: 'ok', reason: 'within-budget',
    inputTokens: input, reserveTokens: reserve, safetyTokens: safety,
    inputHardLimitTokens: hardLimit, outputReserveTokens: reserve,
    reserveMode: effectiveLong ? 'long' : 'normal',
    outputOverReserve: false,
  };
}

/** Truncate-side view: direct cuts only; the 350K fold line is not a cut. */
export function evaluateTruncateBudget(options = {}) {
  const result = evaluateThresholds(options);
  if (result.action === 'compact') {
    return { ...result, action: 'ok', reason: 'within-truncate-budget' };
  }
  return result;
}
