#!/usr/bin/env node
// R1 Router-A — 命令行入口（只读）。
//
//   node src/router/router.mjs --check
//       规则表 schema → policyRef 锚点 → fixtures 19 条 → 契约/确定性自检
//       全过 exit 0；有 FAIL exit 1。
//   node src/router/router.mjs --check --design <design-doc>
//       用设计文档原文核对 policy 锚点（默认用 design-headings.json 快照，离线可用）。
//   node src/router/router.mjs --explain "现在上下文多少？还能撑多久？" --ctx tokens=82192,zone=green
//       走一次 route()，把每条决定的 kind/action/ruleId/evidence/writeScope 打出来。
//   node src/router/router.mjs --explain --fixture T1
//   node src/router/router.mjs --list
//   node src/router/router.mjs --help
//
// 这个入口不写盘、不执行决定，只解释"会怎么走"。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ERROR_CODES,
  LEVELS,
  POLICY,
  RULES,
  canonicalAction,
  legacyAction,
  route,
  runtimeFor,
} from './route.js';
import { configuredPolicyProfileName } from '../policy-profile.js';
import {
  FIXTURE_IDS,
  LEVEL_MATRIX,
  fixtureInput,
  judgeFixture,
  judgeJ1,
  judgeJ2,
  judgeJ3,
  judgeJ4,
  judgeJ5,
  judgeJ6,
  judgeJ7,
  judgeJ8,
  judgeJ9,
  judgePolicy,
  loadDesignHeadings,
  loadDesignSnapshot,
  loadFixtures,
  validateWriteScope,
} from './judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const SNAPSHOT = path.join(HERE, 'design-headings.json');

const USAGE = `R1 Router-A — 规则层命令行

用法：
  router.mjs --check [--json] [--design <R1-DESIGN.md>] [--profile <name>]
  router.mjs --explain "<utterance>" [--kind tool|memory|session] [--ctx tokens=1,zone=red,activeWorkers=0,openRows=2] [--profile <name>] [--json]
  router.mjs --explain --fixture T1 [--profile <name>] [--json]
  router.mjs --list [--json] [--profile <name>]
  router.mjs --help

策略：默认 profile=generic；--profile owner-rulings-2026-11-03 可加载家规叠加层（只许收窄）。
`;

