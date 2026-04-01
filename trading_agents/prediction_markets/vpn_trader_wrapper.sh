#!/usr/bin/env bash
###############################################################################
# vpn_trader_wrapper.sh — Start VPN, run Polymarket trader, cleanup on exit
#
# USAGE:
#   ./vpn_trader_wrapper.sh                    # paper trader (default)
#   ./vpn_trader_wrapper.sh --live             # live trader
#   ./vpn_trader_wrapper.sh --paper --min-score 80
#   ./vpn_trader_wrapper.sh --status           # just check status, then exit
#   ./vpn_trader_wrapper.sh --no-vpn           # skip VPN (for testing)
#
# This script:
#   1. Starts the WireGuard split-tunnel VPN (wg-poly)
#   2. Verifies Polymarket API is accessible
#   3. Runs paper_trader.py or live_trader.py
#   4. On exit (Ctrl+C, error, or signal), stops the VPN cleanly
#   5. Logs everything to prediction_markets/logs/
#
# PREREQUISITES:
#   - Run vpn_setup.sh --provider <proton|mullvad> first
#   - Python 3.10+ with prediction markets deps installed
#   - Must run as root (for WireGuard) or with passwordless sudo for wg-quick
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WG_IFACE="wg-poly"
LOG_DIR="${SCRIPT_DIR}/logs"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="${LOG_DIR}/trader_${TIMESTAMP}.log"
VPN_STARTED=false
TRADER_PID=""

# Defaults
MODE="paper"
EXTRA_ARGS=""
SKIP_VPN=false

###############################################################################
# LOGGING
###############################################################################
log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg" | tee -a "$LOG_FILE"
}

log_error() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*"
    echo "$msg" >&2 | tee -a "$LOG_FILE"
}

###############################################################################
# CLEANUP — runs on ANY exit (signal, error, normal)
###############################################################################
cleanup() {
    local exit_code=$?
    log "Cleanup triggered (exit code: ${exit_code})"

    # Kill trader if running
    if [[ -n "$TRADER_PID" ]]; then
        log "Stopping trader (PID: ${TRADER_PID})..."
        kill "$TRADER_PID" 2>/dev/null || true
        wait "$TRADER_PID" 2>/dev/null || true
        log "Trader stopped."
    fi

    # Stop VPN if we started it
    if $VPN_STARTED; then
        log "Stopping VPN (${WG_IFACE})..."
        if [[ "$EUID" -eq 0 ]]; then
            wg-quick down "$WG_IFACE" 2>/dev/null || true
        else
            sudo wg-quick down "$WG_IFACE" 2>/dev/null || true
        fi
        log "VPN stopped."
    fi

    log "Session ended. Log: ${LOG_FILE}"
    exit "$exit_code"
}

trap cleanup EXIT INT TERM HUP

###############################################################################
# PARSE ARGS
###############################################################################
while [[ $# -gt 0 ]]; do
    case "$1" in
        --live)
            MODE="live"
            shift
            ;;
        --paper)
            MODE="paper"
            shift
            ;;
        --no-vpn)
            SKIP_VPN=true
            shift
            ;;
        --status)
            MODE="paper"
            EXTRA_ARGS="--status"
            shift
            ;;
        --history)
            MODE="paper"
            EXTRA_ARGS="--history"
            shift
            ;;
        *)
            EXTRA_ARGS="${EXTRA_ARGS} $1"
            shift
            ;;
    esac
done

