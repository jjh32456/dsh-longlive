// Host-visible configuration schema — 1.6.0 config surface.
//
// This module declares the plugin's user-facing configuration as a
// `schemastery` object so the Cordis loader can validate a row's `config` at
// activation and so schema-aware settings surfaces can describe it without a
// second source of truth. It is deliberately limited to the switches and
// limits documented in docs/CONFIG.md §1.1–1.9; Router's 50 advanced tuning
// keys keep their own tolerant normaliser (src/router/service/config.mjs) and
// are left as passthrough keys so alias migration, clamping and warning-based
// fallbacks are not shadowed by a schema default.
//
// The schema is optional debt, not a second runtime config read: every default
// below mirrors the value the 1.6.0 code already falls back to (including the
// 1.6.0 safety defaults: autoTruncate off/dryrun and routerRuntime off). Where
// the runtime distinguishes "absent" from a value (routerRuntime vs
// shadowEnabled, routerProvider vs providerExplicit, and the three alias-mapped
// router keys), the field intentionally has no default.
//
// schemastery is a host-provided peer (`@deepseek-ai/schemastery >=3.18.5 <4`;
// the current host ships 3.18.5). A missing peer degrades to "no Config",
// exactly like 1.5.0, instead of making the plugin unimportable: the packaging
// suite imports src/index.js from a shallow copy with no node_modules.

import { createRequire } from 'node:module';

let z = null;
try {
  const require = createRequire(import.meta.url);
  const resolved = require('@deepseek-ai/schemastery');
  z = resolved?.default ?? resolved;
} catch {
  // Fall through to the ESM build (e.g. a future ESM-only peer).
  try {
    const imported = await import('@deepseek-ai/schemastery');
    z = imported?.default ?? imported;
  } catch {
    z = null;
  }
}

/** Whether a schemastery peer resolved at import time (test and doctor surface). */
export const CONFIG_SCHEMA_AVAILABLE = z !== null && typeof z?.object === 'function';

