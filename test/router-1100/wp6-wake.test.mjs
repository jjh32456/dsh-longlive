// WP6 — Tier B wake gates (DESIGN §5.13, K27/K28).
//
// Every host seam is mocked: resolveAgent, followup, flush, session log size,
// clock and quota. These tests assert Router behaviour only; the five frozen
// host contracts still need a real-machine check (DESIGN §10.6 layer 2).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createWakeChannel, wakeIdFor } from '../../src/router/service/wake.mjs';
import { localDayKey } from '../../src/router/service/paths.mjs';
import { auditKinds, startedService, tempRoot, writeMemory } from './helpers.mjs';

const MB = 1024 * 1024;

function setupWake({ enabled = true, clock, config = {} } = {}) {
  const temp = tempRoot('wp6-wake-');
  const vaultDir = path.join(temp, 'vault');
  const audit = [];
  const clockRef = clock ?? { ms: new Date(2026, 10, 5, 10, 0, 0).getTime() };
  const channel = createWakeChannel({
    vaultDir,
    config: {
      wakeEnabled: enabled,
      wakeCooldownMs: 600_000,
      wakeDailyQuota: 20,
      wakeLogMaxBytes: 32 * MB,
      ...config,
    },
    now: () => new Date(clockRef.ms),
    audit: (kind, data = {}) => audit.push({ kind, ...data }),
  });
  return {
    temp,
    vaultDir,
    audit,
    clock: clockRef,
    channel,
    stateFile: path.join(vaultDir, 'wake-state.json'),
    readyFile: path.join(vaultDir, 'wake-ready.jsonl'),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

function addReady(env, overrides = {}) {
  const createdAt = new Date(env.clock.ms).toISOString();
  const result = env.channel.appendReady({
    origin: { sessionId: 's1' },
    queue: { ticket: 'q-0001' },
    target: 'journal/2026-11.md',
    op: 'journal.append',
    title: 'secret-title-do-not-leak',
    createdAt,
    ...overrides,
  });
  assert.equal(result.ok, true);
  return result.entry;
}

function makeHost({ flushOk = true, resolveError = null, logSize = 1 * MB } = {}) {
  const calls = { resolve: 0, followup: 0, flush: 0, logSize: 0, messages: [] };
  const controller = {
    async resolveAgent(sessionId) {
      calls.resolve += 1;
      if (resolveError) throw resolveError;
      return {
        session: { id: sessionId },
        async followup(message) {
          calls.followup += 1;
          calls.messages.push(message);
        },
      };
    },
  };
  return {
    calls,
    controller,
    flush: async () => {
      calls.flush += 1;
      return flushOk;
    },
    sessionLogSize: async () => {
      calls.logSize += 1;
      return logSize;
    },
  };
}

function idleSessions(...ids) {
  return ids.map((sessionId) => ({ sessionId, state: 'idle', isSubagent: false }));
}

test('Tier B: default off is an exact no-op (no read, no host call, no state file, no audit)', async () => {
  const env = setupWake({ enabled: false });
  try {
    const host = makeHost();
    addReady(env);
    const before = fs.readFileSync(env.readyFile, 'utf8');
    const result = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.reason, 'disabled');
    assert.equal(result.delivered, 0);
    assert.equal(host.calls.resolve, 0);
    assert.equal(host.calls.followup, 0);
    assert.equal(host.calls.logSize, 0);
    assert.equal(fs.existsSync(env.stateFile), false);
    assert.equal(env.audit.length, 0);
    assert.equal(fs.readFileSync(env.readyFile, 'utf8'), before);
  } finally {
    env.cleanup();
  }
});

test('Tier B: delivers a schedule message with ticket+target only, then records the attempt', async () => {
  const env = setupWake();
  try {
    const host = makeHost({ logSize: 1 * MB });
    const entry = addReady(env);
    const result = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.delivered, 1);
    assert.equal(result.todayCount, 1);
    assert.equal(host.calls.resolve, 1);
    assert.equal(host.calls.followup, 1);
    assert.equal(host.calls.flush, 1);
    const message = host.calls.messages[0];
    assert.equal(message.source.kind, 'schedule');
    assert.equal(message.role, 'user');
    assert.ok(typeof message.id === 'string' && message.id.length > 0);
    const body = message.content[0].text;
    assert.ok(body.length <= 200, `body must stay <=200 chars, got ${body.length}`);
    assert.ok(body.includes('q-0001'));
    assert.ok(body.includes('journal/2026-11.md'));
    assert.ok(!body.includes('secret-title-do-not-leak'), 'body must not contain the proposal body/title');
    assert.ok(env.audit.some((row) => row.kind === 'wake.attempt' && row.reason === 'delivered'));
    const state = JSON.parse(fs.readFileSync(env.stateFile, 'utf8'));
    assert.equal(state.count, 1);
    assert.ok(state.recentWakeIds[entry.id]);
    assert.equal(state.sessions.s1.lastError, null);
  } finally {
    env.cleanup();
  }
});

