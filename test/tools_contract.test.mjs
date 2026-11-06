// Registration contracts for all 22 tools.
//
// A test that only checks `TOOLS.length === 20` cannot see a rename, cannot see
// one tool's invoke replaced by another tool's implementation, and cannot see
// goal truncation regress from code points to UTF-16 units. This suite pins:
//   - the exact ordered list of names,
//   - one successful invoke per tool plus its error branch,
//   - the astral-plane goal string (80 emoji stay 80 emoji),
//   - an explicit coverage assertion (C21) proving both branches really ran.
//
// Every call goes through the exported `invoke`, i.e. the same entry the host
// calls after defineTool, so swapping one implementation in the TOOLS table is
// a visible failure rather than a silently passing smoke test.

import fs from 'node:fs';
import path from 'node:path';

import { TOOLS } from '../src/tools.js';
import { encodeSession } from '../src/codec.js';

export const CONTRACT_NAMES = [
  'session_health',
  'session_original',
  'session_backup',
  'session_truncate',
  'session_truncate_visible',
  'session_compact',
  'session_wake',
  'lease_acquire',
  'lease_release',
  'worker_spawn',
  'worker_status',
  'worker_kill',
  'memory_index',
  'memory_consolidate',
  'memory_reinforce',
  'memory_forget',
  'memory_procedure',
  'memory_recall',
  'session_live_update',
  'session_live_list',
  'session_live_get',
  'session_live_prune',
];

function toolNamed(name) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool;
}

// C21 is not a vibe check: every invoke is counted here, by result shape.
// A throw, `ok:false`, or an explicit unavailable/error status is an error
// path; anything else is a success path. C1 alone cannot prove either ran.
let coverage = null;

function resetCoverage() {
  coverage = new Map(CONTRACT_NAMES.map((name) => [name, { calls: 0, ok: 0, error: 0 }]));
}

function noteCoverage(name, kind) {
  if (!coverage) return;
  const slot = coverage.get(name);
  if (!slot) return;
  slot.calls += 1;
  slot[kind] += 1;
}

function isErrorValue(value) {
  return Boolean(value) && typeof value === 'object'
    && (value.ok === false || value.status === 'unavailable' || value.status === 'error');
}

async function call(name, args, config) {
  try {
    const value = await toolNamed(name).invoke(args, config);
    noteCoverage(name, isErrorValue(value) ? 'error' : 'ok');
    return { ok: true, value, tool: name };
  } catch (error) {
    noteCoverage(name, 'error');
    return { ok: false, error, tool: name };
  }
}

function assertOk(assert, result, label) {
  assert(result.ok === true, `${label}: expected success, got ${result.ok ? '???' : result.error?.message}`);
  return result.value;
}

function assertError(assert, result, code, label) {
  assert(result.ok === false, `${label}: expected an error, got a successful call`);
  assert(
    result.error?.code === code,
    `${label}: expected ${code}, got ${result.error?.code ?? '(no code)'}: ${result.error?.message}`,
  );
  return result.error;
}

