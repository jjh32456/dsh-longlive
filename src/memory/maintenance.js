// Daily memory maintenance (feature batch 2026-11-05, B1/B2).
//
// B1: once per local calendar day, run `memory_consolidate` (report only; it
//     never edits a card) and record the result.
// B2: once per local calendar day, run `memory_forget` with NO `confirm`, i.e.
//     the dry-run branch, and write a human-readable pending list. There is no
//     code path here that can move, delete or rewrite a card: the confirm word
//     is never supplied by this module.
//
// Triggering is deliberately cheap: one unref'd `setTimeout` to the next local
// midnight, re-armed after each run, plus one catch-up run at plugin start.
// There is no polling loop and no per-turn hook, so a failed run cannot affect
// a turn. Every failure is caught, recorded in the schedule state and at most
// logged as one warning.
//
// Shared state lives at `<memoryRoot>/.longlive/bridge/schedule.json` with
// `lastConsolidateDate` / `lastForgetDate` as the per-day idempotency keys.
// Reports live in `<memoryRoot>/.longlive/reports/`:
//   consolidate-<YYYY-MM-DD>.md          (written by memoryConsolidate)
//   forget-pending-<YYYYMMDD>.md         (written here)

import fs from 'node:fs';
import path from 'node:path';

import { dayString, isoStamp } from './frontmatter.js';
import { memoryRootFromConfig, resolveInside, relativePath } from './paths.js';
import { ensureDir, writeFileAtomic } from './state.js';
import { memoryConsolidate } from './consolidate.js';
import { memoryForget } from './forget.js';
import { runConclusionDistillJob } from './conclusion-distill.js';

export const SCHEDULE_VERSION = 1;
export const SCHEDULE_REL = path.join('.longlive', 'bridge', 'schedule.json');
export const LOCK_REL = path.join('.longlive', 'bridge', 'schedule.lock');
export const PENDING_REPORT_PREFIX = 'forget-pending-';
export const RUN_HISTORY_LIMIT = 30;
export const DEFAULT_START_DELAY_MS = 500;
export const MIDNIGHT_PAD_MS = 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;

