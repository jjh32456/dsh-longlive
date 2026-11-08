#requires -Version 5.1
<#
  watch-loop.ps1 - resident watcher for dsh-longlive autoTruncate.

  The plugin's "request" mode only publishes
    <memoryRoot>\.longlive\logs\auto-truncate.request.json
  and never touches the session. This loop is the resident consumer:

    poll request file -> archive evidence -> run auto-truncate-run.ps1
    (close app, cut visible log, verify, restart app) -> record result

  Properties:
    * single instance: named mutex + state\watcher.lock (pid/heartbeat)
    * request parsing tolerates a half-written file (writer is atomic, but the
      watcher still retries and then quarantines instead of crashing)
    * failures keep evidence: archive\requests\<stamp>-<id>\ (request + runner
      stdout/stderr + result json + evidence json)
    * corrupt/stale/permanently-failed requests move to quarantine\
    * log rotation: logs\watcher.log, 5 MB per file, 3 files total
    * stale post-success requests are not executed twice

  Exit codes: 0 stopped by stop.flag / another instance owns the mutex,
              1 fatal error (Task Scheduler restarts the task),
              2 bad config.
#>
param(
    [string]$Config = '',
    # data root for logs/state/archive; defaults to the package directory.
    # Tests pass a sandbox here so they never mix evidence with production.
    [string]$DataRoot = ''
)

$ErrorActionPreference = 'Stop'
$script:Root = if ($DataRoot) { $DataRoot } else { $PSScriptRoot }
$script:Version = '0.1.1'
# request states that must never be executed again: a replayed request with one
# of these states is quarantined instead of starting the runner a second time.
$script:TerminalStatuses = @('done', 'recovered', 'restart-failed', 'failed', 'request-stuck')
$script:LogPath = Join-Path $script:Root 'logs\watcher.log'
$script:StatePath = Join-Path $script:Root 'state\watcher-state.json'
$script:HeartbeatPath = Join-Path $script:Root 'state\heartbeat.json'
$script:LockPath = Join-Path $script:Root 'state\watcher.lock'
$script:StopFlag = Join-Path $script:Root 'state\stop.flag'
$script:OnceFlag = Join-Path $script:Root 'state\once.flag'
$script:StartedAt = (Get-Date)

function Write-WLog {
    param([string]$Level, [string]$Message)
    try {
        if (Test-Path -LiteralPath $script:LogPath) {
            $len = (Get-Item -LiteralPath $script:LogPath).Length
            if ($len -ge [int64]$script:Cfg.logMaxBytes) { Rotate-Log }
        }
        $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
        $line = "[$ts] [$Level] [pid=$PID] $Message"
        Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
        Write-Host $line
    } catch {
        # logging must never take the watcher down
    }
}

function Rotate-Log {
    try {
        $keep = [int]$script:Cfg.logKeep
        if ($keep -lt 1) { $keep = 3 }
        for ($i = $keep - 1; $i -ge 1; $i--) {
            $src = "$($script:LogPath).$i"
            if (-not (Test-Path -LiteralPath $src)) { continue }
            $dst = "$($script:LogPath).$($i + 1)"
            if ($i + 1 -ge $keep) {
                Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
            } else {
                Move-Item -LiteralPath $src -Destination $dst -Force -ErrorAction SilentlyContinue
            }
        }
        if (Test-Path -LiteralPath $script:LogPath) {
            Move-Item -LiteralPath $script:LogPath -Destination "$($script:LogPath).1" -Force
        }
    } catch {
        # rotation is best effort
    }
}

function Get-CfgValue {
    param($Object, [string]$Name, $Default)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
    if ($prop.Value -is [string] -and $prop.Value -eq '') { return $Default }
    return $prop.Value
}

