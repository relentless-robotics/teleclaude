#!/bin/bash
# Entrypoint script for kali-anon container
# Starts Tor and optionally VPN based on environment variables

set -e

echo "[*] TeleClaude Anonymous Container Starting..."

# Function to start Tor
start_tor() {
    echo "[*] Starting Tor service..."
    service tor start

    # Wait for Tor to establish circuit
    echo "[*] Waiting for Tor to establish circuit..."
    for i in {1..30}; do
        if curl --socks5-hostname localhost:9050 -s https://check.torproject.org/api/ip 2>/dev/null | grep -q "true"; then
            TOR_IP=$(curl --socks5-hostname localhost:9050 -s https://check.torproject.org/api/ip | grep -o '"IP":"[^"]*' | cut -d'"' -f4)
            echo "[+] Tor connected! Exit IP: $TOR_IP"
            return 0
        fi
        echo "    Waiting... ($i/30)"
        sleep 2
    done
    echo "[-] Warning: Tor may not be fully connected"
    return 1
}

# Function to start OpenVPN
start_openvpn() {
    if [ -f "/vpn-configs/client.ovpn" ]; then
        echo "[*] Starting OpenVPN..."
        openvpn --config /vpn-configs/client.ovpn --daemon
        sleep 5

        VPN_IP=$(curl -s ifconfig.me 2>/dev/null || echo "unknown")
        echo "[+] VPN connected! IP: $VPN_IP"
    else
        echo "[!] No OpenVPN config found at /vpn-configs/client.ovpn"
    fi
}

# Function to start WireGuard
start_wireguard() {
    if [ -f "/vpn-configs/wg0.conf" ]; then
        echo "[*] Starting WireGuard..."
        cp /vpn-configs/wg0.conf /etc/wireguard/wg0.conf
        wg-quick up wg0

        VPN_IP=$(curl -s ifconfig.me 2>/dev/null || echo "unknown")
        echo "[+] WireGuard connected! IP: $VPN_IP"
    else
        echo "[!] No WireGuard config found at /vpn-configs/wg0.conf"
    fi
}

# Check environment variables for what to start
if [ "$ANON_LEVEL" = "tor" ] || [ "$ANON_LEVEL" = "full" ] || [ -z "$ANON_LEVEL" ]; then
    start_tor
fi

if [ "$ANON_LEVEL" = "vpn" ] || [ "$ANON_LEVEL" = "full" ]; then
    if [ "$VPN_TYPE" = "wireguard" ]; then
        start_wireguard
    else
        start_openvpn
    fi
fi

# Show current IP configuration
echo ""
echo "[*] Current Network Configuration:"
echo "    Real IP: $(curl -s ifconfig.me 2>/dev/null || echo 'unknown')"
if service tor status >/dev/null 2>&1; then
    TOR_IP=$(curl --socks5-hostname localhost:9050 -s https://api.ipify.org 2>/dev/null || echo 'not connected')
    echo "    Tor Exit IP: $TOR_IP"
fi
echo ""

# Print usage info
echo "[*] Usage Tips:"
echo "    - Use 'proxychains4 <command>' to route through Tor"
echo "    - Use 'torify <command>' as alternative"
echo "    - Check Tor: curl --socks5-hostname localhost:9050 https://check.torproject.org/api/ip"
echo ""

# Execute the command passed to the container
exec "$@"
