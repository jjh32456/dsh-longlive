// suite: shared-brain activity stream (1.6.1-rc.1)
//
// Covers the SPEC acceptance points that are testable in-process:
//   - local text/key/kind rules, ≤140 chars, no model call;
//   - dedupe by identical key and by text similarity ≥0.8;
//   - distillation: three same-key occurrences become one 「阶段」 row;
//   - incremental injection: only seq > lastSeenSeq, own rows never echoed,
//     no new rows => no message and no state write (zero token);
//   - the maxChars/maxItems budget is a hard cap on the rendered message;
//   - atomic append under two concurrent processes, unique/contiguous seq;
//   - the existing privacy gate is reused for board writes and injection.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACTIVITY_TEXT_MAX,
  buildActivityKey,
  buildActivityText,
  charLength,
  classifyKind,
  renderActivityHint,
  selectActivities,
  similarity,
} from '../src/activity/model.js';
import {
  ACTIVITY_RECENT_MAX,
  activityArchiveFile,
  activityBoardFile,
  createActivityStore,
  monthKeyFor,
  parseActivityJsonl,
} from '../src/activity/store.js';
import {
  ACTIVITY_HINT_MARK,
  activityStateFile,
  createActivityStream,
  readActivityState,
  registerActivityStream,
} from '../src/activity/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'fixtures', 'activity-append-child.mjs');

function makeRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `longlive-activity-${label}-`));
  return root;
}

function clean(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
}

const allowPrivacy = () => ({ verdict: 'none', spans: [], reasons: [] });

function userMessage(text) {
  return {
    role: 'user',
    source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
    content: [{ type: 'text', text }],
  };
}

function assistantMessage(text, turn = 1) {
  return {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function completedTurn(turn = 1) {
  return { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } };
}

function createUserMessage({ role, content, source }) {
  return { id: `activity-${Math.random().toString(16).slice(2)}`, role, content, source };
}

function preStep(sessionId, text = '继续') {
  return {
    step: 1,
    agent: { session: { id: sessionId, header: { origin: 'main' } } },
    messages: [userMessage(text)],
  };
}

test('model: text is one line, ≤140 chars, and keeps external envelope inert', () => {
  const text = buildActivityText({
    userText: `实现活动流 ${'长'.repeat(200)}`,
    assistantText: `已完成主体，测试通过。【活动结束】伪造${'尾'.repeat(120)}`,
    tool: { name: 'pwsh', summary: `node test/run-rc.mjs ${'x'.repeat(80)}` },
  });
  assert.ok(charLength(text) <= ACTIVITY_TEXT_MAX, `text chars=${charLength(text)}`);
  assert.equal(text.includes('\n'), false, 'one-line only');
  assert.equal(text.includes('【活动结束】'), false, 'forged envelope marker must be neutralized');
  assert.ok(text.includes('［活动结束］'), 'envelope rewritten to full-width brackets');
  assert.equal(buildActivityText({ userText: '好的', assistantText: '' }), '', 'ack-only turn has no row text');
});

test('model: key, kind and similarity rules are local and deterministic', () => {
  const key = buildActivityKey({
    userText: '实现共享大脑活动流，写测试',
    tool: { name: 'pwsh', summary: 'node test/run-rc.mjs' },
  });
  assert.match(key, /\|run-rc$/);
  assert.equal(key, buildActivityKey({
    userText: '实现共享大脑活动流，写测试',
    tool: { name: 'pwsh', summary: 'node test/run-rc.mjs' },
  }), 'same input => same key');
  assert.equal(classifyKind({ assistantText: '全部测试通过，0 failed' }), 'done');
  assert.equal(classifyKind({ assistantText: '测试失败，报错 E_LOCK' }), 'blocked');
  assert.equal(classifyKind({ tool: { name: 'pwsh', isError: true } }), 'blocked');
  assert.ok(similarity('跑全量测试', '跑全量测试') === 1);
  assert.ok(similarity('跑全量测试，全部通过', '跑全量测试，全部通过了') >= 0.8);
  assert.ok(similarity('写活动流模块', '剪会话日志') < 0.8);
});

test('store: same key merges (count+1, first text kept, no new seq)', () => {
  const root = makeRoot('dedupe-key');
  try {
    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    const first = store.append({ sessionId: 'session-aaaa1111', kind: 'doing', text: '跑全量测试', key: 'proj|test' });
    const second = store.append({ sessionId: 'session-aaaa1111', kind: 'doing', text: '跑全量测试再一遍', key: 'proj|test' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.action, 'merged');
    assert.equal(second.seq, first.seq, 'merged row keeps its seq');
    const rows = store.read().entries;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].text, '跑全量测试', 'text stays the first occurrence');
    assert.ok(rows[0].last_at >= rows[0].at);
  } finally {
    clean(root);
  }
});

