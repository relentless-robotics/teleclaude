#!/usr/bin/env python3
"""
wider_cnn_card_sweep_uranus.py — CPU-based card optimization sweep for WIDER CNN predictions.

Runs on Uranus CPU alongside GPU training. Uses pure Python (no fill_sim binary needed).
Single-threaded to avoid Windows multiprocessing issues with large arrays.
Optimized with vectorized numpy operations for speed.

Output: C:\\Users\\nick\\Lvl3Quant\\alpha_discovery\\deep_models\\results\\wider_cnn\\wider_cnn_card_sweep_results.json
"""

import os
import sys
import json
import time
import glob
import numpy as np
from pathlib import Path
from datetime import datetime

# ── Paths ─────────────────────────────────────────────────────────────────────
WIDER_CNN_DIR = Path(r"C:\Users\nick\Lvl3Quant\alpha_discovery\deep_models\results\wider_cnn")
OUTPUT_DIR = WIDER_CNN_DIR

# ── Sweep Parameters ──────────────────────────────────────────────────────────
SIGNAL_THRESHOLDS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0]
HOLD_BARS = [1, 3, 6, 10, 30, 60, 120, 300, 600, 1800]  # in 10s bars
TP_TICKS = [0, 2, 4, 6, 8, 12, 15, 20, 30]  # 0 = no TP
SL_TICKS = [0, 10, 15, 20, 25, 50]  # 0 = no SL
TICK_SIZE = 0.25  # ES tick size


def load_all_predictions():
    """Load all wider CNN prediction NPZ files and merge by date."""
    npz_files = sorted(glob.glob(str(WIDER_CNN_DIR / "oos_predictions_wider_cnn_*.npz")))
    if not npz_files:
        print("ERROR: No wider CNN NPZ files found!")
        sys.exit(1)

    all_dates = {}
    for f in npz_files:
        print(f"Loading {os.path.basename(f)}...", flush=True)
        data = np.load(f)
        for key in data.keys():
            if key.endswith("_preds"):
                date = key.replace("_preds", "")
                targets_key = f"{date}_targets"
                if targets_key in data:
                    all_dates[date] = {
                        'preds': data[key],
                        'targets': data[targets_key]
                    }

    print(f"Loaded {len(all_dates)} unique dates from {len(npz_files)} NPZ files", flush=True)
    dates = sorted(all_dates.keys())
    if dates:
        print(f"Date range: {dates[0]} to {dates[-1]}", flush=True)
    return all_dates


def simulate_card_vectorized(preds, targets, signal_threshold, hold_bars, tp_ticks, sl_ticks):
    """
    Vectorized card simulation. Much faster than bar-by-bar loop.

    For each entry signal, compute cumulative PnL over hold period,
    check TP/SL at each bar, find first exit.
    """
    n = len(preds)
    if n == 0:
        return None

    # Find entry points: where abs(pred) > threshold
    abs_preds = np.abs(preds)
    entry_mask = abs_preds >= signal_threshold

    if not np.any(entry_mask):
        return None

    # Get entry indices
    entry_indices = np.where(entry_mask)[0]

    # Filter to non-overlapping trades (skip entries within hold period of previous)
    filtered_entries = []
    next_allowed = 0
    for idx in entry_indices:
        if idx >= next_allowed:
            filtered_entries.append(idx)
            next_allowed = idx + hold_bars

    if not filtered_entries:
        return None

    entries = np.array(filtered_entries)
    n_trades = len(entries)
    directions = np.sign(preds[entries])

    # Compute PnL for each trade
    trade_pnls = np.zeros(n_trades)
    trade_holds = np.zeros(n_trades, dtype=int)
    trade_exits = ['hold'] * n_trades

    for t_idx in range(n_trades):
        entry = entries[t_idx]
        direction = directions[t_idx]
        end = min(entry + hold_bars, n)

        if entry >= n:
            continue

        # Cumulative returns from entry
        returns = targets[entry:end] * direction
        cum_returns = np.cumsum(returns)

        # Check TP/SL
        exit_bar = len(cum_returns)  # default: full hold
        exit_reason = 'hold'

        if tp_ticks > 0:
            tp_hits = np.where(cum_returns >= tp_ticks)[0]
            if len(tp_hits) > 0:
                exit_bar = tp_hits[0] + 1
                exit_reason = 'tp'

        if sl_ticks > 0:
            sl_hits = np.where(cum_returns <= -sl_ticks)[0]
            if len(sl_hits) > 0:
                sl_exit = sl_hits[0] + 1
                if sl_exit < exit_bar:
                    exit_bar = sl_exit
                    exit_reason = 'sl'

        if exit_bar <= len(cum_returns):
            trade_pnls[t_idx] = cum_returns[exit_bar - 1]
        trade_holds[t_idx] = exit_bar
        trade_exits[t_idx] = exit_reason

    # Cap SL losses
    if sl_ticks > 0:
        trade_pnls = np.maximum(trade_pnls, -sl_ticks)

    # Statistics
    total_pnl = float(np.sum(trade_pnls))
    avg_pnl = float(np.mean(trade_pnls))
    std_pnl = float(np.std(trade_pnls)) if n_trades > 1 else 1.0
    sharpe = (avg_pnl / std_pnl) * np.sqrt(252) if std_pnl > 1e-10 else 0.0
    win_rate = float(np.mean(trade_pnls > 0))

    # Drawdown
    cum_pnl = np.cumsum(trade_pnls)
    running_max = np.maximum.accumulate(cum_pnl)
    drawdowns = cum_pnl - running_max
    max_dd = float(np.min(drawdowns)) if len(drawdowns) > 0 else 0.0

    # Long/short split
    long_mask = directions > 0
    short_mask = directions < 0
    tp_count = sum(1 for e in trade_exits if e == 'tp')
    sl_count = sum(1 for e in trade_exits if e == 'sl')

    return {
        'total_pnl': round(total_pnl, 2),
        'n_trades': n_trades,
        'avg_pnl': round(avg_pnl, 4),
        'win_rate': round(win_rate, 4),
        'sharpe': round(sharpe, 2),
        'max_drawdown': round(max_dd, 2),
        'long_trades': int(np.sum(long_mask)),
        'short_trades': int(np.sum(short_mask)),
        'long_pnl': round(float(np.sum(trade_pnls[long_mask])), 2),
        'short_pnl': round(float(np.sum(trade_pnls[short_mask])), 2),
        'tp_exits': tp_count,
        'sl_exits': sl_count,
        'hold_exits': n_trades - tp_count - sl_count,
        'avg_hold_bars': round(float(np.mean(trade_holds)), 1),
    }


