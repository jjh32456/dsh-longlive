# 安装 · @jjh32456/dsh-longlive-panel

> **本机现状（2026-11-06 21:30）：0.2.5 已装且已发布 npm；本包 0.2.6 = 六层视图活体行重排 + 已归档折叠。**
> `desktop` profile 的 `package.json` 里
> `@jjh32456/dsh-longlive-panel` 同时在 `bundles` 与 `dependencies`（`file:C:/dshops/batch/release-164/out/jjh32456-dsh-longlive-panel-0.2.5.tgz`），
> `node_modules/@jjh32456/dsh-longlive-panel` 现在是 0.2.5 的包壳 + 0.2.6 的 `src/client.js`、`src/server.js`（热更，客户端已即时生效；正式装机用 0.2.6 的 tgz，重启一次）。
> 下面既写当前状态，也保留从零安装、验证、卸载的步骤；**改代码/配置后仍需重启宿主**。

面板是**只读**的：八个 GET 路由（六个数据页签取数 + `/cards`、`/card` 的卡片正文），不写文件、
不建目录、不改 `memory-state.json`、不碰会话日志。装不装它都不影响宿主里已有的记忆数据。

---

## 0. 它是什么

| 项 | 值 |
|---|---|
| 包名 | `@jjh32456/dsh-longlive-panel` |
| 版本 | __DSH_PLUGIN_VERSION__ |
| 类型 | Cordis 插件（宿主侧 `webServer` 路由 + Web 客户端 bundle） |
| 入口 | `src/server.js`（宿主）、`src/client.js`（浏览器） |
| 路由基址 | `/api/longlive-panel` |
| Node | `>= 22.13.0` |
| 面板入口 | 侧栏「潜望镜」→ 整页七个页签 |

七个页签（按面板从左到右）：**六层视图**（先看这里，确认自己接上了：六层记忆 + 活体心跳；
活体行按 运行中 → 空闲 → 已归档 排序，已归档默认折叠）、
**过滤器决策**（`.longlive/filter/decisions-*.jsonl`）、
**影子记录**（`router-runtime.jsonl`，根目录与 `.longlive/` 两处合并）、
**常驻 Router**（`.longlive/router/` 的 status / board / proposals，只读窗口）、
**本轮想起**（`.longlive/recall-log.jsonl` 的召回流水）、
**截断记录**（维护页：`truncate.json` + `truncate-visible.json` + 备份，会话日志被剪短的账）、
**使用说明**（纯静态的图文说明，不发请求、不读数据）。

常驻 Router 没开启时，这一页显示「未启用」并给一句说明，不报错；开启后只读展示心跳、
共享大脑摘要、提案队列与风险告警，不写记忆、不批准提案、不执行写入。
过滤器与影子记录在 0.2.0 起就接真实数据（`implemented: true`）；只有请求失败时才回退到
样例数据并挂「样例」标，未启用或没有记录时显示空态，不拿样例顶班。

## 1. 前置

- DSH 的 **web** profile（`webServer` 服务只在 web 形态存在；非 web profile 里 `inject: ['webServer']` 不会激活）。
- Node `>= 22.13.0`（manifest `engines.node`）。
- 认识这两个路径（默认值，可用配置覆盖）：

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `memoryRoot` | `~/.dsh/longlive-memory` | 与 longlive 本体一致；默认**不看**任何本机私有路径（如 `H:\dsh-memory`）。本机要用那个库，按第 4 节显式配置；也可用环境变量 `DSH_LONGLIVE_MEMORY_ROOT` / `DSH_MEM` 覆盖 |
| `sessionsRoot` | `C:\Users\<你>\.dsh\sessions` | 只读 `<workspace>/<sessionId>/{truncate,truncate-visible,backups}.json` 与 `*.bak*` 的 stat |

默认值跟着当前用户主目录走，**别的机器/系统装完不需要改任何路径**。`H:\dsh-memory`
只是本机的显式配置示例，不是默认判断的一部分。

路径 jail：`card/:id` 只接受白名单内的相对路径，`..`、绝对路径、`.credentials*`、
`*.key|pem|pfx|p12|p8`、`node_modules`、`*.jsonl.zstd` 一律拒绝。

## 2. 安装（本机 0.2.4 已装；下面是复核 / 换机 / 重装步骤）

以 `desktop` profile 为例。本机 0.2.4 的安装来源是
`C:\dshops\install-1.6.3\packages\jjh32456-dsh-longlive-panel-0.2.4.tgz`，装完已重启宿主、`GET /summary` 返回 `version:"0.2.4"`。
从零安装用同一套命令（把 tgz 换成你要装的版本）：

```powershell
# 1) 装进 profile（dsh plugin 把参数原样转给 profile 目录里的 pnpm）
dsh plugin --profile desktop add .\@jjh32456/dsh-longlive-panel-__DSH_PLUGIN_VERSION__.tgz

# 2) 把包名加进 profile 的 bundle 列表
#    文件：C:\Users\Administrator\.dsh\profiles\desktop\package.json
#    "dsh": { "profile": { "bundles": [ ... , "@jjh32456/dsh-longlive-panel" ] } }
```

`dsh plugin` 的语义（来自 `dsh plugin --help`）：把剩余参数**转发给 profile 目录里的 pnpm**，
所以 `add` / `remove` / `why` 都可用；`--profile <name>` 指定 profile。

第 2 步不能省：包里的 `dsh.bundle.patch`（`cordis.patch.yml`）只有在包被当作 bundle 加载时才生效。
`cordis.patch.yml` 的内容是一条 insert，把 `id: dsh-longlive-panel` 挂进 composition；
路径不写死，跟着包走。

## 3. 重启并验证

