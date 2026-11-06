// D3 — session_original: fetch one turn out of a session log.
//
// Every fixture is a real encoded v4 log under a throwaway DSH home. The suite
// covers the four acceptance cases (hit, missing turn, truncation, privacy) plus
// the selection and read-only edges that make the tool safe to expose:
//   - a hit returns the tool output verbatim and reports a D2 archive path
//     without writing it;
//   - a missing turn / call id is a structured error, never a throw;
//   - truncation pages by UTF-8 bytes and reassembles into the exact original;
//   - the privacy gate scans the FULL selection, so offset/maxBytes cannot
//     page around a match;
//   - a corrupt log is reported as SESSION_CORRUPT.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { TOOLS } from '../src/tools.js';
import { sessionOriginal } from '../src/tools.js';
import { encodeSession } from '../src/codec.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-d3-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeRoot(label) {
  const root = path.join(TMP, label);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Build events with contiguous seq values, starting at 0. */
function eventBuilder() {
  const events = [];
  const push = (type, data) => {
    events.push({
      seq: events.length,
      type,
      time: Date.now() - 3_600_000 + events.length,
      data,
    });
  };
  return { events, push };
}

function writeSession(root, id, events, { corrupt = false } = {}) {
  const dir = path.join(root, 'sessions', 'scope-d3', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: Date.now(),
    cwd: root,
    isSeeded: false,
    delegationDepth: 0,
  };
  fs.writeFileSync(file, corrupt ? Buffer.from('this is not a zstd session log') : encodeSession(header, events));
  return file;
}

function configFor(root) {
  return { home: root, memoryRoot: path.join(root, 'memory') };
}

function recipe({ toolOutput = 'TOOL-OUTPUT', includeSecondTurn = true } = {}) {
  const { events, push } = eventBuilder();
  push('turn/start', { turn: 1 });
  push('user/message', {
    content: [{ type: 'text', text: 'question one' }],
    source: { kind: 'user' },
    role: 'user',
    id: 'user-1',
  });
  push('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer one' }, { type: 'reasoning', text: 'private chain' }],
    },
    usage: {},
    stream: false,
  });
  push('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'demo_tool',
    arguments: '{"query":"alpha"}',
  });
  push('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
      content: [{ type: 'text', text: toolOutput }],
      isError: false,
      id: 'result-1',
    },
    meta: {},
  });
  if (includeSecondTurn) {
    push('turn/start', { turn: 2 });
    push('user/message', {
      content: [{ type: 'text', text: 'question two' }],
      source: { kind: 'user' },
      role: 'user',
      id: 'user-2',
    });
    push('tool/call', {
      turn: 2,
      step: 1,
      callId: 'call-2',
      name: 'other_tool',
      arguments: '{}',
    });
  }
  return events;
}

test('session_original is registered exactly once with the documented parameters', () => {
  const matches = TOOLS.filter((tool) => tool.name === 'session_original');
  assert.equal(matches.length, 1, 'session_original must be registered exactly once');
  const [tool] = matches;
  assert.equal(typeof tool.invoke, 'function');
  assert.equal(tool.parameters.turn.type, 'integer');
  assert.deepEqual(tool.parameters.kind.enum, ['tool', 'message', 'call', 'all']);
  assert.equal(tool.parameters.toolCallId.type, 'string');
  assert.equal(tool.parameters.messageIndex.type, 'integer');
  assert.equal(tool.parameters.maxBytes.type, 'integer');
  assert.equal(tool.parameters.offset.type, 'integer');
  assert.equal(typeof tool.output.render, 'function');
});