function freshRoot(TMP, id) {
  const root = path.join(TMP, 'contract', id);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** One real v4 log under <root>/sessions/<scope>/<id>/, enough for a dry run. */
function sessionFile(root, events = 40) {
  const dir = path.join(root, 'sessions', 'scope-contract', 'contract-session');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const header = {
    type: 'session',
    version: 4,
    id: 'contract-session',
    createdAt: Date.now(),
    cwd: root,
    isSeeded: false,
    delegationDepth: 0,
  };
  const list = Array.from({ length: events }, (_, index) => ({
    seq: index,
    type: index % 2 === 0 ? 'turn/start' : 'session/title',
    data: index % 2 === 0 ? { turn: index + 1 } : { title: `contract ${index}` },
  }));
  fs.writeFileSync(file, encodeSession(header, list));
  // Destructive tools refuse a log written in the last minute (a live session
  // may still be appending); make this fixture look quiescent.
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  return file;
}

/** A v4 log with a protected system head and real user turns, for visible cuts. */
function visibleSessionFile(root) {
  const dir = path.join(root, 'sessions', 'scope-contract', 'visible-session');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const header = {
    type: 'session',
    version: 4,
    id: 'visible-session',
    createdAt: Date.now(),
    cwd: root,
    isSeeded: false,
    delegationDepth: 0,
  };
  const events = [];
  const push = (event) => {
    event.seq = events.length;
    event.time = Date.now() - 3600_000 + events.length;
    events.push(event);
  };
  push({
    type: 'system/message',
    surfaceOp: 'append',
    data: { message: { role: 'system', id: 'system-1', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'contract system' }] } },
  });
  for (let turn = 1; turn <= 8; turn += 1) {
    push({ type: 'turn/start', data: { turn } });
    push({ type: 'step/start', data: { turn, step: 1 } });
    push({
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        turn, step: 1, role: 'user', id: `user-${turn}`,
        content: [{ type: 'text', text: `contract question ${turn}` }],
        source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      },
    });
    push({
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn, step: 1, stream: [],
        message: {
          role: 'assistant', id: `assistant-${turn}`,
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          content: [{ type: 'text', text: `contract answer ${turn}` }],
        },
      },
    });
    push({ type: 'step/end', data: { turn, step: 1 } });
    push({ type: 'turn/end', data: { turn } });
  }
  fs.writeFileSync(file, encodeSession(header, events));
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  return file;
}

/**
 * A v4 log with one tool result (for session_original) and one turn whose
 * message contains a phone number (for the privacy branch).
 */
function originalSessionFile(root) {
  const dir = path.join(root, 'sessions', 'scope-contract', 'original-session');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const header = {
    type: 'session',
    version: 4,
    id: 'original-session',
    createdAt: Date.now(),
    cwd: root,
    isSeeded: false,
    delegationDepth: 0,
  };
  const events = [];
  const push = (event) => {
    event.seq = events.length;
    event.time = Date.now() - 3600_000 + events.length;
    events.push(event);
  };
  push({ type: 'turn/start', data: { turn: 1 } });
  push({
    type: 'user/message',
    data: { role: 'user', id: 'original-user-1', content: [{ type: 'text', text: 'contract original question' }], source: { kind: 'user' } },
  });
  push({
    type: 'assistant/message',
    data: {
      turn: 1, step: 1, stream: [],
      message: { role: 'assistant', content: [{ type: 'text', text: 'contract original answer' }] },
    },
  });
  push({
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-original', name: 'demo_original', arguments: '{}' },
  });
  push({
    type: 'tool/result',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'call-original' },
        toolCallId: 'call-original',
        content: [{ type: 'text', text: 'contract original tool output' }],
        isError: false,
        id: 'result-original',
      },
      meta: {},
    },
  });
  push({ type: 'turn/start', data: { turn: 2 } });
  push({
    type: 'user/message',
    data: { role: 'user', id: 'original-user-2', content: [{ type: 'text', text: 'call me 13800138000' }], source: { kind: 'user' } },
  });
  fs.writeFileSync(file, encodeSession(header, events));
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  return file;
}

