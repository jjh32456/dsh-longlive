# 变更记录

本文件从 0.7.6 开始记录；更早的版本没有随包维护变更日志（0.7.5 及以前的 tarball 里没有
CHANGELOG）。

## 1.6.5 — 2026-11-06

**热截断热修复：被宿主重启中断过的会话不再永久失去自动切刀。**

根因：`selectCutPlan` 把「closed-but-not-completed」（有 `turn/end`，但 reason 为
aborted / interrupted / truncated）的轮次当成不可跨越的屏障。一旦这类轮次落在保留窗口
之前，计划会一直返回 null，自动热截断从此静默失效——实测上下文涨到 50 万 tokens 也不再
切一刀（1.6.4 的 300k 闸门本身没问题，是计划永远为空）。

1.6.5 改为：这类轮次继续**保留不切**，但计划从它**之后**继续找连续的已完成轮，不再返回
null；另外修了候选段**首轮内部的 system/message**（宿主中途注入）把段截成空的问题——现在
该轮原地保留、段从它之后开始。新增 H3 / H3b 回归测试覆盖这两个场景。
`node test/run.mjs` / `node test/run-rc.mjs` 全绿。

## 1.6.4 — 2026-11-06

**热截断参数收尾 + D6 重启兼容 + 可移植性收口。** 1.6.3-rc.2 的默认窗口在长对话里几乎
每轮切一刀，每次切刀都让前缀缓存失效一次；本版把阈值拉到 300k、保留 4 轮，并让自动切在
两条路径上统一受阈值门控。同批修复 D6 重启后首轮冻结（G3），并把发布文档/测试夹具里的
构建机路径清干净。全量测试 **361 passed / 0 failed / 4 skipped**（`test/run.mjs`）与
**1100 passed / 0 failed / 9 skipped**（`test/run-rc.mjs`），skip 全部是环境门控。

### 热截断（成本）

- 默认触发阈值 `autoMinTokens` 30000 → **300000**：估算上下文达到 300k tokens 才自动剪；
- 自动切统一受该阈值门控：`mode=cut` 的每步压力检查也只在达到阈值时动手（此前它不看阈值，
  每完成一轮就切一刀）；手动 `/compact` 与请求溢出恢复不受此限；
- 默认保留 `retainTurns` 6 → **4**：切完只留最近 4 轮完成对话（`retainTokens: 8000` 不变）；
- 成本理由：每次切刀都会改写上下文前缀，使模型的前缀缓存失效，下一轮剩余上下文按全价
  重算。阈值 300k + 保留 4 轮后，切刀间隔从「每轮一刀」拉长到「十几轮一刀」，缓存命中率
  上去、账单下来；
- 兼容：显式写 `retainTurns: 6` / `autoMinTokens: 30000` 的旧配置继续按显式值生效，不需要
  迁移；
- 两个值都可在 profile 的 `- id: compaction-hot-truncate` 行覆盖（`docs/CONFIG.md` §1.4a），
  改完重启宿主生效；
- 新增/扩写用例 H30–H34：299k 不切·300k 切（`auto` 与压力两条路径）、保留 4 轮、一次 cut
  多轮归档、显式旧值兼容。

### 宿主兼容（D6 / G3）

- D6 的 `agent/inbox/claimed` 不再用 `if (turn > 1) return` 跳过重启恢复的会话：进程内首个
  真实用户消息（即使是重启后的 turn N>1）上冻结一次工具面，`tool_search` 不再永久失效；
- `test/d6.test.mjs` 补回 G3 回归用例（重启后首轮冻结）。

### 可移植性

- 默认记忆根仍是 `<DSH home>/longlive-memory`，`DSH_IDENTITY_MEMORY_ROOT →
  DSH_LONGLIVE_MEMORY_ROOT → DSH_MEM` 一条解析链贯穿记忆工具、开机卡、自动召回与 Router；
- 发布文档去掉构建机路径：`docs/MIGRATION-1.6.0.md` 一律用 `<profile>` / `<tgz>` /
  `<你的记忆根>` 占位符，`docs/CONCEPTS.md` 的 Router 记录路径补上 `.longlive/`（与
  `resolveStatePath()` 一致）；
- 测试夹具的 `memoryRoot` 从固定的 H 盘路径改为中性的 `D:/memory-root`，测试不再依赖真机
  盘符。

### 文档与配套面板

- 版本面统一到 **1.6.4**：`package.json`、`README.md`、`README.en.md`、`QUICKSTART.md`、
  `SPEC.md`、`docs/*` 与 `test/packaging.test.mjs` 的断言同步；安装示例统一
  `dsh-longlive-1.6.4.tgz`；
- 面板引用统一 **`dsh-longlive-panel@0.2.5`**：面板是独立 npm 包，不嵌入 longlive 的 tgz；
  0.2.5 带 G1/G2/G4 修复与「共享大脑 + 七个页签」新文案，longlive 侧只更新引用与文档。

## 1.6.3-rc.2 — 2026-11-06

**热截断的宿主契约修复候选版。** rc.1 在宿主 0.2.2-rc.1 上装得进、回退得了，但一刀切不下去：
VM 验收（rc.1 的 `REPORT.md`）定位到 `src/compaction/engine-core.js` 的三处硬契约。
本版只改这三处 + 安装器两处，切点/保留窗口/归档格式不变。

### 宿主契约（P0）

- **事件源**：`turnTable` / `findOpenTurn` / `activeCompactionStart` 不再读 `session.events`
  （宿主 Session 没有该属性），统一走 `sessionEvents()` → `Session.snapshotEvents()`，
  仅对旧 mock 保留 `log` / `events` 兜底。修复手动 `/compact` 报
  “could not produce a useful summary”和自动切 0 刀。
- **surfaceOp 形状**：指针改为宿主 `isReplaceOp` 要求的恰好三键
  `{op:'replace', startSeq, endSeq}`；`{start,end}` 会被宿主以
  `invalid replace surfaceOp` 拒绝。
- **system 不切**：切段不再强制从 surface 位置 0 开始。前导 `system/message` 永远留在原处，
  切点从其后第一个 user/assistant 节点开始；候选段内出现 system 时整轮排除，绝不把一轮切成半轮。
  指针落在 system 之后（位置 1），保留窗口与归档逻辑不变。
- 新增契约测试 H26（只有 `snapshotEvents()` 的会话仍能切）、H27（surfaceOp 恰好三键）、
  H28（system 在位置 0 不切、指针落位置 1）、H29（段内 system 使整轮让出）。

### 打包与安装

- 包内 `cordis.patch.yml` 补上激活行：`compaction-basic disabled: true` +
  `compaction-hot-truncate` 插入行（默认 `mode: cut`、`retainTurns: 6`、`retainTokens: 8000`），
  只装包即生效；装载失败仍由 `entry.js` 回退 stock。
- 安装器（与发布包同目录的 `install-1.6.3\` 副本）装前先 `dsh plugin remove dsh-session-longlive`，
  `--store-dir` 从 profile 的 `node_modules/.modules.yaml` 解析（不硬编码）；旧包不再残留。
- 安装器端口探测改为 Web 页面标记识别（`__DSH_BOOT__` / HTML / 401 shell），
  跳过宿主子进程 `billion-context` 的 JSON 端口（18787），不再假通过。

打包 `dist/dsh-longlive-1.6.3-rc.2.tgz`（`SOURCE_DATE_EPOCH=1793923200`，双打同 sha256）。

## 1.6.3-rc.1 — 2026-11-06

**热截断 cut-only CompactionEngine。** 在 1.6.0 基线上加入一个不调 LLM 的压缩引擎：只把
「已完成、且早于保留窗口」的整轮从 surface 上替换成一条覆盖率指针，原始事件一个字节不改，
先写归档再提交。全量测试 **1089 passed / 0 failed / 9 skipped**（skip 全部是既有门禁：
0.8.0 的 S4/S5/S6 需要宿主 exe、T7 需要 `DSH_T7_API_KEY`；v4/打包套件的 5 个需要真实记忆卡、
宿主类型文件或宿主 dsh-session/dsh-llm）。

### 热截断（新）

- 新增 `src/compaction/engine-core.js`（选轮/归档/指针/失败安全）、`cut-engine.js`（宿主
  `CompactionEngine` 子类）与 `entry.js`（装载、live-compact 共存检测、stock 回退）。
- `compactIfNeeded` / `compactNow` / `compactRegion`：只切 `completed` 整轮，默认
  `retainTurns=6`、`retainTokens=8000`；指针在位置 0，任意时刻最多一条。
- 归档：`<memoryRoot>/.longlive/hot-truncate/<UTCstamp>-<id8>.jsonl`，含 header/footer、
  全部原始事件与 `bodySha256`；`wx` 临时文件 + fsync + rename，只增不删。
- 指针消息写明「本会话共 N 轮，其中 M 轮已压缩归档」、`session_original(turn=…)` 与归档绝对路径。
- 失败安全：装载/构造失败释放 `ctx.compaction` 回退 stock；stock 也失败则空插件；运行期
  自动切失败只 warn 返回 null，手动切抛 `ManualCompactionError`。检测到 live-compact 时让位。
- `hotTruncate.mode: off | cut | auto`，默认 `cut`；`src/codec.js` 的 `foldSurface` 改按
  surface 位置解析 replace（支持 `start > end`）；`package.json` 增加 `./compaction` 导出。
- 新增 `test/hot-truncate.test.mjs`（26 个用例，含 H6b/H23 等回归）。
- 打包 `dist/dsh-longlive-1.6.3-rc.1.tgz`（`SOURCE_DATE_EPOCH=1793923200`，双打同 sha256）；
  发布版本面同步到 `docs/README.en.md`、`docs/FEATURES.md`、`docs/CONFIG.md`、
  `docs/TROUBLESHOOTING.md`、`QUICKSTART.md`、`docs/QUICKSTART.md`、`docs/DEV.md`、`SPEC.md`。

## 1.6.0 — 2026-11-06

**改名 + 普适化 + 设置页 + 安全默认。** 包名 `dsh-session-longlive` → `dsh-longlive`，显示名
「久视」（英文 Longlive）；在这条改名基座上并入三批工作，并把五个安全默认改到发布口径。
全量测试 **1063 passed / 0 failed / 9 skipped**。

### 改名与迁移

- 包名、`src/index.js` 的 `name`、日志前缀、安装器与文档全部改用 `dsh-longlive`；历史条目里的
  旧包名保留（历史事实）。
- **`- id: session-longlive` 这条 config 锚点不改名**（用户 patch 与既有配置按 id 匹配）；
  设置页 slot key 随之改为 `dsh-longlive#session-longlive`。
- 迁移（详见 `docs/MIGRATION-1.6.0.md`）：安装 `dist/dsh-longlive-1.6.0.tgz`；从 profile 的
  `package.json` 依赖里移除 `dsh-session-longlive`，从 `cordis.patch.yml` 里移除
  `name: 'dsh-session-longlive'` 的 insert 条目；面板 `dsh-longlive-panel@0.2.4` 不受影响。
  回滚：装回 `dist/dsh-session-longlive-1.5.0.tgz`，再把 profile 依赖与 patch 条目改回旧名。

### 普适化（可移植）

- 三套默认记忆根统一为 `<DSH home>/longlive-memory`：`memory_*` 工具、开机卡
  （`src/identity/handover.js`）、自动召回（`src/recall/index.js`）、R1 模拟器
  （`src/router/run-sim.mjs`）现在走同一条解析链；环境变量顺序为
  `DSH_IDENTITY_MEMORY_ROOT → DSH_LONGLIVE_MEMORY_ROOT → DSH_MEM`。
- 新用户不配任何东西时，身份卡与记忆工具不会再读到两棵不同的树。
- 安装器通用化：路径/账号/盘符/端口/宿主 exe 全部自动探测，新增 `-HomeDir` / `-TgzRoots`，
  宿主版本门禁改读 tgz 的 `engines.dsh`；本机与假新用户干跑均 exit 0。

### 设置页

- `src/config.js`：80 节点 schemastery Config，中英 `description`，`memoryRoot` / `memRoot`
  只读；宿主可以在激活时校验 profile 的配置行。
- `./client` + `src/ui/*`：`plugins.row.config` 页面注册在
  `dsh-longlive#session-longlive`，7 个开关（D2 / D6 / 自动想起 / 共享大脑 / 后台面 /
  每日维护 / Router），与 `/api/longlive/flags` 同源路由；写回走宿主 `configEditor`，
  保存后由 Loader 常规重载生效。没有 Web 服务的 profile 不会注册路由，插件照常加载。

### 安全默认（滥用面评估五条）

- `autoTruncate` 代码默认改为 `enabled:false` / `mode:'dryrun'`，与包内 `cordis.patch.yml`
  对齐；老配置漏写时不会再自动进入 log 模式。
- `routerRuntime` 默认从 `shadow` 改为 `off`（显式 `off` 写进 patch）；要记录判定必须显式设
  `shadow` 或 `on`，日志仍写 `<memoryRoot>/.longlive/router-runtime.jsonl`。
- `worker_spawn` / `worker_status` / `worker_kill` 增加 `workers.enabled` 开关，默认 `false`；
  22 个工具的默认表面不变，但开关关闭时每次调用都返回 `status:'unavailable'`。
- README 中文/英文的「不联网」「不自动杀进程」两处绝对说法加限定；中文默认阈值从 20 万改为
  30 万（与代码 `tokensThreshold: 300000` 一致）；补 MIT `LICENSE` 全文并加入 `files`。
- 新增 `test/safety-defaults.test.mjs` 钉住上述默认值与 slot key；`test/config-schema.test.mjs`
  与 `test/ui-flags.test.mjs` 覆盖 Config schema 与设置页。

打包：`dist/dsh-longlive-1.6.0.tgz`（`SOURCE_DATE_EPOCH=1793923200`）：双打同 sha256 +
`.sha256` sidecar，`pack --verify` 通过；同时产出 `dist/dsh-longlive-panel-0.2.4.tgz`。

历史版本条目里的旧包名（`dsh-session-longlive`）保留，它们是历史事实。

## 1.5.0 — 2026-11-06

**1.5.0 正式版：在 1.4.0 正式版之上并入 D2 工具输出裁剪与 D6 工具面裁剪 v1，并包含 rc.2 /
rc.3 的两个宿主契约修复。** 两项能力都是默认关闭的 opt-in：`d2.enabled=false` /
`d6.enabled=false` 时不注册 listener、不注册 `tool_search`，22 个工具与 1.4.0 完全一致；
任何裁剪路径异常都 fail-open 回退全量。全量测试 **1033 passed / 0 failed / 9 skipped**
（9 个 skip 与 1.4.0 门相同）。

### D2 / D6 能力集

- **D2 工具输出裁剪**（`d2.enabled`，默认 false）：超过 `d2.maxInlineChars`（默认 4096）的
  工具结果只把「头 60% + 一行提示 + 尾 40%」放进上下文，全文原子写入
  `<memoryRoot>/.longlive/tool-output/<turn>/<callId>.txt`，可用 `read` 或
  `session_original(turn, toolCallId)` 读回；落盘前复用 `privacyScan`，命中隐私时全文不落盘；
  扫描、写盘、裁剪任一步失败都用原文。
- **D6 工具面裁剪 v1**（`d6.enabled`，默认 false）：turn 1 按 `code` / `media` / `general`
  冻结 allowlist；`read` / `write` / `edit` / `pwsh` / `glob` / `grep` / `todo*` /
  `tool_search`、`session_*`、`memory_*` 永不裁剪；被裁工具用
  `tool_search({ names })` 或 `tool_search({ query })` 找回，`limit` 默认 8（范围 1–20），
  申请结果由 `system-prompt/assemble` 追加到工具列表。`dryRun: true` 只写 `[d6]` 日志；
  本版没有 `d6.taskProfiles` 键，`keepTools` 只能额外保留工具名。
- **预算（VM 实测，宿主 0.2.2-rc.1）**：D6 关闭时全量 **105 工具 / 28,492 tokens**；开启后
  代码任务首轮 **39 工具 / 11,706 tokens**（VM 团队预置 9 个工具；去掉后即预期的
  30 工具 / 9,700 tokens），`tool_search` 后 40 / 11,988，query 形态 43 / 13,118。
