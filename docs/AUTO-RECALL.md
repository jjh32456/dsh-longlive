# 自动想起（auto-recall）

0.9.0-rc.1 把 auto-recall 作为可选能力收进主包。**1.8.0 起默认开启**（未显式给则 `true`，仅字面 `false` 关闭）；开启时它在本轮
`agent/pre-step` 的 waterfall 末端读取 memoryRoot 下的卡片，挑与当前用户消息
最相关的几段，作为一条合成 user 消息并入本轮上下文。

## 打开方式

```yaml
config:
  autoRecall:
    enabled: true
    topK: 3
    budgetTokens: 2000
    everyNTurns: 6
```

默认值：`enabled: true`（1.8.0 起）、`topK: 3`、`budgetTokens: 2000`、`everyNTurns: 6`。
显式 `enabled: false` 时零注入，行为与无此能力时一致。

## 1.8.8：强制触发 + 链路直连 + 自学习（M2）

一句话：**你一发任务消息，当轮就先想起一次**；你常用的词/项目词通过链路**直接指向**相关老卡；
你说「对/就是这个」它会记下来，说「不对/不是这个」它会减权，久不用会衰减。

### ① 自动回忆指向（forced recall + link）

- 每条真实用户任务消息，在 `agent/pre-step` 的 `step === 1` 就强制召回一次，
  **不再等 everyNTurns、也不再被 quiet 门控挡住**；同一轮最多一次。
- 纯应答不刷屏：消息去掉空白/标点后 ≤6 字符且没有任务动词（如「好」「嗯」「ok」「继续」
  「谢谢」「收到」）→ 不强制召回，走原来的按轮次/话题切换路径。
- 链路直连：`<memoryRoot>/.longlive/recall/links.jsonl` 里的「词 → 卡」边，按 `weight`
  从高到低命中用户消息里的词（中文按子串、拉丁词按词边界）；**命中即注入**，日志记
  `source:"link"`；之后仍跑一遍原来的 `chooseRecall` 补漏，同一张卡只注入一次。
- 每轮注入上限：≤5 张卡 / ≤2000 tokens（沿用 `chooseRecall` 的预算裁剪与 `minScore`）；
  已注入过的卡（`collectInjectedTexts`）去重；隐私命中卡（`local_only` / `privacyScan`）
  **整卡不注入**；召回异常 fail-open，不挡这一轮。
- 关掉强制触发：`autoRecall.forceOnUserMessage: false`（默认 `true`）→ 完全回落 1.8.7
  行为；关掉链路：`recall.links.enabled: false`（默认 `true`）→ 只保留关键词/语义召回。

```yaml
config:
  autoRecall:
    enabled: true
    topK: 5                 # 1.8.8 强制路径实际还会被夹到 ≤5
    budgetTokens: 2000
    forceOnUserMessage: true # 1.8.8 新增；false = 回落 1.8.7
  recall:
    links:
      enabled: true          # 1.8.8 新增；false = 回落 1.8.7
      learn: true            # 在线学习（确认加权 / 否认减权 / 衰减）
```

### ② 高频词学习（self-learning links）

- 种子表来自**真实历史用户消息**的统计产物（词频 `n` / 出现卡数 `df` / 命中的卡内位置），
  用离线脚本把 `LINKS-SEED-v3.csv` 转成 `links.jsonl`：**词表是数据产物，不是代码常量**。
  构建命令（幂等、原子写、写前备份、写后审计，`--dry-run` 只统计）：
  `node scripts/recall-links-build.mjs --csv <seed.csv> --memory-root <记忆根>`；
  用 `--out <links.jsonl>` 可直接指定目标文件（审计与备份落在同目录），
  `--rollback <备份>` 回滚。
- 每行一条边，形状：
  `{term, cardPath, weight, source:"seed"|"learned", evidence:{n,df,tier,matchKind,cooccurCount,…}, createdAt, updatedAt}`；
  **只存词与卡路径和计数/时间，不存原句**。
