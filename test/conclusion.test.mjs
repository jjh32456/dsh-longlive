// A1 (conclusion write-back) + A2 (shared-board lastConclusion) tests.
//
// Everything writes under the runner's TMP directory only: the P6 gate in
// test/run.mjs fails the suite if the package tree changes during a run.

import fs from 'node:fs';
import path from 'node:path';

import {
  bridgeMarkerFile,
  classifyConclusionText,
  conclusionCardFile,
  createConclusionBridge,
  judgeConclusion,
  readBridgeMarker,
} from '../src/conclusion.js';
import {
  LAST_CONCLUSION_MAX,
  boardHashOf,
  createBoardBuilder,
  lastConclusionOf,
  readBridgeConclusions,
} from '../src/router/service/board.mjs';
import { renderHint } from '../src/router/service/hint.mjs';
import { liveUpdate } from '../src/live.js';

const NOW_MS = Date.parse('2026-11-05T12:00:00.000Z');
const NOW = new Date(NOW_MS);

// test/run.mjs passes a plain assert(cond, message) function; keep a small
// object-shaped adapter so the cases below read naturally.
function makeAssert(check) {
  const api = (cond, message) => check(cond, message);
  api.ok = (value, message) => check(value, message || `expected truthy, got ${String(value)}`);
  api.equal = (actual, expected, message) => {
    check(actual === expected, message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  api.notEqual = (actual, expected, message) => {
    check(actual !== expected, message || `did not expect ${JSON.stringify(expected)}`);
  };
  api.deepEqual = (actual, expected, message) => {
    check(JSON.stringify(actual) === JSON.stringify(expected),
      message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  return api;
}

function userEvent(text, extra = {}) {
  return {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      role: 'user',
      id: `u-${Math.random().toString(16).slice(2)}`,
      ...extra,
    },
  };
}

function injectedUserEvent(text) {
  return {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
      id: 'u-injected',
    },
  };
}

function assistantEvent(turn, blocks) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step: 1,
      message: {
        role: 'assistant',
        content: blocks,
        source: { kind: 'model' },
        id: `a-${turn}`,
      },
    },
  };
}

function turnStart(turn) {
  return { type: 'turn/start', data: { turn } };
}

