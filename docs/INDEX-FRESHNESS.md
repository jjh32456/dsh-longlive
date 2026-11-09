# 索引新鲜度（INDEX freshness）

`memory-state.json` 现在区分四个时间，不能用 `generatedAt` 充健康：

| 字段 | 含义 |
|---|---|
| `indexBuiltAt` | INDEX.md 最近一次实际写入时间 |
| `indexDataAt` | 最近一次确认被纳入索引的输入时间 / 最新卡或事件 mtime |
| `indexLagMs` | `indexDataAt - indexBuiltAt`，索引落后输入的毫秒数 |
| `indexFreshness` | `fresh` / `stale` / `unknown` / `error` |
| `indexLastError` / `indexFailureCount` | 失败告警和累计次数（refresh 失败不阻断 turn） |
| `lastCaptureAt` | captureTurn 最近一次成功采集时间 |

工具/脚本：

- `memory_index` 的返回带 `freshness`、`autoCards`、`rawPolicy`；
- `node scripts/index-status.mjs --memory-root <dir> --json` 只读输出；
- `node scripts/index-maintain.mjs --memory-root <dir> --apply` 幂等刷新 INDEX + 状态；
- `captureTurn` 成功后会自动调用同一刷新路径，失败只在 memory-state 记 error，不破坏本轮。

健康判据：`status=stale` 表示 `indexLagMs > 5min`；`status=unknown` 表示没有可证明的输入/生成时间；`status=error` 表示最近一次刷新失败。`dataAgeMs` 只说明数据本身多久没变化，不是索引落后。