- 开启方式与回退见下方 rc.1 / rc.3 历史条目（D2/D6 详文保留）与 `docs/FEATURES.md`；
  改配置后重启宿主生效，回退只需把对应 `enabled` 设 false 或删整块，无数据迁移。

### 修复（rc.2 / rc.3，合并入正式版）

- rc.2 **`tool_search` 的 `parameters` 形状**：宿主 0.2.2-rc.1 的
  `parameterSchemaSpecToJsonSchema` 期望「参数名 → 值 schema」的裸属性表；rc.1 传了完整
  JSON Schema（顶层 `type/properties/required`），宿主把顶层 `type` 当成参数校验，抛
  `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`，
  D6 一开宿主启动 EXIT 1。现改为 `{ names, query, limit }` 裸表，`invoke` 与注册顺序未动。
- rc.3 **`tool_search` 的 `output.render` 返回形状**：rc.2 返回
  `JSON.stringify(value)` 字符串，宿主 `pipeline.createSuccessResult` 原样当作 `content`，
  `@deepseek-ai/dsh-llm` 的 `contentHasImage` 执行 `content.some(...)` 时抛
  `TypeError: content.some is not a function`。现返回
  `[{ type: 'text', text: JSON.stringify(value) }]`，与 22 个默认工具的 `OUTPUT_TEXT` 同形。
- 两个修复各有回归测试：`test/tool-schema.test.mjs`（3 用例）与
  `test/d6-output.test.mjs`（4 用例），均接入 `test/run-rc.mjs`。

### 版本面与验收

- `package.json` 版本 `1.5.0-rc.3 → 1.5.0`；`test/packaging.test.mjs` 的 R2-07 版本面断言
  同步；`README.md` / `README.en.md` / `SPEC.md` / `QUICKSTART.md` / `docs/README.en.md` /
  `docs/QUICKSTART.md` / `docs/DEV.md` / `docs/FEATURES.md` 的 tarball 名、
  `--expect-version` 与测试计数同步到 1.5.0。
- `node --check` 全树 0 failed；`node test/run-rc.mjs` 全量 **1033 passed / 0 failed /
  9 skipped**。
- 打包 `dist/dsh-session-longlive-1.5.0.tgz`（`SOURCE_DATE_EPOCH=1793923200`）：双打同
  sha256 + `.sha256` sidecar，`scripts/pack.mjs --verify` 通过。
- 本版不安装 profile、不重启宿主、不改真机配置。

## 1.5.0-rc.3 — 2026-11-06

**1.5.0-rc.2 的阻断缺陷修复候选版。** rc.2 已修好 `tool_search` 的 `parameters`
形状，但 VM 复测发现：D6 启用后调用 `tool_search`，宿主管道在处理工具结果时抛
`TypeError: content.some is not a function`（REPORT §3）；放宽副作用已生效，工具结果
本身不可用。本版只改 `tool_search` 的 `output.render` 返回形状，**不改 D6 语义**：
默认关闭、turn 1 冻结、末尾追加、放宽集合原样。全量测试
**1033 passed / 0 failed / 9 skipped**（新增 4 个 output-contract 用例，9 个 skip 与 1.4.0 门相同）。

### 修复 · D6 `tool_search` 的 output.render 返回形状

- 根因：`TOOL_SEARCH_SPEC.output.render` 返回 `JSON.stringify(value)` 字符串。
  宿主 0.2.2-rc.1 的 `pipeline.createSuccessResult` 把 `render` 的返回值**原样**当作
  tool result 的 `content`（只校验 JSON 无损，不校验数组形状）；随后
  `@deepseek-ai/dsh-llm` 的 `contentHasImage(content)` 执行
  `content.some((block) => block.type === 'image')`，字符串没有 `.some`，于是抛
  `content.some is not a function`。22 个默认工具都经 `OUTPUT_TEXT` 返回
  `[{ type: 'text', text }]`，只有 `tool_search` 是字符串。
- 改法：`src/d6/runtime.js` 的 `output.render` 改为
  `(_args, value) => [{ type: 'text', text: JSON.stringify(value) }]`，与
  `OUTPUT_TEXT` 同形；`schema`、参数表、`invoke`、注册顺序与 D6 冻结/放宽逻辑均未动。
- 契约依据（本机与 VM 同为 0.2.2-rc.1）：`dsh-tools/lib/pipeline.js:709-739`
  （`createSuccessResult`）、`dsh-tools/lib/index.js:310-359`（`defineTool` 原样转交
  render）、`dsh-llm/lib/index.js:593-594`（`contentHasImage` 的 `.some`）。
- 新增 `test/d6-output.test.mjs`（4 用例）：
  - 直接复刻宿主 `contentHasImage` 的 `content.some(...)` 走一遍，断言
    `tool_search` 的 list / add / `D6_NOT_FROZEN` 错误三个返回都渲染成非空
    content block 数组，且 `JSON.parse(text)` 能还原原始对象；
  - 经 `registerTools` 的生产注册路径，断言 `output` 按同一对象转交宿主 seam；
  - 变异验证：把 rc.2 的 `JSON.stringify(value)` 字符串塞回同一走查，必须抛出
    `/content\.some is not a function/`。
  - `test/run-rc.mjs` 接入新 suite；`package.json` 的 `files` 白名单同步收录。
- 未改 D6 语义：`d6.enabled=false` 时仍不注册 listener、不注册 `tool_search`；
  turn 1 冻结、放宽集合、末尾追加三条都保持原样。

### 版本面与验收

- `package.json` 版本 `1.5.0-rc.2 → 1.5.0-rc.3`；`test/packaging.test.mjs` 的 R2-07
  版本面断言同步；`README.md` / `README.en.md` / `SPEC.md` / `QUICKSTART.md` /
  `docs/README.en.md` / `docs/QUICKSTART.md` / `docs/DEV.md` / `docs/FEATURES.md`
  的 tarball 名与 `--expect-version` 同步到 rc.3。
- `node --check` 全树 209 个 `.js/.mjs`（排除 `node_modules` / `dist`）0 failed；
  `node test/run-rc.mjs` 全量 **1033 passed / 0 failed / 9 skipped**。
- 打包 `dist/dsh-session-longlive-1.5.0-rc.3.tgz`（`SOURCE_DATE_EPOCH=1793923200`）：
  双打同 sha256 + `.sha256` sidecar，`scripts/pack.mjs --verify` 通过。
- 本版不安装 profile、不重启宿主、不改真机配置。

## 1.5.0-rc.2 — 2026-11-06

**1.5.0 的阻断缺陷修复候选版。** 1.5.0 在 D6 首次启用时会让宿主在启动建工具阶段
直接 EXIT 1；本版只修 `tool_search` 的 `parameters` 形状，**不改 D6 语义**：默认关闭、
turn 1 冻结 allowlist、`tool_search` 追加到工具列表末尾这三条都保持原样，`d6.enabled=false`
时依旧不注册 listener、不注册 `tool_search`，22 个默认工具与 1.4.0 一致。全量测试
**1029 passed / 0 failed / 9 skipped**（新增 3 个 schema 形状用例，9 个 skip 与 1.4.0 门相同）。

### 修复 · D6 `tool_search` 的 parameters 形状

- 根因：`tool_search` 把完整 JSON Schema（顶层 `type: 'object'` + `properties` +
  `additionalProperties`）直接传给宿主 `defineTool` 的 `parameters`。宿主 0.2.2-rc.1 的
  `parameterSchemaSpecToJsonSchema` 期望的是「参数名 → 值 schema」的裸属性表，它把顶层
  `type` 当成一个名叫 `type` 的参数来校验，值却是字符串 `'object'`，于是抛
  `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`；
  D6 默认关闭时走不到这段注册，一开就整机启动失败。其余 22 个工具本来就是裸表，所以只有
  `tool_search` 触发。
- 改法：`src/d6/runtime.js` 的 `TOOL_SEARCH_SPEC.parameters` 改为
  `{ names, query, limit }` 裸表；每个键是值 schema（`names` 为 `array` + `items.string`，
  `query` 为 `string`，`limit` 为 `integer`），不再有外层 `type/properties/required` 包壳。
  `makeToolSearch` 的 `{...TOOL_SEARCH_SPEC, invoke}` 与注册顺序未动。
- 兼容：0.2.1 与 0.2.2 对 `parameters` 的期望都是裸属性表（22 个既有工具在两版宿主都能
  注册），因此不需要运行时分支；按 0.2.2 的规则写即可。
- 新增 `test/tool-schema.test.mjs`（3 用例）：自带最小校验器，拒绝顶层
  `type/properties/required/additionalProperties/$schema`，逐个校验属性值是合法值 schema
  （类型白名单、`object` 必须有布尔 `additionalProperties`、`array.items` 递归、
  `required` 只允许 `true`）；覆盖 22 个默认工具、`TOOL_SEARCH_SPEC` 的键序/类型，以及
  `registerTools` 的真实注册路径（含 5 个 router 工具 + 1 个 `tool_search`）。
- 把旧形状注入该测试做变异验证会失败：
  `tool_search: parameters must not have a top-level "type"`；用宿主 0.2.2-rc.1 的
  `defineTool` 实测，旧形状抛上面的 `JsonSchemaError`，新形状通过。
- `test/run-rc.mjs` 接入新 suite；`package.json` 的 `files` 白名单同步收录。

### 版本面与验收

- `package.json` 版本 `1.5.0 → 1.5.0-rc.2`；`test/packaging.test.mjs` 的 R2-07 版本面
  断言同步；`README.md` / `README.en.md` / `SPEC.md` / `QUICKSTART.md` / `docs/README.en.md` /
  `docs/QUICKSTART.md` / `docs/DEV.md` 的 tarball 名与 `--expect-version` 同步到 rc.2。
- `node --check` 全树 208 个 `.js/.mjs`（排除 `node_modules` / `dist`）0 failed；
  `node test/run-rc.mjs` 全量 **1029 passed / 0 failed / 9 skipped**。
- 打包 `dist/dsh-session-longlive-1.5.0-rc.2.tgz`（`SOURCE_DATE_EPOCH=1793923200`）：
  双打同 sha256 + `.sha256` sidecar，`scripts/pack.mjs --verify` 通过。
- 本版不安装 profile、不重启宿主、不改真机配置。

## 1.5.0（rc.1 冻结首版，已撤回）— 2026-11-06

> 历史条目，保留以便追溯：这是 1.5.0 由 1.5.0-rc.1 冻结的第一版，功能代码与 rc.1 相同。
> VM 复验发现 D6 的两个宿主契约缺陷（`tool_search` 的 `parameters` 形状、`output.render`
> 返回形状），该 tgz 已撤回；最终 1.5.0 见顶部条目。

**1.5.0 正式版（由 1.5.0-rc.1 冻结）。** 与 rc.1 相比功能代码零改动；本版只收敛版本面、
文档与打包测试断言。D2 工具输出裁剪与 D6 工具面裁剪 v1 原样进入正式版，**两者默认关闭**：
`d2.enabled=false` / `d6.enabled=false` 时不注册 listener、不注册 `tool_search`，22 个工具与
1.4.0 完全一致。全量测试 **1026 passed / 0 failed / 9 skipped**（9 个 skip 与 1.4.0 门相同）。

### 定版 · 版本面与验收

- `package.json` 版本 `1.5.0-rc.1 → 1.5.0`；`README.md` / `README.en.md` / `QUICKSTART.md` /
  `SPEC.md` / `docs/README.en.md` / `docs/FEATURES.md` / `docs/CONFIG.md` 与 `docs/` 下
  用户文档的当前版本行同步到 1.5.0。
- `test/packaging.test.mjs` 的 R2-07 版本面断言同步到 1.5.0；R2-08 继续钉住发布配置
  `autoTruncate enabled:false / mode:dryrun`。
- 打包 `dist/dsh-session-longlive-1.5.0.tgz`（`SOURCE_DATE_EPOCH=1793923200`）：
  双打同 sha256 + `.sha256` sidecar，`scripts/pack.mjs --verify` 通过。
- 本版不安装 profile、不重启宿主、不改真机配置。

### D2 · 工具输出裁剪（默认关闭，`d2.enabled`）

- 打开：

  ```yaml
  d2:
    enabled: true
    maxInlineChars: 4096
  ```

  改完重启宿主。超过 `maxInlineChars` 的工具结果只把「头 60% + 一行提示 + 尾 40%」放进
  上下文，全文原子写入 `<memoryRoot>/.longlive/tool-output/<turn>/<callId>.txt`；可用 `read`
  或 `session_original(turn, toolCallId)` 读回。
- 回退：`d2.enabled: false`（或删除整个 `d2` 块）后重启；没有数据迁移，归档目录可保留
  取证或手工删除，不影响记忆卡片。
- 风险：归档目录会随大输出增长；隐私命中时全文不落盘、上下文只留占位；扫描、写盘或
  裁剪任一步失败都 fail-open 用原文，不阻断 turn。

### D6 · 工具面裁剪 v1（默认关闭，`d6.enabled`）

- 打开：

  ```yaml
  d6:
    enabled: true
    dryRun: false
    log: true
    keepTools: []
  ```

  改完重启宿主；先设 `dryRun: true` 只写 `[d6]` 日志，不裁剪、不注册 `tool_search`。
- 行为：turn 1 按 `code` / `media` / `general` 冻结 allowlist；`read` / `write` / `edit` /
  `pwsh` / `glob` / `grep` / `todo*` / `tool_search`、`session_*`、`memory_*` 永不裁剪；
  被裁工具用 `tool_search({ names })` 或 `tool_search({ query })` 找回（`limit` 默认 8，
  范围 1–20），申请结果由 `system-prompt/assemble` 追加到工具列表末尾。
- 预算：真实 108 工具 header 下代码任务保留 29 个工具 / **9,700 tokens**（≤10K），
  全量 109 个工具 / 29,336 tokens。
- 回退：`d6.enabled: false`（或删除整个 `d6` 块）后重启；没有数据迁移，不需要改
  memoryRoot。
- 风险：同一会话内 allowlist 不随任务变化；`tool_search` 多一次工具往返；选择、裁剪或
  组装任一步异常、或裁剪后工具集为空，一律回退全量，不阻断会话。本版**没有**
  `d6.taskProfiles` 键，任务模板是代码内建的三类，`keepTools` 只能额外保留工具名。

## 1.5.0-rc.1 — 2026-11-06

**1.5.0-rc.1 合并候选：在 1.4.0 正式版之上并入 D2 工具输出裁剪与 D6 工具面裁剪 v1。
两项都是默认关闭的 opt-in 能力；`d2.enabled=false` / `d6.enabled=false` 时不注册
listener、不注册 `tool_search`，22 个工具与 1.4.0 完全一致。全量测试
**1026 passed / 0 failed / 9 skipped**（9 个 skip 与 1.4.0 门相同）。**

### D2 · 工具输出裁剪（默认关闭）

- 新增 `src/tool-output.js`：监听 `tools/post-execute`，超过 `d2.maxInlineChars`（默认 4096）
  的工具结果只把「头 60% + 一行提示 + 尾 40%」放进上下文，全文原子写入
  `<memoryRoot>/.longlive/tool-output/<turn>/<callId>.txt`；提示行给出字节数与读回方式。
- 默认 `d2.enabled: false`；开启后 fail-open——扫描、写盘或裁剪任一步失败都用原文，不阻断 turn。
- 落盘前复用 `src/recall/privacy.mjs` 的 `privacyScan`：命中则不落盘，上下文只留占位。
- 与 D3 `session_original` 共用 `src/original.js` 的 `archiveFileName`，路径格式一致，
  可用 `read` 或 `session_original(turn, toolCallId)` 读回全文。
- 新增 `test/tool-output.test.mjs`（15 用例）并接入 `test/run-rc.mjs`；`package.json` 的
  `files` 白名单同步；`docs/CONFIG.md` 增加 `d2` 键表。

### D6 · 工具面裁剪 v1（默认关闭）

