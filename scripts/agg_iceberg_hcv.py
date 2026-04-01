#!/usr/bin/env python3
"""
Aggregate iceberg_highcv_fillsim results.
Groups by config_id (derived from filename suffix), averages across all days.
"""
import os, json, glob, re
from collections import defaultdict

RESULTS_DIR = '/home/jupiter/Lvl3Quant/data/processed/iceberg_highcv_fillsim/'
OUTPUT = '/home/jupiter/Lvl3Quant/data/processed/iceberg_hcv_agg.json'

files = glob.glob(RESULTS_DIR + '*.json')
print(f'Total files: {len(files)}')

# Extract config from filename: YYYY-MM-DD_<config>.json
configs = defaultdict(lambda: {
    'pnl': [], 'trades': [], 'wr': [], 'fill_rate': [], 'days': 0,
    'sharpe': [], 'profit_factor': [], 'avg_queue_pos': []
})

for f in files:
    fname = os.path.basename(f)
    # Config is everything after the date prefix
    m = re.match(r'\d{4}-\d{2}-\d{2}_(.+)\.json', fname)
    if not m:
        continue
    cfg = m.group(1)

    try:
        with open(f) as fh:
            d = json.load(fh)

        total_pnl = d.get('total_pnl_dollars', 0) or 0
        n_trades = d.get('total_trades', 0) or 0
        wr = d.get('win_rate', 0) or 0
        fill_rate = d.get('fill_rate', 0) or 0
        sharpe = d.get('sharpe_per_trade', 0) or 0
        pf = d.get('profit_factor', 0) or 0
        qpos = d.get('avg_queue_position', 0) or 0

        configs[cfg]['pnl'].append(total_pnl)
        configs[cfg]['trades'].append(n_trades)
        configs[cfg]['wr'].append(wr)
        configs[cfg]['fill_rate'].append(fill_rate)
        configs[cfg]['days'] += 1
        configs[cfg]['sharpe'].append(sharpe)
        configs[cfg]['profit_factor'].append(pf)
        configs[cfg]['avg_queue_pos'].append(qpos)
    except Exception as e:
        print(f'  Error {fname}: {e}')

# Aggregate
results = []
for cfg, data in configs.items():
    n = data['days']
    if n == 0:
        continue

    avg_pnl = sum(data['pnl']) / n
    total_pnl = sum(data['pnl'])
    avg_trades = sum(data['trades']) / n
    avg_wr = sum(data['wr']) / n
    avg_fill = sum(data['fill_rate']) / n
    avg_qpos = sum(data['avg_queue_pos']) / n

    # Sortino-like: mean/std of daily PnL
    import statistics
    if n > 1:
        std_pnl = statistics.stdev(data['pnl'])
        neg_rets = [p for p in data['pnl'] if p < 0]
        downside_std = statistics.stdev(neg_rets) if len(neg_rets) > 1 else (std_pnl or 1)
        sortino = avg_pnl / (downside_std + 1e-9)
    else:
        sortino = 0
        std_pnl = 0

    results.append({
        'config': cfg,
        'days': n,
        'avg_pnl_day': round(avg_pnl, 2),
        'total_pnl': round(total_pnl, 2),
        'sortino': round(sortino, 3),
        'avg_trades_day': round(avg_trades, 1),
        'avg_wr': round(avg_wr, 3),
        'avg_fill_rate': round(avg_fill, 3),
        'avg_queue_pos': round(avg_qpos, 1),
        'pnl_std': round(std_pnl, 2),
    })

results.sort(key=lambda x: -x['sortino'])

print(f'\nCONFIGS RANKED BY SORTINO ({len(results)} total):')
print(f'{"Config":<35} {"Days":>5} {"Avg PnL":>9} {"Sortino":>8} {"AvgTrd":>7} {"WR":>6} {"FillR":>6} {"QPos":>6}')
print('-' * 95)
for r in results:
    print(f'{r["config"]:<35} {r["days"]:>5} ${r["avg_pnl_day"]:>8.2f} {r["sortino"]:>8.3f} '
          f'{r["avg_trades_day"]:>7.1f} {r["avg_wr"]:>5.1%} {r["avg_fill_rate"]:>5.1%} {r["avg_queue_pos"]:>6.1f}')

# Save
with open(OUTPUT, 'w') as f:
    json.dump({'configs': results, 'n_files': len(files), 'n_configs': len(results)}, f, indent=2)
print(f'\nSaved to {OUTPUT}')

# Key insight
positive = [r for r in results if r['sortino'] > 0 and r['avg_pnl_day'] > 0]
print(f'\nPositive Sortino + PnL: {len(positive)}/{len(results)} configs')
if positive:
    best = positive[0]
    print(f'BEST: {best["config"]} Sortino={best["sortino"]} PnL=${best["avg_pnl_day"]}/day WR={best["avg_wr"]:.1%} FillR={best["avg_fill_rate"]:.1%}')
