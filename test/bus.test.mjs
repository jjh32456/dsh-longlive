// Bus prototype tests — dependency-free runner.
//
// Run with the bundled Node runtime:
//   node --test test/bus.test.mjs
//
// Every temp directory is created under <repo>/.tmp-test and removed afterwards.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createBus,
  DEFAULT_WRITER_TTL_MS,
  MAX_TTL_MS,
  DEFAULT_MAX_BODY_CHARS,
  mergePendingAckIds,
  shouldAckOnTurnEnd,
} from '../src/bus/bus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP_BASE = path.join(REPO, '.tmp-test');
const BUS_URL = pathToFileURL(path.join(REPO, 'src', 'bus', 'bus.mjs')).href;
const HOST = 'testhost';

fs.mkdirSync(TMP_BASE, { recursive: true });

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok ${results.length} - ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`not ok ${results.length} - ${name}`);
    console.log(String(error && error.stack ? error.stack : error).split('\n').slice(0, 8).join('\n'));
  }
}

function setup(tag) {
  const memoryRoot = fs.mkdtempSync(path.join(TMP_BASE, `${tag}-`));
  const root = path.join(memoryRoot, '.longlive', 'bus');
  const clock = { value: Date.now() };
  const make = (sessionId, extra = {}) => createBus({
    root,
    sessionId,
    host: HOST,
    memoryRoot,
    now: () => clock.value,
    ...extra,
  });
  return {
    memoryRoot,
    root,
    clock,
    make,
    alice: make('session-alice'),
    bob: make('session-bob'),
    cleanup: () => fs.rmSync(memoryRoot, { recursive: true, force: true }),
  };
}

function writeLiveRow(memoryRoot, sessionId, options = {}) {
  const dir = path.join(memoryRoot, '.longlive', 'live');
  fs.mkdirSync(dir, { recursive: true });
  const now = options.now ?? Date.now();
  const heartbeatAt = new Date(now - (options.heartbeatAgeMs ?? 0)).toISOString();
  const row = {
    schemaVersion: 1,
    sessionId,
    pid: options.pid ?? process.pid,
    host: options.host ?? HOST,
    startedAt: heartbeatAt,
    updatedAt: heartbeatAt,
    heartbeatAt,
    ttlMs: options.ttlMs ?? 60000,
    state: options.state ?? 'running',
    turn: 1,
    goal: '',
    blocked_on: '',
    queued: [],
    last_action: { at: heartbeatAt, kind: 'turn', detail: '' },
  };
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(row, null, 2));
}

function runNode(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`child exited ${exitCode}: ${stderr.slice(0, 500)}`));
    });
  });
}

// 1. Basic round trip.
await test('send / poll / ack round trip', async () => {
  const s = setup('basic');
  try {
    const sent = s.alice.send({ to: 'session-bob', body: 'hello', kind: 'note' });
    assert.equal(sent.ok, true);
    assert.match(sent.id, /^m-/);
    const first = s.bob.poll({ since: 0 });
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].body, 'hello');
    assert.equal(first.messages[0].from, 'session-alice');
    assert.equal(first.messages[0].to, 'session-bob');
    assert.equal(first.messages[0].host, HOST);
    const acked = s.bob.ack(sent.id);
    assert.equal(acked.ok, true);
    assert.equal(acked.already, false);
    const second = s.bob.poll({ since: 0 });
    assert.equal(second.messages.length, 0);
  } finally {
    s.cleanup();
  }
});

// 2. poll is non-destructive until ack.
await test('poll is at-least-once (repeat poll before ack)', async () => {
  const s = setup('at-least-once');
  try {
    const sent = s.alice.send({ to: 'session-bob', body: 'retry me' });
    const a = s.bob.poll({ since: 0 });
    const b = s.bob.poll({ since: 0 });
    assert.equal(a.messages.length, 1);
    assert.equal(b.messages.length, 1);
    assert.equal(a.messages[0].id, sent.id);
    assert.equal(b.messages[0].id, sent.id);
    s.bob.ack(sent.id);
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 0);
  } finally {
    s.cleanup();
  }
});

// 3. Duplicate ack is idempotent; unknown id is E_NOT_FOUND.
await test('duplicate ack is idempotent', async () => {
  const s = setup('dup-ack');
  try {
    const sent = s.alice.send({ to: 'session-bob', body: 'ack twice' });
    const first = s.bob.ack(sent.id);
    const second = s.bob.ack(sent.id);
    assert.equal(first.ok, true);
    assert.equal(first.already, false);
    assert.equal(second.ok, true);
    assert.equal(second.already, true);
    const missing = s.bob.ack('m-000000000-0001-000001-deadbeef');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'E_NOT_FOUND');
  } finally {
    s.cleanup();
  }
});

// 4. dedupKey makes send idempotent; a conflicting reuse is rejected.
await test('dedupKey send idempotency and conflict', async () => {
  const s = setup('idempotent');
  try {
    const first = s.alice.send({ to: 'session-bob', body: 'same', dedupKey: 'job-1' });
    const second = s.alice.send({ to: 'session-bob', body: 'same', dedupKey: 'job-1' });
    assert.equal(first.id, second.id);
    assert.equal(second.results[0].deduped, true);
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 1);
    await assert.rejects(
      async () => s.alice.send({ to: 'session-bob', body: 'different', dedupKey: 'job-1' }),
      (error) => error.code === 'E_DEDUP_CONFLICT',
    );
  } finally {
    s.cleanup();
  }
});

// 5. TTL expiry is evaluated by the receiver and removes the file.
await test('TTL expiry discards the message', async () => {
  const s = setup('expiry');
  try {
    s.clock.value = 1_000_000;
    s.alice.send({ to: 'session-bob', body: 'soon gone', ttl: 1000 });
    s.clock.value += 1001;
    const polled = s.bob.poll({ since: 0 });
    assert.equal(polled.messages.length, 0);
    assert.equal(polled.expired, 1);
    assert.equal(polled.scanned, 1);
    const inbox = path.join(s.root, 'inbox', 'session-bob');
    assert.equal(fs.readdirSync(inbox).filter((name) => name.endsWith('.json')).length, 0);
  } finally {
    s.cleanup();
  }
});

// 6. Dead peer is refused by default, allowed explicitly; roles skip dead members.
await test('dead session refusal and allowDead / role skip', async () => {
  const s = setup('dead');
  try {
    writeLiveRow(s.memoryRoot, 'session-dead', { heartbeatAgeMs: 10 * 60 * 1000, ttlMs: 60000, pid: 999999 });
    writeLiveRow(s.memoryRoot, 'session-alive', { heartbeatAgeMs: 0, ttlMs: 60000 });
    await assert.rejects(
      async () => s.alice.send({ to: 'session-dead', body: 'anyone?' }),
      (error) => error.code === 'E_PEER_DEAD',
    );
    const forced = s.alice.send({ to: 'session-dead', body: 'stored', allowDead: true });
    assert.equal(forced.ok, true);
    const deadBus = s.make('session-dead');
    assert.equal(deadBus.poll({ since: 0 }).messages.length, 1);

    fs.writeFileSync(path.join(s.root, 'roles.json'), JSON.stringify({ team: ['session-alive', 'session-dead'] }));
    const roleSend = s.alice.send({ to: '#team', body: 'role hello' });
    assert.equal(roleSend.results.length, 1);
    assert.equal(roleSend.results[0].to, 'session-alive');
    assert.equal(roleSend.partial, true);
    assert.ok(roleSend.skipped.some((item) => item.to === 'session-dead' && item.reason === 'dead'));
    const aliveBus = s.make('session-alive');
    assert.equal(aliveBus.poll({ since: 0 }).messages.length, 1);
  } finally {
    s.cleanup();
  }
});

