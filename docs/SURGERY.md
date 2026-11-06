# 无人值守手术（unattended surgery）

> 面向维护者。用户视角的「怎么办」在 `docs/OPERATIONS.md` §10。

## 1. 组成

| 文件 | 作用 |
|---|---|
| `scripts/unattended-surgery.ps1` | 真正的执行器：延迟 → 关宿主 → 快照 → 备份 → 调 CLI 剪 → 独立读回 → 重启 → 写回执 |
| `scripts/install-surgery-task.ps1` | 注册一次性计划任务（`-WindowStyle Hidden`）并启动 |
| `scripts/surgery-run.cmd` | 双击/命令行入口，转发参数给 installer |
| `scripts/surgery-inspect.mjs` | 只读检查会话（bytes/sha256/events/messages）；`--write-receipt` 是唯一的写入模式 |
| `src/surgery-recovery.js` | 插件启动时的只读恢复自检、回执文本、CLI 查询实现 |

设计前提：**执行器随时可能被杀**（用户点 ×、断电、任务被结束）。因此所有进度先落
`<memoryRoot>/.longlive/surgery-state.json`，再执行下一步；下一次启动只读它，不自动重剪。

## 2. 阶段与原子性

```
prepare ──► backup ──► cut ──► restart ──► done
   │           │         │        │
   │           │         │        └──► receipt-pending（回执没写成，宿主已起来）
   │           │         └───────────► needs-attention（CLI exit 0，但独立读回核不通过）
   └───────────┴─────────────────────► failed
```

`needs-attention` 是 rc.6 新增的**非终态失败**：执行器退出码 7，`result.ok=false`，state 里
`cut.outcome="unverified"`、`needsAttention.code="E_CUT_UNVERIFIED"`；会话不回滚，也**不写回执**，
留给下一次启动的恢复自检去报告——绝不在这里假装成功。

每次转换都：写 `state.tmp-<pid>` → `Move-Item -Force` 覆盖 → 读回并校验 `phase`。
`history[]` 每次追加 `{phase, at}`，所以被 kill 时能看出最后走到了哪一步。

关键顺序（1.1.0 定死；不要再把两个默认值写反）：

1. `prepare`：记录 sessionPath、参数、pid、pluginVersion，以及 `startDelaySeconds: 30`
   和 `restartDelaySeconds: 0`。
2. **等 `StartDelaySeconds`（默认 30 秒）**：这是刻意留的阅读窗口，让人看完最后一屏再关
   宿主；它不是为了等宿主空闲。改这个值要说明理由。
3. 硬关宿主（`Stop-Process -Force`），等进程清零 + 800ms。
4. **关宿主之后**才快照 `before`、复制备份：不会备份到写了一半的文件。
5. `backup`：`<session>.pre-surgery-<stamp>`，复制后 `Get-FileHash` 与 `before.sha256` 比对。
6. `cut`：**先写 phase=cut，再调 CLI**。这样 CLI 中途被杀时，恢复能看到 `cut`。
7. CLI 成功后用 `surgery-inspect.mjs` 独立读回，sha/events/messages 必须与 CLI 的 `after` 一致。
   **rc.6（R4-03）**：CLI exit=0 但 stdout 一行 JSON 都解析不出来（GBK 控制台把 UTF-8 解坏）时，
   不判 `failed`；先做独立核验（会话可读、sha 与磁盘一致、sha 已变、事件/消息下降、备份在且
   等于 `before`）。核验通过 → `cut.outcome="applied-unparsed"`、`verify.method=
   "independent-readback-unparsed"`，继续写回执并 `phase=done`；核验不通过 → `needs-attention`
   （exit 7，见上）。CLI 非 0 退出、或解析成功但 `ok:false`，仍按 `failed` 处理。原始 stdout
   会以 UTF-8 落盘到 `.longlive/logs/node-cut-<surgeryId>-<rand>.utf8.txt` 供事后核对。
8. **写回执**：读回通过后立刻 `surgery-inspect.mjs --write-receipt`，把结果、数字和备份路径
   作为一条可见 `user/message` 追加进会话正文，并把 `receipt.after` 记进 state（见 §7）。
   `applied-unparsed` 路径同样写，回执正文会多一行说明「CLI 输出编码异常，独立读回核验通过」。
9. `restart`：`Start-Process <AppPath>`，最多等 60 秒，记录 pid 列表。默认
   `RestartDelaySeconds = 0`——校验和回执落盘后立刻重启，不 sleep。
