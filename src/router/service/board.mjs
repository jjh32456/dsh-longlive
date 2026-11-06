// WP2 · L2 board builder (read-only projection).
//
// Inputs, in priority order:
//   1. live rows  `<memoryRoot>/.longlive/live/*.json`  (declared state, goal)
//   2. session metadata fallback (`ctx.get('sessions').list()` /
//      `sessionQuery.listSessions()`), state always `unknown` — never inferred.
//   3. proposal files under `<vault>/proposals/` (WP3 owns writing them; WP2 only
//      reads titles/counts, never transcripts).
//
// Outputs:
//   board.json            ≤ 8KB, stable logical `boardHash`
//   index/roster.json     per-session projection, source live|sessions|both
//
// boardHash deliberately excludes volatile rendered fields: only v, focus
// {sessionId,goal}, timeline {kind,ref,summary,at-minute}, counts and pending.

import fs from 'node:fs';
import path from 'node:path';

import { BOARD_MAX_BYTES, BOARD_VERSION, ROSTER_VERSION, isoOrNull, listJsonFiles, localDayKey, readJsonFile, sha256Hex, writeJsonAtomic } from './paths.mjs';
import { ACTIVE_STATE_SET, scanLiveRows } from './live.mjs';

export const BOARD_FILE_NAME = 'board.json';
export const ROSTER_FILE_NAME = 'roster.json';
export const FOCUS_GOAL_MAX = 80;
export const FOCUS_ACTION_KIND_MAX = 40;
export const FOCUS_ACTION_DETAIL_MAX = 60;
// A2: one-line conclusion per focus session (from A1's bridge marker, else the
// session's last_action.detail). Capped so one line cannot eat the hint budget.
export const LAST_CONCLUSION_MAX = 120;
export const TIMELINE_MAX = 8;
export const ROSTER_MAX = 256;

const STATE_PRIORITY = Object.freeze({ running: 0, blocked: 1, waiting: 2, idle: 3 });

function cleanText(value, maxChars) {
  let text = String(value ?? '')
    // Control chars and newlines would break the single-line hint format.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxChars && Array.from(text).length > maxChars) {
    text = `${Array.from(text).slice(0, Math.max(0, maxChars - 1)).join('')}…`;
  }
  return text;
}

/** Keep external text as data: wrap in 「」 and cap it. */
export function quoted(value, maxChars) {
  const text = cleanText(value, maxChars);
  return text === '' ? '（未声明）' : `「${text.replace(/[「」]/g, '')}」`;
}

