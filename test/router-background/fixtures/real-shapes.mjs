// test/fixtures/real-shapes.mjs — 从真宿主源码抽出的对象形状
//
// 这些 fixture 不是「另一个 sim」：字段名、类型、可调用位置都按
// 宿主 checkout 下的真实实现来：
//   - dsh-tools: view(scope).restrictableNames 是 Set；service 无该属性；
//     restrict({allow?, deny?})；execute(exec) 收单个对象
//   - dsh-agent-loop / dsh-agent: agents.create() -> { agent, dispose }；
//     agent.followup(durableMessage) / agent.whenIdle() / agent.cancel(cause)
//   - dsh-llm: createUserMessage 产出带 id 的 durable message
//
// 测试里凡是「断言 router 不依赖 sim 私有形状」的地方都用这里。

import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

/** 真实 register() 需要的完整定义（output.render 必填）。 */
export function tool(name, execute = () => `ok:${name}`) {
  return {
    name,
    description: `${name} fixture`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => 'ok' },
    execute,
  };
}

/** 与 dsh-llm createUserMessage 同形状：content 是 block 数组，且带 id。 */
export function durableUserMessage(text, source = { kind: 'user' }) {
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source,
  };
}

/**
 * tools 服务的真实表面：restrictableNames 只在 view(scope) 上，是 Set。
 * 传入 names 时会被当作「可 restrict 的已注册工具」全集（run_code 除外）。
 */
export function realToolSurface({ names = [], scope = null } = {}) {
  const known = new Set(names.filter((name) => name !== 'run_code'));
  const state = { filter: null, guards: [], calls: [], restrictCalls: 0, disposers: 0 };
  const visible = new Map(names.map((name) => [name, { name, execute: () => `ok:${name}` }]));

  const surface = {
    state,
    view(requested) {
      if (scope !== null) assert.equal(requested, scope, 'view() must be called with the agent scope');
      return {
        visible: new Map(visible),
        knownNames: new Set(names),
        restrictableNames: new Set(known),
      };
    },
    restrict(filter) {
      // 真宿主 :2996-2999：两个都不给才报错；空 deny 合法。
      assert.ok(filter && (filter.allow !== undefined || filter.deny !== undefined),
        'restrict() needs allow and/or deny');
      for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
        assert.notEqual(name, 'run_code', 'run_code cannot be named in restrict()');
        assert.ok(known.has(name), `restrict() got unknown name ${name}`);
      }
      state.restrictCalls += 1;
      state.filter = {
        allow: filter.allow === undefined ? null : new Set(filter.allow),
        deny: filter.deny === undefined ? null : new Set(filter.deny),
      };
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        state.disposers += 1;
        state.filter = null;
      };
    },
    guard(fn) {
      assert.equal(typeof fn, 'function');
      state.guards.push(fn);
      return () => {
        const index = state.guards.indexOf(fn);
        if (index >= 0) state.guards.splice(index, 1);
        state.disposers += 1;
      };
    },
    guardReason(exec) {
      for (const fn of state.guards) {
        const reason = fn(exec);
        if (typeof reason === 'string' && reason.length > 0) return reason;
      }
      return undefined;
    },
    execute(exec) {
      assert.equal(typeof exec, 'object');
      assert.equal(typeof exec.name, 'string', 'execute(exec) takes a single object with name/args/agent');
      const filter = state.filter;
      if (filter?.allow && !filter.allow.has(exec.name)) {
        throw Object.assign(new Error(`restricted: ${exec.name}`), { code: 'E_TOOL_DENIED' });
      }
      if (filter?.deny?.has(exec.name)) {
        throw Object.assign(new Error(`restricted: ${exec.name}`), { code: 'E_TOOL_DENIED' });
      }
      const reason = surface.guardReason(exec);
      if (reason) throw Object.assign(new Error(reason), { code: 'E_TOOL_DENIED' });
      state.calls.push(exec.name);
      return `ok:${exec.name}`;
    },
  };
  return surface;
}