10. `done`：`outcome = applied-and-verified | applied-unparsed | noop | dry-run`，`resultPath`
    指向结果 JSON。

失败路径一律先尝试把宿主拉起来，再写 `failed` 和结果 JSON；退出码：

| 码 | 含义 |
|---|---|
| 0 | done（含 dry-run / noop） |
| 2 | 参数错误；或会话不可读 |
| 3 | 宿主没停下来 |
| 4 | 备份失败 / CLI 失败（未剪切或剪切失败） |
| 5 | 读回校验失败（磁盘与 CLI 的 after 不一致） |
| 6 | 重启后 60 秒内没看到宿主进程 |
| 7 | CLI exit 0 但输出不可解析，且独立核验不通过 → `needs-attention` |
| 1 | 未预期异常 |

## 3. state 形状（version 1）

```json
{
  "version": 1,
  "kind": "longlive-surgery",
  "surgeryId": "20261104-143426-884",
  "phase": "cut",
  "pid": 8316,
  "sessionPath": "<sessions-root>/<session>/session.v4.jsonl.zstd",
  "sessionId": "session-e219dedf-...",
  "memoryRoot": "<memory-root>",
  "appPath": "<app-dir>/DeepSeek Harness.exe",
  "keepTurns": 6,
  "keepTokens": 40000,
  "startDelaySeconds": 30,
  "restartDelaySeconds": 0,
  "pluginVersion": "1.1.0",
  "hostVersion": null,
  "dryRun": false,
  "before": { "bytes": 4006116, "events": 4771, "messages": 1256, "sha256": "5900be55..." },
  "backup": { "path": "<backup-path>", "sha256": "5900be55...", "bytes": 4006116 },
  "cut": { "startedAt": "...", "verify": { "ok": true }, "cli": { "exitCode": 0, "json": { } } },
  "after": { "bytes": 110329, "events": 177, "messages": 54, "sha256": "b2d1fe1c..." },
  "verify": { "ok": true, "method": "independent-readback" },
  "receipt": {
    "written": true,
    "via": "surgery-script",
    "seq": 177,
    "eventId": "surgery-receipt-20261104-143426-884",
    "after": { "bytes": 111812, "events": 178, "messages": 55, "sha256": "7c3f9a01..." }
  },
  "restart": { "ok": true, "count": 1, "pids": [1234] },
  "done": { "at": "...", "outcome": "applied-and-verified", "resultPath": "..." },
  "error": null,
  "history": [{ "phase": "prepare", "at": "..." }]
}
```

`after` 也可以出现在 `cut.after` / `cut.cli.after`；恢复按
`state.receipt.after（已写回执时） → state.after → state.cut.after → state.cut.cli.after → state.before`
找第一个带 sha 的快照。写回执会让会话合法地多一个事件、一条消息，所以回执写入后的
期望快照必须是 `receipt.after`，不能再用 `after`。

## 4. 恢复判定（`src/surgery-recovery.js`）

| 条件 | 判定 |
|---|---|
| state 不存在 | 不报告（只一次 `existsSync`） |
| `phase=done` | 不报告（`checked:false, reason:"phase-done"`） |
| `phase=needs-attention` 或 state 有 `needsAttention` | `needs-attention / E_CUT_UNVERIFIED`（rc.6） |
| state 读不了/不是 JSON | `needs-attention / STATE_UNREADABLE` |
| phase 非法 / 无 sessionPath | `needs-attention / STATE_INVALID` |
| 会话不存在或解析失败 | `needs-attention / SESSION_MISSING｜SESSION_UNREADABLE` |
| 有 after，磁盘 sha 不等 | `needs-attention / SESSION_SHA_MISMATCH` |
| sha 等但字节/事件/消息不等 | `needs-attention / SESSION_COUNTS_MISMATCH` |
| after 在，备份缺失/坏 | `needs-attention / BACKUP_MISSING｜BACKUP_SHA_MISMATCH` |
| after 在 + 备份在 + 有 verify + `cut.outcome=applied-unparsed` | `applied-unparsed / CUT_APPLIED_UNPARSED_STDOUT`（rc.6） |
| after 在 + 备份在 + 有 verify | `applied-and-verified` |
| after 在 + 备份在 + 无 verify | `applied-unverified` |
| 无 after，磁盘 == before，备份在 | `aborted-before-cut` |
| 无 after，磁盘 != before（cut 阶段） | `needs-attention / CUT_RESULT_MISSING` |
| prepare/backup 阶段，磁盘 != before | `needs-attention / SESSION_CHANGED_BEFORE_CUT` |

