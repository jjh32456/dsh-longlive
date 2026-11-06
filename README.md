# @jjh32456/dsh-longlive（久视）

> 1.6.0 起包名由 `dsh-session-longlive` 改为 `dsh-longlive`；1.6.4 起发布名改为 scoped 包
> `@jjh32456/dsh-longlive`（npm 包名），显示名仍是「久视」（英文 Longlive）；
> 1.6.3 在 1.6.0 基线上新增**热截断**（cut-only 压缩引擎，见下文「版本与边界」），这一项是 1.5.0
> 没有的能力；1.6.4 把热截断默认值收到 **300k 触发 / 保留 4 轮**，并修复 D6 重启后首轮冻结
> （G3）与可移植性收口。升级步骤见 [docs/MIGRATION-1.6.0.md](docs/MIGRATION-1.6.0.md)。

**一句话**：一个大脑，多双手脚——把「我」从会话里搬出来，让人格与记忆长久化。

我们过去把「我」塞在一个会话里。会话一长就慢、就挤，断了就失忆；多开几个，就成了几个互不相识的自己。

longlive 的做法，是把「我」从会话里搬出来，做成一个**共享大脑**：

- **一份记忆**：卡、流水、程序、状态落在磁盘上，不在某段上下文里；
- **一个身份**：我是谁、在做什么、在等什么，由常驻 Router 和开机卡持有，新会话先接上它再开口；
- **一套通道**：收件箱让会话之间递话，共享板让 Router 看见谁在跑、卡在哪、队列里有什么；子脑、手机端连的是同一个我。

这样会话就可以短、可以断、可以并排开，人格和记忆不跟着断；上下文只装那三句话，不随工作量膨胀。**换会话不再等于换人，多开不再等于分裂**——这就是「长久化」的实际含义：不是永生，是不再因为一次断线就丢掉之前那个人。

自动截断是给单个会话做的卫生工作（见下文「自动截断：会话长了怎么办」），不是身份来源。


> 术语先说明白：**插件**是装进 DSH 的功能包；**会话**是你和 AI 的一次完整对话；**上下文**是这次对话里 AI 此刻还记得的内容；**token** 是模型计量文字的单位，可以粗略理解成「字数」。

## 读完你会得到什么

- 知道它到底解决哪三个麻烦，以及它**明确不做什么**。
- 能用三条命令装好，并确认 22 个工具真的出现。
- 知道下一步该读哪篇：第一次截断、原理，还是排错。

## 它解决什么

### 1. 聊久了变卡

一场对话越长，每次请求要重发的上下文越大。到了模型窗口上限，请求会失败（常见 413），或者慢得让人不想等。它不是「电脑卡」，是「桌子摆不下了」。

### 2. 聊久了忘事

为了腾地方，宿主会把旧消息压成摘要（compaction）。摘要之外的原话，模型就看不见了。这不是插件造成的，是长对话的必然代价；插件能做的是**把还能救的字节收干净，并让记忆有地方落盘**。

### 3. 会话文件越来越大

每个会话是一个 `session.v4.jsonl.zstd` 日志，平时只追加、不会自己缩小。压缩过的旧事件仍占着磁盘。插件负责体检、备份、按规则回收，而不是让你手动删文件。

## 自动截断：会话长了怎么办

一个会话聊久了，上下文会越来越长：模型变慢、成本上升，最早说过的话被挤出可见窗口。自动截断就是给单个会话减负的部件——**默认关闭**；开启后它盯着会话大小，超过你设的阈值（默认 30 万 token）就动手：

- 先体检，再把整份会话文件备份一份；
- 然后收缩：要么只删不可见的历史事件（可见对话尽量一字不变），要么按轮次和预算只保留最近几轮，把更早的部分折叠压缩；
- 剪掉的东西不会凭空消失：备份文件、截断账本（每次前后大小、校验值、保留了什么）都留着，随时能回滚；
- 默认还能「只观察不真剪」（dry-run）：开启后默认 `mode: dryrun`，先看它会怎么剪、阈值合不合适，确认了再切 `log` / `request`。

