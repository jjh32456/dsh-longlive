// identity-router v0 单测。零依赖：node test/run.mjs
// 覆盖：STATE 缺失/字段缺失、多卡取最新、超长截断、中文路径、空内容、
//       插件注入（pre-step）、reject 透传、子代理跳过、周期/销毁写草稿。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_CHARS,
  buildOpenCard,
  charLength,
  collectOpenCard,
  extractSections,
  findSection,
  normalizeHeading,
  parseState,
  selectLatestHandover,
  sortHandoverCards,
  summarizeHandover,
  truncateChars,
} from '../../src/identity/handover.js';
import {
  buildHandoverDraft,
  normalizeItems,
  slugifyTopic,
  writeHandoverDraft,
  writeHandoverFromState,
} from '../../src/identity/writeback.js';
import { apply, normalizeConfig } from '../../src/identity/index.js';
import {
  insertionIndex,
  placeAfterFirstHuman,
} from '../../src/identity/inject-position.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tempDirs = [];

function makeTemp(prefix = 'identity-router-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const STATE_FIXTURE = `# 听澜状态卡

## 2026-11-03 21:47 · rc.9 真机 + scope 落卡
**下一步（最紧三条）**
- 这是粗体小标题下的内容，不该被当成「我在哪」

## 我在哪（2026-11-03 19:55 更新）
- 在 C:\\work\\identity-router 写插件
- 卡在 agent/pre-step 注入

## 在等什么
- 等父代理验收

## 最近三件
1. 读完宿主钩子
2. 写完 handover.js
3. 准备写测试

## 我现在在哪
- 干扰项：不该被精确匹配取到

## 最近三件未完成
- 干扰项：不该被精确匹配取到
`;

const HANDOVER_FIXTURE = `# longlive 0.2 设计要点

## 一句话

把长期记忆做成会话心跳。

## 三层

- 状态卡
- 交接卡
- 流程卡
`;

function makeCtx() {
  const handlers = new Map();
  return {
    handlers,
    logger: { info() {}, warn() {} },
    on(event, fn) {
      handlers.set(event, fn);
    },
  };
}

function makeAgent(id = 'sess-test-0001', origin) {
  return {
    id,
    session: {
      id,
      header: origin ? { origin } : {},
    },
  };
}

// ---------------------------------------------------------------------------
// handover.js
// ---------------------------------------------------------------------------

test('STATE 正常：三节都抓到，卡片含关键文本且不超 800 字', () => {
  const card = buildOpenCard({
    stateText: STATE_FIXTURE,
    handover: { name: '2026-11-01-longlive.md', text: HANDOVER_FIXTURE },
    now: new Date(2026, 10, 4, 9, 30),
  });
  assert.equal(card.truncated, false);
  assert.ok(card.chars <= DEFAULT_MAX_CHARS);
  assert.match(card.text, /【开机卡】2026-11-04 09:30/);
  assert.match(card.text, /在 C:\\work\\identity-router 写插件/);
  assert.match(card.text, /等父代理验收/);
  assert.match(card.text, /读完宿主钩子/);
  assert.match(card.text, /把长期记忆做成会话心跳/);
  assert.deepEqual(card.found, { where: true, waiting: true, recent: true, handover: true });
  assert.equal(card.warnings.length, 0);
});

test('STATE 缺失：不抛，给占位并记 STATE_MISSING', () => {
  const card = buildOpenCard({
    stateText: null,
    handover: null,
    now: new Date(2026, 10, 4, 9, 30),
  });
  assert.ok(card.text.length > 0);
  assert.ok(card.warnings.includes('STATE_MISSING'));
  assert.ok(card.warnings.includes('HANDOVER_MISSING'));
  assert.match(card.text, /STATE\.md 里没有这一节/);
  assert.equal(card.found.where, false);
});

test('字段缺失：只给「我在哪」，其余节用占位，不编造', () => {
  const card = buildOpenCard({
    stateText: '# 卡\n\n## 我在哪\n- 只在写测试\n',
    handover: { name: '2026-11-02-x.md', text: '# X\n\n## 一句话\n测试卡。\n' },
    now: new Date(2026, 10, 4),
  });
  assert.equal(card.found.where, true);
  assert.equal(card.found.waiting, false);
  assert.equal(card.found.recent, false);
  assert.ok(card.warnings.includes('SECTION_MISSING:在等什么'));
  assert.ok(card.warnings.includes('SECTION_MISSING:最近三件'));
  assert.match(card.text, /只在写测试/);
  assert.match(card.text, /STATE\.md 里没有这一节/);
});

test('近似标题不误匹配：「我现在在哪」「最近三件未完成」不算', () => {
  const parsed = parseState(STATE_FIXTURE);
  assert.ok(findSection(parsed.sections, '我在哪'));
  assert.ok(findSection(parsed.sections, '最近三件'));
  const where = findSection(parsed.sections, '我在哪');
  assert.match(where.content, /identity-router/);
  assert.doesNotMatch(where.content, /干扰项/);
  const recent = findSection(parsed.sections, '最近三件');
  assert.match(recent.content, /准备写测试/);
  assert.doesNotMatch(recent.content, /干扰项/);
});

test('标题归一化剥括号注释，但不等于近似标题', () => {
  assert.equal(normalizeHeading('## 我在哪（2026-11-03 更新）'), '我在哪');
  assert.equal(normalizeHeading('## 在等什么'), '在等什么');
  assert.notEqual(normalizeHeading('## 我现在在哪'), '我在哪');
  assert.notEqual(normalizeHeading('## 最近三件未完成'), '最近三件');
});

test('代码围栏里的 ## 不当标题', () => {
  const markdown = [
    '# 卡',
    '',
    '```md',
    '## 我在哪',
    '这是假货',
    '```',
    '',
    '## 我在哪',
    '- 这是真的',
  ].join('\n');
  const sections = extractSections(markdown);
  const where = sections.filter((section) => section.title === '我在哪');
  assert.equal(where.length, 1);
  assert.match(where[0].content, /这是真的/);
  assert.doesNotMatch(where[0].content, /假货/);
});

