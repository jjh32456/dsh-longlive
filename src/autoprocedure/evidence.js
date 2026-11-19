// src/autoprocedure/evidence.js — 证据锚（D4/F2/N5）。
//
// 每条证据必含：
//   step, sessionId, turn, seqStart, seqEnd, turnDigest,
//   excerptSha256, excerptOffset, excerptLen, from, offsetSpace
// 两种来源各用各的偏移空间（N5）：
//   from:"session" → offsetSpace:"utf8-bytes-decompressed-session"
//                    偏移 = 解压后会话文本的 UTF-8 字节；摘录是会话里的一整行事件。
//   from:"d2"      → offsetSpace:"d2-redacted-file"
//                    偏移 = D2 落盘（redact 之后）文本的 UTF-8 字节；
//                    必带 callId / d2RelPath / redactedSha256 / sourceSha256。
//
// 禁止把 D2 摘录拿去会话文本里硬算偏移；D2 摘录在会话文本里找不到是正常情况
// （D2 落盘的是被替换掉的全文），只能按 D2 偏移校验；两处都定位不到才丢弃证据。
//
// 1.8.6 尾段采样（D7）下的偏移口径（红队 2026-11-18 裁决，写死）：
//   * 真值只有 `turnDigest` + 摘录 `excerptSha256`；`excerptOffset/excerptLen` 仅作
//     定位提示，不承担证明力。
//   * 尾段降级解析时 `excerptOffset` 是「尾段窗口内解压文本」的偏移，不保证是整包
//     绝对偏移；因此校验先试精确偏移，失败后**只在同一 turn 的字节范围内**按
//     「同长度 + 同 sha256」重定位（见 verifyEvidence）。
//   * 任何不确定（同 turn 内找不到同长度+同 hash 的行、digest 不一致、D2 meta 身份
//     不符）一律 fail closed：丢弃该条证据，绝不「大概定位」后放行。
//   * 1.8.7 计划新增采样标记以区分整包/尾段偏移；1.8.6 不做，但上述口径已写死。
//
// 校验三件套（v0.3 §3.4）：① turnDigest 可重算且一致；② 摘录 sha256 命中
// （session 来源允许在 turn 字节范围内按内容重定位——截断重排 seq 后 offset
// 会平移，但 digest 与内容不受影响）；③ 步骤文本不要求原文匹配。
//
// 文档口径固定：证据 gate 证明「未发现伪造/回读失败」，不证明「内容正确」。

import fs from 'node:fs';
import path from 'node:path';

import { turnDigest, turnWindowOf } from '../memory/anchors.js';
import { archiveFileName, sliceUtf8, textOfParts } from '../original.js';
import { sha256Hex } from './session-reader.js';

export const EVIDENCE_SCHEMA = 'autoprocedure-evidence/v1';
export const EVIDENCE_SOURCES = Object.freeze(['session', 'd2']);
export const OFFSET_SPACES = Object.freeze({
  session: 'utf8-bytes-decompressed-session',
  d2: 'd2-redacted-file',
});
export const D2_MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const D2_EXCERPT_MAX_BYTES = 4096;
const HEX64 = /^[0-9a-f]{64}$/;

function isInt(value) {
  return Number.isInteger(value);
}

/** A session-log evidence item for one event line (the excerpt IS that line). */
export function makeSessionEvidence({ step, sessionId, turn, turnSample, seq, parsed = null }) {
  const line = turnSample?.eventLine?.(seq);
  if (!line) return null;
  return {
    step,
    sessionId,
    turn,
    seqStart: turnSample.seqStart,
    seqEnd: turnSample.seqEnd,
    turnDigest: turnSample.digest,
    excerptSha256: sha256Hex(line.text),
    excerptOffset: line.offset,
    excerptLen: line.length,
    from: 'session',
    offsetSpace: OFFSET_SPACES.session,
  };
}

/** The session-log text of one tool result (canonical session side, for D2 source hash). */
export function sessionToolResultText(events, callId) {
  if (typeof callId !== 'string' || callId === '') return null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'tool/result') continue;
    const data = event?.data ?? {};
    const message = data.message && typeof data.message === 'object' ? data.message : data;
    const id = typeof message.toolCallId === 'string' ? message.toolCallId
      : (typeof data.toolCallId === 'string' ? data.toolCallId : null);
    if (id !== callId) continue;
    const { text } = textOfParts(message.content ?? data.content);
    return text;
  }
  return null;
}

