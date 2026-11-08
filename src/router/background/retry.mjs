// retry.mjs — 裸 stream 调用方的 RATE_LIMIT 退避 / QUOTA 立刻停
//
// 宿主 dsh-llm 自己从不重试（README:93），重试属于 agent 的 failed-step
// 扩展点（dsh-llm-retry）。Router 后台面不走 agent loop 时，必须自己实现
// 同样的最小策略：
//   - RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE：指数退避重试
//   - QUOTA / ACCOUNT_QUOTA：不重试，整个 Router 停（quota_exceeded）
//   - AUTH / INVALID_CREDENTIAL / CONTEXT_WINDOW_EXCEEDED / NO_ADAPTER：不重试
//   - 有副作用之后的调用不重试（idempotent:false）
// 退避优先使用 failure.providerRetryAfterMs，其次 500ms 起、10s 封顶、±10% 抖动。

export const RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]);

export const STOP_CODES = Object.freeze(['QUOTA', 'ACCOUNT_QUOTA']);

export const FATAL_CODES = Object.freeze([
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'CONTEXT_WINDOW_EXCEEDED',
]);

export function classifyCode(code) {
  if (RETRYABLE_CODES.includes(code)) return 'retry';
  if (STOP_CODES.includes(code)) return 'stop';
  if (FATAL_CODES.includes(code)) return 'fatal';
  return 'unknown';
}

export function stopReasonFor(code) {
  if (STOP_CODES.includes(code)) return 'quota_exceeded';
  if (FATAL_CODES.includes(code)) {
    if (code === 'CONTEXT_WINDOW_EXCEEDED') return 'context_window_exceeded';
    if (code === 'AUTH' || code === 'INVALID_CREDENTIAL') return 'auth_failed';
    return 'llm_fatal';
  }
  return null;
}

export function computeBackoff({
  attempt,
  initialDelayMs = 500,
  maxDelayMs = 10000,
  jitterRatio = 0.1,
  random = Math.random,
} = {}) {
  const base = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = base * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.min(maxDelayMs, Math.round(base + jitter)));
}

export function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('aborted');
      error.code = 'E_ABORTED';
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      const error = new Error('aborted');
      error.code = 'E_ABORTED';
      reject(error);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function failureFromError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'E_UNKNOWN',
    message: String(error?.message ?? error),
    providerRetryAfterMs: error?.providerRetryAfterMs,
  };
}

/**
 * Retry-After 封顶：provider 给 99999 也不能让后台 tick 睡 100 秒。
 * 单独导出是为了能在不真睡 30s 的测试里断言生产默认值。
 */
export function capRetryAfter(ms, maxRetryAfterMs = 30000) {
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(0, ms), maxRetryAfterMs);
}

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];

/**
 * 累加每一次 attempt 的 usage —— 包括最终失败的那一次。
 * 评审 P26：第一次 attempt 花了 60 后 SERVER 失败，第二次花 30，旧实现只记 30；
 * provider 已经计费 90，预算必须按 90 扣。
 */
export function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  const next = total ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    legacy: false,
  };
  for (const field of USAGE_FIELDS) {
    const value = Number(usage[field]);
    if (Number.isFinite(value)) next[field] += value;
  }
  next.legacy = Boolean(next.legacy || usage.legacy);
  return next;
}

/**
 * 把一次 attempt 的 usage 累加进总数；fail-closed：
 * 任何字段是负数 / NaN / Infinity，整个 attempt 都不入账（不能出现 -20 回冲），
 * 并标记 invalidUsage，让 Router 记 0 或只记之前已确认的合法用量后停机。
 *
 * @returns {{usage:object, invalid:boolean}}
 */
