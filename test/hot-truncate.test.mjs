// Hot truncate (cut-only compaction) contract tests.
//
// The host is mocked down to the seams the engine actually uses:
//   MockSession — an append-only event log with the real surface replace
//                 contract (a replace must name every removed node in
//                 sourceEventSeqs, and the replacement takes the range's
//                 position);
//   MockMeter   — fixed price per surface event, so retention windows are exact;
//   entry       — loaded with fixture host packages through the documented
//                 env overrides, to exercise import/construct fallback,
//                 mode=off, live-compact deference and no-op degradation.
//
// What is pinned here:
//   * an open / aborted turn is never cut;
//   * only turns older than retainTurns AND retainTokens are cut;
//   * the cut point and later surface text are untouched (only a prefix shrinks);
//   * the archive contains every original event of the cut turns with a
//     verifiable sha256 and exact event count, append-only and atomic;
//   * the pointer text names N/M, session_original(turn=…), and the archive;
//   * failures leave the session unchanged and fall back to stock;
//   * live-compact wins by default (package/profile/gate/ctx probes);
//   * three consecutive cuts are idempotent.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ARCHIVE_SCHEMA,
  PROVIDER,
  buildPointerText,
  createCutEngine,
  normalizeOptions,
  writeArchive,
} from '../src/compaction/engine-core.js';
import { foldSurface } from '../src/codec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-truncate-'));

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // Best effort on Windows.
  }
});

let caseId = 0;
function caseDir(name) {
  caseId += 1;
  const dir = path.join(TMP, `${caseId}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Host mock
// ---------------------------------------------------------------------------

class MockManualCompactionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ManualCompactionError';
    this.code = code;
  }
}

class MockCompactionEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = 'compaction';
    this.kind = 'mock';
    ctx.reflect.store[Symbol.for(`compaction:${Math.random()}`)] = this;
  }
}

class MockSession {
  constructor(id = 'session-hot-truncate', { hideEvents = false } = {}) {
    this.id = id;
    this._events = [];
    this._surface = [];
    this._generation = 0;
    // The real host Session has no `events` property. Tests that set
    // hideEvents keep the mock surface API but make the legacy array
    // unreadable, so only snapshotEvents()/eventAt() can serve the engine.
    this.hideEvents = hideEvents;
  }

  get events() {
    return this.hideEvents ? undefined : this._events;
  }

  get surface() {
    return { nodes: this._surface, replaceGeneration: this._generation };
  }

  get seq() {
    return this._events.length;
  }

  eventAt(seq) {
    return this._events[seq];
  }

  append(type, data, options = {}) {
    const event = { type, seq: this._events.length, time: 1_700_000_000_000 + this._events.length, data: structuredClone(data) };
    if (options.surfaceOp !== undefined) {
      event.surfaceOp = structuredClone(options.surfaceOp);
      if (options.sourceEventSeqs !== undefined) event.sourceEventSeqs = [...options.sourceEventSeqs];
      if (options.surfaceOp === 'append') {
        this._surface.push(event.seq);
      } else {
        // Pin the host's exact replace contract: three own keys named
        // op/startSeq/endSeq (the host rejects `start`/`end`).
        assert.deepEqual(Object.keys(options.surfaceOp).sort(), ['endSeq', 'op', 'startSeq'],
          'surfaceOp must be the host replace shape {op, startSeq, endSeq}');
        const { startSeq: start, endSeq: end } = options.surfaceOp;
        const startIndex = this._surface.indexOf(start);
        const endIndex = this._surface.indexOf(end);
        assert.ok(startIndex >= 0, `replace start ${start} is on the surface`);
        assert.ok(endIndex >= startIndex, `replace end ${end} follows start ${start}`);
        const removed = this._surface.slice(startIndex, endIndex + 1);
        for (const seq of removed) {
          assert.ok(event.sourceEventSeqs.includes(seq), `sourceEventSeqs cites shadowed node ${seq}`);
        }
        this._surface.splice(startIndex, removed.length, event.seq);
        this._generation += 1;
      }
    }
    this._events.push(event);
    return event;
  }

  snapshotEvents() {
    return this._events.slice();
  }

  deriveEventMessage(event) {
    if (event.type === 'user/message') return event.data;
    if (event.type === 'assistant/message') return event.data.message;
    if (event.type === 'tool/result') return event.data.message;
    return null;
  }
}

class MockCtx {
  constructor(meter) {
    this.tokenMeter = meter;
    this.sessions = {
      flushed: 0,
      flush: async () => {
        this.sessions.flushed += 1;
        return true;
      },
    };
    this.store = {};
    this.reflect = { store: this.store };
    this.fiber = { store: {} };
    this.services = {};
    this.handlers = new Map();
    this.lines = [];
    const push = (level) => (message) => this.lines.push({ level, message: String(message) });
    this.logger = { info: push('info'), warn: push('warn'), debug: () => {}, error: push('error') };
  }

  on(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(handler);
  }

  get(name) {
    return this.services[name];
  }

  text(level = null) {
    return this.lines.filter((line) => level === null || line.level === level).map((line) => line.message).join('\n');
  }
}

function makeMeter(perEvent = 500) {
  return {
    measure(session) {
      const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: perEvent }));
      return { totalTokens: nodes.length * perEvent, nodes };
    },
    estimateMessage(message) {
      return Math.ceil(JSON.stringify(message).length / 2);
    },
  };
}

function makeAgent(session) {
  return {
    session,
    status: 'idle',
    runMaintenance: (task) => task(new AbortController().signal),
  };
}

function addTurn(session, turn, { completed = true, open = false, surface = true } = {}) {
  session.append('turn/start', { turn });
  if (surface) {
    session.append('user/message', {
      id: `user-${turn}`,
      role: 'user',
      content: [{ type: 'text', text: `第 ${turn} 轮用户消息` }],
      source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
    }, { surfaceOp: 'append' });
    session.append('assistant/message', {
      turn,
      step: 1,
      message: {
        id: `assistant-${turn}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text: `第 ${turn} 轮回答` }],
      },
    }, { surfaceOp: 'append' });
  }
  if (!open) session.append('turn/end', { turn, reason: { kind: completed ? 'completed' : 'aborted' } });
}

