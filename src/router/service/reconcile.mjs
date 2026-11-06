// 日窗口预算扫描 + 账本/审计对账（DESIGN §6.3、§7.4）。
//
// 对账口径：同一个 run 里，审计的 budget.settle 总和与账本结算总和必须一致。
// 审计少（崩溃窗口）→ 写 audit.reconcile，以账本为准继续（QUESTIONS Q4）；
// 审计多（凭空多出结算）→ E_LEDGER_TAMPERED，不自动修。
//
// 能力边界：账本、审计、锚都在同一个用户可写目录里。这里的校验能发现崩溃残留、
// 误删、回滚和代码 bug，但同用户蓄意同时重写三者仍然无法防御。

import fs from 'node:fs';
import path from 'node:path';

import { foldRecords, readLedger } from '../background/budget-ledger.mjs';

export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function recordDay(record, fallbackMs) {
  const ts = typeof record?.ts === 'string' ? Date.parse(record.ts) : NaN;
  if (Number.isFinite(ts)) return dayKey(new Date(ts));
  const fallback = Number.isFinite(fallbackMs) ? fallbackMs : Date.now();
  return dayKey(new Date(fallback));
}

function listRunDirs(vaultDir) {
  const runsDir = path.join(vaultDir, 'runs');
  let entries = [];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ runId: entry.name, dir: path.join(runsDir, entry.name) }))
    .sort((a, b) => a.runId.localeCompare(b.runId));
}

/**
 * 扫描 runs 目录下各 run 的 budget.ledger.jsonl，得到今天已用与仍在有效期内的预留。
 * 账本记录本身没有 ts 字段（复用 0.9.0 的 BudgetLedger），所以按文件 mtime 归日；
 * 如果记录将来带上 ts，优先用 ts。这个限制写进 REPORT。
 *
 * @param {{vaultDir:string, day?:string, statusTodayUsed?:number, now?:Date}} options
 */
export function scanDayUsage(options = {}) {
  const vaultDir = typeof options.vaultDir === 'string' ? options.vaultDir : '';
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const day = typeof options.day === 'string' && options.day !== '' ? options.day : dayKey(now);
  const statusUsed = Number.isFinite(options.statusTodayUsed) ? Math.max(0, options.statusTodayUsed) : 0;
  let settledToday = 0;
  let reservedToday = 0;
  let tampered = false;
  const runs = [];
  const nowMs = now.getTime();

  for (const entry of listRunDirs(vaultDir)) {
    const ledgerFile = path.join(entry.dir, 'budget.ledger.jsonl');
    if (!fs.existsSync(ledgerFile)) continue;
    let mtimeMs = nowMs;
    try { mtimeMs = fs.statSync(ledgerFile).mtimeMs; } catch { /* ignore */ }
    const read = readLedger(ledgerFile);
    const folded = foldRecords(read.records);
    if (read.badLines > 0 || read.chainBreaks.length > 0 || folded.badLines > 0) tampered = true;

    let runSettled = 0;
    for (const rec of read.records) {
      if (!rec || rec.op !== 'settle' || !Number.isFinite(Number(rec.tokens))) continue;
      if (recordDay(rec, mtimeMs) === day) runSettled += Number(rec.tokens);
    }
    let runReserved = 0;
    for (const active of folded.active.values()) {
      const lease = active.leaseExpiresAt;
      if (Number.isFinite(lease) && lease <= nowMs) continue;
      const started = active.startedAt ? Date.parse(active.startedAt) : mtimeMs;
      if (dayKey(new Date(Number.isFinite(started) ? started : mtimeMs)) === day) {
        runReserved += active.tokens;
      }
    }
    settledToday += runSettled;
    reservedToday += runReserved;
    runs.push({
      runId: entry.runId,
      used: folded.used,
      reserved: folded.reserved,
      settledToday: runSettled,
      reservedToday: runReserved,
      records: read.records.length,
      seq: folded.seq,
      lastHash: folded.lastHash,
      badLines: read.badLines + folded.badLines,
      chainBreaks: read.chainBreaks.length,
    });
  }

  const used = Math.max(settledToday, statusUsed);
  return {
    day,
    used,
    reserved: reservedToday,
    scannedSettled: settledToday,
    statusUsed,
    tampered,
    runs,
    clockRegression: statusUsed > settledToday,
  };
}

function sumAuditSettled(auditRecords, runId) {
  let total = 0;
  for (const rec of Array.isArray(auditRecords) ? auditRecords : []) {
    if (!rec || rec.run_id !== runId || rec.kind !== 'budget.settle') continue;
    const tokens = Number(rec.tokens);
    if (Number.isFinite(tokens) && tokens >= 0) total += tokens;
  }
  return total;
}

/**
 * 对账一个 run。返回 {ok, code?, delta, ledgerUsed, auditSettled, reconciled}。
 * 不写文件；调用方决定是否把 audit.reconcile 追加进审计链。
 */