- 学习信号：本轮注入后，把「本轮用户消息里的词 × 本轮注入的卡」记成待确认；
  下一轮用户说「对/就是这个/没错」→ 相关边 `weight += 1`；说「不对/不是这个/错了」→
  `weight -= 1.5`（≤0 删边）；`N` 天（默认 30）未用按 `0.85`/周期衰减。
- 上限：单 term ≤5 张卡、单卡 ≤50 个 term、单轮直连 ≤5 张；溢出按 weight 淘汰。
- 写回是 **tmp → rename 原子写 + 备份 + 追加审计行**（`.longlive/recall/links-audit.jsonl`），
  可导出、可回滚（`--rollback <备份>`）、可从种子表重建（重建只替换 `source:"seed"` 边，
  学习出来的 `source:"learned"` 边保留）。
- **误归因风险（已知边界）**：用户说「不对/不是这个」不一定代表这张卡错了——可能是话题
  没对上、上下文没跟上、或纠正的是别的段落。因此本实现把反馈当作**弱信号**：一次反馈只
  调整 ±1 个权重（默认值），不做批量改写，不删除学习边以外的任何东西；每条调整都落审计行，
  可以回放与回滚。共现同样不等于因果（注入卡恰好同轮出现就被计数），所以边权只作为排序
  依据，不作为"这张卡一定相关"的断言。

### ③ 旧记忆适配（老卡不动，只补门面）

- 老卡文件不动、正文不改：`topics/`、`procedures/`、`journal/`、`handover/` 里的 Markdown
  卡按原 frontmatter（`title` / `aliases` / `scope_in`）读取，不迁移、不改写。
- 统一门面 = `links.jsonl` 的「词 → cardPath」边（外加原有 `entities.mjs` 实体别名通道），
  让新召回认识老卡；`links.jsonl` 由上面的构建脚本**幂等**生成（同输入同输出字节），
  支持备份/回滚，所以这一步是可逆的。
- 运行期若发现链路文件损坏（坏行 >50%），按"不可写"处理：不学习、不写回，召回照常
  fail-open，坏文件保留现场给审计。

### 归档兜底（1.8.8，可选模块）

常规召回 + 链路命中合计为 0 时，才尝试从**历史会话归档**里找线索（被截断/归档切掉的轮次）。
归档检索由 `src/recall/archive-search.mjs` 提供（`searchArchive({memoryRoot, queryText, limit})`）；
模块不存在或调用失败时**静默回落**，日志记 `archiveUnavailable:true`（不算成功、不假报命中）。
命中时注入 `【自动想起·归档】` 块：≤3 条、≤800 tokens，每条带 `session` / `turn` / 归档文件出处，
正文过同一个隐私扫描。

## 语义召回（embedding，1.8.0 起默认开启；模型缺失静默退关键词）

在关键词之外，可以再挂一个**本地**向量召回（1.8.0 起默认开；模型缺失时静默走关键词）。它和 `autoRecall` 是两个独立的开关：
`embedding.enabled` 只决定“有没有向量”，`autoRecall.enabled` 决定“要不要自动注入”。

```yaml
config:
  autoRecall:
    enabled: true
    budgetTokens: 2000
  embedding:
    enabled: true
    modelPath: <model-dir>   # 目录里要有 config.json / tokenizer.json / onnx/model.onnx
```

- 模型是 `Xenova/bge-small-zh-v1.5` 的 ONNX 版（BERT，hidden 512，4 层，CLS pooling）。
  目录缺文件时可从 hf-mirror.com 或 modelscope 拉同名文件，**不要求联网**才能运行。
- 运行时依赖 `onnxruntime-node`（`~1.16.3`）写在 `optionalDependencies`；默认安装不
  保证带上它。加载失败、模型缺失、tokenizer 损坏都只告警一次，然后**静默退回纯关键词**。
