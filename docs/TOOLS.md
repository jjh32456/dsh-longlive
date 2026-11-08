# TOOLS.md — 工具参考（1.1.2）

本文件只写**插件真正注册的工具**。名单从 `src/tools.js` 的 `TOOLS` 数组导出，共 **22** 个；
`registerTools` 把它们逐个交给宿主的 `defineTool`。README / ERRORS 已同步为 22；若再现 21 即为旧稿。

> D6 例外：`d6.enabled: true` 且非 `dryRun` 时，插件额外注册 `tool_search`（第 23 个工具），
> 用来按名称/关键词找回被裁掉的工具；默认关，所以默认名单仍是 22 个。见
> [FEATURES.md](FEATURES.md) 的 d6 节。

三个先记住的结论：

1. **没有 `memory_save`。** 它属于 engram 插件；本插件只是在 R1 路由里拦截它（`src/router/runtime.js`
   的 `INTERCEPTED_TOOLS`），并不注册。
2. **写会话日志的工具都要 `confirm` 词，且默认 dry-run。** 省略 `dryRun` = 只看不写。
3. **"危险等级"看爆炸半径，不看 bug。** L0 只读；L1 只写副本/账本/注册表；L2 改记忆正文或
   宿主写入；L3 改写会话日志、删行、杀进程——做错要动备份。

---

## 0. 两组怎么分

| 组 | 覆盖 | 数量 |
|---|---|---|
| **A. 会话 / 进程生命周期** | 会话日志的读、备份、压缩、截断，按需翻原文，子会话（worker），live 存活注册表 | 14 |
| **B. 记忆生命周期** | 记忆库的索引、巩固、强化、遗忘、程序卡、检索，以及记忆库写锁 | 8 |

`lease_*` 放在 B：锁文件是 `<memoryRoot>/.lease`，保护的是记忆库写入，不是会话日志。

---

## 1. 组 A：会话 / 进程生命周期（14）

所有会话类工具共用一组参数 `SESSION_ARGS`（`src/tools.js` 顶部）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `sessionPath` | string | 指向 `session.v4.jsonl.zstd` **文件本身**的绝对路径，优先级最高 |
| `sessionId` | string | `<DSH_HOME>/sessions/<scope>/` 下的目录名；跨 scope 重名会报 `SESSION_AMBIGUOUS` |
| `session` | string | 只接受 `"latest"`（按 mtime 最新）或 `"current"`（当前宿主会话） |

**没有默认值**：三个都不给 → `SESSION_NOT_FOUND`，附带最近 3 个候选（`resolveSessionPath`，
`src/tools.js:298-371`）。传相对路径 → `PATH_NOT_ABSOLUTE`。

