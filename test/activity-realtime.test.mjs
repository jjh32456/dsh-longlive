// suite: shared-brain activity stream — event-level realtime writes (P1)
//
// The rc.1 stream only wrote at `turn/end`, so a >10-minute turn stayed
// invisible to sibling sessions. This suite pins the event-level behaviour:
//   (a) a `tool/call` inside a running turn refreshes the turn's row text to
//       「工具：目标」 with a fresh last_at — no turn/end needed;
//   (b) same-key refreshes are throttled to ≤1 write/10s (a 12-call burst must
//       not flood the board), and a refresh after the window goes through;
//   (c) the store merge used for an event-level refresh bumps `seq` (touchSeq),
//       so the consumer's seq-only cursor (`seq > lastSeenSeq`) sees the later
//       update instead of being stuck behind the first row;
//   (d) `turn/end` still writes the local-rule conclusion row, deduped, and the
//       consumer still gets ≤5 items / ≤300 chars;
//   (e) `tool/result` with isError writes a blocked row (escalation may bypass
//       the window once, then it throttles like everything else);
//   (f) a disabled stream and a privacy-rejected event write nothing;
//   (g) S3 (red-team 1.6.8): key/token material (sk-*, DEEPSEEK_API_KEY=,
//       Bearer, private-key headers, …) never reaches the shared board or a
//       sibling hint even when the external privacy gate is unreachable; a
//       configured-but-unreachable gate warns and forces the strengthened local
//       rules; phone/email behavior is unchanged;
//   (h) R1.5 (red-team 1.6.8): overflow archiving must keep the just-refreshed
//       row (newest seq) on the board, so a full 500-row board still delivers
//       the latest action to a sibling's seq-only cursor;
//   (i) RE-S3.1 (red-team 1.6.8 re-break): lowercase/prefixed credential
//       assignments (`my_api_key: "…"`, `apiKey=…`, `secret token: …`,
//       `api_key = "…"`) are local_only, while ordinary English/code text
//       (`password reset flow`, `token 数 12`, `task-id-…`) is not over-blocked;
//   (j) RE-R15.5 (red-team 1.6.8 re-break): deleting/emptying the board must not
//       restart seq at 1 — the store keeps a seq high-water sidecar and writes a
//       `stream.reset.json` marker, and the consumer falls back to replaying the
//       board when its cursor is above every current row.
//
// Everything is local rules only: no model call, no host, temp memoryRoots.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACTIVITY_REFRESH_THROTTLE_MS,
  ACTIVITY_TEXT_MAX,
  buildToolActivityText,
  charLength,
} from '../src/activity/model.js';
import {
  activityArchiveFile,
  activityBoardFile,
  activityResetMarkerFile,
  activitySeqHighWaterFile,
  createActivityStore,
  monthKeyFor,
} from '../src/activity/store.js';
import {
  ACTIVITY_HINT_MARK,
  activityStateFile,
  createActivityStream,
  readActivityState,
} from '../src/activity/index.js';
import { fallbackScan, privacyScan } from '../src/recall/privacy.mjs';

function makeRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `longlive-activity-rt-${label}-`));
}

function clean(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
}

const allowPrivacy = () => ({ verdict: 'none', spans: [], reasons: [] });

function makeClock(startIso) {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms) => { current += ms; },
    time: () => current,
  };
}

const sessionOf = (id) => ({ id, header: { id, origin: 'main' } });
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } });
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } });
const userEvent = (text) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text }] },
});
const assistantEvent = (text, turn) => ({
  type: 'assistant/message',
  data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const toolCall = (name, args = {}) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } });
const toolResult = (isError = false) => ({ type: 'tool/result', data: { message: { isError } } });

function createUserMessage({ role, content, source }) {
  return { id: `activity-rt-${Math.random().toString(16).slice(2)}`, role, content, source };
}

function preStep(sessionId, text = '继续') {
  return {
    step: 1,
    agent: { session: { id: sessionId, header: { id: sessionId, origin: 'main' } } },
    messages: [{
      role: 'user',
      source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      content: [{ type: 'text', text }],
    }],
  };
}

function newStream(root, clock, extra = {}) {
  return createActivityStream({
    enabled: true,
    memoryRoot: root,
    createUserMessage,
    privacyScan: allowPrivacy,
    now: () => clock.now(),
    ...extra,
  });
}

