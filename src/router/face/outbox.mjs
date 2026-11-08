// routerFace v1 · 跨会话通道（bridge）。
//
// 后台面只能把话写进 `<root>/.longlive/bridge/router-outbox.jsonl`；
// 前台 hint 读到「最近 1 条未读」，渲染后写回该行的 readAt。
// 通道只是文件，不注入会话历史、不触发任何工具、不调度任何执行。
//
// 行格式（应答任务书的字段，额外带 v/id/readAt 以便标记已读）：
//   { "v":1, "id":"<sha1 前 12>", "at":"ISO", "sessionHint":"root",
//     "text":"≤300 字", "kind":"suggestion", "readAt":null }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FACE_MAX_HINT_CHARS } from './config.mjs';

export const OUTBOX_VERSION = 1;
export const OUTBOX_MAX_ROWS = 200;
export const BRIDGE_TEXT_MAX_CHARS = FACE_MAX_HINT_CHARS;

function clean(value, maxChars) {
  let text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (typeof maxChars === 'number' && maxChars > 0) {
    const chars = Array.from(text);
    if (chars.length > maxChars) text = `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
  }
  return text;
}

function hashId(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 12);
}

function readRows(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && typeof value.text === 'string') rows.push(value);
    } catch {
      // 坏行忽略：bridge 是通知通道，不做校验器。
    }
  }
  return rows;
}

function writeRows(file, rows) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 写一条后台留话。返回 {ok, id, duplicate}。
 * 同一个 (kind,text,at 分钟) 不重复写：防止定时器抖动刷屏。
 */
export function appendOutbox(file, entry, options = {}) {
  if (!file) return { ok: false, error: 'E_NO_OUTBOX_FILE' };
  const text = clean(entry?.text, Number.isInteger(options.maxChars) ? options.maxChars : BRIDGE_TEXT_MAX_CHARS);
  if (text === '') return { ok: false, error: 'E_EMPTY_TEXT' };
  const at = typeof entry?.at === 'string' && entry.at !== '' ? entry.at : new Date().toISOString();
  const kind = clean(entry?.kind, 40) || 'suggestion';
  const sessionHint = clean(entry?.sessionHint, 80) || 'root';
  const id = clean(entry?.id, 64) || hashId(`${kind}\n${sessionHint}\n${text}\n${at.slice(0, 16)}`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = readRows(file);
    if (rows.some((row) => row.id === id)) return { ok: true, added: false, duplicate: true, id };
    const record = { v: OUTBOX_VERSION, id, at, sessionHint, text, kind, readAt: null };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    if (rows.length + 1 > OUTBOX_MAX_ROWS) {
      writeRows(file, readRows(file).slice(-OUTBOX_MAX_ROWS));
    }
    return { ok: true, added: true, id, record };
  } catch (error) {
    return { ok: false, error: error?.code ?? 'E_OUTBOX_WRITE', message: String(error?.message ?? error) };
  }
}

/** 读全部（或尾部 limit 条），永不抛。 */
export function readOutbox(file, options = {}) {
  if (!file) return [];
  const rows = readRows(file);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
  return limit > 0 ? rows.slice(-limit) : rows;
}

/** 最近一条未读；读不到返回 null。 */
export function readLatestUnread(file) {
  const rows = readRows(file);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].readAt === null || rows[i].readAt === undefined) return rows[i];
  }
  return null;
}

/**
 * 标记已读：整文件读-改-写（bridge 很小，v1 接受这个代价）。
 * 找不到 id / 写失败都返回 ok:false，由前台忽略。
 */
export function markRead(file, id, options = {}) {
  if (!file || typeof id !== 'string' || id === '') return { ok: false, error: 'E_NO_ID' };
  const at = typeof options.at === 'string' && options.at !== '' ? options.at : new Date().toISOString();
  try {
    const rows = readRows(file);
    let found = false;
    for (const row of rows) {
      if (row.id === id && (row.readAt === null || row.readAt === undefined)) {
        row.readAt = at;
        found = true;
      }
    }
    if (!found) return { ok: false, error: 'E_NOT_FOUND' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeRows(file, rows);
    return { ok: true, id, readAt: at };
  } catch (error) {
    return { ok: false, error: error?.code ?? 'E_OUTBOX_WRITE', message: String(error?.message ?? error) };
  }
}

/**
 * 渲染给前台 hint 的一行。≤300 字，且中和提示信封标记，防止后台文本
 * 伪造「【提示结束】」。
 */
export function renderBridgeHint(entry, options = {}) {
  if (!entry || typeof entry.text !== 'string') return '';
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? Math.min(options.maxChars, BRIDGE_TEXT_MAX_CHARS)
    : BRIDGE_TEXT_MAX_CHARS;
  const text = clean(entry.text, maxChars)
    .replace(/【/gu, '［')
    .replace(/】/gu, '］');
  if (text === '') return '';
  const when = localClock(entry.at);
  return `后台留话${when ? `（${when}）` : ''}：${text}`;
}

function localClock(value) {
  if (typeof value !== 'string' || value === '') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
