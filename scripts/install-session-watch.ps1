#Requires -Version 5.1
<#
.SYNOPSIS
  Install the resident session watchdog as a per-user scheduled task.

.DESCRIPTION
  Copies the watchdog, the truncate CLI and src/ into an install directory,
  writes session-watch.config.json, validates it with `session-watch.mjs
  --check`, and registers a Task Scheduler task that runs

      <node> <install>\scripts\session-watch.mjs --config <config> --loop

  at logon. The watchdog is a separate process tree: it never loads the DSH
  host, never closes/starts the GUI, and a failed tick is only a log line.

  This script changes Task Scheduler, which is a high-impact action on a real
  machine. It is safe to dry-run first:
      powershell -NoProfile -File install-session-watch.ps1 -DryRun

  All paths that end up in the scheduled-task command line must be ASCII
  (7-bit). That is deliberate: schtasks quoting is fragile around non-ASCII
  paths, and a task that silently fails to start is worse than a rejected
  install.

.PARAMETER InstallDir
  Default: %LOCALAPPDATA%\dsh-session-watch. Must be ASCII.

.PARAMETER Mode
  dryrun (default) or request. The mode can be overridden later by the profile's
  autoTruncate block when -ProfileConfig is used.

.PARAMETER Enabled
  Initial kill switch. Default true; set false to stage the task inert.

.PARAMETER ProfileConfig
  Optional path to cordis.patch.yml. When set, the watcher re-reads its
  autoTruncate block on every wake-up; that block owns enabled/mode/thresholds.

.PARAMETER DryRun
  Validate and print the exact plan; write nothing, register nothing.

.PARAMETER NoRegister
  Copy files and write config, but do not create the scheduled task.

.PARAMETER NoStart
  Register but do not start the task now.

.PARAMETER Force
  Overwrite an existing install directory and task.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'dsh-session-watch'),
    [ValidateSet('dryrun', 'request')]
    [string]$Mode = 'dryrun',
    [bool]$Enabled = $true,
    [string]$TaskName = 'DshSessionWatch',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$SessionsRoot = '',
    [string]$MemoryRoot = '',
    [string]$ProfileConfig = '',
    [string]$NodeExe = '',
    [int]$IntervalSeconds = 300,
    [switch]$DryRun,
    [switch]$NoRegister,
    [switch]$NoStart,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$script:StartedAt = Get-Date

function Fail([string]$Message) {
    throw "install-session-watch: $Message"
}

function Test-AsciiPath([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value)) { Fail "$Label is empty" }
    if ($Value -notmatch '^[\x20-\x7E]+$') {
        Fail "$Label must be pure ASCII for schtasks, got: $Value"
    }
    return $Value
}

function Resolve-FullPath([string]$Value, [string]$Base) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $Base $Value))
}

function Write-JsonFile([string]$Path, $Value) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $json = $Value | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-Node([string]$Node, [string]$ScriptPath) {
    $output = & $Node --check $ScriptPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail "node --check failed for $ScriptPath`n$output"
    }
}

# --- resolve and validate paths -------------------------------------------------
$repo = Split-Path -Parent $PSScriptRoot
$sourceWatch = Join-Path $PSScriptRoot 'session-watch.mjs'
$sourceCli = Join-Path $PSScriptRoot 'truncate-cli.mjs'
$sourceSrc = Join-Path $repo 'src'
$sourcePkg = Join-Path $repo 'package.json'
foreach ($required in @($sourceWatch, $sourceCli, $sourcePkg)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "source file missing: $required" }
}
if (-not (Test-Path -LiteralPath $sourceSrc -PathType Container)) { Fail "source directory missing: $sourceSrc" }

$install = Resolve-FullPath $InstallDir (Get-Location).Path
$dsh = Resolve-FullPath $DshHome (Get-Location).Path
if (-not $SessionsRoot) { $SessionsRoot = Join-Path $dsh 'sessions' }
$sessions = Resolve-FullPath $SessionsRoot (Get-Location).Path
# An explicit sessions root is the strongest signal of the DSH home; without
# this, `-SessionsRoot <fixture>` would pair a fake sessions tree with the real
# ~/.dsh and the installed watcher would hand the CLI a contradictory DSH_HOME.
if ($PSBoundParameters.ContainsKey('SessionsRoot') -and -not $PSBoundParameters.ContainsKey('DshHome')) {
    $parent = Split-Path -Parent $sessions
    if ($parent) { $dsh = $parent }
}
if (-not $MemoryRoot) {
    if ($env:DSH_MEM) { $MemoryRoot = $env:DSH_MEM }
    else { $MemoryRoot = Join-Path $dsh 'longlive-memory' }
}
$memory = Resolve-FullPath $MemoryRoot (Get-Location).Path
if ($ProfileConfig) { $ProfileConfig = Resolve-FullPath $ProfileConfig (Get-Location).Path }

