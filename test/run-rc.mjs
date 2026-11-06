/**
 * 1.1.0 单入口：0.8.0 原套件 + rc.1 四件新能力的套件 + 开关隔离
 * + 无人值守手术恢复自检 + rc.4 红队回归（R3-01..R3-04）
 * + rc.5 红队回归（R4-01..R4-02）+ rc.6 中文编码回归（R4-03）
 * + Router 1.1.0 服务/L1/L2/L4/唤醒/apply 回归。
 *
 * 0.8.0 的三个 S4/S5/S6 需要真实宿主包；没有 DSH_LONGLIVE_APP_EXE 时它们会
 * 诚实地 SKIP（348/0/4），设了才会跑满 350/0/1（B3 在 0.8.0 套件里加了
 * M40–M42 三个用例；350 是 347+3 的推导值，本副本未装宿主实测）。这个脚本
 * 如实汇总，不把 skip 说成 pass。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

function tail(text, lines = 80) {
  const list = String(text || '').trimEnd().split(/\r?\n/);
  return list.slice(-lines).join('\n');
}

function parseClassic(output, pattern) {
  const match = output.match(pattern);
  if (!match) return null;
  return { passed: Number(match[1]), failed: Number(match[2]), skipped: Number(match[3] ?? 0) };
}

function parseNodeTest(output) {
  const read = (name) => {
    const match = output.match(new RegExp(`(?:^|\\n)\\s*(?:#|ℹ)\\s*${name}\\s+(\\d+)`));
    return match ? Number(match[1]) : null;
  };
  const tests = read('tests');
  const passed = read('pass');
  const failed = read('fail');
  if (tests === null || passed === null || failed === null) return null;
  return { passed, failed, skipped: read('skipped') ?? 0, total: tests };
}

function run(label, args) {
  const started = Date.now();
  const result = spawnSync(NODE, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });
  const ms = Date.now() - started;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const entry = {
    label,
    status: result.status,
    ms,
    output,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  return entry;
}

const routerTests = fs.readdirSync(path.join(ROOT, 'test', 'router-background'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join('test', 'router-background', name));

const router1100Dir = path.join(ROOT, 'test', 'router-1100');
const router1100Tests = fs.existsSync(router1100Dir)
  ? fs.readdirSync(router1100Dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('test', 'router-1100', name))
  : [];

const routerFaceDir = path.join(ROOT, 'test', 'router-face');
const routerFaceTests = fs.existsSync(routerFaceDir)
  ? fs.readdirSync(routerFaceDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('test', 'router-face', name))
  : [];

const suites = [
  {
    label: '0.8.0 baseline (test/run.mjs)',
    args: ['test/run.mjs'],
    parse: (out) => parseClassic(out, /(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+skipped/),
  },
  {
    label: 'identity-router (test/identity-router/run.mjs)',
    args: ['test/identity-router/run.mjs'],
    parse: (out) => parseClassic(out, /(\d+)\s+passed,\s+(\d+)\s+failed/),
  },
  {
    label: 'session-bus (test/bus.test.mjs)',
    args: ['test/bus.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'router background (node --test)',
    args: ['--test', ...routerTests],
    parse: parseNodeTest,
  },
  ...(router1100Tests.length > 0
    ? [{
      label: 'router 1.1.0 service (node --test)',
      args: ['--test', ...router1100Tests],
      parse: parseNodeTest,
    }]
    : []),
  ...(routerFaceTests.length > 0
    ? [{
      label: 'routerFace v1 background face (node --test)',
      args: ['--test', ...routerFaceTests],
      parse: parseNodeTest,
    }]
    : []),
  // WP2 J11/J12: the L1/L2 contract test is its own formal evidence carrier.
  ...(fs.existsSync(path.join(ROOT, 'test', 'router-l1-l2.contract.test.mjs'))
    ? [{
      label: 'router 1.1.0 L1/L2 contract (node --test)',
      args: ['--test', 'test/router-l1-l2.contract.test.mjs'],
      parse: parseNodeTest,
    }]
    : []),
  {
    label: 'auto-recall + v4 + packaging (node --test)',
    args: [
      '--test',
      'test/auto-recall.test.mjs',
      'test/integration-pre-step.test.mjs',
      'test/v4-hardening.test.mjs',
      'test/packaging.test.mjs',
    ],
    parse: parseNodeTest,
  },
  {
    label: '1.2.0 filter + shadow (node --test)',
    args: ['--test', 'test/filter-shadow.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'feature flags (node --test)',
    args: ['--test', 'test/feature-flags.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'host Config schema (node --test)',
    args: ['--test', 'test/config-schema.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'settings panel (node --test)',
    args: ['--test', 'test/ui-flags.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: '1.6.0 safety defaults (node --test)',
    args: ['--test', 'test/safety-defaults.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: '1.4.0 engines.dsh self-check (node --test)',
    args: ['--test', 'test/host-engine-status.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'D1/D4 metrics ledger (node --test)',
    args: ['--test', 'test/metrics.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: '1.4.0 embedding recall (node --test)',
    args: ['--test', 'test/embedding-recall.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: '1.3.1 identity-card marker (node --test)',
    args: ['--test', 'test/identity-card-marker.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'surgery recovery (node --test)',
    args: ['--test', 'test/surgery-recovery.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'rc.4 regressions R3-01..04 (node --test)',
    args: ['--test', 'test/rc4-regressions.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'rc.5 regressions R4-01..02 (node --test)',
    args: ['--test', 'test/rc5-regressions.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'rc.6 chinese encoding R4-03 (node --test)',
    args: ['--test', 'test/rc6-chinese.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'B1/B2 auto-maintenance schedule (node --test)',
    args: ['--test', 'test/maintenance-schedule.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'D3 session_original original fetch (node --test)',
    args: ['--test', 'test/session-original.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'hot truncate cut-only compaction (node --test)',
    args: ['--test', 'test/hot-truncate.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'D2 tool-output trim (node --test)',
    args: ['--test', 'test/tool-output.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'D6 tool-surface trimming (node --test)',
    args: ['--test', 'test/d6.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'D6 tool_search host result content (node --test)',
    args: ['--test', 'test/d6-output.test.mjs'],
    parse: parseNodeTest,
  },
  {
    label: 'tool parameters host schema shape (node --test)',
    args: ['--test', 'test/tool-schema.test.mjs'],
    parse: parseNodeTest,
  },
];

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const failures = [];

process.stdout.write(`[rc] package: ${ROOT}\n`);
if (process.env.DSH_LONGLIVE_APP_EXE) {
  process.stdout.write(`[rc] host app: ${process.env.DSH_LONGLIVE_APP_EXE}\n`);
} else {
  process.stdout.write('[rc] host app: not set — 0.8.0 S4/S5/S6 will SKIP (no fake pass)\n');
}

for (const suite of suites) {
  const result = run(suite.label, suite.args);
  const parsed = suite.parse(result.output);
  if (parsed) {
    result.passed = parsed.passed;
    result.failed = parsed.failed;
    result.skipped = parsed.skipped;
  }
  totalPassed += result.passed;
  totalFailed += result.failed;
  totalSkipped += result.skipped;
  const verdict = !parsed
    ? 'UNPARSED'
    : result.failed > 0 || result.status !== 0
      ? 'FAIL'
      : result.skipped > 0
        ? 'PASS*'
        : 'PASS';
  process.stdout.write(
    `[rc] ${verdict} ${suite.label}: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.ms}ms)\n`,
  );
  if (!parsed) {
    process.stdout.write(`${tail(result.output, 20)}\n`);
  }
  if (result.failed > 0 || result.status !== 0 || !parsed) {
    const details = tail(result.output, 80);
    failures.push({ label: suite.label, status: result.status, details });
    process.stdout.write(`----- ${suite.label} tail -----\n${details}\n----- end -----\n`);
  }
}

const expectedBaseline = process.env.DSH_LONGLIVE_APP_EXE ? '351/0/1' : '349/0/4';
process.stdout.write(`\n[rc] TOTAL ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped\n`);
process.stdout.write(
  `[rc] baseline shape: ${expectedBaseline} for the 0.8.0 suite (B3 adds M40–M42; routerFace v1 extends R1-ID4's allowed seam to the face entry) with this host setting; ` +
    'rc.4 adds test/rc4-regressions.test.mjs (9 cases) and one published-file case (informational)\n',
);

if (failures.length > 0 || totalFailed > 0) {
  for (const failure of failures) {
    process.stdout.write(`[rc] failure: ${failure.label} (exit ${failure.status})\n`);
  }
  process.exitCode = 1;
}
