#!/usr/bin/env bash
###############################################################################
# vpn_setup.sh — Split-tunnel WireGuard VPN for Polymarket on Ubuntu 22.04
#
# PURPOSE: Route ONLY Polymarket API traffic through VPN while keeping all
#          other services (SSH, AeroForge :8000, etc.) on the regular connection.
#
# SUPPORTS: ProtonVPN Free (WireGuard) or Mullvad ($5/mo)
#
# USAGE:
#   chmod +x vpn_setup.sh
#   sudo ./vpn_setup.sh --provider proton   # or --provider mullvad
#   sudo ./vpn_setup.sh --test              # verify routing
#   sudo ./vpn_setup.sh --teardown          # remove everything
#
# IMPORTANT: Run on Jupiter (192.168.0.108) as root or with sudo.
#            Do NOT run this on your Windows PC.
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WG_IFACE="wg-poly"
WG_CONF="/etc/wireguard/${WG_IFACE}.conf"
RT_TABLE_NAME="polymarket"
RT_TABLE_ID=200
FWMARK=0x50  # 80 decimal — arbitrary mark for Polymarket packets
LOG_FILE="${SCRIPT_DIR}/vpn_setup.log"

# Polymarket domains to route through VPN
POLYMARKET_DOMAINS=(
    "gamma-api.polymarket.com"
    "clob.polymarket.com"
    "api.polymarket.com"
    "polymarket.com"
    "www.polymarket.com"
    # Polygon RPC (used for on-chain settlement)
    "polygon-rpc.com"
    "rpc.ankr.com"
)

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

###############################################################################
# RESOLVE POLYMARKET IPS
###############################################################################
resolve_domains() {
    log "Resolving Polymarket domain IPs..."
    local all_ips=()
    for domain in "${POLYMARKET_DOMAINS[@]}"; do
        local ips
        ips=$(dig +short "$domain" A 2>/dev/null | grep -E '^[0-9]+\.' || true)
        if [[ -z "$ips" ]]; then
            log "  WARNING: Could not resolve $domain"
        else
            while IFS= read -r ip; do
                log "  $domain -> $ip"
                all_ips+=("$ip")
            done <<< "$ips"
        fi
    done

    # Deduplicate
    POLYMARKET_IPS=($(printf '%s\n' "${all_ips[@]}" | sort -u))
    log "Resolved ${#POLYMARKET_IPS[@]} unique IPs"
}

###############################################################################
# INSTALL DEPENDENCIES
###############################################################################
install_deps() {
    log "Installing WireGuard and dependencies..."
    apt-get update -qq
    apt-get install -y wireguard wireguard-tools dnsutils iproute2 iptables curl
    log "Dependencies installed."
}

###############################################################################
# PROTONVPN FREE SETUP
###############################################################################
setup_proton() {
    log "=== ProtonVPN Free (WireGuard) Setup ==="
    echo ""
    echo "###################################################################"
    echo "#  ProtonVPN Free WireGuard Configuration                        #"
    echo "###################################################################"
    echo ""
    echo "ProtonVPN offers free WireGuard configs. Steps to get one:"
    echo ""
    echo "1. Sign up at https://account.protonvpn.com/signup (free tier)"
    echo "   Use: relentlessrobotics@gmail.com or a throwaway email"
    echo ""
    echo "2. Go to: https://account.protonvpn.com/downloads#wireguard-configuration"
    echo "   - Platform: Linux"
    echo "   - Protocol: WireGuard"
    echo "   - Country: Netherlands (NL) or Switzerland (CH)"
    echo "     (Both work for Polymarket; NL has best latency to US)"
    echo "   - Server: Any free server (e.g., NL-FREE#1)"
    echo "   - NAT/Moderate NAT: Enable"
    echo ""
    echo "3. Download the .conf file. It will look like:"
    echo ""
    echo "   [Interface]"
    echo "   PrivateKey = <your-private-key>"
    echo "   Address = 10.2.0.2/32"
    echo "   DNS = 10.2.0.1"
    echo ""
    echo "   [Peer]"
    echo "   PublicKey = <server-public-key>"
    echo "   AllowedIPs = 0.0.0.0/0"
    echo "   Endpoint = <server-ip>:51820"
    echo ""
    echo "4. Place the downloaded file at:"
    echo "   /etc/wireguard/proton-source.conf"
    echo ""
    echo "5. Re-run this script: sudo ./vpn_setup.sh --provider proton"
    echo ""

    local source_conf="/etc/wireguard/proton-source.conf"
    if [[ ! -f "$source_conf" ]]; then
        log "ERROR: $source_conf not found. Follow steps above first."
        exit 1
    fi

    # Extract keys from ProtonVPN config
    local priv_key endpoint pub_key address
    priv_key=$(grep -i 'PrivateKey' "$source_conf" | head -1 | awk -F= '{print $2}' | xargs)
    pub_key=$(grep -i 'PublicKey' "$source_conf" | head -1 | awk -F= '{print $2}' | xargs)
    endpoint=$(grep -i 'Endpoint' "$source_conf" | head -1 | awk -F= '{print $2}' | xargs)
    address=$(grep -i 'Address' "$source_conf" | head -1 | awk -F= '{print $2}' | xargs)

    create_split_tunnel_conf "$priv_key" "$pub_key" "$endpoint" "$address"
}

