# @jjh32456/dsh-longlive 操作手册（runbook）

> 目标：把一个**正在变胖但已经停下来**的会话日志安全变短，并且让「任何一步失败都退回原样」可验证、可操作。
> 插件只在文件层工作；**不会**修改对话内容，**不会**自动触发，**不会**删除任何备份。
>
> **平台**：本手册里的独占句柄探测（PowerShell/`FileShare.None`）与 `autoTruncate.mode="request"`
> 编排器只在 Windows 上成立；Linux/macOS 上探测会标记为 `unverified`，`request` 模式不可用，
> 其余步骤跨平台。路径示例里的 `%DSH_HOME%` / `%USERPROFILE%` 在 POSIX 上是 `$DSH_HOME` / `$HOME`。

## 0. 前置条件（缺一条就别动）

1. **该会话已经停写**：桌面端 / headless / sdk 里都没有正在跑的 turn。判断方法：`session_health` 的 `ageSeconds` 大于 60 s，并且你自己确认没有别的窗口在用这个会话。
2. **磁盘有空间**：至少留出「当前文件大小 × 2」。备份和 `.tmp` 都要落盘。
3. **知道自己要放弃什么**：截断只保留尾部 `keepEvents` 条事件（默认 20000）。被切掉的旧事件**不会**进上下文；但要保证**可见对话**（surface 上的 user/assistant/tool-result 消息）一字不差——这一条由插件强制校验，不通过就中止。
4. **已经 compact 过**：`session_health.compaction.shadowedEvents > 0`。没有 compaction 就没有可回收的前缀，`session_truncate` 会返回 `cutIndex: 0 / dropped: 0`——那不是 bug，是它算得对。先走 §1.5。

## 1. 看一眼现状（只读，零写盘）

```
session_health { sessionPath: "<SESSION_PATH>\\<scope>\\<session-id>\\session.v4.jsonl.zstd" }
```

看四个数：
- `bytes` / `events`：现在多大、多少事件；
- `visibleMessages` + `deriveSha256`：可见对话的条数与指纹（截断前后必须相同的就是这个 sha）；
- `ageSeconds`：小于 60 s 就别动，等它停；
- `backups` / `lastTruncation`：以前备份过没有、上次截断记录；
- `compactionMessage`：一句话判词——「模型还看得见多少」和「磁盘能回收多少」是两件事，别混。

**校验点 A**：`deriveSha256` 抄下来，记成 `BEFORE_SHA`。

## 1.5 先 compact（唯一能让 payload 真正变小的步骤）

```
session_compact { sessionPath: "...", dryRun: true }   // 只报可用性，零写盘
session_compact { sessionPath: "...", dryRun: false }  // 真压
```

- 它调用宿主自己的 `ctx.compaction.compactNow(agent, signal)`。摘要是宿主生成并**写进日志**的
  （`compaction/summary` + 一条 `source.kind="compact-checkpoint"` 的 user 消息，带
  `surfaceOp.replace`），不依赖进程内存——这就是 2026-10-30 那次事故缺的那个东西。
- agent 正在跑时调用会返回 `scheduled`：本轮结束后才真正开始。不要因为没立刻看到变化就连点。
- 压完再 `session_health`：`compaction.shadowedEvents` 变大，`shadowedEventsStillStored` 也变大
  ——后者才是 `session_truncate` 能回收的量。
- profile 里没有 compaction 服务时返回 `unavailable`：在输入框手动跑一次 `/compact`，效果相同。

**为什么不能跳过这步**：截断只删事件。没有 compaction 时，第一条可见消息就在文件开头，
`planTruncation` 必须把切点退到它前面（`firstVisibleSeq` 保护），于是 `cutIndex: 0`、一个字节
都删不掉；硬砍前面的事件又会把 checkpoint 一起砍掉 → 遮蔽失效 → 上下文瞬间涨回原始大小
（这正是 2026-10-30 13:48 的事故链）。先 compact，再 truncate，顺序不能反。

## 1.6 重启后自检（四步，缺一步不算过）

插件改动要重启客户端才加载。重启后不必猜，按顺序跑四条：

1. **插件加载了没有** —— `session_health {}` 的返回里必须有 `compaction` 与
   `compactionMessage` 两个字段。没有：插件没启用（查 profile 的 `cordis.patch.yml`），
   后面的步骤没有意义。
2. **宿主服务够不够得着** —— `session_compact { dryRun: true }` 必须返回 `status: "planned"`。
   返回 `unavailable`：这个 profile 没有 compaction 服务，只能在输入框手动 `/compact`。
3. **摘要真落盘了没有** —— `session_compact { dryRun: false }` 之后重读 `session_health`：
   `compactionFiles` 至少 +1，并且那条记录的 `summaryChars > 0`。只 +1 而 `summaryChars`
   是 0，说明摘要没写进日志，等于没压——这正是 2026-10-30 事故里丢掉的那一半。