test('BOM + CRLF 也能正常解析', () => {
  const markdown = '\uFEFF# 标题\r\n\r\n## 我在哪\r\n- Windows 换行\r\n';
  const parsed = parseState(markdown);
  assert.ok(parsed.found.where);
  assert.match(findSection(parsed.sections, '我在哪').content, /Windows 换行/);
});

test('多张交接卡按文件名日期取最新（mtime 更新的旧卡不抢位）', () => {
  const entries = [
    { name: '2026-10-31-surgery.md', mtimeMs: 9_999_999_999_999 },
    { name: '2026-11-01-longlive-0.2.md', mtimeMs: 1 },
    { name: '2026-10-27-old.md', mtimeMs: 5 },
  ];
  const sorted = sortHandoverCards(entries);
  assert.equal(sorted[0].name, '2026-11-01-longlive-0.2.md');
  assert.equal(selectLatestHandover(entries).name, '2026-11-01-longlive-0.2.md');
});

test('无日期卡片按 mtime 排序并排在日期卡之后', () => {
  const sorted = sortHandoverCards([
    { name: 'note.md', mtimeMs: 100 },
    { name: '2026-11-01-a.md', mtimeMs: 1 },
    { name: 'scratch.md', mtimeMs: 200 },
  ]);
  assert.equal(sorted[0].name, '2026-11-01-a.md');
  assert.deepEqual(sorted.slice(1).map((item) => item.name), ['scratch.md', 'note.md']);
});

test('超长截断：300 字上限下长度不超，且标记 truncated', () => {
  const long = Array.from({ length: 80 }, (_, index) => `- 第 ${index + 1} 条很长很长的进度描述`).join('\n');
  const card = buildOpenCard({
    stateText: `# 卡\n\n## 我在哪\n${long}\n\n## 在等什么\n${long}\n\n## 最近三件\n${long}\n`,
    handover: { name: '2026-11-01-x.md', text: `# 卡\n\n## 一句话\n${'交接内容'.repeat(200)}` },
    maxChars: 300,
    now: new Date(2026, 10, 4),
  });
  assert.ok(charLength(card.text) <= 300, `实际 ${charLength(card.text)}`);
  assert.equal(card.truncated, true);
  assert.ok(card.warnings.includes('CARD_TRUNCATED') || card.warnings.includes('SECTION_TRUNCATED'));
});

