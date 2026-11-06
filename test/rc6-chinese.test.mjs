// rc.6 — R4-03 Chinese-environment regressions.
//
// The VM drill (drill/run-rc6-drill.mjs) exercises the real PowerShell 5.1
// executor end to end. These cases keep the invariants in the ordinary suite:
// every node capture goes through UTF-8 decoders, an exit-0-but-unparseable CLI
// result is classified `applied-unparsed` instead of `failed`, and a receipt
// written for a Chinese session round-trips byte-for-byte into the transcript.
//
// Nothing here touches a real session, the host, the real memory root, or the
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
  RECOVERY_REASON,
  buildRecoveryReport,
  displaySessionId,
  readSurgeryState,
  receiptText,
  surgeryStatePath,
  writeSurgeryReceipt,
} from '../src/surgery-recovery.js';
import { sanitizeSessionId } from '../src/surgery-recovery.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const NODE = process.execPath;
const NOW = new Date('2026-11-04T06:30:00.000Z');
const ZH_ID = 'zh-session-0f8fad5b-d9cb-469f-a165-70867728950e';
const ZH_FIRST = '好的，今天做听觉训练';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRoot(tag = 'longlive-rc6-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  const sessionDir = path.join(root, 'sessions', 'scope-fixtures', ZH_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  return { root, sessionDir, sessionPath: path.join(sessionDir, 'session.v4.jsonl.zstd') };
}

