#!/usr/bin/env python3
"""
mfe_mae_multihorizon.py — MFE/MAE analysis for all signals at multiple time horizons.

Answers: WHERE does each signal have edge?
- Not just "is there IC" but "at what horizon is the edge maximized"
- MFE (Max Favorable Excursion): best price reached before reversal
- MAE (Max Adverse Excursion): worst price reached before reversal
- Edge ratio = MFE / (MFE + MAE) — closer to 1 means signal has directional edge

Signals tested: iceberg (proxy), queue_fade, imbalance, sweep (absorption), momentum
Horizons: 10s (100 bars), 30s (300), 1min (600), 5min (3000), 10min (6000), 30min (18000)

Deploys on Razer: RTX 3070 8GB, 173 days of book tensors
Data: C:/Users/claude/Lvl3Quant/data/processed/dl_book_cache

Output: C:/Users/claude/Lvl3Quant/data/processed/dl_book_cache/mfe_mae_multihorizon_results.json
        C:/Users/claude/Lvl3Quant/data/processed/dl_book_cache/mfe_mae_report.txt
"""

import glob
import json
import os
import time
import numpy as np
from scipy import stats as ss

# ─────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────
DATA_DIR = "C:/Users/claude/Lvl3Quant/data/processed/dl_book_cache"
OUT_JSON = os.path.join(DATA_DIR, "mfe_mae_multihorizon_results.json")
OUT_TXT  = os.path.join(DATA_DIR, "mfe_mae_report.txt")

TICK_SIZE = 0.25  # ES tick = $12.50

# Time horizons in bars (each bar = 100ms at event stream level)
# 1 second ≈ 10 bars, so:
#   10s  = 100 bars
#   30s  = 300 bars
#   1min = 600 bars
#   5min = 3000 bars
#   10min = 6000 bars
#   30min = 18000 bars
HORIZONS = {
    "10s":   100,
    "30s":   300,
    "1min":  600,
    "5min":  3000,
    "10min": 6000,
    "30min": 18000,
}

# ─────────────────────────────────────────────────────────
# DATA LOADING
# ─────────────────────────────────────────────────────────
def load_all_data(max_files=None):
    """Load all book tensors and mid prices. Returns arrays concatenated."""
    files = sorted(glob.glob(os.path.join(DATA_DIR, "*_book_tensors.npz")))
    if max_files:
        files = files[:max_files]

    print(f"Loading {len(files)} files...")
    tensors_list, mids_list = [], []

    for i, f in enumerate(files):
        try:
            z = np.load(f, allow_pickle=False)
            t = z["book_tensors"]  # (N, 20, 4)
            m = z["mid_prices"].astype(np.float32)
            tensors_list.append(t)
            mids_list.append(m)
            if (i + 1) % 20 == 0:
                print(f"  Loaded {i+1}/{len(files)} files...")
        except Exception as e:
            print(f"  Skip {os.path.basename(f)}: {e}")

    tensors = np.concatenate(tensors_list, axis=0)
    mids = np.concatenate(mids_list, axis=0)
    print(f"Total bars: {len(mids):,}  ({len(mids)/36000:.1f} trading days equiv)")
    return tensors, mids


# ─────────────────────────────────────────────────────────
# SIGNAL DEFINITIONS (derived from book tensors)
# Book tensor shape: (N, 20, 4)
# Features per level: [price_offset, bid_qty, ask_qty, cumvol]
# Levels 0-9: ask side (positive offsets), 10-19: bid side (negative offsets)
# Wait — looking at sample: level 0 has price_offset = -0.5, so levels 0-9 = bid side
# level 10 has +0.5 offset -> ask side. Let's verify and use accordingly.
# ─────────────────────────────────────────────────────────

