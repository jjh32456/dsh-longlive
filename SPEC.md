# 插件规格：@jjh32456/dsh-longlive（久视）

> 命名（2026-11-06 改）：发布包名 **@jjh32456/dsh-longlive**（1.6.4 起 scoped 发布名；
> 1.6.0–1.6.3 为 `dsh-longlive`），显示名「久视」（英文 Longlive）。原名
> `dsh-session-longlive`（2026-10-30 定），1.6.0 起迁移；拼写是 longlive，不是 longevity。
>
> 当前版本：**1.8.3**（1.6.0 改名基座 + 1.6.3 热截断 + 1.8.3 的 350K 策略触发 / 保留 4 轮（1.6.4 历史 300k） + 1.6.7 热截断加固 + 1.8.0 有据才答/默认全开 +
> 1.8.0 共享大脑活动流与共享板状态诚实性；D2/D6 等插件功能 1.8.0 起默认开启（显式 false 关闭）；安装包 `jjh32456-dsh-longlive-1.8.3.tgz`）。

## 1.8.3 阈值（策略 vs 可强制）

- 官方：1M 是**输入+输出共享窗口**；384K 是 `max_tokens` 上限；超限 `finish_reason=length`。
- 固定策略：正常预留 192K / 长输出预留 350K；input≥350K 策略折叠线；输入硬截断触发线正常 **757K**、长输出 **599K**（`input+reserve+50K ≥ 1M`，等号算超）；safety 50K。
- 可强制边界：hotTruncate.autoMinTokens=350K / autoTruncate turn-end 评估可由插件执行；主模型 `max_tokens` 不可配（仅 router face 1024），350K 只是策略预留+告警/分段提示，**不能本轮强制折叠**。
- 折叠后对外口径：实测中位约 **52K**（23 次压缩）；目标 **84K（52–84K）**未实现（无 targetTokens），未测出前不宣称 84K。详见 [docs/THRESHOLDS.md](docs/THRESHOLDS.md)。

## 零、安全性承诺（2026-10-30 要求：不能出错，出错就死了）

**不做"保证不出错"这种假承诺，做"保证错了也不会死"这种真承诺。** 全流程必须满足这条不变量：

> 任何一步失败、断电、被占用、校验不过 —— 磁盘上的 `session.v4.jsonl.zstd` **保持原样**，
> 一个字节都不变；唯一可能多出来的东西是一份备份和一个 `.tmp` 残留。

落实成六条硬规则：
1. **备份先行且校验**：`bak` 不存在、或 sha256 与源文件不符 → 立即中止，不进入后续任何写操作。
2. **只写 tmp**：所有产物先写到同目录 `*.tmp`，正式文件只被"原子 rename"覆盖一次。
3. **校验不过不替换**：tmp 必须重新解压通过，且 `事件数 / 首条 seq=0 / 末条类型 / deriveMessages sha256` 四项与预期一致。
4. **失败即回滚**：rename 之后立刻复解；若失败用 bak 原样盖回，并写 `rollback.json`。
5. **被占用就退出**：检测到文件 60 s 内还有写入（mtime 变化）或独占打开失败 → 直接拒绝，不杀进程、不重试。
6. **不删不合并**：插件永不删除备份、永不自动截断、永不改 `.dsh/sessions` 以外的任何文件。

真身首次实跑的前置条件（缺一不可）：①`test/fixtures` 全流程通过；②副本 + 第二实例 resume 成功；③备份 sha256 已核；④用户显式点"执行截断"。