报告写到 `.longlive/reports/surgery-recovery-<UTC stamp>.json`，同内容一行 audit：
`<ISO>\tsurgery-recovery\t<surgeryId>\t<classification> <reasonCode>`。
报告文件名撞车时加 `-2`/`-3`，绝不覆盖旧报告。

## 5. 零副作用

- `checkSurgeryOnStart` 在没有 state 时只做一次 `existsSync`；不建目录、不写日志。
- `statusSurgery` / `scripts/surgery-inspect.mjs --recover-report` 完全不写盘。
- 恢复自检只读会话；它不调用 `truncateVisibleSession`，也不改 state。
- 唯一会写会话正文的是 `scripts/surgery-inspect.mjs --write-receipt`：只在读回校验通过后由
  执行器调用一次，写前留 `.bak-receipt-*`，写后逐字节读回并在 state 记 `receipt`。
- 配置 `surgeryRecovery: false` 可整段关闭启动自检（回执注入也随之一并关闭）。

## 6. 测试

`test/surgery-recovery.test.mjs`（10 例）：

- 四类判定各至少一例；另有 sha 不符、备份缺失、state 损坏、done 不重复报告、无 state 零副作用。
- `--recover-report` 前后对整棵目录做 sha 快照，证明只读（测试 `test/surgery-recovery.test.mjs`）。
- 真实形状演练：生成 120 turn 的会话，**真跑 CLI** 剪切，把 state 摆成 cut 后被杀的样子，
  断言恢复为 `applied-and-verified`；全程在 `%TEMP%` 下，不碰真实会话。

已覆盖：state 解析、判定分支、报告/audit、CLI 只读、真实剪切后的读回。
rc.6 另加 `test/rc6-chinese.test.mjs`（6 例）：三个 PowerShell 执行器的 UTF-8 静态审计、
`applied-unparsed` 分类与回执、`needs-attention` 不冒充 failed、中文会话回执逐字节一致且
二次写入 0 条新事件、GBK 控制台下真实执行器 dry run 的中文路径保真。
未覆盖（见 `REPORT.md`）：真实宿主关闭/重启（本环境禁止重启宿主）、计划任务实注册、
Windows 关机/断电期间的中断。

## 7. 会话正文里的回执（必修二）

用户的要求是：**启动会话后自动看到截断是否成功，而且必须出现在对话正文里**。为此有两层：

1. **主路径（脚本写）**：第 7 步读回通过后、重启之前，执行器调用
   `node scripts/surgery-inspect.mjs --write-receipt --session <path> --memory-root <root>`。
   它做的是离线追加一条 `user/message`（`source.kind = "user"`，宿主会把它投射成可见的
   对话文本，而不是上下文侧栏的 `session-reference`）：
   - 先 `parseSession` 校验事件 seq 连续，再 `encodeSession([...原来的事件, 回执])`；
   - 写前复制 `<session>.bak-receipt-<stamp>`，写临时文件 + fsync + rename，再逐字节读回；
   - 回执 `id = surgery-receipt-<surgeryId>`，幂等：state 里已有 `receipt.written` 就什么都不做；
   - 成功后把 `receipt {written, via, at, seq, eventId, backupPath, text, after{bytes,events,messages,sha256}}`
     写回 state。下一次启动自检用 `receipt.after` 比对，不会因为多了一条消息误报 sha 不符。
2. **兜底（插件注入）**：如果执行器没来得及写（失败、崩溃、旧 state、断电），插件启动时
   `checkSurgeryOnStart` 会给出报告；`src/index.js` 把 `receiptText(report)` 交给
   `registerFeatures`，由 `agent/pre-step` 在第一轮第一步注入**同样的可见文本**（一次即撤）。
   只有在存在未写回执的 state 时才注册这个钩子；没有记录时零副作用（不读、不写、不注册）。

回执正文包含：结果（成功 / 已剪切未读回 / 未执行 / 需要注意）、停在哪一阶段和 reason、
前/后字节、前/后事件数、前/后消息数（并注明本条回执 +1）、sha 是否一致、备份路径、
失败时的人工建议。测试见 `test/surgery-recovery.test.mjs` 的 receipt 用例。
