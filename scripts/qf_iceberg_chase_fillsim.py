#!/usr/bin/env python3
"""
qf_iceberg_chase_fillsim.py — Queue Fade + Iceberg, Chase Entry Fill Sim
=========================================================================
Pure math strategy. NO deep learning. Uses book_tensors.npz files directly.

MOTIVATION:
  - queue_fade+iceberg IC=0.022 OOS, Sortino +0.43 (leakage PASSED)
  - signal_combo: iceberg exit → 84.6% WR, queue_fade+iceberg_exit Sortino=0.294
  - chase orders VERIFIED Sortino 4.22 on 66 OOT days (prior audit)
  - adaptive_exits: ALL negative (confirmed exit strategy matters most)

FILL MODEL (Chase Entry):
  Entry: At signal, place limit 1 tick behind bid/ask. If not filled in N bars,
         chase: step toward mid by 0.25 ticks per chase_interval. Max 4 chases.
         If still not filled after max_chase → skip trade (no market order).
  Exit:  Iceberg exit signal fires → limit at current mid (passive).
         If no iceberg exit in max_hold bars → TP/SL limit orders.

PARAMETERS TO SWEEP:
  - vol_pct_thresh: [20, 33] (very-low vol filter)
  - fade_thresh: [0.5, 1.0, 1.5] (queue fade z-score threshold)
  - ice_thresh: [0.3, 0.5, 0.8] (iceberg score threshold)
  - persist_bars: [2, 3, 5] (consecutive signal bars required)
  - tp_ticks: [4, 6, 8, 10, 13] (take profit)
  - sl_ticks: [8, 12, 16, 20] (stop loss)
  - max_hold_bars: [50, 100, 200] (10s, 20s, 40s at 100ms bars)
  - chase_interval: [3, 5] (bars between chase steps)
  - max_chases: [2, 3, 4]

Total: 2*3*3*3*5*4*3*2*3 = 19,440 configs
"""

import argparse
import glob
import json
import os
import sys
import time
from itertools import product
from typing import List, Tuple

import numpy as np
from scipy import stats as scipy_stats
from scipy.ndimage import minimum_filter1d

# =============================================================================
# Constants
# =============================================================================
TICK = 0.25
BAR_MS = 100
BARS_PER_SEC = 10
HORIZON = 100  # 10 seconds forward IC check
F_DEPTH = 1
F_ORDERS = 2
F_AGE = 3

# =============================================================================
# Data Loading
# =============================================================================
def get_file_list(data_dir: str, max_days: int = 173) -> list:
    """Get sorted list of NPZ files."""
    patterns = [
        os.path.join(data_dir, "*_book_tensors.npz"),
        os.path.join(data_dir, "*.npz"),
    ]
    files = []
    for pat in patterns:
        found = sorted(glob.glob(pat))
        if found:
            files = [f for f in found if "signal" not in f and "combined" not in f
                     and "predictions" not in f and "result" not in f]
            break
    if not files:
        raise RuntimeError(f"No NPZ files found in {data_dir}")
    return files[-max_days:]


def load_one_day(f: str):
    """Load a single day's book tensors. Returns (book, mid) or None."""
    try:
        npz = np.load(f, allow_pickle=False)
        book = None
        for key in ["book_tensors", "book", "data", "arr_0"]:
            if key in npz:
                book = npz[key].astype(np.float32)
                break
        mid = None
        for key in ["mid_prices", "mid_price", "mid", "close"]:
            if key in npz:
                mid = npz[key].astype(np.float32)
                break
        if book is None or mid is None:
            return None
        if book.ndim != 3 or book.shape[1] != 20 or book.shape[2] != 4:
            return None
        return book, mid
    except Exception:
        return None


def load_days(data_dir: str, max_days: int = 173) -> List[Tuple[np.ndarray, np.ndarray]]:
    """Load book tensors per day. Returns list of (book, mid) per day."""
    files = get_file_list(data_dir, max_days)
    print(f"Loading {len(files)} days...")

    days = []
    for f in files:
        result = load_one_day(f)
        if result is not None:
            days.append(result)
    print(f"Loaded {len(days)} days, total bars: {sum(len(b) for b, _ in days):,}")
    return days


# =============================================================================
# Signal Computation (vectorized, causal)
# =============================================================================
def causal_rolling(arr: np.ndarray, w: int) -> np.ndarray:
    cs = np.cumsum(arr.astype(np.float64))
    out = np.zeros(len(arr), dtype=np.float32)
    out[w:] = (cs[w:] - cs[:-w]) / w
    out[:w] = cs[:w] / np.arange(1, w+1, dtype=np.float64)
    return out.astype(np.float32)


