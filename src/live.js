// Live session registry — the "正在" table (0.5.0).
//
// One JSON file per session under `<memoryRoot>/.longlive/live/<sessionId>.json`.
// The location is deliberate: topics/ and journal/ are scanned by memory_index,
// and the store root belongs to hand-written cards, so a registry row must not
// land in either. `.longlive/` already owns plugin state (memory-state.json,
// backups/, reports/), and `live/` is hidden from every memory_* tool.
//
// The file is a snapshot, not a log. A writer declares one of five states
// (idle | running | waiting | blocked | stale); a reader computes what is
// actually true. Liveness is heartbeat-first:
//   running  the heartbeat is within one ttl, whatever the recorded pid says.
//            record.pid is the *writer's* pid, not the session's, so it can
//            never overturn a fresh heartbeat.
//   stale    the heartbeat is older than 2 x ttlMs (strictly older)
//   dead     the heartbeat is older than 4 x ttlMs, or the row is from this
//            host and its pid is definitively gone. pid evidence only
//            accelerates death; it never decides it on its own.
//   corrupt  the file cannot be read, parsed, or no longer has the shape
// A fresh heartbeat therefore always wins, including when another process wrote
// the row and that writer has already exited.
//
// Writes are atomic: a unique tmp file in the same directory, a read-back of
// the tmp, then rename over the target. A writer that dies half-way leaves the
// old complete file (or no file) and at worst an orphan tmp that listing
// ignores. Concurrent writers each rename their own complete file, so the last
// rename wins and the target is never a mixture of two payloads.
//
// Prune is dry-run by default and requires confirm:"PRUNE". Before deleting it
// re-reads the row and deletes only a row that is still dead/corrupt AND whose
// bytes did not change since it became a candidate. A row carrying blocked_on
// is never deleted automatically; it is reported under `skipped` instead.
// Corrupt rows carry no trustworthy host, so they are the one cross-host case
// prune may remove. Remote rows that are merely dead are left alone. The same
// run reports (and, with confirm, removes) orphan *.tmp-* files older than an
// hour and empty directory placeholders that block a session id.
//
// All registry paths are checked after realpath(): the live directory and every
// row must resolve inside <memoryRoot>, so a junction or symlink cannot redirect
// a write outside it. liveGet refuses a symlinked row outright.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  memoryError, memoryRootFromConfig, resolveInside, relativePath,
  realPathProbe, isInsideRoot,
} from './memory/paths.js';

export const LIVE_SCHEMA_VERSION = 1;
export const LIVE_DIR = path.join('.longlive', 'live');
export const LIVE_TOMBSTONE_FILE = 'tombstones.jsonl';
export const LIVE_CONFIRM = 'PRUNE';
export const LIVE_SWEEP_CONFIRM = 'SWEEP';
export const GOAL_MAX_CHARS = 80;
export const DEFAULT_TTL_MS = 60_000;
export const MIN_TTL_MS = 1_000;
export const MAX_TTL_MS = 86_400_000;
// Bounded queue/detail payloads: a registry row is a glance, not a backlog dump.
export const MAX_QUEUED_ITEMS = 200;
export const MAX_QUEUED_ITEM_CHARS = 300;
export const LAST_ACTION_DETAIL_MAX_CHARS = 500;
// Orphaned tmp files younger than this may still belong to a live writer.
export const TMP_MAX_AGE_MS = 60 * 60 * 1000;

/** States a writer may declare. `stale` is legal here and also computed on read. */
export const DECLARED_STATES = Object.freeze(['idle', 'running', 'waiting', 'blocked', 'stale']);
/** States only a reader can decide; a writer must never store them. */
export const COMPUTED_STATES = Object.freeze(['dead', 'corrupt']);
export const EFFECTIVE_STATES = Object.freeze([...DECLARED_STATES, ...COMPUTED_STATES]);

/** The exact keys of a stored row, in order. Nothing else is written. */
export const LIVE_RECORD_FIELDS = Object.freeze([
  'schemaVersion',
  'sessionId',
  'pid',
  'host',
  'startedAt',
  'updatedAt',
  'heartbeatAt',
  'ttlMs',
  'state',
  'turn',
  'goal',
  // R3: the clock of the *goal*, not of the row. A heartbeat touch must never
  // move it (see liveTouch), and the board renders focus.updatedAt from it.
  'goalUpdatedAt',
  'blocked_on',
  'queued',
  'last_action',
]);

export const LIVE_CODES = Object.freeze({
  BAD_ARGUMENT: 'E_BAD_ARGUMENT',
  ROOT_UNSET: 'E_MEMORY_ROOT_UNSET',
  PATH_OUTSIDE_ROOT: 'E_PATH_OUTSIDE_ROOT',
  CORRUPT: 'E_LIVE_CORRUPT',
  CONFIRM_REQUIRED: 'E_CONFIRM_REQUIRED',
  WRITE: 'E_LIVE_WRITE',
  // Reading through a case alias is ambiguous on NTFS: one file, several
  // spellings. Writers normalise; readers must name the canonical id.
  NOT_CANONICAL: 'E_SESSION_ID_NOT_CANONICAL',
  // Something that is not a regular file occupies the row path (directory,
  // device, FIFO). Writing would fail or replace the wrong object.
  DIR_PLACEHOLDER: 'E_LIVE_ROW_BLOCKED',
});

// A session id becomes a file name, so it is constrained, not sanitised: a
// value that looks like a path is refused rather than rewritten into something
// the caller did not ask for.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function bad(message) {
  return memoryError(LIVE_CODES.BAD_ARGUMENT, message);
}

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

/** Tool-entry gate: args and config must be explicit plain objects. */
function assertEntry(name, args, config) {
  if (!isPlainObject(args)) {
    throw bad(`${name} 的 args 必须是普通对象，收到 ${argumentType(args)}`);
  }
  if (!isPlainObject(config)) {
    throw bad(`${name} 的 config 必须是普通对象，收到 ${argumentType(config)}`);
  }
}

function currentHostname() {
  const name = os.hostname();
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'unknown-host';
}

/** Host stamps are case-insensitive, like the OS names they came from. */
function hostsMatch(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && a.trim() !== '' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function nowMs(config = {}) {
  const raw = config?.now;
  if (raw instanceof Date) {
    const ms = raw.getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return Date.now();
}

function isoTime(ms) {
  return new Date(ms).toISOString();
}

function parseTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when `pid` is an existing process. Signal 0 only probes; it never
 * terminates anything. EPERM means the process exists but belongs to another
 * user, which still counts as alive.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Validate and normalise a session id before it can become a file name. */
export function normalizeSessionId(value, label = 'sessionId') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw bad(`${label} 必须是非空字符串，收到 ${value === undefined ? 'undefined' : JSON.stringify(value)}`);
  }
  const id = value.trim();
  if (id.includes('\0')) throw bad(`${label} 不能包含 NUL 字符`);
  if (path.isAbsolute(id) || /[\\/]/.test(id) || id === '..' || id.split(/[\\/]+/).includes('..')) {
    throw memoryError(
      LIVE_CODES.PATH_OUTSIDE_ROOT,
      `拒绝越界 ${label}：${JSON.stringify(id)} — 只允许写在 <memoryRoot>/.longlive/live 里`,
    );
  }
  if (!SESSION_ID_RE.test(id)) {
    throw bad(`${label} 只允许字母、数字与 . _ -（1..128 位，首字符是字母或数字），收到 ${JSON.stringify(id)}`);
  }
  // NTFS is case-insensitive, so `S-A` and `s-a` are one file. Canonicalise to
  // lowercase before the id ever becomes a name: one session, one row, no
  // duplicate-looking aliases that decode as "corrupt".
  return id.toLowerCase();
}

