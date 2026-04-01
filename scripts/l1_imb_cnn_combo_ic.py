#!/usr/bin/env python3
"""
l1_imb_cnn_combo_ic.py — L1 Imbalance x Signal Agreement IC Study
====================================================================
HYPOTHESIS: L1 imbalance direction agreement with other signals boosts IC.
Specifically: when L1 imbalance z-score agrees in direction with
queue_fade + iceberg (the validated signal combo), does IC improve?

Also tests standalone L1 imbalance IC vs different thresholds and horizons.

Data: book_tensors.npz files in dl_book_cache
Signals computed purely from L1 order book depth (causal).

Output: l1_imb_combo_ic_results.json in home dir

This runs on Razer CPU only (no GPU needed, pure numpy).
"""
import glob
import json
import os
import sys
import time
from typing import List, Tuple

import numpy as np
from scipy import stats as scipy_stats
from scipy.ndimage import minimum_filter1d

DATA_DIR = r'C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache'
OUTPUT = r'C:\Users\claude\l1_imb_combo_ic_results.json'
LOG = r'C:\Users\claude\l1_imb_combo_ic.log'

TICK = 0.25
BAR_MS = 100
BARS_PER_SEC = 10
HORIZONS = [10, 30, 100, 300, 600]  # bars (1s, 3s, 10s, 30s, 60s)
HORIZONS_LABELS = ['1s', '3s', '10s', '30s', '60s']

F_DEPTH = 1
F_ORDERS = 2
F_AGE = 3

logf = open(LOG, 'w', buffering=1)

def log(msg):
    ts = time.strftime('%H:%M:%S')
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    logf.write(line + '\n')
    logf.flush()


def causal_rolling(arr: np.ndarray, w: int) -> np.ndarray:
    """Causal rolling mean via cumsum."""
    cs = np.cumsum(arr.astype(np.float64))
    out = np.zeros(len(arr), dtype=np.float32)
    out[w:] = (cs[w:] - cs[:-w]) / w
    out[:w] = cs[:w] / np.arange(1, w+1, dtype=np.float64)
    return out.astype(np.float32)


def causal_roll_min(arr: np.ndarray, w: int) -> np.ndarray:
    """Causal rolling min."""
    padded = np.concatenate([np.full(w-1, arr[0], dtype=np.float32), arr])
    filt = minimum_filter1d(padded, size=w, mode='nearest')
    return filt[w-1:]


def get_files(data_dir: str, max_days: int = 173) -> list:
    files = sorted(glob.glob(os.path.join(data_dir, '*_book_tensors.npz')))
    files = [f for f in files if 'signal' not in f and 'combined' not in f]
    return files[-max_days:]


def load_day(f: str):
    try:
        npz = np.load(f, allow_pickle=False)
        book = None
        for key in ['book_tensors', 'book', 'data', 'arr_0']:
            if key in npz:
                book = npz[key].astype(np.float32)
                break
        mid = None
        for key in ['mid_prices', 'mid_price', 'mid', 'close']:
            if key in npz:
                mid = npz[key].astype(np.float32)
                break
        if book is None or mid is None:
            return None
        if book.ndim != 3 or book.shape[1] != 20 or book.shape[2] != 4:
            return None
        return book, mid
    except Exception as e:
        return None


