# 错误码与下一步（ERRORS）

dsh-longlive 的所有工具失败时都会返回 `{ ok: false, code, message }`（同步抛出的则是带 `code` 的 `Error`）。这张表按出错的位置分组：**先找你的 `code`，照最后一列做**。

> 版本：1.5.0。码表与源码同步；新增码时必须同时改本文件（`test/portability.test.mjs` 会检查本文件随包发布）。

## 插件整条没加载（一个工具都没有）

这类问题没有工具错误码可查：`apply()` 失败，宿主只打一行警告，22 个工具全部不存在。
先看宿主的 stderr。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `dsh: warning: 1 entry did not activate`<br>`session-longlive (dsh-session-longlive): Error: cannot get property "version" without inject` | **0.7.3 的激活回归**：`src/host-version.js` 直接读了未在 `inject` 声明的 `ctx.version`，Cordis 代理抛错，整条 entry 挂掉 | 升级到 **0.8.0**（所有宿主面读取都做了守卫）；暂时不能升级就回滚到 0.6.0（见 [QUICKSTART.md](../QUICKSTART.md) §4） |
| `failed to import: SyntaxError: ...` | 包文件损坏或解压不完整 | 重装同一个 tgz，先核对 `.sha256` |
| `Cannot find package '@deepseek-ai/dsh-tools'` | 宿主没提供 peer 依赖（profile/宿主版本不对） | 换受支持的 DSH 宿主（`engines.dsh >=0.2.0 <1.0.0`） |
| 没有 `did not activate`，但会话里仍看不到工具 | 看错 profile / 宿主没重载 | `dsh plugin --profile <p> list --depth 0` 确认装在哪；重启该 profile |

**怎么确认是不是这一类**：`--dump-config` 只证明 entry 挂上了，不证明激活；必须起宿主看
stderr 有没有 `did not activate`。新 profile 第一次启动可能是一次准备性加载，**启动两次**再下结论。
完整验证步骤见 [QUICKSTART.md](../QUICKSTART.md) §3A/§3B。

### engines.dsh 自检（1.4.0）

插件启动时会把宿主版本与 `package.json` 的 `engines.dsh` 比对。**版本不匹配不会让插件停止
加载**：只打一行 warning，并在 `<memoryRoot>/.longlive/status.json` 写入 `engineMismatch`
（`hostVersion` / `required` / `at` / `source`），面板据此显示红点。版本来源依次是 Cordis ctx、
`config.hostVersion`、`DSH_HOST_VERSION`，最后读宿主清单（桌面宿主为
`process.resourcesPath` 下的 `app.asar/dsh/package.json`；也可用 `DSH_HOST_PACKAGE` 显式指定）。
探测不到按「未知」处理，不写记录也不报错；只读记忆根导致写不进去时同样只 warn。
字段与面板接入口径见 [PANEL-INTEGRATION.md](./PANEL-INTEGRATION.md) §8。

## 记忆根与配置

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `E_MEMORY_ROOT_UNSET` | 开了严格模式（`strictMemoryRoot: true` 或 `DSH_LONGLIVE_STRICT_MEMORY_ROOT=1`）却没有配根 | 配 `memoryRoot`，或设 `DSH_LONGLIVE_MEMORY_ROOT`（旧名 `DSH_MEM`）；也可以关掉严格模式改用默认根 |
| `E_MEMORY_ROOT_MISSING` | 显式配置的记忆根目录不存在（插件**不会**替你创建显式路径） | `mkdir -p <该目录>`，或把配置改成已有目录；默认根则会自动创建 |
| `E_MEMORY_ROOT_NOT_DIR` | 记忆根路径上是一个同名文件 | 移走或删除同名文件，再重试 |
| `E_PATH_OUTSIDE_ROOT` | 目标路径用 `..`、绝对路径或符号链接逃出了记忆根 | 只传记忆根内的相对路径 |
| `E_BAD_ARGUMENT` | 参数不是预期的字符串/对象（`null`、数组、数字等） | 按工具 schema 传参；`confirm` 等枚举值一字不差 |
| `E_SYMLINK_REFUSED` | 记忆库里遇到符号链接或 junction | 换真实目录；不要用链接把记忆库指到别处 |
| `E_CONFIRM_REQUIRED` | 只做了预演，没有真正删除 | 真删时传 `confirm: "FORGET"`（`memory_forget`）或对应确认词 |

