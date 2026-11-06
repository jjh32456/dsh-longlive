// WP5 K10/K14 — owner CLI shares the proposal JSON/state machine with the
// tools, is the only P0 channel, and never re-implements WP4 transitions.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditKinds, makeService, readJson, tempRoot, writeMemory } from './helpers.mjs';

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const packageRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const cli = path.join(packageRoot, 'scripts', 'router-proposals.mjs');

function runCli(args) {
  const child = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
  const stdout = String(child.stdout ?? '').trim();
  const stderr = String(child.stderr ?? '').trim();
  let json = null;
  for (const text of [stdout, stderr]) {
    if (!text) continue;
    try { json = JSON.parse(text); break; } catch { /* try the other stream */ }
  }
  return { status: child.status, stdout, stderr, json };
}

function fixture(prefix) {
  const temp = tempRoot(prefix);
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  return { temp, memoryRoot, vaultDir, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

function proposalFiles(vaultDir) {
  const dir = path.join(vaultDir, 'proposals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'queue.json').sort();
}

test('CLI propose --priority P0 stamps the owner channel and shares the WP3 proposal JSON', () => {
  const env = fixture('wp5-cli-p0-');
  try {
    const result = runCli([
      'propose',
      '--memory-root', env.memoryRoot,
      '--vault-dir', env.vaultDir,
      '--op', 'journal.append',
      '--target', 'journal/2026-11.md',
      '--title', 'Owner P0 request',
      '--content', 'owner content body',
      '--priority', 'P0',
      '--priority-reason', 'owner asked for it',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.ticket, 1);
    assert.equal(result.json.ticketName, 'q-0001');

    const files = proposalFiles(env.vaultDir);
    assert.equal(files.length, 1);
    const proposal = readJson(path.join(env.vaultDir, 'proposals', files[0]));
    assert.equal(proposal.origin.kind, 'owner-cli');
    assert.equal(proposal.origin.sessionId, 'owner-cli');
    assert.equal(proposal.queue.priority, 'P0');
    assert.equal(proposal.queue.priorityBy, 'owner-cli');
    assert.equal(proposal.stateLog[0].by, 'owner:cli');
    assert.equal(proposal.status, 'pending');

    const queue = readJson(path.join(env.vaultDir, 'proposals', 'queue.json'));
    assert.equal(queue.entries.length, 1);
    assert.equal(queue.entries[0].ticket, 'q-0001');

    const kinds = auditKinds(path.join(env.vaultDir, 'audit.jsonl'));
    assert.ok(kinds.includes('proposal.create'));
    const wal = fs.readFileSync(path.join(env.vaultDir, 'proposals', 'wal.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(wal.some((entry) => entry.ev === 'queue.assign'));
  } finally {
    env.cleanup();
  }
});

test('CLI list/show/queue read the same JSON as the tools', () => {
  const env = fixture('wp5-cli-read-');
  try {
    const proposed = runCli([
      'propose', '--memory-root', env.memoryRoot, '--vault-dir', env.vaultDir,
      '--op', 'topic.append', '--target', 'topics/test.md', '--title', 'Read me',
      '--content', 'read body',
    ]);
    assert.equal(proposed.status, 0, proposed.stderr || proposed.stdout);

    const list = runCli(['list', '--vault-dir', env.vaultDir]);
    assert.equal(list.status, 0);
    assert.equal(list.json.mode, 'list');
    assert.equal(list.json.proposals.length, 1);
    assert.equal(list.json.proposals[0].ticket, 'q-0001');

    const queue = runCli(['queue', '--vault-dir', env.vaultDir]);
    assert.equal(queue.status, 0);
    assert.equal(queue.json.mode, 'queue');
    assert.equal(queue.json.depth, 1);

    const show = runCli(['show', '--vault-dir', env.vaultDir, '--id', proposed.json.id]);
    assert.equal(show.status, 0);
    assert.equal(show.json.mode, 'detail');
    assert.equal(show.json.proposal.id, proposed.json.id);
    assert.match(show.json.proposal.content, /read body/);
    assert.match(show.json.proposal.content, /BEGIN PROPOSAL|PROPOSAL/i);
  } finally {
    env.cleanup();
  }
});

test('K14: CLI transitions run the real WP4 state machine through lease/WAL', () => {
  const env = fixture('wp5-cli-seam-');
  try {
    const proposed = runCli([
      'propose', '--memory-root', env.memoryRoot, '--vault-dir', env.vaultDir,
      '--op', 'journal.append', '--target', 'journal/2026-11.md',
      '--title', 'Seam', '--content', 'seam body', '--priority', 'P2',
    ]);
    assert.equal(proposed.status, 0);
    const id = proposed.json.id;
    const proposalFile = path.join(env.vaultDir, 'proposals', `${id}.json`);
    const targetFile = path.join(env.memoryRoot, 'journal', '2026-11.md');

    const wrong = runCli(['approve', '--vault-dir', env.vaultDir, '--id', id, '--confirm', 'xxxxxx']);
    assert.equal(wrong.status, 1);
    assert.equal(wrong.json.code, 'E_CONFIRM_REQUIRED');
    assert.equal(readJson(proposalFile).status, 'pending');

    const approve = runCli(['approve', '--vault-dir', env.vaultDir, '--memory-root', env.memoryRoot, '--id', id, '--confirm', id.slice(-6)]);
    assert.equal(approve.status, 0, approve.stderr || approve.stdout);
    assert.equal(approve.json.state, 'approved');
    const approved = readJson(proposalFile);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.stateLog.at(-1).by, 'owner:cli');
    assert.equal(fs.existsSync(targetFile), false, 'approve must not write canonical memory');

    const apply = runCli(['apply', '--vault-dir', env.vaultDir, '--memory-root', env.memoryRoot, '--id', id, '--confirm', id.slice(-6)]);
    assert.equal(apply.status, 0, apply.stderr || apply.stdout);
    assert.equal(apply.json.state, 'done');
    const done = readJson(proposalFile);
    assert.equal(done.status, 'done');
    assert.match(fs.readFileSync(targetFile, 'utf8'), /seam body/);
    const appliedSha = done.result.afterSha;
    assert.equal(sha256Buffer(fs.readFileSync(targetFile)), appliedSha);
    assert.ok(fs.existsSync(path.join(env.vaultDir, done.result.snapshot)), 'snapshot evidence exists');
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'locks', 'writer.lease.json')), false, 'lease released');

    const walFile = path.join(env.vaultDir, 'proposals', 'wal.jsonl');
    const kinds = fs.readFileSync(walFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line).ev);
    for (const ev of ['queue.assign', 'queue.approve', 'lease.acquire', 'apply.begin', 'apply.done']) {
      assert.ok(kinds.includes(ev), `WAL has ${ev}`);
    }

    const reject = runCli(['reject', '--vault-dir', env.vaultDir, '--id', id]);
    assert.equal(reject.status, 1);
    assert.equal(reject.json.code, 'E_BAD_STATE');

    const rollback = runCli(['rollback', '--vault-dir', env.vaultDir, '--memory-root', env.memoryRoot, '--id', id, '--confirm', id.slice(-6)]);
    assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
    assert.equal(rollback.json.state, 'rolled_back');
    assert.equal(rollback.json.removed, true, 'R-06: a new-file apply is undone by removing the target');
    assert.equal(rollback.json.restoredSha, null);
    const rolledBack = readJson(proposalFile);
    assert.equal(rolledBack.status, 'rolled_back');
    assert.equal(fs.existsSync(targetFile), false, 'R-06: rollback removes the file the apply created');
    assert.equal(rolledBack.result.removed, true);
    assert.equal(rolledBack.result.restoredSha, null);
    assert.ok(fs.existsSync(path.join(env.vaultDir, rolledBack.result.rollbackSnapshot)), 'rollback evidence kept');
    const walKinds = fs.readFileSync(walFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const doneWal = walKinds.filter((line) => line.ev === 'rollback.done').at(-1);
    assert.equal(doneWal.removed, true, 'WAL records removed:true');
    assert.equal(doneWal.restoredSha, null);
  } finally {
    env.cleanup();
  }
});

test('K10: tool P0 is denied without creating a proposal; the CLI P0 channel is isolated', async () => {
  const temp = tempRoot('wp5-k10-');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  writeMemory(memoryRoot);
  const vaultDir = path.join(temp, 'vault');
  const env = makeService({
    temp,
    memoryRoot,
    vaultDir,
    config: { proposalEnabled: true },
  });
  try {
    const started = await env.service.start();
    assert.equal(started.state, 'running');

    const toolResult = await env.service.proposeProposal({
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'tool wants P0',
      content: 'tool body',
      priority: 'P0',
    }, { caller: { kind: 'root', sessionId: 'root-session' } });

    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.code, 'E_PRIORITY_DENIED');
    assert.equal(proposalFiles(vaultDir).length, 0, 'tool P0 must not create a proposal');
    const kinds = auditKinds(path.join(vaultDir, 'audit.jsonl'));
    assert.ok(kinds.includes('priority.rejected'));

    const cliResult = runCli([
      'propose', '--memory-root', memoryRoot, '--vault-dir', vaultDir,
      '--op', 'journal.append', '--target', 'journal/2026-11.md',
      '--title', 'owner P0', '--content', 'owner body', '--priority', 'P0',
    ]);
    assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
    const files = proposalFiles(vaultDir);
    assert.equal(files.length, 1);
    const owner = readJson(path.join(vaultDir, 'proposals', files[0]));
    assert.equal(owner.origin.kind, 'owner-cli');
    assert.equal(owner.queue.priorityBy, 'owner-cli');
    assert.equal(owner.stateLog[0].by, 'owner:cli');
  } finally {
    await env.service.dispose();
    env.cleanup();
  }
});
