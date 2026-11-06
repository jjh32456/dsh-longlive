// R-02 regression: updateProposalStrict must be a cross-process CAS.
//
// Eight REAL child processes (`process.execPath` + test/fixtures/proposal-cas-child.mjs)
// call updateProposalStrict(dir, id, expectedRev=2) at the same instant. The
// inter-process `<id>.lock` must let exactly one of them write rev=3; the other
// seven must fail with E_STATE_RACE (never a silent lost update, never E_STORAGE
// from a 2 s contention timeout).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  proposalLockPath,
  readProposal,
  scanProposalDir,
  updateProposalStrict,
  writeProposalFile,
} from '../../src/router/service/store.mjs';
import { tempRoot } from './helpers.mjs';

const CHILD = path.resolve('test/fixtures/proposal-cas-child.mjs');
const CHILD_TIMEOUT_MS = 15_000;
const PROPOSAL_ID = 'p-20261105T000000-abc123';

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
      finish({ timedOut: true, code: null, stderr });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ error: String(error?.message ?? error), code: null, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stderr });
    });
  });
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function setupProposal() {
  const temp = tempRoot('proposal-cas-');
  const dir = path.join(temp, 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeProposalFile(path.join(dir, `${PROPOSAL_ID}.json`), {
    v: 1,
    id: PROPOSAL_ID,
    rev: 2,
    status: 'queued',
    title: 'base',
    createdAt: now,
    updatedAt: now,
    queue: { ticket: 'S-000001' },
  });
  return { temp, dir, file: path.join(dir, `${PROPOSAL_ID}.json`) };
}

test('R-02: eight real processes CAS rev=2 — exactly one writes rev=3, seven E_STATE_RACE', async () => {
  const env = setupProposal();
  try {
    const startAt = Date.now() + 900;
    const outs = [];
    const jobs = [];
    for (let i = 0; i < 8; i += 1) {
      const out = path.join(env.temp, `cas-${i}.json`);
      outs.push(out);
      jobs.push(runChild([
        '--dir', env.dir,
        '--id', PROPOSAL_ID,
        '--rev', '2',
        '--out', out,
        '--startAt', String(startAt),
        '--attempts', '6',
        '--writer', `writer-${i}`,
      ]));
    }
    const runs = await Promise.all(jobs);
    for (const run of runs) {
      assert.equal(run.timedOut, undefined, `child timed out: ${JSON.stringify(run)}`);
      assert.equal(run.error, undefined, `child spawn error: ${JSON.stringify(run)}`);
      assert.equal(run.code, 0, `child exit ${run.code}: ${run.stderr}`);
    }

    const results = outs.map((out) => readJsonFile(out));
    const winners = results.filter((row) => row.ok === true);
    const losers = results.filter((row) => row.ok !== true);
    assert.equal(winners.length, 1, `expected exactly one winner: ${JSON.stringify(results)}`);
    assert.equal(winners[0].rev, 3);
    assert.equal(losers.length, 7, JSON.stringify(results));
    for (const row of losers) {
      assert.equal(row.code, 'E_STATE_RACE', `loser must lose on rev, not storage: ${JSON.stringify(row)}`);
      assert.equal(row.retryable, false);
    }
    assert.equal(new Set(results.map((row) => row.pid)).size, 8, 'all eight results come from distinct pids');

    const finalProposal = readJsonFile(env.file);
    assert.equal(finalProposal.rev, 3, 'exactly one revision was written');
    assert.equal(finalProposal.title, winners[0].writer, 'the winner bytes are on disk');
    assert.equal(fs.existsSync(proposalLockPath(env.dir, PROPOSAL_ID)), false, 'no lock left behind');
    assert.equal(scanProposalDir(env.dir).proposals.length, 1, 'lock/evidence files are not proposals');
    assert.equal(scanProposalDir(env.dir).invalid.length, 0);
  } finally {
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('R-02: an aged dead-pid proposal lock is reclaimed with evidence before the CAS', () => {
  const env = setupProposal();
  try {
    const lockFile = proposalLockPath(env.dir, PROPOSAL_ID);
    const old = new Date(Date.now() - 60_000);
    fs.writeFileSync(lockFile, `${JSON.stringify({
      pid: 999999,
      host: os.hostname(),
      nonce: 'dead-nonce',
      startedAt: old.toISOString(),
    })}\n`, 'utf8');
    fs.utimesSync(lockFile, old, old);

    const next = updateProposalStrict(env.dir, PROPOSAL_ID, 2, (current) => ({ title: `after-stale-${current.rev}` }));
    assert.equal(next.rev, 3);
    assert.equal(next.title, 'after-stale-2');
    assert.equal(readJsonFile(env.file).rev, 3);
    assert.equal(fs.existsSync(lockFile), false);
    const evidence = fs.readdirSync(env.dir).filter((name) => name.startsWith(`${PROPOSAL_ID}.lock.reclaimed-`));
    assert.equal(evidence.length, 1, `expected one evidence file: ${JSON.stringify(fs.readdirSync(env.dir))}`);
  } finally {
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});

test('R-02: a fresh lock held by a live pid yields retryable E_STORAGE and changes nothing', () => {
  const env = setupProposal();
  try {
    const lockFile = proposalLockPath(env.dir, PROPOSAL_ID);
    const payload = {
      pid: process.pid,
      host: os.hostname(),
      nonce: 'live-nonce',
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockFile, `${JSON.stringify(payload)}\n`, 'utf8');
    const before = readJsonFile(env.file);

    assert.throws(
      () => updateProposalStrict(env.dir, PROPOSAL_ID, 2, { title: 'must-not-write' }, {
        lockWaitMs: 150,
        lockBackoffMs: 10,
      }),
      (error) => error?.code === 'E_STORAGE' && error.retryable === true,
    );
    assert.deepEqual(readJsonFile(env.file), before, 'proposal untouched while the lock is foreign');
    assert.deepEqual(readJsonFile(lockFile), payload, 'foreign lock untouched');
    const scanned = scanProposalDir(env.dir);
    assert.equal(scanned.proposals.length, 1);
    assert.equal(scanned.invalid.length, 0);
  } finally {
    fs.rmSync(env.temp, { recursive: true, force: true });
  }
});