function Read-WatcherConfig {
    param([string]$Path)
    if (-not $Path) { $Path = Join-Path $script:Root 'config.json' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Write-WLog 'ERROR' "config not found: $Path (run --install first)"
        return $null
    }
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $j = $raw | ConvertFrom-Json
    $memoryRoot = [string](Get-CfgValue $j 'memoryRoot' '')
    if (-not $memoryRoot) {
        Write-WLog 'ERROR' "config has no memoryRoot: $Path"
        return $null
    }
    $memoryRoot = $memoryRoot.TrimEnd('\', '/')
    $requestPath = [string](Get-CfgValue $j 'requestPath' '')
    if (-not $requestPath) {
        $requestPath = Join-Path $memoryRoot '.longlive\logs\auto-truncate.request.json'
    }
    $cfg = [ordered]@{
        version         = [int](Get-CfgValue $j 'version' 1)
        memoryRoot      = $memoryRoot
        requestPath     = $requestPath
        appExe          = [string](Get-CfgValue $j 'appExe' '')
        appArgs         = [string](Get-CfgValue $j 'appArgs' '')
        processName     = [string](Get-CfgValue $j 'processName' 'DeepSeek Harness')
        profile         = [string](Get-CfgValue $j 'profile' 'desktop')
        runnerPath      = [string](Get-CfgValue $j 'runnerPath' (Join-Path $script:Root 'lib\auto-truncate-run.ps1'))
        runnerLogDir    = [string](Get-CfgValue $j 'runnerLogDir' (Join-Path $memoryRoot '.longlive\logs'))
        pollSeconds     = [int](Get-CfgValue $j 'pollSeconds' 2)
        requestSettle   = [int](Get-CfgValue $j 'requestSettleSeconds' 5)
        cooldownSeconds = [int](Get-CfgValue $j 'cooldownSeconds' 90)
        maxAttempts     = [int](Get-CfgValue $j 'maxAttempts' 2)
        retryDelay      = [int](Get-CfgValue $j 'retryDelaySeconds' 30)
        logMaxBytes     = [int64](Get-CfgValue $j 'logMaxBytes' 5242880)
        logKeep         = [int](Get-CfgValue $j 'logKeep' 3)
        taskName        = [string](Get-CfgValue $j 'taskName' 'DshResidentWatcher')
    }
    if ($cfg.pollSeconds -lt 1) { $cfg.pollSeconds = 1 }
    if ($cfg.logKeep -lt 1) { $cfg.logKeep = 3 }
    if ($cfg.logMaxBytes -lt 65536) { $cfg.logMaxBytes = 5242880 }
    return $cfg
}

function Save-JsonFile {
    param([string]$Path, $Value)
    $tmp = "$Path.tmp-$PID"
    $json = $Value | ConvertTo-Json -Depth 12
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Read-State {
    $state = [ordered]@{
        version        = 1
        createdAt      = (Get-Date).ToString('o')
        lastRequestId  = ''
        lastSuccessAt  = ''
        lastStatus     = ''
        nextAttemptAt  = ''
        totals         = @{ detected = 0; succeeded = 0; failed = 0; quarantined = 0; stale = 0; duplicateFailed = 0 }
        requests       = @{}
    }
    if (Test-Path -LiteralPath $script:StatePath) {
        try {
            $j = Get-Content -LiteralPath $script:StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($name in @('lastRequestId', 'lastSuccessAt', 'lastStatus', 'nextAttemptAt')) {
                if ($null -ne $j.PSObject.Properties[$name] -and $null -ne $j.$name) { $state[$name] = [string]$j.$name }
            }
            foreach ($name in @('detected', 'succeeded', 'failed', 'quarantined', 'stale', 'duplicateFailed')) {
                if ($null -ne $j.totals -and $null -ne $j.totals.PSObject.Properties[$name]) {
                    $state.totals[$name] = [int]$j.totals.$name
                }
            }
            if ($null -ne $j.requests) {
                foreach ($prop in $j.requests.PSObject.Properties) {
                    $state.requests[$prop.Name] = $prop.Value
                }
            }
        } catch {
            Write-WLog 'WARN' "state file unreadable, starting fresh: $($_.Exception.Message)"
        }
    }
    return $state
}

function Save-State {
    param($State)
    # keep the request journal bounded (oldest by .at first)
    if ($State.requests.Count -gt 100) {
        $ordered = $State.requests.GetEnumerator() | Sort-Object { [string]$_.Value.at }
        $drop = $ordered | Select-Object -First ($State.requests.Count - 100)
        foreach ($entry in $drop) { [void]$State.requests.Remove($entry.Key) }
    }
    Save-JsonFile $script:StatePath $State
}

function Write-Heartbeat {
    param($State, [int]$Loop, [string]$RunnerPid = '')
    try {
        $hb = [ordered]@{
            at            = (Get-Date).ToString('o')
            pid           = $PID
            startedAt     = $script:StartedAt.ToString('o')
            loop          = $Loop
            version       = $script:Version
            config        = (Join-Path $script:Root 'config.json')
            requestExists = (Test-Path -LiteralPath $script:Cfg.requestPath -PathType Leaf)
            lastStatus    = [string]$State.lastStatus
            runnerPid     = $RunnerPid
        }
        Save-JsonFile $script:HeartbeatPath $hb
    } catch {
        # heartbeat is advisory only
    }
}

function Get-AppProcesses {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $script:Cfg.processName })
}

function Get-LedgerCount {
    param([string]$SessionPath)
    try {
        $dir = Split-Path -Parent $SessionPath
        $ledger = Join-Path $dir 'truncate-visible.json'
        if (Test-Path -LiteralPath $ledger) {
            $j = Get-Content -LiteralPath $ledger -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $j.truncations) { return @($j.truncations).Count }
        }
    } catch { }
    return 0
}

function Get-ArchiveCount {
    param([string]$SessionPath)
    try {
        $dir = Split-Path -Parent $SessionPath
        return @(Get-ChildItem -LiteralPath $dir -Directory -Filter '*.archive' -ErrorAction SilentlyContinue).Count
    } catch { return 0 }
}