| 工具 | 作用 | 参数（默认） | 写盘？ | 危险 | 典型误用 |
|---|---|---|---|---|---|
| `session_health` | 读日志大小、事件数、首 seq、末事件类型、可见消息数、derive 摘要、备份、上次截断、压缩分析 | 仅 `SESSION_ARGS` | 否 | L0 | 把它当"截断成功"的证据——它只描述现状，不证明可见对话没被切坏 |
| `session_original` | D3 按需翻原文：取回指定 turn 的工具输出 / 用户或助手消息 / 工具参数全文；隐私门先扫全量再切片 | `turn` 必填（1 基）；`kind` 默认 `tool`，可选 `message`/`call`/`all`；`toolCallId?`、`messageIndex?`（0 基）、`maxBytes?` 默认 65536（配置 `originalFetchMaxBytes`，夹 1024..4194304）、`offset?` 字节分页；其余 `SESSION_ARGS` | 否（只报 D2 archive 路径，不写） | L0 | 把 `maxBytes` 当隐私绕过（隐私门扫全量，命中即整次拒绝）；把 `messageIndex` 当 turn 号；指望它创建 `<memoryRoot>/.longlive/tool-output/` —— D2 才写 |
| `session_backup` | 在同目录做逐字节备份 `<log>.bak-YYYYMMDD`（sha256 校验，条目写 `backups.json`） | `dryRun` 默认 `true`；`confirm:"BACKUP"` 才写 | 是（`.bak-*` + `backups.json`） | L1 | 对 `.bak-*` 再备份 → `IS_BACKUP`；以为 dry-run 已经备份了 |
| `session_truncate` | 丢掉最老的**不可见前缀**（通常来自压缩遮蔽），可见对话摘要保持不变 | `keepEvents` 默认 20000；`dryRun` 默认 `true`；`confirm:"TRUNCATE"` | 是（改写日志 + 备份 + `truncate.json`） | L3 | 切本宿主正在用的会话 → 拒绝（`VISIBLE_TARGET_IS_LIVE_SESSION`）；不做 `session_compact` 直接切 → 切不动（`NO_TURN_BOUNDARY`）；切别的会话虽被允许，但先确认没人正在用它 |
| `session_truncate_visible` | 从**可见对话前端**整轮丢弃，让模型真的少收上下文；前缀归档、seq 重排 0..n-1 | `keepTurns` 默认 12、`keepTokens` 默认 80000（双边界取更晚）；`dryRun` 默认 `true`；`confirm:"TRUNCATE-VISIBLE"`；`carryFirstUserMessage` 默认 `true`；`insertArchiveCard` 默认 `true` | 是（改写日志 + 归档 + 备份 + `truncate-visible.json`） | L3 | 在宿主里对自己切；把 `keepTurns` 当"至少保留"的硬下限（双边界会保留更少）；不看 `visibleMessages` 就确认 |
| `session_compact` | 触发一次宿主原生压缩，把摘要写进日志（`compaction/summary` + `compact-checkpoint`） | `dryRun` 默认 `true`；`sourceCommandId?` | 是（由宿主 compaction 服务写） | L2 | 在无 compaction 服务的 profile 里调 → `COMPACTION_UNAVAILABLE`；在 turn 中调以为立刻生效（实际排队到 `whenIdle`） |
| `session_wake` | 读一段有上限的"醒来切片"：STATE.md 三节、flow/current.md、最新 journal 的三个标题、INDEX 短行 | `session?`（只是标签，不选内容） | 否 | L0 | 把它当全文读取；超出 2500 字符被截断是设计行为 |
| `worker_spawn` | 派一个后台子会话，立即返回 `workerId`；**默认不可用**（`workers.enabled:true` 才放行） | `prompt` 必填；`label?`；`timeoutSec` 默认 600 | 是（子会话自己的日志） | L1 | 把需要交互确认的任务丢给 worker（它没法问你）；不设超时干等 |
| `worker_status` | 读 worker 状态（注册表 → 子会话目录 → 持久日志）；**默认不可用** | `workerId` 必填 | 否 | L0 | 把"inactive"当失败；它也可能只是没在跑 |
| `worker_kill` | 请求停掉一个 worker（fire-and-return）；**默认不可用** | `workerId` 必填；`reason?` | 否（宿主管理） | L2 | 拿它当"等它结束"；返回只代表请求已发出 |
| `session_live_update` | 写/补本会话在 live 注册表的行 | `sessionId?`；`state` 必填（`idle/running/waiting/blocked/stale`）；`goal?` ≤80 字；`queued?`；`turn?`；`ttlMs` 默认 60000（1000..86400000）；`last_action?{at,kind,detail≤500}`；`blocked_on?` | 是（`.longlive/live/<id>.json`） | L1 | 手写别的会话 id；把 `state` 改成非 `blocked` 却还想保留 `blocked_on`（会被清空） |
| `session_live_list` | 列 live 注册表，按心跳算 `effectiveState` | `includeDead` 默认 `false` | 否 | L0 | 把 `dead` 当"已经退出"——远端机器的行只按心跳老化，不做 pid 探测 |
| `session_live_get` | 读一行，带 canonical 校验 | `sessionId` 必填（必须已是小写 canonical） | 否 | L0 | 传大小写混写 → `E_SESSION_ID_NOT_CANONICAL`（错误里给 canonical） |
| `session_live_prune` | 清死行/损坏行/孤儿 tmp | `dryRun` 默认 `true`；`confirm:"PRUNE"` | 是（删注册表行） | L3 | 不看预览直接确认；以为会删远端行（远端永不删） |

### 1.1 会话解析与 live 保护（所有 A 组共用）

- 解析顺序：`sessionPath` → `sessionId` → `session:"current"` → `session:"latest"`；
  `current` 先问宿主 `exec.agent`，再退 `DSH_SESSION_ID`（`src/tools.js:339-358`）。
- live 保护在**读之前**执行（`assertNotOwnLiveSession`，`src/tools.js:385-478`）：
  - 目标是本宿主加载的会话 → `VISIBLE_TARGET_IS_LIVE_SESSION`；
  - 调用者 id 未知 → `VISIBLE_CURRENT_ID_UNKNOWN`（fail-closed，不猜）；
  - 绕过必须 `allowLive:true` **且** `confirm:"I-KNOW-THIS-CORRUPTS"`，只用于诊断。
- 工具层只有这一道身份保护（只读目标 id，不探测心跳/文件句柄）。`SESSION_IS_RUNNING` 那种
  三路探测在 CLI（`src/live-target.js`，`truncate-cli.mjs` 调用）里：live 行心跳新鲜、Windows
  独占句柄、`$DSH_SESSION_ID` 相等，任一命中即拒。**所以"切别的会话"工具会放行，但并不代表
  它真的没在跑**——先确认没有别的宿主/进程在用。

