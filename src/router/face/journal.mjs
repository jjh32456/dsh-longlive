// routerFace v1 · 后台面自己的 journal（JSONL）。
//
// 这是「最近 5 条 router 自己的 journal」的唯一来源：仓库里原先没有
// router 服务自写的 journal 文件，v1 就把它定义成 face 自己的连续记忆。
//
// 幂等：每条记录带 tickKey（face-<day>-<tick 序号>）。同一个 tick 重复
// 追加时只保留第一条，崩溃重放或定时器抖动都不会写重。
//
// 永不抛错：读失败返回 []，写失败返回 {ok:false}，由调用方决定是否记失败。

import fs from 'node:fs';
import path from 'node:path';

export const JOURNAL_VERSION = 1;
export const JOURNAL_MAX_ROWS = 500;

function clean(value, maxChars = 0) {
  let text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxChars > 0) {
    const chars = Array.from(text);
    if (chars.length > maxChars) text = `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
  }
  return text;
}

function parseLines(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && typeof value.tickKey === 'string') out.push(value);
    } catch {
      // 坏行跳过；journal 不是审计账本，容忍单行损坏。
    }
  }
  return out;
}

function readAll(file) {
  try {
    return parseLines(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * 读最近 N 条（文件顺序的尾部，不按时间排序）。
 * @returns {Array<object>}
 */
export function readJournal(file, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 5;
  if (!file) return [];
  const rows = readAll(file);
  return rows.slice(-limit);
}

/** 该 tickKey 是否已经写过（幂等判据）。 */
export function hasJournalTick(file, tickKey) {
  if (!file || typeof tickKey !== 'string' || tickKey === '') return false;
  return readAll(file).some((row) => row.tickKey === tickKey);
}

function trimInPlace(file, maxRows) {
  try {
    const rows = readAll(file);
    if (rows.length <= maxRows) return;
    const kept = rows.slice(-maxRows);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 裁剪失败不影响主路径；下一次追加再试。
  }
}

/**
 * 追加一条 journal；同 tickKey 已存在时返回 {ok:true, appended:false, duplicate:true}。
 *
 * @param {string} file
 * @param {object} entry 至少含 tickKey / at / text
 * @param {{maxRows?:number}} [options]
 */
export function appendJournalOnce(file, entry, options = {}) {
  if (!file) return { ok: false, error: 'E_NO_JOURNAL_FILE' };
  const tickKey = clean(entry?.tickKey, 120);
  if (tickKey === '') return { ok: false, error: 'E_NO_TICK_KEY' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = readAll(file);
    if (rows.some((row) => row.tickKey === tickKey)) {
      return { ok: true, appended: false, duplicate: true };
    }
    const record = {
      v: JOURNAL_VERSION,
      tickKey,
      at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
      day: clean(entry.day, 20),
      text: clean(entry.text, 1200),
      kind: clean(entry.kind, 40) || 'tick',
      ...(Array.isArray(entry.suggestions) ? { suggestions: entry.suggestions.slice(0, 10) } : {}),
      ...(entry.usage && typeof entry.usage === 'object' ? { usage: entry.usage } : {}),
      ...(entry.provider ? { provider: clean(entry.provider, 80) } : {}),
      ...(entry.model ? { model: clean(entry.model, 120) } : {}),
      ...(entry.dryRun === true ? { dryRun: true } : {}),
    };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    trimInPlace(file, Number.isInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : JOURNAL_MAX_ROWS);
    return { ok: true, appended: true, record };
  } catch (error) {
    return { ok: false, error: error?.code ?? 'E_JOURNAL_WRITE', message: String(error?.message ?? error) };
  }
}

export { clean };
