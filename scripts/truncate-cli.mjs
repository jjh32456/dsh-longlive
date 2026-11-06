#!/usr/bin/env node
// Out-of-app visible truncation, for the auto-truncate orchestrator.
//
// The in-app plugin no longer cuts a session log: a running host keeps the old
// sequence in memory, so a rewrite underneath it tears the next append. This
// CLI is meant to run only after the host has exited:
//
//   node scripts/truncate-cli.mjs --session <session.v4.jsonl.zstd> \
//     --keep-turns 12 --keep-tokens 80000 --confirm TRUNCATE-VISIBLE
//
// Add --dry-run to compute the same plan without writing anything (no archive,
// no backup, no in-flight record, no session bytes changed). That is the path
// the resident session watchdog uses in dryrun mode, so a drill can compare a
// planned cut with the real one from the same code.
//
// stdout is exactly one JSON line. Exit 0 means the operation succeeded *or*
// was a no-op; exit 2 means nothing was accepted and the JSON says why. The
// underlying truncateVisibleSession() still does snapshot / byte-compare /
// archive / backup / inflight / tmp / rename / read-back, and restores the
// backup itself if it fails after the rename.
//
// This process has no tool context, so it answers "is the target still
// running?" itself via src/live-target.js: the live registry row, the Windows
// exclusive-handle probe, and $DSH_SESSION_ID. A hit refuses with
// SESSION_IS_RUNNING before anything is read for writing — the tool-layer
// guard is not reachable from here, and this CLI must never depend on it.

import path from 'node:path';

import { VISIBLE_CONFIRM_WORD, truncateVisibleSession } from '../src/truncate-visible.js';
import { detectLiveTarget, LIVE_TARGET_CODES } from '../src/live-target.js';
import { dshHome } from '../src/home.js';

const DEFAULT_KEEP_TURNS = 12;
const DEFAULT_KEEP_TOKENS = 80_000;
const DEFAULT_FIRST_USER_CAP = 4000;
const DEFAULT_BOUNDARY_RETRIES = 3;

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * m2 (rc.2): --session must live under the DSH sessions root. Callers pass a
 * path they computed themselves, so a typo or a drive-relative path must not
 * let this CLI rewrite an arbitrary .zst file. The root follows $DSH_HOME
 * (tests and the orchestrator set it to a fixture home).
 */
function assertInsideSessionsRoot(sessionPath, env = process.env) {
  const root = path.resolve(path.join(dshHome(env), 'sessions'));
  const resolved = path.resolve(sessionPath);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw cliError(
      'E_SESSION_PATH_OUTSIDE',
      `refusing to write: ${resolved} is outside the DSH sessions root ${root}`,
    );
  }
  return resolved;
}

function emit(value, exitCode) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

function parseIntArg(name, value, min = 1) {
  const pattern = min === 0 ? /^[0-9]+$/ : /^[1-9][0-9]*$/;
  if (typeof value !== 'string' || !pattern.test(value) || Number(value) < min) {
    throw cliError('BAD_ARGUMENT', `--${name} must be an integer >= ${min} (got ${JSON.stringify(value)})`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const options = {
    sessionPath: null,
    keepTurns: DEFAULT_KEEP_TURNS,
    keepTokens: DEFAULT_KEEP_TOKENS,
    firstUserCapChars: DEFAULT_FIRST_USER_CAP,
    boundaryRetries: DEFAULT_BOUNDARY_RETRIES,
    confirm: null,
    // --dry-run is a read-only plan. It is the only mode that does not need
    // --confirm, because it provably writes nothing.
    dryRun: false,
    // The live registry lives under <memoryRoot>/.longlive/live. The
    // orchestrator passes the root it runs with; a standalone run falls back to
    // $DSH_MEM and simply skips the registry check when neither is set (the
    // handle probe and $DSH_SESSION_ID still apply).
    memoryRoot: typeof process.env.DSH_MEM === 'string' && process.env.DSH_MEM.trim() !== ''
      ? process.env.DSH_MEM.trim()
      : null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw cliError('BAD_ARGUMENT', `${flag} needs a value`);
      }
      i += 1;
      return value;
    };
    if (flag === '--session') {
      options.sessionPath = take();
    } else if (flag === '--keep-turns') {
      options.keepTurns = parseIntArg('keep-turns', take());
    } else if (flag === '--keep-tokens') {
      options.keepTokens = parseIntArg('keep-tokens', take());
    } else if (flag === '--first-user-cap') {
      options.firstUserCapChars = parseIntArg('first-user-cap', take());
    } else if (flag === '--boundary-retries') {
      options.boundaryRetries = parseIntArg('boundary-retries', take(), 0);
    } else if (flag === '--confirm') {
      options.confirm = take();
    } else if (flag === '--dry-run') {
      options.dryRun = true;
    } else if (flag === '--memory-root') {
      options.memoryRoot = take();
    } else {
      throw cliError('BAD_ARGUMENT', `unknown argument: ${flag}`);
    }
  }
  if (!options.sessionPath) throw cliError('BAD_ARGUMENT', '--session is required');
  if (!options.dryRun && options.confirm !== VISIBLE_CONFIRM_WORD) {
    throw cliError('CONFIRM_REQUIRED',
      `refusing to write: pass --confirm ${VISIBLE_CONFIRM_WORD} (got ${JSON.stringify(options.confirm)})`);
  }
  return options;
}

