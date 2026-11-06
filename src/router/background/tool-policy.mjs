// tool-policy.mjs — 后台 agent 的工具面：restrict 精确名字 + guard 同步 fail-closed
//
// 依据宿主 dsh-tools 的真实语义（_hostsrc/dsh-tools/lib/index.js）：
//   - restrict() 接受 { allow?, deny? } 两个可选集合；两个都不给才抛错
//     （:2992-2994），空 deny 是合法的；名字会先编译成 Set。
//   - 名字必须是「可 restrict 的已注册工具」；未知名字抛错（:3002-3004），
//     run_code 明确禁止出现在 allow/deny 里（:2997-3000）。
//   - 可 restrict 的名字在 view(scope).restrictableNames 上，而且是 **Set**，
//     不是 tools 服务上的数组属性（:3051-3077）。service 本身没有
//     `restrictableNames`。
//   - guard() 是同步检查，返回字符串即拒绝；全局 guard 先跑，然后 agent 链
//     由远及近（guardReason :3020-3028）。
//
// 红队 P0-1 的教训：旧实现要求 `Array.isArray(tools.restrictableNames)`，
// 在真宿主上 100% 抛 E_TOOL_SURFACE。现在的顺序是：
//   1. 优先从 view(scope).restrictableNames（Set）枚举；
//   2. 退回旧形状的 service.restrictableNames（Array 或 Set）；
//   3. 两者都没有（或 view 不可用）时不再自己枚举，直接 restrict({allow})
//      —— 宿主会在内部按 known 集合校验，未知名字照样抛错；
// 无论哪条路都保留 guard 作为第二层（run_code / 未来新增写类工具 fail-closed）。

/** 从 _hostsrc 各 dsh-tool-* 包实际 dump 到的注册名（见 tools/asar-index.txt）。 */
export const REGISTERED_TOOL_NAMES = Object.freeze([
  // filesystem
  'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'str_replace_editor',
  // shell / terminal
  'bash', 'pwsh', 'terminal_open', 'terminal_send', 'terminal_read',
  'terminal_signal', 'terminal_close', 'terminal_list',
  // jobs
  'job_output', 'job_list', 'job_kill',
  // delegation / control
  'subagent', 'list_subagent_models', 'send_message', 'interrupt_agent',
  'workflow', 'ralph',
  // schedule
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
  // introspection / session
  'cordis_inspect_list', 'cordis_inspect_query',
  'session_search', 'session_event_search', 'session_trace',
  'session_event_trace', 'session_event_read',
  // misc
  'ask_user_question', 'get_goal', 'create_goal', 'update_goal', 'present',
  'working_directory', 'load_workspace_dependencies', 'todo_write', 'skill',
  'web_search', 'web_fetch',
  // reserved PTC transport (cannot be named in restrict)
  'run_code',
]);

/** 后台 agent 唯一允许的工具：只读、无副作用。 */
export const READ_ONLY_TOOL_ALLOWLIST = Object.freeze(['read', 'glob', 'grep', 'read_image']);

/**
 * 文档/测试用的静态 deny 列表：所有真实注册名 - 只读白名单 - run_code。
 * 运行时优先从 view(scope) 动态算；此表用于核对策略覆盖。
 */
export const RESTRICT_DENY = Object.freeze(
  REGISTERED_TOOL_NAMES.filter(
    (name) => name !== 'run_code' && !READ_ONLY_TOOL_ALLOWLIST.includes(name),
  ),
);

const SPAWN_NAMES = new Set(['subagent', 'send_message', 'interrupt_agent', 'workflow', 'ralph']);
const SHELL_NAMES = new Set(['bash', 'pwsh']);
const FS_WRITE_NAMES = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch', 'multi_edit']);

