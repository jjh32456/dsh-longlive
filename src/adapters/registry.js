/**
 * 第三方插件适配器注册表（M2-E 解耦的唯一核心入口）
 *
 * 设计：核心代码不 import 任何第三方包、不出现第三方包名/工具名/动作名字面量；
 * 所有第三方接触面（包名、工具名、动作名、规则/别名/策略片段、注入标记）都由
 * adapter 提供，核心经本 registry 取用。适配器缺席/数据损坏时一律 fail-safe：
 * 核心照常运行 + 显式 degraded 记录，不抛错、不阻塞。
 *
 * 统一接口（每个 adapter 必须提供）：
 *   { id, probe, call, health, mode }
 * 可选：loadData(kind) → { ok, data, error }
 *
 * 新增第三方插件 = 在 adapters/<id>/ 实现接口 + 在 createDefaultRegistry() 里注册，
 * 并先登记到 scripts/lint-plugin-independence.mjs。
 */
import { createEngramAdapter } from './engram/index.js'

export const ADAPTER_REGISTRY_VERSION = 1

function safeCall(fn, fallback) {
  try {
    return typeof fn === 'function' ? fn() : fallback
  } catch (cause) {
    return fallback
  }
}

/**
 * 创建一个独立 registry（测试用；生产用默认 registry）。
 * @param {Array<object>} adapters
 */
export function createAdapterRegistry(adapters = []) {
  const entries = new Map()
  const problems = []

  const registry = {
    register(adapter) {
      if (!adapter || typeof adapter.id !== 'string' || !adapter.id.trim()) {
        problems.push({ code: 'E_ADAPTER_INVALID', message: 'adapter 缺 id，忽略' })
        return false
      }
      if (entries.has(adapter.id)) {
        problems.push({ code: 'E_ADAPTER_DUPLICATE', message: `adapter id 重复：${adapter.id}` })
        return false
      }
      entries.set(adapter.id, adapter)
      return true
    },
    get(id) {
      return entries.get(id) || null
    },
    list() {
      return [...entries.values()]
    },
    ids() {
      return [...entries.keys()]
    },
    /** 探测全部 adapter，返回 { modes, degraded, problems }；单个 adapter 抛错不影响整体。 */
    probeAll(options = {}) {
      const modes = {}
      const adapterProblems = []
      for (const adapter of entries.values()) {
        const result = safeCall(() => adapter.probe(options), { ok: false, mode: 'absent', evidence: [], error: { code: 'E_ADAPTER_PROBE' } })
        modes[adapter.id] = result && result.mode ? result.mode : 'absent'
        if (result && result.error) adapterProblems.push({ adapter: adapter.id, ...result.error })
      }
      return {
        modes,
        degraded: Object.values(modes).some((mode) => mode !== 'active'),
        problems: [...adapterProblems],
      }
    },
    /** 汇总 health；供 doctor/lint 输出。 */
    healthAll(options = {}) {
      const rows = []
      for (const adapter of entries.values()) {
        const health = safeCall(() => adapter.health(options), { id: adapter.id, mode: 'absent', degraded: true, detail: 'health() 异常' })
        rows.push({ id: adapter.id, mode: health.mode || 'absent', ok: health.ok === true, degraded: health.degraded !== false, detail: health.detail || '' })
      }
      return { ok: rows.every((row) => row.ok), rows, problems: [...problems] }
    },
    /** 经适配器转发一次调用；adapter 缺席时返回降级结果。 */
    call(id, request) {
      const adapter = entries.get(id)
      if (!adapter) {
        return { ok: false, degraded: true, mode: 'absent', code: 'E_ADAPTER_UNKNOWN', message: `未注册的 adapter：${String(id)}` }
      }
      return safeCall(() => adapter.call(request), { ok: false, degraded: true, mode: 'absent', code: 'E_ADAPTER_CALL', message: 'adapter.call 异常' })
    },
    /** 合并各 adapter 的某类数据；失败仅记录 + degraded，不抛错。 */
    loadData(kind) {
      const items = []
      const errors = []
      const sources = []
      for (const adapter of entries.values()) {
        if (typeof adapter.loadData !== 'function') continue
        const result = safeCall(() => adapter.loadData(kind), { ok: false, error: { code: 'E_ADAPTER_DATA', message: `adapter ${adapter.id} loadData 异常` } })
        if (!result || !result.ok) {
          errors.push({ adapter: adapter.id, kind, code: (result && result.error && result.error.code) || 'E_ADAPTER_DATA', message: (result && result.error && result.error.message) || 'adapter 数据不可用' })
          continue
        }
        items.push({ adapter: adapter.id, data: result.data, text: result.text || '', sourcePath: result.sourcePath || '' })
        sources.push(adapter.id)
      }
      return { ok: errors.length === 0, items, sources, errors, degraded: errors.length > 0 }
    },
    problems,
  }

  for (const adapter of adapters) registry.register(adapter)
  return registry
}

