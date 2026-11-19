/**
 * v2-core.js · 面板 1.6.9（M2-F/M2-G）纯逻辑层
 *
 * 依据：PANEL-V2-PROPOSAL.md v2.4（唯一设计权威）+ longlive v2.6.3 契约。
 * 本模块不碰 I/O、不碰 DOM、不联网：只做「契约 → 面板 UI」的映射与校验，
 * 方便 self-test / gap-fixes 直接断言。所有契约语义都在这里落成可执行常量，
 * client 只消费，不自己发明。
 */

/** G7 18 动作（v2.8 §12.7 L1767-1784；面板只许这些契约名，禁止自定义）。 */
export const PANEL_ACTIONS = Object.freeze([
  'approve',
  'reject',
  'return',
  'promote',
  'merge',
  'distill',
  'archive',
  'restore',
  'undo',
  'apply',
  'annotate',
  'dry-run',
  'distill.rollback',
  'protection.add',
  'protection.remove',
  'review.reopen',
  'conflict.arbitrate',
  'relationship.update',
])

/** G1 review 状态枚举（v2.6.3 §12.7-G1 L1717）。 */
export const REVIEW_STATES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'returned',
  'applied',
  'failed',
  'undone',
  'expired',
])

/** 面板按钮 → G7 动作（v2.4 §4.2；禁止自定义动作名）。 */
export const BUTTON_ACTIONS = Object.freeze({
  approve: 'approve',
  reject: 'reject',
  return: 'return',
  undo: 'undo',
  annotate: 'annotate',
  dryRun: 'dry-run',
  apply: 'apply',
  promote: 'promote',
  merge: 'merge',
  distill: 'distill',
  archive: 'archive',
  restore: 'restore',
  distillRollback: 'distill.rollback',
  protectionAdd: 'protection.add',
  protectionRemove: 'protection.remove',
  reviewReopen: 'review.reopen',
  conflictArbitrate: 'conflict.arbitrate',
  relationshipUpdate: 'relationship.update',
})

export const BUTTON_LABELS = Object.freeze({
  approve: '通过',
  reject: '拒绝',
  return: '退回',
  undo: '撤销',
  annotate: '注释',
  dryRun: 'dry-run 预览',
  apply: '执行',
  promote: '提升为卡',
  merge: '合并',
  distill: '生成蒸馏',
  archive: '归档',
  restore: '恢复归档',
  distillRollback: '回滚蒸馏',
  protectionAdd: '加入保护',
  protectionRemove: '移除保护',
  reviewReopen: '重新打开',
  conflictArbitrate: '仲裁冲突',
  relationshipUpdate: '更新关系等级',
})

/** v2.4 §4.4-A：8 状态 × 按钮矩阵。true = 可点。 */
export function stateButtonMatrix(state) {
  const s = typeof state === 'string' ? state : ''
  const no = { approve: false, reject: false, return: false, undo: false, annotate: true, dryRun: false, apply: false, reviewReopen: false }
  switch (s) {
    case 'pending':
      return { ...no, approve: true, reject: true, return: true, dryRun: true }
    case 'approved':
      return { ...no, dryRun: true }
    case 'rejected':
      return { ...no }
    case 'returned':
      return { ...no }
    case 'applied':
      return { ...no, undo: true }
    case 'failed':
      return { ...no, dryRun: true }
    case 'undone':
      return { ...no }
    case 'expired':
      // 仅 review.reopen 可把 expired 拉回 pending（v2.6.3 §12.7 L1737）。
      return { ...no, reviewReopen: true }
    default:
      // 未知状态 = FAIL（审计+拒绝）：面板一律禁用动作，只显示数据。
      return { ...no, annotate: false }
  }
}

/** R7 三问字段（archiveReport）。 */
export const ARCHIVE_REPORT_FIELDS = Object.freeze(['reason', 'affects', 'stillUseful', 'recoverable'])