function Read-RequestFile {
    param([string]$Path)
    $lastError = ''
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return @{ ok = $false; absent = $true; error = 'file disappeared' }
        }
        try {
            $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
            $obj = $raw | ConvertFrom-Json
            return @{ ok = $true; request = $obj; raw = $raw }
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 250
        }
    }
    return @{ ok = $false; absent = $false; error = $lastError }
}

function Move-ToQuarantine {
    param([string]$Path, [string]$Reason, $Request)
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return }
        $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
        $id = 'unknown'
        if ($null -ne $Request -and $null -ne $Request.PSObject.Properties['requestId']) { $id = [string]$Request.requestId }
        $safe = ($id -replace '[^A-Za-z0-9._-]', '_')
        $dest = Join-Path (Join-Path $script:Root 'quarantine') "$stamp-$safe.json"
        Move-Item -LiteralPath $Path -Destination $dest -Force
        Set-Content -LiteralPath "$dest.reason.txt" -Value $Reason -Encoding UTF8
        Write-WLog 'WARN' "quarantine: $dest reason=$Reason"
    } catch {
        Write-WLog 'ERROR' "quarantine move failed: $($_.Exception.Message)"
    }
}

function Quote-Arg {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    return '"' + ($Value -replace '"', '\"') + '"'
}

# Read a key from a request journal entry. Entries are [ordered]@{} while the
# cycle is running and PSCustomObject after a state reload; PSObject.Properties
# only exists on the latter, so both shapes must be handled explicitly.
function Get-MapValue {
    param($Map, [string]$Name, $Default = $null)
    if ($null -eq $Map) { return $Default }
    if ($Map -is [System.Collections.IDictionary]) {
        if ($Map.Contains($Name)) {
            $value = $Map[$Name]
            if ($null -eq $value) { return $Default }
            return $value
        }
        return $Default
    }
    $prop = $Map.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
    return $prop.Value
}

function Get-FileLength {
    param([string]$Path)
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) { return [int64](Get-Item -LiteralPath $Path).Length }
    } catch { }
    return [int64]0
}

# Read only the bytes appended after $Offset: the runner log is shared by every
# request, so a whole-file scan could pick up an older result for the same id.
function Read-TextFromOffset {
    param([string]$Path, [int64]$Offset = 0)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $fs = $null
    $reader = $null
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        if ($Offset -lt 0 -or $Offset -gt $fs.Length) { $Offset = 0 }
        [void]$fs.Seek($Offset, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8, $true)
        return $reader.ReadToEnd()
    } catch {
        return ''
    } finally {
        if ($null -ne $reader) { $reader.Dispose() } elseif ($null -ne $fs) { $fs.Dispose() }
    }
}

function Write-FailedRecord {
    param(
        [string]$EvidenceDir,
        [string]$RequestId,
        [string]$Status,
        $ExitCode,
        [bool]$ExitCodeKnown,
        [string]$Reason,
        [int]$Attempts,
        $Result,
        [string]$ResultSource
    )
    try {
        $record = [ordered]@{
            ok           = $false
            requestId    = $RequestId
            status       = $Status
            exitCode     = $ExitCode
            exitCodeKnown = $ExitCodeKnown
            reason       = $Reason
            attempts     = $Attempts
            resultStatus = $(if ($null -ne $Result) { [string](Get-MapValue $Result 'status' '') } else { '' })
            resultOk     = $(if ($null -ne $Result) { [bool](Get-MapValue $Result 'ok' $false) } else { $false })
            resultSource = $ResultSource
            failedAt     = (Get-Date).ToString('o')
            evidence     = $EvidenceDir
        }
        Save-JsonFile (Join-Path $EvidenceDir 'failed.json') $record
        return $true
    } catch {
        Write-WLog 'ERROR' "could not write failed.json: $($_.Exception.Message)"
        return $false
    }
}

