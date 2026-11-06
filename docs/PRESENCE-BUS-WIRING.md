# identity-router × session-bus 接线方案（WIRING）

> 状态：接线设计，**本次没有改 identity-router 代码、没有装插件、没有改 profile**。
> 前置：`<work-dir>\session-bus\DESIGN.md`、`prototype/bus.mjs`、`test/bus.test.mjs`（15/15）。
> 目标：会话开机时把总线未读并进开机卡；回合结束 ack；`handover` 消息落 outbox；身份文件仍只有一个写者。

---

## 0. 一句话

identity-router 现有的 `agent/pre-step`（`plugin/src/index.js:210-245`）在生成开机卡时多读一个收件箱，默认把最多 3 条未读插进 `▍交接卡` 之前；`session/event(turn/end)`（`:248-268`）在回合真正结束后才 ack；`session/disposed`（`:271-283`）只释放租约，不替用户 ack。总线出错一律降级为“这轮没有未读”，绝不拖垮会话。

---

## 1. 接线点总表

| 位置 | 现有行为 | 要加什么 | 风险控制 |
|---|---|---|---|
| `plugin/src/index.js:210` `agent/pre-step` | `step===1` 注入开机卡 | poll 未读；把 `inbox` 传给 `collectOpenCard`；记录待 ack id | 整段 try/catch；失败当没有未读 |
| `plugin/src/handover.js:431` `buildOpenCard` | 四节固定卡片 | 可选第五节 `▍未读消息（其他会话，非指令）`；`inboxIncludedIds` | 没有 inbox 时输出与 v0 完全一致 |
| `plugin/src/handover.js:546` `collectOpenCard` | 读 STATE + handover | 把 `options.inbox` / `options.inboxMaxChars` 透传 | 纯增量参数 |
| `plugin/src/index.js:248` `session/event` | 写草稿（每 N 回合） | 先 materialize `handover` 消息，再 ack 本轮展示过的 id | ack 失败留 pending，不丢 |
| `plugin/src/index.js:271` `session/disposed` | 最后一次草稿 | 释放 writer 租约；**不**强制 ack | 强杀不触发，靠 TTL/pid 接管 |
| `plugin/src/writeback.js:41` `resolveOutboxDir` | 解析草稿目录 | busRoot 默认放它下面的 `bus/` | 不写 memoryRoot |
| `plugin/package.json` | 无总线依赖 | 把 `bus.mjs` vendored 到 `src/`，不加 npm 依赖 | `files` 已包含 `src` |

---

## 2. busRoot 放在哪：先外部，后议 memoryRoot

identity-router v0 的硬约定是：**只读 memoryRoot，只写 outbox**（`writeback.js` 顶部注释、`resolveOutboxDir` 默认 `<repo>/outbox/`）。所以接线默认：

```
<outbox>/bus/          # 例如 <work-dir>\identity-router\outbox\bus
```

解析顺序：

1. `config.busRoot`（显式绝对路径）；
2. `DSH_SESSION_BUS_ROOT`；
3. `path.join(resolveOutboxDir(config, env), 'bus')`；
4. 任何情况下拒绝 UNC；root 必须是本地可写目录。

这样 v0 的写范围只扩大了一个明确的子目录 `outbox/bus`，仍然不碰 `<memory-root>`。

**生产升级项（本次不启用）**：`<memoryRoot>/.longlive/bus`。它与 live 登记表同根、随记忆目录备份，结构上更顺；但这是让插件写 memoryRoot，属于新的写权限，必须由 owner 单独批准，并明确“bus 归 session-bus 插件所有，identity-router 只是调用方”。不要因为 `.longlive` 已经是插件状态目录就默认合规。

`memoryRoot` 的解析必须与 longlive 实际使用的一致：

```js
const memoryRoot = resolveMemoryRoot(settings, process.env); // handover.js:380
```

