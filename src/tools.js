// @local/dsh-longlive - tools
//
// Four groups:
// - session_* read or rewrite one DSH session log and default to dryRun=true:
//   a dry run performs all reads and computations and writes NOTHING (no tmp,
//   no backup, no ledger); writing requires an explicit confirm word.
// - session_wake is the v0.2 wake-up kit, lease_acquire / lease_release hand
//   out a cross-process write lease over the memory store so two hosts never
//   believe they both own it, and worker_* drive one background child session
//   when the host exposes a subagents service.
// - memory_* (v0.4) read and write ONLY inside the directory configured as
//   `memoryRoot`. Since 0.7.3 an unset root derives to <DSH home>/longlive-memory
//   (create-on-demand) and $DSH_MEM / $DSH_LONGLIVE_MEMORY_ROOT override it;
//   `strictMemoryRoot` restores the old "unset root is an error" behaviour.
//   Every write is backed up, verified, and rolled back on failure.
// - session_live_* (v0.5) maintain the "正在" live session registry under
//   <memoryRoot>/.longlive/live: one atomically written JSON row per session.
//   idle/running/waiting/blocked/stale are declared by the writer;
//   dead/corrupt are computed by the reader.

import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './home.js';
import { parseSession, deriveMessagesDigest } from './codec.js';
import { sha256File, stamp, readLedger, writeLedger } from './backup.js';
import { resolveCurrentSessionId } from './identity.js';
import { truncateSession, formatBytes, CONFIRM_WORD } from './truncate.js';
import {
  truncateVisibleSession,
  VISIBLE_CONFIRM_WORD,
  DEFAULT_KEEP_TURNS,
  DEFAULT_KEEP_TOKENS,
} from './truncate-visible.js';
import { analyzeCompaction, describeCompaction } from './compaction.js';
import { memoryIndex } from './memory/index.js';
import { memoryConsolidate } from './memory/consolidate.js';
import { memoryReinforce } from './memory/reinforce.js';
import { memoryForget } from './memory/forget.js';
import { memoryRecall } from './memory/recall.js';
import { memoryProcedure, PROCEDURES_DIR, PROCEDURE_ACTIONS } from './memory/procedure.js';
import {
  memoryError,
  memoryRootSetting,
  defaultMemoryRoot,
  MEMORY_ROOT_ENV,
  LEGACY_MEMORY_ROOT_ENV,
  DEFAULT_MEMORY_DIRNAME,
} from './memory/paths.js';
import { liveUpdate, liveList, liveGet, livePrune } from './live.js';
import { sessionIdOfLogFile } from './live-target.js';
import { privacyScan } from './recall/privacy.mjs';
import {
  buildTurnItems,
  availableTurns,
  selectTurnItems,
  joinTurnItems,
  sliceUtf8,
  archiveFileName,
  ORIGINAL_KINDS,
} from './original.js';

const SESSION_FILE = 'session.v4.jsonl.zstd';

export { dshHome };

/**
 * Every session log under <home>/sessions/<scope>/<id>/session.v4.jsonl.zstd.
 * Read-only: never creates anything.
 */