export function truncateChars(value, maxChars) {
  const text = String(value ?? '');
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/**
 * L2 presence upgrade: a live row's `last_action`, reduced to exactly the
 * three fields the board may carry. The detail is truncated here and again at
 * render time; it is plugin-written tool metadata, never message text.
 */
export function focusActionOf(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = cleanText(value.kind, FOCUS_ACTION_KIND_MAX);
  const detail = cleanText(value.detail, FOCUS_ACTION_DETAIL_MAX);
  const at = isoOrNull(value.at);
  if (kind === '' && detail === '' && at === null) return null;
  return { kind, detail, at };
}

function queuedCountOf(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * A2: one conclusion string, or null. Accepts the bridge marker's
 * `lastConclusion` (an object carrying `text`) or a plain string; every other
 * shape (number, array, nested junk) is dropped instead of rendered.
 */
export function lastConclusionOf(value) {
  let raw = null;
  if (typeof value === 'string') raw = value;
  else if (value && typeof value === 'object' && typeof value.text === 'string') raw = value.text;
  if (raw === null) return null;
  const text = cleanText(raw, LAST_CONCLUSION_MAX);
  return text === '' ? null : text;
}

// A2 fallback: the live writer always fills a last_action, so lifecycle-only
// details must not surface as a "conclusion" in the hint.
const LIFECYCLE_DETAIL = /^(?:state=(?:idle|running|waiting|blocked)|turn\/end #\d+|turn\/start #\d+)$/;

/** A2: derive a conclusion from a live row's last_action (or null). */
export function conclusionFromAction(lastAction) {
  const detail = typeof lastAction?.detail === 'string' ? lastAction.detail : '';
  if (detail === '' || LIFECYCLE_DETAIL.test(detail)) return null;
  return lastConclusionOf(detail);
}

/** Read `.longlive/bridge/*.json` into Map<sessionId, conclusion text>. */
export function readBridgeConclusions(bridgeDir) {
  const map = new Map();
  if (typeof bridgeDir !== 'string' || bridgeDir === '') return map;
  for (const file of listJsonFiles(bridgeDir)) {
    const read = readJsonFile(file);
    if (!read.ok || !read.value || typeof read.value !== 'object') continue;
    const sessionId = sessionIdFrom(read.value);
    if (!sessionId) continue;
    const text = lastConclusionOf(read.value.lastConclusion);
    if (text !== null) map.set(sessionId, text);
  }
  return map;
}

function sessionIdFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = value.sessionId ?? value.id ?? value.header?.id ?? value.session?.header?.id;
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) return null;
  return id;
}

export function normalizeMetadataList(raw) {
  if (!raw) return null;
  const list = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw.sessions) ? raw.sessions
      : (Array.isArray(raw.items) ? raw.items : (Array.isArray(raw.list) ? raw.list : null)));
  if (!list) return null;
  const sessions = [];
  for (const item of list) {
    const sessionId = sessionIdFrom(item);
    if (!sessionId) continue;
    const header = item.header ?? item.session?.header ?? {};
    sessions.push({
      sessionId,
      origin: header.origin ?? item.origin ?? null,
      parentSession: header.parentSession ?? header.parentSessionId ?? item.parentSession ?? null,
      isSeeded: header.isSeeded === true || item.isSeeded === true,
      seenAt: isoOrNull(header.updatedAt ?? item.updatedAt ?? item.lastActiveAt ?? header.createdAt ?? item.createdAt),
    });
  }
  return sessions;
}

/** Dual-source roster metadata; returns null when the host exposes neither source. */
export async function listSessionMetadata(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null;
  const get = async (key) => {
    try { return await ctx.get(key); } catch { return null; }
  };
  const calls = [];
  const sessions = await get('sessions');
  if (sessions && typeof sessions.list === 'function') calls.push(() => sessions.list());
  const query = await get('sessionQuery');
  if (query && typeof query.listSessions === 'function') calls.push(() => query.listSessions());
  for (const call of calls) {
    try {
      const list = normalizeMetadataList(await call());
      if (list) return list;
    } catch { /* try the next source */ }
  }
  return null;
}

/** Read proposal files defensively; WP3 owns the real schema. */
export function readProposalSummaries(proposalsDir) {
  const dirs = [proposalsDir, proposalsDir ? path.join(proposalsDir, 'queue') : null];
  const items = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const file of listJsonFiles(dir)) {
      const read = readJsonFile(file);
      if (!read.ok || !read.value || typeof read.value !== 'object') continue;
      const raw = read.value.proposal && typeof read.value.proposal === 'object' ? read.value.proposal : read.value;
      const id = cleanText(raw.id ?? raw.proposalId ?? path.basename(file, '.json'), 60);
      const status = cleanText(raw.status ?? '', 20).toLowerCase();
      if (!id || !status) continue;
      items.push({
        id,
        status,
        title: cleanText(raw.title ?? raw.summary ?? raw.goal ?? '', 60),
        at: isoOrNull(raw.appliedAt ?? raw.updatedAt ?? raw.createdAt),
      });
    }
  }
  return items;
}

