// Small, shared JSONL log rotation used by the truncation diagnostics.
//
// The logs this plugin appends (auto-truncate.log, hot-truncate-diag.jsonl) are
// evidence, not an unbounded ledger. Rotation is deliberately local and dumb:
//   * size: rotate before an append when the current file is at/over maxBytes;
//   * date: rotate when the current file was last written on an older local day;
//   * retention: keep at most maxFiles rotated siblings and drop ones older
//     than maxAgeDays.
// No clock/glob dependency and no winston/pino dependency: the host may run
// this from a read-only-ish profile, and a diagnostics append must stay
// best-effort.

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_LOG_ROTATION = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxAgeDays: 14,
  maxFiles: 5,
  rotateDaily: true,
})

export function normalizeLogRotation(options = {}) {
  const maxBytes = Number.isFinite(Number(options.maxBytes))
    ? Math.max(64 * 1024, Number(options.maxBytes))
    : DEFAULT_LOG_ROTATION.maxBytes
  const maxAgeDays = Number.isFinite(Number(options.maxAgeDays))
    ? Math.max(0, Number(options.maxAgeDays))
    : DEFAULT_LOG_ROTATION.maxAgeDays
  const maxFiles = Number.isFinite(Number(options.maxFiles))
    ? Math.max(1, Math.floor(Number(options.maxFiles)))
    : DEFAULT_LOG_ROTATION.maxFiles
  return {
    maxBytes,
    maxAgeDays,
    maxFiles,
    rotateDaily: options.rotateDaily !== false,
  }
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

function stamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return new Date().toISOString().replace(/[-:]/gu, '').slice(0, 15)
  return `${dateKey(date)}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`
}

function rotatedPrefix(file) {
  const ext = path.extname(file) || ''
  return path.join(path.dirname(file), path.basename(file, ext))
}

function rotatedTarget(file, now) {
  const ext = path.extname(file) || ''
  const prefix = rotatedPrefix(file)
  const tag = stamp(now)
  let target = `${prefix}.${tag}${ext}`
  for (let n = 1; fs.existsSync(target); n += 1) target = `${prefix}.${tag}-${n}${ext}`
  return target
}

function listRotated(file) {
  const dir = path.dirname(file)
  const base = path.basename(file, path.extname(file))
  const ext = path.extname(file)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const re = new RegExp(`^${escaped}\\.(\\d{8}-\\d{6})(?:-\\d+)?${ext.replace('.', '\\.')}$`, 'u')
  return names
    .map((name) => ({ name, match: re.exec(name) }))
    .filter((row) => row.match)
    .map((row) => {
      const full = path.join(dir, row.name)
      let mtimeMs = 0
      try { mtimeMs = fs.statSync(full).mtimeMs } catch { /* raced */ }
      return { file: full, stamp: row.match[1], mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function pruneRotatedLogs(file, options = {}, now = Date.now()) {
  const policy = normalizeLogRotation(options)
  const rows = listRotated(file)
  const removed = []
  const cutoff = policy.maxAgeDays > 0 ? now - policy.maxAgeDays * 86_400_000 : null
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const tooOld = cutoff !== null && row.mtimeMs > 0 && row.mtimeMs < cutoff
    if (i >= policy.maxFiles || tooOld) {
      try {
        fs.unlinkSync(row.file)
        removed.push(row.file)
      } catch {
        /* a file locked by another reader is left for the next append */
      }
    }
  }
  return removed
}

/**
 * Rotate one log file if size/date policy says so. Returns the rotated target
 * (or null). Throws only on a real filesystem error; callers that treat logs as
 * best-effort catch it.
 */
export function rotateLogIfNeeded(file, options = {}, now = Date.now()) {
  const policy = normalizeLogRotation(options)
  let stat
  try {
    stat = fs.statSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const tooBig = stat.size >= policy.maxBytes
  const oldDay = policy.rotateDaily && stat.size > 0 && dateKey(stat.mtime) !== dateKey(now)
  if (!tooBig && !oldDay) return null
  const target = rotatedTarget(file, now)
  fs.renameSync(file, target)
  pruneRotatedLogs(file, policy, now)
  return target
}

/**
 * Append one JSON line, rotating first when needed. Returns the current path,
 * whether a rotation happened, and the rotated target. The line is written with
 * a single appendFileSync after rotation so concurrent readers never see a
 * partial JSON line from this helper.
 */
export function appendJsonlRotated(file, entry, options = {}, now = Date.now()) {
  const policy = normalizeLogRotation(options)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const rotatedTo = rotateLogIfNeeded(file, policy, now)
  const line = `${JSON.stringify(entry)}\n`
  fs.appendFileSync(file, line, 'utf8')
  return {
    ok: true,
    path: file,
    bytes: Buffer.byteLength(line),
    rotated: rotatedTo !== null,
    rotatedTo,
  }
}