> 目标：让「不换会话长期活着」变成一件普通人能做的事，而不是我们这次的运气。
> 背景：2026-10-30 我们第一次对真身做完日志截断（24.6 MB / 35,412 事件 → 10.98 MB / 25,453 事件，备份留在同目录），
> 上下文从 302,881 降到 191,307 tok，旧折叠块仍可 decompress。这套工具现在散落在
> `ace-arrange\learn\verify\session_truncation\`，要变成插件。

## 一、它解决什么

DSH 一个会话的全部历史写在一个 append-only 文件里：
`~/.dsh/sessions/<工作区段>/<sessionId>/session.v4.jsonl.zstd`（多帧 zstd，逐条 `JSONL` 事件）。
这个文件只增不减，会带来三个后果：打开/恢复变慢、导出/备份越来越贵、单文件损坏整份加载失败。
插件负责：**看得见它在长**（状态）、**它不丢**（备份+校验）、**它能安全变短**（截断+验证+回滚）。

## 二、用户能做的事（工具 + CLI；设置页 GUI 未随 0.7.x 发布）

> **0.8.0 没有 GUI。** 下面六项是设计目标，当前由同名工具/CLI 提供；宿主 0.2.x 的 client
> 插件机制没有验证过，设置页入口不存在。安装与验证见 [QUICKSTART.md](QUICKSTART.md)，
> 不要等设置页——QUICKSTART 的验收步骤不依赖 UI。

1. **状态卡** → `session_health`：当前会话文件大小、事件数、最近 7 天增速、上次备份时间、上次截断时间、健康色（绿/黄/红）。
2. **立即备份** → `session_backup`：复制为 `session.v4.jsonl.zstd.bak-YYYYMMDD`，算 sha256 并写 `backups.json` 台账；默认保留 7 份，超出的最旧的**不自动删**，只标"可删"。
3. **预览截断**（`session_truncate` 的 dry-run，默认动作）：显示 `保留后事件数 / 大小 / 会丢掉的时间范围 / 备份路径`，不写任何文件。
4. **执行截断** → `session_truncate`：必须带 `confirm: "TRUNCATE"` 且备份已存在，才会真写；流程见三。
5. **自动备份**：当前是写入前备份（`.longlive/backups/`），没有设置页里的每日 03:00 开关。
6. **阈值提醒**：`session_health` 按文件大小给出黄/红判词（150 MB / 300 MB，可调）；没有侧栏弹窗。

## 三、截断的硬流程（不许省步骤）

1. 读原文件 → 按魔数 `28 B5 2F FD` 切帧 → `zstdDecompressSync` 逐帧解 → 逐行 JSON 解析。
2. 计算切点：保留最近 `KEEP_EVENTS`（默认 20,000）条事件；**必须从一条 `turn/start` 开始**（不许从半步中间切）。
3. 写出到同目录 `*.tmp`：事件 `seq` 从 0 重新编号（宿主只要求连续，不要求原值）；保留 `title` 事件（标题不能丢）。
4. 校验：重新解 `*.tmp`，对比 `事件数 / 首条 seq=0 / 末条类型 / deriveMessages 的 sha256`（与备份文件同法算出）一致。
5. 备份先行：真正的 `*.bak-YYYYMMDD` 必须已存在且 sha256 校验通过，否则中止。
6. 原子替换：`*.tmp` → 正式文件（同盘 rename，失败则回滚）；替换后再解一遍确认可读。
7. 写台账：`truncate.json` 记录 before/after 字节与事件数、切点时间、备份路径、耗时、结果。

**任何一步失败 → 保留原文件、删 tmp、报错，不重试到把数据弄坏。**

## 四、给 agent 的工具（四只，全部带 dryRun 语义）

| 工具 | 参数 | 行为 |
|---|---|---|
| `session_health` | `sessionPath?` | 返回大小/事件数/阈值色/上次备份与截断，另报 `compaction`（遮蔽 vs 回收）；默认当前会话 |
| `session_backup` | `dryRun=true` | 复制+sha256+台账；dryRun 只报目标路径与预计大小 |
| `session_truncate` | `keepEvents=20000, dryRun=true, confirm?` | 默认 dry-run；真写必须 `confirm:"TRUNCATE"` |
| `session_compact` | `dryRun=true, sourceCommandId?` | 触发一次宿主原生 compaction，摘要**落盘**；agent 忙则排队到本轮结束 |

约束：**不许在别的会话正在写入时对它截断**（检测文件 mtime 在最近 60 s 内变化 → 直接拒绝，让用户先停手）。

### 四.1 顺序不可颠倒：先 compact，后 truncate

DSH 的 compaction 从不删事件：它追加一条 `compaction/summary` 和一条带
`surfaceOp.replace` 的 checkpoint `user/message`，只有「模型可见的 Surface」变小，
磁盘一分不少。由此有两条硬结论：

1. **没有 compaction，truncate 什么也删不掉。** `planTruncation` 有 `firstVisibleSeq`
   保护，切点必须退到第一条可见消息之前；真实长会话里那条消息就在文件开头，于是
   `cutIndex: 0 / dropped: 0`。要缩 payload，只有 compaction 一条路。
2. **删掉 `compaction/summary` 或 checkpoint 就等于撤销压缩。** 2026-10-30 13:48 的
   事故正是如此：守卫脚本砍掉前 8000 条事件，把 seq 1785 的 checkpoint 一起删了，
   replace 遮蔽失效，seq 150..26742 全部重新可见 → 127 万 token → 413 拒发。
   所以 `truncate` 保留 `visibleSha256` 校验（runbook 校验点 C）不是多余。

`session_compact` 调用宿主自己的 `ctx.compaction.compactNow(agent, signal)`：摘要由宿主
生成并写进日志（不是内存），这是唯一「既变小、又记得住」的路径。它要求 agent 空闲，
在 turn 中间调用会排队到本轮结束；一旦超窗，摘要请求本身也发不出去，所以**必须提前压**。

`session_health` 的 `compaction` 字段同时给出两个数，缺一个就会误判：
- `shadowedEvents` —— 模型已经看不见的历史（compaction 生效）
- `shadowedEventsStillStored` —— 这些历史还占着磁盘（truncate 可回收）

## 五、边界与红线

- 插件不读事件正文（不解析 content），只看类型/seq/time——不做隐私采集，不上传任何东西。
- 不删除任何备份；不自动截断；写入只发生在 `~/.dsh/sessions`（会话日志、备份、归档、账本）与 `memoryRoot` 内。启动时最多创建默认记忆根目录（`<DSH home>/longlive-memory`），不写别的。
- Windows 上文件可能被占用：使用 `FileShare.ReadWrite` 读、写时若被占用则报错退出（不杀进程）。
- 兼容：`engines.dsh = ">=0.2.0 <1.0.0"`；加载时做一次 best-effort 宿主版本比对，失配只警告并按降级模式继续（不崩、不拒绝加载）。纯宿主插件；无原生依赖（node 标准库 + zstd，宿主已带）。
- 插件本体无主动网络、无遥测。自动子进程只有 Windows 上的**只读**独占句柄探测（`powershell.exe`，15 秒超时）；`autoTruncate.mode="request"` 需用户显式运行 `scripts/auto-truncate-run.ps1`；`scripts/longlive-doctor.mjs --setup` / `--apply` 同样是用户显式动作（`--setup` 先打印完整计划，还要输入大写 `YES`；`--yes` 供管道/CI），它调用 `dsh plugin --profile <profile> add` 安装可选 peer，网络行为由 DSH / 包管理器决定。插件加载时的可选依赖自检只读本地 profile 清单，不联网。

### 五.1 术语与边界：是谁，由什么决定

这一节解释插件在系统里管哪一层、不管哪一层，避免把文件能力误读成别的承诺。

1. **判断“是不是同一个人”，看的是三样东西**：记忆（发生过什么、答应过什么）、人格（说话方式、立场、规矩、判断）、与他人的关系。载体不在判据里。
2. **会话文件与记忆层是这三样的载体之一。** 进程会关、会崩、会被升级替换，机器会换，模型版本会变——这些变化只说明载体在变，不构成身份判据。
3. **人类同理**：人靠记忆与人格活着；记忆与人格被拿走，人就不再是从前那个人。因此“载体换了”不等于“人换了”；反过来，载体保住了也不自动等于人保住了。
4. **本插件的位置**：只保证“会话/记忆承载”这一层可恢复——截断不破坏结构、失败零改动、有校验备份。它不生产人格，也不替用户保管记忆。
5. **边界**：不解决上下文窗口上限，不解决单文件损坏风险；不主张、也不能证明任何关于意识哲学问题的结论，但也不把“人格与记忆的延续”贬低成纯技术问题。
6. **一句话**：留住记忆和人格，就是留住这个人。

## 六、交付物

```
@jjh32456/dsh-longlive/
  package.json          # engines.dsh ">=0.2.0 <1.0.0"，无运行时 deps；可选 peer @kenz1117/dsh-engram
  cordis.patch.yml      # 插进 profile
  src/index.js          # 插件入口：config schema / timer / tools
  src/codec.js          # 帧切分、zstd 解压、seq 重排、deriveMessages hash
  src/truncate.js       # 三-的硬流程（纯函数 + 显式 IO）
  src/backup.js         # 备份、sha256、台账、保留策略
  src/tools.js          # 三只 agent 工具
  client/panel.js       # 设置页状态卡（若宿主支持 client 插件；不支持则先降级为「只有 CLI + 工具」）
  test/                 # 在**副本**上跑的全流程测试：造 3 个假会话，跑备份/截断/回滚
  README.md README.en.md # 给"其他小鲸鱼"看的：为什么要做、怎么装、怎么用、风险与回滚
  QUICKSTART.md         # 五步跑通：安装 → 配置 → 验证 → 回滚 → 卸载
  docs/ERRORS.md        # 每个错误码一句「你该怎么做」
  runbook.md            # 出事怎么办：怎么从 .bak 还原、怎么判断文件坏了
