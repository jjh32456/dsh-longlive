// Auto-binding + auto-heartbeat tests (AB*).
//
// These cases pin the two behaviours added in 0.5.1:
//   - identity resolution from the explicit caller Agent (`exec.agent`) with
//     every fallback source independent of the host;
//   - a heartbeat that only ever refreshes rows this writer bound, preserves
//     the row's meaning, and is switchable off with `heartbeatMs: 0`.
//
// Every fixture lives under the harness tmp directory; nothing here writes
// inside the package tree (P6 checks that afterwards).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveCurrentSessionId,
  sessionIdOfAgent,
  sessionIdOfExec,
} from '../src/identity.js';
import {
  LIVE_SCHEMA_VERSION,
  LIVE_RECORD_FIELDS,
  liveUpdate,
  liveTouch,
} from '../src/live.js';
import { createAutoHeartbeat, DEFAULT_HEARTBEAT_MS, MAX_BOUND_SESSIONS } from '../src/heartbeat.js';

const NOW = Date.parse('2026-05-06T07:08:09.000Z');
const HOST = os.hostname();

function newRoot(TMP, name) {
  const root = fs.mkdtempSync(path.join(TMP, `autobind-${name}-`));
  return root;
}

function rowPath(root, id) {
  return path.join(root, '.longlive', 'live', `${id}.json`);
}

function readRow(root, id) {
  return JSON.parse(fs.readFileSync(rowPath(root, id), 'utf8'));
}

function fileSha(file) {
  return fs.readFileSync(file).toString('base64');
}

/** A complete, realistic row created through the public writer. */
function seedRow(root, id, extra = {}) {
  liveUpdate({
    sessionId: id,
    state: 'blocked',
    blocked_on: '等待用户确认',
    goal: '验证自动绑定',
    queued: ['step-1', 'step-2'],
    ...extra,
  }, { memoryRoot: root, now: new Date(NOW) });
  return readRow(root, id);
}

function agent(id, { header = true } = {}) {
  return header
    ? { id, session: { header: { id }, id } }
    : { id, session: { id } };
}