test('极小上限 120 也不越界', () => {
  const card = buildOpenCard({
    stateText: STATE_FIXTURE,
    handover: { name: '2026-11-01-x.md', text: HANDOVER_FIXTURE },
    maxChars: 120,
  });
  assert.ok(card.chars <= 120, `实际 ${card.chars}`);
});

test('中文路径：STATE 与 handover 都能读', () => {
  const root = path.join(makeTemp('身份路由-'), '记忆 根');
  const handoverDir = path.join(root, 'handover');
  fs.mkdirSync(handoverDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_FIXTURE, 'utf8');
  fs.writeFileSync(
    path.join(handoverDir, '2026-11-01-中文卡.md'),
    '# 中文交接卡\n\n## 一句话\n中文交接内容。\n',
    'utf8',
  );

  const card = collectOpenCard({ memoryRoot: root, now: new Date(2026, 10, 4) });
  assert.deepEqual(card.errors, []);
  assert.match(card.text, /中文交接内容/);
  assert.ok(card.handoverPath.endsWith('2026-11-01-中文卡.md'));
});

test('空内容：空 STATE + 空 handover 不抛，全占位', () => {
  const card = buildOpenCard({ stateText: '', handover: { name: 'empty.md', text: '' } });
  assert.ok(card.warnings.includes('STATE_EMPTY'));
  assert.ok(card.warnings.includes('HANDOVER_EMPTY'));
  assert.ok(card.chars > 0);
  assert.equal(card.truncated, false);
});

test('空 handover 目录：HANDOVER_MISSING，但卡照常生成', () => {
  const root = makeTemp();
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_FIXTURE, 'utf8');
  fs.mkdirSync(path.join(root, 'handover'), { recursive: true });
  const card = collectOpenCard({ memoryRoot: root });
  assert.ok(card.warnings.includes('HANDOVER_MISSING'));
  assert.equal(card.handoverPath, null);
  assert.match(card.text, /没有找到交接卡/);
});

test('最新交接卡是空文件：回退到旧卡并告警', () => {
  const root = makeTemp();
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_FIXTURE, 'utf8');
  const handoverDir = path.join(root, 'handover');
  fs.mkdirSync(handoverDir, { recursive: true });
  fs.writeFileSync(path.join(handoverDir, '2026-11-01-empty.md'), '', 'utf8');
  fs.writeFileSync(
    path.join(handoverDir, '2026-10-27-old.md'),
    '# 旧卡\n\n## 一句话\n旧卡也要能接上。\n',
    'utf8',
  );
  const card = collectOpenCard({ memoryRoot: root });
  assert.ok(card.warnings.includes('HANDOVER_LATEST_EMPTY'));
  assert.match(card.text, /旧卡也要能接上/);
  assert.ok(card.handoverPath.endsWith('2026-10-27-old.md'));
});

test('交接卡摘要优先取「一句话」，带标题', () => {
  const summary = summarizeHandover(HANDOVER_FIXTURE, 200);
  assert.match(summary.text, /^《longlive 0\.2 设计要点》/);
  assert.match(summary.text, /把长期记忆做成会话心跳/);
  assert.equal(summary.truncated, false);
});

test('交接卡有标题时不再重复文件名标签', () => {
  const card = buildOpenCard({
    stateText: STATE_FIXTURE,
    handover: { name: '2026-11-01-longlive-0.2-设计要点.md', text: HANDOVER_FIXTURE },
    now: new Date(2026, 10, 4),
  });
  const occurrences = card.text.match(/longlive 0\.2 设计要点/gu) ?? [];
  assert.equal(occurrences.length, 1);
  assert.doesNotMatch(card.text, /2026-11-01-longlive/);
});

