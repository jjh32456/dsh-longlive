// WP4a — queue / lease / WAL / wake / tick-lock (K16, K17, K18, K21–K25, K27).
//
// These tests drive the modules directly (no host, no timers) and use the same
// on-disk layout as the service so a failure here is a protocol failure.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeRouterConfig } from '../../src/router/service/config.mjs';
import { createProposalEngine } from '../../src/router/service/proposals.mjs';
import { createQueueManager } from '../../src/router/service/queue.mjs';
import { createTickLock } from '../../src/router/service/ticklock.mjs';
import { createWal } from '../../src/router/service/wal.mjs';
import { createWakeChannel, wakeIdFor } from '../../src/router/service/wake.mjs';
import { createWriterLease } from '../../src/router/service/lease.mjs';
import { scanProposalDir } from '../../src/router/service/store.mjs';
import { localDayKey } from '../../src/router/service/paths.mjs';
import { makeService, readJson, tempRoot, writeMemory } from './helpers.mjs';

function setup(prefix = 'wp4a-') {
  const temp = tempRoot(prefix);
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const config = normalizeRouterConfig({
    proposalEnabled: true,
    applyEnabled: true,
    agingSeconds: 10,
    leaseWaitTimeoutMs: 300000,
    blockedOnUserTtlMs: 86400000,
    // K16 issues a 10-proposal burst from one root session on purpose. The
    // in-lock rate re-check (D-CR5) is real behaviour now, so the fixture must
    // raise the per-session ceiling above the burst instead of relying on the
    // old pre-lock racing window.
    proposalsPerSessionHour: 60,
  });
  const audit = [];
  const auditFn = (kind, data = {}) => audit.push({ kind, ...data });
  const paths = { vaultDir, proposalsDir: path.join(vaultDir, 'proposals'), liveRoot: memoryRoot };
  const wal = createWal({ file: path.join(paths.proposalsDir, 'wal.jsonl'), audit: auditFn });
  const engine = createProposalEngine({ config, paths, memoryRoot, audit: auditFn, now: () => new Date() });
  const wakeChannel = createWakeChannel({ vaultDir, config, audit: auditFn, now: () => new Date() });
  engine.wake = wakeChannel;
  const queue = createQueueManager({ paths, config, wal, audit: auditFn, now: () => new Date() });
  return { temp, memoryRoot, vaultDir, config, paths, audit, wal, engine, queue, wakeChannel, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

function propose(engine, content, extra = {}) {
  return engine.propose({
    op: 'journal.append',
    target: 'journal/2026-11.md',
    title: `t-${content}`,
    content,
    ...extra,
  }, { caller: { kind: 'root', sessionId: 'root-session' } });
}

test('K16: two engines sharing a vault serialize ticket allocation inside issue.lock', async () => {
  const env = setup('wp4a-k16-');
  try {
    const env2 = {
      engine: createProposalEngine({
        config: env.config,
        paths: env.paths,
        memoryRoot: env.memoryRoot,
        audit: () => {},
        now: () => new Date(),
      }),
    };
    // One target per proposal: this test isolates ticket-allocation ordering;
    // same-target small writes would legitimately coalesce under §5.8.
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (
      propose(
        index % 2 === 0 ? env.engine : env2.engine,
        `body-${index}`,
        { target: `journal/2026-${String(index + 1).padStart(2, '0')}.md` },
      )
    )));
    const tickets = results.map((result) => result.ticket);
    assert.equal(new Set(tickets).size, tickets.length, 'no ticket may be issued twice');
    assert.deepEqual(tickets.slice().sort((a, b) => a - b), tickets, 'ticket order follows the serialized proposal order');
    const walLines = env.wal.read().lines;
    for (let index = 1; index < walLines.length; index += 1) {
      assert.equal(walLines[index].seq, walLines[index - 1].seq + 1);
      assert.equal(walLines[index].prev, walLines[index - 1].hash);
    }
    assert.equal(walLines.filter((line) => line.ev === 'queue.assign').length, 10);
  } finally {
    env.cleanup();
  }
});

