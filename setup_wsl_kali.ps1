# WSL2 Kali Linux Setup Script for Teleclaude Cyber Tools
# This script sets up WSL2 with Kali Linux and essential security tools

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "WSL2 Kali Linux Setup for Teleclaude" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator!" -ForegroundColor Red
    Write-Host "Right-click PowerShell and select 'Run as Administrator'" -ForegroundColor Yellow
    exit 1
}

# Step 1: Enable WSL2 Features
Write-Host "[1/5] Enabling WSL2 features..." -ForegroundColor Green

try {
    # Check if WSL is already enabled
    $wslFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
    if ($wslFeature.State -ne "Enabled") {
        Write-Host "Enabling Windows Subsystem for Linux..." -ForegroundColor Yellow
        dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
    } else {
        Write-Host "WSL feature already enabled" -ForegroundColor Green
    }

    # Enable Virtual Machine Platform
    $vmFeature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
    if ($vmFeature.State -ne "Enabled") {
        Write-Host "Enabling Virtual Machine Platform..." -ForegroundColor Yellow
        dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
    } else {
        Write-Host "Virtual Machine Platform already enabled" -ForegroundColor Green
    }

    # Set WSL 2 as default
    Write-Host "Setting WSL2 as default version..." -ForegroundColor Yellow
    wsl --set-default-version 2

} catch {
    Write-Host "WARNING: Some features may already be enabled or require restart" -ForegroundColor Yellow
}

# Step 2: Install Kali Linux
Write-Host ""
Write-Host "[2/5] Installing Kali Linux..." -ForegroundColor Green

try {
    $distros = wsl --list --quiet
    if ($distros -match "kali-linux") {
        Write-Host "Kali Linux already installed!" -ForegroundColor Green
    } else {
        Write-Host "Installing Kali Linux (this may take several minutes)..." -ForegroundColor Yellow
        wsl --install kali-linux
        Write-Host "Kali Linux installation initiated!" -ForegroundColor Green
        Write-Host "You may need to set up username/password on first launch" -ForegroundColor Yellow
    }
} catch {
    Write-Host "ERROR installing Kali Linux: $_" -ForegroundColor Red
    Write-Host "You can manually install with: wsl --install kali-linux" -ForegroundColor Yellow
}

# Step 3: Update and install security tools
Write-Host ""
Write-Host "[3/5] Setting up security tools in Kali..." -ForegroundColor Green

$setupScript = @'
#!/bin/bash
echo "Updating package lists..."
sudo apt update

echo "Installing essential security tools..."
sudo apt install -y \
    nmap \
    nikto \
    gobuster \
    metasploit-framework \
    john \
    hashcat \
    aircrack-ng \
    sqlmap \
    hydra \
    wireshark \
    tcpdump \
    netcat \
    curl \
    wget \
    git \
    python3 \
    python3-pip \
    nodejs \
    npm

echo "Installing additional tools..."
sudo apt install -y \
    masscan \
    rustscan \
    ffuf \
    wfuzz \
    dirb \
    enum4linux \
    smbclient \
    dnsutils \
    whois \
    traceroute

echo "Setting up Ghidra..."
sudo apt install -y ghidra

echo "Security tools installation complete!"
echo "Installed tools: nmap, nikto, gobuster, metasploit, john, hashcat, and more"
'@

# Save the setup script
$tempScript = "$env:TEMP\kali_setup.sh"
$setupScript | Out-File -FilePath $tempScript -Encoding UTF8 -NoNewline

# Copy to WSL and execute
Write-Host "Running setup script in Kali Linux..." -ForegroundColor Yellow
try {
    # Check if Kali is actually running/available
    $wslStatus = wsl -d kali-linux echo "ready" 2>&1
    if ($wslStatus -match "ready") {
        wsl -d kali-linux bash -c "cat > /tmp/setup.sh && chmod +x /tmp/setup.sh && /tmp/setup.sh" < $tempScript
        Write-Host "Security tools installed successfully!" -ForegroundColor Green
    } else {
        Write-Host "Kali Linux not ready yet. You can run the setup script later with:" -ForegroundColor Yellow
        Write-Host "  wsl -d kali-linux" -ForegroundColor White
        Write-Host "Then inside Kali, run the commands to install tools" -ForegroundColor White
    }
} catch {
    Write-Host "Setup script will need to be run manually after Kali is configured" -ForegroundColor Yellow
}

# Step 4: Create integration directory
Write-Host ""
Write-Host "[4/5] Setting up teleclaude integration..." -ForegroundColor Green

$teleclaude = "C:\Users\Footb\Documents\Github\teleclaude-main"

# Create directories if they don't exist
$dirs = @(
    "$teleclaude\utils",
    "$teleclaude\mcp",
    "$teleclaude\config",
    "$teleclaude\logs"
)

foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Host "Created: $dir" -ForegroundColor Gray
    }
}

Write-Host "Directory structure ready!" -ForegroundColor Green

# Step 5: Summary
Write-Host ""
Write-Host "[5/5] Setup Summary" -ForegroundColor Green
Write-Host "===================" -ForegroundColor Cyan
Write-Host ""
Write-Host "WSL2 Status:" -ForegroundColor Yellow
wsl --status

Write-Host ""
Write-Host "Installed Distributions:" -ForegroundColor Yellow
wsl --list --verbose

Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "1. If prompted, complete Kali Linux first-time setup (username/password)" -ForegroundColor White
Write-Host "2. Run: wsl -d kali-linux" -ForegroundColor White
Write-Host "3. The Node.js modules (wsl_bridge.js, cyber-tools.js) will be created next" -ForegroundColor White
Write-Host "4. Review C:\Users\Footb\Documents\Github\teleclaude-main\config\cyber_authorized_targets.json" -ForegroundColor White
Write-Host ""
Write-Host "Setup Complete!" -ForegroundColor Green
Write-Host ""
Write-Host "NOTE: You may need to restart your computer for WSL2 to work properly" -ForegroundColor Yellow