## memory_index / memory_consolidate / memory_reinforce / memory_forget

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `E_INDEX_MARKERS` | `INDEX.md` 缺少 `<!-- BEGIN GENERATED -->` / `<!-- END GENERATED -->` | 手工补上这两行标记（其余手写内容不会被动） |
| `E_INDEX_INCOMPLETE` | 有卡片缺 frontmatter，无法生成行 | 给该卡补最小 frontmatter（`title/date/tags/salience/strength/last_used/revisions`） |
| `E_INDEX_VERIFY` | 写 `INDEX.md` 后回读校验失败 | 先看 `.longlive/backups/` 的备份；排查杀毒/同步盘占用后重试 |
| `E_READ_ONLY` | 只读模式下调用了需要写入的动作 | 用 `apply: true` 重跑（`memory_index`）；`consolidate` 本来就只出报告，不改卡 |
| `E_CARD_NOT_FOUND` | 卡片相对路径不存在 | 用 `memory_index` 或列目录确认路径；路径相对记忆根 |
| `E_NOT_A_CARD` | 目标不是卡片（无 frontmatter 或不是 `.md`） | 指向 `topics/*.md` 或 `journal/*.md` |
| `E_REINFORCE_VERIFY` | 强化后正文被改动，已自动回滚 | 保持卡片正文原样；插件只允许追加 `<!-- rev: ... -->` 行 |
| `E_ROLLBACK_FAILED` | 写后校验失败，回滚也失败 | 从 `.longlive/backups/` 里对应备份手工恢复 |
| `E_BACKUP_SOURCE` | 备份源文件不存在/读不到 | 确认原文件还在、可读；不要先手工改备份 |
| `E_BACKUP_VERIFY` | 备份写后校验失败 | 检查磁盘空间与权限，重跑 |
| `E_STATE_CORRUPT` | `memory-state.json` 不是合法 JSON | 从 `.longlive/backups/` 恢复，或删掉让插件重建（会丢 consolidate 进度） |
| `E_LIST_FAILED` | 列记忆目录失败 | 检查记忆根权限；确认它不是网络盘且在线 |
| `E_WRITE_FAILED` / `E_WRITE_VERIFY` | 写入或写后回读失败 | 检查权限、磁盘与同步盘占用；重试 |
| `E_FRONTMATTER_MULTILINE` | frontmatter 值里出现多行 | 把值压成一行，长文放进正文 |
| `E_FRONTMATTER_UNTERMINATED` | frontmatter 没有闭合 `---` | 补上第二行 `---` |
| `E_FORGET_MOVE` | 移动到 `archive/tombstones/` 失败 | 检查目标目录权限与磁盘；原卡未删除 |
| `E_CARD_STATUS_INVALID` | frontmatter 的 `status` 不是 `active` / `locked` / `archived` | 改成三态之一；缺省即 `active`，不要写别的词 |
| `E_CARD_SALIENCE_INVALID` | frontmatter 的 `salience` 不是 0–9 的整数 | 改成 0–9 的整数（缺省 3）；要保核心卡就写 `status: locked` 或 `salience: 5` |

## memory_recall（主动回忆，只读）

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `E_RECALL_EMPTY_QUERY` | `query` 缺失、不是字符串或是空白 | 传一段自然语言或关键词 |
| `E_RECALL_NO_MATCH` | 查询合法但没有任何卡片命中（**不是异常**，结果仍 `ok: true`，`results: []`） | 换关键词；或放宽 `room` / `status`（默认只搜 `active` + `locked`，`archived` 要显式指定） |

## live_*（会话注册表）

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `E_LIVE_CORRUPT` | 某行 live 记录无法解析 | 先 `session_live_list` 看是哪一行，再用 `session_live_prune`；不要手改 JSON |
| `E_LIVE_ROW_BLOCKED` | 行路径被目录或符号链接占住 | 移走占用物后重试 |
| `E_LIVE_WRITE` | tmp → rename 写行失败 | 检查 `.longlive/live/` 的权限与磁盘 |
| `E_SESSION_ID_NOT_CANONICAL` | 传了大小写/空白别名 | 用错误里 `canonical` 字段给的小写 id |
| `E_CONFIRM_REQUIRED` | `session_live_prune` 只做了预演 | 真清理传 `confirm: "PRUNE"` |
| `SESSION_IS_RUNNING` | 目标会话仍在运行 | 先停掉该会话再操作，或换目标 |

