/**
 * engram 适配器（M2-E 解耦样板）
 *
 * 核心代码只通过 src/adapters/registry.js 使用本模块；本目录是唯一允许出现
 * 第三方插件（engram）包名/工具名/动作名/注入标记字面量的地方。
 *
 * 统一接口：{ id, probe, call, health, mode }
 * - probe():  探测宿主是否提供 engram 能力（按宿主传入的工具清单/显式 mode），返回 { ok, mode, evidence }
 * - call():   经宿主 invoke 转发一次 engram 工具调用；adapter 缺席时返回降级结果，不抛错
 * - health(): { id, mode, ok, degraded, detail }，供 doctor/lint/registry 汇总
 * - mode:     'active' | 'degraded' | 'absent'
 */
import { readFileSync } from 'node:fs'

export const ID = 'engram'
export const PACKAGE_NAME = '@kenz1117/dsh-engram'
export const ACTION_PREFIX = 'engram.'
export const TOOL_PREFIX = 'engram_'
export const PROFILE_EDIT_ACTION = 'engram.profile.edit'
export const FORGET_ACTION = 'engram.forget'
export const SAVE_ACTION = 'engram.save'
export const FACTS_REPLACE_ACTION = 'engram.facts.replace'
export const CLASSIFY_PLUGIN_LABEL = 'plugin:dsh-engram'
export const EVIDENCE_PREFIX = 'engram:'
/**
 * Support matrix for the external engram plugin. Deliberately version-agnostic
 * at the tool boundary: 0.11–0.13.9 all expose the same engram_* namespace and
 * the same injection markers, so probe/degrade behavior is shared. The matrix
 * is evidence, not a runtime semver gate.
 */
export const SUPPORTED_ENGRAM_VERSIONS = Object.freeze({
  min: '0.11.0',
  max: '0.13.9',
  tested: ['0.13.6', '0.13.9'],
  optionalEmbeddingFrom: '0.13.9',
  markerNames: ['engram_profile', 'engram_memory_context', 'engram_selection_rationale'],
  embeddingWarningCodes: ['core.warnEmbedderUnavailable', 'vectors-missing'],
  note: '0.13.9 moves transformers.js/onnxruntime to optionalDependencies; missing embeddings do not remove tools and do not degrade file memory.',
})
export const LEGACY_TOOL_NAMES = Object.freeze(['memory_save'])
export const INTERCEPTED_WRITE_TOOLS = Object.freeze([
  'engram_save',
  'engram_update',
  'engram_facts',
  'engram_forget',
  'engram_profile_edit',
])
export const ACTION_NAMES = Object.freeze([
  'engram.search',
  'engram.save',
  'engram.facts.replace',
  'engram.forget',
  'engram.profile.edit',
])
export const LEGACY_WRITE_TOOL_NAMES = Object.freeze(['memory_save'])
export const WRITE_TOOL_NAMES = Object.freeze(['memory_save', 'engram_save', 'engram_update', 'engram_facts', 'engram_forget', 'engram_profile_edit'])
export const ACTION_GROUPS = Object.freeze({
  approval: ['engram.forget'],
  write: ['engram.save', 'engram.facts.replace'],
  profileEdit: ['engram.profile.edit'],
})
export const DEGRADE_TARGETS = Object.freeze({
  'engram.search': 'live',
  'engram.save': 'topics',
  'engram.facts.replace': 'topics',
  'engram.forget': 'topics',
  'engram.profile.edit': 'topics',
})
export const SESSION_MARKER_PATTERNS = Object.freeze([
  /<engram_profile\b/i,
  /<engram_memory_context\b/i,
  /<engram_selection_rationale\b/i,
])

