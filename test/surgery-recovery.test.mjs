// rc.2 — startup recovery for unattended surgeries.
//
// Each case builds a throwaway memory root + a v4 session file, writes a
// surgery-state.json in the shape the launcher writes, and checks the verdict.
// The last case is a real-shaped drill: it lets truncate-cli.mjs actually cut a
// generated 120-turn session and then asks recovery to confirm the result.
//
// Nothing here touches a real session, a real memory root, the host, or the
// network.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MESSAGE_TYPES,
  encodeSession,
  foldSurface,
  parseSession,
  sha256,
} from '../src/codec.js';
import {
  CLASSIFICATIONS,
  buildReceiptEvent,
  checkSurgeryOnStart,
  markReceiptFallbackInjected,
  readSurgeryState,
  receiptText,
  statusSurgery,
  writeSurgeryReceipt,
  surgeryStatePath,
} from '../src/surgery-recovery.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE_ROOT, 'scripts', 'truncate-cli.mjs');
const INSPECT = path.join(PACKAGE_ROOT, 'scripts', 'surgery-inspect.mjs');
const NOW = new Date('2026-11-04T06:30:00.000Z');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-surgery-'));
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
        source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
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

function treeSignature(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const buf = fs.readFileSync(full);
        out.push([path.relative(dir, full), buf.length, sha256(buf)]);
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test('applied-and-verified: after snapshot matches disk and a read-back was recorded', () => {
  const { root, sessionPath } = makeRoot();
  const cutBuf = buildSession({ turns: 4, pad: 40 });
  const beforeBuf = buildSession({ turns: 12, pad: 200, id: 'before-fixture' });
  writeSession(sessionPath, cutBuf);
  const after = snapshot(cutBuf);
  const before = snapshot(beforeBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-test`, beforeBuf);

  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before,
    after,
    backup,
    cut: { startedAt: '2026-11-04T06:28:30.000Z', verify: { ok: true }, after },
    verify: { ok: true, method: 'independent-readback', sha256: after.sha256 },
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.checked, true);
  assert.equal(result.reason, 'recovered');
  assert.equal(result.report.classification, CLASSIFICATIONS.APPLIED_VERIFIED);
  assert.equal(result.report.reasonCode, 'CUT_APPLIED_AND_VERIFIED');
  assert.equal(result.report.ok, true);
  assert.equal(result.report.checks.shaMatch, true);
  assert.equal(result.report.checks.backupExists, true);
  assert.equal(result.report.checks.backupShaMatch, true);
  assert.equal(result.report.checks.readBackRecorded, true);
  assert.ok(result.written?.path, 'a report file must be written');
  assert.ok(fs.existsSync(result.written.path));
  const onDisk = JSON.parse(fs.readFileSync(result.written.path, 'utf8'));
  assert.equal(onDisk.classification, CLASSIFICATIONS.APPLIED_VERIFIED);
  assert.equal(onDisk.checks.sessionSha256, after.sha256);

  const audit = fs.readFileSync(path.join(root, '.longlive', 'audit.log'), 'utf8');
  assert.match(audit, /surgery-recovery/);
  assert.match(audit, /applied-and-verified CUT_APPLIED_AND_VERIFIED/);
});

test('applied-unverified: cut landed but no read-back record exists', () => {
  const { root, sessionPath } = makeRoot();
  const cutBuf = buildSession({ turns: 5, pad: 60 });
  const beforeBuf = buildSession({ turns: 20, pad: 100, id: 'before-fixture' });
  writeSession(sessionPath, cutBuf);
  const after = snapshot(cutBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-test`, beforeBuf);

  writeState(root, stateBase({
    phase: 'cut',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after,
    backup,
    cut: { startedAt: '2026-11-04T06:28:30.000Z', after },
    verify: null,
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.checked, true);
  assert.equal(result.report.classification, CLASSIFICATIONS.APPLIED_UNVERIFIED);
  assert.equal(result.report.reasonCode, 'CUT_APPLIED_WITHOUT_READBACK');
  assert.equal(result.report.checks.readBackRecorded, false);
});

test('applied-unverified: launcher died right after the CLI returned (cut.cli.json.after)', () => {
  const { root, sessionPath } = makeRoot();
  const cutBuf = buildSession({ turns: 5, pad: 60 });
  const beforeBuf = buildSession({ turns: 20, pad: 100, id: 'before-fixture' });
  writeSession(sessionPath, cutBuf);
  const after = snapshot(cutBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-test`, beforeBuf);

  // Exactly what the launcher writes when it is killed between
  // `cut.cli = {...}` and `after = ...`: the CLI's JSON is the only record of
  // the post-cut snapshot, and no independent verify exists yet.
  writeState(root, stateBase({
    phase: 'cut',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: null,
    backup,
    cut: {
      startedAt: '2026-11-04T06:28:30.000Z',
      cli: {
        exitCode: 0,
        json: {
          ok: true,
          applied: true,
          status: 'applied',
          after,
          verify: { ok: true, sha256: after.sha256 },
        },
      },
    },
    verify: null,
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.report.classification, CLASSIFICATIONS.APPLIED_UNVERIFIED);
  assert.equal(result.report.reasonCode, 'CUT_APPLIED_WITHOUT_READBACK');
  assert.equal(result.report.checks.expectedKind, 'after');
  assert.equal(result.report.checks.expectedSha256, after.sha256);
  assert.equal(result.report.checks.shaMatch, true);
  assert.equal(result.report.checks.readBackRecorded, false);
});

test('aborted-before-cut: session still matches before and the backup is intact', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 8, pad: 80 });
  writeSession(sessionPath, buf);
  const before = snapshot(buf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-test`, buf);

  writeState(root, stateBase({
    phase: 'backup',
    sessionPath,
    memoryRoot: root,
    before,
    backup,
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.report.classification, CLASSIFICATIONS.ABORTED_BEFORE_CUT);
  assert.equal(result.report.reasonCode, 'ABORTED_BEFORE_CUT');
  assert.equal(result.report.checks.expectedKind, 'before');
});

test('needs-attention: state says after but the session sha differs', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 6, pad: 70 });
  writeSession(sessionPath, buf);
  const disk = snapshot(buf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-test`, buf);
  const lyingAfter = { ...disk, sha256: '0'.repeat(64) };

  writeState(root, stateBase({
    phase: 'cut',
    sessionPath,
    memoryRoot: root,
    before: disk,
    after: lyingAfter,
    backup,
    cut: { verify: { ok: true }, after: lyingAfter },
    verify: { ok: true },
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.report.classification, CLASSIFICATIONS.NEEDS_ATTENTION);
  assert.equal(result.report.reasonCode, 'SESSION_SHA_MISMATCH');
  assert.equal(result.report.ok, false);
  assert.match(result.report.recommendation, /sha256/);
});

test('needs-attention: backup recorded but missing on disk', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 6, pad: 70 });
  writeSession(sessionPath, buf);
  const after = snapshot(buf);

  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: after,
    after,
    backup: { path: `${sessionPath}.pre-surgery-missing`, bytes: 1, sha256: 'f'.repeat(64) },
    cut: { verify: { ok: true }, after },
    verify: { ok: true },
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.report.classification, CLASSIFICATIONS.NEEDS_ATTENTION);
  assert.equal(result.report.reasonCode, 'BACKUP_MISSING');
});

test('needs-attention: corrupt stage file is reported, not thrown', () => {
  const { root } = makeRoot();
  fs.mkdirSync(path.join(root, '.longlive'), { recursive: true });
  fs.writeFileSync(surgeryStatePath(root), '{ this is not json');

  const read = readSurgeryState(root);
  assert.equal(read.exists, true);
  assert.ok(read.error);

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.checked, true);
  assert.equal(result.report.classification, CLASSIFICATIONS.NEEDS_ATTENTION);
  assert.equal(result.report.reasonCode, 'STATE_UNREADABLE');
});

test('phase done: no report, no audit, no extra files', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 3, pad: 30 });
  writeSession(sessionPath, buf);
  const snap = snapshot(buf);
  writeState(root, stateBase({
    phase: 'done',
    sessionPath,
    memoryRoot: root,
    before: snap,
    after: snap,
    done: { at: '2026-11-04T06:29:00.000Z', outcome: 'applied-and-verified', resultPath: 'C:\\tmp\\result.json' },
    // R2-02: done is only terminal once the receipt exists.
    receipt: { written: true, via: 'surgery-script', at: '2026-11-04T06:29:00.000Z', seq: 9, eventId: 'surgery-receipt-test' },
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.checked, false);
  assert.equal(result.reason, 'phase-done');
  assert.equal(result.outcome, 'applied-and-verified');
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'reports')), false);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'audit.log')), false);
});

test('R2-02: phase done without a receipt still yields one fallback report, then stays quiet', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 12, pad: 200, id: 'before-fixture' });
  const afterBuf = buildSession({ turns: 4, pad: 40 });
  writeSession(sessionPath, afterBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-150000`, beforeBuf);
  const after = snapshot(afterBuf);
  writeState(root, stateBase({
    phase: 'done',
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

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.checked, true);
  assert.equal(result.report.receiptFallbackNeeded, true);
  assert.equal(result.report.checks.receiptWritten, false);
  assert.equal(result.report.classification, CLASSIFICATIONS.APPLIED_VERIFIED);
  assert.ok(result.written?.path && fs.existsSync(result.written.path));

  const text = receiptText(result.report, { appendingReceipt: false });
  assert.match(text, /回执：state 停在 done/);
  assert.ok(!text.includes(sessionPath), text);
  assert.ok(!text.includes(backup.path), text);

  const marked = markReceiptFallbackInjected({ memoryRoot: root, now: NOW });
  assert.equal(marked.ok, true);
  const stored = readSurgeryState(root).state;
  assert.equal(stored.receipt.fallbackInjected, true);
  assert.equal(stored.receipt.written, false);

  const again = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(again.checked, false);
  assert.equal(again.reason, 'receipt-fallback-injected');
  const secondMark = markReceiptFallbackInjected({ memoryRoot: root, now: NOW });
  assert.equal(secondMark.ok, true);
  assert.equal(secondMark.alreadyMarked, true);
});

test('no stage file: one existsSync, zero side effects', () => {
  const { root } = makeRoot();
  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW });
  assert.equal(result.checked, false);
  assert.equal(result.reason, 'no-state');
  assert.equal(fs.existsSync(path.join(root, '.longlive')), false);
});

test('surgery-inspect --recover-report is a read-only query', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 6, pad: 60 });
  writeSession(sessionPath, buf);
  const snap = snapshot(buf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-test`, buf);
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snap,
    after: snap,
    backup,
    cut: { verify: { ok: true }, after: snap },
    verify: { ok: true },
  }));

  const beforeTree = treeSignature(root);
  const proc = spawnSync(process.execPath, [INSPECT, '--recover-report', '--memory-root', root], {
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, proc.stderr);
  const lines = proc.stdout.trim().split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  assert.ok(lines.length >= 1, `expected one JSON line, got: ${proc.stdout}`);
  const payload = JSON.parse(lines[lines.length - 1]);
  assert.equal(payload.found, true);
  assert.equal(payload.classification, CLASSIFICATIONS.APPLIED_VERIFIED);
  assert.equal(payload.reasonCode, 'CUT_APPLIED_AND_VERIFIED');
  assert.equal(payload.status, 'needs-review');
  const afterTree = treeSignature(root);
  assert.deepEqual(afterTree, beforeTree, '--recover-report must not create or modify files');
});

test('real-shaped drill: CLI really cuts a 120-turn session, recovery sees applied-and-verified', () => {
  const { root, sessionPath } = makeRoot();
  const original = buildSession({ turns: 120, pad: 3000, id: 'drill-120' });
  writeSession(sessionPath, original);
  const before = snapshot(original);
  const backup = writeBackup(`${sessionPath}.pre-surgery-drill`, original);

  const proc = spawnSync(process.execPath, [
    CLI,
    '--session', sessionPath,
    '--keep-turns', '4',
    '--keep-tokens', '4000',
    '--confirm', 'TRUNCATE-VISIBLE',
    '--memory-root', root,
  ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: root } });
  assert.equal(proc.status, 0, `truncate-cli failed: ${proc.stderr}\n${proc.stdout}`);

  const lines = proc.stdout.trim().split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  assert.ok(lines.length >= 1, `expected one JSON line, got: ${proc.stdout}`);
  const cut = JSON.parse(lines[lines.length - 1]);
  assert.equal(cut.ok, true);
  assert.equal(cut.applied, true, 'the drill session must actually be cut');
  assert.ok(cut.after.bytes < before.bytes, 'cut session must be smaller');

  const afterBuf = fs.readFileSync(sessionPath);
  const after = snapshot(afterBuf);
  assert.equal(cut.after.sha256, after.sha256);
  assert.equal(cut.after.events, after.events);
  assert.equal(cut.after.messages, after.messages);
  assert.notEqual(after.sha256, before.sha256);

  // Shape the stage file exactly as the launcher leaves it when it is killed
  // after the CLI succeeded but before phase=done.
  writeState(root, stateBase({
    phase: 'cut',
    sessionPath,
    memoryRoot: root,
    before,
    after,
    backup,
    cut: {
      startedAt: '2026-11-04T06:28:30.000Z',
      verify: { ok: true },
      after,
      exitCode: 0,
      archivePath: cut.archivePath,
      backupPath: cut.backupPath,
    },
    verify: { ok: true, method: 'independent-readback', sha256: after.sha256 },
  }));

  const result = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(result.report.classification, CLASSIFICATIONS.APPLIED_VERIFIED);
  assert.equal(result.report.checks.sessionSha256, after.sha256);
  assert.equal(result.report.checks.sessionEvents, after.events);
  assert.equal(result.report.checks.sessionMessages, after.messages);
  assert.equal(result.report.checks.backupShaMatch, true);

  const status = statusSurgery({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(status.status, 'needs-review');
  assert.equal(status.classification, CLASSIFICATIONS.APPLIED_VERIFIED);
  assert.equal(status.lastSurgery.before.sha256, before.sha256);
  assert.equal(status.lastSurgery.after.sha256, after.sha256);
});

// ---------------------------------------------------------------------------
// Receipt in the conversation body (rc.2)
// ---------------------------------------------------------------------------

test('receipt: 写回执后最后一条是可读 user 消息，state 记 receipt.after，重复调用幂等', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  writeSession(sessionPath, afterBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-143000`, beforeBuf);
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(afterBuf),
    backup,
    cut: { after: snapshot(afterBuf), verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  }));

  const result = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt.written, true);
  assert.equal(result.receipt.sessionPath, sessionPath);
  assert.equal(result.receipt.after.events, snapshot(afterBuf).events + 1);

  const parsed = parseSession(fs.readFileSync(sessionPath));
  assert.equal(parsed.events.length, snapshot(afterBuf).events + 1);
  assert.equal(parsed.events.at(-1).seq, parsed.events.length - 1);
  assert.equal(parsed.events.at(-1).type, 'user/message');
  assert.equal(parsed.events.at(-1).data.role, 'user');
  assert.equal(parsed.events.at(-1).data.source.kind, 'user');
  assert.match(parsed.events.at(-1).data.id, /^surgery-receipt-/);

  const text = parsed.events.at(-1).data.content.map((part) => part.text).join('');
  assert.match(text, /^【手术回执】/);
  assert.match(text, /成功/);
  assert.match(text, /字节：\d[\d,]* → \d[\d,]*/);
  assert.match(text, /事件：\d[\d,]* → \d[\d,]*/);
  assert.match(text, /消息：\d[\d,]* → \d[\d,]*/);
  assert.match(text, /sha256：磁盘读回与记录一致/);
  assert.ok(text.includes('seq='), text);
  // R2-01: the visible receipt carries names only, never a full path.
  assert.ok(!text.includes(sessionPath), text);
  assert.ok(!text.includes(backup.path), text);
  assert.ok(!/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|opt|root|mnt)\/)/.test(text), text);
  assert.ok(text.includes(path.basename(backup.path)), text);

  const stored = readSurgeryState(root);
  assert.equal(stored.state.receipt.written, true);
  assert.equal(stored.state.receipt.seq, parsed.events.length - 1);
  assert.equal(stored.state.receipt.after.events, parsed.events.length);
  assert.ok(fs.readdirSync(path.dirname(sessionPath)).some((name) => name.includes('.bak-receipt-')), 'receipt backup missing');

  const again = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyWritten, true);
  assert.equal(fs.readFileSync(sessionPath).length, parsed.bytes);
});