test('K16/K17: a stale tick.lock is reclaimed through tick.reclaim.lock with evidence', () => {
  const env = setup('wp4a-k17-');
  try {
    const tickFile = path.join(env.vaultDir, 'tick.lock');
    fs.mkdirSync(path.dirname(tickFile), { recursive: true });
    fs.writeFileSync(tickFile, JSON.stringify({ v: 1, pid: 999999, host: 'local', startedAt: new Date(Date.now() - 3600000).toISOString() }));
    const lock = createTickLock({ file: tickFile, maxHoldMs: 1000, audit: () => {} });
    const first = lock.tryAcquire();
    assert.equal(first.ok, true);
    assert.equal(first.reclaimed, true);
    const evidence = fs.readdirSync(env.vaultDir).filter((name) => name.startsWith('tick.reclaimed-'));
    assert.equal(evidence.length, 1, 'old lock renamed, not unlinked');
    assert.equal(JSON.parse(fs.readFileSync(tickFile, 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'tick.reclaim.lock')), false);
    lock.release();

    // A live holder makes the next round a quiet skip.
    fs.writeFileSync(tickFile, JSON.stringify({ v: 1, pid: process.pid, host: 'local', startedAt: new Date().toISOString() }));
    const busy = lock.tryAcquire();
    assert.equal(busy.ok, false);
    assert.equal(busy.reason, 'busy');
    assert.equal(JSON.parse(fs.readFileSync(tickFile, 'utf8')).pid, process.pid, 'never steals a live lock');
    lock.release();
  } finally {
    env.cleanup();
  }
});

test('K17: an unrecoverable reclaim mutex yields reclaim-busy instead of waiting', () => {
  const env = setup('wp4a-k17b-');
  try {
    const tickFile = path.join(env.vaultDir, 'tick.lock');
    fs.mkdirSync(path.dirname(tickFile), { recursive: true });
    fs.writeFileSync(tickFile, JSON.stringify({ v: 1, pid: 999999, host: 'local', startedAt: new Date(Date.now() - 3600000).toISOString() }));
    fs.writeFileSync(path.join(env.vaultDir, 'tick.reclaim.lock'), '');
    const lock = createTickLock({ file: tickFile, maxHoldMs: 1000, audit: () => {} });
    const result = lock.tryAcquire();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reclaim-busy');
    assert.equal(fs.existsSync(tickFile), true, 'old lock left untouched');
  } finally {
    env.cleanup();
  }
});

test('K21: a half-written WAL tail is dropped, audited, and the chain continues', async () => {
  const env = setup('wp4a-k21-');
  try {
    await propose(env.engine, 'one');
    await propose(env.engine, 'two');
    const walFile = path.join(env.paths.proposalsDir, 'wal.jsonl');
    fs.appendFileSync(walFile, '{"seq":3,"at":"2026-11-05T00:00:00.000Z","ev":"apply.be');
    const read = env.wal.read();
    assert.equal(read.lines.length, 2);
    assert.equal(read.broken, false);
    assert.ok(env.audit.some((row) => row.kind === 'wal.corrupt'), 'corruption is audited');
    const appended = env.wal.append('queue.reconcile', { reason: 'test' });
    assert.equal(appended.seq, 3);
    assert.equal(env.wal.read().lines.length, 3);
  } finally {
    env.cleanup();
  }
});

