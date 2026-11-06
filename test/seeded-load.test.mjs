// @local/dsh-longlive — seeded-session load regression (0.7.5)
//
// A released v4 log carries its inherited cut as a MARKER EVENT, not as a
// header field: one `session/end-seed` row with `data.inherited === true`, and
// the decoder derives `inheritedEventCount` from the LAST such row
// (`@deepseek-ai/dsh-session-format-v1-to-v2` finish()). The physical header
// line has no `inheritedEventCount` field at all — the persistence layer's
// isHeaderLine() rejects unknown keys — so 0.7.4's
// `header.inheritedEventCount = 0` never reached disk. Truncating a seeded
// session therefore produced a header that still said `isSeeded: true` with no
// marker left anywhere, and the real host refused to load it:
//
//   SessionPersistenceCorruptionError: stored log is corrupt:
//   SessionFormatError: released v2 seeded Session lacks an inherited end-seed
//   marker
//
// The CLI's read-back stayed green because it only reparsed with src/codec.js,
// which never looks at this metadata. So these cases pin both halves:
//   * the metadata the writers must emit (unit, no host needed);
//   * a real load of the truncated log through the host's own persistence and
//     Session packages (no model API key involved — this decodes a log only).
//
// A seeded log's inherited prefix is exactly what a prefix cut removes, so the
// writers now keep `isSeeded` and write one fresh marker at index 0: an
// explicitly empty inherited prefix, a shape `@deepseek-ai/dsh-subagent`
// documents as supported and the decoder accepts as `inheritedEventCount: 0`.
// Rewriting `isSeeded` to false instead would silently re-label a detached
// child as a fresh session, so that route is deliberately not taken.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseSession, encodeSession, assertContiguous } from '../src/codec.js';
import { truncateSession, CONFIRM_WORD } from '../src/truncate.js';
import { truncateVisibleSession, VISIBLE_CONFIRM_WORD, isInheritedSeedMarker } from '../src/truncate-visible.js';

// The host is discovered at run time (see findAppRoot): the suite must not
// publish a machine path. Overridable via DSH_LONGLIVE_APP_EXE when the app
// lives somewhere the walk-up cannot see; when nothing is found the real-load
// half SKIPs instead of pretending to pass.
// app.asar is a virtual archive: plain Node cannot stat anything INSIDE it, so
// the readiness check stops at the archive file itself and the per-package
// existence is proven by the loader actually requiring them.
const ASAR_DIR = 'app.asar';

function buildSeeded({ id, turns = 18, markerTurns = [3, 5, 7], seeded = true, checkpointAt = null }) {
  const events = [];
  const surface = [];
  const base = Date.now() - 600_000;
  const push = (event) => {
    event.seq = events.length;
    event.time = base + events.length;
    events.push(event);
    if (event.surfaceOp === 'append') surface.push(event.seq);
  };
  push({
    type: 'system/message',
    surfaceOp: 'append',
    data: {
      message: {
        role: 'system',
        id: 'system-1',
        source: { kind: 'system-prompt' },
        content: [{ type: 'text', text: 'inherited system prompt' }],
      },
    },
  });
  push({ type: 'session/title', data: { title: '子代理（继承）', messageSeqs: [], source: { kind: 'user' } } });
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
        content: [{ type: 'text', text: `question ${turn}` }],
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
          id: `assistant-${turn}`,
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          content: [{ type: 'text', text: `answer ${turn} ${'x'.repeat(200)}` }],
        },
      },
    });
    if (turn === checkpointAt) {
      // Real logs are compacted long before they are cut: a checkpoint replaces
      // the visible surface so far, which is the only way the log truncator's
      // "never cut a visible message" boundary can sit deep in the file.
      const compactionId = 'ckpt-seeded';
      const startSeq = surface[0];
      const endSeq = surface[surface.length - 1];
      push({ type: 'compaction/start', data: { compactionId, turn } });
      push({
        type: 'compaction/summary',
        data: {
          compactionId,
          turn,
          summary: '（压缩摘要）',
          shadowedRange: { start: startSeq, end: endSeq },
          shadowedSeqs: [...surface],
        },
      });
      push({
        type: 'user/message',
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: [...surface],
        data: {
          turn,
          step: 1,
          role: 'user',
          id: `checkpoint-${turn}`,
          content: [{ type: 'text', text: '（压缩摘要）' }],
          source: { kind: 'compact-checkpoint', compactionId },
        },
      });
      push({ type: 'compaction/end', data: { compactionId, turn } });
      surface.length = 0;
      surface.push(events.length - 1);
    }
    push({ type: 'step/end', data: { turn, step: 1 } });
    push({ type: 'turn/end', data: { turn } });
    if (seeded && markerTurns.includes(turn)) {
      push({ type: 'session/end-seed', data: { inherited: true } });
    }
  }
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: base,
    cwd: 'C:\\fixtures',
    isSeeded: seeded,
    delegationDepth: seeded ? 1 : 0,
    ...(seeded ? { parentSession: 'session-parent-fixture', origin: 'subagent' } : {}),
  };
  return { header, events };
}

