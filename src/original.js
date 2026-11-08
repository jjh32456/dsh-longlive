// D3 — fetch the original text of one turn from a session log.
//
// This module is pure over parsed session events: it attributes events to
// turns, turns them into addressable items, selects the requested item, joins
// the selection and slices it on UTF-8 boundaries. Reading the log, resolving
// the session path, the privacy gate and the memory root stay in tools.js.
//
// Item kinds:
//   message  user/message and assistant/message (text parts only; reasoning is
//            deliberately never returned)
//   tool     tool/result text parts (tool output)
//   call     tool/call arguments (opt-in; arguments may be sensitive)
//
// The per-turn indexes are stable and 0-based:
//   messageIndex  counts user + assistant messages in seq order
//   toolIndex     counts tool results in seq order
//   callIndex     counts tool calls in seq order
//
// system/message and developer/message are not exposed at all: D3 is about
// conversation and tool output, and the system prompt has no business being
// fetched through a session reader.

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message']);

export const ORIGINAL_KINDS = Object.freeze(['tool', 'message', 'call', 'all']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Join the text parts of a content array; non-text parts are counted, not copied. */
export function textOfParts(content) {
  const texts = [];
  let nonTextParts = 0;
  for (const part of asArray(content)) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    } else if (part) {
      nonTextParts += 1;
    }
  }
  return { text: texts.join('\n'), nonTextParts };
}

function itemBase(event, data) {
  return {
    seq: event?.seq,
    time: event?.time ?? null,
    step: Number.isInteger(data?.step) ? data.step : null,
  };
}

function messageItem(event, role) {
  const data = event?.data ?? {};
  const content = data.message?.content ?? data.content;
  const { text, nonTextParts } = textOfParts(content);
  return {
    ...itemBase(event, data),
    kind: 'message',
    role,
    text,
    nonTextParts,
    toolCallId: null,
    toolName: null,
    isError: false,
    messageIndex: null,
    toolIndex: null,
    callIndex: null,
  };
}

function callItem(event) {
  const data = event?.data ?? {};
  const args = typeof data.arguments === 'string'
    ? data.arguments
    : (data.arguments == null ? '' : JSON.stringify(data.arguments));
  return {
    ...itemBase(event, data),
    kind: 'call',
    role: 'tool',
    text: args,
    nonTextParts: 0,
    toolCallId: typeof data.callId === 'string' ? data.callId : null,
    toolName: typeof data.name === 'string' ? data.name : null,
    isError: false,
    messageIndex: null,
    toolIndex: null,
    callIndex: null,
  };
}

function resultItem(event) {
  const data = event?.data ?? {};
  const message = data.message ?? {};
  const { text, nonTextParts } = textOfParts(message.content ?? data.content);
  return {
    ...itemBase(event, data),
    kind: 'tool',
    role: 'tool',
    text,
    nonTextParts,
    toolCallId: typeof message.toolCallId === 'string'
      ? message.toolCallId
      : (typeof data.toolCallId === 'string' ? data.toolCallId : null),
    toolName: typeof data.name === 'string' ? data.name : null,
    isError: message.isError === true,
    messageIndex: null,
    toolIndex: null,
    callIndex: null,
  };
}

/**
 * Group the four addressable event types by turn.
 *
 * A user/message usually has no `data.turn` (the live host omits it); it is
 * attributed to the most recent turn/start. A log whose visible prefix was
 * truncated can begin with a user message before its turn/start: such items
 * wait in `pending` and join the first turn that becomes known.
 *
 * Returns Map<turn, item[]> with items sorted by seq and indexes assigned.
 */
export function buildTurnItems(events) {
  const turns = new Map();
  const pending = [];
  let current = null;

  const add = (turn, item) => {
    if (!turns.has(turn)) turns.set(turn, []);
    turns.get(turn).push(item);
  };
  const flushPending = (turn) => {
    while (pending.length > 0) add(turn, pending.shift());
  };

  for (const event of asArray(events)) {
    const type = event?.type;
    const data = event?.data ?? {};
    if (type === 'turn/start') {
      if (Number.isInteger(data.turn)) {
        current = data.turn;
        flushPending(current);
      }
      continue;
    }
    let item = null;
    if (type === 'user/message') item = messageItem(event, 'user');
    else if (type === 'assistant/message') item = messageItem(event, 'assistant');
    else if (type === 'tool/call') item = callItem(event);
    else if (type === 'tool/result') item = resultItem(event);
    if (!item) continue;

    const turn = Number.isInteger(data.turn) ? data.turn : current;
    if (turn == null) pending.push(item);
    else add(turn, item);
  }

  for (const [turn, items] of turns) {
    items.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    let messageIndex = 0;
    let toolIndex = 0;
    let callIndex = 0;
    for (const item of items) {
      item.turn = turn;
      item.index = items.indexOf(item);
      if (item.kind === 'message') item.messageIndex = messageIndex++;
      else if (item.kind === 'tool') item.toolIndex = toolIndex++;
      else if (item.kind === 'call') item.callIndex = callIndex++;
    }
    // A result usually has no tool name of its own; borrow the matching call.
    const names = new Map();
    for (const item of items) {
      if (item.kind === 'call' && item.toolCallId && item.toolName) names.set(item.toolCallId, item.toolName);
    }
    for (const item of items) {
      if (item.kind === 'tool' && !item.toolName && item.toolCallId) {
        item.toolName = names.get(item.toolCallId) ?? null;
      }
    }
  }
  return turns;
}

