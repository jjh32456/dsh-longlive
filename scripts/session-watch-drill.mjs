#!/usr/bin/env node
// End-to-end drill for the resident session watchdog.
//
// It builds throwaway DSH homes under the OS temp directory, writes v4 session
// fixtures with the package's own encoder, and drives the real watcher + real
// truncate CLI through:
//
//   check      profile config is read; mode resolves to dryrun
//   dryrun     a planned cut; session bytes/hash do not move; receipt says so
//   request    profile mode flips to request; one real cut; backup + archive +
//              receipt all present and verified
//   kill       profile enabled=false; the watcher does nothing
//   live       fresh live row; the watcher refuses and leaves the file alone
//   corrupt    an unparseable session is reported, but the process still exits 0
//   loop       a running loop notices enabled=false within one poll and exits on
//              stop.flag
//
// No real session is read or written: every path is under --workdir, which
// defaults to a new directory under the OS temp dir. The drill never installs
// anything and never touches Task Scheduler.
//
//   node scripts/session-watch-drill.mjs
//   node scripts/session-watch-drill.mjs --workdir <drill-dir> --clean
//
// stdout is one JSON document; the same document is written to
// <workdir>/drill-result.json. Exit 0 = every check passed, 1 = a check failed,
// 2 = bad arguments.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseSession } from '../src/codec.js';
import { sessionEstimate } from '../src/truncate-visible.js';
import { writeFixture, writeLiveRow, writeCorruptSession } from './lib/session-watch-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WATCHER = path.join(HERE, 'session-watch.mjs');
const CLI = path.join(HERE, 'truncate-cli.mjs');
const NODE = process.execPath;

