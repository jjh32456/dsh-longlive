import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  estimateTokens,
  estimateMessageTokens,
  estimateToolsTokens,
  contentText,
  ESTIMATOR_ID,
} from '../src/metrics/estimate.mjs';
import {
  classifyMessage,
  messageOfEvent,
  recallIdsFromText,
  recallIdsFromMessage,
  firstLine,
} from '../src/metrics/classify.mjs';
import {
  measureTurn,
  normalizeMetricsConfig,
  scaleToTotal,
  summarizeRows,
  median,
} from '../src/metrics/measure.mjs';
import {
  appendTurnRow,
  readTurnLedger,
  readMetricsSummary,
  readCalibration,
  writeCalibration,
  readLastConclusion,
  ledgerPath,
} from '../src/metrics/store.mjs';
import { registerMetrics, findUsageEvent, findRequestHeader } from '../src/metrics/index.mjs';
import { createRouterTools } from '../src/router/service/tools.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-metrics-'));
}

let seqCounter = 0;
function event(type, data, extra = {}) {
  return { seq: seqCounter++, type, data, surfaceOp: 'append', ...extra };
}

function resetSeq() {
  seqCounter = 0;
}

function systemEvent(text, turn = 1) {
  return event('system/message', {
    turn,
    step: 1,
    message: { role: 'system', content: text },
  });
}

function userEvent(text, source = null, turn = 0) {
  const message = { role: 'user', content: text, source: source ?? { kind: 'user' } };
  return turn > 0
    ? event('user/message', { turn, message })
    : event('user/message', message);
}

function assistantEvent(text, turn, usage = null) {
  return event('assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...(usage ? { usage } : {}),
  });
}

function toolEvent(text, turn) {
  return event('tool/result', {
    turn,
    step: 1,
    message: { role: 'tool', content: [{ type: 'text', text }] },
  });
}

function turnStart(turn) {
  return event('turn/start', { turn });
}

test('estimate: empty and malformed values are zero', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(42), 0);
  assert.equal(estimateTokens('你好'), 2);
  assert.equal(estimateTokens('abcd'), 2);
  assert.equal(estimateTokens('a'.repeat(350)), 100);
  assert.equal(ESTIMATOR_ID, 'cjk*1+other/3.5');
});

test('estimate: large strings do not overflow and stay finite', () => {
  const text = '字a'.repeat(1_000_000);
  const tokens = estimateTokens(text);
  assert.ok(Number.isSafeInteger(tokens));
  assert.ok(tokens > 1_000_000);
});

test('estimate: message text ignores reasoning but counts tool calls', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'x'.repeat(4000) },
      { type: 'text', text: 'hello' },
      { type: 'tool-call', name: 'read', arguments: '{"file_path":"a"}' },
    ],
  };
  const text = contentText(message.content);
  assert.equal(text.includes('x'.repeat(20)), false);
  assert.equal(text.includes('read'), true);
  assert.equal(estimateMessageTokens({ role: 'assistant', content: [{ type: 'reasoning', text: 'x' }] }), 0);
  assert.ok(estimateMessageTokens(message) > 0);
});

test('estimate: tools json and empty tools', () => {
  assert.equal(estimateToolsTokens([]), 0);
  assert.equal(estimateToolsTokens(null), 0);
  assert.ok(estimateToolsTokens([{ name: 'read', description: 'abc' }]) > 0);
});

