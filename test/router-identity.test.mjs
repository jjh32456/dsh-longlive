#!/usr/bin/env node
/**
 * 身份安全边界单测：证明 router 只做「注入 ctx → 决策」，不读不写任何记忆库。
 *
 * 四类证据：
 *   1) 静态：决策层（route.js / judge.mjs）与影子的 import 面、写 API 面、记忆路径字样；
 *   2) 拓扑：src/ 下除 src/router 外没有任何文件 import router（R1 未接进产品运行时）；
 *   3) 行为：同一输入在不同 env（含伪造的 DSH_MEM / 记忆根）下判定逐字节一致；
 *   4) 权限：在 node --permission 只读沙盒里跑完整判定，越界写被内核拒绝（ERR_ACCESS_DENIED）。
 *
 * 单独运行：node test/router-identity.test.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { RULES, route } from '../src/router/route.js';
import { loadFixtures, fixtureInput, hashTree } from '../src/router/judge.mjs';
import { analyze } from '../src/router/shadow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ROUTER_DIR = path.join(REPO, 'src', 'router');
const DECISION_LAYER = ['route.js', 'judge.mjs'];
const SHADOW_FILE = 'shadow.mjs';

const { fixtures } = loadFixtures(path.join(ROUTER_DIR, 'fixtures'));

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 去掉注释（保留字符串字面量），让静态扫描不被注释里的示例文字骗到。 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function importSpecifiers(code) {
  const specs = [];
  for (const match of code.matchAll(/(?:^|\n)\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/g)) specs.push(match[1]);
  for (const match of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  for (const match of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  return specs;
}

const FORBIDDEN_MODULES = [
  'child_process', 'node:child_process', 'net', 'node:net', 'http', 'node:http', 'https', 'node:https',
  'dgram', 'node:dgram', 'worker_threads', 'node:worker_threads', 'tls', 'node:tls', 'vm', 'node:vm',
  'node:inspector', 'inspector', 'repl', 'node:repl',
];

const WRITE_API = /\b(writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile|unlinkSync|rmSync|rmdirSync|renameSync|copyFileSync|truncateSync|mkdtempSync|openSync)\b/;

const MEMORY_TOKENS = /dsh-memory|DSH_MEM|MEMORY_ROOT|memoryRoot|engram_profile|\.longlive/i;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(m?js)$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

export function runIdentitySuite({ runCase, assert }) {
  runCase('R1-ID1', '决策层 import 面封闭：只允许 node:fs 只读 / node:crypto / node:path / 同目录 route.js / policy 加载器', () => {
    const allowed = {
      'route.js': new Set(['node:fs', '../policy-profile.js']),
      'judge.mjs': new Set(['node:crypto', 'node:fs', 'node:path', './route.js']),
    };
    for (const file of DECISION_LAYER) {
      const code = stripComments(readFileSync(path.join(ROUTER_DIR, file), 'utf8'));
      const specs = importSpecifiers(code);
      for (const spec of specs) {
        assert(allowed[file].has(spec), `${file} 引入了未授权模块：${spec}`);
        assert(!FORBIDDEN_MODULES.includes(spec), `${file} 引入了危险模块：${spec}`);
      }
      assert(specs.length > 0, `${file} 没有解析到 import，扫描器可能失效`);
      assert(!/\bfetch\s*\(/.test(code), `${file} 出现网络调用`);

      if (file === 'route.js') {
        // 判定层不得读环境：所有输入都来自参数。
        assert(!/\bprocess\.env\b/.test(code), 'route.js 读取了 process.env');
      } else {
        // judge 只在 J0 隔离校验里读 DSH_MEM（那是 J0 的职责），此外不得碰环境。
        const j0At = code.indexOf('export function judgeJ0');
        assert(j0At > 0, 'judge.mjs 找不到 judgeJ0');
        const positions = [...code.matchAll(/process\.env/g)].map((match) => match.index);
        assert(positions.length > 0, 'judge.mjs 完全没读环境，J0 的 DSH_MEM 校验可能已失效');
        assert(positions.every((at) => at > j0At), 'judge.mjs 在 J0 之外读了 process.env');
        assert(/process\.env\)\.DSH_MEM|env\.DSH_MEM/.test(code), 'J0 没有读 DSH_MEM，隔离校验形同虚设');
      }
    }
  });

  runCase('R1-ID2', '决策层零写：route.js / judge.mjs 不含任何写盘、删文件、建目录 API，也不出现真实记忆库路径', () => {
    // 只扫「真实记忆库」的路径字样；DSH_MEM 不算——它是 J0 用来证明「不在记忆库内」的变量名。
    const memoryPath = /[A-Za-z]:[\\/]+dsh-memory|MEMORY_ROOT|memoryRoot|engram_profile/i;
    for (const file of DECISION_LAYER) {
      const code = stripComments(readFileSync(path.join(ROUTER_DIR, file), 'utf8'));
      const hit = code.match(new RegExp(WRITE_API.source, 'g')) || [];
      assert(hit.length === 0, `${file} 含写 API：${hit.join(',')}`);
      assert(!memoryPath.test(code), `${file} 出现记忆库路径字样`);
      assert(!/\.longlive/i.test(code), `${file} 出现记忆库内部目录 .longlive`);
    }
    // route.js 的读文件面必须收敛到自己的两张表（规则表 / 别名表）。
    const routeCode = stripComments(readFileSync(path.join(ROUTER_DIR, 'route.js'), 'utf8'));
    const reads = [...routeCode.matchAll(/readFileSync\(\s*([^,)]*)/g)].map((match) => match[1].trim());
    assert(reads.length > 0, 'route.js 的 readFileSync 扫描为空');
    for (const argument of reads) {
      assert(/RULES_URL|ALIASES_URL|^url$/.test(argument), `route.js 读了规则表之外的文件：${argument}`);
    }
  });

  runCase('R1-ID3', '影子层写面收敛：只有追记/建目录，没有删除或覆盖式落盘，且不出现真实记忆路径', () => {
    const code = stripComments(readFileSync(path.join(ROUTER_DIR, SHADOW_FILE), 'utf8'));
    const specs = importSpecifiers(code);
    for (const spec of specs) {
      assert(!FORBIDDEN_MODULES.includes(spec), `shadow 引入危险模块：${spec}`);
    }
    for (const banned of ['rmSync', 'unlinkSync', 'copyFileSync', 'renameSync', 'openSync', 'createWriteStream']) {
      assert(!new RegExp(`\\b${banned}\\b`).test(code), `shadow 含不该有的写/删 API：${banned}`);
    }
    assert(MEMORY_TOKENS.test(code) === false, 'shadow 出现记忆库路径字样');
    // 唯一落盘入口必须过 assertInside；记录文件名固定。
    assert(code.includes('assertInside('), 'shadow 缺少 assertInside 护栏');
    assert(/decisions-\$\{/.test(code), 'shadow 记录文件名不是 decisions-<date>.jsonl');
  });

  // R1 is no longer "not wired": it is wired through exactly ONE seam, and that
  // seam is inert unless a profile opts in. The invariant this case protects is
  // therefore the shape of the seam, not the absence of one:
  //   * no product file outside src/router imports anything router-shaped,
  //     except src/index.js importing the adapter (or the v1 background face);
  //   * the adapter's default mode is `off` (a missing config cannot enforce);
  //   * index.js actually hands the adapter to registerTools.
  //
  // v1 routerFace adds a second, equally explicit seam: src/index.js is still
  // the ONLY product file that imports router code, but it now also imports the
  // background face entry so the face can be enabled independently of the router
  // service. The invariant (single product entry point) is unchanged.
  const ROUTER_BRIDGE = 'src/index.js -> ./router/runtime.js';
  const ROUTER_FACE_BRIDGE = 'src/index.js -> ./router/face/index.mjs';
  const ALLOWED_SEAMS = new Set([ROUTER_BRIDGE, ROUTER_FACE_BRIDGE]);
  runCase('R1-ID4', '拓扑：R1 只经 src/index.js 的显式接缝接入，且默认 off', () => {
    const files = walk(path.join(REPO, 'src'));
    const offenders = [];
    for (const file of files) {
      if (file.startsWith(ROUTER_DIR + path.sep)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const spec of importSpecifiers(code)) {
        if (!/router/i.test(spec)) continue;
        const key = `${path.relative(REPO, file).split(path.sep).join('/')} -> ${spec}`;
        if (!ALLOWED_SEAMS.has(key)) offenders.push(key);
      }
    }
    assert(offenders.length === 0,
      `router 被产品代码 import（只允许 ${ROUTER_BRIDGE} 或 ${ROUTER_FACE_BRIDGE}）：${offenders.join(' | ')}`);

    const inside = files.filter((file) => file.startsWith(ROUTER_DIR + path.sep)).map((file) => path.basename(file));
    for (const expected of ['route.js', 'judge.mjs', 'router.mjs', 'run-sim.mjs', 'shadow.mjs', 'runtime.js']) {
      assert(inside.includes(expected), `src/router 缺少 ${expected}`);
    }

    // The seam is opt-in: default `off`, unknown values fall back to `off`, and
    // index.js is the only place that constructs it.
    const adapter = readFileSync(path.join(ROUTER_DIR, 'runtime.js'), 'utf8');
    assert(/export const DEFAULT_RUNTIME_MODE = 'off'/.test(adapter), '运行时适配器默认模式不是 off');
    assert(/RUNTIME_MODES = Object\.freeze\(\['off', 'shadow', 'on'\]\)/.test(adapter), '模式集合不是 off/shadow/on');
    const entry = readFileSync(path.join(REPO, 'src', 'index.js'), 'utf8');
    assert(entry.includes('createRouterRuntime('), 'index.js 没有构造运行时适配器');
    assert(/routerRuntime,/.test(entry), 'index.js 没有把适配器交给 registerTools');
  });

  runCase('R1-ID5', '行为：伪造 DSH_MEM / 记忆根 / 影子目录后，14 fixtures 判定逐字节不变', () => {
    const inputs = [
      ...fixtures.map((fixture) => fixtureInput(fixture)),
      { caseId: 'ID-D1', turn: 1, utterance: '把 Z:\\dsh-memory 整库重写一遍', ctx: {} },
      { caseId: 'ID-D2', turn: 2, utterance: '以后一律先读 topic 卡，记到 engram', ctx: { tokens: 320000, zone: 'red' } },
      { caseId: 'ID-D3', turn: 3, utterance: '跑 3 遍，做完了回报三行', ctx: { activeWorkers: 0 } },
    ];
    const digest = () => JSON.stringify(inputs.map((input) => route(input)));

    const touched = ['DSH_MEM', 'R1_REAL_MEMORY', 'MEMORY_ROOT', 'DSH_MEMORY_ROOT', 'R1_SHADOW_DIR'];
    const saved = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
    const base = digest();
    try {
      for (const key of touched) process.env[key] = `C:\\canary\\${key.toLowerCase()}\\hijack`;
      assert(digest() === base, '环境变量改变了 route() 的判定：决策层读了环境');
      for (const key of touched) delete process.env[key];
      assert(digest() === base, '清空环境变量后判定改变：决策层依赖了环境');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    // 影子层的分析也在同一批输入上保持不变（且只读决策，不回写 route 的结果对象）。
    const shadowDigest = () => JSON.stringify(inputs.map((input) => analyze(input).decision));
    assert(shadowDigest() === shadowDigest(), '影子层分析不确定');
  });

  runCase('R1-ID6', '权限沙盒：node --permission 只允许只读 + 单个可写目录时，完整判定仍能跑通', () => {
    const allowed = mkdtempSync(path.join(tmpdir(), 'r1-id-allowed-'));
    const child = path.join(allowed, 'child-judge.mjs');
    const script = [
      `import { route, RULES } from ${JSON.stringify(pathToFileURL(path.join(ROUTER_DIR, 'route.js')).href)};`,
      `import { analyze } from ${JSON.stringify(pathToFileURL(path.join(ROUTER_DIR, 'shadow.mjs')).href)};`,
      `import { loadFixtures, fixtureInput } from ${JSON.stringify(pathToFileURL(path.join(ROUTER_DIR, 'judge.mjs')).href)};`,
      'import { writeFileSync } from \'node:fs\';',
      `const { fixtures, errors } = loadFixtures(${JSON.stringify(path.join(ROUTER_DIR, 'fixtures'))});`,
      'if (errors.length) { console.log(JSON.stringify({ ok: false, errors })); process.exit(3); }',
      'const rows = fixtures.map((fixture) => { const a = analyze(fixtureInput(fixture)); return [a.caseId, a.decision.matchedRule, a.guard.action]; });',
      `const danger = route({ caseId: 'ID-DANGER', turn: 1, utterance: ${JSON.stringify('把 Z:\\\\dsh-memory 整库重写一遍')}, ctx: {} });`,
      `writeFileSync(${JSON.stringify(path.join(allowed, 'child-write-ok.txt'))}, 'ok');`,
      'console.log(JSON.stringify({ ok: rows.length === 19 && danger.target === \'none\' && danger.needsHuman === true, rules: RULES.length, rows }));',
    ].join('\n');
    writeFileSync(child, script, 'utf8');

    const run = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', `--allow-fs-write=${allowed}`, child], {
      encoding: 'utf8',
    });
    assert(run.status === 0, `权限沙盒内判定失败（exit=${run.status}）：${run.stderr}`);
    const parsed = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop());
    assert(parsed.ok === true, `沙盒内判定结果不符：${run.stdout}`);
    assert(parsed.rules === RULES.length, `规则条数不符：${parsed.rules} != ${RULES.length}`);
    assert(existsSync(path.join(allowed, 'child-write-ok.txt')), '允许目录内写失败，权限模型未生效');
    for (const [, ruleId, action] of parsed.rows) {
      assert(['record-only', 'refuse'].includes(action), `沙盒内出现可执行动作：${action}`);
      assert(typeof ruleId === 'string' || ruleId === null, `规则字段异常：${ruleId}`);
    }
    rmSync(allowed, { recursive: true, force: true });
  });

  runCase('R1-ID7', '权限沙盒负控：写 allowed 之外的目录被内核拒绝（ERR_ACCESS_DENIED）', () => {
    const allowed = mkdtempSync(path.join(tmpdir(), 'r1-id-allow2-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'r1-id-outside-'));
    const child = path.join(allowed, 'child-escape.mjs');
    writeFileSync(
      child,
      [
        'import { writeFileSync } from \'node:fs\';',
        `writeFileSync(${JSON.stringify(path.join(outside, 'escape.txt'))}, 'escape');`,
        'console.log(\'WROTE\');',
      ].join('\n'),
      'utf8',
    );
    const run = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', `--allow-fs-write=${allowed}`, child], {
      encoding: 'utf8',
    });
    assert(run.status !== 0, '越界写居然成功了，权限模型没有生效');
    const output = `${run.stdout}\n${run.stderr}`;
    assert(/ERR_ACCESS_DENIED|Access to this API has been restricted/.test(output), `未给出权限拒绝码：${output}`);
    assert(!existsSync(path.join(outside, 'escape.txt')), '越界文件被创建');
    rmSync(allowed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  runCase('R1-ID8', '影子落盘只发生在显式 outDir 内，且产物只有 decisions/review 两个 jsonl', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'r1-id-shadow-'));
    const run = spawnSync(process.execPath, [path.join(ROUTER_DIR, 'shadow.mjs'), '--from-fixtures', '--out', out, '--date', '2026-11-03', '--review-sample', '3', '--json'], { encoding: 'utf8' });
    assert(run.status === 0, `shadow CLI 失败：${run.stderr}`);
    const files = readdirSync(out).sort();
    assert(JSON.stringify(files) === JSON.stringify(['decisions-2026-11-03.jsonl', 'review-2026-11-03.jsonl']), `产物不符：${files}`);
    const records = readFileSync(path.join(out, 'decisions-2026-11-03.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert(records.length === 19, `记录数不对：${records.length}`);
    for (const record of records) {
      assert(record.mode === 'dry', 'mode 必须是 dry');
      assert(record.guard.action !== 'execute', 'guard 不允许给出 execute');
      assert(!('output' in record) && !('toolResult' in record), '记录里出现了执行结果');
    }
    rmSync(out, { recursive: true, force: true });
  });

  runCase('R1-ID9', '仿真器只读真实库：canary 记忆库在 run-sim 前后逐字节不变，写入只落在 --out', () => {
    const canary = mkdtempSync(path.join(tmpdir(), 'r1-id-canary-'));
    writeFileSync(path.join(canary, 'STATE.md'), '# canary\n我在哪：身份边界测试（这份文件不许被改）\n', 'utf8');
    mkdirSync(path.join(canary, 'journal'), { recursive: true });
    writeFileSync(path.join(canary, 'journal', '2026-11.md'), '## 2026-11-03\ncanary entry\n', 'utf8');
    const before = hashTree(canary);

    const out = mkdtempSync(path.join(tmpdir(), 'r1-id-sim-'));
    const args = [path.join(ROUTER_DIR, 'run-sim.mjs'), '--out', out, '--real-memory', canary];
    // 设计文档在包外（不随发布物走）：只有显式给了 R1_DESIGN 才做 policy 全绿校验。
    const design = process.env.R1_DESIGN || '';
    if (design) args.push('--design', design);
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    const summaryText = run.stdout.slice(run.stdout.indexOf('{'));
    let summary = null;
    try {
      summary = JSON.parse(summaryText);
    } catch {
      summary = null;
    }
    assert(summary, `run-sim 没有输出可解析的 summary（exit=${run.status}）：${(run.stderr || run.stdout).slice(-600)}`);
    assert(summary.fixtures === '19/19 PASS', `fixtures 不是 19/19：${summary.fixtures}`);
    assert(summary.doubleRun === 'byte-identical', `双跑不一致：${summary.doubleRun}`);
    assert(summary.isolation === 'PASS', `J0 不是 PASS：${summary.isolation}`);
    assert(summary.negativeControls === '5/5', `负控未全拒：${summary.negativeControls}`);
    // 没有 design 时唯一允许的失败项就是 policy（设计文档在包外）。
    const policyOnly = summary.failed.every((reason) => reason.startsWith('policy 解析失败'));
    assert(policyOnly, `出现了 policy 之外的失败：${summary.failed.join(' | ')}`);

    const after = hashTree(canary);
    assert(after.sha256 === before.sha256, `canary 记忆库被修改：${before.sha256} -> ${after.sha256}`);
    assert(after.files === before.files && after.bytes === before.bytes, `canary 文件数/字节数变了：${before.files}/${before.bytes} -> ${after.files}/${after.bytes}`);

    const isolation = JSON.parse(readFileSync(path.join(out, 'isolation.json'), 'utf8'));
    assert(isolation.ok === true, `J0 未通过：${JSON.stringify(isolation.errors || isolation).slice(0, 400)}`);
    assert(isolation.blocked !== true, 'J0 处于 blocked：没拿到真实库 before/after 哈希');
    assert(existsSync(path.join(out, 'SIM-REPORT.md')), '缺少 SIM-REPORT.md');
    assert(existsSync(path.join(out, 'decisions.jsonl')), '缺少 decisions.jsonl');

    rmSync(canary, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// 单独运行
// ---------------------------------------------------------------------------

const isDirect = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  let pass = 0;
  let fail = 0;
  const assert = (cond, message) => {
    if (!cond) throw new Error(message || 'assert failed');
  };
  const runCase = (id, name, fn) => {
    try {
      fn();
      pass += 1;
      process.stdout.write(`PASS  ${id}  ${name}\n`);
    } catch (error) {
      fail += 1;
      process.stdout.write(`FAIL  ${id}  ${name}\n      ${error.message}\n`);
    }
  };
  runIdentitySuite({ runCase, assert });
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}