function readBoard(root) {
  const file = path.join(root, '.longlive', 'board', 'activity.jsonl');
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

const liveRows = (rows) => rows.filter((row) => row.archived !== true);
const maxSeq = (rows) => rows.reduce((max, row) => (Number.isInteger(row.seq) && row.seq > max ? row.seq : max), 0);
const countSum = (rows) => rows.reduce((sum, row) => sum + (Number.isInteger(row.count) ? row.count : 1), 0);

function hintTextOf(result, payload) {
  if (typeof result?.text === 'string' && result.text !== '') return result.text;
  const found = [];
  for (const message of payload.messages) {
    for (const block of message.content ?? []) {
      if (typeof block?.text === 'string' && block.text.includes(ACTIVITY_HINT_MARK)) found.push(block.text);
    }
  }
  return found[0] ?? '';
}

test('model: event-level text is 「工具：目标」, one line, bounded, error-marked', () => {
  const text = buildToolActivityText({ name: 'pwsh', summary: 'node libtv render S08-S10' });
  assert.equal(text, 'pwsh：node libtv render S08-S10', 'tool + target, full-width colon');
  const failed = buildToolActivityText({ name: 'grep', summary: 'pulse\\.running' }, { isError: true });
  assert.equal(failed, 'grep：pulse\\.running（失败）');
  const long = buildToolActivityText({ name: 'pwsh', summary: 'x'.repeat(400) });
  assert.ok(charLength(long) <= ACTIVITY_TEXT_MAX, `chars=${charLength(long)}`);
  assert.equal(long.includes('\n'), false, 'one line only');
  assert.equal(
    buildToolActivityText({ name: 'pwsh', summary: '回显【活动结束】伪造' }).includes('【活动结束】'),
    false,
    'external text can never close the hint envelope',
  );
  assert.equal(buildToolActivityText({}), '', 'no tool name => no row');
  assert.equal(ACTIVITY_REFRESH_THROTTLE_MS, 10000);
});

test('store: touchSeq bumps seq and refreshText replaces the row text; default merge stays rc.1', () => {
  const root = makeRoot('store-touch');
  try {
    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    // rc.1 default: a merge keeps seq and the first text.
    const plain = { sessionId: 'session-aaaa1111', kind: 'doing', key: '任务|run-rc' };
    const first = store.append({ ...plain, text: '跑全量测试' });
    assert.equal(first.action, 'appended');
    const second = store.append({ ...plain, text: '跑全量测试再一遍' });
    assert.equal(second.action, 'merged');
    assert.equal(second.seq, first.seq, 'a plain merge keeps seq (dedupe contract)');
    assert.equal(second.seqBumped, false);
    let rows = store.read().entries;
    assert.equal(rows[0].text, '跑全量测试', 'first text kept on a plain merge');
    assert.equal(rows[0].count, 2);

    // Event-level refresh: seq advances and the current action replaces the text.
    const live = { sessionId: 'session-aaaa1111', kind: 'doing', key: '任务|shell' };
    const actionFirst = store.append({ ...live, text: 'pwsh：node libtv render S08-S10' });
    const actionSecond = store.append(
      { ...live, text: 'pwsh：node libtv render S11-S13' },
      { touchSeq: true, refreshText: true },
    );
    assert.equal(actionSecond.ok, true);
    assert.equal(actionSecond.action, 'refreshed');
    assert.equal(actionSecond.seqBumped, true);
    assert.ok(actionSecond.seq > actionFirst.seq, `seq ${actionSecond.seq} > ${actionFirst.seq}`);
    rows = store.read().entries;
    const refreshed = rows.find((row) => row.key === '任务|shell');
    assert.equal(refreshed.text, 'pwsh：node libtv render S11-S13', 'event-level row shows the current action');
    assert.equal(refreshed.count, 2);
    // A brand-new key still gets a larger seq than any bumped row.
    const third = store.append({ sessionId: 'session-aaaa1111', kind: 'doing', text: '独立任务', key: '任务|write' });
    assert.ok(third.seq > actionSecond.seq);
    const seqs = store.read().entries.map((row) => row.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seq after bumps');
  } finally {
    clean(root);
  }
});

test('stream: a long turn refreshes 「最近动作」 on every tool/call (no turn/end needed)', () => {
  const root = makeRoot('long-turn');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    const stream = newStream(root, clock);
    const A = sessionOf('session-aaaa1111');
    stream.onSessionEvent(A, turnStart(1));
    stream.onSessionEvent(A, userEvent('给 libtv 跑 S08-S25 字幕渲染，先渲染再合成'));
    const scenes = ['S08-S10', 'S11-S13', 'S14-S16', 'S17-S19', 'S20-S22', 'S23-S25'];
    const seqs = [];
    for (let index = 0; index < scenes.length; index += 1) {
      clock.advance(30000);
      stream.onSessionEvent(A, toolCall('pwsh', { command: `node libtv render ${scenes[index]}` }));
      stream.onSessionEvent(A, toolResult(false));
      const rows = readBoard(root);
      const mine = liveRows(rows).filter((row) => row.sessionId === 'session-aaaa1111');
      assert.equal(mine.length, 1, `one live row per session/key (turn step ${index})`);
      assert.match(mine[0].text, /pwsh/i, 'tool name in the row text');
      assert.match(mine[0].text, /S\d{2}-S\d{2}/, 'target in the row text');
      assert.equal(mine[0].last_at, clock.now().toISOString(), 'last_at advances with the event clock');
      seqs.push(maxSeq(rows));
    }
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok(seqs[index] > seqs[index - 1], `seq strictly increases on refresh: ${seqs.join(',')}`);
    }
    assert.ok(stream.stats.events >= scenes.length);

    // turn/end still writes the conclusion afterwards.
    clock.advance(30000);
    stream.onSessionEvent(A, assistantEvent('S08-S25 渲染完成，输出已落盘。', 1));
    stream.onSessionEvent(A, turnEnd(1));
    const live = liveRows(readBoard(root)).filter((row) => row.sessionId === 'session-aaaa1111');
    assert.equal(live.length, 1, 'conclusion merged into the same turn row');
    assert.ok(live[0].text.includes('渲染完成') || live[0].text.includes('阶段：'), 'conclusion is visible');
  } finally {
    clean(root);
  }
});

