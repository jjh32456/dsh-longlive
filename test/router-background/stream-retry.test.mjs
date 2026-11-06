// test/stream-retry.test.mjs — 真实 stream 契约 + RATE_LIMIT/QUOTA 策略的验收测试
//
// 覆盖 mustFix 7（block 数组 / finish 失败码 / usage / abort 后 drain）与
// mustFix 9（RATE_LIMIT 退避、QUOTA 停、非幂等不重试）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessages,
  consumeStream,
  normalizeUsage,
} from '../../src/router/background/stream.mjs';
import {
  capRetryAfter,
  classifyCode,
  computeBackoff,
  retryOnFailure,
  stopReasonFor,
} from '../../src/router/background/retry.mjs';
import { MockLlm } from '../../src/router/background/mock-llm.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function* fromChunks(chunks, { onReturn } = {}) {
  try {
    for (const chunk of chunks) {
      if (chunk instanceof Error) throw chunk;
      if (chunk?.wait) await sleep(chunk.wait);
      else yield chunk;
    }
  } finally {
    onReturn?.();
  }
}

test('buildMessages：content 是 block 数组，空 system 不产生空消息', () => {
  const messages = buildMessages({ system: '你是路由器', prompt: '处理 t1' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.deepEqual(messages[0].content, [{ type: 'text', text: '你是路由器' }]);
  assert.equal(messages[1].role, 'user');
  assert.deepEqual(messages[1].content, [{ type: 'text', text: '处理 t1' }]);

  const noSystem = buildMessages({ system: '   ', prompt: 'hi' });
  assert.equal(noSystem.length, 1);
  assert.equal(noSystem[0].role, 'user');
  assert.equal(typeof noSystem[0].content, 'object');
  assert.ok(Array.isArray(noSystem[0].content));
});

test('normalizeUsage：camelCase 为主，snake_case 兼容并标 legacy，total 可显式覆盖、NaN 标 invalid', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 5 }), {
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, legacy: false, invalid: false,
  });
  const legacy = normalizeUsage({ input_tokens: 7, output_tokens: 3, total_tokens: 20 });
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.totalTokens, 20);
  assert.equal(legacy.inputTokens, 7);
  // F12：NaN 不得被洗成 0 当免费，必须标 invalid 交给 Router fail-closed。
  const nan = normalizeUsage({ inputTokens: NaN, outputTokens: 0 });
  assert.equal(nan.invalid, true);
  assert.ok(Number.isNaN(nan.totalTokens));
  const negative = normalizeUsage({ inputTokens: -5, outputTokens: 0 });
  assert.equal(negative.invalid, true);
  assert.equal(negative.inputTokens, -5);
  assert.equal(normalizeUsage(null), null);
});

test('consumeStream 正常路径：text-delta 拼接、usage、terminal finish', async () => {
  const stream = fromChunks([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你' },
    { type: 'text-delta', index: 0, text: '好' },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const result = await consumeStream(stream);
  assert.equal(result.ok, true);
  assert.equal(result.text, '你好');
  assert.equal(result.usage.totalTokens, 13);
  assert.equal(result.finish.kind, 'stop');
  assert.equal(result.finished, true);
  assert.equal(result.missingFinish, false);
  assert.equal(result.code, null);
});

test('consumeStream 失败 finish：读 chunk.reason.failure 的稳定错误码', async () => {
  const stream = fromChunks([
    { type: 'text-delta', index: 0, text: '部分' },
    {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 1200, status: 429 },
      },
    },
  ]);
  const result = await consumeStream(stream);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RATE_LIMIT');
  assert.equal(result.failure.message, 'slow down');
  assert.equal(result.failure.providerRetryAfterMs, 1200);
  assert.equal(result.aborted, false);
  assert.equal(result.finished, true);
});

test('consumeStream 缺 finish：返回 E_STREAM_NO_FINISH，不向外抛', async () => {
  const stream = fromChunks([
    { type: 'text-delta', index: 0, text: '半截' },
  ]);
  const result = await consumeStream(stream);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_STREAM_NO_FINISH');
  assert.equal(result.missingFinish, true);
  assert.equal(result.finished, false);
});

