// src/autoprocedure/session-reader.js — 异步采样原语（F3/N5）。
//
// 本模块只在 setTimeout 的异步 drain 里被调用，绝不在 `session/event` 回调里：
//   * 解压上限可配（autoProcedure.maxDecompressBytes，默认 8 MiB，硬上限
//     64 MiB），超限抛 E_AP_SAMPLE_TOO_BIG → reject too_big；
//   * MAJ-2/D7：解压后文本超过上限时，不再整包失败，而是退化为「尾段窗口」
//     解析——用 codec.zstdFrameLength 只扫帧边界（不解压），从最后一帧向前
//     逐帧解压，累计 ≤ 上限为止；目标 turn 是刚结束的最后一轮，必然落在尾段。
//     只有单帧本身就超过上限时才继续抛 TOO_BIG；
//   * 任何不可读/非 JSON/seq 不连续 → E_AP_SAMPLE_PARSE → reject parse（重试 ≤1）；
//   * 每一行记录「解压文本的 UTF-8 字节偏移」，供证据 excerptOffset/excerptLen
//     使用（offsetSpace = utf8-bytes-decompressed-session，见 N5）。整包解析时
//     偏移从文件起点算；尾段解析时是尾段文本内的偏移——校验侧会先做精确匹配，
//     失败后在 turn 内按「同长度 + 同 sha256」重定位，因此两种解析都能通过；
//   * 只读会话日志，绝不改写。
//
// turnDigest 的锚定口径复用 src/memory/anchors.js#turnDigest（投影掉 seq/turn 等
// 会因截断重排的坐标），所以会话被 session_truncate_visible 重排 seq 后 digest
// 仍然可重算一致。

import crypto from 'node:crypto';
import fs from 'node:fs';

import { decompressFrame, splitFrames, zstdFrameLength } from '../codec.js';
import { findSessionFile } from '../auto-truncate.js';
import { turnDigest, turnWindowOf } from '../memory/anchors.js';
import { AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES } from './config.js';

export const SAMPLE_CODES = Object.freeze({
  MISSING: 'E_AP_SAMPLE_MISSING',
  PARSE: 'E_AP_SAMPLE_PARSE',
  TOO_BIG: 'E_AP_SAMPLE_TOO_BIG',
  TURN: 'E_AP_SAMPLE_TURN',
});

export class AutoProcedureSampleError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'AutoProcedureSampleError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(text) ? text : String(text ?? ''), 'utf8').digest('hex');
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * Decompress a session log with a hard cap on DECOMPRESSED bytes.
 * A frame that would push the total past the cap aborts immediately.
 */
export function decompressSessionCapped(buf, maxBytes = AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES) {
  let frames;
  try {
    frames = splitFrames(buf);
  } catch (error) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, `会话帧结构损坏：${error?.message ?? error}`);
  }
  let totalBytes = 0;
  const texts = [];
  for (const frame of frames) {
    let text;
    try {
      text = decompressFrame(buf.subarray(frame.start, frame.end));
    } catch (error) {
      throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, `会话帧解压失败：${error?.message ?? error}`);
    }
    totalBytes += byteLength(text);
    if (totalBytes > maxBytes) {
      throw new AutoProcedureSampleError(SAMPLE_CODES.TOO_BIG, `会话解压后超过 ${maxBytes} 字节（too_big）`, {
        maxBytes,
        frames: frames.length,
      });
    }
    texts.push(text);
  }
  return { text: texts.join(''), frames: frames.length, bytes: totalBytes };
}

/**
 * Walk the zstd frame structure WITHOUT decompressing payloads (D7).
 * Cheap enough to run on a 60 MB log: only frame headers are parsed.
 * @returns {Array<{start:number,end:number}>}
 */
export function scanFrameSpans(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, '会话文件为空');
  }
  const spans = [];
  let start = 0;
  try {
    while (start < buf.length) {
      const end = zstdFrameLength(buf, start);
      if (!Number.isInteger(end) || end <= start || end > buf.length) {
        throw new Error(`bad frame length at ${start}: ${String(end)}`);
      }
      spans.push({ start, end });
      start = end;
    }
  } catch (error) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, `会话帧结构损坏：${error?.message ?? error}`);
  }
  if (spans.length === 0) throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, '会话没有可读帧');
  return spans;
}

