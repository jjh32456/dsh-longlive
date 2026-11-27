# 安装 · @jjh32456/dsh-longlive-panel

> 第三方通用版（1.8.2）。本文只写可复制的通用命令，不含任何本机绝对路径或用户名。
> 面板依赖 longlive；两件按同一条发布线（1.8.x）安装。1.8.2 跟随 longlive 1.8.12 的包名改名
> （`@jjh32456/longlive`），并上屏 1.8.7–1.8.12 的新功能：记忆网络、蒸馏（canonical/historical）、
> 强制召回/链路学习/归档兜底、24h 活动窗、自动截断新阈值口径。

## 0. 它是什么

| 项 | 值 |
|---|---|
| 包名 | `@jjh32456/dsh-longlive-panel` |
| 版本 | 1.8.2 |
| 类型 | Cordis 插件（宿主侧 `webServer` 路由 + Web 客户端 bundle） |
| 入口 | `src/server.js`（宿主）、`src/client.js`（浏览器）、`src/extras.js`（1.8.2 只读扩展视图） |
| 路由基址 | `/api/longlive-panel`（旧只读面 + 1.8.2 新增 network/distill/system）；`/api/longlive-panel/v2/*`（1.8.0 全视图） |
| Node | `>= 22.13.0`（运行时用宿主提供的 Node：`process.execPath` / `DSH_NODE`；不依赖固定安装路径） |
| 面板入口 | 侧栏「潜望镜」：旧 9 页签（含 1.8.2 网络/蒸馏）+ 1.8.0 视图（记忆/回忆/遗忘/断言-证据/冲突/审计/角色） |
| summary 契约 | `panelApiVersion=2`（1.8.1 起）；新增可选只读 `autoProcedure` 块 |
| 依赖名 | `@jjh32456/longlive`（1.8.12 起的新包名；旧名 `@jjh32456/dsh-longlive` 仅作兜底兼容） |

**定位**：只读展示为主；判定动作严格走 longlive 的 M2-G 受控动作面（18 个契约动作名，宿主签发一次性能力令牌）。
面板本身不落盘凭据、不直连 SQLite、不写记忆正文。

## 1. 前置

- 一个 **web 形态**的 DSH profile（`webServer` 服务只在 web 形态存在；非 web profile 不会激活 `inject: ['webServer']`）。
- Node `>= 22.13.0`：运行时由宿主提供（`process.execPath` 或 `DSH_NODE` 显式注入）；`dsh` 命令与自测脚本用它执行，不写死安装路径。
- longlive 1.8.12（npm 新包名 `@jjh32456/longlive`）与面板 1.8.2 同时安装；面板通过 peerDependencies
  `@jjh32456/longlive ^1.8.12` 声明对 longlive 的依赖（旧包名已删除，不能再装）。

## 2. 安装（第三方用户步骤）

在宿主的 web profile 下，用同一套 DSH CLI 安装两件（版本号以安装集清单为准）：

```bash
# 1) longlive（核心 + 面板后端 API + answer-guard + autoProcedure 数据面）
dsh plugin add @jjh32456/longlive@1.8.12

# 2) panel（本包）
dsh plugin add @jjh32456/dsh-longlive-panel@1.8.2
```

- 两件保持同一条发布线（1.8.x）；混装会返回 `E_VERSION_SET`（契约 §16.6）。
- 安装后重启一次宿主（插件在启动时加载）。
- 全新 `$DSH_HOME`（第一次装 DSH）场景：上面的命令会自动创建 `$DSH_HOME` 下的 profile 目录；
  不需要手动拷任何文件。默认 `memoryRoot` = `$DSH_HOME/longlive-memory`，`sessionsRoot` = `$DSH_HOME/sessions`。
- 默认 **ON**（面板装好即可用）；不上面板时 longlive 核心照常工作。
- **kill switch**：
  - 关面板 API/动作面：longlive 配置 `memoryV2.enabled: false`（默认关；为 true 时才注册 27 条只读路由与动作面）。
  - 卸载面板：`dsh plugin remove @jjh32456/dsh-longlive-panel`；卸载后 `/api/longlive*` 返回 401 `E_PANEL_ABSENT`，长活核心不受影响，动作队列进入 `paused`（须人工确认恢复）。

