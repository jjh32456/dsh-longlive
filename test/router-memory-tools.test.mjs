// R1 记忆工具规则：5 个工具 × 普通 / 敏感 / 缺参 参数形态 + locked 目标 fail-closed。
//
// 背景（2026-11-03 VM 影子）：matchedRule=null 4/4 = 100%，因为 20 条规则里
// 没有任何一条以 memory_recall / memory_consolidate / memory_forget /
// memory_procedure 作为 match.tool。本套件把「工具名 + 参数形态」直接喂给
// route()，断言命中哪条规则、action / level / needsHuman / writeScope。
//
// 注意：
// - memory_save 属 engram 侧，本插件不注册、也不为它建规则。这里只钉住
//   「普通/缺参 → matchedRule=null（已知缺口）」与「带隐私标记 → 既有
//   R-MEM-LOCAL 仍然兜住（memory/private/、0 网络）」两个事实。
// - forget 的 locked 目标目前只能从文本里的 locked/锁定 识别：forget.js 的
//   schema 只有 confirm，没有 target；locked 卡在工具内部本来就是免疫的，
//   这条规则是前向防御（fail-closed），不是当前工具参数的常规路径。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { route } from '../src/router/route.js';
import { buildJudgeText } from '../src/router/runtime.js';

const PROFILE = 'generic';

