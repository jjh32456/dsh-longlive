# raw / 原始材料索引规则

- `raw/` 与 `topics/raw/` 默认 **不进入 INDEX.md**，也不占用生成表行数。
- 原因：这些文件是会话原文/证据归档；把每个 raw 文件当卡片会把 INDEX.md 变成第二份会话日志，违背“先读引子、再按需读卡”的规则。
- `memory_index` 在 dry-run/apply 结果里返回 `rawPolicy`：`policy=excluded-by-default`、文件列表、可选 opt-in 列表；面板/状态应显示“raw 未入表但有 N 个文件”，不能显示成漏卡。
- 未来若需要 opt-in：在 raw 文件 frontmatter 写 `index: true`，并由维护者显式接入 `scanCards`；当前版本**没有**默认自动纳入，避免误伤。
- `index-status.mjs` 和 `memory_index` 的 `rawPolicy` 是判断“raw 规则有没有被破坏”的入口，不以“生成时间”代替。