/** 生产默认 registry：engram 是当前唯一样例；其它第三方插件只登记、不建 adapter。 */
export function createDefaultRegistry() {
  return createAdapterRegistry([createEngramAdapter()])
}

export const defaultRegistry = createDefaultRegistry()

// ── 核心取用面（全部是中性命名，不含第三方字面量） ──────────────────────

export function adapterHealth() {
  return defaultRegistry.healthAll()
}

export function adapterModes() {
  return defaultRegistry.probeAll().modes
}

export function adapterEntries() {
  return defaultRegistry.list().map((adapter) => ({ id: adapter.id, mode: safeCall(() => adapter.mode, 'absent') }))
}

export function adapterCall(id, request) {
  return defaultRegistry.call(id, request)
}

/** 合并 adapter 提供的路由规则（保留 adapter 侧 _order 以复原原表顺序）。 */
export function loadAdapterRoutingRules() {
  const loaded = defaultRegistry.loadData('routing-rules')
  const rules = []
  const targets = []
  const errors = []
  for (const item of loaded.items) {
    const data = item.data || {}
    if (Array.isArray(data.rules)) rules.push(...data.rules)
    if (Array.isArray(data.targets)) targets.push(...data.targets)
  }
  errors.push(...loaded.errors)
  return { ok: errors.length === 0, rules, targets, items: loaded.items, errors, degraded: errors.length > 0 }
}

/** 合并 adapter 提供的动作别名。 */
export function loadAdapterAliases() {
  const loaded = defaultRegistry.loadData('aliases')
  const actions = []
  const errors = [...loaded.errors]
  for (const item of loaded.items) {
    const data = item.data || {}
    if (Array.isArray(data.actions)) actions.push(...data.actions)
  }
  return { ok: errors.length === 0, actions, errors, degraded: errors.length > 0 }
}

/** 把 adapter 的策略片段（forbiddenActions / allowPrefixes）并入一份已校验的 profile。 */
export function applyAdapterPolicy(policy) {
  const loaded = defaultRegistry.loadData('policy')
  if (!loaded.ok || typeof policy !== 'object' || policy === null) {
    return { policy, degraded: !loaded.ok, errors: loaded.errors }
  }
  const next = JSON.parse(JSON.stringify(policy))
  const forbidden = new Set(next.rest && Array.isArray(next.rest.forbiddenActions) ? next.rest.forbiddenActions : [])
  const allowed = new Set(next.writeScope && Array.isArray(next.writeScope.allowPrefixes) ? next.writeScope.allowPrefixes : [])
  for (const item of loaded.items) {
    const data = item.data || {}
    for (const action of Array.isArray(data.forbiddenActions) ? data.forbiddenActions : []) forbidden.add(action)
    for (const prefix of Array.isArray(data.allowPrefixes) ? data.allowPrefixes : []) allowed.add(prefix)
  }
  if (next.rest) next.rest.forbiddenActions = [...forbidden]
  if (next.writeScope) next.writeScope.allowPrefixes = [...allowed]
  return { policy: next, degraded: false, errors: [] }
}

export function optionalPeerNames() {
  return defaultRegistry.list().map((adapter) => adapter.packageName).filter((name) => typeof name === 'string' && name.trim())
}

export function interceptedToolNames() {
  const names = []
  for (const adapter of defaultRegistry.list()) {
    const constants = adapter.constants || {}
    for (const name of constants.INTERCEPTED_WRITE_TOOLS || []) names.push(name)
    for (const name of constants.LEGACY_TOOL_NAMES || []) names.push(name)
  }
  return [...new Set(names)]
}

export function classificationPluginLabels() {
  return defaultRegistry.list().map((adapter) => adapter.constants && adapter.constants.CLASSIFY_PLUGIN_LABEL).filter(Boolean)
}

