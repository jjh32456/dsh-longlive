// 1.1.3 contract checks for the v7 gaps that 1.1.2 still exposed:
//   P0  anchor off-by-one (restart with a ledger must not raise E_LEDGER_TAMPERED)
//   F-03 audit.repair (a truncated half-line must leave an audit event)
//   E-06/G-02/G-03 budget.reclaim (previous-run reservations are released and audited)
//   D-05 routerTestHooks (full+reflect both over budget can be constructed; off by default)
//
// Everything is local temp storage; no host, no network, no real model.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readAnchor } from '../../src/router/background/anchor.mjs';
import { AuditLog, readAudit } from '../../src/router/background/audit.mjs';
import { BudgetLedger, foldRecords, readLedger } from '../../src/router/background/budget-ledger.mjs';
import {
  appendTask,
  makeService,
  taskInput,
  tempRoot,
} from './helpers.mjs';

function auditRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function recordAt(records, seq) {
  return records.find((record) => record.seq === seq) ?? null;
}

async function stopAndDispose(env) {
  try { await env.service.stop(); } catch { /* best effort */ }
  try { await env.service.dispose(); } catch { /* best effort */ }
}

test('v6c P0: restart with a ledger is healthy; the anchor points at the last audit record', async () => {
  const temp = tempRoot('v6c-p0-');
  const first = makeService({ temp, deps: { runId: 'run-p0-a' } });
  let second = null;
  try {
    const started = await first.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    appendTask(first.service, taskInput('p0-task'));
    const tick = await first.service.tick({ tier: 'full' });
    assert.equal(tick.ok, true, JSON.stringify(tick));

    const ledgerFile = path.join(temp, 'vault', 'runs', 'run-p0-a', 'budget.ledger.jsonl');
    const folded = foldRecords(readLedger(ledgerFile).records);
    assert.ok(folded.used > 0, 'the tick must settle real tokens, so the restart is "with a ledger"');

    await stopAndDispose(first);

    const auditFile = path.join(temp, 'vault', 'audit.jsonl');
    const anchorFile = path.join(temp, 'vault', 'runs', 'run-p0-a', 'anchor.jsonl');
    const auditRecords = readAudit(auditFile).records;
    const anchorRecords = readAnchor(anchorFile).records;
    const lastAnchor = anchorRecords[anchorRecords.length - 1];
    assert.ok(lastAnchor, 'stop() must leave an anchor behind');
    // The seal may happen before the final audit row of stop(), so check the
    // prefix it claims: the seq must exist and its hash must match.
    const claimed = recordAt(auditRecords, lastAnchor.audit.seq);
    assert.ok(claimed, `anchor claims audit seq ${lastAnchor.audit.seq}, which does not exist (off-by-one)`);
    assert.equal(claimed.hash, lastAnchor.audit.last_hash);

    second = makeService({ temp, deps: { runId: 'run-p0-b' } });
    const restarted = await second.service.start();
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    assert.equal(restarted.state, 'running');
    assert.notEqual(restarted.code, 'E_LEDGER_TAMPERED');
    assert.ok(!(second.service.status().warnings ?? []).includes('E_LEDGER_TAMPERED'));
  } finally {
    if (second) await stopAndDispose(second);
    if (first.service.status().state === 'running') await stopAndDispose(first);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6c F-03: a truncated audit half-line is dropped and recorded as audit.repair', async () => {
  const temp = tempRoot('v6c-f03-');
  const file = path.join(temp, 'audit.jsonl');
  try {
    const log = new AuditLog({ file, runId: 'run-f03' });
    log.open();
    log.append('test.before', { n: 1 });
    log.append('test.before', { n: 2 });
    log.close();

    const partial = '{"v":1,"seq":99,"kind":"broken-tail"';
    fs.appendFileSync(file, partial, 'utf8');

    const reopened = new AuditLog({ file, runId: 'run-f03' });
    reopened.open();
    const afterOpen = readAudit(file);
    assert.equal(afterOpen.badLines, 0);
    assert.equal(afterOpen.truncated, 0);
    assert.deepEqual(afterOpen.records.map((record) => record.seq), [1, 2, 3]);
    const repaired = afterOpen.records[2];
    assert.equal(repaired.kind, 'audit.repair');
    assert.equal(repaired.bytes_dropped, Buffer.byteLength(partial));
    assert.equal(repaired.reason, 'partial_tail');

    // Later writes continue the sequence and stay parseable.
    reopened.append('test.after', { n: 3 });
    const afterWrite = readAudit(file);
    assert.equal(afterWrite.badLines, 0);
    assert.equal(afterWrite.records.length, 4);
    assert.equal(afterWrite.records[3].seq, 4);
    assert.equal(afterWrite.records[3].kind, 'test.after');
    reopened.close();

    // A clean reopen must not invent a repair event.
    const clean = new AuditLog({ file, runId: 'run-f03' });
    clean.open();
    assert.equal(readAudit(file).records.length, 4);
    clean.close();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6c E-06/G-02/G-03: boot reclaims previous-run reservations and audits budget.reclaim', async () => {
  const temp = tempRoot('v6c-reclaim-');
  const vaultDir = path.join(temp, 'vault');
  const orphanDir = path.join(vaultDir, 'runs', 'run-orphan');
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphanFile = path.join(orphanDir, 'budget.ledger.jsonl');
  const tokens = 777;

  // A crashed child left one reservation behind: its pid is still alive (ours),
  // so the lease is what marks it dead.
  const orphan = new BudgetLedger({
    file: orphanFile,
    runId: 'run-orphan',
    maxTokens: 50000,
    pid: process.pid,
    reservationLeaseMs: 1,
  });
  const reserved = orphan.reserve({ taskId: 'crashed-task', tokens, leaseMs: 1 });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await new Promise((resolve) => setTimeout(resolve, 25));

  let first = null;
  let second = null;
  try {
    first = makeService({
      temp,
      deps: { runId: 'run-after-crash-1' },
      config: { allowMissingAnchor: true },
    });
    const started = await first.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.state, 'running');

    const audit = auditRows(path.join(vaultDir, 'audit.jsonl'));
    const reclaims = audit.filter((row) => row.kind === 'budget.reclaim');
    assert.equal(reclaims.length, 1, JSON.stringify(reclaims));
    const [reclaim] = reclaims;
    assert.equal(reclaim.origin, 'startup');
    assert.equal(reclaim.released, 1);
    assert.equal(reclaim.freed_tokens, tokens);
    assert.equal(reclaim.charged, 0);
    assert.equal(reclaim.runs.length, 1);
    assert.equal(reclaim.runs[0].run_id, 'run-orphan');
    assert.equal(reclaim.runs[0].scope, 'previous_run');
    assert.equal(reclaim.runs[0].released, 1);

    // The old run is back to zero: no charge, no active reservation.
    const folded = foldRecords(readLedger(orphanFile).records);
    assert.equal(folded.used, 0);
    assert.equal(folded.reserved, 0);
    assert.equal(folded.active.size, 0);
    const release = readLedger(orphanFile).records.find((record) => record.op === 'release');
    assert.ok(release, 'reclaim must append a release record');
    assert.equal(release.released_tokens, tokens);

    const status = first.service.status();
    assert.equal(status.run.usedTokens, 0);
    assert.equal(status.today.usedTokens, 0);
    assert.ok(!audit.some((row) => row.kind === 'budget.settle' && row.run_id === 'run-orphan'));

    await stopAndDispose(first);
    first = null;

    // A second restart has nothing left to reclaim: no duplicate billing event.
    second = makeService({
      temp,
      deps: { runId: 'run-after-crash-2' },
      config: { allowMissingAnchor: true },
    });
    const restarted = await second.service.start();
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    const reclaimsAgain = auditRows(path.join(vaultDir, 'audit.jsonl'))
      .filter((row) => row.kind === 'budget.reclaim');
    assert.equal(reclaimsAgain.length, 1, 'reclaim must be idempotent across restarts');
    assert.equal(foldRecords(readLedger(orphanFile).records).used, 0);
  } finally {
    if (first) await stopAndDispose(first);
    if (second) await stopAndDispose(second);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6c D-05: the test hook can force full+reflect over budget without touching a model', async () => {
  const temp = tempRoot('v6c-d05-block-');
  const env = makeService({
    temp,
    deps: { runId: 'run-d05-block', testHooks: { forceContextOverBudget: true } },
  });
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    appendTask(env.service, taskInput('d05-task'));
    const tick = await env.service.tick({ tier: 'full' });
    assert.equal(tick.ok, true, JSON.stringify(tick));

    const status = env.service.status();
    assert.equal(status.state, 'blocked');
    assert.equal(status.reason, 'E_CONTEXT_OVER_BUDGET');
    assert.equal(env.llm.calls, 0, 'a blocked context must not call the model');
    assert.equal(status.run.usedTokens, 0);
    assert.equal(foldRecords(readLedger(path.join(temp, 'vault', 'runs', 'run-d05-block', 'budget.ledger.jsonl')).records).reserved, 0);
    assert.ok(!auditRows(path.join(temp, 'vault', 'audit.jsonl'))
      .some((row) => row.kind === 'budget.settle'));
  } finally {
    await stopAndDispose(env);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6c D-05: without the hook the same service runs normally (hook is off by default)', async () => {
  const temp = tempRoot('v6c-d05-normal-');
  const env = makeService({ temp, deps: { runId: 'run-d05-normal' } });
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    appendTask(env.service, taskInput('d05-normal'));
    const tick = await env.service.tick({ tier: 'full' });
    assert.equal(tick.ok, true, JSON.stringify(tick));
    assert.equal(tick.processed, 1);
    assert.equal(env.llm.calls, 1);
    assert.equal(env.service.status().state, 'running');
    assert.equal(env.service.status().reason, 'started');
  } finally {
    await stopAndDispose(env);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