function buildSession({ turns = 20, pad = 60, id = ZH_ID, firstText = ZH_FIRST } = {}) {
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
        content: [{ type: 'text', text: t === 1 ? firstText : `第 ${t} 轮问题 ${'问'.repeat(pad)}` }],
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
          content: [{ type: 'text', text: `第 ${t} 轮回答 ${'答'.repeat(pad)}` }],
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

function stateBase(overrides = {}) {
  return {
    version: 1,
    kind: 'longlive-surgery',
    surgeryId: 'surgery-20261104-183000-001',
    phase: 'cut',
    startedAt: '2026-11-04T06:28:00.000Z',
    updatedAt: '2026-11-04T06:29:00.000Z',
    pid: 12345,
    sessionPath: null,
    sessionId: ZH_ID,
    memoryRoot: null,
    appPath: 'C:\\Program Files\\DSH\\DSH.exe',
    keepTurns: 6,
    keepTokens: 40000,
    startDelaySeconds: 0,
    pluginVersion: '0.9.0-rc.6',
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

// ---------------------------------------------------------------------------
// 1. Every PowerShell -> node capture must be UTF-8 (R4-03).
// ---------------------------------------------------------------------------

test('R4-03: 三个 PowerShell 执行器都用 UTF-8 解码 node 输出（静态审计）', () => {
  const files = [
    path.join(PACKAGE_ROOT, 'scripts', 'unattended-surgery.ps1'),
    path.join(PACKAGE_ROOT, 'scripts', 'auto-truncate-run.ps1'),
    path.join(PACKAGE_ROOT, 'scripts', 'lib', 'auto-truncate-run.ps1'),
  ];
  for (const file of files) {
    const buf = fs.readFileSync(file);
    assert.notDeepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file} must not start with a BOM`);
    const text = buf.toString('utf8');
    const code = text
      .replace(/<#[\s\S]*?#>/g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+#.*$/, ''))
      .join('\n');
    assert.match(text, /ProcessStartInfo/, `${path.basename(file)} must use an explicit process start`);
    assert.match(text, /StandardOutputEncoding/, `${path.basename(file)} must set stdout decoding`);
    assert.match(text, /StandardErrorEncoding/, `${path.basename(file)} must set stderr decoding`);
    assert.match(text, /UTF8Encoding/, `${path.basename(file)} must name UTF-8 explicitly`);
    assert.doesNotMatch(code, /&\s*\$\w+\s+@\w+\s+2>&1/, `${path.basename(file)} must not use the GBK capture idiom`);
    assert.doesNotMatch(code, /Substring\(\s*0\s*,\s*8\s*\)/, `${path.basename(file)} must not hard-truncate ids`);
  }
  const surgery = fs.readFileSync(files[0], 'utf8');
  assert.match(surgery, /applied-unparsed/);
  assert.match(surgery, /needs-attention/);
  assert.match(surgery, /E_CUT_UNVERIFIED/);
  assert.match(surgery, /Write-RawCapture/);
  assert.match(surgery, /Test-CutLanded/);
  const auto = fs.readFileSync(files[1], 'utf8');
  assert.match(auto, /Test-CutApplied/);
  assert.match(auto, /applied-unparsed/);
});

// ---------------------------------------------------------------------------
// 2. Ids are shown in full (R4-01 stays fixed).
// ---------------------------------------------------------------------------

test('R4-03: 合法会话 id 完整显示，非法 id 才清洗并缩短', () => {
  assert.equal(displaySessionId(ZH_ID), ZH_ID);
  const dirty = '../..\\tok en\\\\secret-session-id';
  const shown = displaySessionId(dirty);
  assert.ok(shown.length <= 8, `dirty id must be shortened, got ${shown.length}`);
  assert.doesNotMatch(shown, /[\\/]/);
  assert.equal(sanitizeSessionId(ZH_ID), ZH_ID.slice(0, 8));
});

// ---------------------------------------------------------------------------
// 3. applied-unparsed is a success class, not a failure.
// ---------------------------------------------------------------------------

test('R4-03: applied-unparsed 归类为成功，回执说明编码异常', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  writeSession(sessionPath, afterBuf);
  const backupBuf = beforeBuf;
  const backupPath = `${sessionPath}.pre-surgery-20261104-183000`;
  fs.writeFileSync(backupPath, backupBuf);
  writeState(root, stateBase({
    phase: 'done',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(afterBuf),
    backup: { path: backupPath, bytes: backupBuf.length, sha256: sha256(backupBuf) },
    cut: {
      outcome: 'applied-unparsed',
      encoding: { unparsed: true, capturePath: null },
      verify: { ok: true, method: 'independent-readback-unparsed' },
    },
    verify: { ok: true, method: 'independent-readback-unparsed' },
    done: { outcome: 'applied-unparsed' },
    receipt: { written: true, text: 'placeholder' },
  }));

  const report = buildRecoveryReport({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.6' });
  assert.equal(report.ok, true);
  assert.equal(report.classification, CLASSIFICATIONS.APPLIED_UNPARSED);
  assert.equal(report.reasonCode, RECOVERY_REASON.OK_UNPARSED);
  assert.equal(report.checks.cutOutcome, 'applied-unparsed');

  const text = receiptText(report);
  assert.match(text, /成功/);
  assert.match(text, /编码/);
  assert.match(text, new RegExp(`会话 id：${ZH_ID}`));
  assert.doesNotMatch(text, /\uFFFD/);
  assert.doesNotMatch(text, /[A-Za-z]:\\/);
});

// ---------------------------------------------------------------------------
// 4. needs-attention is a distinct state; the reason is not "failed".
// ---------------------------------------------------------------------------

test('R4-03: needs-attention 不冒充 failed，recommendation 不泄露绝对路径', () => {
  const { root, sessionPath } = makeRoot();
  const buf = buildSession({ turns: 20 });
  writeSession(sessionPath, buf);
  writeState(root, stateBase({
    phase: 'needs-attention',
    sessionPath,
    memoryRoot: root,
    before: snapshot(buf),
    cut: {
      outcome: 'unverified',
      verification: { sessionReadable: true, shaChanged: false, eventsDecreased: false },
    },
    needsAttention: {
      at: '2026-11-04T06:29:00.000Z',
      code: 'E_CUT_UNVERIFIED',
      phase: 'verify',
      message: 'truncate-cli exited 0 but verification did not confirm the cut',
      checks: { shaChanged: false, eventsDecreased: false },
    },
    after: null,
    receipt: { written: false, at: '2026-11-04T06:29:00.000Z' },
  }));

  const report = buildRecoveryReport({ memoryRoot: root, now: NOW, loadedVersion: '0.9.0-rc.6' });
  assert.equal(report.ok, false);
  assert.equal(report.classification, CLASSIFICATIONS.NEEDS_ATTENTION);
  assert.equal(report.reasonCode, RECOVERY_REASON.CUT_UNVERIFIED);
  assert.equal(report.checks.needsAttentionCode, 'E_CUT_UNVERIFIED');
  assert.doesNotMatch(report.recommendation, /[A-Za-z]:\\/);
  const actions = Array.isArray(report.actions) ? report.actions.join(' ') : '';
  assert.doesNotMatch(actions, /[A-Za-z]:\\/);
});

// ---------------------------------------------------------------------------
// 5. Receipt text for a Chinese session: UTF-8 consistent + idempotent.
// ---------------------------------------------------------------------------

test('R4-03: 中文会话回执 UTF-8 一致、id 完整、二次写入 0 条新事件', () => {
  const { root, sessionPath } = makeRoot();
  const beforeBuf = buildSession({ turns: 20 });
  const afterBuf = buildSession({ turns: 6 });
  writeSession(sessionPath, afterBuf);
  const backupPath = `${sessionPath}.pre-surgery-20261104-183000`;
  fs.writeFileSync(backupPath, beforeBuf);
  writeState(root, stateBase({
    phase: 'done',
    sessionPath,
    memoryRoot: root,
    before: snapshot(beforeBuf),
    after: snapshot(afterBuf),
    backup: { path: backupPath, bytes: beforeBuf.length, sha256: sha256(beforeBuf) },
    cut: {
      outcome: 'applied-unparsed',
      verify: { ok: true, method: 'independent-readback-unparsed' },
    },
    verify: { ok: true, method: 'independent-readback-unparsed' },
    done: { outcome: 'applied-unparsed' },
  }));

  const first = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.receipt.written, true);
  assert.match(first.receipt.text, /【手术回执】/);
  assert.match(first.receipt.text, new RegExp(`会话 id：${ZH_ID}`));
  assert.match(first.receipt.text, /编码/);
  assert.doesNotMatch(first.receipt.text, /\uFFFD/);

  const parsed = parseSession(fs.readFileSync(sessionPath));
  const receipts = parsed.events.filter((event) => String(event.data?.id ?? '').startsWith('surgery-receipt-'));
  assert.equal(receipts.length, 1);
  const eventText = receipts[0].data.content.map((part) => part.text).join('');
  assert.equal(eventText, first.receipt.text);
  assert.equal(eventText, readSurgeryState(root).state.receipt.text);
  assert.ok(eventText.includes(ZH_FIRST) === false); // receipt text is not the carried first message

  const second = writeSurgeryReceipt({ sessionPath, memoryRoot: root, now: NOW });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyWritten, true);
  const again = parseSession(fs.readFileSync(sessionPath));
  assert.equal(again.events.length, parsed.events.length);
  assert.equal(again.events.filter((event) => String(event.data?.id ?? '').startsWith('surgery-receipt-')).length, 1);
});

// ---------------------------------------------------------------------------
// 6. Real executor dry run under a GBK console: Chinese path survives.
// ---------------------------------------------------------------------------

test('R4-03: GBK 控制台下真实执行器读回中文路径（dry run）', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-rc6-gbk-'));
  const sessionDir = path.join(root, '会话 备份', 'sessions', 'scope', ZH_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(sessionPath, buildSession({ turns: 20 }));
  const memoryRoot = path.join(root, '记忆 根');
  fs.mkdirSync(memoryRoot, { recursive: true });

  const launcher = path.join(root, 'launch-gbk.ps1');
  // PS 5.1 reads a script without BOM as ANSI, which would mangle the Chinese
  // fixture path inside the launcher itself. The BOM makes the launcher UTF-8
  // for the parser; the package scripts stay UTF-8 without BOM and ASCII-only.
  fs.writeFileSync(launcher, '\uFEFF' + [
    "$ErrorActionPreference = 'Stop'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936) } catch { }',
    'try { $OutputEncoding = [System.Text.Encoding]::GetEncoding(936) } catch { }',
    `& '${path.join(PACKAGE_ROOT, 'scripts', 'unattended-surgery.ps1')}' -SessionPath '${sessionPath}' -MemoryRoot '${memoryRoot}' -NodeExe '${NODE}' -DryRun`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n'), 'utf8');

  const proc = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: root },
    timeout: 120000,
  });
  assert.equal(proc.status, 0, `executor failed: ${proc.stderr}\n${proc.stdout}`);

  const statePath = path.join(memoryRoot, '.longlive', 'surgery-state.json');
  const raw = fs.readFileSync(statePath, 'utf8');
  assert.doesNotMatch(raw, /\uFFFD/);
  const state = JSON.parse(raw);
  assert.equal(state.phase, 'dryrun');
  assert.equal(state.sessionPath, sessionPath);
  assert.equal(state.sessionId, ZH_ID);
  assert.equal(state.dryRun, true);
});
