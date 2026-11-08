# QUICKSTART — 五步跑通（1.8.0）

目标：在一台新机器上，5 步内让 `@jjh32456/dsh-longlive` 装好、能用、能回滚、能卸干净。
完整背景见 [README.md](README.md)，逐码排错见 [docs/ERRORS.md](docs/ERRORS.md)，
截断操作与发布自检见 [runbook.md](runbook.md)。

> 平台：会话截断与自动截断的**独占句柄探测、PowerShell 编排器（`request` 模式）只在 Windows 上成立**。
> Linux/macOS 上其余工具可用，但探测会标记为 `unverified`，`request` 模式不可用。
>
> 0.7.3 有一个真实宿主上的激活回归：版本探测读了未声明的 `ctx.version`，Cordis 抛
> `cannot get property "version" without inject`，整条插件 entry 不激活、19 个工具全不在。
> 0.7.4 已修（所有宿主面读取都做了守卫，`apply()` 也不会再因诊断失败而挂掉）。
> 仍卡在 0.7.3 的机器请直接升级或按第 4 步回滚到 0.6.0。

## 0. 开始前：确认三件事

**（1）用哪个 Node。** 干净机器的 `PATH` 里通常没有 `node`；DSH 自带运行时。先把它指出来：

```powershell
# <DSH 安装目录> 换成你的实际安装目录（目录下应有 resources\runtime 与 DeepSeek Harness.exe）
$NODE = '<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $NODE --version          # 本包在 v24.21.0 上验证；package.json 要求 >=20
```

如果 `where.exe node` 能找到 Node（>=20），也可以直接用 `node`。本文其余命令统一写 `$NODE`。

**（2）用哪个 dsh。** 同样优先用安装目录里的 CLI，而不是假设 `PATH` 里有：

```powershell
$DSH = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $DSH --version
```

**（3）安装权限。** 会话内的 `plugin_manager action=install_bundle` / `remove_bundle`
**需要 danger-full-access，或对这一次调用逐次批准**。如果机器关掉了审批又没开 danger-full-access，
安装会被自动拒绝——这不是包的问题。没有权限时走下面的 CLI 安装（`dsh plugin ... add/remove`）。

## 1. 安装

### 1A. 已经拿到 tgz（最常见）

先把包放到固定目录，核对 sha256，再装进一个**新 profile**：

```powershell
$TGZ = '<path-to>\jjh32456-dsh-longlive-1.8.0.tgz'
Get-FileHash -Algorithm SHA256 $TGZ      # 对照同目录的 .tgz.sha256

$LLPROFILE = 'fresh0723b'
# 变量名别用 $PROFILE：那是 PowerShell 自己的自动变量（配置文件路径）。
# 先按 web 模板建一个干净 profile；--from-default-profile 会「替换」同名 profile，别对在用的 profile 跑
& $DSH $LLPROFILE --from-default-profile web --dump-config | Out-Null

& $DSH plugin --profile $LLPROFILE add "file:$TGZ"
& $DSH plugin --profile $LLPROFILE list --depth 0
```

`list` 应出现 `@jjh32456/dsh-longlive@1.8.0`。`dsh plugin --profile <新名字> add` 自己也会初始化
profile，但那样只带 `@deepseek-ai/dsh-base`；要网页 UI 和与本文一致的验证，先用
`--from-default-profile web` 建模板 profile。

> 装完要让宿主**重新加载这个 profile**（退出该 profile 的宿主再启动）。CLI 安装不会改已经跑着的进程。

### 1B. 只有源码（仓库）

在仓库根目录先自检，再打包，然后走 1A 安装：

```powershell
Set-Location <仓库根目录>
& $NODE test\run.mjs
# 仓库内开发脚本（npm 包不含）\n& $NODE scripts\pack.mjs --expect-version 1.8.0
# 产物：dist\jjh32456-dsh-longlive-1.8.0.tgz（+ .sha256）
```

`pack.mjs`（仓库内开发脚本，npm 包不含）只负责打包，不跑测试；`--expect-version` 会在版本不匹配时拒绝出包。
发布前还要跑带真机 T7 的发布闸门（见 [runbook.md](runbook.md) §1.7）。

