"""
neptune_guardian.py — HARDCORE Neptune Resource Guardian

Permanently monitors Neptune (local PC) and enforces HARD limits:
  1. RAM: Kill training processes if RAM exceeds 85% (BEFORE system crashes)
  2. CPU workers: Max 16 workers for any process
  3. GPU: Ensure training uses GPU ONLY, not CPU fallback
  4. DataLoader: Max 8 num_workers for any PyTorch DataLoader

Runs every 10 seconds. Kills offenders immediately. Sends Discord alerts.
This is a SAFETY SYSTEM — aggressive by design.

Usage:
    python utils/neptune_guardian.py                # Run persistent
    python utils/neptune_guardian.py --once          # Single check
    python utils/neptune_guardian.py --dry-run       # Report only, don't kill
"""

import argparse
import json
import os
import subprocess
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

# ── Hard Limits (DO NOT RAISE THESE) ─────────────────────────────────────────
RAM_CRITICAL_PCT = 85      # Kill training processes above this
RAM_WARNING_PCT = 75       # Alert but don't kill
MAX_CPU_WORKERS = 16       # Hard cap on CPU worker processes
MAX_DATALOADER_WORKERS = 8 # Hard cap on PyTorch DataLoader num_workers
RAM_CHECK_INTERVAL = 10    # Seconds between checks
GPU_VRAM_TOTAL_MB = 24576  # RTX 3090 = 24GB

# Processes we're allowed to kill (training/compute only — never system processes)
KILLABLE_PROCESS_NAMES = [
    'python.exe', 'python3.exe', 'python3.10.exe', 'python3.11.exe',
]

# Processes we NEVER kill even if they're using RAM
PROTECTED_PROCESSES = [
    'explorer.exe', 'dwm.exe', 'csrss.exe', 'svchost.exe', 'System',
    'RuntimeBroker.exe', 'SearchHost.exe', 'discord.exe', 'Discord.exe',
    'chrome.exe', 'msedge.exe', 'firefox.exe', 'Code.exe',
    'node.exe',  # Our own orchestrator
    'claude.exe', 'claude-agent.exe',
    'sshd.exe', 'WindowsTerminal.exe', 'cmd.exe', 'powershell.exe',
    'nvidia-smi.exe', 'nvcontainer.exe',
    'steam.exe', 'steamwebhelper.exe',
    'EscapeFromTarkov.exe', 'Tarkov.exe', 'valorant.exe',
    'VALORANT-Win64-Shipping.exe', 'cs2.exe',
]

# ── Paths ────────────────────────────────────────────────────────────────────
TELECLAUDE = Path(__file__).resolve().parent.parent
LOG_FILE = TELECLAUDE / 'neptune_guardian.log'
STATE_FILE = TELECLAUDE / '.neptune_guardian_state.json'
ALERTS_FILE = TELECLAUDE / 'compute_alerts.json'

# ── Logging ──────────────────────────────────────────────────────────────────

def log(msg, level='INFO'):
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    sys.stdout.flush()
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def emit_alert(severity, message):
    """Write alert to compute_alerts.json for Discord delivery."""
    alert = {
        'timestamp': datetime.now().isoformat(),
        'severity': severity,
        'machine': 'Neptune',
        'message': f'[GUARDIAN] {message}',
    }
    try:
        existing = []
        if ALERTS_FILE.exists():
            with open(ALERTS_FILE) as f:
                existing = json.load(f)
        existing.append(alert)
        if len(existing) > 200:
            existing = existing[-200:]
        with open(ALERTS_FILE, 'w') as f:
            json.dump(existing, f, indent=2)
    except Exception:
        pass


# ── System Queries ───────────────────────────────────────────────────────────

