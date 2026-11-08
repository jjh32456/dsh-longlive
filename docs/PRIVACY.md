# PRIVACY · 久视 1.8.0 身份与隐私

本文件说明 1.8.0 的身份默认值、用户身份配置方式、共享大脑 thinking 的隐私边界，以及发布包的隐私扫描门。

## 1. 默认中性身份

- **1.8.0 起，内置身份默认中性**：发布包与内置提示里不含具体人名、角色名或称呼（不再内置「你是谁」「叫我什么」这类个人设定）。
- 身份由用户自己的 `<memoryRoot>/IDENTITY.md` 定义；文件不存在时使用**中性默认文本**，不自动创建、不自动改写。
- 记忆内容里的「who」由用户自己决定：`memory_*` 写入与蒸馏时，who 字段**默认为空**，由用户显式配置注入；插件不把任何个人称呼当成默认值。
- 升级注意：从 1.6.x 升到 1.8.0 时，旧机器上已有的 `IDENTITY.md` 不会被删除或改写；没有该文件的机器会显示中性身份，需要的话按第 2 节新建。

## 2. 怎么配置自己的身份

1. 在记忆根下新建 `IDENTITY.md`（默认 `<DSH home>/longlive-memory/IDENTITY.md`，Windows 下通常是 `%USERPROFILE%\.dsh\longlive-memory\IDENTITY.md`；记忆根被 `memoryRoot` 覆盖时跟着走）。
2. 写你希望前台 hint / 后台 Router 使用的身份说明；建议短、稳定、不要写敏感信息。
3. 改完重启宿主生效。`identityCard` 只做开机卡注入，默认不创建 outbox、不改 `STATE.md`。

示例（按你自己的设定替换）：

```markdown
# 我
- 称呼：<你希望被怎么称呼>
- 身份：<你自己定义的身份/角色>
- 说话风格：<可选>
```

## 3. 发布包隐私扫描（发版门）

- 发布包只包含 `package.json.files` 白名单内的内容（源码/文档/测试，`scripts/answer-eval/` 与 `eval/` 等 dev-only 不进包）。
- 打包前跑仓库内发版门脚本（**npm 包不含**）`scripts/scan-abs-paths.mjs`（经 `scripts/pack-gate.mjs` 串联）扫描发布物：**绝对路径、个人目录名等 blocker 计数必须为 0**，否则阻止发版。这是 1.8.0 的发版门之一。
- 发布包不包含任何用户的记忆库、`IDENTITY.md`、会话日志或本机路径；本机路径只在运行时由 `process.execPath` / `DSH_HOME` 解析。

## 4. 共享大脑隐私边界（活动流 + thinking 摘要级 1.8.0 起默认开启）

- **共享大脑活动流（1.8.0 起默认开启）**：写侧 + 实时注入；数据只在本地 `memoryRoot`，不上传、不联网；关闭方法：`sharedBrain.activity.enabled: false` 后重启宿主（回到 1.6.8 默认）。
- **thinking（摘要级，1.8.0 起默认开启）**：只注入摘要；设 `sharedBrain.thinkingInjection.enabled: false` 可关，关闭后零注入、零写盘；数据只在本地 memoryRoot。
- 打开后只做两件事：在 pre-step 注入其他会话的**摘要**；以及把摘要写进共享板/活动文件（按现有共享大脑文件布局）。
- **只摘要、不写原文**：thinking 不落原文、不保存用户消息/助手回答的完整文本；摘要受共享大脑已有的长度上限约束。
- **不进日志**：不把 thinking 内容写进错误日志/审计日志；失败只记状态，不记内容。
- 写入/注入前复用 `src/recall/privacy.mjs` 的隐私门（`privacyScan`）：本地私密（`local_only`）内容不写、不注入。
- 关闭方式：把 thinking 开关设为关闭（配置键见 [CONFIG.md](CONFIG.md) 的 thinking 段）后重启宿主；关闭后已写盘的历史摘要可手动删除对应 `.longlive` 文件。
- **卡片三套机制的隐私边界（1.8.0）**：AutoCard 是每轮派生索引（.longlive/index/cards.jsonl，可重建、不含原文正文）；精卡 sidecar（.longlive/index/card-anchors.jsonl）只存源文件路径/行号/哈希与锚点状态，不复制卡正文；legacy:true 的卡无可用锚点、不计入「已链接」。三者都只在本机 <memoryRoot>，不上传。

