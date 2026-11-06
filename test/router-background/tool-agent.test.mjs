// test/tool-agent.test.mjs — 工具面 fail-closed + 真宿主 {agent, dispose} 生命周期
//
// P0-1 / P0-2 回归：所有形状断言都走 test/fixtures/real-shapes.mjs
// （从宿主 checkout 抽出的真实签名），而不是让
// host-sim 自己证明自己。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from '../../src/router/background/router.mjs';
import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { createHost } from '../../src/router/background/host-sim.mjs';
import { runAgentTask } from '../../src/router/background/agent-runner.mjs';
import {
  RESTRICT_DENY,
  READ_ONLY_TOOL_ALLOWLIST,
  REGISTERED_TOOL_NAMES,
  denyReason,
  guardReason,
  installToolPolicy,
  validateDenyNames,
} from '../../src/router/background/tool-policy.mjs';
import {
  durableUserMessage,
  makeRealAgents,
  realToolSurface,
  realToolSurfaceWithoutNames,
  tool,
} from './fixtures/real-shapes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(path.dirname(here), '.tmp');
let caseNo = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRouter(host, overrides = {}) {
  const dir = path.join(TMP, `tool-case-${process.pid}-${caseNo++}`);
  fs.mkdirSync(dir, { recursive: true });
  return new Router({
    queuePath: path.join(dir, 'queue.jsonl'),
    auditPath: path.join(dir, 'audit.jsonl'),
    llm: new MockLlm(),
    ctx: host.ctx,
    agents: host.agents,
    agentSetup: (ctx, agent) => installToolPolicy(ctx, { agent }),
    ...overrides,
  });
}

test('工具名全集：注册表唯一，RESTRICT_DENY = 全集 - 只读白名单 - run_code', () => {
  const names = [...REGISTERED_TOOL_NAMES];
  assert.equal(new Set(names).size, names.length, '注册名不能重复');
  assert.ok(Object.isFrozen(REGISTERED_TOOL_NAMES));
  assert.ok(names.length >= 45, `真实注册名只有 ${names.length} 个，注册表明显缺包`);
  assert.ok(names.every((name) => typeof name === 'string' && !name.includes('*')));

  const expectedDeny = names.filter(
    (name) => name !== 'run_code' && !READ_ONLY_TOOL_ALLOWLIST.includes(name),
  );
  assert.deepEqual([...RESTRICT_DENY].sort(), expectedDeny.sort());
  assert.equal(RESTRICT_DENY.includes('run_code'), false);

  // 每个被 deny 的名字都必须能生成一条精确拒绝原因，而不是落到空字符串。
  for (const name of RESTRICT_DENY) {
    assert.match(denyReason(name), /^tool_denied: /);
  }
  for (const name of ['subagent', 'bash', 'write', 'schedule_create', 'spawn_router', 'queue_append']) {
    assert.ok(RESTRICT_DENY.includes(name) || name === 'spawn_router' || name === 'queue_append',
      `RESTRICT_DENY 缺少 ${name}`);
  }
  assert.ok(REGISTERED_TOOL_NAMES.includes('spawn_router') === false, 'spawn_router 是测试注入名');
});

test('validateDenyNames：Set 形状 / 通配符 / 未知名字 / run_code 一律 fail-closed', () => {
  const known = new Set(['subagent', 'read', 'bash']);

  assert.throws(() => validateDenyNames(['subagent_*'], known), (error) => error.code === 'E_TOOL_POLICY');
  assert.throws(() => validateDenyNames(['not_registered'], known), (error) => error.code === 'E_UNKNOWN_RESTRICT_TOOL');
  assert.throws(() => validateDenyNames(['run_code'], known), (error) => error.code === 'E_RUN_CODE_NOT_RESTRICTABLE');
  assert.throws(() => validateDenyNames('read', known), (error) => error.code === 'E_TOOL_POLICY');
  assert.doesNotThrow(() => validateDenyNames(['subagent', 'bash'], known));
  // 拿不到 known 集合时只校验形状，未知名字交给宿主 restrict() 拒绝。
  assert.doesNotThrow(() => validateDenyNames(['not_registered'], null));
});

