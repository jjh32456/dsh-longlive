// budget-ledger.mjs — 跨实例、跨重启的原子预算账本
//
// 为什么需要它：Router 的预算上限是「每个 run 目录」的，不是「每个进程实例」的。
// 旧实现把 tokensUsed 放在 Router 实例内存里，两个实例各读同一个审计文件、
// 各自以为还剩 100，结果 75 + 75 = 150 超支（复核 P02）；重启时又从审计里
// 取 max(tokens_total) 而不是累加（P03），只恢复了一部分。
//
// 账本是一个只追加的 JSONL 文件（默认与 queue 同目录的 budget.ledger.jsonl）：
//   {v,seq,ts,run_id,op:'adopt'|'reserve'|'settle'|'release', id, tokens, ..., prev_hash, hash}
//
// 每次读改写都在文件锁（<ledger>.lock，O_EXCL 创建）里完成，所以：
//   - 同进程的两个实例、或两个进程，预留会串行化，不会同时看到同一份剩余额度；
//   - reserve 是全有或全无：剩余不够 callMaxTokens 就返回 E_BUDGET_EXCEEDED，
//     不写任何记录（绝不出现「先花了再发现超了」）；
//   - settle 是硬上限：实花只记 min(请求值, 预留, 预算剩余)，超出部分拒绝并
//     返回 E_BUDGET_OVERSHOOT（复核 P0-1：60+60 重试不得记 120）；
//   - reserve 记录带 pid / started_at / lease_expires_at；崩溃遗留的 active 预留
//     在下次启动或下一 tick 时按「pid 不存在」或「租约过期」回收（P0-2）；
//   - 每条记录带 prev_hash + hash 的链，删整行/改字段会在下次读时暴露（P0-4）；
//   - 半行尾可在 start() 之前用 repairTail() 修掉（P0-3）。
//
// 锁是同步的（openSync 'wx' + 短暂 Atomics.wait 自旋）。这个 spike 的临界区
// 只有一次 append + fsync，同步锁让「预留」在 JS 语义上真正原子，也避免了
// 把 Router.start() 变成 async。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const LEDGER_VERSION = 1;
export const LEDGER_GENESIS = '0'.repeat(64);

export const LEDGER_ERRORS = Object.freeze({
  INVALID: 'E_BUDGET_INVALID',
  LOCK: 'E_BUDGET_LOCK',
  CORRUPT: 'E_BUDGET_CORRUPT',
  WRITE: 'E_BUDGET_WRITE',
  READ: 'E_BUDGET_READ',
  EXCEEDED: 'E_BUDGET_EXCEEDED',
  OVERSHOOT: 'E_BUDGET_OVERSHOOT',
  UNKNOWN_RESERVATION: 'E_BUDGET_UNKNOWN_RESERVATION',
  TAMPERED: 'E_LEDGER_TAMPERED',
});

const sleepSync = (ms) => {
  // 只在抢锁失败时睡几毫秒；SharedArrayBuffer 不依赖第三方库。
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
};

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function ledgerError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

/** 记录的内容 hash（不含 hash 字段本身）。 */
export function recordHash(record) {
  const { hash: _ignored, ...rest } = record;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/**
 * 校验账本 hash 链。纯函数。
 * 账本不轮转，所以第一条必须是 seq=1 + GENESIS；任何缺号/断链/字段改动都算 break。
 *
 * @returns {{ok:boolean, signed:boolean, breaks:Array<{index:number,seq?:number,reason:string}>}}
 */
export function verifyLedgerChain(records) {
  const breaks = [];
  const hashed = records.some((rec) => rec && typeof rec === 'object' && typeof rec.hash === 'string');
  if (!hashed) return { ok: true, signed: false, breaks };

  let expectedSeq = 0;
  let expectedPrev = LEDGER_GENESIS;
  for (let index = 0; index < records.length; index += 1) {
    const rec = records[index];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      breaks.push({ index, reason: 'not an object' });
      continue;
    }
    if (typeof rec.hash !== 'string' || rec.hash.length === 0) {
      breaks.push({ index, seq: rec.seq, reason: 'missing hash' });
      expectedSeq = Number.isInteger(rec.seq) ? rec.seq : expectedSeq;
      expectedPrev = typeof rec.prev_hash === 'string' ? rec.prev_hash : expectedPrev;
      continue;
    }
    if (rec.seq !== expectedSeq + 1) {
      breaks.push({ index, seq: rec.seq, reason: `seq gap (expected ${expectedSeq + 1})` });
    }
    if (rec.prev_hash !== expectedPrev) {
      breaks.push({ index, seq: rec.seq, reason: 'prev_hash mismatch' });
    }
    if (recordHash(rec) !== rec.hash) {
      breaks.push({ index, seq: rec.seq, reason: 'hash mismatch' });
    }
    expectedSeq = rec.seq;
    expectedPrev = rec.hash;
  }
  return { ok: breaks.length === 0, signed: true, breaks };
}

