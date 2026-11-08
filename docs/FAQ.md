# 常见问题（FAQ）

**读完你会得到什么**：装完没反应、侧栏不见了、401/404、剪完变少、换电脑、断电、卸载这些最常见的情况，能自己判断「是正常、是没装好，还是该回滚」。

> 约定：**宿主**＝运行 DSH 的那个应用进程；**memoryRoot**＝记忆库根目录，默认 `%USERPROFILE%\.dsh\longlive-memory`。

## 1. 装完什么都没发生，是不是没装上？

大概率是正常的。这个插件**没有自带界面**，默认 `mode: "log"` 也只会在后台写一行评估日志，不会弹窗、不会剪东西。

按顺序确认：`dsh plugin --profile desktop list --depth 0` 有 `@jjh32456/dsh-longlive@1.8.0`；doctor 没有硬错误（退出码 0，或只有 engram 缺失导致的 1）；重启后新会话里能数到 22 个工具；聊到超过阈值后，`%USERPROFILE%\.dsh\longlive-memory\.longlive\logs\auto-truncate.log` 才出现评估行（默认阈值 300000，所以短时间内没有是正常的）。

如果这四样都没有，先看宿主启动 stderr 有没有 `1 entry did not activate`。

## 2. 侧栏没有「潜望镜」？

「潜望镜」不是 longlive 本体自带的，它来自独立可选包 `@jjh32456/dsh-longlive-panel@1.8.0`。不装那个包，就永远不会有这个侧栏——这不是故障。1.8.0 面板侧 `GET /api/longlive-panel/v2/state` 返回 27 条路由 / 18 个动作；「本轮想起」审计入口读 `.longlive/recall-log.jsonl`。

装了还没有，按顺序查：

1. 装到了**同一个 profile** 吗？面板要装在你会打开的那个 profile 里。
2. 包名进了 profile 的 `dsh.profile.bundles` 列表吗？只在 `dependencies` 里不够。
3. 这个 profile 有 `webServer` 服务吗？面板只挂在 Web profile 上。
4. 宿主完全重启了吗？只刷新页面不够。

## 3. 工具列表里没有 22 个？

22 是 longlive 自己注册的数量，不是「整个会话只有 22 个工具」。先确认你看的是**新会话**，且是装插件的那个 profile。

- 一个都没有 → 插件没激活，看 stderr 的 `1 entry did not activate` 和紧随其后的错误。
- 少几个 → 可能被 profile 的工具过滤挡住，或版本不是 1.8.0。
- 只有 `engram_*` 缺失 → 那是可选依赖没装，和 22 个工具无关。

## 4. 401 和 404 到底差在哪？

面板接口挂在 DSH 宿主的 Web 服务下。面板自己的代码只定义了 `404` / `405` / `400`，**没有定义 401**，所以 401 一定来自它前面那一层。

- **401**：HTTP 认证失败——请求没被允许，在 Web 宿主上通常来自登录 / 令牌那一层（这一层的确切实现不在本插件仓库里，**待核实**）。**不是面板或 longlive 坏了**。
- **404**：宿主上根本没有这个路由（面板没装/没挂载），或者路径不在面板白名单里。面板对所有未命中路径一律 404，**故意不区分**「不存在」和「不许读」。
- 另外两种：**405** = 方法不对（面板只收 GET / HEAD）；**400 E_BAD_QUERY** = 参数越界。

判断顺序：先看侧栏有没有「潜望镜」；没有 → 查安装和重启；有但接口 401 → 查登录态，不要重装插件。

## 5. 剪完对话变少，是不是丢了？

看你被剪的是哪一种：

- **日志截断**（`session_truncate`）：可见对话**一条不少**，只是文件变小；界面不应该有变化。
- **可见截断**（`session_truncate_visible`，runner 走的就是它）：前面的整轮确实不再出现在对话里，模型也看不到；但原文在 `session.v4.jsonl.zstd.archive/<时间戳>.jsonl.zstd`，会话旁边还有 `.bak-YYYYMMDD`（同日多次会带 `-2`），开头会留一张 `[已归档 ...]` 卡。

所以「变少」是设计行为，不是删除。真要确认，跑 `session_health` 看 `backups` 和 `lastTruncation`，再去归档目录数文件。

## 6. 它会不会删掉我的记忆？

不会删文件。具体到每个工具：

