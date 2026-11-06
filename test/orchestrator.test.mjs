// @local/dsh-longlive — orchestrator (scripts/auto-truncate-run.ps1) contract
//
// The orchestrator closes the app, cuts the log through truncate-cli.mjs,
// verifies the rewrite and restarts the app. These cases pin the parts that
// used to be unguarded:
//   * the request's sessionPath must resolve to a file under the sessions root
//     (case-insensitive prefix compare after Resolve-Path normalisation);
//   * a refusal writes structured JSON with SESSION_PATH_OUTSIDE_ROOT and
//     exits 2 without touching the file;
//   * a close failure writes structured JSON with CLOSE_FAILED and exits 3
//     (exercised with -SimulateCloseFailure, which never looks at a process);
//   * a valid in-root request still passes -DryRun with exit 0.
//
// Nothing here closes an app or reads ~/.dsh/sessions: the sessions root, the
// memory root and the "app" are all temp fixtures.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PS1 = path.join(ROOT, 'scripts', 'auto-truncate-run.ps1');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeRequest(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
}

function baseRequest({ sessionPath, appExe, keepTurns = 5 }) {
  return {
    version: 1,
    requestId: 'req-orchestrator-test',
    at: new Date().toISOString(),
    sessionPath,
    sessionId: 'session-orchestrator-test',
    reason: 'unit test',
    estimate: { events: 10, bytes: 100 },
    plan: { keepTurns, keepTokens: 1000 },
    app: { exe: appExe },
    pluginDir: ROOT,
  };
}

function runOrchestrator({ memoryRoot, requestFile, sessionsRoot, extra = [] }) {
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
    '-MemoryRoot', memoryRoot,
    '-RequestFile', requestFile,
    '-SessionsRoot', sessionsRoot,
    ...extra,
  ];
  const run = spawnSync('powershell.exe', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    status: run.status,
    stdout: String(run.stdout ?? ''),
    stderr: String(run.stderr ?? ''),
  };
}

function readResultLog(memoryRoot) {
  const file = path.join(memoryRoot, '.longlive', 'logs', 'auto-truncate.log');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    if (!trimmed.startsWith('{')) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* keep scanning */ }
  }
  return out;
}

