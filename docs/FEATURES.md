# 1.8.0 可选能力与开关

1.8.0 在 1.6.8 之上新增/变更：**有据才答的注入修复 + 来源闸**（信心闸默认关）、**插件功能默认开启**
（未显式给则 true，仅字面 `false` 关闭；含 autoRecall / identityCard / presenceBus / sharedBrain.activity /
sharedBrain.thinkingInjection / autoMaintenance / D2 / D6 / routerEnabled / routerFace / workers / embedding / autoTruncate）、
**身份默认中性**（由 `IDENTITY.md` 配置）、**可移植加固**。安全/灰度项仍默认关（`answerGuard.gate`、`routerApplyEnabled`、
`strictMemoryRoot`、`routerRuntime: off`、`d6.dryRun` 等）；热截断行为不变。

1.6.8 在 1.6.7 之上并入**共享大脑活动流**（`sharedBrain.activity`，默认关闭，与
`presenceBus` 解耦）与**共享板状态诚实性修复**（board/status/live 的 running 计数、焦点
新鲜度、turn 状态、开机卡时效）。热截断行为与 1.6.7 相同。

1.6.7 是热截断加固版：turn===0 / 无 turn 记录的组不再永久屏障（含 system/developer 指令的
原地保留，只含普通消息的随旧前缀整组归档）；中段缺 turn/end 的轮只有最后启动的当前轮不可切；
新增 onNoPlan 拒绝原因通道，切不了会写 `hot-truncate: 未切（reason）`，不再静默零进展。
1.6.5 / 1.6.6 的热截断热修复（被宿主重启中断的会话不再永久失去自动切刀）继续生效；其余行为与 1.6.4 相同。

1.6.8 的活动流在该版本默认关闭、**1.8.0 起默认开启**（opt-out：`sharedBrain.activity.enabled: false`）、失败静默，与 `presenceBus` 完全独立；开关、预算与回退见下文
「`sharedBrain.activity`」与 [CONFIG.md](CONFIG.md) §1.5b。

1.6.4 在 1.6.0 改名基座之上加入**热截断**（cut-only `CompactionEngine`：只切已完成且早于
保留窗口的整轮，不调 LLM，原始事件不动，只追加一条覆盖率指针；默认 `mode=cut`，自动切达到
300k 估算 tokens 才剪、切完保留最近 4 轮（两个值都可在 `hotTruncate` 下改，
重启宿主生效）；见 `CHANGELOG.md` 的 1.6.4 条目与 `docs/` 中的 Compaction 说明）。下面列出
的可选能力与默认值沿用 1.6.0。

1.6.0 是**改名 + 普适化 + 设置页 + 安全默认**版：包名 `dsh-session-longlive` →
`@jjh32456/dsh-longlive`，显示名「久视」（英文 Longlive）。在这条改名基座上并入可移植记忆根、
Config schema（1.6.0 为 80 节点，1.6.4 增加 `hotTruncate` 块后为 85，本次活动流
`sharedBrain.activity` 再 +5 为 90）与设置页客户端，并把 `autoTruncate` / `routerRuntime` / `worker_*`
三个默认值收到发布口径（见下文与 [CONFIG.md](CONFIG.md)）。迁移步骤见
[MIGRATION-1.6.0.md](MIGRATION-1.6.0.md)。22 个工具的默认表面不变；D2/D6 在 1.8.0 起默认开启（显式 `false` 关闭）。
全量测试 **1063 passed / 0 failed / 9 skipped**。

1.5.0 在 1.4.0 正式版之上并入两件当时**默认关闭**的裁剪能力（1.8.0 起默认开启）：**D2 工具输出裁剪**
（`d2.enabled`，超过 `maxInlineChars` 的工具结果只留头尾，全文归档）与 **D6 工具面裁剪 v1**
（`d6.enabled`，按任务类型冻结 allowlist，其余工具经 `tool_search` 追加）。
两者关闭时与 1.4.0 行为完全一致：不注册 listener、不注册 `tool_search`、22 个工具不变。
全量测试 **1033 passed / 0 failed / 9 skipped**（9 个 skip 与 1.4.0 门相同）。