test('hit: returns the tool output verbatim and reports the D2 archive path without writing it', () => {
  const root = makeRoot('hit');
  const text = `TOOL-OUTPUT ${'A'.repeat(5000)}`;
  const file = writeSession(root, 'hit-session', recipe({ toolOutput: text }));
  const config = configFor(root);

  const value = sessionOriginal({ sessionPath: file, turn: 1 }, config);
  assert.equal(value.ok, true);
  assert.equal(value.status, 'ok');
  assert.equal(value.content, text);
  assert.equal(value.totalBytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(value.returnedBytes, value.totalBytes);
  assert.equal(value.truncated, false);
  assert.equal(value.nextOffset, null);
  assert.equal(value.selectedCount, 1);
  assert.equal(value.selected[0].toolCallId, 'call-1');
  assert.equal(value.selected[0].toolName, 'demo_tool');
  assert.ok(value.archives[0].path.endsWith(path.join('tool-output', '1', 'call-1.txt')));
  assert.equal(value.archives[0].exists, false);
  assert.equal(fs.existsSync(path.join(config.memoryRoot, '.longlive')), false, 'read-only: no archive tree');
});

test('turn attribution: user messages with no data.turn belong to the preceding turn/start', () => {
  const root = makeRoot('attribution');
  const file = writeSession(root, 'attribution-session', recipe());
  const config = configFor(root);

  const first = sessionOriginal({ sessionPath: file, turn: 1, kind: 'message', messageIndex: 0 }, config);
  assert.equal(first.ok, true);
  assert.equal(first.content, 'question one');

  const second = sessionOriginal({ sessionPath: file, turn: 2, kind: 'message', messageIndex: 0 }, config);
  assert.equal(second.ok, true);
  assert.equal(second.content, 'question two');
  assert.equal(second.selected[0].seq, 6);
});

test('reasoning parts are never returned as message text', () => {
  const root = makeRoot('reasoning');
  const file = writeSession(root, 'reasoning-session', recipe());
  const value = sessionOriginal({ sessionPath: file, turn: 1, kind: 'message', messageIndex: 1 }, configFor(root));
  assert.equal(value.ok, true);
  assert.equal(value.content, 'answer one');
  assert.equal(value.selected[0].nonTextParts, 1);
});

test('missing turn: structured TURN_NOT_FOUND with the available turns', () => {
  const root = makeRoot('missing-turn');
  const file = writeSession(root, 'missing-turn-session', recipe());
  const value = sessionOriginal({ sessionPath: file, turn: 99 }, configFor(root));
  assert.equal(value.ok, false);
  assert.equal(value.status, 'error');
  assert.equal(value.code, 'TURN_NOT_FOUND');
  assert.equal(value.error.code, 'TURN_NOT_FOUND');
  assert.deepEqual(value.availableTurns, [1, 2]);
  assert.equal(value.turnCount, 2);
});

test('truncation: pages on UTF-8 boundaries and reassembles into the exact original', () => {
  const root = makeRoot('truncate');
  const full = `${'汉字🙂'.repeat(1500)}END`;
  const file = writeSession(root, 'truncate-session', recipe({ toolOutput: full }));
  const config = configFor(root);

  let offset = 0;
  let rebuilt = '';
  let pages = 0;
  let firstTruncated = null;
  for (;;) {
    const value = sessionOriginal({ sessionPath: file, turn: 1, maxBytes: 1024, offset }, config);
    assert.equal(value.ok, true);
    assert.ok(value.returnedBytes <= 1024, `page returned ${value.returnedBytes} bytes`);
    assert.equal(value.content.includes('\uFFFD'), false, 'a page split a code point');
    assert.equal(value.offset, offset);
    rebuilt += value.content;
    pages += 1;
    if (firstTruncated == null) firstTruncated = value.truncated;
    if (value.nextOffset == null) break;
    assert.ok(value.nextOffset > offset, 'nextOffset must advance');
    offset = value.nextOffset;
    assert.ok(pages < 1000, 'paging did not terminate');
  }
  assert.equal(firstTruncated, true);
  assert.equal(rebuilt, full);
  assert.equal(Buffer.byteLength(rebuilt, 'utf8'), Buffer.byteLength(full, 'utf8'));
  assert.ok(pages > 1, 'the fixture must actually need more than one page');
});

test('maxBytes below the floor is clamped, not rejected', () => {
  const root = makeRoot('clamp');
  const file = writeSession(root, 'clamp-session', recipe({ toolOutput: 'B'.repeat(4096) }));
  const value = sessionOriginal({ sessionPath: file, turn: 1, maxBytes: 10 }, configFor(root));
  assert.equal(value.ok, true);
  assert.equal(value.maxBytes, 1024);
  assert.equal(value.returnedBytes, 1024);
  assert.equal(value.truncated, true);
});

test('privacy: a phone number in the FULL selection blocks every page and returns no content', () => {
  const root = makeRoot('privacy');
  const file = writeSession(root, 'privacy-session', recipe({ toolOutput: 'secret 13800138000 tail' }));
  const config = configFor(root);

  for (const args of [
    { sessionPath: file, turn: 1 },
    { sessionPath: file, turn: 1, offset: 3, maxBytes: 1024 },
    { sessionPath: file, turn: 1, maxBytes: 4096 },
  ]) {
    const value = sessionOriginal(args, config);
    assert.equal(value.ok, false);
    assert.equal(value.status, 'blocked');
    assert.equal(value.code, 'PRIVACY_BLOCKED');
    assert.equal(Object.prototype.hasOwnProperty.call(value, 'content'), false);
    assert.equal(value.privacy.verdict, 'local_only');
    assert.ok(value.privacy.reasons.includes('phone'));
  }
  assert.equal(fs.existsSync(path.join(config.memoryRoot, '.longlive')), false);
});

test('toolCallId narrows a turn with several tool results', () => {
  const root = makeRoot('callid');
  const { events, push } = eventBuilder();
  push('turn/start', { turn: 1 });
  for (const [callId, text] of [['call-a', 'alpha output'], ['call-b', 'beta output']]) {
    push('tool/call', { turn: 1, step: 1, callId, name: 'demo', arguments: '{}' });
    push('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
      },
    });
  }
  const file = writeSession(root, 'callid-session', events);
  const config = configFor(root);

  const beta = sessionOriginal({ sessionPath: file, turn: 1, toolCallId: 'call-b' }, config);
  assert.equal(beta.ok, true);
  assert.equal(beta.content, 'beta output');
  assert.equal(beta.selectedCount, 1);

  const missing = sessionOriginal({ sessionPath: file, turn: 1, toolCallId: 'nope' }, config);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'TOOL_CALL_NOT_FOUND');
  assert.deepEqual(
    missing.toolCalls.map((entry) => entry.toolCallId),
    ['call-a', 'call-a', 'call-b', 'call-b'],
  );
});

