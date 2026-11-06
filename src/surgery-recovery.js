// @local/dsh-longlive — unattended-surgery recovery self-check
//
// The unattended launcher (scripts/unattended-surgery.ps1) writes a small,
// atomic stage file before every irreversible step:
//
//   <memoryRoot>/.longlive/surgery-state.json
//
// If the operator closes the window (or the host/script dies) between two
// stages, that file survives. On the next activation this module performs a
// *read-only* post-mortem:
//
//   * read the state file (one existsSync probe when there is none);
//   * re-read the session and compare its sha256 / byte size / event count /
//     message count with the stage file;
//   * check the pre-surgery backup still exists and its sha256 matches;
//   * compare the plugin (and, when recorded, host) version with the running
//     one;
//   * write exactly one report under .longlive/reports/ and append exactly one
//     audit line.
//
// It NEVER truncates, restores, deletes or rewrites the session, and it never
// edits surgery-state.json. The four verdicts are deliberately boring:
//
//   applied-and-verified  the cut landed and a read-back record proves it
//   applied-unparsed      the CLI exited 0 but its stdout could not be parsed
//                         (GBK console / broken pipe), and an independent
//                         read-back proved the cut landed (rc.6 / R4-03)
//   applied-unverified    the cut landed but no read-back record was written
//   aborted-before-cut    backup is intact and the session still matches before
//   needs-attention       session unreadable/changed in an unexplained way, or
//                         the backup is missing/mismatched, or the cut could not
//                         be proved after an unparseable CLI exit (rc.6)
//
// A `phase: "done"` state file with `receipt.written: true` is a completed
// receipt: activation does nothing at all. A done state that never recorded a
// written receipt (an rc.2 state, or a launcher killed after the cut) falls
// through to the fallback path, which reports it once and marks the injection
// in the state file so later starts stay quiet. `--recover-report` / `--status`
// can still read any state on demand.
//
// `-DryRun` never reaches any of that. rc.4 writes `phase: "dryrun"` (plus
// `dryRun: true`) instead of `done`, and every entry point below short-circuits
// on it: the startup check returns `checked: false, reason: "dryrun"` without
// reading the session, writing a report or appending an audit line, and
// `--write-receipt` answers `E_RECEIPT_DRYRUN` instead of treating the state as
// a broken real surgery. An rc.3 dry-run state (`phase: "done"` with
// `dryRun: true`) is recognised the same way.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MESSAGE_TYPES, encodeSession, foldSurface, parseSession, sha256 } from './codec.js';
import { dshHome } from './home.js';
import { VERSION } from './version.js';
import {
  REPORTS_DIR,
  appendAudit,
  ensureDir,
  longliveDir,
  reportsDir,
  sha256File,
  stampToken,
  writeFileAtomic,
} from './memory/state.js';

export const SURGERY_STATE_FILENAME = 'surgery-state.json';
export const SURGERY_STATE_VERSION = 1;
export const SURGERY_KIND = 'longlive-surgery';

export const CLASSIFICATIONS = Object.freeze({
  APPLIED_VERIFIED: 'applied-and-verified',
  APPLIED_UNPARSED: 'applied-unparsed',
  APPLIED_UNVERIFIED: 'applied-unverified',
  ABORTED_BEFORE_CUT: 'aborted-before-cut',
  NEEDS_ATTENTION: 'needs-attention',
});

export const RECOVERY_REASON = Object.freeze({
  OK_VERIFIED: 'CUT_APPLIED_AND_VERIFIED',
  OK_UNPARSED: 'CUT_APPLIED_UNPARSED_STDOUT',
  OK_UNVERIFIED: 'CUT_APPLIED_WITHOUT_READBACK',
  OK_ABORTED: 'ABORTED_BEFORE_CUT',
  OK_NOOP: 'NOOP_TRUNCATION_NOT_NEEDED',
  OK_DRYRUN: 'DRYRUN_NOT_A_SURGERY',
  NOOP_SESSION_CHANGED: 'NOOP_SESSION_CHANGED',
  STATE_UNREADABLE: 'STATE_UNREADABLE',
  STATE_INVALID: 'STATE_INVALID',
  SESSION_MISSING: 'SESSION_MISSING',
  SESSION_UNREADABLE: 'SESSION_UNREADABLE',
  SESSION_SHA_MISMATCH: 'SESSION_SHA_MISMATCH',
  SESSION_SIZE_MISMATCH: 'SESSION_SIZE_MISMATCH',
  SESSION_COUNTS_MISMATCH: 'SESSION_COUNTS_MISMATCH',
  CUT_RESULT_MISSING: 'CUT_RESULT_MISSING',
  SESSION_CHANGED_BEFORE_CUT: 'SESSION_CHANGED_BEFORE_CUT',
  BACKUP_MISSING: 'BACKUP_MISSING',
  BACKUP_SHA_MISMATCH: 'BACKUP_SHA_MISMATCH',
  BACKUP_UNREADABLE: 'BACKUP_UNREADABLE',
  // rc.6: the CLI exited 0 but printed nothing parseable, and the independent
  // read-back could not prove the cut either. This is the error code the
  // executor writes into needsAttention.code and the report echoes back.
  CUT_UNVERIFIED: 'E_CUT_UNVERIFIED',
});

const PHASES = new Set(['prepare', 'backup', 'cut', 'restart', 'receipt-pending', 'done', 'failed', 'dryrun', 'needs-attention']);

// R3-04: `phase` and `sessionId` come from a JSON file that an attacker (or a
// broken launcher) can edit, and they used to be interpolated into conversation
// text verbatim. Only the fixed phase enum and a [a-z0-9-] token may be echoed
// (a legal session id in full, per R4-02); everything else is replaced character
// by character, so a value like `..\..\C:\Users\x` can never look like a path in
// the receipt.
const SAFE_TOKEN_RE = /^[a-z0-9-]+$/;

export function sanitizePhase(value) {
  const text = asText(value);
  if (!text) return '-';
  const lower = text.toLowerCase();
  if (PHASES.has(lower)) return lower;
  return '[invalid]';
}

export function sanitizeSessionId(value, maxLength = 8) {
  const text = asText(value);
  if (!text) return null;
  const base = SAFE_TOKEN_RE.test(text) ? text : text.toLowerCase().replace(/[^a-z0-9-]/g, '?');
  return base.slice(0, maxLength) || null;
}

/**
 * R4-02: the host already constrains a session id to `[a-z0-9-]`, and operators
 * match receipts against the real id (UUIDs are 36 characters). Echo a legal id
 * in full. Only a value that fails the whitelist is sanitised — and only that
 * faulty value is cut to the short display budget.
 */
export function displaySessionId(value) {
  const text = asText(value);
  if (!text) return null;
  if (SAFE_TOKEN_RE.test(text)) return text;
  return sanitizeSessionId(text);
}

/** Keep a token safe for a file name and for one audit/log line. */
function sanitizeFileToken(value) {
  const text = asText(value) ?? 'unknown';
  const replaced = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
  return (replaced || 'unknown').slice(0, 80);
}

export function surgeryStatePath(memoryRoot) {
  return path.join(longliveDir(memoryRoot), SURGERY_STATE_FILENAME);
}

export function recoveryReportPath(memoryRoot, now = new Date()) {
  const dir = reportsDir(memoryRoot);
  const base = path.join(dir, `surgery-recovery-${stampToken(now)}`);
  let file = `${base}.json`;
  // Two activations in the same millisecond are unlikely but not impossible.
  // Never overwrite an earlier report: each start earns its own evidence file.
  for (let suffix = 2; fs.existsSync(file); suffix += 1) file = `${base}-${suffix}.json`;
  return file;
}

function asText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function versionOf(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (value && typeof value === 'object' && typeof value.version === 'string' && value.version.trim() !== '') {
    return value.version.trim();
  }
  return null;
}

function countOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function messageCount(events) {
  try {
    return foldSurface(events).filter((node) => MESSAGE_TYPES.has(node.type)).length;
  } catch {
    return null;
  }
}

/** Read the stage file without throwing. Missing is a normal, zero-cost state. */
export function readSurgeryState(memoryRoot) {
  const file = surgeryStatePath(memoryRoot);
  let exists = false;
  try {
    exists = fs.existsSync(file);
  } catch {
    exists = false;
  }
  if (!exists) return { exists: false, path: file, state: null, error: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      exists: true,
      path: file,
      state: null,
      error: { code: 'SURGERY_STATE_UNREADABLE', message: `${file}: ${error?.code ?? error?.message ?? error}` },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      exists: true,
      path: file,
      state: null,
      error: { code: 'SURGERY_STATE_CORRUPT', message: `${file}: ${error?.message ?? error}` },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      exists: true,
      path: file,
      state: null,
      error: { code: 'SURGERY_STATE_CORRUPT', message: `${file}: state must be a JSON object` },
    };
  }
  return { exists: true, path: file, state: parsed, error: null };
}

function snapshotFromState(state) {
  // A written in-conversation receipt moves the expected snapshot forward: the
  // session now legitimately carries one extra user/message event.
  const receiptSnapshot = state?.receipt?.written === true ? state?.receipt?.after : null;
  const candidates = [
    ['receipt', receiptSnapshot],
    ['after', state?.after],
    ['after', state?.cut?.after],
    ['after', state?.cut?.cli?.after],
    ['after', state?.cut?.cli?.json?.after],
    ['before', state?.before],
  ];
  for (const [kind, value] of candidates) {
    if (value && typeof value === 'object' && asText(value.sha256)) {
      return { kind, snapshot: value };
    }
  }
  return { kind: null, snapshot: null };
}

