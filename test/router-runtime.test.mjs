// R1 runtime adapter tests (node:test). Run with:
//   node --test test/router-runtime.test.mjs
//
// This suite is deliberately separate from test/run.mjs: the existing 18 suites
// are a hand-rolled harness, and nothing here needs to change their baseline.
//
// Every test writes only inside mkdtemp() directories: no real memory root, no
// ~/.dsh, no personal store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_RUNTIME_MODE,
  INTERCEPTED_TOOLS,
  MAX_RECORDS_DEFAULT,
  ROUTE_REFUSED_CODE,
  WRITE_TOOLS,
  buildJudgeText,
  classifyRisk,
  createRouterRuntime,
  normalizeMode,
  resolveStatePath,
} from '../src/router/runtime.js';
import { registerTools, TOOLS } from '../src/tools.js';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'router-runtime-'));
  dirs.push(dir);
  return dir;
}
function statePathIn(dir) {
  return join(dir, 'router-runtime.jsonl');
}
function readRecords(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function cleanup() {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
process.on('exit', cleanup);

// ---------------------------------------------------------------- normalize

test('modes: off is the default and unknown values never become on', () => {
  assert.equal(DEFAULT_RUNTIME_MODE, 'off');
  assert.equal(normalizeMode(undefined), 'off');
  assert.equal(normalizeMode(''), 'off');
  assert.equal(normalizeMode('SHADOW'), 'shadow');
  assert.equal(normalizeMode(' on '), 'on');
  assert.equal(normalizeMode('enabled'), 'off');
  assert.equal(normalizeMode('true'), 'off');
  assert.equal(MAX_RECORDS_DEFAULT, 1000);
  assert.deepEqual([...INTERCEPTED_TOOLS].sort(), ['memory_consolidate', 'memory_forget', 'memory_recall', 'memory_save']);
  assert.deepEqual([...WRITE_TOOLS].sort(), ['memory_consolidate', 'memory_forget', 'memory_save']);
});

test('state path: explicit wins, memory root is the fallback, neither means no sink', () => {
  assert.equal(resolveStatePath({ statePath: 'C:/tmp/x.jsonl' }).endsWith('x.jsonl'), true);
  assert.equal(resolveStatePath({ memoryRoot: 'C:/tmp/root' }).endsWith('router-runtime.jsonl'), true);
  assert.equal(resolveStatePath({}), null);
});

// ---------------------------------------------------------------------- off

test('off: never judges, never writes, and stays synchronous', () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'off', statePath: path });
  assert.equal(runtime.enabled, false);

  let calls = 0;
  const value = runtime.intercept('memory_forget', { confirm: 'FORGET' }, () => {
    calls += 1;
    return { ok: true };
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 1, 'the tool still runs');
  assert.equal(typeof value.then, 'undefined', 'off must not turn a sync tool into a promise');
  assert.equal(existsSync(path), false, 'off writes nothing');
});

test('off: an unregistered tool is not judged either', () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'shadow', statePath: path });
  let calls = 0;
  runtime.intercept('session_health', {}, () => {
    calls += 1;
    return 'x';
  });
  assert.equal(calls, 1);
  assert.equal(existsSync(path), false, 'session_* is out of scope');
});

// ------------------------------------------------------------------- shadow

test('shadow: records the decision and returns the tool value unchanged', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'shadow', statePath: path });
  const expected = { ok: true, cards: 3 };
  const result = await runtime.intercept('memory_forget', { confirm: 'FORGET', reason: '删除重复卡片' }, () => expected);
  assert.equal(result, expected, 'the exact same object comes back');

  const records = readRecords(path);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.mode, 'shadow');
  assert.equal(record.tool, 'memory_forget');
  assert.equal(record.decision.matchedRule, 'R-MEM-DISTILL');
  assert.equal(record.decision.ruleId, 'R-MEM-DISTILL');
  assert.equal(record.decision.action, 'memory.distillPropose', 'the deciding action, not decisions[0] (engram.search)');
  assert.equal(record.decision.level, 'X');
  assert.equal(record.decision.needsHuman, true);
  assert.equal(typeof record.latencyMs, 'number');
  assert.equal(record.outcome.status, 'ok');
  assert.equal(record.guard.verdict, 'allow');
  assert.equal(record.risk.level, 'delete');
});

test('shadow: a thrown tool error is rethrown as the same object and still recorded', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'shadow', statePath: path });
  const boom = Object.assign(new Error('E_RECALL_NO_MATCH: nothing'), { code: 'E_RECALL_NO_MATCH' });
  const thrown = await runtime
    .intercept('memory_recall', { query: '听觉训练' }, () => {
      throw boom;
    })
    .then(
      () => null,
      (error) => error,
    );
  assert.equal(thrown, boom, 'identity of the error object is preserved');
  const [record] = readRecords(path);
  assert.equal(record.outcome.status, 'error');
  assert.equal(record.outcome.code, 'E_RECALL_NO_MATCH');
  assert.equal(record.guard.verdict, 'allow');
});