test('R2-04: a live receipt lock rejects the second writer, and retry succeeds after release', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  writeSession(sessionPath, afterBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-150100`, beforeBuf);
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(afterBuf),
    backup,
    cut: { after: snapshot(afterBuf), verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  }));

  const lockPath = path.join(root, '.longlive', 'surgery-receipt.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: NOW.toISOString() }));
  const beforeBytes = fs.readFileSync(sessionPath).length;
  const busy = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'RECEIPT_BUSY');
  assert.equal(fs.readFileSync(sessionPath).length, beforeBytes, 'busy writer must not touch the session');

  fs.unlinkSync(lockPath);
  const retry = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.receipt.written, true);
});

test('R2-04: an append that landed before the state write is repaired without a second event', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  const parsed = parseSession(afterBuf);
  const event = buildReceiptEvent({
    text: '【手术回执】already written\n',
    seq: parsed.events.length,
    now: NOW.getTime(),
    id: 'surgery-receipt-surgery-20261104-143000-001',
  });
  const withEvent = encodeSession(parsed.header, [...parsed.events, event]);
  writeSession(sessionPath, withEvent);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-150200`, beforeBuf);
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(withEvent),
    backup,
    cut: { after: snapshot(withEvent), verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
    receipt: null,
  }));

  const result = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.alreadyWritten, true);
  assert.equal(result.repairedState, true);
  const after = parseSession(fs.readFileSync(sessionPath));
  assert.equal(after.events.length, parsed.events.length + 1, 'must not append a second receipt');
  assert.equal(after.events.at(-1).data.id, event.data.id);
  const stored = readSurgeryState(root).state;
  assert.equal(stored.receipt.written, true);
  assert.equal(stored.receipt.repairedState, true);
  assert.equal(stored.receipt.seq, parsed.events.length);
});

