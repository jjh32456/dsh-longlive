/**
 * 真·集成测试：两个插件的 apply() 跑在复刻的 Cordis pre-step 容器里。
 *
 * 红队第 5 条：旧测试 0 次调用 apply()、顺序靠手拼数组。这里所有顺序断言
 * 都来自 PreStepBus 的 waterfall 合成（见 fixtures/pre-step-container.mjs），
 * 不出现 `[a, b, c]` 式的人工排序。
 *
 * 运行：node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply as applyAuto } from '../src/recall/index.js';
import { apply as applyIdentity } from '../src/identity/index.js';
import { loadCards } from '../src/recall/cards.mjs';
import { PRIVACY_HIDDEN_PATH, buildQueryText, chooseRecall, renderItemHeader } from '../src/recall/recall-core.mjs';
import { isAutoMessage, isIdentityMessage } from '../src/recall/inject-order.mjs';
import { PreStepBus, makeUserMessageFactory, noopLogger, textMessage } from './fixtures/pre-step-container.mjs';

const BOOT_MARK = '【开机卡】';
const AUTO_MARK = '【自动想起】';

/** 宿主 MessageSourceMap 的完整成员（dsh-llm/lib/typert.host.js:475-477）。 */
const HOST_SOURCE_KINDS = new Set([
  'user', 'model', 'tool', 'system-prompt', 'model-selection', 'runtime-context',
  'working-directory', 'user-approval', 'ptc-mode', 'tool-registry', 'user-rpc',
  'agent-message', 'subagent-settled', 'skill-invocation', 'compact-checkpoint',
  'cordis-host-runner', 'team-message', 'user-question-reply', 'goal', 'plan-mode',
  'schedule', 'session-reference', 'webhook',
]);

const AGENT = { session: { id: 'sess-integration', header: { origin: 'main' } } };

function writeFile(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
}

/**
 * 临时记忆根：topics + handover + STATE.md。测试结束自动删。
 * @param {import('node:test').TestContext} t
 * @param {{topics?:Record<string,string>, handover?:Record<string,string>, state?:string}} [input]
 */
function makeMemory(t, { topics = {}, handover = {}, state = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-recall-it-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFile(root, 'STATE.md', state ?? [
    '## 我在哪',
    '自动想起集成测试',
    '## 在等什么',
    '红队验收',
    '## 最近三件',
    '- 修顺序',
    '- 修打包',
    '- 修测试',
  ].join('\n'));
  for (const [name, text] of Object.entries(topics)) writeFile(root, `topics/${name}`, text);
  for (const [name, text] of Object.entries(handover)) writeFile(root, `handover/${name}`, text);
  return root;
}

const TOPIC_CARD = [
  '---',
  'title: 听觉训练',
  'scope_in: ["音程辨认"]',
  '---',
  '# 听觉训练',
  '- 每天练音程辨认，先听根音再听音程。',
].join('\n');

const HANDOVER_CARD = [
  '---',
  'title: 测试交接卡一',
  'scope_in: ["测试交接卡一"]',
  '---',
  '# 测试交接卡一',
  '- 上次停在 auto-recall 的红队修复。',
].join('\n');

function makeStack({ memoryRoot, identity = true, auto = true }) {
  const bus = new PreStepBus();
  const ctx = { on: bus.on.bind(bus), logger: noopLogger() };
  const factory = makeUserMessageFactory();
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

function legacyBootMessage(text = `${BOOT_MARK}旧版 identity 在 next() 之后追加`) {
  return textMessage(text, { id: 'legacy-boot' });
}

/* ================================================================== *
 * A：两插件都在 → [user, boot, runtime, auto]（v3：boot 在 user 之后）
 * ================================================================== */

test('apply() 集成 A：identity + auto 合成后 user 在首、boot 紧随其后、auto 在尾', async (t) => {
  const memoryRoot = makeMemory(t, { topics: { 'ear.md': TOPIC_CARD }, handover: { '2026-11-04-boot.md': HANDOVER_CARD } });
  const { bus } = makeStack({ memoryRoot });
  const user = textMessage('今天继续练音程辨认，顺便看测试交接卡一', { id: 'user-1' });

  const { decision, claimed } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });

  // 顺序只由注册语义 + 插件代码合成，断言不手工拼期望数组。
  const order = decision.messages.map(roleOf);
  assert.deepEqual(order, ['user', 'boot', 'runtime', 'auto'], `实际：${order.join(',')}`);
  // 宿主共享的 claimed 里也只允许 [user, boot]：boot 插在真实 user 之后，不是最前。
  assert.deepEqual(claimed.map(roleOf), ['user', 'boot'], 'boot 必须紧跟真实 user，不能抢首位');
  assert.equal(decision.messages.filter((m) => roleOf(m) === 'boot').length, 1);
  assert.equal(decision.messages.filter((m) => roleOf(m) === 'auto').length, 1);
});

