# Kali Linux Anonymous Container
# Security tools with Tor, proxychains, and VPN support

FROM kalilinux/kali-rolling:latest

LABEL maintainer="TeleClaude"
LABEL description="Kali Linux with anonymity tools - Tor, proxychains, VPN"

ENV DEBIAN_FRONTEND=noninteractive

# Update and install base tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Anonymity tools
    tor \
    proxychains4 \
    privoxy \
    openvpn \
    wireguard-tools \
    # Network tools
    nmap \
    masscan \
    netcat-traditional \
    tcpdump \
    dnsutils \
    curl \
    wget \
    # Web testing
    nikto \
    gobuster \
    sqlmap \
    # Utilities
    git \
    vim \
    python3 \
    python3-pip \
    iptables \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Configure Tor
RUN echo "SocksPort 9050" >> /etc/tor/torrc && \
    echo "ControlPort 9051" >> /etc/tor/torrc && \
    echo "CookieAuthentication 0" >> /etc/tor/torrc

# Configure proxychains for Tor
RUN sed -i 's/^socks4.*/socks5 127.0.0.1 9050/' /etc/proxychains4.conf && \
    sed -i 's/^#dynamic_chain/dynamic_chain/' /etc/proxychains4.conf && \
    sed -i 's/^strict_chain/#strict_chain/' /etc/proxychains4.conf

# Create directory for VPN configs
RUN mkdir -p /etc/openvpn/client /etc/wireguard

# Create startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create working directories
WORKDIR /work
RUN mkdir -p /output /vpn-configs

# Volume mount points
VOLUME ["/work", "/output", "/vpn-configs"]

# Expose Tor SOCKS port (for other containers)
EXPOSE 9050

# Health check for Tor
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
    CMD curl --socks5-hostname localhost:9050 -s https://check.torproject.org/api/ip | grep -q "true" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/bin/bash"]