/**
 * Build one D2 evidence item. Returns `{ok:true, evidence}` or
 * `{ok:false, code}` — the caller degrades to session evidence on a miss,
 * and drops the evidence when there is nothing verifiable at all.
 */
export function makeD2Evidence({
  step,
  memoryRoot,
  sessionId,
  turn,
  seqStart,
  seqEnd,
  turnDigest: digest,
  callId,
  sessionResultText = null,
  readFile = null,
}) {
  if (typeof callId !== 'string' || callId === '') {
    return { ok: false, code: 'E_EVIDENCE_D2_CALLID', message: 'D2 证据必须有 callId，缺则丢弃' };
  }
  if (typeof memoryRoot !== 'string' || memoryRoot === '' || !isInt(turn) || turn < 1) {
    return { ok: false, code: 'E_EVIDENCE_D2_CONTEXT' };
  }
  const dir = path.join(memoryRoot, '.longlive', 'tool-output', String(turn));
  const name = archiveFileName({ kind: 'tool', toolCallId: callId });
  const file = path.join(dir, name);
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, code: 'E_EVIDENCE_D2_MISSING' };
    if (stat.size > D2_MAX_EVIDENCE_BYTES) return { ok: false, code: 'E_EVIDENCE_D2_TOO_BIG' };
    text = readFile ? readFile(file) : fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, code: 'E_EVIDENCE_D2_MISSING' };
  }
  if (typeof text !== 'string' || text === '') return { ok: false, code: 'E_EVIDENCE_D2_MISSING' };

  const redactedSha256 = sha256Hex(text);
  // sourceSha256 = 会话原文（redact 之前）的 hash。D2 落盘前把原文换成 scrubbed
  // 文本，原文只留下 meta.originalSha256 这一个指针；没有 meta 时退到会话侧同
  // callId 的结果文本（可能被 D2 内联裁剪过，仍是 canonical 会话侧内容）。
  let sourceSha256 = null;
  try {
    const meta = JSON.parse(fs.readFileSync(`${file}.meta.json`, 'utf8'));
    if (meta && (meta.turn === undefined || meta.turn === turn)
      && (meta.callId === undefined || meta.callId === null || meta.callId === callId)
      && typeof meta.originalSha256 === 'string' && HEX64.test(meta.originalSha256)) {
      sourceSha256 = meta.originalSha256;
    }
  } catch {
    /* meta is optional; fall back to the session-side text */
  }
  if (sourceSha256 === null && typeof sessionResultText === 'string' && sessionResultText !== '') {
    sourceSha256 = sha256Hex(sessionResultText);
  }
  if (sourceSha256 === null) {
    return { ok: false, code: 'E_EVIDENCE_SOURCE_HASH', message: 'D2 与会话两处都定位不到原文 hash，丢弃该证据' };
  }

  const sliced = sliceUtf8(text, 0, D2_EXCERPT_MAX_BYTES);
  return {
    ok: true,
    evidence: {
      step,
      sessionId,
      turn,
      seqStart,
      seqEnd,
      turnDigest: digest,
      excerptSha256: sha256Hex(sliced.content),
      excerptOffset: sliced.offset,
      excerptLen: sliced.returnedBytes,
      from: 'd2',
      offsetSpace: OFFSET_SPACES.d2,
      callId,
      d2RelPath: `.longlive/tool-output/${turn}/${name}`,
      sourceSha256,
      redactedSha256,
    },
  };
}