/**
 * Lexical resolveInside already refuses `..`, but a junction or symlink can
 * still point the live directory outside the root. Every registry path is
 * therefore resolved again through the shared memory-layer probe and compared
 * against the real root.
 */
function assertRealInside(root, target, label) {
  let realRoot;
  try {
    // Use the same native realpath probe as the memory layer: the JS fallback
    // can hand back an 8.3 short name (ADMINI~1) while the target probe returns
    // the long form, which would look like an escape on Windows.
    realRoot = realPathProbe(root);
  } catch (error) {
    throw memoryError(
      LIVE_CODES.ROOT_UNSET,
      `无法解析 memoryRoot 的真实路径：${root}（${error?.code ?? error?.message}）`,
      error,
    );
  }
  let realTarget;
  try {
    realTarget = realPathProbe(target);
  } catch (error) {
    throw memoryError(
      LIVE_CODES.PATH_OUTSIDE_ROOT,
      `无法校验 ${label} 的真实路径：${target}（${error?.code ?? error?.message}）`,
      error,
    );
  }
  if (!isInsideRoot(realRoot, realTarget)) {
    throw memoryError(
      LIVE_CODES.PATH_OUTSIDE_ROOT,
      `拒绝越界 ${label}：${target} 的真实路径 ${realTarget} 不在 ${realRoot} 之内`,
    );
  }
  return realTarget;
}

/** `<memoryRoot>/.longlive/live` (no mkdir; lexical + realpath guarded). */
export function liveDir(root) {
  const dir = resolveInside(root, LIVE_DIR);
  assertRealInside(root, dir, '活体目录');
  return dir;
}

/** Absolute path of one session's row; id and realpath are validated first. */
export function liveFile(root, sessionId) {
  const id = normalizeSessionId(sessionId);
  const file = resolveInside(root, path.join(LIVE_DIR, `${id}.json`));
  assertRealInside(root, file, '活体记录');
  return file;
}

/** Append-only tombstone/audit ledger for removed or swept L1 rows. */
export function liveTombstoneFile(root) {
  return resolveInside(root, path.join(LIVE_DIR, LIVE_TOMBSTONE_FILE));
}

function appendLiveTombstones(root, rows, now) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const file = liveTombstoneFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = isoTime(typeof now === 'number' ? now : Date.now());
  const written = [];
  const lines = rows.map((row) => {
    const entry = {
      schema: 'live-tombstone/v1',
      at,
      sessionId: row.sessionId ?? null,
      effectiveState: row.effectiveState ?? null,
      reason: row.reason ?? 'dead-row-cleanup',
      heartbeatAt: row.heartbeatAt ?? null,
      ttlMs: row.ttlMs ?? null,
      heartbeatAgeMs: row.heartbeatAgeMs ?? null,
      host: row.host ?? null,
      sha256: row.sha256 ?? null,
      fileRel: row.fileRel ?? null,
      row: row.row ?? null,
    };
    written.push(entry);
    return JSON.stringify(entry);
  });
  fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return written;
}

/** Read-only health snapshot: stale/dead counts + tombstone backlog. */
export function liveHealth(rootOrConfig, config = {}) {
  const root = typeof rootOrConfig === 'string' ? rootOrConfig : memoryRootFromConfig(rootOrConfig ?? config);
  const now = typeof rootOrConfig === 'string' ? nowMs(config) : nowMs(rootOrConfig ?? config);
  const listed = liveList({ includeDead: true }, { memoryRoot: root, now });
  const entries = Array.isArray(listed.entries) ? listed.entries : [];
  const stale = entries.filter((entry) => entry.effectiveState === 'stale');
  const dead = entries.filter((entry) => entry.effectiveState === 'dead');
  let tombstones = 0;
  try {
    const text = fs.readFileSync(liveTombstoneFile(root), 'utf8');
    tombstones = text.split('\n').filter((line) => line.trim() !== '').length;
  } catch { /* no ledger yet */ }
  return {
    ok: true,
    root,
    dir: listed.dir,
    total: entries.length,
    active: entries.filter((entry) => ['idle', 'running', 'waiting', 'blocked'].includes(entry.effectiveState)).length,
    stale: stale.length,
    dead: dead.length,
    corrupt: entries.filter((entry) => entry.effectiveState === 'corrupt').length,
    tombstoned: tombstones,
    staleIds: stale.map((entry) => entry.sessionId),
    deadIds: dead.map((entry) => entry.sessionId),
  };
}

/**
 * Startup-safe sweep: mark stale in the health view and move dead same-host
 * rows to the append-only tombstone ledger before unlinking them. Remote rows
 * are never swept; dry-run is the default.
 */
export function liveSweep(args = {}, config = {}) {
  const root = memoryRootFromConfig(config);
  const now = nowMs(config);
  const real = args.confirm === LIVE_SWEEP_CONFIRM || args.autoCleanup === true;
  const health = liveHealth(root, { now });
  const listed = liveList({ includeDead: true }, { memoryRoot: root, now });
  const entries = Array.isArray(listed.entries) ? listed.entries : [];
  const candidates = entries.filter((entry) => entry.effectiveState === 'dead' && entry.sameHost === true && entry.file);
  const removed = [];
  const tombstoned = [];
  if (real) {
    for (const entry of candidates) {
      let text = '';
      let sha = null;
      try {
        const bytes = fs.readFileSync(entry.file);
        text = bytes.toString('utf8');
        sha = crypto.createHash('sha256').update(bytes).digest('hex');
      } catch { continue; }
      const row = { ...entry, sha256: sha };
      try { tombstoned.push(...appendLiveTombstones(root, [row], now)); } catch { continue; }
      try {
        fs.unlinkSync(entry.file);
        removed.push(entry.sessionId);
      } catch { /* tombstone is already durable; report as not removed */ }
    }
  }
  return {
    ok: true,
    status: real ? 'swept' : 'dry-run',
    dryRun: !real,
    confirmRequired: LIVE_SWEEP_CONFIRM,
    ...health,
    candidates: candidates.map((entry) => entry.sessionId),
    removed,
    tombstoned: tombstoned.length,
  };
}

// --------------------------------------------------------------------- write

let tmpSeq = 0;

