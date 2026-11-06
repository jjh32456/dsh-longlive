# 跨会话通道 · session-bus v0 设计

> 状态：设计 + 可运行原型，**尚未接入宿主、尚未安装插件**。
> 范围：同一台 Windows 机器、同一个 DSH profile、同一个 Windows 用户。
> 日期：2026-11-04。原型：`prototype/bus.mjs`；测试：`test/bus.test.mjs`（15/15 通过）。

---

## 0. 一句话

给每个会话一个**文件邮箱**：发消息是原子写一个 JSON 文件，收消息是 `poll` 扫描自己的收件箱，处理完 `ack` 把它移进 `acked/`。存活判断只读 longlive 已有的 live 登记表；身份文件仍然只有 identity-router 一个读者、人类一个写者。它不是 RPC，不假装能叫醒一个空闲会话——它是**信箱**，下一次开门时取信。

---

## 1. 目标与非目标

### 目标

1. 同一台机器上的前台会话、后台会话、另一个窗口里的会话可以互发短消息。
2. 三个寻址维度：`sessionId`（精确）、`@别名`（1:1）、`#角色`（1:N）。
3. 至少一次投递；发送端可用 `dedupKey` 做幂等；接收端用 `ack` 确认。
4. 不依赖数据库、不依赖网络、不新增 npm 依赖；只用 Node 标准库。
5. 与 identity-router 的 `STATE.md` / `handover/*.md` 共用同一份身份，但**不篡改**身份文件。
6. 失败可见、可恢复：对方死了、消息堆了、重复消费了，都有明确行为，不静默丢。

### 非目标（v0 明确不做）

- **不跨机器**。不做网络传输、不做中继、不做同步盘。
- **v0 不做自动唤醒**：宿主已有唤醒 API，但 v0 选择邮箱轮询的取舍（见 §8）。
- **不做加密**。同一 Windows 用户信任边界内，文件 ACL 就是权限。
- **不做富媒体**。`body` 是 UTF-8 文本（可以是 JSON 字符串），不放二进制。
- **不做 exactly-once**。文件系统 + 崩溃恢复只能给 at-least-once。
- **不自动改 `handover/*.md`**。只写 outbox 草稿，合并由人/后续流程做。
- **不替代 engram / longlive**。总线只传“消息”，不传记忆库。

---

## 2. 事实基础（设计所依赖的已验证行为）

### 2.1 live 登记表

`@jjh32456/dsh-longlive` 在 `<memoryRoot>/.longlive/live/<sessionId>.json` 每个会话一行，字段：

```
schemaVersion, sessionId, pid, host, startedAt, updatedAt, heartbeatAt,
ttlMs, state, turn, goal, blocked_on, queued, last_action
```

- `ttlMs` 默认 `60000`，允许 `1000..86400000`。
- 声明状态：`idle | running | waiting | blocked | stale`；读取方计算 `dead | corrupt`。
- 有效状态规则（`liveEntry`）：
  - `age <= ttlMs` → fresh（pid 不推翻 fresh）；
  - `age > 4*ttlMs` → dead；
  - 否则同 host 且 `pidAlive(pid) === false` → dead；
  - 否则 `age > 2*ttlMs` → stale；
  - 否则沿用声明状态。
