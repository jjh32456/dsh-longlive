// routerFace v1 tests: dry-run, budget brake, outbox-only, journal idempotency,
// identity fallback, silent tick failure. All use a fake memoryRoot and an
// injected fake LLM client; no host, no profile, no network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildFaceContext,
  createRouterFace,
  facePaths,
  normalizeFaceConfig,
  parseIdentity,
  readIdentity,
  readJournal,
  readOutbox,
  renderIdentityLine,
  appendJournalOnce,
} from '../../src/router/face/index.mjs';

const ISO = '2026-11-05T02:00:00.000Z';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-face-'));
  fs.mkdirSync(path.join(root, '.longlive', 'router'), { recursive: true });
  fs.mkdirSync(path.join(root, '.longlive', 'live'), { recursive: true });
  fs.mkdirSync(path.join(root, 'flow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'STATE.md'), [
    '# 状态卡',
    '## 我在哪',
    '在写后台面 v1 的 face 模块。',
    '## 在等什么',
    '等全量测试结果。',
    '## 最近三件',
    '- 复制副本',
    '- 读源码',
    '- 写 face',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'flow', 'current.md'), [
    '## 我在哪',
    '实现 tick 与 outbox。',
    '## 下一步',
    '跑全量测试。',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, '.longlive', 'router', 'board.json'), JSON.stringify({
    v: 1,
    seq: 3,
    boardHash: 'board-hash-face-1',
    focus: [{
      sessionId: 'sess-a',
      goal: '后台面 v1',
      lastAction: { kind: 'turn', detail: 'turn/end #7', at: ISO },
      queuedCount: 1,
    }],
    timeline: [],
    pulse: { active: 1, running: 1, blocked: 0, unknownSessions: 0, queuedProposals: 0 },
  }), 'utf8');
  fs.writeFileSync(path.join(root, '.longlive', 'live', 'sess-a.json'), JSON.stringify({
    sessionId: 'sess-a',
    state: 'running',
    goal: '后台面 v1',
    queued: ['写测试', '跑全量'],
  }), 'utf8');
  return root;
}

function makeClock(value = ISO) {
  const clock = { t: Date.parse(value) };
  clock.now = () => new Date(clock.t);
  return clock;
}

function cleanup(t, root) {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
}

test('normalizeFaceConfig: strict booleans, clamps, defaults off', () => {
  const defaults = normalizeFaceConfig(undefined, { memoryRoot: 'X:/root' });
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.dryRun, true);
  assert.equal(defaults.tickMs, 60000);
  assert.equal(defaults.maxContextTokens, 30000);
  assert.equal(defaults.dailyTokenBudget, 50000);

  const bad = normalizeFaceConfig({
    enabled: 'true',
    dryRun: 1,
    tickMs: 1,
    maxContextTokens: 99999999,
    unknownKey: true,
  }, { memoryRoot: 'X:/root' });
  assert.equal(bad.enabled, false);
  assert.equal(bad.dryRun, true);
  assert.equal(bad.tickMs, 60000);
  assert.equal(bad.maxContextTokens, 30000);
  assert.ok(bad.warnings.includes('FACE_CONFIG_INVALID:enabled'));
  assert.ok(bad.warnings.includes('FACE_CONFIG_INVALID:dryRun'));
  assert.ok(bad.warnings.includes('FACE_CONFIG_UNKNOWN:unknownKey'));
});

test('dry-run: assembles context, writes journal, never calls the LLM', async (t) => {
  const root = makeRoot();
  cleanup(t, root);
  const clock = makeClock();
  let calls = 0;
  const face = createRouterFace({
    memoryRoot: root,
    rawConfig: { enabled: true, dryRun: true, tickMs: 30000, maxContextTokens: 5000 },
    now: clock.now,
    client: { complete: async () => { calls += 1; return { text: 'must not be called' }; } },
  });

  const first = await face.tick('test');
  assert.equal(first.ok, true);
  assert.equal(first.dryRun, true);
  assert.equal(calls, 0, 'dry-run must not call the LLM');
  const journal = readJournal(path.join(root, '.longlive', 'face', 'journal.jsonl'), { limit: 5 });
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, 'dry-run');
  assert.equal(journal[0].dryRun, true);
  assert.ok(Array.from(journal[0].text).length <= 400);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'bridge', 'router-outbox.jsonl')), false,
    'dry-run must not write the outbox');

  const second = await face.tick('test');
  assert.equal(second.skipped, 'duplicate-tick');
  assert.equal(readJournal(path.join(root, '.longlive', 'face', 'journal.jsonl'), { limit: 5 }).length, 1);
  assert.equal(calls, 0);
});

test('budget: crossing dailyTokenBudget stops the face and the next tick is inert', async (t) => {
  const root = makeRoot();
  cleanup(t, root);
  const clock = makeClock();
  let calls = 0;
  const face = createRouterFace({
    memoryRoot: root,
    rawConfig: {
      enabled: true,
      dryRun: false,
      tickMs: 30000,
      dailyTokenBudget: 1000,
      maxContextTokens: 5000,
    },
    now: clock.now,
    client: {
      complete: async () => {
        calls += 1;
        return {
          text: JSON.stringify({ journal: '推进了一步。', suggestions: ['看看测试结果'] }),
          usage: { inputTokens: 900, outputTokens: 200 },
        };
      },
    },
  });

  const first = await face.tick('test');
  assert.equal(first.ok, true);
  assert.equal(first.stopped, true);
  assert.equal(first.reason, 'daily-budget');
  assert.equal(calls, 1);
  const status = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'face', 'status.json'), 'utf8'));
  assert.equal(status.state, 'stopped');
  assert.equal(status.reason, 'daily-budget');
  assert.equal(status.today.usedTokens, 1100);

  const second = await face.tick('test');
  assert.equal(second.skipped, 'stopped');
  assert.equal(calls, 1, 'no second call after the budget brake');
});

