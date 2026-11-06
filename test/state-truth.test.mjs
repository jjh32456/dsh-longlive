// suite: P2 状态诚实（R3 目标新鲜度 / R4 状态诚实 / R6.2 开机卡年龄）
//
// 这一套只测「共享板 / status / 开机卡不说谎」这四件事，全部在 fixture
// memoryRoot 里跑，不读真实记忆根、不装插件、不联网：
//   - R3: live 行的 goalUpdatedAt 只由「写 goal」推进，心跳 tick 不得改它；
//         board.focus.updatedAt = 目标写入时间；目标 >30 分钟未更新时
//         focus 项带 stale:true（board.stale 同步），旧行不编造目标时间。
//   - R4.1: board.pulse.running 按 effectiveState 统计，不再数行自报 state。
//   - R4.2: status 投影取 board 同字段（service.mjs 不再硬编码 running:0）；
//           buildStatus({board}) 透传 board.pulse.running。
//   - R4.3: live 行在 turn/start → running+turn，turn/end → idle/waiting/
//           blocked+turn；心跳 tick 只续 heartbeat、不动 state/turn/last_action。
//   - R6.2: 开机卡逐字含「状态卡写于 X 分钟前」，X 由 STATE.md mtime 与 now
//           计算；拿不到 mtime 时不编造。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LIVE_RECORD_FIELDS,
  liveTouch,
  liveUpdate,
} from '../src/live.js';
import {
  createAutoHeartbeat,
  stateForTurnEnd,
  stateForTurnStart,
  turnBoundaryPlan,
} from '../src/heartbeat.js';
import { createBoardBuilder, FOCUS_STALE_MS, renderFocusLine } from '../src/router/service/board.mjs';
import { renderHint } from '../src/router/service/hint.mjs';
import { buildStatus } from '../src/router/service/status.mjs';
import { createRouterService } from '../src/router/service/service.mjs';
import { MockLlm } from '../src/router/background/mock-llm.mjs';
import { buildOpenCard, collectOpenCard } from '../src/identity/handover.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIN = 60 * 1000;
const BASE_MS = Date.parse('2026-11-06T04:00:00.000Z');

function makeRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `longlive-state-truth-${label}-`));
}

