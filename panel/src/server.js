/**
 * dsh-longlive-panel · 宿主侧（只读）
 *
 * 设计依据：../DESIGN.md、../data-contract.md（同一目录下的两份文档）。
 * 本文件只做三件事：
 *   1. 把白名单内的文件读出来（路径 jail 在 memoryRoot / sessionsRoot 里）；
 *   2. 按 data-contract 的七个接口拼出 JSON；
 *   3. 用 ctx.webServer.register 挂成一个 prefix 路由。
 *
 * 没有任何写操作：不建目录、不写文件、不改 memory-state、不碰 session 日志。
 * 唯一的“副作用”是 readFile 的 atime（由宿主决定是否启用，node 默认不更新）。
 *
 * 路由（全部 GET，HEAD 允许）：
 *   GET /api/longlive-panel/summary
 *   GET /api/longlive-panel/cards?layer=semantic&limit=20&cursor=&q=
 *   GET /api/longlive-panel/card/<urlencoded path>
 *   GET /api/longlive-panel/truncations?limit=20&session=
 *   GET /api/longlive-panel/filter?limit=20&target=&reveal=1
 *   GET /api/longlive-panel/shadow?limit=20&source=&action=&reveal=1
 *   GET /api/longlive-panel/router
 *   GET /api/longlive-panel/recall?limit=20
 */

import { readFile, readdir, stat, realpath, open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * 版本号的唯一权威是 package.json（运行时从包根读取，禁止手写常量）。
 * 历史事故：本文件曾手写 VERSION 且发版时漏改，导致页头显示旧版本；复盘见 FIX-NOTES.md。
 */
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (typeof PKG.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(PKG.version)) {
  throw new Error(`dsh-longlive-panel: package.json version 非法：${String(PKG.version)}`)
}
export const VERSION = PKG.version
export const ROUTE = '/api/longlive-panel'

/** 单文件读取上限：1 MiB（契约 0.3）。 */
export const MAX_FILE_BYTES = 1024 * 1024
/** 正文返回上限：200 KB（契约 0.3）。 */
export const BODY_MAX_BYTES = 200 * 1024
/** 正文返回上限：400 行（契约 0.3）。 */
export const BODY_MAX_LINES = 400
/** 列表默认/最大条数（契约 0.3）。 */
export const LIMIT_DEFAULT = 20
export const LIMIT_MAX = 100
/** JSONL 只取尾部 5000 行（契约 0.3）。 */
export const JSONL_TAIL_LINES = 5000
/**
 * 会话目录扫描预算。
 *
 * 契约 0.3 写的是「单请求最多 64 个文件 stat，超了 503」。真实机器上
 * `~/.dsh/sessions` 有 3 个 workspace / 约 400 个会话目录，要靠 readdir 逐个
 * 才知道谁有 truncate.json——64 这个数在这里必然被撞穿，面板会永远 503。
 * 所以扫描路径改成「目录预算 SESSION_WALK_BUDGET + 只读 truncate.json/backups.json」，
 * 超出预算时在响应里标 scanTruncated:true（不静默截断）。文件读取上限仍按 1 MiB。
 * 这条差异已写进 RESULT.json 的 openQuestions，等契约升版确认。
 */
export const SESSION_WALK_BUDGET = 1024
/** 扫描结果缓存时间，避免一页四张卡把 sessions 目录扫四遍。 */
export const SCAN_TTL_MS = 5000

const STATUS_BY_CODE = {
  E_BAD_QUERY: 400,
  E_NOT_FOUND: 404,
  E_METHOD: 405,
  E_TOO_LARGE_FILE: 413,
  E_READ_FAILED: 500,
  E_TOO_MANY_FILES: 503,
}

export class PanelError extends Error {
  constructor(code, message, path) {
    super(message)
    this.name = 'PanelError'
    this.code = code
    this.status = STATUS_BY_CODE[code] ?? 500
    if (path) this.path = path
  }
}

function fail(code, message, path) {
  return { status: STATUS_BY_CODE[code] ?? 500, headers: {}, body: { ok: false, error: { code, message, ...(path ? { path } : {}) } } }
}

// ---------------------------------------------------------------------------
// 路径白名单与 jail
// ---------------------------------------------------------------------------

const ROOT_FILES = new Set(['INDEX.md', 'POLICY.md', 'STATE.md', 'status.json', 'memory-state.json', 'tombstones.md'])

/** 契约 0.2 的只读白名单。命中即允许，未命中一律 404（不区分“不存在”和“不许读”）。 */
const REL_ALLOWED = [
  /^topics\/[^/\\]+\.md$/i,
  /^journal\/[^/\\]+\.md$/i,
  /^procedures\/[^/\\]+\.md$/i,
  /^flow\/current\.md$/i,
  /^flow\/archive\/[^/\\]+\.md$/i,
  /^\.longlive\/live\/[^/\\]+\.json$/i,
  /^\.longlive\/memory-state\.json$/i,
  /^\.longlive\/audit\.log$/i,
  /^\.longlive\/reports\/[^/\\]+\.md$/i,
  /^\.longlive\/filter\/decisions-[^/\\]+\.jsonl$/i,
  // 常驻 Router 的只读窗口：状态、共享板、单张提案。提案正文不出口，只读字段。
  /^\.longlive\/router\/status\.json$/i,
  /^\.longlive\/router\/board\.json$/i,
  /^\.longlive\/router\/proposals\/[^/\\]+\.json$/i,
]

/** 永不提供的路径（白名单之外再加一道，防止将来放宽时漏掉）。 */
const REL_FORBIDDEN = [
  /(^|\/)\.credentials[^/]*$/i,
  /\.(key|pem|pfx|p12|p8)$/i,
  /(^|\/)node_modules(\/|$)/i,
  /\.jsonl\.zstd$/i,
  /(^|\/)private(\/|$)/i,
]

/** 把任意用户输入压成 memoryRoot 下的相对路径；任何越界迹象返回 null。 */
export function normalizeRel(input) {
  if (typeof input !== 'string' || !input) return null
  if (input.includes('\0')) return null
  let s = input.trim().replace(/\\/g, '/')
  if (!s) return null
  if (s.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(s)) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return null // file: / http: 之类
  const out = []
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    out.push(seg)
  }
  if (!out.length) return null
  return out.join('/')
}

export function isAllowedRel(rel) {
  if (typeof rel !== 'string' || !rel) return false
  if (ROOT_FILES.has(rel)) return true
  if (REL_FORBIDDEN.some((re) => re.test(rel))) return false
  return REL_ALLOWED.some((re) => re.test(rel))
}

/** 白名单 + 绝对路径前缀 + realpath 三道关，返回可读的绝对路径。 */
async function jail(root, input) {
  const rel = normalizeRel(input)
  if (!rel) throw new PanelError('E_BAD_QUERY', '路径不合法', String(input ?? ''))
  if (!isAllowedRel(rel)) throw new PanelError('E_NOT_FOUND', '不在只读白名单内', rel)
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, rel.split('/').join(sep))
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new PanelError('E_NOT_FOUND', '路径越界', rel)
  }
  return { rel, abs, rootAbs }
}

async function assertInsideRoot(abs, rootAbs) {
  let realAbs
  let realRoot
  try {
    realAbs = await realpath(abs)
  } catch {
    return // 不存在时交给 readText 的 ENOENT 分支
  }
  try {
    realRoot = await realpath(rootAbs)
  } catch {
    return
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
    throw new PanelError('E_NOT_FOUND', '符号链接指向 jail 之外', abs)
  }
}

// ---------------------------------------------------------------------------
// 读文件
// ---------------------------------------------------------------------------

async function readText(root, input) {
  const { rel, abs, rootAbs } = await jail(root, input)
  let st
  try {
    st = await stat(abs)
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) throw new PanelError('E_NOT_FOUND', '文件不存在', rel)
    throw new PanelError('E_READ_FAILED', `stat 失败：${e && e.code ? e.code : 'unknown'}`, rel)
  }
  if (!st.isFile()) throw new PanelError('E_NOT_FOUND', '不是文件', rel)
  if (st.size > MAX_FILE_BYTES) {
    throw new PanelError('E_TOO_LARGE_FILE', `文件 ${st.size} B 超过 ${MAX_FILE_BYTES} B 上限`, rel)
  }
  await assertInsideRoot(abs, rootAbs)
  let text
  try {
    text = await readFile(abs, 'utf8')
  } catch (e) {
    throw new PanelError('E_READ_FAILED', `读取失败：${e && e.code ? e.code : 'unknown'}`, rel)
  }
  return { rel, abs, text, size: st.size, mtimeMs: st.mtimeMs, etag: etagOf(st) }
}

function etagOf(st) {
  const hash = createHash('sha1').update(`${Math.round(st.mtimeMs)}:${st.size}`).digest('hex').slice(0, 16)
  return `W/"${hash}"`
}

async function readIfExists(root, rel) {
  try {
    return await readText(root, rel)
  } catch (e) {
    if (e instanceof PanelError && (e.code === 'E_NOT_FOUND' || e.code === 'E_TOO_LARGE_FILE' || e.code === 'E_READ_FAILED')) return null
    if (e instanceof PanelError && e.code === 'E_BAD_QUERY') return null
    throw e
  }
}

async function readJsonIfExists(root, rel) {
  const f = await readIfExists(root, rel)
  if (!f) return null
  try {
    return JSON.parse(f.text)
  } catch {
    return null
  }
}

/**
 * sessionsRoot 自己的 jail：只放行 `<workspace>/<session>/(truncate|backups).json`。
 * 内存库的白名单是另一套（readText），两边不能混用——混用的结果就是扫描永远返回空。
 */
const SESSION_LEDGER = /^[^/\\]+[/\\][^/\\]+[/\\](truncate|truncate-visible|backups)\.json$/

async function readSessionJson(root, rel) {
  const clean = normalizeRel(rel)
  if (!clean || !SESSION_LEDGER.test(clean)) return null
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, clean.split('/').join(sep))
  if (!abs.startsWith(rootAbs + sep)) return null
  let st
  try {
    st = await stat(abs)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
  try {
    await assertInsideRoot(abs, rootAbs)
    return JSON.parse(await readFile(abs, 'utf8'))
  } catch {
    return null
  }
}

async function listDir(dir, filter) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((d) => d.isFile() && filter(d.name))
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return []
    throw e
  }
}

async function dirExists(dir) {
  try {
    const st = await stat(dir)
    return st.isDirectory()
  } catch {
    return false
  }
}

async function fileExists(file) {
  try {
    const st = await stat(file)
    return st.isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// frontmatter / 摘要
// ---------------------------------------------------------------------------

/** 简单 YAML：key: value，支持 "引号"、数字、true/false、null、[a, b]。 */
export function parseFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '')
  if (!src.startsWith('---')) return { frontmatter: {}, body: src, hasFrontmatter: false }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: {}, body: src, hasFrontmatter: false }
  const head = src.slice(3, end)
  let body = src.slice(end + 4)
  body = body.replace(/^[^\n]*\n?/, '')
  const frontmatter = {}
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    frontmatter[m[1]] = coerceYamlValue(m[2])
  }
  return { frontmatter, body, hasFrontmatter: true }
}

function coerceYamlValue(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim()
    return inner ? inner.split(',').map((x) => coerceYamlValue(x)) : []
  }
  if (v === 'null' || v === '~') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

