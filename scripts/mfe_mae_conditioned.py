"""
MFE/MAE Analysis — Signal-Conditioned (CORRECTED)
Computes max favorable/adverse excursion CONDITIONED on signal direction.

For a LONG signal: MFE = max price INCREASE after entry, MAE = max price DECREASE
For a SHORT signal: MFE = max price DECREASE after entry, MAE = max price INCREASE

This is the correct formulation. The prior script computed unconditional excursion
(same values for all signals because it ignored direction) — results were garbage.

Output: mfe_mae_conditioned_results.json
  {
    signal_name: {
      horizon: int (seconds),
      mfe_mean: float (ticks),
      mae_mean: float (ticks),
      edge_ratio: float (MFE/(MFE+MAE)),
      n_trades: int,
      ic: float,
      wr: float
    }
  }
"""
import numpy as np
import json
import os
import time
from pathlib import Path
import sys

LOG_FILE = r'C:\Users\claude\mfe_mae_conditioned.log'
OUT_FILE = r'C:\Users\claude\mfe_mae_conditioned_results.json'

TICK_SIZE = 0.25  # ES tick size in points

def log(msg):
    ts = time.strftime('%H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line, flush=True)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')

def load_npz(path):
    try:
        d = np.load(path, allow_pickle=True)
        log(f'  Loaded {path}: keys={list(d.keys())[:10]}')
        return d
    except Exception as e:
        log(f'  ERROR loading {path}: {e}')
        return None

def compute_mfe_mae_conditioned(mid_prices, signal_times, signal_directions, horizons_bars, tick_size=0.25):
    """
    signal_directions: +1 for long, -1 for short
    horizons_bars: list of bar counts to check
    Returns dict: horizon -> {mfe_mean, mae_mean, edge_ratio, wr, n}
    """
    n = len(mid_prices)
    results = {}

    for h in horizons_bars:
        mfes = []
        maes = []
        outcomes = []

        for i, (t, d) in enumerate(zip(signal_times, signal_directions)):
            if t + h >= n:
                continue

            entry_price = mid_prices[t]
            window = mid_prices[t:t+h]

            if d > 0:  # LONG
                mfe = (np.max(window) - entry_price) / tick_size
                mae = (entry_price - np.min(window)) / tick_size
                outcome = (window[-1] - entry_price) / tick_size
            else:  # SHORT
                mfe = (entry_price - np.min(window)) / tick_size
                mae = (np.max(window) - entry_price) / tick_size
                outcome = (entry_price - window[-1]) / tick_size

            mfes.append(mfe)
            maes.append(mae)
            outcomes.append(outcome)

        if len(mfes) == 0:
            continue

        mfe_arr = np.array(mfes)
        mae_arr = np.array(maes)
        out_arr = np.array(outcomes)

        mfe_mean = float(np.mean(mfe_arr))
        mae_mean = float(np.mean(mae_arr))
        edge_ratio = mfe_mean / (mfe_mean + mae_mean) if (mfe_mean + mae_mean) > 0 else 0.5
        wr = float(np.mean(out_arr > 0))
        ic = float(np.corrcoef(np.ones(len(out_arr)), out_arr)[0,1]) if len(out_arr) > 1 else 0.0

        results[h] = {
            'mfe_mean': round(mfe_mean, 4),
            'mae_mean': round(mae_mean, 4),
            'edge_ratio': round(edge_ratio, 4),
            'wr': round(wr, 4),
            'n': len(mfes),
            'mfe_p25': round(float(np.percentile(mfe_arr, 25)), 4),
            'mfe_p75': round(float(np.percentile(mfe_arr, 75)), 4),
            'mae_p25': round(float(np.percentile(mae_arr, 25)), 4),
            'mae_p75': round(float(np.percentile(mae_arr, 75)), 4),
        }

    return results

