// @local/dsh-longlive — test suite
//
//   node test/run.mjs
//
// Builds fake session logs (never touches ~/.dsh/sessions), exercises the
// truncation flow including three failure injections, checks that dry runs
// write nothing, and optionally runs the real headless resume (T7) against a
// temporary DSH_HOME.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseSession, encodeSession, deriveMessagesDigest, sha256, compressFrame, splitFrames } from '../src/codec.js';
import { truncateSession, ERROR_CODES, CONFIRM_WORD } from '../src/truncate.js';
import {
  sessionHealth, sessionBackupPlan, truncateTool, compactTool,
  sessionWake, leaseAcquire, leaseRelease,
  workerSpawn, workerStatus, workerKill, TOOLS,
} from '../src/tools.js';
import { inject } from '../src/index.js';
import { detectHostVersion } from '../src/host-version.js';
import { analyzeCompaction, describeCompaction } from '../src/compaction.js';
import { sha256File, listBackups } from '../src/backup.js';
import { runMemorySuite } from './memory.test.mjs';
import { runConclusionSuite } from './conclusion.test.mjs';
import { runLiveSuite } from './live.test.mjs';
import { runToolsContractSuite } from './tools_contract.test.mjs';
import { runPortabilitySuite } from './portability.test.mjs';
import { runAutoBindSuite } from './autobind.test.mjs';
import { runVisibleTruncateSuite } from './truncate-visible.test.mjs';
import { runAutoTruncateSuite } from './auto-truncate.test.mjs';
import { runCliGuardSuite } from './cli-guard.test.mjs';
import { runOrchestratorSuite } from './orchestrator.test.mjs';
import { runSeededLoadSuite } from './seeded-load.test.mjs';
import { runRouterSuite } from './router.test.mjs';
import { runFailClosedSuite } from './router-failclosed.test.mjs';
import { runShadowSuite } from './router-shadow.test.mjs';
import { runIdentitySuite } from './router-identity.test.mjs';
import { runPolicySuite } from './router-policy.test.mjs';
import { runRouterMemoryToolsSuite } from './router-memory-tools.test.mjs';
import { runDepsSuite } from './deps.test.mjs';
import { runDoctorSetupSuite } from './doctor-setup.test.mjs';
import { VERSION } from '../src/version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-longlive-test-'));
const FIX = path.join(TMP, 'fixtures');

const results = [];
let failed = 0;

// `--release` makes the credential-gated T7 mandatory: a release candidate may
// not call a skip a pass. Local/offline runs keep the opt-in default so the
// suite never opens a credential store on its own.
const RELEASE_GATE = process.argv.includes('--release') || process.env.DSH_RELEASE_GATE === '1';

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail, hashes: hashPairs.get(id) ?? hashPairs.get(currentCase) ?? null });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  ' + detail : ''}`);
}

