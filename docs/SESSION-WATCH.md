# 会话看门（session watchdog）

这是一个**独立的、脱离 DSH 宿主进程树**的常驻看门：由 Windows 计划任务在用户
登录时拉起一个 `node.exe` 进程，按固定间隔扫描会话日志，超过阈值时调用现有的
`scripts/truncate-cli.mjs` 做截断。它不装 profile、不改插件配置、不重启 GUI。

它和 `docs/RESIDENT-WATCHER.md` 里的 resident watcher 是两件事：

| | resident watcher (0.9.0-rc.1) | session watchdog (本页) |
| --- | --- | --- |
| 输入 | 插件在回合末写的 `.longlive/logs/auto-truncate.request.json` | 自己扫描 `sessions/**/session.v4.jsonl.zstd` |
| 触发 | 请求文件出现 | 文件大小 / 事件数 / token 估算超过阈值 |
| 动作 | 关 GUI → 截断 → 校验 → 重启 GUI | 直接跑 `truncate-cli.mjs`，不碰 GUI |
| 适合 | 无人值守的插件请求消费 | 定时、低耦合的阈值看门 |

看门只负责“发现该截断的会话并调用既有 CLI”。真正的计划、备份、归档、验证
全部在 `truncate-cli.mjs` / `src/truncate-visible.js` 里，避免两套截断逻辑。

## 安全边界（默认就是安全的）

- `mode` 默认 `dryrun`：只调用 CLI 的 `--dry-run`，不写会话、不建备份/归档。
- 只有显式把 `mode` 改成 `request`，且配置/profiles 的 `enabled` 为 true 时，才会
  做一次真实截断；真实截断必须由 CLI 自己再通过一遍 live 检查。
- **kill-switch** 有三层，任意一层生效都会在下一轮停止动作：
  1. `session-watch.config.json` 里 `"enabled": false`；
  2. `profileConfig` 指向的 `cordis.patch.yml` 里
     `plugins.session-longlive.autoTruncate.enabled: false`（profile 覆盖 mode 与阈值，
     但 `enabled` 是**与**关系：任意一层为 false 都会停）；
  3. `<memoryRoot>\.longlive\session-watch\stop.flag` 出现（`uninstall` 会写）。
- 触发前健康检查：
  - live 注册表里该会话是 `running` / `waiting` / `blocked` / `idle`，或
    `stale/dead` 但本机 pid 还活着 → 跳过；
  - live 行损坏、live 目录读不了 → 整轮 fail-closed，不截断；
  - 会话目录里有 `.truncate-visible-inflight.json` → 跳过；
  - 文件 mtime 还在 `settleSeconds` 内 → 等下一轮；
  - `truncate-cli` 自己还会查 Windows 独占句柄和 `DSH_SESSION_ID`。
- 单个会话解析失败、CLI 超时、回执写失败都只记日志，不抛出到宿主，不影响 DSH。
- 看门进程被杀/崩溃，不会破坏会话；计划任务下一次登录会重新拉起。

## 文件与路径

安装目录（默认）`%LOCALAPPDATA%\dsh-session-watch`：

```text
session-watch.config.json      # 看门自己的配置（安装时生成）
scripts\session-watch.mjs      # 循环/单次入口
scripts\truncate-cli.mjs       # 既有截断 CLI（--dry-run 由本功能补上）
scripts\session-watch-status.ps1   # 只读状态
scripts\uninstall-session-watch.ps1 # 卸载入口
scripts\lib\*.mjs              # 演练 fixture 等
src\...                        # CLI 依赖的全部源码
docs\SESSION-WATCH.md
```

运行期证据都放在 memoryRoot 下，安装目录可以随时删除：

```text
<memoryRoot>\.longlive\logs\session-watch.log
<memoryRoot>\.longlive\session-watch\state.json
<memoryRoot>\.longlive\session-watch\last-tick.json
<memoryRoot>\.longlive\session-watch\watch.pid
<memoryRoot>\.longlive\session-watch\stop.flag
<memoryRoot>\.longlive\session-watch\receipts\<stamp>-<sessionId>-<mode>.json
```

## 安装

前置条件：Windows PowerShell 5.1、已知的 node.exe、一个固定的本地
memoryRoot 和 sessions 根目录。任务命令里出现的路径必须是**纯 ASCII**；
`InstallDir`、`NodeExe`、`TaskName`、`ProfileConfig` 含非 ASCII 字符会被拒绝。
中文 memoryRoot 可以（它只进配置文件，不进任务命令行），但最稳妥仍是 ASCII。

在包的 `scripts\` 目录里执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-session-watch.ps1 `
  -InstallDir "C:\Tools\dsh-session-watch" `
  -SessionsRoot "$env:USERPROFILE\.dsh\sessions" `
  -MemoryRoot "$env:USERPROFILE\.dsh\longlive-memory" `
  -ProfileConfig "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" `
  -Mode dryrun
```

先只演练、不写文件、不注册任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-session-watch.ps1 `
  -InstallDir "C:\Tools\dsh-session-watch" `
  -SessionsRoot "<existing sessions dir>" -MemoryRoot "<existing memoryRoot>" `
  -DryRun
