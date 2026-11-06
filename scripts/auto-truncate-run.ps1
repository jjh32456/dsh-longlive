#requires -Version 5.1
<#
  auto-truncate-run.ps1 - out-of-app visible truncation orchestrator.

  The in-app plugin only writes a request; this script performs the cut while
  the app is closed, verifies the rewritten log by loading it through the
  app's own Electron runtime, and restarts the app.

  The request's sessionPath must live under the sessions root (by default
  %USERPROFILE%\.dsh\sessions, or <DSH_HOME>\sessions when DSH_HOME is set).
  The path is resolved to its full form and compared case-insensitively, so a
  relative path, a ..-escape, or an arbitrary file is refused before anything
  is closed.

  Exit codes:
    0 success (or -DryRun validation only)
    2 bad-request (including SESSION_PATH_OUTSIDE_ROOT)
    3 close-failed (CLOSE_FAILED; structured result written)
    4 cut-failed (backup restored when available)
    5 verify-failed (backup restored)
    6 restart-failed (cut kept, request kept)

  Closing the app is a hard kill, because a graceful-only close proved to shut
  down 3 of 5 processes and to make the run wait a full minute for nothing:
  Close-App sends one polite CloseMainWindow to the processes that own a main
  window, waits at most 3 seconds, then force-kills every survivor by PID with
  Stop-Process -Force (never a /IM image-name sweep, which matches by image name
  and both misses and overreaches), settles 2 seconds and requires zero
  processes. Anything still alive after that is CLOSE_FAILED / exit 3 and no
  session byte changes.

  -SimulateCloseFailure exists only so the test suite can exercise the
  close-failed path without touching a real process. It makes Close-App report
  failure before it looks at any process.

  The script body is ASCII. Paths and log lines may contain any Unicode text.
#>
param(
    [Parameter(Mandatory = $true)][string]$MemoryRoot,
    [string]$RequestFile = '',
    [string]$AppExe = '',
    [string]$Profile = 'desktop',
    [string]$LogDir = '',
    [string]$SessionsRoot = '',
    [switch]$DryRun,
    [switch]$SimulateCloseFailure
)

$ErrorActionPreference = 'Stop'
$script:ExeName = ''

# rc.6 (R4-03): capture every native node process as UTF-8, independent of the
# console code page. On a Chinese Windows the host console is GBK; letting the
# runtime decode node's UTF-8 stdout through that page produced mojibake and
# made the JSON line unparseable. This file is UTF-8 without BOM and must never
# contain non-ASCII string literals (PS 5.1 reads it as ANSI).
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = $script:Utf8NoBom } catch { }
try { [Console]::InputEncoding = $script:Utf8NoBom } catch { }
try { $OutputEncoding = $script:Utf8NoBom } catch { }

function Quote-NativeArg([string]$Value) {
    if ($null -eq $Value) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\' * (($backslashes * 2) + 1))
            [void]$sb.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$sb.Append('\' * $backslashes); $backslashes = 0 }
        [void]$sb.Append($ch)
    }
    if ($backslashes -gt 0) { [void]$sb.Append('\' * ($backslashes * 2)) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Write-Run([string]$Message) {
    $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
    $line = "[$ts] $Message"
    Add-Content -LiteralPath $script:RunLog -Value $line -Encoding UTF8
    Write-Host $line
}

function Write-Result($Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 10
    Add-Content -LiteralPath $script:ResultLog -Value $json -Encoding UTF8
    Write-Run "RESULT $json"
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    # stdout/stderr are read through explicit UTF-8 decoders. Do not go back to
    # `& $exe @args 2>&1 | Out-String`: that path decodes via the console code
    # page and corrupts non-ASCII JSON (R4-03).
    $argLine = (@($Arguments) | ForEach-Object { Quote-NativeArg ([string]$_) }) -join ' '
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FilePath
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $script:Utf8NoBom
    $psi.StandardErrorEncoding = $script:Utf8NoBom
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(900000)) {
        try { $proc.Kill() } catch { }
        throw "native process timed out after 900s: $FilePath"
    }
    $stdout = $outTask.Result
    $stderr = $errTask.Result
    $code = $proc.ExitCode
    $proc.Dispose()
    $text = (@($stdout, $stderr) | Where-Object { $_ }) -join "`n"
    return [pscustomobject]@{ Output = $text.Trim(); Stdout = $stdout; Stderr = $stderr; ExitCode = $code }
}

function Get-AppProcs {
    $names = @($script:ExeName, 'DEEPSE~1', "$($script:ExeName) Helper")
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $p = $_.ProcessName
        $names -contains $p -or $p -like "$($script:ExeName)*"
    })
}