/* ================================================================== *
 * TurnNavigator 等价：宿主取该轮第一个可见 kind:'user' 节点做 prompt
 * （dsh-client-ui-chat/lib/client.js:8371-8383；tooltip :460-467）
 * ================================================================== */

/**
 * 复刻宿主投影：user/message 且 source.kind === 'user' → kind:'user' 可见节点，
 * 其余（session-reference / runtime-context 等）→ context 节点（client.js:9887-9893）。
 * @param {object[]} messages
 * @returns {{kind:string, data:object}[]}
 */
function chatNodes(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    kind: message?.source?.kind === 'user' ? 'user' : 'context',
    data: message,
  }));
}

/** 复刻 turnNavigationItem 的 prompt 提取：loaded.find(kind === 'user')。 */
function firstVisibleUserPrompt(messages) {
  const user = chatNodes(messages).filter((node) => node.kind === 'user')[0];
  return user === undefined ? '' : textOf(user.data);
}

test('TurnNavigator 等价：第 1 轮 prompt 取首个非注入 user，不是开机卡', async (t) => {
  const memoryRoot = makeMemory(t, { topics: { 'ear.md': TOPIC_CARD }, handover: { '2026-11-04-boot.md': HANDOVER_CARD } });
  const { bus } = makeStack({ memoryRoot });
  const user = textMessage('今天继续练音程辨认，顺便看测试交接卡一', { id: 'user-1' });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });

  const prompt = firstVisibleUserPrompt(decision.messages);
  assert.ok(prompt.startsWith('今天继续练音程辨认'), `tooltip 必须是用户提问，实际：${prompt.slice(0, 40)}`);
  assert.doesNotMatch(prompt, /【开机卡】/, 'tooltip 不能显示开机卡');
  assert.equal(prompt, textOf(user), '首个可见 user 节点必须就是用户原话');

  // 反证：把 boot 的 source.kind 改回 v2 的 'user'，同一个提取函数就会拿到开机卡
  // （v4 的 session-reference 不会再投影成 user 节点）。
  const boot = decision.messages.find((m) => roleOf(m) === 'boot');
  const legacyBoot = { ...boot, source: { ...boot.source, kind: 'user' } };
  const legacyOrder = [legacyBoot, user];
  assert.match(firstVisibleUserPrompt(legacyOrder), /【开机卡】/);
});

/* ================================================================== *
 * B：只有 auto → [user, runtime, auto]
 * ================================================================== */

test('apply() 集成 B：没有 identity 时 auto 追加在 runtime 之后，不伪造 boot', async (t) => {
  const memoryRoot = makeMemory(t, { topics: { 'ear.md': TOPIC_CARD } });
  const { bus } = makeStack({ memoryRoot, identity: false });
  const user = textMessage('今天继续练音程辨认', { id: 'user-1' });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  assert.deepEqual(decision.messages.map(roleOf), ['user', 'runtime', 'auto']);
  assert.equal(decision.messages.some((m) => roleOf(m) === 'boot'), false);
});

/* ================================================================== *
 * 回归夹具：旧 identity 在 next() 之后 append → before 顺序
 * ================================================================== */

test('旧 identity 语义（next 后 append）确实复现 [user, runtime, auto, boot]', async (t) => {
  const memoryRoot = makeMemory(t, { topics: { 'ear.md': TOPIC_CARD } });
  const { bus } = makeStack({ memoryRoot, identity: false });
  const user = textMessage('今天继续练音程辨认', { id: 'user-1' });

  // 只模拟旧实现的注入点（outer prepend + next 后 append），不模拟最终数组。
  bus.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind === 'reject' || Number(payload?.step) !== 1) return decision;
    return { ...decision, messages: [...decision.messages, legacyBootMessage()] };
  }, { prepend: true });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  assert.deepEqual(decision.messages.map(roleOf), ['user', 'runtime', 'auto', 'boot']);
  const bootIndex = decision.messages.findIndex((m) => roleOf(m) === 'boot');
  assert.equal(bootIndex, decision.messages.length - 1, '旧语义下 boot 被追加到末尾');
});

