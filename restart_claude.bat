@echo off
echo Killing existing node processes...
taskkill /F /IM node.exe 2>NUL
timeout /t 2 /nobreak >NUL
echo Starting watchdog...
cd /d "%~dp0"
start "TeleClaude Watchdog" cmd /k node watchdog.js
echo Watchdog started in new window.
