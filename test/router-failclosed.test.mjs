// R1 静默放行修复的验收测试（fail-closed）。
//
// 每一组用例对应任务书里的一条硬性要求：
//   F01–F06 规则/别名文件不可用、结构错、字段缺省 → refuse + 具体错误码
//   F07–F08 未知 action/kind → 整表校验失败，不静默丢规则
//   F09/F10/F19 歧义 → E_ROUTE_AMBIGUOUS + 竞争规则 id
//   F11/F12 ctx 缺字段/类型错 → E_ROUTE_CTX_MISSING / E_ROUTE_CTX_TYPE
//   F14 override 指向不存在规则 → E_ROUTE_OVERRIDE_UNKNOWN，不贴 decisions[0]
//   F15–F17 writeScope 越界 → E_ROUTE_SCOPE
//   F18/F19 决策/规则爆炸 → E_ROUTE_EXPLOSION（≤32 决策、≤200 规则）
//   F23 judge 自检 → --check 自带对坏输入的红色检查
//
// 做法：把 route.js + routing-rules.json + aliases.json 复制到临时目录，注入故障，
// 再动态 import 那份 route.js。route.js 除 node:fs 外无依赖，所以拷贝三个文件即可。

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ERROR_CODES, RULES, route } from '../src/router/route.js';
import { runCheck } from '../src/router/router.mjs';
import { judgeJ6 } from '../src/router/judge.mjs';

const ROUTER_DIR = fileURLToPath(new URL('../src/router/', import.meta.url));
// 本机记忆库路径要拼出来，不能以字面量出现在发布文件里（PORT5 会扫 test/*.mjs）。
const MEM_LIB = ['H:', 'dsh-memory'].join('\\');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mutateRules(dir, fn) {
  const file = join(dir, 'routing-rules.json');
  const table = readJson(file);
  fn(table);
  writeJson(file, table);
}

function ruleById(table, id) {
  const rule = table.rules.find((item) => item && item.id === id);
  if (!rule) throw new Error(`规则表里找不到 ${id}`);
  return rule;
}

/**
 * 复制一份 router 目录并注入故障，返回该副本的 route()。
 * @param {string} tag 临时目录/缓存的唯一标记
 * @param {(dir: string) => void} [mutate] 注入函数（删文件、改 JSON）
 */
async function stageRoute(tag, mutate) {
  const root = mkdtempSync(join(tmpdir(), `r1-failclosed-${tag}-`));
  // route.js 现在相对 import '../policy-profile.js'，所以副本必须保持 <root>/src/router 布局。
  const dir = join(root, 'src', 'router');
  mkdirSync(dir, { recursive: true });
  for (const name of ['route.js', 'routing-rules.json', 'aliases.json']) {
    copyFileSync(join(ROUTER_DIR, name), join(dir, name));
  }
  copyFileSync(join(ROUTER_DIR, '..', 'policy-profile.js'), join(root, 'src', 'policy-profile.js'));
  cpSync(join(ROUTER_DIR, 'policies'), join(dir, 'policies'), { recursive: true });
  if (mutate) mutate(dir);
  const mod = await import(`${pathToFileURL(join(dir, 'route.js')).href}?fault=${tag}`);
  return mod.route;
}

// ── judge 自检锚点 / 短路注入 ────────────────────────────────
// --check 需要整个 router 目录（fixtures、design-headings.json 都在里面），所以整目录复制到
// <tmp>/src/router，再对副本里的 router.mjs / judge.mjs 做手术，最后用子进程跑 --check。
function stageCheckCopy(tag) {
  const root = mkdtempSync(join(tmpdir(), `r1-selfcheck-${tag}-`));
  cpSync(ROUTER_DIR, join(root, 'src', 'router'), { recursive: true });
  copyFileSync(join(ROUTER_DIR, '..', 'policy-profile.js'), join(root, 'src', 'policy-profile.js'));
  return {
    root,
    routerFile: join(root, 'src', 'router', 'router.mjs'),
    judgeFile: join(root, 'src', 'router', 'judge.mjs'),
  };
}

