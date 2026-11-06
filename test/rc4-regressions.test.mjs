// rc.4 — red-team regressions R3-01 .. R3-04.
//
// R3-01  -DryRun used to write phase=done, so the next activation reported a
//        real surgery with BACKUP_MISSING and --write-receipt refused forever.
// R3-02  a failed state write left the repair branch unreachable behind the
//        needs-attention gate; the receipt is already in the session.
// R3-03  two hosts could inject the fallback receipt twice.
// R3-04  phase / sessionId from a state file were echoed into receipt text
//        without sanitising, so a tampered state could print a local path.
//
// Each case builds a throwaway memory root and a v4 session under os.tmpdir();
// nothing here touches a real session, the host, a profile or the network.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MESSAGE_TYPES, encodeSession, foldSurface, parseSession, sha256 } from '../src/codec.js';
import {
  CLASSIFICATIONS,
  RECOVERY_REASON,
  buildReceiptEvent,
  checkSurgeryOnStart,
  claimFallbackInjection,
  clearReceiptPendingMarker,
  markReceiptFallbackInjected,
  readReceiptPendingMarkers,
  readSurgeryState,
  receiptPendingMarkerPath,
  receiptText,
  releaseFallbackInjectionClaim,
  statusSurgery,
  surgeryStatePath,
  writeReceiptPendingMarker,
  writeSurgeryReceipt,
} from '../src/surgery-recovery.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_URL = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'surgery-recovery.js')).href;
const NOW = new Date('2026-11-04T06:30:00.000Z');

// ---------------------------------------------------------------------------
// Fixtures (same shape as test/surgery-recovery.test.mjs)
// ---------------------------------------------------------------------------

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-rc4-'));
  const sessionDir = path.join(root, 'sessions', 'scope-fixtures', 'surgery-fixture');
  fs.mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir, sessionPath: path.join(sessionDir, 'session.v4.jsonl.zstd') };
}

function buildSession({ turns = 20, pad = 120, id = 'surgery-fixture' } = {}) {
  const events = [];
  const base = 1_760_000_000_000;
  const push = (event) => {
    event.seq = events.length;
    event.time = base + events.length;
    events.push(event);
  };
  push({
    type: 'system/message',
    surfaceOp: 'append',
    data: {
      message: {
        role: 'system',
        id: 'system-1',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: `system ${'s'.repeat(pad)}` }],
      },
    },
  });
  for (let t = 1; t <= turns; t += 1) {
    push({ type: 'turn/start', data: { turn: t } });
    push({ type: 'step/start', data: { turn: t, step: 1 } });
    push({
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        turn: t,
        step: 1,
        role: 'user',
        id: `user-${t}`,
        content: [{ type: 'text', text: `question ${t} ${'q'.repeat(pad)}` }],
        source: { kind: 'user' },
      },
    });
    push({
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: t,
        step: 1,
        message: {
          role: 'assistant',
          id: `assistant-${t}`,
          content: [{ type: 'text', text: `answer ${t} ${'a'.repeat(pad)}` }],
        },
      },
    });
    push({ type: 'step/end', data: { turn: t, step: 1 } });
    push({ type: 'turn/end', data: { turn: t, reason: { kind: 'completed' } } });
  }
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: '2026-11-04T00:00:00.000Z',
    cwd: 'C:\\fixtures',
    isSeeded: false,
    delegationDepth: 0,
  };
  return encodeSession(header, events);
}

function snapshot(buf) {
  const parsed = parseSession(buf);
  return {
    bytes: buf.length,
    sha256: sha256(buf),
    events: parsed.events.length,
    messages: foldSurface(parsed.events).filter((node) => MESSAGE_TYPES.has(node.type)).length,
  };
}

