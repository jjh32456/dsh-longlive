import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStatus,
  writeStatus,
  storageErrorCode,
  STATUS_MAX_BYTES,
  STATUS_VERSION,
} from '../../src/router/service/status.mjs';

const NOW = '2026-11-05T00:30:00+08:00';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-status-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('minimal status is a complete v2 read-only projection', () => {
  const status = buildStatus({ now: NOW });
  assert.equal(status.v, STATUS_VERSION);
  assert.equal(status.v, 2);
  assert.equal(status.readOnly, true);
  assert.equal(status.state, 'stopped');
  assert.equal(status.reason, null);
  assert.deepEqual(status.provider, { configured: false, missing: true });
  assert.deepEqual(status.model, { auto: false, resolved: null, resolvedAt: null });
  assert.equal(status.agentMode, false);
  assert.deepEqual(status.run, { usedTokens: 0, capTokens: 0 });
  assert.deepEqual(status.tickQueue, { pending: 0, invalid: 0, oldestAgeMs: 0 });
  assert.deepEqual(status.queue, { pending: 0, queued: 0, applying: 0, blockedOnUser: 0, expired: 0 });
  assert.equal(status.board.pulse.unknownSessions, 0);
  assert.deepEqual(status.live, { rows: 0, maxRows: 128, unknown: 0 });
  assert.deepEqual(status.warnings, []);
  assert.deepEqual(status.alerts, []);
  assert.equal(status.lastError, null);
  assert.equal(status.lastReport, null);
  assert.deepEqual(Object.keys(status.files).sort(), ['anchor', 'audit', 'board', 'ledger', 'outbox', 'vault']);
});

test('provider exposes exactly two booleans and never endpoints or credentials', () => {
  const status = buildStatus({
    now: NOW,
    provider: {
      configured: true,
      missing: false,
      endpoint: 'https://secret.example/v1',
      apiKey: 'sk-do-not-leak',
      candidates: ['a', 'b'],
    },
  });
  assert.deepEqual(status.provider, { configured: true, missing: false });
  assert.equal(JSON.stringify(status).includes('sk-do-not-leak'), false);
  assert.equal(JSON.stringify(status).includes('secret.example'), false);

  const empty = buildStatus({ now: NOW, provider: 'mock' });
  assert.deepEqual(empty.provider, { configured: true, missing: false });
});

test('model reports auto and only the resolved identifier', () => {
  const auto = buildStatus({ now: NOW, model: { auto: true, resolved: '', resolvedAt: null } });
  assert.deepEqual(auto.model, { auto: true, resolved: null, resolvedAt: null });

  const resolved = buildStatus({
    now: NOW,
    model: { auto: true, resolved: 'deepseek-v4-flash', resolvedAt: NOW, candidates: ['x'] },
  });
  assert.deepEqual(Object.keys(resolved.model).sort(), ['auto', 'resolved', 'resolvedAt']);
  assert.equal(resolved.model.auto, true);
  assert.equal(resolved.model.resolved, 'deepseek-v4-flash');
  assert.equal(resolved.model.resolvedAt, NOW);

  const plain = buildStatus({ now: NOW, model: 'mock-1' });
  assert.deepEqual(plain.model, { auto: false, resolved: 'mock-1', resolvedAt: NOW });
});

test('tickQueue and the five proposal queue counters are separate', () => {
  const status = buildStatus({
    now: NOW,
    tickQueue: { pending: 2, invalid: 1, oldestAgeMs: 7 },
    queueStatus: { pending: 1, queued: 2, applying: 3, blockedOnUser: 4, expired: 5 },
  });
  assert.deepEqual(status.tickQueue, { pending: 2, invalid: 1, oldestAgeMs: 7 });
  assert.deepEqual(status.queue, { pending: 1, queued: 2, applying: 3, blockedOnUser: 4, expired: 5 });

  // 兼容 v1 形状的输入：无 tickQueue 时 queue 充当 tickQueue，queue 五键仍独立为零。
  const legacy = buildStatus({ now: NOW, queue: { pending: 9, invalid: 0, oldestAgeMs: 3 } });
  assert.deepEqual(legacy.tickQueue, { pending: 9, invalid: 0, oldestAgeMs: 3 });
  assert.deepEqual(legacy.queue, { pending: 0, queued: 0, applying: 0, blockedOnUser: 0, expired: 0 });
});

test('warnings are an open enum: known codes get catalog text, unknown codes stay verbatim', () => {
  const status = buildStatus({
    now: NOW,
    warnings: ['BOARD_STALE', 'board_stale', 'ZZ_CUSTOM'],
  });
  assert.deepEqual(status.warnings, ['BOARD_STALE', 'ZZ_CUSTOM']);
  assert.equal(status.alerts.length, 2);
  assert.equal(status.alerts[0].code, 'BOARD_STALE');
  assert.equal(status.alerts[0].severity, 'warn');
  assert.match(status.alerts[0].message, /看板/);
  assert.equal(status.alerts[1].code, 'ZZ_CUSTOM');
  assert.match(status.alerts[1].message, /ZZ_CUSTOM/);
});