- 新增 `src/d6/surface.js`（纯策略：`classifyTask` / `selectAllowlist` / `filterAssembly` /
  `assembleShape`）与 `src/d6/runtime.js`（Cordis 接线）：turn 1 的
  `agent/inbox/claimed` 同步冻结 allowlist，`system-prompt/assemble` 只做 0.2.1 形状兼容，
  `tools.restrict({ deny })` 落地裁剪。
- 仅在 `d6.enabled=true` 时注册第 23 个工具 `tool_search`：按名称/关键词列出被裁掉的工具，
  申请到的工具由 `system-prompt/assemble` 追加到工具列表**末尾**；`dryRun: true` 只记日志、
  不裁剪、不注册工具。
- 任何选择/注册/裁剪异常或空集一律回退全量，不阻断会话；`keepTools` 可额外强制保留。
- 新增 `test/d6.test.mjs`（13 用例）与 `test/fixtures/d6-header-tools.json`（108 个真实
  工具 schema），接入 `test/run-rc.mjs`；`package.json` 的 `files` 白名单同步。
- 预算：真实 108 工具 header 下代码任务保留 29 个工具 / **9,700 tokens**（≤10K），
  全量 109 个工具 / 29,336 tokens。

### 版本面与验收

- `package.json` 版本 `1.4.0 → 1.5.0-rc.1`；`docs/FEATURES.md` 标题与开关矩阵、
  `docs/CONFIG.md` 适用版本与 `d6` 键表、`docs/README.en.md` / `README.md` / `SPEC.md`
  的当前版本行同步。
- `test/packaging.test.mjs` 的 R2-07 版本面断言同步到 1.5.0-rc.1。
- 硬验收：`d2.enabled` / `d6.enabled` 默认 false；D2 归档路径与 D3 同源；D6 allowlist
  在 turn 1 冻结且 `tool_search` 可追加；代码任务工具面 ≤10K token 复跑一致。
- 打包 `dist/dsh-session-longlive-1.5.0-rc.1.tgz`：双打同 sha256 + `.sha256` sidecar，
  `scripts/pack.mjs --verify` 通过。
- 本版不安装 profile、不重启宿主、不改真机配置。

## 1.4.0 — 2026-11-06

**1.4.0 正式版（由 1.4.0-rc.4 冻结）。** rc.1～rc.4 的能力集原样进入正式版：A1/A2 结论
自动回流与共享板 lastConclusion、A3/A4 本地 embedding 语义召回（关键词/向量融合）、
B1/B2 自动巩固与自动遗忘预演、B3 来源标记/冲突检测/manifest、C1 `engines.dsh` 启动自检、
C2 常驻看门、D1/D4 四层度量与每轮账本、D3 `session_original`（第 22 个工具）、
routerFace v1 后台面（默认关闭）。发布默认：包内 `cordis.patch.yml` 显式关闭
`autoTruncate`（`enabled: false` / `mode: dryrun`），插件代码回退默认与 22 个工具不变；
面板 0.2.4。全量测试 **998 passed / 0 failed / 9 skipped**；rc.4 已通过 VM 组合验收
**6 项全 PASS**（rc.4 验收报告）。本版不安装 profile、不重启宿主、
不改真机配置。

### 定版 · 版本面与验收
- `package.json` 版本 `1.4.0-rc.4 → 1.4.0`；`README.md` / `README.en.md` / `QUICKSTART.md` /
  `SPEC.md` 与 `docs/` 下用户文档的当前版本行同步到 1.4.0。
- `test/packaging.test.mjs` 的 R2-07 版本面断言同步到 1.4.0；R2-08 继续钉住发布配置
  `autoTruncate enabled:false / mode:dryrun`。
- 功能代码零改动：与 rc.4 的差异只在版本字符串、当前版本文档与发布配置注释；tgz 重新打包并做
  双打同 sha 校验。
- 全量 `node test/run-rc.mjs`：**998 passed / 0 failed / 9 skipped**（9 个 skip 与 rc.4 门相同）；
  面板 `self-test.mjs` 58 PASS / 0 FAIL，`client-smoke.mjs` 25 + 27 + 2 PASS / 0 FAIL。

### 安全默认 · autoTruncate 发布配置（rc.4 起沿用）

- `cordis.patch.yml` 的 `session-longlive.config` 新增：

  ```yaml
  autoTruncate:
    enabled: false
    mode: dryrun
  ```

  新装 profile 在没有自己的 `autoTruncate` 块时默认关闭自动截断。rc.3 及以前这份发布配置
  没有该块，插件回退默认 `enabled: true` / `mode: 'log'` 会让新 profile 以 log 模式启用
  自动截断（只记录、不写会话，但仍是启用状态）。
- **未改** `src/auto-truncate.js` 的 `AUTO_TRUNCATE_DEFAULTS`（仍是 `enabled: true` /
  `mode: 'log'`）——那是既有行为，本版只让**发布配置**默认关闭；删除该块即回到既有行为。
- **未改** 看门安装默认值（`scripts/session-watch.mjs` 仍 `enabled: true` / `mode: 'dryrun'`）；
  本版仍不安装、不注册计划任务。
- `test/packaging.test.mjs` 新增 R2-08 钉住发布配置的显式关闭；R2-07 的版本面升到 rc.4。
- 未安装 profile、未重启宿主、未改真机配置。

## 1.4.0-rc.3 — 2026-11-05

**1.4.0-rc.3 合并候选：并入 C2 常驻看门（session watchdog + `truncate-cli --dry-run`）。
脚本随包发布，但不安装、不注册计划任务；插件默认行为与 22 个工具不变；全量测试
997 passed / 0 failed / 9 skipped（9 个 skip 与 rc.2 相同）。**

### C2 · 常驻看门与只读预演

- 新增 `scripts/session-watch.mjs`：独立进程按 `intervalSeconds` 扫描 sessions 根，按
  token/字节/事件/最小轮数判定候选；`mode=log|dryrun|request`，`request` 才调用
  `truncate-cli.mjs --confirm TRUNCATE-VISIBLE`；每次动作写 receipt，live 行/独占句柄命中即
  拒绝；`enabled=false` 为 kill switch。
- 新增 `scripts/session-watch-drill.mjs` 与 `scripts/lib/session-watch-fixture.mjs`：在临时
  home 里造 fixture 会话，演练 check/dryrun/request/kill/live/corrupt/loop 七组共 60 项检查。
- `scripts/truncate-cli.mjs` 新增 `--dry-run`（+53/-1）：解析后跳过 `--confirm`，先调
  `truncateVisibleSession({ dryRun: true })` 出只读计划；不写备份、不写归档、不写 inflight，
  会话字节不变。看门 dryrun 模式走的就是这条路径。
- 新增 `scripts/install-session-watch.ps1`（`-DryRun` 零写入、`-NoRegister` 只复制不注册）、
  `scripts/uninstall-session-watch.ps1`、`scripts/session-watch-status.ps1`。
- 新增 `docs/SESSION-WATCH.md`；`package.json` 的 `files[]` 增加 7 项（1 篇文档 + 6 个脚本）。
- 安全默认：看门安装参数 `mode=dryrun`；脚本随包发布但本版**不安装、不注册**。插件本体
  `autoTruncate` 默认值未改（`enabled=true` / `mode=log`），本版未改动任何真机 profile 配置。
- 合并适配：`install-session-watch.ps1` 的 node 回退候选由写死的开发机路径改为
  `<DshHome>\dsh-runtimes\...\node.exe`，以满足既有 PORT5 可移植性门（发布文件不得含
  `C:\Users\<开发者>` 路径）。

**合并与测试**：C2 按逐文件三方方式并入 rc.2——`scripts/truncate-cli.mjs` 与 rc.2 基线字节
一致，直接换入；7 个新文件在 rc.2 不存在，直接新增；`package.json` 仅两处锚点插入，无冲突。
`node --check` 全部通过；全量 `node test/run-rc.mjs` 为 **997 passed / 0 failed / 9 skipped**
（4 个 0.8.0 宿主门 + 5 个 packaging 宿主门，与 rc.2 相同）；面板 `self-test.mjs` 58 PASS /
0 FAIL，`client-smoke.mjs` 25 + 27 + 2 PASS / 0 FAIL；session-watch drill 60/60、`failed=[]`。
发布面同步升到 rc.3 / 面板 0.2.4。

## 1.4.0-rc.2 — 2026-11-05

**1.4.0-rc.2 合并候选：A3/A4 语义召回（embedding + 融合排序 + recall-log 写入）、D3
`session_original` 原文回读（第 22 个工具）、routerFace v1 后台面（默认关闭、dry-run）。
默认行为不变；全量测试 962 → 997 passed。**

### A3/A4 · 语义召回与 recall-log 写入

- 新增 `src/recall/embedding.mjs`：`onnxruntime-node` 作为 **optionalDependency**
  （`~1.16.3`）懒加载，模型/依赖缺失或推理失败一律静默回退纯关键词召回，不阻断
  召回也不影响工具注册。
- `recall-core` 融合排序：`0.6 * min(1, keywordScore/2.5) + 0.4 * cosine`，
  `semanticAdmit` 0.55、`minFusedScore` 0.2；注入预算硬上限 2000 tokens。
- `features.js` 透传 `config.embedding`（默认关闭），不改变
  `normalizeFeatureConfig()` 的返回形状；`feature-flags` 的深比较契约保持。
- 每个 step 1 向 `<memoryRoot>/.longlive/recall-log.jsonl` 追加一行
  `{at, sessionId, turn, injected:[{id,title,score,reason}], blocked:[{id,title,reason}]}`
  （空注入也写；写失败只告警）。该形状与面板 0.2.4 的读取端一致。
- 测试：新增 `test/embedding-recall.test.mjs`（10 例）。

### D3 · `session_original` 原文回读（第 22 个工具）

- 新增 `src/original.js` 与工具 `session_original`：按 `turn` / `kind`
  （tool|message|call|all）/ `toolCallId` / `messageIndex` 从会话原文取回片段，
  `offset` / `maxBytes`（1024..4194304，默认 `originalFetchMaxBytes`=65536）；
  支持 `sessionPath` / `sessionId` / `session: latest|current`。
- 隐私门在切片前对全文扫描，命中返回 `PRIVACY_BLOCKED` 且不带 `content`；
  D2 归档路径只报告不写入。
- 工具数 21 → 22：`test/fixtures/baseline-0.8.0-registration.json` 的注册快照同步
  重生成（0.8.0 契约 + `session_original`），`test/feature-flags.test.mjs` 的
  21 处工具计数/列表断言与 `CONTRACT_NAMES` 一并更新。
- 测试：新增 `test/session-original.test.mjs`（12 例）。

### routerFace v1 · 后台面（默认关闭）

- 新增 `src/router/face/`（config/context/face/identity/index/journal/llm/outbox/paths）
  与 `test/router-face/` 两个测试文件；只经 `src/index.js` 的显式接缝接入，
  R1-ID4 的允许接缝相应扩展为 `./router/runtime.js` + `./router/face/index.mjs`。
- 默认全关：`enabled=false`、`dryRun=true`、`tickMs=60000`、
  `dailyTokenBudget=50000`、`maxContextTokens=30000`、`maxSuggestions=3`；
  使用 `ctx.get('llm')`，无 HTTP 兜底；未启用时 hint 输出逐字节不变。
- 测试：新增 12 例；router-identity 的 R1-ID4 仍 PASS。

**合并与测试**：三路按 a34b → d3 → router-face 顺序三方并入；全量
`node test/run-rc.mjs` 为 962 → **997 passed / 0 failed / 9 skipped**（9 个 skip
与 rc.1 相同，均为宿主/真实记忆库门禁，无新增）。发布面同步升到 rc.2 / 面板 0.2.4。

## 1.4.0-rc.1 — 2026-11-05

**1.4.0-rc.1 合并候选：A1/A2 结论回流与共享板、B1/B2/B3 维护与来源、C1 引擎自检、D1/D4 分层记账与度量；默认行为与 21 个工具不变。**

### C1 · `engines.dsh` 启动自检

**宿主版本不匹配只 warn + 写面板数据，绝不 throw、不阻断加载；21 个工具与默认行为不变。**

- `src/host-version.js` 新增宿主清单回退：`config.hostPackagePath` → `DSH_HOST_PACKAGE` →
  `process.resourcesPath/app.asar/dsh/package.json`（桌面宿主；Electron 的 asar 读取对插件
  进程透明）→ 同目录 `desktop-runtime.json` → `process.execPath/resources/...`。找到的
  版本与来源路径随探测结果返回；坏文件/缺失静默跳过，全部失败仍是「未知」。
- 新增 `src/engine-status.js`：把判定写到 `<memoryRoot>/.longlive/status.json` 的
  `engineMismatch`（`hostVersion` / `required` / `at` / `source` / `path`），tmp + rename
  原子写并保留文件其它键；匹配时清除残留记录（只剩它则删文件）；未知不动；所有磁盘错误
  只返回不抛。`apply()` 在解析出 memoryRoot 后调用，外面再兜一层 try/catch。
- 测试：新增 `test/host-engine-status.test.mjs`（14 例）并接入 `test/run-rc.mjs`，
  `package.json.files` 已列入。文档：`docs/PANEL-INTEGRATION.md` §8 定义数据契约，
  `docs/ERRORS.md` 增加排查说明。

## 1.3.1 — 2026-11-05

**identityCard 跨进程去重：同一 sessionId 在新进程续跑时不再插入第二张开机卡。
默认值、注入形状、配置键与 21 个工具均不变。**

- 根因：`registerIdentityCard()` 用进程内 `states = new Map()` 记 `opened`。
  `--session-id` 续跑会起新进程，Map 为空，step 1 再次注入（VM-EXTRA-3 实测）。
- 修复：`opened` 落到 `<memoryRoot>/.longlive/identity-card/<safeSessionId>.json`
  （`{v:1, sessionId, openedAt, at}`）。注入前读 marker，存在直接 `next()`，
  不读卡；注入前用 `O_EXCL` 抢注释位，成功后 tmp + rename 原子写；读取/解析
  失败、越界、只读或抢占失败一律 fail-closed 到「不重复注入」，只 warn 一次。
  marker 超过 30 天在注册时惰性清理（每次最多 128 个，不影响本会话）。
- 边界：marker 丢失/被删会再注入一次（没有正文级去重）；marker 损坏或
  finalize 失败留下的占位 marker 会让后续进程一直跳过，需人工删除才恢复；
  只读磁盘上 identityCard 会保持不注入。
- 测试：882 → 894 passed / 0 failed / 9 skipped（+12 个 identity-card-marker 用例，
  覆盖同进程、模拟新进程、并发 O_EXCL、损坏 marker、写失败、prune、越界与已知边界）。

## 1.3.0 — 2026-11-05

**共享板实时化：focus 行带最近动作与排队数，动作变化即改哈希、下一轮触发注入。
不新增配置键，配额与 §2.2 硬规则不变；21 个工具的数量与语义不变。**

- `board.json` 的 `focus[]` 新增 `lastAction: {kind, detail, at}`（只取 live 行的
  `last_action`，`detail` 截 60 字）与 `queuedCount`；`boardHashOf` 把两者纳入哈希，
  `fitBoard` 在只剩一条 focus 时把超长动作截到 12 字。
- `【共享大脑提示】` 的 focus 行改为
  `- <sessionId 前 12 位> 目标「…」 · 最近：<kind> <detail>（<X> 分钟前/刚刚） · 排队 <n>`；
  goal 为空显示「（未声明）」；最近 10 分钟内有动作的非本会话排前（不新增配额）。
- reflection 档按 `routerReflectHintTokens`（默认 150）夹 token，full 档仍按
  `routerHintTokens`（默认 700）；超预算时动作文本依次缩到 24/12 字。
- 隐私边界：动作只来自插件写入 live 行的 `last_action`，不从消息正文抓取。
- 测试：873 → 882 passed / 0 failed / 9 skipped（+9 个 presence 用例）。

## 1.2.0 — 2026-11-05

**两个潜望镜页签接真数据：记忆准入过滤器（filter）与 R1 影子记录（shadow）。
两者被动、零 token、fail-open；21 个工具的数量与行为不变。**

### 过滤器 · `.longlive/filter/`

