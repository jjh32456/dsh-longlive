# dsh-session-longlive 0.8.0 发布说明

- 发布状态：**本地冻结**（只产出本地 tgz，未发布到任何 registry，未装进真机 profile）
- 版本：`0.8.0`（由 `0.8.0-rc.11` 冻结；仅版本号与文档变化，功能代码零改动）
- 构建日期：2026-11-04
- 构建方式：`$env:SOURCE_DATE_EPOCH='1793760000'; node scripts/pack.mjs --expect-version 0.8.0`

## 1. 产物

| 项 | 值 |
| --- | --- |
| tgz | `<work-dir>\release-080\dist\dsh-session-longlive-0.8.0.tgz` |
| 字节 | **571,745** |
| SHA-256 | `9bea2bf93adf0b40c47fa103cd6b33d80f29fa03d1637c84060881857dee63d2` |
| 校验文件 | `dist\dsh-session-longlive-0.8.0.tgz.sha256`（格式：`<sha>  <文件名>`） |
| tar 条目 | **107**（全部为文件条目；归档未写独立目录条目，解包后磁盘文件数同为 107） |
| manifest 文件数 | **106**（`build-info.json` 不列在自身 manifest 中；`package.json` 在 manifest 内） |
| sourceTreeSha256 | `646478d9a28064017ddc827fe69b231a2f9b9e2df7a066d878093d817f5f520d` |
| build-info.generatedAt | `2026-11-04T02:40:00.000Z`（由固定的 SOURCE_DATE_EPOCH 推出） |

可复现性：同一 `SOURCE_DATE_EPOCH` 连打两次，`dist\dsh-session-longlive-0.8.0.tgz` 与
`dist\repro-check-0.8.0.tgz` 的 sha256、字节数完全一致；`pack.mjs --verify` 通过
（`ok=true`、`sidecarOk=true`）。

本文件 `RELEASE.md`、`_verify\` 与 `dist\repro-check-*` 不打包进 tgz，随 tgz 单独交付。

与 rc.11 相比：字节 570,520 → 571,745（+1,225），sha 必然变化；变化的来源只有
`package.json` 的版本号、文档里的版本行、`CHANGELOG.md` 新增的 0.8.0 条目。

## 2. 改了什么（以及没改什么）

- `package.json`: `"version": "0.8.0"`。
- 14 个文档文件（不含 `CHANGELOG.md`）里的当前版本字样 `0.8.0-rc.11` → `0.8.0`：`README.md`、`README.en.md`、
  `SPEC.md`、`QUICKSTART.md`、`docs/ARCHITECTURE.md`、`docs/CONFIG.md`、`docs/DEV.md`、
  `docs/ERRORS.md`、`docs/FAQ.md`、`docs/OPERATIONS.md`、`docs/QUICKSTART.md`、
  `docs/README.en.md`、`docs/TOOLS.md`、`docs/TROUBLESHOOTING.md`。
- `CHANGELOG.md`: 新增 `## 0.8.0 — 2026-11-04` 条目，汇总 rc.1–rc.11 的变更与验收/红队结论；
  rc.1–rc.11 的历史条目原样保留。
- **未改**：`src/`、`scripts/`、`test/`、`locale/`、`cordis.patch.yml`、`icon.svg` 共
  **88 个文件与 rc.11 逐字节相同**（本次发布前做过 sha256 全量对比：88/88 identical，0 diff）。
  `src/`、`test/` 注释里出现的 `0.8.0-rc.11` 是历史缺陷锚点，按“不改功能代码”原则保留。
- `SPEC.md` 中 `已决（0.7.4，0.8.0-rc.10 沿用）` 属历史记录，保留。

## 3. 验收结果

### 3.1 测试套件

命令（包内自带 harness；`node --test test/` 不是计数运行器，`test/run.mjs` 才是）：

```powershell
$node = "<本机 Node 24.x 路径>\node.exe"
$env:DSH_LONGLIVE_APP_EXE = "<本机 DeepSeek Harness.exe>"
& $node test/run.mjs
```

结果：**347 passed / 0 failed / 1 skipped，exit 0**。

