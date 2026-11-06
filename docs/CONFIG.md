# CONFIG.md — @jjh32456/dsh-longlive（久视）配置手册

适用版本：**1.6.8**（以包内 `package.json` 的 `version` 为准）。所有默认值以该源码树为准。
读者：会改 YAML、会看日志，但没参与开发的人。

---

## 0. 先搞清楚三件事

1. **配置写在哪。** 写在当前 profile 的 `cordis.patch.yml` 里、`- id: session-longlive` 这一条目下。
   只改这一个条目的 `config:`，不要把发布包 `cordis.patch.yml` 里的 `- insert:` 整段复制进 profile
   （会出现重复 id，见 `INSTALL-RUNBOOK.md` §6）。
2. **改完必须重启。** 插件的全部配置在 `apply(ctx, config)` 里读一次（`src/index.js:96-247`），
   之后不再重读；面板配置同理。改 YAML 不重启 = 没改。
3. **一个写错，整条不激活。** `autoTruncate` 会在插件加载时归一化，非法值直接抛
   `AUTO_BAD_CONFIG` / `AUTO_BAD_MODE`（`src/auto-truncate.js:107-147`，调用点 `src/index.js:156`，
   这一句没有 try 包住）。表现是宿主 stderr 出现 `1 entry did not activate`，**所有工具一起消失**，
   不是只有自动截断失效。

YAML 路径建议一律用正斜杠（例如 `<memory-root>/topics` 这种写法），反斜杠在 YAML 双引号里会被当转义符。

---

## 1. 配置键总表

### 1.1 记忆库与路径

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `memoryRoot` | string（绝对路径） | 未设时 `<DSH home>/longlive-memory`（推导值，会自动创建） | 一个**已存在**的目录 | 是 | 显式配置的目录**不会**被创建；写错 → 启动告警，memory 类工具报 `E_MEMORY_ROOT_MISSING`。解析顺序见 §3 |
| `memRoot` | string | 无 | 同上 | 是 | 0.7.3 之前的别名；与 `memoryRoot` 同时给时 `memoryRoot` 优先（`src/memory/paths.js` 解析器） |
| `strictMemoryRoot` | boolean | `false` | `true` / `false` | 是 | `true` 时"没配根"直接报 `E_MEMORY_ROOT_UNSET`，不再回落到推导默认值。多机/生产建议开 |
| `home` | string | `$DSH_HOME`，否则 `~/.dsh` | 目录 | 是 | 测试缝：覆盖 DSH home（会话目录、live 注册表都跟着变）。普通部署不要设，见 `src/home.js` |

### 1.2 自动截断 `autoTruncate`

配置形态是嵌套对象：

```yaml
autoTruncate:
  enabled: true
  mode: request
```

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `enabled` | boolean | `false` | `true` / `false` | 是 | 1.6.0 起默认关闭。`false` 时 `evaluate` 在写日志之前就早退（`disabled`），连日志行都没有（`src/auto-truncate.js:390-443` 的早退分支） |
| `mode` | string | `dryrun` | `log` \| `dryrun` \| `request` | 是 | 1.6.0 起默认 `dryrun`（只规划不写会话）。**没有 `on`**。写 `on` → `AUTO_BAD_MODE`，整条 entry 不激活。旧值 `apply` 会被改写成 `request` 并记 `modeAlias:"apply->request"`（`src/auto-truncate.js:64,117-125`） |
| `tokensThreshold` | integer | `300000` | ≥ 1 | 是 | 阈值比较是 `estimate.tokens >= tokensThreshold`（`src/auto-truncate.js:435`）。`tokens` 是**启发式估算**：对 `MESSAGE_TYPES` 事件的 data JSON 取字符数 ÷ 4（`src/truncate-visible.js:80`），不是宿主计费 token，两者偏差**待核实**。阈值压到几千只适合演练 |
| `minTurns` | integer | `12` | ≥ 1 | 是 | 条件对 turn 数是**严格大于**：`estimate.turns > minTurns`（同 435 行）。`minTurns: 1` 表示第 2 个 turn 起才可能触发 |
| `cooldownMinutes` | integer | `60` | ≥ 0 | 是 | 每会话冷却；**低于阈值的评估也会消耗冷却窗口**（同文件 438-440 注释）。`0` 只用于 VM 采样：超过阈值后每个 turn 都会评估并尝试写请求（single-flight，已有请求不会被覆盖），生产别用 |
| `keepTurns` | integer | `12` | ≥ 1 | 是 | 交给 runner 的"至少保留轮数"；实际切点由 `planVisibleTruncation` 重算，双边界取**更晚**的一个（保留更少），见 `src/truncate-visible.js:437-597` |
| `keepTokens` | integer | `80000` | ≥ 1 | 是 | 同上；按估算 token 算保留后缀。两个值都调小 = 切得更狠 |
| `appExe` | string | `""` | 可执行文件绝对路径 | 是 | 空 → 运行时用 `process.execPath`（宿主进程 exe，`src/auto-truncate.js:321-328`）。runner 关闭/重启应用用的是 request 里记录的 `app.exe`，这里写错 → runner 关错进程或起不来（exit 6） |
| `profile` | string | `desktop` | 字符串（只是标签） | 是 | 只写进 request 的 `app.profile` 和 runner 日志，**runner 重启时并不传 profile 参数**（`explorer.exe "<appExe>"`，脚本 118 行）；写错不会切 profile，但会让排障误判。未来是否用于多 profile 启动**待核实** |