function Resolve-NodeExe([string]$Exe) {
    $dir = Split-Path -Parent $Exe
    $candidates = @()
    if ($env:DSH_NODE) { $candidates += $env:DSH_NODE }
    $candidates += @(
        (Join-Path $dir 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $dir 'resources\runtime\node\bin\node.exe'),
        (Join-Path $dir 'resources\node\node.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return ''
}

function Restore-Backup([string]$BackupPath, [string]$TargetPath, [string]$ExpectedSha) {
    if (-not $BackupPath -or -not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
        Write-Run "restore: no usable backup path ($BackupPath)"
        return $false
    }
    Copy-Item -LiteralPath $BackupPath -Destination $TargetPath -Force
    $got = (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $want = ''
    if ($ExpectedSha) { $want = $ExpectedSha.ToLowerInvariant() }
    $ok = ($want -eq '') -or ($got -eq $want)
    Write-Run "restore: $BackupPath -> $TargetPath sha256=$got expected=$want ok=$ok"
    return $ok
}

# rc.6 (R4-03): when truncate-cli exits 0 but its stdout cannot be parsed, the
# cut may still have landed (GBK decoding ate the JSON, not the write). Read the
# session back with surgery-inspect and compare its event count with the plan
# snapshot: a drop is proof the cut landed; no drop means we cannot tell and the
# old restore-and-fail path stays in charge.
function Test-CutApplied([string]$NodeExe, [string]$Path, $Request) {
    $inspectScript = Join-Path $PSScriptRoot 'surgery-inspect.mjs'
    if (-not (Test-Path -LiteralPath $inspectScript -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; reason = 'inspect-missing'; after = $null; backupPath = $null }
    }
    $run = Invoke-Native $NodeExe @($inspectScript, $Path)
    $json = $null
    foreach ($line in ($run.Output -split "`r?`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed.StartsWith('{')) { continue }
        try { $json = $trimmed | ConvertFrom-Json } catch { $json = $null }
    }
    if ($null -eq $json -or -not $json.ok) {
        return [pscustomobject]@{ ok = $false; reason = 'inspect-unreadable'; after = $null; backupPath = $null }
    }
    $planned = $null
    if ($null -ne $Request.plan -and $null -ne $Request.plan.PSObject.Properties['snapshotEvents']) {
        $planned = [int]$Request.plan.snapshotEvents
    }
    if ($null -eq $planned) {
        return [pscustomobject]@{ ok = $false; reason = 'no-plan-snapshot'; after = $json; backupPath = $null }
    }
    $fileName = Split-Path -Leaf $Path
    $backup = Get-ChildItem -LiteralPath (Split-Path -Parent $Path) -Filter "$fileName.bak-*" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $backupPath = $null
    if ($backup) { $backupPath = $backup.FullName }
    $afterEvents = [int]$json.events
    if ($afterEvents -lt $planned) {
        return [pscustomobject]@{ ok = $true; reason = 'events-dropped'; after = $json; backupPath = $backupPath; planned = $planned }
    }
    return [pscustomobject]@{ ok = $false; reason = "events-did-not-drop ($afterEvents >= $planned)"; after = $json; backupPath = $backupPath; planned = $planned }
}

function Start-App {
    try {
        Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"' + $script:AppPath + '"') | Out-Null
        Write-Run "restart: launched via explorer $($script:AppPath)"
    } catch {
        Write-Run "restart: launch failed: $($_.Exception.Message)"
        return $false
    }
    Start-Sleep -Seconds 20
    $procs = Get-AppProcs
    $ok = $procs.Count -gt 0
    Write-Run "restart: running=$ok count=$($procs.Count)"
    return $ok
}

function Close-App {
    if ($SimulateCloseFailure) {
        Write-Run 'close: simulated failure (-SimulateCloseFailure), no process touched'
        return $false
    }
    $started = Get-Date
    $procs = Get-AppProcs
    if ($procs.Count -eq 0) {
        Write-Run 'close: app is not running'
        return $true
    }
    Write-Run "close: running=$($procs.Count) pids=$((($procs | ForEach-Object { $_.Id }) -join ',')) names=$((($procs | ForEach-Object { $_.ProcessName }) -join ','))"

    # One polite signal, only to the processes that actually own a main window.
    # Helpers, renderers and crashpad have no window and are not asked; they are
    # killed by PID below like everything else that is still alive.
    $polite = 0
    foreach ($proc in $procs) {
        $hasWindow = $false
        try { $hasWindow = ($proc.MainWindowHandle.ToInt64() -ne 0) } catch { $hasWindow = $false }
        if (-not $hasWindow) { continue }
        $sent = $false
        try { $sent = $proc.CloseMainWindow() } catch { $sent = $false }
        $polite += 1
        Write-Run "close: polite signal pid=$($proc.Id) sent=$sent"
    }
    if ($polite -eq 0) {
        Write-Run 'close: no process owns a main window, no polite signal sent'
    }

    # Three seconds is a courtesy window, not a negotiation: whatever is left is
    # force-killed by PID right away (never a /IM image-name sweep, which matches
    # globally by image name and leaves sibling processes behind).
    $graceDeadline = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $graceDeadline) {
        if ((Get-AppProcs).Count -eq 0) {
            $ms = [int]((Get-Date) - $started).TotalMilliseconds
            Write-Run "close: closed after the polite signal, elapsed=${ms}ms"
            return $true
        }
        Start-Sleep -Milliseconds 100
    }

    $left = Get-AppProcs
    Write-Run "close: force-killing $($left.Count) pid(s)"
    foreach ($proc in $left) {
        try {
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            Write-Run "close: Stop-Process -Force pid=$($proc.Id) name=$($proc.ProcessName)"
        } catch {
            Write-Run "close: Stop-Process pid=$($proc.Id) failed: $($_.Exception.Message)"
        }
    }

    Start-Sleep -Seconds 2
    $still = Get-AppProcs
    if ($still.Count -gt 0) {
        Write-Run "close: still running after force: $((($still | ForEach-Object { $_.Id }) -join ','))"
        return $false
    }
    $ms = [int]((Get-Date) - $started).TotalMilliseconds
    Write-Run "close: forced close confirmed, elapsed=${ms}ms"
    return $true
}

# ---------------------------------------------------------------------------
# setup and request validation
# ---------------------------------------------------------------------------
if (-not $RequestFile) {
    $RequestFile = Join-Path $MemoryRoot '.longlive\logs\auto-truncate.request.json'
}
if (-not $LogDir) {
    $LogDir = Join-Path $MemoryRoot '.longlive\logs'
}
if (-not (Test-Path -LiteralPath $LogDir -PathType Container)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$script:RunLog = Join-Path $LogDir 'auto-truncate-run.log'
$script:ResultLog = Join-Path $LogDir 'auto-truncate.log'

Write-Run "start: request=$RequestFile app=$AppExe profile=$Profile dryRun=$($DryRun.IsPresent)"

if (-not (Test-Path -LiteralPath $RequestFile -PathType Leaf)) {
    Write-Run 'bad-request: request file does not exist'
    exit 2
}
try {
    $raw = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8
    $request = $raw | ConvertFrom-Json
} catch {
    Write-Run "bad-request: cannot parse JSON: $($_.Exception.Message)"
    exit 2
}

$missing = @()
foreach ($name in @('version', 'requestId', 'at', 'sessionPath', 'sessionId', 'reason', 'estimate', 'plan', 'app', 'pluginDir')) {
    if ($null -eq $request.PSObject.Properties[$name]) { $missing += $name }
}
if ($missing.Count -gt 0) {
    Write-Run "bad-request: missing fields: $($missing -join ',')"
    exit 2
}
if ($request.version -ne 1) {
    Write-Run "bad-request: unsupported version $($request.version)"
    exit 2
}
if (-not (Test-Path -LiteralPath $request.sessionPath -PathType Leaf)) {
    Write-Run "bad-request: session file not found: $($request.sessionPath)"
    exit 2
}

# ---------------------------------------------------------------------------
# sessionPath containment: it must be a real file under the sessions root.
#
# Resolve-Path normalises separators and ..-segments; the comparison is a
# case-insensitive prefix on the full path plus one separator, so
# "sessions-other\x" cannot pass as "sessions\x". The root itself is resolved
# the same way, which keeps the check honest when DSH_HOME is redirected.
# ---------------------------------------------------------------------------
if (-not $SessionsRoot) {
    if ($env:DSH_HOME) {
        $SessionsRoot = Join-Path $env:DSH_HOME 'sessions'
    } else {
        $SessionsRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
    }
}
$sessionsRootFull = ''
try {
    if (-not (Test-Path -LiteralPath $SessionsRoot -PathType Container)) {
        throw "not a directory: $SessionsRoot"
    }
    $sessionsRootFull = [System.IO.Path]::GetFullPath(
        (Resolve-Path -LiteralPath $SessionsRoot).ProviderPath
    ).TrimEnd([char[]]@('\', '/'))
} catch {
    $message = "sessions root is not usable: $SessionsRoot ($($_.Exception.Message))"
    Write-Run "bad-request: SESSIONS_ROOT_NOT_FOUND $message"
    Write-Result ([ordered]@{
        ok = $false; status = 'bad-request'; requestId = $request.requestId
        time = (Get-Date).ToString('o'); code = 'SESSIONS_ROOT_NOT_FOUND'; message = $message
        sessionPath = [string]$request.sessionPath; sessionsRoot = $SessionsRoot
    })
    exit 2
}
$sessionFull = [System.IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath $request.sessionPath).ProviderPath
)
$insidePrefix = $sessionsRootFull + [System.IO.Path]::DirectorySeparatorChar
$insideRoot = $sessionFull.StartsWith($insidePrefix, [System.StringComparison]::OrdinalIgnoreCase)
if (-not $insideRoot) {
    $message = "sessionPath is outside the sessions root: $sessionFull (root: $sessionsRootFull)"
    Write-Run "bad-request: SESSION_PATH_OUTSIDE_ROOT $message"
    Write-Result ([ordered]@{
        ok = $false; status = 'bad-request'; requestId = $request.requestId
        time = (Get-Date).ToString('o'); code = 'SESSION_PATH_OUTSIDE_ROOT'; message = $message
        sessionPath = $sessionFull; sessionsRoot = $sessionsRootFull
    })
    exit 2
}
Write-Run "session-path ok: $sessionFull under $sessionsRootFull"

if (-not (Test-Path -LiteralPath $request.pluginDir -PathType Container)) {
    Write-Run "bad-request: plugin dir not found: $($request.pluginDir)"
    exit 2
}
$cli = Join-Path $request.pluginDir 'scripts\truncate-cli.mjs'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    Write-Run "bad-request: truncate-cli.mjs not found: $cli"
    exit 2
}
$keepTurns = 12
$keepTokens = 80000
if ($null -ne $request.plan.PSObject.Properties['keepTurns']) { $keepTurns = [int]$request.plan.keepTurns }
if ($null -ne $request.plan.PSObject.Properties['keepTokens']) { $keepTokens = [int]$request.plan.keepTokens }
if ($keepTurns -lt 1 -or $keepTokens -lt 1) {
    Write-Run "bad-request: invalid keepTurns=$keepTurns keepTokens=$keepTokens"
    exit 2
}

$script:AppPath = $AppExe
if (-not $script:AppPath -and $null -ne $request.app.PSObject.Properties['exe']) { $script:AppPath = [string]$request.app.exe }
if (-not $script:AppPath -or -not (Test-Path -LiteralPath $script:AppPath -PathType Leaf)) {
    Write-Run "bad-request: app executable not found: $script:AppPath"
    exit 2
}
$script:ExeName = [System.IO.Path]::GetFileNameWithoutExtension($script:AppPath)
Write-Run "request ok: id=$($request.requestId) session=$($request.sessionPath) keepTurns=$keepTurns keepTokens=$keepTokens"

if ($DryRun) {
    $plan = [ordered]@{
        ok = $true
        dryRun = $true
        requestId = $request.requestId
        sessionPath = $request.sessionPath
        sessionsRoot = $sessionsRootFull
        app = $script:AppPath
        keepTurns = $keepTurns
        keepTokens = $keepTokens
        requestedPlan = $request.plan
        running = ((Get-AppProcs).Count -gt 0)
        close = [ordered]@{
            policy = 'hard-kill'
            signal = 'CloseMainWindow'
            gracefulMs = 3000
            kill = 'Stop-Process -Id -Force'
            settleMs = 2000
        }
    }
    $plan | ConvertTo-Json -Depth 8
    Write-Run 'dry-run: validation passed, nothing closed or cut'
    exit 0
}

# ---------------------------------------------------------------------------
# close - cut - verify - restart
# ---------------------------------------------------------------------------
if (-not (Close-App)) {
    Write-Result ([ordered]@{
        ok = $false; status = 'close-failed'; requestId = $request.requestId
        time = (Get-Date).ToString('o'); code = 'CLOSE_FAILED'
        message = 'the app could not be closed; nothing was cut and no session byte changed'
        sessionPath = $sessionFull; app = $script:AppPath
        before = $null; after = $null; archivePath = $null; backupPath = $null
        verify = $null; restored = $false; restart = $false
    })
    # Kept for readers that only grep the run log.
    Write-Run 'RESULT close-failed'
    exit 3
}
Start-Sleep -Seconds 5

$nodeExe = Resolve-NodeExe $script:AppPath
if (-not $nodeExe) {
    Write-Run 'cut-failed: node executable not found'
    $restarted = Start-App
    Write-Result ([ordered]@{
        ok = $false; status = 'cut-failed'; requestId = $request.requestId
        time = (Get-Date).ToString('o'); code = 'NODE_NOT_FOUND'
        before = $null; after = $null; archivePath = $null; backupPath = $null
        verify = $null; restored = $false; restart = $restarted
    })
    exit 4
}
Write-Run "cut: node=$nodeExe cli=$cli"

$cliArgs = @($cli, '--session', $sessionFull, '--keep-turns', [string]$keepTurns,
    '--keep-tokens', [string]$keepTokens, '--confirm', 'TRUNCATE-VISIBLE',
    '--memory-root', $MemoryRoot)
# m2 (rc.2): truncate-cli.mjs re-checks that --session lives under the DSH
# sessions root ($DSH_HOME/sessions). When the caller passed an explicit
# -SessionsRoot, derive the matching home for the child and restore it after.
$previousDshHome = $env:DSH_HOME
if ((Split-Path -Leaf $sessionsRootFull) -ieq 'sessions') {
    $env:DSH_HOME = Split-Path -Parent $sessionsRootFull
}
$cliRun = Invoke-Native $nodeExe $cliArgs
if ($null -eq $previousDshHome) {
    Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue
} else {
    $env:DSH_HOME = $previousDshHome
}
$cliOutput = $cliRun.Output
$cliExit = $cliRun.ExitCode
Write-Run "cut: cli exit=$cliExit raw=$($cliOutput.Trim())"

$cliJson = $null
foreach ($line in ($cliOutput -split "`r?`n")) {
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith('{')) {
        try { $cliJson = $trimmed | ConvertFrom-Json } catch { $cliJson = $null }
    }
}

# rc.6 (R4-03): exit 0 with unparseable stdout is not proof of failure. Verify
# the write independently before restoring: a dropped event count means the cut
# really landed and the JSON line was the only casualty.
$unparsedStdout = ($cliExit -eq 0 -and $null -eq $cliJson)
$unparsedVerification = $null
if ($unparsedStdout) {
    $probe = Test-CutApplied $nodeExe $sessionFull $request
    $unparsedVerification = [ordered]@{
        ok = $probe.ok
        reason = $probe.reason
        plannedEvents = $probe.planned
        afterEvents = $(if ($null -ne $probe.after) { $probe.after.events } else { $null })
        backupPath = $probe.backupPath
        checkedAt = (Get-Date).ToString('o')
    }
    if ($probe.ok) {
        Write-Run "cut: cli stdout unparsed; read-back proves the cut (events -> $($probe.after.events), planned $($probe.planned))"
        $cliJson = [pscustomobject]@{
            ok = $true
            applied = $true
            needed = $true
            status = 'applied-unparsed'
            encoding = 'unparsed'
            sessionPath = $sessionFull
            before = [pscustomobject]@{ events = $probe.planned; source = 'plan.snapshotEvents' }
            after = $probe.after
            backupPath = $probe.backupPath
            archivePath = $null
        }
    } else {
        Write-Run "cut: cli stdout unparsed and read-back did not prove a cut ($($probe.reason)); falling back to restore"
    }
}

$backupPath = $null
$beforeSha = $null
if ($null -ne $cliJson) {
    if ($null -ne $cliJson.PSObject.Properties['backupPath']) { $backupPath = [string]$cliJson.backupPath }
    if ($null -ne $cliJson.before -and $null -ne $cliJson.before.PSObject.Properties['sha256']) {
        $beforeSha = [string]$cliJson.before.sha256
    }
}
if (-not $backupPath -and $null -ne $unparsedVerification) {
    $backupPath = [string]$unparsedVerification.backupPath
}

if ($cliExit -ne 0 -or $null -eq $cliJson -or -not $cliJson.ok) {
    $code = 'CLI_FAILED'
    if ($null -ne $cliJson -and $null -ne $cliJson.PSObject.Properties['code']) { $code = [string]$cliJson.code }
    Write-Run "cut-failed: code=$code"
    $restored = Restore-Backup $backupPath $request.sessionPath $beforeSha
    $restarted = Start-App
    Write-Result ([ordered]@{
        ok = $false; status = 'cut-failed'; requestId = $request.requestId
        time = (Get-Date).ToString('o'); code = $code
        before = $(if ($null -ne $cliJson) { $cliJson.before } else { $null })
        after = $(if ($null -ne $cliJson) { $cliJson.after } else { $null })
        archivePath = $(if ($null -ne $cliJson) { $cliJson.archivePath } else { $null })
        backupPath = $backupPath; verify = $null; restored = $restored; restart = $restarted
    })
    exit 4
}

$sessionPath = [string]$cliJson.sessionPath
$expectedMessages = 0
if ($null -ne $cliJson.after -and $null -ne $cliJson.after.PSObject.Properties['messages']) {
    $expectedMessages = [int]$cliJson.after.messages
}
Write-Run "cut: ok needed=$($cliJson.needed) applied=$($cliJson.applied) afterMessages=$expectedMessages archive=$($cliJson.archivePath)"

# The plan inside the request was built from a snapshot taken while the app was
# still running; the app keeps appending for a few milliseconds after turn/end,
# so the file this run cuts can be longer than the snapshot. Report the
# difference instead of pretending the plan matched: the numbers are what the
# operator audits, and a silent mismatch is exactly the bug this field removes.
$actualBefore = $null
if ($null -ne $cliJson.before -and $null -ne $cliJson.before.PSObject.Properties['events']) {
    $actualBefore = [int]$cliJson.before.events
}
$actualAfter = $null
if ($null -ne $cliJson.after -and $null -ne $cliJson.after.PSObject.Properties['events']) {
    $actualAfter = [int]$cliJson.after.events
}
$plannedSnapshot = $null
if ($null -ne $request.plan.PSObject.Properties['snapshotEvents']) {
    $plannedSnapshot = [int]$request.plan.snapshotEvents
}
$plannedKept = $null
if ($null -ne $request.plan.PSObject.Properties['kept']) {
    $plannedKept = [int]$request.plan.kept
}
$plannedDropped = $null
if ($null -ne $request.plan.PSObject.Properties['dropped']) {
    $plannedDropped = [int]$request.plan.dropped
}
$eventsDelta = $null
if (($null -ne $plannedSnapshot) -and ($null -ne $actualBefore)) {
    $eventsDelta = $actualBefore - $plannedSnapshot
}
$keptDelta = $null
if (($null -ne $plannedKept) -and ($null -ne $actualAfter)) {
    $keptDelta = $actualAfter - $plannedKept
}
$actualDropped = $null
if (($null -ne $actualBefore) -and ($null -ne $actualAfter)) {
    $actualDropped = $actualBefore - $actualAfter
}
$drifted = $false
if (($null -ne $eventsDelta) -and ($eventsDelta -ne 0)) { $drifted = $true }
if (($null -ne $keptDelta) -and ($keptDelta -ne 0)) { $drifted = $true }
$drift = [ordered]@{
    planSnapshotEvents = $plannedSnapshot
    actualBeforeEvents = $actualBefore
    eventsDelta = $eventsDelta
    plannedKept = $plannedKept
    actualKept = $actualAfter
    keptDelta = $keptDelta
    plannedDropped = $plannedDropped
    actualDropped = $actualDropped
    drifted = $drifted
}
Write-Run "cut: drift snapshot=$plannedSnapshot actualBefore=$actualBefore eventsDelta=$eventsDelta keptDelta=$keptDelta drifted=$drifted"

$appAsar = Join-Path (Split-Path -Parent $script:AppPath) 'resources\app.asar'
$asar = Join-Path $appAsar 'dsh\node_modules'
if (-not (Test-Path -LiteralPath $appAsar -PathType Leaf)) {
    Write-Run "verify-failed: app.asar not found: $appAsar"
    $restored = Restore-Backup $backupPath $sessionPath $beforeSha
    $restarted = Start-App
    Write-Result ([ordered]@{
        ok = $false; status = 'verify-failed'; requestId = $request.requestId; time = (Get-Date).ToString('o')
        code = 'ASAR_NOT_FOUND'; before = $cliJson.before; after = $cliJson.after
        archivePath = $cliJson.archivePath; backupPath = $backupPath; verify = $null
        restored = $restored; restart = $restarted
    })
    exit 5
}

$verifyScript = Join-Path $LogDir 'verify-load.cjs'
$verifyCode = @'
const path = require('node:path');
const file = process.argv[2];
const expected = Number(process.argv[3]);
const asar = process.argv[4];
(async () => {
  const cordis = require(path.join(asar, '@deepseek-ai/cordis'));
  const persistence = require(path.join(asar, '@deepseek-ai/dsh-session-persistence-jsonl'));
  const sessionMod = require(path.join(asar, '@deepseek-ai/dsh-session'));
  const ctx = new cordis.Context();
  await ctx.plugin(persistence, { root: path.dirname(path.dirname(path.dirname(file))), compression: 'zstd' });
  const id = path.basename(path.dirname(file));
  const stored = await ctx.sessionPersistence.readStoredLog(file, id);
  const session = sessionMod.Session.fromRestore(
    stored.meta.id, stored.events, stored.meta, stored.inheritedEventCount, stored.eventState, [],
  );
  const messages = session.deriveMessages();
  const ok = messages.length === expected;
  console.log(JSON.stringify({ ok: ok, status: stored.status, events: stored.events.length, messages: messages.length, expected: expected }));
  process.exitCode = ok ? 0 : 1;
})().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: String((error && error.stack) || error) }));
  process.exitCode = 1;
});
'@
Set-Content -LiteralPath $verifyScript -Value $verifyCode -Encoding ASCII