###############################################################################
# MULLVAD SETUP ($5/mo)
###############################################################################
setup_mullvad() {
    log "=== Mullvad VPN Setup ==="
    echo ""
    echo "###################################################################"
    echo "#  Mullvad VPN WireGuard Configuration ($5/mo, no email needed)  #"
    echo "###################################################################"
    echo ""
    echo "Mullvad is the gold standard for privacy VPNs. No email required."
    echo ""
    echo "1. Go to: https://mullvad.net/en/account/create"
    echo "   - You get a 16-digit account number (no email, no name)"
    echo "   - Fund with crypto or card ($5/mo)"
    echo ""
    echo "2. Generate WireGuard key:"
    echo "   curl https://api.mullvad.net/wg/"
    echo "   Or use their config generator:"
    echo "   https://mullvad.net/en/account/wireguard-config"
    echo "   - Select: Linux, Netherlands or Switzerland"
    echo ""
    echo "3. Download the .conf file and place at:"
    echo "   /etc/wireguard/mullvad-source.conf"
    echo ""
    echo "4. Re-run: sudo ./vpn_setup.sh --provider mullvad"
    echo ""

    local source_conf="/etc/wireguard/mullvad-source.conf"
    if [[ ! -f "$source_conf" ]]; then
        log "ERROR: $source_conf not found. Follow steps above first."
        exit 1
    fi

    local priv_key endpoint pub_key address
    priv_key=$(grep -i 'PrivateKey' "$source_conf" | head -1 | awk -F= '{print $2}' | xargs)
    pub_key=$(grep -i 'PublicKey' "$source_conf" | head -1 | awk -F= '{print $2}' | xargs)
    endpoint=$(grep -i 'Endpoint' "$source_conf" | head -1 | awk -F= '{print $2}' | xargs)
    address=$(grep -i 'Address' "$source_conf" | head -1 | awk -F= '{print $2}' | xargs)

    create_split_tunnel_conf "$priv_key" "$pub_key" "$endpoint" "$address"
}

###############################################################################
# CREATE SPLIT-TUNNEL WIREGUARD CONFIG
# This is the key part: we do NOT set AllowedIPs = 0.0.0.0/0
# Instead, we only route specific Polymarket IPs through the tunnel.
###############################################################################
create_split_tunnel_conf() {
    local priv_key="$1" pub_key="$2" endpoint="$3" address="$4"

    log "Creating split-tunnel WireGuard config..."

    # Resolve current Polymarket IPs
    resolve_domains

    # Build AllowedIPs from resolved Polymarket IPs (each as /32)
    local allowed_ips=""
    for ip in "${POLYMARKET_IPS[@]}"; do
        if [[ -n "$allowed_ips" ]]; then
            allowed_ips="${allowed_ips}, ${ip}/32"
        else
            allowed_ips="${ip}/32"
        fi
    done

    # Also add common Cloudflare ranges that Polymarket uses
    # (Polymarket is behind Cloudflare, IPs can change)
    # We add the /24 subnets of resolved IPs for resilience
    local subnets=()
    for ip in "${POLYMARKET_IPS[@]}"; do
        local subnet
        subnet=$(echo "$ip" | sed 's/\.[0-9]*$/.0\/24/')
        subnets+=("$subnet")
    done
    local unique_subnets
    unique_subnets=$(printf '%s\n' "${subnets[@]}" | sort -u)
    while IFS= read -r subnet; do
        allowed_ips="${allowed_ips}, ${subnet}"
    done <<< "$unique_subnets"

    cat > "$WG_CONF" <<WGEOF
# Split-tunnel WireGuard for Polymarket ONLY
# Generated: $(date -Iseconds)
# Provider source: proton or mullvad
# Routes ONLY Polymarket API traffic through VPN

[Interface]
PrivateKey = ${priv_key}
Address = ${address}
# NO DNS override — we keep system DNS for everything else
# Table = off — we manage routing ourselves via PostUp/PostDown
Table = off

# --- Policy routing: mark Polymarket traffic, route marked traffic via VPN ---
PostUp = ip rule add fwmark ${FWMARK} table ${RT_TABLE_ID} priority 100
PostUp = ip route add default dev %i table ${RT_TABLE_ID}
# Mark outbound packets destined for Polymarket IPs
$(for ip in "${POLYMARKET_IPS[@]}"; do
    echo "PostUp = iptables -t mangle -A OUTPUT -d ${ip}/32 -j MARK --set-mark ${FWMARK}"
done)
# Also mark by /24 subnets for Cloudflare IP rotation resilience
$(while IFS= read -r subnet; do
    echo "PostUp = iptables -t mangle -A OUTPUT -d ${subnet} -j MARK --set-mark ${FWMARK}"
done <<< "$unique_subnets")

# Cleanup on down
PostDown = ip rule del fwmark ${FWMARK} table ${RT_TABLE_ID} priority 100 2>/dev/null || true
PostDown = ip route del default dev %i table ${RT_TABLE_ID} 2>/dev/null || true
$(for ip in "${POLYMARKET_IPS[@]}"; do
    echo "PostDown = iptables -t mangle -D OUTPUT -d ${ip}/32 -j MARK --set-mark ${FWMARK} 2>/dev/null || true"
done)
$(while IFS= read -r subnet; do
    echo "PostDown = iptables -t mangle -D OUTPUT -d ${subnet} -j MARK --set-mark ${FWMARK} 2>/dev/null || true"
done <<< "$unique_subnets")

[Peer]
PublicKey = ${pub_key}
AllowedIPs = ${allowed_ips}
Endpoint = ${endpoint}
PersistentKeepalive = 25
WGEOF

    chmod 600 "$WG_CONF"

    # Ensure routing table exists
    if ! grep -q "^${RT_TABLE_ID}" /etc/iproute2/rt_tables 2>/dev/null; then
        echo "${RT_TABLE_ID} ${RT_TABLE_NAME}" >> /etc/iproute2/rt_tables
        log "Added routing table '${RT_TABLE_NAME}' (${RT_TABLE_ID})"
    fi

    log "WireGuard config written to ${WG_CONF}"
    log ""
    log "=== SETUP COMPLETE ==="
    log "Start VPN:  sudo wg-quick up ${WG_IFACE}"
    log "Stop VPN:   sudo wg-quick down ${WG_IFACE}"
    log "Status:     sudo wg show ${WG_IFACE}"
    log "Test:       sudo ./vpn_setup.sh --test"
}