## session_health / session_truncate（会话日志）

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `SESSION_NOT_FOUND` | 给的日志路径不存在 | 跑 `session_health` 列清单，或改用 `sessionId` / `session: "latest"` |
| `SESSION_AMBIGUOUS` | 前缀匹配到多个会话 | 用完整 session id |
| `SESSION_CORRUPT` | zstd 解不开或日志结构坏 | 先 `session_health`；从 `.bak-YYYYMMDD` 恢复后再试，别连续 truncate |
| `SESSION_LOCKED` | 文件被别的进程独占 | 关掉占用它的 app/进程；插件不会杀进程 |
| `SESSION_RECENT_WRITE` | 60 秒内被写过 | 停掉写入方，等窗口过去再跑 |
| `SESSION_CHANGED` | 读取后、写入前日志又变了 | 停掉写入方，重跑 |
| `VISIBLE_FILE_BUSY` | Windows 独占句柄探测发现 app 打开着日志 | 关掉那个 app 再试 |
| `NO_TURN_BOUNDARY` | 找不到可切的 turn 边界 | 先 `session_compact`，再用不同 `keepEvents` 重试 |
| `VISIBLE_CONVERSATION_CHANGED` | 预演与真跑之间可见对话变了 | 重新预演（dry-run） |
| `INBOX_PROJECTION_INVALID` | 日志尾部的 inbox 投影不自洽 | 先 `session_compact`，再重试；不要手改日志 |
| `IS_BACKUP` | 目标是 `.bak-*` 备份 | 指向 `session.v4.jsonl.zstd` 本体 |
| `TMP_VERIFY_FAILED` | 临时文件写后校验失败 | 检查磁盘/杀毒；原日志未被改动 |
| `POST_WRITE_VERIFY_FAILED` | 替换后校验失败 | 按 runbook §6 用 `.bak-YYYYMMDD` 回滚 |
| `BACKUP_MISSING` | 找不到配套备份 | 先把 `session.v4.jsonl.zstd` 复制成 `.bak-YYYYMMDD` 再操作 |
| `BACKUP_SHA256_MISMATCH` | 备份哈希与记录不符 | 重新备份，不要拿旧备份回滚 |
| `CONFIRM_REQUIRED` | 只做了预演 | 真写传 `confirm: "TRUNCATE"` |
| `BAD_ARGUMENT` | 参数非法（负数、亚秒、未知键） | 按 schema 重传 |
| `TRUNCATE_FAILED` | 未分类的截断失败 | 看 `error.cause` 与 `session_health` |
| `READ_FAILED` | 读日志失败 | 检查路径与读权限 |
| `NOT_A_FILE` | 给的是目录不是文件 | 指向 `...\session.v4.jsonl.zstd` |
| `PATH_NOT_ABSOLUTE` / `PATH_NOT_SESSION_FILE` / `PATH_OUTSIDE_SESSIONS` | 路径不是绝对路径、不是会话日志、或不在 `<home>/sessions` 下 | 用 `session_health` 给出的路径形式，别自己拼 |

## session_truncate_visible（可见前缀截断）

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `VISIBLE_NOT_FOUND` | 日志不存在 | 同 `SESSION_NOT_FOUND` |
| `VISIBLE_BAD_ARGUMENT` | 参数非法 | 按 schema 重传 |
| `VISIBLE_IS_BACKUP` | 目标是备份文件 | 指向本体日志 |
| `VISIBLE_CONFIRM_REQUIRED` | 只做了预演 | 真写传 `confirm: "TRUNCATE-VISIBLE"`（活会话还需额外确认） |
| `VISIBLE_RECENT_WRITE` / `VISIBLE_LOCKED` | 60 秒内被写 / 被独占 | 停掉写入方或占用 app，再试 |
| `VISIBLE_NO_PROTECTED_HEAD` | 日志里没有可保留的受保护头 | 该日志不支持可见截断，改用 `session_truncate` |
| `VISIBLE_REPLACEMENT_STRADDLES_CUT` | 替换文本跨过切点 | 调整 `replacement`，让它完整落在保留区或删除区 |
| `VISIBLE_NO_BOUNDARY` | 找不到 turn 边界 | 先 compact，或调整 `keepTurns` / `keepTokens` |
| `VISIBLE_TMP_VERIFY` | 临时文件校验失败 | 检查磁盘；原日志未动 |
| `VISIBLE_POST_VERIFY` | 替换后校验失败 | 用 `.bak-YYYYMMDD` 回滚 |
| `VISIBLE_CHANGED` | 操作过程中文件变了 | 重跑预演 |
| `VISIBLE_BACKUP_MISSING` / `VISIBLE_BACKUP_MISMATCH` | 备份缺失 / 哈希不符 | 重新备份后再操作 |