function readBackRecorded(state) {
  const flags = [
    state?.cut?.verify?.ok,
    state?.cut?.readBack?.ok,
    state?.verify?.ok,
    state?.after?.verified,
  ];
  return flags.some((value) => value === true);
}

function sessionInfo(sessionPath) {
  const info = {
    exists: false,
    readable: false,
    bytes: null,
    sha256: null,
    events: null,
    messages: null,
    error: null,
  };
  if (!asText(sessionPath)) {
    info.error = { code: 'SESSION_PATH_MISSING', message: 'state 里没有 sessionPath' };
    return info;
  }
  let stat;
  try {
    stat = fs.statSync(sessionPath);
  } catch (error) {
    info.error = { code: 'SESSION_MISSING', message: `${sessionPath}: ${error?.code ?? error?.message ?? error}` };
    return info;
  }
  if (!stat.isFile()) {
    info.error = { code: 'SESSION_NOT_A_FILE', message: `${sessionPath}: not a regular file` };
    return info;
  }
  info.exists = true;
  info.bytes = stat.size;
  let buf;
  try {
    buf = fs.readFileSync(sessionPath);
  } catch (error) {
    info.error = { code: 'SESSION_UNREADABLE', message: `${sessionPath}: ${error?.code ?? error?.message ?? error}` };
    return info;
  }
  info.sha256 = sha256(buf);
  try {
    const parsed = parseSession(buf);
    info.readable = true;
    info.events = parsed.events.length;
    info.messages = messageCount(parsed.events);
  } catch (error) {
    info.error = { code: 'SESSION_UNREADABLE', message: `${sessionPath}: ${error?.message ?? error}` };
  }
  return info;
}

function backupInfo(state) {
  const info = { path: asText(state?.backup?.path), exists: false, sha256: null, expected: null, error: null };
  if (!info.path) {
    info.error = { code: 'BACKUP_NOT_RECORDED', message: 'state 里没有 backup.path' };
    return info;
  }
  info.expected = asText(state?.backup?.sha256);
  try {
    const stat = fs.statSync(info.path);
    if (!stat.isFile()) {
      info.error = { code: 'BACKUP_MISSING', message: `${info.path}: not a regular file` };
      return info;
    }
    info.exists = true;
  } catch (error) {
    info.error = { code: 'BACKUP_MISSING', message: `${info.path}: ${error?.code ?? error?.message ?? error}` };
    return info;
  }
  try {
    info.sha256 = sha256File(info.path);
  } catch (error) {
    info.error = { code: 'BACKUP_UNREADABLE', message: `${info.path}: ${error?.code ?? error?.message ?? error}` };
  }
  return info;
}

function emptyReport({ memoryRoot, statePath, now, loadedVersion, loadedHostVersion, stateRead }) {
  return {
    version: 1,
    kind: 'surgery-recovery',
    at: new Date(now).toISOString(),
    memoryRoot,
    statePath,
    surgeryId: null,
    statePhase: null,
    stateError: stateRead?.error ?? null,
    classification: CLASSIFICATIONS.NEEDS_ATTENTION,
    reasonCode: RECOVERY_REASON.STATE_UNREADABLE,
    ok: false,
    checks: {},
    recommendation: '',
    actions: [],
    evidence: {},
    loadedVersion: versionOf(loadedVersion),
    loadedHostVersion: versionOf(loadedHostVersion),
  };
}

function verdict(report, classification, reasonCode) {
  report.classification = classification;
  report.reasonCode = reasonCode;
  report.ok = classification !== CLASSIFICATIONS.NEEDS_ATTENTION;
  return report;
}

/**
 * Build (but do not write) the recovery verdict for one stage file.
 *
 * Pure with respect to project state: it reads the session, backup and state
 * file, and returns a report object. Writing is a separate, explicit step.
 */