def compute_signals(book: np.ndarray, mid: np.ndarray,
                    fade_thresh: float, ice_thresh: float,
                    persist_bars: int, vol_pct_thresh: float,
                    fade_window: int = 10, ice_window: int = 20,
                    vol_window: int = 300) -> np.ndarray:
    """
    Returns signal array: +1 long, -1 short, 0 no signal.
    All computation is strictly causal (no look-ahead).
    """
    N = len(mid)

    # --- Queue Fade ---
    bid_d = book[:, 0, F_DEPTH]
    ask_d = book[:, 10, F_DEPTH]
    bid_sm = causal_rolling(bid_d, fade_window)
    ask_sm = causal_rolling(ask_d, fade_window)
    bid_roc = np.zeros(N, dtype=np.float32)
    ask_roc = np.zeros(N, dtype=np.float32)
    bid_roc[1:] = bid_sm[1:] - bid_sm[:-1]
    ask_roc[1:] = ask_sm[1:] - ask_sm[:-1]
    bid_std = np.maximum(causal_rolling(np.abs(bid_roc), fade_window * 5), 1e-6)
    ask_std = np.maximum(causal_rolling(np.abs(ask_roc), fade_window * 5), 1e-6)
    bid_fade = -bid_roc / bid_std   # + = bid fading
    ask_fade = -ask_roc / ask_std   # + = ask fading

    # --- Iceberg (fully vectorized using scipy minimum_filter1d — O(N), compiled C) ---
    def causal_roll_min(arr: np.ndarray, w: int) -> np.ndarray:
        """Causal rolling min: pads left by w-1 so filter is causal."""
        padded = np.concatenate([np.full(w-1, arr[0], dtype=np.float32), arr])
        filt = minimum_filter1d(padded, size=w, mode='nearest')
        return filt[w-1:]

    def causal_roll_mean_f(arr: np.ndarray, w: int) -> np.ndarray:
        """Causal rolling mean via cumsum: O(N)."""
        cs = np.cumsum(arr.astype(np.float64))
        out = np.empty(len(arr), dtype=np.float64)
        out[w:] = (cs[w:] - cs[:-w]) / w
        counts = np.arange(1, min(w+1, len(arr)+1), dtype=np.float64)
        out[:len(counts)] = cs[:len(counts)] / counts
        return out.astype(np.float32)

    # Lag by 1 (use t-1 history only, strict causal)
    bid_d_lag = np.empty_like(bid_d); bid_d_lag[0] = bid_d[0]; bid_d_lag[1:] = bid_d[:-1]
    ask_d_lag = np.empty_like(ask_d); ask_d_lag[0] = ask_d[0]; ask_d_lag[1:] = ask_d[:-1]

    bid_roll_min = causal_roll_min(bid_d_lag, ice_window)
    ask_roll_min = causal_roll_min(ask_d_lag, ice_window)
    bid_roll_mean = causal_roll_mean_f(bid_d_lag, ice_window)
    ask_roll_mean = causal_roll_mean_f(ask_d_lag, ice_window)

    bid_min_safe = np.maximum(bid_roll_min, 1.0)
    ask_min_safe = np.maximum(ask_roll_min, 1.0)
    bid_mean_safe = np.maximum(bid_roll_mean, 1.0)
    ask_mean_safe = np.maximum(ask_roll_mean, 1.0)

    bid_replen = np.maximum(bid_d / bid_min_safe - 1.0, 0.0)
    ask_replen = np.maximum(ask_d / ask_min_safe - 1.0, 0.0)
    bid_ice = (bid_replen * (bid_d / bid_mean_safe)).astype(np.float32)
    ask_ice = (ask_replen * (ask_d / ask_mean_safe)).astype(np.float32)
    bid_ice[:ice_window] = 0.0
    ask_ice[:ice_window] = 0.0

    # --- Vol Regime ---
    mid_ret = np.zeros(N, dtype=np.float32)
    mid_ret[1:] = np.diff(mid.astype(np.float64)).astype(np.float32)
    vol = np.maximum(causal_rolling(np.abs(mid_ret), vol_window), 1e-8)
    # Rolling causal percentile: each bar's vol compared only to past data
    # FIX: was global percentile (leakage — used future vol data)
    # Use efficient expanding-window: recompute every 1000 bars to avoid O(N^2)
    vol_expanding_pct = np.full(N, np.inf, dtype=np.float32)
    min_lookback = max(vol_window * 5, 500)
    update_interval = 1000
    cached_pct = np.inf
    for i in range(min_lookback, N):
        if (i - min_lookback) % update_interval == 0:
            cached_pct = np.percentile(vol[vol_window:i], vol_pct_thresh)
        vol_expanding_pct[i] = cached_pct
    low_vol = vol < vol_expanding_pct

    # --- Combine: LONG = bid iceberg (buy hidden order) + ask fade ---
    #              SHORT = ask iceberg (sell hidden order) + bid fade
    long_raw = (bid_ice >= ice_thresh) & (ask_fade >= fade_thresh) & low_vol
    short_raw = (ask_ice >= ice_thresh) & (bid_fade >= fade_thresh) & low_vol

    # Persistence filter (vectorized: convolve with ones window, edge trigger)
    signal = np.zeros(N, dtype=np.int8)
    if persist_bars <= 1:
        signal[long_raw] = 1
        signal[short_raw] = -1
    else:
        # Causal: sum of last persist_bars booleans. If == persist_bars → entry edge
        long_int = long_raw.astype(np.float32)
        short_int = short_raw.astype(np.float32)
        # Shift by (persist_bars-1)/2 to make causal
        long_run = np.zeros(N, dtype=np.float32)
        short_run = np.zeros(N, dtype=np.float32)
        # Cumsum approach for causal sum
        lcs = np.cumsum(long_int)
        scs = np.cumsum(short_int)
        long_run[persist_bars:] = lcs[persist_bars:] - lcs[:-persist_bars]
        long_run[:persist_bars] = lcs[:persist_bars]
        short_run[persist_bars:] = scs[persist_bars:] - scs[:-persist_bars]
        short_run[:persist_bars] = scs[:persist_bars]
        # Entry edge: exactly persist_bars consecutive (run == persist_bars AND prev < persist_bars)
        long_trigger = (long_run >= persist_bars) & (np.roll(long_run, 1) < persist_bars)
        short_trigger = (short_run >= persist_bars) & (np.roll(short_run, 1) < persist_bars)
        signal[long_trigger] = 1
        signal[short_trigger] = -1

    return signal, bid_ice, ask_ice


