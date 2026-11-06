# TROUBLESHOOTING.md — 按症状查（1.6.8）

用法：先看「症状」，对不上再看「最可能原因」。每条只给**一条**验证命令——先确认判断，再动手。
「什么时候该停手」比「怎么修」更重要：结构一旦不对，继续重试只会扩大损失。

约定：`$M` = 你的 memoryRoot（默认 `~/.dsh/longlive-memory`），`$P` = profile 目录
（默认 `~/.dsh/profiles/desktop`）。

---

## 1. 装完一个工具都没有

**症状**：宿主能启动，但工具列表里没有任何 `session_*` / `memory_*`；stderr 可能有一行
`dsh: warning: 1 entry did not activate`。

**最可能原因**（按概率）：
1. `autoTruncate` 配置非法，`normalizeAutoTruncateConfig` 抛错，整条 entry 不激活
   （`src/index.js:156` 没有 try 包住）——最常见是 `mode: on` 或 `mode` 拼错；
2. 0.7.3 的注入回归：`cannot get property "version" without inject`（0.7.4 已修，但旧包会中）；
3. 包装了但 profile 不对，或宿主没真正重启；
4. `failed to import` / `Cannot find package '@deepseek-ai/dsh-tools'`。

**验证（一条）**：

```powershell
& dsh --profile desktop --dump-config 2>&1 | Select-String -Context 0,20 'session-longlive'
```

同时看启动 stderr 的原话。`--dump-config` 只有挂载证据，**不能**证明激活。

**修法**：
- 有 `AUTO_BAD_MODE` / `AUTO_BAD_CONFIG` → 改成 `log|dryrun|request`，重启；
- 有 `without inject` → 换 0.8.0 包，重启两次；
- `failed to import` → 用同一个 tgz 重装，不要混版本；
- dump 出 0 个或 2 个条目 → 0 个是没挂上（profile 错），2 个是重复 id（删掉手抄的 `- insert:`）。

**停手**：连续两次重启仍是 `did not activate`，不要再改配置试；先回滚 `cordis.patch.yml` 到
上一版，确认旧版能起来，再逐项加配置定位。

---

## 2. 侧栏没有「潜望镜」

**症状**：Web GUI 左侧看不到面板入口。

**最可能原因**：面板是**独立可选包** `@jjh32456/dsh-longlive-panel@0.2.6`，这一轮根本没装；
或者只 `plugin add` 了、没加进 profile 的 `dsh.profile.bundles`，bundle patch 不生效；
或者当前 profile 不是 `desktop`、宿主没重启。

**验证（一条）**：

```powershell
& dsh --profile desktop --dump-config 2>&1 | Select-String '@jjh32456/dsh-longlive-panel'
```

**修法**：
1. 安装独立可选包 `@jjh32456/dsh-longlive-panel@0.2.6`（装法见该包的 `INSTALL.md`）；
2. 在 `$P\package.json` 的 `dsh.profile.bundles` 里加入 `@jjh32456/dsh-longlive-panel`；
3. 重启宿主，刷新页面。
（两步缺一不可；只装不加 bundles，patch 不会应用。）

**停手**：如果 `--dump-config` 已经能看到面板、页面仍无入口，不要再装第二遍；去看 Web 控制台
的 client bundle 报错，或确认你打开的是本机 `http://127.0.0.1:<port>` 而不是别的实例。

---

## 3. 401 Unauthorized

**症状**：`curl` 或浏览器访问面板/接口返回 401。

**最可能原因**：**面板本身不产生 401**（`src/server.js` 里没有 401 分支，只有 400/404/405/413/500/503）。
401 来自 DSH Web 层、反向代理或远程访问鉴权。也就是说：这不是插件故障。

**验证（一条）**：

```powershell
curl.exe -i "http://127.0.0.1:13781/api/longlive-panel/summary"
```

- 本机回环 200/404 → 面板正常，401 只出现在你走代理/远程时；
- 本机也 401 → 看 DSH Web 的鉴权配置，不是面板配置。

**修法**：用回环地址访问；需要远程时在 Web 层配置 token/反代鉴权，把凭据放在请求头里。
面板路径 `ROUTE = /api/longlive-panel`（`plugin/src/server.js:29`），不要自己拼别的前缀。

