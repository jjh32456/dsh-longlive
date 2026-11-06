# 自动想起（auto-recall）

0.9.0-rc.1 把 auto-recall 作为**默认关闭**的可选能力收进主包。打开后，它在本轮
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

默认值：`enabled: false`、`topK: 3`、`budgetTokens: 2000`、`everyNTurns: 6`。
`enabled: false` 时与 0.8.0 完全一致。

## 语义召回（embedding，默认关闭）

在关键词之外，可以再挂一个**本地**向量召回。它和 `autoRecall` 是两个独立的开关：
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

`reason` 取 `keyword+vector` / `vector` / `keyword`；`blocked` 的 `reason` 取
`privacy` / `dedupe` / `budget` / `max-items` / `seen`（够格但没进本轮注入的卡）。

## 数据来源

- 默认扫描 `<memoryRoot>/topics` 与 `<memoryRoot>/handover` 的 Markdown 卡片。
- 卡片按标题、别名、正文 bigram 打分；只取分数过线的，最多 `topK` 张。
- 注入正文按 `budgetTokens` 估算截断，不会把整张卡塞进来。
- 隐私过滤先过 gate（`DSH_PRIVACY_GATE` 指向的外部 gate 或本地 PII 规则），
  命中私密片段就不注入。

## 什么时候想、什么时候安静

- 只在 `payload.step === 1` 触发；同一轮后续 step 不重复注入。
- turn 1 必然检索一次。
- 之后默认受 `everyNTurns` 节流：`turn % everyNTurns === 0` 时做一次心跳重扫。
  默认 6 时，**turn 2–5 若话题没换就保持安静**，turn 6 再扫；往后 12、18……
- 话题明显切换（当前消息与上次查询的 bigram containment 低于 0.25）会提前触发，
  不必等心跳。
- 与上次查询完全相同则跳过。

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

- `test/auto-recall.test.mjs`
- `test/embedding-recall.test.mjs`（tokenizer / 增量缓存 / 融合 / recall-log）
- `test/integration-pre-step.test.mjs`
- `test/v4-hardening.test.mjs`
- `test/feature-flags.test.mjs`（默认关闭与单开关隔离）

统一入口：`node test/run-rc.mjs`。