补充：

- **发布默认值（1.4.0 起，1.6.0 收紧代码默认）**：包内 `cordis.patch.yml` 的
  `session-longlive.config` 显式写了 `autoTruncate: { enabled: false, mode: dryrun }`；1.6.0
  起 `src/auto-truncate.js` 的代码回退默认也改为 `enabled: false` / `mode: dryrun`。所以无论
  是发布配置还是手写配置漏掉该块，自动截断都默认关闭；想开启必须显式写 `enabled: true`。
- `mode: request` 只写 `<memoryRoot>/.longlive/logs/auto-truncate.request.json`，**不碰会话日志**；
  真正改写会话的是宿主外的 `scripts/auto-truncate-run.ps1` + `scripts/truncate-cli.mjs`。
- `mode: dryrun` 会真的跑一遍 `truncateVisibleSession({dryRun:true})`（读+规划+报告），但不写盘；
  日志里 `action:"dryrun-planned"`，`wroteSessionFile:false`。
- `mode: log` 只规划并写一行日志，适合先看"如果切会切到哪"。

### 1.3 路由与策略（R1）

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `routerRuntime` | string | `off` | `off` \| `shadow` \| `on` | 是 | 非法值**不会**变 `on`，而是按 `off` 处理并告警（`src/index.js:178-180`、`src/router/runtime.js` 的 `normalizeMode`）。`on` 只拒高风险**写**，只读调用永不拒 |
| `routerRuntimeStatePath` | string | `<memoryRoot>/.longlive/router-runtime.jsonl` | 可写文件路径 | 是 | 没配 memoryRoot 时记录会被丢弃（`src/index.js:181-183` 的告警）。文件按行追加，超过上限自动轮转 |
| `routerRuntimeMaxRecords` | integer | `1000` | ≥ 1（由运行时归一化） | 是 | 记录条数上限；调大 = 占盘更多。轮转保留最新 N 条 |
| `routerPolicyProfile` | string | `generic` | `generic` 或 `src/router/policies/<name>.json` 里存在的名字 | 是 | 未知名字在加载时只告警，`route()` 里 fail-closed 成 `E_ROUTE_PROFILE_UNKNOWN`（`src/policy-profile.js`）。叠加层只许收窄，不许放宽 |

### 1.4 会话截断与心跳

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `keepEvents` | integer | `20000` | ≥ 1 | 是 | 只作为 `session_truncate` 的默认 `keepEvents`（`src/index.js:199`）。切点还会被"第一条可见消息"夹住，见 `planTruncation` `src/truncate.js:103-152` |
| `recentWriteWindowMs` | integer | `60000` | ≥ 0 | 是 | 最近写窗口；窗口内拒绝截断（`SESSION_RECENT_WRITE`）。runner 走 CLI 时显式传 0，因为它假定宿主已退出 |
| `heartbeatMs` | integer | `15000` | 有限正数；`0` 只关定时心跳与工具调用触发的写 | 是 | `0` **不关 turn 边界状态机**：turn/start 与 turn/end 仍维护 live 行 state/turn；也不影响自动截断：`onTurnEnd` 在 `enabled` 门之前触发（`src/heartbeat.js:169`）。给 1 这种极小值 = 高频写盘，别这么干；无上限校验 |
| `recoverOnStart` | boolean | `true` | `true` / `false` | 是 | 启动时扫 `.truncate-visible-inflight.json` 并收尾/回滚（`src/index.js:230-236` + `sweepInflight`）。只有排障时才建议关 |
| `originalFetchMaxBytes` | integer | `65536` | 1024..4194304（超范围夹回） | 否 | 仅 `session_original` 的单次返回上限（UTF-8 字节）；超出按 `offset` 分页。隐私门先扫全量，调大它不会绕过隐私拦截 |
| `touchLiveSession` / `now` / `defineTool` | 内部 | — | — | 是 | 测试注入缝（`src/index.js:160,193-195,205`），不是给部署用的稳定配置；**待核实**未来版本是否保留 |

### 1.4a 热截断 `hotTruncate`（`compaction-hot-truncate` 行，默认接管压缩）

热截断是包内 `cordis.patch.yml` 默认插入的 cut-only 压缩引擎（`@jjh32456/dsh-longlive/compaction`）。
它的配置写在 **`compaction-hot-truncate` 条目**的 `config.hotTruncate` 下，不写在
`session-longlive` 条目里；两个条目改完都要重启宿主。宿主的 stock `compaction-basic` 行被
patch 关掉，引擎加载失败时 `entry.js` 自动回退 stock，`/compact` 仍可用。

```yaml
- insert:
    - id: compaction-hot-truncate
      name: '@jjh32456/dsh-longlive/compaction'
      config:
        hotTruncate:
          mode: cut
          retainTurns: 4
          retainTokens: 8000
          autoMinTokens: 300000
```

只覆盖要改的键即可：profile 的 `cordis.patch.yml` 按 `id` 合并，不必重复整段 `- insert:`。
例如把阈值放到 200k、切完保留 6 轮：

