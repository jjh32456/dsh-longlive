// doctor --setup acceptance tests (0.8.0-rc.10).
//
// The wizard is a consent surface, so these tests assert the invariants that
// matter more than formatting: cancellation is inert (no spawn, no file writes,
// exit 0), only the literal uppercase YES proceeds, consent is recorded in the
// audit log, and a non-TTY run refuses to guess.
//
// stdin is a pipe under spawnSync, so DSH_DOCTOR_TEST_TTY=1 is the explicit
// test seam that makes the doctor treat it as a terminal. It is never set by
// the product; only these tests (and the BUILD.md demo) set it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOCTOR = path.join(ROOT, 'scripts', 'longlive-doctor.mjs');
const ENGRAM = '@kenz1117/dsh-engram';
const LONGLIVE = '@jjh32456/dsh-longlive';

function writeProfile(home, name, { bundles = [], dependencies = {} } = {}) {
  const dir = path.join(home, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { name, dependencies };
  if (bundles.length > 0) manifest.dsh = { profile: { bundles } };
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

function baseEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|DSH_HOME|DSH_BIN|DSH_PROFILE|DSH_DOCTOR_TEST_TTY|DSH_DOCTOR_TEST_LOG)$/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function runDoctor(home, args, options = {}) {
  const env = baseEnv();
  env.DSH_HOME = home;
  env.DSH_PROFILE = '';
  env.PATH = options.pathPrefix ?? process.env.PATH ?? '';
  if (options.tty !== false) env.DSH_DOCTOR_TEST_TTY = '1';
  if (options.log) env.DSH_DOCTOR_TEST_LOG = options.log;
  Object.assign(env, options.env ?? {});
  return spawnSync(process.execPath, [DOCTOR, ...args], {
    input: options.input ?? '',
    encoding: 'utf8',
    env,
    cwd: options.cwd ?? ROOT,
    windowsHide: true,
    timeout: 120000,
  });
}

/**
 * A fake `dsh` on PATH. It records its argv to %DSH_DOCTOR_TEST_LOG% and exits
 * with the requested code; it deliberately does NOT touch any profile, so the
 * wizard's success semantics must come from the child exit code, not from a
 * post-install recheck.
 */
function makeMockDsh(dir, { exitCode = 0, stderr = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const lines = [
      '@echo off',
      '>>"%DSH_DOCTOR_TEST_LOG%" echo %*',
    ];
    if (stderr) lines.push(`1>&2 echo ${stderr}`);
    lines.push(`exit /b ${exitCode}`);
    fs.writeFileSync(path.join(dir, 'dsh.cmd'), `${lines.join('\r\n')}\r\n`, 'utf8');
  }
  const sh = [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$DSH_DOCTOR_TEST_LOG"',
  ];
  if (stderr) sh.push(`printf '%s\\n' '${stderr}' 1>&2`);
  sh.push(`exit ${exitCode}`);
  fs.writeFileSync(path.join(dir, 'dsh'), `${sh.join('\n')}\n`, 'utf8');
  try {
    fs.chmodSync(path.join(dir, 'dsh'), 0o755);
  } catch {
    /* Windows does not need the bit */
  }
  return dir;
}

function auditLines(home) {
  const file = path.join(home, 'longlive-doctor-audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
}

function assertCancelled(run, home, logPath, assert) {
  assert(run.status === 0, `取消应 exit 0，实际 ${run.status}；stderr=${run.stderr}`);
  assert(run.stdout.includes('已取消'), `取消应打印「已取消」，实际 stdout=${run.stdout}`);
  assert(run.stdout.includes('未做任何改动'), `取消应打印「未做任何改动」，实际 stdout=${run.stdout}`);
  assert(!fs.existsSync(home), `取消不得创建/改动 DSH home，实际存在：${home}`);
  assert(!fs.existsSync(path.join(home, 'longlive-doctor-audit.log')), '取消不得写 audit 日志');
  assert(!fs.existsSync(logPath), `取消不得 spawn dsh（mock 日志存在）：${logPath}`);
}

export async function runDoctorSetupSuite({ runCase, runAsyncCase, assert, TMP }) {
  const base = path.join(TMP, 'doctor-setup');
  fs.mkdirSync(base, { recursive: true });
  const loadDeps = () => import('../src/deps.js');

  // SETUP1 — "no" cancels: exit 0, nothing spawned, nothing written.
  await runCase('SETUP1', '--setup 输入 no：取消、exit 0、零副作用', () => {
    const home = path.join(base, 'cancel-no', 'home');
    const mock = path.join(base, 'cancel-no', 'bin');
    const logPath = path.join(base, 'cancel-no', 'dsh.log');
    makeMockDsh(mock);
    const run = runDoctor(home, ['--setup'], { input: 'no\n', pathPrefix: mock, log: logPath });
    assertCancelled(run, home, logPath, assert);
    assert(run.stdout.includes(`plugin add ${ENGRAM}`), `计划里应有确切命令，实际 stdout=${run.stdout}`);
    assert(run.stdout.includes('>=0.11.0'), `计划里应有版本约束，实际 stdout=${run.stdout}`);
    return 'exit 0 · no spawn · home untouched';
  });

  // SETUP2 — lowercase yes is not consent.
  await runCase('SETUP2', '--setup 输入小写 yes：视为取消', () => {
    const home = path.join(base, 'cancel-lower', 'home');
    const mock = path.join(base, 'cancel-lower', 'bin');
    const logPath = path.join(base, 'cancel-lower', 'dsh.log');
    makeMockDsh(mock);
    const run = runDoctor(home, ['--setup'], { input: 'yes\n', pathPrefix: mock, log: logPath });
    assertCancelled(run, home, logPath, assert);
    return 'lowercase yes rejected as cancel';
  });

  // SETUP3 — literal YES: exactly one plugin add, typed-YES audit line.
  await runCase('SETUP3', '--setup 输入 YES：只执行一条 plugin add 并写 audit', () => {
    const caseDir = path.join(base, 'confirm');
    const home = path.join(caseDir, 'home');
    writeProfile(home, 'work', { bundles: [LONGLIVE] });
    const mock = makeMockDsh(path.join(caseDir, 'bin'));
    const logPath = path.join(caseDir, 'dsh.log');
    const run = runDoctor(home, ['--setup'], {
      input: 'YES\n', pathPrefix: mock, log: logPath, env: { DSH_DOCTOR_TEST_LOG: logPath },
    });
    assert(run.status === 0, `YES 安装成功应 exit 0，实际 ${run.status}；stdout=${run.stdout} stderr=${run.stderr}`);
    const calls = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    assert(calls.length === 1, `只应 spawn 一次 dsh，实际 ${calls.length} 次：${JSON.stringify(calls)}`);
    assert(calls[0].trim() === `plugin --profile work add ${ENGRAM}`, `命令应为 plugin --profile work add ${ENGRAM}，实际 ${JSON.stringify(calls[0])}`);
    const lines = auditLines(home);
    assert(lines.length === 1, `应写一行 audit，实际 ${lines.length} 行：${JSON.stringify(lines)}`);
    const entry = JSON.parse(lines[0]);
    assert(entry.consent === 'typed-YES', `audit consent 应为 typed-YES，实际 ${JSON.stringify(entry.consent)}`);
    assert(typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)), 'audit timestamp 应为可解析时间');
    assert(typeof entry.user === 'string' && entry.user !== '', 'audit user 不应为空');
    assert(Array.isArray(entry.deps) && entry.deps.includes(ENGRAM), 'audit deps 应包含缺失包');
    assert(entry.result === 'ok', `audit result 应为 ok，实际 ${JSON.stringify(entry.result)}`);
    assert(entry.exitCode === 0, `audit exitCode 应为 0，实际 ${JSON.stringify(entry.exitCode)}`);
    assert(run.stdout.includes('重启宿主后生效'), `成功应打印重启指引，实际 stdout=${run.stdout}`);
    return 'one plugin add · typed-YES audit · restart guidance';
  });

  // SETUP4 — child exit 7: non-zero, stderr excerpt, failed audit.
  await runCase('SETUP4', '--setup YES + mock exit 7：非零退出、stderr 片段、audit failed', () => {
    const caseDir = path.join(base, 'fail');
    const home = path.join(caseDir, 'home');
    writeProfile(home, 'work', { bundles: [LONGLIVE] });
    const mock = makeMockDsh(path.join(caseDir, 'bin'), { exitCode: 7, stderr: 'mock-dsh: cannot install (exit 7)' });
    const logPath = path.join(caseDir, 'dsh.log');
    const run = runDoctor(home, ['--setup'], {
      input: 'YES\n', pathPrefix: mock, log: logPath, env: { DSH_DOCTOR_TEST_LOG: logPath },
    });
    assert(run.status !== 0, `安装失败应非零退出，实际 ${run.status}`);
    assert(run.stderr.includes('mock-dsh'), `stderr 应含子进程输出片段，实际 stderr=${run.stderr}`);
    const lines = auditLines(home);
    assert(lines.length === 1, `失败也应写一行 audit，实际 ${lines.length} 行`);
    const entry = JSON.parse(lines[0]);
    assert(entry.result === 'failed', `audit result 应为 failed，实际 ${JSON.stringify(entry.result)}`);
    assert(entry.exitCode !== 0, `audit exitCode 应非零，实际 ${JSON.stringify(entry.exitCode)}`);
    assert(Array.isArray(entry.deps) && entry.deps.includes(ENGRAM), 'audit deps 应记录尝试安装的包');
    return 'exit 1 · stderr excerpt · failed audit';
  });

  // SETUP5 — unattended: non-TTY + --yes executes and records consent "--yes".
  await runCase('SETUP5', '--setup --yes 非 TTY：跳过交互直接执行', () => {
    const caseDir = path.join(base, 'unattended');
    const home = path.join(caseDir, 'home');
    writeProfile(home, 'work', { bundles: [LONGLIVE] });
    const mock = makeMockDsh(path.join(caseDir, 'bin'));
    const logPath = path.join(caseDir, 'dsh.log');
    const run = runDoctor(home, ['--setup', '--yes'], {
      input: '', tty: false, pathPrefix: mock, log: logPath, env: { DSH_DOCTOR_TEST_LOG: logPath },
    });
    assert(run.status === 0, `--setup --yes 应成功，实际 ${run.status}；stderr=${run.stderr}`);
    assert(run.stdout.includes(`plugin --profile work add ${ENGRAM}`), '仍应先打印计划');
    const calls = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    assert(calls.length === 1 && calls[0].trim() === `plugin --profile work add ${ENGRAM}`, `应执行一条命令，实际 ${JSON.stringify(calls)}`);
    const entry = JSON.parse(auditLines(home)[0]);
    assert(entry.consent === '--yes', `audit consent 应为 --yes，实际 ${JSON.stringify(entry.consent)}`);
    assert(entry.result === 'ok', `audit result 应为 ok，实际 ${JSON.stringify(entry.result)}`);
    return 'non-TTY --yes executed · consent --yes';
  });

  // SETUP6 — non-TTY without --yes must refuse with exit 2, before any write.
  await runCase('SETUP6', '--setup 非 TTY 无 --yes：exit 2 且什么都不做', () => {
    const home = path.join(base, 'refuse', 'home');
    const mock = path.join(base, 'refuse', 'bin');
    const logPath = path.join(base, 'refuse', 'dsh.log');
    makeMockDsh(mock);
    const run = runDoctor(home, ['--setup'], { input: '', tty: false, pathPrefix: mock, log: logPath });
    assert(run.status === 2, `非 TTY 无 --yes 应 exit 2，实际 ${run.status}`);
    assert(run.stderr.includes('--setup 在非交互环境'), `提示应说明 --setup 在非交互环境的规则，实际 stderr=${run.stderr}`);
    assert(run.stderr.includes('--yes'), `提示应告诉用户用 --yes，实际 stderr=${run.stderr}`);
    assert(!fs.existsSync(logPath), '拒绝时不得 spawn dsh');
    assert(!fs.existsSync(path.join(home, 'longlive-doctor-audit.log')), '拒绝时不得写 audit');
    return 'exit 2 · --yes hint · inert';
  });

  // SETUP7 — startup copy is a pure function; it must point at --setup.
  await runAsyncCase('SETUP7', '启动指引文案包含 --setup 与确认提示', async () => {
    const { formatMissingDepsWarning } = await loadDeps();
    assert(typeof formatMissingDepsWarning === 'function', 'src/deps.js 应导出 formatMissingDepsWarning');
    const message = formatMissingDepsWarning([ENGRAM]);
    assert(typeof message === 'string', '缺包时应有文案');
    assert(message.includes(`可选依赖缺失：${ENGRAM}`), `文案应以「可选依赖缺失：<包名>」开头，实际：${message}`);
    assert(message.includes('--setup'), `文案应指向 --setup，实际：${message}`);
    assert(message.includes('会先列清单再要你确认'), `文案应说明先列清单再确认，实际：${message}`);
    assert(formatMissingDepsWarning([]) === null, '无缺失时应返回 null，保持安静');
    return 'startup copy points at --setup';
  });

  // SETUP8 — EOF is a cancellation, not a hang or a crash.
  await runCase('SETUP8', '--setup 遇到 EOF：取消且零副作用', () => {
    const home = path.join(base, 'eof', 'home');
    const mock = path.join(base, 'eof', 'bin');
    const logPath = path.join(base, 'eof', 'dsh.log');
    makeMockDsh(mock);
    const run = runDoctor(home, ['--setup'], { input: '', pathPrefix: mock, log: logPath });
    assertCancelled(run, home, logPath, assert);
    return 'EOF treated as cancel';
  });

  // SETUP9 — --help must advertise the new main entry point.
  await runCase('SETUP9', '--help 列出 --setup 与 YES 确认', () => {
    const home = path.join(base, 'help', 'home');
    const run = runDoctor(home, ['--help'], { tty: false });
    assert(run.status === 0, `--help 应 exit 0，实际 ${run.status}`);
    assert(run.stdout.includes('--setup'), '--help 应提到 --setup');
    assert(run.stdout.includes('YES'), '--help 应说明需要输入大写 YES');
    return 'help advertises --setup';
  });
}

