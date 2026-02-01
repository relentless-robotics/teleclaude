# Teleclaude Docker Build Script (PowerShell)
# Builds all Docker images for teleclaude

param(
    [switch]$Production,
    [switch]$Test,
    [switch]$All,
    [switch]$NoCache
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Teleclaude Docker Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Push-Location $projectDir

try {
    $cacheFlag = if ($NoCache) { "--no-cache" } else { "" }

    # Default to building all if no specific flag
    if (-not ($Production -or $Test -or $All)) {
        $All = $true
    }

    if ($All -or $Production) {
        Write-Host "`n[1/2] Building production image..." -ForegroundColor Yellow
        $cmd = "docker build -t teleclaude:prod -f Dockerfile $cacheFlag ."
        Write-Host "Running: $cmd" -ForegroundColor Gray
        Invoke-Expression $cmd
        if ($LASTEXITCODE -ne 0) { throw "Production build failed" }
        Write-Host "Production image built: teleclaude:prod" -ForegroundColor Green
    }

    if ($All -or $Test) {
        Write-Host "`n[2/2] Building test image..." -ForegroundColor Yellow
        $cmd = "docker build -t teleclaude:test -f Dockerfile.test $cacheFlag ."
        Write-Host "Running: $cmd" -ForegroundColor Gray
        Invoke-Expression $cmd
        if ($LASTEXITCODE -ne 0) { throw "Test build failed" }
        Write-Host "Test image built: teleclaude:test" -ForegroundColor Green
    }

    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "Build complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan

    Write-Host "`nAvailable images:" -ForegroundColor Cyan
    docker images | Select-String "teleclaude"

} catch {
    Write-Host "`nBuild failed: $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
