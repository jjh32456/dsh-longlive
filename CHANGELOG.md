# 变更记录

> 本文件只保留用户可读的功能与修复摘要；内部开发日志单独保存，不随发布包分发。

## 1.8.12 — 2026-11-27

**包名变更（2026-11-27）**：npm 包名由 `@jjh32456/dsh-longlive` 改为 `@jjh32456/longlive`；旧包已整包删除，旧版本号不可再复用；本版为新包首版。安装名、doctor 路径、profile 配置键（`@jjh32456/longlive#session-longlive`）随之变化。

**发布包修复：安装包内可直接运行验收脚本；真根已迁移时验收显式拒绝。**

- `package.json` files 白名单加入 `test/fixtures/pre-step-container.mjs`：修复 1.8.11 包里
  `scripts/acceptance-1.8.11.mjs` 因缺该 fixture 而 `ERR_MODULE_NOT_FOUND`（1.8.11 包审计只做了
  `node --check`，未实际执行验收脚本）。
- `scripts/acceptance-1.8.11.mjs` 增加已迁移真根守卫：plan 无 pending（cards/extracts/targets/edges 全 already）时
  返回显式 `E_ALREADY_MIGRATED`（exit 2），不再给出 e1/e7/n5 的误导性失败；未迁移副本上仍为 14/14。
  已知边界同步登记 `kb-acceptance-requires-unmigrated-root` / `kb-package-acceptance-fixture-shipped`。
- **隐私修复（npm 包面）**：`src/memory/lifecycle-plan.json`（逐字含真实记忆内容）与
  `scripts/acceptance-1.8.11.mjs`（个人名/真实库绝对路径）不再随 npm 包发布；迁移 CLI 的默认计划改为
  「显式 `--plan` > `<memoryRoot>/.longlive/lifecycle-plan.json` > 仓库内路径」，缺失时给
  `E_PLAN_MISSING` 明确指引；验收脚本改为仓库内门禁（repo-only）。
- 无运行时行为变化；插件运行时代码与 1.8.11 相同（仅打包清单、迁移 CLI 计划解析与验收脚本）。

## 1.8.11 — 2026-11-26

**记忆网络 + 蒸馏：关系边、卡生命周期、排序与迁移工具。**

- 网络层：新增 `src/recall/edges.js`（8 类边：supersedes / superseded_by / deprecated_by /
  conflicts_with / answers_with / derived_from / mentions / same_topic；1-hop 扩展，按
  deprecated_by > conflicts_with > superseded_by > answers_with 优先级；evidence 带
  quote/path/confidence；坏边 fail-open 不挡召回）。`scripts/edges-build.mjs` 从
  `.longlive/recall/links.jsonl` 构建 `.longlive/recall/edges.jsonl`（幂等、原子写、坏引用计数、
  `--dry-run`）。
- 蒸馏层：新增 `src/memory/lifecycle.js`，卡 frontmatter 独立 `lifecycle: canonical|historical`
  （不碰 `status`）；historical 默认不进注入，显式历史查询放行并标「历史口径」；canonical 优先排序。
- 召回：link 命中与文本召回合并统一排序（lifecycleRank 主键 + 归一化分数）；memory_recall 工具层
  对 historical 降权 ×0.3（显式历史查询不降权）；evidence-package/v1 anchors 增 `lifecycle` / `edge`。
- 迁移：新增 `scripts/migrate-lifecycle.mjs`（`--mode plan|dry-run|apply|rollback`）。apply 一次性
  快照原文、按 apply 前行号替换、历史卡收原始整行与原始 sha、无 frontmatter 卡只写 lifecycle；
  校验失败 `E_APPLY_VERIFY` + 自动还原；二次 apply 幂等；rollback 保留 apply 审计并写 rollback 审计；
  并发冲突 `E_ROLLBACK_CONFLICT` fail-closed；真根守卫 realpath + junction/别名拒绝。
- 验收：新增 `scripts/acceptance-1.8.11.mjs`（14 cases：e1–e9 + n1–n5；含 handover
  body/frontmatter/provenance、dry-run 四下游、真库只读 digest）。
