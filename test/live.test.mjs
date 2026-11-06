// Live session registry tests (L0-L9).
//
// The registry is a cross-process, crash-tolerant table, so these cases write
// real files under the harness tmp directory and L3 runs real child processes.
// Nothing here writes inside the package tree (P6 checks that afterwards),
// reads credentials, or touches the network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  LIVE_SCHEMA_VERSION,
  LIVE_CONFIRM,
  LIVE_RECORD_FIELDS,
  GOAL_MAX_CHARS,
  pidAlive,
  liveFile,
  liveUpdate,
  liveList,
  liveGet,
  livePrune,
} from '../src/live.js';
import { TOOLS } from '../src/tools.js';

const LIVE_MODULE_URL = new URL('../src/live.js', import.meta.url).href;
const SUITE = 'live-suite';
const NOW = Date.parse('2026-05-06T07:08:09.000Z');
const HOST = os.hostname();
const REMOTE_HOST = 'live-test-remote-host';
const FAKE_PID = 0x7ffffff0;

function iso(ms) {
  return new Date(ms).toISOString();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function liveDirOf(root) {
  return path.join(root, '.longlive', 'live');
}

function newRoot(TMP, name) {
  const root = path.join(TMP, SUITE, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** One complete row with every field, ready to be tweaked per case. */
function makeRecord(overrides = {}) {
  return {
    schemaVersion: LIVE_SCHEMA_VERSION,
    sessionId: 'row',
    pid: process.pid,
    host: HOST,
    startedAt: iso(NOW),
    updatedAt: iso(NOW),
    heartbeatAt: iso(NOW),
    ttlMs: 60000,
    state: 'running',
    turn: 0,
    goal: '',
    blocked_on: '',
    queued: [],
    last_action: { at: iso(NOW), kind: 'test', detail: '' },
    ...overrides,
  };
}

function putRow(root, record) {
  const dir = liveDirOf(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.sessionId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/** name -> sha256 of every regular file, sorted, for byte-identical checks. */
function snapshotFiles(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) out[name] = sha256(fs.readFileSync(full));
  }
  return out;
}

/** Swap fs methods for one call; restores them even when the call throws. */
function withFsPatch(patches, fn) {
  const originals = new Map();
  for (const [key, value] of Object.entries(patches)) {
    originals.set(key, fs[key]);
    fs[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of originals) fs[key] = value;
  }
}

/** Run one child to completion without stdio pipes; results travel by file. */
function runChild(script, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ code: 'timeout', signal: null });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 'spawn-error', error: error.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

// Each child patches the same row 12 times with a ~52 KB payload, so the
// renames genuinely overlap. Results go to per-child files: a piped stdout can
// be unavailable under Windows confinement, a file cannot.
const WORKER_SOURCE = [
  "import fs from 'node:fs';",
  `import { liveUpdate } from ${JSON.stringify(LIVE_MODULE_URL)};`,
  '',
  "const [root, sessionId, index, outFile] = process.argv.slice(2);",
  "const queue = Array.from({ length: 300 }, (_, i) => 'q-' + index + '-' + i + '-' + 'x'.repeat(160));",
  'let last = null;',
  'try {',
  '  for (let round = 0; round < 12; round += 1) {',
  '    last = liveUpdate({',
  '      sessionId,',
  "      state: round % 2 === 0 ? 'running' : 'waiting',",
  '      turn: round,',
  "      goal: 'race ' + index + ':' + round,",
  '      queued: queue,',
  '      ttlMs: 60000,',
  '    }, { memoryRoot: root });',
  '  }',
  '  fs.writeFileSync(outFile, JSON.stringify({',
  '    ok: true, sha256: last.sha256, bytes: last.bytes,',
  "    superseded: last.superseded, pid: process.pid, sessionId: last.sessionId,",
  '  }));',
  '} catch (error) {',
  '  fs.writeFileSync(outFile, JSON.stringify({',
  "    ok: false, code: error.code ?? null, message: error.message,",
  '  }));',
  '  process.exitCode = 1;',
  '}',
  '',
].join('\n');

export async function runLiveSuite({ runCase, runAsyncCase, runSymlinkCase, assert, expectCode, TMP }) {
  fs.mkdirSync(path.join(TMP, SUITE), { recursive: true });

  // L0 — wiring: the four tools exist and carry the documented schema.
  runCase('L0', '四个 session_live_* 已注册，state 必填且枚举只有五种声明态', () => {
    const names = [
      'session_live_update',
      'session_live_list',
      'session_live_get',
      'session_live_prune',
    ];
    for (const name of names) {
      assert(TOOLS.some((tool) => tool.name === name), `missing tool ${name}`);
    }
    const update = TOOLS.find((tool) => tool.name === 'session_live_update');
    assert(update.parameters.state.type === 'string', 'state must be a string');
    assert(
      JSON.stringify(update.parameters.state.enum)
        === JSON.stringify(['idle', 'running', 'waiting', 'blocked', 'stale']),
      `state enum must be the five declared states, got ${JSON.stringify(update.parameters.state.enum)}`,
    );
    assert(update.parameters.sessionId, 'sessionId schema must exist');
    const list = TOOLS.find((tool) => tool.name === 'session_live_list');
    assert(list.parameters.includeDead.type === 'boolean', 'includeDead schema');
    const get = TOOLS.find((tool) => tool.name === 'session_live_get');
    assert(get.parameters.sessionId.type === 'string', 'get sessionId schema');
    const prune = TOOLS.find((tool) => tool.name === 'session_live_prune');
    assert(prune.parameters.confirm.type === 'string', 'prune confirm schema');
    assert(prune.parameters.dryRun.type === 'boolean', 'prune dryRun schema');

    const root = newRoot(TMP, 'l0');
    const written = update.invoke({ sessionId: 's-l0', state: 'idle' }, { memoryRoot: root });
    assert(written.ok && written.created === true, 'registered invoke must write through live.js');
    return '4 tools registered; state enum = 5 declared states';
  });

  // L1 — round-trip, exact field set, patch semantics, goal truncation.
  runCase('L1', '写读往返：15 字段齐全，patch 保留旧值，goal 截断并标注', () => {
    const root = newRoot(TMP, 'l1');
    const sessionId = 's-l1';
    const longGoal = '一二三四五六七八九十'.repeat(9); // 90 code points
    const first = liveUpdate({
      sessionId,
      state: 'blocked',
      turn: 7,
      goal: longGoal,
      blocked_on: 'waiting for review',
      queued: ['a', 'b', 'c'],
      ttlMs: 120000,
      last_action: { at: iso(NOW), kind: 'edit', detail: 'first write' },
    }, { memoryRoot: root, now: NOW });

    assert(first.ok === true && first.created === true, 'first write must create');
    assert(first.goalTruncated === true, 'long goal must be flagged as truncated');
    assert(first.goalChars === 90, `goalChars must be 90, got ${first.goalChars}`);
    assert(first.goalLimit === GOAL_MAX_CHARS, 'goalLimit');
    // Independent oracle: the literal first eight repetitions, NOT the same
    // Array.from().slice() expression the implementation uses.
    assert(
      first.record.goal === '一二三四五六七八九十'.repeat(8),
      'stored goal must be the first 80 code points (literal expectation)',
    );

    const file = path.join(root, '.longlive', 'live', `${sessionId}.json`);
    assert(fs.existsSync(file), `row file must exist at ${file}`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Hard-coded field list: importing LIVE_RECORD_FIELDS would let a mutation
    // that drops a field pass, because the expectation would move with it.
    const DOCUMENTED_FIELDS = [
      'schemaVersion', 'sessionId', 'pid', 'host', 'startedAt', 'updatedAt', 'heartbeatAt',
      'ttlMs', 'state', 'turn', 'goal', 'goalUpdatedAt', 'blocked_on', 'queued', 'last_action',
    ];
    assert(
      JSON.stringify(Object.keys(stored)) === JSON.stringify(DOCUMENTED_FIELDS),
      `stored row must be exactly the 15 documented fields in order, got ${JSON.stringify(Object.keys(stored))}`,
    );
    assert(stored.schemaVersion === LIVE_SCHEMA_VERSION, 'schemaVersion');
    assert(stored.pid === process.pid, 'pid must be the writing process');
    assert(stored.host === HOST, 'host must be this machine');
    assert(stored.startedAt === iso(NOW), 'startedAt = now');
    assert(stored.updatedAt === iso(NOW) && stored.heartbeatAt === iso(NOW), 'updatedAt/heartbeatAt = now');
    // R3: the goal has its own clock; a heartbeat touch must never move it.
    assert(stored.goalUpdatedAt === iso(NOW), 'goalUpdatedAt = the goal write time');
    assert(stored.state === 'blocked', 'state');
    assert(stored.turn === 7, 'turn');
    assert(stored.blocked_on === 'waiting for review', 'blocked_on while blocked');
    assert(JSON.stringify(stored.queued) === JSON.stringify(['a', 'b', 'c']), 'queued');
    assert(stored.ttlMs === 120000, 'ttlMs');
    assert(
      stored.last_action.at === iso(NOW)
        && stored.last_action.kind === 'edit'
        && stored.last_action.detail === 'first write',
      'last_action',
    );

    // Patch: only state. Everything else is preserved; blocked_on is cleared
    // because the session is no longer blocked.
    const second = liveUpdate({ sessionId, state: 'running' }, { memoryRoot: root, now: NOW + 5000 });
    assert(second.created === false, 'second write is an update');
    assert(second.blockedOnCleared === true, 'blocked_on must be cleared when state != blocked');
    const patched = second.record;
    assert(patched.turn === 7, 'turn preserved by patch');
    assert(patched.goal === stored.goal, 'goal preserved by patch');
    assert(patched.goalUpdatedAt === iso(NOW), 'goalUpdatedAt preserved by a goal-less patch');
    assert(JSON.stringify(patched.queued) === JSON.stringify(['a', 'b', 'c']), 'queued preserved');
    assert(patched.blocked_on === '', 'blocked_on emptied');
    assert(patched.startedAt === iso(NOW), 'startedAt preserved across updates');
    assert(patched.updatedAt === iso(NOW + 5000), 'updatedAt moves');
    assert(patched.last_action.kind === 'edit', 'last_action preserved when omitted');

    const got = liveGet({ sessionId }, { memoryRoot: root, now: NOW + 5000 });
    assert(got.ok === true && got.found === true && got.status === 'ok', 'get ok');
    assert(got.live.effectiveState === 'running', `get effectiveState running, got ${got.live.effectiveState}`);
    assert(got.live.fileRel === '.longlive/live/s-l1.json', `fileRel, got ${got.live.fileRel}`);
    assert(got.live.pidAlive === true && got.live.sameHost === true, 'get reports liveness');

    const listed = liveList({}, { memoryRoot: root, now: NOW + 5000 });
    assert(listed.ok === true && listed.count === 1 && listed.scanned === 1, 'list count');
    assert(listed.entries[0].sessionId === sessionId, 'list sessionId');
    assert(listed.entries[0].goal === stored.goal, 'list goal matches stored');
    assert(listed.entries[0].ttlMs === 120000, 'list ttlMs');
    assert(listed.counts.running === 1, 'list counts.running');

    const names = fs.readdirSync(path.dirname(file)).sort();
    assert(
      JSON.stringify(names) === JSON.stringify([`${sessionId}.json`]),
      `registry dir must hold exactly one row, got ${names.join(',')}`,
    );
    return 'round-trip ok; goal 90 -> 80; blocked_on cleared on unblock';
  });

  // L2 — atomic write: a crash half-way leaves the previous complete row.
  runCase('L2', '原子写：写一半 / rename 失败 / 读回损坏都不留半个 JSON，旧文件仍可解析', () => {
    const root = newRoot(TMP, 'l2');
    const sessionId = 's-atomic';
    liveUpdate(
      { sessionId, state: 'running', turn: 1, goal: 'before' },
      { memoryRoot: root, now: NOW },
    );
    const file = liveFile(root, sessionId);
    const beforeText = fs.readFileSync(file, 'utf8');
    const realWrite = fs.writeFileSync;
    const realRead = fs.readFileSync;

    // (a) the tmp write explodes before it completes
    expectCode(() => withFsPatch({
      writeFileSync: (...args) => {
        if (String(args[0]).includes('.tmp-')) {
          throw Object.assign(new Error('injected half write'), { code: 'EIO' });
        }
        return realWrite(...args);
      },
    }, () => liveUpdate(
      { sessionId, state: 'running', turn: 2 },
      { memoryRoot: root, now: NOW + 1000 },
    )), 'E_LIVE_WRITE');
    assert(fs.readFileSync(file, 'utf8') === beforeText, 'failed tmp write must leave the old row byte-identical');
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).turn === 1, 'old row still parses');

    // (b) rename fails: the tmp is cleaned up and the old row survives
    expectCode(() => withFsPatch({
      renameSync: () => {
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      },
    }, () => liveUpdate(
      { sessionId, state: 'waiting', turn: 3 },
      { memoryRoot: root, now: NOW + 2000 },
    )), 'E_LIVE_WRITE');
    assert(fs.readFileSync(file, 'utf8') === beforeText, 'failed rename must leave the old row byte-identical');
    assert(
      fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-')).length === 0,
      'failed rename must not leave a tmp file behind',
    );

    // (c) post-rename read-back is damaged: the old bytes are restored and the
    // call fails instead of reporting a write it cannot verify. Reads of the
    // target are: readPrior (1), writeLiveText prior (2), read-back (3).
    let targetReads = 0;
    const readBackError = expectCode(() => withFsPatch({
      readFileSync: (...args) => {
        if (args[0] === file) {
          targetReads += 1;
          if (targetReads === 3) return '{"half": ';
        }
        return realRead(...args);
      },
    }, () => liveUpdate(
      { sessionId, state: 'blocked', turn: 4 },
      { memoryRoot: root, now: NOW + 3000 },
    )), 'E_LIVE_WRITE');
    assert(readBackError.code === 'E_LIVE_WRITE', 'read-back failure is E_LIVE_WRITE');
    assert(fs.readFileSync(file, 'utf8') === beforeText, 'damaged read-back must restore the old row');
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).turn === 1, 'restored row still parses');

    // and the registry is still writable afterwards
    const recovered = liveUpdate(
      { sessionId, state: 'running', turn: 5 },
      { memoryRoot: root, now: NOW + 4000 },
    );
    assert(recovered.ok === true && JSON.parse(fs.readFileSync(file, 'utf8')).turn === 5, 'write recovers');
    return 'tmp failure, rename failure and damaged read-back all keep the old complete row';
  });

  // L3 — real concurrent writers; the final file is one complete JSON row.
  await runAsyncCase('L3', '并发写同一会话：4 个真进程 x 12 次，最后是一份完整 JSON', async () => {
    const root = newRoot(TMP, 'l3');
    const sessionId = 's-race';
    const script = path.join(TMP, SUITE, 'l3-worker.mjs');
    fs.writeFileSync(script, WORKER_SOURCE);

    const children = [];
    for (let index = 0; index < 4; index += 1) {
      const out = path.join(TMP, SUITE, `l3-out-${index}.json`);
      children.push(runChild(script, [root, sessionId, String(index), out]).then((result) => ({ ...result, out })));
    }
    const finished = await Promise.all(children);
    for (const child of finished) {
      assert(fs.existsSync(child.out), `child wrote no result (code ${child.code})`);
      const result = JSON.parse(fs.readFileSync(child.out, 'utf8'));
      assert(result.ok === true, `child failed (exit ${child.code}): ${JSON.stringify(result)}`);
      assert(result.sessionId === sessionId, 'child wrote another row');
    }

    const file = liveFile(root, sessionId);
    const text = fs.readFileSync(file, 'utf8');
    // JSON.parse over the WHOLE text is the interleaving test: two payloads
    // mixed together would not parse.
    const record = JSON.parse(text);
    assert(record.sessionId === sessionId, 'final row sessionId');
    // MAX_QUEUED_ITEMS caps the row: 300 offered items become 200 stored ones.
    assert(Array.isArray(record.queued) && record.queued.length === 200, `final queued 200, got ${record.queued?.length}`);
    assert(record.queued.every((item) => typeof item === 'string' && item.startsWith('q-')), 'queue items intact');
    assert(record.queued.every((item) => [...item].length <= 300), 'each queued item is capped at 300 code points');
    assert(
      [...LIVE_RECORD_FIELDS].every((key) => key in record),
      'final row has every field',
    );
    assert(text.trim().startsWith('{') && text.trim().endsWith('}'), 'file is exactly one JSON object');
    const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
    assert(leftovers.length === 0, `no orphan tmp files, got ${leftovers.join(',')}`);
    return `4 children x 12 writes; final ${Buffer.byteLength(text)} bytes parse as one row`;
  });

  // L4 — heartbeat bands: fresh wins over everything, stale starts after 2x.
  runCase('L4', '心跳带：ttl 内一律 running（pid 已死也是）；> 2x ttl 才 stale', () => {
    const root = newRoot(TMP, 'l4');
    const ttl = 60000;
    putRow(root, makeRecord({
      sessionId: 's-boundary',
      ttlMs: ttl,
      heartbeatAt: iso(NOW - 2 * ttl),
      updatedAt: iso(NOW - 2 * ttl),
    }));
    putRow(root, makeRecord({
      sessionId: 's-stale',
      ttlMs: ttl,
      heartbeatAt: iso(NOW - 2 * ttl - 1),
      updatedAt: iso(NOW - 2 * ttl - 1),
    }));
    putRow(root, makeRecord({
      sessionId: 's-declared-stale',
      state: 'stale',
      heartbeatAt: iso(NOW - 10),
      updatedAt: iso(NOW - 10),
    }));
    // B4: the writer's pid is not the session's; a fresh heartbeat wins even
    // when that pid no longer exists.
    putRow(root, makeRecord({
      sessionId: 's-fresh-dead-pid',
      pid: FAKE_PID,
      heartbeatAt: iso(NOW - 10),
      updatedAt: iso(NOW - 10),
    }));

    const listed = liveList({}, { memoryRoot: root, now: NOW });
    const byId = Object.fromEntries(listed.entries.map((entry) => [entry.sessionId, entry]));
    assert(byId['s-boundary'].effectiveState === 'running', `age == 2x ttl stays running, got ${byId['s-boundary'].effectiveState}`);
    assert(byId['s-stale'].effectiveState === 'stale', 'age > 2x ttl must be stale');
    assert(byId['s-stale'].heartbeatAgeMs === 2 * ttl + 1, 'heartbeatAgeMs reported');
    assert(byId['s-declared-stale'].effectiveState === 'running', 'a fresh heartbeat overrides a declared stale');
    assert(byId['s-fresh-dead-pid'].effectiveState === 'running', 'fresh heartbeat must beat a dead pid');
    assert(byId['s-fresh-dead-pid'].pidAlive === false, 'the dead pid is still reported, just not decisive');
    assert(listed.counts.stale === 1, `counts.stale 1, got ${listed.counts.stale}`);
    assert(listed.counts.running === 3, `counts.running 3, got ${listed.counts.running}`);

    const got = liveGet({ sessionId: 's-stale' }, { memoryRoot: root, now: NOW });
    assert(got.live.effectiveState === 'stale', 'get must compute the same stale state');
    return 'age = 2x ttl -> running; age = 2x ttl + 1 -> stale; fresh heartbeat beats dead pid';
  });

  // L5 — dead needs old heartbeat or a definitively missing same-host pid.
  runCase('L5', 'dead 判定：>4x ttl 或同 host 死 pid；新心跳压过死 pid；跨 host 不探 pid', () => {
    const root = newRoot(TMP, 'l5');
    assert(pidAlive(FAKE_PID) === false, `fixture pid ${FAKE_PID} unexpectedly exists`);
    // Eight ttl of silence: dead without any pid evidence.
    putRow(root, makeRecord({
      sessionId: 's-dead',
      pid: FAKE_PID,
      host: HOST,
      heartbeatAt: iso(NOW - 500000),
      updatedAt: iso(NOW - 500000),
    }));
    // 1.17 ttl of silence, same host, pid definitively gone: pid accelerates it.
    putRow(root, makeRecord({
      sessionId: 's-pid-dead',
      pid: FAKE_PID,
      host: HOST,
      heartbeatAt: iso(NOW - 70000),
      updatedAt: iso(NOW - 70000),
    }));
    putRow(root, makeRecord({ sessionId: 's-fresh-dead-pid', pid: FAKE_PID, host: HOST }));
    putRow(root, makeRecord({ sessionId: 's-alive', pid: process.pid, host: HOST }));
    putRow(root, makeRecord({
      sessionId: 's-remote-dead',
      pid: FAKE_PID,
      host: REMOTE_HOST,
      heartbeatAt: iso(NOW - 500000),
      updatedAt: iso(NOW - 500000),
    }));

    const hidden = liveList({}, { memoryRoot: root, now: NOW });
    assert(!hidden.entries.some((entry) => entry.sessionId === 's-dead'), 'dead row hidden by default');
    assert(hidden.hiddenDead === 3, `hiddenDead 3, got ${hidden.hiddenDead}`);
    assert(hidden.counts.dead === 3, `counts.dead 3, got ${hidden.counts.dead}`);
    assert(hidden.entries.some((entry) => entry.sessionId === 's-fresh-dead-pid'), 'fresh heartbeat row stays visible');

    const all = liveList({ includeDead: true }, { memoryRoot: root, now: NOW });
    const byId = Object.fromEntries(all.entries.map((entry) => [entry.sessionId, entry]));
    assert(byId['s-dead'].effectiveState === 'dead', '>4x ttl -> dead');
    assert(byId['s-dead'].sameHost === true && byId['s-dead'].pidAlive === false, 'dead row liveness flags');
    assert(byId['s-pid-dead'].effectiveState === 'dead', 'same host + missing pid -> dead before 4x ttl');
    assert(byId['s-fresh-dead-pid'].effectiveState === 'running', 'fresh heartbeat must not be overruled by pid');
    assert(byId['s-remote-dead'].effectiveState === 'dead', 'remote row ages by heartbeat alone');
    assert(byId['s-remote-dead'].sameHost === false && byId['s-remote-dead'].pidAlive === null, 'remote pid must not be probed');

    const got = liveGet({ sessionId: 's-dead' }, { memoryRoot: root, now: NOW });
    assert(got.live.effectiveState === 'dead', 'get dead');
    return 'dead by 4x ttl or same-host dead pid; fresh heartbeat wins; remote pid never probed';
  });

  // L6 — corrupt rows are listed, named, and never break the list.
  runCase('L6', 'corrupt 文件不炸列表：坏 JSON 与 sessionId 不符都列为 corrupt', () => {
    const root = newRoot(TMP, 'l6');
    liveUpdate({ sessionId: 's-good', state: 'idle' }, { memoryRoot: root, now: NOW });
    const dir = liveDirOf(root);
    fs.writeFileSync(path.join(dir, 's-bad-json.json'), '{"schemaVersion": 1, "sessionId": "s-bad-json"');
    fs.writeFileSync(
      path.join(dir, 's-wrong-id.json'),
      `${JSON.stringify(makeRecord({ sessionId: 'someone-else' }))}\n`,
    );
    fs.writeFileSync(path.join(dir, 's-orphan.tmp-123'), 'not a record');

    const listed = liveList({}, { memoryRoot: root, now: NOW });
    assert(listed.ok === true, 'list must not throw on corrupt rows');
    assert(listed.count === 3, `3 rows (1 good + 2 corrupt), got ${listed.count}`);
    assert(listed.counts.corrupt === 2, `counts.corrupt 2, got ${listed.counts.corrupt}`);
    for (const id of ['s-bad-json', 's-wrong-id']) {
      const entry = listed.entries.find((item) => item.sessionId === id);
      assert(entry, `${id} must be listed`);
      assert(entry.effectiveState === 'corrupt', `${id} effectiveState corrupt`);
      assert(typeof entry.corruptReason === 'string' && entry.corruptReason.length > 0, `${id} corruptReason`);
      assert(
        entry.pid === null && entry.state === null && entry.last_action === null
          && Array.isArray(entry.queued) && entry.queued.length === 0,
        `${id} corrupt row shape`,
      );
    }
    assert(!listed.entries.some((entry) => entry.sessionId.includes('orphan')), 'tmp file is not a row');

    const error = expectCode(
      () => liveGet({ sessionId: 's-bad-json' }, { memoryRoot: root, now: NOW }),
      'E_LIVE_CORRUPT',
    );
    assert(error.message.includes('s-bad-json'), `get error names the row: ${error.message}`);
    return '2 corrupt rows listed (bad JSON + wrong sessionId); tmp ignored';
  });

  // L7 — prune: dry-run by default, only dead/corrupt, never cross-host.
  runCase('L7', 'prune：默认 dry-run 零删除；confirm 只删 dead/corrupt，跨 host 与活 pid 的 stale 不动', () => {
    const root = newRoot(TMP, 'l7');
    const records = [
      // Eight ttl of silence: dead by heartbeat (pid evidence unnecessary).
      makeRecord({
        sessionId: 's-dead',
        pid: FAKE_PID,
        host: HOST,
        heartbeatAt: iso(NOW - 500000),
        updatedAt: iso(NOW - 500000),
      }),
      makeRecord({ sessionId: 's-live', pid: process.pid, host: HOST }),
      // 2.5 ttl: stale, but the same-host pid is alive, so it must be kept.
      makeRecord({
        sessionId: 's-stale-alive',
        pid: process.pid,
        host: HOST,
        heartbeatAt: iso(NOW - 150000),
        updatedAt: iso(NOW - 150000),
      }),
      makeRecord({ sessionId: 's-remote', pid: FAKE_PID, host: REMOTE_HOST }),
      // Cross-host stale: heartbeat says stale, never dead, and never pruned.
      makeRecord({
        sessionId: 's-remote-stale',
        pid: FAKE_PID,
        host: REMOTE_HOST,
        heartbeatAt: iso(NOW - 150000),
        updatedAt: iso(NOW - 150000),
      }),
    ];
    for (const record of records) putRow(root, record);
    const dir = liveDirOf(root);
    const corruptFile = path.join(dir, 's-corrupt.json');
    fs.writeFileSync(corruptFile, 'half a json {');

    const before = snapshotFiles(dir);
    assert(Object.keys(before).length === 6, '6 fixture files');

    const preview = livePrune({}, { memoryRoot: root, now: NOW });
    assert(preview.ok === true && preview.status === 'dry-run' && preview.dryRun === true, 'default is dry-run');
    assert(preview.deleted.length === 0, 'dry-run deletes nothing');
    assert(preview.wouldDelete.length === 2, `wouldDelete 2, got ${preview.wouldDelete.length}`);
    const candidateIds = preview.candidates.map((item) => item.sessionId).sort();
    assert(
      JSON.stringify(candidateIds) === JSON.stringify(['s-corrupt', 's-dead']),
      `candidates must be dead + corrupt, got ${JSON.stringify(candidateIds)}`,
    );
    assert(preview.kept.length === 4, 'dry-run kept 4');
    assert(
      JSON.stringify(snapshotFiles(dir)) === JSON.stringify(before),
      'dry-run must not change a single byte',
    );

    expectCode(
      () => livePrune({ dryRun: false }, { memoryRoot: root, now: NOW }),
      'E_CONFIRM_REQUIRED',
    );
    assert(
      JSON.stringify(snapshotFiles(dir)) === JSON.stringify(before),
      'refused prune must not delete anything',
    );

    const real = livePrune({ confirm: LIVE_CONFIRM }, { memoryRoot: root, now: NOW });
    assert(real.ok === true && real.status === 'pruned' && real.dryRun === false, 'confirmed prune runs');
    assert(
      JSON.stringify(real.deleted.map((item) => item.sessionId).sort())
        === JSON.stringify(['s-corrupt', 's-dead']),
      'confirmed prune deletes exactly dead + corrupt',
    );
    assert(real.failed.length === 0, 'no failed deletes');
    assert(!fs.existsSync(path.join(dir, 's-dead.json')), 'dead row removed');
    assert(!fs.existsSync(corruptFile), 'corrupt row removed');

    const after = snapshotFiles(dir);
    for (const name of [
      's-live.json',
      's-stale-alive.json', // same host but pid alive: never deleted
      's-remote.json', // cross-host fresh: never touched
      's-remote-stale.json', // cross-host stale: never touched
    ]) {
      assert(after[name] === before[name], `${name} must be byte-identical`);
    }
    assert(!('s-dead.json' in after) && !('s-corrupt.json' in after), 'only the two candidates are gone');

    const again = livePrune({ confirm: LIVE_CONFIRM }, { memoryRoot: root, now: NOW });
    assert(again.candidates.length === 0 && again.deleted.length === 0, 'second prune is a no-op');

    const confirmedPreview = livePrune({ confirm: LIVE_CONFIRM, dryRun: true }, { memoryRoot: root, now: NOW });
    assert(confirmedPreview.status === 'dry-run' && confirmedPreview.deleted.length === 0, 'dryRun:true wins over confirm');
    return 'dry-run kept 6 files; prune removed exactly dead + corrupt; 4 kept byte-identical';
  });

  // L8 — strict mode keeps the "no root, no registry" contract; the derived
  // default itself is covered by the portability suite.
  runCase('L8', 'strictMemoryRoot：四工具全拒 E_MEMORY_ROOT_UNSET；null/字符串/数组 E_BAD_ARGUMENT', () => {
    const strict = { strictMemoryRoot: true };
    const calls = [
      ['update', () => liveUpdate({ sessionId: 's', state: 'running' }, strict)],
      ['list', () => liveList({}, strict)],
      ['get', () => liveGet({ sessionId: 's' }, strict)],
      ['prune', () => livePrune({}, strict)],
    ];
    for (const [name, call] of calls) {
      const error = expectCode(call, 'E_MEMORY_ROOT_UNSET');
      assert(error.message.includes('memoryRoot'), `${name}: message must name memoryRoot: ${error.message}`);
    }
    expectCode(() => liveList({}, { memoryRoot: '   ', strictMemoryRoot: true }), 'E_MEMORY_ROOT_UNSET');
    expectCode(
      () => liveList({}, { memoryRoot: path.join(TMP, 'does-not-exist-live') }),
      'E_MEMORY_ROOT_MISSING',
    );

    for (const badArgs of [null, '{"state":"running"}', ['running'], 42]) {
      expectCode(() => liveUpdate(badArgs, strict), 'E_BAD_ARGUMENT');
      expectCode(() => liveList(badArgs, strict), 'E_BAD_ARGUMENT');
      expectCode(() => liveGet(badArgs, strict), 'E_BAD_ARGUMENT');
      expectCode(() => livePrune(badArgs, strict), 'E_BAD_ARGUMENT');
    }
    expectCode(() => liveUpdate({ state: 'running' }, null), 'E_BAD_ARGUMENT');
    expectCode(() => liveUpdate({ state: 'running' }, []), 'E_BAD_ARGUMENT');
    // state is required and must be one of the five writer-declared states.
    expectCode(() => liveUpdate({ sessionId: 's' }, { memoryRoot: TMP }), 'E_BAD_ARGUMENT');
    expectCode(() => liveUpdate({ sessionId: 's', state: 'dead' }, { memoryRoot: TMP }), 'E_BAD_ARGUMENT');
    expectCode(() => liveUpdate({ sessionId: 's', state: 'corrupt' }, { memoryRoot: TMP }), 'E_BAD_ARGUMENT');
    return '4 tools refuse unset memoryRoot; null/string/array args rejected';
  });

  // L9 — an id that could be a path is refused, and nothing is created.
  runCase('L9', '路径越界：../、绝对路径、反斜杠一律 E_PATH_OUTSIDE_ROOT，不建目录', () => {
    const root = newRoot(TMP, 'l9');
    const escapeIds = ['../evil', '..\\evil', '../../etc/passwd', 'C:\\evil', '/evil', 'a/b', 'a\\b', '..'];
    for (const sessionId of escapeIds) {
      expectCode(
        () => liveUpdate({ sessionId, state: 'running' }, { memoryRoot: root }),
        'E_PATH_OUTSIDE_ROOT',
      );
      expectCode(
        () => liveGet({ sessionId }, { memoryRoot: root }),
        'E_PATH_OUTSIDE_ROOT',
      );
    }
    assert(!fs.existsSync(path.join(root, '.longlive')), 'refused ids must not create the registry dir');
    assert(!fs.existsSync(path.join(root, '..', 'evil.json')), 'no file may appear above the root');

    for (const sessionId of ['', '   ', 'bad id', 'x'.repeat(129), 'evil%2f..', '.hidden']) {
      expectCode(
        () => liveUpdate({ sessionId, state: 'running' }, { memoryRoot: root }),
        'E_BAD_ARGUMENT',
      );
    }
    assert(!fs.existsSync(path.join(root, '.longlive')), 'malformed ids must not create the registry dir either');

    const accepted = liveUpdate({ sessionId: 's.9_ok-1', state: 'idle' }, { memoryRoot: root });
    assert(accepted.ok === true && fs.existsSync(liveFile(root, 's.9_ok-1')), 'a legal dotted id is accepted');
    return '8 path-like ids refused, 6 malformed ids refused, legal dotted id accepted';
  });

  // L10 — B2: prune re-reads and re-judges every candidate before unlinking.
  runCase('L10', 'B2 prune 删除前重读：blocked_on 不静默丢弃，字节变化则 skipped', () => {
    const root = newRoot(TMP, 'l10');
    putRow(root, makeRecord({
      sessionId: 's-dead',
      pid: FAKE_PID,
      host: HOST,
      startedAt: iso(NOW - 900000),
      queued: ['deleted-queue-1', 'deleted-queue-2'],
      heartbeatAt: iso(NOW - 500000),
      updatedAt: iso(NOW - 500000),
    }));
    putRow(root, makeRecord({
      sessionId: 's-blocked-dead',
      pid: FAKE_PID,
      host: HOST,
      state: 'blocked',
      blocked_on: 'waiting for approval',
      startedAt: iso(NOW - 800000),
      queued: ['blocked-queue'],
      heartbeatAt: iso(NOW - 500000),
      updatedAt: iso(NOW - 500000),
    }));

    const real = livePrune({ confirm: LIVE_CONFIRM }, { memoryRoot: root, now: NOW });
    assert(
      JSON.stringify(real.deleted.map((item) => item.sessionId)) === JSON.stringify(['s-dead']),
      `only the unprotected dead row may go, got ${JSON.stringify(real.deleted.map((item) => item.sessionId))}`,
    );
    assert(
      real.skipped.length === 1
        && real.skipped[0].sessionId === 's-blocked-dead'
        && real.skipped[0].reason.includes('blocked_on'),
      `blocked_on row must be skipped and visible, got ${JSON.stringify(real.skipped)}`,
    );
    assert(
      JSON.stringify(real.skipped[0].queued) === JSON.stringify(['blocked-queue'])
        && real.skipped[0].startedAt === iso(NOW - 800000),
      'skipped row must keep queued/startedAt in the result',
    );
    assert(
      JSON.stringify(real.deleted[0].queued) === JSON.stringify(['deleted-queue-1', 'deleted-queue-2'])
        && real.deleted[0].startedAt === iso(NOW - 900000),
      'deleted row must report the queued/startedAt it removed',
    );
    assert(fs.existsSync(liveFile(root, 's-blocked-dead')), 'blocked_on row must still exist after prune');

    // Race: the row is dead at scan time, then becomes running before unlink.
    const racedRoot = newRoot(TMP, 'l10-race');
    putRow(racedRoot, makeRecord({
      sessionId: 's-race',
      pid: FAKE_PID,
      host: HOST,
      heartbeatAt: iso(NOW - 500000),
      updatedAt: iso(NOW - 500000),
    }));
    const target = liveFile(racedRoot, 's-race');
    const realRead = fs.readFileSync;
    let reads = 0;
    withFsPatch({
      readFileSync: (file, ...rest) => {
        if (path.resolve(String(file)) === path.resolve(target)) {
          reads += 1;
          if (reads === 2) {
            const row = JSON.parse(realRead(target, 'utf8'));
            row.heartbeatAt = iso(NOW);
            row.updatedAt = iso(NOW);
            row.pid = process.pid;
            row.goal = 'changed after scan';
            return `${JSON.stringify(row, null, 2)}\n`;
          }
        }
        return realRead(file, ...rest);
      },
    }, () => {
      const raced = livePrune({ confirm: LIVE_CONFIRM }, { memoryRoot: racedRoot, now: NOW });
      assert(raced.deleted.length === 0, 'a row that changed after scanning must not be deleted');
      assert(
        raced.skipped.some((item) => item.sessionId === 's-race' && item.reason.includes('变化')),
        `changed row must be reported as skipped, got ${JSON.stringify(raced.skipped)}`,
      );
    });
    assert(fs.existsSync(target), 'race row must survive');
    return 'blocked_on skipped visibly; changed-after-scan row skipped';
  });

  // L11 — M-a: one session, one row; readers must name the canonical spelling.
  runCase('L11', 'M-a 大小写别名：写统一小写；get 用别名报 E_SESSION_ID_NOT_CANONICAL 并给出 canonical', () => {
    const root = newRoot(TMP, 'l11');
    const first = liveUpdate({ sessionId: 'S-Ali', state: 'idle' }, { memoryRoot: root, now: NOW });
    assert(first.sessionId === 's-ali', `sessionId must be canonical lowercase, got ${first.sessionId}`);
    const dir = liveDirOf(root);
    assert(
      JSON.stringify(fs.readdirSync(dir)) === JSON.stringify(['s-ali.json']),
      `one lowercase file, got ${JSON.stringify(fs.readdirSync(dir))}`,
    );
    for (const alias of ['S-ALI', 's-Ali']) {
      const error = expectCode(
        () => liveGet({ sessionId: alias }, { memoryRoot: root, now: NOW }),
        'E_SESSION_ID_NOT_CANONICAL',
      );
      assert(error.canonical === 's-ali', `alias ${alias}: canonical must be s-ali, got ${error.canonical}`);
      assert(error.message.includes('规范'), `alias ${alias}: message must explain canonical form`);
    }
    const got = liveGet({ sessionId: 's-ali' }, { memoryRoot: root, now: NOW });
    assert(got.ok === true && got.sessionId === 's-ali', 'canonical id reads the row');
    assert(liveList({}, { memoryRoot: root, now: NOW }).scanned === 1, 'aliases are one row, not several');

    // A row written before canonicalisation may still carry mixed case on disk.
    putRow(root, makeRecord({ sessionId: 'S-Legacy' }));
    const legacy = liveGet({ sessionId: 's-legacy' }, { memoryRoot: root, now: NOW });
    assert(legacy.ok === true && legacy.live.corrupt === false, 'mixed-case legacy row is the same session, not corrupt');
    const legacyAlias = expectCode(
      () => liveGet({ sessionId: 'S-Legacy' }, { memoryRoot: root, now: NOW }),
      'E_SESSION_ID_NOT_CANONICAL',
    );
    assert(legacyAlias.canonical === 's-legacy', 'legacy alias reports its canonical id');
    return 'S-Ali -> s-ali.json; aliases refused with canonical; legacy mixed-case row readable by canonical id';
  });

  // L12 — B3: lexical escape is not enough; realpath is the guard. A junction
  // needs no privilege and always runs; the symlinked-row half needs a real
  // file symlink, so it is a separate case that can honestly SKIP.
  runCase('L12', 'B3 realpath：live 目录 junction 指根外 -> E_PATH_OUTSIDE_ROOT', () => {
    const root = newRoot(TMP, 'l12');
    const outside = path.join(TMP, SUITE, 'l12-outside');
    fs.mkdirSync(outside, { recursive: true });
    const live = path.join(root, '.longlive', 'live');
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.symlinkSync(outside, live, 'junction');
    const calls = [
      ['list', () => liveList({}, { memoryRoot: root })],
      ['update', () => liveUpdate({ sessionId: 's', state: 'idle' }, { memoryRoot: root })],
      ['get', () => liveGet({ sessionId: 's' }, { memoryRoot: root })],
      ['prune', () => livePrune({}, { memoryRoot: root })],
    ];
    for (const [name, call] of calls) {
      const error = expectCode(call, 'E_PATH_OUTSIDE_ROOT');
      assert(error.message.includes('真实路径'), `${name}: message must say the real path escaped`);
    }
    assert(fs.readdirSync(outside).length === 0, 'junction target must stay untouched');
    return 'junction -> 4 tools E_PATH_OUTSIDE_ROOT';
  });

  runSymlinkCase('L12-link', 'B3 realpath：符号链接行被拒且只报告，不删除（需符号链接权限）', () => {
    const clean = newRoot(TMP, 'l12-file');
    putRow(clean, makeRecord({ sessionId: 's-real' }));
    const dir = liveDirOf(clean);
    const link = path.join(dir, 's-link.json');
    fs.symlinkSync(path.join(dir, 's-real.json'), link, 'file');
    expectCode(() => liveGet({ sessionId: 's-link' }, { memoryRoot: clean, now: NOW }), 'E_LIVE_CORRUPT');

    const preview = livePrune({}, { memoryRoot: clean, now: NOW });
    assert(
      preview.placeholders.some((item) => item.kind === 'symlink' && item.fileRel.endsWith('s-link.json')),
      'prune must report the symlinked row',
    );
    const real = livePrune({ confirm: LIVE_CONFIRM }, { memoryRoot: clean, now: NOW });
    assert(real.deleted.length === 0, 'a symlink is never a row candidate');
    assert(fs.existsSync(link) && fs.existsSync(path.join(dir, 's-real.json')), 'symlink and its target survive');
    return 'symlinked row refused and only reported; never deleted';
  });

  // L13 — M-b/M-c: orphan tmp files and empty directory placeholders.
  runCase('L13', 'M-b/M-c prune：陈旧 tmp 与空目录 confirm 后清理；新 tmp/非空目录只报告', () => {
    const root = newRoot(TMP, 'l13');
    const dir = liveDirOf(root);
    fs.mkdirSync(dir, { recursive: true });
    putRow(root, makeRecord({ sessionId: 's-alive', pid: process.pid }));

    const oldTmp = path.join(dir, 's-old.json.tmp-999-1-aaaa');
    fs.writeFileSync(oldTmp, 'half a row');
    fs.utimesSync(oldTmp, new Date(NOW - 7200000), new Date(NOW - 7200000));
    const freshTmp = path.join(dir, 's-fresh.json.tmp-999-2-bbbb');
    fs.writeFileSync(freshTmp, 'still writing');
    fs.utimesSync(freshTmp, new Date(NOW - 60000), new Date(NOW - 60000));
    const emptyDir = path.join(dir, 's-empty.json');
    fs.mkdirSync(emptyDir);
    const nonEmptyDir = path.join(dir, 's-nonempty.json');
    fs.mkdirSync(nonEmptyDir);
    fs.writeFileSync(path.join(nonEmptyDir, 'child'), 'x');

    const preview = livePrune({}, { memoryRoot: root, now: NOW });
    assert(preview.tmpFiles.length === 2, `two tmp files reported, got ${preview.tmpFiles.length}`);
    assert(preview.placeholders.length === 2, `two directory placeholders reported, got ${preview.placeholders.length}`);
    assert(preview.wouldDelete.length === 2, `old tmp + empty dir are deletable, got ${preview.wouldDelete.length}`);
    assert(fs.existsSync(oldTmp) && fs.existsSync(emptyDir), 'dry-run touches nothing');

    const real = livePrune({ confirm: LIVE_CONFIRM }, { memoryRoot: root, now: NOW });
    assert(!fs.existsSync(oldTmp), 'old orphan tmp removed');
    assert(fs.existsSync(freshTmp), 'fresh tmp kept (may belong to a live writer)');
    assert(!fs.existsSync(emptyDir), 'empty directory placeholder removed');
    assert(fs.existsSync(path.join(nonEmptyDir, 'child')), 'non-empty directory is reported, never recursively deleted');
    assert(
      real.tmpFiles.some((item) => item.fileRel.endsWith('s-old.json.tmp-999-1-aaaa') && item.action === 'deleted'),
      'deletion is visible in the result',
    );
    assert(
      real.placeholders.some((item) => item.fileRel.endsWith('s-nonempty.json') && item.action === 'report'),
      'non-empty directory is visible as a report',
    );
    return 'old tmp + empty dir removed on confirm; fresh tmp and non-empty dir kept and reported';
  });

  // L14 — M-d: bounded queue and action detail, with visible truncation flags.
  runCase('L14', 'M-d 上限：queued 200 项、每项 300 字，last_action.detail 500 字，结果明示截断', () => {
    const root = newRoot(TMP, 'l14');
    const queued = Array.from({ length: 250 }, (_, index) => `q-${index}-${'y'.repeat(400)}`);
    const written = liveUpdate({
      sessionId: 's-caps',
      state: 'running',
      queued,
      last_action: { at: iso(NOW), kind: 'edit', detail: 'z'.repeat(700) },
    }, { memoryRoot: root, now: NOW });
    assert(written.queuedTruncated === true, 'queued truncation must be flagged');
    assert(written.queuedInput === 250 && written.queuedCount === 200, 'queue input/kept counts');
    assert(written.record.queued.length === 200, `stored queue 200, got ${written.record.queued.length}`);
    assert([...written.record.queued[0]].length === 300, 'each stored queue item is 300 code points');
    assert(written.lastActionDetailTruncated === true, 'detail truncation must be flagged');
    assert(written.lastActionDetailChars === 700, 'original detail length reported');
    assert(written.record.last_action.detail.length === 500, 'stored detail is 500 chars');

    const stored = JSON.parse(fs.readFileSync(liveFile(root, 's-caps'), 'utf8'));
    assert(stored.queued.length === 200 && stored.last_action.detail.length === 500, 'on-disk row obeys the caps');
    return 'queue 250 -> 200 x 300 chars; detail 700 -> 500; both flagged';
  });

  // L16 — cross-host corrupt rows: a host stamp is evidence of another owner.
  runCase('L16', '跨 host corrupt：带远端 host 的损坏行不删；host 未知/本机才可清理', () => {
    const root = newRoot(TMP, 'l16');
    const dir = liveDirOf(root);
    fs.mkdirSync(dir, { recursive: true });
    putRow(root, makeRecord({ sessionId: 's-alive', pid: process.pid }));

    const remoteFile = path.join(dir, 's-corrupt-remote.json');
    fs.writeFileSync(remoteFile, JSON.stringify({
      schemaVersion: LIVE_SCHEMA_VERSION,
      sessionId: 's-corrupt-remote',
      host: REMOTE_HOST,
      heartbeatAt: iso(NOW),
      // state/pid/ttl are missing: this row cannot be decoded.
    }));
    const remoteHalf = path.join(dir, 's-corrupt-remote-half.json');
    fs.writeFileSync(remoteHalf, `{"sessionId":"s-corrupt-remote-half","host":"${REMOTE_HOST}"`);
    const localFile = path.join(dir, 's-corrupt-local.json');
    fs.writeFileSync(localFile, JSON.stringify({
      schemaVersion: LIVE_SCHEMA_VERSION,
      sessionId: 's-corrupt-local',
      host: HOST,
      heartbeatAt: iso(NOW),
    }));
    const hostless = path.join(dir, 's-corrupt-hostless.json');
    fs.writeFileSync(hostless, 'not json at all');

    const before = snapshotFiles(dir);
    const preview = livePrune({}, { memoryRoot: root, now: NOW });
    const candidateIds = preview.candidates.map((item) => item.sessionId).sort();
    assert(
      JSON.stringify(candidateIds) === JSON.stringify(['s-corrupt-hostless', 's-corrupt-local']),
      `only local/unknown-host corrupt rows are candidates, got ${JSON.stringify(candidateIds)}`,
    );
    assert(
      preview.skipped.filter((item) => item.sessionId.startsWith('s-corrupt-remote')).length === 2,
      'both remote corrupt rows must be reported as skipped',
    );
    assert(
      preview.skipped.every((item) => !item.sessionId.startsWith('s-corrupt-remote') || item.reason.includes('跨 host')),
      'remote corrupt skip must say why',
    );
    assert(JSON.stringify(snapshotFiles(dir)) === JSON.stringify(before), 'dry-run touches nothing');

    const real = livePrune({ confirm: LIVE_CONFIRM }, { memoryRoot: root, now: NOW });
    assert(
      JSON.stringify(real.deleted.map((item) => item.sessionId).sort())
        === JSON.stringify(['s-corrupt-hostless', 's-corrupt-local']),
      `deleted exactly local/unknown corrupt rows, got ${JSON.stringify(real.deleted.map((item) => item.sessionId))}`,
    );
    assert(fs.existsSync(remoteFile) && fs.existsSync(remoteHalf), 'remote corrupt rows survive');
    const after = snapshotFiles(dir);
    assert(after['s-corrupt-remote.json'] === before['s-corrupt-remote.json'], 'remote row is byte-identical');
    assert(after['s-corrupt-remote-half.json'] === before['s-corrupt-remote-half.json'], 'remote half row is byte-identical');
    return 'remote corrupt rows protected and reported; local/unknown corrupt rows removed';
  });

  // L17 — a directory on the row path must fail early and clearly. The
  // directory half needs no privilege; the symlink half is skippable.
  runCase('L17', '目录占位：update 抛 E_LIVE_ROW_BLOCKED；空目录 prune 后写入恢复', () => {
    const root = newRoot(TMP, 'l17');
    const dir = liveDirOf(root);
    fs.mkdirSync(dir, { recursive: true });
    const placeholder = path.join(dir, 's-dir.json');
    fs.mkdirSync(placeholder);
    const error = expectCode(
      () => liveUpdate({ sessionId: 's-dir', state: 'idle' }, { memoryRoot: root, now: NOW }),
      'E_LIVE_ROW_BLOCKED',
    );
    assert(error.message.includes('目录') && error.message.includes(placeholder), 'error must name the directory');

    const preview = livePrune({}, { memoryRoot: root, now: NOW });
    assert(
      preview.placeholders.some((item) => item.kind === 'directory' && item.fileRel.endsWith('s-dir.json')),
      'empty directory is reported as a placeholder',
    );
    livePrune({ confirm: LIVE_CONFIRM }, { memoryRoot: root, now: NOW });
    assert(!fs.existsSync(placeholder), 'empty directory placeholder removed');
    const written = liveUpdate({ sessionId: 's-dir', state: 'idle' }, { memoryRoot: root, now: NOW });
    assert(written.ok === true && fs.existsSync(liveFile(root, 's-dir')), 'write succeeds after the placeholder is gone');
    return 'update refused a directory with a named error; prune cleared the empty dir; write recovered';
  });

  runSymlinkCase('L17-link', '符号链接占位：update 抛 E_LIVE_ROW_BLOCKED 并按名字指出链接（需符号链接权限）', () => {
    const root = newRoot(TMP, 'l17-link');
    const dir = liveDirOf(root);
    fs.mkdirSync(dir, { recursive: true });
    putRow(root, makeRecord({ sessionId: 's-real', pid: process.pid }));
    const link = path.join(dir, 's-link.json');
    fs.symlinkSync(path.join(dir, 's-real.json'), link, 'file');
    const linkError = expectCode(
      () => liveUpdate({ sessionId: 's-link', state: 'idle' }, { memoryRoot: root, now: NOW }),
      'E_LIVE_ROW_BLOCKED',
    );
    assert(linkError.message.includes('符号链接'), 'symlink row must be refused by name');
    return 'update refused the symlink row with a named error';
  });
}
