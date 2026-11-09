# OPERATIONS.md — 日常运维手册（1.8.3）

对象：愿意动手、会看日志，但没参与开发的人。所有结论都能在 1.8.3 源码里指到位置；
标「待核实」的是我在本机没有证据的推断。

---

## 0. 一句话架构（细节见 ARCHITECTURE.md）

```
宿主进程内：session_* / memory_* / live_* / worker_* 工具，R1 路由，心跳，自动截断"决策"
宿主进程外：auto-truncate-run.ps1 → truncate-cli.mjs（改**当前**会话日志的唯一入口）
旁路：面板只读记忆库和截断账本；verify-truncation.mjs 只读校验日志结构
```

**关键边界**：自动截断路径在宿主内**只写 request**，不改会话。会话工具（`session_truncate*`）确实能在
宿主内改写日志，但只对**未被本宿主加载**的会话放行；目标是本宿主当前会话时一律拒绝。要切当前会话，
必须等应用退出后由外部 runner 完成。这是 0.7.0 事故换来的设计（应用内存里还握着旧 seq，
边跑边改会写出撕裂序号，实测 77 → 3532，见 `src/auto-truncate.js:24-28`）。

---

## 1. 每天看什么

### 1.1 日志/账本清单

| 路径（相对 `memoryRoot`，默认 `~/.dsh/longlive-memory`） | 谁写 | 看什么 |
|---|---|---|
| `.longlive/logs/auto-truncate.log` | 插件 | **只有超过阈值的评估**才写一行 JSON：估算、阈值、动作。低于阈值/冷却/关闭等是静默的（见 §1.3） |
| `.longlive/hot-truncate-diag.jsonl` | `session_truncate_visible` / `truncate-cli.mjs` | 1.8.3-rc.7 起每次非 dryrun 归档一行：session/turn/计划切点/retainTurns/tokens/字节/结果 `ok\|degraded\|fail`/`failReason`/耗时；按大小与日期轮转 |
| `.longlive/auto-truncate-status.json` | 插件 | 1.8.3-rc.7 起的状态快照：`mode`（dryrun 显式）、`over.count`/`over.maxTokens`、`counters.error`/`counters.infeasible`、`lastError`/`lastInfeasible`；同时镜像到 `.longlive/status.json` 的 `autoTruncate` 字段，`/api/longlive/status` 可读 |
| `.longlive/logs/auto-truncate.request.json` | 插件（request 模式） | 待执行请求。存在 = 有活没干；长期存在 = runner 没跑或失败 |
| `.longlive/logs/auto-truncate-run.log` | runner | 人读的执行流水：关闭、切、验证、重启、退出码 |
| `.longlive/logs/auto-truncate.log` 里的 `RESULT` 行 | runner | 机器读的一次执行结果（成功/失败、before/after、备份路径） |
| `router-runtime.jsonl` | R1 运行时 | shadow/on 的判定记录；off 时**不应存在** |
| `.longlive/audit.log` | 记忆工具 | 遗忘/移动等操作，TAB 分隔 `ISO / action / object / result` |
| `.longlive/reports/consolidate-YYYY-MM-DD.md` | `memory_consolidate` | 巩固提案；只提案，不改卡 |
| `<会话目录>/truncate.json` | `session_truncate` | `truncations[]`（≤20 条，核心切；字段是 `backup`/`backupSha256`，不是 `backupPath`） |
| `<会话目录>/backups.json` | `session_backup` | `{version, backups[], truncations[]}`；第 8 个备份起标 `deletable`（`src/backup.js:127-134`） |
| `<会话目录>/truncate-visible.json` | `session_truncate_visible` | 账本：切点、前后字节/消息/token、`archivePath`、`backupPath`、双 sha256 |
| `.longlive/live/<id>.json` | 心跳 / live 工具 | 谁在跑、在等什么、`blocked_on` |
| `.longlive/auto-truncate-state.json` | 插件 | 每会话的 `lastEvaluatedAt/lastTurn/tokens/turns/status`，用来判断"多久没评估了" |

### 1.2 三条最常用的命令