function parseArgs(argv) {
  const args = { _: [], check: false, explain: false, list: false, help: false, json: false, design: null, fixture: null, kind: null, ctx: {}, profile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') args.check = true;
    else if (arg === '--explain') args.explain = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--design') args.design = argv[++index] || null;
    else if (arg === '--profile') args.profile = argv[++index] || null;
    else if (arg === '--fixture') args.fixture = argv[++index] || null;
    else if (arg === '--kind') args.kind = argv[++index] || null;
    else if (arg === '--ctx') {
      const value = argv[++index] || '';
      for (const pair of value.split(',')) {
        const [key, raw] = pair.split('=');
        if (!key || raw === undefined) continue;
        if (key === 'zone') args.ctx.zone = raw;
        else if (['tokens', 'activeWorkers', 'openRows'].includes(key)) args.ctx[key] = Number(raw);
      }
    } else if (arg.startsWith('--')) {
      args._.push(arg);
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function loadDesign(options) {
  if (options.design) return loadDesignHeadings(path.resolve(options.design));
  return loadDesignSnapshot(SNAPSHOT);
}

function checkRules(rules, policy = POLICY) {
  const errors = [];
  if (rules.length < 14) errors.push(`规则数 ${rules.length} < 14`);
  const ids = new Set();
  let previous = Infinity;
  for (const rule of rules) {
    if (ids.has(rule.id)) errors.push(`重复 ruleId ${rule.id}`);
    ids.add(rule.id);
    if (!LEVELS.includes(rule.level)) errors.push(`${rule.id}: level ${rule.level} 不在 X/D/H`);
    if (!Number.isFinite(rule.priority)) errors.push(`${rule.id}: priority 非有限数`);
    if (rule.priority > previous) errors.push(`${rule.id}: 规则表没有按 priority 降序`);
    previous = rule.priority;
    if (!rule.reason.trim()) errors.push(`${rule.id}: 缺 reason`);
    if (!rule.policyRef) errors.push(`${rule.id}: 缺 policyRef`);
    if (!rule.line) errors.push(`${rule.id}: 定位不到规则表行号（evidence 会失效）`);
    if (canonicalAction(rule.decision.action) !== rule.decision.action) {
      errors.push(`${rule.id}: decision.action ${rule.decision.action} 不是 canonical`);
    }
    if (rule.decision.action && !legacyAction(rule.decision.action)) {
      errors.push(`${rule.id}: ${rule.decision.action} 在 aliases.json 里没有 legacy 名`);
    }
    for (const scope of rule.decision.writeScope) {
      const problems = validateWriteScope([scope], policy);
      if (problems.length) errors.push(`${rule.id}: writeScope ${scope}（${problems.join(';')}）`);
    }
    for (const template of [rule.decision, ...rule.before, ...rule.after]) {
      if (!LEVELS.includes(rule.level)) errors.push(`${rule.id}: 模板 level 非法`);
      if (!ERROR_CODES) errors.push('ERROR_CODES 未加载');
      if (!template || typeof template !== 'object') errors.push(`${rule.id}: 模板为空`);
    }
  }
  return errors;
}

function checkContract(profile) {
  const notes = [];
  const fail = (code, message) => notes.push(`${code} ${message}`);
  const sampleInput = {
    caseId: 'CONTRACT-1',
    turn: 1,
    utterance: '现在上下文多少？还能撑多久？',
    ctx: { tokens: 82192, zone: 'green', activeWorkers: 0, openRows: 1 },
  };
  const sample = route(sampleInput, { profile });
  if (!Array.isArray(sample.decisions) || !sample.decisions.length) fail(ERROR_CODES.CONTRACT, 'decisions 不是非空数组');
  if (!sample.decisions.every((decision) => decision.ruleId && Array.isArray(decision.evidence) && Array.isArray(decision.writeScope))) {
    fail(ERROR_CODES.CONTRACT, '决定缺 ruleId/evidence/writeScope');
  }
  if (sample.decision.target !== sample.target || sample.decision.tool !== sample.tool) {
    fail(ERROR_CODES.CONTRACT, '兼容别名 decision 与 target/tool 不一致');
  }
  if (sample.target !== 'live') fail(ERROR_CODES.CONTRACT, `契约样例 target=${sample.target}，应为 live`);
  const again = route(sampleInput, { profile });
  if (JSON.stringify(sample) !== JSON.stringify(again)) fail(ERROR_CODES.DETERMINISM, '同一输入两次输出不一致');

  let bomb;
  try {
    bomb = route({ get utterance() { throw new Error('boom'); } }, { profile });
  } catch (error) {
    fail(ERROR_CODES.CONTRACT, `getter 炸弹抛出：${error.message}`);
  }
  if (bomb && bomb.target !== 'none') fail(ERROR_CODES.CONTRACT, 'getter 炸弹没有退化为 none');

  const unjustified = route({
    caseId: 'CONTRACT-2',
    utterance: '现在上下文多少？',
    override: { ruleId: 'R-TOOL-CTX' },
  }, { profile });
  if (!(unjustified.overrideAudit && unjustified.overrideAudit.rejected === 1)) {
    fail(ERROR_CODES.CONTRACT, '无理由 override 没有被拒');
  }
  if (!unjustified.errors.some((error) => error.code === ERROR_CODES.OVERRIDE_UNJUSTIFIED)) {
    fail(ERROR_CODES.CONTRACT, '无理由 override 没有记 E_ROUTE_OVERRIDE_UNJUSTIFIED');
  }
  if (unjustified.overrides.length !== 0) fail(ERROR_CODES.CONTRACT, '无理由 override 被当成生效');
  const justified = route({
    caseId: 'CONTRACT-3',
    utterance: '现在上下文多少？',
    override: { ruleId: 'R-TOOL-CTX', reason: '样例：这次只复述', by: 'tester', at: '2026-11-03T02:44:31+08:00' },
  }, { profile });
  if (justified.overrides.length !== 1) fail(ERROR_CODES.CONTRACT, '有理由 override 没有留痕');
  return notes;
}

// ── judge 自检：判官被短路时 --check 必须红 ─────────────────
// 每条都是「已知坏输入」，对应的 judge 必须判红。若有人把某个 judge 改成 return {ok:true}
// （F23 型回归），这里立刻从红变绿 → report.ok=false → exit 1。自检只喂坏输入，不依赖仓库规则表。
//
// 用例总数用硬编码常量锚定，不再用 cases.length 自己给自己打分：删掉任意一条（哪怕剩下的
// 仍然全红），条数对不上锚点 → --check 直接红。覆盖的 judge 编号也逐个点名（J1–J8），
// 少一个就红。修复前这里只有 5 条 judgeJ6 用例、没有绝对锚点，删到 4 条仍 exit 0
// （R1 独立复验 §4.3，2026-11-03 修复）。
export const JUDGE_SELFCHECK_CASE_COUNT = 13;
// J6（writeScope）原有五条 scope 坏输入是这份自检的起点：即使将来总条数调整，
// 这五条也不许被替换成更弱的用例，所以单独锚一个 5。
export const JUDGE_SELFCHECK_J6_CASE_COUNT = 5;
export const JUDGE_SELFCHECK_REQUIRED_JUDGES = Object.freeze(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9']);

function checkJudgeSelfCheck() {
  const decision = (patch) => ({
    kind: 'memory',
    action: 'engram.save',
    target: 'engram',
    ruleId: 'R-JUDGE-SELFCHECK',
    evidence: ['selfcheck:bad-input'],
    writeScope: [],
    needsHuman: false,
    confidence: 1,
    ...patch,
  });
  const fixture = (patch) => ({ id: 'JUDGE-SELFCHECK', level: 'X', kind: 'memory', utterance: 'selfcheck', ctx: {}, expect: {}, ...patch });
  // J5 的坏输入：注入一个永远不承认 override 被拒的 route() 替身；judgeJ5 若被短路就会放行。
  const brokenRoute = () => ({
    decisions: [],
    overrides: [],
    overrideAudit: { applied: 0, rejected: 0, records: [] },
    needsHuman: false,
    errors: [],
    matchedRule: 'R-TOOL-CTX',
  });
  const cases = [
    {
      judge: 'J1',
      name: '单条形状：零决定',
      fixture: fixture({}),
      result: { decisions: [], needsHuman: false, errors: [] },
    },
    {
      judge: 'J2',
      name: 'action 不在规则表允许集',
      fixture: fixture({}),
      result: { decisions: [decision({ action: 'delete.everything' })], needsHuman: false, errors: [] },
    },
    {
      judge: 'J3',
      name: '拒绝用例返回可写记忆决定',
      fixture: fixture({ expect: { refusal: true } }),
      result: { decisions: [decision({ kind: 'memory', action: 'engram.save', target: 'engram' })], needsHuman: true, errors: [] },
    },
    {
      judge: 'J4',
      name: '决定的 evidence 为空',
      fixture: fixture({}),
      result: { decisions: [decision({ evidence: [] })], needsHuman: false, errors: [] },
    },
    {
      judge: 'J5',
      name: 'override 拒绝审计被清空',
      fixture: fixture({}),
      result: { decisions: [decision({})], overrides: [], overrideAudit: { applied: 0, rejected: 0, records: [] }, needsHuman: false, errors: [] },
      opts: { route: brokenRoute },
    },
    {
      judge: 'J6',
      name: 'writeScope 盘符路径',
      fixture: fixture({}),
      result: { decisions: [decision({ writeScope: ['Z:\\memory\\journal\\'] })], needsHuman: false, errors: [] },
    },
    {
      judge: 'J6',
      name: 'writeScope 父目录跳转',
      fixture: fixture({}),
      result: { decisions: [decision({ writeScope: ['../../etc/cron.d/x'] })], needsHuman: false, errors: [] },
    },
    {
      judge: 'J6',
      name: 'writeScope 绝对路径',
      fixture: fixture({}),
      result: { decisions: [decision({ writeScope: ['/etc/passwd'] })], needsHuman: false, errors: [] },
    },
    {
      judge: 'J6',
      name: '空判定漏掉必须声明的写入',
      fixture: fixture({ expect: { writeScope: ['memory/journal/2026-11.md'] } }),
      result: { decisions: [], needsHuman: false, errors: [] },
    },
    {
      judge: 'J6',
      name: '拒绝决定偷偷声明真实写入',
      fixture: fixture({ expect: { refusal: true, writeScope: [] } }),
      result: {
        decisions: [decision({ kind: 'reply', action: 'guard.refuse', target: 'none', writeScope: ['memory/secret.md'] })],
        needsHuman: true,
        errors: [],
      },
    },
    {
      judge: 'J7',
      name: 'overrideAudit 缺失',
      fixture: fixture({}),
      result: { decisions: [decision({})], overrides: [], needsHuman: false, errors: [] },
    },
    {
      judge: 'J8',
      name: '应让人点头却 needsHuman=false',
      fixture: fixture({ expect: { needsHuman: true } }),
      result: { decisions: [decision({ kind: 'reply', action: 'guard.refuse', target: 'none' })], needsHuman: false, errors: [] },
    },
    {
      judge: 'J9',
      name: '用户单方面「我同意」被当放行',
      fixture: fixture({ expect: { consent: { holder: 'assistant', required: true, satisfied: false } } }),
      result: {
        decisions: [decision({
          kind: 'reply',
          action: 'engram.profile.edit',
          target: 'engram',
          args: { consent: { holder: 'user', satisfied: true, at: '2026-11-03T10:00:00+08:00', quote: '我同意改' } },
        })],
        needsHuman: false,
        errors: [],
      },
    },
  ];
  const runners = {
    J1: (item) => judgeJ1(item.fixture, item.result),
    J2: (item) => judgeJ2(item.fixture, item.result),
    J3: (item) => judgeJ3(item.fixture, item.result),
    J4: (item) => judgeJ4(item.fixture, item.result, { repoRoot: HERE }),
    J5: (item) => judgeJ5(item.fixture, item.result, item.opts),
    J6: (item) => judgeJ6(item.fixture, item.result),
    J7: (item) => judgeJ7(item.fixture, item.result),
    J8: (item) => judgeJ8(item.fixture, item.result),
    J9: (item) => judgeJ9(item.fixture, item.result),
  };
  const errors = [];
  // 绝对锚点一：条数。删掉任意一条用例都会让这里报错，不依赖剩下的用例是否仍然全红。
  if (cases.length !== JUDGE_SELFCHECK_CASE_COUNT) {
    errors.push(`${ERROR_CODES.CONTRACT} judge 自检用例数 ${cases.length} != 锚点 ${JUDGE_SELFCHECK_CASE_COUNT}（删/加用例必须同步改锚点，不允许自证）`);
  }
  // 绝对锚点二：J6 子集。原有五条 scope 坏输入不允许被替换或删减。
  const j6 = cases.filter((item) => item.judge === 'J6').length;
  if (j6 !== JUDGE_SELFCHECK_J6_CASE_COUNT) {
    errors.push(`${ERROR_CODES.CONTRACT} judge 自检 J6 用例数 ${j6} != 锚点 ${JUDGE_SELFCHECK_J6_CASE_COUNT}（原有五条 scope 用例不允许被替换）`);
  }
  // 绝对锚点三：覆盖编号。J1–J8 每个都必须至少有一条坏输入。
  const covered = new Set(cases.map((item) => item.judge));
  for (const judge of JUDGE_SELFCHECK_REQUIRED_JUDGES) {
    if (!covered.has(judge)) {
      errors.push(`${ERROR_CODES.CONTRACT} judge 自检没有覆盖 ${judge}（短路该 judge 不会被 --check 抓住）`);
    }
  }
  let red = 0;
  for (const item of cases) {
    const run = runners[item.judge];
    let verdict;
    try {
      if (!run) throw new Error(`没有 ${item.judge} 的自检执行器`);
      verdict = run(item);
    } catch (error) {
      errors.push(`${ERROR_CODES.CONTRACT} judge 自检「${item.judge} ${item.name}」抛出：${error.message}`);
      continue;
    }
    if (verdict && verdict.ok === false) {
      red += 1;
    } else {
      errors.push(`${ERROR_CODES.CONTRACT} judge 自检「${item.judge} ${item.name}」：已知坏输入被判为通过（judge 可能被短路）`);
    }
  }
  const total = cases.length;
  const ok = total === JUDGE_SELFCHECK_CASE_COUNT
    && j6 === JUDGE_SELFCHECK_J6_CASE_COUNT
    && JUDGE_SELFCHECK_REQUIRED_JUDGES.every((judge) => covered.has(judge))
    && red === total
    && errors.length === 0;
  return { total, expected: JUDGE_SELFCHECK_CASE_COUNT, j6, j6Expected: JUDGE_SELFCHECK_J6_CASE_COUNT, red, coverage: [...covered].sort(), ok, errors };
}

export function runCheck(options = {}) {
  const design = options.design ? loadDesignHeadings(path.resolve(options.design)) : loadDesignSnapshot(SNAPSHOT);
  const profileName = options.profile || configuredPolicyProfileName();
  const runtime = runtimeFor(profileName);
  const rules = runtime.rules || [];
  const policy = runtime.policy || POLICY;
  const report = { profile: { name: profileName, rules: rules.length }, rules: [], policy: null, fixtures: [], contract: [], errors: [] };

  if (runtime.errors.length) {
    report.errors.push(...runtime.errors.map((error) => ({ area: 'profile', message: `${error.code} ${error.message}` })));
  }

  const ruleErrors = checkRules(rules, policy);
  report.rules = rules.map((rule) => ({ id: rule.id, priority: rule.priority, level: rule.level, action: rule.decision.action }));
  report.errors.push(...ruleErrors.map((message) => ({ area: 'rules', message })));

  const policyReport = judgePolicy(rules, design);
  report.policy = { ok: policyReport.ok, errors: policyReport.errors, doc: design.doc, snapshot: Boolean(design.snapshot) };
  report.errors.push(...policyReport.errors.map((error) => ({ area: 'policy', message: error.message })));

  const loaded = loadFixtures(FIXTURES_DIR);
  report.errors.push(...loaded.errors.map((error) => ({ area: 'fixtures', message: error.message })));
  const ids = loaded.fixtures.map((fixture) => fixture.id).sort();
  if (ids.join(',') !== FIXTURE_IDS.slice().sort().join(',')) {
    report.errors.push({ area: 'fixtures', message: `fixture id 不是 ${FIXTURE_IDS.length} 条全集：${ids.join(',')}` });
  }
  for (const fixture of loaded.fixtures) {
    const result = route(fixtureInput(fixture), { profile: profileName });
    const judged = judgeFixture(fixture, result, {
      repoRoot: REPO_ROOT,
      design,
      policy,
      route: (next) => route(next, { profile: profileName }),
    });
    report.fixtures.push({ id: fixture.id, level: fixture.level, status: judged.status, decisions: result.decisions.length, errors: judged.errors });
    for (const error of judged.errors) {
      report.errors.push({ area: 'judge', message: `${fixture.id}: ${error.code} ${error.message}` });
    }
  }

  report.contract = checkContract(profileName);
  report.errors.push(...report.contract.map((message) => ({ area: 'contract', message })));

  // 判官自检：对已知坏输入跑 judge，必须全红。判官被短路时这里变绿 → --check 变红。
  const judgeSelfCheck = checkJudgeSelfCheck();
  report.judgeSelfCheck = judgeSelfCheck;
  report.errors.push(...judgeSelfCheck.errors.map((message) => ({ area: 'judge-selfcheck', message })));

  const passed = report.fixtures.filter((item) => item.status === 'PASS').length;
  report.ok = report.errors.length === 0;
  report.summary = `${passed}/${report.fixtures.length} fixtures PASS · policy ${policyReport.ok ? 'ok' : 'FAIL'} · rules ${rules.length} · contract ${report.contract.length === 0 ? 'ok' : 'FAIL'} · judge-selfcheck ${judgeSelfCheck.red}/${judgeSelfCheck.total} red · anchor ${judgeSelfCheck.expected} · profile ${profileName}`;
  return report;
}

export function explain(input, options = {}) {
  return route(input, options);
}

function printReport(report) {
  process.stdout.write(`R1 CHECK — ${report.summary}\n`);
  process.stdout.write(`policy: ${report.policy.doc}${report.policy.snapshot ? '（快照）' : '（原文）'} ${report.policy.ok ? 'ok' : 'FAIL'}\n\n`);
  process.stdout.write('  id   level  status  decisions\n');
  for (const item of report.fixtures) {
    process.stdout.write(`  ${item.id.padEnd(4)} ${item.level.padEnd(6)} ${item.status.padEnd(7)} ${item.decisions}\n`);
  }
  if (report.errors.length) {
    process.stdout.write(`\nFAIL ${report.errors.length}:\n`);
    for (const error of report.errors) process.stdout.write(`  [${error.area}] ${error.message}\n`);
  } else {
    process.stdout.write('\nALL PASS\n');
  }
}

function printExplain(result) {
  process.stdout.write(`caseId=${result.caseId === null ? '-' : result.caseId} turn=${result.turn === null ? '-' : result.turn}\n`);
  process.stdout.write(`matchedRule=${result.matchedRule || '-'} level=${result.level || '-'} confidence=${result.confidence} needsHuman=${result.needsHuman}\n`);
  if (!result.decisions.length) {
    process.stdout.write('decisions: （无匹配，target=none）\n');
  }
  result.decisions.forEach((decision, index) => {
    process.stdout.write(`\n${index + 1}. [${decision.kind}] ${decision.action}  ← ${decision.ruleId} (confidence ${decision.confidence})\n`);
    process.stdout.write(`   args: ${JSON.stringify(decision.args)}\n`);
    if (decision.writeScope.length) process.stdout.write(`   writeScope: ${decision.writeScope.join(', ')}\n`);
    for (const entry of decision.evidence) process.stdout.write(`   evidence: ${entry}\n`);
    if (decision.overridden) process.stdout.write(`   overridden: ${JSON.stringify(decision.overridden)}\n`);
  });
  if (result.overrides.length) process.stdout.write(`\noverrides: ${JSON.stringify(result.overrides)}\n`);
  if (result.errors.length) process.stdout.write(`errors: ${JSON.stringify(result.errors)}\n`);
  process.stdout.write(`\n兼容别名 decision=${JSON.stringify(result.decision)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || (!args.check && !args.explain && !args.list)) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.check) {
    const report = runCheck({ design: args.design, profile: args.profile });
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printReport(report);
    return report.ok ? 0 : 1;
  }
  if (args.list) {
    const profileName = args.profile || configuredPolicyProfileName();
    const rules = runtimeFor(profileName).rules || [];
    const rows = rules.map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      level: rule.level,
      kind: rule.decision.kind,
      action: rule.decision.action,
      policyRef: rule.policyRef,
      line: rule.line,
    }));
    if (args.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else {
      for (const row of rows) process.stdout.write(`${row.id.padEnd(16)} ${String(row.priority).padStart(3)} ${row.level}  ${row.action.padEnd(22)} ${row.policyRef}\n`);
    }
    return 0;
  }
  if (args.explain) {
    let input = null;
    if (args.fixture) {
      const loaded = loadFixtures(FIXTURES_DIR);
      const fixture = loaded.fixtures.find((item) => item.id === args.fixture.toUpperCase());
      if (!fixture) {
        process.stderr.write(`没有 fixture ${args.fixture}\n`);
        return 2;
      }
      input = fixtureInput(fixture);
    } else if (args._.length) {
      input = { caseId: 'EXPLAIN', utterance: args._.join(' '), ctx: args.ctx };
      if (args.kind) input.kind = args.kind;
    } else {
      process.stderr.write('--explain 需要一句话或 --fixture <id>\n');
      return 2;
    }
    const result = explain(input, { profile: args.profile });
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printExplain(result);
    return 0;
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`router.mjs 崩了：${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

export { REPO_ROOT };