/**
 * 折叠账本记录。纯函数，方便单测；也用于「账本损坏时拒绝启动」的判定。
 *
 * @returns {{used:number, reserved:number, active:Map<string,{tokens:number,owner:string|null,taskId:string|null,pid:number|null,startedAt:string|null,leaseExpiresAt:number|null}>, settled:Set<string>, badLines:number, records:number, seq:number, lastHash:string|null}}
 */
export function foldRecords(records) {
  let used = 0;
  let badLines = 0;
  let seq = 0;
  let lastHash = null;
  const active = new Map();
  const settled = new Set();

  for (const rec of records) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      badLines += 1;
      continue;
    }
    if (Number.isInteger(rec.seq)) seq = Math.max(seq, rec.seq);
    if (typeof rec.hash === 'string' && rec.hash.length > 0) lastHash = rec.hash;
    switch (rec.op) {
      case 'adopt': {
        if (!isFiniteNonNegative(rec.used)) {
          badLines += 1;
          break;
        }
        // adopt 只在账本为空时写入；用 max 防止手写账本把已用额度改小。
        used = Math.max(used, rec.used);
        break;
      }
      case 'reserve': {
        const tokens = Number(rec.tokens);
        if (typeof rec.id !== 'string' || !isFiniteNonNegative(tokens)) {
          badLines += 1;
          break;
        }
        const leaseRaw = rec.lease_expires_at;
        const lease = typeof leaseRaw === 'string'
          ? Date.parse(leaseRaw)
          : (Number.isFinite(leaseRaw) ? leaseRaw : NaN);
        active.set(rec.id, {
          tokens,
          owner: typeof rec.owner === 'string' ? rec.owner : null,
          taskId: typeof rec.task_id === 'string' ? rec.task_id : null,
          pid: Number.isInteger(rec.pid) ? rec.pid : null,
          startedAt: typeof rec.started_at === 'string' ? rec.started_at : null,
          leaseExpiresAt: Number.isFinite(lease) ? lease : null,
        });
        break;
      }
      case 'settle': {
        const tokens = Number(rec.tokens);
        if (typeof rec.id !== 'string' || !isFiniteNonNegative(tokens)) {
          badLines += 1;
          break;
        }
        if (settled.has(rec.id)) break;
        settled.add(rec.id);
        used += tokens;
        active.delete(rec.id);
        break;
      }
      case 'release': {
        if (typeof rec.id !== 'string') {
          badLines += 1;
          break;
        }
        active.delete(rec.id);
        break;
      }
      default:
        badLines += 1;
        break;
    }
  }

  let reserved = 0;
  for (const entry of active.values()) reserved += entry.tokens;
  return { used, reserved, active, settled, badLines, records: records.length, seq, lastHash };
}

/**
 * 读账本，坏行计入 badLines（不抛）。
 * 只对「能解析的记录」校验 hash 链；半行尾由 repairTail() 处理。
 */
export function readLedger(file) {
  if (!fs.existsSync(file)) {
    return {
      records: [],
      badLines: 0,
      bytes: 0,
      tailTruncated: false,
      chainBreaks: [],
      signed: false,
      lastHash: null,
    };
  }
  const text = fs.readFileSync(file, 'utf8');
  const records = [];
  let badLines = 0;
  let tailTruncated = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const isLast = i === lines.length - 1;
    try {
      const rec = JSON.parse(line);
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        badLines += 1;
        if (isLast) tailTruncated = true;
        continue;
      }
      records.push(rec);
    } catch {
      badLines += 1;
      if (isLast) tailTruncated = true;
    }
  }
  const chain = verifyLedgerChain(records);
  return {
    records,
    badLines,
    bytes: Buffer.byteLength(text),
    tailTruncated,
    chainBreaks: chain.breaks,
    signed: chain.signed,
    lastHash: records.length > 0 && typeof records[records.length - 1].hash === 'string'
      ? records[records.length - 1].hash
      : null,
  };
}