function decompressSpan(buf, span) {
  try {
    return decompressFrame(buf.subarray(span.start, span.end));
  } catch (error) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, `会话帧解压失败：${error?.message ?? error}`);
  }
}

/**
 * Split decompressed session text into non-empty lines with byte offsets.
 * `start`/`end` are UTF-8 byte offsets into the provided decompressed text.
 */
export function indexSessionLines(text) {
  const records = [];
  let offset = 0;
  for (const line of String(text ?? '').split('\n')) {
    const length = byteLength(line);
    if (line !== '') records.push({ text: line, start: offset, end: offset + length });
    offset += length + 1; // the '\n' the split consumed
  }
  return records;
}

function parseEventLines(lines, baseSeq) {
  const events = [];
  // Sparse array: index === event.seq, so downstream lookups by seq keep working
  // for a tail window whose seqs start above 0 (D7).
  const eventLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index].text);
    } catch (error) {
      throw new AutoProcedureSampleError(
        SAMPLE_CODES.PARSE,
        `事件行不是 JSON（base seq ${baseSeq} + ${index}）：${error?.message ?? error}`,
      );
    }
    const expected = baseSeq + index;
    if (event?.seq !== expected) {
      throw new AutoProcedureSampleError(
        SAMPLE_CODES.PARSE,
        `事件 seq 不连续：index ${index} 的 seq=${JSON.stringify(event?.seq)}，期望 ${expected}`,
      );
    }
    events.push(event);
    eventLines[event.seq] = lines[index];
  }
  return { events, eventLines };
}

function parseFull(buf, spans, maxBytes) {
  const texts = [];
  let totalBytes = 0;
  for (const span of spans) {
    const text = decompressSpan(buf, span);
    totalBytes += byteLength(text);
    if (totalBytes > maxBytes) {
      throw new AutoProcedureSampleError(SAMPLE_CODES.TOO_BIG, `会话解压后超过 ${maxBytes} 字节（too_big）`, {
        maxBytes,
        frames: spans.length,
      });
    }
    texts.push(text);
  }
  const fullText = texts.join('');
  const lines = indexSessionLines(fullText);
  if (lines.length === 0) throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, '会话为空');
  let header;
  try {
    header = JSON.parse(lines[0].text);
  } catch (error) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, `会话头不是 JSON：${error?.message ?? error}`);
  }
  if (header?.type !== 'session') {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, '会话第一行不是 session 头');
  }
  const { events, eventLines } = parseEventLines(lines.slice(1), 0);
  return { header, events, lines, eventLines, bytes: totalBytes, frames: spans.length, tail: false, baseSeq: 0 };
}

/**
 * D7 tail window: decompress whole frames from the end until the cap is reached.
 * The just-completed turn lives at the end of the log, so the tail always covers
 * it; a single frame bigger than the cap is the only remaining too_big case.
 */