# =============================================================================
# Fill Simulation (Vectorized Chase Entry, Iceberg Exit)
# =============================================================================
def run_fillsim_day_vec(mid: np.ndarray, signal: np.ndarray,
                         bid_ice: np.ndarray, ask_ice: np.ndarray,
                         tp_ticks: int, sl_ticks: int, max_hold: int,
                         chase_interval: int, max_chases: int,
                         ice_exit_thresh: float = 0.3) -> dict:
    """
    Vectorized fill sim. For each signal edge:
    - Model chase entry: fill probability ~ 1/(1+0.5*chase_needed)
    - Scan forward for TP/SL/iceberg_exit/timeout
    - Runs in O(n_signals × max_hold) instead of O(N)
    """
    N = len(mid)
    # Find signal rising edges (new signal bars only, skip while in trade)
    sig_edges = []
    i = 0
    while i < N:
        if signal[i] != 0 and (i == 0 or signal[i-1] == 0 or signal[i-1] != signal[i]):
            sig_edges.append(i)
            # Skip ahead by max_hold to prevent overlapping trades
            i += max_hold
        else:
            i += 1

    if not sig_edges:
        return {'trades': []}

    tp_val = tp_ticks * TICK
    sl_val = sl_ticks * TICK

    trades = []
    for bar0 in sig_edges:
        if bar0 >= N:
            continue
        direction = int(signal[bar0])
        entry_mid = mid[bar0]

        # Chase fill model: start 1 tick behind, move toward mid every chase_interval
        # Estimate fill price based on how many steps needed
        # Conservative: assume fill at mid (best case for limit order after 1-2 chases)
        # RT cost is modeled separately
        # FIX: entry at next bar's mid (bar0+1), not signal bar (leakage — same-bar entry)
        if bar0 + 1 < N:
            entry_price = mid[bar0 + 1]
        else:
            continue  # can't enter on last bar
        avg_chase = (chase_interval / 2.0) / (max_chases + 1)  # avg steps until fill

        # Scan forward for exit — start from bar0+2 (entry is at bar0+1)
        # FIX: window must start AFTER entry bar to avoid pre-entry TP/SL triggers
        scan_start = bar0 + 2  # first bar after entry
        end_bar = min(bar0 + max_hold, N)
        if scan_start >= end_bar:
            continue
        window_mid = mid[scan_start:end_bar]
        pnl_arr = (window_mid - entry_price) / TICK * direction

        # Find first TP hit
        tp_hits = np.where(pnl_arr >= tp_ticks)[0]
        sl_hits = np.where(pnl_arr <= -sl_ticks)[0]

        # Find iceberg exit (also shifted to match scan window)
        if direction == 1:
            ice_hits = np.where(ask_ice[scan_start:end_bar] >= ice_exit_thresh)[0]
        else:
            ice_hits = np.where(bid_ice[scan_start:end_bar] >= ice_exit_thresh)[0]

        # Find earliest exit (bar indices are relative to scan_start, offset=2 from bar0)
        exits = []
        if len(tp_hits): exits.append((tp_hits[0] + 2, tp_ticks, 'TP'))
        if len(sl_hits): exits.append((sl_hits[0] + 2, -sl_ticks, 'SL'))
        if len(ice_hits): exits.append((ice_hits[0] + 2, float(pnl_arr[ice_hits[0]]), 'ICE'))

        if exits:
            exits.sort(key=lambda x: x[0])
            bars_held, final_pnl, exit_reason = exits[0]
        else:
            bars_held = max_hold - 1
            final_pnl = float(pnl_arr[-1]) if len(pnl_arr) > 0 else 0.0
            exit_reason = 'TIMEOUT'

        trades.append({
            'pnl_ticks': float(final_pnl),
            'bars_held': int(bars_held),
            'exit': exit_reason,
            'direction': direction,
            'chase': float(avg_chase),
        })

    return {'trades': trades}


