#requires -Version 5.1
<#
.SYNOPSIS
  Unattended longlive session truncation ("surgery") with an on-disk stage file.

.DESCRIPTION
  Runs the longlive truncate CLI against one session file while the DSH host is
  closed, then restarts the host. Designed to be started by Task Scheduler with
  -WindowStyle Hidden so there is NO visible console window for the user to
  close mid-surgery.

  Stage file (atomic write, survives a killed launcher/host):
    <MemoryRoot>\.longlive\surgery-state.json

  Phases: prepare -> backup -> cut -> restart -> done | receipt-pending
          | needs-attention | failed.
  A cut whose CLI exited 0 but printed unreadable stdout is independently
  verified (sha / bytes / events / messages / backup); when it passes, the cut
  is recorded as cut.outcome "applied-unparsed" and the run still ends in
  "done" with a receipt. When it fails, the run parks at "needs-attention"
  (never a plain "failed") so nothing is retried blindly.
  -DryRun stops at a dedicated "dryrun" phase (never "done"): a rehearsal has
  no backup and no receipt, and writing "done" made the next activation report
  a missing backup for a surgery that never happened.
  On the next plugin activation, src/surgery-recovery.js reads this file and
  only reports; it never re-cuts automatically.

.PARAMETER SessionPath
  Absolute path to session.v4.jsonl.zstd. Must live under the DSH sessions root
  unless -DryRun or -AllowOutsideSessions is given.

.PARAMETER KeepTurns
  Passed to truncate-cli.mjs --keep-turns (default 12).

.PARAMETER KeepTokens
  Passed to truncate-cli.mjs --keep-tokens (default 80000).

.PARAMETER StartDelaySeconds
  Grace window between launching the script and closing the host. 30 seconds is
  deliberate: it is the time a human gets to read the last screen before the
  window disappears. This is a readability window, not a race with the host.

.PARAMETER RestartDelaySeconds
  Wait between the verified receipt and restarting the host. Default 0: after
  the read-back and the in-conversation receipt are on disk, restart at once.
  Do not confuse this with StartDelaySeconds (30).

.PARAMETER AppPath
  Absolute path to the DSH host executable. Required for a real run.

.PARAMETER ResultPath
  Where to write the result JSON. Default:
  <MemoryRoot>\.longlive\reports\surgery-result-<surgeryId>.json

.PARAMETER MemoryRoot
  longlive memory root. Default: DSH_LONGLIVE_MEMORY_ROOT, else DSH_MEM,
  else <DSH_HOME>\longlive-memory.

.PARAMETER NodeExe
  node.exe path. Default: node.exe on PATH, DSH_NODE_EXE, then the bundled
  DSH primary-runtime node.

.PARAMETER Confirm
  Real runs require -Confirm TRUNCATE-VISIBLE (the same word the CLI uses).

.PARAMETER DryRun
  Validate arguments and stop in phase "dryrun" with done.outcome "dry-run".
  Never writes phase "done". Does not close the host, copy a backup, cut, or
  restart; the startup check and --write-receipt both recognise the rehearsal.

.PARAMETER AllowOutsideSessions
  Permit a real run on a session outside the DSH sessions root (dangerous).

.EXAMPLE
  powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass `
    -File scripts\unattended-surgery.ps1 `
    -SessionPath "%USERPROFILE%\.dsh\sessions\scope\abc\session.v4.jsonl.zstd" `
    -AppPath "C:\Program Files\DSH\DSH.exe" -Confirm TRUNCATE-VISIBLE
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

  [switch]$DryRun,
  [switch]$AllowOutsideSessions
)

$ErrorActionPreference = 'Stop'

# rc.6 (R4-03): never let the console code page decide how node output is read.
# On a zh-CN Windows the console defaults to GBK; the truncate CLI prints UTF-8
# JSON that contains the first user message, so a GBK decode both corrupted the
# text and (when a trail byte swallowed a brace) broke ConvertFrom-Json. The
# script now pins every console stream to UTF-8 without a BOM and decodes node's
# stdout/stderr as UTF-8 explicitly in Invoke-NodeScript, independent of the
# system code page.
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = $script:Utf8NoBom } catch { }
try { [Console]::InputEncoding = $script:Utf8NoBom } catch { }
$OutputEncoding = $script:Utf8NoBom

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

function Get-IsoNow {
  return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Write-Log {
  param([string]$Message)
  if (-not $script:LogPath) { return }
  try {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff zzz')
    Add-Content -LiteralPath $script:LogPath -Value ("[{0}] {1}" -f $stamp, $Message) -Encoding UTF8
  } catch {
    # Logging must never take the surgery down.
  }
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-NodeExe {
  if ($NodeExe) {
    if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
      throw "node.exe not found: $NodeExe"
    }
    return (Resolve-Path -LiteralPath $NodeExe).Path
  }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  if ($env:DSH_NODE_EXE -and (Test-Path -LiteralPath $env:DSH_NODE_EXE -PathType Leaf)) {
    return (Resolve-Path -LiteralPath $env:DSH_NODE_EXE).Path
  }
  $candidate = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    return (Resolve-Path -LiteralPath $candidate).Path
  }
  throw 'node.exe not found: pass -NodeExe, put node on PATH, or set DSH_NODE_EXE.'
}

function Resolve-MemoryRoot {
  if ($MemoryRoot) { return [IO.Path]::GetFullPath($MemoryRoot) }
  if ($env:DSH_LONGLIVE_MEMORY_ROOT) { return [IO.Path]::GetFullPath($env:DSH_LONGLIVE_MEMORY_ROOT) }
  if ($env:DSH_MEM) { return [IO.Path]::GetFullPath($env:DSH_MEM) }
  $home = $env:DSH_HOME
  if (-not $home) { $home = Join-Path $env:USERPROFILE '.dsh' }
  return [IO.Path]::GetFullPath((Join-Path $home 'longlive-memory'))
}

function Read-JsonLine {
  param([string]$Text)
  if (-not $Text) { return $null }
  $lines = @($Text -split "`n")
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $trim = $lines[$i].Trim()
    if ($trim.StartsWith('{') -and $trim.EndsWith('}')) {
      try { return ($trim | ConvertFrom-Json) } catch { }
    }
  }
  return $null
}