export const AUTO_MAINTENANCE_DEFAULTS = Object.freeze({
  enabled: false,
  consolidate: true,
  forget: true,
  runOnStart: true,
  startDelayMs: DEFAULT_START_DELAY_MS,
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value) {
  return typeof value === 'string' && DAY_RE.test(value.trim());
}

function errorInfo(error) {
  return {
    code: error?.code ?? 'E_MAINTENANCE_FAILED',
    message: String(error?.message ?? error),
  };
}

function warnTo(logger, message) {
  try {
    if (typeof logger === 'function') logger(message);
    else if (logger && typeof logger.warn === 'function') logger.warn(message);
  } catch {
    /* a logger failure must never break maintenance */
  }
}

function toClock(now) {
  if (typeof now === 'function') {
    return () => {
      const value = now();
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? new Date() : date;
    };
  }
  if (now instanceof Date) {
    return () => new Date(now.getTime());
  }
  return () => new Date();
}

function emptyState() {
  return {
    version: SCHEDULE_VERSION,
    lastConsolidateDate: null,
    lastConsolidateAt: null,
    lastConsolidateReport: null,
    lastConsolidateProposals: null,
    lastConsolidateError: null,
    lastForgetDate: null,
    lastForgetAt: null,
    lastForgetPending: null,
    lastForgetPendingCount: null,
    lastForgetError: null,
    lastConclusionDistillDate: null,
    lastConclusionDistillAt: null,
    lastConclusionDistillResult: null,
    lastConclusionDistillError: null,
    lastRunAt: null,
    lastRunDay: null,
    lastTrigger: null,
    runs: [],
  };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  state.lastConsolidateDate = isDay(raw.lastConsolidateDate) ? raw.lastConsolidateDate : null;
  state.lastForgetDate = isDay(raw.lastForgetDate) ? raw.lastForgetDate : null;
  state.lastConclusionDistillDate = isDay(raw.lastConclusionDistillDate) ? raw.lastConclusionDistillDate : null;
  for (const key of [
    'lastConsolidateAt', 'lastConsolidateReport',
    'lastForgetAt', 'lastForgetPending',
    'lastConclusionDistillAt',
    'lastRunAt', 'lastRunDay', 'lastTrigger',
  ]) {
    if (raw[key] == null || typeof raw[key] === 'string') state[key] = raw[key] ?? null;
  }
  for (const key of ['lastConsolidateError', 'lastForgetError', 'lastConclusionDistillError']) {
    const value = raw[key];
    if (value == null) {
      state[key] = null;
    } else if (typeof value === 'string') {
      state[key] = { code: 'E_MAINTENANCE_FAILED', message: value };
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      state[key] = {
        code: typeof value.code === 'string' ? value.code : 'E_MAINTENANCE_FAILED',
        message: typeof value.message === 'string' ? value.message : '',
        ...(typeof value.at === 'string' ? { at: value.at } : {}),
        ...(typeof value.day === 'string' ? { day: value.day } : {}),
      };
    } else {
      state[key] = null;
    }
  }
  for (const key of ['lastConsolidateProposals', 'lastForgetPendingCount']) {
    if (Number.isFinite(raw[key])) state[key] = raw[key];
  }
  state.lastConclusionDistillResult = raw.lastConclusionDistillResult
    && typeof raw.lastConclusionDistillResult === 'object'
    && !Array.isArray(raw.lastConclusionDistillResult)
    ? {
      archived: Number(raw.lastConclusionDistillResult.archived) || 0,
      distilled: Number(raw.lastConclusionDistillResult.distilled) || 0,
      rejected: Number(raw.lastConclusionDistillResult.rejected) || 0,
      skipped: Number(raw.lastConclusionDistillResult.skipped) || 0,
    }
    : null;
  state.runs = Array.isArray(raw.runs)
    ? raw.runs.filter((entry) => entry && typeof entry === 'object').slice(-RUN_HISTORY_LIMIT)
    : [];
  return state;
}

export function scheduleStatePath(root) {
  return resolveInside(root, SCHEDULE_REL);
}

function lockPathFor(root) {
  return resolveInside(root, LOCK_REL);
}

/**
 * Best-effort cross-process guard. Multiple sessions can share one memoryRoot;
 * without this, two startup ticks could both run the same day's jobs. The lock
 * is advisory and stale after 10 minutes, so a crashed process cannot block
 * maintenance forever.
 */
function acquireLock(root, { now = new Date() } = {}) {
  const file = lockPathFor(root);
  ensureDir(root, path.dirname(file));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({
          pid: process.pid,
          at: isoStamp(now),
          day: dayString(now),
        }));
      } finally {
        fs.closeSync(fd);
      }
      return {
        acquired: true,
        path: file,
        release: () => {
          try {
            fs.unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { acquired: false, reason: 'lock-error', error: errorInfo(error) };
      }
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* raced with another cleaner; retry */
        }
        continue;
      }
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        /* unreadable holder is still a live lock */
      }
      return { acquired: false, reason: 'locked', holder };
    }
  }
  return { acquired: false, reason: 'locked' };
}

/**
 * Read the schedule state. A missing file is an empty state; a corrupt file is
 * reported (never thrown) and is backed up by the next atomic write.
 */
export function readScheduleState(root) {
  const file = scheduleStatePath(root);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { state: emptyState(), exists: false, corrupt: false, error: null, path: file };
    }
    return {
      state: emptyState(),
      exists: true,
      corrupt: true,
      error: errorInfo(error),
      path: file,
    };
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('schedule.json 必须是对象');
    }
    return { state: normalizeState(raw), exists: true, corrupt: false, error: null, path: file };
  } catch (error) {
    return {
      state: emptyState(),
      exists: true,
      corrupt: true,
      error: errorInfo(error),
      path: file,
    };
  }
}