/** 精确名字 -> 拒绝原因；未知名字一律落到 not_allowlisted（fail-closed）。 */
export function denyReason(name) {
  if (typeof name !== 'string' || name.length === 0) return 'tool_denied: missing tool name';
  if (SPAWN_NAMES.has(name) || name.startsWith('subagent_') || name.startsWith('worker_') || name === 'list_agents') {
    return `tool_denied: "${name}" is a delegation/recursion tool; background agents may not spawn or control agents`;
  }
  if (name === 'run_code') {
    return 'tool_denied: "run_code" is the PTC transport and can execute arbitrary code; never available to a background agent';
  }
  if (SHELL_NAMES.has(name) || name.startsWith('terminal_')) {
    return `tool_denied: "${name}" is a shell/terminal tool; background agents are not allowed to execute commands`;
  }
  if (FS_WRITE_NAMES.has(name)) {
    return `tool_denied: "${name}" writes the filesystem; background agents are read-only`;
  }
  if (name.startsWith('schedule_')) {
    return `tool_denied: "${name}" mutates persistent schedules; background agents may not schedule work`;
  }
  if (name === 'spawn_router' || name === 'router.spawn' || name === 'router.start') {
    return `tool_denied: "${name}" is a Router recursion entry point`;
  }
  if (name === 'queue_append' || name === 'router_enqueue' || name === 'queue_write') {
    return `tool_denied: "${name}" writes the trusted task queue`;
  }
  return `tool_denied: "${name}" is not in the fail-closed read-only allowlist`;
}

/**
 * 同步 guard 判定。返回字符串 = 拒绝；undefined = 允许。
 * exec 形状按 dsh-tools createExecution：{ name, agent?, ... }。
 */
export function guardReason(exec, { allowedTools = READ_ONLY_TOOL_ALLOWLIST, agentId = null } = {}) {
  if (!exec || typeof exec.name !== 'string' || exec.name.length === 0) {
    return 'tool_denied: execution has no tool name';
  }
  if (agentId && exec.agent && exec.agent.id !== agentId) return undefined;
  if (allowedTools.includes(exec.name)) return undefined;
  return denyReason(exec.name);
}

/** 把 Set / Array / 其它 iterable 统一成 Set；不可迭代返回 null。 */
export function toNameSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    try { return new Set(value); } catch { return null; }
  }
  return null;
}

/**
 * 解析「哪些名字可以被 restrict」。真实宿主只有 view(scope).restrictableNames
 * （Set）；为了兼容旧 host-sim 与降级场景，也接受 service 上的 Array/Set。
 *
 * @returns {{names: Set<string>|null, source: string, view: object|null}}
 */
export function resolveRestrictableView(tools, agentCtx, agent = null) {
  if (typeof tools?.view === 'function') {
    // 真宿主的 agent.ctx 上没有 .agent（dsh-agent-loop/lib/index.js:771-789），
    // scope 必须显式传 agent 本体；只有旧 host-sim / 测试才把 agent 挂在 ctx 上。
    const scope = agent ?? agentCtx?.agent ?? agentCtx;
    let view = null;
    try {
      view = tools.view(scope);
    } catch {
      view = null;
    }
    if (view) {
      const names = toNameSet(view.restrictableNames);
      if (names) return { names, source: 'view.restrictableNames', view };
      const visible = view.visible instanceof Map
        ? view.visible.keys()
        : (view.visible && typeof view.visible.keys === 'function' ? view.visible.keys() : null);
      const fallback = toNameSet(visible);
      if (fallback) return { names: fallback, source: 'view.visible', view };
    }
  }
  const direct = toNameSet(tools?.restrictableNames);
  if (direct) return { names: direct, source: 'service.restrictableNames', view: null };
  return { names: null, source: 'none', view: null };
}

