# A1 迁移说明（1.8.0 / rc.1–rc.3 / rc.4 → 1.8.3-rc.5）

> 目标：把历史上可能进入召回面的 A1 旧产物迁出，内容**不删除**，全程可审计、可恢复。
> 所有操作只作用于注入的 `memoryRoot`；不要对真实库直接跑，先备份/副本演练。

## 1. 谱系落点全表

| 版本 | 产物 | 原路径 | 读/写 | rc.5 迁移动作 |
|---|---|---|---|---|
| 1.8.0 | 直写结论卡 | `<memoryRoot>/topics/conclusion-t{turn}-{hash8}.md`，tags 含 `auto-conclusion` | 1.8.0 `conclusion.js` 写；`scanCards`/recall 读 | 移到 `.longlive/staging/auto-cards/legacy-1.8.0/`，原文件保留 |
| 1.8.0 | bridge marker | `<memoryRoot>/.longlive/bridge/*.json` | bridge 去重；不召回 | 不迁移、不删除（仅去重记录） |
| rc.1–rc.3 | 候选池 | `<memoryRoot>/.longlive/index/conclusion-drafts.jsonl` | A1 写；维护读 | 保留（候选池仍可用） |
| rc.1–rc.3 | auto 卡 | `<memoryRoot>/topics/auto/*.md` | recall/scanCards 会读（危险） | 移到 `.longlive/staging/auto-cards/`，文件保留 |
| rc.1–rc.3 | TTL archive | `<memoryRoot>/.longlive/archive/conclusion-drafts/` | 生命周期读/写 | 保留；不进入召回 |
| rc.4 | auto staging | `<memoryRoot>/.longlive/staging/auto-cards/*.md` | 仅 staging；scanCards 不读 | 保留；`legacy-1.8.0/` 为历史区 |
| rc.4/5 | maintenance state | `<memoryRoot>/.longlive/maintenance-state.json` | 维护调度读/写 | 保留，不重置 |
| 所有 | INDEX | `<memoryRoot>/INDEX.md` | 派生视图 | 迁移后 `memoryIndex({apply:true})` 重算，不含旧 A1 |

## 2. 升级矩阵

| 起点 | 迁移动作 | 验证 |
|---|---|---|
| 1.8.0 | `topics/conclusion-t*.md`（tags auto-conclusion）→ `legacy-1.8.0/` | 迁移后旧/新 scanCards 均 0 命中；内容 sha 保留 |
| rc.1 | `topics/auto/*` → staging | 旧/新 scanCards 0 命中；候选/archive 保留 |
| rc.2 | 同上 | 同上 |
| rc.3 | 同上 | 同上 |
| rc.4 | 已 staging；补迁 `topics/auto`（若存在） | 同上 |

迁移脚本幂等：第二遍 `moved=0`；不覆盖已有 staging 文件（冲突时加 `duplicate-` 后缀）；
删除的只是空目录，卡片文件全部移动/保留。

## 3. 命令

```powershell
# 只读预览（默认 dry-run）
node scripts/migrate-a1-legacy.mjs --memory-root "<memoryRoot>" --dry-run --json --out migrate-dry.json

# 真正迁移 + 重建 INDEX + 写回执/日志
node scripts/migrate-a1-legacy.mjs --memory-root "<memoryRoot>" --apply --json --out migrate-apply.json
```

产物：
- 迁移日志：`<memoryRoot>/.longlive/logs/a1-migration.jsonl`
- 迁移回执：`<memoryRoot>/.longlive/migrations/a1-legacy-<timestamp>.json`
- 旧 1.8.0 卡：`<memoryRoot>/.longlive/staging/auto-cards/legacy-1.8.0/`
- rc.1–3 卡：`<memoryRoot>/.longlive/staging/auto-cards/`

## 4. 人工审 / 恢复

- 这些卡**只是移出召回面，不是删除**；需要保留历史时留在 staging。
- 若人工审后确认可召回：把文件移回 `topics/`（建议改名并补 `status/审核` 字段），再重建 INDEX。
- 若要恢复 1.8.0 语义：把 `legacy-1.8.0/` 中的卡移回 `topics/`，明确这是旧 A1 的助手转述卡，
  不建议直接恢复。
- 回滚到 1.8.0：staging/legacy 在 `.longlive/` 下，1.8.0 的 `scanCards` 扫不到（0 命中），
  因此无需迁移；但 rc.3 之前遗留的 `topics/auto/` 必须先跑本迁移。
- INDEX 是可重建派生视图，不含 staging/legacy。

## 5. 自动化

维护 job 启动时会做同一迁移（best-effort，写日志/回执）；也可以手动运行 CLI。
迁移失败不会删除任何卡片；查看 `a1-migration.jsonl` 定位。

## 6. rc.6 迁移安全保证

- **dry-run 零写盘**：dry-run 只用文件系统列举 topics，不调用 scanCards；不会写 card-audit、INDEX、日志或回执。
- **可中断恢复**：每张卡移动前写 journal `begin`、移动后写 `done`；若中途被杀，下一次运行会扫描剩余 topics 卡继续移动，并把已存在 staging 的卡计为 recovered。回执含 moved/recovered/totalLegacy。
- **维护 job 必重算 INDEX**：迁移动作数 >0（或 recovered >0）时同一维护 job 调 `memoryIndex({apply:true})`；迁移成功但 INDEX 旧行=0 才算完成。
- **降级 preflight**：

  ```powershell
  node scripts/migrate-a1-legacy.mjs --memory-root "<memoryRoot>" --check-only
  ```

  有未迁移 legacy 卡时退出码 2，输出 `E_A1_LEGACY_NOT_MIGRATED`；确认迁移后再降级。
- **1.8.0 自动写 topics 的行为已在 1.8.3 A1 移除**；rc.5/6 只写候选/staging。