test('K28: 0s delivers, 300s is E_WAKE_COOLDOWN, 601s delivers the next ticket', async () => {
  const env = setupWake();
  try {
    const host = makeHost();
    addReady(env, { queue: { ticket: 'q-0001' } });
    const first = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(first.delivered, 1);
    assert.equal(host.calls.followup, 1);

    addReady(env, { queue: { ticket: 'q-0002' } });
    env.clock.ms += 300_000;
    const cooling = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(cooling.delivered, 0);
    assert.ok(cooling.denied.some((row) => row.code === 'E_WAKE_COOLDOWN'));
    assert.ok(cooling.denied.find((row) => row.code === 'E_WAKE_COOLDOWN').cooldownRemainingMs > 0);
    assert.equal(host.calls.followup, 1);

    env.clock.ms += 301_000;
    const second = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(second.delivered, 1);
    assert.equal(host.calls.followup, 2);
    assert.ok(host.calls.messages[1].content[0].text.includes('q-0002'));
  } finally {
    env.cleanup();
  }
});

test('K28: running/blocked roots are E_WAKE_NOT_ELIGIBLE(not-idle); subagents are skipped before resolve', async () => {
  const env = setupWake();
  try {
    const host = makeHost();
    addReady(env);
    for (const state of ['running', 'blocked', 'dead']) {
      const result = await env.channel.runCycle({
        sessions: [{ sessionId: 's1', state, isSubagent: false }],
        sessionController: host.controller,
        flush: host.flush,
        sessionLogSize: host.sessionLogSize,
      });
      assert.equal(result.delivered, 0);
      assert.ok(result.denied.some((row) => row.code === 'E_WAKE_NOT_ELIGIBLE' && row.reason === 'not-idle'));
    }
    const subagent = await env.channel.runCycle({
      sessions: [{ sessionId: 's1', state: 'idle', isSubagent: true }],
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(subagent.delivered, 0);
    assert.ok(subagent.denied.some((row) => row.code === 'E_WAKE_NOT_ELIGIBLE' && row.reason === 'subagent'));
    assert.equal(host.calls.resolve, 0);
    assert.equal(host.calls.followup, 0);
  } finally {
    env.cleanup();
  }
});

test('K28: 33MB cold log is E_WAKE_LOG_TOO_LARGE with zero resolveAgent; 1MB resolves and delivers', async () => {
  const large = setupWake();
  try {
    const host = makeHost({ logSize: 33 * MB });
    addReady(large);
    const result = await large.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.delivered, 0);
    assert.ok(result.denied.some((row) => row.code === 'E_WAKE_LOG_TOO_LARGE'));
    assert.equal(host.calls.resolve, 0);
    assert.equal(host.calls.followup, 0);
    assert.equal(large.channel.status().lastError, 'E_WAKE_LOG_TOO_LARGE');
    assert.equal(host.calls.logSize, 1);
  } finally {
    large.cleanup();
  }

  const small = setupWake();
  try {
    const host = makeHost({ logSize: 1 * MB });
    addReady(small);
    const result = await small.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.delivered, 1);
    assert.equal(host.calls.resolve, 1);
    assert.equal(host.calls.followup, 1);
  } finally {
    small.cleanup();
  }
});

