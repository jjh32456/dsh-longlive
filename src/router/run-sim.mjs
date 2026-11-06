#!/usr/bin/env node
// R1 Router-A — 模拟运行器（双跑 + judge + 证据落盘）。
//
//   node src/router/run-sim.mjs
//   node src/router/run-sim.mjs --real-memory <memory-root> --out src/router/evidence
//
// 做四件事：
//   1. 双跑：同一批 19 条 fixture 连跑两遍；两遍的"结果文件"里不放任何耗时字段，
//      所以逐字节可比（耗时单独写进 timings.json）——这是 VM 报告 §6.3⑥ 的修法。
//   2. judge：每条用例过 J1–J9 + EXTRA + 禁用动作 + level + 置信度，另有负控（故意喂坏数据，
//      证明 judge 真会拒，而不是只会打 PASS）。
//   3. 隔离 J0：DSH_MEM 指向临时沙盒、模拟写入只落沙盒、真实库前后 hash 对比。
//   4. 落盘：evidence/{results-run1.json, results-run2.json, decisions-run1.jsonl,
//      decisions-run2.jsonl, decisions.jsonl, timings.json, isolation.json, SIM-REPORT.md}
//
// 退出码：0 = 19/19 PASS 且两遍一致；1 = 有 FAIL / 不一致；2 = 用法错误。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dshHome } from '../home.js';
import { DEFAULT_MEMORY_DIRNAME } from '../memory/paths.js';

import route, { ERROR_CODES, RULES } from './route.js';
import {
  judgeAuditLines,
  judgeFixture,
  judgeJ0,
  judgePolicy,
  loadDesignHeadings,
  loadDesignSnapshot,
  loadFixtures,
  hashTree,
  fixtureInput,
} from './judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const SNAPSHOT = path.join(HERE, 'design-headings.json');
const RULES_FILE = path.join(HERE, 'routing-rules.json');
// 证据默认落在包外（仓库上一级），避免新增日志进入包树（P6）或被打包。
const DEFAULT_OUT = process.env.R1_EVIDENCE_DIR
  ? path.resolve(process.env.R1_EVIDENCE_DIR)
  : path.resolve(HERE, '../../../r1-evidence');
const DEFAULT_REAL = process.env.R1_REAL_MEMORY || path.join(dshHome(), DEFAULT_MEMORY_DIRNAME);

const OVERRIDE_CASES = [
  {
    caseId: 'OVERRIDE-JUSTIFIED',
    fixture: 'T1',
    override: {
      ruleId: 'R-TOOL-CTX',
      reason: '本次只复述上一轮结论，不构成新决策',
      by: '金嘉恒',
      at: '2026-11-03T02:44:31+08:00',
    },
  },
  {
    caseId: 'OVERRIDE-UNJUSTIFIED',
    fixture: 'T1',
    override: { ruleId: 'R-TOOL-CTX', by: 'tester' },
  },
];

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, realMemory: DEFAULT_REAL, design: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') args.out = path.resolve(argv[++index] || DEFAULT_OUT);
    else if (arg === '--real-memory') args.realMemory = path.resolve(argv[++index] || DEFAULT_REAL);
    else if (arg === '--no-real-memory') args.realMemory = null;
    else if (arg === '--design') args.design = path.resolve(argv[++index]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else args.unknown = arg;
  }
  return args;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadDesign(args) {
  return args.design ? loadDesignHeadings(args.design) : loadDesignSnapshot(SNAPSHOT);
}

// ── 用例 ─────────────────────────────────────────────────────

function runFixtureCase(fixture, design) {
  const input = fixtureInput(fixture);
  const result = route(input);
  const judged = judgeFixture(fixture, result, { repoRoot: REPO_ROOT, design });
  return {
    caseId: fixture.id,
    level: fixture.level,
    status: judged.status,
    matchedRule: result.matchedRule,
    needsHuman: result.needsHuman,
    confidence: result.confidence,
    decisions: result.decisions,
    overrides: result.overrides,
    overrideAudit: result.overrideAudit,
    errors: result.errors,
    judge: judged.checks.map(({ id, ok, code, detail }) => ({ id, ok, code: code || null, detail })),
  };
}

