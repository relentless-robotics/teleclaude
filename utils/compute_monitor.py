"""
compute_monitor.py — Persistent compute health monitor for ALL 5 compute nodes.

Monitors:
  - Neptune (localhost): RTX 3090, Windows
  - Uranus (100.100.83.37): RTX 5090, Windows (Tailscale)
  - Razer (100.102.215.75): RTX 3070, Windows (Tailscale)
  - Jupiter (192.168.0.108): CPU-only, Linux
  - Saturn (10.0.0.2 via Jupiter): CPU-only, Linux

Checks every 5 minutes:
  - GPU: utilization %, temperature, VRAM, power draw
  - CPU/RAM usage
  - Running Python/fill_sim processes
  - Training progress: fold number, IC, train/val loss from logs
  - Disk space
  - SSH connectivity

Alert conditions:
  - GPU idle (<10%) for >10 min when training expected
  - Training stalled (no log output >30 min)
  - Overfitting (val/train loss ratio >1.5 for 3+ folds, declining IC)
  - Job completed (fold count reached target)
  - Disk space <10%
  - SSH connection failure (3+ consecutive)
  - Process crash (expected PID gone)
  - Temperature >85C
  - RAM >90%

Logs to: compute_monitor.log
Alerts to: compute_alerts.json (read by orchestrator for Discord delivery)
State in: .compute_monitor_state.json
Dashboard: data/compute_status.json

Usage:
    python utils/compute_monitor.py                  # Run persistent (5 min interval)
    python utils/compute_monitor.py --interval 300   # Custom interval (seconds)
    python utils/compute_monitor.py --once           # Single check and exit
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
TELECLAUDE = Path(__file__).resolve().parent.parent
LOG_FILE = TELECLAUDE / 'compute_monitor.log'
ALERTS_FILE = TELECLAUDE / 'compute_alerts.json'
STATE_FILE = TELECLAUDE / '.compute_monitor_state.json'
DASHBOARD_STATUS_FILE = TELECLAUDE / 'data' / 'compute_status.json'
HOURLY_REPORT_FILE = TELECLAUDE / 'data' / 'hourly_compute_report.json'
HEARTBEAT_FILE = TELECLAUDE / '.watchdog_heartbeat'
WEBHOOKS_CONFIG = TELECLAUDE / 'config' / 'webhooks.json'

# Add parent for imports
sys.path.insert(0, str(TELECLAUDE))

# ── Server Configuration ────────────────────────────────────────────────────
# Canonical server metadata (supplements remote_servers.json)
SERVER_META = {
    'neptune': {
        'display_name': 'Neptune',
        'os': 'windows',
        'has_gpu': True,
        'gpu_model': 'RTX 3090',
        'description': 'RTX 3090, 32-core CPU, 32GB RAM',
        'ip': 'localhost',
        'is_local': True,
    },
    'uranus': {
        'display_name': 'Uranus',
        'os': 'windows',
        'has_gpu': True,
        'gpu_model': 'RTX 5090',
        'description': 'RTX 5090, 16-core, 130GB RAM',
        'ip': '100.100.83.37',
        'is_local': False,
    },
    'razer': {
        'display_name': 'Razer',
        'os': 'windows',
        'has_gpu': True,
        'gpu_model': 'RTX 3070',
        'description': 'RTX 3070, Laptop',
        'ip': '100.102.215.75',
        'is_local': False,
    },
    'jupiter': {
        'display_name': 'Jupiter',
        'os': 'linux',
        'has_gpu': False,
        'gpu_model': None,
        'description': '16-core CPU, 46GB RAM',
        'ip': '192.168.0.108',
        'is_local': False,
    },
    'saturn': {
        'display_name': 'Saturn',
        'os': 'linux',
        'has_gpu': False,
        'gpu_model': None,
        'description': '48-core CPU, 62GB RAM',
        'ip': '10.0.0.2 (via Jupiter)',
        'is_local': False,
    },
}

# Default check interval
DEFAULT_INTERVAL = 300  # 5 minutes

# ── SSH helper ───────────────────────────────────────────────────────────────

def ssh_run(server_name, command, timeout=30):
    """Run command on remote server via pooled SSH. Returns stdout or None."""
    try:
        from utils.ssh_exec import run_on
        result = run_on(server_name, command, timeout=timeout)
        if result.get('success'):
            return result['stdout']
        # Also accept non-zero exit but with stdout (some commands return 1 with valid output)
        if result.get('stdout'):
            return result['stdout']
        return None
    except Exception:
        return None


def ssh_available(server_name):
    """Check if SSH to server works."""
    result = ssh_run(server_name, 'echo ok', timeout=10)
    return result is not None and 'ok' in result


def _log(msg, level='INFO'):
    """Write to log file with timestamp."""
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"{ts} | [{level}] {msg}"
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


# ── Local (Neptune) checks ───────────────────────────────────────────────────

def check_neptune():
    """Check local machine (Neptune) — GPU, VRAM, temp, Python processes, disk, RAM."""
    info = {
        'name': 'Neptune',
        'gpu_pct': None,
        'gpu_temp_c': None,
        'gpu_power_w': None,
        'vram_used_gb': None,
        'vram_total_gb': None,
        'cpu_pct': None,
        'ram_used_gb': None,
        'ram_total_gb': None,
        'disk_free_pct': None,
        'python_procs': [],
        'python_count': 0,
        'checkpoint_age_min': None,
        'reachable': True,
    }

    # GPU utilization, VRAM, temperature, power via nvidia-smi
    try:
        out = subprocess.check_output(
            ['nvidia-smi',
             '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
             '--format=csv,noheader,nounits'],
            timeout=10, stderr=subprocess.DEVNULL
        ).decode().strip()
        parts = [p.strip() for p in out.split(',')]
        if len(parts) >= 5:
            info['gpu_pct'] = int(parts[0])
            info['vram_used_gb'] = round(int(parts[1]) / 1024, 1)
            info['vram_total_gb'] = round(int(parts[2]) / 1024, 1)
            info['gpu_temp_c'] = int(parts[3])
            try:
                info['gpu_power_w'] = round(float(parts[4]), 1)
            except ValueError:
                pass
    except Exception:
        pass

    # Python processes via tasklist
    try:
        out = subprocess.check_output(
            ['tasklist', '/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'],
            timeout=10, stderr=subprocess.DEVNULL
        ).decode().strip()
        for line in out.split('\n'):
            line = line.strip()
            if not line or 'No tasks' in line:
                continue
            parts = line.replace('"', '').split(',')
            if len(parts) >= 5:
                pid = int(parts[1])
                mem_str = parts[4].strip().replace(' K', '').replace(',', '')
                try:
                    mem_mb = int(mem_str) / 1024
                except ValueError:
                    mem_mb = 0
                info['python_procs'].append({'pid': pid, 'mem_mb': round(mem_mb, 1)})
        info['python_count'] = len(info['python_procs'])
    except Exception:
        pass

    # Try to get command lines for python processes (Windows)
    try:
        out = subprocess.check_output(
            ['wmic', 'process', 'where', "name='python.exe'", 'get',
             'ProcessId,CommandLine', '/format:csv'],
            timeout=15, stderr=subprocess.DEVNULL
        ).decode().strip()
        cmd_map = {}
        for line in out.split('\n'):
            line = line.strip()
            if not line or line.startswith('Node'):
                continue
            # CSV: Node,CommandLine,ProcessId
            parts = line.split(',')
            if len(parts) >= 3:
                try:
                    pid = int(parts[-1].strip())
                    cmd = ','.join(parts[1:-1]).strip()
                    cmd_map[pid] = cmd[:200]
                except ValueError:
                    pass
        # Merge command lines into process list
        for proc in info['python_procs']:
            if proc['pid'] in cmd_map:
                proc['cmd'] = cmd_map[proc['pid']]
    except Exception:
        pass

    # RAM via wmic
    try:
        ram_out = subprocess.check_output(
            ['wmic', 'OS', 'get', 'TotalVisibleMemorySize,FreePhysicalMemory', '/value'],
            timeout=5, stderr=subprocess.DEVNULL
        ).decode().strip()
        total_kb = free_kb = 0
        for line in ram_out.split('\n'):
            line = line.strip()
            if line.startswith('TotalVisibleMemorySize='):
                total_kb = int(line.split('=')[1])
            elif line.startswith('FreePhysicalMemory='):
                free_kb = int(line.split('=')[1])
        if total_kb:
            info['ram_total_gb'] = round(total_kb / 1048576, 1)
            info['ram_used_gb'] = round((total_kb - free_kb) / 1048576, 1)
    except Exception:
        pass

    # CPU usage via wmic
    try:
        cpu_out = subprocess.check_output(
            ['wmic', 'cpu', 'get', 'loadpercentage', '/value'],
            timeout=5, stderr=subprocess.DEVNULL
        ).decode().strip()
        for line in cpu_out.split('\n'):
            line = line.strip()
            if line.startswith('LoadPercentage='):
                info['cpu_pct'] = int(line.split('=')[1])
    except Exception:
        pass

    # Disk space (C: drive)
    try:
        disk_out = subprocess.check_output(
            ['wmic', 'logicaldisk', 'where', "DeviceID='C:'", 'get',
             'FreeSpace,Size', '/value'],
            timeout=5, stderr=subprocess.DEVNULL
        ).decode().strip()
        free_bytes = total_bytes = 0
        for line in disk_out.split('\n'):
            line = line.strip()
            if line.startswith('FreeSpace='):
                free_bytes = int(line.split('=')[1])
            elif line.startswith('Size='):
                total_bytes = int(line.split('=')[1])
        if total_bytes > 0:
            info['disk_free_pct'] = round((free_bytes / total_bytes) * 100, 1)
    except Exception:
        pass

    # Checkpoint timestamps — check Lvl3Quant deep_models results
    try:
        ckpt_dir = Path('C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery/deep_models/results')
        if ckpt_dir.exists():
            ckpts = sorted(ckpt_dir.glob('*.pt'), key=lambda p: p.stat().st_mtime, reverse=True)
            if not ckpts:
                ckpts = sorted(ckpt_dir.glob('*.pth'), key=lambda p: p.stat().st_mtime, reverse=True)
            if not ckpts:
                ckpts = sorted(ckpt_dir.glob('*.npz'), key=lambda p: p.stat().st_mtime, reverse=True)
            if ckpts:
                newest = ckpts[0].stat().st_mtime
                age_min = (time.time() - newest) / 60
                info['checkpoint_age_min'] = round(age_min, 1)
    except Exception:
        pass

    return info


# ── Remote Windows GPU machine checks (Uranus, Razer) ───────────────────────

def check_windows_gpu_machine(server_name, display_name):
    """Check a remote Windows GPU machine — GPU, VRAM, temp, power, processes, disk, RAM."""
    info = {
        'name': display_name,
        'gpu_pct': None,
        'gpu_temp_c': None,
        'gpu_power_w': None,
        'vram_used_gb': None,
        'vram_total_gb': None,
        'cpu_pct': None,
        'ram_used_gb': None,
        'ram_total_gb': None,
        'disk_free_pct': None,
        'python_procs': [],
        'python_count': 0,
        'checkpoint_age_min': None,
        'log_age_min': None,
        'log_tail': None,
        'reachable': False,
    }

    # Check if we're dealing with Windows SSH (OpenSSH on Windows) or WSL
    meta = SERVER_META.get(server_name, {})
    is_windows = meta.get('os') == 'windows'

    # GPU check — nvidia-smi works the same on Windows and Linux
    gpu_cmd = (
        "nvidia-smi "
        "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw "
        "--format=csv,noheader,nounits"
    )
    gpu_out = ssh_run(server_name, gpu_cmd, timeout=15)
    if gpu_out is None:
        return info

    info['reachable'] = True

    # Parse GPU output
    parts = [p.strip() for p in gpu_out.strip().split(',')]
    if len(parts) >= 5:
        try:
            info['gpu_pct'] = int(parts[0])
            info['vram_used_gb'] = round(int(parts[1]) / 1024, 1)
            info['vram_total_gb'] = round(int(parts[2]) / 1024, 1)
            info['gpu_temp_c'] = int(parts[3])
            try:
                info['gpu_power_w'] = round(float(parts[4]), 1)
            except ValueError:
                pass
        except ValueError:
            pass

    if is_windows:
        # Windows: use tasklist for processes
        procs_cmd = 'tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH'
        procs_out = ssh_run(server_name, procs_cmd, timeout=15) or ''

        for line in procs_out.split('\n'):
            line = line.strip()
            if not line or 'No tasks' in line or 'INFO:' in line:
                continue
            parts = line.replace('"', '').split(',')
            if len(parts) >= 5:
                try:
                    pid = int(parts[1])
                    mem_str = parts[4].strip().replace(' K', '').replace(',', '')
                    mem_mb = int(mem_str) / 1024
                    info['python_procs'].append({
                        'pid': pid,
                        'mem_mb': round(mem_mb, 1),
                    })
                except ValueError:
                    pass

        # Get command lines for python processes on Windows
        cmdline_cmd = (
            'wmic process where "name=\'python.exe\'" get ProcessId,CommandLine /format:csv'
        )
        cmdline_out = ssh_run(server_name, cmdline_cmd, timeout=15) or ''
        cmd_map = {}
        for line in cmdline_out.split('\n'):
            line = line.strip()
            if not line or line.startswith('Node'):
                continue
            parts = line.split(',')
            if len(parts) >= 3:
                try:
                    pid = int(parts[-1].strip())
                    cmd = ','.join(parts[1:-1]).strip()
                    cmd_map[pid] = cmd[:200]
                except ValueError:
                    pass
        for proc in info['python_procs']:
            if proc['pid'] in cmd_map:
                proc['cmd'] = cmd_map[proc['pid']]

        # RAM via wmic
        ram_cmd = 'wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /value'
        ram_out = ssh_run(server_name, ram_cmd, timeout=10) or ''
        total_kb = free_kb = 0
        for line in ram_out.split('\n'):
            line = line.strip()
            if line.startswith('TotalVisibleMemorySize='):
                try:
                    total_kb = int(line.split('=')[1])
                except ValueError:
                    pass
            elif line.startswith('FreePhysicalMemory='):
                try:
                    free_kb = int(line.split('=')[1])
                except ValueError:
                    pass
        if total_kb:
            info['ram_total_gb'] = round(total_kb / 1048576, 1)
            info['ram_used_gb'] = round((total_kb - free_kb) / 1048576, 1)

        # CPU via wmic
        cpu_cmd = 'wmic cpu get loadpercentage /value'
        cpu_out = ssh_run(server_name, cpu_cmd, timeout=10) or ''
        for line in cpu_out.split('\n'):
            line = line.strip()
            if line.startswith('LoadPercentage='):
                try:
                    info['cpu_pct'] = int(line.split('=')[1])
                except ValueError:
                    pass

        # Disk space via wmic
        disk_cmd = "wmic logicaldisk where \"DeviceID='C:'\" get FreeSpace,Size /value"
        disk_out = ssh_run(server_name, disk_cmd, timeout=10) or ''
        free_bytes = total_bytes = 0
        for line in disk_out.split('\n'):
            line = line.strip()
            if line.startswith('FreeSpace='):
                try:
                    free_bytes = int(line.split('=')[1])
                except ValueError:
                    pass
            elif line.startswith('Size='):
                try:
                    total_bytes = int(line.split('=')[1])
                except ValueError:
                    pass
        if total_bytes > 0:
            info['disk_free_pct'] = round((free_bytes / total_bytes) * 100, 1)

        # Training log — check for walkforward logs or training logs
        # Use PowerShell Get-ChildItem for Windows log discovery
        log_cmd = (
            'powershell -Command "'
            "Get-ChildItem -Path $env:USERPROFILE\\Documents -Recurse -Include *.log "
            "-ErrorAction SilentlyContinue | "
            "Where-Object { $_.Name -match 'walkforward|training|train_' } | "
            "Sort-Object LastWriteTime -Descending | "
            "Select-Object -First 1 -ExpandProperty FullName"
            '"'
        )
        log_path = ssh_run(server_name, log_cmd, timeout=20)
        if log_path and log_path.strip():
            log_path = log_path.strip()
            # Get log age
            age_cmd = (
                f'powershell -Command "'
                f"$f = Get-Item '{log_path}' -ErrorAction SilentlyContinue; "
                f"if ($f) {{ ((Get-Date) - $f.LastWriteTime).TotalMinutes }}"
                f'"'
            )
            age_out = ssh_run(server_name, age_cmd, timeout=10)
            if age_out:
                try:
                    info['log_age_min'] = round(float(age_out.strip()), 1)
                except ValueError:
                    pass

            # Get last 10 lines of log
            tail_cmd = (
                f'powershell -Command "Get-Content -Path \'{log_path}\' -Tail 10"'
            )
            tail_out = ssh_run(server_name, tail_cmd, timeout=15)
            if tail_out:
                info['log_tail'] = tail_out.strip()[:500]

    else:
        # Linux-style commands (shouldn't hit this for GPU machines, but fallback)
        procs_cmd = "ps aux | grep python | grep -v grep | awk '{print $2, $4, $11, $12, $13}'"
        procs_out = ssh_run(server_name, procs_cmd, timeout=15) or ''
        for line in procs_out.split('\n'):
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 4)
            if len(parts) >= 2:
                try:
                    pid = int(parts[0])
                    mem_pct = float(parts[1])
                    cmdline = ' '.join(parts[2:]) if len(parts) > 2 else ''
                    info['python_procs'].append({
                        'pid': pid,
                        'mem_pct': mem_pct,
                        'cmd': cmdline[:200]
                    })
                except ValueError:
                    pass

        # RAM
        ram_out = ssh_run(server_name, "free -m | grep Mem | awk '{print $2, $3}'", timeout=10)
        if ram_out:
            parts = ram_out.strip().split()
            if len(parts) >= 2:
                try:
                    info['ram_total_gb'] = round(int(parts[0]) / 1024, 1)
                    info['ram_used_gb'] = round(int(parts[1]) / 1024, 1)
                except ValueError:
                    pass

        # CPU load
        cpu_out = ssh_run(server_name, "cat /proc/loadavg | awk '{print $1}'", timeout=10)
        if cpu_out:
            try:
                info['cpu_pct'] = float(cpu_out.strip())
            except ValueError:
                pass

        # Disk
        disk_out = ssh_run(server_name, "df -h / | tail -1 | awk '{print $5}'", timeout=10)
        if disk_out:
            try:
                used_pct = int(disk_out.strip().replace('%', ''))
                info['disk_free_pct'] = 100 - used_pct
            except ValueError:
                pass

        # Log tail
        log_cmd = (
            "ls -t ~/Lvl3Quant/walkforward_*.log ~/Lvl3Quant/*.log "
            "~/Lvl3Quant/alpha_discovery/deep_models/*.log 2>/dev/null | "
            "grep -v 'No such' | head -1"
        )
        log_path_out = ssh_run(server_name, log_cmd, timeout=15)
        if log_path_out and log_path_out.strip() and log_path_out.strip() != 'none':
            log_path = log_path_out.strip()
            age_cmd = f"stat -c %Y '{log_path}' 2>/dev/null"
            age_out = ssh_run(server_name, age_cmd, timeout=10)
            if age_out:
                try:
                    log_epoch = int(age_out.strip())
                    info['log_age_min'] = round((time.time() - log_epoch) / 60, 1)
                except ValueError:
                    pass
            tail_cmd = f"tail -10 '{log_path}' 2>/dev/null"
            tail_out = ssh_run(server_name, tail_cmd, timeout=15)
            if tail_out:
                info['log_tail'] = tail_out.strip()[:500]

    info['python_count'] = len(info['python_procs'])
    return info


# ── CPU machines (Jupiter, Saturn) checks ────────────────────────────────────

def check_cpu_machine(server_name, display_name):
    """Check a CPU-based Linux machine — load, RAM, disk, fill_sim procs, result counts."""
    info = {
        'name': display_name,
        'load_avg': None,
        'cpu_pct': None,
        'ram_used_gb': None,
        'ram_total_gb': None,
        'disk_free_pct': None,
        'fill_sim_count': 0,
        'python_count': 0,
        'result_file_count': 0,
        'python_procs': [],
        'reachable': False,
    }

    # Single compound command for efficiency
    cmd = (
        "cat /proc/loadavg 2>/dev/null; "
        "echo '===FILLSIM==='; "
        "ps aux | grep -c '[f]ill_sim' 2>/dev/null; "
        "echo '===PYTHON==='; "
        "ps aux | grep -c '[p]ython' 2>/dev/null; "
        "echo '===RESULTS==='; "
        "find ~/Lvl3Quant ~/lvl3quant -name '*.json' "
        "\\( -path '*/results/*' -o -path '*_results/*' \\) 2>/dev/null | wc -l; "
        "echo '===RAM==='; "
        "free -m | grep Mem | awk '{print $2, $3}'; "
        "echo '===DISK==='; "
        "df -h / | tail -1 | awk '{print $5}'; "
        "echo '===PROCS==='; "
        "ps aux | grep '[p]ython\\|[f]ill_sim' | awk '{print $2, $11, $12, $13}' | head -30"
    )

    out = ssh_run(server_name, cmd, timeout=30)
    if out is None:
        return info

    info['reachable'] = True

    # Parse load average
    load_line = out.split('===FILLSIM===')[0].strip() if '===FILLSIM===' in out else ''
    if load_line:
        parts = load_line.split()
        if parts:
            try:
                info['load_avg'] = float(parts[0])
                info['cpu_pct'] = info['load_avg']  # Approximate
            except ValueError:
                pass

    # Parse fill_sim count
    if '===FILLSIM===' in out and '===PYTHON===' in out:
        fs_section = out.split('===FILLSIM===')[1].split('===PYTHON===')[0].strip()
        try:
            info['fill_sim_count'] = int(fs_section)
        except ValueError:
            pass

    # Parse python count
    if '===PYTHON===' in out and '===RESULTS===' in out:
        py_section = out.split('===PYTHON===')[1].split('===RESULTS===')[0].strip()
        try:
            info['python_count'] = int(py_section)
        except ValueError:
            pass

    # Parse result count
    if '===RESULTS===' in out and '===RAM===' in out:
        res_section = out.split('===RESULTS===')[1].split('===RAM===')[0].strip()
        try:
            info['result_file_count'] = int(res_section)
        except ValueError:
            pass

    # Parse RAM
    if '===RAM===' in out and '===DISK===' in out:
        ram_section = out.split('===RAM===')[1].split('===DISK===')[0].strip()
        parts = ram_section.split()
        if len(parts) >= 2:
            try:
                info['ram_total_gb'] = round(int(parts[0]) / 1024, 1)
                info['ram_used_gb'] = round(int(parts[1]) / 1024, 1)
            except ValueError:
                pass

    # Parse disk
    if '===DISK===' in out and '===PROCS===' in out:
        disk_section = out.split('===DISK===')[1].split('===PROCS===')[0].strip()
        try:
            used_pct = int(disk_section.replace('%', ''))
            info['disk_free_pct'] = 100 - used_pct
        except ValueError:
            pass

    # Parse process list
    if '===PROCS===' in out:
        procs_section = out.split('===PROCS===')[1].strip()
        for line in procs_section.split('\n'):
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 3)
            if len(parts) >= 2:
                try:
                    pid = int(parts[0])
                    cmd = ' '.join(parts[1:]) if len(parts) > 1 else ''
                    info['python_procs'].append({
                        'pid': pid,
                        'cmd': cmd[:200],
                    })
                except ValueError:
                    pass

    return info


# ── State Management ─────────────────────────────────────────────────────────

def load_state():
    """Load persistent state from disk."""
    default = {
        'last_check': None,
        'ssh_failures': {},           # server -> consecutive failure count
        'last_ckpt_ts': {},           # server -> last known checkpoint timestamp
        'last_result_counts': {},     # server -> last known result file count
        'last_pids': {},              # server -> {pid: cmd} last known processes
        'last_log_age': {},           # server -> log age in minutes at last check
        'alert_history': {},          # alert_key -> last_fired_ts (cooldown)
        'gpu_idle_since': {},         # server -> timestamp when GPU went idle
        'log_stall_since': {},        # server -> timestamp when log stopped updating
        'ic_history': {},             # server -> list of {fold, ic, timestamp}
        'expected_jobs': {},          # server -> {description, expected_folds, started_at}
        'last_fold_seen': {},         # server -> last fold number detected
        'hourly_report_ts': 0,       # timestamp of last hourly report
        'stall_cycles': {},           # server -> consecutive stall cycles
        'check_count': 0,
        'overfit_consec': {},         # server -> consecutive overfitting detections
    }
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE) as f:
                saved = json.load(f)
            # Merge with defaults for new fields
            for k, v in default.items():
                if k not in saved:
                    saved[k] = v
            return saved
        except Exception:
            pass
    return default


def save_state(state):
    """Save state to disk."""
    state['last_check'] = datetime.now().isoformat()
    try:
        with open(STATE_FILE, 'w') as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        _log(f"Failed to save state: {e}", 'ERROR')


# ── Webhook Helper ──────────────────────────────────────────────────────────

def get_webhook_url():
    """Load Discord webhook URL from config/webhooks.json."""
    try:
        if WEBHOOKS_CONFIG.exists():
            with open(WEBHOOKS_CONFIG) as f:
                config = json.load(f)
                return config.get('webhooks', {}).get('alerts') or config.get('webhooks', {}).get('default')
    except Exception:
        pass
    return None


def send_discord_webhook(webhook_url, message, severity='INFO'):
    """Send alert to Discord webhook. Returns True if successful."""
    if not webhook_url:
        return False

    try:
        # Map severity to color
        color_map = {
            'CRITICAL': 0xff0000,  # red
            'WARNING': 0xffa500,   # orange
            'INFO': 0x3b82f6,      # blue
        }
        color = color_map.get(severity, 0x3b82f6)

        payload = {
            'embeds': [{
                'title': f'[{severity}] Compute Alert',
                'description': message,
                'color': color,
                'timestamp': datetime.now().isoformat(),
            }]
        }

        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            webhook_url,
            data=data,
            headers={'Content-Type': 'application/json'}
        )

        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status in (200, 204)
    except urllib.error.URLError as e:
        _log(f"Failed to send webhook: {e}", 'ERROR')
        return False
    except Exception as e:
        _log(f"Webhook error: {e}", 'ERROR')
        return False


def update_heartbeat():
    """Update heartbeat file to show watchdog is alive."""
    try:
        with open(HEARTBEAT_FILE, 'w') as f:
            f.write(datetime.now().isoformat())
    except Exception:
        pass


# ── Alert System ─────────────────────────────────────────────────────────────

def emit_alert(alerts_list, severity, machine, message, state, cooldown_min=30):
    """Create an alert if not in cooldown. Severity: CRITICAL, WARNING, INFO."""
    alert_key = f"{machine}:{message[:60]}"
    now = time.time()

    # Check cooldown
    last_fired = state.get('alert_history', {}).get(alert_key, 0)
    if now - last_fired < cooldown_min * 60:
        return False

    alert = {
        'timestamp': datetime.now().isoformat(),
        'severity': severity,
        'machine': machine,
        'message': message,
        'key': alert_key,
    }
    alerts_list.append(alert)

    if 'alert_history' not in state:
        state['alert_history'] = {}
    state['alert_history'][alert_key] = now

    _log(f"ALERT [{severity}] {machine}: {message}", severity)
    return True


def write_alerts(alerts_list):
    """Append alerts to the alerts JSON file for the orchestrator to pick up.
    Also attempt to send via Discord webhook if configured."""
    existing = []
    if ALERTS_FILE.exists():
        try:
            with open(ALERTS_FILE) as f:
                existing = json.load(f)
        except Exception:
            existing = []

    # Add unread flag to new alerts
    for alert in alerts_list:
        alert['unread'] = True

    existing.extend(alerts_list)

    # Keep only last 200 alerts
    if len(existing) > 200:
        existing = existing[-200:]

    # Write to file
    try:
        with open(ALERTS_FILE, 'w') as f:
            json.dump(existing, f, indent=2)
    except Exception as e:
        _log(f"Failed to write alerts file: {e}", 'ERROR')

    # Also attempt to send via webhook
    webhook_url = get_webhook_url()
    if webhook_url:
        for alert in alerts_list:
            msg = f"**{alert['machine']}**: {alert['message']}"
            send_discord_webhook(webhook_url, msg, alert.get('severity', 'INFO'))


# ── Training Log Parsing ────────────────────────────────────────────────────

def parse_fold_metrics(log_text):
    """Parse fold-by-fold training metrics from a training log.

    Looks for patterns like:
        Fold 1: train_loss=0.023, val_loss=0.035, IC=0.142
        Fold 2  train_loss 0.021  val_loss 0.041  IC 0.128
        [Fold 3] loss=0.019 val_loss=0.055 IC=0.115
        Fold 4/8 -- train: 0.018, val: 0.061, ic: 0.098

    Returns list of dicts: [{'fold': int, 'train_loss': float, 'val_loss': float, 'ic': float}, ...]
    """
    folds = []
    if not log_text:
        return folds

    for line in log_text.split('\n'):
        fold_match = re.search(r'[Ff]old\s*[\[#]?\s*(\d+)', line)
        if not fold_match:
            continue

        fold_num = int(fold_match.group(1))

        train_loss = None
        tl_match = re.search(r'train[_\s]?loss[=:\s]+([\d.]+)', line, re.IGNORECASE)
        if not tl_match:
            tl_match = re.search(r'train[=:\s]+([\d.]+)', line, re.IGNORECASE)
        if tl_match:
            try:
                train_loss = float(tl_match.group(1))
            except ValueError:
                pass

        val_loss = None
        vl_match = re.search(r'val[_\s]?loss[=:\s]+([\d.]+)', line, re.IGNORECASE)
        if not vl_match:
            vl_match = re.search(r'val[=:\s]+([\d.]+)', line, re.IGNORECASE)
        if vl_match:
            try:
                val_loss = float(vl_match.group(1))
            except ValueError:
                pass

        ic = None
        ic_match = re.search(r'\bIC[=:\s]+([-\d.]+)', line, re.IGNORECASE)
        if ic_match:
            try:
                ic = float(ic_match.group(1))
            except ValueError:
                pass

        if train_loss is not None or val_loss is not None or ic is not None:
            folds.append({
                'fold': fold_num,
                'train_loss': train_loss,
                'val_loss': val_loss,
                'ic': ic,
            })

    # Deduplicate — keep last occurrence of each fold number
    seen = {}
    for f in folds:
        seen[f['fold']] = f
    return sorted(seen.values(), key=lambda x: x['fold'])


def parse_training_progress(log_text):
    """Extract current training progress from log text.

    Returns dict with:
      - current_fold: int or None
      - total_folds: int or None
      - current_epoch: int or None
      - total_epochs: int or None
      - latest_ic: float or None
      - latest_loss: float or None
      - errors: list of error strings found
    """
    progress = {
        'current_fold': None,
        'total_folds': None,
        'current_epoch': None,
        'total_epochs': None,
        'latest_ic': None,
        'latest_loss': None,
        'errors': [],
    }

    if not log_text:
        return progress

    lines = log_text.strip().split('\n')

    # Scan from bottom for most recent progress
    for line in reversed(lines):
        # Fold progress: "Fold 3/8" or "Fold 3 of 8"
        if progress['current_fold'] is None:
            fold_match = re.search(r'[Ff]old\s*(\d+)\s*[/of]+\s*(\d+)', line)
            if fold_match:
                progress['current_fold'] = int(fold_match.group(1))
                progress['total_folds'] = int(fold_match.group(2))
            else:
                fold_match = re.search(r'[Ff]old\s*[\[#]?\s*(\d+)', line)
                if fold_match:
                    progress['current_fold'] = int(fold_match.group(1))

        # Epoch progress: "Epoch 15/100"
        if progress['current_epoch'] is None:
            epoch_match = re.search(r'[Ee]poch\s*(\d+)\s*[/of]+\s*(\d+)', line)
            if epoch_match:
                progress['current_epoch'] = int(epoch_match.group(1))
                progress['total_epochs'] = int(epoch_match.group(2))

        # IC value
        if progress['latest_ic'] is None:
            ic_match = re.search(r'\bIC[=:\s]+([-\d.]+)', line, re.IGNORECASE)
            if ic_match:
                try:
                    progress['latest_ic'] = float(ic_match.group(1))
                except ValueError:
                    pass

        # Loss value
        if progress['latest_loss'] is None:
            loss_match = re.search(r'(?:val_)?loss[=:\s]+([\d.]+)', line, re.IGNORECASE)
            if loss_match:
                try:
                    progress['latest_loss'] = float(loss_match.group(1))
                except ValueError:
                    pass

    # Scan for errors (look at all lines, not just recent)
    error_patterns = [
        r'ERROR',
        r'Traceback',
        r'CUDA.*(?:error|out of memory)',
        r'OOM',
        r'RuntimeError',
        r'torch\.cuda\.OutOfMemoryError',
    ]
    for line in lines[-50:]:  # Only check last 50 lines for errors
        for pattern in error_patterns:
            if re.search(pattern, line, re.IGNORECASE):
                progress['errors'].append(line.strip()[:200])
                break

    return progress


# ── Overfitting Detection ────────────────────────────────────────────────────

def detect_overfitting(fold_metrics, consecutive_threshold=3):
    """Detect overfitting from fold metrics.

    Triggers on:
      1. val_loss / train_loss ratio > 1.5 for consecutive_threshold+ folds
      2. IC declining for consecutive_threshold+ consecutive folds

    Returns dict with detection results or None if no overfitting detected.
    """
    if len(fold_metrics) < consecutive_threshold:
        return None

    result = {
        'detected': False,
        'reasons': [],
        'overfit_folds': [],
        'loss_ratio_folds': [],
        'ic_decline_folds': [],
        'fold_details': [],
    }

    # Check 1: val_loss / train_loss ratio > 1.5
    consecutive_high_ratio = 0
    high_ratio_folds = []
    for fm in fold_metrics:
        tl = fm.get('train_loss')
        vl = fm.get('val_loss')
        if tl is not None and vl is not None and tl > 0:
            ratio = vl / tl
            if ratio > 1.5:
                consecutive_high_ratio += 1
                high_ratio_folds.append({
                    'fold': fm['fold'],
                    'train_loss': tl,
                    'val_loss': vl,
                    'ratio': round(ratio, 2),
                })
            else:
                if consecutive_high_ratio >= consecutive_threshold:
                    break
                consecutive_high_ratio = 0
                high_ratio_folds = []

    if consecutive_high_ratio >= consecutive_threshold:
        result['detected'] = True
        result['loss_ratio_folds'] = high_ratio_folds
        result['overfit_folds'].extend([f['fold'] for f in high_ratio_folds])
        result['reasons'].append(
            f'val_loss/train_loss ratio > 1.5 for {consecutive_high_ratio} consecutive folds'
        )

    # Check 2: IC declining for consecutive_threshold+ folds
    ic_values = [(fm['fold'], fm['ic']) for fm in fold_metrics if fm.get('ic') is not None]
    if len(ic_values) >= consecutive_threshold:
        consecutive_decline = 0
        decline_folds = []
        for i in range(1, len(ic_values)):
            if ic_values[i][1] < ic_values[i - 1][1]:
                consecutive_decline += 1
                if consecutive_decline == 1:
                    decline_folds.append({
                        'fold': ic_values[i - 1][0],
                        'ic': ic_values[i - 1][1],
                    })
                decline_folds.append({
                    'fold': ic_values[i][0],
                    'ic': ic_values[i][1],
                })
            else:
                if consecutive_decline >= consecutive_threshold:
                    break
                consecutive_decline = 0
                decline_folds = []

        if consecutive_decline >= consecutive_threshold:
            result['detected'] = True
            result['ic_decline_folds'] = decline_folds
            result['overfit_folds'].extend([f['fold'] for f in decline_folds])
            result['reasons'].append(
                f'IC declining for {consecutive_decline} consecutive folds '
                f'({decline_folds[0]["ic"]:.4f} -> {decline_folds[-1]["ic"]:.4f})'
            )

    result['overfit_folds'] = sorted(set(result['overfit_folds']))
    result['fold_details'] = fold_metrics

    return result if result['detected'] else None


def format_overfitting_alert(server_name, model_name, detection):
    """Format an overfitting detection into a Discord-friendly alert message."""
    lines = [
        f'OVERFITTING DETECTED on {server_name}',
        f'Model: {model_name or "unknown"}',
        f'Affected folds: {", ".join(str(f) for f in detection["overfit_folds"])}',
    ]
    for reason in detection['reasons']:
        lines.append(f'  - {reason}')

    short_msg = ' | '.join(lines[:3]) + ' | ' + '; '.join(detection['reasons'])
    return short_msg


# ── Duplicate Process Detection ──────────────────────────────────────────────

def detect_duplicates(procs, machine_name):
    """Detect multiple processes with identical command lines."""
    dupes = []
    if not procs:
        return dupes

    cmd_groups = {}
    for p in procs:
        cmd = p.get('cmd', '')
        sig = cmd.strip()
        if sig not in cmd_groups:
            cmd_groups[sig] = []
        cmd_groups[sig].append(p)

    for sig, group in cmd_groups.items():
        if len(group) > 1 and sig:
            pids = [str(p.get('pid', '?')) for p in group]
            dupes.append({
                'cmd': sig,
                'count': len(group),
                'pids': pids,
            })

    return dupes


# ── Process Death Detection ──────────────────────────────────────────────────

def detect_process_deaths(current_pids, last_pids, machine_name):
    """Compare current PIDs to last known PIDs, detect deaths."""
    deaths = []
    if not last_pids:
        return deaths

    current_set = set(str(p) for p in current_pids)
    for pid, cmd in last_pids.items():
        if str(pid) not in current_set:
            deaths.append({'pid': pid, 'cmd': cmd})

    return deaths


# ── Fetch Training Log ───────────────────────────────────────────────────────

def fetch_training_log(server_name, lines=100):
    """Fetch training log content from a server for fold metric parsing.

    Returns (log_text, model_name) tuple.
    """
    if server_name == 'Neptune':
        log_dirs = [
            Path('C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery/deep_models'),
            Path('C:/Users/Footb/Documents/Github/Lvl3Quant'),
        ]
        for log_dir in log_dirs:
            if not log_dir.exists():
                continue
            log_files = sorted(
                list(log_dir.glob('*.log')) + list(log_dir.glob('**/*training*.log')),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if log_files:
                try:
                    with open(log_files[0], 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                    all_lines = content.split('\n')
                    log_text = '\n'.join(all_lines[-lines:])
                    model_name = log_files[0].stem
                    model_match = re.search(
                        r'(?:model|training|walkforward)[_\s]*([\w]+)',
                        model_name, re.IGNORECASE
                    )
                    if model_match:
                        model_name = model_match.group(1)
                    return log_text, model_name
                except Exception:
                    pass
        return None, None

    # For remote servers, use their log_tail if already fetched
    meta = SERVER_META.get(server_name.lower(), {})
    if meta.get('os') == 'windows':
        # Windows remote — use PowerShell
        log_cmd = (
            'powershell -Command "'
            "Get-ChildItem -Path $env:USERPROFILE\\Documents -Recurse -Include *.log "
            "-ErrorAction SilentlyContinue | "
            "Where-Object { $_.Name -match 'walkforward|training|train_' } | "
            "Sort-Object LastWriteTime -Descending | "
            "Select-Object -First 1 -ExpandProperty FullName"
            '"'
        )
        log_path = ssh_run(server_name.lower(), log_cmd, timeout=20)
        if not log_path or not log_path.strip():
            return None, None

        log_path = log_path.strip()
        model_name = Path(log_path).stem
        model_match = re.search(
            r'(?:walkforward|training)[_\s]*([\w]+)',
            model_name, re.IGNORECASE
        )
        if model_match:
            model_name = model_match.group(1)

        tail_cmd = (
            f'powershell -Command "Get-Content -Path \'{log_path}\' -Tail {lines}"'
        )
        log_text = ssh_run(server_name.lower(), tail_cmd, timeout=20)
        return log_text, model_name

    else:
        # Linux remote
        log_cmd = (
            "ls -t ~/Lvl3Quant/walkforward_*.log ~/Lvl3Quant/*.log "
            "~/Lvl3Quant/alpha_discovery/deep_models/*.log 2>/dev/null | "
            "grep -v 'No such' | head -1"
        )
        log_path = ssh_run(server_name.lower(), log_cmd, timeout=15)
        if not log_path or log_path.strip() == 'none':
            return None, None

        log_path = log_path.strip()
        model_name = Path(log_path).stem
        model_match = re.search(
            r'(?:walkforward|training)[_\s]*([\w]+)',
            model_name, re.IGNORECASE
        )
        if model_match:
            model_name = model_match.group(1)

        tail_cmd = f"tail -{lines} '{log_path}' 2>/dev/null"
        log_text = ssh_run(server_name.lower(), tail_cmd, timeout=20)
        return log_text, model_name


# ── Per-Server Alert Logic ───────────────────────────────────────────────────

def attempt_restart_crashed_training(name, server_key, state, alerts):
    """Detect and restart crashed training processes.

    When GPU is idle but processes exist, kill stale processes and attempt restart via SSH.
    """
    try:
        _log(f"Attempting to detect and restart crashed training on {name}", 'INFO')

        # Infer the expected command from any remaining processes
        # (Look for python.exe with common training scripts)
        training_keywords = ['sweep', 'train', 'fit', 'cnn', 'lstm', 'pytorch']

        # Kill any stale processes
        if server_key == 'neptune':
            # Local Windows machine
            try:
                subprocess.run(['taskkill', '/F', '/IM', 'python.exe'], timeout=10)
                _log(f"Killed Python processes on {name}", 'INFO')
            except Exception:
                pass
        else:
            # Remote machine via SSH
            kill_cmd = 'pkill -9 python'
            result = ssh_run(server_key, kill_cmd, timeout=10)
            if result is not None:
                _log(f"Killed Python processes on {name} via SSH", 'INFO')

        emit_alert(alerts, 'INFO', name,
                   'Crashed training detected and cleaned. Awaiting manual restart or auto-recovery.',
                   state, cooldown_min=120)

    except Exception as e:
        _log(f"Error during crash recovery on {name}: {e}", 'ERROR')


def check_gpu_alerts(info, server_key, state, alerts, interval_sec):
    """Run all GPU-server alert checks. Works for Neptune, Uranus, Razer."""
    name = info['name']
    now = time.time()

    # --- GPU Temperature > 85C ---
    if info.get('gpu_temp_c') is not None and info['gpu_temp_c'] > 85:
        emit_alert(alerts, 'CRITICAL', name,
                   f'GPU temperature {info["gpu_temp_c"]}C exceeds 85C threshold!',
                   state, cooldown_min=15)

    # --- GPU Idle >10 min when processes running ---
    if info.get('gpu_pct') is not None:
        if info['gpu_pct'] < 10 and info.get('python_count', 0) > 0:
            # Track when GPU went idle
            idle_key = f'{server_key}_gpu_idle_since'
            if idle_key not in state.get('gpu_idle_since', {}):
                if 'gpu_idle_since' not in state:
                    state['gpu_idle_since'] = {}
                state['gpu_idle_since'][idle_key] = now
            else:
                idle_duration = now - state['gpu_idle_since'][idle_key]
                if idle_duration > 600:  # 10 minutes
                    emit_alert(alerts, 'WARNING', name,
                               f'GPU idle (<10%) for {idle_duration/60:.0f} min with '
                               f'{info["python_count"]} Python processes running',
                               state, cooldown_min=30)
        else:
            # GPU is active, reset idle tracker
            if 'gpu_idle_since' in state:
                idle_key = f'{server_key}_gpu_idle_since'
                state['gpu_idle_since'].pop(idle_key, None)

    # --- GPU at 0% with processes (instant alert) ---
    if (info.get('gpu_pct') is not None and info['gpu_pct'] == 0
            and info.get('python_count', 0) > 0):
        emit_alert(alerts, 'CRITICAL', name,
                   f'GPU at 0% but {info["python_count"]} Python processes running -- possible crash',
                   state, cooldown_min=15)
        # Attempt auto-restart for crashed training
        attempt_restart_crashed_training(name, server_key, state, alerts)

    # --- Stale checkpoint ---
    if (info.get('checkpoint_age_min') is not None and info['checkpoint_age_min'] > 120
            and info.get('gpu_pct') is not None and info['gpu_pct'] > 10):
        emit_alert(alerts, 'WARNING', name,
                   f'No new checkpoint in {info["checkpoint_age_min"]:.0f} min but GPU active at {info["gpu_pct"]}%',
                   state, cooldown_min=30)

    # --- Training log stalled >30 min ---
    if info.get('log_age_min') is not None and info['log_age_min'] > 30:
        if info.get('gpu_pct') is not None and info['gpu_pct'] > 10:
            stall_key = f'{server_key}_log_stall'
            if stall_key not in state.get('log_stall_since', {}):
                if 'log_stall_since' not in state:
                    state['log_stall_since'] = {}
                state['log_stall_since'][stall_key] = now
            stall_start = state.get('log_stall_since', {}).get(stall_key, now)
            stall_duration = now - stall_start
            if stall_duration > 1800:  # 30 min
                emit_alert(alerts, 'WARNING', name,
                           f'Training log unchanged for {info["log_age_min"]:.0f} min but GPU active at {info["gpu_pct"]}%',
                           state, cooldown_min=30)
    else:
        # Log is updating, reset stall tracker
        if 'log_stall_since' in state:
            state['log_stall_since'].pop(f'{server_key}_log_stall', None)

    # --- Duplicate process detection ---
    dupes = detect_duplicates(info.get('python_procs', []), name)
    for d in dupes:
        emit_alert(alerts, 'CRITICAL', name,
                   f'DUPLICATE: {d["count"]} identical processes: {d["cmd"][:80]} (PIDs: {", ".join(d["pids"][:5])})',
                   state, cooldown_min=60)

    # --- Process death detection ---
    last_pids = state.get('last_pids', {}).get(server_key, {})
    current_pids = [p['pid'] for p in info.get('python_procs', [])]
    deaths = detect_process_deaths(current_pids, last_pids, name)
    for d in deaths:
        emit_alert(alerts, 'CRITICAL', name,
                   f'Process died: PID {d["pid"]} ({d["cmd"][:80]})',
                   state, cooldown_min=10)

    # Save current PIDs
    if 'last_pids' not in state:
        state['last_pids'] = {}
    state['last_pids'][server_key] = {
        str(p['pid']): p.get('cmd', '') for p in info.get('python_procs', [])
    }

    # --- RAM > 90% ---
    if info.get('ram_used_gb') and info.get('ram_total_gb') and info['ram_total_gb'] > 0:
        ram_pct = (info['ram_used_gb'] / info['ram_total_gb']) * 100
        if ram_pct > 90:
            emit_alert(alerts, 'WARNING', name,
                       f'RAM at {ram_pct:.0f}% ({info["ram_used_gb"]}/{info["ram_total_gb"]} GB)',
                       state, cooldown_min=15)

    # --- Disk space < 10% ---
    if info.get('disk_free_pct') is not None and info['disk_free_pct'] < 10:
        emit_alert(alerts, 'CRITICAL', name,
                   f'Disk space critically low: {info["disk_free_pct"]:.1f}% free',
                   state, cooldown_min=60)

    # --- Overfitting detection ---
    try:
        if info.get('gpu_pct') is not None and info['gpu_pct'] > 10:
            log_text, model_name = fetch_training_log(name)
            if log_text:
                fold_metrics = parse_fold_metrics(log_text)
                if len(fold_metrics) >= 3:
                    detection = detect_overfitting(fold_metrics)
                    if detection:
                        overfit_key = f'{server_key}_overfit_consec'
                        if 'overfit_consec' not in state:
                            state['overfit_consec'] = {}
                        state['overfit_consec'][overfit_key] = state['overfit_consec'].get(overfit_key, 0) + 1
                        short_msg = format_overfitting_alert(name, model_name, detection)
                        emit_alert(alerts, 'WARNING', name, short_msg, state, cooldown_min=60)
                    else:
                        if 'overfit_consec' in state:
                            state['overfit_consec'][f'{server_key}_overfit_consec'] = 0

                # --- Training progress & fold tracking ---
                progress = parse_training_progress(log_text)

                # Track IC history
                if progress.get('latest_ic') is not None:
                    if 'ic_history' not in state:
                        state['ic_history'] = {}
                    if server_key not in state['ic_history']:
                        state['ic_history'][server_key] = []
                    state['ic_history'][server_key].append({
                        'ic': progress['latest_ic'],
                        'fold': progress.get('current_fold'),
                        'ts': datetime.now().isoformat(),
                    })
                    # Keep last 100 entries
                    state['ic_history'][server_key] = state['ic_history'][server_key][-100:]

                # Track fold progress for job completion detection
                if progress.get('current_fold') is not None:
                    last_fold = state.get('last_fold_seen', {}).get(server_key)
                    state.setdefault('last_fold_seen', {})[server_key] = progress['current_fold']

                    # Check for job completion
                    if progress.get('total_folds') is not None:
                        if progress['current_fold'] >= progress['total_folds']:
                            emit_alert(alerts, 'INFO', name,
                                       f'Job COMPLETED: Fold {progress["current_fold"]}/{progress["total_folds"]} '
                                       f'(IC={progress.get("latest_ic", "N/A")})',
                                       state, cooldown_min=120)

                # Report training errors
                if progress.get('errors'):
                    for err in progress['errors'][:3]:  # Max 3 error alerts
                        emit_alert(alerts, 'CRITICAL', name,
                                   f'Training error: {err[:100]}',
                                   state, cooldown_min=30)
    except Exception as e:
        _log(f"Overfitting/progress check error for {name}: {e}", 'ERROR')


def check_cpu_alerts(info, server_key, state, alerts, interval_sec):
    """Run all CPU-server alert checks. Works for Jupiter, Saturn."""
    name = info['name']

    # --- SSH connectivity ---
    if not info.get('reachable'):
        state['ssh_failures'][server_key] = state.get('ssh_failures', {}).get(server_key, 0) + 1
        if state['ssh_failures'][server_key] >= 3:
            severity = 'CRITICAL' if state['ssh_failures'][server_key] >= 6 else 'WARNING'
            emit_alert(alerts, severity, name,
                       f'SSH unreachable for {state["ssh_failures"][server_key]} consecutive checks',
                       state, cooldown_min=30)
        return

    # Reset SSH failure counter
    state['ssh_failures'][server_key] = 0

    # --- Stalled sweep detection ---
    last_count = state.get('last_result_counts', {}).get(server_key, 0)
    if last_count > 0 and info['result_file_count'] == last_count:
        if info.get('fill_sim_count', 0) > 0 or info.get('python_count', 0) > 0:
            stall_key = f'{server_key}_stall'
            state.setdefault('stall_cycles', {})[stall_key] = state.get('stall_cycles', {}).get(stall_key, 0) + 1
            cycles = state['stall_cycles'][stall_key]
            stall_min = cycles * (interval_sec // 60)
            if cycles >= 3:  # 3 cycles = 15 min at 5-min intervals
                emit_alert(alerts, 'WARNING', name,
                           f'Result count stuck at {info["result_file_count"]} for ~{stall_min} min '
                           f'with {info.get("fill_sim_count", 0)} fill_sim + {info.get("python_count", 0)} python running',
                           state, cooldown_min=30)
        else:
            state.setdefault('stall_cycles', {})[f'{server_key}_stall'] = 0
    else:
        state.setdefault('stall_cycles', {})[f'{server_key}_stall'] = 0

    state.setdefault('last_result_counts', {})[server_key] = info.get('result_file_count', 0)

    # --- RAM > 90% ---
    if info.get('ram_used_gb') and info.get('ram_total_gb') and info['ram_total_gb'] > 0:
        ram_pct = (info['ram_used_gb'] / info['ram_total_gb']) * 100
        if ram_pct > 90:
            emit_alert(alerts, 'WARNING', name,
                       f'RAM at {ram_pct:.0f}% ({info["ram_used_gb"]}/{info["ram_total_gb"]} GB)',
                       state, cooldown_min=15)

    # --- Disk space < 10% ---
    if info.get('disk_free_pct') is not None and info['disk_free_pct'] < 10:
        emit_alert(alerts, 'CRITICAL', name,
                   f'Disk space critically low: {info["disk_free_pct"]:.1f}% free',
                   state, cooldown_min=60)

    # --- Process death detection ---
    last_pids = state.get('last_pids', {}).get(server_key, {})
    current_pids = [p['pid'] for p in info.get('python_procs', [])]
    deaths = detect_process_deaths(current_pids, last_pids, name)
    for d in deaths:
        emit_alert(alerts, 'WARNING', name,
                   f'Process died: PID {d["pid"]} ({d["cmd"][:80]})',
                   state, cooldown_min=10)

    if 'last_pids' not in state:
        state['last_pids'] = {}
    state['last_pids'][server_key] = {
        str(p['pid']): p.get('cmd', '') for p in info.get('python_procs', [])
    }


# ── Dashboard Status Writer ──────────────────────────────────────────────────

def _infer_task(procs, gpu_pct=None, fill_sim_count=0):
    """Infer current task from process list."""
    if not procs and not fill_sim_count:
        return "Idle"
    tasks = []
    for p in procs:
        cmd = p.get('cmd', p.get('mem_mb', ''))
        cmd_str = str(cmd).lower()
        if 'train' in cmd_str or 'walkforward' in cmd_str:
            tasks.append('Training')
        elif 'sweep' in cmd_str:
            tasks.append('Sweep')
        elif 'fill_sim' in cmd_str:
            tasks.append('Fill Sim')
        elif 'inference' in cmd_str or 'predict' in cmd_str:
            tasks.append('Inference')
    if fill_sim_count > 0:
        tasks.append(f'Fill Sim ({fill_sim_count} workers)')
    if not tasks:
        if gpu_pct is not None and gpu_pct > 50:
            return "GPU Active (unknown task)"
        count = len(procs) if procs else fill_sim_count
        return f"{count} processes running" if count else "Idle"
    return ', '.join(sorted(set(tasks)))


def _proc_list(procs, max_items=8):
    """Convert process info list to dashboard-friendly format."""
    out = []
    for p in procs[:max_items]:
        entry = {}
        if 'pid' in p:
            entry['pid'] = p['pid']
        if 'cmd' in p:
            entry['cmd'] = p['cmd'][:100]
        if 'mem_mb' in p:
            entry['mem_mb'] = p['mem_mb']
        if 'mem_pct' in p:
            entry['mem_pct'] = p['mem_pct']
        out.append(entry)
    return out


def write_dashboard_status(all_nodes):
    """Write dashboard-friendly JSON for the quant dashboard Compute tab."""
    try:
        nodes_out = {}
        for key, info in all_nodes.items():
            meta = SERVER_META.get(key, {})
            node = {
                'name': meta.get('display_name', info.get('name', key)),
                'description': meta.get('description', ''),
                'ip': meta.get('ip', ''),
                'reachable': info.get('reachable', False),
                'gpu_pct': info.get('gpu_pct'),
                'gpu_temp_c': info.get('gpu_temp_c'),
                'gpu_power_w': info.get('gpu_power_w'),
                'vram_used_gb': info.get('vram_used_gb'),
                'vram_total_gb': info.get('vram_total_gb'),
                'cpu_pct': info.get('cpu_pct', info.get('load_avg')),
                'ram_used_gb': info.get('ram_used_gb'),
                'ram_total_gb': info.get('ram_total_gb'),
                'disk_free_pct': info.get('disk_free_pct'),
                'current_task': _infer_task(
                    info.get('python_procs', []),
                    info.get('gpu_pct'),
                    info.get('fill_sim_count', 0),
                ),
                'active_processes': _proc_list(info.get('python_procs', [])),
                'python_count': info.get('python_count', 0),
                'checkpoint_age_min': info.get('checkpoint_age_min'),
                'log_age_min': info.get('log_age_min'),
                'log_tail': info.get('log_tail'),
            }
            # CPU machine extras
            if 'fill_sim_count' in info:
                node['fill_sim_count'] = info['fill_sim_count']
            if 'result_file_count' in info:
                node['result_file_count'] = info['result_file_count']
            if 'load_avg' in info:
                node['load_avg'] = info['load_avg']

            nodes_out[key] = node

        status = {
            'last_updated': datetime.now().isoformat(),
            'nodes': nodes_out,
        }

        DASHBOARD_STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(DASHBOARD_STATUS_FILE, 'w') as f:
            json.dump(status, f, indent=2)

    except Exception as e:
        _log(f"Dashboard write error: {e}", 'ERROR')


# ── Hourly Summary Report ───────────────────────────────────────────────────

def generate_hourly_report(all_nodes, state):
    """Generate an hourly summary report for Discord #system-status."""
    now = time.time()
    last_report = state.get('hourly_report_ts', 0)

    # Only generate once per hour
    if now - last_report < 3600:
        return None

    state['hourly_report_ts'] = now

    lines = [
        f"**Compute Status Report** -- {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
    ]

    for key, info in all_nodes.items():
        meta = SERVER_META.get(key, {})
        name = meta.get('display_name', key)
        gpu_model = meta.get('gpu_model', '')

        if not info.get('reachable', False) and not meta.get('is_local', False):
            lines.append(f"**{name}** ({gpu_model or 'CPU'}): UNREACHABLE")
            continue

        parts = [f"**{name}** ({gpu_model or 'CPU'})"]

        # GPU info
        if info.get('gpu_pct') is not None:
            gpu_str = f"GPU: {info['gpu_pct']}%"
            if info.get('gpu_temp_c') is not None:
                gpu_str += f" @ {info['gpu_temp_c']}C"
            if info.get('gpu_power_w') is not None:
                gpu_str += f" / {info['gpu_power_w']}W"
            parts.append(gpu_str)

        if info.get('vram_used_gb') is not None and info.get('vram_total_gb') is not None:
            parts.append(f"VRAM: {info['vram_used_gb']}/{info['vram_total_gb']} GB")

        # RAM
        if info.get('ram_used_gb') is not None and info.get('ram_total_gb') is not None:
            ram_pct = round((info['ram_used_gb'] / info['ram_total_gb']) * 100) if info['ram_total_gb'] > 0 else 0
            parts.append(f"RAM: {info['ram_used_gb']}/{info['ram_total_gb']} GB ({ram_pct}%)")

        # Disk
        if info.get('disk_free_pct') is not None:
            parts.append(f"Disk: {info['disk_free_pct']:.0f}% free")

        # Processes
        py_count = info.get('python_count', 0)
        fs_count = info.get('fill_sim_count', 0)
        if py_count > 0 or fs_count > 0:
            proc_str = f"Procs: {py_count} Python"
            if fs_count > 0:
                proc_str += f", {fs_count} fill_sim"
            parts.append(proc_str)

        # Results (CPU machines)
        if 'result_file_count' in info and info['result_file_count'] > 0:
            parts.append(f"Results: {info['result_file_count']:,}")

        # Task inference
        task = _infer_task(
            info.get('python_procs', []),
            info.get('gpu_pct'),
            info.get('fill_sim_count', 0),
        )
        parts.append(f"Task: {task}")

        lines.append(" | ".join(parts))

    # IC trend summary
    ic_history = state.get('ic_history', {})
    if ic_history:
        lines.append("")
        lines.append("**IC Trends:**")
        for server_key, entries in ic_history.items():
            if entries and len(entries) >= 2:
                recent = entries[-5:]
                ics = [e['ic'] for e in recent if e.get('ic') is not None]
                if ics:
                    trend = "up" if ics[-1] > ics[0] else "down" if ics[-1] < ics[0] else "flat"
                    name = SERVER_META.get(server_key, {}).get('display_name', server_key)
                    lines.append(f"  {name}: {ics[-1]:.4f} (trend: {trend}, n={len(ics)})")

    report_text = '\n'.join(lines)

    # Write hourly report to file for Discord pickup
    try:
        report = {
            'timestamp': datetime.now().isoformat(),
            'severity': 'INFO',
            'machine': 'ALL',
            'message': report_text,
            'type': 'hourly_report',
        }
        HOURLY_REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(HOURLY_REPORT_FILE, 'w') as f:
            json.dump(report, f, indent=2)
    except Exception as e:
        _log(f"Failed to write hourly report: {e}", 'ERROR')

    # Also emit as an INFO alert for the orchestrator
    return report_text