function firstParagraph(body) {
  const lines = String(body || '').split(/\r?\n/)
  const buf = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) {
      if (buf.length) break
      continue
    }
    if (t.startsWith('#')) {
      if (buf.length) break
      continue
    }
    if (t.startsWith('---') || t.startsWith('```')) continue
    buf.push(t.replace(/^[>\-*+]\s+/, '').replace(/\*\*|`/g, ''))
    if (buf.join(' ').length > 160) break
  }
  const text = buf.join(' ').replace(/\s+/g, ' ').trim()
  return text.length > 120 ? `${text.slice(0, 118)}…` : text
}

function daysAgo(iso, now) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((now - t) / 86400000))
}

function flagsOf(card, now) {
  const salience = Number(card.salience) || 0
  const usedAt = card.lastUsed || card.date || null
  const age = usedAt ? daysAgo(usedAt, now) : null
  const flags = []
  if (salience >= 4) flags.push('high')
  if (age != null && age <= 3) flags.push('fresh')
  if (age != null && age > 60) flags.push('stale')
  if (Number(card.revisions) > 0) flags.push('revised')
  return { flags, ageDays: age }
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function toParams(query) {
  if (!query) return new URLSearchParams()
  if (query instanceof URLSearchParams) return query
  if (typeof query === 'string') return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)))
    else if (v !== undefined && v !== null) p.append(k, String(v))
  }
  return p
}

function clampInt(raw, def, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return { value: def, clamped: false }
  if (n < min) return { value: min, clamped: true }
  if (n > max) return { value: max, clamped: true }
  return { value: n, clamped: false }
}

function decodeCursor(raw) {
  if (!raw) return null
  try {
    const text = Buffer.from(String(raw), 'base64url').toString('utf8')
    const [path, mtime] = text.split('|')
    if (!path) return null
    return { path, mtimeMs: Number(mtime) || 0 }
  } catch {
    return null
  }
}

function encodeCursor(card) {
  return Buffer.from(`${card.path}|${Math.round(Date.parse(card.mtime) || 0)}`, 'utf8').toString('base64url')
}

// ---------------------------------------------------------------------------
// 隐私
// ---------------------------------------------------------------------------

const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|cookie|authorization|credential)/i

export function redact(value, depth = 0) {
  if (depth > 8) return '[depth]'
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) out[k] = '[redacted]'
      else out[k] = redact(v, depth + 1)
    }
    return out
  }
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…`
  return value
}

export function maskUtterance(raw, reveal = false) {
  const s = typeof raw === 'string' ? raw : ''
  if (!s) return { text: null, hash: null, truncated: false }
  const hash = createHash('sha256').update(s).digest('hex').slice(0, 8)
  const cap = reveal ? 200 : 80
  return { text: s.slice(0, cap), hash, truncated: s.length > cap }
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

const LAYER_DIRS = {
  semantic: 'topics',
  procedural: 'procedures',
  episodic: 'journal',
  archive: 'archive',
}

const LAYER_LABEL = {
  semantic: '语义记忆',
  procedural: '程序性记忆',
  episodic: '情景记忆',
  archive: '归档',
}

async function collectCards(root, layer, now) {
  const dirName = LAYER_DIRS[layer]
  if (!dirName) throw new PanelError('E_BAD_QUERY', `未知 layer：${layer}`)
  const dirRel = dirName.replace(/\\/g, '/')
  const files = await listDir(join(root, dirName), (n) => /\.md$/i.test(n) && !n.startsWith('.'))
  const out = []
  for (const f of files) {
    const rel = `${dirRel}/${f.name}`
    const fr = await readIfExists(root, rel)
    if (!fr) continue
    const { frontmatter, body } = parseFrontmatter(fr.text)
    const card = {
      id: rel,
      layer,
      layerLabel: LAYER_LABEL[layer],
      title: String(frontmatter.title || f.name.replace(/\.md$/i, '')),
      path: rel,
      date: frontmatter.date ? String(frontmatter.date) : null,
      salience: Number.isFinite(Number(frontmatter.salience)) ? Number(frontmatter.salience) : null,
      strength: Number.isFinite(Number(frontmatter.strength)) ? Number(frontmatter.strength) : null,
      lastUsed: frontmatter.last_used ? String(frontmatter.last_used) : null,
      revisions: Number.isFinite(Number(frontmatter.revisions)) ? Number(frontmatter.revisions) : 0,
      bytes: fr.size,
      mtime: new Date(fr.mtimeMs).toISOString(),
      excerpt: firstParagraph(body),
      flags: [],
    }
    const meta = flagsOf(card, now)
    card.flags = meta.flags
    card.ageDays = meta.ageDays
    out.push(card)
  }
  out.sort((a, b) => {
    const s = (Number(b.salience) || 0) - (Number(a.salience) || 0)
    if (s !== 0) return s
    return (Date.parse(b.mtime) || 0) - (Date.parse(a.mtime) || 0)
  })
  return out
}

// ---------------------------------------------------------------------------
// sessions 扫描（截断记录 / 备份）
// ---------------------------------------------------------------------------

let scanCache = { key: null, at: 0, value: null }

/**
 * 账本行：现行格式是 `{version:1,truncations:[...]}`；早期手工写的账本可能是
 * 顶层数组或 `{entries:[...]}`，读取侧一并认，写侧格式不受影响。
 */
function ledgerRows(parsed, key = 'truncations') {
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed[key])) return parsed[key]
  if (parsed && Array.isArray(parsed.entries)) return parsed.entries
  return []
}

function ledgerBasename(value) {
  if (typeof value !== 'string' || value === '') return null
  const parts = value.split(/[\\/]/)
  return parts[parts.length - 1] || null
}

function ledgerNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * `truncate-visible.json`（宿主可见对话截断账本）的一行。
 *
 * 字段别名是给旧格式留的：早期账本用 `time`/`turn`/`bytesBefore`，现行账本用
 * `at`/`cutTurn`/`beforeBytes`。两种都要能进页面，否则又变成“只显示一条旧账”。
 * 绝对路径不外泄：只留备份/归档文件名（与 truncate.json 页的口径一致）。
 */
function visibleTruncationItem(t, sid, ws) {
  if (!t || typeof t !== 'object') return null
  const at = t.at ?? t.time ?? t.ts ?? null
  const before = ledgerNumber(t.beforeBytes ?? t.bytesBefore ?? t.before) ?? 0
  const after = ledgerNumber(t.afterBytes ?? t.bytesAfter ?? t.after) ?? 0
  const cutTurn = ledgerNumber(t.cutTurn ?? t.turn)
  const cutSeq = ledgerNumber(t.cutSeq ?? t.seq)
  const cutSeq0 = ledgerNumber(t.cutIndex)
  return {
    id: `${sid}@visible:${at ?? cutTurn ?? 'unknown'}`,
    sessionId: sid,
    workspaceDir: ws,
    kind: 'visible',
    at,
    beforeBytes: before,
    afterBytes: after,
    // 可见截断按“消息”记账，事件列没有对应值；页面用 kind 区分后显示消息数。
    beforeEvents: null,
    afterEvents: null,
    cutSeq: cutSeq ?? cutSeq0,
    cutTurn,
    backup: ledgerBasename(t.backupPath ?? t.backup),
    backupSha256: null,
    savedBytes: Math.max(0, before - after),
    savedRatio: before > 0 ? Math.round(((before - after) / before) * 1000) / 1000 : null,
    derived: true,
    tool: typeof t.tool === 'string' ? t.tool : null,
    droppedTurns: ledgerNumber(t.droppedTurns),
    keptTurns: ledgerNumber(t.keptTurns),
    beforeMessages: ledgerNumber(t.beforeMessages),
    afterMessages: ledgerNumber(t.afterMessages),
    beforeTokens: ledgerNumber(t.beforeTokens),
    afterTokens: ledgerNumber(t.afterTokens),
    archive: ledgerBasename(t.archivePath ?? t.archive),
    beforeSha256: typeof t.beforeSha256 === 'string' ? t.beforeSha256 : null,
    afterSha256: typeof t.afterSha256 === 'string' ? t.afterSha256 : null,
  }
}

