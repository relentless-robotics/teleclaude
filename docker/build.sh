#!/bin/bash
# Teleclaude Docker Build Script (Bash)
# Builds all Docker images for teleclaude

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse arguments
BUILD_PROD=false
BUILD_TEST=false
NO_CACHE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --production|-p)
            BUILD_PROD=true
            shift
            ;;
        --test|-t)
            BUILD_TEST=true
            shift
            ;;
        --all|-a)
            BUILD_PROD=true
            BUILD_TEST=true
            shift
            ;;
        --no-cache)
            NO_CACHE="--no-cache"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--production|-p] [--test|-t] [--all|-a] [--no-cache]"
            exit 1
            ;;
    esac
done

# Default to all if nothing specified
if [[ "$BUILD_PROD" == "false" && "$BUILD_TEST" == "false" ]]; then
    BUILD_PROD=true
    BUILD_TEST=true
fi

echo -e "${CYAN}========================================"
echo "Teleclaude Docker Build"
echo -e "========================================${NC}"

cd "$PROJECT_DIR"

if [[ "$BUILD_PROD" == "true" ]]; then
    echo -e "\n${YELLOW}[1/2] Building production image...${NC}"
    docker build -t teleclaude:prod -f Dockerfile $NO_CACHE .
    echo -e "${GREEN}Production image built: teleclaude:prod${NC}"
fi

if [[ "$BUILD_TEST" == "true" ]]; then
    echo -e "\n${YELLOW}[2/2] Building test image...${NC}"
    docker build -t teleclaude:test -f Dockerfile.test $NO_CACHE .
    echo -e "${GREEN}Test image built: teleclaude:test${NC}"
fi

echo -e "\n${CYAN}========================================"
echo -e "Build complete!"
echo -e "========================================${NC}"

echo -e "\n${CYAN}Available images:${NC}"
docker images | grep teleclaude