> seeded 会话（`header.isSeeded`，从别的日志分叉来的）截断后会保留 `isSeeded`，并在序号 0 放一个
> `session/end-seed`（`data.inherited: true`）标记——宿主的解码器正是从这个标记反推进继承前缀长度，
> 缺了它就会报 `SessionPersistenceCorruptionError: … lacks an inherited end-seed marker`。别手工删这个标记。
| `VISIBLE_INFLIGHT_CORRUPT` | 未完成事务记录损坏 | 检查 `.longlive/live` 同名 inflight 文件；不要盲目 rollback |
| `VISIBLE_INFLIGHT_BACKUP_MISSING` | inflight 指向的备份丢了 | 不要继续 rollback；用 `.bak-YYYYMMDD` |
| `VISIBLE_ARCHIVE_EXISTS` | 归档文件已存在（绝不覆盖） | 换 session，或在确认旧归档后移走/改名 |
| `VISIBLE_ARCHIVE_VERIFY` | 归档写后回读失败 | 检查磁盘；原日志未动 |
| `VISIBLE_RECOVERY_FAILED` | 启动时恢复上次中断的事务失败 | 手工从备份恢复并删掉残留 inflight 记录 |
| `VISIBLE_TRUNCATE_FAILED` | 未分类失败 | 看 `error.cause` 与 `session_health` |
| `VISIBLE_FAULT_INJECTED` | 仅测试用故障注入 | 正常使用不会出现；若出现，说明环境里开了故障注入开关，去掉后重试 |
| `VISIBLE_CURRENT_ID_UNKNOWN` | 宿主没告诉插件当前会话 id，且目标像是活会话 | 显式传 `sessionId` |
| `VISIBLE_TARGET_IS_LIVE_SESSION` | 目标是正在运行的会话 | 先停会话；确实要截断活会话的可见前缀时按提示加确认参数 |
| `VISIBLE_LIVE_ESCAPE_CONFIRM_REQUIRED` | 截断活会话需要额外确认 | 按错误提示加确认参数；不要绕过 |

## 无人值守手术（`scripts/unattended-surgery.ps1`）

| 码 / 状态 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `E_CUT_UNVERIFIED`（退出码 7，`phase=needs-attention`） | CLI exit 0，但 stdout 一行 JSON 都解析不出来，且独立读回核验不通过（会话 sha 没变 / 事件数没降 / 备份不在或与 before 不符） | 不要重剪、不要手工改会话。看 `state.needsAttention.checks` 与 `.longlive/logs/node-cut-*.utf8.txt`；会话与备份都在，按报告 `actions` 核对后人工决定 |
| `applied-unparsed`（成功，不是错误） | CLI exit 0、输出不可解析（典型：中文 Windows 的 GBK 控制台把 UTF-8 JSON 解坏），但独立核验确认剪切已落盘 | 不用动。回执会注明「CLI 输出编码异常（applied-unparsed），独立读回核验通过」；`verify.checks` 里有逐项证据 |
| `CLI_FAILED` / 退出码 4 | CLI 非 0 退出，或解析成功但 `ok:false`，或备份失败 | 看 `surgery.log` 的 `cut ...` 行与 `state.cut.cli.text`；确认宿主已退出、备份可用后再重跑 |
| 退出码 5 | CLI 正常退出，但 `surgery-inspect.mjs` 读回的 sha/events/messages 与 CLI 的 `after` 不一致 | 磁盘与记录不一致，不要重剪；用 `.pre-surgery-*` 备份核对 |
| 退出码 6 | 重启后 60 秒内没看到宿主进程 | 手工启动宿主；剪切已保留，回执可能已写 |

> rc.6 起执行器**不再按控制台代码页解码 node 输出**：它用 `ProcessStartInfo` 直接以 UTF-8
> 读取 stdout/stderr，所以中文路径、中文会话 id、中文回执在任何代码页下都不会变成乱码；
> 若仍出现不可解析输出，原始字节会原样落在 `.longlive/logs/node-*.utf8.txt`。

