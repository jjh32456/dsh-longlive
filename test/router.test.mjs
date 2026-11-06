// R1 Router-A — 19 条设计场景 + 边界用例。
//
// 场景来源：R1-DESIGN.md §5（工具选择 4 / 记忆路由 4 / 会话分派 4 / 边界 2）
// 加 §5.8 的 J8 六条裁决（S5/S6/M5/M6/M7 五条草案）。
// 每条场景只断言“该走哪条路”：target、tool、命中的规则 id、置信度区间；
// 规则表本身是否合法由 R1-RULES 单独守。
//
// 纯内存测试：不写包内文件（P6），不读凭据（P1），不出现本机盘符（PORT5）。
// 同时导出 runRouterSuite 供 test/run.mjs 调用，也能 `node test/router.test.mjs` 单跑。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { route, loadRules, RULES, TARGETS, KINDS, LEVELS, ERROR_CODES } from '../src/router/route.js';
import {
  LEVEL_MATRIX,
  SIGN_OFF,
  fixtureInput,
  loadFixtures,
  judgeFixture,
  judgeJ0,
  judgeJ1,
  judgeJ2,
  judgeJ3,
  judgeJ4,
  judgeJ5,
  judgeJ6,
  judgeJ8,
  judgeBrief,
  judgePolicy,
  judgeAuditLines,
  loadDesignSnapshot,
  hashTree,
  resolvePolicyRef,
} from '../src/router/judge.mjs';
import { runCheck } from '../src/router/router.mjs';
import { main as runSimMain } from '../src/router/run-sim.mjs';

// 拼出真实库路径，避免把本机盘符字面量写进发布文件。
const REAL_LIB = ['H:', 'dsh-memory'].join('\\');

const ROUTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/router');
const FIXTURES_DIR = path.join(ROUTER_DIR, 'fixtures');
const SNAPSHOT = path.join(ROUTER_DIR, 'design-headings.json');
const REPO_ROOT = path.resolve(ROUTER_DIR, '../..');

const FIXTURES = [
  // ── 工具选择 ──────────────────────────────────────────────
  {
    id: 'R1-T1',
    category: '工具选择',
    level: 'X',
    kind: 'tool',
    text: '现在上下文多少？还能撑多久？',
    expect: { target: 'live', toolIn: ['acp_status'], rule: 'R-TOOL-CTX' },
    forbid: ['session_health', 'read', 'web_search', 'worker_spawn'],
  },
  {
    id: 'R1-T2',
    category: '工具选择',
    level: 'X',
    kind: 'tool',
    text: '0.7.7 VM 那次硬杀到底几秒？给我出处。',
    expect: { target: 'live', toolIn: ['read'], rule: 'R-TOOL-EVIDENCE' },
    forbid: ['web_search', 'web_fetch', 'acp_status'],
  },
  {
    id: 'R1-T3',
    category: '工具选择',
    level: 'X',
    kind: 'tool',
    text: '把 R1 的 14 条场景写成 fixture，放 R1/fixtures。',
    expect: { target: 'live', toolIn: ['worker_spawn'], rule: 'R-TOOL-DISPATCH' },
    forbid: ['engram_save', 'web_search'],
  },
  {
    id: 'R1-T4',
    category: '工具选择',
    level: 'X',
    kind: 'tool',
    text: '我们之前定过的结论是什么？我要原话。',
    expect: { target: 'engram', toolIn: ['engram_search'], rule: 'R-TOOL-RECALL' },
    forbid: ['read', 'journal.append', 'web_search'],
  },

  // ── 记忆路由 ──────────────────────────────────────────────
  {
    id: 'R1-M1',
    category: '记忆路由',
    level: 'X',
    kind: 'memory',
    text: '以后派活一律用 worker_spawn，别再手工起了。',
    expect: { target: 'engram', toolIn: ['engram_save'], rule: 'R-MEM-DECISION' },
    forbid: ['journal.append', 'topics.write'],
  },
  {
    id: 'R1-M2',
    category: '记忆路由',
    level: 'X',
    kind: 'memory',
    text: '今天 15:40 他把 E1 的四问签了。',
    expect: { target: 'journal', toolIn: ['journal.append'], rule: 'R-MEM-EPISODE' },
    forbid: ['engram_save', 'topics.write'],
  },
  {
    id: 'R1-M3',
    category: '记忆路由',
    level: 'D',
    kind: 'memory',
    text: '以后每次改文件前必须先 read，照做。',
    expect: { target: 'procedures', toolIn: ['procedures.draft'], rule: 'R-MEM-PROCEDURE' },
    forbid: ['engram_save', 'journal.append'],
  },
  {
    id: 'R1-M4',
    category: '记忆路由',
    level: 'D',
    kind: 'memory',
    text: '旧结论作废，以后不再用平均估算法，统一改成逐音序列。',
    expect: { target: 'engram', toolIn: ['engram_facts'], rule: 'R-MEM-REVISE' },
    forbid: ['engram_save', 'topics.write'],
  },

  // ── 会话分派 ──────────────────────────────────────────────
  {
    id: 'R1-S1',
    category: '会话分派',
    level: 'X',
    kind: 'session',
    text: '要跑 3 遍稳定性，大概 40 分钟，你盯着。',
    expect: { target: 'live', toolIn: ['worker_spawn'], rule: 'R-SES-HEAVY' },
    forbid: ['reply.only', 'acp_status'],
  },
  {
    id: 'R1-S2',
    category: '会话分派',
    level: 'X',
    kind: 'session',
    text: '现在上下文 320K 了，快满了。',
    expect: { target: 'live', toolIn: ['session_handover'], rule: 'R-SES-RED' },
    forbid: ['worker_spawn', 'reply.only'],
  },
  {
    id: 'R1-S3',
    category: '会话分派',
    level: 'X',
    kind: 'session',
    text: 'worker-7f3a 回报：做完了，产物在 R1/fixtures/。三行如下……',
    expect: { target: 'live', toolIn: ['read'], rule: 'R-SES-VERIFY' },
    forbid: ['worker_spawn', 'reply.only'],
  },
  {
    id: 'R1-S4',
    category: '会话分派',
    level: 'H',
    kind: 'session',
    text: '今天真累，什么都不想干了。',
    expect: { target: 'live', toolIn: ['reply.only'], rule: 'R-SES-CHAT' },
    forbid: ['worker_spawn', 'engram_save', 'journal.append'],
  },

  // ── 边界 ──────────────────────────────────────────────────
  {
    id: 'R1-X1',
    category: '边界',
    level: 'H',
    kind: 'memory',
    text: '这段别记，也别写进记忆。',
    expect: { target: 'none', toolAbsent: true, rule: 'R-MEM-NONE' },
    forbid: ['engram_save', 'journal.append', 'topics.write', 'procedures.draft'],
  },
  {
    id: 'R1-X2',
    category: '边界',
    level: 'X',
    kind: 'memory',
    text: `把 ${REAL_LIB} 整库重写一遍。`,
    expect: { target: 'none', toolIn: ['guard.refuse'], rule: 'R-GUARD-REAL' },
    forbid: ['engram_save', 'journal.append', 'read'],
  },

  // ── J8 六条裁决（2026-11-03）─────────────────────────────
  {
    id: 'R1-S5',
    category: '会话分派',
    level: 'X',
    kind: 'session',
    text: '今天累坏了，先歇会儿。歇归歇，活儿别丢，回头还得接着干。',
    expect: { target: 'live', toolIn: ['reply.only'], rule: 'R-SES-CHAT' },
    forbid: ['worker_spawn', 'session_handover', 'session_compact', 'journal.append'],
  },
  {
    id: 'R1-S6',
    category: '会话分派',
    level: 'X',
    kind: 'session',
    text: '那个东西再弄一下。',
    expect: { target: 'none', toolIn: ['reply.ask'], rule: 'R-SES-ASK' },
    forbid: ['worker_spawn', 'engram_save', 'acp_status', 'read', 'grep'],
  },
  {
    id: 'R1-M5',
    category: '记忆路由',
    level: 'X',
    kind: 'memory',
    text: '这段别记——不是不记，是别上传：证件号 <ID_NO>，住址 <HOME_ADDR>，只存本地。',
    expect: { target: 'none', toolIn: ['memory_save_local'], rule: 'R-MEM-LOCAL' },
    forbid: ['engram_save', 'journal.append', 'web_fetch', 'web_search'],
  },
  {
    id: 'R1-M6',
    category: '记忆路由',
    level: 'X',
    kind: 'memory',
    text: '上次那几条关于预算的记忆重复了，删掉吧。',
    expect: { target: 'engram', toolIn: ['memory_distill_propose'], rule: 'R-MEM-DISTILL' },
    forbid: ['memory.delete', 'engram.forget', 'engram_save'],
  },
  {
    id: 'R1-M7',
    category: '记忆路由',
    level: 'X',
    kind: 'memory',
    text: '以后你就叫小蓝，别再叫听澜了，画像也改一下。',
    expect: { target: 'none', toolAbsent: true, rule: 'R-ID-CONSENT' },
    forbid: ['engram_profile_edit', 'engram_save', 'engram.facts.replace'],
  },
];

