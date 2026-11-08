# 变更记录

> 本文件只保留用户可读的功能与修复摘要；内部开发日志单独保存，不随发布包分发。

## 1.8.0 — 2026-11-08

**有据才答（注入修复 + 来源闸）、插件功能默认开启（含共享大脑活动流/thinking 摘要级）、隐私默认中性、可移植加固。**

### 有据才答：注入修复与来源闸

- **证据投递修复（默认生效）**：`evidenceMaxChars` 1200→4000；证据包助手 excerpt 窗口 300→800；
  `HISTORY_CUE_RE` 增加「当时 / 那时 / 那次 / 当天」，修复「证据已注入但答案被截在 300 字外 →
  模型误判零证据而弃答」。
- **信心闸（默认关闭）**：`answerGuard.gate.enabled=false`；开启后三态判定
  `answer`/`degraded`/`abstain`，基于证据数、引用可回读性、冲突计数、无源数字、未标注推断等
  可机读信号；审计行新增 `gate`/`assertions`/`citations` 字段。开启后系统提示追加硬规则
  （每个事实句需「第 N 轮」引用、数字可回读、未标注推断视为幻觉、不得声称未发生的工具调用）；
  `gate.enabled=false` 时系统提示逐字节保持不变。
- 总开关 `answerGuard.enabled=false` / `DSH_LONGLIVE_DISABLE_ANSWER_GUARD=1` 可整层关闭。

### 投递契约层（FIX-05）

**1.8.0 投递契约层（FIX-05）**：`answerMode` / `evidenceUnits` / `sourceGate` / `tier` 四个审计
字段；B 题 0 证据时 pre-step 注入隐藏强制弃答指令（模型可不服从）；`row.delivery` 提供弃答
投递契约兜底。宿主无 message transform，**live 用户可见正文的强制替换待宿主钩子（1.9 计划）**；
V2 行为指标按 delivery/answerMode 契约统计，raw 判分保持冻结口径。

### 共享大脑活动流（1.8.0 起默认开启）

- 写侧 + 实时注入：turn/end 记一条本回合活动到共享板；pre-step 只注入其他会话新增的活动（≤5 条 / 整条 ≤300 字，无新增零 token）。
- 隐私：数据只在本机 `memoryRoot`，不上传、不联网；`local_only` 不写不注入。不想要就设 `sharedBrain.activity.enabled: false` 后重启（opt-out）；细节见 `docs/CONFIG.md`。

### 插件功能默认开启（1.8.0 起）

- 未显式给则视为 `true`，**只有字面 `false` 才关闭**：`autoRecall`、`identityCard`、`presenceBus`、
  `sharedBrain.activity`、`sharedBrain.thinkingInjection`（摘要级）、`autoMaintenance`、`d2`、`d6`、
  `routerEnabled`（含 sharedBoard / wake）、`routerFace`、`workers`、`embedding`（本地模型缺失时静默退关键词）、
  `autoTruncate`。
- 保持默认关的安全/灰度项：`answerGuard.gate.enabled`、`routerApplyEnabled`、`strictMemoryRoot`、
  `routerRuntime: off`、`d6.dryRun` 等。
- 升级注意：1.8.0 起多处功能由「默认关」翻为「默认开」；行为回退用显式 `false`，细节见 `docs/CONFIG.md`。

### 共享大脑 thinking（摘要级默认开启）

- 默认开启（摘要级）：只注入其他会话摘要，不注入原文、不写日志；`sharedBrain.thinkingInjection.enabled: false` 可关。
- 开启后只注入其他会话的**摘要**，不注入原文、不写入错误日志；`local_only` 内容不写不注入。
- 配置键（`sharedBrain.thinkingInjection`）与默认值见 `docs/CONFIG.md`。

### 隐私与默认中性

- 内置身份默认中性：发布包与内置提示不含具体人名/角色；身份由用户 `<memoryRoot>/IDENTITY.md`
  定义（缺省用中性默认，不自动创建/改写）；蒸馏 `who` 默认空，由用户显式配置注入。
- 发布包隐私扫描：绝对路径、个人目录名等 blocker 计数必须为 0 才发版；发布包不含记忆库、
  会话日志或本机路径。详见 `docs/PRIVACY.md`。

### 可移植加固（Gate-4）

- node 统一走 `process.execPath`，不依赖 PATH；包内无绝对机器路径；干净 `DSH_HOME` 下可
  install/运行。

### 质量门

- Gate-3 采用人类机制校准版判据 `GATE3-CRITERIA-V2`（v2.1，sha256
  `40A2C62D2CD07DA1D36C6B9211427A9496A0BD525F4E0862ED21AE94BA318D6D`；判据文件随发布证据
  归档，不随发布包）；旧口径保留为双口径对照。

### 已知限制

- 真实模型 holdout-after（after2）四指标待填：错答率 / 弃答率 / 覆盖率 / 幻觉率 **占位**，
  来源=发布评测 `score-real` 输出（见发布证据归档）；不写未复测数字。
- before 参考（旧口径，分母 100）：错答 17 / 弃答 9 / 覆盖 70 / 幻觉 12（来源=真实模型
  holdout-before 评分文件）；按 V2.1 口径复算：有据可答题覆盖 85.9%、证据投递率 82.1%、
  可答误弃 10.3%、该弃未弃 100%、有据误判 2.6%、无据硬答 13.7%。
- 插件功能默认开启（sharing brain 活动流/thinking 等，显式 false 可关）、身份默认中性属行为变更：从旧版本升级且未自建 `IDENTITY.md` 的
  机器会显示中性身份，旧文件不会被删改。

## 1.6.8 — 2026-11-06

- 并入共享大脑活动流（该版本默认关闭；1.8.0 起默认开启）：事件级活动写入共享板，只向其他会话增量注入新增活动；
  可选、失败静默，与热截断独立。
- 共享板状态诚实性修复：running 计数、焦点新鲜度、turn 状态、开机卡时效。

## 1.6.7 / 1.6.6 / 1.6.5 — 2026-11-06

- 热截断加固与热修复：turn 边界、缺 turn/end 记录、被宿主重启中断的会话不再永久失去自动切刀。

## 1.6.4 — 2026-11-06

- 热截断默认值收到 300k 触发 / 保留 4 轮；修复 D6 重启后首轮冻结；可移植性收口。

## 1.6.3 — 2026-11-06

- 新增热截断：不调 LLM 的 cut-only 压缩引擎，只切已完成且早于保留窗口的整轮，切前归档原文。

## 1.6.0 — 2026-11-06

- 包名由 `dsh-session-longlive` 改为 `dsh-longlive`。

## 1.5.0 — 2026-11-06

- 冻结首版（经 rc 迭代后重发）。

## 0.8.0 – 1.4.0 — 2026-11-03 ~ 2026-11-06

- 内测迭代期：会话健康工具、备份、两种截断、热截断与共享大脑能力逐步成形。

## 0.7.6 及更早

- 无随包维护的变更日志。