function Invoke-Runner {
    param($Request, [string]$EvidenceDir)
    $cfg = $script:Cfg
    $runner = $cfg.runnerPath
    $resultFile = Join-Path $EvidenceDir 'runner-result.json'
    $outFile = Join-Path $EvidenceDir 'runner.out.txt'
    $errFile = Join-Path $EvidenceDir 'runner.err.txt'
    $empty = @{
        started = $false; exitCode = $null; error = ''; pid = 0
        startedAt = ''; endedAt = ''; durationMs = 0
        outFile = $outFile; errFile = $errFile; resultFile = $resultFile
    }
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
        $empty.error = "runner not found: $runner"
        return $empty
    }
    $pwsh = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $pwsh)) { $pwsh = 'powershell.exe' }
    $parts = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote-Arg $runner),
        '-MemoryRoot', (Quote-Arg $cfg.memoryRoot),
        '-RequestFile', (Quote-Arg $cfg.requestPath),
        '-AppExe', (Quote-Arg $cfg.appExe),
        '-Profile', (Quote-Arg $cfg.profile),
        '-LogDir', (Quote-Arg $cfg.runnerLogDir)
    )
    if ($cfg.appArgs) { $parts += @('-AppArgs', (Quote-Arg $cfg.appArgs)) }
    $argLine = ($parts -join ' ')
    Write-WLog 'INFO' "runner start: $pwsh $argLine"
    $startedAt = Get-Date

    # P0-1: Start-Process -PassThru keeps ExitCode empty in Windows PowerShell
    # 5.1 when stdout/stderr are redirected ("[int]$null" then reads as 0, i.e.
    # every runner failure looked like success). Drive the process through
    # System.Diagnostics.Process instead: ExitCode is real after WaitForExit().
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $pwsh
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    try { $psi.WorkingDirectory = $script:Root } catch { }
    # The runner mirrors its result JSON here, so the watcher does not depend on
    # parsing a shared log file. Runners that ignore the variable are covered by
    # the log-offset fallback in Get-RunnerResult.
    try { $psi.EnvironmentVariables['DSH_TRUNCATE_RESULT_FILE'] = $resultFile } catch { }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    try {
        if (-not $proc.Start()) { throw 'Process.Start returned false' }
    } catch {
        $message = $_.Exception.Message
        try { $proc.Dispose() } catch { }
        Write-WLog 'ERROR' "runner could not start: $message"
        $empty.error = $message
        $empty.startedAt = $startedAt.ToString('o')
        $empty.endedAt = (Get-Date).ToString('o')
        return $empty
    }

    $runnerPid = $proc.Id
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    Write-WLog 'INFO' "runner pid=$runnerPid"
    Write-Heartbeat -State $script:State -Loop $script:Loop -RunnerPid ([string]$runnerPid)
    $proc.WaitForExit()

    $stdout = ''
    $stderr = ''
    try { if ($stdoutTask.Wait(30000)) { $stdout = [string]$stdoutTask.Result } } catch { }
    try { if ($stderrTask.Wait(30000)) { $stderr = [string]$stderrTask.Result } } catch { }
    $endedAt = Get-Date
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    try { [System.IO.File]::WriteAllText($outFile, $stdout, $utf8) } catch { }
    try { [System.IO.File]::WriteAllText($errFile, $stderr, $utf8) } catch { }

    $exitCode = $null
    try { $exitCode = [int]$proc.ExitCode } catch { }
    try { $proc.Dispose() } catch { }
    return @{
        started    = $true
        exitCode   = $exitCode
        pid        = $runnerPid
        startedAt  = $startedAt.ToString('o')
        endedAt    = $endedAt.ToString('o')
        durationMs = [int]($endedAt - $startedAt).TotalMilliseconds
        outFile    = $outFile
        errFile    = $errFile
        resultFile = $resultFile
        error      = ''
    }
}

function Get-RunnerResult {
    param([string]$RequestId, [string]$ResultFile = '', [int64]$LogOffset = 0)
    # Preferred source: the per-request result file the runner was asked to
    # write (DSH_TRUNCATE_RESULT_FILE). It cannot be confused with an older run.
    if ($ResultFile -and (Test-Path -LiteralPath $ResultFile -PathType Leaf)) {
        try {
            $j = Get-Content -LiteralPath $ResultFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $j) {
                $rid = [string](Get-MapValue $j 'requestId' '')
                if (-not $rid -or $rid -eq $RequestId) {
                    return @{ result = $j; source = 'result-file' }
                }
            }
        } catch { }
    }
    # Fallback: only the bytes appended to the shared result log during this
    # run, so a stale line for the same id cannot be resurrected.
    $log = Join-Path $script:Cfg.runnerLogDir 'auto-truncate.log'
    $text = Read-TextFromOffset -Path $log -Offset $LogOffset
    if (-not $text) { return $null }
    $found = $null
    foreach ($line in ($text -split "`r?`n")) {
        $trim = $line.Trim()
        $brace = $trim.IndexOf('{')
        if ($brace -lt 0) { continue }
        try { $j = $trim.Substring($brace) | ConvertFrom-Json } catch { continue }
        $rid = [string](Get-MapValue $j 'requestId' '')
        if ($rid -eq $RequestId) { $found = $j }
    }
    if ($null -eq $found) { return $null }
    return @{ result = $found; source = 'runner-log' }
}

