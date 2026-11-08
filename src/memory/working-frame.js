// src/memory/working-frame.js — v2.6.4 §14.2：连续性最小集（working-frame）
//
// 用途：同一话题的连续追问时，把「当前工作焦点」压成 ≤300 字的注入块，
// 放在 pre-step 注入顺序的 working 位：**[boot, shared, working, recall]**。
//
// 文件：<memoryRoot>/.longlive/working/<sessionId>.json（原子写 tmp→rename）
//       <memoryRoot>/.longlive/working/archive/<sessionId>-<frameNo>.json（旧帧，不删）
//       <memoryRoot>/.longlive/working/audit.jsonl（rollback / stale / topic-switch 审计）
//
// 时间纪律（复用 Gate-1 P1-2）：
//   * TTL 默认 30min（1800000ms），用**单调时钟**计算 elapsed：回拨/前跳都不改变 TTL；
//   * 持久化 `wallWatermarkMs`；检测到墙钟回拨（now + 容差 < watermark）→ fail closed
//     `E_CLOCK_ROLLBACK`（不注入 + 审计），绝不把过期帧当有效帧。
//   * 过期 → 不注入、不删除，帧标 `state:"stale"`（审计可查）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../codec.js';
import { acquireLease, releaseLease } from './lock.js';
import {
  AUTO_TEXT_MARK,
  insertionIndex,
  isHumanMessage,
  isInjectedMessage,
  textOfMessage,
} from '../identity/inject-position.js';
import {
  assertFrameReadable,
  attachFrameSubject,
  normalizeRoleSubject,
  verifyProtectedFile,
  writeProtectedJson,
} from '../role/writeprotect.js';

export const FRAME_SCHEMA = 'working-frame/v1';
export const FRAME_TTL_MS = 30 * 60 * 1000;
export const TOPIC_SIMILARITY_THRESHOLD = 0.35;
export const INJECTION_ORDER = Object.freeze(['boot', 'shared', 'working', 'recall']);
export const CLOCK_TOLERANCE_MS = 5000;

export class WorkingFrameError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'WorkingFrameError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function workingDirOf(memoryRoot) {
  const root = path.resolve(String(memoryRoot ?? ''));
  return {
    root,
    dir: path.join(root, '.longlive', 'working'),
    archiveDir: path.join(root, '.longlive', 'working', 'archive'),
    audit: path.join(root, '.longlive', 'working', 'audit.jsonl'),
  };
}

export function framePathOf(memoryRoot, sessionId) {
  return path.join(workingDirOf(memoryRoot).dir, `${safeSessionId(sessionId)}.json`);
}

function safeSessionId(sessionId) {
  const original = String(sessionId ?? '');
  const raw = original.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  if (raw === '') throw new WorkingFrameError('E_SESSION_ID', 'working-frame requires sessionId');
  // EA-14: sanitization must not collide different sessions (sess@1 vs sess_1).
  if (raw !== original) {
    const digest = crypto.createHash('sha1').update(original, 'utf8').digest('hex').slice(0, 10);
    return `${raw.slice(0, 140)}_${digest}`;
  }
  return raw;
}

function sha1Short(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 12);
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return value instanceof Date ? value.getTime() : Number(value);
}

function nowIso(now) {
  return new Date(nowMs(now)).toISOString();
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** CJK bigrams + ASCII words + version tokens. */
export function tokenizeFocus(value) {
  const text = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  const tokens = new Set();
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? []) tokens.add(word);
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) tokens.add(chars[0]);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.add(chars[i] + chars[i + 1]);
  }
  return [...tokens];
}

export function jaccardSimilarity(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Pre-step injection order: [boot, shared, working, recall].
 * Blocks are {kind, text}; empty texts are dropped, unknown kinds dropped.
 */

/** Human-friendly focus entities from a question (EA-05 caller uses this). */
export function entitiesFromText(text, limit = 8) {
  const normalized = String(text ?? '');
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const token = String(value ?? '').trim();
    if (token === '' || seen.has(token) || out.length >= limit) return;
    seen.add(token);
    out.push(token);
  };
  for (const run of normalized.match(/[㐀-䶿一-鿿]{2,8}/g) ?? []) push(run);
  for (const word of normalized.match(/[A-Za-z][A-Za-z0-9._-]{1,30}/g) ?? []) push(word);
  for (const version of normalized.match(/v?\d+(?:\.\d+){1,3}/g) ?? []) push(version);
  return out;
}