def compute_l1_features(book: np.ndarray, mid: np.ndarray) -> dict:
    """
    Compute L1 imbalance and related signals, all strictly causal.
    Returns dict of signal arrays.
    """
    N = len(mid)

    # L1 bid/ask depth
    bid_d = book[:, 0, F_DEPTH].astype(np.float32)
    ask_d = book[:, 10, F_DEPTH].astype(np.float32)

    # Raw L1 imbalance: (bid - ask) / (bid + ask)
    total = np.maximum(bid_d + ask_d, 1e-6)
    l1_imb = (bid_d - ask_d) / total  # range [-1, 1]

    # Causal z-score of L1 imbalance (10-bar and 50-bar)
    for w in [10, 50, 200]:
        pass  # computed below

    def causal_zscore(arr: np.ndarray, w: int) -> np.ndarray:
        mu = causal_rolling(arr, w)
        sq = causal_rolling(arr**2, w)
        var = np.maximum(sq - mu**2, 1e-10)
        std = np.sqrt(var)
        z = (arr - mu) / std
        z[:w] = 0.0
        return z.astype(np.float32)

    z10 = causal_zscore(l1_imb, 10)
    z50 = causal_zscore(l1_imb, 50)
    z200 = causal_zscore(l1_imb, 200)

    # L1 queue fade: rate of change of bid/ask depth
    bid_sm10 = causal_rolling(bid_d, 10)
    ask_sm10 = causal_rolling(ask_d, 10)
    bid_roc = np.zeros(N, dtype=np.float32)
    ask_roc = np.zeros(N, dtype=np.float32)
    bid_roc[1:] = bid_sm10[1:] - bid_sm10[:-1]
    ask_roc[1:] = ask_sm10[1:] - ask_sm10[:-1]
    bid_std = np.maximum(causal_rolling(np.abs(bid_roc), 50), 1e-6)
    ask_std = np.maximum(causal_rolling(np.abs(ask_roc), 50), 1e-6)
    bid_fade = -bid_roc / bid_std   # +bid fading = bullish pressure
    ask_fade = -ask_roc / ask_std   # +ask fading = bearish pressure

    # Iceberg detection
    bid_d_lag = np.empty_like(bid_d)
    bid_d_lag[0] = bid_d[0]
    bid_d_lag[1:] = bid_d[:-1]
    ask_d_lag = np.empty_like(ask_d)
    ask_d_lag[0] = ask_d[0]
    ask_d_lag[1:] = ask_d[:-1]

    w_ice = 20
    bid_roll_min = causal_roll_min(bid_d_lag, w_ice)
    ask_roll_min = causal_roll_min(ask_d_lag, w_ice)
    bid_roll_mean = causal_rolling(bid_d_lag, w_ice)
    ask_roll_mean = causal_rolling(ask_d_lag, w_ice)

    bid_replen = np.maximum(bid_d / np.maximum(bid_roll_min, 1.0) - 1.0, 0.0)
    ask_replen = np.maximum(ask_d / np.maximum(ask_roll_min, 1.0) - 1.0, 0.0)
    bid_ice = (bid_replen * (bid_d / np.maximum(bid_roll_mean, 1.0))).astype(np.float32)
    ask_ice = (ask_replen * (ask_d / np.maximum(ask_roll_mean, 1.0))).astype(np.float32)
    bid_ice[:w_ice] = 0.0
    ask_ice[:w_ice] = 0.0

    # Vol filter: causal expanding percentile
    mid_ret = np.zeros(N, dtype=np.float32)
    mid_ret[1:] = np.diff(mid.astype(np.float64)).astype(np.float32)
    vol = np.maximum(causal_rolling(np.abs(mid_ret), 300), 1e-8)

    # Causal 33rd percentile of vol (expanding, updated every 1000 bars)
    vol_pct33 = np.full(N, np.inf, dtype=np.float32)
    min_lb = 1500
    step = 1000
    cached = np.inf
    for i in range(min_lb, N):
        if (i - min_lb) % step == 0:
            cached = float(np.percentile(vol[300:i], 33))
        vol_pct33[i] = cached
    low_vol = (vol < vol_pct33).astype(np.float32)

    # Forward returns at each horizon
    fwd_returns = {}
    for h, label in zip(HORIZONS, HORIZONS_LABELS):
        ret = np.zeros(N, dtype=np.float32)
        ret[:-h] = (mid[h:] - mid[:-h]) / TICK  # in ticks
        fwd_returns[label] = ret

    return {
        'l1_imb': l1_imb,
        'z10': z10,
        'z50': z50,
        'z200': z200,
        'bid_fade': bid_fade,
        'ask_fade': ask_fade,
        'bid_ice': bid_ice,
        'ask_ice': ask_ice,
        'low_vol': low_vol,
        'fwd_returns': fwd_returns,
        'N': N,
    }


def compute_ic_for_signal(signal_vals: np.ndarray, fwd_ret: np.ndarray,
                           mask: np.ndarray = None) -> float:
    """Spearman IC between signal and forward returns."""
    if mask is not None:
        sv = signal_vals[mask]
        fr = fwd_ret[mask]
    else:
        sv = signal_vals
        fr = fwd_ret

    # Remove last HORIZONS[-1] bars (no fwd return)
    valid = np.isfinite(sv) & np.isfinite(fr) & (sv != 0)
    if valid.sum() < 30:
        return 0.0
    sv = sv[valid]
    fr = fr[valid]
    rho, _ = scipy_stats.spearmanr(sv, fr)
    return float(rho) if np.isfinite(rho) else 0.0


