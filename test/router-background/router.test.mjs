// test/router.test.mjs — Router 后台面骨架的验收测试（mustFix 重写版）
//
// 运行（Node 24）：
//   node --test test/
//
// 覆盖：启动 / 幂等 / 预算硬上限与恢复 / 递归防护 / 崩溃隔离 / 审计格式 /
// busy 互斥 / 审计写失败 / stop 中止在飞 tick / stopFile / 队列去重 / timer 清理。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from '../../src/router/background/router.mjs';
import { MockLlm } from '../../src/router/background/mock-llm.mjs';
import { readAudit } from '../../src/router/background/audit.mjs';
import { BudgetLedger, readLedger } from '../../src/router/background/budget-ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(path.dirname(here), '.tmp');
let caseNo = 0;

function makeCase({ tasks = [], queueText = null, memory = null, llm = null, router = {} } = {}) {
  const dir = path.join(TMP, `case-${process.pid}-${caseNo++}`);
  fs.mkdirSync(dir, { recursive: true });
  const queuePath = path.join(dir, 'queue.jsonl');
  const auditPath = path.join(dir, 'audit.jsonl');
  const memoryPath = path.join(dir, 'memory.md');

  fs.writeFileSync(queuePath, queueText ?? (tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : '')));
  if (memory !== null) fs.writeFileSync(memoryPath, memory);

  return {
    dir, queuePath, auditPath, memoryPath,
    read: () => readAudit(auditPath).records,
    router: (overrides = {}) => new Router({
      queuePath,
      auditPath,
      memoryPath: memory !== null ? memoryPath : null,
      llm: llm ?? new MockLlm(),
      ...router,
      ...overrides,
    }),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const task = (id, type = 'note', extra = {}) => ({ id, type, payload: { text: id }, ...extra });

test('启动：start() 建状态、写 router.start、不预先处理任务', async () => {
  const c = makeCase({ tasks: [task('t1')], memory: '# 记忆\n## 卡片一\n- 事实 A\n' });
  const r = c.router();
  const started = r.start();

  assert.equal(started.ok, true);
  assert.equal(started.alreadyRunning, false);
  assert.equal(r.state, 'running');

  const recs = c.read();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'router.start');
  assert.equal(recs[0].seq, 1);
  assert.equal(recs[0].v, 1);
  assert.equal(recs[0].run_id, r.runId);
  await r.dispose();
});

test('幂等：重复 start() 不产生第二条 router.start，也不重置预算', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const r = c.router();

  assert.equal(r.start().alreadyRunning, false);
  const again = r.start();
  assert.equal(again.ok, true);
  assert.equal(again.alreadyRunning, true);

  const starts = c.read().filter((x) => x.kind === 'router.start');
  assert.equal(starts.length, 1);
  await r.dispose();
});

test('幂等：同一任务跨两次 tick 只处理一次', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const llm = new MockLlm();
  const r = c.router({ llm });
  r.start();

  const first = await r.tick();
  const second = await r.tick();

  assert.equal(first.processed, 1);
  assert.equal(second.processed, 0);
  assert.equal(llm.calls, 1);
  assert.equal(c.read().filter((x) => x.kind === 'action').length, 1);
  await r.dispose();
});

test('幂等：重启后从审计回放，不重复执行已处理任务', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2')] });
  const llm1 = new MockLlm();
  const r1 = c.router({ llm: llm1 });
  r1.start();
  await r1.tick();
  await r1.stop('test_done');

  const llm2 = new MockLlm();
  const r2 = c.router({ llm: llm2 });
  const started = r2.start();
  const res = await r2.tick();

  assert.equal(started.replayed, 2);
  assert.equal(res.processed, 0);
  assert.equal(llm2.calls, 0);
  await r2.dispose();
});

test('预算硬上限：预算 100、每次 75 时第二次调用在调度前被拒，总花费 75 不是 150', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2'), task('t3')] });
  const llm = new MockLlm({ usage: { inputTokens: 50, outputTokens: 25 } });
  const r = c.router({ llm, maxTokens: 100, callMaxTokens: 75, retry: { maxAttempts: 1 } });
  r.start();

  const res = await r.tick();
  assert.equal(res.processed, 1);
  assert.equal(res.stop, 'budget_exceeded');
  assert.equal(r.state, 'stopped');
  assert.equal(r.tokensUsed, 75);
  assert.equal(llm.calls, 1, '第二次调用必须在发出前被拒');

  const records = c.read();
  const reserves = records.filter((x) => x.kind === 'budget.reserve');
  assert.equal(reserves.length, 1);
  assert.equal(reserves[0].budgetReserved, 75);
  assert.ok(records.some((x) => x.kind === 'budget.exceeded'));
  assert.ok(records.some((x) => x.kind === 'router.stop' && x.reason === 'budget_exceeded'));

  const after1 = await r.tick();
  assert.equal(after1.ok, false);
  assert.equal(after1.code, 'E_NOT_RUNNING');
});