test('an empty kind is a successful "empty" status, not an error', () => {
  const root = makeRoot('empty');
  const file = writeSession(root, 'empty-session', recipe());
  const value = sessionOriginal({ sessionPath: file, turn: 2 }, configFor(root));
  assert.equal(value.ok, true);
  assert.equal(value.status, 'empty');
  assert.equal(value.content, '');
  assert.equal(value.selectedCount, 0);
  assert.equal(value.truncated, false);
  assert.equal(value.nextOffset, null);
});

test('corrupt logs and bad arguments are structured errors, never throws', () => {
  const root = makeRoot('corrupt');
  const file = writeSession(root, 'corrupt-session', [], { corrupt: true });
  const config = configFor(root);

  const corrupt = sessionOriginal({ sessionPath: file, turn: 1 }, config);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.code, 'SESSION_CORRUPT');

  const badTurn = sessionOriginal({ sessionPath: file, turn: 0 }, config);
  assert.equal(badTurn.ok, false);
  assert.equal(badTurn.code, 'E_BAD_ARGUMENT');

  const badKind = sessionOriginal({ sessionPath: file, turn: 1, kind: 'nope' }, config);
  assert.equal(badKind.ok, false);
  assert.equal(badKind.code, 'E_BAD_ARGUMENT');

  const badSelector = sessionOriginal({ sessionPath: file, turn: 1, toolCallId: 'x', messageIndex: 0 }, config);
  assert.equal(badSelector.ok, false);
  assert.equal(badSelector.code, 'E_BAD_ARGUMENT');
});

test('sessionId resolution works through the normal session resolver', () => {
  const root = makeRoot('by-id');
  writeSession(root, 'by-id-session', recipe({ toolOutput: 'by id output' }));
  const value = sessionOriginal({ sessionId: 'by-id-session', turn: 1 }, configFor(root));
  assert.equal(value.ok, true);
  assert.equal(value.content, 'by id output');
  assert.equal(value.sessionId, 'by-id-session');
  assert.equal(value.scope, 'scope-d3');
});
