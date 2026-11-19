/**
 * v2-routes.js · 面板 v2 HTTP 分派（/api/longlive-panel/v2/*）
 *
 * 浏览器只跟面板 server 同源通信；面板 server 经 v2-bridge 走宿主内部通道，
 * 对 longlive 的 22 条只读路由 + M2-G 动作面（5 条动作路由，共 27 路由）发起 in-process 调用。
 * 能力令牌只在 bridge 内部一次请求生命期内存在，绝不进响应体/日志/浏览器。
 *
 * 依据：PANEL-V2-PROPOSAL v2.4 §3/§4/§5；longlive v2.6.3 §12.2/§12.3/§12.4。
 */

import {
  ACTION_ENDPOINTS,
  OPTIONAL_READS,
  PANEL_ACTIONS,
  READ_ROUTE_NAMES,
  classifyFailure,
  integrityModel,
  normalizeAttention,
  normalizeAuditRecords,
  normalizeBanks,
  normalizeChannels,
  normalizeClaims,
  normalizeConflicts,
  normalizeEvidenceChain,
  normalizeFrames,
  normalizePersonality,
  normalizeRecords,
  normalizeRelationships,
  normalizeWorkingFrame,
  readRoutePath,
} from './v2-core.js'

export const V2_PREFIX = '/v2'
export const V2_BODY_LIMIT = 64 * 1024
// R4 P1-1：不再用公开常量当 CSRF；每面板实例随机令牌（/v2/state 同源下发）。
export const CSRF_HEADER = 'x-panel-csrf'
export const CSRF_VALUE = 'per-session-random' // 兼容旧常量导出；真实值由 createV2Service 注入
export const ORIGIN_HEADER = 'origin'

function jsonHeaders() {
  return { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
}

function sendable(status, body, extraHeaders = {}) {
  return { status, headers: { ...jsonHeaders(), ...extraHeaders }, body }
}

function failure(status, payload) {
  const mapped = classifyFailure(status, payload)
  return sendable(status, { ok: false, error: { code: mapped.code, message: mapped.message, state: mapped.state, retryable: mapped.retryable } })
}

function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

function normalizeHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value)
  return out
}

/**
 * Create the v2 dispatcher.
 * @param {object} options
 * @param {object} options.bridge createLongliveBridge() result
 * @param {() => Date} [options.now]
 */