```yaml
- id: compaction-hot-truncate
  config:
    hotTruncate:
      autoMinTokens: 200000   # 达到 200k 估算 tokens 才剪
      retainTurns: 6          # 切完保留最近 6 轮完成对话
```

没写的键继续用上表默认值；`hotTruncate` 在插件构造时读一次，**改完必须重启宿主才生效**。

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `hotTruncate.mode` | string | `cut` | `off` \| `cut` \| `auto` | 是 | `off` 让位 stock；`cut` 在宿主每步按阈值检查并响应压缩调用；`auto` 再加 `agent/status=idle` 时自动切。非法值在 `normalizeOptions` 直接抛错，entry 回退 stock（`src/compaction/engine-core.js`） |
| `hotTruncate.retainTurns` | integer | `4` | ≥ 0 | 是 | 切完保留最近 4 轮完成对话；只有**同时**满足轮数与 token 下限的整轮才留下，未完成的轮永远不切 |
| `hotTruncate.retainTokens` | integer | `8000` | ≥ 0 | 是 | 保留窗口的估算 token 下限；与 `retainTurns` 一起决定切点 |
| `hotTruncate.autoMinTokens` | integer | `300000` | ≥ 0 | 是 | 自动切（`cut` 的每步压力检查、`auto` 的空闲切）达到该估算 token 数才剪；手动 `/compact` 与请求溢出恢复不受此限。默认 300k 是为了避开前缀缓存失效——每次切刀改写上下文前缀，下一轮剩余上下文全价重算 |

**成本理由**：切刀不调 LLM，但会改写上下文前缀，使模型的前缀缓存失效，下一轮要按全价重算
剩余上下文。1.6.3 的 30k 触发 + 6 轮保留在长对话里几乎每轮一刀；1.6.4 改成 300k 触发 +
保留 4 轮，切刀间隔拉长到十几轮，缓存命中率上去、账单下来。

### 1.4b D2 工具输出裁剪 `d2`（默认关闭）

配置形态是嵌套对象；只有 `d2.enabled: true` 才挂 `tools/post-execute`，默认整段不存在时
一切保持原样。

```yaml
d2:
  enabled: false
  maxInlineChars: 4096
```

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `d2.enabled` | boolean | `false` | 仅字面 `true` 开启 | 是 | 关闭时不注册钩子、不建目录、不读会话；开启后单条工具结果超限即裁剪 |
| `d2.maxInlineChars` | integer | `4096` | 64..1000000（超范围夹回） | 是 | 上下文里保留的字符上限（头 + 提示行 + 尾）；夹回逻辑见 `src/tool-output.js` 的 `normalizeD2Config` |
| `d2.headRatio` | number | `0.6` | 0..1（夹回） | 是 | 头部占保留预算的比例，其余给尾部；提示行本身不占这个预算 |
| `d2.skipTools` | string[] | `["read"]` | 工具名数组 | 是 | `read` 默认跳过：它本来就是按需分页读文件，再裁一次会让读回归档变成死循环 |
| `d2.trimErrors` | boolean | `false` | `true` / `false` | 是 | `false` 时 `isError` 结果的原文完整保留（错误信息通常短且关键） |

补充：

- **落盘位置** `<memoryRoot>/.longlive/tool-output/<turn>/<callId>.txt`，文件名复用
  `src/original.js` 的 `archiveFileName`，与 D3 `session_original` 报告的是同一套约定；
  提示行给出绝对路径、字节数与 `session_original(turn, toolCallId)` 读回方式。
- **隐私门**：写盘前先对全文跑 `src/recall/privacy.mjs` 的 `privacyScan`；命中 → 不落盘，
  上下文只留一行占位。扫描或写盘失败 → fail-open，原文照常进入上下文，不阻断 turn。
- **与宿主内置 `spill-policy` 的关系**：D2 的监听不带 `{prepend:true}`，在其它 policy 之后
  执行并用自己的 content 覆盖最终决定，所以归档路径不会被 spill 的临时目录替换。
- **回退**：`d2.enabled: false`（或删除整个 `d2` 块）后重启；已归档文件不动会话，可保留
  取证或手工删除。

### 1.4c D6 工具面裁剪 v1 `d6`（默认关闭）

只有 `d6.enabled: true` 才注册 `tool_search` 与两个 listener；默认整段不存在时工具面与
1.4.0 完全一致。

```yaml
d6:
  enabled: false
  dryRun: false
  log: true
  keepTools: []
```

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `d6.enabled` | boolean | `false` | 仅字面 `true` 开启 | 是 | 关闭时不注册 listener、不注册 `tool_search`，`allTools` 仍是原始 `TOOLS` |
| `d6.dryRun` | boolean | `false` | `true` / `false` | 是 | `true` 只输出 `[d6] dry-run task=... keep=... trim=... names=...` 日志：不 `restrict`、不注册 `tool_search` |
| `d6.log` | boolean | `true` | `true` / `false` | 是 | `false` 关闭 `[d6]` info 日志（冻结与追加的决策仍照常生效） |
| `d6.keepTools` | string[] | `[]` | 工具名数组 | 是 | 在任务模板之外额外强制保留的工具名（特殊 profile / 测试用） |

补充：