// 7. Path traversal, reserved names, and bad poll ids are rejected.
await test('path escape and bad session ids', async () => {
  const s = setup('path');
  try {
    const badTargets = ['../evil', '..\\evil', 'C:\\evil', 'a/b', '..', '.', 'con', 'nul', 'session-x/../y', 'session-x\u0000y'];
    for (const bad of badTargets) {
      await assert.rejects(
        async () => s.alice.send({ to: bad, body: 'x' }),
        (error) => error.code === 'E_PATH_OUTSIDE_ROOT' || error.code === 'E_BAD_SESSION_ID',
        `expected rejection for ${JSON.stringify(bad)}`,
      );
    }
    await assert.rejects(
      async () => s.bob.poll({ sessionId: '../x' }),
      (error) => error.code === 'E_PATH_OUTSIDE_ROOT',
    );
    assert.equal(fs.existsSync(path.join(s.root, '..', 'evil.json')), false);
  } finally {
    s.cleanup();
  }
});

// 8. Backlog cap blocks new sends until a slot is freed.
await test('backlog cap', async () => {
  const s = setup('backlog');
  try {
    const alice = s.make('session-alice', { maxPending: 3 });
    const sent = [];
    for (let i = 0; i < 3; i += 1) sent.push(alice.send({ to: 'session-bob', body: `m${i}` }));
    await assert.rejects(
      async () => alice.send({ to: 'session-bob', body: 'overflow' }),
      (error) => error.code === 'E_BACKLOG_FULL',
    );
    s.bob.ack(sent[0].id);
    const after = alice.send({ to: 'session-bob', body: 'fits now' });
    assert.equal(after.ok, true);
  } finally {
    s.cleanup();
  }
});

// 9. A fresh handle sees the same on-disk queue.
await test('restart recovery with a new handle', async () => {
  const s = setup('restart');
  try {
    const sent = s.alice.send({ to: 'session-bob', body: 'persisted' });
    const restarted = s.make('session-bob');
    const polled = restarted.poll({ since: 0 });
    assert.equal(polled.messages.length, 1);
    assert.equal(polled.messages[0].id, sent.id);
    restarted.ack(sent.id);
    const third = s.make('session-bob');
    assert.equal(third.poll({ since: 0 }).messages.length, 0);
  } finally {
    s.cleanup();
  }
});

// 10. Three processes deliver 15 messages each without loss or duplication.
await test('concurrent delivery from three processes', async () => {
  const s = setup('concurrent');
  try {
    const code = `
      import { createBus } from ${JSON.stringify(BUS_URL)};
      const bus = createBus({
        root: process.env.BUS_ROOT,
        sessionId: 'session-alice',
        host: ${JSON.stringify(HOST)},
      });
      for (let i = 0; i < 15; i += 1) {
        bus.send({
          to: 'session-bob',
          body: 'worker-' + process.env.WORKER + '-' + i,
          dedupKey: 'worker-' + process.env.WORKER + '-' + i,
        });
      }
    `;
    await Promise.all([0, 1, 2].map((worker) => runNode(code, {
      BUS_ROOT: s.root,
      WORKER: String(worker),
    })));
    const polled = s.bob.poll({ since: 0, limit: 100 });
    assert.equal(polled.messages.length, 45);
    assert.equal(new Set(polled.messages.map((message) => message.id)).size, 45);
    assert.equal(new Set(polled.messages.map((message) => message.body)).size, 45);
  } finally {
    s.cleanup();
  }
});

// 11. Alias (1:1) and role (1:N, deduplicated) addressing.
await test('alias and role addressing', async () => {
  const s = setup('addressing');
  try {
    fs.writeFileSync(path.join(s.root, 'aliases.json'), JSON.stringify({ reviewer: 'session-bob' }));
    fs.writeFileSync(path.join(s.root, 'roles.json'), JSON.stringify({ team: ['session-bob', 'session-carol', 'session-bob'] }));
    s.alice.send({ to: '@reviewer', body: 'alias hello' });
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 1);
    const carol = s.make('session-carol');
    const roleSend = s.alice.send({ to: '#team', body: 'role hello' });
    assert.equal(roleSend.results.length, 2);
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 2);
    assert.equal(carol.poll({ since: 0 }).messages.length, 1);
    await assert.rejects(
      async () => s.alice.send({ to: '@nobody', body: 'x' }),
      (error) => error.code === 'E_UNKNOWN_TARGET',
    );
  } finally {
    s.cleanup();
  }
});

// 12. Foreign-host messages are never delivered; remote peers are refused.
await test('cross-host isolation', async () => {
  const s = setup('foreign');
  try {
    writeLiveRow(s.memoryRoot, 'session-remote', { host: 'other-host', heartbeatAgeMs: 0, ttlMs: 60000 });
    await assert.rejects(
      async () => s.alice.send({ to: 'session-remote', body: 'x' }),
      (error) => error.code === 'E_REMOTE_HOST',
    );
    const inbox = path.join(s.root, 'inbox', 'session-bob');
    fs.mkdirSync(inbox, { recursive: true });
    const id = 'm-000000000-0001-000001-deadbeef';
    fs.writeFileSync(path.join(inbox, `${id}.json`), JSON.stringify({
      v: 1, id, from: 'session-alice', to: 'session-bob', kind: 'note',
      body: 'foreign', ts: Date.now(), ttl: 60000, host: 'other-host',
    }));
    const polled = s.bob.poll({ since: 0 });
    assert.equal(polled.messages.length, 0);
    assert.equal(polled.foreignHost, 1);
    assert.equal(fs.existsSync(path.join(inbox, `${id}.json`)), false);
  } finally {
    s.cleanup();
  }
});

// 13. A corrupt file is quarantined and does not block later messages.
await test('corrupt message isolation', async () => {
  const s = setup('corrupt');
  try {
    const inbox = path.join(s.root, 'inbox', 'session-bob');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'm-bad.json'), '{ this is not json');
    const first = s.bob.poll({ since: 0 });
    assert.equal(first.messages.length, 0);
    assert.equal(first.corrupt, 1);
    assert.equal(fs.existsSync(path.join(inbox, 'm-bad.json')), false);
    s.alice.send({ to: 'session-bob', body: 'after chaos' });
    const second = s.bob.poll({ since: 0 });
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0].body, 'after chaos');
  } finally {
    s.cleanup();
  }
});

// 14. Input limits: body size, kind, ttl, dedupKey, empty target.
await test('input validation limits', async () => {
  const s = setup('limits');
  try {
    await assert.rejects(
      async () => s.alice.send({ to: 'session-bob', body: 'x'.repeat(DEFAULT_MAX_BODY_CHARS + 1) }),
      (error) => error.code === 'E_BODY_TOO_LARGE',
    );
    await assert.rejects(
      async () => s.alice.send({ to: 'session-bob', body: 'x', kind: 'evil' }),
      (error) => error.code === 'E_BAD_KIND',
    );
    await assert.rejects(
      async () => s.alice.send({ to: 'session-bob', body: 'x', ttl: 0 }),
      (error) => error.code === 'E_BAD_TTL',
    );
    await assert.rejects(
      async () => s.alice.send({ to: 'session-bob', body: 'x', ttl: MAX_TTL_MS + 1 }),
      (error) => error.code === 'E_BAD_TTL',
    );
    await assert.rejects(
      async () => s.alice.send({ to: 'session-bob', body: 'x', dedupKey: '' }),
      (error) => error.code === 'E_BAD_DEDUP_KEY',
    );
    await assert.rejects(
      async () => s.alice.send({ to: '', body: 'x' }),
      (error) => error.code === 'E_BAD_TARGET',
    );
  } finally {
    s.cleanup();
  }
});

// 15. Single-writer lease: held, released, and stale takeover.
await test('writer lease uniqueness and stale takeover', async () => {
  const s = setup('lease');
  try {
    const first = s.alice.claimWriter();
    assert.equal(first.ok, true);
    const blocked = s.bob.claimWriter();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.holder, 'session-alice');
    assert.equal(s.alice.writerStatus().held, true);
    assert.equal(s.alice.releaseWriter({ nonce: first.nonce, token: first.token }).released, true);
    const second = s.bob.claimWriter();
    assert.equal(second.ok, true);
    assert.equal(s.bob.writerStatus().holder, 'session-bob');
    s.bob.releaseWriter({ nonce: second.nonce, token: second.token });
    fs.writeFileSync(path.join(s.root, 'writer.lock'), JSON.stringify({
      schemaVersion: 1,
      holder: 'session-carol',
      pid: 999999,
      host: HOST,
      acquiredAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-01T00:01:00.000Z',
      ttlMs: 60000,
    }));
    const takeover = s.alice.claimWriter();
    assert.equal(takeover.ok, true);
    assert.equal(takeover.holder, 'session-alice');
  } finally {
    s.cleanup();
  }
});