test('denyReason / guardReason：派生、队列写、shell、run_code、fs 写各有精确原因', () => {
  assert.match(denyReason('subagent'), /delegation\/recursion/);
  assert.match(denyReason('spawn_router'), /Router recursion/);
  assert.match(denyReason('queue_append'), /trusted task queue/);
  assert.match(denyReason('run_code'), /PTC transport/);
  assert.match(denyReason('bash'), /shell\/terminal/);
  assert.match(denyReason('write'), /writes the filesystem/);
  assert.match(denyReason('schedule_create'), /persistent schedules/);
  assert.match(denyReason('mystery_tool'), /fail-closed read-only allowlist/);

  assert.equal(guardReason({ name: 'read' }), undefined);
  assert.equal(guardReason({ name: 'glob' }), undefined);
  assert.match(guardReason({ name: 'spawn_router' }), /Router recursion/);
  assert.equal(typeof guardReason({ name: 'write' }), 'string', 'guard 必须是同步判定');
});

test('P0-1：真 view(scope).restrictableNames 是 Set，installToolPolicy 不再 Array.isArray', () => {
  const agent = { id: 'agent-set' };
  const surface = realToolSurface({ names: [...REGISTERED_TOOL_NAMES], scope: agent });
  const policy = installToolPolicy({ agent, tools: surface }, { agent });

  assert.equal(policy.strategy, 'deny-from-known-names');
  assert.equal(surface.state.restrictCalls, 1);
  assert.ok(surface.state.filter.deny instanceof Set, '真宿主 restrict() 收 Set');
  assert.equal(surface.state.filter.deny.has('run_code'), false, 'run_code 不能出现在 deny 里');
  assert.equal(surface.state.filter.deny.has('write'), true);
  assert.ok(policy.deny.includes('subagent'));
  assert.equal(policy.known.includes('run_code'), false);

  // 第二个层：guard 连 run_code 也拒（restrict 无法命名它）。
  assert.equal(surface.execute({ name: 'read', args: {}, agent }), 'ok:read');
  assert.throws(() => surface.execute({ name: 'write', args: {}, agent }),
    (error) => error.code === 'E_TOOL_DENIED');
  assert.throws(() => surface.execute({ name: 'run_code', args: {}, agent }),
    (error) => /PTC transport/.test(error.message));

  policy.dispose();
  assert.equal(surface.state.disposers, 2, 'restrict 与 guard 的 disposer 都要被调用');
});

test('P0-1：service 没有 view/restrictableNames 时退化为 allow 过滤器，不抛 E_TOOL_SURFACE', () => {
  const agent = { id: 'agent-no-view' };
  const surface = realToolSurfaceWithoutNames();
  const policy = installToolPolicy({ agent, tools: surface }, { agent });

  assert.equal(policy.strategy, 'allow-filter');
  assert.deepEqual(policy.allow, [...READ_ONLY_TOOL_ALLOWLIST]);
  assert.deepEqual(surface.state.filter.allow, [...READ_ONLY_TOOL_ALLOWLIST]);
  assert.equal(surface.execute({ name: 'read', args: {}, agent }), 'ok:read');

  // 第二种退化形状：service 上直接挂一个 Set（旧 sim / 部分版本）。
  const flat = realToolSurfaceWithoutNames();
  flat.restrictableNames = new Set(['read', 'glob']);
  const flatPolicy = installToolPolicy({ tools: flat }, { agent: { id: 'agent-flat' } });
  assert.equal(flatPolicy.strategy, 'deny-from-known-names');
  assert.deepEqual(flatPolicy.deny, [], '两个已知名字都是只读，不需要 deny');
});

test('P1-1：真宿主 ctx 没有 .agent，必须用 setup(ctx, agent) 的 agent 本体取 view', () => {
  const agent = { id: 'agent-real-ctx' };
  const surface = realToolSurface({ names: [...REGISTERED_TOOL_NAMES], scope: agent });
  // 真宿主形状：只有 tools，没有 ctx.agent（dsh-agent-loop/lib/index.js:771-789）。
  const ctx = { tools: surface };

  const policy = installToolPolicy(ctx, { agent });
  assert.equal(policy.strategy, 'deny-from-known-names');
  assert.ok(policy.deny.includes('subagent'));
  assert.equal(surface.state.filter.deny.has('write'), true);
  assert.throws(() => surface.execute({ name: 'write', args: {}, agent }),
    (error) => error.code === 'E_TOOL_DENIED');

  policy.dispose();
});