test('预算恢复：重启后 start() 从审计恢复已花 75，第二次 tick 不再调用模型', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2')] });
  const llm1 = new MockLlm({ usage: { inputTokens: 50, outputTokens: 25 } });
  const r1 = c.router({ llm: llm1, maxTokens: 100, callMaxTokens: 75, retry: { maxAttempts: 1 } });
  r1.start();
  const first = await r1.tick();
  assert.equal(first.processed, 1);
  assert.equal(r1.tokensUsed, 75);
  await r1.stop('done');

  const llm2 = new MockLlm({ usage: { inputTokens: 50, outputTokens: 25 } });
  const r2 = c.router({ llm: llm2, maxTokens: 100, callMaxTokens: 75, retry: { maxAttempts: 1 } });
  const started = r2.start();
  assert.equal(started.resumedTokens, 75);
  assert.equal(r2.tokensUsed, 75);

  const res = await r2.tick();
  assert.equal(res.stop, 'budget_exceeded');
  assert.equal(llm2.calls, 0);
  assert.equal(r2.tokensUsed, 75);
  await r2.dispose();
});

test('P0-1 预算超支：provider 返回 150 > 预留 100 → 只记 100、拒 50，E_BUDGET_OVERSHOOT 并停', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2')] });
  const llm = new MockLlm({ usage: { inputTokens: 120, outputTokens: 30 } });
  const r = c.router({ llm, maxTokens: 100, callMaxTokens: 100, retry: { maxAttempts: 1 } });
  r.start();
  const res = await r.tick();

  assert.equal(res.stop, 'budget_overshoot');
  assert.equal(res.code, 'E_BUDGET_OVERSHOOT');
  assert.equal(r.tokensUsed, 100, '硬上限是 100，不能记 150');
  assert.equal(r.lastError?.code, 'E_BUDGET_OVERSHOOT');
  assert.equal(llm.calls, 1, '超支后不得继续调用');

  const records = c.read();
  assert.ok(records.some((x) => x.kind === 'budget.overshoot'));
  assert.ok(records.some((x) => x.kind === 'router.stop' && x.reason === 'budget_overshoot'));
  const settleRec = records.find((x) => x.kind === 'budget.settle');
  assert.equal(settleRec.actual_tokens, 100, '只记上限内的部分');
  assert.equal(settleRec.requested_tokens, 150);
  assert.equal(settleRec.rejected_tokens, 50);
  await r.dispose();
});

test('重试预算：60+60 预留 150、预算 200 → 两次 attempt 全额入账 120（不再 clamp 到 75）', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const sixty = { inputTokens: 40, outputTokens: 20 };
  const llm = new MockLlm({
    usage: sixty,
    failOn: new Map([['t1', { code: 'SERVER', times: 1, usage: sixty }]]),
  });
  const r = c.router({
    llm,
    maxTokens: 200,
    callMaxTokens: 75,
    retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
  });
  r.start();
  const res = await r.tick();

  assert.equal(llm.calls, 2, '必须真的发生两次 attempt');
  assert.equal(res.stop, false, '120 <= 150 预留，不应触发 overshoot');
  assert.equal(r.tokensUsed, 120, '60+60 必须全额入账，旧实现只记 75');
  assert.equal(r.ledger.snapshot().used, 120);

  const reserveRec = c.read().find((x) => x.kind === 'budget.reserve');
  assert.equal(reserveRec.budgetReserved, 150, '预留必须覆盖 maxAttempts × callMaxTokens');
  const settleRec = c.read().find((x) => x.kind === 'budget.settle');
  assert.equal(settleRec.actual_tokens, 120);
  assert.equal(settleRec.requested_tokens, 120);
  assert.equal(settleRec.rejected_tokens, 0);
  await r.dispose();
});

test('递归防护：origin=router / depth>0 的任务不进入模型调用', async () => {
  const c = makeCase({
    tasks: [task('r1', 'note', { origin: 'router' }), task('r2', 'note', { depth: 1 })],
  });
  const llm = new MockLlm();
  const r = c.router({ llm });
  r.start();
  const res = await r.tick();

  assert.equal(res.processed, 0);
  assert.equal(res.denied, 2);
  assert.equal(llm.calls, 0);
  const denied = c.read().filter((x) => x.kind === 'task.denied');
  assert.equal(denied.length, 2);
  assert.ok(denied.every((x) => x.reason === 'recursion'));
  await r.dispose();
});

test('递归防护：模型产出派生动作（spawn_router）被拒绝', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const llm = new MockLlm({ actionFor: () => ({ type: 'spawn_router' }) });
  const r = c.router({ llm });
  r.start();
  const res = await r.tick();

  assert.equal(res.processed, 0);
  assert.equal(res.denied, 1);
  const rec = c.read().find((x) => x.kind === 'action.denied');
  assert.equal(rec.reason, 'recursion');
  assert.equal(r.state, 'running');
  await r.dispose();
});