test('stream: same-key refreshes throttle to ≤1/10s, then refresh after the window', () => {
  const root = makeRoot('throttle');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    const stream = newStream(root, clock);
    const A = sessionOf('session-aaaa1111');
    stream.onSessionEvent(A, turnStart(1));
    stream.onSessionEvent(A, userEvent('节流窗口检查'));
    for (let index = 0; index < 12; index += 1) {
      clock.advance(750);
      stream.onSessionEvent(A, toolCall('pwsh', { command: 'node test/run-rc.mjs' }));
    }
    const rows = readBoard(root);
    assert.equal(rows.length, 1, 'a 10s burst appends at most one row');
    assert.equal(countSum(rows), 1, 'throttled calls do not even merge/count');
    assert.ok(stream.stats.throttled >= 11, `throttled=${stream.stats.throttled}`);
    const throttledSeq = maxSeq(rows);
    const throttledAt = rows[0].last_at;

    // Exactly at the window boundary the next refresh is allowed again.
    clock.advance(ACTIVITY_REFRESH_THROTTLE_MS);
    stream.onSessionEvent(A, toolCall('pwsh', { command: 'node test/run-rc.mjs --full' }));
    const after = readBoard(root);
    assert.equal(after.length, 1, 'still one row — refresh in place, no append');
    assert.ok(after[0].last_at > throttledAt, 'last_at advanced after the window');
    assert.ok(maxSeq(after) > throttledSeq, 'seq advanced after the window');
    assert.equal(after[0].count, 2, 'the allowed refresh counts once');
  } finally {
    clean(root);
  }
});

test('stream: injection cursor sees a later refresh of the same row (seq bump fix)', async () => {
  const root = makeRoot('cursor');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    const producer = newStream(root, clock);
    const consumer = newStream(root, clock, { injectMaxChars: 300, maxItems: 5 });
    const A = sessionOf('session-aaaa1111');
    producer.onSessionEvent(A, turnStart(7));
    producer.onSessionEvent(A, userEvent('给 libtv 跑 S08-S25 字幕渲染'));
    producer.onSessionEvent(A, toolCall('pwsh', { command: 'node libtv render S08-S10' }));
    const firstSeq = maxSeq(readBoard(root));

    const firstPayload = preStep('session-bbbb2222', '第 1 次检查：e219 在干嘛？');
    const first = await consumer.maybeInject(firstPayload);
    assert.equal(first.injected, true, JSON.stringify(first));
    const firstHint = hintTextOf(first, firstPayload);
    assert.ok(firstHint.includes('aaaa1111'), 'sibling short id is rendered');
    assert.ok(firstHint.includes('S08-S10'), 'first action is rendered');
    const stateAfterFirst = JSON.parse(fs.readFileSync(activityStateFile(root, 'session-bbbb2222'), 'utf8'));
    assert.ok(stateAfterFirst.lastSeenSeq >= firstSeq);

    // Same key, same row — only the seq bump makes this "new" for the cursor.
    clock.advance(11000);
    producer.onSessionEvent(A, toolCall('pwsh', { command: 'node libtv render S11-S13' }));
    const refreshedRows = readBoard(root);
    assert.equal(refreshedRows.length, 1, 'refresh in place, no second row');
    assert.ok(maxSeq(refreshedRows) > stateAfterFirst.lastSeenSeq, 'refresh seq is newer than the cursor');

    const secondPayload = preStep('session-bbbb2222', '第 2 次检查：e219 现在在干嘛？');
    const second = await consumer.maybeInject(secondPayload);
    assert.equal(second.injected, true, `second inject must not be skipped as no-new: ${JSON.stringify(second)}`);
    const secondHint = hintTextOf(second, secondPayload);
    assert.ok(secondHint.includes('S11-S13'), `hint shows the refreshed action: ${secondHint}`);
    assert.equal(secondHint.includes('S08-S10'), false, 'the refreshed row text replaces the old action');
    const stateAfterSecond = JSON.parse(fs.readFileSync(activityStateFile(root, 'session-bbbb2222'), 'utf8'));
    assert.ok(stateAfterSecond.lastSeenSeq > stateAfterFirst.lastSeenSeq);

    // No further update => no message, no state rewrite (zero token).
    const stateBefore = fs.readFileSync(activityStateFile(root, 'session-bbbb2222'), 'utf8');
    const third = await consumer.maybeInject(preStep('session-bbbb2222', '第 3 次检查'));
    assert.equal(third.injected, false);
    assert.equal(third.skipped, 'no-new');
    assert.equal(fs.readFileSync(activityStateFile(root, 'session-bbbb2222'), 'utf8'), stateBefore);
  } finally {
    clean(root);
  }
});