function text(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export function isIncompleteReviewTarget(target) {
  if (!target || typeof target !== 'object') return true
  if (!text(target.kind)) return true
  if (target.version === undefined || target.version === null) return true
  return false
}

/** review/v1 行规范化（v2.6.3 §12.7-G1 唯一权威 + §12.10-R7 target 扩展）。 */
export function normalizeReviewRow(row) {
  const r = row && typeof row === 'object' ? row : {}
  const target = r.target && typeof r.target === 'object' ? r.target : null
  const decision = r.decision && typeof r.decision === 'object' ? r.decision : null
  const state = text(r.state) || 'unknown'
  const incomplete = isIncompleteReviewTarget(target)
  return {
    id: text(r.id) || null,
    kind: text(r.kind) || null,
    salience: Number.isFinite(Number(r.salience)) ? Number(r.salience) : null,
    lastUsed: text(r.lastUsed) || null,
    expiry: text(r.expiry) || null,
    createdAt: text(r.createdAt) || null,
    source: text(r.source) || null,
    target: target
      ? {
        kind: text(target.kind) || null,
        id: text(target.id) || null,
        version: target.version === undefined ? null : target.version,
        eventIds: Array.isArray(target.eventIds) ? target.eventIds.map((x) => text(x)).filter(Boolean) : null,
        primaryId: text(target.primaryId) || null,
        recordId: text(target.recordId) || null,
        archiveReport: target.archiveReport && typeof target.archiveReport === 'object' ? target.archiveReport : null,
        completeness: text(target.completeness) || null,
      }
      : null,
    state,
    decision: decision ? { by: text(decision.by) || null, at: text(decision.at) || null, reason: text(decision.reason) || null } : null,
    incomplete,
    // 契约：缺 target/version/state 的条目拒收——面板显示「数据不完整」，不显示任何动作按钮。
    buttons: incomplete ? { approve: false, reject: false, return: false, undo: false, annotate: false, dryRun: false, apply: false, reviewReopen: false } : stateButtonMatrix(state),
  }
}

/** merge 表单：target.eventIds[2..10] + primaryId∈eventIds（v2.6.3 §12.10-R7 L1769-1776）。 */
export function validateMergeTarget(target) {
  const t = target && typeof target === 'object' ? target : {}
  if (!t || typeof t !== 'object' || Object.keys(t).length === 0) return { ok: false, code: 'E_TARGET_INCOMPLETE', missing: ['target'] }
  if (t.version === undefined || t.version === null) return { ok: false, code: 'E_TARGET_INCOMPLETE', missing: ['version'] }
  if (t.eventIds === undefined || t.eventIds === null) return { ok: false, code: 'E_TARGET_INCOMPLETE', missing: ['eventIds'] }
  const ids = Array.isArray(t.eventIds) ? t.eventIds.map((x) => text(x)).filter(Boolean) : []
  if (ids.length < 2 || ids.length > 10) return { ok: false, code: 'E_TARGET_EVENTIDS', missing: ['eventIds[2..10]'] }
  if (!text(t.primaryId)) return { ok: false, code: 'E_TARGET_INCOMPLETE', missing: ['primaryId'] }
  if (!ids.includes(text(t.primaryId))) return { ok: false, code: 'E_TARGET_EVENTIDS', missing: ['primaryId∈eventIds'] }
  return { ok: true, code: null, missing: [], eventIds: ids, primaryId: text(t.primaryId), version: t.version }
}

/** archive 表单：recordId + archiveReport{reason,affects,stillUseful,recoverable}。 */
export function validateArchiveTarget(target) {
  const t = target && typeof target === 'object' ? target : {}
  const report = t.archiveReport && typeof t.archiveReport === 'object' ? t.archiveReport : {}
  if (!t || typeof t !== 'object') return { ok: false, code: 'E_TARGET_INCOMPLETE', missing: ['target'] }
  const missing = []
  if (t.version === undefined || t.version === null) missing.push('version')
  if (!text(t.recordId) && !text(t.id)) missing.push('recordId')
  for (const field of ARCHIVE_REPORT_FIELDS) {
    if (field === 'recoverable') {
      if (typeof report.recoverable !== 'boolean') missing.push('archiveReport.recoverable')
    } else if (!text(report[field])) {
      missing.push(`archiveReport.${field}`)
    }
  }
  if (missing.length) {
    return { ok: false, code: missing.some((m) => m.startsWith('archiveReport')) ? 'E_ARCHIVE_REPORT_INCOMPLETE' : 'E_TARGET_INCOMPLETE', missing }
  }
  return {
    ok: true,
    code: null,
    missing: [],
    recordId: text(t.recordId) || text(t.id),
    version: t.version,
    archiveReport: { reason: text(report.reason), affects: text(report.affects), stillUseful: text(report.stillUseful), recoverable: report.recoverable === true },
  }
}

const MIN_REASON = 10

/** 动作参数校验（v2.6.3 §12.7 各 action params）。返回 {ok, code, message}。 */
export function validateActionParams(action, params) {
  const p = params && typeof params === 'object' ? params : {}
  switch (action) {
    case 'approve':
      return text(p.itemId) ? { ok: true } : { ok: false, code: 'E_PARAMS', message: '缺 itemId' }
    case 'reject':
      if (!text(p.itemId)) return { ok: false, code: 'E_PARAMS', message: '缺 itemId' }
      if (text(p.reason).length < MIN_REASON) return { ok: false, code: 'E_PARAMS', message: `reason 至少 ${MIN_REASON} 字` }
      return { ok: true }
    case 'return':
      if (!text(p.itemId)) return { ok: false, code: 'E_PARAMS', message: '缺 itemId' }
      if (text(p.reason).length < MIN_REASON) return { ok: false, code: 'E_PARAMS', message: `reason 至少 ${MIN_REASON} 字` }
      return { ok: true }
    case 'review.reopen':
      if (!text(p.reviewId)) return { ok: false, code: 'E_PARAMS', message: '缺 reviewId' }
      if (text(p.reason).length < MIN_REASON) return { ok: false, code: 'E_PARAMS', message: `reason 至少 ${MIN_REASON} 字` }
      return { ok: true }
    case 'annotate':
      if (text(p.note).length === 0) return { ok: false, code: 'E_PARAMS', message: '缺 note' }
      if (text(p.note).length > 500) return { ok: false, code: 'E_PARAMS', message: 'note 最多 500 字' }
      return { ok: true }
    case 'distill.rollback':
    case 'protection.add':
    case 'protection.remove':
      if (text(p.reason).length < MIN_REASON) return { ok: false, code: 'E_PARAMS', message: `reason 至少 ${MIN_REASON} 字` }
      return { ok: true }
    case 'conflict.arbitrate':
      if (!text(p.conflictId)) return { ok: false, code: 'E_PARAMS', message: '缺 conflictId' }
      if (!Number.isFinite(Number(p.expectedVersion))) return { ok: false, code: 'E_PARAMS', message: '缺 expectedVersion（CAS）' }
      if (!['preferA', 'preferB', 'both', 'disputed'].includes(text(p.resolution))) return { ok: false, code: 'E_PARAMS', message: 'resolution 非法' }
      if (text(p.reason).length < MIN_REASON) return { ok: false, code: 'E_PARAMS', message: `reason 至少 ${MIN_REASON} 字` }
      return { ok: true }
    case 'relationship.update':
      if (!text(p.personId)) return { ok: false, code: 'E_PARAMS', message: '缺 personId' }
      if (!Number.isFinite(Number(p.expectedVersion))) return { ok: false, code: 'E_PARAMS', message: '缺 expectedVersion（CAS）' }
      if (!['stranger', 'familiar', 'trusted', 'intimate'].includes(text(p.tier))) return { ok: false, code: 'E_PARAMS', message: 'tier 非法' }
      if (text(p.reason).length < MIN_REASON) return { ok: false, code: 'E_PARAMS', message: `reason 至少 ${MIN_REASON} 字` }
      return { ok: true }
    case 'undo':
      return text(p.actionId) ? { ok: true } : { ok: false, code: 'E_PARAMS', message: '缺 actionId' }
    case 'apply':
      return text(p.previewId) ? { ok: true } : { ok: false, code: 'E_PARAMS', message: '缺 previewId' }
    case 'dry-run':
      return PANEL_ACTIONS.includes(p.action) ? { ok: true } : { ok: false, code: 'E_ACTION_UNKNOWN', message: 'dry-run 包裹未知 action' }
    default:
      if (!PANEL_ACTIONS.includes(action)) return { ok: false, code: 'E_ACTION_UNKNOWN', message: `未知动作：${action}` }
      return { ok: true }
  }
}

/**
 * 由「按钮 + review 行 + 用户表单输入」构造 preview/apply 请求体。
 * 返回 {ok, action, previewBody, code, missing}；不合格时按钮应禁用并显示错误码。
 */
export function buildActionRequest(button, row, inputs = {}) {
  const action = BUTTON_ACTIONS[button]
  if (!action) return { ok: false, code: 'E_ACTION_UNKNOWN', missing: ['button'] }
  const r = row && typeof row === 'object' ? row : {}
  const t = r.target && typeof r.target === 'object' ? r.target : {}
  const target = { kind: t.kind || 'review', id: t.id || r.id || null, version: t.version === undefined ? null : t.version }
  const params = {}
  const expectedVersion = target.version

  if (button === 'approve' || button === 'reject' || button === 'return') {
    params.itemId = r.id
    if (button !== 'approve') params.reason = text(inputs.reason)
    if (button === 'return' && text(inputs.assignee)) params.assignee = text(inputs.assignee)
  } else if (button === 'reviewReopen') {
    params.reviewId = r.id
    params.reason = text(inputs.reason)
  } else if (button === 'undo') {
    params.actionId = text(inputs.actionId)
    params.idempotencyKey = text(inputs.idempotencyKey) || null
    if (!params.idempotencyKey) delete params.idempotencyKey
  } else if (button === 'annotate') {
    params.target = target
    params.note = text(inputs.note)
    params.visibility = inputs.visibility === 'audit' ? 'audit' : 'panel'
  } else if (button === 'dryRun') {
    params.action = text(inputs.action)
    params.target = target
    params.params = inputs.params && typeof inputs.params === 'object' ? inputs.params : {}
  } else if (button === 'apply') {
    params.previewId = text(inputs.previewId)
    params.idempotencyKey = text(inputs.idempotencyKey)
    params.expectedVersion = inputs.expectedVersion !== undefined ? inputs.expectedVersion : expectedVersion
  } else if (button === 'merge') {
    const v = validateMergeTarget({ ...t, eventIds: inputs.eventIds || t.eventIds, primaryId: inputs.primaryId || t.primaryId })
    if (!v.ok) return { ok: false, code: v.code, missing: v.missing }
    Object.assign(params, { eventIds: v.eventIds, primaryId: v.primaryId })
  } else if (button === 'archive') {
    const report = { ...(t.archiveReport || {}), ...(inputs.archiveReport || {}) }
    const v = validateArchiveTarget({ ...t, archiveReport: report })
    if (!v.ok) return { ok: false, code: v.code, missing: v.missing }
    Object.assign(params, { recordId: v.recordId, archiveReport: v.archiveReport })
  } else if (button === 'promote') {
    params.distillId = text(inputs.distillId) || text(t.id)
    params.targetKind = text(inputs.targetKind) || 'card'
  } else if (button === 'distill') {
    params.sourceIds = Array.isArray(inputs.sourceIds) ? inputs.sourceIds : []
    params.mode = 'extractive'
  } else if (button === 'restore') {
    params.archiveId = text(inputs.archiveId) || text(t.id) || text(t.recordId)
  } else if (button === 'distillRollback') {
    params.distillId = text(inputs.distillId) || text(t.id)
    params.reason = text(inputs.reason)
  } else if (button === 'protectionAdd') {
    params.id = text(inputs.id) || text(t.id)
    params.kind = text(inputs.kind) || text(t.kind) || 'memory'
    params.reason = text(inputs.reason)
  } else if (button === 'protectionRemove') {
    params.id = text(inputs.id) || text(t.id)
    params.reason = text(inputs.reason)
  } else if (button === 'conflictArbitrate') {
    params.conflictId = text(inputs.conflictId) || text(t.id)
    params.resolution = text(inputs.resolution) || 'disputed'
    params.reason = text(inputs.reason)
    params.expectedVersion = inputs.expectedVersion !== undefined ? inputs.expectedVersion : (t.version === undefined ? null : t.version)
  } else if (button === 'relationshipUpdate') {
    params.personId = text(inputs.personId) || text(t.id)
    params.tier = text(inputs.tier) || 'familiar'
    params.reason = text(inputs.reason)
    params.expectedVersion = inputs.expectedVersion !== undefined ? inputs.expectedVersion : (t.version === undefined ? null : t.version)
  }

  const check = validateActionParams(action, params)
  if (!check.ok) return { ok: false, code: check.code, message: check.message, missing: [check.message] }
  if (target.version === null && (button === 'approve' || button === 'reject' || button === 'return' || button === 'merge' || button === 'archive')) {
    return { ok: false, code: 'E_TARGET_INCOMPLETE', missing: ['target.version'] }
  }
  return {
    ok: true,
    action,
    params,
    previewBody: { action, target, params },
  }
}

/** 保护移除硬约束（v2.6.3 §12.9-R4 L1761）：重要事件永禁移除。 */
export function protectionRemoveBlocked(row) {
  const r = row && typeof row === 'object' ? row : {}
  const salience = Number(r.salience)
  const locked = r.locked === true || r.locked === 'true'
  const important = r.important === true || r.pinned === true
  const reasons = []
  if (Number.isFinite(salience) && salience >= 5) reasons.push('salience==5')
  if (locked) reasons.push('locked')
  if (important) reasons.push('重要事件')
  return { blocked: reasons.length > 0, reasons }
}

/** evidence-package/v1 anchors：anchorId 必须存在（v2.6.3 §12.9-R1 L1750）。 */
export function normalizeEvidence(bundle) {
  const b = bundle && typeof bundle === 'object' ? bundle : {}
  const anchors = Array.isArray(b.anchors) ? b.anchors : []
  const rows = anchors.map((a, i) => {
    const item = a && typeof a === 'object' ? a : {}
    return {
      key: text(item.anchorId) || `anchor-${i}`,
      anchorId: text(item.anchorId) || null,
      excerpt: text(item.excerpt),
      sha256: text(item.sha256),
      l0Status: text(item.l0Status) || 'unknown',
      sessionId: text(item.sessionId),
      turn: item.turn === undefined || item.turn === null ? null : item.turn,
      canReadBack: Boolean(text(item.anchorId)),
    }
  })
  return {
    present: b.present !== false && (Boolean(b.queryId) || rows.length > 0),
    queryId: text(b.queryId) || null,
    query: text(b.query),
    timings: b.timings && typeof b.timings === 'object' ? b.timings : null,
    fastAnswer: b.fastAnswer === undefined ? null : b.fastAnswer,
    status: text(b.status) || 'unknown',
    fallback: b.fallback === undefined ? null : b.fallback,
    packageSha256: text(b.packageSha256),
    anchors: rows,
    oldEvidence: rows.length > 0 && rows.every((x) => !x.anchorId),
  }
}

/** integrity/v1 → 面板完整性模型（v2.6.3 §12.11 L1784/L1793-1796）。 */
export function integrityModel(body) {
  const b = body && typeof body === 'object' ? body : {}
  const files = Array.isArray(b.files) ? b.files.map((f) => ({
    path: text(f && f.path),
    ok: f && f.ok === true,
    sha256: text(f && f.sha256),
  })) : []
  const ok = b.ok === true
  const hasPayload = typeof b.ok === 'boolean'
  return {
    status: !hasPayload ? 'unknown' : (ok ? 'ok' : 'locked'),
    ok,
    locked: hasPayload && !ok,
    manifestVersion: text(b.manifestVersion),
    checkedAt: text(b.checkedAt),
    files,
    failedFiles: files.filter((f) => !f.ok),
    lastError: text(b.lastError),
  }
}

/** HTTP 状态/错误码 → 面板降级态（v2.4 §5.4）。 */
export function classifyFailure(status, payload) {
  const code = text(payload && payload.error && payload.error.code) || `HTTP_${status}`
  const map = {
    E_NO_CAP: { state: 'unauthorized', message: '授权已过期，请刷新页面重试。', retryable: true },
    E_CAP_INVALID: { state: 'unauthorized', message: '授权校验失败，请刷新页面。', retryable: true },
    E_CAP_CONSUMED: { state: 'unauthorized', message: '授权已使用或过期，请刷新页面重新授权。', retryable: true },
    E_CAP_EXPIRED: { state: 'unauthorized', message: '授权已过期（TTL ≤60s），请刷新页面。', retryable: true },
    E_PANEL_ABSENT: { state: 'unauthorized', message: '面板未授权：宿主未安装或已卸载面板。', retryable: false },
    E_PANEL_INTEGRITY: { state: 'integrity-locked', message: '面板包被改动/损坏，动作已禁用（只读保留）。', retryable: false },
    E_SUBAGENT_FORBIDDEN: { state: 'forbidden', message: '当前会话无判定权限（仅宿主主会话可判）。', retryable: false },
    E_PANEL_UNAVAILABLE: { state: 'not-implemented', message: 'longlive 1.6.9 面板 API 未接通（memoryV2 未开启或未安装）。', retryable: true },
    E_UNDO_EXPIRED: { state: 'conflict', message: '撤销窗口已过（24h）。', retryable: false },
    E_CLOCK_ROLLBACK: { state: 'conflict', message: '检测到系统时钟回拨，动作已拒绝（防时间攻击）。', retryable: false },
    E_STALE: { state: 'conflict', message: '数据已变化，请重新预览。', retryable: true },
    E_AUDIT_BROKEN: { state: 'degraded', message: '审计链不可信，已停止写操作。', retryable: false },
    E_TARGET_INCOMPLETE: { state: 'form', message: '目标参数不完整，请补齐表单。', retryable: true },
    E_TARGET_EVENTIDS: { state: 'form', message: 'eventIds 不合法（2..10 条且来自 target）。', retryable: true },
    E_ARCHIVE_REPORT_INCOMPLETE: { state: 'form', message: '归档三问（含 recoverable）不完整。', retryable: true },
    E_ACTION_UNKNOWN: { state: 'form', message: '动作不在 18 动作词表内（面板不应发出）。', retryable: false },
    E_PARAMS: { state: 'form', message: '参数不合法。', retryable: true },
  }
  const known = map[code]
  const httpState = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not-implemented' : status === 409 ? 'conflict' : status === 422 || status === 400 ? 'form' : status === 500 ? 'degraded' : 'error'
  return {
    state: known ? known.state : httpState,
    code,
    message: known ? known.message : (text(payload && payload.error && payload.error.message) || '请求失败。'),
    retryable: known ? known.retryable : status >= 500 || status === 429,
  }
}

/** 16 只读路由 → 面板 v2 路由名（与 longlive §12.3 一一对应）。 */
export const READ_ROUTES = Object.freeze({
  flags: '/api/longlive/flags',
  board: '/api/longlive/board',
  status: '/api/longlive/status',
  live: '/api/longlive/live',
  activity: '/api/longlive/activity',
  evidence: '/api/longlive/evidence/latest',
  gap: '/api/longlive/gap',
  'recall-log': '/api/longlive/recall-log',
  'write-health': '/api/longlive/write-health',
  review: '/api/longlive/review',
  events: '/api/longlive/events',
  distill: '/api/longlive/distill',
  archive: '/api/longlive/archive',
  protection: '/api/longlive/protection',
  integrity: '/api/longlive/integrity',
  anchor: '/api/longlive/anchor',
  // v2.6.4： #17 records 断言-证据只读路由。
  records: '/api/longlive/records',
  // v2.8 / 1.8.0：治理/连续性/角色内核，路由 17→27（§12.3 L1725-1734 #18–#27）。
  claims: '/api/longlive/claims',            // #18
  'evidence-chain': '/api/longlive/evidence', // #19（/evidence/:claimId，动态）
  banks: '/api/longlive/banks',              // #20
  conflicts: '/api/longlive/conflicts',      // #21
  'audit-records': '/api/longlive/audit/records', // #22
  frames: '/api/longlive/frames',            // #23
  attention: '/api/longlive/attention',      // #24
  relationships: '/api/longlive/relationships', // #25
  personality: '/api/longlive/personality',  // #26
  channels: '/api/longlive/channels',        // #27（release-check 注册）
})

/**
 * 可选只读路由：契约未计入 17 条（v2.6.4 只增 #17 records），
 * 只在 longlive 提供该路由时展示；缺失 → 面板显示「未实装」，不发明端点。
 */
export const OPTIONAL_READS = Object.freeze({
  // 1.8.0 host smoke 修复：longlive 1.8.0 只注册 #23 /api/longlive/frames
  // （frames/v1，items 按 lastUsedAt 降序）；旧的 /api/longlive/working-frame
  // 从未在宿主侧注册，导致面板「工作帧」永远 E_ROUTE_UNKNOWN → 未实装。
  // 这里映射到实际存在的 #23，由 v2-routes 取最近一帧归一为 working-frame/v1。
  'working-frame': '/api/longlive/frames',
})

export const READ_ROUTE_NAMES = Object.freeze(Object.keys(READ_ROUTES))

export function readRoutePath(name, params = {}) {
  const base = READ_ROUTES[name] ?? OPTIONAL_READS[name]
  if (!base) return null
  if (name === 'anchor') {
    const id = text(params.anchorId)
    if (!id) return null
    return `${base}/${encodeURIComponent(id)}`
  }
  if (name === 'evidence-chain') {
    const claimId = text(params.claimId)
    if (!claimId) return null
    return `${base}/${encodeURIComponent(claimId)}`
  }
  return base
}

/** 动作接口（v2.6.3 §12.4 L1694）：preview/apply/undo 是 POST。 */
export const ACTION_ENDPOINTS = Object.freeze({
  preview: '/api/longlive/actions/preview',
  apply: '/api/longlive/actions/apply',
  undo: '/api/longlive/actions/undo',
  list: '/api/longlive/actions',
  audit: '/api/longlive/audit',
})

/** records/v1 → 面板断言-证据模型（v2.6.4 §14.1 / §12.3 #17）。 */
export const RECORD_SOURCE_TIERS = Object.freeze(['user', 'host', 'agent', 'plugin'])

export function normalizeRecordRow(row) {
  const r = row && typeof row === 'object' ? row : {}
  const evidence = Array.isArray(r.evidence)
    ? r.evidence.filter((item) => item && typeof item.anchorId === 'string').map((item) => ({
      anchorId: item.anchorId,
      sha256: text(item.sha256),
      excerptRef: text(item.excerptRef),
      verifiedAt: text(item.verifiedAt),
      canReadBack: Boolean(text(item.anchorId)),
    }))
    : []
  const sourceTier = RECORD_SOURCE_TIERS.includes(r.sourceTier) ? r.sourceTier : 'agent'
  return {
    id: text(r.id) || null,
    kind: text(r.kind) || 'fact',
    content: text(r.content),
    subject: text(r.subject) || null,
    attribute: text(r.attribute) || null,
    value: r.value === undefined ? null : r.value,
    salience: Number.isFinite(Number(r.salience)) ? Number(r.salience) : 3,
    state: text(r.state) || 'active',
    createdAt: text(r.createdAt) || null,
    lastUsed: text(r.lastUsed) || null,
    evidence,
    evidenceCount: evidence.length,
    sourceTier,
    tierDefaulted: r.tierDefaulted === true,
    conflict: r.conflict === true,
    conflictWith: Array.isArray(r.conflict_with) ? r.conflict_with.map((x) => text(x)).filter(Boolean) : [],
    supersedes: Array.isArray(r.supersedes) ? r.supersedes.map((x) => text(x)).filter(Boolean) : [],
    // 契约：无证据 => unverified（读取层计算，面板只显示，不重算哈希）。
    unverified: r.unverified === true || evidence.length === 0,
  }
}

export function normalizeRecords(body) {
  const b = body && typeof body === 'object' ? body : {}
  const items = (Array.isArray(b.items) ? b.items : []).map(normalizeRecordRow)
  const conflicts = (Array.isArray(b.conflicts) ? b.conflicts : []).map((c) => ({
    idA: text(c && c.idA),
    idB: text(c && c.idB),
    subject: text(c && c.subject),
    why: text(c && c.why),
  })).filter((c) => c.idA && c.idB)
  return {
    present: b.present !== false,
    schema: text(b.schema) || 'records/v1',
    items,
    total: Number.isFinite(Number(b.total)) ? Number(b.total) : items.length,
    conflicts,
    conflictsCount: Number.isFinite(Number(b.conflictsCount)) ? Number(b.conflictsCount) : conflicts.length,
    unverified: Number.isFinite(Number(b.unverified)) ? Number(b.unverified) : items.filter((item) => item.unverified).length,
    badLines: Number.isFinite(Number(b.badLines)) ? Number(b.badLines) : 0,
    code: text(b.code) || null,
  }
}

/** working-frame/v1 → 面板「当前帧」模型（可选路由；无帧返回 present=false）。 */
export function normalizeWorkingFrame(body) {
  const b = body && typeof body === 'object' ? body : {}
  const frame = b.frame && typeof b.frame === 'object' ? b.frame : (b.schema === 'working-frame/v1' ? b : null)
  if (!frame) return { present: false, frame: null, code: text(b.code) || null }
  const focus = frame.focus && typeof frame.focus === 'object' ? frame.focus : {}
  const turnRange = Array.isArray(frame.turnRange) ? frame.turnRange.map((x) => Number(x)).filter(Number.isFinite) : []
  return {
    present: true,
    code: null,
    frame: {
      schema: text(frame.schema) || 'working-frame/v1',
      sessionId: text(frame.sessionId) || null,
      frameId: text(frame.frameId) || null,
      frameNo: Number.isFinite(Number(frame.frameNo)) ? Number(frame.frameNo) : null,
      turnRange,
      entities: Array.isArray(focus.entities) ? focus.entities.map((x) => text(x)).filter(Boolean) : [],
      anchors: Array.isArray(focus.anchors) ? focus.anchors.map((a) => ({ anchorId: text(a && a.anchorId), oneLine: text(a && a.oneLine) })).filter((a) => a.anchorId) : [],
      ttlMs: Number.isFinite(Number(frame.ttlMs)) ? Number(frame.ttlMs) : null,
      lastUsedAt: text(frame.lastUsedAt) || null,
      updatedAt: text(frame.updatedAt) || null,
      state: text(frame.state) || 'active',
      stale: frame.stale === true,
      archivedAt: text(frame.archivedAt) || null,
    },
  }
}

// ---------------------------------------------------------------------------
// v2.8 / 1.8.0：治理 / 连续性 / 角色内核 只读模型（§12.3 #18–#27）
// ---------------------------------------------------------------------------

export const SOURCE_TIER_WEIGHT = Object.freeze({ user: 1.0, host: 0.9, agent: 0.6, plugin: 0.4 })
export const LOW_TRUST_THRESHOLD = 0.35
export const CONFLICT_STATES = Object.freeze(['open', 'resolved', 'disputed'])
export const RELATIONSHIP_TIERS = Object.freeze(['stranger', 'familiar', 'trusted', 'intimate'])
export const ATTENTION_PRIORITIES = Object.freeze(['P0', 'P1', 'P2'])
export const BANK_SCOPES = Object.freeze(['user', 'project', 'org'])
export const CHANNEL_TYPES = Object.freeze(['qq', 'web', 'tool'])
export const AUDIT_FAILURE_REASONS = Object.freeze(['no_hit', 'low_trust', 'privacy_blocked', 'audit_missing', 'unknown'])

/** trustScore = clamp(0,1, w_tier*(1+0.1*verifyCount)*decay)，verifyCount≤5，decay=0.5^(ageDays/30)（§15.1 L1980）。 */
export function trustScoreOf(sourceTier, verifyCount = 0, ageDays = 0) {
  const w = SOURCE_TIER_WEIGHT[sourceTier] ?? SOURCE_TIER_WEIGHT.agent
  const verified = Math.min(5, Math.max(0, Number.isFinite(Number(verifyCount)) ? Number(verifyCount) : 0))
  const days = Math.max(0, Number.isFinite(Number(ageDays)) ? Number(ageDays) : 0)
  const decay = Math.pow(0.5, days / 30)
  const raw = w * (1 + 0.1 * verified) * decay
  return Math.min(1, Math.max(0, Math.round(raw * 1000) / 1000))
}

export function isLowTrust(score, state) {
  return Number(score) < LOW_TRUST_THRESHOLD && String(state || '') !== 'verified'
}

/** #18 claims/v1 */
export function normalizeClaims(body) {
  const b = body && typeof body === 'object' ? body : {}
  const items = (Array.isArray(b.items) ? b.items : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    return {
      id: text(r.id) || null,
      bankId: text(r.bankId) || null,
      subject: r.subject && typeof r.subject === 'object' ? r.subject : (text(r.subject) || null),
      content: text(r.content),
      evidenceCount: Number.isFinite(Number(r.evidenceCount)) ? Number(r.evidenceCount) : (Array.isArray(r.evidence) ? r.evidence.length : 0),
      state: text(r.state) || 'active',
      conflict: r.conflict === true,
      sourceTier: RECORD_SOURCE_TIERS.includes(r.sourceTier) ? r.sourceTier : 'agent',
      // P1-8：trustScore 由宿主计算（#18 claims/v1 需带该字段）；面板只显示，不前端派生。
      trustScore: r.trustScore !== undefined && r.trustScore !== null && Number.isFinite(Number(r.trustScore)) ? Number(r.trustScore) : null,
    }
  })
  return { present: b.present !== false, schema: text(b.schema) || 'claims/v1', items, total: Number.isFinite(Number(b.total)) ? Number(b.total) : items.length, code: text(b.code) || null }
}

