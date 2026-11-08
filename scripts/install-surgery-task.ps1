#requires -Version 5.1
<#
.SYNOPSIS
  Register and start the hidden longlive surgery task (no visible console).

.DESCRIPTION
  Creates a one-shot Task Scheduler task that runs
  scripts/unattended-surgery.ps1 through powershell.exe with
  -NoProfile -NonInteractive -WindowStyle Hidden. The task has no window the
  user can close: closing this registrar window before TASK_STARTED only
  cancels registration; after TASK_STARTED the surgery is owned by the
  Task Scheduler service.

  The task is registered with -Hidden, ignores duplicate instances, and is
  limited to 2 hours. It runs as the current interactive user.

.PARAMETER TaskName
  Scheduled task name (default dsh-longlive-surgery). Re-registering replaces it.

.PARAMETER NoStart
  Register only; do not start the task now.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install-surgery-task.ps1 `
    -SessionPath "%USERPROFILE%\.dsh\sessions\scope\abc\session.v4.jsonl.zstd" `
    -AppPath "<path-to-DSH-host.exe>" -Confirm TRUNCATE-VISIBLE
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SessionPath,

  [int]$KeepTurns = 12,
  [int]$KeepTokens = 80000,
  [int]$StartDelaySeconds = 30,
  [int]$RestartDelaySeconds = 0,

  [string]$AppPath = '',
  [string]$ResultPath = '',
  [string]$MemoryRoot = '',
  [string]$NodeExe = '',
  [string]$Confirm = '',

  [string]$TaskName = 'dsh-longlive-surgery',
  [switch]$DryRun,
  [switch]$AllowOutsideSessions,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

function Write-Fail {
  param([string]$Message, [int]$Code = 2)
  [Console]::Error.WriteLine($Message)
  exit $Code
}

if (-not (Test-Path -LiteralPath $SessionPath -PathType Leaf)) {
  Write-Fail "SessionPath not found: $SessionPath" 2
}
$SessionPath = (Resolve-Path -LiteralPath $SessionPath).Path

if (-not $DryRun) {
  if ($Confirm -ne 'TRUNCATE-VISIBLE') {
    Write-Fail "Refusing to register a real cut: pass -Confirm TRUNCATE-VISIBLE (or -DryRun)." 2
  }
  if (-not $AppPath -and $env:DSH_APP_PATH) {
    $AppPath = $env:DSH_APP_PATH
  }
  if (-not $AppPath) {
    Write-Fail "Refusing to register a real cut: pass -AppPath <dsh host exe> or set DSH_APP_PATH." 2
  }
}
if ($AppPath) {
  if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
    Write-Fail "AppPath not found: $AppPath" 2
  }
  $AppPath = (Resolve-Path -LiteralPath $AppPath).Path
}
if ($TaskName -notmatch '^[A-Za-z0-9._-]{1,120}$') {
  Write-Fail "TaskName may only contain letters, digits, dot, underscore, dash (max 120)." 2
}

$launcher = Join-Path $PSScriptRoot 'unattended-surgery.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  Write-Fail "Launcher not found: $launcher" 2
}

function Quote-Arg {
  param([string]$Value)
  if ($Value -match '[\s"]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

$tokens = @(
  '-NoProfile',
  '-NonInteractive',
  '-WindowStyle', 'Hidden',
  '-ExecutionPolicy', 'Bypass',
  '-File', (Quote-Arg $launcher),
  '-SessionPath', (Quote-Arg $SessionPath),
  '-KeepTurns', "$KeepTurns",
  '-KeepTokens', "$KeepTokens",
  '-StartDelaySeconds', "$StartDelaySeconds",
  '-RestartDelaySeconds', "$RestartDelaySeconds"
)
if ($AppPath) { $tokens += @('-AppPath', (Quote-Arg $AppPath)) }
if ($ResultPath) { $tokens += @('-ResultPath', (Quote-Arg $ResultPath)) }
if ($MemoryRoot) { $tokens += @('-MemoryRoot', (Quote-Arg $MemoryRoot)) }
if ($NodeExe) { $tokens += @('-NodeExe', (Quote-Arg $NodeExe)) }
if ($DryRun) { $tokens += '-DryRun' } else { $tokens += @('-Confirm', 'TRUNCATE-VISIBLE') }
if ($AllowOutsideSessions) { $tokens += '-AllowOutsideSessions' }

$argumentLine = $tokens -join ' '

$registered = $false
try {
  if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argumentLine
    $settings = New-ScheduledTaskSettingsSet `
      -Hidden `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew `
      -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    $userId = $env:USERNAME
    if ($env:USERDOMAIN) { $userId = "$env:USERDOMAIN\$env:USERNAME" }
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -Principal $principal -Force | Out-Null
    $registered = $true
  }
} catch {
  [Console]::Error.WriteLine("Register-ScheduledTask failed: $($_.Exception.Message)")
}

if (-not $registered) {
  # Windows PowerShell 5.1 always has schtasks.exe; /IT keeps it in the
  # interactive session so the restarted host is visible on the desktop.
  $taskCommand = 'powershell.exe ' + $argumentLine
  & schtasks.exe /Create /TN $TaskName /SC ONCE /ST 23:59 /F /IT /TR $taskCommand | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "schtasks /Create failed with exit code $LASTEXITCODE" 1
  }
  $registered = $true
}

if (-not $registered) {
  Write-Fail "Could not register scheduled task $TaskName" 1
}

if ($NoStart) {
  Write-Output "TASK_REGISTERED $TaskName"
  exit 0
}

if (Get-Command Start-ScheduledTask -ErrorAction SilentlyContinue) {
  Start-ScheduledTask -TaskName $TaskName
} else {
  & schtasks.exe /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "schtasks /Run failed with exit code $LASTEXITCODE" 1
  }
}

Write-Output "TASK_STARTED $TaskName"
Write-Output "The surgery now runs detached and windowless. This console can be closed."
if ($DryRun) {
  Write-Output "Dry run: no host will be closed and no bytes will be cut."
} else {
  Write-Output ("Closing the host in {0} seconds (reading window), then cut, verify, receipt, restart (+{1}s)." -f $StartDelaySeconds, $RestartDelaySeconds)
}
exit 0
