// caller.mjs — the single place that classifies a tool caller as main session,
// subagent or owner CLI (DESIGN §2.7 / §9.4, lead ruling D-CR1).
//
// The only authoritative subagent signal is the host-stamped
// `session.header.origin === 'subagent'`. A header that exists and says
// `root` (or omits origin) is a main session even when the same wrapper also
// carries `isSubagent`/`depth`. Fork sessions inherit `parentSessionId` but are
// NOT subagents, so that field must never be used on its own.
//
// The legacy isSubagent/depth heuristic is kept only for a caller with no
// `session.header` object at all (older hosts). It is the conservative read for
// the worst case: a hostile host that fakes a missing header still needs
// `isSubagent === true` or a positive depth to be treated as a subagent.

import { sessionIdOfExec } from '../../identity.js';

/**
 * Unwrap the exec wrapper (`{ agent }` / `{ caller }`) when present.
 * Plain Agent/session-like objects are returned as-is.
 */
function rawCallerOf(exec) {
  if (!exec || typeof exec !== 'object' || Array.isArray(exec)) return exec;
  if (exec.agent && typeof exec.agent === 'object' && !Array.isArray(exec.agent)) return exec.agent;
  if (exec.caller && typeof exec.caller === 'object' && !Array.isArray(exec.caller)) return exec.caller;
  return exec;
}

function headerOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const session = value.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  const header = session.header;
  return header && typeof header === 'object' && !Array.isArray(header) ? header : null;
}

/** True only when the caller carries an actual session.header object. */
export function hasSessionHeader(value) {
  return headerOf(value) !== null;
}

/** Lower-cased origin string from session.header.origin ('' when absent). */
export function originOf(value) {
  const origin = headerOf(value)?.origin;
  return typeof origin === 'string' ? origin.trim().toLowerCase() : '';
}

/** Legacy fallback, used only when no session.header exists at all. */
export function looksLikeSubagent(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.isSubagent === true) return true;
  if (Number.isInteger(value.depth) && value.depth > 0) return true;
  if (value.agent && Number.isInteger(value.agent.depth) && value.agent.depth > 0) return true;
  return false;
}

function kindFor(exec, raw) {
  if ((raw && raw.kind === 'owner-cli') || (exec && exec.kind === 'owner-cli')) return 'owner-cli';
  for (const value of [raw, exec]) {
    if (!hasSessionHeader(value)) continue;
    return originOf(value) === 'subagent' ? 'subagent' : 'root';
  }
  return looksLikeSubagent(raw) || looksLikeSubagent(exec) ? 'subagent' : 'root';
}

/**
 * Resolve the host-side caller without trusting tool arguments. The returned
 * `kind` is the authoritative classification for this call.
 */
export function callerOf(config = {}) {
  const exec = config?.exec ?? null;
  const raw = rawCallerOf(exec);
  let sessionId = null;
  try {
    sessionId = sessionIdOfExec(exec) ?? null;
  } catch { /* identity resolution is best effort */ }
  if (!sessionId && raw && typeof raw.sessionId === 'string' && raw.sessionId.trim() !== '') sessionId = raw.sessionId.trim();
  if (!sessionId && raw && typeof raw.id === 'string' && raw.id.trim() !== '') sessionId = raw.id.trim();
  if (!sessionId && raw) {
    const headerId = headerOf(raw)?.id;
    if (typeof headerId === 'string' && headerId.trim() !== '') sessionId = headerId.trim();
  }
  const turn = Number.isInteger(raw?.turn)
    ? raw.turn
    : (Number.isInteger(exec?.turn) ? exec.turn : null);
  const host = typeof raw?.host === 'string' && raw.host !== ''
    ? raw.host
    : (typeof exec?.host === 'string' && exec.host !== '' ? exec.host : null);
  return {
    sessionId: sessionId ?? 'unknown-session',
    kind: kindFor(exec, raw),
    turn,
    host,
  };
}

/**
 * Hard-gate predicate used by the service layer. Accepts both the normalized
 * `{kind, sessionId}` caller and a raw exec/agent wrapper.
 *
 * Precedence: explicit owner-cli > session.header.origin > explicit normalized
 * kind > legacy heuristic (header missing only).
 */
export function isSubagentCaller(caller) {
  if (!caller || typeof caller !== 'object') return false;
  const raw = rawCallerOf(caller);
  if (caller.kind === 'owner-cli' || (raw && raw.kind === 'owner-cli')) return false;
  for (const value of [raw, caller]) {
    if (!hasSessionHeader(value)) continue;
    return originOf(value) === 'subagent';
  }
  if (caller.kind === 'subagent') return true;
  return looksLikeSubagent(raw) || looksLikeSubagent(caller);
}

/** Best-effort stable session id for audit/rate-limit keys. */
export function sessionIdOfCaller(caller) {
  if (!caller || typeof caller !== 'object') return 'unknown-session';
  if (typeof caller.sessionId === 'string' && caller.sessionId.trim() !== '') return caller.sessionId.trim();
  try {
    const fromExec = sessionIdOfExec(caller);
    if (typeof fromExec === 'string' && fromExec.trim() !== '') return fromExec.trim();
  } catch { /* best effort */ }
  const raw = rawCallerOf(caller);
  for (const value of [raw, caller]) {
    const headerId = headerOf(value)?.id;
    if (typeof headerId === 'string' && headerId.trim() !== '') return headerId.trim();
    if (value && typeof value.sessionId === 'string' && value.sessionId.trim() !== '') return value.sessionId.trim();
    if (value && typeof value.id === 'string' && value.id.trim() !== '') return value.id.trim();
  }
  return 'unknown-session';
}
