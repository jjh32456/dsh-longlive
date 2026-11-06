/**
 * v4-hardening.test.mjs — 第四轮红队 mustFix + 顺手加固的回归测试。
 *
 * 覆盖：
 * 1. M1 可见性：kind='session-reference' 的注入不再产生用户气泡（对照 v3 的 3 个气泡）。
 * 2. M1 恢复：真实宿主 dsh-session append/adoptSessionEvent/deriveMessages 仍含正文。
 * 3. 坏 source.kind 在 append 前被拒绝（不写进日志）。
 * 4. ADV1：外部插件 kind='user' 文本排在真实提问前，firstUserText 仍取真实提问。
 * 5. 块状 scope_in（YAML 多行）被正确解析；显式空块给 warning，不再静默成空。
 * 6. M2：cordis.patch.yml 注释是实际顺序 [user, boot, runtime, auto] 且写明原因。
 * 7. M3 + 文档：recovered 死文件不再冒充测试；README/WIRING 写清潜望镜与 everyNTurns 语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { apply as applyAuto, defaultMemoryRoot } from '../src/recall/index.js';
import { apply as applyIdentity } from '../src/identity/index.js';
import { parseCard } from '../src/recall/cards.mjs';
import { chooseRecall } from '../src/recall/recall-core.mjs';
import {
  HOST_SOURCE_KINDS,
  HOST_USER_SOURCE_KIND,
  assertInjectionMessage,
  injectionSource,
} from '../src/recall/inject-order.mjs';
import {
  PreStepBus,
  makeUserMessageFactory,
  noopLogger,
  textMessage,
} from './fixtures/pre-step-container.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const AUTO_ROOT = path.resolve(HERE, '..');

const AGENT = { session: { id: 'sess-v4-hardening', header: { origin: 'main' } } };
const BOOT_MARK = '【开机卡】';
const AUTO_MARK = '【自动想起】';

const TOPIC_CARD = [
  '---',
  'title: 听觉训练',
  'scope_in: ["音程辨认", "听觉"]',
  '---',
  '# 听觉训练',
  '- 音程辨认先练大三度和小三度。',
].join('\n');

const RHYTHM_CARD = [
  '---',
  'title: 节奏训练',
  'scope_in: ["节奏"]',
  '---',
  '# 节奏训练',
  '- 节奏先练四拍。',
].join('\n');

const HANDOVER_CARD = [
  '---',
  'title: 测试交接卡一',
  'scope_in: ["测试交接卡一"]',
  '---',
  '# 测试交接卡一',
  '- 上次停在 auto-recall 的红队修复。',
].join('\n');

const STATE_CARD = [
  '## 我在哪',
  '收尾 auto-recall v4。',
  '## 在等什么',
  '等全量测试结果。',
  '## 最近三件',
  '1. 修 M1。',
  '2. 修 M2。',
  '3. 修 M3。',
].join('\n');

function makeMemory(t, { topics = {}, handover = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-recall-v4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_CARD);
  fs.mkdirSync(path.join(root, 'topics'), { recursive: true });
  fs.mkdirSync(path.join(root, 'handover'), { recursive: true });
  for (const [name, text] of Object.entries(topics)) fs.writeFileSync(path.join(root, 'topics', name), text);
  for (const [name, text] of Object.entries(handover)) fs.writeFileSync(path.join(root, 'handover', name), text);
  return root;
}

function makeStack({ memoryRoot, identity = true, auto = true, factory = makeUserMessageFactory() }) {
  const bus = new PreStepBus();
  const ctx = { on: bus.on.bind(bus), logger: noopLogger() };
  if (identity) {
    applyIdentity(ctx, {
      memoryRoot,
      createUserMessage: factory,
      writeOnTurnEnd: false,
      writeOnSessionEnd: false,
    });
  }
  if (auto) {
    applyAuto(ctx, {
      memoryRoot,
      createUserMessage: factory,
      dirs: ['topics', 'handover'],
      log: false,
    });
  }
  return { bus, factory };
}

function textOf(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function roleOf(message) {
  const text = textOf(message);
  if (text.startsWith(BOOT_MARK)) return 'boot';
  if (text.startsWith(AUTO_MARK)) return 'auto';
  if (message?.source?.kind === 'runtime-context') return 'runtime';
  return 'user';
}

function runtimeMessage(text = 'runtime context snapshot') {
  return textMessage(text, { role: 'user', source: { kind: 'runtime-context' } });
}

/* ------------------------------------------------------------------ *
 * 宿主投影的等价镜像（与 redteam4/lib/host.mjs 的 isVisibleChatNode 同口径）
 * ------------------------------------------------------------------ */

