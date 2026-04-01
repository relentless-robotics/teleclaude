@echo off
REM =========================================================================
REM  QCC Research Agent — Razer Node launcher
REM
REM  Run once manually to register with PM2 (or just double-click to start).
REM  PM2 will restart it automatically if it crashes or the node reboots.
REM
REM  Prerequisites on Razer:
REM    1. Node.js + PM2 installed: npm install -g pm2
REM    2. Python 3.x on PATH
REM    3. pm2 startup configured (run: pm2 startup, follow instructions)
REM
REM  To install as a persistent PM2 service:
REM    pm2 start launch_agent_razer.bat --name qcc-agent-razer --interpreter none
REM    pm2 save
REM  =========================================================================

SET NODE_NAME=razer
SET QCC_HOST=100.109.245.73
SET QCC_PORT=3456
SET SCRIPTS_DIR=C:\Users\claude\Lvl3Quant\scripts
SET LOG_DIR=C:\Users\claude\Lvl3Quant\logs\research_agent
SET POLL_INTERVAL=30

REM Location of this script (assumes research_agent.py is in the same dir)
SET SCRIPT_DIR=%~dp0

echo [%DATE% %TIME%] Starting QCC Research Agent on node: %NODE_NAME%
echo QCC orchestrator: %QCC_HOST%:%QCC_PORT%
echo Scripts dir: %SCRIPTS_DIR%
echo Log dir: %LOG_DIR%

:LOOP
python "%SCRIPT_DIR%research_agent.py" ^
    --node %NODE_NAME% ^
    --qcc-host %QCC_HOST% ^
    --qcc-port %QCC_PORT% ^
    --scripts-dir "%SCRIPTS_DIR%" ^
    --log-dir "%LOG_DIR%" ^
    --poll-interval %POLL_INTERVAL%

REM If the agent exits unexpectedly, wait 10s and restart
echo [%DATE% %TIME%] Agent exited — restarting in 10 seconds...
timeout /t 10 /nobreak >nul
goto LOOP