/** Chinese copy: every field's `''` fallback and the `zh` locale. */
const ZH = {
  $description: '会话长寿插件的功能开关与运行参数。修改后需重启宿主生效。',
  memoryRoot: '记忆根目录（只读展示）。显式路径必须已存在；留空则使用 <DSH home>/longlive-memory。',
  memRoot: 'memoryRoot 的兼容别名（只读展示）；两者同时设置时 memoryRoot 优先。',
  strictMemoryRoot: '未配置 memoryRoot 时直接报错，而不是回落到推导出的默认目录。',
  filterEnabled: '记忆准入过滤器：启动后异步分析 journal 与卡片（只读，默认开启）。',
  shadowEnabled: '旧配置兼容位：默认路由判定已关闭；要开启请显式设 routerRuntime=shadow 或 on。',
  autoConclusion: '结论回流：每轮结束时把命中触发规则的结论写入 topics/（默认关闭）。',
  surgeryRecovery: '启动时检查无人值守手术的恢复报告（默认开启）。',
  recoverOnStart: '启动时收尾或回滚未完成的可见截断事务（默认开启）。',
  keepEvents: 'session_truncate 默认保留的事件数（默认 20000）。',
  recentWriteWindowMs: '最近写入保护窗口；窗口内拒绝截断（默认 60000 毫秒）。',
  heartbeatMs: '活跃会话心跳间隔（默认 15000 毫秒；0 关闭自动写入）。',
  routerEnabled: '开启 Router 路由服务：判定工具调用并按策略记录/拦截（默认关闭）。',
  routerRuntime: '路由运行时模式：off / shadow / on（默认 off；要记录判定须显式设 shadow 或 on）。',
  routerProvider: 'Router 使用的 provider；留空则用 deepseek-official。',
  routerModel: 'Router 使用的模型（auto = 由宿主解析）。',
  routerPolicyProfile: '路由策略档名，指向 src/router/policies/<name>.json（默认 generic）。',
  routerSharedBoard: '共享大脑提示：把 board 摘要注入 agent/pre-step（默认关闭）。',
  routerRuntimeStatePath: '路由判定记录文件路径（默认 <memoryRoot>/.longlive/router-runtime.jsonl）。',
  routerRuntimeMaxRecords: '路由判定记录条数上限（默认 1000）。',
  routerTickMs: 'Router 定时 tick 间隔（默认 60000 毫秒）。',
  routerAutonomy: '路由自治级别：report / draft（默认 report）。',
  routerHintScope: '共享板提示作用域：root / all / off（默认 root）。',
  routerProposalEnabled: '第二道闸：允许 Router 写提案，不写工作区（默认关闭）。',
  routerApplyEnabled: '第三道闸：允许批准后的九步写入（默认关闭）。',
  routerL4MergeEnabled: '允许相邻小写合并（默认关闭）。',
  routerWakeEnabled: '允许 Router 唤醒会话（默认关闭）。',
  routerWriterLeaseMs: '写入租约时长（默认 120000 毫秒，夹取到 60000–120000）。',
  metrics: '工作集度量（D1/D4）：每轮追加一行账本；metrics:false 或 metrics.enabled:false 关闭。默认开启。',
  embedding: '自动想起的向量索引后端；仅在 autoRecall.enabled 时透传。默认关闭。',
  d2: {
    $description: '工具输出裁剪（D2）：超过上限的工具输出全文归档，只保留头尾内联。',
    enabled: '开启 D2 工具输出裁剪（默认关闭）。',
    maxInlineChars: '内联保留的最大字符数（默认 4096，范围 64–1000000）。',
    headRatio: '内联预算中头部的比例（默认 0.6，范围 0.2–0.8）。',
    skipTools: '永不裁剪的工具名（默认 ["read"]）。',
    trimErrors: '错误结果也裁剪（默认关闭）。',
  },
  d6: {
    $description: '工具面裁剪（D6）：第一轮冻结按任务挑选的工具清单，其余工具用 tool_search 申请。',
    enabled: '开启 D6 工具面裁剪（默认关闭）。',
    dryRun: '只记录判定，不实际裁剪工具面（默认关闭）。',
    log: '输出 [d6] 决策日志（默认开启）。',
    keepTools: '无论任务如何都保留的工具名（默认空）。',
  },
  autoRecall: {
    $description: '自动想起：按轮次从记忆库召回卡片并注入上下文。',
    enabled: '开启自动想起（默认关闭）。',
    topK: '每次召回的最大卡片数（默认 3，范围 1–10）。',
    budgetTokens: '每次召回的 token 预算（默认 2000，范围 200–2000）。',
    everyNTurns: '每 N 轮召回一次（默认 6）。',
  },
  identityCard: {
    $description: '身份卡：在每次对话前置注入 STATE.md 摘要。',
    enabled: '开启身份卡注入（默认关闭）。',
    path: '身份卡路径（默认 <memoryRoot>/STATE.md）。',
    maxChars: '身份卡最多注入的字符数（默认 800，范围 120–4000）。',
  },
  presenceBus: {
    $description: '共享大脑：消费其他会话写入总线的消息。',
    enabled: '开启共享大脑总线（默认关闭）。',
    pollMs: '总线轮询间隔（默认 3000 毫秒；0 关闭轮询）。',
    root: '总线根目录；留空则使用记忆根。',
  },
  autoMaintenance: {
    $description: '每日维护：本地午夜调度 consolidate 报告与 forget 候选清单。',
    enabled: '开启每日维护（默认关闭）。',
    consolidate: '维护时生成合并报告（默认开启）。',
    forget: '维护时生成遗忘候选清单（默认开启）。',
    runOnStart: '启动后立即补跑一次（默认开启）。',
    startDelayMs: '启动后延迟毫秒数（默认 500）。',
  },
  routerFace: {
    $description: '后台面（routerFace v1）：定时读取共享记忆，写 journal 与建议 outbox（默认关闭）。',
    enabled: '开启后台面（默认关闭）。',
    tickMs: 'tick 间隔（默认 60000 毫秒，范围 30000–900000）。',
    dailyTokenBudget: '每个本地日的 token 预算（默认 50000）。',
    maxContextTokens: '单次组装的上下文上限（默认 30000）。',
    dryRun: '只写 journal，不调用 LLM（默认开启）。',
    provider: '后台面 provider；留空则沿用宿主当前 provider。',
    model: '后台面模型（auto = 由宿主解析）。',
    maxSuggestions: '每次最多写入 outbox 的建议条数（默认 3，范围 0–10）。',
  },
  autoTruncate: {
    $description: '自动可见截断：在 turn/end 规划 log / dryrun / request（1.6.0 默认关闭，mode=dryrun）。',
    enabled: '开启自动可见截断（默认关闭；开启后仍默认只 dryrun，不写会话）。',
    mode: '模式：log / dryrun / request（旧值 apply 会被改写为 request）。',
    tokensThreshold: '触发截断的估算 token 阈值（默认 300000）。',
    minTurns: '触发截断的最小轮数（默认 12，严格大于）。',
    cooldownMinutes: '每会话冷却分钟数（默认 60）。',
    keepTurns: '至少保留的轮数（默认 12）。',
    keepTokens: '至少保留的估算 token 数（默认 80000）。',
    firstUserCapChars: '携带首条用户消息的字符上限（默认 4000）。',
    boundaryRetries: '边界不稳定时的重试次数（默认 3）。',
    appExe: 'runner 关闭/重启的应用路径；留空使用当前进程 exe。',
    profile: '写入 request 的 profile 标签（默认 desktop；runner 不传该参数）。',
  },
  hotTruncate: {
    $description: '热截断（compaction-hot-truncate 行）：只切已完成且早于保留窗口的整轮，不调 LLM。',
    mode: '模式：off / cut / auto（默认 cut）；cut 在宿主每步按阈值检查，auto 再加空闲时自动切。',
    retainTurns: '切完保留最近 4 轮完成对话（默认 4）。',
    retainTokens: '保留窗口的估算 token 下限（默认 8000）。',
    autoMinTokens: '自动切达到该估算 token 数才剪（默认 300000；手动 /compact 与溢出恢复不受此限）；每次切刀都会让前缀缓存失效，下一轮全价重算。',
  },
};