```powershell
$M = "<memory-root>"          # 本机示例：换成你的 memoryRoot
# 最近 5 次自动截断评估
Get-Content "$M\.longlive\logs\auto-truncate.log" -Tail 5

# 有没有待执行请求（有内容 = 有活没干）
Get-Item "$M\.longlive\logs\auto-truncate.request.json" -ErrorAction SilentlyContinue |
  Select-Object LastWriteTime, Length

# 最近一次 runner 结果
Get-Content "$M\.longlive\logs\auto-truncate-run.log" -Tail 20

# 1.8.3-rc.7：最近 5 条归档诊断 / 当前自动截断状态
Get-Content "$M\.longlive\hot-truncate-diag.jsonl" -Tail 5
Get-Content "$M\.longlive\auto-truncate-status.json" -Raw
```

### 1.3 怎么读 `auto-truncate.log` 的一行

固定字段（`src/auto-truncate.js` 的 `baseEntry`）：`time`、`sessionId`、`sessionPath`、`mode`、
`estimate{tokens,turns,events,messages,userMessages,basis}`、`threshold{tokens,minTurns,exceeded}`、
`action`、`wroteSessionFile`。

| `action` | 含义 | `wroteSessionFile` |
|---|---|---|
| `planned` | log 模式：规划完成，只写日志 | 必为 `false` |
| `dryrun-planned` | dryrun 模式：真跑了一遍 dry-run | 必为 `false` |
| `request-written` | 写出了 request.json，等 runner | 必为 `false` |
| `request-pending` | 已有待执行请求，本次不覆盖（single-flight） | 必为 `false` |
| `request-failed` | 写 request 失败（磁盘/权限），看 `message` | 必为 `false` |
| `none` | 已过阈值但规划认为不需要切；原因在 `plan.reason` | `false` |
| `exception` | 评估自身异常（不杀会话），看 `error` | `false` |

`action: "none"` 表示阈值过了但规划认为不需要切，原因在 `plan.reason` 里（例如
`already within keepTurns and keepTokens`）。

**只有"超过阈值"的评估才会写日志。** 下面这些情况是**静默**的，日志里不会出现对应行
（它们只出现在 `onTurnEnd` 的返回值里，宿主不展示）：
`disabled`（总开关关）、`no-memory-root`、`no-session-id`、`duplicate-turn`（同一 turn 重复触发）、
`cooldown`（冷却中）、`session-file-not-found`、`inflight` / `inflight-unreadable`、
`below-threshold`（没到阈值）。

所以"日志里很久没有新行"通常只说明**没到阈值**，不等于自动截断坏了。
判断"还在评估"要看 `.longlive/auto-truncate-state.json` 的 `lastEvaluatedAt` 有没有更新
（`markEvaluated` 在阈值判断之前执行，`src/auto-truncate.js:438-443`）。

**`inflight` 不是故障**：说明上一轮可能正在写，主动避让。

> 任何一行出现 `"wroteSessionFile":true`，都是事故级信号：0.8.0 没有任何模式会在宿主内写会话。
> 立刻停 runner、保留日志、按 §6 回滚。

---

## 2. 怎么判断"截断真的发生了"

不要只看"文件变小了"——文件可能被别的东西重写。按下面**五条独立证据**交叉验证，缺一条都不算。

| # | 证据 | 命令 / 字段 |
|---|---|---|
| 1 | 账本新增一条 | 会话目录的 `truncate-visible.json`，`truncations` **最后一项**（数组末尾，≤50 条），含 `at`、`beforeSha256`、`afterSha256`、`beforeBytes/afterBytes`、`cutTurn`、`archivePath`、`backupPath` |
| 2 | 归档文件存在且非空 | `session.v4.jsonl.zstd.archive/<UTC-stamp>.jsonl.zstd`；账本里的 `archivePath` 必须指向它 |
| 3 | 备份存在且哈希对得上 | `session.v4.jsonl.zstd.bak-YYYYMMDD`；与账本 `backupPath` 一致，sha256 等于 `beforeSha256` |
| 4 | 结构校验通过 | `verify-truncation.mjs` 输出 `VIOLATIONS=0`、`shape: visible`（或 `runner`）、exit 0 |
| 5 | 可见面符合预期 | `session_health` 的 `visibleMessages` 与"切后应剩的轮数"一致；不是 0，也不是原值 |

再补一条"谁干的"：`auto-truncate-run.log` 里有对应的 `RESULT`，`ok:true` 且 `status:"done"`。
没有 RESULT 却有账本 → 有人手工跑了 CLI，必须查清是谁。

**区分两种"变小"**：