export function listSessions(home = dshHome()) {
  const root = path.join(home, 'sessions');
  const out = [];
  let scopes = [];
  try {
    scopes = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(root, scope.name);
    let entries = [];
    try {
      entries = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(scopeDir, entry.name, SESSION_FILE);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      out.push({ id: entry.name, scope: scope.name, file, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

function candidatesOf(sessions, limit = 3) {
  return [...sessions]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((s) => ({ id: s.id, scope: s.scope, bytes: s.bytes, modified: new Date(s.mtimeMs).toISOString() }));
}

function lookupError(code, message, sessions) {
  return { ok: false, error: { code, message, candidates: candidatesOf(sessions ?? []) } };
}

// ---------------------------------------------------------------------------
// Path whitelist (F2) and backup planning (F1/F3/F4)
//
// Every session tool resolves a path before it reads or writes anything, and
// that path must stay inside <DSH_HOME>/sessions: the plugin's whole contract is
// "one session log, never any other file". A relative path is refused outright
// (it would silently resolve against whatever cwd the host happened to have),
// and only the two names a session log can have are accepted.
// ---------------------------------------------------------------------------

const BACKUP_CONFIRM_WORD = 'BACKUP';

/** The sessions root every resolved path must live under. */
function sessionsRoot(home) {
  return path.join(home, 'sessions');
}

/** True for the log itself — the only name a destructive tool may touch. */
function isSessionLogName(name) {
  return name === SESSION_FILE;
}

/** True for a `.bak-*` copy of the log. Read tools may inspect these; writers may not. */
function isBackupFileName(name) {
  return name.startsWith(`${SESSION_FILE}.bak-`);
}

/** True for the two names a session tool may touch: the log, and its .bak-* copies. */
function isSessionFileName(name) {
  return isSessionLogName(name) || isBackupFileName(name);
}

/** `target` is strictly inside `dir` (not the directory itself, not its parent). */
function isInsideDir(dir, target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** One shape for every refusal: no read, no write, and the offending path named. */
function pathRefusal(code, abs, message) {
  const error = { code, message, path: abs, candidates: [], ok: false, status: 'unavailable' };
  return { ok: false, code, status: 'unavailable', refused: true, path: abs, message, error };
}

/**
 * Enforce the whitelist on an already-resolved absolute path.
 *
 * `destructive: true` narrows it to the log itself: truncating a `.bak-*` copy
 * rewrites a backup, which is the one thing a backup exists to prevent. Reads
 * keep the wider whitelist, because inspecting a backup is a legitimate question.
 */
function guardSessionPath(abs, home, { destructive = false } = {}) {
  if (!isInsideDir(sessionsRoot(home), abs)) {
    return pathRefusal('PATH_OUTSIDE_SESSIONS', abs, `unavailable: 路径不在 sessions 目录内 ${abs}`);
  }
  const name = path.basename(abs);
  if (!isSessionFileName(name)) {
    return pathRefusal('PATH_NOT_SESSION_FILE', abs,
      `unavailable: 不是 session 文件名（只能是 ${SESSION_FILE} 或其 .bak-* 备份）${abs}`);
  }
  if (destructive && isBackupFileName(name)) {
    return pathRefusal('IS_BACKUP', abs,
      `unavailable: 这是 ${SESSION_FILE} 的备份文件，破坏性工具只对日志本体操作（备份不可被截断；` +
      `要动日志请指向 ${SESSION_FILE}）${abs}`);
  }
  return null;
}

/** An already-vetted path (from listSessions or the whitelist) becomes a resolution. */
function acceptPath(file, home, extra = {}, options = {}) {
  const guarded = guardSessionPath(file, home, options);
  if (guarded) return guarded;
  return { ok: true, sessionPath: file, ...extra, home };
}

/** Backup files that really are files; a same-named directory is not a backup. */
function backupFilesUnder(sessionPath) {
  const dir = path.dirname(sessionPath);
  const base = path.basename(sessionPath);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.startsWith(`${base}.bak-`)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) out.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Unreadable or vanished mid-scan: it cannot be counted as a backup.
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

const FS_REASONS = {
  ENOENT: '文件不存在',
  EACCES: '没有权限',
  EPERM: '没有权限',
  EISDIR: '目标是目录',
  ENOTDIR: '路径不是目录',
  ENOSPC: '磁盘空间不足',
  EEXIST: '目标已存在',
  EBUSY: '文件被占用',
  EMFILE: '文件句柄耗尽',
};

/** `中文原因（CODE）` for any filesystem error, so a bare code never escapes. */
function fsReason(error) {
  const code = error?.code ?? 'UNKNOWN';
  return `${FS_REASONS[code] ?? (typeof error?.message === 'string' ? error.message : String(error))}（${code}）`;
}

/** `unavailable: …` wrapper shared by the session tools. */
function fsUnavailable(action, error, extra = {}) {
  return {
    ok: false,
    status: 'unavailable',
    code: error?.code ?? 'UNKNOWN',
    ...extra,
    message: `unavailable: ${action}：${fsReason(error)}`,
  };
}

/**
 * Pick the backup path for this invocation: today's stamp, then -2, -3, … until
 * a free name is found. Never reuses an older backup and never overwrites one,
 * so a dry run and the real run that follows it name the same file.
 */
function planBackupTarget(sessionPath, date = new Date()) {
  const dir = path.dirname(sessionPath);
  const base = path.basename(sessionPath);
  const day = stamp(date);
  for (let n = 1; n <= 1000; n += 1) {
    const name = n === 1 ? `${base}.bak-${day}` : `${base}.bak-${day}-${n}`;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return { file, day, suffix: n };
  }
  const error = new Error('backup name space exhausted');
  error.code = 'EEXIST';
  throw error;
}

/** Copy + verify + ledger. COPYFILE_EXCL means an existing file is never clobbered. */
function createBackupNow(sessionPath, targetFile, expectedSha256, size) {
  fs.copyFileSync(sessionPath, targetFile, fs.constants.COPYFILE_EXCL);
  let copied;
  try {
    copied = sha256File(targetFile);
  } catch (error) {
    try { fs.unlinkSync(targetFile); } catch { /* best effort */ }
    throw error;
  }
  if (copied !== expectedSha256) {
    try { fs.unlinkSync(targetFile); } catch { /* best effort */ }
    const error = new Error(`backup verification failed: ${copied} != ${expectedSha256}`);
    error.code = 'BACKUP_SHA256_MISMATCH';
    throw error;
  }
  const result = { created: true, file: targetFile, sha256: copied, size, ledgerWritten: true };
  try {
    const ledger = readLedger(sessionPath);
    ledger.backups.push({
      file: targetFile,
      sha256: copied,
      size,
      createdAt: new Date().toISOString(),
      deletable: ledger.backups.length + 1 > 7,
    });
    writeLedger(sessionPath, ledger);
  } catch (error) {
    // The bytes are on disk and verified; a ledger that could not be written is
    // reported, not turned into a fake failure.
    result.ledgerWritten = false;
    result.ledgerWarning = fsReason(error);
  }
  return result;
}

/** The confirm word is case-insensitive but never approximate. */
function backupConfirmOk(value) {
  return typeof value === 'string' && value.trim().toUpperCase() === BACKUP_CONFIRM_WORD;
}

/**
 * Turn any of { sessionPath, sessionId, session } into an absolute log path.
 * Resolution is read-only and happens before any write; failures carry
 * SESSION_NOT_FOUND / SESSION_AMBIGUOUS plus up to three recent candidates.
 */
export function resolveSessionPath(args = {}, config = {}, options = {}) {
  const home = config.home ?? dshHome();
  const explicit = typeof args.sessionPath === 'string' ? args.sessionPath.trim() : '';

  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      return pathRefusal('PATH_NOT_ABSOLUTE', path.resolve(explicit),
        `unavailable: 需要绝对路径或 sessionId（收到 ${JSON.stringify(explicit)}）`);
    }
    const abs = path.resolve(explicit);
    const guarded = guardSessionPath(abs, home, options);
    if (guarded) return guarded;
    let stat = null;
    try { stat = fs.statSync(abs); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      return lookupError('SESSION_NOT_FOUND', `no session log at ${abs}`, listSessions(home));
    }
    return { ok: true, sessionPath: abs, source: 'sessionPath', home };
  }

  const sessions = listSessions(home);
  const id = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  const want = typeof args.session === 'string' ? args.session.trim() : '';

  if (id) {
    const matches = sessions.filter((s) => s.id === id);
    if (matches.length === 1) return acceptPath(matches[0].file, home, { source: 'sessionId' });
    if (matches.length > 1) {
      return {
        ok: false,
        error: {
          code: 'SESSION_AMBIGUOUS',
          message: `session id ${id} exists in ${matches.length} scopes; pass sessionPath instead`,
          candidates: matches.map((s) => ({ id: s.id, scope: s.scope, bytes: s.bytes, modified: new Date(s.mtimeMs).toISOString() })),
        },
      };
    }
    return lookupError('SESSION_NOT_FOUND',
      `no session with id ${id} under ${path.join(home, 'sessions')}`, sessions);
  }

  if (want === 'current') {
    let current = null;
    try {
      // `exec` is the current tool execution: identity.js reads the explicit
      // caller Agent from it before falling back to anything ambient.
      current = typeof config.currentSessionId === 'function'
        ? config.currentSessionId(config.exec)
        : config.currentSessionId;
    } catch { current = null; }
    if (!current) current = process.env.DSH_SESSION_ID ?? null;
    if (!current) {
      return lookupError('SESSION_NOT_FOUND',
        'this host did not expose the current session id; pass sessionId or sessionPath', sessions);
    }
    const match = sessions.find((s) => s.id === current);
    if (!match) {
      return lookupError('SESSION_NOT_FOUND',
        `current session ${current} has no log under ${path.join(home, 'sessions')}`, sessions);
    }
    return acceptPath(match.file, home, { source: 'current' });
  }

  if (want === 'latest') {
    if (sessions.length === 0) {
      return lookupError('SESSION_NOT_FOUND', `no session logs under ${path.join(home, 'sessions')}`, sessions);
    }
    const newest = [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return acceptPath(newest.file, home, { source: 'latest', sessionId: newest.id });
  }

  return lookupError('SESSION_NOT_FOUND',
    'no session selected: pass sessionPath, sessionId, or session:"latest" | "current"', sessions);
}

// --- live-session guard (0.7.2) -------------------------------------------
//
// A manual truncation rewrites the file, but the app that has the session
// loaded still holds the *old* event sequence in memory: the next append then
// writes a torn/duplicate seq and the log becomes unreadable (measured 0.7.0:
// 77 -> 3532). Truncating the session this very app has loaded is therefore
// refused unless the caller proves it is a test/diagnostic run.
//
// The caller id comes from the 0.5.1 chain: identity.resolveCurrentSessionId
// (explicit tool exec -> initiator agent -> env), and is bound into the
// heartbeat registry so the same id is what live tooling sees.

export const LIVE_ESCAPE_CONFIRM_WORD = 'I-KNOW-THIS-CORRUPTS';

export const LIVE_GUARD_CODES = Object.freeze({
  TARGET_IS_LIVE_SESSION: 'VISIBLE_TARGET_IS_LIVE_SESSION',
  CURRENT_ID_UNKNOWN: 'VISIBLE_CURRENT_ID_UNKNOWN',
  ESCAPE_CONFIRM_REQUIRED: 'VISIBLE_LIVE_ESCAPE_CONFIRM_REQUIRED',
});

// The id helper lives in live-target.js so the out-of-app CLI can share it
// without importing the whole tool layer (which depends on the host plugin
// runtime). Re-exported here for the tool modules and existing callers.
export { sessionIdOfLogFile };

/** Resolve the session this app has loaded; never throws. */
export function resolveCallerSessionId(config = {}) {
  let ctx = null;
  try { ctx = typeof config.host === 'function' ? config.host() : null; } catch { ctx = null; }
  let resolved = { id: null, source: 'none' };
  try {
    resolved = resolveCurrentSessionId({ ctx, exec: config.exec ?? null });
  } catch { resolved = { id: null, source: 'none' }; }
  let id = typeof resolved?.id === 'string' ? resolved.id.trim() : '';
  let source = resolved?.source ?? 'none';
  if (!id) {
    try {
      const fallback = typeof config.currentSessionId === 'function'
        ? config.currentSessionId(config.exec)
        : config.currentSessionId;
      if (typeof fallback === 'string' && fallback.trim() !== '') {
        id = fallback.trim();
        source = 'config.currentSessionId';
      }
    } catch { /* fail closed below */ }
  }
  if (!id) return { id: null, source: 'none' };
  try { config.autoHeartbeat?.bind?.(id); } catch { /* registry must not block the guard */ }
  return { id, source };
}

/**
 * Refuse to write the session this app has loaded. Fail-closed: an unknown
 * caller id is a refusal too, because "I cannot tell" must never mean "go".
 *
 * `allowLive:true` is a test/diagnostic escape hatch and additionally requires
 * confirm:"I-KNOW-THIS-CORRUPTS"; the automatic path never sets it.
 */
export function assertNotOwnLiveSession(sessionPath, args = {}, config = {}) {
  const allowLive = args.allowLive === true;
  const escaped = allowLive && args.confirm === LIVE_ESCAPE_CONFIRM_WORD;
  if (allowLive && !escaped) {
    return {
      ok: false,
      code: LIVE_GUARD_CODES.ESCAPE_CONFIRM_REQUIRED,
      escaped: false,
      message: `allowLive:true is diagnostics-only and needs confirm:"${LIVE_ESCAPE_CONFIRM_WORD}" ` +
        `(got ${JSON.stringify(args.confirm)}); it is never used by the automatic path`,
    };
  }
  const target = sessionIdOfLogFile(sessionPath);
  const caller = resolveCallerSessionId(config);
  if (!caller.id && !escaped) {
    return {
      ok: false,
      code: LIVE_GUARD_CODES.CURRENT_ID_UNKNOWN,
      targetId: target.id,
      targetIdSource: target.source,
      currentId: null,
      escaped: false,
      message: 'cannot determine which session this app has loaded (no exec, agent, or DSH_SESSION_ID); ' +
        'refusing to write. Stop the app and use the CLI, or pass allowLive:true with ' +
        `confirm:"${LIVE_ESCAPE_CONFIRM_WORD}" for a test/diagnostic run.`,
    };
  }
  const same = Boolean(caller.id) && caller.id.toLowerCase() === String(target.id).toLowerCase();
  if (same && !escaped) {
    return {
      ok: false,
      code: LIVE_GUARD_CODES.TARGET_IS_LIVE_SESSION,
      targetId: target.id,
      targetIdSource: target.source,
      currentId: caller.id,
      identitySource: caller.source,
      escaped: false,
      message: 'target is the session currently loaded by this app; truncate it only while the app is stopped',
    };
  }
  return {
    ok: true,
    targetId: target.id,
    targetIdSource: target.source,
    currentId: caller.id,
    identitySource: caller.source,
    escaped,
  };
}


function lastTruncation(sessionPath) {
  const file = path.join(path.dirname(sessionPath), 'truncate.json');
  if (!fs.existsSync(file)) return null;
  try {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(ledger.truncations) && ledger.truncations.length
      ? ledger.truncations.at(-1)
      : null;
  } catch {
    return null;
  }
}

export function sessionHealth(args = {}, config = {}) {
  const resolved = resolveSessionPath(args, config);
  if (!resolved.ok) return { status: 'error', ...resolved.error, error: resolved.error };
  const abs = resolved.sessionPath;
  const base = {
    sessionPath: abs,
    exists: fs.existsSync(abs),
    bytes: null,
    events: null,
    firstSeq: null,
    lastType: null,
    visibleMessages: null,
    deriveSha256: null,
    ageSeconds: null,
    backups: 0,
    lastTruncation: lastTruncation(abs),
    status: 'ok',
    message: '',
  };
  if (!base.exists) return { ...base, status: 'missing', message: `no such file: ${abs}` };

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    return { ...base, status: 'unavailable', message: fsUnavailable('无法读取会话日志', error).message };
  }
  if (!stat.isFile()) {
    return { ...base, status: 'unavailable', message: `unavailable: 会话路径不是普通文件 ${abs}` };
  }
  base.bytes = stat.size;
  base.ageSeconds = Math.round((Date.now() - stat.mtimeMs) / 1000);
  base.backups = backupFilesUnder(abs).length;
  try {
    const parsed = parseSession(fs.readFileSync(abs));
    const digest = deriveMessagesDigest(parsed.header, parsed.events);
    base.events = parsed.events.length;
    base.firstSeq = parsed.events[0]?.seq ?? null;
    base.lastType = parsed.events.at(-1)?.type ?? null;
    base.visibleMessages = digest.count;
    base.deriveSha256 = digest.sha256;
    // Shadowed-vs-reclaimed is the difference between "the model forgot" and
    // "the disk forgot"; a longevity tool that reports only one of them will
    // happily approve a truncation that deletes live history. `filePath` makes
    // the analysis re-read the log from disk, so "reclaimed" is a counted fact
    // instead of an inference from event metadata.
    base.compaction = analyzeCompaction(parsed, { filePath: abs });
    base.compactionMessage = describeCompaction(base.compaction);
    base.message = `${formatBytes(stat.size)} / ${base.events} events / ${digest.count} visible messages`;
  } catch (error) {
    base.status = 'corrupt';
    base.message = fsUnavailable('无法解析会话日志', error).message;
  }
  return base;
}

export function sessionBackupPlan(args = {}, config = {}) {
  const dryRun = args.dryRun !== false;
  const resolved = resolveSessionPath(args, config);
  if (!resolved.ok) return { dryRun, status: 'error', ...resolved.error, error: resolved.error };
  const abs = resolved.sessionPath;
  // N4: a backup of a backup is not a backup. Refusing here keeps one clear
  // chain (log -> .bak-*) instead of nesting .bak-…bak-… copies nobody can
  // attribute, and it is refused before confirm/stat/read so nothing is written.
  if (isBackupFileName(path.basename(abs))) {
    return {
      ok: false,
      code: 'IS_BACKUP',
      status: 'unavailable',
      dryRun,
      sessionPath: abs,
      message: `unavailable: ${path.basename(abs)} 已经是 ${SESSION_FILE} 的备份；备份不能再被备份，` +
        `请指向日志本体 ${SESSION_FILE}`,
    };
  }
  // F1: a write needs the explicit word. Checked before any read, so a missing
  // or wrong confirm cannot leave a stat, a sha256 or a file behind.
  if (!dryRun && !backupConfirmOk(args.confirm)) {
    return {
      ok: false,
      sessionPath: abs,
      dryRun: false,
      status: 'unavailable',
      confirm: typeof args.confirm === 'string' ? args.confirm : null,
      message: `unavailable: 需 confirm:"${BACKUP_CONFIRM_WORD}" 才能真写盘`,
    };
  }

  let size;
  let sha256;
  let target;
  try {
    if (!fs.existsSync(abs)) {
      return { sessionPath: abs, dryRun, status: 'missing', message: `no such file: ${abs}` };
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      return {
        ok: false, sessionPath: abs, dryRun, status: 'unavailable',
        message: `unavailable: 源路径不是普通文件 ${abs}`,
      };
    }
    // F3: a zero-byte log has nothing to copy; say so instead of letting the
    // comparison path read a directory afterwards.
    if (stat.size === 0) {
      return { ok: false, sessionPath: abs, dryRun, status: 'unavailable', bytes: 0, message: 'unavailable: 源文件为空' };
    }
    size = stat.size;
    sha256 = sha256File(abs);
    // F4: the target is decided once, in this call, by one function. The real
    // run below uses exactly this name — it never rescans the directory.
    target = planBackupTarget(abs, new Date());
  } catch (error) {
    return fsUnavailable('无法读取会话日志', error, { sessionPath: abs, dryRun });
  }

  // The write must land next to the log and nowhere else, under a session name.
  const sameDir = path.resolve(path.dirname(target.file)) === path.resolve(path.dirname(abs));
  if (!sameDir || !isSessionFileName(path.basename(target.file))) {
    return {
      ok: false, sessionPath: abs, dryRun, status: 'unavailable',
      message: `unavailable: 备份目标不合法（必须与源文件同目录、同 session 文件名）${target.file}`,
    };
  }

  const plan = {
    sessionPath: abs,
    dryRun,
    status: 'planned',
    bytes: size,
    sha256,
    targetFile: target.file,
    targetExists: fs.existsSync(target.file),
    message: dryRun
      ? `would back up ${formatBytes(size)} to ${path.basename(target.file)} (sha256 ${sha256.slice(0, 12)})`
      : '',
  };
  if (dryRun) return plan;

  let created;
  try {
    created = createBackupNow(abs, target.file, sha256, size);
  } catch (error) {
    return fsUnavailable('写备份失败', error, { sessionPath: abs, dryRun, targetFile: target.file });
  }
  return {
    ...plan,
    dryRun: false,
    status: 'created',
    targetFile: created.file,
    sha256: created.sha256,
    ledgerWritten: created.ledgerWritten,
    ledgerWarning: created.ledgerWarning ?? null,
    message: `created ${created.file}${created.ledgerWritten ? '' : `（账本未写入：${created.ledgerWarning}）`}`,
  };
}

export function truncateTool(args = {}, config = {}) {
  const dryRun = args.dryRun !== false;
  // Destructive: only the log itself. A `.bak-*` target is refused with
  // IS_BACKUP before anything is read, let alone written (N4).
  const resolved = resolveSessionPath(args, config, { destructive: true });
  if (!resolved.ok) {
    return { ok: false, dryRun, status: 'error', ...resolved.error, error: resolved.error };
  }
  const keepEvents = args.keepEvents ?? config.keepEvents;
  if (keepEvents !== undefined && keepEvents !== null
    && !(Number.isInteger(keepEvents) && keepEvents >= 1)) {
    return {
      ok: false, dryRun, status: 'error', code: 'BAD_ARGUMENT',
      message: `keepEvents 必须是 >= 1 的整数（事件数，收到 ${JSON.stringify(keepEvents)}）`,
    };
  }
  const escapeConfirmed = args.allowLive === true && args.confirm === LIVE_ESCAPE_CONFIRM_WORD;
  if (!dryRun && args.confirm !== CONFIRM_WORD && !escapeConfirmed) {
    return {
      ok: false, dryRun, status: 'error', code: 'CONFIRM_REQUIRED',
      message: `refusing to write: pass confirm:"${CONFIRM_WORD}" (got ${JSON.stringify(args.confirm)})`,
    };
  }
  if (!dryRun) {
    // Writing the session this app is running is the 0.7.0 torn-log bug: the
    // in-memory cursor still points at the old seq. Refuse before any read that
    // could be mistaken for a write attempt.
    const live = assertNotOwnLiveSession(resolved.sessionPath, args, config);
    if (!live.ok) {
      return { ok: false, dryRun, status: 'error', code: live.code, errorCode: live.code, ...live };
    }
  }
  // The escape word authorizes the tool-level live guard; the core writer still
  // needs its own canonical confirm word. Forwarding the escape word here made
  // the escape path fail closed at the core instead of writing (V12).
  const writeConfirm = escapeConfirmed ? CONFIRM_WORD : args.confirm;
  let summary;
  try {
    summary = truncateSession(resolved.sessionPath, {
      keepEvents,
      dryRun,
      confirm: writeConfirm,
      recentWriteWindowMs: config.recentWriteWindowMs,
    });
  } catch (error) {
    return {
      ok: false, dryRun, status: 'error',
      code: error?.code ?? 'TRUNCATE_FAILED',
      message: error?.message ?? String(error),
    };
  }
  return {
    ...summary,
    ok: true,
    status: summary.needed === false ? 'noop' : (dryRun ? 'planned' : 'truncated'),
  };
}

export function truncateVisibleTool(args = {}, config = {}) {
  const dryRun = args.dryRun !== false;
  const resolved = resolveSessionPath(args, config, { destructive: true });
  if (!resolved.ok) {
    return { ok: false, dryRun, status: 'error', ...resolved.error, error: resolved.error };
  }
  const keepTurns = args.keepTurns ?? DEFAULT_KEEP_TURNS;
  const keepTokens = args.keepTokens ?? DEFAULT_KEEP_TOKENS;
  if (keepTurns !== undefined && keepTurns !== null && !(Number.isInteger(keepTurns) && keepTurns >= 1)) {
    return {
      ok: false, dryRun, status: 'error', code: 'BAD_ARGUMENT',
      message: `keepTurns 必须是 >= 1 的整数（收到 ${JSON.stringify(keepTurns)}）`,
    };
  }
  if (keepTokens !== undefined && keepTokens !== null && !(Number.isInteger(keepTokens) && keepTokens >= 1)) {
    return {
      ok: false, dryRun, status: 'error', code: 'BAD_ARGUMENT',
      message: `keepTokens 必须是 >= 1 的整数（收到 ${JSON.stringify(keepTokens)}）`,
    };
  }
  const escapeConfirmed = args.allowLive === true && args.confirm === LIVE_ESCAPE_CONFIRM_WORD;
  if (!dryRun && args.confirm !== VISIBLE_CONFIRM_WORD && !escapeConfirmed) {
    return {
      ok: false, dryRun, status: 'error', code: 'CONFIRM_REQUIRED',
      message: `refusing to write: pass confirm:"${VISIBLE_CONFIRM_WORD}" (got ${JSON.stringify(args.confirm)})`,
    };
  }
  if (args.firstUserCapChars !== undefined && args.firstUserCapChars !== null
    && !(Number.isInteger(args.firstUserCapChars) && args.firstUserCapChars >= 1)) {
    return {
      ok: false, dryRun, status: 'error', code: 'BAD_ARGUMENT',
      message: `firstUserCapChars 必须是 >= 1 的整数（收到 ${JSON.stringify(args.firstUserCapChars)}）`,
    };
  }
  if (!dryRun) {
    const live = assertNotOwnLiveSession(resolved.sessionPath, args, config);
    if (!live.ok) {
      return { ok: false, dryRun, status: 'error', code: live.code, errorCode: live.code, ...live };
    }
  }
  // Same split of authority as truncateTool: "I-KNOW-THIS-CORRUPTS" clears the
  // live guard only; the writer below still requires "TRUNCATE-VISIBLE".
  const writeConfirm = escapeConfirmed ? VISIBLE_CONFIRM_WORD : args.confirm;
  let summary;
  try {
    summary = truncateVisibleSession(resolved.sessionPath, {
      dryRun,
      confirm: writeConfirm,
      keepTurns,
      keepTokens,
      firstUserCapChars: args.firstUserCapChars,
      boundaryRetries: args.boundaryRetries,
      carryFirstUserMessage: args.carryFirstUserMessage,
      insertArchiveCard: args.insertArchiveCard,
      recentWriteWindowMs: config.recentWriteWindowMs,
      faultAt: config.faultAt,
    });
  } catch (error) {
    const detail = error?.result ?? {};
    const rollback = detail.rollback
      ? `\n回滚：${detail.rollback}`
      : (detail.backupPath ? `\n回滚：Copy-Item -LiteralPath "${detail.backupPath}" -Destination "${resolved.sessionPath}" -Force` : '');
    return {
      ...detail,
      ok: false, dryRun, status: 'error',
      code: error?.code ?? 'VISIBLE_TRUNCATE_FAILED',
      message: `${error?.message ?? String(error)}${rollback}`,
      errorCode: error?.code ?? null,
    };
  }
  return {
    ...summary,
    // 0.8.0-rc.11: a dry run that cannot produce a cut is a failed plan, not a
    // successful tool call. `feasible:false` keeps its structured reason and
    // attempts, so the caller never has to guess why nothing was planned.
    ok: summary.feasible === false ? false : true,
    status: summary.feasible === false
      ? 'infeasible'
      : (summary.needed === false ? 'noop' : (dryRun ? 'planned' : 'truncated')),
  };
}

/**
 * Trigger one native DSH compaction, whose summary is appended to the session
 * log itself (`compaction/summary` + a `compact-checkpoint` user message).
 *
 * Only the host can append those events: a compaction must cover an exact
 * current surface span and run start -> summary -> end inside one open turn.
 * A session log that already ends in `turn/end` therefore cannot be compacted
 * from the outside, and never by hand — which is exactly why the 2026-10-30
 * 13:48 truncation could not restore a summary it had deleted.
 *
 * `compactNow` requires an idle agent, so inside a running turn the request is
 * queued on `whenIdle()` and reported as `scheduled`.
 */
/**
 * Read one Cordis service off the host context without tripping its inject guard.
 *
 * A context object is a Proxy: `ctx.compaction` throws
 * `cannot get property "compaction" without inject` when this plugin never
 * declared that service (Cordis treats an undeclared read as a bug, not as a
 * missing dependency). A profile that simply does not load a compaction service
 * is the normal case here, so the read has to fail soft and report
 * `unavailable` instead of throwing out of the tool.
 */
function probeService(host, name) {
  if (!host) return null;
  try {
    const direct = host[name];
    if (direct != null) return direct;
  } catch {
    // Not declared by this plugin's inject list: treat as absent.
  }
  try {
    const viaGet = typeof host.get === 'function' ? host.get(name) : null;
    if (viaGet != null) return viaGet;
  } catch {
    // Same guard on the accessor path.
  }
  return null;
}

export async function compactTool(args = {}, config = {}) {
  const dryRun = args.dryRun !== false;
  // Compaction rewrites the log it is invoked for, so naming a `.bak-*` copy is
  // refused exactly like truncation (N4). The host service itself only ever
  // targets the live session; this guard makes the tool's own contract match.
  if (args.sessionPath !== undefined || args.sessionId !== undefined || args.session !== undefined) {
    const resolved = resolveSessionPath(args, config, { destructive: true });
    if (!resolved.ok) {
      return { ok: false, dryRun, status: 'error', ...resolved.error, error: resolved.error };
    }
  }
  const host = config.host?.() ?? null;
  const compaction = probeService(host, 'compaction');
  const agent = probeService(host, 'agent');
  // A queued compaction settles after this call returns; keep its state here
  // and hand out copies, so a caller's snapshot can never mutate underneath it.
  const state = {
    ok: true,
    dryRun,
    status: 'unavailable',
    available: Boolean(compaction && agent),
    agentStatus: agent?.status ?? null,
    message: '',
  };
  const snapshot = () => ({ ...state });
  const fail = (error) => {
    state.ok = false;
    state.status = 'failed';
    state.code = error?.code ?? 'COMPACTION_FAILED';
    state.message = `compaction failed: ${error?.message ?? error?.code ?? error}`;
    return snapshot();
  };
  if (!compaction || !agent) {
    state.ok = false;
    state.status = 'unavailable';
    state.code = compaction ? 'COMPACTION_NO_AGENT' : 'COMPACTION_UNAVAILABLE';
    state.message = compaction
      ? 'no agent on this context; run /compact from the composer instead'
      : 'this profile loads no compaction service; run /compact from the composer instead';
    return snapshot();
  }
  if (dryRun) {
    state.status = 'planned';
    state.message = 'native compaction is available; pass dryRun:false to run it now';
    return snapshot();
  }
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error('compaction did not start within 10 minutes')),
    10 * 60_000,
  );
  // A queued compaction outlives the tool call; never keep a process alive for it.
  timer.unref?.();
  const run = () => compaction.compactNow(agent, abort.signal, args.sourceCommandId);
  const succeed = (result) => {
    state.status = result === null ? 'nothing-to-compact' : 'compacted';
    state.result = result;
    state.message = result === null
      ? 'no compactable history yet'
      : `compacted ${result.shadowedSeqs.length} events (~${result.shadowedTokenCount} tokens), summary at seq ${result.summarySeq}`;
    state.message += ' — verify with session_health: compactionFiles must grow and truncation becomes possible.';
  };
  if (agent.status !== 'idle') {
    state.status = 'scheduled';
    state.message = 'queued: compaction starts as soon as this turn ends';
    agent.whenIdle()
      .then(run)
      .then(succeed)
      .catch((error) => {
        fail(error);
        console.error('[longlive] compaction failed:', error?.message ?? error);
      })
      .finally(() => clearTimeout(timer));
    return snapshot();
  }
  try {
    succeed(await run());
    return snapshot();
  } catch (error) {
    clearTimeout(timer);
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// session_wake — one bounded "where was I" slice of the memory store
//
// The wake-up problem: a fresh process cannot afford to read the whole store,
// but it must not start blind either. So it reads four small, high-value
// sources and nothing else. Everything is failure-tolerant on purpose: a
// missing file is a note, never a thrown error, because a wake-up that dies
// because one file is gone is worse than a wake-up that says "that file is
// gone" and continues.
// ---------------------------------------------------------------------------

const WAKE_LIMIT = 2500;
const STATE_SECTIONS = ['我在哪', '在等什么', '最近三件'];
const STATE_SECTION_CHARS = 400;
const FLOW_CHARS = 800;
const JOURNAL_HEADINGS = 3;
const INDEX_LINES = 20;
const INDEX_LINE_MAX = 60;

/**
 * Resolve the memory-store root used by session_wake / lease_acquire /
 * lease_release. This MUST stay the same resolver as `memory_*` uses
 * (`memoryRootSetting` in ./memory/paths.js): in 0.7.2 these two families had
 * different keys and different defaults, so a user who configured
 * `memoryRoot` still had `session_wake` reading a non-existent drive.
 *
 * Order: config.memoryRoot → config.memRoot → $DSH_LONGLIVE_MEMORY_ROOT →
 * $DSH_MEM → <DSH home>/longlive-memory (created on demand). An explicitly
 * configured root is never created here — a typo must surface as
 * `memRootUnavailable`, not as a silent empty store.
 */
export function memRoot(config = {}, env = process.env) {
  const setting = memoryRootSetting(config, env);
  if (setting.explicit) {
    try {
      return path.resolve(setting.explicit);
    } catch {
      return setting.explicit;
    }
  }
  const derived = defaultMemoryRoot(config, env);
  try {
    fs.mkdirSync(derived, { recursive: true });
  } catch {
    // Let memRootUnavailable report the concrete path and the next action.
  }
  return derived;
}

/**
 * One wording for "the memory root is not there", shared by all three
 * memory-store tools. Every caller gets the same shape: 原因 — 怎么办.
 */
function memRootUnavailableMessage(root) {
  return `unavailable: 记忆根目录不存在 ${root} — 创建该目录（mkdir -p），或设置环境变量 ` +
    `${MEMORY_ROOT_ENV}（旧名 ${LEGACY_MEMORY_ROOT_ENV}）指向一个已有记忆库；` +
    `插件配置 memoryRoot 优先级最高，默认根是 <DSH home>/${DEFAULT_MEMORY_DIRNAME}`;
}

/** Codes that mean "the root is gone or not writable", never "someone else holds the lease". */
const LEASE_WRITE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);

/**
 * Pre-flight shared by session_wake / lease_acquire / lease_release.
 *
 * Returns null when `root` is an existing directory, else a report-shaped
 * answer. Never throws: a stat failure (ENOENT/EACCES) is reported, and a path
 * that stats as a *file* counts as missing because these tools need a directory.
 */
function memRootUnavailable(root) {
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = null;
  }
  if (stat && stat.isDirectory()) return null;
  return {
    status: 'unavailable',
    reason: 'mem root unavailable',
    memRoot: root,
    message: memRootUnavailableMessage(root),
  };
}

/** Read a text file, reporting a reason instead of throwing. */
function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, code: 'NOT_A_FILE' };
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'READ_FAILED' };
  }
}