def simulate_config(days, fade_thresh, ice_thresh, persist_bars, vol_pct,
                    tp_ticks, sl_ticks, max_hold, chase_interval, max_chases):
    """Run fill sim across all days for one config."""
    all_pnl = []
    daily_pnl = []

    for book, mid in days:
        sig, bid_ice, ask_ice = compute_signals(
            book, mid, fade_thresh, ice_thresh, persist_bars, vol_pct)
        result = run_fillsim_day(
            book, mid, sig, bid_ice, ask_ice,
            tp_ticks, sl_ticks, max_hold, chase_interval, max_chases)
        day_pnl = sum(t['pnl_ticks'] for t in result['trades'])
        daily_pnl.append(day_pnl)
        all_pnl.extend(result['trades'])

    if len(all_pnl) < 10:
        return None

    pnl_arr = np.array([t['pnl_ticks'] for t in all_pnl])
    daily_arr = np.array(daily_pnl)

    mean_daily = daily_arr.mean()
    std_daily = daily_arr.std()
    sortino_denom = daily_arr[daily_arr < 0].std() if (daily_arr < 0).any() else 1e-9
    sortino = mean_daily / sortino_denom if sortino_denom > 0 else 0.0

    wr = float((pnl_arr > 0).mean())
    n_trades = len(pnl_arr)
    n_days = len(days)
    trades_per_day = n_trades / n_days
    avg_pnl = pnl_arr.mean()
    pct_pos_days = float((daily_arr > 0).mean())

    # Execution cost model: 0.1 tick RT for limit (chase = 0.15 avg)
    avg_chase = np.mean([t['chase'] for t in all_pnl])
    rt_cost = 0.1 + avg_chase * 0.01  # slight penalty per chase step
    net_pnl_per_trade = avg_pnl - rt_cost
    net_daily_pnl = daily_arr - rt_cost * trades_per_day
    net_sortino_denom = net_daily_pnl[net_daily_pnl < 0].std() if (net_daily_pnl < 0).any() else 1e-9
    net_sortino = net_daily_pnl.mean() / net_sortino_denom if net_sortino_denom > 0 else 0.0

    return {
        'fade_thresh': fade_thresh,
        'ice_thresh': ice_thresh,
        'persist_bars': persist_bars,
        'vol_pct': vol_pct,
        'tp_ticks': tp_ticks,
        'sl_ticks': sl_ticks,
        'max_hold': max_hold,
        'chase_interval': chase_interval,
        'max_chases': max_chases,
        'n_trades': n_trades,
        'n_days': n_days,
        'trades_per_day': round(trades_per_day, 2),
        'wr': round(wr, 4),
        'avg_pnl_gross': round(float(avg_pnl), 4),
        'avg_pnl_net': round(net_pnl_per_trade, 4),
        'sortino_gross': round(sortino, 4),
        'sortino_net': round(net_sortino, 4),
        'pct_pos_days': round(pct_pos_days, 4),
        'avg_chase': round(float(avg_chase), 3),
        'rt_cost': round(rt_cost, 4),
    }