### 1.2 三个"截断"别混

| | `session_compact` | `session_truncate` | `session_truncate_visible` |
|---|---|---|---|
| 切什么 | 不切；让宿主把旧事件折叠成摘要 | 丢"已被压缩遮蔽"的最老事件 | 丢可见对话的最前若干**整轮** |
| 模型看到的上下文 | 变少（摘要替代） | **不变**（可见面不变） | 变少 |
| 主要收益 | 上下文 | 磁盘字节 / 事件数 | 上下文 + 磁盘 |
| 前提 | 宿主有 compaction 服务 | 先 compact 过，否则没东西可丢 | 至少有一整轮可丢，且切点后有用户消息 |

正确顺序：`session_compact` → `session_health` 确认 `compaction.shadowedEvents > 0` →
`session_truncate`（`INSTALL-RUNBOOK.md`/README 的操作顺序）。

---

## 2. 组 B：记忆生命周期（8）

| 工具 | 作用 | 参数（默认） | 写盘？ | 危险 | 典型误用 |
|---|---|---|---|---|---|
| `lease_acquire` | 原子拿记忆库写锁（`O_EXCL` 创建 `<memoryRoot>/.lease`） | `holder` 必填；`ttlSec` 默认 300（1..86400） | 是（`.lease`） | L1 | 拿锁不释放；ttl 设成一天（源码注释：一天是上限，不是计划） |
| `lease_release` | 释放锁，holder 必须匹配 | `holder` 必填 | 是（删 `.lease`） | L1 | 用错 holder → `ok:false, reason:"not the holder"`，锁还在；没锁时返回 `reason:"no lease"`（是结果，不是异常） |
| `memory_index` | 重建 `INDEX.md` 的生成区 | `apply` 默认 `false` | 是（仅 apply，先备份） | L1 | 以为 dry-run 也会修 INDEX；手工改生成区后不重跑 |
| `memory_consolidate` | 扫 journal，产出"哪段该进哪张卡"的**提案报告** | `since?`（默认 `memory-state.json` 的 `lastConsolidated`） | 是（`.longlive/reports/consolidate-<day>.md` + 状态） | L1 | 以为它会改卡——它只写报告，永不编辑卡片 |
| `memory_reinforce` | 记一次真实使用：strength+1（≤9）、last_used=今天、revisions+1 | `path` 必填；`reason?` 默认"被真实使用" | 是（卡片 + `.longlive/backups/`） | L2 | 对同一张卡刷次数；把"我读了一遍"当"用成功了一次" |
| `memory_forget` | 按衰减规则提议遗忘，`FORGET` 才执行（移入 archive/epochs，从不删除） | `confirm?`（缺省 = dry-run） | 是（备份、`tombstones.md`、`audit.log`、移动卡片） | L3 | 把 dry-run 当已归档；salience ≥5 的卡不会被提议，误以为工具坏了 |
| `memory_procedure` | 程序卡：save/list/get/report | `action` 必填；`name?`、`slug?`、`trigger?[]`、`when?`、`steps?[]`、`failureModes?`、`example?`、`salience?` 1..5、`strength?` 0..9、`outcome?`（report 必填）、`reason?`、`limit?` 默认 50（≤500） | 是（`procedures/<slug>.md`，旧版进备份） | L2 | 用 save 覆盖而不带旧字段（省略字段会保留旧值，这点是安全的）；对坏 frontmatter 的卡硬 save → `E_PROCEDURE_INVALID`，不会覆盖 |
| `memory_recall` | 关键词/短语混合检索卡片 | `query` 必填；`topK` 默认 3（夹到 1..20）；`room?`（`topics`/`journal` 或其子目录）；`status?` 默认 `active+locked`，可选 `archived`/`any` | 否 | L0 | 空 query → `E_RECALL_EMPTY_QUERY`；没命中返回 `ok:true, results:[]`（不是错误） |

补充：

- `memory_consolidate` 的 `since` 只接受 `YYYY-MM-DD`；不要传时间戳。
- `memory_index` 只替换 `<!-- BEGIN GENERATED -->` 与 `<!-- END GENERATED -->` 之间；手工内容保留。
  半对标记 → `E_INDEX_MARKERS`。
- `memory_forget` 的审计行是 TAB 分隔的 `ISO \t action \t object \t result`，写在
  `<memoryRoot>/.longlive/audit.log`，可以直接 `Import-Csv -Delimiter "`t"` 看。
- `memory_recall` 的排序是确定性的：title×5 + tags×3 + 正文词频（封顶 3）+ 整句加分 + 字符 bigram
  Dice；同一棵树、同一 query 字节级可复现。

---

## 3. 不在这 22 个里的东西

