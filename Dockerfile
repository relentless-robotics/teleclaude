# Teleclaude Production Dockerfile
# Node.js 18+ with Playwright browsers for browser automation
# Supports Discord bridge with native modules (node-pty)

FROM node:20-bookworm-slim AS base

# Install system dependencies for node-pty and Playwright
RUN apt-get update && apt-get install -y \
    # Build tools for native modules
    build-essential \
    python3 \
    # Playwright dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libgtk-3-0 \
    # Additional utilities
    git \
    curl \
    ca-certificates \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r teleclaude && useradd -r -g teleclaude -d /app -s /bin/bash teleclaude

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies (including native modules)
RUN npm install --production && npm cache clean --force

# Install Playwright browsers
RUN npx playwright install chromium firefox

# Copy application code (excluding protected files via .dockerignore)
COPY . .

# Create directories for mounted volumes
RUN mkdir -p /app/logs /app/screenshots /app/browser_state && \
    chown -R teleclaude:teleclaude /app

# Switch to non-root user
USER teleclaude

# Environment variables
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright

# Default command
CMD ["dumb-init", "node", "index.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('./lib/logger'); console.log('healthy')" || exit 1

# Labels
LABEL org.opencontainers.image.title="Teleclaude"
LABEL org.opencontainers.image.description="Control Claude Code CLI from Discord/Telegram"
LABEL org.opencontainers.image.source="https://github.com/gatordevin/teleclaude"