/* ================================================================== *
 * mustFix #1：firstUserText 污染 —— v2 红 / v3 绿
 * ================================================================== */

function firstText(message) {
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}

/** v2 的 session/event 实现：只按 type 取第一条 user/message，不区分注入。 */
function legacyFirstUserText(events) {
  const first = (Array.isArray(events) ? events : []).find((e) => e?.type === 'user/message');
  return first ? firstText(first.data) : '';
}

function userMessageEvent(message, seq) {
  return { type: 'user/message', data: message, seq };
}

const BOOT_TOKEN = '开机卡专属词';
const USER_TOKEN = '真实问题词';

/** 污染回归共用夹具：STATE.md 与一张 topic 都含开机卡专属词，另一张只含真实问题词。 */
function makePollutionMemory(t) {
  const state = [
    '## 我在哪',
    `- ${BOOT_TOKEN}：这句只该出现在 STATE.md 和开机卡里。`,
    '## 在等什么',
    '- 红队验收',
    '## 最近三件',
    '- 修污染',
  ].join('\n');
  const card = (title) => [
    '---',
    `title: ${title}`,
    `scope_in: ["${title}"]`,
    '---',
    `# ${title}`,
    `- ${title}：这是测试卡。`,
  ].join('\n');
  return makeMemory(t, {
    state,
    topics: { 'boot-token.md': card(BOOT_TOKEN), 'user-token.md': card(USER_TOKEN) },
  });
}

test('污染回归：v2 把【开机卡】当 firstUserText（红），v3 跳过注入消息（绿）', async (t) => {
  const memoryRoot = makePollutionMemory(t);
  const { bus } = makeStack({ memoryRoot });
  const user = textMessage('今天先随便聊聊，不开工。', { id: 'user-1' });

  const first = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  const boot = first.decision.messages.find((m) => roleOf(m) === 'boot');
  assert.ok(boot, '第一轮应注入开机卡');
  assert.match(textOf(boot), new RegExp(BOOT_TOKEN), '开机卡正文带着专属词（污染源）');

  // v2 的现实：boot 在最前 → 事件流里第一条 user/message 就是开机卡。
  const events = [
    userMessageEvent(boot, 1),
    userMessageEvent(user, 2),
    userMessageEvent(runtimeMessage(), 3),
  ];
  const legacyText = legacyFirstUserText(events);
  assert.equal(legacyText, textOf(boot), '红：v2 把开机卡当首条用户消息');
  const cards = loadCards(memoryRoot, { dirs: ['topics'] });
  const legacyQuery = buildQueryText({
    firstUserText: legacyText,
    recentTexts: [`${USER_TOKEN}是什么`],
    cwd: process.cwd(),
  });
  const legacyHits = chooseRecall({ queryText: legacyQuery, cards, options: { minScore: 0.7 } });
  const legacyPaths = legacyHits.items.map((item) => item.path);
  assert.ok(
    legacyPaths.some((p) => p.includes('boot-token')),
    `红：污染查询会召回开机卡专属词卡，实际 ${legacyPaths.join(',')}`,
  );

  // v3：把同一段「boot 在前」的事件流喂给真实 handler；注入消息必须被跳过。
  for (const event of events) await bus.emit('session/event', { id: AGENT.session.id }, event);
  await bus.emit('session/event', { id: AGENT.session.id }, { type: 'turn/end', data: { turn: 1 } });
  await bus.emit('session/event', { id: AGENT.session.id }, { type: 'compaction/end' });

  const turn2 = textMessage(`${USER_TOKEN}是什么`, { id: 'user-2' });
  const second = await bus.compose({
    messages: [turn2], agent: AGENT, turn: 2, step: 1, context: runtimeMessage(),
  });
  const auto = second.decision.messages.find((m) => roleOf(m) === 'auto');
  assert.ok(auto, '第二轮应召回真实问题词卡');
  assert.match(textOf(auto), new RegExp(USER_TOKEN));
  assert.doesNotMatch(textOf(auto), new RegExp(BOOT_TOKEN), '绿：开机卡专属词不能再借 firstUserText 混进第二轮');
});