1.4.0 由 1.4.0-rc.4 冻结，功能代码与 rc.4 相同。发布配置默认值：包内 `cordis.patch.yml` 的 `session-longlive.config`
显式加入 `autoTruncate: { enabled: false, mode: dryrun }`，所以新装 profile 在没有自己的
`autoTruncate` 块时默认关闭自动截断。插件代码里的回退默认在 1.4.0–1.5.0 仍是
`enabled: true` / `mode: 'log'`；**1.6.0 起代码默认也改为 `enabled: false` / `mode: 'dryrun'`**，
手写配置漏写该块不会再自动进入 log。看门安装默认仍是 `enabled: true` / `mode: dryrun`，
本版仍不安装、不注册计划任务。22 个工具与其它开关不变。

1.4.0-rc.3 在 rc.2 之上并入 **C2 常驻看门**：新增 `scripts/session-watch.mjs`（定时检查会话日志，
超过阈值时按配置只发裁剪请求或演练）、配套 drill/fixture 与 install/uninstall/status 三个
PowerShell 脚本，以及 `docs/SESSION-WATCH.md`；`scripts/truncate-cli.mjs` 新增 `--dry-run`
（只读计划，不写备份/归档）。脚本随包发布，但**不安装、不注册计划任务**；即使安装，看门默认
`mode=dryrun`。插件本体的 `autoTruncate` 默认值在 1.6.0 已改为 `dryrun` / 关闭，本版没有改动真机 profile 配置。
详见 [SESSION-WATCH.md](SESSION-WATCH.md)。

1.3.1 修复 identityCard 的跨进程重复注入：同一 sessionId 在**新进程**里续跑时，
`agent/pre-step` 不再第二次插入开机卡。判定从进程内 Map 改为
`<memoryRoot>/.longlive/identity-card/<safeSessionId>.json`：注入前先读 marker，
存在即跳过；注入前用 `O_EXCL` 抢注释位，成功后原子写（tmp + rename），失败
fail-closed 到「不重复注入」并只 warn 一次；30 天以上的 marker 在启动时惰性清理
（每次最多 128 个）。默认值、注入形状与 22 个工具均不变。

本次另加 **D1/D4 工作集度量**：每轮把 fixed/recent/recall/conclusion 四层占用写进
`<memoryRoot>/.longlive/metrics/turns.jsonl`，超预算只记录、不裁剪。默认开启，
`metrics: false` 可关；详见 [METRICS.md](METRICS.md)。D2/D3 的裁剪动作没有实现。

1.3.0 在 1.2.0 之上把 L2 共享板实时化：`board.json` 的 `focus[]` 每行带上
`lastAction: {kind, detail, at}` 与 `queuedCount`（只取插件自己写进 live 行的
`last_action`，`detail` 截 60 字），注入的【共享大脑提示】逐行显示
「最近动作 + 相对时间 + 排队数」。这两个字段参与板子哈希，动作变化会在下一轮
触发一次 hint。**不新增配置键**，旧配置照常工作；22 个工具的数量与语义不变。

1.2.0 在 1.1.0 的 **Router 1.1.0** 之上，新增两件被动观测能力：**记忆准入过滤器**与
**R1 影子记录**。这两件在 1.2.0 默认开启（`filterEnabled` / `shadowEnabled`），只读记忆文件、
只写 `<memoryRoot>/.longlive/`，不调 LLM、不改变工具行为；22 个工具的数量与语义不变。
**1.6.0 起 `routerRuntime` 默认 `off`**，所以影子记录默认不写盘；要记录须显式设
`routerRuntime: shadow`。`filterEnabled` 仍默认开启。

## 开关矩阵

