# 变更记录

> 本文件只保留用户可读的功能与修复摘要；内部开发日志单独保存，不随发布包分发。

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