/** A turn whose first surface node is the host's system prompt (surface 0). */
function addTurnWithSystemHead(session, turn, options = {}) {
  session.append('turn/start', { turn });
  session.append('system/message', {
    turn,
    step: 1,
    message: {
      id: `system-${turn}`,
      role: 'system',
      source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: 'You are a protected system prompt.' }],
    },
  }, { surfaceOp: 'append' });
  session.append('user/message', {
    id: `user-${turn}`,
    role: 'user',
    content: [{ type: 'text', text: `第 ${turn} 轮用户消息` }],
    source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
  }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      id: `assistant-${turn}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text: `第 ${turn} 轮回答` }],
    },
  }, { surfaceOp: 'append' });
  if (!options.open) session.append('turn/end', { turn, reason: { kind: options.completed === false ? 'aborted' : 'completed' } });
}

/** A turn whose system prompt sits after its user message (mid-span barrier). */
function addTurnWithSystemInside(session, turn, options = {}) {
  session.append('turn/start', { turn });
  session.append('user/message', {
    id: `user-${turn}`,
    role: 'user',
    content: [{ type: 'text', text: `第 ${turn} 轮用户消息` }],
    source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
  }, { surfaceOp: 'append' });
  session.append('system/message', {
    turn,
    step: 2,
    message: {
      id: `system-${turn}`,
      role: 'system',
      source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: 'A later system message.' }],
    },
  }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn,
    step: 2,
    message: {
      id: `assistant-${turn}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text: `第 ${turn} 轮回答` }],
    },
  }, { surfaceOp: 'append' });
  if (!options.open) session.append('turn/end', { turn, reason: { kind: options.completed === false ? 'aborted' : 'completed' } });
}

function buildSession(turns, { openLast = true, lastCompleted = true, perTurn = null, hideEvents = false } = {}) {
  const session = new MockSession('session-hot-truncate', { hideEvents });
  for (let turn = 1; turn <= turns; turn += 1) {
    if (openLast && turn === turns) addTurn(session, turn, { open: true });
    else addTurn(session, turn, { completed: lastCompleted });
    if (typeof perTurn === 'function') perTurn(turn);
  }
  return session;
}

function engineFor({ perEvent = 500, archiveDir, engineDeps = {}, useDefaults = false, ...options } = {}) {
  const meter = makeMeter(perEvent);
  const ctx = new MockCtx(meter);
  const Engine = createCutEngine({
    CompactionEngine: MockCompactionEngine,
    CompactionId: (id) => id,
    ManualCompactionError: MockManualCompactionError,
    compactCheckpointSource: (compactionId, sourceCommandId) => ({
      kind: 'plugin', plugin: 'compact', compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    }),
    isCompactCheckpointSource: (source) => source?.kind === 'plugin' && source?.plugin === 'compact',
    createUserMessage: (input) => ({
      id: `msg-${Math.random().toString(16).slice(2)}`,
      role: 'user',
      content: input.content,
      source: input.source,
    }),
    toolPairingBalancedBefore: () => true,
    toolPairingBalancedAfter: () => true,
    ...engineDeps,
  });
  const engine = new Engine(ctx, {
    hotTruncate: {
      mode: 'cut',
      // Most historical cases pin the pre-1.6.4 window/threshold explicitly;
      // useDefaults drops those pins so the test exercises the new
      // DEFAULT_OPTIONS (4 turns / 300000 tokens).
      ...(useDefaults ? {} : { retainTurns: 6, retainTokens: 0, autoMinTokens: 0 }),
      archiveDir: archiveDir !== undefined ? archiveDir : caseDir('archive'),
      ...options,
    },
  });
  return { engine, ctx, meter };
}

function pointerEvents(session) {
  return session._events.filter((event) => event.type === 'compaction/summary');
}

function readArchive(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  const header = JSON.parse(lines[0]);
  const footer = JSON.parse(lines[lines.length - 1]);
  const bodyLines = lines.slice(1, -1);
  const body = bodyLines.map((line) => `${line}\n`).join('');
  const sha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  return { header, footer, records: bodyLines.map((line) => JSON.parse(line)), bodyLines, sha256, text };
}

// ---------------------------------------------------------------------------
// Selection and safety
// ---------------------------------------------------------------------------

test('H1 open turn is never cut; only completed turns older than the window go', async () => {
  const session = buildSession(9, { openLast: true });
  const { engine, ctx } = engineFor({ archiveDir: caseDir('archive') });
  const before = session.surface.nodes.length;
  const result = await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);

  assert.ok(result, 'cut happened');
  assert.deepEqual(result.shadowedSeqs.length, 4, 'turns 1-2 have two surface nodes each');
  assert.equal(pointerEvents(session).length, 1);
  assert.equal(session.surface.nodes[0], result.summarySeq + 1, 'pointer is the first surface node');
  assert.equal(session.surface.nodes.length, before - result.shadowedSeqs.length + 1);
  // The open turn's own messages are still on the surface.
  const openUser = session.events.find((event) => event.type === 'user/message' && event.data.id === 'user-9');
  assert.ok(session.surface.nodes.includes(openUser.seq), 'open turn untouched');
  // And a session with fewer than retainTurns completed turns cannot cut.
  const small = buildSession(5, { openLast: true });
  const second = await engine.compactIfNeeded(makeAgent(small), 'pressure', new AbortController().signal);
  assert.equal(second, null);
  assert.equal(pointerEvents(small).length, 0);
  assert.ok(ctx.lines.length >= 0);
});