/**
 * EA-05: real per-turn focus updater — extracts the last human message and records
 * this turn's focus into the frame stack (so the NEXT turn can inject it).
 */
export function updateFrameFromMessages({ store, sessionId, messages, turn = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let human = null;
  for (const message of list) {
    if (isHumanMessage(message)) human = message;
  }
  const query = human ? textOfMessage(human) : '';
  if (query.trim() === '') return { ok: false, code: 'E_NO_HUMAN_MESSAGE' };
  const result = store.updateFocus({
    sessionId,
    entities: entitiesFromText(query),
    anchors: [],
    turn: Number.isInteger(turn) && turn >= 0 ? turn : 0,
    query,
  });
  return { ...result, query };
}

/**
 * EA-04: insert the working-frame injection at the real order slot
 * [boot, shared, working, recall] — before the auto-recall block, after boot/shared.
 */
export function insertWorkingMessage(messages, message) {
  const list = Array.isArray(messages) ? [...messages] : [];
  if (!message) return list;
  const autoIndex = list.findIndex((entry) => {
    if (!isInjectedMessage(entry)) return false;
    const firstLine = textOfMessage(entry).trimStart().split('\n', 1)[0] ?? '';
    return firstLine.startsWith(AUTO_TEXT_MARK);
  });
  if (autoIndex !== -1) {
    list.splice(autoIndex, 0, message);
    return list;
  }
  let lastInjected = -1;
  for (let index = 0; index < list.length; index += 1) {
    if (isInjectedMessage(list[index])) lastInjected = index;
  }
  if (lastInjected !== -1) {
    list.splice(lastInjected + 1, 0, message);
    return list;
  }
  list.splice(insertionIndex(list), 0, message);
  return list;
}

export function composePreStepBlocks(blocks) {
  const byKind = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (!INJECTION_ORDER.includes(block.kind)) continue;
    if (typeof block.text !== 'string' || block.text.trim() === '') continue;
    if (!byKind.has(block.kind)) byKind.set(block.kind, []);
    byKind.get(block.kind).push(block.text.trim());
  }
  const out = [];
  for (const kind of INJECTION_ORDER) {
    for (const text of byKind.get(kind) ?? []) out.push({ kind, text });
  }
  return out;
}

function validateFrame(frame, sessionId) {
  if (!frame || typeof frame !== 'object') throw new WorkingFrameError('E_FRAME_INVALID', 'frame must be an object');
  if (frame.sessionId !== sessionId) throw new WorkingFrameError('E_FRAME_SESSION', 'frame.sessionId mismatch');
  if (!Array.isArray(frame.focus?.entities)) throw new WorkingFrameError('E_FRAME_FOCUS', 'frame.focus.entities required');
  if (!Array.isArray(frame.turnRange) || frame.turnRange.length !== 2) {
    throw new WorkingFrameError('E_FRAME_TURN_RANGE', 'frame.turnRange required');
  }
  return frame;
}

/**
 * Create the working-frame store.
 *
 * @param {object} options
 * @param {string} options.memoryRoot
 * @param {() => Date} [options.now]
 * @param {() => number} [options.monoNow] monotonic clock seam (ms)
 * @param {number} [options.ttlMs]
 * @param {number} [options.clockToleranceMs]
 */