- 预算：注入默认 2000 tokens（SPEC D3）；`DEFAULTS.budget=1200` 仅未接线兜底，生产 config 传 2000。
- 已知边界：真实根迁移会改卡/INDEX，需显式 `--allow-real-root` 并由用户批准后执行（回滚用
  `--mode rollback`，备份在 `.longlive/lifecycle-migrations/<migrationId>/backup/`）；无种子 CSV 时
  `links.jsonl` 不重建；`acceptance-1.8.11.mjs` 的 knownBoundaries 文本写「迁移 CLI 不在包内」是
  1.8.11 打包前的旧状态，1.8.11 包已把两个脚本加入 `files`。

## 1.8.10 — 2026-11-26

**自动截断的阈值口径修正：外部日志阈值与模型上下文线分开（默认 12M token ≈ 60MB），默认 dryrun 不变。**

- 旧默认 `autoTruncate.tokensThreshold` 继承 `INPUT_COMPACT_AT_TOKENS`（350000，模型上下文线），
  实测在重度工具输出下约 55 分钟就把 1.8MB 会话日志切一次。350k 是上下文指标，不是外部日志尺寸。
- 新默认 `AUTO_TRUNCATE_LOG_TOKENS = 12_000_000`（本机实测 ≈5 B/token，≈60MB 日志）。
  `compaction-hot-truncate.autoMinTokens` 仍是 350000（上下文侧），两者不再互相继承。
- 不再把 `fold.triggerTokens` 映射成自动截断阈值（1.8.3 的这条映射就是混用来源）。
- 默认 `mode: dryrun` 不变：只评估、不写请求、不关应用；`request` 模式才会由外部 watchdog 自动切，
  且不会询问——要人工确认就保持 dryrun。
- 收录 1.8.9 的两项修复：压缩检查点切点边界、ACP 桥接的真人消息判定（1.8.9 因 npm 上已有 staged
  版本（E409）未能发布，1.8.10 一并发出）。

## 1.8.9 — 2026-11-26

**自动截断边界修复：压缩检查点不再让切点死锁；ACP 桥接的真人消息按真人消息处理。**

- 现场：一个 12.0MB 会话在 `keepTurns=6, keepTokens=240000` 下每次评估都 `infeasible`
  （`VISIBLE_REPLACEMENT_STRADDLES_CUT`）。日志里有一个 context 压缩检查点（`user/message`，
  `surfaceOp.replace(startSeq=8190)`）；keepTurns 算出的切点落在它替换的跨度内，旧实现只会把
  切点往回退（保留更多轮），每退一步仍跨在检查点上，于是同一会话永远切不动。
- 修复 1（规划期边界）：`chooseBoundary` 识别「保留区里、替换了切点之前跨度的检查点」，把切点
  前移到检查点之后（少保留几轮，切后体积只减不增）；同时禁止「首轮必须有真人消息」的回退
  再次跨回检查点。检查点若位于最后一轮（没有更晚的边界可落），仍按原逻辑报 infeasible。
- 修复 2（真人消息判定）：`isUserAuthoredMessage` 接受 `kind:"user"` + `rpcId`、无
  `clientTimeZone` 的消息（ACP / agents-anywhere 桥接的真实用户消息就是这种形状）。此前它们
  全被判成机器文本，桥接会话没有任何一轮「有真人消息」，首条消息 carry 与边界守卫都会退化。
  注入块仍由文本黑名单拦截（检查点文本先命中黑名单即判机器）。
- 测试：新增 A21（保留区检查点 → 切点跳到检查点之后）和 A1 的 ACP 消息断言；diagnostics 的
  straddle 用例改为断言规划期直接给出合法边界。`test/run.mjs` 364 passed / 0 failed /
  4 skipped（T7 等 opt-in 项无 key，照旧 skip）。
- 已知边界：若一条「伪装成 user 行」的机器消息既无 `clientTimeZone`、又带 `rpcId`、文本也不
  命中黑名单，会被当作真人消息（可能被 carry 成会话起点）。这是为解开「桥接会话永不截断」的
  死锁付出的代价，已在发布说明里单独登记。

## 1.8.8 — 2026-11-26