function parseTail(buf, spans, maxBytes) {
  const pieces = [];
  let totalBytes = 0;
  let frameBytes = 0;
  for (let index = spans.length - 1; index >= 1; index -= 1) {
    const span = spans[index];
    let text;
    try {
      text = decompressSpan(buf, span);
    } catch (error) {
      if (pieces.length === 0) throw error;
      break;
    }
    frameBytes = byteLength(text);
    if (totalBytes + frameBytes > maxBytes) {
      if (pieces.length === 0) {
        throw new AutoProcedureSampleError(SAMPLE_CODES.TOO_BIG, `最后一帧解压后超过 ${maxBytes} 字节（too_big）`, {
          maxBytes,
          frames: spans.length,
          frameBytes,
        });
      }
      break;
    }
    pieces.unshift(text);
    totalBytes += frameBytes;
  }
  if (pieces.length === 0) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.TOO_BIG, `会话没有可采样的尾段（too_big）`, {
      maxBytes,
      frames: spans.length,
    });
  }
  const tailText = pieces.join('');
  const lines = indexSessionLines(tailText);
  if (lines.length === 0) throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, '会话尾段没有事件');
  // We do not know the absolute startSeq in advance; the first event line carries
  // it, and contiguity is enforced from there.
  let baseSeq = null;
  try {
    const first = JSON.parse(lines[0].text);
    baseSeq = Number.isInteger(first?.seq) ? first.seq : null;
  } catch (error) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, `尾段首行不是 JSON：${error?.message ?? error}`);
  }
  if (baseSeq === null || baseSeq < 0) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, '尾段首事件没有合法 seq');
  }
  const { events, eventLines } = parseEventLines(lines, baseSeq);
  return {
    header: null,
    events,
    lines,
    eventLines,
    bytes: totalBytes,
    frames: spans.length,
    tail: true,
    baseSeq,
  };
}

/**
 * Parse a session log buffer into header + events + byte-indexed lines.
 * Does not look at any turn yet; that is findTurnSample's job.
 *
 * Whole-file parsing is tried first (cheap for normal logs). When the decompressed
 * size would exceed `maxBytes`, the tail window is parsed instead (D7) instead of
 * failing with too_big.
 */
export function parseSessionBuffer(buf, { maxBytes = AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES } = {}) {
  const cap = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES;
  const spans = scanFrameSpans(buf);
  try {
    return parseFull(buf, spans, cap);
  } catch (error) {
    if (!(error instanceof AutoProcedureSampleError) || error.code !== SAMPLE_CODES.TOO_BIG) throw error;
    return parseTail(buf, spans, cap);
  }
}

/**
 * Locate the requested turn: seq window + byte window + per-event line records.
 * Returns null when the turn is not in the log (caller counts it as a sample miss).
 */
export function findTurnSample(parsed, turn) {
  if (!Number.isInteger(turn) || turn < 1) return null;
  const window = turnWindowOf(parsed.events, turn);
  if (!window) return null;
  const events = parsed.events.filter((event) => Number.isInteger(event?.seq)
    && event.seq >= window.seqStart && event.seq <= window.seqEnd);
  const firstLine = parsed.eventLines[window.seqStart];
  const lastLine = parsed.eventLines[window.seqEnd];
  if (!firstLine || !lastLine) return null;
  // Tail window guard: the requested turn is normally the last one, but never
  // emit a digest for a turn whose beginning was cut off by the window.
  if (parsed.tail === true && window.seqStart === parsed.baseSeq) {
    const firstEvent = events[0];
    if (firstEvent?.type !== 'turn/start') return null;
  }
  return {
    turn,
    seqStart: window.seqStart,
    seqEnd: window.seqEnd,
    byteStart: firstLine.start,
    byteEnd: lastLine.end,
    events,
    digest: turnDigest(parsed.events, window.seqStart, window.seqEnd),
    eventLine(seq) {
      const line = parsed.eventLines[seq];
      if (!line) return null;
      return { text: line.text, offset: line.start, length: line.end - line.start };
    },
  };
}

/**
 * Read one session file from disk and parse it. Never writes.
 * @returns {{file:string, parsed:object}}
 */
export function readSessionFile({ home, sessionId, maxBytes = AUTOPROCEDURE_MAX_DECOMPRESSED_BYTES, readFile = null } = {}) {
  const file = findSessionFile(home, sessionId);
  if (!file) throw new AutoProcedureSampleError(SAMPLE_CODES.MISSING, `找不到会话文件：${sessionId}`);
  let buf;
  try {
    // io: this is called only from the async drain, never from the event callback.
    buf = readFile ? readFile(file) : fs.readFileSync(file);
  } catch (error) {
    throw new AutoProcedureSampleError(SAMPLE_CODES.PARSE, `会话文件不可读：${error?.message ?? error}`);
  }
  return { file, parsed: parseSessionBuffer(buf, { maxBytes }) };
}