export function writeScheduleState(root, state, { now = new Date() } = {}) {
  const file = scheduleStatePath(root);
  ensureDir(root, path.dirname(file));
  const next = normalizeState(state);
  next.version = SCHEDULE_VERSION;
  next.updatedAt = isoStamp(now);
  const write = writeFileAtomic(root, file, `${JSON.stringify(next, null, 2)}\n`, { backup: true, now });
  return { state: next, write };
}

/** Next local midnight (+ a small pad so dayString() has already changed). */
export function nextLocalMidnight(now = new Date(), padMs = MIDNIGHT_PAD_MS) {
  const base = now instanceof Date ? now : new Date(now);
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 0, 0, 0, 0);
  const pad = Number.isFinite(padMs) && padMs > 0 ? Math.floor(padMs) : 0;
  next.setTime(next.getTime() + pad);
  return next;
}

function compactDay(day) {
  return String(day).replaceAll('-', '');
}

export function pendingReportPath(root, day) {
  return resolveInside(root, path.join('.longlive', 'reports', `${PENDING_REPORT_PREFIX}${compactDay(day)}.md`));
}

/**
 * Write the pending list. If today's file already exists (e.g. a manual rerun
 * after a state-write failure), keep a copy in reports/.backups first, matching
 * the memoryConsolidate convention.
 */
function writePendingReport(root, file, content, { now = new Date() } = {}) {
  ensureDir(root, path.dirname(file));
  if (fs.existsSync(file)) {
    const backupDir = resolveInside(root, path.join('.longlive', 'reports', '.backups'));
    ensureDir(root, backupDir);
    const stamp = isoStamp(now).replace(/[:.]/g, '-');
    const stem = path.basename(file, '.md');
    let name = `${stem}.${stamp}.md`;
    for (let suffix = 2; fs.existsSync(path.join(backupDir, name)); suffix += 1) {
      name = `${stem}.${stamp}-${suffix}.md`;
    }
    fs.copyFileSync(file, path.join(backupDir, name));
  }
  return writeFileAtomic(root, file, content, { backup: false, now });
}

function kindLabel(kind) {
  if (kind === 'tombstone') return '立碑（tombstone）';
  if (kind === 'epochs') return '降级（epochs）';
  return String(kind ?? '未知');
}

/**
 * Render the B2 pending list. Pure: takes the dry-run result and returns text.
 * Deliberately repeats the confirm requirement so a human never mistakes this
 * file for an executed forget run.
 */