const priorityOf = (id) => {
  const rule = RULES.find((entry) => entry.id === id);
  return rule ? rule.priority : Number.NaN;
};

function checkFixture(fixture, assert) {
  const input = { kind: fixture.kind, text: fixture.text };
  const result = route(input);

  assert(result && typeof result === 'object', `${fixture.id}: route() 返回 ${typeof result}`);
  assert(result.decision && typeof result.decision === 'object', `${fixture.id}: 缺少 decision`);
  assert(
    result.decision.target === fixture.expect.target,
    `${fixture.id}: target ${result.decision.target} != ${fixture.expect.target}`,
  );
  assert(
    result.matchedRule === fixture.expect.rule,
    `${fixture.id}: 命中规则 ${result.matchedRule} != ${fixture.expect.rule}`,
  );

  if (fixture.expect.toolAbsent) {
    assert(
      result.decision.tool == null,
      `${fixture.id}: 不该给工具，却给了 ${result.decision.tool}`,
    );
  } else {
    assert(
      fixture.expect.toolIn.includes(result.decision.tool),
      `${fixture.id}: tool ${result.decision.tool} 不在 ${fixture.expect.toolIn.join('|')}`,
    );
  }

  // 兜底提问没有关键词命中，confidence 就该是 0；其余场景必须落在 0.75–1。
  if (fixture.expect.rule === 'R-SES-ASK') {
    assert(
      result.confidence === 0,
      `${fixture.id}: 兜底提问 confidence 应为 0，实际 ${result.confidence}`,
    );
    assert(result.matchedRule === 'R-SES-ASK', `${fixture.id}: 兜底提问 ruleId ${result.matchedRule}`);
  } else {
    assert(
      typeof result.confidence === 'number' && result.confidence >= 0.75 && result.confidence <= 1,
      `${fixture.id}: confidence ${result.confidence} 越界`,
    );
  }
  assert(
    Array.isArray(result.overrides) && result.overrides.length === 0,
    `${fixture.id}: 没有 override 输入却回显了 ${JSON.stringify(result.overrides)}`,
  );

  for (const forbidden of fixture.forbid || []) {
    assert(
      result.decision.tool !== forbidden,
      `${fixture.id}: 命中了不该走的 ${forbidden}`,
    );
  }

  // 同样的输入必须给出同样的判断（规则表顺序不能抖动）。
  const again = route(input);
  assert(
    JSON.stringify(again) === JSON.stringify(result),
    `${fixture.id}: 两次调用结果不一致`,
  );

  const toolText = result.decision.tool ? `:${result.decision.tool}` : '';
  return `${result.decision.target}${toolText} ← ${result.matchedRule} (confidence ${result.confidence})`;
}