test('K28: unavailable log size is E_WAKE_NOT_ELIGIBLE(log-size-unavailable) and never resolves', async () => {
  const env = setupWake();
  try {
    const host = makeHost({ logSize: null });
    addReady(env);
    const result = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.delivered, 0);
    assert.ok(result.denied.some((row) => row.code === 'E_WAKE_NOT_ELIGIBLE' && row.reason === 'log-size-unavailable'));
    assert.equal(host.calls.resolve, 0);
    assert.equal(env.channel.status().lastError, 'log-size-unavailable');
  } finally {
    env.cleanup();
  }
});

test('K28: the 21st idle root hits E_WAKE_QUOTA after exactly 20 deliveries', async () => {
  const env = setupWake();
  try {
    const host = makeHost();
    const ids = Array.from({ length: 21 }, (_, index) => `s${index + 1}`);
    ids.forEach((sessionId, index) => addReady(env, {
      origin: { sessionId },
      queue: { ticket: `q-${String(index + 1).padStart(4, '0')}` },
    }));
    const result = await env.channel.runCycle({
      sessions: idleSessions(...ids),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.delivered, 20);
    assert.equal(host.calls.followup, 20);
    assert.equal(result.todayCount, 20);
    assert.equal(result.denied.length, 1);
    assert.equal(result.denied[0].code, 'E_WAKE_QUOTA');
    assert.equal(env.channel.status().todayCount, 20);
  } finally {
    env.cleanup();
  }
});

test('K28: flush failure records wake.flush_failed; the same wakeId is never resent (wake.deduped)', async () => {
  const env = setupWake();
  try {
    const host = makeHost({ flushOk: false });
    const entry = addReady(env);
    const first = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(first.delivered, 1);
    assert.equal(host.calls.followup, 1);
    assert.ok(env.audit.some((row) => row.kind === 'wake.flush_failed'));

    env.clock.ms += 601_000;
    const retry = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(retry.delivered, 0);
    assert.ok(retry.denied.some((row) => row.code === 'E_WAKE_DEDUPED'));
    assert.ok(env.audit.some((row) => row.kind === 'wake.deduped' && row.reason === 'flush-retry'));
    assert.equal(host.calls.followup, 1);
    assert.ok(JSON.parse(fs.readFileSync(env.stateFile, 'utf8')).recentWakeIds[entry.id]);
  } finally {
    env.cleanup();
  }
});

test('Tier B: resolveAgent not-found skips and consumes the wakeId; writer-held backs off without consuming', async () => {
  const notFound = setupWake();
  try {
    const host = makeHost({
      resolveError: Object.assign(new Error('session/not-found'), { code: 'session/not-found' }),
    });
    addReady(notFound);
    const result = await notFound.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.delivered, 0);
    assert.ok(result.skipped.some((row) => row.reason === 'not-found'));
    assert.equal(host.calls.followup, 0);
    assert.equal(notFound.channel.status().todayCount, 1);
  } finally {
    notFound.cleanup();
  }

  const writerHeld = setupWake();
  try {
    const host = makeHost({
      resolveError: Object.assign(new Error('session/writer-held'), { code: 'session/writer-held' }),
    });
    addReady(writerHeld);
    const result = await writerHeld.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.delivered, 0);
    assert.ok(result.skipped.some((row) => row.reason === 'writer-held'));
    assert.equal(writerHeld.channel.status().todayCount, 0, 'a held writer must not spend daily quota');
    writerHeld.clock.ms += 300_000;
    const cooled = await writerHeld.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.ok(cooled.denied.some((row) => row.code === 'E_WAKE_COOLDOWN'));
    assert.equal(host.calls.resolve, 1);
  } finally {
    writerHeld.cleanup();
  }
});