| 名字 | 归属 | 说明 |
|---|---|---|
| `memory_save` | engram 插件 | 本插件只在 R1 里拦它（`routerRuntime: on` 时可能拒绝高风险写） |
| `send_meme` / `web_search` / `acp_*` | 宿主或其他插件 | 与本插件无关，不要写进本插件的运维文档当能力 |
| `router_status` / `router_tick` / `router_ask` / `router_report` | 本插件（1.1.0，默认关闭） | `routerEnabled: true` 才注册；打开后 22→26。`routerProposalEnabled: true` 再加 `router_propose` / `router_proposals` / `router_apply`（26→29）；这三个里的 apply 还要 `routerApplyEnabled: true` 才真正写盘。默认配置下**一个都不会出现** |
| 常驻守护 / 定时任务 | **没有** | 1.1.0 仍不注册计划任务、不起 daemon。RouterService 是插件进程内的后台服务，随 `apply()` 起停；`auto-truncate-run.ps1` 是**一次性**脚本（见 `OPERATIONS.md`） |
| scope 打分 / 过滤器 | **规划中** | 面板"过滤器决策"页 `implemented:false`；没有对应工具或配置（Router 的 L1/L2 是上下文注入，不是 scope 打分） |

---

## 3.1 Router 提案三工具（`routerProposalEnabled: true` 才注册）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `router_propose` | 建提案、拿排队号；**不立即写记忆** | `op`、`target`、`title`、`content` 必填；`priority` 不允许 `P0`（返回 `E_PRIORITY_DENIED`） |
| `router_proposals` | 读列表 / 队列 / 详情 | `mode`: `list` \| `queue` \| `detail`；`id`（detail）、`limit`、`status` |
| `router_apply` | 状态迁移：`approve` / `reject` / `apply` / `cancel` / `rollback` | `mode` 必填；`id` **或 `ticket`**（`q-0001`）；`confirm` 只需给 approve/apply/rollback = id 后 6 位；`apply`/`rollback` 还需 `routerApplyEnabled: true` |

`list` 每行的字段（1.1.2 起）：

```json
{
  "id": "journal-2026-11-md-3fa9c1",
  "ticket": "q-0001",
  "title": "补一段 journal",
  "priority": "P3",
  "state": "pending",
  "status": "pending",
  "cancellable": true,
  "terminal": false,
  "createdAt": "2026-11-05T05:00:00.000Z",
  "position": 1
}
```

- `state` 是契约字段；`status` 是**同值只读别名**（外部面板/验收脚本两种拼法都能读）。
- `cancellable`：当前状态是否允许 `reject`/`cancel`，只有 `pending`、`approved`、
  `blocked-on-user` 为 `true`。
- `terminal`：是否已到终态（`rejected`、`cancelled`、`expired`、`superseded`、`conflict` 等）。
- **`superseded` 是合法终态**：同目标小写入合并时，后一条被并入它前面的 keeper
  （`queue.mergedInto` / `supersededBy` 指向 keeper），因此它不该被取消，也没有内容丢失
  ——内容已并入 keeper。检查“队列可取消”时判据是 **`cancellable` 行可取消**，
  而不是“每一行都能取消”。

两个跨版本契约（1.1.2 补测）：

1. **过期只改状态，不删本体**：`expired`（blocked-on-user 24h / 提案 72h TTL）只写
   `status` 与审计（`proposal.expired`，含 `bodyKept`），`proposals/<id>.json` 保留可回溯；
   若未来有清理路径删了本体，审计会出 `proposal.retention_lost`。
2. **重启重建**：服务启动时从 `proposals/*.json` 重建 `proposals/queue.json`
   （审计 `queue.restored`，仅在确实有变化时写），`list` / `queue` / `status` 同源，
   不会出现“文件 approved、队列还写 pending”。

取消示例（按 ticket，不需要 `confirm`）：

```json
{ "mode": "cancel", "ticket": "q-0001", "note": "改主意了" }
```

---

## 4. 最容易出事的五个调用

1. `session_truncate_visible` 带 `confirm` 在应用还开着时调用——会被拒；**不要**为了绕过而加
   `allowLive`，那正是 0.7.0 把 77 个事件写成 3532 个的那条路。
2. `session_truncate` 之前不做 `session_compact`——压缩没发生就没有可丢的遮蔽区，只会得到
   `NO_TURN_BOUNDARY` 或切 0 条。
3. `memory_forget {confirm:"FORGET"}` 前不看 dry-run 清单——卡片会被移走（可恢复，但 INDEX 会变）。
4. `session_live_update` 手填别人的 `sessionId`——注册表会被污染，面板/守卫都会读错。
5. 把 `worker_spawn` 当同步调用——它立即返回 `workerId`，结果要靠 `worker_status` 或通知。
