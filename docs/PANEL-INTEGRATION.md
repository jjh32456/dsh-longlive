# 面板接入约定：上次手术回执（rc.2）

## 0. 1.8.0 面板路由与审计入口（实测口径）

- `GET /api/longlive-panel/v2/state` 返回 **27 条路由 / 18 个动作**（1.8.0 验收口径，见 `RELEASE-1.8.0-CHECKLIST.md` §5）。
- 「本轮想起」审计入口 = `<memoryRoot>/.longlive/recall-log.jsonl`（行格式见 `AUTO-RECALL.md`「recall-log」）。
- 本文件只定义手术回执等接口约定，不重复面板其余路由。

本文只定义**接口约定与数据形状**，不要求改面板仓库。潜望镜面板（@jjh32456/dsh-longlive-panel）
如果已有「会话 / 截断」页签，加一个小字段即可；没有就按下面的形状做一个只读卡片。

## 1. 数据从哪来

面板只需要读两个路径（都在同一个 `memoryRoot` 下）：

| 用途 | 路径 | 读法 |
|---|---|---|
| 当前/上次手术阶段 | `<memoryRoot>/.longlive/surgery-state.json` | 整份 JSON；`phase`、`done`、`before`、`after`、`backup`、`error` |
| 恢复判定（可选） | `<memoryRoot>/.longlive/reports/surgery-recovery-*.json` | 取文件名排序最后一份；没有就不显示 |

插件启动时如果发现未完成的 state，会自动写一份 `surgery-recovery-<ts>.json`；
`node scripts/surgery-inspect.mjs --recover-report` 只读地返回同样的判定，不落盘。面板**不要**为了刷新去调用
`--confirm`、`session_truncate*` 或任何写工具。

## 2. 建议字段

字段名就叫「上次手术」：

```json
{
  "found": true,
  "time": "2026-11-04T06:34:26.845Z",
  "phase": "done",
  "outcome": "applied-and-verified",
  "classification": "applied-and-verified",
  "reasonCode": "CUT_APPLIED_AND_VERIFIED",
  "sessionId": "session-e219dedf-...",
  "sessionPath": "<sessions-root>/<session>/session.v4.jsonl.zstd",
  "beforeBytes": 4006116,
  "afterBytes": 110329,
  "backupPath": "<backup-path>",
  "reportPath": "<memory-root>/.longlive/reports/surgery-recovery-<stamp>.json",
  "needsAttention": false
}
```

没有 state 文件时：

```json
{ "found": false, "label": "无手术记录", "needsAttention": false }
```

`phase=done` 时 `time` 取 `done.at`，否则取 `updatedAt`；`outcome` 取
`done.outcome`。`beforeBytes`/`afterBytes` 从 `before.bytes`/`after.bytes` 取，
缺失就返回 `null`，不要用 0 冒充。

## 3. 判定到 UI 的映射

| classification | 标签 | 颜色建议 | 点击后 |
|---|---|---|---|
| `applied-and-verified` | 已完成 · 已校验 | 绿 | 打开 `reportPath` 或 state |
| `applied-unverified` | 已完成 · 未读回 | 黄 | 提示「启动宿主确认会话能打开」 |
| `aborted-before-cut` | 已中止 · 未剪切 | 灰/蓝 | 提示可重跑，指向 `surgery.log` |
| `needs-attention` | 需要人工核对 | 红 | 展开报告里的 `recommendation` / `actions` |
| 无记录 | 无手术记录 | 灰 | 不弹窗 |

`phase=done` 时 `classification` 直接取 `done.outcome`，可能是 `applied-and-verified`、
`noop`（会话本来就够小，未剪切）或 `dry-run`（演练，未关宿主）；后两者按“无变化/演练”
显示成中性色即可，不要当成失败。`status=done` 表示有完整回执，不表示一定剪过。

面板只显示，不提供「一键重剪」。重跑必须由人显式执行
`scripts\surgery-run.cmd`（隐藏计划任务），面板最多给一条命令提示。

## 4. 只读查询接口

如果面板更愿意走进程而不是直接读文件：

```powershell
node <plugin>\scripts\surgery-inspect.mjs --recover-report --memory-root <memoryRoot>
```

stdout 恰好一行 JSON，字段与 `statusSurgery()` 一致：

```json
{
  "ok": true,
  "found": true,
  "status": "needs-review",
  "memoryRoot": "...",
  "statePath": "...\\.longlive\\surgery-state.json",
  "classification": "applied-and-verified",
  "reasonCode": "CUT_APPLIED_AND_VERIFIED",
  "recommendation": "上次手术已完成 ...",
  "lastSurgery": {
    "surgeryId": "20261104-143426-884",
    "phase": "restart",
    "startedAt": "...",
    "updatedAt": "...",
    "before": { "bytes": 4006116, "events": 4771, "messages": 1256, "sha256": "..." },
    "after": { "bytes": 110329, "events": 177, "messages": 54, "sha256": "..." },
    "backup": { "path": "...", "sha256": "..." },
    "outcome": null,
    "error": null
  }
}
```

`status` 取值：`none` / `done` / `needs-review` / `state-unreadable`。
退出码 0 表示查询本身成功（判定看 `classification`），2 表示查询失败。
**该命令不写报告、不追加 audit、不改 state、不碰会话**，面板可以放心定时刷新。