/** Trim to at most `limit` characters; the truncation marker is inside the budget. */
function clampText(text, limit, note) {
  const clean = String(text ?? '').trim();
  if (clean.length <= limit) return { text: clean, truncated: false };
  const suffix = note ?? '…';
  const room = Math.max(0, limit - suffix.length);
  return { text: clean.slice(0, room) + suffix, truncated: true };
}

/**
 * Pull the bodies of the headings whose title contains one of `keywords`
 * (first match per keyword). Body = everything up to the next heading of any
 * level. Sections are looked up, not assumed to be in a fixed order.
 */
function extractSections(text, keywords) {
  const found = new Map();
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current == null) return;
    if (!found.has(current)) found.set(current, buffer.join('\n').trim());
    current = null;
    buffer = [];
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const title = heading[2].trim();
      const hit = keywords.find((keyword) => title.includes(keyword));
      if (hit != null && !found.has(hit)) current = hit;
      continue;
    }
    if (current != null) buffer.push(line);
  }
  flush();
  return found;
}

/**
 * A session label is display-only. It must never be able to start a new line or
 * a heading: the wake text is assembled from headings, so a label containing
 * `\n## …` would forge sections that the memory store never contained.
 */
function wakeSessionLabel(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/#/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
  return cleaned || null;
}

/** Numeric year/month/day key for journal file names; null when not dated. */
function journalTimestamp(name) {
  const match = /^(\d{4})[-_.](\d{1,2})(?:[-_.](\d{1,2}))?/.exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : 0;
  if (month < 1 || month > 12 || day > 31) return null;
  return [year, month, day];
}

/**
 * Newest journal by date, not by string. `.sort()` is lexicographic, so
 * `2026-9.md` would beat `2026-10.md`; a year/month/day key fixes that.
 */
function compareJournalNames(a, b) {
  const left = journalTimestamp(a);
  const right = journalTimestamp(b);
  if (left && right) {
    for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
    return a.localeCompare(b);
  }
  if (left) return 1;
  if (right) return -1;
  return a.localeCompare(b);
}

/**
 * Read a bounded wake-up slice of the memory store.
 *
 * Order matters: STATE.md (where am I / what am I waiting for / last three
 * unfinished things) first, then the flow snapshot, then the newest journal's
 * last three headings, then INDEX.md's short lines. Total output is capped at
 * WAKE_LIMIT characters; the caller gets `missing` and `sources` so a host can
 * tell "nothing to say" from "could not read".
 */