// A skipped case is NOT a pass: it never becomes a PASS line, never counts
// toward the passed total, and it forces a loud NOTE at the end.
function recordSkip(id, name, detail) {
  results.push({ id, name, ok: true, skipped: true, detail, hashes: hashPairs.get(id) ?? null });
  console.log(`SKIP  ${id}  ${name}${detail ? '  ' + detail : ''}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const hashPairs = new Map();
let currentCase = null;

function noteHashes(id, beforeSha, afterSha) {
  if (beforeSha && afterSha) hashPairs.set(id, { before: beforeSha, after: afterSha });
}

function dirSnapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const st = fs.statSync(full);
      out[path.relative(dir, full)] = `${st.size}:${sha256OfFile(full)}`;
    }
  };
  walk(dir);
  return out;
}

function diffSnapshots(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const key of keys) if (a[key] !== b[key]) changed.push(key);
  return changed;
}

// ---------------------------------------------------------------- fixtures

function buildFixture({ id, turns, title, jobs = true, inbox = false, checkpointAt = Math.ceil(turns * 0.85) }) {
  const events = [];
  const base = Date.now();
  const surface = [];
  const push = (event) => {
    event.seq = events.length;
    event.time = base + events.length;
    events.push(event);
    if (event.surfaceOp === 'append') surface.push(event.seq);
  };
  push({
    type: 'system/message', surfaceOp: 'append',
    data: { message: { role: 'system', id: 'system-1', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '测试用系统提示' }] } },
  });
  for (let t = 1; t <= turns; t += 1) {
    push({ type: 'turn/start', data: { turn: t } });
    push({ type: 'step/start', data: { turn: t, step: 1 } });
    push({
      type: 'user/message', surfaceOp: 'append',
      data: {
        turn: t, step: 1, role: 'user', id: `user-${t}`,
        content: [{ type: 'text', text: `第 ${t} 个问题` }],
        source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      },
    });
    if (inbox && t % 9 === 0) {
      push({
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: `queued-${t}`, text: '排队' }] },
      });
    }
    push({
      type: 'assistant/message', surfaceOp: 'append',
      data: {
        turn: t, step: 1, stream: [],
        message: {
          role: 'assistant', id: `assistant-call-${t}`,
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          content: [{ type: 'tool-call', id: `call-${t}`, name: 'demo', arguments: '{"n":1}' }],
        },
      },
    });
    push({ type: 'tool/call', data: { turn: t, step: 1, callId: `call-${t}`, name: 'demo', arguments: '{"n":1}' } });
    if (jobs && t % 6 === 0) {
      push({ type: 'job/registered', data: { jobId: `job-${t}` } });
      push({ type: 'job/settled', data: { jobId: `job-${t}`, status: 'done' } });
    }
    push({
      type: 'tool/result', surfaceOp: 'append',
      data: {
        turn: t, step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: `call-${t}` },
          toolCallId: `call-${t}`,
          content: [{ type: 'text', text: '{"ok":true}' }],
          isError: false,
          id: `result-${t}`,
        },
      },
    });
    push({
      type: 'assistant/message', surfaceOp: 'append',
      data: {
        turn: t, step: 1, stream: [],
        message: {
          role: 'assistant', id: `assistant-${t}`,
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          content: [{ type: 'text', text: `第 ${t} 个回答` }],
        },
      },
    });
    if (t === checkpointAt) {
      // Compaction checkpoint: replaces the whole visible surface so far,
      // exactly like a real log. The cut point must stay inside the shadowed
      // span so the checkpoint (and its group) is retained and the visible
      // conversation is unchanged.
      const compactionId = 'ckpt-1';
      const startSeq = surface[0];
      const endSeq = surface[surface.length - 1];
      push({ type: 'compaction/start', data: { compactionId, turn: t } });
      push({
        type: 'compaction/summary',
        data: {
          compactionId, turn: t, summary: '（压缩摘要）',
          shadowedRange: { start: startSeq, end: endSeq },
          shadowedSeqs: [...surface],
        },
      });
      push({
        type: 'user/message',
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: [...surface],
        data: {
          turn: t, step: 1, role: 'user', id: `checkpoint-${t}`,
          content: [{ type: 'text', text: '（压缩摘要）' }],
          source: { kind: 'compact-checkpoint', compactionId },
        },
      });
      push({ type: 'compaction/end', data: { compactionId, turn: t } });
      surface.length = 0;
      surface.push(events.length - 1);
    }
    push({ type: 'step/end', data: { turn: t, step: 1 } });
    push({ type: 'turn/end', data: { turn: t } });
  }
  if (title) push({ type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } });
  const header = {
    type: 'session', version: 4, id, createdAt: Date.now(),
    cwd: 'C:\\fixtures', isSeeded: false, delegationDepth: 0,
  };
  return { header, events };
}

function writeFixture(name, options) {
  const { header, events } = buildFixture(options);
  const file = path.join(FIX, name, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeSession(header, events));
  return file;
}

/** Write a log at <base>/<id>/session.v4.jsonl.zstd (used by the resolver test). */
function writeSessionAt(base, id, options) {
  const { header, events } = buildFixture({ id, ...options });
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, encodeSession(header, events));
  return file;
}

// ---------------------------------------------------------------- helpers

function runCase(id, name, fn) {
  currentCase = id;
  try {
    const detail = fn();
    record(id, name, true, detail ?? '');
  } catch (error) {
    record(id, name, false, error.message);
  } finally {
    currentCase = null;
  }
}

async function runAsyncCase(id, name, fn) {
  currentCase = id;
  try {
    record(id, name, true, (await fn()) ?? '');
  } catch (error) {
    record(id, name, false, error.message);
  } finally {
    currentCase = null;
  }
}

// ------------------------------------------------------------- symlinks
//
// Windows refuses `fs.symlinkSync(..., 'file')` with EPERM unless the process
// is elevated or Developer Mode is on. A suite that builds a symlink fixture
// without asking first reports an environment limitation as a product
// failure. So probe once, for real — create, lstat, read through, delete — and
// let the cases that need a file symlink degrade to SKIP with the OS error.
//
// A directory junction needs no privilege (`mklink /J`), so the junction half
// of every mixed case keeps running for real; only the halves whose fixture is
// genuinely impossible here are skipped. DSH_TEST_SYMLINK=deny simulates the
// missing privilege, which is how the SKIP path itself stays exercised.
function probeSymlinkCapability() {
  const forced = String(process.env.DSH_TEST_SYMLINK ?? '').trim().toLowerCase();
  if (['deny', '0', 'off', 'no', 'false'].includes(forced)) {
    return {
      ok: false,
      simulated: true,
      reason: 'symlink privilege unavailable (EPERM) — simulated by DSH_TEST_SYMLINK=deny',
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-longlive-symlink-'));
  const target = path.join(dir, 'target.txt');
  const link = path.join(dir, 'link.txt');
  try {
    fs.writeFileSync(target, 'symlink probe\n');
    fs.symlinkSync(target, link, 'file');
    if (!fs.lstatSync(link).isSymbolicLink()) {
      return { ok: false, simulated: false, reason: 'symlink was created but lstat does not report a link' };
    }
    if (fs.readFileSync(link, 'utf8') !== 'symlink probe\n') {
      return { ok: false, simulated: false, reason: 'symlink was created but reading it did not reach the target' };
    }
    return { ok: true, simulated: false };
  } catch (error) {
    const code = error?.code ?? String(error?.message ?? error).slice(0, 80);
    return { ok: false, simulated: false, reason: `symlink privilege unavailable (${code})` };
  } finally {
    try { fs.unlinkSync(link); } catch { /* the probe may fail before the link exists */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const symlinkProbe = probeSymlinkCapability();
if (!symlinkProbe.ok) {
  console.log(`NOTE  symlink probe: ${symlinkProbe.reason} — symlink-only fixtures will SKIP; junction fixtures still run`);
}

/**
 * Run a case whose fixture needs a real file symlink. When the OS refuses to
 * create one the case is SKIPped with the OS error: never a fake PASS, never a
 * failure, and never silently dropped from the report.
 */
function runSymlinkCase(id, name, fn) {
  if (symlinkProbe.ok) {
    runCase(id, name, fn);
    return;
  }
  const parent = id.replace(/-link$/, '');
  recordSkip(id, name, `${symlinkProbe.reason}; needs a file symlink fixture — junction half ran under ${parent}`);
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert(error.code === code, `expected error code ${code}, got ${error.code ?? '(none)'}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

function truncate(file, extra = {}) {
  const beforeSha = sha256OfFile(file);
  try {
    return truncateSession(file, {
      keepEvents: 900, dryRun: false, confirm: CONFIRM_WORD, recentWriteWindowMs: 0, ...extra,
    });
  } finally {
    noteHashes(currentCase, beforeSha, sha256OfFile(file));
  }
}

/**
 * Run `fn` with some fs methods replaced, then always restore them.
 *
 * The production code used to carry `fault(point)` hooks so tests could crash
 * it from the inside; those hooks are gone. Failures are now injected from the
 * outside, through the same `node:fs` object the plugin imports — no test-only
 * branch lives in src/ any more.
 */
function withFsPatch(patches, fn) {
  const saved = new Map();
  for (const [name, make] of Object.entries(patches)) {
    saved.set(name, fs[name]);
    fs[name] = make(fs[name].bind(fs));
  }
  try {
    return fn();
  } finally {
    for (const [name, original] of saved) fs[name] = original;
  }
}

// ---------------------------------------------------------------- tests

function t1Normal() {
  const file = writeFixture('t1-normal', { id: 'fixture-t1', turns: 120, title: '试试截断' });
  const beforeSha = sha256OfFile(file);
  const beforeBytes = fs.statSync(file).size;
  const original = parseSession(fs.readFileSync(file));
  const baseline = deriveMessagesDigest(original.header, original.events);

  const dry = truncateSession(file, { keepEvents: 400, dryRun: true, recentWriteWindowMs: 0 });
  assert(dry.dryRun === true, 'dry run must be flagged');
  assert(sha256OfFile(file) === beforeSha, 'dry run changed the file');

  const result = truncate(file, { keepEvents: 400 });
  const after = parseSession(fs.readFileSync(file));
  const afterDigest = deriveMessagesDigest(after.header, after.events);

  assert(result.dryRun === false, 'real run must not be flagged dry');
  assert(after.events.length === result.afterEvents, `afterEvents ${result.afterEvents} != file ${after.events.length}`);
  assert(after.events[0].seq === 0, `first seq must be 0, got ${after.events[0].seq}`);
  assert(after.events.at(-1).type === result.beforeLastType,
    `last type changed: ${after.events.at(-1).type} != ${result.beforeLastType}`);
  assert(afterDigest.sha256 === baseline.sha256, 'visible conversation changed');
  assert(afterDigest.count === baseline.count, 'visible message count changed');

  const backup = listBackups(file).at(-1);
  assert(backup, 'no backup file created');
  assert(sha256OfFile(backup.file) === beforeSha, 'backup bytes differ from the original');

  const ledgerFile = path.join(path.dirname(file), 'truncate.json');
  assert(fs.existsSync(ledgerFile), 'truncate.json missing');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert(ledger.truncations.length === 1, 'truncate.json should record one truncation');

  return `${beforeBytes} B -> ${result.afterBytes} B, ${result.beforeEvents} -> ${result.afterEvents} events, ` +
    `messages ${baseline.count}, sha equal`;
}

function t2BackupFailures(mode) {
  const file = writeFixture(`t2-${mode}`, { id: `fixture-t2-${mode}`, turns: 80 });
  const beforeSha = sha256OfFile(file);
  const dir = path.dirname(file);
  const before = new Set(fs.readdirSync(dir));
  let detail = '';
  withFsPatch({
    writeFileSync: (orig) => (target, data, ...rest) => {
      const result = orig(target, data, ...rest);
      if (path.basename(String(target)).startsWith('session.v4.jsonl.zstd.bak-')) {
        // The backup lands, then the disk lies: gone (missing) or wrong bytes.
        if (mode === 'missing') fs.rmSync(target, { force: true });
        else orig(target, Buffer.from('corrupted backup bytes'));
      }
      return result;
    },
  }, () => {
    const error = expectCode(() => truncate(file, { keepEvents: 300 }),
      mode === 'missing' ? ERROR_CODES.BACKUP_MISSING : ERROR_CODES.BACKUP_MISMATCH);
    assert(sha256OfFile(file) === beforeSha, 'original changed after backup failure');
    detail = `${error.code}: ${error.message.slice(0, 70)}…`;
  });
  const leftovers = fs.readdirSync(dir).filter((name) => !before.has(name));
  assert(leftovers.length === 0, `backup failure left files behind: ${leftovers.join(', ')}`);
  return `${detail}; refused before the tmp write, no leftover backup`;
}
function t3CrashBeforeRename() {
  const file = writeFixture('t3-before-rename', { id: 'fixture-t3', turns: 60 });
  const beforeSha = sha256OfFile(file);
  let tmpSeen = null;
  withFsPatch({
    renameSync: () => (from) => {
      tmpSeen = String(from);
      const error = new Error('injected crash before rename');
      error.code = 'ENOSPC';
      throw error;
    },
  }, () => {
    const error = expectCode(() => truncate(file, { keepEvents: 200 }), 'ENOSPC');
    assert(error.code === 'ENOSPC', `expected the injected ENOSPC, got ${error.code}`);
  });
  assert(sha256OfFile(file) === beforeSha, 'original changed after crash before rename');
  assert(tmpSeen && !fs.existsSync(tmpSeen), 'tmp file should be cleaned up');
  return 'original unchanged, tmp removed, error ENOSPC';
}

function t4PostRenameRollback() {
  const file = writeFixture('t4-rollback', { id: 'fixture-t4', turns: 60 });
  const beforeSha = sha256OfFile(file);
  let renamed = false;
  let error = null;
  withFsPatch({
    // The rename lands, then the bytes read back are corrupt: this is the only
    // way a real crash can leave a file that fails the post-write verification.
    renameSync: (orig) => (from, to) => { const result = orig(from, to); renamed = true; return result; },
    readFileSync: (orig) => (target, ...rest) => (
      renamed && path.resolve(String(target)) === path.resolve(file)
        ? Buffer.from('corrupted bytes read back after the rename')
        : orig(target, ...rest)),
  }, () => {
    error = expectCode(() => truncateSession(file, {
      keepEvents: 200, dryRun: false, confirm: CONFIRM_WORD, recentWriteWindowMs: 0,
    }), ERROR_CODES.POST_VERIFY);
  });
  assert(sha256OfFile(file) === beforeSha, 'original not restored from the backup');
  const rollbackFile = path.join(path.dirname(file), 'rollback.json');
  assert(fs.existsSync(rollbackFile), 'rollback.json missing');
  const rollback = JSON.parse(fs.readFileSync(rollbackFile, 'utf8'));
  assert(rollback.restoredSha256 === beforeSha, 'rollback.json does not record the original sha256');
  return `${error.code}, restored sha ${beforeSha.slice(0, 12)}…`;
}

// ------------------------------------------------------------ N1–N4 regressions

function n1ConcurrentAppendSurvives() {
  const file = writeFixture('n1-append', { id: 'fixture-n1', turns: 100, title: '并发追加' });
  const snapshotBuf = fs.readFileSync(file);
  const snapshotSha = crypto.createHash('sha256').update(snapshotBuf).digest('hex');
  const parsed = parseSession(snapshotBuf);
  let appendedSha = null;
  let lostAppend = null;
  withFsPatch({
    // A real writer appends three events between the snapshot and the rename —
    // exactly the write the old code renamed over and destroyed.
    writeFileSync: (orig) => (target, data, ...rest) => {
      const result = orig(target, data, ...rest);
      if (appendedSha === null && String(target).includes('.tmp-')) {
        const extra = [1, 2, 3].map((n) => ({
          seq: parsed.events.length + n - 1,
          type: 'user/message',
          surfaceOp: 'append',
          data: { turn: 999, step: 1, role: 'user', id: `late-${n}`, content: [{ type: 'text', text: `late append ${n}` }] },
        }));
        fs.appendFileSync(file, compressFrame(extra.map((e) => `${JSON.stringify(e)}\n`).join('')));
        appendedSha = sha256OfFile(file);
      }
      return result;
    },
  }, () => {
    const error = expectCode(() => truncate(file, { keepEvents: 300 }), ERROR_CODES.CHANGED);
    assert(error.code === 'SESSION_CHANGED', `expected SESSION_CHANGED, got ${error.code}`);
    assert(/Nothing was written/.test(error.message), `refusal must say nothing was written: ${error.message}`);
  });
  const after = parseSession(fs.readFileSync(file));
  lostAppend = after.events.length !== parsed.events.length + 3;
  const nowSha = sha256OfFile(file);
  const backups = listBackups(file);
  const newest = backups.at(-1);
  const newestSha = sha256OfFile(newest.file);
  const newestSize = fs.statSync(newest.file).size;
  const detail = `append kept (${parsed.events.length} -> ${after.events.length} events, lostAppend=${lostAppend}); ` +
    `backup ${path.basename(newest.file)} sha ${newestSha.slice(0, 12)}…`;
  assert(lostAppend === false, 'the concurrent append was lost: truncate renamed over it');
  assert(nowSha === appendedSha, 'the log on disk is not the appended version');
  assert(newestSha === snapshotSha, `backup is not the snapshot bytes: ${newestSha} != ${snapshotSha}`);
  assert(newestSize === snapshotBuf.length, `backup size ${newestSize} != snapshot ${snapshotBuf.length}`);
  return detail;
}

function n2FrameBoundariesIgnoreMagicInData() {
  const source = writeFixture('n2-source', { id: 'fixture-n2', turns: 120, title: '魔数夹具' });
  const parsed = parseSession(fs.readFileSync(source));
  const half = Math.floor(parsed.events.length / 2);
  const lines = (slice) => slice.map((e) => `${JSON.stringify(e)}\n`).join('');
  const first = compressFrame(`${JSON.stringify(parsed.header)}\n${lines(parsed.events.slice(0, half))}`);
  const second = compressFrame(lines(parsed.events.slice(half)));
  // A skippable zstd frame is legal payload between real frames, and its bytes
  // are arbitrary: put the 4-byte frame magic inside it. A magic scanner reads
  // that as a frame start; a structural walk does not.
  const payload = Buffer.concat([
    Buffer.from('decoy: '), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from(' not a frame'),
  ]);
  const skipHeader = Buffer.alloc(8);
  skipHeader.writeUInt32LE(0x184d2a50, 0);
  skipHeader.writeUInt32LE(payload.length, 4);
  const skippable = Buffer.concat([skipHeader, payload]);
  const log = Buffer.concat([first, skippable, second]);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const decoyAt = log.indexOf(magic, 4);
  assert(decoyAt > 0 && decoyAt !== first.length, `fixture has no decoy magic (offset ${decoyAt})`);

  const frames = splitFrames(log);
  const starts = frames.map((f) => f.start);
  const expected = [0, first.length, first.length + skippable.length];
  assert(JSON.stringify(starts) === JSON.stringify(expected),
    `frame boundaries ${JSON.stringify(starts)} != true boundaries ${JSON.stringify(expected)}`);
  const reparsed = parseSession(log);
  assert(reparsed.events.length === parsed.events.length,
    `reparsed ${reparsed.events.length} events != ${parsed.events.length}`);
  assert(reparsed.texts.join('').length > 0, 'frames decompressed to no text');

  const home = path.join(TMP, 'n2-home');
  fs.rmSync(home, { recursive: true, force: true });
  const scope = path.join(home, 'sessions', '--n2--');
  fs.mkdirSync(scope, { recursive: true });
  const file = path.join(scope, 'session-magic', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, log);

  const health = sessionHealth({ sessionPath: file }, { home });
  assert(health.ok !== false && health.status === 'ok', `health is ${health.status}: ${health.message}`);
  const result = truncateSession(file, {
    keepEvents: 300, dryRun: false, confirm: CONFIRM_WORD, recentWriteWindowMs: 0,
  });
  const after = parseSession(fs.readFileSync(file));
  assert(after.events.length === result.afterEvents, `afterEvents ${result.afterEvents} != ${after.events.length}`);
  return `${log.length} B / ${frames.length} frames (decoy magic at ${decoyAt}); health ok, ` +
    `truncate ${parsed.events.length} -> ${after.events.length} events`;
}

function n3LeaseBoundsAndCorruptExpiry() {
  const root = writeMemRoot(path.join(TMP, 'n3-mem'), { 'STATE.md': '# s\n' });
  const leaseFile = path.join(root, '.lease');
  const refused = [];
  for (const ttlSec of [1e15, 86_401, 0, -1, 1.5, '60']) {
    const out = leaseAcquire({ holder: 'greedy', ttlSec }, { memRoot: root });
    assert(out.ok === false && out.code === 'BAD_ARGUMENT',
      `ttlSec ${String(ttlSec)} was not refused: ${JSON.stringify(out)}`);
    assert(!fs.existsSync(leaseFile), `ttlSec ${String(ttlSec)} wrote .lease before being refused`);
    refused.push(String(ttlSec));
  }
  const max = leaseAcquire({ holder: 'max-ttl', ttlSec: 86_400 }, { memRoot: root });
  assert(max.ok === true, `ttlSec 86400 should be allowed: ${JSON.stringify(max)}`);
  assert(typeof max.expiresAt === 'string' && !Number.isNaN(Date.parse(max.expiresAt)),
    `expiresAt is not a usable time: ${max.expiresAt}`);

  const poison = (record) => fs.writeFileSync(leaseFile, JSON.stringify(record));
  // A lease the old code poisoned: ttlSec 1e15 used to derive a year-33658 date
  // and throw RangeError on every later read.
  poison({ holder: 'zombie', pid: 1, acquiredAt: new Date().toISOString(), ttlSec: 1e15 });
  const afterPoison = leaseAcquire({ holder: 'writer-poison', ttlSec: 60 }, { memRoot: root });
  assert(afterPoison.ok === true && afterPoison.tookOver === true,
    `a poisoned lease locked the store: ${JSON.stringify(afterPoison)}`);

  poison({ holder: 'zombie', pid: 1, acquiredAt: new Date().toISOString(), ttlSec: 60, expiresAt: 'not-a-date' });
  const afterBadString = leaseAcquire({ holder: 'writer-bad-string', ttlSec: 60 }, { memRoot: root });
  assert(afterBadString.ok === true && afterBadString.tookOver === true,
    `expiresAt:"not-a-date" was not treated as expired: ${JSON.stringify(afterBadString)}`);

  poison({ holder: 'zombie', pid: 1, acquiredAt: new Date().toISOString(), ttlSec: 60, expiresAt: 8.7e15 });
  const afterBadNumber = leaseAcquire({ holder: 'writer-bad-number', ttlSec: 60 }, { memRoot: root });
  assert(afterBadNumber.ok === true && afterBadNumber.tookOver === true,
    `an out-of-range expiresAt was not treated as expired: ${JSON.stringify(afterBadNumber)}`);

  const blocked = leaseAcquire({ holder: 'someone-else', ttlSec: 60 }, { memRoot: root });
  assert(blocked.ok === false && /held by/.test(String(blocked.reason)),
    `a live lease stopped blocking: ${JSON.stringify(blocked)}`);
  return `ttlSec ${refused.join('/')} refused with no .lease; 86400 ok; poisoned/not-a-date/8.7e15 ` +
    'leases taken over; a live lease still blocks';
}

function n4BackupsAreNotWritableTargets() {
  const home = path.join(TMP, 'n4-home');
  fs.rmSync(home, { recursive: true, force: true });
  const scope = path.join(home, 'sessions', '--n4--');
  fs.mkdirSync(scope, { recursive: true });
  const file = writeSessionAt(scope, 'session-n4', { turns: 60, title: '备份目标' });
  const backup = `${file}.bak-20261101`;
  fs.copyFileSync(file, backup);
  const backupSha = sha256OfFile(backup);
  const backupSize = fs.statSync(backup).size;
  const dir = path.dirname(file);
  const before = dirSnapshot(dir);

  const refused = truncateTool({
    sessionPath: backup, keepEvents: 100, dryRun: false, confirm: CONFIRM_WORD, recentWriteWindowMs: 0,
  }, { home });
  assert(refused.ok === false && refused.code === 'IS_BACKUP',
    `truncate on a .bak-* was not refused: ${JSON.stringify(refused)}`);
  assert(sha256OfFile(backup) === backupSha && fs.statSync(backup).size === backupSize,
    'the refused truncate changed the backup bytes');

  // The tool layer refuses before truncating; the core refuses on its own too,
  // so a direct library call cannot eat the rollback source either.
  let libRefusal = null;
  try {
    truncateSession(backup, {
      keepEvents: 10, dryRun: false, confirm: CONFIRM_WORD, recentWriteWindowMs: 0,
    });
  } catch (error) {
    libRefusal = error;
  }
  assert(libRefusal?.code === 'IS_BACKUP',
    `truncateSession on a backup: ${libRefusal?.code ?? 'no error'}`);
  assert(sha256OfFile(backup) === backupSha, 'the library-level refusal changed the backup bytes');

  const nested = sessionBackupPlan({ sessionPath: backup, dryRun: false, confirm: 'BACKUP' }, { home });
  assert(nested.ok === false && nested.code === 'IS_BACKUP',
    `backing up a backup was not refused: ${JSON.stringify(nested)}`);
  const nestedDry = sessionBackupPlan({ sessionPath: backup, dryRun: true }, { home });
  assert(nestedDry.ok === false && nestedDry.code === 'IS_BACKUP',
    `a dry plan to back up a backup was not refused: ${JSON.stringify(nestedDry)}`);

  const after = dirSnapshot(dir);
  const changed = diffSnapshots(before, after);
  assert(changed.length === 0, `refusals still wrote files: ${changed.join(', ')}`);
  assert(fs.readdirSync(dir).filter((n) => n.includes('.bak-')).length === 1,
    'a refused backup-on-backup still created a nested .bak-* file');

  // Read tools keep accepting backups: inspecting one is a legitimate question.
  const health = sessionHealth({ sessionPath: backup }, { home });
  assert(health.ok !== false && health.status === 'ok', `health on a backup: ${health.status} ${health.message}`);
  return `truncate/backup(dry+real) on ${path.basename(backup)} -> IS_BACKUP, bytes and tree unchanged, ` +
    `health still reads it (${health.events} events)`;
}

async function n4CompactRefusesBackup() {
  const home = path.join(TMP, 'n4c-home');
  fs.rmSync(home, { recursive: true, force: true });
  const scope = path.join(home, 'sessions', '--n4c--');
  fs.mkdirSync(scope, { recursive: true });
  const file = writeSessionAt(scope, 'session-n4c', { turns: 40 });
  const backup = `${file}.bak-20261101`;
  fs.copyFileSync(file, backup);
  const backupSha = sha256OfFile(backup);
  const out = await compactTool({ sessionPath: backup, dryRun: true }, { home });
  assert(out.ok === false && out.code === 'IS_BACKUP',
    `session_compact on a .bak-* was not refused: ${JSON.stringify(out)}`);
  assert(sha256OfFile(backup) === backupSha, 'the refused compact changed the backup bytes');
  return `${out.code}: ${String(out.message).slice(0, 60)}…`;
}

function t5LiveRefusals() {
  const file = writeFixture('t5-live', { id: 'fixture-t5', turns: 40 });
  const beforeSha = sha256OfFile(file);

  const fresh = expectCode(() => truncateSession(file, { keepEvents: 100, dryRun: false, confirm: CONFIRM_WORD }),
    ERROR_CODES.RECENT_WRITE);
  assert(sha256OfFile(file) === beforeSha, 'original changed after RECENT_WRITE');

  fs.chmodSync(file, 0o444);
  try {
    // 0.7.2 takes an exclusive handle before anything else; a read-only file
    // fails that probe and is reported as VISIBLE_FILE_BUSY (the old r+ probe
    // only produced SESSION_LOCKED after the mtime guard had been disabled).
    const locked = expectCode(() => truncateSession(file, {
      keepEvents: 100, dryRun: false, confirm: CONFIRM_WORD, recentWriteWindowMs: 0,
    }), ERROR_CODES.FILE_BUSY);
    assert(sha256OfFile(file) === beforeSha, 'original changed after LOCKED');
    noteHashes('T5', beforeSha, sha256OfFile(file));
    return `${fresh.code} + ${locked.code}`;
  } finally {
    fs.chmodSync(file, 0o666);
  }
}

function t6ThreeFixtures() {
  const reports = [];
  for (const [name, turns, keep] of [['small', 8, 45], ['medium', 60, 300], ['large', 400, 2000]]) {
    const file = writeFixture(`t6-${name}`, { id: `fixture-t6-${name}`, turns, title: `中文标题-${name}` });
    const before = parseSession(fs.readFileSync(file));
    const base = deriveMessagesDigest(before.header, before.events);
    const beforeBytes = fs.statSync(file).size;
    const result = truncate(file, { keepEvents: keep });
    const after = parseSession(fs.readFileSync(file));
    const afterDigest = deriveMessagesDigest(after.header, after.events);
    assert(afterDigest.sha256 === base.sha256, `${name}: visible conversation changed`);
    const hasTitle = after.events.some((e) => e.type === 'session/title');
    assert(hasTitle, `${name}: title lost`);
    reports.push(`${name} ${beforeBytes}B->${result.afterBytes}B (${before.events.length}->${after.events.length})`);
  }
  return reports.join('; ');
}

function t6bInboxBoundary() {
  const file = writeFixture('t6b-inbox', { id: 'fixture-t6b', turns: 120, inbox: true });
  const before = parseSession(fs.readFileSync(file));
  const base = deriveMessagesDigest(before.header, before.events);
  const result = truncate(file, { keepEvents: 600 });
  const after = parseSession(fs.readFileSync(file));
  assert(deriveMessagesDigest(after.header, after.events).sha256 === base.sha256, 'visible conversation changed');
  assert(after.events.every((e) => !e.type.startsWith('agent/inbox/')), 'inbox event survived into the kept window');
  return `kept ${result.afterEvents} events; inbox traffic dropped (${result.advancedForInbox || 'none in window'})`;
}

function t8DryRunZeroWrites() {
  const file = writeFixture('t8-dry', { id: 'fixture-t8', turns: 50 });
  const dir = path.dirname(file);
  const before = dirSnapshot(dir);

  sessionHealth({ sessionPath: file });
  sessionBackupPlan({ sessionPath: file, dryRun: true });
  truncateSession(file, { keepEvents: 100, dryRun: true, recentWriteWindowMs: 0 });

  const after = dirSnapshot(dir);
  const changed = diffSnapshots(before, after);
  assert(changed.length === 0, `dry runs wrote: ${changed.join(', ')}`);
  return `3 tools, 0 files written (${Object.keys(before).length} files)`;
}

function t9ResolveSession() {
  const home = path.join(TMP, 't9-home');
  fs.rmSync(home, { recursive: true, force: true });
  const scopeA = path.join(home, 'sessions', '--scope-a--');
  const scopeB = path.join(home, 'sessions', '--scope-b--');
  fs.mkdirSync(scopeA, { recursive: true });
  fs.mkdirSync(scopeB, { recursive: true });

  const older = writeSessionAt(scopeA, 'session-old', { turns: 40, title: '旧的' });
  const newer = writeSessionAt(scopeB, 'session-new', { turns: 40, title: '新的' });
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 7_200_000), new Date(now - 7_200_000));
  fs.utimesSync(newer, new Date(now - 60_000), new Date(now - 60_000));

  const config = { home };
  const empty = path.join(TMP, 't9-empty-home');
  fs.mkdirSync(empty, { recursive: true });

  // 1) session:"latest" -> the most recently modified log, across scopes.
  const latest = sessionHealth({ session: 'latest' }, config);
  assert(latest.sessionPath === newer, `latest resolved to ${latest.sessionPath}, expected ${newer}`);
  assert(latest.status === 'ok', `latest health status ${latest.status}: ${latest.message}`);

  // 2) sessionId -> exact match, regardless of age.
  const byId = sessionHealth({ sessionId: 'session-old' }, config);
  assert(byId.sessionPath === older, `sessionId resolved to ${byId.sessionPath}, expected ${older}`);

  // 3) unknown id -> SESSION_NOT_FOUND with up to three recent candidates.
  const missing = sessionHealth({ sessionId: 'session-missing' }, config);
  assert(missing.status === 'error', 'unknown id must be an error');
  assert(missing.error.code === 'SESSION_NOT_FOUND', `expected SESSION_NOT_FOUND, got ${missing.error.code}`);
  const ids = missing.error.candidates.map((c) => c.id);
  assert(ids.length === 2 && ids[0] === 'session-new', `candidates ${JSON.stringify(ids)}`);
  assert(missing.message.includes('session-missing'), 'message should name the missing id');

  // 4) empty home -> SESSION_NOT_FOUND, no throw.
  const none = sessionHealth({ session: 'latest' }, { home: empty });
  assert(none.status === 'error' && none.error.code === 'SESSION_NOT_FOUND', 'empty home must be SESSION_NOT_FOUND');

  // 5) dry runs through the resolver still write nothing.
  const snapshot = dirSnapshot(home);
  sessionHealth({ session: 'latest' }, config);
  sessionBackupPlan({ session: 'latest', dryRun: true }, config);
  truncateTool({ session: 'latest', keepEvents: 60, dryRun: true }, config);
  truncateTool({ sessionId: 'session-old', keepEvents: 60, dryRun: true }, config);
  const changed = diffSnapshots(snapshot, dirSnapshot(home));
  assert(changed.length === 0, `resolver dry runs wrote: ${changed.join(', ')}`);

  return `latest->${path.basename(path.dirname(newer))}, sessionId->${path.basename(path.dirname(older))}, ` +
    `missing->SESSION_NOT_FOUND(${ids.join(', ')}), dry-run wrote 0 files`;
}