本机实测 live 在 `<memory-root>\.longlive\live\`；如果这里解析成 `%USERPROFILE%\.dsh\longlive-memory`，所有 peer 会显示 `missing`，死会话不会被拒发。这是接线时最容易踩的坑，必须在启动日志里打一次实际路径。

---

## 3. 开机时读哪些未读

### 3.1 定义

“未读”= `<busRoot>/inbox/<sessionId>/` 下所有 **pending `.json`**：

- 不含 `acked/`（已确认）；
- 不含 `dead/`（损坏/外来，已隔离）；
- 不含过期（`poll` 负责删）；
- 不含 host 不匹配（`poll` 负责隔离）；
- `control` 不展示（机器协议，见 DESIGN §5.3）。

**不需要游标文件**：ack 会把消息移出 pending，所以 pending 集合本身就是未读集合。开机 `poll({since: 0, limit: maxItems + 1})` 即可。`since` 只在同一回合内二次 poll 时使用；v0 默认只在 `step===1` poll 一次，所以不需要持久化 cursor。这样 identity-router 不用为游标再写一个文件，边界更干净。若这次 poll 投递了超前于本机时钟（5 分钟窗内）的消息，返回的 `cursor` 是数字时间戳而不是 id，下一轮会重放那条消息；语义见 §3.5。

### 3.2 伪代码

```js
// plugin/src/index.js — pre-step 内，拿到 agent 之后
const sessionId = normalizeSessionId(sessionKeyFor(agent)); // 来自 bus.mjs；失败→ warning，跳过总线
const bus = getOrCreateBus(record, sessionId);                  // 每个会话一个句柄，缓存

let inbox = null;
if (bus) {
  try {
    const pending = bus.poll({ since: 0, limit: settings.busMaxItems + 1 });
    const usable = pending.messages.filter((m) => m.kind !== 'control');
    const visible = usable.slice(0, settings.busMaxItems);
    inbox = {
      messages: visible,
      total: usable.length + (pending.hasMore ? 1 : 0), // hasMore 只用于“还有更多”提示
      hasMore: pending.hasMore,
    };
  } catch (error) {
    logWarn(`BUS_POLL_FAILED:${error?.code ?? error?.message ?? error}`);
    inbox = null; // 降级：这轮没有未读
  }
}

const card = collectOpenCard({
  memoryRoot: settings.memoryRoot,
  statePath: settings.statePath,
  handoverDir: settings.handoverDir,
  maxChars: settings.maxChars,
  inbox: inbox ?? undefined,          // 新增
  inboxMaxChars: settings.busMaxChars, // 新增，默认 320
});
// import { mergePendingAckIds } from './bus.mjs';
// 1) 先重试上一轮没 ack 掉的 id（幂等，already 也算完成），仍未成功的留在
//    record.pendingAckIds；2) 再把本轮注入的 id 合并进来。不能无条件覆盖：
// 覆盖会丢掉上一轮 ack 失败的 id，它们会一直 pending 到 TTL。
if (record.bus && record.pendingAckIds?.length) {
  const remaining = [];
  for (const id of record.pendingAckIds) {
    try {
      const result = record.bus.ack(id);
      if (!result.ok && result.code !== 'E_NOT_FOUND') remaining.push(id);
    } catch (error) {
      remaining.push(id);
      logWarn(`BUS_ACK_RETRY_FAILED:${id}:${error?.code ?? error?.message ?? error}`);
    }
  }
  record.pendingAckIds = remaining;
}
record.pendingAckIds = mergePendingAckIds(record.pendingAckIds, card.inboxIncludedIds);
```

注意：

- `bus.poll` 是同步的；`agent/pre-step` 是 async，但这里不需要 await。
- 先 `next()` 再 poll，保持现有 waterfall 语义；下游 reject 就不注入、不 ack。
- `record.opened` 仍只在注入成功后置 true；注入失败时 `pendingAckIds` 不要留（下次重来）。
- **`pendingAckIds` 只能合并，不能覆盖**：`mergePendingAckIds(previous, included)` 去重、保序（旧 id 在前），幂等重试依赖它。上一轮 ack 失败的 id 必须活到下一次 `step===1`。
- 卡片注入成功后**不立刻 ack**，等 `turn/end`。
- **v0 只在会话首次 `pre-step` 注入一次**（`record.opened`）。同一会话之后新到的消息不会自动进上下文——总线的语义是“下次开门取信”，不是实时推送；要实时化得另做二次注入或每步 poll，见开放问题。

### 3.3 为什么 limit = maxItems + 1

多取一条用于判断“还有更多”，但只展示 `maxItems` 条；多出来的那条不展示、不 ack，留到下次。`hasMore` 为 true 时卡片尾部显示 `…另有 N 条`，N 至少为 1，精确值可以不知道（`poll` 的 `hasMore` 只说明还有）。

### 3.4 会话 id 不合法怎么办

`sessionKeyFor(agent)` 可能是 UUID、`session-...` 或子代理 id。`normalizeSessionId` 只接受 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`。