// 16. ack gate: only `turn/end` with reason.kind === 'completed'.
await test('t6a ack gate accepts only completed turns', async () => {
  assert.equal(shouldAckOnTurnEnd({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), true);
  assert.equal(shouldAckOnTurnEnd({ type: 'turn/end', data: { reason: { kind: 'error' } } }), false);
  assert.equal(shouldAckOnTurnEnd({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), false);
  assert.equal(shouldAckOnTurnEnd({ type: 'turn/end', data: {} }), false);
  assert.equal(shouldAckOnTurnEnd({ type: 'turn/end' }), false);
  assert.equal(shouldAckOnTurnEnd({ type: 'turn/start', data: { reason: { kind: 'completed' } } }), false);
  assert.equal(shouldAckOnTurnEnd(null), false);
});

// 17. Error/aborted turns must not consume the message; completed does.
await test('t6b failed turn leaves message pending and redeliverable', async () => {
  const s = setup('t6b');
  try {
    const sent = s.alice.send({ to: 'session-bob', body: 'retry me', kind: 'task' });
    const record = { pendingAckIds: [sent.id] };
    const finishTurn = (event) => {
      if (!shouldAckOnTurnEnd(event)) return;
      for (const id of record.pendingAckIds) s.bob.ack(id);
      record.pendingAckIds = [];
    };
    finishTurn({ type: 'turn/end', data: { reason: { kind: 'error' } } });
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 1);
    finishTurn({ type: 'turn/end', data: { reason: { kind: 'aborted' } } });
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 1);
    assert.deepEqual(record.pendingAckIds, [sent.id]);
    finishTurn({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 0);
  } finally {
    s.cleanup();
  }
});

// 18. ack already:true must remove a leftover inbox copy (half-ack repair).
await test('t2c ack already branch deletes the inbox copy', async () => {
  const s = setup('t2c');
  try {
    const sent = s.alice.send({ to: 'session-bob', body: 'half acked', dedupKey: 'half-1' });
    const inbox = path.join(s.root, 'inbox', 'session-bob');
    const acked = path.join(inbox, 'acked');
    fs.mkdirSync(acked, { recursive: true });
    fs.copyFileSync(path.join(inbox, `${sent.id}.json`), path.join(acked, `${sent.id}.json`));
    const result = s.bob.ack(sent.id);
    assert.equal(result.ok, true);
    assert.equal(result.already, true);
    assert.equal(fs.existsSync(path.join(inbox, `${sent.id}.json`)), false);
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 0);
  } finally {
    s.cleanup();
  }
});

// 19. Dedup after ack: the acked copy is a tombstone, not a new delivery.
await test('t2f ack-then-retry with the same dedupKey does not resurrect the id', async () => {
  const s = setup('t2f');
  try {
    const first = s.alice.send({ to: 'session-bob', body: 'job payload', kind: 'task', dedupKey: 'job-42' });
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 1);
    assert.equal(s.bob.ack(first.id).already, false);
    const retry = s.alice.send({ to: 'session-bob', body: 'job payload', kind: 'task', dedupKey: 'job-42' });
    assert.equal(retry.id, first.id);
    assert.equal(retry.results[0].deduped, true);
    assert.equal(retry.results[0].acked, true);
    assert.equal(fs.existsSync(path.join(s.root, 'inbox', 'session-bob', `${first.id}.json`)), false);
    assert.equal(s.bob.poll({ since: 0 }).messages.length, 0);
    assert.equal(s.bob.ack(first.id).already, true);
    assert.equal(fs.existsSync(path.join(s.root, 'inbox', 'session-bob', `${first.id}.json`)), false);
    await assert.rejects(
      async () => s.alice.send({ to: 'session-bob', body: 'different body', kind: 'task', dedupKey: 'job-42' }),
      (error) => error.code === 'E_DEDUP_CONFLICT',
    );
  } finally {
    s.cleanup();
  }
});

// 20. Sender-side clock validation: ts must be positive.
await test('t4f send rejects non-positive timestamps', async () => {
  const s = setup('t4f');
  try {
    for (const value of [0, -1, -1_700_000_000_000]) {
      s.clock.value = value;
      await assert.rejects(
        async () => s.alice.send({ to: 'session-bob', body: 'poison' }),
        (error) => error.code === 'E_BAD_CLOCK',
      );
    }
    assert.equal(fs.existsSync(path.join(s.root, 'inbox', 'session-bob')), false);
    s.clock.value = 1;
    const sent = s.alice.send({ to: 'session-bob', body: 'epoch-ish' });
    assert.equal(sent.ok, true);
    const polled = s.bob.poll({ since: 0 });
    assert.equal(polled.messages.length, 1);
    assert.equal(polled.messages[0].ts, 1);
  } finally {
    s.cleanup();
  }
});

// 21. Envelope id must equal its file name (otherwise ack can never find it).
await test('t3e envelope id / file name mismatch is quarantined', async () => {
  const s = setup('t3e');
  try {
    const dir = path.join(s.root, 'inbox', 'session-bob');
    fs.mkdirSync(dir, { recursive: true });
    const fileId = 'm-000000000-0001-000001-abcdef';
    const envelopeId = 'm-000000000-0002-000001-fedcba';
    const forged = {
      v: 1,
      id: envelopeId,
      from: 'session-alice',
      to: 'session-bob',
      kind: 'note',
      body: 'forged id',
      ts: s.clock.value,
      ttl: 60000,
      host: HOST,
    };
    fs.writeFileSync(path.join(dir, `${fileId}.json`), JSON.stringify(forged));
    const first = s.bob.poll({ since: 0 });
    assert.equal(first.messages.length, 0);
    assert.equal(first.corrupt, 1);
    assert.equal(fs.existsSync(path.join(dir, `${fileId}.json`)), false);
    const quarantined = fs.readdirSync(path.join(dir, 'dead'));
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0], /id-mismatch/);
    assert.equal(s.alice.send({ to: 'session-bob', body: 'real one' }).ok, true);
    assert.equal(s.bob.poll({ since: 0 }).messages[0].body, 'real one');
  } finally {
    s.cleanup();
  }
});

// 22. Fresh heartbeat must not mask a dead pid.
await test('t5b fresh heartbeat with dead pid is still dead', async () => {
  const s = setup('t5b');
  try {
    writeLiveRow(s.memoryRoot, 'session-ghost', {
      pid: 999999, heartbeatAgeMs: 0, ttlMs: 60000, state: 'running',
    });
    const peer = s.alice.peerState('session-ghost');
    assert.equal(peer.state, 'dead');
    assert.equal(peer.reason, 'pid');
    await assert.rejects(
      async () => s.alice.send({ to: 'session-ghost', body: 'anyone there?' }),
      (error) => error.code === 'E_PEER_DEAD',
    );
    const allowed = s.alice.send({ to: 'session-ghost', body: 'stored anyway', allowDead: true });
    assert.equal(allowed.ok, true);
    assert.equal(s.make('session-ghost').poll({ since: 0 }).messages.length, 1);
  } finally {
    s.cleanup();
  }
});

