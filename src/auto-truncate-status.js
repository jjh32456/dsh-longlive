// auto-truncate-status.json — operator-visible health for the automatic
// visible-truncation loop (1.8.1-rc.7, audit P1-6 / P1-5).
//
// Before this file, the only evidence was append-only auto-truncate.log: a
// dryrun mode, an over-threshold session, an error and an infeasible plan all
// looked the same unless an operator parsed 40+ JSON lines. This module keeps a
// small, atomic status document that the panel/STATUS surface can read, and
// mirrors it into <memoryRoot>/.longlive/status.json under `autoTruncate` so an
// existing panel reader sees it without a new route.
//
// Shape:
//   { schema, at, mode, enabled, thresholds,
//     over: { count, maxTokens: { sessionId, tokens, turns, turn, at } },
//     counters: { evaluations, over, error, infeasible, dryrunPlanned, ... },
//     lastOutcome, lastError, lastInfeasible, warning }
//
// The file is diagnostics, not a decision input: every write failure returns
// {ok:false} and callers warn; nothing here may fail a truncation.

import fs from 'node:fs'
import path from 'node:path'

export const AUTO_TRUNCATE_STATUS_DIR = '.longlive'
export const AUTO_TRUNCATE_STATUS_FILE = 'auto-truncate-status.json'

const COUNTER_KEYS = Object.freeze([
  'evaluations', 'over', 'below', 'error', 'infeasible', 'logged', 'planned',
  'requestWritten', 'requestPending', 'requestFailed', 'noop', 'skipped', 'dryrun',
])

export function autoTruncateStatusPath(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot.trim() === '') return ''
  return path.join(path.resolve(memoryRoot.trim()), AUTO_TRUNCATE_STATUS_DIR, AUTO_TRUNCATE_STATUS_FILE)
}

export function readAutoTruncateStatus(memoryRoot) {
  const file = autoTruncateStatusPath(memoryRoot)
  if (file === '') return { ok: false, path: '', status: null, error: 'E_NO_MEMORY_ROOT' }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, path: file, status: null, error: 'E_CORRUPT' }
    }
    return { ok: true, path: file, status: parsed }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, path: file, status: null }
    return { ok: false, path: file, status: null, error: String(error?.code ?? error?.message ?? error) }
  }
}

function atomicJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
    return { ok: false, error }
  }
}

function panelStatusPath(memoryRoot) {
  return path.join(path.resolve(memoryRoot.trim()), AUTO_TRUNCATE_STATUS_DIR, 'status.json')
}

/** Merge `autoTruncate` into status.json without dropping engineMismatch. */
function mergePanelStatus(memoryRoot, status) {
  const file = panelStatusPath(memoryRoot)
  let current = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') current = {}
  }
  current.autoTruncate = status
  return atomicJson(file, current)
}

function normalizeCounters(previous) {
  const counters = {}
  for (const key of COUNTER_KEYS) counters[key] = Number.isFinite(previous?.[key]) ? Math.max(0, Math.floor(previous[key])) : 0
  return counters
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Number(value) : null
}

/**
 * Record one evaluation outcome.
 *
 * @param {string} memoryRoot
 * @param {object} facts
 * @param {string} facts.mode
 * @param {boolean} facts.enabled
 * @param {object} facts.thresholds
 * @param {object} [facts.delta] counter increments, e.g. {evaluations:1, over:1}
 * @param {string} [facts.outcome]
 * @param {object} [facts.overSample] { sessionId, tokens, turns, turn, at }
 * @param {object} [facts.error] { code, message, sessionId, at }
 * @param {object} [facts.infeasible] { code, reason, sessionId, at }
 * @param {string} [facts.warning]
 * @param {object} [options] { now }
 */
export function recordAutoTruncateStatus(memoryRoot, facts = {}, options = {}) {
  const file = autoTruncateStatusPath(memoryRoot)
  if (file === '') return { ok: false, path: '', status: null, error: 'E_NO_MEMORY_ROOT' }
  const now = options.now ?? Date.now()
  const previous = readAutoTruncateStatus(memoryRoot).status ?? {}
  const counters = normalizeCounters(previous.counters)
  for (const [key, value] of Object.entries(facts.delta ?? {})) {
    if (!Number.isFinite(value) || value === 0) continue
    counters[key] = Math.max(0, (counters[key] ?? 0) + Math.floor(value))
  }

  const previousOver = previous.over && typeof previous.over === 'object' ? previous.over : {}
  const overSessions = previousOver.sessions && typeof previousOver.sessions === 'object' && !Array.isArray(previousOver.sessions)
    ? { ...previousOver.sessions }
    : {}
  const over = {
    count: Number.isFinite(previousOver.count) ? Math.max(0, Math.floor(previousOver.count)) : Object.keys(overSessions).length,
    maxTokens: previousOver.maxTokens ?? null,
    sessions: overSessions,
  }
  if (facts.overSample) {
    const sample = {
      sessionId: facts.overSample.sessionId ?? null,
      tokens: numberOrNull(facts.overSample.tokens),
      turns: numberOrNull(facts.overSample.turns),
      turn: numberOrNull(facts.overSample.turn),
      at: facts.overSample.at ?? new Date(now).toISOString(),
    }
    if (sample.sessionId) overSessions[sample.sessionId] = { tokens: sample.tokens, turns: sample.turns, turn: sample.turn, at: sample.at }
    over.count = Object.keys(overSessions).length
    if (!over.maxTokens || (sample.tokens ?? -1) > (over.maxTokens.tokens ?? -1)) over.maxTokens = sample
  }

  const status = {
    schema: 'longlive/auto-truncate-status/v1',
    at: new Date(now).toISOString(),
    mode: facts.mode ?? previous.mode ?? null,
    enabled: facts.enabled ?? previous.enabled ?? null,
    thresholds: facts.thresholds ?? previous.thresholds ?? null,
    over,
    counters,
    lastOutcome: facts.outcome ?? previous.lastOutcome ?? null,
    lastError: facts.error ?? previous.lastError ?? null,
    lastInfeasible: facts.infeasible ?? previous.lastInfeasible ?? null,
    warning: facts.warning ?? null,
  }
  const standalone = atomicJson(file, status)
  const panel = mergePanelStatus(memoryRoot, status)
  return {
    ok: standalone.ok,
    path: file,
    panelPath: panelStatusPath(memoryRoot),
    status,
    ...(standalone.ok ? {} : { error: String(standalone.error?.code ?? standalone.error?.message ?? standalone.error) }),
    ...(panel.ok ? {} : { panelError: String(panel.error?.code ?? panel.error?.message ?? panel.error) }),
  }
}