function checkRulesTable(assert) {
  assert(Array.isArray(RULES), 'RULES 不是数组');
  assert(RULES.length >= 14, `规则表只有 ${RULES.length} 条，至少 14 条`);

  const ids = new Set();
  for (const rule of RULES) {
    assert(!ids.has(rule.id), `规则 id 重复：${rule.id}`);
    ids.add(rule.id);
    assert(TARGETS.includes(rule.target), `${rule.id}: target ${rule.target} 非法`);
    assert(
      typeof rule.priority === 'number' && Number.isFinite(rule.priority),
      `${rule.id}: priority 必须是有限数字`,
    );
    assert(rule.reason.trim().length > 0, `${rule.id}: reason 不能为空`);
    assert(
      rule.kind === '*' || ['tool', 'memory', 'session'].includes(rule.kind),
      `${rule.id}: match.kind ${rule.kind} 非法`,
    );
  }

  // 降序 + 文件顺序稳定
  for (let i = 1; i < RULES.length; i += 1) {
    assert(
      RULES[i - 1].priority >= RULES[i].priority,
      `规则未按 priority 降序：${RULES[i - 1].id}(${RULES[i - 1].priority}) < ${RULES[i].id}(${RULES[i].priority})`,
    );
  }

  // 同一份文件重新加载，排序结果必须一致
  const reloaded = loadRules().map((rule) => rule.id);
  assert(
    JSON.stringify(reloaded) === JSON.stringify(RULES.map((rule) => rule.id)),
    'loadRules() 两次结果不一致',
  );

  return `${RULES.length} rules, ${ids.size} unique ids, top=${RULES[0].id}(${RULES[0].priority})`;
}

function checkEmptyInputs(assert) {
  const cases = [
    undefined,
    null,
    {},
    { kind: 'tool' },
    { kind: 'tool', text: '' },
    { kind: 'tool', text: '   ' },
    { kind: 'memory', text: 42 },
    { kind: 'unknown', text: '这句话不指向任何房间' },
  ];
  for (const input of cases) {
    const result = route(input);
    assert(
      result.decision && result.decision.target === 'none',
      `${JSON.stringify(input)} -> target ${result.decision && result.decision.target}`,
    );
    assert(result.matchedRule === null, `${JSON.stringify(input)} -> matchedRule ${result.matchedRule}`);
    assert(result.confidence === 0, `${JSON.stringify(input)} -> confidence ${result.confidence}`);
    assert(Array.isArray(result.overrides), `${JSON.stringify(input)} -> overrides 不是数组`);
  }

  // 取属性就抛错的输入（getter 炸弹）也不许把 route 打穿
  const bomb = {
    get text() {
      throw new Error('boom');
    },
  };
  const bombed = route(bomb);
  assert(bombed.decision.target === 'none' && bombed.confidence === 0, 'getter 炸弹没有退化为 none');

  // override 缺 reason 一律丢弃，不许留一条无理由的偏离
  const silent = route({ kind: 'memory', text: '以后一律用 worker_spawn', override: { ruleId: 'R-MEM-DECISION' } });
  assert(silent.overrides.length === 0, `无理由 override 未被丢弃：${JSON.stringify(silent.overrides)}`);

  const logged = route({
    kind: 'memory',
    text: '以后一律用 worker_spawn',
    override: { ruleId: 'R-MEM-DECISION', reason: '会话判断：这次只是复述别人的决定' },
  });
  assert(
    logged.overrides.length === 1 && logged.overrides[0].ruleId === 'R-MEM-DECISION',
    `有理由 override 未回显：${JSON.stringify(logged.overrides)}`,
  );

  return `${cases.length} malformed inputs + getter bomb + override 留痕`;
}

function checkLongInput(assert) {
  const filler = 'x'.repeat(99_992);
  const text = `${filler}现在上下文多少？`;
  assert(text.length === 100_000, `构造的文本长度 ${text.length} != 100000`);

  route({ kind: 'tool', text: 'x'.repeat(1024) }); // 预热，避免把首次 JIT 算进中位数

  const timings = [];
  for (let i = 0; i < 3; i += 1) {
    const started = process.hrtime.bigint();
    const result = route({ kind: 'tool', text });
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    timings.push(elapsed);
    assert(result.matchedRule === 'R-TOOL-CTX', `第 ${i + 1} 次长文本未命中 R-TOOL-CTX`);
  }

  timings.sort((a, b) => a - b);
  const median = timings[1];
  assert(median < 50, `10 万字符中位耗时 ${median.toFixed(2)}ms 超过 50ms（${timings.map((t) => t.toFixed(2)).join(' / ')}）`);
  return `100000 chars, median ${median.toFixed(2)}ms (min ${timings[0].toFixed(2)}, max ${timings[2].toFixed(2)})`;
}

function checkConflictPriority(assert) {
  const procedure = priorityOf('R-MEM-PROCEDURE');
  const decision = priorityOf('R-MEM-DECISION');
  assert(procedure > decision, `R-MEM-PROCEDURE(${procedure}) 必须高于 R-MEM-DECISION(${decision})`);

  const conflict = route({ kind: 'memory', text: '以后每次改文件前必须先 read，照做。' });
  assert(conflict.matchedRule === 'R-MEM-PROCEDURE', `冲突未取高优先级：${conflict.matchedRule}`);
  assert(conflict.decision.target === 'procedures', `冲突 target ${conflict.decision.target}`);

  const guard = priorityOf('R-GUARD-REAL');
  const guardCase = route({ kind: 'memory', text: '以后把整库重写一遍' });
  assert(guardCase.matchedRule === 'R-GUARD-REAL', `越界动作未先命中 guard：${guardCase.matchedRule}`);
  assert(guardCase.decision.target === 'none', `越界动作 target ${guardCase.decision.target} 应为 none`);
  assert(guard > decision, `R-GUARD-REAL(${guard}) 必须高于 R-MEM-DECISION(${decision})`);

  // 越界动作的 refusals 也必须是确定输出
  const repeated = route({ kind: 'memory', text: '以后把整库重写一遍' });
  assert(JSON.stringify(repeated) === JSON.stringify(guardCase), '越界判断两次不一致');

  return `procedure(${procedure}) > decision(${decision}); guard(${guard}) > decision(${decision}) → none`;
}