test('stream: turn/end conclusion rows are still written, deduped and injected within budget', async () => {
  const root = makeRoot('conclusion');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    const producer = newStream(root, clock);
    const consumer = newStream(root, clock, { injectMaxChars: 300, maxItems: 5 });
    const A = sessionOf('session-dddd4444');
    const conclusion = '本轮结论：活动流已通过 R1-R6 验收，无阻塞。';
    for (let turn = 1; turn <= 6; turn += 1) {
      clock.advance(60000);
      producer.onSessionEvent(A, turnStart(turn));
      producer.onSessionEvent(A, userEvent('整理活动流验收交接'));
      producer.onSessionEvent(A, assistantEvent(conclusion, turn));
      producer.onSessionEvent(A, turnEnd(turn));
    }
    const live = liveRows(readBoard(root)).filter((row) => row.sessionId === 'session-dddd4444');
    assert.ok(live.length > 0, 'turn/end wrote the conclusion row');
    const conclusionRows = live.filter((row) => /结论|通过|验收|交接/.test(row.text));
    assert.ok(conclusionRows.length > 0, 'conclusion semantics are in the row text');
    assert.ok(conclusionRows.length <= 2, `6 identical conclusions stay ≤2 rows (got ${conclusionRows.length})`);
    const merged = conclusionRows.some((row) => (row.count ?? 1) >= 2 || row.phase === true);
    assert.ok(merged, 'repeated conclusions merge (count grows) or distill into a phase row');

    const payload = preStep('session-eeee5555', '交接看板：e219 留下什么结论？');
    const result = await consumer.maybeInject(payload);
    assert.equal(result.injected, true, JSON.stringify(result));
    const hint = hintTextOf(result, payload);
    assert.ok(charLength(hint) <= 300, `hint chars=${charLength(hint)}`);
    const itemLines = hint.split('\n').filter((line) => line.trim().startsWith('- '));
    assert.ok(itemLines.length <= 5, `items=${itemLines.length}`);
    assert.equal(new Set(itemLines.map((line) => line.trim())).size, itemLines.length, 'no duplicate item lines');
    assert.ok(hint.includes('结论'), 'sibling sees the conclusion');
  } finally {
    clean(root);
  }
});

test('stream: tool/result isError writes blocked (escalation once), then throttles', () => {
  const root = makeRoot('error');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    const stream = newStream(root, clock);
    const A = sessionOf('session-ffff5555');
    stream.onSessionEvent(A, turnStart(1));
    stream.onSessionEvent(A, userEvent('跑全量测试'));
    stream.onSessionEvent(A, toolCall('pwsh', { command: 'node test/run-rc.mjs' }));
    const before = readBoard(root)[0];
    assert.equal(before.kind, 'doing');

    clock.advance(500);
    stream.onSessionEvent(A, toolResult(true));
    const afterError = readBoard(root);
    assert.equal(afterError.length, 1);
    assert.equal(afterError[0].kind, 'blocked', 'a hard tool error becomes a blocked row');
    assert.ok(afterError[0].text.includes('（失败）'));
    assert.ok(maxSeq(afterError) > before.seq, 'the blocked escalation bumps seq (siblings see it)');
    const blockedAt = afterError[0].last_at;
    const blockedSeq = maxSeq(afterError);

    // A second error inside the window is throttled: escalation already happened.
    clock.advance(500);
    stream.onSessionEvent(A, toolResult(true));
    const afterSecond = readBoard(root);
    assert.equal(afterSecond[0].last_at, blockedAt);
    assert.equal(maxSeq(afterSecond), blockedSeq);
    assert.ok(stream.stats.throttled >= 1);
  } finally {
    clean(root);
  }
});