function proposalCounts(items) {
  const approved = items.filter((item) => item.status === 'approved');
  const ready = items.filter((item) => item.status === 'approved' || item.status === 'ready');
  const queued = items.filter((item) => item.status === 'pending' || item.status === 'queued' || item.status === 'open');
  const blocked = items.filter((item) => item.status === 'blocked');
  const applied = items
    .filter((item) => item.status === 'applied' || item.status === 'done')
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return {
    approved: approved.length,
    ready: ready.length,
    queued: queued.length,
    blocked: blocked.length,
    applied,
    lastApplyAt: applied[0]?.at ?? null,
  };
}

export function boardHashOf(board) {
  const canonical = {
    v: BOARD_VERSION,
    // Presence upgrade: the action and queue size are logical inputs too, so a
    // changed tool action invalidates the hint dedupe hash on the next turn.
    focus: (board.focus ?? []).map((item) => ({
      sessionId: item.sessionId,
      goal: item.goal,
      lastAction: item.lastAction && typeof item.lastAction === 'object'
        ? {
          kind: item.lastAction.kind ?? null,
          detail: item.lastAction.detail ?? null,
          at: item.lastAction.at ?? null,
        }
        : null,
      queuedCount: Number.isInteger(item.queuedCount) ? item.queuedCount : 0,
      // A2: a changed conclusion must invalidate the hint dedupe hash.
      lastConclusion: typeof item.lastConclusion === 'string' ? item.lastConclusion : null,
    })),
    timeline: (board.timeline ?? []).map((item) => ({
      kind: item.kind ?? null,
      ref: item.ref ?? null,
      summary: item.summary ?? null,
      at: typeof item.at === 'string' ? item.at.slice(0, 16) : null,
    })),
    counts: {
      active: board.counts?.active ?? 0,
      running: board.counts?.running ?? 0,
      blocked: board.counts?.blocked ?? 0,
      queuedProposals: board.counts?.queuedProposals ?? 0,
      blockedOnUser: board.counts?.blockedOnUser ?? 0,
      readyProposals: board.counts?.readyProposals ?? 0,
    },
    pending: {
      count: board.pending?.count ?? 0,
      ticket: board.pending?.ticket ?? null,
    },
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function boardHashPrefixed(board) {
  return `sha256:${boardHashOf(board)}`;
}

/** The on-disk shape is exactly DESIGN §3.2; in-memory extras never leak. */
function persistedBoard(board) {
  return {
    v: board.v,
    seq: board.seq,
    generatedAt: board.generatedAt,
    source: board.source,
    focus: board.focus,
    timeline: board.timeline,
    pulse: board.pulse,
    warnings: board.warnings,
    hash: board.hash,
  };
}

function serializeBoard(board) {
  return `${JSON.stringify(persistedBoard(board), null, 2)}\n`;
}

function fitBoard(board) {
  let text = serializeBoard(board);
  if (Buffer.byteLength(text, 'utf8') <= BOARD_MAX_BYTES) return { text, truncated: false };
  board.warnings = Array.isArray(board.warnings) ? board.warnings : [];
  if (!board.warnings.includes('BOARD_TRUNCATED')) board.warnings.push('BOARD_TRUNCATED');
  let guard = 512;
  while (Buffer.byteLength(text, 'utf8') > BOARD_MAX_BYTES && guard > 0) {
    guard -= 1;
    if (board.timeline.length > 0) {
      board.timeline.pop();
    } else if (board.focus.length > 1) {
      board.focus.pop();
    } else if (board.warnings.length > 1) {
      const index = board.warnings.findIndex((code) => code !== 'BOARD_TRUNCATED');
      if (index >= 0) board.warnings.splice(index, 1);
      else board.warnings.length = 1;
    } else if (board.focus.length === 1 && Array.from(board.focus[0].goal).length > 20) {
      board.focus[0].goal = truncateChars(board.focus[0].goal, 20);
    } else if (board.focus.length === 1 && board.focus[0].lastAction
      && Array.from(board.focus[0].lastAction.detail ?? '').length > 12) {
      board.focus[0].lastAction.detail = truncateChars(board.focus[0].lastAction.detail, 12);
    } else if (board.focus.length === 1 && typeof board.focus[0].lastConclusion === 'string'
      && Array.from(board.focus[0].lastConclusion).length > 24) {
      board.focus[0].lastConclusion = truncateChars(board.focus[0].lastConclusion, 24);
    } else {
      break;
    }
    text = serializeBoard(board);
  }
  return { text, truncated: true };
}

export function createBoardBuilder(options = {}) {
  const memoryRoot = options.memoryRoot ?? null;
  const config = options.config ?? {};
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const paths = options.paths ?? {};
  const boardFile = paths.boardFile ?? null;
  const rosterFile = paths.rosterFile ?? null;
  const proposalsDir = paths.proposalsDir ?? null;
  // A2 reads the same markers A1 writes. `paths.bridgeDir` is the router path
  // module's value; tests may pass only a memoryRoot, so derive it too.
  const bridgeDir = paths.bridgeDir
    ?? (memoryRoot ? path.join(memoryRoot, '.longlive', 'bridge') : null);
  const maxSessions = Number.isInteger(config.boardMaxSessions) ? config.boardMaxSessions : 5;
  const maxRows = Number.isInteger(config.liveRowsMax) ? config.liveRowsMax : 128;
  let seq = options.seq ?? 0;

  function build(args = {}) {
    const at = now();
    const generatedAt = isoOrNull(at);
    const scan = scanLiveRows({ memoryRoot, now: at });
    const warnings = [];
    if (!scan.ok) warnings.push('LIVE_UNREADABLE');
    if (args.saturated === true) warnings.push('LIVE_ROWS_SATURATED');

    const metadata = Array.isArray(args.metadata) ? args.metadata : null;
    const metaMap = new Map();
    for (const item of metadata ?? []) metaMap.set(item.sessionId, item);

    const liveEntries = scan.entries.filter((entry) => !entry.corrupt && entry.sessionId);
    const liveMap = new Map(liveEntries.map((entry) => [entry.sessionId, entry]));
    const liveCount = liveEntries.length;

    const roster = [];
    for (const entry of liveEntries) {
      const meta = metaMap.get(entry.sessionId) ?? null;
      roster.push({
        sessionId: entry.sessionId,
        source: meta ? 'both' : 'live',
        effectiveState: entry.effectiveState,
        state: entry.state ?? null,
        seenAt: isoOrNull(entry.heartbeatAt),
        unknown: false,
        origin: meta?.origin ?? null,
      });
    }
    for (const meta of metaMap.values()) {
      if (liveMap.has(meta.sessionId)) continue;
      roster.push({
        sessionId: meta.sessionId,
        source: 'sessions',
        effectiveState: 'unknown',
        state: null,
        seenAt: meta.seenAt ?? null,
        unknown: true,
        origin: meta.origin ?? null,
      });
    }
    roster.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (roster.length > ROSTER_MAX) roster.length = ROSTER_MAX;

    const unknownSessions = roster.filter((item) => item.unknown === true && item.origin !== 'subagent').length;
    const activeEntries = liveEntries.filter((entry) => ACTIVE_STATE_SET.has(entry.effectiveState) && !isSubagent(entry, metaMap));
    // A live row we can see but cannot decode still proves a session exists.
    // DESIGN §9 counts such a row as active (state unknown), while a zero-byte
    // file is an interrupted write and is ignored (and later cleaned).
    const unreadableActive = scan.entries.filter((entry) => entry.corrupt === true
      && entry.sessionId
      && !isSubagent(entry, metaMap)
      && fileHasBytes(entry.file)).length;
    // Subagents are counted only in counts.subagents: they never inflate
    // activeSessions/unknownSessions and never appear in focus.
    const allActive = activeEntries.length + unreadableActive;
    if (activeEntries.length > Math.max(1, maxSessions)) warnings.push('FOCUS_LIMITED');
    const running = liveEntries.filter((entry) => entry.state === 'running').length;
    const blocked = liveEntries.filter((entry) => entry.state === 'blocked').length;
    const subagents = roster.filter((item) => item.origin === 'subagent').length;

    const proposals = readProposalSummaries(proposalsDir);
    const countsProposals = proposalCounts(proposals);
    const conclusions = readBridgeConclusions(bridgeDir);

    const focus = activeEntries
      .map((entry) => {
        const goalText = cleanText(entry.goal ?? '', FOCUS_GOAL_MAX);
        const lastAction = focusActionOf(entry.last_action);
        // A2: A1's conclusion wins; otherwise share the live row's last action
        // detail (already capped to 60 chars), skipping lifecycle-only noise.
        const conclusion = conclusions.get(entry.sessionId)
          ?? conclusionFromAction(lastAction);
        return {
          sessionId: entry.sessionId,
          goal: goalText || '（未声明）',
          updatedAt: isoOrNull(entry.heartbeatAt),
          lastAction,
          lastConclusion: lastConclusionOf(conclusion),
          queuedCount: queuedCountOf(entry.queued),
          state: entry.effectiveState,
          declared: goalText !== '',
        };
      })
      .sort((a, b) => {
        // DESIGN §3.2: declared goal → running → freshest heartbeat.
        if (a.declared !== b.declared) return a.declared ? -1 : 1;
        const pa = STATE_PRIORITY[a.state] ?? 9;
        const pb = STATE_PRIORITY[b.state] ?? 9;
        if (pa !== pb) return pa - pb;
        return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
          || a.sessionId.localeCompare(b.sessionId);
      })
      .slice(0, Math.max(1, maxSessions))
      .map((item) => ({
        sessionId: item.sessionId,
        goal: item.goal,
        updatedAt: item.updatedAt,
        lastAction: item.lastAction,
        lastConclusion: item.lastConclusion,
        queuedCount: item.queuedCount,
      }));

    const timeline = countsProposals.applied
      .filter((item) => item.title !== '')
      .slice(0, TIMELINE_MAX)
      .map((item) => ({
        kind: 'proposal.applied',
        ref: item.id,
        summary: item.title,
        at: item.at,
      }));

    const pulse = {
      active: allActive,
      running,
      blocked,
      unknownSessions,
      queuedProposals: countsProposals.queued,
      approvedProposals: countsProposals.approved,
      blockedOnUser: countsProposals.blocked,
      readyProposals: countsProposals.ready,
      queueHead: null,
      lease: null,
      lastApplyAt: countsProposals.lastApplyAt,
    };

    const board = {
      v: BOARD_VERSION,
      seq: seq + 1,
      generatedAt,
      source: {
        liveRows: liveCount,
        proposals: proposals.length,
        scanMs: Math.max(0, Date.now() - at.getTime()),
      },
      focus,
      timeline,
      pulse,
      warnings,
      hash: null,
      // In-memory-only projections used by the Router status; the file written
      // to disk is trimmed to the DESIGN §3.2 shape in write().
      activeSessions: allActive,
      unknownSessions,
      focusVisible: focus.length,
      stale: false,
      counts: {
        active: allActive,
        running,
        blocked,
        queuedProposals: countsProposals.queued,
        blockedOnUser: countsProposals.blocked,
        readyProposals: countsProposals.ready,
        subagents,
      },
      pending: { count: countsProposals.ready, ticket: null },
    };
    board.boardHash = boardHashOf(board);
    board.hash = `sha256:${sha256Hex(JSON.stringify({
      v: board.v,
      seq: board.seq,
      generatedAt: board.generatedAt,
      source: board.source,
      focus: board.focus,
      timeline: board.timeline,
      pulse: board.pulse,
      warnings: board.warnings,
    }))}`;

    const shared = {
      hintTokensLast: 0,
      injectedTurns: 0,
      injectedTokensToday: 0,
      skipped: 0,
      readyProposals: countsProposals.ready,
      lastInjectAt: null,
      lastInjectSha256: null,
      liveRows: liveCount,
      unknownSessions,
      maxRows,
      saturated: args.saturated === true,
      day: localDayKey(at),
    };

    const live = {
      rows: liveCount,
      maxRows,
      unknown: unknownSessions,
      saturated: args.saturated === true,
      corrupt: scan.counts?.corrupt ?? 0,
      warnings,
    };

    return { board, roster, shared, live, boardHash: board.boardHash };
  }

  function write(snapshot) {
    if (!boardFile) return { ok: false, code: 'E_NO_BOARD_PATH' };
    const board = { ...snapshot.board };
    cleanBoardTmp(boardFile, now().getTime());
    // build() already reserved the next seq; write must not advance it twice.
    seq = Math.max(seq, Number.isInteger(board.seq) ? board.seq : 0);
    board.seq = seq;
    const fit = fitBoard(board);
    // The persisted hash must describe what is actually on disk, including a
    // truncated timeline/focus, so recompute it after the fit pass.
    const hashed = persistedBoard(board);
    delete hashed.hash;
    board.hash = `sha256:${sha256Hex(JSON.stringify(hashed))}`;
    let result = writeJsonAtomic(boardFile, persistedBoard(board));
    if (result.ok) {
      // DESIGN §3.2 read-back: parse, then verify hash and seq. One retry.
      const check = verifyBoardWrite(boardFile, board);
      if (!check.ok) result = writeJsonAtomic(boardFile, persistedBoard(board));
    }
    if (!result.ok) return { ok: false, code: result.error ?? 'E_BOARD_WRITE' };
    let rosterWritten = null;
    if (rosterFile) {
      const roster = {
        v: ROSTER_VERSION,
        generatedAt: board.generatedAt,
        source: board.source,
        counts: board.counts,
        sessions: snapshot.roster,
      };
      rosterWritten = writeJsonAtomic(rosterFile, roster);
    }
    return {
      ok: true,
      board,
      bytes: Buffer.byteLength(fit.text, 'utf8'),
      truncated: fit.truncated,
      rosterOk: rosterWritten ? rosterWritten.ok === true : false,
    };
  }

  function read() {
    if (!boardFile) return null;
    const read = readJsonFile(boardFile);
    return read.ok ? read.value : null;
  }

  return {
    build,
    write,
    read,
    // Orphan temp cleanup is useful even when sharedBoard is off: a stale
    // board.json.tmp-* from a previous run must not survive a tick (J-05/L-02).
    cleanTmp: () => {
      if (boardFile) cleanBoardTmp(boardFile, now().getTime());
    },
    get seq() { return seq; },
    boardFile,
    rosterFile,
  };
}

function fileHasBytes(file) {
  try {
    return typeof file === 'string' && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function cleanBoardTmp(boardFile, nowMs) {
  if (!boardFile) return 0;
  const dir = path.dirname(boardFile);
  const prefix = `${path.basename(boardFile)}.tmp-`;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(dir, name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs > 60 * 60 * 1000) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch { /* a concurrent writer may have renamed it already */ }
  }
  return removed;
}

function isSubagent(entry, metaMap) {
  const meta = metaMap.get(entry.sessionId);
  return meta?.origin === 'subagent';
}

function verifyBoardWrite(file, board) {
  const read = readJsonFile(file);
  if (!read.ok) return { ok: false };
  return {
    ok: read.value?.seq === board.seq && read.value?.hash === board.hash,
  };
}

/** Format one focus row for the fixed hint template. */
export function renderFocusLine(item) {
  return `- ${item.sessionId} ${item.state ?? ''} · 目标${quoted(item.goal, FOCUS_GOAL_MAX)} · ${timeOf(item.updatedAt)}`;
}

export function timeOf(iso) {
  if (typeof iso !== 'string' || iso.length < 16) return '--:--';
  return iso.slice(11, 16);
}