const DATA_FILES = Object.freeze({
  'routing-rules': { url: new URL('./data/routing-rules.json', import.meta.url), sourcePath: 'src/adapters/engram/data/routing-rules.json' },
  aliases: { url: new URL('./data/aliases.json', import.meta.url), sourcePath: 'src/adapters/engram/data/aliases.json' },
  policy: { url: new URL('./data/policy.json', import.meta.url), sourcePath: 'src/adapters/engram/data/policy.json' },
})
const dataCache = new Map()

/**
 * 读取 adapter 数据文件；缺失/坏 JSON 一律 fail-safe：返回 ok:false + 错误记录，
 * 由调用方（registry/核心 loader）降级继续跑，不抛错。
 */
export function loadData(kind) {
  if (dataCache.has(kind)) return dataCache.get(kind)
  const entry = DATA_FILES[kind]
  let result
  if (!entry) {
    result = { ok: false, kind, data: null, text: '', sourcePath: '', error: { code: 'E_ADAPTER_DATA_UNKNOWN', message: `未知 adapter 数据：${String(kind)}` } }
  } else {
    try {
      const text = readFileSync(entry.url, 'utf8')
      result = { ok: true, kind, data: JSON.parse(text), text, sourcePath: entry.sourcePath, error: null }
    } catch (cause) {
      result = {
        ok: false,
        kind,
        data: null,
        text: '',
        sourcePath: entry.sourcePath,
        error: {
          code: cause && cause.code === 'ENOENT' ? 'E_ADAPTER_DATA_MISSING' : 'E_ADAPTER_DATA_INVALID',
          message: `${kind} 数据不可用：${cause && cause.message ? cause.message : String(cause)}`,
        },
      }
    }
  }
  dataCache.set(kind, result)
  return result
}

export function resetDataCacheForTests() {
  dataCache.clear()
}

export function isEngramToolName(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (!trimmed) return false
  return trimmed.startsWith(TOOL_PREFIX) || LEGACY_TOOL_NAMES.includes(trimmed)
}

export function isEngramActionName(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  return trimmed.startsWith(ACTION_PREFIX) || trimmed.startsWith(TOOL_PREFIX)
}

function normalizeMode(value) {
  return value === 'active' || value === 'degraded' || value === 'absent' ? value : null
}

function normalizeEmbeddingStatus(value) {
  if (typeof value === 'function') {
    try { return normalizeEmbeddingStatus(value()); } catch { return normalizeEmbeddingStatus(null); }
  }
  if (!value || typeof value !== 'object') {
    return { available: true, vectors: 'unknown', warnings: [], optional: true };
  }
  const warnings = Array.isArray(value.warnings) ? value.warnings.map(String) : [];
  const vectors = typeof value.vectors === 'string' ? value.vectors : (value.available === false ? 'missing' : 'unknown');
  return {
    available: value.available !== false && vectors !== 'missing',
    vectors,
    warnings,
    optional: true,
  };
}

/**
 * @param {object} [options]
 * @param {() => string[]} [options.tools] 宿主可用工具名列表（探测依据，不 import 第三方）
 * @param {string} [options.mode] 显式覆盖 mode（测试/配置用）
 * @param {(tool: string, args: object) => any} [options.invoke] 宿主工具调用通道
 * @param {() => any} [options.afterProbe]
 * @param {object|(() => object)} [options.embeddingStatus] 0.13.9 optional embedding 状态
 */