它保证的是一双手脚别肿起来；共享大脑在磁盘上，不随某个会话被剪而消失——这正是它和「把整段对话硬塞进上下文」最大的区别。

## 它不做什么

- **不改写记忆正文**。`memory_reinforce` 只改卡片头部的计数、日期，并追加一行使用记录，正文逐字节校验不变；`memory_forget` 只归档，不删文件。
- **默认配置不联网、不上传**。源码里没有网络请求，没有遥测；截断、备份、检索都在本机完成。但打开 `routerEnabled` / `routerFace.enabled` / 语义召回（embedding）后，插件会通过宿主调用你配置的模型 API——这是你显式开启后的行为。
- **不替你做决定**。备份、两个截断、遗忘默认 `dryRun: true`，真要写必须给对应的 `confirm` 词；`session_compact` 只受 `dryRun` 控制（没有 confirm 词）。自动截断默认关闭；路由判定默认关闭；`worker_*` 扇出默认关闭（需 `workers.enabled: true`）。
- **默认不自动杀进程**。插件本体不关应用；只有你手动运行 `auto-truncate-run.ps1`，或装了看门并切到 request 模式时，它才会关宿主、剪完再打开。
- **不修已经损坏的会话**，也不恢复你手动删掉的消息。

## 装之前

- **不用另装 Node**：DSH 自带运行时，`package.json` 要求 Node **>= 20.0.0**；下面用 `$NODE` 指向它。
- DSH **>= 0.2.0 < 1.0.0**；装在哪个 profile 就装到哪个 profile。
- 想用「自动截断」的 `request` 模式：目前只有 **Windows** 有完整实现；Linux/macOS 用 `log` / `dryrun`。

## 三条安装命令

先在 PowerShell 里设好两个路径（按你的实际安装目录改）：

```powershell
$DSH  = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
$NODE = '<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
```

然后依次执行：

```powershell
# 1. 安装本地 tgz（用 plugin add，不要用 npm install）
& $DSH plugin --profile desktop add "file:C:/path/jjh32456-dsh-longlive-1.6.4.tgz"

# 2. 确认版本
& $DSH plugin --profile desktop list --depth 0

# 3. 自检（只读，不改任何东西；设过 DSH_HOME 就把前半段换成 $env:DSH_HOME）
& $NODE "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@jjh32456\dsh-longlive\scripts\longlive-doctor.mjs" --profile desktop
```

上面的命令统一用 `& $DSH` 调用（`$DSH` 就是上面设的 `dsh.cmd` 路径）；若 `dsh` 已在 PATH，也可以直接写 `dsh`。

装完必须**完全退出并重启**这个 profile 的宿主；新 profile 第一次可能只是准备性加载，需要再启动一次。详细走法见 [QUICKSTART.md](docs/QUICKSTART.md)。

## 装完你会看到什么

- 新会话里多出 **22 个工具**，分四组：
  - 会话：`session_health`、`session_original`、`session_backup`、`session_compact`、`session_truncate`、`session_truncate_visible`
  - 记忆：`session_wake`、`memory_index`、`memory_consolidate`、`memory_reinforce`、`memory_forget`、`memory_procedure`、`memory_recall`
  - 协作：`worker_spawn`、`worker_status`、`worker_kill`、`lease_acquire`、`lease_release`
  - 活体巡检：`session_live_update`、`session_live_list`、`session_live_get`、`session_live_prune`
- **Router 1.1.0 默认关闭**：`routerEnabled` 不写或写 `false` 时，上面仍是 22 个工具、不建
  `.longlive/router/`、不起定时器。显式打开后先多 4 个 `router_*`（22→26）；再开
  `routerProposalEnabled` 多 3 个（26→29）。开关与默认值见 [docs/FEATURES.md](docs/FEATURES.md)
  和 [docs/CONFIG.md](docs/CONFIG.md)，建议先只开 `routerEnabled` 观察。
- **D2/D6 默认关闭**：`d2.enabled` 打开工具输出裁剪（超长结果落盘、正文只留头尾），
  `d6.enabled` 打开工具面裁剪（默认仍是 22 个工具，打开后多一个 `tool_search` 用来找回
  被裁掉的工具）。打开方式、预算与回退见 [docs/FEATURES.md](docs/FEATURES.md) 和
  [docs/CONFIG.md](docs/CONFIG.md)。