function cardFile({ title, strength = 3, lastUsed = '2026-11-01', revisions = 0, salience = 3, status = null, body = '正文。' }) {
  return [
    '---',
    `title: ${title}`,
    `salience: ${salience}`,
    `strength: ${strength}`,
    `last_used: ${lastUsed}`,
    `revisions: ${revisions}`,
    ...(status ? [`status: ${status}`] : []),
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

/** A host shaped like the Cordis services these tools probe. */
function workerHost() {
  const calls = { start: 0, interrupt: 0 };
  const host = {
    subagents: {
      list: () => ['spawn'],
      getProvider: () => ({ prepareContinuable() {} }),
      startActivation: async () => {
        calls.start += 1;
        return { childId: 'w-contract', messageId: 'm-contract' };
      },
      listChildren: async () => [],
      interrupt: async () => { calls.interrupt += 1; },
    },
    agents: {
      get: (id) => (id === 'w-contract'
        ? { status: 'running', session: { snapshotEvents: () => [{ type: 'turn/start' }] } }
        : null),
    },
    agent: { id: 'parent-1', status: 'idle' },
    compaction: {},
  };
  return { host, calls };
}

export async function runToolsContractSuite({ runAsyncCase, assert, TMP }) {
  resetCoverage();
  runAsyncCase('C1', '22 个工具按固定顺序注册，name 与实现一一对应', async () => {
    const names = TOOLS.map((tool) => tool.name);
    assert(
      JSON.stringify(names) === JSON.stringify(CONTRACT_NAMES),
      `registration order changed: ${JSON.stringify(names)}`,
    );
    assert(TOOLS.length === 22, `expected exactly 22 tools, got ${TOOLS.length}`);
    for (const name of CONTRACT_NAMES) {
      const tool = toolNamed(name);
      assert(tool.name === name, `tool at ${name} reports a different name`);
      assert(typeof tool.invoke === 'function', `${name}: invoke missing`);
      assert(typeof tool.description === 'string' && tool.description.length > 0, `${name}: description missing`);
      assert(tool.parameters && typeof tool.parameters === 'object', `${name}: parameters schema missing`);
    }
    // Uniqueness: a duplicated name would make the host table ambiguous.
    assert(new Set(names).size === names.length, 'duplicate tool names in TOOLS');
    return '22 names, fixed order, unique, each with description/schema/invoke';
  });

  await runAsyncCase('C2', 'session_health: 读一份真日志；相对路径拒绝', async () => {
    const root = freshRoot(TMP, 'c2');
    const file = sessionFile(root);
    const got = assertOk(assert, await call('session_health', { sessionPath: file }, { home: root }), 'health ok');
    assert(got.status === 'ok' && got.events === 40, `health status/events, got ${got.status}/${got.events}`);
    assert(typeof got.deriveSha256 === 'string' && got.deriveSha256.length === 64, 'message digest present');
    const bad = assertOk(
      assert,
      await call('session_health', { sessionPath: 'relative/session.v4.jsonl.zstd' }, { home: root }),
      'health bad',
    );
    assert(
      bad.code === 'PATH_NOT_ABSOLUTE',
      `relative path must be refused as PATH_NOT_ABSOLUTE, got ${bad.status}/${bad.code}`,
    );
    return 'events=40, digest present; relative path -> status error';
  });

  await runAsyncCase('C2b', 'session_original: 取回原文；turn 不存在与隐私命中返回结构化错误', async () => {
    const root = freshRoot(TMP, 'c2b');
    const file = originalSessionFile(root);
    const config = { home: root, memoryRoot: path.join(root, 'memory') };

    const got = assertOk(
      assert,
      await call('session_original', { sessionPath: file, turn: 1 }, config),
      'original ok',
    );
    assert(got.ok === true, 'original ok: expected ok:true');
    assert(got.content === 'contract original tool output', `unexpected content: ${JSON.stringify(got.content)}`);
    assert(
      got.archives[0].path.endsWith(path.join('tool-output', '1', 'call-original.txt')),
      `unexpected archive path: ${got.archives[0].path}`,
    );
    assert(got.archives[0].exists === false, 'session_original must not write the D2 archive');

    const missing = assertOk(
      assert,
      await call('session_original', { sessionPath: file, turn: 9 }, config),
      'original missing turn',
    );
    assert(missing.ok === false, 'missing turn: expected ok:false');
    assert(missing.code === 'TURN_NOT_FOUND', `missing turn: unexpected code ${missing.code}`);

    const blocked = assertOk(
      assert,
      await call('session_original', { sessionPath: file, turn: 2, kind: 'message' }, config),
      'original privacy',
    );
    assert(blocked.ok === false, 'privacy: expected ok:false');
    assert(blocked.code === 'PRIVACY_BLOCKED', `privacy: unexpected code ${blocked.code}`);
    assert(Object.prototype.hasOwnProperty.call(blocked, 'content') === false, 'privacy: content must be absent');

    return 'tool output returned; missing turn -> TURN_NOT_FOUND; phone -> PRIVACY_BLOCKED (no content)';
  });

  await runAsyncCase('C3', 'session_backup: dry-run planned；真写缺 confirm 拒绝', async () => {
    const root = freshRoot(TMP, 'c3');
    const file = sessionFile(root);
    const planned = assertOk(assert, await call('session_backup', { sessionPath: file }, { home: root }), 'backup plan');
    assert(planned.status === 'planned' && planned.bytes > 0, `planned, got ${planned.status}`);
    const refused = assertOk(
      assert,
      await call('session_backup', { sessionPath: file, dryRun: false }, { home: root }),
      'backup without confirm',
    );
    assert(refused.ok === false && String(refused.message).includes('confirm'), 'confirm word required');
    return 'dry-run planned; write without confirm refused';
  });

  await runAsyncCase('C4', 'session_truncate: dry-run planned；真写缺 confirm 拒绝', async () => {
    const root = freshRoot(TMP, 'c4');
    const file = sessionFile(root);
    const planned = assertOk(
      assert,
      await call('session_truncate', { sessionPath: file, keepEvents: 10 }, { home: root }),
      'truncate plan',
    );
    assert(planned.status === 'planned', `dry-run planned, got ${planned.status}`);
    const refused = assertOk(
      assert,
      await call('session_truncate', { sessionPath: file, keepEvents: 10, dryRun: false }, { home: root }),
      'truncate without confirm',
    );
    assert(refused.ok === false && refused.code === 'CONFIRM_REQUIRED', 'CONFIRM_REQUIRED returned');
    return 'dry-run planned; unconditional write refused';
  });

  await runAsyncCase('C4b', 'session_truncate_visible: dry-run planned；确认词错误拒绝', async () => {
    const root = freshRoot(TMP, 'c4b');
    const file = visibleSessionFile(root);
    const planned = assertOk(
      assert,
      await call('session_truncate_visible', {
        sessionPath: file, keepTurns: 3, keepTokens: 1_000_000,
      }, { home: root }),
      'visible truncate plan',
    );
    assert(planned.status === 'planned' && planned.cut.turn === 6, `planned cut ${planned.status}/${planned.cut?.turn}`);
    const refused = assertOk(
      assert,
      await call('session_truncate_visible', {
        sessionPath: file, dryRun: false, confirm: 'WRONG',
        keepTurns: 3, keepTokens: 1_000_000,
      }, { home: root }),
      'visible truncate without confirm',
    );
    assert(refused.ok === false && refused.code === 'CONFIRM_REQUIRED', 'CONFIRM_REQUIRED returned');
    return 'dry-run planned at turn 6; unconditional write refused';
  });

  await runAsyncCase('C5', 'session_compact: 有 compaction/agent 服务时 planned；没有时 unavailable', async () => {
    const planned = assertOk(
      assert,
      await call('session_compact', {}, { host: () => ({ compaction: {}, agent: { status: 'idle' } }) }),
      'compact plan',
    );
    assert(planned.status === 'planned' && planned.ok === true, `planned, got ${planned.status}`);
    const missing = assertOk(assert, await call('session_compact', {}, {}), 'compact no service');
    assert(
      missing.ok === false && missing.status === 'unavailable' && missing.code === 'COMPACTION_UNAVAILABLE',
      `no service -> unavailable, got ${missing.status}/${missing.code}`,
    );
    return 'planned with service; unavailable without it';
  });

  await runAsyncCase('C6', 'session_wake: 空根也返回 ok；根不存在返回 unavailable', async () => {
    const root = freshRoot(TMP, 'c6');
    const woke = assertOk(assert, await call('session_wake', {}, { memRoot: root }), 'wake ok');
    assert(woke.status === 'ok' && typeof woke.message === 'string', `wake ok, got ${woke.status}`);
    const missing = assertOk(
      assert,
      await call('session_wake', {}, { memRoot: path.join(root, 'nope') }),
      'wake missing root',
    );
    assert(missing.status === 'unavailable', `missing root -> unavailable, got ${missing.status}`);
    return 'ok on an empty store; unavailable when the root is missing';
  });

  await runAsyncCase('C7', 'lease_acquire: 首个成功；缺 holder 拒绝', async () => {
    const root = freshRoot(TMP, 'c7');
    const got = assertOk(assert, await call('lease_acquire', { holder: 'c7-a', ttlSec: 60 }, { memRoot: root }), 'acquire');
    assert(got.ok === true && got.holder === 'c7-a', `acquired, got ${JSON.stringify(got)}`);
    const refused = assertOk(assert, await call('lease_acquire', {}, { memRoot: root }), 'acquire no holder');
    assert(refused.ok === false && refused.reason === 'holder required', 'holder required');
    return 'acquired; missing holder refused';
  });

  await runAsyncCase('C8', 'lease_release: 持有者释放成功；空租约 no lease', async () => {
    const root = freshRoot(TMP, 'c8');
    assertOk(assert, await call('lease_acquire', { holder: 'c8-a' }, { memRoot: root }), 'setup acquire');
    const released = assertOk(assert, await call('lease_release', { holder: 'c8-a' }, { memRoot: root }), 'release');
    assert(released.ok === true && released.released === true, 'released');
    const none = assertOk(assert, await call('lease_release', { holder: 'c8-b' }, { memRoot: root }), 'release none');
    assert(none.ok === false && none.reason === 'no lease', 'no lease reported');
    return 'released by holder; second release says no lease';
  });

  await runAsyncCase('C9', 'worker_spawn: 宿主有 subagents 时 dispatched；缺 prompt 拒绝', async () => {
    const { host } = workerHost();
    const dispatched = assertOk(
      assert,
      await call('worker_spawn', { prompt: 'contract task', timeoutSec: 5 }, { host: () => host, exec: { agent: { id: 'parent-1' } } }),
      'spawn',
    );
    assert(
      dispatched.ok === true && dispatched.status === 'dispatched' && dispatched.workerId === 'w-contract',
      `dispatched, got ${JSON.stringify(dispatched)}`,
    );
    const refused = assertOk(
      assert,
      await call('worker_spawn', {}, { host: () => host, exec: { agent: { id: 'parent-1' } } }),
      'spawn no prompt',
    );
    assert(refused.ok === false && refused.status === 'unavailable', 'missing prompt -> unavailable');
    return 'dispatched w-contract; missing prompt refused';
  });

  await runAsyncCase('C10', 'worker_status: 活 worker 返回 live；未知 worker unavailable', async () => {
    const { host } = workerHost();
    const live = assertOk(
      assert,
      await call('worker_status', { workerId: 'w-contract' }, { host: () => host, home: freshRoot(TMP, 'c10-home') }),
      'status live',
    );
    assert(live.ok === true && live.live === true && live.events === 1, `live worker, got ${JSON.stringify(live)}`);
    const missing = assertOk(
      assert,
      await call('worker_status', { workerId: 'w-missing' }, { host: () => host, home: freshRoot(TMP, 'c10-home2') }),
      'status missing',
    );
    assert(missing.ok === false && missing.status === 'unavailable', 'unknown worker unavailable');
    return 'live worker reports events; unknown worker unavailable';
  });

  await runAsyncCase('C11', 'worker_kill: 活 worker 调 interrupt；未知 worker 不调', async () => {
    const { host, calls } = workerHost();
    const killed = assertOk(
      assert,
      await call('worker_kill', { workerId: 'w-contract' }, { host: () => host, home: freshRoot(TMP, 'c11-home'), exec: { agent: { id: 'parent-1' } } }),
      'kill',
    );
    assert(killed.ok === true && killed.status === 'killed' && calls.interrupt === 1, 'interrupt called exactly once');
    const missing = assertOk(
      assert,
      await call('worker_kill', { workerId: 'w-missing' }, { host: () => host, home: freshRoot(TMP, 'c11-home2'), exec: { agent: { id: 'parent-1' } } }),
      'kill missing',
    );
    assert(missing.ok === false && calls.interrupt === 1, 'unknown worker must not call interrupt');
    return 'killed -> interrupt=1; unknown -> interrupt stays 1';
  });

  await runAsyncCase('C12', 'memory_index: 空根 dry-run；没有 memoryRoot 抛 E_MEMORY_ROOT_UNSET', async () => {
    const root = freshRoot(TMP, 'c12');
    const got = assertOk(assert, await call('memory_index', {}, { memoryRoot: root }), 'index dry-run');
    assert(got.ok === true && got.status === 'dry-run' && got.dryRun === true, 'dry-run');
    assertError(assert, await call('memory_index', {}, { strictMemoryRoot: true }), 'E_MEMORY_ROOT_UNSET', 'index no root');
    return 'dry-run ok; unset root throws E_MEMORY_ROOT_UNSET';
  });

  await runAsyncCase('C13', 'memory_consolidate: 出报告；apply:true 抛 E_READ_ONLY', async () => {
    const root = freshRoot(TMP, 'c13');
    const got = assertOk(
      assert,
      await call('memory_consolidate', {}, { memoryRoot: root, now: new Date('2026-11-02T00:00:00.000Z'), today: '2026-11-02' }),
      'consolidate',
    );
    assert(got.ok === true && got.status === 'report', `report, got ${got.status}`);
    assertError(assert, await call('memory_consolidate', { apply: true }, { memoryRoot: root }), 'E_READ_ONLY', 'consolidate apply');
    return 'report written; apply refused as read-only';
  });

  await runAsyncCase('C14', 'memory_reinforce: 强化一张卡；缺 path 抛 E_BAD_ARGUMENT', async () => {
    const root = freshRoot(TMP, 'c14');
    fs.mkdirSync(path.join(root, 'topics'), { recursive: true });
    fs.writeFileSync(path.join(root, 'topics', 'heat.md'), cardFile({ title: '热卡' }));
    const got = assertOk(
      assert,
      await call('memory_reinforce', { path: 'topics/heat.md' }, { memoryRoot: root, now: new Date('2026-11-02T00:00:00.000Z'), today: '2026-11-02' }),
      'reinforce',
    );
    assert(got.ok === true && got.status === 'reinforced', `reinforced, got ${got.status}`);
    assertError(assert, await call('memory_reinforce', {}, { memoryRoot: root }), 'E_BAD_ARGUMENT', 'reinforce no path');
    return 'strength bumped; missing path rejected';
  });

  await runAsyncCase('C15', 'memory_forget: 空根 dry-run；错误 confirm 抛 E_CONFIRM_REQUIRED', async () => {
    const root = freshRoot(TMP, 'c15');
    const got = assertOk(assert, await call('memory_forget', {}, { memoryRoot: root }), 'forget dry-run');
    assert(got.ok === true && got.dryRun === true && got.status === 'dry-run', 'dry-run');
    assertError(assert, await call('memory_forget', { confirm: 'nope' }, { memoryRoot: root }), 'E_CONFIRM_REQUIRED', 'forget bad confirm');
    return 'dry-run ok; wrong confirm rejected';
  });

  await runAsyncCase('C15b', 'memory_procedure: 存一张卡并读回；缺 action 抛 E_BAD_ARGUMENT', async () => {
    const root = freshRoot(TMP, 'c15b');
    const config = { memoryRoot: root, now: new Date('2026-11-02T00:00:00.000Z'), today: '2026-11-02' };
    const saved = assertOk(
      assert,
      await call('memory_procedure', {
        action: 'save', name: '契约流程', trigger: ['契约'], when: '跑契约测试时。', steps: ['存一张'],
      }, config),
      'procedure save',
    );
    assert(saved.ok === true && saved.status === 'created' && saved.version === 1, `save status/version: ${saved.status}/${saved.version}`);
    const got = assertOk(assert, await call('memory_procedure', { action: 'get', slug: saved.slug }, config), 'procedure get');
    assert(got.ok === true && got.rel === saved.rel && got.name === '契约流程', 'get did not read the card back');
    assertError(assert, await call('memory_procedure', {}, config), 'E_BAD_ARGUMENT', 'procedure without action');
    return 'card saved and read back; missing action rejected';
  });

  await runAsyncCase('C15c', 'memory_recall: 命中锁定卡；空 query 抛 E_RECALL_EMPTY_QUERY', async () => {
    const root = freshRoot(TMP, 'c15c');
    fs.mkdirSync(path.join(root, 'topics'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'topics', 'core.md'),
      cardFile({ title: '核心记忆', status: 'locked', salience: 5, body: '从听觉开始，靠离散训练长出感觉。' }),
    );
    const config = { memoryRoot: root };
    const got = assertOk(assert, await call('memory_recall', { query: '听觉 训练' }, config), 'recall hit');
    assert(got.ok === true && got.count >= 1, `recall count: ${got.count}`);
    assert(got.results[0].path === 'topics/core.md', `recall top1: ${JSON.stringify(got.results[0])}`);
    assert(typeof got.results[0].score === 'number' && got.results[0].score > 0, 'recall score missing');
    assertError(assert, await call('memory_recall', { query: '   ' }, config), 'E_RECALL_EMPTY_QUERY', 'recall blank query');
    return 'locked card recalled with a score; blank query rejected';
  });

  await runAsyncCase('C16', 'session_live_update: 写一行；路径型 id 抛 E_PATH_OUTSIDE_ROOT', async () => {
    const root = freshRoot(TMP, 'c16');
    const got = assertOk(
      assert,
      await call('session_live_update', { sessionId: 'c16-session', state: 'running', goal: 'contract' }, { memoryRoot: root }),
      'live update',
    );
    assert(got.ok === true && got.status === 'written' && got.sessionId === 'c16-session', 'written');
    assertError(
      assert,
      await call('session_live_update', { sessionId: '../escape', state: 'running' }, { memoryRoot: root }),
      'E_PATH_OUTSIDE_ROOT',
      'live update escape',
    );
    return 'row written; ../ id refused';
  });

  await runAsyncCase('C17', 'session_live_list: 列出刚写的行；无 memoryRoot 拒绝', async () => {
    const root = freshRoot(TMP, 'c17');
    assertOk(assert, await call('session_live_update', { sessionId: 'c17-session', state: 'idle' }, { memoryRoot: root }), 'setup');
    const listed = assertOk(assert, await call('session_live_list', {}, { memoryRoot: root }), 'list');
    assert(listed.ok === true && listed.count === 1 && listed.entries[0].sessionId === 'c17-session', 'one row listed');
    assertError(assert, await call('session_live_list', {}, { strictMemoryRoot: true }), 'E_MEMORY_ROOT_UNSET', 'list no root');
    return 'one row listed; unset root rejected';
  });

  await runAsyncCase('C18', 'session_live_get: 命中读回；未知 id 返回 absent', async () => {
    const root = freshRoot(TMP, 'c18');
    assertOk(assert, await call('session_live_update', { sessionId: 'c18-session', state: 'waiting' }, { memoryRoot: root }), 'setup');
    const got = assertOk(assert, await call('session_live_get', { sessionId: 'c18-session' }, { memoryRoot: root }), 'get');
    assert(
      got.ok === true && got.found === true
        && got.live.state === 'waiting' && got.live.effectiveState === 'running',
      `fresh heartbeat keeps a waiting row running, got ${JSON.stringify(got.live && { state: got.live.state, effectiveState: got.live.effectiveState })}`,
    );
    const absent = assertOk(assert, await call('session_live_get', { sessionId: 'c18-none' }, { memoryRoot: root }), 'get absent');
    assert(absent.ok === false && absent.status === 'absent', 'unknown id is absent, not corrupt');
    return 'hit read back; miss reported absent';
  });

  await runAsyncCase('C19', 'session_live_prune: 默认 dry-run；缺 confirm 抛 E_CONFIRM_REQUIRED', async () => {
    const root = freshRoot(TMP, 'c19');
    assertOk(assert, await call('session_live_update', { sessionId: 'c19-session', state: 'idle' }, { memoryRoot: root }), 'setup');
    const preview = assertOk(assert, await call('session_live_prune', {}, { memoryRoot: root }), 'prune preview');
    assert(preview.ok === true && preview.status === 'dry-run', `dry-run, got ${preview.status}`);
    assertError(
      assert,
      await call('session_live_prune', { dryRun: false, confirm: 'nope' }, { memoryRoot: root }),
      'E_CONFIRM_REQUIRED',
      'prune no confirm',
    );
    return 'dry-run default; unconfirmed delete refused';
  });

  await runAsyncCase('C20', 'goal 截断按码点：混合字面量 90 码点（含代理对）截到 80，split("") 会砍坏', async () => {
    const root = freshRoot(TMP, 'c20');
    const prefix = '示例会话记录表测试鲸';
    const emoji = '😀😃😄😁😆😅😂🤣😊😇'
      + '🥰😍🤩😘😗😚😙😋😛😜'
      + '🤪😝🤑🤗🤭🤫🤔🤐🤨😐'
      + '😑😶😏😒🙄😬🤥😌😔😪'
      + '🤤😴😷🤒🤕🤢🤮🤧🥵🥶'
      + '🥳🥺🤠🤡🤖👻👽💩👾🎃'
      + '🦄🐺🦊🐱🐶🐼🐨🐯🦁🐸'
      + '🍎🍊🍋🍌🍉🍇🍓🫐🍒🍑';
    const goal = prefix + emoji;
    // Independent literal: 10 CJK + 70 astral emoji = 80 code points.
    const expected = prefix
      + '😀😃😄😁😆😅😂🤣😊😇'
      + '🥰😍🤩😘😗😚😙😋😛😜'
      + '🤪😝🤑🤗🤭🤫🤔🤐🤨😐'
      + '😑😶😏😒🙄😬🤥😌😔😪'
      + '🤤😴😷🤒🤕🤢🤮🤧🥵🥶'
      + '🥳🥺🤠🤡🤖👻👽💩👾🎃'
      + '🦄🐺🦊🐱🐶🐼🐨🐯🦁🐸';
    assert([...goal].length === 90, 'fixture itself must be 90 code points');
    assert([...expected].length === 80, 'expected fixture must be 80 code points');

    const got = assertOk(
      assert,
      await call('session_live_update', { sessionId: 'c20-emoji', state: 'running', goal }, { memoryRoot: root }),
      'emoji goal',
    );
    assert(got.goalChars === 90, `input is 90 code points, got ${got.goalChars}`);
    assert(got.goalTruncated === true, 'goal must report truncation');
    assert(got.record.goal === expected, `stored goal differs from the independent 80-code-point literal (${[...got.record.goal].length} code points)`);
    assert([...got.record.goal].length === 80, 'stored goal is 80 code points');
    return '90 mixed code points -> exactly 80 (10 CJK + 70 astral), literal expectation';
  });

  await runAsyncCase('C21', '契约覆盖：22 个 invoke 各跑过至少一次成功与一次错误路径', async () => {
    const gaps = [];
    let calls = 0;
    let okCalls = 0;
    let errorCalls = 0;
    for (const name of CONTRACT_NAMES) {
      const slot = coverage?.get(name);
      if (!slot || slot.calls === 0) {
        gaps.push(`${name}: not invoked`);
        continue;
      }
      calls += slot.calls;
      okCalls += slot.ok;
      errorCalls += slot.error;
      if (slot.ok === 0) gaps.push(`${name}: no success path`);
      if (slot.error === 0) gaps.push(`${name}: no error path`);
    }
    assert(gaps.length === 0, `contract coverage gaps: ${gaps.join('; ')}`);
    assert(calls >= CONTRACT_NAMES.length * 2, `expected at least 2 invokes per tool, got ${calls}`);
    return `${CONTRACT_NAMES.length} tools, ${calls} invokes = ${okCalls} success + ${errorCalls} error-path`;
  });
}