function runOverrideCase(spec, fixtures) {
  const fixture = fixtures.find((item) => item.id === spec.fixture);
  const input = { ...fixtureInput(fixture), caseId: spec.caseId, override: spec.override };
  const result = route(input);
  return {
    caseId: spec.caseId,
    level: 'AUDIT',
    status: result.overrideAudit.rejected > 0 ? 'REJECTED' : 'APPLIED',
    matchedRule: result.matchedRule,
    needsHuman: result.needsHuman,
    confidence: result.confidence,
    decisions: result.decisions,
    overrides: result.overrides,
    overrideAudit: result.overrideAudit,
    errors: result.errors,
    judge: [],
  };
}

// 负控：喂给 judge 的坏数据必须被判 FAIL——否则"19/19 PASS"没有意义。
function negativeControls(fixtures, design) {
  const fixture = fixtures.find((item) => item.id === 'T1');
  const base = route(fixtureInput(fixture));
  const control = (name, judgeName, mutated, expectCode) => {
    const checks = {
      J1: () => judgeFixture(fixture, mutated, { repoRoot: REPO_ROOT, design }),
      J3: () => judgeFixture({ ...fixture, expect: { ...fixture.expect, refusal: true } }, mutated, { repoRoot: REPO_ROOT, design }),
      J6: () => judgeFixture(fixture, mutated, { repoRoot: REPO_ROOT, design }),
      J8: () => judgeFixture(fixture, mutated, { repoRoot: REPO_ROOT, design }),
      J2: () => judgeFixture(fixture, mutated, { repoRoot: REPO_ROOT, design }),
    };
    const judged = checks[judgeName]();
    const codes = judged.errors.map((error) => error.code);
    const caught = judged.status === 'FAIL' && (!expectCode || codes.includes(expectCode));
    return { control: name, judge: judgeName, caught, codes };
  };

  return [
    control('J1 多出一条决定', 'J1', { ...base, decisions: [...base.decisions, { ...base.decisions[0], ruleId: 'R-TOOL-EVIDENCE' }] }, ERROR_CODES.SHAPE),
    control('J2 顺序颠倒', 'J2', { ...base, decisions: [{ ...base.decisions[0], kind: 'memory' }] }, ERROR_CODES.ORDER),
    control('J6 写盘符路径', 'J6', { ...base, decisions: [{ ...base.decisions[0], writeScope: ['Z:\\\\memory'] }] }, ERROR_CODES.SCOPE),
    control('J8 needsHuman 翻转', 'J8', { ...base, needsHuman: true }, ERROR_CODES.HUMAN),
    control('J3 拒绝类却带写入', 'J3', {
      ...base,
      decisions: [{ ...base.decisions[0], kind: 'reply', action: 'guard.refuse', target: 'none', writeScope: ['memory/journal/2026-11.md'] }],
      target: 'none',
      needsHuman: true,
    }, ERROR_CODES.REFUSAL),
  ];
}

// ── 审计行 ───────────────────────────────────────────────────

function caseToAuditLine(item) {
  return {
    caseId: item.caseId,
    level: item.level,
    status: item.status,
    matchedRule: item.matchedRule,
    needsHuman: item.needsHuman,
    decisions: item.decisions,
    overrides: item.overrides,
    overrideAudit: item.overrideAudit,
    errors: item.errors,
  };
}

function buildRun(fixtures, design) {
  const cases = fixtures.map((fixture) => runFixtureCase(fixture, design));
  const overrides = OVERRIDE_CASES.map((spec) => runOverrideCase(spec, fixtures));
  return { cases, overrides };
}

function compareText(textA, textB) {
  return {
    identical: textA === textB,
    sha256: { run1: sha256Text(textA), run2: sha256Text(textB) },
    bytes: { run1: Buffer.byteLength(textA), run2: Buffer.byteLength(textB) },
  };
}

// ── 沙盒 ─────────────────────────────────────────────────────

