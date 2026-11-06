# 从零到第一次截断（QUICKSTART）

**读完你会得到什么**：从一台已经装好 DSH 的 Windows 机器出发，装好 longlive，用 `dryrun` 看它「打算怎么剪」，再切到 `request`，最后安全地完成第一次真截断，并且知道怎么退回去。

> 适合谁：第一次拿到 `dsh-longlive-1.6.4.tgz` 的人。全程约 20 分钟，其中真截断那一步应用会自己关闭再打开（VM 实测约 31.5 秒），请挑你不用电脑的时候做。
>
> 本文默认 DSH home 是 `%USERPROFILE%\.dsh`；如果你设过 `DSH_HOME`，把命令里的这段整体换掉。

## 0. 准备：两个路径先对上

```powershell
$DSH  = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
$NODE = '<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $NODE --version
& $DSH plugin --help
```

**你应该看到**：Node 版本 ≥ `v20`（DSH 自带，不用另装）；`dsh plugin` 能正常打印用法（不同版本措辞可能不同）。

**报错了怎么办**：
- 路径不存在 → 去 DSH 安装目录下找 `resources\runtime\cli\bin\dsh.cmd` 和 `resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。
- Node 低于 20 → DSH 版本太旧，先升级 DSH，不要单独换 Node。
- 不知道有哪些 profile → 先确认你要装的是哪一个（本文以 `desktop` 为例）。

## 1. 装插件：三条命令

```powershell
$TGZ = 'C:/path/dsh-longlive-1.6.4.tgz'   # 换成真实绝对路径

& $DSH plugin --profile desktop add "file:$TGZ"
& $DSH plugin --profile desktop list --depth 0
& $NODE "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-longlive\scripts\longlive-doctor.mjs" --profile desktop
```

**你应该看到**：`list` 里出现 `dsh-longlive@1.6.4`；doctor 打印一张表，最后是「全部可选依赖已启用。」或只有 engram 缺失的提示。

**报错了怎么办**：
- `ENOENT` → `file:` 后面必须是**真实存在的绝对路径**，用正斜杠；不要把 `~` 写进去。
- 提示版本冲突或 `1 entry did not activate` → 先确认装的是 1.5.0；仍报错就把完整 stderr 发出来，别反复重装。
- 装完没变化 → CLI 安装**不会**影响正在运行的进程，必须完全退出宿主再启动；新 profile 第一次可能只是准备性加载，要再启动一次。
- 缺 `@kenz1117/dsh-engram` → 只是少 `engram_*` / `memory_save`，22 个工具和截断照常，可以先不装。

## 2. 跑一次 doctor（只读）

上面第 3 条已经跑过。想看得更细：

```powershell
& $NODE "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-longlive\scripts\longlive-doctor.mjs" --profile desktop --json
```

**你应该看到**：JSON 里每个依赖有 `status`；退出码 `0`（全齐）或 `1`（只缺可选项，或没检测到 profile）都算正常。

**报错了怎么办**：退出码 `1` 先看缺的是不是 `@kenz1117/dsh-engram`——只缺它不影响 22 个工具和截断；`2` = 参数写错。doctor **不会**自动安装，想让它给安装计划就加 `--setup`，它会要求你输入大写 `YES`。

## 3. 先「只看不动」：切到 dryrun

编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，找到（或新增）这一段。**必须是 `- id:`，不能抄成 `- insert:`**，否则会出现两条同 id：

```yaml
- id: session-longlive
  name: dsh-longlive
  config:
    autoTruncate:
      enabled: true
      mode: dryrun        # log | dryrun | request
      tokensThreshold: 5000   # 演练值；默认 300000，本手册建议的生产值是 200000
      minTurns: 2             # 演练值，生产用 12
      cooldownMinutes: 5
      keepTurns: 12
      keepTokens: 80000
      profile: desktop
