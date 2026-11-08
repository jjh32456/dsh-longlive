// stream.mjs — 按宿主 ctx.llm.stream() 的真实契约消费 AsyncIterable<StreamChunk>
//
// 宿主契约（_hostsrc/dsh-llm，README:47-57 / :93，assembler.js:33-84）：
//   - 请求 messages 的 content 是 block 数组：[{ type:'text', text }]
//   - chunk 类型：block-start / text-delta / reasoning-delta /
//     tool-call-delta / block-end / usage / finish
//   - 每个流恰好以一个 finish 结束；失败是 { kind:'error', failure }，
//     取消是 { kind:'aborted', failure }，failure 在 chunk.reason.failure 里
//   - usage 是 camelCase：{ inputTokens, outputTokens, cacheReadTokens, ... }
//   - 服务本身不重试；RATE_LIMIT 等退避由 retry.mjs 负责
//
// 本模块只做「消费」，不重试、不执行动作；missing finish 视为协议错误，
// 由 Router 记成 task.error，而不是让 tick reject。

export const STREAM_PROTOCOL_ERRORS = Object.freeze([
  'E_STREAM_NOT_ASYNC_ITERABLE',
  'E_STREAM_NO_FINISH',
  'E_STREAM_CHUNK_LIMIT',
]);

/**
 * 保留原始数字，不把 NaN 洗成 0（F12：NaN usage 曾被当免费）。
 * 缺失字段按 0；出现非有限数/负数时只打 invalid 标记，由 Router fail-closed。
 */
const asNumber = (value, state) => {
  if (value === undefined || value === null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) state.invalid = true;
  return Number.isFinite(n) ? n : NaN;
};

