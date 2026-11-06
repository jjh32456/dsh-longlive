// anchor.mjs — 预算账本 / 审计链之外的第三个「锚」
//
// 为什么需要它（红队 F10）：账本和审计各自都是自证 hash 链。攻击者如果有写权限，
// 可以同时重算两条链（把 used 30 改成 5），两条链各自自洽、互相对得上，旧版
// start() 就放行了。锚文件把「某一时刻两条链的 (seq, last_hash, used)」再封一次，
// 并且自己也是一条只追加 hash 链；重算账本+审计而不同时重算锚，就会在锚的
// prefix 对账处露馅。
//
// 明确的能力边界（不吹）：锚文件和账本在同一台机器、同一个可写目录里。有写权限
// 的攻击者如果知道锚的存在，可以连锚一起重算，或者直接删掉锚文件。单机软件
// 无法对「拥有同等写权限的攻击者」提供密码学意义上的防篡改——真正的外部锚
// 必须落在攻击者写不到的地方（只读挂载 / 另一台机器 / 硬件根 / 透明日志）。
// 这里做的是「提高攻击成本 + 抓住只改两条链的常见攻击 + 给出可接线点」：
//   - Router 选项 anchorPath 可以把锚放到只读目录/另一个卷；
//   - verifyAnchor() 是纯函数，宿主可以拿外部 checkpoint 的 (seq, hash) 来调用；
//   - 删除锚文件不会被静默接受：账本非空而锚缺失时，Router 以 E_ANCHOR_MISSING
//     拒绝启动（bootstrap 旧数据需显式 allowMissingAnchor: true）。
//
// 记录格式（JSONL，只追加）：
//   {v,seq,ts,prev_hash,ledger:{seq,last_hash,used,reserved},
//    audit:{seq,last_hash,settled_used,records},hash}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ANCHOR_VERSION = 1;
export const ANCHOR_GENESIS = '0'.repeat(64);

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(sleepBuffer, 0, 0, Math.min(ms, 1000));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function anchorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 锚记录的内容 hash（不含 hash 本身）。 */
export function anchorRecordHash(record) {
  const { hash: _ignored, ...rest } = record;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/** 校验锚自身的 hash 链；第一条必须是 seq=1 + GENESIS。 */
export function verifyAnchorChain(records) {
  const breaks = [];
  let expectedSeq = 0;
  let expectedPrev = ANCHOR_GENESIS;
  for (let index = 0; index < records.length; index += 1) {
    const rec = records[index];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      breaks.push({ index, reason: 'not an object' });
      continue;
    }
    if (rec.seq !== expectedSeq + 1) {
      breaks.push({ index, seq: rec.seq, reason: `seq gap (expected ${expectedSeq + 1})` });
    }
    if (rec.prev_hash !== expectedPrev) {
      breaks.push({ index, seq: rec.seq, reason: 'prev_hash mismatch' });
    }
    if (rec.hash !== anchorRecordHash(rec)) {
      breaks.push({ index, seq: rec.seq, reason: 'hash mismatch' });
    }
    expectedSeq = rec.seq;
    expectedPrev = rec.hash;
  }
  return { ok: breaks.length === 0, breaks };
}

