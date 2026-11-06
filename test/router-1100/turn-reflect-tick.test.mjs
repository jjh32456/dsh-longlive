// C-02 / C-06: turn/end reflect 轻量整理必须真的跑一次模型；running 时
// status.nextTickAt 必须保持为下一次定时 tick（不能因为空队列被置 null）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { makeService, startedService } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function auditRecords(vaultDir) {
  const file = path.join(vaultDir, 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('C-02: turn/end completed enqueues a synthetic reflect pass with exactly one model call', async () => {
  const env = await startedService({ deps: { turnDebounceMs: 5 } });
  try {
    assert.equal(env.result.state, 'running');
    const delivered = env.service.handleSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' }, turn: 1 } });
    assert.equal(delivered.scheduled, true);

    for (let i = 0; i < 100 && env.llm.calls === 0; i += 1) await sleep(5);
    assert.equal(env.llm.calls, 1, 'turn/end reflect must call the model once');

    const records = auditRecords(env.vaultDir);
    const starts = records.filter((record) => record.kind === 'task.start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].type, 'reflect');
    assert.equal(starts[0].tier, 'reflect');

    // error / aborted turns must not trigger a model call.
    env.service.handleSessionEvent({ type: 'turn/end', data: { reason: { kind: 'error' }, turn: 2 } });
    env.service.handleSessionEvent({ type: 'turn/end', data: { reason: { kind: 'aborted' }, turn: 3 } });
    await sleep(40);
    assert.equal(env.llm.calls, 1, 'error/aborted turns must stay quiet');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('C-06: running service keeps nextTickAt as the next scheduled tick after an idle tick', async () => {
  const env = await startedService({
    config: { tickMs: 60 },
    deps: { firstTickMs: 5 },
  });
  try {
    assert.equal(env.result.state, 'running');
    await sleep(20);
    env.service.nextTickAt = new Date(Date.now() + 30000).toISOString();
    const before = env.service.status().nextTickAt;

    // Force one idle tick (no queued tasks): the old bug nulled nextTickAt here.
    const idle = await env.service.tick({ tier: 'reflect', reason: 'test-idle' });
    assert.equal(idle.ok, true);
    assert.equal(idle.idle, true);
    assert.equal(env.service.status().nextTickAt, before, 'idle tick must not null nextTickAt');
    assert.equal(env.service.status().nextTickAt, before);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('C-06: a successful tick also keeps nextTickAt (no null on completion)', async () => {
  const env = await startedService();
  try {
    assert.equal(env.result.state, 'running');
    const scheduled = new Date(Date.now() + 30000).toISOString();
    env.service.nextTickAt = scheduled;
    env.service.queue.writer.append({
      id: 'c06-task-1',
      type: 'question',
      payload: { question: 'nextTickAt 保持' },
      origin: 'test',
      depth: 0,
    });
    const done = await env.service.tick({ tier: 'reflect', reason: 'test-task' });
    assert.equal(done.ok, true);
    assert.equal(done.processed, 1);
    assert.equal(env.service.status().nextTickAt, scheduled, 'successful tick must not null nextTickAt');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});
