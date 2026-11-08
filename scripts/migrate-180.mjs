#!/usr/bin/env node
// scripts/migrate-180.mjs — 1.8.0 / v2.8 §16.6：records.jsonl → claims.jsonl 迁移（默认 dry-run）
//
//   node scripts/migrate-180.mjs [--memory-root <dir>] [--apply] [--json]
//
// 安全：默认 dry-run；--apply 先备份 records.jsonl 到 .longlive/backups/ 再追加 claims；
// 不物理删除任何文件；幂等（重复 apply 不重复追加）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateRecordsToClaims } from '../src/memory/migrate.js';

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function parseArgs(argv) {
  const out = { memoryRoot: '', apply: false, json: false, allowRealRoot: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    // 未知 flag / 位置参数必须显式 E_CLI_UNKNOWN_FLAG（exit 2），不许静默忽略。
    if (!match) throw new CliError('E_CLI_UNKNOWN_FLAG', `unknown argument: ${arg}`);
    let value = match[2];
    if (value === undefined && index + 1 < argv.length && !String(argv[index + 1]).startsWith('--')) {
      value = argv[index + 1];
      index += 1;
    }
    // --root is an alias of --memory-root (sandbox drills used either spelling).
    if (match[1] === 'memory-root' || match[1] === 'root') {
      if (value === undefined || value === '') throw new CliError('E_CLI_INVALID_VALUE', '--memory-root/--root requires a value');
      out.memoryRoot = value;
    } else if (match[1] === 'apply') out.apply = true;
    else if (match[1] === 'json') out.json = true;
    else if (match[1] === 'allow-real-root') out.allowRealRoot = true;
    else throw new CliError('E_CLI_UNKNOWN_FLAG', `unknown flag: --${match[1]}`);
  }
  return out;
}

function writeCliError(error, argv) {
  const code = error?.code ?? 'E_MIGRATE_FAILED';
  const exitCode = 2;
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: false, code, exitCode, error: String(error?.message ?? error) }, null, 2));
  }
  console.error(`[migrate-180] ${code}: ${error?.message ?? error}`);
  process.exitCode = exitCode;
}

/** Resolve a path through junctions/symlinks when possible (fallback: lexical). */
function realPathOf(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Real memoryRoot candidates: env overrides, DSH longlive-memory, explicit host roots env.
 * A migration must never silently write the real store from a sandbox drill.
 */
function realMemoryRoots() {
  const roots = new Set();
  for (const name of ['DSH_LONGLIVE_MEMORY_ROOT', 'DSH_MEM']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') roots.add(path.resolve(value.trim()));
  }
  roots.add(path.join(dshHome(), 'longlive-memory'));
  // Host-injected real roots (path.delimiter separated) for non-default stores.
  const extra = process.env.DSH_LONGLIVE_REAL_ROOTS;
  if (typeof extra === 'string' && extra.trim() !== '') {
    for (const item of extra.split(path.delimiter)) {
      if (item.trim() !== '') roots.add(path.resolve(item.trim()));
    }
  }
  const out = new Set();
  for (const candidate of roots) {
    out.add(realPathOf(candidate));
    out.add(path.resolve(candidate));
  }
  return out;
}

function isRealRoot(target) {
  const resolved = realPathOf(target);
  // Generic guard: a store directory named dsh-memory / longlive-memory is real
  // unless the operator passed --allow-real-root (no machine paths in shipped code).
  const base = path.basename(resolved).toLowerCase();
  if (base === 'dsh-memory' || base === 'longlive-memory') return true;
  for (const real of realMemoryRoots()) {
    if (resolved === real) return true;
  }
  return false;
}

function dshHome() {
  const raw = process.env.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
  return path.join(os.homedir(), '.dsh');
}

function defaultMemoryRoot() {
  for (const name of ['DSH_LONGLIVE_MEMORY_ROOT', 'DSH_MEM']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value.trim());
  }
  return path.join(dshHome(), 'longlive-memory');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const memoryRoot = path.resolve(args.memoryRoot !== '' ? args.memoryRoot : defaultMemoryRoot());
  // P0 防呆：沙箱演练绝不允许悄悄迁移真实 memoryRoot（dry-run 也一样拒绝）。
  if (isRealRoot(memoryRoot) && args.allowRealRoot !== true) {
    console.error(`[migrate-180] REFUSE target=${memoryRoot} is real memoryRoot (pass --allow-real-root only if intended)`);
    process.exitCode = 3;
    return;
  }
  const receipt = migrateRecordsToClaims({ memoryRoot, apply: args.apply });
  if (receipt.code === 'E_NOTHING_TO_MIGRATE') {
    // §16.6 / P0-2：空 records 不是成功退出。JSON 必须带
    // recordsPresent/recordsTotal/countMatched，且 countMatched=false。
    if (args.json) {
      console.log(JSON.stringify(receipt, null, 2));
    } else {
      console.error(`[migrate-180] ${receipt.code}: recordsPresent=${receipt.recordsPresent} recordsTotal=${receipt.recordsTotal} countMatched=${receipt.countMatched}`);
    }
    process.exitCode = receipt.exitCode ?? 2;
    return;
  }
  if (args.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`[migrate-180] mode=${receipt.mode} memoryRoot=${receipt.memoryRoot}`);
    console.log(`[migrate-180] records=${receipt.recordsTotal} mapped=${receipt.mapped} duplicates=${receipt.duplicates} unmappable=${receipt.unmappable.length} appended=${receipt.appended} skippedExisting=${receipt.skippedExisting}`);
    console.log(`[migrate-180] claims before=${receipt.beforeClaims} after=${receipt.afterClaims} countMatched=${receipt.countMatched}`);
    if (receipt.backup) console.log(`[migrate-180] backup=${receipt.backup.path} sha256=${receipt.backup.sha256}`);
    if (!args.apply) console.log('[migrate-180] dry-run: nothing written (pass --apply to write claims)');
  }
  if (receipt.recordsTotal > 0 && !receipt.countMatched && args.apply) {
    console.error('[migrate-180] FAIL: migration count mismatch');
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  if (String(error?.code ?? '').startsWith('E_CLI_')) {
    writeCliError(error, process.argv.slice(2));
  } else {
    console.error(`[migrate-180] FAILED: ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