// ---------------------------------------------------------------- T7 real resume

function t10CompactionAnalysis() {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'system/message', data: { role: 'system', content: [] }, surfaceOp: 'append' },
    { seq: 2, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'old' }] }, surfaceOp: 'append' },
    { seq: 3, type: 'compaction/start', data: { compactionId: 'c1', turn: 1 } },
    {
      seq: 4,
      type: 'compaction/summary',
      data: {
        compactionId: 'c1',
        shadowedRange: { start: 2, end: 2 },
        shadowedSeqs: [2],
        shadowedTokenCount: 1234,
        summary: [{ type: 'text', text: 'S'.repeat(50) }],
      },
    },
    {
      seq: 5,
      type: 'user/message',
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'S'.repeat(50) }],
        source: { kind: 'compact-checkpoint', compactionId: 'c1' },
      },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
    },
    { seq: 6, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'new' }] }, surfaceOp: 'append' },
    { seq: 7, type: 'compaction/end', data: { compactionId: 'c1', turn: 1 } },
  ];
  const a = analyzeCompaction({ header: {}, events });
  assert(a.compactionFiles === 1, `compactionFiles ${a.compactionFiles}`);
  assert(a.closedCompactions === 1, `closedCompactions ${a.closedCompactions}`);
  assert(a.checkpointsOnSurface === 1, `checkpointsOnSurface ${a.checkpointsOnSurface}`);
  assert(a.shadowedEvents === 1 && a.shadowedEventsStillStored === 1,
    `shadowed ${a.shadowedEvents} / still stored ${a.shadowedEventsStillStored}`);
  assert(a.shadowedTokens === 1234, `shadowedTokens ${a.shadowedTokens}`);
  assert(a.visibleMessages === 3, `visibleMessages ${a.visibleMessages} (head + checkpoint + new)`);
  assert(a.visibleFirstSeq === 1, `visibleFirstSeq ${a.visibleFirstSeq}`);
  const verdict = describeCompaction(a);
  assert(verdict.includes('shadowed') && verdict.includes('3 messages'), `verdict: ${verdict}`);

  // A log with no compaction records at all is "never compacted".
  const stripped = events.filter((e) =>
    !e.type.startsWith('compaction/') && e.data?.source?.kind !== 'compact-checkpoint');
  const never = analyzeCompaction({ header: {}, events: stripped });
  assert(never.compactionFiles === 0, `never-compacted log reported ${never.compactionFiles} files`);
  assert(describeCompaction(never).includes('/compact'), `never-compacted verdict: ${describeCompaction(never)}`);
  // The 2026-10-30 13:48 shape: the checkpoint survives, its summary does not.
  // Its surfaceOp still shadows that span, so the measurement must not read 0.
  const orphan = analyzeCompaction({ header: {}, events: events.filter((e) => e.type !== 'compaction/summary') });
  assert(orphan.shadowedEvents === 1, `orphan checkpoint must still measure 1 shadowed event, got ${orphan.shadowedEvents}`);
  assert(orphan.files[0]?.metadataIncomplete === true, 'orphan checkpoint must be flagged incomplete');
  assert(describeCompaction(orphan).includes('incomplete'), `orphan verdict: ${describeCompaction(orphan)}`);
  return `1 group, 1 shadowed event still stored, 3 visible messages; incomplete-checkpoint 判词可辨；verdict "${verdict.slice(0, 46)}…"`;
}

async function t11CompactStates() {
  const idle = { status: 'idle' };
  const busy = { status: 'running', whenIdle: () => new Promise(() => {}) };
  const compaction = {
    compactNow: async () => ({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 999, summarySeq: 42 }),
  };
  const noHost = await compactTool({ dryRun: true }, {});
  assert(noHost.status === 'unavailable', `no host -> ${noHost.status}`);
  const noService = await compactTool({ dryRun: true }, { host: () => ({ agent: idle }) });
  assert(noService.status === 'unavailable' && noService.message.includes('/compact'),
    `no compaction service -> ${noService.status}/${noService.message}`);
  // A real Cordis context is a Proxy that throws on an undeclared service read —
  // `cannot get property "compaction" without inject`. That means "this profile
  // loads no compaction service", so the tool must degrade, never throw.
  const guarded = {
    get agent() { throw new Error('cannot get property "agent" without inject'); },
    get compaction() { throw new Error('cannot get property "compaction" without inject'); },
    get() { throw new Error('cannot get property "compaction" without inject'); },
  };
  const guardedResult = await compactTool({ dryRun: true }, { host: () => guarded });
  assert(guardedResult.status === 'unavailable',
    `inject guard must degrade, got ${guardedResult.status}`);
  assert(guardedResult.available === false, `inject guard available -> ${guardedResult.available}`);
  const planned = await compactTool({ dryRun: true }, { host: () => ({ compaction, agent: idle }) });
  assert(planned.status === 'planned', `dryRun -> ${planned.status}`);
  const done = await compactTool({ dryRun: false }, { host: () => ({ compaction, agent: idle }) });
  assert(done.status === 'compacted' && done.result.summarySeq === 42, `idle run -> ${done.status}`);
  assert(done.message.includes('3 events'), `message ${done.message}`);
  const scheduled = await compactTool({ dryRun: false }, { host: () => ({ compaction, agent: busy }) });
  assert(scheduled.status === 'scheduled', `busy -> ${scheduled.status}`);
  assert(scheduled.message.includes('turn ends'), `queued message ${scheduled.message}`);
  return 'unavailable / dryRun / idle-compacted / busy-queued all correct';
}

// ---------------------------------------------------------------- wake / lease

/** Build a throwaway memory store under the test temp dir (never the real one). */
function writeMemRoot(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
  return dir;
}

function t12WakeNormal() {
  const root = writeMemRoot(path.join(TMP, 't12-mem'), {
    'STATE.md': [
      '# STATE · 状态卡',
      '',
      '## 我在哪',
      '正在做 longlive v0.2，主文件 src/tools.js；上一段刚把唤醒包写完。'.repeat(2),
      '',
      '## 在等什么',
      '等他重启 DSH，重启后先读 STATE.md 再开工。',
      '',
      '## 最近三件未完成',
      '1. 验证真机加载',
      '2. 补 session_wake',
      '3. 修 T7 夹具',
      '',
      '## 别的一节',
      'SECTION-SHOULD-NOT-APPEAR',
    ].join('\n'),
    'flow/current.md': '我刚把唤醒包写完，正在想 lease 怎么写。',
    'journal/2026-10.md': '# 十月\n\n## 第一段\n\n## 第二段\n\n## 第三段\n',
    'journal/2026-12.md': '# 十二月\n\n## 甲\n\n## 乙\n\n## 丙\n\n## 丁\n',
    'INDEX.md': [
      '# 引子索引',
      '| 人物 | 金嘉恒、老大 | topics/people.md |',
      '| 地点 | 西安、杭州 | 先查 journal/ |',
      '这一行故意写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长，长度超过六十个字符，不该出现在唤醒包里。',
    ].join('\n'),
  });

  const wake = sessionWake({ session: 'test' }, { memRoot: root });
  assert(wake.status === 'ok', `status ${wake.status}: ${wake.message}`);
  assert(wake.chars === wake.message.length, 'chars must equal message length');
  assert(wake.chars <= 2500, `wake returned ${wake.chars} chars (> 2500)`);
  for (const keyword of ['我在哪', '在等什么', '最近三件']) {
    assert(wake.message.includes(keyword), `missing section ${keyword}`);
  }
  assert(!wake.message.includes('SECTION-SHOULD-NOT-APPEAR'), 'a section outside the three was included');
  assert(wake.message.includes('我刚把唤醒包写完'), 'flow/current.md body missing');
  assert(wake.message.includes('## 乙') && wake.message.includes('## 丙') && wake.message.includes('## 丁'),
    'the last three journal headings are missing');
  assert(!wake.message.includes('## 甲'), 'journal included a heading older than the last three');
  assert(wake.message.includes('topics/people.md'), 'INDEX short lines missing');
  assert(!wake.message.includes('长度超过六十个字符'), 'INDEX long line leaked into the wake text');
  assert(wake.sources.includes('STATE.md') && wake.sources.includes('INDEX.md'), `sources ${wake.sources}`);
  return `${wake.chars} chars, sources ${wake.sources.join(' + ')}`;
}

function t13WakeUnavailable() {
  const root = path.join(TMP, 't13-missing-root');
  fs.rmSync(root, { recursive: true, force: true });
  const wake = sessionWake({}, { memRoot: root });
  assert(wake.status === 'unavailable', `status ${wake.status}`);
  assert(wake.message.includes(root), `unavailable message must name the root: ${wake.message}`);
  assert(wake.message.includes('DSH_MEM'), `unavailable message must mention DSH_MEM: ${wake.message}`);
  assert(wake.message.length <= 2500, 'unavailable message exceeds 2500 chars');
  return `unavailable: ${wake.message.slice(0, 52)}…`;
}

function t14WakePartialAndCaps() {
  const root = writeMemRoot(path.join(TMP, 't14-mem'), {
    'STATE.md': `# STATE\n\n## 我在哪\n${'定位很长的内容。'.repeat(60)}\n`,
    'flow/current.md': '心流快照。'.repeat(300),
  });
  const wake = sessionWake({}, { memRoot: root });
  assert(wake.status === 'ok', `status ${wake.status}: ${wake.message}`);
  assert(wake.message.includes('flow/current.md'), 'missing flow block');
  assert(/截断/.test(wake.message), 'long flow must be marked as truncated');
  assert(wake.message.includes('跳过'), 'skipped files need an inline note');
  assert(wake.message.length <= 2500, `chars ${wake.message.length} > 2500`);
  assert(wake.missing.some((m) => m.startsWith('journal/')), `missing must list journal: ${wake.missing}`);
  assert(wake.missing.some((m) => m.startsWith('INDEX.md')), `missing must list INDEX.md: ${wake.missing}`);
  return `${wake.chars} chars, ${wake.missing.length} skipped source(s): ${wake.missing.join(', ')}`;
}

function t15LeaseAcquire() {
  const root = writeMemRoot(path.join(TMP, 't15-mem'), { 'STATE.md': '# s\n' });
  const first = leaseAcquire({ holder: 'writer-a', ttlSec: 60 }, { memRoot: root });
  assert(first.ok === true, `first acquire failed: ${JSON.stringify(first)}`);
  assert(first.ttlSec === 60, `ttlSec ${first.ttlSec}`);
  const file = path.join(root, '.lease');
  assert(fs.existsSync(file), 'lease file missing');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['holder', 'pid', 'acquiredAt', 'ttlSec']) {
    assert(key in raw, `lease JSON missing ${key}: ${JSON.stringify(raw)}`);
  }
  assert(raw.holder === 'writer-a', `holder ${raw.holder}`);
  assert(raw.pid === process.pid, `pid ${raw.pid} != ${process.pid}`);
  assert(raw.ttlSec === 60, `ttlSec ${raw.ttlSec}`);
  assert(/^\d{4}-\d\d-\d\dT/.test(raw.acquiredAt) && !Number.isNaN(Date.parse(raw.acquiredAt)),
    `acquiredAt is not an ISO time: ${raw.acquiredAt}`);
  return `.lease ${JSON.stringify(raw).slice(0, 96)}…`;
}

function t16LeaseRejected() {
  const root = writeMemRoot(path.join(TMP, 't16-mem'), { 'STATE.md': '# s\n' });
  const a = leaseAcquire({ holder: 'writer-a' }, { memRoot: root });
  assert(a.ok === true, `first writer should win: ${JSON.stringify(a)}`);
  const b = leaseAcquire({ holder: 'writer-b' }, { memRoot: root });
  assert(b.ok === false, 'second writer must be refused');
  assert(b.reason === 'held by another writer', `reason "${b.reason}"`);
  assert(b.holder === 'writer-a', `reported holder ${b.holder}`);
  assert(b.acquiredAt === a.acquiredAt, `acquiredAt ${b.acquiredAt} != ${a.acquiredAt}`);
  const raw = JSON.parse(fs.readFileSync(path.join(root, '.lease'), 'utf8'));
  assert(raw.holder === 'writer-a', 'a refused acquire must not overwrite the lease');
  const again = leaseAcquire({ holder: 'writer-a' }, { memRoot: root });
  assert(again.ok === false && again.reason === 'held by another writer',
    'the same holder re-acquiring must also be refused while the lease is alive');
  return `refused: "${b.reason}", held by ${b.holder} since ${b.acquiredAt}`;
}

function t17LeaseExpired() {
  const root = writeMemRoot(path.join(TMP, 't17-mem'), { 'STATE.md': '# s\n' });
  const leaseFile = path.join(root, '.lease');
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  fs.writeFileSync(leaseFile, JSON.stringify({ holder: 'ghost-writer', pid: 999999, acquiredAt: old, ttlSec: 60 }));
  const taken = leaseAcquire({ holder: 'writer-new', ttlSec: 300 }, { memRoot: root });
  assert(taken.ok === true, `expired lease not taken over: ${JSON.stringify(taken)}`);
  assert(taken.tookOver === true, 'tookOver must be flagged');
  assert(taken.previous?.holder === 'ghost-writer', `previous holder ${taken.previous?.holder}`);
  const raw = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  assert(raw.holder === 'writer-new', `holder after takeover ${raw.holder}`);

  // Unparseable content counts as expired (JSON.parse failure).
  fs.writeFileSync(leaseFile, 'not json at all');
  const corrupt = leaseAcquire({ holder: 'writer-corrupt' }, { memRoot: root });
  assert(corrupt.ok === true, `unparseable lease not treated as expired: ${JSON.stringify(corrupt)}`);
  assert(corrupt.previous === null, `previous for a corrupt lease ${JSON.stringify(corrupt.previous)}`);
  return 'expired ghost-writer -> writer-new (tookOver), corrupt lease -> writer-corrupt';
}

function t18LeaseRelease() {
  const root = writeMemRoot(path.join(TMP, 't18-mem'), { 'STATE.md': '# s\n' });
  const leaseFile = path.join(root, '.lease');
  const noLease = leaseRelease({ holder: 'writer-a' }, { memRoot: root });
  assert(noLease.ok === false && noLease.reason === 'no lease', `no lease -> ${noLease.ok}/${noLease.reason}`);

  const got = leaseAcquire({ holder: 'writer-a' }, { memRoot: root });
  assert(got.ok === true, 'acquire failed');
  const wrong = leaseRelease({ holder: 'writer-b' }, { memRoot: root });
  assert(wrong.ok === false, 'a non-holder release must fail');
  assert(wrong.reason === 'not the holder', `reason ${wrong.reason}`);
  assert(fs.existsSync(leaseFile), 'a non-holder release deleted the lease');
  assert(JSON.parse(fs.readFileSync(leaseFile, 'utf8')).holder === 'writer-a', 'lease holder changed after refusal');

  const mine = leaseRelease({ holder: 'writer-a' }, { memRoot: root });
  assert(mine.ok === true, `holder release failed: ${JSON.stringify(mine)}`);
  assert(!fs.existsSync(leaseFile), 'the lease file survived a holder release');
  return 'no lease -> refused; writer-b -> "not the holder" (lease kept); writer-a -> released';
}