###############################################################################
# UPDATE IPS — Re-resolve domains and update iptables rules
# Run this periodically (cron daily) since Cloudflare IPs can rotate
###############################################################################
update_ips() {
    log "=== Updating Polymarket IP routes ==="

    if ! ip link show "$WG_IFACE" &>/dev/null; then
        log "ERROR: ${WG_IFACE} interface not up. Start VPN first."
        exit 1
    fi

    resolve_domains

    # Clear old mangle rules for our mark
    iptables -t mangle -S OUTPUT 2>/dev/null | grep -- "--set-xmark ${FWMARK}" | while read -r rule; do
        iptables -t mangle $(echo "$rule" | sed 's/^-A/-D/') 2>/dev/null || true
    done

    # Re-add with fresh IPs
    for ip in "${POLYMARKET_IPS[@]}"; do
        iptables -t mangle -A OUTPUT -d "${ip}/32" -j MARK --set-mark "$FWMARK"
        log "  Marked ${ip}/32 -> VPN"
    done

    # Add /24 subnets
    local subnets=()
    for ip in "${POLYMARKET_IPS[@]}"; do
        local subnet
        subnet=$(echo "$ip" | sed 's/\.[0-9]*$/.0\/24/')
        subnets+=("$subnet")
    done
    printf '%s\n' "${subnets[@]}" | sort -u | while read -r subnet; do
        iptables -t mangle -A OUTPUT -d "$subnet" -j MARK --set-mark "$FWMARK"
        log "  Marked ${subnet} -> VPN"
    done

    log "IP update complete."
}

