// host-sim.mjs — 真宿主形状的最小仿真器（测试 fixture 用）
//
// 第二轮评审的核心批评：旧 sim 的「形状」是自造的，测试只能证明 sim 与
// 自己一致。这一版按宿主 checkout 里抽出的真实签名
// 重写，测试断言的都是真宿主会给出/接受的东西：
//
//   tools.view(scope) -> { visible: Map, knownNames: Set, restrictableNames: Set }
//   tools.restrict({ allow?, deny? })  // 两者都不给才报错；空 deny 合法
//   tools.register(def) 需要 output: { schema, render }
//   tools.execute({ name, args, agent, callId, signal })  // 单对象
//   agents.create(opts) -> { agent, dispose }
//   agent.followup(durableMessage) / agent.whenIdle() / agent.cancel(cause)
//   agent.status 只有 'idle' | 'running'，没有 result
//   agents.list() 返回 agent 对象（不是 handle），只含未 dispose 的
//
// 这是 fixture，不是产品代码；它刻意保留真实宿主的严格性（缺 output 报错、
// 非 durable message 报错），这样 router 一侧的脚本化才能被真正验证。

import { randomUUID } from 'node:crypto';

const RUN_CODE_NAME = 'run_code';

export class HostSimError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostSimError';
    this.code = code;
  }
}

function assert(condition, code, message) {
  if (!condition) throw new HostSimError(code, message);
}

function toNameSet(value) {
  if (value === undefined) return null;
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  throw new HostSimError('E_TOOL_RESTRICT_SHAPE', 'restrict() allow/deny must be an array or Set');
}

function validateToolDefinition(definition) {
  assert(definition && typeof definition === 'object', 'E_TOOL_DEFINITION', 'tool definition must be an object');
  assert(typeof definition.name === 'string' && definition.name.length > 0, 'E_TOOL_DEFINITION', 'tool.name is required');
  assert(definition.name !== RUN_CODE_NAME, 'E_TOOL_RESERVED', `${RUN_CODE_NAME} is reserved`);
  assert(typeof definition.execute === 'function', 'E_TOOL_DEFINITION', `tool ${definition.name} needs execute()`);
  assert(definition.output && typeof definition.output === 'object', 'E_TOOL_REGISTER_OUTPUT',
    `tool ${definition.name} must declare output: { schema, render }`);
  assert(typeof definition.output.render === 'function', 'E_TOOL_REGISTER_OUTPUT',
    `tool ${definition.name} output.render must be a function`);
}

function createSession(agent) {
  const messages = [];
  return {
    agent,
    messages,
    deriveMessages() {
      return messages.map((message) => ({ ...message }));
    },
  };
}

export class ToolService {
  constructor() {
    this.global = { tools: new Map(), restrictions: [], guards: [] };
    this.scopes = new Map();
    this.calls = [];
    this.denials = [];
    this.mode = 'ptc';
  }

  scopeOf(agent) {
    if (!agent) return this.global;
    let scope = this.scopes.get(agent);
    if (!scope) {
      scope = { agent, tools: new Map(), restrictions: [], guards: [], disposed: false };
      this.scopes.set(agent, scope);
    }
    return scope;
  }

  releaseScope(agent) {
    const scope = this.scopes.get(agent);
    if (!scope) return false;
    scope.disposed = true;
    this.scopes.delete(agent);
    return true;
  }

  register(scopeOrDefinition, maybeDefinition) {
    const definition = maybeDefinition ?? scopeOrDefinition;
    const scopeKey = maybeDefinition === undefined ? null : scopeOrDefinition;
    validateToolDefinition(definition);
    const layer = this.scopeOf(scopeKey);
    if (layer.tools.has(definition.name)) {
      throw new HostSimError('E_TOOL_DUPLICATE', `tool ${definition.name} already registered in this scope`);
    }
    layer.tools.set(definition.name, definition);
    if (scopeKey) {
      const announce = this.announce?.(definition, scopeKey);
      if (announce === false) throw new HostSimError('E_TOOL_ANNOUNCE', `announce rejected ${definition.name}`);
    }
    return () => {
      if (layer.tools.get(definition.name) === definition) layer.tools.delete(definition.name);
    };
  }

