// WP4b — apply nine-step protocol, lease/WAL ordering, failure injection
// (K4, K7, K8, K19, K25) and lease bounds (K26).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { clampLeaseTtl, computeMaxHoldMs, createWriterLease } from '../../src/router/service/lease.mjs';
import { makeService, readJson, tempRoot, writeMemory } from './helpers.mjs';

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function setup(prefix, config = {}, deps = {}) {
  const temp = tempRoot(prefix);
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const env = makeService({
    temp,
    memoryRoot,
    vaultDir,
    config: { proposalEnabled: true, applyEnabled: true, tickMs: 60000, ...config },
    deps: { installTimers: false, installListener: false, ...deps },
  });
  const started = await env.service.start();
  assert.equal(started.ok, true, `service start failed: ${JSON.stringify(started)}`);
  return { ...env, temp, memoryRoot, vaultDir, engine: env.service.proposalEngine };
}

function proposeJournal(env, content, target = 'journal/2026-11.md') {
  return env.service.proposeProposal({
    op: 'journal.append',
    target,
    title: 'apply test',
    content,
  }, { caller: { kind: 'root', sessionId: 'root-session' } });
}

async function approve(env, id) {
  const result = await env.service.requestApply({
    mode: 'approve',
    id,
    confirm: id.slice(-6),
  }, { caller: { kind: 'root', sessionId: 'root-session' } });
  assert.equal(result.ok, true, `approve failed: ${JSON.stringify(result)}`);
  return result;
}

async function apply(env, id) {
  return env.service.requestApply({
    mode: 'apply',
    id,
    confirm: id.slice(-6),
  }, { caller: { kind: 'root', sessionId: 'root-session' } });
}