function usage() {
  return [
    'session-watch drill',
    '',
    '  node scripts/session-watch-drill.mjs [--workdir <dir>] [--clean] [--verbose]',
    '',
    '  --workdir  where to build throwaway homes (default: OS temp)',
    '  --clean    delete the workdir on success (default: keep evidence)',
    '  --verbose  print each check to stderr',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { workdir: null, clean: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--clean') options.clean = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--workdir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--workdir needs a value');
      i += 1;
      options.workdir = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function iso(now = Date.now()) {
  return new Date(now).toISOString();
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(predicate).sort();
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

function writeProfile(file, { enabled, mode, cooldownMinutes = 0 }) {
  const yaml = [
    '# Drill profile: the watcher reads only the autoTruncate block.',
    'plugins:',
    '  session-longlive:',
    '    autoTruncate:',
    `      enabled: ${enabled}`,
    `      mode: ${mode}`,
    '      tokensThreshold: 1000',
    '      minTurns: 1',
    '      keepTurns: 4',
    '      keepTokens: 100000',
    '      firstUserCapChars: 4000',
    '      boundaryRetries: 3',
    `      cooldownMinutes: ${cooldownMinutes}`,
    '',
  ].join('\n');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, yaml, 'utf8');
  return yaml;
}

function makeEnv(workdir, name, { enabled, mode, cooldownMinutes = 0 } = {}) {
  const root = path.join(workdir, safeName(name));
  const dshHome = path.join(root, 'dsh-home');
  const sessionsRoot = path.join(dshHome, 'sessions');
  const memoryRoot = path.join(root, 'memory');
  const profilePath = path.join(root, 'profile', 'cordis.patch.yml');
  const configPath = path.join(root, 'config.json');
  ensureDir(sessionsRoot);
  ensureDir(memoryRoot);
  writeProfile(profilePath, { enabled, mode, cooldownMinutes });
  const config = {
    version: 1,
    enabled: true,
    mode: 'dryrun',
    intervalSeconds: 1,
    settleSeconds: 0,
    tokensThreshold: 1000,
    minTurns: 1,
    keepTurns: 4,
    keepTokens: 100000,
    firstUserCapChars: 4000,
    boundaryRetries: 3,
    cooldownMinutes,
    profileConfig: profilePath,
    memoryRoot,
    sessionsRoot,
    dshHome,
    nodeExe: NODE,
    cliPath: CLI,
    scanMaxFiles: 20,
    cliTimeoutSeconds: 120,
    logMaxBytes: 1024 * 1024,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return {
    name,
    root,
    dshHome,
    sessionsRoot,
    memoryRoot,
    profilePath,
    configPath,
    config,
    receiptDir: path.join(memoryRoot, '.longlive', 'session-watch', 'receipts'),
    statePath: path.join(memoryRoot, '.longlive', 'session-watch', 'state.json'),
    logPath: path.join(memoryRoot, '.longlive', 'logs', 'session-watch.log'),
    lastTickPath: path.join(memoryRoot, '.longlive', 'session-watch', 'last-tick.json'),
    stopFlag: path.join(memoryRoot, '.longlive', 'session-watch', 'stop.flag'),
  };
}

function runWatcher(env, args) {
  const started = Date.now();
  const result = spawnSync(NODE, [WATCHER, '--config', env.configPath, ...args], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: env.dshHome, DSH_MEM: env.memoryRoot },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  let json = null;
  try {
    json = JSON.parse(String(result.stdout ?? '').trim());
  } catch {
    json = null;
  }
  return {
    args,
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
    json,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function parseOk(file) {
  try {
    return sessionEstimate(parseSession(fs.readFileSync(file)));
  } catch {
    return null;
  }
}

function backupFiles(sessionFile) {
  const dir = path.dirname(sessionFile);
  return listFiles(dir, (name) => name.includes('.bak-')).map((name) => path.join(dir, name));
}

function archiveFiles(sessionFile) {
  const dir = `${sessionFile}.archive`;
  return listFiles(dir).map((name) => path.join(dir, name));
}

function waitFor(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      let value = false;
      try { value = fn(); } catch { value = false; }
      if (value) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function createReport(verbose) {
  const checks = [];
  const phases = {};
  const check = (phase, name, ok, detail = {}) => {
    const entry = { phase, name, ok: Boolean(ok), ...detail };
    checks.push(entry);
    if (!ok || verbose) {
      process.stderr.write(`${ok ? 'PASS' : 'FAIL'} ${phase}/${name}${detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}\n`);
    }
    return Boolean(ok);
  };
  return { checks, phases, check };
}

// -------------------------------------------------------------------- phases
function phaseCheck(env, check) {
  const run = runWatcher(env, ['--check']);
  check('check', 'exit-0', run.exitCode === 0, { exitCode: run.exitCode, stderr: run.stderr.slice(0, 500) });
  const json = run.json;
  check('check', 'json-ok', Boolean(json?.ok === true));
  check('check', 'mode-dryrun-from-profile', json?.mode === 'dryrun', { mode: json?.mode ?? null, source: json?.modeSource ?? null });
  check('check', 'mode-source-profile', String(json?.modeSource ?? '').startsWith('profile:'), { source: json?.modeSource ?? null });
  check('check', 'enabled', json?.enabled === true);
  check('check', 'profile-path', path.resolve(String(json?.profileConfig ?? '')) === path.resolve(env.profilePath));
  return run;
}

function phaseDryrun(env, fixture, check) {
  const before = fs.readFileSync(fixture.file);
  const beforeSha = sha256(before);
  const beforeEstimate = parseOk(fixture.file);
  const run = runWatcher(env, ['--once']);
  check('dryrun', 'exit-0', run.exitCode === 0, { exitCode: run.exitCode });
  const json = run.json;
  check('dryrun', 'json-ok', Boolean(json?.ok === true), { status: json?.status ?? null });
  check('dryrun', 'mode-dryrun', json?.mode === 'dryrun', { mode: json?.mode ?? null });
  check('dryrun', 'scanned-1', json?.scanned === 1, { scanned: json?.scanned ?? null });
  const action = json?.actions?.[0] ?? null;
  check('dryrun', 'action-planned', action?.status === 'planned', { status: action?.status ?? null });
  check('dryrun', 'action-verification', action?.verificationOk === true);
  check('dryrun', 'estimates-available', Boolean(beforeEstimate && beforeEstimate.tokens > 0), { estimate: beforeEstimate });
  const after = fs.readFileSync(fixture.file);
  check('dryrun', 'session-bytes-unchanged', sha256(after) === beforeSha, { beforeSha, afterSha: sha256(after) });
  check('dryrun', 'no-backup', backupFiles(fixture.file).length === 0, { backups: backupFiles(fixture.file) });
  check('dryrun', 'no-archive', archiveFiles(fixture.file).length === 0, { archives: archiveFiles(fixture.file) });
  check('dryrun', 'no-inflight', !fs.existsSync(path.join(path.dirname(fixture.file), '.truncate-visible-inflight.json')));
  const receipts = listFiles(env.receiptDir, (name) => name.endsWith('.json'));
  check('dryrun', 'receipt-written', receipts.length === 1, { receipts });
  let receipt = null;
  if (receipts.length > 0) receipt = readJson(path.join(env.receiptDir, receipts[0]));
  check('dryrun', 'receipt-mode-dryrun', receipt?.mode === 'dryrun', { mode: receipt?.mode ?? null });
  check('dryrun', 'receipt-wrote-session-false', receipt?.wroteSession === false);
  check('dryrun', 'receipt-verification-ok', receipt?.verification?.ok === true);
  return { run, receipt, beforeSha, beforeEstimate };
}

function phaseRequest(env, fixture, check, beforeSha) {
  writeProfile(env.profilePath, { enabled: true, mode: 'request', cooldownMinutes: 0 });
  const before = fs.readFileSync(fixture.file);
  const beforeStat = fs.statSync(fixture.file);
  const beforeReceipts = listFiles(env.receiptDir, (name) => name.endsWith('.json')).length;
  const run = runWatcher(env, ['--once']);
  check('request', 'exit-0', run.exitCode === 0, { exitCode: run.exitCode });
  const json = run.json;
  check('request', 'mode-request', json?.mode === 'request', { mode: json?.mode ?? null });
  const action = json?.actions?.[0] ?? null;
  check('request', 'action-truncated', action?.status === 'truncated', { status: action?.status ?? null, cliStatus: action?.cliStatus ?? null });
  check('request', 'verification-ok', action?.verificationOk === true);
  const after = fs.readFileSync(fixture.file);
  const afterStat = fs.statSync(fixture.file);
  check('request', 'bytes-shrunk', afterStat.size < beforeStat.size, {
    beforeBytes: beforeStat.size, afterBytes: afterStat.size, actionBefore: action?.bytesBefore ?? null, actionAfter: action?.bytesAfter ?? null,
  });
  check('request', 'sha-changed', sha256(after) !== beforeSha);
  const afterEstimate = parseOk(fixture.file);
  check('request', 'still-parseable', Boolean(afterEstimate), { afterEstimate });
  const backups = backupFiles(fixture.file);
  check('request', 'backup-exists', backups.length === 1, { backups });
  if (backups.length === 1) {
    check('request', 'backup-hash-matches-before', sha256File(backups[0]) === beforeSha, {
      backup: backups[0], backupSha: sha256File(backups[0]), beforeSha,
    });
  }
  const archives = archiveFiles(fixture.file);
  check('request', 'archive-exists', archives.length === 1, { archives });
  check('request', 'no-inflight', !fs.existsSync(path.join(path.dirname(fixture.file), '.truncate-visible-inflight.json')));
  const receipts = listFiles(env.receiptDir, (name) => name.endsWith('.json'));
  check('request', 'one-new-receipt', receipts.length === beforeReceipts + 1, { beforeReceipts, receipts });
  let receipt = null;
  for (const name of receipts) {
    const candidate = readJson(path.join(env.receiptDir, name));
    if (candidate?.mode === 'request') receipt = candidate;
  }
  check('request', 'receipt-mode-request', receipt?.mode === 'request', { mode: receipt?.mode ?? null });
  check('request', 'receipt-wrote-session', receipt?.wroteSession === true);
  check('request', 'receipt-verification-ok', receipt?.verification?.ok === true);
  return { run, receipt, afterBytes: afterStat.size, afterEstimate, backups, archives };
}

function phaseKillSwitch(workdir, check) {
  const env = makeEnv(workdir, 'kill-switch', { enabled: false, mode: 'request' });
  const fixture = writeFixture({ sessionsRoot: env.sessionsRoot, id: 'session-drill-kill', turns: 20, padding: 500 });
  const beforeSha = sha256File(fixture.file);
  const run = runWatcher(env, ['--once']);
  check('kill', 'exit-0', run.exitCode === 0, { exitCode: run.exitCode });
  check('kill', 'status-disabled', run.json?.status === 'disabled', { status: run.json?.status ?? null });
  check('kill', 'mode-request-but-disabled', run.json?.mode === 'request' && run.json?.enabled === false, {
    mode: run.json?.mode ?? null, enabled: run.json?.enabled ?? null,
  });
  check('kill', 'no-receipt', listFiles(env.receiptDir).length === 0);
  check('kill', 'session-unchanged', sha256File(fixture.file) === beforeSha);
  check('kill', 'no-backup', backupFiles(fixture.file).length === 0);
  return { env, fixture, run };
}

function phaseLive(workdir, check) {
  const env = makeEnv(workdir, 'live-block', { enabled: true, mode: 'request' });
  const fixture = writeFixture({ sessionsRoot: env.sessionsRoot, id: 'session-drill-live', turns: 20, padding: 500 });
  const live = writeLiveRow({ memoryRoot: env.memoryRoot, sessionId: 'session-drill-live', state: 'running' });
  const beforeSha = sha256File(fixture.file);
  const run = runWatcher(env, ['--once']);
  check('live', 'exit-0', run.exitCode === 0, { exitCode: run.exitCode });
  check('live', 'no-action', (run.json?.actions ?? []).length === 0, { actions: run.json?.actions ?? [] });
  const blocked = run.json?.blocked ?? [];
  check('live', 'blocked-health', blocked.length === 1 && blocked[0]?.stage === 'health', { blocked });
  check('live', 'blocked-by-live-registry', (blocked[0]?.reasons ?? []).some((reason) => reason.signal === 'live-registry' && reason.state === 'running'), { blocked });
  check('live', 'session-unchanged', sha256File(fixture.file) === beforeSha);
  check('live', 'no-receipt', listFiles(env.receiptDir).length === 0);
  check('live', 'live-row-exists', fs.existsSync(live.file));
  return { env, fixture, run, live };
}

function phaseCorrupt(workdir, check) {
  const env = makeEnv(workdir, 'corrupt-fail-soft', { enabled: true, mode: 'request' });
  writeCorruptSession({ sessionsRoot: env.sessionsRoot, id: 'session-drill-corrupt' });
  const run = runWatcher(env, ['--once']);
  check('corrupt', 'exit-0-fail-soft', run.exitCode === 0, { exitCode: run.exitCode });
  check('corrupt', 'degraded-not-crash', run.json?.ok === false && run.json?.status === 'degraded', {
    runOk: run.json?.ok ?? null, status: run.json?.status ?? null,
  });
  const parseError = (run.json?.errors ?? []).find((error) => error.stage === 'parse');
  check('corrupt', 'parse-error-reported', Boolean(parseError), { errors: run.json?.errors ?? [] });
  check('corrupt', 'no-action', (run.json?.actions ?? []).length === 0);
  check('corrupt', 'log-written', fs.existsSync(env.logPath));
  return { env, run };
}

async function phaseLoop(workdir, check) {
  const env = makeEnv(workdir, 'loop-kill', { enabled: true, mode: 'dryrun', cooldownMinutes: 60 });
  const fixture = writeFixture({ sessionsRoot: env.sessionsRoot, id: 'session-drill-loop', turns: 20, padding: 500 });
  const stdoutPath = path.join(env.root, 'loop.stdout.log');
  const stderrPath = path.join(env.root, 'loop.stderr.log');
  const out = fs.openSync(stdoutPath, 'w');
  const err = fs.openSync(stderrPath, 'w');
  const child = spawn(NODE, [WATCHER, '--config', env.configPath, '--loop'], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: env.dshHome, DSH_MEM: env.memoryRoot },
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  fs.closeSync(out);
  fs.closeSync(err);
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error: String(error?.message ?? error) }));
  });

  const firstTick = await waitFor(() => fs.existsSync(env.lastTickPath), 15_000);
  check('loop', 'first-tick', firstTick, { lastTickPath: env.lastTickPath });
  const firstReceipts = listFiles(env.receiptDir, (name) => name.endsWith('.json'));
  check('loop', 'first-dryrun-receipt', firstReceipts.length >= 1, { receipts: firstReceipts });

  writeProfile(env.profilePath, { enabled: false, mode: 'dryrun', cooldownMinutes: 60 });
  const disabledLogged = await waitFor(() => {
    if (!fs.existsSync(env.logPath)) return false;
    return fs.readFileSync(env.logPath, 'utf8').includes('"event":"disabled"');
  }, 12_000, 300);
  check('loop', 'disabled-observed', disabledLogged);
  const countAtDisable = listFiles(env.receiptDir, (name) => name.endsWith('.json')).length;
  await sleep(6_000);
  const countAfterWait = listFiles(env.receiptDir, (name) => name.endsWith('.json')).length;
  check('loop', 'no-receipt-while-disabled', countAfterWait === countAtDisable, { countAtDisable, countAfterWait });

  fs.writeFileSync(env.stopFlag, `${iso()}\n`, 'utf8');
  const exited = await Promise.race([
    exitPromise,
    sleep(15_000).then(() => ({ timeout: true })),
  ]);
  check('loop', 'stop-flag-exits', !exited.timeout, { exit: exited });
  if (exited.timeout) {
    try { child.kill(); } catch { /* already gone */ }
  } else {
    check('loop', 'exit-code-0', exited.code === 0, { exit: exited });
  }
  return {
    env,
    fixture,
    firstReceipts,
    countAtDisable,
    countAfterWait,
    exit: exited,
    stdoutPath,
    stderrPath,
  };
}

// ---------------------------------------------------------------------- main
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const workdir = options.workdir ?? path.join(os.tmpdir(), `dsh-session-watch-drill-${stamp}`);
  if (fs.existsSync(workdir)) {
    const entries = fs.readdirSync(workdir);
    if (entries.length > 0) {
      throw new Error(`workdir is not empty: ${workdir}; pass a new --workdir or clean it first`);
    }
  }
  ensureDir(workdir);

  const report = createReport(options.verbose);
  const { check } = report;
  report.workdir = workdir;
  report.startedAt = iso(startedAt);
  report.node = NODE;
  report.watcher = WATCHER;
  report.cli = CLI;

  // 1. config gate -----------------------------------------------------------------
  const dryEnv = makeEnv(workdir, 'dry-run', { enabled: true, mode: 'dryrun' });
  const fixture = writeFixture({ sessionsRoot: dryEnv.sessionsRoot, id: 'session-drill-dry', turns: 20, padding: 500 });
  report.phases.check = phaseCheck(dryEnv, check);
  report.fixture = { path: fixture.file, bytes: fixture.bytes, turns: 20, padding: 500 };

  // 2. dry-run must not write -------------------------------------------------------
  const dry = phaseDryrun(dryEnv, fixture, check);
  report.phases.dryrun = { exitCode: dry.run.exitCode, action: dry.run.json?.actions?.[0] ?? null, receipt: dry.receipt };

  // 3. request must write once ------------------------------------------------------
  const request = phaseRequest(dryEnv, fixture, check, dry.beforeSha);
  report.phases.request = {
    exitCode: request.run.exitCode,
    action: request.run.json?.actions?.[0] ?? null,
    receipt: request.receipt,
    bytesAfter: request.afterBytes,
    afterEstimate: request.afterEstimate,
    backups: request.backups,
    archives: request.archives,
  };

  // 4. kill switch ------------------------------------------------------------------
  const kill = phaseKillSwitch(workdir, check);
  report.phases.kill = { env: kill.env.root, run: kill.run.json };

  // 5. live row ---------------------------------------------------------------------
  const live = phaseLive(workdir, check);
  report.phases.live = { env: live.env.root, run: live.run.json, liveRow: live.live.file };

  // 6. corrupt session: noisy, not fatal --------------------------------------------
  const corrupt = phaseCorrupt(workdir, check);
  report.phases.corrupt = { env: corrupt.env.root, run: corrupt.run.json };

  // 7. loop: enabled=false takes effect without a restart ---------------------------
  const loop = await phaseLoop(workdir, check);
  report.phases.loop = {
    env: loop.env.root,
    firstReceipts: loop.firstReceipts,
    countAtDisable: loop.countAtDisable,
    countAfterWait: loop.countAfterWait,
    exit: loop.exit,
  };

  report.finishedAt = iso();
  report.durationMs = Date.now() - startedAt;
  report.checks = report.checks;
  report.failed = report.checks.filter((entry) => !entry.ok);
  report.ok = report.failed.length === 0;

  const resultPath = path.join(workdir, 'drill-result.json');
  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  report.resultPath = resultPath;

  if (options.clean && report.ok) {
    const tmpRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(workdir);
    const insideTmp = resolved.toLowerCase().startsWith(tmpRoot.toLowerCase() + path.sep);
    if (!insideTmp || !path.basename(resolved).startsWith('dsh-session-watch-drill-')) {
      process.stderr.write(`refusing to clean a non-drill directory: ${resolved}\n`);
    } else {
      fs.rmSync(resolved, { recursive: true, force: true });
      process.stdout.write(`${JSON.stringify({ ok: true, cleaned: resolved, checks: report.checks.length }, null, 2)}\n`);
      return;
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