function Invoke-RequestCycle {
    param($State)
    $cfg = $script:Cfg
    $reqPath = $cfg.requestPath

    $read = Read-RequestFile $reqPath
    if ($read.absent) { return }
    if (-not $read.ok) {
        $age = 0
        try { $age = ((Get-Date) - (Get-Item -LiteralPath $reqPath).LastWriteTime).TotalSeconds } catch { }
        if ($age -ge $cfg.requestSettle) {
            Write-WLog 'ERROR' "request unreadable after ${age}s: $($read.error)"
            Move-ToQuarantine $reqPath "unreadable JSON: $($read.error)" $null
            $State.totals.quarantined++
            Save-State $State
        } else {
            Write-WLog 'WARN' "request still being written (age=${age}s), will retry"
        }
        return
    }

    $req = $read.request
    $id = ''
    if ($null -ne $req.PSObject.Properties['requestId']) { $id = [string]$req.requestId }
    if (-not $id) {
        Write-WLog 'ERROR' 'request has no requestId, quarantining'
        Move-ToQuarantine $reqPath 'missing requestId' $req
        $State.totals.quarantined++
        Save-State $State
        return
    }

    $known = $null
    if ($State.requests.ContainsKey($id)) { $known = $State.requests[$id] }

    if ($null -ne $known) {
        # P0-2: $known is an [ordered]@{} in this process and a PSCustomObject
        # after a state reload. PSObject.Properties is empty for the dictionary,
        # so reading attempts that way returned 0 forever (infinite retry).
        $knownStatus = [string](Get-MapValue $known 'status' '')
        $attempts = [int](Get-MapValue $known 'attempts' 0)
        if ($script:TerminalStatuses -contains $knownStatus) {
            $knownEvidence = [string](Get-MapValue $known 'evidence' '')
            if ($knownStatus -eq 'failed') {
                $reason = "duplicate-failed: request $id already failed; runner not started again"
                if ($knownEvidence) { $reason += " (evidence: $knownEvidence)" }
                $State.totals.duplicateFailed++
                $State.lastStatus = 'duplicate-failed'
                Write-WLog 'WARN' $reason
            } else {
                $reason = "duplicate-finished: request $id already finished ($knownStatus)"
                if ($knownEvidence) { $reason += " (evidence: $knownEvidence)" }
                Write-WLog 'WARN' $reason
            }
            Move-ToQuarantine $reqPath $reason $req
            $State.totals.quarantined++
            Save-State $State
            return
        }
        if ($attempts -ge $cfg.maxAttempts) {
            Write-WLog 'ERROR' "request $id exhausted $attempts attempts, quarantining"
            Move-ToQuarantine $reqPath "max attempts reached ($attempts)" $req
            $State.totals.quarantined++
            # terminal in the journal too: a replay must not reach the runner
            # through this guard either
            $entry = $State.requests[$id]
            if ($entry -is [System.Collections.IDictionary]) { $entry['status'] = 'failed' } else { $entry.status = 'failed' }
            Save-State $State
            return
        }
    }

    # a request produced before the last successful cut is obsolete: the cut
    # already happened, re-running it would truncate a second time.
    $reqAt = $null
    if ($null -ne $req.PSObject.Properties['at']) {
        try { $reqAt = [datetimeoffset]::Parse([string]$req.at, [System.Globalization.CultureInfo]::InvariantCulture) } catch { }
    }
    if ($reqAt -and $State.lastSuccessAt) {
        try {
            $lastOk = [datetimeoffset]::Parse([string]$State.lastSuccessAt, [System.Globalization.CultureInfo]::InvariantCulture)
            if ($reqAt -le $lastOk) {
                Write-WLog 'WARN' "request $id predates last success ($($State.lastSuccessAt)), quarantining as stale"
                Move-ToQuarantine $reqPath "stale: request at $($req.at) <= last success $($State.lastSuccessAt)" $req
                $State.totals.stale++
                Save-State $State
                return
            }
        } catch { }
    }
    if ($State.nextAttemptAt) {
        try {
            $next = [datetimeoffset]::Parse([string]$State.nextAttemptAt, [System.Globalization.CultureInfo]::InvariantCulture)
            if ([datetimeoffset]::Now -lt $next) {
                Write-WLog 'INFO' "request $id waiting for retry window ($($State.nextAttemptAt))"
                return
            }
        } catch { }
    }

    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $safeId = ($id -replace '[^A-Za-z0-9._-]', '_')
    if ($safeId.Length -gt 40) { $safeId = $safeId.Substring(0, 40) }
    $evDir = Join-Path (Join-Path $script:Root 'archive\requests') "$stamp-$safeId"
    $n = 1
    while (Test-Path -LiteralPath $evDir) { $n++; $evDir = Join-Path (Join-Path $script:Root 'archive\requests') "$stamp-$safeId-$n" }
    New-Item -ItemType Directory -Path $evDir -Force | Out-Null

    $sessionPath = ''
    if ($null -ne $req.PSObject.Properties['sessionPath']) { $sessionPath = [string]$req.sessionPath }
    $bytesBefore = 0
    if ($sessionPath -and (Test-Path -LiteralPath $sessionPath -PathType Leaf)) {
        $bytesBefore = (Get-Item -LiteralPath $sessionPath).Length
    }
    $ledgerBefore = 0
    $archiveBefore = 0
    if ($sessionPath) { $ledgerBefore = Get-LedgerCount $sessionPath; $archiveBefore = Get-ArchiveCount $sessionPath }

    Set-Content -LiteralPath (Join-Path $evDir 'request.json') -Value $read.raw -Encoding UTF8
    $startedAt = Get-Date
    $State.totals.detected++
    $attempts = 0
    if ($null -ne $known) { $attempts = [int](Get-MapValue $known 'attempts' 0) }
    $attempts++
    $State.lastRequestId = $id
    $State.lastStatus = 'running'
    $State.requests[$id] = [ordered]@{
        at       = $(if ($reqAt) { $reqAt.ToString('o') } else { '' })
        status   = 'running'
        attempts = $attempts
        evidence = $evDir
        updated  = (Get-Date).ToString('o')
    }
    Save-State $State
    Write-WLog 'INFO' "request $id detected: session=$sessionPath bytes=$bytesBefore ledger=$ledgerBefore archive=$archiveBefore"

    $runLogPath = Join-Path $cfg.runnerLogDir 'auto-truncate.log'
    $logOffset = Get-FileLength $runLogPath
    $run = Invoke-Runner $req $evDir
    $endedAt = Get-Date
    $totalMs = [int]($endedAt - $startedAt).TotalMilliseconds
    $found = Get-RunnerResult -RequestId $id -ResultFile ([string]$run.resultFile) -LogOffset $logOffset
    $result = $null
    $resultSource = ''
    if ($null -ne $found) {
        $result = $found.result
        $resultSource = [string]$found.source
        $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $evDir 'result.json') -Encoding UTF8
    }
    $resultOk = ($null -ne $result) -and [bool](Get-MapValue $result 'ok' $false)
    $resultStatus = $(if ($null -ne $result) { [string](Get-MapValue $result 'status' '') } else { '' })
    $exitKnown = ($null -ne $run.exitCode)
    $code = $(if ($exitKnown) { [int]$run.exitCode } else { -1 })
    $codeLabel = $(if ($exitKnown) { "failed-$code" } else { 'failed-unknown' })

    $bytesAfter = 0
    if ($sessionPath -and (Test-Path -LiteralPath $sessionPath -PathType Leaf)) { $bytesAfter = (Get-Item -LiteralPath $sessionPath).Length }
    $ledgerAfter = 0
    $archiveAfter = 0
    if ($sessionPath) { $ledgerAfter = Get-LedgerCount $sessionPath; $archiveAfter = Get-ArchiveCount $sessionPath }
    $requestStillThere = Test-Path -LiteralPath $reqPath -PathType Leaf
    $appCount = (Get-AppProcesses).Count

    $evidence = [ordered]@{
        requestId          = $id
        requestAt          = $(if ($reqAt) { $reqAt.ToString('o') } else { '' })
        detectedAt         = $startedAt.ToString('o')
        finishedAt         = $endedAt.ToString('o')
        totalMs            = $totalMs
        runnerStarted      = $run.started
        runnerPid          = $run.pid
        runnerExitCode     = $run.exitCode
        runnerExitCodeKnown = $exitKnown
        runnerDurationMs   = $run.durationMs
        runnerError        = $run.error
        resultStatus       = $resultStatus
        resultOk           = $resultOk
        resultSource       = $resultSource
        sessionPath        = $sessionPath
        sessionBytesBefore = $bytesBefore
        sessionBytesAfter  = $bytesAfter
        ledgerBefore       = $ledgerBefore
        ledgerAfter        = $ledgerAfter
        archiveBefore      = $archiveBefore
        archiveAfter       = $archiveAfter
        requestStillThere  = $requestStillThere
        appProcesses       = $appCount
        attempts           = $attempts
    }
    $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evDir 'evidence.json') -Encoding UTF8

    # P0-1 double insurance: exit 0 alone is not success, the runner must also
    # have written ok=true. Any disagreement between exit code and result is a
    # failure; when the exit code is 0 we never retry (the cut may have
    # happened), we quarantine instead.
    $success = $run.started -and $exitKnown -and ($code -eq 0) -and $resultOk -and (-not $requestStillThere)
    $requestStuck = $run.started -and $exitKnown -and ($code -eq 0) -and $resultOk -and $requestStillThere
    $restartPath = $run.started -and (($code -eq 6) -or (($code -eq 0) -and ($resultStatus -eq 'restart-failed')))

    $status = 'failed'
    $outcome = ''
    $failureReason = ''

    if ($success) {
        $status = 'done'
        $outcome = 'success'
        $State.totals.succeeded++
        $State.lastSuccessAt = $endedAt.ToString('o')
        $State.lastStatus = 'done'
        $State.nextAttemptAt = ''
        Write-WLog 'INFO' "request $id DONE exit=0 resultOk=True runnerMs=$($run.durationMs) totalMs=$totalMs bytes=$bytesBefore->$bytesAfter ledger=$ledgerBefore->$ledgerAfter app=$appCount requestPresent=False"
    } elseif ($requestStuck) {
        # P2: the cut happened but the request survived, so this is NOT a
        # success and must not move the stale baseline (lastSuccessAt).
        $status = 'request-stuck'
        $outcome = 'request-stuck'
        $failureReason = 'runner reported success (exit 0, ok=true) but the request file is still present'
        $State.totals.failed++
        $State.lastStatus = 'request-stuck'
        $State.nextAttemptAt = ''
        Write-WLog 'ERROR' "request $id STUCK: $failureReason"
        Move-ToQuarantine $reqPath $failureReason $req
        $State.totals.quarantined++
        [void](Write-FailedRecord -EvidenceDir $evDir -RequestId $id -Status $status -ExitCode $run.exitCode -ExitCodeKnown $exitKnown -Reason $failureReason -Attempts $attempts -Result $result -ResultSource $resultSource)
    } elseif ($restartPath) {
        # cut+verify succeeded, only the restart failed. Re-running the request
        # would cut a second time: try to start the app here and archive it.
        $status = 'restart-failed'
        $outcome = 'restart-failed'
        $State.lastStatus = 'restart-failed'
        Write-WLog 'ERROR' "request $id restart-failed (runner exit $code); attempting manual start"
        try {
            if ($script:Cfg.appArgs) {
                Start-Process -FilePath $script:Cfg.appExe -ArgumentList $script:Cfg.appArgs | Out-Null
            } else {
                Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList (Quote-Arg $script:Cfg.appExe) | Out-Null
            }
            Start-Sleep -Seconds 15
            $after = (Get-AppProcesses).Count
            if ($after -gt 0) {
                $status = 'recovered'
                $outcome = 'recovered'
                $State.lastStatus = 'recovered'
                $State.totals.succeeded++
                Write-WLog 'INFO' "request $id recovered: app running after manual start ($after processes)"
            } else {
                Write-WLog 'ERROR' "request $id manual start did not bring the app back"
            }
        } catch {
            Write-WLog 'ERROR' "request $id manual start failed: $($_.Exception.Message)"
        }
        if ($status -eq 'recovered') {
            Move-ToQuarantine $reqPath "runner exit $code; cut applied, restart handled by watcher (recovered)" $req
            $State.totals.quarantined++
        } else {
            $failureReason = "runner exit $code (restart-failed): cut applied but the app did not come back"
            $State.totals.failed++
            Move-ToQuarantine $reqPath $failureReason $req
            $State.totals.quarantined++
            [void](Write-FailedRecord -EvidenceDir $evDir -RequestId $id -Status $status -ExitCode $run.exitCode -ExitCodeKnown $exitKnown -Reason $failureReason -Attempts $attempts -Result $result -ResultSource $resultSource)
        }
    } else {
        $State.totals.failed++
        $permanent = $false
        if (-not $run.started) {
            $failureReason = "runner did not start: $($run.error)"
        } elseif (-not $exitKnown) {
            $permanent = $true
            $failureReason = 'runner exited but its exit code could not be read'
        } elseif ($code -eq 2 -or $code -eq 4 -or $code -eq 5) {
            $permanent = $true
            $failureReason = "runner exit $code"
            if ($resultStatus) { $failureReason += " (result status=$resultStatus)" }
        } elseif ($code -eq 0) {
            $permanent = $true
            if ($null -eq $result) {
                $failureReason = 'runner exit 0 but no result record was found; refusing to retry an unverified success'
            } else {
                $failureReason = "runner exit 0 but result.ok=false (status=$resultStatus)"
            }
        } else {
            $failureReason = "runner exit $code"
        }
        Write-WLog 'ERROR' "request $id failure: $failureReason"
        if ($permanent) {
            $status = 'failed'
            $outcome = 'permanent-failure'
            $State.lastStatus = $codeLabel
            $State.nextAttemptAt = ''
            Move-ToQuarantine $reqPath $failureReason $req
            $State.totals.quarantined++
            [void](Write-FailedRecord -EvidenceDir $evDir -RequestId $id -Status $status -ExitCode $run.exitCode -ExitCodeKnown $exitKnown -Reason $failureReason -Attempts $attempts -Result $result -ResultSource $resultSource)
        } else {
            $delay = [int]$script:Cfg.retryDelay
            if ($delay -lt 0) { $delay = 0 }
            Write-WLog 'WARN' "request $id transient failure: $failureReason; retry after $delay s (attempt $attempts/$($script:Cfg.maxAttempts))"
            if ($attempts -ge [int]$script:Cfg.maxAttempts) {
                $status = 'failed'
                $outcome = 'exhausted'
                $State.lastStatus = $codeLabel
                $State.nextAttemptAt = ''
                Move-ToQuarantine $reqPath "max attempts reached: $failureReason" $req
                $State.totals.quarantined++
                [void](Write-FailedRecord -EvidenceDir $evDir -RequestId $id -Status $status -ExitCode $run.exitCode -ExitCodeKnown $exitKnown -Reason "max attempts ($attempts) reached: $failureReason" -Attempts $attempts -Result $result -ResultSource $resultSource)
            } else {
                $status = 'retry'
                $outcome = 'retry'
                $State.nextAttemptAt = (Get-Date).AddSeconds($delay).ToString('o')
                $State.lastStatus = "retry-$code"
            }
        }
    }

    $State.requests[$id] = [ordered]@{
        at            = $(if ($reqAt) { $reqAt.ToString('o') } else { '' })
        status        = $status
        attempts      = $attempts
        exitCode      = $(if ($exitKnown) { $code } else { $null })
        exitCodeKnown = $exitKnown
        outcome       = $outcome
        reason        = $failureReason
        evidence      = $evDir
        ms            = $totalMs
        updated       = (Get-Date).ToString('o')
    }
    Save-State $State
    Write-WLog 'INFO' "request $id finished status=$status outcome=$outcome exit=$code totalMs=$totalMs evidence=$evDir"
}

