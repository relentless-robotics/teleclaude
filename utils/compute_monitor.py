"""
compute_monitor.py — Unified compute monitor for PC + Server.

Periodically checks training logs and server jobs, sends Discord updates
when progress changes (new folds, new epochs, jobs complete).

Usage:
    python utils/compute_monitor.py --interval 90

Runs as a lightweight background process. Minimal CPU/RAM usage.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# Paths
TELECLAUDE = Path(__file__).resolve().parent.parent
LVL3QUANT = Path('C:/Users/YOUR_USERNAME/Documents/Github/Lvl3Quant')
DL_RESULTS = LVL3QUANT / 'alpha_discovery' / 'deep_models' / 'results'
MFE_RESULTS = LVL3QUANT / 'alpha_discovery' / 'results'

# Add parent to path for imports
sys.path.insert(0, str(TELECLAUDE))


def ssh_exec_quiet(command, timeout=15):
    """Run command on server, return stdout or None on failure."""
    try:
        from utils.ssh_exec import connect_jupiter
        result = connect_jupiter(command, prefer='both', timeout=timeout)
        if result['success']:
            return result['stdout']
    except Exception:
        pass
    return None


def parse_dl_log(log_path):
    """Parse a walkforward training log file."""
    if not os.path.exists(log_path):
        return None
    with open(log_path) as f:
        lines = f.readlines()

    info = {'folds': [], 'current_fold': None, 'model': 'unknown', 'total_folds': 0}
    current_fold = None

    for line in lines:
        line = line.strip()

        m = re.search(r'Walk-Forward Training: (\w+)', line)
        if m:
            info['model'] = m.group(1)

        m = re.search(r'Total folds: (\d+)', line)
        if m:
            info['total_folds'] = int(m.group(1))

        m = re.search(r'Fold (\d+)/(\d+) \|.*Test: (\S+)', line)
        if m:
            current_fold = {'num': int(m.group(1)), 'test_date': m.group(3), 'epochs': []}

        m = re.search(r'Target normalization: mean=([\d.-]+) std=([\d.-]+)', line)
        if m and current_fold:
            current_fold['tgt_std'] = float(m.group(2))

        # Handle both old (loss=) and new (train_loss=, val_loss=) formats
        m = re.search(r'Epoch (\d+)/(\d+): train_loss=([\d.]+)\s+val_loss=([\d.]+)\s+IC=([+-]?[\d.]+)', line)
        if m and current_fold:
            current_fold['epochs'].append({
                'epoch': int(m.group(1)),
                'train_loss': float(m.group(3)),
                'val_loss': float(m.group(4)),
                'ic': float(m.group(5)),
            })
        else:
            m = re.search(r'Epoch (\d+)/(\d+): loss=([\d.]+)\s+IC=([+-]?[\d.]+)', line)
            if m and current_fold:
                current_fold['epochs'].append({
                    'epoch': int(m.group(1)),
                    'train_loss': float(m.group(3)),
                    'val_loss': None,
                    'ic': float(m.group(4)),
                })

        m = re.search(r'Fold IC: ([+-]?[\d.]+)', line)
        if m and current_fold:
            current_fold['fold_ic'] = float(m.group(1))
            info['folds'].append(current_fold)
            current_fold = None

    if current_fold and current_fold.get('epochs'):
        info['current_fold'] = current_fold

    return info


def parse_mfe_log_tail(log_path, n_lines=10):
    """Get the last N lines from an MFE log file."""
    if not os.path.exists(log_path):
        return None
    with open(log_path) as f:
        lines = f.readlines()
    return {
        'total_lines': len(lines),
        'tail': [l.strip() for l in lines[-n_lines:]],
    }


def format_dl_update(info):
    """Format a DL training update for Discord."""
    if not info:
        return None

    lines = []
    model = info['model']
    n_done = len(info['folds'])
    n_total = info['total_folds']

    lines.append(f"**{model} Training**: {n_done}/{n_total} folds")

    if n_done > 0:
        ics = [f['fold_ic'] for f in info['folds']]
        avg_ic = sum(ics) / len(ics)
        last = info['folds'][-1]
        lines.append(f"Avg IC: {avg_ic:+.4f} | Last fold IC: {last['fold_ic']:+.4f}")

        if last.get('epochs'):
            ep = last['epochs'][-1]
            tl = ep['train_loss']
            vl = ep.get('val_loss')
            if vl is not None:
                lines.append(f"Last fold final: train={tl:.5f} val={vl:.5f} IC={ep['ic']:+.4f}")
            else:
                lines.append(f"Last fold final: loss={tl:.5f} IC={ep['ic']:+.4f}")

    if info['current_fold']:
        cf = info['current_fold']
        n_ep = len(cf['epochs'])
        lines.append(f"In progress: fold {cf['num']}, epoch {n_ep}")
        if cf['epochs']:
            ep = cf['epochs'][-1]
            tl = ep['train_loss']
            vl = ep.get('val_loss')
            if vl is not None:
                lines.append(f"  Current: train={tl:.5f} val={vl:.5f} IC={ep['ic']:+.4f}")
                if tl < vl * 0.85:
                    lines.append("  ⚠️ val_loss >> train_loss — possible overfitting")
            else:
                lines.append(f"  Current: loss={tl:.5f} IC={ep['ic']:+.4f}")

    return '\n'.join(lines)


def find_latest_dl_log():
    """Find the most recent walkforward log."""
    pattern = str(DL_RESULTS / 'walkforward_*.log')
    logs = glob.glob(pattern)
    return max(logs, key=os.path.getmtime) if logs else None


def find_latest_mfe_log():
    """Find the most recent MFE OOS log."""
    pattern = str(MFE_RESULTS / 'mfe_oos*.log')
    logs = glob.glob(pattern)
    return max(logs, key=os.path.getmtime) if logs else None


def check_server_jobs():
    """Check server tmux sessions and running jobs."""
    out = ssh_exec_quiet(
        "tmux list-sessions 2>/dev/null; echo '---PROCS---'; "
        "ps aux --sort=-%cpu | grep python | grep -v grep | head -5; "
        "echo '---MEM---'; free -h | grep Mem; "
        "echo '---LOG---'; tail -3 ~/lvl3quant/results/mfe_oos_100d.log 2>/dev/null || echo 'no log'"
    )
    return out


class MonitorState:
    """Track what we've already reported to avoid duplicate messages."""

    def __init__(self):
        self.last_dl_folds = -1
        self.last_dl_epochs = -1
        self.last_mfe_lines = -1
        self.last_server_lines = -1
        self.last_report_time = 0

    def should_report_dl(self, info):
        if not info:
            return False
        n_folds = len(info['folds'])
        n_epochs = len(info['current_fold']['epochs']) if info['current_fold'] else 0
        changed = (n_folds != self.last_dl_folds or n_epochs != self.last_dl_epochs)
        if changed:
            self.last_dl_folds = n_folds
            self.last_dl_epochs = n_epochs
        return changed

    def should_report_mfe(self, mfe_info):
        if not mfe_info:
            return False
        changed = mfe_info['total_lines'] != self.last_mfe_lines
        if changed:
            self.last_mfe_lines = mfe_info['total_lines']
        return changed