### 1C. 在会话里用 plugin_manager

宿主正在跑、且当前 profile 就是目标 profile 时：

```
plugin_manager action=install_bundle target="file:<path-to>/jjh32456-dsh-longlive-1.8.0.tgz"
```

目标必须是**绝对路径**，且需要上面说的权限。装完按宿主提示重载（或重启该 profile）。

> 不要用 `npm install` 当安装方式：本包未发布到 npm registry；`file:` 必须指向刚打出来的
> **1.8.0 tgz**，指向旧版 tgz 会装回旧行为。

### 1D. 装完第一件事：可选依赖自检与 `--setup`

`@jjh32456/dsh-longlive` 没有硬依赖。它和 engram 记忆插件（`@kenz1117/dsh-engram`）是**可选协作**：
装了 engram，`engram_*` 与 `memory_save` 工具才在；不装，这两组工具缺席，但剪对话、备份、截断和
`memory_*` 卡片工具照常工作。插件启动时只打印一行提示（指向 `--setup`），不会自动安装、不会崩、不会阻塞。

**推荐：用 `--setup` 向导。** 在包根目录运行：

```powershell
& $NODE scripts\longlive-doctor.mjs --setup
```

它先打印「将要做的事」——缺哪些包、版本约束、目标 profile 清单路径、将执行的确切命令、装完要重启宿主——
然后要求你输入大写 `YES`。输入其它任何内容（含空行、EOF、Ctrl+C）都会打印「已取消，未做任何改动」并 exit 0，
**不执行命令、不写任何文件**。确认后它逐个执行 `dsh plugin --profile <profile> add <包名>`，失败会保留 exit code 与 stderr 片段；
成功会提示「重启宿主后生效」（doctor 不会自动重启）。

管道/CI 里没人能敲 YES，用 `--setup --yes` 跳过确认（仍会先打印计划）：

```powershell
& $NODE scripts\longlive-doctor.mjs --setup --yes
```

每次真正执行（`typed-YES` 或 `--yes`）都会向 `<DSH home>/longlive-doctor-audit.log` 追加一行 JSON：
timestamp / user / consent / deps / result / exitCode。日志写不进去不影响安装结果。

只想看状态、什么都不改：

```powershell
& $NODE scripts\longlive-doctor.mjs              # 只读表格；有缺失 exit 1
& $NODE scripts\longlive-doctor.mjs --json       # 给脚本/CI
```

旧流程 `--apply` 仍保留（逐个 `[y/N]` 确认），CI 里同样要加 `--yes`。非 TTY 下 `--setup` 没带
`--yes` 会 exit 2 并提示，不会做任何事。

**装完必须重启宿主**（重新加载该 profile）才生效。doctor 对真实 profile 只读；只有显式加
`--setup` 或 `--apply` 才会执行 `dsh plugin add`，安装本身的网络行为由 DSH / npm 决定。

## 2. 配置（可选）

**开箱即用**：不配任何东西，记忆根默认是 `<DSH home>/longlive-memory`。
`<DSH home>` 的解析顺序是 `$env:DSH_HOME` → `$env:USERPROFILE\.dsh`（POSIX 上是 `$HOME/.dsh`）；
默认根在插件加载时自动创建。

需要换位置时，任选一种（优先级从高到低）：

1. 插件配置 `memoryRoot`（推荐；`memRoot` 是兼容别名）
2. 环境变量 `DSH_LONGLIVE_MEMORY_ROOT`
3. 旧环境变量 `DSH_MEM`（向后兼容）

**写法很关键：profile 层要用 `- id:` 覆盖，不要照抄 bundle 里的 `- insert:`。**

```powershell
$MEM = '<memory-root>'
New-Item -ItemType Directory -Force -Path $MEM | Out-Null   # 显式根必须已存在
```

```yaml
# <DSH_HOME>\profiles\<profile>\cordis.patch.yml
- id: session-longlive
  config:
    memoryRoot: <memory-root>
```

