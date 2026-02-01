#!/bin/bash
# Teleclaude Docker Cleanup Script (Bash)
# Removes test containers and optionally images

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
CLEAN_IMAGES=false
CLEAN_VOLUMES=false
FORCE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --all|-a)
            CLEAN_IMAGES=true
            CLEAN_VOLUMES=true
            shift
            ;;
        --images|-i)
            CLEAN_IMAGES=true
            shift
            ;;
        --volumes|-v)
            CLEAN_VOLUMES=true
            shift
            ;;
        --force|-f)
            FORCE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--all|-a] [--images|-i] [--volumes|-v] [--force|-f]"
            exit 1
            ;;
    esac
done

echo -e "${CYAN}========================================"
echo "Teleclaude Docker Cleanup"
echo -e "========================================${NC}"

# Containers to clean up
CONTAINERS=(
    "teleclaude-prod"
    "teleclaude-test"
    "teleclaude-upstream"
    "teleclaude-upstream-test"
    "teleclaude-experimental"
)

# Images to clean up
IMAGES=(
    "teleclaude:prod"
    "teleclaude:test"
    "teleclaude:upstream-test"
)

echo -e "\n${YELLOW}[1/3] Stopping and removing containers...${NC}"
for container in "${CONTAINERS[@]}"; do
    if docker ps -a --format "{{.Names}}" | grep -q "^${container}$"; then
        echo "  Removing: $container"
        docker rm -f "$container" 2>/dev/null || true
    fi
done
echo -e "  ${GREEN}Containers cleaned.${NC}"

if [[ "$CLEAN_IMAGES" == "true" ]]; then
    echo -e "\n${YELLOW}[2/3] Removing images...${NC}"
    for image in "${IMAGES[@]}"; do
        if docker images -q "$image" | grep -q .; then
            if [[ "$FORCE" == "true" ]]; then
                echo "  Removing: $image"
                docker rmi -f "$image" 2>/dev/null || true
            else
                echo "  Would remove: $image (use --force to actually remove)"
            fi
        fi
    done

    # Also clean up dangling images from teleclaude builds
    if [[ "$FORCE" == "true" ]]; then
        echo "  Removing dangling images..."
        docker image prune -f --filter "label=org.opencontainers.image.title=Teleclaude" 2>/dev/null || true
    fi
    echo -e "  ${GREEN}Images cleaned.${NC}"
else
    echo -e "\n${YELLOW}[2/3] Skipping image removal (use --images or --all)${NC}"
fi

if [[ "$CLEAN_VOLUMES" == "true" ]]; then
    echo -e "\n${YELLOW}[3/3] Cleaning up volumes...${NC}"
    if [[ "$FORCE" == "true" ]]; then
        docker volume prune -f 2>/dev/null || true
        echo -e "  ${GREEN}Volumes cleaned.${NC}"
    else
        echo "  Would clean volumes (use --force to actually remove)"
    fi
else
    echo -e "\n${YELLOW}[3/3] Skipping volume cleanup (use --volumes or --all)${NC}"
fi

echo -e "\n${CYAN}========================================"
echo -e "Cleanup complete!"
echo -e "========================================${NC}"

echo -e "\n${CYAN}Remaining teleclaude resources:${NC}"
echo -e "\n${YELLOW}Containers:${NC}"
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" | grep teleclaude || echo "  None"

echo -e "\n${YELLOW}Images:${NC}"
docker images | grep teleclaude || echo "  None"
