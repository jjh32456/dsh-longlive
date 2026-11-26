# 自动想起接线（wire format）

这份文档写给以后改 `src/features.js` / `src/recall/*` 的人：下面是从真实
Cordis fixture 抄下来的形状，不要自创 `ctx.emit`、不要自己拼 `payload`。

## 真实 waterfall 形状

宿主注册的是 `agent/pre-step`，waterfall 的 `next()` 返回一个 decision：

```js
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next();          // 只调用一次
  if (!decision || decision.kind === 'reject') return decision;
  if (Number(payload?.step) !== 1) return decision;
  // ...挑选、渲染、校验 source...
  return { ...decision, messages: mergeInjectionOrder(decision.messages, message) };
}, { prepend: false });
```

fixture 见 `test/fixtures/pre-step-container.mjs`：`PreStepBus.waterfall()` 先取
第一个 callback，把共享的 `next` 传进去，最后由最内层返回
`{kind:'enter', messages:[...]}`。测试断言的是这个 decision，不是聊天记录。

## 本包的两条 pre-step

| 能力 | 选项 | 位置 | 做什么 |
| --- | --- | --- | --- |
| 开机卡 `identityCard` | `{ prepend: true }` | 在 `await next()` **之前** | 把卡插到第一条真人消息之后；被 reject 时撤回 |
| 自动想起 `autoRecall` | `{ prepend: false }` | 在 `await next()` **之后** | 在 decision.messages 尾部并入回忆消息 |

两条都只在 `step === 1` 工作。开机卡先跑，自动想起后跑，所以最终消息顺序是：

```text
[user, boot, runtime, auto]
```

`runtime` 是宿主自己的 runtime context；`auto` 排在最后。没有开机卡时是
`[user, runtime, auto]`。`TurnNavigator` 的 `firstUserText` 负责找到“第一条真人
消息”，不要用 `messages[0]` 代替——压缩后第一条可能是 system/runtime。

## 注入 source

回忆消息由 `createUserMessage({ content:[{type:'text',text}], source })` 生成，
`source` 必须是：

```js
{ kind: 'session-reference', form: 'recall', version: 1, references: [] }
```

`assertInjectionMessage()`（`src/recall/inject-order.mjs`）会拒绝任何别的形状。宿主据此把消息投影为 **context
节点**，`isVisibleChatNode()` 返回 false：聊天里看不到，但 `deriveMessages` 仍
含正文。审计入口是**潜望镜**面板（1.8.0：`GET /api/longlive-panel/v2/state` 返回 27 条路由 / 18 个动作；「本轮想起」读 `.longlive/recall-log.jsonl`），不是聊天气泡。这也是“回忆不可见”的实现基础。

## 顺序合并

`mergeInjectionOrder()` 不重排既有消息，只按标记把回忆放到最后；重复 id 会被
去掉。不要 `unshift`，不要按时间戳排序——宿主的消息没有稳定时间戳。

## 失败语义

- `next()` 抛错：原样抛回，auto-recall 不接。
- 挑选/渲染/gate 抛错：本轮回退到 `decision`，不注入。
- 工厂缺失：回退到 `decision`，仅在显式打开时告警一次。
- 绝不修改 `decision.kind`，也绝不伪造 `messages` 以外的字段。

## everyNTurns 与 1.8.8 强制触发

`decideTrigger()` 的纯函数规则（`src/recall/recall-core.mjs`）——**1.8.2 起这里没有取模心跳**，
`everyNTurns` 只是兼容配置键，不参与门控：

```js
if (step !== 1) return { recall: false, why: 'mid-turn' };
if (query === '') return { recall: false, why: 'empty-query' };
if (turn <= 1) return { recall: true, why: 'new-session' };
if (state.compactedSinceLast) return { recall: true, why: 'after-compaction' };
if (last === query) return { recall: false, why: 'same-as-last' };
if (containment(query, last) < 0.25) return { recall: true, why: 'topic-switch' };
return { recall: false, why: 'quiet' };
```

1.8.8 在它**之前**插了一段强制触发（`src/recall/index.js` 的 pre-step，`autoRecall.forceOnUserMessage`，
默认 `true`）：

```js
const forceCandidate = cfg.forceOnUserMessage
  && lastUserText !== ''                        // 本轮最后一条真实 user 消息（isRealUserMessage）
  && !isPureAcknowledgement(lastUserText)       // 纯应答（≤6 字符且无任务动词）不强制
  && st.forcedTurn !== turn;                    // 同一轮最多一次
const gate = forceCandidate
  ? { recall: true, why: 'forced', everyNTurns: cfg.everyNTurns }
  : decideTrigger({ ... });
```

强制路径的召回顺序（只加不改，chooseRecall / renderInjection 对外契约不变）：

1. `selectLinkItems()`：`links.jsonl` 里命中的词 → 关联卡，按权重排序、≤5 张、
   过隐私/去重/预算，`source:"link"`；
2. 用剩下的预算跑原来的 `chooseRecall()` 补漏；
3. 两者合并后仍是 ≤5 张 / ≤2000 tokens；同一张卡只注入一次；
4. 合计 0 命中时才尝试 `archive-search.mjs` 的归档兜底（`loadModule` 注入缝，
   失败/缺模块 → `archiveUnavailable:true`，静默回落）；
5. 渲染成【自动想起】块（或【自动想起·归档】块）→ `assertInjectionMessage`
   → `mergeInjectionOrder` 放末尾。

注入块标记：`【自动想起】` 与 `【自动想起·归档】` 都算 auto 消息（`isAutoMessage`），
重复注入时会被 `mergeInjectionOrder` 换掉而不是叠加。

日志（`buildRecallLogRecord`）：强制路径固定 `trigger:"forced"` / `why:"user-task"`，
并带 `forced`、`query`（脱敏摘要）、`elapsedMs`、`outcome`、`link`、`archiveUnavailable`、
`injected[].source`（`link` / `archive` / `file`）。周期路径字段与 1.8.7 保持一致。

## 隐私 gate

`privacy.mjs` 先走 `DSH_PRIVACY_GATE` 指向的 gate，未配置时用本地 PII 规则。
命中 `local_only` 的片段整段丢弃，不做“部分脱敏后仍然注入”。
