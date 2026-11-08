# 1.6.0 迁移：`dsh-session-longlive` → `dsh-longlive`（久视）

> 适用对象：已经装过 `dsh-session-longlive@1.5.0`（或更早 1.4.0/1.5.0-rc）的 profile。
> 全新安装不需要看本文，直接按 [QUICKSTART.md](QUICKSTART.md) 装 1.6.0 即可。
>
> 一句话：**改名 + 普适化 + 设置页 + 三处安全默认收紧。** 装新包 → 从 profile 删掉旧包的
> 两处登记 → 保留 `- id: session-longlive` 的 config 覆盖 → 重启两次。面板不动；已有的
> `memoryRoot` / router / d2 / d6 配置继续生效，只有未显式写的默认值变保守（见 §6.8）。

## 1. 变的是什么，不变的是什么

| 项 | 1.5.0 | 1.6.0 |
| --- | --- | --- |
| 包名（`package.json#name`） | `dsh-session-longlive` | **`dsh-longlive`** |
| 显示名 | 会话长寿 / Session Longevity | **久视 / Longlive** |
| 版本 | 1.5.0 | **1.6.0** |
| loader entry id | `session-longlive` | **`session-longlive`（不变）** |
| 面板包 | `dsh-longlive-panel@0.2.4` | **不变，不用重装** |
| 22 个默认工具的名单 | — | **不变**（`worker_*` 默认不可用，见 §6.8） |
| 配置键（`memoryRoot`、`router*`、`d2`、`d6`…） | — | **不变** |
| 未显式设置的默认值 | `autoTruncate` 开/log；`routerRuntime` shadow；`worker_*` 可用 | **收紧为** dryrun/关、off、不可用（§6.8） |
| 记忆目录 `<DSH home>/longlive-memory` | — | **完全不变** |
| tgz | `dsh-session-longlive-1.5.0.tgz` | `dsh-longlive-1.6.0.tgz` |
| 安装后 node_modules 目录 | `node_modules/dsh-session-longlive` | `node_modules/dsh-longlive` |
| doctor 路径 | `…/node_modules/dsh-session-longlive/scripts/longlive-doctor.mjs` | `…/node_modules/dsh-longlive/scripts/longlive-doctor.mjs` |

**为什么 `- id: session-longlive` 不能改**：profile 的 `cordis.patch.yml` 用这个 id 做锚点覆盖
配置（`memoryRoot`、`routerEnabled`、`d2/d6` 等）。新包的 bundle 仍然用同一个 id 插入，
所以这条覆盖继续生效；把 id 一起改名反而会让你的全部自定义配置失效。

## 2. 怎么判断要不要手工迁移（只读检查）

> 下面一律用占位符：`<profile>` 是你的 profile 目录（默认 `%USERPROFILE%\.dsh\profiles\desktop`），
> `<tgz>` / `<面板 tgz>` 是你实际安装用的包路径。文中不出现任何具体机器的绝对路径。

- `<profile>\package.json` → `dsh.profile.bundles` 含 `"dsh-session-longlive"`；
- `package.json` → `dependencies` 含 `"dsh-session-longlive": "file:<tgz>"`；
- `package.json` → 面板依赖形如 `"dsh-longlive-panel": "file:<面板 tgz>"`（不动）；
- `<profile>\cordis.patch.yml` → **只有** `- id: session-longlive` 的 config 覆盖（没有 `name:` 行）；
  真正的 insert 条目来自旧包自带的 `cordis.patch.yml` bundle 层；