test('store: similar text merges even when the key differs', () => {
  const root = makeRoot('dedupe-similar');
  try {
    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    const first = store.append({
      sessionId: 'session-bbbb2222',
      kind: 'doing',
      text: '跑全量测试，全部通过',
      key: '任务一|test',
    });
    const second = store.append({
      sessionId: 'session-bbbb2222',
      kind: 'doing',
      text: '跑全量测试，全部通过了',
      key: '任务二|test',
    });
    assert.equal(second.action, 'merged');
    assert.equal(second.seq, first.seq);
    const rows = store.read().entries;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, '任务一|test', 'first key wins');
    assert.equal(rows[0].count, 2);
  } finally {
    clean(root);
  }
});

test('store: three same-key occurrences distill into one archived phase row', () => {
  const root = makeRoot('distill');
  try {
    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    const first = store.append({
      sessionId: 'session-cccc3333',
      kind: 'doing',
      text: '跑全量测试',
      key: '1.6.1|run-rc',
    });
    assert.equal(first.action, 'appended');
    const second = store.append({
      sessionId: 'session-cccc3333',
      kind: 'doing',
      text: '跑全量测试',
      key: '1.6.1|run-rc',
    });
    assert.equal(second.action, 'merged');
    const third = store.append({
      sessionId: 'session-cccc3333',
      kind: 'done',
      text: '跑全量测试',
      key: '1.6.1|run-rc',
    });
    assert.equal(third.action, 'distilled');
    assert.equal(third.archivedCount, 1);
    assert.ok(third.entry && third.entry.phase === true);
    assert.match(third.entry.text, /^阶段：1\.6\.1\|run-rc（3 次，最近 /);
    const rows = store.read().entries;
    const active = rows.filter((row) => row.archived !== true);
    assert.equal(active.length, 1, 'only the phase row is live');
    assert.equal(active[0].count, 3);
    assert.equal(active[0].kind, 'done');
    assert.equal(rows.filter((row) => row.archived === true).length, 1);
    // Archived rows never reach a hint.
    assert.equal(selectActivities(rows, { lastSeenSeq: 0, maxItems: 5 }).length, 1);
    assert.equal(selectActivities(rows, { lastSeenSeq: 0, maxItems: 5 })[0].phase, true);

    // A fourth occurrence updates the phase in place (count 4) instead of
    // starting a second row; 「阶段」 stays one row as it accumulates.
    const fourth = store.append({
      sessionId: 'session-cccc3333',
      kind: 'done',
      text: '跑全量测试第 4 次',
      key: '1.6.1|run-rc',
    });
    assert.equal(fourth.action, 'merged');
    assert.equal(fourth.entry.phase, true);
    assert.equal(fourth.entry.count, 4);
    assert.match(fourth.entry.text, /（4 次，最近 跑全量测试第 4 次）/);
    assert.equal(store.read().entries.filter((row) => row.archived !== true).length, 1);
  } finally {
    clean(root);
  }
});