test('classify: system, developer, fixed injection, recall, conclusion, conversation', () => {
  assert.equal(classifyMessage({ role: 'system', content: 'x' }), 'fixed');
  assert.equal(classifyMessage({ role: 'developer', content: 'x' }), 'fixed');
  assert.equal(classifyMessage({ role: 'user', content: 'x', source: { kind: 'agent-instructions' } }), 'fixed');
  assert.equal(classifyMessage({ role: 'user', content: 'x', source: { kind: 'runtime-context', sections: [] } }), 'fixed');
  assert.equal(classifyMessage({ role: 'user', content: 'x', source: { kind: 'session-reference', form: 'recall' } }), 'fixed');
  assert.equal(classifyMessage({ role: 'user', content: '【自动想起】\n- 《A》（a.md · 1）', source: { kind: 'session-reference' } }), 'recall');
  assert.equal(classifyMessage({ role: 'user', content: '【开机卡】x' }), 'conclusion');
  assert.equal(classifyMessage({ role: 'user', content: 'x', source: { kind: 'plugin:dsh-auto-recall' } }), 'recall');
  assert.equal(classifyMessage({ role: 'user', content: 'x', source: { kind: 'plugin:dsh-identity-router' } }), 'conclusion');
  assert.equal(classifyMessage({ role: 'user', content: 'x', source: { kind: 'archive-card' } }), 'conversation');
  assert.equal(classifyMessage({ role: 'user', content: 'x', source: { kind: 'user' } }), 'conversation');
  assert.equal(classifyMessage({ role: 'user', content: 'x' }), 'conversation');
  assert.equal(classifyMessage(null), 'unknown');
});

test('classify: messageOfEvent handles wrapper and bare user message', () => {
  const bare = { role: 'user', content: 'hi' };
  assert.equal(messageOfEvent({ type: 'user/message', data: bare }), bare);
  const wrapped = { role: 'tool', content: 'out' };
  assert.equal(messageOfEvent({ type: 'tool/result', data: { message: wrapped } }), wrapped);
  assert.equal(messageOfEvent({ data: null }), null);
});

test('recall ids: parse rendered lines, dedupe, tolerate missing fields', () => {
  const text = [
    '【自动想起】线索：',
    '- 《工具链》（topics/toolchain.md · 相关度 1.72）',
    '- 《工具链》（topics/toolchain.md · 相关度 1.10）',
    '- 《无路径》',
    '',
  ].join('\n');
  const ids = recallIdsFromText(text);
  assert.equal(ids.length, 1);
  assert.equal(ids[0].path, 'topics/toolchain.md');
  assert.equal(firstLine(text), '【自动想起】线索：');
  assert.deepEqual(recallIdsFromText(''), []);
  assert.deepEqual(recallIdsFromText(null), []);
  assert.deepEqual(recallIdsFromMessage({ source: { references: [{ path: 'a.md', title: 'A' }, { path: 'a.md' }] } }), [{ title: 'A', path: 'a.md' }]);
});

test('config: defaults, disable switch, proportional layer targets', () => {
  const defaults = normalizeMetricsConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.targetTokens, 40000);
  assert.deepEqual(defaults.layerTargets, { fixed: 25000, recent: 12000, recall: 2000, conclusion: 1000 });
  assert.equal(normalizeMetricsConfig({ metrics: false }).enabled, false);
  assert.equal(normalizeMetricsConfig({ metrics: { enabled: false } }).enabled, false);
  const half = normalizeMetricsConfig({ targetTokens: 20000 });
  assert.equal(half.layerTargets.fixed, 12500);
  assert.equal(half.layerTargets.recent, 6000);
  assert.equal(half.layerTargets.recall, 1000);
  assert.equal(half.layerTargets.conclusion, 500);
});

test('scaleToTotal: exact sum, empty and zero are safe', () => {
  const scaled = scaleToTotal({ fixed: 10, recent: 5, recall: 1, conclusion: 1, carried: 3 }, 100);
  const sum = Object.values(scaled).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
  assert.deepEqual(scaleToTotal({}, 100), {});
  assert.deepEqual(scaleToTotal({ a: 0, b: 0 }, 100), { a: 0, b: 0 });
});

test('measureTurn: empty input produces a zero row, never throws', () => {
  const row = measureTurn({ turn: 0, sessionId: 's-empty' });
  assert.equal(row.v, 1);
  assert.equal(row.sessionId, 's-empty');
  assert.deepEqual(row.layers, { fixed: 0, recent: 0, recall: 0, conclusion: 0 });
  assert.equal(row.total, 0);
  assert.equal(row.carried, 0);
  assert.equal(row.reconciliation.available, false);
  assert.equal(row.budget.over, false);
  assert.equal(row.budget.applied.length, 0);
  assert.equal(row.source, 'live');
});