test('崩溃隔离：单任务抛错被捕获，同 tick 其它任务照常完成', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2')] });
  const llm = new MockLlm({ failOn: new Map([['t1', 'crash']]) });
  const r = c.router({ llm });
  r.start();

  const res = await r.tick(); // 不 reject
  assert.equal(res.ok, true);
  assert.equal(res.processed, 1);
  assert.equal(res.errors, 1);
  assert.equal(r.state, 'running');

  const kinds = c.read().map((x) => x.kind);
  assert.ok(kinds.includes('task.error'));
  assert.ok(kinds.includes('action'));
  assert.ok(c.read().some((x) => x.kind === 'task.error' && x.code === 'MOCK_CRASH'));
  await r.dispose();
});

test('熔断：连续错误达到阈值后停止', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2'), task('t3')] });
  const llm = new MockLlm({
    failOn: new Map([['t1', 'crash'], ['t2', 'crash'], ['t3', 'crash']]),
  });
  const r = c.router({ llm, maxConsecutiveErrors: 2 });
  r.start();

  const res = await r.tick();
  assert.equal(res.errors, 2);
  assert.equal(r.state, 'stopped');
  assert.equal(r.stopReason, 'error_streak');
  assert.equal(llm.calls, 2);
});

test('busy flag：并发 tick 只跑一个，另一个立即返回 E_BUSY', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const llm = new MockLlm({ delayMs: 80 });
  const r = c.router({ llm });
  r.start();

  const first = r.tick();
  await sleep(10);
  const second = await r.tick();
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_BUSY');

  const res = await first;
  assert.equal(res.processed, 1);
  assert.equal(llm.calls, 1);
  await r.dispose();
});

test('审计写失败：audit.close() 后 tick 不 reject、转 stopped 并记录', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const r = c.router();
  r.start();
  r.audit.close();

  let res;
  try {
    res = await r.tick();
  } catch (error) {
    assert.fail(`tick must not reject after audit close: ${error.message}`);
  }
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_AUDIT_WRITE');
  assert.equal(r.state, 'stopped');
  assert.equal(r.stopReason, 'audit_failed');
});

test('stop 先 abort：在飞 tick 被中止，stop 之后不再有新 tick', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const llm = new MockLlm({ delayMs: 300 });
  const r = c.router({ llm });
  r.start();

  const inflight = r.tick();
  await sleep(20);
  const stopped = await r.stop('manual');
  assert.equal(stopped.alreadyStopped, false);
  const res = await inflight;

  assert.equal(r.state, 'stopped');
  assert.equal(res.stop, 'aborted');
  assert.equal(llm.calls, 1);

  const after = await r.tick();
  assert.equal(after.code, 'E_NOT_RUNNING');
});

test('stop 幂等 + stopFile：第二次 stop 不重复写 router.stop；stopFile 触发停止', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const stopFile = path.join(c.dir, 'STOP');
  const r = c.router({ stopFile });
  r.start();

  const first = await r.stop('manual');
  const second = await r.stop('manual');
  assert.equal(first.alreadyStopped, false);
  assert.equal(second.alreadyStopped, true);
  assert.equal(c.read().filter((x) => x.kind === 'router.stop').length, 1);

  const other = c.router({ stopFile });
  fs.writeFileSync(stopFile, '');
  other.start();
  const res = await other.tick();
  assert.equal(res.stop, 'stop_file');
  assert.equal(other.state, 'stopped');
  assert.equal(c.read().filter((x) => x.kind === 'router.stop').length, 2);
});

test('未启动调用：tick() 返回 E_NOT_RUNNING 而不是抛错', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const r = c.router();
  const res = await r.tick();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_NOT_RUNNING');
});

test('审计行格式：每行可解析、信封字段齐全、seq 连续、ts 为 ISO', async () => {
  const c = makeCase({
    tasks: [task('t1'), task('t2', 'report'), task('r1', 'note', { depth: 1 })],
    memory: '# 记忆\n## 卡片一\n- 事实 A\n',
  });
  const r = c.router({ llm: new MockLlm() });
  r.start();
  await r.tick();
  await r.tick();
  await r.stop('done');

  const { records, badLines } = readAudit(c.auditPath);
  assert.equal(badLines, 0);
  assert.ok(records.length >= 8);

  records.forEach((rec, i) => {
    assert.equal(rec.v, 1);
    assert.equal(rec.seq, i + 1, 'seq 必须从 1 开始连续');
    assert.equal(typeof rec.kind, 'string');
    assert.ok(rec.kind.length > 0);
    assert.equal(typeof rec.run_id, 'string');
    assert.equal(new Date(rec.ts).toISOString(), rec.ts, 'ts 必须是 ISO 时间');
  });

  const kinds = new Set(records.map((x) => x.kind));
  for (const expected of ['router.start', 'memory.read', 'action', 'task.denied', 'router.stop']) {
    assert.ok(kinds.has(expected), `缺少审计类型 ${expected}`);
  }
  const memRec = records.find((x) => x.kind === 'memory.read');
  assert.equal(memRec.facts, 2);
});

