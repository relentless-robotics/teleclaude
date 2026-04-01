#!/bin/bash
# =============================================================================
# deploy.sh — Lvl3Quant Server Bootstrap Script
# Run ON the server (via SSH) to set up the complete ML environment.
#
# Usage:
#   bash deploy.sh
#   bash deploy.sh --minimal   (skip conda/mamba, use pip only)
#   bash deploy.sh --force     (reinstall even if already set up)
# =============================================================================

set -e  # Exit on error

MINIMAL=false
FORCE=false

for arg in "$@"; do
  case $arg in
    --minimal) MINIMAL=true ;;
    --force)   FORCE=true ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()    { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn()   { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
section(){ echo -e "\n${BLUE}=== $1 ===${NC}"; }

# =============================================================================
section "System Check"
# =============================================================================
log "Running as: $(whoami)"
log "Hostname: $(hostname)"
log "Date: $(date)"
log "OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '"')"
log "Kernel: $(uname -r)"

# =============================================================================
section "1. Update Package Lists"
# =============================================================================
log "Updating apt package lists..."
sudo apt-get update -qq || warn "apt-get update had non-zero exit, continuing..."

# =============================================================================
section "2. Install System Dependencies"
# =============================================================================
SYSTEM_PACKAGES="
  python3 python3-pip python3-venv python3-dev
  build-essential gcc g++ gfortran
  libhdf5-dev liblapack-dev libopenblas-dev
  tmux screen htop iotop nethogs
  git curl wget unzip
  libssl-dev libffi-dev
  pkg-config
"

log "Installing system packages..."
sudo apt-get install -y $SYSTEM_PACKAGES || warn "Some packages may have failed, continuing..."

# =============================================================================
section "3. Verify Python Version"
# =============================================================================
PYTHON_VER=$(python3 --version 2>&1 | cut -d' ' -f2)
log "Python version: $PYTHON_VER"

PYTHON_MAJOR=$(echo $PYTHON_VER | cut -d. -f1)
PYTHON_MINOR=$(echo $PYTHON_VER | cut -d. -f2)

if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 9 ]); then
  warn "Python 3.9+ recommended. Current: $PYTHON_VER. Attempting to install 3.11..."
  sudo apt-get install -y python3.11 python3.11-venv python3.11-dev || \
    warn "Could not install Python 3.11, using existing $PYTHON_VER"
fi

# Prefer python3.11 if available
if command -v python3.11 &>/dev/null; then
  PYTHON_BIN=python3.11
  log "Using python3.11"
else
  PYTHON_BIN=python3
  log "Using $PYTHON_BIN"
fi

# =============================================================================
section "4. Install conda/mamba (optional)"
# =============================================================================
if [ "$MINIMAL" = false ]; then
  if ! command -v conda &>/dev/null; then
    log "Installing Miniforge (conda + mamba)..."
    MINIFORGE_URL="https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh"
    wget -q "$MINIFORGE_URL" -O /tmp/miniforge.sh || {
      warn "Could not download Miniforge, skipping conda installation"
      MINIMAL=true
    }

    if [ "$MINIMAL" = false ]; then
      bash /tmp/miniforge.sh -b -p "$HOME/miniforge3"
      rm /tmp/miniforge.sh
      echo 'export PATH="$HOME/miniforge3/bin:$PATH"' >> ~/.bashrc
      source "$HOME/miniforge3/etc/profile.d/conda.sh"
      conda init bash
      log "Miniforge installed at ~/miniforge3"
    fi
  else
    log "conda already installed: $(conda --version)"
    source "$HOME/miniforge3/etc/profile.d/conda.sh" 2>/dev/null || \
      source "$(conda info --base)/etc/profile.d/conda.sh" 2>/dev/null || true
  fi
fi

# =============================================================================
section "5. Create Working Directories"
# =============================================================================
DIRS=(
  "$HOME/lvl3quant"
  "$HOME/lvl3quant/data"
  "$HOME/lvl3quant/data/features"
  "$HOME/lvl3quant/data/raw"
  "$HOME/lvl3quant/alpha_discovery"
  "$HOME/lvl3quant/results"
  "$HOME/lvl3quant/results/scans"
  "$HOME/lvl3quant/results/models"
  "$HOME/lvl3quant/logs"
  "$HOME/lvl3quant/tmp"
)

log "Creating directory structure..."
for dir in "${DIRS[@]}"; do
  mkdir -p "$dir"
  log "  Created: $dir"
done

# =============================================================================
section "6. Set Up Python Virtual Environment"
# =============================================================================
VENV_DIR="$HOME/lvl3quant/venv"

if [ "$FORCE" = true ] && [ -d "$VENV_DIR" ]; then
  log "Force mode: removing existing venv..."
  rm -rf "$VENV_DIR"
fi

