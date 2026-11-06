// B1/B2: daily maintenance scheduling (2026-11 feature batch).
//
// Every test runs against a throwaway memory root. The scheduler tests inject a
// fake clock and fake timers, so a "day" costs microseconds and no real timer
// is left behind.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createMaintenanceScheduler,
  nextLocalMidnight,
  pendingReportPath,
  readScheduleState,
  renderForgetPending,
  runDailyMaintenance,
} from '../src/memory/maintenance.js';
import { normalizeFeatureConfig, registerFeatures } from '../src/features.js';

const DAY1 = new Date(2026, 10, 5, 10, 0, 0); // 2026-11-05 10:00 local
const DAY2 = new Date(2026, 10, 6, 9, 0, 0);

function cardFile({
  title, salience = 3, strength = 3, lastUsed = null, status = null, tags = [],
}) {
  return [
    '---',
    `title: ${title}`,
    ...(tags.length ? [`tags: [${tags.join(', ')}]`] : []),
    ...(status ? [`status: ${status}`] : []),
    `salience: ${salience}`,
    `strength: ${strength}`,
    ...(lastUsed ? [`last_used: ${lastUsed}`] : []),
    'revisions: 0',
    '---',
    `# ${title}`,
    '',
    `${title}的正文。`,
    '',
  ].join('\n');
}

function journalFile(day, lines) {
  return [
    '---',
    `title: ${day}`,
    `date: ${day}`,
    'salience: 3',
    'strength: 3',
    'revisions: 0',
    '---',
    '',
    ...lines,
    '',
  ].join('\n');
}

function put(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/** A root with one fresh card, one epochs proposal, one tombstone proposal,
 *  two immune cards (salience=locked), and one card without last_used. */
function prepareRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-maint-'));
  fs.mkdirSync(path.join(root, 'topics'), { recursive: true });
  fs.mkdirSync(path.join(root, 'journal'), { recursive: true });
  put(root, 'journal/2026-11-04.md', journalFile('2026-11-04', ['今天定了：先做 B1，再做 B2。']));
  put(root, 'topics/fresh.md', cardFile({ title: '新鲜', strength: 1, lastUsed: '2026-11-04' }));
  put(root, 'topics/epochs.md', cardFile({ title: '三个月', strength: 1, lastUsed: '2026-07-01' }));
  put(root, 'topics/tombstone.md', cardFile({ title: '一年以上', strength: 9, lastUsed: '2025-01-01' }));
  put(root, 'topics/core.md', cardFile({ title: '核心', salience: 5, strength: 0, lastUsed: '2020-01-01' }));
  put(root, 'topics/locked.md', cardFile({
    title: '锁定', status: 'locked', salience: 5, strength: 1, lastUsed: '2020-01-01',
  }));
  put(root, 'topics/undated.md', cardFile({ title: '无日期', strength: 0 }));
  return root;
}

/** Read every card-ish file (everything outside .longlive) for a 0-change check. */
function snapshotCards(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (rel === '' && name === '.longlive') continue;
      const abs = path.join(dir, name);
      const nextRel = rel ? `${rel}/${name}` : name;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) walk(abs, nextRel);
      else out[nextRel] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

function readSchedule(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.longlive', 'bridge', 'schedule.json'), 'utf8'));
}

function fakeTimers() {
  const jobs = [];
  let nextId = 0;
  return {
    setTimeout(fn, ms) {
      const handle = { id: (nextId += 1), ms, fn };
      jobs.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const at = jobs.indexOf(handle);
      if (at >= 0) jobs.splice(at, 1);
    },
    count() {
      return jobs.length;
    },
    delays() {
      return jobs.map((job) => job.ms);
    },
    next() {
      return jobs[0] ?? null;
    },
    async fire(handle = null) {
      const job = handle ?? jobs.shift();
      if (!job) throw new Error('no pending timer');
      const at = jobs.indexOf(job);
      if (at >= 0) jobs.splice(at, 1);
      return job.fn();
    },
  };
}