/** Sorted turn numbers present in a buildTurnItems() map. */
export function availableTurns(turns) {
  return [...turns.keys()].sort((a, b) => a - b);
}

/**
 * Select items of one turn. Explicit selectors win over `kind`:
 *   messageIndex -> the one message with that index
 *   toolCallId   -> the tool result(s) and/or call with that call id
 * A miss is returned as a coded error, never an empty list that hides a typo.
 */
export function selectTurnItems(items, { kind = 'tool', toolCallId = null, messageIndex = null } = {}) {
  const list = asArray(items);
  if (messageIndex != null) {
    const hits = list.filter((item) => item.kind === 'message' && item.messageIndex === messageIndex);
    if (hits.length === 0) {
      return {
        error: {
          code: 'MESSAGE_INDEX_OUT_OF_RANGE',
          message: `messageIndex ${messageIndex} does not exist in this turn ` +
            `(the turn has ${list.filter((item) => item.kind === 'message').length} message(s))`,
        },
      };
    }
    return { items: hits };
  }
  if (toolCallId) {
    const hits = list.filter((item) => {
      if (item.toolCallId !== toolCallId) return false;
      if (kind === 'all') return item.kind === 'tool' || item.kind === 'call';
      if (kind === 'tool') return item.kind === 'tool';
      if (kind === 'call') return item.kind === 'call';
      return false;
    });
    if (hits.length === 0) {
      return {
        error: {
          code: 'TOOL_CALL_NOT_FOUND',
          message: `no ${kind === 'all' ? 'tool call/result' : kind} with toolCallId ${JSON.stringify(toolCallId)} in this turn`,
        },
      };
    }
    return { items: hits };
  }
  if (kind === 'all') return { items: list };
  return { items: list.filter((item) => item.kind === kind) };
}

/**
 * The logical text of a selection. One item is returned verbatim; several are
 * separated by stable markers so paging offsets are reproducible across calls.
 */
export function joinTurnItems(items) {
  const list = asArray(items);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0].text;
  return list.map((item) => {
    const id = item.kind === 'message'
      ? `#${item.messageIndex}`
      : (item.toolCallId ? ` ${item.toolCallId}` : ` #${item.index}`);
    return `===== [${item.kind}${id} seq=${item.seq}] =====\n${item.text}`;
  }).join('\n\n');
}

/**
 * Slice a string by UTF-8 bytes without splitting a code point.
 *
 * `offset` is a byte offset. If it lands inside a multi-byte character it is
 * moved back to that character's first byte, so the returned `offset` is the
 * one actually used. `nextOffset` is `end` while more bytes remain.
 */
export function sliceUtf8(text, offset = 0, maxBytes = 65536) {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  const totalBytes = buf.length;
  let start = Math.min(Math.max(0, Number.isInteger(offset) ? offset : 0), totalBytes);
  while (start > 0 && start < totalBytes && (buf[start] & 0xc0) === 0x80) start -= 1;

  let end = Math.min(start + Math.max(1, maxBytes), totalBytes);
  while (end > start && end < totalBytes && (buf[end] & 0xc0) === 0x80) end -= 1;

  return {
    content: buf.subarray(start, end).toString('utf8'),
    offset: start,
    end,
    totalBytes,
    returnedBytes: end - start,
    nextOffset: end < totalBytes ? end : null,
  };
}

/**
 * D2 archive filename for one selected item. The convention is
 * `<memoryRoot>/.longlive/tool-output/<turn>/<id>.txt`.
 *
 * A tool result uses its toolCallId (D2's natural id); a message uses
 * `msg-<messageIndex>`; a tool call uses `call-<callId>` so it cannot collide
 * with the result of the same call.
 */
export function archiveFileName(item) {
  let raw;
  if (item.kind === 'tool') raw = item.toolCallId || `result-${item.seq}`;
  else if (item.kind === 'call') raw = item.toolCallId ? `call-${item.toolCallId}` : `call-${item.seq}`;
  else raw = `msg-${item.messageIndex ?? item.seq}`;
  const safe = String(raw)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 96);
  return `${safe || `item-${item.seq}`}.txt`;
}

export { MESSAGE_TYPES };