export function renderForgetPending({ day, at = new Date(), result = {} } = {}) {
  const proposals = Array.isArray(result.proposals) ? result.proposals : [];
  const immune = Array.isArray(result.immune) ? result.immune : [];
  const undated = Array.isArray(result.undated) ? result.undated : [];
  const missing = Array.isArray(result.scaffold?.missing) ? result.scaffold.missing : [];
  const tombstones = proposals.filter((item) => item.kind === 'tombstone').length;
  const epochs = proposals.filter((item) => item.kind === 'epochs').length;
  const scanned = Number.isFinite(result.scanned) ? result.scanned : 0;
  const lines = [];

  lines.push(`# 遗忘提案待确认 · ${day}`, '');
  lines.push(
    '> 本文件由每日自动维护任务对 `memory_forget` 执行的 dry-run 生成：**没有移动、删除或改写任何卡片**。',
    `> 真正执行仍需人工显式确认 \`confirm:"FORGET"\`；自动任务不会触发执行。`,
    '',
  );
  lines.push(`- 生成时间：${isoStamp(at)}`);
  lines.push(`- 扫描卡片：${scanned}`);
  lines.push(`- 待确认提案：${proposals.length}（立碑 ${tombstones} / 降级 ${epochs}）`);
  lines.push(`- 核心记忆免疫：${immune.length}`);
  lines.push(`- 无 last_used 跳过：${undated.length}`);
  lines.push(`- 脚手架：${missing.length ? `缺 ${missing.join('/')}` : '齐全'}`);
  lines.push('');

  if (proposals.length === 0) {
    lines.push('今天没有到期的遗忘提案。', '');
  } else {
    lines.push('## 待确认提案', '');
    proposals.forEach((item, index) => {
      lines.push(`### ${index + 1}. \`${item.path}\``, '');
      lines.push(`- 动作：${kindLabel(item.kind)}`);
      lines.push(
        `- 年龄：${item.ageDays ?? '—'} 天` +
          `（last_used: ${item.last_used ?? '—'}，strength: ${item.strength ?? '—'}，salience: ${item.salience ?? '—'}）`,
      );
      lines.push(`- 依据：${item.reason ?? '—'}`);
      lines.push(`- 目标位置：\`${item.destRel ?? '—'}\``);
      if (item.epitaph && typeof item.epitaph === 'object') {
        lines.push('- 墓志铭：');
        lines.push(`  - 为什么关：${item.epitaph.reason ?? '—'}`);
        lines.push(`  - 影响谁：${item.epitaph.affects ?? '—'}`);
        lines.push(`  - 还有用吗：${item.epitaph.stillUseful ?? '—'}`);
      }
      lines.push('');
    });
  }

  if (immune.length > 0) {
    lines.push('## 免疫（未列入提案）', '');
    lines.push('| 卡片 | 状态 | 原因 |');
    lines.push('|---|---|---|');
    for (const item of immune) {
      lines.push(`| \`${item.path}\` | ${item.status ?? 'active'} | ${item.reason ?? '—'} |`);
    }
    lines.push('');
  }

  if (undated.length > 0) {
    lines.push('## 无日期跳过', '');
    for (const item of undated) {
      lines.push(`- \`${item.path}\` — ${item.reason ?? '没有可用的 last_used'}`);
    }
    lines.push('');
  }

  lines.push(
    '---',
    '',
    '确认方式：人工核对本清单后，调用 `memory_forget` 并传 `confirm:"FORGET"`。',
    '自动维护只产生本清单；没有卡被移动、删除或改写。',
    '',
  );
  return lines.join('\n');
}

/**
 * Run the daily jobs once. Both jobs are independent: one failing does not stop
 * the other, and neither failure is thrown to the caller. A job is skipped when
 * its `last*Date` already equals today's local date.
 *
 * Returns a plain summary:
 *   { ok, ran, day, trigger, consolidate, forget, state, corruptState?, stateError? }
 */