## 自动截断与 compact

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `AUTO_BAD_CONFIG` | `autoTruncate` 配置形状不对 | 用 `{ mode: "log" \| "dryrun" \| "request", ... }` |
| `AUTO_BAD_MODE` | `mode` 不是三个值之一 | 三选一；Windows 外不要用 `request` |
| `AUTO_EVALUATE_FAILED` | 读会话大小失败 | 检查 `<DSH home>/sessions` 权限 |
| `AUTO_LOG_WRITE` | 写自动截断日志失败 | 检查 `<memoryRoot>/.longlive/logs/` 权限 |
| `AUTO_REQUEST_WRITE` | 写 request 文件失败 | 检查 `<memoryRoot>/.longlive/` 权限；确保 PowerShell 编排器能读到 |
| `CLOSE_FAILED`（编排器 exit 3） | 发出温和信号 + 3 秒等待 + 按 PID 强杀 + 2 秒确认之后，仍有进程活着 | 手工关掉残留进程后重跑；会话一个字节都没动，request 文件也还在 |
| `LOAD_VERIFY_FAILED`（编排器 exit 5） | 真实宿主加载校验失败（截断后的日志读不回来） | 不用管：脚本已从备份恢复并重启应用；把 `auto-truncate-run.log` 和结果 JSON 的 `verify` 字段留下 |
| `COMPACTION_UNAVAILABLE` | 宿主没有 `ctx.compaction` 服务 | 升级宿主；或手动传 `sessionPath` 做日志截断 |
| `COMPACTION_NO_AGENT` | 宿主没有 agent 服务 | 同上 |
| `COMPACTION_FAILED` | `session_compact` 抛错 | 看 `error.cause`；先 `session_health` |

## 插件自身

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `PACKAGE_JSON_UNREADABLE` | 包内 `package.json` 读不到 | 重新安装插件包（可能被截断） |
| `BAD_PACKAGE_VERSION` | `version` 不是 `x.y.z` | 修 `package.json` 后重装 |
| `LEASE_RACE` | `lease_acquire` 时被别人抢先 | 看错误里的 holder / acquiredAt；等对方释放或换 holder |
| `NO_FILE_PATH` | 宿主 compact 结果没有 `file_path` | 手动传 `sessionPath` |

## 可选依赖（doctor / `--setup`）

`scripts/longlive-doctor.mjs` 默认只读。推荐安装入口是 `--setup`：先打印计划（缺失包、版本约束、
目标 profile、确切命令、重启提示），要求输入大写 `YES`；取消时**不 spawn、不写文件**、exit 0。
`--setup --yes` 供管道/CI 跳过确认。只有 `--setup` / `--apply` 才会执行 `dsh plugin --profile <profile> add`，doctor
从不自动重启宿主。每次真正执行都会向 `<DSH home>/longlive-doctor-audit.log` 追加一行 JSON；
写日志失败只提示，不影响安装结果。

它不静默：子进程失败时保留 exit code 与捕获的 stdout/stderr，并按下面的状态报告。

| 现象 / 状态 | 原因 | 你该怎么做 |
| --- | --- | --- |
| 依赖状态「缺失」，doctor exit 1 | 当前 profile 没装或没启用 `@kenz1117/dsh-engram` | 跑 `--setup` 并按计划输入大写 `YES`；或按表格命令手工 `dsh plugin --profile <name> add @kenz1117/dsh-engram`，装完重启宿主 |
| 依赖状态「未检测」，exit 1 | `DSH_HOME/profiles` 不存在或为空，或 `--profile` 指向不存在的 profile | 先启动一次 DSH 生成 profile；核对 `DSH_HOME` 与 `--profile` |
| 看不到 `dsh` 命令 | `PATH` 里没有 dsh，且未设 `DSH_BIN` | 设 `DSH_BIN` 指向 `dsh.cmd` / `dsh.exe`，或把 DSH CLI 加进 `PATH` |
| `--setup` 打印「已取消，未做任何改动。」 | 输入不是大写 `YES`（含空行、`yes`、EOF、Ctrl+C） | 正常取消，exit 0、零副作用；要装就重跑并输入大写 `YES` |
| `--setup 在非交互环境（管道/CI）需要 --yes`（exit 2） | 没有 TTY 且没带 `--yes` | CI / 脚本改用 `--setup --yes`；或先在真实终端手工确认 |
| `dsh plugin add ... 失败（exit N）` | 子进程非零退出（网络、权限、包名等） | 看 doctor 保留的 stderr 片段；修好后重跑。安装失败不会改动 longlive 本体 |
| audit 日志写入失败（stderr 一行） | `<DSH home>` 不可写或路径被占 | 安装结果仍然有效；修好权限后下一次执行会自动补写新行 |
| 启动日志出现一行「可选依赖缺失：…；安装运行 `node scripts/longlive-doctor.mjs --setup`」 | 当前 profile 缺 engram | 可选，不影响剪对话；按提示跑 `--setup`，装完重启 |

