#!/usr/bin/env bash
# ray_cluster_manager.sh — Start/stop/status the Ray cluster
#
# Run from Neptune (Windows Git Bash or WSL):
#   bash compute/ray_cluster_manager.sh start
#   bash compute/ray_cluster_manager.sh stop
#   bash compute/ray_cluster_manager.sh status
#   bash compute/ray_cluster_manager.sh restart
#
# Jupiter is the HEAD node (192.168.0.108:6379).
# Saturn, Neptune WSL are WORKER nodes.
# Razer connects via Jobs API (Python version mismatch workaround).

RAY_HEAD="192.168.0.108"
RAY_PORT="6379"
RAY_DASH_PORT="8265"
API_KEY="qcc_node_api_2026"
JUPITER_RAY="/home/jupiter/.local/bin/ray"
SATURN_RAY="/home/saturn/.local/bin/ray"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; }

flask_exec() {
    # flask_exec <node_url> "<command>" [timeout]
    local url="$1" cmd="$2" timeout="${3:-30}"
    python3 -c "
import urllib.request, json
body = json.dumps({'command': '''${cmd}''', 'timeout': ${timeout}}).encode()
req = urllib.request.Request('${url}/exec', data=body,
      headers={'Content-Type': 'application/json', 'X-API-Key': '${API_KEY}'}, method='POST')
try:
    with urllib.request.urlopen(req, timeout=${timeout}+5) as r:
        d = json.loads(r.read())
        print(d.get('stdout','') + d.get('stderr',''))
except Exception as e:
    print('ERROR:', e)
" 2>&1
}

cmd_start() {
    echo ""
    echo "Starting Ray cluster (head: Jupiter ${RAY_HEAD}:${RAY_PORT})"
    echo "────────────────────────────────────────────────"

    # 1. Start Jupiter head
    echo "Step 1/3: Starting Ray HEAD on Jupiter..."
    out=$(flask_exec "http://${RAY_HEAD}:8765" \
        "${JUPITER_RAY} stop --force 2>&1 || true; sleep 1; ${JUPITER_RAY} start --head --port=${RAY_PORT} --dashboard-host=0.0.0.0 --dashboard-port=${RAY_DASH_PORT} --object-store-memory=4000000000 2>&1" 30)
    if echo "$out" | grep -q "Ray runtime started"; then
        ok "Jupiter HEAD started (dashboard: http://${RAY_HEAD}:${RAY_DASH_PORT})"
    else
        fail "Jupiter HEAD failed: ${out:0:100}"
    fi

    sleep 2

    # 2. Connect Saturn worker
    echo "Step 2/3: Connecting Saturn worker..."
    out=$(flask_exec "http://${RAY_HEAD}:8765" \
        "ssh -o StrictHostKeyChecking=no saturn@10.0.0.2 '${SATURN_RAY} stop --force 2>&1 || true; sleep 1; ${SATURN_RAY} start --address=${RAY_HEAD}:${RAY_PORT} --object-store-memory=2000000000 2>&1'" 30)
    if echo "$out" | grep -q "Ray runtime started"; then
        ok "Saturn worker connected"
    else
        warn "Saturn: ${out:0:80}"
    fi

    # 3. Connect Neptune WSL worker
    echo "Step 3/3: Connecting Neptune WSL (Ubuntu-22.04) worker..."
    out=$(wsl -d Ubuntu-22.04 -- bash -c \
        "ray stop --force 2>&1 || true; sleep 1; ray start --address=${RAY_HEAD}:${RAY_PORT} --object-store-memory=2000000000 2>&1" 2>&1)
    if echo "$out" | grep -q "Ray runtime started"; then
        ok "Neptune WSL worker connected"
    else
        warn "Neptune WSL: ${out:0:80}"
    fi

    sleep 2

    # Show status
    cmd_status
}

cmd_stop() {
    echo ""
    echo "Stopping Ray cluster..."
    echo "────────────────────────────────────────────────"

    # Neptune WSL
    wsl -d Ubuntu-22.04 -- ray stop --force 2>&1 | head -2
    ok "Neptune WSL: stopped"

    # Saturn (via Jupiter)
    flask_exec "http://${RAY_HEAD}:8765" \
        "ssh -o StrictHostKeyChecking=no saturn@10.0.0.2 '${SATURN_RAY} stop --force 2>&1'" 20 | head -2
    ok "Saturn: stopped"

    # Jupiter head (last — kills everything)
    flask_exec "http://${RAY_HEAD}:8765" "${JUPITER_RAY} stop --force 2>&1" 20 | head -2
    ok "Jupiter head: stopped"

    echo ""
    echo "Ray cluster stopped."
}

cmd_status() {
    echo ""
    echo "Ray Cluster Status"
    echo "────────────────────────────────────────────────"

    # Ray cluster status via Jupiter
    out=$(flask_exec "http://${RAY_HEAD}:8765" "${JUPITER_RAY} status 2>&1" 15)
    echo "$out"

    echo ""
    echo "Flask API health:"
    for node in "neptune:localhost" "razer:100.102.215.75" "uranus:100.100.83.37" "jupiter:${RAY_HEAD}"; do
        name="${node%%:*}"
        ip="${node##*:}"
        health=$(python3 -c "
import urllib.request, json
try:
    with urllib.request.urlopen('http://${ip}:8765/health', timeout=5) as r:
        d = json.loads(r.read())
        gpu = len(d.get('gpu', []))
        print(f'OK  {d.get(\"platform\",\"?\"):8s} GPU={gpu}  {d.get(\"hostname\",\"?\")}')
except Exception as e:
    print(f'ERR {str(e)[:40]}')
" 2>&1)
        echo "  ${name:0:10}: ${health}"
    done

    echo ""
    echo "Dashboard: http://${RAY_HEAD}:${RAY_DASH_PORT}"
    echo ""
}

cmd_workers() {
    echo "Reconnecting workers (head must already be running)..."
    echo "────────────────────────────────────────────────"

    out=$(flask_exec "http://${RAY_HEAD}:8765" \
        "ssh -o StrictHostKeyChecking=no saturn@10.0.0.2 '${SATURN_RAY} stop --force 2>&1; sleep 1; ${SATURN_RAY} start --address=${RAY_HEAD}:${RAY_PORT} --object-store-memory=2000000000 2>&1'" 30)
    echo "$out" | grep -E "started|failed|error" | head -3

    wsl -d Ubuntu-22.04 -- bash -c \
        "ray stop --force 2>&1; sleep 1; ray start --address=${RAY_HEAD}:${RAY_PORT} --object-store-memory=2000000000 2>&1" | grep -E "started|failed|error" | head -3

    ok "Workers reconnected. Check status with: bash compute/ray_cluster_manager.sh status"
}

case "${1:-status}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    status)  cmd_status ;;
    restart) cmd_stop; sleep 3; cmd_start ;;
    workers) cmd_workers ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|workers}"
        echo ""
        echo "  start    — Start Jupiter head + Saturn + Neptune WSL workers"
        echo "  stop     — Stop all Ray processes"
        echo "  restart  — stop + start"
        echo "  status   — Show cluster and node health"
        echo "  workers  — Reconnect workers to existing head"
        ;;
esac