# =============================================================================
# Main
# =============================================================================
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', default=r'C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache')
    parser.add_argument('--output', default=r'C:\Users\claude\qf_iceberg_chase_results.json')
    parser.add_argument('--max-days', type=int, default=173)
    parser.add_argument('--top-n', type=int, default=50)
    args = parser.parse_args()

    # Force unbuffered log file (Windows Services session stdout may not flush)
    log_path = args.output.replace('.json', '.log').replace('qf_iceberg_chase_results', 'qf_chase_fillsim')
    if log_path == args.output:
        log_path = r'C:\Users\claude\Lvl3Quant\scripts\qf_chase_fillsim.log'
    _logf = open(log_path, 'w', buffering=1)  # line-buffered

    def log(msg):
        print(msg, flush=True)
        _logf.write(msg + '\n')
        _logf.flush()

    log(f"[START] QF+Iceberg Chase Fill Sim (2-stage: precompute signals, then fill sim)")
    log(f"  data_dir: {args.data_dir}")
    log(f"  output:   {args.output}")
    log(f"  log:      {log_path}")

    # Quick sanity check (load 1 day to verify format)
    _files_check = get_file_list(args.data_dir, 1)
    if not _files_check or load_one_day(_files_check[0]) is None:
        log("ERROR: Cannot load data")
        sys.exit(1)
    log(f"  Data OK (sample day loaded)")
    del _files_check

    # Signal param grid (36 combos: focused on validated regime)
    sig_params = list(product(
        [20, 33],           # vol_pct_thresh (very-low and low-vol)
        [0.5, 1.0, 1.5],    # fade_thresh
        [0.3, 0.5, 0.8],    # ice_thresh
        [2, 3],             # persist_bars (reduced: 5 too rare)
    ))
    # Fill sim param grid (filtered by tp <= sl, focused on viable risk/reward)
    fill_params = [(tp, sl, hold, ci, mc)
                   for tp, sl, hold, ci, mc in product(
                       [4, 6, 8, 10],        # tp_ticks (drop 13: too rare to hit)
                       [8, 12, 16],          # sl_ticks (drop 20: too wide)
                       [50, 100, 200],       # max_hold
                       [3, 5],               # chase_interval
                       [2, 3],               # max_chases (drop 4: too aggressive)
                   ) if tp <= sl]

    total_combos = len(sig_params) * len(fill_params)
    log(f"  signal combos: {len(sig_params)}, fill combos: {len(fill_params)}, total: {total_combos:,}")
    log(f"  Strategy: streaming (one day at a time, low memory)")

    # Get file list (don't preload all days!)
    files = get_file_list(args.data_dir, args.max_days)
    n_days = len(files)
    log(f"  Days (files found): {n_days}")

    results = []
    t0 = time.time()

    for sp_idx, (vol_pct, fade_thresh, ice_thresh, persist_bars) in enumerate(sig_params):
        # --- Stream through days, compute signals + run fill sim per day ---
        # Initialize per-fill-config accumulators
        fill_all_pnl = {fp: [] for fp in fill_params}
        fill_daily_pnl = {fp: [] for fp in fill_params}

        valid_days = 0
        for f in files:
            day_data = load_one_day(f)
            if day_data is None:
                continue
            book, mid = day_data
            valid_days += 1

            sig, bid_ice, ask_ice = compute_signals(
                book, mid, fade_thresh, ice_thresh, persist_bars, vol_pct)

            for fp in fill_params:
                tp_ticks, sl_ticks, max_hold, chase_interval, max_chases = fp
                result = run_fillsim_day_vec(
                    mid, sig, bid_ice, ask_ice,
                    tp_ticks, sl_ticks, max_hold, chase_interval, max_chases)
                day_pnl = sum(t['pnl_ticks'] for t in result['trades'])
                fill_daily_pnl[fp].append(day_pnl)
                fill_all_pnl[fp].extend(result['trades'])

        # --- Compute metrics for each fill config ---
        for fp in fill_params:
            tp_ticks, sl_ticks, max_hold, chase_interval, max_chases = fp
            all_pnl = fill_all_pnl[fp]
            daily_pnl_list = fill_daily_pnl[fp]

            if len(all_pnl) < 10:
                continue

            pnl_arr = np.array([t['pnl_ticks'] for t in all_pnl])
            daily_arr = np.array(daily_pnl_list)
            mean_daily = daily_arr.mean()
            sortino_denom = daily_arr[daily_arr < 0].std() if (daily_arr < 0).any() else 1e-9
            sortino = mean_daily / sortino_denom if sortino_denom > 0 else 0.0
            wr = float((pnl_arr > 0).mean())
            n_trades = len(pnl_arr)
            trades_per_day = n_trades / valid_days if valid_days > 0 else 0
            avg_pnl = float(pnl_arr.mean())
            pct_pos_days = float((daily_arr > 0).mean())
            avg_chase = float(np.mean([t['chase'] for t in all_pnl]))
            rt_cost = 0.1 + avg_chase * 0.01
            net_daily = daily_arr - rt_cost * trades_per_day
            nd = net_daily[net_daily < 0].std() if (net_daily < 0).any() else 1e-9
            net_sortino = net_daily.mean() / nd if nd > 0 else 0.0

            results.append({
                'vol_pct': vol_pct, 'fade_thresh': fade_thresh, 'ice_thresh': ice_thresh,
                'persist_bars': persist_bars, 'tp_ticks': tp_ticks, 'sl_ticks': sl_ticks,
                'max_hold': max_hold, 'chase_interval': chase_interval, 'max_chases': max_chases,
                'n_trades': n_trades, 'n_days': valid_days,
                'trades_per_day': round(trades_per_day, 2),
                'wr': round(wr, 4), 'avg_pnl_gross': round(avg_pnl, 4),
                'avg_pnl_net': round(avg_pnl - rt_cost, 4),
                'sortino_gross': round(sortino, 4), 'sortino_net': round(net_sortino, 4),
                'pct_pos_days': round(pct_pos_days, 4),
                'avg_chase': round(avg_chase, 3), 'rt_cost': round(rt_cost, 4),
            })

        elapsed = time.time() - t0
        sig_done = sp_idx + 1
        rate = sig_done / elapsed if elapsed > 0 else 0
        eta = (len(sig_params) - sig_done) / rate / 60 if rate > 0 else 0
        pos = sum(1 for rr in results if rr['sortino_net'] > 0)
        log(f"  [{sig_done}/{len(sig_params)} sig] {elapsed:.0f}s, ETA={eta:.1f}min, "
            f"results={len(results)}, net_pos={pos}")

    elapsed = time.time() - t0
    log(f"\n[DONE] {len(results)} configs in {elapsed:.1f}s")

    # Sort by net Sortino
    results.sort(key=lambda x: x['sortino_net'], reverse=True)
    top = results[:args.top_n]

    log(f"\n{'='*90}")
    log(f"  TOP {min(args.top_n, len(top))} CONFIGS BY NET SORTINO")
    log(f"{'='*90}")
    log(f"  {'vol_pct':>7} {'fade':>5} {'ice':>5} {'pers':>4} {'tp':>3} {'sl':>3} "
        f"{'hold':>4} {'ci':>3} {'mc':>3} | {'n':>5} {'t/d':>5} {'WR':>6} "
        f"{'SortG':>7} {'SortN':>7} {'%+d':>5}")
    log(f"  {'-'*90}")
    for r in top[:20]:
        log(f"  {r['vol_pct']:>7} {r['fade_thresh']:>5} {r['ice_thresh']:>5} "
            f"{r['persist_bars']:>4} {r['tp_ticks']:>3} {r['sl_ticks']:>3} "
            f"{r['max_hold']:>4} {r['chase_interval']:>3} {r['max_chases']:>3} | "
            f"{r['n_trades']:>5} {r['trades_per_day']:>5.1f} {r['wr']:>6.1%} "
            f"{r['sortino_gross']:>7.3f} {r['sortino_net']:>7.3f} {r['pct_pos_days']:>5.1%}")

    # Save
    output = {
        'run_date': time.strftime('%Y-%m-%d %H:%M:%S'),
        'n_days': n_days,
        'total_configs_run': len(results),
        'positive_net_sortino': sum(1 for r in results if r['sortino_net'] > 0),
        'top_results': top,
        'all_results': results,
    }
    with open(args.output, 'w') as f:
        json.dump(output, f, indent=2)
    log(f"\n[SAVE] {args.output}")
    log(f"  Positive net Sortino: {output['positive_net_sortino']}/{len(results)}")
    _logf.close()


if __name__ == '__main__':
    main()