| 配置键 | 默认值 | 打开后注册 | 作用 |
| --- | --- | --- | --- |
| `autoRecall.enabled` | `true` | `agent/pre-step` + `session/event` + `session/disposed` | 从 memoryRoot 的卡片里挑相关段落，作为一条不可见上下文注入本轮 |
| `identityCard.enabled` | `true` | `agent/pre-step` | 把 `<memoryRoot>/STATE.md` 的开机卡插到第一条真人消息之后 |
| `presenceBus.enabled` | `true` | `session/event` | 在 turn/end（completed）时消费本会话的 bus 收件箱并落 spool |
| `sharedBrain.activity.enabled` | `true` | `session/event` + `agent/pre-step` | turn/end 写一条本回合活动到 `.longlive/board/activity.jsonl`；pre-step 只把其他会话新增的活动注入本轮（≤5 条 / 整条 ≤300 字，无新增零 token） |
| `autoMaintenance.enabled` | `true` | 一条 unref 定时器（无 turn hook） | 每日本地日期变化时跑 consolidate 报告 + forget dry-run 待确认清单 |
| `metrics.enabled` | `true` | `session/event` | 每轮 turn/end 写一行四层账到 `.longlive/metrics/turns.jsonl`；只度量，不裁剪 |
| `routerEnabled` | `true` | RouterService + 4 个 `router_*` 工具（`routerProposalEnabled` 时再 +3） | 进程内后台服务：tick、预算账本、提案闸门、L1/L2 活体板、L4 归并、可选唤醒 |
| `routerFace.enabled` | `true` | 无新工具；只起后台 tick 定时器 | v1 后台面：组装 ≤30K 上下文 → 一次 LLM → journal + outbox；不执行工具 |
| `routerRuntime` | `off` | 沿用 0.8.0 的 `src/router/runtime.js` | `off \| shadow \| on`；shadow 只记录不执行，on 仅拒绝高风险写；1.6.0 起默认 off |
| `filterEnabled` | `true` | 启动后异步跑一次过滤器 | 读 `journal/*.md` 打分，写 `.longlive/filter/`，不调 LLM |
| `shadowEnabled` | `true` | 无（旧配置兼容位） | 1.6.0 起不再决定默认值；要记录判定必须显式设 `routerRuntime: shadow` / `on` |
''unavailable'`；显式 true 才可派子会话 |
| `d2.enabled` | `true` | `tools/post-execute` | 工具结果超 `maxInlineChars` 时只放头尾，全文写 `.longlive/tool-output/`，可用 `session_original` 读回 |
| `d6.enabled` | `true` | `agent/inbox/claimed` + `system-prompt/assemble` + `tool_search` 工具 | 首条真实用户消息按任务类型冻结工具 allowlist（重启恢复的 turn>1 会话也冻结一次）；`tool_search` 可追加被裁掉的工具；`dryRun` 只记日志 |

默认值列按 1.8.0 口径：`true` = 默认开启（未显式给则开，仅字面 `false` 关闭）；`routerRuntime` 等安全/灰度项仍默认关。`routerRuntime`、`keepEvents`、`recentWriteWindowMs`、`routerPolicyProfile` 的语义
没有变化。注意 `routerRuntime` 是旧的「工具执行前 R1 判定」接缝，`routerEnabled`
是 1.1.0 新增的后台 RouterService，两者独立，可以只开其中一个。

## 配置写法

`cordis.patch.yml` 的 `config:` 下直接写下面这些块即可。只写要改的字段，未写的字段
取默认值：

```yaml
config:
  keepEvents: 20000
  recentWriteWindowMs: 60000
  routerPolicyProfile: generic
  autoRecall:
    enabled: false
    topK: 3
    budgetTokens: 2000
    everyNTurns: 6
  identityCard:
    enabled: false
    path: "<memoryRoot>/STATE.md"
    maxChars: 800
  presenceBus:
    enabled: false
    pollMs: 3000
  sharedBrain:
    activity:
      enabled: false
      injectMaxChars: 300
      maxItems: 5
  autoMaintenance:
    enabled: false
    consolidate: true
    forget: true
    runOnStart: true
    startDelayMs: 500
  metrics:
    enabled: true
    targetTokens: 40000
    keepTurns: 12
  routerRuntime: shadow
  filterEnabled: true
  shadowEnabled: true
  d2:
    enabled: false
    maxInlineChars: 4096
  d6:
    enabled: false
    dryRun: false
    log: true
    keepTools: []
```