- **冻结时机**：`agent/inbox/claimed` 在 `ReactLoopInbox.claim` 内同步触发，早于 preStep 的
  `tools.resolve`，所以 allowlist 在会话的第一条真实用户消息上就确定，本会话内不再随消息变化。
  宿主重启后恢复的会话，第一条新消息就是 turn>1；D6 也在重启后的第一条真实用户消息上冻结一次
  （每个进程一次），否则该会话整个生命周期都不会再裁剪（1.6.3-rc.2 起修复，见 `runtime.js` 的
  `onClaimed`；`D6_NOT_FROZEN` 只表示还没碰到真实用户消息，不再表示“长会话永远不冻结”）。
- **任务分类**：`classifyTask` 分 `code` / `media` / `general` 三类；`read` / `write` / `edit` /
  `pwsh` / `glob` / `grep` / `todo*` / `tool_search`、`session_*`、`memory_*` 永不裁剪；
  当前 goal 的 objective 也参与分类。
- **恢复路径**：`tool_search` 按名称或关键词列出被裁掉的工具：
  `tool_search({ names: ["router_status"] })` 或 `tool_search({ query: "截断" })`；
  `limit` 默认 8（1–20）。申请到的工具由 `system-prompt/assemble` 追加到工具列表
  **末尾**（0.2.1 形状），不改变原有顺序，下一步生效。未冻结或 dry-run 时返回
  `D6_NOT_FROZEN` / `D6_DRY_RUN`，不改变工具面。
- **没有 `d6.taskProfiles`**：任务模板是代码内建的 `code` / `media` / `general` 三类；
  `keepTools` 只能额外按工具名保留，不能自定义任务模板。
- **回退**：`d6.enabled: false`（或删除整个 `d6` 块）后重启；没有数据迁移。运行中选择、
  `restrict()` 或组装任一步抛错、或裁剪后工具集为空，也一律回到全量工具面，不阻断会话。

### 1.5 面板（@jjh32456/dsh-longlive-panel@0.2.6，独立可选插件）

面板的配置**不继承**上面插件的 `memoryRoot`，它有自己的两个键（`src/server.js:2103-2109`）：

| 键 | 类型 | 默认值 | 合法值 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `memoryRoot` | string | `~/.dsh/longlive-memory` | 目录 | 是 | 面板只读这个目录。插件配了显式根（本机示例 `<memory-root>`）而面板没配 → **面板显示 0 卡**（它读的是默认空目录），不是记忆丢了 |
| `sessionsRoot` | string | `~/.dsh/sessions` | 目录 | 是 | "截断记录"页读这里的 `<会话目录>/truncate.json`、`truncate-visible.json`（宿主可见对话截断账本）和 `backups.json`（并 stat 账本里记的备份文件）；两份截断账合并后按时间倒序列出。指错 → 该页空白 |

面板也可以用环境变量 `DSH_LONGLIVE_MEMORY_ROOT` / `DSH_MEM` 覆盖 `memoryRoot`。0.2.6 是配套本版的「六层视图活体行排序 + 已归档折叠（按需物化）」与红队 v1 回执修复版；本机 `desktop` profile 之前装的是旧版面板，升级到 0.2.6 的装法/验证/卸载见包内 `INSTALL.md`，装完或改配置后必须重启宿主。

**1.6.0 新增：插件自带的设置页伴侣**（不是上面的面板包）。`package.json` 的 `./client` +
`src/ui/*` 在宿主设置页的插件行注册 `plugins.row.config`，标题「久视 · 功能开关」，提供 7 个
开关（D2 / D6 / 自动想起 / 共享大脑 / 后台面 / 每日维护 / Router）和只读 memoryRoot 展示；
slot key 为 `@jjh32456/dsh-longlive#session-longlive`（包名已改，row id 仍是 `session-longlive`）。
保存走宿主 `configEditor.edit` 写回 profile patch，再由 Loader 常规重载；没有 `webServer`
的 profile 不注册 `/api/longlive/flags`，插件照常加载。`workers.enabled` 不在 7 个面板开关里，
需要直接改配置。

### 1.5b 共享大脑活动流 `sharedBrain.activity`（默认关闭）

```yaml
sharedBrain:
  activity:
    enabled: true          # 字面 true 才开启；与 presenceBus 无关
    injectMaxChars: 300    # 每轮注入总字符上限（含固定头尾，60–2000）
    maxItems: 5            # 每轮最多注入条数（1–10）
```

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `enabled` | boolean | `false` | `true` / `false` | 是 | 开启后：按事件写活动行（同 key ≤1 条/10s 节流）到 `<memoryRoot>/.longlive/board/activity.jsonl`；`agent/pre-step` 只注入 `seq > lastSeenSeq` 的其他会话活动。失败静默，不影响 turn |
| `injectMaxChars` | number | `300` | 60–2000 | 是 | 渲染后的整条提示（含 `【共享大脑活动】` 头与 `【活动结束】` 尾）不超过此值；预算不够时先裁条目标题、再少注入几条 |
| `maxItems` | number | `5` | 1–10 | 是 | 最多条数；blocked 优先 |

- 判重：同会话最近 10 条内 `key` 相同或文本相似度 ≥0.8 → 合并，`count+1`、`last_at` 更新、正文保留首条。
- 蒸馏：同 key 连续 3 次（`count`）或累计 10 次 → 旧行 `archived:true`，新增一条
  `阶段：<key>（N 次，最近 …）`。500 条窗口外的最旧行归档到 `activity-YYYYMM.jsonl`。