test('outbox: suggestions are written as data and no LLM/tool is executed', async (t) => {
  const root = makeRoot();
  cleanup(t, root);
  const clock = makeClock();
  let ctxReads = 0;
  const face = createRouterFace({
    memoryRoot: root,
    rawConfig: {
      enabled: true,
      dryRun: false,
      tickMs: 30000,
      dailyTokenBudget: 50000,
      maxContextTokens: 5000,
      maxSuggestions: 2,
    },
    now: clock.now,
    ctx: { get: () => { ctxReads += 1; throw new Error('ctx.get must not be read with an injected client'); } },
    client: {
      complete: async () => ({
        text: JSON.stringify({
          journal: '后台面写了一条 journal，建议只进 outbox。',
          suggestions: ['先跑测试', '再看 REPORT'],
        }),
        usage: { inputTokens: 300, outputTokens: 80 },
      }),
    },
  });

  const result = await face.tick('test');
  assert.equal(result.ok, true);
  assert.equal(result.outboxWritten, 2);
  assert.equal(ctxReads, 0, 'injected client path never touches the host llm service');
  const rows = readOutbox(path.join(root, '.longlive', 'bridge', 'router-outbox.jsonl'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.kind, 'suggestion');
    assert.equal(row.sessionHint, 'root');
    assert.equal(row.readAt, null);
    assert.ok(Array.from(row.text).length <= 300);
  }
  const journal = readJournal(path.join(root, '.longlive', 'face', 'journal.jsonl'), { limit: 5 });
  assert.equal(journal.length, 1);
  assert.equal(journal[0].suggestions.length, 2);
  // The face's whole write surface: journal + outbox + state/status under its own dir.
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.longlive')).sort(),
    ['bridge', 'face', 'live', 'router'],
  );
});

test('journal: same tickKey appends once', async (t) => {
  const root = makeRoot();
  cleanup(t, root);
  const file = path.join(root, '.longlive', 'face', 'journal.jsonl');
  const first = appendJournalOnce(file, { tickKey: 'k-1', at: ISO, text: '第一次', day: '2026-11-05' });
  const second = appendJournalOnce(file, { tickKey: 'k-1', at: ISO, text: '第二次', day: '2026-11-05' });
  assert.equal(first.ok, true);
  assert.equal(first.appended, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  const rows = readJournal(file, { limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '第一次');
});

test('identity: missing file falls back to the built-in default; present file is shared', (t) => {
  const root = makeRoot();
  cleanup(t, root);
  const file = path.join(root, 'IDENTITY.md');
  const missing = readIdentity(file);
  assert.equal(missing.source, 'default');
  assert.match(missing.text, /听澜/);
  assert.equal(missing.warning, 'E_IDENTITY_MISSING');

  fs.writeFileSync(file, [
    '# 身份',
    '名字：阿澜',
    '称呼：主人',
    '必须守的：不编数字；不确定就说没查',
    '说话方式：短句，有情绪',
  ].join('\n'), 'utf8');
  const present = readIdentity(file);
  assert.equal(present.source, 'file');
  const parsed = parseIdentity(present.text);
  assert.equal(parsed.name, '阿澜');
  assert.equal(parsed.address, '主人');
  assert.match(renderIdentityLine(present), /^身份：阿澜/);

  const context = buildFaceContext({ memoryRoot: root, paths: facePaths(root), maxContextTokens: 5000 });
  assert.ok(context.text.includes('阿澜'), 'context carries the shared identity');
  assert.ok(context.sections.some((section) => section.key === 'identity'));
  assert.ok(context.tokens <= 5000);
});

test('failure: a throwing LLM stays silent and stops after 3 consecutive failures', async (t) => {
  const root = makeRoot();
  cleanup(t, root);
  const clock = makeClock();
  let calls = 0;
  const face = createRouterFace({
    memoryRoot: root,
    rawConfig: { enabled: true, dryRun: false, tickMs: 30000, dailyTokenBudget: 50000, maxContextTokens: 5000 },
    now: clock.now,
    client: { complete: async () => { calls += 1; throw new Error('provider down'); } },
  });

  const first = await face.tick('test');
  assert.equal(first.ok, false);
  assert.equal(first.stopped, false);
  assert.equal(calls, 1);

  clock.t += 30000;
  const second = await face.tick('test');
  assert.equal(second.ok, false);
  assert.equal(second.stopped, false);
  assert.equal(calls, 2);

  clock.t += 30000;
  const third = await face.tick('test');
  assert.equal(third.ok, false);
  assert.equal(third.stopped, true);
  assert.equal(third.reason, 'consecutive-failures');
  assert.equal(calls, 3);

  clock.t += 30000;
  const fourth = await face.tick('test');
  assert.equal(fourth.skipped, 'stopped');
  assert.equal(calls, 3, 'stopped face does not keep calling the provider');
  const status = JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'face', 'status.json'), 'utf8'));
  assert.equal(status.state, 'stopped');
  assert.equal(status.reason, 'consecutive-failures');
});

test('stop(): disabled config schedules nothing and start() is inert', () => {
  const root = makeRoot();
  const face = createRouterFace({ memoryRoot: root, rawConfig: {}, now: makeClock().now });
  const result = face.start();
  assert.equal(result.started, false);
  assert.equal(result.reason, 'disabled');
  face.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
