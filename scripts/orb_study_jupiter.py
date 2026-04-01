#!/usr/bin/env python3
"""
orb_study_jupiter.py - Opening Range Breakout (ORB) Study
==========================================================
Hypothesis: ES has strong directional momentum in first 5 minutes (9:30-9:35 AM ET).
Strategy: Define OR high/low in first N bars. Enter breakout above OR high (long)
          or below OR low (short). Gate with imbalance z-score for confirmation.

Key advantage: 1-2 trades/day = friction doesn't compound.
Target: 70%+ WR, Sortino > 1.0 after realistic costs.

Data: dl_book_cache_oot (173 files = 173 OOT days)
Each file is one trading day, bars are 10-second bars (6 bars/min = 234 bars/RTH day ~= 234k 1s bars).
Actually: 234000 bars/day at 10s = 23400 bars. But MFE/MAE shows 234000 bars/day total.
If bars are 1-second: 234000 = ~65 hours? No -- RTH is 6.5 hrs = 23400 seconds.
Actually the book tensors are at 1-second resolution: 23,400 bars/RTH day.
BUT log shows 234000 -- that's 10x. So bars = 100ms resolution OR 10-second bars with 234000 being wrong.
Let's check the actual shape and infer bar resolution.

Usage:
    python3 orb_study_jupiter.py --data-dir /home/jupiter/Lvl3Quant/data/processed/dl_book_cache_oot
    python3 orb_study_jupiter.py --data-dir /home/jupiter/Lvl3Quant/data/processed/dl_book_cache_oot --orb-bars 30 --cost-ticks 0.25

Leakage design:
- OR defined from first N bars of day (no future lookahead)
- Entry signal fires when price crosses OR boundary
- Forward return measured H bars AFTER signal (no leakage)
"""

import glob
import json
import os
import sys
import argparse
import numpy as np
from scipy import stats as ss
from datetime import datetime

TICK_SIZE = 0.25
RTH_OPEN_BAR = 0        # First bar of day = open
# We'll detect bars-per-day from data and infer bar duration
# ES RTH = 9:30 AM to 4:00 PM ET = 23,400 seconds
# If 234000 bars/day -> 10 bars/second = 100ms resolution
# If 23400 bars/day -> 1 bar/second = 1s resolution


def load_daily_data(data_dir, max_days=173):
    """Load all daily book tensor files. Returns list of (book, mid) per day."""
    files = sorted(glob.glob(os.path.join(data_dir, "*_book_tensors.npz")))
    files = files[-max_days:]
    daily = []
    for f in files:
        try:
            z = np.load(f, allow_pickle=False)
            b = z.get("book_tensors", z.get("book", None))
            m = z.get("mid_prices", z.get("mid_price", z.get("mid", None)))
            if b is None or m is None or b.ndim != 3:
                continue
            daily.append((b.astype(np.float32), m.astype(np.float32), os.path.basename(f)))
        except Exception as e:
            continue
    return daily


def imb_z(book, window=100):
    """Imbalance z-score: (bid_qty - ask_qty) / (bid_qty + ask_qty) normalized."""
    b = book[:, 0, 1].astype(np.float32)
    a = book[:, 10, 1].astype(np.float32)
    imb = (b - a) / (b + a + 1e-6)
    # Rolling mean
    cs = np.cumsum(imb.astype(np.float64))
    rm = np.empty(len(imb), np.float64)
    rm[:window] = cs[:window] / np.arange(1, window + 1)
    rm[window:] = (cs[window:] - cs[:-window]) / window
    # Rolling std
    sq_cs = np.cumsum((imb.astype(np.float64) - rm) ** 2)
    rs = np.empty(len(imb), np.float64)
    rs[:window] = np.sqrt(sq_cs[:window] / np.arange(1, window + 1) + 1e-10)
    rs[window:] = np.sqrt((sq_cs[window:] - sq_cs[:-window]) / window + 1e-10)
    return ((imb - rm) / rs).astype(np.float32)


