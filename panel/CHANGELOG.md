# Changelog · dsh-longlive-panel

## 0.2.6 — 2026-11-06

- 六层视图「活体心跳」重排：旧顺序按心跳从旧到新返回，已归档行最长，把运行中/空闲的会话挤到表格下面（用户 2026-11-06 当场指出「已归档的那么长，空闲和运行中的反而在下面」）。服务端 `summary.live` 与客户端展示统一改为 **运行中 → 空闲 → 其它活动态 → 已归档** 排序，同档位内心跳越新越靠前，末位按 sessionId 兜底保证顺序稳定。
- 已归档行折叠：活动行直接展开，`dead`（已归档）行收进 `<details class="fold">`，**默认折叠**、点开才占版面；折叠标题带条数与「心跳已停（超过 4×TTL）」说明。页头「活体心跳」角标从总行数改为活动行数（`N 个活动`），活动区为空时有单独空态文案。
- 新增回归：`client-smoke.mjs` 增活体排序/折叠/脏数据断言 14 条；`self-test.mjs` 断言首行 running、末行 dead、L1 口径与脏文件过滤。
- **红队 v1（独立子脑 65 条攻击断言）回执后修**：心跳未知（null/读不到）不再冒充「最新」而是排同档最后（RED-01/01b）；`state` 直查表的原型链键（constructor/__proto__）不再击穿排序与状态 chip（RED-03/03b）；`summary.live` 含 null 行不再让整页签进错误边界（RED-04）；折叠标题改成能覆盖全部成因且去掉未解释的「4×TTL」缩写（RED-02/08）；L1「工作记忆」卡与页头「N 个活动」统一口径（count=活动行数、unit=活动、已归档不再把 L1 常亮成「注意」）（RED-05）；脏 live 文件（数组/非字符串 sessionId/重复 sessionId）不再变成幽灵行或重复 key（RED-07）。
- **折叠改为按需物化**：收起时只渲染 `<summary>`（表格不挂进树），点开才挂 `LiveTable`（RED-06：折叠不能只藏 DOM）。真机 38 条已归档：收起态默认可见数据行 40→2；1000 条规模下收起态元素树 ~11,044→~34。
- `package.json` 版本升到 0.2.6；`INSTALL.md` 同步本机现状、六层视图说明与测试计数。
- 只动活体行排序/折叠/文案/CSS 与对应防御；接口契约、G1/G2 修复、只读边界、其余页签均未改动。

## 0.2.5 — 2026-11-06

- 文案定位从「截断为主」改为「共享大脑为主」：帮助页「它是什么」三句重写——先讲 longlive 的第一件事是让哪个会话都是同一个人（记忆卡/状态卡/开机卡放磁盘上，换会话、多开窗口、断线重连接上的都是同一段关系），再讲分层只是把最近发生的/长期结论/做事步骤分文件存放，最后才把截断记录、过滤器、影子记录收束为「卫生工具——那是打扫，不是身份」。
- 页签顺序调整：截断记录从第二位移到维护位，新顺序为 六层视图 → 过滤器决策 → 影子记录 → 常驻 Router → 本轮想起 → 截断记录 → 使用说明；`TABS` 只调显示顺序，id 不变。帮助页的页签列表同步为实际七个并改成同一顺序，截断记录标注「维护页：会话日志被剪短的账」。
- 「三个开关」改名「维护：截断的三个开关」，开头加一句「共享大脑平时用不到这些；只有会话太长、想让它自动减负时才动。」；「第一次用，四步」改成共享大脑优先：① 看六层视图活体行确认接上 → ② 开新会话验证开机卡把同一个你接回来 → ③ 看本轮想起/影子记录（怎么想起、怎么拦动作）→ ④ 最后才动截断开关（dryrun 先观察）。
- `package.json` 版本升到 0.2.5，description 改为「久视（longlive）共享大脑只读面板：先看有没有接上同一个我（六层视图/本轮想起/常驻 Router），再看过滤器决策/影子记录；截断记录是维护页。全只读。」
- `INSTALL.md` 同步页签顺序、七个页签列表与接口表，并把「七个页签取数」更正为「六个数据页签取数」。
- 只改文案、页签显示顺序与版本号；读写逻辑、接口契约、G1/G2 修复与 `gap-fixes.test.mjs` 均未改动。

## 0.2.4 — 2026-11-05