export function sessionWake(args = {}, config = {}) {
  const root = memRoot(config);
  const sessionTag = wakeSessionLabel(args.session);
  const rootProblem = memRootUnavailable(root);
  if (rootProblem) {
    return {
      status: 'unavailable',
      memRoot: root,
      session: sessionTag,
      chars: rootProblem.message.length,
      message: rootProblem.message,
    };
  }

  const missing = [];
  const sources = [];
  const blocks = [];
  let truncated = false;
  blocks.push(`# 醒来 · ${root}${sessionTag ? ` · session=${sessionTag}` : ''}`);

  // 1) STATE.md sections, 400 chars each.
  const statePath = path.join(root, 'STATE.md');
  const stateRead = readText(statePath);
  blocks.push('## STATE.md');
  if (!stateRead.ok) {
    missing.push(`STATE.md (${stateRead.code})`);
    blocks.push(`（跳过：读不到 ${statePath}，${stateRead.code}）`);
  } else {
    sources.push('STATE.md');
    const sections = extractSections(stateRead.text, STATE_SECTIONS);
    for (const keyword of STATE_SECTIONS) {
      const body = sections.get(keyword);
      if (body == null) {
        missing.push(`STATE.md › ${keyword}`);
        blocks.push(`### ${keyword}`, '（跳过：没有这一节）');
        continue;
      }
      const capped = clampText(body, STATE_SECTION_CHARS, '…（本节已截断）');
      if (capped.truncated) truncated = true;
      blocks.push(`### ${keyword}`, capped.text || '（本节为空）');
    }
  }

  // 2) flow/current.md, 800 chars.
  const flowPath = path.join(root, 'flow', 'current.md');
  const flowRead = readText(flowPath);
  blocks.push('## flow/current.md');
  if (!flowRead.ok) {
    missing.push(`flow/current.md (${flowRead.code})`);
    blocks.push(`（跳过：读不到 ${flowPath}，${flowRead.code}）`);
  } else {
    sources.push('flow/current.md');
    const capped = clampText(flowRead.text, FLOW_CHARS, '…（已截断：flow/current.md 超过 800 字）');
    if (capped.truncated) truncated = true;
    blocks.push(capped.text);
  }

  // 3) The newest journal file (largest file name) and its last three ## headings.
  const journalDir = path.join(root, 'journal');
  blocks.push('## journal 最新文件的最后 3 个标题');
  let journalName = null;
  try {
    const names = fs
      .readdirSync(journalDir)
      .filter((entry) => entry.toLowerCase().endsWith('.md'))
      .sort(compareJournalNames);
    if (names.length === 0) {
      missing.push('journal/*.md');
      blocks.push(`（跳过：${journalDir} 里没有 .md 文件）`);
    } else {
      journalName = names.at(-1);
    }
  } catch (error) {
    missing.push(`journal/ (${error?.code ?? 'READ_FAILED'})`);
    blocks.push(`（跳过：读不到 ${journalDir}，${error?.code ?? 'READ_FAILED'}）`);
  }
  if (journalName) {
    const journalPath = path.join(journalDir, journalName);
    const journalRead = readText(journalPath);
    if (!journalRead.ok) {
      missing.push(`journal/${journalName} (${journalRead.code})`);
      blocks.push(`（跳过：读不到 ${journalPath}，${journalRead.code}）`);
    } else {
      const headings = journalRead.text
        .split(/\r?\n/)
        .filter((line) => /^##\s+/.test(line))
        .map((line) => line.trim())
        .slice(-JOURNAL_HEADINGS);
      if (headings.length === 0) {
        blocks.push(`（journal/${journalName} 里没有 ## 标题）`);
      } else {
        sources.push(`journal/${journalName}`);
        blocks.push(`文件：journal/${journalName}`, ...headings.map((line) => `- ${line}`));
      }
    }
  }

  // 4) INDEX.md short lines (length < 60), at most 20.
  const indexPath = path.join(root, 'INDEX.md');
  const indexRead = readText(indexPath);
  blocks.push('## INDEX.md 短行');
  if (!indexRead.ok) {
    missing.push(`INDEX.md (${indexRead.code})`);
    blocks.push(`（跳过：读不到 ${indexPath}，${indexRead.code}）`);
  } else {
    sources.push('INDEX.md');
    const short = indexRead.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.length < INDEX_LINE_MAX);
    const picked = short.slice(0, INDEX_LINES);
    if (picked.length === 0) {
      blocks.push('（没有长度小于 60 的行）');
    } else {
      blocks.push(...picked.map((line) => `- ${line}`));
      if (short.length > picked.length) blocks.push(`（另有 ${short.length - picked.length} 行短行未列出）`);
    }
  }

  if (missing.length > 0) blocks.push(`（缺失：${missing.join('；')}）`);

  let text = blocks.join('\n').trim();
  if (text.length > WAKE_LIMIT) {
    const note = '\n…（整体已截断到 2500 字上限）';
    const room = WAKE_LIMIT - note.length;
    // Cut on a line boundary so a half-written INDEX row never ends the wake
    // text; fall back to a hard cut only if one single line eats the budget.
    const boundary = text.lastIndexOf('\n', room);
    text = text.slice(0, boundary > Math.floor(room / 2) ? boundary : room) + note;
    truncated = true;
  }
  return {
    status: 'ok',
    memRoot: root,
    session: sessionTag,
    chars: text.length,
    truncated,
    sources,
    missing,
    message: text,
  };
}

// ---------------------------------------------------------------------------
// lease_acquire / lease_release — one writer at a time across processes
//
// The lease is a single file created with O_EXCL ('wx'): the kernel guarantees
// exactly one creator, so no read-check-then-write race. Content is a small
// JSON record; a record that is dead by TTL (or unparseable) can be replaced,
// and replacement is attempted exactly once so two contenders cannot livelock.
// ---------------------------------------------------------------------------

/** A lease longer than a day is a typo, not a plan: it also overflows Date. */
const MAX_LEASE_TTL_SEC = 86_400;
const MIN_LEASE_TTL_SEC = 1;
/** Date can only render milliseconds in this span; outside it toISOString throws. */
const MIN_ISO_MS = -8.64e15;
const MAX_ISO_MS = 8.64e15;

/** True when `ms` is a timestamp Date can format without throwing RangeError. */
function isSafeDateMs(ms) {
  return Number.isFinite(ms) && ms >= MIN_ISO_MS && ms <= MAX_ISO_MS;
}

/** ISO string, or null when the timestamp is not representable. Never throws. */
function isoOrNull(ms) {
  return isSafeDateMs(ms) ? new Date(ms).toISOString() : null;
}

function leasePayloadOf(holder, ttlSec, now = Date.now()) {
  // expiresAt is built and validated before the record is written: a lease that
  // cannot state when it ends must never reach the disk (it used to be written
  // first and throw afterwards, leaving every later caller stuck).
  const expiresAt = isoOrNull(now + ttlSec * 1000);
  if (!expiresAt) {
    const error = new Error('lease expiry is out of the representable date range');
    error.code = 'BAD_ARGUMENT';
    throw error;
  }
  return { holder, pid: process.pid, acquiredAt: new Date(now).toISOString(), expiresAt, ttlSec };
}

/**
 * "The root passed the pre-flight but the .lease file still could not be
 * created" — the directory vanished between the check and the open, or it is
 * not writable. Same shape as the missing-root answer, with the OS code kept in
 * parentheses so the cause is diagnosable without dumping a bare ENOENT.
 */
function leaseCreateUnavailable(leasePath, holder, code) {
  return {
    ok: false,
    status: 'unavailable',
    reason: 'mem root not writable',
    code,
    leasePath,
    holder: null,
    requestedHolder: holder,
    message: `unavailable: 无法在 ${leasePath} 创建租约文件（${code}）— 检查记忆根目录是否存在且可写`,
  };
}

/** Read and parse the lease file without throwing. */
function readLease(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, code: error?.code ?? 'READ_FAILED', lease: null };
  }
  try {
    const lease = JSON.parse(text);
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
      return { ok: false, code: 'INVALID', lease: null };
    }
    return { ok: true, lease };
  } catch {
    return { ok: false, code: 'INVALID', lease: null };
  }
}

/** TTL judgement: no usable acquiredAt/ttlSec counts as expired. */
/**
 * Decide whether a lease record is still valid, and when it ends.
 *
 * A corrupt expiry must never be able to wedge the memory root: a record whose
 * `expiresAt` is unparseable, NaN or outside the representable date range is
 * treated as expired, so the next writer takes it over instead of crashing on
 * every read (the old code called new Date(expiresAt).toISOString() and threw
 * RangeError here, locking every later caller out of the lease).
 */
function leaseExpiry(lease) {
  const acquiredMs = typeof lease?.acquiredAt === 'string' ? Date.parse(lease.acquiredAt) : NaN;
  const ttlSec = Number(lease?.ttlSec);
  const declared = lease && lease.expiresAt !== undefined && lease.expiresAt !== null
    ? (typeof lease.expiresAt === 'string' ? Date.parse(lease.expiresAt) : NaN)
    : null;

  // An explicit expiresAt is authoritative when it is usable. When it is not,
  // the record cannot be trusted to still hold the lease — treat it as expired.
  if (declared !== null) {
    if (!isSafeDateMs(declared)) return { valid: false, expired: true, expiresAt: null, reason: 'bad-expiresAt' };
    return { valid: true, expired: Date.now() >= declared, expiresAt: declared };
  }

  if (!Number.isFinite(acquiredMs) || !isSafeDateMs(acquiredMs)) {
    return { valid: false, expired: true, expiresAt: null, reason: 'bad-acquiredAt' };
  }
  if (!Number.isFinite(ttlSec) || ttlSec < MIN_LEASE_TTL_SEC || ttlSec > MAX_LEASE_TTL_SEC) {
    return { valid: false, expired: true, expiresAt: null, reason: 'bad-ttl' };
  }
  const expiresAt = acquiredMs + ttlSec * 1000;
  if (!isSafeDateMs(expiresAt)) {
    return { valid: false, expired: true, expiresAt: null, reason: 'expiry-out-of-range' };
  }
  return { valid: true, expired: Date.now() >= expiresAt, expiresAt };
}

/**
 * Atomic create: openSync(path, 'wx') fails with EEXIST when the lease exists,
 * and succeeds for exactly one writer when it does not.
 *
 * After writing we re-read the file. A contender that observes our still-empty
 * file treats it as expired, unlinks it and creates its own — the re-read makes
 * sure the lease that survives is ours, so two writers never both report ok.
 */
function createLease(file, payload) {
  const text = JSON.stringify(payload);
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (error) {
    return { created: false, error };
  }
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* best effort: durability is not the contract */ }
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  let seen = null;
  try { seen = fs.readFileSync(file, 'utf8'); } catch { seen = null; }
  if (seen !== text) {
    const error = new Error('lease changed while it was being created');
    error.code = 'LEASE_RACE';
    return { created: false, raceLost: true, error };
  }
  return { created: true };
}

function acquireOk(leasePath, payload, extra = {}) {
  const expiry = leaseExpiry(payload);
  return {
    ok: true,
    leasePath,
    holder: payload.holder,
    pid: payload.pid,
    acquiredAt: payload.acquiredAt,
    ttlSec: payload.ttlSec,
    expiresAt: isoOrNull(expiry.expiresAt),
    ...extra,
    message: `${extra.tookOver ? 'lease taken over' : 'lease acquired'} by ${payload.holder} (pid ${payload.pid}) for ${payload.ttlSec}s`,
  };
}

function heldBy(leasePath, lease, requestedHolder, message) {
  const expiry = leaseExpiry(lease);
  return {
    ok: false,
    reason: 'held by another writer',
    leasePath,
    holder: typeof lease?.holder === 'string' ? lease.holder : null,
    acquiredAt: typeof lease?.acquiredAt === 'string' ? lease.acquiredAt : null,
    pid: Number.isInteger(lease?.pid) ? lease.pid : null,
    ttlSec: Number.isFinite(Number(lease?.ttlSec)) ? Number(lease.ttlSec) : null,
    expiresAt: isoOrNull(expiry.expiresAt),
    requestedHolder,
    message: message ?? `lease is held by ${lease?.holder ?? '(unknown holder)'} since ${lease?.acquiredAt ?? '(unknown time)'} — reason: held by another writer`,
  };
}

/** Take the lease for `holder`; TTL default 300s. Exactly one caller wins per lease. */
export function leaseAcquire(args = {}, config = {}) {
  const root = memRoot(config);
  const holder = typeof args.holder === 'string' ? args.holder.trim() : '';
  const leasePath = path.join(root, '.lease');
  // Checked before anything opens a path under the root: on a host with no
  // memory store, openSync('wx') used to surface a bare ENOENT that said
  // nothing about what to do. Must be a directory, not just an existing path.
  const rootProblem = memRootUnavailable(root);
  if (rootProblem) {
    return { ok: false, ...rootProblem, leasePath, holder: null, requestedHolder: holder || null };
  }
  if (!holder) {
    return {
      ok: false,
      reason: 'holder required',
      leasePath,
      holder: null,
      requestedHolder: null,
      message: 'lease_acquire needs holder (a non-empty string)',
    };
  }
  if (args.ttlSec !== undefined && args.ttlSec !== null
    && !(Number.isInteger(args.ttlSec)
      && args.ttlSec >= MIN_LEASE_TTL_SEC && args.ttlSec <= MAX_LEASE_TTL_SEC)) {
    return {
      ok: false,
      status: 'error',
      reason: 'invalid ttlSec',
      code: 'BAD_ARGUMENT',
      leasePath,
      holder: null,
      requestedHolder: holder,
      message: `ttlSec 必须是 ${MIN_LEASE_TTL_SEC}..${MAX_LEASE_TTL_SEC} 之间的整数（秒）`,
    };
  }
  const ttlSec = Number.isInteger(args.ttlSec)
    && args.ttlSec >= MIN_LEASE_TTL_SEC && args.ttlSec <= MAX_LEASE_TTL_SEC
    ? args.ttlSec : 300;

  // memRoot creates only the derived default; an explicitly configured root
  // that is missing was reported above and must not be created here — that
  // would hide the exact misconfiguration the message explains.
  const payload = leasePayloadOf(holder, ttlSec);
  const first = createLease(leasePath, payload);
  if (first.created) return acquireOk(leasePath, payload);
  if (!first.raceLost && LEASE_WRITE_CODES.has(first.error?.code)) {
    return leaseCreateUnavailable(leasePath, holder, first.error.code);
  }
  if (first.error?.code !== 'EEXIST' && !first.raceLost) {
    return {
      ok: false,
      reason: 'lease io error',
      code: first.error?.code ?? 'UNKNOWN',
      leasePath,
      requestedHolder: holder,
      message: `cannot create ${leasePath}: ${first.error?.code ?? first.error?.message}`,
    };
  }

  const seen = readLease(leasePath);
  if (seen.ok) {
    const expiry = leaseExpiry(seen.lease);
    if (expiry.valid && !expiry.expired) return heldBy(leasePath, seen.lease, holder);
  }
  const previous = seen.ok
    ? { holder: seen.lease.holder ?? null, acquiredAt: seen.lease.acquiredAt ?? null, expired: true }
    : null;

  // Expired (or unreadable, or vanished) — clear it and retry exactly once.
  try {
    fs.unlinkSync(leasePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return {
        ok: false,
        reason: 'lease io error',
        code: error?.code ?? 'UNKNOWN',
        leasePath,
        requestedHolder: holder,
        message: `cannot clear expired lease ${leasePath}: ${error?.code ?? error?.message}`,
      };
    }
  }
  const second = createLease(leasePath, payload);
  if (second.created) return acquireOk(leasePath, payload, { tookOver: true, previous });
  if (!second.raceLost && LEASE_WRITE_CODES.has(second.error?.code)) {
    return leaseCreateUnavailable(leasePath, holder, second.error.code);
  }

  const now = readLease(leasePath);
  if (now.ok) return heldBy(leasePath, now.lease, holder, 'lost the takeover race — reason: held by another writer');
  return {
    ok: false,
    reason: 'held by another writer',
    leasePath,
    holder: null,
    acquiredAt: null,
    requestedHolder: holder,
    message: 'lost the takeover race and the lease vanished — retry lease_acquire',
  };
}

