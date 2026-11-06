#Requires -Version 5.1
<#
.SYNOPSIS
  Uninstall the resident session watchdog scheduled task and its files.

.DESCRIPTION
  Orderly shutdown:
    1. write <memoryRoot>\.longlive\session-watch\stop.flag so the loop exits
       after its current tick (it checks every 5 seconds),
    2. stop and unregister the scheduled task (Stop/Unregister-ScheduledTask,
       falling back to schtasks /End and /Delete),
    3. if a recorded loop pid is still alive AND its command line contains
       scripts\session-watch.mjs, stop that process; never kill by pid alone,
    4. remove the install directory (receipts and state live under memoryRoot
       and are deliberately kept).

  This script changes Task Scheduler, which is a high-impact action on a real
  machine. Dry-run it first:
      powershell -NoProfile -File uninstall-session-watch.ps1 -DryRun

  All paths used in task commands are ASCII-only; non-ASCII input is rejected.

.PARAMETER KeepFiles
  Unregister and stop, but leave the install directory in place.

.PARAMETER ForceStop
  If the loop does not exit within 15 seconds after stop.flag, stop the
  recorded pid only when its command line matches the watcher script.

.PARAMETER ForceRemove
  Allow removing a non-default install directory (still refuses a path whose
  leaf is not dsh-session-watch).
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'dsh-session-watch'),
    [string]$TaskName = 'DshSessionWatch',
    [switch]$DryRun,
    [switch]$KeepFiles,
    [switch]$ForceStop,
    [switch]$ForceRemove
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    throw "uninstall-session-watch: $Message"
}

function Test-AsciiPath([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value)) { Fail "$Label is empty" }
    if ($Value -notmatch '^[\x20-\x7E]+$') { Fail "$Label must be pure ASCII, got: $Value" }
    return $Value
}

function Resolve-FullPath([string]$Value, [string]$Base) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $Base $Value))
}

$install = Resolve-FullPath $InstallDir (Get-Location).Path
[void](Test-AsciiPath $install 'InstallDir')
[void](Test-AsciiPath $TaskName 'TaskName')

$configPath = Join-Path $install 'session-watch.config.json'
$config = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    try { $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch { $config = $null }
}

$memoryRoot = ''
$stopFlag = ''
$lockPath = ''
if ($config) {
    $memoryRoot = [string]$config.memoryRoot
    $stopFlag = [string]$config.stopFlag
    $lockPath = [string]$config.lockPath
}
if (-not $memoryRoot -and $env:DSH_MEM) { $memoryRoot = $env:DSH_MEM }
if (-not $memoryRoot) {
    $home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $memoryRoot = Join-Path $home 'longlive-memory'
}
if (-not $stopFlag) { $stopFlag = Join-Path $memoryRoot '.longlive\session-watch\stop.flag' }
if (-not $lockPath) { $lockPath = Join-Path $memoryRoot '.longlive\session-watch\watch.pid' }

$plan = [ordered]@{
    ok = $true
    dryRun = [bool]$DryRun
    installDir = $install
    taskName = $TaskName
    memoryRoot = $memoryRoot
    stopFlag = $stopFlag
    lockPath = $lockPath
    keepFiles = [bool]$KeepFiles
}

if ($DryRun) {
    $plan['taskExists'] = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
    $plan['configExists'] = [bool](Test-Path -LiteralPath $configPath -PathType Leaf)
    $plan['note'] = 'dry run: no flag written, no task changed, no file removed'
    $plan | ConvertTo-Json -Depth 6
    exit 0
}

# --- 1. ask the loop to stop ----------------------------------------------------
$stopRequested = $false
if (Test-Path -LiteralPath (Split-Path -Parent $stopFlag)) {
    [System.IO.File]::WriteAllText($stopFlag, (Get-Date).ToString('o') + [Environment]::NewLine,
        (New-Object System.Text.UTF8Encoding($false)))
    $stopRequested = $true
}

# --- 2. stop and unregister the task -------------------------------------------
$taskStopped = $false
$taskRemoved = $false
$taskSeen = $false
try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $taskSeen = $true
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; $taskStopped = $true } catch { }
        try {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
            $taskRemoved = $true
        } catch {
            & schtasks.exe /Delete /TN $TaskName /F 2>&1 | ForEach-Object { Write-Verbose $_ }
            if ($LASTEXITCODE -eq 0) { $taskRemoved = $true }
        }
    }
} catch {
    # Get-ScheduledTask can be unavailable; fall through to schtasks.
    & schtasks.exe /Query /TN $TaskName 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $taskSeen = $true
        & schtasks.exe /End /TN $TaskName 2>&1 | ForEach-Object { Write-Verbose $_ }
        if ($LASTEXITCODE -eq 0) { $taskStopped = $true }
        & schtasks.exe /Delete /TN $TaskName /F 2>&1 | ForEach-Object { Write-Verbose $_ }
        if ($LASTEXITCODE -eq 0) { $taskRemoved = $true }
    }
}

# --- 3. wait for the loop, then only kill a verified watcher -------------------
$loopPid = $null
if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
    try { $loopPid = [int](Get-Content -LiteralPath $lockPath -Raw).Trim() } catch { $loopPid = $null }
}
$loopExited = $true
$forced = $false
if ($loopPid -and $loopPid -gt 0) {
    $loopExited = $false
    for ($i = 0; $i -lt 15; $i++) {
        if (-not (Get-Process -Id $loopPid -ErrorAction SilentlyContinue)) { $loopExited = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $loopExited -and $ForceStop) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $loopPid" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -and $proc.CommandLine -match 'session-watch\.mjs') {
            Stop-Process -Id $loopPid -Force -ErrorAction Stop
            $forced = $true
            Start-Sleep -Seconds 1
            $loopExited = -not [bool](Get-Process -Id $loopPid -ErrorAction SilentlyContinue)
        }
    }
}

# --- 4. remove install files (never memoryRoot evidence) -----------------------
$removedFiles = $false
if (-not $KeepFiles) {
    $leaf = Split-Path -Leaf $install
    if ($leaf -ne 'dsh-session-watch' -and -not $ForceRemove) {
        Fail "refusing to remove ${install}: leaf is not dsh-session-watch (pass -ForceRemove)"
    }
    if (Test-Path -LiteralPath $install -PathType Container) {
        Remove-Item -LiteralPath $install -Recurse -Force -ErrorAction Stop
        $removedFiles = $true
    }
}

$plan['stopRequested'] = $stopRequested
$plan['taskSeen'] = $taskSeen
$plan['taskStopped'] = $taskStopped
$plan['taskRemoved'] = $taskRemoved
$plan['loopPid'] = $loopPid
$plan['loopExited'] = $loopExited
$plan['forced'] = $forced
$plan['removedFiles'] = $removedFiles
if ($loopPid -and -not $loopExited) { $plan['ok'] = $false }
$plan['finishedAt'] = (Get-Date).ToString('o')
$plan | ConvertTo-Json -Depth 6
if ($plan['ok']) { exit 0 } else { exit 1 }