# ---------------------------------------------------------------------------
# startup
# ---------------------------------------------------------------------------
$script:Cfg = Read-WatcherConfig -Path $Config
if ($null -eq $script:Cfg) { exit 2 }

foreach ($d in @('logs', 'state', 'archive\requests', 'quarantine')) {
    New-Item -ItemType Directory -Path (Join-Path $script:Root $d) -Force | Out-Null
}

$mutex = $null
foreach ($name in @('Global\DshResidentWatcher', 'Local\DshResidentWatcher')) {
    try {
        $mutex = New-Object System.Threading.Mutex($false, $name)
        break
    } catch { }
}
if ($null -eq $mutex) {
    Write-WLog 'ERROR' 'cannot create the watcher mutex'
    exit 1
}
$owned = $false
try {
    $owned = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    # the previous owner died without releasing it; we are the owner now
    $owned = $true
}
if (-not $owned) {
    Write-WLog 'WARN' 'another watcher instance already owns the mutex; exiting'
    exit 0
}

$script:State = Read-State
$script:Loop = 0

if (Test-Path -LiteralPath $script:LockPath) {
    try {
        $old = Get-Content -LiteralPath $script:LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $oldPid = [int]$old.pid
        if ($oldPid -and $oldPid -ne $PID) {
            $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -like 'powershell*') {
                Write-WLog 'WARN' "stale lock points at a live powershell pid=$oldPid; exiting"
                $mutex.ReleaseMutex()
                exit 0
            }
        }
    } catch { }
}