test('队列去重：重复 id 只跑一次，裸 append 被拒绝，writer 重复 append 返回 E_DUPLICATE', async () => {
  const line = JSON.stringify(task('t1'));
  const c = makeCase({ queueText: `${line}\n${line}\n` });
  const llm = new MockLlm();
  const r = c.router({ llm });
  r.start();

  const read = r.queue.read();
  assert.equal(read.tasks.length, 1);
  assert.equal(read.duplicates.length, 1);

  const res = await r.tick();
  assert.equal(res.processed, 1);
  assert.equal(llm.calls, 1);

  const dup = r.queue.writer.append(task('t1'));
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'E_DUPLICATE');
  assert.throws(() => r.queue.append(task('t2')), /trusted producer/);
  await r.dispose();
});

test('timer 清理：ctx.effect 注册的 heartbeat 在 dispose 时被取消', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  let installed = 0;
  let disposed = 0;
  const ctx = {
    effect(fn) {
      installed += 1;
      const dispose = fn();
      return () => {
        disposed += 1;
        dispose();
      };
    },
  };
  const r = c.router({ ctx, heartbeatMs: 20 });
  r.start();
  assert.equal(installed, 1);
  await r.dispose();
  assert.equal(disposed, 1);
});

// ---------------------------------------------------------------------------
// 第二轮红队 P0/P1 回归：跨实例预算、重启恢复、usage 记账、审计完整性、
// 迭代器兜底、stop 降级、队列容量、heartbeat 停止。
// ---------------------------------------------------------------------------

function usageChunks(tokens, text = 'ok') {
  const inputTokens = Math.floor(tokens * 2 / 3);
  return [
    { type: 'block-start', index: 0, block: { type: 'text' } },
    { type: 'text-delta', index: 0, text },
    { type: 'usage', usage: { inputTokens, outputTokens: tokens - inputTokens, totalTokens: tokens } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

function failedChunks(tokens, code = 'SERVER') {
  return [
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'usage', usage: { totalTokens: tokens } },
    { type: 'finish', reason: { kind: 'error', failure: { code, message: 'upstream failed' } } },
  ];
}

function scriptedLlm(scripts) {
  const llm = {
    provider: 'fixture',
    model: 'fixture-1',
    calls: 0,
    requests: [],
    async *stream(request) {
      llm.calls += 1;
      llm.requests.push(request);
      const index = Math.min(llm.calls - 1, scripts.length - 1);
      for (const chunk of scripts[index]) yield chunk;
    },
  };
  return llm;
}

test('P0-3：llm.stream 请求必须带 provider/model（真宿主 NO_ADAPTER 回归）', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const llm = scriptedLlm([usageChunks(30)]);
  const r = c.router({ llm, maxTokens: 100, callMaxTokens: 50, retry: { maxAttempts: 1 } });
  r.start();
  await r.tick();

  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0].provider, 'fixture');
  assert.equal(llm.requests[0].model, 'fixture-1');
  assert.ok(Array.isArray(llm.requests[0].messages));
  assert.equal(typeof llm.requests[0].maxTokens, 'number');
  await r.dispose();

  // 显式配置优先于 llm 实例上的默认值。
  const c2 = makeCase({ tasks: [task('t2')] });
  const llm2 = scriptedLlm([usageChunks(30)]);
  const r2 = c2.router({
    llm: llm2,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxTokens: 100,
    callMaxTokens: 50,
    retry: { maxAttempts: 1 },
  });
  r2.start();
  await r2.tick();
  assert.equal(llm2.requests[0].provider, 'deepseek-official');
  assert.equal(llm2.requests[0].model, 'deepseek-v4-flash');
  await r2.dispose();
});

test('P0-3：NO_ADAPTER 写 llm.diagnostic 并停为 llm_fatal（不是静默重试）', async () => {
  const c = makeCase({ tasks: [task('noadapter')] });
  const llm = scriptedLlm([
    [
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter for provider' } } },
    ],
  ]);
  const r = c.router({ llm, maxTokens: 200, callMaxTokens: 50, retry: { maxAttempts: 3, initialDelayMs: 1 } });
  r.start();
  await r.tick();

  assert.equal(llm.calls, 1, 'FATAL 码不能重试');
  assert.equal(r.stopReason, 'llm_fatal');
  const diagnostic = c.read().find((rec) => rec.kind === 'llm.diagnostic');
  assert.ok(diagnostic, '必须把适配器缺失写进审计');
  assert.equal(diagnostic.code, 'NO_ADAPTER');
  await r.dispose();
});