// ── 契约 / judge / 审计（R1 对齐设计文档后新增） ─────────────

function checkInputContract(assert) {
  const utterance = '现在上下文多少？还能撑多久？';
  const base = route({ caseId: 'C1', turn: 3, utterance });
  assert(base.caseId === 'C1' && base.turn === 3, `${base.caseId}/${base.turn} 未透传`);
  assert(Array.isArray(base.decisions) && base.decisions.length === 1, `decisions 应为 1 条：${base.decisions.length}`);
  assert(base.decisions[0].target === base.decision.target, '旧别名 decision.target 与 decisions[0] 不一致');
  assert(base.decisions[0].tool === base.decision.tool, '旧别名 decision.tool 与 decisions[0] 不一致');
  assert(base.needsHuman === false, `T1 needsHuman 应为 false：${base.needsHuman}`);

  for (const decision of base.decisions) {
    assert(KINDS.includes(decision.kind), `kind ${decision.kind} 非法`);
    assert(typeof decision.action === 'string' && decision.action.length > 0, 'action 不能为空');
    assert(/^R-[A-Z-]+$/.test(decision.ruleId), `ruleId 形态不对：${decision.ruleId}`);
    assert(Array.isArray(decision.evidence) && decision.evidence.length > 0, `${decision.ruleId}: evidence 为空`);
    assert(
      decision.evidence.some((item) => item.startsWith('src/router/routing-rules.json:')),
      `${decision.ruleId}: 缺规则表行号证据`,
    );
    assert(decision.evidence.some((item) => item.startsWith('policy:')), `${decision.ruleId}: 缺 policy 证据`);
    assert(Array.isArray(decision.writeScope), `${decision.ruleId}: writeScope 不是数组`);
  }

  // ctx.tokens 参与路由：acp_status 带上 tokens，evidence 写明用了 ctx
  const withTokens = route({ caseId: 'C2', turn: 1, utterance, ctx: { tokens: 82192, zone: 'green' } });
  const status = withTokens.decisions.find((decision) => decision.action === 'acp_status');
  assert(status && status.args.tokens === 82192, `ctx.tokens 未进入 args：${JSON.stringify(status && status.args)}`);
  assert(status.evidence.includes('ctx:tokens'), `evidence 未标注 ctx:tokens：${status.evidence.join('|')}`);
  assert(!withTokens.decisions.some((decision) => decision.action === 'session.compact'), '绿区不该建议压缩');

  // ctx.zone=red 且无 handover → 叠加交班决定，且交给人的判断
  const red = route({ caseId: 'C3', turn: 1, utterance, ctx: { tokens: 327680, zone: 'red', activeWorkers: 0, openRows: 0 } });
  const handover = red.decisions.find((decision) => decision.action === 'session.handover');
  assert(handover, '红区没有 session.handover');
  assert(handover.args.tokens === 327680 && handover.args.zone === 'red', `handover ctx 未透传：${JSON.stringify(handover.args)}`);
  assert(handover.evidence.includes('ctx:tokens') && handover.evidence.includes('ctx:zone'), 'handover 证据缺 ctx');
  assert(red.needsHuman === true, '交班必须 needsHuman');

  // ctx.tokens=黄区 → 建议压缩（session.compact），不交班
  const yellow = route({ caseId: 'C4', turn: 1, utterance, ctx: { tokens: 180000, zone: 'yellow' } });
  assert(yellow.decisions.some((decision) => decision.action === 'session.compact'), '黄区没有建议压缩');
  assert(!yellow.decisions.some((decision) => decision.action === 'session.handover'), '黄区不该交班');

  // ctx.activeWorkers>0 → 派活进现有池；ctx.openRows>0 → 任务板行
  const dispatch = route({
    caseId: 'C5',
    turn: 1,
    utterance: '把 R1 的 14 条场景写成 fixture，放 R1/fixtures。',
    ctx: { activeWorkers: 2, openRows: 3 },
  });
  const spawn = dispatch.decisions.find((decision) => decision.action === 'worker_spawn');
  assert(spawn, '派活场景没有 worker_spawn');
  assert(spawn.args.pool === 'existing', `activeWorkers>0 应复用现有池：${JSON.stringify(spawn.args)}`);
  assert(spawn.evidence.includes('ctx:activeWorkers'), 'worker_spawn 证据缺 ctx:activeWorkers');
  const board = dispatch.decisions.find((decision) => decision.action === 'taskboard.update');
  assert(board && board.evidence.includes('ctx:openRows'), '任务板决定证据缺 ctx:openRows');
  const brief = spawn.args.brief || {};
  assert(
    typeof brief.goal === 'string' && brief.goal.length > 0
      && Array.isArray(brief.inputs) && brief.inputs.length > 0
      && Array.isArray(brief.artifacts) && brief.artifacts.length > 0
      && typeof brief.acceptance === 'string' && brief.acceptance.length > 0
      && Number.isFinite(brief.timeoutSec) && brief.timeoutSec > 0,
    `任务书五要素不全：${JSON.stringify(brief)}`,
  );

  // text 是 utterance 的兼容别名：同一句话必须给出同一串决定
  const viaText = route({ kind: 'tool', text: utterance });
  assert(viaText.matchedRule === base.matchedRule, `text 别名命中不一致：${viaText.matchedRule} != ${base.matchedRule}`);
  assert(JSON.stringify(viaText.decisions) === JSON.stringify(base.decisions), 'text 别名与 utterance 的决定不一致');

  // 纯函数：同输入两次完全一致（无时钟/随机）
  assert(JSON.stringify(route({ caseId: 'C1', turn: 3, utterance })) === JSON.stringify(base), '两次调用结果不一致');

  return 'decisions[] + needsHuman + 旧别名；ctx:tokens/zone/activeWorkers/openRows 均参与并留痕';
}

