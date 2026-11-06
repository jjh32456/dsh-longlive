// D2 — trim oversized tool results at `tools/post-execute`.
//
// Every case runs against a fake host: a fake `exec`, a fake tool `result`, a
// fake waterfall `next()` and an injected archive writer where the failure
// path matters. No host package is imported; the seam is a plain async
// function, which is what the Cordis waterfall calls.
//
// Acceptance cases (the five D2 asks):
//   - a small output is untouched;
//   - an oversized output is replaced by head + tail + one notice line;
//   - the archived file is byte-identical to the original text;
//   - a privacy hit writes nothing and leaves a placeholder;
//   - a write failure keeps the original content (fail-open).
//
// Extras that make the seam safe: default off, skip read/error/PTC children,
// a `value` decision is never rewritten, the turn comes from the agents
// projection or the session log, and the 70 KB acceptance probe holds the
// context delta under 5 K while the path still reads the full text back.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import {
  D2_DEFAULTS,
  createTrimHandler,
  currentTurnOf,
  decideToolOutputTrim,
  formatD2Notice,
  normalizeD2Config,
  registerToolOutputTrim,
  replaceTextParts,
  splitHeadTail,
  toolOutputDir,
  toolOutputRoot,
} from '../src/tool-output.js';
import { archiveFileName } from '../src/original.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-d2-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeRoot(label) {
  const root = path.join(TMP, label);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** A fake tool execution: only the fields D2 reads, no host types. */
function makeExec({ name = 'demo_tool', callId = 'call-1', turn = 3, log = null } = {}) {
  const events = log ?? [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: {} },
  ];
  return {
    name,
    callId,
    agent: {
      session: {
        seq: events.length,
        eventAt: (seq) => events[seq],
      },
    },
  };
}

function makeResult(text, { isError = false, extra = [] } = {}) {
  return { content: [{ type: 'text', text }, ...extra], isError };
}

/** Run the real handler; the turn is resolved from the fake session log. */
function handlerFor(options = {}) {
  return createTrimHandler({
    settings: normalizeD2Config({ enabled: true, ...(options.settings ?? {}) }),
    memoryRoot: options.memoryRoot,
    currentTurn: options.currentTurn ?? ((exec) => currentTurnOf(null, exec)),
    ...(options.overrides ?? {}),
  });
}

function call(handler, exec, result) {
  return handler(exec, result, async () => ({ kind: 'accept' }));
}

test('D2 defaults: disabled, 4096 chars, read skipped, errors kept whole', () => {
  const settings = normalizeD2Config(undefined);
  assert.equal(settings.enabled, false);
  assert.equal(settings.maxInlineChars, D2_DEFAULTS.maxInlineChars);
  assert.deepEqual(settings.skipTools, ['read']);
  assert.equal(settings.trimErrors, false);

  // A typo must not create a nonsense budget.
  const clamped = normalizeD2Config({ enabled: true, maxInlineChars: 5, headRatio: 9 });
  assert.equal(clamped.maxInlineChars, 64);
  assert.equal(clamped.headRatio, 0.8);
  assert.equal(normalizeD2Config({ enabled: 'yes' }).enabled, false);
});

test('D2 off by default: registration mounts nothing', () => {
  const hooked = [];
  const ctx = {
    on: (event, handler) => { hooked.push({ event, handler }); return () => {}; },
    get: () => null,
    logger: { warn() {}, info() {} },
  };
  const status = registerToolOutputTrim(ctx, {}, { memoryRoot: makeRoot('off') });
  assert.equal(status.registered, false);
  assert.equal(hooked.length, 0);
});

test('D2 small output is untouched (identity, no archive)', async () => {
  const root = makeRoot('small');
  const decision = { kind: 'accept' };
  const handler = handlerFor({ memoryRoot: root });
  const out = await handler(makeExec({ turn: 1 }), makeResult('a short tool answer'), async () => decision);
  assert.equal(out, decision);
  assert.equal(fs.existsSync(path.join(root, '.longlive')), false);

  // Exactly at the budget: still inline, still the same decision object.
  const tight = await handlerFor({ memoryRoot: root, settings: { maxInlineChars: 64 } })(
    makeExec({ turn: 1 }),
    makeResult('x'.repeat(64)),
    async () => decision,
  );
  assert.equal(tight, decision);
});