function failure(error, sessionPath) {
  const result = error?.result ?? null;
  return {
    ok: false,
    code: error?.code ?? 'TRUNCATE_CLI_FAILED',
    message: error?.message ?? String(error),
    sessionPath: result?.sessionPath ?? sessionPath ?? null,
    needed: result?.needed ?? null,
    feasible: result?.feasible ?? null,
    attempts: result?.attempts ?? error?.attempts ?? null,
    archivePath: result?.archivePath ?? null,
    backupPath: result?.backupPath ?? null,
    restored: result?.restored ?? null,
    before: result?.before ?? null,
    after: result?.after ?? null,
  };
}

function main() {
  let options = null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    emit(failure(error), 2);
    return;
  }

  try {
    options.sessionPath = assertInsideSessionsRoot(options.sessionPath);
    // "Am I about to write a session that is still running?" This is decided
    // here, from the registry / handle probe / inherited session id — not by
    // the tool layer, which this process never loads.
    const live = detectLiveTarget(options.sessionPath, { memoryRoot: options.memoryRoot });
    if (live.running) {
      emit({
        ok: false,
        code: LIVE_TARGET_CODES.SESSION_IS_RUNNING,
        message: `refusing to write: ${live.reason}. ` +
          'Close the app that has this session loaded, then retry (this CLI never kills a process).',
        sessionPath: live.sessionPath,
        sessionId: live.sessionId,
        sessionIdSource: live.sessionIdSource,
        reasons: live.reasons,
        checks: live.checks,
        needed: null,
        archivePath: null,
        backupPath: null,
        restored: null,
        before: null,
        after: null,
      }, 2);
      return;
    }

    // Read-only plan. It shares resolveVisibleCut with the writing path but
    // stops before assertNotLive / backup / archive / inflight / rename, so
    // there is nothing to clean up and nothing to verify beyond the absent
    // write. The caller can hash the file before and after this process.
    if (options.dryRun) {
      const planned = truncateVisibleSession(options.sessionPath, {
        dryRun: true,
        keepTurns: options.keepTurns,
        keepTokens: options.keepTokens,
        firstUserCapChars: options.firstUserCapChars,
        boundaryRetries: options.boundaryRetries,
      });
      const after = planned.after ?? planned.before;
      emit({
        ok: planned.ok !== false,
        dryRun: true,
        wrote: false,
        sessionPath: planned.sessionPath ?? options.sessionPath,
        needed: planned.needed ?? null,
        feasible: planned.feasible ?? true,
        applied: false,
        status: planned.status,
        before: planned.before ?? null,
        after,
        bytes: {
          before: planned.before?.bytes ?? null,
          after: after?.bytes ?? null,
        },
        budget: planned.budget ?? null,
        firstUserCarry: planned.firstUserCarry ?? null,
        archivePath: planned.archivePath ?? null,
        backupPath: null,
        verify: { ok: true, method: 'truncate-visible:dry-run', wrote: false },
        cut: planned.cut ?? null,
        retainedMessages: planned.retainedMessages ?? null,
        dropped: planned.dropped ?? null,
        kept: planned.kept ?? null,
        message: planned.message ?? null,
      }, 0);
      return;
    }

    // The host is assumed closed, so the "recently written" guard is disabled;
    // truncateVisibleSession still aborts if the bytes change between snapshot
    // and rename. The exclusive-handle probe inside it still runs.
    const result = truncateVisibleSession(options.sessionPath, {
      dryRun: false,
      confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: options.keepTurns,
      keepTokens: options.keepTokens,
      firstUserCapChars: options.firstUserCapChars,
      boundaryRetries: options.boundaryRetries,
      recentWriteWindowMs: 0,
    });
    const after = result.after ?? result.before;
    const verify = result.needed
      ? { ok: true, method: 'truncate-visible:read-back', ...(result.readBack ?? {}) }
      : { ok: true, skipped: 'noop', reason: result.reason ?? null };
    emit({
      ok: true,
      sessionPath: result.sessionPath,
      needed: result.needed,
      feasible: result.feasible ?? true,
      attempts: result.attempts ?? null,
      applied: Boolean(result.applied),
      status: result.status,
      before: result.before,
      after,
      bytes: {
        before: result.before.bytes,
        after: after.bytes,
      },
      budget: result.budget ?? null,
      firstUserCarry: result.firstUserCarry ?? null,
      archivePath: result.archivePath ?? null,
      backupPath: result.backupPath ?? null,
      verify,
      cut: result.cut ?? null,
      retainedMessages: result.retainedMessages ?? null,
    }, 0);
  } catch (error) {
    emit(failure(error, options.sessionPath), 2);
  }
}

main();