test('H2 retainTurns and retainTokens both gate the cut', async () => {
  const turns = buildSession(10, { openLast: false });
  const { engine } = engineFor({ perEvent: 500, archiveDir: caseDir('archive'), retainTurns: 3, retainTokens: 2500 });
  const result = await engine.compactNow(makeAgent(turns), new AbortController().signal);
  assert.ok(result);
  assert.equal(result.shadowedSeqs.length, 14, 'turns 1-7 cut');
  // Surface: pointer + turns 8,9,10 (2 nodes each).
  assert.equal(turns.surface.nodes.length, 1 + 6);
  const pointer = turns.events[result.summarySeq + 1];
  assert.match(pointer.data.content[0].text, /保留窗口：最近 3 个已完成轮、至少 2500 tokens/);

  const tokenDominant = buildSession(10, { openLast: false });
  const second = engineFor({ perEvent: 500, archiveDir: caseDir('archive'), retainTurns: 1, retainTokens: 4500 });
  const result2 = await second.engine.compactNow(makeAgent(tokenDominant), new AbortController().signal);
  assert.ok(result2);
  assert.equal(result2.shadowedSeqs.length, 10, 'turns 1-5 cut by the token floor');
  assert.equal(tokenDominant.surface.nodes.length, 1 + 10);
});

test('H3 an aborted turn blocks the prefix but never gets cut itself', async () => {
  const session = new MockSession();
  for (let turn = 1; turn <= 3; turn += 1) addTurn(session, turn, { completed: false });
  for (let turn = 4; turn <= 9; turn += 1) addTurn(session, turn, { completed: true });
  const { engine } = engineFor({ archiveDir: caseDir('archive') });
  const result = await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);
  assert.equal(result, null, 'the aborted turn-1 prefix is not a legal completed-only cut');
  assert.equal(pointerEvents(session).length, 0);
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

test('H4 archive: atomic JSONL, exact event count, sha256, append-only', async () => {
  const dir = caseDir('archive');
  const session = buildSession(9, { openLast: false });
  const { engine } = engineFor({ archiveDir: dir });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result);

  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}T\d{9}Z-[0-9a-f]{8}\.jsonl$/);
  const parsed = readArchive(path.join(dir, files[0]));
  assert.equal(parsed.header.kind, 'hot-truncate/header');
  assert.equal(parsed.header.schema, ARCHIVE_SCHEMA);
  assert.equal(parsed.header.compactionId, result.compactionId);
  assert.equal(parsed.header.provider, PROVIDER);
  assert.equal(parsed.footer.kind, 'hot-truncate/footer');
  assert.equal(parsed.header.eventCount, parsed.records.length);
  assert.equal(parsed.footer.eventCount, parsed.records.length);
  assert.equal(parsed.header.bodySha256, parsed.sha256);
  assert.equal(parsed.footer.bodySha256, parsed.sha256);
  // Turns 1-3: turn/start, user, assistant, turn/end = 12 original events.
  assert.equal(parsed.records.length, 12);
  assert.deepEqual([...new Set(parsed.records.map((record) => record.turn))], [1, 2, 3]);
  for (const record of parsed.records) {
    const original = session.events[record.seq];
    assert.ok(original, `seq ${record.seq} exists in the log`);
    assert.equal(record.type, original.type);
    assert.deepEqual(record.data, original.data, `seq ${record.seq} data is the original`);
    assert.ok('seq' in record && 'turn' in record, 'each line carries seq/turn');
  }
  assert.deepEqual(parsed.header.cutTurns, [
    { turn: 1, firstSeq: 1, lastSeq: 2, startSeq: 0, endSeq: 3, surfaceEvents: 2, tokens: 1000 },
    { turn: 2, firstSeq: 5, lastSeq: 6, startSeq: 4, endSeq: 7, surfaceEvents: 2, tokens: 1000 },
    { turn: 3, firstSeq: 9, lastSeq: 10, startSeq: 8, endSeq: 11, surfaceEvents: 2, tokens: 1000 },
  ]);
  const headerBefore = parsed.sha256;

  // A later cut must add a second file and leave the first byte-identical.
  addTurn(session, 10, { completed: true });
  addTurn(session, 11, { open: true });
  const second = await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);
  assert.ok(second);
  const filesAfter = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  assert.equal(filesAfter.length, 2, 'append-only: a new archive file, never a rewrite');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, filesAfter.find((name) => name !== files[0])), 'utf8')).digest('hex').length, 64);
  assert.equal(readArchive(path.join(dir, files[0])).sha256, headerBefore, 'first archive untouched');
});

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

test('H5 pointer text carries N/M, session_original(turn=…), and the archive path', async () => {
  const dir = caseDir('archive');
  const session = buildSession(9, { openLast: false });
  const { engine } = engineFor({ archiveDir: dir });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result);
  const text = result.summary[0].text;
  assert.match(text, /本会话共 9 轮，其中 3 轮已压缩归档；需要原文用 session_original\(turn=…\) 或读归档路径：/);
  assert.ok(text.includes(dir), 'archive directory is in the pointer');
  assert.match(text, /只切已完成且早于保留窗口的轮/);
  assert.match(text, /保留窗口：最近 6 个已完成轮、至少 0 tokens（本次保留 6 轮）/);

  const pointerEvent = session.events[result.summarySeq + 1];
  assert.equal(pointerEvent.type, 'user/message');
  assert.deepEqual(pointerEvent.surfaceOp, { op: 'replace', startSeq: result.shadowedRange.start, endSeq: result.shadowedRange.end });
  assert.equal(pointerEvent.data.source.kind, 'plugin');
  assert.equal(pointerEvent.data.source.plugin, 'compact');
});

