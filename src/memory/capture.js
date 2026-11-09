// src/memory/capture.js — M2-B：写入路径全覆盖（turn 内/轮末 / 会话启动 / 宿主生命周期 /
// 离线空窗补记 / 场外事件）＋ 幂等 ＋ 跨进程锁（lock.js）+ WAL（wal.js）
//
// 设计（提案 §2.1 写入矩阵 / §2.3 幂等 / §2.4 双会话并发 / PLAN §2.7）：
//   * 每个写路径 = lease（O_EXCL）→ WAL pending → 真正写（索引/记录/journal）→ WAL done；
//     崩溃后 replay pending（写入本身幂等，不产生半行）。
//   * captureTurn：从 L0 抽该会话本轮（或全部未入库轮）→ EventRecord 入索引（幂等 key=id+digest）。
//   * captureMemoryGap：把双时钟（host-gap / memory-gap）**分两行**写 journal，
//     幂等 key 由 (from,to) 决定；同时写索引 lifecycle 事件（可被回忆检索）。
//   * captureOffFieldNote（场外事件）：records.jsonl 追加 kind=episode（机器断言层）。
// 禁止触碰 L0：本模块只读会话日志，所有写都在 <memoryRoot>。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseSession, stableStringify } from '../codec.js';
import { makeSessionTurnAnchor, turnDigest } from './anchors.js';
import { appendClaimFromRecord } from './governance.js';
import { evaluateEvidenceForWrite, evidenceFromAnchors } from './records.js';
import { extractTurns, openEventIndex } from './event-index.js';
import { acquireLease, releaseLease } from './lock.js';
import { createWal } from './wal.js';
import { memoryIndex } from './index.js';
import { refreshIndexAfterCapture } from './index-freshness.js';
import { updateState } from './state.js';

export const RECORDS_SCHEMA = 'records/v1';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha1Short(text, length = 12) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, length);
}

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return value instanceof Date ? value : new Date(value);
}

export function journalPathOf(memoryRoot, atMs) {
  const date = new Date(atMs);
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return path.join(path.resolve(String(memoryRoot)), 'journal', `${month}.md`);
}

export function recordsPathOf(memoryRoot) {
  return path.join(path.resolve(String(memoryRoot)), '.longlive', 'records.jsonl');
}

export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Append an idempotent journal line. `capKey` is hashed into a `<!-- cap:… -->`
 * marker; the same key is written at most once (checked by substring scan).
 */
export function appendJournalLine({ memoryRoot, atMs, text, capKey }) {
  const file = journalPathOf(memoryRoot, atMs);
  const cap = sha1Short(`lifecycle:${capKey}`);
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.includes(`<!-- cap:${cap} -->`)) return { ok: true, written: false, file, cap };
  const date = new Date(atMs);
  const stamp = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const prefix = existing === '' ? '' : (existing.endsWith('\n') ? '' : '\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${prefix}- **${stamp}** ${text} <!-- cap:${cap} -->\n`, 'utf8');
  return { ok: true, written: true, file, cap };
}

/** Append one records.jsonl assertion (idempotent by record.id). */
export function appendRecordLine({ memoryRoot, record }) {
  const file = recordsPathOf(memoryRoot);
  const id = record.id;
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.includes(`"id":"${id}"`)) return { ok: true, written: false, id, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ schema: RECORDS_SCHEMA, ...record });
  fs.appendFileSync(file, `${line}\n`, 'utf8');
  return { ok: true, written: true, id, file };
}

export function makeRecordId({ content, createdAt, source }) {
  return `rec:${sha1Short(`${content}|${createdAt}|${source}`, 12)}`;
}

/**
 * Create the capture facade.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {() => Date} [options.now]
 * @param {string[]} [options.sessionRoots]
 * @param {number} [options.lockTtlMs]
 */