// ── 单跑入口（被 run.mjs import 时不打印）──────────────────────────────
const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const results = [];
  const assert = (cond, message) => {
    if (!cond) throw new Error(message || 'assertion failed');
  };
  const runCase = (id, name, fn) => {
    const started = Date.now();
    try {
      const detail = fn();
      results.push({ id, ok: true, detail, ms: Date.now() - started });
    } catch (error) {
      results.push({ id, ok: false, detail: error.message, ms: Date.now() - started });
    }
    const last = results[results.length - 1];
    console.log(`${last.ok ? 'PASS' : 'FAIL'}  ${last.id}  ${name}  ${last.detail ?? ''}`);
  };
  const runAsyncCase = async (id, name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ id, ok: true, detail, ms: Date.now() - started });
    } catch (error) {
      results.push({ id, ok: false, detail: error.message, ms: Date.now() - started });
    }
    const last = results[results.length - 1];
    console.log(`${last.ok ? 'PASS' : 'FAIL'}  ${last.id}  ${name}  ${last.detail ?? ''}`);
  };

  const directTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-doctor-setup-direct-'));
  try {
    await runDoctorSetupSuite({ runCase, runAsyncCase, assert, TMP: directTmp });
  } catch (error) {
    console.error(`suite crashed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
  const failedCases = results.filter((entry) => !entry.ok);
  const totalMs = results.reduce((sum, entry) => sum + entry.ms, 0);
  console.log(`\n${results.length - failedCases.length} passed, ${failedCases.length} failed, ${totalMs}ms total`);
  if (failedCases.length > 0) process.exitCode = 1;
}