/** #19 evidence/v1（evidence/:claimId） */
export function normalizeEvidenceChain(body) {
  const b = body && typeof body === 'object' ? body : {}
  const entries = (Array.isArray(b.entries) ? b.entries : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    return {
      anchorId: text(r.anchorId),
      sha256: text(r.sha256),
      verifier: text(r.verifier) || 'unknown',
      verifiedAt: text(r.verifiedAt),
      supersedes: text(r.supersedes) || null,
      canReadBack: Boolean(text(r.anchorId)),
    }
  })
  return {
    present: b.present !== false,
    schema: text(b.schema) || 'evidence/v1',
    claimId: text(b.claimId) || null,
    version: Number.isFinite(Number(b.version)) ? Number(b.version) : (entries.length > 0 ? 1 : 0),
    entries,
    code: text(b.code) || null,
  }
}

/** #20 banks/v1 */
export function normalizeBanks(body) {
  const b = body && typeof body === 'object' ? body : {}
  const banks = (Array.isArray(b.banks) ? b.banks : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    return {
      bankId: text(r.bankId) || null,
      scope: BANK_SCOPES.includes(r.scope) ? r.scope : 'user',
      owner: text(r.owner) || null,
      readers: (Array.isArray(r.readers) ? r.readers : []).map(text).filter(Boolean),
      writers: (Array.isArray(r.writers) ? r.writers : []).map(text).filter(Boolean),
      auditors: (Array.isArray(r.auditors) ? r.auditors : []).map(text).filter(Boolean),
    }
  })
  return { present: b.present !== false, schema: text(b.schema) || 'banks/v1', banks, code: text(b.code) || null }
}