test('severity=error alerts are mirrored into warnings, including unknown codes', () => {
  const status = buildStatus({
    now: NOW,
    warnings: ['WAKE_QUOTA'],
    alerts: [{ code: 'MY_CUSTOM_FATAL', severity: 'error', message: 'boom' }],
  });
  assert.ok(status.warnings.includes('MY_CUSTOM_FATAL'));
  assert.equal(status.alerts[0].code, 'MY_CUSTOM_FATAL');
  assert.equal(status.alerts[0].severity, 'error');
});

test('warnings and alerts are capped at eight with errors first', () => {
  const warnings = Array.from({ length: 12 }, (_, index) => `CUSTOM_${index}`);
  const alerts = [
    ...Array.from({ length: 6 }, (_, index) => ({ code: `A_${index}`, severity: 'info', message: 'i' })),
    ...Array.from({ length: 6 }, (_, index) => ({ code: `E_${index}`, severity: 'error', message: 'e' })),
  ];
  const status = buildStatus({ now: NOW, warnings, alerts });
  assert.equal(status.warnings.length, 8);
  assert.equal(status.alerts.length, 8);
  assert.equal(status.alerts[0].severity, 'error');
  for (const alert of status.alerts.filter((item) => item.severity === 'error')) {
    assert.ok(status.warnings.includes(alert.code));
  }
});

test('focus and blocked entries are bounded and never leak proposal bodies', () => {
  const focus = Array.from({ length: 12 }, (_, index) => ({
    sessionId: `s-${index}`,
    goal: 'g',
    updatedAt: NOW,
    content: 'SECRET BODY',
  }));
  const blocked = Array.from({ length: 12 }, (_, index) => ({
    ticket: `t-${index}`,
    reason: 'r',
    since: NOW,
    content: 'SECRET BODY',
  }));
  const status = buildStatus({ now: NOW, board: { focus }, proposals: { queue: { blocked } } });
  assert.equal(status.board.focus.length, 8);
  assert.deepEqual(Object.keys(status.board.focus[0]).sort(), ['goal', 'lastAction', 'queuedCount', 'sessionId', 'updatedAt']);
  assert.equal(status.proposals.queue.blocked.length, 8);
  assert.deepEqual(Object.keys(status.proposals.queue.blocked[0]).sort(), ['reason', 'since', 'ticket']);
  assert.equal(JSON.stringify(status).includes('SECRET BODY'), false);
});

test('writeStatus writes v2 atomically, reads it back, and classifies storage errors', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'vault', 'status.json');
    const result = writeStatus(file, {
      now: NOW,
      state: 'running',
      warnings: ['BOARD_STALE'],
      lastReport: { summary: 'x'.repeat(2000) },
    });
    assert.equal(result.ok, true);
    assert.ok(result.bytes > 0 && result.bytes <= STATUS_MAX_BYTES);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.v, 2);
    assert.equal(parsed.state, 'running');
    assert.equal(parsed.lastReport.summary.length, 200);
    const leftovers = fs.readdirSync(path.join(dir, 'vault')).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);

    assert.deepEqual(writeStatus('', {}), { ok: false, error: 'E_STATUS_PATH' });
  });

  withTempDir((dir) => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const result = writeStatus(path.join(blocker, 'status.json'), { now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'E_IO');
  });

  assert.equal(storageErrorCode({ code: 'ENOSPC' }), 'E_STORAGE');
  assert.equal(storageErrorCode({ code: 'EROFS' }), 'E_STORAGE');
  assert.equal(storageErrorCode({ code: 'EACCES' }), 'E_STORAGE');
  assert.equal(storageErrorCode({ code: 'EPERM' }), 'E_STORAGE');
  assert.equal(storageErrorCode({ code: 'ENOTDIR' }), 'E_IO');
  assert.equal(storageErrorCode(null), 'E_IO');
});

test('oversized status shrinks under 16KB without dropping starvation', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'status.json');
    const alerts = Array.from({ length: 20 }, (_, index) => ({
      code: `ERR_${index}`,
      severity: index < 10 ? 'error' : 'info',
      message: 'm'.repeat(400),
    }));
    const result = writeStatus(file, {
      now: NOW,
      alerts,
      warnings: alerts.map((alert) => alert.code),
      lastError: { code: 'E_BIG', at: NOW, message: 'x'.repeat(5000) },
      lastReport: { at: NOW, summary: 'y'.repeat(20000) },
      board: { focus: Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}`, goal: 'g', updatedAt: NOW })) },
      proposals: { queue: { starvation: true, blocked: Array.from({ length: 20 }, () => ({ ticket: 't', reason: 'r', since: NOW })) } },
    });
    assert.equal(result.ok, true);
    assert.ok(result.bytes <= STATUS_MAX_BYTES);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.proposals.queue.starvation, true);
    assert.ok(parsed.alerts.every((alert) => alert.severity === 'error'));
  });
});