if (-not $NodeExe) {
    $candidate = Join-Path $dsh 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $NodeExe = $candidate }
    else {
        $command = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $command) { Fail 'node.exe not found; pass -NodeExe' }
        $NodeExe = $command.Source
    }
}
$node = Resolve-FullPath $NodeExe (Get-Location).Path
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Fail "node executable missing: $node" }

$configPath = Join-Path $install 'session-watch.config.json'
$watchPath = Join-Path $install 'scripts\session-watch.mjs'
$cliPath = Join-Path $install 'scripts\truncate-cli.mjs'

$asciiChecks = @(
    @{ Value = $install; Label = 'InstallDir' },
    @{ Value = $node; Label = 'NodeExe' },
    @{ Value = $configPath; Label = 'config path' },
    @{ Value = $watchPath; Label = 'watcher path' },
    @{ Value = $TaskName; Label = 'TaskName' }
)
foreach ($entry in $asciiChecks) { [void](Test-AsciiPath $entry.Value $entry.Label) }
if ($ProfileConfig -and $ProfileConfig -notmatch '^[\x20-\x7E]+$') {
    Fail "ProfileConfig must be ASCII because it is stored in config.json and read by the task process: $ProfileConfig"
}
if (-not (Test-Path -LiteralPath $sessions -PathType Container)) {
    Fail "SessionsRoot does not exist: $sessions (this script does not guess a real DSH home)"
}
if (-not (Test-Path -LiteralPath $memory -PathType Container)) {
    Fail "MemoryRoot does not exist: $memory (create it, or pass -MemoryRoot)"
}
if ($ProfileConfig -and -not (Test-Path -LiteralPath $ProfileConfig -PathType Leaf)) {
    Fail "ProfileConfig does not exist: $ProfileConfig"
}
if ($IntervalSeconds -lt 1) { Fail 'IntervalSeconds must be >= 1' }

$taskCommand = "`"$node`" `"$watchPath`" --config `"$configPath`" --loop"
$plan = [ordered]@{
    ok = $true
    dryRun = [bool]$DryRun
    installDir = $install
    configPath = $configPath
    watcher = $watchPath
    cli = $cliPath
    nodeExe = $node
    memoryRoot = $memory
    sessionsRoot = $sessions
    dshHome = $dsh
    profileConfig = $ProfileConfig
    mode = $Mode
    enabled = $Enabled
    intervalSeconds = $IntervalSeconds
    taskName = $TaskName
    taskCommand = $taskCommand
    copyFrom = $repo
    startedAt = $script:StartedAt.ToString('o')
}

if ($DryRun) {
    $plan['registered'] = $false
    $plan['started'] = $false
    $plan['note'] = 'dry run: no file was written and no task was registered'
    $plan | ConvertTo-Json -Depth 6
    exit 0
}

# --- guard existing install -----------------------------------------------------
if ((Test-Path -LiteralPath $install -PathType Container) -and -not $Force) {
    $existing = @(Get-ChildItem -LiteralPath $install -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        Fail "install directory is not empty: $install (pass -Force to update in place)"
    }
}
New-Item -ItemType Directory -Path $install -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $install 'scripts') -Force | Out-Null

# --- copy runtime --------------------------------------------------------------
Copy-Item -LiteralPath $sourceWatch -Destination (Join-Path $install 'scripts\session-watch.mjs') -Force
Copy-Item -LiteralPath $sourceCli -Destination (Join-Path $install 'scripts\truncate-cli.mjs') -Force
Copy-Item -LiteralPath $sourcePkg -Destination (Join-Path $install 'package.json') -Force

