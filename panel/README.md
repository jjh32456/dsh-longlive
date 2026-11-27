# @jjh32456/dsh-longlive-panel

DSH（DeepSeek Harness）的 **longlive 只读面板**（潜望镜）：在 Web UI 里查看长活记忆的六层视图、
过滤器/影子记录、常驻 Router、召回流水、截断记录，以及 1.8.0 新增的
**断言-证据 / 冲突仲裁 / 审计导出 / 角色内核**视图。

1.8.1 新增：`GET /api/longlive-panel/summary` 的**可选只读** `autoProcedure` 块（自动经验候选的
运行态/计数/候选清单）；默认关闭时只有 `{enabled:false}`，不 stat、不读 staging。

1.8.2 新增：
- **改名修复**：longlive 1.8.12 把 npm 包名改为 `@jjh32456/longlive`；面板 v2 兜底加载先认新名、
  再认旧名，不再出现「面板脱钩 / v2 未实装」。
- **新页签「网络」**：edges（1.8.11，8 类关系边：supersedes / superseded_by / deprecated_by /
  conflicts_with / answers_with / derived_from / mentions / same_topic）+ links（1.8.8 词→卡学习链路，
  seed/learned 分布、权重 Top、最近学习、链路审计）。
- **新页签「蒸馏」**：卡 `lifecycle: canonical|historical`（1.8.11）计数与清单、迁移运行记录
  （`.longlive/lifecycle-migrations/`，只给相对路径与计数）。
- **本轮想起**追加「强制召回与链路」（1.8.8：forced / user-task / link 命中 / 归档兜底）；
  **截断记录**追加「自动截断口径」（1.8.10：12M token 外部日志阈值与 350k 上下文线解耦、infeasible 原因）；
  **六层视图**追加「活动窗（近 24h）」（1.8.8：先按时间、后按行数护栏）。

- 只读展示 + **受控动作**：动作只走 longlive M2-G 的 18 个契约动作名，宿主签发一次性能力令牌；
  面板不持有凭据、不直连 SQLite、不写记忆正文。
- 依赖：`@jjh32456/longlive`（peerDependencies `^1.8.12`；旧包名 `@jjh32456/dsh-longlive` 已删除，
  仅作为旧安装的兜底解析保留）。`autoProcedure` 块的数据由 longlive **1.8.6+** 写入；
  装在 1.8.5 上时该块自然为 `enabled:false`，其余功能不变。
- Node：`>= 22.13.0`（用宿主运行时）。

## 安装

```bash
dsh plugin add @jjh32456/longlive@1.8.12
dsh plugin add @jjh32456/dsh-longlive-panel@1.8.2
```

重启宿主后侧栏出现「潜望镜」。完整步骤、配置、kill switch、验证与卸载见
[INSTALL.md](INSTALL.md)。

## summary 契约扩展：`panelApiVersion = 2`（1.8.1）

`panelApiVersion` 是 summary 的**契约版本整数**（不是包版本号；包版本见 `version`）。
1.8.1 起 = `2`：只增不改义，未新增任何路由（只读路由仍 27、动作面仍 18）。

关闭时（`memory-state.json` 没有 `autoProcedure`，或显式为 `enabled:false`）：

```json
"autoProcedure": { "enabled": false }
```

开启时（longlive 1.8.6+ 的 `autoProcedure` 有产出）：

```json
"autoProcedure": {
  "enabled": true,
  "state": "ok",                 // "ok" | "stalled" | null
  "lastDraftAt": "2026-11-17T09:00:00.000Z",   // string | null
  "drafted7d": 3,                // number | null
  "rejects7d": 2,                // number | null（读不到为 null 且 degraded）
  "candidates": [                // ≤20 条最新
    { "slug": "example-run", "risk": "low", "createdAt": "2026-11-17T10:00:00.000Z", "status": "candidate" }
  ],
  "degraded": false              // 有 sidecar 被跳过/读不到时 true
}
```

约束（1.8.1 起冻结，随后续版本只增不改义）：

- **数据源只读且白名单**：`.longlive/memory-state.json` 的 `autoProcedure` 字段 +
  `.longlive/staging/auto-cards/procedures/*.meta.json` 的 sidecar；**不读**候选 `.md` 正文、账本、
  会话日志、`procedures/`、配置或凭据。
- **sidecar 读取上限**：≤20 条最新、单文件 ≤256 KiB、单次总读取 ≤1 MiB、非递归；
  slug 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$` 且拒 `..`/前导点/符号链接；
  坏 JSON / schema 不符 / 超限 → 跳过并 `degraded:true`，不崩、不猜。
- **只读零写**：不写记忆文件、不建目录、不建锁、不做 retention；无 approve/apply/promote
  端点或按钮，面板没有放行权。
- **隐私**：块内只有 slug / risk / 时间 / 计数，不含绝对路径、用户名、端口、sessionId、turn、
  callId 或候选正文。
- **文案**：任何展示层固定「候选（未审核，未生效）」，不得写「已入库/已生效/保证」。
- **兼容**：旧客户端忽略未知字段、继续消费 1.8.0 既有字段；旧 server 无该块时新客户端回落
  1.8.0 视图。`.integrity/manifest.sha256` 由宿主在**安装时**重签（用进程内存 key），tarball 不含。

## 开发/自测

```bash
node self-test.mjs
node --test gap-fixes.test.mjs
node --test auto-procedure.test.mjs
node client-smoke.mjs
node clean-env-smoke.mjs
node activation-probe.mjs
```

隔离源树里没有 sibling `longlive/` 时，后两个脚本用 `DSH_LONGLIVE_SRC=<longlive 包根>` 指向
longlive 源树（脚本只读 import 其 `src/ui|role|memory`）：

```bash
# bash
DSH_LONGLIVE_SRC=../longlive node activation-probe.mjs
# Windows PowerShell
$env:DSH_LONGLIVE_SRC='..\longlive'; node activation-probe.mjs
```

`auto-procedure.test.mjs` 的「默认关 summary 与 1.8.0 逐字节一致」用例需要 1.8.0 面板包根
（只作为环境变量传入，源码不含本机路径）：

```bash
# bash
PANEL_180_SRC=<1.8.0 面板包根> node --test auto-procedure.test.mjs
# Windows PowerShell
$env:PANEL_180_SRC='<1.8.0 面板包根>'; node --test auto-procedure.test.mjs
```

## Gate-2 面板门槛（维护者）

```bash
node --test test/panel-readonly.test.mjs test/panel-actions.test.mjs test/recall-v2/gov-routes-actions.test.mjs
node scripts/verify-ids.mjs
node activation-probe.mjs
```

**三组全绿**：① 静态计数（25 pass / 0 fail、27 路由/18 动作精确；`test/panel-gate-expectations.mjs` 为中心常量）；
② A7 脚本级（`verify-ids` 正例 EXIT 0；负例 `--expect-routes 26` / `--expect-actions 17` 必须 EXIT≠0 并输出差异）；
③ A7 面板活体（`activation-probe` status=activated、**22/22 checks**、fiveHundreds=0、EXIT 0；
含 1.8.1 的 `panelApiVersion=2` 与 `autoProcedure` 默认关检查）。

## License

MIT（见 [LICENSE](LICENSE)）。