/**
 * Two real processes race the same lease. Both spin until one shared instant and
 * then call leaseAcquire, so the O_EXCL guarantee is exercised, not simulated.
 */
async function t19LeaseRace() {
  const root = writeMemRoot(path.join(TMP, 't19-mem'), { 'STATE.md': '# s\n' });
  const worker = path.join(TMP, 'lease-race-worker.mjs');
  const toolsUrl = pathToFileURL(path.join(ROOT, 'src', 'tools.js')).href;
  fs.writeFileSync(worker, [
    `import { leaseAcquire } from ${JSON.stringify(toolsUrl)};`,
    'const [root, holder, startAt] = process.argv.slice(2);',
    'const at = Number(startAt);',
    'while (Date.now() < at) { /* spin so both children hit openSync(wx) together */ }',
    'const result = leaseAcquire({ holder }, { memRoot: root });',
    'process.stdout.write(JSON.stringify(result));',
    '',
  ].join('\n'), 'utf8');

  const startAt = String(Date.now() + 1500);
  const run = (holder) => new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, root, holder, startAt], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ holder, out, err: `${err}\nTIMEOUT`, code: null }); }, 20000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ holder, out, err, code }); });
  });

  const [a, b] = await Promise.all([run('racer-a'), run('racer-b')]);
  const parsed = [a, b].map((r) => {
    assert(r.code === 0, `worker ${r.holder} exited ${r.code}: ${r.err.slice(-400)}`);
    try {
      return { holder: r.holder, result: JSON.parse(r.out.slice(r.out.indexOf('{'))) };
    } catch {
      throw new Error(`worker ${r.holder} produced no JSON: ${r.out.slice(-200)}`);
    }
  });
  const winners = parsed.filter((p) => p.result.ok === true);
  const losers = parsed.filter((p) => p.result.ok !== true);
  assert(winners.length === 1, `expected exactly one winner, got ${winners.length}: ${JSON.stringify(parsed.map((p) => p.result.ok))}`);
  assert(losers.length === 1, `expected exactly one loser, got ${losers.length}`);
  assert(losers[0].result.reason === 'held by another writer', `loser reason ${losers[0].result.reason}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.lease'), 'utf8')).holder;
  assert(onDisk === winners[0].holder, `lease on disk (${onDisk}) is not the winner (${winners[0].holder})`);
  const released = leaseRelease({ holder: winners[0].holder }, { memRoot: root });
  assert(released.ok === true, 'winner could not release the lease');
  return `2 processes -> 1 winner (${winners[0].holder}), loser "${losers[0].result.reason}"`;
}

/**
 * T20/T21/T22: the same VM failure that made session_wake print "unavailable:
 * 记忆根目录不存在 <root> — ..." used to leak `ENOENT` out of lease_acquire and
 * print "no lease at <root>\.lease" out of lease_release. All three now have to
 * answer in one shape, never throw, and never create the missing root.
 */
function missingRoot(name) {
  const root = path.join(TMP, name);
  fs.rmSync(root, { recursive: true, force: true });
  return root;
}

function t20LeaseAcquireMissingRoot() {
  const root = missingRoot('t20-missing-root');
  let result;
  try {
    result = leaseAcquire({ holder: 'writer-a', ttlSec: 60 }, { memRoot: root });
  } catch (error) {
    throw new Error(`lease_acquire threw instead of reporting: ${error.code ?? error.message}`);
  }
  assert(result.ok === false, `ok must be false, got ${JSON.stringify(result)}`);
  assert(result.status === 'unavailable', `status ${result.status}`);
  assert(result.message.includes('记忆根目录不存在'), `message: ${result.message}`);
  assert(result.message.includes(root), `message must name the root: ${result.message}`);
  assert(result.message.includes('DSH_MEM'), `message must mention DSH_MEM: ${result.message}`);
  assert(result.message.startsWith('unavailable: '), `message must start with "unavailable: ": ${result.message}`);
  assert(!fs.existsSync(root), 'lease_acquire must not create a missing memory root');
  assert(!fs.existsSync(path.join(root, '.lease')), 'no lease file may appear under a missing root');
  return `no throw, ok:false, root untouched: ${result.message.slice(0, 46)}…`;
}

function t21LeaseReleaseMissingRoot() {
  const root = missingRoot('t21-missing-root');
  let result;
  try {
    result = leaseRelease({ holder: 'writer-a' }, { memRoot: root });
  } catch (error) {
    throw new Error(`lease_release threw instead of reporting: ${error.code ?? error.message}`);
  }
  assert(result.ok === false, `ok must be false, got ${JSON.stringify(result)}`);
  assert(result.status === 'unavailable', `status ${result.status}`);
  assert(result.message.includes('记忆根目录不存在'), `message: ${result.message}`);
  assert(!result.message.includes('no lease at'), `stale "no lease at" wording came back: ${result.message}`);
  assert(result.message.startsWith('unavailable: '), `message must start with "unavailable: ": ${result.message}`);
  assert(!fs.existsSync(root), 'lease_release must not create a missing memory root');
  return `no throw, ok:false: ${result.message.slice(0, 46)}…`;
}

function t22UnifiedUnavailableFormat() {
  const root = missingRoot('t22-missing-root');
  const reports = {
    session_wake: sessionWake({}, { memRoot: root }),
    lease_acquire: leaseAcquire({ holder: 'writer-a' }, { memRoot: root }),
    lease_release: leaseRelease({ holder: 'writer-a' }, { memRoot: root }),
  };
  const messages = {};
  for (const [tool, report] of Object.entries(reports)) {
    assert(typeof report.message === 'string' && report.message.length > 0, `${tool}: empty message`);
    assert(report.message.startsWith('unavailable: '), `${tool}: must start with "unavailable: ": ${report.message}`);
    assert(report.message.includes(' — '), `${tool}: must read "原因 — 怎么办": ${report.message}`);
    assert(report.message.includes(root), `${tool}: must name the root: ${report.message}`);
    assert(report.status === 'unavailable', `${tool}: status ${report.status}`);
    if (tool !== 'session_wake') assert(report.ok === false, `${tool}: ok ${report.ok}`);
    messages[tool] = report.message;
  }
  assert(new Set(Object.values(messages)).size === 1,
    `three tools disagree: ${JSON.stringify(messages, null, 0)}`);
  return `3 tools, one sentence: ${messages.session_wake.slice(0, 52)}…`;
}

// ---------------------------------------------------------------- workers

// The worker tools need a live `subagents` service and an exact live Agent to
// create or interrupt a child. A plain-node test cannot provide either, so these
// cases pin the degrade paths: every missing dependency must answer
// "unavailable: …" instead of throwing out of the turn.

async function t23WorkerSpawnUnavailable() {
  const noHost = await workerSpawn({ prompt: '把这段日志整理成摘要' }, {});
  assert(noHost.status === 'unavailable', `no host -> ${noHost.status}`);
  assert(noHost.message.startsWith('unavailable: '), `no host message: ${noHost.message}`);
  assert(noHost.message.includes('subagents'), `no host message must name the service: ${noHost.message}`);

  const emptyHost = await workerSpawn({ prompt: '把这段日志整理成摘要' }, { host: () => ({}) });
  assert(emptyHost.status === 'unavailable' && emptyHost.message.includes('subagents'),
    `empty host -> ${emptyHost.status}/${emptyHost.message}`);

  // A real Cordis context throws on an undeclared service read; the tool must
  // turn that inject-guard error into "unavailable", never rethrow it.
  const guarded = {
    get subagents() { throw new Error('cannot get property "subagents" without inject'); },
    get() { throw new Error('cannot get property "subagents" without inject'); },
  };
  const guardedResult = await workerSpawn({ prompt: '把这段日志整理成摘要' }, { host: () => guarded });
  assert(guardedResult.status === 'unavailable' && guardedResult.message.startsWith('unavailable: '),
    `inject guard -> ${guardedResult.status}/${guardedResult.message}`);

  const missingPrompt = await workerSpawn({}, {});
  assert(missingPrompt.status === 'unavailable' && missingPrompt.message.includes('prompt'),
    `missing prompt -> ${missingPrompt.message}`);

  return `4 degrade paths, no throw; wording "${noHost.message.slice(0, 22)}…"`;
}

async function t24WorkerStatusMissing() {
  const home = path.join(TMP, 't24-home');
  fs.rmSync(home, { recursive: true, force: true });
  const unknown = await workerStatus({ workerId: 'worker-not-here' }, { home });
  assert(unknown.status === 'unavailable', `unknown worker -> ${unknown.status}`);
  assert(unknown.message === 'unavailable: 找不到这个 worker', `unknown worker message: ${unknown.message}`);
  assert(unknown.ok === false, `unknown worker ok -> ${unknown.ok}`);

  const missingId = await workerStatus({}, { home });
  assert(missingId.status === 'unavailable' && missingId.message.includes('workerId'),
    `missing workerId -> ${missingId.message}`);

  // No host services at all: the persisted session log still answers
  // events / last message time / status.
  const workerId = 'worker-persisted-1';
  const scopeDir = path.join(home, 'sessions', 'local', workerId);
  fs.mkdirSync(scopeDir, { recursive: true });
  const header = {
    type: 'session', version: 4, id: workerId, createdAt: Date.now(),
    cwd: 'C:\\fixtures', isSeeded: false, delegationDepth: 1,
  };
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 0 } },
    { seq: 1, type: 'user/message', data: {} },
    { seq: 2, type: 'turn/end', data: { turn: 0 } },
  ];
  fs.writeFileSync(path.join(scopeDir, 'session.v4.jsonl.zstd'), encodeSession(header, events));

  const persisted = await workerStatus({ workerId }, { home });
  assert(persisted.status === 'persisted', `persisted worker -> ${persisted.status}`);
  assert(persisted.events === 3, `persisted events -> ${persisted.events}`);
  assert(typeof persisted.lastMessageAt === 'string' && !Number.isNaN(Date.parse(persisted.lastMessageAt)),
    `lastMessageAt -> ${persisted.lastMessageAt}`);
  assert(persisted.lastEventType === 'turn/end', `lastEventType -> ${persisted.lastEventType}`);
  assert(persisted.message.includes(workerId), `persisted message -> ${persisted.message}`);

  return `missing -> "${unknown.message}", persisted -> 3 events @ ${persisted.lastMessageAt}`;
}

async function t25WorkerKillUnavailable() {
  const home = path.join(TMP, 't25-home');
  fs.rmSync(home, { recursive: true, force: true });
  const noHost = await workerKill({ workerId: 'worker-not-here' }, { home });
  assert(noHost.status === 'unavailable', `no host -> ${noHost.status}`);
  assert(noHost.message.startsWith('unavailable: 终止失败'), `no host message: ${noHost.message}`);

  // Service present, but no live calling Agent to authorize the interrupt.
  const serviceOnly = { interrupt() { throw new Error('interrupt must not run without a live parent'); } };
  const noParent = await workerKill({ workerId: 'worker-not-here' }, { home, host: () => ({ subagents: serviceOnly }) });
  assert(noParent.status === 'unavailable' && noParent.message.includes('终止失败'),
    `no parent -> ${noParent.status}/${noParent.message}`);

  // Service + parent + Agent registry, but an unknown id: interrupt() treats
  // an absent target as a no-op, so a silent no-op must not read as success.
  const agents = { get: () => null };
  const subagents = { interrupt() { throw new Error('unreachable for an unknown worker'); } };
  const unknown = await workerKill({ workerId: 'worker-not-here' }, {
    home,
    host: () => ({ subagents, agents }),
    exec: { agent: { id: 'parent-session' } },
  });
  assert(unknown.status === 'unavailable', `unknown worker -> ${unknown.status}`);
  assert(unknown.message.includes('找不到这个 worker'), `unknown worker message: ${unknown.message}`);

  const missingId = await workerKill({}, { home });
  assert(missingId.status === 'unavailable' && missingId.message.includes('workerId'),
    `missing workerId -> ${missingId.message}`);

  return `4 unavailable paths; message "${unknown.message.slice(0, 30)}…"`;
}

async function t26WorkerToolRegistration() {
  assert(Array.isArray(inject) && inject.length === 1 && inject[0] === 'tools',
    `inject must stay ['tools'], got ${JSON.stringify(inject)}`);
  assert(TOOLS.length === 22, `9 existing + 3 worker + 6 memory + 4 live tools, got ${TOOLS.length}`);

  const names = TOOLS.map((tool) => tool.name);
  const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]));
  for (const name of ['worker_spawn', 'worker_status', 'worker_kill']) {
    assert(names.includes(name), `missing ${name}`);
    const tool = byName[name];
    assert(typeof tool.description === 'string' && tool.description.length > 20, `${name}: description`);
    assert(typeof tool.invoke === 'function', `${name}: invoke`);
    assert(tool.output?.schema?.type === 'object', `${name}: output schema`);
    assert(typeof tool.output?.render === 'function', `${name}: render`);
  }
  assert(byName.worker_spawn.parameters.prompt?.description?.includes('Required'),
    'worker_spawn prompt must be documented as required');
  assert(byName.worker_spawn.parameters.timeoutSec, 'worker_spawn needs timeoutSec');
  assert(byName.worker_status.parameters.workerId?.description?.includes('Required'),
    'worker_status workerId must be documented as required');
  assert(byName.worker_kill.parameters.workerId?.description?.includes('Required'),
    'worker_kill workerId must be documented as required');
  assert(byName.worker_kill.parameters.reason, 'worker_kill needs an optional reason');

  return `inject ${JSON.stringify(inject)}, ${TOOLS.length} tools, required fields documented`;
}

/**
 * T27 (0.7.4): the host-version probe must survive a real Cordis inject guard.
 *
 * 0.7.3 shipped `ctx?.version` in detectHostVersion(). A Cordis context is a
 * Proxy that throws `cannot get property "version" without inject` for any
 * property not declared in `inject`; the throw escaped apply() and the web host
 * reported `1 entry did not activate` with all 22 tools missing. The old suite
 * was green because every fake ctx was a plain object. This proxy throws
 * exactly like the host, so a regression fails here without a credential.
 */
function t27HostVersionProbeGuarded() {
  const guarded = new Proxy({
    get(name) { return name === 'absent' ? undefined : undefined; },
    root: {},
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });

  const unknown = detectHostVersion(guarded);
  assert(unknown.version === null && unknown.source === null,
    `guarded ctx must be unknown, got ${JSON.stringify(unknown)}`);

  const fromConfig = detectHostVersion(guarded, { hostVersion: '0.2.1-rc.5' });
  assert(fromConfig.source === 'config.hostVersion' && fromConfig.version === '0.2.1-rc.5',
    `config fallback after guarded reads -> ${JSON.stringify(fromConfig)}`);

  const fromEnv = detectHostVersion(guarded, {}, { DSH_HOST_VERSION: '0.3.0' });
  assert(fromEnv.source === 'env.DSH_HOST_VERSION' && fromEnv.version === '0.3.0',
    `env fallback after guarded reads -> ${JSON.stringify(fromEnv)}`);

  return 'ctx.version/app/root guarded -> unknown; config/env fallbacks intact';
}

/**
 * T7 is opt-in on purpose: this suite must never open a credential store.
 * Only an explicitly exported DSH_T7_API_KEY is accepted — no env alias, no
 * file scraping, no home-directory lookup.
 */
function readApiKey() {
  const key = process.env.DSH_T7_API_KEY;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

function t7RealResume() {
  // No drive-letter default: DSH_NODE wins, else the node running this suite.
  const nodeExe = process.env.DSH_NODE ?? process.execPath;
  const apiKey = readApiKey();
  if (!apiKey) return { skip: 'DSH_T7_API_KEY is not set — T7 is opt-in and the suite never reads a credential file' };
  if (!fs.existsSync(nodeExe)) return { skip: `node not found: ${nodeExe}` };

  const workDir = path.join(TMP, 't7');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const id = `session-t7-${Date.now().toString(36)}`;
  const built = buildFixture({ id, turns: 60, title: 'T7 真机恢复', jobs: true, inbox: true, checkpointAt: 57 });
  built.header.cwd = process.cwd();
  const source = path.join(workDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(source, encodeSession(built.header, built.events));
  const preTruncSha = sha256OfFile(source);

  const result = truncateSession(source, {
    keepEvents: 200, dryRun: false, confirm: CONFIRM_WORD, recentWriteWindowMs: 0,
  });

  // Deploy into an isolated DSH_HOME (never ~/.dsh) and resume it there.
  const parsed = parseSession(fs.readFileSync(source));
  // DSH derives the scope directory name from cwd: backslashes -> '-', colons
  // dropped, wrapped in '--'. Non-ASCII characters become ~<code point hex>
  // (听 -> ~542C), which an ASCII-only cwd never shows. Using a made-up name
  // makes resume report a "corrupt session log".
  const scope = `--${process.cwd().replace(/\\/g, '-').replace(/:/g, '')
    .replace(/[^\x20-\x7e]/g, (ch) => `~${ch.codePointAt(0).toString(16).toUpperCase()}`)}--`;
  const sessionDir = path.join(workDir, 'home', 'sessions', scope, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const deployed = path.join(sessionDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(deployed, encodeSession(parsed.header, parsed.events));

  const driver = path.join(HERE, 't7_drive.mjs');
  const env = {
    ...process.env,
    DEEPSEEK_API_KEY: apiKey,
    T7_DSH_HOME: path.join(workDir, 'home'),
    T7_SESSION_FILE: deployed,
    T7_CWD: process.cwd(),
    T7_WAIT_MS: '120000',
  };
  const command = `node test/t7_drive.mjs ${id} "只回两个字：收到"`;
  const started = Date.now();
  const child = spawnSync(nodeExe, [driver, id, '只回两个字：收到'], {
    env, encoding: 'utf8', timeout: 240000, maxBuffer: 32 * 1024 * 1024,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const stdout = (child.stdout ?? '').trim();
  const stderr = (child.stderr ?? '').trim();
  const tail = [stdout, stderr].filter(Boolean).join('\n---\n').slice(-2000);
  let report = null;
  try { report = JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { report = null; }

  assert(child.status === 0, `sdk resume failed (exit ${child.status}): ${tail.slice(-800)}`);
  assert(report, `driver produced no JSON: ${tail.slice(-800)}`);
  assert(report.ok, `no assistant reply: ${JSON.stringify(report).slice(-600)}`);
  const reply = (report.assistantTexts ?? []).join(' ');
  assert(/收到/.test(reply), `assistant reply is not 收到: ${JSON.stringify(reply)}`);
  assert(report.seqContiguous, 'event seq is not contiguous after resume');
  assert((report.lastTypes ?? []).includes('turn/end'), `turn did not finish: ${JSON.stringify(report.lastTypes)}`);
  noteHashes('T7', preTruncSha, report.sha256Before);

  return {
    ok: true,
    detail: `${result.beforeBytes}B/${result.beforeEvents} ev -> ${result.afterBytes}B/${result.afterEvents} ev; ` +
      `sdk resume+prompt exit 0 in ${elapsed}s; reply ${JSON.stringify(reply)}; ` +
      `log ${report.bytesBefore}B/${report.eventsBefore} ev -> ${report.bytesAfter}B/${report.eventsAfter} ev; seq contiguous`,
    command: `${command}   (DSH_HOME=${path.join(workDir, 'home')})`,
    output: tail.slice(-1200),
  };
}

// ------------------------------------------------------------ F1–F6 regressions

/** Write a hand-built log (needed when the field shape itself is under test). */
function encodeLog(file, id, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = {
    type: 'session', version: 4, id, createdAt: Date.now(),
    cwd: 'C:\\fixtures', isSeeded: false, delegationDepth: 0,
  };
  fs.writeFileSync(file, encodeSession(header, events));
  return file;
}

function f1BackupConfirmGate() {
  const home = path.join(TMP, 'f1-home');
  fs.rmSync(home, { recursive: true, force: true });
  const dir = path.join(home, 'sessions', '--scope-f1--', 'session-f1');
  const file = writeSessionAt(dir, 'session-f1', { turns: 6 });
  const before = dirSnapshot(dir);

  // No confirm, and a near-miss confirm, must both refuse without writing.
  const absent = sessionBackupPlan({ sessionPath: file, dryRun: false }, { home });
  assert(absent.ok === false && absent.status === 'unavailable', `absent confirm -> ${absent.ok}/${absent.status}`);
  assert(/confirm/.test(absent.message) && absent.message.includes('BACKUP'), `absent confirm message: ${absent.message}`);
  const typo = sessionBackupPlan({ sessionPath: file, dryRun: false, confirm: 'BAKCUP' }, { home });
  assert(typo.ok === false && typo.status === 'unavailable', `approximate confirm -> ${typo.ok}/${typo.status}`);
  const dry = sessionBackupPlan({ sessionPath: file, dryRun: true }, { home });
  assert(dry.status === 'planned', `dry run -> ${dry.status}/${dry.message}`);
  assert(diffSnapshots(before, dirSnapshot(dir)).length === 0,
    `refused backup wrote: ${diffSnapshots(before, dirSnapshot(dir)).join(', ')}`);

  // The exact word is accepted, case-insensitively, and really writes.
  const lower = sessionBackupPlan({ sessionPath: file, dryRun: false, confirm: 'backup' }, { home });
  assert(lower.status === 'created', `lowercase confirm -> ${lower.status}/${lower.message}`);
  assert(fs.existsSync(lower.targetFile) && sha256OfFile(lower.targetFile) === sha256OfFile(file),
    'confirmed backup missing or differs');
  const upper = sessionBackupPlan({ sessionPath: file, dryRun: false, confirm: 'BACKUP' }, { home });
  assert(upper.status === 'created' && upper.targetFile !== lower.targetFile,
    'second confirmed backup must be a new file');
  return `absent/typo refused (0 bytes written), dry planned ${path.basename(dry.targetFile)}, "backup"/"BACKUP" created 2 distinct files`;
}

function f2PathWhitelist() {
  const home = path.join(TMP, 'f2-home');
  fs.rmSync(home, { recursive: true, force: true });
  const scope = path.join(home, 'sessions', '--scope-f2--');
  const inside = writeSessionAt(scope, 'session-f2', { turns: 6 });
  // A perfectly valid log outside the sessions root must still be refused.
  const outside = writeSessionAt(path.join(TMP, 'f2-outside'), 'session-f2-out', { turns: 4 });
  const outsideDir = path.dirname(outside);
  const outsideSha = sha256OfFile(outside);

  const healthOutside = sessionHealth({ sessionPath: outside }, { home });
  assert(healthOutside.ok !== true && healthOutside.status === 'unavailable',
    `outside path accepted: ${healthOutside.status}/${healthOutside.message}`);
  assert(healthOutside.message.startsWith('unavailable: 路径不在 sessions 目录内')
    && healthOutside.message.includes(outside), `outside health message: ${healthOutside.message}`);

  const backupOutside = sessionBackupPlan({ sessionPath: outside, dryRun: false, confirm: 'BACKUP' }, { home });
  assert(backupOutside.ok === false && backupOutside.message.includes('路径不在 sessions 目录内'),
    `outside backup -> ${backupOutside.status}/${backupOutside.message}`);
  assert(fs.readdirSync(outsideDir).length === 1, `outside backup wrote: ${fs.readdirSync(outsideDir).join(', ')}`);

  const truncOutside = truncateTool({ sessionPath: outside, keepEvents: 1, dryRun: false, confirm: CONFIRM_WORD }, { home });
  assert(truncOutside.status === 'unavailable' && truncOutside.message.includes('路径不在 sessions 目录内'),
    `outside truncate -> ${truncOutside.status}/${truncOutside.message}`);
  assert(sha256OfFile(outside) === outsideSha, 'outside log was modified');

  const relative = sessionHealth({ sessionPath: 'rel\\session.v4.jsonl.zstd' }, { home });
  assert(relative.message.startsWith('unavailable: 需要绝对路径或 sessionId'),
    `relative path message: ${relative.message}`);

  const traversal = path.join(path.dirname(inside), '..', '..', '..', 'escape', 'session.v4.jsonl.zstd');
  const trav = sessionBackupPlan({ sessionPath: traversal, dryRun: true }, { home });
  assert(trav.ok === false && trav.message.includes('路径不在 sessions 目录内'),
    `traversal -> ${trav.status}/${trav.message}`);

  // Non-session file names are refused even inside the sessions root.
  const notes = path.join(path.dirname(inside), 'notes.txt');
  fs.writeFileSync(notes, 'not a session log');
  const notesPlan = sessionBackupPlan({ sessionPath: notes, dryRun: true }, { home });
  assert(notesPlan.ok === false && notesPlan.message.includes('不是 session 文件名'),
    `notes.txt -> ${notesPlan.status}/${notesPlan.message}`);
  const notesReal = sessionBackupPlan({ sessionPath: notes, dryRun: false, confirm: 'BACKUP' }, { home });
  assert(notesReal.status === 'unavailable', `notes.txt real -> ${notesReal.status}`);
  const leftover = fs.readdirSync(path.dirname(inside)).filter((n) => n.startsWith('notes.txt'));
  assert(leftover.length === 1, `notes.txt got a backup: ${leftover.join(', ')}`);

  const okHealth = sessionHealth({ sessionPath: inside }, { home });
  assert(okHealth.status === 'ok' && okHealth.events > 0, `legit path broke: ${okHealth.status}/${okHealth.message}`);
  return `outside/relative/traversal/filename all refused, outside log untouched; inside ok ${okHealth.events} events`;
}

function f3ZeroByteAndDirectoryTrap() {
  const home = path.join(TMP, 'f3-home');
  fs.rmSync(home, { recursive: true, force: true });
  const base = path.join(home, 'sessions', '--scope-f3--');
  const dir = path.join(base, 'session-f3');
  fs.mkdirSync(dir, { recursive: true });
  const empty = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(empty, Buffer.alloc(0));
  // The old `listBackups` counted this directory as a backup and later read it.
  const trap = path.join(dir, 'session.v4.jsonl.zstd.bak-20250101');
  fs.mkdirSync(trap, { recursive: true });

  const emptyPlan = sessionBackupPlan({ sessionPath: empty, dryRun: false, confirm: 'BACKUP' }, { home });
  assert(emptyPlan.ok === false && emptyPlan.status === 'unavailable', `empty source -> ${emptyPlan.status}`);
  assert(emptyPlan.message === 'unavailable: 源文件为空', `empty source message: ${emptyPlan.message}`);
  assert(fs.readdirSync(dir).length === 2, `empty source wrote: ${fs.readdirSync(dir).join(', ')}`);

  const health = sessionHealth({ sessionPath: empty }, { home });
  assert(health.backups === 0, `same-named directory counted as a backup: ${health.backups}`);
  assert(fs.statSync(trap).isDirectory(), 'health touched the directory');

  // A real source with that directory beside it must pick a fresh name.
  const source = writeSessionAt(base, 'session-f3', { turns: 6 });
  assert(source === empty, `fixture must overwrite the empty log: ${source}`);
  const plan = sessionBackupPlan({ sessionPath: source, dryRun: true }, { home });
  assert(plan.status === 'planned', `plan with directory trap -> ${plan.status}/${plan.message}`);
  assert(plan.targetFile !== trap, 'plan chose the directory name');
  const real = sessionBackupPlan({ sessionPath: source, dryRun: false, confirm: 'BACKUP' }, { home });
  assert(real.status === 'created', `real with directory trap -> ${real.status}/${real.message}`);
  assert(fs.statSync(real.targetFile).isFile(), 'backup target is not a file');
  assert(sha256OfFile(real.targetFile) === sha256OfFile(source), 'backup bytes differ');
  assert(fs.statSync(trap).isDirectory(), 'trap directory was disturbed');
  return `0-byte -> "${emptyPlan.message}" (no write), directory not counted, backup took ${path.basename(real.targetFile)}`;
}

function f4PlanMatchesRealRun() {
  const home = path.join(TMP, 'f4-home');
  fs.rmSync(home, { recursive: true, force: true });
  const base = path.join(home, 'sessions', '--scope-f4--');
  const file = writeSessionAt(base, 'session-f4', { turns: 8 });
  const dir = path.dirname(file);
  // An older backup of identical bytes used to be "reused" across days.
  const old = path.join(dir, 'session.v4.jsonl.zstd.bak-20250101');
  fs.writeFileSync(old, fs.readFileSync(file));
  const oldSha = sha256OfFile(old);

  const dry = sessionBackupPlan({ sessionPath: file, dryRun: true }, { home });
  assert(dry.status === 'planned', `dry run -> ${dry.status}/${dry.message}`);
  assert(dry.targetFile !== old, 'dry run proposed the old backup');
  assert(dry.targetExists === false, `dry-run target already exists: ${dry.targetFile}`);

  const real = sessionBackupPlan({ sessionPath: file, dryRun: false, confirm: 'BACKUP' }, { home });
  assert(real.status === 'created', `real run -> ${real.status}/${real.message}`);
  assert(real.targetFile === dry.targetFile, `plan ${dry.targetFile} != real ${real.targetFile}`);
  assert(real.status !== 'reused', 'real run reused an old backup');
  assert(sha256OfFile(old) === oldSha, 'old backup was modified');
  assert(sha256OfFile(real.targetFile) === sha256OfFile(file), 'backup bytes differ');

  const count = fs.readdirSync(dir).length;
  const dry2 = sessionBackupPlan({ sessionPath: file, dryRun: true }, { home });
  const real2 = sessionBackupPlan({ sessionPath: file, dryRun: false, confirm: 'BACKUP' }, { home });
  assert(real2.targetFile === dry2.targetFile, 'second plan/real mismatch');
  assert(real2.targetFile !== real.targetFile, 'second backup reused the first name');
  assert(fs.readdirSync(dir).length === count + 1, 'exactly one new file expected');
  assert(/\.bak-\d{8}(-\d+)?$/.test(path.basename(real2.targetFile)),
    `unexpected backup name: ${path.basename(real2.targetFile)}`);
  return `dry ${path.basename(dry.targetFile)} == real; old 20250101 untouched; second ${path.basename(real2.targetFile)}`;
}

async function f5KillRequiresLive() {
  const home = path.join(TMP, 'f5-home');
  fs.rmSync(home, { recursive: true, force: true });
  const id = 'definitely-not-a-worker';

  // Host without an `agents` registry: status cannot find it, so kill must not
  // claim a kill either (the old code called interrupt and returned ok:true).
  const noAgents = () => ({ subagents: { interrupt() { throw new Error('interrupt must not run'); } } });
  const statusNoAgents = await workerStatus({ workerId: id }, { home, host: noAgents });
  const killNoAgents = await workerKill({ workerId: id }, {
    home, host: noAgents, exec: { agent: { id: 'parent-session' } },
  });
  assert(statusNoAgents.status === 'unavailable', `status without agents -> ${statusNoAgents.status}`);
  assert(killNoAgents.ok === false && killNoAgents.status === 'unavailable',
    `kill without agents -> ${killNoAgents.ok}/${killNoAgents.status}`);
  assert(killNoAgents.status === statusNoAgents.status, 'kill and status disagree on the same id');

  // A persisted-but-stopped worker: status is ok but live:false, so no kill.
  writeSessionAt(path.join(home, 'sessions', 'local'), 'worker-stopped', { turns: 3 });
  const statusStopped = await workerStatus({ workerId: 'worker-stopped' }, { home });
  assert(statusStopped.ok === true && statusStopped.live === false, `stopped status -> ${JSON.stringify(statusStopped).slice(0, 80)}`);
  const killStopped = await workerKill({ workerId: 'worker-stopped' }, {
    home, host: noAgents, exec: { agent: { id: 'parent-session' } },
  });
  assert(killStopped.ok === false && killStopped.status === 'unavailable', `kill stopped -> ${killStopped.status}`);

  // A genuinely live worker: interrupt runs, and only then is `killed` reported.
  let interrupted = null;
  const liveAgent = { id, status: 'running' };
  const liveHost = () => ({
    agents: { get: (workerId) => (workerId === id ? liveAgent : null) },
    subagents: { interrupt(workerId) { interrupted = workerId; } },
  });
  const statusLive = await workerStatus({ workerId: id }, { home, host: liveHost });
  const killLive = await workerKill({ workerId: id, reason: 'unit test' }, {
    home, host: liveHost, exec: { agent: { id: 'parent-session' } },
  });
  assert(statusLive.live === true && statusLive.status === 'running', `live status -> ${JSON.stringify(statusLive).slice(0, 80)}`);
  assert(killLive.ok === true && killLive.status === 'killed', `live kill -> ${killLive.ok}/${killLive.status}`);
  assert(interrupted === id, `interrupt not called for a live worker: ${interrupted}`);
  return `unknown/stopped refused (status==${statusNoAgents.status}), live -> killed after interrupt`;
}

function f6ReclaimedNeedsDiskCount() {
  const home = path.join(TMP, 'f6-home');
  fs.rmSync(home, { recursive: true, force: true });

  // The real shape: the checkpoint's surfaceOp carries start/end (not
  // startSeq/endSeq) and the summary records no seq list at all.
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'system/message', data: { role: 'system', content: [] }, surfaceOp: 'append' },
    { seq: 2, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'old' }] }, surfaceOp: 'append' },
    { seq: 3, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] }, surfaceOp: 'append' },
    { seq: 4, type: 'compaction/start', data: { compactionId: 'c1', turn: 1 } },
    { seq: 5, type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: 'S' }], shadowedTokenCount: 777 } },
    {
      seq: 6, type: 'user/message',
      data: {
        role: 'user', content: [{ type: 'text', text: '（压缩摘要）' }],
        source: { kind: 'compact-checkpoint', compactionId: 'c1' },
      },
      surfaceOp: { op: 'replace', start: 1, end: 3 },
      sourceEventSeqs: [1, 2, 3],
    },
    { seq: 7, type: 'compaction/end', data: { compactionId: 'c1', turn: 1 } },
    { seq: 8, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'new' }] }, surfaceOp: 'append' },
    { seq: 9, type: 'turn/end', data: { turn: 1 } },
  ];
  const file = encodeLog(path.join(home, 'sessions', '--scope-f6--', 'session-f6', 'session.v4.jsonl.zstd'), 'session-f6', events);
  const health = sessionHealth({ sessionPath: file }, { home });
  assert(health.status === 'ok', `health -> ${health.status}: ${health.message}`);
  const c = health.compaction;
  assert(c.shadowedEvents === 3, `start/end span not measured: shadowedEvents ${c.shadowedEvents}`);
  assert(c.shadowedEventsStillStoredOnDisk === 3, `disk count ${c.shadowedEventsStillStoredOnDisk}`);
  assert(c.reclaimed === false, `reclaimed claim -> ${c.reclaimed}`);
  assert(!health.compactionMessage.includes('already gone from disk'), `false reclaim: ${health.compactionMessage}`);
  assert(health.compactionMessage.includes('still stored'), `verdict should say still stored: ${health.compactionMessage}`);

  // Without a disk read, reclaim status is unknown — never "true".
  const memoryOnly = analyzeCompaction(parseSession(fs.readFileSync(file)));
  assert(memoryOnly.reclaimed === 'unknown', `memory-only reclaimed -> ${memoryOnly.reclaimed}`);
  assert(describeCompaction(memoryOnly).includes('unknown'), `memory-only verdict: ${describeCompaction(memoryOnly)}`);

  // A log that cannot be re-read also reports unknown, not a guess.
  const unreadable = analyzeCompaction(parseSession(fs.readFileSync(file)), { filePath: path.join(path.dirname(file), 'nope.v4.jsonl.zstd') });
  assert(unreadable.reclaimed === 'unknown' && unreadable.diskVerified === false,
    `unreadable disk -> ${unreadable.reclaimed}/${unreadable.diskVerified}`);

  // Only when the disk count proves zero may it say reclaimed. The metadata
  // keeps the pre-truncation seq numbers (10–12), which no longer exist.
  const gone = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'system/message', data: { role: 'system', content: [] }, surfaceOp: 'append' },
    { seq: 2, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'old' }] }, surfaceOp: 'append' },
    { seq: 3, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] }, surfaceOp: 'append' },
    { seq: 4, type: 'compaction/start', data: { compactionId: 'c2', turn: 1 } },
    {
      seq: 5, type: 'compaction/summary',
      data: { compactionId: 'c2', shadowedSeqs: [10, 11, 12], shadowedTokenCount: 100, summary: [{ type: 'text', text: 'S' }] },
    },
    {
      seq: 6, type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '（压缩摘要）' }], source: { kind: 'compact-checkpoint', compactionId: 'c2' } },
      surfaceOp: { op: 'replace', start: 1, end: 3 },
      sourceEventSeqs: [1, 2, 3],
    },
    { seq: 7, type: 'compaction/end', data: { compactionId: 'c2', turn: 1 } },
    { seq: 8, type: 'turn/end', data: { turn: 1 } },
  ];
  const goneFile = encodeLog(path.join(home, 'sessions', '--scope-f6b--', 'session-f6b', 'session.v4.jsonl.zstd'), 'session-f6b', gone);
  const goneHealth = sessionHealth({ sessionPath: goneFile }, { home });
  assert(goneHealth.compaction.reclaimed === true, `proven-gone log -> ${goneHealth.compaction.reclaimed}`);
  assert(goneHealth.compactionMessage.includes('counted on disk'), `verdict must cite the count: ${goneHealth.compactionMessage}`);
  return `start/end measured 3 shadowed / 3 on disk / reclaimed=false; no disk -> unknown; counted-zero -> reclaimed`;
}

// ---------------------------------------------------------------- P1–P6 regressions

function p1NoCredentialRead() {
  // Assemble the needle at run time: the assertion text itself must not contain
  // the path it forbids, or the scan would find its own source line.
  const credentialNeedle = ['.credentials', 'yaml'].join('.');
  const keyPattern = 'sk-' + '[A-Za-z0-9]';

  // 1) Static: every shipped source file, not just the test harness. The old
  //    check grepped run.mjs/t7_drive.mjs and left src/ unscanned.
  const srcDir = path.join(ROOT, 'src');
  const srcFiles = fs.readdirSync(srcDir).filter((name) => name.endsWith('.js'))
    .map((name) => path.join(srcDir, name));
  const harnessFiles = ['run.mjs', 't7_drive.mjs', 'p1_probe.mjs'].map((name) => path.join(HERE, name));
  const scanned = [...srcFiles, ...harnessFiles];
  assert(srcFiles.length >= 5, `src scan only found ${srcFiles.length} files`);
  for (const file of scanned) {
    const text = fs.readFileSync(file, 'utf8');
    assert(!text.includes(credentialNeedle),
      `${path.relative(ROOT, file)} references the credential file`);
    assert(!text.includes(keyPattern),
      `${path.relative(ROOT, file)} scrapes an sk- key out of a file`);
  }

  // 2) Runtime: run the real tools under a witness that records every file the
  //    fs layer opens, inside a fake home that plants a decoy credential file.
  //    A source grep can miss a require-through-a-variable; the witness cannot.
  const home = path.join(TMP, 'p1-home');
  fs.rmSync(home, { recursive: true, force: true });
  const fakeDsh = path.join(home, '.dsh');
  fs.mkdirSync(fakeDsh, { recursive: true });
  const decoy = path.join(fakeDsh, credentialNeedle);
  fs.writeFileSync(decoy, ['decoy', 'value', 'not', 'a', 'key'].join(':') + '\n');
  fs.writeFileSync(path.join(home, 'canary.txt'), 'canary\n');
  const memRoot = path.join(home, 'memory');
  fs.mkdirSync(memRoot, { recursive: true });
  fs.writeFileSync(path.join(memRoot, 'STATE.md'), '# STATE\n\n## 我在哪\n在这里。\n');
  const scope = path.join(home, 'sessions', '--p1--', 'session-p1');
  fs.mkdirSync(scope, { recursive: true });
  const sessionFile = path.join(scope, 'session.v4.jsonl.zstd');
  fs.copyFileSync(writeFixture('p1-session', { id: 'fixture-p1', turns: 12 }), sessionFile);

  const child = spawnSync(process.execPath, [path.join(HERE, 'p1_probe.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: fakeDsh, P1_PROBE_HOME: home },
  });
  assert(child.status === 0, `witness probe failed (${child.status}): ${String(child.stderr).slice(-400)}`);
  const stdout = String(child.stdout ?? '');
  const marker = stdout.split('\n').filter((line) => line.includes('P1_WITNESS ')).pop();
  assert(marker, `witness probe printed no result: ${stdout.slice(-300)} ${String(child.stderr).slice(-300)}`);
  const witness = JSON.parse(marker.slice(marker.indexOf('P1_WITNESS ') + 'P1_WITNESS '.length));
  const reads = witness.reads.map((file) => path.resolve(file));

  // The witness must be provably live, or the credential result is vacuous.
  assert(reads.includes(path.resolve(path.join(home, 'canary.txt'))),
    'witness did not record the canary read — the fs patch is not in effect');
  assert(reads.includes(path.resolve(sessionFile)),
    `witness never saw the session log read (${reads.length} paths recorded)`);
  const credentialReads = reads.filter((file) => path.basename(file).includes(credentialNeedle));
  assert(credentialReads.length === 0,
    `tools opened the credential file at run time: ${credentialReads.join(', ')}`);
  assert(!reads.includes(path.resolve(decoy)), 'the decoy credential file was opened');
  // Module loading reads the plugin's OWN files, and when the plugin is
  // installed under the real ~/.dsh (the profile layout:
  // ~/.dsh/profiles/<name>/node_modules/<pkg>) those reads legitimately carry
  // that prefix. The invariant is about USER STATE under the real home, so the
  // package tree is excluded — and only the package tree — while every other
  // path under the real home must stay untouched.
  const realDsh = path.join(os.homedir(), '.dsh');
  const normCase = (file) => {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const under = (file, base) => {
    const target = normCase(file);
    const root = normCase(base);
    return target === root || target.startsWith(root + path.sep);
  };
  const pluginInsideRealDsh = under(ROOT, realDsh) && normCase(ROOT) !== normCase(realDsh);
  const selfReads = pluginInsideRealDsh ? reads.filter((file) => under(file, ROOT)) : [];
  const realHits = reads.filter(
    (file) => under(file, realDsh) && !(pluginInsideRealDsh && under(file, ROOT)),
  );
  assert(realHits.length === 0, `tools touched the real ~/.dsh: ${realHits.join(', ')}`);
  const calls = witness.calls.filter((call) => call.ok).map((call) => call.name);
  assert(calls.length >= 5, `witness only exercised ${calls.length} tools: ${JSON.stringify(witness.calls)}`);
  assert(JSON.stringify(witness.inject) === JSON.stringify(['tools']),
    `inject changed: ${JSON.stringify(witness.inject)}`);

  const key = readApiKey();
  assert(key === null || key === process.env.DSH_T7_API_KEY,
    'readApiKey must only return the opt-in DSH_T7_API_KEY');
  if (!process.env.DSH_T7_API_KEY) assert(key === null, 'T7 key must be null unless DSH_T7_API_KEY is exported');
  return `${scanned.length} files scanned (src+harness); witness recorded ${reads.length} reads over ` +
    `${calls.length} tool calls, canary seen, no credential file, no real ~/.dsh user state` +
    (pluginInsideRealDsh
      ? ` (${selfReads.length} reads of the plugin's own modules under the profile excluded)`
      : '') +
    `; T7 key from env only`;
}