// ---------------------------------------------------------------------------
// Host contract pins (0.2.2-rc.1)
// ---------------------------------------------------------------------------

test('H26 host Session has no `events`: selection and commit use snapshotEvents()', async () => {
  const session = buildSession(9, { openLast: true, hideEvents: true });
  assert.equal(session.events, undefined, 'the mock hides the legacy array exactly like the host');
  const { engine } = engineFor({ archiveDir: caseDir('archive') });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result, 'the engine must still plan and commit through snapshotEvents()');
  assert.equal(pointerEvents(session).length, 1);
  assert.equal(session.surface.nodes[0], result.summarySeq + 1, 'pointer landed on the surface');
});

test('H27 surfaceOp is exactly the host shape {op, startSeq, endSeq}', async () => {
  const session = buildSession(9, { openLast: false });
  const { engine } = engineFor({ archiveDir: caseDir('archive') });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result);
  const pointer = session.events[result.summarySeq + 1];
  assert.deepEqual(Object.keys(pointer.surfaceOp).sort(), ['endSeq', 'op', 'startSeq']);
  assert.equal(pointer.surfaceOp.op, 'replace');
  assert.equal(pointer.surfaceOp.startSeq, result.shadowedRange.start);
  assert.equal(pointer.surfaceOp.endSeq, result.shadowedRange.end);
  assert.equal(Object.hasOwn(pointer.surfaceOp, 'start'), false);
  assert.equal(Object.hasOwn(pointer.surfaceOp, 'end'), false);
});

test('H28 a system prompt at surface 0 is never cut; the pointer lands at position 1', async () => {
  const session = new MockSession();
  addTurnWithSystemHead(session, 1);
  for (let turn = 2; turn <= 9; turn += 1) addTurn(session, turn, { open: turn === 9 });
  const systemEvent = session._events.find((event) => event.type === 'system/message');
  assert.ok(systemEvent);
  const firstUser = session._events.find((event) => event.type === 'user/message');
  const dir = caseDir('archive');
  const { engine } = engineFor({ archiveDir: dir });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result);
  assert.equal(result.shadowedSeqs.includes(systemEvent.seq), false, 'system seq is outside the cut span');
  assert.equal(session.surface.nodes[0], systemEvent.seq, 'system stays at surface position 0');
  assert.equal(session.surface.nodes[1], result.summarySeq + 1, 'pointer is the second surface node');
  const pointer = session._events[result.summarySeq + 1];
  assert.equal(pointer.surfaceOp.startSeq, firstUser.seq, 'cut starts at the first user message');
  assert.equal(pointer.sourceEventSeqs.includes(systemEvent.seq), false, 'system is not cited as shadowed');
  const file = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
  const parsed = readArchive(path.join(dir, file));
  assert.equal(parsed.header.cutTurns[0].firstSeq, firstUser.seq, 'turn 1 is cut from its first non-system node');
  assert.equal(parsed.header.cutTurns[0].startSeq, 0, 'the archive still covers the whole turn');
});

test('H29 a system message inside the candidate span stops the cut before its turn', async () => {
  const session = new MockSession();
  addTurn(session, 1);
  addTurnWithSystemInside(session, 2);
  for (let turn = 3; turn <= 9; turn += 1) addTurn(session, turn, { open: turn === 9 });
  const systems = session._events.filter((event) => event.type === 'system/message');
  assert.equal(systems.length, 1);
  const dir = caseDir('archive');
  const { engine } = engineFor({ archiveDir: dir });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result, 'the safe prefix before the system message is still cuttable');
  assert.equal(result.shadowedSeqs.includes(systems[0].seq), false);
  const file = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
  const parsed = readArchive(path.join(dir, file));
  assert.deepEqual(parsed.header.cutTurns.map((entry) => entry.turn), [1], 'only turn 1 is cut');
  assert.equal(session.surface.nodes.includes(systems[0].seq), true, 'the system node remains on the surface');
});

test('H6 successive cuts update the cumulative archived count and fold the old pointer', async () => {
  const session = buildSession(14, { openLast: false });
  const { engine } = engineFor({ archiveDir: caseDir('archive') });
  const first = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(first);
  assert.equal(first.shadowedSeqs.length, 16, 'turns 1-8');
  const firstText = first.summary[0].text;
  assert.match(firstText, /本会话共 14 轮，其中 8 轮已压缩归档/);

  // Three more completed turns and a fresh open turn: the next cut starts at
  // the old pointer (position 0) and includes turns 9-11.
  for (let turn = 15; turn <= 17; turn += 1) addTurn(session, turn, { completed: true });
  addTurn(session, 18, { open: true });
  const second = await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);
  assert.ok(second);
  assert.equal(second.shadowedSeqs[0], first.summary[0] === undefined ? -1 : session.events[first.summarySeq + 1].seq, 'old pointer is inside the new span');
  assert.equal(second.shadowedSeqs.length, 1 + 6, 'old pointer + turns 9-11');
  assert.match(second.summary[0].text, /本会话共 18 轮，其中 11 轮已压缩归档/);
  assert.equal(pointerEvents(session).length, 2);
});