- 每会话游标：`<memoryRoot>/.longlive/bridge/<sessionId>.activity.json`（`lastSeenSeq`）。
  与 A1 结论桥的 `<sessionId>.json` 分开，互不覆盖；删掉该文件只会让该会话下次重新看到最近 5 条。
- 隐私门：写盘前与注入前都调 `src/recall/privacy.mjs`；`local_only` 的活动不写、不注入。
- 回退：`enabled: false` 并重启；已写文件保留，可手动删除。
- 面板：活动流的「谁在干什么」页**不在 1.6.8 配套的面板 0.2.6 内**（面板侧后续版本 0.2.7 提供）；
  longlive 包只负责写盘与增量注入。

### 1.6 Router 1.1.0（默认关闭，50 键）

全部键都在插件 `config` 里，`routerEnabled` 只认字面 `true`；改完重启宿主才生效。
`false` 时 22 个工具不变、不建 `.longlive/router/`；打开后先多 4 个 `router_*`
（22→26），再开 `routerProposalEnabled` 多 3 个（26→29）。

```yaml
routerEnabled: false                    # 总开关；字面 true 才生效
routerProvider: deepseek-official
routerModel: auto                       # 显式 id / 宿主 currentSelection / listModels 首个非 preview
routerTickMs: 60000
routerReflectOnTurn: true
routerReflectCoalesceMs: 300000         # turn/end 后 2s 防抖、5min 合并
routerAutonomy: report                  # report | ...
routerAllowAgent: false                 # 允许 agent 模式（本轮未实现真实 provider 调用）
routerMaxTokensPerRun: 80000
routerMaxTokensPerDay: 1000000
routerCallMaxTokens: 2048
routerMaxAttempts: 2                    # 1–3
routerMaxConsecutiveErrors: 3           # 连续 3 次进 blocked(E_ERROR_STREAK)
routerAnchorPath: ''                    # 空 = memoryRoot/STATE.md
routerStopFile: ''                      # 存在即停止服务
routerAllowMissingAnchor: false
routerVaultDir: ''                      # 空 = <memoryRoot>/.longlive/router；两者都无则 E_NO_VAULT
routerAgentTimeoutMs: 15000
routerDisposeTimeoutMs: 2000
routerFlowSlice: 1200
routerSharedBoard: false
routerHintScope: root                   # root | all
routerHintTokens: 700                   # clamp 到 200–700
routerReflectHintTokens: 150            # clamp 到 50–150
routerInjectEveryTurns: 10
routerInjectStateMaxSessions: 512
routerInjectMaxPerSessionPerDay: 24
routerInjectMaxTotalTokens: 12000
routerLiveRowsMax: 128
routerBoardMaxSessions: 5
routerProposalEnabled: false            # 第二档：提案三工具
routerApplyEnabled: false               # 第三道闸：真正写盘
routerL4MergeEnabled: false             # 相邻小写合并
routerProposalMaxChars: 4000
routerProposalsPerSessionHour: 6        # 子代理固定 3/h，不读此键
routerMaxProposals: 200
routerAgingSeconds: 120
routerLeaseRenewMax: 2                  # maxHold = ttl + renewals × ttl/2 = 240s
routerLeaseWaitTimeoutMs: 300000
routerBlockedOnUserTtlMs: 86400000
routerProposalTtlH: 72
routerWakeEnabled: false
routerWakeCooldownMs: 600000
routerWakeDailyQuota: 20
routerWakeLogMaxBytes: 33554432
routerStarvationAlertMs: 600000
routerQueueMaxBytes: 65536
routerWalMaxBytes: 2097152
routerWriterLeaseMs: 120000             # clamp 到 60000–120000
routerSnapshotKeepDays: 30
```

要点：

- **双闸**：`routerProposalEnabled` 只让模型写提案（不碰工作区）；`routerApplyEnabled`
  才允许批准后的九步写入。两个都默认 `false`。
- **vault**：默认落在 `<memoryRoot>/.longlive/router/`（board/live/proposals/queue/WAL/
  snapshots/runs/outbox）。`routerVaultDir` 显式指定时不再要求 `memoryRoot`；两者都没有
  时服务 `blocked(E_NO_VAULT)`，不写盘。
- **共享板动作**：`routerSharedBoard: true` 时，`board.json` 的 `focus[]` 每行附带
  `lastAction: {kind, detail, at}`（只取本插件写入 live 行的 `last_action`，`detail`
  截到 60 字）和 `queuedCount`；这两个字段参与板子哈希，动作变化会在下一轮触发一次
  hint。**不需要新配置键**——升级后自动生效，旧配置照常工作。
- **范围钳制**：`routerHintTokens`、`routerReflectHintTokens`、`routerWriterLeaseMs`
  超出范围会被夹回（`CLAMP_SPECS`，`src/router/service/config.mjs:132-135`），不是报错；
  其余数值键超范围回默认并给 warning。旧键 `routerMergeEnabled` /
  `routerProposalsEnabled` / `routerLeaseTtlMs` 仍被读取并迁移，`routerMaxQueue` 已删除。
- **默认关的副作用**：Router 的定时器、`router_*` 工具、审计/预算/快照写盘全部不启动；
  详见 [FEATURES.md](FEATURES.md) 的 routerEnabled 一节与
  `test/router-1100/apply-off.test.mjs`。