export function buildRecoveryReport(options = {}) {
  const {
    memoryRoot,
    now = new Date(),
    loadedVersion = VERSION,
    loadedHostVersion = null,
    stateRead = readSurgeryState(memoryRoot),
    statePath = stateRead?.path ?? surgeryStatePath(memoryRoot),
  } = options;

  const report = emptyReport({ memoryRoot, statePath, now, loadedVersion, loadedHostVersion, stateRead });

  if (!stateRead?.exists) {
    report.reasonCode = 'NO_STATE';
    report.summary = '没有发现手术状态文件：上次没有跑过无人值守手术（或状态已被清理）。';
    return report;
  }
  if (stateRead.error || !stateRead.state) {
    report.stateError = stateRead.error ?? { code: 'SURGERY_STATE_CORRUPT', message: 'state is empty' };
    report.recommendation =
      '手术状态文件读不出来，无法判断上次手术停在哪一步。先看 .longlive/logs/surgery.log 的最后几行，' +
      '再人工核对会话文件的 sha256 与旁边的备份；确认之前不要重剪。';
    report.actions = [
      `查看 ${report.statePath}`,
      '查看 .longlive/logs/surgery.log 的末尾',
      '会话文件与备份都在原位时，可把 state 移到别处后重跑手术',
    ];
    return report;
  }

  const state = stateRead.state;
  const phase = asText(state.phase);
  const checks = {
    stateReadable: true,
    stateKind: state.kind ?? null,
    stateVersion: state.version ?? null,
    phase,
    phaseKnown: phase != null && PHASES.has(phase),
    sessionId: asText(state.sessionId),
    sessionPath: asText(state.sessionPath),
    expectedKind: null,
    expectedSha256: null,
    expectedBytes: null,
    expectedEvents: null,
    expectedMessages: null,
    cutOutcome: asText(state?.cut?.outcome) ?? asText(state?.done?.outcome),
    sessionExists: false,
    sessionReadable: false,
    sessionBytes: null,
    sessionSha256: null,
    sessionEvents: null,
    sessionMessages: null,
    shaMatch: null,
    beforeBytes: countOf(state?.before?.bytes),
    beforeEvents: countOf(state?.before?.events),
    beforeMessages: countOf(state?.before?.messages),
    beforeSha256: asText(state?.before?.sha256),
    sizeMatch: null,
    countsMatch: null,
    backupPath: asText(state?.backup?.path),
    backupExists: false,
    backupExpectedSha256: asText(state?.backup?.sha256),
    backupSha256: null,
    backupShaMatch: null,
    readBackRecorded: readBackRecorded(state),
    receiptWritten: state?.receipt?.written === true,
    receiptSeq: countOf(state?.receipt?.seq),
    receiptAt: asText(state?.receipt?.at),
    receiptEventId: asText(state?.receipt?.eventId),
    versionRecorded: versionOf(state.pluginVersion),
    versionLoaded: versionOf(loadedVersion),
    versionMatch: null,
    hostVersionRecorded: versionOf(state.hostVersion),
    hostVersionLoaded: versionOf(loadedHostVersion),
    hostVersionMatch: null,
  };
  report.checks = checks;
  report.surgeryId = asText(state.surgeryId);
  report.sessionId = asText(state.sessionId);
  report.statePhase = phase;
  report.startedAt = asText(state.startedAt);
  report.updatedAt = asText(state.updatedAt);
  report.dryRun = state.dryRun === true || phase === 'dryrun';
  // R2-02: a done state is only truly finished when the receipt was written.
  // The fallback path reports it once; the marker makes later starts silent.
  // A dry run is not a surgery at all: it never needs a receipt.
  report.receiptFallbackNeeded = phase === 'done' && report.dryRun !== true && checks.receiptWritten !== true;
  report.receiptFallbackInjected = state?.receipt?.fallbackInjected === true;

  // R3-01: a dry run is a rehearsal, not a surgery. It has no backup and no
  // after-snapshot by design, so none of the real checks below may run against
  // it — otherwise a rehearsal is reported as BACKUP_MISSING / needs-attention
  // and the operator is told not to re-cut. Return the boring verdict instead.
  if (report.dryRun || phase === 'dryrun') {
    report.dryRun = true;
    verdict(report, CLASSIFICATIONS.ABORTED_BEFORE_CUT, RECOVERY_REASON.OK_DRYRUN);
    report.recommendation =
      '上次是 -DryRun 演练：只校验了参数并记了手术前快照，没有关闭宿主、没有剪切任何字节，也没有手术回执。' +
      '这不是失败，不需要处理；要真正截断时去掉 -DryRun 重跑即可。';
    report.actions = ['无需操作', '要真正截断时去掉 -DryRun 重跑'];
    return report;
  }

  // rc.6 / R4-03: the executor now has a distinct terminal state for "the CLI
  // exited 0 but printed unparseable stdout, and the independent read-back did
  // NOT prove the cut". It must not be mistaken for an ordinary failed run:
  // the report answers needs-attention with the executor's own error code, and
  // the operator is told to check the files instead of re-cutting.
  if (phase === 'needs-attention' || (state.needsAttention && typeof state.needsAttention === 'object')) {
    const info = state.needsAttention ?? {};
    const code = asText(info.code) ?? RECOVERY_REASON.CUT_UNVERIFIED;
    checks.needsAttentionCode = code;
    checks.needsAttentionPhase = asText(info.phase);
    checks.needsAttentionMessage = asText(info.message);
    checks.needsAttentionChecks = info.checks ?? null;
    verdict(report, CLASSIFICATIONS.NEEDS_ATTENTION, code);
    report.recommendation =
      '剪切结果没能确认：CLI 输出读不出来，独立读回核验也没有通过。先不要重剪，' +
      '核对会话文件与手术前备份的大小和 sha256，再看日志里的原始输出。';
    report.actions = [
      '核对会话文件与 .pre-surgery 备份的大小、sha256',
      '查看 .longlive/logs/surgery.log 与同目录 node-*.utf8.txt 的原始输出',
      '确认会话完整后，把 state 里的 needsAttention 清掉再重跑',
    ];
    return report;
  }

  if (checks.versionRecorded && checks.versionLoaded) {
    checks.versionMatch = checks.versionRecorded === checks.versionLoaded;
  }
  if (checks.hostVersionRecorded && checks.hostVersionLoaded) {
    checks.hostVersionMatch = checks.hostVersionRecorded === checks.hostVersionLoaded;
  }

  const expected = snapshotFromState(state);
  checks.expectedKind = expected.kind;
  if (expected.snapshot) {
    checks.expectedSha256 = asText(expected.snapshot.sha256);
    checks.expectedBytes = countOf(expected.snapshot.bytes);
    checks.expectedEvents = countOf(expected.snapshot.events);
    checks.expectedMessages = countOf(expected.snapshot.messages);
  }
  report.evidence = {
    sessionPath: checks.sessionPath,
    expectedKind: checks.expectedKind,
    expectedSha256: checks.expectedSha256,
    backupPath: checks.backupPath,
    readBackRecorded: checks.readBackRecorded,
  };

  if (!checks.phaseKnown) {
    report.reasonCode = RECOVERY_REASON.STATE_INVALID;
    report.recommendation =
      `手术状态文件里的 phase=${JSON.stringify(phase)} 不是已知阶段（prepare/backup/cut/restart/receipt-pending/done/failed/dryrun）。` +
      '先人工核对会话文件的 sha256 和备份，再决定是否重跑；不要自动重剪。';
    report.actions = ['核对 state 文件是否被手工改过', '核对会话文件与备份的 sha256'];
    return report;
  }
  if (!checks.sessionPath) {
    report.reasonCode = RECOVERY_REASON.STATE_INVALID;
    report.recommendation = '手术状态文件里没有 sessionPath，无法核对会话；先人工确认目标是哪个会话文件。';
    report.actions = ['补看 .longlive/logs/surgery.log 里的 session= 行'];
    return report;
  }

  const session = sessionInfo(checks.sessionPath);
  Object.assign(checks, {
    sessionExists: session.exists,
    sessionReadable: session.readable,
    sessionBytes: session.bytes,
    sessionSha256: session.sha256,
    sessionEvents: session.events,
    sessionMessages: session.messages,
  });
  report.evidence.sessionBytes = session.bytes;
  report.evidence.sessionSha256 = session.sha256;
  report.evidence.sessionEvents = session.events;
  report.evidence.sessionMessages = session.messages;
  if (session.error) report.evidence.sessionError = session.error;

  if (!session.exists) {
    report.reasonCode = RECOVERY_REASON.SESSION_MISSING;
    report.recommendation =
      `会话文件 ${checks.sessionPath} 不在了。手术不会删会话，这通常说明它被挪走/改名，或 state 已经过期。` +
      '先找到会话文件和它的备份，再决定下一步；不要重剪。';
    report.actions = [`确认 ${checks.sessionPath} 是否被移动`, `确认备份 ${checks.backupPath ?? '(未记录)'} 是否还在`];
    return report;
  }
  if (!session.readable) {
    report.reasonCode = RECOVERY_REASON.SESSION_UNREADABLE;
    report.recommendation =
      '会话文件存在，但解析不了（不是合法的 v4 会话日志，或写坏了）。不要再跑任何写操作；' +
      '先用备份和旁边同名的 .bak-* 做只读比对，必要时人工恢复。';
    report.actions = ['对会话文件做一份只读副本', '用 pre-surgery 备份比对大小与 sha256', '确认损坏前不要重剪'];
    return report;
  }

  if (checks.expectedSha256) {
    checks.shaMatch = session.sha256 === checks.expectedSha256;
    report.evidence.expectedBytes = checks.expectedBytes;
    report.evidence.expectedEvents = checks.expectedEvents;
    report.evidence.expectedMessages = checks.expectedMessages;
  }
  if (checks.expectedBytes != null) checks.sizeMatch = session.bytes === checks.expectedBytes;
  if (checks.expectedEvents != null) checks.eventsMatch = session.events === checks.expectedEvents;
  if (checks.expectedMessages != null) checks.messagesMatch = session.messages === checks.expectedMessages;
  if (checks.expectedEvents == null && checks.expectedMessages == null) {
    checks.countsMatch = null;
  } else {
    checks.countsMatch =
      (checks.expectedEvents == null || checks.eventsMatch === true) &&
      (checks.expectedMessages == null || checks.messagesMatch === true);
  }

  // Backup is required from the moment the launcher starts copying it. In the
  // `prepare` stage it may legitimately not exist yet.
  const backup = backupInfo(state);
  Object.assign(checks, {
    backupExists: backup.exists,
    backupSha256: backup.sha256,
  });
  if (backup.error) report.evidence.backupError = backup.error;
  if (backup.exists && backup.expected) checks.backupShaMatch = backup.sha256 === backup.expected;

  const cutRecorded = (expected.kind === 'after' || expected.kind === 'receipt') && checks.expectedSha256 != null;
  const backupRequired = phase !== 'prepare';

  // R2-06: a noop run never cut anything. It must never be reported as
  // "cut applied" just because after === before and verify.ok was set to true.
  if (cutRecorded && checks.cutOutcome === 'noop') {
    if (checks.shaMatch === false || checks.sizeMatch === false || checks.countsMatch === false) {
      report.reasonCode = RECOVERY_REASON.NOOP_SESSION_CHANGED;
      report.recommendation =
        'state 说这次手术判定「无需截断」，但磁盘上的会话与手术前快照不一致。' +
        '没有执行过剪切却出现变化，通常是宿主正常写入或外部改过文件；先只读核对，不要把它当成一次成功的截断。';
      report.actions = ['停宿主后重新跑一次 surgery-inspect.mjs --recover-report', '不要重剪'];
      return report;
    }
    verdict(report, CLASSIFICATIONS.ABORTED_BEFORE_CUT, RECOVERY_REASON.OK_NOOP);
    report.recommendation =
      '这次手术判定无需截断：会话没有发生剪切，文件保持手术前状态。' +
      '不需要重剪；如果之后真的需要压缩，再重新跑手术即可。';
    report.actions = ['无需操作'];
    return report;
  }

  if (cutRecorded) {
    if (checks.shaMatch === false) {
      report.reasonCode = RECOVERY_REASON.SESSION_SHA_MISMATCH;
      report.recommendation =
        'stage 文件说剪切已经完成，但磁盘上会话的 sha256 与记录的 after 不一致。' +
        '这可能是宿主重启后又写了新内容，也可能是文件被替换/恢复过。先只读核对，不要重剪；' +
        '把宿主停掉后再比对备份与当前文件。';
      report.actions = [
        '停宿主后重新跑一次 scripts/surgery-inspect.mjs --recover-report，排除“运行中还在写”',
        `比对当前文件与备份 ${checks.backupPath ?? '(未记录)'}`,
        '确认是新写入还是异常替换，再决定是否重剪',
      ];
      return report;
    }
    if (checks.sizeMatch === false || checks.countsMatch === false) {
      report.reasonCode = RECOVERY_REASON.SESSION_COUNTS_MISMATCH;
      report.recommendation =
        '会话 sha256 对得上，但字节数/事件数/消息数与记录不一致。先按证据文件逐项核对；' +
        'sha 一致时通常说明 state 里的计数写错了，而不是会话被改坏。';
      report.actions = ['打开 recovery 报告核对 checks 各字段', '不要重剪'];
      return report;
    }
    if (backupRequired && !backup.exists) {
      report.reasonCode = RECOVERY_REASON.BACKUP_MISSING;
      report.recommendation =
        '剪切已完成，但 prep 备份不见了。会话可能没问题，但一旦需要回滚就没有退路。' +
        '先找回备份（旁边同名的 .pre-surgery-* / .bak-*），找不到就不要再动这个会话。';
      report.actions = [`在会话目录里找 ${path.basename(checks.sessionPath)}.pre-surgery-*`, '找到前不要重剪'];
      return report;
    }
    if (backup.exists && checks.backupShaMatch === false) {
      report.reasonCode = RECOVERY_REASON.BACKUP_SHA_MISMATCH;
      report.recommendation =
        '剪切已完成，但备份文件的 sha256 与记录不一致——备份可能被改过或拷坏了。' +
        '先只读核对备份，不要把它当回滚依据；会话本身仍以 sha 校验结果为准。';
      report.actions = ['核对备份文件的大小与 sha256', '另找一份更早的 .bak-* 作为退路'];
      return report;
    }
    if (checks.readBackRecorded) {
      // rc.6: `applied-unparsed` is a real, verified cut whose only anomaly was
      // the CLI's stdout; keep it visible as its own verdict so the receipt and
      // the logs agree, instead of pretending the stdout was fine.
      const unparsed = checks.cutOutcome === 'applied-unparsed';
      verdict(
        report,
        unparsed ? CLASSIFICATIONS.APPLIED_UNPARSED : CLASSIFICATIONS.APPLIED_VERIFIED,
        unparsed ? RECOVERY_REASON.OK_UNPARSED : RECOVERY_REASON.OK_VERIFIED,
      );
      report.recommendation = unparsed
        ? '上次手术的 CLI 输出编码异常（GBK 控制台读不了 UTF-8 的 JSON），但脚本用独立读回核验确认了剪切落盘：' +
          '会话 sha256、事件数、消息数与记录一致，备份也在。不需要重剪。'
        : '上次手术已经落盘并通过读回校验：会话 sha256、事件数、消息数与 state 记录一致，备份也在。' +
          '不需要重剪。若要回滚，先停宿主，再用备份覆盖会话文件。';
      report.actions = unparsed
        ? ['无需操作（applied-unparsed 已核验）', '需要回滚时先停宿主，再用备份覆盖会话文件']
        : ['无需操作', '需要回滚时先停宿主，再用备份覆盖会话文件'];
    } else {
      verdict(report, CLASSIFICATIONS.APPLIED_UNVERIFIED, RECOVERY_REASON.OK_UNVERIFIED);
      report.recommendation =
        '会话文件已经是剪切后的样子，但 state 里没有留下读回校验记录（脚本在 cut 之后、记录 verify 之前被杀）。' +
        '当前这次只读检查已经核对 sha256 与备份；确认宿主能正常加载后，不需要重剪。';
      report.actions = ['确认宿主能正常打开这个会话', '保留 state 作为回执；不要重剪'];
    }
    if (checks.versionMatch === false) {
      report.recommendation +=
        ` 注意：记录的手术插件版本是 ${checks.versionRecorded}，当前加载的是 ${checks.versionLoaded}；` +
        '截断本身已核对，版本变化只影响回执的解释。';
    }
    if (checks.hostVersionMatch === false) {
      report.recommendation +=
        ` 宿主版本也变了（记录 ${checks.hostVersionRecorded}，当前 ${checks.hostVersionLoaded}），` +
        '如果会话能正常打开就不用处理。';
    }
    return report;
  }

  // No after snapshot: the cut never recorded a result.
  const beforeSha = asText(state?.before?.sha256);
  const matchesBefore = beforeSha != null && session.sha256 === beforeSha;
  const cutAttempted =
    phase === 'cut' ||
    phase === 'restart' ||
    phase === 'receipt-pending' ||
    (state?.cut && (state.cut.exitCode !== undefined || state.cut.startedAt != null));

  if (cutAttempted || phase === 'failed') {
    if (matchesBefore && backup.exists) {
      verdict(report, CLASSIFICATIONS.ABORTED_BEFORE_CUT, RECOVERY_REASON.OK_ABORTED);
      report.recommendation =
        '上次手术在真正剪切之前就停了：会话文件仍与 before 快照一致，备份也完整。' +
        '可以直接重跑无人值守手术；重跑前先看 surgery.log 的最后一行，弄清上次为什么断。';
      report.actions = ['查看 .longlive/logs/surgery.log 末尾', '确认宿主已退出后重跑手术'];
      return report;
    }
    if (matchesBefore && !backup.exists) {
      report.reasonCode = RECOVERY_REASON.BACKUP_MISSING;
      report.recommendation =
        '会话仍是手术前状态，但这次手术应该已经做过备份却没有找到备份文件。' +
        '先找回备份或确认这次没有真正开始，再重跑；不要在没有退路的情况下动手术。';
      report.actions = ['在会话目录里找 .pre-surgery-* 备份', '确认后重跑'];
      return report;
    }
    report.reasonCode = RECOVERY_REASON.CUT_RESULT_MISSING;
    report.recommendation =
      'stage 文件停在 cut/restart，但没有记录 after 结果，而磁盘上的会话已经和 before 不一样了。' +
      '这说明剪切很可能已经执行，只是脚本在写回执前被杀。先只读核对当前 sha、备份和 archive 目录；' +
      '不要重剪，确认后再手工把 state 的 phase 改成 done（或保留报告作回执）。';
    report.actions = [
      '核对会话目录下的 .bak-* 与 .archive 产物',
      `比对当前 sha256 ${session.sha256} 与 before ${beforeSha ?? '(未记录)'}`,
      '确认新会话能被宿主加载后，再决定是否手工收尾',
    ];
    return report;
  }

  // prepare / backup (or failed before the cut): the safe abort case.
  if (matchesBefore) {
    if (!backup.exists && phase !== 'prepare') {
      report.reasonCode = RECOVERY_REASON.BACKUP_MISSING;
      report.recommendation =
        '手术在剪切前停了，但阶段已经是 backup/之后，却没有找到备份文件。先找回备份再重跑。';
      report.actions = ['在会话目录里找 .pre-surgery-* 备份'];
      return report;
    }
    if (backup.exists && checks.backupShaMatch === false) {
      report.reasonCode = RECOVERY_REASON.BACKUP_SHA_MISMATCH;
      report.recommendation = '手术在剪切前停了，但备份文件的 sha256 与记录不一致；先核对备份再重跑。';
      report.actions = ['核对备份 sha256'];
      return report;
    }
    verdict(report, CLASSIFICATIONS.ABORTED_BEFORE_CUT, RECOVERY_REASON.OK_ABORTED);
    report.recommendation =
      '上次手术在剪切前中止：会话文件仍是手术前状态，备份完整。重跑前看一眼 surgery.log 的末尾即可。';
    report.actions = ['查看 .longlive/logs/surgery.log 末尾', '确认宿主已退出后重跑手术'];
    return report;
  }

  report.reasonCode = RECOVERY_REASON.SESSION_CHANGED_BEFORE_CUT;
  report.recommendation =
    phase === 'prepare'
      ? 'stage 只到 prepare，但会话文件已经与 before 快照不一致。可能是记完 before 之后宿主又写了内容（正常），' +
        '也可能是别的进程动过文件。先只读核对；要重跑就让手术重新记一次 before。'
      : 'stage 说还在剪切前，但会话文件已经和 before 不一致。先只读核对，不要盲目重跑。';
  report.actions = ['停宿主后重新核对 sha256', '确认变化来自宿主正常写入还是外部替换'];
  return report;
}