**自动想起：任务消息当轮强制触发 + 高频词直连老记忆 + 越用越准的自学习链路（M2）。**

用户反馈「说触发很不灵敏，必须强制触发，说要做什么的时候直接就指向老记忆」。1.8.8 把自动想起从
"按轮次/话题切换触发"改成"强制触发 + 链路直连"：

- **① 自动回忆指向**：每条真实用户任务消息在 `agent/pre-step` 第一步（`step === 1`）强制召回一次，
  不再等 everyNTurns、也不再被 quiet 门控挡住；同一轮最多一次。常用词/项目词经种子映射与学习链路
  **直接指向**老记忆卡，命中即注入（日志 `source:"link"`），之后仍跑一遍原关键词/语义召回补漏。
  每轮 ≤5 张卡 / ≤2000 tokens，已注入卡去重，纯应答（「好」「继续」「谢谢」「收到」等去空白后
  ≤6 字符且无任务动词）不刷屏；隐私命中卡（`local_only` / `privacyScan`）整卡不注入；召回异常
  fail-open，不挡这一轮。开关 `autoRecall.forceOnUserMessage`（默认 `true`；`false` = 完全回落
  1.8.7 行为）、`recall.links.enabled`（默认 `true`；`false` = 只保留关键词/语义召回）。
- **② 高频词学习（self-learning links）**：种子表来自真实历史用户消息的统计产物（词频 `n` / 出现
  卡数 `df` / 卡内命中位置），`scripts/recall-links-build.mjs` 把 `LINKS-SEED-v3.csv` 转成
  `<memoryRoot>/.longlive/recall/links.jsonl`（幂等、原子写、写前备份、写后审计、`--dry-run`
  统计、`--rollback <备份>` 回滚）。每行一条边 `{term, cardPath, weight, source:"seed"|"learned",
  evidence:{n,df,tier,matchKind,cooccurCount,…}, createdAt, updatedAt}`，**只存词 + 卡路径 + 计数/
  时间，不存原句**。每轮记录「消息里的词 × 注入的卡」共现与事后反馈：对/就是这个/没错 → 权重 `+1`；
  不对/不是这个/错了 → `-1.5`（≤0 删边）；默认 30 天未用按 `0.85`/周期衰减；上限单 term ≤5 张卡、
  单卡 ≤50 个 term、单轮直连 ≤5 张。写回 tmp → rename 原子写 + 备份（保留 5 份）+ 追加审计
  `.longlive/recall/links-audit.jsonl`；链路文件损坏（坏行 >50%）按不可写处理，召回 fail-open。
  已知边界：反馈是弱信号（用户纠正不一定是卡错），共现不等于因果——见 docs/AUTO-RECALL.md「误归因风险」。
- **③ 旧记忆适配**：老卡文件不动、正文不改，按原 frontmatter（`title` / `aliases` / `scope_in`）
  读取；统一门面就是 `links.jsonl` 的「词 → cardPath」边（外加原有实体别名通道），构建幂等、可备份
  可回滚。
- **归档兜底（新增可选模块 `src/recall/archive-search.mjs`）**：常规召回 + 链路命中合计为 0 时，才
  尝试从历史会话归档里检索；模块不存在或调用失败时静默回落（日志 `archiveUnavailable:true`，不算
  成功、不假报命中）；命中则注入 【自动想起·归档】 块（≤3 条 / ≤800 tokens，每条带
  `session` / `turn` / 归档文件出处，正文过同一个隐私扫描，日志 `source:"archive"`）。
- **审计日志**：`recall-log.jsonl` 每行新增 `trigger`（强制路径 `"forced"`，周期路径仍是原值）、
  `why`（强制路径固定 `"user-task"`；是否真的注入看 `injected` / `outcome`）、`forced`、`query`
  （脱敏摘要 ≤200 字符）、`elapsedMs`、`outcome`、`injected[].source`（`link` / `archive` / `file`）、
  `link{enabled,matchedTerms,injectedCount,tokens}`、`archiveUnavailable`；失败仍 `error:true`
  且 fail-open。