### 1.7 工作集度量 `metrics`（D1/D4，默认开启）

只度量、不裁剪：每轮 `turn/end` 往 `<memoryRoot>/.longlive/metrics/turns.jsonl` 追加一行
四层账，超预算只记录不报错。完整口径见 [METRICS.md](METRICS.md)。

| 键 | 类型 | 默认值 | 合法值 / 范围 | 改了要重启？ | 风险与说明 |
|---|---|---|---|---|---|
| `metrics.enabled` | boolean | `true` | `true` / `false` | 是 | `false`（或顶层 `metrics: false`）时不注册监听、不写盘；度量失败也永远静默，不影响对话 |
| `metrics.targetTokens` | integer | `40000` | ≥ 1 | 是 | 每轮输入预算；只改它时四层目标按 0.625/0.30/0.05/0.025 等比缩放 |
| `metrics.keepTurns` | integer | `12` | ≥ 1 | 是 | `recent` 层的窗口；早于窗口的对话记入 `carried`，仍留在请求里（D2/D3 未实现） |
| `metrics.layerTargets` | object | `{fixed:25000,recent:12000,recall:2000,conclusion:1000}` | 四个非负整数 | 是 | 显式给出则不再按 `targetTokens` 等比缩放 |

账本写入是 best-effort：目录不可写、行解析失败、没有 `usage` 都只影响账本，不抛到宿主。
只读读取用 `node scripts/metrics-read.mjs --memory-root <root>`，或直接读文件；
`router_status` 的 `ledger` 字段是同一份汇总。

### 1.8 语义召回 `embedding`（默认关闭）

`autoRecall` 的顶层开关之外，另有一个 `embedding` 对象；它不属于三块 feature flag，
只在 `autoRecall.enabled: true` 且 `config.embedding` 是对象时透传给 auto-recall。

| 键 | 默认 | 说明 |
|---|---|---|
| `embedding.enabled` | `false` | 打开后尝试加载本地 ONNX 模型；失败静默退回关键词 |
| `embedding.modelPath` | `''` | 模型目录（含 `config.json`、`tokenizer.json`、`onnx/model.onnx`）或直接指向 onnx 文件 |
| `embedding.maxSeqLen` | `256` | 查询/卡片切块编码上限；模型指纹变化会触发向量缓存全量重建 |
| `embedding.keywordWeight` / `vectorWeight` | `0.6` / `0.4` | 融合权重 |
| `embedding.semanticAdmit` | `0.55` | 零关键词命中卡的余弦准入线 |
| `embedding.minFusedScore` | `0.2` | 零关键词命中卡的融合分下限 |
| `embedding.cacheDir` | `<memoryRoot>/.longlive/embeddings` | 向量缓存目录（`index.json`） |

`autoRecall.budgetTokens` 的硬上限是 2000（超出会被夹回），保证单轮注入不超过 2K token。
完整行为与 recall-log 行格式见 [AUTO-RECALL.md](AUTO-RECALL.md)。

### 1.9 routerFace（v1 后台面，默认关闭，8 键）

嵌套对象。`enabled` 只认字面 `true`；关闭时零定时器、零目录、零 IO。

```yaml
routerFace:
  enabled: false                # 总开关；还需 routerEnabled + routerSharedBoard 才能把留话递到前台
  tickMs: 60000                 # 30000–900000
  dryRun: true                  # true = 只写 journal，不调 LLM、不写 outbox
  dailyTokenBudget: 50000       # input+output；超了自动停（state=stopped, reason=daily-budget）
  maxContextTokens: 30000       # 2000–300000；身份/状态/心流/板/journal/待办都在里面
  provider: ""                  # 空 = 沿用宿主当前 provider
  model: auto                   # 显式 id / 宿主选择 / provider 首个非 preview
  maxSuggestions: 3             # 0–10，每条 ≤200 字；只进 outbox，不执行
```

| 键 | 类型 | 默认值 | 合法值 / 范围 | 风险与说明 |
|---|---|---|---|---|
| `enabled` | boolean | `false` | `true` / `false` | false 时 `createRouterFace` 都不调用；改完重启宿主才生效 |
| `tickMs` | integer | `60000` | 30000–900000 | 同一窗口内 journal 按 `tickKey` 幂等；窗口过短会提高调用频率 |
| `dryRun` | boolean | `true` | `true` / `false` | 首次上真机建议先跑 dry-run 看上下文和 journal，再关掉 |
| `dailyTokenBudget` | integer | `50000` | 1000–5000000 | 只记 LLM usage，不估算上下文；超预算停到当天结束 |
| `maxContextTokens` | integer | `30000` | 2000–300000 | 低于 2000 按 2000；各分区按比例裁剪，不保证每段完整 |
| `provider` | string | `""` | 已注册 provider id | 空=宿主 `currentSelection()`；填错会连续失败 3 次后停 |
| `model` | string | `auto` | `auto` 或显式 model id | `auto` 解析不到 provider 时进 `waiting_provider` 并计数失败 |
| `maxSuggestions` | integer | `3` | 0–10 | 只影响进 outbox 的条数；0 = 只写 journal |

