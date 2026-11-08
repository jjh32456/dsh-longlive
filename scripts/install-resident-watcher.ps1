#requires -Version 5.1
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RestArgs = @()
)
# Keep the historical $args contract: this script and its thin wrappers pass
# tokens such as --install / --status / --once through @args / $args.
$args = $RestArgs

# install.ps1 - thin wrapper: same flags as resident-watcher.ps1 --install
$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'resident-watcher.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $ps -NoProfile -ExecutionPolicy Bypass -File $cli --install @args
exit $LASTEXITCODE