/** Release the lease, but only for the holder recorded inside it. */
export function leaseRelease(args = {}, config = {}) {
  const root = memRoot(config);
  const holder = typeof args.holder === 'string' ? args.holder.trim() : '';
  const leasePath = path.join(root, '.lease');
  // Same pre-flight as lease_acquire: "no lease at <root>/.lease" is a wrong
  // answer when the root itself does not exist.
  const rootProblem = memRootUnavailable(root);
  if (rootProblem) {
    return { ok: false, ...rootProblem, leasePath, holder: null, requestedHolder: holder || null };
  }
  if (!holder) {
    return {
      ok: false,
      reason: 'holder required',
      leasePath,
      holder: null,
      requestedHolder: null,
      message: 'lease_release needs holder (a non-empty string)',
    };
  }
  const seen = readLease(leasePath);
  if (!seen.ok) {
    if (seen.code === 'ENOENT') {
      return {
        ok: false,
        reason: 'no lease',
        leasePath,
        holder: null,
        requestedHolder: holder,
        message: `no lease at ${leasePath}`,
      };
    }
    return {
      ok: false,
      reason: 'lease unreadable',
      code: seen.code,
      leasePath,
      holder: null,
      requestedHolder: holder,
      message: `lease at ${leasePath} is unreadable (${seen.code}); refusing to delete it`,
    };
  }
  const current = typeof seen.lease?.holder === 'string' ? seen.lease.holder : null;
  if (current !== holder) {
    return {
      ok: false,
      reason: 'not the holder',
      leasePath,
      holder: current,
      requestedHolder: holder,
      message: `lease is held by ${current ?? '(unknown holder)'}; ${holder} may not release it`,
    };
  }
  try {
    fs.unlinkSync(leasePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // Someone removed it between our read and our unlink: the lease is gone,
      // which is the outcome the holder asked for.
      return { ok: true, released: true, alreadyGone: true, leasePath, holder, message: `lease released by ${holder} (already removed)` };
    }
    return {
      ok: false,
      reason: 'lease io error',
      code: error?.code ?? 'UNKNOWN',
      leasePath,
      holder,
      requestedHolder: holder,
      message: `cannot delete ${leasePath}: ${error?.code ?? error?.message}`,
    };
  }
  return { ok: true, released: true, leasePath, holder, message: `lease released by ${holder}` };
}

// ---------------------------------------------------------------------------
// worker_* — background child sessions through the host `subagents` service
//
// The Cordis service key is the string "subagents", and it must be read with
// ctx.get('subagents'): a bare ctx.subagents read is blocked by the inject guard
// because this plugin only injects ['tools'].
//
// Confirmed against @deepseek-ai/dsh-subagent/lib/index.js:
//   async startActivation(spec)                       (index.js:3036)
//     spec = { provider, label?, request: { prompt, parent, ... }, signal, delivery }
//     request.prompt is an ARRAY of content parts — [{ type: 'text', text }]
//     request.parent must be the exact live Agent object from the registry (:3045)
//     returns { childId, messageId, result, dispose } (manager.js:400 -> receipt at :2072)
//   interrupt(targetSessionId, authority)             (index.js:3105)
//     authority = { kind: 'ancestor', agent } | { kind: 'user', parentSessionId }
//     an absent target is an accepted no-op, so existence is proven first
//
// Every failure is reported as "unavailable: …" and never thrown: a tool that
// throws takes the whole turn down, while a tool that degrades tells the model
// what to do next. Same wording discipline as session_wake / lease_*.
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_TIMEOUT_SEC = 600;
const WORKER_NO_SERVICE = 'unavailable: 本宿主未提供 subagents 服务';

/**
 * 1.6.0 safety default (abuse assessment §3.1 / §4.1): the three fan-out tools
 * stay in the documented 22-tool table so the surface stays stable, but every
 * host invocation returns `status:'unavailable'` until the profile explicitly
 * sets `workers.enabled: true`. A switch, not a removal, keeps the tool list
 * byte-identical to 1.5.0 while taking the capability away by default.
 */
export const WORKER_TOOL_NAMES = Object.freeze(['worker_spawn', 'worker_status', 'worker_kill']);
export const WORKERS_DEFAULTS = Object.freeze({ enabled: false });
export const WORKERS_DISABLED_MESSAGE =
  'unavailable: worker_* 默认关闭（workers.enabled=false）；需要派子会话时请在配置里显式设置 workers.enabled: true';

function workerUnavailable(message) {
  return { ok: false, status: 'unavailable', available: false, message };
}

/** `code: message` when there is one, else `String(error)`; never empty. */
function errorDetail(error) {
  if (!error) return '未知原因';
  const code = error.code ? `${error.code}: ` : '';
  return `${code}${error.message ?? String(error)}`;
}

/** Reach the plugin's Cordis context without letting a host() throw escape. */
function safeHost(config = {}) {
  try {
    return typeof config.host === 'function' ? config.host() ?? null : null;
  } catch {
    return null;
  }
}

/**
 * The exact live Agent that authorizes a child. `exec.agent` is the calling
 * agent handed to every tool execution (dsh-tool-subagent uses the same field);
 * probed only as a fallback so plain-node tests and older hosts still resolve.
 */
function workerParent(config = {}) {
  const exec = config.exec;
  const fromExec = exec && typeof exec === 'object' ? exec.agent : null;
  if (fromExec) return fromExec;
  return probeService(safeHost(config), 'agent');
}

function workerIdArg(args = {}) {
  return typeof args.workerId === 'string' ? args.workerId.trim() : '';
}

/**
 * Pick a provider without hard-coding one: ask the service what it has.
 * Continuable providers (correct `prepareContinuable`, i.e. the in-process
 * spawn/fork backends) are preferred, because only they can honor a reserved
 * child id and report progress by session id.
 */
function chooseWorkerProvider(subagents) {
  let names = [];
  try {
    names = typeof subagents.list === 'function' ? subagents.list() : [];
  } catch {
    names = [];
  }
  if (!Array.isArray(names) || names.length === 0) return null;
  const continuable = [];
  for (const name of names) {
    try {
      const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(name) : null;
      if (provider && typeof provider.prepareContinuable === 'function') continuable.push(name);
    } catch {
      // A lookup failure is not fatal; fall back to registration order below.
    }
  }
  const pool = continuable.length > 0 ? continuable : names;
  for (const preferred of ['spawn', 'fork']) {
    if (pool.includes(preferred)) return preferred;
  }
  return pool[0];
}