4. **真的能删了没有** —— `session_truncate { dryRun: true }` 的 `dropped` 必须 > 0。
   还是 0：遮蔽没覆盖到前缀，回第 3 步，别硬来。

四步全过才允许真写（`confirm: "TRUNCATE"`）。真写之后**还要重启一次**，确认会话能打开、
而且我能回出一句话——那是第五步，也是唯一能证明「记忆没丢」的一步。

## 1.7 装/升级后：先证明 21 个工具真的注册（发布闸门）

`dsh plugin ... add` 成功、`--dump-config` 里有 entry，都**不等于**插件激活。0.7.3 就是这样：
`list` 显示 `@0.7.3`、dump 里一条 entry，起 web 宿主却只打
`dsh: warning: 1 entry did not activate`，19 个工具一个都没注册。根因是版本探测直接读了
未在 `inject` 声明的 `ctx.version`；0.7.4 给所有宿主面读取加了守卫，并新增 T27 回归用例。

装完/升级后，按这个顺序验：

1. **entry 挂上了**：`dsh --profile <p> --dump-config` 里只有一条 `session-longlive`。
2. **真的激活了**：用该 profile 起宿主，stderr 里不能有 `did not activate` / `cannot get property`。
   新 profile 的第一次启动可能是准备性加载，**启动两次**再下结论。
3. **21 个工具在**：有模型凭据时，会话里调 `session_health` / `memory_index` / `session_live_list` /
   `session_wake` 各一次；没有凭据时，第 2 条就是无凭据的替代验证。

发布闸门（缺一条不许出包）：

```powershell
# 1) 单元/契约套件；T27 会在「会抛 inject 错」的代理 ctx 上调用版本探测
& $NODE test\run.mjs

# 2) 发布模式：--release 下 T7（真 SDK resume）缺 key 直接 FAIL，不再算 SKIP
$env:DSH_T7_API_KEY = '<你的 key>'
& $NODE test\run.mjs --release
```

`--release` 只改变 T7 的判定：本地/离线跑仍可 skip，但**发布候选不许把 skip 当 pass**。
T7 需要 `DSH_EXE` 与 `DSH_CLI_JS` 指向真实宿主（见 `test/t7_drive.mjs`），且只从环境变量读
`DSH_T7_API_KEY`，不会去翻凭据文件。

## 2. 先备份（可单独执行）

```
session_backup { sessionPath: "...", dryRun: true }          // 只报告目标文件名与 sha256，零写盘
session_backup { sessionPath: "...", dryRun: false, confirm: "BACKUP" }
```

备份落在同目录，命名 `session.v4.jsonl.zstd.bak-YYYYMMDD`（同一天同字节会复用；不同字节自动加 `-1`、`-2`，**绝不覆盖**）。备份写完立刻回读校验 sha256，不符就报 `BACKUP_SHA256_MISMATCH`。

备份台账：同目录 `backups.json`（只追加，不删）。

**校验点 B**：`listBackups` 或台账里出现该备份，`sha256` 等于源文件当前 sha256。

## 3. 先 dry-run 一次（零写盘）

```
session_truncate { sessionPath: "...", keepEvents: 20000, dryRun: true }
```

输出会告诉你：
- `cutIndex` / `cutTurn`：从第几条事件、哪个 turn 起保留；
- `dropped`：要丢多少事件；
- `keptVisibleMessages` / `visibleSha256`：截断后的可见对话指纹；
- `blockers`（若有）：为什么不能截（例如 `NO_TURN_BOUNDARY`、`VISIBLE_CONVERSATION_CHANGED` 预检）。

**校验点 C**：`visibleSha256` 必须等于第 1 步的 `BEFORE_SHA`。不等就**停**，不要强行截。

## 4. 真写（唯一会改文件的命令）

```
session_truncate { sessionPath: "...", keepEvents: 20000, dryRun: false, confirm: "TRUNCATE" }
```

内部顺序（每一步失败都会中止，并且原文件不动）：

1. 检查会话是否还活着（`SESSION_RECENT_WRITE` / `SESSION_LOCKED`）；
2. 备份 + 校验 sha256（失败 → `BACKUP_MISSING` / `BACKUP_SHA256_MISMATCH`）；
3. 在内存里算出新事件表，跑 deriveMessages 指纹闸门（不等 → `VISIBLE_CONVERSATION_CHANGED`）；
4. 写 `session.v4.jsonl.zstd.tmp-<pid>-<ts>`，再**解回来**校验事件数 / 首条 `seq=0` / 末条类型 / 指纹（失败 → `TMP_VERIFY_FAILED`，删 tmp）；
5. 原子 rename 覆盖正式文件；
6. **再解一次**正式文件复核（失败 → `POST_WRITE_VERIFY_FAILED`，自动用备份盖回并写 `rollback.json`）；
7. 写 `truncate.json` 台账（保留最近 20 条）。

