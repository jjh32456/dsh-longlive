// answer/store.js — 生成后审计的落盘与查询。
//
// 审计文件固定落在 `<memoryRoot>/.longlive/answer-audit/audit.jsonl`：一行一轮，
// 只追加、不改助手正文。写失败只返回 {ok:false}，调用方 fail-open。
//
// 轮转：文件超过 maxBytes 时先把现有文件改名为 `answer-audit/audit.1.jsonl`
// （覆盖上一份 .1），再继续追加。审计是证据不是账本，保留最近两份足够。

import fs from 'node:fs';
import path from 'node:path';

import { appendJsonLine, withFileLock } from '../util/append-store.js';
import { scrubJsonValue, redactionMetadata } from '../util/redact.js';

export const AUDIT_DIRNAME = '.longlive';
export const AUDIT_FILENAME = 'answer-audit/audit.jsonl';
export const AUDIT_MAX_BYTES_DEFAULT = 2 * 1024 * 1024;
/** S1: 审计行默认 TTL 元数据（删除执行归 S5 retention，本层只标注）。 */
export const AUDIT_RETENTION_DAYS_DEFAULT = 30;

export function auditFilePath(memoryRoot) {
  if (typeof memoryRoot !== 'string' || memoryRoot.trim() === '') return '';
  return path.join(memoryRoot, AUDIT_DIRNAME, AUDIT_FILENAME);
}

/**
 * 追加一行审计。永远不抛。
 *
 * S1 追加纪律：单写锁 + fsync + 坏行隔离（append-store）+ 写入前凭据 scrub。
 * scrub 后仍保留审计用途：`redaction.originalSha256` / `originalLength` / `hits`
 * 与 `retentionDays` + `retainUntil` 元数据；原文不落盘。
 *
 * @param {string} memoryRoot
 * @param {object} row
 * @param {{maxBytes?:number, redact?:boolean, retentionDays?:number, now?:Function}} [options]
 * @returns {{ok:boolean,path:string,rotated?:boolean,code?:string,error?:string}}
 */