test('day one: both reports + schedule state are written, cards are unchanged', () => {
  const root = prepareRoot();
  const before = snapshotCards(root);
  const result = runDailyMaintenance({ memoryRoot: root, now: DAY1, config: {} });

  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.day, '2026-11-05');
  assert.equal(result.consolidate.status, 'ran');
  assert.equal(result.consolidate.reportRel, '.longlive/reports/consolidate-2026-11-05.md');
  assert.ok(result.consolidate.proposals >= 1, 'consolidate should see the journal paragraph');
  assert.ok(fs.existsSync(path.join(root, result.consolidate.reportRel)));

  assert.equal(result.forget.status, 'ran');
  assert.equal(result.forget.pending, 2);
  assert.equal(result.forget.pendingRel, '.longlive/reports/forget-pending-20261105.md');
  assert.equal(result.forget.immune, 2);
  assert.equal(result.forget.undated, 2);

  const state = readSchedule(root);
  assert.equal(state.lastConsolidateDate, '2026-11-05');
  assert.equal(state.lastForgetDate, '2026-11-05');
  assert.equal(state.lastForgetPendingCount, 2);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].consolidate, 'ran');
  assert.equal(state.runs[0].forget, 'ran');

  const pending = fs.readFileSync(path.join(root, result.forget.pendingRel), 'utf8');
  assert.match(pending, /confirm:"FORGET"/);
  assert.match(pending, /topics\/epochs\.md/);
  assert.match(pending, /topics\/tombstone\.md/);
  assert.match(pending, /降级/);
  assert.match(pending, /立碑/);
  assert.match(pending, /免疫/);
  assert.match(pending, /没有移动、删除或改写任何卡片/);

  assert.deepEqual(snapshotCards(root), before, 'B1/B2 must not touch a single card');
  assert.equal(
    fs.existsSync(path.join(root, '.longlive', 'bridge', 'schedule.lock')),
    false,
    'the cross-process lock must be released',
  );
});

test('a live lock from another session skips the run; a stale lock is reclaimed', () => {
  const root = prepareRoot();
  const lock = path.join(root, '.longlive', 'bridge', 'schedule.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, day: '2026-11-05' }));

  const skipped = runDailyMaintenance({ memoryRoot: root, now: DAY1, config: {} });
  assert.equal(skipped.ran, false);
  assert.equal(skipped.reason, 'locked');
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'reports', 'forget-pending-20261105.md')), false);
  assert.equal(fs.existsSync(lock), true, 'a live lock is not stolen');

  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  const reclaimed = runDailyMaintenance({ memoryRoot: root, now: DAY1, config: {} });
  assert.equal(reclaimed.ran, true);
  assert.equal(fs.existsSync(lock), false);
});

test('same local day is idempotent: no second report, state bytes unchanged', () => {
  const root = prepareRoot();
  runDailyMaintenance({ memoryRoot: root, now: DAY1, config: {} });
  const stateFile = path.join(root, '.longlive', 'bridge', 'schedule.json');
  const pendingFile = path.join(root, '.longlive', 'reports', 'forget-pending-20261105.md');
  const stateBefore = fs.readFileSync(stateFile, 'utf8');
  const pendingBefore = fs.readFileSync(pendingFile, 'utf8');

  const result = runDailyMaintenance({ memoryRoot: root, now: new Date(2026, 10, 5, 23, 59, 0), config: {} });
  assert.equal(result.ok, true);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'already-ran-today');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore);
  assert.equal(fs.readFileSync(pendingFile, 'utf8'), pendingBefore);
});

test('a new local date triggers a second run', () => {
  const root = prepareRoot();
  runDailyMaintenance({ memoryRoot: root, now: DAY1, config: {} });
  const result = runDailyMaintenance({ memoryRoot: root, now: DAY2, config: {} });

  assert.equal(result.ran, true);
  assert.equal(result.day, '2026-11-06');
  assert.equal(result.consolidate.reportRel, '.longlive/reports/consolidate-2026-11-06.md');
  assert.ok(fs.existsSync(path.join(root, result.consolidate.reportRel)));

  const state = readSchedule(root);
  assert.equal(state.lastConsolidateDate, '2026-11-06');
  assert.equal(state.lastForgetDate, '2026-11-06');
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[1].day, '2026-11-06');
});