test('P02：两个 Router 实例共享 run 目录，预算 100 时只能有一个预留 75（不得 150）', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const llm1 = scriptedLlm([usageChunks(75)]);
  const llm2 = scriptedLlm([usageChunks(75)]);
  const opts = { maxTokens: 100, callMaxTokens: 75, maxTicks: 5, retry: { maxAttempts: 1 } };

  // 两个进程各自写自己的审计（同一文件并发写会互相打断 hash 链），
  // 但共享同一本预算账本——这才是跨进程要验的东西。
  const r1 = c.router({ llm: llm1, ...opts, auditPath: path.join(c.dir, 'audit-1.jsonl') });
  const r2 = c.router({ llm: llm2, ...opts, auditPath: path.join(c.dir, 'audit-2.jsonl') });
  assert.equal(r1.start().ok, true);
  assert.equal(r2.start().ok, true);

  await Promise.all([r1.tick(), r2.tick()]);

  assert.equal(llm1.calls + llm2.calls, 1, '预算 100 只允许一次 75 的调用');
  assert.equal(r1.ledger.snapshot().used, 75);
  assert.equal(r1.ledger.snapshot().reserved, 0);
  const stopReasons = [r1.stopReason, r2.stopReason].filter(Boolean);
  assert.deepEqual(stopReasons, ['budget_exceeded']);
  await r1.dispose();
  await r2.dispose();
});

test('P03：重启从账本恢复全部已用（150），不是 max(75)', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2')] });
  const llm = scriptedLlm([usageChunks(75), usageChunks(75)]);
  const r1 = c.router({
    llm,
    maxTokens: 200,
    callMaxTokens: 75,
    maxTasksPerTick: 2,
    retry: { maxAttempts: 1 },
  });
  r1.start();
  await r1.tick();
  assert.equal(r1.tokensUsed, 150);
  await r1.dispose();

  const r2 = c.router({ llm: scriptedLlm([usageChunks(75)]), maxTokens: 200, callMaxTokens: 75 });
  const resumed = r2.start();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumedTokens, 150, '两笔 75 必须相加恢复');
  assert.equal(resumed.tokensUsed, 150);

  // 剩余 50 连一次 75 都预留不出来 → 明确停因，不静默超支。
  assert.equal(r2.queue.writer.append(task('t3')).ok, true);
  await r2.tick();
  assert.equal(r2.stopReason, 'budget_exceeded');
  assert.equal(r2.ledger.snapshot().used, 150);
  await r2.dispose();
});

test('P06：负 usage 不得退款——拒绝记账并停机（tokensUsed 0，剩余仍是 2000）', async () => {
  const c = makeCase({ tasks: [task('neg')] });
  const llm = scriptedLlm([[
    { type: 'text-delta', index: 0, text: 'bad' },
    { type: 'usage', usage: { inputTokens: -1000, outputTokens: -1000, totalTokens: -2000 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]]);
  const r = c.router({ llm, maxTokens: 2000, callMaxTokens: 100, retry: { maxAttempts: 1 } });
  r.start();
  await r.tick();

  assert.equal(r.tokensUsed, 0, '负 usage 不能把已用降到 0 以下');
  assert.equal(r.ledger.snapshot().used, 0);
  assert.equal(r.stopReason, 'usage_invalid');
  assert.equal(r.state, 'stopped');
  assert.equal(r.lastError.code, 'E_USAGE_INVALID');
  const settle = c.read().find((rec) => rec.kind === 'budget.settle');
  assert.equal(settle.usage_valid, false);
  assert.equal(settle.actual_tokens, 0);
  await r.dispose();
});

test('P26：失败 attempt 的 usage 也计入——60+30 必须记 90', async () => {
  const c = makeCase({ tasks: [task('retry')] });
  const llm = scriptedLlm([
    failedChunks(60, 'SERVER'),
    usageChunks(30),
  ]);
  const r = c.router({
    llm,
    maxTokens: 1000,
    callMaxTokens: 100,
    retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  });
  r.start();
  await r.tick();

  assert.equal(llm.calls, 2);
  assert.equal(r.tokensUsed, 90, '失败那次已经计费，不能只记最后一次的 30');
  assert.equal(r.ledger.snapshot().used, 90);
  const settle = c.read().filter((rec) => rec.kind === 'budget.settle').at(-1);
  assert.equal(settle.actual_tokens, 90);
  await r.dispose();
});

test('F5：重试链 30 后 -20 → 只记 30、停机 usage_invalid、绝不回冲到 10', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const llm = scriptedLlm([
    failedChunks(30, 'SERVER'),
    usageChunks(-20),
  ]);
  const r = c.router({
    llm,
    maxTokens: 100,
    callMaxTokens: 30,
    retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  });
  r.start();
  const res = await r.tick();

  assert.equal(llm.calls, 2);
  assert.equal(res.stop, 'usage_invalid');
  assert.equal(r.tokensUsed, 30, '第一次合法花费 30 必须入账，不能被 -20 回冲成 10');
  assert.equal(r.ledger.snapshot().used, 30);
  const settle = c.read().filter((rec) => rec.kind === 'budget.settle').at(-1);
  assert.equal(settle.actual_tokens, 30);
  await r.dispose();
});

test('B：单次 attempt usage 40 > callMaxTokens 30（总额仍 ≤ 预留 90）→ 记 actual 40 并 fail 任务', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const llm = new MockLlm({ usage: { inputTokens: 40, outputTokens: 0 } });
  const r = c.router({
    llm,
    maxTokens: 200,
    callMaxTokens: 30,
    retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
  });
  r.start();
  const res = await r.tick();

  assert.equal(res.stop, 'usage_overflow', '单次超 callMaxTokens 必须 fail，不能靠总额没超预留混过去');
  assert.equal(r.tokensUsed, 40, '按 actual 记账');
  assert.equal(r.ledger.snapshot().used, 40);
  const dead = c.read().filter((rec) => rec.kind === 'task.error' && rec.dead_letter === true);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].reason, 'attempt_usage_overflow');
  await r.dispose();
});

