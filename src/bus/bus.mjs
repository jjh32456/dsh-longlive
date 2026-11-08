// Cross-session message bus — prototype (dependency-free, Node >= 18).
//
// Storage layout (one bus root, shared by every session of one profile):
//
//   <root>/
//     aliases.json              { "reviewer": "session-bob" }
//     roles.json                { "team": ["session-bob", "session-carol"] }
//     writer.lock               single-writer lease for identity/handover files
//     inbox/<session-id>/
//       <message-id>.json       pending envelope; immutable after creation
//       acked/<message-id>.json acknowledged (kept for duplicate-ack replay)
//       dead/<message-id>.*.json corrupt / foreign-host messages, quarantined
//
// Delivery is at-least-once: poll() never removes a message, ack() does. A
// sender that supplies dedupKey gets a deterministic id, so a retry after a
// timeout cannot create a second copy. TTL is evaluated on the receiver side.
//
// All operations stay below the realpath of the bus root; symlinked
// directories and message files are rejected, and ids are limited to the same
// charset the longlive live registry accepts (lowercased).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const BUS_SCHEMA_VERSION = 1;
export const KINDS = Object.freeze(['note', 'task', 'reply', 'handover', 'control']);
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_BODY_CHARS = 8192;
export const DEFAULT_MAX_PENDING = 1000;
// Writer lease TTL: 1_800_000 ms = 30 minutes. This constant is the single
// source of truth for the default; DESIGN.md §13.1 and WIRING.md §8 quote the
// same value in ms, and a test asserts the three stay in sync.
export const DEFAULT_WRITER_TTL_MS = 1_800_000;
export const WRITER_SCHEMA_VERSION = 2;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
// A sender whose clock is ahead by more than this is refused (E_BAD_CLOCK), and
// a receiver quarantines any envelope whose ts is this far in its own future.
// 300_000 ms = 5 minutes, enough for ordinary NTP slew, small enough that a
// poisoned cursor cannot hide real traffic for long.
export const DEFAULT_MAX_CLOCK_SKEW_MS = 300_000;

// The commit lock serializes writer.lock readers/writers across processes. It
// only ever exists for the duration of one synchronous critical section; a
// crashed process leaves it behind and the next caller steals it after
// COMMIT_LOCK_STALE_MS (or immediately when the recorded pid is provably dead).
const COMMIT_LOCK_STALE_MS = 30_000;
const COMMIT_LOCK_TIMEOUT_MS = 15_000;
// Same-process reentrancy: fencedWrite holds the commit lock while it calls a
// test hook / JSON.stringify, and a hook may synchronously call claimWriter.
// JavaScript is single-threaded, so an inner call cannot interleave with the
// outer critical section; skipping the file lock avoids a self-deadlock while
// the outer revalidation still catches a takeover.
const commitLocksHeldByProcess = new Set();

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MESSAGE_ID_RE = /^m-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

let localSeq = 0;

function busError(code, message) {
  const error = new Error(message);
  error.code = code;
  // Marks an intentional bus-level error (as opposed to an fs error whose code
  // also happens to start with "E"). Commit paths rethrow only these.
  error.busError = true;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Ack policy for the wiring layer.
 *
 * Host `turn/end` events are appended from a `finally` block, so they also fire
 * for failed turns (`reason.kind === 'error' | 'aborted'`). The bus has no
 * un-ack / requeue, so acking there would consume a message the model never got
 * to process. Only a turn whose reason is exactly `completed` may ack; a
 * missing or unknown reason fails closed and the message is redelivered on the
 * next `agent/pre-step`.
 *
 * Call this only inside the `turn/end` branch of `session/event` (WIRING §5.2).
 */
export function shouldAckOnTurnEnd(event) {
  if (!isPlainObject(event) || event.type !== 'turn/end') return false;
  const reason = isPlainObject(event.data) ? event.data.reason : undefined;
  return isPlainObject(reason) && reason.kind === 'completed';
}

/**
 * Merge the ids this pre-step injected with ids left over from an earlier
 * turn's failed ack.
 *
 * WIRING §3.2 and §5.1: `record.pendingAckIds` is a retry queue, not a
 * "messages shown this turn" register. Overwriting it on the next pre-step
 * would silently drop ids whose turn/end ack failed, and those messages would
 * be redelivered forever (bus ack has no expiry other than TTL). The union
 * keeps the old ids first, preserves order, and drops duplicates so repeated
 * `ack(id)` calls stay idempotent.
 *
 * @param {unknown} previous pending ids from the last turn
 * @param {unknown} included ids injected into the card just now
 * @returns {string[]}
 */
export function mergePendingAckIds(previous, included) {
  const merged = [];
  const seen = new Set();
  for (const list of [previous, included]) {
    if (!Array.isArray(list)) continue;
    for (const id of list) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeHost(value) {
  if (typeof value !== 'string') throw busError('E_BAD_HOST', 'host must be a string');
  const host = value.trim();
  if (!host || host.length > 255) throw busError('E_BAD_HOST', 'host must be 1..255 chars');
  if (/[\u0000-\u001f/\\]/.test(host)) throw busError('E_BAD_HOST', 'host contains control chars or path separators');
  return host;
}

export function normalizeSessionId(value, label = 'sessionId') {
  if (typeof value !== 'string') {
    throw busError('E_BAD_SESSION_ID', `${label} must be a string`);
  }
  const id = value.trim();
  if (!id) throw busError('E_BAD_SESSION_ID', `${label} must not be empty`);
  if (id.includes('\u0000')) {
    throw busError('E_PATH_OUTSIDE_ROOT', `${label} must not contain NUL`);
  }
  if (path.isAbsolute(id) || id === '.' || id === '..' || /[\\/]/.test(id)) {
    throw busError('E_PATH_OUTSIDE_ROOT', `${label} must not be a path: ${value}`);
  }
  if (!SESSION_ID_RE.test(id)) {
    throw busError('E_BAD_SESSION_ID', `${label} is not a valid session id: ${value}`);
  }
  const canonical = id.toLowerCase();
  if (canonical.endsWith('.') || canonical.endsWith(' ')) {
    throw busError('E_BAD_SESSION_ID', `${label} must not end with a dot or space`);
  }
  const base = canonical.split('.')[0];
  if (RESERVED_BASENAMES.has(base)) {
    throw busError('E_BAD_SESSION_ID', `${label} is a Windows reserved name: ${value}`);
  }
  return canonical;
}

function normalizeAlias(value) {
  if (typeof value !== 'string') throw busError('E_BAD_ALIAS', 'alias must be a string');
  const alias = value.trim();
  if (!ALIAS_RE.test(alias)) throw busError('E_BAD_ALIAS', `invalid alias: ${value}`);
  return alias.toLowerCase();
}

function newMessageId(now) {
  localSeq = (localSeq + 1) % 0xffffff;
  const time = Math.floor(now).toString(36).padStart(9, '0');
  const seq = localSeq.toString(36).padStart(4, '0');
  const pid = (process.pid % 0xfffffff).toString(36).padStart(6, '0');
  const random = crypto.randomBytes(3).toString('hex');
  return `m-${time}-${seq}-${pid}-${random}`;
}

function dedupMessageId(from, to, dedupKey) {
  const hash = crypto.createHash('sha256').update(`${from}\u0000${to}\u0000${dedupKey}`, 'utf8').digest('hex');
  return `m-${hash.slice(0, 32)}`;
}

function timestampFromMessageId(id) {
  const time = id.split('-')[1] || '';
  if (time.length !== 9) return null;
  const parsed = Number.parseInt(time, 36);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveRoot(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw busError('E_ROOT_REQUIRED', 'createBus requires a non-empty root path');
  }
  if (/^\\\\/.test(input.trim())) {
    throw busError('E_UNC_NOT_ALLOWED', 'bus root must be a local path, not a UNC share');
  }
  return path.resolve(input.trim());
}

function isPermissionError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS';
}

function ensureRoot(root) {
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    // m3 (rc.2): a read-only root is a permission problem, not a malformed
    // path. Keep failing hard, but say EPERM so callers can tell it apart.
    if (isPermissionError(error)) {
      throw busError('EPERM', `bus root is not writable: ${root}: ${error.code || error.message}`);
    }
    throw busError('E_BAD_ROOT', `cannot create bus root ${root}: ${error.code || error.message}`);
  }
  let real;
  try {
    real = fs.realpathSync.native(root);
  } catch (error) {
    // A directory that exists but cannot be resolved is usually an ACL/EPERM
    // problem, not a bad path (0.9.0-rc.3: real read-only root diagnostic).
    if (isPermissionError(error)) {
      throw busError('EPERM', `bus root is not readable: ${root}: ${error.code || error.message}`);
    }
    throw busError('E_BAD_ROOT', `cannot resolve bus root ${root}: ${error.code || error.message}`);
  }
  if (/^\\\\/.test(real)) {
    throw busError('E_UNC_NOT_ALLOWED', 'bus root resolves to a UNC share');
  }
  let stat;
  try {
    stat = fs.lstatSync(real);
  } catch (error) {
    if (isPermissionError(error)) {
      throw busError('EPERM', `bus root is not accessible: ${root}: ${error.code || error.message}`);
    }
    throw busError('E_BAD_ROOT', `cannot inspect bus root ${root}: ${error.code || error.message}`);
  }
  if (!stat.isDirectory()) throw busError('E_BAD_ROOT', `bus root is not a directory: ${real}`);
  return real;
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw busError('E_PATH_OUTSIDE_ROOT', `path escapes bus root: ${target}`);
  }
}