test('truncateChars 按码点计数，emoji 不被劈成两半', () => {
  const cut = truncateChars('鲸鱼🐳鲸鱼🐳鲸鱼', 6);
  assert.equal(charLength(cut.text), 6);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.endsWith('…'));
});

// ---------------------------------------------------------------------------
// writeback.js
// ---------------------------------------------------------------------------

test('从 STATE 生成草稿：进度与下一步来自三节，不编造', () => {
  const draft = buildHandoverDraft({
    topic: 'identity-router v0',
    stateText: STATE_FIXTURE,
    now: new Date(2026, 10, 4, 10, 5),
  });
  assert.ok(draft.text.includes('# 交接卡草稿：identity-router v0'));
  assert.ok(draft.text.includes('## 当前进度'));
  assert.ok(draft.text.includes('【我在哪】'));
  assert.ok(draft.text.includes('【最近三件】'));
  assert.ok(draft.text.includes('## 下一步'));
  assert.ok(draft.text.includes('等父代理验收'));
  assert.ok(draft.text.includes('## 风险'));
  assert.ok(draft.text.includes('尚未写入 memoryRoot'));
  assert.equal(draft.filename, '2026-11-04-identity-router-v0.md');
  assert.ok(draft.chars <= 1600);
  assert.ok(!draft.warnings.includes('DRAFT_USED_STATE_FALLBACK'));
});

test('显式 progress/next/risks 覆盖 STATE 推导', () => {
  const draft = buildHandoverDraft({
    topic: '手动卡',
    stateText: STATE_FIXTURE,
    progress: ['改完 handover.js', '写完 writeback.js'],
    next: '补事件注入',
    risks: ['钩子没在真机验证'],
    now: new Date(2026, 10, 4),
  });
  assert.match(draft.text, /- 改完 handover\.js/);
  assert.match(draft.text, /- 补事件注入/);
  assert.match(draft.text, /- 钩子没在真机验证/);
  assert.doesNotMatch(draft.text, /【我在哪】/);
});

test('中文 topic 的 slug 回退为 session，文件名仍是合法 ASCII', () => {
  assert.equal(slugifyTopic('身份路由 v0'), 'v0');
  assert.equal(slugifyTopic('完全中文'), 'session');
  const draft = buildHandoverDraft({ topic: '完全中文', progress: ['x'], next: ['y'], now: new Date(2026, 0, 2) });
  assert.equal(draft.filename, '2026-01-02-session.md');
});

test('写草稿：创建 outbox，重名自动加 -2 不覆盖', () => {
  const outbox = path.join(makeTemp(), 'outbox');
  const draft = buildHandoverDraft({
    topic: 'collision',
    progress: ['第一版'],
    next: ['继续'],
    risks: ['无'],
    now: new Date(2026, 10, 4),
  });
  const first = writeHandoverDraft(draft, { outboxDir: outbox });
  const second = writeHandoverDraft(draft, { outboxDir: outbox });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.ok(first.path.endsWith('2026-11-04-collision.md'));
  assert.ok(second.path.endsWith('2026-11-04-collision-2.md'));
  assert.equal(fs.readFileSync(first.path, 'utf8'), draft.text);
});

test('writeHandoverFromState：中文路径下读 STATE、写 outbox', () => {
  const root = path.join(makeTemp('身份路由-'), '记忆 根');
  fs.mkdirSync(root, { recursive: true });
  const statePath = path.join(root, 'STATE.md');
  fs.writeFileSync(statePath, STATE_FIXTURE, 'utf8');
  const outbox = path.join(root, 'outbox 目录');

  const result = writeHandoverFromState({
    statePath,
    outboxDir: outbox,
    topic: '中文路径测试',
    now: new Date(2026, 10, 4, 11, 0),
  });
  assert.equal(result.ok, true);
  assert.ok(result.path.startsWith(outbox));
  const text = fs.readFileSync(result.path, 'utf8');
  assert.match(text, /【我在哪】/);
  assert.match(text, /2026-11-04 11:00/);
});

