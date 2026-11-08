# METRICS.md — D1 工作集分层与 D4 轮次账本

适用：本仓库 1.3.1 + 本次 D1/D4 改动。**只度量，不裁剪**：D2（工具输出裁剪）、D3（按需翻原文）
和任何降级动作都没有实现；超预算只写进账本，不报错、不改请求。

## 1. 四层怎么分

每轮 `turn/end` 时，取该轮最后一条带 `usage` 的 `assistant/message` 作为切点，用它之前的
surface 事件重建“这一轮实际发出去的请求”，再分成四层：

| 层 | 内容 | 判定 |
|---|---|---|
| `fixed` | 系统提示 + 工具定义 + 宿主注入的常驻上下文 | 所有仍存活的 `system/message`；最后一个 `request/header` 的 `tools` JSON；role=user 且 `source.kind` 为 `agent-instructions` / `runtime-context` / `skill-catalog` / `plugin:dsh-engram` / `time-context` 的消息；`developer/message` |
| `recent` | 最近 `keepTurns` 轮的完整对话 | role=user（`source.kind` 为空或 `user`）/ assistant / tool，且该消息的 turn 落在 `(turn - keepTurns, turn]` |
| `recall` | 自动召回注入卡 | 正文首行 `【自动想起】`，或 `source.kind === 'plugin:dsh-auto-recall'` |
| `conclusion` | 开机卡 / 结论卡 | 正文首行 `【开机卡】`，或 `source.kind === 'plugin:dsh-identity-router'`；若本轮没有任何开机卡消息，可额外读 `<memoryRoot>/.longlive/router/board.json` 的 `focus[].lastConclusion`（A2 才有该字段，当前通常为空，且不会与消息双算） |

补充：

- **`carried`**：真实对话里早于 `keepTurns` 窗口的轮次，以及 turn 0 / 无法归属的会话卡
  （如 visible truncation 的 `archive-card`）。D2/D3 未实现，这些内容仍留在请求里，
  所以必须单列，不能假装它们被裁掉了。
- `recent` 的窗口按“消息所属 turn”算；`user/message` 事件本身不带 `data.turn`，实现里用
  顺序扫描 `turn/start` 得到的 seq→turn 映射归属。
- 未知 `source.kind`（非空、且没有 sections/form）归 `fixed`；无 kind 的 user 消息归对话。
- `assistant/message` 里的 `reasoning` 块不计入请求，估算时跳过；`tool-call` 的 name+arguments 计入。
- 工具定义取 `request/header.tools`，不是当前工具列表的猜测。

## 2. 默认预算与配置

默认目标 **40,000 token/轮**，四层目标：

| 层 | 默认 |
|---|---:|
| fixed | 25,000 |
| recent | 12,000 |
| recall | 2,000 |
| conclusion | 1,000 |

```yaml
metrics:
  enabled: true          # 默认 true；纯度量，失败静默
  targetTokens: 40000    # 只改这个时，层目标按 0.625/0.30/0.05/0.025 等比缩放
  keepTurns: 12          # 与 autoTruncate.keepTurns 默认值一致
  layerTargets:          # 可选；显式给出则覆盖等比缩放
    fixed: 25000
    recent: 12000
    recall: 2000
    conclusion: 1000
```

也可以写 `metrics: false` 直接关闭。配置在 `apply()` 时读一次，改 YAML 后仍需重启宿主。

超预算时账本行里记：

```json
"budget": {
  "target": 40000,
  "layers": { "fixed": 25000, "recent": 12000, "recall": 2000, "conclusion": 1000 },
  "over": true,
  "overBy": 59527,
  "layersOver": ["fixed", "recent"],
  "order": [
    { "step": 1, "action": "drop-tool-outputs", "layer": "recent", "implemented": false, "owner": "D2" },
    { "step": 2, "action": "drop-old-turns", "layer": "recent", "implemented": false, "owner": "D3" },
    { "step": 3, "action": "trim-recall", "layer": "recall", "implemented": false, "owner": "D1-followup" },
    { "step": 4, "action": "trim-conclusion", "layer": "conclusion", "implemented": false, "owner": "A2-followup" },
    { "step": 5, "action": "trim-tool-definitions", "layer": "fixed", "implemented": false, "owner": "D6" }
  ],
  "triggered": true,
  "applied": [],
  "note": "measure-only: over budget is recorded, D2/D3 trimming is not implemented"
}
```

**降级顺序只写在文档和 `budget.order` 里，代码不执行**；`budget.applied` 永远为空数组。
`over`/`triggered` 只表示“这一轮超过目标”，不是错误。

## 3. 每轮账本

写入：`<memoryRoot>/.longlive/metrics/turns.jsonl`，一行一个 JSON 对象，只追加。
校准状态：`<memoryRoot>/.longlive/metrics/state.json`（原子写：tmp + rename）。