def send_discord_msg(msg):
    """Try to print the message (the main Claude process picks it up)."""
    print(f"\n{'='*60}")
    print(f"[MONITOR {datetime.now().strftime('%H:%M:%S')}]")
    print(msg)
    print('='*60)
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description='Unified compute monitor')
    parser.add_argument('--interval', type=int, default=90, help='Check interval in seconds')
    parser.add_argument('--once', action='store_true', help='Run once and exit')
    args = parser.parse_args()

    state = MonitorState()
    print(f"[monitor] Started. Checking every {args.interval}s")
    print(f"[monitor] DL results: {DL_RESULTS}")
    print(f"[monitor] MFE results: {MFE_RESULTS}")

    while True:
        reports = []
        ts = datetime.now().strftime('%H:%M:%S')

        # 1. Check PC DL training
        dl_log = find_latest_dl_log()
        if dl_log:
            dl_info = parse_dl_log(dl_log)
            if state.should_report_dl(dl_info):
                update = format_dl_update(dl_info)
                if update:
                    reports.append(f"**[PC GPU]** {update}")

        # 2. Check PC MFE sweep
        mfe_log = find_latest_mfe_log()
        if mfe_log:
            mfe_info = parse_mfe_log_tail(mfe_log)
            if state.should_report_mfe(mfe_info):
                last_line = mfe_info['tail'][-1] if mfe_info['tail'] else 'empty'
                reports.append(f"**[PC CPU]** MFE sweep: {mfe_info['total_lines']} lines. Latest: `{last_line}`")

        # 3. Check server
        server_out = check_server_jobs()
        if server_out:
            # Extract key info
            server_lines = server_out.strip().split('\n')
            reports.append(f"**[Server]** {len(server_lines)} lines of status")
            for line in server_lines:
                if 'mfe_path' in line or 'LightGBM' in line or 'IC=' in line or 'Fold' in line:
                    reports.append(f"  `{line.strip()}`")

        if reports:
            send_discord_msg('\n'.join(reports))
        else:
            print(f"[{ts}] No changes detected.")

        if args.once:
            break

        time.sleep(args.interval)


if __name__ == '__main__':
    main()
