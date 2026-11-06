// test/cross-process.test.mjs — 真跨进程预算回归（红队 P0-2 / 验收项 75+75→75、60+60→60）
//
// 每个子进程有独立的 queue/audit，只共享 budget.ledger.jsonl —— 这是红队的实测形状。
// 另外用 SIGKILL 真杀一个在 reserve 之后挂起的子进程，验证重启不会把死预留算成 25。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Router } from '../../src/router/background/router.mjs';
import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { BudgetLedger } from '../../src/router/background/budget-ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'fixtures', 'cross-child.mjs');
const TMP = path.join(path.dirname(here), '.tmp-cross');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let caseNo = 0;
function makeDir(label) {
  const dir = path.join(TMP, `${label}-${process.pid}-${Date.now()}-${caseNo++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeQueue(dir, id) {
  fs.writeFileSync(path.join(dir, 'queue.jsonl'), `${JSON.stringify({ id, type: 'note', payload: { text: id } })}\n`);
}

function writeMemory(dir) {
  fs.writeFileSync(path.join(dir, 'memory.md'), '# 记忆\n## 卡片一\n- 事实 A\n');
}

function spawnChild(cfg) {
  const child = spawn(process.execPath, [CHILD, JSON.stringify(cfg)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const lines = [];
  const waiters = [];
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      lines.push(line);
      for (const waiter of [...waiters]) {
        // 子进程打的是 `tick <json>` / `event <json>`：必须允许前缀匹配，
        // 否则 waitFor('tick') 永远等不到（旧实现 3 条 cross-process 全红的原因之一）。
        if (waiter.want === line || line.startsWith(`${waiter.want} `)) {
          waiter.done = true;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    }
  });

  function waitFor(want, timeoutMs = 20000) {
    const existing = lines.find((line) => line === want || line.startsWith(`${want} `));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        want,
        done: false,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`timeout waiting for "${want}" from child; stderr=${stderr}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function waitExit(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      // timer 必须和 clearTimeout 处在同一个作用域；旧实现把它声明在 executor 内、
      // 在 .finally 里清，抛出 ReferenceError: timer is not defined。
      const timer = setTimeout(() => reject(new Error(`child exit timeout; stderr=${stderr}`)), timeoutMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  return { child, lines, waitFor, waitExit, stderr: () => stderr };
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function runRace({ maxTokens, perCall, expectedUsed }) {
  const root = makeDir('race');
  const ledgerPath = path.join(root, 'budget.ledger.jsonl');
  const children = [];
  for (const id of ['a', 'b']) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    writeQueue(dir, id);
    writeMemory(dir);
    children.push(spawnChild({
      mode: 'race',
      ledgerPath,
      auditPath: path.join(dir, 'audit.jsonl'),
      queuePath: path.join(dir, 'queue.jsonl'),
      memoryPath: path.join(dir, 'memory.md'),
      maxTokens,
      callMaxTokens: perCall,
      usage: perCall,
    }));
  }

  try {
    await Promise.all(children.map((child) => child.waitFor('ready')));
    for (const child of children) child.child.stdin.write('go\n');

    const tickLines = await Promise.all(children.map((child) => child.waitFor('tick')));
    const results = tickLines.map((line) => JSON.parse(line.slice('tick '.length)));

    await Promise.all(children.map((child) => child.waitExit()));

    const ledger = new BudgetLedger({ file: ledgerPath, runId: 'inspect', maxTokens });
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.used, expectedUsed, `账本 used 必须是 ${expectedUsed}`);
    assert.equal(snapshot.reserved, 0, '结束后不能残留预留');
    assert.equal(results.filter((res) => res.ok === true).length, 1, '只能有一个进程拿到预算');
    assert.equal(results.reduce((sum, res) => sum + (res.processed ?? 0), 0), 1, '任务总共只能被处理一次');
    return { results, snapshot };
  } finally {
    for (const child of children) {
      if (child.child.exitCode === null) child.child.kill('SIGKILL');
    }
  }
}

test('跨进程 75+75、预算 100 → 只能记 75（不是 150）', async () => {
  const { snapshot } = await runRace({ maxTokens: 100, perCall: 75, expectedUsed: 75 });
  assert.equal(snapshot.remaining, 25);
});

test('跨进程 60+60、预算 100 → 只能记 60（不是 120）', async () => {
  const { snapshot } = await runRace({ maxTokens: 100, perCall: 60, expectedUsed: 60 });
  assert.equal(snapshot.remaining, 40);
});

test('P0-2 跨进程：SIGKILL 在 reserve 之后，重启剩余仍是 100（不是 25）', async () => {
  const root = makeDir('crash');
  const ledgerPath = path.join(root, 'budget.ledger.jsonl');
  const auditPath = path.join(root, 'audit.jsonl');
  const queuePath = path.join(root, 'queue.jsonl');
  const memoryPath = path.join(root, 'memory.md');
  writeQueue(root, 't1');
  writeMemory(root);

  const child = spawnChild({
    mode: 'crash',
    ledgerPath,
    auditPath,
    queuePath,
    memoryPath,
    maxTokens: 100,
    callMaxTokens: 75,
  });

  let killed = false;
  try {
    await child.waitFor('in-call');
    child.child.kill('SIGKILL');
    killed = true;
    await child.waitExit();
    await sleep(100);
  } finally {
    if (!killed && child.child.exitCode === null) child.child.kill('SIGKILL');
  }

  // 被杀前确实写下了 active reserve 75。
  const probe = new BudgetLedger({ file: ledgerPath, runId: 'inspect', maxTokens: 100 });
  const before = probe.snapshot();
  assert.equal(before.reserved, 75, '子进程必须已经 reserve 75 才被 kill');
  assert.equal(before.used, 0);

  const router = new Router({
    queuePath,
    auditPath,
    memoryPath,
    ledgerPath,
    llm: new MockLlm({ usage: { inputTokens: 75, outputTokens: 0 } }),
    maxTokens: 100,
    callMaxTokens: 75,
    maxTasksPerTick: 1,
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2 },
  });

  const started = router.start();
  assert.equal(started.ok, true, `重启必须成功：${JSON.stringify(started)}`);
  assert.equal(started.reclaimed.released, 1, '死进程的预留必须被回收');
  assert.equal(started.tokensUsed, 0, '死预留不能算成已花');
  assert.equal(router.budget.remaining, 100, '重启后剩余必须是 100，不是 25');

  const tick = await router.tick();
  assert.equal(tick.ok, true);
  assert.equal(tick.processed, 1, '回收后必须还能跑任务');
  assert.equal(router.tokensUsed, 75);
  assert.equal(router.budget.remaining, 25);
  await router.stop('done');
});