test('D2 oversized output: head + tail + one notice line, archive written', async () => {
  const root = makeRoot('trim');
  const text = `HEAD-MARKER-${'A'.repeat(20000)}-TAIL-MARKER`;
  const out = await call(handlerFor({ memoryRoot: root }), makeExec({ turn: 3 }), makeResult(text));

  assert.equal(out.kind, 'accept');
  assert.notEqual(out, undefined);
  const inline = out.content[0].text;
  assert.ok(inline.length <= 4096 + 500, `inline ${inline.length} should stay near the budget`);
  assert.ok(inline.length < text.length, 'the inline text is much smaller than the original');
  assert.ok(inline.startsWith('HEAD-MARKER-'), 'head is kept first');
  assert.ok(inline.endsWith('-TAIL-MARKER'), 'tail is kept last');
  assert.match(inline, new RegExp(`\\[D2\\] tool output \\(demo_tool\\) trimmed: ${text.length} chars → \\d+ inline\\.`));
  assert.ok(inline.includes(`Full output (${Buffer.byteLength(text, 'utf8')} bytes) saved at `));

  const file = path.join(toolOutputDir(root, 3), 'call-1.txt');
  assert.ok(fs.existsSync(file), 'archive path is the D3 convention');
  assert.ok(inline.includes(file), 'the notice prints the path');
  assert.ok(inline.includes('session_original(turn=3, toolCallId="call-1")'));
});

test('D2 archive is byte-identical to the original text', async () => {
  const root = makeRoot('bytes');
  const text = '日本語テキスト\n'.repeat(4000) + '尾部';
  await call(handlerFor({ memoryRoot: root }), makeExec({ name: 'grep', callId: 'call-9', turn: 2 }), makeResult(text));
  const file = path.join(toolOutputDir(root, 2), archiveFileName({ kind: 'tool', toolCallId: 'call-9' }));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.statSync(file).size, Buffer.byteLength(text, 'utf8'));
});

test('D2 privacy hit writes nothing and leaves a placeholder', async () => {
  const root = makeRoot('privacy');
  const text = 'customer record: phone 13800138000\n' + 'x'.repeat(9000);
  const out = await call(
    handlerFor({
      memoryRoot: root,
      overrides: { scan: () => ({ verdict: 'local_only', reasons: ['phone'], spans: [] }) },
    }),
    makeExec({ turn: 4 }),
    makeResult(text),
  );
  const inline = out.content[0].text;
  assert.match(inline, new RegExp(`withheld: ${text.length} chars matched the privacy gate \\(phone\\)`));
  assert.ok(!inline.includes('13800138000'), 'a flagged value is never echoed');
  assert.equal(fs.existsSync(path.join(root, '.longlive')), false, 'nothing is written');
  assert.ok(!inline.includes('.longlive'), 'no path is advertised');
});

test('D2 write failure is fail-open: original decision survives', async () => {
  const root = makeRoot('eacces');
  const text = 'y'.repeat(9000);
  const decision = { kind: 'accept' };
  const handler = handlerFor({
    memoryRoot: root,
    overrides: {
      writeArchive: () => {
        const error = new Error('EACCES: permission denied, open archive');
        error.code = 'EACCES';
        throw error;
      },
    },
  });
  const out = await handler(makeExec({ turn: 5 }), makeResult(text), async () => decision);
  assert.equal(out, decision, 'the untouched decision is returned');
  assert.equal(fs.readdirSync(root).filter((name) => name.includes('tmp-')).length, 0, 'no tmp file is left behind');
});

test('D2 next() failure propagates untouched', async () => {
  const handler = handlerFor({ memoryRoot: makeRoot('next-fail') });
  const boom = new Error('below-seam failure');
  await assert.rejects(
    handler(makeExec({ turn: 1 }), makeResult('z'.repeat(9000)), async () => { throw boom; }),
    boom,
  );
});