test('STATE 读不到时草稿仍可写，但带占位与警告', () => {
  const outbox = makeTemp();
  const result = writeHandoverFromState({
    statePath: path.join(outbox, 'missing-STATE.md'),
    outboxDir: path.join(outbox, 'out'),
    topic: 'missing',
    now: new Date(2026, 10, 4),
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.includes('STATE_READ_FAILED:ENOENT'));
  assert.ok(result.warnings.includes('DRAFT_USED_STATE_FALLBACK'));
  assert.match(result.text, /未提供 STATE\.md/);
});

test('normalizeItems 去 bullet、拆多行、过滤空项', () => {
  assert.deepEqual(normalizeItems('- a\n2. b\n\n* c'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeItems(['x', ['y', 'z']]), ['x', 'y', 'z']);
  assert.deepEqual(normalizeItems(''), []);
});

// ---------------------------------------------------------------------------
// index.js（插件外壳）
// ---------------------------------------------------------------------------

test('normalizeConfig 钳制坏值，默认值稳定', () => {
  const config = normalizeConfig({
    maxChars: 10,
    writeEveryTurns: -5,
    memoryRoot: '  ',
    log: 'yes',
  });
  assert.equal(config.maxChars, 120);
  assert.equal(config.writeEveryTurns, 0);
  assert.equal(config.memoryRoot, undefined);
  assert.equal(config.log, false);
  assert.equal(normalizeConfig({ maxChars: 99999 }).maxChars, 4000);
  assert.equal(normalizeConfig({ maxChars: 'abc' }).maxChars, 800);
});

test('pre-step 第一轮注入一次，第二轮同一会话不再注入', async () => {
  const root = makeTemp();
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_FIXTURE, 'utf8');
  fs.mkdirSync(path.join(root, 'handover'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'handover', '2026-11-01-x.md'),
    HANDOVER_FIXTURE,
    'utf8',
  );

  const ctx = makeCtx();
  const injected = [];
  apply(ctx, {
    memoryRoot: root,
    outboxDir: path.join(root, 'outbox'),
    createUserMessage: (input) => {
      injected.push(input);
      return { role: 'user', ...input };
    },
    writeOnTurnEnd: false,
    writeOnSessionEnd: false,
  });

  const agent = makeAgent('sess-inject-01');
  const decision = { kind: 'enter', messages: [] };
  const preStep = ctx.handlers.get('agent/pre-step');
  const first = await preStep({ agent, step: 1, turn: 1 }, async () => decision);
  assert.equal(first.messages.length, 1);
  assert.equal(injected.length, 1);
  assert.match(injected[0].content[0].text, /【开机卡】/);
  assert.equal(injected[0].source.kind, 'session-reference');
  assert.equal(injected[0].source.form, 'recall');
  assert.equal(injected[0].source.version, 1);
  assert.deepEqual(injected[0].source.references, []);
  assert.equal(injected[0].source.sections, undefined);

  const second = await preStep({ agent, step: 1, turn: 2 }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(second.messages.length, 0);
  assert.equal(injected.length, 1);
});

test('pre-step 拒绝坏 source.kind：工厂产物不进 decision，也不写日志', async () => {
  const root = makeTemp();
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_FIXTURE, 'utf8');
  fs.mkdirSync(path.join(root, 'handover'), { recursive: true });
  fs.writeFileSync(path.join(root, 'handover', '2026-11-01-x.md'), HANDOVER_FIXTURE, 'utf8');

  const ctx = makeCtx();
  const injected = [];
  apply(ctx, {
    memoryRoot: root,
    outboxDir: path.join(root, 'outbox'),
    createUserMessage: (input) => {
      const message = { role: 'user', ...input, source: { kind: 'plugin:bogus' } };
      injected.push(message);
      return message;
    },
    writeOnTurnEnd: false,
    writeOnSessionEnd: false,
  });

  const agent = makeAgent('sess-bad-kind');
  const decision = { kind: 'enter', messages: [] };
  const preStep = ctx.handlers.get('agent/pre-step');
  const out = await preStep({ agent, step: 1, turn: 1 }, async () => decision);
  assert.equal(injected.length, 1, '工厂确实被调用过');
  assert.equal(out.messages.length, 0, '坏 kind 注入必须被拒绝，不能 append');
  assert.equal(out.messages.some((m) => m.source?.kind === 'plugin:bogus'), false);
});

test('inject-position：插到第一条真实 user 之后，且不把 runtime-context 当人话', () => {
  const user1 = { role: 'user', content: [{ type: 'text', text: '一' }], source: { kind: 'user' } };
  const runtime = {
    role: 'user',
    content: [{ type: 'text', text: 'runtime' }],
    source: { kind: 'runtime-context' },
  };
  const user2 = { role: 'user', content: [{ type: 'text', text: '二' }], source: { kind: 'user' } };
  assert.equal(insertionIndex([user1, user2]), 1);
  assert.equal(insertionIndex([user1, runtime, user2]), 1);
  assert.equal(insertionIndex([runtime]), 0, '没有真实用户消息时退回最前面');

  const boot = { role: 'user', content: [{ type: 'text', text: '【开机卡】' }], source: { kind: 'user' } };
  assert.deepEqual(placeAfterFirstHuman([user1, user2], boot), [user1, boot, user2]);
  // 幂等：已经就位时不重复插入。
  assert.deepEqual(placeAfterFirstHuman([user1, boot, user2], boot), [user1, boot, user2]);
  // 被旧实现 unshift 到最前的 boot 会被搬到 user 后面。
  assert.deepEqual(placeAfterFirstHuman([boot, user1, user2], boot), [user1, boot, user2]);
});

test('pre-step 把开机卡插在第一条真实 user 之后（claimed 路径）', async () => {
  const root = makeTemp();
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_FIXTURE, 'utf8');
  fs.mkdirSync(path.join(root, 'handover'), { recursive: true });
  fs.writeFileSync(path.join(root, 'handover', '2026-11-01-x.md'), HANDOVER_FIXTURE, 'utf8');

  const ctx = makeCtx();
  const injected = [];
  apply(ctx, {
    memoryRoot: root,
    outboxDir: path.join(root, 'outbox'),
    createUserMessage: (input) => {
      const message = { role: 'user', ...input };
      injected.push(message);
      return message;
    },
    writeOnTurnEnd: false,
    writeOnSessionEnd: false,
  });

  const agent = makeAgent('sess-inject-claimed');
  const user1 = { role: 'user', content: [{ type: 'text', text: '真实提问一' }], source: { kind: 'user' } };
  const user2 = { role: 'user', content: [{ type: 'text', text: '真实提问二' }], source: { kind: 'user' } };
  const runtime = {
    role: 'user',
    content: [{ type: 'text', text: 'runtime context' }],
    source: { kind: 'runtime-context' },
  };
  const claimed = [user1, user2];
  const preStep = ctx.handlers.get('agent/pre-step');
  const decision = await preStep(
    { agent, messages: claimed, step: 1, turn: 1 },
    async () => ({ kind: 'enter', messages: [...claimed, runtime] }),
  );

  assert.equal(injected.length, 1);
  assert.deepEqual(decision.messages, [user1, injected[0], user2, runtime]);
  // TurnNavigator 取该轮第一个 kind==='user' 节点 → 必须是用户原话。
  assert.equal(decision.messages[0], user1);
  assert.equal(decision.messages[0].content[0].text, '真实提问一');
  assert.match(injected[0].content[0].text, /【开机卡】/);
});