/** 显式 deny 列表的 fail-closed 校验：未知名字 / 通配符 / run_code 都抛。 */
export function validateDenyNames(denyNames, knownNames = null) {
  if (!Array.isArray(denyNames)) {
    const error = new Error('E_TOOL_POLICY: denyNames must be an array');
    error.code = 'E_TOOL_POLICY';
    throw error;
  }
  const known = knownNames instanceof Set ? knownNames : toNameSet(knownNames);
  for (const name of denyNames) {
    if (typeof name !== 'string' || name.length === 0) {
      const error = new Error('E_TOOL_POLICY: denyNames entries must be non-empty strings');
      error.code = 'E_TOOL_POLICY';
      throw error;
    }
    if (name.includes('*')) {
      const error = new Error(`E_TOOL_POLICY: wildcard "${name}" is not an exact registered tool name`);
      error.code = 'E_TOOL_POLICY';
      throw error;
    }
    if (name === 'run_code') {
      const error = new Error('E_TOOL_POLICY: run_code cannot be named in tools.restrict()');
      error.code = 'E_RUN_CODE_NOT_RESTRICTABLE';
      throw error;
    }
    // 拿不到 known 集合时只校验形状；宿主 restrict() 自己会拒绝未知名字。
    if (known && !known.has(name)) {
      const error = new Error(`E_UNKNOWN_RESTRICT_TOOL: "${name}" is not registered`);
      error.code = 'E_UNKNOWN_RESTRICT_TOOL';
      throw error;
    }
  }
}

/**
 * 在后台 agent 的 scoped ctx 上安装 restrict + guard。
 * setup 抛错 -> agents.create() 失败（fail-closed），不会带着半套权限发布 agent。
 *
 * @param {object} agentCtx 宿主 agent ctx（含 tools、agent）
 * @param {object} [options]
 * @param {string[]} [options.allowedTools]
 * @param {string[]} [options.denyNames] 显式 deny 列表；会先做精确名字校验
 * @param {object} [options.agent] 宿主 agent 本体（setup(ctx, agent) 的第二个参数）；
 *   真宿主 ctx 上没有 .agent，必须显式传，否则 view(scope) 解析不到 inherited 工具
 * @returns {{deny:string[], allow:string[]|null, strategy:string, known:string[]|null, dispose:()=>void}}
 */
export function installToolPolicy(agentCtx, {
  allowedTools = READ_ONLY_TOOL_ALLOWLIST,
  denyNames = null,
  agent = null,
} = {}) {
  const tools = agentCtx?.tools;
  if (!tools || typeof tools.restrict !== 'function' || typeof tools.guard !== 'function') {
    const error = new Error('E_TOOL_SURFACE: agent ctx has no tools.restrict()/guard()');
    error.code = 'E_TOOL_SURFACE';
    throw error;
  }

  const surface = resolveRestrictableView(tools, agentCtx, agent);
  let deny = [];
  let allow = null;
  let strategy;

  if (denyNames !== null) {
    validateDenyNames(denyNames, surface.names);
    deny = [...denyNames];
    strategy = 'explicit-deny';
  } else if (surface.names && surface.names.size > 0) {
    const allowed = new Set(allowedTools);
    // run_code 不可被 restrict 命名；留给 guard 拒绝。
    deny = [...surface.names].filter((name) => name !== 'run_code' && !allowed.has(name));
    strategy = 'deny-from-known-names';
  } else {
    // 拿不到可 restrict 名字集合：把策略交给宿主的 allow 过滤器。
    // 真宿主 restrict({allow}) 会拒绝 allow 里的未知名字，等价于 fail-closed。
    allow = [...allowedTools];
    strategy = 'allow-filter';
  }

  const filter = strategy === 'allow-filter'
    ? { allow }
    : (deny.length > 0 ? { deny } : null);

  let disposeRestrict = null;
  let disposeGuard = null;
  let disposed = false;
  try {
    if (filter) disposeRestrict = tools.restrict(filter);
    const agentId = agent?.id ?? agentCtx?.agent?.id ?? null;
    disposeGuard = tools.guard((exec) => guardReason(exec, { allowedTools, agentId }));
  } catch (error) {
    // 半套策略绝不能留下：任何一步失败都回滚并让 create() 失败。
    try { disposeGuard?.(); } catch { /* ignore */ }
    try { disposeRestrict?.(); } catch { /* ignore */ }
    throw error;
  }

  return {
    deny,
    allow,
    strategy,
    known: surface.names ? [...surface.names] : null,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeGuard?.();
      disposeRestrict?.();
    },
  };
}