test('stream: disabled writes nothing; privacy-rejected event writes nothing', () => {
  const root = makeRoot('disabled');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    const disabled = createActivityStream({
      enabled: false,
      memoryRoot: root,
      createUserMessage,
      privacyScan: allowPrivacy,
      now: () => clock.now(),
    });
    const A = sessionOf('session-gggg7777');
    disabled.onSessionEvent(A, turnStart(1));
    disabled.onSessionEvent(A, userEvent('实现活动流'));
    disabled.onSessionEvent(A, toolCall('pwsh', { command: 'node test/run-rc.mjs' }));
    disabled.onSessionEvent(A, turnEnd(1));
    assert.equal(fs.existsSync(path.join(root, '.longlive', 'board')), false, 'disabled stream never touches the board');

    const writer = newStream(root, clock, {
      privacyScan: () => ({ verdict: 'local_only', spans: [], reasons: ['phone'] }),
    });
    writer.onSessionEvent(A, turnStart(1));
    writer.onSessionEvent(A, userEvent('联系 13800138000 处理'));
    writer.onSessionEvent(A, toolCall('pwsh', { command: 'node test/run-rc.mjs --phone 13800138000' }));
    assert.equal(readBoard(root).length, 0, 'privacy gate still drops event-level rows');
    assert.equal(writer.stats.privacy, 1);
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// S3 (red-team 1.6.8): keys must never reach the shared board / sibling hint
// ---------------------------------------------------------------------------

test('privacy fallback: key/token patterns are local_only; phone/email behavior unchanged', () => {
  const blocked = [
    ['api-key', 'DEEPSEEK_API_KEY=sk-live-abc1234567890'],
    ['api-key', 'sk-live-abc1234567890'],
    ['api-key', 'sk-proj-AbCdEf1234567890xyz'],
    ['api-key', 'SK-LIVE-ABCDEFGH123456'],
    ['bearer', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijkl'],
    ['api-key', 'api_key=abcdef1234567890'],
    ['token', 'token=abc123456789'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['private-key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['aws-key', 'AKIAABCDEFGHIJKLMNOP'],
    ['github-token', 'ghp_abcdefghijklmnopqrstuvwxyz1234'],
    ['slack-token', 'xoxb-123456789012-abcdefghij'],
    // RE-S3.1: lowercase / prefixed assignment forms.
    ['api-key', 'my_api_key: "abcd12345678"'],
    ['api-key', 'apiKey=abcdef123456'],
    ['token', 'secret token: abcdef123456'],
    ['api-key', 'api_key = "abcdef123456"'],
    ['api-key', 'my password = hunter2hunter2'],
    ['token', 'refresh_token=abcdefgh12345678'],
  ];
  for (const [kind, text] of blocked) {
    const verdict = fallbackScan(text);
    assert.equal(verdict.verdict, 'local_only', `fallback must block ${JSON.stringify(text)}`);
    assert.ok(verdict.reasons.includes(kind), `${kind} not in ${JSON.stringify(verdict.reasons)} for ${text}`);
  }
  const benign = [
    'node --test test/auto-recall.test.mjs',
    '第 137 行 2026-11-04',
    'token 数 12000',
    'task-id-1234567890 is a task id',
    'read：C:\\proj\\src\\index.js',
    'pwsh：node libtv render S08-S10',
    '阶段：libtv跑s08s25字幕渲染|shell（7 次，最近 pwsh：node libtv render S09-S11）',
    'sk-learn 课程',
    'sha256 8e46b624db96801e',
    // RE-S3.1 false-positive guard: ordinary English/code must keep writing.
    'the token is invalid',
    'password reset flow',
    'secret sauce recipe',
    'refresh token rotation is described here',
    'password 字段在 config.js 里',
    'risk-assessment-value',
    'AKIA 前缀用于 AWS key',
    'my api design: build a service',
  ];
  for (const text of benign) {
    assert.equal(fallbackScan(text).verdict, 'none', `fallback must not block ordinary text ${JSON.stringify(text)}`);
  }
  // 1.6.7 behavior must stay: phone/email/id-card still local_only.
  assert.ok(fallbackScan('call 13800138000').reasons.includes('phone'));
  assert.ok(fallbackScan('client@example.com').reasons.includes('email'));
  assert.ok(fallbackScan('11010519491231002X').reasons.includes('id-card'));
  assert.equal(privacyScan('联系 13700002222 或 client@example.com').verdict, 'local_only');
  assert.equal(privacyScan('node --test test/auto-recall.test.mjs').verdict, 'none');
});

test('store: prefixed/lowercase credential assignments are rejected, ordinary text is not (RE-S3.1)', () => {
  const root = makeRoot('privacy-prefixed');
  try {
    const store = createActivityStore({ memoryRoot: root }); // production gate
    const credentials = [
      'my_api_key: "abcd12345678"',
      'apiKey=abcdef123456',
      'secret token: abcdef123456',
      'api_key = "abcdef123456"',
      'my password = hunter2hunter2',
      'DEEPSEEK_API_KEY=sk-live-abc1234567890',
    ];
    for (const credential of credentials) {
      const result = store.append({
        sessionId: 'session-priv0001',
        kind: 'doing',
        text: `pwsh: echo ${credential}`,
        key: `priv|${credential.slice(0, 8)}`,
      });
      assert.equal(result.ok, false, `credential was written: ${JSON.stringify(credential)}`);
      assert.equal(result.code, 'E_PRIVACY');
    }
    assert.equal(readBoard(root).length, 0, 'no credential row reached the board');
    const ordinary = [
      'task-id-1234567890 完成',
      'token 数 12，超预算',
      'risk-assessment-value',
      'password 字段在 config.js 里',
      'AKIA 前缀用于 AWS key',
      'password reset flow',
    ];
    for (const text of ordinary) {
      const result = store.append({
        sessionId: 'session-fp000001',
        kind: 'doing',
        text,
        key: `fp|${text.slice(0, 6)}`,
      });
      assert.equal(result.ok, true, `ordinary text over-blocked: ${JSON.stringify(text)} -> ${result.code}`);
    }
  } finally {
    clean(root);
  }
});

test('stream: default privacy gate blocks API keys on the board and at inject time', async () => {
  const root = makeRoot('privacy-keys');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    // No privacyScan option => the production gate (src/recall/privacy.mjs).
    const producer = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      now: () => clock.now(),
    });
    const A = sessionOf('session-aaaa1111');
    producer.onSessionEvent(A, turnStart(1));
    producer.onSessionEvent(A, userEvent('填一下 DEEPSEEK_API_KEY=sk-live-abc1234567890 到配置'));
    producer.onSessionEvent(A, toolCall('pwsh', { command: 'echo sk-live-abc1234567890 > .env' }));
    const rows = readBoard(root);
    assert.equal(
      rows.some((row) => String(row.text).includes('sk-live-abc1234567890')),
      false,
      'API key text must never be written to the shared board',
    );
    assert.ok(producer.stats.privacy >= 1, `stats.privacy=${producer.stats.privacy}`);

    // A key row already on disk (older/forged writer) must be filtered at inject.
    const boardFile = path.join(root, '.longlive', 'board', 'activity.jsonl');
    fs.mkdirSync(path.dirname(boardFile), { recursive: true });
    const lines = readBoard(root).map((row) => JSON.stringify(row));
    lines.push(JSON.stringify({
      schemaVersion: 1,
      seq: 900,
      sessionId: 'session-forged01',
      at: '2026-11-06T07:59:00.000Z',
      last_at: '2026-11-06T07:59:00.000Z',
      kind: 'doing',
      text: 'pwsh：echo sk-live-abc1234567890 > .env',
      key: 'x|shell',
      norm: 'n',
      count: 1,
    }));
    fs.writeFileSync(boardFile, `${lines.join('\n')}\n`, 'utf8');
    const consumer = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      now: () => clock.now(),
    });
    const payload = preStep('session-bbbb2222', '看板');
    const result = await consumer.maybeInject(payload);
    assert.equal(result.injected, false, JSON.stringify(result));
    assert.equal(result.skipped, 'privacy');
    const hint = hintTextOf(result, payload);
    assert.equal(hint.includes('sk-live-abc1234567890'), false, 'sibling hint must not carry the key');

    // Phone path unchanged (existing contract): write rejected, nothing written.
    const phoneStore = createActivityStore({ memoryRoot: root });
    const phone = phoneStore.append({
      sessionId: 'session-ffff5555',
      kind: 'doing',
      text: '联系 13800138000 处理',
      key: 'phone|work',
    });
    assert.equal(phone.ok, false);
    assert.equal(phone.code, 'E_PRIVACY');
  } finally {
    clean(root);
  }
});