export function createV2Service(options = {}) {
  const bridge = options.bridge
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  // P1-1：per-session 随机 CSRF（宿主侧生成；同源页面经 /v2/state 取；跨源读不到）。
  const csrfToken = typeof options.csrfToken === 'string' && options.csrfToken.length >= 16 ? options.csrfToken : null
  // 严格同源：POST 必须带 Origin 且与 Host 同源；无/异源一律 403（不再「有才比较」）。
  const requireOrigin = options.requireOrigin !== false

  function readOne(name, params = {}, query = '') {
    const path = readRoutePath(name, params)
    if (path === null) return sendable(400, { ok: false, error: { code: 'E_PATH', message: `非法只读路由参数：${name}` } })
    const verdict = bridge.read(`${path}${query ? `?${query}` : ''}`)
    if (name === 'working-frame') {
      // 1.8.0 host smoke 修复：宿主只注册 #23 frames（items 按 lastUsedAt 降序），
      // 取最近一帧映射为 working-frame/v1；宿主没有 frames 路由或空栈时诚实
      // 返回 200 present:false（「暂无工作帧」），不再把可选路由变成 404 未实装。
      const body = verdict.status === 200 && verdict.body && typeof verdict.body === 'object' ? verdict.body : {}
      const items = Array.isArray(body.items) ? body.items : []
      const latest = items.length > 0 && items[0] && typeof items[0] === 'object' ? items[0] : null
      const normalized = latest === null
        ? { present: false, frame: null, code: 'E_FRAMES_EMPTY' }
        : normalizeWorkingFrame({ frame: { schema: 'working-frame/v1', ...latest } })
      return sendable(200, { ok: true, route: name, generatedAt: now().toISOString(), frame: normalized, data: body })
    }
    if (verdict.status !== 200) return failure(verdict.status, verdict.body)
    const body = verdict.body && typeof verdict.body === 'object' ? verdict.body : {}
    if (name === 'records') {
      return sendable(200, { ok: true, route: name, generatedAt: now().toISOString(), records: normalizeRecords(body), data: body })
    }
    // v2.8 / 1.8.0：治理/连续性/角色内核 只读路由（#18–#27）统一归一为 model。
    const V2_READ_MODELS = {
      claims: normalizeClaims,
      'evidence-chain': normalizeEvidenceChain,
      banks: normalizeBanks,
      conflicts: normalizeConflicts,
      'audit-records': normalizeAuditRecords,
      frames: normalizeFrames,
      attention: normalizeAttention,
      relationships: normalizeRelationships,
      personality: normalizePersonality,
      channels: normalizeChannels,
    }
    if (Object.prototype.hasOwnProperty.call(V2_READ_MODELS, name)) {
      return sendable(200, { ok: true, route: name, generatedAt: now().toISOString(), model: V2_READ_MODELS[name](body), data: body })
    }
    if (name === 'integrity') {
      // #16 的 body 里 `ok` 属于 integrity/v1 自身（lock 时 ok:false），
      // 但 HTTP 仍是 200、只读保留：这里绝不能当成路由失败。
      return sendable(200, {
        ok: true,
        route: name,
        generatedAt: now().toISOString(),
        integrity: integrityModel(body),
        data: body,
      })
    }
    if (body.ok === false) return failure(200, body)
    return sendable(200, { ok: true, route: name, generatedAt: now().toISOString(), data: body })
  }

  function state() {
    const availability = bridge.availability()
    let integrity = null
    let integrityStatus = 'unknown'
    if (availability.available) {
      const verdict = bridge.integrity()
      if (verdict.status === 200) {
        integrity = integrityModel(verdict.body)
        integrityStatus = 'readonly-route'
      } else if (verdict.status === 404) {
        integrityStatus = 'not-implemented'
      } else {
        integrityStatus = 'read-failed'
      }
    }
    return sendable(200, {
      ok: true,
      generatedAt: now().toISOString(),
      bridge: availability,
      integrity,
      integrityStatus,
      integrityFallback: integrityStatus === 'not-implemented' ? 'dry-run' : null,
      // P1-1：同源页面从这里取 per-session CSRF（不落盘、不进日志；跨源读不到）。
      csrfToken: csrfToken || null,
      actions: PANEL_ACTIONS.slice(),
      routes: READ_ROUTE_NAMES.slice(),
      optionalRoutes: Object.keys(OPTIONAL_READS),
      capabilities: {
        anchorReadBack: true,
        reviewReopen: true,
        protectionWrite: true,
        distillRollback: true,
        // v2.6.4 / 1.8.0：断言-证据（#17）+ 治理/连续性/角色内核（#18–#27）。
        recordsReadonly: true,
        governance: ['claims', 'evidence-chain', 'banks', 'conflicts', 'audit-records'],
        continuity: ['frames'],
        roleKernel: ['attention', 'relationships', 'personality', 'channels'],
        workingFrame: 'optional',
      },
    })
  }

  function actionsList(query = '') {
    const verdict = bridge.action('GET', `${ACTION_ENDPOINTS.list}${query ? `?${query}` : ''}`)
    if (verdict.status !== 200 || (verdict.body && verdict.body.ok === false)) return failure(verdict.status, verdict.body)
    return sendable(200, { ok: true, route: 'actions', generatedAt: now().toISOString(), data: verdict.body })
  }

  function audit(query = '') {
    const verdict = bridge.action('GET', `${ACTION_ENDPOINTS.audit}${query ? `?${query}` : ''}`)
    if (verdict.status !== 200 || (verdict.body && verdict.body.ok === false)) return failure(verdict.status, verdict.body)
    return sendable(200, { ok: true, route: 'audit', generatedAt: now().toISOString(), data: verdict.body })
  }

  /**
   * 完整性状态：优先 #16 只读路由；若 404（旧部署缺该路由）按 v2.4 降级为
   * 一次 dry-run 动作探针（不落效果，只判断完整性门是否 401 E_PANEL_INTEGRITY）。
   */
  function integrityProbe() {
    const verdict = bridge.integrity()
    if (verdict.status === 200) {
      return sendable(200, { ok: true, route: 'integrity', generatedAt: now().toISOString(), integrity: integrityModel(verdict.body), via: 'readonly-route' })
    }
    if (verdict.status === 404) {
      const probe = bridge.action('POST', ACTION_ENDPOINTS.preview, {
        action: 'dry-run',
        target: { kind: 'panel', id: 'integrity-probe', version: 1 },
        params: { action: 'annotate', target: { kind: 'panel', id: 'integrity-probe', version: 1 }, params: {} },
      })
      const code = probe.body && probe.body.error ? probe.body.error.code : ''
      if (probe.status === 200) {
        return sendable(200, { ok: true, route: 'integrity', generatedAt: now().toISOString(), via: 'dry-run-probe', integrity: integrityModel({ ok: true, checkedAt: now().toISOString(), manifestVersion: null, files: [] }) })
      }
      if (probe.status === 401 && code === 'E_PANEL_INTEGRITY') {
        return sendable(200, { ok: true, route: 'integrity', generatedAt: now().toISOString(), via: 'dry-run-probe', integrity: integrityModel({ ok: false, checkedAt: now().toISOString(), manifestVersion: null, files: [], lastError: 'E_PANEL_INTEGRITY' }) })
      }
      return sendable(200, { ok: true, route: 'integrity', generatedAt: now().toISOString(), via: 'dry-run-probe', probeStatus: probe.status, integrity: integrityModel({}) })
    }
    return failure(verdict.status, verdict.body)
  }

  function actionPost(kind, body) {
    const endpoint = ACTION_ENDPOINTS[kind]
    if (!endpoint) return sendable(404, { ok: false, error: { code: 'E_ROUTE_UNKNOWN', message: `未知动作接口：${kind}` } })
    if (
      body !== null
      && typeof body === 'object'
      && body.action !== undefined
      && !PANEL_ACTIONS.includes(String(body.action))
    ) {
      // Panel must never send custom actions; reject before touching the host.
      return sendable(400, { ok: false, error: { code: 'E_ACTION_UNKNOWN', message: `动作不在 18 动作词表：${String(body.action)}` } })
    }
    // P0-2：conflict.arbitrate / relationship.update 的 CAS 校验只在 preview 阶段做
    //（apply/undo 用 previewId 携带已存的 expectedVersion；A7 探针发现 apply 被误拦 422）。
    if (kind === 'preview' && body && typeof body === 'object' && (body.action === 'conflict.arbitrate' || body.action === 'relationship.update')) {
      const params = body.params && typeof body.params === 'object' ? body.params : {}
      if (!Number.isFinite(Number(params.expectedVersion))) {
        return sendable(422, { ok: false, error: { code: 'E_PARAMS', message: `动作 ${body.action} 缺 expectedVersion（CAS version 源未定，P0-2）` } })
      }
    }
    const verdict = bridge.action('POST', endpoint, body && typeof body === 'object' ? body : {})
    if (verdict.status !== 200 || (verdict.body && verdict.body.ok === false)) return failure(verdict.status, verdict.body)
    return sendable(200, { ok: true, route: `actions/${kind}`, generatedAt: now().toISOString(), data: verdict.body })
  }

  /**
   * Dispatch one panel v2 request.
   * `subPath` is the path after `/api/longlive-panel` (e.g. `/v2/read/review?state=pending`).
   */
  function handleRequest({ method = 'GET', subPath = '/v2/state', headers = {}, body = {}, rawBodySize = null } = {}) {
    const m = String(method || 'GET').toUpperCase()
    const hdrs = normalizeHeaders(headers)
    let url
    try {
      url = new URL(String(subPath || '/v2/state'), 'http://panel.local')
    } catch {
      return sendable(400, { ok: false, error: { code: 'E_PATH', message: '路径解析失败' } })
    }
    const parts = url.pathname.split('/').filter(Boolean) // ['v2', ...]
    if (parts[0] !== 'v2') return sendable(404, { ok: false, error: { code: 'E_ROUTE_UNKNOWN', message: '不是 v2 路由' } })
    const rest = parts.slice(1)
    const query = url.searchParams.toString()

    if (rest.length === 0 || (rest.length === 1 && rest[0] === 'state')) {
      if (m !== 'GET' && m !== 'HEAD') return sendable(405, { ok: false, error: { code: 'E_METHOD', message: '只支持 GET' } })
      return state()
    }

    if (rest[0] === 'read') {
      if (m !== 'GET' && m !== 'HEAD') return sendable(405, { ok: false, error: { code: 'E_METHOD', message: '只读接口只支持 GET' } })
      const name = rest[1]
      if (!name) return sendable(400, { ok: false, error: { code: 'E_PATH', message: '缺只读路由名' } })
      if (name === 'anchor') {
        const anchorId = rest[2] || url.searchParams.get('anchorId') || ''
        return readOne('anchor', { anchorId }, '')
      }
      if (name === 'evidence-chain') {
        const claimId = rest[2] || url.searchParams.get('claimId') || ''
        if (!claimId) return sendable(400, { ok: false, error: { code: 'E_PATH', message: '缺 claimId（/v2/read/evidence-chain/<claimId>）' } })
        return readOne('evidence-chain', { claimId }, '')
      }
      if (!READ_ROUTE_NAMES.includes(name) && !Object.prototype.hasOwnProperty.call(OPTIONAL_READS, name)) {
        return sendable(404, { ok: false, error: { code: 'E_ROUTE_UNKNOWN', message: `未知只读路由：${name}` } })
      }
      return readOne(name, {}, query)
    }

    if (rest[0] === 'actions') {
      if (rest.length === 1) {
        if (m !== 'GET') return sendable(405, { ok: false, error: { code: 'E_METHOD', message: 'actions 列表只支持 GET' } })
        return actionsList(query)
      }
      const kind = rest[1]
      if (kind === 'preview' || kind === 'apply' || kind === 'undo') {
        if (m !== 'POST') return sendable(405, { ok: false, error: { code: 'E_METHOD', message: `${kind} 只支持 POST` } })
        // P1-1：CSRF 必须等于本面板会话随机令牌（缺失/伪造 403；公开常量不算凭据）。
        const presented = hdrs[CSRF_HEADER] || ''
        if (csrfToken === null || presented.length !== csrfToken.length || presented !== csrfToken) {
          return sendable(403, { ok: false, error: { code: 'E_CSRF', message: '缺少/伪造同源请求标记（x-panel-csrf）' } })
        }
        // P1-1：Origin 严格校验——必须存在且与 Host 同源；无 Origin/跨源一律 403。
        const origin = hdrs[ORIGIN_HEADER] || ''
        const host = hdrs.host || ''
        if (requireOrigin) {
          if (!origin || !host) {
            return sendable(403, { ok: false, error: { code: 'E_ORIGIN', message: '缺 Origin/Host：拒绝代签请求' } })
          }
          try {
            const parsed = new URL(origin)
            if (parsed.host !== host || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
              return sendable(403, { ok: false, error: { code: 'E_ORIGIN', message: '跨源/非法 Origin 被拒绝' } })
            }
          } catch {
            return sendable(403, { ok: false, error: { code: 'E_ORIGIN', message: 'Origin 不合法' } })
          }
        }
        const size = Number.isInteger(rawBodySize) ? rawBodySize : Buffer.byteLength(JSON.stringify(body ?? {}))
        if (size > V2_BODY_LIMIT) return sendable(413, { ok: false, error: { code: 'E_BODY_TOO_LARGE', message: `请求体超过 ${V2_BODY_LIMIT} 字节` } })
        return actionPost(kind, body)
      }
      return sendable(404, { ok: false, error: { code: 'E_ROUTE_UNKNOWN', message: `未知动作接口：${kind}` } })
    }

    if (rest[0] === 'integrity') {
      if (m !== 'GET') return sendable(405, { ok: false, error: { code: 'E_METHOD', message: 'integrity 只支持 GET' } })
      return integrityProbe()
    }

    if (rest[0] === 'audit') {
      if (m !== 'GET') return sendable(405, { ok: false, error: { code: 'E_METHOD', message: 'audit 只支持 GET' } })
      return audit(query)
    }

    return sendable(404, { ok: false, error: { code: 'E_ROUTE_UNKNOWN', message: `未知 v2 路由：/${['v2', ...rest].join('/')}` } })
  }

  return { handleRequest, readOne, state }
}