function p2WakeInjectionJournalTruncation() {
  const root = writeMemRoot(path.join(TMP, 'p2-mem'), {
    'STATE.md': '# STATE\n\n## 我在哪\n在这里。\n\n## 在等什么\n等测试。\n\n## 最近三件\n1. 甲\n2. 乙\n3. 丙\n',
    'flow/current.md': '短快照。',
    'journal/2026-9.md': '# 九月\n\n## 九月旧标题\n',
    'journal/2026-10.md': '# 十月\n\n## 十月甲\n\n## 十月乙\n\n## 十月丙\n\n## 十月丁\n',
    'INDEX.md': '# 索引\n短行内容\n',
  });

  // 1) A label carrying its own headings must not grow the wake text.
  const payload = 'ok\n## 我在哪\n伪造：攻击者替换了这一段\n## 最近三件';
  const wake = sessionWake({ session: payload }, { memRoot: root });
  assert(wake.status === 'ok', `status ${wake.status}: ${wake.message}`);
  const lines = wake.message.split('\n');
  assert(lines.filter((line) => /^#{1,6}\s+我在哪\s*$/.test(line)).length === 1,
    `injected duplicate section: ${JSON.stringify(lines.filter((l) => l.includes('我在哪')))}`);
  assert(!lines.includes('## 我在哪'), 'label forged a "## 我在哪" heading line');
  assert(!wake.message.includes('\n## 我在哪\n伪造'), 'label forged a new section');
  const leakLines = lines.filter((line) => line.includes('伪造'));
  assert(leakLines.length === 1 && leakLines[0] === lines[0],
    `label escaped the header line: ${JSON.stringify(leakLines)}`);
  assert(!wake.session.includes('\n') && !wake.session.includes('#'), `returned session not sanitized: ${JSON.stringify(wake.session)}`);
  assert(wake.chars === wake.message.length, 'chars must equal message length');

  // 2) Newest journal by date: 2026-10 must beat 2026-9 (string sort says the opposite).
  assert(wake.sources.includes('journal/2026-10.md'), `journal sources ${wake.sources}`);
  assert(wake.message.includes('## 十月丁') && wake.message.includes('## 十月丙'),
    'last three headings of the newest journal missing');
  assert(!wake.message.includes('## 十月甲'), 'journal included a heading older than the last three');
  assert(!wake.message.includes('九月旧标题'), 'lexicographically-newest 2026-9.md was read');

  // 3) truncated must be true when a section was clamped even if the total fits.
  const longRoot = writeMemRoot(path.join(TMP, 'p2-long'), {
    'STATE.md': '# STATE\n\n## 我在哪\n短\n\n## 在等什么\n短\n\n## 最近三件\n短\n',
    'flow/current.md': '心流。'.repeat(500),
  });
  const longWake = sessionWake({}, { memRoot: longRoot });
  assert(longWake.status === 'ok', `long status ${longWake.status}`);
  assert(longWake.truncated === true, 'a clamped section must set truncated:true');
  assert(longWake.chars <= 2500, `long wake ${longWake.chars} chars`);
  assert(wake.truncated === false, 'a small wake must not claim truncation');
  return `label sanitized (1 header line), journal 2026-10 chosen, truncated=true only when cut (${longWake.chars} chars)`;
}

function p3TruncateShapeAndParity() {
  const home = path.join(TMP, 'p3-home');
  fs.rmSync(home, { recursive: true, force: true });
  const base = path.join(home, 'sessions', '--scope-p3--');
  const cfg = { home, recentWriteWindowMs: 0 };
  const file = writeSessionAt(base, 'p3-main', { turns: 8, title: '三号' });
  const beforeSha = sha256OfFile(file);

  // 1) Every confirm near-miss is a value with a code, never a rejected promise.
  for (const confirm of ['', 'truncate', 'TRUNCATE ', undefined]) {
    const out = truncateTool({ sessionPath: file, keepEvents: 60, dryRun: false, confirm }, cfg);
    assert(typeof out?.then !== 'function', 'the confirm gate returned a promise');
    assert(out?.ok === false && out.code === 'CONFIRM_REQUIRED',
      `confirm=${JSON.stringify(confirm)} -> ${out?.ok}/${out?.code}`);
    assert(out.message.includes('TRUNCATE'), `confirm message must name the word: ${out.message}`);
  }
  assert(sha256OfFile(file) === beforeSha, 'a refused confirm must not write');

  // 2) A bad keepEvents is the same shape — the tool may not throw.
  for (const keepEvents of [0, -1, 1.5, '60', NaN, []]) {
    const out = truncateTool({ sessionPath: file, keepEvents, dryRun: true }, cfg);
    assert(out?.ok === false && out.code === 'BAD_ARGUMENT',
      `keepEvents=${JSON.stringify(keepEvents)} -> ${out?.ok}/${out?.code}`);
    assert(out.message.includes('keepEvents'), `keepEvents message: ${out.message}`);
  }

  // 3) Dry run and real run agree on the cut and both report ok/status.
  const dry = truncateTool({ sessionPath: file, keepEvents: 45, dryRun: true }, cfg);
  assert(dry.ok === true && dry.status === 'planned' && dry.needed === true,
    `dry -> ${dry.ok}/${dry.status}/${dry.needed}: ${dry.message}`);
  const real = truncateTool({ sessionPath: file, keepEvents: 45, dryRun: false, confirm: CONFIRM_WORD }, cfg);
  assert(real.ok === true && real.status === 'truncated' && real.needed === true,
    `real -> ${real.ok}/${real.status}: ${real.message}`);
  assert(real.cutSeq === dry.cutSeq && real.droppedEvents === dry.droppedEvents,
    `dry cut ${dry.cutSeq}/${dry.droppedEvents} != real ${real.cutSeq}/${real.droppedEvents}`);
  assert(sha256OfFile(file) !== beforeSha, 'the real run must write the truncated log');
  assert(typeof real.backupFile === 'string' && fs.existsSync(real.backupFile), 'the real run must leave a backup');

  // 4) A boundary a real run cannot cross is refused identically by a dry run.
  const blocked = path.join(base, 'p3-blocked', 'session.v4.jsonl.zstd');
  encodeLog(blocked, 'p3-blocked', [
    { type: 'turn/start', data: { turn: 1 }, seq: 0 },
    { type: 'step/start', data: { turn: 1, step: 1 }, seq: 1 },
    { type: 'user/message', surfaceOp: 'append', data: { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: 'hi' }] }, seq: 2 },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }, seq: 3 },
    { type: 'step/end', data: { turn: 1, step: 1 }, seq: 4 },
    { type: 'turn/end', data: { turn: 1 }, seq: 5 },
  ]);
  const blockedSha = sha256OfFile(blocked);
  const blockedDry = truncateTool({ sessionPath: blocked, keepEvents: 4, dryRun: true }, cfg);
  const blockedReal = truncateTool({ sessionPath: blocked, keepEvents: 4, dryRun: false, confirm: CONFIRM_WORD }, cfg);
  assert(blockedDry.ok === false && blockedDry.code === 'NO_TURN_BOUNDARY',
    `dry boundary -> ${blockedDry.ok}/${blockedDry.code}: ${blockedDry.message}`);
  assert(blockedReal.ok === false && blockedReal.code === 'NO_TURN_BOUNDARY',
    `real boundary -> ${blockedReal.ok}/${blockedReal.code}: ${blockedReal.message}`);
  assert(blockedDry.message === blockedReal.message, 'dry and real must give the same refusal');
  assert(sha256OfFile(blocked) === blockedSha, 'a refused truncation must not write');

  // 5) The zero-net cut (only the protected head would move) is a no-op for both.
  const zero = path.join(base, 'p3-zero', 'session.v4.jsonl.zstd');
  encodeLog(zero, 'p3-zero', [
    { type: 'turn/start', data: { turn: 1 }, seq: 0 },
    { type: 'step/start', data: { turn: 1, step: 1 }, seq: 1 },
    { type: 'user/message', surfaceOp: 'append', data: { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: 'q1' }] }, seq: 2 },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } }, seq: 3 },
    { type: 'step/end', data: { turn: 1, step: 1 }, seq: 4 },
    { type: 'turn/end', data: { turn: 1 }, seq: 5 },
    { type: 'turn/start', data: { turn: 2 }, seq: 6 },
    { type: 'user/message', surfaceOp: 'append', data: { turn: 2, step: 1, role: 'user', content: [{ type: 'text', text: 'q2' }] }, seq: 7 },
    { type: 'turn/end', data: { turn: 2 }, seq: 8 },
  ]);
  const zeroSha = sha256OfFile(zero);
  const zeroDry = truncateTool({ sessionPath: zero, keepEvents: 7, dryRun: true }, cfg);
  const zeroReal = truncateTool({ sessionPath: zero, keepEvents: 7, dryRun: false, confirm: CONFIRM_WORD }, cfg);
  assert(zeroDry.ok === true && zeroDry.needed === false && zeroDry.status === 'noop',
    `zero dry -> ${zeroDry.ok}/${zeroDry.needed}/${zeroDry.status}: ${zeroDry.message}`);
  assert(zeroReal.ok === true && zeroReal.needed === false,
    `zero real -> ${zeroReal.ok}/${zeroReal.needed}/${zeroReal.status}: ${zeroReal.message}`);
  assert(sha256OfFile(zero) === zeroSha, 'a zero-net cut must not rewrite the log');

  return `confirm/keepEvents -> value objects; dry cut seq ${dry.cutSeq} == real ${real.cutSeq} ` +
    `(dropped ${real.droppedEvents}); boundary ${blockedDry.code} both; zero-net noop both`;
}