/** #21 conflicts/v1 */
export function normalizeConflicts(body) {
  const b = body && typeof body === 'object' ? body : {}
  const items = (Array.isArray(b.items) ? b.items : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    // 兼容：契约态 {conflictId,claimA,claimB,subject,state,arbitratedBy,resolution,version}
    //   与实现态 conflicts.js 现输出 {idA,idB,subject,why,source}（缺 conflictId/state/version）。
    const idA = text(r.claimA) || text(r.idA) || null
    const idB = text(r.claimB) || text(r.idB) || null
    return {
      conflictId: text(r.conflictId) || (idA && idB ? `${idA}~${idB}` : null) || text(r.id) || null,
      claimA: idA,
      claimB: idB,
      subject: text(r.subject) || null,
      why: text(r.why) || null,
      state: CONFLICT_STATES.includes(r.state) ? r.state : 'open',
      // P0-2：#21 conflicts/v1 需带 version 才能 CAS；缺 version 时面板禁用仲裁（fail closed）。
      version: Number.isFinite(Number(r.version)) && r.version !== null ? Number(r.version) : null,
      arbitratedBy: text(r.arbitratedBy) || null,
      resolution: ['preferA', 'preferB', 'both', 'disputed'].includes(r.resolution) ? r.resolution : null,
    }
  })
  return { present: b.present !== false, schema: text(b.schema) || 'conflicts/v1', items, total: Number.isFinite(Number(b.total)) ? Number(b.total) : items.length, code: text(b.code) || null }
}