# ── Main Check Logic ─────────────────────────────────────────────────────────

def run_check(state, interval_sec=300):
    """Run a single check cycle across all 5 machines."""
    now = datetime.now()
    ts = now.strftime('%Y-%m-%d %H:%M:%S')
    alerts = []
    status_parts = [ts]

    all_nodes = {}

    # ── Neptune (local) ────────────────────────────────────────────────
    neptune = check_neptune()
    all_nodes['neptune'] = neptune

    gpu_str = f"GPU:{neptune['gpu_pct']}%" if neptune['gpu_pct'] is not None else "GPU:N/A"
    vram_str = f"VRAM:{neptune['vram_used_gb']}GB" if neptune['vram_used_gb'] is not None else "VRAM:N/A"
    temp_str = f"{neptune['gpu_temp_c']}C" if neptune.get('gpu_temp_c') is not None else ""
    disk_str = f"Disk:{neptune['disk_free_pct']:.0f}%" if neptune.get('disk_free_pct') is not None else ""
    status_parts.append(f"Neptune {gpu_str} {temp_str} {vram_str} Py:{neptune['python_count']} {disk_str}")

    check_gpu_alerts(neptune, 'neptune', state, alerts, interval_sec)

    # ── Uranus (remote Windows GPU) ──────────────────────────────────
    uranus = check_windows_gpu_machine('uranus', 'Uranus')
    all_nodes['uranus'] = uranus

    if uranus['reachable']:
        gpu_str = f"GPU:{uranus['gpu_pct']}%" if uranus['gpu_pct'] is not None else "GPU:N/A"
        vram_str = f"VRAM:{uranus['vram_used_gb']}GB" if uranus['vram_used_gb'] is not None else "VRAM:N/A"
        temp_str = f"{uranus['gpu_temp_c']}C" if uranus.get('gpu_temp_c') is not None else ""
        disk_str = f"Disk:{uranus['disk_free_pct']:.0f}%" if uranus.get('disk_free_pct') is not None else ""
        status_parts.append(f"Uranus {gpu_str} {temp_str} {vram_str} Py:{uranus['python_count']} {disk_str}")
        state['ssh_failures']['uranus'] = 0
        check_gpu_alerts(uranus, 'uranus', state, alerts, interval_sec)
    else:
        status_parts.append("Uranus UNREACHABLE")
        state['ssh_failures']['uranus'] = state.get('ssh_failures', {}).get('uranus', 0) + 1
        if state['ssh_failures']['uranus'] >= 3:
            emit_alert(alerts, 'CRITICAL', 'Uranus',
                       f'SSH unreachable for {state["ssh_failures"]["uranus"]} consecutive checks',
                       state, cooldown_min=30)

    # ── Razer (remote Windows GPU) ───────────────────────────────────
    razer = check_windows_gpu_machine('razer', 'Razer')
    all_nodes['razer'] = razer

    if razer['reachable']:
        gpu_str = f"GPU:{razer['gpu_pct']}%" if razer['gpu_pct'] is not None else "GPU:N/A"
        vram_str = f"VRAM:{razer['vram_used_gb']}GB" if razer['vram_used_gb'] is not None else "VRAM:N/A"
        temp_str = f"{razer['gpu_temp_c']}C" if razer.get('gpu_temp_c') is not None else ""
        disk_str = f"Disk:{razer['disk_free_pct']:.0f}%" if razer.get('disk_free_pct') is not None else ""
        status_parts.append(f"Razer {gpu_str} {temp_str} {vram_str} Py:{razer['python_count']} {disk_str}")
        state['ssh_failures']['razer'] = 0
        check_gpu_alerts(razer, 'razer', state, alerts, interval_sec)
    else:
        status_parts.append("Razer UNREACHABLE")
        state['ssh_failures']['razer'] = state.get('ssh_failures', {}).get('razer', 0) + 1
        if state['ssh_failures']['razer'] >= 3:
            emit_alert(alerts, 'WARNING', 'Razer',
                       f'SSH unreachable for {state["ssh_failures"]["razer"]} consecutive checks',
                       state, cooldown_min=60)

    # ── Jupiter (remote Linux CPU) ───────────────────────────────────
    jupiter = check_cpu_machine('jupiter', 'Jupiter')
    all_nodes['jupiter'] = jupiter

    if jupiter['reachable']:
        load_str = f"Load:{jupiter['load_avg']:.1f}" if jupiter['load_avg'] is not None else "Load:N/A"
        ram_str = ""
        if jupiter.get('ram_used_gb') and jupiter.get('ram_total_gb'):
            ram_str = f"RAM:{jupiter['ram_used_gb']}/{jupiter['ram_total_gb']}GB"
        disk_str = f"Disk:{jupiter['disk_free_pct']:.0f}%" if jupiter.get('disk_free_pct') is not None else ""
        status_parts.append(
            f"Jupiter {load_str} {ram_str} FillSim:{jupiter['fill_sim_count']} "
            f"Results:{jupiter['result_file_count']} {disk_str}"
        )
        check_cpu_alerts(jupiter, 'jupiter', state, alerts, interval_sec)
    else:
        status_parts.append("Jupiter UNREACHABLE")
        check_cpu_alerts(jupiter, 'jupiter', state, alerts, interval_sec)

    # ── Saturn (via Jupiter, remote Linux CPU) ───────────────────────
    saturn = check_cpu_machine('saturn', 'Saturn')
    all_nodes['saturn'] = saturn

    if saturn['reachable']:
        load_str = f"Load:{saturn['load_avg']:.1f}" if saturn['load_avg'] is not None else "Load:N/A"
        ram_str = ""
        if saturn.get('ram_used_gb') and saturn.get('ram_total_gb'):
            ram_str = f"RAM:{saturn['ram_used_gb']}/{saturn['ram_total_gb']}GB"
        disk_str = f"Disk:{saturn['disk_free_pct']:.0f}%" if saturn.get('disk_free_pct') is not None else ""
        status_parts.append(
            f"Saturn {load_str} {ram_str} FillSim:{saturn['fill_sim_count']} "
            f"Results:{saturn['result_file_count']} {disk_str}"
        )
        check_cpu_alerts(saturn, 'saturn', state, alerts, interval_sec)
    else:
        status_parts.append("Saturn UNREACHABLE")
        check_cpu_alerts(saturn, 'saturn', state, alerts, interval_sec)

    # ── Write dashboard status JSON ──────────────────────────────────
    write_dashboard_status(all_nodes)

    # ── Hourly summary report ────────────────────────────────────────
    hourly_report = generate_hourly_report(all_nodes, state)
    if hourly_report:
        emit_alert(alerts, 'INFO', 'ALL',
                   f'Hourly compute report generated ({len(all_nodes)} nodes checked)',
                   state, cooldown_min=55)

    # ── Write log line ───────────────────────────────────────────────
    log_line = ' | '.join(status_parts)
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(log_line + '\n')
        for alert in alerts:
            f.write(f"{ts} | ALERT [{alert['severity']}]: {alert['machine']} -- {alert['message']}\n")

    # ── Write alerts file ────────────────────────────────────────────
    if alerts:
        write_alerts(alerts)

    # ── Update state ─────────────────────────────────────────────────
    state['check_count'] = state.get('check_count', 0) + 1

    # Prune old alert history (keep last 7 days)
    cutoff = time.time() - 7 * 86400
    if 'alert_history' in state:
        state['alert_history'] = {
            k: v for k, v in state['alert_history'].items() if v > cutoff
        }

    return log_line, alerts