function oneLine(report) {
  const parts = [
    `classification=${report.classification}`,
    `reason=${report.reasonCode}`,
    `phase=${sanitizePhase(report.statePhase)}`,
  ];
  if (report.surgeryId) parts.push(`surgery=${sanitizeFileToken(report.surgeryId)}`);
  if (report.dryRun === true) parts.push('dryRun=true');
  if (report.checks?.sessionSha256) parts.push(`sha=${report.checks.sessionSha256}`);
  return parts.join(' ');
}

/**
 * Write one report file and one audit line. The caller decides whether a check
 * is due; this function only persists evidence.
 */
export function writeRecoveryReport(memoryRoot, report, { now = new Date(), audit = true } = {}) {
  const file = recoveryReportPath(memoryRoot, now);
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const write = writeFileAtomic(memoryRoot, file, content, { backup: false, now });
  let auditLine = null;
  if (audit) {
    try {
      const entry = appendAudit(memoryRoot, {
        action: 'surgery-recovery',
        object: report.surgeryId ?? report.statePath ?? '-',
        result: `${report.classification} ${report.reasonCode}`,
        now,
      });
      auditLine = entry.line;
    } catch {
      // The report is the primary evidence; an append failure must not hide it.
      auditLine = null;
    }
  }
  return { path: write.path, sha256: write.sha256, bytes: write.bytes, auditLine };
}

/**
 * Startup entry point. Returns `checked: false` (and touches nothing beyond
 * one existsSync) when there is no stage file, when the last surgery is
 * `done` *and* its receipt was written, or when the fallback receipt was
 * already injected once. A `done` state without a written receipt falls
 * through so the caller can inject the fallback text exactly once.
 *
 * Never throws: activation must not fail because a post-mortem could not be
 * written. The caller still gets a structured result for logging/tests.
 */
export function checkSurgeryOnStart(options = {}) {
  const { memoryRoot, now = new Date(), loadedVersion = VERSION, loadedHostVersion = null } = options;
  if (!memoryRoot) return { checked: false, reason: 'no-memory-root' };
  const stateRead = readSurgeryState(memoryRoot);
  if (!stateRead.exists) return { checked: false, reason: 'no-state', statePath: stateRead.path };
  const state = stateRead.state;
  // R3-01: a -DryRun rehearsal is not a surgery. Return before reading the
  // session, writing a report, appending an audit line or producing receipt
  // text: there is nothing to recover and nothing to inject.
  if (state?.dryRun === true || asText(state?.phase) === 'dryrun') {
    return {
      checked: false,
      reason: 'dryrun',
      statePath: stateRead.path,
      surgeryId: asText(state.surgeryId),
      outcome: asText(state?.done?.outcome) ?? 'dry-run',
    };
  }
  if (state?.phase === 'done' && state?.receipt?.written === true) {
    return {
      checked: false,
      reason: 'phase-done',
      statePath: stateRead.path,
      surgeryId: asText(state.surgeryId),
      outcome: asText(state?.done?.outcome) ?? null,
    };
  }
  // R2-02 / minor: the fallback is injected once. The pre-step hook writes
  // this marker atomically after a successful injection; every later start
  // stays quiet instead of appending the same receipt again.
  if (state?.receipt?.fallbackInjected === true) {
    return {
      checked: false,
      reason: 'receipt-fallback-injected',
      statePath: stateRead.path,
      surgeryId: asText(state.surgeryId),
      outcome: asText(state?.done?.outcome) ?? null,
    };
  }
  const report = buildRecoveryReport({
    memoryRoot,
    now,
    loadedVersion,
    loadedHostVersion,
    stateRead,
  });
  let written = null;
  let writeError = null;
  try {
    written = writeRecoveryReport(memoryRoot, report, { now });
    report.reportPath = written.path;
    report.reportSha256 = written.sha256;
    report.auditLine = written.auditLine;
  } catch (error) {
    writeError = { code: error?.code ?? 'REPORT_WRITE_FAILED', message: error?.message ?? String(error) };
    report.reportWriteError = writeError;
  }
  return {
    checked: true,
    reason: 'recovered',
    statePath: stateRead.path,
    report,
    written,
    writeError,
    summary: oneLine(report),
  };
}

