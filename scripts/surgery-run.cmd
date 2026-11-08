@echo off
rem Unattended surgery entry: register a hidden scheduled task and start it.
rem The surgery itself runs detached with -WindowStyle Hidden, so there is no
rem console window to click x on. After TASK_STARTED you may close this window.
setlocal
if "%~1"=="" goto :usage

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-surgery-task.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [surgery-run] installer failed with exit code %RC%.
  exit /b %RC%
)
echo [surgery-run] Task started. This window can be closed; the surgery runs hidden.
exit /b 0

:usage
echo Usage:
echo   surgery-run.cmd -SessionPath "<session-file>" -AppPath "<app folder>\DeepSeek Harness.exe" -Confirm TRUNCATE-VISIBLE [options]
echo.
echo Options:
echo   -KeepTurns N            default 12
echo   -KeepTokens N           default 80000
echo   -StartDelaySeconds N    default 30 (reading window before the host closes)
echo   -RestartDelaySeconds N  default 0 (restart immediately after verify + receipt)
echo   -MemoryRoot PATH        default DSH_LONGLIVE_MEMORY_ROOT / DSH_MEM / ^<DSH home^>\longlive-memory
echo   -ResultPath PATH        default ^<memoryRoot^>\.longlive\reports\surgery-result-^<id^>.json
echo   -NodeExe PATH           node.exe used to run the plugin CLI
echo   -TaskName NAME          default dsh-longlive-surgery
echo   -DryRun                 no host kill, no backup, no cut
echo   -NoStart                register the task but do not start it
echo.
echo Real runs require -Confirm TRUNCATE-VISIBLE and a session under the DSH sessions root.
exit /b 2
