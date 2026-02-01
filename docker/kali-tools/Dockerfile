# Kali Linux Security Tools Container
# Base image with common pentesting tools pre-installed

FROM kalilinux/kali-rolling:latest

LABEL maintainer="TeleClaude"
LABEL description="Kali Linux with security tools for isolated pentesting"

# Avoid prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

# Update and install tools in groups to manage layer size
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Network reconnaissance
    nmap \
    masscan \
    netcat-traditional \
    tcpdump \
    dnsutils \
    whois \
    traceroute \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Web testing
    nikto \
    gobuster \
    dirb \
    ffuf \
    sqlmap \
    whatweb \
    wpscan \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Password attacks
    hydra \
    john \
    hashcat \
    wordlists \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Utilities
    curl \
    wget \
    git \
    vim \
    python3 \
    python3-pip \
    jq \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    # SMB/Windows
    enum4linux \
    smbclient \
    smbmap \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Reverse engineering
    binwalk \
    foremost \
    exiftool \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /work

# Create output directory for scan results
RUN mkdir -p /output

# Set up volume mount points
VOLUME ["/work", "/output", "/wordlists"]

# Copy custom scripts
COPY scripts/ /opt/scripts/
RUN chmod +x /opt/scripts/*.sh 2>/dev/null || true

# Add scripts to PATH
ENV PATH="/opt/scripts:${PATH}"

# Default command
CMD ["/bin/bash"]