test('consumeStream abort：设置 aborted、drain 到 finish、始终 return() 清理', async () => {
  let returned = false;
  const controller = new AbortController();
  const stream = (async function* () {
    try {
      yield { type: 'text-delta', index: 0, text: 'a' };
      await sleep(30);
      yield { type: 'text-delta', index: 0, text: 'b' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } };
    } finally {
      returned = true;
    }
  })();

  const running = consumeStream(stream, { signal: controller.signal, drainTimeoutMs: 100 });
  await sleep(5);
  controller.abort('test');
  const result = await running;

  assert.equal(result.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.finished, true);
  assert.equal(result.finish.kind, 'aborted');
  assert.equal(result.code, 'ABORTED');
  assert.equal(result.text, 'a');
  assert.ok(result.drained >= 1);
  assert.equal(returned, true, 'generator finally 必须执行');
});

test('consumeStream abort 卡住：drain 超时后 return() 有时限，不永久挂起', async () => {
  let returned = false;
  const controller = new AbortController();
  const stream = (async function* () {
    try {
      yield { type: 'text-delta', index: 0, text: 'x' };
      await sleep(200);
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally {
      returned = true;
    }
  })();

  const started = Date.now();
  const running = consumeStream(stream, {
    signal: controller.signal,
    drainTimeoutMs: 20,
    returnTimeoutMs: 30,
  });
  await sleep(5);
  controller.abort('test');
  const result = await running;
  const elapsed = Date.now() - started;

  assert.equal(result.aborted, true);
  assert.equal(result.drainTimedOut, true);
  assert.equal(result.code, 'E_ABORTED');
  // P10：旧实现 await iterator.return() 无限期，tick 永远不 settle。
  assert.equal(result.returnTimedOut, true, 'return() 必须有超时标记');
  assert.ok(elapsed < 180, `consumeStream 返回耗时 ${elapsed}ms，不能等挂住的 generator`);

  // return() 仍然排在这个 generator 的队列里，等它自己的 sleep 结束后 finally 会执行。
  await sleep(260);
  assert.equal(returned, true, 'generator 最终仍应被清理，只是调用方不再等它');
});

test('consumeStream 输入不是 AsyncIterable：抛 E_STREAM_NOT_ASYNC_ITERABLE', async () => {
  await assert.rejects(
    () => consumeStream({ ok: true }),
    (error) => error.code === 'E_STREAM_NOT_ASYNC_ITERABLE',
  );
});

test('consumeStream chunk 上限：超限抛 E_STREAM_CHUNK_LIMIT', async () => {
  const many = [];
  for (let i = 0; i < 5; i += 1) many.push({ type: 'text-delta', index: 0, text: 'x' });
  await assert.rejects(
    () => consumeStream(fromChunks(many), { maxChunks: 3 }),
    (error) => error.code === 'E_STREAM_CHUNK_LIMIT',
  );
});

test('retryOnFailure：RATE_LIMIT 指数退避后成功，attempts 与 onRetry 正确', async () => {
  let attempts = 0;
  const retries = [];
  const result = await retryOnFailure(async (attempt) => {
    attempts += 1;
    if (attempt < 3) return { failure: { code: 'RATE_LIMIT', message: '429' } };
    return { ok: true, value: 'done' };
  }, {
    maxAttempts: 3,
    initialDelayMs: 1,
    jitterRatio: 0,
    onRetry: (event) => retries.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.value, 'done');
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
  assert.equal(retries.length, 2);
  assert.equal(retries[0].code, 'RATE_LIMIT');
  assert.equal(retries[0].delayMs, 1);
});

test('retryOnFailure：providerRetryAfterMs 优先于指数退避，且封顶 30s', async () => {
  const delays = [];
  const result = await retryOnFailure(async (attempt) => (
    attempt === 1
      ? { failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 7 } }
      : { ok: true }
  ), {
    maxAttempts: 2,
    initialDelayMs: 1,
    onRetry: (event) => delays.push(event.delayMs),
  });
  assert.equal(result.ok, true);
  assert.equal(delays[0], 7);

  // 生产默认上限就是 30s：provider 给多少都不能让后台 tick 睡更久。
  assert.equal(capRetryAfter(99999), 30000);
  assert.equal(capRetryAfter(-5), 0);

  // 为了不真睡 30s，这里把上限压到 25ms，断言「封顶逻辑」本身。
  const capped = [];
  await retryOnFailure(async () => ({ failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 99999 } }), {
    maxAttempts: 2,
    maxRetryAfterMs: 25,
    onRetry: (event) => capped.push(event.delayMs),
  });
  assert.deepEqual(capped, [25], 'provider Retry-After 必须被 maxRetryAfterMs 截断');
});

