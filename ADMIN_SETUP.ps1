# ADMIN_SETUP.ps1 - Run as Administrator
# This script completes the setup that requires elevated privileges

Write-Host "=== TeleClaude Admin Setup ===" -ForegroundColor Cyan
Write-Host "This script requires Administrator privileges" -ForegroundColor Yellow
Write-Host ""

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as Administrator'" -ForegroundColor Yellow
    exit 1
}

Write-Host "Running with Administrator privileges..." -ForegroundColor Green
Write-Host ""

# ============================================
# STEP 1: Set Windows Password
# ============================================
Write-Host "=== Step 1: Setting Windows Password ===" -ForegroundColor Cyan

# Get password from password manager
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$passwordCmd = "node `"$scriptDir\password-cli.js`" get ssh-windows-neptune 2>&1"
$passwordOutput = Invoke-Expression $passwordCmd

# Extract password from output (line that starts with "Password:")
$passwordLine = $passwordOutput | Where-Object { $_ -match "^Password:" }
if ($passwordLine) {
    $newPassword = $passwordLine -replace "^Password:\s*", ""
    Write-Host "Retrieved password from manager" -ForegroundColor Green

    # Set the password
    try {
        net user Footb $newPassword
        Write-Host "Password set successfully!" -ForegroundColor Green
    } catch {
        Write-Host "Failed to set password: $_" -ForegroundColor Red
    }
} else {
    Write-Host "Could not retrieve password from manager" -ForegroundColor Red
    Write-Host "Using fallback password generation..." -ForegroundColor Yellow

    # Generate new password
    $newPassword = node -e "console.log(require('./utils/password_manager').generatePassword(28))"

    # Save it
    node -e "const pm = require('./utils/password_manager'); pm.savePassword('ssh-windows-neptune', 'Footb', '$newPassword', 'TeleClaude-Master-2026', {host: 'neptune', tailscaleIP: '100.109.245.73'})"

    # Set it
    net user Footb $newPassword
    Write-Host "New password generated and set" -ForegroundColor Green
}

Write-Host ""

# ============================================
# STEP 2: Configure SSH for Tailscale Only
# ============================================
Write-Host "=== Step 2: Configuring SSH for Tailscale Only ===" -ForegroundColor Cyan

# Check if OpenSSH Server is installed
$sshCapability = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'

if ($sshCapability.State -ne "Installed") {
    Write-Host "Installing OpenSSH Server..." -ForegroundColor Yellow
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
}

# Start and configure SSH service
Write-Host "Configuring SSH service..." -ForegroundColor Yellow
Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType 'Automatic'

# Remove existing SSH firewall rules
Write-Host "Configuring firewall for Tailscale-only SSH..." -ForegroundColor Yellow

# Remove default OpenSSH rule if it exists
Remove-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -Name "SSH-Tailscale-Only" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -Name "SSH-Block-Others" -ErrorAction SilentlyContinue

# Create rule that ONLY allows Tailscale subnet (100.x.x.x)
New-NetFirewallRule -Name "SSH-Tailscale-Only" `
    -DisplayName "SSH via Tailscale Only" `
    -Description "Allow SSH only from Tailscale network (100.0.0.0/8)" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 22 `
    -RemoteAddress 100.0.0.0/8 `
    -Action Allow `
    -Enabled True

Write-Host "SSH configured for Tailscale only (100.0.0.0/8)" -ForegroundColor Green
Write-Host ""

# ============================================
# STEP 3: Install WSL and Kali
# ============================================
Write-Host "=== Step 3: Installing WSL and Kali Linux ===" -ForegroundColor Cyan

# Check WSL status
$wslStatus = wsl --status 2>&1

if ($wslStatus -match "not recognized" -or $wslStatus -match "not installed") {
    Write-Host "Enabling WSL feature..." -ForegroundColor Yellow

    # Enable WSL feature (may require restart)
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

    Write-Host "WSL features enabled. Restart required to complete." -ForegroundColor Yellow
    $needsRestart = $true
} else {
    Write-Host "WSL is already enabled" -ForegroundColor Green
}

# Set WSL 2 as default
wsl --set-default-version 2 2>&1 | Out-Null

