// R-01 regression: InstanceLock must be an atomic cross-process mutex.
//
// These are REAL child processes (`process.execPath` + test/fixtures/lock-child.mjs),
// never in-process mocks: six siblings race open(wx) on the same lock file and
// only one may report state:'acquired'; the other five must see 'standby' with a
// live holder, and no child may crash with an uncaught fs error.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InstanceLock } from '../../src/router/service/lock.mjs';
import { tempRoot } from './helpers.mjs';

const CHILD = path.resolve('test/fixtures/lock-child.mjs');
const CHILD_TIMEOUT_MS = 15_000;

function runChild(args, timeoutMs = CHILD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ timedOut: true, code: null, signal: null, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ error: String(error?.message ?? error), code: null, signal: null, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal, stdout, stderr });
    });
  });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

test('R-01: six real processes race one lock — exactly one acquires, five standby', async () => {
  const temp = tempRoot('lock-crossproc-');
  try {
    const file = path.join(temp, 'router.lock');
    const startAt = Date.now() + 900;
    const outs = [];
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      const out = path.join(temp, `child-${i}.json`);
      outs.push(out);
      jobs.push(runChild([
        '--file', file,
        '--out', out,
        '--runId', `run-${i}`,
        '--startAt', String(startAt),
        '--holdMs', '1500',
      ]));
    }
    const runs = await Promise.all(jobs);
    for (const run of runs) {
      assert.equal(run.timedOut, undefined, `child timed out: ${JSON.stringify(run)}`);
      assert.equal(run.error, undefined, `child spawn error: ${JSON.stringify(run)}`);
      assert.equal(run.code, 0, `child exit ${run.code}: ${run.stderr}`);
      assert.equal(run.stderr.includes('EPERM'), false, `uncaught EPERM surfaced: ${run.stderr}`);
    }

    const results = outs.map((out) => JSON.parse(fs.readFileSync(out, 'utf8')));
    assert.equal(results.some((row) => row.crash), false, JSON.stringify(results.filter((row) => row.crash)));
    const acquired = results.filter((row) => row.state === 'acquired');
    const standby = results.filter((row) => row.state === 'standby');
    assert.equal(acquired.length, 1, `expected exactly one acquired: ${JSON.stringify(results)}`);
    assert.equal(standby.length, 5, `expected five standby: ${JSON.stringify(results)}`);
    assert.equal(new Set(results.map((row) => row.pid)).size, 6, 'all six results come from distinct pids');

    const winner = acquired[0];
    assert.equal(typeof winner.runId, 'string');
    for (const row of standby) {
      assert.equal(row.ok, false);
      if (row.holderRunId !== null) assert.equal(row.holderRunId, winner.runId, 'loser saw the winner as holder');
    }
    assert.ok(standby.some((row) => row.holderRunId === winner.runId), 'at least one loser read the live holder');

    // Every child (including the holder after its 1.5 s hold) has exited now.
    assert.equal(fs.existsSync(file), false, 'holder released its own lock');
    assert.equal(fs.readdirSync(temp).some((name) => name.includes('reclaimed')), false, 'no takeover was needed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('R-01: a second process gets standby while the holder lives, then acquires after release', async () => {
  const temp = tempRoot('lock-second-');
  try {
    const file = path.join(temp, 'router.lock');
    const out = path.join(temp, 'holder.json');
    const holderRun = runChild([
      '--file', file,
      '--out', out,
      '--runId', 'holder-run',
      '--startAt', '0',
      '--holdMs', '1500',
    ]);
    assert.equal(await waitFor(() => fs.existsSync(out)), true, 'holder never reported its acquire');
    const holder = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(holder.state, 'acquired');
    assert.equal(readLock(file)?.runId, 'holder-run');

    const second = new InstanceLock({ file, runId: 'second-run' });
    const standby = second.acquire();
    assert.equal(standby.ok, false);
    assert.equal(standby.state, 'standby');
    assert.equal(standby.holder?.runId, 'holder-run');

    const held = await holderRun;
    assert.equal(held.code, 0, held.stderr);
    assert.equal(fs.existsSync(file), false, 'holder released before exit');

    const acquired = second.acquire();
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    assert.equal(acquired.state, 'acquired');
    assert.equal(acquired.takeover, false, 'an empty path is not a takeover');
    assert.equal(second.release(), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('R-01: a dead-pid stale lock is taken over with a kept evidence file', () => {
  const temp = tempRoot('lock-stale-');
  try {
    const file = path.join(temp, 'router.lock');
    const old = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, `${JSON.stringify({
      v: 1,
      pid: 999999,
      host: os.hostname(),
      runId: 'dead-run',
      nonce: 'dead-nonce',
      startedAt: old,
      heartbeatAt: old,
    })}\n`, 'utf8');

    const lock = new InstanceLock({ file, runId: 'live-run' });
    const result = lock.acquire();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state, 'acquired');
    assert.equal(result.takeover, true);
    assert.equal(result.previous?.runId, 'dead-run');
    const evidence = path.join(temp, result.evidence);
    assert.equal(fs.existsSync(evidence), true, 'old lock kept as evidence');
    assert.equal(JSON.parse(fs.readFileSync(evidence, 'utf8')).runId, 'dead-run');
    assert.equal(readLock(file)?.runId, 'live-run', 'new lock is on the canonical path');
    assert.equal(lock.release(), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('R-01: release refuses a lock whose nonce is no longer ours', () => {
  const temp = tempRoot('lock-release-');
  try {
    const file = path.join(temp, 'router.lock');
    const lock = new InstanceLock({ file, runId: 'mine' });
    assert.equal(lock.acquire().ok, true);
    const foreign = {
      v: 1,
      pid: process.pid,
      host: os.hostname(),
      runId: 'other-run',
      nonce: 'other-nonce',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, `${JSON.stringify(foreign)}\n`, 'utf8');
    assert.equal(lock.release(), false);
    assert.deepEqual(readLock(file), foreign, 'not-ours file left untouched');
    fs.unlinkSync(file);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