# ── Main Loop ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Persistent compute health monitor for all 5 nodes')
    parser.add_argument('--interval', type=int, default=DEFAULT_INTERVAL,
                        help=f'Check interval in seconds (default: {DEFAULT_INTERVAL})')
    parser.add_argument('--once', action='store_true', help='Run once and exit')
    args = parser.parse_args()

    state = load_state()

    # Startup banner
    start_msg = (
        f"[compute_monitor] Started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"[compute_monitor] Monitoring: Neptune, Uranus, Razer, Jupiter, Saturn\n"
        f"[compute_monitor] Interval: {args.interval}s | Log: {LOG_FILE}\n"
        f"[compute_monitor] State: {STATE_FILE} | Alerts: {ALERTS_FILE}\n"
        f"[compute_monitor] Dashboard: {DASHBOARD_STATUS_FILE}\n"
        f"[compute_monitor] Checks so far: {state.get('check_count', 0)}"
    )
    print(start_msg)
    sys.stdout.flush()

    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(f"\n{'='*80}\n")
        f.write(f"Monitor started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} "
                f"interval={args.interval}s nodes=5\n")
        f.write(f"{'='*80}\n")

    while True:
        try:
            log_line, alerts = run_check(state, interval_sec=args.interval)
            save_state(state)
            update_heartbeat()

            # Print summary to stdout
            print(log_line)
            for a in alerts:
                print(f"  ** ALERT [{a['severity']}] {a['machine']}: {a['message']}")
            sys.stdout.flush()

        except KeyboardInterrupt:
            # User interrupted
            _log("Monitor stopped by user", 'INFO')
            print("[compute_monitor] Stopped by user")
            break

        except Exception as e:
            # Log error but keep running - don't crash
            err_msg = f"[compute_monitor] CHECK ERROR: {e}\n{traceback.format_exc()}"
            print(err_msg, file=sys.stderr)
            sys.stderr.flush()
            _log(f"MONITOR CHECK ERROR: {e}\n{traceback.format_exc()}", 'ERROR')

            # Send error alert via webhook if configured
            webhook_url = get_webhook_url()
            if webhook_url:
                send_discord_webhook(
                    webhook_url,
                    f"Compute monitor encountered an error and is recovering:\n```{str(e)[:200]}```",
                    'WARNING'
                )

            # Update heartbeat even on error to show we're still alive
            update_heartbeat()

            # Wait a bit before retrying
            time.sleep(min(args.interval, 30))
            continue

        if args.once:
            break

        time.sleep(args.interval)


if __name__ == '__main__':
    main()