def compute_signals(tensors, mid):
    """
    Derive 5 signal families from book tensors.
    Returns dict of signal arrays, each shape (N,) with values in {-1, 0, 1}.
    """
    N = len(tensors)
    price_offsets = tensors[:, :, 0]   # (N, 20)
    bid_qty       = tensors[:, :, 1]   # (N, 20)
    ask_qty       = tensors[:, :, 2]   # (N, 20)
    cum_vol       = tensors[:, :, 3]   # (N, 20)

    # Identify bid vs ask levels by sign of price offset
    # Negative offset = below mid = bid, Positive = above mid = ask
    bid_mask = price_offsets < 0   # (N, 20)
    ask_mask = price_offsets > 0   # (N, 20)

    bid_qty_total = np.sum(bid_qty * bid_mask, axis=1)   # (N,)
    ask_qty_total = np.sum(ask_qty * ask_mask, axis=1)   # (N,)

    # 1. IMBALANCE: bid_qty vs ask_qty ratio
    #    Positive => bid-heavy => bullish
    total_qty = bid_qty_total + ask_qty_total + 1e-6
    imbalance_raw = (bid_qty_total - ask_qty_total) / total_qty  # [-1, 1]
    # Threshold: top/bottom 20% = signal
    ib_thresh = 0.3
    imbalance_sig = np.where(imbalance_raw > ib_thresh, 1,
                    np.where(imbalance_raw < -ib_thresh, -1, 0)).astype(np.int8)

    # 2. QUEUE_FADE: compare top-of-book qty changes
    #    When best bid qty drops significantly -> fade (expect down), vice versa
    #    Proxy: 1st-level bid qty vs its rolling mean
    best_bid_qty = bid_qty[:, 0]   # level 0 (closest to mid on bid side)
    best_ask_qty = ask_qty[:, 10] if tensors.shape[1] > 10 else ask_qty[:, 0]

    # Rolling mean with window 100
    window = 100
    roll_bid = np.convolve(best_bid_qty, np.ones(window)/window, mode='same')
    roll_ask = np.convolve(best_ask_qty, np.ones(window)/window, mode='same')

    # Fade: if best bid is >50% below its mean, shorts expected (fade the bid)
    bid_ratio = best_bid_qty / (roll_bid + 1e-6)
    ask_ratio = best_ask_qty / (roll_ask + 1e-6)

    qf_sig = np.where((bid_ratio < 0.5) & (ask_ratio > 1.5), -1,    # bid fading, ask growing -> short
             np.where((ask_ratio < 0.5) & (bid_ratio > 1.5), 1, 0)).astype(np.int8)   # ask fading -> long

    # 3. ICEBERG (proxy): large cumvol prints at best bid/ask
    #    Iceberg orders repeat at same price with large volume
    #    Proxy: cumvol at best level vs typical cumvol
    best_bid_cumvol = cum_vol[:, 0]
    best_ask_cumvol = cum_vol[:, 10] if cum_vol.shape[1] > 10 else cum_vol[:, 0]

    roll_bid_cv = np.convolve(best_bid_cumvol, np.ones(window)/window, mode='same')
    roll_ask_cv = np.convolve(best_ask_cumvol, np.ones(window)/window, mode='same')

    bid_cv_ratio = best_bid_cumvol / (roll_bid_cv + 1e-6)
    ask_cv_ratio = best_ask_cumvol / (roll_ask_cv + 1e-6)

    # Iceberg at bid -> support -> buy; iceberg at ask -> resistance -> sell
    iceberg_sig = np.where(bid_cv_ratio > 3.0, 1,      # large bid iceberg -> support -> long
                  np.where(ask_cv_ratio > 3.0, -1, 0)).astype(np.int8)  # large ask iceberg -> resist -> short

    # 4. SWEEP / ABSORPTION:
    #    Sweep = large qty consumed across multiple levels (aggressor takes liquidity)
    #    Absorption = large qty at single level absorbs aggression (market maker holds)
    #    Proxy: spread across top 3 levels vs single-level concentration
    top3_bid_qty = bid_qty[:, :3].sum(axis=1)   # top 3 bid levels
    top3_ask_qty = ask_qty[:, :3].sum(axis=1)   # but need ask side

    # Level concentration: if most qty is at level 0 (tight), vs spread out
    bid_conc = bid_qty[:, 0] / (top3_bid_qty + 1e-6)  # 1 = all at best, 0.33 = uniform
    ask_conc_vals = ask_qty[:, 10:13].sum(axis=1) if ask_qty.shape[1] > 12 else ask_qty[:, 0]
    ask_top3 = ask_conc_vals
    ask_conc = ask_qty[:, 10] / (ask_top3 + 1e-6) if ask_qty.shape[1] > 10 else bid_conc

    # High concentration = absorption (market maker defending level)
    # Low bid concentration + high ask concentration = bid swept, shorts
    sweep_sig = np.where((bid_conc < 0.4) & (ask_conc > 0.7), -1,  # bid swept -> short
                np.where((ask_conc < 0.4) & (bid_conc > 0.7), 1, 0)).astype(np.int8)  # ask swept -> long

    # 5. MOMENTUM: price momentum from mid-price changes
    #    Uses mid_prices directly
    p_change_short = np.zeros(N, dtype=np.float32)
    p_change_long  = np.zeros(N, dtype=np.float32)

    short_w = 50   # ~5s
    long_w  = 300  # ~30s

    p_change_short[short_w:] = mid[short_w:] - mid[:-short_w]
    p_change_long[long_w:]   = mid[long_w:] - mid[:-long_w]

    # Momentum: both timeframes agree on direction
    mom_sig = np.where((p_change_short > TICK_SIZE) & (p_change_long > TICK_SIZE), 1,
              np.where((p_change_short < -TICK_SIZE) & (p_change_long < -TICK_SIZE), -1, 0)).astype(np.int8)

    return {
        "imbalance": imbalance_sig,
        "queue_fade": qf_sig,
        "iceberg":   iceberg_sig,
        "sweep":     sweep_sig,
        "momentum":  mom_sig,
    }