必填字段（D4 约定）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `at` | ISO string | 记录时刻 |
| `sessionId` | string | 会话 id |
| `turn` | integer | 轮次 |
| `layers` | object | `{fixed, recent, recall, conclusion}`，已校准后的整数值 |
| `total` | integer | **本轮请求输入的估算值**：`fixed + recent + recall + conclusion + carried` |
| `recallCount` | integer | 去重后的召回卡数 |
| `recallIds` | string[] | 召回卡 path（没有 path 时用 title） |

附加字段（便于对账和面板）：

```json
{
  "v": 1,
  "at": "2026-11-05T13:16:33.716Z",
  "sessionId": "session-e219dedf-...",
  "turn": 16,
  "layers": { "fixed": 60916, "recent": 33710, "recall": 200, "conclusion": 0 },
  "total": 99899,
  "recallCount": 1,
  "recallIds": ["topics/toolchain.md"],
  "carried": 5073,
  "components": {
    "system": 8482, "tools": 29304, "injected": 17202, "developer": 0,
    "lastConclusion": 0, "recentTurns": 12
  },
  "counts": { "recallMessages": 1, "conclusionMessages": 0, "recentMessages": 60, "carriedMessages": 7 },
  "raw": { "layers": { "fixed": 55000, "recent": 30400, "recall": 180, "conclusion": 0 },
           "total": 90177, "estimator": "cjk*1+other/3.5", "factor": 1.1078101666215914 },
  "actual": { "inputTokens": 1473, "cacheReadTokens": 100480, "cacheWriteTokens": 0,
              "outputTokens": 120, "requestInputTokens": 101953 },
  "reconciliation": { "available": true, "rawEstimate": 90177, "actualInput": 101953,
                      "delta": -2054, "deltaPct": -2.01, "within5pct": true,
                      "method": "actualInput = inputTokens + cacheReadTokens + cacheWriteTokens; estimate = raw * cumulative factor" },
  "calibration": { "factor": 1.1078101666215914, "samples": 4 },
  "cacheHitRate": 0.9855,
  "budget": { "...": "见上一节" },
  "tokenSource": "estimate-calibrated",
  "source": "live"
}
```

数值仅为形状示例，不是固定值。`source` 为 `live`（插件实时写）或 `sample`（离线脚本造）。

## 4. 估算与对账算法（重要）

宿主的 `usage` 字段是真实账单；每层占用没有独立的真实 token，只能估算。规则写死为：

1. **原始估算**（`estimator = "cjk*1+other/3.5"`）：
   - 每个 CJK 字符 1 token，其他字符每 3.5 个 1 token；向上取整；
   - 每条消息再 +4（角色/分隔开销）；
   - 工具定义：`JSON.stringify(tools)` 的字符数按同一公式估算，再 +4；
   - `reasoning` 块不计。
2. **实际输入**：`actualInput = inputTokens + cacheReadTokens + cacheWriteTokens`。
   `totalTokens` 含输出，不能直接拿来当输入上下文。
3. **冷启动**：没有历史样本时 `factor = 1`，第一轮会系统性偏差。本次样本首轮
   `91,874` vs 实际 `107,076`，**-14.20%**。
4. **累计比值校准**：每写一轮，把该轮的 `raw.total` 与 `actualInput` 累加进
   `state.json` 的 `rawSum` / `actualSum`，下一轮用

   `factor = clamp(0.5, 2, (actualSum + actual) / (rawSum + raw))`

   把原始估算缩放到账单口径。注意：这是**累计比值**，不是 EWMA；一次样本就能纠偏，
   后续样本只做微调。`total = round(rawTotal * factor)`，四层按比例缩放，用最大余数法
   把舍入差分摊，保证 `fixed + recent + recall + conclusion + carried === total`。
5. **误差**：`delta = total - actualInput`；
   `deltaPct = round(delta / actualInput * 100, 2)`（实际输入为 0 时不计算）；
   `within5pct = |deltaPct| < 5`。
6. **没有 `usage` 时**：`actual = null`，`reconciliation.available = false`，不更新校准状态；
   账本仍然写，`tokenSource` 保持 `estimate-cold` 或 `estimate-calibrated`。

为什么不是 `chars/4`：宿主 `dsh-token-meter` 用 `chars/4`，本次样本里系统性低估约
22%–25%（CJK 多）；按任务要求用 `/3.5` 作基线，再用账单校准兜底。`raw` 与 `total` 都保留，
面板可以同时看“估算”和“校准后”。

已知残差：