function turnEnd(turn, kind = 'completed') {
  return { type: 'turn/end', data: { turn, reason: { kind } } };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function runConclusionSuite({ runCase, assert: rawAssert, TMP }) {
  const assert = makeAssert(rawAssert);

  const fixture = (name) => {
    const root = path.join(TMP, `conclusion-${name}`);
    fs.mkdirSync(root, { recursive: true });
    return root;
  };

  const session = { id: 'session-alpha' };

  function feedThreeTurns(bridge) {
    bridge.onSessionEvent(session, turnStart(1));
    bridge.onSessionEvent(session, userEvent('先看看现在的情况'));
    bridge.onSessionEvent(session, assistantEvent(1, [
      { type: 'text', text: '现在有两个方案，A 和 B，各有取舍，需要你定一个。' },
    ]));
    bridge.onSessionEvent(session, turnEnd(1));

    bridge.onSessionEvent(session, turnStart(2));
    bridge.onSessionEvent(session, userEvent('A 方案改起来麻烦吗'));
    bridge.onSessionEvent(session, assistantEvent(2, [
      { type: 'reasoning', text: 'REASONING-内部推理不该进卡' },
      { type: 'text', text: 'A 方案改动面大一些，B 方案更稳，两种都能做。' },
    ]));
    bridge.onSessionEvent(session, turnEnd(2));

    bridge.onSessionEvent(session, turnStart(3));
    bridge.onSessionEvent(session, userEvent('改成用 A 方案吧'));
    bridge.onSessionEvent(session, assistantEvent(3, [
      { type: 'reasoning', text: 'REASONING-最终轮推理' },
      { type: 'text', text: '好，按这个来，以后都走 A 方案生成。' },
    ]));
    bridge.onSessionEvent(session, turnEnd(3));
  }

  runCase('K1', 'local decision/fact rules classify without an LLM', () => {
    assert.equal(classifyConclusionText('定了，就用 B 方案'), 'decision');
    assert.equal(classifyConclusionText('结论是走 A 路线'), 'decision');
    assert.equal(classifyConclusionText('结论：走 A 路线'), 'fact');
    assert.equal(classifyConclusionText('以后都按这个来'), 'decision');
    assert.equal(classifyConclusionText('今天天气不错'), null);
    assert.equal(classifyConclusionText(''), null);
    assert.equal(judgeConclusion({ userText: '改成 A', assistantText: '好。' }), null);
    assert.equal(judgeConclusion({ userText: '随便', assistantText: '窗外的树在动。' }), null);
    const judged = judgeConclusion({
      userText: '改成用 A 方案',
      assistantText: '好，按这个来，以后都走 A 方案生成。',
    });
    assert.equal(judged.kind, 'decision');
    assert.ok(Array.from(judged.body).length <= 500);
    assert.ok(Array.from(judged.title).length <= 60);
    assert.ok(judged.body.includes('用户：'));
    assert.ok(judged.body.includes('助手：'));
  });

  runCase('K2', 'three turns write one card; reasoning blocks never reach it', () => {
    const root = fixture('card');
    const bridge = createConclusionBridge({ enabled: true, memoryRoot: root, now: () => NOW });
    feedThreeTurns(bridge);
    const file = conclusionCardFile(root, 'session-alpha', 3);
    assert.ok(fs.existsSync(file), 'card should exist for turn 3');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith('---\n'));
    assert.ok(text.includes('kind: decision'));
    assert.ok(text.includes('source_session: session-alpha'));
    assert.ok(text.includes('source_turn: 3'));
    assert.ok(text.includes('written_at: 2026-11-05'));
    assert.ok(!text.includes('REASONING'));
    assert.ok(!text.includes('今天天气'));
    const body = text.split('\n---\n')[1] ?? '';
    assert.ok(Array.from(body).length <= 500, `body too long: ${Array.from(body).length}`);
    const marker = readBridgeMarker(root, 'session-alpha');
    assert.equal(marker.lastConclusion.turn, 3);
    assert.equal(marker.lastConclusion.kind, 'decision');
    assert.ok(marker.lastConclusion.text.includes('按这个来'));
    assert.ok(Array.from(marker.lastConclusion.text).length <= LAST_CONCLUSION_MAX);
    assert.deepEqual(Object.keys(marker.turns), ['3']);
    assert.equal(bridge.stats.written, 1);
    assert.equal(bridge.stats.skipped, 2);
  });

  runCase('K3', 'same session + turn is idempotent (marker survives a new bridge)', () => {
    const root = fixture('idempotent');
    const first = createConclusionBridge({ enabled: true, memoryRoot: root, now: () => NOW });
    feedThreeTurns(first);
    feedThreeTurns(first);
    assert.equal(first.stats.duplicates, 1);
    const second = createConclusionBridge({ enabled: true, memoryRoot: root, now: () => NOW });
    feedThreeTurns(second);
    assert.equal(second.stats.duplicates, 1);
    const files = fs.readdirSync(path.join(root, 'topics'));
    assert.equal(files.filter((name) => name.startsWith('conclusion-')).length, 1);
  });

  runCase('K4', 'privacy gate blocks the card; a throwing gate fails closed', () => {
    const root = fixture('privacy');
    const skipped = createConclusionBridge({
      enabled: true,
      memoryRoot: root,
      now: () => NOW,
      privacyScan: () => ({ verdict: 'local_only', spans: [], reasons: ['test'] }),
    });
    feedThreeTurns(skipped);
    assert.equal(skipped.stats.privacy, 1);
    assert.equal(fs.existsSync(conclusionCardFile(root, 'session-alpha', 3)), false);

    const root2 = fixture('privacy-throw');
    const failed = createConclusionBridge({
      enabled: true,
      memoryRoot: root2,
      now: () => NOW,
      privacyScan: () => { throw new Error('gate down'); },
    });
    feedThreeTurns(failed);
    assert.equal(failed.stats.privacy, 1);
    assert.equal(fs.existsSync(conclusionCardFile(root2, 'session-alpha', 3)), false);
  });

  runCase('K5', 'non-completed turns and injected user text never write', () => {
    const root = fixture('gates');
    const bridge = createConclusionBridge({ enabled: true, memoryRoot: root, now: () => NOW });
    bridge.onSessionEvent(session, turnStart(1));
    bridge.onSessionEvent(session, injectedUserEvent('<system-reminder>注入块</system-reminder> 改成 A'));
    bridge.onSessionEvent(session, assistantEvent(1, [{ type: 'text', text: '好，按这个来，以后都走 A 方案。' }]));
    bridge.onSessionEvent(session, turnEnd(1, 'aborted'));
    assert.equal(fs.existsSync(conclusionCardFile(root, 'session-alpha', 1)), false);
    assert.equal(bridge.stats.skipped, 1);
    // reasoning-only assistant messages leave no text to judge
    bridge.onSessionEvent(session, turnStart(2));
    bridge.onSessionEvent(session, userEvent('改成 A 吧'));
    bridge.onSessionEvent(session, assistantEvent(2, [{ type: 'reasoning', text: '只是想一想' }]));
    bridge.onSessionEvent(session, turnEnd(2));
    assert.equal(bridge.stats.skipped, 2);
  });

  runCase('K6', 'a write failure is swallowed and never throws', () => {
    const root = fixture('failure');
    // Occupy the topics path with a file: mkdirSync/write must fail inside the
    // bridge, which has to count an error instead of throwing.
    fs.writeFileSync(path.join(root, 'topics'), 'not a directory\n', 'utf8');
    const bridge = createConclusionBridge({ enabled: true, memoryRoot: root, now: () => NOW });
    feedThreeTurns(bridge);
    assert.equal(bridge.stats.written, 0);
    assert.ok(bridge.stats.errors >= 1);
    assert.equal(bridge.stats.privacy, 0);
  });

  runCase('K7', 'lastConclusionOf accepts only clean strings or {text}', () => {
    assert.equal(lastConclusionOf(undefined), null);
    assert.equal(lastConclusionOf(null), null);
    assert.equal(lastConclusionOf(''), null);
    assert.equal(lastConclusionOf('   '), null);
    assert.equal(lastConclusionOf(42), null);
    assert.equal(lastConclusionOf([]), null);
    assert.equal(lastConclusionOf({ text: 42 }), null);
    assert.equal(lastConclusionOf({ text: '' }), null);
    assert.equal(lastConclusionOf('  a\n b\u0000c '), 'a b c');
    const long = lastConclusionOf('x'.repeat(200));
    assert.equal(Array.from(long).length, LAST_CONCLUSION_MAX);
    assert.ok(long.endsWith('…'));
  });

  runCase('K8', 'board focus carries A1 conclusion and boardHash follows it', () => {
    const root = fixture('board');
    liveUpdate({
      sessionId: 'session-alpha',
      state: 'running',
      goal: '写 A1',
      last_action: { kind: 'edit', detail: '改了 board.mjs', at: NOW.toISOString() },
    }, { memoryRoot: root, now: NOW_MS });
    writeJson(path.join(root, '.longlive', 'bridge', 'session-alpha.json'), {
      v: 1,
      sessionId: 'session-alpha',
      updatedAt: NOW.toISOString(),
      lastConclusion: {
        text: '好，按这个来，以后都走 A 方案生成。',
        kind: 'decision',
        turn: 3,
        at: NOW.toISOString(),
      },
      turns: { 3: NOW.toISOString() },
    });
    const builder = createBoardBuilder({
      memoryRoot: root,
      config: {},
      now: () => NOW,
      paths: { bridgeDir: path.join(root, '.longlive', 'bridge') },
    });
    const { board } = builder.build({});
    assert.equal(board.focus.length, 1);
    assert.equal(board.focus[0].lastConclusion, '好，按这个来，以后都走 A 方案生成。');
    assert.equal(readBridgeConclusions(path.join(root, '.longlive', 'bridge')).get('session-alpha'),
      '好，按这个来，以后都走 A 方案生成。');
    const without = { ...board, focus: [{ ...board.focus[0], lastConclusion: null }] };
    assert.notEqual(boardHashOf(board), boardHashOf(without));
  });

  runCase('K9', 'board falls back to last_action.detail and ignores dirty markers', () => {
    const root = fixture('board-fallback');
    liveUpdate({
      sessionId: 'session-beta',
      state: 'running',
      goal: '写 A2',
      last_action: { kind: 'edit', detail: 'turn 结束 #7', at: NOW.toISOString() },
    }, { memoryRoot: root, now: NOW_MS });
    writeJson(path.join(root, '.longlive', 'bridge', 'session-beta.json'), {
      v: 1,
      sessionId: 'session-beta',
      lastConclusion: { text: '   ' },
    });
    const builder = createBoardBuilder({ memoryRoot: root, config: {}, now: () => NOW, paths: {} });
    const { board } = builder.build({});
    assert.equal(board.focus[0].lastConclusion, 'turn 结束 #7');

    // A row with no explicit action only carries `state=...`; that lifecycle
    // detail must not be rendered as a conclusion.
    liveUpdate({ sessionId: 'session-delta', state: 'running', goal: '无动作' },
      { memoryRoot: root, now: NOW_MS });
    const withDelta = builder.build({}).board;
    const delta = withDelta.focus.find((item) => item.sessionId === 'session-delta');
    assert.ok(delta, 'session-delta should be on the board');
    assert.equal(delta.lastConclusion, null);

    // Junk JSON and unknown shapes are skipped, not rendered.
    writeJson(path.join(root, '.longlive', 'bridge', 'session-gamma.json'), {
      v: 1,
      sessionId: 'session-gamma',
      lastConclusion: { text: { nested: true } },
    });
    fs.writeFileSync(path.join(root, '.longlive', 'bridge', 'broken.json'), '{not json', 'utf8');
    const conclusions = readBridgeConclusions(path.join(root, '.longlive', 'bridge'));
    assert.equal(conclusions.has('session-gamma'), false);
    assert.equal(conclusions.has('session-beta'), false);
  });

  runCase('K10', 'hint renders 目标 / 最近 / 结论 and B sees A', () => {
    const root = fixture('hint');
    liveUpdate({
      sessionId: 'session-a',
      state: 'running',
      goal: '写 A1 回流',
      last_action: { kind: 'edit', detail: '改 conclusion.js', at: NOW.toISOString() },
    }, { memoryRoot: root, now: NOW_MS });
    writeJson(path.join(root, '.longlive', 'bridge', 'session-a.json'), {
      v: 1,
      sessionId: 'session-a',
      lastConclusion: { text: '决定：结论回流先默认关，等验收后再开。', kind: 'decision', turn: 4, at: NOW.toISOString() },
    });
    liveUpdate({
      sessionId: 'session-b',
      state: 'running',
      goal: '写 A2 看板',
    }, { memoryRoot: root, now: NOW_MS });
    const builder = createBoardBuilder({ memoryRoot: root, config: {}, now: () => NOW, paths: {} });
    const { board } = builder.build({});
    const hint = renderHint(board, { tier: 'full', now: NOW_MS, selfSessionId: 'session-b' });
    assert.ok(hint.text.includes('目标「写 A1 回流」'));
    assert.ok(hint.text.includes('最近：edit 改 conclusion.js'));
    assert.ok(hint.text.includes('结论：决定：结论回流先默认关，等验收后再开。'));
    assert.ok(!hint.text.includes('注入'), 'hint must not leak unrelated text');
    assert.ok(hint.tokens <= 700);
  });

  runCase('K11', 'board write/read keeps lastConclusion in the persisted JSON', () => {
    const root = fixture('persist');
    liveUpdate({
      sessionId: 'session-a',
      state: 'idle',
      goal: '收尾',
    }, { memoryRoot: root, now: NOW_MS });
    writeJson(path.join(root, '.longlive', 'bridge', 'session-a.json'), {
      v: 1,
      sessionId: 'session-a',
      lastConclusion: { text: '就这样，A2 用 board 现有字段，不新增配置键。', kind: 'decision', turn: 9 },
    });
    const vault = path.join(root, '.longlive', 'router');
    const builder = createBoardBuilder({
      memoryRoot: root,
      config: {},
      now: () => NOW,
      paths: {
        boardFile: path.join(vault, 'board.json'),
        rosterFile: path.join(vault, 'index', 'roster.json'),
        proposalsDir: path.join(vault, 'proposals'),
        bridgeDir: path.join(root, '.longlive', 'bridge'),
      },
    });
    const { board } = builder.build({});
    const written = builder.write({ board, roster: [] });
    assert.equal(written.ok, true);
    const persisted = JSON.parse(fs.readFileSync(path.join(vault, 'board.json'), 'utf8'));
    assert.equal(persisted.focus[0].lastConclusion, board.focus[0].lastConclusion);
    const readBack = builder.read();
    assert.equal(readBack.hash, written.board.hash);
  });

  runCase('K12', 'disabled bridge is a no-op', () => {
    const root = fixture('disabled');
    const bridge = createConclusionBridge({ enabled: false, memoryRoot: root, now: () => NOW });
    feedThreeTurns(bridge);
    assert.equal(bridge.enabled, false);
    assert.equal(bridge.stats.written, 0);
    assert.equal(fs.existsSync(path.join(root, 'topics')), false);
    assert.equal(fs.existsSync(bridgeMarkerFile(root, 'session-alpha')), false);
  });
}