- 融合分：`0.6 * min(1, 关键词分 / 2.5) + 0.4 * 余弦`。零关键词命中卡只有在余弦
  ≥ `semanticAdmit`（0.55）且融合分 ≥ `minFusedScore`（0.2）时才准入；两个权重、两个
  阈值都可在 `embedding` 下覆盖。没有向量时完全走原来的关键词路径。
- 向量缓存：`<memoryRoot>/.longlive/embeddings/index.json`，按卡片内容 sha256 增量更新；
  模型指纹（onnx 大小/修改时间、tokenizer、maxSeqLen、查询前缀）变化时全量重建。
  缓存写入失败不影响召回，只是下一轮重算。
- 关键词分仍按 `minScore`/`minHits` 过门；语义准入只加候选，不降低原有关键词门槛。

### recall-log（面板「本轮想起」）

每个 `step === 1` 的轮次都会向 `<memoryRoot>/.longlive/recall-log.jsonl` 追加一行，
由宿主面板按行读取；写日志失败只告警，不影响注入：

```json
{"at":"2026-11-05T14:11:18.982Z","sessionId":"...","turn":1,
 "injected":[{"id":"topics/x.md","title":"…","score":0.237,"reason":"vector"}],
 "blocked":[{"id":"topics/y.md","title":"…","reason":"max-items"}]}
```

1.8.8 起每行固定带强制召回的取证字段（周期路径仍在，字段为缺省值）：

```json
{"turn":12,"why":"user-task","trigger":"forced","forced":true,
 "query":"接着做 v39 战役","elapsedMs":37,"outcome":"injected",
 "injectedCount":2,
 "injected":[{"id":"topics/v39.md","title":"…","score":0.83,"reason":"link","source":"link"}],
 "link":{"enabled":true,"matchedTerms":["v39","战役"],"injectedCount":2,"tokens":145},
 "archiveUnavailable":false,
 "gate":{"recall":true,"why":"forced","everyNTurns":6}}
```

- `trigger`：`forced`（强制路径）/ `turn<=1` / `topic-switch` / `quiet` …（周期路径原值）；
- `why`：强制路径固定 `user-task`（"这一轮被强制触发过"），是否真的注入了看
  `injected` / `outcome`（`injected` / `zero-hit` / `gate-skip` / `error` /
  `factory-unavailable`），不要只看 `why`；
- `injected[].source`：`link`（链路直连）/ `archive`（归档兜底）/ `file`（原关键词/语义召回）；
- `query` 是脱敏后的用户消息摘要（≤200 字符，手机号/邮箱/身份证/IP/超长 token 打码）；
- 失败时 `error:true`，进程内 catch 后照常返回本轮 decision（fail-open）。

`reason` 取 `keyword+vector` / `vector` / `keyword` / `link`（1.8.8 链路直连）/
`archive`（1.8.8 归档兜底）；`blocked` 的 `reason` 取
`privacy` / `dedupe` / `budget` / `max-items` / `seen`（够格但没进本轮注入的卡）。

## 数据来源

- 默认扫描 `<memoryRoot>/topics` 与 `<memoryRoot>/handover` 的 Markdown 卡片。
- 卡片按标题、别名、正文 bigram 打分；只取分数过线的，最多 `topK` 张。
- 注入正文按 `budgetTokens` 估算截断，不会把整张卡塞进来。
- 隐私过滤先过 gate（`DSH_PRIVACY_GATE` 指向的外部 gate 或本地 PII 规则），
  命中私密片段就不注入。

### 卡片层与链接（1.8.0）

- **AutoCard**：每个 EventRecord 一条派生索引卡（`.longlive/index/cards.jsonl`，`eventId` 幂等），带 `anchor {sessionId,turn,seqStart,seqEnd,digest}`；逐行 HMAC 签名，`anchor.digest` 用 `turnDigest` 与 L0 校活，注入时带 `[原文 sessionId#turn]`。
- **精卡 sidecar 回链**：`.longlive/index/card-anchors.jsonl` 记录人工 `topics/` 卡到源文件的锚点；`legacy:true` = 无可用锚点，**不计入「已链接」**（本机基线 25 张 → linked 7 / legacy 18）。
- **自动蒸馏/自动结论**：`autoConclusion` 1.8.0 起默认开启（显式 `false` 关闭）；蒸馏/遗忘口径见 `M2D-FORGETTING.md`，签名与信任边界见 `CONFIG.md` §1.11b。

