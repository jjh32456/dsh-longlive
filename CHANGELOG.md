# 变更记录

> 本文件只保留用户可读的功能与修复摘要；内部开发日志单独保存，不随发布包分发。

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
