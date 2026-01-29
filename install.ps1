# ============================================
# Claude Telegram Bridge - PowerShell Installer
# Run this script in PowerShell to install everything
# ============================================

$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "Claude Telegram Bridge - Installer"

Write-Host ""
Write-Host " ========================================" -ForegroundColor Cyan
Write-Host "  Claude Telegram Bridge - Installer" -ForegroundColor Cyan
Write-Host " ========================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Host " [OK] Running with administrator privileges" -ForegroundColor Green
} else {
    Write-Host " [!] Not running as administrator" -ForegroundColor Yellow
    Write-Host "     Some installations may require admin rights." -ForegroundColor Gray
}

# ============================================
# Step 1: Check/Install Node.js
# ============================================

Write-Host ""
Write-Host " Step 1: Checking Node.js..." -ForegroundColor Cyan
Write-Host " ----------------------------------------" -ForegroundColor Gray

$nodeInstalled = $false
$nodeVersion = $null

try {
    $nodeVersion = node --version 2>$null
    if ($nodeVersion) {
        Write-Host " [OK] Node.js found: $nodeVersion" -ForegroundColor Green

        # Check if version is 18+
        $majorVersion = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
        if ($majorVersion -lt 18) {
            Write-Host " [!] Node.js version 18+ required" -ForegroundColor Yellow
            Write-Host "     Current version: $nodeVersion" -ForegroundColor Gray
        } else {
            $nodeInstalled = $true
        }
    }
} catch {
    Write-Host " [X] Node.js not found" -ForegroundColor Red
}

if (-not $nodeInstalled) {
    Write-Host ""
    Write-Host " Installing Node.js LTS..." -ForegroundColor Yellow

    # Try winget first
    $wingetAvailable = $false
    try {
        $wingetVersion = winget --version 2>$null
        if ($wingetVersion) { $wingetAvailable = $true }
    } catch {}

    if ($wingetAvailable) {
        Write-Host " Using winget to install Node.js..." -ForegroundColor Gray
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements

        if ($LASTEXITCODE -eq 0) {
            Write-Host " [OK] Node.js installed via winget" -ForegroundColor Green
            Write-Host ""
            Write-Host " IMPORTANT: Please close and reopen PowerShell," -ForegroundColor Yellow
            Write-Host " then run install.ps1 again." -ForegroundColor Yellow
            Write-Host ""
            Read-Host " Press Enter to exit"
            exit 0
        }
    }

    # Fallback: Download and run installer
    Write-Host " Downloading Node.js installer..." -ForegroundColor Gray
    $nodeUrl = "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi"
    $nodeInstaller = "$env:TEMP\node-installer.msi"

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeInstaller -UseBasicParsing

        if (Test-Path $nodeInstaller) {
            Write-Host " Running Node.js installer..." -ForegroundColor Gray
            Start-Process msiexec.exe -Wait -ArgumentList "/i `"$nodeInstaller`" /qn /norestart"

            Remove-Item $nodeInstaller -Force -ErrorAction SilentlyContinue

            Write-Host " [OK] Node.js installed" -ForegroundColor Green
            Write-Host ""
            Write-Host " IMPORTANT: Please close and reopen PowerShell," -ForegroundColor Yellow
            Write-Host " then run install.ps1 again." -ForegroundColor Yellow
            Write-Host ""
            Read-Host " Press Enter to exit"
            exit 0
        }
    } catch {
        Write-Host " [X] Could not download Node.js installer" -ForegroundColor Red
        Write-Host "     Please install Node.js manually: https://nodejs.org/" -ForegroundColor Gray
        Read-Host " Press Enter to exit"
        exit 1
    }
}

# ============================================
# Step 2: Install npm dependencies
# ============================================

Write-Host ""
Write-Host " Step 2: Installing npm dependencies..." -ForegroundColor Cyan
Write-Host " ----------------------------------------" -ForegroundColor Gray

if (Test-Path "node_modules") {
    Write-Host " [OK] Dependencies already installed" -ForegroundColor Green
} else {
    Write-Host " Running npm install..." -ForegroundColor Gray
    npm install

    if ($LASTEXITCODE -eq 0) {
        Write-Host " [OK] Dependencies installed" -ForegroundColor Green
    } else {
        Write-Host " [X] npm install failed" -ForegroundColor Red
        Read-Host " Press Enter to exit"
        exit 1
    }
}

# ============================================
# Step 3: Check/Install Claude Code CLI
# ============================================

Write-Host ""
Write-Host " Step 3: Checking Claude Code CLI..." -ForegroundColor Cyan
Write-Host " ----------------------------------------" -ForegroundColor Gray

$claudeInstalled = $false
try {
    $claudeVersion = claude --version 2>$null
    if ($claudeVersion) {
        Write-Host " [OK] Claude Code CLI found: $claudeVersion" -ForegroundColor Green
        $claudeInstalled = $true
    }
} catch {}

if (-not $claudeInstalled) {
    Write-Host " [X] Claude Code CLI not found" -ForegroundColor Red
    Write-Host ""
    Write-Host " Installing Claude Code CLI..." -ForegroundColor Yellow

    npm install -g @anthropic-ai/claude-code

    if ($LASTEXITCODE -eq 0) {
        Write-Host " [OK] Claude Code CLI installed" -ForegroundColor Green
    } else {
        Write-Host " [!] Could not install Claude Code CLI" -ForegroundColor Yellow
        Write-Host "     You can install it later with:" -ForegroundColor Gray
        Write-Host "     npm install -g @anthropic-ai/claude-code" -ForegroundColor Gray
    }
}

# ============================================
# Step 4: Launch setup wizard
# ============================================

Write-Host ""
Write-Host " ========================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host " ========================================" -ForegroundColor Green
Write-Host ""
Write-Host " Starting setup wizard..." -ForegroundColor Cyan
Write-Host ""

node setup.js

Read-Host " Press Enter to exit"
