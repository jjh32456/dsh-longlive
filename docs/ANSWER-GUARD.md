# ANSWER-GUARD（有据才答）· 1.8.0

本文件说明 1.8.0 合并进 longlive 的有据才答层（answer-guard）的来源、开关、接线、评测入口与打包边界。

## 1. 来源与版本

- 上游：`<answer-guard-repo>`（answer-guard 1.6.5-rc.1；冻结见 `eval/gate3/frozen-fix-2/FROZEN-MANIFEST.json`）。
- 1.8.0 合并：`src/answer/` 六类文件（语义拆分，实现单源在 `guard.js`）：
  - `guard.js` ← 上游 `core.mjs`（规则/证据检索/数字与轮号检测/审计行计算，纯函数单源）；
  - `evidence.js` ← 证据注入面（`retrieveEvidence` / `renderEvidencePacket` / 无证据标记等语义导出，转发 `guard.js`）；
  - `second-hop.mjs` ← B4 证据包字段覆盖不足时的第二跳补读（最多 1 跳）；
  - `audit.js` ← 上游 `store.js`（生成后审计落盘/轮转/读回）+ 审计纯函数转发；
  - `query.js` ← 上游 `tool.js`（只读工具 `answer_audit`）；
  - `index.js` ← 上游 `index.js`（`registerAnswerGuard`：pre-step 证据注入、systemPrompt 规则 section、session/event turn/end 审计、只读面板路由）。
- 历史修复随合并带入：`HISTORY_CUE_RE` 的「上一次/上回/上上轮」族 + 审计上下文尾部保留/显式截断（`contextTruncated` 可机读）。
- 1.8.0 新增：**M1 信心闸（审计级）**、**M1.5 文本层硬规则**、**R1 检索断链修复**（见 §2、§3）。

## 2. 开关（1.8.0 默认 ON）

- `answerGuard.enabled` 默认 `true`（`src/config.js` schema；`resolveActivationSwitches` 的 `answerGuardEnabled` 为运行期统一门）。
- 独立 kill switch：`answerGuard.enabled: false`，或环境变量 `DSH_LONGLIVE_DISABLE_ANSWER_GUARD=1`。
- 关闭时行为：零 hook、零系统提示 section、零审计 IO（`registerAnswerGuard` 不注册，`src/index.js` 不创建 `answer_audit` 工具）。
- 其他子开关（默认值）：`audit=true`、`auditMaxBytes=2 MiB`、`auditContextChars=40000`、`systemPromptSection=true`、`injectRule=true`、`panel=true`、`maxEvidenceTurns=3`、`evidenceMinScore=1.8`、`evidenceMaxChars=4000`、`maxHistoryTurns=80`。
- **信心闸（M1）默认关闭**：`answerGuard.gate.enabled=false`；这不是 answer-guard 总开关，关闭时审计与注入仍按 1.8.0 原行为运行，系统提示逐字节不变。

### 2.1 信心闸（M1 / M1.5）配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `answerGuard.gate.enabled` | `false` | M1 灰度开关。只有 `true` 时 `auditTurn` 才做三态判定并写 `gate` 字段；默认关=保持 1.8.0 现状。 |
| `answerGuard.gate.minCoverage` | `0.6` | 有事实断言的句子中，带轮号引用或 `【推断】` 标注的最低比例。低于此值判 `degraded`。 |
| `answerGuard.gate.requireReadable` | `true` | 草稿引用的轮号必须在本轮证据包轮次内且 excerpt 非空；不可回读时判 `abstain`。 |
| `answerGuard.gate.conflictPolicy` | `degrade` | 证据冲突策略：`degrade`（降级，默认）或 `abstain`（弃答）。 |

- 开启方式（profile 的插件 config，YAML 示例）：

```yaml
- id: session-longlive
  config:
    answerGuard:
      enabled: true          # 1.8.0 默认已是 true；显式保留便于审计
      gate:
        enabled: true        # M1 信心闸灰度开关（默认 false）
        minCoverage: 0.6
        requireReadable: true
        conflictPolicy: degrade
```

- `gate` 目前**只有配置开关，没有独立环境变量**；整个 answer-guard 的 kill switch 仍是 `DSH_LONGLIVE_DISABLE_ANSWER_GUARD=1`（或 `answerGuard.enabled=false`）。
- M1 是**审计级**：`auditTurn` 产出三态 `gate.mode`（`answer`/`degraded`/`abstain`）、`gate.reasons`、`gate.signals`、`gate.assertions`，并写入审计行 `gateVersion=1`；不直接改写助手正文。开启后若模型应弃答却输出事实断言，记 `GATE_ABSTAIN_VIOLATION`；应降级但首句没有「不确定」标注，记 `GATE_DEGRADED_MISSING`。
- M1.5 是**文本层硬规则**：`gate.enabled=true` 时，系统提示追加 `GATE_RULE_TEXT`（无证据不许作答、只用白名单轮号、每个事实句带引用、数字必须能在 excerpt 找到、未标注推断=幻觉等）；`gate.enabled=false` 时只注入原 `RULE_TEXT`，不改变既有行为。
- 回退：把 `answerGuard.gate.enabled` 改回 `false`（或删除 `gate` 块）即可一键回到 M1 之前的现状，无需卸载/重启以外的其他操作。