test('Tier B: a stale entry (>24h) is never considered even if the session is idle', async () => {
  const env = setupWake();
  try {
    const host = makeHost();
    env.clock.ms += 25 * 60 * 60 * 1000;
    addReady(env, { createdAt: new Date(env.clock.ms - 25 * 60 * 60 * 1000).toISOString() });
    const result = await env.channel.runCycle({
      sessions: idleSessions('s1'),
      sessionController: host.controller,
      flush: host.flush,
      sessionLogSize: host.sessionLogSize,
    });
    assert.equal(result.delivered, 0);
    assert.equal(host.calls.resolve, 0);
    assert.equal(env.channel.status().readyCount, 0);
  } finally {
    env.cleanup();
  }
});

test('K27: service tick with wakeEnabled=false does zero followup/resolve and writes no wake state', async () => {
  const calls = { resolve: 0, followup: 0 };
  const sessionController = {
    async resolveAgent() { calls.resolve += 1; throw new Error('must not be called'); },
  };
  const env = await startedService({
    config: { proposalEnabled: true, wakeEnabled: false },
    deps: {
      wakeSessions: idleSessions('root-session', 'other-session'),
      sessionController,
      flushSessions: async () => { calls.followup += 1; return true; },
      sessionLogSize: () => 1 * MB,
    },
  });
  try {
    const first = await env.service.proposalEngine.propose({
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'one',
      content: 'body-one',
    }, { caller: { kind: 'root', sessionId: 'root-session' } });
    const second = await env.service.proposalEngine.propose({
      op: 'topic.append',
      target: 'topics/other.md',
      title: 'two',
      content: 'body-two',
    }, { caller: { kind: 'root', sessionId: 'other-session' } });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    await env.service.tick({ reason: 'manual' });
    await env.service.tick({ reason: 'manual' });
    assert.equal(calls.resolve, 0);
    assert.equal(calls.followup, 0);
    assert.equal(fs.existsSync(path.join(env.vaultDir, 'wake-state.json')), false);
    const lines = fs.readFileSync(path.join(env.vaultDir, 'wake-ready.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const wakeKinds = auditKinds(path.join(env.vaultDir, 'audit.jsonl')).filter((kind) => kind.startsWith('wake.'));
    assert.deepEqual(wakeKinds, [], 'disabled wake must emit no E_WAKE_* audit noise');
  } finally {
    await env.service.dispose?.();
    env.cleanup();
  }
});

test('K27 control: the same tick with wakeEnabled=true delivers exactly one schedule followup', async () => {
  const calls = { resolve: 0, followup: 0, messages: [] };
  const sessionController = {
    async resolveAgent(sessionId) {
      calls.resolve += 1;
      return {
        session: { id: sessionId },
        async followup(message) { calls.followup += 1; calls.messages.push(message); },
      };
    },
  };
  const env = await startedService({
    config: { proposalEnabled: true, wakeEnabled: true },
    deps: {
      wakeSessions: idleSessions('root-session'),
      sessionController,
      flushSessions: async () => true,
      sessionLogSize: () => 1 * MB,
    },
  });
  try {
    const created = await env.service.proposalEngine.propose({
      op: 'journal.append',
      target: 'journal/2026-11.md',
      title: 'one',
      content: 'body-one',
    }, { caller: { kind: 'root', sessionId: 'root-session' } });
    assert.equal(created.ok, true);
    await env.service.tick({ reason: 'manual' });
    assert.equal(calls.resolve, 1);
    assert.equal(calls.followup, 1);
    assert.equal(calls.messages[0].source.kind, 'schedule');
    const status = env.service.status();
    assert.equal(status.wake.enabled, true);
    assert.equal(status.wake.todayCount, 1);
  } finally {
    await env.service.dispose?.();
    env.cleanup();
  }
});

test('wakeIdFor: retry ids differ from the base id (M-16 deliberate retry)', () => {
  const base = wakeIdFor('s1', 'q-0001', localDayKey(new Date(2026, 10, 5)));
  assert.notEqual(base, wakeIdFor('s1', 'q-0001', localDayKey(new Date(2026, 10, 5)), 1));
});
