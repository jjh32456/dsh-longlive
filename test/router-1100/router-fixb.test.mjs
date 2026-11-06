// FIX-B regression suite — CR-04/05/06/07/09/10/11/13/16/17.
//
// Every test here exists for a specific red-team finding; the RESULT file
// records the file:line of each one. These tests use real child processes and
// real on-disk crash seams, never mocks of the protocol itself.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createTickLock } from '../../src/router/service/ticklock.mjs';
import { createWal } from '../../src/router/service/wal.mjs';
import { createWriterLease } from '../../src/router/service/lease.mjs';
import {
  readProposal,
  scanProposalDir,
  updateProposalStrict,
  writeProposalFile,
} from '../../src/router/service/store.mjs';
import { makeService, readJson, tempRoot, writeMemory } from './helpers.mjs';

const WAL_MODULE = pathToFileURL(path.resolve('src/router/service/wal.mjs')).href;

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function setupService(prefix, config = {}, deps = {}) {
  const temp = tempRoot(prefix);
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const env = makeService({
    temp,
    memoryRoot,
    vaultDir,
    config: {
      proposalEnabled: true,
      applyEnabled: true,
      tickMs: 60000,
      proposalsPerSessionHour: 60,
      ...config,
    },
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
    title: 'fixb',
    content,
  }, { caller: { kind: 'root', sessionId: 'root-session' } });
}

async function approve(env, id) {
  const result = await env.service.requestApply({ mode: 'approve', id, confirm: id.slice(-6) }, { caller: { kind: 'root', sessionId: 'root-session' } });
  assert.equal(result.ok, true, `approve failed: ${JSON.stringify(result)}`);
  return result;
}

function apply(env, id) {
  return env.service.requestApply({ mode: 'apply', id, confirm: id.slice(-6) }, { caller: { kind: 'root', sessionId: 'root-session' } });
}

function rollback(env, id) {
  return env.service.requestApply({ mode: 'rollback', id, confirm: id.slice(-6) }, { caller: { kind: 'root', sessionId: 'root-session' } });
}

