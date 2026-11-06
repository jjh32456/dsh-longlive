// WP6 — L4 small-write coalescing + L4c planner (DESIGN §5.8/§2.4, K20).
//
// Layer-1 mock contract: no host, no model, no network. Pure planner tests run
// first, then the proposal engine against a real temp vault so a failure here is
// a store/queue protocol failure, not a mock artefact.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeRouterConfig } from '../../src/router/service/config.mjs';
import { createProposalEngine } from '../../src/router/service/proposals.mjs';
import { createQueueManager } from '../../src/router/service/queue.mjs';
import { createWal } from '../../src/router/service/wal.mjs';
import { createWakeChannel } from '../../src/router/service/wake.mjs';
import { readProposal, readQueueFile } from '../../src/router/service/store.mjs';
import {
  SMALL_WRITE_SEGMENT_MAX_BYTES,
  SMALL_WRITE_MERGED_MAX_BYTES,
  SMALL_WRITE_SEPARATOR,
  buildL4JournalContent,
  canMergeSmallWrite,
  planL4Merge,
  planSmallWriteMerge,
} from '../../src/router/service/merge.mjs';
import { readJson, tempRoot, writeMemory } from './helpers.mjs';

function setup(prefix = 'wp6-merge-') {
  const temp = tempRoot(prefix);
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const config = normalizeRouterConfig({
    proposalEnabled: true,
    applyEnabled: false,
    agingSeconds: 10,
    l4MergeEnabled: false,
  });
  const audit = [];
  const auditFn = (kind, data = {}) => audit.push({ kind, ...data });
  const paths = { vaultDir, proposalsDir: path.join(vaultDir, 'proposals'), liveRoot: memoryRoot };
  const wal = createWal({ file: path.join(paths.proposalsDir, 'wal.jsonl'), audit: auditFn });
  const engine = createProposalEngine({ config, paths, memoryRoot, audit: auditFn, now: () => new Date() });
  const wakeChannel = createWakeChannel({ vaultDir, config, audit: auditFn, now: () => new Date() });
  engine.wake = wakeChannel;
  const queue = createQueueManager({ paths, config, wal, audit: auditFn, now: () => new Date() });
  return {
    temp,
    memoryRoot,
    vaultDir,
    config,
    paths,
    audit,
    wal,
    engine,
    queue,
    wakeChannel,
    wakeFile: path.join(vaultDir, 'wake-ready.jsonl'),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

function propose(env, content, extra = {}) {
  return env.engine.propose({
    op: 'journal.append',
    target: 'journal/2026-11.md',
    title: `t-${content.slice(0, 20)}`,
    content,
    ...extra,
  }, { caller: { kind: 'root', sessionId: 'root-session' } });
}

function fakeProposal(id, content, overrides = {}) {
  return {
    id,
    op: 'journal.append',
    target: 'journal/2026-11.md',
    content,
    status: 'pending',
    baseSha: 'sha256:aaa',
    mergeKey: 'sha256:mmm',
    rev: 1,
    stateLog: [],
    queue: { ticket: `q-${id.slice(1).padStart(4, '0')}` },
    ...overrides,
  };
}

function wakeLines(env) {
  try {
    return fs.readFileSync(env.wakeFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('merge: every gate is required (target/op/mergeKey/adjacent/2KB/4KB/base)', () => {
  const previous = fakeProposal('p1', 'alpha');
  const next = fakeProposal('p2', 'beta');
  const ok = canMergeSmallWrite(previous, next, { adjacent: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.content, `alpha${SMALL_WRITE_SEPARATOR}beta`);
  assert.equal(ok.bytes, Buffer.byteLength(ok.content));

  assert.equal(canMergeSmallWrite(previous, { ...next, target: 'journal/2026-12.md' }, { adjacent: true }).code, 'target-mismatch');
  assert.equal(canMergeSmallWrite(previous, { ...next, op: 'topic.append' }, { adjacent: true }).code, 'op-mismatch');
  assert.equal(canMergeSmallWrite(previous, { ...next, mergeKey: 'sha256:other' }, { adjacent: true }).code, 'merge-key-mismatch');
  assert.equal(canMergeSmallWrite(previous, next, { adjacent: false }).code, 'not-adjacent');
  assert.equal(canMergeSmallWrite(previous, { ...next, status: 'approved' }, { adjacent: true }).code, 'not-pending');
  assert.equal(canMergeSmallWrite({ ...previous, baseSha: 'sha256:old' }, next, { adjacent: true, currentSha: 'sha256:new' }).code, 'base-moved');

  const atLimit = 'x'.repeat(SMALL_WRITE_SEGMENT_MAX_BYTES);
  assert.equal(canMergeSmallWrite(fakeProposal('p1', atLimit), fakeProposal('p2', 'y'), { adjacent: true }).ok, true);
  assert.equal(canMergeSmallWrite(fakeProposal('p1', `${atLimit}x`), fakeProposal('p2', 'y'), { adjacent: true }).code, 'segment-too-large');
  assert.equal(
    canMergeSmallWrite(
      fakeProposal('p1', atLimit),
      fakeProposal('p2', atLimit),
      { adjacent: true },
    ).code,
    'merged-too-large',
  );
  assert.ok(Buffer.byteLength(`${atLimit}${SMALL_WRITE_SEPARATOR}${atLimit}`) > SMALL_WRITE_MERGED_MAX_BYTES);

  // A null currentSha is the "target not created yet" snapshot: null===null.
  assert.equal(canMergeSmallWrite(
    { ...previous, baseSha: null },
    { ...next, baseSha: null },
    { adjacent: true, currentSha: null },
  ).ok, true);
});

test('merge: later proposal is absorbed into the earlier one (mergedInto/superseded)', () => {
  const previous = fakeProposal('p1', 'alpha');
  const next = fakeProposal('p2', 'beta');
  const plan = planSmallWriteMerge(previous, next, { at: '2026-11-05T00:00:00.000Z', adjacent: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.keeper.id, 'p1');
  assert.equal(plan.absorbed.id, 'p2');
  assert.equal(plan.keeper.queue.ticket, 'q-0001');
  assert.equal(plan.keeper.content, `alpha${SMALL_WRITE_SEPARATOR}beta`);
  assert.equal(plan.keeper.rev, 2);
  assert.equal(plan.keeper.stateLog.at(-1).note, 'merged-in:q-0002');
  assert.equal(plan.absorbed.status, 'superseded');
  assert.equal(plan.absorbed.queue.mergedInto, 'p1');
  assert.equal(plan.absorbed.queue.supersededBy, 'p1');
  assert.equal(plan.absorbed.queue.ticket, 'q-0002');
  assert.equal(plan.absorbed.stateLog.at(-1).to, 'superseded');
  // dedupeKey is recomputed over the merged body, not inherited from the keeper.
  assert.notEqual(plan.keeper.dedupeKey, previous.dedupeKey);
  // The keeper keeps the first segment first: there is no reordering.
  assert.ok(plan.keeper.content.startsWith('alpha'));
});

test('merge: engine coalesces adjacent small writes, keeps one ticket, one wake line, one apply slot', async () => {
  const env = setup();
  try {
    const first = await propose(env, 'alpha');
    const second = await propose(env, 'beta');
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.merged, true);
    assert.equal(second.mergedInto, first.id);
    assert.equal(second.ticket, first.ticket);

    const keeper = readProposal(env.paths.proposalsDir, first.id);
    const absorbed = readProposal(env.paths.proposalsDir, second.id);
    assert.equal(keeper.status, 'pending');
    assert.equal(keeper.content, `alpha${SMALL_WRITE_SEPARATOR}beta`);
    // scanProposalDir's __file breadcrumb must not leak into the persisted JSON.
    const keeperOnDisk = JSON.parse(fs.readFileSync(path.join(env.paths.proposalsDir, `${first.id}.json`), 'utf8'));
    assert.equal(Object.hasOwn(keeperOnDisk, '__file'), false);
    assert.equal(absorbed.status, 'superseded');
    assert.equal(absorbed.queue.mergedInto, first.id);
    assert.equal(absorbed.queue.supersededBy, first.id);

    const queueFile = readQueueFile(path.join(env.paths.proposalsDir, 'queue.json'));
    assert.deepEqual(queueFile.entries.map((entry) => entry.proposalId), [first.id]);
    assert.equal(queueFile.entries[0].ticket, first.ticketName);

    const merges = env.audit.filter((row) => row.kind === 'merge.superseded');
    assert.equal(merges.length, 1);
    assert.equal(merges[0].keeperId, first.id);
    assert.equal(merges[0].absorbedId, second.id);

    // Tier A: the absorbed proposal must not add a second ready line.
    const lines = wakeLines(env);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ticket, first.ticketName);

    // K20: only one apply is possible because only the keeper is queued.
    const queue = createQueueManager({
      paths: env.paths,
      config: env.config,
      wal: env.wal,
      audit: () => {},
      now: () => new Date(),
    });
    await queue.maintain();
    const again = readProposal(env.paths.proposalsDir, second.id);
    assert.equal(again.status, 'superseded', 'M-09: never auto-split back');
    assert.equal(readProposal(env.paths.proposalsDir, first.id).content, `alpha${SMALL_WRITE_SEPARATOR}beta`);
  } finally {
    env.cleanup();
  }
});

test('merge: seqCounter is not recycled after an absorbed ticket', async () => {
  const env = setup();
  try {
    const first = await propose(env, 'alpha');
    const second = await propose(env, 'beta');
    assert.equal(second.merged, true);
    const third = await propose(env, 'gamma');
    assert.equal(third.merged, true, 'third also coalesces into the keeper');
    assert.equal(third.ticket, first.ticket);
    // The absorbed seq (q-0002) was spent and must not be handed out again.
    const fourth = await propose(env, 'delta', { target: 'topics/other.md', op: 'topic.append' });
    assert.equal(fourth.ok, true);
    assert.equal(fourth.ticket, 4);
    assert.equal(fourth.ticketName, 'q-0004');
  } finally {
    env.cleanup();
  }
});

test('merge: 2KB per segment and 4KB total are hard limits', async () => {
  const env = setup();
  try {
    const first = await propose(env, 'a'.repeat(SMALL_WRITE_SEGMENT_MAX_BYTES));
    const big = await propose(env, 'b'.repeat(SMALL_WRITE_SEGMENT_MAX_BYTES));
    assert.equal(big.merged, undefined, '2048+2048 plus separator exceeds 4096');
    assert.notEqual(big.ticket, first.ticket);
    const tooBig = await propose(env, 'c'.repeat(SMALL_WRITE_SEGMENT_MAX_BYTES + 1));
    assert.equal(tooBig.merged, undefined, 'a single segment over 2048 never merges');
  } finally {
    env.cleanup();
  }
});

test('merge: a non-adjacent proposal never reaches past its queue predecessor', async () => {
  const env = setup();
  try {
    const first = await propose(env, 'alpha');
    const middle = await propose(env, 'middle', { target: 'topics/other.md', op: 'topic.append' });
    const third = await propose(env, 'gamma');
    assert.equal(middle.merged, undefined);
    assert.equal(third.merged, undefined);
    assert.notEqual(third.ticket, first.ticket);
    const keeper = readProposal(env.paths.proposalsDir, first.id);
    assert.equal(keeper.content, 'alpha');
    assert.equal(readProposal(env.paths.proposalsDir, third.id).status, 'pending');
  } finally {
    env.cleanup();
  }
});

test('merge: a moved base keeps both proposals queued (no merge, no split)', async () => {
  const env = setup();
  try {
    const journal = path.join(env.memoryRoot, 'journal');
    fs.mkdirSync(journal, { recursive: true });
    const target = path.join(journal, '2026-11.md');
    fs.writeFileSync(target, 'old\n', 'utf8');
    const first = await propose(env, 'alpha');
    fs.writeFileSync(target, 'new\n', 'utf8');
    const second = await propose(env, 'beta');
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.merged, undefined);
    assert.notEqual(second.ticket, first.ticket);
    assert.equal(readProposal(env.paths.proposalsDir, first.id).content, 'alpha');
    assert.equal(readProposal(env.paths.proposalsDir, second.id).status, 'pending');
  } finally {
    env.cleanup();
  }
});

test('merge: identical content dedupes before merge is considered (K20)', async () => {
  const env = setup();
  try {
    const first = await propose(env, 'same-body');
    const second = await propose(env, 'same-body');
    assert.equal(second.duplicateOf, first.id);
    assert.equal(readProposal(env.paths.proposalsDir, second.id), null);
    assert.equal(env.audit.filter((row) => row.kind === 'merge.superseded').length, 0);
  } finally {
    env.cleanup();
  }
});

test('L4: disabled is an exact no-op; window, rounds, root, quota and per-session/day gate the fold', () => {
  const proposals = [
    { id: 'p1', origin: { sessionId: 's1' }, title: '标题一', queue: { ticket: 'q-0001' } },
    { id: 'p2', origin: { sessionId: 's1' }, title: '标题二', queue: { ticket: 'q-0002' } },
  ];
  const sessions = [{ sessionId: 's1', goal: '把 Router 1.1.0 收尾', roundsSinceLastMerge: 3 }];

  const disabled = planL4Merge({ enabled: false, now: new Date(2026, 10, 5, 5, 0, 0), sessions, proposals });
  assert.deepEqual(disabled.proposals, []);
  assert.equal(disabled.reason, 'disabled');

  const before = planL4Merge({ enabled: true, now: new Date(2026, 10, 5, 3, 59, 0), sessions, proposals });
  assert.equal(before.reason, 'before-window');

  const tooFewRounds = planL4Merge({
    enabled: true,
    now: new Date(2026, 10, 5, 5, 0, 0),
    sessions: [{ ...sessions[0], roundsSinceLastMerge: 2 }],
    proposals,
  });
  assert.equal(tooFewRounds.proposals.length, 0);

  const subagent = planL4Merge({
    enabled: true,
    now: new Date(2026, 10, 5, 5, 0, 0),
    sessions: [{ ...sessions[0], isSubagent: true }],
    proposals,
  });
  assert.equal(subagent.proposals.length, 0);

  const plan = planL4Merge({ enabled: true, now: new Date(2026, 10, 5, 5, 0, 0), sessions, proposals });
  assert.equal(plan.proposals.length, 1);
  const input = plan.proposals[0];
  assert.equal(input.op, 'journal.append');
  assert.equal(input.target, 'journal/2026-11.md');
  assert.equal(input.risk, 'medium');
  assert.equal(input.content.split('\n').length, 3);
  assert.ok(input.content.split('\n').every((line) => line.startsWith('- ')));
  assert.ok(input.content.length <= 600);
  assert.ok(input.content.includes('把 Router 1.1.0 收尾'));
  assert.ok(input.evidence.includes('live:s1'));
  assert.ok(input.evidence.includes('proposal:p1'));
  assert.equal(plan.state.count, 1);

  const sameDayAgain = planL4Merge({
    enabled: true,
    now: new Date(2026, 10, 5, 6, 0, 0),
    sessions,
    proposals,
    state: plan.state,
  });
  assert.equal(sameDayAgain.proposals.length, 0, 'one fold per session per local day');

  const manySessions = Array.from({ length: 7 }, (_, index) => ({
    sessionId: `s${index + 1}`,
    goal: `goal-${index + 1}`,
    roundsSinceLastMerge: 3,
  }));
  const manyProposals = manySessions.map((session, index) => ({
    id: `p${index + 1}`,
    origin: { sessionId: session.sessionId },
    title: `title-${index + 1}`,
    queue: { ticket: `q-000${index + 1}` },
  }));
  const capped = planL4Merge({
    enabled: true,
    now: new Date(2026, 10, 5, 5, 0, 0),
    sessions: manySessions,
    proposals: manyProposals,
  });
  assert.equal(capped.proposals.length, 5, 'global daily cap is 5');
  assert.equal(capped.state.count, 5);
});

test('L4: content is exactly three bullets and always <=600 chars', () => {
  const text = buildL4JournalContent({ goal: 'g'.repeat(500), titles: ['t'.repeat(500)], nextTicket: 'q-9999' });
  assert.ok(text.length <= 600);
  assert.equal(text.split('\n').length, 3);
  assert.ok(text.split('\n').every((line) => line.startsWith('- ')));
});

test('L4: engine proposals do not trigger the fold while routerL4MergeEnabled=false', () => {
  const env = setup();
  try {
    assert.equal(env.config.l4MergeEnabled, false);
    const plan = planL4Merge({ enabled: env.config.l4MergeEnabled, sessions: [], proposals: [] });
    assert.equal(plan.reason, 'disabled');
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'l4-merge-state.json')), false);
    assert.equal(env.audit.filter((row) => row.kind.startsWith('merge.l4')).length, 0);
  } finally {
    env.cleanup();
  }
});
