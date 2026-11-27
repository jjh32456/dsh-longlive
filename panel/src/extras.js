/**
 * dsh-longlive-panel · 只读扩展视图（1.8.2）
 *
 * 为 longlive 1.8.7–1.8.12 的新数据提供面板展示用的只读读取器：
 *   - network：记忆网络 edges（1.8.11）+ 学习链路 links（1.8.8）+ 链路审计
 *   - distill：卡 lifecycle canonical/historical（1.8.11）+ 迁移运行记录
 *   - system ：自动截断口径（1.8.10）、强制召回/链路/归档兜底统计（1.8.8）、
 *              共享大脑 24h 活动窗（1.8.8）
 *
 * 硬约束（与 server.js 一致）：
 *   - 只读：不写任何文件、不建目录、不触发迁移/蒸馏；
 *   - fail-open：文件缺失/坏行/超限都降级为 present:false 或 badLines 计数，不崩、不编造；
 *   - 预算：单文件读取 ≤ 1 MiB（recall-log 只读尾部 ≤2 MiB / ≤5000 行），
 *           JSON 响应由 server 统一截断；
 *   - 隐私：返回字符串里的一律做绝对路径脱敏（盘符/UNC/home），绝不返回 planPath/rootAbs
 *           这类机器路径；会话只给短 id（前 12 位）。
 */