- 合法 → lower-case 后作为 bus 身份。
- 不合法（含 `:`、空格、中文等）→ 记一次 `BUS_INVALID_SESSION_ID:<id>`，**跳过总线**，不猜、不哈希。哈希会把地址变成不可预测的，别人没法 `send`。
- 子代理：沿用 `skipSubagents`，默认不接总线（避免每个子脑都来抢卡）。

### 3.5 游标与 5 分钟时钟容忍窗

`poll` 的 `maxClockSkewMs` 默认 300000ms（5 分钟）。发送侧用它拒绝超前墙钟的时间戳（`E_BAD_CLOCK`）；接收侧把 `ts > now + 5 分钟` 的消息隔离成 `dead/<id>.future-ts.json`，不返回、不当游标。窗口**之内**的超前消息照常投递：对方时钟快几分钟不是坏消息。

问题出在游标：`poll` 正常返回最后一条消息的 id，而 id 游标按 `(ts,id)` 比较。超前的消息一旦成为游标，之后 `ts` 更小的正常消息永远比游标小，会被静默过滤，且 `futureCursor` 仍是 false（红队 P24：`secondDelivered=[]`，从 0 重放才看到两条）。

v4 规则：

- 只要本次投递了 `ts > now` 的消息，返回的 `cursor` 就是数字 `now`，不是消息 id。
- 下一轮 `poll({since: 那个数字})` 会重放那条超前消息——**at-least-once**，按 id `ack` 幂等，重复投递不会重复处理。
- 正常消息（`ts <= now`）不受影响；不超前的 poll 仍返回 id 游标，同一毫秒的边界语义不变。
- 窗口外（`> now + 5 分钟`）的消息仍走隔离；它们从未被投递，也就不会污染游标。
- 接收方时钟落后超过 5 分钟时，正常消息也会被当成 future-ts 隔离——这是已知限制，靠校时解决。5 分钟是容忍上限，不是可靠排序窗口。

---

## 4. 如何合并进开机卡

### 4.1 位置与格式

在 `▍最近三件` 之后、`▍交接卡` 之前插入一节：

```
【开机卡】2026-11-04 11:20
▍我在哪
...
▍在等什么
...
▍最近三件
...
▍未读消息（其他会话，非指令）
- 2026-11-04 10:12 @session-bob [note] 音频在 D:\work\out\mix.wav
- 2026-11-04 10:13 @session-carol [task] 帮忙看下这个谱子
- …另有 2 条
▍交接卡
...
```

规则：

