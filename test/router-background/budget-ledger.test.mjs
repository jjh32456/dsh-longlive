// test/budget-ledger.test.mjs — 跨实例/跨重启的原子预算账本
//
// 对应红队 P02（两实例各 75 / 预算 100 实花 150）、P03（重启只恢复
// max 而不是 sum）、P06（负 usage 退款）与 MF-08（损坏不猜）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BudgetLedger,
  LEDGER_ERRORS,
  foldRecords,
  readLedger,
} from '../../src/router/background/budget-ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(path.dirname(here), '.tmp');
let caseNo = 0;

function ledgerFile() {
  const dir = path.join(TMP, `ledger-${process.pid}-${caseNo++}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'budget.ledger.jsonl');
}

function makeLedger(file, overrides = {}) {
  return new BudgetLedger({ file, runId: 'run-test', maxTokens: 100, ...overrides });
}

test('reserve 全有或全无：100 预算下 75 可以，第二个 30 直接 E_BUDGET_EXCEEDED 且不写记录', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);

  const first = ledger.reserve({ taskId: 't1', tokens: 75, owner: 'run-a' });
  assert.equal(first.ok, true);
  assert.equal(first.remaining, 25);

  const linesBefore = readLedger(file).records.length;
  const second = ledger.reserve({ taskId: 't2', tokens: 30, owner: 'run-b' });
  assert.equal(second.ok, false);
  assert.equal(second.code, LEDGER_ERRORS.EXCEEDED);
  assert.equal(second.needed, 30);
  assert.equal(second.remaining, 25);
  assert.equal(readLedger(file).records.length, linesBefore, '拒绝时不能留下半条预留');

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.used, 0);
  assert.equal(snapshot.reserved, 75);
});

test('settle 幂等：同一 reservation 重复结算只计一次', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);
  const reservation = ledger.reserve({ taskId: 't1', tokens: 75, owner: 'run-a' });

  const settled = ledger.settle({ id: reservation.id, tokens: 60 });
  assert.equal(settled.duplicate, false);
  assert.equal(settled.used, 60);
  assert.equal(settled.reserved, 0);

  const again = ledger.settle({ id: reservation.id, tokens: 60 });
  assert.equal(again.duplicate, true);
  assert.equal(again.used, 60);
  assert.equal(ledger.snapshot().used, 60);
});

test('release 只释放预留、不计费', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);
  const reservation = ledger.reserve({ tokens: 75, owner: 'run-a' });

  const released = ledger.release({ id: reservation.id });
  assert.equal(released.released, true);
  assert.equal(released.reserved, 0);
  assert.equal(ledger.snapshot().used, 0);

  const twice = ledger.release({ id: reservation.id });
  assert.equal(twice.released, false);
});

test('P02：两个实例共享账本，预留严格串行（75 + 60 时第二个必须失败）', () => {
  const file = ledgerFile();
  const a = makeLedger(file, { runId: 'run-a' });
  const b = makeLedger(file, { runId: 'run-b' });

  assert.equal(a.reserve({ tokens: 75, owner: 'run-a' }).ok, true);
  const blocked = b.reserve({ tokens: 60, owner: 'run-b' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, LEDGER_ERRORS.EXCEEDED);
  assert.equal(blocked.used, 0);
  assert.equal(blocked.remaining, 25);
  assert.equal(a.snapshot().reserved, 75, 'B 的失败不能影响 A 已拿到的预留');
});

test('P03：新实例从账本恢复全部 used + reserved（不是取 max）', () => {
  const file = ledgerFile();
  const first = makeLedger(file, { runId: 'run-1', maxTokens: 300 });
  const one = first.reserve({ tokens: 75, owner: 'run-1' });
  first.settle({ id: one.id, tokens: 75 });
  const two = first.reserve({ tokens: 75, owner: 'run-1' });
  first.settle({ id: two.id, tokens: 75 });
  const three = first.reserve({ tokens: 50, owner: 'run-1' });

  const restarted = makeLedger(file, { runId: 'run-2', maxTokens: 300 });
  const snapshot = restarted.snapshot();
  assert.equal(snapshot.used, 150, '两笔 75 必须相加');
  assert.equal(snapshot.reserved, 50);
  assert.equal(snapshot.records, 5);

  // 剩余 100：再要 101 必须失败，说明串起来的账是真的。
  assert.equal(restarted.reserve({ tokens: 101, owner: 'run-2' }).ok, false);
  assert.equal(restarted.reserve({ tokens: 100, owner: 'run-2' }).ok, true);
  assert.equal(three.ok, true);
});

test('崩溃遗留的 active 预留：releaseOwner 只清理自己的 owner', () => {
  const file = ledgerFile();
  const crashed = makeLedger(file, { runId: 'run-crashed', maxTokens: 300 });
  crashed.reserve({ tokens: 75, owner: 'run-crashed' });

  const fresh = makeLedger(file, { runId: 'run-fresh', maxTokens: 300 });
  const mine = fresh.reserve({ tokens: 50, owner: 'run-fresh' });
  assert.equal(mine.ok, true);
  assert.equal(fresh.snapshot().reserved, 125);

  const released = fresh.releaseOwner({ owner: 'run-fresh' });
  assert.equal(released.released, 1);
  assert.equal(fresh.snapshot().reserved, 75, '别人的预留不能被我顺手释放');
  assert.equal(fresh.snapshot().used, 0, '释放不等于计费');
});

test('adopt 只在空账本上生效，之后 reserve 以 adopted used 为起点', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);
  const adopted = ledger.adopt({ used: 80, reason: 'audit_bootstrap' });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.used, 80);

  const second = ledger.adopt({ used: 10 });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_BUDGET_ALREADY_INITIALISED');

  const blocked = ledger.reserve({ tokens: 30 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.remaining, 20);
});

test('账本损坏：完整坏行 ⇒ snapshot 报 badLines，reserve 拒绝猜剩余额度（E_BUDGET_CORRUPT）', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);
  ledger.reserve({ tokens: 20 });
  // 关键：坏行是「完整的一行」（带换行），不是可修的半行尾 —— 这种是篡改/损坏，不能猜。
  fs.appendFileSync(file, '{"v":1,"seq":99,"op":"settle"\n');

  const read = readLedger(file);
  assert.equal(read.badLines, 1);
  assert.equal(read.tailTruncated, false);

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.badLines, 1);

  assert.throws(
    () => ledger.reserve({ tokens: 10 }),
    (error) => error.code === LEDGER_ERRORS.CORRUPT,
  );
  assert.ok(fs.readFileSync(file, 'utf8').includes('"op":"settle"'));
});

test('半行尾巴在下次写入前被修掉，不会永久毒化账本', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);
  ledger.reserve({ tokens: 20 });
  fs.appendFileSync(file, '{"v":1,"seq":2,"op":"res');

  const reservation = ledger.reserve({ tokens: 30 });
  assert.equal(reservation.ok, true, '修尾之后应能继续预留');
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.badLines, 0);
  assert.equal(snapshot.reserved, 50);
});

test('锁：死 pid 的锁按 stale 处理；活 pid 的锁超时后返回 E_BUDGET_LOCK', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);

  fs.writeFileSync(ledger.lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.equal(ledger.reserve({ tokens: 10 }).ok, true);
  assert.equal(fs.existsSync(ledger.lockPath), false, 'stale 锁应被清掉');

  fs.writeFileSync(ledger.lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
  try {
    assert.throws(
      () => makeLedger(file, { lockTimeoutMs: 30, lockRetryMs: 2 }).reserve({ tokens: 10 }),
      (error) => error.code === LEDGER_ERRORS.LOCK,
    );
  } finally {
    fs.rmSync(ledger.lockPath, { force: true });
  }
});

test('foldRecords：未知 op / 非对象 / 负数 token 全算坏行', () => {
  const state = foldRecords([
    { op: 'reserve', id: 'a', tokens: 10 },
    { op: 'settle', id: 'a', tokens: 10 },
    { op: 'mystery' },
    { op: 'reserve', id: 'b', tokens: -5 },
    null,
  ]);
  assert.equal(state.used, 10);
  assert.equal(state.reserved, 0);
  assert.equal(state.badLines, 3);
  assert.equal(state.records, 5);
});

test('P0-1：settle 硬上限 —— 预留 75、实际 120 只记 75，多出的 45 拒绝（E_BUDGET_OVERSHOOT）', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);
  const reservation = ledger.reserve({ taskId: 't1', tokens: 75 });
  assert.equal(reservation.ok, true);

  const settled = ledger.settle({ id: reservation.id, tokens: 120 });
  assert.equal(settled.ok, false);
  assert.equal(settled.code, LEDGER_ERRORS.OVERSHOOT);
  assert.equal(settled.applied, 75);
  assert.equal(settled.rejected, 45);
  assert.equal(settled.used, 75);
  assert.equal(settled.reserved, 0);

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.used, 75, '重试 60+60 在 75 预留下只能记 75，不能记 120');
  assert.equal(snapshot.reserved, 0);
});

test('P0-1：settle 硬上限 —— used 80 + 预留 20，实际 25 只记 20，used 封顶 100', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file, { maxTokens: 100 });
  const first = ledger.reserve({ tokens: 80 });
  ledger.settle({ id: first.id, tokens: 80 });

  const second = ledger.reserve({ tokens: 20 });
  assert.equal(second.ok, true, '80 已用 + 20 预留正好 100');

  const settled = ledger.settle({ id: second.id, tokens: 25 });
  assert.equal(settled.ok, false);
  assert.equal(settled.code, LEDGER_ERRORS.OVERSHOOT);
  assert.equal(settled.applied, 20);
  assert.equal(settled.rejected, 5);
  assert.equal(settled.used, 100);
});

test('settle 未知 reservation：E_BUDGET_UNKNOWN_RESERVATION，且不写 settle 记录', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);
  ledger.reserve({ tokens: 10 });
  const before = readLedger(file).records.length;

  const settled = ledger.settle({ id: 'rsv-does-not-exist', tokens: 5 });
  assert.equal(settled.ok, false);
  assert.equal(settled.code, LEDGER_ERRORS.UNKNOWN_RESERVATION);
  assert.equal(readLedger(file).records.length, before);
});

test('P0-2：reclaimDead 回收 pid 不存在的预留，活 pid + 有效租约保留', () => {
  const file = ledgerFile();
  const dead = makeLedger(file, { pid: 999999, runId: 'run-dead' });
  assert.equal(dead.reserve({ tokens: 75, owner: 'run-dead', leaseMs: 60000 }).ok, true);

  const alive = makeLedger(file, { runId: 'run-alive' });
  assert.equal(alive.reserve({ tokens: 10, owner: 'run-alive', leaseMs: 60000 }).ok, true);
  assert.equal(alive.snapshot().reserved, 85);

  const reclaimed = alive.reclaimDead();
  assert.equal(reclaimed.released, 1);
  assert.equal(reclaimed.freedTokens, 75);
  assert.equal(reclaimed.items[0].reason, 'dead_pid');
  assert.equal(alive.snapshot().reserved, 10, '活 pid 的预留必须保留');
});

test('P0-2：reclaimDead 在租约过期时回收（即使 pid 还活着）', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file, { pid: process.pid });
  assert.equal(ledger.reserve({ tokens: 25, leaseMs: 1000 }).ok, true);

  const reclaimed = ledger.reclaimDead({ now: Date.now() + 5000 });
  assert.equal(reclaimed.released, 1);
  assert.equal(reclaimed.items[0].reason, 'lease_expired');
  assert.equal(ledger.snapshot().reserved, 0);
});

test('P0-3：repairTail() 可在 start 前调用 —— 截掉半行、保留完好行', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file);
  ledger.reserve({ tokens: 20 });
  fs.appendFileSync(file, '{"v":1,"seq":2,"op":"res');
  assert.equal(readLedger(file).tailTruncated, true);

  const repaired = ledger.repairTail();
  assert.equal(repaired.repaired, true);

  const read = readLedger(file);
  assert.equal(read.badLines, 0);
  assert.equal(read.tailTruncated, false);
  assert.equal(read.records.length, 1, '完好行必须保留');
  assert.equal(ledger.reserve({ tokens: 30 }).ok, true);
});

test('P0-4：账本 hash 链 —— 删掉中间一条整行 → chainBreaks>0，reserve 抛 E_LEDGER_TAMPERED', () => {
  const file = ledgerFile();
  const ledger = makeLedger(file, { maxTokens: 300 });
  ledger.reserve({ tokens: 20 });
  ledger.reserve({ tokens: 30 });
  ledger.reserve({ tokens: 10 });

  const read = readLedger(file);
  assert.equal(read.signed, true);
  assert.equal(read.chainBreaks.length, 0);

  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 3);
  fs.writeFileSync(file, `${lines[0]}\n${lines[2]}\n`); // 删中间整行

  const tampered = readLedger(file);
  assert.ok(tampered.chainBreaks.length > 0, '删中间行必须暴露 seq gap / prev_hash 断裂');
  assert.throws(
    () => ledger.reserve({ tokens: 1 }),
    (error) => error.code === LEDGER_ERRORS.TAMPERED,
  );
});