async function p4CompactSnapshotAndErrors() {
  const ticks = () => new Promise((resolve) => setTimeout(resolve, 20));
  const okCompaction = () => ({
    compactNow: async () => ({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 999, summarySeq: 42 }),
  });

  // 1) A scheduled result is a snapshot: releasing the queue must not mutate it.
  let release;
  const idleGate = new Promise((resolve) => { release = resolve; });
  const scheduled = await compactTool({ dryRun: false }, {
    host: () => ({ compaction: okCompaction(), agent: { status: 'running', whenIdle: () => idleGate } }),
  });
  assert(scheduled.ok === true && scheduled.status === 'scheduled',
    `scheduled -> ${scheduled.ok}/${scheduled.status}: ${scheduled.message}`);
  const frozen = JSON.stringify(scheduled);
  release();
  await ticks();
  assert(scheduled.status === 'scheduled' && scheduled.result === undefined,
    'the returned snapshot was mutated in place once the queued run finished');
  assert(JSON.stringify(scheduled) === frozen, 'the returned snapshot changed after the queued run');

  // 2) An idle failure is a value with a code, never a rejection.
  const boom = Object.assign(new Error('compaction exploded'), { code: 'COMPACTION_BOOM' });
  let idleOut;
  try {
    idleOut = await compactTool({ dryRun: false }, {
      host: () => ({ compaction: { compactNow: async () => { throw boom; } }, agent: { status: 'idle' } }),
    });
  } catch (error) {
    assert(false, `the idle failure rejected instead of returning: ${error.message}`);
  }
  assert(idleOut.ok === false && idleOut.status === 'failed' && idleOut.code === 'COMPACTION_BOOM',
    `idle failure -> ${idleOut.ok}/${idleOut.status}/${idleOut.code}`);
  assert(idleOut.message.includes('compaction exploded'), `idle message: ${idleOut.message}`);

  // 3) A queued failure is caught and logged; the earlier snapshot stays valid.
  const logged = [];
  const realError = console.error;
  console.error = (...parts) => logged.push(parts.join(' '));
  try {
    const queued = await compactTool({ dryRun: false }, {
      host: () => ({
        compaction: { compactNow: async () => { throw Object.assign(new Error('late fail'), { code: 'COMPACTION_LATE' }); } },
        agent: { status: 'running', whenIdle: () => Promise.resolve() },
      }),
    });
    await ticks();
    assert(queued.ok === true && queued.status === 'scheduled', `queued snapshot -> ${queued.ok}/${queued.status}`);
    assert(queued.code === undefined && queued.result === undefined, 'queued snapshot must not carry a result');
    assert(logged.some((line) => line.includes('compaction failed') && line.includes('late fail')),
      `queued failure not logged: ${JSON.stringify(logged)}`);
  } finally {
    console.error = realError;
  }

  // 4) Unavailable is shaped the same way.
  const missing = await compactTool({ dryRun: true }, {});
  assert(missing.ok === false && missing.status === 'unavailable' && missing.code === 'COMPACTION_UNAVAILABLE',
    `unavailable -> ${missing.ok}/${missing.status}/${missing.code}`);

  return 'scheduled snapshot frozen (no in-place mutation); idle/queued failures shaped + logged; unavailable shaped';
}