**校验点 D**：命令返回 `ok: true`，并且返回体里 `bytesBefore > bytesAfter`、`visibleSha256` 仍等于 `BEFORE_SHA`。

## 5. 事后复核（建议每次都做）

```
session_health { sessionPath: "..." }
```
- `visibleMessages` / `deriveSha256` 必须与第 1 步完全一致；
- `lastTruncation` 有本次记录（时间、前后字节数、事件数）；
- 目录里有 `session.v4.jsonl.zstd.bak-YYYYMMDD`、`backups.json`、`truncate.json`。

真机检查（可选，最稳）：在隔离的 `DSH_HOME` 里用副本跑一次 resume，确认会话能被宿主正常读出来。插件自带的 T7 用例就是这么测的：命令在 `test/run.mjs` 的 `t7RealResume()`（需要 `DSH_T7_API_KEY`，没有则自动 skip；报告写到系统临时目录，不写进包内）。

## 6. 回滚（三种情况）

**情况 1：截断命令失败，原文件没动。**
什么都不用做；删掉可能残留的 `*.tmp-*` 即可（插件一般已自删）。

**情况 2：截断成功但你想退回。**
用备份覆盖回去，并核对 sha256：

```powershell
$dir = "<SESSION_PATH>\<scope>\<session-id>"
$bak = Join-Path $dir "session.v4.jsonl.zstd.bak-YYYYMMDD"
Copy-Item -LiteralPath $bak -Destination (Join-Path $dir "session.v4.jsonl.zstd") -Force
(Get-FileHash $bak -Algorithm SHA256).Hash
(Get-FileHash (Join-Path $dir "session.v4.jsonl.zstd") -Algorithm SHA256).Hash
```

两个哈希必须一致。注：`*.bak-*` 不匹配宿主的 `session.v<N>.jsonl.zstd` 命名规则，**留在目录里不会被当成会话加载**，可以放心留着。

**情况 3：宿主起不来，怀疑文件坏了。**
先看同目录 `rollback.json`（如果存在）——里面记了「什么时候、因为什么、从哪个备份恢复、恢复后的 sha256」。没有就用情况 2 手动覆盖。

## 7. 常见错误码对照

完整码表（80+ 个码，每码一句「你该怎么做」）见 [docs/ERRORS.md](docs/ERRORS.md)。下表只是截断链路上最常撞到的 8 个。

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `SESSION_RECENT_WRITE` | 文件 60 s 内被写过，可能还有 turn 在跑 | 等会话彻底停下再试 |
| `SESSION_LOCKED` | 文件被独占打开 | 关掉占用它的进程，不要杀宿主的其他会话 |
| `NO_TURN_BOUNDARY` | `keepEvents` 太大，找不到可用的 turn 边界 | 调大 `keepEvents`，或换更短的切点 |
| `VISIBLE_CONVERSATION_CHANGED` | 截断会改变可见对话 | **停下**，这是设计上的硬闸门，别绕过 |
| `INBOX_PROJECTION_INVALID` | 切片开头会让 `agent/inbox/*` 投影非法 | 同样停下，换切点（插件会尝试丢弃边界 inbox 事件） |
| `TMP_VERIFY_FAILED` | 写出的 tmp 解不回预期内容 | 原文件未动；删 tmp 重试 |
| `POST_WRITE_VERIFY_FAILED` | rename 后复核失败 | 已自动回滚；查 `rollback.json` |
| `BACKUP_MISSING` / `BACKUP_SHA256_MISMATCH` | 备份没写成或字节不符 | 检查磁盘空间/权限后重试 |

## 8. 不要做的事

- 不要在会话还在跑的时候截断（插件会拒，但别故意去试）；
- 不要手动删备份后继续用这个会话——出问题就退不回去了；
- 不要把 `keepEvents` 设得大到「等于没截」，也别小到把当前任务需要的上下文切掉；
- 不要改 `session.v4.jsonl.zstd` 里的 `id` / `cwd`——目录名、header.id、cwd 三者必须自洽，否则宿主列表都会失败。

---

## 9. 每日巩固（memory_index + memory_consolidate）

**前置**：`memoryRoot` 可选。不配就用默认根 `<DSH home>/longlive-memory`（首次使用自动创建）。显式配置的目录必须已存在，否则报 `E_MEMORY_ROOT_MISSING`（插件不会替你创建显式路径）。想恢复旧行为（未配置即报 `E_MEMORY_ROOT_UNSET`），设 `strictMemoryRoot: true`。