失败与停止：连续 3 次失败 → `status.json` 的 `state:"stopped"`、`reason:"consecutive-failures"`
（需重启插件才恢复）；预算耗尽 → `reason:"daily-budget"`（当天不再跑，次日首个 tick 自动恢复）。
`<memoryRoot>/IDENTITY.md` 是前后台共用身份文件（只读，缺省用内置默认），
不要在 hint 里改它；bridge 文件是 `.longlive/bridge/router-outbox.jsonl`。

### 1.10 子会话扇出 `workers`（默认关闭）

`worker_spawn` / `worker_status` / `worker_kill` 仍在 22 个默认工具里，但 1.6.0 起每次调用
先看 `workers.enabled`：缺省或 `false` 时直接返回
`{ ok:false, status:"unavailable", available:false, message:"unavailable: worker_* 默认关闭…" }`，
不会派发任何子会话。只有显式打开才走宿主 `subagents` 服务。

```yaml
config:
  workers:
    enabled: true     # 默认 false；打开后才能派子会话
```

| 键 | 类型 | 默认值 | 合法值 | 说明 |
|---|---|---|---|---|
| `workers.enabled` | boolean | `false` | `true` / `false` | 关闭时三个 worker 工具都返回 unavailable；打开后仍受宿主 `subagents` 服务是否存在约束 |

整块不在 `src/config.js` 的 90 节点 Config schema 里（1.6.0 为 80；1.6.4 的 `hotTruncate`
块 +5，本次活动流 `sharedBrain.activity` 再 +5；透传键保持 schema 面稳定），属于透传配置；Cordis
的 schema 校验保留未知键，运行时由 `src/tools.js` 的注册包装读取。

---

## 2. 环境变量

| 变量 | 作用 | 优先级 / 备注 |
|---|---|---|
| `DSH_HOME` | 覆盖 DSH home（会话目录、默认记忆根、live 注册表都在其下） | 最高；不设则 `~/.dsh`（`src/home.js`） |
| `DSH_LONGLIVE_MEMORY_ROOT` | 指定记忆根 | 低于 `memoryRoot`/`memRoot` 配置，高于 `DSH_MEM` |
| `DSH_MEM` | 老版本记忆根变量 | 最低的显式来源；仍被接受 |
| `DSH_LONGLIVE_STRICT_MEMORY_ROOT` | 真值 = 等价 `strictMemoryRoot:true` | 与配置取或（`src/memory/paths.js:69`） |
| `DSH_SESSION_ID` | 当前会话 id 的最后兜底 | 只影响"current"解析和 live 目标判定；不要手改 |
| `DSH_NODE` | runner 找 node 的第一优先 | `<root>/scripts/auto-truncate-run.ps1` |
| `DSH_BIN` | doctor 找 `dsh` 可执行文件 | `scripts/longlive-doctor.mjs` |
| `DSH_LONGLIVE_APP_EXE` | 测试 S4–S6 需要 | 跑测试套件时用，不是运行时配置 |
| `DSH_T7_API_KEY` | 测试 T7 需要 | 同上 |
| `DSH_HOST_VERSION` / `DSH_PROBE_FREE` | 版本探测/免探测开关 | 排障用；具体语义只在 ERRORS.md 的环境变量清单里出现，**待核实**（不要写进生产配置） |

---

## 3. `memoryRoot` 到底取哪个

严格按下面顺序，先命中先赢（`src/memory/paths.js`）：

1. 配置 `memoryRoot`
2. 配置 `memRoot`（别名）
3. 环境变量 `DSH_LONGLIVE_MEMORY_ROOT`
4. 环境变量 `DSH_MEM`（老版本）
5. `<DSH home>/longlive-memory`（推导默认，唯一会**自动创建**的一档）

两条硬规则：

- 第 1–4 档给的是"显式根"：**必须已经存在**，插件不会替你建。不存在 → `E_MEMORY_ROOT_MISSING`。
- `strictMemoryRoot` / `DSH_LONGLIVE_STRICT_MEMORY_ROOT` 打开后，第 5 档被取消，没配就报错。

所有卡片/报告的写入都经过 `resolveInside()` 的越界检查（拒绝 `..`、其他盘符、逃出根的绝对路径），
所以把根配到你的记忆根（如 `<memory-root>`）之后，工具不会写到别的盘去。

---

## 4. 三份示例配置（从保守到激进）

以下路径均为占位符，替换成你的 `<memory-root>` / `<app-dir>`。
三份都放在同一位置：profile 的 `cordis.patch.yml`，只替换 `- id: session-longlive` 条目。

### 4.1 保守：只看不切（推荐第一天）

```yaml
- id: session-longlive
  config:
    memoryRoot: "<memory-root>"   # 显式根，必须已存在；不要指向空目录
    strictMemoryRoot: true        # 没配根就报错，避免悄悄用默认目录
    routerRuntime: off            # 不判定、不落盘，行为与旧版一致
    autoTruncate:
      enabled: true
      mode: log                   # 只规划 + 写一行日志，绝不写会话
      tokensThreshold: 300000     # 默认值；先观察真实日志估算离阈值多远
      minTurns: 12
      cooldownMinutes: 60
      keepTurns: 12
      keepTokens: 80000
      profile: desktop
```

看什么：`<memoryRoot>/.longlive/logs/auto-truncate.log` 里是否出现 `action:"planned"`，
以及 `estimate.tokens` 与本机实际上下文压力的关系。