function walEvents(vaultDir) {
  const file = path.join(vaultDir, 'proposals', 'wal.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function cleanup(env) {
  env.cleanup();
  fs.rmSync(env.temp, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(10);
  }
  return false;
}

// CR-04 / D-CR6: two independent Node processes append to one WAL after a
// barrier. The pre-fix behavior was 20/20 duplicate seq and broken=true.
test('CR-04: two real processes append 20 events without a duplicate seq or a broken chain', async () => {
  const temp = tempRoot('fixb-wal-');
  const proposalsDir = path.join(temp, 'vault', 'proposals');
  const goFile = path.join(temp, 'go');
  fs.mkdirSync(proposalsDir, { recursive: true });
  const walFile = path.join(proposalsDir, 'wal.jsonl');
  const wal = createWal({ file: walFile });
  for (let index = 0; index < 5; index += 1) wal.append('queue.reconcile', { seed: index });

  const script = path.join(temp, 'append-worker.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { createWal } from ${JSON.stringify(WAL_MODULE)};
const [walFile, goFile, worker, readyFile] = process.argv.slice(2);
const wal = createWal({ file: walFile });
fs.writeFileSync(readyFile, 'ready');
const sleeper = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(goFile)) Atomics.wait(sleeper, 0, 0, 5);
for (let index = 0; index < 10; index += 1) wal.append('queue.reconcile', { worker, index });
`, 'utf8');

  const children = [];
  try {
    for (const worker of ['a', 'b']) {
      const readyFile = path.join(temp, `ready-${worker}`);
      const child = spawn(process.execPath, [script, walFile, goFile, worker, readyFile], { stdio: ['ignore', 'ignore', 'pipe'] });
      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      children.push({ child, stderr, readyFile });
    }
    for (const entry of children) {
      assert.equal(await waitFor(() => fs.existsSync(entry.readyFile)), true, 'worker did not reach the barrier');
    }
    fs.writeFileSync(goFile, 'go');
    const codes = await Promise.all(children.map((entry) => new Promise((resolve) => entry.child.on('exit', resolve))));
    for (let index = 0; index < children.length; index += 1) {
      assert.equal(codes[index], 0, `worker failed: ${Buffer.concat(children[index].stderr).toString('utf8')}`);
    }

    const read = wal.read();
    assert.equal(read.broken, false, `chain broken at ${read.brokenAt}: ${read.error ?? ''}`);
    assert.equal(read.lines.length, 25, '5 seed + 2 workers x 10 events');
    for (let index = 0; index < read.lines.length; index += 1) {
      assert.equal(read.lines[index].seq, index + 1, 'seq is continuous and unique');
      if (index > 0) assert.equal(read.lines[index].prev, read.lines[index - 1].hash, 'prev/hash chain intact');
    }
    assert.deepEqual(
      read.lines.slice(5).map((line) => `${line.worker}:${line.index}`).sort(),
      ['a:0', 'a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6', 'a:7', 'a:8', 'a:9', 'b:0', 'b:1', 'b:2', 'b:3', 'b:4', 'b:5', 'b:6', 'b:7', 'b:8', 'b:9'],
    );
    assert.equal(fs.existsSync(path.join(temp, 'vault', 'locks', 'wal.lock')), false, 'wal.lock released');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// CR-04 / D-CR6: a crashed writer's stale wal.lock is taken over with evidence,
// so one dead pid can never close the shared WAL forever.
test('CR-04b: a stale wal.lock is taken over with evidence and append proceeds', () => {
  const temp = tempRoot('fixb-wallock-');
  const proposalsDir = path.join(temp, 'vault', 'proposals');
  const locksDir = path.join(temp, 'vault', 'locks');
  fs.mkdirSync(proposalsDir, { recursive: true });
  fs.mkdirSync(locksDir, { recursive: true });
  const lockFile = path.join(locksDir, 'wal.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ v: 1, pid: 999995, host: 'local', startedAt: new Date(Date.now() - 3600000).toISOString(), nonce: 'dead' }));
  const audit = [];
  const wal = createWal({ file: path.join(proposalsDir, 'wal.jsonl'), audit: (kind, data = {}) => audit.push({ kind, ...data }) });
  try {
    wal.append('queue.reconcile', { afterStaleLock: true });
    assert.equal(wal.read().broken, false);
    assert.equal(wal.read().lines.length, 1);
    assert.ok(fs.readdirSync(locksDir).some((name) => name.startsWith('wal.lock.reclaimed-')), 'old lock kept as evidence');
    assert.ok(audit.some((row) => row.kind === 'wal.lock.reclaimed'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// CR-07 / D-CR7: a stale rev must lose, never overwrite; service retries a lost
// CAS once instead of surfacing a silent overwrite.
test('CR-07: rev CAS rejects a stale write (E_STATE_RACE) and service retries a lost race', async () => {
  const env = await setupService('fixb-cas-');
  try {
    const proposed = await proposeJournal(env, 'cas body');
    const file = path.join(env.vaultDir, 'proposals', `${proposed.id}.json`);
    const original = readJson(file);
    writeProposalFile(file, { ...original, title: 'winner', rev: original.rev + 1 });
    const raced = readJson(file);
    assert.throws(
      () => updateProposalStrict(env.vaultDir ? path.dirname(file) : path.dirname(file), proposed.id, original.rev, { title: 'loser' }),
      (error) => error?.code === 'E_STATE_RACE' && error.rev === raced.rev,
    );
    assert.equal(readJson(file).title, 'winner', 'stale writer changed nothing');

    // Bounded retry: the first approve loses the CAS, the second reads fresh.
    const engine = env.service.proposalEngine;
    const originalApprove = engine.approve;
    let calls = 0;
    engine.approve = async function wrapped(...args) {
      calls += 1;
      if (calls === 1) return { ok: false, code: 'E_STATE_RACE', message: 'injected lost update' };
      return originalApprove.apply(this, args);
    };
    const approved = await env.service.requestApply({ mode: 'approve', id: proposed.id, confirm: proposed.id.slice(-6) }, { caller: { kind: 'root', sessionId: 'root-session' } });
    assert.equal(calls, 2, 'service retried exactly once');
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(readJson(file).status, 'approved');
    assert.equal(walEvents(env.vaultDir).filter((line) => line.ev === 'queue.approve').length, 1, 'approve WAL written once');
  } finally {
    cleanup(env);
  }
});

// CR-05 / D-CR8: the final pre-rename recheck refuses a target that changed
// after the earlier check, with zero canonical bytes and no rollback.done.
test('CR-05: rollback refuses a target changed after the initial check with zero bytes', async () => {
  const env = await setupService('fixb-rb-race-');
  try {
    const proposed = await proposeJournal(env, 'rollback race body');
    await approve(env, proposed.id);
    const applied = await apply(env, proposed.id);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const targetFile = path.join(env.memoryRoot, 'journal', '2026-11.md');
    const doneBytes = fs.readFileSync(targetFile);
    env.service.applier.testHooks = {
      onRollbackRecheck: () => { fs.writeFileSync(targetFile, 'owner edit during rollback\n'); },
    };
    const raced = await rollback(env, proposed.id);
    assert.equal(raced.ok, false);
    assert.equal(raced.code, 'E_BASE_MOVED');
    assert.equal(raced.reason, 'owner-write-race');
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'owner edit during rollback\n', 'the owner bytes win');
    assert.notDeepEqual(fs.readFileSync(targetFile), doneBytes);
    const tmpDir = path.dirname(targetFile);
    assert.equal(fs.readdirSync(tmpDir).some((name) => name.includes('.tmp-')), false, 'tmp removed');
    const proposal = readJson(path.join(env.vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(proposal.status, 'conflict');
    assert.equal(proposal.conflict.reason, 'owner-write-race');
    const events = walEvents(env.vaultDir).map((line) => line.ev);
    assert.ok(events.includes('rollback.begin'));
    assert.equal(events.includes('rollback.done'), false);
    assert.ok(walEvents(env.vaultDir).some((line) => line.ev === 'apply.abort' && line.reason === 'owner-write-race' && line.phase === 'rollback-pre-rename'));
  } finally {
    cleanup(env);
  }
});

// CR-06 / D-CR8: crash after rename but before the state flip is recovered to
// rolled_back; crash before rename is recovered to done; a third state is a
// conflict with RESTORE_REQUIRED. Never auto-restore.
test('CR-06: rollback crash recovery has exactly three outcomes', async () => {
  // Branch 1 — R-06: this apply created the file, so its rollback removes it;
  // a crash after the removal but before the state flip recovers to rolled_back.
  const crashed = await setupService('fixb-rb-crash-');
  try {
    const proposed = await proposeJournal(crashed, 'crash branch body');
    await approve(crashed, proposed.id);
    assert.equal((await apply(crashed, proposed.id)).ok, true);
    const targetFile = path.join(crashed.memoryRoot, 'journal', '2026-11.md');
    crashed.service.applier.testHooks = { failRollbackAfterRename: true };
    await assert.rejects(() => crashed.service.applier.rollback({ id: proposed.id }), (error) => error?.code === 'E_TEST_CRASH');
    let proposal = readJson(path.join(crashed.vaultDir, 'proposals', `${proposed.id}.json`));
    const beforeSha = proposal.rollback.beforeSha;
    assert.equal(proposal.status, 'applying');
    assert.equal(proposal.rollback.active, true);
    assert.equal(proposal.rollback.removeTarget, true, 'new-file rollback removes instead of restoring');
    assert.equal(beforeSha, sha256Buffer(Buffer.alloc(0)), 'beforeSha is the empty-buffer sha');
    assert.equal(fs.existsSync(targetFile), false, 'target removed by rollback');
    const recovered = crashed.service.applier.recoverApplying();
    assert.ok(recovered.rolledBack.includes(proposed.id), JSON.stringify(recovered));
    proposal = readJson(path.join(crashed.vaultDir, 'proposals', `${proposed.id}.json`));
    assert.equal(proposal.status, 'rolled_back');
    assert.equal(proposal.result.restoredSha, null);
    assert.equal(proposal.result.removed, true);
    assert.equal(fs.existsSync(targetFile), false, 'still absent after recovery');
    assert.ok(walEvents(crashed.vaultDir).some((line) => line.ev === 'rollback.done' && line.proposalId === proposed.id
      && line.recovered === true && line.removed === true && line.restoredSha === null));
    assert.equal(fs.existsSync(path.join(crashed.vaultDir, 'locks', 'writer.lease.json')), false, 'recovery released its own lease');
  } finally {
    cleanup(crashed);
  }

  // Branch 2 — crash before rename: target is still afterSha -> done.
  const pending = await setupService('fixb-rb-done-');
  try {
    const proposed = await proposeJournal(pending, 'not-landed body');
    await approve(pending, proposed.id);
    assert.equal((await apply(pending, proposed.id)).ok, true);
    const file = path.join(pending.vaultDir, 'proposals', `${proposed.id}.json`);
    let proposal = readJson(file);
    const { beforeSha, afterSha } = proposal.result;
    proposal = updateProposalStrict(path.dirname(file), proposed.id, proposal.rev, (current) => ({
      ...current,
      status: 'applying',
      rollback: { active: true, beforeSha, afterSha },
      queue: { ...current.queue, lease: null },
    }));
    pending.service.wal.append('rollback.begin', { ticket: proposal.queue.ticket, proposalId: proposed.id, beforeSha, afterSha });
    const targetFile = path.join(pending.memoryRoot, 'journal', '2026-11.md');
    assert.equal(sha256Buffer(fs.readFileSync(targetFile)), afterSha);
    const recovered = pending.service.applier.recoverApplying();
    assert.ok(recovered.done.includes(proposed.id), JSON.stringify(recovered));
    proposal = readJson(file);
    assert.equal(proposal.status, 'done');
    assert.equal(sha256Buffer(fs.readFileSync(targetFile)), afterSha, 'no canonical write on this branch');
  } finally {
    cleanup(pending);
  }

  // Branch 3 — neither beforeSha nor afterSha: conflict + RESTORE_REQUIRED.
  const conflict = await setupService('fixb-rb-conflict-');
  try {
    const proposed = await proposeJournal(conflict, 'conflict branch body');
    await approve(conflict, proposed.id);
    assert.equal((await apply(conflict, proposed.id)).ok, true);
    const file = path.join(conflict.vaultDir, 'proposals', `${proposed.id}.json`);
    let proposal = readJson(file);
    const { beforeSha, afterSha } = proposal.result;
    proposal = updateProposalStrict(path.dirname(file), proposed.id, proposal.rev, (current) => ({
      ...current,
      status: 'applying',
      rollback: { active: true, beforeSha, afterSha },
      queue: { ...current.queue, lease: null },
    }));
    conflict.service.wal.append('rollback.begin', { ticket: proposal.queue.ticket, proposalId: proposed.id, beforeSha, afterSha });
    fs.writeFileSync(path.join(conflict.memoryRoot, 'journal', '2026-11.md'), 'third party content\n');
    const recovered = conflict.service.applier.recoverApplying();
    assert.ok(recovered.conflicts.includes(proposed.id), JSON.stringify(recovered));
    proposal = readJson(file);
    assert.equal(proposal.status, 'conflict');
    assert.equal(proposal.conflict.code, 'RESTORE_REQUIRED');
    assert.equal(proposal.conflict.restoreRequired, true);
    assert.equal(fs.readFileSync(path.join(conflict.memoryRoot, 'journal', '2026-11.md'), 'utf8'), 'third party content\n');
    assert.equal(conflict.service.status().warnings.includes('RESTORE_REQUIRED'), true);
  } finally {
    cleanup(conflict);
  }
});

// CR-15 / D-CR12: a read-back mismatch in the lock acquire path is a busy
// round, never a successful acquisition with no owner on disk.
test('CR-15: tick.lock read-back mismatch reports busy and leaves no lock', () => {
  const temp = tempRoot('fixb-ticknull-');
  const lockFile = path.join(temp, 'tick.lock');
  const lock = createTickLock({ file: lockFile, maxHoldMs: 1000 });
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (file === lockFile) return JSON.stringify({ v: 1, pid: process.pid, startedAt: 'not-the-payload' });
    return realRead.call(fs, file, ...rest);
  };
  try {
    const result = lock.tryAcquire();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'busy');
    assert.equal(fs.existsSync(lockFile), false, 'mismatched read-back deleted its own file');
  } finally {
    fs.readFileSync = realRead;
  }
  try {
    assert.equal(lock.status().held, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// CR-09 / D-CR9: an abandoned reclaim mutex with a dead local owner is taken
// over with evidence; a live owner's mutex is never stolen.
test('CR-09: stale tick/issue reclaim locks are taken over, live ones are not', async () => {
  const env = await setupService('fixb-reclaim-');
  try {
    const tickFile = path.join(env.vaultDir, 'tick.lock');
    const tickReclaim = path.join(env.vaultDir, 'tick.reclaim.lock');
    fs.mkdirSync(env.vaultDir, { recursive: true });
    const audit = [];
    fs.writeFileSync(tickFile, JSON.stringify({ v: 1, pid: 999999, host: 'local', startedAt: new Date(Date.now() - 3600000).toISOString() }));
    fs.writeFileSync(tickReclaim, JSON.stringify({ v: 1, pid: 999998, host: 'local', startedAt: new Date(Date.now() - 3600000).toISOString(), nonce: 'dead' }));
    const lock = createTickLock({ file: tickFile, maxHoldMs: 1000, audit: (kind, data = {}) => audit.push({ kind, ...data }) });
    const taken = lock.tryAcquire();
    assert.equal(taken.ok, true, JSON.stringify(taken));
    assert.equal(taken.reclaimed, true);
    assert.ok(fs.readdirSync(env.vaultDir).some((name) => name.startsWith('tick.reclaim.lock.reclaimed-')));
    assert.ok(audit.some((row) => row.kind === 'tick.reclaim_lock.reclaimed'));
    lock.release();

    // A live reclaim mutex is a quiet busy, and the stale tick lock stays put.
    fs.writeFileSync(tickFile, JSON.stringify({ v: 1, pid: 999999, host: 'local', startedAt: new Date(Date.now() - 3600000).toISOString() }));
    fs.writeFileSync(tickReclaim, JSON.stringify({ v: 1, pid: process.pid, host: 'local', startedAt: new Date().toISOString(), nonce: 'live' }));
    const busy = lock.tryAcquire();
    assert.equal(busy.ok, false);
    assert.equal(busy.reason, 'reclaim-busy');
    assert.equal(JSON.parse(fs.readFileSync(tickFile, 'utf8')).pid, 999999);

    // The lease reclaim mutex uses the same stale-takeover rule: a dead pid's
    // reclaim.lock must not freeze lease maintenance.
    const leaseFile = path.join(env.vaultDir, 'locks', 'writer.lease.json');
    const leaseReclaim = path.join(env.vaultDir, 'locks', 'reclaim.lock');
    const leaseAudit = [];
    const lease = createWriterLease({
      file: leaseFile,
      lockDir: path.join(env.vaultDir, 'locks'),
      holder: { sessionId: 'test', runId: 'test-owner', pid: process.pid, host: 'local' },
      audit: (kind, data = {}) => leaseAudit.push({ kind, ...data }),
    });
    const nowMs = Date.now();
    fs.mkdirSync(path.join(env.vaultDir, 'locks'), { recursive: true });
    const writeDeadLease = () => fs.writeFileSync(leaseFile, JSON.stringify({
      v: 1,
      holder: { sessionId: 'dead', runId: 'dead-owner', pid: 999994, host: 'local' },
      ticket: 'q-0001',
      proposalId: null,
      acquiredAt: new Date(nowMs - 1000).toISOString(),
      expiresAt: new Date(nowMs + 60000).toISOString(),
      ttlMs: 60000,
      renewals: 0,
    }));
    writeDeadLease();
    fs.writeFileSync(leaseReclaim, JSON.stringify({ v: 1, pid: 999993, host: 'local', startedAt: new Date(nowMs - 3600000).toISOString(), nonce: 'dead' }));
    const reclaimed = lease.reclaimIfNeeded();
    assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
    assert.equal(fs.existsSync(leaseFile), false);
    assert.ok(leaseAudit.some((row) => row.kind === 'lease.reclaim_lock.reclaimed'), 'stale lease reclaim mutex taken over');
    assert.ok(fs.readdirSync(path.join(env.vaultDir, 'locks')).some((name) => name.startsWith('reclaim.lock.reclaimed-')));

    writeDeadLease();
    fs.writeFileSync(leaseReclaim, JSON.stringify({ v: 1, pid: process.pid, host: 'local', startedAt: new Date().toISOString(), nonce: 'live' }));
    const busyLease = lease.reclaimIfNeeded();
    assert.equal(busyLease.ok, false);
    assert.equal(busyLease.reason, 'reclaim-busy');
    assert.equal(fs.existsSync(leaseFile), true, 'live reclaim mutex prevented the steal');

    // Same protocol for locks/issue.lock: a dead holder's reclaim lock must not
    // block proposals forever.
    const issueLock = path.join(env.vaultDir, 'locks', 'issue.lock');
    const issueReclaim = path.join(env.vaultDir, 'locks', 'issue.reclaim.lock');
    fs.mkdirSync(path.dirname(issueLock), { recursive: true });
    fs.writeFileSync(issueLock, JSON.stringify({ v: 1, pid: 999997, host: 'local', startedAt: new Date(Date.now() - 3600000).toISOString(), proposalId: null }));
    fs.writeFileSync(issueReclaim, JSON.stringify({ v: 1, pid: 999996, host: 'local', startedAt: new Date(Date.now() - 3600000).toISOString(), nonce: 'dead' }));
    const old = new Date(Date.now() - 3600000);
    fs.utimesSync(issueLock, old, old);
    fs.utimesSync(issueReclaim, old, old);
    const proposed = await proposeJournal(env, 'after stale issue lock');
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.ok(fs.readdirSync(path.join(env.vaultDir, 'locks')).some((name) => name.startsWith('issue.reclaimed-')));
  } finally {
    cleanup(env);
  }
});

// CR-10 / D-CR10: a foreign host's unexpired lease is alive; local dead pid and
// expired leases are reclaimed into evidence files.
test('CR-10: foreign unexpired lease is not stolen; dead local and expired leases are', () => {
  const temp = tempRoot('fixb-lease-');
  const lockDir = path.join(temp, 'vault', 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const leaseFile = path.join(lockDir, 'writer.lease.json');
  const holder = (host, pid, runId) => ({ sessionId: 'x', runId, pid, host });
  const writeLease = (host, pid, runId, acquiredMs, expiresMs) => {
    fs.writeFileSync(leaseFile, JSON.stringify({
      v: 1,
      holder: holder(host, pid, runId),
      ticket: 'q-0001',
      proposalId: null,
      acquiredAt: new Date(acquiredMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      ttlMs: 60000,
      renewals: 0,
    }));
  };
  try {
    const lease = createWriterLease({
      file: leaseFile,
      lockDir,
      holder: { sessionId: 'test', runId: 'test-owner', pid: process.pid, host: 'local' },
      now: () => new Date(),
      audit: () => {},
    });
    const now = Date.now();
    writeLease('other-host', 1, 'foreign-live', now - 1000, now + 60000);
    assert.deepEqual(lease.reclaimIfNeeded(), { ok: true, reclaimed: false, reason: 'alive' });
    assert.equal(fs.existsSync(leaseFile), true);

    writeLease('local', 999999, 'local-dead', now - 1000, now + 60000);
    const local = lease.reclaimIfNeeded();
    assert.equal(local.ok, true, JSON.stringify(local));
    assert.equal(fs.existsSync(leaseFile), false);
    assert.ok(local.evidence && fs.existsSync(local.evidence), 'dead lease preserved as evidence');

    writeLease('other-host', 1, 'foreign-expired', now - 200000, now - 1000);
    const expired = lease.reclaimIfNeeded();
    assert.equal(expired.ok, true, JSON.stringify(expired));
    assert.ok(expired.evidence && fs.existsSync(expired.evidence));
    assert.equal(fs.existsSync(leaseFile), false);
    const evidence = fs.readdirSync(lockDir).filter((name) => name.startsWith('reclaimed-'));
    assert.ok(evidence.length >= 2, `evidence files kept: ${evidence.join(',')}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// CR-11 / D-CR11: approving an expired proposal re-queues it at the tail.
test('CR-11: expired approve issues a new tail ticket and queue.assign.recovered', async () => {
  const env = await setupService('fixb-expired-');
  try {
    const proposed = await proposeJournal(env, 'expired body');
    await approve(env, proposed.id);
    const file = path.join(env.vaultDir, 'proposals', `${proposed.id}.json`);
    let proposal = readJson(file);
    proposal.queue.deadlineAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(proposal));
    env.service.queueManager.maintain();
    proposal = readJson(file);
    assert.equal(proposal.status, 'blocked-on-user');
    proposal.queue.deadlineAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(proposal));
    env.service.queueManager.maintain();
    proposal = readJson(file);
    assert.equal(proposal.status, 'expired');

    const requeued = await approve(env, proposed.id);
    assert.equal(requeued.state, 'pending');
    assert.equal(requeued.requeued, true);
    assert.notEqual(requeued.ticket, proposal.queue.ticket);
    proposal = readJson(file);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.queue.ticket, requeued.ticket);
    assert.equal(proposal.queue.lease, null);
    assert.equal(proposal.queue.deadlineAt, null);
    assert.ok(walEvents(env.vaultDir).some((line) => line.ev === 'queue.assign.recovered'
      && line.proposalId === proposed.id && line.reason === 'expired-requeue' && line.ticket === requeued.ticket));
  } finally {
    cleanup(env);
  }
});