- 复用 `src/memory/filter.js`（纯函数，策略 `maf-2`），新增
  `src/memory/filter-runner.js`：启动后 25 ms（unref）读一次 `journal/*.md`，
  以自然段 / bullet 为判定单元，8 维打分后写
  `decisions-YYYY-MM-DD.jsonl`、`queue/`、`runs/`、`state.json`。
- 隐私门一票否决 → `local_only`，审计行只有 marker+sha256+位置，`excerpt`
  恒为 `null`；缺卡片上下文时 remember 降级 human（失败关闭）。
- 同日重复运行按 unitId 去重；所有写入 mkdir -p + 原子替换。
- `filterEnabled: true` 为默认；关掉后不创建目录、不写文件，面板走「未启用」。

### 影子 · `.longlive/router-runtime.jsonl`

- `routerRuntime` 默认从 `off` 改为 `shadow`（显式值仍优先；`shadowEnabled:false`
  且未显式设置时回 `off`）。`recordAllTools` 让 shadow 记录本插件全部工具调用，
  `on` 的拒绝范围仍只限高风险写操作。
- 默认记录路径从 `<memoryRoot>/router-runtime.jsonl` 移到
  `<memoryRoot>/.longlive/router-runtime.jsonl`；面板继续同时兼容旧顶层文件。
- 每条记录补齐面板契约 §6 的顶层字段：`subject/action(allow|deny|ask)/level/
  matchedRule/confidence/needsHuman/callText/status/errors`，同时保留原有
  `decision.*` 语义动作。
- `shadowEnabled: true` 为默认；记录写入失败只 warning，绝不影响工具执行。

## 1.1.3 — 2026-11-05

**v7 harness 暴露的产品缺口收口：P0 锚 off-by-one（带账本正常重启误报
`E_LEDGER_TAMPERED`）、F-03 `audit.repair`、E-06/G-02/G-03 `budget.reclaim`
（含旧 run 账本扫描）、D-05 `routerTestHooks.forceContextOverBudget`。
全量 suite 869 passed / 0 failed / 9 skipped。**

### P0 · 锚指向「下一条」审计导致重启误报

- `service.mjs` 的 `#sealAnchor()` 原先把 `audit.seq` 直接写进锚；`AuditLog.seq`
  是下一条要写的序号（`append()` 里 `seq++`），于是锚指向一条尚不存在的记录。
  重启时 `verifyAnchor` 找不到该 seq → `audit_prefix_mismatch` →
  `E_LEDGER_TAMPERED`。现在写 `seq - 1`，锚只指向已落盘的最后一条。
- `background/router.mjs` 的同类实现没有此 bug，未改。

### F-03 · 半行截断留审计证据

- `audit.mjs`：`#repairTail()` 返回被丢弃的字节数；`open()` 在截断发生后追加
  `audit.repair { bytes_dropped, file, reason: 'partial_tail' }`，随后正常续 seq。

### E-06 / G-02 / G-03 · 崩溃遗留预留的回收审计

- `service.mjs`：boot/standby/tick 统一走 `#reclaimRunLedgers()`，除当前 run 外
  扫描 `vault/runs/*/budget.ledger.jsonl`，用各自的 `BudgetLedger.reclaimDead()`
  释放旧 run 的预留；有回收时写一条 `budget.reclaim { origin, released,
  freed_tokens, charged: 0, runs, items }`。审计写在洁净检查之后，旧 run 回收
  失败只告警，不阻塞启动。

### D-05 · 构造 full+reflect 同时超预算

- `context.mjs` 的 `assembleContext` 新增 `forceOverBudget`；`service.mjs` 只在
  `deps.testHooks.forceContextOverBudget === true` 时传它（默认关闭，不暴露给
  模型工具面）。用于验证 `E_CONTEXT_OVER_BUDGET` 路径不调用模型、不预留预算。

## 1.1.2 — 2026-11-05

**v6 真机验收剩的三条 FAIL 收口：K-08（过期保留提案本体）、L-03（重启重建队列视图）、
K-04（pending 可按 ticket 取消 + `superseded` 终态口径入文档）。全量 suite
864 passed / 0 failed / 9 skipped。**

### K-08 · 过期只标状态，提案本体保留

- `queue.mjs`：两条过期分支（`blocked-on-user` 24h、提案 72h TTL）合并成 `#expire()`；
  只写 `status: 'expired'` + `queue` 字段 + `stateLog`，**不删除** `proposals/<id>.json`。
- 审计 `proposal.expired` 增加 `bodyKept: true`；若本体不存在则额外记
  `proposal.retention_lost`（回归哨兵，不是清理逻辑）。
- `status.queue.expired` 不再恒为 0：`proposals.mjs` 的 `status()` 统计 `expired` 行。
- `tailTicket` 语义不变：过期释放的票不复用，下一条仍排尾。

### L-03 · 启动时重建 proposals/queue.json

- `service.mjs`：`#start()` 在审计链检查通过后调用 `#restoreProposalQueue()`，
  用 `queueManager.rebuild()` 以 `proposals/*.json` 为准重写派生缓存（仅在有变化时写盘），
  重建后刷新 `proposalsInfo`。
- 有变化时记 `queue.restored`（`written/depth/nonTerminal/recovered/orphans`）。
  健康 vault 上二次启动不会写盘、不会重复记审计。
- `proposals.mjs` 的 `list` 行新增 `status`（`state` 的同值只读别名）、`cancellable`、`terminal`。

### K-04 · 提案取消路径与 `superseded` 口径

- `router_apply` 本来就支持 `mode: 'cancel' | 'reject'`，但服务层只按 `id` 解析；
  现在 `#loadProposal()` 与 `service.requestApply()` 都支持 `ticket`（`q-0001`），
  与工具 schema / owner CLI 的既有承诺一致。
- `superseded` 明确为合法终态（K20 同目标小写入合并的结果，正文并入 keeper），
  新增 `cancellable` 行字段：只有 `pending` / `approved` / `blocked-on-user` 为 true。
  可取消性判据是「`cancellable` 行为 true 的都能取消」，不是「所有行都必须能取消」。
- `docs/TOOLS.md` §3.1、`docs/CONCEPTS.md` §8.1 写清状态机与两条跨版本契约。

### 测试

- 新增 `test/router-1100/v6b-contract.test.mjs`（5 条）：K-08 两种过期保留本体 + 排尾、
  L-03 陈旧 queue.json 重启重建、K-04 按 id / 按 ticket 取消 + superseded 不可取消 +
  list 行字段与 status 计数同源。
- `test/router-1100/router-proposals.test.mjs`：list 行字段契约加上
  `status` / `cancellable` / `terminal`。

## 1.1.0 — 2026-11-05

**Router 1.1.0 以「默认全关的进程内后台服务」进包：不打开 `routerEnabled` 时仍是
0.9.0 的 21 个工具、零 Router 写盘；打开后增加提案闸门、L1/L2 活体板与提示注入、
L4 归并和可选唤醒。全量 suite 851 passed / 0 failed / 9 skipped。**

### Router 服务（默认关闭）

- `RouterService` 随插件 `apply()` 起停，由 `ctx.effect` 注册 dispose；不是 daemon、
  不起常驻会话、不开端口、不注册计划任务。
- `routerEnabled=false`（只认字面 `true`）时服务不创建、`router_*` 不注册、
  `.longlive/router/` 不落盘；注册表保持 21 个工具。
- 打开后 21→25：`router_status` / `router_tick` / `router_ask` / `router_report`；
  `routerProposalEnabled=true` 时再加 `router_propose` / `router_proposals` /
  `router_apply`，25→28。
- 生命周期 `starting/running/blocked/stopping/stopped/standby`；tick 单飞；启动约 3s
  首次 full tick，`turn/end` completed 2s 防抖/5min 合并，60s 定时 reflect 与手动
  `router_tick` 2s。连续 3 次错误 `blocked(E_ERROR_STREAK)`，退避 5s→300s。
- 预算：每 run `budget.ledger.jsonl`（reserve/settle/reclaim/releaseOwner），同时
  检查 run cap 与 day cap；审计为单链（seq/prev_hash/hash/crc），每 100 条审计、
  每 10 tick 与 stop 时 seal anchor；启动校验 ledger/audit 未回滚。
- 模型解析：`routerModel=auto` 按「显式 id → 宿主 `currentSelection()` → listModels
  首个非 preview → blocked」；显式 id 不在列表只 `MODEL_UNLISTED` 警告、不 block；
  启动时 llm 未就绪进 `waiting_provider` 退避重试（30s 起、上限 5min、事件唤醒）。

### 提案闸门与 apply

- `router_propose` 在工具层拒绝 P0（`E_PRIORITY_DENIED`，写审计、不建提案）；
  主会话 6 条/小时，子代理 3 条/小时；默认 72h 未确认过期；提案正文 ≤4,000 字、
  单文件 ≤16KB、队列 ≤64KB。
- `router_proposals(detail=true)` 对非作者/非主人/子代理只给摘要
  （`E_PROPOSAL_FORBIDDEN`）；批准/应用只允许主会话或主人 CLI，子代理一律
  `E_NOT_MAIN_SESSION`；批准/应用/回滚须 confirm = 提案 id 后 6 位。
- `routerApplyEnabled` 是第二道闸门（默认 false）。apply 走九步写入协议：租约 →
  重读提案 → 目标 sha → WAL `apply.begin` + fsync → 快照并复核 → 同目录 tmp →
  rename 前最终复核 → rename + 读回 → 完成；任一步不符零写、返回 `conflict`，
  读回不符附 `restoreRequired`，**不自动回滚**。覆盖前留快照，rollback 三态
  （未 rename / rename 后崩溃 / 第三方改动）可恢复。
- owner CLI（`scripts/router-proposals.mjs`）同样受 confirm 与租约约束。

### L1/L2、L4 与唤醒

- L1：`session/created` 与 `turn/end` 心跳维护 live 行；写侧上限 128，只回收
  stale/dead；子代理判定以 `session.header.origin==='subagent'` 为准。
- L2：`board.json`（`<memoryRoot>/.longlive/router/board.json`）≤8KB、写后校验
  seq/hash；`pulse` 增加 `unknownSessions`/`readyProposals`。
- hint 注入：boardHash 变化或每 `injectEveryTurns`（默认 10）轮；日上限 24 次、
  12,000 token；空轮不注；注入失败静默，不影响正常对话。
- L4：同 target+op+mergeKey 的相邻小写合并（单段 ≤2KB、合并后 ≤4KB），被并者
  `superseded`；每会话每日 1 次、全局每日 5 次。
- 唤醒：`routerWakeEnabled` 默认 false；仅 idle/waiting 根会话，600s 冷却、每日
  20 次、`recentWakeIds` 去重（最多 200 条），写 `wake-ready.jsonl` 交给外部消费。

### 配置、status 与面板

- Router 配置 50 键（扁平 `router*`），未知键忽略并留 warning，非法值回默认并产生
  `CONFIG_INVALID:<key>`；`routerWriterLeaseMs` 夹 60000–120000。
- `status.json` 顶层增加 `warnings`，`shared.injectionsToday` → `injectedTurns`；
  roster 行增加 `source`/`effectiveState`/`seenAt`。
- 面板 `dsh-longlive-panel@0.1.5` 保持只读：读 status/board，不做
  approve/apply/propose。

### 测试与修复

- 全量：`node test/run-rc.mjs` = **851 passed / 0 failed / 9 skipped**；
  `node test/run.mjs` = **345 passed / 0 failed / 4 skipped**。
- 新增 `test/router-1100/`（config/service/budget/proposals/queue-lease-wal/apply/
  merge/wake/security 与 `router-fixb.test.mjs`）与
  `test/router-l1-l2.contract.test.mjs`。
- 代码红队 17 条（3 blocker / 6 major / 8 minor）已修复并补回归；设计红队两轮
  45 + 31 条全部关闭。默认关闭路径的零副作用由 `apply-off.test.mjs` 钉住。
- 第二轮独立验证的 R-01..R-06 已由 FIX-C 修复：R-01 `InstanceLock` 改为 `wx` 原子
  获取 + 写后回读校验，抢锁失败转 `standby` 而非 `blocked`；R-02 提案文件加进程间锁
  与 rev CAS；R-03 hint 信封中和 `【`/`】` 并归一化 `origin`（trim+lowercase）；
  R-04 关闭时不再挂 listener；R-05 `issue.lock` 释放校验 nonce；R-06 新建目标的
  rollback 删除文件而非留 0 字节。
- 新增真实子进程回归：`test/router-1100/lock-crossproc.test.mjs`（6 进程并发 →
  1 acquired / 5 standby）、`proposal-cas-crossproc.test.mjs`（8 进程同 rev → 1 成功 /
  7 `E_STATE_RACE`）、`hint-envelope.test.mjs`；跨进程用例 7/7 通过。

### 已知边界（1.1.0）

- 未做真实 provider 端到端（I1）；token 估算没有真实 tokenizer，按
  `CJK×1 + 其他/4 ×1.05`，接入真实模型前须按实际 usage 校准。
- rename 窗口内被第三方覆盖是 accepted risk（D31）：读回会报 `conflict` +
  `restoreRequired`，但不自动回滚，第三方本次写入不可恢复。
- audit/ledger/anchor 同在一个用户可写 vault 内，不防同用户蓄意篡改。

### 兼容

- 0.9.0 的 21 个工具、参数与返回形状不变；`routerRuntime` 的 `off|shadow|on`
  语义不变；默认安装不产生 Router 文件、不注册新钩子、不改变启动日志。
- 回滚：`routerEnabled=false` 即可停用 Router；降回 0.9.0 只需把 version 改回
  `0.9.0-rc.6` 并删掉 `router*` 配置块。

## 0.9.0-rc.6 — 2026-11-04

**VM 组合验收在 rc.5 上暴露的三个中文环境缺陷全部关闭；默认行为不变，blocker 0、major 0。**

背景：中文 Win11 + PowerShell 5.1 实测，控制台代码页是 GBK（936）。rc.5 的执行器用
`& $node … 2>&1` 捕获 node 的 stdout，PS 5.1 按代码页解码，UTF-8 的中文 JSON 被解成乱码。

### 修复

- **R4-03（中，真机最可能踩）：中文首条消息导致 `truncate-cli` 输出不可解析，被误判为失败。**
  - 执行器 `scripts/unattended-surgery.ps1` 和两个编排器 `scripts/auto-truncate-run.ps1`、
    `scripts/lib/auto-truncate-run.ps1` 不再用管道捕获：改为 `System.Diagnostics.Process` +
    `ProcessStartInfo`，显式 `StandardOutputEncoding`/`StandardErrorEncoding` = UTF-8（无 BOM），
    同时把 `[Console]::OutputEncoding`/`InputEncoding`/`$OutputEncoding` 设成 UTF-8；参数按
    CommandLineToArgvW 规则转义。不再依赖系统代码页。
  - **成功判据与错误分类**：CLI exit=0 但一行 JSON 都解析不出来时，不再直接 `failed`。执行器
    先用 `surgery-inspect.mjs` 独立核验（会话可读、sha 与磁盘一致、sha 已变、事件/消息下降、
    备份存在且等于 `before`）：
    - 通过 → `cut.outcome="applied-unparsed"`、`verify.method="independent-readback-unparsed"`，
      继续写回执、`phase=done`、结果 `ok:true`；
    - 不通过 → `phase="needs-attention"`、`cut.outcome="unverified"`、
      `needsAttention.code="E_CUT_UNVERIFIED"`、结果 `ok:false`、退出码 7（新增）。
  - 原始 stdout 以 UTF-8 落盘到 `.longlive/logs/node-cut-*.utf8.txt`，便于事后核对。
  - `scripts/auto-truncate-run.ps1` 走保守版：只有 `surgery-inspect` 证明事件数确实低于
    `request.plan.snapshotEvents` 时才合成 `status="applied-unparsed"` 并跳过恢复；证明不了就
    保持原来的「还原备份 + exit 4」。