- 与 `dsh-session-longlive@1.4.0-rc.2` 配对发版；本版无功能代码改动，只同步版本号。
- 0.2.3 的「本轮想起」读取端已按写入侧字段 `{at, sessionId, turn, injected:[{id,title,score,reason}], blocked:[...]}` 实现；本轮 a34b 的 `recall-log.jsonl` 写入侧并入后，两包同批验收。

## 0.2.3 — 2026-11-05

- 新增只读接口 `GET /api/longlive-panel/recall` 与第六页签「本轮想起」：读 `<memoryRoot>/.longlive/recall-log.jsonl`，显示最近几轮注入/被隐私门拦下的记忆及命中词与分数；无记录显示「本轮没有触发召回」。

## 0.2.0 — 2026-11-05

- 「过滤器决策」「影子记录」两个页签接真数据：服务端在
  `<memoryRoot>/.longlive/filter/decisions-*.jsonl` 与
  `<memoryRoot>/.longlive/router-runtime.jsonl` 存在时返回 `implemented:true`，
  前端 `source==='live'` 不再显示样例标、不再用 SAMPLE 替换 items。
- `filter.items[].dims[]` 补契约要求的 `name`（R1..R8 中文名）；服务端缺
  `name` 时按 id 兜底，旧 decisions 文件仍可渲染。
- `shadow.items[]` 补真实 runtime 记录的嵌套映射：`subject←tool`、
  `action←顶层 allow|deny|ask 或 guard/needsHuman 推导`、
  `level/matchedRule/confidence/needsHuman/errors←decision.*`、
  `status/totalMs←outcome.*`、`callText←call.text`；新增 `target`。
- `shadow.metrics.maf` 补 `byTarget` / `avgConfidence`；router 的
  allow/deny/ask/guardReject 现在能正确统计旧语义动词记录。
- `/shadow` 同时读取并合并 `<memoryRoot>/router-runtime.jsonl` 与
  `<memoryRoot>/.longlive/router-runtime.jsonl`：旧顶层文件不再遮住 1.2.x
  的新记录，`mode/modeSource` 取两份中时间最新的一行。
- 未启用时（`implemented:false`）live 视图保持空数据并显示「未启用/暂无记录」，
  不再退化成样例；只有请求失败（source=sample）才展示样例。
- 版本升到 0.2.0。

## 0.1.9 — 2026-11-05

- 按 Router 设计 v2.3-rev2（DESIGN.md §6.5 / §9）重打第六页签「常驻 Router」的字段口径：
  - 时间：`lastTickAt` / `nextTickAt` / `heartbeatAt` 按 ISO 8601 或 null 原样接收；面板显示「12s前 / 48s后」，null 显示「未运行」。
  - `status.queue` 固定五键 `{pending,queued,applying,blockedOnUser,expired}`，与 `tickQueue{pending,invalid,oldestAgeMs}` 分开展示；不再把 `queue` 当数组、不再读旧 `askQueue`。
  - `alerts[].severity` 直接使用 Router 给的 `info|warn|error`；面板只做中文/颜色映射（信息=灰、警告=黄、错误=红），不改协议、不猜。
  - `board.focus[]` 只读 `{sessionId,goal,updatedAt}` 三字段；旧版从 `focus` 读 `state/ageMs/kind/host/declared` 的推断已删。
  - `model.auto` / `agentMode` 保留 boolean；`provider` 只收 `{configured,missing}` 两布尔，不再下发或显示 `model.resolved` / `resolvedAt` / `candidates` / 模型名 / 端点 / 凭据。
  - 顶层 `warnings` 改为开放枚举的 code 数组：16 个已知码给中文文案，未知码原样展示并标「未收录」；「告警 N 条」= `warnings.length`，不过滤、不丢弃。board.warnings 单列为「共享板诊断」。
  - 新增 `proposals.queue`（`seqCounter`→下一张票、`etaMs`、`starvation`、`writer`→「正在写」、`blocked[]`→「请主人裁决」）、`lease`（持有者/已持有/续约/到期）、`wal`（末序号/段数/字节，`broken` 才报警）；`board.pulse` 采用新名（`unknownSessions` / `queuedProposals` / `blockedOnUser` / `readyProposals` / `queueHead` / `lease` / `lastApplyAt`），旧名 `pendingProposals` / `writerLocked` 不再出口。
  - 提案列表只给 `id/ticket/target/title/status/priority/deadlineAt/op` 等安全字段，`content` / `rationale` / `baseSha` / `evidence` 永不回传。
  - HTTP：非 GET/HEAD 一律 405 + `E_METHOD_NOT_ALLOWED`，`Allow: GET, HEAD`；OPTIONS 只回 Allow（无错误体）；`/router` 顶层 `readOnly:true` 不变。
