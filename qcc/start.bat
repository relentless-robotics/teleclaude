@echo off
REM QCC Daemon Startup Script for Windows
REM Run this to start the QCC daemon with PM2

echo === QCC Daemon Startup ===

REM Check if PM2 is installed
where pm2 >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo PM2 not found. Installing globally...
    npm install -g pm2 pm2-windows-startup
    if %ERRORLEVEL% NEQ 0 (
        echo Failed to install PM2. Falling back to direct node execution.
        echo Starting QCC daemon directly...
        node "%~dp0daemon.js"
        exit /b
    )
)

REM Check if already running
pm2 describe qcc-daemon >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo QCC daemon is already managed by PM2. Restarting...
    pm2 restart qcc-daemon
) else (
    echo Starting QCC daemon with PM2...
    pm2 start "%~dp0ecosystem.config.js"
)

REM Save PM2 process list (persists across reboots)
pm2 save

echo.
echo QCC Daemon started!
echo   Dashboard: http://localhost:3456/status
echo   Health API: http://localhost:3456/api/health
echo   Full Dashboard (Streamlit): http://localhost:8501
echo.
echo PM2 commands:
echo   pm2 logs qcc-daemon    View logs
echo   pm2 stop qcc-daemon    Stop daemon
echo   pm2 restart qcc-daemon Restart daemon
echo   pm2 monit              Monitor all processes
echo.

pause