test('D2 skips read, errors, PTC children and value decisions', async () => {
  const root = makeRoot('skips');
  const big = () => makeResult('q'.repeat(9000));
  const cases = [
    ['read', makeExec({ name: 'read', turn: 1 }), big(), { kind: 'accept' }],
    ['error result', makeExec({ name: 'demo', turn: 1 }), makeResult('e'.repeat(9000), { isError: true }), { kind: 'accept' }],
    ['ptc child', { ...makeExec({ turn: 1 }), parent: {} }, big(), { kind: 'accept' }],
    ['value decision', makeExec({ name: 'demo', turn: 1 }), big(), { kind: 'accept', value: { ok: true } }],
    ['blocked decision', makeExec({ name: 'demo', turn: 1 }), big(), { kind: 'block', feedback: 'nope' }],
  ];
  for (const [label, exec, result, decision] of cases) {
    const out = await handlerFor({ memoryRoot: root })(exec, result, async () => decision);
    assert.equal(out, decision, `${label} must be untouched`);
  }
  assert.equal(fs.existsSync(path.join(root, '.longlive')), false);

  // trimErrors is the documented opt-out from the error exemption.
  const out = await call(
    handlerFor({ memoryRoot: root, settings: { skipTools: [], trimErrors: true, maxInlineChars: 64 } }),
    makeExec({ name: 'demo', turn: 1 }),
    makeResult('e'.repeat(5000), { isError: true }),
  );
  assert.match(out.content[0].text, /\[D2\] tool output/);
});

test('D2 turn resolution: agents projection first, session log as fallback, null keeps content', () => {
  const events = [
    { type: 'turn/start', data: { turn: 7 } },
    { type: 'tool/result', data: {} },
    { type: 'turn/start', data: { turn: 8 } },
  ];
  const exec = makeExec({ log: events });

  // 1. the agents service's turnBoundary projection wins;
  const projectionCtx = { get: (name) => (name === 'agents' ? { turnBoundaryOf: () => ({ lastTurn: 42 }) } : null) };
  assert.equal(currentTurnOf(projectionCtx, exec), 42);

  // 2. without it, the newest turn/start in the session log answers;
  assert.equal(currentTurnOf(null, exec), 8);

  // 3. a session with no turn/start yields null, and null keeps the content inline.
  const orphan = makeExec({ log: [{ type: 'user/message', data: {} }] });
  assert.equal(currentTurnOf(null, orphan), null);
  const decision = { kind: 'accept' };
  const outcome = decideToolOutputTrim({
    exec: orphan,
    result: makeResult('w'.repeat(9000)),
    decision,
    settings: normalizeD2Config({ enabled: true }),
    memoryRoot: makeRoot('turn'),
    turn: currentTurnOf(null, orphan),
  });
  assert.equal(outcome.action, 'keep');
  assert.equal(outcome.decision, decision);
});

