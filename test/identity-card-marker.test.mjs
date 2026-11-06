/**
 * identityCard 跨进程去重（1.3.1）。
 *
 * 缺陷：opened 只记在进程内 Map，`--session-id` 续跑时新进程从空开始，
 * step 1 又注入一张开机卡（VM-EXTRA-3）。
 *
 * 这里用「新 ctx 实例 + 同一 memoryRoot/sessionId」模拟新进程：每个
 * registerFeatures() 调用都拥有全新的闭包状态，等价于一个刚启动的宿主进程；
 * 磁盘上的 marker 是两次「进程」之间唯一的共享状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerFeatures } from '../src/features.js';
import {
  MARKER_PRUNE_LIMIT,
  markerPathFor,
  pruneCardMarkers,
  readCardMarker,
  safeSessionId,
} from '../src/identity/card-marker.js';
import {
  PreStepBus,
  makeUserMessageFactory,
  textMessage,
} from './fixtures/pre-step-container.mjs';

const BOOT_MARK = '【开机卡】';
const STATE_TEXT = [
  '## 我在哪',
  'identityCard 跨进程修复。',
  '## 在等什么',
  '等 marker 测试全绿。',
  '## 最近三件',
  '1. 读 features.js。',
  '2. 写 marker 模块。',
  '3. 跑测试。',
].join('\n');

function agentOf(sessionId, origin = 'main') {
  return { session: { id: sessionId, header: { origin } } };
}

function makeMemory(t, state = STATE_TEXT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-marker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'STATE.md'), state);
  return root;
}

function makeInstance({ memoryRoot, identity = {}, warnings = [] }) {
  const bus = new PreStepBus();
  const ctx = {
    on: bus.on.bind(bus),
    logger: () => ({
      warn: (message) => warnings.push(String(message)),
      info() {},
      error() {},
    }),
    effect() {},
    tools: { register() {} },
  };
  registerFeatures(ctx, {
    identityCard: {
      enabled: true,
      createUserMessage: makeUserMessageFactory(),
      ...identity,
    },
  }, { memoryRoot });
  return { bus, warnings };
}

async function compose(instance, sessionId, { texts = ['你好'], origin = 'main', step = 1 } = {}) {
  const messages = texts.map((text) => textMessage(text));
  const composed = await instance.bus.compose({
    messages,
    agent: agentOf(sessionId, origin),
    step,
  });
  return composed;
}

function cards(decision) {
  return (decision?.messages ?? []).filter((message) => message?.source?.kind === 'session-reference');
}

function isBootCard(message) {
  return typeof message?.content?.[0]?.text === 'string'
    && message.content[0].text.startsWith(BOOT_MARK);
}

test('① 同一进程两次 step 1 只注入一次，marker 形状正确', async (t) => {
  const root = makeMemory(t);
  const warnings = [];
  const instance = makeInstance({ memoryRoot: root, warnings });

  const first = await compose(instance, 'sess-same', { texts: ['第一问'] });
  assert.equal(cards(first.decision).length, 1);
  assert.equal(first.decision.messages[1].source.kind, 'session-reference');
  assert.ok(isBootCard(first.decision.messages[1]));

  const second = await compose(instance, 'sess-same', { texts: ['第二问'] });
  assert.equal(cards(second.decision).length, 0);

  const file = markerPathFor(root, 'sess-same');
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(marker).sort(), ['at', 'openedAt', 'sessionId', 'v']);
  assert.equal(marker.v, 1);
  assert.equal(marker.sessionId, 'sess-same');
  assert.ok(Date.parse(marker.openedAt) > 0);
  assert.ok(Date.parse(marker.at) > 0);
  assert.deepEqual(warnings, []);
});

test('② 新进程（新 ctx，同 memoryRoot+sessionId）不再注入', async (t) => {
  const root = makeMemory(t);

  const firstProcess = makeInstance({ memoryRoot: root });
  const first = await compose(firstProcess, 'sess-resume');
  assert.equal(cards(first.decision).length, 1);

  // 这一行之前，第一个「进程」已经结束；第二个实例的 Map 是空的，只有磁盘
  // 上的 marker 能拦住重复注入。
  const secondProcess = makeInstance({ memoryRoot: root });
  const second = await compose(secondProcess, 'sess-resume', { texts: ['续跑第一问'] });
  assert.equal(cards(second.decision).length, 0);
  assert.deepEqual(second.decision.messages.map((message) => message.content[0].text), ['续跑第一问']);
});

test('③ 不同 sessionId 各自注入一次', async (t) => {
  const root = makeMemory(t);
  const instance = makeInstance({ memoryRoot: root });

  const a = await compose(instance, 'sess-a');
  const b = await compose(instance, 'sess-b');
  const aAgain = await compose(instance, 'sess-a', { texts: ['a 再问'] });

  assert.equal(cards(a.decision).length, 1);
  assert.equal(cards(b.decision).length, 1);
  assert.equal(cards(aAgain.decision).length, 0);
  assert.ok(fs.existsSync(markerPathFor(root, 'sess-a')));
  assert.ok(fs.existsSync(markerPathFor(root, 'sess-b')));
});

test('④ 子代理不注入、也不落 marker', async (t) => {
  const root = makeMemory(t);
  const instance = makeInstance({ memoryRoot: root });

  const sub = await compose(instance, 'sess-sub', { origin: 'subagent' });
  assert.equal(cards(sub.decision).length, 0);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'identity-card')), false);
});

test('⑤ 空卡（越界路径导致生成失败）不注入、不落 marker', async (t) => {
  const root = makeMemory(t);
  const warnings = [];
  const instance = makeInstance({
    memoryRoot: root,
    identity: { path: '../escape/STATE.md' },
    warnings,
  });

  const result = await compose(instance, 'sess-empty');
  assert.equal(cards(result.decision).length, 0);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'identity-card')), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /E_PATH_OUTSIDE_ROOT/);
});

test('⑥ marker 落盘失败：本进程只注入一次、不抛，后续进程按已注入跳过', async (t) => {
  const root = makeMemory(t);
  const warnings = [];
  const instance = makeInstance({ memoryRoot: root, warnings });

  const realRenameSync = fs.renameSync;
  fs.renameSync = function failingRenameSync(from, to) {
    if (String(to).includes(`${path.sep}identity-card${path.sep}`)) {
      const error = new Error('simulated read-only marker dir');
      error.code = 'EACCES';
      throw error;
    }
    return realRenameSync.call(this, from, to);
  };
  try {
    const first = await compose(instance, 'sess-writefail');
    assert.equal(cards(first.decision).length, 1);
    const second = await compose(instance, 'sess-writefail', { texts: ['第二次'] });
    assert.equal(cards(second.decision).length, 0);
  } finally {
    fs.renameSync = realRenameSync;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /落盘失败/);

  // 抢占时写的占位 marker 还在：新进程读到它就不重复注入（fail-closed）。
  const marker = JSON.parse(fs.readFileSync(markerPathFor(root, 'sess-writefail'), 'utf8'));
  assert.equal(marker.openedAt, null);
  const resumed = makeInstance({ memoryRoot: root });
  const third = await compose(resumed, 'sess-writefail', { texts: ['恢复'] });
  assert.equal(cards(third.decision).length, 0);
});

test('⑦ 并发两个实例：O_EXCL 只有一个赢家', async (t) => {
  const root = makeMemory(t);
  const one = makeInstance({ memoryRoot: root });
  const two = makeInstance({ memoryRoot: root });

  const [left, right] = await Promise.all([
    compose(one, 'sess-race'),
    compose(two, 'sess-race'),
  ]);
  const injected = [...cards(left.decision), ...cards(right.decision)];
  assert.equal(injected.length, 1);

  const marker = JSON.parse(fs.readFileSync(markerPathFor(root, 'sess-race'), 'utf8'));
  assert.equal(marker.v, 1);
  assert.ok(Date.parse(marker.openedAt) > 0);
});

test('⑧ marker 损坏：跳过注入并只 warn 一次', async (t) => {
  const root = makeMemory(t);
  const file = markerPathFor(root, 'sess-corrupt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"v":1,"sessionId":', 'utf8');

  const warnings = [];
  const instance = makeInstance({ memoryRoot: root, warnings });
  const first = await compose(instance, 'sess-corrupt');
  const second = await compose(instance, 'sess-corrupt', { texts: ['再来'] });

  assert.equal(cards(first.decision).length, 0);
  assert.equal(cards(second.decision).length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /E_MARKER_CORRUPT/);
  // 损坏的 marker 不被覆盖，仍保持坏文件（fail-closed，不猜）。
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1,"sessionId":');
});

test('⑨ prune 只删 30 天以上的 .json，且遵守数量上限', async (t) => {
  const root = makeMemory(t);
  const dir = path.join(root, '.longlive', 'identity-card');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const old = new Date(now - 31 * 24 * 60 * 60 * 1000);

  const make = (name, mtime) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ v: 1, sessionId: name, openedAt: new Date().toISOString(), at: new Date().toISOString() }));
    fs.utimesSync(file, mtime, mtime);
    return file;
  };
  const staleA = make('stale-a.json', old);
  const staleB = make('stale-b.json', old);
  const fresh = make('fresh.json', new Date(now - 60 * 1000));

  const dry = pruneCardMarkers(root, { now, limit: 1 });
  assert.equal(dry.deleted, 1);
  assert.equal(fs.existsSync(staleA) || fs.existsSync(staleB), true);
  assert.ok(fs.existsSync(fresh));

  const rest = pruneCardMarkers(root, { now, limit: MARKER_PRUNE_LIMIT });
  assert.equal(rest.deleted, 1);
  assert.equal(fs.existsSync(staleA), false);
  assert.equal(fs.existsSync(staleB), false);
  assert.ok(fs.existsSync(fresh));
});

test('⑩ safeSessionId 规范化、防路径穿越、保留可读 id', () => {
  assert.equal(safeSessionId('session-e219dedf'), 'session-e219dedf');
  const traversal = safeSessionId('../evil/id');
  assert.equal(traversal.includes('/'), false);
  assert.equal(traversal.includes('\\'), false);
  assert.equal(safeSessionId('..').startsWith('.'), false);
  assert.equal(safeSessionId('..').includes('/'), false);
  assert.notEqual(safeSessionId('会话 一'), safeSessionId('会话 二'));
  // 同一个 id 总是映射到同一个文件名。
  assert.equal(safeSessionId('a b'), safeSessionId('a b'));
});

test('⑪ marker 丢失时：无法证明已开过，会再注入一次（已知边界）', async (t) => {
  const root = makeMemory(t);
  const first = makeInstance({ memoryRoot: root });
  const injected = await compose(first, 'sess-lost');
  assert.equal(cards(injected.decision).length, 1);

  fs.rmSync(markerPathFor(root, 'sess-lost'), { force: true });
  const resumed = makeInstance({ memoryRoot: root });
  const again = await compose(resumed, 'sess-lost', { texts: ['marker 被删后'] });
  assert.equal(cards(again.decision).length, 1);

  // readCardMarker 对缺失文件返回 exists:false，而不是错误。
  const read = readCardMarker({ memoryRoot: root, sessionId: 'sess-lost' });
  assert.equal(read.ok, true);
  assert.equal(read.exists, true); // 第二次注入后又写回来了
});

test('⑫ 非 step 1 不注入、不落 marker', async (t) => {
  const root = makeMemory(t);
  const instance = makeInstance({ memoryRoot: root });
  const later = await compose(instance, 'sess-step2', { step: 2 });
  assert.equal(cards(later.decision).length, 0);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'identity-card')), false);
});
