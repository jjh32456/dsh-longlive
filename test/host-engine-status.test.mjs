// C1 (1.4.0): engines.dsh startup self-check — data for the panel.
//
// Pins the three promises that make this advisory instead of a new failure mode:
//   1. a mismatch only warns and writes `<memoryRoot>/.longlive/status.json`; it
//      never throws and never stops tools from registering;
//   2. a matching host writes nothing, and clears a stale mismatch so a fixed
//      installation stops showing the panel red dot;
//   3. an undetectable/unparseable version is "unknown": plugin loads, no new
//      record, no crash, and an existing record is left untouched.
//
// The host-manifest fallback is also exercised with temp files and an injected
// `readFile`, so no test depends on the machine's real DSH installation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../src/index.js';
import {
  HOST_PACKAGE_ENV,
  detectHostPackageVersion,
  detectHostVersion,
  hostPackageCandidates,
} from '../src/host-version.js';
import {
  ENGINE_STATUS_DIR,
  ENGINE_STATUS_FILE,
  engineStatusPath,
  recordEngineStatus,
} from '../src/engine-status.js';

const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const DECLARED_RANGE = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).engines.dsh;
const FIXED_NOW = '2026-11-05T13:02:01.000Z';

function tempDir(t, prefix = 'longlive-engine-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function statusFile(memoryRoot) {
  return path.join(memoryRoot, ENGINE_STATUS_DIR, ENGINE_STATUS_FILE);
}

function readStatus(memoryRoot) {
  return JSON.parse(fs.readFileSync(statusFile(memoryRoot), 'utf8'));
}

