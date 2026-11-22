<#
.SYNOPSIS
    CPU-profile the iot-agent under its current OPC UA workload.

.DESCRIPTION
    1. Restarts agent with --cpu-prof enabled (via docker-compose.profile.yml overlay).
    2. Waits for the container health check to pass.
    3. Lets the agent run under its normal workload for the specified duration.
    4. Stops the agent cleanly (SIGTERM triggers the V8 CPU profile write).
    5. Copies the .cpuprofile file from the container to ./profiles/.
    6. Reopens the agent at normal settings.
    7. Opens the profile in VS Code (built-in JavaScript Profile Viewer).

.PARAMETER DurationSec
    How long to let the agent run under load in seconds (default: 120).

.PARAMETER SkipReopen
    Do not restart the agent in normal mode after profiling. Useful when you
    want to inspect the container before bringing it back.

.EXAMPLE
    # 2-minute capture under normal OPC UA load
    .\scripts\profile-agent.ps1

.EXAMPLE
    # 5-minute capture, don't restart after
    .\scripts\profile-agent.ps1 -DurationSec 300 -SkipReopen
#>
[CmdletBinding()]
param(
    [int]    $DurationSec = 120,
    [switch] $SkipReopen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot    = $PSScriptRoot
$ProfileDir  = Join-Path $RepoRoot 'profiles'
$ComposeBase = Join-Path $RepoRoot 'docker-compose.yml'
$ComposeProf = Join-Path $RepoRoot 'docker-compose.profile.yml'
$Container   = 'iotistica-agent'

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step([string]$Msg) {
    Write-Host ""
    Write-Host "==> $Msg" -ForegroundColor Cyan
}

function Wait-Healthy([string]$Container, [int]$TimeoutSec = 120) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    while ([DateTime]::UtcNow -lt $deadline) {
        $status = docker inspect $Container --format '{{.State.Health.Status}}' 2>$null
        if ($status -eq 'healthy') { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Container $Container did not become healthy within ${TimeoutSec}s"
}

# ── Preflight ────────────────────────────────────────────────────────────────

Write-Step "Preflight"

if (-not (Test-Path $ComposeProf)) {
    throw "Compose overlay not found: $ComposeProf"
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Write-Host "  Profile output  : $ProfileDir"
Write-Host "  Capture duration: ${DurationSec}s"

# ── Start agent with profiling enabled ───────────────────────────────────────

Write-Step "Starting agent with --cpu-prof"

Push-Location $RepoRoot
try {
    docker compose -f $ComposeBase -f $ComposeProf up -d agent 2>&1 | Write-Host
} finally {
    Pop-Location
}

Write-Step "Waiting for agent to be healthy..."
Wait-Healthy $Container 120
Write-Host "  OK - agent is healthy"

# ── Wait under load ──────────────────────────────────────────────────────────

Write-Step "Capturing CPU profile for ${DurationSec}s under normal workload..."

$elapsed = 0
while ($elapsed -lt $DurationSec) {
    $remaining = $DurationSec - $elapsed
    Write-Host "`r  ${remaining}s remaining..." -NoNewline
    Start-Sleep -Seconds ([Math]::Min(10, $remaining))
    $elapsed += [Math]::Min(10, $remaining)
}
Write-Host ""

# ── Stop agent cleanly (triggers .cpuprofile write) ─────────────────────────

Write-Step "Stopping agent (triggers CPU profile write)"

# 30s timeout: gives Node's graceful shutdown time before Docker sends SIGKILL
docker stop --timeout 30 $Container | Out-Null
Write-Host "  Container stopped."

# ── Copy profile file out ─────────────────────────────────────────────────────

Write-Step "Copying .cpuprofile from container"

$TmpDump = Join-Path $env:TEMP "agent-profile-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $TmpDump | Out-Null

docker cp "${Container}:/app/data/." $TmpDump 2>&1 | Out-Null

$profiles = @(Get-ChildItem $TmpDump -Filter "*.cpuprofile")

if ($profiles.Count -eq 0) {
    Write-Warning "No .cpuprofile file found in container /app/data."
    Write-Warning "Node may not have exited cleanly (SIGKILL before profile flush)."
    Write-Host "  Check: docker logs $Container --tail 30"
} else {
    foreach ($pf in $profiles) {
        $dest = Join-Path $ProfileDir $pf.Name
        Copy-Item $pf.FullName $dest -Force
        Write-Host "  Saved: $dest" -ForegroundColor Green
    }

    # Open the most recent one in VS Code
    $latest = $profiles | Sort-Object LastWriteTime | Select-Object -Last 1
    $destLatest = Join-Path $ProfileDir $latest.Name
    Write-Host "  Opening $destLatest in VS Code..." -ForegroundColor Green
    code $destLatest
}

# ── Reopen agent at normal settings ──────────────────────────────────────────

if (-not $SkipReopen) {
    Write-Step "Restarting agent (normal mode)"
    Push-Location $RepoRoot
    try {
        docker compose up -d agent 2>&1 | Write-Host
    } finally {
        Pop-Location
    }
    Write-Host "  Agent restarted without profiling." -ForegroundColor Green
}

Write-Step "Done"
Write-Host "  Profile files in: $ProfileDir"
Write-Host "  View in VS Code : code <file>.cpuprofile"
Write-Host "  Or open Chrome DevTools -> Performance -> Load profile"