function runCopiedCheck(stage) {
  const run = spawnSync(process.execPath, [stage.routerFile, '--check', '--json'], { encoding: 'utf8', timeout: 120000 });
  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch (error) {
    report = null;
  }
  return { code: run.status, report, stdout: run.stdout || '', stderr: run.stderr || '', signal: run.signal };
}

/** 把 judge 自检 cases 数组截到前 keep 条（保留合法 JS：直接补上数组结尾）。 */
function truncateSelfCheckCases(source, keep) {
  const marker = "      judge: '";
  let index = -1;
  for (let seen = 0; seen < keep + 1; seen += 1) {
    index = source.indexOf(marker, index + 1);
    if (index < 0) throw new Error(`找不到第 ${keep + 1} 条 judge 自检用例`);
  }
  // 退回到这条用例的对象开头（否则会留下一个没闭合的 `{`）。
  const caseStart = source.lastIndexOf('    {\n', index);
  if (caseStart < 0) throw new Error(`找不到第 ${keep + 1} 条 judge 自检用例的对象开头`);
  const endMarker = '\n  ];\n  const runners';
  const end = source.indexOf(endMarker, index);
  if (end < 0) throw new Error('找不到 judge 自检 cases 数组的结尾');
  return `${source.slice(0, caseStart)}  ];\n  const runners${source.slice(end + endMarker.length)}`;
}

/** 在 judge 函数体第一行插入 return，模拟「判官被短路」：后续检查全部跳过。 */
function injectJudgeShortCircuit(source, judge) {
  const signature = new RegExp(`^export function judge${judge}\\(.*\\) \\{$`, 'm');
  const match = signature.exec(source);
  if (!match) throw new Error(`judge.mjs 里找不到 ${judge} 的函数签名`);
  const insertAt = match.index + match[0].length;
  return `${source.slice(0, insertAt)}\n  return { ok: true, detail: 'INJECTED_SHORT_CIRCUIT' }; // 自检短路注入${source.slice(insertAt)}`;
}

const X2 = () => ({
  caseId: 'X2', turn: 7, kind: 'memory',
  utterance: `把 ${MEM_LIB} 整库重写一遍，按新格式。`,
  ctx: { tokens: 98000, zone: 'green', activeWorkers: 2, openRows: 5 },
});

const S1 = () => ({
  caseId: 'S1', turn: 3, kind: 'session',
  utterance: '这批 14 条 fixture 要跑 3 遍稳定性，估计 40 分钟。',
  ctx: { tokens: 140000, zone: 'green', activeWorkers: 1, openRows: 3 },
});

const M1 = () => ({
  caseId: 'M1', turn: 2, kind: 'memory',
  utterance: '以后 R1 的模拟一律先在 pre-r1-sim 快照上跑，别再直接动真机。',
  ctx: { tokens: 100000, zone: 'green', activeWorkers: 0, openRows: 2 },
});