/**
 * Read-only CLI query. Never writes a report, never appends audit, never
 * touches the session. Returns a JSON-serialisable object with the last
 * surgery receipt (phase `done`) or the live recovery verdict.
 */
export function statusSurgery(options = {}) {
  const { memoryRoot, now = new Date(), loadedVersion = VERSION, loadedHostVersion = null } = options;
  if (!memoryRoot) {
    return { ok: false, found: false, status: 'no-memory-root', message: '没有记忆根目录，无法定位手术状态。' };
  }
  const stateRead = readSurgeryState(memoryRoot);
  if (!stateRead.exists) {
    return {
      ok: true,
      found: false,
      status: 'none',
      memoryRoot,
      statePath: stateRead.path,
      message: '没有发现手术状态文件：上次没有跑过无人值守手术。',
    };
  }
  if (stateRead.error || !stateRead.state) {
    const report = buildRecoveryReport({ memoryRoot, now, loadedVersion, loadedHostVersion, stateRead });
    return {
      ok: false,
      found: true,
      status: 'state-unreadable',
      memoryRoot,
      statePath: stateRead.path,
      stateError: stateRead.error,
      classification: report.classification,
      reasonCode: report.reasonCode,
      recommendation: report.recommendation,
      report,
    };
  }
  const state = stateRead.state;
  const lastSurgery = {
    surgeryId: asText(state.surgeryId),
    phase: asText(state.phase),
    startedAt: asText(state.startedAt),
    updatedAt: asText(state.updatedAt),
    sessionPath: asText(state.sessionPath),
    before: state.before ?? null,
    after: state.after ?? state.cut?.after ?? state.cut?.cli?.after ?? state.cut?.cli?.json?.after ?? null,
    backup: state.backup ?? null,
    outcome: asText(state?.done?.outcome),
    error: state.error ?? null,
  };
  if (state.dryRun === true || asText(state.phase) === 'dryrun') {
    return {
      ok: true,
      found: true,
      status: 'dryrun',
      memoryRoot,
      statePath: stateRead.path,
      classification: 'dry-run',
      reasonCode: RECOVERY_REASON.OK_DRYRUN,
      dryRun: true,
      lastSurgery,
      recommendation:
        '上次是 -DryRun 演练：没有关闭宿主、没有剪切任何字节，也没有手术回执可写。' +
        '状态正常，不需要处理；要真正截断时去掉 -DryRun 重跑。',
      reportPath: asText(state?.done?.resultPath),
    };
  }
  if (state.phase === 'done' && state?.receipt?.written === true) {
    const outcome = asText(state?.done?.outcome);
    const noop = outcome === 'noop';
    return {
      ok: true,
      found: true,
      status: 'done',
      memoryRoot,
      statePath: stateRead.path,
      classification: noop ? CLASSIFICATIONS.ABORTED_BEFORE_CUT : outcome ?? CLASSIFICATIONS.APPLIED_VERIFIED,
      reasonCode: noop ? RECOVERY_REASON.OK_NOOP : RECOVERY_REASON.OK_VERIFIED,
      lastSurgery,
      recommendation: noop
        ? `上次手术已完成（${asText(state?.done?.at) ?? asText(state.updatedAt) ?? '时间未记录'}），` +
          '但判定为无需截断：会话没有被剪切，文件保持手术前状态。这份查询不写任何文件。'
        : `上次手术已完成（${asText(state?.done?.at) ?? asText(state.updatedAt) ?? '时间未记录'}），` +
          '回执已写入会话正文。启动自检不会重复写报告；这份查询也不写任何文件。',
      reportPath: asText(state?.done?.resultPath),
    };
  }
  const report = buildRecoveryReport({ memoryRoot, now, loadedVersion, loadedHostVersion, stateRead });
  return {
    ok: report.ok,
    found: true,
    status: 'needs-review',
    memoryRoot,
    statePath: stateRead.path,
    classification: report.classification,
    reasonCode: report.reasonCode,
    recommendation: report.recommendation,
    actions: report.actions,
    lastSurgery,
    report,
  };
}

export function formatRecoveryReport(report) {
  return oneLine(report);
}

/**
 * Ensure the reports directory exists for a caller that is about to write a
 * report. Kept separate so a pure build/query never creates anything.
 */
export function ensureReportsDir(memoryRoot) {
  const dir = path.join(longliveDir(memoryRoot), REPORTS_DIR);
  ensureDir(memoryRoot, dir);
  return dir;
}

// ---------------------------------------------------------------------------
// In-conversation receipt (必修二)
//
// The launcher writes a visible receipt into the session log *after* the
// read-back passed and *before* the host is restarted, so the next time the
// session opens the conversation already carries the verdict as ordinary text.
// If that write never happened (failed/crashed run), the plugin's startup
// pre-step hook injects the same text on the next turn instead.
// ---------------------------------------------------------------------------

export const RECEIPT_PREFIX = '【手术回执】';
export const RECEIPT_SOURCE_KIND = 'user';