### `autoRecall`

- `topK`：最多注入几张卡片，夹在 1–10。
- `budgetTokens`：注入正文的估算 token 上限，最小 200。
- `everyNTurns`：心跳重扫间隔，最小 1；默认 6。
- 只有 `enabled: true` 才会调用 auto-recall 的 `apply()`；`false` 时连 import
  期之外的文件系统访问都没有。
- 隐私过滤使用 `DSH_PRIVACY_GATE` 指定的 gate；没有配置时退回本地 PII 规则。
- 详细行为见 [AUTO-RECALL.md](AUTO-RECALL.md) 与
  [AUTO-RECALL-WIRING.md](AUTO-RECALL-WIRING.md)。

### `identityCard`

- `path` 支持占位符 `<memoryRoot>`；相对路径按 memoryRoot 解析。
- `maxChars` 默认 800，夹在 120–4000。
- 只做开机卡注入，不启用 identity-router 的草稿回写；因此不会创建 outbox、
  不会改 STATE.md。
- STATE.md 不存在时预检为空，本轮不做任何注入。

### `presenceBus`

- `pollMs` 是同一会话两次消费之间的最小间隔，默认 3000；`0` 表示不节流。
- 只有 `event.type === 'turn/end'` 且 `event.data.reason.kind === 'completed'`
  才消费；失败/中断的轮不会 ack，消息留在 bus 里等下次。
- 消费结果追加到 `<memoryRoot>/.longlive/bus/spool/<sessionId>.jsonl`，随后
  对每条消息 ack。写 spool 失败就不 ack，宁可重放也不丢消息。
- 可用 `presenceBus.root` 显式指定 bus 根目录（测试用）。

### `sharedBrain.activity`（共享大脑活动流，1.8.0 起默认开启）

- **默认开启（1.8.0 起）**：写侧 + 实时注入；数据只在本机 `memoryRoot`、不上传；不想要就设 `enabled: false` 后重启（回到 1.6.8 默认行为）。

- 工具/轮次事件到达时用本地规则（不调 LLM）从「本轮用户实质消息 + 助手结论 + 最近工具动作」
  生成一条 ≤140 字的活动，写进 `<memoryRoot>/.longlive/board/activity.jsonl`；同 key ≤1 条/10s；
- 同会话最近 10 条内 `key` 相同或文本相似度 ≥0.8 时只 `count+1` / 更新 `last_at`；
  同 key 连续 3 次或累计 10 次压成一条「阶段：…（N 次，最近 …）」；
- 每个会话在 `.longlive/bridge/<sessionId>.activity.json` 记 `lastSeenSeq`，每次
  `agent/pre-step` 只注入 `seq > lastSeenSeq` 的**其他会话**活动，最多 5 条、总长
  ≤300 字（含固定头尾）；没有新增就**零 token、零写盘**；blocked 优先；
- 失败静默，不影响 turn；隐私门复用 `src/recall/privacy.mjs`；写盘用跨进程锁 +
  tmp/fsync/rename，两个会话并发写不会丢行或撞 seq；
- 与 `presenceBus` 完全独立，关掉一个不影响另一个；回退：`enabled: false` 后重启；
- 面板：活动流的「谁在干什么」页不在面板 0.2.6 内（由面板侧后续版本提供）；
  longlive 包只负责写盘与增量注入。

### `autoMaintenance`（B1/B2，1.8.0 起默认开启）

- 打开后只注册一条 `unref` 的单次 `setTimeout`，指向下一个**本地**午夜（+1s）；
  每次跑完再挂下一天，没有轮询，也不挂 `agent/pre-step`，所以失败影响不到 turn。
