#requires -Version 5.1
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RestArgs = @()
)
# Keep the historical $args contract: this script and its thin wrappers pass
# tokens such as --install / --status / --once through @args / $args.
$args = $RestArgs

<#
  resident-watcher.ps1 - install / uninstall / status / run / once

  Keeps the dsh-longlive "autoTruncate request" consumer alive without
  a human: a Scheduled Task (AtLogOn) starts watch-loop.ps1 in the interactive
  user session, where it can close the GUI app, cut the session log, verify it
  and start the app again.

  Usage (Windows PowerShell 5.1):
    powershell -NoProfile -ExecutionPolicy Bypass -File resident-watcher.ps1 --install
    powershell ... resident-watcher.ps1 --status
    powershell ... resident-watcher.ps1 --uninstall
    powershell ... resident-watcher.ps1 --run        (foreground loop)
    powershell ... resident-watcher.ps1 --once       (one poll cycle, for tests)

  Install options:
    --memory-root <path>   memory store that holds .longlive\logs (default: auto)
    --app-exe <path>       DeepSeek Harness.exe (default: running process / default install)
    --app-args <string>    arguments used when the watcher restarts the app
    --profile <name>       dsh profile name (default desktop)
    --task-name <name>     scheduled task name (default DshResidentWatcher)
    --no-start             register the task but do not start it now
    --json                 machine-readable output (status / install)
#>

$ErrorActionPreference = 'Stop'
$script:Root = $PSScriptRoot
$script:Version = '0.1.1'
$script:ConfigPath = Join-Path $script:Root 'config.json'
$script:LoopScript = Join-Path $script:Root 'watch-loop.ps1'
$script:StopFlag = Join-Path $script:Root 'state\stop.flag'
$script:OnceFlag = Join-Path $script:Root 'state\once.flag'
$script:LockPath = Join-Path $script:Root 'state\watcher.lock'
$script:StatePath = Join-Path $script:Root 'state\watcher-state.json'
$script:HeartbeatPath = Join-Path $script:Root 'state\heartbeat.json'
$script:TaskName = 'DshResidentWatcher'

function Write-Line {
    param([string]$Text = '')
    Write-Host $Text
}

function Get-OptValue {
    param($Table, [string]$Name, $Default = '')
    if ($Table.ContainsKey($Name) -and $Table[$Name]) { return $Table[$Name] }
    return $Default
}