/**
 * Resolve the nearest existing ancestor of `target` with realpath, then append
 * the still-missing segments. `assertInside` alone is lexical: an NTFS junction
 * inside the root can point anywhere, so the real path is what must stay in.
 */
function realpathNearestExisting(target) {
  let current = target;
  const missing = [];
  for (;;) {
    try {
      return { real: fs.realpathSync.native(current), missing };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        if (isPermissionError(error)) {
          throw busError('EPERM', `cannot resolve ${current}: ${error.code || error.message}`);
        }
        throw busError('E_PATH_OUTSIDE_ROOT', `cannot resolve ${current}: ${error.code || error.message}`);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw busError('E_PATH_OUTSIDE_ROOT', `cannot resolve path: ${target}`);
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Strong path jail for anything the bus is about to create or write:
 *  1. lexical check against the real root (fast rejection of `..`/absolute);
 *  2. reject Windows alternate data streams (`file.json:payload`);
 *  3. realpath the nearest existing ancestor (a junction anywhere above the
 *     target resolves to its real location) and require it to be inside root;
 *  4. refuse to write through a symlink/junction at the target itself.
 * Missing tail segments are appended lexically after the real ancestor was
 * proven inside, so a not-yet-created parent can still be validated.
 */
function assertRealInsideRoot(root, target) {
  assertInside(root, target);
  const relative = path.relative(root, target);
  for (const segment of relative.split(path.sep)) {
    if (segment.includes(':')) {
      throw busError('E_PATH_OUTSIDE_ROOT', `path contains an alternate data stream: ${target}`);
    }
  }
  const { real, missing } = realpathNearestExisting(target);
  assertInside(root, real);
  const resolved = missing.length === 0 ? real : path.join(real, ...missing);
  assertInside(root, resolved);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw busError('E_PATH_OUTSIDE_ROOT', `refusing to write through a symlink: ${target}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolved;
}

function ensureDirInside(root, dir) {
  // Check before mkdir: `mkdirSync(recursive)` through a junction ancestor would
  // create directories outside the root and only fail afterwards.
  assertRealInsideRoot(root, dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    if (isPermissionError(error)) {
      throw busError('EPERM', `cannot create ${dir}: ${error.code || error.message}`);
    }
    throw busError('E_BAD_ROOT', `cannot create ${dir}: ${error.code || error.message}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (isPermissionError(error)) {
      throw busError('EPERM', `cannot inspect ${dir}: ${error.code || error.message}`);
    }
    throw busError('E_BAD_ROOT', `cannot inspect ${dir}: ${error.code || error.message}`);
  }
  if (stat.isSymbolicLink()) throw busError('E_PATH_OUTSIDE_ROOT', `refusing symlinked directory: ${dir}`);
  if (!stat.isDirectory()) throw busError('E_PATH_OUTSIDE_ROOT', `not a directory: ${dir}`);
  let real;
  try {
    real = fs.realpathSync.native(dir);
  } catch (error) {
    if (isPermissionError(error)) {
      throw busError('EPERM', `cannot resolve ${dir}: ${error.code || error.message}`);
    }
    throw busError('E_BAD_ROOT', `cannot resolve ${dir}: ${error.code || error.message}`);
  }
  assertInside(root, real);
  return real;
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: error.code || 'EREAD' };
  }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch {
    return { ok: false, error: 'EPARSE' };
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 4) throw error;
      sleepSync(5);
    }
  }
}