```

常用参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `-InstallDir` | `%LOCALAPPDATA%\dsh-session-watch` | 运行时文件目录，必须 ASCII |
| `-Mode` | `dryrun` | 安装参数只接受 `dryrun` / `request`；配置文件里可手写 `log` |
| `-Enabled` | `true` | 初始 kill-switch；`-Enabled:$false` 只装不跑 |
| `-IntervalSeconds` | `300` | 扫描间隔 |
| `-DshHome` | `%DSH_HOME%` 或 `%USERPROFILE%\.dsh` | sessions 根的上层 |
| `-SessionsRoot` | `<DshHome>\sessions` | 要扫描的会话根 |
| `-MemoryRoot` | `%DSH_MEM%` 或 `<DshHome>\longlive-memory` | live 行与证据根 |
| `-ProfileConfig` | 空 | 可选；只有文件里存在 `autoTruncate:` 块时才覆盖 mode/enabled/阈值，没有块则忽略 |
| `-NodeExe` | DSH 运行时 node，找不到再查 PATH | 任务里执行的 node |
| `-TaskName` | `DshSessionWatch` | 计划任务名 |
| `-DryRun` | — | 只打印计划，不写文件、不注册 |
| `-NoRegister` | — | 复制文件、写配置，但不注册任务（适合演练） |
| `-NoStart` | — | 注册后不立即启动 |
| `-Force` | — | 覆盖已有安装目录 |

安装会用 `Register-ScheduledTask` 注册一个 AtLogOn 任务（当前用户，
MultipleInstances=IgnoreNew，无执行时限）；如果该 cmdlet 不可用，退回
`schtasks /Create /SC ONLOGON`。注册失败只报错，不会留下半装任务。

## 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\session-watch-status.ps1
```

输出包含任务状态、解析后的配置、`last-tick.json`、state 摘要、最近 5 张回执和
日志尾部。看门本身也可以单独跑一次（不经过计划任务）：

```powershell
& "C:\...\node.exe" .\session-watch.mjs --config .\session-watch.config.json --once
```

`--once` 输出整轮 JSON 到 stdout（同时写日志）；`--check` 只打印配置摘要；
`--dry-run` 把本轮强制降级为 dryrun，但绝不会把 dryrun 升级成 request。

## 配置键

`session-watch.config.json`：

```json
{
  "enabled": true,
  "mode": "dryrun",
  "intervalSeconds": 300,
  "settleSeconds": 10,
  "tokensThreshold": 300000,
  "minTurns": 12,
  "bytesThreshold": 0,
  "eventsThreshold": 0,
  "keepTurns": 12,
  "keepTokens": 80000,
  "firstUserCapChars": 4000,
  "boundaryRetries": 3,
  "cooldownMinutes": 60,
  "scanMaxFiles": 500,
  "cliTimeoutSeconds": 600,
  "profileConfig": "",
  "memoryRoot": "...",
  "sessionsRoot": "...",
  "dshHome": "...",
  "nodeExe": "...",
  "cliPath": "..."
}
```

- 三条阈值任一命中即候选；`bytesThreshold` / `eventsThreshold` 为 0 表示不启用。
  token 阈值还要求 `turns > minTurns`（与插件默认一致）。
- 同一会话在 `cooldownMinutes` 内不重复触发；CLI 失败会按 5/10/20…分钟退避，
  上限 60 分钟。
- `mode: "log"` 只记录 `would-truncate`；`dryrun` 调 CLI 干跑并写回执；
  `request` 真截断并校验备份、归档和 sha。
- `profileConfig` 只解析 `autoTruncate:` 的直接子级标量（简单 YAML 子集）；
  没有 `autoTruncate:` 块时整段忽略，继续用 config.json，不套用插件默认值；
  有块但解析错误时按配置错误退出，不猜。

## 演练（不碰真会话）

`session-watch-drill.mjs` 在临时目录造一个假 DSH home、假会话和假 memoryRoot，
依次验证：dryrun 不写、request 真截断并留备份/归档/回执、kill-switch、live
健康门、损坏会话 fail-soft、循环模式。

```powershell
& "C:\...\node.exe" .\session-watch-drill.mjs --clean
```

成功时输出 `"ok": true`、60 条检查；证据留在 `drill-result.json` 指向的临时
workdir，或加 `--workdir` 指定目录。它使用假 `DSH_HOME` / `DSH_MEM`，不会读写
`C:\Users\<user>\.dsh\sessions`。**不要**在演练里传入真实 SessionsRoot。

## 卸载

先 dry-run：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-session-watch.ps1 `
  -InstallDir "C:\Tools\dsh-session-watch" -DryRun
```

确认后去掉 `-DryRun`。它会写 stop.flag、停止/删除计划任务、最多等 15 秒让循环
退出，再删除安装目录；`memoryRoot` 里的日志、状态和回执**故意保留**。只有循环
未退出且带 `-ForceStop` 时，才会在命令行确认包含 `session-watch.mjs` 后杀进程。

## 已知限制

- 只支持 Windows；计划任务只在用户登录时运行（关机即停，符合“人不在就不看门”）。
- 不重启 GUI，也不解决 GUI 正持有的会话；那种会话应交给 resident watcher 或
  手动处理。
- 扫描是轮询全量文件，`scanMaxFiles` 默认 500；会话很多时按需调大间隔。
- `request` 模式是真截断。第一次在真机启用前，必须先跑 `session-watch-drill.mjs`
  和一次真实 `--once --dry-run`，并确认备份可读。
- `profileConfig` 的 YAML 解析是刻意做小的；复杂锚点/多文档不在支持范围。

## 安装包变更

`package.json` 的 `files[]` 已包含本页、`scripts/session-watch.mjs`、
`scripts/session-watch-drill.mjs`、三个 PowerShell 入口和
`scripts/lib/session-watch-fixture.mjs`。npm 安装/升级不会自动注册计划任务；
必须由操作者显式运行安装脚本。