def main():
    log('=== MFE/MAE Conditioned Analysis (CORRECTED) ===')
    log(f'Output: {OUT_FILE}')

    # Data location on Razer
    DATA_DIR = Path(r'C:\Users\claude')

    # Horizons: 10s, 30s, 1min, 5min (at 1s bars = 1,30,60,300 bars)
    HORIZONS_BARS = [10, 30, 60, 300, 600]
    HORIZONS_LABELS = ['10s', '30s', '1min', '5min', '10min']

    # Try to load the mbo_signals files
    # Each npz should have: timestamps, mid_price, and signal columns
    all_results = {}

    signal_files = {
        'iceberg': r'C:\Users\claude\mbo_signals_iceberg.npz',
        'queue_fade': r'C:\Users\claude\mbo_signals_queue_fade.npz',
        'all_signals': r'C:\Users\claude\mbo_signals_all.npz',
        'sweep': r'C:\Users\claude\mbo_signals_sweep.npz',
    }

    # First, probe the all_signals file to understand structure
    log('Probing data structure...')
    probe_path = signal_files.get('all_signals')
    if not os.path.exists(probe_path):
        log(f'ERROR: {probe_path} not found')
        # Try alternate path
        alt_paths = list(Path(r'C:\Users\claude').glob('mbo_signals*.npz'))
        log(f'Found npz files: {[str(p) for p in alt_paths]}')
        if not alt_paths:
            log('FATAL: No mbo_signals npz files found')
            return

    d = load_npz(probe_path)
    if d is None:
        return

    keys = list(d.keys())
    log(f'Keys: {keys}')

    # Detect data structure
    # Expected: timestamps/ts, mid_price/price/bid/ask, signal columns
    # Each key is an array
    for k in keys[:5]:
        arr = d[k]
        log(f'  {k}: shape={getattr(arr,"shape","?")} dtype={getattr(arr,"dtype","?")} sample={arr.flat[0] if hasattr(arr,"flat") else "?"}')

    # Now try to extract mid prices and signals
    # Strategy: find price column and signal columns
    mid_key = None
    for candidate in ['mid_price', 'price', 'mid', 'wmid']:
        if candidate in keys:
            mid_key = candidate
            break

    if mid_key is None:
        # Look for bid/ask
        if 'bid' in keys and 'ask' in keys:
            log('Computing mid from bid/ask')
            mid_prices = (d['bid'].astype(np.float64) + d['ask'].astype(np.float64)) / 2.0
            mid_key = 'computed'
        else:
            log(f'ERROR: Cannot find mid price. Available: {keys}')
            # Try using first numeric array as price reference
            for k in keys:
                arr = d[k]
                if hasattr(arr, 'dtype') and np.issubdtype(arr.dtype, np.number) and len(arr) > 1000:
                    log(f'Using {k} as mid price proxy')
                    mid_prices = arr.astype(np.float64)
                    mid_key = k
                    break
    else:
        mid_prices = d[mid_key].astype(np.float64)

    if mid_key is None:
        log('FATAL: Cannot determine price data')
        return

    log(f'Mid prices: n={len(mid_prices)}, mean={np.nanmean(mid_prices):.2f}, range=[{np.nanmin(mid_prices):.2f}, {np.nanmax(mid_prices):.2f}]')

    # Find signal columns (binary or continuous signals)
    signal_cols = [k for k in keys if k not in ['timestamp', 'ts', 'date', 'time', mid_key, 'bid', 'ask', 'bid_size', 'ask_size']]
    log(f'Signal candidates: {signal_cols}')

    for sig_name in signal_cols:
        sig = d[sig_name]
        if not hasattr(sig, 'dtype') or not np.issubdtype(sig.dtype, np.number):
            continue
        if len(sig) != len(mid_prices):
            log(f'  {sig_name}: shape mismatch, skip')
            continue

        sig_float = sig.astype(np.float64)
        nonzero = np.count_nonzero(np.isfinite(sig_float) & (sig_float != 0))
        log(f'\n--- Signal: {sig_name} ---')
        log(f'  nonzero/total: {nonzero}/{len(sig_float)}')
        log(f'  stats: mean={np.nanmean(sig_float):.4f} std={np.nanstd(sig_float):.4f} min={np.nanmin(sig_float):.4f} max={np.nanmax(sig_float):.4f}')

        if nonzero < 100:
            log(f'  Too few signals ({nonzero}), skip')
            continue

        # Extract signal events: where signal is nonzero
        # Direction: positive = long, negative = short
        sig_mask = np.isfinite(sig_float) & (sig_float != 0)
        sig_times = np.where(sig_mask)[0]
        sig_dirs = np.sign(sig_float[sig_mask])

        # If signal is all positive (e.g., indicator), use normalized value to determine direction
        if np.all(sig_dirs > 0):
            # Treat above-median as long, below as short
            med = np.median(sig_float[sig_mask])
            sig_dirs = np.where(sig_float[sig_mask] >= med, 1.0, -1.0)
            log(f'  All-positive signal: split at median={med:.4f}')

        log(f'  Signal events: {len(sig_times)}, long%={np.mean(sig_dirs>0):.2%}')

        t0 = time.time()
        horizon_results = compute_mfe_mae_conditioned(mid_prices, sig_times, sig_dirs, HORIZONS_BARS)
        elapsed = time.time() - t0

        sig_results = {}
        for h, label in zip(HORIZONS_BARS, HORIZONS_LABELS):
            if h not in horizon_results:
                continue
            r = horizon_results[h]
            log(f'  {label}: MFE={r["mfe_mean"]:.3f}t MAE={r["mae_mean"]:.3f}t edge={r["edge_ratio"]:.3f} WR={r["wr"]:.1%} n={r["n"]}')
            sig_results[label] = r

        log(f'  Done in {elapsed:.1f}s')
        all_results[sig_name] = sig_results

    # Save results
    log(f'\nSaving to {OUT_FILE}')
    with open(OUT_FILE, 'w') as f:
        json.dump(all_results, f, indent=2)
    log('DONE')

if __name__ == '__main__':
    main()
