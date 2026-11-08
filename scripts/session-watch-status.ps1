#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only status for the resident session watchdog.

.DESCRIPTION
  Prints one JSON document: scheduled-task state, the resolved config (never
  secrets), the last tick summary, the per-session state digest, and the newest
  receipts. It writes nothing and does not start/stop anything.

  Use this after install, during a drill, or when a session did not get cut:
  `lastTick.actions[].status` plus the receipt is the evidence trail.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'dsh-session-watch'),
    [string]$TaskName = 'DshSessionWatch',
    [int]$ReceiptLimit = 5
)

$ErrorActionPreference = 'SilentlyContinue'

function Debug-Step([string]$Name) {
    if ($env:DSH_STATUS_DEBUG) { [Console]::Error.WriteLine("status-step: $Name") }
}

function Resolve-FullPath([string]$Value, [string]$Base) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $Base $Value))
}

$install = Resolve-FullPath $InstallDir (Get-Location).Path
$configPath = Join-Path $install 'session-watch.config.json'
$result = [ordered]@{
    ok = $true
    at = (Get-Date).ToString('o')
    installDir = $install
    taskName = $TaskName
    configPath = $configPath
    configExists = [bool](Test-Path -LiteralPath $configPath -PathType Leaf)
    config = $null
    task = $null
    lastTick = $null
    stateSummary = $null
    receipts = @()
    logTail = @()
}

if ($result.configExists) {
    try { $result.config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch {
        $result.ok = $false
        $result.configError = $_.Exception.Message
    }
}
Debug-Step 'config'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $result.task = [ordered]@{
        exists = $true
        state = [string]$task.State
        lastRunTime = if ($info) { [string]$info.LastRunTime } else { $null }
        lastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
        nextRunTime = if ($info) { [string]$info.NextRunTime } else { $null }
        numberOfMissedRuns = if ($info) { $info.NumberOfMissedRuns } else { $null }
    }
} else {
    $result.task = [ordered]@{ exists = $false }
}
Debug-Step 'task'

if ($result.config) {
    $lastTickPath = [string]$result.config.lastTickPath
    if (-not $lastTickPath) {
        $lastTickPath = Join-Path ([string]$result.config.memoryRoot) '.longlive\session-watch\last-tick.json'
    }
    if (Test-Path -LiteralPath $lastTickPath -PathType Leaf) {
        try { $result.lastTick = Get-Content -LiteralPath $lastTickPath -Raw | ConvertFrom-Json } catch {
            $result.ok = $false
            $result.lastTickError = $_.Exception.Message
        }
    }

    $statePath = [string]$result.config.statePath
    if (-not $statePath) {
        $statePath = Join-Path ([string]$result.config.memoryRoot) '.longlive\session-watch\state.json'
    }
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try {
            $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            $sessions = @($state.sessions.PSObject.Properties)
            $result.stateSummary = [ordered]@{
                updatedAt = $state.updatedAt
                sessions = $sessions.Count
                statuses = @($sessions | ForEach-Object { $_.Value.lastStatus } | Where-Object { $_ } | Group-Object | Sort-Object Name | ForEach-Object {
                    [ordered]@{ status = $_.Name; count = $_.Count }
                })
            }
        } catch {
            $result.ok = $false
            $result.stateError = $_.Exception.Message
        }
    }
    Debug-Step 'state'

    $receiptDir = [string]$result.config.receiptDir
    if (-not $receiptDir) {
        $receiptDir = Join-Path ([string]$result.config.memoryRoot) '.longlive\session-watch\receipts'
    }
    if (Test-Path -LiteralPath $receiptDir -PathType Container) {
        $result.receipts = @(Get-ChildItem -LiteralPath $receiptDir -Filter '*.json' -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First ([Math]::Max(1, $ReceiptLimit)) |
            ForEach-Object {
                $body = $null
                try { $body = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json } catch { }
                [ordered]@{
                    file = $_.Name
                    bytes = $_.Length
                    at = $_.LastWriteTime.ToString('o')
                    mode = if ($body) { $body.mode } else { $null }
                    status = if ($body) { $body.status } else { $null }
                    wroteSession = if ($body) { $body.wroteSession } else { $null }
                    verificationOk = if ($body) { $body.verification.ok } else { $null }
                }
            })
    }
    Debug-Step 'receipts'

    $logPath = [string]$result.config.logPath
    if (-not $logPath) {
        $logPath = Join-Path ([string]$result.config.memoryRoot) '.longlive\logs\session-watch.log'
    }
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        # Get-Content attaches PSPath/PSParentPath/ReadCount note properties to each
        # string. ConvertTo-Json would serialize those as objects and can explode.
        # [string]::Copy returns a clean string with no note properties.
        $result.logTail = @(Get-Content -LiteralPath $logPath -Tail 10 | ForEach-Object { [string]::Copy($_) })
    }
}
Debug-Step 'log'
$result | ConvertTo-Json -Depth 10
Debug-Step 'serialized'
if ($result.ok) { exit 0 } else { exit 1 }