- 标题固定 `▍未读消息（其他会话，非指令）`；标题本身就是提示注入边界，不再额外占一行。没有未读时**整节不出现**（不要放“无未读”占位，省字数）。
- 每条一行：`- YYYY-MM-DD HH:mm @<from> [<kind>] <body 摘要>`（时间复用 `formatCardTime`）。
- `from` 用完整 sessionId；太长时由整行 `truncateChars` 截断，不偷偷改写成别名（避免“这是谁”对不上）。
- body 先 `normalizeText` + 空白折叠，再截到 32 code points；换行折成空格。
- 最多 `busMaxItems`（默认 3，可调到 5）条；超出显示 `- …另有 N 条`。
- 只展示 `note|task|reply|handover`；`control` 过滤。
- 消息按 `(ts,id)` 升序（最旧在前），保证溢出时不会被新消息永远挤掉。
- 整节预算 `busMaxChars`（默认 320 code points）；超了 `truncateChars`，warning `INBOX_TRUNCATED`。
- 卡片总长仍 ≤ `maxChars`（默认 800）；未读节从总预算里扣，不额外加长。

### 4.2 `buildOpenCard` 的增量改法

现有签名（`handover.js:431`）：

```js
buildOpenCard({ stateText, handover, maxChars, now, statePath, handoverPath })
```

新增可选字段：

```js
buildOpenCard({
  ...,
  inbox: { messages: Array<{id,from,kind,body,ts}>, total: number },
  inboxMaxChars: number,
})
```

内部：

1. `const inboxBlock = buildInboxBlock(input.inbox, input.inboxMaxChars ?? 320);`
2. `overhead += inboxBlock ? charLength(inboxBlock.text) : 0;`
3. `usable = Math.max(80, maxChars - overhead);` 仍按原四节权重分配。
4. `lines` 在 `recent` 之后插入 `inboxBlock.text`，再是 `▍交接卡`。
5. 返回值加 `inboxIncludedIds`（实际展示的 id 数组）和 `found.inbox`。
6. `inboxBlock.truncated` 或 `total > messages.length` → warning `INBOX_TRUNCATED` / `INBOX_OVERFLOW`。
7. 没有 `inbox` 或 `messages.length === 0` → 不产生任何节，**输出与 v0 字节级一致**，现有 33 个测试不需要改。
8. `buildInboxBlock` 内部对每条消息做字段类型校验；坏条目跳过并 warning，**绝不把异常抛到 `buildOpenCard`**，否则整张卡会退化成 `CARD_BUILD_FAILED`。

`collectOpenCard`（`handover.js:546`）只加两行透传：

```js
const card = buildOpenCard({
  ...,
  inbox: options.inbox,
  inboxMaxChars: options.inboxMaxChars,
});
```

### 4.3 预算例子（maxChars=800, inboxMaxChars=320）

- 头部 + 五个标题 + 10 ≈ 100 字；
- 未读节 ≤ 320 字；
- 剩余约 380 字给 `我在哪/在等什么/最近三件/交接卡`，仍按 1.1/0.9/1.1/1.3 分，每节下限 24。
- 如果没未读，320 字全部回到四节，和现在一样。

不要为了塞消息把 `maxChars` 调大；开机卡是每轮都进的上下文，800 已经不小。

---

## 5. ack 生命周期

### 5.1 时机

| 时机 | 动作 | 理由 |
|---|---|---|
| `step===1` 卡片注入成功 | `record.pendingAckIds = mergePendingAckIds(record.pendingAckIds, card.inboxIncludedIds)` | 还没处理，不能 ack；与旧 id 合并，避免覆盖上一轮失败的重试 |
| `turn/end` 且 `event.data.reason.kind === 'completed'` | 逐条 `bus.ack(id)` | 只有成功回合才接近“看到了并处理完” |
| `turn/end` 且 `reason.kind` 为 `error` / `aborted` / 缺失 | **不** ack，保留 pendingAckIds | 宿主的 `turn/end` 在 `finally` 里发，失败回合也会来；ack 了消息就永久消失 |
| `session/disposed` | **不** ack；只释放租约 | 销毁前可能没处理，宁可重投 |
| 下一次 `step===1` | 先重试上一轮 pendingAckIds，再把新注入的 id 合并进去 | 幂等，重复 ack 返回 already；覆盖会让失败 id 永远 pending |
| `busAckOn='never'` | 永不 ack | 只用于调试；消息会一直重投到 TTL |