// The host identifies a stored log by resolving its path against
// header.cwd (projectKey -> `--C-fixtures--`), so the fixture must live at the
// path the header claims: sessions/<projectKey>/<id>/session.v4.jsonl.zstd.
function writeLog(TMP, name, options) {
  const { header, events } = buildSeeded({ id: `session-seeded-${name}`, ...options });
  const file = path.join(TMP, 'seeded-load', name, 'sessions', '--C-fixtures--', header.id, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeSession(header, events));
  return { file, header, events };
}

// Locates the installed app without hardcoding a drive: the suite's own node is
// usually the app's bundled runtime, so walking up from process.execPath finds
// `<app>\resources\app.asar`. Overrides win (DSH_LONGLIVE_APP_EXE /
// DSH_LONGLIVE_ASAR), and when nothing is found the load cases skip instead of
// pretending to pass.
function findAppRoot() {
  const seen = new Set();
  let dir = path.dirname(process.execPath);
  for (let i = 0; i < 8; i += 1) {
    if (seen.has(dir)) break;
    seen.add(dir);
    if (fs.existsSync(path.join(dir, 'app.asar'))) return path.dirname(dir);
    if (fs.existsSync(path.join(dir, 'resources', ASAR_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findAppExe(root) {
  if (!root) return null;
  let names;
  try { names = fs.readdirSync(root); } catch { return null; }
  const exes = names.filter((name) => name.toLowerCase().endsWith('.exe'));
  if (exes.length === 0) return null;
  const preferred = exes.find((name) => /harness|deepseek/i.test(name)) ?? exes[0];
  return path.join(root, preferred);
}

function hostRuntime() {
  const envExe = process.env.DSH_LONGLIVE_APP_EXE;
  const appRoot = findAppRoot();
  const exe = envExe || (process.versions.electron ? process.execPath : findAppExe(appRoot));
  if (!exe || !fs.existsSync(exe)) {
    return { ok: false, reason: 'no installed app found (set DSH_LONGLIVE_APP_EXE; the load half needs the real packages)' };
  }
  const archive = process.env.DSH_LONGLIVE_ASAR
    ? path.dirname(path.dirname(process.env.DSH_LONGLIVE_ASAR))
    : (appRoot ? path.join(appRoot, 'resources', ASAR_DIR)
      : path.join(path.dirname(exe), 'resources', ASAR_DIR));
  const asar = process.env.DSH_LONGLIVE_ASAR
    || path.join(archive, 'dsh', 'node_modules');
  if (!fs.existsSync(archive)) {
    return { ok: false, reason: `host archive not found at ${archive} (set DSH_LONGLIVE_ASAR)` };
  }
  return { ok: true, exe, asar };
}

// Runs inside the host's own Electron binary with ELECTRON_RUN_AS_NODE=1: same
// V8, same packages the app loads sessions with. Prints one JSON line.
const LOADER_SOURCE = `'use strict';
const path = require('node:path');
const file = process.argv[2];
const asar = process.argv[3];
(async () => {
  try {
    const cordis = require(path.join(asar, '@deepseek-ai', 'cordis'));
    const persistence = require(path.join(asar, '@deepseek-ai', 'dsh-session-persistence-jsonl'));
    const sessionMod = require(path.join(asar, '@deepseek-ai', 'dsh-session'));
    const root = path.dirname(path.dirname(path.dirname(file)));
    const id = path.basename(path.dirname(file));
    const ctx = new cordis.Context();
    await ctx.plugin(persistence, { root, compression: 'zstd' });
    const stored = await ctx.sessionPersistence.readStoredLog(file, id);
    const session = sessionMod.Session.fromRestore(
      stored.meta.id, stored.events, stored.meta, stored.inheritedEventCount, stored.eventState, [],
    );
    const messages = session.deriveMessages();
    process.stdout.write(JSON.stringify({
      ok: true,
      status: stored.status,
      events: stored.events.length,
      inheritedEventCount: stored.inheritedEventCount,
      isSeeded: stored.meta.isSeeded === true,
      messages: messages.length,
    }) + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      name: error && error.name,
      error: error && String(error.message),
      cause: error && error.cause ? String(error.cause.message || error.cause) : null,
    }) + '\\n');
    process.exitCode = 1;
  }
})();
`;

function realLoad(TMP, file) {
  const runtime = hostRuntime();
  if (!runtime.ok) return { fail: runtime.reason };
  const loader = path.join(TMP, 'seeded-load', 'load-session.cjs');
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  fs.writeFileSync(loader, LOADER_SOURCE);
  const run = spawnSync(runtime.exe, [loader, file, runtime.asar], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const line = text.split(/\r?\n/).filter((row) => row.trim().startsWith('{')).pop();
  if (!line) {
    return { fail: `host loader printed no JSON: ${text.slice(0, 400)}` };
  }
  try {
    return { result: JSON.parse(line) };
  } catch (error) {
    return { fail: `host loader JSON unreadable: ${line.slice(0, 200)}` };
  }
}

function seedMarkers(events) {
  return events.filter(isInheritedSeedMarker);
}

// Rebuilds the 0.7.4 shape on purpose: seeded header, every inherited marker
// stripped. The host must refuse it, and this case is what proves the failure
// mode the fix removes still is what it says it is.
function stripMarkers(file) {
  const parsed = parseSession(fs.readFileSync(file));
  const events = parsed.events
    .filter((event) => !isInheritedSeedMarker(event))
    .map((event, index) => ({ ...event, seq: index }));
  fs.writeFileSync(file, encodeSession(parsed.header, events));
  return parsed.header;
}

export function runSeededLoadSuite({ runCase, recordSkip, assert, TMP }) {
  // The real-load cases need the app's own packages. When the app is not
  // installed here they SKIP with the reason — never a fake pass, never a fail.
  const runtime = hostRuntime();
  const hostCase = (id, name, fn) => {
    if (runtime.ok) runCase(id, name, fn);
    else recordSkip(id, name, runtime.reason);
  };

  runCase('S1', 'seeded 会话可见截断：保留 isSeeded 并在 index 0 写一个 inherited 标记', () => {
    const { file } = writeLog(TMP, 'visible', { turns: 18, markerTurns: [3, 5, 7] });
    const result = truncateVisibleSession(file, {
      dryRun: false,
      confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 4,
      keepTokens: 10_000_000,
      recentWriteWindowMs: 0,
    });
    assert(result.applied === true, `truncation did not apply: ${result.status}`);
    const after = parseSession(fs.readFileSync(file));
    assert(after.header.isSeeded === true, 'visible truncation cleared isSeeded');
    assert(!('inheritedEventCount' in after.header),
      'header must not carry inheritedEventCount (the persistence header line rejects unknown keys)');
    const markers = seedMarkers(after.events);
    assert(markers.length === 1, `expected exactly one inherited marker, got ${markers.length}`);
    assert(markers[0].seq === 0, `expected the inherited marker at seq 0, got ${markers[0].seq}`);
    assert(markers[0].data.inherited === true, 'marker lost data.inherited === true');
    assert(result.seedMarker?.inheritedEventCount === 0,
      `result.seedMarker should report the cut, got ${JSON.stringify(result.seedMarker)}`);
    assertContiguous(after.events);
    return `${result.before.events} -> ${result.after.events} events, isSeeded kept, inherited marker at seq 0`;
  });

  runCase('S2', 'seeded 会话日志截断：同样保留 isSeeded 并在 index 0 写一个 inherited 标记', () => {
    // Log truncation may only cut an invisible prefix, so the fixture is
    // compacted at turn 12 and cut inside that shadowed span; markers exist on
    // both sides of the cut and every one of them must be replaced by the single
    // marker the writer puts at index 0.
    const { file } = writeLog(TMP, 'log', {
      turns: 18,
      markerTurns: [3, 5, 7, 14, 16],
      checkpointAt: 12,
    });
    const result = truncateSession(file, {
      keepEvents: 40,
      dryRun: false,
      confirm: CONFIRM_WORD,
      recentWriteWindowMs: 0,
    });
    assert(result.needed === true, 'log truncation found nothing to cut');
    const after = parseSession(fs.readFileSync(file));
    assert(after.header.isSeeded === true, 'log truncation cleared isSeeded');
    assert(!('inheritedEventCount' in after.header),
      'header must not carry inheritedEventCount (the persistence header line rejects unknown keys)');
    const markers = seedMarkers(after.events);
    assert(markers.length === 1, `expected exactly one inherited marker, got ${markers.length}`);
    assert(markers[0].seq === 0, `expected the inherited marker at seq 0, got ${markers[0].seq}`);
    assert(markers[0].data.inherited === true, 'marker lost data.inherited === true');
    assertContiguous(after.events);
    return `${result.beforeEvents} -> ${after.events.length} events, inherited marker at seq 0`;
  });

  runCase('S3', 'unseeded 会话截断：不写任何 inherited 标记，isSeeded 保持 false', () => {
    const { file } = writeLog(TMP, 'unseeded', { turns: 12, seeded: false });
    truncateVisibleSession(file, {
      dryRun: false,
      confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 3,
      keepTokens: 10_000_000,
      recentWriteWindowMs: 0,
    });
    const after = parseSession(fs.readFileSync(file));
    assert(after.header.isSeeded !== true, 'unseeded fixture came back seeded');
    assert(seedMarkers(after.events).length === 0, 'unseeded log gained an inherited marker');
    return 'unseeded truncation writes no inherited marker';
  });

  hostCase('S4', '真实宿主加载：截断后的 seeded 会话可读取（可见截断）', () => {
    const { file } = writeLog(TMP, 'real-visible', { turns: 20, markerTurns: [3, 5, 7, 9] });
    const result = truncateVisibleSession(file, {
      dryRun: false,
      confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 5,
      keepTokens: 10_000_000,
      recentWriteWindowMs: 0,
    });
    const load = realLoad(TMP, file);
    assert(!load.fail, load.fail);
    assert(load.result.ok === true,
      `real host refused the truncated log: ${load.result.name}: ${load.result.error}`);
    assert(load.result.isSeeded === true, 'host saw isSeeded false after truncating a seeded log');
    assert(load.result.inheritedEventCount === 0,
      `host derived inheritedEventCount ${load.result.inheritedEventCount}, expected 0`);
    assert(load.result.status === 'current', `host status ${load.result.status}`);
    assert(load.result.events === result.after.events,
      `host read ${load.result.events} events, truncation wrote ${result.after.events}`);
    return `host loaded ${load.result.events} events, isSeeded kept, inheritedEventCount 0, ${load.result.messages} messages`;
  });

  hostCase('S5', '真实宿主加载：截断后的 seeded 会话可读取（日志截断）', () => {
    const { file } = writeLog(TMP, 'real-log', {
      turns: 18,
      markerTurns: [3, 5, 7, 14, 16],
      checkpointAt: 12,
    });
    truncateSession(file, {
      keepEvents: 40,
      dryRun: false,
      confirm: CONFIRM_WORD,
      recentWriteWindowMs: 0,
    });
    const load = realLoad(TMP, file);
    assert(!load.fail, load.fail);
    assert(load.result.ok === true,
      `real host refused the truncated log: ${load.result.name}: ${load.result.error}`);
    assert(load.result.inheritedEventCount === 0,
      `host derived inheritedEventCount ${load.result.inheritedEventCount}, expected 0`);
    return `host loaded ${load.result.events} events after a log cut`;
  });

  hostCase('S6', '0.7.4 形状（seeded 无标记）：真实宿主必须拒绝，错误串与 VM 一致', () => {
    const { file } = writeLog(TMP, 'legacy-shape', { turns: 12, markerTurns: [3, 5] });
    truncateVisibleSession(file, {
      dryRun: false,
      confirm: VISIBLE_CONFIRM_WORD,
      keepTurns: 3,
      keepTokens: 10_000_000,
      recentWriteWindowMs: 0,
    });
    stripMarkers(file);
    const load = realLoad(TMP, file);
    assert(!load.fail, load.fail);
    assert(load.result.ok === false,
      'the host loaded a seeded log with no inherited marker; the regression this suite guards is not reproducible');
    assert(load.result.name === 'SessionPersistenceCorruptionError',
      `expected SessionPersistenceCorruptionError, got ${load.result.name}`);
    assert(String(load.result.error).includes('lacks an inherited end-seed marker')
      || String(load.result.cause).includes('lacks an inherited end-seed marker'),
    `missing the decoder message: ${load.result.error} / ${load.result.cause}`);
    return 'the old shape is still rejected by the host (SessionFormatError inside SessionPersistenceCorruptionError)';
  });
}

export const SEEDED_LOAD_CASES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