test('P04a：没有账本且审计有坏行 → start fail-closed（E_AUDIT_CORRUPT）', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const r1 = c.router({ retry: { maxAttempts: 1 } });
  r1.start();
  await r1.tick();
  await r1.dispose();

  fs.rmSync(path.join(c.dir, 'budget.ledger.jsonl'), { force: true });
  fs.appendFileSync(c.auditPath, '{"v":1,"seq":999,"kind":"torn');

  const r2 = c.router({});
  const res = r2.start();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_AUDIT_CORRUPT');
  assert.ok(res.badLines >= 1);
  assert.equal(r2.state, 'stopped');
  assert.equal(r2.stopReason, 'audit_corrupt');
  await r2.dispose();
});

test('P04b：审计截断但账本完整 → 从账本恢复 150，并上报 badLines', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2')] });
  const llm = scriptedLlm([usageChunks(75), usageChunks(75)]);
  const r1 = c.router({
    llm,
    maxTokens: 200,
    callMaxTokens: 75,
    maxTasksPerTick: 2,
    retry: { maxAttempts: 1 },
  });
  r1.start();
  await r1.tick();
  assert.equal(r1.tokensUsed, 150);
  await r1.dispose();

  // 尾部追加半行：旧实现会静默忽略，重新 start 只剩审计里能读出的 75。
  fs.appendFileSync(c.auditPath, '{"v":1,"seq":999,"kind":"torn');

  const r2 = c.router({ llm: scriptedLlm([usageChunks(75)]), maxTokens: 200, callMaxTokens: 75 });
  const res = r2.start();
  assert.equal(res.ok, true);
  assert.equal(res.resumedTokens, 150, '账本才是预算的真相来源');
  assert.ok(res.badLines >= 1, 'start() 必须把审计坏行数报出来');
  assert.equal(r2.tokensUsed, 150);
  const kinds = c.read().map((rec) => rec.kind);
  assert.ok(kinds.includes('audit.corrupt'));
  await r2.dispose();
});

test('P0-3：账本半行尾 → start() 先修尾再启动，不返回 E_BUDGET_CORRUPT', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const r1 = c.router({
    llm: scriptedLlm([usageChunks(75)]),
    maxTokens: 200,
    callMaxTokens: 75,
    retry: { maxAttempts: 1 },
  });
  r1.start();
  await r1.tick();
  assert.equal(r1.tokensUsed, 75);
  await r1.dispose();

  // 模拟崩溃：预留/结算都落盘了，最后一条只写了一半。
  fs.appendFileSync(path.join(c.dir, 'budget.ledger.jsonl'), '{"v":1,"seq":99,"op":"res');

  const r2 = c.router({
    llm: scriptedLlm([usageChunks(75)]),
    maxTokens: 200,
    callMaxTokens: 75,
    retry: { maxAttempts: 1 },
  });
  const res = r2.start();
  assert.equal(res.ok, true);
  assert.equal(res.tokensUsed, 75, '完好的 75 必须保留');
  assert.equal(res.reclaimed.released, 0);
  assert.equal(readLedger(path.join(c.dir, 'budget.ledger.jsonl')).badLines, 0, '半行必须被截掉');
  await r2.dispose();
});

test('P0-2：start() 回收死进程遗留的预留（不等到 tick）', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const ghost = new BudgetLedger({
    file: path.join(c.dir, 'budget.ledger.jsonl'),
    runId: 'run-ghost',
    maxTokens: 200,
    pid: 999999,
  });
  assert.equal(ghost.reserve({ tokens: 75, owner: 'run-ghost', leaseMs: 60000 }).ok, true);

  const r = c.router({
    llm: scriptedLlm([usageChunks(75)]),
    maxTokens: 200,
    callMaxTokens: 75,
    retry: { maxAttempts: 1 },
  });
  const res = r.start();
  assert.equal(res.ok, true);
  assert.equal(res.reclaimed.released, 1);
  assert.equal(res.tokensUsed, 0, '死预留不算花掉');
  assert.equal(res.resumedTokens, 0);
  assert.ok(res.reclaimed.freedTokens >= 75);

  const reclaimRec = c.read().find((rec) => rec.kind === 'budget.reclaim');
  assert.ok(reclaimRec, '回收动作必须进审计');
  assert.equal(reclaimRec.reason, 'startup');

  await r.tick();
  assert.equal(r.tokensUsed, 75);
  await r.stop('done');
});