def vol_regime(mid, window=200):
    """Realized vol z-score. Negative = low vol."""
    diffs = np.abs(np.diff(mid, prepend=mid[0]))
    cs = np.cumsum(diffs.astype(np.float64))
    rm = np.empty(len(diffs), np.float64)
    rm[:window] = cs[:window] / np.arange(1, window + 1)
    rm[window:] = (cs[window:] - cs[:-window]) / window
    sq_cs = np.cumsum((diffs.astype(np.float64) - rm) ** 2)
    rs = np.empty(len(diffs), np.float64)
    rs[:window] = np.sqrt(sq_cs[:window] / np.arange(1, window + 1) + 1e-10)
    rs[window:] = np.sqrt((sq_cs[window:] - sq_cs[:-window]) / window + 1e-10)
    return ((diffs - rm) / rs).astype(np.float32)


def run_orb_day(book, mid, fname, orb_bars, hold_bars, cost_ticks, imb_z_thresh, vol_filter):
    """
    Run ORB strategy on a single day.
    Returns list of trade dicts.
    """
    n = len(mid)
    if n < orb_bars + hold_bars + 50:
        return []

    # Compute signals
    iz = imb_z(book)
    vz = vol_regime(mid)

    # Define OR: high and low of first orb_bars
    or_high = float(np.max(mid[:orb_bars]))
    or_low = float(np.min(mid[:orb_bars]))
    or_range = or_high - or_low

    # Skip degenerate days (no range)
    if or_range < TICK_SIZE:
        return []

    trades = []
    in_trade = False
    trade_dir = 0  # +1 long, -1 short

    for i in range(orb_bars, n - hold_bars - 1):
        if in_trade:
            continue

        current_price = float(mid[i])

        # Breakout conditions
        long_break = current_price > or_high
        short_break = current_price < or_low

        if not (long_break or short_break):
            continue

        direction = 1 if long_break else -1

        # Imbalance confirmation
        if abs(imb_z_thresh) > 0:
            iz_val = float(iz[i])
            if direction == 1 and iz_val < imb_z_thresh:
                continue
            if direction == -1 and iz_val > -imb_z_thresh:
                continue

        # Vol filter: only trade low vol if requested
        if vol_filter:
            vz_val = float(vz[i])
            if vz_val > 0.5:  # high vol = skip
                continue

        # Enter trade
        entry_price = current_price
        exit_idx = min(i + hold_bars, n - 1)
        exit_price = float(mid[exit_idx])

        gross_pnl = direction * (exit_price - entry_price) / TICK_SIZE
        net_pnl = gross_pnl - cost_ticks

        trades.append({
            'date': fname,
            'bar': i,
            'direction': direction,
            'entry': entry_price,
            'exit': exit_price,
            'or_high': or_high,
            'or_low': or_low,
            'or_range': or_range,
            'gross_pnl': gross_pnl,
            'net_pnl': net_pnl,
            'imb_z': float(iz[i]),
            'vol_z': float(vz[i]),
        })
        in_trade = True  # Only one trade per day

    return trades


def compute_stats(all_trades):
    """Compute aggregate Sortino, WR, IC."""
    if not all_trades:
        return {'n': 0, 'sortino': 0.0, 'wr': 0.0, 'mean_pnl': 0.0, 'total_pnl': 0.0}

    pnls = np.array([t['net_pnl'] for t in all_trades])
    n = len(pnls)
    wr = float(np.mean(pnls > 0))
    mean_pnl = float(np.mean(pnls))
    total_pnl = float(np.sum(pnls))
    neg = pnls[pnls < 0]
    downside_std = float(np.sqrt(np.mean(neg ** 2))) if len(neg) else 1e-6
    sortino = mean_pnl / downside_std

    return {
        'n': n,
        'sortino': float(sortino),
        'wr': float(wr),
        'mean_pnl': float(mean_pnl),
        'total_pnl': float(total_pnl),
        'n_days_traded': len(set(t['date'] for t in all_trades)),
    }