test('measureTurn: four layers, carry, budget and usage reconciliation', () => {
  resetSeq();
  const events = [
    turnStart(1),
    systemEvent('S'.repeat(350), 1),
    userEvent('A'.repeat(350), { kind: 'agent-instructions' }, 1),
    userEvent('real one', { kind: 'user' }, 1),
    assistantEvent('answer one', 1),
    toolEvent('tool output one', 1),
    event('turn/end', { turn: 1 }),
    turnStart(2),
    userEvent('【自动想起】\n- 《A》（a.md · 1.0）\n- 《B》（b.md · 0.9）', { kind: 'session-reference', form: 'recall' }),
    userEvent('【开机卡】boot conclusion', { kind: 'session-reference' }),
    userEvent('real two', { kind: 'user' }, 2),
    assistantEvent('answer two', 2, {
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
      totalTokens: 3050,
    }),
  ];
  const usage = events[events.length - 1].data.usage;
  const row = measureTurn({
    events,
    turn: 2,
    sessionId: 's-layers',
    requestHeader: { tools: [{ name: 'read', description: 'read a file' }] },
    actualUsage: usage,
    config: { keepTurns: 12, targetTokens: 100, layerTargets: { fixed: 10, recent: 10, recall: 10, conclusion: 10 } },
    factor: 1,
    calibrationSamples: 3,
    now: '2026-11-05T00:00:00.000Z',
  });
  assert.ok(row.layers.fixed > 0);
  assert.ok(row.layers.recent > 0);
  assert.ok(row.layers.recall > 0);
  assert.ok(row.layers.conclusion > 0);
  assert.equal(row.total, row.layers.fixed + row.layers.recent + row.layers.recall + row.layers.conclusion + row.carried);
  assert.equal(row.recallCount, 2);
  assert.deepEqual(row.recallIds.sort(), ['a.md', 'b.md']);
  assert.equal(row.actual.requestInputTokens, 3000);
  assert.equal(row.reconciliation.available, true);
  assert.equal(row.reconciliation.delta, row.total - 3000);
  assert.equal(row.budget.over, true);
  assert.equal(row.budget.triggered, true);
  assert.equal(row.budget.applied.length, 0);
  assert.equal(row.budget.note.includes('measure-only'), true);
  assert.equal(row.tokenSource, 'estimate-calibrated');
  assert.equal(row.at, '2026-11-05T00:00:00.000Z');
});

test('measureTurn: older conversation becomes carried', () => {
  resetSeq();
  const events = [
    turnStart(1),
    userEvent('old real', { kind: 'user' }, 1),
    assistantEvent('old answer', 1),
    turnStart(10),
    userEvent('new real', { kind: 'user' }, 10),
    assistantEvent('new answer', 10),
  ];
  const row = measureTurn({ events, turn: 10, sessionId: 's', config: { keepTurns: 2 } });
  assert.ok(row.carried > 0);
  assert.equal(row.components.recentTurns, 1);
});

test('measureTurn: missing content, header and usage are safe', () => {
  resetSeq();
  const events = [
    turnStart(1),
    event('user/message', { role: 'user', content: undefined }),
    event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant' } }),
  ];
  const row = measureTurn({ events, turn: 1, sessionId: 's' });
  assert.equal(row.actual, null);
  assert.equal(row.reconciliation.available, false);
  assert.equal(row.components.tools, 0);
  assert.equal(row.total, 0);
});

test('measureTurn: very large budgets and token sums stay finite', () => {
  resetSeq();
  const events = [
    turnStart(1),
    systemEvent('x'.repeat(10000), 1),
    userEvent('y'.repeat(10000), { kind: 'user' }, 1),
    assistantEvent('z'.repeat(10000), 1, {
      inputTokens: 1_000_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 2_000_000_000,
      cacheWriteTokens: 1_000_000_000,
      totalTokens: 4_001_000_000,
    }),
  ];
  const row = measureTurn({
    events,
    turn: 1,
    sessionId: 's-big',
    actualUsage: events[events.length - 1].data.usage,
    config: { targetTokens: 1_000_000_000, keepTurns: 12 },
    factor: 2,
  });
  assert.ok(Number.isSafeInteger(row.total));
  assert.equal(row.layers.fixed + row.layers.recent + row.layers.recall + row.layers.conclusion + row.carried, row.total);
  assert.equal(row.actual.requestInputTokens, 4_000_000_000);
  assert.equal(row.budget.over, false);
});