## 3. 配置（可选，全部从宿主注入/环境变量解析，面板不含默认真实路径）

面板 server 的配置项（`cordis.patch.yml` 的插件 config 或宿主注入）：

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `memoryRoot` | `$DSH_HOME/longlive-memory` | 与 longlive 一致；也可用环境变量 `DSH_LONGLIVE_MEMORY_ROOT` / `DSH_MEM` 覆盖 |
| `sessionsRoot` | `$DSH_HOME/sessions` | 只读会话目录（截断记录/备份 stat） |
| `longliveApi` | 宿主注入 | 宿主打开 longlive 时注入的 `createPanelApi()` 实例（推荐接线；面板据此走内部通道，不自建凭据） |
| `v2RequireOrigin` | `true` | 动作 POST 强制同源 Origin + 每面板随机 CSRF；测试环境才可显式关 |

示例（通用占位，按你的 profile 实际路径替换；Windows 用正斜杠可免转义）：

```yaml
- id: session-longlive-panel
  config:
    memoryRoot: "$DSH_HOME/longlive-memory"   # 由宿主展开，或直接写你自己的路径
    sessionsRoot: "$DSH_HOME/sessions"
```

**不要**在配置里写别人的家目录；插件在自己的机器上没有默认私有路径。

## 4. 验证

1. 重启宿主后打开 Web UI，侧栏出现「潜望镜」。
2. 页头显示「接口已接通」与版本号。
3. 路由自检（把 `<host>` 换成你的 Web UI 地址）：
   - `GET <host>/api/longlive-panel/summary` → 200 JSON（旧只读面）；响应含 `panelApiVersion: 2`
     与 `autoProcedure`（longlive 未开启自动经验时为 `{ "enabled": false }`）
   - `GET <host>/api/longlive-panel/network?limit=5` → 200，含 `edges`（边总数/类型分布/明细）与 `links`（词→卡链路）
   - `GET <host>/api/longlive-panel/distill` → 200，含 `cards.byLifecycle`（canonical/historical）与
     `migrations`（迁移运行记录，只给相对路径与计数）
   - `GET <host>/api/longlive-panel/system` → 200，含 `autoTruncate`（1.8.10 阈值口径）、
     `recallForced`（1.8.8 强制召回/链路/归档兜底）、`activityWindow`（1.8.8 近 24h 活动窗）
   - `GET <host>/api/longlive-panel/v2/state` → 200，含 `routes`（27 条）、`actions`（18 个）、`csrfToken`（per-session）
4. 每个视图在无数据时显示空态（不是样例、不是崩溃）；longlive 未开启 `memoryV2` 时显示「未实装」。
5. 只读面自检：summary 前后 `.longlive/` 文件不应有新增/改动；默认关时面板不读
   `.longlive/staging/auto-cards/procedures/`（staging 里的候选是 longlive 的产物，面板只读 sidecar）。

## 5. 测试（用宿主运行时；在包根目录执行）

```bash
node self-test.mjs                  # 面板 server 单测（88 项）
node --test gap-fixes.test.mjs      # 回归测试（15 项）
node --test auto-procedure.test.mjs # summary.autoProcedure 只读块（15 项；含默认关零 staging IO）
node client-smoke.mjs               # 客户端渲染 smoke（120 项）
node clean-env-smoke.mjs            # 干净环境冒烟：临时 DSH_HOME 起面板→连 longlive→27/18 路由（15 项）
node activation-probe.mjs           # 安装态激活探针（22 项；临时 DSH_HOME + 宿主签名模拟）
```

`clean-env-smoke.mjs` / `activation-probe.mjs` 只用临时目录，不碰真实 `$DSH_HOME`、不装插件、不联网；
找不到 longlive API 时显式 SKIP（不冒充通过）。隔离源树里用环境变量 `DSH_LONGLIVE_SRC=<longlive 包根>`
指向 longlive 源树；`auto-procedure.test.mjs` 的 1.8.0 逐字节基线用 `PANEL_180_SRC=<1.8.0 面板包根>`。