- `session_truncate`（核心）：只丢不可见前缀（通常来自压缩遮蔽）。模型看到的上下文**不变**；
  磁盘/事件数变小。判断依据：`session_health.compaction.shadowedEventsStillStored` 下降、
  `visibleMessages` 不变。
- `session_truncate_visible`：丢掉最前的整轮。模型上下文**真的变少**。
  判断依据：`visibleMessages` 下降、`cutTurn` 增加、archive 目录多文件。

如果"字节变小但 `visibleMessages` 也掉到 0"——不是正常截断，按 TROUBLESHOOTING「剪完变空」处理。

---

## 3. 推进门禁：从观察到自动

任务书里常写 `dryrun → request → on`。0.8.0 里要拆成**两条独立的轴**，不要混：

| 轴 | 取值 | 说明 |
|---|---|---|
| `autoTruncate.mode` | `log` → `dryrun` → `request` → （宿主外）runner | **没有 `on`**；写 `on` 会 `AUTO_BAD_MODE`，整条 entry 不激活 |
| `routerRuntime` | `off` → `shadow` → `on` | `on` 只拒高风险写；只读永不拒 |

所谓"推进到 on"，如果指的是自动切，正确说法是"推进到 request + 启用 runner"；如果指的是路由拒绝，
那是 `routerRuntime`。两者互不代替。

### 3.1 门禁表

| 阶段 | 配置 | 进入条件 | 通过标准（证据） | 失败就退回 |
|---|---|---|---|---|
| G0 观察 | `mode: log`，`routerRuntime: off` | 安装完成、两次启动无 `did not activate` | 24 h 内日志有 `planned`/`none`（**低于阈值不写日志**，此时看 `auto-truncate-state.json` 的 `lastEvaluatedAt` 在动）；会话文件只增不减；无 `wroteSessionFile:true` | 保持 G0 |
| G1 预演 | `mode: dryrun` | G0 满 24 h | `dryrun-planned` 行出现；会话字节数与 sha256 不变；`truncate-visible.json` 不新增 | 回 G0 |
| G2 请求 | `mode: request`，runner **先只 dry-run** | G1 至少一次预演成功 | request 文件字段完整（`version:1`、`sessionPath` 绝对、`plan` 有 `cut/kept`）；`--DryRun` 输出 `ok:true` 且不关应用 | 回 G1，检查阈值/权限 |
| G3 真切 | runner 真跑，阈值 5000 起步 | G2 的 dry-run 通过；应用可被安全关闭 | 连续 **3 次**真实执行都满足 §2 五条证据 + `VIOLATIONS=0` | 停 runner，按 §6 恢复 |
| G4 生产阈值 | `tokensThreshold: 200000`（或实测值） | G3 连续 3 次通过 | 72 h 内无失败、无 `wroteSessionFile:true`、无重复 request 堆积 | 回 G3 的 5000 |
| G5 路由拒绝 | `routerRuntime: on` | shadow 48 h、≥20 次 `memory_*` 调用、零误拒 | 只读调用从未被拒；`E_ROUTE_REFUSED` 只出现在高风险写 | 回 shadow |

**硬门禁（来自 `INSTALL-RUNBOOK.md` §7）**：VM 里 `on` 的拒绝路径（D9）与"20+ 次零误拒"（D10）
**未验**，所以 `routerRuntime: on` 目前不得开启；`autoTruncate` 最多到 G2，除非你本地补齐了
G3 的三次证据。文档不能替你签字。

### 3.2 每次真跑之前的三项检查