function writeSession(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

function writeState(root, state) {
  fs.mkdirSync(path.join(root, '.longlive'), { recursive: true });
  fs.writeFileSync(surgeryStatePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

function writeBackup(file, buf) {
  fs.writeFileSync(file, buf);
  return { path: file, bytes: buf.length, sha256: sha256(buf) };
}

function stateBase(overrides = {}) {
  return {
    version: 1,
    kind: 'longlive-surgery',
    surgeryId: 'surgery-20261104-143000-001',
    phase: 'cut',
    startedAt: '2026-11-04T06:28:00.000Z',
    updatedAt: '2026-11-04T06:29:00.000Z',
    pid: 12345,
    sessionPath: null,
    sessionId: 'surgery-fixture',
    memoryRoot: null,
    appPath: 'C:\\Program Files\\DSH\\DSH.exe',
    keepTurns: 6,
    keepTokens: 40000,
    startDelaySeconds: 0,
    pluginVersion: '0.9.0-rc.4',
    hostVersion: '0.9.0',
    dryRun: false,
    before: null,
    backup: null,
    cut: null,
    after: null,
    verify: null,
    restart: null,
    done: null,
    error: null,
    history: [{ phase: 'prepare', at: '2026-11-04T06:28:00.000Z' }],
    ...overrides,
  };
}

/** A state that the launcher writes right before the restart (verified cut). */
function verifiedState(root, { sessionPath, beforeBuf, afterBuf, backupPath }) {
  const after = snapshot(afterBuf);
  return stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after,
    backup: { path: backupPath ?? `${sessionPath}.pre-surgery-20261104-143000`, bytes: beforeBuf.length, sha256: sha256(beforeBuf) },
    cut: { after, verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  });
}

function receiptEvents(buf) {
  return parseSession(buf).events.filter(
    (event) => event?.type === 'user/message' && String(event?.data?.id ?? '').startsWith('surgery-receipt-'),
  );
}

// ---------------------------------------------------------------------------
// R3-01 — a dry run is a rehearsal, never a fake surgery
// ---------------------------------------------------------------------------

test('R3-01: phase=dryrun is a no-op for the startup check, status stays ok and the receipt is refused as E_RECEIPT_DRYRUN', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 8, pad: 60 });
  writeSession(sessionPath, buf);
  const before = snapshot(buf);
  const ll = path.join(root, '.longlive');
  writeState(root, stateBase({
    phase: 'dryrun',
    dryRun: true,
    sessionPath,
    memoryRoot: root,
    before,
    done: { at: '2026-11-04T06:29:00.000Z', outcome: 'dry-run', resultPath: path.join(ll, 'reports', 'surgery-result-x.json') },
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.checked, false);
  assert.equal(result.reason, 'dryrun');
  assert.equal(result.outcome, 'dry-run');
  // Zero side effects: no report dir, no audit line, no injected text.
  assert.equal(fs.existsSync(path.join(ll, 'reports')), false, 'dry run must not write a recovery report');
  assert.equal(fs.existsSync(path.join(ll, 'audit.log')), false, 'dry run must not append an audit line');
  assert.deepEqual(snapshot(fs.readFileSync(sessionPath)), before);

  const status = statusSurgery({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(status.ok, true);
  assert.equal(status.status, 'dryrun');
  assert.equal(status.classification, 'dry-run');
  assert.equal(status.reasonCode, RECOVERY_REASON.OK_DRYRUN);
  assert.equal(status.dryRun, true);
  assert.match(status.recommendation, /演练/);

  const refused = writeSurgeryReceipt({ memoryRoot: root, now: NOW });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'E_RECEIPT_DRYRUN');
  assert.equal(refused.dryRun, true);
  assert.match(refused.message, /这不是真实手术/);
  assert.doesNotMatch(refused.message, /人工核对|永久/);
  assert.deepEqual(snapshot(fs.readFileSync(sessionPath)), before);

  // It is a refusal, not a lock: repeating it gives the same answer.
  const again = writeSurgeryReceipt({ memoryRoot: root, now: NOW });
  assert.equal(again.code, 'E_RECEIPT_DRYRUN');
});

test('R3-01: an rc.3 dry-run state (phase=done + dryRun=true) is recognised as a rehearsal', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 6, pad: 40 });
  writeSession(sessionPath, buf);
  writeState(root, stateBase({
    phase: 'done',
    dryRun: true,
    sessionPath,
    memoryRoot: root,
    before: snapshot(buf),
    done: { at: '2026-11-04T06:29:00.000Z', outcome: 'dry-run' },
    receipt: null,
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.checked, false);
  assert.equal(result.reason, 'dryrun');
  const refused = writeSurgeryReceipt({ memoryRoot: root, now: NOW });
  assert.equal(refused.code, 'E_RECEIPT_DRYRUN');
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'reports')), false);
});