test('pre-step 对 reject 原样透传，不注入', async () => {
  const ctx = makeCtx();
  apply(ctx, {
    statePath: path.join(makeTemp(), 'STATE.md'),
    createUserMessage: () => {
      throw new Error('不该被调用');
    },
    writeOnTurnEnd: false,
    writeOnSessionEnd: false,
  });
  const reject = { kind: 'reject' };
  const result = await ctx.handlers.get('agent/pre-step')(
    { agent: makeAgent('sess-reject'), step: 1, turn: 1 },
    async () => reject,
  );
  assert.equal(result, reject);
});

test('子代理默认跳过注入', async () => {
  const ctx = makeCtx();
  let called = 0;
  apply(ctx, {
    statePath: path.join(makeTemp(), 'STATE.md'),
    createUserMessage: () => {
      called += 1;
      return { role: 'user' };
    },
    writeOnTurnEnd: false,
    writeOnSessionEnd: false,
  });
  const agent = makeAgent('sess-sub', 'subagent');
  const result = await ctx.handlers.get('agent/pre-step')(
    { agent, step: 1, turn: 1 },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(result.messages.length, 0);
  assert.equal(called, 0);
});

test('turn/end 每 N 轮写一次草稿，不重复', () => {
  const root = makeTemp();
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_FIXTURE, 'utf8');
  const outbox = path.join(root, 'outbox');
  const ctx = makeCtx();
  apply(ctx, {
    memoryRoot: root,
    outboxDir: outbox,
    writeEveryTurns: 2,
    writeOnSessionEnd: false,
  });

  const session = { id: 'sess-turns-1234', header: {} };
  const onEvent = ctx.handlers.get('session/event');
  onEvent(session, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(fs.existsSync(outbox) ? fs.readdirSync(outbox).length : 0, 0);
  onEvent(session, { type: 'turn/end', data: { turn: 2 } });
  const files = fs.readdirSync(outbox).filter((file) => file.endsWith('.md'));
  assert.equal(files.length, 1);
  assert.match(files[0], /identity-router-1234/);
  onEvent(session, { type: 'turn/end', data: { turn: 3 } });
  assert.equal(fs.readdirSync(outbox).filter((file) => file.endsWith('.md')).length, 1);
});

test('writeback 也尊重 statePath 配置，不只 memoryRoot', () => {
  const root = makeTemp();
  const statePath = path.join(root, 'STATE.md');
  fs.writeFileSync(statePath, STATE_FIXTURE, 'utf8');
  const outbox = path.join(root, 'outbox');
  const ctx = makeCtx();
  apply(ctx, {
    statePath,
    outboxDir: outbox,
    writeEveryTurns: 1,
    writeOnSessionEnd: false,
  });
  ctx.handlers.get('session/event')(
    { id: 'sess-statepath-77', header: {} },
    { type: 'turn/end', data: { turn: 1 } },
  );
  const files = fs.readdirSync(outbox).filter((file) => file.endsWith('.md'));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(outbox, files[0]), 'utf8');
  assert.match(text, /在 C:\\work\\identity-router 写插件/);
});

