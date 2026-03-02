"""Collect signal sweep results from Saturn server (two-hop via Jupiter)."""
import paramiko
import json
import sys

def main():
    jump = paramiko.SSHClient()
    jump.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        jump.connect('YOUR_JUPITER_LAN_IP', username='jupiter', password='YOUR_SERVER_PASSWORD', timeout=10)
        transport = jump.get_transport()
        channel = transport.open_channel('direct-tcpip', ('YOUR_SATURN_IP', 22), ('YOUR_JUPITER_LAN_IP', 0))

        target = paramiko.SSHClient()
        target.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        target.connect('YOUR_SATURN_IP', username='saturn', password='YOUR_SERVER_PASSWORD', sock=channel, timeout=10)

        cmd = """python3 -c "
import json, glob
files = glob.glob('/home/saturn/lvl3quant/alpha_discovery/results/sig_*.json')
by_strat = {}
profitable = 0
total = len(files)
best_overall = None
for f in sorted(files):
    try:
        with open(f) as fh:
            d = json.load(fh)
        pnl = d.get('total_pnl_dollars', d.get('pnl_dollars', 0))
        trades = d.get('total_trades', d.get('n_trades', 0))
        parts = f.split('sig_')[1].replace('.json', '')
        tokens = parts.split('_')
        date_idx = None
        for i, t in enumerate(tokens):
            if len(t) == 4 and t.isdigit() and int(t) >= 2020:
                date_idx = i
                break
        if date_idx:
            strat = '_'.join(tokens[:date_idx])
        else:
            strat = 'unknown'
        if strat not in by_strat:
            by_strat[strat] = {'count': 0, 'profitable': 0, 'total_pnl': 0, 'best_pnl': -999999, 'best_combo': '', 'total_trades': 0}
        by_strat[strat]['count'] += 1
        by_strat[strat]['total_pnl'] += pnl
        by_strat[strat]['total_trades'] += trades
        if pnl > 0:
            by_strat[strat]['profitable'] += 1
            profitable += 1
        if pnl > by_strat[strat]['best_pnl']:
            by_strat[strat]['best_pnl'] = pnl
            by_strat[strat]['best_combo'] = parts
        if best_overall is None or pnl > best_overall['pnl']:
            best_overall = {'pnl': pnl, 'combo': parts, 'trades': trades}
    except:
        pass

import subprocess
ps = subprocess.run(['pgrep', '-f', 'run_all_signal'], capture_output=True, text=True)
running = len(ps.stdout.strip().split()) > 0 if ps.stdout.strip() else False
tmux = subprocess.run(['tmux', 'list-sessions'], capture_output=True, text=True)
print(json.dumps({
    'total': total, 'profitable': profitable,
    'by_strat': by_strat,
    'best': best_overall,
    'server': 'saturn',
    'still_running': running,
    'tmux': tmux.stdout.strip()
}))
" """

        stdin, stdout, stderr = target.exec_command(cmd, timeout=60)
        out = stdout.read().decode('utf-8', errors='replace').strip()
        err = stderr.read().decode('utf-8', errors='replace').strip()

        lines = out.strip().split('\n')
        for line in reversed(lines):
            line = line.strip()
            if line.startswith('{'):
                data = json.loads(line)
                print(json.dumps(data))
                target.close()
                return

        print(json.dumps({'error': 'No JSON output', 'stdout': out[:500], 'stderr': err[:500]}), file=sys.stderr)
        target.close()
        sys.exit(1)

    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)
    finally:
        jump.close()

if __name__ == '__main__':
    main()