export const MEMORY_TOOL_CASES = [
  // ── memory_recall：只读检索 ──────────────────────────────────────────
  {
    id: 'MEM-R1',
    name: 'memory_recall 普通查询：只读允许，level X，零写入',
    tool: 'memory_recall',
    args: { query: '之前定过的路由规则', topK: 3 },
    expect: {
      rule: 'R-MEM-RECALL', action: 'engram.search', target: 'topics',
      level: 'X', needsHuman: false, scope: [], tool: 'memory_recall',
    },
  },
  {
    id: 'MEM-R2',
    name: 'memory_recall 隐私查询：仍然只读允许（不写、不上传）',
    tool: 'memory_recall',
    args: { query: '身份证号和银行卡存在哪', room: 'topics' },
    expect: {
      rule: 'R-MEM-RECALL', action: 'engram.search', target: 'topics',
      level: 'X', needsHuman: false, scope: [], tool: 'memory_recall',
    },
  },
  {
    id: 'MEM-R3',
    name: 'memory_recall 缺 query：规则仍命中，工具层自己报 E_RECALL_EMPTY_QUERY',
    tool: 'memory_recall',
    args: { topK: 5 },
    expect: {
      rule: 'R-MEM-RECALL', action: 'engram.search', target: 'topics',
      level: 'X', needsHuman: false, scope: [], tool: 'memory_recall',
    },
  },

  // ── memory_consolidate：只出提案，不写卡 ─────────────────────────────
  {
    id: 'MEM-C1',
    name: 'memory_consolidate 普通：提案允许，只写 .longlive/reports/',
    tool: 'memory_consolidate',
    args: { since: '2026-10-01' },
    expect: {
      rule: 'R-MEM-CONSOLIDATE', action: 'memory.distillPropose', target: 'topics',
      level: 'X', needsHuman: false, scope: ['memory/.longlive/reports/'], tool: 'memory_consolidate',
    },
  },
  {
    id: 'MEM-C2',
    name: 'memory_consolidate apply=true：写真实库意图 → 先问，0 写入',
    tool: 'memory_consolidate',
    args: { apply: true },
    expect: {
      rule: 'R-MEM-CONSOLIDATE-REAL', action: 'reply.ask', target: 'none',
      level: 'X', needsHuman: true, scope: [], tool: 'memory_consolidate',
    },
  },
  {
    id: 'MEM-C3',
    name: 'memory_consolidate 缺 since：since 可选，全量提案仍允许',
    tool: 'memory_consolidate',
    args: {},
    expect: {
      rule: 'R-MEM-CONSOLIDATE', action: 'memory.distillPropose', target: 'topics',
      level: 'X', needsHuman: false, scope: ['memory/.longlive/reports/'], tool: 'memory_consolidate',
    },
  },

  // ── memory_forget：dry-run 允许，confirm 执行先问，locked 拒绝 ────────
  {
    id: 'MEM-F1',
    name: 'memory_forget 普通（无 confirm）：dry-run 允许，零写入',
    tool: 'memory_forget',
    args: {},
    expect: {
      rule: 'R-MEM-FORGET-DRY', action: 'guard.dryRun', target: 'none',
      level: 'X', needsHuman: false, scope: [], tool: 'memory_forget',
    },
  },
  {
    id: 'MEM-F2',
    name: 'memory_forget confirm=FORGET：执行删除 → 先问，确认前 0 写入',
    tool: 'memory_forget',
    args: { confirm: 'FORGET' },
    expect: {
      rule: 'R-MEM-FORGET-CONFIRM', action: 'memory.delete', target: 'none',
      level: 'X', needsHuman: true, scope: [], tool: 'memory_forget',
    },
  },
  {
    id: 'MEM-F3',
    name: 'memory_forget 空 confirm：等同缺参，工具层 E_CONFIRM_REQUIRED，路由不写',
    tool: 'memory_forget',
    args: { confirm: '' },
    expect: {
      rule: 'R-MEM-FORGET-DRY', action: 'guard.dryRun', target: 'none',
      level: 'X', needsHuman: false, scope: [], tool: 'memory_forget',
    },
  },
  {
    id: 'MEM-F4',
    name: 'memory_forget locked 目标：fail-closed 直接拒绝，0 写入',
    tool: 'memory_forget',
    args: { confirm: 'FORGET', target: 'locked-core' },
    expect: {
      rule: 'R-MEM-FORGET-LOCKED', action: 'guard.refuse', target: 'none',
      level: 'X', needsHuman: true, scope: [], tool: 'guard.refuse',
    },
  },

  // ── memory_procedure：新建/合并同名 → 先问 ───────────────────────────
  {
    id: 'MEM-P1',
    name: 'memory_procedure 普通 save：写 memory/procedures/ 允许',
    tool: 'memory_procedure',
    args: { action: 'save', name: '部署流程', slug: 'deploy-flow', when: '发布前', steps: ['跑测试', '打包'] },
    expect: {
      rule: 'R-MEM-PROC-TOOL', action: 'procedures.draft', target: 'procedures',
      level: 'X', needsHuman: false, scope: ['memory/procedures/'], tool: 'memory_procedure',
    },
  },
  {
    id: 'MEM-P2',
    name: 'memory_procedure delete：合并/删除同名 → 先问，0 写入',
    tool: 'memory_procedure',
    args: { action: 'delete', slug: 'deploy-flow' },
    expect: {
      rule: 'R-MEM-PROC-MERGE', action: 'reply.ask', target: 'none',
      level: 'X', needsHuman: true, scope: [], tool: 'memory_procedure',
    },
  },
  {
    id: 'MEM-P3',
    name: 'memory_procedure 缺参：规则仍命中，工具层自己报参数错误',
    tool: 'memory_procedure',
    args: {},
    expect: {
      rule: 'R-MEM-PROC-TOOL', action: 'procedures.draft', target: 'procedures',
      level: 'X', needsHuman: false, scope: ['memory/procedures/'], tool: 'memory_procedure',
    },
  },

  // ── memory_save：engram 侧、本插件收不到，不建规则 ───────────────────
  {
    id: 'MEM-S1',
    name: 'memory_save 普通：本表零规则（已知缺口，guard 通道覆盖）',
    tool: 'memory_save',
    args: { content: '路由规则补了记忆工具', kind: 'fact', scope: 'project' },
    expect: { rule: null },
  },
  {
    id: 'MEM-S2',
    name: 'memory_save 隐私：既有 R-MEM-LOCAL 兜住，memory/private/、0 网络',
    tool: 'memory_save',
    args: { content: '把密码和身份证号存到本地', kind: 'fact' },
    expect: {
      rule: 'R-MEM-LOCAL', action: 'memory.save_local', target: 'none',
      level: 'X', needsHuman: false, scope: ['memory/private/'], tool: 'memory_save_local',
    },
  },
  {
    id: 'MEM-S3',
    name: 'memory_save 缺参：本表零规则（工具层自己校验）',
    tool: 'memory_save',
    args: {},
    expect: { rule: null },
  },
];

