import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AuditLog } from '../../src/router/background/audit.mjs';
import { BudgetLedger } from '../../src/router/background/budget-ledger.mjs';
import { makeService, startedService, taskInput } from './helpers.mjs';

function auditRecords(vaultDir) {
  return fs.readFileSync(path.join(vaultDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function seedOldRun(vaultDir, { used = 0, runId = 'old-run', auditSettle = null } = {}) {
  const runDir = path.join(vaultDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const ledgerFile = path.join(runDir, 'budget.ledger.jsonl');
  if (used > 0) {
    const ledger = new BudgetLedger({ file: ledgerFile, runId, maxTokens: 50000 });
    const reserved = ledger.reserve({ taskId: `${runId}-task`, tokens: used, owner: runId, tick: 1 });
    assert.equal(reserved.ok, true);
    const settled = ledger.settle({ id: reserved.id, tokens: used });
    assert.equal(settled.ok, true);
  } else {
    fs.writeFileSync(ledgerFile, '');
  }
  if (auditSettle !== null) {
    const audit = new AuditLog({ file: path.join(vaultDir, 'audit.jsonl'), runId });
    audit.open();
    audit.append('router.start', { run_id: runId });
    audit.append('budget.settle', { run_id: runId, task_id: `${runId}-task`, tokens: auditSettle });
    audit.append('router.stop', { run_id: runId });
    audit.close();
  }
  return runDir;
}

test('a normal tick reserves and settles the actual usage, never the reservation', async () => {
  const env = await startedService();
  try {
    env.service.queue.writer.append(taskInput('settle-1'));
    const result = await env.service.tick({ tier: 'reflect', reason: 'test' });
    assert.equal(result.ok, true);
    assert.equal(result.processed, 1);
    const records = auditRecords(env.vaultDir);
    const reserve = records.find((record) => record.kind === 'budget.reserve' && record.task_id === 'settle-1');
    const settle = records.find((record) => record.kind === 'budget.settle' && record.task_id === 'settle-1');
    assert.ok(reserve);
    assert.ok(settle);
    assert.ok(reserve.tokens > 150, `reservation ${reserve.tokens} should exceed actual usage`);
    assert.equal(settle.tokens, 150);
    assert.equal(settle.usage_estimated, false);
    assert.equal(env.service.status().run.usedTokens, 150);
    const ledgerLines = fs.readFileSync(path.join(env.vaultDir, 'runs', env.service.runId, 'budget.ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(ledgerLines.map((line) => line.op), ['reserve', 'settle']);
    assert.equal(ledgerLines[1].tokens, 150);
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('budget exhaustion blocks, leaves the task queued, and never calls the model', async () => {
  const env = await startedService({ config: { maxTokensPerRun: 5000 } });
  try {
    // 4900 leaves 100: even the reflect reservation (>= ~200) cannot fit, so no degrade.
    const adopted = env.service.ledger.adopt({ used: 4900, reason: 'test preuse' });
    assert.equal(adopted.ok, true);
    env.service.queue.writer.append(taskInput('no-budget'));
    const result = await env.service.tick({ tier: 'full', reason: 'test' });
    assert.equal(result.ok, true);
    assert.equal(env.service.status().state, 'blocked');
    assert.equal(env.service.status().lastError.code, 'E_BUDGET_EXHAUSTED');
    assert.equal(env.llm.calls, 0);
    const pending = env.service.queue.pending(env.service.seen);
    assert.equal(pending.tasks.length, 1);
    assert.equal(pending.tasks[0].id, 'no-budget');
    const kinds = auditRecords(env.vaultDir).map((record) => record.kind);
    assert.ok(kinds.includes('budget.exceeded'));
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('full does not fit but reflect does: degrade, audit it, and make one reflect call', async () => {
  const env = await startedService({ config: { maxTokensPerRun: 5000 } });
  try {
    const adopted = env.service.ledger.adopt({ used: 3300, reason: 'test preuse' });
    assert.equal(adopted.ok, true);
    env.service.queue.writer.append(taskInput('degrade-1', { payload: { question: '问'.repeat(2000) } }));
    const result = await env.service.tick({ tier: 'full', reason: 'test' });
    assert.equal(result.ok, true);
    assert.equal(env.llm.calls, 1);
    const records = auditRecords(env.vaultDir);
    const degrade = records.find((record) => record.kind === 'budget.degrade');
    assert.ok(degrade, 'degrade must be audited');
    assert.equal(degrade.from, 'full');
    assert.equal(degrade.to, 'reflect');
    assert.equal(degrade.reason, 'reserve_not_fit');
    assert.equal(env.service.status().state, 'running');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('daily cap across an older run blocks a new tick without a second call', async () => {
  const temp = fs.mkdtempSync(path.join(requireTmp(), 'longlive-router-day-'));
  const memoryRoot = path.join(temp, 'memory');
  const vaultDir = path.join(temp, 'vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const env = makeService({ temp, memoryRoot, vaultDir, memory: false, config: { allowMissingAnchor: true, maxTokensPerDay: 5000 } });
  try {
    seedOldRun(vaultDir, { used: 4900, runId: 'yesterday-run' });
    const started = await env.service.start();
    assert.equal(started.state, 'running');
    env.service.queue.writer.append(taskInput('day-cap'));
    const result = await env.service.tick({ tier: 'full', reason: 'test' });
    assert.equal(result.ok, true);
    assert.equal(env.service.status().state, 'blocked');
    assert.equal(env.service.status().lastError.code, 'E_BUDGET_EXHAUSTED');
    assert.equal(env.llm.calls, 0);
    assert.equal(env.service.status().tickQueue.pending, 1);
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('usage above the reservation is an overshoot: record it and stop', async () => {
  const env = await startedService({
    llmOptions: { usage: { inputTokens: 5000, outputTokens: 100 } },
    config: { maxTokensPerRun: 50000 },
  });
  try {
    env.service.queue.writer.append(taskInput('overshoot-1'));
    const result = await env.service.tick({ tier: 'reflect', reason: 'test' });
    assert.equal(result.ok, true);
    assert.equal(env.service.status().state, 'stopped');
    assert.equal(env.service.status().lastError.code, 'E_BUDGET_OVERSHOOT');
    const kinds = auditRecords(env.vaultDir).map((record) => record.kind);
    assert.ok(kinds.includes('budget.overshoot'));
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});

test('startup reconcile repairs a crash window from the ledger side and audits it', async () => {
  const temp = fs.mkdtempSync(path.join(requireTmp(), 'longlive-router-reconcile-'));
  const memoryRoot = path.join(temp, 'memory');
  const vaultDir = path.join(temp, 'vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const env = makeService({
    temp,
    memoryRoot,
    vaultDir,
    memory: false,
    config: { allowMissingAnchor: true },
  });
  try {
    seedOldRun(vaultDir, { used: 120, runId: 'crashed-run' });
    const started = await env.service.start();
    assert.equal(started.state, 'running');
    const reconcile = auditRecords(vaultDir).find((record) => record.kind === 'audit.reconcile');
    assert.ok(reconcile, 'audit.reconcile must be written');
    assert.equal(reconcile.run_id, 'crashed-run');
    assert.equal(reconcile.delta, 120);
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('audit settles more than the ledger: fail closed as E_LEDGER_TAMPERED', async () => {
  const temp = fs.mkdtempSync(path.join(requireTmp(), 'longlive-router-tamper-'));
  const memoryRoot = path.join(temp, 'memory');
  const vaultDir = path.join(temp, 'vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const env = makeService({ temp, memoryRoot, vaultDir, memory: false });
  try {
    seedOldRun(vaultDir, { used: 0, runId: 'ghost-run', auditSettle: 100 });
    const started = await env.service.start();
    assert.equal(started.state, 'blocked');
    assert.equal(started.lastError.code, 'E_LEDGER_TAMPERED');
    const panel = env.service.status();
    assert.ok(panel.warnings.includes('E_LEDGER_TAMPERED'));
    assert.ok(panel.alerts.some((alert) => alert.code === 'E_LEDGER_TAMPERED'));
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('missing historical anchor blocks unless routerAllowMissingAnchor is true', async () => {
  const temp = fs.mkdtempSync(path.join(requireTmp(), 'longlive-router-anchor-'));
  const memoryRoot = path.join(temp, 'memory');
  const vaultDir = path.join(temp, 'vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const env = makeService({ temp, memoryRoot, vaultDir, memory: false });
  try {
    seedOldRun(vaultDir, { used: 100, runId: 'anchored-run' });
    const started = await env.service.start();
    assert.equal(started.state, 'blocked');
    assert.equal(started.lastError.code, 'E_ANCHOR_MISSING');
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function requireTmp() {
  return process.env.TEMP || process.env.TMP || '.';
}