test('retryOnFailure：失败 attempt 的 usage 也计入总额（P26：60+30 必须记 90）', async () => {
  let calls = 0;
  const result = await retryOnFailure(async (attempt) => {
    calls += 1;
    if (attempt === 1) {
      return {
        failure: { code: 'SERVER', message: 'upstream 500' },
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
      };
    }
    return { ok: true, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
  }, { maxAttempts: 2, initialDelayMs: 1, jitterRatio: 0 });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.usage.totalTokens, 90, 'provider 已计费两次，预算必须按 90 扣');
  assert.equal(result.usage.inputTokens, 60);
  assert.equal(result.usage.outputTokens, 30);
});

test('retryOnFailure：QUOTA 立即停（quota_exceeded），不重试', async () => {
  let calls = 0;
  const result = await retryOnFailure(async () => {
    calls += 1;
    return { failure: { code: 'QUOTA', message: 'quota exhausted' } };
  }, { maxAttempts: 5, initialDelayMs: 1 });

  assert.equal(calls, 1);
  assert.equal(result.stopReason, 'quota_exceeded');
  assert.equal(result.failure.code, 'QUOTA');
});

test('retryOnFailure：AUTH 不重试（auth_failed），非幂等调用不重试', async () => {
  let authCalls = 0;
  const auth = await retryOnFailure(async () => {
    authCalls += 1;
    return { failure: { code: 'AUTH' } };
  }, { maxAttempts: 5 });
  assert.equal(authCalls, 1);
  assert.equal(auth.stopReason, 'auth_failed');

  let sideEffectCalls = 0;
  const nonIdempotent = await retryOnFailure(async () => {
    sideEffectCalls += 1;
    return { failure: { code: 'RATE_LIMIT' } };
  }, { maxAttempts: 5, idempotent: false });
  assert.equal(sideEffectCalls, 1);
  assert.equal(nonIdempotent.retryExhausted, true);
});

test('retryOnFailure：退避期间 abort 返回 E_ABORTED，不再发下一次', async () => {
  const controller = new AbortController();
  let calls = 0;
  const running = retryOnFailure(async () => {
    calls += 1;
    return { failure: { code: 'RATE_LIMIT' } };
  }, {
    maxAttempts: 5,
    initialDelayMs: 100,
    signal: controller.signal,
    onRetry: () => setTimeout(() => controller.abort('stop'), 5),
  });
  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.failure.code, 'E_ABORTED');
  assert.equal(calls, 1);
});

test('classifyCode / stopReasonFor / computeBackoff：错误码分类与抖动边界', () => {
  assert.equal(classifyCode('RATE_LIMIT'), 'retry');
  assert.equal(classifyCode('QUOTA'), 'stop');
  assert.equal(classifyCode('AUTH'), 'fatal');
  assert.equal(classifyCode('MOCK_CRASH'), 'unknown');
  assert.equal(stopReasonFor('ACCOUNT_QUOTA'), 'quota_exceeded');
  assert.equal(stopReasonFor('CONTEXT_WINDOW_EXCEEDED'), 'context_window_exceeded');
  assert.equal(stopReasonFor('RATE_LIMIT'), null);

  assert.equal(computeBackoff({ attempt: 1, initialDelayMs: 500, jitterRatio: 0 }), 500);
  assert.equal(computeBackoff({ attempt: 2, initialDelayMs: 500, jitterRatio: 0 }), 1000);
  assert.equal(computeBackoff({ attempt: 99, initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0 }), 10000);
  const jittered = computeBackoff({ attempt: 1, initialDelayMs: 1000, jitterRatio: 0.5, random: () => 0 });
  assert.equal(jittered, 500);
});

test('MockLlm：拒绝字符串 content，失败注入走 finish.reason.failure，abort 走 aborted finish', async () => {
  const bad = new MockLlm().stream({ messages: [{ role: 'user', content: 'hello' }] });
  await assert.rejects(async () => {
    for await (const _ of bad) { /* should throw before yield */ }
  }, (error) => error.code === 'E_MOCK_BAD_MESSAGES');

  const failing = new MockLlm({ failOn: new Map([['t1', 'RATE_LIMIT']]) });
  const result = await consumeStream(failing.stream({
    messages: buildMessages({ prompt: 'x' }),
    task: { id: 't1' },
  }));
  assert.equal(result.code, 'RATE_LIMIT');
  assert.equal(result.finished, true);

  const controller = new AbortController();
  controller.abort('test');
  const aborted = await consumeStream(new MockLlm().stream({
    messages: buildMessages({ prompt: 'x' }),
    task: { id: 't2' },
    signal: controller.signal,
  }));
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.code, 'ABORTED');
});