export function appendAuditRow(memoryRoot, row, options = {}) {
  const file = auditFilePath(memoryRoot);
  if (file === '') return { ok: false, path: '', code: 'E_NO_MEMORY_ROOT', error: 'E_NO_MEMORY_ROOT' };
  const maxBytes = Number.isFinite(Number(options.maxBytes))
    ? Math.max(64 * 1024, Number(options.maxBytes))
    : AUDIT_MAX_BYTES_DEFAULT;
  const retentionDays = Number.isInteger(Number(options.retentionDays)) && Number(options.retentionDays) > 0
    ? Number(options.retentionDays)
    : AUDIT_RETENTION_DAYS_DEFAULT;
  const at = row && typeof row === 'object' && typeof row.at === 'string' ? row.at : new Date().toISOString();
  const redact = options.redact !== false;
  // 先 scrub（只改字符串叶子，不改行结构），再补审计元数据。
  const scrubbed = scrubJsonValue(row && typeof row === 'object' ? row : { value: row }, { enabled: redact });
  const auditRow = scrubbed.value && typeof scrubbed.value === 'object' && !Array.isArray(scrubbed.value)
    ? { ...scrubbed.value }
    : { value: scrubbed.value };
  const meta = redactionMetadata(scrubbed, { retentionDays, at });
  auditRow.redaction = meta;
  auditRow.retentionDays = retentionDays;
  auditRow.retainUntil = meta.retainUntil;

  const write = () => {
    let rotated = false;
    try {
      const stat = fs.statSync(file);
      if (stat.size >= maxBytes) {
        fs.renameSync(file, `${file.replace(/\.jsonl$/u, '')}.1.jsonl`);
        rotated = true;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const written = appendJsonLine({
      file,
      row: auditRow,
      label: 'answer-audit',
      skipLock: true,
      healthRoot: memoryRoot,
      now: options.now,
      quarantineDir: path.join(path.resolve(String(memoryRoot)), '.longlive', 'quarantine'),
    });
    return { written, rotated };
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 轮转 + 追加在同一个 per-file 锁内完成，避免两个进程同时 rename/append。
    const locked = withFileLock(file, write, { waitMs: 2_000 });
    if (!locked.ok) {
      return { ok: false, path: file, code: locked.code ?? 'E_APPEND_LOCKED', error: locked.error?.message ?? locked.code ?? 'E_APPEND_LOCKED' };
    }
    const { written, rotated } = locked.value;
    if (!written.ok) {
      return { ok: false, path: file, code: written.code ?? 'E_APPEND_IO', error: written.error?.message ?? written.code ?? 'E_APPEND_IO', rotated };
    }
    return { ok: true, path: file, rotated };
  } catch (error) {
    return { ok: false, path: file, code: error?.code ?? 'E_APPEND_IO', error: String(error?.message ?? error) };
  }
}

/**
 * 读审计行，按筛选条件过滤。永远不抛；坏行跳过并计入 corrupt。
 *
 * @param {string} memoryRoot
 * @param {{limit?:number,sessionId?:string,turn?:number,verdict?:string,code?:string,
 *          since?:string,newestFirst?:boolean}} [filter]
 * @returns {{ok:boolean,path:string,total:number,matched:number,corrupt:number,
 *            byVerdict:object,byCode:object,sessions:string[],rows:object[],error?:string}}
 */
export function readAuditRows(memoryRoot, filter = {}) {
  const file = auditFilePath(memoryRoot);
  const empty = {
    ok: false,
    path: file,
    total: 0,
    matched: 0,
    corrupt: 0,
    byVerdict: {},
    byCode: {},
    sessions: [],
    rows: [],
  };
  if (file === '') return { ...empty, error: 'E_NO_MEMORY_ROOT' };

  let text;
  try {
    const rotated = file.replace(/\.jsonl$/u, '.1.jsonl');
    let older = '';
    let current = '';
    try {
      older = fs.readFileSync(rotated, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (older === '') return { ...empty, ok: true, error: 'E_NO_AUDIT_FILE' };
    }
    text = `${older}\n${current}`;
  } catch (error) {
    return { ...empty, error: String(error?.code ?? error?.message ?? error) };
  }

  const limit = Number.isFinite(Number(filter.limit)) ? Math.max(1, Math.min(500, Number(filter.limit))) : 50;
  const wantSession = typeof filter.sessionId === 'string' ? filter.sessionId.trim() : '';
  const wantTurn = Number.isFinite(Number(filter.turn)) ? Number(filter.turn) : null;
  const wantVerdict = typeof filter.verdict === 'string' ? filter.verdict.trim() : '';
  const wantCode = typeof filter.code === 'string' ? filter.code.trim() : '';
  const since = typeof filter.since === 'string' && filter.since.trim() !== '' ? Date.parse(filter.since) : null;

  const rows = [];
  const byVerdict = {};
  const byCode = {};
  const sessions = new Set();
  let total = 0;
  let corrupt = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    total += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    if (!row || typeof row !== 'object') {
      corrupt += 1;
      continue;
    }
    if (row.sessionId) sessions.add(String(row.sessionId));
    byVerdict[row.verdict ?? 'unknown'] = (byVerdict[row.verdict ?? 'unknown'] ?? 0) + 1;
    for (const flag of Array.isArray(row.flags) ? row.flags : []) {
      const code = String(flag?.code ?? 'UNKNOWN');
      byCode[code] = (byCode[code] ?? 0) + 1;
    }
    if (wantSession !== '' && String(row.sessionId ?? '') !== wantSession) continue;
    if (wantTurn !== null && Number(row.turn) !== wantTurn) continue;
    if (wantVerdict !== '' && String(row.verdict ?? '') !== wantVerdict) continue;
    if (wantCode !== '' && !(Array.isArray(row.flags) ? row.flags : []).some((flag) => String(flag?.code ?? '') === wantCode)) continue;
    if (since !== null && Number.isFinite(since)) {
      const at = Date.parse(String(row.at ?? ''));
      if (!Number.isFinite(at) || at < since) continue;
    }
    rows.push(row);
  }

  const newestFirst = filter.newestFirst !== false;
  if (newestFirst) rows.reverse();
  const matched = rows.length;
  return {
    ok: true,
    path: file,
    total,
    matched,
    corrupt,
    byVerdict,
    byCode,
    sessions: [...sessions].sort(),
    rows: rows.slice(0, limit),
  };
}

/** 审计行里是否含「编引用/编数字/编执行」。 */
export function hasFabrication(row) {
  return (Array.isArray(row?.flags) ? row.flags : []).some((flag) => flag?.severity === 'fabrication');
}

/**
 * 四指标口径（只统计已有审计行，不推断未审计的轮）。
 * @param {object[]} rows
 */
export function auditMetrics(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const flagged = list.filter((row) => row?.verdict === 'flagged').length;
  const fabrication = list.filter(hasFabrication).length;
  const unsupported = list.filter((row) => (Array.isArray(row?.flags) ? row.flags : []).some((flag) => flag?.severity === 'unsupported')).length;
  return {
    turns: total,
    clean: total - flagged,
    flagged,
    fabrication,
    unsupported,
    flaggedRate: total === 0 ? 0 : Number((flagged / total).toFixed(4)),
    fabricationRate: total === 0 ? 0 : Number((fabrication / total).toFixed(4)),
  };
}

// 1.8.0 合并：生成后审计的纯函数（从 answer-guard core 单源导出，供 query/index 使用）。
export {
  auditTurn,
  buildAuditRow,
  composeAuditContext,
  tailTextParts,
  isFabricationRow,
  AUDIT_CONTEXT_MARKER,
} from './guard.js';