function tmpPathFor(file) {
  tmpSeq += 1;
  return `${file}.tmp-${process.pid}-${tmpSeq}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Synchronous sleep for the Windows rename retry only. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no Atomics on this runtime: retry immediately */
  }
}

// On Windows a rename over a target another process has open can fail with
// EPERM/EBUSY for a moment. Retrying a few times is a real fix, not a mask:
// the rename itself is still all-or-nothing.
function renameWithRetry(from, to) {
  const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!retryable.has(error?.code) || attempt >= 4) throw error;
      sleepSync(5 * (attempt + 1));
    }
  }
}

function writeFailure(file, error) {
  if (error?.code === LIVE_CODES.WRITE) return error;
  return memoryError(
    LIVE_CODES.WRITE,
    `写入活体记录失败：${file}（${error?.code ?? error?.message ?? 'unknown'}）`,
    error,
  );
}

/**
 * Write `text` to `file` atomically: tmp + tmp read-back + rename + read-back.
 * If the read-back after the rename shows a complete JSON object that is not
 * ours, another writer won the race and that is the contract (last complete
 * file wins), so the write is reported as superseded instead of rolled back.
 * Anything else (including a half-written tmp) restores the previous bytes and
 * throws E_LIVE_WRITE.
 */
function writeLiveText(file, text) {
  let prior = null;
  try {
    prior = fs.readFileSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') prior = null;
  }
  const tmp = tmpPathFor(file);
  let renamed = false;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    const staged = fs.readFileSync(tmp, 'utf8');
    if (staged !== text) {
      throw memoryError(LIVE_CODES.WRITE, `临时文件内容不完整：${tmp}`);
    }
    renameWithRetry(tmp, file);
    renamed = true;
    const readBack = fs.readFileSync(file, 'utf8');
    if (readBack !== text) {
      let completeForeign = false;
      try {
        const other = JSON.parse(readBack.replace(/^\uFEFF/, ''));
        completeForeign = isPlainObject(other) && typeof other.sessionId === 'string';
      } catch {
        completeForeign = false;
      }
      if (!completeForeign) {
        throw memoryError(LIVE_CODES.WRITE, `写入后读回的不是完整 JSON：${file}`);
      }
      return { sha256: sha256Text(text), bytes: Buffer.byteLength(text, 'utf8'), superseded: true };
    }
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best effort: the error that matters is the one being rethrown */
    }
    if (renamed) {
      try {
        if (prior != null) fs.writeFileSync(file, prior);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        /* best effort: never mask the write error */
      }
    }
    throw writeFailure(file, error);
  }
  return {
    sha256: sha256Text(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    superseded: false,
  };
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------- read

/**
 * Parse one row. Returns `{ok:true, record}` with exactly LIVE_RECORD_FIELDS,
 * or `{ok:false, reason}` for anything that cannot be trusted. This never
 * throws: corrupt rows are data for the reader, not an exception.
 */
function decodeRecord(text, expectedSessionId) {
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, reason: `JSON 解析失败：${error.message}` };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: '顶层不是 JSON 对象' };
  // Case-insensitive on purpose: NTFS maps S-A.json and s-a.json to one file,
  // and rows written before the lowercase canonicalisation may still carry the
  // mixed-case id. They are the same session, not a corrupt row.
  if (typeof raw.sessionId !== 'string'
    || raw.sessionId.trim().toLowerCase() !== expectedSessionId.toLowerCase()) {
    return {
      ok: false,
      reason: `sessionId 缺失或与文件名不一致：文件名 ${expectedSessionId}，记录 ${JSON.stringify(raw.sessionId)}`,
    };
  }
  if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
    return { ok: false, reason: `schemaVersion 无效：${JSON.stringify(raw.schemaVersion)}` };
  }
  if (typeof raw.state !== 'string' || !DECLARED_STATES.includes(raw.state)) {
    return { ok: false, reason: `state 无效：${JSON.stringify(raw.state)}` };
  }
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) {
    return { ok: false, reason: `pid 无效：${JSON.stringify(raw.pid)}` };
  }
  if (typeof raw.host !== 'string' || raw.host.trim() === '') {
    return { ok: false, reason: 'host 缺失或不是字符串' };
  }
  if (!Number.isInteger(raw.ttlMs) || raw.ttlMs <= 0) {
    return { ok: false, reason: `ttlMs 无效：${JSON.stringify(raw.ttlMs)}` };
  }
  const heartbeatMs = parseTime(raw.heartbeatAt) ?? parseTime(raw.updatedAt);
  if (heartbeatMs == null) {
    return { ok: false, reason: 'heartbeatAt/updatedAt 不是可解析的时间' };
  }
  const updatedMs = parseTime(raw.updatedAt) ?? heartbeatMs;
  const startedMs = parseTime(raw.startedAt) ?? heartbeatMs;
  // R3 additive field: rows written before this version simply have no goal
  // clock; keep it as '' (unknown) instead of inventing one from heartbeatAt.
  const goalUpdatedMs = parseTime(raw.goalUpdatedAt);
  if (!Array.isArray(raw.queued) || !raw.queued.every((item) => typeof item === 'string')) {
    return { ok: false, reason: 'queued 必须是字符串数组' };
  }
  return {
    ok: true,
    record: {
      schemaVersion: raw.schemaVersion,
      sessionId: raw.sessionId,
      pid: raw.pid,
      host: raw.host,
      startedAt: isoTime(startedMs),
      updatedAt: isoTime(updatedMs),
      heartbeatAt: isoTime(heartbeatMs),
      ttlMs: raw.ttlMs,
      state: raw.state,
      turn: Number.isInteger(raw.turn) && raw.turn >= 0 ? raw.turn : 0,
      goal: typeof raw.goal === 'string' ? raw.goal : '',
      goalUpdatedAt: goalUpdatedMs != null ? isoTime(goalUpdatedMs) : '',
      blocked_on: typeof raw.blocked_on === 'string' ? raw.blocked_on : '',
      queued: [...raw.queued],
      last_action: normalizeLastAction(raw.last_action, updatedMs),
    },
  };
}

function normalizeLastAction(value, fallbackMs) {
  if (!isPlainObject(value)) return null;
  return {
    at: parseTime(value.at) != null ? value.at : isoTime(fallbackMs),
    kind: typeof value.kind === 'string' ? value.kind : '',
    detail: typeof value.detail === 'string' ? value.detail : '',
  };
}

/** Reader-side truth for one valid row. Never mutates the file. */
function liveEntry(record, { file, root, now, hostname }) {
  const heartbeatMs = parseTime(record.heartbeatAt);
  const sameHost = record.host.trim().toLowerCase() === hostname.trim().toLowerCase();
  // Only a local pid can be probed. A remote row ages by heartbeat alone.
  const alive = sameHost ? pidAlive(record.pid) : null;
  const age = now - heartbeatMs;
  const fresh = age <= record.ttlMs;
  let effectiveState;
  if (fresh) {
    // Heartbeat-first: a row refreshed within one ttl is alive. The pid is the
    // writer's, not the session's, so a dead pid must not overturn this.
    effectiveState = 'running';
  } else if (age > 4 * record.ttlMs) {
    // The writer has been silent for four lifetimes: no pid evidence needed.
    effectiveState = 'dead';
  } else if (alive === false) {
    // A local pid that is definitively gone only accelerates death; it never
    // decides it while the heartbeat is still fresh (handled above).
    effectiveState = 'dead';
  } else if (age > 2 * record.ttlMs) {
    effectiveState = 'stale';
  } else {
    effectiveState = record.state;
  }
  return {
    sessionId: record.sessionId,
    file,
    fileRel: relativePath(root, file),
    effectiveState,
    state: record.state,
    pid: record.pid,
    host: record.host,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    heartbeatAt: record.heartbeatAt,
    ttlMs: record.ttlMs,
    heartbeatAgeMs: age,
    sameHost,
    pidAlive: alive,
    turn: record.turn,
    goal: record.goal,
    // R3: the goal write clock (ISO) or null when the row never declared one.
    // Never derived from heartbeatAt — that is exactly the lie R3 fixes.
    goalUpdatedAt: record.goalUpdatedAt === '' ? null : record.goalUpdatedAt,
    blocked_on: record.blocked_on,
    queued: record.queued,
    last_action: record.last_action,
    corrupt: false,
    corruptReason: null,
  };
}

/** Stable shape for a row that cannot be read; every field is present but null. */
function corruptEntry({ sessionId, file, root, reason, hostHint = null, hostname = null }) {
  const host = typeof hostHint === 'string' && hostHint.trim() !== '' ? hostHint.trim() : null;
  return {
    sessionId,
    file,
    fileRel: relativePath(root, file),
    effectiveState: 'corrupt',
    state: null,
    pid: null,
    host,
    startedAt: null,
    updatedAt: null,
    heartbeatAt: null,
    ttlMs: null,
    heartbeatAgeMs: null,
    sameHost: host == null || hostname == null ? null : hostsMatch(host, hostname),
    pidAlive: null,
    turn: null,
    goal: '',
    goalUpdatedAt: null,
    blocked_on: '',
    queued: [],
    last_action: null,
    corrupt: true,
    corruptReason: reason,
  };
}

/**
 * Best-effort host stamp from a corrupt row. A half-written JSON object still
 * usually carries its host; extracting it lets prune tell a local orphan from
 * a row another machine may still own. This is a hint for protection only —
 * it is never trusted as proof of liveness.
 */
function hostHintFromText(text) {
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (isPlainObject(raw) && typeof raw.host === 'string' && raw.host.trim() !== '') {
      return raw.host.trim();
    }
  } catch {
    // Fall through to the field regex for truncated/half-written JSON.
  }
  const match = /"host"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!match) return null;
  try {
    const decoded = JSON.parse(`"${match[1]}"`);
    return typeof decoded === 'string' && decoded.trim() !== '' ? decoded.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Every row in the live directory. A missing directory is an empty registry.
 * Corrupt rows are returned, never thrown; a directory that cannot be read at
 * all is E_LIVE_CORRUPT because the list cannot be answered honestly.
 */
function scanEntries(root, { now, hostname }) {
  const dir = liveDir(root);
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { dir, entries: [], hashes: new Map() };
    throw memoryError(
      LIVE_CODES.CORRUPT,
      `读不到活体目录：${dir}（${error?.code ?? error?.message}）`,
      error,
    );
  }
  const entries = [];
  // The exact bytes each row had when it was scanned. Prune keeps this hash so
  // it can prove the row did not change while it was being considered.
  const hashes = new Map();
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue; // no symlinks, no directories
    const name = dirent.name;
    if (!name.endsWith('.json')) continue; // orphan .tmp-* files stay invisible
    const sessionId = name.slice(0, -'.json'.length);
    if (!SESSION_ID_RE.test(sessionId)) continue; // not a registry file
    const file = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      entries.push(corruptEntry({
        sessionId, file, root, reason: `读取失败：${error?.code ?? error?.message}`,
      }));
      continue;
    }
    hashes.set(file, sha256Text(text));
    const decoded = decodeRecord(text, sessionId);
    if (!decoded.ok) {
      entries.push(corruptEntry({
        sessionId, file, root, reason: decoded.reason,
        hostHint: hostHintFromText(text), hostname,
      }));
      continue;
    }
    entries.push(liveEntry(decoded.record, { file, root, now, hostname }));
  }
  entries.sort((a, b) => {
    const at = parseTime(a.updatedAt);
    const bt = parseTime(b.updatedAt);
    if (at != null && bt != null && at !== bt) return bt - at;
    if (at != null && bt == null) return -1;
    if (at == null && bt != null) return 1;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return { dir, entries, hashes };
}

function countStates(entries) {
  const counts = Object.fromEntries(EFFECTIVE_STATES.map((state) => [state, 0]));
  for (const entry of entries) counts[entry.effectiveState] += 1;
  counts.total = entries.length;
  return counts;
}

function entrySummary(entry) {
  return {
    sessionId: entry.sessionId,
    effectiveState: entry.effectiveState,
    host: entry.host,
    pid: entry.pid,
  };
}

// ------------------------------------------------------------------- argument

function optionalString(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw bad(`${name} 必须是字符串，收到 ${argumentType(value)}`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string') {
    throw bad(`${name} 必须是字符串，收到 ${argumentType(value)}`);
  }
  return value;
}

function optionalInteger(value, name, { min, max } = {}) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw bad(`${name} 必须是整数，收到 ${JSON.stringify(value)}`);
  }
  if (min !== undefined && value < min) throw bad(`${name} 必须 >= ${min}，收到 ${value}`);
  if (max !== undefined && value > max) throw bad(`${name} 必须 <= ${max}，收到 ${value}`);
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw bad(`${name} 必须是布尔值，收到 ${argumentType(value)}`);
  }
  return value;
}

function optionalBoolean(value, name, fallback = false) {
  if (value === undefined) return fallback;
  return requireBoolean(value, name);
}

function optionalQueued(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw bad(`queued 必须是字符串数组，收到 ${argumentType(value)}`);
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw bad(`queued[${index}] 必须是字符串，收到 ${argumentType(item)}`);
    }
  }
  return value;
}

function optionalLastAction(value, now) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw bad(`last_action 必须是 {at, kind, detail} 对象，收到 ${argumentType(value)}`);
  }
  const at = value.at === undefined
    ? isoTime(now)
    : (parseTime(requireString(value.at, 'last_action.at')) != null
      ? value.at
      : (() => { throw bad(`last_action.at 不是可解析的时间：${JSON.stringify(value.at)}`); })());
  return {
    at,
    kind: value.kind === undefined ? '' : requireString(value.kind, 'last_action.kind'),
    detail: value.detail === undefined ? '' : requireString(value.detail, 'last_action.detail'),
  };
}

function requireState(value) {
  if (value === undefined) throw bad(`state 必填，可选值：${DECLARED_STATES.join(' | ')}`);
  if (typeof value !== 'string') throw bad(`state 必须是字符串，收到 ${argumentType(value)}`);
  const state = value.trim().toLowerCase();
  if (!DECLARED_STATES.includes(state)) {
    throw bad(`state 无效：${JSON.stringify(value)}，可选值：${DECLARED_STATES.join(' | ')}`);
  }
  return state;
}

/** Keep a goal to GOAL_MAX_CHARS code points; the result says it was cut. */
function fitGoal(goal) {
  const chars = Array.from(goal);
  if (chars.length <= GOAL_MAX_CHARS) {
    return { value: goal, truncated: false, chars: chars.length };
  }
  return {
    value: chars.slice(0, GOAL_MAX_CHARS).join(''),
    truncated: true,
    chars: chars.length,
  };
}

/** Trim a string to `max` code points; report whether anything was cut. */
function clipChars(value, max) {
  const chars = Array.from(value);
  if (chars.length <= max) return { value, clipped: false, chars: chars.length };
  return { value: chars.slice(0, max).join(''), clipped: true, chars: chars.length };
}

/**
 * Bound a queued list: at most MAX_QUEUED_ITEMS entries, each at most
 * MAX_QUEUED_ITEM_CHARS code points. The drop counts are reported, never silent.
 */
function boundQueued(value, fallback) {
  const input = value ?? fallback ?? [];
  const kept = input.slice(0, MAX_QUEUED_ITEMS);
  let clippedItems = 0;
  const items = kept.map((item) => {
    const clip = clipChars(item, MAX_QUEUED_ITEM_CHARS);
    if (clip.clipped) clippedItems += 1;
    return clip.value;
  });
  return {
    value: items,
    input: input.length,
    dropped: Math.max(0, input.length - items.length),
    clippedItems,
    truncated: input.length > items.length || clippedItems > 0,
  };
}

/** Bound last_action.detail; the row still carries a complete, usable action. */
function boundLastAction(action, now, created, state) {
  const base = action ?? {
    at: isoTime(now),
    kind: created ? 'create' : 'update',
    detail: `state=${state}`,
  };
  const detail = clipChars(base.detail ?? '', LAST_ACTION_DETAIL_MAX_CHARS);
  return {
    value: { at: base.at, kind: base.kind, detail: detail.value },
    truncated: detail.clipped,
    chars: detail.chars,
  };
}

function resolveSessionId(args, config) {
  if (args.sessionId !== undefined) return normalizeSessionId(args.sessionId);
  let fromConfig = typeof config.sessionId === 'string' && config.sessionId.trim() !== ''
    ? config.sessionId
    : null;
  // An explicit `config.sessionId` is a caller decision (e.g. a scheduled job
  // acting on a named row); it must not be registered as "this writer's own".
  const explicitConfig = fromConfig != null;
  if (fromConfig == null && typeof config.currentSessionId === 'function') {
    try {
      // Pass `exec` through: the resolver uses the explicit caller Agent from
      // the tool execution, falling back to the initiator chain.
      const current = config.currentSessionId(config.exec);
      if (typeof current === 'string' && current.trim() !== '') fromConfig = current;
    } catch {
      fromConfig = null;
    }
  }
  if (fromConfig == null) {
    throw bad('无法确定当前会话 id：传 sessionId，或让宿主提供当前会话 id');
  }
  const id = normalizeSessionId(fromConfig, 'currentSessionId');
  // Auto-bind: a row written without an explicit id belongs to the caller, so
  // the heartbeat manager may keep refreshing this id later. Best effort — a
  // failed hook must never fail the write that already succeeded.
  if (!explicitConfig && typeof config.onAutoSessionId === 'function') {
    try {
      config.onAutoSessionId(id);
    } catch {
      /* binding is optional */
    }
  }
  return id;
}

// --------------------------------------------------------------------- tools

/**
 * A row path must be a regular file or absent. A directory (or a symlink)
 * sitting on the exact path would make every write fail late with a generic
 * rename error, so refuse it up front and name the obstacle.
 */
function assertRowSlotWritable(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw memoryError(
      LIVE_CODES.WRITE,
      `无法检查活体记录位置：${file}（${error?.code ?? error?.message}）`,
      error,
    );
  }
  if (stat.isSymbolicLink()) {
    throw memoryError(
      LIVE_CODES.DIR_PLACEHOLDER,
      `活体记录位置是符号链接，拒绝写入：${file} — 删除链接后重试`,
    );
  }
  if (!stat.isFile()) {
    throw memoryError(
      LIVE_CODES.DIR_PLACEHOLDER,
      `活体记录位置被${stat.isDirectory() ? '目录' : '非普通文件'}占用：${file}`
        + ' — 先移走它（空目录可交给 session_live_prune 清理），再写入',
    );
  }
}

/**
 * session_live_update — write or patch this session's row.
 * Omitted optional fields keep their previous value, except `blocked_on`,
 * which is cleared whenever the new state is not `blocked`.
 */
export function liveUpdate(args = {}, config = {}) {
  assertEntry('session_live_update', args, config);
  const root = memoryRootFromConfig(config);
  const sessionId = resolveSessionId(args, config);
  const state = requireState(args.state);
  const turn = optionalInteger(args.turn, 'turn', { min: 0 });
  const goalInput = optionalString(args.goal, 'goal');
  const blockedInput = optionalString(args.blocked_on, 'blocked_on');
  const queuedInput = optionalQueued(args.queued);
  const ttlInput = optionalInteger(args.ttlMs, 'ttlMs', { min: MIN_TTL_MS, max: MAX_TTL_MS });
  const now = nowMs(config);
  const lastActionInput = optionalLastAction(args.last_action, now);
  const fit = goalInput === undefined ? null : fitGoal(goalInput);

  const file = liveFile(root, sessionId);
  assertRowSlotWritable(file);
  const prior = readPrior(file, sessionId);
  const base = prior.record;
  const created = base == null;
  const goal = fit ? fit.value : (base?.goal ?? '');
  // R3: `goalUpdatedAt` is the goal's own clock. Only a write that supplies a
  // goal stamps it; patches and heartbeat touches keep the previous value, so
  // "目标 30 分钟没更新" can be told apart from "心跳 5 秒前刚动过".
  const goalUpdatedAt = goalInput !== undefined
    ? isoTime(now)
    : (base?.goalUpdatedAt ?? '');
  // blocked_on describes a blocked session; anything else clears it, so a
  // running row cannot keep advertising an obstacle nobody is waiting on.
  const priorBlockedOn = base?.blocked_on ?? '';
  const incomingBlockedOn = blockedInput !== undefined ? blockedInput : priorBlockedOn;
  const blockedOn = state === 'blocked' ? incomingBlockedOn : '';
  const blockedOnCleared = state !== 'blocked' && incomingBlockedOn.length > 0;
  // Both patches are bounded so one row cannot grow into a backlog dump.
  const queued = boundQueued(queuedInput, base?.queued ?? []);
  const lastAction = boundLastAction(lastActionInput ?? base?.last_action, now, created, state);
  const record = {
    schemaVersion: LIVE_SCHEMA_VERSION,
    sessionId,
    pid: process.pid,
    host: currentHostname(),
    startedAt: base?.startedAt ?? isoTime(now),
    updatedAt: isoTime(now),
    heartbeatAt: isoTime(now),
    ttlMs: ttlInput ?? base?.ttlMs ?? DEFAULT_TTL_MS,
    state,
    turn: turn ?? base?.turn ?? 0,
    goal,
    goalUpdatedAt,
    blocked_on: blockedOn,
    queued: queued.value,
    last_action: lastAction.value,
  };

  const dir = liveDir(root);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw memoryError(
      LIVE_CODES.WRITE,
      `创建活体目录失败：${dir}（${error?.code ?? error?.message}）`,
      error,
    );
  }
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const write = writeLiveText(file, text);
  const entry = liveEntry(record, { file, root, now, hostname: currentHostname() });

  return {
    ok: true,
    status: 'written',
    created,
    sessionId,
    file,
    fileRel: entry.fileRel,
    sha256: write.sha256,
    bytes: write.bytes,
    superseded: write.superseded,
    state,
    effectiveState: entry.effectiveState,
    ttlMs: record.ttlMs,
    goalTruncated: fit?.truncated === true,
    goalChars: fit?.chars ?? Array.from(goal).length,
    goalLimit: GOAL_MAX_CHARS,
    queuedTruncated: queued.truncated,
    queuedInput: queued.input,
    queuedCount: queued.value.length,
    queuedLimit: MAX_QUEUED_ITEMS,
    queuedItemLimit: MAX_QUEUED_ITEM_CHARS,
    lastActionDetailTruncated: lastAction.truncated,
    lastActionDetailChars: lastAction.chars,
    lastActionDetailLimit: LAST_ACTION_DETAIL_MAX_CHARS,
    blockedOnCleared,
    repairedCorrupt: prior.reason,
    record,
    message:
      `${created ? '已创建' : '已更新'} ${entry.fileRel}：state=${state}, effectiveState=${entry.effectiveState}, ` +
      `pid=${record.pid}, ttl=${record.ttlMs}ms` +
      (fit?.truncated ? `；goal 超过 ${GOAL_MAX_CHARS} 字，已截断（原 ${fit.chars} 字）` : '') +
      (queued.truncated
        ? `；queued 超过上限（最多 ${MAX_QUEUED_ITEMS} 项、每项 ${MAX_QUEUED_ITEM_CHARS} 字），输入 ${queued.input} 项，保留 ${queued.value.length} 项`
        : '') +
      (lastAction.truncated ? `；last_action.detail 超过 ${LAST_ACTION_DETAIL_MAX_CHARS} 字，已截断` : '') +
      (blockedOnCleared ? '；state 不是 blocked，blocked_on 已清空' : '') +
      (write.superseded ? '；并发写入中另一份完整记录最后落盘（last-writer-wins）' : '') +
      (prior.reason ? `；覆盖了损坏的旧记录（${prior.reason}）` : ''),
  };
}

/**
 * Refresh one *existing* row's liveness stamps — the write behind auto-heartbeat.
 *
 * This is deliberately narrower than `liveUpdate`:
 *   - it never creates a row (`status:'absent'` instead), so merely running a
 *     longlive tool does not fabricate a session row;
 *   - it never repairs/lists corrupt rows (`status:'corrupt'`, bytes untouched);
 *   - it preserves `state`, `goal`, `goalUpdatedAt`, `blocked_on`, `queued`,
 *     `turn`, `startedAt` and `ttlMs`: heartbeat says "this writer is still
 *     here", not "state changed". In particular the goal's own clock must not
 *     move, or the board could no longer tell a stale goal from a live one;
 *   - `lastAction:false` keeps `last_action` exactly as-is (the timer tick);
 *     otherwise only the action stamp is replaced, bounded like every other write.
 */
export function liveTouch(sessionId, config = {}) {
  const root = memoryRootFromConfig(config);
  const id = normalizeSessionId(sessionId);
  const file = liveFile(root, id);
  assertRowSlotWritable(file);
  const prior = readPrior(file, id);
  if (prior.record == null) {
    if (prior.reason == null) {
      return {
        ok: false,
        status: 'absent',
        sessionId: id,
        file,
        message: `没有 ${id} 的活体记录，未新建（自动心跳只刷新已存在的行）`,
      };
    }
    return {
      ok: false,
      status: 'corrupt',
      sessionId: id,
      file,
      reason: prior.reason,
      message: `活体记录无法解析，未覆盖：${prior.reason}`,
    };
  }

  const now = nowMs(config);
  const base = prior.record;
  const keepAction = config.lastAction === false;
  const action = keepAction
    ? base.last_action
    : {
      at: isoTime(now),
      kind: typeof config.kind === 'string' && config.kind.trim() !== ''
        ? config.kind.trim()
        : 'heartbeat',
      detail: clipChars(
        typeof config.detail === 'string' ? config.detail : '',
        LAST_ACTION_DETAIL_MAX_CHARS,
      ).value,
    };
  const record = {
    ...base,
    pid: process.pid,
    host: currentHostname(),
    updatedAt: isoTime(now),
    heartbeatAt: isoTime(now),
    last_action: action,
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const write = writeLiveText(file, text);
  const entry = liveEntry(record, { file, root, now, hostname: currentHostname() });
  return {
    ok: true,
    status: 'touched',
    sessionId: id,
    file,
    fileRel: entry.fileRel,
    sha256: write.sha256,
    bytes: write.bytes,
    superseded: write.superseded,
    state: record.state,
    effectiveState: entry.effectiveState,
    record,
    message: `已刷新 ${entry.fileRel}：heartbeatAt=${record.heartbeatAt}, pid=${record.pid}, state=${record.state}`,
  };
}

/** session_live_list — every row with its computed effectiveState. */
export function liveList(args = {}, config = {}) {
  assertEntry('session_live_list', args, config);
  const root = memoryRootFromConfig(config);
  const includeDead = optionalBoolean(args.includeDead, 'includeDead', false);
  const now = nowMs(config);
  const hostname = currentHostname();
  const { dir, entries } = scanEntries(root, { now, hostname });
  const counts = countStates(entries);
  const deadEntries = entries.filter((entry) => entry.effectiveState === 'dead');
  const visible = includeDead
    ? entries
    : entries.filter((entry) => entry.effectiveState !== 'dead');
  return {
    ok: true,
    status: 'listed',
    root,
    dir,
    includeDead,
    scanned: entries.length,
    count: visible.length,
    hiddenDead: deadEntries.length,
    counts,
    entries: visible,
    message:
      `活体表：${visible.length} 条` +
      (includeDead ? '' : `（隐藏 dead ${deadEntries.length} 条）`) +
      `；running ${counts.running}, idle ${counts.idle}, waiting ${counts.waiting}, ` +
      `blocked ${counts.blocked}, stale ${counts.stale}, dead ${counts.dead}, corrupt ${counts.corrupt}`,
  };
}

/** session_live_get — one row by id, same computed state as the list. */
export function liveGet(args = {}, config = {}) {
  assertEntry('session_live_get', args, config);
  const root = memoryRootFromConfig(config);
  const sessionId = normalizeSessionId(args.sessionId);
  // NTFS maps S-ALI / s-ali / S-Ali to the same file, so a read through an
  // alias cannot tell the caller which session it actually got. Writers
  // normalise silently; readers must name the canonical id.
  if (args.sessionId !== sessionId) {
    const error = memoryError(
      LIVE_CODES.NOT_CANONICAL,
      `sessionId 不是规范形式：收到 ${JSON.stringify(args.sessionId)}，应为 ${JSON.stringify(sessionId)}`
        + '（NTFS 上大小写/空白别名指向同一文件）',
    );
    error.canonical = sessionId;
    throw error;
  }
  const now = nowMs(config);
  const hostname = currentHostname();
  const file = liveFile(root, sessionId);
  // A symlinked row could be retargeted between the realpath check and the
  // read. liveGet is a lookup, not a follower: refuse the link itself.
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: false,
        status: 'absent',
        found: false,
        sessionId,
        file,
        fileRel: relativePath(root, file),
        message: `没有 ${sessionId} 的活体记录`,
      };
    }
    throw memoryError(
      LIVE_CODES.CORRUPT,
      `读取活体记录失败：${file}（${error?.code ?? error?.message}）`,
      error,
    );
  }
  if (stat.isSymbolicLink()) {
    throw memoryError(LIVE_CODES.CORRUPT, `拒绝跟随符号链接的活体记录：${file}`);
  }
  if (!stat.isFile()) {
    throw memoryError(LIVE_CODES.CORRUPT, `活体记录不是普通文件：${file}`);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw memoryError(
      LIVE_CODES.CORRUPT,
      `读取活体记录失败：${file}（${error?.code ?? error?.message}）`,
      error,
    );
  }
  const decoded = decodeRecord(text, sessionId);
  if (!decoded.ok) {
    throw memoryError(LIVE_CODES.CORRUPT, `活体记录损坏：${file} — ${decoded.reason}`);
  }
  const live = liveEntry(decoded.record, { file, root, now, hostname });
  return {
    ok: true,
    status: 'ok',
    found: true,
    sessionId,
    file,
    fileRel: live.fileRel,
    live,
    message: `${sessionId}: ${live.effectiveState}`,
  };
}

/**
 * Non-row clutter in the live directory: orphan tmp files left by a SIGKILLed
 * writer, empty directory placeholders that block a session id, and symlinks
 * (reported, never followed or deleted).
 */
function scanPruneExtras(root, dir, now) {
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw memoryError(
      LIVE_CODES.CORRUPT,
      `读不到活体目录：${dir}（${error?.code ?? error?.message}）`,
      error,
    );
  }
  const extras = [];
  for (const dirent of dirents) {
    const file = path.join(dir, dirent.name);
    const fileRel = relativePath(root, file);
    if (dirent.isSymbolicLink()) {
      extras.push({
        kind: 'symlink',
        file,
        fileRel,
        action: 'report',
        reason: '符号链接：不跟随、不自动删除',
      });
      continue;
    }
    if (dirent.isDirectory()) {
      let empty = false;
      try {
        empty = fs.readdirSync(file).length === 0;
      } catch {
        empty = false;
      }
      extras.push({
        kind: 'directory',
        file,
        fileRel,
        empty,
        action: empty ? 'delete' : 'report',
        reason: empty
          ? '空目录占位：可删除'
          : '非空目录占位：只报告，不递归删除',
      });
      continue;
    }
    if (!dirent.name.includes('.tmp-')) continue;
    let ageMs = null;
    try {
      ageMs = now - fs.lstatSync(file).mtimeMs;
    } catch {
      ageMs = null;
    }
    const old = ageMs != null && ageMs > TMP_MAX_AGE_MS;
    extras.push({
      kind: 'tmp',
      file,
      fileRel,
      ageMs,
      action: old ? 'delete' : 'report',
      reason: old
        ? `遗留 tmp 文件超过 ${Math.round(TMP_MAX_AGE_MS / 60000)} 分钟，可删除`
        : 'tmp 文件仍新：可能属于正在写入的进程，保留',
    });
  }
  return extras;
}

/**
 * session_live_prune — delete still-dead/corrupt rows whose bytes did not
 * change, plus old orphan tmp files and empty directory placeholders.
 * Dry-run unless confirm:"PRUNE"; dryRun:true forces a preview even then.
 */
export function livePrune(args = {}, config = {}) {
  assertEntry('session_live_prune', args, config);
  const root = memoryRootFromConfig(config);
  const dryRunFlag = args.dryRun === undefined ? undefined : requireBoolean(args.dryRun, 'dryRun');
  const confirm = args.confirm === undefined ? undefined : requireString(args.confirm, 'confirm');
  const confirmed = confirm === LIVE_CONFIRM;
  if (dryRunFlag === false && !confirmed) {
    throw memoryError(
      LIVE_CODES.CONFIRM_REQUIRED,
      `真正清理需要 confirm:"${LIVE_CONFIRM}"；当前 confirm=${JSON.stringify(confirm)}`,
    );
  }
  const real = confirmed && dryRunFlag !== true;
  const now = nowMs(config);
  const hostname = currentHostname();
  const { dir, entries, hashes } = scanEntries(root, { now, hostname });
  const extras = scanPruneExtras(root, dir, now);

  // Legal row candidates: a dead row with a confirmed same host, or a corrupt
  // row that does not carry another machine's host stamp. A corrupt row with a
  // remote host hint is protected: its bytes still may belong to a live remote
  // session, and corruptness alone is not proof of abandonment.
  // Each candidate carries the exact byte hash seen while scanning and the
  // preservation fields (blocked_on / queued / startedAt) so a delete decision
  // never silently loses them.
  const rowCandidate = (entry) => ({
    sessionId: entry.sessionId,
    effectiveState: entry.effectiveState,
    host: entry.host,
    pid: entry.pid,
    file: entry.file,
    fileRel: entry.fileRel,
    sha256: hashes.get(entry.file) ?? null,
    blocked_on: entry.blocked_on ?? '',
    queued: Array.isArray(entry.queued) ? entry.queued : [],
    startedAt: entry.startedAt ?? null,
    goal: entry.goal ?? '',
    reason: entry.effectiveState === 'corrupt'
      ? `corrupt：${entry.corruptReason}`
      : `dead：同 host 且 pid ${entry.pid} 不存在`,
  });
  const candidates = entries
    .filter((entry) => {
      if (entry.effectiveState === 'corrupt') return entry.sameHost !== false;
      if (entry.effectiveState === 'dead') return entry.sameHost === true;
      return false;
    })
    .map(rowCandidate);

  // blocked_on is never dropped silently: such a row is skipped, not deleted,
  // and the skip is visible in the result.
  const protectedRows = candidates.filter((candidate) => candidate.blocked_on !== '');
  const deletableRows = candidates.filter((candidate) => candidate.blocked_on === '');
  const remoteCorruptSkips = entries
    .filter((entry) => entry.effectiveState === 'corrupt' && entry.sameHost === false)
    .map((entry) => ({
      ...rowCandidate(entry),
      reason: `corrupt 行带远端 host ${entry.host}：跨 host 不可判定，保留`,
    }));
  const wouldDelete = [
    ...deletableRows.map((candidate) => ({
      kind: 'row', sessionId: candidate.sessionId, file: candidate.file, fileRel: candidate.fileRel,
    })),
    ...extras
      .filter((extra) => extra.action === 'delete')
      .map((extra) => ({ kind: extra.kind, file: extra.file, fileRel: extra.fileRel })),
  ];

  if (!real) {
    const candidateIds = new Set(candidates.map((candidate) => candidate.sessionId));
    return {
      ok: true,
      status: 'dry-run',
      dryRun: true,
      confirmRequired: LIVE_CONFIRM,
      root,
      dir,
      scanned: entries.length,
      candidates,
      wouldDelete,
      deleted: [],
      failed: [],
      tombstoned: [],
      skipped: [
        ...protectedRows.map((candidate) => ({
          ...candidate,
          reason: 'blocked_on 非空：自动删除会静默丢弃阻塞信息，保留',
        })),
        ...remoteCorruptSkips,
      ],
      placeholders: extras.filter((extra) => extra.kind !== 'tmp'),
      tmpFiles: extras.filter((extra) => extra.kind === 'tmp'),
      kept: entries.filter((entry) => !candidateIds.has(entry.sessionId)).map(entrySummary),
      message:
        `dry-run：扫描 ${entries.length} 条，可清理 ${wouldDelete.length} 项（dead/本机 corrupt 行 + 陈旧 tmp/空目录）；` +
        (protectedRows.length ? `blocked_on 保护 ${protectedRows.length} 条；` : '') +
        (remoteCorruptSkips.length ? `远端 host 的 corrupt 行保护 ${remoteCorruptSkips.length} 条；` : '') +
        `加 confirm:"${LIVE_CONFIRM}" 才真删` +
        (confirmed ? '（dryRun:true 是显式预览，不删除）' : ''),
    };
  }

  const deleted = [];
  const failed = [];
  const tombstoned = [];
  const skipped = [
    ...protectedRows.map((candidate) => ({
      ...candidate,
      reason: 'blocked_on 非空：自动删除会静默丢弃阻塞信息，保留',
    })),
    ...remoteCorruptSkips,
  ];

  for (const candidate of deletableRows) {
    // Re-read and re-judge immediately before unlinking. A row that changed
    // since it became a candidate is never removed on stale evidence.
    let text;
    try {
      text = fs.readFileSync(candidate.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        skipped.push({ ...candidate, reason: '删除前记录已不存在' });
      } else {
        failed.push({
          ...candidate,
          code: error?.code ?? LIVE_CODES.WRITE,
          error: String(error?.message ?? error),
        });
      }
      continue;
    }
    if (candidate.sha256 != null && sha256Text(text) !== candidate.sha256) {
      skipped.push({ ...candidate, reason: '删除前内容已变化，重新判定后保留' });
      continue;
    }
    const decoded = decodeRecord(text, candidate.sessionId);
    if (decoded.ok) {
      const current = liveEntry(decoded.record, {
        file: candidate.file, root, now, hostname,
      });
      if ((current.blocked_on ?? '') !== '') {
        skipped.push({ ...candidate, reason: '删除前出现 blocked_on，保留' });
        continue;
      }
      const stillGone = current.effectiveState === 'corrupt'
        || (current.effectiveState === 'dead' && current.sameHost === true);
      if (!stillGone) {
        skipped.push({ ...candidate, reason: `重新判定为 ${current.effectiveState}，不再删除` });
        continue;
      }
    } else {
      // Still corrupt: re-extract the host stamp from the bytes read right now.
      // Evidence that changed from "host unknown" to "another host" protects it.
      const hint = hostHintFromText(text);
      if (hint != null && !hostsMatch(hint, hostname)) {
        skipped.push({ ...candidate, reason: `删除前重读发现远端 host ${hint}，保留` });
        continue;
      }
    }
    try {
      // Archive first: a crash between tombstone and unlink leaves a replayable
      // audit row; a crash before tombstone leaves the row untouched.
      try {
        tombstoned.push(...appendLiveTombstones(root, [{ ...candidate, sha256: sha256Text(text) }], now));
      } catch { /* the row is still recoverable from its file */ }
      fs.unlinkSync(candidate.file);
      deleted.push(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        skipped.push({ ...candidate, reason: '删除前记录已不存在' });
      } else {
        failed.push({
          ...candidate,
          code: error?.code ?? LIVE_CODES.WRITE,
          error: String(error?.message ?? error),
        });
      }
    }
  }

  // Extras are re-checked at delete time: only still-old tmp files and still-
  // empty directories are removed. A non-empty directory is only reported.
  const placeholders = [];
  const tmpFiles = [];
  const extrasDeleted = [];
  for (const extra of extras) {
    if (extra.kind === 'tmp') {
      if (extra.action !== 'delete') {
        tmpFiles.push(extra);
        continue;
      }
      try {
        const ageMs = now - fs.lstatSync(extra.file).mtimeMs;
        if (!(ageMs > TMP_MAX_AGE_MS)) {
          tmpFiles.push({ ...extra, action: 'report', reason: 'tmp 文件仍新，保留' });
          continue;
        }
        fs.unlinkSync(extra.file);
        tmpFiles.push({ ...extra, action: 'deleted' });
        extrasDeleted.push({ ...extra, action: 'deleted' });
      } catch (error) {
        if (error?.code === 'ENOENT') {
          tmpFiles.push({ ...extra, action: 'gone' });
        } else {
          tmpFiles.push({ ...extra, action: 'report', reason: `删除失败：${error?.code ?? error?.message}` });
        }
      }
      continue;
    }
    if (extra.kind === 'symlink') {
      placeholders.push(extra);
      continue;
    }
    // directory
    if (extra.action !== 'delete') {
      placeholders.push(extra);
      continue;
    }
    try {
      if (fs.readdirSync(extra.file).length !== 0) {
        placeholders.push({ ...extra, action: 'report', reason: '删除时目录已非空，只报告' });
        continue;
      }
      fs.rmdirSync(extra.file);
      placeholders.push({ ...extra, action: 'deleted' });
      extrasDeleted.push({ ...extra, action: 'deleted' });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        placeholders.push({ ...extra, action: 'gone' });
      } else {
        placeholders.push({ ...extra, action: 'report', reason: `删除失败：${error?.code ?? error?.message}` });
      }
    }
  }

  const goneIds = new Set([...deleted, ...failed].map((item) => item.sessionId));
  return {
    ok: true,
    status: 'pruned',
    dryRun: false,
    confirmRequired: LIVE_CONFIRM,
    root,
    dir,
    scanned: entries.length,
    candidates,
    wouldDelete: [],
    deleted,
    failed,
    tombstoned,
    skipped,
    placeholders,
    tmpFiles,
    kept: entries.filter((entry) => !goneIds.has(entry.sessionId)).map(entrySummary),
    message:
      `已清理 ${deleted.length} 条（仍 dead/corrupt 且字节未变）` +
      (extrasDeleted.length ? `，另清理 ${extrasDeleted.length} 项陈旧 tmp/空目录` : '') +
      (skipped.length ? `，跳过 ${skipped.length} 条（内容变化、blocked_on 或远端 host）` : '') +
      (failed.length ? `，失败 ${failed.length} 条` : '') +
      `；删除前内容变化、blocked_on 非空、跨 host 的 dead/corrupt 行与 pid 仍存活的记录一律未动`,
  };
}

/** Read the previous row for a patch; a corrupt prior is reported, not fatal. */
function readPrior(file, sessionId) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { record: null, reason: null };
    return { record: null, reason: `读取失败：${error?.code ?? error?.message}` };
  }
  const decoded = decodeRecord(text, sessionId);
  return decoded.ok
    ? { record: decoded.record, reason: null }
    : { record: null, reason: decoded.reason };
}