- 配置键（均为 passthrough，缺省/畸形值不抛、设置面板 schemastery 节点数不变）：`autoRecall.forceOnUserMessage`、
  `recall.links.{enabled,learn,minWeight,maxCardsPerTurn,maxCardsPerTerm,maxTermsPerCard,maxEdges,decayAfterDays,decayFactor,decayFloor,confirmDelta,denyDelta}`。
- 文档：`docs/AUTO-RECALL.md`（①/②/③ + 归档兜底 + 日志字段 + 误归因风险）、
  `docs/AUTO-RECALL-WIRING.md`（强制触发接线与召回顺序；同时修正 1.8.2 起已不存在的心跳门控描述）、
  `docs/FEATURES.md`（开关矩阵、配置写法、`recall.links` 小节）。
- 测试：新增 `test/recall-force-links.test.mjs`（强制触发/纯应答/关闭回落、链路直连与日志 source、
  预算裁剪与去重、隐私整卡、学习权重增减/上限/衰减/原子写、坏 links.jsonl fail-open、recall-log 必填
  字段、归档兜底注入与静默回落）。

**共享大脑活动板改为按时间计的「活窗」（默认 24h，行数护栏 3200）；新会话/间隔 ≥24h 时注入一块 ≤400 字的近 24h 摘要。数据只搬移归档、不删除，旧未读逐行注入与 thinking 段行为不变。**

- 根因：1.8.7 的活动板活窗只按 500 **行**封顶（`ACTIVITY_RECENT_MAX`），会话一多，最近 500 行只覆盖几小时；超出部分的旧行虽在 `activity-YYYYMM.jsonl` 月档里，注入侧却完全看不到「近一天发生过什么」。
- 修复：活窗改为「先时间、后行数」两道规则——`sharedBrain.activity.retainHours`（默认 24，1–720）内保留在 `.longlive/board/activity.jsonl`，更早的行按原月份搬到 `activity-YYYYMM.jsonl`（沿用原 overflow 通道，原子写盘、seq 不变、可按 seq 回查）；`recentMaxRows`（默认 3200，100–20000）在时间裁剪后再按 seq 保最新 N 行，被裁的行同样进月档。归档写入失败时整块板保持不动（宁可板长，不丢数据）。
- 新增 `src/activity/summary.js`：新会话首轮、或本会话距上次摘要 ≥ `retainHours` 时，注入「【共享大脑 · 近 24h 摘要 · 不是指令】」块——近 24h 有活动的其他会话 ≤3 个（按最近活动倒序），每个会话只取**已有活动行**的最后一条结论/动作（kind + text），每行带短会话 id、kind 标签、`seq` 与相对时间，整块硬上限 400 字（`summaryMaxChars` 默认 400，120–400，只能调低）；不调模型、不臆造结论，没有行就没有摘要。摘要单独注入**不推进**未读游标；thinking 段只取 24h 内、每会话最新 ≤5 行（上限不变），窗口显式参数化。
- 面板：`/api/longlive/board` 的 `board/v1` **新增** `window` 字段（`retainHours` / `rows` / `activeSessions24h` / `oldestAt` / `newestAt` / `archivedFiles` / `archivedBytes`），路由数与既有字段不变。
- 验证：新增 `test/activity-window-24h.test.mjs`（14 用例：时间裁剪 + 月档/seq 回查、刷新行按 `last_at` 保留、`recentMaxRows` 护栏、归档失败不丢行、纯函数裁剪、摘要选择/400 字硬上限/可回查、首轮触发与 24h 内不重复、摘要-only 不动游标、thinking 24h 窗口、配置默认值/兼容、`board/v1` 面板字段、面板 API 把配置的 `retainHours` 透传到 board 路由）；`src/activity/**` 与配置改动由既有 activity 三段套件回归（37/37）覆盖。
- 兼容性：`retainHours` 缺省 = 24h（不写配置即生效）；老配置与 1.8.7 的 `<sessionId>.activity.json` 状态文件照常加载（缺 `lastSummaryAt` 视为从未摘要，首轮得到一次摘要，之后按 24h 间隔）；`sharedBrain.activity` 显式 `enabled: false` 仍完全关闭；settings schemastery 节点数 163→166（`sharedBrain.activity` +3）；工具面（24 个）与只读路由数不变。