- `SKIP T7 real sdk resume (isolated DSH_HOME)`：原因 `DSH_T7_API_KEY is not set`，T7 是
  opt-in，套件不读取凭据文件；给 key 后此项可转 PASS，但本发布按“缺 key 即 skip”记录。
- `PASS P6`：测试期间包目录未被写入（`package tree unchanged (113 files)`）。
- 日志：`<work-dir>\release-080\_verify\suite-080.log`。

### 3.2 doctor

```powershell
& $node scripts/longlive-doctor.mjs --json
```

结果：**exit 0**，`ok=true`，`version=0.8.0`，`profile=desktop`，
`missing=[]`，可选 peer `@kenz1117/dsh-engram` 状态“已启用”。

### 3.3 独立解包核对

把 tgz 解到 `_verify\unpacked\package`，用独立脚本（不 import `pack.mjs`）重算每个文件：

| 检查 | 结果 |
| --- | --- |
| `package.json` version | `0.8.0` ✅ |
| `build-info.json` version / fileCount | `0.8.0` / `106` ✅ |
| 磁盘文件数 / tar 条目 | 107 / 107 ✅ |
| manifest 覆盖（缺失 / 多余） | 0 / 0 ✅ |
| 逐文件 sha256 / 字节 | 0 错 / 0 错 ✅ |
| README 版本行 | 安装命令文件名 `0.8.0`、正文“本套文档对应 **0.8.0**” ✅ |
| 当前版本文档中 `0.8.0-rc.11` 残留 | 0 ✅（仅 CHANGELOG 历史条目与 src/test 注释锚点有） |
| `build-info.generatedAt` | `2026-11-04T02:40:00.000Z` ✅ |

脚本与结果：`_verify\check-package.mjs`、`_verify\check-package.json`。

## 4. 红队结论与已知限制

rc.11 的独立红队复核（`<work-dir>\rc11-redteam\REPORT.md`）结论为
**accept-with-limits：无阻断问题，可发布**。以下限制原样带入 0.8.0，不构成本次冻结的阻断项：

1. “106 个文件”是 manifest 计数；tar/磁盘实际是 107 个文件（`build-info.json` 不在自身 manifest）。
2. 首条用户消息的 carry 卡整行 4,155 字符，超过 4,000 的前缀上限 155 字符；
   前缀契约 PASS，字面“整卡 ≤4,000”FAIL。
3. `SPEC.md` 的 PORT 描述写成 PORT1–PORT5，实际存在 PORT6；PORT5 的实现是硬编码
   `SRC_SHIPPED` 而非读 `package.json` 的 `files`；根目录清单漏了 `build-info.json` / `icon.svg`。
4. `docs/ARCHITECTURE.md:119`、`docs/TOOLS.md:3-4` 引用的 `src/tools.js:1970/:2360` 已漂移
   （实际 `TOOLS=1984`、`registerTools=2381`）；`docs/TOOLS.md:60` 的
   `assertNotOwnLiveSession` 行号 385 已漂移（实际 431 起）。
5. PORT5 扫描 `CHANGELOG.md`，但没有把它列进必须存在的固定清单。
6. 自动 `NO_BOUNDARY` 路径在默认 `stabilizePasses` 下没有可达的套件内 fixture。

VM 全链路记录（2,906 tokens ≤4,000、`VIOLATIONS=0`、面板 0.1.4）来自 rc.11 冻结时的
发布任务书；本机未找到可独立复核该行数字的 VM 报告文件，故按“冻结记录”引用，未把它写成
本次重跑结果。面板是独立可选包，不在本 tgz 内（本机现存 `dsh-longlive-panel-0.1.4.tgz`，
34,371 B）。

## 5. 升级步骤

前置：DSH `>=0.2.0 <1.0.0`、Node `>=20`；先在测试 profile 上验，再动生产 profile。
升级前备份 `longlive-memory` 与相关会话的 `.bak-YYYYMMDD`（0.8.0 不改记忆根，备份只为保险）。

通用升级（对同一个 profile 再执行一次 `add`，宿主会替换为新版）：