test('D2 keeps non-text parts and never splits a surrogate pair', async () => {
  const root = makeRoot('parts');
  const image = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
  const out = await call(
    handlerFor({ memoryRoot: root }),
    makeExec({ name: 'screenshot', callId: 'call-img', turn: 6 }),
    makeResult('s'.repeat(9000), { extra: [image] }),
  );
  assert.equal(out.content.length, 2);
  assert.equal(out.content[1], image);
  assert.match(out.content[0].text, /\[D2\]/);

  const split = splitHeadTail('😀'.repeat(5000), 100, 0.5);
  assert.equal(split.trimmed, true);
  assert.ok(split.omittedChars > 0);
  assert.doesNotThrow(() => Buffer.from(split.head + split.tail, 'utf8'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(split.head), 'head does not end on a lone high surrogate');
  assert.ok(!/^[\uDC00-\uDFFF]/.test(split.tail), 'tail does not start on a lone low surrogate');
});

test('D2 acceptance probe: 70 KB JSON output costs ≤5 K inline and reads back whole', async () => {
  const root = makeRoot('probe-70k');
  const payload = JSON.stringify({
    items: Array.from({ length: 1800 }, (_, index) => ({ id: index, name: `row-${index}`, tags: ['alpha', 'beta'] })),
  });
  assert.ok(payload.length >= 70000, `probe payload is ${payload.length} chars`);

  const decision = { kind: 'accept' };
  const out = await handlerFor({ memoryRoot: root })(
    makeExec({ name: 'query_db', callId: 'call-70k', turn: 11 }),
    makeResult(payload),
    async () => decision,
  );

  const inline = out.content[0].text;
  assert.ok(inline.length <= 5120, `context delta ${inline.length} must be ≤ 5120 chars`);
  assert.ok(inline.length < payload.length / 10, 'the context grows by an order of magnitude less');

  const file = path.join(toolOutputDir(root, 11), 'call-70k.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), payload, 'the whole 70 KB reads back from the path');
  assert.ok(inline.includes(file));
});

test('D2 registration wires the seam and disposes with the plugin scope', () => {
  const hooked = [];
  const disposed = [];
  const ctx = {
    on: (event, handler) => {
      hooked.push({ event, handler });
      return () => disposed.push(`dispose:${event}`);
    },
    get: () => null,
    effect: (factory) => {
      const disposer = factory();
      disposed.push(`effect:${typeof disposer}`);
    },
    logger: { warn() {}, info() {} },
  };
  const root = makeRoot('register');
  const status = registerToolOutputTrim(ctx, { d2: { enabled: true, maxInlineChars: 512 } }, { memoryRoot: root });
  assert.equal(status.registered, true);
  assert.equal(status.settings.maxInlineChars, 512);
  assert.equal(hooked.length, 1);
  assert.equal(hooked[0].event, 'tools/post-execute');
  assert.equal(status.archiveRoot, toolOutputRoot(root));
  assert.deepEqual(disposed, ['effect:function']);
});

test('D2 applies through the plugin entry: d2.enabled mounts on tools/post-execute', async () => {
  const home = makeRoot('apply-home');
  const memoryRoot = path.join(home, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  const hooked = [];
  const ctx = {
    tools: { register: () => () => {} },
    on: (event, handler) => {
      hooked.push({ event, handler });
      return () => {};
    },
    get: () => null,
    effect: () => {},
    logger: { warn() {}, info() {} },
  };
  const { apply } = await import('../src/index.js');
  await apply(ctx, {
    home,
    memoryRoot,
    env: {},
    heartbeatMs: 0,
    recoverOnStart: false,
    defineTool: (definition) => definition,
    routerRuntime: 'off',
    d2: { enabled: true, maxInlineChars: 256 },
  });
  const seam = hooked.find((entry) => entry.event === 'tools/post-execute');
  assert.ok(seam, 'd2.enabled must register a tools/post-execute listener');

  const events = [{ type: 'turn/start', data: { turn: 4 } }];
  const exec = {
    name: 'query_db',
    callId: 'call-apply',
    agent: { session: { seq: 1, eventAt: (seq) => events[seq] } },
  };
  const payload = 'P'.repeat(9000);
  const out = await seam.handler(exec, makeResult(payload), async () => ({ kind: 'accept' }));
  const inline = out.content[0].text;
  assert.ok(inline.length <= 256 + 500, `inline ${inline.length} near the configured budget`);
  assert.ok(fs.existsSync(path.join(toolOutputDir(memoryRoot, 4), 'call-apply.txt')));
  assert.equal(fs.readFileSync(path.join(toolOutputDir(memoryRoot, 4), 'call-apply.txt'), 'utf8'), payload);
});

test('D2 notice and text replacement keep the no-call-id shape readable', () => {
  const notice = formatD2Notice({
    chars: 9000,
    inlineChars: 4096,
    bytes: 9000,
    file: 'C:\\m\\.longlive\\tool-output\\2\\c.txt',
    turn: null,
    callId: '',
    toolName: 'demo',
  });
  assert.ok(notice.startsWith('[D2] tool output (demo) trimmed: 9000 chars → 4096 inline.'));
  assert.ok(!notice.includes('session_original'), 'no call id, no read-back hint');

  const content = replaceTextParts(
    [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
    'merged',
  );
  assert.deepEqual(content, [{ type: 'text', text: 'merged' }, { type: 'image' }]);
});
