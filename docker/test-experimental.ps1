# Teleclaude Test Experimental Script (PowerShell)
# Spin up container for testing experimental code changes

param(
    [switch]$Interactive,
    [switch]$KeepContainer,
    [switch]$Run,
    [string]$Command = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Teleclaude Experimental Test Environment" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Push-Location $projectDir

$containerName = "teleclaude-experimental"

try {
    # Create test data directories
    Write-Host "`n[1/3] Creating test data directories..." -ForegroundColor Yellow
    $testDataDir = Join-Path $projectDir "test-data"
    New-Item -ItemType Directory -Path "$testDataDir\browser_state" -Force | Out-Null
    New-Item -ItemType Directory -Path "$testDataDir\logs" -Force | Out-Null
    New-Item -ItemType Directory -Path "$testDataDir\screenshots" -Force | Out-Null

    # Check if test image exists
    $imageExists = docker images -q teleclaude:test
    if (-not $imageExists) {
        Write-Host "`n[2/3] Building test image (not found)..." -ForegroundColor Yellow
        docker build -t teleclaude:test -f Dockerfile.test .
    } else {
        Write-Host "`n[2/3] Using existing test image..." -ForegroundColor Yellow
    }

    Write-Host "`n[3/3] Starting experimental container..." -ForegroundColor Yellow

    # Stop existing container if running
    docker rm -f $containerName 2>$null

    # Run container with mounted source code for live editing
    $dockerCmd = @"
docker run -d --name $containerName `
    -v "${projectDir}\config.json:/app/config.json:ro" `
    -v "${projectDir}\.env:/app/.env:ro" `
    -v "${projectDir}\ACCOUNTS.md:/app/ACCOUNTS.md:ro" `
    -v "${projectDir}\API_KEYS.md:/app/API_KEYS.md:ro" `
    -v "${projectDir}\CLAUDE.md:/app/CLAUDE.md:ro" `
    -v "${projectDir}\lib:/app/lib" `
    -v "${projectDir}\mcp:/app/mcp" `
    -v "${projectDir}\utils:/app/utils" `
    -v "${projectDir}\index.js:/app/index.js" `
    -v "${projectDir}\chat.js:/app/chat.js" `
    -v "${projectDir}\setup.js:/app/setup.js" `
    -v "${testDataDir}\browser_state:/app/browser_state" `
    -v "${testDataDir}\logs:/app/logs" `
    -v "${testDataDir}\screenshots:/app/screenshots" `
    -e NODE_ENV=development `
    -e DEBUG=* `
    teleclaude:test tail -f /dev/null
"@
    Invoke-Expression $dockerCmd

    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "Experimental Environment Ready" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan

    Write-Host "`nSource code is mounted - changes are reflected immediately!" -ForegroundColor Green

    Write-Host "`nUseful commands:" -ForegroundColor Cyan
    Write-Host "  docker exec -it $containerName bash" -ForegroundColor White
    Write-Host "  docker exec $containerName node index.js" -ForegroundColor White
    Write-Host "  docker exec $containerName npm test" -ForegroundColor White
    Write-Host "  docker logs -f $containerName" -ForegroundColor White
    Write-Host "  docker stop $containerName" -ForegroundColor White

    # Execute custom command if provided
    if ($Command) {
        Write-Host "`nExecuting: $Command" -ForegroundColor Yellow
        docker exec $containerName bash -c $Command
    }

    # Run the main application if requested
    if ($Run) {
        Write-Host "`nStarting teleclaude..." -ForegroundColor Yellow
        docker exec -it $containerName node index.js
    }

    if ($Interactive) {
        Write-Host "`nEntering interactive shell..." -ForegroundColor Yellow
        docker exec -it $containerName bash
    }

    if (-not $KeepContainer -and -not $Run -and -not $Interactive) {
        Write-Host "`nPress any key to stop and remove the container..." -ForegroundColor Yellow
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        docker rm -f $containerName
        Write-Host "Container removed." -ForegroundColor Green
    } elseif ($KeepContainer) {
        Write-Host "`nContainer '$containerName' is still running. Run 'docker rm -f $containerName' to remove." -ForegroundColor Yellow
    }

} catch {
    Write-Host "`nError: $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