/** One dispatched worker: return its id, never its promise, never throw. */
export async function workerSpawn(args = {}, config = {}) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return workerUnavailable('unavailable: 缺少必填参数 prompt（要派给子会话的任务文本）');
  if (args.timeoutSec !== undefined && args.timeoutSec !== null
    && !(Number.isInteger(args.timeoutSec) && args.timeoutSec >= 1)) {
    return {
      ok: false,
      status: 'error',
      reason: 'invalid timeoutSec',
      code: 'BAD_ARGUMENT',
      message: 'timeoutSec 必须是 >= 1 的整数（秒）',
    };
  }
  const labelArg = typeof args.label === 'string' ? args.label.trim() : '';
  const timeoutSec = Number.isInteger(args.timeoutSec) && args.timeoutSec >= 1
    ? Math.min(args.timeoutSec, 24 * 60 * 60)
    : DEFAULT_WORKER_TIMEOUT_SEC;
  const host = safeHost(config);
  const subagents = probeService(host, 'subagents');
  if (!subagents || typeof subagents.startActivation !== 'function') {
    return workerUnavailable(WORKER_NO_SERVICE);
  }
  const parent = workerParent(config);
  if (!parent || typeof parent.id !== 'string' || parent.id.length === 0) {
    return workerUnavailable('unavailable: 开子会话失败（当前上下文没有活着的 Agent，spec.request.parent 必须是注册表里的活 Agent）');
  }
  const provider = chooseWorkerProvider(subagents);
  if (!provider) {
    return workerUnavailable('unavailable: 开子会话失败（subagents 服务没有注册任何 provider）');
  }
  const label = (labelArg || prompt).slice(0, 120);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`worker_spawn 超过 ${timeoutSec} 秒仍未派发完成`)),
    timeoutSec * 1000,
  );
  // A dispatched child outlives this tool call; never keep the process alive.
  timer.unref?.();
  let signal = controller.signal;
  try {
    const callerSignal = config.exec?.signal;
    if (callerSignal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([callerSignal, controller.signal]);
    }
  } catch {
    signal = controller.signal;
  }
  try {
    const started = await subagents.startActivation({
      provider,
      label,
      request: {
        // Confirmed shape (dsh-tool-subagent/lib/index.js:464): content parts,
        // not a bare string.
        prompt: [{ type: 'text', text: prompt }],
        parent,
      },
      signal,
      delivery: 'parent',
    });
    const workerId = typeof started?.childId === 'string' && started.childId.length > 0 ? started.childId : null;
    if (!workerId) {
      return workerUnavailable('unavailable: 开子会话失败（startActivation 没有返回 childId）');
    }
    return {
      ok: true,
      status: 'dispatched',
      available: true,
      workerId,
      provider,
      label,
      messageId: typeof started?.messageId === 'string' ? started.messageId : null,
      timeoutSec,
      parentSessionId: parent.id,
      message: `已派发 ${workerId}（provider ${provider}，label "${label}"，超时 ${timeoutSec} 秒）`,
    };
  } catch (error) {
    return workerUnavailable(`unavailable: 开子会话失败（${errorDetail(error)}）`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where a worker stands. Three layers, cheapest first: the live Agent registry,
 * the parent-owned child catalog, then the persisted session log. A worker that
 * is none of the three does not exist.
 */
export async function workerStatus(args = {}, config = {}) {
  const workerId = workerIdArg(args);
  if (!workerId) return workerUnavailable('unavailable: 缺少必填参数 workerId（worker_spawn 返回的 id）');
  const host = safeHost(config);
  const home = config.home ?? dshHome();

  // 1) Live: local children stay in the Agent registry while they run.
  const agents = probeService(host, 'agents');
  let live = null;
  try {
    live = agents && typeof agents.get === 'function' ? agents.get(workerId) : null;
  } catch {
    live = null;
  }
  const persisted = listSessions(home).find((session) => session.id === workerId) ?? null;
  if (live) {
    const status = typeof live.status === 'string' && live.status.length > 0 ? live.status : 'unknown';
    let events = null;
    let lastEventType = null;
    try {
      const snapshot = typeof live.session?.snapshotEvents === 'function' ? live.session.snapshotEvents() : null;
      if (Array.isArray(snapshot)) {
        events = snapshot.length;
        lastEventType = snapshot.length > 0 ? snapshot.at(-1)?.type ?? null : null;
      }
    } catch {
      events = null;
    }
    return {
      ok: true,
      status,
      available: true,
      live: true,
      workerId,
      events,
      lastEventType,
      lastMessageAt: persisted ? new Date(persisted.mtimeMs).toISOString() : null,
      sessionPath: persisted?.file ?? null,
      message: `worker ${workerId} 活着，状态 ${status}${events === null ? '' : `，已记 ${events} 个事件`}`,
    };
  }

  // 2) Catalog: durable direct-child rows owned by this parent (needs the
  // sessionQuery service; degrade to the log when it is absent).
  const subagents = probeService(host, 'subagents');
  const parent = workerParent(config);
  let catalogRow = null;
  if (subagents && typeof subagents.listChildren === 'function' && parent && typeof parent.id === 'string') {
    try {
      const rows = await subagents.listChildren(parent.id, undefined);
      catalogRow = Array.isArray(rows) ? rows.find((row) => row && row.id === workerId) ?? null : null;
    } catch {
      catalogRow = null;
    }
  }

  // 3) Persisted session log: events count, last message time, and a status word.
  if (persisted) {
    let events = null;
    let lastEventType = null;
    try {
      const parsed = parseSession(fs.readFileSync(persisted.file));
      events = parsed.events.length;
      lastEventType = parsed.events.at(-1)?.type ?? null;
    } catch {
      events = null;
    }
    const state = catalogRow ? 'inactive-child' : 'persisted';
    const lastMessageAt = new Date(persisted.mtimeMs).toISOString();
    return {
      ok: true,
      status: state,
      available: true,
      live: false,
      workerId,
      events,
      lastEventType,
      lastMessageAt,
      sessionPath: persisted.file,
      catalog: catalogRow,
      message: `worker ${workerId} 不在运行：状态 ${state}，${events === null ? '事件数未知' : `${events} 个事件`}，最后写入 ${lastMessageAt}`,
    };
  }

  if (catalogRow) {
    return {
      ok: true,
      status: 'inactive',
      available: true,
      live: false,
      workerId,
      events: null,
      lastEventType: null,
      lastMessageAt: null,
      sessionPath: null,
      catalog: catalogRow,
      message: `worker ${workerId} 在子会话目录里，但既不在运行也没有会话文件可读`,
    };
  }

  return workerUnavailable('unavailable: 找不到这个 worker');
}

/**
 * Stop a running worker. `interrupt` is fire-and-return and treats an absent
 * target as an accepted no-op, so the target is proven live first — otherwise a
 * typo would be reported as a successful kill.
 */
export async function workerKill(args = {}, config = {}) {
  const workerId = workerIdArg(args);
  if (!workerId) return workerUnavailable('unavailable: 缺少必填参数 workerId（worker_spawn 返回的 id）');
  const reason = typeof args.reason === 'string' && args.reason.trim().length > 0 ? args.reason.trim() : null;
  const host = safeHost(config);
  const subagents = probeService(host, 'subagents');
  if (!subagents || typeof subagents.interrupt !== 'function') {
    return workerUnavailable('unavailable: 终止失败（本宿主未提供 subagents 服务）');
  }
  const parent = workerParent(config);
  if (!parent || typeof parent.id !== 'string' || parent.id.length === 0) {
    return workerUnavailable('unavailable: 终止失败（当前上下文没有活着的 Agent，拿不到终止授权）');
  }
  // F5: interrupt() accepts an absent target as a no-op, so "killed" may only be
  // reported after the same probe worker_status uses says the worker is live.
  // Sharing that probe is what keeps kill and status from contradicting each
  // other on the same id (no `agents` service ⇒ status unavailable ⇒ kill too).
  let statusReport;
  try {
    statusReport = await workerStatus({ workerId }, config);
  } catch (error) {
    return workerUnavailable(`unavailable: 终止失败（查不到 worker 状态：${errorDetail(error)}）`);
  }
  if (!statusReport || statusReport.ok !== true || statusReport.live !== true) {
    const detail = statusReport?.ok === true
      ? `worker ${workerId} 不在运行（状态 ${statusReport.status}）`
      : '找不到这个 worker';
    return workerUnavailable(`unavailable: 终止失败（${detail}；未调用 interrupt，不返回假成功）`);
  }
  try {
    await subagents.interrupt(workerId, { kind: 'ancestor', agent: parent });
    return {
      ok: true,
      status: 'killed',
      available: true,
      live: true,
      workerId,
      reason,
      message: `worker killed: ${workerId}${reason ? `（${reason}）` : ''}`,
    };
  } catch (error) {
    return workerUnavailable(`unavailable: 终止失败（${errorDetail(error)}）`);
  }
}

const SESSION_ARGS = {
  sessionPath: {
    type: 'string',
    description: 'Absolute path to a session.v4.jsonl.zstd file (highest priority).',
  },
  sessionId: {
    type: 'string',
    description: 'Session id (the folder name under <DSH_HOME>/sessions/<scope>/).',
  },
  session: {
    type: 'string',
    description: 'Shortcut instead of an id: "latest" (most recently modified log) or "current".',
  },
};

const OUTPUT_TEXT = (value) => [{ type: 'text', text: typeof value === 'string' ? value : value.message ?? JSON.stringify(value) }];

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function argumentType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Tool-entry gate for the memory_* family. args and config must be plain
 * objects: without this, `null` dies with a bare TypeError on the first
 * property read, and a string/array is silently treated as an empty object.
 * The check is explicit rather than optional chaining so a wrong type is
 * reported as such instead of being masked.
 */
function memoryTool(name, fn) {
  return (args, config) => {
    if (!isPlainObject(args)) {
      throw memoryError('E_BAD_ARGUMENT', `${name} 的 args 必须是普通对象，收到 ${argumentType(args)}`);
    }
    if (!isPlainObject(config)) {
      throw memoryError('E_BAD_ARGUMENT', `${name} 的 config 必须是普通对象，收到 ${argumentType(config)}`);
    }
    return fn(args, config);
  };
}

// --- D3: fetch the original text of one turn ------------------------------
//
// session_original is the deliberate escape hatch from the compressed view:
// the agent has a sessionId + turn (usually from session_search or
// memory_recall) and needs the bytes that were folded away. It is read-only,
// scans the WHOLE selection before slicing anything, and never writes the D2
// archive — it only reports the path D2 would use.

const ORIGINAL_DEFAULT_MAX_BYTES = 64 * 1024;
const ORIGINAL_MIN_MAX_BYTES = 1024;
const ORIGINAL_MAX_MAX_BYTES = 4 * 1024 * 1024;
const ORIGINAL_ARCHIVE_LIMIT = 20;
const ORIGINAL_TURN_LIMIT = 50;
const ORIGINAL_CALL_ID_LIMIT = 50;

function originalError(code, message, extra = {}) {
  return {
    ok: false,
    status: code === 'PRIVACY_BLOCKED' ? 'blocked' : 'error',
    code,
    error: { code, message },
    message: `unavailable: ${message}`,
    ...extra,
  };
}

function originalClampInteger(value, min, max) {
  if (!Number.isInteger(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function originalMaxBytes(config) {
  const configured = config?.originalFetchMaxBytes;
  return originalClampInteger(
    Number.isInteger(configured) ? configured : ORIGINAL_DEFAULT_MAX_BYTES,
    ORIGINAL_MIN_MAX_BYTES,
    ORIGINAL_MAX_MAX_BYTES,
  );
}

/** Where D2 would archive a turn, without creating anything. */
function originalArchiveRoot(config) {
  const env = config?.env ?? process.env;
  const setting = memoryRootSetting(config ?? {}, env);
  return setting.explicit
    ? path.resolve(setting.explicit)
    : defaultMemoryRoot(config ?? {}, env);
}

function originalSessionCoordinates(sessionPath, home) {
  try {
    const rel = path.relative(path.join(home, 'sessions'), sessionPath);
    const parts = rel.split(path.sep);
    if (parts.length >= 3 && parts[0] !== '..' && !path.isAbsolute(rel)) {
      return { scope: parts[0], sessionId: parts[1] };
    }
  } catch {
    // fall through
  }
  return { scope: null, sessionId: null };
}

function originalItemSummary(item, archive) {
  return {
    kind: item.kind,
    role: item.role,
    step: item.step,
    seq: item.seq,
    time: item.time,
    messageIndex: item.messageIndex,
    toolIndex: item.toolIndex,
    callIndex: item.callIndex,
    toolCallId: item.toolCallId,
    toolName: item.toolName,
    isError: item.isError,
    nonTextParts: item.nonTextParts,
    bytes: Buffer.byteLength(item.text, 'utf8'),
    archive,
  };
}

function originalArchivePlan(items, turn, config) {
  const dir = path.join(originalArchiveRoot(config), '.longlive', 'tool-output', String(turn));
  const used = new Set();
  return items.slice(0, ORIGINAL_ARCHIVE_LIMIT).map((item) => {
    let name = archiveFileName(item);
    if (used.has(name)) name = name.replace(/\.txt$/, `-${item.seq}.txt`);
    used.add(name);
    const file = path.join(dir, name);
    let exists = false;
    let size = null;
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) {
        exists = true;
        size = stat.size;
      }
    } catch {
      // A missing archive is the normal case: this tool never writes it.
    }
    return {
      convention: '<memoryRoot>/.longlive/tool-output/<turn>/<id>.txt',
      path: file,
      exists,
      ...(size == null ? {} : { size }),
    };
  });
}

function originalRender(_args, value) {
  if (!isPlainObject(value)) return OUTPUT_TEXT(value);
  const lines = [];
  if (value.ok) {
    const size = `${value.returnedBytes ?? 0}/${value.totalBytes ?? 0} B`;
    lines.push(`session_original: turn ${value.turn} — ${value.selectedCount ?? 0} selected item(s), ${size}` +
      `${value.truncated ? ' (truncated)' : ''}`);
    if (value.message) lines.push(value.message);
    if (typeof value.content === 'string' && value.content !== '') {
      lines.push('', value.content);
    }
    if (value.truncated) {
      lines.push('', `... [truncated; continue with offset=${value.nextOffset}]`);
    }
    if (Array.isArray(value.archives) && value.archives.length > 0) {
      lines.push('', 'D2 archive path (written by D2 only when d2.enabled; this tool just plans it):');
      for (const archive of value.archives) {
        lines.push(`  ${archive.path}${archive.exists ? ` (exists, ${archive.size} B)` : ' (not present)'}`);
      }
    }
  } else {
    lines.push(`session_original: ${value.code ?? 'error'} — ${value.error?.message ?? value.message ?? ''}`);
    if (Array.isArray(value.availableTurns) && value.availableTurns.length > 0) {
      lines.push(`  recent turns: ${value.availableTurns.join(', ')}`);
    }
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

function sessionOriginalImpl(args = {}, config = {}) {
  if (!isPlainObject(args)) {
    return originalError('E_BAD_ARGUMENT', `args must be an object, received ${argumentType(args)}`);
  }
  if (!isPlainObject(config)) {
    return originalError('E_BAD_ARGUMENT', `config must be an object, received ${argumentType(config)}`);
  }

  const turn = args.turn;
  if (!Number.isInteger(turn) || turn < 1) {
    return originalError('E_BAD_ARGUMENT', 'turn is required and must be an integer >= 1');
  }
  const kind = args.kind === undefined ? 'tool' : args.kind;
  if (!ORIGINAL_KINDS.includes(kind)) {
    return originalError('E_BAD_ARGUMENT', `kind must be one of ${ORIGINAL_KINDS.join(', ')}`);
  }
  const toolCallId = typeof args.toolCallId === 'string' ? args.toolCallId.trim() : '';
  if (args.toolCallId !== undefined && toolCallId === '') {
    return originalError('E_BAD_ARGUMENT', 'toolCallId must be a non-empty string when given');
  }
  if (toolCallId && kind === 'message') {
    return originalError('E_BAD_ARGUMENT', 'toolCallId selects a tool call/result; kind "message" cannot match it');
  }
  if (args.messageIndex !== undefined && (!Number.isInteger(args.messageIndex) || args.messageIndex < 0)) {
    return originalError('E_BAD_ARGUMENT', 'messageIndex must be an integer >= 0');
  }
  if (toolCallId && args.messageIndex !== undefined) {
    return originalError('E_BAD_ARGUMENT', 'pass either toolCallId or messageIndex, not both');
  }
  if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) {
    return originalError('E_BAD_ARGUMENT', 'offset must be an integer >= 0');
  }
  if (args.maxBytes !== undefined && (!Number.isInteger(args.maxBytes) || args.maxBytes < 1)) {
    return originalError('E_BAD_ARGUMENT', 'maxBytes must be an integer >= 1');
  }

  let resolved = null;
  try {
    resolved = resolveSessionPath(args, config);
  } catch (error) {
    return originalError('SESSION_READ_FAILED', `cannot resolve session: ${errorDetail(error)}`);
  }
  if (!resolved.ok) {
    const error = resolved.error ?? {
      code: resolved.code ?? 'SESSION_NOT_FOUND',
      message: resolved.message ?? 'session is unavailable',
    };
    return {
      ok: false,
      status: resolved.status ?? 'error',
      code: error.code,
      error,
      ...(resolved.path ? { path: resolved.path } : {}),
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      message: error.message,
    };
  }

  const sessionPath = resolved.sessionPath;
  const coordinates = originalSessionCoordinates(sessionPath, resolved.home);
  const context = {
    sessionPath,
    sessionId: coordinates.sessionId,
    scope: coordinates.scope,
    turn,
  };

  let parsed = null;
  try {
    parsed = parseSession(fs.readFileSync(sessionPath));
  } catch (error) {
    return originalError('SESSION_CORRUPT', `cannot parse session log: ${errorDetail(error)}`, context);
  }

  const turns = buildTurnItems(parsed.events);
  const turnNumbers = availableTurns(turns);
  if (!turns.has(turn)) {
    const recent = turnNumbers.slice(-ORIGINAL_TURN_LIMIT);
    const range = turnNumbers.length > 0
      ? `turn ${turn} is not in this log; available turns ${turnNumbers[0]}..${turnNumbers[turnNumbers.length - 1]}`
      : `turn ${turn} is not in this log; the log has no turns`;
    return originalError('TURN_NOT_FOUND', range, {
      ...context,
      availableTurns: recent,
      turnCount: turnNumbers.length,
    });
  }

  const items = turns.get(turn);
  const selection = selectTurnItems(items, {
    kind,
    toolCallId: toolCallId || null,
    messageIndex: args.messageIndex ?? null,
  });

  if (selection.error) {
    const extra = { ...context, itemCount: items.length };
    if (selection.error.code === 'MESSAGE_INDEX_OUT_OF_RANGE') {
      extra.messages = items
        .filter((item) => item.kind === 'message')
        .map((item) => ({ messageIndex: item.messageIndex, role: item.role, bytes: Buffer.byteLength(item.text, 'utf8') }));
    }
    if (selection.error.code === 'TOOL_CALL_NOT_FOUND') {
      extra.toolCalls = items
        .filter((item) => item.kind === 'tool' || item.kind === 'call')
        .slice(0, ORIGINAL_CALL_ID_LIMIT)
        .map((item) => ({ kind: item.kind, toolCallId: item.toolCallId, toolName: item.toolName }));
    }
    return originalError(selection.error.code, selection.error.message, extra);
  }

  const selected = selection.items;
  const archives = originalArchivePlan(selected, turn, config);
  const summaries = selected.map((item, index) => originalItemSummary(item, archives[index] ?? null));

  const base = {
    ...context,
    itemCount: items.length,
    selectedCount: selected.length,
    items: items.length,
    selected: summaries,
    archives,
  };

  if (selected.length === 0) {
    return {
      ok: true,
      status: 'empty',
      ...base,
      content: '',
      offset: 0,
      totalBytes: 0,
      returnedBytes: 0,
      truncated: false,
      nextOffset: null,
      privacy: { verdict: 'none', reasons: [], spans: 0, source: 'not-scanned' },
      message: `turn ${turn} has no ${kind === 'all' ? 'items' : kind} to fetch; ` +
        'try kind:"message" / "call" / "all" (and toolCallId / messageIndex when the turn has several)',
    };
  }

  const joined = joinTurnItems(selected);
  const privacy = privacyScan(joined);
  if (privacy.verdict !== 'none') {
    return {
      ok: false,
      status: 'blocked',
      code: 'PRIVACY_BLOCKED',
      error: {
        code: 'PRIVACY_BLOCKED',
        message: `original text hit the privacy gate (${privacy.reasons.join(', ') || privacy.verdict}); no content is returned`,
      },
      message: `blocked: privacy gate matched ${privacy.reasons.join(', ') || 'local-only content'} — ` +
        'the original text is not returned, and maxBytes/offset cannot bypass the gate',
      ...base,
      privacy: {
        verdict: privacy.verdict,
        reasons: privacy.reasons,
        spans: Array.isArray(privacy.spans) ? privacy.spans.length : 0,
        source: privacy.source,
      },
    };
  }

  const maxBytes = originalClampInteger(
    Number.isInteger(args.maxBytes) ? args.maxBytes : originalMaxBytes(config),
    ORIGINAL_MIN_MAX_BYTES,
    ORIGINAL_MAX_MAX_BYTES,
  );
  const slice = sliceUtf8(joined, Number.isInteger(args.offset) ? args.offset : 0, maxBytes);

  return {
    ok: true,
    status: 'ok',
    ...base,
    content: slice.content,
    offset: slice.offset,
    nextOffset: slice.nextOffset,
    totalBytes: slice.totalBytes,
    returnedBytes: slice.returnedBytes,
    truncated: slice.nextOffset != null,
    maxBytes,
    privacy: {
      verdict: privacy.verdict,
      reasons: privacy.reasons,
      spans: Array.isArray(privacy.spans) ? privacy.spans.length : 0,
      source: privacy.source,
    },
    message: `turn ${turn}: ${selected.length} item(s), ${slice.totalBytes} B total, ` +
      `${slice.returnedBytes} B returned from byte ${slice.offset}` +
      `${slice.nextOffset == null ? '' : `; continue with offset=${slice.nextOffset}`}` +
      `${archives.some((archive) => archive.exists) ? '; one or more D2 archives already exist' : ''}`,
  };
}

/**
 * D3: read one turn back out of a session log.
 *
 * This is the only tool that returns bytes that were deliberately compressed
 * away. It is read-only, keeps the selection out of the context unless asked
 * for, and refuses to return anything when the privacy gate matches the FULL
 * selection (scanning before slicing, so paging cannot smuggle a match).
 */
export function sessionOriginal(args, config) {
  try {
    return sessionOriginalImpl(args, config);
  } catch (error) {
    return originalError('SESSION_ORIGINAL_FAILED', `session_original failed: ${errorDetail(error)}`);
  }
}

export const TOOLS = [
  {
    name: 'session_health',
    description:
      'Inspect a DSH session log (session.v4.jsonl.zstd): size, event count, last event type, ' +
      'visible-message count and sha256, age, backups, last truncation. Read-only. ' +
      'Pass sessionPath, sessionId, or session:"latest"/"current".',
    parameters: { ...SESSION_ARGS },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => sessionHealth(args, config),
  },
  {
    name: 'session_original',
    description:
      'D3 "fetch the original": return the text of ONE turn from a session log, including tool ' +
      'output that was compressed out of the context. Read-only and privacy-gated: the FULL ' +
      'selection is scanned before slicing, so maxBytes/offset cannot page around a match. ' +
      'turn is required and 1-based (a user message belongs to its preceding turn/start). ' +
      'kind defaults to "tool" (tool results); use "message" for user/assistant text, "call" for ' +
      'tool arguments, or "all". Narrow a turn with toolCallId, or with messageIndex (0-based ' +
      'among the turn\'s user/assistant messages). The response is capped at maxBytes UTF-8 bytes ' +
      '(default 65536, config originalFetchMaxBytes): when truncated, content stops on a code-point ' +
      'boundary and nextOffset is the byte offset for the next call. Find a turn first with ' +
      'session_search or memory_recall. The result also reports the D2 archive path ' +
      '<memoryRoot>/.longlive/tool-output/<turn>/<id>.txt but NEVER writes it. ' +
      'Pass sessionPath, sessionId, or session:"latest"/"current".',
    parameters: {
      ...SESSION_ARGS,
      turn: {
        type: 'integer',
        description: 'Required. 1-based turn number (the value in turn/start events).',
      },
      kind: {
        type: 'string',
        enum: [...ORIGINAL_KINDS],
        description: 'Default "tool" (tool results). "message" = user/assistant text, "call" = tool arguments, "all" = every item in the turn.',
      },
      toolCallId: {
        type: 'string',
        description: 'Select one tool call/result by call id (the toolCallId on the result event).',
      },
      messageIndex: {
        type: 'integer',
        description: 'Select one message by its 0-based index among the turn\'s user/assistant messages.',
      },
      offset: {
        type: 'integer',
        description: 'Byte offset into the full selection for paging (default 0). Use nextOffset from a truncated response.',
      },
      maxBytes: {
        type: 'integer',
        description: 'Byte cap for this call (default config originalFetchMaxBytes = 65536; clamped to 1024..4194304).',
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: originalRender },
    invoke: (args, config) => sessionOriginal(args, config),
  },
  {
    name: 'session_backup',
    description:
      'Plan or create a byte-identical backup of a session log next to it ' +
      '(session.v4.jsonl.zstd.bak-YYYYMMDD, sha256 verified). dryRun=true writes nothing. ' +
      'Pass sessionPath, sessionId, or session:"latest"/"current".',
    parameters: {
      ...SESSION_ARGS,
      dryRun: { type: 'boolean', description: 'Default true: only report the planned backup.' },
      confirm: { type: 'string', description: 'Pass "BACKUP" to actually create the backup.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => sessionBackupPlan(args, config),
  },
  {
    name: 'session_truncate',
    description:
      'Safely drop the oldest events of a session log while keeping the visible conversation ' +
      'byte-identical (verified by a deriveMessages digest), with backup, tmp verify and rollback. ' +
      'dryRun=true writes nothing; writing requires confirm:"TRUNCATE". Refuses the session this app ' +
      'has loaded (VISIBLE_TARGET_IS_LIVE_SESSION; unknown caller id: VISIBLE_CURRENT_ID_UNKNOWN): ' +
      'stop the app first. ' +
      'Pass sessionPath, sessionId, or session:"latest"/"current".',
    parameters: {
      ...SESSION_ARGS,
      keepEvents: { type: 'integer', description: 'How many trailing events to keep (integer >= 1, default 20000).' },
      dryRun: { type: 'boolean', description: 'Default true: plan and verify without writing.' },
      confirm: { type: 'string', description: 'Pass "TRUNCATE" to actually rewrite the log.' },
      allowLive: { type: 'boolean', description: 'Diagnostics only. Bypass the live-session refusal; also requires confirm:"I-KNOW-THIS-CORRUPTS". Never use it on the session this app has loaded.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => truncateTool(args, config),
  },
  {
    name: 'session_truncate_visible',
    description:
      'Drop whole turns from the FRONT of the visible conversation so the model actually receives ' +
      'less context. The cut is always on a turn boundary; the first user-authored message survives ' +
      '(copied into the retained head when its turn is dropped); a protected system/message is kept; ' +
      'a synthetic user/message archive card records what was removed. The removed prefix is archived ' +
      'under <session>.archive/<ts>.jsonl.zstd; seq is renumbered 0..n-1; the write is tmp + fsync + ' +
      'atomic rename with read-back verification and an inflight rollback record. dryRun=true writes ' +
      'nothing; writing requires confirm:"TRUNCATE-VISIBLE". Refuses the session this app has loaded ' +
      '(VISIBLE_TARGET_IS_LIVE_SESSION; unknown caller id: VISIBLE_CURRENT_ID_UNKNOWN): truncate it only ' +
      'while the app is stopped. Defaults: keepTurns=12, keepTokens=80000 ' +
      '(the later boundary wins). When the first user message is dropped it is carried as a bounded ' +
      'prefix (firstUserCapChars, default 4000) that names the archive instead of copying megabytes; ' +
      'the post-cut token budget counts that card, the archive card and the protected head. An unstable ' +
      'boundary is retried by dropping one more turn (boundaryRetries, default 3); if no cut fits, the ' +
      'result is feasible=false with the attempted cuts, never a silent success. ' +
      'Pass sessionPath, sessionId, or session:"latest"/"current".',
    parameters: {
      ...SESSION_ARGS,
      keepTurns: { type: 'integer', description: 'Keep at least this many trailing turns (integer >= 1, default 12).' },
      keepTokens: { type: 'integer', description: 'Keep at least this many estimated trailing message tokens (integer >= 1, default 80000).' },
      firstUserCapChars: { type: 'integer', description: 'Cap the carried first user message at this many characters (integer >= 1, default 4000); the full text stays in the archive.' },
      boundaryRetries: { type: 'integer', description: 'When the cut boundary cannot be stabilized, retry with one more dropped turn this many times (integer >= 0, default 3).' },
      dryRun: { type: 'boolean', description: 'Default true: plan and report without writing.' },
      confirm: { type: 'string', description: 'Pass "TRUNCATE-VISIBLE" to actually rewrite the log.' },
      carryFirstUserMessage: { type: 'boolean', description: 'Copy the first user-authored message into the retained head when its turn is dropped (default true).' },
      insertArchiveCard: { type: 'boolean', description: 'Insert the synthetic [已归档 ...] user/message card (default true). Set false if the host rejects it.' },
      allowLive: { type: 'boolean', description: 'Diagnostics only. Bypass the live-session refusal; also requires confirm:"I-KNOW-THIS-CORRUPTS". Never use it on the session this app has loaded.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => truncateVisibleTool(args, config),
  },
  {
    name: 'session_compact',
    description:
      'Trigger one native harness compaction so the summary is written into the session log ' +
      '(compaction/summary + compact-checkpoint) instead of living in process memory. ' +
      'This is the only way to make a long session shorter without losing what it knows; ' +
      'run it BEFORE session_truncate, because truncation can only delete history a ' +
      'compaction already shadowed. dryRun=true only reports availability. When called ' +
      'inside a running turn the request is queued until the agent goes idle.',
    parameters: {
      dryRun: { type: 'boolean', description: 'Default true: only report whether compaction is available.' },
      sourceCommandId: { type: 'string', description: 'Optional command identity recorded on the compaction.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => compactTool(args, config),
  },
  {
    name: 'session_wake',
    description:
      'Read a bounded wake-up slice of the memory store (default <DSH home>/longlive-memory; ' +
      'override with plugin config memoryRoot / memRoot or $DSH_LONGLIVE_MEMORY_ROOT, legacy $DSH_MEM): ' +
      'the STATE.md sections 我在哪 / 在等什么 / 最近三件 (400 chars each), flow/current.md (800 chars max), ' +
      'the last three "##" headings of the newest journal/*.md (newest by year/month, not by string sort), and up to 20 INDEX.md lines shorter than 60 chars. ' +
      'Read-only. Missing files are skipped with a note instead of failing; an absent memory root reports ' +
      'unavailable. The text is capped at 2500 characters; truncated is true whenever a section or the whole text was cut.',
    parameters: {
      session: { type: 'string', description: 'Optional session label for the caller. It never selects or replaces memory content; newlines and "#" are stripped before it can appear in the text.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => sessionWake(args, config),
  },
  {
    name: 'lease_acquire',
    description:
      'Atomically take the memory-store write lease (<memoryRoot>/.lease, default ' +
      '<DSH home>/longlive-memory/.lease; override with memoryRoot / memRoot, $DSH_LONGLIVE_MEMORY_ROOT, or legacy $DSH_MEM). ' +
      'Concurrency-safe across processes (O_EXCL create): exactly one caller gets ok:true. An existing, ' +
      'unexpired lease returns ok:false with its holder and acquiredAt (reason "held by another writer"); ' +
      'an expired or unparseable lease is replaced, retried exactly once.',
    parameters: {
      holder: { type: 'string', description: 'Who wants the lease (a process/session name). Required.' },
      ttlSec: {
        type: 'integer',
        description: 'Lease lifetime in whole seconds (integer 1..86400, default 300). A day is the ceiling: a longer lease is a typo, not a plan.',
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => leaseAcquire(args, config),
  },
  {
    name: 'lease_release',
    description:
      'Release the memory-store write lease, but only for the holder recorded inside it. ' +
      'No file reports ok:false reason "no lease"; a different holder reports ok:false reason ' +
      '"not the holder" and the lease is left in place.',
    parameters: {
      holder: { type: 'string', description: 'Who is releasing; must match the recorded holder. Required.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => leaseRelease(args, config),
  },
  {
    name: 'worker_spawn',
    description:
      'Dispatch one background child session (worker) through the host subagents service and return ' +
      'immediately with its workerId. The child runs in its own context and reports back through the ' +
      'host; read its state with worker_status and stop it with worker_kill. ' +
      'Pass prompt (required: the task text), an optional label, and timeoutSec (default 600).',
    parameters: {
      prompt: { type: 'string', description: 'The task to hand to the child session. Required.' },
      label: { type: 'string', description: 'Optional short label for the child (defaults to the prompt head).' },
      timeoutSec: { type: 'integer', description: 'How long the dispatch itself may take, in whole seconds (integer >= 1, default 600).' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => workerSpawn(args, config),
  },
  {
    name: 'worker_status',
    description:
      'Report where a worker stands: live status from the Agent registry, else the parent child catalog, ' +
      'else its persisted session log (events count, last message time, status). ' +
      'Pass workerId (required), the id worker_spawn returned.',
    parameters: {
      workerId: { type: 'string', description: 'The worker id returned by worker_spawn. Required.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => workerStatus(args, config),
  },
  {
    name: 'worker_kill',
    description:
      'Stop one running worker through the host subagents service (interrupt, fire-and-return). ' +
      'A worker that is not running reports unavailable instead of a fake success. ' +
      'Pass workerId (required) and an optional reason.',
    parameters: {
      workerId: { type: 'string', description: 'The worker id returned by worker_spawn. Required.' },
      reason: { type: 'string', description: 'Optional short reason recorded in the report.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => workerKill(args, config),
  },
  {
    name: 'memory_index',
    description:
      'Rebuild the generated section of <memoryRoot>/INDEX.md from every card under topics/, journal/ and ' +
      'procedures/. Only the region between <!-- BEGIN GENERATED --> and <!-- END GENERATED --> is replaced; hand-written ' +
      'content outside is preserved byte-for-byte. Cards without frontmatter are legacy cards and still get a row. ' +
      'Procedures get their own 「程序性」 table (name / trigger / path / strength / version) so they are counted without ' +
      'appearing twice; a broken procedure card is listed as an invalid row instead of failing the run. ' +
      'Default is dry-run (returns the section and the resulting file, writes nothing); pass apply:true to write. ' +
      'Memory root: plugin config memoryRoot (alias memRoot), else $DSH_LONGLIVE_MEMORY_ROOT, ' +
      'else legacy $DSH_MEM, else <DSH home>/longlive-memory (created on demand).',
    parameters: {
      apply: { type: 'boolean', description: 'Default false (dry-run). true rewrites only the generated section, after backing INDEX.md up.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: memoryTool('memory_index', memoryIndex),
  },
  {
    name: 'memory_consolidate',
    description:
      'Read journal/*.md entries dated after the last consolidation (or an explicit since) and produce a ' +
      'proposal report: which paragraph belongs in which card, why, a 120-char excerpt, and a suggested salience. ' +
      'Journal paragraphs may carry `<!-- affect: N | reason -->` (N 1..5); the marker wins over the regex ' +
      'fallback, and malformed markers are listed under badAffect without failing the run. Every proposal gets a ' +
      'stable id (sha1(source paragraph text)[:12]); ids already in state.seenProposals are never proposed again. ' +
      'Report only — it never edits a card. It writes exactly one file under <memoryRoot>/.longlive/reports/ and ' +
      'records new proposal ids in memory-state.json; lastConsolidated advances only after every proposal for the ' +
      'newest scanned day is resolved (accepted/rejected/superseded). There is no apply flag by design.',
    parameters: {
      since: { type: 'string', description: 'Optional YYYY-MM-DD override for the incremental start; defaults to memory-state.json lastConsolidated.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: memoryTool('memory_consolidate', memoryConsolidate),
  },
  {
    name: 'memory_reinforce',
    description:
      'Record one real use of a card: strength = min(9, strength+1), last_used = today, revisions += 1, plus one ' +
      '<!-- rev: ... --> line with the reason. The prose body must stay byte-identical; the original is backed up ' +
      'to <memoryRoot>/.longlive/backups/ before writing, and any post-write mismatch rolls the card back. ' +
      'Pass path (required, relative to memoryRoot or absolute inside it).',
    parameters: {
      path: { type: 'string', description: 'The card to reinforce, relative to memoryRoot or an absolute path inside it. Required.' },
      reason: { type: 'string', description: 'Optional short reason stored in the rev comment (default "被真实使用").' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: memoryTool('memory_reinforce', memoryReinforce),
  },
  {
    name: 'memory_forget',
    description:
      'Propose forgetting by decay rules: last_used > 90 days and strength <= 2 demotes to epochs/, last_used > ' +
      '365 days tombstones. Cards with salience >= 5 are never proposed. Default is dry-run and writes nothing: it ' +
      'only reports proposals and whether epochs/, archive/tombstones/ and .longlive/backups exist. Execution ' +
      'requires confirm:"FORGET": it creates those paths, backs up each card into .longlive/backups/ first, rewrites ' +
      'tombstones.md atomically with a three-question epitaph per card (reason / affects / stillUseful) BEFORE moving ' +
      'the card to archive/tombstones/ (or epochs/), appends exactly one line to .longlive/audit.log, and never ' +
      'deletes a file.',
    parameters: {
      confirm: { type: 'string', description: 'Default absent = dry-run. Pass "FORGET" to execute the proposals.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: memoryTool('memory_forget', memoryForget),
  },
  {
    name: 'memory_procedure',
    description:
      'Procedural memory: how a task is done, not what happened. One card per procedure at ' +
      '<memoryRoot>/procedures/<slug>.md. Frontmatter is required: name / trigger / salience / ' +
      'strength / last_used (plus revisions). Body sections: 何时用 / 怎么做 (a numbered list) / ' +
      '失败模式 / 例子. action:"save" creates or merges by slug (same slug -> revisions+1, the old ' +
      'version is backed up under .longlive/backups/, and fields you omit keep their old value); a NEW ' +
      'card needs name plus when and at least one step. action:"list" filters by trigger keyword ' +
      '(space or comma separated, case-insensitive, OR over keywords); action:"get" returns one card ' +
      'including its raw text; action:"report" records one real use: success -> strength+1, failure -> ' +
      'strength-1 (clamped to 0..9), last_used = today, plus one <!-- rev: ... --> line. report leaves ' +
      'revisions alone: revisions counts content versions, strength counts how often it worked. A card ' +
      'whose frontmatter is broken or misses a required field is reported with E_PROCEDURE_INVALID and ' +
      'is never silently overwritten.',
    parameters: {
      action: {
        type: 'string',
        enum: [...PROCEDURE_ACTIONS],
        description: 'Required. save | list | get | report.',
      },
      name: { type: 'string', description: 'Card title (frontmatter name). save derives the slug from it when slug is absent; get/report accept it instead of slug.' },
      slug: { type: 'string', description: `File stem under ${PROCEDURES_DIR}/. save/get/report may pass it explicitly (no path separators, no ..).` },
      trigger: { type: 'array', items: { type: 'string' }, description: 'When this procedure applies (frontmatter trigger). save replaces the whole list; list uses the keywords as an OR filter.' },
      salience: { type: 'integer', description: 'Importance 1..5 (default 3 on a new card, kept on merge unless given).' },
      strength: { type: 'integer', description: 'How often it worked 0..9 (default 3 on a new card; report changes it, save sets it explicitly).' },
      when: { type: 'string', description: 'Body section 「何时用」: the situation that calls for this procedure. Required for a new card.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Body section 「怎么做」: ordered steps, written as a numbered list. Required (at least one) for a new card. A single string with newlines is accepted too.' },
      failureModes: { type: 'string', description: 'Optional body section 「失败模式」: how this procedure goes wrong.' },
      example: { type: 'string', description: 'Optional body section 「例子」: one concrete run.' },
      outcome: { type: 'string', enum: ['success', 'failure'], description: 'report only, required: success raises strength by 1, failure lowers it by 1.' },
      reason: { type: 'string', description: 'report only: short reason stored in the rev comment.' },
      limit: { type: 'integer', description: 'list only: page size (default 50, max 500). total/count/truncated are always reported.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: memoryTool('memory_procedure', memoryProcedure),
  },
  {
    name: 'memory_recall',
    description:
      'Search memory cards by meaning-ish keywords and get the best few back. Mixed, reproducible score: title ' +
      'hits *5 + tags *3 + body frequency (capped 3) + whole-query phrase bonus + character-bigram Dice similarity. ' +
      'Returns {path, title, score, excerpt} sorted by score desc then path asc; the same tree and query always ' +
      'produce byte-identical results. Defaults: topK 3 (1..20), room any, status active+locked — already-locked ' +
      'cards are searchable. Pass status:"archived" or "any" to widen, room:"topics" to narrow. READ-ONLY: it never ' +
      'writes a card, never builds INDEX.md and never creates .longlive/. An empty query throws ' +
      'E_RECALL_EMPTY_QUERY; no hit is not an error — it returns an empty results list with code ' +
      'E_RECALL_NO_MATCH and a hint.',
    parameters: {
      query: { type: 'string', description: 'Required. Natural language or keywords, e.g. "听觉 训练".' },
      topK: { type: 'integer', description: 'How many cards to return (default 3, clamped to 1..20).' },
      room: { type: 'string', description: 'Optional relative directory filter: topics, journal, or a subdirectory of either.' },
      status: { type: 'string', enum: ['active', 'locked', 'archived', 'any'], description: 'Card status filter. Default active+locked; "any" includes archived.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: memoryTool('memory_recall', memoryRecall),
  },
  {
    name: 'session_live_update',
    description:
      'Write or patch this session\'s row in the live registry (<memoryRoot>/.longlive/live/<sessionId>.json). ' +
      'state is required: idle | running | waiting | blocked | stale. Omitted optional fields keep their previous ' +
      'value, except blocked_on, which is cleared whenever state is not "blocked". pid and host are always the ' +
      'calling process and machine; startedAt is preserved. goal is cut to 80 characters, queued to 200 items of ' +
      '300 characters each, and last_action.detail to 500 characters; the result reports every cut ' +
      '(goalTruncated / queuedTruncated / lastActionDetailTruncated). The file is written tmp -> rename with a ' +
      'read-back, so a crash never leaves half a JSON. If a directory or symlink occupies the row path, the write ' +
      'is refused up front with E_LIVE_ROW_BLOCKED instead of failing late in rename. Pass sessionId only to write ' +
      'another session\'s row; by default the host\'s current session is used.',
    parameters: {
      sessionId: { type: 'string', description: 'Optional session id; defaults to the host\'s current session id.' },
      state: {
        type: 'string',
        enum: ['idle', 'running', 'waiting', 'blocked', 'stale'],
        description: 'Required writer-declared state. dead/corrupt are computed by readers and cannot be written.',
      },
      turn: { type: 'integer', description: 'Current turn number (integer >= 0, default keeps the previous value or 0).' },
      goal: { type: 'string', description: 'What this session is doing; stored at most 80 characters (longer input is truncated and flagged).' },
      blocked_on: { type: 'string', description: 'What the session is waiting on. Only kept while state is "blocked".' },
      queued: { type: 'array', items: { type: 'string' }, description: 'Queued work items (strings); replaces the previous queue.' },
      ttlMs: {
        type: 'integer',
        description: 'Heartbeat lifetime in ms (integer 1000..86400000, default 60000). Older than 2x this is stale.',
      },
      last_action: {
        type: 'object',
        additionalProperties: false,
        properties: {
          at: { type: 'string', description: 'ISO timestamp; defaults to now.' },
          kind: { type: 'string', description: 'Short action kind, e.g. "edit" or "tool".' },
          detail: { type: 'string', description: 'Short human-readable detail.' },
        },
        description: 'Last action {at, kind, detail}; defaults to now/create or now/update.',
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => liveUpdate(args, config),
  },
  {
    name: 'session_live_list',
    description:
      'List the live registry (<memoryRoot>/.longlive/live) with a computed effectiveState for every row. ' +
      'Liveness is heartbeat-first: a heartbeat within one ttlMs is running regardless of pid (pid is the ' +
      'writer\'s, not the session\'s); older than 2x ttlMs is stale; older than 4x ttlMs, or same-host with a pid ' +
      'that definitively no longer exists, is dead; a file that cannot be parsed or has the wrong shape is corrupt ' +
      '(listed, never thrown). Other hosts\' pids are never probed, so remote rows age purely by heartbeat and can ' +
      'be stale or dead but are never treated as dead by pid. dead rows are hidden unless includeDead:true; the ' +
      'result always reports hiddenDead and per-state counts. Orphan tmp files are ignored by the list.',
    parameters: {
      includeDead: { type: 'boolean', description: 'Default false: hide rows whose same-host pid no longer exists.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => liveList(args, config),
  },
  {
    name: 'session_live_get',
    description:
      'Read one row of the live registry by sessionId, with the same computed effectiveState as session_live_list ' +
      '(dead / stale / corrupt included). sessionId must already be canonical (lowercase): a case or whitespace ' +
      'alias throws E_SESSION_ID_NOT_CANONICAL with the canonical id in error.canonical, because NTFS maps aliases ' +
      'to one file and a silent lookup cannot say which session was read. A symlinked row is refused rather than ' +
      'followed. A missing row returns ok:false status:"absent" instead of failing; a row that cannot be parsed ' +
      'throws E_LIVE_CORRUPT.',
    parameters: {
      sessionId: { type: 'string', description: 'Session id whose row to read. Required.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => liveGet(args, config),
  },
  {
    name: 'session_live_prune',
    description:
      'Clean the live registry. Row candidates are dead rows from this host (heartbeat older than 4x ttlMs, or ' +
      'same-host pid definitively gone), or corrupt rows without another host\'s stamp. Before unlinking, each ' +
      'candidate is re-read and re-judged: it is deleted only if it is STILL dead/corrupt AND its bytes did not ' +
      'change; otherwise it is returned under skipped. A row carrying blocked_on is never auto-deleted (skipped), ' +
      'and every deleted/skipped row keeps blocked_on, queued and startedAt in the result. Remote rows are never ' +
      'deleted: a merely dead remote row is left alone, and a corrupt row whose bytes still name a remote host is ' +
      'skipped too (host unknown is the only corrupt case prune may remove). Also reports (and with confirm ' +
      'removes) orphan *.tmp-* files older than one hour and empty directory placeholders; non-empty directories ' +
      'and symlinks are reported only. Default is dry-run (candidates, wouldDelete, skipped; deletes nothing); a ' +
      'real delete requires confirm:"PRUNE". dryRun:false without the confirm word throws E_CONFIRM_REQUIRED.',
    parameters: {
      dryRun: { type: 'boolean', description: 'Default true (preview only). false with confirm:"PRUNE" really deletes.' },
      confirm: { type: 'string', description: 'Pass "PRUNE" to actually delete the previewed candidates.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => OUTPUT_TEXT(value) },
    invoke: (args, config) => livePrune(args, config),
  },
];

/**
 * Register the tools on a Cordis context. `@deepseek-ai/dsh-tools` is imported
 * lazily so plain-node tests can exercise `TOOLS` without the host present.
 */
export async function registerTools(ctx, config = {}) {
  // `@deepseek-ai/dsh-tools` is imported lazily so plain-node tests can exercise
  // `TOOLS` without the host present; `config.defineTool` is the same seam for a
  // suite that wants to drive the real registration path (test/router-runtime).
  const defineTool =
    typeof config.defineTool === 'function'
      ? config.defineTool
      : (await import('@deepseek-ai/dsh-tools')).defineTool;
  // `host` keeps the live Cordis context reachable from a tool body: compaction
  // is a host service (ctx.compaction) acting on the host agent (ctx.agent), and
  // neither can be reconstructed from arguments.
  const bound = { ...config, host: () => ctx };
  // Fan-out tools are opt-in from 1.6.0 on; `undefined` means the safe default.
  const workersEnabled = bound.workers?.enabled === true;
  // R1 runtime adapter. Absent (or `routerRuntime: 'off'`, which creates no
  // adapter) means the execute closure below is byte-identical to before.
  const routerRuntime = bound.routerRuntime && typeof bound.routerRuntime.intercept === 'function' ? bound.routerRuntime : null;
  // RouterService tools exist only when the service is enabled and was passed in
  // by apply(). With routerEnabled=false this array is empty, so registration is
  // byte-for-byte the 0.9.0 path (22 tools, no extra hooks).
  // RouterService tools exist only when the service is enabled and apply()
  // injected them. With routerEnabled=false this array is empty, so registration
  // is byte-for-byte the 0.9.0 path (22 tools, no extra hooks).
  const routerTools = Array.isArray(bound.routerTools) ? bound.routerTools : [];
  // D6 (default off): the fallback tool_search is registered only when the
  // feature is enabled; appending it after the normal set keeps the baseline
  // order byte-identical when D6 is off.
  const d6Tools = Array.isArray(bound.d6Tools) ? bound.d6Tools : [];
  const allTools = routerTools.length > 0 || d6Tools.length > 0
    ? [...TOOLS, ...routerTools, ...d6Tools]
    : TOOLS;
  const ownNames = new Set(allTools.map((tool) => tool.name));
  for (const tool of allTools) {
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: tool.output,
      // `exec` carries the exact live calling Agent (exec.agent) and its signal
      // (exec.signal); the worker tools need both to authorize a child.
      execute: (args, exec) => {
        // 1.6.0 safety gate: no child session can be spawned, listed or killed
        // until the profile opts in. This is the only path the Host uses.
        if (!workersEnabled && WORKER_TOOL_NAMES.includes(tool.name)) {
          return workerUnavailable(WORKERS_DISABLED_MESSAGE);
        }
        // Auto-heartbeat: every longlive call is also a liveness signal for the
        // caller's own row (never for an explicit `sessionId` argument). This is
        // best effort and must never change what the tool itself returns.
        try {
          bound.autoHeartbeat?.autoTouch?.(exec, tool.name);
        } catch {
          /* heartbeat is decoration; the tool call wins */
        }
        const invoke = () => tool.invoke(args, { ...bound, exec });
        // Shadow records and returns the tool's own value; on may refuse a
        // high-risk write before invoke ever runs. Without an adapter this is a
        // direct call, so the synchronous contract of every tool is preserved.
        return routerRuntime ? routerRuntime.intercept(tool.name, args, invoke) : invoke();
      },
    }));
  }
  // `memory_save` belongs to the engram side, not to this plugin, so wrapping
  // cannot see it. The host's pre-execute guard is the only non-invasive hook
  // that can: in shadow it returns undefined (allow) and only records; in `on`
  // it may return a denial reason for a high-risk write. `ownNames` keeps the
  // guard away from tools already wrapped above (no double records).
  if (routerRuntime && routerRuntime.enabled) {
    if (typeof ctx.tools.guard === 'function') {
      try {
        ctx.tools.guard((execution) =>
          ownNames.has(execution.name) ? undefined : routerRuntime.guard(execution.name, execution.arguments),
        );
      } catch (error) {
        try {
          console.warn?.(`[longlive] router guard unavailable, shadow records only wrapped tools: ${error && error.message}`);
        } catch {
          /* a missing warning must not fail registration */
        }
      }
    } else {
      try {
        console.warn?.(`[longlive] host tools.guard() absent; routerRuntime=${routerRuntime.mode} covers wrapped tools only`);
      } catch {
        /* ignore */
      }
    }
  }
  return allTools.length;
}