function atomicWriteJson(target, value) {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync is best effort; rename still gives atomic visibility.
    }
    fs.closeSync(fd);
    fd = undefined;
    renameWithRetry(temp, target);
    return { ok: true, exists: false };
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch { /* ignore */ }
    // A concurrent writer may have created the target first. Caller re-reads it.
    if (fs.existsSync(target)) return { ok: true, exists: true };
    throw busError('E_WRITE', `cannot write ${target}: ${error.code || error.message}`);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function validateEnvelope(value, recipient, maxBodyChars, expectedId) {
  if (!isPlainObject(value)) return { ok: false, reason: 'not-object' };
  if (value.v !== BUS_SCHEMA_VERSION) return { ok: false, reason: 'bad-version' };
  if (typeof value.id !== 'string' || !MESSAGE_ID_RE.test(value.id)) return { ok: false, reason: 'bad-id' };
  // The filename is the address of the message: ack(id) can only find an
  // envelope whose id matches its file name. A mismatch is never deliverable
  // (it would be permanently un-ackable), so quarantine it instead.
  if (expectedId !== undefined && value.id !== expectedId) return { ok: false, reason: 'id-mismatch' };
  let from;
  try {
    from = normalizeSessionId(value.from, 'from');
  } catch {
    return { ok: false, reason: 'bad-from' };
  }
  if (value.to !== recipient) return { ok: false, reason: 'wrong-recipient' };
  if (!KINDS.includes(value.kind)) return { ok: false, reason: 'bad-kind' };
  if (typeof value.body !== 'string' || value.body.length === 0) return { ok: false, reason: 'bad-body' };
  if (codePointLength(value.body) > maxBodyChars) return { ok: false, reason: 'body-too-large' };
  if (!Number.isFinite(value.ts) || value.ts <= 0) return { ok: false, reason: 'bad-ts' };
  if (!Number.isFinite(value.ttl) || value.ttl <= 0 || value.ttl > MAX_TTL_MS) {
    return { ok: false, reason: 'bad-ttl' };
  }
  if (typeof value.host !== 'string' || !value.host.trim()) return { ok: false, reason: 'bad-host' };
  if (value.dedupKey !== undefined) {
    if (typeof value.dedupKey !== 'string' || value.dedupKey.length === 0
      || codePointLength(value.dedupKey) > 128) {
      return { ok: false, reason: 'bad-dedup-key' };
    }
  }
  return {
    ok: true,
    message: {
      v: BUS_SCHEMA_VERSION,
      id: value.id,
      from,
      to: recipient,
      kind: value.kind,
      body: value.body,
      ts: value.ts,
      ttl: value.ttl,
      host: value.host,
      ...(value.dedupKey === undefined ? {} : { dedupKey: value.dedupKey }),
    },
  };
}

function deriveMemoryRoot(root) {
  const bus = path.basename(root).toLowerCase();
  const longlive = path.basename(path.dirname(root)).toLowerCase();
  if (bus === 'bus' && longlive === '.longlive') {
    return path.dirname(path.dirname(root));
  }
  return null;
}

function resolveMemoryRootOption(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw busError('E_BAD_ROOT', 'memoryRoot must be a path');
  return path.resolve(value.trim());
}

/**
 * Create a bus handle bound to one session.
 *
 * @param {object} options
 * @param {string} options.root              bus root (required)
 * @param {string} [options.sessionId]       this session's canonical id
 * @param {string} [options.host]            local hostname, default os.hostname()
 * @param {string} [options.memoryRoot]      memory root used to find .longlive/live
 * @param {string} [options.liveDir]         override the live registry directory
 * @param {() => number} [options.now]       clock injection (tests / deterministic)
 * @param {number} [options.maxBodyChars]    default 8192 code points
 * @param {number} [options.maxPending]      default 1000 messages per inbox
 */
