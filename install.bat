@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

:: ============================================
:: Claude Telegram Bridge - Windows Installer
:: Double-click this file to install everything
:: ============================================

title Claude Telegram Bridge - Installer

:: Set colors
color 0B

echo.
echo  ========================================
echo   Claude Telegram Bridge - Installer
echo  ========================================
echo.

:: Check if running as admin (optional, but helps with some installs)
net session >nul 2>&1
if %errorLevel% == 0 (
    echo  [OK] Running with administrator privileges
) else (
    echo  [!] Not running as administrator
    echo      Some installations may require admin rights.
    echo.
)

:: ============================================
:: Step 1: Check/Install Node.js
:: ============================================

echo.
echo  Step 1: Checking Node.js...
echo  ----------------------------------------

where node >nul 2>&1
if %errorLevel% == 0 (
    for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
    echo  [OK] Node.js found: !NODE_VERSION!

    :: Check if version is 18+
    for /f "tokens=1 delims=v." %%a in ("!NODE_VERSION!") do set NODE_MAJOR=%%a
    if !NODE_MAJOR! LSS 18 (
        echo  [!] Node.js version 18+ required
        echo      Current version: !NODE_VERSION!
        goto :install_node
    )
) else (
    echo  [X] Node.js not found
    goto :install_node
)
goto :node_done

:install_node
echo.
echo  Installing Node.js LTS...
echo.

:: Try winget first (Windows 10/11)
where winget >nul 2>&1
if %errorLevel% == 0 (
    echo  Using winget to install Node.js...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorLevel% == 0 (
        echo  [OK] Node.js installed via winget
        echo.
        echo  IMPORTANT: Please close and reopen this terminal,
        echo  then run install.bat again.
        echo.
        pause
        exit /b 0
    )
)

:: Fallback: Download and run installer
echo  Downloading Node.js installer...
set NODE_URL=https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi
set NODE_INSTALLER=%TEMP%\node-installer.msi

powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_INSTALLER%'}"

if exist "%NODE_INSTALLER%" (
    echo  Running Node.js installer...
    msiexec /i "%NODE_INSTALLER%" /qn /norestart
    if %errorLevel% == 0 (
        echo  [OK] Node.js installed
        echo.
        echo  IMPORTANT: Please close and reopen this terminal,
        echo  then run install.bat again.
        echo.
        del "%NODE_INSTALLER%" >nul 2>&1
        pause
        exit /b 0
    ) else (
        echo  [X] Installation failed. Please install Node.js manually:
        echo      https://nodejs.org/
        pause
        exit /b 1
    )
) else (
    echo  [X] Could not download Node.js installer
    echo      Please install Node.js manually: https://nodejs.org/
    pause
    exit /b 1
)

:node_done

:: ============================================
:: Step 2: Install npm dependencies
:: ============================================

echo.
echo  Step 2: Installing npm dependencies...
echo  ----------------------------------------

:: Check if node_modules exists
if exist "node_modules" (
    echo  [OK] Dependencies already installed
) else (
    echo  Running npm install...
    call npm install
    if %errorLevel% == 0 (
        echo  [OK] Dependencies installed
    ) else (
        echo  [X] npm install failed
        pause
        exit /b 1
    )
)

:: ============================================
:: Step 3: Check/Install Claude Code CLI
:: ============================================

echo.
echo  Step 3: Checking Claude Code CLI...
echo  ----------------------------------------

where claude >nul 2>&1
if %errorLevel% == 0 (
    for /f "tokens=*" %%i in ('claude --version 2^>nul') do set CLAUDE_VERSION=%%i
    echo  [OK] Claude Code CLI found: !CLAUDE_VERSION!
) else (
    echo  [X] Claude Code CLI not found
    echo.
    echo  Installing Claude Code CLI...
    call npm install -g @anthropic-ai/claude-code
    if %errorLevel% == 0 (
        echo  [OK] Claude Code CLI installed
    ) else (
        echo  [!] Could not install Claude Code CLI
        echo      You can install it later with:
        echo      npm install -g @anthropic-ai/claude-code
    )
)

:: ============================================
:: Step 4: Launch setup wizard
:: ============================================

echo.
echo  ========================================
echo   Installation Complete!
echo  ========================================
echo.
echo  Starting setup wizard...
echo.

call node setup.js

pause
