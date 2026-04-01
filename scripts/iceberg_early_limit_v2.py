"""
Iceberg Early Limit Order — V2 (Sampled, Fast)
Uses 20K random samples per config. 48 configs. Should run in ~5-10 min.
"""
import numpy as np
import json, time, sys

t0 = time.time()
print('[START] iceberg_early_limit_v2', flush=True)

d = np.load('mbo_signals_iceberg.npz', allow_pickle=True)
signals = d['signals'].astype(np.float32)
mid = d['mid_prices'].astype(np.float32)
n = len(mid)
print(f'  Bars: {n:,} Signals: {int(np.count_nonzero(signals)):,}', flush=True)

TICK = 0.25
RT_COST = 0.25
N_SAMPLE = 20000
rng = np.random.default_rng(42)

sig_idx = np.where(signals != 0)[0]
sig_dirs = np.sign(signals[sig_idx]).astype(np.float32)
if np.all(sig_dirs > 0) or np.all(sig_dirs < 0):
    med = float(np.median(np.abs(signals[sig_idx])))
    sig_dirs = np.where(np.abs(signals[sig_idx]) >= med, 1.0, -1.0).astype(np.float32)

# Sample
sel = rng.choice(len(sig_idx), min(N_SAMPLE, len(sig_idx)), replace=False)
sel.sort()
sample_idx = sig_idx[sel]
sample_dirs = sig_dirs[sel]
print(f'  Sample: {len(sample_idx):,} signals, long%={float(np.mean(sample_dirs>0)):.1%}', flush=True)

configs = [(ta,tp,sl,hold) for ta in [3,5,7,10] for tp in [4,6,8,12] for sl in [3,5,8] for hold in [40,120,240]]
print(f'  {len(configs)} configs', flush=True)

results = []
for ci, (ta, tp_t, sl_t, hold) in enumerate(configs):
    pnls = []
    for i in range(len(sample_idx)):
        t = int(sample_idx[i])
        dd = sample_dirs[i]
        if t + hold >= n:
            continue
        ep = float(mid[t])
        if dd > 0:
            entry = ep + ta*TICK; tp_p = entry + tp_t*TICK; sl_p = ep - sl_t*TICK
        else:
            entry = ep - ta*TICK; tp_p = entry - tp_t*TICK; sl_p = ep + sl_t*TICK
        w = mid[t:t+hold]
        fm = (w <= entry) if dd > 0 else (w >= entry)
        if not np.any(fm):
            continue
        fo = int(np.argmax(fm))
        rem = mid[t+fo:t+hold]
        if len(rem) == 0:
            continue
        if dd > 0:
            tb = int(np.argmax(rem >= tp_p)) if np.any(rem >= tp_p) else len(rem)
            sb = int(np.argmax(rem <= sl_p)) if np.any(rem <= sl_p) else len(rem)
        else:
            tb = int(np.argmax(rem <= tp_p)) if np.any(rem <= tp_p) else len(rem)
            sb = int(np.argmax(rem >= sl_p)) if np.any(rem >= sl_p) else len(rem)
        if tb < sb and tb < len(rem):
            pnl = tp_t - RT_COST
        elif sb < len(rem):
            pnl = -(ta + sl_t) - RT_COST
        else:
            xp = float(rem[-1])
            pnl = ((xp-entry)/TICK - RT_COST) if dd > 0 else ((entry-xp)/TICK - RT_COST)
        pnls.append(pnl)
    if len(pnls) < 5:
        continue
    pa = np.array(pnls, dtype=np.float32)
    wr = float(np.mean(pa > 0))
    mp = float(np.mean(pa))
    neg = pa[pa < 0]
    so = float(mp / np.std(neg) * (252**0.5)) if len(neg) > 1 and float(np.std(neg)) > 0 else 0.0
    results.append({'ta': ta, 'tp': tp_t, 'sl': sl_t, 'hold': hold,
                    'n': len(pnls), 'fill_rate': round(len(pnls)/len(sample_idx),3),
                    'wr': round(wr,3), 'mean_pnl': round(mp,3), 'sortino': round(so,3)})
    if ci % 12 == 0:
        print(f'  [{ci+1}/{len(configs)}] {time.time()-t0:.0f}s', flush=True)

results.sort(key=lambda x: x['sortino'], reverse=True)
print(f'\n=== TOP 10 ===', flush=True)
for r in results[:10]:
    print(f"  ta={r['ta']}t tp={r['tp']}t sl={r['sl']}t hold={r['hold']}b: "
          f"Sortino={r['sortino']:.3f} WR={r['wr']:.1%} fill={r['fill_rate']:.1%} n={r['n']} pnl/t={r['mean_pnl']:.3f}", flush=True)
out = {'n_sample': N_SAMPLE, 'n_total': int(len(sig_idx)), 'n_configs': len(results),
       'elapsed': round(time.time()-t0,1), 'top20': results[:20], 'all': results}
with open('iceberg_early_results.json', 'w') as f:
    json.dump(out, f, indent=2)
print(f'\nSaved (total: {time.time()-t0:.0f}s)', flush=True)