### 4.2 平衡：只生成请求，宿主外执行（推荐起步）

```yaml
- id: session-longlive
  config:
    memoryRoot: "<memory-root>"
    strictMemoryRoot: true
    routerRuntime: shadow        # 只判定 + 记录，不拒绝任何调用
    routerPolicyProfile: generic
    autoTruncate:
      enabled: true
      mode: request             # 只写 request.json；真正切由 runner 做
      tokensThreshold: 200000   # 生产起点；先 5000 跑三次验收再加到 200000
      minTurns: 12
      cooldownMinutes: 60
      keepTurns: 12             # 与 keepTokens 双边界，取更晚者
      keepTokens: 80000
      appExe: "<app-dir>/DeepSeek Harness.exe"   # 必须与实际安装路径一致
      profile: desktop
```

门禁：先按 `OPERATIONS.md` 的 `dryrun → request` 验收；连续三次真实 runner 执行都通过
`verify-truncation.mjs` 的 `VIOLATIONS=0` 后，才谈下一步。

### 4.3 激进：自动切 + 路由拒绝（只在有验收证据后用）

```yaml
- id: session-longlive
  config:
    memoryRoot: "<memory-root>"
    strictMemoryRoot: true
    routerRuntime: on            # 高风险写会被拒；只读永不拒
    routerPolicyProfile: generic # 不要为了"更严"随便换成未审的 overlay
    heartbeatMs: 15000
    autoTruncate:
      enabled: true
      mode: request
      tokensThreshold: 100000   # 更早触发 = 更频繁重启应用
      minTurns: 12
      cooldownMinutes: 30       # 冷却减半，失败重试窗口也减半
      keepTurns: 8              # 保留更少 = 更狠
      keepTokens: 50000
      appExe: "<app-dir>/DeepSeek Harness.exe"
      profile: desktop
```

代价：每次触发都要**关闭并重启应用**（runner 的 hard-kill 策略，`auto-truncate-run.ps1:344-570`）。
`keepTurns` 压到 8、阈值压到 100000，意味着活跃工作日可能一天触发多次；没有连续三次 V13
通过之前不要上这一档。`routerRuntime: on` 另有一道门：VM 里 D9/D10（拒绝路径与 0 误拒）**未验**，
见 `INSTALL-RUNBOOK.md` §7。

---

## 5. 改完怎么确认生效

```powershell
# 0) `dsh` 不在 PATH 时，换成 runbook 里的 $DSH 绝对路径（如 <app-dir>\resources\runtime\cli\bin\dsh.cmd）

# 1) 条目真的挂上了（只证明挂载，不证明激活）
dsh --profile desktop --dump-config | Select-String -Context 0,12 'session-longlive'

# 2) 宿主启动两次，stderr 都不许出现 "did not activate"
#    出现即整条 entry 没激活，先回滚配置，不要继续调参

# 3) 看运行期证据（把 <memory-root> 换成你的 memoryRoot；
#    默认是 $env:USERPROFILE\.dsh\longlive-memory）
Get-Content "<memory-root>\.longlive\logs\auto-truncate.log" -Tail 5
Get-Content "<memory-root>\.longlive\auto-truncate-state.json" -Raw

# 4) router 模式下确认记录文件在长
Get-Item "<memory-root>\.longlive\router-runtime.jsonl" | Select-Object Length,LastWriteTime
```

判断标准：

- `mode: log` → 日志行 `action:"planned"`，且 `wroteSessionFile:false`。
- `mode: dryrun` → `action:"dryrun-planned"`，`wroteSessionFile:false`，会话文件字节数不变。
- `mode: request` → `action:"request-written"`，`request.json` 出现；**会话文件此时仍不变**。
- 会话真的变小，只可能发生在 runner 成功执行之后（`auto-truncate-run.log` 里有 `RESULT`，
  `truncate-visible.json` 账本多一条）。

---

## 6. 已知的"配置无效"陷阱

| 写法 | 结果 | 正确做法 |
|---|---|---|
| `autoTruncate.mode: on` | `AUTO_BAD_MODE`，整条 entry 不激活 | 自动截断只有 `log/dryrun/request`；`on` 是 `routerRuntime` 的值 |
| `autoTruncate.mode: apply` | 被静默改写成 `request`，日志带 `modeAlias` | 新配置直接写 `request` |
| `cooldownMinutes: 0` | 每 turn 都可能写 request，runner 会反复关应用 | 生产 ≥ 30；演练完改回来 |
| `memoryRoot` 指向不存在的目录 | 启动告警，memory 工具全部 `E_MEMORY_ROOT_MISSING` | 先建目录；或让它走默认根 |
| 面板 `memoryRoot` 没配 | 面板读 `~/.dsh/longlive-memory`，显示 0 卡 | 面板配置里写同一个根，或用 `DSH_LONGLIVE_MEMORY_ROOT` |
| `tokensThreshold: 5000` 直接上生产 | 一天触发多次重启 | 5000 只用于前三次验收，之后回到 200000 量级 |

规划中、**当前没有对应配置键**的东西：scope 打分、过滤器（panel 的"过滤器决策"页返回
`implemented:false`）、常驻看门进程/计划任务。不要为它们编配置项。