### 5.2 代码位置

在 `session/event` 的 `turn/end` 分支开头（现有草稿逻辑之前）：

```js
// import { shouldAckOnTurnEnd } from './bus.mjs';
if (event?.type === 'turn/end') {
  if (shouldAckOnTurnEnd(event)) {
    // Same key as buildCardFor: sessionKeyFor(agent), not session?.id.
    const record = stateFor(sessionKeyFor(agent));
    if (record.bus && record.pendingAckIds?.length) {
      const remaining = [];
      for (const id of record.pendingAckIds) {
        try {
          const result = record.bus.ack(id);
          if (!result.ok && result.code !== 'E_NOT_FOUND') remaining.push(id);
        } catch (error) {
          remaining.push(id);
          logWarn(`BUS_ACK_FAILED:${id}:${error?.code ?? error?.message ?? error}`);
        }
      }
      record.pendingAckIds = remaining;
    }
  }
  // 原有草稿逻辑继续（error/aborted 回合也要走到这里）
}
```

`shouldAckOnTurnEnd(event)` 就是 `event.type === 'turn/end' && event.data?.reason?.kind === 'completed'`；缺失/未知 reason 一律 false（fail closed）。`turn/end` 分支本身仍要执行原有草稿逻辑——只是 ack 被包在条件里，不要 `return` 掉整个分支。

`E_NOT_FOUND` 视为完成（可能被上一轮 ack 掉了，或 TTL 过期被 poll 删了）；其余错误保留，下次重试。

**位置警告**：这段必须插在现有 `if (!settings.writeOnTurnEnd || settings.writeEveryTurns <= 0) return;` 和 `if (record.turns % settings.writeEveryTurns !== 0) return;` **之前**（`plugin/src/index.js:259-261`）。否则只有“写草稿的回合”才 ack，其它回合的消息会一直重投。`record` 键要和 `buildCardFor` 用同一个 `sessionKeyFor(agent)`；正常会话两者都是 `session.id`，异常情况下不要只按 `session?.id` 猜。

### 5.3 为什么不在注入后立刻 ack

注入成功不等于模型看到/处理；如果注入后崩溃，立刻 ack 会让消息永久消失。等到 `turn/end` 是折中：

- 回合正常结束且 `reason.kind === 'completed'` → ack；
- 回合以 `error` / `aborted` 结束 → 宿主 `finally` 仍发 `turn/end`，但**不** ack → 下次重投；
- 回合中途崩溃 → 没有 `turn/end` → 不 ack → 下次重投；
- 模型看到了但选择不处理 → 仍然 ack（at-least-once 不保证“处理”，只保证“送达”）。

需要“处理确认”的场景用 `kind:"task"` + 对方回 `kind:"reply"`，不要指望 ack 表达业务成功。

### 5.4 唤醒：live 与 cold 两条路（v0 只走邮箱）

宿主不是“不能唤醒”，v0 只是没有接：

- **live 空闲会话**：`ctx.agents.get(sessionId)?.followup(msg)` 能让它开始新一轮（`asar/agent.js:597`、`asar/agent-loop.js:806-807`、`README.md:47`）。若将来接：先写 inbox（持久化成功），再 `followup` 一条“你有新 bus 消息”的短提示；`followup` 失败只 warning，消息仍在 inbox，下次 `pre-step` 照常取。
- **cold 会话**：进程已退出/未启动，没有 live agent 可 `followup`；由 api-session-controller 的 resume 路径恢复（`:228,794,950`），恢复后的第一次 `agent/pre-step` poll 到消息。
- **v0 的选择**：两条都不接，投递只写 inbox；延迟上界 = 对方下一次 `pre-step`。这样不依赖未稳定导出的内部 API，也不会在会话忙/重启窗口里丢消息。