test('session/disposed 写最后一张草稿，且只写一次', () => {
  const root = makeTemp();
  fs.writeFileSync(path.join(root, 'STATE.md'), STATE_FIXTURE, 'utf8');
  const outbox = path.join(root, 'outbox');
  const ctx = makeCtx();
  apply(ctx, {
    memoryRoot: root,
    outboxDir: outbox,
    writeOnTurnEnd: false,
    writeOnSessionEnd: true,
  });
  const session = { id: 'sess-final-9999', header: {} };
  const disposed = ctx.handlers.get('session/disposed');
  disposed(session);
  disposed(session);
  const files = fs.readdirSync(outbox).filter((file) => file.endsWith('.md'));
  assert.equal(files.length, 1);
});

test('注入工厂不可用时跳过注入但不影响 decision', async () => {
  const ctx = makeCtx();
  apply(ctx, {
    statePath: path.join(makeTemp(), 'STATE.md'),
    writeOnTurnEnd: false,
    writeOnSessionEnd: false,
  });
  const decision = { kind: 'enter', messages: [] };
  const result = await ctx.handlers.get('agent/pre-step')(
    { agent: makeAgent('sess-no-factory'), step: 1, turn: 1 },
    async () => decision,
  );
  assert.equal(result, decision);
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

for (const item of tests) {
  try {
    await item.fn();
    passed += 1;
    process.stdout.write(`ok ${passed + failures.length} - ${item.name}\n`);
  } catch (error) {
    failures.push({ name: item.name, error });
    process.stdout.write(`not ok - ${item.name}\n  ${error?.message ?? error}\n`);
  }
}

for (const dir of tempDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 临时目录清不掉不影响测试结论
  }
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed, ${tests.length} total\n`);
if (failures.length > 0) process.exitCode = 1;
