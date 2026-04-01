"""
Iceberg Early Limit Order — FAST VECTORIZED VERSION
Uses actual NPZ key names: signals, mid_prices, timestamps
Runs 48 configs synchronously in ~2-5 min.
"""
import numpy as np
import json
import time
import sys

t0 = time.time()
print('[START] iceberg_early_limit_fast.py', flush=True)

d = np.load('mbo_signals_iceberg.npz', allow_pickle=True)
signals = d['signals'].astype(np.float32)
mid = d['mid_prices'].astype(np.float32)
print(f'  Loaded: {len(mid):,} bars, {int(np.count_nonzero(signals)):,} signals', flush=True)

TICK = 0.25
RT_COST = 0.25

sig_idx = np.where(signals != 0)[0]
sig_dirs = np.sign(signals[sig_idx]).astype(np.float32)
if np.all(sig_dirs > 0) or np.all(sig_dirs < 0):
    med = float(np.median(np.abs(signals[sig_idx])))
    sig_dirs = np.where(np.abs(signals[sig_idx]) >= med, 1.0, -1.0).astype(np.float32)
    print(f'  One-sided signal, split at median={med:.4f}', flush=True)

print(f'  Signals: n={len(sig_idx)}, long%={float(np.mean(sig_dirs>0)):.1%}', flush=True)

results = []
n = len(mid)

configs = []
for ta in [3, 5, 7, 10]:
    for tp in [4, 6, 8, 12]:
        for sl in [3, 5, 8]:
            for hold in [40, 120, 240]:
                configs.append((ta, tp, sl, hold))

print(f'  Running {len(configs)} configs...', flush=True)

for ci, (ticks_ahead, tp_ticks, sl_ticks, hold_bars) in enumerate(configs):
    pnls = []
    for i in range(len(sig_idx)):
        t = int(sig_idx[i])
        d_dir = sig_dirs[i]
        if t + hold_bars >= n:
            continue
        entry_level = float(mid[t])
        if d_dir > 0:
            entry = entry_level + ticks_ahead * TICK
            tp = entry + tp_ticks * TICK
            sl = entry_level - sl_ticks * TICK
        else:
            entry = entry_level - ticks_ahead * TICK
            tp = entry - tp_ticks * TICK
            sl = entry_level + sl_ticks * TICK
        window = mid[t:t+hold_bars]
        fill_mask = (window <= entry) if d_dir > 0 else (window >= entry)
        if not np.any(fill_mask):
            continue
        fill_offset = int(np.argmax(fill_mask))
        remain = mid[t+fill_offset:t+hold_bars]
        if len(remain) == 0:
            continue
        if d_dir > 0:
            tp_bars = np.argmax(remain >= tp) if np.any(remain >= tp) else len(remain)
            sl_bars = np.argmax(remain <= sl) if np.any(remain <= sl) else len(remain)
        else:
            tp_bars = np.argmax(remain <= tp) if np.any(remain <= tp) else len(remain)
            sl_bars = np.argmax(remain >= sl) if np.any(remain >= sl) else len(remain)
        if int(tp_bars) < int(sl_bars) and int(tp_bars) < len(remain):
            pnl = tp_ticks - RT_COST
        elif int(sl_bars) < len(remain):
            pnl = -(ticks_ahead + sl_ticks) - RT_COST
        else:
            exit_p = float(remain[-1])
            pnl = ((exit_p - entry) / TICK - RT_COST) if d_dir > 0 else ((entry - exit_p) / TICK - RT_COST)
        pnls.append(pnl)
    if len(pnls) < 5:
        continue
    pnl_arr = np.array(pnls, dtype=np.float32)
    wr = float(np.mean(pnl_arr > 0))
    mean_pnl = float(np.mean(pnl_arr))
    neg = pnl_arr[pnl_arr < 0]
    sortino = float(mean_pnl / np.std(neg) * (252**0.5)) if len(neg) > 1 and float(np.std(neg)) > 0 else 0.0
    results.append({'ticks_ahead': ticks_ahead, 'tp_ticks': tp_ticks, 'sl_ticks': sl_ticks,
                    'hold_bars': hold_bars, 'n': len(pnls),
                    'fill_rate': round(len(pnls)/max(len(sig_idx),1), 3),
                    'wr': round(wr, 3), 'mean_pnl': round(mean_pnl, 3), 'sortino': round(sortino, 3)})
    if ci % 10 == 0:
        elapsed = time.time() - t0
        print(f'  [{ci+1}/{len(configs)}] {elapsed:.0f}s', flush=True)

results.sort(key=lambda x: x['sortino'], reverse=True)
elapsed = time.time() - t0
print(f'\n=== TOP 10 (of {len(results)}) ===', flush=True)
for r in results[:10]:
    print(f"  ta={r['ticks_ahead']}t tp={r['tp_ticks']}t sl={r['sl_ticks']}t hold={r['hold_bars']}b: "
          f"Sortino={r['sortino']:.3f} WR={r['wr']:.1%} n={r['n']} pnl={r['mean_pnl']:.3f}t", flush=True)
out = {'strategy': 'Iceberg Early Limit', 'n_configs': len(results), 'elapsed_s': round(elapsed, 1),
       'top20': results[:20], 'all': results}
with open('iceberg_early_limit_results.json', 'w') as f:
    json.dump(out, f, indent=2)
print(f'\nSaved iceberg_early_limit_results.json ({elapsed:.0f}s total)', flush=True)