function readRunLog(memoryRoot) {
  const file = path.join(memoryRoot, '.longlive', 'logs', 'auto-truncate-run.log');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

// The dry-run plan is a pretty-printed ConvertTo-Json object on stdout, mixed
// with the "[timestamp] ..." run lines. Pull the first balanced object out.
function parsePlanBlock(stdout) {
  const text = String(stdout);
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function runOrchestratorSuite({ runCase, assert, TMP }) {
  const base = path.join(TMP, 'orchestrator');
  const sessionsRoot = path.join(base, 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });

  runCase('O1', 'auto-truncate-run.ps1：ASCII 主体 + 硬杀关闭策略 + sessionPath 约束 + 结构化结果', () => {
    const bytes = fs.readFileSync(PS1);
    for (let i = 0; i < bytes.length; i += 1) {
      assert(bytes[i] < 0x80, `script byte ${i} is non-ASCII (0x${bytes[i].toString(16)})`);
    }
    const text = bytes.toString('ascii');
    for (const needle of [
      'SessionsRoot', 'Resolve-Path', 'OrdinalIgnoreCase', 'StartsWith',
      'SESSION_PATH_OUTSIDE_ROOT', 'CLOSE_FAILED', 'close-failed', 'SimulateCloseFailure',
      'exit 3', '--memory-root',
      // hard-kill close, not a one-minute standoff
      'CloseMainWindow', 'Stop-Process -Id', 'AddSeconds(3)', 'settleMs', 'gracefulMs',
      // the watchdog reports how far the cut drifted from the request plan
      'snapshotEvents', 'eventsDelta', 'drifted', 'drift = $drift',
    ]) {
      assert(text.includes(needle), `orchestrator script is missing ${needle}`);
    }
    // The old flow waited 60 seconds for taskkill without /F, then swept by image
    // name. Neither may come back: the close has to be a one-shot polite signal
    // plus a PID-scoped force kill.
    assert(!/taskkill\s+\/[IMF]/i.test(text), 'the script still invokes taskkill by image name');
    assert(!/AddSeconds\((?!3\))/.test(text), 'the script still has a non-3-second grace window');
    assert(!text.includes('AddSeconds(60)') && !text.includes('AddSeconds(30)'),
      'the script still waits 30/60 seconds for the app to close');
    assert(text.includes('Stop-Process -Id $proc.Id -Force'),
      'the force kill is not scoped to a PID');
    // The drift numbers must ride on the success result, not only in the run log.
    const doneResult = text.slice(text.indexOf("status = 'done'"), text.indexOf('Remove-Item -LiteralPath $RequestFile'));
    assert(doneResult.includes('drift = $drift'), 'the done result does not carry the drift report');
    assert(!text.includes('RESULT close-failed') || text.includes('Write-Result'),
      'close-failed path has no structured result');
    return 'script contract holds';
  });

  runCase('O2', 'sessionPath 在 sessions 根外：exit 2 + SESSION_PATH_OUTSIDE_ROOT，字节不变', () => {
    const caseDir = path.join(base, 'outside');
    const memoryRoot = path.join(caseDir, 'memory');
    const outsideDir = path.join(caseDir, 'elsewhere');
    fs.mkdirSync(memoryRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const fakeApp = path.join(caseDir, 'fake.exe');
    fs.writeFileSync(fakeApp, Buffer.from('not a real executable'));
    const sessionPath = path.join(outsideDir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(sessionPath, Buffer.from('synthetic-log-bytes'));
    const requestFile = path.join(caseDir, 'request.json');
    writeRequest(requestFile, baseRequest({ sessionPath, appExe: fakeApp }));

    const before = sha256(sessionPath);
    const result = runOrchestrator({ memoryRoot, requestFile, sessionsRoot });
    assert(result.status === 2, `exit ${result.status} (stderr ${result.stderr.slice(0, 300)})`);
    const results = readResultLog(memoryRoot);
    assert(results.length === 1, `expected one structured result, got ${results.length}`);
    const entry = results[0];
    assert(entry.ok === false && entry.status === 'bad-request',
      `structured result ${entry.ok}/${entry.status}`);
    assert(entry.code === 'SESSION_PATH_OUTSIDE_ROOT', `structured code ${entry.code}`);
    assert(sha256(sessionPath) === before, 'refused run changed the session bytes');
    assert(readRunLog(memoryRoot).includes('SESSION_PATH_OUTSIDE_ROOT'),
      'run log does not name the refusal');
    assert(fs.existsSync(requestFile), 'refused run removed the request');
    return 'outside-root path refused with structured JSON';
  });

  runCase('O3', 'sessionPath 在 sessions 根内 + -DryRun：exit 0，干跑声明硬杀策略，不关应用不写结果', () => {
    const caseDir = path.join(base, 'inside');
    const memoryRoot = path.join(caseDir, 'memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    const fakeApp = path.join(caseDir, 'fake.exe');
    fs.writeFileSync(fakeApp, Buffer.from('not a real executable'));
    const sessionDir = path.join(sessionsRoot, 'scope-fixtures', 'inside-session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(sessionPath, Buffer.from('synthetic-log-bytes'));
    const requestFile = path.join(caseDir, 'request.json');
    writeRequest(requestFile, baseRequest({ sessionPath, appExe: fakeApp }));

    const before = sha256(sessionPath);
    const result = runOrchestrator({
      memoryRoot, requestFile, sessionsRoot, extra: ['-DryRun'],
    });
    assert(result.status === 0, `exit ${result.status} (stdout ${result.stdout.slice(0, 400)})`);
    assert(result.stdout.includes('"dryRun"'), 'dry-run printed no plan JSON');
    const plan = parsePlanBlock(result.stdout);
    assert(plan && plan.ok === true && plan.dryRun === true, 'dry-run JSON is not parseable');
    // A dry run has to say out loud which close policy the real run would use,
    // so an operator can see the hard kill before it happens.
    assert(plan.close && plan.close.policy === 'hard-kill',
      `dry-run close policy ${JSON.stringify(plan.close)}`);
    assert(plan.close.gracefulMs === 3000, `gracefulMs ${plan.close.gracefulMs}`);
    assert(plan.close.settleMs === 2000, `settleMs ${plan.close.settleMs}`);
    assert(String(plan.close.kill).includes('Stop-Process'),
      `close.kill ${plan.close.kill}`);
    assert(readResultLog(memoryRoot).length === 0, 'dry-run wrote a result line');
    assert(sha256(sessionPath) === before, 'dry-run changed the session bytes');
    assert(fs.existsSync(requestFile), 'dry-run removed the request');
    return 'in-root dry-run passes';
  });

  runCase('O4', '关闭失败：exit 3 + CLOSE_FAILED 结构化结果，会话与请求都保留', () => {
    const caseDir = path.join(base, 'close-failed');
    const memoryRoot = path.join(caseDir, 'memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    const fakeApp = path.join(caseDir, 'fake.exe');
    fs.writeFileSync(fakeApp, Buffer.from('not a real executable'));
    const sessionDir = path.join(sessionsRoot, 'scope-fixtures', 'close-session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(sessionPath, Buffer.from('synthetic-log-bytes'));
    const requestFile = path.join(caseDir, 'request.json');
    writeRequest(requestFile, baseRequest({ sessionPath, appExe: fakeApp }));

    const beforeSha = sha256(sessionPath);
    const beforeFiles = fs.readdirSync(sessionDir).sort();
    const result = runOrchestrator({
      memoryRoot, requestFile, sessionsRoot, extra: ['-SimulateCloseFailure'],
    });
    assert(result.status === 3, `exit ${result.status} (stderr ${result.stderr.slice(0, 300)})`);
    const results = readResultLog(memoryRoot);
    assert(results.length === 1, `expected one structured result, got ${results.length}`);
    const entry = results[0];
    assert(entry.ok === false && entry.status === 'close-failed',
      `structured result ${entry.ok}/${entry.status}`);
    assert(entry.code === 'CLOSE_FAILED', `structured code ${entry.code}`);
    assert(entry.restored === false && entry.restart === false,
      'close-failed result claims a restore or restart');
    assert(sha256(sessionPath) === beforeSha, 'close-failed run changed the session bytes');
    assert(fs.readdirSync(sessionDir).sort().join('|') === beforeFiles.join('|'),
      'close-failed run created files beside the session');
    assert(fs.existsSync(requestFile), 'close-failed run removed the request');
    assert(readRunLog(memoryRoot).includes('simulated failure'),
      'run log does not record the simulated close');
    // A failed close must never reach the force-kill or the cut: the session is
    // still open, so the only correct outcome is "nothing happened".
    const runLog = readRunLog(memoryRoot);
    assert(!runLog.includes('force-killing'), 'close-failed run still tried to force-kill');
    assert(!runLog.includes('Stop-Process'), 'close-failed run reached Stop-Process');
    assert(!runLog.includes('cut: cli exit='), 'close-failed run ran truncate-cli');
    assert(entry.drift === undefined, 'close-failed result carries a drift report');
    return 'close failure reported structurally without touching the app';
  });
}

export const ORCHESTRATOR_CASES = ['O1', 'O2', 'O3', 'O4'];
