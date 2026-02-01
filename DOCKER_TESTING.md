# Docker Testing Environment for Teleclaude

This document explains how to use Docker to safely test updates, experimental features, and changes before applying them to your production teleclaude installation.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Building Images](#building-images)
3. [Testing Upstream Updates](#testing-upstream-updates)
4. [Testing Experimental Features](#testing-experimental-features)
5. [Using Docker Compose](#using-docker-compose)
6. [Accessing Logs and Debugging](#accessing-logs-and-debugging)
7. [Comparing Behavior Between Containers](#comparing-behavior-between-containers)
8. [Cleanup](#cleanup)
9. [Security Notes](#security-notes)
10. [Troubleshooting](#troubleshooting)

---

## Quick Start

```powershell
# Windows PowerShell
.\docker\build.ps1                    # Build all images
.\docker\test-experimental.ps1 -Interactive  # Test with live code changes
```

```bash
# Linux/macOS
./docker/build.sh                     # Build all images
./docker/test-experimental.sh -i      # Test with live code changes
```

---

## Building Images

### Build All Images

```powershell
# Windows
.\docker\build.ps1

# With no cache (fresh build)
.\docker\build.ps1 -NoCache
```

```bash
# Linux/macOS
./docker/build.sh

# With no cache
./docker/build.sh --no-cache
```

### Build Specific Images

```powershell
# Production only
.\docker\build.ps1 -Production

# Test only
.\docker\build.ps1 -Test
```

```bash
# Production only
./docker/build.sh --production

# Test only
./docker/build.sh --test
```

### Available Images

| Image | Purpose |
|-------|---------|
| `teleclaude:prod` | Production-ready, minimal, secure |
| `teleclaude:test` | Development tools, debugging enabled |
| `teleclaude:upstream-test` | Testing upstream repository changes |

---

## Testing Upstream Updates

**Use this before pulling updates from the upstream repository.**

### Workflow

1. Run the test-update script with the branch you want to test:

```powershell
# Windows - Test main branch
.\docker\test-update.ps1

# Test a specific branch
.\docker\test-update.ps1 -Branch "feature-branch"

# Interactive mode (drops into shell)
.\docker\test-update.ps1 -Interactive
```

```bash
# Linux/macOS
./docker/test-update.sh

# Test specific branch
./docker/test-update.sh --branch feature-branch

# Interactive mode
./docker/test-update.sh --interactive
```

2. The script will:
   - Clone the upstream repository into a temp directory
   - Build a test image with upstream code
   - Start a container with your LOCAL config files mounted
   - Allow you to test the upstream code with your credentials

3. Test the upstream code:

```bash
# Run teleclaude in the container
docker exec -it teleclaude-upstream-test node index.js

# Run specific commands
docker exec teleclaude-upstream-test npm test
```

4. If everything works, apply the update to your local installation.

---

## Testing Experimental Features

**Use this to test code changes before committing.**

### Workflow

```powershell
# Windows - Start experimental environment
.\docker\test-experimental.ps1 -KeepContainer

# With interactive shell
.\docker\test-experimental.ps1 -Interactive
```

```bash
# Linux/macOS
./docker/test-experimental.sh --keep

# With interactive shell
./docker/test-experimental.sh --interactive
```

### Live Code Editing

The experimental container mounts your source code, so changes are reflected immediately:

- `lib/` - Core library files
- `mcp/` - MCP server files
- `utils/` - Utility modules
- `index.js`, `chat.js`, `setup.js` - Entry points

**Workflow:**

1. Start the experimental container: `.\docker\test-experimental.ps1 -KeepContainer`
2. Edit your local files in your IDE
3. Run the changed code in the container: `docker exec teleclaude-experimental node index.js`
4. Repeat until satisfied
5. Cleanup: `.\docker\cleanup.ps1`

---

## Using Docker Compose

For more complex setups, use docker-compose:

```bash
# Start all services
docker-compose up -d

# Start specific service
docker-compose up -d teleclaude-test

# View logs
docker-compose logs -f teleclaude-test

# Stop all
docker-compose down
```

### Available Services

| Service | Purpose |
|---------|---------|
| `teleclaude-prod` | Production-like environment |
| `teleclaude-test` | Experimental testing with mounted source |
| `teleclaude-upstream` | Testing upstream updates |

---

## Accessing Logs and Debugging

### View Container Logs

```bash
# Follow logs
docker logs -f teleclaude-experimental

# Last 100 lines
docker logs --tail 100 teleclaude-test
```

### Access Container Shell

```bash
# Interactive bash shell
docker exec -it teleclaude-experimental bash

# Run single command
docker exec teleclaude-experimental cat /app/logs/bridge-2026-01-30.log
```

### Debug Mode

The test image has debugging tools pre-installed:

```bash
docker exec -it teleclaude-experimental bash

# Inside container:
htop                    # Process monitor
lsof -i                 # Open network connections
strace -p <PID>         # Trace system calls
```

### Access Application Logs

Logs are stored in the mounted volume:

```powershell
# Windows - View test logs
Get-Content .\test-data\logs\bridge-*.log

# View upstream test logs
Get-Content .\upstream-test-data\logs\*.log
```

```bash
# Linux/macOS
cat ./test-data/logs/bridge-*.log
cat ./upstream-test-data/logs/*.log
```

---

## Comparing Behavior Between Containers

### Side-by-Side Testing

Run both production and test containers simultaneously:

```bash
# Start both
docker-compose up -d teleclaude-prod teleclaude-test

# Execute same command on both
docker exec teleclaude-prod node -e "console.log(require('./package.json').version)"
docker exec teleclaude-test node -e "console.log(require('./package.json').version)"
```

### Compare Outputs

```powershell
# Windows - Run same operation, compare results
$prodOutput = docker exec teleclaude-prod node index.js --version
$testOutput = docker exec teleclaude-test node index.js --version
Compare-Object $prodOutput $testOutput
```

### Network Isolation

Each service has its own isolated network:
- `teleclaude-prod-net`
- `teleclaude-test-net`
- `teleclaude-upstream-net`

Containers cannot interfere with each other.

---

## Cleanup

### Remove All Test Containers

```powershell
# Windows
.\docker\cleanup.ps1
```

```bash
# Linux/macOS
./docker/cleanup.sh
```

### Full Cleanup (Containers + Images)

```powershell
# Windows
.\docker\cleanup.ps1 -All -Force
```

```bash
# Linux/macOS
./docker/cleanup.sh --all --force
```

### Manual Cleanup

```bash
# Remove specific container
docker rm -f teleclaude-experimental

# Remove specific image
docker rmi teleclaude:test

# Remove all teleclaude images
docker images | grep teleclaude | awk '{print $3}' | xargs docker rmi -f

# Clean test data directories
rm -rf test-data/ upstream-test-data/
```

---

## Security Notes

### Protected Files

The following files are NEVER baked into Docker images (see `.dockerignore`):

- `config.json` - Discord/Telegram tokens
- `.env` - Environment secrets
- `ACCOUNTS.md` - Account credentials
- `API_KEYS.md` - API keys
- `browser_state/` - Browser sessions
- `.keys/` - Crypto wallet keys

These files are mounted at runtime as read-only volumes.

### Non-Root User

The production image runs as a non-root user (`teleclaude`) for security. The test image runs as root for debugging flexibility.

### Network Isolation

Test containers are isolated in separate Docker networks and cannot access the host network or other containers by default.

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker logs teleclaude-test

# Check if config exists
docker exec teleclaude-test ls -la /app/config.json
```

### Missing Dependencies

```bash
# Rebuild with no cache
docker build --no-cache -t teleclaude:test -f Dockerfile.test .
```

### Permission Issues

```bash
# Inside container, check permissions
ls -la /app/

# Fix ownership (test container only, as root)
chown -R teleclaude:teleclaude /app/logs /app/screenshots
```

### Browser Automation Fails

```bash
# Check Playwright installation
docker exec teleclaude-test npx playwright --version

# Reinstall browsers
docker exec teleclaude-test npx playwright install chromium
```

### Config Not Found

Ensure config.json exists in your project directory:

```powershell
# Windows
Test-Path .\config.json

# Create from example if missing
Copy-Item .\config.example.json .\config.json
```

### Out of Disk Space

```bash
# Check Docker disk usage
docker system df

# Clean up unused resources
docker system prune -a
```

---

## Directory Structure

After using Docker testing, your project will have:

```
teleclaude-main/
├── docker/
│   ├── build.ps1           # Build images (Windows)
│   ├── build.sh            # Build images (Linux/macOS)
│   ├── test-update.ps1     # Test upstream updates (Windows)
│   ├── test-update.sh      # Test upstream updates (Linux/macOS)
│   ├── test-experimental.ps1  # Test experimental (Windows)
│   ├── test-experimental.sh   # Test experimental (Linux/macOS)
│   ├── cleanup.ps1         # Cleanup (Windows)
│   └── cleanup.sh          # Cleanup (Linux/macOS)
├── test-data/              # Data from experimental testing
│   ├── browser_state/
│   ├── logs/
│   └── screenshots/
├── upstream-test-data/     # Data from upstream testing
│   ├── browser_state/
│   ├── logs/
│   └── screenshots/
├── Dockerfile              # Production image
├── Dockerfile.test         # Test/experimental image
├── docker-compose.yml      # Multi-container orchestration
└── .dockerignore           # Excludes sensitive files
```

---

*Last updated: 2026-01-30*