export async function runAutoBindSuite({ runCase, assert, TMP }) {
  // ------------------------------------------------------------ identity
  runCase('AB1', '身份优先级：exec.agent.session.header.id 压过 initiator / ctx / env', () => {
    const ctx = {
      get: (name) => (name === 'agents'
        ? { currentInitiator: () => agent('initiator-id') }
        : null),
      agent: agent('ctx-agent-id'),
    };
    const exec = { agent: agent('exec-id') };
    const found = resolveCurrentSessionId({ ctx, exec, env: { DSH_SESSION_ID: 'env-id' } });
    assert(found.id === 'exec-id', `id=${found.id}`);
    assert(found.source === 'exec.agent', `source=${found.source}`);
    return 'exec.agent.session.header.id → exec-id';
  });

  runCase('AB2', '身份链：header 缺失时用 agent.session.id，再退到 agent.id', () => {
    const sessionOnly = resolveCurrentSessionId({
      exec: { agent: { id: 'agent-id', session: { id: 'session-id' } } },
      env: {},
    });
    assert(sessionOnly.id === 'session-id', `session=${sessionOnly.id}`);
    assert(sessionOnly.source === 'exec.agent', sessionOnly.source);
    const agentOnly = resolveCurrentSessionId({
      exec: { agent: { id: 'agent-id-only' } },
      env: {},
    });
    assert(agentOnly.id === 'agent-id-only', `agent=${agentOnly.id}`);
    assert(agentOnly.source === 'exec.agent', agentOnly.source);
    // Direct helpers must agree with the resolver.
    assert(sessionIdOfAgent(agent('a1')) === 'a1', 'sessionIdOfAgent');
    assert(sessionIdOfExec({ agent: agent('a2') }) === 'a2', 'sessionIdOfExec');
    assert(sessionIdOfAgent(null) === null && sessionIdOfExec(undefined) === null, 'null tolerance');
    return 'header → session.id → agent.id';
  });

  runCase('AB3', '身份链：无 exec 时用 agents.currentInitiator()', () => {
    const ctx = {
      get: (name) => (name === 'agents'
        ? { currentInitiator: () => agent('initiator-id') }
        : null),
    };
    const found = resolveCurrentSessionId({ ctx, exec: null, env: { DSH_SESSION_ID: 'env-id' } });
    assert(found.id === 'initiator-id', `id=${found.id}`);
    assert(found.source === 'agents.currentInitiator', `source=${found.source}`);
    return 'currentInitiator → initiator-id';
  });

  runCase('AB4', '身份链：没有 agents 服务时退到 ctx.agent / ctx.session，再退到 env', () => {
    const ctxAgent = { agent: agent('ctx-agent-id') };
    const a = resolveCurrentSessionId({ ctx: ctxAgent, env: { DSH_SESSION_ID: 'env-id' } });
    assert(a.id === 'ctx-agent-id' && a.source === 'ctx.agent', `${a.id}/${a.source}`);
    const ctxSession = { session: { id: 'ctx-session-id' } };
    const b = resolveCurrentSessionId({ ctx: ctxSession, env: { DSH_SESSION_ID: 'env-id' } });
    assert(b.id === 'ctx-session-id' && b.source === 'ctx.agent', `${b.id}/${b.source}`);
    const envOnly = resolveCurrentSessionId({ ctx: null, exec: null, env: { DSH_SESSION_ID: ' env-id ' } });
    assert(envOnly.id === 'env-id' && envOnly.source === 'env.DSH_SESSION_ID', `${envOnly.id}/${envOnly.source}`);
    const none = resolveCurrentSessionId({ ctx: null, exec: null, env: {} });
    assert(none.id === null && none.source === 'none', `${none.id}/${none.source}`);
    return 'ctx.agent → ctx.session → env → none';
  });

  runCase('AB5', '身份链：坏来源（抛错 / 非字符串 / 纯空白）一律降级，不抛异常', () => {
    const ctx = {
      get: () => { throw new Error('service disposed'); },
      agent: { id: 42, session: { header: { id: 7 } } },
    };
    const found = resolveCurrentSessionId({
      ctx,
      exec: { agent: { id: null, session: { header: { id: '   ' } } } },
      env: { DSH_SESSION_ID: 'fallback-id' },
    });
    assert(found.id === 'fallback-id', `id=${found.id}`);
    assert(found.source === 'env.DSH_SESSION_ID', found.source);
    return 'throwing get() and non-string ids fall through to env';
  });

  runCase('AB6', 'live_touch：刷新已存在的行，state/goal/queued/startedAt 原样保留', () => {
    const root = newRoot(TMP, 'touch');
    seedRow(root, 'row-a');
    const before = readRow(root, 'row-a');
    const result = liveTouch('row-a', {
      memoryRoot: root,
      now: new Date(NOW + 5000),
      kind: 'tool',
      detail: 'longlive 工具调用：session_live_list',
    });
    assert(result.ok === true && result.status === 'touched', JSON.stringify(result.status));
    const after = readRow(root, 'row-a');
    assert(after.heartbeatAt === new Date(NOW + 5000).toISOString(), after.heartbeatAt);
    assert(after.updatedAt === after.heartbeatAt, 'updatedAt follows heartbeatAt');
    assert(after.startedAt === before.startedAt, 'startedAt preserved');
    assert(after.state === 'blocked' && after.blocked_on === '等待用户确认', 'state preserved');
    assert(after.goal === '验证自动绑定', 'goal preserved');
    assert(after.queued.join(',') === 'step-1,step-2', 'queued preserved');
    assert(after.last_action.at === after.heartbeatAt, 'last_action.at refreshed');
    assert(after.last_action.kind === 'tool', after.last_action.kind);
    assert(Object.keys(after).sort().join(',') === LIVE_RECORD_FIELDS.slice().sort().join(','), 'field set stable');
    assert(after.schemaVersion === LIVE_SCHEMA_VERSION, 'schema version stable');
    return `${after.heartbeatAt} / state=${after.state}`;
  });

  runCase('AB7', 'live_touch：行不存在时绝不新建（absent）', () => {
    const root = newRoot(TMP, 'absent');
    const result = liveTouch('ghost-row', { memoryRoot: root, now: new Date(NOW) });
    assert(result.ok === false && result.status === 'absent', JSON.stringify(result));
    assert(!fs.existsSync(rowPath(root, 'ghost-row')), 'no file created');
    return 'absent, no file';
  });

  runCase('AB8', 'live_touch：损坏行原样不动（corrupt，不“修好”也不删）', () => {
    const root = newRoot(TMP, 'corrupt');
    const file = rowPath(root, 'broken-row');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json\n');
    const before = fileSha(file);
    const result = liveTouch('broken-row', { memoryRoot: root, now: new Date(NOW + 1000) });
    assert(result.ok === false && result.status === 'corrupt', JSON.stringify(result));
    assert(fileSha(file) === before, 'bytes unchanged');
    return 'corrupt, untouched';
  });

  runCase('AB9', 'live_touch：lastAction:false 只动心跳时间，last_action 原样', () => {
    const root = newRoot(TMP, 'keep-action');
    seedRow(root, 'row-b');
    const before = readRow(root, 'row-b');
    const result = liveTouch('row-b', {
      memoryRoot: root,
      now: new Date(NOW + 9000),
      lastAction: false,
    });
    assert(result.ok === true, JSON.stringify(result));
    const after = readRow(root, 'row-b');
    assert(after.heartbeatAt === new Date(NOW + 9000).toISOString(), after.heartbeatAt);
    assert(JSON.stringify(after.last_action) === JSON.stringify(before.last_action), 'last_action unchanged');
    return 'heartbeat only';
  });

  runCase('AB10', 'live_update 无 sessionId：用 exec.agent 自动解析并登记绑定', () => {
    const root = newRoot(TMP, 'auto-id');
    const boundIds = [];
    const result = liveUpdate({ state: 'running', goal: '自动绑定' }, {
      memoryRoot: root,
      now: new Date(NOW),
      exec: { agent: agent('auto-session-id') },
      currentSessionId: (exec) => resolveCurrentSessionId({ ctx: null, exec }).id,
      onAutoSessionId: (id) => boundIds.push(id),
    });
    assert(result.ok === true && result.sessionId === 'auto-session-id', `${result.sessionId}`);
    assert(fs.existsSync(rowPath(root, 'auto-session-id')), 'row written');
    assert(boundIds.join(',') === 'auto-session-id', `bound=${boundIds.join(',')}`);
    return 'written + bound';
  });

  runCase('AB11', '显式 sessionId 仍优先，且不被当成“当前会话”登记', () => {
    const root = newRoot(TMP, 'explicit');
    const boundIds = [];
    const result = liveUpdate({ sessionId: 'someone-else', state: 'running' }, {
      memoryRoot: root,
      now: new Date(NOW),
      exec: { agent: agent('my-session') },
      currentSessionId: (exec) => resolveCurrentSessionId({ ctx: null, exec }).id,
      onAutoSessionId: (id) => boundIds.push(id),
    });
    assert(result.sessionId === 'someone-else', result.sessionId);
    assert(boundIds.length === 0, `bound=${boundIds.join(',')}`);
    assert(!fs.existsSync(rowPath(root, 'my-session')), 'no row for the caller');
    return 'explicit wins, no bind';
  });

  // ----------------------------------------------------------- heartbeat
  runCase('AB12', '自动心跳：工具调用刷新已绑定行；首次调用自动登记；身份不明不写文件', () => {
    const root = newRoot(TMP, 'hb-touch');
    seedRow(root, 'mine');
    const beat = createAutoHeartbeat({
      memoryRoot: root,
      now: () => NOW + 1500,
      ctx: null,
      resolve: () => ({ id: 'mine', source: 'exec.agent' }),
    });
    const touched = beat.autoTouch({}, 'memory_index');
    assert(touched.ok === true && touched.status === 'touched', JSON.stringify(touched));
    assert(beat.boundIds().join(',') === 'mine', beat.boundIds().join(','));
    const after = readRow(root, 'mine');
    assert(after.last_action.kind === 'tool', after.last_action.kind);
    assert(after.heartbeatAt === new Date(NOW + 1500).toISOString(), after.heartbeatAt);

    // No row yet: the first tool call is the session's self-registration, so
    // `session_live_list` can show "this is me" without a sessionId argument.
    const beat2 = createAutoHeartbeat({
      memoryRoot: root,
      now: () => NOW + 2500,
      ctx: null,
      resolve: () => ({ id: 'ghost', source: 'exec.agent' }),
    });
    const ghost = beat2.autoTouch({}, 'session_live_list');
    assert(ghost.ok === true && ghost.created === true, JSON.stringify(ghost));
    const row = readRow(root, 'ghost');
    assert(row.sessionId === 'ghost', row.sessionId);
    assert(row.state === 'running', row.state);
    assert(row.pid === process.pid, String(row.pid));
    assert(row.last_action.kind === 'tool', row.last_action.kind);
    assert(row.last_action.detail.includes('session_live_list'), row.last_action.detail);

    // An identity that cannot be resolved writes nothing (no guessed rows).
    const beat3 = createAutoHeartbeat({
      memoryRoot: root,
      ctx: null,
      resolve: () => ({ id: null, source: 'none' }),
    });
    const none = beat3.autoTouch({}, 'memory_index');
    assert(none === null, JSON.stringify(none));
    assert(fs.readdirSync(path.join(root, '.longlive', 'live')).sort().join(',') === 'ghost.json,mine.json',
      'no row for an unknown caller');
    return 'tool touch refreshes; first call registers; unknown identity writes nothing';
  });

  runCase('AB13', 'turn/start 与 turn/end：只刷新已绑定行，其他会话一律忽略', () => {
    const root = newRoot(TMP, 'turns');
    seedRow(root, 'mine');
    seedRow(root, 'other');
    const beforeOther = fileSha(rowPath(root, 'other'));
    const beat = createAutoHeartbeat({
      memoryRoot: root,
      heartbeatMs: 0,
      ctx: null,
      resolve: () => ({ id: 'mine', source: 'exec.agent' }),
    });
    beat.bind('mine');
    // heartbeatMs:0 disables writes by contract; flip it on for this case by
    // rebuilding with a real interval but no timer (start() not called).
    const live = createAutoHeartbeat({
      memoryRoot: root,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      ctx: null,
      now: () => NOW + 2000,
    });
    live.bind('mine');
    live.onSessionEvent({ id: 'other' }, { type: 'turn/end', data: { turn: 3 } });
    assert(fileSha(rowPath(root, 'other')) === beforeOther, 'other row untouched');
    live.onSessionEvent({ id: 'mine' }, { type: 'turn/start', data: { turn: 4 } });
    const afterStart = readRow(root, 'mine');
    assert(afterStart.last_action.detail === 'turn/start #4', afterStart.last_action.detail);
    live.onSessionEvent({ id: 'mine' }, { type: 'turn/end', data: { turn: 4 } });
    const afterEnd = readRow(root, 'mine');
    assert(afterEnd.last_action.detail === 'turn/end #4', afterEnd.last_action.detail);
    assert(beat.boundIds().join(',') === 'mine', 'disabled manager still binds');
    return 'turn boundaries refresh only the bound row';
  });

  runCase('AB14', '兜底定时器：默认 15s、unref、只刷心跳不动 last_action、stop 后清掉', () => {
    const root = newRoot(TMP, 'timer');
    seedRow(root, 'mine');
    const before = readRow(root, 'mine');
    let captured = null;
    let capturedMs = 0;
    let cleared = null;
    let unrefCalled = false;
    const listeners = [];
    const fakeCtx = {
      on: (name, fn) => { listeners.push({ name, fn }); return () => { cleared = 'listener'; }; },
    };
    const beat = createAutoHeartbeat({
      memoryRoot: root,
      ctx: fakeCtx,
      now: () => NOW + 30_000,
      setInterval: (fn, ms) => {
        captured = fn;
        capturedMs = ms;
        return { unref: () => { unrefCalled = true; } };
      },
      clearInterval: (timer) => { cleared = timer; },
    });
    assert(beat.intervalMs() === DEFAULT_HEARTBEAT_MS, `${beat.intervalMs()}`);
    const started = beat.start();
    assert(started === true, 'started');
    assert(capturedMs === DEFAULT_HEARTBEAT_MS, `ms=${capturedMs}`);
    assert(unrefCalled === true, 'timer.unref() called');
    assert(listeners.length === 1 && listeners[0].name === 'session/event', 'session/event subscribed');
    beat.bind('mine');
    captured();
    const after = readRow(root, 'mine');
    assert(after.heartbeatAt === new Date(NOW + 30_000).toISOString(), after.heartbeatAt);
    assert(JSON.stringify(after.last_action) === JSON.stringify(before.last_action), 'timer keeps last_action');
    const timer = beat.stop();
    assert(timer === true && cleared != null, 'stop clears timer');
    assert(beat.start() === false, 'cannot restart after stop');
    return `${capturedMs}ms, unref, one tick, stop`;
  });

  runCase('AB15', 'heartbeatMs:0 关闭全部自动写；绑定上限有界', () => {
    const root = newRoot(TMP, 'off');
    seedRow(root, 'mine');
    const before = fileSha(rowPath(root, 'mine'));
    let timerCalls = 0;
    const beat = createAutoHeartbeat({
      memoryRoot: root,
      heartbeatMs: 0,
      ctx: { on: () => () => {} },
      setInterval: () => { timerCalls += 1; return { unref() {} }; },
      resolve: () => ({ id: 'mine', source: 'exec.agent' }),
    });
    assert(beat.isEnabled() === false, 'disabled');
    beat.start();
    assert(timerCalls === 0, 'no timer when disabled');
    assert(beat.autoTouch({}, 'session_live_list') === null, 'no tool touch when disabled');
    beat.onSessionEvent({ id: 'mine' }, { type: 'turn/start', data: { turn: 1 } });
    assert(fileSha(rowPath(root, 'mine')) === before, 'row bytes unchanged');
    for (let i = 0; i < MAX_BOUND_SESSIONS + 10; i += 1) beat.bind(`s-${i}`);
    assert(beat.boundIds().length === MAX_BOUND_SESSIONS, `bound=${beat.boundIds().length}`);
    return '0 disables writes; bound set capped';
  });
}

export const AUTOBIND_CASES = [
  'AB1', 'AB2', 'AB3', 'AB4', 'AB5', 'AB6', 'AB7', 'AB8',
  'AB9', 'AB10', 'AB11', 'AB12', 'AB13', 'AB14', 'AB15',
];