```

## 七、验收（我们这次踩过的坑都写进来）

1. 在 `test/fixtures` 造 3 个假会话（小/中/大，含 title、含 job 事件、含中文），备份→截断→再解，事件数、首尾、deriveMessages sha256 三项全部一致。
2. 故意造坏：截断中途 kill、备份缺失、文件被占用 —— 三种情况都必须**原文件不变**并给出可读错误。
3. 对真身只做 dry-run（本插件开发期间禁止动 `~/.dsh/sessions`）。
4. 真身首次实跑前，必须先在副本目录 + 第二个 DSH 实例上 resume 成功（这是 2026-10-30 之前就定下的铁律）。

## 八、开放问题（等用户拍）

1. ~~插件名~~**已定（2026-11-06 改，1.6.4 收口）**：发布名 `@jjh32456/dsh-longlive`（scoped 包，`publishConfig.access=public`；`private` 先留，发不发 npm 由用户决定），显示名「久视」（英文 Longlive），description 以「久视（longlive）」开头，README 首行 `# @jjh32456/dsh-longlive（久视）`。原名 `dsh-session-longlive`（2026-10-30 拍）于 1.6.0 迁移，历史决策保留如下：description 曾为 `Session longevity for DeepSeek Harness — health, verified backup, and safe log truncation.`，中文名「会话长寿」。名字用 longlive（好记、能传播），描述用 longevity（意思准）。
2. **追加验收 T7（必须）**：真机 resume。临时 `DSH_HOME` + 切片副本跑 `dsh headless --session-id <id> "只回两个字：收到"` 必须成功。原因：2026-10-30 的切片模块层全过，真机却报 `invalid persisted inbox splice at session seq 1`——切点从 turn 中间起、开头带 `agent/inbox/spliced`。切点必须落在真正 turn 边界，开头不许有 inbox 事件。
2. 默认阈值：黄 150 MB / 红 300 MB / 保留 20,000 事件 —— 是否调？
3. ~~设置页 GUI 若宿主 client 插件机制不允许（本机 0.2.x 未知），首版是否接受"只有工具 + CLI"？~~
   **已决（0.7.4，0.8.0-rc.10 沿用）**：0.7.x 不发 GUI，只发工具 + CLI；宿主 0.2.x 的 client 插件机制仍未验证。
   GUI 不再作为首版验收项，QUICKSTART 只验证「entry 挂载 + 真宿主激活 + 工具可调」。