export function injectedMarkerPatterns() {
  const patterns = []
  for (const adapter of defaultRegistry.list()) {
    for (const pattern of (adapter.constants && adapter.constants.SESSION_MARKER_PATTERNS) || []) patterns.push(pattern)
  }
  return patterns
}

export function pluginEvidencePrefixes() {
  return defaultRegistry.list().map((adapter) => adapter.constants && adapter.constants.EVIDENCE_PREFIX).filter((prefix) => typeof prefix === 'string' && prefix)
}

// ── 语义判定（核心不关心是哪家插件） ────────────────────────────────

function externalActions() {
  return defaultRegistry.list().flatMap((adapter) => (adapter.constants && adapter.constants.ACTION_NAMES) || [])
}

export function isExternalMemoryAction(action) {
  if (typeof action !== 'string') return false
  const trimmed = action.trim()
  if (!trimmed) return false
  return externalActions().some((name) => trimmed === name) || defaultRegistry.list().some((adapter) => {
    const prefix = adapter.constants && adapter.constants.ACTION_PREFIX
    return typeof prefix === 'string' && prefix && trimmed.startsWith(prefix)
  })
}

export function isExternalMemoryTarget(target) {
  if (typeof target !== 'string') return false
  const trimmed = target.trim()
  return defaultRegistry.list().some((adapter) => trimmed === adapter.id)
}

export function isExternalMemoryTool(toolName) {
  if (typeof toolName !== 'string') return false
  const trimmed = toolName.trim()
  return defaultRegistry.list().some((adapter) => {
    const constants = adapter.constants || {}
    if ((constants.LEGACY_TOOL_NAMES || []).includes(trimmed)) return true
    const prefix = constants.TOOL_PREFIX
    return typeof prefix === 'string' && prefix && trimmed.startsWith(prefix)
  })
}

export function isExternalMemoryKind(kind) {
  if (typeof kind !== 'string') return false
  return defaultRegistry.list().some((adapter) => kind.includes(adapter.id))
}

/** 按语义分组取第三方动作名（approval/write/profileEdit 等，由 adapter 声明）。 */
export function externalActionGroups(group) {
  const out = []
  for (const adapter of defaultRegistry.list()) {
    const groups = adapter.constants && adapter.constants.ACTION_GROUPS
    if (groups && Array.isArray(groups[group])) out.push(...groups[group])
  }
  return [...new Set(out)]
}

export function planExternalAction(action) {
  for (const adapter of defaultRegistry.list()) {
    if (typeof adapter.plan !== 'function') continue
    const result = safeCall(() => adapter.plan(action), { ok: false, degraded: true, code: 'E_ADAPTER_PLAN' })
    if (result && result.code !== 'E_ADAPTER_ACTION') return { ...result, adapter: adapter.id }
  }
  return { ok: false, degraded: false, code: 'E_ADAPTER_UNKNOWN_ACTION', action }
}

export function externalProfileEditAction() {
  return externalActionGroups('profileEdit')[0] || null
}

export function externalLegacyToolNames() {
  const out = []
  for (const adapter of defaultRegistry.list()) {
    const constants = adapter.constants || {}
    out.push(...(constants.LEGACY_TOOL_NAMES || []))
  }
  return [...new Set(out)]
}

export function externalWriteToolNames() {
  const out = []
  for (const adapter of defaultRegistry.list()) {
    const constants = adapter.constants || {}
    out.push(...(constants.WRITE_TOOL_NAMES || []))
  }
  return [...new Set(out)]
}

export function externalLegacyWriteToolNames() {
  const out = []
  for (const adapter of defaultRegistry.list()) {
    const constants = adapter.constants || {}
    out.push(...(constants.LEGACY_WRITE_TOOL_NAMES || []))
  }
  return [...new Set(out)]
}

export function isExternalMemoryProfileEdit(action) {
  return defaultRegistry.list().some((adapter) => {
    const constants = adapter.constants || {}
    return (constants.ACTION_NAMES || []).includes(action) && action.endsWith('.profile.edit')
  })
}

export function isExternalMemoryDeleteAction(action) {
  return defaultRegistry.list().some((adapter) => {
    const constants = adapter.constants || {}
    return (constants.ACTION_NAMES || []).includes(action) && action.endsWith('.forget')
  })
}