export function accumulateUsage(total, usage) {
  const base = total ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    legacy: false,
  };
  if (!usage || typeof usage !== 'object') return { usage: base, invalid: false };

  let invalid = Boolean(usage.invalid);
  for (const field of USAGE_FIELDS) {
    const raw = usage[field];
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) invalid = true;
  }
  if (invalid) return { usage: base, invalid: true };

  const next = { ...base };
  for (const field of USAGE_FIELDS) {
    const raw = usage[field];
    if (raw === undefined || raw === null) continue;
    next[field] += Number(raw);
  }
  next.legacy = Boolean(next.legacy || usage.legacy);
  // 单调不减：即使上游传了负的差额，也绝不把累计值改小。
  for (const field of USAGE_FIELDS) {
    next[field] = Math.max(next[field], base[field] ?? 0);
  }
  return { usage: next, invalid: false };
}

/**
 * 调用一次可能失败的异步操作；失败按 code 分类决定是否重试。
 * call(attempt) 返回 { failure } 表示失败，返回其它对象表示成功。
 * 抛出的异常按 error.code 分类；AbortError 立即返回 aborted。
 *
 * @returns {Promise<object>} 最后一次结果 + { attempts, retryExhausted?, stopReason? }
 */
export async function retryOnFailure(call, {
  maxAttempts = 3,
  initialDelayMs = 500,
  maxDelayMs = 10000,
  jitterRatio = 0.1,
  random = Math.random,
  signal,
  onRetry,
  idempotent = true,
  maxRetryAfterMs = 30000,
} = {}) {
  let attempt = 0;
  let usageTotal = null;
  let attemptOverflow = false;
  while (true) {
    if (signal?.aborted) {
      return { failure: { code: 'E_ABORTED', message: 'aborted' }, aborted: true, attempts: attempt, usage: usageTotal };
    }
    attempt += 1;

    let result;
    try {
      result = await call(attempt);
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORTED' || signal?.aborted) {
        return { failure: { code: 'E_ABORTED', message: 'aborted' }, aborted: true, attempts: attempt, usage: usageTotal };
      }
      result = { failure: failureFromError(error) };
    }

    // 单次 attempt 的 usage 超过 callMaxTokens 也记下来；即使总和还在整段预留内，
    // 也必须 fail 任务（B：每次 attempt 上限是硬边界，不能靠「总额没超」混过去）。
    if (result?.attemptOverflow) attemptOverflow = true;

    const accumulated = accumulateUsage(usageTotal, result?.usage ?? result?.result?.usage);
    usageTotal = accumulated.usage;
    if (accumulated.invalid) {
      // P0/F5/F12：某次 attempt 的 usage 非法时立即 fail-closed，不重试、不回冲。
      return {
        ...(result ?? {}),
        ok: false,
        failure: null,
        usage: usageTotal,
        attempts: attempt,
        invalidUsage: true,
        attemptOverflow,
        retryExhausted: false,
      };
    }

    if (!result || !result.failure) {
      return { ...(result ?? {}), usage: usageTotal, attempts: attempt, attemptOverflow };
    }

    const code = result.failure.code ?? 'E_UNKNOWN';
    const kind = classifyCode(code);

    if (kind === 'stop' || kind === 'fatal') {
      return {
        ...result,
        usage: usageTotal,
        attempts: attempt,
        attemptOverflow,
        retryExhausted: false,
        stopReason: stopReasonFor(code),
      };
    }

    if (kind !== 'retry' || !idempotent || attempt >= maxAttempts) {
      return { ...result, usage: usageTotal, attempts: attempt, attemptOverflow, retryExhausted: kind === 'retry' };
    }

    const delayMs = Number.isFinite(result.failure.providerRetryAfterMs)
      ? capRetryAfter(result.failure.providerRetryAfterMs, maxRetryAfterMs)
      : computeBackoff({ attempt, initialDelayMs, maxDelayMs, jitterRatio, random });
    onRetry?.({ attempt, code, delayMs });
    try {
      await sleep(delayMs, signal);
    } catch {
      return { failure: { code: 'E_ABORTED', message: 'aborted' }, aborted: true, attempts: attempt, usage: usageTotal };
    }
  }
}