export function createWorkingFrameStore(options = {}) {
  const memoryRoot = path.resolve(String(options.memoryRoot ?? ''));
  if (memoryRoot === '') throw new WorkingFrameError('E_MEMORY_ROOT', 'working-frame requires memoryRoot');
  const paths = workingDirOf(memoryRoot);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const monoNow = typeof options.monoNow === 'function'
    ? options.monoNow
    : () => {
      const [seconds, nanoseconds] = process.hrtime();
      return seconds * 1000 + nanoseconds / 1e6;
    };
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : FRAME_TTL_MS;
  const tolerance = Number.isFinite(options.clockToleranceMs) && options.clockToleranceMs >= 0
    ? options.clockToleranceMs
    : CLOCK_TOLERANCE_MS;
  const bootMono = monoNow();
  const bootWall = nowMs(now);
  // §16.8 A/E：working/** 写保护（宿主独占写 + HMAC 侧车）+ 四元边界。
  const frameSubject = normalizeRoleSubject(options.subject ?? {});
  const frameActor = typeof options.actorKind === 'string' ? options.actorKind : 'host';

  function effectiveWallMs() {
    const elapsed = Number.isFinite(monoNow()) ? Math.max(0, monoNow() - bootMono) : 0;
    return bootWall + elapsed;
  }

  function audit(event, detail) {
    try {
      fs.mkdirSync(path.dirname(paths.audit), { recursive: true });
      fs.appendFileSync(paths.audit, `${JSON.stringify({ schema: 'working-frame-audit/v1', at: nowIso(now), event, ...detail })}\n`, 'utf8');
    } catch {
      /* audit is best effort */
    }
  }

  function clockGuard(frame) {
    const wall = nowMs(now);
    const watermark = Number(frame?.wallWatermarkMs ?? frame?.lastUsedAtMs ?? 0);
    if (Number.isFinite(wall) && watermark > 0 && wall + tolerance < watermark) {
      audit('clock.rollback', { sessionId: frame?.sessionId ?? null, wall, watermark });
      throw new WorkingFrameError('E_CLOCK_ROLLBACK', `系统时钟回拨（now=${new Date(wall).toISOString()} < watermark=${new Date(watermark).toISOString()}），工作帧 fail closed。`, { wall, watermark });
    }
    return wall;
  }

  function load(sessionId) {
    const id = safeSessionId(sessionId);
    const file = framePathOf(memoryRoot, id);
    const verified = verifyProtectedFile({ memoryRoot, file });
    if (verified.absent) return { present: false, frame: null };
    if (!verified.ok) {
      return { present: true, frame: null, code: verified.code ?? 'E_INTEGRITY_TAMPER', message: verified.message };
    }
    try {
      return { present: true, frame: JSON.parse(verified.text), code: null };
    } catch {
      return { present: true, frame: null, code: 'E_INTEGRITY_TAMPER', message: '受保护帧 JSON 解析失败' };
    }
  }

  function clampFramePayload(input) {
    const value = JSON.parse(JSON.stringify(input));
    if (Array.isArray(value?.focus?.entities)) {
      value.focus.entities = value.focus.entities.map((entity) => String(entity).slice(0, 200)).slice(0, 50);
    }
    if (Array.isArray(value?.focus?.anchors)) {
      value.focus.anchors = value.focus.anchors.slice(0, 20).map((anchor) => {
        const clone = JSON.parse(JSON.stringify(anchor ?? {}));
        const walk = (node) => {
          if (typeof node === 'string') return node.length > 2000 ? `${node.slice(0, 2000)}…[truncated]` : node;
          if (Array.isArray(node)) return node.map(walk);
          if (node && typeof node === 'object') { for (const key of Object.keys(node)) node[key] = walk(node[key]); }
          return node;
        };
        return walk(clone);
      });
    }
    return value;
  }

  function save(sessionId, frame) {
    const id = safeSessionId(sessionId);
    const clamped = clampFramePayload(frame);
    const validated = validateFrame(clamped, id);
    const value = attachFrameSubject(validated, { subject: frameSubject });
    const serialized = JSON.stringify(value);
    if (serialized.length > 512 * 1024) {
      throw new WorkingFrameError('E_FRAME_TOO_LARGE', `工作帧超过 512KB 上限（${serialized.length} bytes），拒绝落盘。`);
    }
    const file = framePathOf(memoryRoot, id);
    writeProtectedJson({ memoryRoot, file, value, actorKind: frameActor });
    return { ok: true, path: file, frame: value };
  }

  function newFrame({ sessionId, entities = [], anchors = [], turn = 0, frameNo = 1, prevFrameId = null }) {
    const wall = nowMs(now);
    return {
      schema: FRAME_SCHEMA,
      sessionId,
      frameId: `wf-${sha1Short(`${sessionId}|${frameNo}|${wall}`)}`,
      frameNo,
      turnRange: [Number.isInteger(turn) ? turn : 0, Number.isInteger(turn) ? turn : 0],
      focus: {
        entities: [...new Set(entities.filter((entity) => typeof entity === 'string' && entity.trim() !== ''))].slice(0, 30),
        anchors: Array.isArray(anchors) ? anchors.slice(0, 20) : [],
      },
      ttlMs,
      lastUsedAtMs: wall,
      lastUsedAt: new Date(wall).toISOString(),
      updatedAt: new Date(wall).toISOString(),
      wallWatermarkMs: wall,
      state: 'active',
      prevFrameId,
    };
  }

  function archiveFrame(sessionId, frame) {
    const id = safeSessionId(sessionId);
    const file = path.join(paths.archiveDir, `${id}-frame-${frame.frameNo ?? 1}-${frame.frameId ?? sha1Short(stableStringify(frame))}.json`);
    writeProtectedJson({
      memoryRoot,
      file,
      value: attachFrameSubject({ ...frame, archivedAt: nowIso(now), state: 'archived' }, { subject: frameSubject }),
      actorKind: frameActor,
    });
    audit('topic.switch.archive', { sessionId: id, frameId: frame.frameId ?? null, frameNo: frame.frameNo ?? null, file });
    return file;
  }

  function isExpired(frame) {
    if (!frame) return true;
    const lastUsed = Number(frame.lastUsedAtMs ?? 0);
    if (!Number.isFinite(lastUsed) || lastUsed <= 0) return true;
    const effective = effectiveWallMs();
    // EA-13: a FORWARD wall-clock jump must expire the frame, not silently stretch
    // its lifetime. Backward jumps are handled by clockGuard (fail closed).
    const realWall = nowMs(now);
    if (Number.isFinite(realWall) && Number.isFinite(effective) && realWall > effective + tolerance) return true;
    return effective - lastUsed > ttlMs;
  }

  function topicChanged(frame, queryOrEntities) {
    const incoming = tokenizeFocus(queryOrEntities);
    if (incoming.length === 0) return false;
    // Topic switch is keyed on the frame's focus ENTITIES (anchors are evidence,
    // not topic tokens). Switch only when the new turn shares no entity token and
    // the Jaccard similarity is below threshold; a same-topic follow-up keeps the frame.
    const entityTokens = tokenizeFocus(frame?.focus?.entities ?? []);
    if (entityTokens.length === 0) return true;
    let intersection = 0;
    const entitySet = new Set(entityTokens);
    for (const token of incoming) if (entitySet.has(token)) intersection += 1;
    if (intersection > 0) return false;
    return jaccardSimilarity(incoming, entityTokens) < TOPIC_SIMILARITY_THRESHOLD;
  }

  /**
   * Per-turn focus update. Same topic merges; expired/topic-switched frames go to archive
   * (never deleted) and a new frame is opened.
   */
  function updateFocus(input = {}) {
    const leaseFile = `${framePathOf(memoryRoot, input.sessionId)}.lock`;
    let lease;
    try {
      lease = acquireLease(leaseFile, { holder: `working-frame:${process.pid}`, ttlMs: 30_000 });
    } catch (error) {
      return { ok: false, code: 'E_FRAME_BUSY', message: `工作帧正在被另一写者更新（E_FRAME_BUSY）：${error?.message ?? error}` };
    }
    try {
      return updateFocusUnlocked(input);
    } finally {
      releaseLease(leaseFile, lease.holder);
    }
  }

  function updateFocusUnlocked({ sessionId, entities = [], anchors = [], turn = 0, query = '' }) {
    const loaded = load(sessionId);
    const wall = nowMs(now);
    // §16.8 A：帧被篡改/缺侧车 → fail closed，绝不把坏帧当有效帧继续写。
    if (loaded.present && loaded.frame === null) {
      return { ok: false, code: loaded.code ?? 'E_INTEGRITY_TAMPER', message: loaded.message ?? '帧完整性校验失败' };
    }
    if (!loaded.present) {
      const frame = newFrame({ sessionId: safeSessionId(sessionId), entities, anchors, turn, frameNo: 1 });
      save(sessionId, frame);
      return { ok: true, switched: true, reason: 'new', frame };
    }
    const current = loaded.frame;
    clockGuard(current);
    const expired = isExpired(current);
    // Topic switch considers BOTH the new question and this turn's extracted entities:
    // a question that reuses the frame's focus entities stays on the same frame.
    const switched = topicChanged(current, query !== '' ? [query, ...(Array.isArray(entities) ? entities : [])] : entities);
    if (expired || switched) {
      const archiveFile = archiveFrame(sessionId, current);
      const frame = newFrame({
        sessionId: safeSessionId(sessionId),
        entities,
        anchors,
        turn,
        frameNo: (current.frameNo ?? 1) + 1,
        prevFrameId: current.frameId ?? null,
      });
      save(sessionId, frame);
      return { ok: true, switched: true, reason: expired ? 'expired' : 'topic-switch', archiveFile, frame };
    }
    const mergedEntities = [...new Set([...(current.focus?.entities ?? []), ...entities])].slice(0, 30);
    const mergedAnchors = [...(current.focus?.anchors ?? []), ...anchors];
    const next = {
      ...current,
      turnRange: [current.turnRange?.[0] ?? 0, Math.max(current.turnRange?.[1] ?? 0, Number.isInteger(turn) ? turn : 0)],
      focus: { entities: mergedEntities, anchors: mergedAnchors.slice(0, 20) },
      lastUsedAtMs: wall,
      lastUsedAt: new Date(wall).toISOString(),
      updatedAt: new Date(wall).toISOString(),
      wallWatermarkMs: Math.max(Number(current.wallWatermarkMs ?? 0), wall),
      state: 'active',
    };
    save(sessionId, next);
    return { ok: true, switched: false, reason: 'merged', frame: next };
  }

  /** Injection decision: unexpired frame only; rollback fails closed; never delete. */
  function frameForInjection({ sessionId, caller = null }) {
    const loaded = load(sessionId);
    if (!loaded.present) return { inject: false, code: 'E_NO_FRAME' };
    if (loaded.frame === null) return { inject: false, code: loaded.code ?? 'E_INTEGRITY_TAMPER' };
    const frame = loaded.frame;
    if (caller !== null) {
      try {
        assertFrameReadable(frame, caller);
      } catch (error) {
        return { inject: false, code: error.code ?? 'E_FRAME_PRIVATE', message: error.message };
      }
    }
    try {
      clockGuard(frame);
    } catch (error) {
      return { inject: false, code: error.code, message: error.message };
    }
    if (isExpired(frame)) {
      if (frame.state !== 'stale') {
        try {
          save(sessionId, { ...frame, state: 'stale', updatedAt: nowIso(now) });
        } catch {
          /* stale mark is best effort */
        }
        audit('frame.stale', { sessionId: safeSessionId(sessionId), frameId: frame.frameId ?? null });
      }
      return { inject: false, code: 'E_FRAME_EXPIRED', frame };
    }
    return { inject: true, frame, text: renderBlock(frame) };
  }

  /** ≤300 chars block; truncated in that order: anchors → entities. */
  function renderBlock(frame) {
    const entities = (frame?.focus?.entities ?? []).slice(0, 8);
    const anchorLines = (frame?.focus?.anchors ?? []).map((anchor) => anchor?.oneLine).filter(Boolean).slice(0, 4);
    const turnRange = Array.isArray(frame?.turnRange) ? `${frame.turnRange[0]}-${frame.turnRange[1]}` : '?';
    const parts = [`【工作帧】焦点：${entities.length > 0 ? entities.join('、') : '（无）'}（轮次 ${turnRange}）`];
    if (anchorLines.length > 0) parts.push(`锚点：${anchorLines.join('；')}`);
    let text = parts.join(' · ');
    if (text.length > 300) text = text.slice(0, 299) + '…';
    return text;
  }

  function archive(sessionId) {
    const loaded = load(sessionId);
    if (!loaded.present) return { ok: false, code: 'E_NO_FRAME' };
    const file = archiveFrame(sessionId, loaded.frame);
    return { ok: true, file };
  }

  return {
    memoryRoot,
    paths,
    ttlMs,
    effectiveWallMs,
    load,
    save,
    updateFocus,
    frameForInjection,
    renderBlock,
    isExpired,
    topicChanged,
    archive,
    newFrame,
  };
}