test('实测：v3 真实两轮事件流（user→boot→runtime）不污染第二轮查询', async (t) => {
  const memoryRoot = makePollutionMemory(t);
  const { bus } = makeStack({ memoryRoot });
  const turn1 = textMessage('今天先随便聊聊，不开工。', { id: 'user-1' });

  const first = await bus.compose({
    messages: [turn1], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  assert.deepEqual(first.decision.messages.map(roleOf), ['user', 'boot', 'runtime']);

  // 严格按 decision.messages 顺序发事件，镜像宿主 step() 的 session 写入。
  let seq = 1;
  for (const message of first.decision.messages) {
    await bus.emit('session/event', { id: AGENT.session.id }, userMessageEvent(message, seq));
    seq += 1;
  }
  await bus.emit('session/event', { id: AGENT.session.id }, { type: 'turn/end', data: { turn: 1 } });
  await bus.emit('session/event', { id: AGENT.session.id }, { type: 'compaction/end' });

  const turn2 = textMessage(`${USER_TOKEN}是什么`, { id: 'user-2' });
  const second = await bus.compose({
    messages: [turn2], agent: AGENT, turn: 2, step: 1, context: runtimeMessage(),
  });
  const auto = second.decision.messages.find((m) => roleOf(m) === 'auto');
  assert.ok(auto, '第二轮应召回真实问题词卡');
  assert.match(textOf(auto), new RegExp(USER_TOKEN));
  assert.doesNotMatch(textOf(auto), new RegExp(BOOT_TOKEN));

  // 同一时刻 TurnNavigator 拿到的仍是用户原话。
  assert.equal(firstVisibleUserPrompt(first.decision.messages), textOf(turn1));
});

/* ================================================================== *
 * boot 在 user 之后 + 路径去重：auto 仍看得到，且不重复注入同一张 handover
 * ================================================================== */

test('apply() 集成：boot 在 user 之后时 auto 仍看得到，且不重复注入同一张 handover', async (t) => {
  const memoryRoot = makeMemory(t, { topics: { 'ear.md': TOPIC_CARD }, handover: { '2026-11-04-boot.md': HANDOVER_CARD } });
  const { bus } = makeStack({ memoryRoot });
  const user = textMessage('测试交接卡一 和 音程辨认 都看一下', { id: 'user-1' });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  const auto = decision.messages.find((m) => roleOf(m) === 'auto');
  assert.ok(auto, 'auto 应该有注入');
  const autoText = textOf(auto);
  assert.match(autoText, /听觉训练/);
  assert.doesNotMatch(autoText, /测试交接卡一|handover\//, 'identity 已注入的 handover 卡不能再由 auto 注入');
});

/* ================================================================== *
 * 首轮 handover 不该被无条件吞掉（P2 handover-suppressed）
 * ================================================================== */

test('apply() 集成：没装 identity 时首轮 handover 仍可被 auto 召回', async (t) => {
  const memoryRoot = makeMemory(t, { handover: { '2026-11-04-boot.md': HANDOVER_CARD } });
  const { bus } = makeStack({ memoryRoot, identity: false });
  const user = textMessage('测试交接卡一 接着上次的做', { id: 'user-1' });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  const auto = decision.messages.find((m) => roleOf(m) === 'auto');
  assert.ok(auto, '首轮 handover 应该能被召回，而不是被 sessionStartExcludedPaths 吞掉');
  assert.match(textOf(auto), /测试交接卡一/);
});

/* ================================================================== *
 * PII 路径：整卡 drop；render 层再兜一层 <hidden>
 * ================================================================== */

test('apply() 集成：路径带手机号的卡整卡 drop，注入文本不含号码', async (t) => {
  const piiCard = [
    '---',
    'title: 订单备注',
    'scope_in: ["订单备注"]',
    '---',
    '- 订单备注：按常规口径归档。',
  ].join('\n');
  const memoryRoot = makeMemory(t, { topics: { '13900002222-订单.md': piiCard } });
  const { bus } = makeStack({ memoryRoot, identity: false });
  const user = textMessage('订单备注 该怎么归档', { id: 'user-1' });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  assert.deepEqual(decision.messages.map(roleOf), ['user', 'runtime']);
  assert.doesNotMatch(decision.messages.map(textOf).join('\n'), /13900002222/);
});

test('chooseRecall 路径隐私：命中文件名手机号时整卡 drop 并计入 droppedByPrivacy', () => {
  const result = chooseRecall({
    queryText: '订单备注 该怎么归档',
    cards: [{
      path: 'topics/13900002222-订单.md',
      title: '订单备注',
      body: '- 订单备注：按常规口径归档。',
      scopeIn: ['订单备注'],
      aliases: [],
    }],
    options: { minScore: 0 },
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.hits.droppedByPrivacy, 1);
});

test('renderItemHeader 对路径兜底：命中 PII 只显示 <hidden>', () => {
  const header = renderItemHeader({
    path: 'topics/13900002222-订单.md',
    title: '订单备注',
    score: 1.5,
  });
  assert.ok(header.includes(PRIVACY_HIDDEN_PATH));
  assert.doesNotMatch(header, /13900002222/);

  const clean = renderItemHeader({ path: 'topics/ear.md', title: '听觉训练', score: 1.5 });
  assert.match(clean, /topics\/ear\.md/);
});

/* ================================================================== *
 * 零命中沉默
 * ================================================================== */

test('apply() 集成：零命中时一个字段都不改（decision 原样返回）', async (t) => {
  const memoryRoot = makeMemory(t, { topics: { 'ear.md': TOPIC_CARD } });
  const { bus } = makeStack({ memoryRoot, identity: false });
  const user = textMessage('今天晚饭吃什么', { id: 'user-1' });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  assert.deepEqual(decision.messages.map(roleOf), ['user', 'runtime']);
  assert.equal(decision.messages.some((m) => isAutoMessage(m)), false);
});

/* ================================================================== *
 * source.kind 契约
 * ================================================================== */

test('apply() 集成：注入消息 source.kind 是 session-reference，形状 form/version/references 完整', async (t) => {
  const memoryRoot = makeMemory(t, { topics: { 'ear.md': TOPIC_CARD }, handover: { '2026-11-04-boot.md': HANDOVER_CARD } });
  const { bus } = makeStack({ memoryRoot });
  const user = textMessage('今天继续练音程辨认', { id: 'user-1' });

  const { decision } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  const injected = decision.messages.filter((m) => isAutoMessage(m) || isIdentityMessage(m));
  assert.equal(injected.length, 2, '应各有一条 auto / identity 注入');
  for (const message of injected) {
    assert.equal(message.source?.kind, 'session-reference');
    assert.ok(HOST_SOURCE_KINDS.has(message.source.kind), `kind=${message.source.kind} 不在封闭 union`);
    assert.equal(message.source.form, 'recall');
    assert.equal(message.source.version, 1);
    assert.deepEqual(message.source.references, []);
    assert.equal(message.source.sections, undefined);
    assert.equal(message.source.cardPaths, undefined);
  }
});

/* ================================================================== *
 * reject 时撤回 boot（不在 claimed 里留半个注入）
 * ================================================================== */

test('apply() 集成：下游 reject 时 identity 撤回已 prepend 的 boot', async (t) => {
  const memoryRoot = makeMemory(t, { handover: { '2026-11-04-boot.md': HANDOVER_CARD } });
  const { bus } = makeStack({ memoryRoot, identity: true, auto: false });
  bus.on('agent/pre-step', async () => ({ kind: 'reject', reason: 'test-reject' }), { prepend: false });
  const user = textMessage('任意消息', { id: 'user-1' });

  const { decision, claimed } = await bus.compose({
    messages: [user], agent: AGENT, turn: 1, step: 1, context: runtimeMessage(),
  });
  assert.equal(decision.kind, 'reject');
  assert.deepEqual(claimed.map(roleOf), ['user'], 'reject 后 claimed 里不能残留 boot');
});

/* ================================================================== *
 * 类型契约：直接读宿主 MessageSourceMap 的声明，不靠手抄列表
 * ================================================================== */

function declaredString(source, name) {
  const at = source.indexOf(`"name": "${name}"`);
  if (at === -1) return null;
  const key = '"declaration": "';
  const start = source.indexOf(key, at);
  if (start === -1) return null;
  let i = start + key.length;
  let escaped = false;
  let raw = '';
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) { raw += `\\${ch}`; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') break;
    raw += ch;
  }
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return null;
  }
}

test('宿主类型：MessageSourceMap 是封闭 union，包含 user、不含 plugin:*', (t) => {
  const candidates = [
    process.env.DSH_LLM_TYPERT,
    'C:/work/redteam2/asar-extract/dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js',
  ].filter(Boolean);
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return t.skip('没有宿主类型文件（设置 DSH_LLM_TYPERT 可补跑）');

  const declaration = declaredString(fs.readFileSync(file, 'utf8'), 'MessageSourceMap');
  assert.ok(declaration, '没能解析出 MessageSourceMap 声明');
  assert.match(declaration, /user:\s*\{\s*kind:\s*'user';\s*\}/);
  assert.doesNotMatch(declaration, /plugin:/, '宿主 union 里不应有 plugin:*');
  // 本测试与 apply 集成里的 HOST_SOURCE_KINDS 互相独立：一个读声明，一个读运行时消息。
});