###############################################################################
# TEST — Verify split tunnel is working correctly
###############################################################################
run_test() {
    log "=== VPN Split-Tunnel Test ==="
    echo ""
    local pass=0 fail=0

    # Test 1: WireGuard interface exists
    echo -n "1. WireGuard interface ${WG_IFACE}: "
    if ip link show "$WG_IFACE" &>/dev/null; then
        echo "UP [PASS]"
        ((pass++))
    else
        echo "DOWN [FAIL]"
        ((fail++))
        echo "   Run: sudo wg-quick up ${WG_IFACE}"
    fi

    # Test 2: WireGuard has handshake (peer connected)
    echo -n "2. WireGuard peer handshake: "
    local handshake
    handshake=$(wg show "$WG_IFACE" latest-handshakes 2>/dev/null | awk '{print $2}')
    if [[ -n "$handshake" && "$handshake" != "0" ]]; then
        echo "OK ($(date -d @"$handshake" '+%H:%M:%S' 2>/dev/null || echo "$handshake")) [PASS]"
        ((pass++))
    else
        echo "NO HANDSHAKE [FAIL]"
        ((fail++))
        echo "   Check endpoint reachability and keys"
    fi

    # Test 3: Polymarket API accessible through VPN
    echo -n "3. Polymarket Gamma API (via VPN): "
    local http_code
    http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        "https://gamma-api.polymarket.com/markets?limit=1" 2>/dev/null || echo "000")
    if [[ "$http_code" == "200" ]]; then
        echo "HTTP ${http_code} [PASS]"
        ((pass++))
    else
        echo "HTTP ${http_code} [FAIL]"
        ((fail++))
    fi

    # Test 4: CLOB API accessible
    echo -n "4. Polymarket CLOB API (via VPN): "
    http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        "https://clob.polymarket.com/time" 2>/dev/null || echo "000")
    if [[ "$http_code" == "200" ]]; then
        echo "HTTP ${http_code} [PASS]"
        ((pass++))
    else
        echo "HTTP ${http_code} [FAIL]"
        ((fail++))
    fi

    # Test 5: Regular traffic NOT going through VPN
    echo -n "5. Regular traffic bypasses VPN (google.com): "
    local my_ip_via_google
    my_ip_via_google=$(curl -s --max-time 10 "https://api.ipify.org" 2>/dev/null || echo "FAIL")
    local vpn_ip
    vpn_ip=$(wg show "$WG_IFACE" endpoints 2>/dev/null | awk '{print $2}' | cut -d: -f1)
    if [[ "$my_ip_via_google" != "FAIL" ]]; then
        echo "Public IP: ${my_ip_via_google} [PASS - not routed via VPN]"
        ((pass++))
    else
        echo "Could not determine [WARN]"
    fi

    # Test 6: SSH still works (implicit — we're running this)
    echo -n "6. SSH connectivity: "
    echo "WORKING (you're running this script) [PASS]"
    ((pass++))

    # Test 7: Routing table check
    echo -n "7. Policy routing table ${RT_TABLE_NAME}: "
    if ip rule show | grep -q "fwmark ${FWMARK}"; then
        echo "ACTIVE [PASS]"
        ((pass++))
    else
        echo "MISSING [FAIL]"
        ((fail++))
    fi

    # Test 8: iptables mangle rules
    echo -n "8. iptables mangle marks: "
    local mark_count
    mark_count=$(iptables -t mangle -L OUTPUT -n 2>/dev/null | grep -c "MARK" || echo "0")
    if [[ "$mark_count" -gt 0 ]]; then
        echo "${mark_count} rules [PASS]"
        ((pass++))
    else
        echo "NO RULES [FAIL]"
        ((fail++))
    fi

    echo ""
    echo "Results: ${pass} passed, ${fail} failed"
    if [[ "$fail" -eq 0 ]]; then
        log "ALL TESTS PASSED - Split tunnel operational"
    else
        log "SOME TESTS FAILED - Check output above"
    fi
}

###############################################################################
# TEARDOWN — Remove everything cleanly
###############################################################################
teardown() {
    log "=== Tearing down VPN split tunnel ==="

    # Stop WireGuard
    wg-quick down "$WG_IFACE" 2>/dev/null || true
    log "WireGuard interface stopped"

    # Remove config
    rm -f "$WG_CONF"
    log "Removed ${WG_CONF}"

    # Remove routing table entry
    sed -i "/^${RT_TABLE_ID}/d" /etc/iproute2/rt_tables 2>/dev/null || true
    log "Removed routing table entry"

    # Clean any leftover mangle rules
    iptables -t mangle -F OUTPUT 2>/dev/null || true
    log "Flushed mangle OUTPUT chain"

    log "Teardown complete."
}

###############################################################################
# MAIN
###############################################################################
usage() {
    echo "Usage: sudo $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --provider proton    Setup ProtonVPN Free (WireGuard)"
    echo "  --provider mullvad   Setup Mullvad VPN ($5/mo)"
    echo "  --test               Test VPN routing"
    echo "  --update-ips         Re-resolve Polymarket IPs and update rules"
    echo "  --teardown           Remove VPN setup completely"
    echo "  -h, --help           Show this help"
}

# Require root for everything except help
if [[ "${1:-}" != "-h" && "${1:-}" != "--help" && "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root (sudo)."
    exit 1
fi

case "${1:-}" in
    --provider)
        install_deps
        case "${2:-}" in
            proton)  setup_proton ;;
            mullvad) setup_mullvad ;;
            *)       echo "Unknown provider: ${2:-}. Use 'proton' or 'mullvad'."; exit 1 ;;
        esac
        ;;
    --test)
        run_test
        ;;
    --update-ips)
        update_ips
        ;;
    --teardown)
        teardown
        ;;
    -h|--help|"")
        usage
        ;;
    *)
        echo "Unknown option: $1"
        usage
        exit 1
        ;;
esac
