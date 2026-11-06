// WP6 · L4 merge (DESIGN §2.4/§5.8, K20).
//
// Two distinct things share the "L4 merge" name:
//   1. Small-write coalescing (§5.8): deterministic, always on. Two adjacent
//      queued proposals for the same op+target merge when each segment is
//      <=2KB and the result is <=4KB. The later proposal is absorbed into the
//      earlier one and marked superseded; it is never split back automatically.
//   2. The daily L4c journal fold (§2.4): LLM-assisted, gated by
//      routerL4MergeEnabled (default false). This module only exposes a pure
//      planner so the tick can stay mockable and the disabled path has zero
//      side effects.
//
// Everything here is pure: no fs, no clock, no audit. The proposal engine
// performs the two file writes and the audit row.

import crypto from 'node:crypto';

import { localDayKey } from './paths.mjs';

export const SMALL_WRITE_SEGMENT_MAX_BYTES = 2048;
export const SMALL_WRITE_MERGED_MAX_BYTES = 4096;
export const SMALL_WRITE_SEPARATOR = '\n\n---\n\n';

export const L4_MERGE_AFTER_HOUR = 4;
export const L4_MIN_ROUNDS = 3;
export const L4_MAX_PER_SESSION_PER_DAY = 1;
export const L4_MAX_PER_DAY = 5;
export const L4_CONTENT_MAX_CHARS = 600;