```powershell
# 1) 应用确实退出了（runner 自己也会查，但先看更安全）
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object Id,StartTime

# 2) 请求文件不是过期快照（session 的 mtime 晚于 request.at 就要怀疑）
$req = Get-Content "$M\.longlive\logs\auto-truncate.request.json" -Raw | ConvertFrom-Json
(Get-Item $req.sessionPath).LastWriteTime ; $req.at

# 3) 上一次的备份还在
Get-ChildItem (Split-Path $req.sessionPath) -Filter '*.bak-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

runner 自己会报 drift（`planSnapshotEvents` vs `actualBeforeEvents`、`keptDelta` 等），
`drifted:true` 不一定是失败，但**必须人工看一眼**再决定是否保留结果。

---

## 4. 用 `verify-truncation.mjs` 验收

工具位置（本机示例，按你的机器替换）：`<tools-dir>\ops\tools\verify-truncation.mjs`，版本 **1.2.0**，独立脚本、只读。
它不在插件包里，别去 `node_modules` 找。

```powershell
$NODE = "<app-dir>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"  # 按本机实际
& $NODE "<tools-dir>\verify-truncation.mjs" "<home>\.dsh\sessions\desktop\<id>\session.v4.jsonl.zstd"
```

参数：`[--json] [--expect-events n] [--expect-messages n] [-h]`。
退出码：`0` 全过、`1` 有违规、`2` 用法错误。期望输出末尾有：

```
VIOLATIONS=0
shape: visible (ledger:truncate-visible.json)
```

它查七类（V1–V7）：seq 从 0 连续；首事件形状与 runner/visible 匹配；事件类型白名单 + 信封；
每个 `turn/end` 有 `reason.kind` 且截断后的第一个必须是 `truncated`；message 都在可见面上且数量对得上；
尾部完整（zstd 帧可解、末行完整 JSON、有换行）；头部身份（type/version/id/cwd/sessionId/目录名）。

**什么时候必须跑**：任何一次 `session_truncate` / `session_truncate_visible` / runner 执行之后；
任何一次从 `.bak` 恢复之后；升级/降级后第一次启动前。**N/A 不算通过。**

违规了怎么办：先停手，别重跑 runner。`1` 表示结构已经不对，按 §6 从备份恢复；
`2` 只是参数问题，改命令重跑。

---

## 5. 备份 / 回滚 / 恢复

### 5.1 会话

- 日常备份：`session_backup`（默认 dry-run），真写要 `confirm:"BACKUP"`；产物
  `session.v4.jsonl.zstd.bak-YYYYMMDD`，同目录，sha256 校验后才算成功，条目写进 `backups.json`。
- 账本：备份在 `backups.json`（`backups[]`）；核心截断在 `truncate.json`（`backup`/`backupSha256`）；
  可见截断在 `truncate-visible.json`（`backupPath`/`archivePath`）。三份都不互相替代。
- 回滚（应用必须已退出）：

```powershell
$S = "<sessions-dir>\session.v4.jsonl.zstd"
$BAK = "$S.bak-20261103"
Copy-Item -LiteralPath $S -Destination "$S.broken-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force  # 先留现场
Copy-Item -LiteralPath $BAK -Destination $S -Force
```

`truncate-visible.js` 自己给出的回滚命令就是这一条（`rollbackCommand`，win32 分支）。
恢复后再跑一次 `verify-truncation.mjs`，然后才启动应用。

- 没有备份、结构又坏了：不要手改 zstd/jsonl。把文件改名留证，找最近一次可用的
  `.bak-*` 或 `session_truncate` 的备份；都没有就接受"这段历史丢了"，不要伪造事件。

### 5.2 记忆库

- 备份：整目录复制（`robocopy /MIR` 到另一块盘），并记录 manifest 的 `sha256`。
- 恢复：**只在证明损坏时做**。先 `Move-Item` 现有根到 `<root>.broken-<stamp>`，再从备份复制回来；
  恢复后跑 `memory_index {apply:false}` 看生成区能否解析、`engram` 侧做一次 recall 冒烟。
- 反模式：升级/降级后"顺手恢复一下记忆"——会把升级后新增的卡片和状态一起抹掉。
  0.8.0 的升级不需要动记忆根。

### 5.3 插件本体

- 回滚三件套：`package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`（profile 下）。
  三个一起恢复，再 `pnpm install --prefer-offline`，然后启动两次。
- 别只改 `package.json` 不恢复 lock——版本会漂。
- 恢复后确认：`--dump-config` 只有一个 `session-longlive` 条目、22 个工具、stderr 无
  `did not activate`。

---

## 6. 升级 / 降级

### 6.1 升级

1. 校验 tgz：大小、sha256、`package.json` 里的版本号（本版 = `1.8.3`）。
2. 停应用（不是"关窗口"，确认进程没了）。
3. `dsh plugin --profile desktop add "file:<tgz 绝对路径>"`；不要同时跑第二条安装命令。
4. 启动**两次**；第二次仍无 `1 entry did not activate` 才算激活。
5. 跑 V1–V13（`CHECKLIST.md`），其中 V13 是 `verify-truncation`。
6. 记录新版本、工具数、记忆根、app exe 路径。

### 6.2 降级

1. 停应用。
2. 恢复 §5.3 三件套 → `pnpm install --prefer-offline`。
3. 会话不需要回滚（截断是单向的，但结构兼容）；**不要**为了降级去恢复旧会话。
4. 记忆库不需要回滚；若降级后 memory 工具报 `E_*`，先看是不是旧版不认新增文件，而不是急着重拷。
5. 启动两次，确认工具数降到目标版本的数字，再跑一次 `verify-truncation`。

### 6.3 失败分级（照 `INSTALL-RUNBOOK.md` §4.0）

- **A 装不上**：pnpm 非 0、版本没变、文件数不对、sha 不符 → 停手，先恢复三件套。
- **B 装上不激活**：`did not activate`、`cannot get property "version" without inject`、
  `failed to import`、`autoTruncate.mode must be one of ...`、dump 出 0 或 2 个条目 →
  先区分配置错还是代码错；配置错改 YAML，代码错恢复三件套。
- **C 激活但行为不对**：会话变小、意外归档、`wroteSessionFile:true`、off 时出现
  `router-runtime.jsonl`、只读被拒、记忆被改 → 停应用、留证据、降级；会话文件只在确认被切过时才恢复。

---

## 7. 多机器路径差异

| 东西 | 不要假设 | 正确做法 |
|---|---|---|
| 记忆根 | 不要假设记忆根在固定位置 | 用 `memoryRoot` 显式配置；每台机器先 `Test-Path` |
| DSH home | 不要假设 DSH home 固定在 `%USERPROFILE%\.dsh` | 用 `$env:DSH_HOME`，否则 `~/.dsh`（`src/home.js`） |
| 应用 exe | 不要假设应用装在固定目录 | `autoTruncate.appExe` 写本机实际路径；runner 也会用 `request.app.exe` |
| node | 本机 `node` 可能不在 PATH | runner 依次找 `DSH_NODE`、应用运行时目录、PATH；手工调 CLI 时用应用自带 node |
| sessions 根 | runner 默认 `$DSH_HOME/sessions`，否则 `%USERPROFILE%\.dsh\sessions` | 自定义过就用 `-SessionsRoot`；越界会 `SESSION_PATH_OUTSIDE_ROOT`（exit 2） |
| 面板（@jjh32456/dsh-longlive-panel@1.8.0） | 插件配了 `memoryRoot` ≠ 面板读同一个根 | 面板单独配 `memoryRoot`/`sessionsRoot`，或用 `DSH_LONGLIVE_MEMORY_ROOT` |
| 路径分隔符 | YAML 双引号里的 `\` 是转义 | 用 `/` 或单引号 |

跨机器复制记忆库时：先停两边应用，复制后跑 `memory_index`（dry-run）+ `memory_recall` 冒烟；
不要把 `router-runtime.jsonl`、`auto-truncate.request.json`、`.lease` 一起带过去（状态是本机的）。

---

## 8. 断电 / 强杀后的恢复检查单

按顺序做，**不要跳步**，尤其不要先启动 runner。

1. **确认没有第二个实例在跑**：`Get-Process 'DeepSeek Harness'`。有就说明上次没退干净。
2. **找残留记录**（都在会话目录 / 记忆根）：
   - 会话目录里的 `.truncate-visible-inflight.json`（写到一半的可见截断，**点开头**，不在日志名后面）；
   - `session.v4.jsonl.zstd.truncate-visible.tmp-<pid>-<ts>`（临时文件）；
   - `.longlive/logs/auto-truncate.request.json`（待执行请求，可能是断电前的旧快照）；
   - `<memoryRoot>/.lease`（记忆写锁，过期会被下一次 acquire 替换）。
3. **不要手工删 inflight/tmp**。宿主的 `sweepInflight(home)` 在启动时收尾或回滚
   （`recoverOnStart !== false`，`src/index.js:230-236`）；先让宿主启动一次，再看它们是否消失。
4. **启动宿主一次，立刻看三件事**：
   - 22 个工具在（工具列表）；
   - `session_health` 对目标会话返回 `status: ok`（不是 `corrupt`/`missing`）；
   - `auto-truncate.log` 没有新的 `exception`。
5. **结构校验**：对每个最近被截断过的会话跑 `verify-truncation.mjs`。`VIOLATIONS=0` 才继续；
   否则停宿主，按 §5.1 从最新 `.bak-*` 恢复（恢复前先复制坏文件留证）。
6. **处理过期 request**：如果 `request.at` 早于会话最后一次写入，或 `sessionPath` 已变，
   把 request 移到旁边（例如 `auto-truncate.request.stale-<stamp>.json`），让插件下一轮重新规划；
   **不要**直接拿旧 request 跑 runner。
7. **记忆库冒烟**：`memory_index {apply:false}`、`memory_recall {query:"..."}`、`session_wake`。
   有 `E_STATE_CORRUPT` 再考虑恢复备份，不要先动 `INDEX.md`。
8. **最后才恢复自动切**：先 `mode: dryrun` 跑一轮，确认 request 能重新生成，再按 §3 的门禁回到
   `request`。
9. **记录**：把断电时间、残留文件、校验结果、恢复来源写进运维日志。下次判断"是不是同一类故障"
   全靠这条记录。

---

## 9. 节奏建议

| 频率 | 动作 |
|---|---|
| 每天 | 看 `auto-truncate.log` 尾部、request 是否堆积、`wroteSessionFile` 是否为 false |
| 每周 | 跑一次 `verify-truncation`（最近活跃会话）；检查 `.archive` 与 `.bak-*` 占盘；跑 `memory_index` dry-run |
| 每次升级/降级 | 三件套备份 + 两次启动 + V1–V13 + V13 校验 |
| 每次真切后 | §2 五条证据 + `RESULT` 行 + 备份可用性 |

---

## 10. 无人值守手术与「中途关窗」恢复（rc.2）

### 10.1 为什么不能用可见控制台窗口跑手术

2026-11-04 14:14 的真实事故：`surgery4.ps1` 用 WMI 起在**可见**的 PowerShell 控制台里，
脚本走到 `phase restart` 时用户点了窗口右上角的 ×。Windows 的关闭顺序是
**先杀宿主进程，再杀脚本进程**——脚本来不及写结果 JSON，日志停在 `phase restart`，
插件侧也没有任何「上次手术没做完」的痕迹。

所以规则只有一条：**真正会关宿主的手术，必须由计划任务以隐藏窗口启动。**
可见窗口不是「方便看进度」，而是给用户递了一个 ×。要看进度就读
`<memoryRoot>/.longlive/logs/surgery.log`，不要开着控制台等。

### 10.2 正确跑法

```powershell
cd <插件目录>\scripts
.\surgery-run.cmd `
  -SessionPath "%USERPROFILE%\.dsh\sessions\<scope>\<session>\session.v4.jsonl.zstd" `
  -AppPath "<app-dir>\DeepSeek Harness.exe" `
  -Confirm TRUNCATE-VISIBLE `
  -StartDelaySeconds 30 `
  -RestartDelaySeconds 0
```