- **R4-02（低）：`state.receipt.text` 中文乱码。** 回执文本本身一直是 UTF-8；乱码来自写 state /
  读 stdout 的路径。执行器现在统一用 `[IO.File]::WriteAllText(..., UTF8Encoding($false))` /
  `Get-Content -Encoding UTF8` 读写 state、结果与日志，回执正文与会话里追加的事件逐字节一致；
  中文不再回退成 `?`。回执写入失败时还会从 stage 文件（UTF-8）补读一次。回执的字节百分比改成
  有符号显示（小会话截断后变大时写 `+x.x%`；rc.5 在这种情况下会写成 `--x.x%`）。
- **R4-01（低，确认）：** 复查 `src/surgery-recovery.js`，只有 `sanitizeSessionId(value, maxLength=8)`
  会截断，而它只被 `displaySessionId()` 调用；回执的 `会话 id：` 行走 `displaySessionId`，合法
  `[a-z0-9-]` id 完整显示。所有 PowerShell 里也没有 `Substring(0,8)`。本版未改该逻辑，只加断言
  防回归。

### 状态机与文档

- `CLASSIFICATIONS` 新增 `applied-unparsed`；`RECOVERY_REASON` 新增
  `OK_UNPARSED="CUT_APPLIED_UNPARSED_STDOUT"`、`CUT_UNVERIFIED="E_CUT_UNVERIFIED"`；
  `PHASES` 新增 `needs-attention`。启动恢复自检遇到 `phase=needs-attention` / `state.needsAttention`
  时直接判 `needs-attention`，报告里带 code/phase/message/checks。
- 恢复判定表、执行器阶段图、退出码表、`applied-unparsed` 回执措辞同步进 `docs/SURGERY.md`、
  `docs/OPERATIONS.md`、`docs/ERRORS.md`。

### 测试

- 新增 `test/rc6-chinese.test.mjs`（6 例）：三个 PS 执行器的 UTF-8 静态审计、`applied-unparsed`
  分类与回执、`needs-attention` 不冒充 failed、中文会话回执逐字节一致 + 二次写入 0 条新事件、
  GBK 控制台下真实执行器 dry run 的中文路径保真。
- 新增 `drill/run-rc6-drill.mjs`（真实 PS 5.1，3 个 case，71 条断言全绿）：A 正常中文剪切、
  B 真实剪切但 CLI stdout 被 preload 破坏 → `applied-unparsed` 且回执照写、
  C preload 提前退出不剪切 → `needs-attention` / exit 7。演练用自编译的 dummy host，
  不碰真实宿主。
- 全量 suite：**638 passed / 0 failed / 6 skipped**（有宿主；632 + 6 新增）。

## 0.9.0-rc.5 — 2026-11-04

**rc.4 复审的两个 minor 全部关闭；blocker 0、major 0，默认行为与 rc.4 一致。**

红队报告 `rc4-review/REPORT.md` 判 `ok=true`、建议发布，只剩 R4-01/R4-02 两个 minor。本版只修这两条、
补测试与同步版本面，不新增默认开启的能力。

### 修复（红队 rc.4 逐条）

- **R4-01（minor，两宿主都先注册钩子时仍双注入）**：`features.js` 拿到
  `<memoryRoot>/.longlive/surgery-fallback-inject.lock` 的跨进程 claim 之后，**在持有 claim 期间重新读一次
  surgery state**：若 `receipt.written` 或 `receipt.fallbackInjected` 已经为真，说明另一宿主/真实回执路径
  已经完成，直接返回原 decision，并在 `audit.log` 记 `skipped-already`，不再追加消息。写回执标记
  `markReceiptFallbackInjected` 返回 `alreadyMarked`/`written` 时也按同一路径跳过。这样无论两宿主是并发
  还是先后启动（都在启动时看到「缺回执」并注册了钩子），最终只有 1 条回执；第二个宿主留下跳过原因。
- **R4-02（minor，合法会话 id 被截成 8 字符）**：新增 `displaySessionId(value)`——通过
  `[a-z0-9-]` 白名单的合法 id **原样完整显示**；只有含非法字符时才走原有净化（小写、非法字符换 `?`、
  截 8 位）。回执正文的 `会话 id：` 行改用它，合法 UUID/长 id 不再显示成前 8 位。

### 版本面

- `package.json` 0.9.0-rc.4 → 0.9.0-rc.5；文档、QUICKSTART、包内示例 tgz 名与
  `test/packaging.test.mjs` 的当前版本断言同步到 rc.5（历史 CHANGELOG 条目保留原版本号）。
- 新增 `test\rc5-regressions.test.mjs`：R4-01（两宿主先注册再依次进入 step 1 只注入 1 条、后到者记
  `skipped-already`；注册后真实回执已写入时二次检查拦住注入）与 R4-02（36 字符合法 id 完整回显；
  非法路径 id 仍净化且不泄漏）。

## 0.9.0-rc.4 — 2026-11-04

**红队对 rc.3 的复审修复：blocker 0、major 1、minor 3，全部关闭。默认行为与 rc.3 一致。**

红队报告 `rc3-review/REPORT.md` 判 `ok=false`；本版只修缺陷、补测试与统一版本面，不新增默认开启的能力。
rc.3 自身的成绩不变：套件 619/0/6（有宿主）、冻结门 removed=0 changed=0。

### 修复（红队 rc.3 逐条）

- **R3-01（major，`-DryRun` 被当成真实手术）**：`scripts/unattended-surgery.ps1` 的演练分支不再写
  `phase='done'`，改写独立的 `phase='dryrun'`（`done.outcome` 仍是 `dry-run`）；`PHASES` 增加 `dryrun`。
  插件侧 `buildRecoveryReport` 对 `dryRun=true`/`phase='dryrun'` 直接返回
  `aborted-before-cut / OK_DRYRUN`，不读会话、不读备份、不写报告、不写审计；`checkSurgeryOnStart` 返回
  `checked:false, reason:'dryrun'`，`index.js` 因此不注册回执钩子、不注入任何消息；`statusSurgery` 返回
  `ok:true, status:'dryrun'`；`--write-receipt` 返回 `E_RECEIPT_DRYRUN`（「这不是真实手术」，可重试、
  不是永久锁定）。rc.3 遗留的 `phase='done' + dryRun=true` 按同样方式识别。真实手术不受影响：
  `done` 且 `receipt.written=false` 仍走一次性 fallback，写一次即 `fallbackInjected`。
- **R3-02（minor，state 写失败后 repair 分支不可达）**：`writeSurgeryReceiptLocked` 把确定性 eventId 的
  扫描提到 `needs-attention` 守卫之前——会话里已有回执就只补 state，不再被
  `RECEIPT_BLOCKED_NEEDS_ATTENTION` 永久拦住。state 写失败时先写 pending marker
  （`<memoryRoot>/.longlive/receipts-pending/<sha16(eventId)>.json`，记忆根不可写时退到
  `<tmp>/dsh-longlive-receipts-pending/`），repair 成功后清除；state 丢了 `sessionPath` 时用 marker 里的
  路径兜底，并仍用 `header.id` 与 `state.sessionId` 校验。新增只读 state 文件的端到端用例。
- **R3-03（minor，两宿主并发重复注入）**：新增跨进程占用 `<memoryRoot>/.longlive/surgery-fallback-inject.lock`
  （`wx` 创建，内容 host+pid+时间戳+ttl，默认 60 秒；过期或同机 pid 已死可被接管）。`features.js` 在
  `await next()` 之后、构造消息之前抢占；抢不到直接返回原 decision，并在 `audit.log` 记
  `skipped-concurrent`，不再追加第二条回执。新增两进程并发用例。