test('R3-01: a real done-without-receipt still falls back exactly once', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 12, pad: 100, id: 'before-fixture' });
  const afterBuf = buildSession({ turns: 4, pad: 40 });
  writeSession(sessionPath, afterBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-150000`, beforeBuf);
  const after = snapshot(afterBuf);
  writeState(root, stateBase({
    phase: 'done',
    dryRun: false,
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after,
    backup,
    cut: { after, verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
    done: { at: '2026-11-04T06:29:00.000Z', outcome: 'applied-and-verified' },
    receipt: null,
  }));

  const first = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(first.checked, true);
  assert.equal(first.report.classification, CLASSIFICATIONS.APPLIED_VERIFIED);
  assert.equal(first.report.receiptFallbackNeeded, true);
  assert.equal(first.report.checks.receiptWritten, false);
  const text = receiptText(first.report, { appendingReceipt: false });
  assert.match(text, /回执：state 停在 done/);

  const marked = markReceiptFallbackInjected({ memoryRoot: root, now: NOW });
  assert.equal(marked.ok, true);
  assert.equal(readSurgeryState(root).state.receipt.fallbackInjected, true);

  const second = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(second.checked, false);
  assert.equal(second.reason, 'receipt-fallback-injected');
});

// ---------------------------------------------------------------------------
// R3-02 — a failed state write leaves a trace and the retry repairs it
// ---------------------------------------------------------------------------

test('R3-02: read-only state -> pending marker, then the retry repairs instead of blocking', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  writeSession(sessionPath, afterBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-143000`, beforeBuf);
  const state = verifiedState(root, { sessionPath, beforeBuf, afterBuf, backupPath: backup.path });
  writeState(root, state);

  const statePath = surgeryStatePath(root);
  fs.chmodSync(statePath, 0o444);
  let first;
  try {
    first = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  } finally {
    fs.chmodSync(statePath, 0o666);
  }

  assert.equal(first.ok, false);
  assert.equal(first.code, 'RECEIPT_STATE_WRITE_FAILED');
  assert.equal(first.receipt.written, true);
  assert.equal(first.receipt.stateWritten, false);
  assert.ok(first.pendingMarker && fs.existsSync(first.pendingMarker), 'pending marker missing');

  // The receipt is already inside the session: exactly one.
  const afterFirst = fs.readFileSync(sessionPath);
  assert.equal(receiptEvents(afterFirst).length, 1);
  const markers = readReceiptPendingMarkers({ memoryRoot: root });
  assert.equal(markers.length, 1);
  assert.equal(markers[0].eventId, `surgery-receipt-${state.surgeryId}`);
  assert.equal(markers[0].sessionPath, sessionPath);

  // The stale state still says "no receipt" and its after-snapshot no longer
  // matches the file (the receipt was appended). Before rc.4 this produced
  // RECEIPT_BLOCKED_NEEDS_ATTENTION and the repair branch was unreachable.
  const second = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.alreadyWritten, true);
  assert.equal(second.repairedState, true);
  assert.equal(second.receipt.eventId, markers[0].eventId);
  assert.equal(receiptEvents(fs.readFileSync(sessionPath)).length, 1, 'repair must not append a second receipt');
  assert.equal(readSurgeryState(root).state.receipt.written, true);
  assert.equal(readReceiptPendingMarkers({ memoryRoot: root }).length, 0, 'marker must be cleared by repair');

  const third = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(third.ok, true);
  assert.equal(third.alreadyWritten, true);
  assert.equal(receiptEvents(fs.readFileSync(sessionPath)).length, 1);
});

