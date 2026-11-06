// activity/store.js — the activity board's file layer (1.6.1).
//
// One append-only JSONL board for every session:
//   <memoryRoot>/.longlive/board/activity.jsonl
//   <memoryRoot>/.longlive/board/activity-YYYYMM.jsonl   (overflow archive)
//
// Every append is a read-modify-write under a cross-process lock, then an
// atomic tmp -> fsync -> read-back -> rename. That combination is what makes
// two sessions writing at the same time produce unique, contiguous seq values
// instead of a lost update. The recent window is bounded (500 rows by default);
// old rows move to the monthly archive in the same transition so the board
// never grows without limit.
//
// The store never throws on an IO failure: it returns {ok:false, code}. The
// caller (index.js) is required to swallow that and let the turn continue.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { privacyScan as defaultPrivacyScan } from '../recall/privacy.mjs';
import {
  ACTIVITY_KINDS,
  ACTIVITY_TEXT_MAX,
  DEDUPE_WINDOW,
  DISTILL_MIN_COUNT,
  DISTILL_TOTAL_COUNT,
  SIMILARITY_THRESHOLD,
  clip,
  distillActivityText,
  normalizeKey,
  normalizeText,
  oneLine,
  similarity,
} from './model.js';

export const ACTIVITY_SCHEMA_VERSION = 1;
export const ACTIVITY_BOARD_DIR = 'board';
export const ACTIVITY_FILE_NAME = 'activity.jsonl';
export const ACTIVITY_RECENT_MAX = 500;
export const ACTIVITY_LOCK_STALE_MS = 10000;
export const ACTIVITY_LOCK_TIMEOUT_MS = 2000;
export const ACTIVITY_SESSION_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Monotonic seq high-water mark: survives board deletion/compaction. */
export const ACTIVITY_SEQ_HIGH_WATER_FILE = '.activity.seq';
/** Written when the store detects the board was reset (deleted/emptied). */
export const ACTIVITY_RESET_MARKER_FILE = 'stream.reset.json';

const ARCHIVE_RE = /^activity-(\d{6})\.jsonl$/;

export function activityBoardDir(memoryRoot) {
  return path.join(String(memoryRoot ?? ''), '.longlive', ACTIVITY_BOARD_DIR);
}

export function activityBoardFile(memoryRoot) {
  return path.join(activityBoardDir(memoryRoot), ACTIVITY_FILE_NAME);
}

/** `<board>/.activity.seq` — the seq high-water sidecar (RE-R15.5). */
export function activitySeqHighWaterFile(memoryRoot) {
  return path.join(activityBoardDir(memoryRoot), ACTIVITY_SEQ_HIGH_WATER_FILE);
}

/** `<board>/stream.reset.json` — last detected board-reset evidence (RE-R15.5). */
export function activityResetMarkerFile(memoryRoot) {
  return path.join(activityBoardDir(memoryRoot), ACTIVITY_RESET_MARKER_FILE);
}

export function activityArchiveFile(memoryRoot, monthKey) {
  return path.join(activityBoardDir(memoryRoot), `activity-${monthKey}.jsonl`);
}

export function monthKeyFor(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) return '000000';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function countOf(entry) {
  const count = Number(entry?.count);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse JSONL defensively; bad lines are counted, never thrown. */
export function parseActivityJsonl(text) {
  const entries = [];
  let bad = 0;
  for (const line of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!isObject(row) || !Number.isInteger(row.seq) || typeof row.text !== 'string' || typeof row.sessionId !== 'string') {
      bad += 1;
      continue;
    }
    entries.push(row);
  }
  entries.sort((left, right) => left.seq - right.seq);
  return { entries, bad };
}

export function serializeActivityEntries(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '');
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* fall through: a busy loop is still bounded by the deadline */
  }
}

function writeTextDurable(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync is best effort on some filesystems */
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const readBack = fs.readFileSync(tmp, 'utf8');
      if (readBack !== text) throw new Error('activity write read-back mismatch');
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (attempt < 4) sleepSync(10 * (attempt + 1));
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  return { ok: false, error: lastError?.code ?? lastError?.message ?? 'E_WRITE' };
}