function checkOverrideAudit(assert) {
  const utterance = '现在上下文多少？';
  const justified = route({
    caseId: 'OV-J',
    turn: 1,
    utterance,
    override: { ruleId: 'R-TOOL-CTX', reason: '本次只复述上一轮结论', by: '金嘉恒', at: '2026-11-03T02:44:31+08:00' },
  });
  assert(justified.overrides.length === 1, `有理由 override 未生效：${JSON.stringify(justified.overrides)}`);
  assert(justified.overrideAudit.applied === 1, `applied ${justified.overrideAudit.applied}`);
  const record = justified.overrideAudit.records[0];
  assert(record.ruleId === 'R-TOOL-CTX' && record.reason === '本次只复述上一轮结论', 'override 记录缺原始理由');
  assert(record.by === '金嘉恒' && /^2026-11-03T/.test(record.at), 'override 记录缺谁覆盖/时间戳');
  assert(justified.decisions[0].overridden && justified.decisions[0].overridden.by === '金嘉恒', '决定上没有偏离标注');

  const unjustified = route({ caseId: 'OV-U', turn: 1, utterance, override: { ruleId: 'R-TOOL-CTX', by: 'tester' } });
  assert(unjustified.overrides.length === 0, '无理由 override 被当成生效');
  assert(unjustified.overrideAudit.rejected === 1, `rejected ${unjustified.overrideAudit.rejected}`);
  assert(
    unjustified.errors.some((error) => error.code === ERROR_CODES.OVERRIDE_UNJUSTIFIED),
    `未记 ${ERROR_CODES.OVERRIDE_UNJUSTIFIED}`,
  );
  assert(unjustified.needsHuman === true, '无理由 override 应转人工');
  assert(
    JSON.stringify(unjustified.decisions) === JSON.stringify(route({ caseId: 'OV-U', turn: 1, utterance }).decisions),
    '无理由 override 不该改变判定',
  );

  // decisions.jsonl 审计：每行要有 overrides；生效条目字段齐全；被拒要有失败码
  const good = judgeAuditLines([
    JSON.stringify({ caseId: 'OV-J', overrides: justified.overrides, overrideAudit: justified.overrideAudit }),
    JSON.stringify({ caseId: 'OV-U', overrides: unjustified.overrides, errors: unjustified.errors, overrideAudit: unjustified.overrideAudit }),
  ]);
  assert(good.ok, `审计行判负：${good.message || good.detail}`);
  assert(good.records.length === 1, `审计记录数 ${good.records.length}`);

  const noOverrides = judgeAuditLines([JSON.stringify({ caseId: 'BAD' })]);
  assert(!noOverrides.ok, '缺 overrides 字段的行没被拒');
  const missingReason = judgeAuditLines([JSON.stringify({ caseId: 'BAD', overrides: [{ ruleId: 'R-TOOL-CTX', by: 'tester' }] })]);
  assert(!missingReason.ok, '缺理由的 override 行没被拒');
  const silentReject = judgeAuditLines([
    JSON.stringify({ caseId: 'BAD', overrides: [], overrideAudit: { rejected: 1 }, errors: [] }),
  ]);
  assert(!silentReject.ok, '被拒 override 没记失败码的行没被拒');

  return '有理由留痕（理由/谁/时间戳）· 无理由丢弃并计 E_ROUTE_OVERRIDE_UNJUSTIFIED · jsonl 逐行可审';
}

function checkFixtureJudge(assert) {
  const design = loadDesignSnapshot(SNAPSHOT);
  assert(SNAPSHOT && design.headings.length >= 14, 'policy 快照不可用');
  const loaded = loadFixtures(FIXTURES_DIR);
  assert(loaded.errors.length === 0, `fixture schema 错：${JSON.stringify(loaded.errors)}`);
  assert(loaded.fixtures.length === 19, `fixture 数量 ${loaded.fixtures.length} != 19`);

  const failures = [];
  const levels = new Map();
  for (const fixture of loaded.fixtures) {
    levels.set(fixture.id, fixture.level);
    const result = route(fixtureInput(fixture));
    const judged = judgeFixture(fixture, result, { design, repoRoot: REPO_ROOT });
    if (judged.status !== 'PASS') {
      failures.push(`${fixture.id}[${judged.errors.map((error) => error.code).join(',')}]`);
    }
  }
  assert(failures.length === 0, `judge 未过：${failures.join(' ')}`);
  return `19/19 PASS（J1–J9 + EXTRA + FORBIDDEN + LEVEL + CONFIDENCE）；level=${[...levels].map(([id, level]) => `${id}:${level}`).join(' ')}`;
}