---

## 6. `kind:"handover"` 消息怎么落

### 6.1 卡片里

只显示一行摘要（同其他 kind），完整内容不在卡片里展开——800 字卡片塞不下。

### 6.2 outbox 里

`turn/end` ack 之前，对**本轮展示过**的 `handover` 消息逐条写：

```
<outbox>/bus-handover-<ts>-<messageId>.md
```

内容：

```markdown
# 来自会话总线

- id: m-...
- from: session-alice
- to: session-bob
- ts: 2026-11-04T02:12:00.000Z
- kind: handover

---

<body 原文>
```

规则：

- 文件名含 message id，天然唯一；已存在就跳过（幂等）。
- **绝不改 `handover/*.md`，绝不改 `STATE.md`**；outbox 是草稿区，合并由人/后续流程做。
- body 超过 `DRAFT_MAX_CHARS`（1600）时截断并加 `<!-- truncated -->`；完整内容仍在总线 `acked/` 里（如果还没 GC）。
- 写文件失败 → 这条 handover 不 ack，留在 pending 下轮重试；其他消息正常 ack。
- 不需要 writer 租约：每个消息一个独立文件，不会互相覆盖。
- 如果未来改成“追加到同一份草稿”，才需要 §7 的租约。

### 6.3 顺序

1. materialize handover 文件（成功/已存在）；
2. 再 ack 这条消息；
3. 非 handover 消息直接 ack。

这样即使 ack 后进程崩溃，outbox 里已经有完整内容；反过来（先 ack 后写）会丢。

---

## 7. 身份文件与写者唯一

### 7.1 谁写什么

| 文件 | 写者 | identity-router 的行为 |
|---|---|---|
| `<memoryRoot>/STATE.md` | 人/主会话 | 只读 |
| `<memoryRoot>/handover/*.md` | 人 | 只读 |
| `<outbox>/*.md` | identity-router | 写（现有 v0 行为） |
| `<outbox>/bus-handover-*.md` | identity-router | 新增：每条 handover 消息一个文件 |
| `<busRoot>/writer.lock` | 租约持有者 | 新增：只在“合并到同一份草稿”时获取 |
| `<busRoot>/inbox/**` | 各会话 | 读写 |

总线不拥有身份文件；它只是把消息送到 outbox。**身份仍然是“一份 STATE + 最新 handover，所有会话读同一份”**，不存在多副本同步。

### 7.2 什么时候需要租约

- v0 的 `bus-handover-<id>.md` 是每消息独立文件，**不需要**租约。
- 只有以下情况需要 `claimWriter`：
  - 把多条 handover 合并进同一个 `outbox/merged-*.md`；
  - 未来直接写 `handover/*.md`（当前禁止）；
  - 多个会话争同一个 canonical 草稿。
- 获取：`const lease = bus.claimWriter({ holder: sessionId, ttlMs: settings.busWriterTtlMs })`；默认 TTL **1800000 ms（30 分钟）**。返回值含 `{ token, nonce }`，存进 `record`，**不要写日志**。
- 续租：`bus.renewWriter({ nonce: lease.nonce, token: lease.token, ttlMs })`；或同 holder 再 `claimWriter`（token/nonce 不变，只刷新 `expiresAt`）。租约已过期时续租返回 `E_LEASE_LOST`，必须重新 `claimWriter` 拿新 token。
- 写回：`bus.fencedWrite({ file, token: lease.token, nonce: lease.nonce, value })`；锁被新持有者接管后，旧 token 的写回抛 `E_LEASE_LOST`，不会覆盖新值。
- 释放：`bus.releaseWriter({ nonce: lease.nonce, token: lease.token })`；不是 holder 返回 `not-holder`，nonce 缺失/不对返回 `bad-nonce`，不误删。
- 抢不到：跳过合并，warning `BUS_LEASE_HELD:<holder>`；卡片和单消息 outbox 不受影响。
- 崩溃：同 host pid 不在 → 下一次 claim 立即接管；跨 host 不存在（总线不跨机器）。