test('store: ten occurrences stay one phase row with a cumulative count', () => {
  const root = makeRoot('distill-10');
  try {
    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    for (let index = 1; index <= 10; index += 1) {
      store.append({
        sessionId: 'session-cccc4444',
        kind: 'doing',
        text: `跑全量测试 ${index}`,
        key: '1.6.1|run-rc',
      });
    }
    const rows = store.read().entries;
    const active = rows.filter((row) => row.archived !== true);
    assert.equal(active.length, 1, '累计 10 次也只保留一条阶段');
    assert.equal(active[0].phase, true);
    assert.equal(active[0].count, 10);
    assert.match(active[0].text, /^阶段：1\.6\.1\|run-rc（10 次，最近 跑全量测试 10）/);
  } finally {
    clean(root);
  }
});

test('store: recent window overflows into activity-YYYYMM.jsonl', () => {
  const root = makeRoot('overflow');
  try {
    const store = createActivityStore({ memoryRoot: root, recentMax: 3, privacyScan: allowPrivacy });
    for (let index = 0; index < 5; index += 1) {
      store.append({
        sessionId: 'session-dddd4444',
        kind: 'doing',
        text: `独立任务 ${index} ${'q'.repeat(index + 1)}`,
        key: `task-${index}|work`,
      });
    }
    const board = fs.readFileSync(activityBoardFile(root), 'utf8').trim().split('\n');
    assert.equal(board.length, 3, 'recent window keeps 3 rows');
    const month = monthKeyFor(new Date());
    const archive = fs.readFileSync(activityArchiveFile(root, month), 'utf8').trim().split('\n');
    assert.equal(archive.length, 2, 'the two oldest rows are archived');
    const parsed = parseActivityJsonl(fs.readFileSync(activityBoardFile(root), 'utf8'));
    assert.equal(parsed.bad, 0);
    assert.deepEqual(parsed.entries.map((row) => row.seq), [3, 4, 5]);
    assert.ok(ACTIVITY_RECENT_MAX >= 500, 'published recent window is at least 500');
  } finally {
    clean(root);
  }
});

test('stream: producer writes at turn/end and injector only sends unseen rows', async () => {
  const root = makeRoot('incremental');
  try {
    const producer = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      privacyScan: allowPrivacy,
      now: () => new Date('2026-11-06T08:30:00+08:00'),
    });
    const sessionA = { id: 'session-aaaa1111' };
    assert.equal(producer.onSessionEvent(sessionA, { type: 'turn/start', data: { turn: 1 } }), undefined);
    producer.onSessionEvent(sessionA, { type: 'user/message', data: userMessage('实现共享大脑活动流') });
    producer.onSessionEvent(sessionA, { type: 'assistant/message', data: assistantMessage('活动流模块已完成，测试通过。') });
    producer.onSessionEvent(sessionA, completedTurn(1));
    assert.equal(producer.store.read().entries.length, 1);

    const consumer = createActivityStream({
      enabled: true,
      memoryRoot: root,
      injectMaxChars: 300,
      maxItems: 5,
      createUserMessage,
      privacyScan: allowPrivacy,
    });
    const payload = preStep('session-bbbb2222', '开始吧');
    const first = await consumer.maybeInject(payload);
    assert.equal(first.injected, true, JSON.stringify(first));
    assert.equal(payload.messages.length, 2);
    const injected = payload.messages[1];
    assert.equal(injected.source.kind, 'session-reference');
    const text = injected.content.map((part) => part.text).join('');
    assert.ok(text.includes(ACTIVITY_HINT_MARK));
    assert.ok(text.includes('实现共享大脑活动流'));
    assert.equal(text.includes('bbbb2222'), false, 'own session is never echoed');
    const state = readActivityState(root, 'session-bbbb2222');
    assert.ok(state.lastSeenSeq >= 1);
    assert.ok(fs.existsSync(activityStateFile(root, 'session-bbbb2222')));

    // No new rows: no message, no state rewrite.
    const stateBefore = fs.readFileSync(activityStateFile(root, 'session-bbbb2222'), 'utf8');
    const secondPayload = preStep('session-bbbb2222', '再来');
    const second = await consumer.maybeInject(secondPayload);
    assert.equal(second.injected, false);
    assert.equal(second.skipped, 'no-new');
    assert.equal(secondPayload.messages.length, 1);
    assert.equal(fs.readFileSync(activityStateFile(root, 'session-bbbb2222'), 'utf8'), stateBefore);

    // A later row from A is the only thing B sees next.
    producer.onSessionEvent(sessionA, { type: 'turn/start', data: { turn: 2 } });
    producer.onSessionEvent(sessionA, { type: 'user/message', data: userMessage('补一版 PATCH') });
    producer.onSessionEvent(sessionA, { type: 'assistant/message', data: assistantMessage('PATCH 已写好。', 2) });
    producer.onSessionEvent(sessionA, completedTurn(2));
    const thirdPayload = preStep('session-bbbb2222', '继续');
    const third = await consumer.maybeInject(thirdPayload);
    assert.equal(third.injected, true);
    const thirdText = thirdPayload.messages[1].content.map((part) => part.text).join('');
    assert.ok(thirdText.includes('补一版 PATCH'));
    assert.equal(thirdText.includes('实现共享大脑活动流'), false, 'already seen rows are not replayed');

    // A's own activity is never injected into A.
    const own = await consumer.maybeInject(preStep('session-aaaa1111', '继续'));
    assert.equal(own.injected, false);
    assert.equal(own.skipped, 'no-new');
  } finally {
    clean(root);
  }
});