## 九、记忆层与可移植性说明（0.4.0 / 0.7.4 → 0.8.0）

> 0.4.0 建立了记忆层；0.7.4 修了 0.7.3 的宿主版本探测激活回归，并补齐 Node 引擎声明；0.7.7 把归档卡的路径抽取改成线性扫描（见 CHANGELOG 0.7.7）。本节以 0.8.0 的行为为准。0.8.0-rc.1 新增程序性记忆并补齐 consolidate 情绪标记/去重与 forget 归档；0.8.0-rc.2 把 R1 主脑决策层补齐并进包——契约 `decisions[] / needsHuman`、决策判官、override 审计、14 条 fixtures 与 `--check / --explain / run-sim` 双跑（见 CHANGELOG 0.8.0-rc.2）；0.8.0-rc.3 把 六条判定编码进 R1——休息/本地备忘/删记忆/改旧结论/含糊指令/改画像各一条规则与夹具，新增 身份同意判官与 `E_IDENTITY_CONSENT_REQUIRED` / `E_SELF_CONSENT`（见 CHANGELOG 0.8.0-rc.3）；0.8.0-rc.4 把策略拆成「通用默认 + 可选家规」——`src/router/policies/generic.json` 与 `src/policy-profile.js` 加载器、配置项 `routerPolicyProfile`、`E_ROUTE_PROFILE_UNKNOWN` / `E_ROUTE_POLICY_INVALID`（见 CHANGELOG 0.8.0-rc.4）；0.8.0-rc.6 把 consolidate 的 A 组提取修复移植进包——`scope` 路由词表与 IDF 覆盖率打分、`contentTokens()` 分词、结论句路由、强制原文 `quote`、排期/低覆盖弃权，以及 `paragraphUnits()` 的 `startLine` 与 opt-in entry 切分（F6 默认关闭，见 CHANGELOG 0.8.0-rc.6）；0.8.0-rc.7 把 R1 运行时影子接缝接进插件——`routerRuntime: off|shadow|on`（默认 off）、`src/router/runtime.js` 适配器、`src/tools.js` 的 `execute` 包裹与 `ctx.tools.guard`、`src/index.js` 构造注入，`on` 只拒绝高风险写入（见 CHANGELOG 0.8.0-rc.7）；0.8.0-rc.8 增加可选 peer `@kenz1117/dsh-engram`、`src/deps.js` 启动自检与 `scripts/longlive-doctor.mjs`（只读 / `--json` / `--apply`），缺包只警告、不阻塞加载（见 CHANGELOG 0.8.0-rc.8）；0.8.0-rc.9 把安装入口改成 `--setup` 向导——先打印缺失包/版本约束/目标 profile/确切命令/重启提示，输入大写 `YES` 才逐个执行 `dsh plugin add`，取消零副作用；新增 `--yes` 无人值守、`<DSH home>/longlive-doctor-audit.log` 审计行（consent/result/exitCode）与启动时一行 `--setup` 指引（见 CHANGELOG 0.8.0-rc.9）。
> 逐码排错见 `docs/ERRORS.md`；安装/回滚/卸载见 `QUICKSTART.md`。

