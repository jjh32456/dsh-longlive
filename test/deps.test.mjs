// suite: optional runtime dependencies (0.8.0-rc.8)
//
// Red-first contract for src/deps.js + scripts/longlive-doctor.mjs:
//   - a profile counts as "enabled" if the package is in dependencies OR in
//     dsh.profile.bundles;
//   - a missing optional peer never blocks plugin activation;
//   - the doctor is read-only by default, machine-readable with --json, and
//     only runs `dsh plugin add` when --apply is explicit.
//
// These fixtures live under TMP only. The package tree must stay byte-identical
// (test/run.mjs snapshots it before the suite runs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENGRAM = '@kenz1117/dsh-engram';
const LONGLIVE = '@jjh32456/dsh-longlive';
const DOCTOR = path.join(ROOT, 'scripts', 'longlive-doctor.mjs');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let tempSeq = 0;
let depsPromise = null;

function loadDeps() {
  depsPromise ??= import('../src/deps.js');
  return depsPromise.catch((error) => {
    throw new Error(`src/deps.js 不存在或无法加载（${error?.code ?? 'ERR'}）：${error?.message ?? error}`);
  });
}

function newHome(TMP, label) {
  const dir = path.join(TMP, `deps-${label}-${process.pid}-${tempSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProfile(home, name, { bundles = [], dependencies = {} } = {}) {
  const dir = path.join(home, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles } },
    dependencies,
  }, null, 2));
}

function doctor(home, args, TMP, { pathPrefix = null, env = {} } = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase() === 'PATH' || key.toUpperCase() === 'DSH_BIN' || key.toUpperCase() === 'DSH_PROFILE') {
      delete clean[key];
    }
  }
  clean.DSH_HOME = home;
  clean.DSH_PROFILE = '';
  clean.PATH = pathPrefix ?? (process.env.PATH ?? process.env.Path ?? '');
  Object.assign(clean, env);
  return spawnSync(process.execPath, [DOCTOR, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: clean,
    timeout: 120000,
    windowsHide: true,
  });
}

function parseJson(run, assert, label) {
  const text = String(run.stdout ?? '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    assert(false, `${label}: --json 输出不是合法 JSON（${error.message}）\nstdout=${JSON.stringify(text)}\nstderr=${JSON.stringify(String(run.stderr ?? ''))}`);
  }
  return parsed;
}

function makeMockDsh(dir, TMP) {
  const log = path.join(TMP, `mock-dsh-${process.pid}-${tempSeq++}.log`);
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'dsh.cmd'), [
      '@echo off',
      '>>"%DSH_DOCTOR_TEST_LOG%" echo %*',
      '1>&2 echo mock-dsh: cannot install (exit 7)',
      'exit /b 7',
      '',
    ].join('\r\n'));
  } else {
    const file = path.join(dir, 'dsh');
    fs.writeFileSync(file, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$DSH_DOCTOR_TEST_LOG"',
      'echo "mock-dsh: cannot install (exit 7)" >&2',
      'exit 7',
      '',
    ].join('\n'));
    fs.chmodSync(file, 0o755);
  }
  return { log, path: dir };
}

export async function runDepsSuite({ runCase, runAsyncCase, assert, TMP }) {
  const base = TMP ?? fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-deps-'));

  // DEP1 — a DSH home with no profiles directory must not throw or demand a dep.
  await runAsyncCase('DEP1', '无 profile 目录：不崩、status 空、ok=true', async () => {
    const { checkOptionalDeps } = await loadDeps();
    const home = newHome(base, 'empty');
    const result = checkOptionalDeps({ home, env: {} });
    assert(result && typeof result === 'object', 'checkOptionalDeps 必须返回对象');
    assert(
      JSON.stringify(Object.keys(result).sort()) === JSON.stringify(['missing', 'ok', 'present', 'profile']),
      `返回字段必须恰好是 ok/profile/missing/present，实际 ${JSON.stringify(Object.keys(result).sort())}`,
    );
    assert(result.ok === true, `无 profile 时 ok 应为 true，实际 ${result.ok}`);
    assert(result.profile === null, `无 profile 时 profile 应为 null，实际 ${JSON.stringify(result.profile)}`);
    assert(Array.isArray(result.missing) && result.missing.length === 0, `missing 应为空，实际 ${JSON.stringify(result.missing)}`);
    assert(Array.isArray(result.present) && result.present.length === 0, `present 应为空，实际 ${JSON.stringify(result.present)}`);
  });

  // DEP2 — longlive enabled, engram absent: ok=false, one missing entry.
  await runAsyncCase('DEP2', 'profile 启用 longlive 但缺 engram：missing 命中', async () => {
    const { checkOptionalDeps } = await loadDeps();
    const home = newHome(base, 'missing');
    writeProfile(home, 'solo', { bundles: [LONGLIVE] });
    const result = checkOptionalDeps({ home, env: {} });
    assert(result.ok === false, `缺 engram 时 ok 应为 false，实际 ${result.ok}`);
    assert(result.profile === 'solo', `应锁定启用了 longlive 的 profile=solo，实际 ${JSON.stringify(result.profile)}`);
    assert(result.missing.includes(ENGRAM), `missing 应包含 ${ENGRAM}，实际 ${JSON.stringify(result.missing)}`);
    assert(!result.present.includes(ENGRAM), `present 不应包含 ${ENGRAM}`);
  });

  // DEP3 — dependencies is enough (no bundles entry needed).
  await runAsyncCase('DEP3', 'dependencies 里装了 engram：present', async () => {
    const { checkOptionalDeps } = await loadDeps();
    const home = newHome(base, 'deps');
    writeProfile(home, 'solo', {
      bundles: [LONGLIVE],
      dependencies: { [ENGRAM]: '0.11.3' },
    });
    const result = checkOptionalDeps({ home, env: {} });
    assert(result.ok === true, `装了 engram 时 ok 应为 true，实际 ${result.ok}，missing=${JSON.stringify(result.missing)}`);
    assert(result.present.includes(ENGRAM), `present 应包含 ${ENGRAM}，实际 ${JSON.stringify(result.present)}`);
    assert(result.missing.length === 0, `missing 应为空，实际 ${JSON.stringify(result.missing)}`);
  });

  // DEP3b — bundles alone also counts as enabled (host installs bundles by name).
  await runAsyncCase('DEP3b', 'bundles 里列了 engram：同样算已启用', async () => {
    const { checkOptionalDeps } = await loadDeps();
    const home = newHome(base, 'bundles');
    writeProfile(home, 'solo', { bundles: [LONGLIVE, ENGRAM], dependencies: {} });
    const result = checkOptionalDeps({ home, env: {} });
    assert(result.ok === true, `bundles 含 engram 时 ok 应为 true，实际 ${result.ok}`);
    assert(result.present.includes(ENGRAM), `bundles 含 engram 时应计入 present，实际 ${JSON.stringify(result.present)}`);
  });

  // DEP4 — --json is one valid JSON object with the documented shape.
  await runAsyncCase('DEP4', 'doctor --json 输出结构与退出码', async () => {
    const home = newHome(base, 'json');
    writeProfile(home, 'solo', { bundles: [LONGLIVE] });
    const run = doctor(home, ['--json'], base);
    assert(run.status === 1, `缺包时 --json 应 exit 1，实际 ${run.status}；stderr=${String(run.stderr ?? '')}`);
    const json = parseJson(run, assert, 'DEP4');
    assert(json.ok === false, `json.ok 应为 false，实际 ${json.ok}`);
    assert(json.plugin === LONGLIVE, `json.plugin 应为 ${LONGLIVE}，实际 ${json.plugin}`);
    assert(json.version === PKG.version, `json.version 应为 ${PKG.version}，实际 ${json.version}`);
    assert(path.resolve(json.home) === path.resolve(home), `json.home 应为 ${home}，实际 ${json.home}`);
    assert(json.profile === 'solo', `json.profile 应为 solo，实际 ${JSON.stringify(json.profile)}`);
    assert(Array.isArray(json.profiles) && json.profiles.includes('solo'), `json.profiles 应含 solo，实际 ${JSON.stringify(json.profiles)}`);
    assert(Array.isArray(json.dependencies) && json.dependencies.length >= 1, 'json.dependencies 应至少一项');
    const entry = json.dependencies.find((row) => row.name === ENGRAM);
    assert(entry, `json.dependencies 应含 ${ENGRAM}，实际 ${JSON.stringify(json.dependencies)}`);
    assert(entry.present === false, `engram present 应为 false，实际 ${entry.present}`);
    assert(entry.optional === true, `engram optional 应为 true，实际 ${entry.optional}`);
    assert(entry.installCommand === `dsh plugin --profile solo add ${ENGRAM}`, `installCommand 应带 --profile solo，实际 ${entry.installCommand}`);
    assert(typeof entry.status === 'string' && entry.status.length > 0, 'status 必须是非空字符串');
  });

  // DEP5 — default mode is a readable table, not JSON, and exits 1 when missing.
  await runAsyncCase('DEP5', 'doctor 默认只读表格：缺包 exit 1', async () => {
    const home = newHome(base, 'table');
    writeProfile(home, 'solo', { bundles: [LONGLIVE] });
    const run = doctor(home, [], base);
    assert(run.status === 1, `缺包时默认模式应 exit 1，实际 ${run.status}`);
    const out = String(run.stdout ?? '');
    assert(out.includes(ENGRAM), `表格应列出 ${ENGRAM}，实际输出：\n${out}`);
    assert(out.includes('缺失'), `表格应有“缺失”状态，实际输出：\n${out}`);
    assert(out.includes(`dsh plugin --profile solo add ${ENGRAM}`), `表格应给出可复制安装命令（带 --profile），实际输出：\n${out}`);
    assert(!out.trim().startsWith('{'), '默认模式不应输出 JSON');
  });

  // DEP6 — every scoped profile has the dep: exit 0.
  await runAsyncCase('DEP6', 'doctor 全部已启用：exit 0', async () => {
    const home = newHome(base, 'ready');
    writeProfile(home, 'solo', {
      bundles: [LONGLIVE, ENGRAM],
      dependencies: { [ENGRAM]: '0.11.3' },
    });
    const run = doctor(home, [], base);
    assert(run.status === 0, `全在时应 exit 0，实际 ${run.status}；stdout=${String(run.stdout ?? '')}；stderr=${String(run.stderr ?? '')}`);
    const out = String(run.stdout ?? '');
    assert(out.includes('已启用'), `表格应显示“已启用”，实际输出：\n${out}`);
  });

  // DEP7 — --help documents all four usages and exits 0.
  await runAsyncCase('DEP7', 'doctor --help：四种用法齐全', async () => {
    const home = newHome(base, 'help');
    const run = doctor(home, ['--help'], base);
    assert(run.status === 0, `--help 应 exit 0，实际 ${run.status}`);
    const out = String(run.stdout ?? '');
    assert(out.includes('--setup'), `--help 应说明 --setup，实际输出：\n${out}`);
    assert(out.includes('YES'), `--help 应说明大写 YES 确认，实际输出：\n${out}`);
    assert(out.includes('--json'), `--help 应说明 --json，实际输出：\n${out}`);
    assert(out.includes('--apply'), `--help 应说明 --apply，实际输出：\n${out}`);
    assert(out.includes('只读检查'), `--help 应说明默认只读用法，实际输出：\n${out}`);
    assert(out.includes('退出码') || out.includes('exit'), `--help 应说明退出码，实际输出：\n${out}`);
  });

  // DEP8 — --apply --yes really invokes dsh; a non-zero child is reported, not hidden.
  await runAsyncCase('DEP8', 'doctor --apply --yes：mock PATH 下被调用且失败可捕获', async () => {
    const home = newHome(base, 'apply');
    writeProfile(home, 'solo', { bundles: [LONGLIVE] });
    const mock = makeMockDsh(path.join(base, `mock-bin-${process.pid}-${tempSeq++}`), base);
    const basePath = process.env.PATH ?? process.env.Path ?? '';
    const run = doctor(home, ['--apply', '--yes', '--json'], base, {
      pathPrefix: `${mock.path}${path.delimiter}${basePath}`,
      env: { DSH_DOCTOR_TEST_LOG: mock.log },
    });
    assert(run.status === 1, `安装失败后应 exit 1，实际 ${run.status}；stderr=${String(run.stderr ?? '')}`);
    const json = parseJson(run, assert, 'DEP8');
    assert(json.ok === false, `最终 ok 应为 false，实际 ${json.ok}`);
    assert(Array.isArray(json.applied) && json.applied.length === 1, `applied 应有一条，实际 ${JSON.stringify(json.applied)}`);
    const applied = json.applied[0];
    assert(applied.name === ENGRAM, `applied.name 应为 ${ENGRAM}，实际 ${applied.name}`);
    assert(applied.ok === false, '子进程 exit 7 时 applied.ok 必须为 false');
    assert(applied.exitCode === 7, `applied.exitCode 应为 7，实际 ${JSON.stringify(applied.exitCode)}`);
    assert(String(applied.command).includes(`plugin --profile solo add ${ENGRAM}`), `command 应含 plugin --profile solo add ${ENGRAM}，实际 ${applied.command}`);
    assert(String(applied.message ?? '').includes('mock-dsh'), `message 应保留子进程 stderr，实际 ${applied.message}`);
    assert(fs.existsSync(mock.log), `mock dsh 未被调用（没有 ${mock.log}）`);
    const logText = fs.readFileSync(mock.log, 'utf8');
    assert(logText.includes('plugin --profile solo add'), `mock dsh 收到的参数不对：${logText}`);
    assert(logText.includes(ENGRAM), `mock dsh 未收到包名：${logText}`);
  });

  // DEP9 — activation with the optional peer missing must still register all 22 tools.
  await runAsyncCase('DEP9', '缺 engram 不阻塞插件启动，只警告一次', async () => {
    const home = newHome(base, 'startup');
    writeProfile(home, 'solo', { bundles: [LONGLIVE] });
    const warnings = [];
    const registered = [];
    const ctx = {
      tools: {
        register(def) {
          registered.push(def);
          return () => {};
        },
      },
      logger() {
        return { warn: (text) => warnings.push(String(text)) };
      },
    };
    const { apply } = await import('../src/index.js');
    const { TOOLS: entryTools } = await import('../src/tools.js');
    const count = await apply(ctx, {
      home,
      env: {},
      heartbeatMs: 0,
      recoverOnStart: false,
      defineTool: (definition) => definition,
      routerRuntime: 'off',
    });
    assert(count === entryTools.length, `apply 应返回注册数 ${entryTools.length}，实际 ${count}`);
    assert(registered.length === entryTools.length, `应注册 ${entryTools.length} 个工具，实际 ${registered.length}`);
    const depWarning = warnings.find((text) => text.includes(ENGRAM));
    assert(depWarning, `应输出包含 ${ENGRAM} 的警告，实际警告：${JSON.stringify(warnings)}`);
    assert(depWarning.includes(`可选依赖缺失：${ENGRAM}`), `警告应以「可选依赖缺失：<包名>」列出，实际：${depWarning}`);
    assert(depWarning.includes('--setup'), `警告应指向 --setup 向导，实际：${depWarning}`);
    assert(depWarning.includes('会先列清单再要你确认'), `警告应说明先列清单再确认，实际：${depWarning}`);
  });

  // DEP10 — the published metadata must declare the optional peer and ship the tools.
  await runAsyncCase('DEP10', 'package.json：可选 peer + files 白名单', async () => {
    assert(PKG.peerDependencies?.[ENGRAM] === '>=0.11.0', `peerDependencies 应声明 ${ENGRAM} >=0.11.0，实际 ${JSON.stringify(PKG.peerDependencies?.[ENGRAM])}`);
    assert(PKG.peerDependenciesMeta?.[ENGRAM]?.optional === true, `peerDependenciesMeta.${ENGRAM}.optional 应为 true`);
    assert(Array.isArray(PKG.files), 'package.json files 必须是数组');
    assert(PKG.files.includes('scripts/longlive-doctor.mjs'), 'files 白名单缺少 scripts/longlive-doctor.mjs');
    assert(PKG.files.includes('test/deps.test.mjs'), 'files 白名单缺少 test/deps.test.mjs');
    assert(PKG.files.includes('src/*.js'), 'files 白名单应保留 src/*.js（覆盖 src/deps.js）');
  });
}

// ── 单跑入口（被 run.mjs import 时不打印）──────────────────────────────
const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const results = [];
  const assert = (cond, message) => {
    if (!cond) throw new Error(message || 'assertion failed');
  };
  const runCase = (id, name, fn) => {
    const started = Date.now();
    try {
      const detail = fn();
      results.push({ id, ok: true, detail, ms: Date.now() - started });
    } catch (error) {
      results.push({ id, ok: false, detail: error.message, ms: Date.now() - started });
    }
    const last = results[results.length - 1];
    console.log(`${last.ok ? 'PASS' : 'FAIL'}  ${last.id}  ${name}  ${last.detail ?? ''}`);
  };
  const runAsyncCase = async (id, name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ id, ok: true, detail, ms: Date.now() - started });
    } catch (error) {
      results.push({ id, ok: false, detail: error.message, ms: Date.now() - started });
    }
    const last = results[results.length - 1];
    console.log(`${last.ok ? 'PASS' : 'FAIL'}  ${last.id}  ${name}  ${last.detail ?? ''}`);
  };

  const directTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longlive-deps-direct-'));
  try {
    await runDepsSuite({ runCase, runAsyncCase, assert, TMP: directTmp });
  } catch (error) {
    console.error(`suite crashed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
  const failedCases = results.filter((entry) => !entry.ok);
  const totalMs = results.reduce((sum, entry) => sum + entry.ms, 0);
  console.log(`\n${results.length - failedCases.length} passed, ${failedCases.length} failed, ${totalMs}ms total`);
  if (failedCases.length > 0) process.exitCode = 1;
}