function clean(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function rowPath(root, sessionId) {
  return path.join(root, '.longlive', 'live', `${sessionId}.json`);
}

function readRow(root, sessionId) {
  return JSON.parse(fs.readFileSync(rowPath(root, sessionId), 'utf8'));
}

function writeRow(root, sessionId, record) {
  fs.mkdirSync(path.dirname(rowPath(root, sessionId)), { recursive: true });
  fs.writeFileSync(rowPath(root, sessionId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function buildBoard(root, nowMs, args = {}) {
  const builder = createBoardBuilder({
    memoryRoot: root,
    config: {},
    now: () => new Date(nowMs),
    paths: {},
    seq: 0,
  });
  const snapshot = builder.build(args);
  return snapshot.board;
}

function writeBoard(root, nowMs) {
  const boardFile = path.join(root, 'vault', 'board.json');
  const builder = createBoardBuilder({
    memoryRoot: root,
    config: {},
    now: () => new Date(nowMs),
    paths: { boardFile },
    seq: 0,
  });
  const snapshot = builder.build({});
  const written = builder.write(snapshot);
  return { written, board: written.board, boardFile };
}

// ---------------------------------------------------------------------------
// R3 — 目标新鲜度
// ---------------------------------------------------------------------------

test('R3: goalUpdatedAt 只由写 goal 推进；心跳 touch 不动 goal/目标时间', () => {
  const root = makeRoot('goal-clock');
  const sessionId = 'session-r3-clock';
  try {
    const first = liveUpdate({
      sessionId,
      state: 'running',
      turn: 3,
      goal: '把 libtv S08-S25 渲完并合成',
      last_action: { kind: 'tool', detail: 'pwsh libtv render S08-S10' },
    }, { memoryRoot: root, now: new Date(BASE_MS) });
    assert.equal(first.ok, true);
    assert.equal(first.record.goalUpdatedAt, iso(BASE_MS), 'row carries the goal clock');
    assert.ok(LIVE_RECORD_FIELDS.includes('goalUpdatedAt'), 'goalUpdatedAt 是文档化行字段');

    // 心跳只续 liveness：goalUpdatedAt / goal / state / turn 全部原样。
    liveUpdate({ sessionId, state: 'running', turn: 3 }, { memoryRoot: root, now: new Date(BASE_MS + 5 * MIN) });
    const heartbeatOnly = readRow(root, sessionId);
    assert.equal(heartbeatOnly.heartbeatAt, iso(BASE_MS + 5 * MIN), 'heartbeatAt 前进');
    assert.equal(heartbeatOnly.goalUpdatedAt, iso(BASE_MS), 'goalUpdatedAt 不跟随 heartbeat');
    assert.equal(heartbeatOnly.goal, '把 libtv S08-S25 渲完并合成', 'goal 原样保留');

    // 真正重写 goal 才推进目标时间。
    liveUpdate({
      sessionId,
      state: 'running',
      turn: 4,
      goal: '改渲 S10-S12',
    }, { memoryRoot: root, now: new Date(BASE_MS + 7 * MIN) });
    const rewritten = readRow(root, sessionId);
    assert.equal(rewritten.goalUpdatedAt, iso(BASE_MS + 7 * MIN), '写 goal 才推进目标时间');
    assert.equal(rewritten.goal, '改渲 S10-S12');
  } finally {
    clean(root);
  }
});

test('R3: liveTouch(lastAction:false) 保留 goal 时钟，只动 heartbeat/updatedAt', () => {
  const root = makeRoot('goal-touch');
  const sessionId = 'session-r3-touch';
  try {
    // liveTouch 是自动心跳的写入口（不新建行），这里直接钉它的保留语义。
    liveUpdate({
      sessionId,
      state: 'running',
      turn: 2,
      goal: '写 P2 状态诚实',
      last_action: { kind: 'tool', detail: 'edit board.mjs' },
    }, { memoryRoot: root, now: new Date(BASE_MS) });
    const before = readRow(root, sessionId);
    const touched = liveTouch(sessionId, {
      memoryRoot: root,
      now: new Date(BASE_MS + 5 * MIN),
      lastAction: false,
    });
    assert.equal(touched.ok, true);
    const after = readRow(root, sessionId);
    assert.equal(after.heartbeatAt, iso(BASE_MS + 5 * MIN));
    assert.equal(after.goalUpdatedAt, before.goalUpdatedAt, '心跳不得改目标写入时间');
    assert.deepEqual(after.last_action, before.last_action, 'lastAction:false 保留 last_action');
    assert.equal(after.state, 'running');
    assert.equal(after.turn, 2);
  } finally {
    clean(root);
  }
});

test('R3: focus.updatedAt = 目标写入时间，不是 heartbeatAt', () => {
  const root = makeRoot('focus-time');
  const sessionId = 'session-r3-focus';
  try {
    liveUpdate({
      sessionId,
      state: 'running',
      turn: 3,
      goal: '把 libtv S08-S25 渲完并合成',
    }, { memoryRoot: root, now: new Date(BASE_MS) });
    // 心跳刷新到 5 分钟后；目标仍在 0 分钟处。
    liveUpdate({ sessionId, state: 'running', turn: 3 }, { memoryRoot: root, now: new Date(BASE_MS + 5 * MIN) });

    const board = buildBoard(root, BASE_MS + 5 * MIN);
    const focus = board.focus.find((item) => item.sessionId === sessionId);
    assert.ok(focus, 'focus 里应有该会话');
    assert.equal(focus.updatedAt, iso(BASE_MS), 'updatedAt 命中目标写入时间');
    assert.notEqual(focus.updatedAt, iso(BASE_MS + 5 * MIN), 'updatedAt 不是心跳时间');
    assert.equal(focus.stale, undefined, '新鲜目标不带 stale 键（持久化形状不变）');
    assert.equal(board.stale, false);
  } finally {
    clean(root);
  }
});

test('R3: 目标 31 分钟未更新 → focus.stale:true + board.stale + 渲染行可见', () => {
  const root = makeRoot('focus-stale');
  const sessionId = 'session-r3-stale';
  try {
    liveUpdate({
      sessionId,
      state: 'running',
      turn: 3,
      goal: '把 libtv S08-S25 渲完并合成',
    }, { memoryRoot: root, now: new Date(BASE_MS) });
    liveUpdate({ sessionId, state: 'running', turn: 3 }, { memoryRoot: root, now: new Date(BASE_MS + 31 * MIN) });

    const board = buildBoard(root, BASE_MS + 31 * MIN);
    const focus = board.focus.find((item) => item.sessionId === sessionId);
    assert.ok(focus);
    assert.equal(focus.stale, true, '目标 31 分钟没更新必须标 stale');
    assert.equal(focus.updatedAt, iso(BASE_MS), 'stale 但 updatedAt 仍是目标时间');
    assert.equal(board.stale, true, 'board 级聚合同步');
    assert.match(renderFocusLine(focus), /stale|过期|不新鲜/i, '渲染行里 stale 可见');
    assert.ok(FOCUS_STALE_MS === 30 * MIN, '阈值固定 30 分钟');
  } finally {
    clean(root);
  }
});

test('R3: 29 分钟未更新不标 stale（30 分钟阈值边界）', () => {
  const root = makeRoot('focus-fresh29');
  const sessionId = 'session-r3-fresh';
  try {
    liveUpdate({
      sessionId,
      state: 'running',
      goal: '跑 361 用例',
    }, { memoryRoot: root, now: new Date(BASE_MS) });
    liveUpdate({ sessionId, state: 'running' }, { memoryRoot: root, now: new Date(BASE_MS + 29 * MIN) });
    const board = buildBoard(root, BASE_MS + 29 * MIN);
    const focus = board.focus.find((item) => item.sessionId === sessionId);
    assert.equal(focus.stale, undefined);
    assert.equal(board.stale, false);
  } finally {
    clean(root);
  }
});

test('R3: 旧行（无 goalUpdatedAt）不编造目标时间，也不谎报 stale', () => {
  const root = makeRoot('focus-legacy');
  const sessionId = 'session-r3-legacy';
  try {
    liveUpdate({
      sessionId,
      state: 'running',
      goal: '旧版本写的目标',
    }, { memoryRoot: root, now: new Date(BASE_MS) });
    // 模拟 1.6.7 写的行：没有 goalUpdatedAt 字段。
    const legacy = readRow(root, sessionId);
    delete legacy.goalUpdatedAt;
    writeRow(root, sessionId, legacy);

    const board = buildBoard(root, BASE_MS + 2 * MIN);
    const focus = board.focus.find((item) => item.sessionId === sessionId);
    assert.ok(focus);
    assert.equal(focus.updatedAt, null, '拿不到目标时间就 null，不拿心跳冒充');
    assert.equal(focus.stale, undefined, '没有目标时间就不判 stale');
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// R4.1 — running 计数按 effectiveState
// ---------------------------------------------------------------------------

test('R4.1: pulse.running 只数 effectiveState=running（34 死 + 2 活 → 2）', () => {
  const root = makeRoot('pulse-running');
  try {
    const boardTime = BASE_MS + 10 * MIN;
    // 34 条早已死掉、但自报 running 的行：心跳停在 10 分钟前 → effectiveState=dead。
    for (let index = 0; index < 34; index += 1) {
      liveUpdate({
        sessionId: `session-dead${String(index).padStart(2, '0')}`,
        state: 'running',
        turn: 1,
      }, { memoryRoot: root, now: new Date(BASE_MS) });
    }
    // 1 条 idle 活行：心跳 100s 前 → 回落 declared state=idle（算 active）。
    liveUpdate({ sessionId: 'session-live0003', state: 'idle' }, { memoryRoot: root, now: new Date(boardTime - 100_000) });
    // 2 条真正在跑的行：心跳 10s 前 → effectiveState=running。
    liveUpdate({ sessionId: 'session-live0001', state: 'running', turn: 4 }, { memoryRoot: root, now: new Date(boardTime - 10_000) });
    liveUpdate({ sessionId: 'session-live0002', state: 'running', turn: 2 }, { memoryRoot: root, now: new Date(boardTime - 10_000) });

    const board = buildBoard(root, boardTime);
    assert.equal(board.pulse.running, 2, 'pulse.running 必须是有效活跃的 2，不是自报 36');
    assert.equal(board.counts.running, 2, 'counts.running 同口径');
    assert.equal(board.pulse.active, 3, '1 idle + 2 running 仍是 3 个活跃会话');
    assert.notEqual(board.pulse.running, 34);
    assert.notEqual(board.pulse.running, 36);
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// R4.2 — status 投影取 board 同字段
// ---------------------------------------------------------------------------

test('R4.2: buildStatus({board}) 透传 board.pulse.running（不是另一个数）', () => {
  const root = makeRoot('status-projection');
  try {
    const boardTime = BASE_MS + 10 * MIN;
    liveUpdate({ sessionId: 'session-live0001', state: 'running', turn: 4 }, { memoryRoot: root, now: new Date(boardTime - 10_000) });
    const board = buildBoard(root, boardTime);
    assert.equal(board.pulse.running, 1);

    const snapshot = buildStatus({ board, now: iso(boardTime) });
    assert.equal(snapshot.board.pulse.running, board.pulse.running, 'status.json 与 board.json 同字段同值');
    assert.equal(snapshot.board.pulse.running, 1);
  } finally {
    clean(root);
  }
});

test('R4.2: service.mjs 的 status 投影不再把 pulse.running 硬编码为 0', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'router', 'service', 'service.mjs'), 'utf8');
  assert.equal(source.includes('running: 0'), false, '不得残留硬编码 running: 0');
  assert.ok(source.includes('running: board.pulse?.running'), 'running 取 board 同字段');
});

// ---------------------------------------------------------------------------
// R4.3 — live 状态机（turn 边界）
// ---------------------------------------------------------------------------

test('R4.3: 纯函数 stateForTurnStart / stateForTurnEnd / turnBoundaryPlan', () => {
  assert.equal(stateForTurnStart(), 'running');
  assert.equal(stateForTurnEnd('waiting'), 'waiting', 'waiting 是给用户的承诺，保留');
  assert.equal(stateForTurnEnd('blocked'), 'blocked', 'blocked 保留');
  assert.equal(stateForTurnEnd('running'), 'idle');
  assert.equal(stateForTurnEnd(undefined), 'idle');
  assert.deepEqual(turnBoundaryPlan('turn/start', { turn: 5 }), {
    state: 'running', turn: 5, kind: 'turn', detail: 'turn/start #5',
  });
  assert.deepEqual(turnBoundaryPlan('turn/end', { turn: 5, priorState: 'blocked' }), {
    state: 'blocked', turn: 5, kind: 'turn', detail: 'turn/end #5',
  });
  assert.equal(turnBoundaryPlan('turn/end', { turn: 0, priorState: 'running' }).state, 'idle');
});

function fakeHostCtx() {
  const hooks = [];
  return {
    hooks,
    ctx: {
      on(name, fn) {
        hooks.push({ name, fn });
        return () => {};
      },
    },
  };
}

test('R4.3: turn/start → state=running+turn；turn/end → idle+turn（heartbeatMs:0 也工作）', () => {
  const root = makeRoot('turn-machine');
  const sessionId = 'session-turn0001';
  try {
    let nowMs = BASE_MS;
    // 先有一行（带 goal），模拟会话已用过 longlive 工具被绑定。
    liveUpdate({
      sessionId,
      state: 'running',
      turn: 4,
      goal: '写 state-truth 测试',
      last_action: { kind: 'tool', detail: 'edit test.mjs' },
    }, { memoryRoot: root, now: new Date(nowMs) });
    const goalClock = readRow(root, sessionId).goalUpdatedAt;

    const host = fakeHostCtx();
    const beat = createAutoHeartbeat({
      ctx: host.ctx,
      memoryRoot: root,
      heartbeatMs: 0, // 定时心跳关闭；turn 状态机必须仍然工作
      now: () => new Date(nowMs),
      resolve: () => ({ id: sessionId }),
    });
    assert.equal(beat.bind(sessionId), true);
    beat.start();
    const hook = host.hooks.find((item) => item.name === 'session/event');
    assert.ok(hook, 'start() 必须注册 session/event');

    nowMs = BASE_MS + 1000;
    hook.fn({ id: sessionId }, { type: 'turn/start', data: { turn: 5 } });
    const started = readRow(root, sessionId);
    assert.equal(started.state, 'running', 'turn/start → running');
    assert.equal(started.turn, 5, 'turn/start 落 turn 号');
    assert.equal(started.last_action.detail, 'turn/start #5');
    assert.equal(started.goalUpdatedAt, goalClock, 'turn/start 不冒充 goal 写入');

    nowMs = BASE_MS + 2000;
    hook.fn({ id: sessionId }, { type: 'turn/end', data: { turn: 5 } });
    const ended = readRow(root, sessionId);
    assert.equal(ended.state, 'idle', 'turn/end → idle');
    assert.equal(ended.turn, 5, 'turn/end 落 turn 号');
    assert.equal(ended.last_action.detail, 'turn/end #5');
    beat.stop();
  } finally {
    clean(root);
  }
});

test('R4.3: turn/end 保留 waiting / blocked 承诺（不抹成 idle）', () => {
  const root = makeRoot('turn-promise');
  const sessionId = 'session-turn0002';
  try {
    let nowMs = BASE_MS + 60_000;
    const host = fakeHostCtx();
    const beat = createAutoHeartbeat({
      ctx: host.ctx,
      memoryRoot: root,
      heartbeatMs: 0,
      now: () => new Date(nowMs),
      resolve: () => ({ id: sessionId }),
    });
    beat.bind(sessionId);
    beat.start();
    const hook = host.hooks.find((item) => item.name === 'session/event');

    liveUpdate({
      sessionId,
      state: 'waiting',
      turn: 2,
      goal: '等用户确认',
    }, { memoryRoot: root, now: new Date(nowMs) });
    hook.fn({ id: sessionId }, { type: 'turn/end', data: { turn: 2 } });
    assert.equal(readRow(root, sessionId).state, 'waiting', 'waiting 保留');
    assert.equal(readRow(root, sessionId).turn, 2);

    liveUpdate({
      sessionId,
      state: 'blocked',
      turn: 3,
      goal: '等用户确认',
      blocked_on: '等待用户确认',
    }, { memoryRoot: root, now: new Date(nowMs) });
    hook.fn({ id: sessionId }, { type: 'turn/end', data: { turn: 3 } });
    const blocked = readRow(root, sessionId);
    assert.equal(blocked.state, 'blocked', 'blocked 保留');
    assert.equal(blocked.turn, 3);
    assert.equal(blocked.blocked_on, '等待用户确认', 'blocked_on 不静默清空');
    beat.stop();
  } finally {
    clean(root);
  }
});

test('R4.3: 心跳 tick 只续 heartbeatAt，不动 state/turn/last_action/目标时间', () => {
  const root = makeRoot('tick-only');
  const sessionId = 'session-tick0001';
  try {
    let nowMs = BASE_MS;
    liveUpdate({
      sessionId,
      state: 'blocked',
      turn: 7,
      goal: '等用户确认',
      blocked_on: '等待用户确认',
      last_action: { kind: 'tool', detail: 'session_live_list' },
    }, { memoryRoot: root, now: new Date(nowMs) });
    const before = readRow(root, sessionId);

    const host = fakeHostCtx();
    let tickFn = null;
    const beat = createAutoHeartbeat({
      ctx: host.ctx,
      memoryRoot: root,
      heartbeatMs: 15_000,
      now: () => new Date(nowMs),
      setInterval: (fn) => { tickFn = fn; return { unref() {} }; },
      clearInterval: () => {},
    });
    beat.bind(sessionId);
    beat.start();
    assert.equal(beat.isEnabled(), true);
    assert.ok(typeof tickFn === 'function', '启用时应有兜底定时器');

    nowMs = BASE_MS + 15_000;
    tickFn();
    const after = readRow(root, sessionId);
    assert.equal(after.heartbeatAt, iso(BASE_MS + 15_000), 'tick 续 heartbeat');
    assert.equal(after.state, before.state, 'tick 不动 state');
    assert.equal(after.turn, before.turn, 'tick 不动 turn');
    assert.deepEqual(after.last_action, before.last_action, 'tick 不覆盖 last_action');
    assert.equal(after.goalUpdatedAt, before.goalUpdatedAt, 'tick 不动目标时间');
    beat.stop();
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// R6.2 — 开机卡年龄
// ---------------------------------------------------------------------------

function writeState(root, ageMinutes) {
  const stateFile = path.join(root, 'STATE.md');
  fs.writeFileSync(stateFile, [
    '# 状态卡',
    '',
    '## 我在哪',
    '正在给活动流写验收脚本。',
    '',
    '## 在等什么',
    '等候选树写完、等基线结果。',
    '',
    '## 最近三件',
    '1. 读 PLAN',
    '2. 写 acceptance.mjs',
    '3. 跑 1.6.7 基线',
    '',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(root, 'handover'), { recursive: true });
  fs.writeFileSync(path.join(root, 'handover', '2026-11-06-演示.md'), '# 交接卡\n\n- 目标：活动流验收\n- 下一步：跑 acceptance.mjs\n', 'utf8');
  const old = new Date(Date.now() - ageMinutes * MIN);
  fs.utimesSync(stateFile, old, old);
  return stateFile;
}

test('R6.2: collectOpenCard 逐字含「状态卡写于 42 分钟前」（来自 STATE.md mtime）', () => {
  const root = makeRoot('opencard');
  try {
    writeState(root, 42);
    const now = new Date();
    const card = collectOpenCard({ memoryRoot: root, now, maxChars: 1200 });
    const text = String(card.text ?? '');
    const match = /状态卡写于\s*(\d+)\s*分钟前/.exec(text);
    assert.ok(match, `开机卡必须含「状态卡写于 X 分钟前」，实际头："${text.split('\n')[0]}"`);
    const minutes = Number(match[1]);
    assert.ok(minutes >= 41 && minutes <= 43, `X 应接近 42，实际 ${minutes}`);
    assert.equal(card.stateAgeMinutes, minutes, '结构化字段与文案同值');
  } finally {
    clean(root);
  }
});

test('R6.2: buildOpenCard 纯函数路径（stateAgeMs）也输出同一句', () => {
  const now = new Date();
  const card = buildOpenCard({
    stateText: '# 卡\n\n## 我在哪\n- 在写测试\n',
    handover: { name: '2026-11-06-x.md', text: '# X\n\n## 一句话\n测试卡。\n' },
    now,
    stateAgeMs: 42 * MIN,
    maxChars: 1200,
  });
  assert.match(card.text, /状态卡写于 42 分钟前/);
  assert.equal(card.stateAgeMinutes, 42);
});

test('R6.2: 拿不到 STATE.md mtime 时不编造年龄句', () => {
  const now = new Date();
  const plain = buildOpenCard({
    stateText: '# 卡\n\n## 我在哪\n- 在写测试\n',
    handover: null,
    now,
  });
  assert.doesNotMatch(plain.text, /状态卡写于/);
  assert.equal(plain.stateAgeMinutes, null);

  const root = makeRoot('opencard-missing');
  try {
    const card = collectOpenCard({ memoryRoot: root, now });
    assert.equal(card.stateAgeMinutes, null);
    assert.doesNotMatch(card.text, /状态卡写于/);
    assert.ok(card.warnings.some((code) => code.startsWith('STATE_READ_FAILED')), '缺 STATE.md 要告警');
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// 兼容：board.json 的 focus 形状只有在 stale 时才多一个字段
// ---------------------------------------------------------------------------

test('board 兼容：新鲜 focus 仍是 6 字段；stale 时持久化 JSON 里多 stale:true', () => {
  const root = makeRoot('board-shape');
  const sessionId = 'session-shape01';
  try {
    liveUpdate({
      sessionId,
      state: 'running',
      goal: '写 P2 测试',
    }, { memoryRoot: root, now: new Date(BASE_MS) });
    const fresh = writeBoard(root, BASE_MS + MIN);
    assert.equal(fresh.written.ok, true);
    const freshFocus = fresh.board.focus[0];
    assert.deepEqual(Object.keys(freshFocus).sort(), [
      'goal', 'lastAction', 'lastConclusion', 'queuedCount', 'sessionId', 'updatedAt',
    ], '新鲜行不得多出字段');

    // 心跳保持新鲜（否则行会进入 dead 被移出 focus），目标仍是 31 分钟前。
    liveUpdate({ sessionId, state: 'running' }, { memoryRoot: root, now: new Date(BASE_MS + 31 * MIN) });
    const stale = writeBoard(root, BASE_MS + 31 * MIN);
    assert.equal(stale.board.focus[0].stale, true);
    const persisted = JSON.parse(fs.readFileSync(stale.boardFile, 'utf8'));
    assert.equal(persisted.focus[0].stale, true, 'stale 标记必须落进 board.json 供面板看');
    assert.equal(persisted.focus[0].updatedAt, iso(BASE_MS), '落盘的 updatedAt 仍是目标时间');
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// R3.4 — stale 的用户可见出口：共享提示
// ---------------------------------------------------------------------------

test('R3.4: 共享提示渲染 stale 与目标写入时间；新鲜目标不出现 stale', () => {
  const root = makeRoot('hint-stale');
  const sessionId = 'session-r34-hint';
  const other = 'session-r34-other';
  try {
    liveUpdate({ sessionId, state: 'running', goal: '31 分钟没动的目标' }, { memoryRoot: root, now: new Date(BASE_MS) });
    // 心跳保持新鲜（否则行会 dead 而离开 focus），目标仍是 31 分钟前。
    liveUpdate({ sessionId, state: 'running' }, { memoryRoot: root, now: new Date(BASE_MS + 31 * MIN) });
    const staleBoard = buildBoard(root, BASE_MS + 31 * MIN);
    const staleFocus = staleBoard.focus.find((item) => item.sessionId === sessionId);
    assert.equal(staleFocus.stale, true, 'board 里必须已经标 stale');
    const staleHint = renderHint(staleBoard, {
      now: new Date(BASE_MS + 31 * MIN), maxTokens: 700, selfSessionId: other,
    });
    assert.match(staleHint.text, /stale/i, `共享提示必须能看到 stale：${staleHint.text}`);
    assert.match(staleHint.text, /31 分钟前写入/, '提示里保留目标写入时间（相对分钟）');
    assert.ok(staleHint.tokens <= 700, '提示仍在 token 预算内');

    const freshRoot = makeRoot('hint-fresh');
    try {
      liveUpdate({ sessionId, state: 'running', goal: '刚写的目标' }, { memoryRoot: freshRoot, now: new Date(BASE_MS) });
      const freshBoard = buildBoard(freshRoot, BASE_MS + MIN);
      const freshHint = renderHint(freshBoard, { now: new Date(BASE_MS + MIN), maxTokens: 700, selfSessionId: other });
      assert.doesNotMatch(freshHint.text, /stale/i, '新鲜目标不得出现 stale');
    } finally {
      clean(freshRoot);
    }
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// R4.4 — RouterService 监听真机两参数 (session, event)
// ---------------------------------------------------------------------------

function fakeRouterHost() {
  const listeners = new Map();
  const ctx = {
    logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get() { return undefined; },
  };
  return {
    ctx,
    fire(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    },
    handlerCount: (name) => (listeners.get(name) ?? []).length,
  };
}

async function startRouterService({ memoryRoot, now }) {
  const host = fakeRouterHost();
  const vaultDir = path.join(memoryRoot, 'vault');
  const service = createRouterService(host.ctx, {
    enabled: true,
    provider: 'mock',
    model: 'mock-1',
    memoryRoot,
    vaultDir,
    tickMs: 60000,
    sharedBoard: true,
    maxTokensPerRun: 50000,
    maxTokensPerDay: 150000,
    callMaxTokens: 256,
    maxAttempts: 1,
    maxConsecutiveErrors: 3,
    disposeTimeoutMs: 500,
  }, {
    llm: new MockLlm(),
    memoryRoot,
    installTimers: false,
    installListener: true,
    now,
    stability: { enabled: false, waitMs: 0, retries: 0 },
  });
  const started = await service.start();
  assert.notEqual(started?.ok, false, `router service failed to start: ${JSON.stringify(started)}`);
  return {
    host,
    service,
    vaultDir,
    async close() {
      try { await service.stop('test'); } catch { /* already stopped */ }
      try { service.dispose(); } catch { /* ignore */ }
    },
  };
}

test('R4.4: RouterService 的 session/event 兼容真机两参数 (session, event)', async () => {
  const root = makeRoot('r44');
  const memoryRoot = path.join(root, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  const sessionId = 'session-r44-router';
  let nowMs = BASE_MS;
  const env = await startRouterService({ memoryRoot, now: () => new Date(nowMs) });
  try {
    const session = { id: sessionId, header: { id: sessionId, origin: 'main' } };
    env.host.fire('session/created', session);
    nowMs += 1000;
    // 真机契约：两个位置参数 (session, event) —— 1.6.8 之前这里被当成单参数
    // 信封，event 拿到的是 session 对象，turn/end 被整条忽略。
    env.host.fire('session/event', session, {
      type: 'turn/end',
      data: { turn: 3, reason: { kind: 'completed' } },
    });
    let row = readRow(memoryRoot, sessionId);
    assert.equal(row.turn, 3, 'two-arg turn/end 必须被接收并落 turn 号');
    assert.equal(row.state, 'idle');
    await env.service.tick({ tier: 'reflect', reason: 'test' });
    const status = JSON.parse(fs.readFileSync(path.join(env.vaultDir, 'status.json'), 'utf8'));
    assert.equal(status.live.turnEndEventVia, 'turn/end', 'status 必须记录 turn/end 这条通道');

    // 旧的一参数信封（repo 既有测试形状）仍要兼容。
    env.host.fire('session/event', {
      type: 'turn/end',
      session: { sessionId },
      turn: 4,
      data: { reason: { kind: 'completed' } },
    });
    row = readRow(memoryRoot, sessionId);
    assert.equal(row.turn, 4, 'legacy one-arg turn/end 仍兼容');
  } finally {
    await env.close();
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// R4.5 — 未绑定会话（只跑原生工具）的 turn 边界也维护 live 行
// ---------------------------------------------------------------------------

test('R4.5: 未绑定会话的 turn 边界维护 live 行：首见建行、遵守 128 行上限、不绑定', () => {
  const root = makeRoot('r45');
  const native = 'session-r45-native';
  const firstSeen = 'session-r45-first';
  const capped = 'session-r45-capped';
  const subagent = 'session-r45-sub';
  try {
    let nowMs = BASE_MS;
    const hooks = [];
    const host = {
      listeners: hooks,
      ctx: { on(name, fn) { hooks.push({ name, fn }); return () => {}; } },
      emitSession(session, event) {
        for (const hook of [...hooks]) if (hook.name === 'session/event') hook.fn(session, event);
      },
    };
    // maxRows=2：A、B 两行之后，第三条（C）不得再创建。
    const hb = createAutoHeartbeat({
      ctx: host.ctx,
      memoryRoot: root,
      heartbeatMs: 0,
      maxRows: 2,
      now: () => new Date(nowMs),
    });
    hb.start();
    try {
      // A：行已存在（Router session/created 写的），但从未调用 longlive 工具 → 未绑定。
      liveUpdate({ sessionId: native, state: 'idle' }, { memoryRoot: root, now: new Date(nowMs) });
      host.emitSession({ id: native, header: { id: native, origin: 'main' } }, { type: 'turn/start', data: { turn: 1 } });
      let row = readRow(root, native);
      assert.equal(row.state, 'running', '未绑定会话 turn/start 必须切 running');
      assert.equal(row.turn, 1);
      assert.deepEqual(hb.boundIds(), [], '维护事件会话不等于绑定（tick 不刷未绑定行）');

      nowMs += 1000;
      host.emitSession({ id: native, header: { id: native, origin: 'main' } }, { type: 'turn/end', data: { turn: 1 } });
      row = readRow(root, native);
      assert.equal(row.state, 'idle');
      assert.equal(row.turn, 1);

      // B：行不存在 → 首个 turn/start 先建行。
      nowMs += 1000;
      host.emitSession({ id: firstSeen, header: { id: firstSeen, origin: 'main' } }, { type: 'turn/start', data: { turn: 2 } });
      assert.equal(readRow(root, firstSeen).state, 'running', '首见会话必须在 turn 边界建行');

      // C：已到 maxRows=2 → 不得创建第 3 行。
      nowMs += 1000;
      host.emitSession({ id: capped, header: { id: capped, origin: 'main' } }, { type: 'turn/start', data: { turn: 1 } });
      assert.equal(fs.existsSync(rowPath(root, capped)), false, '到达行上限时不得创建新行');

      // subagent：不计入 live 注册表。
      host.emitSession({ id: subagent, header: { id: subagent, origin: 'subagent' } }, { type: 'turn/start', data: { turn: 1 } });
      assert.equal(fs.existsSync(rowPath(root, subagent)), false, 'subagent 不建 live 行');
    } finally {
      hb.stop();
    }
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// R4.6 / R4.7 — pulse 口径统一（subagent 单独计数；blocked 同口径同源）
// ---------------------------------------------------------------------------

test('R4.6: subagent live 行不进 pulse.running/active/focus，只在 counts.subagents 计数', () => {
  const root = makeRoot('r46');
  const main = 'session-r46-main';
  const sub = 'abc12345-0000-4000-8000-000000000000';
  try {
    liveUpdate({ sessionId: main, state: 'running', goal: '主会话' }, { memoryRoot: root, now: new Date(BASE_MS) });
    liveUpdate({ sessionId: sub, state: 'running' }, { memoryRoot: root, now: new Date(BASE_MS) });
    const board = buildBoard(root, BASE_MS, {
      metadata: [
        { sessionId: main, origin: 'main' },
        { sessionId: sub, origin: 'subagent' },
      ],
    });
    assert.equal(board.pulse.running, 1, 'subagent 行不得抬高 pulse.running');
    assert.equal(board.pulse.active, 1, 'subagent 行不得抬高 pulse.active');
    assert.equal(board.pulse.running, board.pulse.active, 'running 与 active 必须同口径');
    assert.deepEqual(board.focus.map((item) => item.sessionId), [main], 'subagent 不进 focus');
    assert.equal(board.counts.subagents, 1, 'subagent 单独计数');
  } finally {
    clean(root);
  }
});

test('R4.6 边界：metadata 不可用时识别不出 origin 的行 fail-safe 进 unknown，不抬高 running/active', () => {
  const root = makeRoot('r46-nometa');
  const main = 'session-r46-nometa-main';
  const sub = 'abc12345-0000-4000-8000-000000000000';
  try {
    liveUpdate({ sessionId: main, state: 'running', goal: '主会话' }, { memoryRoot: root, now: new Date(BASE_MS) });
    liveUpdate({ sessionId: sub, state: 'running' }, { memoryRoot: root, now: new Date(BASE_MS) });
    // host ctx.get('sessions') 不可用 → RouterService 传 metadata=null
    const board = buildBoard(root, BASE_MS, { metadata: null });
    assert.equal(board.pulse.running, 1, 'metadata 缺失时 bare-UUID 行不得重蹈 running 虚高');
    assert.equal(board.pulse.active, 1, 'metadata 缺失时 active 不得虚高');
    assert.equal(board.pulse.running, board.pulse.active);
    assert.deepEqual(board.focus.map((item) => item.sessionId), [main], '识别不出的行不得进 focus');
    assert.equal(board.pulse.unknownSessions, 1, '识别不出 origin 的行归 unknownSessions（不冒充 running）');
    assert.equal(board.counts.subagents, 0, '无 metadata 时无法确证 subagent，但不影响不计数');

    // fail-safe 不能把普通主会话也藏掉：非 UUID 形状的 id 仍按 main 处理。
    const other = 'sess-r46-legacy';
    liveUpdate({ sessionId: other, state: 'idle' }, { memoryRoot: root, now: new Date(BASE_MS) });
    const board2 = buildBoard(root, BASE_MS, { metadata: null });
    assert.equal(board2.pulse.active, 2, 'sess-* 形状的行仍算主会话（只 fail-safe 裸 UUID）');
    assert.equal(board2.pulse.running, 1, 'idle 行不抬高 running');
  } finally {
    clean(root);
  }
});

test('R4.7: 心跳新鲜的活 blocked 行计入（1），死行自报 blocked 不计，running 口径不回归', () => {
  const root = makeRoot('r47-dead');
  const deadAt = new Date(BASE_MS - 10 * MIN).toISOString();
  try {
    // 30 条 10 分钟前的心跳行，自报 blocked 但 effectiveState=dead。
    for (let index = 0; index < 30; index += 1) {
      writeRow(root, `session-r47-dead${String(index).padStart(4, '0')}`, {
        schemaVersion: 1,
        sessionId: `session-r47-dead${String(index).padStart(4, '0')}`,
        pid: 999999,
        host: os.hostname(),
        startedAt: deadAt,
        updatedAt: deadAt,
        heartbeatAt: deadAt,
        ttlMs: 60000,
        state: 'blocked',
        turn: 1,
        goal: '',
        goalUpdatedAt: '',
        blocked_on: '等用户',
        queued: [],
        last_action: null,
      });
    }
    // 活的 blocked 行（心跳新鲜 → effectiveState=running）必须计入 blocked=1。
    liveUpdate({ sessionId: 'session-r47-liveblock', state: 'blocked', blocked_on: '等确认' }, { memoryRoot: root, now: new Date(BASE_MS) });
    liveUpdate({ sessionId: 'session-r47-fresh', state: 'running' }, { memoryRoot: root, now: new Date(BASE_MS) });
    const board = buildBoard(root, BASE_MS);
    assert.equal(board.pulse.blocked, 1, '活 blocked 行计入 1；30 条死行自报 blocked 不计');
    assert.equal(board.pulse.running, 1, 'blocked 行不得同时算 running（口径不回归）');
    assert.equal(board.counts.blocked, board.pulse.blocked, 'counts 与 pulse 同源');
    assert.equal(board.pulse.active, 2, '2 条有效行（blocked + running）');
  } finally {
    clean(root);
  }
});

test('R4.7 口径窗口：blocked 行在 (ttl,2ttl] 仍按声明状态计入，>2ttl 变 stale 后不计', () => {
  const root = makeRoot('r47-ttl');
  try {
    liveUpdate({ sessionId: 'session-r47-ttl', state: 'blocked', blocked_on: '等确认' }, { memoryRoot: root, now: new Date(BASE_MS) });
    const inWindow = buildBoard(root, BASE_MS + 90 * 1000); // 1.5 × ttl
    assert.equal(inWindow.pulse.blocked, 1, '声明态窗口内 blocked 计 1');
    const afterStale = buildBoard(root, BASE_MS + 130 * 1000); // > 2 × ttl
    assert.equal(afterStale.pulse.blocked, 0, 'stale 后不再计入');
  } finally {
    clean(root);
  }
});

test('R4.7: board.json 与 status.json 的 pulse.blocked 同源同值（Router 自身状态不覆盖）', async () => {
  const root = makeRoot('r47-proj');
  const memoryRoot = path.join(root, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  const nowMs = BASE_MS;
  try {
    liveUpdate({ sessionId: 'session-r47-blk1', state: 'blocked', blocked_on: '等确认' }, { memoryRoot, now: new Date(nowMs) });
    liveUpdate({ sessionId: 'session-r47-blk2', state: 'blocked', blocked_on: '等确认' }, { memoryRoot, now: new Date(nowMs) });
    const env = await startRouterService({ memoryRoot, now: () => new Date(nowMs) });
    try {
      await env.service.tick({ tier: 'full', reason: 'test' });
      const board = JSON.parse(fs.readFileSync(path.join(env.vaultDir, 'board.json'), 'utf8'));
      const status = JSON.parse(fs.readFileSync(path.join(env.vaultDir, 'status.json'), 'utf8'));
      assert.equal(board.pulse.blocked, 2, '2 条活 blocked 行都要计入（不是恒 0）');
      assert.equal(status.board.pulse.blocked, board.pulse.blocked,
        `status.blocked=${status.board.pulse.blocked} 必须等于 board.blocked=${board.pulse.blocked}`);
      assert.equal(status.board.pulse.running, board.pulse.running, 'running 也必须同源');
    } finally {
      await env.close();
    }
  } finally {
    clean(root);
  }
});