test('shadow: a read is judged and recorded but never refused', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'shadow', statePath: path });
  const value = await runtime.intercept('memory_recall', { query: '改名 小蓝' }, () => 'cards');
  assert.equal(value, 'cards');
  const [record] = readRecords(path);
  assert.equal(record.decision.matchedRule, 'R-ID-CONSENT');
  assert.equal(record.guard.verdict, 'allow');
  assert.equal(runtime.stats().denied, 0);
});

// ----------------------------------------------------------------------- on

test('on: a confirmed delete is refused and the underlying tool is not called', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'on', statePath: path });
  let calls = 0;
  const error = await runtime
    .intercept('memory_forget', { confirm: 'FORGET' }, () => {
      calls += 1;
      return 'deleted';
    })
    .then(
      () => null,
      (failure) => failure,
    );
  assert.ok(error, 'the call must reject');
  assert.equal(error.code, ROUTE_REFUSED_CODE);
  assert.equal(error.details.risk, 'delete');
  assert.equal(calls, 0, 'invoke is never reached');
  const [record] = readRecords(path);
  assert.equal(record.outcome.status, 'denied');
  assert.equal(record.guard.verdict, 'deny');
  assert.equal(record.mode, 'on');
});

test('on: a dry-run forget and a read both pass through', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'on', statePath: path });
  assert.equal(await runtime.intercept('memory_forget', {}, () => 'preview'), 'preview');
  assert.equal(await runtime.intercept('memory_recall', { query: '任意' }, () => 'cards'), 'cards');
  const records = readRecords(path);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.outcome.status), ['ok', 'ok']);
});

test('on: identity risk is refused', async () => {
  const dir = tempDir();
  const runtime = createRouterRuntime({ mode: 'on', statePath: statePathIn(dir) });
  const failure = await runtime.guard('memory_save', { content: '以后叫我小蓝' });
  assert.equal(typeof failure, 'string');
  assert.match(failure, /E_ROUTE_REFUSED/);
  assert.match(failure, /R-ID-CONSENT/);
  assert.equal(classifyRisk({ tool: 'memory_save', args: {}, matchedRule: 'R-ID-CONSENT', action: 'identity.hold' }).level, 'identity');
});

// -------------------------------------------------------------- fail-closed

test('fail-closed: a broken router refuses writes but not reads, and never throws', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({
    mode: 'on',
    statePath: path,
    routeImpl: () => {
      throw new Error('router exploded');
    },
  });
  let called = 0;
  const write = await runtime
    .intercept('memory_consolidate', { since: '2026-11-01' }, () => {
      called += 1;
      return 'merged';
    })
    .then(
      () => null,
      (error) => error,
    );
  assert.ok(write);
  assert.equal(write.code, ROUTE_REFUSED_CODE);
  assert.equal(called, 0);
  assert.equal(await runtime.intercept('memory_recall', { query: 'x' }, () => 'cards'), 'cards');

  const records = readRecords(path);
  assert.equal(records.length, 2);
  assert.equal(records[0].decision.failClosed, true);
  assert.equal(records[0].decision.ruleId, 'R-ROUTER-FAILCLOSED');
  assert.equal(records[1].outcome.status, 'ok', 'the read still ran');
});

test('fail-closed in shadow: records the failure and runs the tool anyway', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({
    mode: 'shadow',
    statePath: path,
    routeImpl: () => {
      throw new Error('router exploded');
    },
  });
  assert.equal(await runtime.intercept('memory_forget', { confirm: 'FORGET' }, () => 'deleted'), 'deleted');
  const [record] = readRecords(path);
  assert.equal(record.decision.failClosed, true);
  assert.equal(record.outcome.status, 'ok');
  assert.equal(record.guard.verdict, 'allow');
});

// ------------------------------------------------------------------ rolling

test('rolling: the file never exceeds the cap and keeps the newest lines', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'shadow', statePath: path, maxRecords: 3 });
  for (let i = 0; i < 7; i += 1) {
    await runtime.intercept('memory_recall', { query: `q-${i}` }, () => `r-${i}`);
  }
  const records = readRecords(path);
  assert.equal(records.length, 3, 'capped at maxRecords');
  assert.deepEqual(
    records.map((r) => r.call.args.query),
    ['q-4', 'q-5', 'q-6'],
    'the newest three survive',
  );
  assert.equal(runtime.stats().recorded, 7);
});

test('rolling: rotation is atomic and leaves no stray tmp file', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'shadow', statePath: path, maxRecords: 2 });
  for (let i = 0; i < 4; i += 1) await runtime.intercept('memory_recall', { query: `q-${i}` }, () => 'ok');
  assert.equal(existsSync(`${path}.tmp-${process.pid}`), false);
  assert.equal(readRecords(path).length, 2);
});

// -------------------------------------------------------------- sink broken

test('a broken record sink never changes what the tool does', async () => {
  const dir = tempDir();
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, 'x', 'utf8');
  const runtime = createRouterRuntime({ mode: 'shadow', statePath: join(blocker, 'router-runtime.jsonl') });
  assert.equal(await runtime.intercept('memory_recall', { query: 'q' }, () => 'cards'), 'cards');
  assert.equal(runtime.stats().recorded, 0, 'nothing could be recorded');
  assert.equal(runtime.stats().judged, 1, 'the judgement still happened');
});

