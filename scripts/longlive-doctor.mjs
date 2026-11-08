#!/usr/bin/env node
// longlive-doctor — check and install dsh-longlive's optional peers.
//
// Four modes, all documented by --help:
//   1. default: read-only table, exit 1 when something is missing;
//   2. --json: one machine-readable object on stdout;
//   3. --setup: print the whole plan, require the literal uppercase YES, then
//      run `dsh plugin add <name>` once per missing peer. `--yes` skips the
//      prompt for pipes/CI. Every completed run appends one audit line.
//   4. --apply: the older per-dependency [y/N] flow, kept for compatibility.
//
// It uses only Node built-ins. Nothing is installed unless --setup or --apply
// is explicit, cancellation writes nothing at all, and a failed child process
// is reported with its exit code and captured output instead of swallowed.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import nodeReadline from 'node:readline';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  checkOptionalDeps,
  optionalPeerNames,
  resolveDshHome,
  scanProfiles,
} from '../src/deps.js';
import { VERSION } from '../src/version.js';
import { adapterHealth } from '../src/adapters/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLUGIN = '@jjh32456/dsh-longlive';
const AUDIT_FILE = 'longlive-doctor-audit.log';

let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch {
  manifest = {};
}
const peerRanges = manifest.peerDependencies ?? {};
const declaredPeers = optionalPeerNames(manifest);

function usage() {
  return [
    'longlive-doctor — 检查 dsh-longlive 的可选依赖',
    '',
    '用法：',
    '  1. node scripts/longlive-doctor.mjs            只读检查（表格）；有缺失 exit 1',
    '  2. node scripts/longlive-doctor.mjs --json     机器可读 JSON；适合脚本/CI',
    '  3. node scripts/longlive-doctor.mjs --setup    先打印完整计划，输入大写 YES 才执行 dsh plugin add',
    '     加 --yes 跳过确认（管道/CI）；非交互且没带 --yes 会 exit 2',
    '  4. node scripts/longlive-doctor.mjs --apply    逐个 [y/N] 确认后执行（旧流程，保留）',
    '     用 --profile <name> 只检查某个 profile',
    '',
    '退出码：',
    '  0  全部已启用 / 安装命令执行成功 / 用户取消',
    '  1  有缺失 / 未检测到 profile / 安装失败',
    '  2  用法错误（含 --setup、--apply 在非交互环境未加 --yes）',
    '',
  ].join('\n');
}

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { help: false, json: false, apply: false, setup: false, yes: false, profile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--setup') {
      options.setup = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--profile') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new UsageError('--profile 需要一个 profile 名称');
      options.profile = value;
      index += 1;
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (!value) throw new UsageError('--profile 需要一个 profile 名称');
      options.profile = value;
    } else {
      throw new UsageError(`未知参数：${arg}`);
    }
  }
  if (options.setup && options.apply) throw new UsageError('--setup 与 --apply 只能选一个');
  if (options.setup && options.json) throw new UsageError('--setup 不能与 --json 同用');
  return options;
}