test('R3-02: a marker carries sessionPath when the state lost it', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 10 });
  const afterBuf = buildSession({ turns: 4 });
  const surgeryId = 'surgery-marker-only-001';
  const eventId = `surgery-receipt-${surgeryId}`;

  // The session already holds the receipt; the state never learned about it and
  // has no sessionPath either (the failed write raced with the cut record).
  const base = parseSession(afterBuf);
  const withReceipt = encodeSession(base.header, [
    ...base.events,
    buildReceiptEvent({ text: '【手术回执】repaired', seq: base.events.length, now: NOW.getTime(), id: eventId }),
  ]);
  writeSession(sessionPath, withReceipt);
  writeState(root, stateBase({
    surgeryId,
    phase: 'restart',
    sessionPath: null,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(afterBuf),
    backup: { path: `${sessionPath}.pre-surgery-x`, bytes: beforeBuf.length, sha256: sha256(beforeBuf) },
    cut: { after: snapshot(afterBuf), verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  }));
  const marker = writeReceiptPendingMarker({ memoryRoot: root, eventId, sessionPath, now: NOW });
  assert.equal(marker.ok, true);

  // Without the marker this is SESSION_PATH_MISSING; the marker supplies it.
  const repaired = writeSurgeryReceipt({ memoryRoot: root, now: NOW });
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(repaired.repairedState, true);
  assert.equal(readSurgeryState(root).state.receipt.written, true);
  assert.equal(readSurgeryState(root).state.receipt.sessionPath, sessionPath);
  assert.equal(fs.existsSync(receiptPendingMarkerPath(root, eventId)), false);

  // Safety: a marker pointing at another session is still refused.
  const other = buildSession({ turns: 3, id: 'other-fixture' });
  const otherPath = path.join(root, 'sessions', 'scope-fixtures', 'other-fixture', 'session.v4.jsonl.zstd');
  writeSession(otherPath, other);
  const otherEventId = 'surgery-receipt-other-001';
  writeReceiptPendingMarker({ memoryRoot: root, eventId: otherEventId, sessionPath: otherPath, now: NOW });
  writeState(root, stateBase({
    surgeryId: 'surgery-other-001',
    phase: 'restart',
    sessionPath: null,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(other),
    backup: null,
    cut: { after: snapshot(other), verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  }));
  const mismatch = writeSurgeryReceipt({ memoryRoot: root, now: NOW });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'E_RECEIPT_SESSION_MISMATCH');
  clearReceiptPendingMarker({ memoryRoot: root, eventId: otherEventId });
});

// ---------------------------------------------------------------------------
// R3-03 — only one process injects the fallback receipt
// ---------------------------------------------------------------------------

test('R3-03: two concurrent processes claim at most once; the loser records skipped-concurrent', async () => {
  const { root } = makeRoot();
  fs.mkdirSync(path.join(root, '.longlive'), { recursive: true });
  const readyDir = path.join(root, 'ready');
  const childFile = path.join(root, 'claim-child.mjs');
  fs.writeFileSync(childFile, `
import fs from 'node:fs';
import path from 'node:path';
import { claimFallbackInjection, releaseFallbackInjectionClaim } from ${JSON.stringify(MODULE_URL)};

const [memoryRoot, readyDir, holdRaw] = process.argv.slice(2);
const holdMs = Number(holdRaw);
fs.mkdirSync(readyDir, { recursive: true });
fs.writeFileSync(path.join(readyDir, 'ready-' + process.pid), '1');
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  const ready = fs.readdirSync(readyDir).filter((name) => name.startsWith('ready-')).length;
  if (ready >= 2) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const result = claimFallbackInjection({ memoryRoot });
if (result.ok) await new Promise((resolve) => setTimeout(resolve, holdMs));
process.stdout.write(JSON.stringify({ ok: result.ok, code: result.code }));
if (result.ok) releaseFallbackInjectionClaim({ memoryRoot, claim: result.claim });
`);

  const runChild = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [childFile, root, readyDir, '1500'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(`child exit ${code}: ${err}`));
        else resolve(JSON.parse(out));
      });
    });

  const results = await Promise.all([runChild(), runChild()]);
  const winners = results.filter((entry) => entry.ok === true);
  const losers = results.filter((entry) => entry.code === 'skipped-concurrent');
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(losers.length, 1, JSON.stringify(results));

  const audit = fs.readFileSync(path.join(root, '.longlive', 'audit.log'), 'utf8');
  assert.match(audit, /surgery-fallback-inject\t[^\t]*\tskipped-concurrent/);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'surgery-fallback-inject.lock')), false);
});

