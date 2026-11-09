# 变更记录

> 本文件只保留用户可读的功能与修复摘要；内部开发日志单独保存，不随发布包分发。

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