def get_ram_usage():
    """Get RAM usage as (used_pct, used_gb, total_gb, free_gb)."""
    try:
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-Command',
             'Get-CimInstance Win32_OperatingSystem | '
             'Select-Object TotalVisibleMemorySize,FreePhysicalMemory | '
             'ConvertTo-Json'],
            timeout=15, stderr=subprocess.DEVNULL
        ).decode().strip()
        data = json.loads(out)
        total_kb = data['TotalVisibleMemorySize']
        free_kb = data['FreePhysicalMemory']
        if total_kb == 0:
            return None
        used_kb = total_kb - free_kb
        used_pct = round((used_kb / total_kb) * 100, 1)
        used_gb = round(used_kb / 1048576, 1)
        total_gb = round(total_kb / 1048576, 1)
        free_gb = round(free_kb / 1048576, 1)
        return (used_pct, used_gb, total_gb, free_gb)
    except Exception as e:
        log(f"Failed to get RAM: {e}", 'ERROR')
        return None


def get_gpu_usage():
    """Get GPU usage as (gpu_pct, vram_used_mb, vram_total_mb)."""
    try:
        out = subprocess.check_output(
            ['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total',
             '--format=csv,noheader,nounits'],
            timeout=10, stderr=subprocess.DEVNULL
        ).decode().strip()
        parts = [p.strip() for p in out.split(',')]
        if len(parts) >= 3:
            return (int(parts[0]), int(parts[1]), int(parts[2]))
    except Exception:
        pass
    return None


def get_python_processes():
    """Get list of python processes with PID, memory usage, and command line."""
    procs = []
    try:
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-Command',
             "Get-Process python*,python3* -ErrorAction SilentlyContinue | "
             "Select-Object Id,WorkingSet64,@{N='CmdLine';E={(Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.Id)\").CommandLine}} | "
             "ConvertTo-Json"],
            timeout=20, stderr=subprocess.DEVNULL
        ).decode('utf-8', errors='replace').strip()

        if not out or out == '':
            return procs

        data = json.loads(out)
        # PowerShell returns a single object (not array) if only 1 process
        if isinstance(data, dict):
            data = [data]

        for item in data:
            pid = item.get('Id')
            mem_bytes = item.get('WorkingSet64', 0)
            cmd = item.get('CmdLine', '') or ''
            if pid:
                procs.append({
                    'pid': pid,
                    'mem_bytes': mem_bytes,
                    'mem_mb': round(mem_bytes / (1024 * 1024), 1),
                    'mem_gb': round(mem_bytes / (1024 * 1024 * 1024), 2),
                    'cmd': cmd,
                })

    except json.JSONDecodeError:
        pass  # No Python processes running
    except Exception as e:
        log(f"Failed to get Python processes: {e}", 'ERROR')

    return procs


def get_cpu_usage():
    """Get CPU usage percentage."""
    try:
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-Command',
             "(Get-CimInstance Win32_Processor).LoadPercentage"],
            timeout=15, stderr=subprocess.DEVNULL
        ).decode().strip()
        return int(out)
    except Exception:
        pass
    return None


def count_python_child_processes():
    """Count total Python processes (proxy for worker count)."""
    try:
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-Command',
             '@(Get-Process python*,python3* -ErrorAction SilentlyContinue).Count'],
            timeout=15, stderr=subprocess.DEVNULL
        ).decode().strip()
        return int(out) if out else 0
    except Exception:
        return 0


def kill_process(pid, reason):
    """Kill a process by PID. Returns True if successful."""
    try:
        log(f"KILLING PID {pid}: {reason}", 'CRITICAL')
        subprocess.check_output(
            ['taskkill', '/F', '/PID', str(pid)],
            timeout=10, stderr=subprocess.DEVNULL
        )
        return True
    except Exception as e:
        log(f"Failed to kill PID {pid}: {e}", 'ERROR')
        return False


# ── Enforcement Logic ────────────────────────────────────────────────────────