  /** 真实 view(scope)：只在这里出现 restrictableNames，而且是 Set。 */
  view(scope) {
    const layer = this.scopeOf(scope);
    const visible = new Map();
    const knownNames = new Set();
    const restrictableNames = new Set();

    for (const [name, definition] of this.global.tools) {
      knownNames.add(name);
      if (name !== RUN_CODE_NAME) restrictableNames.add(name);
      // 真宿主 view() 对继承来的工具同样要求「本 scope 的每层限制都放行」；
      // 只在 layer.tools 上应用限制会让 restrict() 藏不住全局注册的工具。
      if (this.#admits(this.global.restrictions, name) && this.#admits(layer.restrictions, name)) {
        visible.set(name, definition);
      }
    }
    for (const [name, definition] of layer.tools) {
      knownNames.add(name);
      if (this.#admits(this.global.restrictions, name) && this.#admits(layer.restrictions, name)) {
        visible.set(name, definition);
      }
    }
    if (this.mode !== 'native') {
      // 真宿主 :3071 无条件把 run_code 放进 visible（但不可 restrict）。
      visible.set(RUN_CODE_NAME, { name: RUN_CODE_NAME, builtin: true });
    }
    return { visible, knownNames, restrictableNames };
  }

  #admits(restrictions, name) {
    for (const restriction of restrictions) {
      if (restriction.allow && !restriction.allow.has(name)) return false;
      if (restriction.deny && restriction.deny.has(name)) return false;
    }
    return true;
  }

  has(name, scope) {
    return this.view(scope).visible.has(name);
  }

  restrict(scope, filter = {}) {
    const allow = toNameSet(filter.allow);
    const deny = toNameSet(filter.deny);
    // 真宿主 :2996-2999：只有 allow 和 deny 都没给才报错；空 deny/空 allow 合法。
    assert(allow !== null || deny !== null, 'E_TOOL_RESTRICT_SHAPE',
      'tools.restrict() needs allow and/or deny; an empty deny is legal but no filter is not');
    for (const name of [allow, deny]) {
      if (name?.has(RUN_CODE_NAME)) {
        throw new HostSimError('E_RUN_CODE_NOT_RESTRICTABLE', 'run_code cannot be restricted');
      }
    }
    const layer = this.scopeOf(scope);
    const known = this.view(scope).restrictableNames;
    const unknown = [...(allow ?? []), ...(deny ?? [])].filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new HostSimError('E_UNKNOWN_RESTRICT_TOOL', `unknown restrict names: ${unknown.join(', ')}`);
    }
    const compiled = { allow, deny };
    layer.restrictions.push(compiled);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const index = layer.restrictions.indexOf(compiled);
      if (index >= 0) layer.restrictions.splice(index, 1);
    };
  }

  guard(scope, guard) {
    assert(typeof guard === 'function', 'E_TOOL_GUARD', 'tools.guard() needs a function');
    const layer = this.scopeOf(scope);
    layer.guards.push(guard);
    return () => {
      const index = layer.guards.indexOf(guard);
      if (index >= 0) layer.guards.splice(index, 1);
    };
  }

  guardReason(exec) {
    for (const guard of this.global.guards) {
      const reason = guard(exec);
      if (typeof reason === 'string' && reason.length > 0) return reason;
    }
    const scope = exec?.agent ? this.scopes.get(exec.agent) : null;
    if (!scope) return undefined;
    for (let i = scope.guards.length - 1; i >= 0; i -= 1) {
      const reason = scope.guards[i](exec);
      if (typeof reason === 'string' && reason.length > 0) return reason;
    }
    return undefined;
  }

  execute(exec) {
    assert(exec && typeof exec === 'object', 'E_TOOL_EXEC_SHAPE',
      'tools.execute(exec) takes one object: { name, args, agent, callId, signal }');
    assert(typeof exec.name === 'string', 'E_TOOL_EXEC_SHAPE', 'exec.name is required');
    const scope = exec.agent ? this.scopes.get(exec.agent) : this.global;
    assert(scope, 'E_TOOL_SCOPE', 'execute() called with an agent that has no live scope');

    const definition = (exec.agent ? scope.tools.get(exec.name) : undefined) ?? this.global.tools.get(exec.name);
    this.calls.push({ name: exec.name, args: exec.args, agent: exec.agent ?? null });
    // run_code 在真宿主里是内建工具，无法 register/restrict，只能靠 guard；
    // 它不在 sim 的注册表里，所以要在 unknown 判定之前走 guard。
    if (exec.name === RUN_CODE_NAME) {
      const reason = this.guardReason(exec) ?? 'run_code is not executable through this surface';
      this.denials.push({ name: exec.name, reason });
      throw new HostSimError('E_TOOL_DENIED', reason);
    }
    if (!definition) {
      throw new HostSimError('E_TOOL_UNKNOWN', `unknown tool: ${exec.name}`);
    }
    if (!this.#admits(this.global.restrictions, exec.name) || !this.#admits(scope.restrictions, exec.name)) {
      this.denials.push({ name: exec.name, reason: 'restricted' });
      throw new HostSimError('E_TOOL_DENIED', `tool ${exec.name} is denied by tools.restrict()`);
    }
    const reason = this.guardReason(exec);
    if (typeof reason === 'string' && reason.length > 0) {
      this.denials.push({ name: exec.name, reason });
      throw new HostSimError('E_TOOL_DENIED', reason);
    }
    if (exec.signal?.aborted) {
      throw new HostSimError('E_TOOL_ABORTED', `tool ${exec.name} aborted before execution`);
    }
    return definition.execute(exec);
  }

  visibleNames(scope) {
    return [...this.view(scope).visible.keys()];
  }

  /** per-agent 门面：真宿主的 agent.ctx.tools 自动绑定到该 agent 的 scope。 */
  forAgent(agent) {
    return {
      view: (scope = agent) => this.view(scope),
      has: (name) => this.has(name, agent),
      restrict: (filter) => this.restrict(agent, filter),
      guard: (fn) => this.guard(agent, fn),
      guardReason: (exec) => this.guardReason(exec),
      register: (definition) => this.register(agent, definition),
      execute: (exec) => this.execute({ agent, ...exec }),
    };
  }
}