**第 1 步 · 先看索引会怎么变（dry-run，零写入）**

```
memory_index {}
```

看返回里的 `cards` / `legacy` / `changed`，以及 `generated` 段。确认没有少卡（`cards` 应等于 `topics/` + `journal/` 下的 `.md` 数，legacy 也算）。

**第 2 步 · 落盘**

```
memory_index { apply: true }
```

**校验点 A**：返回 `applied: true`，`INDEX.md` 里标记行 `<!-- cards: N ... -->` 的 N 与第 1 步一致；标记外你手写的内容一个字没变；两次 apply 的生成段除 `<!-- generated: ... -->` 时间戳外逐字节相同。

**第 3 步 · 出巩固提案（只读）**

```
memory_consolidate {}
```

报告写到 `<memoryRoot>/.longlive/reports/consolidate-YYYY-MM-DD.md`。逐条看「目标卡 / 理由 / 前 120 字摘录 / 建议 salience」。

**校验点 B**：调用前后 `topics/`、`journal/`、`.longlive/memory-state.json` 全都没变，只有 `reports/` 下多一份文件。`memory_consolidate` 没有 `apply`，传了会报 `E_READ_ONLY`——它只提议，不改卡。

**第 4 步 · 人工采纳**

按报告把段落写进目标卡（这是唯一改正文的步骤，必须由人/agent 明确执行）。采纳后如果这张卡确实被用到了，再记一次使用：

```
memory_reinforce { path: "topics/记忆解剖.md", reason: "2026-11-02 巩固时采用" }
```

**第 5 步 · 推进增量起点**

`memory_consolidate` 不会自己改 `lastConsolidated`（只读承诺）。人工确认报告已处理完后，复制一份 state 再改：

```powershell
$root = "<MEMORY_ROOT>"
$state = Join-Path $root ".longlive\memory-state.json"
Copy-Item -LiteralPath $state -Destination "$state.bak"
# 把 lastConsolidated 改成本次报告日期 YYYY-MM-DD，保存
```

下次 `memory_consolidate` 就只读这个日期之后的 journal。

## 10. 遗忘演练（memory_forget）

**永远先在临时夹具上演练，不要拿真库试手。**

**第 1 步 · 造夹具**

复制几张卡（至少一张 `salience: 5` 的核心卡、一张 `last_used` 超过一年且 `strength <= 2` 的旧卡）到临时目录，把 `memoryRoot` 指过去。

**第 2 步 · dry-run**

```
memory_forget {}
```

**校验点 A**：返回 `dryRun: true`、`applied: false`；`proposals` 里只应有旧卡，核心卡出现在 `immune`；临时目录里没有 `tombstones.md`、没有 `archive/`、没有 `.longlive/audit.log`。dry-run 是**零写入**。

**第 3 步 · 确认门**

```
memory_forget { confirm: "yes" }
```

必须报 `E_CONFIRM_REQUIRED`，且目录仍然零变化。再跑：

```
memory_forget { confirm: "FORGET" }
```

**校验点 B**：
- `moved` 等于 `proposals.length`；
- `tombstones.md` 里以 `- ` 开头的行数等于 `moved`；
- 原文仍在 `archive/tombstones/<原相对路径>`（或降级的 `epochs/<原相对路径>`），**没有被删除**；
- `salience >= 5` 的卡原地不动；
- `.longlive/audit.log` 只多一行 `memory_forget`。

**第 4 步 · 演练复原**

把 `archive/`、`epochs/` 里的文件 `Move-Item` 回原路径，删掉演练用的 `tombstones.md` 和 `.longlive`（只限夹具目录）。真库执行后不要复原——记忆切片就是记录。

## 11. 越界拒绝（E_PATH_OUTSIDE_ROOT）

记忆工具的所有路径都先解析、再证明在 `memoryRoot` 里面；证明不了就拒绝，**拒绝发生在任何读写之前**。

**会触发拒绝的输入**（六条验收路径）：

```
../../../etc/passwd
..\..\..\Windows\win.ini
C:\Windows\win.ini
D:\outside\x.md
/etc/passwd
topics/../../escape.md
```

**怎么验**：

```
memory_reinforce { path: "../../../etc/passwd" }
```

**校验点**：抛错且 `error.code === "E_PATH_OUTSIDE_ROOT"`，消息里带这个码；根外文件 mtime/sha256 不变；根内不产生任何临时文件。另外，`memoryRoot` 未配置时是 `E_MEMORY_ROOT_UNSET`，不是越界——两种错误要分清。

**不要做的事**：不要为了“让它跑通”改成根外绝对路径、不要给 `memoryRoot` 配一个包含 `..` 的路径、不要在根外手工建 `.longlive/` 再指过去。工具会拒绝，这是正确的行为，不是 bug。