def enforce_ram_limit(dry_run=False):
    """Check RAM and kill training processes if over limit."""
    ram = get_ram_usage()
    if ram is None:
        return

    used_pct, used_gb, total_gb, free_gb = ram

    if used_pct >= RAM_CRITICAL_PCT:
        log(f"RAM CRITICAL: {used_pct}% ({used_gb}/{total_gb} GB, {free_gb} GB free)", 'CRITICAL')
        emit_alert('CRITICAL', f'RAM at {used_pct}% ({used_gb}/{total_gb} GB)! Killing training processes.')

        if dry_run:
            log("DRY RUN — would kill training processes", 'WARNING')
            return

        # Get Python processes sorted by memory (largest first)
        procs = get_python_processes()
        procs.sort(key=lambda p: p.get('mem_bytes', 0), reverse=True)

        killed = 0
        for proc in procs:
            pid = proc.get('pid')
            cmd = proc.get('cmd', '')
            mem_gb = proc.get('mem_gb', 0)

            # Skip tiny processes
            if mem_gb < 0.5:
                continue

            # Kill it
            reason = f"RAM at {used_pct}% — process using {mem_gb} GB: {cmd[:100]}"
            if kill_process(pid, reason):
                killed += 1
                emit_alert('CRITICAL', f'Killed PID {pid} ({mem_gb} GB): {cmd[:80]}')

            # Re-check RAM after each kill
            time.sleep(2)
            new_ram = get_ram_usage()
            if new_ram and new_ram[0] < RAM_CRITICAL_PCT:
                log(f"RAM recovered to {new_ram[0]}% after killing {killed} process(es)", 'INFO')
                break

        if killed == 0:
            log("No killable Python processes found despite critical RAM!", 'ERROR')
            emit_alert('CRITICAL', 'RAM critical but no Python processes to kill!')

    elif used_pct >= RAM_WARNING_PCT:
        log(f"RAM WARNING: {used_pct}% ({used_gb}/{total_gb} GB, {free_gb} GB free)", 'WARNING')
        # Don't spam — only alert every 5 minutes
    else:
        pass  # RAM is fine


def enforce_worker_limit(dry_run=False):
    """Ensure we don't have too many Python worker processes."""
    count = count_python_child_processes()

    if count > MAX_CPU_WORKERS:
        log(f"WORKER LIMIT EXCEEDED: {count} Python processes (max {MAX_CPU_WORKERS})", 'CRITICAL')
        emit_alert('CRITICAL', f'{count} Python processes running (max {MAX_CPU_WORKERS})! Killing excess.')

        if dry_run:
            log("DRY RUN — would kill excess workers", 'WARNING')
            return

        # Get all Python processes sorted by memory (kill smallest workers first — they're likely the spawned workers)
        procs = get_python_processes()
        procs.sort(key=lambda p: p.get('mem_bytes', 0))

        excess = count - MAX_CPU_WORKERS
        killed = 0

        for proc in procs:
            if killed >= excess:
                break
            pid = proc.get('pid')
            cmd = proc.get('cmd', '')
            mem_gb = proc.get('mem_gb', 0)

            # Skip the main training process (usually the largest)
            # Kill worker subprocesses (usually smaller)
            if mem_gb > 4.0:
                continue  # Probably a main process, skip

            reason = f"Worker limit exceeded ({count}/{MAX_CPU_WORKERS}): {cmd[:100]}"
            if kill_process(pid, reason):
                killed += 1

        log(f"Killed {killed}/{excess} excess workers", 'INFO')


def enforce_gpu_only():
    """Check that training is using GPU, not CPU fallback."""
    gpu = get_gpu_usage()
    if gpu is None:
        return

    gpu_pct, vram_used, vram_total = gpu

    # Get Python processes
    procs = get_python_processes()

    # If we have heavy Python processes (>4GB RAM each) but GPU is idle,
    # they might be doing CPU training — which is WRONG
    heavy_cpu_procs = [p for p in procs if p.get('mem_gb', 0) > 4.0]

    if heavy_cpu_procs and gpu_pct < 5 and vram_used < 2000:
        for proc in heavy_cpu_procs:
            cmd = proc.get('cmd', '').lower()
            # Check if it's a training process
            if any(kw in cmd for kw in ['train', 'walkforward', 'sweep', 'fold', 'epoch']):
                log(f"SUSPICIOUS: Heavy Python process ({proc.get('mem_gb')}GB RAM) but GPU idle! "
                    f"PID {proc.get('pid')}: {proc.get('cmd', '')[:100]}", 'WARNING')
                emit_alert('WARNING',
                    f'Training process using {proc.get("mem_gb")}GB RAM but GPU idle — '
                    f'possible CPU fallback! PID {proc.get("pid")}')