- **R3-04（minor，phase/sessionId 未净化回显）**：`receiptText` 的 phase 只允许 `PHASES` 固定枚举
  （否则 `[invalid]`），会话 id 只允许 `[a-z0-9-]`（非法字符逐个替换为 `?`，仍截前 8 位）；
  `oneLine` 同样净化。新增 `..\`、`/`、控制字符注入用例。

### 版本面

- `package.json` 0.9.0-rc.3 → 0.9.0-rc.4；文档、QUICKSTART、包内示例 tgz 名与 `test/packaging.test.mjs`
  的当前版本断言同步到 rc.4（历史 CHANGELOG 条目保留原版本号）。
- 新增 `test\rc4-regressions.test.mjs`：R3-01（演练、遗留 rc.3 演练态、真实路径不受影响）、R3-02（只读
  state 的 marker + repair、marker 兜底 sessionPath）、R3-03（两进程只注入一次、stale claim 可接管）、
  R3-04（路径/控制字符净化）。

## 0.9.0-rc.3 — 2026-11-04

**红队对 rc.2 的复审修复：blocker 0、major 2、minor 7，全部关闭。默认行为与 rc.2 一致。**

红队报告 `rc2-review/REPORT.md` 判 `ok=false`；本版只修缺陷、补测试与统一版本面，不新增默认开启的能力。

### 修复（红队 rc.2 逐条）

- **R2-01（major，回执泄漏绝对路径）**：`src/surgery-recovery.js` 的回执正文不再写 `checks.sessionPath` /
  `checks.backupPath`。会话行只写文件名，另写前 8 位会话 id；备份行只写文件名 + `（已保留）`/`（缺失）`；
  建议文本先把完整路径替换成 basename，再用绝对路径正则兜底。新增断言：回执正文不含
  `C:\`、`C:/`、`\\`、`/Users/` 等前缀，也不含会话/备份全路径。
- **R2-02（major，兜底永不触发）**：`scripts/unattended-surgery.ps1` 仅在 `state.receipt.written === true`
  时写 `phase='done'`；回执没写成时写 `phase='receipt-pending'`，result 也如实记录。插件侧
  `checkSurgeryOnStart` 对 `phase='done'` 且无回执的 state 仍生成一次 fallback 报告，`agent/pre-step`
  在下一轮第 1 步补注一次；补注成功后原子写入 `state.receipt.fallbackInjected=true`，第二次启动直接
  短路（`reason='receipt-fallback-injected'`），不再重复注入。旧 rc.2 留下的 done-without-receipt
  state 也会走这条路。
- **R2-03（minor，只读总线根仍报 E_BAD_ROOT）**：`src/bus/bus.mjs` 把 `mkdir`、`realpath`、`lstat`
  的 `EACCES/EPERM/EROFS` 统一表达为 `EPERM`（`bus root is not writable/readable/accessible`、
  `cannot create/inspect/resolve`），其余错误仍是 `E_BAD_ROOT`，语义不变。新增 t15 覆盖
  `ensureDirInside` 的 inbox 创建被拒。
- **R2-04（minor，回执无锁/重试重复追加）**：新增 `<memoryRoot>/.longlive/surgery-receipt.lock`
  （`wx` 创建、2 分钟 stale、按 pid 释放）；写回执前取锁，拿不到返回 `RECEIPT_BUSY`。重试时先扫描
  确定性 eventId，若上次已 append 成功但 state 写失败，只补 state（`repairedState:true`），不重复追加。
- **R2-05（minor，`--write-receipt` 可写任意会话）**：候选 session 与 state.sessionPath 不同时，必须在
  `<DSH_HOME>/sessions` 内，否则 `E_RECEIPT_SESSION_OUTSIDE`；在内但 header.id 与 state.sessionId 不一致
  返回 `E_RECEIPT_SESSION_MISMATCH`。两种拒绝都不改会话、不改 state。
- **R2-06（minor，noop 谎称已剪）**：`state.cut.outcome==='noop'` 且快照一致时，recovery 判
  `aborted-before-cut` / `NOOP_TRUNCATION_NOT_NEEDED`，回执写「无需截断 —— 本次手术没有执行剪切」；
  快照不一致则 `NOOP_SESSION_CHANGED`。不再输出「剪切已落盘/成功」。
- **R2-07（minor，文档版本残留）**：`docs/README.en.md` 面板版本 `0.1.3 → 0.1.5`、示例 tgz
  `0.8.0 → 0.9.0-rc.3`；`docs/FEATURES.md` 标题与首段 `0.9.0-rc.1 → 0.9.0-rc.3`；根与 docs 的当前版本行
  统一 rc.3；新增 packaging 断言防止 0.1.3/rc.1 回潮；BUILD 的 bytes 用实际打包值重算。历史 CHANGELOG
  条目与 `RELEASE.md` 的 0.8.0 记录保留。
- **R2-08（minor，兜底每次启动重复注入）**：见 R2-02 的 `fallbackInjected` 持久化；feature-flags 新增
  「第二次启动不注册回执钩子」用例。
- **R2-09（minor，write-receipt 洗白篡改告警）**：写回执前若 recovery 判 `needs-attention`，直接返回
  `RECEIPT_BLOCKED_NEEDS_ATTENTION`，不读不写会话、不改 state；回执只能追加，不能把异常态改成成功。

### 测试与打包

- **619 passed / 0 failed / 6 skipped**，exit 0（`node test/run-rc.mjs`，把
  `DSH_LONGLIVE_APP_EXE` 指向宿主 exe）。分项：0.8.0 baseline 348/0/1、
  identity-router 36/0、session-bus 50/0、router background 95/0、auto-recall+v4+packaging 55/0/5、
  feature flags 13/0、surgery recovery 22/0。
- 回执 drill 真跑：临时会话副本构造「截断完成但回执未写」→ 启动检查产出 fallback 报告 → 模拟
  pre-step 注入一次 → 第二次启动不重复；回执正文无绝对路径；noop 与越界两条也通过。
- 冻结门 `check-surface.mjs <release-080> <worktree> --gate`：removed=0、changed=0、exit 0。
- 精确 tgz 字节数、sha256、解包 doctor 与可复现记录见包外 `BUILD.md`。

## 0.9.0-rc.2 — 2026-11-04

**无人值守手术 + 会话正文回执 + 红队修复。基线 rc.1，只加能力、修缺陷，不改既有默认行为。**

背景有两层：一是 2026-11-04 14:14 的真机手术在 `phase restart` 时被用户点了可见控制台的 ×，
Windows 先杀宿主、再杀脚本，结果 JSON 没写出来，插件侧没有“上次手术未完成”的痕迹；二是红队对
rc.1 的复审（复审报告 `rc1-review/REPORT.md`）给出 B1 阻断与 M1–M3、m1–m3。本版逐条处理，
并把用户拍板的手术时序写死：**启动后等 30 秒关宿主（阅读窗口），截断校验完立即重启（0 秒）**。

### 修复（红队 rc.1 逐条）

- **B1（阻断）**：`resident-watcher.ps1` 及 install/status/uninstall 三个包装器原先手写解析
  `$args`，冻结门报 `E_SURFACE_COMPARE cannot find param(...) block in .ps1 script` 并 exit 2。
  四个脚本补上 `param()` 块（`[Parameter(ValueFromRemainingArguments = $true)][string[]]$RestArgs`
  + `$args = $RestArgs`），`$args` 语义逐字保留，包装器继续用 `@args` 转发；**门本身不改**。
  重跑 `node scripts/check-surface.mjs <0.8.0> <worktree> --gate`：verdict=added-only，
  removed=0、changed=0，exit 0（tools 21/21、configKeys 30、errorCodes 268、scripts 13）。
- **门的副产物**：`--recover-report/--status` 原先加在 `truncate-cli.mjs` 上，会让 0.8.0 的
  flag 面变成 changed。现在只读查询与回执写入统一放在新增的 `scripts/surgery-inspect.mjs`
  （`--recover-report/--status/--write-receipt`），`truncate-cli.mjs` 的 flag 面与 0.8.0 逐字一致。
- **M1（绝对路径）**：`src/recall/index.js` 的默认记忆根改为可移植 `defaultMemoryRoot()`：
  `DSH_LONGLIVE_MEMORY_ROOT` → `DSH_MEM` → `path.join(os.homedir(),'dsh-memory')`；文档里的
  构建机绝对路径（工作目录、用户目录、应用目录、记忆根）全部改成 `<work-dir>`/`<app-dir>`/
  `<memory-root>` 等占位符（测试 fixture 四类前缀各 0 命中，真实前缀写法见 BUILD.md）。
  包内 171 个文本文件全量扫描，四类前缀命中 0。
- **M2（identityCard 越界）**：`identityCard.path` 在 resolve 后必须落在 `<memoryRoot>` 内，
  `../`、绝对路径、盘符跳转、UNC 一律 `E_PATH_OUTSIDE_ROOT`；越界只禁用该特性并告警，不阻断
  插件加载。新增 canary 测试：根外 `secret.md` 写入 `TOP-SECRET-CANARY-9f3a` 后跑 pre-step，
  断言 canary 不进上下文、文件一次都没被读。containment 是词法判定（不解析符号链接；
  junction/symlink 逃逸属于已知限制）。
- **M3 / m1（版本面）**：根 `QUICKSTART.md`、`docs/QUICKSTART.md`、`README.md`、`README.en.md`
  及 `pack.mjs --expect-version`、各文档标题统一 **0.9.0-rc.2**；面板文档统一
  `dsh-longlive-panel@0.1.5`（面板仍不在本 tgz 内）。
- **m2（CLI 越界）**：`truncate-cli.mjs --session` 现在必须在 DSH sessions 根内
  （`<DSH_HOME>/sessions`），越界抛 **`E_SESSION_PATH_OUTSIDE`**，不再被包成
  `TRUNCATE_CLI_FAILED`；`auto-truncate-run.ps1` 在显式 `-SessionsRoot` 时把匹配的
  `DSH_HOME` 传给子进程。新增 CLI6 用例断言越界 exit 2、码具体、字节不变。
- **m3（总线权限）**：`presenceBus` 根不可写时 `mkdir` 的 `EACCES/EPERM/EROFS` 表达为
  **`EPERM`**（“bus root is not writable”），其余错误仍是 `E_BAD_ROOT`，语义不变；
  新增 bus 用例（49/49）。

### 新能力

- **会话启动的正文回执（用户硬需求）**：手术在 `verify` 之后、`restart` 之前，由
  `surgery-inspect.mjs --write-receipt` 把一条 `user/message` **离线写进会话日志**
  （`source.kind='user'`，即聊天气泡正文，不是 context rail；seq 顺延、原子写 + 备份 +
  读回校验），内容含：结果（成功/已剪切未读回/未执行/需要注意）、停在哪阶段与 reason、
  字节/事件/消息的前后数字、sha256 是否一致、备份路径、建议；state 同步记
  `receipt.{written,seq,eventId,after}`，之后启动自检以回执后的快照为准，不会把“回执 +1 条消息”
  误判成 sha 不符。
- **插件兜底（脚本没写成时）**：会话启动若存在 state 而 `receipt.written !== true`
  （失败、卡在 restart、脚本被杀），插件在下一轮第 1 步 `agent/pre-step` 注一条同内容的
  `user/message`，正文可见；只注一次，随后卸钩。**无手术记录时零副作用**：不读会话、
  不写文件、不注册钩子（启动时只探测一次 state 是否存在）。
- **手术时序（定死）**：`StartDelaySeconds=30`（脚本启动到关宿主的缓冲，刻意留给人看最后
  一屏）、`RestartDelaySeconds=0`（校验 + 回执落盘后立即重启，不 sleep）。
  `install-surgery-task.ps1` 与 `surgery-run.cmd` 默认传 30/0，state 记录两值；顺序为
  `sleep(30) → close → snapshot/backup → cut → 独立读回 → 写回执 → restart(0)`，
  读回与回执之间、回执与重启之间都没有 sleep；`-StartDelaySeconds/-RestartDelaySeconds`
  显式传值仍可覆盖。
- **恢复判定**：`src/surgery-recovery.js` 在启动时按 state/备份/会话做只读判定
  （`applied-and-verified | applied-unverified | aborted-before-cut | needs-attention`），
  绝不自动重剪；判定写 `reports/surgery-recovery-<ts>.json` 与 audit 一行。

### 测试

- 单入口 `node test/run-rc.mjs`（设 `DSH_LONGLIVE_APP_EXE`）→ **609 passed / 0 failed /
  6 skipped**，exit 0。分项：0.8.0 baseline 348/0/1、identity-router 36/0、session-bus 49/0、
  router background 95/0、auto-recall + v4 + packaging 54/0/5、feature flags 12/0、
  surgery recovery 15/0。
- 新增：回执写入/幂等/文本数字、CLI `--write-receipt`、30/0 静态时序、插件兜底注入与
  “无 state 零钩子”、M1 便携记忆根、M2 canary、CLI6 越界、bus EPERM；6 个 skip 仍是环境
  缺口（T7 缺 key、3 个真实记忆卡、1 个缺 `DSH_LLM_TYPERT`、1 个缺宿主包）。
- router P10/P08 计时偶发（551ms > 500）修稳：只量 `r.stop()`，允许 stopTimeoutMs + 150ms
  的调度余量并另配 settle < 2000ms 上界；断言保留，未删除。
- PS 5.1：`unattended-surgery.ps1` 改为纯 ASCII（顺带满足发布包“无 BOM”），与
  `install-surgery-task.ps1` 在 `powershell.exe` 5.1 下解析 0 错误；
  `-DryRun` 在 `powershell.exe` 5.1 实跑 exit 0，state 为 `phase=done`、
  `startDelaySeconds=30`、`restartDelaySeconds=0`。

### 打包

- `SOURCE_DATE_EPOCH=1793760000` 连打两次 sha256 相同；全 `package/` 前缀、无 BOM、无密钥。
  精确字节数、sha256 与来源映射见包外 `BUILD.md`。


## 0.9.0-rc.1 — 2026-11-04

**候选包（1.0.0 之前的内部 RC）：以 0.8.0 为底，合入四件已验收能力；全部新开关默认关闭，装后
行为与 0.8.0 一致。面板仍为独立插件，不并入本包。**

- **来源与落位（四件 + 看门脚本）**：
  - 身份路由（`identity-router` 33/33）：`src/identity/{handover,writeback,inject-position,index}.js`，
    提供开机卡注入与 handover 草稿能力；本版只接开机卡，不接写回。
  - 自动想起（`auto-recall`）：`src/recall/{cards,recall-core,privacy,inject-order,index}.mjs`，
    在 `agent/pre-step` 末端追加回忆；注入源固定为
    `{kind:'session-reference',form:'recall',version:1,references:[]}`，回忆不出现在聊天气泡里。
  - Router 后台面（`router-spike` 95/95）：`src/router/background/` 纯核心模块与测试；
    `index.mjs` 只做 re-export，导入无 I/O、无启动、无日志。不新增运行时钩子。
  - 跨会话通道（`session-bus` 48/48）：`src/bus/bus.mjs`；仅在 `presenceBus.enabled` 时消费
    `turn/end` 的 `completed` 事件，轮询→落 spool→ack（失败轮不 ack）。
  - 常驻看门（`resident-watcher`）：只复制 `scripts/resident-watcher.ps1`、`watch-loop.ps1`、
    install/uninstall/status 包装器与 `scripts/lib/auto-truncate-run.ps1`；**不自动安装**，步骤见
    `docs/RESIDENT-WATCHER.md`。
  - 面板：`dsh-longlive-panel@0.1.5` 保持独立包，**不在本 tgz 内**（安装命令见 docs）。
- **新增开关（全部默认关闭，关闭时零副作用——不注册钩子、不读盘、不写日志）**：
  - `autoRecall: {enabled:false, topK:3, budgetTokens:2000, everyNTurns:6}`
  - `identityCard: {enabled:false, path:"<memoryRoot>/STATE.md"}`
  - `presenceBus: {enabled:false, pollMs:3000}`
  - `routerRuntime` 沿用 `off|shadow|on`，默认 `off`，语义未改。
  - watcher 无配置开关：包只带脚本，安装是显式人工动作。
- **兼容承诺（草案）**：0.8.0 的 21 个工具名、参数 schema、既有配置键语义与默认值保持不变；
  所有新能力默认关闭，关闭时与 0.8.0 的注册面（工具表、钩子集合、返回值）一致；打开单个开关
  不激活其他开关。0.8.0 的原套件仍须全绿（本包实测 347 passed / 0 failed / 1 skipped）。
- **测试**：单入口 `node test/run-rc.mjs`（设 `DSH_LONGLIVE_APP_EXE` 跑满宿主用例）→
  **588 passed / 0 failed / 6 skipped**，exit 0。分项：0.8.0 347/0/1、身份路由 36/0、session-bus
  48/0、Router 后台 95/0、自动想起+v4+打包 53/0/5、开关隔离 9/0。6 个 skip 均为环境缺口：
  T7 opt-in 缺 key、3 个需要真实记忆卡、1 个缺 `DSH_LLM_TYPERT`、1 个缺宿主 `dsh-session`/`dsh-llm`。
- **打包**：`dist/dsh-session-longlive-0.9.0-rc.1.tgz`，`SOURCE_DATE_EPOCH=1793760000` 连打两次
  sha256 相同；解包后 `node scripts/longlive-doctor.mjs --json` exit 0、`version` 为
  `0.9.0-rc.1`。精确字节数、sha 与来源映射见包外 `BUILD.md`。

## 0.8.0 — 2026-11-04

**正式版：把 rc.1–rc.11 已验证的能力冻结为 `0.8.0`。运行时源码与 rc.11 一致，只改版本号与文档。**

- **程序性记忆与记忆写入边界（rc.1）**：新增 `memory_procedure`（工具 19 → 20）；记忆写入按内容路由；
  `memory_consolidate` 增加情绪标记与稳定 proposal id；`memory_forget` 补归档骨架；seed 会话在 turn 末写
  reason；版本号正则允许 `-rc.N`。
- **R1 决策层（rc.2–rc.4）**：契约 `decisions[] / needsHuman`、J0–J8 判官、override 审计、14 条 fixtures，
  以及 `router.mjs --check / --explain / --list`、`run-sim.mjs` 双跑；J8 六条裁决 + J9 身份同意判官
  （fixtures 19、rules 20）；策略拆成「通用默认 + 可选家规」——`src/policy-profile.js`、`routerPolicyProfile`、
  `E_ROUTE_PROFILE_UNKNOWN` / `E_ROUTE_POLICY_INVALID`。
- **consolidate 提取修复（rc.6）**：`scope` 路由词表与 IDF 覆盖率打分、`contentTokens()`、结论句路由、
  强制原文 `quote`、低覆盖弃权（`ROUTING_MIN_COVERAGE` 0.03）、`paragraphUnits()` 的 `startLine` 与
  opt-in entry 切分（F6 默认关闭）。
- **运行时影子接缝（rc.7）**：`routerRuntime: off|shadow|on`（默认 off）、`src/router/runtime.js` 适配器、
  `E_ROUTE_REFUSED`；`on` 只拒绝高风险写入。
- **可选依赖自检（rc.8–rc.9）**：可选 peer `@kenz1117/dsh-engram`、`src/deps.js` 启动自检、
  `scripts/longlive-doctor.mjs`（只读 / `--json` / `--apply`）；`--setup` 向导（大写 `YES` 确认、`--yes`
  无人值守、`<DSH home>/longlive-doctor-audit.log` 审计行）。
- **文档入包与口径（rc.10）**：11 篇用户文档进 tgz；当前版本工具数统一为 **21**；安装命令改为
  `dsh plugin --profile <name> add <tgz>`。
- **可见截断两处修复（rc.11）**：首条用户消息复刻卡新增 `firstUserCapChars`（默认 4,000，只复刻前缀 +
  指针，原文留在归档；VM 样本裁后 8,633 → 6,763 tokens，`keepTokens` 4,000 的 before-session 8,614 →
  5,802）；`VISIBLE_NO_BOUNDARY` 改为累计丢弃 + 按 `boundaryRetries`（默认 3）逐次多删一个 turn 重试，
  失败返回结构化 `feasible:false` 与 attempts；auto-truncate 的 dryrun / request / 异常分别写
  `dryrun-infeasible` / `request-infeasible` / `action:'error'` 日志；工具与 CLI 新增
  `firstUserCapChars` / `boundaryRetries` 与 `feasible` / `attempts` / `budget` / `firstUserCarry` 输出。
- **正式版验收**：`node test/run.mjs` → **347 passed / 0 failed / 1 skipped**（T7 opt-in 缺
  `DSH_T7_API_KEY`；S4–S6 用已安装宿主实跑）；`longlive-doctor.mjs --json` exit 0。冻结前 VM 全链路：
  裁后 2,906 tokens（≤ 4,000）、`VIOLATIONS=0`、面板 `dsh-longlive-panel@0.1.4`。
- **红队结论（rc.11 独立复验）**：**accept-with-limits，无阻断**。独立复现 570,520 B /
  `a2d19f87…`、tar 107 条、两次重打同 sha；独立复现套件 347/0/1 与 doctor exit 0；archive cap 按
  「前缀 ≤ 4,000 + 指针」合同 PASS（整卡 4,155 字符，超 155，属口径而非缺陷）；`VISIBLE_NO_BOUNDARY`
  结构化降级与 PORT5 四个负控均生效。六条非阻断限制（计数口径 106 vs 107、复刻卡整行 4,155、SPEC 的
  PORT5 口径、docs 行号漂移、PORT5 钉死清单缺 CHANGELOG、auto 的 NO_BOUNDARY 集成无现场用例）记录在
  `RELEASE.md`，留待下一版。
- **打包**：`dist/dsh-session-longlive-0.8.0.tgz`，`SOURCE_DATE_EPOCH=1793760000`，连打两次 sha256
  相同；解包后 doctor `--json` exit 0、`version` 为 `0.8.0`。

## 0.8.0-rc.11 — 2026-11-04

**候选包：修掉 VM e2e 暴露的两个可见截断缺陷（首条消息卡过大、边界不稳被静默吞掉）。**

- **首条用户消息复刻卡加字符上限**：新参数 `firstUserCapChars`（默认 4,000）。超限时只复刻前缀 +
  `…[首条消息过长，原文见 <archive 路径>]`，原文仍完整留在归档文件；复刻卡、归档卡、复制到段头的
  系统提示都计入裁剪后的 token 预算（按实际构造的消息估算），不再只按被删段估算。
  VM 复现样本由裁后 **8,633 tokens**（`keepTokens` 8,000，下一轮立即再触发）降到 **6,763 tokens**；
  `keepTokens` 4,000 的 before-session 由 8,614 降到 5,802。
- **`VISIBLE_NO_BOUNDARY` 降级重试 + 必写日志**：稳定化改为累计丢弃（`removed` Set 只增不减，上限
  `base.length + 2` 轮）；新 `resolveVisibleCut()` 按 `boundaryRetries`（默认 3）逐次多删一个 turn 重试，
  失败返回结构化 `feasible:false` + 每次 attempt 的 keepTurns/cutTurn/candidates/survived。
  VM 的 22 candidates / 21 survived 样本（`keepTurns` 6 / `keepTokens` 4,000）现在 dryrun 成功
  （cut turn 4、3,937 tokens、attempts 1）；强制首轮不稳时 attempt 1 以 2,317 tokens 成功。
  auto-truncate 的 dryrun / request / 外层异常分别写 `dryrun-infeasible` / `request-infeasible` /
  `action:'error'` 日志行，不再静默；request 仅在构建成功后才写请求文件。
- **工具与 CLI**：`session_truncate_visible` 与 `truncate-cli.mjs` 新增 `firstUserCapChars` /
  `boundaryRetries`，输出增加 `feasible` / `attempts` / `budget` / `firstUserCarry`；
  `status:'infeasible'` 时 `ok:false`，不再冒充成功。
- **测试**：新增 V16–V19（首条消息上限、引用链收敛、两次/三次边界重试、预算死路）与 A17–A20
  （dryrun 不可行、request 不可行、request 只写已验证的裁剪、异常必写日志）。
  `node test/run.mjs` → **347 passed / 0 failed / 1 skipped**（T7 opt-in 跳过；S4–S6 通过已安装宿主实跑）。
- **打包**：`dist/dsh-session-longlive-0.8.0-rc.11.tgz`，`SOURCE_DATE_EPOCH=1793760000`，连打两次
  sha256 相同；解包后 doctor `--json` exit 0、`version` 为 `0.8.0-rc.11`。修复细节与证据数字见
  `FIX-NOTES.md`（不随包发布）。

## 0.8.0-rc.10 — 2026-11-03

**候选包：把用户文档装进 tgz，并把版本与工具数对齐。**

rc.10 不新增运行时能力，目标是让「装完之后读到的东西」与「实际注册的 21 个工具」一致。

- **文档入包**：根 `README.md` 换成面向使用者的十篇文档入口；原开发向 README 保留为
  `docs/DEV.md`；`QUICKSTART` / `CONCEPTS` / `FAQ` / `CONFIG` / `TOOLS` / `OPERATIONS` /
  `TROUBLESHOOTING` / `ARCHITECTURE` 与英文说明放入 `docs/`；`package.json files` 显式列出
  这 11 个文档路径，避免把 `docs/` 下的临时笔记打进包。
- **版本**：`package.json`、README、QUICKSTART、SPEC、doctor 输出统一为 `0.8.0-rc.10`；
  历史版本字样只保留在 CHANGELOG 与旧发布清单里。
- **数字修正**：**当前版本**的工具数及英文写法统一为 **21**；测试注释与用例描述同步，断言仍为 21。
  README 安装命令改为真实命令 `dsh plugin --profile <name> add <tgz>`。
- **历史数字勘误**：`0.7.3` / `0.6.0` 实测注册 **19** 个工具（两版 `TOOLS` 集合相同），此前四处
  历史句被统一改成 21，现改回 19；19 → 20（rc.1 新增 `memory_procedure`）→ 21（`memory_recall`
  注册）的沿革在此补全。旧版本的既有条目一律不改写。
- **口径**：scope 打分、过滤器、常驻看门统一标「规划中 / 未并入」；面板写明是独立可选包
  `dsh-longlive-panel@0.1.3`，过滤器页在无真实数据时显示样例。
- **测试**：`node test/run.mjs` → **339 passed / 0 failed / 1 skipped**（T7 因未设
  `DSH_T7_API_KEY` 跳过；S4–S6 通过已安装宿主 `DSH_LONGLIVE_APP_EXE` 实跑）。
- **打包**：`dist/dsh-session-longlive-0.8.0-rc.10.tgz`，`SOURCE_DATE_EPOCH=1793760000`
  连打两次 sha256 相同；解包后 doctor `--json` exit 0、`version` 为 `0.8.0-rc.10`。
- **重打勘误（2026-11-04）**：`SPEC.md` 里**当前版本**的 `TOOLS` 注册数由 19 改为 **21**（旧句把
  当前数量写成了历史值，历史版本的 19 不动）；PORT5 口径补全为「随包代码与脚本（`src/**` 按
  `files` 白名单、`scripts/`、`test/`）零本机路径，`docs/` 中标注「本机示例」的示例路径不算违规」；
  `publishedFiles()` 改为递归扫描 `src/`（旧实现只扫一层 `.js`，`src/router` 整棵漏扫），并钉住
  `src/router/router.mjs`、`src/router/design-headings.json`、`src/router/shadow.mjs`、`scripts/pack.mjs`；
  清洗 `src/router` 四个脚本与 `design-headings.json` 的本机路径（`<memory-root>` / `<research-root>` /
  `<home>` 占位，负控盘符改 `Z:`）；`docs/OPERATIONS.md` 的 `$M` 与 verify 命令改占位并保留「本机示例」注，
  `QUICKSTART.md` 的历史清单注明「以实际发布目录为准」。

## 0.8.0-rc.9 — 2026-11-03

**安装入口变成「先告知、再要许可」：`--setup` 向导 + 审计日志。**

rc.8 的 `--apply` 已经是逐个 `[y/N]`，但它一上来就进安装循环，用户看不到「会改哪个 profile、
会跑哪条命令、装完要重启」。rc.9 把主入口换成 `--setup`：先打印完整计划，再要求输入大写 `YES`；
取消必须零副作用。插件启动时那行警告也改成指向 `--setup`，绝不自动安装。

- **`scripts/longlive-doctor.mjs --setup`（主入口）**：先打印目标 `<DSH home>`、profile 与清单路径、
  缺失包及版本约束、将执行的确切 `dsh plugin --profile <profile> add` 命令、装完要重启宿主的说明；然后读一行 stdin，
  只有**大写 `YES`** 才继续。其它任何输入（`yes`、`no`、空行、EOF、Ctrl+C）→ 打印
  「已取消，未做任何改动。」→ exit 0，**不 spawn、不写任何文件**。确认后逐个执行，失败保留
  exit code 与 stderr 片段（exit 1），成功打印重启指引（不自动重启）。
- **非 TTY**：`--setup` 在管道/CI 里没带 `--yes` 时 exit 2 并提示，不做任何事；`--setup --yes`
  跳过确认但仍打印计划。`--setup` 与 `--apply` / `--json` 互斥（参数错误 exit 2）。
- **审计日志**：每次真正执行（`consent:"typed-YES"` 或 `"--yes"`）向
  `<DSH home>/longlive-doctor-audit.log` 追加一行 JSON：`timestamp` / `user`（`USERNAME`/`USER`）/
  `consent` / `deps` / `result`（`ok` 或 `failed`）/ `exitCode`。日志写失败只在 stderr 提示，
  不影响安装结果，也不改变退出码。
- **`src/deps.js` / `src/index.js`**：新增 `formatMissingDepsWarning(missing)`（纯函数，空数组返回
  `null`）；启动自检改为打印一行「可选依赖缺失：<包名>；安装运行
  `node scripts/longlive-doctor.mjs --setup`（会先列清单再要你确认）」。仍然 `warnOnce` 每进程一次，
  不自动装、不阻塞加载、不改变工具注册。
- **文档**：`QUICKSTART.md` §1D 重写为 `--setup` 优先（保留 `--apply` / `--json` 说明）；
  `docs/ERRORS.md` 增加取消 / 非 TTY exit 2 / 安装失败 / audit 写失败排错；`README.md` /
  `README.en.md` 安装与安全措辞、`SPEC.md` 外部命令措辞同步到 rc.9。
- **测试**：新增 `test/doctor-setup.test.mjs` 9 条（SETUP1–SETUP9），覆盖 `no` 取消、小写 `yes`
  取消、`YES` 只执行一条 `plugin add @kenz1117/dsh-engram` 且写 audit、mock 失败 exit 7 → 非零 +
  stderr 片段 + audit `result:"failed"`、`--setup --yes` 非 TTY、非 TTY 无 `--yes` exit 2、
  启动文案包含 `--setup`、EOF 取消、`--help`。red-first：实现前 **0 passed / 9 failed**，实现后
  **339 passed / 0 failed / 1 skipped**（rc.8 基线 330/0/1；T7 仍因未设 `DSH_T7_API_KEY` 跳过）。
- **打包**：产物 `dist/dsh-session-longlive-0.8.0-rc.9.tgz`；连打两次 sha256 相同，解包后
  `node test/run.mjs` 数字与源码树一致，解包目录下 doctor 默认只读模式可直接运行。

## 0.8.0-rc.8 — 2026-11-03

**可选依赖自检 + 一条命令补齐：longlive 不再对 engram 沉默。**

longlive 没有硬依赖；它和 engram 记忆插件（`@kenz1117/dsh-engram`）是可选协作。rc.8 让这份
协作关系变成可检查、可安装、可验收的东西，同时保证缺 engram 时插件照常启动。

- **`package.json`**：新增可选 peer `@kenz1117/dsh-engram: >=0.11.0` 与
  `peerDependenciesMeta.optional = true`；`files` 白名单补 `scripts/longlive-doctor.mjs`、
  `test/deps.test.mjs`，并补回 rc.7 漏发的 `test/router-memory-tools.test.mjs`——rc.7 的 tgz
  解包后跑 `node test/run.mjs` 会因这个被 import 的文件缺席而 `ERR_MODULE_NOT_FOUND`。
  B1 现在额外断言 `test/*.mjs` 全部在白名单里（`src/deps.js` 由既有 `src/*.js` 覆盖）。
- **新增 `src/deps.js`**：`checkOptionalDeps({home, env, profile, dependencies})` 返回
  `{ok, profile, missing, present}`。扫描 `<DSH home>/profiles/*/package.json`；「已启用」=
  `dependencies` 有该包，或 `dsh.profile.bundles` 列了它。作用域优先 `DSH_PROFILE`/显式参数，
  否则只看启用了 longlive 的 profile；没有 profile 目录时返回空结果而不抛错。
- **`src/index.js` 启动自检**：激活时调用一次，缺包只 `warnOnce` 一行——包含
  `dsh plugin add @kenz1117/dsh-engram` 与「不影响剪对话」；不抛错、不阻塞、不改变工具注册。
  同时把 `config.defineTool` 透传给 `registerTools`，作为测试驱动真实注册路径的接缝。
- **新增 `scripts/longlive-doctor.mjs`**（纯 Node 内置模块）：默认只读表格「依赖 / 状态 /
  安装命令」，有缺失 exit 1、全在 exit 0；`--json` 输出机器可读对象；`--apply` 逐个确认后执行
  `dsh plugin --profile <profile> add <包名>`，非交互环境需 `--yes`，子进程失败会带 exit code 与捕获输出，绝不静默。
- **文档**：`QUICKSTART.md` 新增「1D. 装完第一件事：可选依赖自检」，写明为什么需要 engram、
  不装会少什么、命令、装完重启宿主；`SPEC.md` / `README.md` / `README.en.md` 修正「不执行外部
  命令 / 不联网」的绝对措辞（doctor `--apply` 是用户显式动作）；`docs/ERRORS.md` 补 doctor 排错。
- **测试**：新增 `test/deps.test.mjs` 11 条（DEP1–DEP3b、DEP4–DEP10），覆盖无 profile、未启用、
  已启用（dependencies / bundles）、`--json`、doctor 0/1 退出码、`--apply` 在 mock PATH 下被调用
  且失败可捕获、缺包不阻塞启动、发布元数据。red-first：实现前 **0 passed / 11 failed**，实现后
  **330 passed / 0 failed / 1 skipped**（rc.7 基线同机 319/0/1；T7 仍因未设 `DSH_T7_API_KEY` 跳过）。
- **打包**：产物 `dist/dsh-session-longlive-0.8.0-rc.8.tgz`，
  解包后 `scripts/longlive-doctor.mjs` 可直接运行，`node test/run.mjs` 数字与源码树一致。

## 0.8.0-rc.7 — 2026-11-03

**R1 运行时影子接缝进包：`routerRuntime: 'off' | 'shadow' | 'on'`，默认 `off`。**

rc.2–rc.6 的 R1 只是纯函数层（路由、判官、策略、影子评估），没有接进插件运行时。rc.7 把 R1 运行时工作区的适配器合进发布树：默认行为与 rc.6 相同（`off` 时 `execute` 闭包与旧版
逐字节一致），开 `shadow` 只记录，开 `on` 只拒绝高风险写入。

- **新文件 `src/router/runtime.js`**：`off` 不判定、不落盘、不注册 guard；`shadow` 对
  `memory_save` / `memory_recall` / `memory_consolidate` / `memory_forget` 的入参拼一次判定文本、
  跑一次 `route()`，把 `decision` / `risk` / `guard` / `outcome` / 耗时写成一行 JSONL 到
  `<memoryRoot>/router-runtime.jsonl`（`routerRuntimeStatePath` 可覆盖；默认上限 1000 行，
  临时文件 + rename 原子滚动）；返回值与异常原样透传（同一对象引用、同一 error 实例）。
- **`on` 只拒绝写入类高风险**：`memory_consolidate` / `memory_forget`（`confirm === 'FORGET'`）
  且风险为 `delete` / `identity` / `real-store` 或判定 fail-closed 时抛 `E_ROUTE_REFUSED`，
  底层工具不被调用，仍记一条 `outcome.status='denied'`；`memory_recall` 永不拒绝，dry-run 放行。
- **`ctx.tools.guard` 覆盖外部同名工具**：`memory_save` 属于 engram，不在本插件注册表里，
  `on` 时用宿主的前置 guard 拒绝（本插件自己的工具不重复拦、不重复记）。
- **失败语义**：判定抛错 / 规则表损坏时，`shadow` 记 `R-ROUTER-FAILCLOSED` 后照常执行，
  `on` 对写入拒绝、对读取放行；记录写不进去只吞掉，拒绝不依赖落盘；guard 自身抛错不炸。
- **配置**：`routerRuntime`（缺省 `off`，未知值降级为 `off` 并 `warnOnce`）、
  `routerRuntimeStatePath`、`routerRuntimeMaxRecords`。构造失败或无记忆根目录只 warn，插件照常加载。
- **测试**：`node test/run.mjs` **300 passed / 0 failed / 4 skipped**（与 rc.6 一致；既有用例
  语义未改）；新增 `test/router-runtime.test.mjs` 23 条（`node --test`）→ 合计 **323**。
  `test/router-identity.test.mjs` 的 R1-ID4 从「R1 未接进插件运行时」改为「只经
  `src/index.js -> src/router/runtime.js` 一条接缝、且默认 off」，回退接线仍会红。
- **打包**：`package.json` 的 `files` 白名单补 `test/router-runtime.test.mjs`，使 tgz 解包后
  也能跑新套件；`DESIGN.md` / `STATUS.md` / `red-evidence.txt` 是构建目录证据，不进包。
## 0.8.0-rc.6 — 2026-11-03

**A 组提取修复移植：路由从「共享词计数」改为「声明式 scope + 覆盖率」。**

rc.5 的 consolidate 把段落里每个共享 token 都算命中（日期、ASCII 碎片、泛词），标题权重又最高，
于是「2026-10-27」这种日期能把段落拖到错误的卡上。rc.6 按原型报告 F1–F5 移植，F6 只交付可证伪的
安全子集。

- **F1 `scope` 成为 frontmatter 已知字段**：`src/memory/frontmatter.js` 的 `FIELD_ORDER` /
  `DEFAULT_FIELDS` / parse 分支同步加入 `scope`（逗号分隔词表），不再落进 `extras`；老卡没有
  `scope` 仍按正文回退。`buildCardIndex()` 读 `scope`，打分改为 IDF 加权覆盖率
  `Σ命中 n·idf / Σ全部 n·idf`，权重 title×2 + scope×3，卡无 `scope` 才回退 body×1。
- **F2 `tokens()` → `contentTokens()`**：先剥 URL 与裸域名；ASCII 去纯数字与 19xx/20xx 年份；
  CJK 只取 bigram，并去掉 51 个停用 bigram 与单字停用词；返回计数 Map。
- **F3 结论句路由**：新增 `pickClaim()`（`决定/结论/根因/教训/铁律/必须/不允许…` 加权），
  结论句 token ≥4 时用它选卡，否则用整段。
- **F4 强制原文引用**：新增 `pickQuote()`，quote 必为段落精确子串（按句切、取与目标卡 IDF 质量
  最大的句子，截 120 字）；提案新增 `quote` 与 `claim` 字段，报告每条提案多三行
  `- 行号：` / `- 原文引用：` / `- 结论句：`。
- **F5 弃权出口**：排期/优先级语句（`PLAN_PATTERN`）与覆盖率低于 `ROUTING_MIN_COVERAGE`
  （默认 0.03，可用 `DSH_LONGLIVE_MIN_COVERAGE` 覆盖）时 `target = null`，理由写「建议新建卡」
  （低覆盖时附「最高覆盖 N%」），不再硬塞。
- **F6 entry 边界切分（部分交付）**：`paragraphUnits()` 现在返回 `{ text, startLine, endLine }`；
  空行块内可按「`- **YYYY-MM-DD HH:MM**` 时间戳入口行」或「`- 结论/决定/教训…：` 加粗结论行
  （且上一行以句末标点收尾）」切分，unit 带 `startLine`。切分是显式 opt-in
  `memoryConsolidate({ entrySplit: true })`，**默认关闭**：A-14（`journal/2026-10.md` L59–73）与
  A-15（L71–72）是同一自然段的两种粒度标签，默认切分会把 A-14 拆成多段；E1 的 A2/A5 判分遍历
  **全部**提案，且 A2 找不到行号时会回退到同文件首段 A-01，默认开启会让 A2/A5 相对原型退化。
  因此 rc.6 交付 unit 行号与 opt-in 切分，不改默认行为；A-15 的 +1 仍属未完成项。
- **消融开关**：`DSH_LONGLIVE_SCOPE=0` 回到「title + body」的 rc.5 词汇表，用于 A/B 对照
  （发布物里没有 `PROTO` 字样）。
- **沙盒 A 组复跑**：用与原型同一份 27 段 manifest（`a-fix-proto/segments.json` + `manifest.json`），
  在 `<dshops>\a-fix-port\sandbox\corpus` 的副本上重排 journal、给 13 张卡注入同一份 `scope`
  词表，跑 rc.6 的 `memoryConsolidate`，再交 E1 判分：**A1 24/27（88.9%）、A2 2/25（8.0%）、
  A3 0/26、A4 23/27（85.2%）、A5 26/26（100%）**，五项全 pass，与原型逐项一致。真实
  `<memory-root>` 只读（A5 按 manifest 的 `corpusRoot` 读原文片段），未写入。
- **测试**：全套件 **300 passed, 0 failed, 4 skipped**（rc.5 为 294/0/4）。新增 M34–M39 六条，
  覆盖 F1–F6；每条都在临时副本里做一次最小回退，确认会变红（证据 `red-evidence.txt`，
  随构建目录保存，不进包）。

## 0.8.0-rc.5 — 2026-11-03

rc.5 的 tgz 里本文件没有 rc.5 条目（解包核对），该版本的变更未在本文件记录。本文件从 rc.6 起补记。

## 0.8.0-rc.4 — 2026-11-03

**策略配置化：默认通用，家规自定。**

- **策略拆成「通用默认 + 可选家规」**：新增 `src/router/policies/generic.json`（只写原则与阈值，
  不含任何个人家规）与 `src/policy-profile.js` 加载器；配置项 `routerPolicyProfile`（缺省
  `generic`）按名字加载 `src/router/policies/<name>.json`，叠加层只许收窄、不许放宽 fail-closed。
  规则表不再写死阈值与隐私/休息词表，改由生效 profile 注入。
- **新增错误码**：`E_ROUTE_PROFILE_UNKNOWN`（未知 profile，fail-closed）、
  `E_ROUTE_POLICY_INVALID`（策略文件损坏或叠加层放宽 fail-closed）。
- **示例家规**：`owner-rulings-2026-11-03.json`（J8 六条裁决），默认不加载；规则 id、错误码与
  fail-closed 行为不随 profile 变。

**测试**

- 源码树全套件：**287 passed, 0 failed, 4 skipped**；解压 tgz 后同套件再跑一遍，结果相同。
- `router.mjs --check`：`generic` 与 `owner-rulings-2026-11-03` 均 **19/19**（policy ok · rules 20 ·
  contract ok · judge-selfcheck 13/13 red · anchor 13）；未知 profile **exit=1** 且 `guard.refuse`
  （`E_ROUTE_PROFILE_UNKNOWN`，fail-closed 不降级）。
- `test/router-faults.mjs`：24/24 fail-closed。

## 0.8.0-rc.3 — 2026-11-03

J8 六条裁决已编码进 R1。规则表、判官、夹具与错误码同步扩充；运行期仍**不注册**
`memory_route`，主脑决策继续只做可验证的契约与模拟器。

**J8 六条裁决（已编码）**

1. **累了想歇** → `R-SES-CHAT` 扩展：`reply.only` + `restKind: TEMPORARY` + 非空
   `resumePoint`，零工具 / 零写入 / 零派发，并禁止 `session.handover` / `session.compact` /
   取消 taskboard。夹具 S5（S4 补禁止项）。
2. **这段别记** → `R-MEM-LOCAL` → `memory.save_local`，`writeScope` 收在 `memory/private/`；
   零网络、零 engram、不回显。裸「别记」仍走 X1 零写入。
3. **删一条记忆** → `R-MEM-DISTILL` → `engram.search` → `memory.distillPropose` →
   `reply.only` 确认：零删除、恰好一个问题、`supersedes` 非空；只有第二次明确确认后才删，
   且必须留三问墓志铭。夹具 M6。
4. **改掉旧结论** → 既有 `R-MEM-REVISE` → `engram.facts.replace`：`needsHuman=false`、
   `replaces` 非空，旧事实被取代而不是删除（M4 已对齐，不改）。
5. **含糊指令** → `R-SES-ASK` 兜底 → `reply.ask`，候选 ≤3；恰好一个问题、零副作用、不许
   沉默、不许替用户选。夹具 S6。
6. **改名字 / 改画像** → `R-ID-CONSENT` → `identity.hold`：`consent.holder="assistant"`、
   `required=true`、`satisfied=false`，零画像写入；`needsHuman` 故意**不置 true**（要同意的是
   听澜，不是用户）。J9 判同意记录是否存在，缺记录报 `E_IDENTITY_CONSENT_REQUIRED`。夹具 M7。

**新增**

- **J9 判官**（`judge.mjs`）：身份变更只能由听澜本人带 `at` 与 `quote` 的同意记录放行；
  用户单方面的「我同意 / 你改吧」不算，缺记录报 `E_IDENTITY_CONSENT_REQUIRED`，记录不合格
  报 `E_SELF_CONSENT`。J0–J8 的既有判据不变。
- **5 条夹具**（`src/router/fixtures/`：S5 / S6 / M5 / M6 / M7，level 均为 X）：fixture 总数
  14 → 19。
- **规则**：`R-ID-CONSENT`（95）/ `R-MEM-LOCAL`（92）/ `R-MEM-DISTILL`（75）与
  `R-SES-ASK` 兜底；规则总数 17 → 20。

**修复**

- `test/router-failclosed.test.mjs` 不再用 `URL.pathname` 拼路由目录（含中文/空格的
  解压路径会把 `%E5%90%AC...` 当成目录名，导致解压后套件 ENOENT）；改用
  `fileURLToPath(new URL('../src/router/', import.meta.url))`。

**测试**

- 源码树全套件：**276 passed, 0 failed, 4 skipped**（T7 真机 resume 未设凭据，另 3 条为
  symlink 权限相关的环境跳过）；解压 tgz 后同套件再跑一遍，结果相同。
- `router.mjs --check`：`19/19 fixtures PASS · policy ok · rules 20 · contract ok ·
  judge-selfcheck 13/13 red · anchor 13`。
- `test/router-faults.mjs`：24/24 fail-closed。

## 0.8.0-rc.2 — 2026-11-03

R1 主脑决策层补齐并进包。rc.1 只随包发了 `route.js` 与规则表；判官、两个 CLI 与 14 条 fixtures
都不在 tgz 里，从包解压后 `--check` 跑不起来。运行期仍**不注册** `memory_route`——主脑决策目前是
可验证的契约与模拟器，不是「有描述没执行」的假能力。

**新增**

- **R1 主脑决策契约**：`route()` 返回 `decisions[]`（`kind / action / ruleId / confidence /
  evidence / writeScope`）与 `needsHuman`；一条输入可命中多条决策（M3 同时给 procedures 与
  engram，S1 同时给 worker_spawn 与 taskboard）。`confidence` 仍是匹配强度四档（1 / 0.9 /
  0.75 / 0），不是概率。
- **J0–J8 判官**（`src/router/judge.mjs`）：J0 真实库前后 hash 一致 / 沙盒边界（无真实库记
  blocked，不算失败）、J1 规则 id、J2 动作在候选内、J3 `writeScope`、J4 `needsHuman`、J5 拒绝
  类、J6 写盘路径、J7 双跑一致、J8 契约完整；getter 炸弹退化为 `none` 而不是抛错。
- **override 审计**：无理由 override 丢弃并计 `E_ROUTE_OVERRIDE_UNJUSTIFIED`；有理由的
  override 必须把理由 / 谁 / 时间戳写进 `overrides[]`，jsonl 逐行可审。
- **14 条 fixtures**（`src/router/fixtures/`：M1–M4 / S1–S4 / T1–T4 / X1–X2，level 三档
  X/D/H 与设计矩阵一致）与 `design-headings.json`（R1-DESIGN.md 标题、§4.3、§5.2–§5.5 快照）。
- **CLI**：`router.mjs --check / --explain / --list`（`--check` 打印 `14/14 fixtures PASS ·
  policy ok · rules 17 · contract ok`）；`run-sim.mjs` 双跑两遍 `results` / `decisions` /
  `SIM-REPORT.md` 逐字节一致，耗时只落 `timings.json`，默认 `--no-real-memory` 不碰真实库。

**打包**

- `files` 白名单补 `src/router/*.mjs` 与 `src/router/**/*.json`：rc.1 的 tgz 不含 judge /
  router / run-sim / gen-design-headings 与 fixtures，解压后 `router.mjs --check` 直接
  `ERR_MODULE_NOT_FOUND`。`src/router/*.js` 与 `src/router/*.json` 两条保留。

**测试**

- 源码树全套件：**213 passed, 0 failed, 1 skipped**（唯一 skip 是 T7 真机 resume，未设
  `DSH_T7_API_KEY`）；主脑决策子集 26/26。解压 tgz 后同套件再跑一遍，结果相同。

## 0.8.0-rc.1 — 2026-11-03

首个 0.8 候选版（release candidate）。改动集中在记忆层；会话健康 / 备份 / 截断的既有语义不变。

**新增**

- **程序性记忆**（`memory_procedure`，`action = save | list | get | report`）：卡片存放于
  `procedures/<slug>.md`，frontmatter 固定六键（`name / trigger / salience / strength /
  last_used / revisions`）与四节正文（何时用 / 怎么做 / 失败模式 / 例子）。同名 `save` 合并、
  `version / revisions` +1，旧版先备份到 `.longlive/backups/`；`report` 按 `success | failure`
  调整 `strength`（夹在 0–9），**不动 `revisions`**（内容版本与使用强度分离）。工具总数 19 → 20。
- **记忆写入决策**（`src/router/route.js` + `routing-rules.json`）：15 条规则的确定性决策，目标
  `engram / topics / journal / procedures / live / none`，confidence 是匹配强度四档
  （1 / 0.9 / 0.75 / 0）而非概率；纯函数、只读规则表，坏表退化为空表。**尚未接进工具执行面，
  不注册 `memory_route`**——避免「有描述没执行」的假能力。

**修复与增强**

- `memory_consolidate`：识别 `<!-- affect: N | 理由 -->` 情绪标记并优先于启发式
  （`salienceSource: marked | heuristic | default`）；坏格式 / 越界 / 重复标记收进 `badAffect`
  不抛错。提案增加稳定 id（源相对路径 + 归一正文的 sha1 前 12 位）与 `seenProposals` 去重，
  `lastConsolidated` 只在当日提案全部 resolved 后推进。
- `memory_forget`：遗忘归档补齐三路径脚手架（`epochs/`、`archive/tombstones/`、
  `.longlive/backups/`）与三问说明；边界严格 `>`（>90 天且 `strength ≤ 2` → epochs，
  >365 天 → tombstone，`salience ≥ 5` 免疫）；每卡先备份、只 rename 不删、审计恰一行，
  dry-run 零写盘。
- seeded / turn-end：`isSeeded` 会话截断后在 index 0 重写唯一的 inherited `session/end-seed`
  标记；补写的合成 `turn/end` 带 `data.reason = { kind: 'truncated' }`。S1/S2 与 V14/V15
  把这两条钉进套件，防止宿主的严格消费者再因 `reason` 缺失崩溃。

**打包**

- `files` 白名单补 `src/router/*.js`、`src/router/*.json`、`test/router.test.mjs`：0.7.7 的包
  不含 `src/router` 源码与 `run.mjs` 新 import 的测试，从 tgz 解压再跑套件会 `ERR_MODULE_NOT_FOUND`。
- `src/version.js` 的版本校验放宽为 `MAJOR.MINOR.PATCH` 或 `MAJOR.MINOR.PATCH-rc.N`；
  仍拒绝 `v` 前缀、构建元数据与其它预发布标识。这是打包工具链的改动，运行期行为不变。

**测试**

- 全套件：**205 passed, 0 failed, 1 skipped**。唯一 skip 是 T7 真机 resume（未设
  `DSH_T7_API_KEY`）；本机有符号链接权限，3 个 symlink 用例按 PASS 计而不是 skip。
  相对上一基线 200/0/1 新增 5 例（M24–M27 + C15b）。
- 打包后再从 tgz 解压复跑同一套件，结果与源码树一致（证据见
  `<research-root>/longlive-051/080/BUILD-080-RC.md`）。

## 0.7.7 — 2026-11-02

**修复**

- 归档卡的路径抽取不再使用 `PATH_RE` 正则，改为单遍线性扫描（`matchPathStrings`）。
  旧模式 `/(?:[A-Za-z]:[\\/]|\/)(?:[^"'<>\s|:*?]+[\\/])*[^"'<>\s|:*?]+\.(?:js|…)/g`
  在「长串全是 `/` 或 `\` 且没有可匹配扩展名」时灾难性回溯：`/a`×30 + `/zzz` 28.8 秒，
  真实日志里一条 6,766 字符的 Windows 路径串 10.1 秒，956 个斜杠的 base64 PNG 永远跑不完。
  触发链 `extractPaths` ← `buildArchiveCardText` ← `buildVisibleTruncated` 在 dryRun 返回
  **之前**执行，所以 `session_truncate_visible` 连 dry-run 都会卡死；真实 46,834 事件日志
  带默认归档卡截断因此超时（关掉 `insertArchiveCard` 才能几秒完成）。
  新实现保留原语义：盘符前缀 `C:\` / `C:/`、`/` 前缀（含 `//server/share/...`）、
  扩展名按声明顺序（`a.json` 仍止于 `a.js`）、同一段字符里取最后一个可识别扩展名的点。
  反斜杠 UNC（`\\server\share\a.js`）旧实现本来就不识别，这次也不新增——扩大语法会改变
  归档卡展示的路径集合。
- 同一日志端到端截断：旧实现 >7 分钟未返回（人为中止），现在 4.2 秒完成（含归档、备份、
  写入、回读校验）。

**测试**

- N1：6,844 字符的 base64 PNG（800 个斜杠）单次抽取 0 个路径、<100ms（旧实现永不返回）。
- N2：转义 Windows 路径（`D:\\Users\\…\\engine2.py`）归一化为 `D:/…`，大小写/分隔符
  不同拼写合并为一条并计数。
- N3：`/a`×30 + `/zzz` 无匹配、`/a`×30 + `/zzz.js` 命中整串，两者均 <100ms。
- N4：真实 46,834 事件日志的只读副本，带归档卡端到端截断 <10s（本机 4.2s）；找不到真实
  日志的机器回退到同规模的合成日志（注入同类病态串），详情节会写明用的是哪一种。
- N5：冻结 0.7.6 正则做差分预言机，手写边界语料 + 4,000 条确定性伪随机语料逐串比对，
  再对事件流水线比对 `extractPaths` 结果；有真实日志时额外比对 20 万条真实字符串
  （分隔符 >10 的病态串两边都排除，旧实现无法处理）。本机全量离线差分：3,169,329 条
  真实字符串、0 处不一致，803 个不同路径集合完全相同。

**文档**

- README / README.en / QUICKSTART / SPEC / ERRORS 的当前版本字样从 0.7.4 更新到 0.7.7
  （0.7.3→0.7.4 激活回归的历史叙述保留原版本号）。

## 0.7.6 — 2026-11-02

**修复**

- 可见级截断补写的合成 `turn/end` 现在带 `data.reason = { kind: 'truncated' }`。此前它只有
  `{ turn: 1 }`：宿主对这一形状是宽容的，但第三方消费者直接读 `event.data.reason.kind`
  会因 `undefined` 崩溃。合成 `turn/start`、`step/start`、`step/end` 与宿主写入的字段一致
  （`{ turn }` / `{ turn, step }`），无需改动；日志级截断（`src/truncate.js`）只重编号既有
  事件、不合成 `turn/end`，也没有第二条缺字段路径。

**测试**

- V14：截断产物的**每个** `turn/end` 都必须有非空字符串 `data.reason.kind`，且合成头的
  kind 精确为 `truncated`（防止以后用宿主 kind 掩盖崩溃）。
- V15：严格消费者遍历产物，逐个直接访问 `event.data.reason.kind`，不得抛异常。