- `<profile>\node_modules\dsh-session-longlive\` 存在。

所以在真机上，「从 `cordis.patch.yml` 删旧包条目」通常是**空操作**：旧包的 insert 块不在你的
patch 里，而在包的 bundle 层里，随旧依赖一起消失。只有当初手工把包内 patch 抄进 profile
的情况，才会看到 `name: 'dsh-session-longlive'` 的 insert 块需要删。

## 3. 手工迁移步骤

### 第 0 步：备份

```powershell
$P  = "$env:USERPROFILE\.dsh\profiles\desktop"
$TS = Get-Date -Format 'yyyyMMdd-HHmmss'
$B  = "$P\_migration-1.6.0-$TS"
New-Item -ItemType Directory -Path $B | Out-Null
Copy-Item "$P\package.json"        "$B\package.json"
Copy-Item "$P\cordis.patch.yml"    "$B\cordis.patch.yml"
Copy-Item "$P\pnpm-lock.yaml"      "$B\pnpm-lock.yaml" -ErrorAction SilentlyContinue
```

### 第 1 步：安装新包

```powershell
$DSH = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $DSH plugin --profile desktop add "file:<你的发布目录>/dsh-longlive-1.6.0.tgz"
```

`plugin add` 会把 `dsh-longlive` 写进 `dsh.profile.bundles` 和 `dependencies`，并把包装进
`node_modules/dsh-longlive`。

### 第 2 步：移除旧包的两处登记

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

1. `dsh.profile.bundles` 数组里删掉 `"dsh-session-longlive",` 这一行；
2. `dependencies` 里删掉
   `"dsh-session-longlive": "file:<你的发布目录>/dsh-session-longlive-1.5.0.tgz",`
   这一行。

只删这两处，**不要**动 `dependencies` 里的 `dsh-longlive-panel`，也**不要**删
`cordis.patch.yml` 里的 `- id: session-longlive`。

如果 `dsh plugin remove dsh-session-longlive` 在你的宿主版本上可用，用它也可以达到同样效果；
用之前先备份，并确认它没有把 `- id: session-longlive` 的 config 覆盖一起删掉。

### 第 3 步：清理 `cordis.patch.yml`（通常无事可做）

只在下面这种情况才需要动手：你的 profile `cordis.patch.yml` 里有形如

```yaml
- insert:
    - id: session-longlive
      name: 'dsh-session-longlive'
      ...
```

的手工 insert 块。删掉整块 `- insert:`；**保留**独立的：

```yaml
- id: session-longlive
  config:
    memoryRoot: '<你的记忆根>'
    ...
```

真机现状没有这个 insert 块（见 §2），所以这一步跳过。

### 第 4 步：旧安装目录（可选）

```powershell
Rename-Item "$P\node_modules\dsh-session-longlive" "dsh-session-longlive.removed-$TS"
```

改名而不是删除：回滚时改回来即可。确认稳定后再删。

`pnpm-lock.yaml` 里旧条目会残留到下一次 `pnpm install`；不影响宿主加载，脚本不改它。

### 第 5 步：校验

```powershell
& $DSH plugin --profile desktop list --depth 0          # 应显示 dsh-longlive@1.6.0，且没有 dsh-session-longlive
& $DSH --profile desktop --dump-config | Select-String -Pattern 'session-longlive' -Context 1,3
$NODE = '<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $NODE "$P\node_modules\dsh-longlive\scripts\longlive-doctor.mjs" --profile desktop
```

期望：`list` 只有新包；`dump-config` 里 `- id: session-longlive` 的配置仍是你的值
（你写过的 `memoryRoot` 等）；doctor 退出码 0（或仅因 engram 缺失为 1）。

### 第 6 步：重启两次

完全退出宿主，再启动。第一次是准备性加载，第二次确认没有
`did not activate`、工具数为 22（开 D6 时另加 `tool_search`）。

## 4. 脚本迁移（可选；脚本在源码仓，不随 npm 包发布）

脚本：1.6.0 历史迁移脚本 `tools/migrate.ps1`（已移除；发布包内不含；装包后想稳一点就按 §3 手工走）。1.8.0 迁移请用 `scripts/migrate-180.mjs`。

```powershell
$MIGRATE = '<源码仓>\tools\migrate.ps1'

# 1) 预演：只读，不写任何文件
powershell -NoProfile -ExecutionPolicy Bypass -File $MIGRATE -DryRun

# 2) 真跑（显式 -Apply 才写）
powershell -NoProfile -ExecutionPolicy Bypass -File $MIGRATE `
  -Apply -Tgz "file:<你的发布目录>/dsh-longlive-1.6.0.tgz"

# 3) 回滚到迁移前
powershell -NoProfile -ExecutionPolicy Bypass -File $MIGRATE `
  -Rollback -BackupDir "$env:USERPROFILE\.dsh\profiles\desktop\_migration-1.6.0-<时间戳>"
