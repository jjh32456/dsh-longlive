// mock-llm.mjs — 确定性 mock 模型（无网络、无凭据）
//
// 形状对齐宿主 ctx.llm.stream()（_hostsrc/dsh-llm README:47-57 / :93）：
//   - 返回 AsyncIterable<StreamChunk>，不是 Promise<{text, action}>；
//   - messages 的 content 必须是 block 数组；
//   - 块序列：block-start -> text-delta* -> usage -> finish；
//   - 失败也是 finish，reason = { kind:'error', failure:{code,...} }；
//   - abort 走 finish，reason = { kind:'aborted', failure:{code:'ABORTED'} }；
//   - usage 是 camelCase，totalTokens 显式给出。
//
// action 用文本协议传递（真实模型走 tool-call-delta，这里保持可读、可断言）：
//   最后一行是 `ACTION: {"type":"note",...}`，Router 解析它。

import { normalizeUsage } from './stream.mjs';

export class MockLlmError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'MockLlmError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/** 宿主只接受 block 数组；mock 也照此校验，避免测试掩盖契约错误。 */
export function assertBlockMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new MockLlmError('messages must be a non-empty array', 'E_MOCK_BAD_MESSAGES');
  }
  for (const message of messages) {
    if (!message || typeof message.role !== 'string' || !Array.isArray(message.content)) {
      throw new MockLlmError('each message.content must be a block array', 'E_MOCK_BAD_MESSAGES');
    }
    for (const block of message.content) {
      if (!block || typeof block.type !== 'string') {
        throw new MockLlmError('message content blocks need a type', 'E_MOCK_BAD_MESSAGES');
      }
    }
  }
}

function usageFrom(raw) {
  const normalized = normalizeUsage(raw);
  return normalized ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, legacy: false };
}

function failureSpec(value) {
  if (!value) return null;
  if (value === 'crash') return { code: 'MOCK_CRASH', message: 'mock backend crashed' };
  if (typeof value === 'string') return { code: value, message: `mock failure ${value}` };
  if (typeof value === 'object' && typeof value.code === 'string') {
    return { message: `mock failure ${value.code}`, ...value };
  }
  return { code: 'MOCK_CRASH', message: 'mock backend crashed' };
}

export class MockLlm {
  /**
   * @param {object} options
   * @param {object|Function} [options.usage] {inputTokens,outputTokens} 或 (task)=>usage
   * @param {Map<string, string|object>} [options.failOn] 任务 id/type/'*' -> code 或 {code,times,...}
   * @param {number|Function} [options.delayMs]
   * @param {Function|string} [options.text] 自定义正文
   * @param {Function} [options.actionFor] (task)=>action
   * @param {string} [options.finishKind='stop']
   */
  constructor({
    usage = { inputTokens: 120, outputTokens: 30 },
    failOn = new Map(),
    delayMs = 0,
    text = null,
    actionFor = null,
    finishKind = 'stop',
    provider = 'mock',
    model = 'mock-1',
  } = {}) {
    this.provider = provider;
    this.model = model;
    this.usage = usage;
    this.failOn = failOn;
    this.delayMs = delayMs;
    this.text = text;
    this.actionFor = actionFor;
    this.finishKind = finishKind;
    this.calls = 0;
    this.attempts = new Map();
    this.lastRequest = null;
    this.requests = [];
  }

  #failureFor(task, key) {
    if (!key) return null;
    const spec = failureSpec(this.failOn.get(key));
    if (!spec) return null;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    if (Number.isInteger(spec.times) && attempt > spec.times) return null;
    if (Number.isInteger(spec.skipTimes) && attempt <= spec.skipTimes) return null;
    return spec;
  }

  #action(task) {
    if (typeof this.actionFor === 'function') return this.actionFor(task);
    return { type: 'note', task_id: task?.id ?? null, note: `mock: ${task?.id ?? 'unknown'}` };
  }

  #text(task, action) {
    if (typeof this.text === 'function') return this.text(task, action);
    if (typeof this.text === 'string' && this.text.length > 0) {
      return `${this.text}\nACTION: ${JSON.stringify(action)}`;
    }
    return `mock: 处理 ${task?.id ?? 'unknown'}\nACTION: ${JSON.stringify(action)}`;
  }

  /**
   * 真实签名的核心：返回 AsyncIterable，而不是 Promise。
   * @returns {AsyncGenerator<object>}
   */
  async *stream({ messages, task, signal, maxTokens } = {}) {
    this.calls += 1;
    this.lastRequest = { messages, task, maxTokens, signal };
    this.requests.push(this.lastRequest);
    assertBlockMessages(messages);

    const key = task?.id ?? task?.type ?? null;
    const failure = this.#failureFor(task, key);
    const delay = typeof this.delayMs === 'function' ? this.delayMs(task) : this.delayMs;

    if (signal?.aborted) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted before stream' } },
      };
      return;
    }

    if (delay > 0) {
      await sleep(delay, signal);
      if (signal?.aborted) {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted during delay' } },
        };
        return;
      }
    }

    yield { type: 'block-start', index: 0, blockType: 'text' };

    if (failure) {
      // 失败也可以带 usage（真适配器会在 finish 前报已消耗量）；重试累计需要它。
      if (failure.usage) {
        yield { type: 'usage', usage: usageFrom(failure.usage) };
      }
      // 失败可以是到达 finish 才暴露；真实适配器也允许先有 block-start。
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: failure.code,
            message: failure.message,
            providerRetryAfterMs: failure.providerRetryAfterMs,
            status: failure.status,
          },
        },
      };
      return;
    }

    const action = this.#action(task);
    const text = this.#text(task, action);
    const split = text.length > 1 ? Math.ceil(text.length / 2) : text.length;
    for (const delta of [text.slice(0, split), text.slice(split)].filter(Boolean)) {
      if (signal?.aborted) {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted mid-text' } },
        };
        return;
      }
      yield { type: 'text-delta', index: 0, text: delta };
    }

    const rawUsage = typeof this.usage === 'function' ? this.usage(task) : this.usage;
    const usage = usageFrom(rawUsage);
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: { kind: this.finishKind } };
  }
}