/** Atomic JSON write used by the per-session lastSeenSeq state. */
export function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const written = writeTextDurable(file, text);
    return written.ok ? { ok: true, file, bytes: Buffer.byteLength(text, 'utf8') } : written;
  } catch (error) {
    return { ok: false, file, error: error?.code ?? error?.message ?? 'E_WRITE' };
  }
}

export function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error?.code ?? 'E_READ' };
  }
}

/**
 * Write/read the whole recent board under `<board>/.activity.lock`. Returns
 * `{ok:false,code:'E_LOCK_TIMEOUT'}` instead of blocking a turn forever.
 */
function withLock(memoryRoot, fn) {
  const dir = activityBoardDir(memoryRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, code: 'E_MKDIR', message: error?.message ?? String(error) };
  }
  const lockFile = path.join(dir, '.activity.lock');
  const started = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, code: 'E_LOCK', message: error?.code ?? String(error) };
      }
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > ACTIVITY_LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        /* the other writer may have released it between open and stat */
      }
      if (Date.now() - started > ACTIVITY_LOCK_TIMEOUT_MS) {
        return { ok: false, code: 'E_LOCK_TIMEOUT' };
      }
      sleepSync(10);
    }
  }
  try {
    try {
      fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
    } catch {
      /* the lock file's existence is what matters */
    }
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      /* the stale lock expires on its own */
    }
  }
}

function readEntries(memoryRoot) {
  const file = activityBoardFile(memoryRoot);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, entries: [], bad: 0, exists: false };
    return { ok: false, code: error?.code ?? 'E_READ', entries: [], bad: 0, exists: false };
  }
  const parsed = parseActivityJsonl(text);
  return { ok: true, entries: parsed.entries, bad: parsed.bad, exists: true };
}

function archivedMaxSeq(memoryRoot) {
  let names = [];
  try {
    names = fs.readdirSync(activityBoardDir(memoryRoot));
  } catch {
    return 0;
  }
  const archives = names.filter((name) => ARCHIVE_RE.test(name)).sort().reverse();
  for (const name of archives) {
    const file = path.join(activityBoardDir(memoryRoot), name);
    try {
      const stat = fs.statSync(file);
      const readBytes = Math.min(stat.size, 128 * 1024);
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(readBytes);
      try {
        fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
      } finally {
        fs.closeSync(fd);
      }
      let text = buffer.toString('utf8');
      if (readBytes < stat.size) text = text.slice(text.indexOf('\n') + 1);
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const row = JSON.parse(lines[index]);
          if (Number.isInteger(row?.seq)) return row.seq;
        } catch {
          /* keep scanning backwards */
        }
      }
    } catch {
      /* try the previous archive month */
    }
  }
  return 0;
}

function nextSeq(entries, memoryRoot, floorSeq = 0) {
  let max = Number.isInteger(floorSeq) && floorSeq > 0 ? floorSeq : 0;
  for (const entry of entries) {
    if (Number.isInteger(entry.seq) && entry.seq > max) max = entry.seq;
  }
  if (max === 0) max = archivedMaxSeq(memoryRoot);
  return max + 1;
}

/** Read the seq high-water sidecar; 0 when absent/corrupt (best effort). */
export function readSeqHighWater(memoryRoot) {
  const read = readJsonFile(activitySeqHighWaterFile(memoryRoot));
  const value = read.ok ? read.value : null;
  return Number.isInteger(value?.seq) && value.seq > 0 ? value.seq : 0;
}

function persistSeqHighWater(memoryRoot, seq, at) {
  const current = readSeqHighWater(memoryRoot);
  if (seq <= current) return;
  try {
    writeJsonAtomic(activitySeqHighWaterFile(memoryRoot), { v: 1, seq, updatedAt: at });
  } catch {
    /* the board remains correct; only the reset protection degrades */
  }
}

function writeResetMarker(memoryRoot, marker) {
  try {
    writeJsonAtomic(activityResetMarkerFile(memoryRoot), marker);
  } catch {
    /* diagnostics only; the high-water sidecar is what prevents the stranding */
  }
}