- `memory_forget`：默认 dry-run；执行要 `confirm: "FORGET"`，卡片被移到 `archive/tombstones/` 或 `epochs/`，并写墓志铭，**不删**。
- `memory_consolidate`：只出报告，不改任何卡片。
- `memory_index`：只重写 `INDEX.md` 的生成段，手写部分逐字节保留。
- `memory_reinforce`：只改卡片头部的 `strength` / `last_used` / `revisions`，追加一行使用记录，正文逐字节校验不变。

它也不会碰你的会话原文，除非你显式调用截断并给 confirm 词。

## 7. 能在别的电脑用吗？路径不同怎么办？

能，但要重新装，不能直接复制 profile。

- 包是便携的，没有写死盘符；把 `.tgz` 拷过去，在新机器上重新 `plugin add`。
- profile 里的 `file:<path>` 是**那台机器**的绝对路径；换机后必须改成新路径，否则装不上。
- `memoryRoot` 默认跟着 DSH home 走（Windows 是 `%USERPROFILE%\.dsh\longlive-memory`）；如果你显式配了路径，**那个目录必须已经存在**，插件不会替你创建。
- 会话根目录默认 `%USERPROFILE%\.dsh\sessions`，设了 `DSH_HOME` 就以它为准。
- `request` 模式的 runner 目前只支持 Windows；换到 Linux/macOS 就用 `log` / `dryrun`，或完全退出宿主后手动跑 `truncate-cli.mjs`。

## 8. 剪到一半断电/强制关机怎么办？

先别慌，设计上就是按「可回滚」做的：

- 写文件走临时文件 + fsync + 原子 rename，正常不会留下半个文件。
- 可见截断会写 `.truncate-visible-inflight.json`；下次启动时 `recoverOnStart` 默认会扫它并回滚。
- runner 在剪切失败（exit 4）或校验失败（exit 5）时会尝试用备份还原。
- 如果断电发生在 runner 执行中：**完全退出宿主**，看会话目录里有没有 `.truncate-visible-inflight.json` 和最新的 `.bak-YYYYMMDD`；需要时按 QUICKSTART 第 8 步把备份盖回去。不要手改 `.zstd`。

## 9. 怎么卸载？卸载会删数据吗？

```powershell
& $DSH plugin --profile desktop remove @jjh32456/dsh-longlive
```

然后重启宿主，`list` 里不再出现即成功。卸载**不会**删 `longlive-memory`、会话的 `.bak-YYYYMMDD`、`session.v4.jsonl.zstd.archive/` 和 `.longlive/` 状态文件；要清就自己确认后手动删。面板是独立可选包 `@jjh32456/dsh-longlive-panel@1.8.0`，得单独 `remove @jjh32456/dsh-longlive-panel`。

## 10. 怎么确认它真的生效了，而不是「装了个寂寞」？

四个独立证据，至少看到两个：

1. `plugin list` 显示 `@1.8.0`；
2. doctor 没有硬错误（0，或只有 engram 缺失导致的 1）；
3. 新会话能调用 `session_health`，返回里有 `sessionPath` / `events` / `visibleMessages`；
4. 聊到超过阈值后，`auto-truncate.log` 出现评估行（`action` 是 `planned` / `dryrun-planned` / `none` 都算插件在评估）。

如果你切到了 `request`，还要看到 `request.json` 在到阈值后出现——但 `200000` 下它出现得少是正常的，不代表没生效。

## 11. 为什么默认不自动截断？

因为「自动」在这里必须是**可审计**的，不是「悄悄帮你删」。默认 `mode: "log"` 到阈值时只写一行「我打算怎么剪」，不碰会话；`request` 也只写请求文件，真正关应用、剪切、重开的是你手动运行的 runner。

另外阈值需要按机器和用法校准，默认值只是保守起点；一上来就自动真剪，风险不对称。

## 12. `log` / `dryrun` / `request` 怎么选？

| 模式 | 干什么 | 什么时候用 |
| --- | --- | --- |
| `log` | 到阈值时只估算、只写日志 | 默认；先观察，或长期只做审计 |
| `dryrun` | 走完整计划路径，但不写会话 | 第一次装、调阈值、验证配置 |
| `request` | 到阈值就写 `request.json`，等人跑 runner | 已经演练过，准备真截断 |

旧的 `apply` 会被改写成 `request`（日志里带 `modeAlias`）。三个都不是「立即剪」；写错拼写不会降级，而是整条配置不激活。

## 13. 多久触发一次？为什么我看不到 request 文件？

每个 `turn/end` 都会评估，但**同一个 session 在 `cooldownMinutes`（默认 60）内只评估一次**。触发要同时满足：估算 token `>= tokensThreshold`，且轮数**严格大于** `minTurns`。