function findDsh(env) {
  const explicit = env.DSH_BIN;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  const pathValue = env.PATH ?? env.Path ?? '';
  const names = process.platform === 'win32'
    ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh']
    : ['dsh'];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function quoteCommand(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function commandLine(dsh, name, profile) {
  // `dsh plugin` requires --profile; without it the CLI exits 1 before pnpm runs.
  const target = typeof profile === 'string' && profile.trim() !== '' ? profile.trim() : null;
  return target
    ? `${quoteCommand(dsh)} plugin --profile ${quoteCommand(target)} add ${name}`
    : `${quoteCommand(dsh)} plugin add ${name}`;
}

function targetProfiles(profile) {
  return String(profile ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function excerpt(value, limit = 600) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function buildEntries(result) {
  const names = [];
  for (const name of [...declaredPeers, ...result.missing, ...result.present]) {
    if (!names.includes(name)) names.push(name);
  }
  const profiles = targetProfiles(result.profile);
  const target = profiles.length === 1 ? profiles[0] : null;
  return names.map((name) => {
    const present = result.present.includes(name);
    const missing = result.missing.includes(name);
    return {
      name,
      range: peerRanges[name] ?? null,
      status: present ? '已启用' : (missing ? '缺失' : '未检测'),
      present,
      installCommand: target ? `dsh plugin --profile ${target} add ${name}` : `dsh plugin add ${name}`,
      optional: true,
    };
  });
}

function recheck(home, profile) {
  return checkOptionalDeps({ home, profile, dependencies: declaredPeers });
}

async function confirmInstall(name) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`为 ${name} 执行 dsh plugin add？[y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Read one line. Resolves null on EOF, Ctrl+C or close — all of which the
 * setup wizard treats as cancellation. Nothing is written by this function.
 */
function askLine(prompt) {
  return new Promise((resolve) => {
    const rl = nodeReadline.createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    rl.on('SIGINT', () => finish(null));
    rl.on('close', () => finish(null));
    rl.question(prompt, (answer) => finish(answer));
  });
}

function installOne(name, env, profile) {
  const dsh = findDsh(env);
  const command = dsh ? commandLine(dsh, name, profile) : `dsh plugin add ${name}`;
  const where = profile ? `（profile ${profile}）` : '';
  if (!dsh) {
    return {
      name,
      profile: profile ?? null,
      ok: false,
      exitCode: null,
      command,
      stdout: '',
      stderr: '',
      message: '找不到 dsh 命令：请把 DSH CLI 加进 PATH，或设置 DSH_BIN 指向可执行文件。',
    };
  }
  const child = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    env,
  });
  if (child.error) {
    return {
      name,
      profile: profile ?? null,
      ok: false,
      exitCode: null,
      command,
      stdout: String(child.stdout ?? ''),
      stderr: String(child.stderr ?? ''),
      message: `无法执行 dsh（${child.error.code ?? child.error.message}）：${command}`,
    };
  }
  const ok = child.status === 0;
  const detail = excerpt(child.stderr) || excerpt(child.stdout);
  return {
    name,
    profile: profile ?? null,
    ok,
    exitCode: child.status,
    command,
    stdout: String(child.stdout ?? ''),
    stderr: String(child.stderr ?? ''),
    message: ok
      ? `已安装 ${name}${where}，重启宿主后 engram_* / memory_save 生效。`
      : `dsh plugin add ${name} 失败${where}（exit ${child.status}）：${detail || '子进程没有输出'}`,
  };
}

function printTable({ home, profile, rows, entries, applied, ok }) {
  const lines = [];
  lines.push(`longlive-doctor · ${PLUGIN} ${VERSION}`);
  lines.push(`DSH home: ${home}`);
  lines.push(`profile: ${profile ?? '（无）'}（扫描到 ${rows.filter((row) => row.manifest).length} 个可读 profile）`);
  lines.push('');
  if (rows.length === 0) {
    lines.push('未检测到 profile：请先安装并至少启动一次 DSH，或检查 DSH_HOME。');
  } else if (rows.every((row) => !row.manifest)) {
    lines.push('没有可读的 profile 清单（profiles/*/package.json 全部无法解析）。');
  }
  lines.push('依赖                              状态      安装命令');
  lines.push('--------------------------------  --------  ------------------------------------------');
  for (const entry of entries) {
    const command = entry.present ? '—' : entry.installCommand;
    lines.push(`${entry.name.padEnd(32)}  ${entry.status.padEnd(8)}  ${command}`);
  }
  lines.push('');
  if (applied.length > 0) {
    lines.push('安装结果：');
    for (const item of applied) {
      lines.push(`  ${item.ok ? 'OK  ' : 'FAIL'}  ${item.name}  ${item.message}`);
    }
    lines.push('');
  }
  const independence = adapterHealth();
  lines.push('核心独立性（插件适配器）:');
  lines.push(`  ${independence.ok ? 'ok' : 'degraded'} · 适配器：${independence.rows.map((row) => `${row.id}=${row.mode}`).join(', ') || '无'}`);
  lines.push('  第三方插件缺席时核心照常工作：只少该插件的可选能力，降级项显式标 degraded。');
  if (ok) {
    lines.push('全部可选依赖已启用。');
  } else {
    lines.push('有缺失：按上面的命令安装，装完重启宿主。缺失不影响剪对话（核心工具照常工作）。');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** The complete plan, printed before any prompt or child process. */
function buildSetupPlan({ home, profile, missing, env }) {
  const dsh = findDsh(env);
  const lines = [];
  lines.push(`longlive-doctor · ${PLUGIN} ${VERSION}`);
  lines.push(`DSH home: ${home}`);
  lines.push(`目标 profile: ${profile ?? '（未检测到）'}`);
  const profileNames = targetProfiles(profile);
  for (const name of profileNames) {
    lines.push(`  profile 清单: ${path.join(home, 'profiles', name, 'package.json')}`);
  }
  if (profileNames.length === 0) {
    lines.push('  ！没有可确定的 profile：`dsh plugin` 必须带 --profile，');
    lines.push('    请先至少启动一次 DSH，或用 --profile <name> 指定后再跑 --setup。');
  }
  lines.push('');
  lines.push('将要做的事：');
  if (missing.length === 0) {
    lines.push('  可选依赖已全部启用，无需安装。');
  } else {
    lines.push(`  安装 ${missing.length} 个可选依赖：`);
    for (const entry of missing) {
      const range = entry.range ? `（版本约束 ${entry.range}）` : '';
      lines.push(`    - ${entry.name}${range}`);
    }
    lines.push('  将执行的命令：');
    for (const entry of missing) {
      if (profileNames.length === 0) {
        lines.push(`    ${dsh ? commandLine(dsh, entry.name) : `dsh plugin add ${entry.name}`}`);
      } else {
        for (const name of profileNames) {
          lines.push(`    ${dsh ? commandLine(dsh, entry.name, name) : `dsh plugin --profile ${name} add ${entry.name}`}`);
        }
      }
    }
    if (!dsh) {
      lines.push('  ！PATH 里没有 dsh：执行会失败；请先设置 DSH_BIN 或把 DSH CLI 加进 PATH。');
    }
    const target = profileNames.length > 0 ? profileNames.join(', ') : '目标 profile';
    lines.push(`  安装完成后需要重启宿主（退出并重新启动，或重新加载 profile ${target}）才会生效。`);
    lines.push('  doctor 不会自动重启宿主。');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function appendAudit(home, { consent, deps, result, exitCode, env }) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    user: env.USERNAME || env.USER || 'unknown',
    consent,
    deps,
    result,
    exitCode,
  });
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(path.join(home, AUDIT_FILE), `${line}\n`, 'utf8');
  } catch (error) {
    // An audit write failure must never change whether the install counts.
    process.stderr.write(`audit 日志写入失败（不影响安装结果）：${error?.message ?? error}\n`);
  }
}

/**
 * --setup: plan -> explicit uppercase YES (or --yes) -> install -> audit.
 * Returns the process exit code. Cancellation returns 0 after writing nothing.
 */
async function runSetup({ home, profile, entries, env, options }) {
  const missing = entries.filter((entry) => !entry.present);
  process.stdout.write(buildSetupPlan({ home, profile, missing, env }));

  if (missing.length === 0) {
    process.stdout.write('没有需要安装的依赖。\n');
    return 0;
  }

  const interactive = Boolean(process.stdin.isTTY) || env.DSH_DOCTOR_TEST_TTY === '1';
  let consent;
  if (options.yes) {
    consent = '--yes';
  } else {
    if (!interactive) {
      process.stderr.write(
        '--setup 在非交互环境（管道/CI）需要 --yes 确认；本次没有执行任何安装，也没有写任何文件。\n');
      return 2;
    }
    const answer = await askLine('确认执行请输入大写 YES（其它任何输入都会取消）：');
    if (answer !== 'YES') {
      process.stdout.write('已取消，未做任何改动。\n');
      return 0;
    }
    consent = 'typed-YES';
  }

  const targets = targetProfiles(profile);
  if (targets.length === 0) {
    process.stderr.write(
      '没有可确定的 profile：`dsh plugin` 必须带 --profile。请先启动一次 DSH，或用 --profile <name> 重跑；本次没有执行任何安装。\n');
    return 1;
  }

  const applied = [];
  for (const entry of missing) {
    for (const target of targets) {
      applied.push(installOne(entry.name, env, target));
    }
  }
  const failed = applied.filter((item) => !item.ok);
  const exitCode = failed.length === 0 ? 0 : 1;

  process.stdout.write('安装结果：\n');
  for (const item of applied) {
    if (item.ok) process.stdout.write(`  OK    ${item.name}  ${item.message}\n`);
  }
  if (failed.length > 0) {
    process.stderr.write('安装失败：\n');
    for (const item of failed) {
      process.stderr.write(`  FAIL  ${item.name}  ${item.message}\n`);
    }
    process.stderr.write('longlive 本体没有改动；看上面的片段修好后重跑 --setup。\n');
  } else {
    const target = String(profile ?? '').split(',').map((name) => name.trim()).filter(Boolean).join(', ');
    process.stdout.write(
      `重启宿主后生效：退出 DSH 并重新启动（或重新加载 profile ${target || '目标 profile'}）。doctor 不会自动重启。\n`);
  }

  appendAudit(home, {
    consent,
    deps: [...new Set(applied.map((item) => item.name))],
    result: exitCode === 0 ? 'ok' : 'failed',
    exitCode,
    env,
  });
  return exitCode;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const env = process.env;
  const home = resolveDshHome(env);
  const rows = scanProfiles(home);
  let result = recheck(home, options.profile ?? undefined);
  let entries = buildEntries(result);

  if (options.setup) {
    process.exitCode = await runSetup({
      home,
      profile: result.profile,
      entries,
      env,
      options,
    });
    return;
  }

  const applied = [];
  if (options.apply && entries.some((entry) => !entry.present)) {
    if (!process.stdin.isTTY && !options.yes) {
      process.stderr.write('--apply 在非交互环境需要 --yes 确认；本次没有执行任何安装。\n');
      process.exitCode = 2;
      return;
    }
    for (const entry of entries.filter((row) => !row.present)) {
      if (!options.yes) {
        const confirmed = await confirmInstall(entry.name);
        if (!confirmed) {
          applied.push({
            name: entry.name,
            ok: false,
            skipped: true,
            exitCode: null,
            command: entry.installCommand,
            stdout: '',
            stderr: '',
            message: '用户取消，未执行。',
          });
          continue;
        }
      }
      applied.push(installOne(entry.name, env, targetProfiles(result.profile).length === 1 ? targetProfiles(result.profile)[0] : null));
    }
    result = recheck(home, options.profile ?? undefined);
    entries = buildEntries(result);
  }

  const noProfiles = rows.length === 0;
  const ok = result.ok && !noProfiles;

  if (options.json) {
    const payload = {
      ok,
      plugin: PLUGIN,
      version: VERSION,
      home,
      profile: result.profile,
      profiles: rows.filter((row) => row.manifest).map((row) => row.name),
      unreadableProfiles: rows
        .filter((row) => row.error)
        .map((row) => ({ name: row.name, error: String(row.error?.message ?? row.error) })),
      dependencies: entries,
      independence: adapterHealth(),
      missing: entries.filter((entry) => !entry.present).map((entry) => entry.name),
      present: entries.filter((entry) => entry.present).map((entry) => entry.name),
    };
    if (options.apply) payload.applied = applied;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    printTable({ home, profile: result.profile, rows, entries, applied, ok });
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`longlive-doctor: ${error?.stack ?? error?.message ?? error}\n`);
  process.exitCode = 2;
});