```

保存，完全退出宿主，再启动 `desktop` profile。

**你应该看到**：没有任何界面变化——这是正常的，它是后台维护插件。

**报错了怎么办**：启动直接报 `invalid ... mode` → 拼写必须是 `log` / `dryrun` / `request`，写错**不会降级**，整条配置不激活；`--dump-config` 里出现两条 `session-longlive` → 你把 `- insert:` 抄进 profile 了，改回 `- id:`。

## 4. 观察一次 dryrun 评估

在 `desktop` profile 里正常聊，直到估算 token 超过 5000（不够就继续聊；日志里的 `estimate.tokens` 会告诉你到哪了）。然后看最后一行：

```powershell
Get-Content "$env:USERPROFILE\.dsh\longlive-memory\.longlive\logs\auto-truncate.log" -Tail 1
```

**你应该看到**：一行 JSON，关键字段是 `"mode":"dryrun"`、`"action":"dryrun-planned"`、`"wroteSessionFile":false`，以及 `plan.cut.turn` / `plan.droppedTurns` / `plan.keptTurnsDetail`。

**报错了怎么办**：
- 文件不存在 → 宿主没重启、或 memoryRoot 不在默认位置（看 `session_health` 的返回）。
- 日志没有新行 → 多半是还没到阈值，或这个 session 还在 `cooldownMinutes` 冷却里；到阈值但计划为空时，才会写 `"action":"none"`。
- 到了阈值也没写 → 看 `estimate.tokens` 是否 ≥ `tokensThreshold`、`estimate.turns` 是否**严格大于** `minTurns`，只等于不算。

## 5. 确认没问题，再切 request

把 `mode` 改成 `request`，重启宿主，再聊到超过阈值。

**你应该看到**：日志出现 `"action":"request-written"`，并生成 `%USERPROFILE%\.dsh\longlive-memory\.longlive\logs\auto-truncate.request.json`——但它**只是请求文件，还没有剪**。

**报错了怎么办**：`request` 模式下日志写 `request-failed` → 先别跑 runner，把那一行的错误字段发出来；不要手改 request 文件。

## 6. runner 演练：只校验，不关应用

```powershell
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-longlive\scripts\auto-truncate-run.ps1" `
  -MemoryRoot "$env:USERPROFILE\.dsh\longlive-memory" -DryRun
```

**你应该看到**：一段 JSON（`ok:true`、`dryRun:true`、`close.policy:"hard-kill"`）和 `dry-run: validation passed, nothing closed or cut`，退出码 `0`。应用**不会**被关闭。

**报错了怎么办**：退出码 `2` + `request file does not exist` → 还没到阈值，或 request 没写出来；这是「没到时候」，不是坏了。

## 7. 第一次真截断

先**保存手头工作**。runner 会在剪切前自动做 `.bak`；想额外多留一份，等完全退出宿主后手动复制会话文件。然后挑你不用电脑的时候，去掉 `-DryRun` 再跑一次上面的命令。

**你应该看到**：应用被关闭 → 约 30 秒后重新打开 → `auto-truncate.log` 追加一条 `"status":"done"`，成功后 request 文件会被删掉；会话目录里有新的 `session.v4.jsonl.zstd.bak-YYYYMMDD`（同一天剪多次会带 `-2` 后缀）；用 `session_health` 看，`visibleMessages` 变小，但 `backups` 非空。

**报错了怎么办**（看 runner 退出码）：

| 退出码 | 含义 | 你该做什么 |
| --- | --- | --- |
| `0` | 成功，或只是 dryrun | 正常 |
| `2` | 请求文件有问题，**没关应用、没改文件** | 按提示修 request，不要手改会话 |
| `3` | 关不掉应用 | 手动退出后重跑；没剪，安全 |
| `4` | 剪切失败，已尝试还原备份 | 用 `session_health` 确认，必要时按第 8 步还原 |
| `5` | 剪完校验失败，已还原 | 同上，并把日志发出来 |
| `6` | 应用没重新打开，但剪切保留 | 手动打开应用，确认会话能读 |

## 8. 回滚

**回滚数据**：完全退出宿主，找到会话目录（`session_health` 的 `sessionPath` 的父目录），把备份盖回去：

```powershell
$dir = '<会话目录>'   # 例如 ...\.dsh\sessions\...\<sessionId>
$bak = Get-ChildItem "$dir\session.v4.jsonl.zstd.bak-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item $bak.FullName "$dir\session.v4.jsonl.zstd" -Force
```

**回滚插件**：`& $DSH plugin --profile desktop remove dsh-longlive`，重启。卸载**不会**删 `longlive-memory`、`.bak-YYYYMMDD` 和 `session.v4.jsonl.zstd.archive/`。

**你应该看到**：会话恢复到截断前的消息数；插件从 `list` 里消失。
**报错了怎么办**：提示会话仍被占用 → 还有 DSH 进程没退干净；**不要**在宿主运行时覆盖文件。

## 收尾：把演练值换回生产值

确认连续三次截断都 `status:"done"` 后，再把 `tokensThreshold` 改回 `200000`、`minTurns` 改回 `12`、`cooldownMinutes` 改回 `60`，`keepTurns: 12` / `keepTokens: 80000` 不动。`200000` 下 request 文件出现得少是正常的，判断是否生效看日志里的评估记录，不要为了「看到它动」把阈值调到 0。