test('P0-4：审计删掉中间整行 → start() 拒绝启动（E_LEDGER_TAMPERED）', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2')] });
  const r1 = c.router({
    llm: scriptedLlm([usageChunks(75), usageChunks(75)]),
    maxTokens: 200,
    callMaxTokens: 75,
    maxTasksPerTick: 2,
    retry: { maxAttempts: 1 },
  });
  r1.start();
  await r1.tick();
  await r1.dispose();

  const lines = fs.readFileSync(c.auditPath, 'utf8').trimEnd().split('\n');
  assert.ok(lines.length >= 5);
  lines.splice(Math.floor(lines.length / 2), 1);
  fs.writeFileSync(c.auditPath, `${lines.join('\n')}\n`);

  const r2 = c.router({});
  const res = r2.start();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_LEDGER_TAMPERED');
  assert.ok(res.chainBreaks > 0, '删中间整行必须暴露 hash 链断裂 / seq 跳号');
  assert.equal(r2.state, 'stopped');
  assert.equal(r2.stopReason, 'ledger_tampered');
  await r2.dispose();
});

test('P0-4：账本删掉中间整行 → start() 拒绝启动（E_LEDGER_TAMPERED）', async () => {
  const c = makeCase({ tasks: [task('t1'), task('t2')] });
  const r1 = c.router({
    llm: scriptedLlm([usageChunks(75), usageChunks(75)]),
    maxTokens: 200,
    callMaxTokens: 75,
    maxTasksPerTick: 2,
    retry: { maxAttempts: 1 },
  });
  r1.start();
  await r1.tick();
  await r1.dispose();

  const ledgerPath = path.join(c.dir, 'budget.ledger.jsonl');
  const lines = fs.readFileSync(ledgerPath, 'utf8').trimEnd().split('\n');
  assert.ok(lines.length >= 4);
  lines.splice(Math.floor(lines.length / 2), 1);
  fs.writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

  const r2 = c.router({});
  const res = r2.start();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_LEDGER_TAMPERED');
  assert.ok(res.chainBreaks > 0);
  assert.equal(r2.stopReason, 'ledger_tampered');
  await r2.dispose();
});

test('P1-2：start() 在缺 provider/model 时 fail-fast E_NO_PROVIDER（不等首 tick）', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const bare = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const r1 = c.router({ llm: bare });
  const res1 = r1.start();
  assert.equal(res1.ok, false);
  assert.equal(res1.code, 'E_NO_PROVIDER');
  assert.deepEqual(res1.missing, ['provider', 'model']);
  assert.equal(r1.state, 'stopped');
  assert.equal(r1.stopReason, 'no_provider');
  await r1.dispose();

  const r2 = c.router({ llm: bare, provider: 'mock' });
  const res2 = r2.start();
  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'E_NO_PROVIDER');
  assert.deepEqual(res2.missing, ['model']);
  await r2.dispose();
});

test('P10/P08：iterator.return() 永不 resolve 时 tick 仍能收敛，busy/预留都释放', async () => {
  const c = makeCase({ tasks: [task('hang')] });
  let returned = false;
  const llm = {
    provider: 'fixture',
    model: 'fixture-1',
    calls: 0,
    async *stream() {
      this.calls += 1;
      try {
        yield { type: 'text-delta', index: 0, text: 'partial' };
        await new Promise(() => { /* 永不 yield，也永不 return */ });
      } finally {
        returned = true;
      }
    },
  };
  const r = c.router({
    llm,
    maxTokens: 200,
    callMaxTokens: 50,
    callTimeoutMs: 5000,
    stopTimeoutMs: 500,
    retry: { maxAttempts: 1 },
  });
  r.start();
  const tickPromise = r.tick();
  await sleep(30);

  const started = Date.now();
  const stopRes = await r.stop();
  const stopElapsed = Date.now() - started;
  const tickRes = await tickPromise;
  const settleElapsed = Date.now() - started;

  assert.equal(stopRes.timedOut, false, 'stop 不能因为 return() 挂住');
  // 只量 stop() 本身；旧写法把 tick 收敛也算了进去，CI 抖动时会偶发 551ms。
  // 断言保留，放宽一个明确的调度余量（stopTimeoutMs + 150ms）。
  assert.ok(
    stopElapsed <= 500 + 150,
    `stop 必须在 stopTimeoutMs（500ms）附近收敛，允许 150ms 调度抖动（实测 ${stopElapsed}ms）`,
  );
  assert.ok(settleElapsed < 2000, `tick 必须在 stop 后很快收敛（实测 ${settleElapsed}ms）`);
  assert.equal(tickRes.ok, true);
  assert.equal(r.busy, false, 'busy 必须释放');
  assert.equal(r.reservedTokens, 0);
  assert.equal(r.ledger.snapshot().reserved, 0, '预留必须释放，不能泄漏 50');
  assert.equal(returned, false, '生成器 finally 可能来不及跑，但 tick 不能等它');
  await r.dispose();
});

