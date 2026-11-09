// audit.mjs — 追加式审计日志（JSONL，一行一条记录）
//
// 设计约束（对应 SPIKE.md 的「审计行格式」与「失败隔离」）：
//   1. 只追加，不重写；崩溃后文件仍可逐行解析。
//   2. 每条记录都有固定信封：v / seq / ts / run_id / kind，其余字段可选。
//   3. 每条记录带 CRC32（crc 字段），读取时可发现「被截断/篡改但仍能 JSON.parse」
//      的记录 —— 复核 P04 的根因是旧实现只跳过「解析不了」的行，截断记录被当成
//      合法数据静默丢掉，预算回放于是少算。
//   4. hash chain：每条记录带 prev_hash + hash（sha256），删中间整行 / 改字段 /
//      缺号都会在 readAudit() 的 chainBreaks 里暴露（复核 P0-4）。
//   5. seq 单调递增；重启时从所有轮转文件里续号，而不是从 1 重来。
//   6. 每次写都 fsync，保证「动作已发生」与「审计已落盘」尽可能同生共死。
//   7. 超过 maxBytes 时轮转：base -> .1 -> .2 ...（最多 maxRotations 个）。
//
// 这不是宿主日志服务的替代品：宿主里应同时写 ctx.logger，审计 jsonl 是给
// Router 自己回放/对账用的证据链。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const AUDIT_VERSION = 1;
export const AUDIT_GENESIS = '0'.repeat(64);
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_ROTATIONS = 5;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** 与 zlib.crc32 同算法的纯 JS 版本（避免依赖 zlib 版本差异）。 */
export function crc32(text) {
  const buffer = Buffer.from(String(text), 'utf8');
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** 记录内容 hash（不含 hash 字段本身）。 */
export function auditRecordHash(record) {
  const { hash: _ignored, ...rest } = record;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

/** 已存在的轮转文件，按 .1 .2 ... 顺序（.1 最新）。 */
export function rotatedPaths(file, maxRotations = DEFAULT_MAX_ROTATIONS) {
  const out = [];
  for (let i = 1; i <= maxRotations; i += 1) {
    const candidate = `${file}.${i}`;
    if (!fs.existsSync(candidate)) break;
    out.push(candidate);
  }
  return out;
}

function verifyRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  if (typeof raw.kind !== 'string' || raw.kind.length === 0) return { ok: false, reason: 'missing kind' };
  if (!Number.isInteger(raw.seq) || raw.seq <= 0) return { ok: false, reason: 'missing seq' };
  const crc = raw.crc;
  if (crc === undefined) {
    // 旧版审计没有 CRC：可以读，但标记为 unsigned，回放时不能证明完整性。
    const { crc: _ignored, ...rec } = raw;
    return { ok: true, rec, unsigned: true };
  }
  if (typeof crc !== 'string') return { ok: false, reason: 'bad crc type' };
  const { crc: _ignored, ...rec } = raw;
  const expected = crc32(JSON.stringify(rec));
  if (expected !== crc) return { ok: false, reason: `crc mismatch (expected ${expected}, got ${crc})` };
  return { ok: true, rec, unsigned: false };
}

/**
 * 校验审计 hash 链。纯函数。
 * 轮转文件被淘汰后，最早一条的 seq 可能不是 1：此时只要求「从它开始连续」，
 * 但保留它的 prev_hash 作为后续断链检测的锚。删中间整行 => seq gap + prev_hash
 * mismatch。
 *
 * @returns {{ok:boolean, signed:boolean, breaks:Array<{index:number,seq?:number,reason:string}>}}
 */
export function verifyAuditChain(records) {
  const breaks = [];
  const signed = records.some((rec) => rec && typeof rec === 'object' && typeof rec.hash === 'string');
  if (!signed) return { ok: true, signed: false, breaks };

  let expectedSeq = 0;
  let expectedPrev = AUDIT_GENESIS;
  for (let index = 0; index < records.length; index += 1) {
    const rec = records[index];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      breaks.push({ index, reason: 'not an object' });
      continue;
    }
    if (index === 0 && rec.seq !== 1) {
      // 更早的轮转文件已经不在了：以当前第一条为锚，不把「历史被轮转掉」误报成篡改。
      expectedSeq = Number.isInteger(rec.seq) ? rec.seq - 1 : 0;
      expectedPrev = typeof rec.prev_hash === 'string' ? rec.prev_hash : AUDIT_GENESIS;
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
    if (auditRecordHash(rec) !== rec.hash) {
      breaks.push({ index, seq: rec.seq, reason: 'hash mismatch' });
    }
    expectedSeq = rec.seq;
    expectedPrev = rec.hash;
  }
  return { ok: breaks.length === 0, signed: true, breaks };
}

/**
 * 读取一个审计文件（含轮转文件），返回
 * {records, badLines, truncated, tamperedLines, unsigned, badLineDetails, files, chainBreaks}。
 * 坏行/CRC 不匹配不抛异常；记录按轮转顺序（旧 -> 新）拼接。
 *
 * truncated：最后一行没有换行（写一半崩了），是可恢复的尾巴，不算篡改。
 * tamperedLines：能确认是「完整的一行但内容非法」——交给 Router 当 E_LEDGER_TAMPERED。
 */
export function readAudit(file, { maxRotations = DEFAULT_MAX_ROTATIONS } = {}) {
  const files = [...rotatedPaths(file, maxRotations).reverse(), file];
  const records = [];
  const badLineDetails = [];
  let badLines = 0;
  let unsigned = 0;
  let truncated = 0;
  let tamperedLines = 0;

  for (const current of files) {
    if (!fs.existsSync(current)) continue;
    let text;
    try {
      text = fs.readFileSync(current, 'utf8');
    } catch (error) {
      badLines += 1;
      tamperedLines += 1;
      badLineDetails.push({ file: current, line: 0, reason: `read: ${error.message}` });
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const isLastLine = i === lines.length - 1;
      const noNewline = isLastLine && !text.endsWith('\n');
      let raw;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        badLines += 1;
        if (noNewline) truncated += 1;
        else tamperedLines += 1;
        badLineDetails.push({ file: current, line: i + 1, reason: `json: ${error.message}` });
        continue;
      }
      const verdict = verifyRecord(raw);
      if (!verdict.ok) {
        badLines += 1;
        if (noNewline) truncated += 1;
        else tamperedLines += 1;
        badLineDetails.push({ file: current, line: i + 1, reason: verdict.reason });
        continue;
      }
      if (verdict.unsigned) unsigned += 1;
      records.push(verdict.rec);
    }
  }
  const chain = verifyAuditChain(records);
  return {
    records,
    badLines,
    truncated,
    tamperedLines,
    unsigned,
    badLineDetails,
    files,
    chainBreaks: chain.breaks,
    signed: chain.signed,
  };
}