低于阈值也会消耗冷却窗口，所以「刚聊两句没反应」是正常的。`200000` 是手册建议的生产值（默认 `300000`），request 文件稀少很正常；判断是否生效看日志里的评估记录，不要为了「看到它动」把阈值调到 0。

## 14. runner 会自己跑吗？会不会突然把我应用关了？

不会自己跑。它没有注册计划任务、没有常驻服务，只有你在 PowerShell 里手动执行 `auto-truncate-run.ps1` 才会动。

真跑时它确实会关掉宿主（`CloseMainWindow` 3 秒 → 按 PID 强制结束 → 等 2 秒确认），剪完再打开；VM 实测约 31.5 秒。所以：**不要在你正在用电脑的时候跑**。先加 `-DryRun` 只校验。

## 15. 截断要多久？期间能用电脑吗？

VM 实测约 31.5 秒，机器慢或会话大可能更久。期间应用是关闭的，不能用；如果关闭失败（exit 3），它不会剪，直接退出，会话一个字节没变。

## 16. 为什么老说「先 compact 再 truncate」？

因为 `session_truncate`（日志截断）只回收**已被 compaction 遮住**的旧字节。没有 compaction，计划切点只能是 0，一个字节都删不掉；如果绕过它硬砍，可能把已有的 checkpoint 一起砍掉，遮罩失效，原文瞬间全部重新可见——2026-10-30 13:48 那次 127 万 token 的 413 就是这么来的。

可见截断（runner 用的那条）不依赖 compaction，它直接按轮次移走可见消息。两条路别混。

## 17. 会话已经打不开/文件损坏了怎么办？

插件没有「修复损坏会话」的工具，别指望 doctor。按这个顺序：

1. 完全退出宿主；
2. 把当前坏的 `session.v4.jsonl.zstd` 改名留证，不要覆盖；
3. 找同目录最新的 `.bak-*`，复制成 `session.v4.jsonl.zstd`；
4. 再启动，用 `session_health` 看 `exists` / `visibleMessages`。

没有备份就不要硬修，更不要手改压缩文件；先保住现场。

## 18. 支持 Linux / macOS 吗？

核心工具跨平台：会话体检、备份、两个截断、记忆、worker、活体登记都能用。两个例外是 **Windows 专属**：

- 判断「宿主是否独占文件」的探测（`FileShare.None`）；
- `request` 模式的 runner。

POSIX 上探测会显示 `skipped/unverified`，也没有 `request` 的 runner，请用 `log` / `dryrun`；真要手动剪，先确保宿主**完全退出**。

## 19. 需要联网吗？会把对话上传吗？

插件本体默认不联网、无遥测：源码里没有 `fetch` / `http` / `https` / socket 调用，截断和检索都在本机。但打开 `routerEnabled` / `routerFace.enabled` / 语义召回（embedding）后，插件会通过宿主调用你配置的模型 API——这是显式开启后的行为。

唯一可能联网的是安装环节：`dsh plugin add` 装包本身走本地文件，但如果你让 doctor 的 `--setup` 去补装可选依赖 `@kenz1117/dsh-engram`，那一步会走包管理器。它不是截断所必需的。

## 20. 面板里的「过滤器决策」为什么是空的/样例？

因为过滤器还没并入本版。面板在没有真实数据时会显示样例并挂「样例」标；「影子记录」也要你先开 `routerRuntime: "shadow"` 并产生 `router-runtime.jsonl` 才有内容。

面板是**只读**的：六个只读接口，不写任何文件；会话日志本体永远不会通过 HTTP 提供。

## 21. 怎么升级/降级？

升级：拿到新 tgz，对同一个 profile 再执行一次 `plugin add`，重启；`list` 确认版本。降级同理，装回旧 tgz。

升级前先备份 `longlive-memory` 和会话 `.bak`；跨大版本时配置键可能变，升完跑一次 doctor 和 `--dump-config`。旧版的兼容性以你现场的记录为准，不要在新宿主上混用不认识的旧包。

## 22. 阈值到底用 200000 还是 300000？

`300000` 是 `autoTruncate.tokensThreshold` 的默认值；`200000` 是运行手册里的生产建议值，前提是真机先跑 `5000` 演练、连续三次都正常再改。

两个都是**估算值**（按消息 JSON 体积除以 4 近似），不是精确 token 数。`keepTurns: 12` 和 `keepTokens: 80000` 不要跟着乱动；也不建议写 `cooldownMinutes: 0`（那会每轮都评估）。

---

回到：[README](../README.md) · [QUICKSTART](QUICKSTART.md) · [CONCEPTS](CONCEPTS.md)