function chatNodes(messages) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const source = message?.source ?? {};
    const base = { seq: index, data: message, source, visibility: 'visible' };
    if (source.kind !== 'user') {
      return { ...base, kind: 'context', producer: { role: 'inject', label: source.kind }, form: source.form };
    }
    return { ...base, kind: 'user' };
  });
}

function isVisibleChatNode(node) {
  return node.visibility === 'visible'
    && node.kind !== 'system-prompt'
    && (node.kind !== 'context' || (node.data?.content ?? []).some((b) => b.type === 'tool-addition' || b.type === 'tool-removal'))
    && !(node.kind === 'command' && node.data?.name === 'permission');
}

function visibleUserNodes(messages) {
  return chatNodes(messages).filter((node) => isVisibleChatNode(node) && node.kind === 'user');
}

function turnNavigatorPrompt(messages) {
  const user = chatNodes(messages).filter(isVisibleChatNode).find((node) => node.kind === 'user');
  return user === undefined ? '' : textOf(user.data);
}

/* ================================================================== *
 * 1. M1 可见性：3 个气泡 → 只有真实用户那 1 个
 * ================================================================== */

test('M1：session-reference 注入在聊天里是 context，不再产生【开机卡】/【自动想起】气泡', async (t) => {
  const memoryRoot = makeMemory(t, {
    topics: { 'ear.md': TOPIC_CARD },
    handover: { '2026-11-04-boot.md': HANDOVER_CARD },
  });
  const { bus } = makeStack({ memoryRoot });
  const user = textMessage('今天继续练音程辨认，顺便看测试交接卡一', { id: 'user-1' });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  const injected = decision.messages.filter((m) => roleOf(m) === 'boot' || roleOf(m) === 'auto');
  assert.equal(injected.length, 2, '两条注入都应存在');
  for (const message of injected) {
    assert.equal(message.source.kind, 'session-reference');
    assert.equal(message.source.form, 'recall');
  }

  // v4：注入节点全部不可见，只剩真实用户节点。
  assert.equal(visibleUserNodes(decision.messages).length, 1);
  assert.equal(turnNavigatorPrompt(decision.messages), '今天继续练音程辨认，顺便看测试交接卡一');

  // 对照：把两条注入的 source.kind 改回 v3 的 'user'，气泡数就是 3。
  const legacy = decision.messages.map((message) => {
    if (roleOf(message) !== 'boot' && roleOf(message) !== 'auto') return message;
    return { ...message, source: { ...message.source, kind: 'user' } };
  });
  assert.equal(visibleUserNodes(legacy).length, 3, 'v3 的 3 个气泡应能复现');
  const injectedVisibleAfter = visibleUserNodes(decision.messages)
    .filter((node) => roleOf(node.data) === 'boot' || roleOf(node.data) === 'auto').length;
  assert.equal(injectedVisibleAfter, 0, 'v4 注入气泡数必须为 0');
  // 落盘用：bubblesBefore 是 v3 的 3 个（含真实提问），bubblesAfter 是注入气泡 0 个。
  console.log(`[visibility] bubblesBefore=3 bubblesAfter=${injectedVisibleAfter} totalVisibleAfter=${visibleUserNodes(decision.messages).length}`);
  // v2 的 [boot, user, ...] 才会让 TurnNavigator 抓到开机卡；v4 的 [user, boot, ...]
  // 即便把 boot 的 kind 改回 user，第一个可见 user 仍是真实提问。
  const v2Order = [legacy.find((m) => roleOf(m) === 'boot'), user];
  assert.match(turnNavigatorPrompt(v2Order), new RegExp(BOOT_MARK));
});

/* ================================================================== *
 * 2. 真实宿主：append / adoptSessionEvent / deriveMessages
 * ================================================================== */

const HOST_ROOTS = [
  'C:/work/redteam4/node_modules/@deepseek-ai',
  'C:/work/redteam3/extract/node_modules/@deepseek-ai',
];

async function loadHost() {
  for (const root of HOST_ROOTS) {
    const sessionEntry = path.join(root, 'dsh-session', 'lib', 'index.js');
    const llmEntry = path.join(root, 'dsh-llm', 'lib', 'index.js');
    if (!fs.existsSync(sessionEntry) || !fs.existsSync(llmEntry)) continue;
    const [session, llm] = await Promise.all([
      import(pathToFileURL(sessionEntry).href),
      import(pathToFileURL(llmEntry).href),
    ]);
    return { ...session, createUserMessage: llm.createUserMessage };
  }
  return null;
}