function walEvents(vaultDir) {
  const file = path.join(vaultDir, 'proposals', 'wal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function auditRows(vaultDir) {
  const file = path.join(vaultDir, 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('K1/K4: apply writes canonical only inside the nine-step window and records WAL order', async () => {
  const env = await setup('wp4b-happy-');
  try {
    const proposed = await proposeJournal(env, 'hello apply');
    assert.equal(proposed.ok, true);
    const id = proposed.id;
    const targetFile = path.join(env.memoryRoot, 'journal', '2026-11.md');
    await approve(env, id);
    assert.equal(fs.existsSync(targetFile), false, 'approve never writes canonical');

    const result = await apply(env, id);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state, 'done');
    const proposal = readJson(path.join(env.vaultDir, 'proposals', `${id}.json`));
    assert.equal(proposal.status, 'done');
    assert.equal(sha256Buffer(fs.readFileSync(targetFile)), proposal.result.afterSha);
    assert.ok(fs.existsSync(path.join(env.vaultDir, proposal.result.snapshot)), 'snapshot kept');
    assert.ok(fs.existsSync(path.join(env.vaultDir, 'snapshots', 'manifest.jsonl')));

    const events = walEvents(env.vaultDir).map((line) => line.ev);
    const begin = events.indexOf('apply.begin');
    const done = events.indexOf('apply.done');
    assert.ok(begin >= 0 && done > begin, 'WAL begin precedes done');
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'locks', 'writer.lease.json')), false, 'lease released');
    assert.ok(auditRows(env.vaultDir).some((row) => row.kind === 'apply.done'));
    const queue = readJson(path.join(env.vaultDir, 'proposals', 'queue.json'));
    assert.equal(queue.entries.length, 0);
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K4: a target changed after approve is a zero-write conflict before apply.begin', async () => {
  const env = await setup('wp4b-moved-');
  try {
    const stateFile = path.join(env.memoryRoot, 'STATE.md');
    const before = fs.readFileSync(stateFile);
    const proposed = await env.service.proposeProposal({
      op: 'state.section',
      target: 'STATE.md',
      title: '我在哪',
      content: '新位置：测试台',
      baseSha: sha256Buffer(before),
    }, { caller: { kind: 'root', sessionId: 'root-session' } });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    await approve(env, proposed.id);
    const ownerBytes = Buffer.from(before.toString('utf8').replace('我在哪', '我在哪（第三方改）'));
    fs.writeFileSync(stateFile, ownerBytes);

    const result = await apply(env, proposed.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_BASE_MOVED');
    assert.deepEqual(fs.readFileSync(stateFile), ownerBytes, 'target bytes untouched');
    const proposal = readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(proposal.status, 'conflict');
    assert.equal(walEvents(env.vaultDir).some((line) => line.ev === 'apply.begin'), false, 'no begin before target validation');
    // D-CR17: a validate-time base move is a conflict, never an OWNER_WRITE_RACE.
    assert.equal(env.service.status().warnings.includes('OWNER_WRITE_RACE'), false);
    assert.equal(auditRows(env.vaultDir).some((row) => row.kind === 'warn' && row.code === 'OWNER_WRITE_RACE'), false);
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K19: owner write after the tmp is a zero-write owner-write-race abort', async () => {
  const env = await setup('wp4b-race-', {}, { testHooks: { forceInjection: true } });
  try {
    const proposed = await proposeJournal(env, 'race body');
    await approve(env, proposed.id);
    const targetFile = path.join(env.memoryRoot, 'journal', '2026-11.md');
    const result = await apply(env, proposed.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_BASE_MOVED');
    assert.equal(result.reason, 'owner-write-race');
    assert.equal(fs.existsSync(targetFile), false, 'zero canonical writes');
    assert.equal(fs.readdirSync(path.dirname(targetFile)).some((name) => name.includes('.tmp-')), false, 'tmp removed');
    const events = walEvents(env.vaultDir).map((line) => line.ev);
    assert.ok(events.includes('apply.abort'));
    assert.equal(events.includes('apply.done'), false);
    const proposal = readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(proposal.status, 'conflict');
    assert.equal(proposal.conflict.reason, 'owner-write-race');
    assert.ok(auditRows(env.vaultDir).some((row) => row.kind === 'apply.abort' && row.reason === 'owner-write-race'));
    assert.ok(auditRows(env.vaultDir).some((row) => row.kind === 'warn' && row.code === 'OWNER_WRITE_RACE'));
    // D-CR17: the warning also reaches the service status surface.
    assert.equal(env.service.status().warnings.includes('OWNER_WRITE_RACE'), true);
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K8: readback failure leaves the rename result but demands manual restore (no auto rollback)', async () => {
  const env = await setup('wp4b-readback-', {}, { testHooks: { failReadback: true } });
  try {
    const proposed = await proposeJournal(env, 'readback body');
    await approve(env, proposed.id);
    const result = await apply(env, proposed.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_RESTORE_REQUIRED');
    assert.equal(result.restoreRequired, true);
    const proposal = readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(proposal.status, 'conflict');
    assert.equal(proposal.result.restoreRequired, true);
    assert.ok(fs.existsSync(path.join(env.vaultDir, proposal.result.snapshot)), 'snapshot kept for manual restore');
    const events = walEvents(env.vaultDir).map((line) => line.ev);
    assert.ok(events.includes('apply.conflict'));
    assert.ok(events.includes('restore.required'));
    assert.equal(events.includes('apply.done'), false);
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K7: snapshot failure aborts with zero canonical writes', async () => {
  const env = await setup('wp4b-snapshot-', {}, { testHooks: { failSnapshot: true } });
  try {
    const proposed = await proposeJournal(env, 'snapshot body');
    await approve(env, proposed.id);
    const targetFile = path.join(env.memoryRoot, 'journal', '2026-11.md');
    const result = await apply(env, proposed.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_SNAPSHOT_FAILED');
    assert.equal(fs.existsSync(targetFile), false);
    assert.ok(walEvents(env.vaultDir).some((line) => line.ev === 'apply.abort' && line.reason === 'snapshot-failed'));
    assert.ok(auditRows(env.vaultDir).some((row) => row.kind === 'snapshot_failed'));
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K8: crash after tmp write leaves applying state and recovery reschedules approved', async () => {
  const env = await setup('wp4b-crash-', {}, { testHooks: { failWriteAfter: true } });
  try {
    const proposed = await proposeJournal(env, 'crash body');
    await approve(env, proposed.id);
    const targetFile = path.join(env.memoryRoot, 'journal', '2026-11.md');
    await assert.rejects(() => apply(env, proposed.id), /after-tmp-write|crash/i);
    assert.equal(fs.existsSync(targetFile), false, 'no rename happened');
    let proposal = readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(proposal.status, 'applying');
    assert.ok(walEvents(env.vaultDir).some((line) => line.ev === 'apply.begin'));

    const recovered = env.engine.applier.recoverApplying();
    assert.equal(recovered.recovered.length, 1);
    proposal = readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(proposal.status, 'approved');
    assert.equal(proposal.queue.attempts, 1);
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'locks', 'writer.lease.json')), false);
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K8 step 1: a held writer lease returns state=queued, never a busy error or a write', async () => {
  const env = await setup('wp4b-held-');
  try {
    const proposed = await proposeJournal(env, 'held body');
    await approve(env, proposed.id);
    const lockDir = path.join(env.vaultDir, 'locks');
    const other = createWriterLease({
      file: path.join(lockDir, 'writer.lease.json'),
      lockDir,
      ttlMs: 60000,
      renewalsMax: 2,
      holder: { sessionId: 'other-session', runId: 'other-run', pid: process.pid, host: 'local' },
    });
    assert.equal(other.acquire({ ticket: 'q-0001', proposalId: proposed.id }).ok, true);

    const result = await apply(env, proposed.id);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'queued');
    assert.equal(result.holder, 'other-session');
    assert.equal(fs.existsSync(path.join(env.memoryRoot, 'journal', '2026-11.md')), false);
    assert.equal(walEvents(env.vaultDir).some((line) => line.ev === 'apply.begin'), false);
    assert.equal(readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`)).status, 'approved');
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K8 step 2: a proposal revoked after approval is E_BAD_STATE with no apply.begin', async () => {
  const env = await setup('wp4b-revoked-');
  try {
    const proposed = await proposeJournal(env, 'revoked body');
    await approve(env, proposed.id);
    const file = path.join(env.vaultDir, 'proposals', `${proposed.id}.json`);
    const proposal = readJson(file);
    proposal.status = 'rejected';
    fs.writeFileSync(file, JSON.stringify(proposal));
    const result = await apply(env, proposed.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_BAD_STATE');
    assert.equal(fs.existsSync(path.join(env.memoryRoot, 'journal', '2026-11.md')), false);
    assert.equal(walEvents(env.vaultDir).some((line) => line.ev === 'apply.begin'), false);
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'locks', 'writer.lease.json')), false);
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K8 step 6: fsync failure aborts before rename with zero canonical writes', async () => {
  const env = await setup('wp4b-fsync-', {}, { testHooks: { failFsync: true } });
  try {
    const proposed = await proposeJournal(env, 'fsync body');
    await approve(env, proposed.id);
    const targetFile = path.join(env.memoryRoot, 'journal', '2026-11.md');
    const result = await apply(env, proposed.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_IO');
    assert.equal(fs.existsSync(targetFile), false);
    const events = walEvents(env.vaultDir);
    assert.ok(events.some((line) => line.ev === 'apply.abort' && line.reason === 'write-failed'));
    assert.equal(events.some((line) => line.ev === 'apply.done'), false);
    assert.equal(readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`)).status, 'conflict');
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('production seam: the applier never reads env/config test hooks, only injected deps', async () => {
  const source = fs.readFileSync(new URL('../../src/router/service/apply.mjs', import.meta.url), 'utf8');
  assert.equal(/routerTestHooks|LONGLIVE_ROUTER_TEST|process\.env/u.test(source), false);
  const env = await setup('wp4b-prod-seam-', { routerTestHooks: { failReadback: true } });
  try {
    const proposed = await proposeJournal(env, 'seam body');
    await approve(env, proposed.id);
    const result = await apply(env, proposed.id);
    assert.equal(result.ok, true, 'a config hook must be ignored outside the test build');
    assert.equal(result.state, 'done');
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('K26: lease bounds are computed from TTL and renewals, never hardcoded', () => {
  assert.equal(computeMaxHoldMs(120000, 2), 240000);
  assert.equal(computeMaxHoldMs(60000, 2), 120000);
  assert.equal(computeMaxHoldMs(90000, 2), 180000);
  assert.equal(clampLeaseTtl(30000), 60000);
  assert.equal(clampLeaseTtl(200000), 120000);
  assert.equal(clampLeaseTtl(90000), 90000);
});

test('K25: an approved proposal that never wins the lease blocks then expires, ticket released', async () => {
  const env = await setup('wp4b-blocked-', { blockedOnUserTtlMs: 3600000 });
  try {
    const proposed = await proposeJournal(env, 'blocked body');
    await approve(env, proposed.id);
    const file = path.join(env.vaultDir, 'proposals', `${proposed.id}.json`);
    let proposal = readJson(file);
    proposal.queue.deadlineAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(proposal));
    env.service.queueManager.maintain();
    proposal = readJson(file);
    assert.equal(proposal.status, 'blocked-on-user');
    assert.equal(proposal.queue.blockedReason, 'LEASE_TIMEOUT');

    proposal.queue.deadlineAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(proposal));
    env.service.queueManager.maintain();
    proposal = readJson(file);
    assert.equal(proposal.status, 'expired');
    const queue = readJson(path.join(env.vaultDir, 'proposals', 'queue.json'));
    assert.equal(queue.entries.some((entry) => entry.proposalId === proposed.id), false);

    // D-CR11: approving an expired proposal re-queues it at the tail with a new
    // ticket and a WAL queue.assign.recovered record; canonical stays untouched.
    const targetFile = path.join(env.memoryRoot, 'journal', '2026-11.md');
    const again = await env.service.requestApply({ mode: 'approve', id: proposed.id, confirm: proposed.id.slice(-6) });
    assert.equal(again.ok, true);
    assert.equal(again.state, 'pending');
    assert.equal(again.requeued, true);
    assert.notEqual(again.ticket, proposal.queue.ticket);
    proposal = readJson(file);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.queue.ticket, again.ticket);
    assert.equal(proposal.queue.lease, null);
    assert.equal(proposal.queue.deadlineAt, null);
    assert.equal(fs.existsSync(targetFile), false);
    const recovered = walEvents(env.vaultDir).find((line) => line.ev === 'queue.assign.recovered'
      && line.proposalId === proposed.id && line.reason === 'expired-requeue');
    assert.ok(recovered);
    const requeued = readJson(path.join(env.vaultDir, 'proposals', 'queue.json'));
    assert.equal(requeued.entries.some((entry) => entry.proposalId === proposed.id && entry.ticket === again.ticket), true);
  } finally {
    env.cleanup();
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});