test('P08：正常 abort 时消费端走到 drain 并关闭迭代器（finally 执行）', async () => {
  const c = makeCase({ tasks: [task('drain')] });
  let returned = false;
  let pulled = 0;
  const llm = {
    provider: 'fixture',
    model: 'fixture-1',
    async *stream() {
      try {
        while (true) {
          pulled += 1;
          yield { type: 'text-delta', index: 0, text: 'x' };
        }
      } finally {
        returned = true;
      }
    },
  };
  const r = c.router({
    llm,
    maxTokens: 200,
    callMaxTokens: 50,
    stopTimeoutMs: 500,
    retry: { maxAttempts: 1 },
  });
  r.start();
  const tickPromise = r.tick();
  await sleep(40);
  const stopRes = await r.stop();
  await tickPromise;

  assert.equal(stopRes.timedOut, false);
  assert.equal(returned, true, 'abort 之后必须真正关闭生成器');
  assert.ok(pulled >= 1);
  assert.equal(r.ledger.snapshot().reserved, 0);
  await r.dispose();
});

test('P12：stop 时 router.stop 审计写失败 → ok:false + E_AUDIT_WRITE，但状态必须 stopped', async () => {
  const c = makeCase({ tasks: [] });
  const r = c.router({});
  r.start();
  const original = r.audit.append.bind(r.audit);
  r.audit.append = (kind, data) => {
    if (kind === 'router.stop') throw new Error('disk full');
    return original(kind, data);
  };

  const res = await r.stop();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_AUDIT_WRITE');
  assert.equal(r.state, 'stopped', '审计坏了也要落到 stopped，不能假装还在跑');
  assert.equal(r.auditBroken, true);
  await r.dispose();
});

test('P29：队列容量上限——第 N+1 条返回 E_QUEUE_FULL，不落盘', async () => {
  const c = makeCase({
    queueText: [1, 2, 3, 4].map((i) => JSON.stringify(task(`q${i}`))).join('\n') + '\n',
  });
  const r = c.router({ maxQueuedTasks: 3, maxQueueBytes: 1024 });
  const capacity = r.queue.capacity();
  assert.equal(capacity.count, 4);
  assert.equal(capacity.full, true);

  const before = fs.statSync(c.queuePath).size;
  const res = r.queue.writer.append(task('q5'));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E_QUEUE_FULL');
  assert.equal(fs.statSync(c.queuePath).size, before, '拒绝时不能写半行');
  await r.dispose();
});

test('P22：dispose 之后 heartbeat 必须停止（不只是取消计时器句柄）', async () => {
  const c = makeCase({ tasks: [] });
  let installed = 0;
  let disposed = 0;
  const ctx = {
    effect(fn) {
      installed += 1;
      const stop = fn();
      return () => { disposed += 1; stop(); };
    },
  };
  const r = c.router({ ctx, heartbeatMs: 20 });
  r.start();
  await sleep(70);
  const beatsBefore = c.read().filter((rec) => rec.kind === 'router.heartbeat').length;
  assert.ok(beatsBefore >= 2, `heartbeat 应该已经在跑（${beatsBefore}）`);

  await r.dispose();
  assert.equal(disposed, 1);
  await sleep(60);
  const beatsAfter = c.read().filter((rec) => rec.kind === 'router.heartbeat').length;
  assert.equal(beatsAfter, beatsBefore, 'dispose 之后不能再产生 heartbeat');
  assert.equal(installed, 1);
});

test('M3a 真锚点：start 发现账本尾部半行 → 截断并写 budget.repair（只删 start 的 repairTail 会红）', async () => {
  const c = makeCase({ tasks: [task('t1')] });
  const ledgerPath = path.join(c.dir, 'budget.ledger.jsonl');
  const seed = new BudgetLedger({ file: ledgerPath, runId: 'seed', maxTokens: 100 });
  const seeded = seed.reserve({ taskId: 'seed', tokens: 1 });
  seed.settle({ id: seeded.id, tokens: 0 });
  fs.appendFileSync(ledgerPath, '{"v":1,"seq":99,"op":"settle","id":"rsv-x","tokens":30');
  const r = c.router({ llm: new MockLlm(), retry: { maxAttempts: 1 } });

  const started = await r.start();
  assert.equal(started.ok, true);

  const repairs = c.read().filter((rec) => rec.kind === 'budget.repair');
  assert.equal(repairs.length, 1, 'start 修尾必须留下 budget.repair 审计事件');
  assert.equal(repairs[0].repaired, true);
  assert.equal(repairs[0].reason, 'startup_tail_repair');
  assert.ok(fs.readFileSync(ledgerPath, 'utf8').endsWith('\n'), '账本必须被截到最后一条完整记录');

  await r.dispose();
});
