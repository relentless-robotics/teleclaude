"""
safe_launch.py — Safe Training Launcher for Neptune

Wraps any Python training command with HARD resource limits.
Ensures:
  1. GPU is available and has enough VRAM before launching
  2. RAM headroom exists (won't launch if >70% used)
  3. Sets environment variables to limit workers/threads
  4. Monitors the child process and kills it if RAM exceeds 85%

Usage:
    python utils/safe_launch.py "python train.py --model book --device cuda"
    python utils/safe_launch.py --max-ram-gb 20 --max-workers 8 "python train.py ..."
    python utils/safe_launch.py --check  # Just check if safe to launch

This is a MANDATORY wrapper for ALL training on Neptune.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# ── Hard Limits ──────────────────────────────────────────────────────────────
DEFAULT_MAX_RAM_GB = 20        # Max RAM the training process should use
DEFAULT_MAX_WORKERS = 8        # Max DataLoader workers
DEFAULT_MAX_THREADS = 16       # Max CPU threads for PyTorch/NumPy
RAM_HEADROOM_PCT = 70          # Don't launch if system RAM > this
RAM_KILL_PCT = 85              # Kill the child if system RAM exceeds this
GPU_MIN_FREE_MB = 4000         # Need at least 4GB free VRAM to launch
CHECK_INTERVAL = 15            # Monitor interval in seconds

TELECLAUDE = Path(__file__).resolve().parent.parent
LOG_FILE = TELECLAUDE / 'neptune_guardian.log'


def log(msg, level='INFO'):
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{ts}] [SAFE_LAUNCH] [{level}] {msg}"
    print(line)
    sys.stdout.flush()
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def get_ram_pct():
    """Get current RAM usage percentage."""
    try:
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-Command',
             'Get-CimInstance Win32_OperatingSystem | '
             'Select-Object TotalVisibleMemorySize,FreePhysicalMemory | '
             'ConvertTo-Json'],
            timeout=15, stderr=subprocess.DEVNULL
        ).decode().strip()
        import json
        data = json.loads(out)
        total_kb = data['TotalVisibleMemorySize']
        free_kb = data['FreePhysicalMemory']
        if total_kb == 0:
            return None
        return round(((total_kb - free_kb) / total_kb) * 100, 1)
    except Exception:
        return None


def get_gpu_free_mb():
    """Get free GPU VRAM in MB."""
    try:
        out = subprocess.check_output(
            ['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'],
            timeout=10, stderr=subprocess.DEVNULL
        ).decode().strip()
        return int(out)
    except Exception:
        return None


def preflight_check():
    """Check if it's safe to launch training. Returns (ok, reasons)."""
    issues = []

    ram_pct = get_ram_pct()
    if ram_pct is None:
        issues.append("Cannot read RAM usage")
    elif ram_pct > RAM_HEADROOM_PCT:
        issues.append(f"RAM too high: {ram_pct}% (max {RAM_HEADROOM_PCT}% to launch)")

    gpu_free = get_gpu_free_mb()
    if gpu_free is None:
        issues.append("Cannot read GPU VRAM (nvidia-smi failed)")
    elif gpu_free < GPU_MIN_FREE_MB:
        issues.append(f"Not enough free VRAM: {gpu_free}MB (need {GPU_MIN_FREE_MB}MB)")

    # Count existing Python processes
    try:
        out = subprocess.check_output(
            ['tasklist', '/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'],
            timeout=10, stderr=subprocess.DEVNULL
        ).decode()
        count = sum(1 for l in out.split('\n') if 'python' in l.lower() and 'No tasks' not in l)
        if count > 12:
            issues.append(f"Too many Python processes already: {count}")
    except Exception:
        pass

    return len(issues) == 0, issues