## 5. 「账本」页：D1/D4 轮次账（只读）

面板加一个「账本」页签时，只读下面两个路径，或跑只读脚本；**不要**为了刷新调用
`metrics-sample` 或任何写工具。

| 用途 | 路径 / 调用 |
|---|---|
| 每轮四层账本 | `<memoryRoot>/.longlive/metrics/turns.jsonl` |
| 校准状态 | `<memoryRoot>/.longlive/metrics/state.json` |
| 一行汇总 | `node <plugin>\scripts\metrics-read.mjs --memory-root <memoryRoot>` |
| 账本行 | `node <plugin>\scripts\metrics-read.mjs --memory-root <memoryRoot> --json --limit 50` |
| Router 工具 | `router_status` 的 `ledger` 字段（仅 Router 开启时工具存在） |

账本每行至少含 `{at, sessionId, turn, layers:{fixed,recent,recall,conclusion}, total,
recallCount, recallIds}`；另带 `carried`、`components`、`raw`、`actual`、`reconciliation`、
`budget`。建议列：时间、turn、四层、total、actual、delta%、within5、recallCount、是否超预算。
`total` 是**请求输入估算**（含 `carried`），`actual` 才是账单口径；两者不要混用。
超预算行 `budget.triggered=true`、`budget.applied=[]`，只表示“超了”，不是错误，也不代表
已经裁剪——D2/D3 本轮没有实现。

没有账本时 `ok:true, exists:false, available:false`；没有 `memoryRoot` 时
`ok:false, code:"E_MEMORY_ROOT_UNSET"`，两种都不是异常。完整字段与误差算法见
[METRICS.md](METRICS.md)。

## 6. 刷新与缓存

- 面板打开时读一次；用户点「刷新」再读一次。
- 不要因为 `phase != done` 就自动触发手术或截断。
- 不要缓存超过一次会话；state 可能被下一次手术覆盖。
- 读到 `needs-attention` 时只提示，不自动「修复」——修复动作必须留给
  `--recover-report` 的人工核对流程。

## 7. 每日自动维护（B1/B2，可选只读卡片）

`autoMaintenance.enabled` 打开后，插件每日本地日期变化时跑一次（默认仍为 `false`）。
面板只读下面两个产物，不要调用任何写工具：

| 用途 | 路径 | 读法 |
|---|---|---|
| 调度状态 | `<memoryRoot>/.longlive/bridge/schedule.json` | 整份 JSON；`lastConsolidateDate`、`lastForgetDate`、`lastConsolidateReport`、`lastForgetPending`、`lastForgetPendingCount`、`last*Error`、最近 30 条 `runs` |
| 待确认遗忘清单 | `<memoryRoot>/.longlive/reports/forget-pending-YYYYMMDD.md` | 按日期取最新一份；文件头明确写了「没有移动、删除或改写任何卡片」 |

同日重复调度会被 `lastConsolidateDate` / `lastForgetDate` 跳过。`last*Error` 非空表示
当天该 job 失败（日期不会推进，下次启动/次日会重试）；面板可以显示一行「上次失败」，
但不要因为失败自动重跑。真正的遗忘执行仍需人工调用 `memory_forget` 并传
`confirm:"FORGET"`，本仓库的自动维护不会触发它。
## 8. 引擎自检（C1，1.4.0）

插件加载时把宿主版本与 `package.json` 的 `engines.dsh` 比对。**不匹配不阻断加载**：
只打一行 warning，并把结论写到 `<memoryRoot>/.longlive/status.json`。面板只读这个文件
就能显示红点/警告；本节只定义数据形状，不要求改面板代码（当前面板仓库还没有读取该字段
的实现，按本节加一个字段即可）。

```json
{
  "engineMismatch": {
    "hostVersion": "0.1.9",
    "required": ">=0.2.0 <1.0.0",
    "at": "2026-11-05T13:02:01.000Z",
    "source": "hostPackage",
    "path": "<host>/resources/app.asar/dsh/package.json"
  }
}
```

- `hostVersion`：检测到的宿主版本；`required`：`engines.dsh` 声明区间；
  `at`：判定时间（ISO 8601）；`source`：探测来源（`ctx.*` / `config.hostVersion` /
  `env.DSH_HOST_VERSION` / `hostPackage`）；`path` 只在从宿主清单读取时出现。
- **不匹配**：写入/更新 `engineMismatch`；文件里其它键原样保留（面板自己的状态不会被冲掉）。
- **匹配**：删除残留的 `engineMismatch`；如果它是唯一键，整个 `status.json` 会被删除。
- **未知**（探测不到、解析失败）：不写也不清——「不知道」不能覆盖一条真实警告。
- **写失败**（只读根、根是文件、并发竞争）：只 warn，插件继续加载；没有记录时面板按
  「无警告」处理，不要把它当成健康证明。
- UI 建议：`engineMismatch` 存在时显示红点，悬浮文案「宿主 X 不在要求 Y 内，插件以降级
  模式运行」；点击展开 `source`/`path`。文件不存在或无该键：不显示。
- 版本来源的读取顺序：Cordis ctx → `config.hostVersion` → `DSH_HOST_VERSION` → 宿主清单
  （桌面宿主为 `process.resourcesPath/app.asar/dsh/package.json`，也接受
  `DSH_HOST_PACKAGE` 显式指定）。探测过程只读、不抛错。