export function runDailyMaintenance({
  memoryRoot,
  config = {},
  now = new Date(),
  logger = null,
  trigger = 'manual',
  consolidate = memoryConsolidate,
  forget = memoryForget,
} = {}) {
  let root;
  try {
    root = memoryRoot ? path.resolve(memoryRoot) : memoryRootFromConfig(config);
  } catch (error) {
    return { ok: false, ran: false, reason: 'no-memory-root', error: errorInfo(error) };
  }
  if (!root) return { ok: false, ran: false, reason: 'no-memory-root' };

  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) return { ok: false, ran: false, reason: 'bad-clock' };
  const day = isDay(config.today) ? config.today.trim() : dayString(at);
  const wantConsolidate = config.consolidate !== false;
  const wantForget = config.forget !== false;
  const wantDrafts = config.autoConclusion !== false;
  if (!wantConsolidate && !wantForget && !wantDrafts) {
    return { ok: true, ran: false, reason: 'disabled', day, trigger };
  }

  const summary = {
    ok: true,
    ran: false,
    day,
    trigger,
    consolidate: null,
    forget: null,
    conclusionDistill: null,
    state: null,
    corruptState: false,
  };

  let read;
  try {
    read = readScheduleState(root);
  } catch (error) {
    return { ...summary, ok: false, reason: 'state-unreadable', error: errorInfo(error) };
  }
  summary.corruptState = read.corrupt;
  if (read.corrupt) {
    warnTo(
      logger,
      `[auto-maintenance] schedule.json 不可读（${read.error?.code ?? 'E_STATE_CORRUPT'}）— 按空状态继续，下一次写入会先备份旧文件`,
    );
  }
  let state = read.state;

  let needConsolidate = wantConsolidate && state.lastConsolidateDate !== day;
  let needForget = wantForget && state.lastForgetDate !== day;
  let needDrafts = wantDrafts && state.lastConclusionDistillDate !== day;
  if (!needConsolidate && !needForget && !needDrafts) {
    return { ...summary, reason: 'already-ran-today', state };
  }

  const lock = acquireLock(root, { now: at });
  if (!lock.acquired) {
    return {
      ...summary,
      reason: lock.reason === 'lock-error' ? 'lock-error' : 'locked',
      lock: lock.holder ?? null,
      error: lock.error,
      state,
    };
  }

  try {
    // Re-read after taking the lock: another session may have finished the
    // same day's jobs between our first read and the lock acquisition.
    const latest = readScheduleState(root);
    if (latest.corrupt) summary.corruptState = true;
    state = latest.state;
    needConsolidate = wantConsolidate && state.lastConsolidateDate !== day;
    needForget = wantForget && state.lastForgetDate !== day;
    needDrafts = wantDrafts && state.lastConclusionDistillDate !== day;
    if (!needConsolidate && !needForget && !needDrafts) {
      return { ...summary, reason: 'already-ran-today', state };
    }

    // ---- B1: consolidate (report only) ------------------------------------
    if (needConsolidate) {
      try {
        const result = consolidate({}, { memoryRoot: root, now: at });
        const proposals = Array.isArray(result?.proposals) ? result.proposals.length : 0;
        summary.consolidate = {
          status: 'ran',
          reportRel: result?.reportRel ?? null,
          proposals,
          stateUpdated: result?.stateUpdated === true,
        };
        state.lastConsolidateDate = day;
        state.lastConsolidateAt = isoStamp(at);
        state.lastConsolidateReport = summary.consolidate.reportRel;
        state.lastConsolidateProposals = proposals;
        state.lastConsolidateError = null;
      } catch (error) {
        summary.consolidate = { status: 'failed', ...errorInfo(error) };
        state.lastConsolidateError = { ...errorInfo(error), at: isoStamp(at), day };
        warnTo(
          logger,
          `[auto-maintenance] consolidate 失败（${summary.consolidate.code}）— ${summary.consolidate.message}；已跳过，不影响对话`,
        );
      }
    }

    // ---- B2: forget dry-run + pending list --------------------------------
    if (needForget) {
      try {
        // `{}` means no confirm -> memoryForget's dry-run branch. The guard below
        // is defensive: if a future refactor ever makes this write cards, the
        // scheduler reports a failure instead of silently applying a forget.
        const result = forget({}, { memoryRoot: root, now: at });
        if (!result || result.dryRun !== true || result.applied === true) {
          const error = new Error('memory_forget 调度必须停留在 dry-run');
          error.code = 'E_MAINTENANCE_DRYRUN_REQUIRED';
          throw error;
        }
        const file = pendingReportPath(root, day);
        const content = renderForgetPending({ day, at, result });
        const write = writePendingReport(root, file, content, { now: at });
        const pending = Array.isArray(result.proposals) ? result.proposals.length : 0;
        summary.forget = {
          status: 'ran',
          pending,
          pendingRel: relativePath(root, file),
          immune: Array.isArray(result.immune) ? result.immune.length : 0,
          undated: Array.isArray(result.undated) ? result.undated.length : 0,
          sha256: write.sha256,
        };
        state.lastForgetDate = day;
        state.lastForgetAt = isoStamp(at);
        state.lastForgetPending = summary.forget.pendingRel;
        state.lastForgetPendingCount = pending;
        state.lastForgetError = null;
      } catch (error) {
        summary.forget = { status: 'failed', ...errorInfo(error) };
        state.lastForgetError = { ...errorInfo(error), at: isoStamp(at), day };
        warnTo(
          logger,
          `[auto-maintenance] forget dry-run 失败（${summary.forget.code}）— ${summary.forget.message}；卡未改动，不影响对话`,
        );
      }
    }

    // ---- B3: A1 conclusion drafts -> distilled topic cards -----------------
    // Distillation is a maintenance concern: raw A1 output stays in the draft
    // pool; only validated, source-anchored extracts reach topics/. A failure
    // here is recorded and audited but never thrown to the caller.
    if (needDrafts) {
      try {
        const result = runConclusionDistillJob({
          memoryRoot: root, config, now: at,
          sessionsRoot: config.sessionsRoot,
        });
        summary.conclusionDistill = { status: 'ran', ...result };
        state.lastConclusionDistillDate = day;
        state.lastConclusionDistillAt = isoStamp(at);
        state.lastConclusionDistillResult = {
          archived: result.archived ?? 0,
          distilled: result.distilled ?? 0,
          rejected: result.rejected ?? 0,
          skipped: result.skipped ?? 0,
        };
        state.lastConclusionDistillError = null;
      } catch (error) {
        summary.conclusionDistill = { status: 'failed', ...errorInfo(error) };
        state.lastConclusionDistillError = { ...errorInfo(error), at: isoStamp(at), day };
        warnTo(
          logger,
          `[auto-maintenance] conclusion distill 失败（${summary.conclusionDistill.code}）— ${summary.conclusionDistill.message}；候选保留，不影响对话`,
        );
      }
    }

    // ---- state -------------------------------------------------------------
    if (!summary.consolidate && !summary.forget && !summary.conclusionDistill) {
      return { ...summary, reason: 'nothing-to-do', state };
    }
    summary.ran = true;
    state.lastRunAt = isoStamp(at);
    state.lastRunDay = day;
    state.lastTrigger = trigger;
    state.runs = [
      ...(Array.isArray(state.runs) ? state.runs : []),
      {
        at: isoStamp(at),
        day,
        trigger,
        consolidate: summary.consolidate?.status ?? 'skipped',
        forget: summary.forget?.status ?? 'skipped',
        ...(summary.consolidate?.status === 'ran' ? { consolidateReport: summary.consolidate.reportRel } : {}),
        ...(summary.consolidate?.status === 'failed' ? { consolidateError: summary.consolidate.code } : {}),
        ...(summary.forget?.status === 'ran' ? { forgetPending: summary.forget.pendingRel } : {}),
        ...(summary.forget?.status === 'failed' ? { forgetError: summary.forget.code } : {}),
      },
    ].slice(-RUN_HISTORY_LIMIT);

    try {
      const written = writeScheduleState(root, state, { now: at });
      summary.state = written.state;
      summary.stateWrite = written.write;
    } catch (error) {
      summary.ok = false;
      summary.state = state;
      summary.stateError = errorInfo(error);
      warnTo(
        logger,
        `[auto-maintenance] schedule.json 写入失败（${summary.stateError.code}）— ${summary.stateError.message}；下次启动会重试`,
      );
    }
    return summary;
  } finally {
    lock.release();
  }
}

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