function Quote-NativeArg {
  # Windows command-line quoting (the same rules CommandLineToArgvW parses):
  # only quote when needed, double the backslashes that precede an inner quote,
  # and double a trailing run of backslashes before the closing quote.
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value)) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq '\') { $slashes += 1; continue }
    if ($ch -eq '"') {
      [void]$builder.Append('\' * ($slashes * 2 + 1))
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) { [void]$builder.Append('\' * $slashes); $slashes = 0 }
    [void]$builder.Append($ch)
  }
  if ($slashes -gt 0) { [void]$builder.Append('\' * ($slashes * 2)) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Write-RawCapture {
  # Keep the bytes we could not parse as UTF-8 evidence next to surgery.log.
  param([string]$Text, [string]$Kind)
  if (-not $script:LogPath) { return $null }
  try {
    $dir = Split-Path -Parent $script:LogPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $name = "node-{0}-{1}-{2}.utf8.txt" -f $Kind, $script:SurgeryId, (Get-Random -Minimum 100 -Maximum 1000)
    $path = Join-Path $dir $name
    [IO.File]::WriteAllText($path, $Text, $script:Utf8NoBom)
    return $path
  } catch {
    return $null
  }
}

function Invoke-NodeScript {
  # rc.6 (R4-03): run node through System.Diagnostics.Process and decode both
  # pipes as UTF-8. `& $node ... 2>&1` goes through the console code page
  # (GBK on zh-CN), which is what corrupted the CLI JSON and the receipt text.
  # This path never consults [Console]::OutputEncoding.
  param([string[]]$ArgList)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe
  $psi.Arguments = (@($ArgList | ForEach-Object { Quote-NativeArg -Value ([string]$_) }) -join ' ')
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $script:Utf8NoBom
  $psi.StandardErrorEncoding = $script:Utf8NoBom
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  # Read both pipes asynchronously: a synchronous stdout read can deadlock when
  # stderr fills its buffer.
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit(900000)) {
    try { $proc.Kill() } catch { }
    throw "node did not exit within 900s: $($psi.FileName) $($psi.Arguments)"
  }
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  $code = $proc.ExitCode
  $proc.Dispose()
  $parts = @()
  if ($stdout) { $parts += $stdout }
  if ($stderr) { $parts += $stderr }
  $text = ($parts -join "`n").Trim()
  return @{
    exitCode = $code
    text = $text
    stdout = $stdout
    stderr = $stderr
    json = (Read-JsonLine -Text $text)
  }
}

function Invoke-Inspect {
  param([string]$Path)
  return Invoke-NodeScript -ArgList @($script:InspectScript, $Path)
}

function Get-CutArchivePath {
  # Best effort: truncate-visible writes the removed prefix to
  # "<sessionPath>.archive\<stamp>.jsonl.zstd". When the CLI JSON is unreadable
  # we still want the newest archive created at/after the cut started, for the
  # result and the receipt.
  param([string]$StartedAt)
  try {
    $archiveDir = "$script:SessionPath.archive"
    if (-not (Test-Path -LiteralPath $archiveDir -PathType Container)) { return $null }
    $since = [datetime]::MinValue
    if ($StartedAt) {
      try {
        $since = ([datetime]::Parse(
          $StartedAt,
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
        )).AddSeconds(-5)
      } catch { }
    }
    $newest = Get-ChildItem -LiteralPath $archiveDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -ge $since } |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    if ($newest) { return $newest.FullName }
  } catch { }
  return $null
}

function Test-CutLanded {
  # rc.6 (R4-03): when the CLI exits 0 but its stdout is not parseable JSON, do
  # NOT call it failed. Prove the cut from independent evidence instead:
  #   * the session parses, and its sha equals a fresh Get-FileHash of the file
  #   * the sha changed since the pre-cut snapshot
  #   * events and messages strictly decreased
  #   * the pre-surgery backup still exists and still has the before sha
  # Byte size is recorded for the log but is NOT required: the codec rewrites
  # the session with a fresh header/archive, so a small session can legitimately
  # grow a few bytes even though turns were dropped (seen in the drill: 1456 ->
  # 1509 B with 121 -> 79 events).
  # Only when every required check passes do we record "applied-unparsed".
  param(
    [hashtable]$Before,
    [string]$BackupPath,
    [string]$StartedAt
  )
  $checks = [ordered]@{
    sessionReadable = $false
    shaMatchesDisk = $false
    shaChanged = $false
    bytesDecreased = $false
    eventsDecreased = $false
    messagesDecreased = $false
    backupExists = $false
    backupMatchesBefore = $false
  }
  $inspect = Invoke-Inspect -Path $script:SessionPath
  if (-not $inspect.json -or -not $inspect.json.ok) {
    return @{ ok = $false; reason = "independent read-back failed: $($inspect.text)"; checks = $checks; after = $null; archivePath = $null }
  }
  $checks.sessionReadable = $true
  $after = @{
    bytes = [int64]$inspect.json.bytes
    events = [int64]$inspect.json.events
    messages = [int64]$inspect.json.messages
    sha256 = [string]$inspect.json.sha256
    at = (Get-IsoNow)
  }
  $diskSha = Get-Sha256 -Path $script:SessionPath
  $checks.shaMatchesDisk = ($after.sha256 -eq $diskSha)
  $checks.shaChanged = ($after.sha256 -ne [string]$Before.sha256)
  $checks.bytesDecreased = ($after.bytes -lt [int64]$Before.bytes)
  $checks.eventsDecreased = ($after.events -lt [int64]$Before.events)
  $checks.messagesDecreased = ($after.messages -lt [int64]$Before.messages)
  $checks.backupExists = (Test-Path -LiteralPath $BackupPath -PathType Leaf)
  if ($checks.backupExists) {
    $checks.backupMatchesBefore = ((Get-Sha256 -Path $BackupPath) -eq [string]$Before.sha256)
  }
  $ok = $true
  $failedOn = @()
  $required = @(
    'sessionReadable', 'shaMatchesDisk', 'shaChanged',
    'eventsDecreased', 'messagesDecreased',
    'backupExists', 'backupMatchesBefore'
  )
  foreach ($key in $required) {
    if (-not [bool]$checks[$key]) { $ok = $false; $failedOn += $key }
  }
  $reason = if ($ok) { 'all independent checks passed' } else { "checks failed: $($failedOn -join ',')" }
  return @{
    ok = $ok
    reason = $reason
    checks = $checks
    after = $after
    archivePath = (Get-CutArchivePath -StartedAt $StartedAt)
  }
}

# ---------------------------------------------------------------------------
# Stage file: one atomic JSON write per transition, plus a history trail.
# ---------------------------------------------------------------------------

function Write-State {
  param(
    [string]$Phase,
    [hashtable]$Patch = @{}
  )
  if (-not $script:State -or $script:State.Count -eq 0) { return }
  $now = Get-IsoNow
  $script:State['phase'] = $Phase
  $script:State['updatedAt'] = $now
  foreach ($key in $Patch.Keys) { $script:State[$key] = $Patch[$key] }
  $history = @()
  if ($script:State.ContainsKey('history') -and $null -ne $script:State['history']) {
    $history = @($script:State['history'])
  }
  $history += @{ phase = $Phase; at = $now }
  $script:State['history'] = $history

  $json = $script:State | ConvertTo-Json -Depth 20
  $dir = Split-Path -Parent $script:StatePath
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $tmp = "$script:StatePath.tmp-$PID"
  [IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $script:StatePath -Force
  try {
    $check = Get-Content -LiteralPath $script:StatePath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    if ($check.phase -ne $Phase) {
      Write-Log "WARN state read-back phase=$($check.phase) expected=$Phase"
    }
  } catch {
    Write-Log "WARN state read-back failed: $($_.Exception.Message)"
  }
}

function Write-Result {
  param(
    [bool]$Ok,
    [string]$Phase,
    $ErrorInfo = $null
  )
  if (-not $script:ResultPath) { return }
  $payload = @{
    version = 1
    kind = 'longlive-surgery-result'
    surgeryId = $script:SurgeryId
    at = (Get-IsoNow)
    ok = $Ok
    phase = $Phase
    dryRun = [bool]$DryRun
    sessionPath = $script:SessionPath
    memoryRoot = $script:MemoryRoot
    pluginVersion = $script:PluginVersion
    before = $script:State['before']
    backup = $script:State['backup']
    cut = $script:State['cut']
    after = $script:State['after']
    verify = $script:State['verify']
    receipt = $script:State['receipt']
    restart = $script:State['restart']
    statePath = $script:StatePath
    logPath = $script:LogPath
    error = $ErrorInfo
  }
  $json = $payload | ConvertTo-Json -Depth 20
  $dir = Split-Path -Parent $script:ResultPath
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $tmp = "$script:ResultPath.tmp-$PID"
  [IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $script:ResultPath -Force
  Write-Log "result written: $script:ResultPath ok=$Ok phase=$Phase"
}

function Fail {
  param(
    [int]$Code,
    [string]$Phase,
    [string]$Message,
    [hashtable]$Extra = @{}
  )
  Write-Log "FAIL($Code) [$Phase] $Message"
  $err = @{
    at = (Get-IsoNow)
    phase = $Phase
    message = $Message
  }
  $patch = @{ error = $err }
  foreach ($key in $Extra.Keys) { $patch[$key] = $Extra[$key] }
  try {
    Write-State 'failed' $patch
  } catch {
    Write-Log "WARN could not write failed state: $($_.Exception.Message)"
  }
  try {
    Write-Result $false $Phase $err
  } catch {
    Write-Log "WARN could not write result: $($_.Exception.Message)"
  }
  exit $Code
}

# ---------------------------------------------------------------------------
# Host process helpers
# ---------------------------------------------------------------------------

function Get-AppProcesses {
  $result = @()
  if (-not $script:AppPath) { return $result }
  $name = [IO.Path]::GetFileNameWithoutExtension($script:AppPath)
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $p.Path } catch { $path = $null }
    if ($path) {
      if ([string]::Equals($path, $script:AppPath, [StringComparison]::OrdinalIgnoreCase)) {
        $result += $p
      }
    } elseif ($p.ProcessName -eq $name) {
      $result += $p
    }
  }
  return $result
}

function Close-Host {
  $before = @(Get-AppProcesses)
  $killed = @()
  foreach ($p in $before) {
    try {
      Stop-Process -Id $p.Id -Force -ErrorAction Stop
      $killed += $p.Id
    } catch {
      Write-Log "WARN could not stop pid $($p.Id): $($_.Exception.Message)"
    }
  }
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 300
    $left = @(Get-AppProcesses)
  } while ($left.Count -gt 0 -and (Get-Date) -lt $deadline)
  # Let file handles settle after the last process disappears.
  Start-Sleep -Milliseconds 800
  $left = @(Get-AppProcesses)
  return @{
    ok = ($left.Count -eq 0)
    before = @($before | ForEach-Object { $_.Id })
    killed = $killed
    remaining = @($left | ForEach-Object { $_.Id })
    at = (Get-IsoNow)
  }
}