## 1.8.7 — 2026-11-26

**修复：router 启动校验在 budget overshoot 后误报 E_LEDGER_TAMPERED（audit_used_regressed），router 因此永久阻塞。**

- 根因：`src/router/service/service.mjs` 的 budget overshoot 分支只写 `budget.overshoot` 就 halt，不写 `budget.settle`；账本侧存在对应 settle 行。下一次启动时 `verifyRunAnchors` 只累加 `budget.settle`，审计已用额度小于账本 used → `anchor verification failed: audit_used_regressed` → router blocked，重启仍复现。
- 修复：`src/router/service/reconcile.mjs` 的 `sumAuditSettled()` 在同一 reservation 没有对应 settle 时计入 `budget.overshoot.applied`；`verifyRunAnchors()` 改用 `sumAuditSettled(auditRecords, runId)`，不再用只数 settle 的内联 reduce。
- 验证：修复前后同一 run 由 `ok:false (E_LEDGER_TAMPERED)` 变为 `ok:true`；全部已存 run 的 `verifyRunAnchors` 均 ok；`reconcileRun` delta=0；宿主重启后 router `state=running`，warnings/alerts 为空。
- 兼容性：其余行为、配置项、工具面与 1.8.6 一致；不迁移数据、不改写历史账本与锚。

## 1.8.6 — 2026-11-18

**新增 `autoProcedure`：本地规则蒸馏的 procedure 候选（默认关闭；设计经独立红队两轮复审 PASS）。**

- 任务结束后（`turn/end` 且 `reason.kind === 'completed'`，排除 router/注入 turn）**异步**用纯本地规则把可复用工具步骤整理成 procedure 卡四段式**候选**；只写 `<memoryRoot>/.longlive/staging/auto-cards/procedures/`，系统永不自动转正，转正唯一入口仍是 lead 的 `memory_procedure save`（工具签名不变）。
- 默认 `enabled: false`：关闭时零注册、零读盘、零定时器；解析/写盘全在 `setTimeout` 异步段，turn 尾路径只做字段过滤 + `schedule()`；采样上限 `maxDecompressBytes`（默认 8 MiB，硬上限 64 MiB）：解压后文本超限时改用**尾段窗口**解析（只解压覆盖刚结束 turn 的最后若干帧），只有单帧超限或尾段覆盖不到目标 turn 才记 `reject reason=too_big`；解析失败重试 ≤1。空闲门（`idleMs`）按最后一次真实 `turn/end` 时刻计算，调度本身不推进空闲时钟（`delayMs < idleMs` 也不会无限顺延）。
- 候选配 sidecar（schema `autoprocedure-candidate/v1`）：来源、digest 锚点证据（`sessionId + turn + seqStart/seqEnd + turnDigest`）、lint 结果、保留期；证据偏移分两种坐标空间（会话解压后 UTF-8 字节 / D2 redact 后落盘文本），D2 证据强制 `callId` 与双 hash，校验时重读 D2 meta 并核对 `turn` / `callId` / `originalSha256`；空证据集或缺少 session 锚点整条拒绝。落盘前一次性校验，失败整条丢弃并计数。
- 本地确定性 lint 5 类（危险动作 / 证据可验 / 与既有卡冲突 / 触发词 / 路径归一化）写进 `lint.issues[]`，无放行权；周期抽查失败只写 `stale` 报告，不改卡、不删文件、不移目录。
- 记账 `.longlive/logs/auto-procedure.jsonl`（append-store，固定字段 + `attemptId`，每次尝试恰好一行终态），**不写** `turns.jsonl`；`memory-state.json` 的 `autoProcedure` 在「已运行 ≥7 天且近 7 天零产出」时置 `stalled`，同因拒绝 ≥3 天体现在 `rejectTop.days`（`quota` / `ineligible` 是预期内拒绝，仍计入 `count`，不计入该告警天数）；候选保留期 30 天，过期只在 staging 内移动。
- B 模式（LLM 润色）默认关：必须显式 `llm.enabled: true`，写 `kind:"llm_enable_ack"` 账本行，经宿主 `ctx.get('llm').stream()` 流式契约调用（promise 式 `complete()` 不是宿主契约），prompt 只含已脱敏片段并再过隐私门，输出仍只进候选；provider 超时/不可用、输出不可解析或**预算耗尽**时都**回落本地 rules 草稿**并如实记 `llm_timeout` / `llm_unavailable` / `llm` 行（预算拒绝记 `llm` 行 `reason=budget`）——开启 B 只多不少。预算 30000/日、15000/次、2 次/日（`dailyLlmCalls` 统计真实调用尝试，成功/超时/不可用都算、预算拒绝不计，并与候选产出解耦）；无 usage 时按估算记账。默认 A 模式零 LLM、零 provider 探测。
- 配置：同一 `session-longlive` 树新增 `autoProcedure` 块（键与默认值见 [docs/CONFIG.md](docs/CONFIG.md) §1.4d）；设置面板 schemastery 节点 162→163（host peer 3.18.5 实测；1.8.5 基线 149 + autoProcedure 14），工具面（24 个）不变。
- 验证：新增 `test/autoprocedure/` 8 套件（开关冻结快照、A 模式零 LLM、证据 / 截断重排 / 多字节偏移 / 空证据拒绝 / D2 meta 核对、锁并发（2 进程 + 2 会话）、预算边界、idle 回归、≥40 MiB 大会话尾段采样、stalled、lint 5 类 + 注入 5 例、N3 账本对账、`turns.jsonl` 字节不变、周期抽查不改候选、MAJ-5 B 模式失败/预算后不减少候选；70 用例 69 pass / 1 skip）；全量套件 1585 passed / 0 failed；`scripts/check-no-personal-strings.mjs` 0 命中。