export class AuditLog {
  /**
   * @param {object} options
   * @param {string} options.file      审计 jsonl 的绝对路径
   * @param {string} options.runId     本次运行的 id
   * @param {() => string} [options.now] 时钟（测试注入）
   * @param {number} [options.maxBytes] 单文件轮转阈值（默认 5 MiB）
   * @param {number} [options.maxRotations] 保留的轮转文件数
   */
  constructor({
    file,
    runId,
    now = () => new Date().toISOString(),
    maxBytes = DEFAULT_MAX_BYTES,
    maxRotations = DEFAULT_MAX_ROTATIONS,
  }) {
    if (!file) throw new Error('AuditLog: file is required');
    if (!runId) throw new Error('AuditLog: runId is required');
    this.file = file;
    this.runId = runId;
    this.now = now;
    this.maxBytes = maxBytes;
    this.maxRotations = maxRotations;
    this.fd = null;
    this.bytes = 0;
    this.seq = 1;
    this.lastHash = AUDIT_GENESIS;
    this.closed = false;
  }

  /**
   * 把崩溃留下的半行尾截掉；否则下一次 append 会把新记录粘在坏行后面。
   * @returns {number} 被丢弃的字节数（没有半行时为 0）
   */
  #repairTail() {
    if (!fs.existsSync(this.file)) return 0;
    const size = fs.statSync(this.file).size;
    if (size === 0) return 0;
    const fd = fs.openSync(this.file, 'r+');
    let dropped = 0;
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return 0;
      const text = fs.readFileSync(this.file, 'utf8');
      const index = text.lastIndexOf('\n');
      const keep = index + 1;
      dropped = size - keep;
      fs.ftruncateSync(fd, keep);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return dropped;
  }

  /** 打开文件并接上已有 seq/hash（重启续号，跨轮转文件）。 */
  open() {
    if (this.fd !== null) return this;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const droppedBytes = this.#repairTail();
    const { records } = readAudit(this.file, { maxRotations: this.maxRotations });
    const maxSeq = records.reduce((max, rec) => {
      return Number.isInteger(rec.seq) && rec.seq > max ? rec.seq : max;
    }, 0);
    this.seq = maxSeq + 1;
    const last = records[records.length - 1];
    this.lastHash = last && typeof last.hash === 'string' ? last.hash : AUDIT_GENESIS;
    this.fd = fs.openSync(this.file, 'a');
    this.bytes = fs.fstatSync(this.fd).size;
    this.closed = false;
    // F-03：截断半行必须留证据，否则「自动修」与「静默丢数据」无法区分。
    // 此时 fd 已打开，append 不会递归 open。
    if (droppedBytes > 0) {
      this.append('audit.repair', {
        bytes_dropped: droppedBytes,
        file: path.basename(this.file),
        reason: 'partial_tail',
      });
    }
    return this;
  }

  /** 把当前 base 轮转成 .1，并把旧的 .n 顺移一位。 */
  rotate() {
    if (this.fd !== null) {
      try { fs.fsyncSync(this.fd); } catch { /* ignore */ }
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    for (let i = this.maxRotations; i >= 1; i -= 1) {
      const source = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const target = `${this.file}.${i}`;
      if (!fs.existsSync(source)) continue;
      if (i === this.maxRotations && fs.existsSync(target)) fs.unlinkSync(target);
      fs.renameSync(source, target);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'a');
    this.bytes = 0;
  }

  /** 追加一条记录，返回写入的对象（含 prev_hash/hash/crc）。 */
  append(kind, data = {}) {
    if (this.closed) throw new Error('AuditLog: append after close');
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new Error('AuditLog: kind must be a non-empty string');
    }
    if (this.fd === null) this.open();
    const rec = {
      v: AUDIT_VERSION,
      seq: this.seq++,
      ts: this.now(),
      run_id: this.runId,
      kind,
      ...data,
      prev_hash: this.lastHash,
    };
    const hash = auditRecordHash(rec);
    const sealed = { ...rec, hash };
    const body = JSON.stringify(sealed);
    const crc = crc32(body);
    const line = `${body.slice(0, -1)},"crc":"${crc}"}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes > 0 && this.bytes + size > this.maxBytes) this.rotate();
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
    this.bytes += size;
    this.lastHash = hash;
    sealed.crc = crc;
    return sealed;
  }

  close() {
    if (this.fd !== null) {
      try { fs.fsyncSync(this.fd); } catch { /* 已关闭的文件描述符 */ }
      try { fs.closeSync(this.fd); } catch { /* 已关闭 */ }
      this.fd = null;
    }
    this.closed = true;
  }
}