function judge(tool, args) {
  return route({
    caseId: `MEM-${tool}`,
    kind: 'memory',
    text: buildJudgeText(tool, args),
    candidates: [tool],
  }, { profile: PROFILE });
}

function checkResult(result, expect, assert, label) {
  const rule = expect.rule === undefined ? null : expect.rule;
  assert(result.matchedRule === rule,
    `${label}: matchedRule=${JSON.stringify(result.matchedRule)}，期望 ${JSON.stringify(rule)}`);
  assert(Array.isArray(result.errors) && result.errors.length === 0,
    `${label}: 不应 fail-closed，errors=${JSON.stringify(result.errors)}`);
  if (rule === null) {
    assert(result.decisions.length === 0, `${label}: 零规则应产生 0 条决策，实际 ${result.decisions.length}`);
    assert(result.needsHuman === false || result.needsHuman === undefined,
      `${label}: 零规则不应 needsHuman，实际 ${JSON.stringify(result.needsHuman)}`);
    return;
  }
  assert(result.decisions.length === 1,
    `${label}: 应恰好 1 条决策，实际 ${result.decisions.length} 条（${result.decisions.map((d) => d.action).join(',')}）`);
  const decision = result.decisions[0];
  assert(decision.action === expect.action,
    `${label}: action=${decision.action}，期望 ${expect.action}`);
  assert(result.level === expect.level, `${label}: level=${result.level}，期望 ${expect.level}`);
  assert(result.needsHuman === expect.needsHuman,
    `${label}: needsHuman=${result.needsHuman}，期望 ${expect.needsHuman}`);
  assert(result.target === expect.target, `${label}: target=${result.target}，期望 ${expect.target}`);
  const scope = Array.isArray(decision.writeScope) ? decision.writeScope : [];
  assert(scope.join('|') === expect.scope.join('|'),
    `${label}: writeScope=${JSON.stringify(scope)}，期望 ${JSON.stringify(expect.scope)}`);
  assert(decision.tool === expect.tool,
    `${label}: decision.tool=${JSON.stringify(decision.tool)}，期望 ${JSON.stringify(expect.tool)}`);
}

export function runRouterMemoryToolsSuite({ runCase, assert }) {
  for (const testCase of MEMORY_TOOL_CASES) {
    runCase(testCase.id, testCase.name, () => {
      const result = judge(testCase.tool, testCase.args);
      checkResult(result, testCase.expect, assert, testCase.id);
      return `rule=${result.matchedRule ?? 'null'} action=${result.decisions[0]?.action ?? 'none'} scope=${JSON.stringify(result.decisions[0]?.writeScope ?? [])}`;
    });
  }
}

// ── 单跑入口（被 run.mjs import 时不打印）────────────────────────────
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
    console.log(`${last.ok ? 'PASS' : 'FAIL'}  ${id}  ${name}  ${last.detail}`);
  };

  runRouterMemoryToolsSuite({ runCase, assert });

  const failedCases = results.filter((entry) => !entry.ok);
  const totalMs = results.reduce((sum, entry) => sum + entry.ms, 0);
  console.log(`\n${results.length - failedCases.length} passed, ${failedCases.length} failed, ${totalMs}ms total`);
  if (failedCases.length > 0) process.exitCode = 1;
}