export function createEngramAdapter(options = {}) {
  const toolsProvider = typeof options.tools === 'function' ? options.tools : () => (Array.isArray(options.tools) ? options.tools : [])
  const invoke = typeof options.invoke === 'function' ? options.invoke : null
  const forcedMode = normalizeMode(options.mode)
  let last = null

  function probe() {
    if (forcedMode) {
      last = { ok: forcedMode !== 'absent', mode: forcedMode, evidence: ['explicit-mode'], at: null }
      return last
    }
    let tools = []
    try {
      const value = toolsProvider()
      tools = Array.isArray(value) ? value : []
    } catch {
      tools = []
    }
    const hits = tools.filter(isEngramToolName)
    const mode = hits.length > 0 ? 'active' : 'absent'
    last = { ok: mode === 'active', mode, evidence: hits.slice(0, 8), at: null }
    return last
  }

  function health() {
    const state = last || probe()
    const embedding = normalizeEmbeddingStatus(options.embeddingStatus)
    return {
      id: ID,
      mode: state.mode,
      ok: state.mode !== 'absent',
      degraded: state.mode === 'degraded' || state.mode === 'absent',
      detail: state.mode === 'absent' ? '未探测到 engram 工具，降级为文件记忆（topics/journal）' : state.mode === 'degraded' ? 'engram 部分能力不可用' : 'engram 可用',
      evidence: state.evidence.slice(),
      supportedVersions: SUPPORTED_ENGRAM_VERSIONS,
      embedding: {
        ...embedding,
        // Missing vectors are an optional capability warning, not an adapter
        // degradation: engram_* tools and file memory still work.
        warningVisible: embedding.available === false || embedding.warnings.some((w) => SUPPORTED_ENGRAM_VERSIONS.embeddingWarningCodes.some((code) => w.includes(code))),
      },
    }
  }

  /** 动作级降级计划：插件缺席时给出降级目标与 degraded 标记，不抛错。 */
  function plan(actionName) {
    if (!isEngramActionName(actionName)) {
      return { ok: false, degraded: false, code: 'E_ADAPTER_ACTION', action: actionName }
    }
    const state = last || probe()
    if (state.mode === 'active') {
      return { ok: true, degraded: false, mode: state.mode, target: ID, action: actionName }
    }
    return {
      ok: false,
      degraded: true,
      mode: state.mode,
      target: DEGRADE_TARGETS[actionName] || 'topics',
      action: 'topics.write',
      fallback: 'file-memory',
      message: '外部记忆插件不可用：该动作降级到文件记忆（topics/journal），不阻塞',
    }
  }

  function call(request = {}) {
    const tool = typeof request.tool === 'string' ? request.tool : ''
    if (!isEngramToolName(tool)) {
      return { ok: false, degraded: false, code: 'E_ADAPTER_TOOL', message: `不是 engram 工具：${tool}` }
    }
    const state = last || probe()
    if (state.mode === 'absent') {
      return {
        ok: false,
        degraded: true,
        mode: 'absent',
        code: 'E_ADAPTER_ABSENT',
        tool,
        fallbackTarget: 'topics',
        message: 'engram 不可用：降级到文件记忆（topics/journal），不阻塞',
      }
    }
    if (typeof invoke !== 'function') {
      return { ok: false, degraded: true, mode: state.mode, code: 'E_ADAPTER_NO_INVOKE', tool, message: '宿主未提供工具调用通道' }
    }
    try {
      return { ok: true, degraded: state.mode !== 'active', mode: state.mode, tool, result: invoke(tool, request.args || {}) }
    } catch (cause) {
      return { ok: false, degraded: true, mode: state.mode, code: 'E_ADAPTER_CALL', tool, message: String(cause && cause.message ? cause.message : cause) }
    }
  }

  return {
    id: ID,
    packageName: PACKAGE_NAME,
    get mode() {
      return (last || probe()).mode
    },
    probe,
    call,
    plan,
    health,
    loadData,
    constants: Object.freeze({
      ACTION_PREFIX,
      TOOL_PREFIX,
      LEGACY_TOOL_NAMES,
      LEGACY_WRITE_TOOL_NAMES,
      WRITE_TOOL_NAMES,
      INTERCEPTED_WRITE_TOOLS,
      ACTION_NAMES,
      ACTION_GROUPS,
      DEGRADE_TARGETS,
      CLASSIFY_PLUGIN_LABEL,
      EVIDENCE_PREFIX,
      SESSION_MARKER_PATTERNS,
      SUPPORTED_ENGRAM_VERSIONS,
    }),
  }
}
