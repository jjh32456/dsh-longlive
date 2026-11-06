// 1.1.1 contract checks for the VM-v5 regressions that are cheap to pin
// locally: ledger `kind` mirror + overshoot accounting (E-01/E-05), the
// pending/numeric-ticket proposal contract (K-04/N-01), and the bounded
// E_WAIT_TIMEOUT lease window (L-04).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { BudgetLedger } from '../../src/router/background/budget-ledger.mjs';
import { makeService, readJson, tempRoot, writeMemory } from './helpers.mjs';

test('v6 E-01: every ledger row carries the VM-facing kind mirror', () => {
  const temp = tempRoot('v6-ledger-kind-');
  try {
    const ledger = new BudgetLedger({ file: path.join(temp, 'budget.ledger.jsonl'), maxTokens: 50000 });
    const reservation = ledger.reserve({ taskId: 't-kind', tokens: 1000, owner: 'run-v6' });
    assert.equal(reservation.ok, true);
    const settled = ledger.settle({ id: reservation.id, tokens: 900 });
    assert.equal(settled.ok, true);
    const rows = fs.readFileSync(path.join(temp, 'budget.ledger.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.kind), ['reserve', 'settle']);
    assert.deepEqual(rows.map((row) => row.op), ['reserve', 'settle']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6 E-05: allowOvershoot records the real usage instead of truncating it', () => {
  const temp = tempRoot('v6-ledger-overshoot-');
  try {
    const ledger = new BudgetLedger({ file: path.join(temp, 'budget.ledger.jsonl'), maxTokens: 50000 });
    const reservation = ledger.reserve({ taskId: 't-over', tokens: 1000, owner: 'run-v6' });
    assert.equal(reservation.ok, true);
    const settled = ledger.settle({ id: reservation.id, tokens: 40000, allowOvershoot: true });
    assert.equal(settled.ok, true);
    assert.equal(settled.applied, 40000);
    const rows = fs.readFileSync(path.join(temp, 'budget.ledger.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).kind, 'settle');
    assert.equal(rows.at(-1).tokens, 40000);
    assert.equal(ledger.snapshot().used, 40000);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6 K-04/N-01: a new proposal is pending and returns a numeric ticket', async () => {
  const temp = tempRoot('v6-proposal-pending-');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const env = makeService({
    temp,
    memoryRoot,
    vaultDir: path.join(temp, 'vault'),
    config: { proposalEnabled: true, applyEnabled: true },
  });
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const proposed = await env.service.proposeProposal({
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'v6 pending',
      content: 'pending body',
    }, { caller: { kind: 'root', sessionId: 'root-session' } });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.equal(proposed.ticket, 1);
    assert.equal(proposed.ticketName, 'q-0001');
    const stored = readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(stored.status, 'pending');
    assert.equal(stored.queue.ticket, 'q-0001');
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6 F-05: allowMissingAnchor is visible as a warning and audit row', async () => {
  const temp = tempRoot('v6-anchor-allowed-');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const seedDir = path.join(vaultDir, 'runs', 'seed-no-anchor');
  fs.mkdirSync(seedDir, { recursive: true });
  const ledger = new BudgetLedger({ file: path.join(seedDir, 'budget.ledger.jsonl'), maxTokens: 50000 });
  const reservation = ledger.reserve({ taskId: 'seed', tokens: 1000, owner: 'seed-run' });
  ledger.settle({ id: reservation.id, tokens: 900 });
  const env = makeService({
    temp,
    memoryRoot,
    vaultDir,
    config: { proposalEnabled: true, allowMissingAnchor: true },
  });
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(env.service.status().state, 'running');
    assert.ok(env.service.status().warnings.includes('ANCHOR_MISSING_ALLOWED'));
    const rows = fs.readFileSync(path.join(vaultDir, 'audit.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.kind === 'anchor.missing.allowed'));
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6 L-04: a short lease window yields E_WAIT_TIMEOUT and blocked-on-user', async () => {
  const temp = tempRoot('v6-lease-timeout-');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const env = makeService({
    temp,
    memoryRoot,
    vaultDir,
    config: { proposalEnabled: true, applyEnabled: true, leaseWaitTimeoutMs: 1000 },
  });
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const proposed = await env.service.proposeProposal({
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'v6 lease',
      content: 'lease body',
    }, { caller: { kind: 'root', sessionId: 'root-session' } });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    await env.service.requestApply({ mode: 'approve', id: proposed.id, confirm: proposed.id.slice(-6) },
      { caller: { kind: 'root', sessionId: 'root-session' } });

    const held = env.service.lease.acquire({ ticket: 'q-0001', proposalId: proposed.id });
    assert.equal(held.ok, true, JSON.stringify(held));

    const result = await env.service.requestApply({
      mode: 'apply',
      id: proposed.id,
      confirm: proposed.id.slice(-6),
    }, { caller: { kind: 'root', sessionId: 'root-session' } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_WAIT_TIMEOUT');
    assert.equal(result.state, 'blocked-on-user');
    assert.equal(result.reason, 'LEASE_TIMEOUT');
    const stored = readJson(path.join(vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(stored.status, 'blocked-on-user');
    assert.equal(stored.reason, 'LEASE_TIMEOUT');
    assert.equal(fs.existsSync(path.join(memoryRoot, 'journal', '2026-11.md')), false);
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
