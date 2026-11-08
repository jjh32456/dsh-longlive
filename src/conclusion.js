// conclusion.js — A1「结论自动回流」v1.
//
// At `turn/end` (reason: completed) this bridge looks at the turn's last real
// user message and the assistant's final text blocks, decides locally — no
// LLM call — whether the turn contains a conclusion (定了 / 决定 / 结论 /
// 就这样 / 改成 ...), and, when it does, writes one memory card under
// `<memoryRoot>/topics/` plus a per-session marker under
// `<memoryRoot>/.longlive/bridge/` that keeps the same session+turn idempotent
// and publishes the one-line conclusion the shared board reads (A2).
//
// Privacy reuses the auto-recall gate (`recall/privacy.mjs`): a local_only
// verdict, or a throwing gate, silently drops the card. Every path is wrapped
// so a failure never blocks the turn that triggered it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dayString, isoStamp, serializeFrontmatter } from './memory/frontmatter.js';
import { privacyScan as defaultPrivacyScan } from './recall/privacy.mjs';
import { isUserAuthoredMessage } from './truncate-visible.js';

export const BRIDGE_VERSION = 1;
export const CONCLUSION_BODY_MAX = 500;
export const CONCLUSION_TEXT_MAX = 120;
export const CONCLUSION_TITLE_MAX = 60;
export const CONCLUSION_USER_MAX = 200;
export const CONCLUSION_ASSISTANT_MAX = 280;
export const BRIDGE_TURNS_MAX = 50;
export const CONCLUSION_CARD_PREFIX = 'conclusion';

/** Words that mark a decision. Checked before FACT_TRIGGERS (「结论是」 wins). */
export const DECISION_TRIGGERS = Object.freeze([
  '定了', '决定', '拍板', '敲定', '定稿', '就这么', '就这样', '按这个',
  '以后都', '改成', '最终方案', '最后决定', '结论是', '就按',
]);

/** Weaker conclusion markers: a summary/answer rather than a directive. */
export const FACT_TRIGGERS = Object.freeze([
  '结论', '最后', '总结', '因此', '所以', '确定', '确认', '记下',
]);

const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function oneLine(value, maxChars = 0) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return maxChars > 0 ? clip(text, maxChars) : text;
}