def run_study():
    log(f"L1 Imbalance x Signal IC Study")
    log(f"Data dir: {DATA_DIR}")

    files = get_files(DATA_DIR, 173)
    log(f"Found {len(files)} days")

    # Per-horizon accumulators for different signal combos
    horizons = HORIZONS_LABELS

    # Initialize accumulators
    # We test these signal definitions:
    # 1. Raw L1 imbalance
    # 2. L1 imb z-score (10-bar)
    # 3. L1 imb z-score (50-bar)
    # 4. L1 imb z-score (200-bar)
    # 5. Combo: l1_imb_z50 * (bid_fade or ask_fade agrees in direction)
    # 6. Combo: l1_imb_z50 * bid_ice/ask_ice direction agrees
    # 7. Combo: l1_imb_z50 * all signals agree (fade+iceberg)
    # 8. Low-vol gated versions of above combos

    signal_names = [
        'l1_imb_raw',
        'l1_imb_z10',
        'l1_imb_z50',
        'l1_imb_z200',
        'l1_z50_x_fade',           # z50 * fade direction agreement
        'l1_z50_x_ice',            # z50 * iceberg direction agreement
        'l1_z50_x_fade_ice',       # z50 * both agree
        'l1_z50_x_fade_lowvol',    # z50 * fade * low-vol gate
        'l1_z50_x_fade_ice_lowvol', # z50 * fade+ice * low-vol
    ]

    # Accumulators: per-signal, per-horizon: list of daily ICs
    daily_ics = {sig: {h: [] for h in horizons} for sig in signal_names}
    n_obs = {sig: {h: 0 for h in horizons} for sig in signal_names}

    t0 = time.time()
    valid_days = 0

    for fi, f in enumerate(files):
        day_data = load_day(f)
        if day_data is None:
            continue
        book, mid = day_data
        feats = compute_l1_features(book, mid)

        N = feats['N']
        fwd = feats['fwd_returns']
        low_vol = feats['low_vol']
        z10 = feats['z10']
        z50 = feats['z50']
        z200 = feats['z200']
        l1_imb = feats['l1_imb']
        bid_fade = feats['bid_fade']
        ask_fade = feats['ask_fade']
        bid_ice = feats['bid_ice']
        ask_ice = feats['ask_ice']

        # Build composite signals
        # fade_agree: when z50>0, bid_fade>0 (bid shrinking → bullish); when z50<0, ask_fade>0
        fade_dir = np.where(z50 > 0, bid_fade, ask_fade)  # positive = agreement
        ice_dir = np.where(z50 > 0, bid_ice, ask_ice)     # positive = agreement (bid ice = hidden buy)

        signals = {
            'l1_imb_raw': l1_imb,
            'l1_imb_z10': z10,
            'l1_imb_z50': z50,
            'l1_imb_z200': z200,
            'l1_z50_x_fade': z50 * np.maximum(fade_dir, 0),
            'l1_z50_x_ice': z50 * np.maximum(ice_dir, 0),
            'l1_z50_x_fade_ice': z50 * np.maximum(fade_dir, 0) * np.maximum(ice_dir, 0),
            'l1_z50_x_fade_lowvol': z50 * np.maximum(fade_dir, 0) * low_vol,
            'l1_z50_x_fade_ice_lowvol': z50 * np.maximum(fade_dir, 0) * np.maximum(ice_dir, 0) * low_vol,
        }

        # Compute IC per signal, per horizon (exclude last horizon bars for fwd return validity)
        max_h = max(HORIZONS)
        mask_valid = np.ones(N, dtype=bool)
        mask_valid[-max_h:] = False  # no valid fwd return in last max_h bars

        for sig_name, sig_arr in signals.items():
            for h, hlabel in zip(HORIZONS, horizons):
                # Only use first N-h bars for this horizon
                h_mask = mask_valid.copy()
                h_mask[-(h):] = False

                ic = compute_ic_for_signal(sig_arr, fwd[hlabel], h_mask)
                daily_ics[sig_name][hlabel].append(ic)
                n_obs[sig_name][hlabel] += int(h_mask.sum())

        valid_days += 1
        if fi % 10 == 0:
            elapsed = time.time() - t0
            log(f"  Day {fi+1}/{len(files)}: {valid_days} valid, {elapsed:.1f}s elapsed")

    log(f"\n=== RESULTS ({valid_days} days) ===")

    results = {
        'n_days': valid_days,
        'horizons': horizons,
        'signals': {}
    }

    for sig_name in signal_names:
        sig_results = {}
        best_sortino = -99
        best_h = None
        for h in horizons:
            ics = np.array(daily_ics[sig_name][h])
            if len(ics) == 0:
                continue
            mean_ic = float(np.mean(ics))
            std_ic = float(np.std(ics))
            ic_ir = mean_ic / std_ic if std_ic > 0 else 0.0
            pct_pos = float((ics > 0).mean())
            sig_results[h] = {
                'mean_ic': round(mean_ic, 5),
                'std_ic': round(std_ic, 5),
                'ic_ir': round(ic_ir, 3),
                'pct_pos_days': round(pct_pos, 3),
                'n_obs': n_obs[sig_name][h],
            }
            if ic_ir > best_sortino:
                best_sortino = ic_ir
                best_h = h

        results['signals'][sig_name] = {
            'best_horizon': best_h,
            'best_ic_ir': round(best_sortino, 3),
            'by_horizon': sig_results,
        }
        # Log summary
        if '10s' in sig_results:
            r = sig_results['10s']
            log(f"  {sig_name:35s} | 10s IC={r['mean_ic']:+.4f} IR={r['ic_ir']:.2f} pos%={r['pct_pos_days']:.2f}")

    # Save
    with open(OUTPUT, 'w') as f:
        json.dump(results, f, indent=2)
    log(f"\nSaved to {OUTPUT}")
    log(f"Total time: {time.time()-t0:.1f}s")
    logf.close()


if __name__ == '__main__':
    run_study()