async function p5SubSecondArguments() {
  const root = writeMemRoot(path.join(TMP, 'p5-mem'), { 'STATE.md': '# s\n' });
  const leasePath = path.join(root, '.lease');

  // 1) A lease TTL is whole seconds: 0.4 must not round down into an already
  //    expired lease the next request can take over.
  for (const ttlSec of [0, 0.4, -1, 1.5, '60', NaN]) {
    const out = leaseAcquire({ holder: 'writer-a', ttlSec }, { memRoot: root });
    assert(out.ok === false && out.code === 'BAD_ARGUMENT',
      `ttlSec=${JSON.stringify(ttlSec)} -> ${out.ok}/${out.code}`);
    assert(out.message === 'ttlSec 必须是 1..86400 之间的整数（秒）', `ttlSec message: ${out.message}`);
    assert(!fs.existsSync(leasePath), `ttlSec=${JSON.stringify(ttlSec)} still created a lease`);
  }
  const okTtl = leaseAcquire({ holder: 'writer-a', ttlSec: 90 }, { memRoot: root });
  assert(okTtl.ok === true && okTtl.ttlSec === 90, `ttl 90 -> ${okTtl.ok}/${okTtl.ttlSec}`);
  assert(JSON.parse(fs.readFileSync(leasePath, 'utf8')).ttlSec === 90, 'ttl 90 not persisted');
  const span = Date.parse(okTtl.expiresAt) - Date.parse(okTtl.acquiredAt);
  assert(Number.isFinite(span) && Math.abs(span - 90_000) <= 2_000,
    `expiresAt is not acquiredAt + 90s: ${span}`);
  leaseRelease({ holder: 'writer-a' }, { memRoot: root });

  // 2) worker_spawn: validate the timeout before touching the host at all.
  for (const timeoutSec of [0, 0.4, -5, 1.5, '60']) {
    const out = await workerSpawn({ prompt: '任务', timeoutSec }, {});
    assert(out.ok === false && out.code === 'BAD_ARGUMENT',
      `timeoutSec=${JSON.stringify(timeoutSec)} -> ${out.ok}/${out.code}`);
    assert(out.message === 'timeoutSec 必须是 >= 1 的整数（秒）', `timeoutSec message: ${out.message}`);
  }
  const noService = await workerSpawn({ prompt: '任务', timeoutSec: 60 }, {});
  assert(noService.status === 'unavailable',
    `a valid timeoutSec must reach the host check, got ${noService.status}/${noService.code}`);

  // 3) keepEvents follows the same contract (shape covered by P3).
  const home = path.join(TMP, 'p5-home');
  const file = writeSessionAt(path.join(home, 'sessions', '--scope-p5--'), 'p5-main', { turns: 6 });
  const badKeep = truncateTool({ sessionPath: file, keepEvents: 0.4, dryRun: true }, { home });
  assert(badKeep.ok === false && badKeep.code === 'BAD_ARGUMENT',
    `keepEvents 0.4 -> ${badKeep.ok}/${badKeep.code}`);

  return 'ttlSec/timeoutSec/keepEvents: sub-second, zero, negative, string -> BAD_ARGUMENT before any write; ttl 90 persisted; valid timeoutSec reaches unavailable';
}