function prepareSandbox() {
  const sandbox = path.join(os.tmpdir(), 'r1-sim-sandbox');
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, 'memory', 'journal'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'memory', 'handover'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'evidence'), { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, 'memory', 'journal', '2026-11.md'),
    '<!-- sim: 沙盒模拟写入，真实库只读 -->\n- 2026-11-03 15:40 · 金嘉恒 · E1 四问签字（sim）\n<!-- affect: 3 | 签字确认，风险下降 -->\n',
  );
  fs.writeFileSync(
    path.join(sandbox, 'memory', 'handover', '2026-11-03-r1.md'),
    '# R1 交接卡（sim）\n\n- 目标：14 条 fixture 双跑对齐\n- 结论：规则层与 judge 分离\n- 产物：r1-evidence/（包外）\n- 下一步：VM 复跑\n- 坑：别在真实库上跑\n',
  );
  fs.writeFileSync(path.join(sandbox, 'evidence', 'sim-note.txt'), 'isolated run: DSH_MEM=sandbox/memory\n');
  return sandbox;
}

// ── 报告 ─────────────────────────────────────────────────────

function reportMarkdown({ design, policy, runs, comparison, audit, isolation, controls, fixtureHash, rulesHash }) {
  const lines = [];
  lines.push('# R1 SIM REPORT');
  lines.push('');
  lines.push('- 生成器：`src/router/run-sim.mjs`');
  lines.push(`- 规则表：\`src/router/routing-rules.json\`（${RULES.length} 条，sha256 \`${rulesHash.slice(0, 16)}…\`）`);
  lines.push(`- fixture：\`src/router/fixtures\`（${runs.cases.length} 条，sha256 \`${fixtureHash.slice(0, 16)}…\`）`);
  lines.push(`- policy：\`${design.doc}\`${design.snapshot ? '（快照 design-headings.json）' : '（原文）'}，${policy.ok ? `${RULES.length}/${RULES.length} 可解析` : 'FAIL'}`);
  lines.push('');
  lines.push('## 19 条场景');
  lines.push('');
  lines.push('| id | level | status | decisions | ruleId | needsHuman |');
  lines.push('|---|---|---|---|---|---|');
  for (const item of runs.cases) {
    lines.push(`| ${item.caseId} | ${item.level} | ${item.status} | ${item.decisions.length} | ${item.matchedRule || '-'} | ${item.needsHuman} |`);
  }
  lines.push('');
  lines.push('## 双跑一致性');
  lines.push('');
  lines.push('| run | results sha256 | bytes | decisions sha256 |');
  lines.push('|---|---|---|---|');
  lines.push(`| 1 | \`${comparison.sha256.run1}\` | ${comparison.bytes.run1} | \`${audit.run1.sha256}\` |`);
  lines.push(`| 2 | \`${comparison.sha256.run2}\` | ${comparison.bytes.run2} | \`${audit.run2.sha256}\` |`);
  lines.push('');
  lines.push(`结论：${comparison.identical && audit.identical ? '**两遍逐字节一致**（结果文件不含耗时字段；耗时见 timings.json）' : '**两遍不一致，FAIL**'}`);
  lines.push('');
  lines.push('## judge 负控（证明会拒）');
  lines.push('');
  lines.push('| 负控 | judge | 结果 | 失败码 |');
  lines.push('|---|---|---|---|');
  for (const item of controls) {
    lines.push(`| ${item.control} | ${item.judge} | ${item.caught ? 'REJECTED' : 'MISSED'} | ${item.codes.join(', ') || '-'} |`);
  }
  lines.push('');
  lines.push('## 隔离 J0');
  lines.push('');
  lines.push(`- 沙盒：\`${isolation.sandbox}\``);
  lines.push(`- DSH_MEM：\`${isolation.dshMem}\`（在沙盒内：${isolation.dshMemInsideSandbox}）`);
  lines.push(`- 真实库：\`${isolation.realRoot || '(未配置)'}\``);
  if (isolation.ignored && isolation.ignored.length) {
    lines.push(`  - 排除：${isolation.ignored.map((item) => `\`${item}\``).join('、')}（宿主存活心跳，不是被测规则的写入）`);
  }
  if (isolation.before && isolation.after) {
    lines.push(`  - before：${isolation.before.files} files / ${isolation.before.bytes} bytes / \`${isolation.before.sha256}\``);
    lines.push(`  - after ：${isolation.after.files} files / ${isolation.after.bytes} bytes / \`${isolation.after.sha256}\``);
    lines.push(`  - 一致：${isolation.before.sha256 === isolation.after.sha256}`);
  }
  lines.push(`- 沙盒树：${isolation.sandboxTree.files} files / ${isolation.sandboxTree.bytes} bytes / \`${isolation.sandboxTree.sha256.slice(0, 16)}…\``);
  lines.push(`- J0：${isolation.ok ? 'PASS' : 'FAIL'}${isolation.blocked ? '（BLOCKED：未配置真实库，不能证明真实库 hash 不变）' : ''}`);
  for (const error of isolation.errors) lines.push(`  - ${error.code}: ${error.message}`);
  lines.push('');
  lines.push('## override 审计');
  lines.push('');
  for (const item of runs.overrides) {
    lines.push(`- ${item.caseId}：${item.status}，生效 ${item.overrideAudit.applied} 条，被拒 ${item.overrideAudit.rejected} 条${item.errors.length ? `，失败码 ${item.errors.map((error) => error.code).join(', ')}` : ''}`);
    for (const record of item.overrides) {
      lines.push(`  - ${record.ruleId} · 理由「${record.reason}」· ${record.by} · ${record.at}`);
    }
  }
  lines.push(`- decisions.jsonl 审计：${audit.ok ? `PASS（${audit.records} 条 override 记录字段齐全）` : `FAIL（${audit.message}）`}`);
  lines.push('');
  lines.push('## 失败码表');
  lines.push('');
  lines.push('| code | 触发 |');
  lines.push('|---|---|');
  lines.push(`| \`${ERROR_CODES.ISOLATION}\` | 沙盒外写入 / DSH_MEM 越出沙盒 / 真实库 hash 变化 |`);
  lines.push(`| \`${ERROR_CODES.SHAPE}\` | 期望单条却给出多条，或没有决定 |`);
  lines.push(`| \`${ERROR_CODES.ORDER}\` | 多条决定的条数或顺序与期望不符 |`);
  lines.push(`| \`${ERROR_CODES.ACTION}\` | 决定里的 action 不在允许集 |`);
  lines.push(`| \`${ERROR_CODES.REFUSAL}\` | 越界请求没有拒绝，或拒绝时仍带写入 |`);
  lines.push(`| \`${ERROR_CODES.EVIDENCE}\` | 决定缺证据 / 证据不可解析 / 用了 ctx 字段却没留痕 |`);
  lines.push(`| \`${ERROR_CODES.OVERRIDE_UNJUSTIFIED}\` | override 无理由，或理由为空仍想生效 |`);
  lines.push(`| \`${ERROR_CODES.SCOPE}\` | writeScope 越界（盘符/绝对/../~/不在允许前缀） |`);
  lines.push(`| \`${ERROR_CODES.AUDIT}\` | decisions.jsonl 缺 overrides 或记录缺理由/谁/时间戳 |`);
  lines.push(`| \`${ERROR_CODES.HUMAN}\` | needsHuman 与审批类决定不一致，H 级用例未升级 |`);
  lines.push(`| \`${ERROR_CODES.POLICY}\` | policyRef 解析不到标题，或 policyTitle/policyQuote 对不上 |`);
  lines.push(`| \`${ERROR_CODES.LEVEL}\` | level 不在 X/D/H，或与 §5.7 执行矩阵不一致 |`);
  lines.push(`| \`${ERROR_CODES.CONTRACT}\` | 输入/输出/fixture 结构不满足契约 |`);
  lines.push(`| \`${ERROR_CODES.DETERMINISM}\` | 同一输入两次输出不一致 |`);
  lines.push(`| \`${ERROR_CODES.FORBIDDEN}\` | 命中禁用动作 |`);
  lines.push(`| \`${ERROR_CODES.BRIEF}\` | 任务书缺要素（派活类用例） |`);
  lines.push('');
  return lines.join('\n');
}

