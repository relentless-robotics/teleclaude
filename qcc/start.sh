#!/bin/bash
# QCC Daemon Startup Script
# Run this to start the QCC daemon with PM2

echo "=== QCC Daemon Startup ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "PM2 not found. Installing globally..."
    npm install -g pm2
    if [ $? -ne 0 ]; then
        echo "Failed to install PM2. Starting directly..."
        node "$SCRIPT_DIR/daemon.js"
        exit 1
    fi
fi

# Check if already running
if pm2 describe qcc-daemon &> /dev/null; then
    echo "QCC daemon already managed by PM2. Restarting..."
    pm2 restart qcc-daemon
else
    echo "Starting QCC daemon with PM2..."
    pm2 start "$SCRIPT_DIR/ecosystem.config.js"
fi

# Save PM2 process list
pm2 save

echo ""
echo "QCC Daemon started!"
echo "  Dashboard: http://localhost:3456/status"
echo "  Health API: http://localhost:3456/api/health"
echo "  Full Dashboard (Streamlit): http://localhost:8501"
echo ""
echo "PM2 commands:"
echo "  pm2 logs qcc-daemon    View logs"
echo "  pm2 stop qcc-daemon    Stop daemon"
echo "  pm2 restart qcc-daemon Restart daemon"
echo "  pm2 monit              Monitor all processes"
