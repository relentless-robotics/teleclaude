#!/bin/bash
# VPN Gateway Entrypoint
# Sets up VPN connection and NAT for connected containers

set -e

echo "[*] VPN Gateway Starting..."

# Enable IP forwarding
sysctl -w net.ipv4.ip_forward=1
sysctl -w net.ipv6.conf.all.forwarding=1

# Get the default interface
DEFAULT_IF=$(ip route | grep default | awk '{print $5}' | head -1)
echo "[*] Default interface: $DEFAULT_IF"

# Function to setup NAT
setup_nat() {
    local VPN_IF=$1
    echo "[*] Setting up NAT from $DEFAULT_IF to $VPN_IF..."

    # Flush existing rules
    iptables -F
    iptables -t nat -F

    # Setup NAT masquerading
    iptables -t nat -A POSTROUTING -o $VPN_IF -j MASQUERADE
    iptables -A FORWARD -i $DEFAULT_IF -o $VPN_IF -j ACCEPT
    iptables -A FORWARD -i $VPN_IF -o $DEFAULT_IF -m state --state RELATED,ESTABLISHED -j ACCEPT

    # Kill switch - block traffic if VPN drops
    if [ "$KILL_SWITCH" = "true" ]; then
        iptables -A OUTPUT -o $DEFAULT_IF -j DROP
        iptables -A OUTPUT -o lo -j ACCEPT
        iptables -A OUTPUT -o $VPN_IF -j ACCEPT
        echo "[+] Kill switch enabled"
    fi
}

# Start WireGuard if config exists
if [ -f "/vpn-configs/wg0.conf" ]; then
    echo "[*] Starting WireGuard VPN..."
    cp /vpn-configs/wg0.conf /etc/wireguard/wg0.conf
    wg-quick up wg0

    sleep 3
    setup_nat "wg0"

    VPN_IP=$(curl -s ifconfig.me)
    echo "[+] WireGuard connected! Exit IP: $VPN_IP"

# Start OpenVPN if config exists
elif [ -f "/vpn-configs/client.ovpn" ]; then
    echo "[*] Starting OpenVPN..."
    openvpn --config /vpn-configs/client.ovpn --daemon --log /var/log/openvpn.log

    # Wait for tun interface
    for i in {1..30}; do
        if ip link show tun0 >/dev/null 2>&1; then
            break
        fi
        echo "    Waiting for VPN connection... ($i/30)"
        sleep 2
    done

    setup_nat "tun0"

    VPN_IP=$(curl -s ifconfig.me)
    echo "[+] OpenVPN connected! Exit IP: $VPN_IP"

else
    echo "[!] No VPN config found!"
    echo "    Place config at /vpn-configs/wg0.conf (WireGuard)"
    echo "    Or /vpn-configs/client.ovpn (OpenVPN)"
fi

echo ""
echo "[*] Gateway ready. Connected containers will route through VPN."
echo "[*] Current exit IP: $(curl -s ifconfig.me)"

# Keep container running
tail -f /dev/null