function formatCount(value) {
  if (!Number.isFinite(value)) return '?';
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function shortSha(value) {
  const text = asText(value);
  return text ? text.slice(0, 12) : '(未记录)';
}

// R2-01: the receipt is conversation text, never a diagnostic dump. It must
// not contain an absolute path (Windows drive, UNC, or a POSIX home path).
const ABSOLUTE_PATH_RE =
  /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|opt|root|mnt)\/)[^\s"'<>|，。；：）)】]*/g;

function receiptBasename(value) {
  const text = asText(value);
  if (!text) return null;
  const name = path.basename(text.replace(/[\\/]+$/, ''));
  return name || null;
}

/**
 * Strip absolute paths from free-form advice. Known session/backup paths are
 * replaced by their file name first so the sentence keeps its meaning; any
 * remaining absolute path becomes a placeholder.
 */
function sanitizeReceiptAdvice(value, { sessionPath, backupPath } = {}) {
  let text = asText(value);
  if (!text) return null;
  for (const candidate of [sessionPath, backupPath]) {
    const full = asText(candidate);
    if (!full) continue;
    const name = receiptBasename(full) ?? '（路径已隐藏）';
    text = text.split(full).join(name);
    text = text.split(full.replace(/\\/g, '/')).join(name);
  }
  return text.replace(ABSOLUTE_PATH_RE, '（路径已隐藏）');
}

/**
 * Compose the human-readable receipt. Numbers come from the recovery report:
 * before = state.before, after = the verified cut result (or the receipt
 * snapshot once it exists), so the text cannot disagree with the evidence file.
 */
export function receiptText(report, { appendingReceipt = false, seq = null } = {}) {
  const checks = report?.checks ?? {};
  const classification = report?.classification ?? CLASSIFICATIONS.NEEDS_ATTENTION;
  const reasonCode = report?.reasonCode ?? null;
  let verdict;
  if (reasonCode === RECOVERY_REASON.OK_NOOP) {
    verdict = '无需截断 —— 本次手术没有执行剪切，会话保持手术前状态。';
  } else if (classification === CLASSIFICATIONS.APPLIED_VERIFIED) {
    verdict = '成功 —— 剪切已落盘，读回校验通过，宿主已自动重启。';
  } else if (classification === CLASSIFICATIONS.APPLIED_UNPARSED) {
    // rc.6 / R4-03: Chinese stdout through a GBK console used to look like a
    // failure even though the cut was fine. Say plainly that it was verified.
    verdict = '成功 —— 剪切已落盘；CLI 输出编码异常（applied-unparsed），独立读回核验通过，宿主已自动重启。';
  } else if (classification === CLASSIFICATIONS.APPLIED_UNVERIFIED) {
    verdict = '已剪切，但没有留下读回校验记录（脚本在写完校验前被杀）。';
  } else if (classification === CLASSIFICATIONS.ABORTED_BEFORE_CUT) {
    verdict = '未执行 —— 在剪切前中止，会话文件仍保持原样。';
  } else {
    verdict = '需要注意 —— 没能确认剪切结果，先不要重剪。';
  }

  const lines = [`${RECEIPT_PREFIX}会话截断结果（无人值守手术）`, ''];
  lines.push(`结果：${verdict}`);
  const phase = sanitizePhase(report?.statePhase ?? checks.phase);
  lines.push(`停在哪：phase=${phase}${reasonCode ? `（reason=${reasonCode}）` : ''}`);
  // Filename only: never the absolute session path.
  const sessionName = receiptBasename(checks.sessionPath);
  if (sessionName) lines.push(`会话：${sessionName}`);
  // R3-04 / R4-02: only a [a-z0-9-] token may be echoed. A legal session id is
  // shown in full (operators match UUIDs, not their first 8 chars); a value
  // that fails the whitelist is still sanitised and shortened. `asText` alone
  // let a tampered state put `..\..\C:\Users\...` into the transcript.
  const sessionId = displaySessionId(asText(report?.sessionId) ?? asText(checks.sessionId));
  if (sessionId) lines.push(`会话 id：${sessionId}`);

  const beforeBytes = checks.beforeBytes;
  const afterBytes = checks.sessionBytes;
  if (Number.isFinite(beforeBytes) && Number.isFinite(afterBytes)) {
    const pct = beforeBytes > 0 ? (afterBytes / beforeBytes - 1) * 100 : null;
    // rc.6: a tiny session can legitimately grow after the cut, so an increase
    // must read as +x.x% instead of the old "--x.x%" double sign.
    const pctText = pct == null ? '' : `（${pct > 0 ? '+' : ''}${pct.toFixed(1)}%）`;
    lines.push(`字节：${formatCount(beforeBytes)} → ${formatCount(afterBytes)}${pctText}`);
  } else if (Number.isFinite(afterBytes)) {
    lines.push(`字节：? → ${formatCount(afterBytes)}`);
  }
  if (Number.isFinite(checks.beforeEvents) && Number.isFinite(checks.sessionEvents)) {
    lines.push(`事件：${formatCount(checks.beforeEvents)} → ${formatCount(checks.sessionEvents)}`);
  }
  if (Number.isFinite(checks.beforeMessages) && Number.isFinite(checks.sessionMessages)) {
    const after = checks.sessionMessages;
    const suffix = appendingReceipt ? `（本条回执另计 +1，写入后 ${formatCount(after + 1)}）` : '';
    lines.push(`消息：${formatCount(checks.beforeMessages)} → ${formatCount(after)}${suffix}`);
  }
  if (checks.shaMatch === true) {
    lines.push(`sha256：磁盘读回与记录一致 ✅（after ${shortSha(checks.expectedSha256)}）`);
  } else if (checks.shaMatch === false) {
    lines.push(
      `sha256：与记录不一致 ❌（记录 ${shortSha(checks.expectedSha256)}，磁盘 ${shortSha(checks.sessionSha256)}）`,
    );
  } else {
    lines.push('sha256：没有可比的记录（无法确认）');
  }
  const backupName = receiptBasename(checks.backupPath);
  if (backupName) {
    lines.push(`备份：${backupName}${checks.backupExists === false ? '（缺失）' : '（已保留）'}`);
  } else {
    lines.push('备份：(未记录)');
  }
  if (report?.receiptFallbackNeeded === true && !appendingReceipt) {
    lines.push('回执：state 停在 done，但没有写成回执；本条是启动兜底，只补写一次。');
  }
  if (appendingReceipt && seq != null) {
    lines.push(`本条回执已写入会话正文：seq=${seq}。`);
  } else {
    lines.push('回执来源：手术脚本没有写进会话，这条由插件在会话启动时按状态文件补写。');
  }
  const advice = sanitizeReceiptAdvice(report?.recommendation, {
    sessionPath: checks.sessionPath,
    backupPath: checks.backupPath,
  });
  if (advice) {
    lines.push('');
    lines.push(`建议：${advice}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Build the durable user/message event the host renders as conversation text. */
export function buildReceiptEvent({ text, seq, now = Date.now(), id }) {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    seq,
    time: now,
    data: {
      role: 'user',
      id,
      content: [{ type: 'text', text }],
      // A plain `user` source is what makes the host project this as visible
      // conversation text (kind `session-reference` would land in the context
      // rail instead, which is invisible in Chat).
      source: { kind: RECEIPT_SOURCE_KIND },
    },
  };
}

function writeSessionAtomic(sessionPath, buffer) {
  const tmp = `${sessionPath}.tmp-receipt-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const staged = fs.readFileSync(tmp);
  if (!staged.equals(buffer)) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new Error(`receipt temp write mismatch: ${tmp}`);
  }
  fs.renameSync(tmp, sessionPath);
  const back = fs.readFileSync(sessionPath);
  if (!back.equals(buffer)) throw new Error(`receipt read-back mismatch: ${sessionPath}`);
}

// R2-04: one writer at a time. The lock lives next to the state file and is
// deliberately short-lived; a crashed writer leaves a lock that goes stale
// after two minutes and is then replaced. The session append itself is still
// idempotent by scanning for the deterministic receipt event id, so a process
// killed between the append and the state write repairs the state on retry.
export const RECEIPT_LOCK_FILENAME = 'surgery-receipt.lock';
const RECEIPT_LOCK_STALE_MS = 2 * 60 * 1000;

function receiptLockPath(memoryRoot) {
  return path.join(longliveDir(memoryRoot), RECEIPT_LOCK_FILENAME);
}

function acquireReceiptLock(memoryRoot, now = new Date()) {
  if (!memoryRoot) return null;
  const lockPath = receiptLockPath(memoryRoot);
  const payload = `${JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      return {
        path: lockPath,
        release() {
          try {
            const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (holder?.pid === process.pid) fs.unlinkSync(lockPath);
          } catch {
            /* best effort; never delete a lock we cannot prove is ours */
          }
        },
      };
    } catch (error) {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      if (error?.code !== 'EEXIST') {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        throw error;
      }
      let stat = null;
      try {
        stat = fs.statSync(lockPath);
      } catch {
        continue;
      }
      if (Date.now() - stat.mtimeMs <= RECEIPT_LOCK_STALE_MS) return null;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* another process may have replaced it; try once more */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// R3-02: a durable trace when the state file itself cannot be rewritten
// ---------------------------------------------------------------------------
// When persistReceiptState fails after the receipt event is already inside the
// session, a retry must be able to *repair* the state instead of being blocked
// forever by a needs-attention report. A marker is written next to the state
// (and in the OS temp dir as a fallback when the memory root is unwritable),
// and the repair branch deletes it once the state carries the receipt.
export const RECEIPT_PENDING_DIR = 'receipts-pending';
export const RECEIPT_PENDING_TEMP_DIR = 'dsh-longlive-receipts-pending';
const RECEIPT_PENDING_KIND = 'longlive-surgery-receipt-pending';

function markerName(eventId) {
  const token = asText(eventId) ?? 'unknown';
  return `${sha256(Buffer.from(token, 'utf8')).slice(0, 16)}.json`;
}

export function receiptPendingMarkerPath(memoryRoot, eventId) {
  return path.join(longliveDir(memoryRoot), RECEIPT_PENDING_DIR, markerName(eventId));
}

export function receiptPendingTempMarkerPath(eventId) {
  return path.join(os.tmpdir(), RECEIPT_PENDING_TEMP_DIR, markerName(eventId));
}

function writeMarkerFile(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    const back = fs.readFileSync(file, 'utf8');
    if (back !== text) throw new Error(`marker read-back mismatch: ${file}`);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function writeReceiptPendingMarker({
  memoryRoot,
  eventId,
  sessionPath = null,
  receipt = null,
  error = null,
  now = new Date(),
} = {}) {
  const id = asText(eventId);
  if (!id) return { ok: false, code: 'MARKER_NO_EVENT_ID', written: [] };
  const slim = receipt && typeof receipt === 'object' ? { ...receipt } : null;
  if (slim) delete slim.text;
  const payload = {
    kind: RECEIPT_PENDING_KIND,
    version: 1,
    at: new Date(now).toISOString(),
    eventId: id,
    memoryRoot: asText(memoryRoot),
    statePath: memoryRoot ? surgeryStatePath(memoryRoot) : null,
    sessionPath: asText(sessionPath),
    receipt: slim,
    error: error == null ? null : String(error?.message ?? error),
  };
  const written = [];
  const errors = [];
  if (memoryRoot) {
    const file = receiptPendingMarkerPath(memoryRoot, id);
    try {
      writeMarkerFile(file, payload);
      written.push(file);
    } catch (failure) {
      errors.push({ path: file, message: String(failure?.message ?? failure) });
    }
  }
  const temp = receiptPendingTempMarkerPath(id);
  try {
    writeMarkerFile(temp, payload);
    written.push(temp);
  } catch (failure) {
    errors.push({ path: temp, message: String(failure?.message ?? failure) });
  }
  return {
    ok: written.length > 0,
    code: written.length > 0 ? 'MARKER_WRITTEN' : 'MARKER_WRITE_FAILED',
    written,
    errors,
  };
}

function readMarker(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.kind === RECEIPT_PENDING_KIND ? parsed : null;
  } catch {
    return null;
  }
}

function listMarkerFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export function readReceiptPendingMarkers({ memoryRoot } = {}) {
  const markers = [];
  const seen = new Set();
  if (memoryRoot) {
    const dir = path.join(longliveDir(memoryRoot), RECEIPT_PENDING_DIR);
    for (const name of listMarkerFiles(dir)) {
      const file = path.join(dir, name);
      const payload = readMarker(file);
      if (!payload || seen.has(payload.eventId)) continue;
      seen.add(payload.eventId);
      markers.push({ ...payload, path: file });
    }
  }
  const tempDir = path.join(os.tmpdir(), RECEIPT_PENDING_TEMP_DIR);
  for (const name of listMarkerFiles(tempDir)) {
    const file = path.join(tempDir, name);
    const payload = readMarker(file);
    if (!payload || seen.has(payload.eventId)) continue;
    // A temp marker belongs to exactly one memory root; never let another
    // profile's leftover marker repair this one.
    if (memoryRoot && asText(payload.memoryRoot) && !sameFilePath(payload.memoryRoot, memoryRoot)) continue;
    seen.add(payload.eventId);
    markers.push({ ...payload, path: file });
  }
  return markers.sort((left, right) => String(right.at).localeCompare(String(left.at)));
}

export function clearReceiptPendingMarker({ memoryRoot, eventId } = {}) {
  const removed = [];
  const files = [receiptPendingTempMarkerPath(eventId)];
  if (memoryRoot) files.unshift(receiptPendingMarkerPath(memoryRoot, eventId));
  for (const file of files) {
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch {
      /* absent is fine */
    }
  }
  return { ok: true, removed };
}

// ---------------------------------------------------------------------------
// R3-03: cross-process claim so two hosts never inject the fallback twice
// ---------------------------------------------------------------------------
// `agent/pre-step` runs the handler, then an async `await next()`; two hosts
// loading the same memory root can both reach the append. The claim is an
// exclusive-create lock carrying host + pid + timestamp, with a TTL so a
// crashed holder (or another machine) cannot wedge it forever.
export const FALLBACK_CLAIM_FILENAME = 'surgery-fallback-inject.lock';
export const FALLBACK_CLAIM_KIND = 'longlive-surgery-fallback-inject';
export const FALLBACK_CLAIM_TTL_MS = 60 * 1000;

function fallbackClaimPath(memoryRoot) {
  return path.join(longliveDir(memoryRoot), FALLBACK_CLAIM_FILENAME);
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function claimExpired(claim, now, ttlMs) {
  const at = Date.parse(claim?.at);
  if (!Number.isFinite(at)) return true;
  const age = new Date(now).getTime() - at;
  // Too old is stale; far in the future is a clock we cannot reason about.
  if (age > ttlMs || age < -ttlMs) return true;
  if (asText(claim?.host) === os.hostname() && !processAlive(claim?.pid)) return true;
  return false;
}

export function claimFallbackInjection({
  memoryRoot,
  now = new Date(),
  host = os.hostname(),
  pid = process.pid,
  ttlMs = FALLBACK_CLAIM_TTL_MS,
} = {}) {
  if (!memoryRoot) return { ok: false, code: 'NO_MEMORY_ROOT' };
  const file = fallbackClaimPath(memoryRoot);
  const claim = {
    kind: FALLBACK_CLAIM_KIND,
    host: String(host),
    pid: Number(pid),
    at: new Date(now).toISOString(),
    ttlMs: Number(ttlMs),
  };
  const payload = `${JSON.stringify(claim)}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* the open below reports the real failure */
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      return { ok: true, code: 'CLAIMED', path: file, claim };
    } catch (error) {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      if (error?.code !== 'EEXIST') {
        return { ok: false, code: 'CLAIM_WRITE_FAILED', path: file, message: String(error?.message ?? error) };
      }
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        holder = null;
      }
      if (holder && !claimExpired(holder, now, ttlMs)) {
        try {
          appendAudit(memoryRoot, {
            action: 'surgery-fallback-inject',
            object: `${asText(holder.host) ?? '?'}:${holder.pid ?? '?'}`,
            result: 'skipped-concurrent',
            now,
          });
        } catch {
          /* audit is best effort; the skip still happened */
        }
        return { ok: false, code: 'skipped-concurrent', path: file, holder };
      }
      try {
        fs.unlinkSync(file);
      } catch {
        /* another process replaced it; loop once more */
      }
    }
  }
  try {
    appendAudit(memoryRoot, { action: 'surgery-fallback-inject', object: '-', result: 'skipped-concurrent', now });
  } catch {
    /* ignore */
  }
  return { ok: false, code: 'skipped-concurrent', path: file, holder: null };
}

