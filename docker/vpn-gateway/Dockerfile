# VPN Gateway Container
# Routes all connected container traffic through VPN

FROM alpine:latest

LABEL maintainer="TeleClaude"
LABEL description="VPN gateway for routing container traffic"

# Install VPN clients and utilities
RUN apk add --no-cache \
    openvpn \
    wireguard-tools \
    iptables \
    ip6tables \
    curl \
    bash \
    bind-tools

# Create directories
RUN mkdir -p /etc/openvpn/client /etc/wireguard /vpn-configs

# Copy configuration
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Enable IP forwarding
RUN echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf && \
    echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.conf

# Volume for VPN configs
VOLUME ["/vpn-configs"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s \
    CMD curl -s ifconfig.me || exit 1

ENTRYPOINT ["/entrypoint.sh"]