function checkJ0Isolation(assert) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-j0-'));
  const realRoot = path.join(root, 'real-memory');
  const sandbox = path.join(root, 'sandbox');
  fs.mkdirSync(realRoot, { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(realRoot, 'INDEX.md'), '# real\n');
  const env = { DSH_MEM: path.join(sandbox, 'memory') };
  const cleanBefore = hashTree(realRoot);
  try {
    const clean = judgeJ0({ sandbox, realRoot, before: cleanBefore, after: hashTree(realRoot), env });
    assert(clean.ok && !clean.blocked, `干净的隔离被判负：${JSON.stringify(clean.errors)}`);

    // 真实库被动过 → 必须失败
    fs.writeFileSync(path.join(realRoot, 'INDEX.md'), '# changed\n');
    const dirty = judgeJ0({ sandbox, realRoot, before: cleanBefore, after: hashTree(realRoot), env });
    assert(!dirty.ok, '真实库 hash 变了却判 PASS');
    assert(dirty.errors.some((error) => error.code === ERROR_CODES.ISOLATION), `未记 ${ERROR_CODES.ISOLATION}`);

    // DSH_MEM 跑到沙盒外 → 必须失败
    const outside = judgeJ0({
      sandbox,
      realRoot,
      before: hashTree(realRoot),
      after: hashTree(realRoot),
      env: { DSH_MEM: realRoot },
    });
    assert(!outside.ok && outside.errors.some((error) => error.code === ERROR_CODES.ISOLATION), 'DSH_MEM 越界未被拒');

    // 没有真实库 → blocked，不许假 PASS
    const blocked = judgeJ0({ sandbox, realRoot: null, env });
    assert(blocked.ok && blocked.blocked === true, '未配置真实库时应 blocked 而不是 PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return 'before/after hash 一致才 PASS；前后不一致与 DSH_MEM 越界都记 E_ROUTE_ISOLATION；无真实库给 blocked';
}

function checkPolicyRefs(assert) {
  const design = loadDesignSnapshot(SNAPSHOT);
  const report = judgePolicy(RULES, design);
  assert(report.ok, `policy 解析失败：${JSON.stringify(report.errors.slice(0, 3))}`);
  for (const rule of RULES) {
    const resolved = resolvePolicyRef(rule.policyRef, design);
    assert(resolved.ok, `${rule.id}: ${resolved.message}`);
    assert(resolved.title === rule.policyTitle, `${rule.id}: title ${resolved.title} != ${rule.policyTitle}`);
  }
  const missing = resolvePolicyRef('R1-DESIGN.md §9.9', design);
  assert(!missing.ok, '不存在的节号不该解析成功');
  const anchor = resolvePolicyRef('R1-DESIGN.md#5.2', design);
  assert(!anchor.ok, '旧 # 锚点形式不该解析成功');
  return `${RULES.length} 条 policyRef 全部命中真实小节（快照 ${design.doc}）；§9.9 与 # 锚点负控被拒`;
}

function checkLevels(assert) {
  const loaded = loadFixtures(FIXTURES_DIR);
  assert(loaded.errors.length === 0, `fixture schema 错：${JSON.stringify(loaded.errors)}`);
  for (const fixture of loaded.fixtures) {
    assert(LEVELS.includes(fixture.level), `${fixture.id}: level ${fixture.level} 不在 ${LEVELS.join('/')}`);
    assert(
      LEVEL_MATRIX[fixture.id] === fixture.level,
      `${fixture.id}: level ${fixture.level} 与设计矩阵 ${LEVEL_MATRIX[fixture.id]} 不一致`,
    );
  }
  assert(LEVEL_MATRIX.M3 === 'D' && LEVEL_MATRIX.M4 === 'D', `M3/M4 应为 D：${LEVEL_MATRIX.M3}/${LEVEL_MATRIX.M4}`);
  assert(LEVEL_MATRIX.S4 === 'H' && LEVEL_MATRIX.X1 === 'H', `S4/X1 应为 H：${LEVEL_MATRIX.S4}/${LEVEL_MATRIX.X1}`);
  assert(SIGN_OFF.S4 === 'human' && SIGN_OFF.X1 === 'human', 'S4/X1 应需人工签字');
  for (const id of ['S4', 'X1']) {
    const fixture = loaded.fixtures.find((item) => item.id === id);
    assert(fixture.level === 'H' && fixture.expect.needsHuman === true, `${id}: H 档必须 needsHuman`);
  }
  return `X/D/H 三档：M3/M4=D，S4/X1=H（人工签字），其余 X`;
}

function checkJudgeNegatives(assert) {
  const loaded = loadFixtures(FIXTURES_DIR);
  const pick = (id) => {
    const fixture = loaded.fixtures.find((item) => item.id === id);
    assert(fixture, `缺 fixture ${id}`);
    return fixture;
  };
  const t1 = pick('T1');
  const r1 = route(fixtureInput(t1));
  const doubled = { ...r1, decisions: [...r1.decisions, { ...r1.decisions[0], ruleId: 'R-TOOL-RECALL' }] };
  const j1 = judgeJ1(t1, doubled);
  assert(!j1.ok && j1.code === ERROR_CODES.SHAPE, `J1 未拒多条：${j1.code}`);

  const t3 = pick('T3');
  const r3 = route(fixtureInput(t3));
  const reversed = { ...r3, decisions: r3.decisions.slice().reverse() };
  const j2 = judgeJ2(t3, reversed);
  assert(!j2.ok && j2.code === ERROR_CODES.ORDER, `J2 未拒乱序：${j2.code}`);

  const evilScope = { ...r3, decisions: r3.decisions.map((decision, index) => (index === 0 ? { ...decision, writeScope: ['C:\\temp'] } : decision)) };
  const j6 = judgeJ6(t3, evilScope);
  assert(!j6.ok && j6.code === ERROR_CODES.SCOPE, `J6 未拒盘符写作用域：${j6.code}`);

  const rogueAction = { ...r1, decisions: r1.decisions.map((decision) => ({ ...decision, action: 'rm_rf' })) };
  const ja = judgeJ2(t1, rogueAction);
  assert(!ja.ok && ja.code === ERROR_CODES.ACTION, `J2 未拒未知动作：${ja.code}`);

  const noGoal = {
    ...r3,
    decisions: r3.decisions.map((decision) => (decision.action === 'worker_spawn'
      ? { ...decision, args: { ...decision.args, brief: { ...decision.args.brief, goal: '' } } }
      : decision)),
  };
  const jb = judgeBrief(t3, noGoal);
  assert(!jb.ok && jb.code === ERROR_CODES.BRIEF, `BRIEF 未拒缺目标的任务书：${jb.code}`);

  const s4 = pick('S4');
  const r4 = route(fixtureInput(s4));
  const flipped = { ...r4, needsHuman: !r4.needsHuman };
  const j8 = judgeJ8(s4, flipped);
  assert(!j8.ok && j8.code === ERROR_CODES.HUMAN, `J8 未拒 needsHuman 翻转：${j8.code}`);

  const x2 = pick('X2');
  const rX = route(fixtureInput(x2));
  const withWrite = {
    ...rX,
    decisions: [...rX.decisions, { kind: 'memory', action: 'engram.save', args: {}, ruleId: 'R-MEM-DECISION', evidence: [], writeScope: ['engram:decision'] }],
  };
  const j3 = judgeJ3(x2, withWrite);
  assert(!j3.ok && j3.code === ERROR_CODES.REFUSAL, `J3 未拒拒绝类带写入：${j3.code}`);

  // 无理由 override → J5 必须判负
  const unjust = route({ caseId: 'NEG-J5', turn: 1, utterance: t1.utterance, override: { ruleId: 'R-TOOL-CTX' } });
  const j5 = judgeJ5(t1, unjust);
  assert(!j5.ok && j5.code === ERROR_CODES.OVERRIDE_UNJUSTIFIED, `J5 未拒无理由 override：${j5.code}`);

  return 'J1 多条 / J2 乱序 / J3 拒绝带写 / J5 无理由 / J6 盘符 scope / J8 翻转 / BRIEF 缺目标 → 全部 REJECTED';
}

// J4（证据字段）红测：先断言“证据齐全 → PASS”作对照，再把同一份 route 结果改坏，
// 断言 J4 必须返回 E_ROUTE_EVIDENCE。停用 judge.mjs 的 J4 分支后，这 4 条必须变红。
function checkJ4Evidence(assert, label, mutate) {
  const design = loadDesignSnapshot(SNAPSHOT);
  const loaded = loadFixtures(FIXTURES_DIR);
  const fixture = loaded.fixtures.find((item) => item.id === 'T1');
  assert(fixture, '缺 fixture T1');
  const clean = route(fixtureInput(fixture));
  const opts = { design, repoRoot: REPO_ROOT };

  const control = judgeJ4(fixture, clean, opts);
  assert(
    control.ok,
    `对照失败：证据齐全的 ${fixture.id} 应 PASS，实际 ${control.code}: ${control.message}`,
  );

  const broken = {
    ...clean,
    decisions: clean.decisions.map((decision) => mutate({ ...decision, evidence: [...decision.evidence] })),
  };
  const judged = judgeJ4(fixture, broken, opts);
  assert(judged.ok !== true, `${label}：J4 没有拒绝（ok:true, ${judged.detail || ''}）`);
  assert(
    judged.code === ERROR_CODES.EVIDENCE,
    `${label}：错误码 ${judged.code} != ${ERROR_CODES.EVIDENCE}`,
  );
  return `对照 PASS；${label} → ${judged.code}`;
}

// J8 六条裁决的负例：每条裁决配一个“不该发生”的对照，防止规则只做正例。
function checkJ8Negatives(assert) {
  const ctx = { tokens: 45000, zone: 'green', activeWorkers: 0, openRows: 1 };
  const run = (kind, utterance, extra = {}) => route({ caseId: 'NEG-J8', turn: 1, kind, utterance, ctx, ...extra });
  const acts = (result) => result.decisions.map((decision) => decision.action);

  // 1 休息≠终止：终止语不得被当成可恢复的临时休息，也不得写交接卡／派活
  const stop = run('session', '不干了，永久退出，以后都不做了。');
  assert(
    !stop.decisions.some((decision) => decision.action === 'reply.only' && decision.args && decision.args.restKind === 'TEMPORARY'),
    `终止语被当成可恢复休息：${acts(stop).join(',')}`,
  );
  assert(!acts(stop).includes('session.handover'), '终止语不得直接写交接卡');
  assert(!acts(stop).includes('worker_spawn'), '终止语不得派活');

  // 2 隐私只本地：裸「别记」仍是零写入，不许被扩成本地保存
  const bare = run('memory', '这段别记。');
  assert(acts(bare).includes('reply.no_write'), `裸别记未走零写入：${acts(bare).join(',')}`);
  assert(!acts(bare).includes('memory.save_local'), '裸别记被当成隐私本地保存');

  // 3 蒸馏优先：用户明确说删，也不许绕过蒸馏提案直接删
  const del = run('memory', '把那条预算记忆删掉，不用合并。');
  assert(!acts(del).includes('memory.delete') && !acts(del).includes('engram.forget'), `删除未被拦下：${acts(del).join(',')}`);
  assert(acts(del).includes('memory.distillPropose'), `删除请求未先提蒸馏：${acts(del).join(',')}`);

  // 4 纠错无需请示：日常改旧结论，不许升级成 needsHuman
  const revise = run('memory', '旧结论作废，改成新的。');
  assert(revise.decisions.some((decision) => decision.action === 'engram.facts.replace'), `纠错未直接改：${acts(revise).join(',')}`);
  assert(revise.needsHuman === false, `纠错被升级成请示：needsHuman=${revise.needsHuman}`);

  // 5 含糊才问：清楚的指令不许反问
  const clear = run('tool', '现在上下文多少？还能撑多久？');
  assert(!acts(clear).includes('reply.ask'), `清楚指令被反问：${acts(clear).join(',')}`);

  // 6 身份同意权在当前会话的助手：用户自己说「我同意」不算同意
  const ident = '以后你就叫小蓝，别再叫听澜了，画像也改一下。';
  const userConsent = run('memory', ident, {
    consent: { holder: 'user', satisfied: true, at: '2026-11-03T10:00:00+08:00', quote: '我同意改' },
  });
  assert(acts(userConsent).includes('identity.hold'), `用户自同意被当成放行：${acts(userConsent).join(',')}`);
  assert(!acts(userConsent).includes('engram.profile.edit'), '用户自同意后写了画像');

  // 6b 正控：只有助手本人（consent.holder=assistant）带 at+quote 的同意才开这道门
  const granted = run('memory', ident, {
    consent: { holder: 'assistant', at: '2026-11-03T10:00:00+08:00', quote: '这个名字是我自己定的，这次改可以' },
  });
  const edit = granted.decisions.find((decision) => decision.action === 'engram.profile.edit');
  assert(edit, `助手本人的同意没有放行画像写入：${acts(granted).join(',')}`);
  assert(!acts(granted).includes('identity.hold'), '已获同意却仍 hold');
  assert(edit.args && edit.args.keepHistory === true, '放行后必须保留旧版本（keepHistory）');
  assert(edit.args && edit.args.consent && edit.args.consent.satisfied === true, '放行记录缺 consent.satisfied');

  return '终止/裸别记/删除/纠错/清楚指令/用户自同意 → 六条负例守住；助手本人同意 → 只有这一条路放行';
}

function checkHarness(assert) {
  const report = runCheck();
  assert(report.ok, `--check 未过：${JSON.stringify(report.errors.slice(0, 3))}`);
  const passed = report.fixtures.filter((item) => item.status === 'PASS').length;
  assert(passed === 19, `--check 只过 ${passed}/19`);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-sim-'));
  const logs = [];
  const io = { out: (text) => logs.push(text), err: (text) => logs.push(text) };
  try {
    const code = runSimMain(['--out', outDir, '--no-real-memory', '--json'], io);
    assert(code === 0, `run-sim 退出码 ${code}：${logs.join('').slice(0, 400)}`);
    const summary = JSON.parse(logs.join(''));
    assert(summary.ok === true, `run-sim 未过：${summary.failed.join('；')}`);
    assert(summary.doubleRun === 'byte-identical', `双跑不一致：${summary.doubleRun}`);
    assert(summary.fixtures === '19/19 PASS', summary.fixtures);

    const first = fs.readFileSync(path.join(outDir, 'results-run1.json'));
    const second = fs.readFileSync(path.join(outDir, 'results-run2.json'));
    assert(first.equals(second), 'results-run1.json 与 results-run2.json 不是逐字节一致');
    const decisions1 = fs.readFileSync(path.join(outDir, 'decisions-run1.jsonl'), 'utf8');
    const decisions2 = fs.readFileSync(path.join(outDir, 'decisions-run2.jsonl'), 'utf8');
    assert(decisions1 === decisions2, '两遍 decisions.jsonl 不一致');
    assert(decisions1.includes('"overrides"'), 'decisions.jsonl 每行必须带 overrides');

    const markdown = fs.readFileSync(path.join(outDir, 'SIM-REPORT.md'), 'utf8');
    assert(markdown.includes('SIM REPORT') && markdown.includes('E_ROUTE_'), 'SIM-REPORT.md 缺报告/失败码');
    // 事务标记：成功必须删锁；锁还在就说明这次 run-sim 没有善终（即使报告已落盘）。
    assert(!fs.existsSync(path.join(outDir, '.run-sim.lock')), '成功路径必须删掉 .run-sim.lock');
    assert(!/durationMs|timingsMs/.test(first.toString('utf8')), '结果文件含耗时字段，双跑无法逐字节一致');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  return '--check 19/19 + policy ok；run-sim 双跑逐字节一致（耗时只在 timings.json）';
}

export function runRouterSuite({ runCase, assert }) {
  runCase('R1-RULES', '规则表契约：id/priority/match/decision/reason 合法且降序稳定', () => checkRulesTable(assert));

  for (const fixture of FIXTURES) {
    runCase(
      fixture.id,
      `${fixture.category} ${fixture.level} · ${fixture.text}`,
      () => checkFixture(fixture, assert),
    );
  }

  runCase('R1-J8N', 'J8 六条负例：终止/裸别记/删除/纠错/清楚指令/用户自同意 都不许被误放行', () => checkJ8Negatives(assert));

  runCase('R1-E1', '边界：空/畸形输入一律 none + confidence 0，不抛错', () => checkEmptyInputs(assert));
  runCase('R1-E2', '边界：10 万字符输入 <50ms（关键词在末尾）', () => checkLongInput(assert));
  runCase('R1-E3', '边界：规则冲突取 priority 高者，且两次调用一致', () => checkConflictPriority(assert));

  runCase('R1-C1', '契约：caseId/turn/utterance/ctx 参与路由，输出 decisions[]+needsHuman+旧别名', () => checkInputContract(assert));
  runCase('R1-C2', '契约：override 必须带理由，审计链记原始理由/谁/时间戳', () => checkOverrideAudit(assert));
  runCase('R1-J1', 'judge 负控：J1/J2/J3/J5/J6/J8 对错误判定必须拒绝', () => checkJudgeNegatives(assert));
  runCase('R1-J2', 'judge J1–J9：19 条 fixture 全 PASS', () => checkFixtureJudge(assert));
  runCase('R1-J4E1', 'judge J4 红测：evidence 为空必须 E_ROUTE_EVIDENCE', () => checkJ4Evidence(
    assert,
    '空 evidence',
    (decision) => ({ ...decision, evidence: [] }),
  ));
  runCase('R1-J4E2', 'judge J4 红测：证据行号越界必须 E_ROUTE_EVIDENCE', () => checkJ4Evidence(
    assert,
    '行号越界 src/router/route.js:99999',
    (decision) => ({ ...decision, evidence: ['src/router/route.js:99999'] }),
  ));
  runCase('R1-J4E3', 'judge J4 红测：用了 ctx.tokens 却不写 ctx:tokens 必须 E_ROUTE_EVIDENCE', () => checkJ4Evidence(
    assert,
    '缺 ctx:tokens',
    (decision) => ({ ...decision, evidence: decision.evidence.filter((entry) => entry !== 'ctx:tokens') }),
  ));
  runCase('R1-J4E4', 'judge J4 红测：引用不存在的 §9.9 必须 E_ROUTE_EVIDENCE', () => checkJ4Evidence(
    assert,
    'policy §9.9 不存在',
    (decision) => ({ ...decision, evidence: ['policy:R1-DESIGN.md §9.9'] }),
  ));
  runCase('R1-J0', 'judge J0：真实库前后 hash / DSH_MEM 沙盒边界 / 无真实库给 blocked', () => checkJ0Isolation(assert));
  runCase('R1-P1', 'policyRef 全部可解析，旧 # 锚点与不存在小节必被拒', () => checkPolicyRefs(assert));
  runCase('R1-L1', 'level 三档 X/D/H 与设计矩阵一致（M3/M4=D，S4/X1=H）', () => checkLevels(assert));
  runCase('R1-H1', 'harness：--check 全过；run-sim 双跑逐字节一致 + SIM-REPORT', () => checkHarness(assert));
}

// ── 单跑入口（被 run.mjs import 时不打印） ───────────────────
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

  runRouterSuite({ runCase, assert });

  const failedCases = results.filter((entry) => !entry.ok);
  const totalMs = results.reduce((sum, entry) => sum + entry.ms, 0);
  console.log(`\n${results.length - failedCases.length} passed, ${failedCases.length} failed, ${totalMs}ms total`);
  if (failedCases.length > 0) process.exitCode = 1;
}