function Start-Host {
  Start-Process -FilePath $script:AppPath -WorkingDirectory (Split-Path -Parent $script:AppPath) | Out-Null
  $deadline = (Get-Date).AddSeconds(60)
  $procs = @()
  do {
    Start-Sleep -Milliseconds 500
    $procs = @(Get-AppProcesses)
  } while ($procs.Count -eq 0 -and (Get-Date) -lt $deadline)
  return @{
    ok = ($procs.Count -gt 0)
    count = $procs.Count
    pids = @($procs | ForEach-Object { $_.Id })
    at = (Get-IsoNow)
  }
}

function FailWithRestart {
  param(
    [int]$Code,
    [string]$Phase,
    [string]$Message
  )
  if ($script:HostClosed) {
    try {
      $restart = Start-Host
      $script:State['restart'] = $restart
      Write-Log "restart after failure ok=$($restart.ok) count=$($restart.count)"
    } catch {
      Write-Log "WARN restart after failure failed: $($_.Exception.Message)"
    }
  }
  Fail $Code $Phase $Message @{ restart = $script:State['restart'] }
}

# ---------------------------------------------------------------------------
# Argument validation (before any state file exists)
# ---------------------------------------------------------------------------

function Write-StderrAndExit {
  param([string]$Message, [int]$Code = 2)
  [Console]::Error.WriteLine($Message)
  exit $Code
}