### 7.3 边界声明（必须写进插件 README）

> v0 的 identity-router 只读 memoryRoot、只写 outbox。接入 session-bus 后，写范围增加 `<outbox>/bus/**` 和 `<outbox>/bus-handover-*.md`，仍然不写 memoryRoot。若要改为 `<memoryRoot>/.longlive/bus`，必须先获得 owner 对“插件写 memoryRoot”的明确批准。

---

## 8. 配置

在 `normalizeConfig`（`plugin/src/index.js:31`）增加（全部有默认值，坏值不抛）：

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `busEnabled` | `false` | bool | 总开关；关闭时零 IO |
| `busRoot` | `null` | path | null → `<outbox>/bus`；拒绝 UNC |
| `busMaxItems` | `3` | 1..5 | 卡片最多展示几条 |
| `busMaxChars` | `320` | 120..400 | 未读节预算 |
| `busAckOn` | `'turn-end'` | `turn-end \| never` | ack 时机 |
| `busWriterTtlMs` | `1800000`（ms） | 60000..86400000 | 30 分钟租约；单位毫秒，与 `DEFAULT_WRITER_TTL_MS` 一致 |
| `busPollEveryStep` | `false` | bool | 长回合内额外 poll（节流 ≥1s，v0 不实现） |
| `busMergeHandover` | `true` | bool | 是否把 handover 消息落 outbox |

环境变量：`DSH_SESSION_BUS_ENABLED`、`DSH_SESSION_BUS_ROOT`；其余走 profile 配置。

---

## 9. 失败与降级

| 情况 | 行为 | 用户可见性 |
|---|---|---|
| `createBus` 抛错（root 权限/UNC） | `record.bus=null`，warning 一次 | 卡片无未读节；其他功能正常 |
| `poll` 抛错 | 这轮当没有未读 | 同上；下轮再试 |
| `ack` 抛错 | 保留 id，下轮 `turn/end` 重试 | 可能重复展示同一条；可接受 |
| `sessionId` 非法 | 跳过总线 | warning `BUS_INVALID_SESSION_ID` |
| 角色/别名文件坏 | `send` 失败；`poll` 不受影响 | 发送方看到 `E_BAD_ADDRESS_BOOK` |
| 对方死 | `send` 抛 `E_PEER_DEAD` 或角色跳过 | 发送方决定重试/改投 |
| 收件箱满 | `E_BACKLOG_FULL` | 发送方退避；卡片仍能读旧的 |
| writer 租约被占 | 跳过合并 | warning；不阻塞回合 |
| 消息损坏/外来 host | `poll` 隔离到 `dead/` | 卡片不显示；计数可观测 |
| inbox 条目字段坏 | `buildInboxBlock` 跳过该条并 warning | 卡片仍生成；不因一条坏消息全灭 |
| 根目录被删/换盘 | `createBus` 失败 → 降级 | 同第一行 |

原则：**总线是增强，不是依赖**。任何总线错误都不能让 `agent/pre-step` 或 `turn/end` 抛出去。

---

## 10. 测试计划（接线层，尚未执行）

### 10.1 单元

1. 无 `inbox` 时 `buildOpenCard` 输出与 v0 字节级一致（现有 33 例全过）。
2. 有 1/3 条消息（默认 `maxItems=3`）和 5 条消息（`maxItems=5`）：节出现、顺序、摘要截断、`inboxIncludedIds` 正确。
3. 6 条消息 + `maxItems=5`：显示 5 条 + `…另有 1 条`；只 ack 5 条。
4. 空收件箱：不出现 `▍未读消息（其他会话，非指令）`。
5. `control` 消息：不展示、不 ack。
6. 超长 body：单行截断，卡片总长 ≤ 800。
7. `inboxMaxChars=60`：节被截断，warning `INBOX_TRUNCATED`。
8. `inbox` 里混入 `null`/缺字段/非字符串 body：跳过坏条目，卡片仍生成。