它做两件事：注册一次性计划任务 `dsh-longlive-surgery`，然后立刻启动。
任务动作是：

```
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass
  -File <插件>\scripts\unattended-surgery.ps1 ... -Confirm TRUNCATE-VISIBLE
```

`-WindowStyle Hidden` + 计划任务 = **没有任何用户可点的控制台**。
看到 `TASK_STARTED dsh-longlive-surgery` 之后，注册窗口就可以关了；手术已经托管给
Task Scheduler，关掉注册窗口不会杀它（但也别在 30 秒阅读窗口内去关宿主，那会打断手术）。

| 参数 | 默认 | 含义 |
|---|---|---|
| `-SessionPath` | 必填 | 目标 `session.v4.jsonl.zstd`；必须在 DSH sessions 根下 |
| `-KeepTurns` | 12 | 至少保留的 turn 数 |
| `-KeepTokens` | 80000 | 保留 token 预算 |
| `-StartDelaySeconds` | 30 | 启动到关宿主之间的阅读窗口（刻意留给人看最后一屏） |
| `-RestartDelaySeconds` | 0 | 读回校验 + 回执落盘后到重启之间的等待；0 = 立刻重启 |
| `-AppPath` | 必填（真跑） | 宿主 exe，关掉后用它重启 |
| `-ResultPath` | 自动 | 结果 JSON；默认 `.longlive/reports/surgery-result-<id>.json` |
| `-DryRun` | 关 | 只写 `phase=done, outcome=dry-run`，不关宿主、不备份、不剪 |

