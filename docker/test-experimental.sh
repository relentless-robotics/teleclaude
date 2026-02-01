#!/bin/bash
# Teleclaude Test Experimental Script (Bash)
# Spin up container for testing experimental code changes

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
INTERACTIVE=false
KEEP_CONTAINER=false
RUN=false
COMMAND=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --interactive|-i)
            INTERACTIVE=true
            shift
            ;;
        --keep|-k)
            KEEP_CONTAINER=true
            shift
            ;;
        --run|-r)
            RUN=true
            shift
            ;;
        --command|-c)
            COMMAND="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--interactive|-i] [--keep|-k] [--run|-r] [--command|-c COMMAND]"
            exit 1
            ;;
    esac
done

CONTAINER_NAME="teleclaude-experimental"

echo -e "${CYAN}========================================"
echo "Teleclaude Experimental Test Environment"
echo -e "========================================${NC}"

cd "$PROJECT_DIR"

echo -e "\n${YELLOW}[1/3] Creating test data directories...${NC}"
TEST_DATA_DIR="$PROJECT_DIR/test-data"
mkdir -p "$TEST_DATA_DIR/browser_state"
mkdir -p "$TEST_DATA_DIR/logs"
mkdir -p "$TEST_DATA_DIR/screenshots"

# Check if test image exists
if [[ -z "$(docker images -q teleclaude:test)" ]]; then
    echo -e "\n${YELLOW}[2/3] Building test image (not found)...${NC}"
    docker build -t teleclaude:test -f Dockerfile.test .
else
    echo -e "\n${YELLOW}[2/3] Using existing test image...${NC}"
fi

echo -e "\n${YELLOW}[3/3] Starting experimental container...${NC}"

# Stop existing container if running
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Run container with mounted source code for live editing
docker run -d --name "$CONTAINER_NAME" \
    -v "$PROJECT_DIR/config.json:/app/config.json:ro" \
    -v "$PROJECT_DIR/.env:/app/.env:ro" \
    -v "$PROJECT_DIR/ACCOUNTS.md:/app/ACCOUNTS.md:ro" \
    -v "$PROJECT_DIR/API_KEYS.md:/app/API_KEYS.md:ro" \
    -v "$PROJECT_DIR/CLAUDE.md:/app/CLAUDE.md:ro" \
    -v "$PROJECT_DIR/lib:/app/lib" \
    -v "$PROJECT_DIR/mcp:/app/mcp" \
    -v "$PROJECT_DIR/utils:/app/utils" \
    -v "$PROJECT_DIR/index.js:/app/index.js" \
    -v "$PROJECT_DIR/chat.js:/app/chat.js" \
    -v "$PROJECT_DIR/setup.js:/app/setup.js" \
    -v "$TEST_DATA_DIR/browser_state:/app/browser_state" \
    -v "$TEST_DATA_DIR/logs:/app/logs" \
    -v "$TEST_DATA_DIR/screenshots:/app/screenshots" \
    -e NODE_ENV=development \
    -e DEBUG=* \
    teleclaude:test tail -f /dev/null

echo -e "\n${CYAN}========================================"
echo -e "Experimental Environment Ready"
echo -e "========================================${NC}"

echo -e "\n${GREEN}Source code is mounted - changes are reflected immediately!${NC}"

echo -e "\n${CYAN}Useful commands:${NC}"
echo "  docker exec -it $CONTAINER_NAME bash"
echo "  docker exec $CONTAINER_NAME node index.js"
echo "  docker exec $CONTAINER_NAME npm test"
echo "  docker logs -f $CONTAINER_NAME"
echo "  docker stop $CONTAINER_NAME"

# Execute custom command if provided
if [[ -n "$COMMAND" ]]; then
    echo -e "\n${YELLOW}Executing: $COMMAND${NC}"
    docker exec "$CONTAINER_NAME" bash -c "$COMMAND"
fi

# Run the main application if requested
if [[ "$RUN" == "true" ]]; then
    echo -e "\n${YELLOW}Starting teleclaude...${NC}"
    docker exec -it "$CONTAINER_NAME" node index.js
fi

if [[ "$INTERACTIVE" == "true" ]]; then
    echo -e "\n${YELLOW}Entering interactive shell...${NC}"
    docker exec -it "$CONTAINER_NAME" bash
fi

if [[ "$KEEP_CONTAINER" == "false" && "$RUN" == "false" && "$INTERACTIVE" == "false" ]]; then
    echo -e "\n${YELLOW}Press Enter to stop and remove the container...${NC}"
    read
    docker rm -f "$CONTAINER_NAME"
    echo -e "${GREEN}Container removed.${NC}"
elif [[ "$KEEP_CONTAINER" == "true" ]]; then
    echo -e "\n${YELLOW}Container '$CONTAINER_NAME' is still running. Run 'docker rm -f $CONTAINER_NAME' to remove.${NC}"
fi