`- insert:` 是包内 `cordis.patch.yml`（bundle 作者层）的写法。把它复制进 profile 会再插一条
同 id 的 entry，`--dump-config` 里能看到两条 `# == @jjh32456/dsh-longlive`；用上面的 `- id:`
覆盖才会合并成一条。

三个注意点：

- **显式配置的目录必须已存在**（插件不会替你创建）；只有默认根会自动创建。
  没有 D 盘的机器不要照抄网上以 `D:` 开头的示例——用上面先建好的路径，或者干脆不配。
- 想要「没配就报错」的旧行为，设 `strictMemoryRoot: true`（或 `DSH_LONGLIVE_STRICT_MEMORY_ROOT=1`）。
- `session_wake` / `lease_*` 与 `memory_*` 共用同一条解析链，不会一个指默认、一个指别处。

确认合并结果：

```powershell
& $DSH --profile $LLPROFILE --dump-config | Select-String -Pattern 'session-longlive' -Context 1,6
```

只应有一条 `# == @jjh32456/dsh-longlive`，且 `config` 里是你要的 `memoryRoot`。

### 2B. 策略配置：默认通用，家规自己定（可选）

R1 的判断依据默认只加载**通用策略**（`src/router/policies/generic.json`），不带任何个人家规。
要用某份家规，加一个 `routerPolicyProfile`，值是 `src/router/policies/` 下的文件名（不含 `.json`）：

```yaml
# <DSH_HOME>\profiles\<profile>\cordis.patch.yml
- id: session-longlive
  config:
    memoryRoot: <memory-root>
    routerPolicyProfile: generic                      # 默认；不写等价于它
    # routerPolicyProfile: <profile-name>          # 可选：自定义规则 profile
```

三条硬规则：

- 名字写错 → `E_ROUTE_PROFILE_UNKNOWN`，路由 **fail-closed**，不会悄悄退回 generic。
- 策略文件损坏、或叠加层想**放宽** fail-closed → `E_ROUTE_POLICY_INVALID`，同样 fail-closed。
- 叠加层只能补 marker、收紧阈值、加要求（例如同意必须带 `quoteId`）；规则 id、错误码、fail-closed 行为不变。

自查当前生效的 profile：

```powershell
# 在仓库根执行；$NODE 已在 §0 设好
& $NODE src/router/router.mjs --check --json | ConvertFrom-Json | Select-Object profile
```

## 3. 验证

### 3A. 先证明 entry 已挂上（不需要模型凭据）

```powershell
& $DSH --profile $LLPROFILE --dump-config | Select-String -Pattern 'session-longlive' -Context 1,6
```

有一条 `- id: session-longlive` / `name: @jjh32456/dsh-longlive` 即已挂载。两条同 id → 回第 2 步改写法。

### 3B. 再证明它真的激活了（不需要模型凭据，**这是关键一步**）

CLI 安装后，用这个 profile 起一次宿主，只看 stderr。下面的写法会自动收尾，不会留下一个跑着的宿主：