test('P1-1：祖先层工具不在 visible 里，但 restrictableNames 含它 → 仍进 deny 且 guard 拒绝', () => {
  const agent = { id: 'agent-inherited' };
  const state = { viewScope: null, filter: null, guards: [] };
  const surface = {
    view(scope) {
      state.viewScope = scope;
      return {
        // 可见 scope 只有 global 层；祖先层（inherited）工具只能从 restrictableNames 看到。
        visible: new Map([['read', {}]]),
        restrictableNames: new Set(['read', 'send_message', 'write']),
      };
    },
    restrict(filter) {
      state.filter = filter;
      return () => {};
    },
    guard(fn) {
      state.guards.push(fn);
      return () => {};
    },
    execute(exec) {
      const guard = state.guards[state.guards.length - 1];
      if (guard) {
        const reason = guard(exec);
        if (reason) {
          const error = new Error(reason);
          error.code = 'E_TOOL_DENIED';
          throw error;
        }
      }
      return `ok:${exec.name}`;
    },
  };

  const policy = installToolPolicy({ tools: surface }, { agent });
  assert.equal(state.viewScope, agent);
  assert.ok(policy.deny.includes('send_message'), '祖先层工具必须从 restrictableNames 进入 deny');
  assert.ok(state.filter.deny.includes('send_message'));
  assert.throws(() => surface.execute({ name: 'send_message', args: {}, agent }),
    (error) => error.code === 'E_TOOL_DENIED');

  policy.dispose();
});

test('真实工具面：restrict 藏写类工具，guard 拒后注册的 spawn_router，read 放行', async () => {
  const host = createHost({
    tools: [
      tool('read', () => 'file-content'),
      tool('write', () => 'should not run'),
      tool('bash', () => 'should not run'),
    ],
  });
  const created = await host.agents.create({
    sessionId: 'policy-session',
    setup: (ctx, agent) => installToolPolicy(ctx, { agent }),
  });
  const agent = created.agent;

  const visible = [...agent.ctx.tools.view().visible.keys()];
  assert.ok(visible.includes('read'));
  assert.equal(visible.includes('write'), false);
  assert.equal(visible.includes('bash'), false);
  assert.equal(visible.includes('run_code'), true, 'run_code 无法被 restrict 命名，只能靠 guard 兜底');

  assert.equal(agent.ctx.tools.execute({ name: 'read', args: {} }), 'file-content');
  assert.throws(() => agent.ctx.tools.execute({ name: 'write', args: {} }),
    (error) => error.code === 'E_TOOL_DENIED');
  assert.throws(() => agent.ctx.tools.execute({ name: 'run_code', args: {} }),
    (error) => /PTC transport/.test(error.message));

  // 关键回归：restrict 之后才注册的工具不在 view 里，但 guard 仍必须拒绝它。
  let spawnBodyCalls = 0;
  host.register(tool('spawn_router', () => {
    spawnBodyCalls += 1;
    return 'spawned';
  }));
  assert.throws(() => agent.ctx.tools.execute({ name: 'spawn_router', args: { task: { id: 'x' } } }),
    (error) => /Router recursion/.test(error.message));
  assert.equal(spawnBodyCalls, 0);

  await created.dispose();
  assert.equal(host.agents.list().length, 0);
  assert.equal(host.toolService.scopes.size, 0);
});

test('fail-closed：setup 里 deny 名字非法时 create 失败，不发布半成品 agent', async () => {
  const host = createHost({ tools: [tool('read')] });
  await assert.rejects(
    () => host.agents.create({
      sessionId: 'bad-policy',
      setup: (ctx, agent) => installToolPolicy(ctx, { denyNames: ['subagent_*'], agent }),
    }),
    (error) => error.code === 'E_TOOL_POLICY',
  );
  assert.equal(host.agents.announcements.length, 0, 'setup 失败不得 announce');
  assert.equal(host.agents.list().length, 0);
  assert.equal(host.toolService.scopes.size, 0, '失败必须回滚所有 scoped 策略');
});

