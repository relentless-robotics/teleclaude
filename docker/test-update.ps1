# Teleclaude Test Update Script (PowerShell)
# Tests upstream updates in an isolated container before applying to local

param(
    [string]$Branch = "main",
    [string]$Repo = "https://github.com/gatordevin/teleclaude.git",
    [switch]$Interactive,
    [switch]$KeepContainer
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Teleclaude Upstream Update Tester" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Branch: $Branch" -ForegroundColor Yellow
Write-Host "Repository: $Repo" -ForegroundColor Yellow

Push-Location $projectDir

$containerName = "teleclaude-upstream-test"
$tempDir = Join-Path $env:TEMP "teleclaude-upstream-$(Get-Date -Format 'yyyyMMddHHmmss')"

try {
    # Create temp directory for upstream code
    Write-Host "`n[1/5] Cloning upstream repository..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    git clone --branch $Branch --depth 1 $Repo $tempDir

    Write-Host "`n[2/5] Creating test data directories..." -ForegroundColor Yellow
    $testDataDir = Join-Path $projectDir "upstream-test-data"
    New-Item -ItemType Directory -Path "$testDataDir\browser_state" -Force | Out-Null
    New-Item -ItemType Directory -Path "$testDataDir\logs" -Force | Out-Null
    New-Item -ItemType Directory -Path "$testDataDir\screenshots" -Force | Out-Null

    Write-Host "`n[3/5] Building upstream test image..." -ForegroundColor Yellow
    docker build -t teleclaude:upstream-test -f Dockerfile.test $tempDir

    Write-Host "`n[4/5] Starting upstream test container..." -ForegroundColor Yellow

    # Stop existing container if running
    docker rm -f $containerName 2>$null

    # Run container with local protected files
    $dockerCmd = @"
docker run -d --name $containerName `
    -v "${projectDir}\config.json:/app/config.json:ro" `
    -v "${projectDir}\.env:/app/.env:ro" `
    -v "${projectDir}\ACCOUNTS.md:/app/ACCOUNTS.md:ro" `
    -v "${projectDir}\API_KEYS.md:/app/API_KEYS.md:ro" `
    -v "${projectDir}\CLAUDE.md:/app/CLAUDE.md:ro" `
    -v "${testDataDir}\browser_state:/app/browser_state" `
    -v "${testDataDir}\logs:/app/logs" `
    -v "${testDataDir}\screenshots:/app/screenshots" `
    -e NODE_ENV=development `
    -e UPSTREAM_TEST=true `
    teleclaude:upstream-test tail -f /dev/null
"@
    Invoke-Expression $dockerCmd

    Write-Host "`n[5/5] Container ready for testing!" -ForegroundColor Green
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "Upstream Test Environment Ready" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan

    Write-Host "`nUseful commands:" -ForegroundColor Cyan
    Write-Host "  docker exec -it $containerName bash" -ForegroundColor White
    Write-Host "  docker exec $containerName node index.js" -ForegroundColor White
    Write-Host "  docker logs $containerName" -ForegroundColor White
    Write-Host "  docker stop $containerName" -ForegroundColor White

    if ($Interactive) {
        Write-Host "`nEntering interactive shell..." -ForegroundColor Yellow
        docker exec -it $containerName bash
    }

    if (-not $KeepContainer) {
        Write-Host "`nPress any key to stop and remove the test container..." -ForegroundColor Yellow
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        docker rm -f $containerName
        Write-Host "Container removed." -ForegroundColor Green
    } else {
        Write-Host "`nContainer '$containerName' is still running. Run 'docker rm -f $containerName' to remove." -ForegroundColor Yellow
    }

} catch {
    Write-Host "`nError: $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
    # Cleanup temp directory
    if (Test-Path $tempDir) {
        Remove-Item -Recurse -Force $tempDir
    }
}