export function releaseFallbackInjectionClaim({ memoryRoot, claim } = {}) {
  if (!memoryRoot || !claim) return { ok: false, code: 'NO_CLAIM' };
  const file = fallbackClaimPath(memoryRoot);
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: true, released: false, reason: 'absent' };
  }
  const sameHolder =
    asText(holder?.host) === asText(claim.host) &&
    Number(holder?.pid) === Number(claim.pid) &&
    String(holder?.at) === String(claim.at);
  if (!sameHolder) return { ok: false, code: 'NOT_HOLDER', path: file };
  try {
    fs.unlinkSync(file);
    return { ok: true, released: true, path: file };
  } catch (error) {
    return { ok: false, code: 'RELEASE_FAILED', path: file, message: String(error?.message ?? error) };
  }
}

/**
 * R4-01: record why this host did not inject the fallback receipt after it had
 * already registered the hook. `skipped-concurrent` is written by the claim
 * itself; `skipped-already` is written here when the second state read (or the
 * atomic mark) shows another host/start already injected. Audit is best effort:
 * a broken audit log must never turn a safe skip into a failed turn.
 */
export function recordFallbackInjectionSkip({ memoryRoot, result = 'skipped-already', now = new Date() } = {}) {
  if (!memoryRoot) return { ok: false, code: 'NO_MEMORY_ROOT' };
  if (result !== 'skipped-concurrent' && result !== 'skipped-already') {
    return { ok: false, code: 'INVALID_RESULT' };
  }
  try {
    appendAudit(memoryRoot, { action: 'surgery-fallback-inject', object: 'state', result, now });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, code: 'AUDIT_WRITE_FAILED', message: String(error?.message ?? error) };
  }
}