test('summarizeRows / median: empty and large values', () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  const empty = summarizeRows([]);
  assert.equal(empty.turns, 0);
  assert.equal(empty.medianTotal, 0);
  const summary = summarizeRows([
    { at: '2026-01-01T00:00:00Z', sessionId: 'a', total: 1_000_000_000, layers: { fixed: 1 }, cacheHitRate: 0.5, budget: { triggered: false }, reconciliation: { actualInput: 900_000_000, deltaPct: 10, within5pct: false } },
    { at: '2026-01-02T00:00:00Z', sessionId: 'a', total: 2_000_000_000, layers: { fixed: 2 }, cacheHitRate: 0.7, budget: { triggered: true }, reconciliation: { actualInput: 2_000_000_000, deltaPct: 0, within5pct: true } },
  ]);
  assert.equal(summary.turns, 2);
  assert.equal(summary.medianTotal, 1_500_000_000);
  assert.equal(summary.overBudgetTurns, 1);
  assert.equal(summary.within5Turns, 1);
  assert.equal(summary.medianAbsErrorPct, 5);
});

test('store: append, read, skip corrupt, filter and limit', () => {
  const root = tempRoot();
  assert.equal(appendTurnRow({ at: '2026-01-01T00:00:00Z', sessionId: 'a', turn: 1, total: 10 }, { memoryRoot: root }).ok, true);
  assert.equal(appendTurnRow({ at: '2026-01-02T00:00:00Z', sessionId: 'b', turn: 2, total: 20 }, { memoryRoot: root }).ok, true);
  fs.appendFileSync(ledgerPath(root), '{not json}\n\n', 'utf8');
  assert.equal(appendTurnRow({ at: '2026-01-03T00:00:00Z', sessionId: 'a', turn: 3, total: 30 }, { memoryRoot: root }).ok, true);

  const all = readTurnLedger({ memoryRoot: root });
  assert.equal(all.ok, true);
  assert.equal(all.total, 3);
  assert.equal(all.skipped, 1);
  assert.equal(all.rows.length, 3);

  const filtered = readTurnLedger({ memoryRoot: root, sessionId: 'a', limit: 1 });
  assert.equal(filtered.total, 2);
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].turn, 3);

  const range = readTurnLedger({ memoryRoot: root, since: '2026-01-02T00:00:00Z', until: '2026-01-02T23:59:59Z' });
  assert.equal(range.total, 1);
  assert.equal(range.rows[0].turn, 2);
});

test('store: missing ledger is ok with exists:false', () => {
  const root = tempRoot();
  const ledger = readTurnLedger({ memoryRoot: root });
  assert.equal(ledger.ok, true);
  assert.equal(ledger.exists, false);
  assert.deepEqual(ledger.rows, []);
  assert.equal(readTurnLedger({ memoryRoot: '' }).ok, false);
  assert.equal(appendTurnRow({}, { memoryRoot: '' }).ok, false);
});

test('store: summary and calibration roundtrip with clamps', () => {
  const root = tempRoot();
  for (let turn = 1; turn <= 3; turn += 1) {
    appendTurnRow({
      at: `2026-01-0${turn}T00:00:00Z`,
      sessionId: 's',
      turn,
      total: 1000 * turn,
      layers: { fixed: 100, recent: 200, recall: 10, conclusion: 5 },
      reconciliation: { actualInput: 1000 * turn, deltaPct: 0, within5pct: true },
      budget: { triggered: false },
    }, { memoryRoot: root });
  }
  const summary = readMetricsSummary({ memoryRoot: root });
  assert.equal(summary.ok, true);
  assert.equal(summary.available, true);
  assert.equal(summary.summary.turns, 3);
  assert.equal(summary.summary.sessions, 1);
  assert.equal(summary.summary.medianTotal, 2000);

  assert.equal(writeCalibration(root, { factor: 99, samples: 2, rawSum: 100, actualSum: 120 }).ok, true);
  const state = readCalibration(root);
  assert.equal(state.ok, true);
  assert.equal(state.factor, 2);
  assert.equal(state.samples, 2);
  assert.equal(state.rawSum, 100);
  assert.equal(state.actualSum, 120);
  fs.writeFileSync(path.join(root, '.longlive', 'metrics', 'state.json'), '{bad', 'utf8');
  const broken = readCalibration(root);
  assert.equal(broken.ok, false);
  assert.equal(broken.factor, 1);
});