- 启动补跑：`runOnStart` 默认 `true`，`startDelayMs` 默认 500ms；同一天已经跑过
  就只读状态并跳过（`lastConsolidateDate` / `lastForgetDate` 为幂等键）。
- B1 `consolidate`：调用 `memory_consolidate` 的报告模式，报告写
  `<memoryRoot>/.longlive/reports/consolidate-YYYY-MM-DD.md`，不改卡片。
- B2 `forget`：调用 `memory_forget` 且**不传 confirm**，只走 dry-run；待确认清单写
  `<memoryRoot>/.longlive/reports/forget-pending-YYYYMMDD.md`。本模块没有任何路径
  会传 `confirm:"FORGET"`，真删仍需人工调用工具。
- 状态：`<memoryRoot>/.longlive/bridge/schedule.json`（`lastConsolidateDate`、
  `lastForgetDate`、最近报告路径、`runs` 最近 30 次、`last*Error`）。状态损坏时按
  空状态继续，下一次原子写入会先把旧文件备份到 `.longlive/backups/`。
- 任一 job 失败都只 `warn` 并写 `last*Error`，不抛出；失败日期不推进，下一次启动
  或下一个午夜会重试。
- `consolidate: false` / `forget: false` 可单独关掉一项；两项都关时零定时器。
### `metrics`（D1/D4，默认开）

- 只度量：每轮 `turn/end` 记录 `fixed/recent/recall/conclusion` 四层、`total`、`actual`、
  `recallCount`、`recallIds` 和预算判定；超预算只写 `budget.over=true`，不报错、不裁剪。
- 账本：`<memoryRoot>/.longlive/metrics/turns.jsonl`；校准：同目录 `state.json`。
- 估算按 CJK×1 + 非 CJK/3.5，冷启动误差约 -9%，之后用累计比值校准；误差算法见
  [METRICS.md](METRICS.md)。
- 读取：`readTurnLedger()` / `readMetricsSummary()`，或
  `node scripts/metrics-read.mjs --memory-root <root>`；`router_status.ledger` 是同一份汇总。
- `metrics: false` 或 `metrics.enabled: false` 关闭；度量失败永远静默，不拖垮对话。

### `routerEnabled`（Router 1.1.0，1.8.0 起默认开启）

`routerEnabled` 只认字面 `true`。`false` 时 RouterService 不创建、`router_*` 不注册、
`.longlive/router/` 不落盘，注册表仍是 22 个工具。打开后：

- **进程内服务，不是 daemon**：随插件 `apply()` 起停，由 `ctx.effect` 注册 dispose；
  不注册计划任务、不开端口、不起常驻会话。
- **生命周期**：`starting/running/blocked/stopping/stopped/standby`；tick 单飞；
  启动约 3s 首次 full tick、`turn/end` completed 2s 防抖/5min 合并、60s 定时
  reflect、`router_tick` 手动 2s；连续 3 次错误进 `blocked(E_ERROR_STREAK)`，
  退避 5s→300s。
- **模型**：`routerModel=auto` 按「显式 id → 宿主 `currentSelection()` → listModels
  首个非 preview → blocked」；显式 id 不在列表只警告 `MODEL_UNLISTED`、不 block；
  启动时 llm 未就绪进 `waiting_provider`，30s 起退避、上限 5min、可被事件唤醒。
- **工具**：核心 4 个 `router_status`/`router_tick`/`router_ask`/`router_report`；
  `routerProposalEnabled=true` 再加 `router_propose`/`router_proposals`/`router_apply`，
  22→26→29。
- **提案**：工具层拒 P0（`E_PRIORITY_DENIED`）；主会话 6/h、子代理 3/h；默认 72h
  过期；`detail=true` 对非作者/非主人/子代理只给摘要；批准与应用只允许主会话或
  主人 CLI，confirm 用提案 id 后 6 位。
- **apply**：`routerApplyEnabled` 默认 false，是第二道闸门；九步写入协议（租约、
  WAL、目标 sha、快照、tmp、rename 前复核、读回），冲突零写，读回不符只报
  `restoreRequired`，不自动回滚。