export function createCapture(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  if (memoryRoot === '') throw new Error('E_MEMORY_ROOT: capture requires memoryRoot');
  const sessionRoots = Array.isArray(options.sessionRoots) ? options.sessionRoots : [];
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const holder = typeof options.holder === 'string' && options.holder !== '' ? options.holder : `capture-${process.pid}`;
  const lockTtlMs = Number.isInteger(options.lockTtlMs) ? options.lockTtlMs : undefined;
  const lockFile = path.join(memoryRoot, '.longlive', 'memory', 'write.lock');
  const wal = createWal({ memoryRoot, now });
  const indexPath = path.join(memoryRoot, '.longlive', 'index', 'events.db');

  function withLease(fn) {
    const lease = acquireLease(lockFile, { holder, now, ...(lockTtlMs ? { ttlMs: lockTtlMs } : {}) });
    try {
      return fn(lease);
    } finally {
      releaseLease(lockFile, lease.holder);
    }
  }

  function withIndex(fn) {
    if (!fs.existsSync(indexPath)) {
      throw new Error('E_EVENTS_INDEX_NOT_BUILT: run scripts/recall-index-build.mjs first');
    }
    const index = openEventIndex({ memoryRoot, now });
    try {
      return fn(index);
    } finally {
      index.close();
    }
  }

  function findSessionLog(sessionId) {
    const stack = sessionRoots.map((root) => path.resolve(root));
    const seen = new Set();
    while (stack.length > 0) {
      const dir = stack.pop();
      if (seen.has(dir)) continue;
      seen.add(dir);
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === sessionId) {
            const file = path.join(full, 'session.v4.jsonl.zstd');
            if (fs.existsSync(file)) return file;
          }
          stack.push(full);
        }
      }
    }
    return null;
  }

  /** Index native turns from a session log (turn-in/turn-end/会话启动 coverage). */
  function captureTurn(input = {}) {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    const logFile = typeof input.logFile === 'string' && input.logFile !== ''
      ? input.logFile
      : (sessionId !== '' ? findSessionLog(sessionId) : null);
    if (!logFile) throw new Error(`E_SESSION_LOG_MISSING: ${sessionId}`);
    return withLease(() => {
      const walId = wal.begin('captureTurn', { sessionId, logFile, turn: input.turn ?? null, source: input.source ?? 'turn-end' });
      try {
        const parsed = parseSession(fs.readFileSync(logFile));
        const records = extractTurns(parsed.header, parsed.events, parsed.frames, parsed.texts);
        const selected = Number.isInteger(input.turn)
          ? records.filter((record) => record.turn === input.turn)
          : records;
        const result = withIndex((index) => {
          let inserted = 0;
          for (const record of selected) {
            record.builtAt = nowDate(now).getTime();
            record.source = input.source ?? 'turn-end';
            const written = index.upsertEvent(record, { source: record.source });
            if (written.inserted) inserted += 1;
          }
          return { inserted, skipped: selected.length - inserted };
        });
        // 1.8.2 D1: AutoCards are no longer written (cold archive; cards.jsonl
        // is read-only legacy data). Keep the return fields as constant 0/null
        // so existing callers do not need a new branch.
        const cards = { written: 0, skipped: 0, file: null };
        const capturedAt = nowDate(now);
        // Refresh INDEX.md + the freshness ledger after every successful capture.
        // The writer is idempotent (`ifChanged`) and failures are recorded in
        // memory-state, not thrown into the host turn.
        let indexRefresh;
        try {
          updateState(memoryRoot, { lastCaptureAt: capturedAt.toISOString() }, { now: capturedAt });
          indexRefresh = refreshIndexAfterCapture({ memoryRoot, now: capturedAt, indexer: memoryIndex });
        } catch (error) {
          indexRefresh = { ok: false, error, failure: { code: error?.code ?? 'E_INDEX_REFRESH' } };
        }
        wal.markDone(walId, { inserted: result.inserted, cards: 0, indexRefresh: indexRefresh?.ok === true });
        return {
          ok: true,
          sessionId,
          logFile,
          turns: selected.length,
          ...result,
          cardsWritten: 0,
          cardsSkipped: 0,
          cardsFile: null,
          indexRefresh,
          indexFreshness: indexRefresh?.freshness ?? null,
          walId,
        };
      } catch (error) {
        wal.markFailed(walId, error?.message ?? error);
        throw error;
      }
    });
  }

  /** 会话启动：把会话当前所有轮补进索引（首次启动全覆盖）并写 boot 事件。 */
  function captureSessionStart(input = {}) {
    const result = captureTurn({ ...input, source: input.source ?? 'session-start' });
    const event = captureLifecycleEvent({
      event: 'session-start',
      at: input.at,
      data: { sessionId: result.sessionId, turns: result.turns },
    });
    return { ...result, lifecycleEvent: event };
  }

  /** 宿主生命周期事件（boot/shutdown/crash/restart）→ journal 行 + 索引事件。 */
  function captureLifecycleEvent(input = {}) {
    const at = Number.isFinite(input.at) ? input.at : nowDate(now).getTime();
    const event = typeof input.event === 'string' ? input.event : 'lifecycle';
    const key = `lifecycle:${event}:${input.key ?? Math.round(at / 1000)}`;
    const journal = appendJournalLine({
      memoryRoot,
      atMs: at,
      text: `宿主生命周期 **${event}**${input.text ? `：${input.text}` : ''}`,
      capKey: key,
    });
    let indexed = null;
    if (fs.existsSync(indexPath)) {
      const summary = `宿主生命周期 ${event}${input.text ? `：${input.text}` : ''}`;
      const digest = sha256Hex(stableStringify({ event, at, data: input.data ?? null }));
      indexed = withIndex((index) => index.upsertEvent({
        id: `evt:host-lifecycle:${sha1Short(key)}`,
        sessionId: 'host-lifecycle',
        turn: 0,
        seqStart: null,
        seqEnd: null,
        timeStart: at,
        timeEnd: at,
        project: null,
        kind: 'lifecycle',
        topics: ['lifecycle'],
        terms: [event],
        summary,
        counts: {},
        anchors: [],
        digest,
        source: 'lifecycle',
        builtAt: nowDate(now).getTime(),
      }, { source: 'lifecycle' }));
    }
    return { ok: true, event, at, journal, indexed };
  }

  /** 离线空窗补记：host-gap 与 memory-gap 分两行写，幂等 key=(from,to)。 */
  function captureMemoryGap(input = {}) {
    const gaps = input.gaps;
    if (!gaps || typeof gaps !== 'object') throw new Error('E_GAPS_REQUIRED: captureMemoryGap requires computeGaps() output');
    const at = gaps.bootAt ? Date.parse(gaps.bootAt) : nowDate(now).getTime();
    const out = { ok: true, journal: [], indexed: [] };
    if (gaps.memoryGap && gaps.memoryGap.kind !== 'unknown') {
      const from = gaps.memoryGap.from ?? 'unknown';
      const to = gaps.memoryGap.to ?? 'unknown';
      const evidence = gaps.memoryGap.activityEvidence ?? {};
      const text = `记忆空窗 ${gaps.memoryGap.gapText}（上次记忆写入 ${String(from).slice(11, 19)}，`
        + `期间 ${evidence.toolOutputs ?? 0} 个 tool-output 活动证据）`;
      out.journal.push(appendJournalLine({ memoryRoot, atMs: at, text, capKey: `memory-gap:${from}:${to}` }));
    }
    if (gaps.hostGap && gaps.hostGap.kind !== 'unknown') {
      const from = gaps.hostGap.from ?? 'unknown';
      const to = gaps.hostGap.to ?? 'unknown';
      const text = `宿主中断 ${gaps.hostGap.gapText}（${String(from).slice(11, 19)} → ${String(to).slice(11, 19)} · 上次退出：${gaps.hostGap.prevExitForm ?? '未知'}）`;
      out.journal.push(appendJournalLine({ memoryRoot, atMs: at, text, capKey: `host-gap:${from}:${to}` }));
    }
    if (fs.existsSync(indexPath)) {
      for (const [clock, gap] of [['memory-gap', gaps.memoryGap], ['host-gap', gaps.hostGap]]) {
        if (!gap || gap.kind === 'unknown') continue;
        const key = `${clock}:${gap.from}:${gap.to}`;
        const clockText = clock === 'memory-gap' ? '记忆空窗' : '宿主中断';
        const digest = sha256Hex(stableStringify({ clock, gap }));
        out.indexed.push(withIndex((index) => index.upsertEvent({
          id: `evt:host-lifecycle:${sha1Short(key)}`,
          sessionId: 'host-lifecycle',
          turn: 0,
          seqStart: null,
          seqEnd: null,
          timeStart: at,
          timeEnd: at,
          project: null,
          kind: 'lifecycle',
          topics: ['lifecycle', clockText],
          terms: [clock, clockText, gap.gapText],
          summary: `${clockText} ${gap.gapText}`,
          counts: {},
          anchors: [],
          digest,
          source: 'lifecycle',
          builtAt: nowDate(now).getTime(),
        }, { source: 'lifecycle' })));
      }
    }
    return out;
  }

  /** 场外事件（老大在外面做的事，口述补记）→ records.jsonl(kind=episode)。 */
  function captureOffFieldNote(input = {}) {
    const text = String(input.text ?? '').trim();
    if (text === '') throw new Error('E_NOTE_EMPTY: memory_note requires text');
    const at = Number.isFinite(input.at) ? input.at : nowDate(now).getTime();
    const createdAt = new Date(at).toISOString();
    const content = text;
    const source = input.source ?? 'off-field-note';
    const id = makeRecordId({ content, createdAt, source });
    // EA-02：sourceTier 由服务端强制——场外补记只能是 user；调用方自报 host/agent 一律拒绝。
    if (input.sourceTier !== undefined && input.sourceTier !== 'user') {
      const error = new Error('E_SOURCE_TIER_SELF_REPORT: 不接受调用方自报 sourceTier');
      error.code = 'E_SOURCE_TIER_SELF_REPORT';
      throw error;
    }
    const sourceTier = 'user';
    const anchors = Array.isArray(input.anchors) ? input.anchors : [];
    const evidenceEval = evaluateEvidenceForWrite(anchors, { verifiedAt: createdAt });
    const evidence = evidenceEval.evidence.map((entry) => ({
      anchorId: entry.anchorId, sha256: entry.sha256, excerptRef: entry.excerptRef, verifiedAt: entry.verifiedAt,
      valid: entry.valid, invalidCode: entry.invalidCode,
    }));
    const evidenceState = evidence.length === 0 ? 'unverified' : (evidenceEval.verified ? 'active' : 'unverified');
    const record = {
      id,
      kind: 'episode',
      content,
      subject: null,
      project: input.project ?? null,
      salience: Number.isInteger(input.salience) ? input.salience : 3,
      importance: 0.5,
      status: 'active',
      createdAt,
      lastUsed: createdAt.slice(0, 10),
      useCount: 0,
      anchors: Array.isArray(input.anchors) ? input.anchors : [],
      evidence,
      sourceTier,
      conflict: false,
      conflict_with: [],
      state: evidenceState,
      evidenceVerified: evidenceEval.verified,
      evidenceReasons: evidenceEval.reasons,
      anchorStatus: evidence.length > 0 ? 'unverified' : 'missing',
      supersedes: [],
      supersededBy: null,
      audit: { createdBy: 'memory-note', source },
    };
    const written = withLease(() => appendRecordLine({ memoryRoot, record }));
    // Activation: runtime memory writes must also land Claims (not records-only).
    let claim = null;
    try {
      claim = appendClaimFromRecord({ memoryRoot, record, now });
    } catch (error) {
      claim = { ok: false, code: error?.code ?? 'E_CLAIM_BRIDGE' };
    }
    return { ok: true, id, written: written.written, file: written.file, record, claim };
  }

  /** Replay pending WAL intents and retry failed ones once (idempotent). */
  function replayWal() {
    const handleEntry = (entry) => {
      if (entry.op !== 'captureTurn') throw new Error(`E_WAL_OP_UNKNOWN: ${entry.op}`);
      const payload = entry.payload ?? {};
      const logFile = payload.logFile ?? findSessionLog(payload.sessionId);
      if (!logFile) throw new Error(`E_SESSION_LOG_MISSING: ${payload.sessionId}`);
      const parsed = parseSession(fs.readFileSync(logFile));
      const records = extractTurns(parsed.header, parsed.events, parsed.frames, parsed.texts);
      const selected = Number.isInteger(payload.turn)
        ? records.filter((record) => record.turn === payload.turn)
        : records;
      withIndex((index) => {
        for (const record of selected) {
          record.builtAt = nowDate(now).getTime();
          record.source = 'wal-replay';
          index.upsertEvent(record, { source: record.source });
        }
      });
      // 1.8.2 D1: WAL replay no longer backfills AutoCards; the legacy
      // cards.jsonl archive stays read-only. Return shape stays compatible.
      return { written: 0, skipped: 0, file: null };
    };
    const results = wal.replay((entry) => { handleEntry(entry); });
    // W2: a failed intent is retried once, then left failed with an audit row
    // rather than retrying forever (EISDIR / permission errors are persistent).
    results.retried = 0;
    results.retryErrors = [];
    for (const entry of wal.failed()) {
      const retryCount = Number(entry.retryCount ?? 0);
      if (retryCount >= 1) continue;
      try {
        handleEntry(entry);
        wal.markDone(entry.walId, { replayed: true, retried: true });
        results.replayed += 1;
        results.retried += 1;
      } catch (error) {
        wal.markFailed(entry.walId, error?.message ?? error, { retryCount: retryCount + 1 });
        results.failed += 1;
        results.retryErrors.push({ walId: entry.walId, op: entry.op, message: String(error?.message ?? error) });
        try {
          fs.mkdirSync(path.join(memoryRoot, '.longlive', 'index'), { recursive: true });
          fs.appendFileSync(path.join(memoryRoot, '.longlive', 'index', 'card-audit.jsonl'),
            `${JSON.stringify({ schema: 'card-audit/v1', at: new Date(nowDate(now)).toISOString(), action: 'wal-retry-exhausted', walId: entry.walId, op: entry.op, message: String(error?.message ?? error) })}\n`, 'utf8');
        } catch { /* audit is best-effort; WAL remains failed */ }
      }
    }
    results.ok = results.failed === 0;
    return results;
  }

  return { memoryRoot, lockFile, wal, captureTurn, captureSessionStart, captureLifecycleEvent, captureMemoryGap, captureOffFieldNote, replayWal, findSessionLog, indexPath };
}

/** Index a raw EventRecord directly (used by activity-capture). */
export function upsertEventRecord({ memoryRoot, now, record }) {
  const indexPath = path.join(path.resolve(String(memoryRoot)), '.longlive', 'index', 'events.db');
  if (!fs.existsSync(indexPath)) return { ok: false, code: 'E_EVENTS_INDEX_NOT_BUILT' };
  const index = openEventIndex({ memoryRoot, now });
  try {
    const result = index.upsertEvent({ ...record, builtAt: record.builtAt ?? (typeof now === 'function' ? now().getTime() : Date.now()) }, { source: record.source ?? 'capture' });
    return { ok: true, ...result };
  } finally {
    index.close();
  }
}

export { makeSessionTurnAnchor, turnDigest };