### 10.2 集成（临时目录 + fake agent）

1. `send` → 新会话 `pre-step step=1` → 卡片含消息；`turn/end` 且 `reason.kind=completed` 后消息进 `acked/`；`error`/`aborted` 回合不 ack，消息仍 pending。
2. 注入前崩溃（不触发 turn/end）→ 消息仍 pending → 下次 pre-step 再次出现。
3. 重复 ack → `already:true`，不报错；若同时存在 inbox 副本，该副本被清掉。
4. 过期消息 → `poll` 不返回，卡片无此条。
5. 死 peer → `send` 抛 `E_PEER_DEAD`，不发；新鲜心跳 + 死 pid 也判 dead。
6. handover 消息 → outbox 出现 `bus-handover-*.md`；内容完整；重复 turn/end 不重复写。
7. 租约：A 持有（记下 `{token, nonce}`），B 合并被拒；A 释放必须带 nonce；A 崩溃（pid 不在）B 接管后，A 用旧 token 写回被拒（`E_LEASE_LOST`），不会覆盖 B 的值。
8. 总线 root 不可写 → 插件不抛，卡片正常。
9. ack 后同 `dedupKey` 重发不复活（`acked/` 是墓碑）；envelope id 与文件名不一致的消息被隔离。

### 10.3 手工验收

1. 开两个会话 A/B，A 发 `note` 给 B；B 下一轮开机卡出现一行；B 回 `reply`；A 下一轮看到。
2. 关掉 B 进程再发；B 重启后能读到（未过期）。
3. 把 B 的 live 心跳改成 10 分钟前，A 发 → `E_PEER_DEAD`；`allowDead:true` 能存。
4. 看 `acked/` 与 `dead/`，确认没有半截 JSON。

---

## 11. 上线步骤

1. `busEnabled=false` 合并代码；跑现有 33 例，确认零变化。
2. 在测试 profile 开 `busEnabled=true`，`busRoot` 指到 `<work-dir>\identity-router\outbox\bus`。
3. 只开一个会话，手工 `send` 一条 `note` 给自己，验证卡片/ack。
4. 开两个会话，验证互发、重启恢复、死会话拒发。
5. 观察一周：`BUS_POLL_FAILED`、`BUS_ACK_FAILED`、`INBOX_TRUNCATED`、`corrupt/foreignHost` 计数。
6. 再讨论是否迁到 `<memoryRoot>/.longlive/bus`（需要 owner 批准）。
7. 不要在这次只读调研里执行以上任何一步。

---

## 12. 开放问题（接线相关）

1. `buildOpenCard` 的 `inbox` 参数是否算 v0.1 破坏性变更？建议按可选字段加，默认输出不变。
2. `turn/end` 自动 ack 对 `task` 类消息是否太早？是否要 `task` 只在显式回复后 ack？
3. `busPollEveryStep` 要不要做？长回合（工具跑 10 分钟）期间消息延迟是否可接受？
4. 会话 id 非法时，是否允许配置 `busSessionId` 覆盖？还是坚持跳过？
5. handover 消息落 outbox 后，谁负责合并进 `handover/*.md`？人，还是主会话的下一轮？
6. 租约 TTL 30 分钟是否合适？长回合超过 30 分钟时，续租点够不够？
7. 未读节 320 字、3 条是否够？如果不够，是加 `maxChars` 还是改成两行摘要？
8. 同一会话存活期间新消息不自动进上下文（只在首次 pre-step 注入），这个延迟能否接受？要不要做“每 N 回合重开一次卡”或独立 `bus_poll` 工具？