export function readAnchor(file) {
  if (!fs.existsSync(file)) {
    return { records: [], badLines: 0, tailTruncated: false, bytes: 0, chainBreaks: [], file };
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
  const chain = verifyAnchorChain(records);
  return {
    records,
    badLines,
    tailTruncated,
    bytes: Buffer.byteLength(text),
    chainBreaks: chain.breaks,
    file,
  };
}

function recordAt(records, seq) {
  if (!Number.isInteger(seq) || seq <= 0) return null;
  return records.find((rec) => rec && rec.seq === seq) ?? null;
}

/**
 * 用锚里最后一次 checkpoint 校验两条链的 prefix 与单调量。
 *
 * @param {Array} anchorRecords
 * @param {{ledgerRecords:Array, ledgerState:{seq:number,used:number},
 *          auditRecords:Array, auditSettled:number}} view
 * @returns {{ok:boolean, anchored:boolean, reason?:string, last?:object}}
 */
export function verifyAnchor(anchorRecords, {
  ledgerRecords = [],
  ledgerState = {},
  auditRecords = [],
  auditSettled = 0,
  auditFile = null,
} = {}) {
  if (!Array.isArray(anchorRecords) || anchorRecords.length === 0) {
    return { ok: true, anchored: false, reason: 'no_anchor' };
  }
  const chain = verifyAnchorChain(anchorRecords);
  if (!chain.ok) {
    return { ok: false, anchored: true, reason: 'anchor_chain_broken', chainBreaks: chain.breaks };
  }
  const last = anchorRecords[anchorRecords.length - 1];
  const expected = last?.ledger;
  if (!expected || !Number.isInteger(expected.seq) || typeof expected.last_hash !== 'string') {
    return { ok: false, anchored: true, reason: 'anchor_ledger_checkpoint_malformed', last };
  }
  // 账本被截短（删掉尾部记录）——锚指向的 seq 已经不存在。
  if ((ledgerState.seq ?? 0) < expected.seq) {
    return { ok: false, anchored: true, reason: 'ledger_truncated', last };
  }
  if (expected.seq > 0) {
    const ledgerAt = recordAt(ledgerRecords, expected.seq);
    if (!ledgerAt || ledgerAt.hash !== expected.last_hash) {
      return { ok: false, anchored: true, reason: 'ledger_prefix_mismatch', last };
    }
  }
  // used 只能单调不减；把整链改成更小的 used 会在这里露馅。
  if ((ledgerState.used ?? 0) < (expected.used ?? 0)) {
    return { ok: false, anchored: true, reason: 'ledger_used_regressed', last };
  }

  const auditExpected = last?.audit;
  // 多个进程可能共享账本但各写各的审计（test/cross-process 就是这样）。
  // 锚绑定的是「写这条 checkpoint 的那个审计文件」；文件名不同就只校验账本，
  // 审计与账本的一致性仍由 Router.start 的 settled_used 对账负责。
  const auditMatches = !auditExpected?.file || !auditFile || auditExpected.file === auditFile;
  if (auditMatches && auditExpected && Number.isInteger(auditExpected.seq) && auditExpected.seq > 0) {
    const auditAt = recordAt(auditRecords, auditExpected.seq);
    if (!auditAt || auditAt.hash !== auditExpected.last_hash) {
      return { ok: false, anchored: true, reason: 'audit_prefix_mismatch', last };
    }
    if (Number.isFinite(auditExpected.settled_used) && auditSettled < auditExpected.settled_used) {
      return { ok: false, anchored: true, reason: 'audit_used_regressed', last };
    }
  }
  return { ok: true, anchored: true, last };
}

export class AnchorLog {
  constructor({
    file,
    now = () => new Date().toISOString(),
    pid = process.pid,
    lockTimeoutMs = 3000,
    lockRetryMs = 5,
    staleLockMs = 5000,
  } = {}) {
    if (!file) throw new Error('AnchorLog: file is required');
    this.file = file;
    this.now = now;
    this.pid = pid;
    this.lockPath = `${file}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.staleLockMs = staleLockMs;
  }

  read() {
    return readAnchor(this.file);
  }

  /** 崩溃留下的半行尾：截到最后一条完整记录。 */
  repairTail() {
    if (!fs.existsSync(this.file)) return { ok: true, repaired: false };
    return this.#withLock(() => {
      const text = fs.readFileSync(this.file, 'utf8');
      if (text.endsWith('\n') || text.length === 0) return { ok: true, repaired: false };
      const cut = text.lastIndexOf('\n');
      fs.truncateSync(this.file, cut + 1);
      return { ok: true, repaired: true };
    });
  }

  /** 追加一次 checkpoint；先验证已有锚链，链断则拒绝续写。 */
  seal({ ledger = {}, audit = {} } = {}) {
    return this.#withLock(() => {
      const read = this.read();
      if (read.chainBreaks.length > 0) {
        throw anchorError('E_LEDGER_TAMPERED', `anchor chain is broken (${read.chainBreaks.length} break(s))`);
      }
      if (read.badLines > 0) {
        throw anchorError('E_BUDGET_CORRUPT', `anchor has ${read.badLines} bad record(s)`);
      }
      const last = read.records[read.records.length - 1] ?? null;
      const record = {
        v: ANCHOR_VERSION,
        seq: (last?.seq ?? 0) + 1,
        ts: this.now(),
        prev_hash: last?.hash ?? ANCHOR_GENESIS,
        ledger: {
          seq: Number.isInteger(ledger.seq) ? ledger.seq : 0,
          last_hash: typeof ledger.lastHash === 'string' ? ledger.lastHash : ANCHOR_GENESIS,
          used: Number.isFinite(ledger.used) ? ledger.used : 0,
          reserved: Number.isFinite(ledger.reserved) ? ledger.reserved : 0,
        },
        audit: {
          file: typeof audit.file === 'string' ? audit.file : null,
          seq: Number.isInteger(audit.seq) ? audit.seq : 0,
          last_hash: typeof audit.lastHash === 'string' ? audit.lastHash : null,
          settled_used: Number.isFinite(audit.settledUsed) ? audit.settledUsed : 0,
          records: Number.isInteger(audit.records) ? audit.records : 0,
        },
      };
      record.hash = anchorRecordHash(record);
      const fd = fs.openSync(this.file, 'a');
      try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, seq: record.seq, hash: record.hash };
    });
  }

  #withLock(fn) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.#acquire();
    try {
      return fn();
    } finally {
      this.#release();
    }
  }

  #acquire() {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: this.pid, at: Date.now() }));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw anchorError('E_ANCHOR_LOCK', `cannot create anchor lock ${this.lockPath}: ${error.message}`);
        }
        if (this.#isStaleLock()) {
          try { fs.unlinkSync(this.lockPath); } catch { /* someone else won */ }
          continue;
        }
        if (Date.now() >= deadline) {
          throw anchorError('E_ANCHOR_LOCK', `timed out waiting for anchor lock ${this.lockPath}`);
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
      // 锁文件写了一半：按 mtime 判老。
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
}
