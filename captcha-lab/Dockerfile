# CAPTCHA Testing Lab
# A containerized environment for practicing and improving CAPTCHA solving

FROM node:20-slim

# Install Tesseract OCR, ImageMagick, and Playwright dependencies
RUN apt-get update && apt-get install -y \
    # Tesseract OCR
    tesseract-ocr \
    tesseract-ocr-eng \
    # ImageMagick for image preprocessing
    imagemagick \
    # FFmpeg for audio CAPTCHA processing
    ffmpeg \
    # Playwright dependencies
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    # Server
    nginx \
    # Python for potential ML models
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install

# Install Playwright browsers
RUN npx playwright install chromium

# Copy application files
COPY . .

# Copy nginx config
COPY nginx.conf /etc/nginx/nginx.conf

# Create directories for data
RUN mkdir -p /app/harvester/data/images /app/harvester/data/labels /app/test_results /app/solver/temp /app/solver/training_data

# Expose ports
# 3000 = CAPTCHA lab server
# 3001 = Labeling UI
# 8080 = nginx proxy
EXPOSE 3000 3001 8080

# Default command: run the test server
CMD ["sh", "-c", "nginx && node server.js"]