/** English copy: `en` is the locale fallback chain's base. */
const EN = {
  $description: 'Session-longlive feature switches and runtime options. Changes take effect after restarting the host.',
  memoryRoot: 'Memory root (display only). An explicit path must already exist; leave empty for <DSH home>/longlive-memory.',
  memRoot: 'Backward-compatible alias for memoryRoot (display only); memoryRoot wins when both are set.',
  strictMemoryRoot: 'Fail when memoryRoot is unset instead of falling back to the derived directory.',
  filterEnabled: 'Memory-admission filter: analyses the journal and cards asynchronously at startup (read-only; on by default).',
  shadowEnabled: 'Legacy compatibility: router evaluation is off by default; set routerRuntime=shadow or on to opt in.',
  autoConclusion: 'Conclusion write-back: writes trigger-matched conclusions into topics/ at turn end (off by default).',
  surgeryRecovery: 'Check the unattended-surgery recovery report at startup (on by default).',
  recoverOnStart: 'Finish or roll back an interrupted visible-truncation transaction at startup (on by default).',
  keepEvents: 'Default events kept by session_truncate (20000).',
  recentWriteWindowMs: 'Recent-write guard window; truncation is refused inside it (60000 ms).',
  heartbeatMs: 'Live-session heartbeat interval (15000 ms; 0 disables automatic writes).',
  routerEnabled: 'Enable the Router service: evaluate tool calls and record/deny them by policy (off by default).',
  routerRuntime: 'Router runtime mode: off / shadow / on (default off; set shadow or on to record evaluations).',
  routerProvider: 'Provider used by Router; empty means deepseek-official.',
  routerModel: 'Model used by Router (auto = resolved by the host).',
  routerPolicyProfile: 'Router policy profile under src/router/policies/<name>.json (generic by default).',
  routerSharedBoard: 'Shared-board hint: inject the board digest at agent/pre-step (off by default).',
  routerRuntimeStatePath: 'Router-decision record path (default <memoryRoot>/.longlive/router-runtime.jsonl).',
  routerRuntimeMaxRecords: 'Maximum router-decision records (1000).',
  routerTickMs: 'Router tick interval (60000 ms).',
  routerAutonomy: 'Router autonomy level: report / draft (report by default).',
  routerHintScope: 'Shared-board hint scope: root / all / off (root by default).',
  routerProposalEnabled: 'Second gate: allow Router to write proposals without touching the workspace (off by default).',
  routerApplyEnabled: 'Third gate: allow approved nine-step writes (off by default).',
  routerL4MergeEnabled: 'Enable merging of adjacent small writes (off by default).',
  routerWakeEnabled: 'Allow Router to wake sessions (off by default).',
  routerWriterLeaseMs: 'Writer lease duration (120000 ms, clamped to 60000–120000).',
  metrics: 'Working-set metrics (D1/D4): one ledger row per turn; `metrics: false` or `metrics.enabled: false` disables it. On by default.',
  embedding: 'Vector-index backend for auto-recall; passed through only when autoRecall.enabled. Off by default.',
  d2: {
    $description: 'Tool-output trimming (D2): archive oversized tool results and keep only head/tail inline.',
    enabled: 'Enable D2 tool-output trimming (off by default).',
    maxInlineChars: 'Maximum inline characters kept (default 4096, range 64–1000000).',
    headRatio: 'Share of the inline budget given to the head (default 0.6, range 0.2–0.8).',
    skipTools: 'Tool names that are never trimmed (default ["read"]).',
    trimErrors: 'Trim error results too (off by default).',
  },
  d6: {
    $description: 'Tool-surface trimming (D6): freeze a task-derived tool list at turn 1 and expose the rest through tool_search.',
    enabled: 'Enable D6 tool-surface trimming (off by default).',
    dryRun: 'Log the decision without trimming the surface (off by default).',
    log: 'Emit [d6] decision logs (on by default).',
    keepTools: 'Tool names kept regardless of the task (empty by default).',
  },
  autoRecall: {
    $description: 'Auto-recall: retrieve cards from the memory store and inject them into context every N turns.',
    enabled: 'Enable auto-recall (off by default).',
    topK: 'Maximum cards per recall (default 3, range 1–10).',
    budgetTokens: 'Token budget per recall (default 2000, range 200–2000).',
    everyNTurns: 'Recall once every N turns (default 6).',
  },
  identityCard: {
    $description: 'Identity card: prepend a STATE.md digest at the start of the conversation.',
    enabled: 'Enable identity-card injection (off by default).',
    path: 'Identity-card path (default <memoryRoot>/STATE.md).',
    maxChars: 'Maximum characters injected (default 800, range 120–4000).',
  },
  presenceBus: {
    $description: 'Shared brain: consume messages other sessions write to the bus.',
    enabled: 'Enable the shared-brain bus (off by default).',
    pollMs: 'Bus polling interval (default 3000 ms; 0 disables polling).',
    root: 'Bus root directory; empty means the memory root.',
  },
  autoMaintenance: {
    $description: 'Daily maintenance: schedule consolidate reports and forget candidates at local midnight.',
    enabled: 'Enable daily maintenance (off by default).',
    consolidate: 'Produce a consolidate report during maintenance (on by default).',
    forget: 'Produce a forget-candidate list during maintenance (on by default).',
    runOnStart: 'Run once shortly after startup (on by default).',
    startDelayMs: 'Startup delay in milliseconds (default 500).',
  },
  routerFace: {
    $description: 'Background face (routerFace v1): read shared memory on a timer and write a journal and suggestion outbox (off by default).',
    enabled: 'Enable the background face (off by default).',
    tickMs: 'Tick interval (default 60000 ms, range 30000–900000).',
    dailyTokenBudget: 'Token budget per local day (default 50000).',
    maxContextTokens: 'Context cap per assembly (default 30000).',
    dryRun: 'Write the journal only; do not call the LLM (on by default).',
    provider: 'Provider for the background face; empty uses the host current provider.',
    model: 'Model for the background face (auto = resolved by the host).',
    maxSuggestions: 'Maximum suggestions written to the outbox (default 3, range 0–10).',
  },
  autoTruncate: {
    $description: 'Automatic visible truncation: plan log / dryrun / request at turn end (off by default in 1.6.0, mode=dryrun).',
    enabled: 'Enable automatic visible truncation (off by default; even when enabled it only dry-runs unless you change mode).',
    mode: 'Mode: log / dryrun / request (the legacy value apply is rewritten to request).',
    tokensThreshold: 'Estimated-token threshold that triggers truncation (default 300000).',
    minTurns: 'Minimum turns before truncation may trigger (default 12, strictly greater).',
    cooldownMinutes: 'Per-session cooldown in minutes (default 60).',
    keepTurns: 'Minimum turns kept (default 12).',
    keepTokens: 'Minimum estimated tokens kept (default 80000).',
    firstUserCapChars: 'Cap for the carried first user message (default 4000).',
    boundaryRetries: 'Retries when the boundary is unstable (default 3).',
    appExe: 'Application path the runner closes/restarts; empty uses the current process executable.',
    profile: 'Profile label written into the request (default desktop; the runner does not pass it).',
  },
  hotTruncate: {
    $description: 'Hot truncate (compaction-hot-truncate row): cuts only completed turns older than the retention window, with no LLM call.',
    mode: 'Mode: off / cut / auto (cut by default); cut is checked each step, auto also cuts at idle.',
    retainTurns: 'Keep the last 4 completed turns after a cut (default 4).',
    retainTokens: 'Minimum estimated tokens kept in the retention window (default 8000).',
    autoMinTokens: 'Automatic cuts happen only once the estimated token count reaches this value (default 300000; manual /compact and overflow recovery ignore it); every cut invalidates the prefix cache, so the next turn re-bills at full price.',
  },
};