function writeStatus(memoryRoot, value) {
  const file = statusFile(memoryRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fakeContext() {
  const tools = [];
  const warnings = [];
  const hooks = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    on(name, listener) {
      hooks.push({ name, listener });
      return () => {};
    },
    logger() {
      return { warn: (message) => warnings.push(String(message)), info() {}, debug() {} };
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  return { ctx, tools, warnings, hooks };
}

function runApply(t, config = {}, prepare = null) {
  const temp = tempDir(t);
  const home = path.join(temp, 'home');
  const memoryRoot = path.join(temp, 'memory');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  if (prepare) prepare({ temp, home, memoryRoot });

  const { ctx, tools, warnings } = fakeContext();
  const returned = apply(ctx, {
    home,
    memoryRoot,
    env: {},
    heartbeatMs: 0,
    recoverOnStart: false,
    filterEnabled: false,
    routerRuntime: 'off',
    defineTool: (definition) => definition,
    now: () => Date.parse(FIXED_NOW),
    ...config,
  });
  return { temp, home, memoryRoot, ctx, tools, warnings, returned };
}

// ---------------------------------------------------------------------------
// Host manifest fallback
// ---------------------------------------------------------------------------

test('detectHostVersion reads a host package.json through config.hostPackagePath', (t) => {
  const dir = tempDir(t);
  const manifest = path.join(dir, 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({
    name: '@deepseek-ai/dsh-desktop-runtime',
    version: '0.2.2',
  }), 'utf8');

  const detection = detectHostVersion({}, { hostPackagePath: manifest }, {});
  assert.equal(detection.version, '0.2.2');
  assert.equal(detection.source, 'hostPackage');
  assert.equal(detection.path, manifest);
  assert.equal(detection.origin, 'config.hostPackagePath');
});

test('detectHostVersion understands the desktop-runtime.json release.version shape', (t) => {
  const dir = tempDir(t);
  const runtime = path.join(dir, 'desktop-runtime.json');
  fs.writeFileSync(runtime, JSON.stringify({ release: { version: '0.2.1-rc.5' } }), 'utf8');

  const detection = detectHostVersion({}, { hostPackagePath: runtime }, {});
  assert.equal(detection.version, '0.2.1-rc.5');
  assert.equal(detection.path, runtime);
});

test('a corrupt or missing host manifest is skipped, and the next candidate wins', (t) => {
  const dir = tempDir(t);
  const broken = path.join(dir, 'package.json');
  fs.writeFileSync(broken, '{ not json', 'utf8');
  const valid = path.join(dir, 'fallback-package.json');
  fs.writeFileSync(valid, JSON.stringify({ version: '0.3.0' }), 'utf8');

  const viaEnv = detectHostVersion({}, { hostPackagePath: broken }, { [HOST_PACKAGE_ENV]: valid });
  assert.equal(viaEnv.version, '0.3.0');
  assert.equal(viaEnv.path, valid);
  assert.equal(viaEnv.origin, `env.${HOST_PACKAGE_ENV}`);

  const missing = detectHostVersion({}, { hostPackagePath: path.join(dir, 'nope.json') }, {});
  assert.equal(missing.version, null);
  assert.equal(missing.source, null);
});

test('hostPackageCandidates is dependency-free, ordered, and de-duplicated', () => {
  const configPath = path.resolve('C:/fake/config/package.json');
  const envPath = path.resolve('C:/fake/env/package.json');
  const candidates = hostPackageCandidates({
    configPath,
    env: { [HOST_PACKAGE_ENV]: envPath },
    resourcesPath: path.resolve('C:/fake/resources'),
    execPath: path.resolve('C:/fake/install/Harness.exe'),
  });
  const paths = candidates.map((entry) => entry.path);
  assert.equal(paths[0], configPath);
  assert.equal(paths[1], envPath);
  assert.ok(paths.includes(path.resolve('C:/fake/resources/app.asar/dsh/package.json')));
  assert.ok(paths.includes(path.resolve('C:/fake/resources/app.asar/dsh/desktop-runtime.json')));
  assert.ok(paths.includes(path.resolve('C:/fake/install/resources/app.asar/dsh/package.json')));
  assert.equal(new Set(paths).size, paths.length, 'no duplicate candidate paths');
});

test('an unreadable host manifest is unknown, not an exception', () => {
  const detection = detectHostPackageVersion({
    configPath: path.resolve('C:/fake/missing/package.json'),
    env: {},
    resourcesPath: undefined,
    execPath: path.resolve('C:/fake/node.exe'),
    readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(detection, null);
});

// ---------------------------------------------------------------------------
// apply(): mismatch / match / unknown
// ---------------------------------------------------------------------------

test('mismatch: plugin still registers every tool and writes the panel record', (t) => {
  const run = runApply(t, { hostVersion: '0.1.0' });

  assert.ok(run.returned, 'apply returned normally');
  assert.ok(run.tools.length >= 20, `expected the full tool table, got ${run.tools.length}`);
  assert.ok(run.tools.some((tool) => tool.name === 'session_truncate'), 'session_truncate is registered');
  assert.ok(run.warnings.some((line) => line.includes('0.1.0') && line.includes(DECLARED_RANGE)),
    `a mismatch warning naming both ends is emitted: ${run.warnings.join(' | ')}`);
  assert.ok(run.warnings.some((line) => line.includes('降级')), 'warning says the plugin degrades');

  const status = readStatus(run.memoryRoot);
  assert.deepEqual(status.engineMismatch, {
    hostVersion: '0.1.0',
    required: DECLARED_RANGE,
    at: FIXED_NOW,
    source: 'config.hostVersion',
  });

  const leftovers = fs.readdirSync(path.join(run.memoryRoot, ENGINE_STATUS_DIR))
    .filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'no temporary write file is left behind');
});

test('mismatch through the environment uses the env source label', (t) => {
  const run = runApply(t, { env: { DSH_HOST_VERSION: '2.0.0' } });

  assert.ok(run.tools.length >= 20);
  const status = readStatus(run.memoryRoot);
  assert.equal(status.engineMismatch.hostVersion, '2.0.0');
  assert.equal(status.engineMismatch.source, 'env.DSH_HOST_VERSION');
});

test('match: no record is written', (t) => {
  const run = runApply(t, { hostVersion: '0.9.0' });

  assert.ok(run.tools.length >= 20);
  assert.equal(fs.existsSync(statusFile(run.memoryRoot)), false, 'a matching host writes nothing');
  assert.equal(run.warnings.some((line) => line.includes('0.9.0')), false, 'no warning on a match');
});

test('match clears a stale engineMismatch but keeps unrelated keys', (t) => {
  const run = runApply(t, { hostVersion: '0.7.0' }, ({ memoryRoot }) => {
    writeStatus(memoryRoot, {
      at: '2026-11-01T00:00:00.000Z',
      ok: true,
      engineMismatch: { hostVersion: '0.1.0', required: DECLARED_RANGE, at: '2026-11-01T00:00:00.000Z' },
    });
  });

  const status = readStatus(run.memoryRoot);
  assert.equal(status.engineMismatch, undefined);
  assert.equal(status.ok, true);
  assert.equal(status.at, '2026-11-01T00:00:00.000Z');
});

test('match deletes status.json when engineMismatch was its only key', (t) => {
  const run = runApply(t, { hostVersion: '0.7.1' }, ({ memoryRoot }) => {
    writeStatus(memoryRoot, {
      engineMismatch: { hostVersion: '0.1.0', required: DECLARED_RANGE, at: '2026-11-01T00:00:00.000Z' },
    });
  });

  assert.equal(fs.existsSync(statusFile(run.memoryRoot)), false, 'stale file is removed');
});

test('unknown: an unparseable host version loads, warns about nothing, writes nothing', (t) => {
  const run = runApply(t, { hostVersion: 'not-a-version' });

  assert.ok(run.tools.length >= 20);
  assert.equal(fs.existsSync(statusFile(run.memoryRoot)), false);
  assert.equal(run.warnings.some((line) => line.includes('not-a-version')), false);
});

test('unknown: a direct verdict leaves an existing record untouched', (t) => {
  const root = tempDir(t);
  writeStatus(root, { engineMismatch: { hostVersion: '0.1.0', required: DECLARED_RANGE, at: FIXED_NOW } });

  const result = recordEngineStatus(root, {
    compat: { status: 'unknown', version: 'nope', range: DECLARED_RANGE, warning: null },
    now: () => new Date(FIXED_NOW),
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'unknown');
  assert.equal(readStatus(root).engineMismatch.hostVersion, '0.1.0');
});

test('a memoryRoot path that is a file warns but never blocks activation', (t) => {
  const temp = tempDir(t);
  const home = path.join(temp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bogusRoot = path.join(temp, 'not-a-directory');
  fs.writeFileSync(bogusRoot, 'x', 'utf8');

  const { ctx, tools, warnings } = fakeContext();
  assert.doesNotThrow(() => {
    apply(ctx, {
      home,
      memoryRoot: bogusRoot,
      hostVersion: '0.1.1',
      env: {},
      heartbeatMs: 0,
      recoverOnStart: false,
      filterEnabled: false,
      routerRuntime: 'off',
      defineTool: (definition) => definition,
    });
  });
  assert.ok(tools.length >= 20, 'tools still load when the status file cannot be written');
  assert.ok(warnings.some((line) => line.includes('记忆根目录')), 'the bad root is reported');
});

test('recordEngineStatus with no memoryRoot is a silent no-op', () => {
  assert.equal(engineStatusPath(''), null);
  assert.equal(engineStatusPath('   '), null);
  const result = recordEngineStatus(null, {
    compat: { status: 'mismatch', version: '0.1.0', range: DECLARED_RANGE, warning: 'x' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'no-memory-root');
});