/** 真宿主的降级形状：service 上既没有 view() 也没有 restrictableNames。 */
export function realToolSurfaceWithoutNames() {
  const state = { filter: null, guards: [], calls: [] };
  return {
    state,
    restrict(filter) {
      assert.ok(filter && (filter.allow !== undefined || filter.deny !== undefined));
      state.filter = { allow: filter.allow ?? null, deny: filter.deny ?? null };
      return () => { state.filter = null; };
    },
    guard(fn) {
      state.guards.push(fn);
      return () => {};
    },
    guardReason(exec) {
      for (const fn of state.guards) {
        const reason = fn(exec);
        if (typeof reason === 'string' && reason.length > 0) return reason;
      }
      return undefined;
    },
    execute(exec) {
      if (state.filter?.deny?.includes(exec.name)) {
        throw Object.assign(new Error(`restricted: ${exec.name}`), { code: 'E_TOOL_DENIED' });
      }
      state.calls.push(exec.name);
      return `ok:${exec.name}`;
    },
  };
}

/**
 * 真宿主 agents 服务的最小形状：create() -> { agent, dispose }。
 * agent.status 只有 idle|running；没有 result；回答从 session.deriveMessages() 取。
 */
export function makeRealAgents({ behavior = null, disposeDelayMs = 0, disposeNever = false } = {}) {
  let seq = 0;
  const entries = [];
  const announcements = [];
  const agents = {
    announcements,
    entries,
    created: [],
    createCalls: 0,
    async create({ sessionId = `real-${++seq}`, agentOptions = {}, setup = null, signal = null } = {}) {
      agents.createCalls += 1;
      const id = `real-agent-${++seq}`;
      const session = {
        messages: [],
        deriveMessages() { return this.messages.map((message) => ({ ...message })); },
      };
      const agent = {
        id,
        sessionId,
        agentOptions,
        status: 'idle',
        session,
        cancelled: null,
        followupCalls: 0,
        disposed: false,
      };
      agent.ctx = { agent, tools: null, sessions: { announce: (event) => announcements.push(event) } };

      if (typeof setup === 'function') await setup(agent.ctx, agent);

      agent.followup = async (input) => {
        assert.equal(typeof input, 'object');
        assert.equal(typeof input.id, 'string', 'followup() requires a durable message with id');
        assert.ok(Array.isArray(input.content), 'followup() requires block content');
        agent.followupCalls += 1;
        agent.status = 'running';
        session.messages.push(input);
        try {
          if (typeof behavior === 'function') await behavior({ agent, ctx: agent.ctx, input });
        } finally {
          agent.status = 'idle';
        }
        return undefined;
      };
      agent.whenIdle = async () => {
        while (agent.status !== 'idle') await new Promise((resolve) => setTimeout(resolve, 1));
      };
      agent.cancel = async (cause = 'cancelled') => {
        agent.cancelled = cause;
        agent.status = 'idle';
        return true;
      };

      const dispose = async () => {
        if (agent.disposed) return;
        if (disposeNever) return new Promise(() => {});
        if (disposeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, disposeDelayMs));
        agents.finish(agent);
      };

      agents.created.push(agent);
      announcements.push({ type: 'agent.created', agentId: id });
      return { agent, dispose };
    },
    finish(agent) {
      agent.disposed = true;
      agent.status = 'idle';
    },
    forceDispose(agentOrId) {
      const agent = typeof agentOrId === 'string'
        ? agents.created.find((item) => item.id === agentOrId)
        : agentOrId;
      if (!agent) return { ok: false, code: 'E_AGENT_UNKNOWN' };
      // 和 host-sim 一样留下可观察的痕迹：调用方要能看见「它曾经卡在 dispose」。
      agent.stuck = true;
      agents.finish(agent);
      return { ok: true, agentId: agent.id };
    },
    reap() {
      const reaped = [];
      for (const agent of agents.created) {
        if (!agent.disposed) {
          agents.finish(agent);
          reaped.push(agent.id);
        }
      }
      return { ok: true, reaped };
    },
    get(id) { return agents.created.find((agent) => agent.id === id); },
    list() { return agents.created.filter((agent) => !agent.disposed); },
  };
  return agents;
}
