#!/usr/bin/env bash
# =============================================================================
#  QCC Research Agent — Jupiter Node launcher (WSL / Linux)
#
#  Run once to install via PM2, or execute directly.
#
#  Prerequisites on Jupiter:
#    1. Node.js + PM2:  npm install -g pm2
#    2. Python 3.x on PATH
#    3. pm2 startup:    pm2 startup  (follow the output instructions)
#
#  To install as a persistent PM2 process:
#    pm2 start /path/to/launch_agent_jupiter.sh \
#        --name qcc-agent-jupiter --interpreter bash
#    pm2 save
#
#  Or run directly (no PM2):
#    bash launch_agent_jupiter.sh
# =============================================================================

set -euo pipefail

NODE_NAME="jupiter"
QCC_HOST="100.109.245.73"
QCC_PORT="3456"
SCRIPTS_DIR="/home/jupiter/Lvl3Quant/scripts"
LOG_DIR="/home/jupiter/Lvl3Quant/logs/research_agent"
POLL_INTERVAL="30"

# Resolve the directory containing this script (works regardless of cwd)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_PY="$SCRIPT_DIR/research_agent.py"

mkdir -p "$LOG_DIR"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting QCC Research Agent on node: $NODE_NAME"
echo "QCC orchestrator : $QCC_HOST:$QCC_PORT"
echo "Scripts dir      : $SCRIPTS_DIR"
echo "Log dir          : $LOG_DIR"

while true; do
    python3 "$AGENT_PY" \
        --node "$NODE_NAME" \
        --qcc-host "$QCC_HOST" \
        --qcc-port "$QCC_PORT" \
        --scripts-dir "$SCRIPTS_DIR" \
        --log-dir "$LOG_DIR" \
        --poll-interval "$POLL_INTERVAL" || true

    # Agent exited — wait and restart (PM2 will also handle this automatically)
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Agent exited — restarting in 10 seconds..."
    sleep 10
done