/** 把 chunk.usage 规范成 camelCase 计数；兼容 snake_case mock，并打 legacy 标记。 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const state = { invalid: false };
  const legacy = !('inputTokens' in raw) && ('input_tokens' in raw);
  const inputTokens = asNumber(raw.inputTokens ?? raw.input_tokens, state);
  const outputTokens = asNumber(raw.outputTokens ?? raw.output_tokens, state);
  const cacheReadTokens = asNumber(raw.cacheReadTokens ?? raw.cache_read_tokens, state);
  const cacheWriteTokens = asNumber(raw.cacheWriteTokens ?? raw.cache_write_tokens, state);
  const explicitTotal = raw.totalTokens ?? raw.total_tokens;
  const totalTokens = explicitTotal === undefined
    ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    : asNumber(explicitTotal, state);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    legacy,
    invalid: state.invalid,
  };
}

/** 构造宿主接受的 messages：content 必须是 block 数组。 */
export function buildMessages({ system, prompt }) {
  const messages = [];
  if (typeof system === 'string' && system.trim() !== '') {
    messages.push({ role: 'system', content: [{ type: 'text', text: system }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] });
  return messages;
}

function normalizeFailure(failure, fallbackCode) {
  if (failure && typeof failure === 'object') {
    return {
      code: typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : fallbackCode,
      message: typeof failure.message === 'string' ? failure.message : String(failure.message ?? fallbackCode),
      status: failure.status,
      providerRetryAfterMs: failure.providerRetryAfterMs,
      requestId: failure.requestId,
    };
  }
  return { code: fallbackCode, message: typeof failure === 'string' ? failure : fallbackCode };
}

function normalizeFinish(reason) {
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason;
  return { kind: typeof reason === 'string' ? reason : 'unknown' };
}

/**
 * 消费一个 AsyncIterable<StreamChunk>。
 *
 * @param {AsyncIterable} stream
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {(chunk: object) => void} [options.onDelta]
 * @param {number} [options.maxChunks] 防御性上限
 * @param {number} [options.drainTimeoutMs] abort 后等待下一个 chunk 的宽限
 * @param {number} [options.maxDrainChunks] abort 后最多再吞多少 chunk
 * @param {number} [options.returnTimeoutMs] 关闭迭代器的上限（防 P10 永挂）
 */
export async function consumeStream(stream, {
  signal,
  onDelta,
  maxChunks = 20000,
  drainTimeoutMs = 50,
  maxDrainChunks = 1000,
  returnTimeoutMs = 100,
} = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    const error = new Error('llm.stream() did not return an AsyncIterable');
    error.code = 'E_STREAM_NOT_ASYNC_ITERABLE';
    throw error;
  }

  const iterator = stream[Symbol.asyncIterator]();
  let aborted = Boolean(signal?.aborted);
  let finished = false;
  let finishReason = null;
  let text = '';
  let usage = null;
  let chunks = 0;
  let drained = 0;
  let drainTimedOut = false;
  let returnTimedOut = false;

  let pendingNext = null;
  const pull = () => {
    if (pendingNext === null) {
      pendingNext = iterator.next().finally(() => { pendingNext = null; });
    }
    return pendingNext;
  };

  let resolveAbort;
  const abortGate = new Promise((resolve) => { resolveAbort = resolve; });
  const onAbort = () => {
    aborted = true;
    resolveAbort({ abort: true });
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  const withTimeout = (promise, timeoutMs) => {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  try {
    while (true) {
      if (chunks >= maxChunks) {
        const error = new Error(`stream exceeded ${maxChunks} chunks`);
        error.code = 'E_STREAM_CHUNK_LIMIT';
        throw error;
      }

      let stepped;
      try {
        if (aborted) {
          stepped = await withTimeout(
            pull().then((value) => ({ value }), (error) => ({ error })),
            drainTimeoutMs,
          );
          if (stepped.timeout) {
            drainTimedOut = true;
            break;
          }
          if (stepped.error) {
            if (stepped.error?.name === 'AbortError' || stepped.error?.code === 'ABORTED') break;
            throw stepped.error;
          }
        } else {
          stepped = await Promise.race([
            pull().then((value) => ({ value }), (error) => ({ error })),
            abortGate,
          ]);
          if (stepped.abort) continue;
          if (stepped.error) throw stepped.error;
        }
      } catch (error) {
        if (aborted && (error?.name === 'AbortError' || error?.code === 'ABORTED')) break;
        throw error;
      }

      const step = stepped.value;
      if (!step || step.done) break;
      const chunk = step.value;
      chunks += 1;

      // terminal chunk：即使正在 abort，也要把 finish 收掉。
      if (chunk?.type === 'finish') {
        finishReason = normalizeFinish(chunk.reason);
        finished = true;
        break;
      }

      if (aborted) {
        drained += 1;
        if (chunk?.type === 'usage') usage = normalizeUsage(chunk.usage) ?? usage;
        if (drained >= maxDrainChunks) break;
        continue;
      }

      switch (chunk?.type) {
        case 'text-delta':
          if (typeof chunk.text === 'string') text += chunk.text;
          onDelta?.(chunk);
          break;
        case 'usage':
          usage = normalizeUsage(chunk.usage) ?? usage;
          break;
        default:
          // block-start / block-end / reasoning-delta / tool-call-delta 等
          // 由上层按需处理；这里保持前向兼容，不因未知 chunk 打断。
          break;
      }
    }
  } finally {
    if (signal) signal.removeEventListener?.('abort', onAbort);
    if (pendingNext) {
      pendingNext.catch(() => { /* the abandoned next() must not reject unhandled */ });
    }
    // 即使已经收到 finish，也关闭迭代器让生成器的 finally 执行；
    // 但 return() 必须有时限：评审 P10 的生成器 return() 永不 resolve，
    // 旧实现让整个 tick（以及 stop 的 awaitInflight）永久挂住。
    if (typeof iterator.return === 'function') {
      try {
        const closing = Promise.resolve().then(() => iterator.return());
        closing.catch(() => { /* 关闭失败不能变成未处理 rejection */ });
        const outcome = await withTimeout(closing.then(() => ({ closed: true }), (error) => ({ error })), returnTimeoutMs);
        if (outcome.timeout) returnTimedOut = true;
      } catch {
        /* best-effort：关闭迭代器失败不应吞掉已经收到的 finish/usage */
      }
    }
  }

  let failure = null;
  let missingFinish = false;

  if (finished) {
    const kind = finishReason?.kind;
    if (kind === 'error') {
      failure = normalizeFailure(finishReason.failure, 'E_STREAM_FAILURE');
    } else if (kind === 'aborted') {
      aborted = true;
      failure = normalizeFailure(finishReason.failure, 'E_ABORTED');
    }
  } else {
    missingFinish = true;
    if (aborted) {
      failure = { code: 'E_ABORTED', message: 'stream aborted before finish' };
    } else {
      failure = {
        code: 'E_STREAM_NO_FINISH',
        message: 'stream ended without a terminal finish chunk',
      };
    }
  }

  return {
    ok: !failure && !aborted,
    text,
    usage,
    finish: finishReason,
    failure,
    aborted,
    missingFinish,
    finished,
    chunks,
    drained,
    drainTimedOut,
    returnTimedOut,
    code: failure?.code ?? null,
  };
}