## 1.8.5 — 2026-11-15

**热修：③ 分层的 `filter` 模式在 1.8.4 会静默退化成 shadow（配置接线漏传 `tiering`）。**

- 根因：`src/index.js` 注册工具时手工拼装的 bound config 漏了 `tiering` 键，`session_grep` 侧读到的 `config.tiering` 永远是 `undefined`，`normalizeTiering` 于是取默认 `mode:'shadow'`。profile 里写 `tiering.mode:'filter'` 不报错、也不过滤，`session_grep` 响应里连 `tierFilter` 字段都不出现。
- 修复：把 `config.tiering` 传进 `registerTools`；新增回归测试 `test/wiring-tiering-config.test.mjs`（断言接线存在、工具层确实读该键、`normalizeTiering` 保留 `filter` 字面值）。
- 行为影响：只影响显式开 `filter` 的 profile；默认 `shadow` 行为与 1.8.4 完全一致——不改默认值、不改设置面板 schemastery 节点数、不迁移数据。
- 已知限制不变：回填（backfill）来的 tier 标签不被 filter 信任，filter 会退回时间窗口过滤（`warmDays` 默认 30），这是设计内兜底。

## 1.8.4 — 2026-11-15

**记忆升级 ②③④：跨会话交接卡 / 热温冷分层 / 主动浮现；全部默认关闭，兼容 1.8.3 行为与设置面板节点数不变；隐私与普适性修正。**