/**
 * Pick the row a new activity should merge into. Window = the last 10 live rows
 * of this session; a distilled phase row is not a merge target (otherwise its
 * count could never grow into a new phase). Similarity is checked even when the
 * key differs, matching the spec's "key 相同或文本相似度≥0.8".
 */
export function selectDedupeTarget(entries, candidate, options = {}) {
  const windowSize = Number.isInteger(options.window) ? options.window : DEDUPE_WINDOW;
  const threshold = Number.isFinite(options.threshold) ? options.threshold : SIMILARITY_THRESHOLD;
  const sessionId = String(candidate?.sessionId ?? '');
  const key = normalizeKey(candidate?.key);
  const text = oneLine(candidate?.text);
  const rows = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && entry.sessionId === sessionId && entry.archived !== true,
  );
  const windowRows = rows.slice(-Math.max(1, windowSize));
  let best = null;
  for (const row of windowRows) {
    if (normalizeKey(row.key) === key) return { row, reason: 'key', score: 1 };
    const score = similarity(row.text, text);
    if (score >= threshold && (best === null || score > best.score)) best = { row, reason: 'similarity', score };
  }
  return best;
}

/**
 * Distillation plan for one session+key. Trigger: the newest live row with
 * that key was seen ≥3 times (count), or the key's active rows add up to ≥10.
 * A lone phase row is never re-distilled (it is already the compressed form).
 */
export function planDistillation(entries, options = {}) {
  const sessionId = String(options.sessionId ?? '');
  const key = normalizeKey(options.key);
  const active = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry
      && entry.sessionId === sessionId
      && entry.archived !== true
      && normalizeKey(entry.key) === key,
  );
  const normal = active.filter((entry) => entry.phase !== true);
  if (normal.length === 0) return null;
  const total = active.reduce((sum, entry) => sum + countOf(entry), 0);
  const newestNormalCount = Math.max(...normal.map(countOf));
  if (newestNormalCount < DISTILL_MIN_COUNT && total < DISTILL_TOTAL_COUNT) return null;
  const ordered = [...active].sort((left, right) => left.seq - right.seq);
  const last = ordered[ordered.length - 1];
  const kind = last.kind === 'blocked' || last.kind === 'done' ? last.kind : 'finding';
  const detail = last.last_text ?? last.text;
  const summary = {
    schemaVersion: ACTIVITY_SCHEMA_VERSION,
    seq: 0, // filled by append after nextSeq()
    sessionId,
    at: options.at ?? new Date().toISOString(),
    last_at: options.at ?? new Date().toISOString(),
    kind,
    text: distillActivityText(key, total, detail),
    last_text: clip(oneLine(detail), ACTIVITY_TEXT_MAX),
    key,
    norm: sha256Hex(normalizeText(detail)).slice(0, 16),
    dupOf: null,
    count: total,
    phase: true,
  };
  return { rows: active, summary };
}

/**
 * Keep the newest `recentMax` rows in activity.jsonl. Older rows are appended
 * to their local-month archive first; if any archive append fails, nothing is
 * dropped (a slightly long board is better than data loss).
 *
 * Recency is `seq` (a refresh bumps the merged row's seq). The physical array
 * order is NOT trusted: the caller may hand us a board that grew past the cap
 * (a previous archive append failed) where the just-refreshed row still sits at
 * its old physical position. Slicing by array position would archive that row —
 * and then a sibling's seq-only cursor could never see the newest action.
 */
function archiveOverflow(memoryRoot, entries, recentMax) {
  if (entries.length <= recentMax) return entries;
  const ordered = [...entries].sort((left, right) => (left?.seq ?? 0) - (right?.seq ?? 0));
  const keep = ordered.slice(ordered.length - recentMax);
  const drop = ordered.slice(0, ordered.length - recentMax);
  const groups = new Map();
  for (const row of drop) {
    const month = monthKeyFor(row.at);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(row);
  }
  try {
    fs.mkdirSync(activityBoardDir(memoryRoot), { recursive: true });
    for (const [month, rows] of groups) {
      fs.appendFileSync(activityArchiveFile(memoryRoot, month), serializeActivityEntries(rows), 'utf8');
    }
  } catch {
    return entries;
  }
  return keep;
}