test('H6b cumulative M is carried on the pointer, not re-derived from summary seqs', async () => {
  const session = buildSession(9, { openLast: true }); // 8 completed + open turn 9
  const { engine } = engineFor({ archiveDir: caseDir('archive') });
  const agent = makeAgent(session);

  // First cut happens while turn 9 is open: the pointer's seq belongs to turn 9.
  const first = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.ok(first);
  assert.match(first.summary[0].text, /其中 2 轮已压缩归档/);
  session.append('turn/end', { turn: 9, reason: { kind: 'completed' } });
  for (let turn = 10; turn <= 14; turn += 1) addTurn(session, turn, { completed: true });
  addTurn(session, 15, { open: true });

  // Second cut folds pointer #1 into its span while keeping turn 9 on the
  // surface. A seq-based archived count would now wrongly count turn 9.
  const second = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.ok(second);
  assert.match(second.summary[0].text, /其中 8 轮已压缩归档/);

  // Third cut folds pointer #2 in; M must still be the number of really
  // archived turns (8 + 4), never 8 + turn 9 + 4.
  session.append('turn/end', { turn: 15, reason: { kind: 'completed' } });
  for (let turn = 16; turn <= 18; turn += 1) addTurn(session, turn, { completed: true });
  addTurn(session, 19, { open: true });
  const third = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
  assert.ok(third);
  assert.match(third.summary[0].text, /本会话共 19 轮，其中 12 轮已压缩归档/);
  const pointer = session.events[third.summarySeq + 1];
  assert.equal(pointer.data.source.hotTruncate.archivedTurns, 12);
});

// ---------------------------------------------------------------------------
// Failure safety
// ---------------------------------------------------------------------------

test('H7 a failed archive write leaves the session byte-identical (auto) ', async () => {
  const session = buildSession(9, { openLast: true });
  const before = session.events.length;
  const surfaceBefore = [...session.surface.nodes];
  const { engine } = engineFor({
    archiveDir: caseDir('archive'),
    engineDeps: {
      archiveWriter: () => {
        throw new Error('disk full');
      },
    },
  });
  const result = await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);
  assert.equal(result, null);
  assert.equal(session.events.length, before, 'no compaction events appended');
  assert.deepEqual(session.surface.nodes, surfaceBefore);
});

test('H8 a failed manual cut reports ManualCompactionError and still leaves no partial log', async () => {
  const session = buildSession(9, { openLast: false });
  const before = session.events.length;
  const { engine } = engineFor({
    archiveDir: caseDir('archive'),
    engineDeps: {
      archiveWriter: () => {
        throw new Error('permission denied');
      },
    },
  });
  await assert.rejects(
    engine.compactNow(makeAgent(session), new AbortController().signal),
    (error) => error instanceof MockManualCompactionError && error.code === 'summary',
  );
  assert.equal(session.events.length, before);
});

test('H9 an unbalanced host boundary blocks the cut before any write', async () => {
  const session = buildSession(9, { openLast: true });
  const before = session.events.length;
  const { engine } = engineFor({
    archiveDir: caseDir('archive'),
    engineDeps: { toolPairingBalancedAfter: () => false },
  });
  const result = await engine.compactIfNeeded(makeAgent(session), 'pressure', new AbortController().signal);
  assert.equal(result, null);
  assert.equal(session.events.length, before);
  assert.equal(pointerEvents(session).length, 0);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('H10 three consecutive manual cuts: one cut, then two honest nulls', async () => {
  const dir = caseDir('archive');
  const session = buildSession(7, { openLast: false });
  const { engine } = engineFor({ archiveDir: dir });
  const agent = makeAgent(session);

  const first = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(first);
  const afterFirstEvents = session.events.length;
  const afterFirstSurface = [...session.surface.nodes];
  const second = await engine.compactNow(agent, new AbortController().signal);
  const third = await engine.compactNow(agent, new AbortController().signal);
  assert.equal(second, null);
  assert.equal(third, null);
  assert.equal(session.events.length, afterFirstEvents, 'no-op cuts append nothing');
  assert.deepEqual(session.surface.nodes, afterFirstSurface);
  assert.equal(pointerEvents(session).length, 1);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length, 1);
});

test('H11 automatic compaction refuses to run between turns', async () => {
  const session = buildSession(9, { openLast: false });
  const { engine } = engineFor({ archiveDir: caseDir('archive') });
  const result = await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal);
  assert.equal(result, null);
  assert.equal(pointerEvents(session).length, 0);
  // The same session is still cuttable manually (idle, standalone transaction).
  const manual = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(manual);
});

// ---------------------------------------------------------------------------
// Entry fallback / coexistence
// ---------------------------------------------------------------------------

const HOST_DIR = path.join(TMP, 'host-stubs');
fs.mkdirSync(HOST_DIR, { recursive: true });

const fixtureCompaction = path.join(HOST_DIR, 'compaction.mjs');
fs.writeFileSync(fixtureCompaction, `
export class CompactionEngine {
  constructor(ctx) {
    if (process.env.DSH_HT_BASE_FAIL === '1') throw new Error('fixture base refused');
    this.ctx = ctx;
    this.name = 'compaction';
    ctx.reflect.store[Symbol.for('fixture-compaction')] = this;
  }
}
export const CompactionId = (id) => id;
export class ManualCompactionError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'ManualCompactionError'; this.code = code; }
}
export const compactCheckpointSource = (compactionId, sourceCommandId) => ({
  kind: 'plugin', plugin: 'compact', compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
});
export const isCompactCheckpointSource = (source) => source?.kind === 'plugin' && source?.plugin === 'compact';
export const toolPairingBalancedBefore = () => true;
export const toolPairingBalancedAfter = () => true;
`, 'utf8');

const fixtureLlm = path.join(HOST_DIR, 'llm.mjs');
fs.writeFileSync(fixtureLlm, `
export const createUserMessage = (input) => ({ id: 'fixture-user', role: 'user', content: input.content, source: input.source });
`, 'utf8');