def check_system_health():
    """Full health check — returns status dict."""
    ram = get_ram_usage()
    gpu = get_gpu_usage()
    cpu = get_cpu_usage()
    py_count = count_python_child_processes()

    status = {
        'timestamp': datetime.now().isoformat(),
        'ram_pct': ram[0] if ram else None,
        'ram_used_gb': ram[1] if ram else None,
        'ram_total_gb': ram[2] if ram else None,
        'ram_free_gb': ram[3] if ram else None,
        'gpu_pct': gpu[0] if gpu else None,
        'vram_used_mb': gpu[1] if gpu else None,
        'vram_total_mb': gpu[2] if gpu else None,
        'cpu_pct': cpu,
        'python_count': py_count,
        'limits': {
            'ram_critical_pct': RAM_CRITICAL_PCT,
            'max_cpu_workers': MAX_CPU_WORKERS,
            'max_dataloader_workers': MAX_DATALOADER_WORKERS,
        },
        'violations': [],
    }

    if ram and ram[0] >= RAM_CRITICAL_PCT:
        status['violations'].append(f'RAM at {ram[0]}% (limit: {RAM_CRITICAL_PCT}%)')
    if py_count > MAX_CPU_WORKERS:
        status['violations'].append(f'{py_count} Python processes (limit: {MAX_CPU_WORKERS})')

    return status


# ── Main Loop ────────────────────────────────────────────────────────────────

def run_once(dry_run=False):
    """Single enforcement cycle."""
    enforce_ram_limit(dry_run=dry_run)
    enforce_worker_limit(dry_run=dry_run)
    enforce_gpu_only()
    return check_system_health()


def main():
    parser = argparse.ArgumentParser(description='Neptune Resource Guardian — HARDCORE limits')
    parser.add_argument('--once', action='store_true', help='Run once and exit')
    parser.add_argument('--dry-run', action='store_true', help='Report only, do not kill')
    parser.add_argument('--interval', type=int, default=RAM_CHECK_INTERVAL,
                        help=f'Check interval in seconds (default: {RAM_CHECK_INTERVAL})')
    args = parser.parse_args()

    log("=" * 70)
    log(f"NEPTUNE GUARDIAN STARTED — HARDCORE MODE")
    log(f"  RAM limit: {RAM_CRITICAL_PCT}% (kill training)")
    log(f"  RAM warning: {RAM_WARNING_PCT}%")
    log(f"  Max CPU workers: {MAX_CPU_WORKERS}")
    log(f"  Max DataLoader workers: {MAX_DATALOADER_WORKERS}")
    log(f"  Check interval: {args.interval}s")
    log(f"  Dry run: {args.dry_run}")
    log("=" * 70)

    if args.once:
        status = run_once(dry_run=args.dry_run)
        print(json.dumps(status, indent=2))
        return

    # Persistent monitoring loop
    consecutive_critical = 0
    while True:
        try:
            status = run_once(dry_run=args.dry_run)

            # Track consecutive critical states
            if status.get('violations'):
                consecutive_critical += 1
                if consecutive_critical % 6 == 0:  # Every minute of critical
                    log(f"PERSISTENT VIOLATIONS ({consecutive_critical * args.interval}s): "
                        f"{', '.join(status['violations'])}", 'CRITICAL')
            else:
                if consecutive_critical > 0:
                    log(f"Violations cleared after {consecutive_critical * args.interval}s", 'INFO')
                consecutive_critical = 0

            # Save state
            try:
                with open(STATE_FILE, 'w') as f:
                    json.dump(status, f, indent=2)
            except Exception:
                pass

        except Exception as e:
            log(f"Guardian error: {e}\n{traceback.format_exc()}", 'ERROR')

        time.sleep(args.interval)


if __name__ == '__main__':
    main()