/** Route table for docs/tests: names exposed by the panel v2 layer. */
export const V2_ROUTES = Object.freeze([
  'GET /api/longlive-panel/v2/state',
  'GET /api/longlive-panel/v2/read/<16 路由名>',
  'GET /api/longlive-panel/v2/read/anchor/<anchorId>',
  'GET /api/longlive-panel/v2/read/integrity',
  'GET /api/longlive-panel/v2/read/records            （#17，断言-证据只读）',
  'GET /api/longlive-panel/v2/read/claims             （#18，治理 Claim）',
  'GET /api/longlive-panel/v2/read/evidence-chain/<claimId>（#19，证据版本链）',
  'GET /api/longlive-panel/v2/read/banks              （#20，Bank/授权矩阵）',
  'GET /api/longlive-panel/v2/read/conflicts          （#21，冲突）',
  'GET /api/longlive-panel/v2/read/audit-records      （#22，读写审计/四指标复盘；?format=ndjson）',
  'GET /api/longlive-panel/v2/read/frames             （#23，帧栈）',
  'GET /api/longlive-panel/v2/read/attention          （#24，角色内核 attention）',
  'GET /api/longlive-panel/v2/read/relationships      （#25，关系等级）',
  'GET /api/longlive-panel/v2/read/personality        （#26，人格快照）',
  'GET /api/longlive-panel/v2/read/channels           （#27，渠道只读；release-check 注册）',
  'GET /api/longlive-panel/v2/read/working-frame      （可选路由；缺失→未实装）',
  'GET /api/longlive-panel/v2/actions?state=pending',
  'POST /api/longlive-panel/v2/actions/preview',
  'POST /api/longlive-panel/v2/actions/apply',
  'POST /api/longlive-panel/v2/actions/undo',
  'GET /api/longlive-panel/v2/audit?seqSince=',
  'GET /api/longlive-panel/v2/integrity',
])