```powershell
$err = Join-Path $env:TEMP 'longlive-host.err'
$out = Join-Path $env:TEMP 'longlive-host.out'
Remove-Item $err,$out -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $DSH -ArgumentList @('--profile',$LLPROFILE,'--port','19555','--no-open') `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 15
Get-Content $out        # 应出现 dsh web: http://127.0.0.1:19555/...
Select-String -Path $err -Pattern 'did not activate|cannot get property|failed to import'
taskkill /PID $proc.Id /T /F | Out-Null
```

没有输出 = 激活成功（`$out` 里有 `dsh web: ...` 说明服务确实起来了）。若出现：

```
dsh: warning: 1 entry did not activate
session-longlive (dsh-session-longlive): Error: cannot get property "version" without inject
```

说明跑的是 0.7.3 的旧代码（19 个工具都不会注册）；升级到 1.8.0，或按第 4 步回滚到 0.6.0。

> **新 profile 要启动两次再下结论。** 新建 profile 的第一次启动会做一次准备性加载，
> 可能不进入 Cordis runtime，从而掩盖这个错误；第二次启动才是稳定状态。两次 stderr 都干净才算过。

### 3C. 在会话里点四个工具（有模型凭据时）

新建的干净 profile 通常没有模型凭据；这时起会话会报
`MISSING_CREDENTIAL: llm-deepseek: no API key ...` 或 `ACCOUNT_SIGN_IN_REQUIRED`。
那是环境缺凭据，不是插件失败——用 3A/3B 验证即可。

有凭据时，在该 profile 的会话里依次调用：

```
session_health                 # 能列出当前会话，返回 ok:true
memory_index {"apply": false}  # 预演索引，返回 ok:true（不写文件）
session_live_list              # 返回 ok:true；没有 live 记录时 rows 为空
session_wake                   # 返回 ok:true 或明确的 unavailable（不再是路径不存在）
```

### 3D. 确认记忆根落在你以为的位置

```powershell
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Get-ChildItem (Join-Path $home 'longlive-memory')   # 或在第 2 步配置的 memoryRoot
```

不要写死 `$env:USERPROFILE\.dsh`：设了 `DSH_HOME` 的机器上真实根在别处。

四项都过，插件就是可用的。

## 4. 回滚

只回滚**数据**（插件版本不动）：

```powershell
# 会话日志：把当天的备份盖回去（先停掉写入该会话的进程）
Copy-Item "<session-dir>\session.v4.jsonl.zstd.bak-YYYYMMDD" "<session-dir>\session.v4.jsonl.zstd" -Force
```

回滚**插件版本**：

```powershell
$OLD = '<path-to>\dsh-session-longlive-0.6.0.tgz'
Get-FileHash -Algorithm SHA256 $OLD
& $DSH plugin --profile $LLPROFILE add "file:$OLD"
& $DSH plugin --profile $LLPROFILE list --depth 0    # 应显示 @0.6.0
```

旧版 tgz 从哪来：发布目录的 `dist\` 会保留历史版本（0.5.0 / 0.5.1 / 0.6.0 / 0.7.3 / 0.7.4 … 0.7.7 / 0.8.0-rc.1 / 0.8.0-rc.2 / 0.8.0-rc.3 / 0.8.0-rc.4 / 0.8.0-rc.5 / 0.8.0-rc.6 / 0.8.0-rc.7 / 0.8.0-rc.8 / 0.8.0-rc.9（当前 1.5.0），
各自带 `.sha256`；0.7.3 是出问题的那个，别拿它回滚）。如果你只拿到 1.5.0 一个包，向发布者索取
`dsh-session-longlive-0.6.0.tgz`（最后一个没有版本探测、能在 0.7.3 出问题的宿主上正常激活的版本）。
以上版本清单是历史记录，**以实际发布目录为准**（`dist\` 里实际有哪个包才算有）。
本包**不在 npm 上**，不要用 `npm i` 找旧版。

回滚后按 3B 再起一次，确认 stderr 干净；0.6.0 的 A/B 对照就是「stderr 为空、服务正常」。

记忆数据在 `memoryRoot` 里，重装插件不会删除它；`.longlive/backups/` 里还有每次写入前的自动备份。

## 5. 卸载

CLI（推荐，不需要会话权限）：

```powershell
& $DSH plugin --profile $LLPROFILE remove @jjh32456/dsh-longlive
& $DSH plugin --profile $LLPROFILE list --depth 0      # 应不再出现该包
```

会话内等价写法（需要 danger-full-access 或逐次批准）：

```
plugin_manager action=remove_bundle target="@jjh32456/dsh-longlive"
```

确认**无残留**：

```powershell
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path (Join-Path $home 'profiles') $LLPROFILE
Test-Path (Join-Path $profileDir 'node_modules\@jjh32456\dsh-longlive')   # 期望 False
Select-String -Path (Join-Path $profileDir 'package.json') -Pattern '@jjh32456/dsh-longlive'  # 期望无输出
```

卸载**不删除** `memoryRoot`（那是你的数据）；确认不再需要后手工删掉该目录即可。
会话目录里的 `*.bak-YYYYMMDD` 与 `*.archive/` 也归你处置，插件不会自动清理。

如果这个 profile 只是验收用的临时 profile，确认路径无误后可以整个删掉：

```powershell
# 先看清 $profileDir 确实是刚建的那个临时 profile，再执行
Remove-Item -Recurse -Force $profileDir
```

---

## 1.8.0 身份与隐私（第一次用先看这条）

- **默认中性身份**：1.8.0 不内置人名/角色；想用你自己的身份，在记忆根下新建
  `<memoryRoot>/IDENTITY.md`（默认 `%USERPROFILE%\.dsh\longlive-memory\IDENTITY.md`，按 `memoryRoot` 走），
  写短一点、别放敏感信息；不建就用中性默认，不会自动创建或改写。
- **蒸馏 who 默认空**：写入/蒸馏不会再带入内置个人称呼，who 需要你在自己的配置里显式注入。
- **共享大脑活动流默认开启（1.8.0 起）**：写侧（turn/end 记活动）+ 实时注入（只注入其他会话新增，≤5 条 / 整条 ≤300 字）；数据只在本机 `memoryRoot`、不上传。不想开就设 `sharedBrain.activity.enabled: false` 后重启（回到 1.6.8 默认）。
- **共享大脑 thinking 默认开启（1.8.0 起，摘要级）**：只注入其他会话的**摘要**，不写原文、不进日志，`local_only` 内容不写不注入；不想要设 `sharedBrain.thinkingInjection.enabled: false` 后重启（细节见 [docs/CONFIG.md](docs/CONFIG.md)）。
- **发布包隐私门**：打包时仓库内脚本 `scripts/scan-abs-paths.mjs`（npm 包不含）扫绝对路径/个人目录名，blocker=0 才发版；
  包内不含记忆库、会话日志、本机路径（说明见 [docs/PRIVACY.md](docs/PRIVACY.md)）。
- **可移植**：node 走 `process.execPath`，不依赖 PATH；干净 `DSH_HOME` 可 install/运行（Gate-4）。

### 创建自己的身份（可选，3 行）

在 `<memoryRoot>/IDENTITY.md` 写三行即可（不建就用中性默认，不会出现任何具体名字）：

```markdown
名字：<你的名字>
称呼：<你希望被怎么称呼>
规则 / 说话方式：<可选，一句>
```
## 排错速查

| 现象 | 大概率原因 | 处理 |
| --- | --- | --- |
| `dsh: warning: 1 entry did not activate` + `cannot get property "version" without inject` | 0.7.3 的激活回归 | 升级到 1.6.8，或回滚 0.6.0（第 4 步） |
| `--dump-config` 里两条同 id 的 `session-longlive` | 在 profile 层照抄了 `- insert:` | 改成 `- id: session-longlive` + `config:`（第 2 步） |
| `E_MEMORY_ROOT_MISSING` | 显式 `memoryRoot` 目录不存在 | 先建目录，或改用默认根（第 2 步） |
| `plugin_manager` 安装/卸载被自动拒绝 | 缺少 danger-full-access 或审批 | 用 CLI，或对本次调用批准（第 0 步） |
| `node` 不是内部或外部命令 | 干净机器 PATH 没有 Node | 用 `$NODE`（第 0 步） |
| 起会话报 `MISSING_CREDENTIAL` / `ACCOUNT_SIGN_IN_REQUIRED` | 新 profile 没有模型凭据 | 用 3A/3B 验证；这是环境问题，不是插件 |
| 设置页找不到「久视 · 功能开关」 | 1.6.0 起才有设置页伴侣；旧宿主或没有 webServer 的 profile 不注册路由 | 确认装的是 1.8.0 且宿主 Web GUI 可用；没有路由时直接改 `cordis.patch.yml` |

出问题先看 [docs/ERRORS.md](docs/ERRORS.md)；Windows 专属部分（PowerShell 探测、`request` 模式、
`Stop-Process` 硬杀关闭）在非 Windows 上会降级而不是崩溃。
