// WP4a · Tier A wake queue (DESIGN §3.8/§5.13, K27).
//
// Tier A is the durable "ready" log: append-only JSONL + fsync, never the host
// TaskQueue. It carries no consumedAt — delivery state lives in wake-state.json
// (recentWakeIds / per-session cooldown+quota).
//
// WP6 · Tier B (DESIGN §5.13) lives in runCycle(): it is the only place that
// calls agent.followup. It is off unless routerWakeEnabled=true, and the
// service only reaches it from the tick after routerProposalEnabled=true.
// Default-off is an exact no-op: no ready read, no state read/write, no audit.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeJsonStrict, StoreError } from './store.mjs';
import { ensureDir, localDayKey, sha256Hex } from './paths.mjs';

export const WAKE_READY_MAX_BYTES = 1024 * 1024;
export const WAKE_READY_MAX_LINES = 5000;
export const WAKE_READY_KEEP_MS = 24 * 60 * 60 * 1000;
export const RECENT_WAKE_IDS_MAX = 200;
export const WAKE_BODY_MAX_CHARS = 200;
const WAKE_LOG_MAX_DEFAULT = 32 * 1024 * 1024;
const WAKE_COOLDOWN_DEFAULT = 600_000;
const WAKE_QUOTA_DEFAULT = 20;

/** Short body: ticket + target + one instruction. Never the proposal body. */
export function buildWakeBody({ ticket, target } = {}) {
  const text = `你的 ${String(ticket ?? '')} 已就绪（${String(target ?? '')}）。完成后调 router_apply。`;
  return text.length <= WAKE_BODY_MAX_CHARS ? text : `${text.slice(0, WAKE_BODY_MAX_CHARS - 1)}…`;
}