test('R2-05: --write-receipt rejects a session outside the allowed set', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  writeSession(sessionPath, afterBuf);
  const outside = path.join(os.tmpdir(), `longlive-outside-${process.pid}.v4.jsonl.zstd`);
  writeSession(outside, buildSession({ turns: 4, id: 'outside-fixture' }));
  const outsideBytes = fs.readFileSync(outside);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-150300`, beforeBuf);
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(afterBuf),
    backup,
    cut: { after: snapshot(afterBuf), verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  }));

  try {
    const result = writeSurgeryReceipt({ sessionPath: outside, memoryRoot: root, now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_RECEIPT_SESSION_OUTSIDE');
    assert.deepEqual(fs.readFileSync(outside), outsideBytes, 'outside session must not change');
    assert.ok(readSurgeryState(root).state.receipt == null);
  } finally {
    try {
      fs.unlinkSync(outside);
    } catch {
      /* temp */
    }
  }
});

test('R2-05: a session inside sessions/ with the wrong header id is rejected', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  writeSession(sessionPath, afterBuf);
  const otherDir = path.join(root, 'sessions', 'scope-fixtures', 'other-fixture');
  const otherPath = path.join(otherDir, 'session.v4.jsonl.zstd');
  writeSession(otherPath, buildSession({ turns: 4, id: 'other-fixture' }));
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-150400`, beforeBuf);
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(afterBuf),
    backup,
    cut: { after: snapshot(afterBuf), verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  }));

  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const result = writeSurgeryReceipt({ sessionPath: otherPath, memoryRoot: root, now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_RECEIPT_SESSION_MISMATCH');
    assert.ok(readSurgeryState(root).state.receipt == null);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('R2-06: noop writes 无需截断 and never claims a cut landed', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 20, id: 'noop-fixture' });
  writeSession(sessionPath, afterBuf);
  const snap = snapshot(afterBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-150500`, beforeBuf);
  writeState(root, stateBase({
    phase: 'done',
    sessionPath,
    memoryRoot: root,
    before: snap,
    after: snap,
    backup,
    cut: { outcome: 'noop', after: snap, verify: { ok: true, method: 'cli-noop' } },
    verify: { ok: true, method: 'cli-noop' },
    done: { at: '2026-11-04T06:29:00.000Z', outcome: 'noop' },
    receipt: null,
  }));

  const report = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(report.report.classification, CLASSIFICATIONS.ABORTED_BEFORE_CUT);
  assert.equal(report.report.reasonCode, 'NOOP_TRUNCATION_NOT_NEEDED');
  const result = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.text, /无需截断/);
  assert.doesNotMatch(result.text, /剪切已落盘|成功/);
  const status = statusSurgery({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(status.status, 'done');
  assert.equal(status.classification, CLASSIFICATIONS.ABORTED_BEFORE_CUT);
  assert.match(status.recommendation, /无需截断/);
});

test('R2-09: write-receipt refuses to launder a needs-attention state', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 6, pad: 70 });
  writeSession(sessionPath, buf);
  const disk = snapshot(buf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-150600`, buf);
  const lyingAfter = { ...disk, sha256: '0'.repeat(64) };
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: disk,
    after: lyingAfter,
    backup,
    cut: { verify: { ok: true }, after: lyingAfter },
    verify: { ok: true },
  }));

  const report = checkSurgeryOnStart({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(report.report.classification, CLASSIFICATIONS.NEEDS_ATTENTION);
  const bytes = fs.readFileSync(sessionPath).length;
  const result = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RECEIPT_BLOCKED_NEEDS_ATTENTION');
  assert.equal(fs.readFileSync(sessionPath).length, bytes, 'blocked receipt must not touch the session');
  assert.ok(readSurgeryState(root).state.receipt == null, 'blocked receipt must not rewrite state');
  const status = statusSurgery({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.4' });
  assert.equal(status.classification, CLASSIFICATIONS.NEEDS_ATTENTION);
  assert.equal(status.reasonCode, 'SESSION_SHA_MISMATCH');
});

test('receipt text: 未能确认的手术写出“需要注意”，并给出备份与人工建议', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  const expectedAfter = snapshot(buildSession({ turns: 5 }));
  writeSession(sessionPath, afterBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-143000`, beforeBuf);
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: expectedAfter,
    backup,
    cut: { after: expectedAfter, verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  }));

  const report = checkSurgeryOnStart({ memoryRoot: root, now: NOW });
  assert.equal(report.checked, true);
  assert.equal(report.report.classification, CLASSIFICATIONS.NEEDS_ATTENTION);
  const text = receiptText(report.report, { appendingReceipt: true, seq: 123 });
  assert.match(text, /^【手术回执】/);
  assert.match(text, /需要注意/);
  assert.match(text, /sha256/);
  assert.match(text, /备份/);
  assert.match(text, /seq=123/);
});

test('surgery-inspect --write-receipt: 成功后会话多一条回执，第二次报告 alreadyWritten', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  writeSession(sessionPath, afterBuf);
  const backup = writeBackup(`${sessionPath}.pre-surgery-20261104-143000`, beforeBuf);
  writeState(root, stateBase({
    phase: 'restart',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(afterBuf),
    backup,
    cut: { after: snapshot(afterBuf), verify: { ok: true } },
    verify: { ok: true, method: 'independent-readback' },
  }));

  const run = () => spawnSync(process.execPath, [INSPECT, '--write-receipt', '--session', sessionPath, '--memory-root', root], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const line = JSON.parse(first.stdout.trim().split(/\r?\n/).pop());
  assert.equal(line.ok, true);
  assert.equal(line.receipt.written, true);
  assert.equal(line.memoryRoot, root);

  const second = run();
  assert.equal(second.status, 0);
  const line2 = JSON.parse(second.stdout.trim().split(/\r?\n/).pop());
  assert.equal(line2.ok, true);
  assert.equal(line2.alreadyWritten, true);
});

test('surgery timing: 默认 30/0；sleep→close→backup→cut→read-back→receipt→restart；verify 与 restart 之间只有重启延迟', () => {
  const ps1 = fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts', 'unattended-surgery.ps1'), 'utf8');
  assert.match(ps1, /\[int\]\$StartDelaySeconds = 30/);
  assert.match(ps1, /\[int\]\$RestartDelaySeconds = 0/);
  assert.ok(!/\[int\]\$StartDelaySeconds = (120|0)\b/.test(ps1), '旧默认值不得残留');
  assert.match(ps1, /StartDelaySeconds must be 0\.\.86400/);
  assert.match(ps1, /RestartDelaySeconds must be 0\.\.86400/);

  const marks = [
    'if ($StartDelaySeconds -gt 0)',
    '$close = Close-Host',
    '.pre-surgery-$stamp"',
    "Write-State 'cut'",
    "method = 'independent-readback'",
    "'--write-receipt'",
    "Write-State 'restart' @{ receipt",
    'if ($RestartDelaySeconds -gt 0)',
  ];
  const positions = marks.map((mark) => {
    const index = ps1.indexOf(mark);
    assert.ok(index >= 0, `missing marker: ${mark}`);
    return index;
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `out of order: ${marks[i - 1]} -> ${marks[i]}`);
  }
  const restartDelayIndex = positions.at(-1);
  const restartIndex = ps1.indexOf('$restart = Start-Host', restartDelayIndex);
  assert.ok(restartIndex > restartDelayIndex, 'restart must follow the RestartDelaySeconds guard');

  const verifyToReceipt = ps1.slice(positions[4], positions[5]);
  assert.ok(!/Start-Sleep/.test(verifyToReceipt), 'no sleep between read-back and receipt');
  const receiptToRestart = ps1.slice(positions[6], restartIndex);
  assert.ok(!/Start-Sleep -Seconds \$StartDelaySeconds/.test(receiptToRestart), '30s window must not repeat before restart');
  const closeToRestart = ps1.slice(positions[1], restartIndex);
  assert.ok(!/Start-Sleep -Seconds \$StartDelaySeconds/.test(closeToRestart), 'reading window only applies before close');

  const install = fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts', 'install-surgery-task.ps1'), 'utf8');
  assert.match(install, /\[int\]\$StartDelaySeconds = 30/);
  assert.match(install, /\[int\]\$RestartDelaySeconds = 0/);
  assert.match(install, /'-RestartDelaySeconds', "\$RestartDelaySeconds"/);
  const cmd = fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts', 'surgery-run.cmd'), 'utf8');
  assert.match(cmd, /default 30/);
  assert.match(cmd, /default 0/);
});