if (-not (Test-Path -LiteralPath $SessionPath -PathType Leaf)) {
  Write-StderrAndExit "SessionPath not found: $SessionPath" 2
}
$script:SessionPath = (Resolve-Path -LiteralPath $SessionPath).Path

if ($KeepTurns -lt 1) { Write-StderrAndExit "KeepTurns must be >= 1 (got $KeepTurns)" 2 }
if ($KeepTokens -lt 1) { Write-StderrAndExit "KeepTokens must be >= 1 (got $KeepTokens)" 2 }
if ($StartDelaySeconds -lt 0 -or $StartDelaySeconds -gt 86400) {
  Write-StderrAndExit "StartDelaySeconds must be 0..86400 (got $StartDelaySeconds)" 2
}
if ($RestartDelaySeconds -lt 0 -or $RestartDelaySeconds -gt 86400) {
  Write-StderrAndExit "RestartDelaySeconds must be 0..86400 (got $RestartDelaySeconds)" 2
}
if (-not $DryRun -and $Confirm -ne 'TRUNCATE-VISIBLE') {
  Write-StderrAndExit "Refusing to cut: pass -Confirm TRUNCATE-VISIBLE (or use -DryRun)." 2
}
if (-not $DryRun -and -not $AppPath) {
  Write-StderrAndExit "Refusing to cut: pass -AppPath <DSH host exe> so the host can be restarted." 2
}
if ($AppPath) {
  if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
    Write-StderrAndExit "AppPath not found: $AppPath" 2
  }
  $script:AppPath = (Resolve-Path -LiteralPath $AppPath).Path
} else {
  $script:AppPath = ''
}