- 默认记忆目录：`%USERPROFILE%\.dsh\longlive-memory`（首次启动自动创建）。
- **没有自带界面**。另装可选的只读面板 `@jjh32456/dsh-longlive-panel@0.2.5` 后，侧栏才会出现「潜望镜」，里面有七个页签：六层视图、截断记录、过滤器决策、影子记录、常驻 Router、本轮想起（另有「使用说明」）。面板是独立可选包，不装就没有这个侧栏。

## 第一次使用

不要一上来就真剪。先读 [QUICKSTART.md](docs/QUICKSTART.md)，按「装好 → doctor → dryrun 观察一次 → request → runner 演练 → 真截断」的顺序走；每一步都写了「你应该看到」和「报错了怎么办」。

## 文档地图

| 文档 | 什么时候读 |
| --- | --- |
| [QUICKSTART.md](docs/QUICKSTART.md) | 第一次装、第一次截断、回滚 |
| [CONCEPTS.md](docs/CONCEPTS.md) | 不懂 token、截断、六层记忆、`on` 模式 |
| [FAQ.md](docs/FAQ.md) | 装完没反应、401/404、断电、卸载、换电脑 |
| [README.en.md](README.en.md) | 给英文读者的一页版 |

开发、打包与回滚细节见 [docs/DEV.md](docs/DEV.md)。

## 版本与边界

- 本套文档对应 **1.6.4** 的本地 tgz（1.6.0 起包名由 `dsh-session-longlive` 改为 `dsh-longlive`；
  1.6.4 起发布名改为 scoped 包 `@jjh32456/dsh-longlive`）。
  **1.6.3 起新增热截断**：一个不调 LLM 的 cut-only 压缩引擎，通过 bundle patch 关掉宿主 stock
  `compaction-basic` 行并插入 `compaction-hot-truncate`；只切「已完成、且早于保留窗口（默认 4 轮 /
  8000 token）」的整轮，切前先把原文归档到 `<memoryRoot>/.longlive/hot-truncate/`，再用一条覆盖率指针
  替换 surface，system 提示永远不被切；引擎加载失败时 `entry.js` 自动回退 stock，`/compact` 仍可用。
  自动切（`cut` 的每步检查与 `auto` 的空闲切）要在估算上下文达到 **300k token** 才动手：每切一刀都会改写上下文前缀，让模型的
  前缀缓存失效、下一轮剩余上下文全价重算，所以默认把阈值拉高、只保留最近 4 轮，切刀频率从「每轮一刀」
  降到「十几轮一刀」。**阈值与保留轮数都可调**：在 profile 的 `cordis.patch.yml` 里按
  `- id: compaction-hot-truncate` 覆盖 `hotTruncate.autoMinTokens` / `hotTruncate.retainTurns`，
  改完重启宿主生效（示例见 [docs/CONFIG.md](docs/CONFIG.md) §1.4a）。
- 包声明 `node >=20.0.0`、`dsh >=0.2.0 <1.0.0`；`@kenz1117/dsh-engram` 是可选增强，缺了只少 `engram_*` / `memory_save`，不影响 22 个工具和截断。
- **记忆准入过滤器（MAF）已并入，但从 1.2.0 起只是只读观测**：`filterEnabled` 默认开，启动后异步读
  `journal/*.md` 给每条段落打分，把 remember / human / local_only 决策写进
  `<memoryRoot>/.longlive/filter/decisions-*.jsonl`；它不调模型、不改卡片、**不拦截 `memory_*` 写入**。
- **`scope` 已并入**：卡片 frontmatter 的已知字段，参与 `memory_recall` 的 IDF 覆盖率打分（权重
  title×2 + scope×3，卡无 scope 回退正文）；`DSH_LONGLIVE_SCOPE=0` 可回到纯 title+body 做 A/B。
- 「按重要度**决定记什么**」（过滤器执行准入、在写入前拦截）仍是**未并入**能力；不要把只读的
  `decisions-*.jsonl` 当成已经存在的准入门槛。