export function createBus(options = {}) {
  const root = ensureRoot(resolveRoot(options.root));
  const sessionId = options.sessionId === undefined || options.sessionId === null
    ? null
    : normalizeSessionId(options.sessionId);
  const host = normalizeHost(options.host ?? os.hostname());
  const hostKey = host.toLowerCase();
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxBodyChars = clampInt(options.maxBodyChars, DEFAULT_MAX_BODY_CHARS, 1, 1_000_000);
  const maxPending = clampInt(options.maxPending, DEFAULT_MAX_PENDING, 1, 100_000);
  const maxClockSkewMs = clampInt(options.maxClockSkewMs, DEFAULT_MAX_CLOCK_SKEW_MS, 0, MAX_TTL_MS);
  // Wall clock used only for the "sender clock is far in the future" guard. A
  // test can pin it; production always uses Date.now(). The injected `now()` is
  // still the logical clock for envelopes, leases and TTL.
  const referenceClock = typeof options.referenceNow === 'function' ? options.referenceNow : () => Date.now();
  // Test seam. `hooks.afterSerialize` runs inside the fencedWrite commit lock,
  // after JSON.stringify and before the temp file/rename; production code must
  // not pass it. It exists so the TOCTOU takeover can be injected
  // deterministically instead of relying on a sleeping toJSON.
  const testHooks = isPlainObject(options.hooks) ? options.hooks : {};
  const memoryRoot = resolveMemoryRootOption(options.memoryRoot) ?? deriveMemoryRoot(root);
  const liveDir = options.liveDir !== undefined
    ? path.resolve(String(options.liveDir))
    : memoryRoot
      ? path.join(memoryRoot, '.longlive', 'live')
      : null;

  function nowMs() {
    const value = Number(clock());
    if (!Number.isFinite(value)) throw busError('E_BAD_CLOCK', 'now() must return a finite number');
    return Math.floor(value);
  }

  function referenceNowMs() {
    let value;
    try {
      value = Number(referenceClock());
    } catch {
      return null;
    }
    return Number.isFinite(value) ? Math.floor(value) : null;
  }

  function runHook(name, info) {
    const hook = testHooks[name];
    if (typeof hook === 'function') hook(info);
  }

  function inboxPath(recipient) {
    return path.join(root, 'inbox', recipient);
  }

  function ensureInbox(recipient) {
    return ensureDirInside(root, inboxPath(recipient));
  }

  function loadAddressBook(name) {
    const file = path.join(root, name);
    const read = readJsonFile(file);
    if (!read.ok) {
      if (read.error === 'ENOENT') return {};
      throw busError('E_BAD_ADDRESS_BOOK', `cannot read ${name}: ${read.error}`);
    }
    if (!isPlainObject(read.value)) throw busError('E_BAD_ADDRESS_BOOK', `${name} must contain a JSON object`);
    return read.value;
  }

  function resolveTargets(to) {
    if (typeof to !== 'string' || !to.trim()) throw busError('E_BAD_TARGET', 'to must be a non-empty string');
    const raw = to.trim();
    const seen = new Set();
    const targets = [];
    const push = (id, via) => {
      if (seen.has(id)) return;
      seen.add(id);
      targets.push({ sessionId: id, via });
    };

    if (raw.startsWith('@')) {
      const name = normalizeAlias(raw.slice(1));
      const aliases = loadAddressBook('aliases.json');
      const foundKey = Object.keys(aliases).find((key) => key.toLowerCase() === name);
      if (!foundKey) throw busError('E_UNKNOWN_TARGET', `unknown alias: ${raw}`);
      const value = aliases[foundKey];
      const id = typeof value === 'string' ? value : isPlainObject(value) ? value.sessionId : null;
      if (typeof id !== 'string') throw busError('E_BAD_ADDRESS_BOOK', `alias ${name} must map to a session id string`);
      push(normalizeSessionId(id, `alias ${name}`), `@${name}`);
      return targets;
    }

    if (raw.startsWith('#')) {
      const role = normalizeAlias(raw.slice(1));
      const roles = loadAddressBook('roles.json');
      const foundKey = Object.keys(roles).find((key) => key.toLowerCase() === role);
      if (!foundKey || !Array.isArray(roles[foundKey]) || roles[foundKey].length === 0) {
        throw busError('E_UNKNOWN_TARGET', `unknown or empty role: ${raw}`);
      }
      for (const member of roles[foundKey]) {
        if (typeof member !== 'string') throw busError('E_BAD_ADDRESS_BOOK', `role ${role} members must be strings`);
        push(normalizeSessionId(member, `role ${role}`), `#${role}`);
      }
      return targets;
    }

    push(normalizeSessionId(raw, 'to'), 'id');
    return targets;
  }

  function peerState(recipient, at) {
    if (!liveDir) return { state: 'unknown', live: false };
    const file = path.join(liveDir, `${recipient}.json`);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      return { state: error.code === 'ENOENT' ? 'missing' : 'corrupt', live: false };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'corrupt', live: true };
    const read = readJsonFile(file);
    if (!read.ok) return { state: 'corrupt', live: true };
    const row = read.value;
    const heartbeat = Date.parse(row.heartbeatAt ?? row.updatedAt ?? '');
    const ttl = Number(row.ttlMs);
    if (!Number.isFinite(heartbeat) || !Number.isFinite(ttl) || ttl <= 0) {
      return { state: 'corrupt', live: true };
    }
    const rowHost = typeof row.host === 'string' ? row.host.trim().toLowerCase() : '';
    const remote = rowHost !== '' && rowHost !== hostKey;
    const age = at - heartbeat;
    if (remote) {
      if (age > 4 * ttl) return { state: 'dead', remote: true, live: true };
      if (age > 2 * ttl) return { state: 'stale', remote: true, live: true };
      return { state: 'fresh', remote: true, live: true };
    }
    // Liveness on this host is decided by the pid first: a fresh heartbeat is
    // just a timestamp and can be forged (or left behind by a crash), while a
    // dead pid is positive evidence that nobody is reading the mailbox. If the
    // heartbeat check ran first, a forged fresh row would mask the dead pid and
    // send() would deliver into a mailbox nobody will ever poll.
    if (!pidAlive(Number(row.pid))) {
      return { state: 'dead', reason: 'pid', remote: false, live: true };
    }
    if (age <= ttl) return { state: 'fresh', declared: row.state, live: true };
    if (age > 4 * ttl) return { state: 'dead', reason: 'heartbeat', remote: false, live: true };
    if (age > 2 * ttl) return { state: 'stale', remote: false, live: true };
    return { state: 'stale', declared: row.state, remote: false, live: true };
  }

  function countPending(dir) {
    let count = 0;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) count += 1;
    }
    return count;
  }

  function quarantine(dir, file, reason) {
    try {
      const dead = ensureDirInside(root, path.join(dir, 'dead'));
      const base = path.basename(file).replace(/\.json$/i, '');
      let target = path.join(dead, `${base}.${reason}.json`);
      if (fs.existsSync(target)) {
        target = path.join(dead, `${base}.${reason}.${Date.now().toString(36)}.json`);
      }
      fs.renameSync(file, target);
    } catch {
      // Quarantine is best effort; the original file remains and is reported.
    }
  }

  function send(args = {}) {
    const from = normalizeSessionId(args.from ?? sessionId, 'from');
    if (sessionId && from !== sessionId) {
      throw busError('E_FROM_MISMATCH', `bus is bound to ${sessionId}, cannot send as ${from}`);
    }
    if (typeof args.body !== 'string' || args.body.length === 0) {
      throw busError('E_BAD_BODY', 'body must be a non-empty string');
    }
    if (codePointLength(args.body) > maxBodyChars) {
      throw busError('E_BODY_TOO_LARGE', `body exceeds ${maxBodyChars} code points`);
    }
    const kind = args.kind ?? 'note';
    if (!KINDS.includes(kind)) throw busError('E_BAD_KIND', `kind must be one of ${KINDS.join(', ')}`);
    const ttl = args.ttl === undefined ? DEFAULT_TTL_MS : Number(args.ttl);
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_MS) {
      throw busError('E_BAD_TTL', `ttl must be > 0 and <= ${MAX_TTL_MS}`);
    }
    let dedupKey;
    if (args.dedupKey !== undefined) {
      if (typeof args.dedupKey !== 'string' || args.dedupKey.length === 0
        || codePointLength(args.dedupKey) > 128) {
        throw busError('E_BAD_DEDUP_KEY', 'dedupKey must be a non-empty string of <= 128 code points');
      }
      dedupKey = args.dedupKey;
    }

    const targets = resolveTargets(args.to);
    const direct = !targets[0].via.startsWith('#');
    const allowDead = args.allowDead === true;
    const ts = nowMs();
    // A non-positive timestamp produces envelopes that are already expired
    // (poll drops `at > ts + ttl`) and breaks cursor math, so reject it at the
    // sender instead of writing a poison message.
    if (!Number.isFinite(ts) || ts <= 0) {
      throw busError('E_BAD_CLOCK', `now() must be a positive finite millisecond timestamp (got ${ts})`);
    }
    // A clock that is far ahead would mint a message no peer can see until the
    // skew elapses (P14): the receiver quarantines it and any cursor derived
    // from it jumps over real traffic. Refuse to write it in the first place.
    // `now()` is injectable and therefore can be wrong; Date.now() is the
    // independent wall-clock reference for this guard.
    const reference = referenceNowMs();
    if (reference !== null && ts > reference + maxClockSkewMs) {
      throw busError(
        'E_BAD_CLOCK',
        `timestamp ${ts} is ${ts - reference}ms ahead of the wall clock; maxClockSkewMs=${maxClockSkewMs}`,
      );
    }
    const results = [];
    const skipped = [];

    for (const target of targets) {
      const recipient = target.sessionId;
      const id = dedupKey ? dedupMessageId(from, recipient, dedupKey) : newMessageId(ts);
      const dir = ensureInbox(recipient);
      const file = path.join(dir, `${id}.json`);
      const ackedFile = path.join(dir, 'acked', `${id}.json`);

      // Dedup means "this dedupKey was already accepted", not "a pending copy
      // exists". A retry after the receiver acked must not resurrect the id:
      // the acked copy is the tombstone. Otherwise ack-then-retry recreated the
      // inbox file, and a later ack saw the acked copy, returned already:true
      // and left the new inbox copy pending forever (un-ackable until TTL).
      if (dedupKey && !fs.existsSync(file) && fs.existsSync(ackedFile)) {
        const prior = readJsonFile(ackedFile);
        if (!prior.ok) throw busError('E_CORRUPT_TARGET', `acked message is unreadable: ${id}`);
        if (prior.value.body !== args.body || prior.value.kind !== kind) {
          throw busError('E_DEDUP_CONFLICT', `dedupKey ${dedupKey} was already acked with a different body/kind`);
        }
        results.push({ to: recipient, id, deduped: true, acked: true, path: ackedFile });
        continue;
      }

      if (fs.existsSync(file)) {
        const existing = readJsonFile(file);
        if (!existing.ok) throw busError('E_CORRUPT_TARGET', `existing message is unreadable: ${id}`);
        const value = existing.value;
        if (value.body !== args.body || value.kind !== kind) {
          throw busError('E_DEDUP_CONFLICT', `dedupKey ${dedupKey} already used with a different body/kind`);
        }
        results.push({ to: recipient, id, deduped: true, path: file });
        continue;
      }

      const peer = peerState(recipient, ts);
      if (peer.remote) {
        if (direct) throw busError('E_REMOTE_HOST', `recipient ${recipient} lives on another host`);
        skipped.push({ to: recipient, reason: 'remote-host' });
        continue;
      }
      if (peer.state === 'dead' && !allowDead) {
        if (direct) throw busError('E_PEER_DEAD', `recipient ${recipient} is dead`);
        skipped.push({ to: recipient, reason: 'dead' });
        continue;
      }
      if (countPending(dir) >= maxPending) {
        if (direct) throw busError('E_BACKLOG_FULL', `inbox ${recipient} has ${maxPending} pending messages`);
        skipped.push({ to: recipient, reason: 'backlog' });
        continue;
      }

      const envelope = {
        v: BUS_SCHEMA_VERSION,
        id,
        from,
        to: recipient,
        kind,
        body: args.body,
        ts,
        ttl,
        host,
        ...(dedupKey === undefined ? {} : { dedupKey }),
      };
      const write = atomicWriteJson(file, envelope);
      if (write.exists) {
        // Our pre-check can lose a race with a receiver that acked the old copy
        // between then and the write. The acked tombstone wins.
        if (dedupKey && fs.existsSync(ackedFile)) {
          try { fs.unlinkSync(file); } catch { /* already gone */ }
          results.push({ to: recipient, id, deduped: true, acked: true, path: ackedFile });
          continue;
        }
        const again = readJsonFile(file);
        if (!again.ok) throw busError('E_CORRUPT_TARGET', `racing message is unreadable: ${id}`);
        if (again.value.body !== args.body || again.value.kind !== kind) {
          throw busError('E_DEDUP_CONFLICT', `dedupKey ${dedupKey} already used with a different body/kind`);
        }
        results.push({ to: recipient, id, deduped: true, path: file });
      } else if (dedupKey && fs.existsSync(ackedFile)) {
        // Close the ack-vs-retry race: ack may have moved the previous copy to
        // acked/ after the pre-check. Drop the fresh inbox copy we just wrote.
        try { fs.unlinkSync(file); } catch { /* ack already removed it */ }
        results.push({ to: recipient, id, deduped: true, acked: true, path: ackedFile });
      } else {
        results.push({ to: recipient, id, deduped: false, peerState: peer.state, path: file });
      }
    }

    if (results.length === 0) {
      throw busError('E_NO_LIVE_RECIPIENTS', 'no live recipient accepted the message');
    }
    return {
      ok: true,
      id: results[0].id,
      from,
      results,
      skipped,
      ...(skipped.length > 0 ? { partial: true } : {}),
    };
  }

  function resolveCursor(since, dir) {
    if (since === undefined || since === null) return { ts: -Infinity, id: '' };
    if (typeof since === 'number' && Number.isFinite(since)) return { ts: since, id: '' };
    if (typeof since !== 'string') throw busError('E_BAD_SINCE', 'since must be a number, ISO time, or message id');
    const text = since.trim();
    if (!text) throw busError('E_BAD_SINCE', 'since must not be empty');
    if (/^\d+$/.test(text)) return { ts: Number(text), id: '' };
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return { ts: parsed, id: '' };
    if (MESSAGE_ID_RE.test(text)) {
      for (const sub of ['', 'acked']) {
        const read = readJsonFile(path.join(dir, sub, `${text}.json`));
        if (read.ok && Number.isFinite(read.value.ts)) return { ts: read.value.ts, id: text };
      }
      const fromId = timestampFromMessageId(text);
      if (fromId !== null) return { ts: fromId, id: text };
      throw busError('E_BAD_SINCE', `cannot resolve message id: ${text}`);
    }
    throw busError('E_BAD_SINCE', 'since must be a number, ISO time, or message id');
  }

  function poll(args = {}) {
    const recipient = normalizeSessionId(args.sessionId ?? sessionId, 'sessionId');
    const dir = inboxPath(recipient);
    if (!fs.existsSync(dir)) {
      return {
        ok: true, sessionId: recipient, messages: [], cursor: args.since ?? null,
        scanned: 0, expired: 0, corrupt: 0, foreignHost: 0, futureTs: 0,
        futureCursor: false, hasMore: false,
      };
    }
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw busError('E_PATH_OUTSIDE_ROOT', `inbox is not a real directory: ${dir}`);
    }
    assertInside(root, fs.realpathSync.native(dir));

    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const at = nowMs();
    const cursor = resolveCursor(args.since, dir);
    // A cursor must never sit in the future: a single message with a poisoned
    // ts would otherwise make every later (real) message invisible. Reset the
    // filter to "replay everything pending" rather than clamping to `at`:
    // clamping forward would silently drop messages that are already queued
    // (at-least-once delivery; ack is idempotent, so a replay is safe).
    const futureCursor = Number.isFinite(cursor.ts) && cursor.ts > at + maxClockSkewMs;
    if (futureCursor) {
      cursor.ts = -Infinity;
      cursor.id = '';
    }
    let scanned = 0;
    let expired = 0;
    let corrupt = 0;
    let foreignHost = 0;
    let futureTs = 0;
    const found = [];

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const file = path.join(dir, name);
      let fileStat;
      try {
        fileStat = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
      scanned += 1;
      const read = readJsonFile(file);
      if (!read.ok) {
        corrupt += 1;
        quarantine(dir, file, 'corrupt');
        continue;
      }
      const expectedId = name.slice(0, -'.json'.length);
      const valid = validateEnvelope(read.value, recipient, maxBodyChars, expectedId);
      if (!valid.ok) {
        corrupt += 1;
        quarantine(dir, file, valid.reason === 'id-mismatch' ? 'id-mismatch' : 'corrupt');
        continue;
      }
      const message = valid.message;
      if (message.host.trim().toLowerCase() !== hostKey) {
        foreignHost += 1;
        quarantine(dir, file, 'foreign');
        continue;
      }
      // A timestamp far in the receiver's future is a clock-skew attack, not a
      // deliverable message: quarantine it so it cannot enter `found` (and so
      // cannot become the next cursor), but do not let it hide the inbox.
      if (message.ts > at + maxClockSkewMs) {
        futureTs += 1;
        quarantine(dir, file, 'future-ts');
        continue;
      }
      if (at > message.ts + message.ttl) {
        expired += 1;
        try { fs.unlinkSync(file); } catch { /* best effort */ }
        continue;
      }
      if (message.ts > cursor.ts || (message.ts === cursor.ts && message.id > cursor.id)) {
        found.push(message);
      }
    }

    found.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    const messages = found.slice(0, limit);
    // A message may legitimately be up to maxClockSkewMs (5 min) ahead of this
    // receiver's clock. Returning its id as the cursor would then hide every
    // later message with a smaller ts forever (P24): id cursors compare (ts,id),
    // and a smaller ts can never beat the ahead-of-clock ts. Clamp the cursor to
    // `at` instead, so the next poll replays the ahead-of-clock message
    // (at-least-once) together with anything that arrived with a normal ts.
    const cursorClamped = messages.some((message) => message.ts > at);
    return {
      ok: true,
      sessionId: recipient,
      messages,
      cursor: messages.length > 0
        ? (cursorClamped ? at : messages[messages.length - 1].id)
        : (futureCursor ? at : (args.since ?? null)),
      scanned,
      expired,
      corrupt,
      foreignHost,
      futureTs,
      futureCursor,
      hasMore: found.length > messages.length,
    };
  }

  function ack(id) {
    if (!sessionId) throw busError('E_NO_SESSION', 'ack requires a bus bound to a sessionId');
    if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id)) {
      throw busError('E_BAD_MESSAGE_ID', `invalid message id: ${id}`);
    }
    const dir = inboxPath(sessionId);
    if (!fs.existsSync(dir)) return { ok: false, code: 'E_NOT_FOUND', id };
    const ackedDir = ensureDirInside(root, path.join(dir, 'acked'));
    const source = path.join(dir, `${id}.json`);
    const target = path.join(ackedDir, `${id}.json`);
    // A copy may exist in both places after a crash between "target written"
    // and "source removed" (or when a dedup retry raced an ack). Once the
    // acked copy exists the message is consumed; leaving the inbox copy behind
    // would make it permanently pending while every ack returns already:true.
    const dropSource = () => {
      try { fs.unlinkSync(source); } catch { /* already gone */ }
    };
    if (fs.existsSync(target)) {
      dropSource();
      return { ok: true, already: true, id };
    }
    try {
      fs.renameSync(source, target);
      return { ok: true, already: false, id };
    } catch (error) {
      if (fs.existsSync(target)) {
        dropSource();
        return { ok: true, already: true, id };
      }
      if (error.code === 'ENOENT') return { ok: false, code: 'E_NOT_FOUND', id };
      throw busError('E_ACK_FAILED', `cannot ack ${id}: ${error.code || error.message}`);
    }
  }

  function writerFile() {
    return path.join(root, 'writer.lock');
  }

  function writerSeqFile() {
    return path.join(root, 'writer.seq');
  }

  function readWriterSeq() {
    const read = readJsonFile(writerSeqFile());
    if (!read.ok) return 0;
    const token = Number(read.value?.token);
    return Number.isSafeInteger(token) && token > 0 ? token : 0;
  }

  function rememberToken(token) {
    // writer.seq is a best-effort fence counter: it closes the window where the
    // old lock is already unlinked but a stale writer has not yet tried to
    // write. Identity itself comes from (holder, token, nonce) in the lock, so
    // losing a seq write cannot let an old holder back in.
    try { atomicWriteJson(writerSeqFile(), { schemaVersion: 1, token }); } catch { /* best effort */ }
  }

  function nextToken(record) {
    return Math.max(readWriterSeq(), Number(record?.token) || 0) + 1;
  }

  function writeLockRecord(record) {
    const file = writerFile();
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      try { fs.fsyncSync(fd); } catch { /* best effort */ }
    } finally {
      fs.closeSync(fd);
    }
    try {
      renameWithRetry(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* renamed */ }
    }
  }

  function commitLockFile() {
    return path.join(root, 'writer.commit.lock');
  }

  /**
   * Serialize every writer.lock mutation (claim/renew/release) and every
   * fenced commit with an O_EXCL lock file. The lock file carries the owner pid
   * and host so a crash can be recovered deterministically: a same-host dead pid
   * is stolen immediately, an unreadable/foreign lock after COMMIT_LOCK_STALE_MS.
   *
   * Reentrancy is deliberate: fencedWrite calls a test hook (and JSON.stringify,
   * which may run user toJSON) while holding the lock, and that code may
   * synchronously call claimWriter. JS is single-threaded, so the inner call
   * cannot interleave with the outer critical section; the outer commit still
   * revalidates the lease before renaming.
   */
  function withCommitLock(fn) {
    if (commitLocksHeldByProcess.has(root)) return fn();
    const lockFile = commitLockFile();
    // Per-acquisition identity. Stale reclaim unlinks this file and a new owner
    // recreates it; the old holder must be able to tell "still mine" from
    // "someone else's" before removing it (red-team P09).
    const ownerId = crypto.randomUUID();
    const deadline = Date.now() + COMMIT_LOCK_TIMEOUT_MS;
    let fd;
    for (;;) {
      try {
        fd = fs.openSync(lockFile, 'wx');
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw busError('E_LEASE_WRITE', `cannot create writer commit lock: ${error.code || error.message}`);
        }
        let stale = false;
        try {
          const read = readJsonFile(lockFile);
          if (read.ok) {
            const sameHost = String(read.value?.host ?? '').toLowerCase() === hostKey;
            if (sameHost && !pidAlive(Number(read.value?.pid))) stale = true;
          }
          if (!stale) stale = (Date.now() - fs.statSync(lockFile).mtimeMs) > COMMIT_LOCK_STALE_MS;
        } catch {
          // The owner is mid-create or just released; retry below.
          stale = false;
        }
        if (stale) {
          try { fs.unlinkSync(lockFile); } catch { /* raced */ }
          continue;
        }
        if (Date.now() >= deadline) {
          throw busError('E_LEASE_WRITE', 'writer commit lock is busy; another fenced write did not finish');
        }
        sleepSync(4);
      }
    }
    try {
      fs.writeFileSync(fd, `${JSON.stringify({
        pid: process.pid,
        host,
        at: new Date().toISOString(),
        ownerId,
      })}\n`, 'utf8');
      try { fs.fsyncSync(fd); } catch { /* best effort */ }
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
      throw busError('E_LEASE_WRITE', `cannot initialize writer commit lock: ${error.code || error.message}`);
    }
    fs.closeSync(fd);
    commitLocksHeldByProcess.add(root);
    try {
      return fn();
    } finally {
      commitLocksHeldByProcess.delete(root);
      releaseCommitLock(lockFile, ownerId);
    }
  }

  /**
   * Remove the commit lock only if this acquisition still owns it.
   *
   * Ownership can be lost inside the critical section: a reclaim may see our
   * mtime as older than COMMIT_LOCK_STALE_MS (slow hook, suspended process) or
   * read our pid as dead, unlink the file and install its own record. A blind
   * unlink in the finally would then delete the *new* owner's lock while that
   * process is still writing, letting a third writer in (P09). Comparing the
   * random ownerId closes that window; a lock we cannot prove is ours is left
   * to the normal stale-reclaim path (30s / dead pid), never removed here.
   */
  function releaseCommitLock(lockFile, ownerId) {
    const read = readJsonFile(lockFile);
    if (!read.ok || read.value?.ownerId !== ownerId) return;
    try { fs.unlinkSync(lockFile); } catch { /* raced with reclaim/removal */ }
  }

  /**
   * Read writer.lock fresh and prove this call still owns the lease. Runs
   * before serialization and again immediately before the rename; the second
   * read is the one that closes the P13 TOCTOU window.
   */
  function checkWriterLease(holder, args) {
    const read = readJsonFile(writerFile());
    if (!read.ok) throw busError('E_LEASE_LOST', 'no writer lease; claimWriter first');
    const record = read.value;
    const at = nowMs();
    const expires = Date.parse(record.expiresAt);
    if (!Number.isFinite(expires) || expires <= at) {
      throw busError('E_LEASE_LOST', 'writer lease has expired');
    }
    if (record.holder !== holder || args.token !== record.token) {
      throw busError('E_LEASE_LOST', 'writer lease belongs to another acquisition (fencing token mismatch)');
    }
    if (typeof args.nonce !== 'string' || args.nonce.length === 0 || args.nonce !== record.nonce) {
      throw busError('E_LEASE_AUTH', 'writer nonce mismatch');
    }
    if (String(record.host ?? '').toLowerCase() === hostKey && !pidAlive(Number(record.pid))) {
      throw busError('E_LEASE_LOST', 'writer process is gone');
    }
    return record;
  }

  function writerStatus() {
    const read = readJsonFile(writerFile());
    if (!read.ok) {
      return { ok: true, held: false, corrupt: read.error !== 'ENOENT' };
    }
    const record = read.value;
    const expires = Date.parse(record.expiresAt);
    const sameHost = String(record.host ?? '').toLowerCase() === hostKey;
    const alive = !sameHost || pidAlive(Number(record.pid));
    return {
      ok: true,
      held: Number.isFinite(expires) && expires > nowMs() && alive,
      holder: record.holder,
      token: record.token,
      expiresAt: record.expiresAt,
      ...(alive ? {} : { reason: 'pid' }),
    };
  }

  function claimWriter(args = {}) {
    const holder = normalizeSessionId(args.holder ?? sessionId, 'holder');
    if (sessionId && holder !== sessionId) {
      throw busError('E_FROM_MISMATCH', `bus is bound to ${sessionId}, cannot claim as ${holder}`);
    }
    const ttl = clampInt(args.ttlMs, DEFAULT_WRITER_TTL_MS, 1000, 86_400_000);
    return withCommitLock(() => {
      const file = writerFile();
      const at = nowMs();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const token = nextToken();
        const nonce = crypto.randomBytes(16).toString('hex');
        const payload = {
          schemaVersion: WRITER_SCHEMA_VERSION,
          holder,
          nonce,
          token,
          pid: process.pid,
          host,
          acquiredAt: new Date(at).toISOString(),
          expiresAt: new Date(at + ttl).toISOString(),
          ttlMs: ttl,
        };
        try {
          const fd = fs.openSync(file, 'wx');
          try {
            fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            try { fs.fsyncSync(fd); } catch { /* best effort */ }
          } finally {
            fs.closeSync(fd);
          }
          rememberToken(token);
          return { ok: true, holder, token, nonce, expiresAt: payload.expiresAt, created: true };
        } catch (error) {
          if (error.code !== 'EEXIST') {
            throw busError('E_LEASE_WRITE', `cannot create writer lock: ${error.code || error.message}`);
          }
          const read = readJsonFile(file);
          let stale;
          if (read.ok) {
            const record = read.value;
            const expires = Date.parse(record.expiresAt);
            const sameHost = String(record.host ?? '').toLowerCase() === hostKey;
            stale = !Number.isFinite(expires) || expires <= at || (sameHost && !pidAlive(Number(record.pid)));
            if (!stale) {
              if (record.holder === holder) {
                // Same-holder re-claim is a renewal, but it still has to prove
                // it owns this acquisition. Without the acquisition nonce, any
                // process that can read the lock (or guess the session id)
                // could extend the lease and receive the nonce back (P08).
                if (typeof args.nonce !== 'string' || args.nonce.length === 0) {
                  return { ok: false, holder, reason: 'auth', code: 'E_NONCE_REQUIRED' };
                }
                if (args.nonce !== record.nonce) {
                  return { ok: false, holder, reason: 'auth', code: 'E_LEASE_AUTH' };
                }
                const refreshed = {
                  ...record,
                  ttlMs: ttl,
                  expiresAt: new Date(at + ttl).toISOString(),
                };
                writeLockRecord(refreshed);
                return {
                  ok: true, holder, token: record.token, nonce: record.nonce,
                  expiresAt: refreshed.expiresAt, created: false, renewed: true,
                };
              }
              return { ok: false, holder: record.holder, expiresAt: record.expiresAt, reason: 'held' };
            }
            // Stale lock: advance the fence counter past the dead holder before
            // unlinking, so the next acquisition's token is strictly larger.
            rememberToken(nextToken(record));
          } else {
            let old = true;
            try { old = (at - fs.statSync(file).mtimeMs) > ttl; } catch { old = true; }
            if (!old) return { ok: false, reason: 'corrupt' };
          }
          try { fs.unlinkSync(file); } catch { /* another process may have won */ }
        }
      }
      return { ok: false, reason: 'race' };
    });
  }

  function renewWriter(args = {}) {
    const holder = normalizeSessionId(args.holder ?? sessionId, 'holder');
    if (sessionId && holder !== sessionId) {
      throw busError('E_FROM_MISMATCH', `bus is bound to ${sessionId}, cannot renew as ${holder}`);
    }
    return withCommitLock(() => {
      if (typeof args.nonce !== 'string' || args.nonce.length === 0) {
        return { ok: false, reason: 'bad-nonce' };
      }
      const read = readJsonFile(writerFile());
      if (!read.ok) return { ok: false, reason: 'no-lock' };
      const record = read.value;
      if (record.holder !== holder) return { ok: false, reason: 'not-holder', holder: record.holder };
      if (args.nonce !== record.nonce) return { ok: false, reason: 'bad-nonce' };
      if (args.token !== undefined && args.token !== record.token) {
        return { ok: false, reason: 'stale-token' };
      }
      const at = nowMs();
      const expires = Date.parse(record.expiresAt);
      if (!Number.isFinite(expires) || expires <= at) {
        return { ok: false, reason: 'expired', code: 'E_LEASE_LOST' };
      }
      if (String(record.host ?? '').toLowerCase() === hostKey && !pidAlive(Number(record.pid))) {
        return { ok: false, reason: 'pid', code: 'E_LEASE_LOST' };
      }
      const ttl = clampInt(args.ttlMs, Number(record.ttlMs) || DEFAULT_WRITER_TTL_MS, 1000, 86_400_000);
      const refreshed = { ...record, ttlMs: ttl, expiresAt: new Date(at + ttl).toISOString() };
      writeLockRecord(refreshed);
      return {
        ok: true, renewed: true, holder, token: record.token, nonce: record.nonce,
        expiresAt: refreshed.expiresAt,
      };
    });
  }

  function releaseWriter(args = {}) {
    const holder = normalizeSessionId(args.holder ?? sessionId, 'holder');
    if (sessionId && holder !== sessionId) {
      throw busError('E_FROM_MISMATCH', `bus is bound to ${sessionId}, cannot release as ${holder}`);
    }
    return withCommitLock(() => {
      const read = readJsonFile(writerFile());
      if (!read.ok) return { ok: true, released: false, reason: 'no-lock' };
      const record = read.value;
      if (record.holder !== holder) {
        return { ok: false, released: false, reason: 'not-holder', holder: record.holder };
      }
      // The nonce is issued once per acquisition and returned only in that
      // claimWriter result: knowing the session id is not enough to release or
      // steal another acquisition's lease.
      if (typeof args.nonce !== 'string' || args.nonce.length === 0 || args.nonce !== record.nonce) {
        return { ok: false, released: false, reason: 'bad-nonce' };
      }
      if (args.token !== undefined && args.token !== record.token) {
        return { ok: false, released: false, reason: 'stale-token' };
      }
      try {
        fs.unlinkSync(writerFile());
        return { ok: true, released: true, holder, token: record.token };
      } catch (error) {
        if (error.code === 'ENOENT') return { ok: true, released: false, reason: 'no-lock' };
        throw busError('E_LEASE_WRITE', `cannot release writer lock: ${error.code || error.message}`);
      }
    });
  }

  function fencedWrite(args = {}) {
    const holder = normalizeSessionId(args.holder ?? sessionId, 'holder');
    if (sessionId && holder !== sessionId) {
      throw busError('E_FROM_MISMATCH', `bus is bound to ${sessionId}, cannot write as ${holder}`);
    }
    if (typeof args.file !== 'string' || args.file.trim().length === 0) {
      throw busError('E_BAD_PATH', 'fencedWrite requires a file path');
    }
    if (args.value === undefined) throw busError('E_BAD_VALUE', 'fencedWrite requires a value');
    const target = path.isAbsolute(args.file)
      ? path.resolve(args.file)
      : path.resolve(root, args.file);
    // The root is lexically "inside" itself, so the jail below would accept it
    // while `dirname(target)` is the root's *parent*: the commit temp file would
    // be created outside the jail and only the rename would fail (P17). The root
    // and any existing directory are not file targets; refuse them up front.
    if (target === root) {
      throw busError('E_BAD_PATH', 'fencedWrite target must not be the bus root itself');
    }
    let targetStat = null;
    try {
      targetStat = fs.lstatSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw busError('E_PATH_OUTSIDE_ROOT', `cannot inspect fencedWrite target: ${error.code || error.message}`);
      }
    }
    if (targetStat && targetStat.isDirectory()) {
      throw busError('E_BAD_PATH', `fencedWrite target is a directory: ${target}`);
    }
    // Real path jail: assertInside is lexical, so a junction inside the root
    // would still let the write land outside. Resolve the nearest existing
    // ancestor and refuse anything whose real location escapes (P12).
    assertRealInsideRoot(root, target);

    // Everything below runs under one cross-process commit lock. The lock is
    // acquired before the first lease read, so a concurrent claimWriter cannot
    // change the lease between the checks and the rename. The lease is checked
    // again after JSON.stringify (which may run user toJSON code) and
    // immediately before the rename (P13).
    return withCommitLock(() => {
      const initial = checkWriterLease(holder, args);

      let text;
      try {
        const serialized = JSON.stringify(args.value, null, 2);
        if (typeof serialized !== 'string') {
          throw busError('E_BAD_VALUE', 'fencedWrite value is not JSON-serializable');
        }
        text = `${serialized}\n`;
      } catch (error) {
        if (error && error.busError) throw error;
        throw busError('E_BAD_VALUE', `fencedWrite value is not JSON-serializable: ${error?.message ?? error}`);
      }

      runHook('afterSerialize', { file: target, holder, token: initial.token });

      // Serialization can take arbitrarily long (toJSON). If the lease expired
      // or another acquisition took over in that window, abort before any byte
      // reaches a temp file.
      checkWriterLease(holder, args);
      // Re-resolve the real path inside the lock: the first check ran before
      // the lock, and a junction could have been swapped in meanwhile.
      assertRealInsideRoot(root, target);

      const dir = path.dirname(target);
      // target === root is rejected above, so dirname(target) is the root or
      // deeper; assert it anyway so a temp file can never be created outside
      // the jail even if that guard is ever loosened (P17).
      assertInside(root, dir);
      const temp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
      let fd;
      try {
        fd = fs.openSync(temp, 'wx');
        fs.writeFileSync(fd, text, 'utf8');
        try { fs.fsyncSync(fd); } catch { /* fsync is best effort */ }
        fs.closeSync(fd);
        fd = undefined;

        // Final gate, after the temp file is durable and immediately before the
        // rename. claim/renew/release share the commit lock, so no other
        // process can slip a takeover in between this read and renameWithRetry.
        const finalRecord = checkWriterLease(holder, args);
        renameWithRetry(temp, target);
        return { ok: true, file: target, holder, token: finalRecord.token };
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        try {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
        } catch { /* ignore */ }
        if (error && error.busError) throw error;
        throw busError('E_WRITE', `cannot write ${target}: ${error?.code || error?.message || error}`);
      }
    });
  }

  return {
    root,
    sessionId,
    host,
    liveDir,
    maxBodyChars,
    maxPending,
    send,
    poll,
    ack,
    peerState: (recipient, at = nowMs()) => peerState(normalizeSessionId(recipient, 'recipient'), at),
    claimWriter,
    renewWriter,
    releaseWriter,
    writerStatus,
    fencedWrite,
  };
}

export default createBus;