test('K22/K25: queue rebuild reissues a lost assignment and drops orphan entries', async () => {
  const env = setup('wp4a-k22-');
  try {
    const created = await propose(env.engine, 'lost assign');
    const proposalFile = path.join(env.paths.proposalsDir, `${created.id}.json`);
    // Simulate a crash between proposal write and WAL/queue write: no assign line,
    // no queue file. The proposal itself must survive and get a tail ticket.
    fs.writeFileSync(path.join(env.paths.proposalsDir, 'wal.jsonl'), '');
    fs.rmSync(path.join(env.paths.proposalsDir, 'queue.json'), { force: true });
    const rebuilt = env.queue.rebuild();
    assert.equal(rebuilt.recovered.length, 1);
    const proposal = readJson(proposalFile);
    assert.equal(proposal.status, 'pending');
    assert.notEqual(proposal.queue.ticket, created.ticket);
    assert.match(proposal.stateLog.at(-1).note, /queue\.assign\.recovered/);
    const walLines = env.wal.read().lines;
    assert.equal(walLines.at(-1).ev, 'queue.assign.recovered');
    assert.equal(walLines.at(-1).ticket, proposal.queue.ticket);

    // An orphan queue entry (proposal deleted) is reconciled away.
    const queueFile = path.join(env.paths.proposalsDir, 'queue.json');
    const queue = readJson(queueFile);
    queue.entries.push({ ticket: 'q-0099', proposalId: 'p-20260101T000000-abcdef', status: 'queued' });
    fs.writeFileSync(queueFile, JSON.stringify(queue));
    const again = env.queue.rebuild();
    assert.ok(again.orphans.length >= 1);
    assert.ok(env.audit.some((row) => row.kind === 'queue.reconcile'));
    const after = readJson(queueFile);
    assert.equal(after.entries.some((entry) => entry.ticket === 'q-0099'), false);
  } finally {
    env.cleanup();
  }
});

test('K18/K21: lease reclaim renames evidence and clock rollback is audited', () => {
  const env = setup('wp4a-k18-');
  try {
    const locksDir = path.join(env.vaultDir, 'locks');
    const leaseFile = path.join(locksDir, 'writer.lease.json');
    let wall = Date.now();
    const holder = { sessionId: 's1', runId: 'run-1', pid: process.pid, host: 'local' };
    const audit = [];
    const lease = createWriterLease({
      file: leaseFile,
      lockDir: locksDir,
      ttlMs: 120000,
      renewalsMax: 2,
      holder,
      now: () => new Date(wall),
      audit: (kind, data) => audit.push({ kind, ...data }),
    });
    assert.equal(lease.acquire({ ticket: 'q-0001', proposalId: 'p-20260101T000000-abcdef' }).ok, true);
    // Force expiry and let another process reclaim it.
    const stored = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    stored.expiresAt = new Date(wall - 1000).toISOString();
    fs.writeFileSync(leaseFile, JSON.stringify(stored));
    const lease2 = createWriterLease({
      file: leaseFile,
      lockDir: locksDir,
      ttlMs: 120000,
      renewalsMax: 2,
      holder: { sessionId: 's2', runId: 'run-2', pid: 999999, host: 'local' },
      now: () => new Date(wall),
      audit: (kind, data) => audit.push({ kind, ...data }),
    });
    const reclaimed = lease2.acquire({ ticket: 'q-0002', proposalId: 'p-20260101T000001-abcdef' });
    assert.equal(reclaimed.ok, true);
    const evidence = fs.readdirSync(locksDir).filter((name) => name.startsWith('reclaimed-'));
    assert.equal(evidence.length, 1, 'expired lease kept as evidence');
    assert.ok(audit.some((row) => row.kind === 'lease.expired'));

    // Clock going backwards is detected and audited.
    wall -= 10 * 60 * 1000;
    lease2.renew();
    assert.ok(audit.some((row) => row.kind === 'lease.clock_skew'));
  } finally {
    env.cleanup();
  }
});