// CR-13 / D-CR12: the 16 KB limit applies to the whole serialized proposal on
// write and on read, not just to the content field.
test('CR-13: full-JSON size is enforced on write and read', async () => {
  const env = await setupService('fixb-size-');
  try {
    const proposed = await proposeJournal(env, 'size body');
    const file = path.join(env.vaultDir, 'proposals', `${proposed.id}.json`);
    const original = readJson(file);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(
      () => writeProposalFile(file, { ...original, rationale: 'x'.repeat(20000) }),
      (error) => error?.code === 'E_CONTENT_TOO_LARGE',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'oversized proposal never lands');

    const oversized = path.join(env.vaultDir, 'proposals', 'p-20261105T000000-abcdef.json');
    fs.writeFileSync(oversized, `${JSON.stringify({ v: 1 })}\n${' '.repeat(17000)}`);
    const scan = scanProposalDir(path.join(env.vaultDir, 'proposals'));
    assert.ok(scan.invalid.some((entry) => entry.file === oversized && entry.error === 'E_CONTENT_TOO_LARGE'));
    assert.equal(scan.proposals.some((entry) => entry.id === 'p-20261105T000000-abcdef'), false);
  } finally {
    cleanup(env);
  }
});

// CR-16 / D-CR12: a read failure marks the log broken and append refuses; it
// must never silently restart the chain at seq 1.
test('CR-16: WAL read failure sets broken and append throws E_WAL_BROKEN', () => {
  const temp = tempRoot('fixb-walbroken-');
  const proposalsDir = path.join(temp, 'vault', 'proposals');
  fs.mkdirSync(proposalsDir, { recursive: true });
  const walFile = path.join(proposalsDir, 'wal.jsonl');
  const wal = createWal({ file: walFile });
  try {
    wal.append('queue.reconcile', { seed: 1 });
    wal.append('queue.reconcile', { seed: 2 });
    fs.rmSync(walFile);
    fs.mkdirSync(walFile); // readFileSync -> EISDIR, not ENOENT
    const read = wal.read();
    assert.equal(read.broken, true);
    assert.ok(read.error);
    assert.throws(() => wal.append('queue.reconcile', { seed: 3 }), (error) => error?.code === 'E_WAL_BROKEN');
    assert.equal(fs.statSync(walFile).isDirectory(), true, 'append did not recreate the chain');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// CR-17 / D-CR17: warnings produced inside apply reach the service status. The
// validate-time misreport is covered in router-apply.test.mjs (K4/K19).
test('CR-17: step-7 owner-write-race warning reaches service.status().warnings', async () => {
  const env = await setupService('fixb-warn-', {}, { testHooks: { forceInjection: true } });
  try {
    const proposed = await proposeJournal(env, 'warn body');
    await approve(env, proposed.id);
    const result = await apply(env, proposed.id);
    assert.equal(result.code, 'E_BASE_MOVED');
    assert.equal(result.reason, 'owner-write-race');
    assert.equal(env.service.status().warnings.includes('OWNER_WRITE_RACE'), true);
  } finally {
    cleanup(env);
  }
});