- 不做旧口径兼容 shim：旧 status 的顶层数组 `queue` / `askQueue` 不再显示，避免与新契约混用。
- 测试：`self-test.mjs` 45 PASS（Router 用例重写：五键 vs tickQueue、provider 两布尔、boolean、focus 三键、warnings 开放枚举、405 码、OPTIONS）；`client-smoke.mjs` 44 PASS（21 基线 + 21 页签断言 + 2 滚动）。两者都在 `.stage/package`（已注入版本）上跑。
- 版本升到 0.1.9，`dist/dsh-longlive-panel-0.1.9.tgz` 55,321 B，sha256 `7c84d994d0d1072ee2d4a293829eedc06288b18c43003dd7ce27ce94d3c53c3e`，连打两次一致。

## 0.1.8 — 2026-11-04

- 新增第六页签「常驻 Router」（插在「影子记录」之后、「使用说明」之前），全部只读：Router 心跳/状态（state、lastTickAt、nextTickAt、blocked 原因、run/day 预算、provider/model、写者租约、最近错误）、共享大脑摘要（board 的 focus / timeline / pulse）、提案队列（ticket、会话、目标文件、等待时长、状态）、风险告警栏（红/黄，按 severity 排序）。
- 数据只读 `status.json`、`board.json`、`proposals/*.json` 的既有字段；`status.json` 不存在时显示「未启用」并给一句说明，不报错；`board.json` 缺失显示占位。面板不解析提案正文，不显示 `content` / `rationale` / `baseSha` / `evidence`，不推断 Router 内部状态。
- 告警 severity 是面板自己的显示映射（Router 契约没有 severity 字段）：审计链断裂 / 预算 blocked / provider 缺失 / 租约超时 / 凭据风险 / 回滚失败为红，共享板过期 / 队列积压 / 降级运行等为黄；同一码去重，红在前，最多 8 条。
- 「使用说明」补「共享大脑 v1 在看什么」：用大白话解释心跳、共享板、提案队列、风险告警，以及租约 / CAS / 冲突 / 待主人确认四个词；写明面板只是窗口，不写记忆、不批准提案、不执行提案、不抢租约。「绝不会」清单新增 n6。
- `client-smoke.mjs` 页签断言 5 → 6，新增 RouterTab 真实/未启用/样例渲染与共享大脑文案断言；`self-test.mjs` 新增 Router 用例（缺文件降级、status/board 字段、提案排序与 oldestAge、正文不出门、告警红黄分级、HTTP 200）。
- 版本升到 0.1.8，用确定性打包器重打 `dist/dsh-longlive-panel-0.1.8.tgz`（包内 5 文件布局不变，连打两次 sha 相同）。

## 0.1.7 — 2026-11-04

- 「使用说明」页补齐两节：「身份上移：让新会话接上」与「路由器：动作先过一道判定」。身份上移一节讲清 STATE.md 三节（我在哪 / 在等什么 / 最近三件）、`identityCard` 开关、重启生效、验证方式与手工更新；路由器一节讲清 `routerPolicyProfile` 的 off / shadow / on 三档、影子只记录不真拦、以及 fail-closed（判定器不可用时默认拒绝）。
- 重写「它是什么」：按五层视图说明面板只读，并写明常驻 Router 仍在规划中。
- 「三个开关」原文案改名「截断开关（三个）」，与路由的 `on` 明确区分：前者管截断（dryrun·request·on），后者管动作放行，不是同一个开关。
- 「绝不会」清单新增 n5：开机卡不会伪装成用户消息——它注入的是隐藏上下文，不是聊天气泡，也不写回记忆正文。
- 文案无禁用词（已死 / 墓碑 / 墓志铭 / 记忆宫殿），页签顺序与段落顺序不变；`client-smoke.mjs` 基线 17 条 + 页签 8 条 + 滚动 2 条全部保持。
- 版本升到 0.1.7，用确定性打包器重打 `dist/dsh-longlive-panel-0.1.7.tgz`（包内 5 文件布局不变，连打两次 sha 相同）。

## 0.1.6 — 2026-11-04