- `buildRequest` 还带 `session.toolHistory()`，本账本没有单独计它；它可能解释部分误差。
- 只统计到最后一个带 usage 的 assistant 消息为止；该轮之后若还有工具结果，不在本轮账里。
- 旧 system 提示若仍存活于 surface，会全部计入 `fixed`（这是宿主 `deriveMessages()` 的真实行为）。
- 估算器不是 tokenizer，`total` 是预算口径，不是账单；对账请看 `actual` 和 `reconciliation`。

## 5. 只读读取面（D4）

本插件**不监听 HTTP 端口**，沿用 `docs/PANEL-INTEGRATION.md` 的“读文件 / 跑脚本”约定：

| 用途 | 路径 / 调用 |
|---|---|
| 原始账本 | `<memoryRoot>/.longlive/metrics/turns.jsonl` |
| 校准状态 | `<memoryRoot>/.longlive/metrics/state.json` |
| 函数（Node） | `readTurnLedger({memoryRoot, sessionId?, limit?, since?, until?})` |
| 汇总函数 | `readMetricsSummary({memoryRoot, sessionId?, limit?})` |
| 校准读取 | `readCalibration(memoryRoot)` |
| CLI（一行 JSON） | `node scripts/metrics-read.mjs --memory-root <root>` |
| CLI（账本行） | `node scripts/metrics-read.mjs --memory-root <root> --json --limit 50` |
| Router 工具 | `router_status` 的 `ledger` 字段（仅 `routerEnabled: true` 时该工具存在） |

`router_status.ledger` 形状：

```json
{
  "ok": true,
  "path": "<root>\\.longlive\\metrics\\turns.jsonl",
  "exists": true,
  "available": true,
  "skipped": 0,
  "summary": {
    "turns": 5,
    "sessions": 1,
    "medianTotal": 108219,
    "p95Total": 112101,
    "maxTotal": 112101,
    "layerMedians": { "fixed": 64492, "recent": 17144, "recall": 212, "conclusion": 0 },
    "actualCoverage": 1,
    "medianActual": 109064,
    "medianAbsErrorPct": 1.71,
    "within5Turns": 4,
    "overBudgetTurns": 5,
    "medianCacheHitRate": 0.9706,
    "last": { "at": "...", "turn": 22, "total": 112101, "recallCount": 1 }
  }
}
```

没有记忆根时 `ledger = {ok:false, code:"E_MEMORY_ROOT_UNSET"}`，不会抛异常。
账本不存在时 `ok:true, exists:false, available:false`。面板“账本”页建议列：
轮次时间、turn、四层、total、actual、delta%、within5、recallCount、是否超预算。
面板只读，不要为了刷新去调用任何写工具或 `metrics-sample`。

## 6. 5 轮样本对账（当前会话历史）

脚本：`scripts/metrics-sample.mjs`。它读真实会话日志，取最后 5 个有 usage 的 turn，
按每轮最后一条 usage 的 seq 截断后重放 `measureTurn`；首轮 `factor=1`，之后用累计比值。
本次样本：

- 日志：`<DSH home>/sessions/<scope>/<session>/session.v4.jsonl.zstd`
- 输出：`<memoryRoot>/.longlive/metrics/turns.jsonl`、`state.json`，
  以及人读的 `reconcile.json`、`reconcile.md`（同在 `\sample\` 下）

| turn | fixed | recent | recall | conclusion | carried | total | actual | delta% | within5 | factor（本轮用的） |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---:|
| 18 | 54,988 | 26,219 | 181 | 0 | 10,486 | 91,874 | 107,076 | -14.20 | no | 1 |
| 19 | 64,176 | 29,690 | 211 | 0 | 13,254 | 107,331 | 108,384 | -0.97 | yes | 1.1655 |
| 20 | 64,492 | 16,687 | 212 | 0 | 26,828 | 108,219 | 109,064 | -0.77 | yes | 1.1712 |
| 21 | 64,660 | 15,983 | 212 | 0 | 29,494 | 110,349 | 112,266 | -1.71 | yes | 1.1742 |
| 22 | 64,945 | 17,144 | 214 | 0 | 29,798 | 112,101 | 114,755 | -2.31 | yes | 1.1794 |

汇总：首轮冷启动 **-14.20%**；暖态（第 2–5 轮）绝对误差中位数 **1.34%**；
全部 5 轮绝对误差中位数 **1.71%**；**4/5 在 5% 内**；最终累计 factor **1.1851**。
5 轮都超过 40K 目标（`overBudgetTurns: 5`），说明当前会话本身就远超预算，
这不是账本 bug，正是 D1 要暴露的事实。

## 7. 明确没做的

- 不裁剪任何消息、工具输出、工具定义；`budget.applied` 永远为空。
- 不新增 HTTP server、不改面板仓库、不装 profile、不重启宿主。
- 不实现 D2/D3，不按需翻原文，不自动降级。
- 不碰 `memoryRoot` 之外的任何记忆根；只写配置里 `memoryRoot` 下的 `.longlive/metrics/`。