/** #22 audit/records → 导出/复盘行（answer-guard 四指标用；questionId 缺→unknown，不臆造）。 */
export function normalizeAuditRecords(body) {
  const b = body && typeof body === 'object' ? body : {}
  const items = (Array.isArray(b.items) ? b.items : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    const hit = r.hit === undefined ? null : r.hit === true
    const failureReason = AUDIT_FAILURE_REASONS.includes(r.failureReason)
      ? r.failureReason
      : (hit === false ? 'no_hit' : (hit === null ? 'unknown' : null))
    return {
      at: text(r.at) || null,
      recordId: text(r.recordId) || null,
      readerTier: text(r.readerTier) || null,
      action: text(r.action) || null,
      exportable: r.exportable !== false,
      hit,
      failureReason,
      questionId: text(r.questionId) || null,
      questionKey: text(r.questionId) || 'unknown',
      // §16.11 P1-5：#22 增 expectedTurns[] + answerText（截断/脱敏；不展示私密原文）。
      // 兼容 producer 三种形态（R4 契约数组 / 实现整数或 null / 旧数组）：int→[int]，null→[]，array 原样。
      expectedTurns: Array.isArray(r.expectedTurns)
        ? r.expectedTurns.map(Number).filter(Number.isFinite)
        : Number.isFinite(Number(r.expectedTurns)) && r.expectedTurns !== null && r.expectedTurns !== ''
          ? [Number(r.expectedTurns)]
          : [],
      answerText: text(r.answerText).slice(0, 200),
    }
  })
  return {
    present: b.present !== false,
    schema: text(b.schema) || 'audit/v1',
    items,
    total: Number.isFinite(Number(b.total)) ? Number(b.total) : items.length,
    exportable: items.filter((x) => x.exportable).length,
    code: text(b.code) || null,
  }
}