# ─────────────────────────────────────────────────────────
# MFE / MAE COMPUTATION
# ─────────────────────────────────────────────────────────
def compute_mfe_mae_at_horizon(signal, mid, horizon_bars):
    """
    For each signal entry, compute:
    - MFE: max favorable excursion over [0..horizon] bars
    - MAE: max adverse excursion over [0..horizon] bars
    - Final return at horizon
    - Edge ratio = MFE / (MFE + MAE + 1e-9)

    Returns dict with statistics.
    """
    N = len(mid)
    H = horizon_bars

    entry_idx = np.where(signal != 0)[0]
    # Only use entries where we have enough future data
    entry_idx = entry_idx[entry_idx < N - H - 1]

    if len(entry_idx) < 10:
        return {"n": 0, "mfe_mean": 0.0, "mae_mean": 0.0, "edge_ratio": 0.5,
                "ic": 0.0, "sortino": 0.0, "win_rate": 0.0, "ret_mean": 0.0}

    directions = signal[entry_idx].astype(np.float32)  # +1 or -1

    # Vectorized MFE/MAE computation
    # Build future price paths: shape (n_entries, H)
    # Only feasible for moderate n_entries × H -- use chunking if needed

    mfe_list = []
    mae_list = []
    ret_list = []

    chunk_size = 5000
    for start in range(0, len(entry_idx), chunk_size):
        end = min(start + chunk_size, len(entry_idx))
        idx_chunk = entry_idx[start:end]
        dir_chunk = directions[start:end]

        # Future prices relative to entry
        future_idx = idx_chunk[:, None] + np.arange(1, H + 1)[None, :]  # (n, H)
        # Clip to valid range
        future_idx = np.clip(future_idx, 0, N - 1)
        future_prices = mid[future_idx]  # (n, H)

        entry_prices = mid[idx_chunk][:, None]  # (n, 1)
        moves = (future_prices - entry_prices) / TICK_SIZE  # in ticks

        # For each direction, favorable = signal direction × move
        favorable = moves * dir_chunk[:, None]   # (n, H) — positive = good

        mfe = np.max(favorable, axis=1)   # best reached
        mae = -np.min(favorable, axis=1)  # worst reached (positive = bad)
        mae = np.maximum(mae, 0.0)

        final_ret = favorable[:, -1]  # return at exact horizon

        mfe_list.append(mfe)
        mae_list.append(mae)
        ret_list.append(final_ret)

    mfe_arr = np.concatenate(mfe_list)
    mae_arr = np.concatenate(mae_list)
    ret_arr = np.concatenate(ret_list)

    # Statistics
    mfe_mean = float(np.mean(mfe_arr))
    mae_mean = float(np.mean(mae_arr))
    edge_ratio = mfe_mean / (mfe_mean + mae_mean + 1e-9)

    # IC at horizon
    fwd_full = np.zeros(N, dtype=np.float32)
    fwd_full[:-H] = (mid[H:] - mid[:-H]) / TICK_SIZE

    valid_mask = np.isfinite(fwd_full[entry_idx]) & (fwd_full[entry_idx] != 0)
    if valid_mask.sum() > 20:
        ic, _ = ss.spearmanr(directions[valid_mask], fwd_full[entry_idx][valid_mask])
        ic = float(ic) if np.isfinite(ic) else 0.0
    else:
        ic = 0.0

    # Sortino
    rets = ret_arr
    neg_rets = rets[rets < 0]
    ds = float(np.sqrt(np.mean(neg_rets**2))) if len(neg_rets) > 0 else 1e-9
    sortino = float(np.mean(rets) / ds) if ds > 0 else 0.0

    win_rate = float(np.mean(ret_arr > 0))

    # MFE/MAE percentiles
    mfe_p25  = float(np.percentile(mfe_arr, 25))
    mfe_p50  = float(np.percentile(mfe_arr, 50))
    mfe_p75  = float(np.percentile(mfe_arr, 75))
    mae_p25  = float(np.percentile(mae_arr, 25))
    mae_p50  = float(np.percentile(mae_arr, 50))
    mae_p75  = float(np.percentile(mae_arr, 75))

    # Optimal holding time: when does cumulative edge peak?
    # Sample subset for this computation
    sample_n = min(5000, len(entry_idx))
    sample_idx = np.random.choice(len(entry_idx), sample_n, replace=False)

    fut_idx_s = entry_idx[sample_idx][:, None] + np.arange(1, H + 1)[None, :]
    fut_idx_s = np.clip(fut_idx_s, 0, N - 1)
    fut_p_s = mid[fut_idx_s]
    ep_s = mid[entry_idx[sample_idx]][:, None]
    fav_s = (fut_p_s - ep_s) / TICK_SIZE * directions[sample_idx][:, None]
    mean_curve = np.mean(fav_s, axis=0)  # (H,)
    peak_bar = int(np.argmax(mean_curve))

    return {
        "n": int(len(entry_idx)),
        "signal_freq": float(len(entry_idx) / N),
        "mfe_mean": float(mfe_mean),
        "mae_mean": float(mae_mean),
        "edge_ratio": float(edge_ratio),  # >0.5 = edge, >0.7 = strong edge
        "mfe_p25": mfe_p25, "mfe_p50": mfe_p50, "mfe_p75": mfe_p75,
        "mae_p25": mae_p25, "mae_p50": mae_p50, "mae_p75": mae_p75,
        "ic": float(ic),
        "sortino": float(sortino),
        "win_rate": float(win_rate),
        "ret_mean": float(np.mean(ret_arr)),
        "peak_bar": peak_bar,
        "peak_bar_sec": round(peak_bar / 10, 1),   # ~100ms per bar -> seconds
    }