- 修「影子记录」页签白屏（React #31）：`normalizeShadow` 原来写 `action: row.action ?? row.decision ?? null`，`decision` 是对象，被前端直接当 React child 渲染。现在 `action` 只取字符串（`row.action ?? row.decision?.action ?? null`），对象一律不出口。
- `decision` 明细另开两个字段：`decisionSummary`（拼好的字符串）与 `decisionFields`（`{key,value}` 且 value 全是字符串/简单值）；界面在「说的是什么」里以纯文本展示 `decisionSummary`。
- 同一接口其它字段收口：`subject`、`matchedRule`、`level`、`status`、`ts`、`id`、`utteranceHash`、`guard.verdict/reason`、`risk.level/reasons`、`errors` 全部转字符串或丢弃对象。`computeShadowMetrics` 的 action 计数因此恢复正常。
- 同类问题一并修：`normalizeDecision` 的 `unitId`/`target`/dims/privacy/human/source/dedup，`normalizeLive` 的 `host`/`declaredState`/`queued`/`lastAction.at/kind`，都不再把对象原样塞给渲染层。
- 前端加 `asText()` 渲染闸（`ShadowTab`、`FilterTab`），即使服务端漏了对象也不会变成 React #31。
- 新增页签级 `TabErrorBoundary`：某个页签渲染抛异常时只挂这个页签，显示「这一页加载失败」+ 错误摘要 + 「重试这一页」，页头、页签栏和其它页签不受影响。
- 版本升到 0.1.6，用确定性打包器重打 `dist/dsh-longlive-panel-0.1.6.tgz`（包内 5 文件布局不变，连打两次 sha 相同）。

## 0.1.5 — 2026-11-04

- 修「使用说明」页签看不全：`.llp` 原来只有 `min-height:100%`，宿主插槽是固定高度但整页不会滚，超出的内容被直接裁掉。改为 `.llp` 占满插槽并裁切（`height:100%;min-height:0;overflow:hidden`），`main` 自己纵向滚（`flex:1;min-height:0;overflow-y:auto`），`header` 补 `flex:none`、`nav.tabs` 原本就是 `flex:none`，页头与页签固定不滚。
- 只改 CSS 与注释，未动数据逻辑、页签结构、接口与文案。
- `client-smoke.mjs` 追加 2 条滚动布局断言（直接读 `src/client.js` 的 CSS 规则）：`.llp` 含 `height:100%` + `overflow:hidden`、`main` 含 `overflow-y:auto` + `min-height:0`；基线 17 条与页签 8 条不动。
- 版本升到 0.1.5，用 `build-pack.mjs` 重新打包 `dsh-longlive-panel-0.1.5.tgz`（包内 5 文件布局不变）。

## 0.1.4 — 2026-11-04

- 版本号只留一个权威源：`server.js` 运行时读 `package.json`（删掉手写 `export const VERSION = '0.1.2'`），`client.js` 改成构建注入占位符，修掉「页头显示 v0.1.2」的漂移。详见 `C:\dshops\panel-version\FIX-NOTES.md`。

## 0.1.3 — 2026-11-03

- 新增第五页签「使用说明」（放在最后）：它是什么 / 装好你会看到什么 / 三个开关（dryrun·request·on）/ 第一次用四步 / 出问题先看这里 / 它绝不会做什么；纯静态只读，术语首次出现带一句解释，页脚指向包内 README.md / QUICKSTART.md。
- `client-smoke.mjs` 追加页签断言：页签数=5、第五页签标题含「使用说明」、页面含 dryrun/request/on 与「绝不」、文案无禁用词；原有 17 条基线不动。
- `package.json` 描述去掉「记忆宫殿」字样（版本同步升到 0.1.3），重新打包 `dsh-longlive-panel-0.1.3.tgz`（包内 5 文件布局不变）。

## 0.1.2 — 2026-11-03

- 状态词改名：`dead` 显示为「已归档」、`stale` 显示为「休眠」、`corrupt` 显示为「损坏」；活体登记找不到会话文件的孤儿行额外标注「无会话文件」；界面不再出现「已死」。
- L6 文案改名：「归档与遗忘」→「归档与封存」，「墓碑」→「封存卡」，「墓志铭」→「归档理由」。
- 修复 `client-smoke.mjs` 侧栏断言：期望的「记忆宫殿」改为「潜望镜」，client-smoke 回到 17 PASS · 0 FAIL。
- 版本升到 0.1.2，重新打包 `dsh-longlive-panel-0.1.2.tgz`（包内 5 文件布局不变）。