const fixtureStock = path.join(HOST_DIR, 'stock.mjs');
fs.writeFileSync(fixtureStock, `
export class BasicCompactionEngine {
  constructor(ctx, config) {
    if (process.env.DSH_HT_STOCK_FAIL === '1') throw new Error('fixture stock refused');
    this.ctx = ctx;
    this.name = 'compaction';
    this.kind = 'stock';
    this.config = config;
    ctx.reflect.store.compaction = this;
  }
}
`, 'utf8');

process.env.DSH_HOT_TRUNCATE_HOST_COMPACTION = pathToFileURL(fixtureCompaction).href;
process.env.DSH_HOT_TRUNCATE_HOST_LLM = pathToFileURL(fixtureLlm).href;
process.env.DSH_HOT_TRUNCATE_HOST_STOCK = pathToFileURL(fixtureStock).href;
process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT = '0';

const ENTRY_URL = pathToFileURL(path.join(ROOT, 'src', 'compaction', 'entry.js')).href;
let entryCase = 0;
async function loadEntry() {
  entryCase += 1;
  return import(`${ENTRY_URL}?case=${entryCase}`);
}

function freshCtx() {
  return new MockCtx(makeMeter(500));
}

test('H12 entry: an engine constructor throw releases ctx.compaction and falls back to stock', async () => {
  process.env.DSH_HT_BASE_FAIL = '1';
  try {
    const { default: Entry } = await loadEntry();
    const ctx = freshCtx();
    const instance = new Entry(ctx, { hotTruncate: { mode: 'cut', retainTurns: 6, retainTokens: 0 } });
    assert.equal(instance.kind, 'stock');
    assert.equal(ctx.store.compaction, instance);
    assert.match(ctx.text('warn'), /回退 stock 压缩/);
  } finally {
    delete process.env.DSH_HT_BASE_FAIL;
  }
});

test('H13 entry: an unloadable engine also falls back to stock', async () => {
  process.env.DSH_HOT_TRUNCATE_ENGINE_FAIL = 'import';
  try {
    const { default: Entry } = await loadEntry();
    const ctx = freshCtx();
    const instance = new Entry(ctx, { hotTruncate: { mode: 'cut' } });
    assert.equal(instance.kind, 'stock');
    assert.match(ctx.text('warn'), /回退 stock 压缩/);
  } finally {
    delete process.env.DSH_HOT_TRUNCATE_ENGINE_FAIL;
  }
});

test('H14 entry: mode=off hands the session back to stock', async () => {
  const { default: Entry } = await loadEntry();
  const ctx = freshCtx();
  const instance = new Entry(ctx, { hotTruncate: { mode: 'off' } });
  assert.equal(instance.kind, 'stock');
  assert.equal(instance.config.auto, true, 'stock automatic compaction stays on');
});

test('H15 entry: live-compact wins by default (gate service probe)', async () => {
  const previous = process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT;
  delete process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT;
  try {
    const { default: Entry } = await loadEntry();
    const ctx = freshCtx();
    ctx.services.liveCompactPresetGate = {};
    const instance = new Entry(ctx, { hotTruncate: { mode: 'cut' } });
    assert.equal(ctx.store.compaction, undefined, 'nothing took the compaction slot');
    assert.notEqual(instance?.kind, 'stock');
    assert.match(ctx.text(), /检测到 live-compact/);
    assert.match(ctx.text(), /热截断让位/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT;
    else process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT = previous;
  }
});

test('H16 entry: a profile mentioning compaction-spine is detected even when it is not loaded yet', async () => {
  const home = caseDir('fake-home');
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: compaction-spine\n', 'utf8');
  const previousHome = process.env.DSH_HOME;
  const previousOverride = process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT;
  process.env.DSH_HOME = home;
  delete process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT;
  try {
    const { default: Entry } = await loadEntry();
    const ctx = freshCtx();
    const instance = new Entry(ctx, { hotTruncate: { mode: 'cut' } });
    assert.equal(ctx.store.compaction, undefined);
    assert.notEqual(instance?.kind, 'stock');
    assert.match(ctx.text(), /检测到 live-compact/);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousOverride === undefined) process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT = '0';
    else process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT = previousOverride;
  }
});