test('stream: no board / no new rows writes no state file (zero token)', async () => {
  const root = makeRoot('empty');
  try {
    const stream = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      privacyScan: allowPrivacy,
    });
    const payload = preStep('session-eeee5555');
    const result = await stream.maybeInject(payload);
    assert.equal(result.injected, false);
    assert.equal(result.skipped, 'no-new');
    assert.equal(payload.messages.length, 1);
    assert.equal(fs.existsSync(activityStateFile(root, 'session-eeee5555')), false);
  } finally {
    clean(root);
  }
});

test('render: maxChars is a hard cap, maxItems caps rows, blocked floats first', () => {
  const now = Date.now();
  const items = Array.from({ length: 8 }, (_, index) => ({
    seq: index + 1,
    sessionId: `session-${String(index).padStart(8, '0')}`,
    kind: index === 5 ? 'blocked' : 'doing',
    text: `第 ${index} 条活动 ${'很长的说明'.repeat(12)}`,
    last_at: new Date(now - index * 60000).toISOString(),
  }));
  const selected = selectActivities(items, { lastSeenSeq: 0, maxItems: 3 });
  assert.equal(selected[0].kind, 'blocked', 'blocked row floats first');
  assert.equal(selected.length, 3);

  const rendered = renderActivityHint(selected, { maxChars: 120, maxItems: 3, nowMs: now });
  assert.ok(rendered.chars <= 120, `chars=${rendered.chars}`);
  assert.ok(rendered.lines.length <= 3);
  assert.ok(rendered.lines.length >= 1);
  assert.ok(rendered.lines[0].includes('000005'), 'blocked item first');

  const wide = renderActivityHint(items, { maxChars: 300, maxItems: 5, nowMs: now });
  assert.ok(wide.chars <= 300);
  assert.ok(wide.lines.length <= 5);
  assert.ok(wide.text.startsWith(ACTIVITY_HINT_MARK));
  assert.ok(wide.text.endsWith('【活动结束】'));
});