$libSource = Join-Path $PSScriptRoot 'lib'
if (Test-Path -LiteralPath $libSource -PathType Container) {
    $libDest = Join-Path $install 'scripts\lib'
    New-Item -ItemType Directory -Path $libDest -Force | Out-Null
    Get-ChildItem -LiteralPath $libSource -File | Copy-Item -Destination $libDest -Force
}
$srcDest = Join-Path $install 'src'
if (Test-Path -LiteralPath $srcDest) { Remove-Item -LiteralPath $srcDest -Recurse -Force }
Copy-Item -LiteralPath $sourceSrc -Destination $srcDest -Recurse -Force
$docsSource = Join-Path $repo 'docs\SESSION-WATCH.md'
if (Test-Path -LiteralPath $docsSource -PathType Leaf) {
    New-Item -ItemType Directory -Path (Join-Path $install 'docs') -Force | Out-Null
    Copy-Item -LiteralPath $docsSource -Destination (Join-Path $install 'docs\SESSION-WATCH.md') -Force
}
# Keep the operator entry points beside the runtime so the install can be
# inspected/removed without remembering the original package directory.
foreach ($name in @('session-watch-status.ps1', 'uninstall-session-watch.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $install ('scripts\' + $name)) -Force
}

# --- config --------------------------------------------------------------------
$config = [ordered]@{
    version = 1
    enabled = $Enabled
    mode = $Mode
    intervalSeconds = $IntervalSeconds
    settleSeconds = 10
    tokensThreshold = 300000
    minTurns = 12
    bytesThreshold = 0
    eventsThreshold = 0
    keepTurns = 12
    keepTokens = 80000
    firstUserCapChars = 4000
    boundaryRetries = 3
    cooldownMinutes = 60
    profileConfig = $ProfileConfig
    memoryRoot = $memory
    sessionsRoot = $sessions
    dshHome = $dsh
    nodeExe = $node
    cliPath = $cliPath
    scanMaxFiles = 500
    cliTimeoutSeconds = 600
    taskName = $TaskName
    installDir = $install
}
Write-JsonFile $configPath $config
Write-JsonFile (Join-Path $install 'install-manifest.json') ([ordered]@{
    version = 1
    installedAt = (Get-Date).ToString('o')
    source = $repo
    taskName = $TaskName
    taskCommand = $taskCommand
    files = @(
        'scripts\session-watch.mjs',
        'scripts\truncate-cli.mjs',
        'scripts\session-watch-status.ps1',
        'scripts\uninstall-session-watch.ps1',
        'src\',
        'package.json',
        'session-watch.config.json'
    )
})

# --- validate the copied install ------------------------------------------------
Test-Node $node $watchPath
Test-Node $node $cliPath
$checkOutput = & $node $watchPath --config $configPath --check 2>&1
if ($LASTEXITCODE -ne 0) { Fail "watcher --check failed:`n$($checkOutput -join "`n")" }
try { $check = ($checkOutput -join "`n") | ConvertFrom-Json } catch { Fail "watcher --check did not return JSON:`n$($checkOutput -join "`n")" }
if (-not $check.ok) { Fail "watcher --check reported not-ok:`n$($checkOutput -join "`n")" }

# --- scheduled task -------------------------------------------------------------
$registered = $false
$registerMethod = $null
if (-not $NoRegister) {
    $argument = "--config `"$configPath`" --loop"
    $action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $install
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
            -Description 'DSH session watchdog: threshold-driven visible truncation, separate process tree.' -Force | Out-Null
        $registered = $true
        $registerMethod = 'Register-ScheduledTask'
    } catch {
        $fallback = "`"$node`" `"$watchPath`" --config `"$configPath`" --loop"
        & schtasks.exe /Create /TN $TaskName /SC ONLOGON /RL LIMITED /TR $fallback /F 2>&1 | ForEach-Object { Write-Verbose $_ }
        if ($LASTEXITCODE -ne 0) { Fail 'both Register-ScheduledTask and schtasks /Create failed' }
        $registered = $true
        $registerMethod = 'schtasks.exe'
    }
}

$started = $false
if ($registered -and -not $NoStart) {
    try {
        Start-ScheduledTask -TaskName $TaskName
        $started = $true
    } catch {
        & schtasks.exe /Run /TN $TaskName 2>&1 | ForEach-Object { Write-Verbose $_ }
        if ($LASTEXITCODE -eq 0) { $started = $true }
    }
}

$plan['registered'] = $registered
$plan['registerMethod'] = $registerMethod
$plan['started'] = $started
$plan['validated'] = $true
$plan['finishedAt'] = (Get-Date).ToString('o')
$plan | ConvertTo-Json -Depth 6
exit 0