test('H17 entry: stock also failing degrades to a no-op plugin, never a throw', async () => {
  process.env.DSH_HT_BASE_FAIL = '1';
  process.env.DSH_HT_STOCK_FAIL = '1';
  try {
    const { default: Entry } = await loadEntry();
    const ctx = freshCtx();
    assert.doesNotThrow(() => {
      const instance = new Entry(ctx, { hotTruncate: { mode: 'cut' } });
      assert.equal(ctx.store.compaction, undefined);
      assert.ok(instance);
    });
    assert.match(ctx.text('warn'), /不接管压缩/);
  } finally {
    delete process.env.DSH_HT_BASE_FAIL;
    delete process.env.DSH_HT_STOCK_FAIL;
  }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('H18 config normalization rejects impossible windows and keeps the documented defaults', () => {
  assert.equal(normalizeOptions({}).retainTurns, 4);
  assert.equal(normalizeOptions({}).retainTokens, 8000);
  assert.equal(normalizeOptions({}).autoMinTokens, 300000);
  assert.equal(normalizeOptions({}).mode, 'cut');
  assert.equal(normalizeOptions({ hotTruncate: { mode: 'auto' } }).mode, 'auto');
  assert.throws(() => normalizeOptions({ hotTruncate: { mode: 'sometimes' } }), /mode must be one of/);
  assert.throws(() => normalizeOptions({ hotTruncate: { retainTurns: -1 } }), /retainTurns/);
  assert.throws(() => normalizeOptions({ hotTruncate: { retainTokens: 1.5 } }), /retainTokens/);
});

test('H19 pointer text is stable and contains the three required facts', () => {
  const text = buildPointerText({
    totalTurns: 12, archivedTurns: 4, firstTurn: 1, lastTurn: 2, cutTurnCount: 2,
    shadowedTokenCount: 900, surfaceEventCount: 4, eventCount: 10,
    archivePath: '/memory/.longlive/hot-truncate/x.jsonl', sha256: 'a'.repeat(64),
    retainTurns: 6, retainTokens: 8000, retainedTurns: 8,
  });
  assert.match(text, /本会话共 12 轮，其中 4 轮已压缩归档/);
  assert.match(text, /session_original\(turn=…\)/);
  assert.match(text, /\/memory\/\.longlive\/hot-truncate\/x\.jsonl/);
  assert.equal(text, buildPointerText({
    totalTurns: 12, archivedTurns: 4, firstTurn: 1, lastTurn: 2, cutTurnCount: 2,
    shadowedTokenCount: 900, surfaceEventCount: 4, eventCount: 10,
    archivePath: '/memory/.longlive/hot-truncate/x.jsonl', sha256: 'a'.repeat(64),
    retainTurns: 6, retainTokens: 8000, retainedTurns: 8,
  }));
});

test('H25 overflow recovery retries only after the surface actually changed', async () => {
  const session = buildSession(9, { openLast: true });
  const { engine, ctx } = engineFor({ archiveDir: caseDir('archive') });
  const handler = ctx.handlers.get('agent/request-error')?.[0];
  assert.ok(handler, 'request-error recovery handler registered');
  const next = () => 'next';
  const agent = makeAgent(session);
  const signal = new AbortController().signal;
  const first = await handler({ agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal }, next);
  assert.deepEqual(first, { kind: 'retry' });
  assert.equal(pointerEvents(session).length, 1);
  // Nothing left beyond the retention window: no surface change, preserve the
  // host's original error by falling through.
  const second = await handler({ agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal }, next);
  assert.equal(second, 'next');
});

test('H24 mode=auto registers an idle trigger and only cuts above autoMinTokens', async () => {
  const session = buildSession(9, { openLast: false });
  const { engine, ctx } = engineFor({ mode: 'auto', autoMinTokens: 0, archiveDir: caseDir('archive') });
  assert.ok((ctx.handlers.get('agent/status')?.length ?? 0) >= 1, 'idle handler registered');
  await engine.autoCut(makeAgent(session));
  assert.equal(pointerEvents(session).length, 1);

  const below = buildSession(9, { openLast: false });
  const second = engineFor({ mode: 'auto', autoMinTokens: 10_000_000, archiveDir: caseDir('archive') }).engine;
  await second.autoCut(makeAgent(below));
  assert.equal(pointerEvents(below).length, 0, 'below autoMinTokens the idle path is a no-op');
});

test('H21 the archive directory follows memoryRoot when archiveDir is unset', async () => {
  const root = caseDir('memory-root');
  const session = buildSession(9, { openLast: false });
  const { engine } = engineFor({ archiveDir: '', memoryRoot: root });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result);
  const dir = path.join(root, '.longlive', 'hot-truncate');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  assert.ok(result.summary[0].text.includes(dir), 'pointer names the memory-root archive');
});

test('H22 entry: an existing compaction registration is never stolen', async () => {
  const previous = process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT;
  delete process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT;
  try {
    const { default: Entry } = await loadEntry();
    const ctx = freshCtx();
    const existing = { name: 'compaction', kind: 'someone-else' };
    ctx.services.compaction = existing;
    const instance = new Entry(ctx, { hotTruncate: { mode: 'cut' } });
    assert.equal(ctx.services.compaction, existing);
    assert.notEqual(instance?.kind, 'stock');
    assert.match(ctx.text(), /已有压缩引擎/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT;
    else process.env.DSH_HOT_TRUNCATE_LIVE_COMPACT = previous;
  }
});

test('H23 longlive foldSurface resolves replacement spans positionally (inverted seqs)', () => {
  // A replace inserts its node at the first node's POSITION, so after one
  // replacement the next span can name start > end numerically. The old
  // numeric-range fold would leave the first pointer visible.
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: {} },
    { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: {} },
    { seq: 3, type: 'turn/end', data: { turn: 1 } },
    { seq: 4, type: 'user/message', surfaceOp: { op: 'replace', start: 1, end: 2 }, data: {} },
    { seq: 5, type: 'user/message', surfaceOp: 'append', data: {} },
    { seq: 6, type: 'user/message', surfaceOp: { op: 'replace', start: 4, end: 5 }, data: {} },
  ];
  assert.deepEqual(foldSurface(events).map((node) => node.seq), [6]);
});

test('H20 direct writeArchive is atomic and leaves no tmp file', () => {
  const dir = caseDir('archive-direct');
  const session = buildSession(3, { openLast: false });
  const table = {
    events: session.events,
    bySeq: new Map(session.events.map((event) => [event.seq, event])),
    turnOfSeq: new Map(session.events.map((event) => [event.seq, 1])),
  };
  const plan = {
    archiveEvents: session.events.slice(0, 4),
    shadowedSeqs: [1, 2],
    cutTurns: [{ turn: 1, firstSeq: 1, lastSeq: 2, startSeq: 0, endSeq: 3, surfaceEvents: 2, tokens: 10 }],
  };
  const result = writeArchive({ dir, table, plan, compactionId: 'abc12345-0000', sessionId: 's-1', now: Date.UTC(2026, 10, 6, 1, 2, 3, 4) });
  assert.ok(fs.existsSync(result.path));
  assert.equal(path.dirname(result.path), dir);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0);
  const parsed = readArchive(result.path);
  assert.equal(parsed.header.sessionId, 's-1');
  assert.equal(parsed.records.length, 4);
});