if (-not $DryRun -and -not $AllowOutsideSessions) {
  $sessionsRoot = $null
  if ($env:DSH_HOME) {
    $sessionsRoot = Join-Path $env:DSH_HOME 'sessions'
  } else {
    $sessionsRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
  }
  $rootFull = [IO.Path]::GetFullPath($sessionsRoot)
  if (-not $rootFull.EndsWith('\')) { $rootFull += '\' }
  if (-not $script:SessionPath.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Write-StderrAndExit "Refusing: SessionPath is outside the DSH sessions root ($rootFull). Use -DryRun or -AllowOutsideSessions." 2
  }
}

$script:MemoryRoot = Resolve-MemoryRoot
$script:NodeExe = Resolve-NodeExe
$script:PluginRoot = Split-Path -Parent $PSScriptRoot
$script:CliScript = Join-Path $script:PluginRoot 'scripts\truncate-cli.mjs'
$script:InspectScript = Join-Path $script:PluginRoot 'scripts\surgery-inspect.mjs'
foreach ($required in @($script:CliScript, $script:InspectScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    Write-StderrAndExit "Plugin file missing: $required" 2
  }
}

$packageJsonPath = Join-Path $script:PluginRoot 'package.json'
$script:PluginVersion = $null
if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
  try {
    $script:PluginVersion = (Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json).version
  } catch {
    $script:PluginVersion = $null
  }
}

$script:SurgeryId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + (Get-Random -Minimum 100 -Maximum 1000)
$script:StartedAt = Get-IsoNow
$longliveDir = Join-Path $script:MemoryRoot '.longlive'
$script:StatePath = Join-Path $longliveDir 'surgery-state.json'
$script:LogPath = Join-Path $longliveDir 'logs\surgery.log'
if (-not $ResultPath) {
  $ResultPath = Join-Path $longliveDir ("reports\surgery-result-{0}.json" -f $script:SurgeryId)
}
$script:ResultPath = [IO.Path]::GetFullPath($ResultPath)

foreach ($dir in @($longliveDir, (Join-Path $longliveDir 'logs'), (Join-Path $longliveDir 'reports'), (Split-Path -Parent $script:ResultPath))) {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$script:HostClosed = $false
$script:State = @{
  version = 1
  kind = 'longlive-surgery'
  surgeryId = $script:SurgeryId
  phase = 'prepare'
  startedAt = $script:StartedAt
  updatedAt = $script:StartedAt
  pid = $PID
  sessionPath = $script:SessionPath
  sessionId = (Split-Path -Leaf (Split-Path -Parent $script:SessionPath))
  memoryRoot = $script:MemoryRoot
  appPath = $script:AppPath
  keepTurns = $KeepTurns
  keepTokens = $KeepTokens
  startDelaySeconds = $StartDelaySeconds
  restartDelaySeconds = $RestartDelaySeconds
  pluginVersion = $script:PluginVersion
  hostVersion = $env:DSH_HOST_VERSION
  dryRun = [bool]$DryRun
  before = $null
  backup = $null
  cut = $null
  after = $null
  verify = $null
  receipt = $null
  restart = $null
  done = $null
  error = $null
  history = @()
}

Write-Log "start surgeryId=$($script:SurgeryId) dryRun=$([bool]$DryRun) session=$($script:SessionPath) node=$($script:NodeExe)"

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
try {
  Write-State 'prepare'

  $beforeInspect = Invoke-Inspect -Path $script:SessionPath
  if (-not $beforeInspect.json -or -not $beforeInspect.json.ok) {
    $detail = if ($beforeInspect.text) { $beforeInspect.text } else { "exit=$($beforeInspect.exitCode)" }
    Fail 2 'prepare' "Cannot read session before surgery: $detail"
  }
  $before = @{
    bytes = [int64]$beforeInspect.json.bytes
    events = [int64]$beforeInspect.json.events
    messages = [int64]$beforeInspect.json.messages
    sha256 = [string]$beforeInspect.json.sha256
    at = (Get-IsoNow)
  }
  Write-State 'prepare' @{ before = $before }
  Write-Log "before bytes=$($before.bytes) events=$($before.events) messages=$($before.messages) sha=$($before.sha256)"

  if ($DryRun) {
    $done = @{
      at = (Get-IsoNow)
      outcome = 'dry-run'
      resultPath = $script:ResultPath
    }
    # rc.4 (R3-01): a rehearsal must never write phase "done". The startup check
    # treats done as a real surgery whose backup/receipt is missing and reports
    # BACKUP_MISSING; "dryrun" is a phase of its own and every entry point
    # short-circuits on it.
    Write-State 'dryrun' @{ done = $done }
    Write-Result $true 'dryrun' $null
    Write-Log 'dry run complete; phase=dryrun (not done); no host was closed and no bytes were cut'
    exit 0
  }

  if ($StartDelaySeconds -gt 0) {
    Write-Log "waiting $StartDelaySeconds s before closing host"
    Start-Sleep -Seconds $StartDelaySeconds
  }

  $close = Close-Host
  Write-Log "close ok=$($close.ok) killed=$($close.killed -join ',') remaining=$($close.remaining -join ',')"
  if (-not $close.ok) {
    Fail 3 'prepare' "Host did not stop (remaining pids: $($close.remaining -join ','))." @{ close = $close }
  }
  $script:HostClosed = $true

  # Re-read after the host is dead: this is the exact snapshot the CLI will cut.
  $beforeInspect = Invoke-Inspect -Path $script:SessionPath
  if (-not $beforeInspect.json -or -not $beforeInspect.json.ok) {
    FailWithRestart 4 'cut' "Cannot read session after host close: $($beforeInspect.text)"
  }
  $before = @{
    bytes = [int64]$beforeInspect.json.bytes
    events = [int64]$beforeInspect.json.events
    messages = [int64]$beforeInspect.json.messages
    sha256 = [string]$beforeInspect.json.sha256
    at = (Get-IsoNow)
  }
  Write-State 'prepare' @{ before = $before }

  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $backupPath = "$($script:SessionPath).pre-surgery-$stamp"
  $suffix = 0
  while (Test-Path -LiteralPath $backupPath) {
    $suffix += 1
    $backupPath = "$($script:SessionPath).pre-surgery-$stamp-$suffix"
  }
  try {
    [IO.File]::Copy($script:SessionPath, $backupPath, $false)
    $backupSha = Get-Sha256 -Path $backupPath
    $backupBytes = (Get-Item -LiteralPath $backupPath).Length
  } catch {
    FailWithRestart 4 'backup' "Backup copy failed: $($_.Exception.Message)"
  }
  if ($backupSha -ne $before.sha256) {
    FailWithRestart 4 'backup' "Backup sha mismatch: copy=$backupSha before=$($before.sha256)"
  }
  $script:State['backup'] = @{
    path = $backupPath
    bytes = [int64]$backupBytes
    sha256 = $backupSha
    at = (Get-IsoNow)
    method = 'copy+readback-sha'
  }
  Write-State 'backup'
  Write-Log "backup path=$backupPath bytes=$backupBytes sha=$backupSha"

  # The cut is now allowed to happen. Write the phase BEFORE invoking the CLI:
  # if the launcher is killed mid-cut, recovery must see phase=cut.
  $script:State['cut'] = @{
    startedAt = (Get-IsoNow)
    before = $before
    backupPath = $backupPath
    cli = $null
  }
  Write-State 'cut'
  Write-Log "cut start keepTurns=$KeepTurns keepTokens=$KeepTokens"

  $cut = Invoke-NodeScript -ArgList @(
    $script:CliScript,
    '--session', $script:SessionPath,
    '--keep-turns', "$KeepTurns",
    '--keep-tokens', "$KeepTokens",
    '--confirm', 'TRUNCATE-VISIBLE',
    '--memory-root', $script:MemoryRoot
  )
  $script:State['cut']['cli'] = @{
    exitCode = $cut.exitCode
    text = $cut.text
    json = $cut.json
  }
  # Persist the CLI receipt before the independent read-back: if the launcher is
  # killed during verification, recovery still sees the CLI's after snapshot.
  Write-State 'cut' @{ cut = $script:State['cut'] }
  $parsedCli = ($null -ne $cut.json)
  $cliExit = [int]$cut.exitCode
  $unparsed = ($cliExit -eq 0 -and -not $parsedCli)
  $rawPath = $null
  if ($unparsed) {
    # rc.6 (R4-03): exit 0 with unreadable stdout is NOT a failure by itself.
    $rawPath = Write-RawCapture -Text $cut.text -Kind 'cut-stdout-unparsed'
    $script:State['cut']['encoding'] = @{
      unparsed = $true
      capturePath = $rawPath
      at = (Get-IsoNow)
      note = 'truncate-cli exited 0 but stdout was not one parseable JSON line (decoded as UTF-8)'
    }
    Write-State 'cut' @{ cut = $script:State['cut'] }
    Write-Log "cut exit=0 stdout-unparsed capture=$rawPath; verifying independently"
  } else {
    $logJsonOk = if ($parsedCli) { $cut.json.ok } else { $null }
    $logApplied = if ($parsedCli) { $cut.json.applied } else { $null }
    $logStatus = if ($parsedCli) { $cut.json.status } else { $null }
    Write-Log "cut exit=$cliExit jsonOk=$logJsonOk applied=$logApplied status=$logStatus"
  }

  if ($cliExit -ne 0 -or ($parsedCli -and -not $cut.json.ok)) {
    $message = "truncate-cli failed (exit=$cliExit): $($cut.text)"
    FailWithRestart 4 'cut' $message @{ cut = $script:State['cut'] }
  }

  if ($unparsed) {
    $recovery = Test-CutLanded -Before $before -BackupPath $backupPath -StartedAt $script:State['cut']['startedAt']
    $script:State['cut']['verification'] = $recovery.checks
    if (-not $recovery.ok) {
      # The cut may or may not have landed. Never report plain "failed" and
      # never retry: park the stage file at needs-attention with the evidence,
      # so a human (or the plugin report) can decide.
      $script:State['cut']['outcome'] = 'unverified'
      $attention = @{
        at = (Get-IsoNow)
        code = 'E_CUT_UNVERIFIED'
        phase = 'verify'
        message = "truncate-cli exited 0 but its JSON was unreadable and independent verification did not confirm the cut: $($recovery.reason)"
        checks = $recovery.checks
        capturePath = $rawPath
        cliText = $cut.text
      }
      Write-State 'needs-attention' @{ cut = $script:State['cut']; needsAttention = $attention }
      Write-Result $false 'needs-attention' $attention
      if ($script:HostClosed) {
        try {
          $script:State['restart'] = Start-Host
          Write-Log "restart after needs-attention ok=$($script:State['restart'].ok)"
        } catch {
          Write-Log "WARN restart after needs-attention failed: $($_.Exception.Message)"
        }
      }
      exit 7
    }
    $after = $recovery.after
    $verify = @{
      ok = $true
      method = 'independent-readback-unparsed'
      sha256 = $after.sha256
      events = $after.events
      messages = $after.messages
      cliUnparsed = $true
      checks = $recovery.checks
      at = (Get-IsoNow)
    }
    $script:State['after'] = $after
    $script:State['verify'] = $verify
    $script:State['cut']['outcome'] = 'applied-unparsed'
    $script:State['cut']['verify'] = $verify
    $script:State['cut']['archivePath'] = $recovery.archivePath
    $script:State['cut']['backupPath'] = $backupPath
    Write-State 'restart' @{ after = $after; verify = $verify; cut = $script:State['cut'] }
    Write-Log "applied-unparsed verified bytes=$($after.bytes) events=$($after.events) messages=$($after.messages) sha=$($after.sha256)"
  } else {
    $needed = $true
    if ($null -ne $cut.json.needed) { $needed = [bool]$cut.json.needed }
    if (-not $needed -or $cut.json.status -eq 'noop' -or -not $cut.json.applied) {
      # Nothing was cut. The host still has to come back up.
      $verify = @{
        ok = $true
        method = 'cli-noop'
        sha256 = $before.sha256
        events = $before.events
        messages = $before.messages
        at = (Get-IsoNow)
      }
      $script:State['verify'] = $verify
      $script:State['after'] = $before
      $script:State['cut']['outcome'] = 'noop'
      Write-State 'restart' @{ verify = $verify; after = $before }
      Write-Log 'cut reported noop; session unchanged'
    } else {
      $afterFromCli = $cut.json.after
      if (-not $afterFromCli -or -not $afterFromCli.sha256) {
        FailWithRestart 5 'verify' "truncate-cli reported applied but no after sha: $($cut.text)" @{ cut = $script:State['cut'] }
      }
      $afterInspect = Invoke-Inspect -Path $script:SessionPath
      if (-not $afterInspect.json -or -not $afterInspect.json.ok) {
        FailWithRestart 5 'verify' "Independent read-back failed: $($afterInspect.text)" @{ cut = $script:State['cut'] }
      }
      $after = @{
        bytes = [int64]$afterInspect.json.bytes
        events = [int64]$afterInspect.json.events
        messages = [int64]$afterInspect.json.messages
        sha256 = [string]$afterInspect.json.sha256
        at = (Get-IsoNow)
      }
      if ($after.sha256 -ne [string]$afterFromCli.sha256) {
        FailWithRestart 5 'verify' "Read-back sha mismatch: disk=$($after.sha256) cli=$($afterFromCli.sha256)" @{ cut = $script:State['cut']; after = $after }
      }
      if ($null -ne $afterFromCli.events -and $after.events -ne [int64]$afterFromCli.events) {
        FailWithRestart 5 'verify' "Read-back event mismatch: disk=$($after.events) cli=$($afterFromCli.events)" @{ cut = $script:State['cut']; after = $after }
      }
      if ($null -ne $afterFromCli.messages -and $after.messages -ne [int64]$afterFromCli.messages) {
        FailWithRestart 5 'verify' "Read-back message mismatch: disk=$($after.messages) cli=$($afterFromCli.messages)" @{ cut = $script:State['cut']; after = $after }
      }
      $verify = @{
        ok = $true
        method = 'independent-readback'
        sha256 = $after.sha256
        events = $after.events
        messages = $after.messages
        cliSha256 = [string]$afterFromCli.sha256
        at = (Get-IsoNow)
      }
      $script:State['after'] = $after
      $script:State['verify'] = $verify
      $script:State['cut']['outcome'] = 'applied'
      $script:State['cut']['verify'] = $verify
      $script:State['cut']['archivePath'] = $cut.json.archivePath
      $script:State['cut']['backupPath'] = $cut.json.backupPath
      Write-State 'restart' @{ after = $after; verify = $verify; cut = $script:State['cut'] }
      Write-Log "after bytes=$($after.bytes) events=$($after.events) messages=$($after.messages) sha=$($after.sha256)"
    }
  }

  # Receipt (required feature 2): after read-back verification, write the visible
  # surgery receipt into the session body. The host is closed, so this edits the
  # on-disk session file. A failed write must not block restart: the plugin
  # fallback reports it on the next start.
  $receipt = Invoke-NodeScript -ArgList @(
    $script:InspectScript,
    '--write-receipt',
    '--session', $script:SessionPath,
    '--memory-root', $script:MemoryRoot
  )
  if ($receipt.json -and $receipt.json.ok) {
    $script:State['receipt'] = $receipt.json.receipt
    Write-Log "receipt written seq=$($receipt.json.receipt.seq) bytes=$($receipt.json.receipt.after.bytes)"
  } else {
    $reason = if ($receipt.text) { $receipt.text } else { "exit=$($receipt.exitCode)" }
    # rc.6: the receipt script may have written the receipt and only its stdout
    # failed to parse. Read the stage file back (UTF-8) before declaring
    # receipt-pending; the visible receipt is the thing that matters, not stdout.
    $stateAfterReceipt = $null
    try {
      $stateAfterReceipt = Get-Content -LiteralPath $script:StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { }
    if ($stateAfterReceipt -and $stateAfterReceipt.receipt -and $stateAfterReceipt.receipt.written -eq $true) {
      $script:State['receipt'] = $stateAfterReceipt.receipt
      Write-Log "receipt recovered from stage file (stdout unparsed) seq=$($script:State['receipt'].seq)"
    } else {
      $script:State['receipt'] = @{ written = $false; at = (Get-IsoNow); via = 'surgery-script'; error = $reason }
      Write-Log "WARN receipt not written: $reason"
    }
  }
  # Flush the receipt evidence before the host comes back up.
  Write-State 'restart' @{ receipt = $script:State['receipt'] }

  if ($RestartDelaySeconds -gt 0) {
    Write-Log "waiting $RestartDelaySeconds s before restarting host"
    Start-Sleep -Seconds $RestartDelaySeconds
  }
  $restart = Start-Host
  $script:State['restart'] = $restart
  Write-Log "restart ok=$($restart.ok) count=$($restart.count) pids=$($restart.pids -join ',')"
  if (-not $restart.ok) {
    Fail 6 'restart' "Host did not come back within 60s after restart." @{ restart = $restart }
  }

  $cutOutcome = [string]$script:State['cut']['outcome']
  $outcome = 'applied-and-verified'
  if ($cutOutcome -eq 'noop') { $outcome = 'noop' }
  elseif ($cutOutcome -eq 'applied-unparsed') { $outcome = 'applied-unparsed' }
  $done = @{
    at = (Get-IsoNow)
    outcome = $outcome
    resultPath = $script:ResultPath
    verify = $script:State['verify']
  }
  # R2-02: `done` means *both* the cut and the visible receipt succeeded. If the
  # receipt could not be written, stop at `receipt-pending`; the plugin's
  # startup fallback injects it once and then marks receipt.fallbackInjected.
  $receiptWritten = ($script:State['receipt'].written -eq $true)
  if ($receiptWritten) {
    Write-State 'done' @{ done = $done; restart = $restart }
    Write-Result $true 'done' $null
    Write-Log "done outcome=$outcome"
  } else {
    $receiptPending = @{
      at = (Get-IsoNow)
      outcome = $outcome
      reason = 'receipt-not-written'
      receiptError = $script:State['receipt'].error
    }
    Write-State 'receipt-pending' @{ done = $done; restart = $restart; receipt = $script:State['receipt']; receiptPending = $receiptPending }
    Write-Result $true 'receipt-pending' $null
    Write-Log "done with receipt pending outcome=$outcome (plugin fallback will inject once)"
  }
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-Log "UNEXPECTED ERROR: $message"
  if ($script:HostClosed) {
    try {
      $restart = Start-Host
      $script:State['restart'] = $restart
      Write-Log "restart after error ok=$($restart.ok) count=$($restart.count)"
    } catch {
      Write-Log "WARN restart after error failed: $($_.Exception.Message)"
    }
  }
  Fail 1 'failed' $message @{ restart = $script:State['restart'] }
}