/** 四指标口径（§15.5）：只展示/导出，判定归 answer-guard 评分器（Gate-3）。 */
export const ANSWER_GUARD_METRICS = Object.freeze([
  { id: 'wrong', label: '错答率', target: '0' },
  { id: 'refused', label: '弃答率', target: '≤10%' },
  { id: 'coverage', label: '覆盖率', target: '≥90%' },
  { id: 'hallucination', label: '幻觉率', target: '0' },
])

/** 审计导出 NDJSON 行（按题号/命中/失败原因筛选；无 questionId 标 unknown）。 */
export function buildAuditExportRows(items, { questionId = '', hit, failureReason } = {}) {
  const list = Array.isArray(items) ? items : []
  return list.filter((row) => {
    if (questionId && row.questionKey !== questionId) return false
    if (hit === 'hit' && row.hit !== true) return false
    if (hit === 'miss' && row.hit !== false) return false
    if (failureReason && row.failureReason !== failureReason) return false
    return true
  }).map((row) => ({
    at: row.at,
    recordId: row.recordId,
    readerTier: row.readerTier,
    action: row.action,
    hit: row.hit,
    failureReason: row.failureReason,
    questionId: row.questionKey,
    expectedTurns: row.expectedTurns,
    answerText: row.answerText,
    exportable: row.exportable,
  }))
}