test('consolidate failure is recorded, does not stop forget and does not throw', () => {
  const root = prepareRoot();
  const before = snapshotCards(root);
  const boom = () => {
    const error = new Error('模拟巩固失败');
    error.code = 'E_TEST_CONSOLIDATE';
    throw error;
  };
  const result = runDailyMaintenance({
    memoryRoot: root,
    now: DAY1,
    config: {},
    consolidate: boom,
  });

  assert.equal(result.ok, true);
  assert.equal(result.consolidate.status, 'failed');
  assert.equal(result.consolidate.code, 'E_TEST_CONSOLIDATE');
  assert.equal(result.forget.status, 'ran');
  assert.ok(fs.existsSync(path.join(root, result.forget.pendingRel)));

  const state = readSchedule(root);
  assert.equal(state.lastConsolidateDate, null, 'a failed day must be retried');
  assert.equal(state.lastForgetDate, '2026-11-05');
  assert.equal(state.lastConsolidateError.code, 'E_TEST_CONSOLIDATE');
  assert.equal(state.runs[0].consolidateError, 'E_TEST_CONSOLIDATE');
  assert.deepEqual(snapshotCards(root), before);
});

test('forget failure leaves cards alone and keeps consolidate', () => {
  const root = prepareRoot();
  const before = snapshotCards(root);
  const boom = () => {
    const error = new Error('模拟遗忘失败');
    error.code = 'E_TEST_FORGET';
    throw error;
  };
  const result = runDailyMaintenance({
    memoryRoot: root,
    now: DAY1,
    config: {},
    forget: boom,
  });

  assert.equal(result.ok, true);
  assert.equal(result.consolidate.status, 'ran');
  assert.equal(result.forget.status, 'failed');
  assert.equal(result.forget.code, 'E_TEST_FORGET');
  assert.equal(fs.existsSync(pendingReportPath(root, '2026-11-05')), false);

  const state = readSchedule(root);
  assert.equal(state.lastForgetDate, null);
  assert.equal(state.lastConsolidateDate, '2026-11-05');
  assert.equal(state.lastForgetError.code, 'E_TEST_FORGET');
  assert.deepEqual(snapshotCards(root), before);
});

test('a forget runner that claims to apply is rejected as a failure (0 card changes)', () => {
  const root = prepareRoot();
  const before = snapshotCards(root);
  const result = runDailyMaintenance({
    memoryRoot: root,
    now: DAY1,
    config: {},
    forget: () => ({ dryRun: false, applied: true, proposals: [] }),
  });

  assert.equal(result.forget.status, 'failed');
  assert.equal(result.forget.code, 'E_MAINTENANCE_DRYRUN_REQUIRED');
  assert.deepEqual(snapshotCards(root), before);
  assert.equal(readSchedule(root).lastForgetDate, null);
});

test('pending list rendering carries the confirm gate and the three epitaph questions', () => {
  const text = renderForgetPending({
    day: '2026-11-05',
    at: DAY1,
    result: {
      scanned: 4,
      proposals: [{
        path: 'topics/old.md',
        kind: 'epochs',
        ageDays: 120,
        reason: '90 天未用且 strength 低',
        salience: 2,
        strength: 1,
        last_used: '2026-07-08',
        destRel: 'epochs/topics/old.md',
        epitaph: { reason: '90 天未用', affects: 'tags: 项目甲', stillUseful: '从 epochs/topics/old.md 移回' },
      }],
      immune: [{ path: 'topics/core.md', status: 'active', reason: 'salience=5 核心记忆' }],
      undated: [{ path: 'topics/nodate.md', reason: '没有可用的 last_used' }],
      scaffold: { missing: [], ready: true },
    },
  });
  assert.match(text, /confirm:"FORGET"/);
  assert.match(text, /为什么关：90 天未用/);
  assert.match(text, /影响谁：tags: 项目甲/);
  assert.match(text, /还有用吗：从 epochs\/topics\/old\.md 移回/);
  assert.match(text, /免疫/);
  assert.match(text, /没有可用的 last_used/);
});