/**
 * Create the daily scheduler. Injectable clock/timers/runner make it testable
 * without waiting a day:
 *   now    : Date | () => Date
 *   timers : { setTimeout(fn, ms), clearTimeout(handle) }
 *   run    : async/sync (options) => summary  (default runDailyMaintenance)
 *
 * start() arms exactly one timer: a short startup tick (runOnStart !== false)
 * or directly the next local midnight. Each tick re-arms the next midnight;
 * a run that straddles midnight arms a 1s catch-up tick instead of skipping a
 * whole day.
 */
export function createMaintenanceScheduler(options = {}) {
  const memoryRoot = options.memoryRoot ?? null;
  const config = options.config && typeof options.config === 'object' ? options.config : {};
  const clock = toClock(options.now);
  const timers = options.timers && typeof options.timers.setTimeout === 'function'
    ? options.timers
    : defaultTimers();
  const clearTimer = typeof timers.clearTimeout === 'function'
    ? (handle) => timers.clearTimeout(handle)
    : () => {};
  const runner = typeof options.run === 'function' ? options.run : runDailyMaintenance;
  const logger = options.logger ?? null;
  const startupDelay = Number.isFinite(options.startDelayMs)
    ? Math.max(0, options.startDelayMs)
    : Number.isFinite(config.startDelayMs)
      ? Math.max(0, config.startDelayMs)
      : DEFAULT_START_DELAY_MS;

  let timer = null;
  let started = false;
  let stopped = false;
  let running = false;
  let lastResult = null;

  function unref(handle) {
    if (handle && typeof handle.unref === 'function') handle.unref();
  }

  function clear() {
    if (timer) {
      try {
        clearTimer(timer);
      } catch {
        /* a timer implementation failure must not break stop() */
      }
      timer = null;
    }
  }

  function arm(delayMs, trigger) {
    if (stopped) return null;
    const delay = Math.max(0, Math.floor(Number(delayMs) || 0));
    timer = timers.setTimeout(() => {
      timer = null;
      return tick(trigger);
    }, delay);
    unref(timer);
    return timer;
  }

  function armNextMidnight() {
    const current = clock();
    const next = nextLocalMidnight(current, MIDNIGHT_PAD_MS);
    const delay = Math.max(0, next.getTime() - current.getTime());
    arm(delay, 'midnight');
    return { at: next.toISOString(), delayMs: delay };
  }

  async function tick(trigger) {
    if (stopped) return { ok: true, ran: false, reason: 'stopped' };
    if (running) return { ok: true, ran: false, reason: 'busy' };
    running = true;
    const startedAt = clock();
    try {
      const result = await runner({
        memoryRoot,
        config,
        now: startedAt,
        logger,
        trigger,
      });
      lastResult = result;
      return result;
    } catch (error) {
      const info = errorInfo(error);
      lastResult = { ok: false, ran: false, reason: 'failed', error: info };
      warnTo(
        logger,
        `[auto-maintenance] ${trigger} 运行失败（${info.code}）— ${info.message}；已跳过，不影响对话`,
      );
      return lastResult;
    } finally {
      running = false;
      if (!stopped) {
        const finishedAt = clock();
        if (dayString(finishedAt) !== dayString(startedAt)) {
          // The run started before local midnight and finished after it; run
          // again for the new date rather than waiting a full extra day.
          arm(1000, 'midnight-catchup');
        } else {
          armNextMidnight();
        }
      }
    }
  }

  function start() {
    if (stopped) return { started: false, reason: 'stopped' };
    if (started) return { started: true, reason: 'already-started', timerArmed: timer !== null };
    if (!memoryRoot) return { started: false, reason: 'no-memory-root' };
    if (config.consolidate === false && config.forget === false) {
      return { started: false, reason: 'disabled' };
    }
    started = true;
    if (config.runOnStart !== false) {
      arm(startupDelay, 'startup');
      return { started: true, mode: 'startup', delayMs: startupDelay };
    }
    const next = armNextMidnight();
    return { started: true, mode: 'midnight', ...next };
  }

  function stop() {
    stopped = true;
    started = false;
    clear();
    return { stopped: true };
  }

  async function runNow(trigger = 'manual') {
    clear();
    return tick(trigger);
  }

  function status() {
    return {
      started,
      stopped,
      running,
      timerArmed: timer !== null,
      lastResult,
    };
  }

  return { start, stop, runNow, status };
}
