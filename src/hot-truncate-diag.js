// hot-truncate-diag.jsonl — durable diagnostic rows for hot-truncate archives.
//
// 1.8.1-rc.7 (audit P1-6): the historical file at
// <memoryRoot>/.longlive/hot-truncate-diag.jsonl contains engine load/plan rows
// (stage: module-load / cis-skip / ...) and stopped on 2026-11-06. The archive
// step wrote no row at all, so 300+ files under .longlive/hot-truncate/ could not
// be judged one by one. This module appends one stage:"archive" row for both
// writers (the in-host hot-truncate engine and the out-of-app visible-truncate
// CLI) and keeps the same historical file so "last updated" is meaningful.
//
// Rotation: shared log-rotation policy (size and local day; bounded files/age).
// Never contains question/answer text: ids, counts, byte sizes, cut coordinates,
// archive path and failure reason only.

import fs from 'node:fs'
import path from 'node:path'

import { appendJsonlRotated, normalizeLogRotation } from './log-rotation.js'

export const HOT_TRUNCATE_DIAG_DIR = '.longlive';
export const HOT_TRUNCATE_DIAG_FILE = 'hot-truncate-diag.jsonl'

export function hotTruncateDiagPath(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot.trim() === '') return ''
  // Keep the historical root-level file name: it already contains the engine's
  // module-load/plan diagnostics and stopped on 2026-11-06. The fix must append
  // archive rows here (not start a second logs/ file) so "last updated" is
  // meaningful again. Rows written by this version carry stage:"archive".
  return path.join(path.resolve(memoryRoot.trim()), HOT_TRUNCATE_DIAG_DIR, HOT_TRUNCATE_DIAG_FILE)
}

export function hotTruncateDiagOptions(autoTruncate = {}) {
  return normalizeLogRotation({
    maxBytes: autoTruncate.logMaxBytes,
    maxAgeDays: autoTruncate.logMaxAgeDays,
    maxFiles: autoTruncate.logMaxFiles,
    rotateDaily: autoTruncate.logRotateDaily,
  })
}

/**
 * Append one diagnostic row. Always best-effort: diagnostics must never turn a
 * successful truncation into a failed one. The caller receives ok:false and the
 * error code so auto-truncate can warn through logger.
 */
export function appendHotTruncateDiag(memoryRoot, row, options = {}, now = Date.now()) {
  const file = hotTruncateDiagPath(memoryRoot)
  if (file === '') return { ok: false, path: '', error: 'E_NO_MEMORY_ROOT' }
  try {
    const entry = {
      schema: 'longlive/hot-truncate-diag/v1',
      at: new Date(now).toISOString(),
      stage: 'archive',
      ...row,
    }
    const written = appendJsonlRotated(file, entry, options, now)
    return { ok: true, ...written }
  } catch (error) {
    return { ok: false, path: file, error: String(error?.code ?? error?.message ?? error) }
  }
}

/** Read current + rotated diag rows newest-first for health/panel output. */
export function readHotTruncateDiag(memoryRoot, { limit = 20 } = {}) {
  const file = hotTruncateDiagPath(memoryRoot)
  if (file === '') return { ok: false, path: '', rows: [], total: 0, corrupt: 0, error: 'E_NO_MEMORY_ROOT' }
  const dir = path.dirname(file)
  const stem = path.basename(file, '.jsonl')
  const candidates = []
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === path.basename(file) || (name.startsWith(`${stem}.`) && name.endsWith('.jsonl'))) {
        candidates.push(path.join(dir, name))
      }
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, path: file, rows: [], total: 0, corrupt: 0 }
    return { ok: false, path: file, rows: [], total: 0, corrupt: 0, error: String(error?.code ?? error?.message ?? error) }
  }
  const rows = []
  let corrupt = 0
  for (const candidate of candidates) {
    let text = ''
    try { text = fs.readFileSync(candidate, 'utf8') } catch { continue }
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { corrupt += 1 }
    }
  }
  rows.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
  return {
    ok: true,
    path: file,
    total: rows.length,
    corrupt,
    rows: rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 20))),
  }
}