test('store: lastConclusion is empty without a board and reads a future field', () => {
  const root = tempRoot();
  assert.equal(readLastConclusion({ memoryRoot: root, sessionId: 's' }), '');
  const boardDir = path.join(root, '.longlive', 'router');
  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({
    focus: [{ sessionId: 's', goal: 'x', lastConclusion: 'we decided to keep it' }],
  }), 'utf8');
  assert.equal(readLastConclusion({ memoryRoot: root, sessionId: 's' }), 'we decided to keep it');
  assert.equal(readLastConclusion({ memoryRoot: '', sessionId: 's' }), '');
});

test('index: usage/header finders and registerMetrics writes on turn/end', () => {
  const root = tempRoot();
  const events = [
    turnStart(1),
    systemEvent('system', 1),
    userEvent('hello', { kind: 'user' }, 1),
    assistantEvent('answer', 1, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 35 }),
    event('request/header', { header: { tools: [{ name: 'read' }], config: { model: 'm' } } }),
    event('turn/end', { turn: 1 }),
  ];
  assert.equal(findUsageEvent(events, 1).data.usage.inputTokens, 10);
  assert.equal(findRequestHeader(events).tools.length, 1);

  const listeners = [];
  const ctx = { on(name, handler) { listeners.push({ name, handler }); return () => {}; } };
  const handle = registerMetrics(ctx, { metrics: { enabled: true } }, { memoryRoot: root, now: () => new Date('2026-11-05T00:00:00Z') });
  assert.equal(handle.enabled, true);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].name, 'session/event');

  const session = {
    id: 's-live',
    snapshotEvents: () => events.slice(0, 4),
    requestHeader: () => ({ tools: [{ name: 'read' }] }),
  };
  listeners[0].handler(session, { type: 'turn/end', data: { turn: 1 } });
  const ledger = readTurnLedger({ memoryRoot: root, sessionId: 's-live' });
  assert.equal(ledger.total, 1);
  assert.equal(ledger.rows[0].turn, 1);
  assert.equal(ledger.rows[0].actual.requestInputTokens, 30);
  assert.equal(readCalibration(root).samples, 1);

  // Duplicate turn/end must not append a second row.
  listeners[0].handler(session, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(readTurnLedger({ memoryRoot: root, sessionId: 's-live' }).total, 1);

  // A missing root disables the recorder instead of throwing.
  assert.equal(registerMetrics(ctx, {}, {}).enabled, false);
});

test('router_status: ledger field is read-only and degrades without a root', async () => {
  const root = tempRoot();
  appendTurnRow({
    at: '2026-01-01T00:00:00Z',
    sessionId: 's',
    turn: 1,
    total: 123,
    layers: { fixed: 1, recent: 2, recall: 0, conclusion: 0 },
    reconciliation: { actualInput: 123, deltaPct: 0, within5pct: true },
    budget: { triggered: false },
  }, { memoryRoot: root });
  const service = {
    status: () => ({ state: 'idle', runId: 'r1' }),
    deps: { memoryRoot: root },
  };
  const tools = createRouterTools(service);
  const status = tools.find((tool) => tool.name === 'router_status');
  const result = await status.invoke();
  assert.equal(result.ok, true);
  assert.equal(result.state, 'idle');
  assert.equal(result.ledger.ok, true);
  assert.equal(result.ledger.available, true);
  assert.equal(result.ledger.summary.turns, 1);

  const noRoot = createRouterTools({ status: () => ({ state: 'idle' }), deps: {} });
  const noRootResult = await noRoot.find((tool) => tool.name === 'router_status').invoke();
  assert.equal(noRootResult.ledger.ok, false);
  assert.equal(noRootResult.ledger.code, 'E_MEMORY_ROOT_UNSET');
});