- **L1/L2**：`session/created` 与 `turn/end` 维护 live 行（写侧 128 上限）；`board.json`
  ≤8KB；hint 只在 boardHash 变化或每 10 轮注入，日上限 24 次/12,000 token，空轮不注。
- **L4**：同 target+op+mergeKey 的相邻小写合并（单段 ≤2KB、合并后 ≤4KB），被并者
  `superseded`；每会话每日 1 次、全局每日 5 次。
- **唤醒**：`routerWakeEnabled` 1.8.0 起默认 true（显式 false 关）；只对 idle/waiting 根会话，600s 冷却、每日
  20 次、`recentWakeIds` 去重，写 `wake-ready.jsonl` 交给外部消费。
- **面板只读**：`@jjh32456/dsh-longlive-panel@1.8.0` 只读 status/board，不做 approve/apply/propose。

Router 的 50 个配置键见 [CONFIG.md](CONFIG.md)；契约测试在 `test/router-1100/` 与
`test/router-l1-l2.contract.test.mjs`。

### `routerFace`（v1 后台面，1.8.0 起默认开启）

一个**不属于任何会话**的后台 tick：每 `tickMs`（默认 60s）在 `maxContextTokens`
（默认 30K）内组装身份 + 状态卡 + 心流 + 共享板 + 最近 5 条 face journal + 最多
10 条待办，调一次宿主 LLM，写一条 ≤400 字 journal；模型给的 ≤3 条建议只进
`.longlive/bridge/router-outbox.jsonl`，**不执行任何工具**。

- **共用身份**：前台 hint 与后台都读 `<memoryRoot>/IDENTITY.md`；文件不存在时用
  内置默认身份，不自动创建、不自动改。前台每条 hint 会多一行「身份：…」。
- **跨会话通道**：`bridge/router-outbox.jsonl` 每行
  `{at, sessionHint, text, kind, readAt}`；前台注入 hint 时只渲染最近 1 条未读
  （≤300 字），读到后回写 `readAt`。触发优先于 board-hash 变化，但一次只带 1 条。
- **刹车**：`routerFace.enabled` 1.8.0 起默认 true（显式 false 关）；`dryRun` 默认 true（只写 journal，
  不调 LLM）；日预算 `dailyTokenBudget` 默认 50000（input+output 计），超了停；
  连续 3 次失败自动停并写 `face/status.json`。任何 tick 失败只记 status，
  不抛、不影响 turn。
- **依赖**：bridge 的渲染挂在 Router 的 hint 注入器上，所以要看到「后台留话」
  仍需 `routerEnabled:true` + `routerSharedBoard:true`；只开 `routerFace` 会写文件，
  但不会有人把话递到前台。
- **产物**：`.longlive/face/journal.jsonl`、`state.json`、`status.json`、`face.lock`；
  退出时 `ctx.effect` 调 `dispose()` 清定时器，幂等。
- **测试**：`test/router-face/`（12 个用例，注入假 LLM + 假 memoryRoot）。

### `d2`（D2 工具输出裁剪，1.8.0 起默认开启）

- **打开**：写 `d2: { enabled: true }`（`maxInlineChars` 默认 4096），改完重启宿主。
- **观察**：超限结果里出现一行提示，给出 `<memoryRoot>/.longlive/tool-output/<turn>/<callId>.txt`
  的绝对路径与 `session_original(turn, toolCallId)` 读回方式。
- **回退**：`d2.enabled: false`（或删掉整个 `d2` 块）后重启；没有数据迁移。已归档的
  `.longlive/tool-output/` 可直接留作证据或手工删除，不动记忆卡片。
- **边界**：`read` 默认在 `skipTools` 里，不做二次裁剪；错误结果默认不裁
  （`trimErrors: false`）；隐私命中不落盘；扫描、写盘或裁剪任一步失败都 fail-open 用原文。

### `d6`（D6 工具面裁剪 v1，1.8.0 起默认开启）