**停手**：不要为了"先跑通"去关掉 Web 鉴权或把端口暴露到 0.0.0.0。这是安全边界，不是配置障碍。

---

## 4. 404 Not Found

**症状**：接口/页面 404。

**最可能原因**（先分清是谁的 404）：
1. 面板路由没挂载 → 纯 404（HTML 或空体）；
2. 面板已挂载但路径/参数不合法 → JSON `{ok:false, code:"E_NOT_FOUND"}`；
3. 会话工具报 `SESSION_NOT_FOUND`（不是 HTTP 404，是工具码）；
4. 安装时 `file:` 路径写错 → ENOENT，看起来像 404。

**验证（一条）**：

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" "http://127.0.0.1:13781/api/longlive-panel/summary"
```

200 = 已挂载；404 = 没挂载或前缀错；405 = 用了非 GET。

**修法**：
- 没挂载 → 按 §2 装面板 + bundles + 重启；
- 已挂载但 JSON `E_NOT_FOUND` → 检查 `card/<path>` 是否越界（`..`、绝对路径、`.credentials*`、
  `*.jsonl.zstd` 都会被拒），或文件确实不存在；
- `SESSION_NOT_FOUND` → 用 `session:"latest"` 或绝对 `sessionPath`，别猜。

**停手**：同一路径连续两次 404 且 `--dump-config` 有面板，不要再改路由；去看 server 启动日志里
`webServer` 注册是否失败。

---

## 5. 截断被拒：`SESSION_IS_RUNNING` / `VISIBLE_TARGET_IS_LIVE_SESSION`

**症状**：`truncate-cli.mjs`（或 runner）返回 `SESSION_IS_RUNNING`；
`session_truncate` / `session_truncate_visible` 返回 `VISIBLE_TARGET_IS_LIVE_SESSION`。

**两个入口，两套检查，不要混**：

- **工具层**只做身份判断：目标 id 等于本宿主当前加载的会话 → `VISIBLE_TARGET_IS_LIVE_SESSION`；
  调用者 id 未知 → `VISIBLE_CURRENT_ID_UNKNOWN`（fail-closed）。它**不探测**心跳/句柄
  （`assertNotOwnLiveSession`，`src/tools.js:431-479`）。
- **CLI 层**才做三路独立检测：live 注册表心跳新鲜、Windows 独占句柄被占、`$DSH_SESSION_ID`
  相等，任一命中 → `SESSION_IS_RUNNING`（`src/live-target.js:70-209`）。注册表读不出来也算拒绝。

**最可能原因**：应用还开着（哪怕窗口最小化）；live 行心跳还新鲜；日志被别的进程独占；
或 `$DSH_SESSION_ID` 正好等于目标 id。这是 0.7.1 的漏洞补丁，不是误报。

**验证（一条）**：

```powershell
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object Id,StartTime,MainWindowTitle
```

再补 `Get-Content "$M\.longlive\live\<id>.json"` 看 `heartbeatAt`。

**修法**：彻底退出应用（不是关窗口），等 5 秒再确认进程为空；用 runner 的 `-DryRun` 先验证；
不要用 `allowLive` 绕过（它要 `confirm:"I-KNOW-THIS-CORRUPTS"`，且只该用于诊断）。

**停手**：进程已经为空、live 行也过期，仍报 running——说明独占句柄没释放或注册表损坏。
停止重试，重启机器/检查是否有残留进程，再不行就按 §6 的"剪完变空"备份恢复路径走，别强切。

---

## 6. 剪完变空 / 会话打不开

**症状**：截断后 `session_health.visibleMessages` 变成 0，或应用加载会话报错/空白。

**最可能原因**：
1. 切点落在唯一一段可见对话上（`planVisibleTruncation` 的"边界轮必须含用户消息"没满足，
   或 `insertArchiveCard` 被宿主拒绝）；
2. 恢复错了文件（拿 `.bak` 覆盖了另一个会话）；
3. 结构损坏（`VISIBLE_POST_VERIFY` / `VIOLATIONS>0`），但被忽略继续启动。

**验证（一条）**：

```powershell
# 本机示例路径；换成你机器上的 verify-truncation.mjs
& $NODE "<tools-dir>\ops\tools\verify-truncation.mjs" "<session.v4.jsonl.zstd>"
```

（`$NODE` 用应用自带 node；见 OPERATIONS §4。）`VIOLATIONS=0` 且 `shape: visible` 才算结构没问题；
再看 `session_health` 的 `visibleMessages`。

**修法**：
1. 停应用；
2. 把当前文件复制成 `.broken-<stamp>` 留证；
3. 用账本 `truncate-visible.json` 的 `backupPath`（或最新 `.bak-YYYYMMDD`）覆盖回去；
4. 再跑 `verify-truncation`，通过后才启动；
5. 若确认是 archive card 被拒，重试时加 `insertArchiveCard:false`——但**先恢复**，不要在坏的
   文件上再切一次。

**停手**：`verify-truncation` 报 V1/V2/V5/V7 违规时，不要再跑任何截断工具，也不要手改 zstd；
只做恢复和取证。连续两次恢复后仍 blank，说明备份也坏了——接受丢这段历史，不要伪造事件。

---

## 7. 重启后版本没换

**症状**：装完新 tgz、重启，`dsh plugin list` 或工具行为还是旧版。

**最可能原因**：
1. 应用没真正退出（旧进程还占着，新的没起来）；
2. 装到了别的 profile（`--profile` 不一致）；
3. `package.json` 改了但 `pnpm-lock.yaml` 没更新，`node_modules` 还是旧解析；
4. 从另一个安装路径启动（G: 与 C: 两个 app）。

**验证（一条）**：

```powershell
(Get-Content "$P\package.json" -Raw | Select-String '@jjh32456/dsh-longlive').Line;
(Get-Content "$P\node_modules\@jjh32456\dsh-longlive\package.json" -Raw | ConvertFrom-Json).version;
Get-Process 'DeepSeek Harness' | Select-Object Id,StartTime
```

三行应互相一致；进程 `StartTime` 必须晚于安装时间。

**修法**：停干净 → 确认 profile → 恢复三件套（`package.json`/`pnpm-lock.yaml`/`cordis.patch.yml`）
→ `pnpm install --prefer-offline` → 启动两次。只改 `package.json` 不动 lock，是最常见的"版本没换"。

**停手**：两次干净重启后 `node_modules` 里的版本仍不变，不要再 `pnpm install` 第三次；
检查是否有人在同一目录手工改过 `node_modules`，或 profile 目录被 junction 到别处。

---

## 8. 面板显示 0 卡

**症状**：六层视图里 semantic/episodic 全是 0，但记忆库明明有文件。

**最可能原因**：面板读的是**另一个**记忆根。面板默认 `~/.dsh/longlive-memory`
（`plugin/src/server.js:1231-1239`），**不继承**插件在 `cordis.patch.yml` 里的 `memoryRoot`；
也可能 `sessionsRoot` 指错，导致截断页空白。`scanCards` 只扫 `topics/` 和 `journal/`
（`src/memory/index.js` 的 `SCAN_DIRS`），`procedures/` 单独计数——所以"卡 0"通常不是数据没了。

**验证（一条）**：

```powershell
# 把 <memory-root> 换成你的记忆根
Test-Path "$env:USERPROFILE\.dsh\longlive-memory\topics"; (Get-ChildItem "<memory-root>\topics" -Filter *.md).Count
```

第一条 `False` 而第二条有数 → 面板读错根，实锤。

**修法**：面板配置里写 `memoryRoot: "<memory-root>"`（你的记忆根）、`sessionsRoot` 指向真实 sessions，
或用 `DSH_LONGLIVE_MEMORY_ROOT`；重启宿主。不要为了"让它有数"去复制卡片到默认目录。

**停手**：配好同一个根、重启后仍 0 卡——不要再动记忆文件；看面板 `/summary` 返回的
`health`/`scanTruncated`，必要时 `curl` 单接口确认是读取失败还是真空。

---

## 9. 看门进程不常驻

**症状**：希望有个进程一直盯着，自动触发截断；实际只有一次执行就退出。

**最可能原因**：**0.8.0 没有常驻守护**。`auto-truncate-run.ps1` 是一次性脚本（一次请求、一次执行、
退出）；插件不注册计划任务、不起 daemon、不写启动项（`scripts/*.ps1|mjs` 里没有
`Register-ScheduledTask`，也没有 `while($true)` 循环）。"看门进程不常驻"是**设计**，不是故障。

**验证（一条）**：

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -match 'longlive|truncate' } | Select-Object TaskName,State
```

预期为空。

**修法**：需要自动化就自己用外部调度器（计划任务/CI/人工）按节奏调用 runner；每次调用前确认
应用已退出、request 未过期。**不要**把 runner 改成常驻循环——它内部会 hard-kill 应用
（`auto-truncate-run.ps1:344-570`），常驻等于反复杀进程。

**停手**：如果你正打算"注册一个开机任务让它一直跑"，先停：这超出 0.8.0 的验证范围，
也会绕过 `dryrun→request` 门禁。先按 OPERATIONS §3 拿到三次真实执行证据，再谈自动化。

---

## 10. `request.json` 一直存在、不执行

**症状**：`auto-truncate.log` 有 `request-written`，但会话没变，request 文件一直在。

**最可能原因**：runner 没跑 / 退出码非 0 / 应用关不掉（exit 3）/ 校验失败已回滚（exit 5）/
request 是旧快照被 runner 判为越界（exit 2）。

**验证（一条）**：

```powershell
Get-Content "$M\.longlive\logs\auto-truncate-run.log" -Tail 30
```

找 `RESULT` 行与退出码：`0` 成功、`2` 请求非法、`3` 关不掉、`4` 切失败（已恢复）、
`5` 校验失败（已恢复）、`6` 重启失败（切保留、request 保留）。

**修法**：按退出码修：3 → 手工退出应用再跑；2 → 看 `SESSION_PATH_OUTSIDE_ROOT`/版本/字段；
4/5 → 先 `verify-truncation`，确认恢复成功，再决定是否重跑；6 → 应用没起来，先手工启动，
确认工具在，再清 request。

**停手**：同一 request 连续两次 exit 4/5，不要第三次重跑；先做 §6 的结构校验与恢复，
并检查请求里的 `plan` 快照是否已过期（`at` 早于会话最后写入）。

---

## 11. `verify-truncation` 退出码 1

**症状**：验收脚本报违规。

**最可能原因**：结构真的坏了（seq 断号、首事件形状不符、message 不在可见面、尾部截断、
头部 sessionId 不匹配），或拿错了文件（`.bak`、旧版本日志、非 v4 日志）。

**验证（一条）**：

```powershell
# 本机示例路径；换成你机器上的 verify-truncation.mjs
& $NODE "<tools-dir>\ops\tools\verify-truncation.mjs" "<file>" --json
```

**修法**：看 `violations[].check` 定位（V1 seq / V2 shape / V3 type / V4 turn-end / V5 messages /
V6 tail / V7 header）。结构问题只走备份恢复，不修补。给 `.bak` 跑会被 V7/形状识别出来——
换正确文件再跑。

**停手**：V1/V2/V5 任一违规 = 不要启动应用、不要再截断，先恢复。

---

## 12. 记忆工具报 `E_MEMORY_ROOT_*`

**症状**：`memory_*` 全挂，错误 `E_MEMORY_ROOT_UNSET` / `MISSING` / `NOT_DIR`。

**最可能原因**：显式根不存在（插件不会创建显式根）；`strictMemoryRoot` 打开但没配根；
盘符没挂载（移动硬盘/网络盘）。

**验证（一条）**：

```powershell
# 把 <memory-root> 换成你的记忆根
Test-Path "<memory-root>"; Get-ChildItem Env:DSH_LONGLIVE_MEMORY_ROOT,Env:DSH_MEM -ErrorAction SilentlyContinue
```

**修法**：建目录或改配置指向真实目录；确认环境变量没有覆盖配置（优先级见 CONFIG §3）；
`strictMemoryRoot` 只在确认根一定存在时开。

**停手**：目录存在、权限也正常，仍报错——不要反复改 `memoryRoot` 试；看启动告警/stderr 里的
实际解析结果（插件启动时会把解析到的根或告警写出来），必要时用 `scripts/longlive-doctor.mjs`
的只读模式核对 profile 与路径，别靠猜。