// ── main ─────────────────────────────────────────────────────
//
// 事务标记：开跑先写 <out>/.run-sim.lock（pid / 开始时间 / 目标目录 / 真实库），
// 成功（SIM-REPORT.md 已落盘）才删锁；崩溃、异常或判定失败都保留锁，并把 state:'failed'
// 与 exitCode 写进锁。下游只认这把锁：锁在 = 这次 run-sim 没有善终，不许用「没有
// SIM-REPORT.md」这种间接证据推断失败。

const LOCK_NAME = '.run-sim.lock';

function writeLock(outDir, lock) {
  const file = path.join(outDir, LOCK_NAME);
  fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return file;
}

function markLockFailed(outDir, lock, error) {
  const failed = {
    ...lock,
    state: 'failed',
    exitCode: 1,
    failedAt: new Date().toISOString(),
    error: error && error.message ? error.message : String(error || 'run-sim failed'),
  };
  try {
    writeLock(outDir, failed);
  } catch (writeError) {
    // 锁都更新不了时，旧的 running 锁仍在盘上（存在即失败）；原因写到 stderr。
    process.stderr.write(`run-sim 失败但锁文件更新失败：${writeError.message}\n`);
  }
}

export function main(argv = process.argv.slice(2), io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }) {
  const args = parseArgs(argv);
  if (args.help) {
    io.out('node src/router/run-sim.mjs [--out <dir>] [--real-memory <dir>] [--no-real-memory] [--json]\n');
    return 0;
  }
  const outDir = args.out;
  fs.mkdirSync(outDir, { recursive: true });
  const lock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    target: path.resolve(outDir),
    realMemory: args.realMemory || null,
    node: process.version,
    state: 'running',
  };
  const lockFile = writeLock(outDir, lock);
  let code;
  try {
    code = simulate(args, io);
  } catch (error) {
    markLockFailed(outDir, lock, error);
    throw error;
  }
  if (code !== 0) {
    markLockFailed(outDir, lock, new Error('run-sim 判定失败（详见 stdout 的 summary.failed）'));
    return code;
  }
  // 成功路径：SIM-REPORT.md 已经在 simulate() 里写完，锁是最后一步。删锁后下游才认这次通过。
  fs.rmSync(lockFile, { force: true });
  return 0;
}