- **打开**：写 `d6: { enabled: true }`；建议先 `dryRun: true` 只记日志，确认分类与保留名单
  后再正式打开。改完重启宿主。
- **找回工具**：被裁掉的工具用 `tool_search` 申请：
  `tool_search({ names: ["router_status"] })` 或 `tool_search({ query: "截断" })`，
  `limit` 默认 8（1–20）；申请结果在下一步追加到工具列表末尾。`D6_DRY_RUN` /
  `D6_NOT_FROZEN` 表示当前没裁剪或尚未冻结，不会改变工具面。
- **回退**：`d6.enabled: false`（或删掉整个 `d6` 块）后重启；没有数据迁移，不需要改
  memoryRoot。运行中任一步异常或裁剪后工具集为空，也会自动回到全量。
- **本版没有 `d6.taskProfiles` 键**：任务模板是代码内建的 `code` / `media` / `general`
  三类；`keepTools` 只能按工具名额外保留，不能自定义任务模板。
- **风险**：同一会话内 allowlist 在首条真实用户消息上冻结（宿主重启后恢复的 turn>1 会话同样冻结一次），不随消息变化；`tool_search` 多一次
  工具往返；`dryRun: true` 时 `tool_search` 不会注册。

### `hotTruncate`（热截断，`compaction-hot-truncate` 行，默认接管压缩）

热截断是 1.6.3 起包内 `cordis.patch.yml` 默认插入的 cut-only 压缩引擎
（`@jjh32456/dsh-longlive/compaction`）：不调 LLM，只把「已完成、且早于保留窗口」的整轮换成一条
覆盖率指针，原文先归档。它的配置写在 `compaction-hot-truncate` 条目的
`config.hotTruncate` 下，**不属于** `session-longlive` 行。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `hotTruncate.mode` | `cut` | `off` 让位 stock；`cut` 在宿主每步按阈值检查并响应压缩调用；`auto` 再加空闲时自动切 |
| `hotTruncate.retainTurns` | `4` | 切完保留最近 4 轮完成对话 |
| `hotTruncate.retainTokens` | `8000` | 保留窗口的估算 token 下限（与轮数同时满足才切） |
| `hotTruncate.autoMinTokens` | `300000` | 自动切（`cut` 的每步检查、`auto` 的空闲切）达到该估算 token 数才剪；手动 `/compact` 与溢出恢复不受限 |

**成本理由**：每次切刀都会改写上下文前缀，让模型的前缀缓存失效，下一轮剩余上下文按全价
重算。默认阈值从 1.6.3 的 30k 提到 300k、保留从 6 轮收到 4 轮后，切刀间隔从「每轮一刀」
拉长到「十几轮一刀」，缓存命中率上去、账单下来。

### 身份默认中性（1.8.0）

- **默认行为**：内置身份默认中性——不内置任何人名、角色、称呼；身份来自用户
  `<memoryRoot>/IDENTITY.md`（只读；文件不存在时用中性默认，不自动创建/改写）。
- **蒸馏 who**：`memory_*` 写入与蒸馏的 who 字段默认为空，由用户显式配置注入；不再把内置称呼
  当默认值。
- **配置**：`identityCard.path` 支持 `<memoryRoot>` 占位；`maxChars` 默认 800（120–4000）。
  只做开机卡注入，不启用 identity-router 的草稿回写，不创建 outbox、不改 STATE.md。
- **隐私门**：发布包不含个人姓名/本机路径；打包隐私扫描 0 blocker 为发版门。详见
  [PRIVACY.md](PRIVACY.md)。

### `sharedBrain.thinkingInjection`（1.8.0，摘要级默认开启）

- 默认 **`true`**（未显式给则 true，仅字面 `false` 关闭）：只做摘要注入；与 `sharedBrain.activity` 相互独立，关闭后零副作用。
- 开启后：pre-step 只注入其他会话的**摘要**（不注入原文）；失败静默，不影响 turn。
- **隐私边界**：写入/注入前复用 `src/recall/privacy.mjs` 隐私门，`local_only` 不写不注入；
  摘要不进错误日志，错误只记状态。