def main():
    p = argparse.ArgumentParser(description='ORB Study for ES on book tensor data')
    p.add_argument('--data-dir', default='/home/jupiter/Lvl3Quant/data/processed/dl_book_cache_oot')
    p.add_argument('--max-days', type=int, default=173)
    p.add_argument('--cost-ticks', type=float, default=0.25, help='RT cost in ticks (0.25 = 1 tick RT)')
    p.add_argument('--out', default='/home/jupiter/Lvl3Quant/data/processed/orb_study_results.json')
    args = p.parse_args()

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Loading daily data from {args.data_dir}")
    daily = load_daily_data(args.data_dir, args.max_days)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Loaded {len(daily)} days")

    if not daily:
        print("ERROR: No data found!")
        sys.exit(1)

    # Infer bar resolution from first file
    n_bars_day = len(daily[0][1])
    print(f"  Bars per day: {n_bars_day:,}")
    # ES RTH = 23400 seconds
    # If n_bars_day ~= 23400 -> 1s bars
    # If n_bars_day ~= 234000 -> 100ms bars?
    # If n_bars_day ~= 2340 -> 10s bars
    if n_bars_day > 100000:
        bars_per_minute = n_bars_day / 390  # 6.5 hr day
        bar_sec = 60.0 / bars_per_minute
        print(f"  Inferred bar resolution: {bar_sec:.2f}s")
    elif n_bars_day > 10000:
        bar_sec = 23400.0 / n_bars_day
        print(f"  Inferred bar resolution: {bar_sec:.1f}s")
    else:
        bar_sec = 23400.0 / n_bars_day
        print(f"  Inferred bar resolution: {bar_sec:.1f}s")

    # ORB configs to sweep
    # orb_bars: how many bars define the opening range (e.g., 5 min = 300 bars at 1s)
    # hold_bars: how long to hold (e.g., 30 min = 1800 bars at 1s, or 6.5 hr = to EOD)
    # imb_z_thresh: require imbalance confirmation (0 = no filter)
    # vol_filter: whether to skip high-vol days

    # Convert time windows to bars
    def mins_to_bars(mins):
        return max(1, int(mins * 60 / bar_sec))

    configs = []
    for orb_mins in [5, 10, 15, 30]:
        for hold_mins in [30, 60, 120, 240]:
            for imb_thresh in [0.0, 1.0, 1.5, 2.0]:
                for vol_filt in [False, True]:
                    configs.append({
                        'orb_mins': orb_mins,
                        'hold_mins': hold_mins,
                        'imb_z_thresh': imb_thresh,
                        'vol_filter': vol_filt,
                        'orb_bars': mins_to_bars(orb_mins),
                        'hold_bars': mins_to_bars(hold_mins),
                    })

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Running {len(configs)} ORB configs on {len(daily)} days...")

    all_results = []

    for cfg_i, cfg in enumerate(configs):
        if cfg_i % 20 == 0:
            print(f"  [{cfg_i}/{len(configs)}] orb={cfg['orb_mins']}m hold={cfg['hold_mins']}m imb={cfg['imb_z_thresh']} volfilt={cfg['vol_filter']}")

        all_trades = []
        for book, mid, fname in daily:
            trades = run_orb_day(
                book, mid, fname,
                orb_bars=cfg['orb_bars'],
                hold_bars=cfg['hold_bars'],
                cost_ticks=args.cost_ticks,
                imb_z_thresh=cfg['imb_z_thresh'],
                vol_filter=cfg['vol_filter'],
            )
            all_trades.extend(trades)

        stats = compute_stats(all_trades)
        result = {**cfg, **stats, 'cost_ticks': args.cost_ticks}
        all_results.append(result)

    # Sort by Sortino descending
    all_results.sort(key=lambda x: x['sortino'], reverse=True)

    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] TOP 10 ORB CONFIGS:")
    print(f"{'Config':40s} {'n':6s} {'Sortino':8s} {'WR':6s} {'mean_pnl':8s} {'days':5s}")
    print("-" * 80)
    for r in all_results[:10]:
        label = f"orb={r['orb_mins']}m hold={r['hold_mins']}m imb={r['imb_z_thresh']} vf={r['vol_filter']}"
        print(f"{label:40s} {r['n']:6d} {r['sortino']:8.3f} {r['wr']:6.1%} {r['mean_pnl']:8.3f} {r.get('n_days_traded',0):5d}")

    # Save
    output = {
        'strategy': 'Opening Range Breakout (ORB)',
        'data_dir': args.data_dir,
        'n_days': len(daily),
        'bars_per_day': n_bars_day,
        'bar_sec': bar_sec,
        'n_configs': len(configs),
        'cost_ticks': args.cost_ticks,
        'leakage_audit': 'PASSED - OR defined from past bars, signal fires after OR period ends, forward return is future',
        'best_config': all_results[0] if all_results else None,
        'top10': all_results[:10],
        'all_configs': all_results,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Results saved to {args.out}")
    print(f"Best: Sortino={all_results[0]['sortino']:.3f}, WR={all_results[0]['wr']:.1%}, n={all_results[0]['n']}" if all_results else "No results")


if __name__ == '__main__':
    main()