if [ ! -d "$VENV_DIR" ]; then
  log "Creating Python virtual environment at $VENV_DIR..."
  $PYTHON_BIN -m venv "$VENV_DIR"
fi

log "Activating venv..."
source "$VENV_DIR/bin/activate"

log "Upgrading pip, setuptools, wheel..."
pip install --upgrade pip setuptools wheel --quiet

# =============================================================================
section "7. Install ML Python Packages"
# =============================================================================
log "Installing core ML packages (this may take 5-10 minutes)..."

# Install in groups for better error isolation
ML_PACKAGES=(
  "numpy>=1.24"
  "pandas>=2.0"
  "scipy>=1.10"
  "scikit-learn>=1.3"
  "lightgbm>=4.0"
)

log "  Installing core ML packages..."
pip install "${ML_PACKAGES[@]}" --quiet || {
  warn "Batch install failed, trying one by one..."
  for pkg in "${ML_PACKAGES[@]}"; do
    pip install "$pkg" --quiet || warn "Failed to install $pkg"
  done
}

UTIL_PACKAGES=(
  "numba>=0.57"
  "joblib>=1.3"
  "tqdm>=4.65"
  "matplotlib>=3.7"
  "seaborn>=0.12"
)

log "  Installing utility packages..."
pip install "${UTIL_PACKAGES[@]}" --quiet || {
  for pkg in "${UTIL_PACKAGES[@]}"; do
    pip install "$pkg" --quiet || warn "Failed to install $pkg"
  done
}

DATA_PACKAGES=(
  "pyarrow>=12.0"
  "fastparquet>=2023.4"
  "h5py>=3.9"
  "tables>=3.8"
  "psutil>=5.9"
)

log "  Installing data I/O packages..."
pip install "${DATA_PACKAGES[@]}" --quiet || {
  for pkg in "${DATA_PACKAGES[@]}"; do
    pip install "$pkg" --quiet || warn "Failed to install $pkg"
  done
}

# =============================================================================
section "8. Write requirements.txt"
# =============================================================================
cat > "$HOME/lvl3quant/requirements.txt" << 'EOF'
# Lvl3Quant ML Requirements
# Generated by deploy.sh

# Core ML
numpy>=1.24
pandas>=2.0
scipy>=1.10
scikit-learn>=1.3
lightgbm>=4.0

# Performance
numba>=0.57
joblib>=1.3

# Data I/O
pyarrow>=12.0
fastparquet>=2023.4
h5py>=3.9
tables>=3.8

# Utilities
tqdm>=4.65
matplotlib>=3.7
seaborn>=0.12
psutil>=5.9
EOF

log "requirements.txt written to ~/lvl3quant/requirements.txt"

# =============================================================================
section "9. Write Venv Activation Script"
# =============================================================================
cat > "$HOME/lvl3quant/activate.sh" << 'ACTIVATE'
#!/bin/bash
# Activate Lvl3Quant Python environment
source "$HOME/lvl3quant/venv/bin/activate"
export PYTHONPATH="$HOME/lvl3quant:$PYTHONPATH"
export PYTHONUNBUFFERED=1
export LVL3QUANT_HOME="$HOME/lvl3quant"
echo "[lvl3quant] Environment activated"
ACTIVATE
chmod +x "$HOME/lvl3quant/activate.sh"

# =============================================================================
section "10. Set Up Heartbeat Cron Job"
# =============================================================================
HEARTBEAT_FILE="$HOME/lvl3quant/.heartbeat"
HEARTBEAT_SCRIPT="$HOME/lvl3quant/heartbeat.sh"

cat > "$HEARTBEAT_SCRIPT" << HEARTBEAT
#!/bin/bash
# Write heartbeat timestamp
echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HEARTBEAT_FILE"
HEARTBEAT
chmod +x "$HEARTBEAT_SCRIPT"

# Add to crontab (every 60 seconds — use 2-line trick since cron min is 1min)
CRON_LINE="* * * * * $HEARTBEAT_SCRIPT"

# Check if already in crontab
if ! crontab -l 2>/dev/null | grep -q "lvl3quant/heartbeat.sh"; then
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  log "Heartbeat cron job added (runs every minute)"
else
  log "Heartbeat cron job already present"
fi

# Write initial heartbeat
bash "$HEARTBEAT_SCRIPT"
log "Initial heartbeat written: $(cat $HEARTBEAT_FILE)"

# =============================================================================
section "11. Create Job Runner Helper Script"
# =============================================================================
cat > "$HOME/lvl3quant/run_job.sh" << 'RUNJOB'
#!/bin/bash
# Lvl3Quant Job Runner
# Usage: bash run_job.sh <job_id> <script> [args...]
#
# Runs a Python script in a tmux session with log capture.