$env:ELECTRON_RUN_AS_NODE = '1'
$verifyRun = Invoke-Native $script:AppPath @('--expose-internals', $verifyScript, $sessionPath, ([string]$expectedMessages), $asar)
$verifyOutput = $verifyRun.Output
$verifyExit = $verifyRun.ExitCode
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Write-Run "verify: exit=$verifyExit raw=$($verifyOutput.Trim())"

$verifyJson = $null
foreach ($line in ($verifyOutput -split "`r?`n")) {
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith('{')) {
        try { $verifyJson = $trimmed | ConvertFrom-Json } catch { $verifyJson = $null }
    }
}
$verifyOk = ($verifyExit -eq 0) -and ($null -ne $verifyJson) -and $verifyJson.ok
if (-not $verifyOk) {
    Write-Run 'verify-failed: load check did not confirm the rewritten log'
    $restored = Restore-Backup $backupPath $sessionPath $beforeSha
    $restarted = Start-App
    Write-Result ([ordered]@{
        ok = $false; status = 'verify-failed'; requestId = $request.requestId; time = (Get-Date).ToString('o')
        code = 'LOAD_VERIFY_FAILED'; before = $cliJson.before; after = $cliJson.after
        archivePath = $cliJson.archivePath; backupPath = $backupPath
        verify = $verifyJson; restored = $restored; restart = $restarted
    })
    exit 5
}

$restarted = Start-App
if (-not $restarted) {
    Write-Run 'restart-failed: app did not come back'
    Write-Result ([ordered]@{
        ok = $false; status = 'restart-failed'; requestId = $request.requestId; time = (Get-Date).ToString('o')
        before = $cliJson.before; after = $cliJson.after
        archivePath = $cliJson.archivePath; backupPath = $backupPath
        verify = $verifyJson; restart = $false; drift = $drift
    })
    exit 6
}

Write-Result ([ordered]@{
    ok = $true; status = 'done'; requestId = $request.requestId; time = (Get-Date).ToString('o')
    before = $cliJson.before; after = $cliJson.after
    archivePath = $cliJson.archivePath; backupPath = $backupPath
    verify = $verifyJson; restart = $true
    drift = $drift
    encoding = $(if ($unparsedStdout) { 'unparsed' } else { 'utf8-json' })
    unparsedVerification = $unparsedVerification
})
Remove-Item -LiteralPath $RequestFile -Force
Write-Run "done: request removed ($RequestFile)"
exit 0