export class BudgetLedger {
  constructor({
    file,
    runId = `ledger-${process.pid}`,
    maxTokens = Infinity,
    lockTimeoutMs = 3000,
    lockRetryMs = 5,
    staleLockMs = 5000,
    pid = process.pid,
    now = () => new Date().toISOString(),
    reservationLeaseMs = 60000,
  } = {}) {
    if (!file) throw new Error('BudgetLedger: file is required');
    this.file = file;
    this.runId = runId;
    this.maxTokens = maxTokens;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.staleLockMs = staleLockMs;
    this.pid = pid;
    this.now = now;
    this.reservationLeaseMs = reservationLeaseMs;
  }

  get lockPath() {
    return `${this.file}.lock`;
  }

  /** 只读快照（读的时候不抢锁：单行 append 要么完整要么被算成坏行）。 */
  snapshot() {
    const read = readLedger(this.file);
    const state = foldRecords(read.records);
    state.badLines += read.badLines;
    return {
      ...state,
      // 剩余预算 = 硬上限 - 已花 - 占着但未结算；调用方/测试常用，别只给 used/reserved。
      remaining: Math.max(0, this.maxTokens - state.used - state.reserved),
      file: this.file,
      bytes: read.bytes,
      tailTruncated: read.tailTruncated,
      chainBreaks: read.chainBreaks,
      signed: read.signed,
    };
  }