## 3. 检索断链修复（R1）

- `evidenceMaxChars` 默认值 **1200 → 4000**：证据包总预算扩大，避免主证据被截掉。
- `renderEvidencePacket` 的助手 excerpt 窗口 **300 → 800**：答案点落在第 300–800 字区间时不再「注入了但看不到答案」。
- `HISTORY_CUE_RE` 新增 **「当时 / 那时 / 那次 / 当天」**：这些说法现在也触发历史检索与轮号引用规则；`HISTORY_CLAIM_RE` 同步覆盖对应的历史断言。
- 检索层仍只读、fail-open；证据不足/通道读不到时不会伪装成「零命中」逼模型弃答（沿用 1.8.0 原语义）。
- 相关评测：`test/answer-history-cue.test.mjs` 覆盖 cue 触发；`test/answer-evidence-context.test.mjs` 覆盖证据上下文/数字可回读边界。

## 4. 接线位置

- `src/index.js`：`registerFeatures(...)` 之后，按 `resolveActivationSwitches().answerGuardEnabled` 调用 `registerAnswerGuard(ctx, config, { memoryRoot, home, now, knownTools })`；同时把 `createAnswerTools(memoryRoot)` 作为 `answerTools` 传给 `registerTools`（基线 22 工具 + `answer_audit`）。
- `agent/pre-step`（最外层，`prepend:true`）：历史类问题先检索会话历史，注入证据包（`EVIDENCE_MARK`）或无证据标记（`NO_EVIDENCE_MARK`）。
- `ctx.systemPrompt.section`：静态短规则（order 9500）；宿主无该能力时用隐藏消息兜底（`injectRule`）；gate 开启时追加 M1.5 硬规则。
- `session/event`：逐轮收集助手正文/tool calls/工具结果，`turn/end` 写生成后审计（含 gate 字段）。
- 审计文件：`<memoryRoot>/.longlive/answer-audit/audit.jsonl`（一行一轮，只追加；超 `auditMaxBytes` 轮转到同目录 `audit.1.jsonl`；坏行只计数不抛）。
- 面板：`GET /api/longlive/answer-audit` 与 `answer_audit` 工具同源（只读）。
- 所有路径 fail-open：注册/注入/审计失败只 warn，pre-step 永远返回原 decision；gate 判定异常只置空 `gate`，不改原 flags。

## 5. 评测入口（dev-only，不随包发布）

- 仓库内评测脚本（**npm 包不含**）：`scripts/answer-eval/run-eval.mjs`：100 题确定性评测（**不调模型/不用 VM**，只跑证据层与检测器），支持 `--json --fixture <fixture-100.jsonl> --out <dir>`。
- 仓库内评测脚本（**npm 包不含**）：`scripts/answer-eval/score-real.mjs` / `score-extras.mjs`：真实模型 run 的评分/聚合（Gate-3/5 用；输入需 `--run/--audit/--plan`）。
- fixture：`test/fixtures/answer-guard/fixture-100.jsonl`（dev-only，不进 npm 包）。
- 关键测试：`test/answer-guard.test.mjs`、`test/answer-history-cue.test.mjs`、`test/answer-evidence-context.test.mjs`；gate 的 dev-only 回归以 M1 合入测试为准（不进入 npm 包）。

## 6. 打包边界

- npm `files` 白名单包含 `src/answer/*.js`、显式的 `src/answer/second-hop.mjs` 与 `docs/ANSWER-GUARD.md`。
- `scripts/answer-eval/`、`test/fixtures/answer-guard/`、`eval/` 均不进入 npm 包（dev-only），避免评测数据/私有路径进包。
- src 内无本机私有绝对路径；memoryRoot/路径均运行时解析（`process.execPath` 仅用于测试脚本 spawn，非硬编码路径）。
- 发布前用只读 `tar -tf <tgz>` 核对包内 answer 文件齐全；不要在文档任务里执行 `npm pack`（打包归 release-check）。

## 7. 验证命令

```powershell
$NODE = "<node-exe>"   # PATH 中的 node，或本机 Node 绝对路径（不随包）
$NODE --test test/answer-guard.test.mjs test/answer-history-cue.test.mjs test/answer-evidence-context.test.mjs
# 仓库内评测脚本（npm 包不含）\n$NODE scripts/answer-eval/run-eval.mjs --json --fixture test/fixtures/answer-guard/fixture-100.jsonl --out $env:TEMP\answer-eval-out
```
