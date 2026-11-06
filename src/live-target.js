// "Is this session still running?" — shared by the tool guard and the CLI.
//
// The tool layer knows which session its own app has loaded (identity.js), but
// scripts/truncate-cli.mjs runs in a fresh process *after* the app was supposed
// to exit: it has no tool context, so it must answer the same question from the
// artefacts this plugin already maintains:
//
//   1. the live registry row (<memoryRoot>/.longlive/live/<id>.json) — a fresh
//      heartbeat is `running`; that is what a live app writes while it works;
//   2. the Windows exclusive-handle probe — a running app keeps the log open,
//      so FileShare.None cannot be taken (this is the 0.7.1 hole);
//   3. $DSH_SESSION_ID — the session this very app has loaded, inherited by
//      the process it spawned.
//
// Any hit refuses (fail closed): truncating a log whose owner still has the old
// seq in memory is exactly the 0.7.0 torn-log bug. An unreadable registry is
// also a refusal — "I cannot tell" must never mean "go" — while a registry that
// simply does not exist yet is genuinely absent, not unknown.

import fs from 'node:fs';
import path from 'node:path';

import { splitFrames, decompressFrame } from './codec.js';
import { assertNotLive, ERROR_CODES } from './truncate.js';
import { liveList } from './live.js';

export const LIVE_TARGET_CODES = Object.freeze({
  SESSION_IS_RUNNING: 'SESSION_IS_RUNNING',
});

/** The session id a log file belongs to: header.id when readable, else the folder name. */
export function sessionIdOfLogFile(sessionPath) {
  const abs = path.resolve(sessionPath);
  try {
    const buf = fs.readFileSync(abs);
    const frames = splitFrames(buf);
    if (frames.length > 0) {
      const text = decompressFrame(buf.subarray(frames[0].start, frames[0].end));
      const header = JSON.parse(text.split('\n', 1)[0]);
      if (header && typeof header.id === 'string' && header.id.trim() !== '') {
        return { id: header.id.trim(), source: 'header' };
      }
    }
  } catch { /* torn/live file: fall back to the folder name */ }
  return { id: path.basename(path.dirname(abs)), source: 'folder' };
}

function check(list, name, status, extra = {}) {
  const entry = { name, status, ...extra };
  list.push(entry);
  return entry;
}

/**
 * Detect whether `sessionPath` belongs to a session that is still running.
 *
 * Returns `{ running, code, sessionId, sessionIdSource, reason, checks, reasons }`.
 * `reason` is a single human sentence suitable for an error message; `checks`
 * records every signal (including the ones that were unavailable) so a refusal
 * can be audited instead of guessed at.
 *
 * Options:
 *   memoryRoot — the plugin's configured memory root; when absent the registry
 *                check is skipped (the caller does not know one);
 *   now        — clock override for tests;
 *   env        — environment override for tests;
 *   probe      — exclusive-handle probe override for tests (defaults to the
 *                plugin's assertNotLive, which spawns the Windows helper).
 */