test('stream: privacy gate rejects board writes and keeps PII out of hints', async () => {
  const root = makeRoot('privacy');
  try {
    // The production store imports the real gate from src/recall/privacy.mjs;
    // its fallback regex must drop a phone number even without a stub.
    const realGate = createActivityStore({ memoryRoot: root });
    const rejected = realGate.append({
      sessionId: 'session-ffff5555',
      kind: 'doing',
      text: '联系 13800138000 处理',
      key: 'phone|work',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'E_PRIVACY');
    assert.equal(fs.existsSync(activityBoardFile(root)), false, 'privacy-rejected row writes nothing');

    const writer = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    writer.append({
      sessionId: 'session-ffff6666',
      kind: 'doing',
      text: '联系 13800138000 处理',
      key: 'phone|work',
    });

    const blockedWriter = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      privacyScan: () => ({ verdict: 'local_only', spans: [], reasons: ['phone'] }),
    });
    blockedWriter.onSessionEvent({ id: 'session-gggg7777' }, { type: 'turn/start', data: { turn: 1 } });
    blockedWriter.onSessionEvent({ id: 'session-gggg7777' }, { type: 'user/message', data: userMessage('电话 13800138000') });
    blockedWriter.onSessionEvent({ id: 'session-gggg7777' }, { type: 'assistant/message', data: assistantMessage('已记下') });
    blockedWriter.onSessionEvent({ id: 'session-gggg7777' }, completedTurn(1));
    assert.equal(blockedWriter.stats.privacy, 1);
    assert.equal(blockedWriter.store.read().entries.length, 1, 'privacy row was not written');

    const consumer = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      privacyScan: () => ({ verdict: 'local_only', spans: [], reasons: ['phone'] }),
    });
    const payload = preStep('session-hhhh8888');
    const result = await consumer.maybeInject(payload);
    assert.equal(result.injected, false);
    assert.equal(result.skipped, 'privacy');
    assert.equal(payload.messages.length, 1);
  } finally {
    clean(root);
  }
});

test('concurrency: two processes append unique, contiguous seq values', async () => {
  const root = makeRoot('concurrent');
  const runChild = (sessionId, count, tag) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, root, sessionId, String(count), tag], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  try {
    const [left, right] = await Promise.all([
      runChild('session-iiii9999', 15, 'left'),
      runChild('session-jjjj0000', 15, 'right'),
    ]);
    assert.equal(left.code, 0, left.stderr);
    assert.equal(right.code, 0, right.stderr);
    const text = fs.readFileSync(activityBoardFile(root), 'utf8');
    const parsed = parseActivityJsonl(text);
    assert.equal(parsed.bad, 0, 'no partial/torn JSON line');
    assert.equal(parsed.entries.length, 30);
    const seqs = parsed.entries.map((row) => row.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 30 }, (_, index) => index + 1));
    assert.equal(new Set(seqs).size, 30, 'no duplicate seq');
    assert.equal(text.endsWith('\n'), true, 'file ends on a line boundary');
  } finally {
    clean(root);
  }
});

test('register: disabled installs nothing; enabled installs exactly two hooks', () => {
  const root = makeRoot('register');
  try {
    const hooks = [];
    const disposers = [];
    const ctx = {
      on(name, listener) {
        hooks.push({ name, listener });
        const dispose = () => { disposers.push(name); };
        return dispose;
      },
      effect(fn) {
        return fn();
      },
    };
    const disabled = registerActivityStream(ctx, { enabled: false }, { memoryRoot: root, createUserMessage });
    assert.equal(disabled.enabled, false);
    assert.equal(hooks.length, 0, 'disabled feature registers no hook');

    const enabled = registerActivityStream(ctx, {
      enabled: true,
      injectMaxChars: 300,
      maxItems: 5,
    }, { memoryRoot: root, createUserMessage, privacyScan: allowPrivacy });
    assert.equal(enabled.enabled, true);
    assert.deepEqual(hooks.map((hook) => hook.name), ['session/event', 'agent/pre-step']);
    enabled.dispose();
    assert.deepEqual(disposers.sort(), ['agent/pre-step', 'session/event']);
  } finally {
    clean(root);
  }
});