// ----------------------------------------------------------------- coercion

test('judge text carries the tool name and the flag values', () => {
  const text = buildJudgeText('memory_forget', { confirm: 'FORGET', reason: '删除重复', topK: 5, nested: { deep: '清掉' } });
  assert.match(text, /memory_forget/);
  assert.match(text, /confirm=forget/);
  assert.match(text, /删除重复/);
  assert.match(text, /清掉/, 'nested strings are flattened');
  assert.ok(text.length <= 2000);
});

// -------------------------------------------------------------- integration

function fakeCtx() {
  const registered = [];
  const guards = [];
  return {
    registered,
    guards,
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
      guard(fn) {
        guards.push(fn);
        return () => {};
      },
    },
  };
}

test('registerTools: shadow wraps execute and records, without touching the result', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'shadow', statePath: path });
  const ctx = fakeCtx();
  const count = await registerTools(ctx, {
    defineTool: (definition) => definition,
    memoryRoot: dir,
    memRoot: dir,
    routerRuntime: runtime,
  });
  assert.equal(count, TOOLS.length);
  assert.equal(ctx.registered.length, TOOLS.length);
  assert.equal(ctx.guards.length, 1, 'the guard is registered for memory_save');

  const forget = ctx.registered.find((tool) => tool.name === 'memory_forget');
  const preview = await forget.execute({}, {});
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun !== false, true, 'no confirm means a preview');
  const [record] = readRecords(path);
  assert.equal(record.tool, 'memory_forget');
  assert.equal(record.outcome.status, 'ok');
});

test('registerTools: on refuses through execute, and the guard only covers foreign tools', async () => {
  const dir = tempDir();
  const path = statePathIn(dir);
  const runtime = createRouterRuntime({ mode: 'on', statePath: path, ownTools: TOOLS.map((t) => t.name) });
  const ctx = fakeCtx();
  await registerTools(ctx, { defineTool: (definition) => definition, memoryRoot: dir, memRoot: dir, routerRuntime: runtime });

  const forget = ctx.registered.find((tool) => tool.name === 'memory_forget');
  const failure = await forget.execute({ confirm: 'FORGET' }, {}).then(
    () => null,
    (error) => error,
  );
  assert.equal(failure.code, ROUTE_REFUSED_CODE);

  const guard = ctx.guards[0];
  assert.equal(guard({ name: 'memory_recall', arguments: { query: 'x' } }), undefined, 'own tools are skipped by the guard');
  assert.equal(typeof guard({ name: 'memory_save', arguments: { content: '以后叫我小蓝' } }), 'string');
  assert.equal(guard({ name: 'memory_save', arguments: { content: '普通事实' } }), undefined);
});

test('registerTools: off registers no guard and does not touch the routing layer', async () => {
  const dir = tempDir();
  const ctx = fakeCtx();
  const runtime = createRouterRuntime({ mode: 'off', statePath: statePathIn(dir) });
  await registerTools(ctx, { defineTool: (definition) => definition, memoryRoot: dir, memRoot: dir, routerRuntime: runtime });
  assert.equal(ctx.guards.length, 0);
  assert.equal(existsSync(statePathIn(dir)), false);
});

test('registerTools without a runtime behaves exactly like the old build', async () => {
  const dir = tempDir();
  const ctx = fakeCtx();
  await registerTools(ctx, { defineTool: (definition) => definition, memoryRoot: dir, memRoot: dir });
  assert.equal(ctx.guards.length, 0);
  const forget = ctx.registered.find((tool) => tool.name === 'memory_forget');
  const preview = await forget.execute({}, {});
  assert.equal(preview.ok, true);
  assert.equal(existsSync(join(dir, 'router-runtime.jsonl')), false);
});

// --------------------------------------------------------------- guard edge

test('guard: a router exception in shadow allows the call and never throws', () => {
  const dir = tempDir();
  const runtime = createRouterRuntime({
    mode: 'shadow',
    statePath: statePathIn(dir),
    routeImpl: () => {
      throw new Error('exploded');
    },
  });
  assert.equal(runtime.guard('memory_save', { content: 'x' }), undefined);
});

test('guard: refuses fail-closed writes in on mode without throwing', () => {
  const dir = tempDir();
  const runtime = createRouterRuntime({
    mode: 'on',
    statePath: statePathIn(dir),
    routeImpl: () => {
      throw new Error('exploded');
    },
  });
  const reason = runtime.guard('memory_save', { content: 'x' });
  assert.equal(typeof reason, 'string');
  assert.match(reason, /E_ROUTE_REFUSED/);
});

test('guard: an unwritable sink still returns a decision (recording is best effort)', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'ro'), { recursive: true });
  const blocker = join(dir, 'ro', 'file');
  writeFileSync(blocker, 'x', 'utf8');
  const runtime = createRouterRuntime({ mode: 'on', statePath: join(blocker, 'x.jsonl') });
  const reason = runtime.guard('memory_save', { content: '以后叫我小蓝' });
  assert.equal(typeof reason, 'string', 'the refusal does not depend on the record landing');
});
