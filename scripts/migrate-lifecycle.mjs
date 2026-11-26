#!/usr/bin/env node
/**
 * lifecycle 迁移 CLI（1.8.11 D1/D7）。
 *
 *   node scripts/migrate-lifecycle.mjs --mode plan     [--memory-root <path>] [--plan <file>]
 *   node scripts/migrate-lifecycle.mjs --mode dry-run  --memory-root <path> [--copy-root <dir>] [--cleanup]
 *   node scripts/migrate-lifecycle.mjs --mode apply    --memory-root <path> --allow-real-root
 *   node scripts/migrate-lifecycle.mjs --mode rollback --memory-root <path> [--migration-id <id>]
 *   node scripts/migrate-lifecycle.mjs --mode list     [--memory-root <path>]
 *
 * 安全阀：apply/rollback 在没有显式 --allow-real-root 时拒绝，且对默认记忆根
 * （<DSH home>/longlive-memory）永远拒绝 —— 真库迁移要 lead 批准后另跑一次。
 * 输出永远是 JSON（stdout），便于验收与红队复算。
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  loadLifecyclePlan,
  planLifecycleMigration,
  applyLifecycleMigration,
  rollbackLifecycleMigration,
  dryRunLifecycleMigration,
  listLifecycleMigrations,
  defaultPlanPath,
} from '../src/memory/migrate-lifecycle.js';
import { memoryRootFromConfig, defaultMemoryRoot, isInsideRoot } from '../src/memory/paths.js';

function realPathOf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function parseArgs(argv) {
  const args = { _: [], json: true };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const key = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).trim();
    if (eq >= 0) {
      args[key] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function fail(code, message, extra = {}) {
  const receipt = { ok: false, code, message, ...extra };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(3);
}

const args = parseArgs(process.argv.slice(2));
const mode = typeof args.mode === 'string'
  ? args.mode
  : (args['dry-run'] ? 'dry-run' : args.apply ? 'apply' : args.rollback ? 'rollback' : 'plan');
const explicitRoot = typeof args['memory-root'] === 'string' ? args['memory-root']
  : (typeof args['mem-root'] === 'string' ? args['mem-root'] : null);
let root = null;
try {
  root = memoryRootFromConfig(explicitRoot == null ? {} : { memoryRoot: explicitRoot });
} catch (error) {
  fail(error.code ?? 'E_MEMORY_ROOT', error.message);
}
// 红队 R12 P1-1：字符串比较可被 junction/符号链接别名绕过（mklink /J 指向真库后守卫不触发）。
// 这里用 realpathSync.native 解析：别名目标一律拒绝，只有「解析后确实是默认真根」才认。
const defaultRootReal = realPathOf(defaultMemoryRoot());
const rootResolved = path.resolve(root);
const rootReal = realPathOf(root);
const aliasDetected = rootResolved !== rootReal;
const touchesRealRoot = rootReal === defaultRootReal || isInsideRoot(defaultRootReal, rootReal);

if ((mode === 'apply' || mode === 'rollback') && aliasDetected) {
  fail('E_REAL_ROOT_REFUSED', 'memory-root 是符号链接/junction 别名，可能指向真实记忆根；apply/rollback 拒绝通过别名执行', {
    root,
    rootReal,
    defaultRootReal,
  });
}
if ((mode === 'apply' || mode === 'rollback') && touchesRealRoot && args['allow-real-root'] !== true) {
  fail('E_REAL_ROOT_REFUSED', '默认记忆根（或其子路径）上的 apply/rollback 需要 lead 批准后显式 --allow-real-root；请先用 --mode dry-run 在临时副本上验证', {
    root,
    rootReal,
    defaultRootReal,
  });
}

const planPath = typeof args.plan === 'string' ? args.plan : defaultPlanPath();

try {
  let receipt = null;
  if (mode === 'plan') {
    const loaded = loadLifecyclePlan(planPath);
    receipt = planLifecycleMigration({ memoryRoot: root, plan: loaded.plan, planSha256: loaded.sha256, planPath: loaded.path });
  } else if (mode === 'dry-run') {
    const loaded = loadLifecyclePlan(planPath);
    receipt = dryRunLifecycleMigration({
      memoryRoot: root,
      plan: loaded.plan,
      planPath: loaded.path,
      planSha256: loaded.sha256,
      copyRoot: typeof args['copy-root'] === 'string' ? args['copy-root'] : null,
      cleanup: args.cleanup === true,
      query: typeof args.query === 'string' ? args.query : undefined,
    });
  } else if (mode === 'apply') {
    const loaded = loadLifecyclePlan(planPath);
    receipt = applyLifecycleMigration({ memoryRoot: root, plan: loaded.plan, planPath: loaded.path, planSha256: loaded.sha256 });
  } else if (mode === 'rollback') {
    receipt = rollbackLifecycleMigration({
      memoryRoot: root,
      migrationId: typeof args['migration-id'] === 'string' ? args['migration-id'] : null,
    });
  } else if (mode === 'list') {
    receipt = listLifecycleMigrations({ memoryRoot: root });
  } else {
    fail('E_BAD_MODE', `不支持的 mode：${JSON.stringify(mode)}（plan|dry-run|apply|rollback|list）`);
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(receipt.ok === false ? 2 : 0);
} catch (error) {
  const receipt = {
    ok: false,
    code: error.code ?? 'E_MIGRATION_FAILED',
    message: error.message,
    manifestRel: error.manifestRel ?? null,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(1);
}