- 配置键与开关取值以 [CONFIG.md](CONFIG.md) 的 `sharedBrain.thinkingInjection` 段为唯一权威；关闭后零副作用。

### 来源闸与证据投递（1.8.0，默认关闭）

- `answerGuard.gate.enabled=false`（默认）：不改变现网行为；`true` 时启用三态判定
  `decideAnswerMode` 与 M1.5 文本层硬规则（每个事实句需「第 N 轮」引用、数字可回读、
  未标注推断视为幻觉、不得声称未发生的工具调用）。
- 证据投递修复（默认生效，属注入层）：`evidenceMaxChars` 1200→4000、助手 excerpt 300→800、
  `HISTORY_CUE_RE` 增加「当时/那时/那次/当天」——修复「证据已注入但答案被截在 300 字外 →
  误判零证据而弃答」。
- 审计字段：`gate {mode, reasons, signals, assertions, citations}`；详见
  [ANSWER-GUARD.md](ANSWER-GUARD.md)。

## 关闭时的零副作用

`src/features.js` 在模块顶层没有 I/O。`registerFeatures()` 先归一化配置：未显式给视为 `true`，只有字面 `false` 才关闭；
某项 `enabled === false` 时该块直接返回 `{enabled: [], config}`，不调用 `ctx.on`、不读 STATE.md、不创建 bus 目录、不打日志。
`test/feature-flags.test.mjs` 用冻结注册快照逐项比对工具、钩子、返回值与磁盘访问。

Router 还多一道 `routerEnabled`：`false` 时 `src/index.js` 连 `createRouterService`
都不调用，没有定时器、监听器、board/live/inject-state 写盘，也不注册 `router_*`
（`test/router-1100/apply-off.test.mjs`）。

`metrics` 是独立于 `registerFeatures` 的默认监听：只挂一个 `session/event`，只写
`.longlive/metrics/`，所有异常都吞掉；`metrics: false` 时连监听都不注册。
`test/feature-flags.test.mjs` 的冻结快照只覆盖 `registerFeatures` 三项，不含 metrics。

## 回滚

### 从 1.5.0 回到 1.4.0

1. 把 `d2.enabled` / `d6.enabled` 改回 `false`（或删掉两个块）；`d6.enabled: false`
   即不再注册 `tool_search`。
2. 安装 `dist/dsh-session-longlive-1.4.0.tgz`，重启两次确认 stderr 无 `did not activate`。
3. 没有数据迁移；`.longlive/tool-output/` 是独立目录，可保留取证或手工删除，不要删
   memoryRoot 下的卡片。

### 更早版本（0.9.x → 当前）

1. 先把 `routerEnabled` 设为 `false`（立即停用 Router）；再把 `package.json` 的
   version 改回 `0.9.0-rc.6`（或安装 0.9.0 的 tgz）。
2. 删除新增的 `autoRecall` / `identityCard` / `presenceBus` / `metrics` 配置块；若开过
   Router，再删掉所有 `router*` 键；保留原有 `keepEvents` 等键。
3. 若开过 `presenceBus`，spool 与 `.longlive/bus` 是独立目录，可直接保留或
   手工删除；若开过 Router，`.longlive/router/`（board/live/proposals/queue/WAL/
   snapshots）也是独立目录，可直接保留取证或手工删除；不要删 memoryRoot 下的卡片。
4. watcher 若装过，先运行 `uninstall-resident-watcher.ps1` 再降级；包本身不会
   自动注册计划任务，所以纯 npm 回滚不涉及计划任务。

## 兼容承诺

- 0.9.0 的 21 个工具名、参数 schema、返回形状不变。
- 0.9.0 的配置键语义不变；新增键只在显式打开时生效。
- 默认安装只多一个 metrics 度量监听（写 `.longlive/metrics/`，失败静默）；不产生 Router
  文件、不注册其他新钩子、不改变启动日志。
- 新模块的错误被限制在自己的钩子内，不允许拖垮既有 truncate/live/router 流程。