/** Structural validation of one evidence item. Never throws. */
export function validateEvidenceItem(evidence) {
  const errors = [];
  const e = evidence && typeof evidence === 'object' ? evidence : null;
  if (!e) return { ok: false, errors: ['E_EVIDENCE_NOT_OBJECT'] };
  if (!isInt(e.step) || e.step < 0) errors.push('E_EVIDENCE_STEP');
  if (typeof e.sessionId !== 'string' || e.sessionId === '') errors.push('E_EVIDENCE_SESSION');
  if (!isInt(e.turn) || e.turn < 1) errors.push('E_EVIDENCE_TURN');
  if (!isInt(e.seqStart) || !isInt(e.seqEnd) || e.seqStart < 0 || e.seqEnd < e.seqStart) errors.push('E_EVIDENCE_SEQ');
  if (typeof e.turnDigest !== 'string' || !HEX64.test(e.turnDigest)) errors.push('E_EVIDENCE_TURN_DIGEST');
  if (typeof e.excerptSha256 !== 'string' || !HEX64.test(e.excerptSha256)) errors.push('E_EVIDENCE_EXCERPT_HASH');
  if (!isInt(e.excerptOffset) || e.excerptOffset < 0) errors.push('E_EVIDENCE_EXCERPT_OFFSET');
  if (!isInt(e.excerptLen) || e.excerptLen < 1) errors.push('E_EVIDENCE_EXCERPT_LEN');
  if (!EVIDENCE_SOURCES.includes(e.from)) errors.push('E_EVIDENCE_SOURCE');
  if (e.from === 'session' && e.offsetSpace !== OFFSET_SPACES.session) errors.push('E_EVIDENCE_OFFSET_SPACE');
  if (e.from === 'd2') {
    if (e.offsetSpace !== OFFSET_SPACES.d2) errors.push('E_EVIDENCE_OFFSET_SPACE');
    if (typeof e.callId !== 'string' || e.callId === '') errors.push('E_EVIDENCE_D2_CALLID');
    if (typeof e.d2RelPath !== 'string' || e.d2RelPath === ''
      || path.isAbsolute(e.d2RelPath) || e.d2RelPath.includes('..')
      || e.d2RelPath.includes('\\')) errors.push('E_EVIDENCE_D2_REL');
    if (typeof e.redactedSha256 !== 'string' || !HEX64.test(e.redactedSha256)) errors.push('E_EVIDENCE_D2_REDACTED_HASH');
    if (typeof e.sourceSha256 !== 'string' || !HEX64.test(e.sourceSha256)) errors.push('E_EVIDENCE_D2_SOURCE_HASH');
  }
  return { ok: errors.length === 0, errors };
}

/** Recompute the turnDigest for the evidence's turn against a parsed session. */
export function verifyTurnDigest(evidence, parsed) {
  if (!parsed || !Array.isArray(parsed.events)) return { ok: false, code: 'E_EVIDENCE_SESSION_MISSING' };
  const window = turnWindowOf(parsed.events, evidence?.turn);
  if (!window) return { ok: false, code: 'E_EVIDENCE_TURN_MISSING' };
  const digest = turnDigest(parsed.events, window.seqStart, window.seqEnd);
  if (digest !== evidence.turnDigest) return { ok: false, code: 'E_EVIDENCE_TURN_DIGEST_MISMATCH', digest, window };
  return { ok: true, code: 'OK', digest, window };
}

/** Byte range + line records of one turn window, used for excerpt checks. */
function turnLineRange(parsed, evidence) {
  const window = turnWindowOf(parsed?.events, evidence?.turn);
  if (!window) return null;
  const startLine = parsed.eventLines?.[window.seqStart];
  const endLine = parsed.eventLines?.[window.seqEnd];
  if (!startLine || !endLine) return null;
  const lines = [];
  for (let seq = window.seqStart; seq <= window.seqEnd; seq += 1) {
    const line = parsed.eventLines?.[seq];
    if (line) lines.push(line);
  }
  return { start: startLine.start, end: endLine.end, lines, window };
}

function hashLine(line) {
  return sha256Hex(line.text);
}

/**
 * Verify one evidence item against the canonical session (+ D2 archive when the
 * evidence says from:"d2"). `readFile` is injectable for tests.
 */