# ─────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────
def main():
    t0 = time.time()
    print("=" * 70)
    print("MFE/MAE Multi-Horizon Signal Analysis")
    print("=" * 70)

    # Load data
    tensors, mid = load_all_data()

    # Compute signals
    print("\nComputing signals from book tensors...")
    signals = compute_signals(tensors, mid)

    for name, sig in signals.items():
        n_sig = int(np.sum(sig != 0))
        print(f"  {name:15s}: {n_sig:8,} entries ({100*n_sig/len(mid):.2f}% active)")

    # Run MFE/MAE at each horizon
    print("\nRunning MFE/MAE analysis across horizons...")
    results = {}

    for sig_name, sig in signals.items():
        results[sig_name] = {}
        print(f"\n  Signal: {sig_name}")

        for hz_name, hz_bars in HORIZONS.items():
            print(f"    Horizon {hz_name} ({hz_bars} bars)...", end=" ", flush=True)
            r = compute_mfe_mae_at_horizon(sig, mid, hz_bars)
            results[sig_name][hz_name] = r
            print(f"n={r['n']:,}  MFE={r['mfe_mean']:.3f}  MAE={r['mae_mean']:.3f}  "
                  f"edge={r['edge_ratio']:.3f}  IC={r['ic']:.4f}  sortino={r['sortino']:.3f}")

    # Save JSON
    with open(OUT_JSON, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to: {OUT_JSON}")

    # Generate text report
    report_lines = []
    report_lines.append("=" * 90)
    report_lines.append("MFE/MAE MULTI-HORIZON SIGNAL ANALYSIS REPORT")
    report_lines.append(f"Data: {len(mid):,} bars ({len(mid)/36000:.1f} day-equivalents)")
    report_lines.append("=" * 90)

    # Summary: best horizon per signal
    report_lines.append("\n--- BEST HORIZON PER SIGNAL (by edge_ratio) ---\n")
    report_lines.append(f"{'Signal':15s}  {'Best Hz':8s}  {'EdgeRatio':10s}  {'MFE':8s}  "
                       f"{'MAE':8s}  {'IC':8s}  {'Sortino':8s}  {'WinRate':8s}  {'n':8s}")
    report_lines.append("-" * 90)

    for sig_name, hz_results in results.items():
        best_hz = max(hz_results.items(), key=lambda x: x[1]["edge_ratio"])
        r = best_hz[1]
        report_lines.append(
            f"{sig_name:15s}  {best_hz[0]:8s}  {r['edge_ratio']:10.4f}  "
            f"{r['mfe_mean']:8.3f}  {r['mae_mean']:8.3f}  {r['ic']:8.4f}  "
            f"{r['sortino']:8.3f}  {r['win_rate']:8.2%}  {r['n']:8,}"
        )

    # Full breakdown
    report_lines.append("\n\n--- FULL BREAKDOWN BY SIGNAL AND HORIZON ---")

    for sig_name, hz_results in results.items():
        report_lines.append(f"\n{sig_name.upper()}:")
        report_lines.append(
            f"  {'Horizon':8s}  {'n':8s}  {'EdgeRatio':10s}  {'MFE':8s}  {'MAE':8s}  "
            f"{'IC':8s}  {'Sortino':8s}  {'WinRate':8s}  {'PeakSec':8s}"
        )
        report_lines.append("  " + "-" * 80)

        for hz_name, r in hz_results.items():
            flag = " *** EDGE" if r["edge_ratio"] > 0.60 else (" * " if r["edge_ratio"] > 0.55 else "")
            report_lines.append(
                f"  {hz_name:8s}  {r['n']:8,}  {r['edge_ratio']:10.4f}  "
                f"{r['mfe_mean']:8.3f}  {r['mae_mean']:8.3f}  {r['ic']:8.4f}  "
                f"{r['sortino']:8.3f}  {r['win_rate']:8.2%}  {r['peak_bar_sec']:8.1f}s"
                f"{flag}"
            )

    # Edge summary: signals with edge_ratio > 0.58 at any horizon
    report_lines.append("\n\n--- SIGNALS WITH EDGE (edge_ratio > 0.58) ---")
    found = False
    for sig_name, hz_results in results.items():
        for hz_name, r in hz_results.items():
            if r["edge_ratio"] > 0.58 and r["n"] > 1000:
                if not found:
                    report_lines.append(f"\n{'Signal':15s}  {'Horizon':8s}  "
                                       f"{'EdgeRatio':10s}  {'IC':8s}  {'Sortino':8s}")
                    report_lines.append("-" * 55)
                    found = True
                report_lines.append(f"{sig_name:15s}  {hz_name:8s}  "
                                   f"{r['edge_ratio']:10.4f}  {r['ic']:8.4f}  {r['sortino']:8.3f}")
    if not found:
        report_lines.append("  None found above threshold. Check IC distribution for weaker signals.")

    elapsed = time.time() - t0
    report_lines.append(f"\n\nCompleted in {elapsed:.0f}s at {time.strftime('%Y-%m-%d %H:%M:%S')}")

    report_text = "\n".join(report_lines)
    print("\n" + report_text)

    with open(OUT_TXT, 'w') as f:
        f.write(report_text)
    print(f"\nReport saved to: {OUT_TXT}")


if __name__ == "__main__":
    np.random.seed(42)
    main()