def main():
    start_time = time.time()
    print("=" * 70, flush=True)
    print("WIDER CNN Card Optimization Sweep - Uranus CPU", flush=True)
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", flush=True)
    print("=" * 70, flush=True)

    # Load predictions
    all_dates = load_all_predictions()
    if not all_dates:
        print("No data loaded!")
        return

    # Concatenate all dates into single arrays
    sorted_dates = sorted(all_dates.keys())
    all_preds = np.concatenate([all_dates[d]['preds'] for d in sorted_dates])
    all_targets = np.concatenate([all_dates[d]['targets'] for d in sorted_dates])

    print(f"\nSignal Statistics:", flush=True)
    print(f"  Total bars: {len(all_preds):,}", flush=True)
    print(f"  Pred mean: {all_preds.mean():.6f}, std: {all_preds.std():.6f}", flush=True)
    print(f"  Target mean: {all_targets.mean():.6f}, std: {all_targets.std():.6f}", flush=True)
    ic = np.corrcoef(all_preds, all_targets)[0, 1]
    print(f"  IC (full): {ic:.6f}", flush=True)

    # Percentile distribution
    abs_preds = np.abs(all_preds)
    pcts = [50, 75, 90, 95, 99]
    pct_vals = {p: round(float(np.percentile(abs_preds, p)), 4) for p in pcts}
    print(f"  |Pred| percentiles: {pct_vals}", flush=True)

    # Build sweep configs
    total_configs = len(SIGNAL_THRESHOLDS) * len(HOLD_BARS) * len(TP_TICKS) * len(SL_TICKS)
    print(f"\nSweep: {len(SIGNAL_THRESHOLDS)} thresholds x {len(HOLD_BARS)} holds x {len(TP_TICKS)} TPs x {len(SL_TICKS)} SLs = {total_configs} configs", flush=True)
    print(f"Running single-threaded (vectorized numpy)...\n", flush=True)

    # Run sweep
    results = []
    completed = 0
    config_id = 0

    for sig in SIGNAL_THRESHOLDS:
        sig_start = time.time()
        sig_results = 0

        for hold in HOLD_BARS:
            for tp in TP_TICKS:
                for sl in SL_TICKS:
                    result = simulate_card_vectorized(
                        all_preds, all_targets, sig, hold, tp, sl
                    )

                    completed += 1
                    config_id += 1

                    if result is not None:
                        result['config'] = {
                            'signal_threshold': sig,
                            'hold_bars': hold,
                            'hold_seconds': hold * 10,
                            'tp_ticks': tp,
                            'sl_ticks': sl,
                        }
                        result['config_id'] = config_id
                        results.append(result)
                        sig_results += 1

        elapsed = time.time() - start_time
        rate = completed / elapsed if elapsed > 0 else 0
        eta = (total_configs - completed) / rate if rate > 0 else 0
        print(f"  sig={sig:.2f}: {sig_results} valid configs ({time.time()-sig_start:.1f}s) | "
              f"Total: [{completed}/{total_configs}] ({rate:.0f}/sec, ETA {eta:.0f}s)", flush=True)

    elapsed = time.time() - start_time
    print(f"\nCompleted {total_configs} configs in {elapsed:.1f}s ({total_configs/elapsed:.0f}/sec)", flush=True)
    print(f"Valid results: {len(results)}", flush=True)

    # Sort by Sharpe
    results.sort(key=lambda x: x['sharpe'], reverse=True)

    # Print top 20
    print("\n" + "=" * 70, flush=True)
    print("TOP 20 CONFIGURATIONS BY SHARPE:", flush=True)
    print("=" * 70, flush=True)
    for i, r in enumerate(results[:20]):
        c = r['config']
        print(f"  #{i+1}: Sharpe={r['sharpe']:6.2f} | PnL={r['total_pnl']:8.1f} | "
              f"Trades={r['n_trades']:5d} | WR={r['win_rate']:.1%} | "
              f"sig={c['signal_threshold']:.2f} hold={c['hold_seconds']}s "
              f"TP={c['tp_ticks']} SL={c['sl_ticks']}", flush=True)

    # Print bottom 5
    print("\nBOTTOM 5 (WORST):", flush=True)
    for r in results[-5:]:
        c = r['config']
        print(f"  Sharpe={r['sharpe']:6.2f} | PnL={r['total_pnl']:8.1f} | "
              f"Trades={r['n_trades']:5d} | "
              f"sig={c['signal_threshold']:.2f} hold={c['hold_seconds']}s "
              f"TP={c['tp_ticks']} SL={c['sl_ticks']}", flush=True)

    # Dimensional analysis
    print("\n" + "=" * 70, flush=True)
    print("ANALYSIS BY DIMENSION:", flush=True)
    print("=" * 70, flush=True)

    print("\nBy Signal Threshold (avg Sharpe):", flush=True)
    for sig in SIGNAL_THRESHOLDS:
        subset = [r for r in results if r['config']['signal_threshold'] == sig]
        if subset:
            avg_sharpe = np.mean([r['sharpe'] for r in subset])
            avg_trades = np.mean([r['n_trades'] for r in subset])
            best = max(subset, key=lambda x: x['sharpe'])
            print(f"  sig={sig:.2f}: avg_sharpe={avg_sharpe:6.2f}, avg_trades={avg_trades:6.0f}, best={best['sharpe']:.2f}", flush=True)

    print("\nBy Hold Time (avg Sharpe):", flush=True)
    for hold in HOLD_BARS:
        subset = [r for r in results if r['config']['hold_bars'] == hold]
        if subset:
            avg_sharpe = np.mean([r['sharpe'] for r in subset])
            print(f"  hold={hold*10:5d}s ({hold:4d} bars): avg_sharpe={avg_sharpe:6.2f}", flush=True)

    print("\nBy Take Profit (avg Sharpe):", flush=True)
    for tp in TP_TICKS:
        subset = [r for r in results if r['config']['tp_ticks'] == tp]
        if subset:
            avg_sharpe = np.mean([r['sharpe'] for r in subset])
            print(f"  TP={tp:2d} ticks: avg_sharpe={avg_sharpe:6.2f}", flush=True)

    print("\nBy Stop Loss (avg Sharpe):", flush=True)
    for sl in SL_TICKS:
        subset = [r for r in results if r['config']['sl_ticks'] == sl]
        if subset:
            avg_sharpe = np.mean([r['sharpe'] for r in subset])
            print(f"  SL={sl:2d} ticks: avg_sharpe={avg_sharpe:6.2f}", flush=True)

    # Long vs Short for top 10
    print("\n" + "=" * 70, flush=True)
    print("LONG vs SHORT ANALYSIS (top 10):", flush=True)
    print("=" * 70, flush=True)
    for i, r in enumerate(results[:10]):
        c = r['config']
        print(f"  #{i+1} (Sharpe={r['sharpe']:.2f}): "
              f"Long={r['long_trades']} trades PnL={r['long_pnl']:.1f} | "
              f"Short={r['short_trades']} trades PnL={r['short_pnl']:.1f}", flush=True)

    # Save results
    output_file = OUTPUT_DIR / "wider_cnn_card_sweep_results.json"
    output = {
        'metadata': {
            'timestamp': datetime.now().isoformat(),
            'total_configs': total_configs,
            'valid_results': len(results),
            'elapsed_seconds': round(elapsed, 1),
            'n_dates': len(all_dates),
            'date_range': f"{sorted_dates[0]} to {sorted_dates[-1]}",
            'total_bars': int(len(all_preds)),
            'ic': round(float(ic), 6),
            'pred_std': round(float(all_preds.std()), 6),
            'sweep_params': {
                'signal_thresholds': SIGNAL_THRESHOLDS,
                'hold_bars': HOLD_BARS,
                'tp_ticks': TP_TICKS,
                'sl_ticks': SL_TICKS,
            }
        },
        'top_50': results[:50],
        'all_results': results,
    }

    with open(output_file, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\nResults saved to: {output_file}", flush=True)
    print(f"\nDone! Total time: {elapsed:.1f}s", flush=True)


if __name__ == "__main__":
    main()