function clip(value, maxChars) {
  const text = String(value ?? '');
  if (maxChars <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

function textBlocks(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== 'text') continue; // reasoning / tool-call are skipped
    if (typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

function sentences(text) {
  return oneLine(text)
    .split(/(?<=[。！？!?；;])/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function firstSentence(text) {
  return sentences(text)[0] ?? '';
}

function triggerSentence(text) {
  return sentences(text).find((item) => classifyConclusionText(item) !== null) ?? '';
}

/** Local rule: which kind of conclusion marker (if any) the text carries. */
export function classifyConclusionText(text) {
  const value = oneLine(text);
  if (value === '') return null;
  if (DECISION_TRIGGERS.some((word) => value.includes(word))) return 'decision';
  if (FACT_TRIGGERS.some((word) => value.includes(word))) return 'fact';
  return null;
}

/** Short statement other sessions see as 「结论」. */
export function pickExcerpt(userText, assistantText) {
  const assistant = oneLine(assistantText);
  const user = oneLine(userText);
  const candidate = triggerSentence(assistant)
    || triggerSentence(user)
    || firstSentence(assistant)
    || firstSentence(user);
  return clip(oneLine(candidate), CONCLUSION_TEXT_MAX);
}

/**
 * Decide whether this turn is a conclusion. Pure: no IO, no clock.
 * Returns {kind, title, excerpt, text, body} or null.
 */
export function judgeConclusion({ userText, assistantText } = {}) {
  const user = oneLine(userText);
  const assistant = oneLine(assistantText);
  if (Array.from(user).length < 2) return null;
  if (Array.from(assistant).length < 8) return null;
  const userKind = classifyConclusionText(user);
  const assistantKind = classifyConclusionText(assistant);
  const kind = userKind === 'decision' || assistantKind === 'decision'
    ? 'decision'
    : (userKind === 'fact' || assistantKind === 'fact' ? 'fact' : null);
  if (kind === null) return null;
  const excerpt = pickExcerpt(user, assistant);
  if (excerpt === '') return null;
  const title = clip(`结论：${excerpt}`, CONCLUSION_TITLE_MAX);
  // Leave room for prefixes and the newline: 200 + 280 + 8 = 488 < 500.
  const body = `用户：${clip(user, CONCLUSION_USER_MAX)}\n助手：${clip(assistant, CONCLUSION_ASSISTANT_MAX)}`;
  return { kind, title, excerpt, text: excerpt, body };
}

/** `<memoryRoot>/.longlive/bridge` — same directory A2's board reads. */
export function bridgeDirFor(memoryRoot) {
  return path.join(memoryRoot, '.longlive', 'bridge');
}

export function bridgeMarkerFile(memoryRoot, sessionId) {
  return path.join(bridgeDirFor(memoryRoot), `${sessionId}.json`);
}

export function readBridgeMarker(memoryRoot, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(bridgeMarkerFile(memoryRoot, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function hash8(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function conclusionCardFile(memoryRoot, sessionId, turn) {
  return path.join(memoryRoot, 'topics', `${CONCLUSION_CARD_PREFIX}-t${turn}-${hash8(sessionId)}.md`);
}

function writeCard(memoryRoot, sessionId, turn, at, judged) {
  const file = conclusionCardFile(memoryRoot, sessionId, turn);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fields = {
    title: judged.title,
    date: dayString(at),
    tags: ['auto-conclusion'],
    salience: judged.kind === 'decision' ? 4 : 3,
    strength: 3,
  };
  const extras = {
    kind: judged.kind,
    source_session: sessionId,
    source_turn: String(turn),
    written_at: isoStamp(at),
    at: isoStamp(at),
  };
  fs.writeFileSync(file, `${serializeFrontmatter(fields, extras)}\n\n${judged.body}\n`, 'utf8');
  return file;
}

function dateOf(value) {
  if (value instanceof Date) return value;
  return new Date(value ?? Date.now());
}

function resolveSessionId(session, event) {
  const raw = session?.id
    ?? session?.header?.id
    ?? event?.sessionId
    ?? '';
  if (typeof raw !== 'string') return '';
  const id = raw.trim().toLowerCase();
  return SESSION_ID_RE.test(id) ? id : '';
}

/**
 * Create the bridge. `enabled === true` is the only switch (A1 is opt-in, so
 * the plugin's default behaviour is unchanged). The returned onSessionEvent is
 * meant to be wired to `ctx.on('session/event', ...)`.
 */
export function createConclusionBridge(options = {}) {
  const enabled = options.enabled === true;
  const memoryRoot = typeof options.memoryRoot === 'string' ? options.memoryRoot.trim() : '';
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const scan = typeof options.privacyScan === 'function' ? options.privacyScan : defaultPrivacyScan;
  const stats = { turns: 0, written: 0, skipped: 0, duplicates: 0, privacy: 0, errors: 0 };
  const sessions = new Map();

  function reset() {
    sessions.clear();
    stats.turns = 0;
    stats.written = 0;
    stats.skipped = 0;
    stats.duplicates = 0;
    stats.privacy = 0;
    stats.errors = 0;
  }

  if (!enabled || memoryRoot === '') {
    return { enabled: false, memoryRoot, stats, onSessionEvent() {}, reset };
  }

  function flush(state, turn) {
    const judged = judgeConclusion({ userText: state.userText, assistantText: state.assistantText });
    if (judged === null) {
      stats.skipped += 1;
      return { written: false, reason: 'not-conclusion' };
    }
    const prior = readBridgeMarker(memoryRoot, state.sessionId);
    const priorTurns = prior && typeof prior.turns === 'object' && prior.turns !== null
      ? prior.turns
      : {};
    if (priorTurns[String(turn)] !== undefined
      || (prior?.lastConclusion && prior.lastConclusion.turn === turn)) {
      stats.duplicates += 1;
      return { written: false, reason: 'duplicate' };
    }
    let verdict = null;
    try {
      verdict = scan(judged.body);
    } catch {
      verdict = { verdict: 'local_only' };
    }
    if (!verdict || verdict.verdict === 'local_only') {
      stats.privacy += 1;
      return { written: false, reason: 'privacy' };
    }
    try {
      const at = dateOf(now());
      const file = writeCard(memoryRoot, state.sessionId, turn, at, judged);
      const turns = { ...priorTurns };
      turns[String(turn)] = isoStamp(at);
      const keys = Object.keys(turns).sort((a, b) => Number(a) - Number(b));
      while (keys.length > BRIDGE_TURNS_MAX) delete turns[keys.shift()];
      writeJsonAtomic(bridgeMarkerFile(memoryRoot, state.sessionId), {
        v: BRIDGE_VERSION,
        sessionId: state.sessionId,
        updatedAt: isoStamp(at),
        lastConclusion: {
          text: judged.text,
          kind: judged.kind,
          turn,
          at: isoStamp(at),
        },
        turns,
      });
      stats.written += 1;
      return { written: true, reason: 'written', file, kind: judged.kind, text: judged.text };
    } catch {
      stats.errors += 1;
      return { written: false, reason: 'error' };
    }
  }

  function handle(session, event) {
    const type = event?.type;
    if (typeof type !== 'string') return;
    const sessionId = resolveSessionId(session, event);
    if (type === 'session/disposed') {
      if (sessionId !== '') sessions.delete(sessionId);
      return;
    }
    if (sessionId === '') return;
    let state = sessions.get(sessionId);
    if (!state) {
      state = { sessionId, turn: null, userText: '', assistantText: '' };
      sessions.set(sessionId, state);
    }

    if (type === 'turn/start') {
      const turn = event?.data?.turn;
      state.turn = Number.isInteger(turn) ? turn : state.turn;
      state.userText = '';
      state.assistantText = '';
      return;
    }

    if (type === 'user/message') {
      if (!isUserAuthoredMessage(event)) return;
      const text = textBlocks(event?.data?.content);
      if (text !== '') state.userText = text;
      return;
    }

    if (type === 'assistant/message') {
      const data = event?.data ?? {};
      const turn = data.turn;
      if (Number.isInteger(turn) && Number.isInteger(state.turn) && turn !== state.turn) return;
      const message = data.message && typeof data.message === 'object' ? data.message : data;
      const text = textBlocks(message?.content);
      // Only the final non-empty text wins; a tool-only closing step leaves the
      // previous text in place.
      if (text !== '') state.assistantText = text;
      return;
    }

    if (type === 'turn/end') {
      const turn = event?.data?.turn;
      const reason = event?.data?.reason?.kind;
      const resolved = Number.isInteger(turn) ? turn : state.turn;
      stats.turns += 1;
      if (Number.isInteger(resolved) && reason === 'completed') flush(state, resolved);
      else stats.skipped += 1;
      state.userText = '';
      state.assistantText = '';
      state.turn = Number.isInteger(resolved) ? resolved : null;
    }
  }

  return {
    enabled: true,
    memoryRoot,
    stats,
    reset,
    onSessionEvent(session, event) {
      try {
        handle(session, event);
      } catch {
        stats.errors += 1;
      }
    },
  };
}
