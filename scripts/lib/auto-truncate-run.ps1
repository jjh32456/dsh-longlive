#requires -Version 5.1
<#
  auto-truncate-run.ps1 - out-of-app visible truncation orchestrator.

  The in-app plugin only writes a request; this script performs the cut while
  the app is closed, verifies the rewritten log by loading it through the
  app's own Electron runtime, and restarts the app.

  Exit codes:
    0 success (or -DryRun validation only)
    2 bad-request
    3 close-failed
    4 cut-failed (backup restored when available)
    5 verify-failed (backup restored)
    6 restart-failed (cut kept, request kept)

  The script body is ASCII. Paths and log lines may contain any Unicode text.
#>
param(
    [Parameter(Mandatory = $true)][string]$MemoryRoot,
    [string]$RequestFile = '',
    [string]$AppExe = '',
    [string]$Profile = 'desktop',
    [string]$LogDir = '',
    # Vendored by resident-watcher: relaunch the app with the same arguments it
    # had before (e.g. --remote-debugging-port=9333 for the VM E2E harness).
    [string]$AppArgs = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$script:ExeName = ''

# rc.6 (R4-03): native node output is decoded as UTF-8 explicitly; the console
# code page (GBK on a Chinese Windows) must never touch it. Keep this file ASCII
# only: PS 5.1 reads UTF-8-without-BOM scripts as ANSI.
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
    # Per-run sidecar: the watcher sets DSH_TRUNCATE_RESULT_FILE so it can read
    # exactly this run's verdict even when the shared log is noisy or rotated.
    if ($script:ResultFile) {
        try {
            [System.IO.File]::WriteAllText($script:ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
        } catch {
            Write-Run "warn: cannot write result file $($script:ResultFile): $($_.Exception.Message)"
        }
    }
    Write-Run "RESULT $json"
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    # Explicit UTF-8 decoders; `& $exe @args 2>&1 | Out-String` decodes through
    # the console code page and corrupts non-ASCII JSON (R4-03).
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

function Start-App {
    try {
        if ($AppArgs) {
            Start-Process -FilePath $script:AppPath -ArgumentList $AppArgs | Out-Null
            Write-Run "restart: launched direct with args [$AppArgs] $($script:AppPath)"
        } else {
            Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('"' + $script:AppPath + '"') | Out-Null
            Write-Run "restart: launched via explorer $($script:AppPath)"
        }
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
    $procs = Get-AppProcs
    if ($procs.Count -eq 0) {
        Write-Run 'close: app is not running'
        return $true
    }
    Write-Run "close: running=$($procs.Count) names=$((($procs | ForEach-Object { $_.ProcessName }) -join ','))"
    foreach ($image in @("$($script:ExeName).exe", 'DEEPSE~1.EXE')) {
        $result = Invoke-Native 'taskkill' @('/IM', $image)
        Write-Run "close: taskkill /IM $image exit=$($result.ExitCode) out=$($result.Output.Trim())"
    }
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if ((Get-AppProcs).Count -eq 0) {
            Write-Run 'close: graceful close confirmed'
            return $true
        }
        Start-Sleep -Seconds 2
    }
    Write-Run 'close: still running after 60s, forcing'
    foreach ($image in @("$($script:ExeName).exe", 'DEEPSE~1.EXE')) {
        $result = Invoke-Native 'taskkill' @('/F', '/IM', $image)
        Write-Run "close: taskkill /F /IM $image exit=$($result.ExitCode) out=$($result.Output.Trim())"
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if ((Get-AppProcs).Count -eq 0) {
            Write-Run 'close: forced close confirmed'
            return $true
        }
        Start-Sleep -Seconds 2
    }
    $left = Get-AppProcs
    Write-Run "close: still running after force: $((($left | ForEach-Object { $_.ProcessName }) -join ','))"
    return $false
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
$script:ResultFile = ''
if ($env:DSH_TRUNCATE_RESULT_FILE) { $script:ResultFile = [string]$env:DSH_TRUNCATE_RESULT_FILE }

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
        app = $script:AppPath
        keepTurns = $keepTurns
        keepTokens = $keepTokens
        requestedPlan = $request.plan
        running = ((Get-AppProcs).Count -gt 0)
    }
    $plan | ConvertTo-Json -Depth 8
    Write-Run 'dry-run: validation passed, nothing closed or cut'
    exit 0
}

# ---------------------------------------------------------------------------
# close - cut - verify - restart
# ---------------------------------------------------------------------------
if (-not (Close-App)) {
    Write-Run 'RESULT close-failed'
    # Keep the plain line above for log compatibility, but also emit a JSON
    # result so the watcher's double-insurance check sees ok=false here too.
    Write-Result ([ordered]@{
        ok = $false; status = 'close-failed'; requestId = $request.requestId
        time = (Get-Date).ToString('o'); code = 'CLOSE_FAILED'
        before = $null; after = $null; archivePath = $null; backupPath = $null
        verify = $null; restored = $false; restart = $false
    })
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

$cliArgs = @($cli, '--session', $request.sessionPath, '--keep-turns', [string]$keepTurns,
    '--keep-tokens', [string]$keepTokens, '--confirm', 'TRUNCATE-VISIBLE')
$cliRun = Invoke-Native $nodeExe $cliArgs
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

# rc.6 (R4-03): exit 0 with unparseable stdout is not failure by itself. Verify
# the cut independently (event count from surgery-inspect) before restoring.
$unparsedStdout = ($cliExit -eq 0 -and $null -eq $cliJson)
$unparsedVerification = $null
if ($unparsedStdout) {
    $inspectScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'surgery-inspect.mjs'
    $probeJson = $null
    if (Test-Path -LiteralPath $inspectScript -PathType Leaf) {
        $probeRun = Invoke-Native $nodeExe @($inspectScript, $request.sessionPath)
        foreach ($line in ($probeRun.Output -split "`r?`n")) {
            $trimmed = $line.Trim()
            if (-not $trimmed.StartsWith('{')) { continue }
            try { $probeJson = $trimmed | ConvertFrom-Json } catch { $probeJson = $null }
        }
    }
    $planned = $null
    if ($null -ne $request.plan -and $null -ne $request.plan.PSObject.Properties['snapshotEvents']) {
        $planned = [int]$request.plan.snapshotEvents
    }
    $afterEvents = $null
    if ($null -ne $probeJson -and $probeJson.ok) { $afterEvents = [int]$probeJson.events }
    $proven = ($null -ne $planned) -and ($null -ne $afterEvents) -and ($afterEvents -lt $planned)
    $unparsedVerification = [ordered]@{
        ok = $proven; plannedEvents = $planned; afterEvents = $afterEvents
        checkedAt = (Get-Date).ToString('o')
    }
    if ($proven) {
        Write-Run "cut: cli stdout unparsed; read-back proves the cut (events -> $afterEvents, planned $planned)"
        $cliJson = [pscustomobject]@{
            ok = $true; applied = $true; needed = $true; status = 'applied-unparsed'
            encoding = 'unparsed'; sessionPath = $request.sessionPath
            before = [pscustomobject]@{ events = $planned; source = 'plan.snapshotEvents' }
            after = $probeJson; backupPath = $null; archivePath = $null
        }
    } else {
        Write-Run 'cut: cli stdout unparsed and read-back did not prove a cut; falling back to restore'
    }
}

$backupPath = $null
$beforeSha = $null
if ($null -ne $cliJson) {
    if ($null -ne $cliJson.PSObject.Properties['backupPath']) { $backupPath = [string]$cliJson.backupPath }
    if ($null -ne $cliJson.PSObject.Properties['before'] -and $null -ne $cliJson.before) {
        if ($null -ne $cliJson.before.PSObject.Properties['sha256']) { $beforeSha = [string]$cliJson.before.sha256 }
    }
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
        verify = $verifyJson; restart = $false
    })
    exit 6
}

Write-Result ([ordered]@{
    ok = $true; status = 'done'; requestId = $request.requestId; time = (Get-Date).ToString('o')
    before = $cliJson.before; after = $cliJson.after
    archivePath = $cliJson.archivePath; backupPath = $backupPath
    verify = $verifyJson; restart = $true
})
Remove-Item -LiteralPath $RequestFile -Force
Write-Run "done: request removed ($RequestFile)"
exit 0
