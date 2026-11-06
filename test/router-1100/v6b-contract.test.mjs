// 1.1.2 contract checks for the three v6 FAILs that remained after 1.1.1:
// K-08 (expiry keeps the proposal body), L-03 (restart rebuilds the queue view
// from proposals/*.json) and K-04 (a pending row is cancellable; `superseded`
// is a legitimate terminal state and is not).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createRouterTools } from '../../src/router/service/tools.mjs';
import { makeService, readJson, tempRoot, writeMemory } from './helpers.mjs';

const CALLER = { kind: 'root', sessionId: 'root-session' };

function propose(service, { title, content, target = 'journal/2026-11.md' }) {
  return service.proposeProposal({
    op: 'journal.append',
    target,
    title,
    content,
  }, { caller: CALLER });
}

function auditRows(vaultDir) {
  const file = path.join(vaultDir, 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function writeStaleQueue(vaultDir, proposalId, ticket) {
  const file = path.join(vaultDir, 'proposals', 'queue.json');
  const queue = readJson(file);
  assert.ok(queue, 'queue.json must exist before it is made stale');
  queue.rev = Number(queue.rev ?? 0) + 1;
  queue.entries = (queue.entries ?? []).map((entry) => (
    entry.proposalId === proposalId ? { ...entry, status: 'pending' } : entry
  ));
  if (!queue.entries.some((entry) => entry.proposalId === proposalId)) {
    queue.entries.push({
      proposalId,
      ticket,
      status: 'pending',
      sessionId: 'unknown-session',
      target: 'journal/2026-11.md',
      op: 'journal.append',
    });
  }
  fs.writeFileSync(file, JSON.stringify(queue, null, 2));
  return queue;
}

function newEnv(temp, { config = {}, now } = {}) {
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  return makeService({
    temp,
    memoryRoot,
    vaultDir: path.join(temp, 'vault'),
    ...(now ? { now } : {}),
    config: { proposalEnabled: true, applyEnabled: true, ...config },
  });
}

test('v6b K-08: blocked-on-user expiry keeps the proposal body and only moves status', async () => {
  const temp = tempRoot('v6b-k08-retention-');
  let clock = new Date('2026-11-05T05:00:00.000Z');
  const env = newEnv(temp, {
    now: () => clock,
    config: { blockedOnUserTtlMs: 24 * 3600 * 1000 },
  });
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const proposed = await propose(env.service, { title: 'blocked', content: 'blocked body' });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    await env.service.requestApply({ mode: 'approve', id: proposed.id, confirm: proposed.id.slice(-6) }, { caller: CALLER });

    // A foreign live writer wins the lease, so the apply attempt parks the row
    // in blocked-on-user instead of applying it.
    fs.mkdirSync(path.join(env.vaultDir, 'locks'), { recursive: true });
    fs.writeFileSync(path.join(env.vaultDir, 'locks', 'writer.lease.json'), JSON.stringify({
      v: 1,
      holder: 'v6b-other',
      proposalId: 'other',
      pid: process.pid,
      host: 'other-host',
      runId: 'other-run',
      acquiredAt: clock.toISOString(),
      expiresAt: new Date(clock.getTime() + 10 * 60 * 1000).toISOString(),
      renewals: 0,
    }));
    const queued = await env.service.requestApply({ mode: 'apply', id: proposed.id, confirm: proposed.id.slice(-6) }, { caller: CALLER });
    assert.equal(queued.ok, true, JSON.stringify(queued));

    clock = new Date(clock.getTime() + 5 * 60 * 1000 + 1000);
    await env.service.tick({ tier: 'full', reason: 'v6b-k08' });
    const file = path.join(env.vaultDir, 'proposals', `${proposed.id}.json`);
    assert.equal(readJson(file).status, 'blocked-on-user');
    assert.equal(fs.existsSync(file), true);

    clock = new Date(clock.getTime() + 24 * 3600 * 1000 + 1000);
    await env.service.tick({ tier: 'full', reason: 'v6b-k08' });
    assert.equal(fs.existsSync(file), true, 'expiry must not delete the proposal body');
    const expired = readJson(file);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.queue.ticket, 'q-0001', 'the released ticket stays readable on the expired body');
    assert.equal(env.service.status().queue.expired, 1);

    const rows = auditRows(env.vaultDir);
    const expiry = rows.filter((row) => row.kind === 'proposal.expired').at(-1);
    assert.ok(expiry, 'expiry must be audited');
    assert.equal(expiry.bodyKept, true);
    assert.equal(expiry.reason, 'blocked-on-user-ttl');
    assert.equal(rows.some((row) => row.kind === 'proposal.retention_lost'), false);

    // Ticket release keeps `tailTicket` semantics: the released q-0001 is not
    // reused, the next proposal goes to the tail as q-0002.
    const next = await propose(env.service, { title: 'next', content: 'next body', target: 'journal/2026-12.md' });
    assert.equal(next.ticket, 2);
    assert.equal(next.ticketName, 'q-0002');
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6b K-08: the 72h proposal TTL expires in place instead of removing the file', async () => {
  const temp = tempRoot('v6b-k08-ttl-');
  let clock = new Date('2026-11-05T05:00:00.000Z');
  const env = newEnv(temp, { now: () => clock, config: { proposalTtlH: 72 } });
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const proposed = await propose(env.service, { title: 'stale', content: 'stale body' });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    clock = new Date(clock.getTime() + 72 * 3600 * 1000 + 1000);
    await env.service.tick({ tier: 'full', reason: 'v6b-k08-ttl' });

    const file = path.join(env.vaultDir, 'proposals', `${proposed.id}.json`);
    assert.equal(fs.existsSync(file), true, 'proposal TTL must not delete the proposal body');
    assert.equal(readJson(file).status, 'expired');
    assert.equal(env.service.status().queue.expired, 1);
    const expiry = auditRows(env.vaultDir).filter((row) => row.kind === 'proposal.expired').at(-1);
    assert.equal(expiry.bodyKept, true);
    assert.equal(expiry.reason, 'proposal-ttl');
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6b L-03: a restart rebuilds list/queue/status from proposals/*.json', async () => {
  const temp = tempRoot('v6b-l03-restart-');
  const first = newEnv(temp);
  let firstId = null;
  try {
    const started = await first.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const one = await propose(first.service, { title: 'one', content: 'body one' });
    const two = await propose(first.service, { title: 'two', content: 'body two' });
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.equal(two.ok, true, JSON.stringify(two));
    // Same-target small writes coalesce: the second row is legitimately
    // superseded by the first (DESIGN §5.8/K20), it is not a lost proposal.
    assert.equal(readJson(path.join(first.vaultDir, 'proposals', `${two.id}.json`)).status, 'superseded');
    await first.service.requestApply({ mode: 'approve', id: one.id, confirm: one.id.slice(-6) }, { caller: CALLER });
    firstId = one.id;
    await first.service.stop('v6b-l03');
    await first.service.dispose();

    // Simulate the crash window: the proposal file says approved, the queue
    // cache still says pending. Start must reconcile the cache, not trust it.
    writeStaleQueue(first.vaultDir, firstId, 'q-0001');

    const second = newEnv(temp);
    try {
      const restarted = await second.service.start();
      assert.equal(restarted.ok, true, JSON.stringify(restarted));
      const caller = CALLER;
      const list = second.service.proposalsView({ mode: 'list', limit: 50 }, { caller });
      assert.equal(list.ok, true, JSON.stringify(list));
      assert.equal(list.proposals.length, 2, JSON.stringify(list.proposals));
      const byTicket = new Map(list.proposals.map((row) => [row.ticket, row]));
      assert.equal(byTicket.get('q-0001').state, 'approved');
      assert.equal(byTicket.get('q-0001').status, 'approved');
      assert.equal(byTicket.get('q-0002').state, 'superseded');

      const queue = second.service.proposalsView({ mode: 'queue' }, { caller });
      const entry = (queue.entries ?? []).find((item) => item.ticket === 'q-0001');
      assert.equal(entry.status, 'approved', 'the rebuilt queue view must agree with the proposal file');

      const queueFile = readJson(path.join(second.vaultDir, 'proposals', 'queue.json'));
      assert.equal(queueFile.entries.find((item) => item.ticket === 'q-0001').status, 'approved');

      const status = second.service.status();
      assert.equal(status.proposals.pending, 0);
      assert.equal(status.proposals.approved, 1);
      assert.equal(status.proposals.superseded, 1);
      assert.equal(status.queue.pending, 0);

      const restored = auditRows(second.vaultDir).filter((row) => row.kind === 'queue.restored');
      assert.ok(restored.length >= 1, 'a reconciliation must be audited');
      assert.equal(restored.at(-1).written, true);
    } finally {
      await second.service.dispose();
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6b K-04: pending rows are cancellable by id and by ticket; superseded rows are terminal', async () => {
  const temp = tempRoot('v6b-k04-cancel-');
  const env = newEnv(temp);
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const one = await propose(env.service, { title: 'keep', content: 'keep body' });
    const two = await propose(env.service, { title: 'merge-2', content: 'merge body 2' });
    const three = await propose(env.service, { title: 'merge-3', content: 'merge body 3' });
    assert.equal(one.ok, true, JSON.stringify(one));

    const list = env.service.proposalsView({ mode: 'list', limit: 20 }, { caller: CALLER });
    assert.equal(list.ok, true);
    assert.equal(list.proposals.length, 3);
    const rows = new Map(list.proposals.map((row) => [row.ticket, row]));
    assert.equal(rows.get('q-0001').state, 'pending');
    assert.equal(rows.get('q-0001').cancellable, true);
    assert.equal(rows.get('q-0001').terminal, false);
    for (const absorbedId of [two.id, three.id]) {
      const stored = readJson(path.join(env.vaultDir, 'proposals', `${absorbedId}.json`));
      const row = rows.get(stored.queue?.ticket);
      assert.ok(row, `absorbed row ${absorbedId} must stay listed`);
      assert.equal(row.state, 'superseded');
      assert.equal(row.cancellable, false);
      assert.equal(row.terminal, true);
    }

    // Cancel the pending row through the tool seam, addressed by ticket only.
    const tools = createRouterTools(env.service);
    const applyTool = tools.find((tool) => tool.name === 'router_apply');
    assert.ok(applyTool, 'router_apply must exist');
    const cancelled = await applyTool.invoke({ mode: 'cancel', ticket: 'q-0001', note: 'v6b' }, { caller: CALLER });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(readJson(path.join(env.vaultDir, 'proposals', `${one.id}.json`)).status, 'cancelled');
    assert.ok(auditRows(env.vaultDir).some((row) => row.kind === 'proposal.cancel' && row.id === one.id));

    // A terminal row cannot be cancelled again, and superseded rows never were
    // cancellable: the criterion is "pending rows are cancellable", not "all rows".
    const again = await env.service.requestApply({ mode: 'cancel', id: one.id }, { caller: CALLER });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'E_BAD_STATE');
    const supersededId = readJson(path.join(env.vaultDir, 'proposals', `${two.id}.json`)).id;
    const rejected = await env.service.requestApply({ mode: 'cancel', id: supersededId }, { caller: CALLER });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'E_BAD_STATE');
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('v6b K-04/L-03: router_proposals rows expose state+status and match status counts', async () => {
  const temp = tempRoot('v6b-rows-');
  const env = newEnv(temp);
  try {
    const started = await env.service.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const one = await propose(env.service, { title: 'rows', content: 'row body' });
    const two = await propose(env.service, { title: 'rows-2', content: 'row body 2' });
    assert.equal(one.ok, true, JSON.stringify(one));

    const tools = createRouterTools(env.service);
    const listTool = tools.find((tool) => tool.name === 'router_proposals');
    const listed = await listTool.invoke({ mode: 'list', limit: 20 }, { caller: CALLER });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    for (const row of listed.proposals) {
      assert.equal(typeof row.state, 'string');
      assert.equal(row.status, row.state, 'status must mirror state');
      assert.equal(typeof row.cancellable, 'boolean');
      assert.equal(typeof row.terminal, 'boolean');
    }
    const status = env.service.status();
    assert.equal(listed.proposals.length, status.proposals.pending + status.proposals.approved + status.proposals.superseded);
    assert.ok(listed.proposals.some((row) => row.ticket === 'q-0002' && row.state === 'superseded'));
  } finally {
    await env.service.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