```

脚本行为：

- 默认 `-DryRun`：只读校验 tgz/sha256、profile 结构，打印将要做的修改，退出码 0；
- `-Apply`：备份 → `dsh plugin add` 装新包 → 文本删除 `package.json` 里旧包在
  `bundles`/`dependencies` 的两处登记 → 删除 `cordis.patch.yml` 里含旧包名的整块顶层 item
  （即旧包自带的 `- insert:` 块；独立的 `- id: session-longlive` 不受影响）→ 旧 node_modules
  改名 → 校验 JSON 可解析、旧名不再出现、`- id: session-longlive` 数量不变；
- 任一步失败自动回滚（恢复备份文件、把新目录改名移出、旧目录改回），并给出退出码；
- 退出码：`0` 成功/预演通过；`1` 预检失败（未改任何东西）；`2` 应用失败但回滚成功；
  `3` 应用失败且回滚失败（需人工按 §6 处理）；`4` 回滚失败。

常用参数：`-Tgz <tgz>`（默认 `<脚本目录>\longlive\dist\dsh-longlive-1.6.0.tgz`）、
`-ProfileDir <profile>`（默认 `%USERPROFILE%\.dsh\profiles\desktop`）、
`-DshCli <dsh.cmd>`（默认 `$env:DSH_CLI` 或 PATH 里的 `dsh`）、`-BackupDir <目录>`。

> 验证记录（2026-11-06）：真机只跑过 `-DryRun`（exit 0，未写任何文件）；`-Apply` /
> `-Rollback` / 安装失败自动回滚 / patch 里带旧 insert 块四条路径，都在复制出来的假 profile
> 上跑通（成功 0、失败回滚 2、回滚后恢复原文件）。真机执行前请先自己跑一次 `-DryRun`。

脚本不重启宿主、不碰面板、不删除任何备份；`-Apply` 完成后仍需按第 6 步手动重启两次。

## 5. 回滚

### 5.1 脚本回滚

```powershell
# 历史示例（1.6.0 脚本已移除）\nmigrate.ps1 -Rollback -BackupDir <备份目录>
```

恢复 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml`，把
`node_modules/dsh-session-longlive` 改名回来，把 `node_modules/dsh-longlive` 移出。重启两次。

### 5.2 手工回滚

1. 备份目录里取回 `package.json` 与 `cordis.patch.yml`（迁移前的版本）；
2. `dsh plugin --profile desktop add "file:.../dsh-session-longlive-1.5.0.tgz"`；
3. 确认 `dependencies` 里旧条目恢复、`bundles` 里旧包在列、`dsh-longlive` 条目删掉；
4. 旧 node_modules 目录改名回来，新目录移出；
5. 重启两次。

### 5.3 只回滚代码、不回滚配置

`- id: session-longlive` 的 config 是名字无关的，两版通用；只换包时不需要恢复配置文件。

## 6. 风险与注意

1. **id 锚点**：任何情况下都不要把 `- id: session-longlive` 改成 `dsh-longlive`。改了会丢掉
   `memoryRoot`/router/d2/d6 等全部用户配置。
2. **`dsh-longlive-panel@0.2.4` 不要卸**：面板按工具名和 memoryRoot 工作，不依赖本包名；
   迁移期间卸面板只会多一次重启。
3. **两版同时存在**：新包加了 insert、旧包还没从 `bundles` 删掉时，会出现两个同 id 的 insert
   （loader 可能报 duplicate id / 只用其中一个）。所以第 2 步必须在重启前完成。
4. **`pnpm-lock.yaml` 残留**：脚本不碰锁文件；若之后运行 `pnpm install`，旧条目会被清掉。
   期间不要用 `pnpm prune` 之类会重写 node_modules 的命令。
5. **设置页缓存**：宿主运行中改 `package.json` 不会热更新；必须完全退出再启动两次。
6. **旧 doctor 命令**：升级后 `node_modules/dsh-session-longlive/scripts/longlive-doctor.mjs`
   不存在了，把命令里的路径换成 `node_modules/dsh-longlive/...`（见 §1 表）。
7. **回滚 tgz 仍在**：`dsh-session-longlive-1.5.0.tgz` 留在原发布目录，别删；它是回滚包。
8. **默认值变了，逻辑没有变坏**：1.6.0 与 1.5.0 的工具语义、参数、配置键相同；只有三处
   未显式配置时的默认值收紧——`autoTruncate` 改为 `enabled:false` / `mode:'dryrun'`，
   `routerRuntime` 改为 `off`，`worker_spawn/status/kill` 需 `workers.enabled:true` 才可用。
   另外记忆根默认统一为 `<DSH home>/longlive-memory`（原来开机卡/召回回落到 `~/dsh-memory`）；
   显式 `memoryRoot` 的 profile 行为不变。要保留 1.5.0 的旧行为，显式写
   `autoTruncate: { enabled:true, mode:log }`、`routerRuntime: shadow`、`workers: { enabled:true }`。
   如果迁移后行为不同且你没写这些键，那是本版预期的安全默认，不是装错包。