/** #23 frames/v1（帧栈：跨会话读 .longlive/working/*.json；过期帧 state='stale' 仍保留） */
export function normalizeFrames(body) {
  const b = body && typeof body === 'object' ? body : {}
  const rows = Array.isArray(b.items) ? b.items : (Array.isArray(b.stack) ? b.stack : [])
  const stack = rows.map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    const focus = r.focus && typeof r.focus === 'object' ? r.focus : {}
    return {
      sessionId: text(r.sessionId) || null,
      frameId: text(r.frameId) || null,
      frameNo: Number.isFinite(Number(r.frameNo)) ? Number(r.frameNo) : null,
      turnRange: Array.isArray(r.turnRange) ? r.turnRange.map(Number).filter(Number.isFinite) : [],
      entities: (Array.isArray(focus.entities) ? focus.entities : []).map(text).filter(Boolean),
      anchors: (Array.isArray(focus.anchors) ? focus.anchors : []).map((a) => ({ anchorId: text(a && a.anchorId), oneLine: text(a && a.oneLine) })).filter((a) => a.anchorId),
      ttlMs: Number.isFinite(Number(r.ttlMs)) ? Number(r.ttlMs) : null,
      lastUsedAt: text(r.lastUsedAt) || null,
      state: text(r.state) || null,
      stale: r.state === 'stale' || r.stale === true,
    }
  }).sort((a, b2) => String(b2.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')))
  return {
    present: b.present !== false && stack.length > 0,
    schema: text(b.schema) || 'frames/v1',
    total: Number.isFinite(Number(b.total)) ? Number(b.total) : stack.length,
    stack,
    code: text(b.code) || null,
  }
}

/** #24 attention/v1 */
export function normalizeAttention(body) {
  const b = body && typeof body === 'object' ? body : {}
  const items = (Array.isArray(b.items) ? b.items : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    return {
      id: text(r.id) || null,
      priority: ATTENTION_PRIORITIES.includes(r.priority) ? r.priority : 'P2',
      kind: text(r.kind) || 'ops',
      subject: text(r.subject) || null,
      at: text(r.at) || null,
      source: text(r.source) || null,
    }
  }).sort((a, b2) => ATTENTION_PRIORITIES.indexOf(a.priority) - ATTENTION_PRIORITIES.indexOf(b2.priority))
  return {
    present: b.present !== false,
    schema: text(b.schema) || 'attention/v1',
    version: Number.isFinite(Number(b.version)) ? Number(b.version) : null,
    degraded: b.degraded === true,
    tampered: b.tampered === true,
    count: Number.isFinite(Number(b.count)) ? Number(b.count) : items.length,
    total: Number.isFinite(Number(b.total)) ? Number(b.total) : items.length,
    readAt: text(b.readAt) || null,
    items,
    code: text(b.code) || null,
  }
}