# Check if Kali is installed
$wslList = wsl --list 2>&1
if ($wslList -notmatch "kali") {
    Write-Host "Installing Kali Linux (this may take a while)..." -ForegroundColor Yellow

    # Install Kali without launching (--no-launch prevents interactive setup)
    wsl --install -d kali-linux --no-launch

    Write-Host "Kali Linux installation initiated" -ForegroundColor Green
} else {
    Write-Host "Kali Linux is already installed" -ForegroundColor Green
}

Write-Host ""

# ============================================
# STEP 4: Install Docker Desktop
# ============================================
Write-Host "=== Step 4: Installing Docker Desktop ===" -ForegroundColor Cyan

# Check if Docker is already installed
$dockerPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (Test-Path $dockerPath) {
    Write-Host "Docker Desktop is already installed" -ForegroundColor Green

    # Start Docker Desktop if not running
    $dockerProcess = Get-Process "Docker Desktop" -ErrorAction SilentlyContinue
    if (-not $dockerProcess) {
        Write-Host "Starting Docker Desktop..." -ForegroundColor Yellow
        Start-Process $dockerPath
    }
} else {
    Write-Host "Docker Desktop not found. Downloading installer..." -ForegroundColor Yellow

    # Download Docker Desktop installer
    $dockerInstaller = "$env:TEMP\DockerDesktopInstaller.exe"
    $dockerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"

    try {
        Invoke-WebRequest -Uri $dockerUrl -OutFile $dockerInstaller -UseBasicParsing
        Write-Host "Download complete. Installing Docker Desktop..." -ForegroundColor Yellow

        # Silent install
        Start-Process -FilePath $dockerInstaller -ArgumentList "install", "--quiet", "--accept-license" -Wait

        Write-Host "Docker Desktop installed successfully!" -ForegroundColor Green
        Write-Host "NOTE: You may need to log out and back in for Docker to work properly" -ForegroundColor Yellow
        $needsLogout = $true
    } catch {
        Write-Host "Failed to download/install Docker Desktop: $_" -ForegroundColor Red
        Write-Host "Please install Docker Desktop manually from: https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
    }
}

# Build ColorHat Docker image if Docker is available
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($dockerCmd) {
    Write-Host "Building ColorHat security container..." -ForegroundColor Yellow
    $dockerDir = Join-Path $scriptDir "docker"

    try {
        docker build -t teleclaude/colorhat:latest -f "$dockerDir\Dockerfile.colorhat" $dockerDir
        Write-Host "ColorHat container built successfully!" -ForegroundColor Green
    } catch {
        Write-Host "Failed to build ColorHat container. Docker may need a restart." -ForegroundColor Yellow
    }
}

Write-Host ""

# ============================================
# STEP 5: Summary
# ============================================
Write-Host "=== Setup Summary ===" -ForegroundColor Cyan
Write-Host ""

# Get Tailscale IP
$tailscaleIP = tailscale ip -4 2>&1

Write-Host "SSH Access Information:" -ForegroundColor Green
Write-Host "  Tailscale IP: $tailscaleIP" -ForegroundColor White
Write-Host "  Username: Footb" -ForegroundColor White
Write-Host "  Password: Stored in password manager" -ForegroundColor White
Write-Host "  Retrieve with: node password-cli.js get ssh-windows-neptune" -ForegroundColor White
Write-Host ""
Write-Host "SSH is ONLY accessible via Tailscale network" -ForegroundColor Yellow
Write-Host ""

if ($needsRestart) {
    Write-Host "IMPORTANT: A restart is required to complete WSL installation" -ForegroundColor Red
    Write-Host "After restart, run: wsl --install -d kali-linux" -ForegroundColor Yellow
}

if ($needsLogout) {
    Write-Host "IMPORTANT: Log out and back in for Docker to work properly" -ForegroundColor Red
}

Write-Host ""
Write-Host "To connect via SSH:" -ForegroundColor Cyan
Write-Host "  ssh Footb@$tailscaleIP" -ForegroundColor White
Write-Host "  ssh Footb@neptune (if Tailscale MagicDNS is enabled)" -ForegroundColor White
Write-Host ""
Write-Host "ColorHat (Security Tools):" -ForegroundColor Cyan
Write-Host "  All security tools run in Docker containers (not on host)" -ForegroundColor White
Write-Host "  Image: teleclaude/colorhat:latest" -ForegroundColor White
Write-Host "  Usage: const colorhat = require('./utils/docker_colorhat')" -ForegroundColor White
Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