## 5. 本地优先、无遥测

- 默认配置本身不发网络请求、无遥测；embedding 默认开启但只加载**本地**模型（模型缺失静默退关键词），Router / RouterFace 只有在你配置了 provider 后才会通过宿主调用你配置的模型——这是 1.8.0 默认开启后的行为，不是插件自行联网。
- `@kenz1117/dsh-engram` 是可选增强：装了会多 `engram_*` / `memory_save` 工具，不装不影响 22 个工具；engram 的数据由其自身策略管理。
- 插件不收集、不上传记忆库、身份、会话日志。

## 6. 你需要知道的风险

- `memoryRoot` 下的记忆、`journal/`、`.longlive/` 审计与共享文件都是**本地明文**；请靠操作系统账号权限与磁盘加密保护。
- 共享大脑的共享板/活动流是给「同一个人的多个会话」用的，不要在没有隔离的共享机器上开启。
- 发布包隐私扫描只覆盖**包内容**，不覆盖你运行时写下的记忆/日志；发 issue 或分享日志前请自行脱敏。

## 7. 相关文档

- 身份卡与开关：[FEATURES.md](FEATURES.md)、[CONFIG.md](CONFIG.md)
- 有据才答与来源闸：[ANSWER-GUARD.md](ANSWER-GUARD.md)
- 共享大脑活动流：[FEATURES.md](FEATURES.md) §`sharedBrain.activity`

## 8. 1.8.0 发布包隐私清理（做了什么、怎么验证）

1.8.0 把「发布包不携带内部/个人信息」当成硬门，清理内容：

- **内部开发日志**：`CHANGELOG.md` 拆为发布版（本包内，用户可读的功能/修复摘要）与内部版
  （不随包，含验收过程与任务编号）。
- **身份默认中性**：内置默认身份不含人名/角色/称呼；`IDENTITY.md` 由用户自建，缺失时用中性默认。
- **文档中性化**：作者个人叙事、合作者原话、内部文件名/编号、内部报告路径等从发布文档移除或改写；
  配置示例统一用占位符（`<profile-name>`、`<你的名字>` 等）。
- **内部报告不随包**：含姓名清单的内部隐私报告、发布清单等仅留内部，不进 `files` 白名单。

**怎么验证**（发版前 + 打包后各跑一次）：

- 对**发布包内容**（`package.json.files` 白名单）跑隐私 token 扫描：人名/内部项目名/内部路径/
  任务编号/评审称呼等命中数必须为 0；源码树扫描不算，按打包后的文件清单扫。
- 对**打包后的 tgz 解包目录**再跑一遍同样的扫描；同时跑绝对路径扫描（`scripts/scan-abs-paths.mjs`，
  blocker=0）。
- 检查 `package.json.files` 白名单：内部文件（内部变更日志、内部隐私报告、发布清单）不在其中；
  `docs/PRIVACY.md` 在包内。
- 以上结果写入发布证据（扫描命令、0 命中输出、白名单 diff），作为 1.8.0 发版门的一部分。

> 说明：隐私扫描只覆盖发布包内容；用户运行时的记忆库/日志仍需用户自行保护（见第 6 节）。

## 9. 质量门与 after2 双口径（1.8.0）

- after2 双口径（raw 冻结 + delivery 契约）均会公布；口径差异见 `GATE3-CRITERIA-V2.md`（判据文件随发布证据归档，不随发布包）。
- delivery 契约只统计行为指标，不改变 raw 判分冻结口径；live 用户可见正文的强制替换依赖宿主 `message transform` 钩子（1.9 计划）。
