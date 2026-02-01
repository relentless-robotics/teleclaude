# Teleclaude Docker Cleanup Script (PowerShell)
# Removes test containers and optionally images

param(
    [switch]$All,
    [switch]$Images,
    [switch]$Volumes,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Teleclaude Docker Cleanup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Containers to clean up
$containers = @(
    "teleclaude-prod",
    "teleclaude-test",
    "teleclaude-upstream",
    "teleclaude-upstream-test",
    "teleclaude-experimental"
)

# Images to clean up
$images = @(
    "teleclaude:prod",
    "teleclaude:test",
    "teleclaude:upstream-test"
)

Write-Host "`n[1/3] Stopping and removing containers..." -ForegroundColor Yellow
foreach ($container in $containers) {
    $exists = docker ps -a --format "{{.Names}}" | Select-String -Pattern "^$container$" -Quiet
    if ($exists) {
        Write-Host "  Removing: $container" -ForegroundColor Gray
        docker rm -f $container 2>$null
    }
}
Write-Host "  Containers cleaned." -ForegroundColor Green

if ($Images -or $All) {
    Write-Host "`n[2/3] Removing images..." -ForegroundColor Yellow
    foreach ($image in $images) {
        $exists = docker images -q $image
        if ($exists) {
            if ($Force) {
                Write-Host "  Removing: $image" -ForegroundColor Gray
                docker rmi -f $image 2>$null
            } else {
                Write-Host "  Would remove: $image (use -Force to actually remove)" -ForegroundColor Gray
            }
        }
    }

    # Also clean up dangling images from teleclaude builds
    if ($Force) {
        Write-Host "  Removing dangling images..." -ForegroundColor Gray
        docker image prune -f --filter "label=org.opencontainers.image.title=Teleclaude" 2>$null
    }
    Write-Host "  Images cleaned." -ForegroundColor Green
} else {
    Write-Host "`n[2/3] Skipping image removal (use -Images or -All)" -ForegroundColor Gray
}

if ($Volumes -or $All) {
    Write-Host "`n[3/3] Cleaning up volumes..." -ForegroundColor Yellow
    if ($Force) {
        docker volume prune -f 2>$null
        Write-Host "  Volumes cleaned." -ForegroundColor Green
    } else {
        Write-Host "  Would clean volumes (use -Force to actually remove)" -ForegroundColor Gray
    }
} else {
    Write-Host "`n[3/3] Skipping volume cleanup (use -Volumes or -All)" -ForegroundColor Gray
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Cleanup complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`nRemaining teleclaude resources:" -ForegroundColor Cyan
Write-Host "`nContainers:" -ForegroundColor Yellow
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" | Select-String "teleclaude"

Write-Host "`nImages:" -ForegroundColor Yellow
docker images | Select-String "teleclaude"