import { open, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const NETWORK_SCHEMA = 'longlive-panel/network/v1'
export const DISTILL_SCHEMA = 'longlive-panel/distill/v1'
export const SYSTEM_SCHEMA = 'longlive-panel/system/v1'

const MAX_FILE_BYTES = 1024 * 1024
const RECALL_LOG_TAIL_BYTES = 2 * 1024 * 1024
const RECALL_LOG_MAX_LINES = 5000
const ITEM_LIMIT_DEFAULT = 30
const ITEM_LIMIT_MAX = 100
const TOP_N = 20
const HISTORICAL_MAX = 50
const MIGRATION_MAX = 10
const MAX_SCAN_FILES = 20000
// 1.8.11 生产卡面：召回默认 dirs = topics + handover（migrate-lifecycle COPY_ROOT_DIRS 还含
// journal/procedures）；蒸馏扫描必须覆盖 handover，否则迁移记录里引用的 handover 卡会漏计。
const ROOMS = ['topics', 'journal', 'procedures', 'flow', 'handover']

function clampLimit(value, dflt = ITEM_LIMIT_DEFAULT) {
  if (value === null || value === undefined || value === '') return dflt
  const n = Number(value)
  if (!Number.isFinite(n)) return dflt
  return Math.max(1, Math.min(ITEM_LIMIT_MAX, Math.floor(n)))
}

/** 绝对路径 / 机器路径脱敏：返回仍可读的相对文本。 */
export function redactMachinePaths(value) {
  let s = value === null || value === undefined ? '' : String(value)
  s = s.replace(/[A-Za-z]:[\\/][^\s"'，。；、）)\]]*/g, '[path]')
  s = s.replace(/\\\\[^\s"'，。；、）)\]]+/g, '[path]')
  s = s.replace(/\/(?:home|Users|root|opt|var|mnt)\/[^\s"'，。；、）)\]]*/g, '[path]')
  s = s.replace(/file:\/\/\S+/g, '[path]')
  return s
}

function clipText(value, max = 200) {
  const s = redactMachinePaths(value)
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
}

function shortSession(sessionId) {
  const s = redactMachinePaths(sessionId).replace(/^session-/, '')
  return s.length > 12 ? `${s.slice(0, 12)}…` : (s || '—')
}

function isoNow() {
  return new Date().toISOString()
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

async function readLimited(abs, maxBytes = MAX_FILE_BYTES) {
  let st
  try {
    st = await stat(abs)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  const size = Number(st.size) || 0
  try {
    if (size <= maxBytes) {
      return { text: await readFile(abs, 'utf8'), size, mtimeMs: st.mtimeMs, truncated: false }
    }
    const fh = await open(abs, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      await fh.read(buf, 0, maxBytes, size - maxBytes)
      return { text: buf.toString('utf8'), size, mtimeMs: st.mtimeMs, truncated: true }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

async function readHeadLimited(abs, maxBytes = MAX_FILE_BYTES) {
  let st
  try {
    st = await stat(abs)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  const size = Number(st.size) || 0
  try {
    if (size <= maxBytes) {
      return { text: await readFile(abs, 'utf8'), size, mtimeMs: st.mtimeMs, truncated: false }
    }
    const fh = await open(abs, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      await fh.read(buf, 0, maxBytes, 0)
      return { text: buf.toString('utf8'), size, mtimeMs: st.mtimeMs, truncated: true }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

async function readTailLimited(abs, maxBytes, maxLines) {
  const f = await readLimited(abs, maxBytes)
  if (!f) return null
  // 尾部读取可能从半行开始：保留最后一个完整行之后的完整行。
  const lines = f.text.split(/\r?\n/)
  if (f.truncated) lines.shift()
  const kept = lines.slice(-maxLines)
  return { ...f, text: kept.join('\n'), truncated: f.truncated || lines.length > maxLines }
}

function parseJsonl(text) {
  const rows = []
  let bad = 0
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v)
      else bad += 1
    } catch {
      bad += 1
    }
  }
  return { rows, bad }
}

async function readJsonlFile(abs, maxBytes = MAX_FILE_BYTES) {
  const f = await readLimited(abs, maxBytes)
  if (!f) return { present: false, rows: [], bad: 0, sizeBytes: null, mtimeMs: null, truncated: false }
  // 尾部截断时第一行可能是半行：先丢掉，别把半个 JSON 记成 badLines。
  let text = f.text
  if (f.truncated) {
    const idx = text.indexOf('\n')
    text = idx >= 0 ? text.slice(idx + 1) : ''
  }
  const { rows, bad } = parseJsonl(text)
  return { present: true, rows, bad, sizeBytes: f.size, mtimeMs: f.mtimeMs, truncated: f.truncated }
}

function countBy(values) {
  const out = {}
  for (const v of values) out[v] = (out[v] || 0) + 1
  return out
}

// ---------------------------------------------------------------------------
// network：edges（1.8.11）+ links（1.8.8）+ links-audit
// ---------------------------------------------------------------------------

export const EDGE_TYPES = Object.freeze([
  'supersedes', 'superseded_by', 'deprecated_by', 'conflicts_with',
  'answers_with', 'derived_from', 'mentions', 'same_topic',
])

function edgeItems(rows, type, limit) {
  const selected = type ? rows.filter((r) => r.type === type) : rows
  return selected.slice(-limit).reverse().map((r) => ({
    from: clipText(r.from, 160),
    to: clipText(r.to, 160),
    type: clipText(r.type, 40),
    confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null,
    createdAt: clipText(r.created_at, 40),
    source: clipText(r.source, 60),
    quote: r.evidence && typeof r.evidence === 'object' ? clipText(r.evidence.quote, 160) : '',
  }))
}

function edgeTopNodes(rows, limit = TOP_N) {
  const degree = new Map()
  for (const r of rows) {
    for (const key of [r.from, r.to]) {
      if (typeof key !== 'string' || !key) continue
      degree.set(key, (degree.get(key) || 0) + 1)
    }
  }
  return [...degree.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([path, d]) => ({ path: clipText(path, 160), degree: d }))
}

export async function buildNetwork(memoryRoot, query = null) {
  const root = String(memoryRoot || '')
  const limit = clampLimit(query && typeof query.get === 'function' ? query.get('limit') : null)
  const typeFilter = query && typeof query.get === 'function' ? String(query.get('type') || '') : ''
  const edgesFile = join(root, '.longlive', 'recall', 'edges.jsonl')
  const linksFile = join(root, '.longlive', 'recall', 'links.jsonl')
  const auditFile = join(root, '.longlive', 'recall', 'links-audit.jsonl')

  const [edges, links, audit] = await Promise.all([
    readJsonlFile(edgesFile),
    readJsonlFile(linksFile),
    readJsonlFile(auditFile),
  ])

  const edgeRows = edges.rows
  const byType = countBy(edgeRows.map((r) => (typeof r.type === 'string' ? r.type : 'unknown')))
  const nodes = new Set()
  for (const r of edgeRows) {
    if (typeof r.from === 'string') nodes.add(r.from)
    if (typeof r.to === 'string') nodes.add(r.to)
  }
  const linkRows = links.rows
  const linkSource = countBy(linkRows.map((r) => (r.source === 'learned' ? 'learned' : r.source === 'seed' ? 'seed' : 'other')))
  const terms = new Set(linkRows.map((r) => r.term).filter((t) => typeof t === 'string' && t))
  const cards = new Set(linkRows.map((r) => r.cardPath).filter((t) => typeof t === 'string' && t))
  const termAgg = new Map()
  for (const r of linkRows) {
    if (typeof r.term !== 'string' || !r.term) continue
    const cur = termAgg.get(r.term) || { term: r.term, cards: 0, weightSum: 0 }
    cur.cards += 1
    const w = Number(r.weight)
    if (Number.isFinite(w)) cur.weightSum += w
    termAgg.set(r.term, cur)
  }
  const topTerms = [...termAgg.values()]
    .sort((a, b) => b.weightSum - a.weightSum || b.cards - a.cards || a.term.localeCompare(b.term))
    .slice(0, TOP_N)
    .map((t) => ({ term: clipText(t.term, 120), cards: t.cards, weightSum: Math.round(t.weightSum * 1000) / 1000 }))

  const learnedRows = linkRows
    .filter((r) => r.source === 'learned')
    .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
    .slice(0, TOP_N)
  const recentLearned = learnedRows.map((r) => ({
    term: clipText(r.term, 120),
    cardPath: clipText(r.cardPath, 160),
    weight: Number.isFinite(Number(r.weight)) ? Number(r.weight) : null,
    updatedAt: clipText(r.updatedAt, 40),
  }))

  const auditItems = audit.rows.slice(-10).reverse().map((r) => ({
    at: clipText(r.at, 40),
    action: clipText(r.action, 40),
    feedback: clipText(r.feedback, 40),
    terms: Array.isArray(r.terms) ? r.terms.slice(0, 8).map((t) => clipText(t, 60)) : [],
    changeCount: Array.isArray(r.changes) ? r.changes.length : 0,
    edges: Number.isFinite(Number(r.edges)) ? Number(r.edges) : null,
  }))

  const filterType = EDGE_TYPES.includes(typeFilter) ? typeFilter : null
  return {
    ok: true,
    schema: NETWORK_SCHEMA,
    generatedAt: isoNow(),
    edges: {
      present: edges.present,
      sizeBytes: edges.sizeBytes,
      mtimeMs: edges.mtimeMs,
      truncated: edges.truncated,
      total: edgeRows.length,
      badLines: edges.bad,
      nodes: nodes.size,
      byType,
      topNodes: edgeTopNodes(edgeRows),
      filterType,
      items: edgeItems(edgeRows, filterType, limit),
    },
    links: {
      present: links.present,
      sizeBytes: links.sizeBytes,
      mtimeMs: links.mtimeMs,
      truncated: links.truncated,
      total: linkRows.length,
      badLines: links.bad,
      terms: terms.size,
      cards: cards.size,
      bySource: linkSource,
      topTerms,
      recentLearned,
      learned: linkSource.learned || 0,
    },
    audit: { present: audit.present, total: audit.rows.length, items: auditItems },
  }
}

// ---------------------------------------------------------------------------
// distill：lifecycle（1.8.11）+ 迁移运行记录
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '')
  if (!src.startsWith('---')) return { frontmatter: {}, hasFrontmatter: false }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: {}, hasFrontmatter: false }
  const frontmatter = {}
  for (const line of src.slice(3, end).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    frontmatter[m[1]] = v
  }
  return { frontmatter, hasFrontmatter: true }
}

async function listMd(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((d) => d.isFile() && /\.md$/i.test(d.name)).map((d) => d.name).sort()
}

async function scanCards(memoryRoot) {
  const root = String(memoryRoot || '')
  const out = []
  let scanned = 0
  for (const room of ROOMS) {
    const dir = join(root, room)
    let names = []
    try {
      names = await listMd(dir)
    } catch {
      names = []
    }
    if (room === 'flow') {
      const archive = await listMd(join(dir, 'archive'))
      names = names.concat(archive.map((n) => `archive/${n}`))
    }
    for (const name of names) {
      if (scanned >= MAX_SCAN_FILES) break
      scanned += 1
      const rel = room === 'flow' && name.startsWith('archive/') ? `flow/${name}` : `${room}/${name}`
      const abs = join(root, ...rel.split('/'))
      let f = null
      try {
        f = await readHeadLimited(abs, 16 * 1024)
      } catch {
        f = null
      }
      if (!f) continue
      const { frontmatter, hasFrontmatter } = parseFrontmatter(f.text)
      const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
        ? frontmatter.title.trim()
        : name.replace(/\.md$/i, '')
      const lifecycle = typeof frontmatter.lifecycle === 'string' ? frontmatter.lifecycle.trim().toLowerCase() : ''
      out.push({
        path: rel,
        room,
        title: clipText(title, 160),
        lifecycle: lifecycle === 'canonical' || lifecycle === 'historical' ? lifecycle : 'none',
        hasFrontmatter,
        status: typeof frontmatter.status === 'string' ? clipText(frontmatter.status, 40) : '',
        supersededBy: typeof frontmatter.superseded_by === 'string' ? clipText(frontmatter.superseded_by, 160) : '',
      })
    }
  }
  return { cards: out, scanned }
}

async function scanBackup(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { files: 0, bytes: 0 }
  }
  let files = 0
  let bytes = 0
  for (const d of entries) {
    if (!d.isFile()) continue
    try {
      const st = await stat(join(dir, d.name))
      if (st.isFile()) {
        files += 1
        bytes += Number(st.size) || 0
      }
    } catch {
      /* 单个备份文件读不到就跳过 */
    }
  }
  return { files, bytes }
}

async function scanMigrations(memoryRoot) {
  const base = join(String(memoryRoot || ''), '.longlive', 'lifecycle-migrations')
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return { present: false, dirs: 0, items: [] }
  }
  const dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse().slice(0, MIGRATION_MAX)
  const items = []
  for (const name of dirs) {
    const dir = join(base, name)
    const man = await readLimited(join(dir, 'manifest.json'), 256 * 1024)
    if (!man) continue
    let json = null
    try {
      json = JSON.parse(man.text)
    } catch {
      json = null
    }
    const cards = Array.isArray(json && json.cards) ? json.cards : []
    const counts = countBy(cards.map((c) => (c && c.lifecycle === 'historical' ? 'historical' : c && c.lifecycle === 'canonical' ? 'canonical' : 'other')))
    const reasons = cards
      .filter((c) => c && typeof c.rel === 'string')
      .slice(0, 12)
      .map((c) => ({
        rel: clipText(c.rel, 160),
        lifecycle: c.lifecycle === 'historical' ? 'historical' : c.lifecycle === 'canonical' ? 'canonical' : 'other',
        reason: clipText(c.reason, 160),
      }))
    const backup = await scanBackup(join(dir, 'backup'))
    items.push({
      migrationId: clipText(name, 60),
      at: clipText(json && json.at, 40),
      status: clipText(json && json.status, 40) || 'unknown',
      schema: clipText(json && json.schema, 60),
      cards: counts,
      extracts: Array.isArray(json && json.extracts) ? json.extracts.length : 0,
      backupFiles: backup.files,
      backupBytes: backup.bytes,
      planSha256: clipText(json && json.planSha256, 64),
      reasons,
    })
  }
  return { present: true, dirs: dirs.length, items }
}

export async function buildDistill(memoryRoot) {
  const [scan, migrations] = await Promise.all([scanCards(memoryRoot), scanMigrations(memoryRoot)])
  const cards = scan.cards
  const byLifecycle = { canonical: 0, historical: 0, none: 0 }
  const byRoom = {}
  for (const c of cards) {
    byLifecycle[c.lifecycle] += 1
    const room = byRoom[c.room] || { room: c.room, canonical: 0, historical: 0, none: 0, total: 0 }
    room[c.lifecycle] += 1
    room.total += 1
    byRoom[c.room] = room
  }
  const historical = cards
    .filter((c) => c.lifecycle === 'historical')
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, HISTORICAL_MAX)
  const canonical = cards
    .filter((c) => c.lifecycle === 'canonical')
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, HISTORICAL_MAX)
  return {
    ok: true,
    schema: DISTILL_SCHEMA,
    generatedAt: isoNow(),
    cards: {
      scanned: scan.scanned,
      byLifecycle,
      byRoom: Object.values(byRoom).sort((a, b) => b.total - a.total),
      historical,
      canonical,
      historicalTotal: byLifecycle.historical,
      canonicalTotal: byLifecycle.canonical,
      legacyTotal: byLifecycle.none,
    },
    migrations,
  }
}

// ---------------------------------------------------------------------------
// system：auto-truncate（1.8.10）、强制召回（1.8.8）、活动窗（1.8.8）
// ---------------------------------------------------------------------------

function sanitizeAutoTruncate(json) {
  const j = asRecord(json)
  const thresholds = asRecord(j.thresholds)
  const counters = asRecord(j.counters)
  const over = asRecord(j.over)
  const overSessions = asRecord(over.sessions)
  const sessions = Object.entries(overSessions)
    .map(([sid, v]) => {
      const row = asRecord(v)
      return {
        session: shortSession(sid),
        tokens: Number.isFinite(Number(row.tokens)) ? Number(row.tokens) : null,
        turns: Number.isFinite(Number(row.turns)) ? Number(row.turns) : null,
        at: clipText(row.at, 40),
      }
    })
    .sort((a, b) => (b.tokens || 0) - (a.tokens || 0))
    .slice(0, 10)
  const li = asRecord(j.lastInfeasible)
  const le = asRecord(j.lastError)
  const warn = j.warning && typeof j.warning === 'object' ? {
    code: clipText(j.warning.code, 60),
    message: clipText(j.warning.message, 200),
    at: clipText(j.warning.at, 40),
  } : null
  return {
    present: true,
    at: clipText(j.at, 40),
    mode: clipText(j.mode, 20),
    enabled: j.enabled === true,
    thresholds: {
      tokensThreshold: Number.isFinite(Number(thresholds.tokensThreshold)) ? Number(thresholds.tokensThreshold) : null,
      minTurns: Number.isFinite(Number(thresholds.minTurns)) ? Number(thresholds.minTurns) : null,
      keepTurns: Number.isFinite(Number(thresholds.keepTurns)) ? Number(thresholds.keepTurns) : null,
      keepTokens: Number.isFinite(Number(thresholds.keepTokens)) ? Number(thresholds.keepTokens) : null,
      boundaryRetries: Number.isFinite(Number(thresholds.boundaryRetries)) ? Number(thresholds.boundaryRetries) : null,
    },
    counters: {
      evaluations: Number.isFinite(Number(counters.evaluations)) ? Number(counters.evaluations) : null,
      over: Number.isFinite(Number(counters.over)) ? Number(counters.over) : null,
      below: Number.isFinite(Number(counters.below)) ? Number(counters.below) : null,
      infeasible: Number.isFinite(Number(counters.infeasible)) ? Number(counters.infeasible) : null,
      error: Number.isFinite(Number(counters.error)) ? Number(counters.error) : null,
      logged: Number.isFinite(Number(counters.logged)) ? Number(counters.logged) : null,
      planned: Number.isFinite(Number(counters.planned)) ? Number(counters.planned) : null,
      requestWritten: Number.isFinite(Number(counters.requestWritten)) ? Number(counters.requestWritten) : null,
      requestPending: Number.isFinite(Number(counters.requestPending)) ? Number(counters.requestPending) : null,
      requestFailed: Number.isFinite(Number(counters.requestFailed)) ? Number(counters.requestFailed) : null,
      noop: Number.isFinite(Number(counters.noop)) ? Number(counters.noop) : null,
      skipped: Number.isFinite(Number(counters.skipped)) ? Number(counters.skipped) : null,
      dryrun: Number.isFinite(Number(counters.dryrun)) ? Number(counters.dryrun) : null,
    },
    over: {
      count: Number.isFinite(Number(over.count)) ? Number(over.count) : null,
      maxTokens: over.maxTokens && typeof over.maxTokens === 'object' ? {
        session: shortSession(over.maxTokens.sessionId),
        tokens: Number.isFinite(Number(over.maxTokens.tokens)) ? Number(over.maxTokens.tokens) : null,
        turns: Number.isFinite(Number(over.maxTokens.turns)) ? Number(over.maxTokens.turns) : null,
        at: clipText(over.maxTokens.at, 40),
      } : null,
      sessions,
    },
    lastOutcome: clipText(j.lastOutcome, 40),
    lastInfeasible: li.code ? {
      at: clipText(li.at, 40),
      session: shortSession(li.sessionId),
      code: clipText(li.code, 80),
      reason: clipText(li.reason, 240),
      limit: li.limit === null || li.limit === undefined ? null : (Number.isFinite(Number(li.limit)) ? Number(li.limit) : null),
    } : null,
    lastError: le.code ? {
      at: clipText(le.at, 40),
      session: shortSession(le.sessionId),
      code: clipText(le.code, 80),
      message: clipText(le.message, 240),
    } : null,
    warning: warn,
  }
}

function summarizeRecallLog(file) {
  const rows = file.rows
  const byTrigger = {}
  const byOutcome = {}
  let forced = 0
  let injectedOutcome = 0
  let archiveUnavailable = 0
  let errors = 0
  let linkTurns = 0
  let linkInjected = 0
  let linkTokens = 0
  let archiveHits = 0
  const sources = { link: 0, archive: 0, file: 0, unknown: 0, other: 0 }
  for (const row of rows) {
    const trigger = typeof row.trigger === 'string' ? row.trigger : 'unknown'
    byTrigger[trigger] = (byTrigger[trigger] || 0) + 1
    if (row.forced === true) forced += 1
    const outcome = typeof row.outcome === 'string' ? row.outcome : 'unknown'
    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1
    if (outcome === 'injected') injectedOutcome += 1
    if (row.archiveUnavailable === true) archiveUnavailable += 1
    if (row.error === true) errors += 1
    const link = asRecord(row.link)
    if (link.enabled === true) {
      linkTurns += 1
      if (Number.isFinite(Number(link.injectedCount))) linkInjected += Number(link.injectedCount)
      if (Number.isFinite(Number(link.tokens))) linkTokens += Number(link.tokens)
    }
    const injected = Array.isArray(row.injected) ? row.injected : []
    for (const item of injected) {
      const src = item && typeof item === 'object' && typeof item.source === 'string' ? item.source : 'unknown'
      if (src === 'link') sources.link += 1
      else if (src === 'archive') { sources.archive += 1; archiveHits += 1 }
      else if (src === 'file') sources.file += 1
      else if (src === 'unknown') sources.unknown += 1
      else sources.other += 1
    }
  }
  const forcedEvents = rows
    .filter((r) => r && r.forced === true)
    .slice(-10)
    .reverse()
    .map((r) => {
      const link = asRecord(r.link)
      const injected = Array.isArray(r.injected) ? r.injected : []
      const srcCounts = countBy(injected.map((i) => (i && typeof i.source === 'string' ? i.source : 'other')))
      return {
        at: clipText(r.at, 40),
        session: shortSession(r.sessionId),
        turn: Number.isFinite(Number(r.turn)) ? Number(r.turn) : null,
        why: clipText(r.why, 60),
        trigger: clipText(r.trigger, 40),
        outcome: clipText(r.outcome, 40),
        injectedCount: injected.length,
        estimatedTokens: Number.isFinite(Number(r.estimatedTokens)) ? Number(r.estimatedTokens) : null,
        matchedTerms: Array.isArray(link.matchedTerms) ? link.matchedTerms.slice(0, 6).map((t) => clipText(t, 60)) : [],
        sources: srcCounts,
        archiveUnavailable: r.archiveUnavailable === true,
        error: r.error === true,
      }
    })
  return {
    present: file.present,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    truncated: file.truncated,
    scanned: rows.length,
    badLines: file.bad,
    counts: { turns: rows.length, forced, injectedOutcome, archiveUnavailable, errors },
    byTrigger,
    byOutcome,
    link: { turns: linkTurns, injected: linkInjected, tokens: linkTokens },
    archive: { hits: archiveHits, unavailable: archiveUnavailable },
    sources,
    recentForced: forcedEvents,
  }
}

async function summarizeActivity(memoryRoot) {
  const boardDir = join(String(memoryRoot || ''), '.longlive', 'board')
  const file = await readJsonlFile(join(boardDir, 'activity.jsonl'), MAX_FILE_BYTES)
  const now = Date.now()
  const cutoff = now - 24 * 3600 * 1000
  const recent = (row) => {
    const t = Date.parse(row && (row.last_at || row.at))
    return Number.isFinite(t) && t >= cutoff
  }
  let rows24h = 0
  const sessions24h = new Set()
  const byKind = {}
  let oldestAt = null
  let newestAt = null
  for (const row of file.rows) {
    const at = Date.parse(row && (row.at || row.last_at))
    const last = Date.parse(row && (row.last_at || row.at))
    if (Number.isFinite(at) && (!oldestAt || at < Date.parse(oldestAt))) oldestAt = new Date(at).toISOString()
    if (Number.isFinite(last) && (!newestAt || last > Date.parse(newestAt))) newestAt = new Date(last).toISOString()
    if (!recent(row)) continue
    rows24h += 1
    if (typeof row.sessionId === 'string') sessions24h.add(row.sessionId)
    const kind = redactMachinePaths(typeof row.kind === 'string' ? row.kind : 'unknown') || 'unknown'
    byKind[kind] = (byKind[kind] || 0) + 1
  }
  let archived = []
  try {
    const entries = await readdir(boardDir, { withFileTypes: true })
    archived = entries
      .filter((d) => d.isFile() && /^activity-\d{6}\.jsonl$/.test(d.name))
      .map((d) => d.name)
  } catch {
    archived = []
  }
  const archivedFiles = []
  let archivedBytes = 0
  for (const name of archived.sort()) {
    try {
      const st = await stat(join(boardDir, name))
      if (st.isFile()) {
        const size = Number(st.size) || 0
        archivedBytes += size
        archivedFiles.push({ name, sizeBytes: size })
      }
    } catch {
      /* 单个归档文件读不到就跳过 */
    }
  }
  return {
    present: file.present,
    file: 'board/activity.jsonl',
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    truncated: file.truncated,
    rows: file.rows.length,
    badLines: file.bad,
    rows24h,
    activeSessions24h: sessions24h.size,
    byKind,
    oldestAt,
    newestAt,
    archivedFiles,
    archivedBytes,
  }
}

export async function buildSystemExtras(memoryRoot) {
  const root = String(memoryRoot || '')
  const autoTruncateFile = join(root, '.longlive', 'auto-truncate-status.json')
  const recallLogFile = join(root, '.longlive', 'recall-log.jsonl')
  const [autoRaw, recallFile, activity] = await Promise.all([
    readLimited(autoTruncateFile, MAX_FILE_BYTES),
    readTailLimited(recallLogFile, RECALL_LOG_TAIL_BYTES, RECALL_LOG_MAX_LINES),
    summarizeActivity(root),
  ])
  let autoTruncate = { present: false }
  if (autoRaw) {
    let json = null
    try {
      json = JSON.parse(autoRaw.text)
    } catch {
      json = null
    }
    if (json && typeof json === 'object' && !Array.isArray(json)) autoTruncate = sanitizeAutoTruncate(json)
  }
  let recallForced = { present: false }
  if (recallFile) {
    const { rows, bad } = parseJsonl(recallFile.text)
    recallForced = summarizeRecallLog({
      present: true,
      rows,
      bad,
      sizeBytes: recallFile.size,
      mtimeMs: recallFile.mtimeMs,
      truncated: recallFile.truncated,
    })
  }
  return {
    ok: true,
    schema: SYSTEM_SCHEMA,
    generatedAt: isoNow(),
    autoTruncate,
    recallForced,
    activityWindow: activity,
  }
}