阶段文件：`<memoryRoot>/.longlive/surgery-state.json`，每次转换都是
**临时文件 + rename** 的原子写，阶段为
`prepare → backup → cut → restart → done | failed`，并带
`before/after`（bytes/events/messages/sha256）、`backup.path/sha256`、`pid`、时间戳、
`history[]`。宿主或脚本被杀时，这个文件留在盘上——它就是下一次判断的依据。

读回通过后、重启之前，执行器会把一条「【手术回执】」追加进**会话正文**（普通可见
`user/message`）：结果、停在哪一阶段、前/后字节、前/后事件数、前/后消息数、sha 是否一致、
备份路径和人工建议。下次打开会话，第一屏就能看到，不用去翻 `surgery.log`。如果执行器没写成
（崩溃/断电/旧 state），插件启动时会在第一轮用同一条文本补报一次，之后不再重复。

### 10.3 中断之后：先看，不要重剪

只读查询（不改任何文件）：

```powershell
node scripts\surgery-inspect.mjs --recover-report --memory-root "<memory-root>"
# 或者 --status，等价
```

也可以直接启动一次宿主：插件在 `apply()` 里发现 `surgery-state.json`
且 `phase != done` 时会自动做同样的只读检查，产出
`<memoryRoot>/.longlive/reports/surgery-recovery-<ts>.json`，并在 `audit.log` 追加一行。
**它绝不自动重剪。**