function sameFilePath(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInsidePath(root, file) {
  if (!root || !file) return false;
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function receiptTextFromEvent(event) {
  const content = event?.data?.content;
  if (!Array.isArray(content)) return null;
  const block = content.find((item) => item?.type === 'text' && typeof item.text === 'string');
  return block?.text ?? null;
}

function persistReceiptState(memoryRoot, state, receipt, now, event) {
  const at = new Date(now).toISOString();
  const nextState = {
    ...state,
    receipt,
    updatedAt: at,
    history: [
      ...(Array.isArray(state.history) ? state.history : []),
      { phase: state.phase ?? null, at, event },
    ],
  };
  writeFileAtomic(memoryRoot, surgeryStatePath(memoryRoot), `${JSON.stringify(nextState, null, 2)}\n`, {
    backup: true,
    now,
  });
  return nextState;
}

/**
 * Record that the pre-step hook injected the fallback receipt once. Idempotent
 * and atomic: the second call returns `alreadyMarked` without touching the
 * state file. Never overwrites a real `receipt.written === true`.
 */
export function markReceiptFallbackInjected({ memoryRoot, now = new Date() } = {}) {
  if (!memoryRoot) return { ok: false, code: 'NO_MEMORY_ROOT' };
  const initial = readSurgeryState(memoryRoot);
  if (!initial.exists || !initial.state) return { ok: false, code: 'SURGERY_STATE_MISSING' };
  if (isDryRunState(initial.state)) return dryRunReceiptRefusal(memoryRoot);
  if (initial.state.receipt?.written === true) {
    return { ok: true, alreadyMarked: false, written: true, receipt: initial.state.receipt };
  }
  if (initial.state.receipt?.fallbackInjected === true) {
    return { ok: true, alreadyMarked: true, receipt: initial.state.receipt };
  }
  let lock = null;
  try {
    lock = acquireReceiptLock(memoryRoot, now);
  } catch (error) {
    return { ok: false, code: 'RECEIPT_LOCK_FAILED', message: String(error?.message ?? error) };
  }
  if (!lock) return { ok: false, code: 'RECEIPT_BUSY', message: '另一个进程正在写手术回执' };
  try {
    const stateRead = readSurgeryState(memoryRoot);
    if (!stateRead.exists || !stateRead.state) return { ok: false, code: 'SURGERY_STATE_MISSING' };
    const state = stateRead.state;
    if (state.receipt?.written === true) {
      return { ok: true, alreadyMarked: false, written: true, receipt: state.receipt };
    }
    if (state.receipt?.fallbackInjected === true) {
      return { ok: true, alreadyMarked: true, receipt: state.receipt };
    }
    const at = new Date(now).toISOString();
    const receipt = {
      ...(state.receipt && typeof state.receipt === 'object' ? state.receipt : {}),
      written: false,
      fallbackInjected: true,
      fallbackVia: 'plugin-pre-step',
      fallbackAt: at,
    };
    persistReceiptState(memoryRoot, state, receipt, now, 'receipt-fallback');
    return { ok: true, alreadyMarked: false, receipt };
  } catch (error) {
    return {
      ok: false,
      code: 'RECEIPT_STATE_WRITE_FAILED',
      message: `${surgeryStatePath(memoryRoot)}: ${error?.message ?? error}`,
    };
  } finally {
    lock.release();
  }
}

function isDryRunState(state) {
  return state?.dryRun === true || asText(state?.phase) === 'dryrun';
}

function dryRunReceiptRefusal(memoryRoot) {
  return {
    ok: false,
    code: 'E_RECEIPT_DRYRUN',
    message:
      '这不是真实手术：上次是 -DryRun 演练（没有关闭宿主、没有剪切字节、没有备份）。' +
      '没有回执可写，状态也不需要修复；要真正截断时去掉 -DryRun 重跑即可。',
    statePath: surgeryStatePath(memoryRoot),
    dryRun: true,
  };
}

/**
 * Append the visible receipt to the session and record it in the stage file.
 *
 * R2-04 single writer: a short-lived lock next to the state file serialises
 * launcher and plugin writers. Idempotent on two levels: `receipt.written`
 * short-circuits, and a retry after a state-write failure finds the already
 * appended deterministic event id and only repairs the state file.
 */
export function writeSurgeryReceipt({ sessionPath, memoryRoot, now = new Date(), via = 'surgery-script' } = {}) {
  if (!memoryRoot) return { ok: false, code: 'NO_MEMORY_ROOT', message: '缺少记忆根，无法定位 state' };
  const initial = readSurgeryState(memoryRoot);
  if (!initial.exists) {
    return { ok: false, code: 'SURGERY_STATE_MISSING', message: `没有 ${surgeryStatePath(memoryRoot)}` };
  }
  // R3-01: `--write-receipt` on a rehearsal is a category error, not a broken
  // surgery. Answer with a distinct code so scripts can tell the operator
  // "this was a dry run" instead of "永久拒绝 / 需要人工处理".
  if (isDryRunState(initial.state)) return dryRunReceiptRefusal(memoryRoot);
  if (initial.state?.receipt?.written === true) {
    return { ok: true, alreadyWritten: true, receipt: initial.state.receipt, text: asText(initial.state.receipt.text) };
  }

  let lock = null;
  try {
    lock = acquireReceiptLock(memoryRoot, now);
  } catch (error) {
    return { ok: false, code: 'RECEIPT_LOCK_FAILED', message: String(error?.message ?? error) };
  }
  if (!lock) {
    return { ok: false, code: 'RECEIPT_BUSY', message: '另一个进程正在写手术回执，稍后重试' };
  }
  try {
    return writeSurgeryReceiptLocked({ sessionPath, memoryRoot, now, via });
  } finally {
    lock.release();
  }
}

function writeSurgeryReceiptLocked({ sessionPath, memoryRoot, now, via }) {
  // Re-read under the lock: another writer may have finished between the
  // optimistic check above and lock acquisition.
  const stateRead = readSurgeryState(memoryRoot);
  if (!stateRead.exists || !stateRead.state) {
    return { ok: false, code: 'SURGERY_STATE_MISSING', message: `没有 ${surgeryStatePath(memoryRoot)}` };
  }
  const state = stateRead.state;
  if (isDryRunState(state)) return dryRunReceiptRefusal(memoryRoot);
  if (state.receipt?.written === true) {
    return { ok: true, alreadyWritten: true, receipt: state.receipt, text: asText(state.receipt.text) };
  }

  const candidate = asText(sessionPath);
  const stateSession = asText(state.sessionPath);
  // R3-02: a state write that failed may still have lost sessionPath with it;
  // a pending marker written at that moment carries the path forward.
  const pendingMarkers = readReceiptPendingMarkers({ memoryRoot });
  const markerSession = pendingMarkers.map((marker) => asText(marker.sessionPath)).find(Boolean) ?? null;
  const file = candidate ?? stateSession ?? markerSession;
  const fromMarker = !candidate && !stateSession && Boolean(markerSession);
  if (!file) return { ok: false, code: 'SESSION_PATH_MISSING', message: 'state 与会话参数里都没有 sessionPath' };

  // R2-05: only the current session (state.sessionPath) or another file inside
  // <DSH_HOME>/sessions carrying the same session id may receive a receipt.
  if (candidate && !sameFilePath(candidate, stateSession)) {
    if (!isInsidePath(path.join(dshHome(), 'sessions'), candidate)) {
      return {
        ok: false,
        code: 'E_RECEIPT_SESSION_OUTSIDE',
        message: '--write-receipt 只接受当前会话或 sessions 根内的会话文件',
      };
    }
    if (!stateSession) {
      return { ok: false, code: 'SESSION_PATH_MISSING', message: 'state 没有 sessionPath，无法确认目标会话' };
    }
  }

  let buffer;
  let parsed;
  try {
    buffer = fs.readFileSync(file);
    parsed = parseSession(buffer);
  } catch (error) {
    return { ok: false, code: 'SESSION_UNREADABLE', message: `${file}: ${error?.message ?? error}` };
  }
  if ((candidate && !sameFilePath(candidate, stateSession)) || fromMarker) {
    const expectedId = asText(state.sessionId);
    const actualId = asText(parsed.header?.id);
    if (!expectedId || actualId !== expectedId) {
      return {
        ok: false,
        code: 'E_RECEIPT_SESSION_MISMATCH',
        message: '目标会话的 header.id 与 state.sessionId 不一致',
      };
    }
  }

  // R3-02: scan for an already-appended receipt *before* the needs-attention
  // gate. When the append landed but the state write failed, the session
  // already holds the deterministic event and a marker sits on disk; blocking
  // on the report first made the repair branch unreachable and turned a
  // recoverable state into a permanent RECEIPT_BLOCKED_NEEDS_ATTENTION.
  const receiptKey =
    asText(state.surgeryId) ?? asText(state.startedAt) ?? asText(state.sessionId) ?? stampToken(now);
  const eventId = `surgery-receipt-${receiptKey}`;
  const existingIndex = parsed.events.findIndex(
    (event) => event?.type === 'user/message' && asText(event?.data?.id) === eventId,
  );

  if (existingIndex >= 0) {
    // The append landed but the state write did not. Repair the state instead
    // of appending a second receipt.
    const text = receiptTextFromEvent(parsed.events[existingIndex]);
    const messages = messageCount(parsed.events);
    const receipt = {
      written: true,
      via,
      at: new Date(now).toISOString(),
      sessionPath: file,
      seq: existingIndex,
      eventId,
      backupPath: null,
      text,
      after: {
        bytes: buffer.length,
        events: parsed.events.length,
        messages,
        sha256: sha256(buffer),
      },
      repairedState: true,
    };
    try {
      persistReceiptState(memoryRoot, state, receipt, now, 'receipt-repaired');
    } catch (error) {
      const marker = writeReceiptPendingMarker({
        memoryRoot,
        eventId,
        sessionPath: file,
        receipt: { ...receipt, stateWritten: false },
        error,
        now,
      });
      return {
        ok: false,
        code: 'RECEIPT_STATE_WRITE_FAILED',
        message: `${surgeryStatePath(memoryRoot)}: ${error?.message ?? error}`,
        receipt: { ...receipt, stateWritten: false },
        pendingMarker: marker.ok ? marker.written[0] ?? null : null,
        pendingMarkerError: marker.ok ? null : marker.errors?.[0]?.message ?? 'marker write failed',
      };
    }
    clearReceiptPendingMarker({ memoryRoot, eventId });
    return { ok: true, alreadyWritten: true, repairedState: true, receipt, text };
  }

  const report = buildRecoveryReport({ memoryRoot, now, stateRead });
  // R2-09: never turn a needs-attention state into a success receipt. The
  // state file is left untouched so the warning stays visible.
  if (report.classification === CLASSIFICATIONS.NEEDS_ATTENTION) {
    return {
      ok: false,
      code: 'RECEIPT_BLOCKED_NEEDS_ATTENTION',
      message: `上次手术结果异常（${report.reasonCode}），不能写成功回执；先人工核对`,
      classification: report.classification,
      reasonCode: report.reasonCode,
    };
  }

  const seq = parsed.events.length;
  const text = receiptText(report, { appendingReceipt: true, seq });
  const event = buildReceiptEvent({ text, seq, now: now.getTime(), id: eventId });

  let next;
  let verified;
  try {
    next = encodeSession(parsed.header, [...parsed.events, event]);
    verified = parseSession(next);
  } catch (error) {
    return { ok: false, code: 'RECEIPT_ENCODE_FAILED', message: String(error?.message ?? error) };
  }
  if (verified.events.length !== seq + 1) {
    return { ok: false, code: 'RECEIPT_VERIFY_FAILED', message: '回执写入后事件数不对' };
  }
  const messages = messageCount(verified.events);
  if (messages !== (messageCount(parsed.events) ?? 0) + 1) {
    return { ok: false, code: 'RECEIPT_VERIFY_FAILED', message: '回执写入后消息数不对' };
  }

  const stamp = stampToken(now);
  const backupPath = `${file}.bak-receipt-${stamp}`;
  try {
    fs.copyFileSync(file, backupPath);
  } catch (error) {
    return { ok: false, code: 'RECEIPT_BACKUP_FAILED', message: `${backupPath}: ${error?.message ?? error}` };
  }
  try {
    writeSessionAtomic(file, next);
  } catch (error) {
    try {
      fs.copyFileSync(backupPath, file);
    } catch {
      /* the backup path is reported below either way */
    }
    return { ok: false, code: 'RECEIPT_WRITE_FAILED', message: `${file}: ${error?.message ?? error}`, backupPath };
  }

  const receipt = {
    written: true,
    via,
    at: new Date(now).toISOString(),
    sessionPath: file,
    seq,
    eventId,
    backupPath,
    text,
    after: {
      bytes: next.length,
      events: verified.events.length,
      messages,
      sha256: sha256(next),
    },
  };
  try {
    persistReceiptState(memoryRoot, state, receipt, now, 'receipt');
  } catch (error) {
    // R3-02: leave a trace the next run can find, even though the state file
    // itself is unwritable right now.
    const marker = writeReceiptPendingMarker({
      memoryRoot,
      eventId,
      sessionPath: file,
      receipt: { ...receipt, stateWritten: false },
      error,
      now,
    });
    return {
      ok: false,
      code: 'RECEIPT_STATE_WRITE_FAILED',
      message: `${surgeryStatePath(memoryRoot)}: ${error?.message ?? error}`,
      receipt: { ...receipt, stateWritten: false },
      pendingMarker: marker.ok ? marker.written[0] ?? null : null,
      pendingMarkerError: marker.ok ? null : marker.errors?.[0]?.message ?? 'marker write failed',
    };
  }
  clearReceiptPendingMarker({ memoryRoot, eventId });

  return { ok: true, alreadyWritten: false, receipt, text };
}
