import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { makeService, startedService, taskInput } from './helpers.mjs';

function auditFile(env) {
  return path.join(env.vaultDir, 'audit.jsonl');
}

function kinds(env) {
  return fs.readFileSync(auditFile(env), 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
}

test('disabled service starts without creating any file or timer state', async () => {
  const env = makeService({ config: { enabled: false } });
  try {
    const result = await env.service.start();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_DISABLED');
    assert.equal(result.state, 'stopped');
    assert.equal(fs.existsSync(env.vaultDir), false);
    assert.equal(env.service.status().state, 'stopped');
    assert.equal(env.service.status().reason, 'disabled');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('no registered llm waits with waiting_provider, backs off, and still writes an observable status', async () => {
  const env = makeService({ llm: null });
  try {
    const result = await env.service.start();
    assert.equal(result.ok, false);
    assert.equal(result.state, 'waiting_provider');
    assert.equal(result.lastError, null);
    const status = env.service.status();
    assert.equal(status.state, 'waiting_provider');
    assert.equal(status.provider.configured, false);
    assert.equal(status.provider.missing, true);
    assert.ok(status.provider.waitAttempts >= 1);
    assert.equal(typeof status.provider.nextRetryAt, 'string');
    // waiting_provider 也要可观测：vault + status.json 必须落盘（面板契约 v2.3 §6.5）
    assert.equal(fs.existsSync(env.vaultDir), true);
    const statusFile = path.join(env.vaultDir, 'status.json');
    assert.equal(fs.existsSync(statusFile), true, 'waiting_provider must write status.json');
    const onDisk = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.equal(onDisk.state, 'waiting_provider');
    assert.equal(onDisk.provider.missing, true);
    const tick = await env.service.tick({ manual: true });
    assert.equal(tick.ok, false);
    assert.equal(tick.code, 'E_NOT_RUNNING');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('start reaches running, writes status/audit, and stop is idempotent with one router.stop', async () => {
  const env = await startedService();
  try {
    assert.equal(env.result.ok, true);
    assert.equal(env.result.state, 'running');
    assert.equal(fs.existsSync(auditFile(env)), true);
    const status = JSON.parse(fs.readFileSync(path.join(env.vaultDir, 'status.json'), 'utf8'));
    assert.equal(status.v, 2);
    assert.equal(status.state, 'running');
    assert.deepEqual(status.provider, { configured: true, missing: false });
    assert.deepEqual(status.model, {
      auto: false,
      resolved: 'mock-1',
      resolvedAt: status.model.resolvedAt,
    });
    assert.equal(typeof status.model.resolvedAt, 'string');
    assert.deepEqual(Object.keys(status.today).sort(), ['capTokens', 'day', 'reservedTokens', 'usedTokens']);
    assert.deepEqual(Object.keys(status.run).sort(), ['capTokens', 'usedTokens']);
    assert.deepEqual(Object.keys(status.tickQueue).sort(), ['invalid', 'oldestAgeMs', 'pending']);
    assert.deepEqual(Object.keys(status.queue).sort(), ['applying', 'blockedOnUser', 'expired', 'pending', 'queued']);
    assert.equal(status.board.pulse.unknownSessions, 0);
    assert.equal(Array.isArray(status.warnings), true);
    for (const key of ['vault', 'board', 'audit', 'ledger', 'anchor', 'outbox']) assert.equal(typeof status.files[key], 'string');

    const first = await env.service.stop('test');
    assert.equal(first.state, 'stopped');
    const second = await env.service.stop('test-again');
    assert.equal(second.state, 'stopped');
    const stops = kinds(env).filter((kind) => kind === 'router.stop');
    assert.equal(stops.length, 1);
    assert.equal(fs.readFileSync(path.join(env.vaultDir, 'status.json'), 'utf8').includes('"state":"stopped"'), true);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('tick is single-flight and requestTick reports E_BUSY synchronously', async () => {
  const env = await startedService({ llmOptions: { delayMs: 30 } });
  try {
    env.service.queue.writer.append(taskInput('busy-1'));
    const first = env.service.tick({ tier: 'reflect', reason: 'test' });
    const second = await env.service.tick({ tier: 'reflect', reason: 'test' });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'E_BUSY');
    const requested = env.service.requestTick({ tier: 'reflect', reason: 'test' });
    assert.equal(requested.ok, false);
    assert.equal(requested.code, 'E_BUSY');
    const done = await first;
    assert.equal(done.ok, true);
    assert.equal(done.processed, 1);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('manual tick resumes a soft block, but a hard ledger block stays blocked', async () => {
  const env = await startedService();
  try {
    await env.service.block('E_NO_PROVIDER', 'temporary');
    assert.equal(env.service.status().state, 'blocked');
    const resumed = await env.service.tick({ manual: true, tier: 'reflect' });
    assert.equal(resumed.ok, true);
    assert.equal(env.service.status().state, 'running');

    await env.service.block('E_LEDGER_TAMPERED', 'hard');
    const denied = await env.service.tick({ manual: true, tier: 'reflect' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'E_NOT_RUNNING');
    assert.equal(env.service.status().state, 'blocked');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('turn/end only wakes on completed, debounces, and coalesces for five minutes', async () => {
  const env = await startedService({ deps: { turnDebounceMs: 5000 } });
  try {
    assert.deepEqual(env.service.handleSessionEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } }), {
      scheduled: false, ignored: true, reason: 'not_completed',
    });
    assert.deepEqual(env.service.handleSessionEvent({ type: 'message' }), {
      scheduled: false, ignored: true, reason: 'not_turn_end',
    });
    const first = env.service.handleSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    assert.equal(first.scheduled, true);
    const second = env.service.handleSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    assert.equal(second.scheduled, false);
    assert.equal(second.debounced, true);

    env.service.reflectTimer = null; // simulate the debounce firing without waiting
    env.service.lastTurnReflectAt = Date.now();
    const coalesced = env.service.handleSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    assert.equal(coalesced.coalesced, true);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('ask enqueues a question task, truncates at 500 chars, and writes through queue.writer', async () => {
  const env = await startedService({ deps: { manualDelayMs: 60000 } });
  try {
    const result = await env.service.ask({ question: '问'.repeat(600), tier: 'reflect' });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.match(result.taskId, /^ask-/);
    const lines = fs.readFileSync(path.join(env.vaultDir, 'queue.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const task = lines.find((entry) => entry.id === result.taskId);
    assert.ok(task);
    assert.equal(task.origin, 'tool');
    assert.equal(task.depth, 0);
    assert.equal(Array.from(task.payload.question).length, 500);
    assert.equal(result.tick.accepted, true);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('a second service on a live vault stays standby without writing audit', async () => {
  const first = await startedService();
  const second = makeService({ temp: first.temp, memoryRoot: first.memoryRoot, vaultDir: first.vaultDir, memory: false });
  try {
    const result = await second.service.start();
    assert.equal(result.ok, true);
    assert.equal(result.state, 'standby');
    assert.equal(first.service.status().state, 'running');
    const records = fs.readFileSync(auditFile(first), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.run_id === second.service.runId).length, 0);
  } finally {
    await second.service.dispose();
    await first.service.dispose();
    first.cleanup();
  }
});

test('stop aborts an in-flight call and records a single stop reason', async () => {
  const env = await startedService({ llmOptions: { delayMs: 200 } });
  try {
    env.service.queue.writer.append(taskInput('slow-1'));
    const running = env.service.tick({ tier: 'reflect' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopped = await env.service.stop('test-abort');
    assert.equal(stopped.state, 'stopped');
    const tickResult = await running;
    assert.equal(tickResult.processed, 1);
    const records = fs.readFileSync(auditFile(env), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.kind === 'router.stop').length, 1);
    const abortRecord = records.find((record) => record.kind === 'task.error');
    assert.ok(abortRecord, 'aborted task should be audited as task.error');
    assert.equal(abortRecord.code, 'E_ABORTED');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});
