// WP4a — WAL rotation / folding / pruning (DESIGN §3.5, §3.7, §5.4).
//
// These tests drive the WAL directly on the same on-disk layout the service
// uses, plus one end-to-end crash-recovery case through the proposal engine and
// queue rebuild. They assert real state transitions: segment names, chain
// hashes across boundaries, snapshot contents, prune policy and ticket survival.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeRouterConfig } from '../../src/router/service/config.mjs';
import { createProposalEngine } from '../../src/router/service/proposals.mjs';
import { createQueueManager } from '../../src/router/service/queue.mjs';
import { createWal, walLineHash } from '../../src/router/service/wal.mjs';
import { readQueueFile } from '../../src/router/service/store.mjs';
import { readJson, tempRoot, writeMemory } from './helpers.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function walDir(prefix) {
  return path.join(tempRoot(prefix), 'vault', 'proposals');
}

function makeWal(prefix, options = {}) {
  const dir = walDir(prefix);
  const audit = [];
  const wal = createWal({
    file: path.join(dir, 'wal.jsonl'),
    audit: (kind, data = {}) => audit.push({ kind, ...data }),
    ...options,
  });
  return { dir, wal, audit, file: path.join(dir, 'wal.jsonl'), snapshotFile: path.join(dir, 'wal.snapshot.json') };
}

function rawLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function setup(prefix, configExtra = {}) {
  const temp = tempRoot(prefix);
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const config = normalizeRouterConfig({ proposalEnabled: true, applyEnabled: true, ...configExtra });
  const audit = [];
  const auditFn = (kind, data = {}) => audit.push({ kind, ...data });
  const paths = { vaultDir, proposalsDir: path.join(vaultDir, 'proposals'), liveRoot: memoryRoot };
  const walFile = path.join(paths.proposalsDir, 'wal.jsonl');
  const wal = createWal({ file: walFile, audit: auditFn });
  const engine = createProposalEngine({ config, paths, memoryRoot, audit: auditFn, now: () => new Date() });
  return {
    temp,
    memoryRoot,
    vaultDir,
    config,
    paths,
    audit,
    wal,
    engine,
    walFile,
    snapshotFile: path.join(paths.proposalsDir, 'wal.snapshot.json'),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

const TARGETS = Object.freeze({
  one: 'journal/2026-11.md',
  first: 'journal/2026-11.md',
  two: 'topics/two.md',
  second: 'topics/second.md',
  three: 'journal/2026-12.md',
  four: 'topics/four.md',
});

function propose(engine, content) {
  const target = TARGETS[content] ?? `topics/${content}.md`;
  return engine.propose({
    op: target.startsWith('journal/') ? 'journal.append' : 'topic.append',
    // One target per proposal: distinct targets avoid §5.8 small-write merge,
    // which would otherwise fold two test proposals into one.
    target,
    title: `t-${content}`,
    content,
  }, { caller: { kind: 'root', sessionId: 'root-session' } });
}

test('WAL-1: the line limit rotates before writing and names segments by first seq', () => {
  const env = makeWal('wal-rot-lines-', { maxLines: 3, maxBytes: 1_000_000 });
  try {
    for (let index = 1; index <= 8; index += 1) {
      env.wal.append('queue.reconcile', { reason: `n${index}` });
    }
    const segments = env.wal.listSegments().map((segment) => segment.name);
    assert.deepEqual(segments, ['wal.1.jsonl', 'wal.4.jsonl']);
    for (const segment of env.wal.listSegments()) {
      const first = rawLines(segment.file)[0];
      assert.equal(first.seq, segment.firstSeq, `${segment.name} starts at its seq`);
    }
    // Each archived segment is at or under the line limit (rotation happens
    // before the line that would exceed it).
    for (const segment of env.wal.listSegments()) {
      assert.ok(rawLines(segment.file).length <= 3, `${segment.name} respects maxLines`);
    }
    const state = env.wal.read();
    assert.equal(state.broken, false);
    assert.equal(state.lastSeq, 8);
    assert.deepEqual(state.lines.map((line) => line.seq), [7, 8]);
    // The whole physical chain still verifies when the snapshot is removed.
    fs.rmSync(env.snapshotFile);
    const replay = env.wal.read();
    assert.equal(replay.broken, false);
    assert.deepEqual(replay.lines.map((line) => line.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const line of replay.lines) assert.equal(line.hash, walLineHash(line));
  } finally {
    fs.rmSync(path.dirname(path.dirname(env.dir)), { recursive: true, force: true });
  }
});

test('WAL-2: the byte limit rotates and the active file stays bounded', () => {
  const env = makeWal('wal-rot-bytes-', { maxLines: 100_000, maxBytes: 400 });
  try {
    const padding = 'x'.repeat(260);
    for (let index = 1; index <= 6; index += 1) {
      env.wal.append('queue.reconcile', { reason: `${index}-${padding}` });
    }
    const segments = env.wal.listSegments();
    assert.ok(segments.length >= 2, `expected multiple segments, got ${segments.length}`);
    for (const segment of segments) {
      const bytes = fs.statSync(segment.file).size;
      assert.ok(bytes <= 400 + 512, `${segment.name} stayed near maxBytes (${bytes})`);
    }
    assert.equal(env.wal.read().broken, false);
    assert.equal(env.wal.read().lastSeq, 6);
  } finally {
    fs.rmSync(path.dirname(path.dirname(env.dir)), { recursive: true, force: true });
  }
});

test('WAL-3: only the newest three archived segments are retained once older terminal lines are prunable', () => {
  const env = makeWal('wal-rot-keep-', { maxLines: 2, maxBytes: 1_000_000, keepSegments: 3 });
  try {
    const old = new Date(Date.now() - 8 * DAY_MS).toISOString();
    for (let index = 1; index <= 10; index += 1) {
      env.wal.append('apply.done', { at: old, reason: `n${index}` });
    }
    const names = env.wal.listSegments().map((segment) => segment.name);
    assert.deepEqual(names, ['wal.3.jsonl', 'wal.5.jsonl', 'wal.7.jsonl']);
    assert.equal(fs.existsSync(path.join(env.dir, 'wal.1.jsonl')), false);
    assert.equal(env.wal.read().lastSeq, 10);
    assert.equal(env.wal.read().broken, false);
  } finally {
    fs.rmSync(path.dirname(path.dirname(env.dir)), { recursive: true, force: true });
  }
});

test('WAL-4: snapshot folds non-terminal proposals, assign summaries, seqCounter and head', async () => {
  const env = setup('wal-rot-snapshot-');
  try {
    const first = await propose(env.engine, 'first');
    const second = await propose(env.engine, 'second');
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const approved = env.engine.approve({ id: first.id }, { caller: { kind: 'root', sessionId: 'root-session' } });
    assert.equal(approved.ok, true);
    const rotated = env.engine.wal.rotate({ force: true });
    assert.equal(rotated.rotated, true);
    assert.equal(rotated.snapshotError, null);

    // Read-back: the file on disk parses to the same snapshot the WAL returned.
    const snapshot = readJson(env.snapshotFile);
    assert.equal(snapshot.v, 1);
    assert.deepEqual(rotated.snapshot, snapshot);
    assert.equal(snapshot.upToSeq, 3); // 2 assigns + 1 approve
    assert.equal(snapshot.lastSeq, 3);
    assert.match(snapshot.lastHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(snapshot.proposals.length, 2);
    assert.deepEqual(snapshot.proposals.map((proposal) => proposal.id).sort(), [first.id, second.id].sort());
    assert.ok(snapshot.proposals.every((proposal) => proposal.status === 'pending' || proposal.status === 'approved'));
    assert.deepEqual(
      snapshot.assignments.map((assignment) => [assignment.proposalId, assignment.ticket]).sort(),
      [[first.id, first.ticketName], [second.id, second.ticketName]].sort(),
    );
    assert.equal(snapshot.seqCounter, 3);
    const queue = readQueueFile(path.join(env.paths.proposalsDir, 'queue.json'));
    assert.deepEqual(snapshot.head, { ticket: queue.entries[0].ticket, proposalId: queue.entries[0].proposalId });

    // Replay after folding: no suffix lines remain, and the boundary hash matches.
    const state = env.engine.wal.read();
    assert.equal(state.broken, false);
    assert.equal(state.lines.length, 0);
    assert.equal(state.lastSeq, 3);
    assert.equal(state.boundaryLineSeen, true);
    // Atomic write leaves no tmp file behind.
    assert.equal(fs.readdirSync(env.paths.proposalsDir).filter((name) => name.includes('.tmp')).length, 0);
  } finally {
    env.cleanup();
  }
});

test('WAL-5: an assignment folded into the snapshot survives queue rebuild and wins over proposal drift', async () => {
  const env = setup('wal-rot-survive-');
  try {
    const first = await propose(env.engine, 'first');
    const second = await propose(env.engine, 'second');
    assert.equal(env.engine.wal.rotate({ force: true }).rotated, true);

    // Crash/restart shape: no active WAL, no queue.json, only snapshot+segment.
    fs.rmSync(env.walFile, { force: true });
    fs.rmSync(path.join(env.paths.proposalsDir, 'queue.json'), { force: true });
    const restartedWal = createWal({ file: env.walFile, audit: () => {} });
    const queue = createQueueManager({
      paths: env.paths,
      config: env.config,
      wal: restartedWal,
      audit: (kind, data = {}) => env.audit.push({ kind, ...data }),
      now: () => new Date(),
    });
    const rebuilt = queue.rebuild();
    assert.equal(rebuilt.recovered.length, 0);
    assert.equal(rebuilt.reconciled.length, 0);
    assert.equal(rebuilt.seqCounter, 3);
    assert.deepEqual(readQueueFile(path.join(env.paths.proposalsDir, 'queue.json')).entries.map((entry) => entry.ticket).sort(), [first.ticketName, second.ticketName].sort());

    // Propose-side drift: WAL wins, ticket restored, no new recovered assign.
    const proposalFile = path.join(env.paths.proposalsDir, `${first.id}.json`);
    const drifted = readJson(proposalFile);
    drifted.queue.ticket = 'q-0009';
    drifted.queue.seq = 9;
    fs.writeFileSync(proposalFile, `${JSON.stringify(drifted)}\n`);
    const repaired = queue.rebuild();
    assert.equal(repaired.recovered.length, 0);
    assert.equal(repaired.reconciled.length, 1);
    assert.equal(readJson(proposalFile).queue.ticket, first.ticketName);
    assert.ok(env.audit.some((row) => row.kind === 'wal.reconcile'));
    assert.equal(restartedWal.read().lines.filter((line) => line.ev === 'queue.assign.recovered').length, 0);
    assert.equal(second.ticketName, 'q-0002');
  } finally {
    env.cleanup();
  }
});

test('WAL-6: seven-day terminal events are pruned, incident records are not', () => {
  const env = makeWal('wal-rot-prune-', { maxLines: 1000, keepSegments: 0 });
  try {
    const old = new Date(Date.now() - 8 * DAY_MS).toISOString();
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const doneId = 'p-20261105T000000-aaaaaa';
    fs.mkdirSync(env.dir, { recursive: true });
    fs.writeFileSync(path.join(env.dir, `${doneId}.json`), JSON.stringify({
      v: 1,
      id: doneId,
      status: 'done',
      queue: { ticket: 'q-0001' },
    }));
    env.wal.append('queue.assign', { ticket: 'q-0001', proposalId: doneId, at: old });
    env.wal.append('apply.done', { proposalId: doneId, at: old }); // terminal via proposal status
    env.wal.append('lease.expired', { at: old });
    env.wal.append('apply.conflict', { at: old });
    env.wal.append('rollback.done', { at: old });
    env.wal.append('queue.cancel', { at: old, proposalId: doneId });
    env.wal.append('lease.release', { at: old });
    env.wal.append('queue.reconcile', { at: old });
    env.wal.append('apply.done', { at: recent, proposalId: 'other' });
    env.wal.rotate({ force: true });
    const segment = env.wal.listSegments()[0];
    const kept = rawLines(segment.file).map((line) => line.ev);
    assert.deepEqual(kept, ['lease.expired', 'apply.conflict', 'rollback.done', 'queue.reconcile', 'apply.done']);
    assert.equal(env.audit.filter((row) => row.kind === 'wal.pruned_event').length, 4);
    assert.ok(env.audit.every((row) => row.kind !== 'wal.prune_failed'));
    // Folded gaps are not a chain break: replay starts from the snapshot.
    assert.equal(env.wal.read().broken, false);
  } finally {
    fs.rmSync(path.dirname(path.dirname(env.dir)), { recursive: true, force: true });
  }
});

test('WAL-7: without an audit archive nothing is pruned', () => {
  const dir = path.join(tempRoot('wal-rot-noaudit-'), 'vault', 'proposals');
  try {
    const file = path.join(dir, 'wal.jsonl');
    const wal = createWal({ file, maxLines: 1000, keepSegments: 0 });
    const old = new Date(Date.now() - 8 * DAY_MS).toISOString();
    for (let index = 0; index < 4; index += 1) wal.append('apply.done', { at: old, seqNote: index });
    const rotated = wal.rotate({ force: true });
    assert.equal(rotated.rotated, true);
    const segment = wal.listSegments()[0];
    assert.equal(rawLines(segment.file).length, 4, 'incident evidence kept without an archive');
    assert.equal(fs.existsSync(path.join(dir, 'wal.snapshot.json')), true);
  } finally {
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  }
});

test('WAL-8: replay verifies the chain continuously across segments and stops at a break', () => {
  const dir = path.join(tempRoot('wal-rot-chain-'), 'vault', 'proposals');
  try {
    const file = path.join(dir, 'wal.jsonl');
    const wal = createWal({ file, maxLines: 1000 });
    for (let index = 1; index <= 4; index += 1) wal.append('queue.reconcile', { reason: `a${index}` });
    assert.equal(wal.rotate({ force: true }).rotated, true);
    for (let index = 5; index <= 8; index += 1) wal.append('queue.reconcile', { reason: `b${index}` });
    assert.equal(wal.rotate({ force: true }).rotated, true);
    assert.deepEqual(wal.listSegments().map((segment) => segment.name), ['wal.1.jsonl', 'wal.5.jsonl']);

    // Missing snapshot: replay both segments + active as one chain.
    fs.rmSync(path.join(dir, 'wal.snapshot.json'));
    const replay = wal.read();
    assert.equal(replay.broken, false);
    assert.deepEqual(replay.lines.map((line) => line.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const line of replay.lines) assert.equal(line.hash, walLineHash(line));

    // Break the second line of the oldest segment: stop there, never guess.
    const segmentFile = wal.listSegments()[0].file;
    const broken = rawLines(segmentFile);
    broken[1].seq = 22;
    fs.writeFileSync(segmentFile, `${broken.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const state = wal.read();
    assert.equal(state.broken, true);
    assert.equal(state.brokenAt, 1);
    assert.deepEqual(state.lines.map((line) => line.seq), [1]);
    assert.throws(() => wal.append('queue.reconcile', { reason: 'nope' }), (error) => error.code === 'E_WAL_BROKEN');
  } finally {
    fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  }
});

test('WAL-9: crash between rename and snapshot keeps every assignment and the ticket sequence', async () => {
  const env = setup('wal-rot-crash-');
  try {
    const one = await propose(env.engine, 'one');
    const two = await propose(env.engine, 'two');
    const three = await propose(env.engine, 'three');
    assert.equal(env.engine.wal.rotate({ force: true }).rotated, true);
    // Fault injection: the segment exists, the snapshot was never written.
    fs.rmSync(env.snapshotFile);
    assert.deepEqual(env.engine.wal.listSegments().map((segment) => segment.name), ['wal.1.jsonl']);

    const restartedWal = createWal({ file: env.walFile, audit: () => {} });
    const restartedEngine = createProposalEngine({
      config: env.config,
      paths: env.paths,
      memoryRoot: env.memoryRoot,
      audit: () => {},
      now: () => new Date(),
    });
    const four = await propose(restartedEngine, 'four');
    assert.equal(four.ok, true);
    assert.equal(four.ticket, 4);
    assert.equal(four.ticketName, 'q-0004');
    const replay = restartedWal.read();
    assert.equal(replay.broken, false);
    assert.equal(replay.lastSeq, 4);
    assert.equal(replay.lines.filter((line) => line.ev === 'queue.assign').length, 4);

    const queue = createQueueManager({
      paths: env.paths,
      config: env.config,
      wal: restartedWal,
      audit: () => {},
      now: () => new Date(),
    });
    const rebuilt = queue.rebuild();
    assert.equal(rebuilt.recovered.length, 0);
    assert.equal(rebuilt.reconciled.length, 0);
    const tickets = readQueueFile(path.join(env.paths.proposalsDir, 'queue.json')).entries.map((entry) => entry.ticket).sort();
    assert.deepEqual(tickets, [one.ticketName, two.ticketName, three.ticketName, four.ticketName].sort());
    assert.equal(new Set(tickets).size, 4);
  } finally {
    env.cleanup();
  }
});