## R1 主脑决策层（`src/router/route.js`）

R1 主脑决策层的错误码。**这一层的语义是 fail-closed**：`route()` 只要给出下列任一错误码，就同时返回
`needsHuman: true`，并且 `decisions` 里**只有一条** `{ kind: "reply", action: "guard.refuse" }`
（`ruleId: "R-ROUTER-FAILCLOSED"`，`writeScope: []`）。调用方看到错误码就停，**不许把「没判断」当
「不用做」，也不许只执行其中一部分决定**。`--check` 对已知坏输入自带判官自检（`judge-selfcheck`），
判官被短路时 `--check` 直接红。

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `E_ROUTE_RULES_UNAVAILABLE` | `routing-rules.json` 读不到（被删/权限/路径错） | 恢复规则表；不要用空表继续跑 |
| `E_ROUTE_RULES_INVALID` | 规则表 JSON 损坏、顶层不是对象、`rules` 不是数组或为空 | 修 JSON；空表等于放行一切，所以也拒 |
| `E_ROUTE_PROFILE_UNKNOWN` | 配置项 `routerPolicyProfile` 指向的策略文件不存在（按名字在 `src/router/policies/<name>.json` 查找） | 核对 profile 名字与文件名；**未知名字不降级到 generic**，直接 fail-closed |
| `E_ROUTE_POLICY_INVALID` | 策略文件 JSON 损坏或结构不合法；或 owner 叠加层试图放宽 fail-closed（加网络/回显原文/允许终止/削弱同意权/抬高阈值/扩写域） | 修策略文件；默认 generic 只放通用原则，叠加层只许收窄（补 marker、收紧阈值、加要求） |
| `E_ROUTE_ALIASES_UNAVAILABLE` | `aliases.json` 读不到 | 恢复别名表；动作名无法归一 |
| `E_ROUTE_ALIASES_INVALID` | 别名表 JSON 损坏、`actions` 结构不对、`canonical` 重复 | 按 `version/actions[{canonical,legacy,aliases}]` 修 |
| `E_ROUTE_RULE_FIELD` | 某条规则缺字段或字段类型错（id/priority/match/decision/before/after/level/writeScope 形状） | 错误里带 `ruleId`，按提示补字段；**整表拒收，不会只丢这一条** |
| `E_ROUTE_RULE_UNKNOWN` | 某条规则的 `kind` / `action` / `target` 不在白名单 | 改用 `route.js` 里 `KINDS/TARGETS/aliases.json` 的合法值；**不许静默丢弃该规则后继续** |
| `E_ROUTE_AMBIGUOUS` | 最高优先级上有 ≥2 条规则同时命中（`errors[].rules` 列出全部竞争 ruleId） | 交人裁决：收紧关键词/ctx，或给规则排出明确优先级；**不许按文件顺序选中** |
| `E_ROUTE_CTX_MISSING` | 规则的关键词命中了，但 `ctx` 缺它门控要的字段 | 补 `ctx.tokens/activeWorkers/openRows/zone`；**不许当成「条件不满足」静默跳过** |
| `E_ROUTE_CTX_TYPE` | `ctx` 字段类型错（如 `activeWorkers: "2"`）或 `ctx` 不是对象 | 按 schema 传有限数字/字符串；类型错不是「没命中」 |
| `E_ROUTE_OVERRIDE_UNJUSTIFIED` | override 缺 `ruleId` 或 `reason` | 补理由；该 override 被丢弃，原判定保留 |
| `E_ROUTE_OVERRIDE_UNKNOWN` | override 指向不存在的规则，或该规则本次没产生决策 | 核对 `ruleId`；**整单拒绝，绝不贴到 `decisions[0]`** |
| `E_ROUTE_SCOPE` | `writeScope` 是盘符路径、绝对路径、含 `..`/`~`，或不在生效策略（`$policy:writeScope.allowPrefixes`）的白名单内 | 改成允许前缀内的相对路径（`memory/`、`engram:`、`taskboard:`、`sandbox:`、`evidence:`、`fixtures:`） |
| `E_ROUTE_EXPLOSION` | 规则表条数/竞争规则数/单条规则展开的决策数超过生效策略 `limits` 上限 | 拆规则/删重复；上限在 `src/router/policies/generic.json` 的 `limits` |
| `E_ROUTE_CONTRACT` | `route()` 内部异常（按 fail-closed 兜底），或输出契约自检失败 | 看 `message`；这是代码 bug，不是输入问题 |
| `E_ROUTE_DETERMINISM` | 同一输入两次输出不一致 | 检查是否引入了时间/随机/文件状态依赖 |
| `E_ROUTE_ISOLATION` | 决策层试图读写真实记忆库 | 决策层只做匹配，不允许落盘 |
| `E_ROUTE_SHAPE` | 输入形状不合法且无法安全解释 | 按 `route()` 注释里的 schema 传参 |
| `E_ROUTE_ORDER` | 决策顺序与规则表声明不一致 | 修 `before/decision/after` 的展开顺序 |
| `E_ROUTE_ACTION` | 决策动作不在允许集内 | 用 `aliases.json` 里的动作名 |
| `E_ROUTE_REFUSAL` | 拒绝类决策带了真实写入 | 拒绝就是零写入；dry-run 只能写 `sandbox:` |
| `E_ROUTE_EVIDENCE` | 决策缺可回读的证据（规则表行号 / policy 锚点 / ctx 字段） | 补 `policyRef` 或让规则在表里有 `"id"` 行 |
| `E_ROUTE_AUDIT` | override 记录缺 reason/by/ISO 时间戳，或 applied 与 records 对不上 | 补全审计字段 |
| `E_ROUTE_HUMAN` | 该交人的决定没标 `needsHuman` | 在规则模板里写 `needsHuman: true` |
| `E_ROUTE_POLICY` | 规则的 `policyRef` 在设计文档里解析不到 | 核对 `policyRef` 与 `R1-DESIGN.md` 的章节锚点 |
| `E_ROUTE_LEVEL` | 规则的 level 不在 X/D/H，或与设计矩阵不符 | 按 `LEVEL_MATRIX` 改 |
| `E_ROUTE_FORBIDDEN` | 命中设计里的禁止行为（如按文件顺序裁决） | 改规则/代码，不许绕过 |
| `E_ROUTE_BRIEF` | `worker_spawn` 的 `args.brief` 缺五要素或验收/产物路径 | 按 judge 的 brief 模板补齐 |