function schemaOf() {
  const d2 = z.object({
    enabled: z.boolean().default(false).description(ZH.d2.enabled),
    maxInlineChars: z.number().default(4096).description(ZH.d2.maxInlineChars),
    headRatio: z.number().default(0.6).description(ZH.d2.headRatio),
    skipTools: z.array(z.string()).default(['read']).description(ZH.d2.skipTools),
    trimErrors: z.boolean().default(false).description(ZH.d2.trimErrors),
  }).collapse();

  const d6 = z.object({
    enabled: z.boolean().default(false).description(ZH.d6.enabled),
    dryRun: z.boolean().default(false).description(ZH.d6.dryRun),
    log: z.boolean().default(true).description(ZH.d6.log),
    keepTools: z.array(z.string()).default([]).description(ZH.d6.keepTools),
  }).collapse();

  const autoRecall = z.object({
    enabled: z.boolean().default(false).description(ZH.autoRecall.enabled),
    topK: z.number().default(3).description(ZH.autoRecall.topK),
    budgetTokens: z.number().default(2000).description(ZH.autoRecall.budgetTokens),
    everyNTurns: z.number().default(6).description(ZH.autoRecall.everyNTurns),
  }).collapse();

  const identityCard = z.object({
    enabled: z.boolean().default(false).description(ZH.identityCard.enabled),
    path: z.string().default('<memoryRoot>/STATE.md').description(ZH.identityCard.path),
    maxChars: z.number().default(800).description(ZH.identityCard.maxChars),
  }).collapse();

  const presenceBus = z.object({
    enabled: z.boolean().default(false).description(ZH.presenceBus.enabled),
    pollMs: z.number().default(3000).description(ZH.presenceBus.pollMs),
    root: z.string().description(ZH.presenceBus.root),
  }).collapse();

  const autoMaintenance = z.object({
    enabled: z.boolean().default(false).description(ZH.autoMaintenance.enabled),
    consolidate: z.boolean().default(true).description(ZH.autoMaintenance.consolidate),
    forget: z.boolean().default(true).description(ZH.autoMaintenance.forget),
    runOnStart: z.boolean().default(true).description(ZH.autoMaintenance.runOnStart),
    startDelayMs: z.number().default(500).description(ZH.autoMaintenance.startDelayMs),
  }).collapse();

  const routerFace = z.object({
    enabled: z.boolean().default(false).description(ZH.routerFace.enabled),
    tickMs: z.number().default(60000).description(ZH.routerFace.tickMs),
    dailyTokenBudget: z.number().default(50000).description(ZH.routerFace.dailyTokenBudget),
    maxContextTokens: z.number().default(30000).description(ZH.routerFace.maxContextTokens),
    dryRun: z.boolean().default(true).description(ZH.routerFace.dryRun),
    provider: z.string().default('').description(ZH.routerFace.provider),
    model: z.string().default('auto').description(ZH.routerFace.model),
    maxSuggestions: z.number().default(3).description(ZH.routerFace.maxSuggestions),
  }).collapse();

  const autoTruncate = z.object({
    enabled: z.boolean().default(false).description(ZH.autoTruncate.enabled),
    mode: z.string().default('dryrun').description(ZH.autoTruncate.mode),
    tokensThreshold: z.number().default(300000).description(ZH.autoTruncate.tokensThreshold),
    minTurns: z.number().default(12).description(ZH.autoTruncate.minTurns),
    cooldownMinutes: z.number().default(60).description(ZH.autoTruncate.cooldownMinutes),
    keepTurns: z.number().default(12).description(ZH.autoTruncate.keepTurns),
    keepTokens: z.number().default(80000).description(ZH.autoTruncate.keepTokens),
    firstUserCapChars: z.number().default(4000).description(ZH.autoTruncate.firstUserCapChars),
    boundaryRetries: z.number().default(3).description(ZH.autoTruncate.boundaryRetries),
    appExe: z.string().default('').description(ZH.autoTruncate.appExe),
    profile: z.string().default('desktop').description(ZH.autoTruncate.profile),
  }).collapse();

  // Hot truncate lives on the separate `compaction-hot-truncate` row, but the
  // engine accepts the same `hotTruncate` block; mirror its defaults here so a
  // schema-aware settings surface documents the engine's contract instead of
  // letting a second, drifted copy of 6 turns / 30k tokens circulate.
  const hotTruncate = z.object({
    mode: z.string().default('cut').description(ZH.hotTruncate.mode),
    retainTurns: z.number().default(4).description(ZH.hotTruncate.retainTurns),
    retainTokens: z.number().default(8000).description(ZH.hotTruncate.retainTokens),
    autoMinTokens: z.number().default(300000).description(ZH.hotTruncate.autoMinTokens),
  }).collapse();

  return z.object({
    memoryRoot: z.string().description(ZH.memoryRoot).disabled(),
    memRoot: z.string().description(ZH.memRoot).disabled(),
    strictMemoryRoot: z.boolean().default(false).description(ZH.strictMemoryRoot),
    filterEnabled: z.boolean().default(true).description(ZH.filterEnabled),
    shadowEnabled: z.boolean().default(true).description(ZH.shadowEnabled),
    autoConclusion: z.boolean().default(false).description(ZH.autoConclusion),
    surgeryRecovery: z.boolean().default(true).description(ZH.surgeryRecovery),
    recoverOnStart: z.boolean().default(true).description(ZH.recoverOnStart),
    keepEvents: z.number().default(20000).description(ZH.keepEvents),
    recentWriteWindowMs: z.number().default(60000).description(ZH.recentWriteWindowMs),
    heartbeatMs: z.number().default(15000).description(ZH.heartbeatMs),

    routerEnabled: z.boolean().default(false).description(ZH.routerEnabled),
    routerRuntime: z.string().description(ZH.routerRuntime),
    routerProvider: z.string().description(ZH.routerProvider),
    routerModel: z.string().default('auto').description(ZH.routerModel),
    routerPolicyProfile: z.string().default('generic').description(ZH.routerPolicyProfile),
    routerSharedBoard: z.boolean().default(false).description(ZH.routerSharedBoard),
    routerRuntimeStatePath: z.string().description(ZH.routerRuntimeStatePath),
    routerRuntimeMaxRecords: z.number().default(1000).description(ZH.routerRuntimeMaxRecords),
    routerTickMs: z.number().default(60000).description(ZH.routerTickMs),
    routerAutonomy: z.string().default('report').description(ZH.routerAutonomy),
    routerHintScope: z.string().default('root').description(ZH.routerHintScope),
    // No defaults on the three alias-mapped gates: a materialised default would
    // win over routerProposalsEnabled / routerMergeEnabled / routerLeaseTtlMs
    // before normalizeRouterConfig gets to migrate the legacy key.
    routerProposalEnabled: z.boolean().description(ZH.routerProposalEnabled),
    routerApplyEnabled: z.boolean().default(false).description(ZH.routerApplyEnabled),
    routerL4MergeEnabled: z.boolean().description(ZH.routerL4MergeEnabled),
    routerWakeEnabled: z.boolean().default(false).description(ZH.routerWakeEnabled),
    routerWriterLeaseMs: z.number().description(ZH.routerWriterLeaseMs),

    metrics: z.any().description(ZH.metrics),
    embedding: z.any().description(ZH.embedding),

    d2,
    d6,
    autoRecall,
    identityCard,
    presenceBus,
    autoMaintenance,
    routerFace,
    autoTruncate,
    hotTruncate,
  }).description(ZH.$description).i18n({ zh: ZH, en: EN });
}

/**
 * The plugin's Config export. `undefined` is a supported form: the loader then
 * keeps the raw row config, which is exactly the 1.5.0 behaviour when the peer
 * schemastery cannot be resolved in the current installation.
 */
export const Config = CONFIG_SCHEMA_AVAILABLE ? schemaOf() : undefined;
