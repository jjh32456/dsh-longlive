import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { makeService } from './helpers.mjs';

function auditRecords(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('model auto with no host resolver stays unresolved and blocks instead of guessing', async () => {
  const env = makeService({ config: { model: 'auto' } });
  try {
    const result = await env.service.start();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'E_NO_PROVIDER');
    assert.equal(result.state, 'blocked');
    const status = env.service.status();
    assert.deepEqual(status.model, { auto: true, resolved: null, resolvedAt: null });
    assert.equal(status.state, 'blocked');
    // 只在内存里解析，绝不回写配置，也不把字面量 "auto" 当模型发出去。
    assert.equal(env.config.model, 'auto');
    assert.equal(env.service.config.model, 'auto');
    // 启动在 initPaths 之前就 blocked，不留 audit 目录。
    assert.equal(status.files.audit, '');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('the daily window rolls over at local midnight instead of carrying yesterday forever', async () => {
  let clock = new Date('2026-11-05T10:00:00+08:00');
  const env = makeService({
    config: { maxTokensPerDay: 5000, maxTokensPerRun: 50000 },
    deps: { now: () => clock },
  });
  try {
    const result = await env.service.start();
    assert.equal(result.state, 'running');
    // 模拟当天已经用掉 4900，然后时钟跨到第二天。
    env.service.dayUsage = {
      day: '2026-11-05',
      usedTokens: 4900,
      reservedTokens: 0,
      capTokens: 5000,
      runs: [],
    };
    clock = new Date('2026-11-06T10:00:00+08:00');
    await env.service.tick({ tier: 'reflect', reason: 'test' });
    const status = env.service.status();
    assert.equal(status.today.day, '2026-11-06');
    assert.equal(status.today.usedTokens, 0);
    assert.equal(status.state, 'running');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('model auto resolves the newest non-preview model into status only', async () => {
  const env = makeService({ config: { model: 'auto' } });
  env.llm.listModels = async ({ provider }) => {
    assert.equal(provider, 'mock');
    return {
      models: [
        { id: 'mock-2-preview' },
        { id: 'mock-3' },
        { name: 'mock-4-experimental' },
      ],
    };
  };
  try {
    const result = await env.service.start();
    assert.equal(result.ok, true);
    assert.equal(result.state, 'running');
    const status = env.service.status();
    assert.equal(status.model.auto, true);
    assert.equal(status.model.resolved, 'mock-3');
    assert.equal(typeof status.model.resolvedAt, 'string');
    assert.equal(env.config.model, 'auto');
    assert.equal(env.service.config.model, 'auto');
    const start = auditRecords(status.files.audit).filter((record) => record.kind === 'router.start').pop();
    assert.equal(start.model, 'mock-3');
    assert.equal(start.model_auto, true);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});