- ② 跨会话交接卡（`src/handoff/`）：每轮结束把「目标/已结论/未决/下一步/最近动作」upsert 成源会话最新卡；新会话首轮过 cwd→存活→相关性/实质→续接意图→预算→认领 六道门后注入 1 条 ≤281 码点隐藏消息；默认 `enabled:false`，`dryRun` 可先只选不注入。设计/红队见 `designs/02-handoff.v4.md`、`reviews/02-handoff.v4.round4.md`。
- ③ 热温冷分层（`src/memory/tiers.js`、`src/memory/event-index.js`）：`events.db` 增 `tier` 列与索引（hot/warm/cold，`warmDays` 默认 30）；默认 `mode:'shadow'` 只标注不过滤，`session_grep`/召回显式 `tier:'hot'|'warm'|'cold'|'all'` 才过滤。设计/红队见 `designs/03-tiers.v4.md`、`reviews/03-tiers.v4.round4.md`。
- ④ 主动浮现（`src/lifecycle/proactive.js`）：静默 ≥3h 回来时从 `topics/`+`handover/` 卡按话题相关度选 1 条 ≤300 字线索（每会话每本地日 ≤1；不调 LLM、不调工具）；默认 `enabled:false, dryRun:true`。设计/红队见 `designs/04-proactive.v4.md`、`reviews/04-proactive.v4.round4.md`。
- 默认关 = 1.8.3 行为：默认注册面（6 项 enabled、8 个 hook）、`session_grep` 响应、设置面板 schemastery 节点数 **153** 均不变；三个新配置键为 passthrough 叶子，缺省/畸形值不抛。
- 三条 kill switch：`DSH_LONGLIVE_DISABLE_HANDOFF=1`、`DSH_LONGLIVE_TIER_OFF=1`、`DSH_LONGLIVE_DISABLE_PROACTIVE=1`；环境变量优先于配置，设完重启宿主生效。
- 数据只增：`events.db` 迁移只加列/索引、不改写既有行（生产库副本 9,551 行升级前后逐行 sha256 不变），1.8.3 旧代码可正常 open/搜索/写入。
- 验证：三套集成 110 / 49 / 63 全绿；兼容/普适/隐私独立审计 92 断言、0 BLOCKING（2 个 MINOR 已修）；`node scripts/check-no-personal-strings.mjs` 扫 206 文件 0 命中。
- 已知限制：设置面板尚无 ②③④ 控件（只能改 profile YAML 或用 `delivery/enable.ps1`）；宿主未重启，真机 E2E 未验；面板 chip 未做。

## 1.8.3 — 2026-11-09

**阈值固化：共享窗口预算制（1M = 输入+输出共享窗口）。**

- 固定 THRESHOLD-FINAL-1.8.3：输出单轮 350K；正常预留 192K / 长输出 350K；输入折叠线 350K；正常输入硬截断触发线 757K / 长输出 599K（硬截断触发线）（公式 ≥，等号算超）；safety 50K。
- 触发改为共享窗口：hotTruncate.autoMinTokens=350K + autoTruncate turn/end 策略（无 pre-step 强制）；input+reserve+50K≥1M 安全硬触发；actual_output 只用于下一轮校准/告警；宿主不暴露主模型 max_tokens，350K 只是策略预留，超限分段由宿主/agent 处理。
- D5 扩展：estimatedInputTokens/estimatedOutputTokens/outputReserveTokens（只写不读；不可得为 null）。
- 折叠后对外口径：实测中位约 **52K**（23 次压缩）；目标 84K（52–84K）未实现（hotTruncate 无 targetTokens），未测出前不宣称。
- 成本：加权≈36.3 元/1000 轮（cache 命中 98.3%），全 miss 421.6，P99 输出档 1,131.4；权重 成本50/质量30/压缩次数20；不含摘要/思考 token（未验证）。
- 质量下限（v0.5）：冻结 golden set/rubric；质量分=top1×0.4+top3×0.3+人工通过率×0.3，样本≥100（代码≥25），阈值≥0.75；不达标回 **150K**；7 天灰度。

## 1.8.2 — 2026-11-09

**减法设计 v4：停写/停读 AutoCard、删周期召回、INDEX/reconcile 去 auto 统计、recall-log 前向仪表。**

- D1：capture 主路径与 WAL replay 不再写 AutoCard；冷归档 cards.jsonl 不增长。
- D2：auto-recall / memory_recall / memory_recall_v2 不再读取 AutoCard；只走 curated 卡。
- D3：删除 everyNTurns 周期触发；保留首轮/压缩后/话题切换/策略跳过。
- D4：INDEX 与 reconcile 不再输出 auto-cards 统计；旧 cards.jsonl 仅作 reconcile 只读诊断/promotion。
- D5：recall-log 增加 trigger/estimatedTokens/budgetUsed/injectedCount，仅前向仪表。
- 版本面/隐私文档/门禁统一到 1.8.2；AutoCard 冷归档说明见 docs/PRIVACY.md。

> 更早版本历史已移入 CHANGELOG-INTERNAL.md（不随发布包分发）；用户可读的发布摘要以本文件 1.8.3 为当前版本。