test('scheduler: exactly one timer to the next local midnight, then re-arms', async () => {
  const root = prepareRoot();
  const clock = { value: new Date(2026, 10, 5, 10, 0, 0) };
  const timers = fakeTimers();
  const scheduler = createMaintenanceScheduler({
    memoryRoot: root,
    config: { runOnStart: false, consolidate: true, forget: true },
    now: () => clock.value,
    timers,
  });

  const started = scheduler.start();
  assert.equal(started.mode, 'midnight');
  assert.equal(timers.count(), 1, 'one-shot timer, not a polling loop');
  const expectedDelay = nextLocalMidnight(clock.value).getTime() - clock.value.getTime();
  assert.equal(started.delayMs, expectedDelay);
  assert.ok(started.delayMs > 0 && started.delayMs <= 24 * 60 * 60 * 1000 + 1000);

  clock.value = new Date(2026, 10, 6, 0, 0, 2);
  const result = await timers.fire(timers.next());
  assert.equal(result.ran, true);
  assert.equal(result.day, '2026-11-06');
  assert.equal(result.consolidate.status, 'ran');
  assert.equal(timers.count(), 1, 'the next midnight is armed after the run');
  assert.ok(timers.delays()[0] > 23 * 60 * 60 * 1000);
});

test('scheduler: startup tick is short and then arms midnight; stop clears the timer', async () => {
  const root = prepareRoot();
  const clock = { value: new Date(2026, 10, 5, 10, 0, 0) };
  const timers = fakeTimers();
  const scheduler = createMaintenanceScheduler({
    memoryRoot: root,
    config: { runOnStart: true, startDelayMs: 0, consolidate: true, forget: true },
    now: () => clock.value,
    timers,
  });

  scheduler.start();
  assert.deepEqual(timers.delays(), [0]);
  const result = await timers.fire(timers.next());
  assert.equal(result.ran, true);
  assert.equal(result.day, '2026-11-05');
  assert.equal(timers.count(), 1);
  assert.ok(timers.delays()[0] > 0);

  scheduler.stop();
  assert.equal(timers.count(), 0);
  const afterStop = await scheduler.runNow('manual');
  assert.equal(afterStop.ran, false);
  assert.equal(afterStop.reason, 'stopped');
});

test('scheduler: a run that straddles local midnight arms a catch-up tick', async () => {
  const root = prepareRoot();
  const clock = { value: new Date(2026, 10, 5, 23, 59, 59) };
  const timers = fakeTimers();
  let advanceOnRun = true;
  const scheduler = createMaintenanceScheduler({
    memoryRoot: root,
    config: { runOnStart: false, consolidate: true, forget: true },
    now: () => clock.value,
    timers,
    run: async (options) => {
      if (advanceOnRun) {
        advanceOnRun = false;
        clock.value = new Date(2026, 10, 6, 0, 0, 1);
      }
      return runDailyMaintenance(options);
    },
  });
  scheduler.start();
  const result = await timers.fire(timers.next());
  assert.equal(result.ran, true);
  assert.equal(timers.count(), 1);
  assert.ok(timers.delays()[0] <= 1000, 'catch-up tick should be short, not a full day');
});

test('corrupt schedule.json is tolerated and repaired with a backup', () => {
  const root = prepareRoot();
  put(root, '.longlive/bridge/schedule.json', '{not json');
  const result = runDailyMaintenance({ memoryRoot: root, now: DAY1, config: {} });

  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.corruptState, true);
  const state = readSchedule(root);
  assert.equal(state.lastConsolidateDate, '2026-11-05');
  const backups = fs.readdirSync(path.join(root, '.longlive', 'backups'));
  assert.ok(backups.some((name) => name.startsWith('schedule.')), 'corrupt state should be backed up');
});