export class AgentService {
  constructor({ tools, logger = null } = {}) {
    this.toolService = tools;
    this.logger = logger;
    this.entries = new Map();
    this.order = [];
    this.announcements = [];
    this.behavior = null;
    this.seq = 0;
    this.disposeDelayMs = 0;
    this.disposeNever = false;
  }

  setBehavior(behavior) {
    this.behavior = behavior;
    return this;
  }

  async create({ sessionId = `sim-${++this.seq}`, agentOptions = {}, setup = null, signal = null,
    disposeDelayMs = this.disposeDelayMs, disposeNever = this.disposeNever } = {}) {
    const id = `agent-${process.pid}-${++this.seq}`;
    const agent = {
      id,
      sessionId,
      agentOptions,
      status: 'idle',
      createdAt: new Date().toISOString(),
      error: null,
      disposed: false,
      disposeState: 'idle',
      cancellation: null,
      _idleWaiters: [],
    };
    agent.session = createSession(agent);
    this.entries.set(id, agent);
    this.order.push(agent);

    const ctx = {
      agent,
      tools: this.toolService.forAgent(agent),
      logger: this.logger,
      sessions: {
        announce: (event) => {
          this.announcements.push(event);
          return event;
        },
      },
    };
    agent.ctx = ctx;

    try {
      if (typeof setup === 'function') await setup(ctx, agent);
    } catch (error) {
      agent.status = 'idle';
      agent.disposed = true;
      agent.disposeState = 'disposed';
      this.toolService.releaseScope(agent);
      throw error;
    }

    agent.followup = async (input) => {
      assert(!agent.disposed, 'E_AGENT_DISPOSED', 'agent is disposed');
      assert(input && typeof input === 'object' && typeof input.id === 'string',
        'E_MESSAGE_NOT_DURABLE', 'followup() needs a durable message with an id');
      assert(Array.isArray(input.content), 'E_MESSAGE_NOT_DURABLE', 'durable message content must be a block array');
      agent.session.messages.push(input);
      agent.status = 'running';
      this.#kick(agent, input);
    };

    agent.whenIdle = async () => {
      if (agent.status === 'idle') return;
      await new Promise((resolve) => agent._idleWaiters.push(resolve));
    };

    agent.cancel = async (cause = 'cancelled', options = {}) => {
      agent.cancellation = { cause, options };
      this.#settleIdle(agent);
      return true;
    };

    const dispose = async () => {
      if (agent.disposed) return;
      agent.disposeState = 'disposing';
      if (disposeNever) {
        // 故意挂住：用来验证调用方有超时与强制清理，而不是永远等。
        return new Promise(() => {});
      }
      if (disposeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, disposeDelayMs));
      this.#finishDispose(agent);
    };
    agent.dispose = dispose;