- 写是 tmp + 读回 + rename（EPERM/EACCES/EBUSY 重试），完整外来 JSON 按 last-writer-wins 接受。
- `sessionId` 正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，写盘前 lower-case；拒绝 NUL、绝对路径、`/`、`\`、`.`、`..`。
- 行路径有 realpath jail；符号链接行拒绝读取；路径被目录/链接占用时报 `E_LIVE_ROW_BLOCKED`。
- 本机实测 live 目录：`<memory-root>\.longlive\live\`（不是 `%USERPROFILE%\.dsh\longlive-memory`）。**所有插件必须共享同一个 `memoryRoot` 解析结果**，否则总线看到的存活状态全是 `missing`。

### 2.2 宿主钩子

- `session/event(turn/end)`：回合结束时触发；identity-router 用它写草稿。
- `session/disposed`：会话被优雅销毁时触发；进程被强杀不会触发。
- **没有 `session/end`**。不能假设“会话结束一定有一次回调”。
- `agent/pre-step` 是 waterfall，`step === 1` 时可追加一条用户消息（identity-router 已用此注入开机卡）。这是目前唯一验证过、能按会话注入内容的入口。
- 全局插件拿不到按会话区分的 system prompt（`system-prompt/assemble` 没有 agent/session 维度）。
- `agent/created` 不能改消息，只能记录来源。

### 2.3 identity-router v0 边界

- 读：`<memoryRoot>/STATE.md`、`<memoryRoot>/handover/*.md`。
- 写：**只写 outbox**；outbox 默认是 `<repo>/outbox/`，不是 memoryRoot（`writeback.js` 顶部注释与 `resolveOutboxDir` 都明确这一点）。
- 开机卡 ≤ 800 code points，四节 `▍我在哪 / ▍在等什么 / ▍最近三件 / ▍交接卡`，`buildOpenCard(input)` 是纯函数。
- `collectOpenCard(options)` 负责读盘并调用 `buildOpenCard`。
- 草稿文件名带短会话 id，永不覆盖（`-2`、`-3`……最多 50）。

> **边界结论**：identity-router v0 的“绝不写 memoryRoot”是硬约定。总线如果落在 `<memoryRoot>/.longlive/bus`，就是让插件往 memoryRoot 写东西——这是**新的写权限**，必须由 owner 明确批准，不能顺手加进 v0。见 §13 的两个落盘方案。

---

## 3. 总体结构

```
┌──────────────────────┐        ┌──────────────────────┐
│ session A            │        │ session B            │
│ identity-router      │        │ identity-router      │
│  ├─ pre-step: poll   │        │  ├─ pre-step: poll   │
│  ├─ turn/end: ack    │        │  ├─ turn/end: ack    │
│  └─ disposed: release│        │  └─ disposed: release│
└─────────┬────────────┘        └─────────┬────────────┘
          │ send / poll / ack             │
          ▼                               ▼
   ┌─────────────────────────────────────────────┐
   │ bus root                                    │
   │  inbox/<to>/<id>.json      pending          │
   │  inbox/<to>/acked/<id>.json                 │
   │  inbox/<to>/dead/<id>.<reason>.json         │
   │  aliases.json   roles.json   writer.lock    │
   └─────────────────────────────────────────────┘
          │ 只读
          ▼
   <memoryRoot>/.longlive/live/<sessionId>.json
   （存活判断；bus 从不写 live 行）
```

三个原则：

1. **消息是文件，不是连接**。发送方写完即返回，不要求接收方在线。
2. **存活是提示，不是保证**。live 行只用于拒发/跳过死会话；真正送达以文件存在为准。
3. **身份是共享只读，写者唯一**。总线不碰 `STATE.md` / `handover/*.md`；只读它们做卡片。

---

## 4. 寻址

### 4.1 三种地址

| 形式 | 例子 | 语义 | 解析来源 |
|---|---|---|---|
| `sessionId` | `session-e219dedf-a08a-...` | 精确一个会话 | 调用方传入；规范化为小写 |
| `@alias` | `@reviewer` | 1:1 别名 | `<busRoot>/aliases.json` |
| `#role` | `#team` | 1:N 角色，去重后逐个投递 | `<busRoot>/roles.json` |

`send({to})` 先解析目标，再校验存活，再落盘。别名和角色文件**每次发送时读取**，不缓存，改完立即生效。

### 4.2 规范化规则

接收 `sessionId` 时：

1. `trim()`；空串拒绝。
2. 含 NUL、绝对路径、`/`、`\`、`.`、`..` → `E_PATH_OUTSIDE_ROOT`。
3. 不匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` → `E_BAD_SESSION_ID`。
4. `toLowerCase()`；Windows 大小写不敏感，规范 id 一律小写。
5. 以 `.` 或空格结尾 → 拒绝（Windows 会静默去掉）。
6. 第一段是 `con/prn/aux/nul/com1..9/lpt1..9` → 拒绝（设备名）。
7. 返回值即落盘目录名；**绝不允许调用方传入未规范化的字符串拼路径**。

别名 `@name`：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，查找时大小写不敏感。别名不落盘成目录，只作为键，所以不需要 Windows 设备名规则，但仍限制字符集。

### 4.3 别名文件

```json
{
  "reviewer": "session-bob",
  "foreground": "session-e219dedf-a08a-4eed-9cd2-ef49cec29258"
}
```

- 值必须是单个合法 `sessionId` 字符串；也可以是 `{ "sessionId": "..." }`（原型兼容两种）。
- 重复键（大小写不同）按“找到的第一个”处理，不静默合并；建议写文件的人保证唯一。
- 别名指向的会话死了：`@alias` 是 1:1，按“直投”处理，默认抛 `E_PEER_DEAD`（不静默丢）。
- 别名修改只影响之后的发送；已经落盘的消息里 `to` 仍是旧 id，不会重写。

### 4.4 角色文件

```json
{
  "team": ["session-bob", "session-carol", "session-bob"]
}
```

- 数组，成员是合法 `sessionId`；重复成员去重。
- 角色是“尽力而为”的 fan-out：
  - 死会话 → `skipped: [{to, reason:"dead"}]`；
  - 远程 host → `skipped: [{to, reason:"remote-host"}]`；
  - 某个成员 inbox 满 → `skipped: [{to, reason:"backlog"}]`；
  - 至少一个成功 → `{ok:true, partial:true, results, skipped}`；
  - 全部失败 → `E_NO_LIVE_RECIPIENTS`。
- v0 **不做 `*` 通配广播**。要广播就显式建 `#all`，避免手滑。
- 角色成员上限原型未强制；建议配置层限制 64（开放问题）。

### 4.5 “前台/后台/别的窗口”怎么表示

总线不知道窗口焦点，也不应该猜。做法是人工/配置维护：

```json
{ "foreground": "session-...", "background": "session-..." }
```

或由未来 UI 在会话启动时原子更新 `aliases.json`。**不要**根据 live 的 `state === 'running'` 推断“前台”——`running` 只表示在跑，不表示可见。

---

## 5. 消息格式

### 5.1 信封

```json
{
  "v": 1,
  "id": "m-0abc12345-0001-00a1b2-9f3c1d",
  "from": "session-alice",
  "to": "session-bob",
  "kind": "note",
  "body": "音频导出来了，在 D:\\work\\out\\mix.wav",
  "ts": 1762300000000,
  "ttl": 86400000,
  "host": "jjh",
  "dedupKey": "mix-export-2026-11-04"
}
```

| 字段 | 必填 | 类型/范围 | 说明 |
|---|---|---|---|
| `v` | 是 | `1` | schema 版本；不兼容变更升 2 |
| `id` | 是 | 匹配 `^m-[a-z0-9]+(?:-[a-z0-9]+)*$` | 全局唯一；见 §5.2 |
| `from` | 是 | 合法 `sessionId` | 发送方；必须等于 bus 绑定的 sessionId |
| `to` | 是 | 合法 `sessionId` | 接收方；解析后的规范 id |
| `kind` | 是 | `note\|task\|reply\|handover\|control` | 语义见 §5.3 |
| `body` | 是 | 非空 UTF-8，≤ 8192 code points | 纯文本；可以是 JSON 字符串 |
| `ts` | 是 | epoch ms，> 0 | 发送方时钟；用于排序/过期 |
| `ttl` | 是 | `0 < ttl <= 604800000`（7 天） | 默认 24h；接收方判断 |
| `host` | 是 | 非空字符串 | 发送方 hostname；接收方必须匹配本机 |
| `dedupKey` | 否 | 非空，≤ 128 code points | 幂等键；同键同 body/kind 去重 |

**不放进信封的**：优先级、replyTo、附件、加密标记。v0 需要回复就用 `kind:"reply"` + body 里写原 id；需要结构化内容就把 JSON 放进 `body`。加字段必须升 `v`，不能悄悄塞。

### 5.2 消息 id

两种生成方式：

1. **普通发送**：
   ```
   m-<9 位 base36 毫秒时间戳>-<4 位 base36 进程内序号>-<6 位 base36 pid>-<6 位 hex 随机>
   ```
   长度可控，前 9 位可反解时间（用于 `since` 回退），进程内序号降低同毫秒碰撞。
2. **带 `dedupKey`**：
   ```
   m-<sha256(from + "\0" + to + "\0" + dedupKey)[0..32]>
   ```
   同一发送方、同一接收方、同一键 → 同一 id → 文件已存在 → 返回 `deduped:true`。
   若已有文件但 body/kind 不同 → `E_DEDUP_CONFLICT`（不静默覆盖，避免“重试时内容变了”却以为成功）。

`id` 只用于文件名和 ack，不承载权限。`ack` 前用正则校验，绝不把它拼进 `..`。

### 5.3 kind 语义

| kind | 用途 | 是否进开机卡 | 是否可能进 handover |
|---|---|---|---|
| `note` | 通知、状态、FYI | 是（一行摘要） | 否 |
| `task` | 请对方做一件事 | 是（一行摘要） | 否 |
| `reply` | 对某条消息的回答 | 是 | 否 |
| `handover` | 交接信息，可能较长 | 是（一行摘要） | 是，单独落 outbox |
| `control` | 机器控制（预留：ack/nack/lease） | **否** | 否 |

`control` 默认不展示，防止内部协议文本污染卡片；v0 原型没有真正使用它，只保留枚举。

---

## 6. 投递语义

### 6.1 至少一次（at-least-once）

- `poll()` **不删除**消息，只读并排序返回。
- `ack(id)` 把 `<id>.json` 从 `inbox/<sessionId>/` 移到 `inbox/<sessionId>/acked/<id>.json`。
- 消费者在“处理完”之后才 ack；崩溃在 poll 与 ack 之间 → 下次重新投递。
- 没有 exactly-once，也没有事务。消费者必须按 `id` 幂等（例如卡片里同一条消息出现两次，不能重复执行副作用）。

### 6.2 去重键（发送端幂等）

- 同一 `(from,to,dedupKey)` → 同一 `id` → 同一文件。
- 第二次 send 读到已存在文件：
  - body 与 kind 相同 → `{deduped:true}`，不新增；
  - 不同 → `E_DEDUP_CONFLICT`。
- 没带 `dedupKey` 的 send 每次生成新 id；网络/进程重试会产生重复，接收端只能靠 id 不同而无法自动合并。**要重试就必须带 dedupKey**。

### 6.3 过期丢弃

- 接收方判断：`now > ts + ttl` → 不返回，删除文件，`expired++`。
- 过期是**逻辑时间**，不是文件 mtime；发送方时钟偏快会让消息活更久，偏慢会提前死。同机时钟通常一致；跨时区不影响 epoch ms。
- 没被 poll 的过期文件会留在磁盘，直到下一次 poll 或未来的 janitor；不占投递配额以外的语义。
- `ttl` 上限 7 天，防止“僵尸消息”无限期占坑。

### 6.4 排序与游标

- `poll` 按 `(ts, id)` 升序返回；这不是跨发送方的因果序。同一毫秒内两条消息的顺序由 id 字典序决定，**不保证等于发送顺序**。
- `since` 支持：
  - 数字：epoch ms，返回 `ts > since`；
  - ISO 时间字符串：同上；
  - 消息 id：先查 pending/acked 文件拿 `ts`，再按 `(ts,id)` 严格大于；找不到文件时用 id 前 9 位时间戳回退。
- 数字/ISO 游标会**排除同一毫秒**的消息；要精确续读，用最后一条消息的 id。
- `cursor` 正常返回本次最后一条的 id；没有新消息时原样返回传入的 `since`。
- **超前消息不参与游标**：若本次投递的消息里有 `ts > now`（仍在 `maxClockSkewMs` 容忍窗内），返回的 `cursor` 改为数字 `now`（epoch ms），而不是该消息的 id。id 游标按 `(ts,id)` 比较，会把之后 `ts` 更小的正常消息永久压在下面；夹到 `now` 后下一轮会重放那条超前消息（at-least-once，ack 幂等），但不再挡任何正常消息。见 §7.4 与 WIRING §3.5。

### 6.5 积压上限

- 每个收件箱默认最多 1000 条 pending `.json`；`acked/` 和 `dead/` 不计。
- 达到上限：直投 `E_BACKLOG_FULL`；角色投递跳过该成员并记 `reason:"backlog"`。
- 上限检查是“读数量 + 写文件”的近似；并发发送可能短暂超过 1 条。严格上限需要额外锁，v0 不做，文档明确。
- 没有自动丢弃；消费者必须 drain + ack，或等 TTL。

### 6.6 ack 语义

- 只有收件箱主人能 ack：`ack` 用 bus 绑定的 `sessionId`，不接受调用方传别的 id。
- 重复 ack：目标已在 `acked/` → `{ok:true, already:true}`。
- 不存在：`{ok:false, code:"E_NOT_FOUND"}`（不是异常，方便重试逻辑）。
- ack 之后消息仍在 `acked/`，用于重复 ack 判定与审计；生产环境建议 7 天后 GC（原型未实现）。
- ack 是“我收到了”，不是“我处理成功了”。需要处理确认就再发一条 `kind:"reply"`。

---

## 7. 落盘位置与原子性

### 7.1 目录布局

```
<busRoot>/
  aliases.json                      # 可选；1:1 别名
  roles.json                        # 可选；1:N 角色
  writer.lock                       # 单写者租约（身份/handover 合并用）
  inbox/
    <sessionId>/
      <messageId>.json              # pending，创建后不可变
      acked/<messageId>.json        # 已确认
      dead/<messageId>.<reason>.json# corrupt / foreign，隔离
```

### 7.2 两个候选 busRoot

| 方案 | 路径 | 优点 | 代价 |
|---|---|---|---|
| A. v0 接线默认（推荐先走） | `<work-dir>\identity-router\outbox\bus` 或 `DSH_SESSION_BUS_ROOT` 指定的仓库外目录 | 不违反 identity-router “绝不写 memoryRoot”；零新权限；便于只读试验 | 不在 memoryRoot 备份范围内；换仓库/换机器要显式搬 |
| B. 生产归属 | `<memoryRoot>/.longlive/bus` | 与 live 登记表同根；随记忆目录备份；`.longlive` 本来就是插件状态目录 | 插件开始写 memoryRoot，**需要 owner 明确批准**；identity-router v0 不能自己这么干 |

原型对两者都支持：`createBus({root, memoryRoot})` 只要求 `root` 可写，`memoryRoot` 只用于定位 live 登记表。**WIRING 采用 A**，把 B 列为需要单独批准的升级项。不要因为“都在 .longlive 下”就默认 B 合规——v0 的约定是身份插件不写记忆根。

### 7.3 原子写

发送一条消息：

1. 校验并规范化 `to`；`ensureDirInside(root, inbox/<to>)`。
2. 若目标文件已存在：读它，按 dedup 规则返回或报冲突。
3. 生成信封；在**同一目录**写临时文件 `.tmp-<pid>-<12 hex>`（6 字节随机数的 hex，`open(..., 'wx')`）。
4. `writeFileSync(fd, text)` → 尽力 `fsync(fd)` → `close`。
5. `renameSync(tmp, target)`；Windows 上 EPERM/EACCES/EBUSY 重试 5 次、每次 5ms（Atomics.wait 同步睡眠）。
6. 失败清理临时文件；若 rename 时目标已被别人创建，读回目标：内容一致按 dedup 处理，否则 `E_DEDUP_CONFLICT`。

因此读方永远看不到半截 JSON：要么没有文件，要么是完整信封。

### 7.4 读与隔离

- `poll` 只读 `inbox/<sessionId>/*.json`，不递归。
- 每个文件 `lstat`：必须是普通文件；符号链接跳过（不读、不删）。
- JSON 解析失败、字段不合法、`to` 不匹配、`host` 不匹配 → 分别计入 `corrupt` / `foreignHost`，移到 `dead/`，继续处理其余消息；一条坏消息不能拖垮整个收件箱。
- `aliases.json` / `roles.json` 解析失败 → 发送时 `E_BAD_ADDRESS_BOOK`，fail closed（不猜）。
- 所有路径都以 `realpath(root)` 为基准；`ensureDirInside` 拒绝符号链接目录和 realpath 逃逸。真实路径检查从**最近存在的祖先**开始（路径不存在时逐级向上），所以 `root\escape\missing\deep.json`（`escape` 是指向根外的 junction）也会被拒绝，而不是先建目录再逃逸。任何路径段含 `:`（Windows ADS）或目标本身是符号链接/junction → `E_PATH_OUTSIDE_ROOT`。
- `poll` 对 `ts > now + maxClockSkewMs`（默认 300000）的消息计入 `futureTs`，移入 `dead/<id>.future-ts.json`，不返回、不当作游标；调用方传入超未来的 `since` 时按“重放全部 pending”处理（结果带 `futureCursor:true`），不夹到 `now`——向前夹会静默丢掉已排队的消息。
- 容忍窗内（`ts <= now + 300000`）的超前消息会被正常投递，但**不能当游标**：若直接返回它的 id，之后 `ts` 更小的正常消息会被 `(ts,id)` 游标永久过滤且 `futureCursor` 仍为 false，等于静默丢消息（红队 P24）。因此 poll 只要投递了 `ts > now` 的消息，`cursor` 就夹到 `now`：下一轮重放该超前消息（at-least-once），正常消息照常可见。窗口语义（5 分钟）写在 WIRING §3.5。

### 7.5 为什么不直接用 SQLite

- 单文件、零依赖、可被人眼检查和手工修复；一个会话一个目录，排障简单。
- 消息量小（每会话每天几十到几百条），文件系统足够。
- 原子 rename 在 NTFS 本地盘可靠；SQLite 反而引入 WAL/锁/版本兼容问题。
- 代价：没有事务性多收件箱写入、没有索引、积压扫描 O(n)。v0 接受，n 由 1000 上限约束。

---

## 8. 唤醒方式：轮询 vs 事件

### 8.1 结论先说

**v0 的投递路径只有轮询；但“不能唤醒”不是物理限制。** 宿主有唤醒 API：`ctx.agents.get(id)?.followup(msg)` 能让一个 **live、空闲** 的会话开始新一轮（`asar/agent.js:597`、`asar/agent-loop.js:806-807`、`README.md:47`）；**cold** 会话（进程已退出/未启动）由 api-session-controller 的 resume 路径恢复（`api-session-controller:228,794,950`），恢复后照常从 inbox 读取。v0 选择邮箱轮询是取舍：不依赖未稳定导出的内部 API、不必处理会话忙/重启窗口，代价是延迟上界 = 对方下一次 `agent/pre-step`。两条路的接线见 WIRING §5.4。

### 8.2 具体挂点

| 时机 | 做什么 | 为什么 |
|---|---|---|
| `agent/pre-step`，`step === 1` | `poll` 未读；把摘要并进开机卡；记录待 ack id | 与 identity-router 现有注入点重合，已验证 |
| `session/event` `turn/end` 且 `data.reason.kind === 'completed'` | ack 本轮卡片里展示过的消息；可选合并 handover | 宿主的 `turn/end` 也在 `finally` 里发，error/aborted 回合不能 ack（否则消息永久消失） |
| `session/disposed` | 释放 writer 租约；不强制 ack | 优雅退出；强杀时不会触发 |
| 任意后续 step（可选） | 若配置 `pollEveryStep`，按节流（≥1s）poll 新消息 | 长回合内也能收信；v0 默认关闭，避免每步 IO |

### 8.3 事件驱动能做到什么、不能做到什么

- **进程内**：`fs.watch(inbox, ...)` 可以在一个已经在等待的进程里降低延迟；但 watch 会漏事件、会重命名抖动、跨进程不保证。它只能当“提示”，收到提示后仍要 `poll` 对账。原型不实现。
- **跨进程/跨窗口**：宿主有两条已验证的路——live 空闲会话用 `ctx.agents.get(id)?.followup(msg)`，cold 会话用 api-session-controller resume（见 §8.1 的源码位置）。v0 不接它们，只投邮箱；不要用 `session_live_update` 假装唤醒——那只是写登记表，不会调度。
- **live / cold 在 v0 的行为**：live 会话等下一次 `agent/pre-step` 自己取；cold 会话等下一次启动/resume 后读 inbox。两者都不需要总线侧定时器。
- **UI 提示**：未来可以做未读角标，但那是客户端插件的事，不是投递语义。
- **后台会话**：即使它是 `running`，消息也要等它下一次 `pre-step`；如果它卡在长工具调用里，延迟就是那个工具的时长。

### 8.4 延迟与成本

- 每次 `poll` 扫一个目录，最多 1000 个 pending；空收件箱是一次 `existsSync`，成本可忽略。
- 只在 `step === 1` poll，长会话不会每步扫盘。
- 不建议 100ms 级定时轮询：v0 不调用宿主唤醒 API，轮询再密也不会让空闲会话开始一轮，只是耗电。

---

## 9. 安全

### 9.1 信任边界

v0 的边界是：**同一台机器 + 同一个 Windows 用户 + 同一个 DSH profile**。

- 没有认证、没有 HMAC、没有每会话 token。同一用户下的任何进程都能读写 busRoot。
- `from` 由 bus 绑定到创建时的 `sessionId`，正常 API 不能冒充别人；但能直接写文件的本机进程可以伪造。**这不是 v0 能防的**，要防需要 ACL + 签名 + 密钥管理，属于 v2。
- 不要把密钥、token、密码放进 `body`；磁盘上是明文，`acked/` 还会留一段时间。
- 跨用户：busRoot 应放在用户 profile/仓库下，靠 NTFS ACL 隔离；原型不主动改 ACL，部署时用 `icacls` 收紧（见 WIRING）。

### 9.2 同 profile

- `busRoot` 和 `memoryRoot` 都来自同一个 profile 配置；别名/角色只在该 root 内有效。
- 不同 profile 默认不共享 root。若两个 profile 显式指向同一个 root，它们可以互通——这是配置选择，不是默认行为。
- 不要用 `C:\ProgramData` 之类全局可写目录做 root。

### 9.3 路径 jail

原型逐层拒绝：

1. root 必须是本地路径，UNC（`\\server\share`）直接 `E_UNC_NOT_ALLOWED`。
2. root 用 `realpath` 解析；后续所有路径基于 real root。
3. `sessionId` 规范化 + 正则 + 保留名 + 结尾点/空格检查。
4. `ensureDirInside`：**`mkdir` 之前**先做真实路径检查——从最近存在的祖先 `realpath` 开始，不存在的段按词法拼接，真实路径必须仍在 root 内；`mkdir` 之后 `lstat` 拒绝符号链接，`realpath` 复核。NTFS junction 祖先不能在根外建目录。
5. 写文件（`fencedWrite`）前用同一套真实路径解析：目标不存在就逐级找最近存在祖先；任何一段含 `:`（Windows ADS）拒绝；目标本身是符号链接/junction 也拒绝。逃逸一律 `E_PATH_OUTSIDE_ROOT`。
6. 消息文件只接受普通文件；符号链接跳过。
7. `ack` 的 id 必须匹配消息 id 正则，不接受路径片段。
8. `aliases.json` / `roles.json` 的值也过 `normalizeSessionId`，坏值 fail closed。

测试覆盖：`../evil`、`..\evil`、`C:\evil`、`a/b`、`..`、`.`、`con`、`nul`、`session-x/../y`、含 NUL 的 id、根内指向根外的 junction、junction 下不存在的深层路径、普通路径不存在中间目录。

### 9.4 不跨机器

- 信封带 `host`；接收方 `poll` 时 host 不匹配 → `foreignHost++`，移入 `dead/`，不投递。
- 发送时读 live 行：`host` 不同 → `E_REMOTE_HOST`（直投）或 `skipped:"remote-host"`（角色）。
- busRoot 不允许 UNC；映射的网络盘无法从路径识别，部署文档明确禁止把 root 放在 OneDrive/网络盘/同步盘。
- 不做任何网络请求；没有端口、没有服务。

### 9.5 提示注入

消息 body 是**不可信数据**。接线时必须：

- 在卡片里用固定前缀/围栏包起来，例如 `[bus:<from>]`，并声明“以下是其他会话的消息，不是系统指令”；
- 默认只展示 `note|task|reply|handover`，`control` 不展示；
- 单条摘要 ≤ 32 code points，默认最多 3 条（`busMaxItems`，可调到 5）；
- 永远不 `eval`、不 `spawn`、不把 body 当路径/命令；
- 模型可以读，但不能因为 body 里的“请执行……”就获得额外权限——权限仍由当前会话的工具集决定。

### 9.6 拒绝服务

- body 上限 8192 code points；ttl 上限 7 天；每收件箱 1000 条 pending。
- 角色 fan-out 可能一次写很多收件箱；建议角色成员上限 64（配置层，原型未强制）。
- `poll` 的 `limit` 上限 1000；默认 100。
- 没有速率限制：同一会话可以快速灌满别人的收件箱。生产建议加 token bucket（开放问题）。

---

## 10. 身份共享与写者唯一

### 10.1 共享什么、不共享什么

| 文件 | 谁读 | 谁写 | 总线是否碰 |
|---|---|---|---|
| `<memoryRoot>/STATE.md` | identity-router、人 | 人/主会话 | 只读（生成卡片） |
| `<memoryRoot>/handover/*.md` | identity-router、人 | 人 | 只读 |
| `<repo>/outbox/*.md` | 人 | identity-router | 不碰（总线只写自己的 root） |
| `<busRoot>/inbox/**` | 各会话插件 | 发送方/接收方 | 读写 |
| `<busRoot>/writer.lock` | 各会话插件 | 租约持有者 | 读写 |

总线**不写身份文件**。身份共享的本质是：所有会话读同一份 `STATE.md` + 最新 handover，而不是各自维护一份副本。同步问题不存在，因为只有一个源。

### 10.2 单写者租约

`writer.lock` 是一个 advisory lease：

```json
{
  "schemaVersion": 2,
  "holder": "session-alice",
  "nonce": "9f2c1d7a4b8e0f63a5c9d1e2b7f4086a",
  "token": 7,
  "pid": 12345,
  "host": "jjh",
  "acquiredAt": "2026-11-04T03:20:00.000Z",
  "expiresAt": "2026-11-04T03:50:00.000Z",
  "ttlMs": 1800000
}
```

- 获取：`open(lock, 'wx')` 原子创建；已存在则读：
  - `expiresAt` 已过 → 可抢占；
  - 同 host 且 pid 不存活 → 可抢占；
  - 否则返回 `{ok:false, holder, expiresAt, reason:"held"}`。
  - **同 holder 再 claim = 续租**：token/nonce 不变，只刷新 `expiresAt`/`ttlMs`，不产生新 acquisition；但**必须带本次 acquisition 的 nonce**——缺 → `E_NONCE_REQUIRED`，错 → `E_LEASE_AUTH`。知道 session id 不等于拥有租约（P08）。
- 鉴权：每次 acquisition 生成随机 `nonce`（32 hex），只在该次 `claimWriter` 返回值里给出；释放/续租/写回都要带它，知道 session id 不够。
- 释放：holder + nonce 都对才能删；不是 holder 返回 `not-holder`，nonce 不对返回 `bad-nonce`，不误删。
- 续租：`renewWriter({nonce, token, ttlMs})`，或同 holder 再 `claimWriter`；默认 TTL **1800000 ms（30 分钟）**。
- 写回（fencing）：`fencedWrite({file, token, nonce, value})` 必须带当前 `token`；锁被新持有者接管后，旧持有者的写回抛 `E_LEASE_LOST`，不会覆盖新值。
- **串行化（P13）**：所有写路径（`claimWriter` / `renewWriter` / `releaseWriter` / `fencedWrite`）都在 `<root>/writer.commit.lock` 这一把跨进程互斥锁内执行。锁用 `open(..., 'wx')` 创建，内容 `{pid, host, at, ownerId}`（`ownerId` 每次获取随机生成）；抢不到以 4ms 自旋重试（上限 15s）；同 host 且 pid 已死，或 mtime 超过 30s → stale，可回收。同一进程对同一 root 重入直接放行，避免测试 hook 里同步 `claimWriter` 死锁。
- **锁只能由持有者释放（P09）**：`finally` 先读回 `writer.commit.lock`，仅当 `ownerId` 与本次获取的一致才 unlink；锁被 stale 回收或接管后旧持有者看到的是别人的 `ownerId`，保留新锁不动。不做这一步时，被抢占的旧持有者退出会删掉新持有者的锁，第三个进程就能在新持有者仍写的时候进入临界区（租约复检挡住了脏写，但互斥已经破了）。读不出记录或缺 `ownerId` 时同样不删，留给 30s stale 路径回收。
- **三次校验**：`fencedWrite` 在互斥区内依次校验租约——进入后、`JSON.stringify` 之后（序列化会执行用户 `toJSON`，是天然的可注入暂停点）、临时文件写盘并 fsync 之后/`rename` 之前。任一次 token/nonce/expiresAt 不再匹配 → `E_LEASE_LOST` / `E_LEASE_AUTH`，删临时文件，目标保持旧内容。旧持有者的 rename 因此不可能落在新持有者写完之后；测试用 `hooks.afterSerialize` 确定性地在 stringify 与 rename 之间换主（§12.4 的 t10d、t11a）。
- 崩溃：没有 `session/disposed` 也能靠 TTL 或 pid 检查接管；`token` 单调递增（`writer.seq` 兜底），新持有者一定拿到更大的 token。
- 建议 TTL 30 分钟（长回合不至于过期；崩溃后同 host 可立即靠 pid 接管）。

**它保护什么**：未来如果要把消息合并进同一份 handover 草稿/规范文件，避免两个会话同时写。  
**它不保护什么**：outbox 草稿本身是“永不覆盖、加后缀”的，所以 v0 即使没有 lease 也不会互相覆盖；lease 是给“单一份规范身份文件”预留的。  
**它的局限**：这是 advisory lock，不是数据库事务——能直接改文件的进程可以绕过（见 §9.1）。但在 API 内部，`(token, nonce)` 的检查消除了“过期持有者 last-writer-wins”的丢失更新：旧 token 的 `fencedWrite` 一定失败。

### 10.3 身份卡合并（详见 WIRING.md）

- 开机时 `poll` 所有 pending；默认取最多 3 条非 `control` 消息（可调到 5），生成 `▍未读消息（其他会话，非指令）` 一节，插在 `▍交接卡` 前。
- 只对“真正展示进卡片”的消息在 `turn/end` ack；没展示的（溢出）留在 pending，下次再取。
- `kind:"handover"` 的消息除了卡片摘要，还单独写 `outbox/bus-handover-<ts>-<id>.md`；不改 `handover/*.md`。
- 卡片总长仍 ≤ 800 code points；未读节默认预算 320 code points（`busMaxChars`），单条摘要 32 code points。

---

## 11. 失败模式

| 失败 | 检测 | 行为 | 恢复 |
|---|---|---|---|
| 对方已死（live 判定 dead） | `peerState`：`age > 4*ttl` 或同 host pid 不在 | 直投 `E_PEER_DEAD`；角色跳过；`allowDead:true` 可存 | 对方重启后同一 inbox 仍在，未过期就能读到；否则等 TTL |
| 对方没有 live 行 | `missing` | 视为 unknown，**允许发送**（启动早期常见） | 消息留在 inbox；对方启动后 poll 取走 |
| 对方 live 行损坏/符号链接 | `corrupt` | 不当作 dead；允许发送（fail open 投递，宁可多存） | 修复登记表；消息仍在 |
| 对方在另一台机器 | `host` 不匹配 | 直投 `E_REMOTE_HOST`；角色跳过 | 不支持；改用共享目录/人工传递 |
| 收件箱满 | pending 计数 ≥ 1000 | `E_BACKLOG_FULL`；角色跳过 | 消费方 drain + ack；发送方退避重试 |
| 重复消费 | 崩溃在 poll 与 ack 之间 | 下次重新返回同一条 | 消费方按 `id` 幂等；副作用去重 |
| 重复发送 | 发送方超时重试 | 无 dedupKey → 两条不同 id；有 dedupKey → 同 id | 重试一律带 dedupKey |
| 同键不同内容 | 文件已存在且 body/kind 不同 | `E_DEDUP_CONFLICT`，不覆盖 | 换新键；或人工检查旧消息 |
| 消息损坏/字段不合法 | JSON parse 失败/校验失败 | 移入 `dead/`，`corrupt++`，继续 | 修文件后手工移回；或忽略 |
| 外来 host 消息 | `host` 不匹配 | 移入 `dead/`，`foreignHost++` | 正常隔离，不需处理 |
| 半截写 | 读方看不到临时文件；rename 原子 | 不会发生半截 JSON | 崩溃留下的 `.tmp-*` 可安全清理（原型不自动清） |
| 磁盘满/权限错 | `E_WRITE` / `E_BAD_ROOT` | send 抛错；插件降级为“不投递” | 清盘/修 ACL；消息未写，重试 |
| 时钟跳变 | 过期判断异常 | 跳快→提前过期；跳慢→延后 | 同机 NTP；不超过 7 天 TTL；关键消息用 id 游标 |
| 发送时钟超前 | `ts > Date.now() + maxClockSkewMs`（默认 300000ms） | `E_BAD_CLOCK`，不建目录、不写文件 | 校时；区分注入的测试时钟与系统时钟 |
| 消息 ts 在未来（收侧） | `ts > now + maxClockSkewMs` | `futureTs++`，移入 `dead/<id>.future-ts.json`，不返回、不当游标 | 正常消息照常可见；坏消息可人工检查 |
| 写路径竞争/租约换主 | 提交锁 + 三次 lease 校验 | 旧持有者 `E_LEASE_LOST`（或 `E_LEASE_AUTH`），目标保持旧内容 | 重新 `claimWriter` 后重写；不会 last-writer-wins |
| 会话被强杀 | 无 `disposed` | lease 等 TTL/pid 接管；未 ack 消息重投 | 重启后 poll 恢复 |
| 插件 poll 抛错 | 异常 | 接线层 catch，卡片照常生成（没有未读节） | 记录 warning；下轮再试 |
| 消息洪水 | 积压上限 | 后来的发送被拒 | 限流（未实现）；人工清理/扩容 |

---

## 12. 原型 API 与测试

### 12.1 工厂

```js
import { createBus } from './prototype/bus.mjs';

const bus = createBus({
  root: '<work-dir>/session-bus/queue', // 必填，本地可写目录
  sessionId: 'session-alice',             // 绑定后 send 的 from / ack 的收件人
  host: 'jjh',                            // 默认 os.hostname()
  memoryRoot: '<memory-root>',           // 用于定位 .longlive/live
  now: () => Date.now(),                  // 测试注入
  maxBodyChars: 8192,
  maxPending: 1000,
  maxClockSkewMs: 300000,                 // 发送侧未来时钟容忍；收侧用同一阈值
  referenceNow: () => Date.now(),          // 只给发送侧墙钟哨兵用（测试可钉死）
  hooks: {},                               // 测试 seam，如 afterSerialize
});
```

### 12.2 方法

| 方法 | 输入 | 成功返回 | 主要错误 |
|---|---|---|---|
| `send({to, body, kind?, ttl?, dedupKey?, allowDead?})` | 见 §5 | `{ok, id, from, results[], skipped[], partial?}` | `E_PEER_DEAD`, `E_REMOTE_HOST`, `E_BACKLOG_FULL`, `E_BODY_TOO_LARGE`, `E_BAD_*`, `E_DEDUP_CONFLICT` |
| `poll({sessionId?, since?, limit?})` | `sessionId` 默认绑定值 | `{ok, sessionId, messages[], cursor, scanned, expired, corrupt, foreignHost, futureTs, futureCursor, hasMore}` | `E_BAD_SINCE`, `E_PATH_OUTSIDE_ROOT` |
| `ack(id)` | 消息 id | `{ok, already}` 或 `{ok:false, code:"E_NOT_FOUND"}` | `E_BAD_MESSAGE_ID`, `E_ACK_FAILED` |
| `peerState(id)` | 会话 id | `{state, remote?, live}` | `E_BAD_SESSION_ID` |
| `claimWriter({holder?, ttlMs?, nonce?})` | 默认绑定 sessionId；同 holder 续租必须带 nonce | `{ok, holder, token, nonce, expiresAt, created, renewed?}` 或 `{ok:false, holder, reason, code?}` | `E_LEASE_WRITE`, `E_NONCE_REQUIRED`, `E_LEASE_AUTH` |
| `renewWriter({nonce, token?, holder?, ttlMs?})` | 必须带 acquisition nonce | `{ok, renewed, holder, token, nonce, expiresAt}` 或 `{ok:false, reason}` | `E_LEASE_WRITE` |
| `releaseWriter({holder?, nonce, token?})` | holder + nonce 都对才删 | `{ok, released, holder?}` | `E_LEASE_WRITE` |
| `fencedWrite({file, token, nonce, value, holder?})` | 相对 root 或 root 内绝对路径；不能是 root 本身或已存在目录 | `{ok, file, holder, token}`；锁内三次校验 | `E_LEASE_LOST`, `E_LEASE_AUTH`, `E_PATH_OUTSIDE_ROOT`, `E_BAD_PATH`, `E_BAD_VALUE`, `E_WRITE` |
| `writerStatus()` | — | `{ok, held, holder?, expiresAt?}` | — |

`send` 的 `results[]` 每项：`{to, id, deduped, peerState?, path}`；角色 fan-out 时部分成功 `partial:true`。

### 12.3 错误码分组

- 参数：`E_BAD_SESSION_ID`, `E_BAD_TARGET`, `E_BAD_ALIAS`, `E_BAD_ADDRESS_BOOK`, `E_BAD_BODY`, `E_BODY_TOO_LARGE`, `E_BAD_KIND`, `E_BAD_TTL`, `E_BAD_DEDUP_KEY`, `E_BAD_SINCE`, `E_BAD_MESSAGE_ID`, `E_BAD_CLOCK`, `E_BAD_PATH`, `E_BAD_VALUE`
- 路径/安全：`E_PATH_OUTSIDE_ROOT`, `E_UNC_NOT_ALLOWED`, `E_BAD_ROOT`
- 投递：`E_PEER_DEAD`, `E_REMOTE_HOST`, `E_BACKLOG_FULL`, `E_NO_LIVE_RECIPIENTS`, `E_UNKNOWN_TARGET`
- 幂等：`E_DEDUP_CONFLICT`
- 租约：`E_LEASE_WRITE`（拿不到提交锁/写锁失败）, `E_LEASE_LOST`（过期或被接管）, `E_LEASE_AUTH`（nonce 错）, `E_NONCE_REQUIRED`（同 holder 续租缺 nonce）
- 存储：`E_WRITE`, `E_ACK_FAILED`, `E_CORRUPT_TARGET`
- 状态：`E_NO_SESSION`, `E_FROM_MISMATCH`, `E_NOT_FOUND`

### 12.4 测试（50 例，全部通过）

```powershell
& '%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' `
  --test '<work-dir>\session-bus\test\bus.test.mjs'
```

`test/` 目录形式同样可用：`node --test test/`（Node 24 的位置参数按文件/glob 解析，目录由 `test/package.json` 的 `main` 指向 `bus.test.mjs`；不带 shim 时 Node 会把目录当模块解析而报 `MODULE_NOT_FOUND`）。直接 `node test/bus.test.mjs` 也可，输出自定义 runner 的 `ok N -` 行。

| # | 用例 | 覆盖点 |
|---|---|---|
| 1 | send/poll/ack round trip | 基本回路、字段 |
| 2 | poll is at-least-once | 未 ack 前重复投递 |
| 3 | duplicate ack is idempotent | 重复 ack、未知 id |
| 4 | dedupKey send idempotency and conflict | 幂等发送、同键冲突 |
| 5 | TTL expiry discards | 注入时钟、过期删除 |
| 6 | dead session refusal and allowDead / role skip | live 判定、死信、角色跳过 |
| 7 | path escape and bad session ids | 越权路径、保留名、NUL |
| 8 | backlog cap | 积压上限、ack 后恢复 |
| 9 | restart recovery with a new handle | 进程重启/新句柄读同一目录 |
| 10 | concurrent delivery from three processes | 3 进程 × 15 条，45 条不丢不重 |
| 11 | alias and role addressing | 别名、角色去重 |
| 12 | cross-host isolation | 远程 live 行、外来 host 消息隔离 |
| 13 | corrupt message isolation | 坏 JSON 不拖垮收件箱 |
| 14 | input validation limits | body/kind/ttl/dedupKey/空目标 |
| 15 | writer lease uniqueness and stale takeover | 租约互斥、释放、过期接管 |
| 16 | `t10a` fencedWrite token rejection | 缺 token / 旧 token → `E_LEASE_LOST`，不落盘；变异 M13 必红 |
| 17 | `t10b` fencedWrite nonce rejection | 错 nonce / 缺 nonce → `E_LEASE_AUTH`，不落盘；变异 M14 必红 |
| 18 | `t10c` same-holder re-claim without nonce | `E_NONCE_REQUIRED`，锁文件字节不变；P08 |
| 19 | `t10d` TOCTOU takeover after stringify | hook 内换主 → `E_LEASE_LOST`，旧文件不变；P13 |
| 20 | `t10e` commit lock visible and stale reclaim | 锁文件含 pid/host，结束后删除；死 pid 可回收 |
| 21 | `t10f` junction escape | 根内 junction 指向根外 → `E_PATH_OUTSIDE_ROOT`；P12 |
| 22 | `t10g` nearest existing ancestor / file symlink | 深层不存在路径仍拒绝逃逸；合法缺失目录是 `E_WRITE` |
| 23 | `t10h` sender future clock | 超 skew → `E_BAD_CLOCK` 且无文件；小偏移可用；P14 |
| 24 | `t10i` receiver future-ts quarantine and cursor | `futureTs/futureCursor`，坏消息进 dead，正常消息不丢 |
| 25 | `t11a` cross-process commit lock | 第二进程阻塞 ≥800ms 后 `held`，子进程退出后接管成功 |
| 26 | `t12a` WIRING pendingAckIds merge / sessionKeyFor | R2、R3 的文档口径与 `mergePendingAckIds` 行为 |
| 27 | `t12b` DESIGN invariants | commit lock、E_NONCE_REQUIRED、maxClockSkewMs、future-ts、realpath jail |
| 28 | `t13a` commit lock release checks the owner | 外来 `ownerId` 记录不被旧持有者删除；ownerId 每次获取都不同；F1/P09 |
| 29 | `t13b` three-process stale reclaim keeps the new lock | B 的锁被接管后 B 退出不删 C 的锁（D 进程在 C 临界区内观察）；F1/P09 |
| 30 | `t13c` fencedWrite rejects the bus root itself | `file:"."` / 绝对 root → `E_BAD_PATH`，root 外不出现 `.tmp-*`；F2/P17 |
| 31 | `t13d` fencedWrite rejects a directory target | 目录目标 → `E_BAD_PATH`，普通文件写入不受影响；F2 |
| 32 | `t13e` poll clamps the cursor for ahead-of-clock messages | 超前 299s 的消息不再挡住后续正常消息，改为 at-least-once 重放；F3/P24 |
| 33 | `t13f` poll keeps id cursors for on-time traffic | 未超前时不夹游标；正好 300000ms 边界仍投递并夹到 `now`；F3 |
| 34 | `t13g` DESIGN/WIRING document owner and skew-window semantics | `ownerId`、5 分钟窗口、at-least-once 重放、`E_BAD_PATH` |

红队第三轮 F1/F2/F3 的回归见第 28–33 例；对应变异（去掉 owner 校验、去掉 root/目录守卫、去掉游标夹取）必须把它们打红，见 `FIX-REPORT-V4.md`。

红队第二轮变异 M13（删 token 校验）与 M14（删 nonce 校验）现在分别被第 16、17 例捕获（改前两例均 29/29 绿）。

测试临时目录在 `<work-dir>\session-bus\.tmp-test\`，每个用例结束后递归删除。并发用例用 `process.execPath` 起 3 个 Node 子进程，不依赖 PATH。

---

## 13. 部署与配置

### 13.1 配置项（建议）

| 配置 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `busEnabled` | `DSH_SESSION_BUS_ENABLED` | `false` | 关闭时完全不触碰总线 |
| `busRoot` | `DSH_SESSION_BUS_ROOT` | 空 → 外部 outbox/bus | 本地绝对路径；拒绝 UNC |
| `memoryRoot` | `DSH_IDENTITY_MEMORY_ROOT` | identity-router 的默认 | 必须与 longlive 实际使用的 root 一致 |
| `busMaxItems` | `DSH_SESSION_BUS_MAX_ITEMS` | `3` | 开机卡最多展示几条（可调到 5） |
| `busMaxChars` | `DSH_SESSION_BUS_MAX_CHARS` | `320` | 未读节预算 |
| `busAckOn` | — | `turn-end` | `turn-end | never` |
| `busWriterTtlMs` | — | `1800000`（ms） | 30 分钟租约；单位毫秒 |
| `busPollEveryStep` | — | `false` | 长回合内额外 poll（节流 ≥1s） |

### 13.2 权限

- busRoot 只给当前 Windows 用户读写；部署时建议：
  ```powershell
  icacls "<work-dir>\session-bus\queue" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"
  ```
  （这是部署建议，本次调研没有执行，也没有改任何 ACL。）
- 不要把 busRoot 放进 OneDrive、Dropbox、Git 工作区自动同步目录或网络盘；rename 语义和共享冲突会破坏原子性。
- 定期清 `dead/`、`acked/`、孤儿 `.tmp-*`（建议 7 天）；原型不做 janitor，避免后台定时器。

### 13.3 上线顺序

1. `busEnabled=false`，先只读 review 设计/原型。
2. 用外部 root 在测试会话开 `busEnabled=true`，`busAckOn=turn-end`。
3. 观察 `poll` 的 `corrupt/foreignHost/expired` 计数与卡片长度。
4. 通过后再讨论是否把 root 迁到 `<memoryRoot>/.longlive/bus`（需要 owner 批准新的 memoryRoot 写权限）。
5. 不要在这次只读调研里安装插件、改 profile、改宿主。

---

## 14. 开放问题

1. **busRoot 归属**：v0 走外部 outbox/bus，还是直接批准 `<memoryRoot>/.longlive/bus`？后者结构上更合理（与 live 同根、随记忆备份），但违反 identity-router v0 “不写 memoryRoot”的约定，需要 owner 明确点头。
2. **唤醒**：宿主已有 `followup`（live 空闲会话）与 api-session-controller resume（cold 会话）两条路，v0 仍选邮箱轮询。要不要在 v1 对 live 会话加“投递后 followup 提醒”？需要先解决：会话忙时是否排队、重启窗口内 id 失效、以及 `followup` 的稳定导出。
3. **ack 时机**：`turn/end` 自动 ack 是“回合结束”而不是“消息处理成功”。任务类消息是否要改成显式 ack 工具？显式更准，但多一步模型操作。
4. **认证**：同用户信任是否足够？如果要防同用户恶意进程伪造 `from`，需要 per-session 密钥/HMAC，以及密钥不进日志的完整方案。
5. **排序**：同毫秒消息按 id 字典序，不等于发送顺序。是否需要 v2 加 `seq`（每发送方单调递增）？
6. **保留/GC**：`acked/` 保留多久？`dead/` 保留多久？谁跑 janitor（插件定时器 vs 会话启动时）？
7. **限流**：角色 fan-out 上限多少？是否需要每发送方 token bucket，防止一个会话灌爆所有人？
8. **广播**：要不要受控的 `#all`？还是永远只允许显式角色？
9. **跨 profile**：两个 profile 指向同一 busRoot 是否允许？默认应该禁止，但配置上如何表达？
10. **UI**：未读角标/发消息面板是否要做？这属于客户端插件，和投递层解耦。
11. **schema 演进**：`replyTo`、`priority`、`contentType` 是否值得进 v2？还是继续用 body 里的 JSON？
12. **lease 竞态**：advisory lease 在“同时判定过期”时可能双写；是否接受，还是改用目录 rename/文件句柄锁？

---

## 15. 结论

- 这个设计能解决“同一台机器不同会话互发消息、共享身份”的核心问题，且不引入服务、端口、依赖。
- 它诚实地区分两个边界：**v0 不自动唤醒**（宿主有 API，但是取舍，见 §8），**不能跨机器**。
- 它把“身份共享”收敛为“同一份只读文件 + 单写者租约”，而不是每个会话复制一份身份。
- 原型 15 个用例覆盖了并发、重复、过期、死会话、越权、积压、重启、幂等；剩下的是接线与产品决策，不是协议本身。