function b1PackageIdentity() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  // The version exists exactly once (package.json) and every consumer reads it
  // through src/version.js. The literal-free checks below are what stop the old
  // drift where the manifest was bumped but the packer still pinned the old
  // version in its own constant.
  assert(pkg.version === VERSION, `source-tree version must be ${VERSION}, got ${JSON.stringify(pkg.version)}`);
  const packSource = fs.readFileSync(path.join(ROOT, 'scripts', 'pack.mjs'), 'utf8');
  assert(!/EXPECTED_VERSION\s*=\s*['"]/.test(packSource),
    'scripts/pack.mjs still pins its own version literal');
  assert(packSource.includes("from '../src/version.js'"),
    'scripts/pack.mjs does not read the shared version module');
  const suiteSource = fs.readFileSync(path.join(ROOT, 'test', 'run.mjs'), 'utf8');
  assert(suiteSource.includes("from '../src/version.js'"),
    'test/run.mjs does not read the shared version module');
  for (const required of [
    'test/run.mjs',
    'test/p1_probe.mjs',
    'test/live.test.mjs',
    'test/memory.test.mjs',
    'test/tools_contract.test.mjs',
    'test/autobind.test.mjs',
    'test/truncate-visible.test.mjs',
    'test/auto-truncate.test.mjs',
    'test/cli-guard.test.mjs',
    'test/orchestrator.test.mjs',
    'test/seeded-load.test.mjs',
    'test/t7_drive.mjs',
    'test/portability.test.mjs',
    'test/deps.test.mjs',
    'scripts/pack.mjs',
    'scripts/longlive-doctor.mjs',
    'scripts/truncate-cli.mjs',
    'scripts/auto-truncate-run.ps1',
    'QUICKSTART.md',
    'docs/ERRORS.md',
  ]) {
    assert(files.includes(required), `package.json files whitelist misses ${required}`);
  }
  // Every suite module that test/run.mjs imports must ship: an installed copy
  // has to be able to run the whole suite, and rc.8 found one test module that
  // was imported but silently missing from the whitelist.
  for (const name of fs.readdirSync(path.join(ROOT, 'test')).filter((n) => n.endsWith('.mjs'))) {
    assert(files.includes(`test/${name}`), `package.json files whitelist misses test/${name}`);
  }
  for (const exclusion of ['!README.md.bak-*', '!runbook.md.bak-*', '!**/*.bak-*']) {
    assert(files.includes(exclusion), `package.json files whitelist misses explicit exclusion ${exclusion}`);
  }

  // npm packs README* unconditionally; the backup must be excluded by an
  // explicit `!` pattern rather than by pretending it is not there.
  const readmeVariants = fs.readdirSync(ROOT).filter(
    (name) => /^readme/i.test(name) && !['README.md', 'README.en.md'].includes(name),
  );
  assert(
    readmeVariants.length === 0,
    `npm would pack a README variant: ${readmeVariants.join(', ')}`,
  );
  // Where the backups sit in this checkout is deliberately NOT asserted: a
  // packed tree ships without them (that is the whole point of the `!`
  // exclusions), so an installed copy must be able to run this suite. The
  // exclusion itself is proved below against a fixture we construct, which
  // also keeps the check honest if the checkout happens to have no backups.
  assert(!files.some((entry) => entry.includes('bak-privacy')), 'the privacy backup must not be whitelisted');

  const driver = fs.readFileSync(path.join(ROOT, 'test', 't7_drive.mjs'), 'utf8');
  assert(!/['"][A-Za-z]:[\\/]/.test(driver), 'test/t7_drive.mjs still hard-codes a drive-letter path');
  assert(driver.includes('process.env.DSH_EXE') && driver.includes('process.env.DSH_CLI_JS'), 't7 reads its paths from env');

  // The only honest check is to pack a tree and open the result. Build that
  // tree here instead of copying the checkout: an installed package contains
  // no `.bak-*` files at all, and each backup is planted explicitly so the
  // `!` rules have real work to do every time this case runs.
  const fixture = path.join(TMP, 'b1-fixture');
  fs.rmSync(fixture, { recursive: true, force: true });

  const payload = {
    'src/index.js': 'export const id = "b1-fixture";\n',
    'src/memory/ledger.js': 'export const ledger = "b1-fixture";\n',
    // pack.mjs imports the shared version module, so the fixture must ship the
    // real one (a stub would not read the fixture package.json).
    'src/version.js': fs.readFileSync(path.join(ROOT, 'src', 'version.js')),
    'cordis.patch.yml': 'patch: b1-fixture\n',
    'locale/zh.json': '{"hello":"b1 fixture"}\n',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    'README.md': '# b1 fixture\n',
    'README.en.md': '# b1 fixture (en)\n',
    'SPEC.md': '# b1 fixture spec\n',
    'runbook.md': '# b1 fixture runbook\n',
    'test/run.mjs': '// b1 fixture stub, not the real suite\n',
    'test/memory.test.mjs': '// b1 fixture stub\n',
    'test/live.test.mjs': '// b1 fixture stub\n',
    'test/tools_contract.test.mjs': '// b1 fixture stub\n',
    'test/autobind.test.mjs': '// b1 fixture stub\n',
    'test/truncate-visible.test.mjs': '// b1 fixture stub\n',
    'test/auto-truncate.test.mjs': '// b1 fixture stub\n',
    'test/cli-guard.test.mjs': '// b1 fixture stub\n',
    'test/orchestrator.test.mjs': '// b1 fixture stub\n',
    'test/p1_probe.mjs': '// b1 fixture probe\n',
    'test/deps.test.mjs': '// b1 fixture stub\n',
    'test/t7_drive.mjs': '// b1 fixture stub\n',
    'scripts/pack.mjs': fs.readFileSync(path.join(ROOT, 'scripts', 'pack.mjs')),
    'scripts/longlive-doctor.mjs': '// b1 fixture stub\n',
    'scripts/truncate-cli.mjs': '// b1 fixture stub\n',
    'scripts/auto-truncate-run.ps1': '# b1 fixture orchestrator stub\n',
  };
  // npm force-includes root README*; `src/*.js` matches the legacy backup.
  // Both must still be removed by the `!` patterns.
  const backups = {
    'README.md.bak-x': 'must not ship\n',
    'runbook.md.bak-y': 'must not ship\n',
    'docs/README.md.bak-x2': 'must not ship\n',
    'src/legacy.bak-20260101.js': 'must not ship\n',
  };
  const decoys = {
    'docs/notes.md': 'not whitelisted\n',
    'private.txt': 'not whitelisted\n',
  };
  for (const [rel, body] of Object.entries({ ...payload, ...backups, ...decoys })) {
    const abs = path.join(fixture, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const fixturePkgPath = path.join(fixture, 'package.json');
  const fixturePkgText = `${JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    type: 'module',
    files,
  }, null, 2)}\n`;
  fs.writeFileSync(fixturePkgPath, fixturePkgText);

  const runFixtureNode = (root, args) => spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'pack.mjs'), ...args],
    { cwd: root, encoding: 'utf8' },
  );
  const archive = path.join(fixture, 'dist', 'fixture.tgz');
  const packed = runFixtureNode(fixture, ['--out', archive, '--json']);
  assert(
    packed.status === 0,
    `fixture pack failed (exit ${packed.status}): ${(packed.stderr || packed.stdout || '').trim().slice(-500)}`,
  );
  const manifest = JSON.parse(packed.stdout.trim());
  assert(manifest.ok === true && manifest.version === VERSION, `pack manifest: ${JSON.stringify(manifest)}`);
  assert(manifest.p1Probe === true, 'pack must report test/p1_probe.mjs in the payload');
  assert(/^[0-9a-f]{64}$/.test(manifest.sha256), `archive sha256 looks wrong: ${manifest.sha256}`);
  assert(fs.existsSync(archive), 'pack did not write the tarball');
  assert(fs.existsSync(`${archive}.sha256`), 'pack did not write the .sha256 sidecar');
  assert(
    fs.readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0] === manifest.sha256,
    'sidecar digest differs from the archive digest',
  );
  // Each planted backup existed in the fixture (enumerated) and none shipped.
  for (const leaked of Object.keys(backups)) {
    assert(
      manifest.excludedBackups.includes(leaked),
      `pack must enumerate the excluded backup ${leaked}`,
    );
  }
  assert(manifest.backupFiles.length === 0, `backup files leaked into the archive: ${manifest.backupFiles.join(', ')}`);
  // Exact payload count: whitelisted fixture files + package.json. Backups and
  // decoys must not add to it, so a broken negative rule changes the count.
  const expectedPayload = Object.keys(payload).length + 1;
  assert(
    manifest.fileCount === expectedPayload,
    `fixture should ship exactly ${expectedPayload} files, got ${manifest.fileCount}`,
  );

  const verified = runFixtureNode(fixture, ['--verify', archive, '--json']);
  assert(
    verified.status === 0,
    `verify failed (exit ${verified.status}): ${(verified.stderr || verified.stdout || '').trim().slice(-500)}`,
  );
  const check = JSON.parse(verified.stdout.trim());
  assert(check.ok === true && check.version === VERSION, `verify result: ${JSON.stringify(check)}`);
  assert(check.p1Probe === true, 'verify must find test/p1_probe.mjs');
  assert(check.backupFiles.length === 0, 'verify found a backup file in the archive');
  assert(check.sha256 === manifest.sha256, 'verify digest differs from the pack digest');
  assert(check.sourceTreeSha256 === manifest.sourceTreeSha256, 'sourceTreeSha256 differs between pack and verify');
  assert(check.sidecarOk === true, 'verify did not confirm the .sha256 sidecar');
  assert(check.fileCount === expectedPayload, `verify shipped ${check.fileCount} files, expected ${expectedPayload}`);

  // Negative control: drop every `!` exclusion from a copy of the same
  // fixture. The packer must refuse the leak rather than ship the README
  // backup, which proves this fixture really exercises the rule.
  const leaky = path.join(TMP, 'b1-fixture-leaky');
  fs.rmSync(leaky, { recursive: true, force: true });
  fs.cpSync(fixture, leaky, {
    recursive: true,
    filter: (src) => path.basename(src) !== 'dist',
  });
  const leakyPkg = JSON.parse(fixturePkgText);
  leakyPkg.files = leakyPkg.files.filter((entry) => !entry.startsWith('!'));
  leakyPkg.files.push('!never-matches-any-file');
  fs.writeFileSync(path.join(leaky, 'package.json'), `${JSON.stringify(leakyPkg, null, 2)}\n`);
  const leakyOut = path.join(leaky, 'dist', 'leaky.tgz');
  const leaked = runFixtureNode(leaky, ['--out', leakyOut, '--json']);
  assert(leaked.status !== 0, 'pack must refuse a whitelist without backup exclusions');
  assert(/backup file leaked/i.test(leaked.stderr ?? ''), `leak refusal must name the backup: ${leaked.stderr}`);
  assert(!fs.existsSync(leakyOut), 'a refused pack must not write an archive');

  // A malformed version must be refused, not silently packed as "undefined".
  const wrong = path.join(fixture, 'dist', 'wrong-version.tgz');
  const tampered = JSON.parse(fixturePkgText);
  tampered.version = '0.4';
  fs.writeFileSync(fixturePkgPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const refused = runFixtureNode(fixture, ['--out', wrong, '--json']);
  assert(refused.status !== 0, 'pack must refuse a version that is not MAJOR.MINOR.PATCH');
  assert(/invalid version/i.test(String(refused.stderr)), `malformed-version refusal must say so: ${refused.stderr}`);
  assert(!fs.existsSync(wrong), 'refused pack must not write an archive');
  fs.writeFileSync(fixturePkgPath, fixturePkgText);

  // A release pin that disagrees with package.json must be refused too: that
  // is the only place a version can still enter the packer from outside, and
  // silently ignoring it would let a stale release script ship the wrong tag.
  const pinnedOut = path.join(fixture, 'dist', 'pinned-version.tgz');
  const pinned = runFixtureNode(fixture, ['--out', pinnedOut, '--expect-version', '0.4.9', '--json']);
  assert(pinned.status !== 0, 'pack must refuse a version that differs from --expect-version');
  assert(String(pinned.stderr).includes('0.4.9'), `pin refusal must name the pin: ${pinned.stderr}`);
  assert(String(pinned.stderr).includes(VERSION), `pin refusal must name the package version: ${pinned.stderr}`);
  assert(!fs.existsSync(pinnedOut), 'refused pinned pack must not write an archive');

  return `${files.length} whitelist entries; fixture packs ${manifest.fileCount} files (probe in, `
    + `${Object.keys(backups).length} backups out), verify ok, leak refused, wrong version refused`;
}

function p6NoPackageWrites(snapshot) {
  const strayTmp = path.join(HERE, 'tmp');
  assert(!fs.existsSync(strayTmp), `the run wrote test/tmp inside the package: ${strayTmp}`);
  assert(!fs.existsSync(path.join(HERE, 'REPORT.md')), 'the run wrote test/REPORT.md inside the package');
  assert(!TMP.startsWith(ROOT + path.sep), `TMP must live outside the package, got ${TMP}`);
  assert(fs.existsSync(TMP), `the temp root disappeared: ${TMP}`);
  const changed = diffSnapshots(snapshot, dirSnapshot(ROOT));
  assert(changed.length === 0, `the test run modified the package tree: ${changed.slice(0, 5).join(', ')}`);
  return `temp root = ${TMP}; test/tmp absent; test/REPORT.md absent; package tree unchanged (${Object.keys(snapshot).length} files)`;
}

// ---------------------------------------------------------------- main

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(FIX, { recursive: true });
  // P6: everything this suite writes lives outside the package; capture the
  // package tree now so the last regression can prove the run changed nothing.
  assert(!fs.existsSync(path.join(HERE, 'tmp')), 'test/tmp must not exist inside the package');
  assert(!fs.existsSync(path.join(HERE, 'REPORT.md')), 'test/REPORT.md must not exist inside the package');
  const packageSnapshot = dirSnapshot(ROOT);
  console.log(`plugin: ${ROOT}`);
  console.log(`fixtures: ${FIX}\n`);

  runCase('T1', 'normal truncate: bytes/events/first seq/last type/derive sha + backup + ledger', t1Normal);
  runCase('T2a', 'backup missing -> abort, original untouched', () => t2BackupFailures('missing'));
  runCase('T2b', 'backup sha mismatch -> abort, original untouched', () => t2BackupFailures('mismatch'));
  runCase('T3', 'crash before rename -> original untouched, tmp cleaned', t3CrashBeforeRename);
  runCase('T4', 'post-rename verify failure -> rollback from backup + rollback.json', t4PostRenameRollback);
  runCase('N1', 'concurrent append during truncate -> SESSION_CHANGED, append kept, backup = snapshot', n1ConcurrentAppendSurvives);
  runCase('N2', 'frame boundaries come from the zstd structure, not from magic bytes in the data', n2FrameBoundariesIgnoreMagicInData);
  runCase('N3', 'lease ttlSec is bounded at 86400; a corrupt expiresAt cannot lock the store', n3LeaseBoundsAndCorruptExpiry);
  runCase('N4', '.bak-* is read-only for destructive tools (truncate/backup -> IS_BACKUP)', n4BackupsAreNotWritableTargets);
  await runAsyncCase('N4c', 'session_compact refuses a .bak-* target', n4CompactRefusesBackup);
  runCase('T5', 'live session refused (recent write + read-only lock)', t5LiveRefusals);
  runCase('T6', 'three fixtures (small/medium/large, Chinese, title, job events)', t6ThreeFixtures);
  runCase('T6b', 'cut avoids agent/inbox traffic at the boundary', t6bInboxBoundary);
  runCase('T8', 'dry runs write zero bytes', t8DryRunZeroWrites);
  runCase('T9', 'resolve sessionPath/sessionId/latest (fake DSH_HOME, dry run writes nothing)', t9ResolveSession);
  runCase('T10', 'compaction analysis separates shadowed history from reclaimed bytes', t10CompactionAnalysis);
  try {
    const detail = await t11CompactStates();
    record('T11', 'compact tool states: unavailable / dryRun / idle / busy-queued', true, detail);
  } catch (error) {
    record('T11', 'compact tool states: unavailable / dryRun / idle / busy-queued', false, error.message);
  }

  runCase('T12', 'session_wake: STATE 三节 + flow + 最新 journal 三标题 + INDEX 短行', t12WakeNormal);
  runCase('T13', 'session_wake: 记忆根不存在 -> unavailable，不抛错', t13WakeUnavailable);
  runCase('T14', 'session_wake: 缺文件写跳过说明、flow 截断、总量 <= 2500 字', t14WakePartialAndCaps);
  runCase('T15', 'lease_acquire: 第一次成功，写入 holder/pid/acquiredAt/ttlSec', t15LeaseAcquire);
  runCase('T16', 'lease_acquire: 第二次被拒并给出 reason + 现有 holder', t16LeaseRejected);
  runCase('T17', 'lease_acquire: 过期（含坏 JSON）可抢一次', t17LeaseExpired);
  runCase('T18', 'lease_release: 无租约 / 非 holder 被拒 / holder 可删', t18LeaseRelease);
  try {
    const detail = await t19LeaseRace();
    record('T19', 'lease 跨进程并发：两个真进程只有一个拿到', true, detail);
  } catch (error) {
    record('T19', 'lease 跨进程并发：两个真进程只有一个拿到', false, error.message);
  }
  runCase('T20', 'lease_acquire: 记忆根不存在 -> unavailable 文案，不抛错、不建目录', t20LeaseAcquireMissingRoot);
  runCase('T21', 'lease_release: 记忆根不存在 -> 同样的 unavailable 文案', t21LeaseReleaseMissingRoot);
  runCase('T22', '三个工具的记忆根缺失文案格式一致（unavailable: 原因 — 怎么办）', t22UnifiedUnavailableFormat);
  await runAsyncCase('T23', 'worker_spawn: 无 subagents 服务 / inject 守卫 / 缺 prompt -> unavailable，不抛错', t23WorkerSpawnUnavailable);
  await runAsyncCase('T24', 'worker_status: 查不存在的 workerId -> unavailable；无服务时降级读会话文件', t24WorkerStatusMissing);
  await runAsyncCase('T25', 'worker_kill: 杀不存在的 worker -> unavailable（不发假成功）', t25WorkerKillUnavailable);
  await runAsyncCase('T26', '三个 worker 工具都注册成功，必填字段在 schema 里，inject 仍是 [tools]', t26WorkerToolRegistration);
  runCase('T27', '真 Cordis inject 守卫下版本探测不抛错（0.7.3 整条 entry 挂掉的回归）', t27HostVersionProbeGuarded);

  await runAsyncCase('F5', 'worker_kill 先验活：kill 与 status 判定一致，只有活着才 killed', f5KillRequiresLive);
  runCase('F1', 'session_backup: confirm 缺省/近似值拒写，大小写不敏感，dry-run 只算不写', f1BackupConfirmGate);
  runCase('F2', '路径白名单：越界/相对/穿越/非 session 文件名一律拒，sessions 内照常', f2PathWhitelist);
  runCase('F3', '0 字节源 unavailable；同名 .bak-* 目录不当备份、不触发 EISDIR', f3ZeroByteAndDirectoryTrap);
  runCase('F4', '备份计划与实跑同名、旧备份不复用、文件名唯一', f4PlanMatchesRealRun);
  runCase('F6', '已回收必须磁盘实数：start/end 字段认、数不出来 unknown', f6ReclaimedNeedsDiskCount);
  runCase('P1', '测试套件不读凭据文件', p1NoCredentialRead);
  runCase('P2', 'session_wake 不反射 session 参数 / journal 按时间选 / 截断标志诚实', p2WakeInjectionJournalTruncation);
  runCase('P3', 'session_truncate 返回形状统一 / dry-run 与真跑同判', p3TruncateShapeAndParity);
  await runAsyncCase('P4', 'session_compact 返回快照 / 两条路径错误处理一致', p4CompactSnapshotAndErrors);
  await runAsyncCase('P5', '亚秒/零/负数参数一律 BAD_ARGUMENT', p5SubSecondArguments);
  // Memory-layer cases run before P6 so the "package tree is unchanged" guard
  // also covers anything the new suite might accidentally write.
  runMemorySuite({ runCase, runSymlinkCase, assert, expectCode, TMP });
  runConclusionSuite({ runCase, assert, TMP });
  // Live-registry cases are async (L3 spawns real children) and also run
  // before P6 so any accidental package write would be caught.
  await runLiveSuite({ runCase, runAsyncCase, runSymlinkCase, assert, expectCode, TMP });
  // Registration contracts: ordered names, one success + one error invoke per
  // tool, and an astral-plane goal (catches split('') truncation).
  await runToolsContractSuite({ runAsyncCase, assert, TMP });
  // Portability: one memory-root chain, derived default, host range, no
  // developer-machine paths in anything package.json ships.
  runPortabilitySuite({ runCase, assert, TMP });
  // 0.6.0: 自动身份解析与自动心跳（不依赖调用方传 sessionId）。
  await runAutoBindSuite({ runCase, assert, TMP });
  await runVisibleTruncateSuite({ runCase, assert, TMP });
  await runAutoTruncateSuite({ runCase, assert, TMP });
  // The CLI must refuse a live target on its own (the tool-layer guard is not
  // reachable from a subprocess), and the orchestrator must stay inside the
  // sessions root and report a close failure as structured JSON.
  await runCliGuardSuite({ runCase, assert, TMP });
  await runOrchestratorSuite({ runCase, assert, TMP });
  // 0.7.5: a truncated seeded log must still load in the real host. S1-S3 pin
  // the metadata the writers emit; S4-S6 decode the result with the app's own
  // persistence + Session packages (skip when the app is not installed here).
  await runSeededLoadSuite({ runCase, recordSkip, assert, TMP });
  // R1 Router-A 规则层（纯函数，不碰盘，不改既有行为）——19 条设计场景 + 空输入/超长输入/优先级冲突。
  runRouterSuite({ runCase, assert });
  // R1 策略 profile：默认 generic（通用原则）+ 可选 owner 家规叠加层（只许收窄）。
  runPolicySuite({ runCase, assert });
  // R1 记忆工具规则层：memory_recall / consolidate / forget / procedure / save 的参数形态矩阵（16 例）。
  runRouterMemoryToolsSuite({ runCase, assert });
  // R1 fail-closed：规则/别名缺失、JSON 损坏、未知 action/kind、歧义、ctx 缺字段/类型错、
  // override 指错规则、writeScope 越界、决策/规则爆炸、judge 自检（F01–F24 回归）。
  runFailClosedSuite({ runCase, assert });
  // R1 影子模式：只记录不执行、越界拦截、采样与指标口径。
  runShadowSuite({ runCase, assert });
  // R1 身份边界：决策层不读写记忆库（import 面 / 写 API 面 / 环境无关 / 权限沙盒 / canary 哈希不变）。
  runIdentitySuite({ runCase, assert });
  // 0.8.0-rc.8: optional peer self-check + longlive-doctor (no-profile, missing,
  // present, --json, exit codes, --apply under a mock PATH, startup non-block).
  await runDoctorSetupSuite({ runCase, runAsyncCase, assert, TMP });
  await runDepsSuite({ runCase, runAsyncCase, assert, TMP });
  runCase('B1', '发布物身份：files 白名单、根目录 README*、t7 无硬编码盘符', b1PackageIdentity);
  runCase('P6', '测试不许在包内写文件', () => p6NoPackageWrites(packageSnapshot));

  let t7 = { skip: 'not run' };
  try {
    t7 = t7RealResume();
    if (t7.skip && RELEASE_GATE) {
      record('T7', 'real sdk resume (isolated DSH_HOME)', false,
        `${t7.skip} — --release makes T7 mandatory`);
    } else if (t7.skip) {
      recordSkip('T7', 'real sdk resume (isolated DSH_HOME)', t7.skip);
    } else record('T7', 'real sdk resume (isolated DSH_HOME)', true, t7.detail);
  } catch (error) {
    record('T7', 'real sdk resume (isolated DSH_HOME)', false, error.message);
    t7 = { error: error.message };
  }

  // REPORT.md
  const lines = [];
  lines.push('# 验收报告 / Acceptance report', '');
  lines.push(`生成时间：${new Date().toISOString()}`, '');
  lines.push('| 用例 | 项目 | 结果 | before sha256 | after sha256 | 说明 |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const b = r.hashes ? r.hashes.before.slice(0, 16) + '…' : '—';
    const a = r.hashes ? r.hashes.after.slice(0, 16) + '…' : '—';
    const verdict = r.skipped ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
    lines.push(`| ${r.id} | ${r.name} | ${verdict} | ${b} | ${a} | ${String(r.detail).replaceAll('|', '\\|')} |`);
  }
  lines.push('', '完整 sha256（64 位）：', '');
  for (const r of results) {
    if (!r.hashes) continue;
    lines.push(`- ${r.id}: before \`${r.hashes.before}\` / after \`${r.hashes.after}\``);
  }
  if (t7?.command) {
    lines.push('', '## T7 命令与输出', '', '```', t7.command, '```', '', '```', t7.output ?? '', '```');
  }
  lines.push('', `契约：任何失败场景，磁盘上的 session.v4.jsonl.zstd 必须与输入字节一致（sha256 相同）。`, '');
  const reportPath = path.join(TMP, 'REPORT.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  const passedCount = results.filter((r) => r.ok && !r.skipped).length;
  const failedCount = results.filter((r) => !r.ok).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  console.log(`\n${passedCount} passed, ${failedCount} failed, ${skippedCount} skipped`);
  // "N/N passed" hid a skip behind a green total. Never again: a skipped case
  // is named out loud and the summary refuses to call itself a full pass.
  if (skippedCount > 0) {
    console.log(`NOTE: ${skippedCount} test(s) skipped — this is not a full pass`);
  }
  console.log(`report: ${reportPath}`);
  if (failedCount > 0) {
    console.error(`\n${failedCount} case(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