test('P0-2：runAgentTask 走 {agent, dispose}，回答从 session transcript 取', async () => {
  const agents = makeRealAgents({
    behavior: async ({ agent, input }) => {
      agent.session.messages.push({
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: input.content[0].text }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture-1' },
      });
    },
  });

  const res = await runAgentTask({ agents, prompt: 'hello-real-shape', timeoutMs: 200 });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hello-real-shape');
  assert.equal('result' in res, false, '真宿主 agent 没有 result 字段，不能编一个');
  assert.equal(res.disposed, true);
  assert.equal(res.forced, false);
  assert.equal(agents.created.length, 1);
  assert.equal(agents.created[0].followupCalls, 1);
  assert.equal(agents.list().length, 0, 'dispose 之后不能留在 list()');

  // 旧句柄形状（handle.followup）必须被显式拒绝，而不是静默 E_AGENT_IDLE。
  const legacy = {
    async create() {
      return {
        id: 'legacy-handle',
        followup: async () => {},
        whenIdle: async () => {},
        dispose: async () => {},
      };
    },
  };
  const legacyRes = await runAgentTask({ agents: legacy, prompt: 'x', timeoutMs: 50 });
  assert.equal(legacyRes.ok, false);
  assert.equal(legacyRes.code, 'E_AGENT_SHAPE');
  assert.equal(legacyRes.disposed, false);
});

test('P0-2：whenIdle 超时返回 E_AGENT_TIMEOUT，finally 仍然 dispose', async () => {
  const agents = makeRealAgents({
    behavior: async () => { await sleep(150); },
  });
  const res = await runAgentTask({ agents, prompt: 'slow', timeoutMs: 20, disposeTimeoutMs: 100 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_AGENT_TIMEOUT');
  assert.equal(res.disposed, true);
  assert.equal(agents.created[0].cancelled, 'router_abort');
  assert.equal(agents.list().length, 0);
});

test('P20：dispose 永不 resolve 时不制造僵尸——强制清理后 list()/scope 都干净', async () => {
  const agents = makeRealAgents({
    behavior: async ({ agent, input }) => {
      agent.session.messages.push({
        id: 'assistant-2',
        role: 'assistant',
        content: [{ type: 'text', text: input.content[0].text }],
        source: { kind: 'model' },
      });
    },
    disposeNever: true,
  });

  const started = Date.now();
  const res = await runAgentTask({
    agents,
    prompt: 'zombie',
    timeoutMs: 500,
    disposeTimeoutMs: 30,
  });
  const elapsed = Date.now() - started;

  assert.equal(res.ok, true);
  assert.equal(res.text, 'zombie');
  assert.equal(res.disposed, true, '超时后必须强制清理，而不是报 disposed:false 留僵尸');
  assert.equal(res.disposeTimedOut, true);
  assert.equal(res.forced, true);
  assert.ok(elapsed < 400, `dispose 超时后应立即返回（${elapsed}ms）`);
  assert.equal(agents.list().length, 0, '强制清理后 list() 不能再看见它');
  assert.equal(agents.created[0].disposed, true);
  assert.equal(agents.created[0].stuck, true, '僵尸状态必须可被观察到（曾经卡在 dispose）');
});

test('Router.runInAgent：没有 ctx.agents 时返回 E_NO_AGENTS，不抛', async () => {
  const dir = path.join(TMP, `no-agent-${process.pid}-${caseNo++}`);
  fs.mkdirSync(dir, { recursive: true });
  const r = new Router({
    queuePath: path.join(dir, 'q.jsonl'),
    auditPath: path.join(dir, 'a.jsonl'),
    llm: new MockLlm(),
  });
  const res = await r.runInAgent({ id: 't1', type: 'note', payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_NO_AGENTS');
  await r.dispose();
});

test('Router.runInAgent：真实 ctx 下明确失败路径也不挂（setup 抛错）', async () => {
  const host = createHost({ tools: [tool('read')] });
  const r = makeRouter(host);
  r.start();
  try {
    const res = await r.runInAgent(
      { id: 't-setup', type: 'note', payload: {} },
      { setup: (ctx, agent) => installToolPolicy(ctx, { denyNames: ['run_code'], agent }) },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, 'E_RUN_CODE_NOT_RESTRICTABLE');
    assert.equal(res.disposed, false);
    assert.equal(host.agents.announcements.length, 0);
  } finally {
    await r.dispose();
  }
});

// 保留 durable message 形状的直接断言：真实 createUserMessage 一定带 id。
test('fixture：durableUserMessage 与 dsh-llm createUserMessage 同形状', () => {
  const message = durableUserMessage('hi', { kind: 'router' });
  assert.equal(typeof message.id, 'string');
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(message.source, { kind: 'router' });
});