  /**
   * 修掉崩溃留下的半行尾：把文件截断到最后一条完整记录。
   * 必须在 Router.start() 读快照之前调用（P0-3）；幂等，没有半行时什么都不做。
   *
   * @returns {{ok:boolean, repaired:boolean}}
   */
  repairTail() {
    if (!fs.existsSync(this.file)) return { ok: true, repaired: false };
    this.#acquire();
    try {
      return { ok: true, repaired: this.#repairTail() };
    } finally {
      this.#release();
    }
  }

  /** 全有或全无预留。返回 {ok:true,id,used,reserved,remaining} 或 {ok:false,code:E_BUDGET_EXCEEDED,...}。 */
  reserve({ taskId = null, tokens, owner = this.runId, tick = null, leaseMs = this.reservationLeaseMs } = {}) {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw ledgerError(LEDGER_ERRORS.INVALID, `reserve() needs a positive token count, got ${tokens}`);
    }
    return this.#withLock(() => {
      const state = this.#stateInsideLock();
      const remaining = this.maxTokens - state.used - state.reserved;
      if (tokens > remaining) {
        return {
          ok: false,
          code: LEDGER_ERRORS.EXCEEDED,
          used: state.used,
          reserved: state.reserved,
          remaining: Math.max(0, remaining),
          needed: tokens,
        };
      }
      const seq = state.seq + 1;
      const id = `rsv-${this.pid}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();
      const lease = Number.isFinite(leaseMs) && leaseMs > 0 ? startedAt + leaseMs : null;
      this.#append(state, {
        op: 'reserve',
        id,
        task_id: taskId,
        tokens,
        owner,
        tick,
        pid: this.pid,
        started_at: new Date(startedAt).toISOString(),
        lease_expires_at: lease === null ? null : new Date(lease).toISOString(),
      });
      return {
        ok: true,
        id,
        used: state.used,
        reserved: state.reserved + tokens,
        remaining: remaining - tokens,
      };
    });
  }

  /**
   * 结算一次预留；幂等。
   * 硬上限（P0-1）：只记 min(tokens, 预留额度, 预算剩余)，超出部分拒绝并返回
   * E_BUDGET_OVERSHOOT；绝不把 used 记到 maxTokens 以上。
   */
  settle({ id, tokens, allowOvershoot = false } = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      throw ledgerError(LEDGER_ERRORS.INVALID, 'settle() needs a reservation id');
    }
    if (!isFiniteNonNegative(Number(tokens))) {
      throw ledgerError(LEDGER_ERRORS.INVALID, `settle() needs a non-negative token count, got ${tokens}`);
    }
    const amount = Number(tokens);
    return this.#withLock(() => {
      const state = this.#stateInsideLock();
      if (state.settled.has(id)) {
        return { ok: true, duplicate: true, applied: 0, used: state.used, reserved: state.reserved };
      }
      const active = state.active.get(id);
      if (!active) {
        return {
          ok: false,
          code: LEDGER_ERRORS.UNKNOWN_RESERVATION,
          id,
          used: state.used,
          reserved: state.reserved,
        };
      }
      const room = Math.max(0, this.maxTokens - state.used);
      // Usually a settle may never exceed what was reserved. The router opts into
      // allowOvershoot so a call whose real usage blew past its reservation is
      // still fully accounted (up to the hard run cap) instead of vanishing from
      // the ledger; the caller audits budget.overshoot and halts the run.
      const ceiling = allowOvershoot ? room : Math.min(active.tokens, room);
      const applied = Math.max(0, Math.min(amount, ceiling));
      const rejected = amount - applied;
      this.#append(state, {
        op: 'settle',
        id,
        tokens: applied,
        requested_tokens: amount,
        rejected_tokens: rejected,
      });
      const used = state.used + applied;
      const reserved = Math.max(0, state.reserved - active.tokens);
      if (rejected > 0) {
        return {
          ok: false,
          code: LEDGER_ERRORS.OVERSHOOT,
          applied,
          rejected,
          used,
          reserved,
          reserved_tokens: active.tokens,
          hard_cap: Number.isFinite(this.maxTokens) ? this.maxTokens : null,
        };
      }
      return { ok: true, duplicate: false, applied, used, reserved };
    });
  }

  /** 调用没有发生（抛错/中止）时释放预留，不计费。 */
  release({ id } = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      throw ledgerError(LEDGER_ERRORS.INVALID, 'release() needs a reservation id');
    }
    return this.#withLock(() => {
      const state = this.#stateInsideLock();
      if (!state.active.has(id)) {
        return { ok: true, released: false, used: state.used, reserved: state.reserved };
      }
      const tokens = state.active.get(id).tokens;
      this.#append(state, { op: 'release', id, reason: 'explicit_release' });
      return {
        ok: true,
        released: true,
        used: state.used,
        reserved: Math.max(0, state.reserved - tokens),
      };
    });
  }

  /** stop 超时兜底：把本实例还挂着的预留全部释放（僵尸 tick 不能再占额度）。 */
  releaseOwner({ owner = this.runId } = {}) {
    return this.#withLock(() => {
      const state = this.#stateInsideLock();
      const ids = [];
      for (const [id, entry] of state.active) {
        if (entry.owner === owner) ids.push(id);
      }
      let reserved = state.reserved;
      for (const id of ids) {
        const entry = state.active.get(id);
        reserved = Math.max(0, reserved - entry.tokens);
        this.#append(state, { op: 'release', id, reason: 'owner_force_release' });
      }
      return { ok: true, released: ids.length, used: state.used, reserved };
    });
  }

  /**
   * 回收崩溃遗留的 active 预留（P0-2）：
   *   - 预留记录的 pid 明确存在且已不存在；或
   *   - lease_expires_at 已过期。
   * 同一进程里正在跑的预留（pid 活着、租约有效）绝不动。
   */
  reclaimDead({ now = Date.now() } = {}) {
    return this.#withLock(() => {
      const state = this.#stateInsideLock();
      const items = [];
      let reserved = state.reserved;
      for (const [id, entry] of state.active) {
        const pidKnown = Number.isInteger(entry.pid) && entry.pid > 0;
        const pidDead = pidKnown && !pidAlive(entry.pid);
        const leaseExpired = entry.leaseExpiresAt !== null && entry.leaseExpiresAt <= now;
        if (!pidDead && !leaseExpired) continue;
        const reason = pidDead ? 'dead_pid' : 'lease_expired';
        this.#append(state, {
          op: 'release',
          id,
          reason,
          released_tokens: entry.tokens,
          dead_pid: pidKnown && pidDead ? entry.pid : null,
        });
        reserved = Math.max(0, reserved - entry.tokens);
        items.push({ id, tokens: entry.tokens, reason });
      }
      return {
        ok: true,
        released: items.length,
        freedTokens: items.reduce((sum, item) => sum + item.tokens, 0),
        used: state.used,
        reserved,
        items,
      };
    });
  }

  /** 首次接管一个只有审计、没有账本的 run：把审计恢复出的已用额度写死进账本。 */
  adopt({ used, reason = 'audit_bootstrap' } = {}) {
    if (!isFiniteNonNegative(Number(used))) {
      throw ledgerError(LEDGER_ERRORS.INVALID, `adopt() needs a non-negative used count, got ${used}`);
    }
    return this.#withLock(() => {
      const state = this.#stateInsideLock();
      if (state.records > 0) {
        return { ok: false, code: 'E_BUDGET_ALREADY_INITIALISED', used: state.used, reserved: state.reserved };
      }
      this.#append(state, { op: 'adopt', used: Number(used), reason });
      return { ok: true, used: Number(used), reserved: 0 };
    });
  }

  #stateInsideLock() {
    const read = readLedger(this.file);
    if (read.chainBreaks.length > 0) {
      throw ledgerError(
        LEDGER_ERRORS.TAMPERED,
        `budget ledger ${this.file} hash chain is broken (${read.chainBreaks.length} break(s))`,
        { chainBreaks: read.chainBreaks.slice(0, 5) },
      );
    }
    const state = foldRecords(read.records);
    state.badLines += read.badLines;
    if (state.badLines > 0) {
      throw ledgerError(
        LEDGER_ERRORS.CORRUPT,
        `budget ledger ${this.file} has ${state.badLines} unreadable record(s); refusing to guess the remaining budget`,
        { badLines: state.badLines },
      );
    }
    state.chainBreaks = read.chainBreaks;
    state.signed = read.signed;
    state.lastHash = read.lastHash ?? state.lastHash;
    return state;
  }

  #withLock(fn) {
    this.#acquire();
    try {
      this.#repairTail();
      return fn();
    } finally {
      this.#release();
    }
  }

  #acquire() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: this.pid, at: Date.now(), run_id: this.runId }));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw ledgerError(LEDGER_ERRORS.LOCK, `cannot create budget lock ${this.lockPath}: ${error.message}`);
        }
        if (this.#isStaleLock()) {
          try { fs.unlinkSync(this.lockPath); } catch { /* someone else won the race */ }
          continue;
        }
        if (Date.now() >= deadline) {
          throw ledgerError(LEDGER_ERRORS.LOCK, `timed out waiting for budget lock ${this.lockPath}`);
        }
        sleepSync(this.lockRetryMs);
      }
    }
  }

  #isStaleLock() {
    let text;
    try {
      text = fs.readFileSync(this.lockPath, 'utf8');
    } catch {
      return false;
    }
    try {
      const info = JSON.parse(text);
      if (Number.isInteger(info?.pid)) return !pidAlive(info.pid);
    } catch {
      // 锁文件写了一半：只能按 mtime 判老。
    }
    try {
      return Date.now() - fs.statSync(this.lockPath).mtimeMs > this.staleLockMs;
    } catch {
      return false;
    }
  }

  #release() {
    try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
  }

  /**
   * 崩溃可能留下半行；写新记录前把尾巴修到最后一条完整记录，避免坏行永久毒化账本。
   * @returns {boolean} 是否真的截断过。
   */
  #repairTail() {
    if (!fs.existsSync(this.file)) return false;
    const size = fs.statSync(this.file).size;
    if (size === 0) return false;
    const fd = fs.openSync(this.file, 'r+');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return false;
      const text = fs.readFileSync(this.file, 'utf8');
      const index = text.lastIndexOf('\n');
      fs.ftruncateSync(fd, index + 1);
      fs.fsyncSync(fd);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 追加一条带 hash 链的记录；调用方必须已持有锁并传入刚读出的 state。 */
  #append(state, fields) {
    const seq = state.seq + 1;
    const base = {
      v: LEDGER_VERSION,
      seq,
      ts: this.now(),
      run_id: this.runId,
      ...fields,
      // VM/status tooling reads ledger rows by `kind`; `op` stays the canonical
      // on-disk operation name for backwards compatibility.
      kind: fields.op,
      prev_hash: state.lastHash ?? LEDGER_GENESIS,
    };
    const hash = recordHash(base);
    const record = { ...base, hash };
    const line = `${JSON.stringify(record)}\n`;
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } catch (error) {
      throw ledgerError(LEDGER_ERRORS.WRITE, `cannot append to budget ledger ${this.file}: ${error.message}`);
    } finally {
      fs.closeSync(fd);
    }
    state.seq = seq;
    state.lastHash = hash;
    state.records += 1;
  }
}