/** #25 relationships/v1 */
export function normalizeRelationships(body) {
  const b = body && typeof body === 'object' ? body : {}
  const nodes = (Array.isArray(b.nodes) ? b.nodes : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    return {
      personId: text(r.personId) || null,
      // P0-2：#25 relationships/v1 需带 version 才能 CAS；缺 version 时面板禁用更新。
      version: r.version !== undefined && r.version !== null && Number.isFinite(Number(r.version)) ? Number(r.version) : null,
      tier: RELATIONSHIP_TIERS.includes(r.tier) ? r.tier : 'stranger',
      confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
      updatedAt: text(r.updatedAt) || null,
      appellations: (Array.isArray(r.appellations) ? r.appellations : []).map(text).filter(Boolean),
    }
  })
  const edges = (Array.isArray(b.edges) ? b.edges : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    return { from: text(r.from) || text(r.personId) || null, to: text(r.to) || null, relation: text(r.relation) || null, lastSeenAt: text(r.lastSeenAt) || null }
  })
  return {
    present: b.present !== false,
    schema: text(b.schema) || 'relationships/v1',
    version: Number.isFinite(Number(b.version)) ? Number(b.version) : null,
    degraded: b.degraded === true,
    tampered: b.tampered === true,
    denied: b.denied === true,
    count: Number.isFinite(Number(b.count)) ? Number(b.count) : nodes.length,
    tierWeights: b.tierWeights && typeof b.tierWeights === 'object' ? { ...b.tierWeights } : { ...RELATIONSHIP_WEIGHT },
    defaultTier: RELATIONSHIP_TIERS.includes(b.defaultTier) ? b.defaultTier : 'stranger',
    readAt: text(b.readAt) || null,
    nodes,
    edges,
    code: text(b.code) || null,
  }
}

export const RELATIONSHIP_WEIGHT = Object.freeze({ stranger: 1.0, familiar: 1.05, trusted: 1.1, intimate: 1.15 })

/** #26 personality/v1 */
export function normalizePersonality(body) {
  const b = body && typeof body === 'object' ? body : {}
  const bias = b.retentionBias && typeof b.retentionBias === 'object' ? b.retentionBias : {}
  return {
    present: b.present !== false,
    schema: text(b.schema) || 'personality/v1',
    snapshotId: text(b.snapshotId) || null,
    version: Number.isFinite(Number(b.version)) ? Number(b.version) : null,
    tone: text(b.tone) || null,
    retentionBias: Object.fromEntries(Object.entries(bias).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])),
    createdAt: text(b.createdAt) || null,
    sources: Array.isArray(b.sources) ? b.sources.slice(0, 20) : [],
    degraded: b.degraded === true,
    tampered: b.tampered === true,
    denied: b.denied === true,
    readAt: text(b.readAt) || null,
    code: text(b.code) || null,
  }
}

/** #27 channels/v1（release-check 注册 #27；state-truth 提供 readChannels 读取器） */
export function normalizeChannels(body) {
  const b = body && typeof body === 'object' ? body : {}
  const channels = (Array.isArray(b.channels) ? b.channels : []).map((row) => {
    const r = row && typeof row === 'object' ? row : {}
    return {
      id: text(r.id) || null,
      type: CHANNEL_TYPES.includes(r.type) ? r.type : 'tool',
      enabled: r.enabled === true,
      lastSeenAt: text(r.lastSeenAt) || null,
    }
  })
  return { present: b.present !== false, schema: text(b.schema) || 'channels/v1', channels, code: text(b.code) || null }
}

/** 冲突仲裁按钮矩阵（§3.10）；resolved 只读，open/disputed 可（重）仲裁。 */
export function conflictButtons(state, version) {
  const s = CONFLICT_STATES.includes(state) ? state : 'open'
  // P0-2：CAS 需要 version 源；无 version 时动作不可用（面板禁用，不调宿主动作）。
  const hasVersion = version !== undefined && version !== null && Number.isFinite(Number(version))
  return { arbitrate: (s === 'open' || s === 'disputed') && hasVersion }
}

/** 关系等级按钮（§3.14）：有 node 才可 update（契约动作 relationship.update）。 */
export function relationshipButtons(node) {
  const hasVersion = node && node.version !== undefined && node.version !== null && Number.isFinite(Number(node.version))
  return { update: Boolean(node && text(node.personId) && hasVersion) }
}