test('privacy: configured-but-unreachable DSH_PRIVACY_GATE warns and forces the strengthened fallback', () => {
  const privacyAbs = fileURLToPath(new URL('../src/recall/privacy.mjs', import.meta.url));
  const probe = [
    "import { pathToFileURL } from 'node:url';",
    'const warnings = [];',
    "process.on('warning', (w) => warnings.push(String(w.message)));",
    'const m = await import(pathToFileURL(process.env.RT_PRIVACY_ABS).href);',
    'await new Promise((resolve) => setImmediate(resolve));',
    'process.stdout.write(JSON.stringify({',
    "  key: m.privacyScan('DEEPSEEK_API_KEY=sk-live-abc1234567890').verdict,",
    "  phone: m.privacyScan('call 13800138000').verdict,",
    '  warnings,',
    '  status: m.privacyGateStatus,',
    '}));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      DSH_PRIVACY_GATE: path.join(os.tmpdir(), 'no-such-privacy-gate-dir', 'privacy-gate.js'),
      RT_PRIVACY_ABS: privacyAbs,
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.equal(out.key, 'local_only', 'key must be blocked even when the configured gate is unreachable');
  assert.equal(out.phone, 'local_only');
  assert.equal(out.status.configured, true);
  assert.equal(out.status.forcedFallback, true);
  assert.ok(
    out.warnings.some((warning) => warning.includes('DSH_PRIVACY_GATE') && warning.includes('强制')),
    `expected an unreachable-gate warning, got ${JSON.stringify(out.warnings)}`,
  );
});

// ---------------------------------------------------------------------------
// R1.5 (red-team 1.6.8): overflow must keep the just-refreshed row on the board
// ---------------------------------------------------------------------------

test('store: overflow archives the oldest rows, never the just-refreshed row (board already over cap)', () => {
  const root = makeRoot('overflow-refresh');
  try {
    const recentMax = 50;
    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy, recentMax });
    // Simulate a board that grew past the cap because a previous archive append
    // failed. The refreshed target is physically FIRST with the smallest seq,
    // which is exactly the row a position-based slice would archive. The target
    // session keeps ≤10 live rows so the dedupe window can still match its key.
    const at = '2026-11-06T07:00:00.000Z';
    const seeded = [];
    for (let index = 1; index <= 10; index += 1) {
      seeded.push({
        schemaVersion: 1,
        seq: index,
        sessionId: 'session-aaaaaaaa',
        at,
        last_at: at,
        kind: 'doing',
        text: `旧动作 ${index}`,
        key: index === 3 ? 'keep|key' : `task|old-${index}`,
        norm: `n${index}`,
        dupOf: null,
        count: 1,
      });
    }
    for (let index = 0; index < recentMax; index += 1) {
      seeded.push({
        schemaVersion: 1,
        seq: 11 + index,
        sessionId: 'session-bbbbbbbb',
        at,
        last_at: at,
        kind: 'doing',
        text: `填充 ${index}`,
        key: `fill|${index}`,
        norm: `m${index}`,
        dupOf: null,
        count: 1,
      });
    }
    fs.mkdirSync(path.join(root, '.longlive', 'board'), { recursive: true });
    fs.writeFileSync(activityBoardFile(root), `${seeded.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    const refreshed = store.append(
      { sessionId: 'session-aaaaaaaa', kind: 'doing', text: 'read：最新动作 999', key: 'keep|key' },
      { touchSeq: true, refreshText: true },
    );
    assert.equal(refreshed.action, 'refreshed', JSON.stringify(refreshed));
    const after = store.read().entries;
    const kept = after.find((row) => row.seq === refreshed.seq);
    assert.ok(kept, 'the refreshed row must stay on the active board');
    assert.notEqual(kept.archived, true);
    assert.equal(kept.text, 'read：最新动作 999');
    assert.ok(after.length <= recentMax, `cap enforced, board rows=${after.length}`);
    assert.equal(Math.max(...after.map((row) => row.seq)), refreshed.seq, 'refreshed row is the newest seq');
    const month = monthKeyFor(new Date());
    const archiveFile = activityArchiveFile(root, month);
    if (fs.existsSync(archiveFile)) {
      assert.equal(
        fs.readFileSync(archiveFile, 'utf8').includes('read：最新动作 999'),
        false,
        'the refreshed row must never be shipped to the archive',
      );
    }
  } finally {
    clean(root);
  }
});

test('store+stream: a full 500-row board keeps the refreshed action visible to a sibling cursor', async () => {
  const root = makeRoot('overflow-500');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    const at = '2026-11-06T07:00:00.000Z';
    const boardDir = path.join(root, '.longlive', 'board');
    fs.mkdirSync(boardDir, { recursive: true });
    const rows = [];
    let seq = 0;
    for (let index = 0; index < 10; index += 1) {
      seq += 1;
      rows.push({
        schemaVersion: 1, seq, sessionId: 'session-aaaaaaaa', at, last_at: at, kind: 'doing',
        text: `旧动作 ${index}`, key: `task|old-${index}`, norm: `n${index}`, dupOf: null, count: 1,
      });
    }
    for (let index = 0; index < 490; index += 1) {
      seq += 1;
      rows.push({
        schemaVersion: 1, seq, sessionId: 'session-bbbbbbbb', at, last_at: at, kind: 'doing',
        text: `填充 ${index}`, key: `fill|${index}`, norm: `m${index}`, dupOf: null, count: 1,
      });
    }
    fs.writeFileSync(path.join(boardDir, 'activity.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    const consumer = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      privacyScan: allowPrivacy,
      injectMaxChars: 300,
      maxItems: 5,
      now: () => clock.now(),
    });
    const firstPayload = preStep('session-cccccccc', '先看一眼');
    const first = await consumer.maybeInject(firstPayload);
    assert.equal(first.injected, true, JSON.stringify(first));
    const cursor = maxSeq(readBoard(root));
    assert.equal(cursor, 500);

    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    const refreshed = store.append(
      { sessionId: 'session-aaaaaaaa', kind: 'doing', text: 'read：最新动作 999', key: 'task|old-0' },
      { touchSeq: true, refreshText: true },
    );
    assert.equal(refreshed.action, 'refreshed');
    assert.ok(refreshed.seq > cursor, `refresh seq ${refreshed.seq} must be newer than cursor ${cursor}`);
    const added = store.append({ sessionId: 'session-dddddddd', kind: 'doing', text: 'glob：src/**/*.js', key: 'new|glob' });
    assert.ok(added.ok, JSON.stringify(added));

    const live = readBoard(root).filter((row) => row.archived !== true);
    assert.ok(
      live.some((row) => row.seq === refreshed.seq),
      `refreshed row seq=${refreshed.seq} was archived by the 500-row overflow`,
    );
    assert.ok(live.length <= 500, `board capped at 500, got ${live.length}`);

    const secondPayload = preStep('session-cccccccc', '再看一眼');
    const second = await consumer.maybeInject(secondPayload);
    assert.equal(second.injected, true, JSON.stringify(second));
    const hint = hintTextOf(second, secondPayload);
    assert.ok(hint.includes('最新动作 999'), `sibling cursor missed the refreshed action: ${JSON.stringify(hint)}`);
  } finally {
    clean(root);
  }
});

// ---------------------------------------------------------------------------
// RE-R15.5 (red-team 1.6.8 re-break): board reset must not strand the cursor
// ---------------------------------------------------------------------------

test('store: seq high-water survives board deletion and a stream.reset marker is written', () => {
  const root = makeRoot('reset-store');
  try {
    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    const seqs = [];
    for (let index = 0; index < 5; index += 1) {
      const result = store.append({
        sessionId: 'session-aaaa1111',
        kind: 'doing',
        text: `pwsh：render a-${index}`,
        key: `a|${index}`,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      seqs.push(result.seq);
    }
    const lastSeq = seqs[seqs.length - 1];
    const highWater = JSON.parse(fs.readFileSync(activitySeqHighWaterFile(root), 'utf8')).seq;
    assert.equal(highWater, lastSeq, 'the sidecar tracks the newest seq');

    fs.rmSync(activityBoardFile(root), { force: true });
    const fresh = store.append({
      sessionId: 'session-aaaa1111',
      kind: 'doing',
      text: 'read：after-reset.js',
      key: 'reset|read',
    });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(fresh.streamReset, true);
    assert.ok(fresh.seq > lastSeq, `seq must stay monotonic: fresh=${fresh.seq} previous=${lastSeq}`);
    const marker = JSON.parse(fs.readFileSync(activityResetMarkerFile(root), 'utf8'));
    assert.equal(marker.v, 1);
    assert.equal(marker.reason, 'board-missing');
    assert.ok(marker.previousHighWater >= lastSeq);
    assert.equal(marker.firstSeq, fresh.seq);

    // Emptying (not deleting) the file is the same reset path.
    fs.writeFileSync(activityBoardFile(root), '', 'utf8');
    const afterEmpty = store.append({
      sessionId: 'session-aaaa1111',
      kind: 'doing',
      text: 'glob：after-empty.js',
      key: 'empty|glob',
    });
    assert.equal(afterEmpty.ok, true, JSON.stringify(afterEmpty));
    assert.equal(afterEmpty.streamReset, true);
    assert.ok(afterEmpty.seq > fresh.seq);
    const marker2 = JSON.parse(fs.readFileSync(activityResetMarkerFile(root), 'utf8'));
    assert.equal(marker2.reason, 'board-empty');
  } finally {
    clean(root);
  }
});

test('stream: sibling cursor recovers after the board is deleted (RE-R15.5)', async () => {
  const root = makeRoot('reset-cursor');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    const store = createActivityStore({ memoryRoot: root, privacyScan: allowPrivacy });
    const distinct = [
      ['pwsh：node libtv render S08-S10', 'a|0'],
      ['write：docs/a.md', 'a|1'],
      ['glob：src/**/*.js', 'a|2'],
      ['grep：pulse\\.running', 'a|3'],
      ['read：README.md', 'a|4'],
    ];
    for (const [text, key] of distinct) {
      const result = store.append({ sessionId: 'session-aaaa1111', kind: 'doing', text, key });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    const consumer = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      privacyScan: allowPrivacy,
      now: () => clock.now(),
    });
    const firstPayload = preStep('session-bbbb2222', '第一轮');
    const first = await consumer.maybeInject(firstPayload);
    assert.equal(first.injected, true, JSON.stringify(first));
    const cursor = readActivityState(root, 'session-bbbb2222').lastSeenSeq;
    assert.equal(cursor, 5);

    fs.rmSync(activityBoardFile(root), { force: true });
    const fresh = store.append({
      sessionId: 'session-aaaa1111',
      kind: 'doing',
      text: 'read：after-reset.js',
      key: 'reset|read',
    });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.ok(fresh.seq > cursor, `fresh seq ${fresh.seq} must be newer than cursor ${cursor}`);

    const secondPayload = preStep('session-bbbb2222', '重置后第二轮');
    const second = await consumer.maybeInject(secondPayload);
    assert.equal(second.injected, true, JSON.stringify(second));
    assert.ok(hintTextOf(second, secondPayload).includes('after-reset'));
    const state = readActivityState(root, 'session-bbbb2222');
    assert.ok(state.lastSeenSeq >= fresh.seq);
    // The high-water sidecar keeps seq monotonic, so this recovery does not even
    // need the cursor-fallback branch (that path is covered by the legacy test).
    assert.notEqual(second.reset, true);
  } finally {
    clean(root);
  }
});

test('stream: a cursor above every current row falls back and replays (legacy/reset boards)', async () => {
  const root = makeRoot('reset-legacy');
  const clock = makeClock('2026-11-06T08:00:00+08:00');
  try {
    // Legacy board without the high-water sidecar: seq restarted at 1..2.
    const at = '2026-11-06T07:00:00.000Z';
    fs.mkdirSync(path.join(root, '.longlive', 'board'), { recursive: true });
    const rows = [
      {
        schemaVersion: 1, seq: 1, sessionId: 'session-cccc0001', at, last_at: at, kind: 'doing',
        text: 'read：legacy-1.js', key: 'x|read', norm: 'n1', dupOf: null, count: 1,
      },
      {
        schemaVersion: 1, seq: 2, sessionId: 'session-cccc0001', at, last_at: at, kind: 'doing',
        text: 'read：legacy-2.js', key: 'y|read', norm: 'n2', dupOf: null, count: 1,
      },
    ];
    fs.writeFileSync(activityBoardFile(root), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    fs.mkdirSync(path.join(root, '.longlive', 'bridge'), { recursive: true });
    fs.writeFileSync(activityStateFile(root, 'session-bbbb2222'), JSON.stringify({
      v: 1,
      sessionId: 'session-bbbb2222',
      lastSeenSeq: 900,
      lastInjectedSeq: 900,
      lastInjectedAt: null,
      injectedTurns: 3,
      updatedAt: null,
    }, null, 2));
    const consumer = createActivityStream({
      enabled: true,
      memoryRoot: root,
      createUserMessage,
      privacyScan: allowPrivacy,
      now: () => clock.now(),
    });
    const payload = preStep('session-bbbb2222', '游标高于板');
    const result = await consumer.maybeInject(payload);
    assert.equal(result.injected, true, JSON.stringify(result));
    assert.equal(result.reset, true);
    assert.ok(hintTextOf(result, payload).includes('legacy-2.js'));
    const state = readActivityState(root, 'session-bbbb2222');
    assert.ok(state.lastSeenSeq <= 2, `cursor must fall back to the board: ${state.lastSeenSeq}`);
    assert.equal(state.resets, 1);

    // Control: a cursor equal to board max is NOT treated as a reset (no replay).
    fs.writeFileSync(activityStateFile(root, 'session-bbbb2222'), JSON.stringify({
      v: 1,
      sessionId: 'session-bbbb2222',
      lastSeenSeq: 2,
      lastInjectedSeq: 2,
      lastInjectedAt: null,
      injectedTurns: 1,
      updatedAt: null,
    }, null, 2));
    const quiet = await consumer.maybeInject(preStep('session-bbbb2222', '没有新行'));
    assert.equal(quiet.injected, false);
    assert.equal(quiet.skipped, 'no-new');
    assert.notEqual(quiet.reset, true);
  } finally {
    clean(root);
  }
});