async function scanSessions(sessionsRoot) {
  const key = resolve(sessionsRoot)
  const now = Date.now()
  if (scanCache.key === key && now - scanCache.at < SCAN_TTL_MS) return scanCache.value

  const result = { sessionsScanned: 0, scanTruncated: false, truncations: [], backups: [], sessionDirs: {}, readable: false, error: null }
  if (!(await dirExists(key))) {
    result.error = 'sessionsRoot 不存在'
    scanCache = { key, at: now, value: result }
    return result
  }
  result.readable = true
  let workspaces = []
  try {
    workspaces = (await readdir(key, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  } catch (e) {
    result.error = `readdir 失败：${e && e.code ? e.code : 'unknown'}`
    scanCache = { key, at: now, value: result }
    return result
  }

  let budget = SESSION_WALK_BUDGET
  for (const ws of workspaces) {
    let sessions = []
    try {
      sessions = (await readdir(join(key, ws.name), { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    } catch {
      continue
    }
    for (const s of sessions) {
      if (budget-- <= 0) {
        result.scanTruncated = true
        break
      }
      result.sessionsScanned += 1
      const sid = s.name
      const dir = join(key, ws.name, sid)
      result.sessionDirs[sid] = dir
      const truncRel = `${ws.name}/${sid}/truncate.json`
      const visibleRel = `${ws.name}/${sid}/truncate-visible.json`
      const backRel = `${ws.name}/${sid}/backups.json`
      const trunc = await readSessionJson(key, truncRel)
      for (const t of ledgerRows(trunc)) {
        const before = Number(t.beforeBytes) || 0
        const after = Number(t.afterBytes) || 0
        result.truncations.push({
          id: `${sid}@${t.at}`,
          sessionId: sid,
          workspaceDir: ws.name,
          kind: 'ledger',
          at: t.at ?? null,
          beforeBytes: before,
          afterBytes: after,
          beforeEvents: Number(t.beforeEvents) || null,
          afterEvents: Number(t.afterEvents) || null,
          cutSeq: Number.isFinite(Number(t.cutSeq)) ? Number(t.cutSeq) : null,
          cutTurn: Number.isFinite(Number(t.cutTurn)) ? Number(t.cutTurn) : null,
          backup: t.backup ? t.backup.split(/[\\/]/).pop() : null,
          backupSha256: t.backupSha256 ?? null,
          savedBytes: Math.max(0, before - after),
          savedRatio: before > 0 ? Math.round(((before - after) / before) * 1000) / 1000 : null,
          derived: true,
        })
      }
      // 宿主可见对话截断（session_truncate_visible）记在单独一本账里。
      // 只读 truncate.json 会让最近一次可见截断永远上不了这一页（G1）。
      const visible = await readSessionJson(key, visibleRel)
      for (const v of ledgerRows(visible)) {
        const item = visibleTruncationItem(v, sid, ws.name)
        if (!item) continue
        if (!item.at && item.beforeBytes === 0 && item.afterBytes === 0 && item.cutTurn === null) continue
        result.truncations.push(item)
      }
      const back = await readSessionJson(key, backRel)
      if (back && Array.isArray(back.backups)) {
        for (const b of back.backups) {
          const fileName = b.file ? b.file.split(/[\\/]/).pop() : null
          let exists = false
          if (fileName) {
            try {
              const st = await stat(join(dir, fileName))
              exists = st.isFile()
            } catch {
              exists = false
            }
          }
          result.backups.push({
            sessionId: sid,
            workspaceDir: ws.name,
            file: fileName,
            size: Number(b.size) || null,
            createdAt: b.createdAt ?? null,
            sha256: b.sha256 ?? null,
            deletable: Boolean(b.deletable),
            exists,
          })
        }
      }
    }
    if (result.scanTruncated) break
  }

  result.truncations.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
  result.backups.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
  scanCache = { key, at: now, value: result }
  return result
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

async function buildSummary(cfg) {
  const root = resolve(cfg.memoryRoot)
  const now = Date.now()
  const warnings = []
  const sources = []

  const rootOk = await dirExists(root)
  sources.push({ id: 'memoryRoot', path: root, readable: rootOk })
  if (!rootOk) warnings.push({ code: 'W_ROOT_MISSING', message: `memoryRoot 不存在：${root}` })

  const sessionsRoot = resolve(cfg.sessionsRoot)
  const scan = await scanSessions(sessionsRoot)
  sources.push({ id: 'sessionsRoot', path: sessionsRoot, readable: scan.readable })
  if (!scan.readable) warnings.push({ code: 'W_SESSIONS_MISSING', message: `sessionsRoot 不可读：${sessionsRoot}` })
  if (scan.scanTruncated) warnings.push({ code: 'W_SCAN_BUDGET', message: `会话目录超过 ${SESSION_WALK_BUDGET} 个，本次只扫了前面一段` })

  const semantic = rootOk ? await collectCards(root, 'semantic', now) : []
  const episodic = rootOk ? await collectCards(root, 'episodic', now) : []
  const procedural = rootOk ? await collectCards(root, 'procedural', now) : []

  const state = rootOk ? (await readJsonIfExists(root, '.longlive/memory-state.json')) || (await readJsonIfExists(root, 'memory-state.json')) : null
  const audit = rootOk ? await readIfExists(root, '.longlive/audit.log') : null
  let auditLastAt = null
  if (audit) {
    const lines = audit.text.split(/\r?\n/).filter(Boolean)
    const last = lines[lines.length - 1]
    if (last) auditLastAt = last.split('\t')[0] || null
  }

  // 活体（.longlive/live/*.json）
  const live = []
  const liveDir = join(root, '.longlive', 'live')
  const liveFiles = rootOk ? await listDir(liveDir, (n) => n.endsWith('.json') && !n.includes('.stale-')) : []
  for (const f of liveFiles) {
    const row = await readJsonIfExists(root, `.longlive/live/${f.name}`)
    if (!row || typeof row !== 'object') continue
    live.push(normalizeLive(row, f.name, now))
  }
  live.sort((a, b) => (b.heartbeatAgeMs ?? 1e15) - (a.heartbeatAgeMs ?? 1e15))

  // 孤儿行：活体登记还在，但对应会话目录里没有 session.v4.jsonl.zstd。
  // 扫描被截断或 sessionsRoot 不可读时不猜，sessionFile 置 null，界面不标「无会话文件」。
  const sessionFileKnown = scan.readable && !scan.scanTruncated
  for (const row of live) {
    if (!sessionFileKnown) {
      row.sessionFile = null
      continue
    }
    const dir = scan.sessionDirs[row.sessionId]
    row.sessionFile = Boolean(dir) && (await fileExists(join(dir, 'session.v4.jsonl.zstd')))
  }

  const filterPresent = rootOk ? await dirExists(join(root, '.longlive', 'filter')) : false
  if (!filterPresent) warnings.push({ code: 'W_FILTER_ABSENT', message: '.longlive/filter/ 不存在，过滤器尚未实装' })
  if (!procedural.length) warnings.push({ code: 'W_NO_PROCEDURES', message: 'procedures/ 不存在或为空，第 4 层为空' })

  let filterDecisions = 0
  if (filterPresent) {
    const latest = await latestFile(join(root, '.longlive', 'filter'), /^decisions-.+\.jsonl$/i)
    if (latest) filterDecisions = await countJsonlAt(join(root, '.longlive', 'filter', latest.name))
  }
  // shadow 页读两处并合并（根目录是 1.1.x 旧位置，.longlive/ 是现行位置），
  // summary 的计数必须用同一口径：两处相加。旧代码在根文件为 0 时读了
  // .longlive/ 却没把返回值赋回 routerLines，导致 totals.shadowRecords 少算
  // 整整一份 .longlive/router-runtime.jsonl（G2）。
  let routerLines = 0
  for (const rel of ['router-runtime.jsonl', '.longlive/router-runtime.jsonl']) {
    routerLines += await countJsonlAt(join(root, rel))
  }
  const shadowRecords = routerLines + filterDecisions

  const tombstones = rootOk ? await readIfExists(root, 'tombstones.md') : null
  const tombstoneCount = tombstones ? (tombstones.text.match(/^##\s+/gm) || []).length : 0
  const epochFiles = rootOk ? await listDir(join(root, 'epochs'), (n) => /\.md$/i.test(n)) : []

  let indexed = 0
  const indexFile = rootOk ? await readIfExists(root, 'INDEX.md') : null
  if (indexFile) {
    const seen = new Set()
    for (const m of indexFile.text.matchAll(/(topics|journal|procedures)\/[^\s|)`]+\.md/g)) seen.add(m[0])
    indexed = seen.size
  }

  const totals = {
    cards: semantic.length,
    journalMonths: episodic.length,
    procedures: procedural.length,
    live: live.length,
    liveRunning: live.filter((x) => x.state === 'running').length,
    liveStale: live.filter((x) => x.state === 'stale').length,
    liveDead: live.filter((x) => x.state === 'dead').length,
    backups: scan.backups.length,
    truncations: scan.truncations.length,
    filterDecisions,
    shadowRecords,
  }

  const layers = [
    { id: 'working', index: 1, name: '工作记忆', path: '.longlive/live/ + sessions/**', count: totals.live, unit: '活体', health: totals.liveDead > 0 ? 'warn' : totals.live ? 'ok' : 'empty', note: '活体心跳不是记忆；已归档行不当记忆读' },
    { id: 'episodic', index: 2, name: '情景记忆', path: 'journal/YYYY-MM.md', count: totals.journalMonths, unit: '月', health: totals.journalMonths ? 'ok' : 'empty', note: '主脑手写，按月份归档' },
    { id: 'semantic', index: 3, name: '语义记忆', path: 'topics/*.md + engram 一句', count: totals.cards, unit: '卡', health: totals.cards ? 'ok' : 'empty', note: 'salience 唯一权威在卡 frontmatter' },
    { id: 'procedural', index: 4, name: '程序性记忆', path: 'procedures/*.md', count: totals.procedures, unit: '卡', health: totals.procedures ? 'ok' : 'empty', note: '目录不存在时为空，不是错误' },
    { id: 'index', index: 5, name: '索引与召回', path: 'INDEX.md 生成段 + bin/recall.mjs', count: indexed || totals.cards, unit: '卡已索引', health: indexed ? 'ok' : 'warn', note: state && state.indexBuiltAt ? `最近一次 memory_index：${state.indexBuiltAt}` : '没有 memory-state.json' },
    { id: 'archive', index: 6, name: '归档与封存', path: 'epochs/ · archive/ · tombstones.md', count: tombstoneCount + epochFiles.length, unit: '封存卡', health: tombstoneCount + epochFiles.length ? 'ok' : 'empty', note: state && Array.isArray(state.forgetRuns) ? `forgetRuns=${state.forgetRuns.length} · 归档理由记在 tombstones.md` : 'forgetRuns 未知 · 归档理由记在 tombstones.md' },
  ]

  return {
    status: 200,
    headers: {},
    body: {
      ok: true,
      readOnly: true,
      version: VERSION,
      root,
      generatedAt: new Date().toISOString(),
      freshness: {
        indexBuiltAt: state?.indexBuiltAt ?? null,
        lastConsolidated: state?.lastConsolidated ?? null,
        auditLastAt,
      },
      totals,
      layers,
      warnings,
      sources,
      live,
    },
  }
}

function normalizeLive(row, fileName, now) {
  const ttl = Number(row.ttlMs) > 0 ? Number(row.ttlMs) : 60000
  const hb = Date.parse(row.heartbeatAt || row.updatedAt || '')
  const age = Number.isFinite(hb) ? Math.max(0, now - hb) : null
  let state = typeof row.state === 'string' ? row.state : 'idle'
  if (age === null) state = 'dead'
  else if (age > ttl * 4) state = 'dead'
  else if (age > ttl * 2) state = 'stale'
  const sid = String(row.sessionId || fileName.replace(/\.json$/, ''))
  return {
    sessionId: sid,
    shortId: sid.replace(/^session-/, '').slice(0, 8),
    workspace: null,
    cwd: null,
    host: panelText(row.host, 120),
    state,
    declaredState: panelText(row.state, 40),
    turn: Number.isFinite(Number(row.turn)) ? Number(row.turn) : null,
    heartbeatAgeMs: age,
    ttlMs: ttl,
    goal: panelText(row.goal, 160),
    blockedOn: panelText(row.blocked_on, 160),
    queued: Array.isArray(row.queued) ? row.queued.map((x) => panelText(x, 120)).filter((x) => x !== null).slice(0, 5) : [],
    lastAction: row.last_action && typeof row.last_action === 'object' ? {
      at: panelText(row.last_action.at, 40),
      kind: panelText(row.last_action.kind, 40),
      detail: panelText(row.last_action.detail, 200),
    } : null,
    encodingWarning: false,
  }
}

// ---------------------------------------------------------------------------
// cards / card
// ---------------------------------------------------------------------------

async function buildCards(cfg, query) {
  const p = toParams(query)
  const layer = String(p.get('layer') || 'semantic')
  if (!LAYER_DIRS[layer]) throw new PanelError('E_BAD_QUERY', `layer 必须是 ${Object.keys(LAYER_DIRS).join('/')}`)
  const { value: limit, clamped } = clampInt(p.get('limit'), LIMIT_DEFAULT, 1, LIMIT_MAX)
  const q = String(p.get('q') || '').trim().toLowerCase()
  const cursor = decodeCursor(p.get('cursor'))
  const root = resolve(cfg.memoryRoot)
  if (!(await dirExists(root))) throw new PanelError('E_NOT_FOUND', `memoryRoot 不存在：${root}`)
  const all = await collectCards(root, layer, Date.now())
  const filtered = q
    ? all.filter((c) => `${c.title} ${c.path} ${c.excerpt}`.toLowerCase().includes(q))
    : all
  let start = 0
  if (cursor) {
    const idx = filtered.findIndex((c) => c.path === cursor.path)
    start = idx >= 0 ? idx + 1 : filtered.filter((c) => (Date.parse(c.mtime) || 0) > cursor.mtimeMs).length
  }
  const pageItems = filtered.slice(start, start + limit)
  const nextCursor = start + limit < filtered.length && pageItems.length ? encodeCursor(pageItems[pageItems.length - 1]) : null
  return {
    status: 200,
    headers: {},
    body: {
      ok: true,
      layer,
      layerLabel: LAYER_LABEL[layer],
      items: pageItems,
      page: {
        limit,
        clamped,
        returned: pageItems.length,
        total: filtered.length,
        nextCursor,
        hasMore: Boolean(nextCursor),
      },
    },
  }
}

async function buildCard(cfg, relPath) {
  const root = resolve(cfg.memoryRoot)
  const file = await readText(root, relPath)
  if (!/\.md$/i.test(file.rel)) throw new PanelError('E_NOT_FOUND', '只有 .md 卡可以取正文', file.rel)
  const { frontmatter, body } = parseFrontmatter(file.text)
  let truncReason = null
  let out = body
  const bytes = Buffer.byteLength(out, 'utf8')
  if (bytes > BODY_MAX_BYTES) {
    out = Buffer.from(out, 'utf8').subarray(0, BODY_MAX_BYTES).toString('utf8')
    truncReason = `bytes>${BODY_MAX_BYTES}`
  }
  const lines = out.split(/\r?\n/)
  if (lines.length > BODY_MAX_LINES) {
    out = lines.slice(0, BODY_MAX_LINES).join('\n')
    truncReason = truncReason ? `${truncReason}+lines>${BODY_MAX_LINES}` : `lines>${BODY_MAX_LINES}`
  }
  return {
    status: 200,
    headers: { etag: file.etag },
    body: {
      ok: true,
      id: file.rel,
      frontmatter,
      body: out,
      bytes: file.size,
      mtime: new Date(file.mtimeMs).toISOString(),
      truncated: Boolean(truncReason),
      truncationReason: truncReason,
    },
  }
}

// ---------------------------------------------------------------------------
// truncations
// ---------------------------------------------------------------------------

async function buildTruncations(cfg, query) {
  const p = toParams(query)
  const { value: limit, clamped } = clampInt(p.get('limit'), LIMIT_DEFAULT, 1, LIMIT_MAX)
  const session = p.get('session') ? String(p.get('session')) : null
  const sessionsRoot = resolve(cfg.sessionsRoot)
  const scan = await scanSessions(sessionsRoot)

  let items = scan.truncations
  let backups = scan.backups
  if (session) {
    items = items.filter((x) => x.sessionId === session || x.sessionId.endsWith(session))
    backups = backups.filter((x) => x.sessionId === session || x.sessionId.endsWith(session))
  }
  const total = items.length
  const visibleTotal = items.filter((x) => x.kind === 'visible').length
  const pageItems = items.slice(0, limit)

  const missing = scan.backups.filter((b) => b.exists === false).map((b) => `${b.sessionId}/${b.file}`)

  const current = []
  if (session) {
    const target = scan.backups.find((b) => b.sessionId === session || b.sessionId.endsWith(session))
    if (target) {
      const dir = join(sessionsRoot, target.workspaceDir, target.sessionId)
      for (const name of ['session.v4.jsonl.zstd']) {
        try {
          const st = await stat(join(dir, name))
          current.push({
            sessionId: target.sessionId,
            file: name,
            bytes: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
          })
        } catch {
          // 不存在的当前日志不写进 current
        }
      }
    }
  }

  return {
    status: 200,
    headers: {},
    body: {
      ok: true,
      sessionsScanned: scan.sessionsScanned,
      scanTruncated: scan.scanTruncated,
      kinds: { ledger: total - visibleTotal, visible: visibleTotal },
      items: pageItems,
      backups: backups.slice(0, limit),
      current: current[0] ?? null,
      missing,
      page: { limit, clamped, returned: pageItems.length, total, hasMore: total > limit },
    },
  }
}

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

function emptyMetrics() {
  return { total: 0, by: { remember: 0, archive_only: 0, human: 0, local_only: 0 }, queue: 0, privacyBlocked: 0, avgScore: null }
}

function computeFilterMetrics(items) {
  const metrics = emptyMetrics()
  metrics.total = items.length
  let sum = 0
  for (const it of items) {
    const target = String(it.target || 'unknown')
    metrics.by[target] = (metrics.by[target] || 0) + 1
    if (Number.isFinite(Number(it.score))) sum += Number(it.score)
    if (it.needsHuman) metrics.queue += 1
    if (it.privacy && it.privacy.verdict && it.privacy.verdict !== 'pass') metrics.privacyBlocked += 1
  }
  metrics.avgScore = items.length ? Math.round((sum / items.length) * 10) / 10 : null
  return metrics
}

async function latestFile(dir, re) {
  const files = await listDir(dir, (n) => re.test(n))
  if (!files.length) return null
  const withStat = []
  for (const f of files) {
    try {
      const st = await stat(join(dir, f.name))
      withStat.push({ name: f.name, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      continue
    }
  }
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withStat[0] || null
}

async function buildFilter(cfg, query) {
  const p = toParams(query)
  const { value: limit, clamped } = clampInt(p.get('limit'), LIMIT_DEFAULT, 1, LIMIT_MAX)
  const reveal = p.get('reveal') === '1'
  const target = p.get('target') ? String(p.get('target')) : null
  const root = resolve(cfg.memoryRoot)
  const dirAbs = join(root, '.longlive', 'filter')
  const present = await dirExists(dirAbs)

  if (!present) {
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        implemented: false,
        preview: true,
        dir: '.longlive/filter',
        reason: 'E_FILTER_NOT_INSTALLED',
        designDoc: cfg.designDoc ?? null,
        note: '过滤器设计稿未实装：这里没有真实决策记录，items 是客户端样例，用来确认实装后长什么样。',
        items: [],
        metrics: emptyMetrics(),
        queue: [],
        page: { limit, clamped, returned: 0, total: 0, hasMore: false },
      },
    }
  }

  const latest = await latestFile(dirAbs, /^decisions-.+\.jsonl$/i)
  let items = []
  let parseErrors = 0
  let truncated = false
  let sourceFile = null
  if (latest) {
    sourceFile = `.longlive/filter/${latest.name}`
    const tail = await readJsonlTail(join(dirAbs, latest.name), JSONL_TAIL_LINES)
    parseErrors = tail.bad
    truncated = tail.truncated
    for (const row of tail.rows) {
      const it = normalizeDecision(row, reveal)
      if (it) items.push(it)
    }
  }
  if (target) items = items.filter((x) => x.target === target)
  items.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
  const metrics = computeFilterMetrics(items)
  const queue = items
    .filter((x) => x.needsHuman || x.target === 'human' || (Number(x.score) >= 3 && Number(x.score) <= 5))
    .slice(0, limit)
    .map((x) => ({ unitId: x.unitId, ts: x.ts, score: x.score, target: x.target, reason: x.needsHuman ? 'needsHuman' : '3–5 分区间' }))

  return {
    status: 200,
    headers: {},
    body: {
      ok: true,
      implemented: true,
      preview: false,
      dir: '.longlive/filter',
      reason: null,
      designDoc: cfg.designDoc ?? null,
      note: items.length ? null : '过滤器已实装，但还没有决策记录',
      sourceFile,
      parseErrors,
      truncated,
      items: items.slice(0, limit),
      metrics,
      queue,
      page: { limit, clamped, returned: Math.min(items.length, limit), total: items.length, hasMore: items.length > limit },
    },
  }
}

// 前端只接受「能直接做 React child」的值：字符串 / 数字 / 布尔 / null。
// 对象、数组一律收成 null，绝不再把 decision 这类结构原样塞给渲染层。
function panelText(value, max = 120) {
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, max)
  return null
}

function decisionPanelFields(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return []
  const keys = ['matchedRule', 'ruleId', 'action', 'level', 'target', 'tool', 'needsHuman', 'confidence', 'failClosed']
  const out = []
  for (const key of keys) {
    if (decision[key] === undefined || decision[key] === null) continue
    const value = panelText(decision[key], 120)
    if (value !== null) out.push({ key, value })
  }
  if (Array.isArray(decision.errors)) {
    const errs = decision.errors.map((e) => panelText(e, 120)).filter((e) => e !== null)
    if (errs.length) out.push({ key: 'errors', value: errs.slice(0, 6).join(', ') })
  }
  return out
}

const DIMENSION_NAMES = {
  R1: '断言性',
  R2: '复用跨度',
  R3: '禁令/偏好',
  R4: '踩坑修法',
  R5: '决策/取代',
  R6: '去重',
  R7: '关系/身份',
  R8: '产物承载',
}

function normalizeDecision(row, reveal) {
  if (!row || typeof row !== 'object') return null
  const dims = Array.isArray(row.dims) ? row.dims.map((d) => {
    const id = panelText(d && d.id, 40)
    return {
      id,
      name: panelText(d && d.name, 40) ?? (id ? DIMENSION_NAMES[id] : null) ?? null,
      score: Number(d && d.score) || 0,
      max: Number(d && d.max) || 0,
      why: panelText(d && d.why, 120) || '',
    }
  }) : []
  const privacy = row.privacy && typeof row.privacy === 'object'
    ? { verdict: panelText(row.privacy.verdict, 40) ?? 'pass', marker: panelText(row.privacy.marker, 80) }
    : { verdict: 'pass', marker: null }
  const localOnly = panelText(row.target, 40) === 'local_only' || privacy.verdict === 'blocked'
  const masked = maskUtterance(row.excerpt ?? '', reveal)
  return {
    ts: panelText(row.ts, 40),
    unitId: panelText(row.unitId, 80),
    turn: Number.isFinite(Number(row.turn)) ? Number(row.turn) : null,
    target: panelText(row.target, 40) ?? 'unknown',
    score: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
    dims,
    hardSignals: Array.isArray(row.hardSignals) ? row.hardSignals.map((x) => panelText(x, 120)).filter((x) => x !== null).slice(0, 8) : [],
    privacy,
    needsHuman: Boolean(row.needsHuman),
    human: row.human && typeof row.human === 'object'
      ? { verdict: panelText(row.human.verdict, 40) ?? 'pending', note: panelText(row.human.note, 120) ?? '' }
      : { verdict: 'pending', note: '' },
    source: row.source && typeof row.source === 'object'
      ? {
        file: panelText(row.source.file, 200),
        lineStart: Number.isFinite(Number(row.source.lineStart)) ? Number(row.source.lineStart) : null,
        lineEnd: Number.isFinite(Number(row.source.lineEnd)) ? Number(row.source.lineEnd) : null,
      }
      : null,
    excerpt: localOnly ? null : masked.text,
    excerptHash: masked.hash,
    dedup: row.dedup && typeof row.dedup === 'object'
      ? { nearestUnitId: panelText(row.dedup.nearestUnitId, 80), delta: Number(row.dedup.delta) || 0 }
      : null,
  }
}

// ---------------------------------------------------------------------------
// shadow
// ---------------------------------------------------------------------------

async function readJsonlTail(abs, maxLines) {
  let st
  try {
    st = await stat(abs)
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) throw new PanelError('E_NOT_FOUND', '文件不存在', abs)
    throw new PanelError('E_READ_FAILED', `stat 失败：${e && e.code ? e.code : 'unknown'}`, abs)
  }
  let text
  let truncatedBySize = false
  if (st.size <= MAX_FILE_BYTES) {
    text = await readFile(abs, 'utf8')
  } else {
    truncatedBySize = true
    const fh = await open(abs, 'r')
    try {
      const len = Math.min(st.size, MAX_FILE_BYTES)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, st.size - len)
      text = buf.toString('utf8')
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    } finally {
      await fh.close()
    }
  }
  // 有人的编辑器会给第一行加 UTF-8 BOM；先剥掉，否则第一行会被当成坏 JSON。
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim())
  const tail = lines.slice(-maxLines)
  const rows = []
  let bad = 0
  for (const line of tail) {
    try {
      rows.push(JSON.parse(line))
    } catch {
      bad += 1
    }
  }
  return { rows, bad, lines: lines.length, truncated: lines.length > maxLines || truncatedBySize, size: st.size, mtimeMs: st.mtimeMs }
}

// ---------------------------------------------------------------------------
// recall · 本轮想起
//
// 数据源是 <memoryRoot>/.longlive/recall-log.jsonl，一行一轮：
//   {at, sessionId, turn, injected:[{id,title,score,reason}], blocked:[{id,title,reason}]}
//
// 这个文件由召回钩子写；后端可能还没实装，所以「文件不存在 / 空文件 / 读不了 /
// 坏行」都必须返回 200 的空态，而不是 404 或异常。面板是只读窗口，不能因为
// 日志还没生出来就崩掉整页。
// ---------------------------------------------------------------------------

const RECALL_LOG_REL = '.longlive/recall-log.jsonl'

function emptyRecallMetrics() {
  return { turns: 0, injected: 0, blocked: 0, sessions: 0, lastAt: null, parseErrors: 0 }
}

function recallScore(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeRecallEntry(raw, kind) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = panelText(raw.id, 120)
  const title = panelText(raw.title, 200)
  if (id === null && title === null) return null
  const out = { id, title, reason: panelText(raw.reason, 300) }
  if (kind === 'injected') out.score = recallScore(raw.score)
  return out
}

function normalizeRecallRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const at = panelText(raw.at, 60)
  const parsedAt = at === null ? NaN : Date.parse(at)
  const ts = Number.isFinite(parsedAt) ? parsedAt : null
  const sessionId = panelText(raw.sessionId, 120)
  const turnNum = Number(raw.turn)
  const turn = raw.turn !== null && raw.turn !== undefined && raw.turn !== '' && Number.isFinite(turnNum) ? turnNum : null
  const injected = []
  if (Array.isArray(raw.injected)) {
    for (const x of raw.injected) {
      const it = normalizeRecallEntry(x, 'injected')
      if (it) injected.push(it)
    }
  }
  const blocked = []
  if (Array.isArray(raw.blocked)) {
    for (const x of raw.blocked) {
      const it = normalizeRecallEntry(x, 'blocked')
      if (it) blocked.push(it)
    }
  }
  // 只丢掉完全没有结构的行（比如 `{}`）；空数组的轮次仍保留，
  // 那代表「这一轮查过召回，但一条都没命中」，本身是信息。
  if (at === null && sessionId === null && turn === null && !injected.length && !blocked.length) return null
  return { at, ts, sessionId, turn, injected, blocked, injectedCount: injected.length, blockedCount: blocked.length }
}

function computeRecallMetrics(items, parseErrors) {
  const metrics = emptyRecallMetrics()
  const sessions = new Set()
  metrics.parseErrors = parseErrors || 0
  for (const it of items) {
    metrics.turns += 1
    metrics.injected += it.injected.length
    metrics.blocked += it.blocked.length
    if (it.sessionId) sessions.add(it.sessionId)
    if (it.ts !== null && (metrics.lastAt === null || it.ts > Date.parse(metrics.lastAt))) metrics.lastAt = it.at
  }
  metrics.sessions = sessions.size
  return metrics
}

async function buildRecall(cfg, query) {
  const p = toParams(query)
  const { value: limit, clamped } = clampInt(p.get('limit'), LIMIT_DEFAULT, 1, LIMIT_MAX)
  const root = resolve(cfg.memoryRoot)
  const abs = join(root, '.longlive', 'recall-log.jsonl')

  let st = null
  try {
    st = await stat(abs)
  } catch (e) {
    if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) {
      throw new PanelError('E_READ_FAILED', `stat 失败：${e && e.code ? e.code : 'unknown'}`, abs)
    }
  }

  const emptyPage = { limit, clamped, returned: 0, total: 0, hasMore: false }

  // 文件还没写：这是正常状态，不是 404。
  if (!st) {
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        readOnly: true,
        implemented: true,
        present: false,
        readable: true,
        sourceFile: RECALL_LOG_REL,
        note: '还没有召回日志（.longlive/recall-log.jsonl 不存在）。召回钩子写入后，这一页会自动出现记录。',
        items: [],
        metrics: emptyRecallMetrics(),
        parseErrors: 0,
        truncated: false,
        page: emptyPage,
      },
    }
  }

  let tail
  try {
    tail = await readJsonlTail(abs, JSONL_TAIL_LINES)
  } catch (e) {
    // 文件存在但读不了（权限、是目录、正好被删）：按「暂时读不到」返回 200，
    // 不把整页拖进 500。页面会显示空态并给一句可重试的说明。
    const code = e instanceof PanelError ? e.code : (e && e.code) || 'E_READ_FAILED'
    return {
      status: 200,
      headers: {},
      body: {
        ok: true,
        readOnly: true,
        implemented: true,
        present: true,
        readable: false,
        readError: code,
        sourceFile: RECALL_LOG_REL,
        size: st.size,
        mtimeMs: st.mtimeMs,
        note: `召回日志存在，但这次读不出来（${code}）。刷新可重试；这一页不会因此崩溃。`,
        items: [],
        metrics: emptyRecallMetrics(),
        parseErrors: 0,
        truncated: false,
        page: emptyPage,
      },
    }
  }

  const items = []
  for (const row of tail.rows) {
    const it = normalizeRecallRow(row)
    if (it) items.push(it)
  }
  // JSONL 是追加写的（旧→新）：先倒转，再按 at 稳定降序。
  // 没有 at / at 坏掉的行排在最后，并保留日志里的倒序位置。
  items.reverse()
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0))

  const metrics = computeRecallMetrics(items, tail.bad)
  const total = items.length
  const pageItems = items.slice(0, limit)
  return {
    status: 200,
    headers: {},
    body: {
      ok: true,
      readOnly: true,
      implemented: true,
      present: true,
      readable: true,
      sourceFile: RECALL_LOG_REL,
      size: tail.size,
      mtimeMs: tail.mtimeMs,
      note: total ? null : '召回日志已存在，但还没有任何一轮记录（文件为空或全是坏行）。',
      items: pageItems,
      metrics,
      parseErrors: tail.bad,
      truncated: tail.truncated,
      page: { limit, clamped, returned: pageItems.length, total, hasMore: total > limit },
    },
  }
}

async function buildShadow(cfg, query) {
  const p = toParams(query)
  const { value: limit, clamped } = clampInt(p.get('limit'), LIMIT_DEFAULT, 1, LIMIT_MAX)
  const reveal = p.get('reveal') === '1'
  const onlySource = p.get('source') ? String(p.get('source')) : null
  const onlyAction = p.get('action') ? String(p.get('action')) : null
  const root = resolve(cfg.memoryRoot)

  const files = []
  const items = []
  let mode = 'off'
  let modeSource = null

  const routerCandidates = [
    { rel: 'router-runtime.jsonl', abs: join(root, 'router-runtime.jsonl') },
    { rel: '.longlive/router-runtime.jsonl', abs: join(root, '.longlive', 'router-runtime.jsonl') },
  ]
  // The panel contract checks both locations. Read both and merge instead of
  // stopping at the first hit: an older 1.1.x file at the top level must not
  // hide the live 1.2.x stream under .longlive/.
  let modeStamp = -1
  for (const cand of routerCandidates) {
    if (!(await isFile(cand.abs))) continue
    try {
      const tail = await readJsonlTail(cand.abs, JSONL_TAIL_LINES)
      files.push({ path: cand.rel, lines: tail.lines, bytes: tail.size, mtime: new Date(tail.mtimeMs).toISOString(), parseErrors: tail.bad })
      for (const row of tail.rows) {
        const it = normalizeShadow(row, 'router', reveal)
        if (it) items.push(it)
        if (row && typeof row.mode === 'string' && row.mode) {
          const stamp = Date.parse(row.ts) || 0
          if (stamp >= modeStamp) {
            mode = row.mode
            modeSource = cand.rel
            modeStamp = stamp
          }
        }
      }
    } catch (e) {
      files.push({ path: cand.rel, lines: 0, bytes: null, mtime: null, error: e instanceof PanelError ? e.code : 'E_READ_FAILED' })
    }
  }

  const filterDir = join(root, '.longlive', 'filter')
  const latest = (await dirExists(filterDir)) ? await latestFile(filterDir, /^decisions-.+\.jsonl$/i) : null
  if (latest) {
    try {
      const tail = await readJsonlTail(join(filterDir, latest.name), JSONL_TAIL_LINES)
      files.push({ path: `.longlive/filter/${latest.name}`, lines: tail.lines, bytes: tail.size, mtime: new Date(tail.mtimeMs).toISOString(), parseErrors: tail.bad })
      for (const row of tail.rows) {
        const it = normalizeShadow(row, 'maf', reveal)
        if (it) items.push(it)
      }
    } catch (e) {
      files.push({ path: `.longlive/filter/${latest.name}`, lines: 0, bytes: null, mtime: null, error: e instanceof PanelError ? e.code : 'E_READ_FAILED' })
    }
  }

  let filtered = items
  if (onlySource) filtered = filtered.filter((x) => x.source === onlySource)
  if (onlyAction) filtered = filtered.filter((x) => x.action === onlyAction)
  filtered.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))

  return {
    status: 200,
    headers: {},
    body: {
      ok: true,
      mode: files.length ? mode : 'off',
      modeSource,
      implemented: files.length > 0,
      files,
      items: filtered.slice(0, limit),
      metrics: computeShadowMetrics(filtered),
      page: { limit, clamped, returned: Math.min(filtered.length, limit), total: filtered.length, hasMore: filtered.length > limit },
    },
  }
}

function normalizeShadow(row, source, reveal) {
  if (!row || typeof row !== 'object') return null
  const tsText = panelText(row.ts ?? row.at ?? row.time, 40)
  const call = row.call && typeof row.call === 'object' ? row.call : null
  // call.args 永不返回（契约 0.7）；只保留工具名。
  const utterance = row.input?.utterance ?? row.utterance ?? null
  const masked = maskUtterance(utterance, reveal)
  const subject = row.subject ?? row.tool ?? call?.name ?? row.unitId ?? null
  // decision 是对象，不能直接给前端做 React child；action 只取字符串。
  const decision = row.decision && typeof row.decision === 'object' && !Array.isArray(row.decision) ? row.decision : null
  const guardVerdict = row.guard && typeof row.guard === 'object' ? panelText(row.guard.verdict, 40) : null
  const target = panelText(row.target, 40) ?? panelText(decision && decision.target, 40)
  const needsHuman = row.needsHuman !== undefined
    ? Boolean(row.needsHuman)
    : Boolean(decision && decision.needsHuman)
  // 1.2+ records carry the contract action at the top level. Older runtime
  // rows only had the semantic verb in decision.action, so derive allow/deny/ask
  // from guard/needsHuman instead of leaking `memory.distillPropose` into
  // metrics. Filter rows (source=maf) use their target as the action.
  const rawAction = panelText(row.action, 40)
  let action = ['allow', 'deny', 'ask'].includes(rawAction) ? rawAction : null
  if (action === null && source === 'maf') action = target
  if (action === null && guardVerdict === 'deny') action = 'deny'
  if (action === null && needsHuman) action = 'ask'
  if (action === null && source === 'router') action = 'allow'
  const decisionFields = decisionPanelFields(decision)
  const decisionSummary = decisionFields.length
    ? decisionFields.map((f) => `${f.key}=${f.value}`).join(' · ').slice(0, 300)
    : null
  const confidence = row.confidence !== undefined
    ? Number(row.confidence)
    : Number(decision && decision.confidence)
  const totalMs = row.totalMs !== undefined
    ? Number(row.totalMs)
    : Number(row.outcome && row.outcome.ms)
  const errors = Array.isArray(row.errors)
    ? row.errors
    : (Array.isArray(decision && decision.errors) ? decision.errors : [])
  return {
    id: panelText(row.id, 120) ?? (source === 'maf' && row.unitId ? `maf:${row.unitId}` : `${source}:${tsText ?? 'unknown'}`),
    source,
    ts: tsText,
    subject: panelText(subject, 80),
    action,
    target,
    decisionSummary,
    decisionFields,
    level: panelText(row.level, 20) ?? panelText(decision && decision.level, 20),
    matchedRule: panelText(row.matchedRule ?? row.rule, 120) ?? panelText(decision && (decision.matchedRule ?? decision.ruleId), 120),
    confidence: Number.isFinite(confidence) ? confidence : null,
    needsHuman,
    guard: row.guard && typeof row.guard === 'object'
      ? { verdict: panelText(row.guard.verdict, 40), reason: panelText(row.guard.reason, 200) }
      : null,
    risk: row.risk && typeof row.risk === 'object'
      ? {
        level: panelText(row.risk.level, 20) ?? 'none',
        reasons: Array.isArray(row.risk.reasons) ? row.risk.reasons.map((x) => panelText(x, 120)).filter((x) => x !== null).slice(0, 6) : [],
      }
      : { level: 'none', reasons: [] },
    status: panelText(row.status, 40) ?? panelText(row.outcome && row.outcome.status, 40) ?? 'ok',
    totalMs: Number.isFinite(totalMs) ? totalMs : null,
    errors: errors.map((x) => panelText(x, 120)).filter((x) => x !== null).slice(0, 6),
    callText: panelText(row.callText, 200) ?? panelText(call && call.text, 200) ?? masked.text,
    utteranceHash: panelText(row.utteranceHash, 80) ?? masked.hash,
    parseError: Boolean(row.parseError),
    // 契约 §6 要求 raw；只放判定现场，绝不放 call.args / utterance / input。
    raw: {
      ts: tsText,
      mode: panelText(row.mode, 20),
      tool: panelText(row.tool, 80),
      decision: decision
        ? {
          matchedRule: panelText(decision.matchedRule, 120),
          ruleId: panelText(decision.ruleId, 120),
          action: panelText(decision.action, 80),
          level: panelText(decision.level, 20),
          target: panelText(decision.target, 40),
          tool: panelText(decision.tool, 80),
          needsHuman: Boolean(decision.needsHuman),
          confidence: Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : null,
          failClosed: Boolean(decision.failClosed),
          errors: Array.isArray(decision.errors) ? decision.errors.map((x) => panelText(x, 120)).filter((x) => x !== null).slice(0, 6) : [],
        }
        : null,
      guard: row.guard && typeof row.guard === 'object'
        ? { verdict: panelText(row.guard.verdict, 40) ?? null, reason: panelText(row.guard.reason, 200) ?? null }
        : null,
      risk: row.risk && typeof row.risk === 'object'
        ? {
          level: panelText(row.risk.level, 20) ?? 'none',
          reasons: Array.isArray(row.risk.reasons) ? row.risk.reasons.map((x) => panelText(x, 120)).filter((x) => x !== null).slice(0, 6) : [],
        }
        : null,
      outcome: row.outcome && typeof row.outcome === 'object'
        ? {
          status: panelText(row.outcome.status, 40) ?? null,
          code: panelText(row.outcome.code, 80) ?? null,
          ms: Number.isFinite(Number(row.outcome.ms)) ? Number(row.outcome.ms) : null,
        }
        : null,
    },
  }
}

function computeShadowMetrics(items) {
  const metrics = {
    router: { total: 0, allow: 0, deny: 0, ask: 0, needsHuman: 0, guardReject: 0, avgTotalMs: null },
    maf: { total: 0, byTarget: {}, byAction: {}, byRule: {}, avgConfidence: null, needsHuman: 0 },
    byRule: [],
    byAction: [],
  }
  const ruleCount = new Map()
  const actionCount = new Map()
  let ms = 0
  let msCount = 0
  let confidenceSum = 0
  let confidenceCount = 0
  for (const it of items) {
    if (it.matchedRule) ruleCount.set(it.matchedRule, (ruleCount.get(it.matchedRule) || 0) + 1)
    if (it.action) actionCount.set(it.action, (actionCount.get(it.action) || 0) + 1)
    if (it.source === 'router') {
      const r = metrics.router
      r.total += 1
      if (it.action === 'allow') r.allow += 1
      else if (it.action === 'deny') r.deny += 1
      else if (it.action === 'ask') r.ask += 1
      if (it.needsHuman) r.needsHuman += 1
      if (it.guard && it.guard.verdict === 'deny') r.guardReject += 1
      if (it.totalMs != null) {
        ms += it.totalMs
        msCount += 1
      }
    } else if (it.source === 'maf') {
      const r = metrics.maf
      r.total += 1
      r.needsHuman += it.needsHuman ? 1 : 0
      if (it.target) r.byTarget[it.target] = (r.byTarget[it.target] || 0) + 1
      if (it.action) r.byAction[it.action] = (r.byAction[it.action] || 0) + 1
      if (it.matchedRule) r.byRule[it.matchedRule] = (r.byRule[it.matchedRule] || 0) + 1
      if (it.confidence != null && Number.isFinite(it.confidence)) {
        confidenceSum += it.confidence
        confidenceCount += 1
      }
    }
  }
  metrics.router.avgTotalMs = msCount ? Math.round((ms / msCount) * 10) / 10 : null
  metrics.maf.avgConfidence = confidenceCount ? Math.round((confidenceSum / confidenceCount) * 100) / 100 : null
  metrics.byRule = [...ruleCount.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count)
  metrics.byAction = [...actionCount.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count)
  return metrics
}

async function isFile(abs) {
  try {
    return (await stat(abs)).isFile()
  } catch {
    return false
  }
}

async function countJsonlAt(abs) {
  try {
    const tail = await readJsonlTail(abs, JSONL_TAIL_LINES)
    return tail.lines
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// 常驻 Router（只读窗口）
//
// 数据只来自 <memoryRoot>/.longlive/router/ 下的三个只读来源：
//   status.json / board.json / proposals/*.json
// 文件不存在、字段缺失、JSON 坏掉都不是错误：能显示多少显示多少，
// 缺的那一块在界面上降级成「未启用 / 暂无」，不影响其它页签。
// ---------------------------------------------------------------------------

const ROUTER_PROPOSAL_LIMIT = 200
const ROUTER_ITEM_LIMIT = 50
const ROUTER_ALERT_LIMIT = 8

/**
 * 面板的显示映射，不是协议（DESIGN §6.5 / §9 冻结接缝）：
 *   - `alerts[].severity` 由 Router 给，原样透传 info / warn / error，界面只做配色；
 *   - `warnings[]` 是开放枚举：已知码查这张表给一句中文，未知码原样显示，
 *     不过滤、不丢弃、不改写、不报解析错；「告警 N 条」的 N 就是 warnings.length。
 */
const ROUTER_WARNING_TEXT = {
  BOARD_STALE: { title: '共享板过期', detail: 'board.json 没有按时重建，焦点和交接可能不是最新的（status.board.stale）。' },
  BOARD_TRUNCATED: { title: '共享板被截断', detail: '共享板超过大小上限，部分字段已被裁掉。' },
  BOARD_RESET: { title: '共享板被重置', detail: 'board.json 找不到或读不出来，Router 从空板重新建了一份。' },
  FOCUS_LIMITED: { title: '焦点条数受限', detail: '焦点条目超过上限，板上只保留了前面几条。' },
  LIVE_ROWS_SATURATED: { title: '活体登记已满', detail: '活跃会话行达到上限，新会话暂时不能登记。' },
  LIVE_UNREADABLE: { title: '活体登记不可读', detail: '重建共享板时有会话心跳读不出来，活跃列表可能不完整。' },
  WAL_BROKEN: { title: 'WAL 链断裂', detail: 'write-ahead 日志的 prev/hash 不连续，Router 已改用快照并标 degraded。' },
  RESTORE_REQUIRED: { title: '需要人工恢复', detail: 'apply 读回不符，目标文件保留快照与三份 sha，等主人裁决。' },
  RESTORE_FAILED: { title: '回滚/恢复失败', detail: '写坏后回滚也失败，目标文件可能处于未知状态。' },
  OWNER_WRITE_RACE: { title: '复核发现被并发改写', detail: '第 6 步复核失败：文件在 apply 期间被别的写者改过，本次已中止且未覆盖任何人。' },
  QUEUE_STARVATION: { title: '队列可能饿死', detail: '有提案等待超过 routerStarvationAlertMs（默认 600s），aging 可能没生效。' },
  BLOCKED_ON_USER_EXPIRED: { title: '等人裁决已过期', detail: '有一条「等主人确认」的提案超过时限，Router 已按过期处理。' },
  WAKE_QUOTA: { title: '唤醒额度用尽', detail: '今日唤醒次数达到上限，Router 不再主动唤醒。' },
  WAKE_DEGRADED: { title: '唤醒降级', detail: '唤醒通道不可用，Router 降级运行。' },
  INJECT_QUOTA: { title: '注入额度用尽', detail: '共享提示注入达到配额，本轮不再注入。' },
  TICK_RECLAIM_BUSY: { title: 'tick 回收忙', detail: '上一轮 tick 的租约还在回收中，本轮顺延。' },
}

function routerText(value, max = 240) {
  if (typeof value === 'string') {
    const s = value.trim()
    return s ? s.slice(0, max) : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') {
    const parts = []
    for (const key of ['code', 'reason', 'message', 'detail', 'summary']) {
      const s = routerText(value[key], max)
      if (s) parts.push(s)
    }
    return parts.length ? parts.join(' · ').slice(0, max) : null
  }
  return null
}

function routerIso(value) {
  if (typeof value !== 'string' || !value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function routerNum(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function routerRatio(used, cap) {
  const u = routerNum(used)
  const c = routerNum(cap)
  if (u === null || c === null || c <= 0) return null
  return Math.max(0, Math.min(1, u / c))
}

const PROPOSAL_LABEL = {
  pending: '待主人确认',
  approved: '已批准，等执行',
  applying: '执行中（持有写者租约）',
  done: '已完成',
  conflict: '冲突',
  rejected: '已拒绝',
  rolled_back: '已回滚',
  superseded: '已被新提案取代',
}

const PROPOSAL_TONE = {
  pending: 'warn',
  approved: 'warn',
  applying: 'solid',
  done: 'ok',
  conflict: 'bad',
  rejected: 'mute',
  rolled_back: 'bad',
  superseded: 'mute',
}

const PROPOSAL_ORDER = { pending: 0, approved: 1, applying: 2, conflict: 3 }

/**
 * 提案只出安全字段（DESIGN §6.5）：id/ticket/op/target/title/status/priority/时间/风险。
 * content / rationale / baseSha / evidence 永远不读进出口——面板不做预审，也不把正文搬进界面。
 */
function normalizeProposal(row, fileName, now) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const id = routerText(row.id, 120) || String(fileName || '').replace(/\.json$/i, '')
  if (!id) return null
  const status = routerText(row.status, 40) || 'unknown'
  const origin = row.origin && typeof row.origin === 'object' ? row.origin : {}
  const createdAt = routerIso(row.createdAt)
  const ageMs = createdAt ? Math.max(0, now - Date.parse(createdAt)) : routerNum(row.ageMs)
  return {
    id,
    ticket: routerText(row.ticket, 40),
    status,
    statusLabel: PROPOSAL_LABEL[status] || status,
    tone: PROPOSAL_TONE[status] || 'mute',
    op: routerText(row.op, 60),
    originSessionId: routerText(origin.sessionId, 120),
    target: routerText(row.target, 240),
    title: routerText(row.title, 160),
    priority: routerNum(row.priority),
    effectivePriority: routerNum(row.effectivePriority),
    attempts: routerNum(row.attempts),
    deadlineAt: routerIso(row.deadlineAt),
    risk: routerText(row.risk, 20),
    ageMs,
    createdAt,
    updatedAt: routerIso(row.updatedAt),
  }
}

function countProposals(items) {
  const counts = { pending: 0, approved: 0, applying: 0, done: 0, conflict: 0, rejected: 0, rolled_back: 0, superseded: 0, other: 0, total: items.length }
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status) && item.status !== 'total') counts[item.status] += 1
    else counts.other += 1
  }
  return counts
}

function oldestWaitingAge(items, now) {
  let oldest = null
  for (const item of items) {
    if (['done', 'rejected', 'rolled_back', 'superseded'].includes(item.status)) continue
    const t = item.createdAt ? Date.parse(item.createdAt) : NaN
    if (!Number.isFinite(t)) continue
    const age = Math.max(0, now - t)
    if (oldest === null || age > oldest) oldest = age
  }
  return oldest
}

/**
 * 顶层 warnings / board.warnings 统一成 [{code, known, label, detail, source}]。
 * code 原样保留（未知码也保留），known=false 表示不在面板文案表里；
 * 去重按大写比较，顺序按 Router 给的顺序（契约里已稳定排序），不重排、不丢弃。
 */
function normalizeWarningCodes(list, source) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const entry of list) {
    const raw = typeof entry === 'string'
      ? entry
      : routerText(entry && (entry.code || entry.warning || entry.id), 80)
    const code = String(raw || '').trim()
    if (!code) continue
    const key = code.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    const known = ROUTER_WARNING_TEXT[key]
    out.push({
      code: code.slice(0, 80),
      known: Boolean(known),
      label: known ? known.title : code.slice(0, 80),
      detail: known ? known.detail : null,
      source,
    })
    if (out.length >= 50) break
  }
  return out
}

/**
 * alerts[]：只做类型收口，不改语义。severity 原样透传（契约是 info|warn|error，
 * 未来加值也照原样显示，面板不把它翻译成颜色以外的任何东西）。
 */
function normalizeRouterAlerts(raw) {
  const list = raw && Array.isArray(raw.alerts) ? raw.alerts : []
  const out = []
  for (const entry of list.slice(0, ROUTER_ALERT_LIMIT)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const code = routerText(entry.code, 80)
    const severity = routerText(entry.severity, 16).toLowerCase()
    out.push({
      code: code || 'ROUTER_ALERT',
      severity: severity || 'info',
      message: routerText(entry.message, 240) || routerText(entry.detail, 240) || null,
      at: routerIso(entry.at),
    })
  }
  return out
}

function normalizeRouterStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  const model = obj(raw.model)
  const today = obj(raw.today)
  const run = obj(raw.run)
  const tickQueue = obj(raw.tickQueue)
  const queue = obj(raw.queue)
  const board = obj(raw.board)
  const proposals = obj(raw.proposals)
  const propQueue = obj(proposals.queue)
  const writer = obj(propQueue.writer)
  const lease = obj(raw.lease)
  const wal = obj(raw.wal)
  const wake = obj(raw.wake)
  const shared = obj(raw.shared)
  const lastReport = obj(raw.lastReport)
  const files = obj(raw.files)

  // provider 只给两位布尔（DESIGN §9）：字符串/明细一律不出门，面板自然也不展示模型名与凭据。
  const providerRaw = raw.provider
  const provider = providerRaw && typeof providerRaw === 'object' && !Array.isArray(providerRaw)
    ? { configured: providerRaw.configured === true, missing: providerRaw.missing === true }
    : null

  const leaseSince = routerIso(lease.since)
  const leaseHeldMs = routerNum(lease.heldMs) ?? (leaseSince ? Math.max(0, Date.now() - Date.parse(leaseSince)) : null)

  const blocked = []
  if (Array.isArray(propQueue.blocked)) {
    for (const entry of propQueue.blocked.slice(0, 8)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      blocked.push({
        ticket: routerText(entry.ticket, 40),
        reason: routerText(entry.reason, 200),
        since: routerIso(entry.since),
      })
    }
  }

  return {
    state: routerText(raw.state, 40),
    reason: routerText(raw.reason, 240),
    since: routerIso(raw.since),
    runId: routerText(raw.runId, 120),
    provider,
    // model 只保留 auto 一个 boolean：resolved / resolvedAt / candidates 按 §6.5 不出面板出口。
    model: { auto: typeof model.auto === 'boolean' ? model.auto : null },
    autonomy: routerText(raw.autonomy, 40),
    agentMode: typeof raw.agentMode === 'boolean' ? raw.agentMode : null,
    lastTickAt: routerIso(raw.lastTickAt),
    nextTickAt: routerIso(raw.nextTickAt),
    heartbeatAt: routerIso(raw.heartbeatAt),
    today: {
      day: routerText(today.day, 40),
      usedTokens: routerNum(today.usedTokens),
      reservedTokens: routerNum(today.reservedTokens),
      capTokens: routerNum(today.capTokens),
      ratio: routerRatio(today.usedTokens, today.capTokens),
    },
    run: {
      usedTokens: routerNum(run.usedTokens),
      capTokens: routerNum(run.capTokens),
      ratio: routerRatio(run.usedTokens, run.capTokens),
    },
    // v2.3：tick 任务队列（旧名 queue）与提案五键 queue 是两个字段，这里分开收口，前端也分开展示。
    tickQueue: Object.keys(tickQueue).length
      ? { pending: routerNum(tickQueue.pending), invalid: routerNum(tickQueue.invalid), oldestAgeMs: routerNum(tickQueue.oldestAgeMs) }
      : null,
    queue: Object.keys(queue).length
      ? {
        pending: routerNum(queue.pending),
        queued: routerNum(queue.queued),
        applying: routerNum(queue.applying),
        blockedOnUser: routerNum(queue.blockedOnUser),
        expired: routerNum(queue.expired),
      }
      : null,
    board: Object.keys(board).length
      ? {
        seq: routerNum(board.seq),
        generatedAt: routerIso(board.generatedAt),
        activeSessions: routerNum(board.activeSessions),
        unknownSessions: routerNum(board.unknownSessions),
        focusVisible: routerNum(board.focusVisible),
        stale: typeof board.stale === 'boolean' ? board.stale : null,
      }
      : null,
    proposals: Object.keys(proposals).length
      ? {
        doneToday: routerNum(proposals.doneToday),
        conflicts: routerNum(proposals.conflicts),
        superseded: routerNum(proposals.superseded),
        queue: Object.keys(propQueue).length
          ? {
            seqCounter: routerNum(propQueue.seqCounter),
            depth: routerNum(propQueue.depth),
            etaMs: routerNum(propQueue.etaMs),
            starvation: typeof propQueue.starvation === 'boolean' ? propQueue.starvation : null,
            writer: Object.keys(writer).length
              ? {
                ticket: routerText(writer.ticket, 40),
                proposalId: routerText(writer.proposalId, 120),
                sessionId: routerText(writer.sessionId, 120),
                since: routerIso(writer.since),
              }
              : null,
            blocked,
          }
          : null,
      }
      : null,
    lease: Object.keys(lease).length
      ? {
        active: typeof lease.active === 'boolean' ? lease.active : null,
        holder: routerText(lease.holder, 80),
        since: leaseSince,
        heldMs: leaseHeldMs,
        renewals: routerNum(lease.renewals),
        expiresAt: routerIso(lease.expiresAt),
      }
      : null,
    wal: Object.keys(wal).length
      ? {
        lastSeq: routerNum(wal.lastSeq),
        lastAt: routerIso(wal.lastAt),
        bytes: routerNum(wal.bytes),
        segments: routerNum(wal.segments),
        broken: typeof wal.broken === 'boolean' ? wal.broken : null,
      }
      : null,
    wake: Object.keys(wake).length
      ? {
        enabled: typeof wake.enabled === 'boolean' ? wake.enabled : null,
        lastAttemptAt: routerIso(wake.lastAttemptAt),
        todayCount: routerNum(wake.todayCount),
        cooldownRemainingMs: routerNum(wake.cooldownRemainingMs),
        lastError: routerText(wake.lastError, 200),
      }
      : null,
    shared: Object.keys(shared).length
      ? {
        hintTokensLast: routerNum(shared.hintTokensLast),
        injectedTurns: routerNum(shared.injectedTurns),
        injectedTokensToday: routerNum(shared.injectedTokensToday),
        skipped: routerNum(shared.skipped),
        readyProposals: routerNum(shared.readyProposals),
        lastInjectAt: routerIso(shared.lastInjectAt),
        liveRows: routerNum(shared.liveRows),
        unknownSessions: routerNum(shared.unknownSessions),
      }
      : null,
    lastError: routerText(raw.lastError, 240),
    lastReport: Object.keys(lastReport).length
      ? { at: routerIso(lastReport.at), summary: routerText(lastReport.summary, 200) }
      : null,
    files: {
      vault: routerText(files.vault, 300),
      board: routerText(files.board, 300),
      audit: routerText(files.audit, 300),
    },
  }
}

function normalizeRouterBoard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const arr = (v) => (Array.isArray(v) ? v : [])
  const pulse = raw.pulse && typeof raw.pulse === 'object' ? raw.pulse : {}
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {}
  // v2.3：focus 只给 sessionId / goal / updatedAt，state/kind/host/declared 一律不出面板出口。
  const focus = []
  for (const entry of arr(raw.focus).slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue
    focus.push({
      sessionId: routerText(entry.sessionId, 64),
      goal: routerText(entry.goal, 80),
      updatedAt: routerIso(entry.updatedAt),
    })
  }
  const timeline = []
  for (const entry of arr(raw.timeline).slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue
    timeline.push({
      at: routerIso(entry.at),
      kind: routerText(entry.kind, 40),
      sessionId: routerText(entry.sessionId, 120),
      ref: routerText(entry.ref, 160),
      summary: routerText(entry.summary, 200),
    })
  }
  const pulseLease = pulse.lease && typeof pulse.lease === 'object' && !Array.isArray(pulse.lease) ? pulse.lease : null
  return {
    seq: routerNum(raw.seq),
    generatedAt: routerIso(raw.generatedAt),
    source: {
      liveRows: routerNum(source.liveRows),
      proposals: routerNum(source.proposals),
      scanMs: routerNum(source.scanMs),
    },
    focus,
    timeline,
    // 旧名 pendingProposals / writerLocked 在 v2.3 已改名，这里按冻结接缝只读新名。
    pulse: {
      active: routerNum(pulse.active),
      running: routerNum(pulse.running),
      blocked: routerNum(pulse.blocked),
      unknownSessions: routerNum(pulse.unknownSessions),
      queuedProposals: routerNum(pulse.queuedProposals),
      approvedProposals: routerNum(pulse.approvedProposals),
      blockedOnUser: routerNum(pulse.blockedOnUser),
      readyProposals: routerNum(pulse.readyProposals),
      queueHead: routerText(pulse.queueHead, 40),
      lease: pulseLease
        ? {
          active: typeof pulseLease.active === 'boolean' ? pulseLease.active : null,
          holder: routerText(pulseLease.holder, 80),
          expiresAt: routerIso(pulseLease.expiresAt),
        }
        : null,
      lastApplyAt: routerIso(pulse.lastApplyAt),
    },
    warnings: arr(raw.warnings).slice(0, 8).map((w) => (typeof w === 'string' ? w.slice(0, 120) : routerText(w, 200))).filter(Boolean),
    hash: routerText(raw.hash, 80),
  }
}

async function buildRouter(cfg) {
  const root = resolve(cfg.memoryRoot)
  const now = Date.now()
  const routerRel = '.longlive/router'
  const statusRel = `${routerRel}/status.json`
  const boardRel = `${routerRel}/board.json`

  const statusFilePath = join(root, '.longlive', 'router', 'status.json')
  const boardFilePath = join(root, '.longlive', 'router', 'board.json')
  const statusFilePresent = await fileExists(statusFilePath)
  const boardFilePresent = await fileExists(boardFilePath)
  const rawStatus = await readJsonIfExists(root, statusRel)
  const rawBoard = await readJsonIfExists(root, boardRel)

  const notes = []
  if (statusFilePresent && !rawStatus) notes.push('status.json 存在但读不出来（不是合法 JSON 或超过单文件读取上限）。')
  if (boardFilePresent && !rawBoard) notes.push('board.json 存在但读不出来（不是合法 JSON 或超过单文件读取上限）。')
  if (!statusFilePresent) notes.push('没有 .longlive/router/status.json：常驻 Router 未安装或未启用，这一页只保留只读窗口，不影响其它页签。')

  const proposalDir = join(root, '.longlive', 'router', 'proposals')
  const proposalNames = (await listDir(proposalDir, (name) => /\.json$/i.test(name))).map((f) => f.name).sort()
  const picked = proposalNames.slice(0, ROUTER_PROPOSAL_LIMIT)
  const items = []
  let unreadable = 0
  for (const name of picked) {
    const row = await readJsonIfExists(root, `${routerRel}/proposals/${name}`)
    const item = row ? normalizeProposal(row, name, now) : null
    if (item) items.push(item)
    else unreadable += 1
  }
  if (unreadable > 0) notes.push(`${unreadable} 个提案文件读不出来，已跳过；其余照常显示。`)
  if (proposalNames.length > picked.length) notes.push(`提案目录有 ${proposalNames.length} 个文件，这一页只看前 ${picked.length} 个。`)

  const source = items.length ? 'proposals' : 'none'

  items.sort((a, b) => {
    const pa = PROPOSAL_ORDER[a.status] ?? 4
    const pb = PROPOSAL_ORDER[b.status] ?? 4
    if (pa !== pb) return pa - pb
    return (b.ageMs ?? -1) - (a.ageMs ?? -1)
  })

  const counts = countProposals(items)
  const oldest = oldestWaitingAge(items, now)

  const status = normalizeRouterStatus(rawStatus)
  const board = normalizeRouterBoard(rawBoard)
  // status.warnings 是冻结契约的权威来源（开放枚举，原样保留未知码）；
  // board.warnings 是共享板文件自己的诊断码，单独一列，不混进 warnings 的条数。
  const warnings = normalizeWarningCodes(rawStatus && rawStatus.warnings, 'status.warnings')
  const boardWarnings = normalizeWarningCodes(rawBoard && rawBoard.warnings, 'board.warnings')
  const alerts = normalizeRouterAlerts(rawStatus)

  return {
    status: 200,
    headers: {},
    body: {
      ok: true,
      readOnly: true,
      version: VERSION,
      root,
      generatedAt: new Date().toISOString(),
      enabled: Boolean(statusFilePresent && rawStatus),
      present: {
        status: statusFilePresent,
        board: boardFilePresent,
        proposals: proposalNames.length > 0,
      },
      paths: {
        status: statusRel,
        board: boardRel,
        proposals: `${routerRel}/proposals/`,
      },
      status,
      board,
      proposals: {
        source,
        countsFrom: items.length ? 'proposals' : 'none',
        counts,
        oldestAgeMs: oldest,
        items,
        limit: ROUTER_ITEM_LIMIT,
        total: proposalNames.length,
        truncated: proposalNames.length > picked.length,
        unreadable,
      },
      alerts,
      warnings,
      boardWarnings,
      notes,
    },
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export const ROUTES = ['summary', 'cards', 'card', 'truncations', 'filter', 'shadow', 'router', 'recall']

/**
 * memoryRoot 默认值：与 dsh-session-longlive 本体一致，走标准位置 ~/.dsh/longlive-memory。
 * 本机私货不参与默认判断——像 H:\dsh-memory 这种手写库只作为「显式配置」的示例：
 *   显式 config > DSH_LONGLIVE_MEMORY_ROOT / DSH_MEM > ~/.dsh/longlive-memory
 * 别的机器/系统装完不用改任何东西；本机要用 H:\dsh-memory 时在 cordis.patch.yml 里写 config。
 */
export function defaultMemoryRoot() {
  const fromEnv = process.env.DSH_LONGLIVE_MEMORY_ROOT || process.env.DSH_MEM
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh', 'longlive-memory')
}

export function createPanel(overrides = {}) {
  const cfg = {
    memoryRoot: defaultMemoryRoot(),
    sessionsRoot: join(homedir(), '.dsh', 'sessions'),
    designDoc: fileURLToPath(new URL('../../DESIGN.md', import.meta.url)),
    ...overrides,
  }

  async function handle(route, query) {
    try {
      switch (route) {
        case 'summary':
          return await buildSummary(cfg)
        case 'cards':
          return await buildCards(cfg, query)
        case 'card': {
          let rel
          if (typeof query === 'string') {
            rel = query
            try {
              rel = decodeURIComponent(query)
            } catch {
              rel = query
            }
          } else {
            rel = String(query?.id ?? '')
          }
          return await buildCard(cfg, rel)
        }
        case 'truncations':
          return await buildTruncations(cfg, query)
        case 'filter':
          return await buildFilter(cfg, query)
        case 'shadow':
          return await buildShadow(cfg, query)
        case 'router':
          return await buildRouter(cfg)
        case 'recall':
          return await buildRecall(cfg, query)
        default:
          throw new PanelError('E_NOT_FOUND', `未知接口：${route}`, String(route))
      }
    } catch (e) {
      if (e instanceof PanelError) return fail(e.code, e.message, e.path)
      return fail('E_READ_FAILED', `未捕获错误：${e && e.message ? e.message : 'unknown'}`)
    }
  }

  async function handleHttp(req, res) {
    const method = String(req.method || 'GET').toUpperCase()
    if (method === 'OPTIONS') {
      // DESIGN §6.5（1218 行）：OPTIONS 只回 Allow: GET, HEAD，不回错误体。
      send(res, 405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }, null, false)
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      // DESIGN §6.5：非 GET/HEAD 一律 405，码固定 E_METHOD_NOT_ALLOWED，Allow 只声明 GET/HEAD。
      const body = { ok: false, error: { code: 'E_METHOD_NOT_ALLOWED', message: '只支持 GET/HEAD' } }
      send(res, 405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body, method === 'HEAD')
      return
    }
    let url
    try {
      url = new URL(String(req.url || '/'), 'http://127.0.0.1')
    } catch {
      send(res, 400, jsonHeaders(), { ok: false, error: { code: 'E_BAD_QUERY', message: 'URL 解析失败' } }, method === 'HEAD')
      return
    }
    const pathname = url.pathname
    let sub
    try {
      sub = decodeURIComponent(pathname.slice(ROUTE.length))
    } catch {
      send(res, 404, jsonHeaders(), { ok: false, error: { code: 'E_NOT_FOUND', message: '路径编码不合法' } }, method === 'HEAD')
      return
    }
    sub = sub.replace(/^\/+|\/+$/g, '')

    let result
    const cardMatch = /^card\/(.+)$/.exec(sub)
    if (cardMatch) {
      result = await handle('card', cardMatch[1])
    } else if (ROUTES.includes(sub)) {
      result = await handle(sub, url.searchParams)
    } else {
      result = fail('E_NOT_FOUND', '未知路由', sub ? `/${sub}` : ROUTE)
    }

    const headers = { ...jsonHeaders(), ...(result.headers || {}) }
    if (method === 'GET' && result.status === 200 && headers.etag) {
      const inm = req.headers?.['if-none-match']
      if (inm && String(inm).split(',').map((s) => s.trim()).includes(headers.etag)) {
        send(res, 304, { etag: headers.etag, 'cache-control': 'no-store' }, null, true)
        return
      }
    }
    send(res, result.status, headers, result.body, method === 'HEAD')
  }

  return { config: cfg, routes: ROUTES.slice(), handle, handleHttp }
}

function jsonHeaders() {
  return { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
}

function send(res, status, headers, body, headOnly) {
  const payload = body === null ? '' : JSON.stringify(body)
  const buf = Buffer.from(payload, 'utf8')
  try {
    res.writeHead(status, { ...headers, 'content-length': String(buf.length) })
    if (headOnly) res.end()
    else res.end(buf)
  } catch {
    try {
      res.destroy()
    } catch {
      /* 宿主已关连接 */
    }
  }
}

// ---------------------------------------------------------------------------
// 宿主侧挂载
// ---------------------------------------------------------------------------

export const name = 'dsh-longlive-panel'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const panel = createPanel(config)
  const webServer = ctx?.webServer ?? (typeof ctx?.get === 'function' ? ctx.get('webServer') : null)
  if (!webServer || typeof webServer.register !== 'function') {
    ctx?.logger?.warn?.('[dsh-longlive-panel] 当前 profile 没有 webServer，面板不挂 HTTP 路由')
    return
  }
  const register = () => webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => { panel.handleHttp(req, res) },
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'dsh-longlive-panel: read-only memory palace routes')
  } else {
    register()
  }
}

export const __test = {
  normalizeRel,
  isAllowedRel,
  parseFrontmatter,
  redact,
  maskUtterance,
  computeFilterMetrics,
  computeShadowMetrics,
  ROUTE,
  MAX_FILE_BYTES,
  LIMIT_MAX,
}