function simulate(args, io) {
  const design = loadDesign(args);
  const loaded = loadFixtures(FIXTURES_DIR);
  if (loaded.errors.length) {
    io.err(`${JSON.stringify(loaded.errors, null, 2)}\n`);
    return 1;
  }
  const fixtures = loaded.fixtures;

  const outDir = args.out;
  fs.mkdirSync(outDir, { recursive: true });

  const sandbox = prepareSandbox();
  const sandboxTree = hashTree(sandbox);

  const realRoot = args.realMemory && fs.existsSync(args.realMemory) ? args.realMemory : null;
  // 宿主的存活心跳（.longlive/live/）由宿主自己写，不是被测规则的写入，hash 时排除。
  const realIgnore = ['.longlive/live'];
  const realBefore = realRoot ? hashTree(realRoot, { ignore: realIgnore }) : null;

  const startedAt = process.hrtime.bigint();
  const run1 = buildRun(fixtures, design);
  const run1End = process.hrtime.bigint();
  const run2 = buildRun(fixtures, design);
  const run2End = process.hrtime.bigint();

  const realAfter = realRoot ? hashTree(realRoot, { ignore: realIgnore }) : null;

  const auditLines1 = buildRunAuditLines(run1);
  const auditLines2 = buildRunAuditLines(run2);
  const audit1 = judgeAuditLines(auditLines1);
  const audit2 = judgeAuditLines(auditLines2);
  const decisionsText1 = auditLines1.map((line) => JSON.stringify(line)).join('\n');
  const decisionsText2 = auditLines2.map((line) => JSON.stringify(line)).join('\n');
  const decisionsIdentical = decisionsText1 === decisionsText2;

  const policy = judgePolicy(RULES, design);
  const controls = negativeControls(fixtures, design);

  const isolation = judgeJ0({
    sandbox,
    realRoot,
    before: realBefore,
    after: realAfter,
    env: { DSH_MEM: path.join(sandbox, 'memory') },
    sandboxTree,
    expectedArtifacts: ['memory/', 'evidence/'],
  });

  const fixtureHash = hashTree(FIXTURES_DIR).sha256;
  const rulesHash = sha256File(RULES_FILE);

  const resultsPayload = {
    design: { doc: design.doc, snapshot: Boolean(design.snapshot), sourceSha256: design.sourceSha256 || null },
    rules: { count: RULES.length, sha256: rulesHash },
    fixtures: { count: fixtures.length, sha256: fixtureHash },
    cases: run1.cases,
    overrideCases: run1.overrides,
    negativeControls: controls,
  };
  const resultsPayload2 = {
    design: { doc: design.doc, snapshot: Boolean(design.snapshot), sourceSha256: design.sourceSha256 || null },
    rules: { count: RULES.length, sha256: rulesHash },
    fixtures: { count: fixtures.length, sha256: fixtureHash },
    cases: run2.cases,
    overrideCases: run2.overrides,
    negativeControls: negativeControls(fixtures, design),
  };
  const results1 = `${JSON.stringify(resultsPayload, null, 2)}\n`;
  const results2 = `${JSON.stringify(resultsPayload2, null, 2)}\n`;
  const comparison = compareText(results1, results2);

  fs.writeFileSync(path.join(outDir, 'results-run1.json'), results1);
  fs.writeFileSync(path.join(outDir, 'results-run2.json'), results2);
  fs.writeFileSync(path.join(outDir, 'decisions-run1.jsonl'), auditLines1.map((line) => JSON.stringify(line)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'decisions-run2.jsonl'), auditLines2.map((line) => JSON.stringify(line)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'decisions.jsonl'), auditLines1.map((line) => JSON.stringify(line)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'timings.json'), `${JSON.stringify({
    run1Ms: Number((run1End - startedAt) / 1000000n),
    run2Ms: Number((run2End - run1End) / 1000000n),
    realMemoryHashMs: null,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'isolation.json'), `${JSON.stringify({
    sandbox,
    dshMem: path.join(sandbox, 'memory'),
    realRoot,
    before: realBefore,
    after: realAfter,
    sandboxTree,
    ok: isolation.ok,
    blocked: isolation.blocked,
    errors: isolation.errors,
  }, null, 2)}\n`);

  const report = reportMarkdown({
    design,
    policy,
    runs: run1,
    comparison,
    audit: {
      ok: audit1.ok && audit2.ok,
      records: audit1.ok ? audit1.records.length : 0,
      message: audit1.ok ? '' : audit1.message,
      identical: decisionsIdentical,
      run1: { sha256: sha256Text(decisionsText1) },
      run2: { sha256: sha256Text(decisionsText2) },
    },
    isolation: {
      ...isolation,
      sandbox,
      realRoot,
      dshMem: path.join(sandbox, 'memory'),
      dshMemInsideSandbox: true,
      ignored: realIgnore,
    },
    controls,
    fixtureHash,
    rulesHash,
  });
  fs.writeFileSync(path.join(outDir, 'SIM-REPORT.md'), report);

  const fixturesPassed = run1.cases.filter((item) => item.status === 'PASS').length;
  const failed = [];
  if (fixturesPassed !== fixtures.length) failed.push(`fixtures ${fixturesPassed}/${fixtures.length}`);
  if (!comparison.identical) failed.push('两遍结果不一致');
  if (!audit1.ok || !audit2.ok) failed.push(`审计失败：${audit1.message || audit2.message}`);
  if (!decisionsIdentical) failed.push('两遍 decisions 不一致');
  if (!policy.ok) failed.push(`policy 解析失败 ${policy.errors.length} 条`);
  if (!isolation.ok) failed.push('J0 隔离失败');
  if (controls.some((item) => !item.caught)) failed.push('judge 负控未拒');

  const summary = {
    ok: failed.length === 0,
    fixtures: `${fixturesPassed}/${fixtures.length} PASS`,
    doubleRun: comparison.identical ? 'byte-identical' : 'MISMATCH',
    resultsSha256: comparison.sha256.run1,
    decisionsSha256: sha256Text(decisionsText1),
    isolation: isolation.ok ? (isolation.blocked ? 'PASS(blocked: no real library)' : 'PASS') : 'FAIL',
    policy: policy.ok ? `${RULES.length}/${RULES.length}` : 'FAIL',
    negativeControls: `${controls.filter((item) => item.caught).length}/${controls.length}`,
    outDir,
    failed,
  };
  io.out(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.ok ? 0 : 1;
}

function buildRunAuditLines(run) {
  return [...run.cases, ...run.overrides].map(caseToAuditLine);
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`run-sim 崩了：${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}