test('config normalization: autoMaintenance is off by default and clamps hostile values', () => {
  const off = normalizeFeatureConfig({});
  assert.equal(off.autoMaintenance.enabled, false);
  assert.equal(off.autoMaintenance.consolidate, true);
  assert.equal(off.autoMaintenance.forget, true);
  assert.equal(off.autoMaintenance.runOnStart, true);
  assert.equal(off.autoMaintenance.startDelayMs, 500);

  const on = normalizeFeatureConfig({
    autoMaintenance: { enabled: true, consolidate: false, startDelayMs: -50 },
  });
  assert.deepEqual(on.autoMaintenance, {
    enabled: true,
    consolidate: false,
    forget: true,
    runOnStart: true,
    startDelayMs: 0,
  });

  // Unknown/malformed blocks stay off; no throw.
  const hostile = normalizeFeatureConfig({ autoMaintenance: 'yes' });
  assert.equal(hostile.autoMaintenance.enabled, false);
});

test('readScheduleState reports missing/corrupt without throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-maint-'));
  const missing = readScheduleState(root);
  assert.equal(missing.exists, false);
  assert.equal(missing.corrupt, false);
  assert.equal(missing.state.lastConsolidateDate, null);

  put(root, '.longlive/bridge/schedule.json', '[]');
  const corrupt = readScheduleState(root);
  assert.equal(corrupt.exists, true);
  assert.equal(corrupt.corrupt, true);
});

function fakeFeatureCtx() {
  const effects = [];
  const warnings = [];
  const infos = [];
  return {
    effects,
    warnings,
    infos,
    tools: { register() {} },
    on() {
      return () => {};
    },
    effect(register) {
      effects.push(register);
      return () => {};
    },
    logger() {
      return {
        warn: (message) => warnings.push(message),
        info: (message) => infos.push(message),
      };
    },
  };
}

test('features wiring: autoMaintenance starts one timer and registers a disposer', async () => {
  const root = prepareRoot();
  const clock = { value: new Date(2026, 10, 5, 10, 0, 0) };
  const timers = fakeTimers();
  const ctx = fakeFeatureCtx();
  const registered = registerFeatures(ctx, {
    autoMaintenance: { enabled: true, runOnStart: false },
    now: () => clock.value,
    timers,
  }, { memoryRoot: root });

  assert.ok(registered.enabled.includes('autoMaintenance'));
  assert.equal(timers.count(), 1);
  assert.equal(ctx.effects.length, 1);
  const dispose = ctx.effects[0]();
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(timers.count(), 0);
});

test('features wiring: autoMaintenance off means no timer and no schedule file', () => {
  const root = prepareRoot();
  const timers = fakeTimers();
  const ctx = fakeFeatureCtx();
  const registered = registerFeatures(ctx, { timers }, { memoryRoot: root });

  assert.deepEqual(registered.enabled, []);
  assert.equal(timers.count(), 0);
  assert.equal(fs.existsSync(path.join(root, '.longlive', 'bridge', 'schedule.json')), false);
  assert.deepEqual(ctx.effects, []);
  assert.deepEqual(ctx.warnings, []);
  assert.deepEqual(ctx.infos, []);
});

test('features wiring: both jobs off arms no timer and logs one warning', () => {
  const root = prepareRoot();
  const timers = fakeTimers();
  const ctx = fakeFeatureCtx();
  const registered = registerFeatures(ctx, {
    autoMaintenance: { enabled: true, consolidate: false, forget: false },
    timers,
  }, { memoryRoot: root });

  assert.deepEqual(registered.enabled, []);
  assert.equal(timers.count(), 0);
  assert.deepEqual(ctx.effects, []);
  assert.equal(ctx.warnings.length, 1);
});