1.8.2 新增的只读扩展视图测试放在面板仓库 `tests/`（fixture + extras + 路由 + 客户端渲染 smoke，
`node --test tests/*.test.mjs`）：全部使用临时 fixture 目录，不碰真实记忆库。

### 5.1 Gate-2 面板门槛（维护者；longlive 仓库内执行）

```bash
# 1) 中心常量精确期望（27 路由 / 18 动作；未达标 FAIL，禁止 >= 下限假绿）
node --test test/panel-readonly.test.mjs test/panel-actions.test.mjs test/recall-v2/gov-routes-actions.test.mjs
# 期望：25 pass / 0 fail、exit 0（27/27 routes、18/18 actions、CAS/权限/集合相等断言）
# 2) A7 脚本级 id 验证（读实际 READONLY_ROUTES/ROUTE_ID_BY_NAME + ACTION_NAMES）
node scripts/verify-ids.mjs
# 期望：EXIT 0，输出 `verify-ids: OK · routes 27/27 · actions 18/18 · ids 1..27 · id-map 27/27`
# 负例（必须 EXIT≠0 且输出差异）：node scripts/verify-ids.mjs --expect-routes 26
# 3) A7 面板真实运行证据（临时 DSH_HOME；断言 27 只读路由 / 18 动作 / 三态）
node activation-probe.mjs
# 期望：status=activated、22/22 checks、fiveHundreds=0、EXIT 0
# （1.8.1 追加 summary.panelApiVersion=2 与 autoProcedure 默认关两条检查；隔离源树需 DSH_LONGLIVE_SRC）
# 附：面板包自身
node self-test.mjs && node --test gap-fixes.test.mjs && node --test auto-procedure.test.mjs && node client-smoke.mjs && node clean-env-smoke.mjs
```

> **Gate-2 三组全绿 = ① `node --test` 25/25（27/18 精确）+ ② `node scripts/verify-ids.mjs` EXIT 0（负例 `--expect-routes 26` / `--expect-actions 17` 必须 EXIT≠0）+ ③ `node activation-probe.mjs` EXIT 0（status=activated、22/22、fiveHundreds=0）。**

## 6. 卸载与残留

- `dsh plugin remove @jjh32456/dsh-longlive-panel`，重启宿主。
- 面板不写任何数据、不建目录，卸载后无残留；记忆库与会话目录原样不动。
- 面板包完整性：宿主包管理器在**安装/更新时**用进程内存 key 写 `.integrity/manifest.sha256`
  （npm tarball 不含该目录）；加载+动作前校验；不匹配 → 动作全禁用 + 401 `E_PANEL_INTEGRITY`，只读展示保留。

## 7. 安全边界（读者须知）

- 面板 server 不是信任边界：凭据只在长活宿主进程内存，能力令牌按请求现签、短 TTL、一次性 nonce，不落盘、不进浏览器；浏览器只有同源页面可读的 per-session CSRF。
- 面板不直连 SQLite、不读 `.longlive/` 白名单之外的文件；已知只读来源：
  summary 的候选 sidecar 目录 `.longlive/staging/auto-cards/procedures/*.meta.json`（只认普通文件、slug 白名单、
  ≤20 条/单文件 ≤256 KiB/总 ≤1 MiB、非递归、拒符号链接；候选 `.md` 正文永不读取）；
  1.8.2 的 network/distill/system 读取 `.longlive/recall/edges.jsonl`、`links.jsonl`、`links-audit.jsonl`、
  `recall-log.jsonl`（只读尾部 ≤2 MiB / ≤5000 行）、`board/activity*.jsonl`、`auto-truncate-status.json`、
  `lifecycle-migrations/*/manifest.json` 与卡 frontmatter——全部只读、绝对路径脱敏、坏行计数不崩。
  新增字段必须先有生产者。
- 动作面只允许 longlive G7 的 18 个契约动作名；panel 侧不发明动作名。
