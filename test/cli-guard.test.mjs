// @local/dsh-longlive — the CLI's own "is this session still running?" gate
//
// scripts/truncate-cli.mjs is spawned by the orchestrator after the app was
// supposed to exit. It has no tool context, so it must answer the live-target
// question itself. These cases pin that contract:
//   * the CLI source does not import the tool layer (the gate cannot be the
//     tool's guard reached through a second door);
//   * a fresh live-registry row refuses with SESSION_IS_RUNNING and leaves
//     every byte alone;
//   * an inherited $DSH_SESSION_ID naming the target refuses the same way;
//   * the exclusive-handle probe is wired in (held -> running);
//   * with no live signal the CLI cuts normally.
//
// Fixtures are synthetic logs under TMP; nothing here reads ~/.dsh/sessions.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeFixture } from './truncate-visible.test.mjs';
import { detectLiveTarget, LIVE_TARGET_CODES, sessionIdOfLogFile } from '../src/live-target.js';
import { liveUpdate } from '../src/live.js';
import { ERROR_CODES } from '../src/truncate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'scripts', 'truncate-cli.mjs');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runCli(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
  }
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const lines = String(run.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{')) ?? null;
  let json = null;
  if (jsonLine) {
    try { json = JSON.parse(jsonLine); } catch { json = null; }
  }
  return {
    status: run.status,
    json,
    stdout: String(run.stdout ?? ''),
    stderr: String(run.stderr ?? ''),
  };
}

function visibleArgs(sessionPath, memoryRoot) {
  return [
    '--session', sessionPath,
    '--keep-turns', '5',
    '--keep-tokens', '1000000',
    '--confirm', 'TRUNCATE-VISIBLE',
    '--memory-root', memoryRoot,
  ];
}

export function runCliGuardSuite({ runCase, assert, TMP }) {
  const base = path.join(TMP, 'cli-guard');
  fs.mkdirSync(base, { recursive: true });
  // rc.2: truncate-cli.mjs only writes under <DSH_HOME>/sessions; fixtures
  // already live at <base>/home/sessions, so point the child at that home.
  const cli = (args, extra = {}) => runCli(args, { DSH_HOME: path.join(base, 'home'), ...extra });

  runCase('CLI1', 'truncate-cli 不 import 工具层，活体判定由 detectLiveTarget 自己完成', () => {
    const source = fs.readFileSync(CLI, 'utf8');
    assert(!/src[\\/]tools\.js/.test(source), 'CLI source still references src/tools.js');
    assert(source.includes('detectLiveTarget'), 'CLI does not call detectLiveTarget');
    assert(source.includes('SESSION_IS_RUNNING'), 'CLI does not name the refusal code');
    assert(source.includes('--memory-root'), 'CLI cannot receive the memory root');
    return 'CLI self-checks via live-target.js only';
  });

  runCase('CLI2', 'detectLiveTarget：注册表/独占句柄/$DSH_SESSION_ID 任一命中即 running', () => {
    const { file } = writeFixture(base, 'guard-unit');
    const targetId = sessionIdOfLogFile(file).id;

    const held = detectLiveTarget(file, {
      env: {},
      probe: () => {
        const error = new Error('held by the app');
        error.code = ERROR_CODES.FILE_BUSY;
        throw error;
      },
    });
    assert(held.running === true && held.code === LIVE_TARGET_CODES.SESSION_IS_RUNNING,
      `held handle -> running=${held.running} code=${held.code}`);
    assert(held.reasons.some((item) => item.signal === 'exclusive-handle'),
      'held handle produced no exclusive-handle reason');

    const free = detectLiveTarget(file, { env: {}, probe: () => {} });
    assert(free.running === false, `free handle -> running=${free.running}`);
    assert(free.checks.some((item) => item.name === 'exclusive-handle' && item.status === 'free'),
      'free handle was not recorded');

    const envHit = detectLiveTarget(file, {
      env: { DSH_SESSION_ID: targetId.toUpperCase() },
      probe: () => {},
    });
    assert(envHit.running === true, 'inherited $DSH_SESSION_ID was not treated as running');
    assert(envHit.reasons.some((item) => item.signal === 'env-session-id'),
      'env hit produced no env-session-id reason');
    assert(envHit.code === LIVE_TARGET_CODES.SESSION_IS_RUNNING, `env hit code ${envHit.code}`);

    const memRoot = path.join(base, 'unit-memory');
    fs.mkdirSync(memRoot, { recursive: true });
    liveUpdate({ sessionId: targetId, state: 'running' }, { memoryRoot: memRoot });
    const registryHit = detectLiveTarget(file, { memoryRoot: memRoot, env: {}, probe: () => {} });
    assert(registryHit.running === true, 'fresh live-registry row was not treated as running');
    assert(registryHit.reasons.some((item) => item.signal === 'live-registry'),
      'registry hit produced no live-registry reason');
    return 'all three signals refuse';
  });

  runCase('CLI3', 'CLI 在写前看到 running 注册表行：exit 2 + SESSION_IS_RUNNING，字节不变', () => {
    const { file } = writeFixture(base, 'guard-registry');
    const targetId = sessionIdOfLogFile(file).id;
    const memRoot = path.join(base, 'registry-memory');
    fs.mkdirSync(memRoot, { recursive: true });
    liveUpdate({ sessionId: targetId, state: 'running' }, { memoryRoot: memRoot });

    const before = sha256(file);
    const beforeFiles = fs.readdirSync(path.dirname(file)).sort();
    const result = cli(visibleArgs(file, memRoot), { DSH_SESSION_ID: undefined });
    assert(result.status === 2, `exit ${result.status} (stderr ${result.stderr.slice(0, 200)})`);
    assert(result.json && result.json.ok === false, 'refusal emitted no ok:false JSON');
    assert(result.json.code === LIVE_TARGET_CODES.SESSION_IS_RUNNING,
      `refusal code ${result.json && result.json.code}`);
    assert(sha256(file) === before, 'refused CLI run changed the session bytes');
    assert(fs.readdirSync(path.dirname(file)).sort().join('|') === beforeFiles.join('|'),
      'refused CLI run created files beside the session');
    return 'registry row blocks the write';
  });

  runCase('CLI4', 'CLI 继承 $DSH_SESSION_ID 指向目标会话：exit 2 + SESSION_IS_RUNNING', () => {
    const { file } = writeFixture(base, 'guard-env');
    const targetId = sessionIdOfLogFile(file).id;
    const memRoot = path.join(base, 'env-memory');
    fs.mkdirSync(memRoot, { recursive: true });

    const before = sha256(file);
    const result = cli(visibleArgs(file, memRoot), { DSH_SESSION_ID: targetId });
    assert(result.status === 2, `exit ${result.status}`);
    assert(result.json && result.json.code === LIVE_TARGET_CODES.SESSION_IS_RUNNING,
      `refusal code ${result.json && result.json.code}`);
    const reasons = Array.isArray(result.json.reasons) ? result.json.reasons : [];
    assert(reasons.some((item) => item.signal === 'env-session-id'),
      'refusal did not name the env-session-id signal');
    assert(sha256(file) === before, 'refused CLI run changed the session bytes');
    return 'inherited session id blocks the write';
  });

  runCase('CLI6', 'CLI 拒绝 sessions 根外的 --session：exit 2 + E_SESSION_PATH_OUTSIDE，字节不变', () => {
    const outsideDir = path.join(base, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, 'session.v4.jsonl.zstd');
    fs.copyFileSync(writeFixture(base, 'guard-outside-src').file, outside);
    const before = sha256(outside);
    const result = cli(visibleArgs(outside, path.join(base, 'outside-memory')), { DSH_SESSION_ID: undefined });
    assert(result.status === 2, `exit ${result.status} code=${result.json && result.json.code}`);
    assert(result.json && result.json.ok === false, 'outside path emitted no ok:false JSON');
    assert(result.json.code === 'E_SESSION_PATH_OUTSIDE', `outside code ${result.json && result.json.code}`);
    assert(sha256(outside) === before, 'refused outside path changed the file');
    assert(!fs.existsSync(path.join(outsideDir, 'session.v4.jsonl.zstd.bak'))
      && !fs.existsSync(path.join(outsideDir, 'session.v4.jsonl.zstd.archive')),
      'refused outside path created side files');
    return 'containment refusal keeps a concrete code';
  });

  runCase('CLI5', 'CLI 无任何活体信号：正常截断（exit 0，ok true，字节改变）', () => {
    const { file } = writeFixture(base, 'guard-control');
    const memRoot = path.join(base, 'control-memory');
    fs.mkdirSync(memRoot, { recursive: true });

    const before = sha256(file);
    const result = cli(visibleArgs(file, memRoot), { DSH_SESSION_ID: undefined });
    assert(result.status === 0,
      `exit ${result.status} code=${result.json && result.json.code} stdout=${result.stdout.slice(0, 300)}`);
    assert(result.json && result.json.ok === true, 'control run did not report ok:true');
    assert(result.json.status === 'truncated', `control run status ${result.json && result.json.status}`);
    assert(sha256(file) !== before, 'control run did not change the session bytes');
    return `control cut ok (${result.json.bytes.before} -> ${result.json.bytes.after} bytes)`;
  });
}

export const CLI_GUARD_CASES = ['CLI1', 'CLI2', 'CLI3', 'CLI4', 'CLI5', 'CLI6'];