## 什么时候想、什么时候安静

1.8.7 及以前（`forceOnUserMessage:false` 时仍是这一套）：

- 只在 `payload.step === 1` 触发；同一轮后续 step 不重复注入。
- turn 1 必然检索一次（`gate.why = "new-session"`）。
- 压缩之后触发一次（`after-compaction`）。
- 话题明显切换（当前消息与上次查询的 bigram containment 低于 0.25）→ 触发
  （`topic-switch`）；与上次查询完全相同 → 跳过（`same-as-last`）。
- 其余情况安静（`quiet`），日志 `gate.recall:false`。
  历史口径（1.8.0/1.8.1 文档）：每 `everyNTurns`（默认 6）才心跳重扫一次，turn 2–5 若话题没换就保持安静、turn 6 再扫；
  注意：1.8.2 起 `everyNTurns` 不再参与门控判断（`decideTrigger` 里没有取模逻辑），
  它仍是兼容配置键；真实的触发是"新会话 / 压缩后 / 话题切换"三种。

1.8.8 起（默认 `forceOnUserMessage:true`）：

- 每条真实用户任务消息都强制召回一次（`gate.why = "forced"`），不看上面那套门控；
- 纯应答（≤6 字符且无任务动词）→ 不强制，回落上面那套；
- 强制/周期触发都会先跑链路直连，再跑 `chooseRecall` 补漏。

## 注入放在哪、为什么看不见

注入消息的 source 固定为：

```json
{ "kind": "session-reference", "form": "recall", "version": 1, "references": [] }
```

宿主把它投影成 **context 节点**，`isVisibleChatNode()` 返回 false。所以：

- 聊天记录里**看不到**「自动想起」气泡，用户不会被打断；
- 但 `deriveMessages` 仍包含这段正文，模型本轮能读到；
- 可见性由**潜望镜**面板承担：要审计“这轮到底想起了什么”，去潜望镜看
  context 节点，而不是翻聊天气泡。

这是已知限制，不是 bug：回忆不可见是为了不污染对话流。

## 消息顺序

开启开机卡时，最终顺序为：

```text
[user, boot, runtime, auto]
```

`auto` 永远排在最后，不抢开机卡的位置；没有开机卡时就是 `[user, runtime, auto]`。
排序由 `inject-order` 的 `TurnNavigator`/`firstUserText` 逻辑保证，不依赖消息
id 的字典序。

## 失败处理

- 卡片目录缺失、单张卡解析失败、gate 抛错：本轮跳过，不注入，不阻断对话。
- 注入工厂拿不到 `createUserMessage`：跳过并只在该能力显式打开时告警。
- 任何异常都吞在 auto-recall 自己的 pre-step 内，不影响 0.8.0 的工具与截断流程。

## 测试

- 仓库测试（npm 包不含）：`test/auto-recall.test.mjs`
- 仓库测试（npm 包不含）：`test/embedding-recall.test.mjs`（tokenizer / 增量缓存 / 融合 / recall-log）
- 仓库测试（npm 包不含）：`test/integration-pre-step.test.mjs`
- 仓库测试（npm 包不含）：`test/recall-force-links.test.mjs`（1.8.8：强制触发 / 链路直连 /
  在线学习 / 预算去重 / 隐私 / 坏文件 fail-open / 归档兜底 / recall-log 字段）
- `test/v4-hardening.test.mjs`
- `test/feature-flags.test.mjs`（默认值与单开关隔离）

统一入口：`node test/run-rc.mjs`。