### J8 身份同意（`route.js` / `judge.mjs` J9）

这两个码**不套 `E_ROUTE_` 前缀**：它们说的不是「路由层坏了」，而是「身份变更被正确地挡下了」，
属于正常判定结果，不是 fail-closed 故障。

| 码 | 什么时候出现 | 你该怎么做 |
| --- | --- | --- |
| `E_IDENTITY_CONSENT_REQUIRED` | 用户单方面要求改名/改画像/改自称，但没有当前会话助手本人的同意记录（`consent.holder === "assistant"` 且带 `at` 与 `quote`） | 回 `identity.hold`，把「谁有权」说清楚；**不许把用户的「我同意/你改吧」当成同意**，也不许先改再补记录 |
| `E_SELF_CONSENT` | judge J9：判定里出现了 `engram.profile.edit` 画像/名字写入，但同意记录不是当前会话助手本人给的（或 `satisfied !== true`、缺 `at`/`quote`） | 改回 `identity.hold`；只有当前会话助手本人带时间戳与原话的同意记录才能写 `engram:profile`，且必须 `keepHistory: true` |

本规则与被判断的 agent 具体叫什么无关：判定只看 `consent.holder === "assistant"` 以及 `at`/`quote` 是否齐全，
不看 agent 的名字、自称或头像；换一个 agent 装上这套路由器，同意权同样归它自己，用户单方面要求同样不算同意。

## 这些不是错误码

- `DSH_MEM`、`DSH_LONGLIVE_MEMORY_ROOT`、`DSH_LONGLIVE_STRICT_MEMORY_ROOT`、`DSH_HOST_VERSION`：环境变量名，出现在提示文案里。
- `DSH_PROBE_FREE`：内部探测用的环境变量，不是错误。
- `VISIBLE_FILE_BUSY` 同时属于会话层（见上表）：它代表 Windows 独占句柄探测的结果。
