// RC gate: every 0.9.0-rc.1 capability is opt-in, and turning one on must not
// turn on another. The baseline contract is captured in
// test/fixtures/baseline-0.8.0-registration.json: the 0.8.0 registration shape
// plus D3's session_original (22nd tool), regenerated from the merged
// 1.4.0-rc.3 tree with all flags off (see the fixture's provenance field).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeFeatureConfig, resolveCardPath } from '../src/features.js';
import { MESSAGE_TYPES, encodeSession, foldSurface, parseSession, sha256 } from '../src/codec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'baseline-0.8.0-registration.json'), 'utf8'));
const { apply } = await import('../src/index.js');

function projectTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? null,
    hasExecute: typeof tool.execute === 'function',
  };
}

function projectHooks(hooks) {
  return hooks.map(({ name, prepend, priority }) => ({ name, prepend, priority: priority ?? null }));
}

function treeOf(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(`${rel}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return out;
}

function interestingFeaturePath(value) {
  const text = String(value).replaceAll('\\', '/');
  return /STATE\.md|\.longlive\/bus|\/topics\/|\/handover\/|recall|presence/i.test(text);
}

function runPackage(config = {}, options = {}) {
  const temp = options.temp ? path.resolve(options.temp) : fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-flags-'));
  const home = options.home ?? path.join(temp, 'home');
  const memoryRoot = options.memoryRoot ?? path.join(temp, 'memory');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  if (typeof options.prepare === 'function') options.prepare({ temp, home, memoryRoot });

  const hooks = [];
  const tools = [];
  const warnings = [];
  const infos = [];
  const featureReads = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    on(name, listener, hookOptions) {
      hooks.push({ name, listener, prepend: hookOptions?.prepend === true, priority: hookOptions?.priority ?? null });
      return () => {};
    },
    logger() {
      return {
        warn: (message) => warnings.push(String(message)),
        info: (message) => infos.push(String(message)),
      };
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };

  const originals = new Map();
  const record = (name) => {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = function instrumented(target, ...rest) {
      if (interestingFeaturePath(target)) featureReads.push(`${name}:${path.resolve(String(target))}`);
      return original.call(fs, target, ...rest);
    };
  };
  if (options.instrumentReads !== false) {
    for (const name of ['readFileSync', 'readdirSync', 'statSync', 'existsSync', 'openSync']) record(name);
  }

  let returned;
  try {
    returned = apply(ctx, {
      home,
      memoryRoot,
      env: {},
      heartbeatMs: 0,
      recoverOnStart: false,
      defineTool: (definition) => definition,
      routerRuntime: 'off',
      // D1/D4 metrics is an independent default-on listener; this suite is the
      // frozen 0.8.0 feature-flag contract, so isolate it here unless a test
      // explicitly turns it on.
      metrics: false,
      ...config,
    });
  } finally {
    for (const [name, original] of originals) fs[name] = original;
  }

  const snapshot = {
    returned: JSON.parse(JSON.stringify(returned ?? null)),
    toolCount: tools.length,
    tools: tools.map(projectTool),
    hooks: projectHooks(hooks),
    warnings,
    infos,
    featureReads,
    memoryTree: treeOf(memoryRoot),
    temp,
    home,
    memoryRoot,
  };
  return { ...snapshot, rawHooks: hooks, ctx };
}

function cleanup(result) {
  try {
    fs.rmSync(result.temp, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
}

test('defaults: all five capabilities are off and documented values are exact', () => {
  assert.deepEqual(normalizeFeatureConfig({}), {
    autoRecall: { enabled: false, topK: 3, budgetTokens: 2000, everyNTurns: 6, createUserMessage: undefined },
    identityCard: { enabled: false, path: '<memoryRoot>/STATE.md', maxChars: 800, createUserMessage: undefined },
    presenceBus: { enabled: false, pollMs: 3000, root: undefined },
    autoMaintenance: {
      enabled: false,
      consolidate: true,
      forget: true,
      runOnStart: true,
      startDelayMs: 500,
    },
  });
  assert.equal(resolveCardPath('<memoryRoot>/STATE.md', 'C:/mem'), path.resolve('C:/mem/STATE.md'));
  assert.equal(resolveCardPath('cards/STATE.md', 'C:/mem'), path.resolve('C:/mem/cards/STATE.md'));
  assert.equal(resolveCardPath('<memoryRoot>/STATE.md', null), null);
});

test('clamps: hostile values stay in range instead of changing behavior', () => {
  const cfg = normalizeFeatureConfig({
    autoRecall: { enabled: 'yes', topK: 99, budgetTokens: 1, everyNTurns: 0 },
    identityCard: { enabled: 1, maxChars: 1 },
    presenceBus: { enabled: true, pollMs: -5 },
  });
  assert.equal(cfg.autoRecall.enabled, false);
  assert.equal(cfg.autoRecall.topK, 10);
  assert.equal(cfg.autoRecall.budgetTokens, 200);
  assert.equal(cfg.autoRecall.everyNTurns, 1);
  assert.equal(cfg.identityCard.enabled, false);
  assert.equal(cfg.identityCard.maxChars, 120);
  assert.equal(cfg.presenceBus.enabled, true);
  assert.equal(cfg.presenceBus.pollMs, 0);
});

test('flags off: byte-identical tool table, hook set and startup side effects to 0.8.0', (t) => {
  const result = runPackage({});
  t.after(() => cleanup(result));

  assert.equal(result.toolCount, BASELINE.toolCount);
  assert.deepEqual(result.tools, BASELINE.tools);
  assert.deepEqual(result.hooks, BASELINE.hooks);
  assert.deepEqual(result.returned, BASELINE.returned);
  assert.deepEqual(result.warnings, BASELINE.warnings);
  assert.deepEqual(result.infos, []);
  assert.deepEqual(result.featureReads, []);
  assert.deepEqual(result.memoryTree, []);
});

test('identityCard on: only one prepended pre-step hook, no recall/bus hooks', (t) => {
  const result = runPackage({ identityCard: { enabled: true, path: '<memoryRoot>/STATE.md' } });
  t.after(() => cleanup(result));

  assert.deepEqual(result.tools, BASELINE.tools);
  assert.deepEqual(result.hooks, [
    ...BASELINE.hooks,
    { name: 'agent/pre-step', prepend: true, priority: null },
  ]);
  assert.deepEqual(result.featureReads, []);
  assert.deepEqual(result.memoryTree, []);
});

test('autoRecall on: only its pre-step + session/event + session/disposed hooks', (t) => {
  const result = runPackage({ autoRecall: { enabled: true } });
  t.after(() => cleanup(result));

  assert.deepEqual(result.tools, BASELINE.tools);
  assert.deepEqual(result.hooks, [
    ...BASELINE.hooks,
    { name: 'agent/pre-step', prepend: false, priority: null },
    { name: 'session/event', prepend: false, priority: null },
    { name: 'session/disposed', prepend: false, priority: null },
  ]);
  assert.deepEqual(result.featureReads, []);
  assert.deepEqual(result.memoryTree, []);
});

test('presenceBus on: only one extra session/event hook', (t) => {
  const result = runPackage({ presenceBus: { enabled: true } });
  t.after(() => cleanup(result));

  assert.deepEqual(result.tools, BASELINE.tools);
  assert.deepEqual(result.hooks, [
    ...BASELINE.hooks,
    { name: 'session/event', prepend: false, priority: null },
  ]);
  assert.deepEqual(result.featureReads, []);
  assert.deepEqual(result.memoryTree, []);
});

test('all three on: hook multiset is the sum, no cross-activation or duplicates', (t) => {
  const result = runPackage({
    identityCard: { enabled: true },
    autoRecall: { enabled: true },
    presenceBus: { enabled: true },
  });
  t.after(() => cleanup(result));

  assert.deepEqual(result.tools, BASELINE.tools);
  assert.deepEqual(result.hooks, [
    ...BASELINE.hooks,
    { name: 'agent/pre-step', prepend: true, priority: null },
    { name: 'agent/pre-step', prepend: false, priority: null },
    { name: 'session/event', prepend: false, priority: null },
    { name: 'session/disposed', prepend: false, priority: null },
    { name: 'session/event', prepend: false, priority: null },
  ]);
  assert.deepEqual(result.featureReads, []);
  assert.deepEqual(result.memoryTree, []);
});

test('metrics on: exactly one extra session/event hook, no tool or disk side effects', (t) => {
  const result = runPackage({ metrics: { enabled: true } });
  t.after(() => cleanup(result));

  assert.deepEqual(result.tools, BASELINE.tools);
  assert.deepEqual(result.hooks, [
    ...BASELINE.hooks,
    { name: 'session/event', prepend: false, priority: null },
  ]);
  assert.deepEqual(result.featureReads, []);
  assert.deepEqual(result.memoryTree, []);
});

test('identityCard with no STATE.md leaves the pre-step result untouched', (t) => {
  const result = runPackage({ identityCard: { enabled: true } });
  t.after(() => cleanup(result));
  const hook = result.rawHooks.find((entry) => entry.name === 'agent/pre-step');
  assert.ok(hook, 'identity pre-step hook registered');

  const payload = {
    step: 1,
    agent: { session: { id: 'session-flag-test', header: { origin: 'main' } } },
    messages: [{ role: 'user', content: 'hello' }],
    context: [{ role: 'system', content: 'ctx' }],
  };
  const decision = { kind: 'enter', messages: [...payload.messages, ...payload.context] };
  const returned = hook.listener(payload, async () => decision);
  return Promise.resolve(returned).then((value) => {
    assert.equal(value, decision);
    assert.equal(payload.messages.length, 1);
  });
});

test('presenceBus consumes a completed turn into spool/acked, ignores failed turns', async (t) => {
  const busRoot = path.join(os.tmpdir(), `longlive-bus-${process.pid}-${Date.now()}`);
  const result = runPackage({ presenceBus: { enabled: true, pollMs: 0, root: busRoot } });
  t.after(() => {
    cleanup(result);
    fs.rmSync(busRoot, { recursive: true, force: true });
  });
  const hook = result.rawHooks.filter((entry) => entry.name === 'session/event').at(-1);
  assert.ok(hook, 'bus session/event hook registered');

  const { createBus } = await import('../src/bus/bus.mjs');
  const sessionId = 'session-flag-bus';
  const producer = createBus({ root: busRoot, sessionId: 'session-flag-producer' });
  producer.send({ to: sessionId, kind: 'note', body: 'one note' });

  const session = { id: sessionId };
  hook.listener(session, { type: 'turn/end', data: { reason: { kind: 'failed' } }, turn: 1 });
  assert.deepEqual(fs.existsSync(path.join(busRoot, 'spool')), false, 'failed turn must not drain');

  hook.listener(session, { type: 'turn/end', data: { reason: { kind: 'completed' } }, turn: 2 });
  const spool = path.join(busRoot, 'spool', `${sessionId}.jsonl`);
  const lines = fs.readFileSync(spool, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.message.kind, 'note');
  assert.equal(record.message.body, 'one note');
  assert.equal(producer.poll({ since: 0 }).messages.length, 0, 'message was acked');
  assert.ok(fs.existsSync(path.join(busRoot, 'inbox', sessionId, 'acked', `${record.message.id}.json`)));

  hook.listener(session, { type: 'turn/end', data: { reason: { kind: 'completed' } }, turn: 3 });
  assert.equal(fs.readFileSync(spool, 'utf8').trim().split('\n').length, 1, 'no duplicate spool line');
});

test('M2 containment: identityCard.path 越界时根外内容不进上下文（canary）', async (t) => {
  // 红队 M2：`../`、根外绝对路径、盘符跳转必须 E_PATH_OUTSIDE_ROOT，且一个字节都不读。
  for (const bad of ['../secret.md', 'D:/outside/STATE.md', '\\\\server\\share\\STATE.md']) {
    assert.throws(
      () => resolveCardPath(bad, 'C:/mem'),
      (error) => error.code === 'E_PATH_OUTSIDE_ROOT',
      `expected E_PATH_OUTSIDE_ROOT for ${bad}`,
    );
  }

  const result = runPackage({ identityCard: { enabled: true, path: '../secret.md' } });
  t.after(() => cleanup(result));
  const secret = path.join(result.temp, 'secret.md');
  fs.writeFileSync(secret, 'TOP-SECRET-CANARY-9f3a');

  const hook = result.rawHooks.find((entry) => entry.name === 'agent/pre-step');
  assert.ok(hook, 'identity pre-step hook registered');
  const payload = {
    step: 1,
    agent: { session: { id: 'session-canary', header: { origin: 'main' } } },
    messages: [{ role: 'user', content: 'hello' }],
  };
  const decision = { kind: 'enter', messages: [...payload.messages] };

  const originalRead = fs.readFileSync;
  const readTargets = [];
  fs.readFileSync = function spy(target, ...rest) {
    readTargets.push(String(target));
    return originalRead.call(fs, target, ...rest);
  };
  let value;
  try {
    value = await hook.listener(payload, async () => decision);
  } finally {
    fs.readFileSync = originalRead;
  }

  assert.ok(!JSON.stringify(value).includes('TOP-SECRET-CANARY-9f3a'), 'canary leaked into the context');
  assert.ok(!readTargets.some((target) => target.includes('secret.md')), 'outside file must never be read');
  assert.ok(result.warnings.some((line) => /E_PATH_OUTSIDE_ROOT|越界/.test(line)), result.warnings.join('\n'));
});
// ---------------------------------------------------------------------------
// Startup receipt fallback (rc.2): visible text, one shot, zero cost if clean
// ---------------------------------------------------------------------------

function buildReceiptSession(turns) {
  const events = [];
  const base = 1_760_000_000_000;
  const push = (event) => {
    event.seq = events.length;
    event.time = base + events.length;
    events.push(event);
  };
  push({
    type: 'system/message',
    surfaceOp: 'append',
    data: {
      message: {
        role: 'system',
        id: 'system-1',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: 'system prompt' }],
      },
    },
  });
  for (let t = 1; t <= turns; t += 1) {
    push({ type: 'turn/start', data: { turn: t } });
    push({
      type: 'user/message',
      surfaceOp: 'append',
      data: { turn: t, step: 1, role: 'user', id: 'user-' + t, source: { kind: 'user' }, content: [{ type: 'text', text: 'question ' + t }] },
    });
    push({
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { turn: t, step: 1, message: { role: 'assistant', id: 'assistant-' + t, content: [{ type: 'text', text: 'answer ' + t }] } },
    });
    push({ type: 'turn/end', data: { turn: t, reason: { kind: 'completed' } } });
  }
  return encodeSession({ type: 'session', version: 4, id: 'receipt-fixture', createdAt: '2026-11-04T00:00:00.000Z', cwd: 'C:\\fixtures' }, events);
}

const receiptSnapshot = (buf) => {
  const parsed = parseSession(buf);
  return {
    bytes: buf.length,
    sha256: sha256(buf),
    events: parsed.events.length,
    messages: foldSurface(parsed.events).filter((node) => MESSAGE_TYPES.has(node.type)).length,
  };
};

test('receipt fallback: 有未写回执的手术 state 时，第一轮正文注入一条可见回执（只一次）', async () => {
  const beforeBuf = buildReceiptSession(3);
  const afterBuf = buildReceiptSession(1);
  let sessionPath = null;
  let backupPath = null;

  const result = runPackage({}, {
    prepare: ({ temp, memoryRoot }) => {
      const dir = path.join(temp, 'sessions', 'scope', 'receipt-fixture');
      fs.mkdirSync(dir, { recursive: true });
      sessionPath = path.join(dir, 'session.v4.jsonl.zstd');
      backupPath = sessionPath + '.pre-surgery-20261104-143000';
      fs.writeFileSync(sessionPath, afterBuf);
      fs.writeFileSync(backupPath, beforeBuf);
      const state = {
        version: 1,
        kind: 'longlive-surgery',
        surgeryId: 'surgery-receipt-fallback-1',
        phase: 'restart',
        sessionPath,
        sessionId: 'receipt-fixture',
        memoryRoot,
        appPath: 'C:\\app\\DSH.exe',
        keepTurns: 6,
        keepTokens: 40000,
        startDelaySeconds: 30,
        restartDelaySeconds: 0,
        pluginVersion: '0.9.0-rc.4',
        hostVersion: '0.9.0',
        dryRun: false,
        before: receiptSnapshot(beforeBuf),
        after: receiptSnapshot(afterBuf),
        backup: { path: backupPath, bytes: beforeBuf.length, sha256: sha256(beforeBuf) },
        cut: { after: receiptSnapshot(afterBuf), verify: { ok: true } },
        verify: { ok: true, method: 'independent-readback' },
        receipt: null,
        history: [],
      };
      fs.mkdirSync(path.join(memoryRoot, '.longlive'), { recursive: true });
      fs.writeFileSync(path.join(memoryRoot, '.longlive', 'surgery-state.json'), JSON.stringify(state, null, 2));
    },
  });

  try {
    const hooks = result.rawHooks.filter((hook) => hook.name === 'agent/pre-step');
    assert.equal(hooks.length, 1, 'exactly one receipt hook');
    assert.ok(result.returned?.enabled?.includes('surgeryReceipt') ?? true);

    const payload = { step: 1, agent: { session: { id: 'session-live', header: { origin: 'main' } } } };
    const decision = await hooks[0].listener(payload, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(decision.messages.length, 1);
    const message = decision.messages[0];
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'user');
    assert.match(message.id, /^surgery-receipt-/);
    const text = message.content.map((part) => part.text).join('');
    assert.match(text, /^【手术回执】/);
    assert.match(text, /成功/);
    assert.match(text, /字节：\d[\d,]* → \d[\d,]*/);
    assert.match(text, /事件：\d[\d,]* → \d[\d,]*/);
    assert.match(text, /消息：\d[\d,]* → \d[\d,]*/);
    assert.match(text, /sha256：磁盘读回与记录一致/);
    // R2-01: names only, never absolute paths.
    assert.ok(!text.includes(sessionPath), text);
    assert.ok(!text.includes(backupPath), text);
    assert.ok(!/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|opt|root|mnt)\/)/.test(text), text);
    assert.ok(text.includes(path.basename(backupPath)), text);
    assert.match(text, /回执来源：/);

    const second = await hooks[0].listener(payload, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(second.messages.length, 0, 'receipt must be injected once');

    // R2-08: the one-shot marker is persisted, not only held in this process.
    const statePath = path.join(result.memoryRoot, '.longlive', 'surgery-state.json');
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(stored.receipt.fallbackInjected, true);
    assert.notEqual(stored.receipt.written, true);
  } finally {
    cleanup(result);
  }
});

test('R2-08: a second startup sees fallbackInjected and registers no receipt hook', async () => {
  const beforeBuf = buildReceiptSession(3);
  const afterBuf = buildReceiptSession(1);
  let sessionPath = null;
  let backupPath = null;

  const first = runPackage({}, {
    prepare: ({ temp, memoryRoot }) => {
      const dir = path.join(temp, 'sessions', 'scope', 'receipt-fixture');
      fs.mkdirSync(dir, { recursive: true });
      sessionPath = path.join(dir, 'session.v4.jsonl.zstd');
      backupPath = sessionPath + '.pre-surgery-20261104-143000';
      fs.writeFileSync(sessionPath, afterBuf);
      fs.writeFileSync(backupPath, beforeBuf);
      const state = {
        version: 1,
        kind: 'longlive-surgery',
        surgeryId: 'surgery-receipt-fallback-2',
        phase: 'restart',
        sessionPath,
        sessionId: 'receipt-fixture',
        memoryRoot,
        appPath: 'C:\\app\\DSH.exe',
        keepTurns: 6,
        keepTokens: 40000,
        startDelaySeconds: 30,
        restartDelaySeconds: 0,
        pluginVersion: '0.9.0-rc.4',
        hostVersion: '0.9.0',
        dryRun: false,
        before: receiptSnapshot(beforeBuf),
        after: receiptSnapshot(afterBuf),
        backup: { path: backupPath, bytes: beforeBuf.length, sha256: sha256(beforeBuf) },
        cut: { after: receiptSnapshot(afterBuf), verify: { ok: true } },
        verify: { ok: true, method: 'independent-readback' },
        receipt: null,
        history: [],
      };
      fs.mkdirSync(path.join(memoryRoot, '.longlive'), { recursive: true });
      fs.writeFileSync(path.join(memoryRoot, '.longlive', 'surgery-state.json'), JSON.stringify(state, null, 2));
    },
  });

  try {
    const hook = first.rawHooks.find((candidate) => candidate.name === 'agent/pre-step');
    assert.ok(hook, 'first startup must offer the receipt');
    const payload = { step: 1, agent: { session: { id: 'session-live', header: { origin: 'main' } } } };
    const decision = await hook.listener(payload, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(decision.messages.length, 1);

    const second = runPackage({}, { temp: first.temp });
    assert.equal(second.rawHooks.filter((candidate) => candidate.name === 'agent/pre-step').length, 0);
    assert.ok(!(second.returned?.enabled ?? []).includes('surgeryReceipt'));
  } finally {
    cleanup(first);
  }
});

test('receipt fallback: 没有手术 state 时零副作用（不注册钩子、不读 state）', () => {
  const result = runPackage({});
  try {
    assert.equal(result.rawHooks.filter((hook) => hook.name === 'agent/pre-step').length, 0);
    assert.ok(!result.returned?.enabled?.includes('surgeryReceipt'));
  } finally {
    cleanup(result);
  }
});