function sha256Hex(text) {
  // Kept local to avoid importing proposals.mjs (that module imports this one).
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalizeContentForHash(content) {
  return String(content ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n');
}

function dedupeKeyFor(op, target, content) {
  return `sha256:${sha256Hex(`${op}\u0000${target}\u0000${normalizeContentForHash(content)}`)}`;
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function sameSha(left, right) {
  const normalize = (value) => {
    if (typeof value !== 'string' || value === '') return null;
    return value.startsWith('sha256:') ? value.slice(7) : value;
  };
  return normalize(left) === normalize(right);
}

function truncated(text, maxChars) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

/**
 * Decide whether two proposals may coalesce. Every clause is required
 * (DESIGN §5.8): same target, same op, same mergeKey, queue-adjacent, each
 * segment <=2KB, merged <=4KB, and both baseShas still match the target.
 *
 * `currentSha` is optional for pure tests; production always passes it. A null
 * currentSha is a legitimate "target does not exist yet" snapshot (journal
 * append), so null===null passes the revalidation.
 */
export function canMergeSmallWrite(previous, next, { adjacent = true, currentSha = undefined } = {}) {
  const no = (code, extra = {}) => ({ ok: false, code, reason: code, ...extra });
  if (!previous || !next) return no('missing-proposal');
  if (previous.status !== 'pending' || next.status !== 'pending') return no('not-pending');
  if (!previous.queue?.ticket || !next.queue?.ticket) return no('missing-ticket');
  if (previous.id && next.id && previous.id === next.id) return no('same-proposal');
  if (previous.target !== next.target) return no('target-mismatch');
  if (previous.op !== next.op) return no('op-mismatch');
  if (!previous.mergeKey || previous.mergeKey !== next.mergeKey) return no('merge-key-mismatch');
  if (adjacent !== true) return no('not-adjacent');
  if (typeof previous.content !== 'string' || typeof next.content !== 'string') return no('content-missing');
  if (currentSha !== undefined
    && (!sameSha(previous.baseSha, currentSha) || !sameSha(next.baseSha, currentSha))) {
    return no('base-moved');
  }
  const previousBytes = byteLength(previous.content);
  const nextBytes = byteLength(next.content);
  if (previousBytes > SMALL_WRITE_SEGMENT_MAX_BYTES || nextBytes > SMALL_WRITE_SEGMENT_MAX_BYTES) {
    return no('segment-too-large', { previousBytes, nextBytes, limit: SMALL_WRITE_SEGMENT_MAX_BYTES });
  }
  const content = `${previous.content}${SMALL_WRITE_SEPARATOR}${next.content}`;
  const bytes = byteLength(content);
  if (bytes > SMALL_WRITE_MERGED_MAX_BYTES) {
    return no('merged-too-large', { previousBytes, nextBytes, bytes, limit: SMALL_WRITE_MERGED_MAX_BYTES });
  }
  return { ok: true, content, bytes, previousBytes, nextBytes };
}

/**
 * Build the keeper/absorbed pair. The keeper keeps its ticket and gains the
 * absorbed body (first segment first); the absorbed proposal becomes
 * `superseded` and points back with queue.mergedInto. `dedupeKey` is recomputed
 * for the merged body, which is the §5.8 "afterSha" obligation for this store.
 */
export function planSmallWriteMerge(previous, next, { at = null, adjacent = true, currentSha = undefined } = {}) {
  const check = canMergeSmallWrite(previous, next, { adjacent, currentSha });
  if (!check.ok) return check;
  const stamp = at ?? new Date().toISOString();
  const keeper = {
    ...previous,
    content: check.content,
    dedupeKey: dedupeKeyFor(previous.op, previous.target, check.content),
    rev: (Number(previous.rev) || 0) + 1,
    updatedAt: stamp,
    stateLog: [
      ...(Array.isArray(previous.stateLog) ? previous.stateLog : []),
      {
        at: stamp,
        from: 'pending',
        to: 'pending',
        by: 'router-merge',
        note: `merged-in:${next.queue.ticket}`,
      },
    ],
  };
  const absorbed = {
    ...next,
    status: 'superseded',
    rev: (Number(next.rev) || 0) + 1,
    updatedAt: stamp,
    queue: {
      ...next.queue,
      mergedInto: previous.id,
      supersededBy: previous.id,
    },
    stateLog: [
      ...(Array.isArray(next.stateLog) ? next.stateLog : []),
      {
        at: stamp,
        from: 'pending',
        to: 'superseded',
        by: 'router-merge',
        note: `merged-into:${previous.queue.ticket}`,
      },
    ],
  };
  return {
    ok: true,
    keeper,
    absorbed,
    keeperId: previous.id,
    keeperTicket: previous.queue.ticket,
    absorbedId: next.id,
    absorbedTicket: next.queue.ticket,
    bytes: check.bytes,
    previousBytes: check.previousBytes,
    nextBytes: check.nextBytes,
  };
}

/**
 * Pure L4c planner. Returns proposal *inputs* (the caller proposes them); it
 * never reads the memory tree and never calls a model. Disabled is an exact
 * no-op: no clock use beyond the caller's Date, no audit, no writes.
 *
 * `sessions` entries: { sessionId, goal, roundsSinceLastMerge, isSubagent,
 * parentSessionId }. `proposals` entries: { id, origin:{sessionId}, title,
 * queue:{ticket} }. `state`: { day, count, sessions:{ [sessionId]:{ day } } }.
 */
export function planL4Merge({ enabled = false, now = new Date(), sessions = [], proposals = [], state = {} } = {}) {
  if (enabled !== true) return { ok: true, enabled: false, proposals: [], reason: 'disabled' };
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) return { ok: true, enabled: true, proposals: [], reason: 'invalid-clock' };
  if (at.getHours() < L4_MERGE_AFTER_HOUR) {
    return { ok: true, enabled: true, proposals: [], reason: 'before-window' };
  }

  const day = localDayKey(at);
  const current = {
    day,
    count: state?.day === day && Number.isInteger(state.count) ? state.count : 0,
    sessions: state?.day === day && state.sessions && typeof state.sessions === 'object' ? { ...state.sessions } : {},
  };
  if (current.count >= L4_MAX_PER_DAY) {
    return { ok: true, enabled: true, proposals: [], day, state: current, reason: 'quota' };
  }

  const bySession = new Map();
  for (const proposal of proposals) {
    const sessionId = proposal?.origin?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') continue;
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push(proposal);
  }

  const out = [];
  const seen = new Set();
  for (const session of sessions) {
    if (current.count >= L4_MAX_PER_DAY) break;
    const sessionId = session?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '' || seen.has(sessionId)) continue;
    seen.add(sessionId);
    if (session.isSubagent === true || session.parentSessionId) continue;
    if (Number(session.roundsSinceLastMerge) < L4_MIN_ROUNDS) continue;
    if (current.sessions[sessionId]?.day === day) continue;

    const submitted = bySession.get(sessionId) ?? [];
    if (submitted.length === 0) continue;
    const titles = submitted.map((proposal) => truncated(proposal.title, 48)).filter(Boolean);
    const content = buildL4JournalContent({
      goal: session.goal,
      titles,
      nextTicket: submitted[0]?.queue?.ticket,
    });
    const proposal = {
      op: 'journal.append',
      target: `journal/${day.slice(0, 7)}.md`,
      title: truncated(`L4 归并 ${day} ${sessionId}`, 120),
      content,
      risk: 'medium',
      evidence: [
        `live:${sessionId}`,
        ...submitted.slice(0, 3).map((item) => `proposal:${item.id}`),
      ],
    };
    out.push(proposal);
    current.count += 1;
    current.sessions[sessionId] = { day, at: at.toISOString() };
  }

  return {
    ok: true,
    enabled: true,
    day,
    proposals: out,
    state: current,
    reason: out.length > 0 ? 'eligible' : 'none-eligible',
  };
}

/** Exactly three bullets, always <=600 chars (DESIGN §2.4). */
export function buildL4JournalContent({ goal = '', titles = [], nextTicket = null } = {}) {
  const goalText = truncated(goal, 120) || '（本会话未记录目标）';
  const picked = titles.slice(0, 3).map((title) => truncated(title, 48));
  while (picked.length < 3) picked.push('（无）');
  const ticket = truncated(nextTicket, 16) || '待处理提案';
  return [
    `- 目标：${goalText}`,
    `- 近期提案：${picked.join('；')}`,
    `- 下一步：处理 ${ticket} 后回写本会话结论。`,
  ].join('\n').slice(0, L4_CONTENT_MAX_CHARS);
}