test('M1 恢复：宿主 append/adoptSessionEvent 接受 session-reference，deriveMessages 仍含正文', async (t) => {
  const host = await loadHost();
  if (host === null) {
    t.skip('宿主 dsh-session/dsh-llm 不可用');
    return;
  }
  const session = host.Session.create('v4-restore');
  const message = host.createUserMessage({
    content: [{ type: 'text', text: `${AUTO_MARK}恢复后仍在上下文里` }],
    source: injectionSource(),
  });
  const event = session.append('user/message', message, { surfaceOp: 'append' });
  assert.equal(event.data.source.kind, 'session-reference');
  assert.equal(event.data.source.form, 'recall');
  assert.deepEqual(event.data.source.references, []);

  // 冷恢复：把事件 JSON 化后重新 adopt，宿主不能抛 invalid source。
  host.adoptSessionEvent(JSON.parse(JSON.stringify(event)), { sessionId: session.id });
  const derived = session.deriveMessages().map(textOf).join('\n');
  assert.match(derived, /恢复后仍在上下文里/);

  // 宿主对 source.kind 只校验「非空字符串」：plugin:bogus 会被 append 接受并污染日志。
  // 这正是插件必须在 append 之前拦一道的原因。
  const poison = host.Session.create('v4-poison');
  const bad = host.createUserMessage({
    content: [{ type: 'text', text: 'bad' }],
    source: { kind: 'plugin:bogus' },
  });
  assert.doesNotThrow(() => poison.append('user/message', bad, { surfaceOp: 'append' }));
  assert.throws(() => assertInjectionMessage(bad), (error) => error?.code === 'E_BAD_SOURCE_KIND');
});

/* ================================================================== *
 * 3. 坏 source.kind：append 前拒绝
 * ================================================================== */

test('坏 source.kind：assertInjectionMessage 直接抛错，插件不把它写进 decision', async (t) => {
  assert.equal(HOST_SOURCE_KINDS.includes('session-reference'), true);
  assert.equal(HOST_SOURCE_KINDS.length, 23);
  assert.equal(HOST_USER_SOURCE_KIND, 'session-reference');

  assert.throws(
    () => assertInjectionMessage({ role: 'user', content: [], source: { kind: 'plugin:bogus' } }),
    (error) => error?.code === 'E_BAD_SOURCE_KIND',
  );
  assert.throws(
    () => assertInjectionMessage({ role: 'user', content: [], source: { kind: 'user' } }),
    (error) => error?.code === 'E_UNEXPECTED_INJECTION_KIND',
  );
  assert.throws(
    () => assertInjectionMessage({ role: 'user', content: [], source: { kind: 'session-reference', form: 'recall', version: 1 } }),
    (error) => error?.code === 'E_BAD_SOURCE_SHAPE',
  );

  const memoryRoot = makeMemory(t, { topics: { 'ear.md': TOPIC_CARD } });
  const bus = new PreStepBus();
  const ctx = { on: bus.on.bind(bus), logger: noopLogger() };
  let factoryCalls = 0;
  applyAuto(ctx, {
    memoryRoot,
    dirs: ['topics'],
    log: false,
    createUserMessage: (input) => {
      factoryCalls += 1;
      return { role: 'user', ...input, source: { kind: 'plugin:bogus' } };
    },
  });

  const { decision } = await bus.compose({
    messages: [textMessage('继续练音程辨认', { id: 'user-1' })],
    agent: AGENT,
    turn: 1,
    step: 1,
    context: runtimeMessage(),
  });
  assert.equal(factoryCalls, 1, '确实尝试过注入');
  assert.equal(decision.messages.some((m) => m.source?.kind === 'plugin:bogus'), false);
  assert.equal(decision.messages.length, 2, '只剩 user + runtime，坏注入被拒绝');
});

/* ================================================================== *
 * 4. ADV1：外部插件 kind:user 文本排在真实提问前
 * ================================================================== */

test('ADV1：外部 kind=user 文本在前时，firstUserText 仍取真实提问（第 1 轮最后一条）', async (t) => {
  const memoryRoot = makeMemory(t, {
    topics: { 'ear.md': TOPIC_CARD, 'rhythm.md': RHYTHM_CARD },
  });
  const { bus } = makeStack({ memoryRoot, identity: false });

  const foreign = textMessage('【外部提醒】今天只练节奏', { id: 'foreign-1' });
  const real = textMessage('继续练音程辨认', { id: 'user-1' });

  bus.emit('session/event', { type: 'user/message', data: foreign }, AGENT);
  bus.emit('session/event', { type: 'user/message', data: real }, AGENT);

  // 真实提问不在 claimed 里也可以：ADV1 的关键是 firstUserText 取谁。
  const { decision } = await bus.compose({
    messages: [real], agent: AGENT, turn: 1, step: 1,
  });
  const auto = decision.messages.find((m) => roleOf(m) === 'auto');
  assert.ok(auto, '应有一条自动想起');
  const text = textOf(auto);
  assert.match(text, /大三度/, '应召回真实提问对应的音程卡');
  assert.doesNotMatch(text, /四拍/, '不应召回外部文本对应的节奏卡');
});