export function reconcileRun({ runId, ledgerFile, auditRecords }) {
  const read = readLedger(ledgerFile);
  const folded = foldRecords(read.records);
  if (read.badLines > 0 || read.chainBreaks.length > 0 || folded.badLines > 0) {
    return {
      ok: false,
      code: 'E_LEDGER_TAMPERED',
      runId,
      ledgerUsed: folded.used,
      auditSettled: sumAuditSettled(auditRecords, runId),
      delta: 0,
    };
  }
  const ledgerUsed = folded.used;
  const auditSettled = sumAuditSettled(auditRecords, runId);
  if (auditSettled > ledgerUsed) {
    return { ok: false, code: 'E_LEDGER_TAMPERED', runId, ledgerUsed, auditSettled, delta: auditSettled - ledgerUsed };
  }
  const delta = ledgerUsed - auditSettled;
  return {
    ok: true,
    runId,
    ledgerUsed,
    auditSettled,
    delta,
    reconciled: delta > 0,
    ledgerSeq: folded.seq,
    ledgerLastHash: folded.lastHash,
  };
}

/**
 * 启动时对账所有历史 run，并把崩溃窗口写成 audit.reconcile。
 * @param {{vaultDir:string, audit:object, auditRecords:Array}} options
 */
export function reconcileRuns(options = {}) {
  const vaultDir = typeof options.vaultDir === 'string' ? options.vaultDir : '';
  const audit = options.audit;
  const results = [];
  for (const entry of listRunDirs(vaultDir)) {
    const ledgerFile = path.join(entry.dir, 'budget.ledger.jsonl');
    if (!fs.existsSync(ledgerFile)) continue;
    const result = reconcileRun({ runId: entry.runId, ledgerFile, auditRecords: options.auditRecords });
    if (!result.ok) return { ok: false, code: result.code, results, failure: result };
    if (result.reconciled && audit) {
      try {
        audit.append('audit.reconcile', {
          run_id: result.runId,
          delta: result.delta,
          ledger_seq: result.ledgerSeq,
          ledger_used: result.ledgerUsed,
          audit_settled: result.auditSettled,
        });
      } catch (error) {
        return { ok: false, code: 'E_AUDIT_WRITE', results, failure: { ...result, error } };
      }
    }
    results.push(result);
  }
  return { ok: true, results };
}

/**
 * 校验历史 run 的锚。没有账本记录的 run 不要求锚；有记录但缺锚 -> E_ANCHOR_MISSING
 * （除非 allowMissingAnchor）。这里只做「锚 <= 当前」的单调校验，细节交给 verifyAnchor。
 *
 * @param {{vaultDir:string, auditRecords:Array, auditFile:string, allowMissingAnchor?:boolean, verifyAnchor:Function}} options
 */
export function verifyRunAnchors(options = {}) {
  const vaultDir = typeof options.vaultDir === 'string' ? options.vaultDir : '';
  const auditRecords = Array.isArray(options.auditRecords) ? options.auditRecords : [];
  const auditFile = typeof options.auditFile === 'string' ? path.basename(options.auditFile) : null;
  const verifyAnchor = options.verifyAnchor;
  const results = [];

  for (const entry of listRunDirs(vaultDir)) {
    const ledgerFile = path.join(entry.dir, 'budget.ledger.jsonl');
    if (!fs.existsSync(ledgerFile)) continue;
    const ledger = readLedger(ledgerFile);
    const folded = foldRecords(ledger.records);
    if (ledger.records.length === 0) continue;
    const anchorFile = path.join(entry.dir, 'anchor.jsonl');
    if (!fs.existsSync(anchorFile)) {
      if (options.allowMissingAnchor === true) {
        results.push({ runId: entry.runId, ok: true, anchored: false, reason: 'anchor_missing_allowed' });
        continue;
      }
      return {
        ok: false,
        code: 'E_ANCHOR_MISSING',
        results,
        failure: { runId: entry.runId, reason: 'anchor_missing' },
      };
    }
    const anchorRead = fs.existsSync(anchorFile)
      ? options.readAnchor(anchorFile)
      : { records: [], badLines: 0, chainBreaks: [] };
    if (anchorRead.badLines > 0 || anchorRead.chainBreaks.length > 0) {
      return {
        ok: false,
        code: 'E_LEDGER_TAMPERED',
        results,
        failure: { runId: entry.runId, reason: 'anchor_corrupt' },
      };
    }
    const auditSettled = auditRecords
      .filter((rec) => rec && rec.run_id === entry.runId && rec.kind === 'budget.settle')
      .reduce((sum, rec) => sum + (Number(rec.tokens) || 0), 0);
    const verdict = verifyAnchor(anchorRead.records, {
      ledgerRecords: ledger.records,
      ledgerState: { seq: folded.seq, used: folded.used },
      auditRecords,
      auditSettled,
      auditFile,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        code: 'E_LEDGER_TAMPERED',
        results,
        failure: { runId: entry.runId, reason: verdict.reason, anchor: verdict.last },
      };
    }
    results.push({ runId: entry.runId, ok: true, anchored: verdict.anchored, reason: verdict.reason });
  }
  return { ok: true, results };
}