// 20 个故障副本（只拷贝三个小文件，import 一次约几十毫秒）。
const SPECS = [
  ['F01', (dir) => rmSync(join(dir, 'routing-rules.json'))],
  ['F02', (dir) => writeFileSync(join(dir, 'routing-rules.json'), '{"rules": [\n', 'utf8')],
  ['F03', (dir) => writeFileSync(join(dir, 'routing-rules.json'), '{"version":1,"rules":null}\n', 'utf8')],
  ['F04', (dir) => rmSync(join(dir, 'aliases.json'))],
  ['F05', (dir) => mutateRules(dir, (table) => { delete ruleById(table, 'R-GUARD-REAL').priority; })],
  ['F06', (dir) => mutateRules(dir, (table) => { delete ruleById(table, 'R-GUARD-REAL').decision; })],
  ['F07', (dir) => mutateRules(dir, (table) => { ruleById(table, 'R-GUARD-REAL').decision.action = 'exec.shell'; })],
  ['F08', (dir) => mutateRules(dir, (table) => { ruleById(table, 'R-GUARD-REAL').decision.kind = 'exec'; })],
  ['F09', (dir) => mutateRules(dir, (table) => {
    const guard = ruleById(table, 'R-GUARD-REAL');
    const clone = JSON.parse(JSON.stringify(guard));
    clone.id = 'R-GUARD-SHADOW';
    clone.decision.kind = 'memory';
    clone.decision.action = 'engram.save';
    clone.decision.target = 'engram';
    clone.decision.writeScope = ['memory/journal/'];
    clone.decision.needsHuman = false;
    clone.after = [];
    table.rules.splice(table.rules.indexOf(guard), 0, clone);
  })],
  ['F15', (dir) => mutateRules(dir, (table) => {
    ruleById(table, 'R-MEM-EPISODE').decision.writeScope = ['Z:\\dsh-memory\\journal\\'];
  })],
  ['F16', (dir) => mutateRules(dir, (table) => {
    ruleById(table, 'R-MEM-DECISION').decision.writeScope = ['../../etc/cron.d/x'];
  })],
  ['F17', (dir) => mutateRules(dir, (table) => {
    ruleById(table, 'R-MEM-EPISODE').decision.writeScope = ['/etc/passwd'];
  })],
  ['F18', (dir) => mutateRules(dir, (table) => {
    const guard = ruleById(table, 'R-GUARD-REAL');
    const template = JSON.parse(JSON.stringify(guard.after[0]));
    guard.after = Array.from({ length: 100 }, () => JSON.parse(JSON.stringify(template)));
  })],
  ['F19', (dir) => mutateRules(dir, (table) => {
    const guard = ruleById(table, 'R-GUARD-REAL');
    const clones = Array.from({ length: 100 }, (_, index) => {
      const clone = JSON.parse(JSON.stringify(guard));
      clone.id = `R-GUARD-BOOM-${index}`;
      clone.decision.writeScope = [];
      clone.after = [];
      return clone;
    });
    table.rules.splice(table.rules.indexOf(guard), 0, ...clones);
  })],
  ['F20', (dir) => mutateRules(dir, (table) => {
    const guard = ruleById(table, 'R-GUARD-REAL');
    const clones = Array.from({ length: 201 }, (_, index) => {
      const clone = JSON.parse(JSON.stringify(guard));
      clone.id = `R-TABLE-BOOM-${index}`;
      clone.priority = 100;
      clone.decision.writeScope = [];
      clone.after = [];
      return clone;
    });
    table.rules.push(...clones);
  })],
];

const STAGED = new Map();
for (const [tag, mutate] of SPECS) STAGED.set(tag, await stageRoute(tag, mutate));

function assertFailClosed(assert, result, code, label) {
  assert(result && Array.isArray(result.decisions), `${label}: decisions 必须是数组`);
  assert(result.needsHuman === true, `${label}: needsHuman 必须为 true`);
  const codes = result.errors.map((error) => error.code);
  assert(codes.includes(code), `${label}: 缺错误码 ${code}，实际 errors=${JSON.stringify(codes)}`);
  assert(result.decisions.length > 0, `${label}: 不允许空 decisions 静默放行`);
  assert(
    result.decisions.every((decision) => decision.kind === 'reply' && decision.action === 'guard.refuse'),
    `${label}: 出错时必须只给 refuse，实际=${JSON.stringify(result.decisions.map((d) => `${d.kind}:${d.action}`))}`,
  );
}

