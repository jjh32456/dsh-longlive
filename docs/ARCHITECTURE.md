# ARCHITECTURE.md — 结构、边界与数据流（1.8.3，≤150 行）

读者：要知道"谁在什么时候写哪个文件、为什么不能都在宿主里做"的运维/排障人员。

---

## 1. 文字版数据流

```
┌──────────────────────── 宿主进程（DSH app）────────────────────────┐
│ session/event(turn/end)                                            │
│    ├─ heartbeat ───────────────► <memoryRoot>/.longlive/live/<id>.json
│    └─ autoTruncator.evaluate                                        │
│         ├─ estimate（MESSAGE_TYPES data JSON 字符数 ÷ 4）           │
│         ├─ mode log/dryrun ────► .longlive/logs/auto-truncate.log   │
│         └─ mode request ───────► .longlive/logs/auto-truncate.request.json
│                                                                     │
│ 22 个工具（tools.js）──► 记忆库文件、账本、live 行、worker、备份     │
│ R1 运行时（router/runtime.js）─► router-runtime.jsonl（shadow/on）   │
└─────────────────────────────────────────────────────────────────────┘
                                   │  request.json（仅当宿主退出后）
┌──────────────────── 宿主外（一次性进程）───────────────────────────┐
│ auto-truncate-run.ps1                                              │
│   1. 校验请求（version/sessionPath 在 sessionsRoot 内/pluginDir）   │
│   2. CloseMainWindow → 3s → Stop-Process（按 PID）→ 等进程归零      │
│   3. truncate-cli.mjs → truncateVisibleSession()                    │
│        ├─ <session>.archive/<UTC>.jsonl.zstd（前缀归档）            │
│        ├─ <session>.bak-YYYYMMDD（sha256）                          │
│        ├─ 写 tmp → 校验 → 原子 rename 覆盖 session.v4.jsonl.zstd    │
│        ├─ 读回校验（sha256/seq/事件数/deriveMessages）              │
│        └─ <会话目录>/truncate-visible.json（账本，≤50 条）           │
│   4. 用应用自带 Electron 加载新日志，deriveMessages 数量必须一致     │
│   5. explorer.exe 重启应用；失败保留 request、exit 6                │
└─────────────────────────────────────────────────────────────────────┘
        │ 只读                                   │ 只读
        ▼                                        ▼
  面板（HTTP GET）                         verify-truncation.mjs
  memoryRoot + sessionsRoot               只读结构校验（V1–V7）
```

图里的 `<session>` 指**完整日志路径** `session.v4.jsonl.zstd`：所以归档目录是
`session.v4.jsonl.zstd.archive/`，备份是 `session.v4.jsonl.zstd.bak-YYYYMMDD`。

记忆库的布局：`INDEX.md`、`topics/`、`journal/`、`procedures/`、`memory-state.json`、
`tombstones.md`、`.longlive/{live,logs,reports,backups,archive/tombstones,audit.log}`。

---

## 2. 模块职责

| 模块 | 文件 | 职责 | 位置 |
|---|---|---|---|
| 入口 | `src/index.js` | 读配置、解析记忆根、装配心跳/自动截断/R1/工具、启动时收尾 inflight | 宿主内 |
| 工具层 | `src/tools.js` | 22 个工具的参数、会话解析、live 守卫、备份/截断/记忆调用 | 宿主内 |
| 核心截断 | `src/truncate.js` | 只丢不可见前缀（通常来自压缩遮蔽）；`planTruncation`（103-152） | 宿主内 |
| 可见截断 | `src/truncate-visible.js` | 丢整轮、归档、seq 重排、tmp+rename+读回、账本 | 工具可改其它未加载会话；**当前会话**只能宿主外 |
| 自动截断 | `src/auto-truncate.js` | 每 turn/end 评估一次；log/dryrun/request；single-flight | 宿主内（只决策） |
| 压缩分析 | `src/compaction.js` | `shadowedEvents` / `stillStored` / `reclaimed`（磁盘回读才算） | 宿主内（只读） |
| live 保护 | `src/live-target.js` | 三路判定"会话是否还在跑"；`SESSION_IS_RUNNING`（工具层只 import 其中的 id 辅助函数，不做三路探测） | 宿主内（仅 id 判定）+ CLI |
| live 注册表 | `src/live.js` | 行读写、effectiveState、prune | 宿主内 |
| 心跳 | `src/heartbeat.js` | turn 边界状态机维护 state/turn + 15s 定时/tool touch 刷新已绑定行；`0` 只关定时与 touch | 宿主内 |
| 记忆存储 | `src/memory/*.js` | 卡片、索引、巩固、遗忘、程序卡、检索 | 宿主内 |
| 路径解析 | `src/memory/paths.js` | memoryRoot 五级优先、越界检查、严格模式 | 宿主内 |
| R1 运行时 | `src/router/runtime.js` | off/shadow/on；只拦 4 个 memory 工具；fail-closed | 宿主内 |
| 策略 | `src/policy-profile.js` | generic 基线 + 只许收窄的 overlay | 宿主内 |
| runner | `scripts/auto-truncate-run.ps1` | 校验→关应用→切→验证→重启；退出码 0/2/3/4/5/6 | **宿主外** |
| CLI | `scripts/truncate-cli.mjs` | 无工具层的最小切口；自带 live 拒绝 | **宿主外** |
| doctor | `scripts/longlive-doctor.mjs` | 可选依赖/版本/安装计划；默认只读 | **宿主外** |
| 面板 | `@jjh32456/dsh-longlive-panel@1.8.0` | 六层视图/截断记录/过滤器决策（未并入，显示样例）/影子记录/常驻 Router，只读 | 独立可选插件 |
| 共享大脑活动流 | `src/activity/*`（`sharedBrain.activity`，1.8.0 起默认开启） | 事件级写活动行（同 key ≤1 条/10s；turn/end 写结论行）到 `.longlive/board/activity.jsonl`；agent/pre-step 只注入其他会话的增量（判重/蒸馏/500 条窗口）；与 `presenceBus` 解耦 | 宿主内（只写记忆根） |
| 校验器 | `<tools-dir>\ops\tools\verify-truncation.mjs`（本机示例，不在包内） | V1–V7 结构验收；不写不修 | **宿主外** |