JOB_ID="${1:?Usage: run_job.sh <job_id> <script> [args...]}"
SCRIPT="${2:?Must provide script path}"
shift 2
EXTRA_ARGS="$@"

LOG_FILE="$HOME/lvl3quant/logs/job_${JOB_ID}.log"
SESSION_NAME="lvl3_${JOB_ID}"

# Write job metadata
JOB_META="$HOME/lvl3quant/logs/job_${JOB_ID}.meta"
cat > "$JOB_META" << META
{
  "job_id": "$JOB_ID",
  "script": "$SCRIPT",
  "args": "$EXTRA_ARGS",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "log_file": "$LOG_FILE",
  "session": "$SESSION_NAME",
  "pid": ""
}
META

# Activate venv
source "$HOME/lvl3quant/venv/bin/activate"
export PYTHONUNBUFFERED=1
export PYTHONPATH="$HOME/lvl3quant:$PYTHONPATH"
export LVL3QUANT_HOME="$HOME/lvl3quant"

# Start in tmux session
tmux new-session -d -s "$SESSION_NAME" \
  "source $HOME/lvl3quant/venv/bin/activate && \
   export PYTHONUNBUFFERED=1 && \
   export PYTHONPATH=$HOME/lvl3quant:\$PYTHONPATH && \
   python $SCRIPT $EXTRA_ARGS 2>&1 | tee $LOG_FILE; \
   echo \"[JOB COMPLETE: exit \$?]\" >> $LOG_FILE"

# Get tmux PID
sleep 0.5
TMUX_PID=$(tmux list-panes -t "$SESSION_NAME" -F "#{pane_pid}" 2>/dev/null | head -1)

# Update meta with PID
if [ -n "$TMUX_PID" ]; then
  sed -i "s/\"pid\": \"\"/\"pid\": \"$TMUX_PID\"/" "$JOB_META"
fi

echo "Job $JOB_ID started in tmux session: $SESSION_NAME"
echo "Log: $LOG_FILE"
echo "PID: $TMUX_PID"
RUNJOB
chmod +x "$HOME/lvl3quant/run_job.sh"

# =============================================================================
section "12. Install tmux Config (nice defaults)"
# =============================================================================
if [ ! -f "$HOME/.tmux.conf" ]; then
  cat > "$HOME/.tmux.conf" << 'TMUXCONF'
# Lvl3Quant tmux config
set -g history-limit 50000
set -g mouse on
set -g status-right "#{session_name} | %H:%M"
set -g default-terminal "screen-256color"
TMUXCONF
  log "tmux config written"
fi

# =============================================================================
section "13. Verify Installation"
# =============================================================================
log "Verifying Python packages..."

source "$VENV_DIR/bin/activate"

python3 -c "
import sys
print(f'Python: {sys.version}')

packages = ['numpy', 'pandas', 'scipy', 'sklearn', 'lightgbm']
for pkg in packages:
    try:
        mod = __import__(pkg if pkg != 'sklearn' else 'sklearn')
        version = getattr(mod, '__version__', 'unknown')
        print(f'  OK  {pkg}: {version}')
    except ImportError as e:
        print(f'  FAIL {pkg}: {e}')
"

# =============================================================================
section "14. System Info Summary"
# =============================================================================
echo ""
log "=== SYSTEM INFORMATION ==="
log "Hostname:   $(hostname)"
log "OS:         $(cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"')"

# RAM
RAM_TOTAL=$(free -m | awk 'NR==2{print $2}')
RAM_FREE=$(free -m | awk 'NR==2{print $4}')
log "RAM:        ${RAM_TOTAL}MB total, ${RAM_FREE}MB free"

# CPU
CPU_CORES=$(nproc)
CPU_MODEL=$(cat /proc/cpuinfo | grep 'model name' | head -1 | cut -d: -f2 | xargs)
log "CPU Cores:  $CPU_CORES"
log "CPU Model:  $CPU_MODEL"

# Disk
DISK_TOTAL=$(df -h $HOME | awk 'NR==2{print $2}')
DISK_FREE=$(df -h $HOME | awk 'NR==2{print $4}')
log "Disk:       $DISK_TOTAL total, $DISK_FREE free (home)"

# Load
LOAD=$(uptime | awk -F'load average:' '{print $2}' | xargs)
log "Load Avg:   $LOAD"

echo ""
log "=== DEPLOYMENT COMPLETE ==="
log "Working dir:  ~/lvl3quant/"
log "Python venv:  ~/lvl3quant/venv/"
log "Logs dir:     ~/lvl3quant/logs/"
log "Results dir:  ~/lvl3quant/results/"
log "Heartbeat:    ~/lvl3quant/.heartbeat (updated every minute)"
log ""
log "To activate environment: source ~/lvl3quant/activate.sh"
log "To run a job: bash ~/lvl3quant/run_job.sh <job_id> <script.py> [args...]"