$lock = [ordered]@{
    pid       = $PID
    startedAt = $script:StartedAt.ToString('o')
    version   = $script:Version
    config    = (Join-Path $script:Root 'config.json')
    taskName  = $script:Cfg.taskName
}
Save-JsonFile $script:LockPath $lock
Write-WLog 'INFO' "watcher start version=$($script:Version) pid=$PID request=$($script:Cfg.requestPath) memoryRoot=$($script:Cfg.memoryRoot) poll=$($script:Cfg.pollSeconds)s"
Write-Heartbeat -State $script:State -Loop 0

$exitCode = 0
try {
    $lastAliveLog = Get-Date
    while (-not (Test-Path -LiteralPath $script:StopFlag)) {
        $script:Loop++
        if ((Get-Date) - $lastAliveLog -ge [TimeSpan]::FromMinutes(5)) {
            Write-WLog 'INFO' "alive loop=$($script:Loop) pending=$(Test-Path -LiteralPath $script:Cfg.requestPath -PathType Leaf) app=$((Get-AppProcesses).Count)"
            $lastAliveLog = Get-Date
        }
        Write-Heartbeat -State $script:State -Loop $script:Loop
        try {
            Invoke-RequestCycle $script:State
        } catch {
            Write-WLog 'ERROR' "request cycle failed: $($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)"
        }
        Start-Sleep -Seconds ([int]$script:Cfg.pollSeconds)
        if (Test-Path -LiteralPath $script:OnceFlag) {
            Write-WLog 'INFO' 'once flag detected, finishing after one cycle'
            Remove-Item -LiteralPath $script:OnceFlag -Force -ErrorAction SilentlyContinue
            break
        }
    }
    Write-WLog 'INFO' 'stop flag detected, exiting'
} catch {
    Write-WLog 'ERROR' "fatal: $($_.Exception.Message) $($_.ScriptStackTrace)"
    $exitCode = 1
} finally {
    try { if (Test-Path -LiteralPath $script:StopFlag) { Remove-Item -LiteralPath $script:StopFlag -Force -ErrorAction SilentlyContinue } } catch { }
    try {
        if (Test-Path -LiteralPath $script:LockPath) {
            $cur = Get-Content -LiteralPath $script:LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([int]$cur.pid -eq $PID) { Remove-Item -LiteralPath $script:LockPath -Force }
        }
    } catch { }
    try { $mutex.ReleaseMutex() } catch { }
    try { $mutex.Dispose() } catch { }
}
exit $exitCode