test('R3-03: an expired claim is taken over, a live one is not, and only the holder can release', () => {
  const { root } = makeRoot();
  fs.mkdirSync(path.join(root, '.longlive'), { recursive: true });

  const first = claimFallbackInjection({ memoryRoot: root, now: NOW, host: 'host-a', pid: 111 });
  assert.equal(first.ok, true);
  const blocked = claimFallbackInjection({ memoryRoot: root, now: NOW, host: 'host-b', pid: 222 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'skipped-concurrent');

  const wrong = releaseFallbackInjectionClaim({ memoryRoot: root, claim: { host: 'host-b', pid: 222, at: NOW.toISOString() } });
  assert.equal(wrong.code, 'NOT_HOLDER');
  const released = releaseFallbackInjectionClaim({ memoryRoot: root, claim: first.claim });
  assert.equal(released.released, true);

  // Ten minutes later the old claim is stale and may be replaced.
  const stale = claimFallbackInjection({ memoryRoot: root, now: NOW, host: 'host-a', pid: 111 });
  assert.equal(stale.ok, true);
  const later = new Date(NOW.getTime() + 10 * 60 * 1000);
  const taken = claimFallbackInjection({ memoryRoot: root, now: later, host: 'host-c', pid: 333 });
  assert.equal(taken.ok, true);
  assert.equal(taken.claim.host, 'host-c');
  releaseFallbackInjectionClaim({ memoryRoot: root, claim: taken.claim });
});

// ---------------------------------------------------------------------------
// R3-04 — phase / sessionId never echo a path or a control character
// ---------------------------------------------------------------------------

test('R3-04: receipt text sanitises a tampered phase and session id', () => {
  const tampered = '..\\..\\C:\\leak-root\\profiles\\Administrator';
  const text = receiptText(
    {
      classification: CLASSIFICATIONS.APPLIED_VERIFIED,
      reasonCode: RECOVERY_REASON.OK_VERIFIED,
      statePhase: 'cut\\..\\..\\C:\\leak-root\\profiles\\Administrator',
      sessionId: tampered,
      checks: {
        phase: 'cut\u0000\u001b[31m',
        sessionId: tampered,
        sessionPath: 'C:\\leak-root\\profiles\\Administrator\\.dsh\\sessions\\scope\\abc\\session.v4.jsonl.zstd',
        sessionBytes: 1000,
        beforeBytes: 4000,
        sessionEvents: 10,
        beforeEvents: 40,
        sessionMessages: 8,
        beforeMessages: 20,
        shaMatch: true,
        expectedSha256: 'a'.repeat(64),
        backupPath: 'C:\\leak-root\\profiles\\Administrator\\.dsh\\longlive-memory\\x.pre-surgery-1',
        backupExists: true,
      },
    },
    { appendingReceipt: true, seq: 9 },
  );

  assert.match(text, /停在哪：phase=\[invalid\]/);
  assert.ok(!text.includes('leak-root'), text);
  assert.ok(!text.includes('..\\'), text);
  assert.ok(!text.includes('\u0000'), text);
  assert.ok(!text.includes('\u001b'), text);
  assert.match(text, /会话 id：\?{6}c\?/, text);
  // The only path-ish line is the basename, never a directory.
  assert.ok(!/leak-root|C:/.test(text), text);
});

test('R3-04: the one-line summary sanitises phase and surgery id too', () => {
  const { root, sessionPath } = makeRoot();
  writeSession(sessionPath, buildSession({ turns: 3, pad: 40 }));
  writeState(root, stateBase({
    phase: 'C:\\leak-root\\profiles\\Administrator\\evil',
    surgeryId: '..\\..\\C:\\leak-root\\profiles\\Administrator',
    sessionPath,
    memoryRoot: root,
  }));
  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.checked, true);
  assert.equal(result.report.classification, CLASSIFICATIONS.NEEDS_ATTENTION);
  assert.equal(result.report.reasonCode, RECOVERY_REASON.STATE_INVALID);
  assert.match(result.summary, /phase=\[invalid\]/);
  assert.ok(!result.summary.includes('\\'), result.summary);
  assert.ok(!result.summary.includes('C:'), result.summary);
});