    const created = { agent, dispose };
    this.announcements.push({ type: 'agent.created', agentId: id, sessionId });
    return created;
  }

  #kick(agent, input) {
    const run = async () => {
      try {
        if (typeof this.behavior === 'function') {
          await this.behavior({ agent, ctx: agent.ctx, input, callTool: (exec) => agent.ctx.tools.execute(exec) });
        }
      } catch (error) {
        agent.error = { code: error?.code ?? 'E_AGENT_BEHAVIOR', message: error.message };
      } finally {
        this.#settleIdle(agent);
      }
    };
    run();
  }

  #settleIdle(agent) {
    agent.status = 'idle';
    const waiters = agent._idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  #finishDispose(agent) {
    agent.disposed = true;
    agent.disposeState = 'disposed';
    this.#settleIdle(agent);
    this.toolService.releaseScope(agent);
  }

  /** dispose 超时后的强制清理：留在 list 里只会变成不可观测的僵尸。 */
  forceDispose(agentOrId, reason = 'force_dispose') {
    const agent = typeof agentOrId === 'string' ? this.entries.get(agentOrId) : agentOrId;
    if (!agent) return { ok: false, code: 'E_AGENT_UNKNOWN' };
    if (!agent.disposed) {
      agent.disposeState = 'stuck';
      agent.stuck = true;
      this.#finishDispose(agent);
    }
    return { ok: true, agentId: agent.id, reason };
  }

  reap(reason = 'reap') {
    const stuck = [];
    for (const agent of this.entries.values()) {
      if (agent.disposeState === 'disposing') {
        this.forceDispose(agent, reason);
        stuck.push(agent.id);
      }
    }
    return { ok: true, reaped: stuck };
  }

  get(id) {
    return this.entries.get(id);
  }

  /** 真宿主 list() 返回 agent 对象本身，且只含 live agents。 */
  list() {
    return [...this.entries.values()].filter((agent) => !agent.disposed);
  }

  get scopes() {
    return this.toolService.scopes;
  }
}

/** createHost({ tools: [{ name, execute }] }) → 真形状的 tools + agents。 */
export function createHost({ tools = [], logger = null, mode = 'ptc' } = {}) {
  const toolService = new ToolService();
  toolService.mode = mode;

  for (const tool of tools) {
    toolService.register(null, {
      description: `${tool.name} tool`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => 'ok' },
      ...tool,
    });
  }

  const agents = new AgentService({ tools: toolService, logger });
  const rootTools = {
    view: (scope) => toolService.view(scope),
    gets: () => toolService.global,
    has: (name) => toolService.has(name, null),
    restrict: (filter) => toolService.restrict(null, filter),
    guard: (fn) => toolService.guard(null, fn),
    guardReason: (exec) => toolService.guardReason(exec),
    register: (definition) => toolService.register(null, definition),
    execute: (exec) => toolService.execute(exec),
  };

  return {
    tools: rootTools,
    toolService,
    agents,
    ctx: { tools: rootTools, agents },
    register: (definition) => toolService.register(null, definition),
    setBehavior: (behavior) => agents.setBehavior(behavior),
  };
}