/**
 * Create the activity store.
 *
 * options: memoryRoot (required), now(), recentMax, privacyScan(text).
 * append() is synchronous and serialized across processes by the lock.
 */
export function createActivityStore(options = {}) {
  const memoryRoot = typeof options.memoryRoot === 'string' && options.memoryRoot.trim() !== ''
    ? path.resolve(options.memoryRoot)
    : null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const privacyScan = typeof options.privacyScan === 'function' ? options.privacyScan : defaultPrivacyScan;
  const recentMax = Number.isInteger(options.recentMax) && options.recentMax > 0
    ? options.recentMax
    : ACTIVITY_RECENT_MAX;

  function read() {
    if (!memoryRoot) return { ok: false, code: 'E_NO_ROOT', entries: [], bad: 0, exists: false };
    return readEntries(memoryRoot);
  }

  /**
   * Append or merge one activity row.
   *
   * options.touchSeq: a merge still carries new information (a tool call moved
   *   on, a turn concluded). The default merge keeps seq stable — that is the
   *   rc.1 dedupe contract and the injection cursor was seq-only, which meant a
   *   sibling session saw the first row of a long turn and then nothing. With
   *   `touchSeq` the merged row takes `nextSeq()`, so every real refresh is
   *   strictly newer for `seq > lastSeenSeq`.
   * options.refreshText: replace the whole row text with the newest occurrence
   *   (event-level rows show the current action) instead of the default 「首条
   *   正文保留」 rule.
   *
   * Returns {ok, action:'appended'|'merged'|'refreshed'|'distilled', entry, seq,
   *          mergedSeq, seqBumped, archivedCount, streamReset, code}.
   *
   * Sequel monotonicity (RE-R15.5): every successful write persists the max seq
   * seen to `<board>/.activity.seq`, and new rows start above max(board, archive,
   * high-water). Deleting/emptying the board therefore does NOT restart seq at 1,
   * so a sibling's high `lastSeenSeq` cursor keeps working. If a reset is detected
   * (board missing/empty but a previous stream is known), a `stream.reset.json`
   * marker is written for diagnostics / consumer fallback.
   */
  function append(input = {}, options = {}) {
    if (!memoryRoot) return { ok: false, code: 'E_NO_ROOT' };
    const touchSeq = options.touchSeq === true;
    const refreshText = options.refreshText === true;
    const sessionId = String(input.sessionId ?? '').trim().toLowerCase();
    if (!ACTIVITY_SESSION_RE.test(sessionId)) return { ok: false, code: 'E_SESSION_ID' };
    const text = clip(oneLine(input.text), ACTIVITY_TEXT_MAX);
    if (text === '') return { ok: false, code: 'E_EMPTY_TEXT' };
    const kind = ACTIVITY_KINDS.includes(input.kind) ? input.kind : 'doing';
    const key = normalizeKey(input.key);
    const atDate = new Date(input.at ?? now());
    const at = Number.isFinite(atDate.getTime()) ? atDate.toISOString() : new Date().toISOString();

    // Reuse the privacy gate before anything touches disk: a local_only verdict
    // drops the row (board data is shared across sessions).
    try {
      const verdict = privacyScan(`${text}\n${key}`);
      if (!verdict || verdict.verdict === 'local_only') {
        return { ok: false, code: 'E_PRIVACY', skipped: true };
      }
    } catch {
      return { ok: false, code: 'E_PRIVACY', skipped: true };
    }

    return withLock(memoryRoot, () => {
      const current = readEntries(memoryRoot);
      if (!current.ok) return { ok: false, code: current.code };
      let entries = current.entries;
      // Seq floor: never go below the persisted high-water mark (board deletion
      // or compaction must not rewind seq for sibling cursors).
      const highWater = readSeqHighWater(memoryRoot);
      const seqFor = (list) => nextSeq(list, memoryRoot, highWater);
      let streamReset = null;
      if (entries.length === 0) {
        const archivedMax = archivedMaxSeq(memoryRoot);
        const previous = Math.max(highWater, archivedMax);
        if (previous > 0) {
          streamReset = {
            v: 1,
            at,
            reason: current.exists === false ? 'board-missing' : 'board-empty',
            previousHighWater: highWater,
            archivedMax,
          };
        }
      }
      const target = selectDedupeTarget(entries, { sessionId, key, text });
      let action = 'appended';
      let entry = null;
      let mergedSeq = null;
      let seqBumped = false;
      let archivedCount = 0;

      if (target) {
        const row = target.row;
        const previousSeq = row.seq;
        row.count = countOf(row) + 1;
        row.last_at = at;
        // The first text is kept for a normal row (spec). A phase row is the
        // generated compression, so it is refreshed with the newest occurrence:
        // 「阶段：…（N 次，最近 …）」 must show the current N and detail.
        row.kind = kind;
        if (row.phase === true) {
          row.last_text = text;
          row.text = distillActivityText(row.key, row.count, text);
          row.norm = sha256Hex(normalizeText(text)).slice(0, 16);
        } else if (refreshText) {
          // Event-level rows track the current action instead of the first one.
          row.text = text;
          row.norm = sha256Hex(normalizeText(text)).slice(0, 16);
        }
        if (touchSeq) {
          // A refresh must be newer than the reader's lastSeenSeq; bump before
          // the distillation plan so the phase row still gets a larger seq.
          row.seq = seqFor(entries);
          seqBumped = true;
          // Keep 「array order tracks recency」 for callers that slice the array
          // directly (archive overflow) — the row was just refreshed, so it
          // must not stay parked at its old physical position.
          const parkedAt = entries.indexOf(row);
          if (parkedAt >= 0 && parkedAt !== entries.length - 1) {
            entries.splice(parkedAt, 1);
            entries.push(row);
          }
        }
        entry = row;
        mergedSeq = previousSeq;
        action = touchSeq ? 'refreshed' : 'merged';
      } else {
        entry = {
          schemaVersion: ACTIVITY_SCHEMA_VERSION,
          seq: seqFor(entries),
          sessionId,
          at,
          last_at: at,
          kind,
          text,
          key,
          norm: sha256Hex(normalizeText(text)).slice(0, 16),
          dupOf: null,
          count: 1,
        };
        entries.push(entry);
        action = 'appended';
      }

      const plan = entry?.phase === true ? null : planDistillation(entries, { sessionId, key: entry.key, at });
      if (plan) {
        for (const row of plan.rows) row.archived = true;
        plan.summary.seq = seqFor(entries);
        entries.push(plan.summary);
        archivedCount = plan.rows.length;
        entry = plan.summary;
        action = 'distilled';
      }

      entries = archiveOverflow(memoryRoot, entries, recentMax);
      const written = writeTextDurable(activityBoardFile(memoryRoot), serializeActivityEntries(entries));
      if (!written.ok) return { ok: false, code: 'E_WRITE', message: written.error };
      // High-water sidecar: keeps seq monotonic even if this board is deleted or
      // truncated between now and the next write (RE-R15.5).
      const boardMax = entries.reduce(
        (max, row) => (Number.isInteger(row.seq) && row.seq > max ? row.seq : max),
        Number.isInteger(entry?.seq) ? entry.seq : 0,
      );
      persistSeqHighWater(memoryRoot, boardMax, at);
      if (streamReset) {
        writeResetMarker(memoryRoot, { ...streamReset, boardMax, firstSeq: entry.seq });
      }
      return {
        ok: true,
        action,
        entry,
        seq: entry.seq,
        mergedSeq,
        seqBumped,
        archivedCount,
        streamReset: streamReset !== null,
        recent: entries.length,
      };
    });
  }

  return {
    memoryRoot,
    boardFile: memoryRoot ? activityBoardFile(memoryRoot) : null,
    recentMax,
    read,
    append,
    highWater: () => readSeqHighWater(memoryRoot),
    resetMarkerFile: memoryRoot ? activityResetMarkerFile(memoryRoot) : null,
    nextSeq: (entries) => nextSeq(entries ?? read().entries ?? [], memoryRoot, readSeqHighWater(memoryRoot)),
  };
}