/** Same durable-message shape the host createUserMessage returns. */
export function buildWakeMessage(body) {
  return {
    id: `msg-${crypto.randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: String(body ?? '') }],
    source: { kind: 'schedule' },
  };
}

function classifyResolveError(error) {
  const code = String(error?.code ?? '');
  const text = String(error?.message ?? error ?? '');
  if (/not[-_ ]?found/iu.test(code) || /not[-_ ]?found/iu.test(text)) return 'not-found';
  if (/writer[-_ ]?held/iu.test(code) || /writer[-_ ]?held/iu.test(text)) return 'writer-held';
  return 'resolve-failed';
}


export function wakeIdFor(sessionId, ticket, day, retry = 0) {
  const base = `${sessionId}\u0000${ticket}\u0000${day}`;
  return sha256Hex(retry > 0 ? `${base}\u0000retry:${retry}` : base);
}

export function wakeEntryId(entry) {
  return entry?.id ?? wakeIdFor(entry?.sessionId, entry?.ticket, localDayKey(entry?.createdAt));
}

export class WakeChannel {
  constructor({ vaultDir, paths = null, config = {}, now = () => new Date(), audit = null, logger = null } = {}) {
    this.vaultDir = vaultDir ?? paths?.vaultDir;
    this.readyFile = path.join(this.vaultDir, 'wake-ready.jsonl');
    this.stateFile = path.join(this.vaultDir, 'wake-state.json');
    this.config = config;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.audit = audit;
    this.logger = logger;
  }

  #auditSafe(kind, data) {
    try { this.audit?.(kind, data); } catch { /* ignore */ }
  }

  get maxBytes() {
    return Number.isFinite(this.config.wakeLogMaxBytes) ? this.config.wakeLogMaxBytes : WAKE_READY_MAX_BYTES;
  }

  get enabled() {
    return this.config.wakeEnabled === true;
  }

  /** Parse wake-ready.jsonl, counting malformed lines instead of throwing. */
  readReady({ sinceMs = null } = {}) {
    let raw = '';
    try {
      raw = fs.readFileSync(this.readyFile, 'utf8');
    } catch {
      return { entries: [], bad: 0, bytes: 0 };
    }
    const entries = [];
    let bad = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || entry.v !== 1 || typeof entry.ticket !== 'string' || typeof entry.sessionId !== 'string') {
          bad += 1;
          continue;
        }
        if (sinceMs !== null) {
          const createdAt = Date.parse(entry.createdAt ?? '');
          if (!Number.isFinite(createdAt) || createdAt < sinceMs) continue;
        }
        entries.push(entry);
      } catch {
        bad += 1;
      }
    }
    return { entries, bad, bytes: Buffer.byteLength(raw) };
  }

  /** Count of ready proposals within the last 24h — board/status use this. */
  readyInLast24h() {
    const since = this.now().getTime() - WAKE_READY_KEEP_MS;
    return this.readReady({ sinceMs: since }).entries.length;
  }

  latestReady() {
    const entries = this.readReady().entries;
    return entries.length > 0 ? entries.at(-1) : null;
  }

  /**
   * Rotate before append when the file reaches 1MB: keep entries created within
   * 24h, at most 5,000 newest. Bad lines are skipped (counted + audited).
   */
  #maybeRotate() {
    let stat;
    try {
      stat = fs.statSync(this.readyFile);
    } catch {
      return;
    }
    if (stat.size < this.maxBytes) return;
    const { entries, bad } = this.readReady();
    const since = this.now().getTime() - WAKE_READY_KEEP_MS;
    const kept = entries
      .filter((entry) => {
        const createdAt = Date.parse(entry.createdAt ?? '');
        return Number.isFinite(createdAt) && createdAt >= since;
      })
      .slice(-WAKE_READY_MAX_LINES);
    const tmp = `${this.readyFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const text = kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length > 0 ? '\n' : '');
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.readyFile);
    if (bad > 0) this.#auditSafe('wake.ready.skip', { count: bad, phase: 'rotate' });
    this.#auditSafe('wake.ready.rotate', { kept: kept.length, dropped: entries.length - kept.length, bytes: stat.size });
  }

  /**
   * Append one Tier A entry. Never throws for append failure: wake is a
   * best-effort notification channel, the proposal itself must survive.
   */
  appendReady(proposal) {
    try {
      ensureDir(this.vaultDir);
      this.#maybeRotate();
      const entry = {
        v: 1,
        id: wakeIdFor(proposal.origin?.sessionId ?? 'unknown', proposal.queue?.ticket ?? proposal.id, localDayKey(proposal.createdAt ?? this.now())),
        ticket: proposal.queue?.ticket ?? null,
        sessionId: proposal.origin?.sessionId ?? null,
        target: proposal.target ?? null,
        op: proposal.op ?? null,
        title: proposal.title ?? '',
        createdAt: proposal.createdAt ?? this.now().toISOString(),
        origin: {
          sessionId: proposal.origin?.sessionId ?? null,
          kind: proposal.origin?.kind ?? 'session',
        },
      };
      fs.appendFileSync(this.readyFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      const fd = fs.openSync(this.readyFile, 'a');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { ok: true, entry };
    } catch (error) {
      this.#auditSafe('wake.flush_failed', { proposalId: proposal?.id ?? null, error: String(error?.message ?? error) });
      return { ok: false, code: 'E_WAKE_FLUSH', error: String(error?.message ?? error) };
    }
  }

  /** Read wake-state.json; corrupt file → empty state + reset audit, quota not relaxed. */
  readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!parsed || parsed.v !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
        throw new Error('bad shape');
      }
      return parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#auditSafe('wake.state.reset', { error: String(error?.message ?? error) });
      return { v: 1, day: localDayKey(this.now()), count: 0, updatedAt: null, lastAttemptAt: null, lastError: null, recentWakeIds: {}, sessions: {} };
    }
  }

  writeState(state) {
    ensureDir(this.vaultDir);
    try {
      writeJsonStrict(this.stateFile, state);
      return { ok: true };
    } catch (error) {
      this.#auditSafe('wake.state_write_failed', { error: String(error?.message ?? error) });
      return { ok: false, code: 'E_STORAGE' };
    }
  }

  #dayState(state) {
    const today = localDayKey(this.now());
    if (state.day !== today) {
      state.day = today;
      state.count = 0;
    }
    return today;
  }

  /**
   * Pick Tier B candidates. Pure planning: no host call, no state mutation.
   * Eligibility follows DESIGN §5.13 exactly (root, idle/waiting, cooldown,
   * quota, 24h, dedupe).
   */
  plan({ sessions = [], day = null } = {}) {
    if (!this.enabled) return { ok: true, entries: [], reason: 'disabled' };
    const now = this.now();
    const today = day ?? this.#dayState(this.readState());
    const state = this.readState();
    this.#dayState(state);
    if (state.count >= (this.config.wakeDailyQuota ?? 20)) {
      return { ok: true, entries: [], reason: 'quota' };
    }
    const recent = state.recentWakeIds ?? {};
    const since = now.getTime() - WAKE_READY_KEEP_MS;
    const entries = this.readReady({ sinceMs: since }).entries;
    const bySession = new Map();
    for (const session of sessions) {
      bySession.set(session.sessionId, session);
    }
    const picked = [];
    const seenSession = new Set();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (seenSession.has(entry.sessionId)) continue;
      const session = bySession.get(entry.sessionId);
      if (!session) continue;
      if (session.state !== 'idle' && session.state !== 'waiting') continue;
      if (session.parentSessionId || session.isSubagent === true) continue;
      const id = wakeIdFor(entry.sessionId, entry.ticket, today);
      if (recent[id]) continue;
      const info = state.sessions?.[entry.sessionId] ?? null;
      const lastAttempt = Date.parse(info?.lastAttemptAt ?? '');
      if (Number.isFinite(lastAttempt) && now.getTime() - lastAttempt < (this.config.wakeCooldownMs ?? 600_000)) continue;
      if (picked.length >= (this.config.wakeDailyQuota ?? 20) - state.count) break;
      picked.push({ id, entry, session });
      seenSession.add(entry.sessionId);
    }
    return { ok: true, entries: picked, day: today, reason: picked.length === 0 ? 'none-eligible' : 'eligible' };
  }

  /**
   * Record one delivery attempt. The wakeId is recorded even when the flush
   * fails, so the same id is never resent; a deliberate retry must therefore
   * use a new wakeId containing the retry count (see wakeIdFor retry arg).
   */
  recordAttempt({ id, sessionId, day = null, ok = true, error = null, flushFailed = false, consume = true } = {}) {
    const state = this.readState();
    const today = day ?? this.#dayState(state);
    this.#dayState(state);
    if (consume) {
      state.count = Number.isInteger(state.count) ? state.count + 1 : 1;
    }
    state.updatedAt = this.now().toISOString();
    state.lastAttemptAt = state.updatedAt;
    state.lastError = error ?? null;
    if (consume && id) {
      state.recentWakeIds = state.recentWakeIds ?? {};
      state.recentWakeIds[id] = state.updatedAt;
      const ids = Object.keys(state.recentWakeIds);
      if (ids.length > RECENT_WAKE_IDS_MAX) {
        ids.sort((a, b) => Date.parse(state.recentWakeIds[a]) - Date.parse(state.recentWakeIds[b]));
        for (const old of ids.slice(0, ids.length - RECENT_WAKE_IDS_MAX)) delete state.recentWakeIds[old];
      }
    }
    const prev = state.sessions?.[sessionId] ?? null;
    state.sessions = state.sessions ?? {};
    state.sessions[sessionId] = {
      lastWakeAt: ok && consume ? state.updatedAt : prev?.lastWakeAt ?? null,
      lastAttemptAt: state.updatedAt,
      lastError: error ?? null,
      attempts: (prev?.attempts ?? 0) + 1,
    };
    this.writeState(state);
    if (flushFailed) this.#auditSafe('wake.flush_failed', { sessionId, wakeId: id, day: today, error });
    return { ok: true };
  }

  /**
   * Tier B actor (DESIGN §5.13). Called by the service tick only when both
   * routerProposalEnabled and routerWakeEnabled are true. The default-off
   * branch returns before touching the ready file or wake-state.json.
   *
   * Host seams are injected so CI can run the whole gate ladder with mocks:
   *   sessionController.resolveAgent(id)
   *   createUserMessage({role, content, source})
   *   flush(agentSession)                  // ctx.sessions.flush
   *   sessionLogSize(sessionId) -> bytes   // stat(<session log>)
   */
  async runCycle({
    sessions = [],
    sessionController = null,
    createUserMessage = null,
    flush = null,
    sessionLogSize = null,
    day = null,
  } = {}) {
    const result = {
      ok: true,
      enabled: this.enabled,
      reason: 'disabled',
      day: null,
      attempted: 0,
      delivered: 0,
      denied: [],
      skipped: [],
      todayCount: 0,
    };
    if (!this.enabled) return result;

    const now = this.now();
    const nowMs = now.getTime();
    const state = this.readState();
    const today = day ?? this.#dayState(state);
    result.day = today;
    result.todayCount = Number.isInteger(state.count) ? state.count : 0;
    const quota = this.config.wakeDailyQuota ?? WAKE_QUOTA_DEFAULT;
    const cooldownMs = this.config.wakeCooldownMs ?? WAKE_COOLDOWN_DEFAULT;
    const logMax = this.config.wakeLogMaxBytes ?? WAKE_LOG_MAX_DEFAULT;
    const recent = state.recentWakeIds ?? {};
    const bySession = new Map(sessions.map((session) => [session?.sessionId, session]));
    result.reason = 'none-eligible';

    const entryList = this.readReady({ sinceMs: nowMs - WAKE_READY_KEEP_MS }).entries;
    result.reason = entryList.length === 0 ? 'no-ready' : 'eligible';
    const seen = new Set();
    let used = result.todayCount;

    const deny = (entry, code, reason, extra = {}) => {
      const row = {
        sessionId: entry.sessionId,
        ticket: entry.ticket,
        code,
        reason,
        ...extra,
      };
      this.#auditSafe('wake.denied', {
        sessionId: entry.sessionId,
        ticket: entry.ticket,
        code,
        reason,
        cooldownRemainingMs: extra.cooldownRemainingMs ?? 0,
        todayCount: used,
      });
      result.denied.push(row);
    };
    const skip = (entry, reason, extra = {}) => {
      this.#auditSafe('wake.skipped', {
        sessionId: entry.sessionId,
        ticket: entry.ticket,
        reason,
        todayCount: used,
        ...extra,
      });
      result.skipped.push({ sessionId: entry.sessionId, ticket: entry.ticket, reason, ...extra });
    };

    for (let index = entryList.length - 1; index >= 0; index -= 1) {
      const entry = entryList[index];
      // Newest ready line per session wins; older tickets for the same session
      // stay in Tier A and are handled by later ticks.
      if (seen.has(entry.sessionId)) continue;
      seen.add(entry.sessionId);
      const session = bySession.get(entry.sessionId);
      if (!session) {
        skip(entry, 'unknown-session');
        continue;
      }
      if (session.parentSessionId || session.isSubagent === true) {
        deny(entry, 'E_WAKE_NOT_ELIGIBLE', 'subagent');
        continue;
      }
      // Raw row state, not effectiveState (DESIGN §5.13).
      if (session.state !== 'idle' && session.state !== 'waiting') {
        deny(entry, 'E_WAKE_NOT_ELIGIBLE', 'not-idle');
        continue;
      }
      const id = entry.id ?? wakeIdFor(entry.sessionId, entry.ticket, today);
      if (recent[id]) {
        this.#auditSafe('wake.deduped', {
          sessionId: entry.sessionId,
          ticket: entry.ticket,
          reason: state.sessions?.[entry.sessionId]?.lastError === 'flush_failed' ? 'flush-retry' : 'already-woken',
        });
        result.denied.push({ sessionId: entry.sessionId, ticket: entry.ticket, code: 'E_WAKE_DEDUPED', reason: 'already-woken' });
        continue;
      }
      const info = state.sessions?.[entry.sessionId] ?? null;
      const lastAttempt = Date.parse(info?.lastAttemptAt ?? '');
      if (Number.isFinite(lastAttempt) && nowMs - lastAttempt < cooldownMs) {
        deny(entry, 'E_WAKE_COOLDOWN', 'cooldown', {
          cooldownRemainingMs: Math.max(0, cooldownMs - (nowMs - lastAttempt)),
        });
        continue;
      }
      if (used >= quota) {
        deny(entry, 'E_WAKE_QUOTA', 'quota', { todayCount: used });
        continue;
      }

      // Cold-session gate: stat before resolveAgent.
      let size = null;
      try {
        size = typeof sessionLogSize === 'function' ? await sessionLogSize(entry.sessionId) : null;
      } catch {
        size = null;
      }
      if (size === null || size === undefined || !Number.isFinite(Number(size))) {
        this.recordAttempt({ id, sessionId: entry.sessionId, day: today, ok: false, error: 'log-size-unavailable', consume: false });
        deny(entry, 'E_WAKE_NOT_ELIGIBLE', 'log-size-unavailable');
        continue;
      }
      if (Number(size) >= logMax) {
        this.recordAttempt({ id, sessionId: entry.sessionId, day: today, ok: false, error: 'E_WAKE_LOG_TOO_LARGE', consume: false });
        deny(entry, 'E_WAKE_LOG_TOO_LARGE', 'log-too-large', { logBytes: Number(size) });
        continue;
      }
      if (typeof sessionController?.resolveAgent !== 'function' || typeof flush !== 'function') {
        this.recordAttempt({ id, sessionId: entry.sessionId, day: today, ok: false, error: 'contract-unavailable', consume: false });
        deny(entry, 'E_WAKE_NOT_ELIGIBLE', 'contract-unavailable');
        continue;
      }
      if (info?.lastError === 'writer-held' && Number(info?.attempts) >= 3) {
        skip(entry, 'writer-held');
        continue;
      }

      result.attempted += 1;
      let agent = null;
      try {
        agent = await sessionController.resolveAgent(entry.sessionId);
      } catch (error) {
        const reason = classifyResolveError(error);
        if (reason === 'not-found') {
          this.recordAttempt({ id, sessionId: entry.sessionId, day: today, ok: false, error: 'not-found', consume: true });
          used += 1;
          skip(entry, 'not-found');
        } else {
          this.recordAttempt({ id, sessionId: entry.sessionId, day: today, ok: false, error: reason, consume: false });
          skip(entry, reason);
        }
        continue;
      }
      if (!agent || typeof agent.followup !== 'function') {
        this.recordAttempt({ id, sessionId: entry.sessionId, day: today, ok: false, error: 'resolve-failed', consume: false });
        skip(entry, 'resolve-failed');
        continue;
      }

      const body = buildWakeBody({ ticket: entry.ticket, target: entry.target });
      let message = null;
      try {
        message = typeof createUserMessage === 'function'
          ? createUserMessage({ role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'schedule' } })
          : buildWakeMessage(body);
      } catch {
        this.recordAttempt({ id, sessionId: entry.sessionId, day: today, ok: false, error: 'create-message-failed', consume: false });
        skip(entry, 'create-message-failed');
        continue;
      }
      let flushOk = true;
      try {
        await agent.followup(message);
        flushOk = (await Promise.resolve(flush(agent.session))) !== false;
      } catch (error) {
        this.recordAttempt({ id, sessionId: entry.sessionId, day: today, ok: false, error: 'followup-failed', consume: false });
        skip(entry, 'followup-failed', { error: String(error?.message ?? error) });
        continue;
      }
      this.recordAttempt({
        id,
        sessionId: entry.sessionId,
        day: today,
        ok: true,
        error: flushOk ? null : 'flush_failed',
        flushFailed: !flushOk,
        consume: true,
      });
      used += 1;
      result.delivered += 1;
      result.todayCount = used;
      this.#auditSafe('wake.attempt', {
        sessionId: entry.sessionId,
        ticket: entry.ticket,
        reason: flushOk ? 'delivered' : 'flush_failed',
        flushFailed: !flushOk,
        todayCount: used,
        bodyChars: body.length,
      });
    }

    result.todayCount = used;
    return result;
  }


  status() {
    const state = this.readState();
    const today = localDayKey(this.now());
    const count = state.day === today ? (Number.isInteger(state.count) ? state.count : 0) : 0;
    const last = state.lastAttemptAt ?? null;
    const lastMs = Date.parse(last ?? '');
    const cooldown = this.config.wakeCooldownMs ?? 600_000;
    return {
      enabled: this.enabled,
      lastAttemptAt: last,
      lastError: state.lastError ?? null,
      todayCount: count,
      cooldownRemainingMs: Number.isFinite(lastMs) ? Math.max(0, cooldown - (this.now().getTime() - lastMs)) : 0,
      recentIds: Object.keys(state.recentWakeIds ?? {}).length,
      readyCount: this.readyInLast24h(),
    };
  }
}

export function createWakeChannel(options) {
  return new WakeChannel(options);
}
