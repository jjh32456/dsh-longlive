// Fixture builder for the resident session watchdog drill.
//
// The drill must never touch a real session. Everything it needs is a v4
// session log encoded by the package's own codec, plus (optionally) a live
// registry row that makes the watchdog treat the file as owned by a host.
// Keeping the builder next to the watcher means the drill and the watcher
// agree on the exact on-disk shape: a fixture that parses here parses in the
// CLI, because both call src/codec.js.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { encodeSession } from '../../src/codec.js';

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * Build a realistic v4 session: one system message, a title, then N turns of
 * user -> assistant(tool call) -> tool result -> assistant(text). Long text is
 * padded so a fixture can cross a low token threshold without needing hundreds
 * of turns.
 */
export function buildFixture({
  id,
  turns = 20,
  title = 'session-watch drill fixture',
  padding = 0,
  createdAt = BASE_TIME,
} = {}) {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('fixture id is required');
  const events = [];
  const base = createdAt;
  const push = (event) => {
    event.seq = events.length;
    event.time = base + events.length;
    events.push(event);
  };
  const pad = 'x'.repeat(Math.max(0, padding));
  push({
    type: 'system/message',
    surfaceOp: 'append',
    data: {
      message: {
        role: 'system',
        id: 'system-1',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: `fixture system prompt ${pad}` }],
      },
    },
  });
  if (title) {
    push({
      type: 'session/title',
      data: { title, messageSeqs: [], source: { kind: 'user' } },
    });
  }
  for (let turn = 1; turn <= turns; turn += 1) {
    push({ type: 'turn/start', data: { turn } });
    push({ type: 'step/start', data: { turn, step: 1 } });
    push({
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        turn,
        step: 1,
        role: 'user',
        id: `user-${turn}`,
        content: [{ type: 'text', text: `question ${turn} ${pad}` }],
        source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      },
    });
    push({
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn,
        step: 1,
        stream: [],
        message: {
          role: 'assistant',
          id: `assistant-call-${turn}`,
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          content: [{ type: 'tool-call', id: `call-${turn}`, name: 'demo', arguments: '{"n":1}' }],
        },
      },
    });
    push({
      type: 'tool/call',
      data: { turn, step: 1, callId: `call-${turn}`, name: 'demo', arguments: '{"n":1}' },
    });
    push({
      type: 'tool/result',
      surfaceOp: 'append',
      sourceEventSeqs: [events.length - 1],
      data: {
        turn,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: `call-${turn}` },
          toolCallId: `call-${turn}`,
          content: [{ type: 'text', text: `{"ok":true,"turn":${turn}} ${pad}` }],
          isError: false,
          id: `result-${turn}`,
        },
      },
    });
    push({
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn,
        step: 1,
        stream: [],
        message: {
          role: 'assistant',
          id: `assistant-${turn}`,
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          content: [{ type: 'text', text: `answer ${turn} ${pad}` }],
        },
      },
    });
    push({ type: 'step/end', data: { turn, step: 1 } });
    push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  }
  return {
    header: {
      type: 'session',
      version: 4,
      id,
      createdAt: base,
      cwd: 'C' + ':' + '\\drill\\fixture',
      isSeeded: false,
      delegationDepth: 0,
    },
    events,
  };
}

export function fixturePath(sessionsRoot, scope, id) {
  return path.join(sessionsRoot, scope, id, 'session.v4.jsonl.zstd');
}

export function writeFixture({
  sessionsRoot,
  scope = 'scope-drill',
  id,
  turns = 20,
  padding = 0,
  title,
} = {}) {
  if (!sessionsRoot) throw new Error('sessionsRoot is required');
  const { header, events } = buildFixture({ id, turns, padding, title });
  const file = fixturePath(sessionsRoot, scope, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeSession(header, events));
  return { file, header, events, bytes: fs.statSync(file).size };
}

/**
 * Write a live-registry row. This is how the drill proves the health gate:
 * a fresh heartbeat must block a cut even though the file is not open by any
 * process. `state: 'running'` with `pid: process.pid` is the realistic shape;
 * the pid is alive but the watchdog must still refuse on the heartbeat alone.
 */
export function writeLiveRow({
  memoryRoot,
  sessionId,
  state = 'running',
  pid = process.pid,
  host = os.hostname(),
  ttlMs = 60_000,
  now = Date.now(),
  goal = 'fixture session is being written',
} = {}) {
  if (!memoryRoot || !sessionId) throw new Error('memoryRoot and sessionId are required');
  const iso = new Date(now).toISOString();
  const row = {
    schemaVersion: 1,
    sessionId,
    pid,
    host,
    startedAt: iso,
    updatedAt: iso,
    heartbeatAt: iso,
    ttlMs,
    state,
    turn: 1,
    goal,
    blocked_on: '',
    queued: [],
    last_action: { at: iso, kind: 'drill', detail: 'fixture live row' },
  };
  const dir = path.join(memoryRoot, '.longlive', 'live');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(row, null, 2)}\n`);
  return { file, row };
}

export function writeCorruptSession({ sessionsRoot, scope = 'scope-drill', id } = {}) {
  const file = fixturePath(sessionsRoot, scope, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not a zstd session\n');
  return file;
}
