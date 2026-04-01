"""
MFE/MAE Conditioned — FAST VECTORIZED (using stride tricks for bulk horizons)
Correctly conditions MFE/MAE on signal direction.
Runs on mbo_signals_iceberg.npz + mbo_signals_queue_fade.npz (Razer local).
Sample: 20K signals per file, 6 horizons. Should run in ~1-2 min.
"""
import numpy as np
import json, time, sys

t0 = time.time()
print('[START] mfe_mae_conditioned_fast', flush=True)

TICK = 0.25
N_SAMPLE = 20000
HORIZONS_BARS = [10, 30, 60, 300, 600, 1200]  # 10s 30s 1min 5min 10min 20min
rng = np.random.default_rng(42)

signal_files = {
    'iceberg': 'mbo_signals_iceberg.npz',
    'queue_fade': 'mbo_signals_queue_fade.npz',
    'sweep': 'mbo_signals_sweep.npz',
    'orb': 'mbo_signals_orb.npz',
}

all_results = {}

for sig_name, fname in signal_files.items():
    try:
        d = np.load(fname, allow_pickle=True)
    except Exception as e:
        print(f'  {sig_name}: SKIP ({e})', flush=True)
        continue

    keys = list(d.keys())
    # Get mid prices
    mid = None
    for k in ['mid_prices', 'mid_price', 'price', 'mid']:
        if k in keys:
            mid = d[k].astype(np.float64)
            break
    if mid is None and 'bid' in keys and 'ask' in keys:
        mid = (d['bid'].astype(np.float64) + d['ask'].astype(np.float64)) / 2.0
    if mid is None:
        print(f'  {sig_name}: No price column', flush=True)
        continue

    # Get signal
    sig = None
    for k in keys:
        if k in ['signals', 'signal', sig_name]:
            sig = d[k].astype(np.float64)
            break
    if sig is None:
        for k in keys:
            if k not in ['mid_prices','mid_price','price','mid','bid','ask','timestamps','ts']:
                sig = d[k].astype(np.float64)
                break
    if sig is None:
        print(f'  {sig_name}: No signal column', flush=True)
        continue

    n = len(mid)
    idx = np.where(sig != 0)[0]
    print(f'  {sig_name}: {n:,} bars, {len(idx):,} signals, keys={keys}', flush=True)

    if len(idx) < 100:
        print(f'  {sig_name}: Too few signals', flush=True)
        continue

    # Sample
    sel = rng.choice(len(idx), min(N_SAMPLE, len(idx)), replace=False)
    sel.sort()
    si = idx[sel]
    dirs = np.sign(sig[si])
    if np.all(dirs > 0) or np.all(dirs < 0):
        med = np.median(np.abs(sig[si]))
        dirs = np.where(np.abs(sig[si]) >= med, 1.0, -1.0)

    # Filter valid (can compute all horizons)
    max_h = max(HORIZONS_BARS)
    valid = si + max_h < n
    si = si[valid]
    dirs = dirs[valid]
    print(f'    Valid (margin {max_h}): {len(si):,}', flush=True)

    # For each signal, vectorized forward window max/min
    # Build forward windows for each horizon
    horizon_results = {}
    for h in HORIZONS_BARS:
        # Forward windows: (n_signals, h)
        windows = mid[si[:, None] + np.arange(h)]  # shape: (n, h)
        entry_prices = mid[si]  # (n,)

        mfes = []
        maes = []
        ics = []
        wrs = []

        # For LONG signals
        long_mask = dirs > 0
        if np.sum(long_mask) > 0:
            long_windows = windows[long_mask]
            long_entry = entry_prices[long_mask]
            long_mfe = (np.max(long_windows, axis=1) - long_entry) / TICK
            long_mae = (long_entry - np.min(long_windows, axis=1)) / TICK
            long_outcome = (long_windows[:, -1] - long_entry) / TICK
            mfes.extend(long_mfe.tolist())
            maes.extend(long_mae.tolist())
            wrs.extend((long_outcome > 0).tolist())
            ics.extend(long_outcome.tolist())

        # For SHORT signals
        short_mask = dirs < 0
        if np.sum(short_mask) > 0:
            short_windows = windows[short_mask]
            short_entry = entry_prices[short_mask]
            short_mfe = (short_entry - np.min(short_windows, axis=1)) / TICK
            short_mae = (np.max(short_windows, axis=1) - short_entry) / TICK
            short_outcome = (short_entry - short_windows[:, -1]) / TICK
            mfes.extend(short_mfe.tolist())
            maes.extend(short_mae.tolist())
            wrs.extend((short_outcome > 0).tolist())
            ics.extend(short_outcome.tolist())

        mfe_arr = np.array(mfes)
        mae_arr = np.array(maes)
        out_arr = np.array(ics)
        wr = float(np.mean(np.array(wrs)))
        edge_ratio = float(np.mean(mfe_arr)) / (float(np.mean(mfe_arr)) + float(np.mean(mae_arr)) + 1e-9)
        ic = float(np.corrcoef(np.ones(len(out_arr)), out_arr)[0, 1]) if len(out_arr) > 1 else 0.0

        h_label = f'{h}bars'
        horizon_results[h_label] = {
            'mfe_mean': round(float(np.mean(mfe_arr)), 4),
            'mae_mean': round(float(np.mean(mae_arr)), 4),
            'edge_ratio': round(edge_ratio, 4),
            'wr': round(wr, 4),
            'n': len(mfes),
            'ic': round(ic, 4),
            'mfe_p50': round(float(np.median(mfe_arr)), 4),
            'mae_p50': round(float(np.median(mae_arr)), 4),
            'pnl_mean': round(float(np.mean(out_arr)), 4),
        }
        print(f'    h={h_label}: MFE={float(np.mean(mfe_arr)):.3f}t MAE={float(np.mean(mae_arr)):.3f}t edge={edge_ratio:.3f} WR={wr:.1%} n={len(mfes)}', flush=True)

    all_results[sig_name] = horizon_results
    print(f'  {sig_name} DONE', flush=True)

# Save
with open('mfe_mae_conditioned_results.json', 'w') as f:
    json.dump(all_results, f, indent=2)

elapsed = time.time() - t0
print(f'\nSaved mfe_mae_conditioned_results.json ({elapsed:.1f}s total)', flush=True)

# Print summary
print('\n=== SUMMARY ===', flush=True)
for sig, hrs in all_results.items():
    print(f'{sig}:', flush=True)
    for h, v in hrs.items():
        print(f'  {h}: MFE={v["mfe_mean"]:.3f}t MAE={v["mae_mean"]:.3f}t edge={v["edge_ratio"]:.3f} WR={v["wr"]:.1%}', flush=True)
