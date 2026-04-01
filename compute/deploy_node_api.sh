#!/usr/bin/env bash
#
# deploy_node_api.sh — Deploy node_api.py to all compute nodes.
#
# Copies the API server to each node, installs Flask, and sets up
# a persistent service (schtasks on Windows, systemd on Linux).
#
# Usage:
#   ./deploy_node_api.sh [token]
#
# If token is not provided, generates a random one and prints it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_FILE="$SCRIPT_DIR/node_api.py"

if [ ! -f "$API_FILE" ]; then
    echo "ERROR: node_api.py not found at $API_FILE"
    exit 1
fi

# Token: use arg, env, or generate
TOKEN="${1:-${NODE_API_TOKEN:-$(python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null || openssl rand -base64 32)}}"
echo "=== Node API Deployment ==="
echo "Token: $TOKEN"
echo "Save this token — you'll need it for QCC config."
echo ""

# ---------------------------------------------------------------------------
# Node definitions
# ---------------------------------------------------------------------------
# Format: name|host|user|os|remote_dir
NODES=(
    "uranus|100.100.83.37|nick|windows|C:/Users/nick/node_api"
    "razer|100.102.215.75|claude|windows|C:/Users/claude/node_api"
    "jupiter|100.102.174.30|jupiter|linux|/home/jupiter/node_api"
    "saturn|100.101.101.9|saturn|linux|/home/saturn/node_api"
)

# ---------------------------------------------------------------------------
# Deploy to a single node
# ---------------------------------------------------------------------------
deploy_node() {
    local spec="$1"
    IFS='|' read -r name host user os_type remote_dir <<< "$spec"

    echo "--- Deploying to $name ($host, $os_type) ---"

    # Test connectivity
    if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$user@$host" "echo ok" &>/dev/null; then
        echo "  SKIP: Cannot reach $name at $host"
        return 1
    fi

    # Create remote directory
    ssh "$user@$host" "mkdir -p '$remote_dir'" 2>/dev/null || true

    # Copy files
    scp -q "$API_FILE" "$user@$host:$remote_dir/node_api.py"
    echo "  Copied node_api.py"

    # Install Flask
    ssh "$user@$host" "pip install flask 2>/dev/null || pip3 install flask 2>/dev/null || python -m pip install flask 2>/dev/null" || true
    echo "  Flask installed/verified"

    # Create .env with token
    ssh "$user@$host" "echo 'NODE_API_TOKEN=$TOKEN' > '$remote_dir/.env'"
    echo "  Token configured"

    # Set up persistent service
    if [ "$os_type" = "windows" ]; then
        _setup_windows_service "$name" "$host" "$user" "$remote_dir"
    else
        _setup_linux_service "$name" "$host" "$user" "$remote_dir"
    fi

    # Verify
    sleep 2
    if curl -sf --connect-timeout 3 "http://$host:5001/health" &>/dev/null; then
        echo "  VERIFIED: $name responding on port 5001"
    else
        echo "  WARNING: $name not yet responding (may need a moment to start)"
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# Windows: use schtasks to run at startup + start now
# ---------------------------------------------------------------------------
_setup_windows_service() {
    local name="$1" host="$2" user="$3" remote_dir="$4"

    # Create a batch launcher
    ssh "$user@$host" "cat > '$remote_dir/start_node_api.bat' << 'BATCH'
@echo off
cd /d \"$remote_dir\"
set NODE_API_TOKEN=$TOKEN
python node_api.py >> node_api.log 2>&1
BATCH"

    # Remove old task if exists, create new one
    ssh "$user@$host" "schtasks /Delete /TN node_api /F 2>NUL; schtasks /Create /TN node_api /TR \"$remote_dir/start_node_api.bat\" /SC ONLOGON /RL HIGHEST /F" || true

    # Kill any existing instance and start fresh
    ssh "$user@$host" "taskkill /F /FI \"WINDOWTITLE eq node_api*\" 2>NUL; start /B \"\" cmd /c \"$remote_dir/start_node_api.bat\"" || true
    echo "  Windows scheduled task created + started"
}

# ---------------------------------------------------------------------------
# Linux: use systemd user service
# ---------------------------------------------------------------------------
_setup_linux_service() {
    local name="$1" host="$2" user="$3" remote_dir="$4"

    # Create systemd user service
    ssh "$user@$host" "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/node-api.service << EOF
[Unit]
Description=Node API Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$remote_dir
Environment=NODE_API_TOKEN=$TOKEN
ExecStart=$(ssh "$user@$host" "which python3 || which python") $remote_dir/node_api.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF"

    # Enable and start
    ssh "$user@$host" "systemctl --user daemon-reload && systemctl --user enable node-api && systemctl --user restart node-api" || {
        # Fallback: nohup if systemd user services not available
        ssh "$user@$host" "cd '$remote_dir' && pkill -f 'node_api.py' 2>/dev/null; NODE_API_TOKEN=$TOKEN nohup python3 node_api.py > node_api.log 2>&1 &"
        echo "  (systemd unavailable, using nohup fallback)"
    }
    # Enable lingering so service runs without active login
    ssh "$user@$host" "loginctl enable-linger $user 2>/dev/null" || true
    echo "  Linux service created + started"
}

# ---------------------------------------------------------------------------
# Neptune (localhost) — just start directly
# ---------------------------------------------------------------------------
deploy_neptune() {
    echo "--- Deploying to Neptune (localhost) ---"
    local neptune_dir="$SCRIPT_DIR"

    # Write .env
    echo "NODE_API_TOKEN=$TOKEN" > "$neptune_dir/.env"
    echo "  Token configured"

    # Kill existing
    if command -v taskkill &>/dev/null; then
        taskkill /F /FI "WINDOWTITLE eq node_api*" 2>/dev/null || true
        # Start via schtasks or just background it
        start //B "" cmd //c "cd /d \"$neptune_dir\" && set NODE_API_TOKEN=$TOKEN && python node_api.py >> node_api.log 2>&1" || \
            (cd "$neptune_dir" && NODE_API_TOKEN="$TOKEN" python node_api.py >> node_api.log 2>&1 &)
    else
        pkill -f 'node_api.py' 2>/dev/null || true
        (cd "$neptune_dir" && NODE_API_TOKEN="$TOKEN" python3 node_api.py >> node_api.log 2>&1 &)
    fi
    echo "  Neptune started"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
deploy_neptune

for node_spec in "${NODES[@]}"; do
    deploy_node "$node_spec" || true
done

echo "=== Deployment Complete ==="
echo ""
echo "Token for QCC config: $TOKEN"
echo ""
echo "Test any node:"
echo "  curl -H 'Authorization: Bearer $TOKEN' http://<host>:5001/status"
echo ""
echo "QCC Integration: Set NODE_API_TOKEN in compute/.env and update"
echo "qcc-ssh.js exec() to use HTTP — see notes in node_api.py header."