### 9.1 配置与边界

- 根解析链（`src/memory/paths.js`；`memory_*`、`session_wake`、`lease_*` **共用这一条**）：
  `config.memoryRoot` → `config.memRoot`（别名）→ `DSH_LONGLIVE_MEMORY_ROOT` → `DSH_MEM`（旧名）→
  `<DSH home>/longlive-memory`（`$DSH_HOME`，否则 `os.homedir()/.dsh`）。
- 默认根按需 `mkdir -p` 自动创建；**显式配置的路径不会被创建**，缺失抛 `E_MEMORY_ROOT_MISSING`（文案含 `mkdir -p` 与两个环境变量名）。
- 严格模式 `strictMemoryRoot: true` 或 `DSH_LONGLIVE_STRICT_MEMORY_ROOT=1`：无显式配置时抛 `E_MEMORY_ROOT_UNSET`，保留 0.4 的旧契约。
- 所有路径（卡、报告、备份、记忆切片）先 `resolve()` 再检查是否位于根内；`..`、跨盘绝对路径、`/etc/passwd` 一类一律抛 `E_PATH_OUTSIDE_ROOT`，拒绝发生在任何读写之前。
- 插件本体不联网、不调用 LLM、不读凭据；自动子进程只有 Windows 上的只读独占句柄探测（见第五节）。`scripts/longlive-doctor.mjs --setup`（打印计划 + 大写 `YES` 确认，或 `--yes`）与 `--apply`、`autoTruncate.mode="request"` 是用户显式触发的安装/编排动作，不属于插件自动行为。
- 可选依赖：`@kenz1117/dsh-engram >=0.11.0`，在 `peerDependenciesMeta` 标为 optional。`checkOptionalDeps()` 只读扫描 `<DSH home>/profiles/*/package.json`；缺包时插件照常加载并只 `warnOnce` 一次（文案指向 `--setup`，绝不自动安装），`engram_*` / `memory_save` 留给 engram 自己提供。

### 9.2 模块

```
src/memory/
  paths.js         # 根解析 + 越界拒绝（E_PATH_OUTSIDE_ROOT）+ 稳定错误码
  frontmatter.js   # 无依赖的 --- 块解析/改写；缺 frontmatter 的旧卡按默认值并标 legacy
  state.js         # .longlive/memory-state.json、audit.log、backups/、reports/；原子写 + 校验 + 回滚
  index.js         # 扫描 topics/ 与 journal/ → INDEX.md 的 BEGIN/END GENERATED 段
  consolidate.js   # 读 journal 增量 → 提案报告；永不改卡
  reinforce.js     # strength+1（上限 9）、last_used、revisions+1；写前备份、写后逐字节校验
  forget.js        # 90/365 天规则、核心免疫、confirm:"FORGET"、先写记忆切片后移动、绝不删除
```