---

## 3. 哪些在宿主内，哪些必须宿主外，为什么

| 操作 | 位置 | 理由 |
|---|---|---|
| 读会话、算估算、规划切点 | 宿主内 | 只读，随时可做 |
| `session_backup` | 宿主内 | 纯增量复制（`COPYFILE_EXCL` + sha256），不改原文件 |
| `session_compact` | 宿主内 | 必须通过宿主自己的 compaction 服务，外部无法生成合法的 summary/checkpoint |
| 记忆库读写、live 行、worker | 宿主内 | 这些是插件自己的能力，不依赖会话文件 |
| 对**其它未加载**会话做截断 | 宿主内 | 工具在宿主里跑，只放行"不是本宿主当前会话"的目标；但它只比 id，**不做**心跳/句柄三路探测，切之前要人工确认没人正在用 |
| **改写本宿主正在加载的会话** | **必须宿主外** | 宿主内存里握着旧 seq；边跑边改会写出撕裂/重复序号（0.7.0 实测 77 → 3532，`src/auto-truncate.js:24-28`）。所以自动截断**没有** in-app 写入模式，`apply` 也被改写为 `request`；runner 先关应用再切 |
| **杀应用 / 重启应用** | **必须宿主外** | 进程不能可靠地杀自己再重启；runner 用 `CloseMainWindow` + 按 PID `Stop-Process`，失败时一个字节都不改 |
| **结构验收（派生消息数）** | **宿主外** | 要用应用自带 Electron 加载 `app.asar` 的会话模块跑 `deriveMessages()`；宿主内无法证明"重启后能加载" |
| 面板展示 | 独立进程/路由 | 只读 HTTP；不参与写入，不与工具共享内存状态 |

一句话：**宿主内只做"能回滚的增量""对未加载会话的改写"和"只读判断"；凡是替换当前会话、结束进程、
验证加载的，都在宿主外。**

---

## 4. 一次完整生命周期

1. 用户继续对话 → 宿主追加事件 → `turn/end`。
2. 心跳刷新 live 行；自动截断评估一次（每会话每冷却窗口一次）。
3. 超过阈值（`tokens >= threshold && turns > minTurns`）→ 按模式写日志 / dry-run / request。
4. request 存在 → 外部 runner（人工或调度器）在**应用退出后**执行。
5. runner 归档→备份→切→读回→用 Electron 验证→重启；成功删 request，失败按退出码恢复。
6. 下次启动：`sweepInflight` 收尾残留；`verify-truncation` 可随时只读复验。

---

## 5. 失效时怎么"困住"损坏

- 写入顺序固定为：快照 → 归档 → 备份+校验 → inflight → tmp → 校验 tmp → 确认源文件未变 →
  `rename` → fsync → 读回 → 删 inflight → 记账（`src/truncate-visible.js:1424-1701`）。
- 任何 rename 之后的失败都用快照字节恢复；恢复失败会带 `error.result` 抛出，不静默。
- request 是 single-flight：合法的待执行请求绝不被覆盖；损坏的改名隔离后再重建。
- live 判定 fail-closed：注册表读不出来 = 拒绝，而不是"应该没在跑"。
- R1 判定异常在 `on` 模式下拒绝写（fail-closed），只读永不拒。

---

## 6. 已实现 vs 规划中（别混）

| 能力 | 状态 | 证据 |
|---|---|---|
| 会话健康/备份/压缩/两种截断/按需翻原文 | 已实现 | `src/tools.js` 的 22 项 |
| 自动截断决策（log/dryrun/request） | 已实现 | `src/auto-truncate.js` |
| 宿主外 runner + CLI | 已实现（Windows） | `scripts/auto-truncate-run.ps1`、`truncate-cli.mjs` |
| live 注册表 / worker | 已实现（v0.7 进程层） | `src/live.js`、`src/heartbeat.js` |
| 记忆六层 + 程序卡 + 检索 | 已实现（v0.4 记忆层） | `src/memory/*` |
| R1 路由 shadow/on | 已实现，**on 未验收** | `src/router/runtime.js`；runbook §7 D9/D10 未做 |
| 身份层 / 常驻 Router | **规划中** | README 第三层标"规划中" |
| scope 打分 / 过滤器 | **规划中** | 面板 `/filter` 返回 `implemented:false` |
| 常驻看门进程 / 计划任务 | **未实现** | `scripts/` 无 daemon、无 `Register-ScheduledTask` |
