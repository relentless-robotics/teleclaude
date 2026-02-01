#!/bin/bash
# Teleclaude Test Update Script (Bash)
# Tests upstream updates in an isolated container before applying to local

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
BRANCH="main"
REPO="https://github.com/gatordevin/teleclaude.git"
INTERACTIVE=false
KEEP_CONTAINER=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --branch|-b)
            BRANCH="$2"
            shift 2
            ;;
        --repo|-r)
            REPO="$2"
            shift 2
            ;;
        --interactive|-i)
            INTERACTIVE=true
            shift
            ;;
        --keep|-k)
            KEEP_CONTAINER=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--branch|-b BRANCH] [--repo|-r REPO] [--interactive|-i] [--keep|-k]"
            exit 1
            ;;
    esac
done

CONTAINER_NAME="teleclaude-upstream-test"
TEMP_DIR=$(mktemp -d)

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo -e "${CYAN}========================================"
echo "Teleclaude Upstream Update Tester"
echo -e "========================================${NC}"
echo -e "${YELLOW}Branch: $BRANCH${NC}"
echo -e "${YELLOW}Repository: $REPO${NC}"

cd "$PROJECT_DIR"

echo -e "\n${YELLOW}[1/5] Cloning upstream repository...${NC}"
git clone --branch "$BRANCH" --depth 1 "$REPO" "$TEMP_DIR"

echo -e "\n${YELLOW}[2/5] Creating test data directories...${NC}"
TEST_DATA_DIR="$PROJECT_DIR/upstream-test-data"
mkdir -p "$TEST_DATA_DIR/browser_state"
mkdir -p "$TEST_DATA_DIR/logs"
mkdir -p "$TEST_DATA_DIR/screenshots"

echo -e "\n${YELLOW}[3/5] Building upstream test image...${NC}"
docker build -t teleclaude:upstream-test -f Dockerfile.test "$TEMP_DIR"

echo -e "\n${YELLOW}[4/5] Starting upstream test container...${NC}"

# Stop existing container if running
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Run container with local protected files
docker run -d --name "$CONTAINER_NAME" \
    -v "$PROJECT_DIR/config.json:/app/config.json:ro" \
    -v "$PROJECT_DIR/.env:/app/.env:ro" \
    -v "$PROJECT_DIR/ACCOUNTS.md:/app/ACCOUNTS.md:ro" \
    -v "$PROJECT_DIR/API_KEYS.md:/app/API_KEYS.md:ro" \
    -v "$PROJECT_DIR/CLAUDE.md:/app/CLAUDE.md:ro" \
    -v "$TEST_DATA_DIR/browser_state:/app/browser_state" \
    -v "$TEST_DATA_DIR/logs:/app/logs" \
    -v "$TEST_DATA_DIR/screenshots:/app/screenshots" \
    -e NODE_ENV=development \
    -e UPSTREAM_TEST=true \
    teleclaude:upstream-test tail -f /dev/null

echo -e "\n${YELLOW}[5/5] Container ready for testing!${NC}"
echo -e "\n${CYAN}========================================"
echo -e "Upstream Test Environment Ready"
echo -e "========================================${NC}"

echo -e "\n${CYAN}Useful commands:${NC}"
echo "  docker exec -it $CONTAINER_NAME bash"
echo "  docker exec $CONTAINER_NAME node index.js"
echo "  docker logs $CONTAINER_NAME"
echo "  docker stop $CONTAINER_NAME"

if [[ "$INTERACTIVE" == "true" ]]; then
    echo -e "\n${YELLOW}Entering interactive shell...${NC}"
    docker exec -it "$CONTAINER_NAME" bash
fi

if [[ "$KEEP_CONTAINER" == "false" ]]; then
    echo -e "\n${YELLOW}Press Enter to stop and remove the test container...${NC}"
    read
    docker rm -f "$CONTAINER_NAME"
    echo -e "${GREEN}Container removed.${NC}"
else
    echo -e "\n${YELLOW}Container '$CONTAINER_NAME' is still running. Run 'docker rm -f $CONTAINER_NAME' to remove.${NC}"
fi