// 23. Same-holder re-claim renews in place, but only with the acquisition nonce.
await test('t8a same-holder re-claim requires the nonce and refreshes in place', async () => {
  const s = setup('t8a');
  try {
    s.clock.value = 1_700_000_000_000;
    const first = s.alice.claimWriter({ ttlMs: 60_000 });
    assert.equal(first.ok, true);
    const before = Date.parse(first.expiresAt);
    s.clock.value += 30_000;
    const wrong = s.alice.claimWriter({ ttlMs: 60_000, nonce: '0'.repeat(32) });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'auth');
    assert.equal(wrong.code, 'E_LEASE_AUTH');
    // P08: knowing the session id is not ownership. A re-claim without the
    // acquisition nonce must not extend the lease or hand the nonce back.
    const missing = s.alice.claimWriter({ ttlMs: 60_000 });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'auth');
    assert.equal(missing.code, 'E_NONCE_REQUIRED');
    const again = s.alice.claimWriter({ ttlMs: 60_000, nonce: first.nonce });
    assert.equal(again.ok, true);
    assert.equal(again.renewed, true);
    assert.equal(again.token, first.token);
    assert.equal(again.nonce, first.nonce);
    assert.ok(Date.parse(again.expiresAt) > before);
    s.clock.value += 10_000;
    const renewed = s.alice.renewWriter({
      nonce: first.nonce, token: first.token, ttlMs: 60_000,
    });
    assert.equal(renewed.ok, true);
    assert.equal(renewed.renewed, true);
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(again.expiresAt));
  } finally {
    s.cleanup();
  }
});

// 24. renewWriter requires the acquisition nonce and refuses expired leases.
await test('t8b renewWriter authenticates and refuses expired leases', async () => {
  const s = setup('t8b');
  try {
    s.clock.value = 1_700_000_000_000;
    const lease = s.alice.claimWriter({ ttlMs: 60_000 });
    s.clock.value += 10_000;
    const bad = s.alice.renewWriter({ nonce: '0'.repeat(32), token: lease.token });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'bad-nonce');
    const renewed = s.alice.renewWriter({ nonce: lease.nonce, token: lease.token });
    assert.equal(renewed.ok, true);
    s.clock.value += 120_000;
    const expired = s.alice.renewWriter({ nonce: lease.nonce, token: lease.token });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, 'expired');
    assert.equal(expired.code, 'E_LEASE_LOST');
  } finally {
    s.cleanup();
  }
});

// 25. releaseWriter requires the per-acquisition nonce; session id is not enough.
await test('t8c releaseWriter rejects cross-session and nonce-less release', async () => {
  const s = setup('t8c');
  try {
    const lease = s.alice.claimWriter({ ttlMs: 60_000 });
    assert.equal(lease.ok, true);
    const unbound = createBus({
      root: s.root, host: HOST, memoryRoot: s.memoryRoot, now: () => s.clock.value,
    });
    const cross = unbound.releaseWriter({ holder: 'session-alice' });
    assert.equal(cross.released, false);
    assert.equal(cross.reason, 'bad-nonce');
    await assert.rejects(
      async () => s.bob.releaseWriter({ holder: 'session-alice', nonce: lease.nonce }),
      (error) => error.code === 'E_FROM_MISMATCH',
    );
    assert.equal(s.alice.releaseWriter().reason, 'bad-nonce');
    assert.equal(s.alice.releaseWriter({ nonce: 'f'.repeat(32) }).reason, 'bad-nonce');
    assert.equal(
      s.alice.releaseWriter({ nonce: lease.nonce, token: lease.token + 1 }).reason,
      'stale-token',
    );
    assert.equal(s.alice.writerStatus().held, true);
    const released = s.alice.releaseWriter({ nonce: lease.nonce, token: lease.token });
    assert.equal(released.released, true);
    assert.equal(s.alice.writerStatus().held, false);
  } finally {
    s.cleanup();
  }
});

// 26. Fencing: an expired holder cannot overwrite the new holder's value.
await test('t8d stale holder fencedWrite fails (lost update prevented)', async () => {
  const s = setup('t8d');
  try {
    s.clock.value = 1_700_000_000_000;
    const file = path.join(s.root, 'handover.json');
    fs.writeFileSync(file, JSON.stringify({ writer: 'seed' }));
    const alice = s.alice.claimWriter({ ttlMs: 1000 });
    assert.equal(alice.ok, true);
    assert.equal(s.alice.fencedWrite({
      file, token: alice.token, nonce: alice.nonce, value: { writer: 'alice' },
    }).ok, true);
    s.clock.value += 5000;
    const bob = s.bob.claimWriter({ ttlMs: 60_000 });
    assert.equal(bob.ok, true);
    assert.ok(bob.token > alice.token);
    await assert.rejects(
      async () => s.alice.fencedWrite({
        file, token: alice.token, nonce: alice.nonce, value: { writer: 'alice-stale' },
      }),
      (error) => error.code === 'E_LEASE_LOST',
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { writer: 'alice' });
    assert.equal(s.bob.fencedWrite({
      file, token: bob.token, nonce: bob.nonce, value: { writer: 'bob' },
    }).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { writer: 'bob' });
    assert.equal(s.alice.releaseWriter({ nonce: alice.nonce, token: alice.token }).reason, 'not-holder');
    assert.equal(s.alice.renewWriter({ nonce: alice.nonce, token: alice.token }).reason, 'not-holder');
  } finally {
    s.cleanup();
  }
});

// 27. Tokens are strictly monotonic across acquisitions (fencing invariant).
await test('t8e fencing tokens increase across stale takeovers', async () => {
  const s = setup('t8e');
  try {
    s.clock.value = 1_700_000_000_000;
    const a = s.alice.claimWriter({ ttlMs: 1000 });
    s.clock.value += 5000;
    const b = s.bob.claimWriter({ ttlMs: 1000 });
    s.clock.value += 5000;
    const c = s.alice.claimWriter({ ttlMs: 1000 });
    assert.equal(a.ok && b.ok && c.ok, true);
    assert.ok(b.token > a.token);
    assert.ok(c.token > b.token);
    assert.notEqual(a.nonce, c.nonce);
  } finally {
    s.cleanup();
  }
});

// 28. The writer TTL is one number in ms across code and both docs.
await test('t9 busWriterTtlMs is 1800000 ms in code, DESIGN and WIRING', async () => {
  assert.equal(DEFAULT_WRITER_TTL_MS, 1_800_000);
  const design = fs.readFileSync(path.join(REPO, 'docs', 'PRESENCE-BUS.md'), 'utf8');
  const wiring = fs.readFileSync(path.join(REPO, 'docs', 'PRESENCE-BUS-WIRING.md'), 'utf8');
  assert.match(design, /`busWriterTtlMs`[^\n]*1800000/);
  assert.match(wiring, /`busWriterTtlMs`[^\n]*1800000/);
  assert.match(design, /1800000 ms/);
  assert.match(wiring, /1800000 ms/);
  assert.doesNotMatch(design, /`busWriterTtlMs`[^\n]*120000/);
  assert.doesNotMatch(wiring, /`busWriterTtlMs`[^\n]*120000/);
});