// ---------------------------------------------------------------------------
// 1.6.4 frequency defaults: 300k trigger / keep 4 turns
// ---------------------------------------------------------------------------

test('H30 default autoMinTokens: 299k does not cut, 300k does', async () => {
  // 20 completed turns x 2 surface nodes = 40 priced nodes.
  const below = buildSession(20, { openLast: false });
  const under = engineFor({ useDefaults: true, mode: 'auto', perEvent: 7475, archiveDir: caseDir('archive') });
  await under.engine.autoCut(makeAgent(below));
  assert.equal(pointerEvents(below).length, 0, '299000 < 300000: the idle gate is a no-op');

  const at = buildSession(20, { openLast: false });
  const dir = caseDir('archive');
  const reach = engineFor({ useDefaults: true, mode: 'auto', perEvent: 7500, archiveDir: dir });
  await reach.engine.autoCut(makeAgent(at));
  assert.equal(pointerEvents(at).length, 1, '300000 >= 300000: exactly one cut');
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length, 1);
});

test('H34 default pressure gate: 299k does not cut, 300k cuts', async () => {
  // 20 completed turns x 2 surface nodes, plus an open turn with no surface
  // nodes so the automatic (pre-step) path is allowed to run.
  const below = buildSession(20, { openLast: false });
  addTurn(below, 21, { open: true, surface: false });
  const under = engineFor({ useDefaults: true, perEvent: 7475, archiveDir: caseDir('archive') });
  const skipped = await under.engine.compactIfNeeded(makeAgent(below), 'pressure', new AbortController().signal);
  assert.equal(skipped, null, '299000 < 300000: the per-step path is a no-op');
  assert.equal(pointerEvents(below).length, 0);

  const at = buildSession(20, { openLast: false });
  addTurn(at, 21, { open: true, surface: false });
  const reach = engineFor({ useDefaults: true, perEvent: 7500, archiveDir: caseDir('archive') });
  const cut = await reach.engine.compactIfNeeded(makeAgent(at), 'pressure', new AbortController().signal);
  assert.ok(cut, '300000 >= 300000: the per-step path cuts');
  assert.equal(pointerEvents(at).length, 1);
});

test('H31 default retainTurns=4 keeps exactly the last four completed turns', async () => {
  const session = buildSession(12, { openLast: false });
  const { engine } = engineFor({ useDefaults: true, perEvent: 1500, archiveDir: caseDir('archive') });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result);
  const pointer = session.events[result.summarySeq + 1];
  assert.equal(pointer.data.source.hotTruncate.cutTurns.length, 8);
  assert.equal(pointer.data.source.hotTruncate.retainTurns, 4);
  assert.equal(session.surface.nodes.length, 1 + 4 * 2, 'pointer + the last four completed turns');
  assert.match(pointer.data.content[0].text, /本次保留 4 轮/);
  assert.match(pointer.data.content[0].text, /保留窗口：最近 4 个已完成轮、至少 8000 tokens/);
});

test('H32 one cut writes one archive whose cutTurns spans several turns', async () => {
  const session = buildSession(12, { openLast: false });
  const dir = caseDir('archive');
  const { engine } = engineFor({ useDefaults: true, perEvent: 1500, archiveDir: dir });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result);
  assert.equal(pointerEvents(session).length, 1, 'one cut = one pointer');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1, 'one cut = one archive');
  const pointer = session.events[result.summarySeq + 1];
  const cutTurns = pointer.data.source.hotTruncate.cutTurns;
  assert.deepEqual(cutTurns, [1, 2, 3, 4, 5, 6, 7, 8], 'a single cut spans several turns');
  const parsed = readArchive(path.join(dir, files[0]));
  assert.equal(parsed.header.cutTurns.length, 8, 'the archive header records every cut turn');
  assert.equal(parsed.header.eventCount, parsed.records.length);
});

test('H33 explicit legacy retainTurns=6 / autoMinTokens=30000 still win over the defaults', async () => {
  const explicit = normalizeOptions({ hotTruncate: { retainTurns: 6, autoMinTokens: 30000 } });
  assert.equal(explicit.retainTurns, 6);
  assert.equal(explicit.autoMinTokens, 30000);
  assert.equal(explicit.retainTokens, 8000);
  assert.equal(explicit.mode, 'cut');

  const session = buildSession(12, { openLast: false });
  const { engine } = engineFor({
    retainTurns: 6,
    autoMinTokens: 30000,
    perEvent: 1500,
    archiveDir: caseDir('archive'),
  });
  const result = await engine.compactNow(makeAgent(session), new AbortController().signal);
  assert.ok(result);
  const pointer = session.events[result.summarySeq + 1];
  assert.equal(pointer.data.source.hotTruncate.retainTurns, 6);
  assert.match(pointer.data.content[0].text, /本次保留 6 轮/);
  assert.equal(session.surface.nodes.length, 1 + 6 * 2, 'explicit retainTurns=6 keeps six turns');

  // The explicit 30k gate also re-opens automatic cutting for a 30k session
  // that the new 300k default deliberately ignores.
  const small = buildSession(20, { openLast: false });
  const auto = engineFor({
    mode: 'auto',
    retainTurns: 6,
    autoMinTokens: 30000,
    perEvent: 750,
    archiveDir: caseDir('archive'),
  });
  await auto.engine.autoCut(makeAgent(small));
  assert.equal(pointerEvents(small).length, 1, 'explicit autoMinTokens=30000 cuts a 30k session');
});
