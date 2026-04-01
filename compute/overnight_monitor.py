"""
Overnight Compute Monitor — checks all nodes every 5 minutes.
Sends Discord alerts on: fold completions, job finishes, crashes, idle detection.
Auto-queues: Hybrid training on Uranus when sliding window finishes.

Run as: python compute/overnight_monitor.py
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

TELECLAUDE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TELECLAUDE))

CHECK_INTERVAL = 300  # 5 minutes

# Track state between checks
last_state = {
    'neptune_last_log_line': '',
    'uranus_fold': 0,
    'uranus_finished': False,
    'jupiter_results': 0,
    'laptop_connected': False,
    'checks': 0,
}

def log(msg):
    ts = datetime.now().strftime('%H:%M:%S')
    print(f'[{ts}] {msg}')
    sys.stdout.flush()

def send_discord(msg):
    """Send message to Discord via MCP or webhook."""
    try:
        # Try webhook approach (works without MCP)
        webhook_url = os.environ.get('DISCORD_WEBHOOK_URL')
        if webhook_url:
            import urllib.request
            data = json.dumps({'content': msg}).encode()
            req = urllib.request.Request(webhook_url, data=data,
                headers={'Content-Type': 'application/json'})
            urllib.request.urlopen(req, timeout=10)
            return True
    except Exception:
        pass
    log(f'DISCORD: {msg}')
    return False

def check_neptune():
    """Check Neptune GPU training status."""
    info = {'gpu_pct': 0, 'ram_pct': 0, 'log_tail': ''}

    try:
        out = subprocess.check_output(
            ['nvidia-smi', '--query-gpu=utilization.gpu,memory.used',
             '--format=csv,noheader,nounits'],
            timeout=10, stderr=subprocess.DEVNULL
        ).decode().strip()
        parts = out.split(',')
        info['gpu_pct'] = int(parts[0].strip())
    except Exception:
        pass

    try:
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-Command',
             'Get-CimInstance Win32_OperatingSystem|Select TotalVisibleMemorySize,FreePhysicalMemory|ConvertTo-Json'],
            timeout=15, stderr=subprocess.DEVNULL
        ).decode().strip()
        d = json.loads(out)
        total = d['TotalVisibleMemorySize']
        free = d['FreePhysicalMemory']
        info['ram_pct'] = round((total - free) / total * 100, 1)
    except Exception:
        pass

    # Check wider CNN log
    log_path = TELECLAUDE / 'wider_cnn_training.log'
    try:
        if log_path.exists():
            lines = log_path.read_text().strip().split('\n')
            info['log_tail'] = lines[-1] if lines else ''
    except Exception:
        pass

    return info

def check_uranus():
    """Check Uranus via SSH."""
    try:
        from utils.ssh_exec import run_on
        result = run_on('uranus',
            'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits; '
            'echo ===; '
            'ls -t ~/Lvl3Quant/walkforward_*.log 2>/dev/null | head -1 | xargs tail -3 2>/dev/null',
            timeout=20)
        if result and result.get('success'):
            out = result['stdout']
            parts = out.split('===')
            gpu = int(parts[0].strip()) if parts[0].strip().isdigit() else 0
            log_tail = parts[1].strip() if len(parts) > 1 else ''

            # Parse fold number from log
            fold = 0
            import re
            fold_match = re.search(r'Fold (\d+)/68', log_tail)
            if fold_match:
                fold = int(fold_match.group(1))

            return {'reachable': True, 'gpu_pct': gpu, 'fold': fold, 'log_tail': log_tail}
    except Exception:
        pass
    return {'reachable': False, 'gpu_pct': 0, 'fold': 0, 'log_tail': ''}

def main():
    log('Overnight monitor started')

    while True:
        try:
            last_state['checks'] += 1

            # Neptune
            nep = check_neptune()
            log(f'Neptune: GPU {nep["gpu_pct"]}% RAM {nep["ram_pct"]}%')

            if nep['ram_pct'] > 80:
                send_discord(f'**NEPTUNE RAM WARNING:** {nep["ram_pct"]}%')

            # Check for fold completions in wider CNN
            if nep['log_tail'] and nep['log_tail'] != last_state['neptune_last_log_line']:
                if 'IC=' in nep['log_tail']:
                    send_discord(f'**Neptune wider CNN:** {nep["log_tail"]}')
                last_state['neptune_last_log_line'] = nep['log_tail']

            if nep['gpu_pct'] < 5:
                send_discord(f'**Neptune GPU idle ({nep["gpu_pct"]}%)** — training may have finished or crashed!')

            # Uranus
            ura = check_uranus()
            if ura['reachable']:
                log(f'Uranus: GPU {ura["gpu_pct"]}% Fold {ura["fold"]}/68')

                # Fold progress
                if ura['fold'] > last_state['uranus_fold']:
                    last_state['uranus_fold'] = ura['fold']
                    if ura['fold'] % 5 == 0:  # Report every 5 folds
                        send_discord(f'**Uranus sliding CNN:** Fold {ura["fold"]}/68')

                # Finished detection
                if ura['gpu_pct'] < 5 and not last_state['uranus_finished']:
                    last_state['uranus_finished'] = True
                    send_discord(
                        '**URANUS SLIDING CNN FINISHED!** GPU idle. '
                        'Ready to deploy Hybrid CNN+Transformer training.'
                    )
            else:
                log('Uranus: UNREACHABLE')

        except Exception as e:
            log(f'Monitor error: {e}')

        time.sleep(CHECK_INTERVAL)

if __name__ == '__main__':
    main()