// 29. The wake API claim: DESIGN/WIRING must say the host API exists and that
//     v0's mailbox-only choice is a tradeoff, not a physical limit.
await test('t7 wake API documented: live followup, cold resume, mailbox is a choice', async () => {
  const design = fs.readFileSync(path.join(REPO, 'docs', 'PRESENCE-BUS.md'), 'utf8');
  const wiring = fs.readFileSync(path.join(REPO, 'docs', 'PRESENCE-BUS-WIRING.md'), 'utf8');
  assert.match(design, /ctx\.agents\.get\(id\)\?\.followup\(msg\)/);
  assert.match(design, /api-session-controller/);
  assert.match(design, /取舍/);
  assert.doesNotMatch(design, /没有验证过的宿主 API/);
  assert.match(wiring, /### 5\.4/);
  assert.match(wiring, /followup\(msg\)/);
  assert.match(wiring, /cold/);
});

// ---------------------------------------------------------------------------
// Red-team round 2 regression tests (P08 / P12 / P13 / P14 and the mutation
// blind spots M13 / M14).
// ---------------------------------------------------------------------------

function expectCode(fn, code) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected ${code}, but nothing was thrown`);
  assert.equal(thrown.code, code, `expected ${code}, got ${thrown.code}: ${thrown.message}`);
}

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

// 30. fencedWrite must check the fencing token. Deleting the token comparison
//     (mutation M13) has to turn this test red.
await test('t10a fencedWrite rejects a missing or stale token without writing', async () => {
  const s = setup('t10a');
  try {
    const lease = s.alice.claimWriter({ ttlMs: 60_000 });
    assert.equal(lease.ok, true);
    fs.mkdirSync(path.join(s.root, 'fenced'), { recursive: true });
    expectCode(
      () => s.alice.fencedWrite({
        file: 'fenced/stale.json', token: lease.token + 1, nonce: lease.nonce, value: { v: 1 },
      }),
      'E_LEASE_LOST',
    );
    expectCode(
      () => s.alice.fencedWrite({ file: 'fenced/missing-token.json', nonce: lease.nonce, value: { v: 1 } }),
      'E_LEASE_LOST',
    );
    assert.equal(fs.existsSync(path.join(s.root, 'fenced', 'stale.json')), false);
    assert.equal(fs.existsSync(path.join(s.root, 'fenced', 'missing-token.json')), false);
    const ok = s.alice.fencedWrite({
      file: 'fenced/ok.json', token: lease.token, nonce: lease.nonce, value: { v: 2 },
    });
    assert.equal(ok.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, 'fenced', 'ok.json'), 'utf8')).v, 2);
  } finally {
    s.cleanup();
  }
});

// 31. fencedWrite must check the acquisition nonce. Deleting the nonce
//     comparison (mutation M14) has to turn this test red.
await test('t10b fencedWrite rejects a wrong or missing nonce without writing', async () => {
  const s = setup('t10b');
  try {
    const lease = s.alice.claimWriter({ ttlMs: 60_000 });
    fs.mkdirSync(path.join(s.root, 'fenced'), { recursive: true });
    expectCode(
      () => s.alice.fencedWrite({
        file: 'fenced/wrong-nonce.json', token: lease.token, nonce: '0'.repeat(32), value: { v: 1 },
      }),
      'E_LEASE_AUTH',
    );
    expectCode(
      () => s.alice.fencedWrite({ file: 'fenced/no-nonce.json', token: lease.token, value: { v: 1 } }),
      'E_LEASE_AUTH',
    );
    assert.equal(fs.existsSync(path.join(s.root, 'fenced', 'wrong-nonce.json')), false);
    assert.equal(fs.existsSync(path.join(s.root, 'fenced', 'no-nonce.json')), false);
    const ok = s.alice.fencedWrite({
      file: 'fenced/ok.json', token: lease.token, nonce: lease.nonce, value: { v: 3 },
    });
    assert.equal(ok.ok, true);
  } finally {
    s.cleanup();
  }
});

// 32. P08: same-holder re-claim without the acquisition nonce is rejected and
//     leaves the lock byte-identical (no silent renewal, no nonce leak).
await test('t10c same-holder re-claim without nonce is E_NONCE_REQUIRED and changes nothing', async () => {
  const s = setup('t10c');
  try {
    s.clock.value = 1_700_000_000_000;
    const first = s.alice.claimWriter({ ttlMs: 60_000 });
    assert.equal(first.ok, true);
    const lockPath = path.join(s.root, 'writer.lock');
    const before = fs.readFileSync(lockPath, 'utf8');
    s.clock.value += 30_000;
    const missing = s.alice.claimWriter({ ttlMs: 600_000 });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'auth');
    assert.equal(missing.code, 'E_NONCE_REQUIRED');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
    const wrong = s.alice.claimWriter({ ttlMs: 600_000, nonce: 'f'.repeat(32) });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'E_LEASE_AUTH');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
    // A different holder is a plain "held", not an authentication error.
    const other = s.bob.claimWriter({ ttlMs: 600_000 });
    assert.equal(other.ok, false);
    assert.equal(other.reason, 'held');
  } finally {
    s.cleanup();
  }
});

// 33. P13: a takeover that lands between JSON.stringify and rename must abort
//     the write with E_LEASE_LOST and leave the previous file intact.
await test('t10d fencedWrite re-checks the lease after serialization (TOCTOU)', async () => {
  const s = setup('t10d');
  try {
    s.clock.value = 1_700_000_000_000;
    const lease = s.alice.claimWriter({ ttlMs: 5_000 });
    assert.equal(lease.ok, true);
    fs.mkdirSync(path.join(s.root, 'race'), { recursive: true });
    const target = path.join(s.root, 'race', 'target.json');
    const first = s.alice.fencedWrite({
      file: 'race/target.json', token: lease.token, nonce: lease.nonce, value: { writer: 'alice' },
    });
    assert.equal(first.ok, true);

    let takeover = null;
    const hooked = s.make('session-alice', {
      hooks: {
        afterSerialize: () => {
          // The old holder is still inside JSON.stringify/rename when the new
          // holder takes over. Deterministic: no timers, no sleeps.
          s.clock.value += 10_000;
          takeover = s.bob.claimWriter({ ttlMs: 60_000 });
        },
      },
    });
    expectCode(
      () => hooked.fencedWrite({
        file: 'race/target.json', token: lease.token, nonce: lease.nonce, value: { writer: 'alice-late' },
      }),
      'E_LEASE_LOST',
    );
    assert.equal(takeover.ok, true);
    assert.ok(takeover.token > lease.token);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).writer, 'alice');
    const bobWrite = s.bob.fencedWrite({
      file: 'race/target.json', token: takeover.token, nonce: takeover.nonce, value: { writer: 'bob' },
    });
    assert.equal(bobWrite.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).writer, 'bob');
  } finally {
    s.cleanup();
  }
});

// 34. Writers serialize through a cross-process commit lock; the lock file is
//     visible inside the critical section and removed afterwards.
await test('t10e commit lock serializes the lease path and reclaims stale locks', async () => {
  const s = setup('t10e');
  try {
    const lockPath = path.join(s.root, 'writer.commit.lock');
    let seen = null;
    const hooked = s.make('session-alice', {
      hooks: {
        afterSerialize: () => {
          const exists = fs.existsSync(lockPath);
          seen = { exists, body: exists ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null };
        },
      },
    });
    const lease = hooked.claimWriter({ ttlMs: 60_000 });
    assert.equal(lease.ok, true);
    fs.mkdirSync(path.join(s.root, 'lock'), { recursive: true });
    hooked.fencedWrite({
      file: 'lock/probe.json', token: lease.token, nonce: lease.nonce, value: { ok: true },
    });
    assert.equal(seen.exists, true);
    assert.equal(seen.body.pid, process.pid);
    assert.equal(String(seen.body.host).toLowerCase(), HOST);
    assert.equal(fs.existsSync(lockPath), false);

    const released = hooked.releaseWriter({ nonce: lease.nonce, token: lease.token });
    assert.equal(released.ok, true);
    // A commit lock left behind by a dead pid must not wedge the bus.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: HOST, at: new Date().toISOString() }));
    const claimed = s.bob.claimWriter({ ttlMs: 60_000 });
    assert.equal(claimed.ok, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    s.cleanup();
  }
});

// 35. P12: a junction inside the root that points outside must be refused by
//     the real-path check, with no file landing outside the jail.
await test('t10f fencedWrite refuses a junction that escapes the root', async () => {
  const s = setup('t10f');
  const outside = fs.mkdtempSync(path.join(TMP_BASE, 'junction-outside-'));
  const link = path.join(s.root, 'escape');
  try {
    const lease = s.alice.claimWriter({ ttlMs: 60_000 });
    fs.symlinkSync(outside, link, 'junction');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    expectCode(
      () => s.alice.fencedWrite({
        file: 'escape/pwn.json', token: lease.token, nonce: lease.nonce, value: { escaped: true },
      }),
      'E_PATH_OUTSIDE_ROOT',
    );
    assert.equal(fs.existsSync(path.join(outside, 'pwn.json')), false);
  } finally {
    try { fs.unlinkSync(link); } catch { /* already gone */ }
    fs.rmSync(outside, { recursive: true, force: true });
    s.cleanup();
  }
});

// 36. P12 continued: resolve the nearest existing ancestor for paths that do
//     not exist yet, and refuse symlinked file targets too.
await test('t10g jail resolves the nearest existing ancestor and rejects file symlinks', async () => {
  const s = setup('t10g');
  const outside = fs.mkdtempSync(path.join(TMP_BASE, 'ancestor-outside-'));
  const link = path.join(s.root, 'escape-j');
  try {
    const lease = s.alice.claimWriter({ ttlMs: 60_000 });
    fs.symlinkSync(outside, link, 'junction');
    expectCode(
      () => s.alice.fencedWrite({
        file: 'escape-j/missing/deep/pwn.json', token: lease.token, nonce: lease.nonce, value: { escaped: true },
      }),
      'E_PATH_OUTSIDE_ROOT',
    );
    assert.equal(fs.existsSync(path.join(outside, 'missing')), false);

    // A legal path with missing intermediate directories passes the jail and
    // fails at the filesystem write (E_WRITE), never as a path escape.
    expectCode(
      () => s.alice.fencedWrite({
        file: 'nested/a/b.json', token: lease.token, nonce: lease.nonce, value: { ok: true },
      }),
      'E_WRITE',
    );
    fs.mkdirSync(path.join(s.root, 'nested', 'a'), { recursive: true });
    const written = s.alice.fencedWrite({
      file: 'nested/a/b.json', token: lease.token, nonce: lease.nonce, value: { ok: true },
    });
    assert.equal(written.ok, true);

    const secret = path.join(outside, 'secret.json');
    fs.writeFileSync(secret, '{"outside":true}');
    const fileLink = path.join(s.root, 'file-link.json');
    fs.symlinkSync(secret, fileLink, 'file');
    expectCode(
      () => s.alice.fencedWrite({
        file: 'file-link.json', token: lease.token, nonce: lease.nonce, value: { overwritten: true },
      }),
      'E_PATH_OUTSIDE_ROOT',
    );
    assert.equal(fs.readFileSync(secret, 'utf8'), '{"outside":true}');
  } finally {
    try { fs.unlinkSync(link); } catch { /* already gone */ }
    try { fs.unlinkSync(path.join(s.root, 'file-link.json')); } catch { /* already gone */ }
    fs.rmSync(outside, { recursive: true, force: true });
    s.cleanup();
  }
});

// 37. P14 send side: a clock far in the future is refused before any file is
//     written; a small skew inside maxClockSkewMs is still accepted.
await test('t10h send rejects a timestamp ahead of the wall clock', async () => {
  const s = setup('t10h');
  try {
    const wall = Date.now();
    s.clock.value = wall + 3_600_000;
    expectCode(
      () => s.alice.send({ to: 'session-bob', body: 'time traveller', kind: 'note' }),
      'E_BAD_CLOCK',
    );
    const inbox = path.join(s.root, 'inbox', 'session-bob');
    assert.equal(
      fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((name) => name.endsWith('.json')).length : 0,
      0,
    );
    s.clock.value = wall + 4 * 60_000;
    const accepted = s.alice.send({ to: 'session-bob', body: 'slightly ahead', kind: 'note' });
    assert.equal(accepted.ok, true);
    // maxClockSkewMs=0 makes even a one-second lead a hard error.
    const strict = s.make('session-alice', { maxClockSkewMs: 0 });
    s.clock.value = Date.now() + 1_000;
    expectCode(
      () => strict.send({ to: 'session-bob', body: 'strict clock', kind: 'note' }),
      'E_BAD_CLOCK',
    );
  } finally {
    s.cleanup();
  }
});

// 38. P14 receive side: a future-dated message is quarantined instead of
//     becoming the cursor; a poisoned `since` cannot hide pending traffic.
await test('t10i poll quarantines future messages and never poisons the cursor', async () => {
  const s = setup('t10i');
  try {
    s.clock.value = 1_700_000_000_000;
    const normal = s.alice.send({ to: 'session-bob', body: 'normal', kind: 'note' });
    const inbox = path.join(s.root, 'inbox', 'session-bob');
    const futureTs = s.clock.value + 3_600_000;
    const time = Math.floor(futureTs).toString(36).padStart(9, '0');
    const futureId = `m-${time}-aa-future-abcdef`;
    fs.writeFileSync(path.join(inbox, `${futureId}.json`), JSON.stringify({
      v: 1,
      id: futureId,
      from: 'session-alice',
      to: 'session-bob',
      kind: 'note',
      body: 'from the future',
      ts: futureTs,
      ttl: 86_400_000,
      host: HOST,
    }, null, 2));

    const first = s.bob.poll({ since: 0 });
    assert.equal(first.futureTs, 1);
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].id, normal.id);
    assert.equal(first.cursor, normal.id);
    assert.equal(
      fs.existsSync(path.join(inbox, 'dead', `${futureId}.future-ts.json`)),
      true,
    );

    // A future `since` (e.g. persisted by an older build) must replay pending
    // messages rather than hide them.
    const poisoned = s.bob.poll({ since: futureId });
    assert.equal(poisoned.futureCursor, true);
    assert.equal(poisoned.messages.length, 1);
    assert.equal(poisoned.messages[0].id, normal.id);

    // And normal traffic after the poison is still delivered.
    s.clock.value += 1_000;
    const later = s.alice.send({ to: 'session-bob', body: 'after', kind: 'note' });
    const next = s.bob.poll({ since: first.cursor });
    assert.equal(next.messages.length, 1);
    assert.equal(next.messages[0].id, later.id);
  } finally {
    s.cleanup();
  }
});

// 39. P13 across processes: a second writer blocks on the commit lock instead
//     of racing the rename.
await test('t11a commit lock serializes a second process claiming concurrently', async () => {
  const s = setup('t11a');
  try {
    const marker = path.join(s.memoryRoot, 'serialized.marker');
    const target = path.join(s.root, 'serialize', 'target.json');
    fs.mkdirSync(path.join(s.root, 'serialize'), { recursive: true });
    const child = runNode(`
import fs from 'node:fs';
const { createBus } = await import(process.env.BUS_URL);
const bus = createBus({
  root: process.env.BUS_ROOT,
  sessionId: 'session-alice',
  host: 'testhost',
  hooks: {
    afterSerialize: () => {
      fs.writeFileSync(process.env.BUS_MARKER, 'serialized');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    },
  },
});
const lease = bus.claimWriter({ ttlMs: 30_000 });
if (!lease.ok) throw new Error('child claim failed');
bus.fencedWrite({
  file: 'serialize/target.json',
  token: lease.token,
  nonce: lease.nonce,
  value: { writer: 'alice' },
});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
`, { BUS_URL, BUS_ROOT: s.root, BUS_MARKER: marker });

    await waitForFile(marker);
    const startedAt = Date.now();
    const held = s.bob.claimWriter({ ttlMs: 30_000 });
    const waited = Date.now() - startedAt;
    assert.equal(held.ok, false);
    assert.equal(held.reason, 'held');
    assert.ok(waited >= 800, `claimWriter should wait behind the commit lock (waited ${waited}ms)`);

    await child;
    const takeover = s.bob.claimWriter({ ttlMs: 30_000 });
    assert.equal(takeover.ok, true);
    const finalWrite = s.bob.fencedWrite({
      file: 'serialize/target.json', token: takeover.token, nonce: takeover.nonce, value: { writer: 'bob' },
    });
    assert.equal(finalWrite.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).writer, 'bob');
  } finally {
    s.cleanup();
  }
});

// 40. WIRING must merge pendingAckIds on retry (not overwrite them) and must
//     use the same sessionKeyFor(agent) key as the card builder.
await test('t12a WIRING retries pendingAckIds by merge and uses sessionKeyFor(agent)', async () => {
  assert.equal(typeof mergePendingAckIds, 'function');
  assert.deepEqual(mergePendingAckIds(['m-a'], ['m-b', 'm-a']), ['m-a', 'm-b']);
  assert.deepEqual(mergePendingAckIds(undefined, ['m-a']), ['m-a']);
  assert.deepEqual(mergePendingAckIds(['m-a'], [null, '', 7, 'm-a']), ['m-a']);
  const wiring = fs.readFileSync(path.join(REPO, 'docs', 'PRESENCE-BUS-WIRING.md'), 'utf8');
  assert.match(wiring, /mergePendingAckIds/);
  assert.match(wiring, /pendingAckIds/);
  assert.match(wiring, /stateFor\(sessionKeyFor\(agent\)\)/);
  assert.doesNotMatch(wiring, /stateFor\(session\?\.id \?\? 'unknown'\)/);
});

// 41. DESIGN documents the new invariants the tests above enforce.
await test('t12b DESIGN documents commit lock, realpath jail, nonce and clock skew', async () => {
  const design = fs.readFileSync(path.join(REPO, 'docs', 'PRESENCE-BUS.md'), 'utf8');
  assert.match(design, /writer\.commit\.lock/);
  assert.match(design, /E_NONCE_REQUIRED/);
  assert.match(design, /maxClockSkewMs/);
  assert.match(design, /future-ts/);
  assert.match(design, /realpath/);
  assert.match(design, /E_PATH_OUTSIDE_ROOT/);
});

// ---------------------------------------------------------------------------
// Red-team round 3 regression tests (F1 owner-checked lock release, F2 root /
// directory targets, F3 skew-cursor message loss).
// ---------------------------------------------------------------------------

// 42. F1: releasing the commit lock must be owner-checked. A holder that lost
//     the lock to a stale reclaim must leave the new owner's record alone.
await test('t13a commit lock release checks the owner before unlinking', async () => {
  const s = setup('t13a');
  try {
    const lockPath = path.join(s.root, 'writer.commit.lock');
    const owners = [];
    const hooked = s.make('session-alice', {
      hooks: {
        afterSerialize: () => {
          const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          owners.push(record.ownerId);
          if (owners.length === 1) {
            // Simulate a reclaim: another acquisition unlinked our record and
            // installed its own ownerId while we were still inside.
            fs.writeFileSync(lockPath, JSON.stringify({
              pid: process.pid,
              host: HOST,
              at: new Date().toISOString(),
              ownerId: 'foreign-owner',
            }));
          }
        },
      },
    });
    const lease = hooked.claimWriter({ ttlMs: 60_000 });
    assert.equal(lease.ok, true);
    fs.mkdirSync(path.join(s.root, 'fenced'), { recursive: true });

    const first = hooked.fencedWrite({
      file: 'fenced/owner.json', token: lease.token, nonce: lease.nonce, value: { v: 1 },
    });
    assert.equal(first.ok, true);
    assert.equal(typeof owners[0], 'string');
    assert.ok(owners[0].length >= 32, 'the lock record must carry a random ownerId');
    assert.equal(fs.existsSync(lockPath), true, 'finally unlinked a lock owned by another acquisition');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).ownerId, 'foreign-owner');

    // Clear the foreign record as the normal stale path would, then verify that
    // an owner-matched release still removes its own lock.
    fs.unlinkSync(lockPath);
    const second = hooked.fencedWrite({
      file: 'fenced/owner.json', token: lease.token, nonce: lease.nonce, value: { v: 2 },
    });
    assert.equal(second.ok, true);
    assert.notEqual(owners[0], owners[1], 'each acquisition must get a fresh ownerId');
    assert.equal(fs.existsSync(lockPath), false, 'an owner must still remove its own lock');
  } finally {
    s.cleanup();
  }
});

// 43. F1 across processes (P09): B's lock record looks stale (dead pid), C
//     legitimately reclaims and holds the lock; when B exits it must not delete
//     C's lock. D watches the lock file while C is inside its critical section.
await test('t13b three processes: a stale-steal victim must not delete the new lock', async () => {
  const s = setup('t13b');
  try {
    const lockPath = path.join(s.root, 'writer.commit.lock');
    const markerB = path.join(s.memoryRoot, 'b.marker');
    const markerC = path.join(s.memoryRoot, 'c.marker');
    const outB = path.join(s.memoryRoot, 'b.out.json');
    const outD = path.join(s.memoryRoot, 'd.out.json');
    fs.mkdirSync(path.join(s.root, 'owner'), { recursive: true });

    const bCode = `
import fs from 'node:fs';
const { createBus } = await import(process.env.BUS_URL);
const waitFor = (file, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return false;
};
const bus = createBus({
  root: process.env.BUS_ROOT,
  sessionId: 'session-alice',
  host: 'testhost',
  hooks: {
    afterSerialize: () => {
      // Make our own record look stale (dead pid), so C reclaims it legally.
      fs.writeFileSync(process.env.LOCK_PATH, JSON.stringify({
        pid: 999999, host: 'testhost', at: new Date().toISOString(),
      }));
      fs.writeFileSync(process.env.MARKER_B, 'b');
      if (!waitFor(process.env.MARKER_C, 15000)) throw new Error('B never saw C holding the lock');
    },
  },
});
const lease = bus.claimWriter({ ttlMs: 60000 });
let code = 'none';
try {
  bus.fencedWrite({ file: 'owner/target.json', token: lease.token, nonce: lease.nonce, value: { writer: 'alice' } });
} catch (error) {
  code = error.code || String(error.message);
}
fs.writeFileSync(process.env.OUT_B, JSON.stringify({ claimed: lease.ok, code }));
`;
    const dCode = `
import fs from 'node:fs';
const waitFor = (file, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return false;
};
const saw = waitFor(process.env.MARKER_C, 15000);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
nap(250);
const early = fs.existsSync(process.env.LOCK_PATH);
nap(250);
const late = fs.existsSync(process.env.LOCK_PATH);
fs.writeFileSync(process.env.OUT_D, JSON.stringify({ saw, early, late }));
`;

    s.clock.value = Date.now();
    const bChild = runNode(bCode, {
      BUS_URL, BUS_ROOT: s.root, LOCK_PATH: lockPath, MARKER_B: markerB, MARKER_C: markerC, OUT_B: outB,
    });
    await waitForFile(markerB);

    // Parent is C: its clock is 31 minutes ahead, so alice's 60s lease has
    // expired and B's lock record (dead pid) is stale. C takes both.
    s.clock.value = Date.now() + 31 * 60_000;
    const bobLease = s.bob.claimWriter({ ttlMs: 120_000 });
    assert.equal(bobLease.ok, true);

    const dChild = runNode(dCode, { MARKER_C: markerC, LOCK_PATH: lockPath, OUT_D: outD });
    const hookedBob = s.make('session-bob', {
      hooks: {
        afterSerialize: () => {
          fs.writeFileSync(markerC, 'c');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        },
      },
    });
    const write = hookedBob.fencedWrite({
      file: 'owner/target.json', token: bobLease.token, nonce: bobLease.nonce, value: { writer: 'bob' },
    });
    assert.equal(write.ok, true);

    await bChild;
    await dChild;
    const bResult = JSON.parse(fs.readFileSync(outB, 'utf8'));
    assert.equal(bResult.claimed, true);
    assert.equal(bResult.code, 'E_LEASE_LOST');
    const dResult = JSON.parse(fs.readFileSync(outD, 'utf8'));
    assert.equal(dResult.saw, true);
    assert.equal(dResult.early, true, 'C lock disappeared while C was still inside the critical section');
    assert.equal(dResult.late, true, 'C lock disappeared while C was still inside the critical section');
    assert.equal(fs.existsSync(lockPath), false, 'C must release its own lock when it exits');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(s.root, 'owner', 'target.json'), 'utf8')).writer,
      'bob',
    );
  } finally {
    s.cleanup();
  }
});

// 44. F2 (P17): `file: "."` resolves to the root itself, which the lexical and
//     realpath jails both accept, but dirname(root) is outside the jail. Reject
//     the root before any temp file can be created next to it.
await test('t13c fencedWrite refuses the bus root as a target', async () => {
  const s = setup('t13c');
  try {
    const lease = s.alice.claimWriter({ ttlMs: 60_000 });
    assert.equal(lease.ok, true);
    const parent = path.dirname(s.root);
    const before = fs.readdirSync(parent).sort();
    for (const file of ['.', './', s.root]) {
      expectCode(
        () => s.alice.fencedWrite({ file, token: lease.token, nonce: lease.nonce, value: { v: 1 } }),
        'E_BAD_PATH',
      );
    }
    assert.deepEqual(fs.readdirSync(parent).sort(), before, 'a temp file escaped next to the root');
    assert.equal(fs.existsSync(path.join(s.root, 'writer.commit.lock')), false);
    assert.equal(fs.lstatSync(s.root).isDirectory(), true);
    assert.equal(fs.readdirSync(s.root).includes('undefined.json'), false);
  } finally {
    s.cleanup();
  }
});

// 45. F2: an existing directory is not a file target either; refusing it must
//     not disturb normal writes, and the commit lock must still be released.
await test('t13d fencedWrite refuses a directory target', async () => {
  const s = setup('t13d');
  try {
    const lease = s.alice.claimWriter({ ttlMs: 60_000 });
    fs.mkdirSync(path.join(s.root, 'dir-target'), { recursive: true });
    for (const file of ['dir-target', 'dir-target/']) {
      expectCode(
        () => s.alice.fencedWrite({ file, token: lease.token, nonce: lease.nonce, value: { v: 1 } }),
        'E_BAD_PATH',
      );
    }
    assert.deepEqual(fs.readdirSync(path.join(s.root, 'dir-target')), []);
    const ok = s.alice.fencedWrite({
      file: 'dir-target/file.json', token: lease.token, nonce: lease.nonce, value: { v: 2 },
    });
    assert.equal(ok.ok, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(s.root, 'dir-target', 'file.json'), 'utf8')).v,
      2,
    );
    assert.equal(fs.existsSync(path.join(s.root, 'writer.commit.lock')), false);
  } finally {
    s.cleanup();
  }
});

// 46. F3 (P24): a message 299s ahead of the receiver's clock is inside the 5
//     minute window, so it is delivered. It must not become the cursor: a later
//     message with a smaller ts has to stay visible.
await test('t13e poll clamps the cursor for ahead-of-clock messages', async () => {
  const s = setup('t13e');
  try {
    const W = 1_700_000_000_000;
    s.clock.value = W + 299_000;
    const ahead = s.alice.send({ to: 'session-bob', body: 'ahead', kind: 'note' });
    s.clock.value = W;
    const first = s.bob.poll({ since: 0 });
    assert.equal(first.futureCursor, false);
    assert.equal(first.futureTs, 0);
    assert.deepEqual(first.messages.map((m) => m.id), [ahead.id]);
    assert.equal(first.cursor, W, 'the cursor must be clamped to now, not the ahead-of-clock id');

    s.clock.value = W + 1_000;
    const normal = s.alice.send({ to: 'session-bob', body: 'normal', kind: 'note' });
    const second = s.bob.poll({ since: first.cursor });
    const ids = second.messages.map((m) => m.id);
    assert.ok(ids.includes(normal.id), 'a later message with a smaller ts was silently hidden');
    assert.ok(ids.includes(ahead.id), 'the ahead-of-clock message must be replayed at least once');
    assert.equal(second.cursor, W + 1_000);

    s.bob.ack(ahead.id);
    s.bob.ack(normal.id);
    const drained = s.bob.poll({ since: second.cursor });
    assert.deepEqual(drained.messages, []);
  } finally {
    s.cleanup();
  }
});

// 47. F3 the other way: on-time traffic keeps id cursors (no over-clamping), and
//     a message exactly at the 300000ms boundary is still delivered and clamped.
await test('t13f poll keeps id cursors for on-time traffic', async () => {
  const s = setup('t13f');
  try {
    const W = 1_700_000_000_000;
    s.clock.value = W;
    const m1 = s.alice.send({ to: 'session-bob', body: 'one', kind: 'note' });
    const first = s.bob.poll({ since: 0 });
    assert.deepEqual(first.messages.map((m) => m.id), [m1.id]);
    assert.equal(first.cursor, m1.id, 'on-time traffic must keep the id cursor');

    s.clock.value = W + 2_000;
    const m2 = s.alice.send({ to: 'session-bob', body: 'two', kind: 'note' });
    const second = s.bob.poll({ since: first.cursor });
    assert.deepEqual(second.messages.map((m) => m.id), [m2.id]);
    assert.equal(second.cursor, m2.id);

    s.clock.value = W + 300_000;
    const edge = s.alice.send({ to: 'session-bob', body: 'edge', kind: 'note' });
    s.clock.value = W;
    const third = s.bob.poll({ since: m2.id });
    assert.equal(third.futureTs, 0, 'exactly 300000ms ahead is inside the window');
    assert.deepEqual(third.messages.map((m) => m.id), [edge.id]);
    assert.equal(third.cursor, W);
  } finally {
    s.cleanup();
  }
});

// 48. F1/F2/F3 must be documented where the wire-up reads them.
await test('t13g DESIGN/WIRING document owner, cursor and skew-window semantics', async () => {
  const design = fs.readFileSync(path.join(REPO, 'docs', 'PRESENCE-BUS.md'), 'utf8');
  const wiring = fs.readFileSync(path.join(REPO, 'docs', 'PRESENCE-BUS-WIRING.md'), 'utf8');
  assert.match(design, /ownerId/);
  assert.match(design, /锁只能由持有者释放/);
  assert.match(design, /at-least-once/);
  assert.match(design, /E_BAD_PATH/);
  assert.match(design, /50 例/);
  assert.match(wiring, /### 3\.5/);
  assert.match(wiring, /5 分钟/);
  assert.match(wiring, /at-least-once/);
  assert.match(wiring, /cursor/);
});

// 49. m3: an unwritable bus root is a permission error, not a malformed path.
await test('t14 ensureRoot reports EPERM for a read-only bus root', async () => {
  const parent = path.join(TMP_BASE, 'bus-t14');
  const root = path.join(parent, 'denied-root');
  fs.mkdirSync(parent, { recursive: true });
  const original = fs.mkdirSync;
  fs.mkdirSync = function patchedMkdir(target, options) {
    if (String(target).toLowerCase().endsWith('denied-root')) {
      const error = new Error("EPERM: operation not permitted, mkdir '" + target + "'");
      error.code = 'EPERM';
      throw error;
    }
    return original.call(fs, target, options);
  };
  try {
    assert.throws(
      () => createBus({ root }),
      (error) => error.code === 'EPERM' && /not writable/.test(error.message),
    );
    assert.equal(fs.existsSync(root), false, 'a failed root must not leave a directory behind');
  } finally {
    fs.mkdirSync = original;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// 50. m3: a root that denies a subdirectory is EPERM too, not a malformed path.
await test('t15 ensureDirInside reports EPERM when the root denies inbox creation', async () => {
  const parent = path.join(TMP_BASE, 'bus-t15');
  const root = path.join(parent, 'root');
  fs.mkdirSync(root, { recursive: true });
  const bus = createBus({ root, sessionId: 'session-alice' });
  const original = fs.mkdirSync;
  fs.mkdirSync = function patchedMkdir(target, options) {
    if (String(target).replaceAll('\\', '/').includes('/inbox/')) {
      const error = new Error("EPERM: operation not permitted, mkdir '" + target + "'");
      error.code = 'EPERM';
      throw error;
    }
    return original.call(fs, target, options);
  };
  try {
    assert.throws(
      () => bus.send({ to: 'session-bob', body: 'x' }),
      (error) => error.code === 'EPERM' && /cannot create/.test(error.message),
    );
  } finally {
    fs.mkdirSync = original;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;
console.log(`# tests ${results.length}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) {
  for (const item of results.filter((entry) => !entry.ok)) {
    console.log(`FAILED: ${item.name}: ${item.error?.message ?? item.error}`);
  }
  process.exitCode = 1;
}