export function verifyEvidence({ evidence, parsed, memoryRoot = '', readFile = null }) {
  const validation = validateEvidenceItem(evidence);
  if (!validation.ok) return { ok: false, code: 'E_EVIDENCE_INVALID', errors: validation.errors };
  const digest = verifyTurnDigest(evidence, parsed);
  if (!digest.ok) return { ok: false, code: digest.code, digest };

  if (evidence.from === 'session') {
    const range = turnLineRange(parsed, evidence);
    if (!range) return { ok: false, code: 'E_EVIDENCE_TURN_RANGE', digest };
    // Fast path: the recorded byte offset is still an event-line start.
    const exact = range.lines.find((line) => line.start === evidence.excerptOffset);
    if (exact && exact.end - exact.start === evidence.excerptLen
      && hashLine(exact) === evidence.excerptSha256) {
      return { ok: true, code: 'OK', digest, excerpt: 'exact', source: 'session' };
    }
    // Relocation path: seq renumbering after session_truncate_visible shifts
    // byte offsets, but the excerpt content (one event line) is unchanged.
    const moved = range.lines.find((line) => line.end - line.start === evidence.excerptLen
      && hashLine(line) === evidence.excerptSha256);
    if (moved) {
      return {
        ok: true,
        code: 'OK',
        digest,
        excerpt: 'relocated',
        relocatedOffset: moved.start,
        source: 'session',
      };
    }
    return { ok: false, code: 'E_EVIDENCE_EXCERPT_MISMATCH', digest, excerpt: 'missing' };
  }

  // from:"d2" — verify against the D2 archive only (N5). The excerpt coordinates
  // are in the redacted D2 text, never in the session text.
  let d2Text;
  let d2File;
  try {
    const rel = evidence.d2RelPath.split('/').join(path.sep);
    d2File = path.join(memoryRoot, rel);
    const stat = fs.statSync(d2File);
    if (!stat.isFile() || stat.size > D2_MAX_EVIDENCE_BYTES) {
      return { ok: false, code: 'E_EVIDENCE_D2_MISSING', digest };
    }
    d2Text = readFile ? readFile(d2File) : fs.readFileSync(d2File, 'utf8');
  } catch {
    return { ok: false, code: 'E_EVIDENCE_D2_MISSING', digest };
  }
  if (sha256Hex(d2Text) !== evidence.redactedSha256) {
    return { ok: false, code: 'E_EVIDENCE_D2_REDACTED_MISMATCH', digest };
  }
  const sliced = sliceUtf8(d2Text, evidence.excerptOffset, evidence.excerptLen);
  if (sliced.offset !== evidence.excerptOffset
    || sliced.returnedBytes !== evidence.excerptLen
    || sha256Hex(sliced.content) !== evidence.excerptSha256) {
    return { ok: false, code: 'E_EVIDENCE_D2_EXCERPT_MISMATCH', digest };
  }
  // sourceSha256（redact 之前的会话原文）只可能从 D2 自己的 meta 里核对：会话
  // 日志留的是内联裁剪后的文本，不可能是原文。meta 不可用（被保留策略删掉）时
  // 按 N5 只做 D2 偏移校验；meta 在但 hash 不一致 → 拒绝。
  //
  // MAJ-4/D4/D8：verify 侧必须重新核对 meta 的身份字段（turn/callId），
  // 否则「跨会话同 turn 同 callId、内容不同」的两个 D2 文件无法区分。
  // meta 缺失可接受（降级：只做偏移 + redactedSha256 校验），但返回
  // metaMissing=true，由 lint 记 EVIDENCE_D2_META_MISSING（不阻塞落盘）。
  let sourceOk = null;
  let metaMissing = false;
  try {
    const meta = JSON.parse(fs.readFileSync(`${d2File}.meta.json`, 'utf8'));
    if (meta && typeof meta === 'object') {
      if (meta.turn !== undefined && meta.turn !== evidence.turn) {
        return { ok: false, code: 'E_EVIDENCE_D2_META_TURN', digest };
      }
      if (meta.callId !== undefined && meta.callId !== null && meta.callId !== evidence.callId) {
        return { ok: false, code: 'E_EVIDENCE_D2_META_CALLID', digest };
      }
      if (typeof meta.originalSha256 === 'string' && HEX64.test(meta.originalSha256)) {
        sourceOk = meta.originalSha256 === evidence.sourceSha256;
        if (!sourceOk) return { ok: false, code: 'E_EVIDENCE_D2_SOURCE_MISMATCH', digest };
      } else {
        metaMissing = true;
      }
    } else {
      metaMissing = true;
    }
  } catch {
    sourceOk = null;
    metaMissing = true;
  }
  return {
    ok: true,
    code: 'OK',
    digest,
    excerpt: 'd2',
    source: 'd2',
    sourceChecked: sourceOk !== null,
    metaMissing,
  };
}

/** Verify every evidence item; the candidate is only written when all pass. */
export function verifyEvidenceSet(evidenceList, { parsed, memoryRoot = '', readFile = null } = {}) {
  const list = Array.isArray(evidenceList) ? evidenceList : [];
  // MAJ-1/D8: an empty evidence set (or a set with no canonical session anchor)
  // must be rejected, counted as reject reason=evidence, and never written.
  if (list.length === 0) return { ok: false, code: 'E_EVIDENCE_EMPTY', results: [] };
  if (!list.some((item) => item?.from === 'session')) {
    return { ok: false, code: 'E_EVIDENCE_NO_SESSION', results: [] };
  }
  const results = [];
  for (const evidence of list) {
    const result = verifyEvidence({ evidence, parsed, memoryRoot, readFile });
    results.push({ evidence, result });
    if (!result.ok) return { ok: false, code: result.code, failed: result, results };
  }
  return { ok: true, code: 'OK', results, metaMissing: results.some((item) => item.result?.metaMissing === true) };
}