| 判定 | 含义 | 人该怎么办 |
|---|---|---|
| `applied-and-verified` | 剪切已落盘，sha/事件数/消息数与 state 记录一致，且有读回校验 | 不用动。要回滚才用备份覆盖 |
| `applied-unparsed` | 剪切已落盘、读回核验通过，只是 CLI 的 stdout 编码坏了（中文 Windows 的 GBK 控制台）——rc.6 按成功处理 | 不用动；回执里会写明「CLI 输出编码异常，独立读回核验通过」 |
| `applied-unverified` | 文件已是剪切后的样子，但 state 没记下读回校验（脚本在 cut 与 verify 之间被杀） | 启动宿主确认能打开；不用重剪 |
| `aborted-before-cut` | 会话仍与 `before` 一致，备份完整；手术没真正切 | 看一眼 `surgery.log` 末尾，确认宿主已退出后可重跑 |
| `needs-attention` | 会话 sha/字节/事件/消息对不上，或备份缺失/损坏，或 state 本身读不了，或 `E_CUT_UNVERIFIED`（CLI exit 0 但核验不通过） | 先停宿主，按报告里的 `actions` 逐项核对；**不要重剪**，不要手工改会话 |

报告里的 `checks` 会逐项列出：`sessionSha256`、`shaMatch`、`sizeMatch`、`countsMatch`、
`backupExists`、`backupShaMatch`、`readBackRecorded`、版本是否一致等。
`recommendation` 是给人看的一句话，`actions` 是下一步清单。

### 10.4 为什么这么判

- **只读**：恢复自检不写会话、不删 state、不重跑 CLI，最多写一份报告 + 一行 audit。
  自动重剪会把「脚本被杀」升级成「数据被二次处理」，这是不可接受的。
- **以 after 为准**：`phase=cut/restart` 且有 `after` 时，只认磁盘 sha 与 `after` 相等；
  相等且备份在 → applied；不相等 → needs-attention（可能宿主重启后又写了，也可能文件被换过）。
- **以 before 为退路**：没有 `after` 时，磁盘仍等于 `before` 就说明 cut 没落盘 →
  aborted-before-cut；磁盘变了又没 after → cut 很可能执行了但回执没写 → needs-attention。
- **done 不重复报告**：`phase=done` 时启动自检直接跳过，不产生第二份报告。
- **备份是硬条件**：除了 `prepare` 阶段，cut 之后没有备份一律 needs-attention——
  没有退路的「成功」不算成功。

### 10.5 回滚

```powershell
# 先停宿主，确认没有进程
$S = "<sessions-dir>\session.v4.jsonl.zstd"
$BAK = "$S.pre-surgery-20261104-141422"   # 或 .bak-YYYYMMDD
Copy-Item -LiteralPath $S -Destination "$S.broken-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
Copy-Item -LiteralPath $BAK -Destination $S -Force
```

回滚前先复制当前文件留证；回滚后跑一次 `verify-truncation`，再启动宿主。
回滚不会改 `surgery-state.json`——它是历史回执，不要为了「看起来干净」删掉它。