test('K21: a zero-byte lease is reclaimed as evidence instead of blocking forever', () => {
  const env = setup('wp4a-zero-lease-');
  try {
    const lockDir = path.join(env.vaultDir, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const leaseFile = path.join(lockDir, 'writer.lease.json');
    fs.writeFileSync(leaseFile, '', 'utf8');
    const lease = createWriterLease({
      file: leaseFile,
      lockDir,
      ttlMs: 60000,
      renewalsMax: 2,
      holder: { sessionId: 'recover', runId: 'run-recover', pid: process.pid, host: 'local' },
      audit: (kind, data) => env.audit.push({ kind, ...data }),
    });
    const acquired = lease.acquire({ ticket: 'q-0001', proposalId: 'p-20261105T000000-abcdef' });
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    assert.equal(fs.existsSync(path.join(lockDir, 'reclaim.lock')), false);
    const evidence = fs.readdirSync(lockDir).filter((name) => name.startsWith('reclaimed-corrupt-'));
    assert.equal(evidence.length, 1);
    assert.ok(env.audit.some((row) => row.kind === 'lease.expired' && row.reason === 'zero-or-corrupt'));
  } finally {
    env.cleanup();
  }
});

test('K27: Tier A always records readiness; Tier B dedupes by wakeId and never resends after flush failure', async () => {
  const env = setup('wp4a-k27-');
  try {
    const created = await propose(env.engine, 'wake me');
    const readyFile = path.join(env.vaultDir, 'wake-ready.jsonl');
    const lines = fs.readFileSync(readyFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ticket, created.ticketName);
    assert.equal(lines[0].id, wakeIdFor('root-session', created.ticketName, localDayKey(lines[0].createdAt)));
    assert.equal('consumedAt' in lines[0], false);

    const audit = [];
    const wake = createWakeChannel({
      vaultDir: env.vaultDir,
      config: { ...env.config, wakeEnabled: true, wakeCooldownMs: 0, wakeDailyQuota: 20 },
      now: () => new Date(),
      audit: (kind, data) => audit.push({ kind, ...data }),
    });
    const sessions = [{ sessionId: 'root-session', state: 'idle', isSubagent: false }];
    const first = wake.plan({ sessions });
    assert.equal(first.entries.length, 1);
    wake.recordAttempt({ id: first.entries[0].id, sessionId: 'root-session', ok: false, error: 'flush', flushFailed: true });
    assert.ok(audit.some((row) => row.kind === 'wake.flush_failed'));
    assert.equal(wake.plan({ sessions }).entries.length, 0, 'same wakeId is never resent');
    assert.notEqual(wakeIdFor('root-session', created.ticket, '2026-11-05', 1), first.entries[0].id);
  } finally {
    env.cleanup();
  }
});

test('K23/K24: status projection agrees with queue.json and stays within 16 KB', async () => {
  const temp = tempRoot('wp4a-k23-');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const env = makeService({ temp, memoryRoot, vaultDir, config: { proposalEnabled: true } });
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true);
    await env.service.proposeProposal({
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'status',
      content: 'status body',
    }, { caller: { kind: 'root', sessionId: 'root-session' } });
    const tick = await env.service.tick({ tier: 'reflect', reason: 'test' });
    assert.equal(tick.ok, true);
    const status = readJson(path.join(vaultDir, 'status.json'));
    const queue = readJson(path.join(vaultDir, 'proposals', 'queue.json'));
    assert.equal(status.queue.pending, 1);
    assert.equal(status.proposals.queue.depth, queue.entries.length);
    assert.equal(status.proposals.queue.seqCounter, queue.seqCounter);
    assert.equal(status.wal.lastSeq, queue.seqCounter - 1);
    assert.ok(fs.statSync(path.join(vaultDir, 'status.json')).size <= 16 * 1024);
    assert.ok(fs.statSync(path.join(vaultDir, 'proposals', 'queue.json')).size <= 64 * 1024);
  } finally {
    env.cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('K24: approved proposals age by one level per aging window, capped at P1', async () => {
  const env = setup('wp4a-aging-');
  try {
    const created = await propose(env.engine, 'age me', { priority: 'P4' });
    const file = path.join(env.paths.proposalsDir, `${created.id}.json`);
    const proposal = readJson(file);
    proposal.queue.queuedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(proposal));
    env.queue.maintain();
    const aged = readJson(file);
    assert.ok(aged.queue.agingSteps >= 1);
    assert.ok(['P1', 'P2', 'P3'].includes(aged.queue.effectivePriority));
    assert.ok(env.audit.some((row) => row.kind === 'queue.aging'));
  } finally {
    env.cleanup();
  }
});

test('scanProposalDir is the single queue source (no queue-only proposal)', () => {
  const env = setup('wp4a-scan-');
  try {
    const scan = scanProposalDir(env.paths.proposalsDir);
    assert.equal(scan.proposals.length, 0);
    assert.equal(fs.existsSync(env.paths.proposalsDir), false, 'read-only scan never creates the directory');
  } finally {
    env.cleanup();
  }
});