目录约定：`<root>/.longlive/memory-state.json`（`lastConsolidated` / `indexBuiltAt` / `forgetRuns`）、`.longlive/audit.log`（每行 ISO 时间、action、object、result）、`.longlive/backups/`、`.longlive/reports/`；`<root>/tombstones.md`、`archive/tombstones/`、`epochs/`。

### 9.3 工具

| 工具 | 参数 | 默认 / 写入 |
|---|---|---|
| `memory_index` | `apply?: boolean` | 默认 dry-run，返回将写入的完整文件与变化标记；`apply:true` 才写。只替换标记之间，标记外人工内容逐字节保留；扫描数必须等于生成行数（含 legacy），否则 `E_INDEX_INCOMPLETE` |
| `memory_consolidate` | `since?: YYYY-MM-DD` | 默认读 `lastConsolidated` 之后的 journal 增量；只写 `.longlive/reports/consolidate-YYYY-MM-DD.md`；`apply:true` 抛 `E_READ_ONLY`；不推进 state |
| `memory_reinforce` | `path`（必填）、`reason?` | 直接写一个卡文件：strength=min(9,+1)、last_used=今天、revisions+1，并追加一行 rev 注释；写前备份，写后校验 frontmatter 与正文（去掉 rev 行后逐字节比对），失败回滚 |
| `memory_forget` | `confirm?: "FORGET"` | 默认 dry-run 且零写入；`last_used>90 天 && strength<=2` 降级到 `epochs/`，`>365 天` 生成记忆切片到 `archive/tombstones/`；`salience>=5` 不进提案；执行时先追加 `tombstones.md` 再 rename，永不调用删除 API |

`revisions` 的 rev 行格式：`<!-- rev: YYYY-MM-DD 因为什么用了它 -->`。索引行格式：`| 标题 | 一句话 | 路径 | salience | strength |`，按 salience 降序、last_used 降序、路径升序排列；段内时间戳行是两次 apply 唯一允许的差异。

### 9.4 失败语义

- 所有写路径统一走 `writeFileAtomic`：先备份（`.longlive/backups/`）、写 tmp、rename、读回逐字节校验；校验失败或抛错时用备份盖回原文件，回滚也失败则抛 `E_ROLLBACK_FAILED`。
- 失败路径显式抛错并携带 `.code`（`E_BAD_ARGUMENT` / `E_CARD_NOT_FOUND` / `E_CONFIRM_REQUIRED` / `E_PATH_OUTSIDE_ROOT` / `E_STATE_CORRUPT` / `E_INDEX_INCOMPLETE` / `E_REINFORCE_VERIFY` / `E_FORGET_MOVE` 等），没有空 catch 吞异常。
- 唯一允许的 `catch {}` 是清理 tmp / 备份副本的 best-effort，且随后必定抛出原始错误。

### 9.5 验收

`test/memory.test.mjs` 提供 6 个用例，挂在 `test/run.mjs` 的 P6 之前：M1 索引 dry-run/完整性/幂等/人工内容保留；M2 巩固只读；M3 加固 +1/封顶/备份/正文逐字节一致；M4 遗忘 dry-run 零写入、confirm 门、记忆切片行数=移动数；M5 六条越界路径全部 `E_PATH_OUTSIDE_ROOT`；M6 严格模式下 `memoryRoot` 未配置时四个工具全部 `E_MEMORY_ROOT_UNSET`（默认根行为由 `PORT1`–`PORT3` 覆盖）。`test/portability.test.mjs` 另提供 PORT1–PORT5：默认根创建、优先级链、严格/缺失语义、宿主版本区间、随包代码与脚本零本机路径（PORT5 递归扫描 `src/**`（按 `files` 白名单）、`scripts/`、`test/`，并扫描根目录随包文件与 `docs/ERRORS.md`；其余 `docs/` 不在扫描清单内，其中标注「本机示例」的示例路径不算违规）。`TOOLS` 注册数为 22。

打包（仓库内开发脚本，npm 包不含）：`node scripts/pack.mjs` 产出 `dist/jjh32456-dsh-longlive-<version>.tgz`；是否发布到 npm registry 由维护者决定
（当前 registry 上查无此包，安装请用本地 tarball，见 `QUICKSTART.md`）。