/* ================================================================== *
 * 5. 块状 scope_in（YAML 多行）
 * ================================================================== */

const BLOCK_CARD = [
  '---',
  'title: 块状卡',
  'scope_in:',
  '  - 音程辨认',
  '  - 听觉',
  'scope_out:',
  '  - 节奏',
  '---',
  '# 块状卡',
  '- 音程辨认先练大三度。',
].join('\n');

const EMPTY_BLOCK_CARD = [
  '---',
  'title: 空块卡',
  'scope_in:',
  'scope_out:',
  '---',
  '# 空块卡',
  '- 这一张没有 scope。',
].join('\n');

test('块状 scope_in：解析成数组、能召回；显式空块给 warning 而不是静默为空', () => {
  const card = parseCard(BLOCK_CARD, 'topics/block.md');
  assert.deepEqual(card.scopeIn, ['音程辨认', '听觉']);
  assert.deepEqual(card.scopeOut, ['节奏']);
  assert.deepEqual(card.warnings, []);

  const result = chooseRecall({ queryText: '音程辨认', cards: [card], budget: 1200, maxItems: 3 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].path, 'topics/block.md');

  // 反证：块状写法被正确识别，不再走 noScope。
  assert.equal(card.noScope, undefined);

  const empty = parseCard(EMPTY_BLOCK_CARD, 'topics/empty.md');
  assert.deepEqual(empty.scopeIn, []);
  assert.equal(empty.warnings.length, 2);
  assert.match(empty.warnings[0], /scope_in/);
  assert.match(empty.warnings[1], /scope_out/);
});

/* ================================================================== *
 * 6. M2：cordis.patch.yml 注释顺序
 * ================================================================== */

test('M2：cordis.patch.yml 注释写实际顺序 [user, boot, runtime, auto] 并解释 TurnNavigator', () => {
  const yml = fs.readFileSync(path.join(AUTO_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(yml, /\[user, boot, runtime, auto\]/);
  assert.doesNotMatch(yml, /\[boot, user, runtime, auto\]/);
  assert.match(yml, /TurnNavigator|firstUserText/);
});

/* ================================================================== *
 * 7. M3 死文件 + 文档
 * ================================================================== */

test('M3：recovered 死文件已删除，v4 套件有单入口；README/WIRING 写清潜望镜与 everyNTurns', () => {
  assert.equal(fs.existsSync(path.join(AUTO_ROOT, 'test', 'auto-recall.recovered.mjs')), false, '死测试文件必须删掉');
  const runAll = path.join(AUTO_ROOT, 'test', 'run-rc.mjs');
  assert.equal(fs.existsSync(runAll), true, '单入口必须存在');
  assert.match(fs.readFileSync(runAll, 'utf8'), /v4-hardening/);

  const readme = fs.readFileSync(path.join(AUTO_ROOT, 'docs', 'AUTO-RECALL.md'), 'utf8');
  const wiring = fs.readFileSync(path.join(AUTO_ROOT, 'docs', 'AUTO-RECALL-WIRING.md'), 'utf8');
  for (const doc of [readme, wiring]) {
    assert.match(doc, /潜望镜/, '可见性归属要写进文档');
    assert.match(doc, /isVisibleChatNode|context 节点/, '要说清注入在聊天里不可见');
  }
  assert.match(readme, /turn 2[–-]5/, 'everyNTurns 的 quiet 区间要写清');
});

test('M1 便携默认记忆根：环境变量优先，缺省从当前用户主目录派生', () => {
  // 红队 M1：源码里不许再有构建机绝对路径。优先级与新/旧环境变量一致。
  assert.equal(defaultMemoryRoot({ DSH_LONGLIVE_MEMORY_ROOT: 'X:/root-new' }), 'X:/root-new');
  assert.equal(defaultMemoryRoot({ DSH_MEM: 'X:/root-legacy' }), 'X:/root-legacy');
  assert.equal(
    defaultMemoryRoot({ DSH_LONGLIVE_MEMORY_ROOT: 'X:/root-new', DSH_MEM: 'X:/root-legacy' }),
    'X:/root-new',
    'new env must win over the legacy alias',
  );
  const fallback = defaultMemoryRoot({});
  assert.equal(fallback, path.join(os.homedir(), '.dsh', 'longlive-memory'));
  assert.ok(fallback.startsWith(os.homedir()), 'fallback must derive from the current user home');
});