def build_env(max_workers, max_threads):
    """Build environment with resource limits."""
    env = os.environ.copy()

    # PyTorch DataLoader workers
    env['NEPTUNE_MAX_WORKERS'] = str(max_workers)

    # CPU thread limits for PyTorch, NumPy, OpenBLAS, MKL
    env['OMP_NUM_THREADS'] = str(max_threads)
    env['MKL_NUM_THREADS'] = str(max_threads)
    env['OPENBLAS_NUM_THREADS'] = str(max_threads)
    env['NUMEXPR_MAX_THREADS'] = str(max_threads)
    env['TORCH_NUM_THREADS'] = str(max_threads)

    # Force CUDA (never fall back to CPU)
    env['CUDA_VISIBLE_DEVICES'] = '0'

    # Disable PyTorch CPU fallback for operations
    # (This doesn't prevent all CPU usage, but signals intent)
    env['NEPTUNE_GPU_ONLY'] = '1'

    # Memory limits
    env['NEPTUNE_MAX_RAM_GB'] = str(DEFAULT_MAX_RAM_GB)
    env['NEPTUNE_GUARDIAN_ACTIVE'] = '1'

    return env


def main():
    parser = argparse.ArgumentParser(description='Safe Training Launcher for Neptune')
    parser.add_argument('command', nargs='?', help='Training command to run')
    parser.add_argument('--max-ram-gb', type=int, default=DEFAULT_MAX_RAM_GB)
    parser.add_argument('--max-workers', type=int, default=DEFAULT_MAX_WORKERS)
    parser.add_argument('--max-threads', type=int, default=DEFAULT_MAX_THREADS)
    parser.add_argument('--check', action='store_true', help='Just check if safe to launch')
    parser.add_argument('--force', action='store_true', help='Launch even if preflight fails (DANGEROUS)')
    args = parser.parse_args()

    # Preflight check
    ok, issues = preflight_check()

    if args.check:
        if ok:
            print("SAFE TO LAUNCH")
            print(f"  RAM: {get_ram_pct()}%")
            print(f"  GPU free: {get_gpu_free_mb()}MB")
        else:
            print("NOT SAFE TO LAUNCH:")
            for issue in issues:
                print(f"  - {issue}")
        sys.exit(0 if ok else 1)

    if not args.command:
        parser.error("Command required (or use --check)")

    log(f"Safe launch requested: {args.command}")
    log(f"  Max RAM: {args.max_ram_gb}GB, Max workers: {args.max_workers}, Max threads: {args.max_threads}")

    if not ok:
        for issue in issues:
            log(f"PREFLIGHT FAILED: {issue}", 'ERROR')
        if not args.force:
            log("Aborting launch. Use --force to override (DANGEROUS).", 'ERROR')
            sys.exit(1)
        else:
            log("FORCE FLAG SET — launching despite failed preflight!", 'WARNING')

    # Build environment with limits
    env = build_env(args.max_workers, args.max_threads)

    log(f"Launching with limits: OMP_NUM_THREADS={args.max_threads}, "
        f"NEPTUNE_MAX_WORKERS={args.max_workers}")

    # Launch the training process
    proc = subprocess.Popen(
        args.command,
        shell=True,
        env=env,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )

    log(f"Training process started: PID {proc.pid}")

    # Monitor loop
    try:
        while proc.poll() is None:
            time.sleep(CHECK_INTERVAL)

            ram_pct = get_ram_pct()
            if ram_pct and ram_pct >= RAM_KILL_PCT:
                log(f"RAM at {ram_pct}%! KILLING training process PID {proc.pid}!", 'CRITICAL')
                proc.kill()
                proc.wait(timeout=10)
                log(f"Training process killed. Exit code: {proc.returncode}", 'CRITICAL')
                sys.exit(1)

            # Periodic status
            gpu_free = get_gpu_free_mb()
            if ram_pct:
                # Only log occasionally (every 10 checks = ~2.5 min)
                pass

    except KeyboardInterrupt:
        log("Interrupted — terminating training process", 'WARNING')
        proc.terminate()
        proc.wait(timeout=30)

    exit_code = proc.returncode
    log(f"Training process exited with code {exit_code}")
    sys.exit(exit_code)


if __name__ == '__main__':
    main()
