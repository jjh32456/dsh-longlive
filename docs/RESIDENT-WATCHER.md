# 常驻看门（resident watcher）

0.9.0-rc.1 **只复制脚本，不安装、不注册计划任务**。安装必须由操作者手动执行；
npm 安装或升级这个包不会改变系统启动项、计划任务或注册表。

## 它做什么

`resident-watcher.ps1` 注册一个当前用户的计划任务（AtLogOn），由
`watch-loop.ps1` 在交互会话里轮询 `.longlive` 的 auto-truncate 请求：需要截断
时关闭 GUI、截断会话日志、校验、再启动 GUI。它不是 DSH 插件的一部分，也不
参与 `apply()`；没有安装时，主包行为与 0.8.0 完全一致。

## 前置条件

- Windows PowerShell 5.1（脚本 `#requires -Version 5.1`）。
- 固定的本地 memoryRoot；不要用映射盘/可移动盘（脚本会拒绝映射盘这类根）。
- 已安装的 DeepSeek Harness，且知道 `DeepSeek Harness.exe` 的路径。
- 交互式登录会话（计划任务在该会话里跑，关机会停，符合“人不在就不看门”）。

## 安装步骤（手动）

1. 选一个**不会被 npm 升级覆盖**的目录，例如
   `%LOCALAPPDATA%\dsh-resident-watcher`。
2. 把包里的 `scripts\` 下这些文件复制过去，保持 `lib\` 子目录：

   ```text
   resident-watcher.ps1
   watch-loop.ps1
   install-resident-watcher.ps1
   uninstall-resident-watcher.ps1
   resident-watcher-status.ps1
   lib\auto-truncate-run.ps1
   ```

3. 以当前用户运行安装包装器（不要用管理员，计划任务要挂在当前用户下）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass `
     -File "$env:LOCALAPPDATA\dsh-resident-watcher\install-resident-watcher.ps1" `
     --memory-root "<memory-root>" `
     --app-exe "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe" `
     --profile default
   ```

   常用参数：

   | 参数 | 含义 |
   | --- | --- |
   | `--memory-root <path>` | 必填/自动探测；持有 `.longlive\logs` 的目录 |
   | `--app-exe <path>` | GUI 可执行文件；缺省从运行进程或默认安装目录找 |
   | `--app-args <string>` | 重启 GUI 时附加参数 |
   | `--profile <name>` | dsh profile，默认 `desktop` |
   | `--task-name <name>` | 计划任务名，默认 `DshResidentWatcher` |
   | `--no-start` | 只注册任务，不立即启动 |
   | `--json` | 机器可读输出（install/status） |

4. 验证：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass `
     -File "$env:LOCALAPPDATA\dsh-resident-watcher\resident-watcher-status.ps1" --json
   ```

   期望看到任务存在、watcher 进程/心跳正常；`--status` 不会修改日志。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\dsh-resident-watcher\uninstall-resident-watcher.ps1"
```

卸载只移除计划任务并停掉看门循环，不删 memoryRoot、不删会话日志。确认不再
需要后，可手动删除 `%LOCALAPPDATA%\dsh-resident-watcher` 目录。

## 升级

- 先卸载旧任务，覆盖脚本目录，再重新安装；不要在两个目录各留一套。
- 计划任务里记录的是安装时的绝对路径，移动目录后必须重装。
- 0.9.0-rc.1 不提供自动迁移；`--task-name` 可用于并行试装，但同一时间只应
  该有一个 watcher 持有锁。

## 已知限制

- **必须手动安装**：包不执行 `install.ps1`，也不会在启动时偷偷注册任务。
- 只支持当前用户、交互式会话；服务账户/无登录会话不适用。
- 映射盘、可移动盘、网络路径不作为 memoryRoot。
- watcher 需要能关闭并重启 GUI；正在跑长任务时它会把“重启”当成截断流程的
  一部分，操作者要自己确保时机合适。
- 这是 Windows PowerShell 5.1 脚本，不保证 PowerShell 7 / 非 Windows 行为。