export function detectLiveTarget(sessionPath, options = {}) {
  const {
    memoryRoot = null,
    now = Date.now(),
    env = process.env,
    probe = assertNotLive,
  } = options;
  const abs = path.resolve(sessionPath);
  const target = sessionIdOfLogFile(abs);
  const checks = [];
  const reasons = [];

  if (!fs.existsSync(abs)) {
    return {
      running: false,
      missing: true,
      code: null,
      sessionPath: abs,
      sessionId: target.id,
      sessionIdSource: target.source,
      reason: null,
      checks,
      reasons,
    };
  }

  // 1. Live registry: a fresh heartbeat from the writer means running.
  if (memoryRoot) {
    try {
      const listed = liveList({}, { memoryRoot, now });
      const row = (listed.entries ?? []).find(
        (entry) => String(entry.sessionId).toLowerCase() === target.id.toLowerCase(),
      );
      if (!row) {
        check(checks, 'live-registry', 'absent');
      } else if (row.effectiveState === 'running') {
        check(checks, 'live-registry', 'running', {
          heartbeatAt: row.heartbeatAt ?? row.record?.heartbeatAt ?? null,
          state: row.state ?? null,
          host: row.host ?? null,
        });
        reasons.push({
          signal: 'live-registry',
          state: 'running',
          detail: `the live registry row for ${target.id} still reports running ` +
            `(heartbeat ${row.heartbeatAt ?? row.record?.heartbeatAt ?? 'unknown'})`,
        });
      } else {
        check(checks, 'live-registry', 'not-running', { state: row.effectiveState ?? row.state ?? null });
      }
    } catch (error) {
      const code = error?.code ?? null;
      if (code === 'E_MEMORY_ROOT_MISSING' || code === 'E_MEMORY_ROOT_NOT_DIR') {
        // "The root does not exist" is absence, not uncertainty: no row can
        // exist there, so nothing can be running from it.
        check(checks, 'live-registry', 'absent', { reason: code });
      } else {
        check(checks, 'live-registry', 'unavailable', {
          code,
          message: String(error?.message ?? error).slice(0, 300),
        });
        reasons.push({
          signal: 'live-registry',
          state: 'unavailable',
          detail: `cannot read the live registry (${code ?? error?.message})`,
        });
      }
    }
  } else {
    check(checks, 'live-registry', 'skipped', { reason: 'memoryRoot not configured' });
  }

  // 2. Exclusive handle: a running app holds the log open with share flags that
  //    fs.openSync('r+') would not notice, so ask Windows for share-none.
  //    Elsewhere the probe is genuinely unavailable — record 'unverified', never
  //    'free': claiming a handle is free when the check never ran is how a
  //    non-Windows host would wave a live log through.
  let lastProbe = null;
  try {
    probe(abs, { recentWriteWindowMs: 0, now, onProbe: (report) => { lastProbe = report; } });
    if (lastProbe && lastProbe.ok === true && lastProbe.skipped) {
      check(checks, 'exclusive-handle', 'unverified', {
        reason: String(lastProbe.skipped),
        platform: process.platform,
      });
    } else {
      check(checks, 'exclusive-handle', 'free');
    }
  } catch (error) {
    const code = error?.code ?? null;
    if (code === ERROR_CODES.FILE_BUSY || code === ERROR_CODES.LOCKED) {
      check(checks, 'exclusive-handle', 'held', { code, message: String(error.message).slice(0, 300) });
      reasons.push({
        signal: 'exclusive-handle',
        state: 'held',
        detail: 'another process holds the session log open (most likely the app running it)',
      });
    } else if (code === ERROR_CODES.RECENT_WRITE) {
      // Freshly written without an open handle: suspicious, but not proof of a
      // running owner. Recorded so a caller can tighten the policy later.
      check(checks, 'exclusive-handle', 'recent-write', { code });
    } else {
      check(checks, 'exclusive-handle', 'unavailable', { code, message: String(error?.message ?? error) });
      reasons.push({
        signal: 'exclusive-handle',
        state: 'unavailable',
        detail: `cannot probe the session log (${code ?? error?.message})`,
      });
    }
  }

  // 3. $DSH_SESSION_ID: this process was spawned by the app with that session
  //    loaded. It is the literal "current session" signal.
  const envId = typeof env.DSH_SESSION_ID === 'string' ? env.DSH_SESSION_ID.trim() : '';
  if (envId) {
    const same = envId.toLowerCase() === target.id.toLowerCase();
    check(checks, 'env-session-id', same ? 'matches' : 'differs', { sessionId: envId });
    if (same) {
      reasons.push({
        signal: 'env-session-id',
        state: 'matches',
        detail: `$DSH_SESSION_ID names this session (${envId})`,
      });
    }
  } else {
    check(checks, 'env-session-id', 'unset');
  }

  const running = reasons.length > 0;
  return {
    running,
    missing: false,
    code: running ? LIVE_TARGET_CODES.SESSION_IS_RUNNING : null,
    sessionPath: abs,
    sessionId: target.id,
    sessionIdSource: target.source,
    reason: running
      ? `${target.id} is still running: ${reasons.map((item) => item.detail).join('; ')}`
      : null,
    checks,
    reasons,
  };
}