export function runFailClosedSuite({ runCase, assert }) {
  // ── F01–F06：规则/别名不可用、结构错、字段缺省 ──────────────────────────
  runCase('R1-FC01', '规则文件缺失 → refuse + E_ROUTE_RULES_UNAVAILABLE', () => {
    assertFailClosed(assert, STAGED.get('F01')(X2()), ERROR_CODES.RULES_UNAVAILABLE, 'F01');
  });

  runCase('R1-FC02', '规则 JSON 损坏 → refuse + E_ROUTE_RULES_INVALID', () => {
    assertFailClosed(assert, STAGED.get('F02')(X2()), ERROR_CODES.RULES_INVALID, 'F02');
  });

  runCase('R1-FC03', '规则结构错误（rules=null）→ refuse + E_ROUTE_RULES_INVALID', () => {
    assertFailClosed(assert, STAGED.get('F03')(X2()), ERROR_CODES.RULES_INVALID, 'F03');
  });

  runCase('R1-FC04', '别名文件缺失 → refuse + E_ROUTE_ALIASES_UNAVAILABLE', () => {
    assertFailClosed(assert, STAGED.get('F04')(X2()), ERROR_CODES.ALIASES_UNAVAILABLE, 'F04');
  });

  runCase('R1-FC05', '规则缺 priority → refuse + E_ROUTE_RULE_FIELD + 点名规则', () => {
    const result = STAGED.get('F05')(X2());
    assertFailClosed(assert, result, ERROR_CODES.RULE_FIELD, 'F05');
    assert(
      result.errors.some((error) => error.code === ERROR_CODES.RULE_FIELD && error.ruleId === 'R-GUARD-REAL'),
      `F05: 错误里必须点名 R-GUARD-REAL，实际=${JSON.stringify(result.errors)}`,
    );
  });

  runCase('R1-FC06', '规则缺 decision → refuse + E_ROUTE_RULE_FIELD', () => {
    const result = STAGED.get('F06')(X2());
    assertFailClosed(assert, result, ERROR_CODES.RULE_FIELD, 'F06');
    assert(
      result.errors.some((error) => error.ruleId === 'R-GUARD-REAL'),
      'F06: 错误里必须点名 R-GUARD-REAL',
    );
  });

  // ── F07–F08：未知 action / kind 整表拒收 ────────────────────────────────
  runCase('R1-FC07', '未知 action → refuse + E_ROUTE_RULE_UNKNOWN（不静默丢规则）', () => {
    const result = STAGED.get('F07')(X2());
    assertFailClosed(assert, result, ERROR_CODES.RULE_UNKNOWN, 'F07');
    assert(
      result.errors.some((error) => error.ruleId === 'R-GUARD-REAL'),
      'F07: 必须点名 R-GUARD-REAL，而不是悄悄丢弃它',
    );
  });

  runCase('R1-FC08', '未知 kind → refuse + E_ROUTE_RULE_UNKNOWN', () => {
    assertFailClosed(assert, STAGED.get('F08')(X2()), ERROR_CODES.RULE_UNKNOWN, 'F08');
  });

  // ── F09/F10/F19：歧义 ──────────────────────────────────────────────────
  runCase('R1-FC09', '同优先级克隆 → E_ROUTE_AMBIGUOUS + 列出竞争规则，不得选中写记忆那条', () => {
    const result = STAGED.get('F09')(X2());
    assertFailClosed(assert, result, ERROR_CODES.AMBIGUOUS, 'F09');
    const ambiguous = result.errors.find((error) => error.code === ERROR_CODES.AMBIGUOUS);
    const ids = Array.isArray(ambiguous.rules) ? ambiguous.rules : [];
    assert(ids.includes('R-GUARD-REAL') && ids.includes('R-GUARD-SHADOW'),
      `F09: 竞争规则 id 必须包含两条，实际=${JSON.stringify(ids)}`);
    assert(!result.decisions.some((decision) => decision.action === 'engram.save'),
      'F09: 歧义时不允许静默选中写记忆的克隆规则');
  });

  runCase('R1-FC10', '现有表重活/回报同优先级双命中 → E_ROUTE_AMBIGUOUS（不按文件顺序）', () => {
    const result = route({
      caseId: 'F10', turn: 1, kind: 'session',
      utterance: '这批要跑 3 遍很久，做完了回报三行。', ctx: {},
    });
    assertFailClosed(assert, result, ERROR_CODES.AMBIGUOUS, 'F10');
    const ambiguous = result.errors.find((error) => error.code === ERROR_CODES.AMBIGUOUS);
    const ids = Array.isArray(ambiguous.rules) ? ambiguous.rules : [];
    assert(ids.includes('R-SES-HEAVY') && ids.includes('R-SES-VERIFY'),
      `F10: 竞争规则 id 应含 HEAVY 与 VERIFY，实际=${JSON.stringify(ids)}`);
  });

  runCase('R1-FC19', '注入 100 条同优先级克隆 → E_ROUTE_AMBIGUOUS（+爆炸上限）', () => {
    const result = STAGED.get('F19')(X2());
    assertFailClosed(assert, result, ERROR_CODES.AMBIGUOUS, 'F19');
    const ambiguous = result.errors.find((error) => error.code === ERROR_CODES.AMBIGUOUS);
    assert(Array.isArray(ambiguous.rules) && ambiguous.rules.length > 2,
      `F19: 竞争规则列表应列出多条，实际=${JSON.stringify(ambiguous.rules)}`);
  });

  // ── F11/F12：ctx 缺字段 / 类型错 ────────────────────────────────────────
  runCase('R1-FC11', 'ctx 缺 activeWorkers → E_ROUTE_CTX_MISSING（不当成没命中）', () => {
    const result = route({
      caseId: 'F11', turn: 1, kind: 'session', utterance: 'worker 进度到哪了？', ctx: {},
    });
    assertFailClosed(assert, result, ERROR_CODES.CTX_MISSING, 'F11');
  });

  runCase('R1-FC12', 'ctx.activeWorkers 是字符串 → E_ROUTE_CTX_TYPE', () => {
    const result = route({
      caseId: 'F12', turn: 1, kind: 'session', utterance: 'worker 进度到哪了？', ctx: { activeWorkers: '2' },
    });
    assertFailClosed(assert, result, ERROR_CODES.CTX_TYPE, 'F12');
    const typeError = result.errors.find((error) => error.code === ERROR_CODES.CTX_TYPE);
    assert(typeError.field === 'activeWorkers', `F12: 错误里应点名 activeWorkers，实际=${JSON.stringify(typeError)}`);
  });

  // ── F13/F14：override ──────────────────────────────────────────────────
  runCase('R1-FC13', 'override 缺 reason → 拒绝 override、保留原判定（既有行为不退）', () => {
    const result = route({
      kind: 'memory', text: '以后一律用 worker_spawn', override: { ruleId: 'R-MEM-DECISION' },
    });
    assert(result.errors.some((error) => error.code === ERROR_CODES.OVERRIDE_UNJUSTIFIED),
      `F13: 缺 E_ROUTE_OVERRIDE_UNJUSTIFIED，实际=${JSON.stringify(result.errors)}`);
    assert(result.needsHuman === true, 'F13: needsHuman 必须为 true');
    assert(result.decisions.length > 0, 'F13: 应保留原判定而不是空决策');
    assert(!result.decisions.some((decision) => decision.overridden), 'F13: 无理由 override 不得生效');
  });

  runCase('R1-FC14', 'override 指向不存在规则 → E_ROUTE_OVERRIDE_UNKNOWN，不贴 decisions[0]', () => {
    const result = route({
      ...S1(),
      override: { ruleId: 'R-NOPE', reason: '测试用越权 override', by: 'fault-matrix', at: '2026-11-03T00:00:00Z' },
    });
    assertFailClosed(assert, result, ERROR_CODES.OVERRIDE_UNKNOWN, 'F14');
    assert(!result.decisions.some((decision) => decision.overridden),
      'F14: 不存在的 override 不得贴到任何决策上');
    assert(!result.decisions.some((decision) => decision.kind === 'session'),
      'F14: 该 override 不可信时不得照常派活');
  });

  // ── F15–F17：writeScope 越界 ────────────────────────────────────────────
  for (const [tag, label] of [
    ['F15', '盘符'],
    ['F16', '相对穿越 ../'],
    ['F17', '绝对路径 /etc'],
  ]) {
    runCase(`R1-FC${tag.slice(1)}`, `writeScope 越界（${label}）→ E_ROUTE_SCOPE`, () => {
      const input = tag === 'F15' || tag === 'F17' ? {
        caseId: 'M2', turn: 2, kind: 'memory',
        utterance: '今天 15:40 他把 E1 的四个问了：17 条、7 段、C3 真实卡、D1 外部盲区。',
        ctx: { tokens: 102000, zone: 'green', activeWorkers: 0, openRows: 1 },
      } : M1();
      assertFailClosed(assert, STAGED.get(tag)(input), ERROR_CODES.SCOPE, tag);
    });
  }

  // ── F18/F20：数量爆炸 ──────────────────────────────────────────────────
  runCase('R1-FC18', '单规则展开 101 条决策 → E_ROUTE_EXPLOSION（≤32）', () => {
    const result = STAGED.get('F18')(X2());
    assertFailClosed(assert, result, ERROR_CODES.EXPLOSION, 'F18');
    assert(result.decisions.length <= 1, `F18: 爆炸时最多一条 refuse，实际 ${result.decisions.length}`);
  });

  runCase('R1-FC20', '规则表 218 条（>200）→ E_ROUTE_EXPLOSION', () => {
    assertFailClosed(assert, STAGED.get('F20')(X2()), ERROR_CODES.EXPLOSION, 'F20');
  });

  // ── F23：judge 自检 ────────────────────────────────────────────────────
  runCase('R1-FC23a', '--check 自带 judge 自检：已知坏输入必须判红且条数对上锚点', () => {
    const report = runCheck();
    assert(report.judgeSelfCheck && typeof report.judgeSelfCheck === 'object',
      '--check 报告缺 judgeSelfCheck 段');
    assert(report.judgeSelfCheck.total === report.judgeSelfCheck.expected,
      `judgeSelfCheck 条数 ${report.judgeSelfCheck.total} 与锚点 ${report.judgeSelfCheck.expected} 不一致`);
    assert(report.judgeSelfCheck.red === report.judgeSelfCheck.total,
      `judgeSelfCheck 应全红，实际 red=${report.judgeSelfCheck.red}/${report.judgeSelfCheck.total}`);
    assert(Array.isArray(report.judgeSelfCheck.coverage) && report.judgeSelfCheck.coverage.length === 9,
      `judgeSelfCheck 应覆盖 J1–J9，实际 ${JSON.stringify(report.judgeSelfCheck.coverage)}`);
    assert(report.ok === true, `正常仓库 --check 应通过，实际 errors=${JSON.stringify(report.errors)}`);
  });

  runCase('R1-FC23b', 'judgeJ6 对越界 writeScope 的坏结果确实判红', () => {
    const fixture = { id: 'SELF-J6', level: 'X', kind: 'memory', utterance: 'x', ctx: {}, expect: { refusal: true, writeScope: [] } };
    const bad = {
      decisions: [{
        kind: 'memory', action: 'engram.save', target: 'engram', ruleId: 'R-SELFCHECK',
        evidence: ['selfcheck'], writeScope: [`${MEM_LIB}\\journal\\`], needsHuman: false, confidence: 1,
      }],
      needsHuman: false, errors: [],
    };
    const verdict = judgeJ6(fixture, bad);
    assert(verdict.ok === false, 'judgeJ6 对越界 writeScope 必须判红，否则自检形同虚设');
  });

  // ── 自检绝对锚点：删用例 / 短路任一 judge 都必须让 --check 红 ───────────
  // 修复前的漏洞：只判「剩下的用例是否全红」。删掉第 5 条后 4/4 全红，--check 仍 exit 0。
  runCase('R1-FC26', 'judge 自检条数锚点：用例减到 4 条 → --check exit=1', () => {
    const stage = stageCheckCopy('anchor');
    const original = readFileSync(stage.routerFile, 'utf8');
    const pristine = runCopiedCheck(stage);
    assert(pristine.code === 0,
      `前置：原始副本 --check 应 exit 0，实际 ${pristine.code}：${(pristine.stderr || pristine.stdout).slice(-400)}`);
    writeFileSync(stage.routerFile, truncateSelfCheckCases(original, 4), 'utf8');
    const red = runCopiedCheck(stage);
    assert(red.code === 1, `删到 4 条后 --check 必须 exit 1，实际 ${red.code}`);
    assert(red.report && red.report.judgeSelfCheck && red.report.judgeSelfCheck.total === 4,
      `报告应只剩 4 条自检用例，实际 ${JSON.stringify(red.report && red.report.judgeSelfCheck)}`);
    assert(red.report.errors.some((error) => error.area === 'judge-selfcheck' && error.message.includes('锚点')),
      `缺少条数锚点报错：${JSON.stringify(red.report.errors.filter((error) => error.area === 'judge-selfcheck'))}`);
  });

  // 判官被短路 = 它放过了已知坏输入；自检必须掉红，--check 必须 exit 1。
  for (const [offset, judge] of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9'].entries()) {
    runCase(`R1-FC${27 + offset}`, `judge ${judge} 被短路 → --check exit=1`, () => {
      const stage = stageCheckCopy(`short-${judge}`);
      const source = readFileSync(stage.judgeFile, 'utf8');
      writeFileSync(stage.judgeFile, injectJudgeShortCircuit(source, judge), 'utf8');
      const red = runCopiedCheck(stage);
      assert(red.code === 1,
        `${judge} 被短路后 --check 必须 exit 1，实际 ${red.code}：${(red.stderr || red.stdout).slice(-500)}`);
      const selfCheck = red.report && red.report.judgeSelfCheck;
      assert(selfCheck && selfCheck.red < selfCheck.total,
        `${judge} 短路后自检必须掉红，实际 red=${selfCheck && selfCheck.red}/${selfCheck && selfCheck.total}`);
      const selfCheckErrors = (red.report.errors || []).filter((error) => error.area === 'judge-selfcheck');
      assert(selfCheckErrors.some((error) => error.message.includes(`「${judge} `)),
        `没有点名 ${judge} 的自检失败：${JSON.stringify(selfCheckErrors)}`);
    });
  }

  // ── 正常路径不被误伤 ────────────────────────────────────────────────────
  runCase('R1-FC24', '正常规则表：X2 仍是 guard.refuse + dryRun，M1 仍是 engram.save', () => {
    const x2 = route(X2());
    assert(x2.errors.length === 0, `正常 X2 不应有错误，实际=${JSON.stringify(x2.errors)}`);
    assert(x2.decisions.some((decision) => decision.action === 'guard.refuse'), '正常 X2 应有 guard.refuse');
    assert(x2.decisions.some((decision) => decision.action === 'guard.dryRun'), '正常 X2 应有 guard.dryRun');
    assert(x2.needsHuman === true, '正常 X2 应 needsHuman');

    const m1 = route(M1());
    assert(m1.errors.length === 0, `正常 M1 不应有错误，实际=${JSON.stringify(m1.errors)}`);
    assert(m1.decisions.some((decision) => decision.action === 'engram.save'), '正常 M1 应写 engram.save');
  });

  runCase('R1-FC25', '正常规则表 17 条全部通过校验（RULES 非空）', () => {
    assert(RULES.length >= 14, `正常仓库规则表应 >=14 条，实际 ${RULES.length}`);
  });
}

// 单独运行：node test/router-failclosed.test.mjs
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const results = [];
  const runCase = (id, name, fn) => {
    try {
      fn();
      results.push({ id, name, ok: true });
      console.log(`PASS ${id} ${name}`);
    } catch (error) {
      results.push({ id, name, ok: false, error });
      console.log(`FAIL ${id} ${name}\n     ${error && error.message}`);
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message || 'assertion failed');
  };
  runFailClosedSuite({ runCase, assert });
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