首次安装必须**重启宿主**（进程启动时解析 bundle 列表）；已经装好之后改本包的代码才可能热更新。

重启后：

1. 侧栏出现「潜望镜」图标（`order: 42` 是占位，可能要与别的插件调顺序）。
2. 点开是整页七个页签；页头 `接口已接通` 是实时数据，`样例数据` 表示接口没通。
3. 命令行核对（**端口以宿主当前 Web GUI 为准**；本机 2026-11-06 是 `6705`，不是 5978）：

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:6705/api/longlive-panel/summary
curl.exe -s http://127.0.0.1:6705/api/longlive-panel/summary | ConvertFrom-Json | Select-Object root,totals
curl.exe -s -o NUL -w "%{http_code}`n" "http://127.0.0.1:6705/api/longlive-panel/card/topics%2Fpeople.md"
```

预期：`200`；`totals.cards` 与本机配置的 `memoryRoot`（默认 `~/.dsh/longlive-memory`，
本机若按第 4 节配置则是 `H:\dsh-memory`）下 `topics\*.md` 的数量一致；
未知路径 `404`、非 GET `405`、越界路径 `400 E_BAD_QUERY`。

七个页签的接口（`server.js:2089` 的 `ROUTES` 共八个，含卡片正文两个）：

| 页签 | 接口 |
|---|---|
| 六层视图 | `GET /summary` |
| 过滤器决策 | `GET /filter?limit=20` |
| 影子记录 | `GET /shadow?limit=20` |
| 常驻 Router | `GET /router` |
| 本轮想起 | `GET /recall?limit=20` |
| 截断记录 | `GET /truncations?limit=20`（合并 `truncate.json` 与 `truncate-visible.json`） |
| 使用说明 | 无（纯静态，浏览器本地渲染） |

另有 `GET /cards?layer=semantic&limit=20&cursor=&q=` 与 `GET /card/<urlencoded path>` 供卡片正文用。

## 4. 显式配置（本机要把面板指到 `H:\dsh-memory` 时）

默认**不需要任何配置**：`memoryRoot` 走标准位置 `~/.dsh/longlive-memory`，与 longlive 本体一致。
下面这段只是**本机示例**，写在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-longlive-panel
  name: '@jjh32456/dsh-longlive-panel'
  config:
    memoryRoot: "H:/dsh-memory"
    sessionsRoot: "C:/Users/Administrator/.dsh/sessions"
```

YAML 里用正斜杠（`H:/dsh-memory`）就不用转义反斜杠，Windows 上 Node 同样认。
**别的机器 / 别的系统不用写这一段**：删掉它即回到 `~/.dsh/longlive-memory`，
路径跟着各自的主目录走，面板不会去探测或猜测 H 盘。

`memoryRoot` 的优先级：**显式 config > `DSH_LONGLIVE_MEMORY_ROOT` / `DSH_MEM` > `~/.dsh/longlive-memory`**。

## 5. 卸载 / 回滚

```powershell
# 1) 从 bundles 列表里删掉 "@jjh32456/dsh-longlive-panel"
dsh plugin --profile desktop remove @jjh32456/dsh-longlive-panel
# 2) 重启宿主
```

面板本身不写任何数据，所以卸载后**没有残留要清**；`H:\dsh-memory` 与会话目录原样不动。

## 6. 本体自测（不启动宿主也能跑）

```powershell
$node = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node .\self-test.mjs       # 58 PASS · 0 FAIL（造 .fixture，跑完自动删）
& $node .\client-smoke.mjs    # 25 PASS · 0 FAIL（基线）+ 页签 34 PASS + 滚动 2 PASS + 活体排序/折叠 10 PASS
& $node --test gap-fixes.test.mjs  # 6 PASS · 0 FAIL（截断记录合并 / shadowRecords 口径回归）
```

`self-test.mjs` 不启 HTTP 服务，直接调 `createPanel()` 的 handler 断言八个路由的结构、
分页夹取、路径越界、1 MiB 上限、ETag/304、405/404，以及常驻 Router 的降级、
字段透传、提案排序和「正文/理由/baseSha 不出门」。
`client-smoke.mjs` 用假 `__ModuleLoader__` + 假 React 加载 `src/client.js`，
验证注册了两个 slot，并用真实 server 数据把六个数据页签各渲染一遍（Router 页真实数据）；
随后单独断言第七页签「使用说明」的页签数=7、帮助文案含共享大脑段与「绝不」、
页面含 dryrun/request/on 且不含禁用词。
`gap-fixes.test.mjs` 是 2026-11-06 真机验收缺口（G1/G2）的回归闸：多会话/多条目/旧格式
截断账本、`?session=` 过滤，以及 `summary.totals.shadowRecords` 必须等于 `/shadow`
的 `page.total`（两处 router-runtime.jsonl 相加）。

## 7. 已知限制

- 过滤器 / 影子两个数据源**已实装**（`implemented: true`）：`/filter` 读
  `.longlive/filter/decisions-*.jsonl` 的最新一份，`/shadow` 合并根目录与 `.longlive/`
  两处 `router-runtime.jsonl` 再加过滤器决策；只有请求失败才回退样例。
- 会话日志本体（`session.v4.jsonl.zstd`）**永不**通过 HTTP 提供；截断页只给两份账本的
  元数据（字节数、事件/消息数、备份与归档文件名、校验值），不给正文。
- 截断记录里 `truncate-visible.json` 的行按「可见对话截断」标出，事件列显示消息数；
  两份账本合并后按时间倒序，`kinds.ledger`/`kinds.visible` 给出各自条数。
- 截断扫描按 `SESSION_WALK_BUDGET = 1024` 个会话目录封顶（本机 2026-11-06 实测 603 个），
  超出时响应里 `scanTruncated: true`，不静默截断。