###############################################################################
# START VPN
###############################################################################
start_vpn() {
    if $SKIP_VPN; then
        log "VPN skipped (--no-vpn flag)"
        return 0
    fi

    # Check if already running
    if ip link show "$WG_IFACE" &>/dev/null; then
        log "VPN interface ${WG_IFACE} already up — reusing."
        VPN_STARTED=false  # Don't tear it down on exit if we didn't start it
        return 0
    fi

    # Check config exists
    if [[ ! -f "/etc/wireguard/${WG_IFACE}.conf" ]]; then
        log_error "WireGuard config not found at /etc/wireguard/${WG_IFACE}.conf"
        log_error "Run vpn_setup.sh --provider <proton|mullvad> first."
        exit 1
    fi

    log "Starting VPN (${WG_IFACE})..."
    if [[ "$EUID" -eq 0 ]]; then
        wg-quick up "$WG_IFACE" 2>&1 | tee -a "$LOG_FILE"
    else
        sudo wg-quick up "$WG_IFACE" 2>&1 | tee -a "$LOG_FILE"
    fi
    VPN_STARTED=true
    log "VPN started."

    # Brief pause for interface to stabilize
    sleep 2
}

###############################################################################
# VERIFY POLYMARKET ACCESS
###############################################################################
verify_access() {
    log "Verifying Polymarket API access..."

    local max_retries=3
    local retry=0

    while [[ $retry -lt $max_retries ]]; do
        local http_code
        http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
            "https://gamma-api.polymarket.com/markets?limit=1" 2>/dev/null || echo "000")

        if [[ "$http_code" == "200" ]]; then
            log "Polymarket Gamma API: HTTP 200 OK"
            break
        fi

        ((retry++))
        if [[ $retry -lt $max_retries ]]; then
            log "Gamma API returned HTTP ${http_code}, retrying (${retry}/${max_retries})..."
            sleep 3
        else
            log_error "Polymarket API unreachable after ${max_retries} attempts (HTTP ${http_code})"
            if ! $SKIP_VPN; then
                log_error "VPN may not be routing correctly. Run: sudo ./vpn_setup.sh --test"
            fi
            exit 1
        fi
    done

    # Also check CLOB
    local clob_code
    clob_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
        "https://clob.polymarket.com/time" 2>/dev/null || echo "000")
    if [[ "$clob_code" == "200" ]]; then
        log "Polymarket CLOB API: HTTP 200 OK"
    else
        log "WARNING: CLOB API returned HTTP ${clob_code} (may be OK for paper trading)"
    fi
}

###############################################################################
# RUN TRADER
###############################################################################
run_trader() {
    local script
    if [[ "$MODE" == "live" ]]; then
        script="${SCRIPT_DIR}/live_trader.py"
        log "=== LIVE TRADING MODE ==="
        log "WARNING: Real money at risk!"
    else
        script="${SCRIPT_DIR}/paper_trader.py"
        log "=== PAPER TRADING MODE ==="
    fi

    if [[ ! -f "$script" ]]; then
        log_error "Trader script not found: ${script}"
        exit 1
    fi

    local cmd="python3 ${script}"
    if [[ -n "${EXTRA_ARGS}" ]]; then
        cmd="${cmd} ${EXTRA_ARGS}"
    elif [[ "$MODE" == "paper" && -z "${EXTRA_ARGS}" ]]; then
        cmd="${cmd} --run"
    fi

    log "Running: ${cmd}"
    log "Log file: ${LOG_FILE}"
    log "---"

    # Run trader in foreground, tee output to log
    # Use exec to replace this shell — cleanup trap still fires
    ${cmd} 2>&1 | tee -a "$LOG_FILE" &
    TRADER_PID=$!

    log "Trader started (PID: ${TRADER_PID})"

    # Wait for trader to exit
    wait "$TRADER_PID"
    local trader_exit=$?
    TRADER_PID=""

    if [[ $trader_exit -eq 0 ]]; then
        log "Trader exited cleanly."
    else
        log_error "Trader exited with code ${trader_exit}"
    fi

    return $trader_exit
}

###############################################################################
# MAIN
###############################################################################
log "=========================================="
log "Polymarket VPN Trader Wrapper"
log "Mode: ${MODE}"
log "VPN: $(if $SKIP_VPN; then echo 'DISABLED'; else echo "${WG_IFACE}"; fi)"
log "=========================================="

start_vpn
verify_access
run_trader