function Resolve-MemoryRoot {
    param([string]$Explicit, [string]$Profile)
    if ($Explicit) { return $Explicit.TrimEnd('\', '/') }
    $patch = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\cordis.patch.yml"
    if (Test-Path -LiteralPath $patch) {
        $text = Get-Content -LiteralPath $patch -Raw -Encoding UTF8
        $m = [regex]::Match($text, '(?m)^\s*memoryRoot:\s*["'']?([^"''\r\n]+?)["'']?\s*$')
        if ($m.Success) {
            $candidate = $m.Groups[1].Value.Trim()
            if ($candidate) { return $candidate.TrimEnd('\', '/') }
        }
    }
    foreach ($candidate in @(
            (Join-Path $env:USERPROFILE 'dsh-memory'),
            (Join-Path $env:USERPROFILE '.dsh\longlive-memory'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate '.longlive') -PathType Container) {
            return $candidate.TrimEnd('\', '/')
        }
    }
    return (Join-Path $env:USERPROFILE 'dsh-memory')
}

function Find-AppExe {
    param([string]$Explicit)
    if ($Explicit -and (Test-Path -LiteralPath $Explicit -PathType Leaf)) { return $Explicit }
    try {
        $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p -and $p.Path -and (Test-Path -LiteralPath $p.Path -PathType Leaf)) { return $p.Path }
    } catch { }
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    return ''
}

function Find-AppArgs {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine -match '(--remote-debugging-port=\d+)') { return $Matches[1] }
        }
    } catch { }
    return ''
}

function Test-WatcherProcess {
    param([int]$ProcessId)
    if (-not $ProcessId) { return $null }
    try { return (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) } catch { return $null }
}

function Get-WatcherLock {
    if (-not (Test-Path -LiteralPath $script:LockPath)) { return $null }
    try { return (Get-Content -LiteralPath $script:LockPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Read-ConfigFile {
    if (-not (Test-Path -LiteralPath $script:ConfigPath -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Get-ConfigValue {
    param($Config, [string]$Name, $Default = $null)
    if ($null -eq $Config) { return $Default }
    $prop = $Config.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    if ($null -eq $prop.Value) { return $Default }
    return $prop.Value
}

# P2 root cause: the installed task is named after config.json's taskName
# (DshResidentWatcherAuto), but status used to query the hardcoded default
# DshResidentWatcher, so an existing running task showed up as task=null.
function Resolve-WatcherTaskName {
    param($Opts, $Config)
    $name = ''
    $source = ''
    if ($Opts -and $Opts.ContainsKey('taskName') -and $Opts['taskName']) {
        $name = [string]$Opts['taskName']
        $source = 'option'
    }
    if (-not $name) {
        $cfgName = [string](Get-ConfigValue $Config 'taskName' '')
        if ($cfgName) { $name = $cfgName; $source = 'config' }
    }
    if (-not $name) { $name = $script:TaskName; $source = 'default' }
    return [ordered]@{ name = $name; source = $source }
}

function Save-ConfigFile {
    param($Config)
    $Config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $script:ConfigPath -Encoding UTF8
}

function Wait-WatcherExit {
    param([int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $lock = Get-WatcherLock
        if ($null -eq $lock) { return $true }
        if (-not (Test-WatcherProcess ([int]$lock.pid))) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-WatcherStart {
    param([int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $lock = Get-WatcherLock
        if ($null -ne $lock -and (Test-WatcherProcess ([int]$lock.pid))) { return $lock }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Stop-RunningWatcher {
    param([int]$GraceSeconds = 90)
    $lock = Get-WatcherLock
    $wasRunning = $false
    if ($null -ne $lock -and (Test-WatcherProcess ([int]$lock.pid))) {
        $wasRunning = $true
        New-Item -ItemType Directory -Path (Join-Path $script:Root 'state') -Force | Out-Null
        Set-Content -LiteralPath $script:StopFlag -Value ('stop requested ' + (Get-Date).ToString('o')) -Encoding UTF8
        Write-Line "watcher pid $($lock.pid) is running; asking it to stop (grace ${GraceSeconds}s)"
        if (-not (Wait-WatcherExit $GraceSeconds)) {
            Write-Line 'watcher did not stop in time; forcing'
            try { Stop-Process -Id ([int]$lock.pid) -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
    Remove-Item -LiteralPath $script:StopFlag -Force -ErrorAction SilentlyContinue
    return $wasRunning
}

function Get-TaskInfo {
    param([string]$Name)

    # Accept both "Task" and "Folder\Task". Task names are unique per folder,
    # not globally, so try the exact path first and only then enumerate.
    $leafName = $Name
    $folder = ''
    $m = [regex]::Match($Name, '^(?<path>.+)\\(?<leaf>[^\\]+)$')
    if ($m.Success) {
        $folder = $m.Groups['path'].Value.TrimEnd('\') + '\'
        $leafName = $m.Groups['leaf'].Value
    }

    $task = $null
    try {
        if ($folder) {
            $task = Get-ScheduledTask -TaskName $leafName -TaskPath $folder -ErrorAction Stop
        } else {
            $task = Get-ScheduledTask -TaskName $leafName -ErrorAction Stop
        }
    } catch { $task = $null }
    if ($null -eq $task) {
        # Fallback for legacy/case-mismatched registrations: one enumeration
        # (195 tasks on this host) only when the direct lookup missed.
        try {
            $task = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $leafName }) | Select-Object -First 1
        } catch { $task = $null }
    }
    if ($null -eq $task) { return $null }
    $realName = [string]$task.TaskName
    $realPath = [string]$task.TaskPath
    if (-not $realPath) { $realPath = '\' }
    $info = $null
    try { $info = Get-ScheduledTaskInfo -TaskName $realName -TaskPath $realPath -ErrorAction Stop } catch { }
    $action = ''
    try { $action = (@($task.Actions) | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ; ' } catch { }
    $trigger = ''
    try { $trigger = (@($task.Triggers) | ForEach-Object { $_.CimClass.CimClassName }) -join ',' } catch { }
    return [ordered]@{
        name             = $realName
        taskPath         = $realPath
        state            = [string]$task.State
        enabled          = [bool]$task.Settings.Enabled
        runLevel         = [string]$task.Principal.RunLevel
        logonType        = [string]$task.Principal.LogonType
        userId           = [string]$task.Principal.UserId
        multipleInstances = [string]$task.Settings.MultipleInstances
        executionLimit   = [string]$task.Settings.ExecutionTimeLimit
        restartCount     = [int]$task.Settings.RestartCount
        restartInterval  = [string]$task.Settings.RestartInterval
        trigger          = $trigger
        action           = $action
        lastRunTime      = $(if ($info) { $info.LastRunTime.ToString('o') } else { '' })
        lastTaskResult   = $(if ($info) { $info.LastTaskResult } else { $null })
        nextRunTime      = $(if ($info -and $info.NextRunTime) { $info.NextRunTime.ToString('o') } else { '' })
        missedRuns       = $(if ($info) { $info.NumberOfMissedRuns } else { $null })
    }
}

function Get-StatusObject {
    param($Opts)
    $cfg = Read-ConfigFile
    $lock = Get-WatcherLock
    $hb = $null
    if (Test-Path -LiteralPath $script:HeartbeatPath) {
        try { $hb = Get-Content -LiteralPath $script:HeartbeatPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    $state = $null
    if (Test-Path -LiteralPath $script:StatePath) {
        try { $state = Get-Content -LiteralPath $script:StatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    $running = $false
    $pidValue = 0
    if ($null -ne $lock) {
        $pidValue = [int]$lock.pid
        $running = [bool](Test-WatcherProcess $pidValue)
    }
    $hbAge = $null
    if ($hb -and $hb.at) {
        try { $hbAge = [int]((Get-Date) - [datetime]::Parse([string]$hb.at)).TotalSeconds } catch { }
    }
    $requestExists = $false
    $requestAge = $null
    $requestId = ''
    $requestSession = ''
    $requestPath = ''
    if ($cfg) {
        $requestPath = [string](Get-ConfigValue $cfg 'requestPath' '')
        if (-not $requestPath) {
            $memoryRoot = [string](Get-ConfigValue $cfg 'memoryRoot' '')
            if (-not $memoryRoot) {
                $memoryRoot = Resolve-MemoryRoot -Explicit '' -Profile ([string](Get-ConfigValue $cfg 'profile' 'desktop'))
            }
            if ($memoryRoot) { $requestPath = Join-Path ($memoryRoot.TrimEnd('\', '/')) '.longlive\logs\auto-truncate.request.json' }
        }
    }
    if ($requestPath) {
        $requestExists = Test-Path -LiteralPath $requestPath -PathType Leaf
        if ($requestExists) {
            $fi = Get-Item -LiteralPath $requestPath
            $requestAge = [int]((Get-Date) - $fi.LastWriteTime).TotalSeconds
            try {
                $req = Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $requestId = [string]$req.requestId
                $requestSession = [string]$req.sessionPath
            } catch { }
        }
    }
    $lookup = Resolve-WatcherTaskName $Opts $cfg
    $task = Get-TaskInfo $lookup.name
    $taskLookup = [ordered]@{
        name     = $lookup.name
        source   = $lookup.source
        found    = ($null -ne $task)
        taskPath = $(if ($task) { [string]$task.taskPath } else { '' })
        error    = $(if ($null -ne $task) { '' } else { "scheduled task '$($lookup.name)' not found" })
    }
    $ok = $running -and ($null -ne $task) -and ($task.state -eq 'Ready' -or $task.state -eq 'Running')
    return [ordered]@{
        ok          = $ok
        version     = $script:Version
        generatedAt = (Get-Date).ToString('o')
        task        = $task
        taskLookup  = $taskLookup
        watcher     = [ordered]@{
            running            = $running
            pid                = $pidValue
            heartbeatAgeSeconds = $hbAge
            startedAt          = $(if ($lock) { [string]$lock.startedAt } else { '' })
            loop               = $(if ($hb) { $hb.loop } else { $null })
            lastStatus         = $(if ($hb) { [string]$hb.lastStatus } else { '' })
        }
        request     = [ordered]@{
            path       = $requestPath
            present    = $requestExists
            ageSeconds = $requestAge
            requestId  = $requestId
            sessionPath = $requestSession
            runnerPid  = $(if ($hb) { [string]$hb.runnerPid } else { '' })
        }
        state       = [ordered]@{
            lastRequestId = $(if ($state) { [string]$state.lastRequestId } else { '' })
            lastSuccessAt = $(if ($state) { [string]$state.lastSuccessAt } else { '' })
            lastStatus    = $(if ($state) { [string]$state.lastStatus } else { '' })
            totals        = $(if ($state) { $state.totals } else { $null })
        }
        config      = [ordered]@{
            path       = $script:ConfigPath
            exists     = [bool]$cfg
            memoryRoot = $(if ($cfg) { [string]$cfg.memoryRoot } else { '' })
            appExe     = $(if ($cfg) { [string]$cfg.appExe } else { '' })
            appArgs    = $(if ($cfg) { [string]$cfg.appArgs } else { '' })
            profile    = $(if ($cfg) { [string]$cfg.profile } else { '' })
            taskName   = $(if ($cfg) { [string](Get-ConfigValue $cfg 'taskName' '') } else { '' })
        }
        paths       = [ordered]@{
            root      = $script:Root
            log       = (Join-Path $script:Root 'logs\watcher.log')
            state     = $script:StatePath
            archive   = (Join-Path $script:Root 'archive\requests')
            quarantine = (Join-Path $script:Root 'quarantine')
        }
    }
}

function Show-StatusText {
    param($S)
    Write-Line "resident-watcher $($S.version)  ok=$($S.ok)"
    if ($S.task) {
        Write-Line "task: $($S.task.name) state=$($S.task.state) lastResult=$($S.task.lastTaskResult) lastRun=$($S.task.lastRunTime) missed=$($S.task.missedRuns)"
        Write-Line "task: logonType=$($S.task.logonType) runLevel=$($S.task.runLevel) multipleInstances=$($S.task.multipleInstances) executionLimit=$($S.task.executionLimit) restart=$($S.task.restartCount)/$($S.task.restartInterval)"
        Write-Line "task action: $($S.task.action)"
    } else {
        Write-Line "task: $($S.taskLookup.name) NOT INSTALLED (looked up by $($S.taskLookup.source); path=$($S.taskLookup.taskPath))"
    }
    Write-Line "watcher: running=$($S.watcher.running) pid=$($S.watcher.pid) heartbeatAge=$($S.watcher.heartbeatAgeSeconds)s loop=$($S.watcher.loop) lastStatus=$($S.watcher.lastStatus)"
    Write-Line "request: present=$($S.request.present) age=$($S.request.ageSeconds)s id=$($S.request.requestId) runnerPid=$($S.request.runnerPid)"
    if ($S.request.path) { Write-Line "request path: $($S.request.path)" }
    if ($S.state.totals) {
        Write-Line "totals: detected=$($S.state.totals.detected) succeeded=$($S.state.totals.succeeded) failed=$($S.state.totals.failed) quarantined=$($S.state.totals.quarantined) stale=$($S.state.totals.stale) duplicateFailed=$($S.state.totals.duplicateFailed)"
    }
    Write-Line "lastSuccess: $($S.state.lastSuccessAt)  lastRequest: $($S.state.lastRequestId)"
    if ($S.config.exists) { Write-Line "config: $($S.config.path) memoryRoot=$($S.config.memoryRoot) app=$($S.config.appExe) args=[$($S.config.appArgs)]" }
    else { Write-Line "config: MISSING ($($S.config.path))" }
    if (Test-Path -LiteralPath $S.paths.log) {
        Write-Line 'recent log:'
        Get-Content -LiteralPath $S.paths.log -Tail 5 -Encoding UTF8 | ForEach-Object { Write-Line "  $_" }
    }
}

function Invoke-Install {
    param($Opts, $RawArgs)
    Write-Line "resident-watcher $($script:Version) install"

    $existing = Read-ConfigFile
    $profile = [string](Get-OptValue $Opts 'profile' $(if ($existing) { [string]$existing.profile } else { 'desktop' }))
    if (-not $profile) { $profile = 'desktop' }
    $memoryRoot = [string](Get-OptValue $Opts 'memoryRoot' $(if ($existing) { [string]$existing.memoryRoot } else { '' }))
    $memoryRoot = Resolve-MemoryRoot -Explicit $memoryRoot -Profile $profile
    $memoryRoot = $memoryRoot.TrimEnd('\', '/')

    if ($memoryRoot -match '^[Hh]:\\') {
        Write-Line 'REFUSING: memoryRoot resolves to a protected real-machine memory store.'
        Write-Line 'Pass an explicit disposable --memory-root for experiments.'
        return 2
    }

    $appExe = [string](Get-OptValue $Opts 'appExe' $(if ($existing) { [string]$existing.appExe } else { '' }))
    if (-not $appExe -or -not (Test-Path -LiteralPath $appExe -PathType Leaf)) { $appExe = Find-AppExe $appExe }
    if (-not $appExe) {
        Write-Line 'ERROR: cannot find "DeepSeek Harness.exe"; pass --app-exe <path>'
        return 2
    }
    $appArgs = [string](Get-OptValue $Opts 'appArgs' '')
    if (-not $appArgs -and -not $Opts.ContainsKey('appArgs')) {
        if ($existing -and $existing.appArgs) { $appArgs = [string]$existing.appArgs } else { $appArgs = Find-AppArgs }
    }
    $taskName = [string](Get-OptValue $Opts 'taskName' $(if ($existing -and $existing.taskName) { [string]$existing.taskName } else { $script:TaskName }))
    $script:TaskName = $taskName

    $runnerPath = Join-Path $script:Root 'lib\auto-truncate-run.ps1'
    if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
        Write-Line "ERROR: runner missing: $runnerPath"
        return 2
    }
    if (-not (Test-Path -LiteralPath (Join-Path $memoryRoot '.longlive') -PathType Container)) {
        Write-Line "WARN: $memoryRoot\.longlive does not exist yet; the plugin creates it on first request"
    }

    New-Item -ItemType Directory -Path (Join-Path $script:Root 'logs') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $script:Root 'state') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $script:Root 'archive\requests') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $script:Root 'quarantine') -Force | Out-Null

    $cfg = [ordered]@{
        version             = 1
        memoryRoot          = $memoryRoot
        requestPath         = (Join-Path $memoryRoot '.longlive\logs\auto-truncate.request.json')
        appExe              = $appExe
        appArgs             = $appArgs
        processName         = 'DeepSeek Harness'
        profile             = $profile
        runnerPath          = $runnerPath
        runnerLogDir        = (Join-Path $memoryRoot '.longlive\logs')
        pollSeconds         = [int](Get-OptValue $Opts 'pollSeconds' 2)
        requestSettleSeconds = [int](Get-OptValue $Opts 'settleSeconds' 5)
        cooldownSeconds     = 90
        maxAttempts         = 2
        retryDelaySeconds   = 30
        logMaxBytes         = 5242880
        logKeep             = 3
        taskName            = $taskName
    }
    Save-ConfigFile $cfg
    Write-Line "config: $script:ConfigPath"
    Write-Line "memoryRoot: $memoryRoot"
    Write-Line "appExe: $appExe"
    Write-Line "appArgs: [$appArgs]"

    # replace a running watcher cleanly
    $old = Get-TaskInfo $taskName
    if ($old -and $old.state -eq 'Running') {
        Write-Line 'stopping the previous task instance'
        try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
    }
    Stop-RunningWatcher -GraceSeconds 90 | Out-Null

    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $ps)) { $ps = 'powershell.exe' }
    $actionArg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script:LoopScript`" -Config `"$script:ConfigPath`""
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $registered = $false
    $regMode = ''
    try {
        $action = New-ScheduledTaskAction -Execute $ps -Argument $actionArg -WorkingDirectory $script:Root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
            -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
            -Principal $principal -Description 'Resident watcher: consumes dsh-longlive autoTruncate requests (close/cut/verify/restart).' `
            -Force | Out-Null
        $registered = $true
        $regMode = 'Register-ScheduledTask'
    } catch {
        Write-Line "Register-ScheduledTask failed: $($_.Exception.Message)"
        Write-Line 'falling back to schtasks /SC ONLOGON'
        $tr = "$ps $actionArg"
        $out = & schtasks.exe /Create /TN $taskName /TR $tr /SC ONLOGON /RL LIMITED /F 2>&1
        $code = $LASTEXITCODE
        Write-Line "schtasks exit=$code $($out | Out-String)".Trim()
        if ($code -eq 0) { $registered = $true; $regMode = 'schtasks ONLOGON' }
    }
    if (-not $registered) {
        Write-Line 'ERROR: task registration failed (need an interactive logon task; run as the desktop user)'
        return 1
    }

    Remove-Item -LiteralPath $script:StopFlag -Force -ErrorAction SilentlyContinue
    $started = $false
    if (-not $RawArgs.Contains('--no-start')) {
        try {
            Start-ScheduledTask -TaskName $taskName
            $lock = Wait-WatcherStart -TimeoutSeconds 20
            $started = ($null -ne $lock)
        } catch {
            Write-Line "start failed: $($_.Exception.Message)"
        }
    }

    $status = Get-StatusObject
    Write-Line "task registered via $regMode"
    Write-Line "watcher started: $started pid=$($status.watcher.pid)"
    Write-Line "status: $($status.ok)  log: $($status.paths.log)"
    if ($RawArgs.Contains('--json')) { $status | ConvertTo-Json -Depth 12 }
    if (-not $started) {
        Write-Line 'WARN: watcher did not report a heartbeat within 20s; run --status and check logs\watcher.log'
        return 1
    }
    return 0
}

function Invoke-Uninstall {
    param($Opts, $RawArgs)
    Write-Line "resident-watcher $($script:Version) uninstall"
    $cfg = Read-ConfigFile
    $taskName = [string](Get-OptValue $Opts 'taskName' $(if ($cfg -and $cfg.taskName) { [string]$cfg.taskName } else { $script:TaskName }))
    $script:TaskName = $taskName

    $task = Get-TaskInfo $taskName
    if ($task -and $task.state -eq 'Running') {
        Write-Line "task $taskName is running; stopping via stop.flag first"
    }
    $stopped = Stop-RunningWatcher -GraceSeconds 120
    if ($task) {
        try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
        try {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
            Write-Line "task removed: $taskName"
        } catch {
            Write-Line "ERROR: could not remove task ${taskName}: $($_.Exception.Message)"
        }
    } else {
        Write-Line "task not present: $taskName"
    }

    # anything still alive?
    $lock = Get-WatcherLock
    if ($null -ne $lock -and (Test-WatcherProcess ([int]$lock.pid))) {
        Write-Line "watcher pid $($lock.pid) still alive, killing"
        try { Stop-Process -Id ([int]$lock.pid) -Force -ErrorAction SilentlyContinue } catch { }
    }
    Remove-Item -LiteralPath $script:LockPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:StopFlag -Force -ErrorAction SilentlyContinue
    Write-Line "watcher was running: $stopped"

    if ($Opts.ContainsKey('purge') -and $Opts['purge']) {
        foreach ($d in @('logs', 'state', 'archive', 'quarantine')) {
            $p = Join-Path $script:Root $d
            if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
        }
        Remove-Item -LiteralPath $script:ConfigPath -Force -ErrorAction SilentlyContinue
        Write-Line 'purged logs/state/archive/quarantine/config.json (code kept)'
    } else {
        Write-Line "kept evidence: $script:Root\logs, archive, quarantine (use --purge to remove)"
    }
    return 0
}

function Invoke-Run {
    param([switch]$Once)
    if ($Once) {
        New-Item -ItemType Directory -Path (Join-Path $script:Root 'state') -Force | Out-Null
        Set-Content -LiteralPath $script:OnceFlag -Value 'once' -Encoding UTF8
        $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
            -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$script:LoopScript`" -Config `"$script:ConfigPath`"" `
            -PassThru -Wait -NoNewWindow
        Remove-Item -LiteralPath $script:OnceFlag -Force -ErrorAction SilentlyContinue
        return [int]$p.ExitCode
    }
    & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $script:LoopScript -Config $script:ConfigPath
    return [int]$LASTEXITCODE
}

# ---------------------------------------------------------------------------
# argument parsing (Windows PowerShell would bind --install as a parameter,
# so the CLI parses $args by hand)
# ---------------------------------------------------------------------------
$action = ''
$opts = @{}
$raw = @()
$i = 0
while ($i -lt $args.Count) {
    $tok = [string]$args[$i]
    $raw += $tok
    $key = ([string]$args[$i]).ToLowerInvariant().TrimStart('-', '/')
    switch ($key) {
        'install' { $action = 'install' }
        'uninstall' { $action = 'uninstall' }
        'status' { $action = 'status' }
        'run' { $action = 'run' }
        'once' { $action = 'once' }
        'help' { $action = 'help' }
        'h' { $action = 'help' }
        'no-start' { $opts['noStart'] = $true }
        'nostart' { $opts['noStart'] = $true }
        'purge' { $opts['purge'] = $true }
        'json' { $opts['json'] = $true }
        'memory-root' { $i++; $opts['memoryRoot'] = [string]$args[$i] }
        'memoryroot' { $i++; $opts['memoryRoot'] = [string]$args[$i] }
        'app-exe' { $i++; $opts['appExe'] = [string]$args[$i] }
        'appexe' { $i++; $opts['appExe'] = [string]$args[$i] }
        'app-args' { $i++; $opts['appArgs'] = [string]$args[$i] }
        'appargs' { $i++; $opts['appArgs'] = [string]$args[$i] }
        'profile' { $i++; $opts['profile'] = [string]$args[$i] }
        'task-name' { $i++; $opts['taskName'] = [string]$args[$i] }
        'taskname' { $i++; $opts['taskName'] = [string]$args[$i] }
        'poll-seconds' { $i++; $opts['pollSeconds'] = [string]$args[$i] }
        'pollseconds' { $i++; $opts['pollSeconds'] = [string]$args[$i] }
        default {
            if ($tok.StartsWith('-') -or $tok.StartsWith('/')) {
                Write-Line "unknown argument: $tok (try --help)"
                exit 2
            }
        }
    }
    $i++
}

$rawText = $raw -join ' '
switch ($action) {
    'install' { exit (Invoke-Install -Opts $opts -RawArgs $rawText) }
    'uninstall' { exit (Invoke-Uninstall -Opts $opts -RawArgs $rawText) }
    'status' {
        $s = Get-StatusObject -Opts $opts
        if ($opts.ContainsKey('json') -and $opts['json']) { $s | ConvertTo-Json -Depth 12 }
        else { Show-StatusText $s }
        if ($s.ok) { exit 0 } else { exit 1 }
    }
    'run' { exit (Invoke-Run) }
    'once' { exit (Invoke-Run -Once) }
    default {
        Write-Line 'resident-watcher.ps1 - resident watcher for dsh-longlive autoTruncate'
        Write-Line ''
        Write-Line '  --install [--memory-root P] [--app-exe P] [--app-args S] [--profile N] [--task-name N] [--no-start]'
        Write-Line '  --uninstall [--purge]'
        Write-Line '  --status [--json] [--task-name N]'
        Write-Line '  --run | --once'
        exit 0
    }
}