```powershell
$DSH = "<DSH 可执行文件>"          # dsh 在 PATH 时可直接用 dsh
$TGZ = "<work-dir>\release-080\dist\dsh-session-longlive-0.8.0.tgz"
& $DSH plugin --profile desktop list --depth 0
& $DSH plugin --profile desktop add "file:$TGZ"
& $DSH plugin --profile desktop list --depth 0     # 应显示 dsh-session-longlive@0.8.0
```

然后重启该 profile 的宿主，确认新会话里 21 个工具注册、`longlive-doctor.mjs --json` exit 0。

按来源版本：

- **0.7.7 → 0.8.0**：直接按上面步骤装 0.8.0。0.7.7 没有 0.8.0 的 router/doctor/engram 能力，
  装完建议跑一次 `longlive-doctor.mjs --json`；缺 `@kenz1117/dsh-engram` 时按需
  `--setup`（会打印计划并要求输入大写 `YES`）。
- **rc.9 → 0.8.0**：同上。rc.9 已有 doctor 与审计日志；0.8.0 新增的配置项（`firstUserCapChars`、
  `boundaryRetries`）都有默认值，不需要迁移数据。
- **rc.11 → 0.8.0**：纯版本号/文档升级，功能代码逐字节相同；直接 `add` 覆盖安装即可，
  不需要改配置、不需要动记忆库、不需要重跑截断。

## 6. 回滚到 rc.11

```powershell
$DSH  = "<DSH 可执行文件>"
$RC11 = "<work-dir>\rc11-work\dist\dsh-session-longlive-0.8.0-rc.11.tgz"
# 先验包：570,520 B；sha256 a2d19f8703d4edf6d10a3a75ef3a7ebd45b83a317f8efd94bb9382d2fe5967d7
Get-FileHash $RC11 -Algorithm SHA256
& $DSH plugin --profile desktop add "file:$RC11"
& $DSH plugin --profile desktop list --depth 0     # 应显示 dsh-session-longlive@0.8.0-rc.11
```

重启宿主后按 rc.11 的 runbook 复核。回滚**不需要**恢复会话或记忆库：0.8.0 没有数据迁移，
截断产物结构向后兼容；不要为了降级去覆盖 `.bak` 或 `longlive-memory`。

## 7. 发布检查清单

- [x] `package.json` 版本 = `0.8.0`
- [x] 14 个文档的当前版本行 = `0.8.0`，历史 rc.N 保留
- [x] `CHANGELOG.md` 有 0.8.0 正式版条目（汇总 rc.1–rc.11 + 红队结论）
- [x] 功能代码与 rc.11 逐字节一致（88/88 文件 sha256 相同）
- [x] 固定 `SOURCE_DATE_EPOCH` 双次重打，sha256/字节一致
- [x] `pack.mjs --verify` 通过，sidecar 存在且格式正确
- [x] 套件 347/0/1，exit 0（T7 因缺 `DSH_T7_API_KEY` skip）
- [x] `longlive-doctor.mjs --json` exit 0，`version=0.8.0`
- [x] 独立解包：version / 107 条目 / 106 manifest / 逐文件 sha / README 行 全通过
- [x] 当前版本文档无 `0.8.0-rc.11` 残留
- [ ] 运维在测试 profile 安装、重启、确认 21 个工具（本机未装，避免碰真机 profile）
- [ ] 运维确认发布渠道（本包**未**发布到任何 registry，只交付本地 tgz）

## 8. 本机证据文件

- `_verify\suite-080.log` — 347/0/1 套件日志
- `_verify\check-package.json` / `_verify\check-package.mjs` — 独立解包核对
- `_verify\release-result.json` — 本次冻结的机器可读结果
- `_verify\unpacked\package\` — 解包后的发布内容
- `_verify\bump-version.mjs` — 版本/文档替换脚本（一次性）
- `dist\repro-check-0.8.0.tgz` — 第二次重打产物（同 sha）
- `_verify\not-shipped\REPORT-rc10-build.md` — 旧的 rc.10 构建报告（不随包发布）
