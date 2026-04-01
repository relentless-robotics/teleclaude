#!/usr/bin/env python3
"""
Wider CNN Walkforward - Raw IC (Information Coefficient) Analysis
Computes Spearman rank correlation between model predictions and
actual forward price moves at multiple horizons.
"""

import numpy as np
from scipy import stats
from collections import defaultdict
import os
import json
import warnings
warnings.filterwarnings('ignore')

PRED_DIR = '/home/jupiter/Lvl3Quant/data/processed/wider_cnn_preds'

def spearman_ic(preds, targets):
    mask = np.isfinite(preds) & np.isfinite(targets) & (preds != 0)
    n = mask.sum()
    if n < 100:
        return np.nan, 0
    ic = stats.spearmanr(preds[mask], targets[mask])[0]
    return ic, n

def analyze_insample():
    fname = os.path.join(PRED_DIR, 'oos_predictions_wider_cnn_20260316_234421.npz')
    if not os.path.exists(fname):
        print("In-sample file not found!")
        return {}

    d = np.load(fname, allow_pickle=True)
    keys = list(d.keys())
    dates = sorted(set(k.replace('_preds','').replace('_targets','') for k in keys))

    results = []
    for date in dates:
        pk, tk = f'{date}_preds', f'{date}_targets'
        if pk in d and tk in d:
            ic, n = spearman_ic(d[pk], d[tk])
            results.append({'date': date, 'ic': float(ic) if not np.isnan(ic) else None, 'n': int(n)})

    ics = [r['ic'] for r in results if r['ic'] is not None]
    summary = {
        'type': 'in_sample_oos',
        'date_range': f"{dates[0]} to {dates[-1]}",
        'n_dates': len(dates),
        'mean_ic': float(np.mean(ics)),
        'median_ic': float(np.median(ics)),
        'std_ic': float(np.std(ics)),
        'icir': float(np.mean(ics) / np.std(ics)) if np.std(ics) > 0 else 0,
        'pct_positive': float(sum(1 for x in ics if x > 0) / len(ics) * 100),
        'min_ic': float(min(ics)),
        'max_ic': float(max(ics)),
        'daily': results
    }
    return summary

def analyze_oot():
    fname = os.path.join(PRED_DIR, 'oos_predictions_wider_cnn_oot_20260311_092055.npz')
    if not os.path.exists(fname):
        print("OOT file not found!")
        return {}

    d = np.load(fname, allow_pickle=True)
    keys = list(d.keys())
    dates = sorted(set(k.replace('_preds','').replace('_mid','') for k in keys))

    horizons = {
        '10s': 1, '30s': 3, '1min': 6, '5min': 30,
        '10min': 60, '17min': 100, '30min': 180
    }

    horizon_results = {h: [] for h in horizons}

    for date in dates:
        pk, mk = f'{date}_preds', f'{date}_mid'
        if pk not in d or mk not in d:
            continue
        preds = d[pk]
        mid = d[mk]

        for hname, hbars in horizons.items():
            fwd = np.full_like(mid, np.nan)
            if hbars < len(mid):
                fwd[:-hbars] = (mid[hbars:] - mid[:-hbars]) / mid[:-hbars] * 10000
            ic, n = spearman_ic(preds, fwd)
            horizon_results[hname].append({
                'date': date,
                'ic': float(ic) if not np.isnan(ic) else None,
                'n': int(n)
            })

    horizon_summary = {}
    for hname in horizons:
        ics = [r['ic'] for r in horizon_results[hname] if r['ic'] is not None]
        if not ics:
            continue
        horizon_summary[hname] = {
            'mean_ic': float(np.mean(ics)),
            'median_ic': float(np.median(ics)),
            'std_ic': float(np.std(ics)),
            'icir': float(np.mean(ics) / np.std(ics)) if np.std(ics) > 0 else 0,
            'pct_positive': float(sum(1 for x in ics if x > 0) / len(ics) * 100),
            'min_ic': float(min(ics)),
            'max_ic': float(max(ics)),
            'n_dates': len(ics)
        }

    # Quintile analysis at 100-bar horizon
    quintile_returns = defaultdict(list)
    for date in dates:
        pk, mk = f'{date}_preds', f'{date}_mid'
        if pk not in d or mk not in d:
            continue
        preds = d[pk]
        mid = d[mk]
        fwd = np.full_like(mid, np.nan)
        fwd[:-100] = (mid[100:] - mid[:-100]) / mid[:-100] * 10000

        mask = np.isfinite(fwd) & (preds != 0)
        if mask.sum() < 1000:
            continue
        p_valid = preds[mask]
        f_valid = fwd[mask]

        quintiles = np.percentile(p_valid, [20, 40, 60, 80])
        for q in range(5):
            if q == 0:
                qmask = p_valid <= quintiles[0]
            elif q == 4:
                qmask = p_valid > quintiles[3]
            else:
                qmask = (p_valid > quintiles[q-1]) & (p_valid <= quintiles[q])
            quintile_returns[f'Q{q+1}'].extend(f_valid[qmask].tolist())

    quintile_summary = {}
    for q in range(1, 6):
        key = f'Q{q}'
        vals = quintile_returns[key]
        quintile_summary[key] = {
            'mean_return_bps': float(np.mean(vals)),
            'median_return_bps': float(np.median(vals)),
            'count': len(vals)
        }

    ls_spread = np.mean(quintile_returns['Q5']) - np.mean(quintile_returns['Q1'])

    summary = {
        'type': 'out_of_time',
        'date_range': f"{dates[0]} to {dates[-1]}",
        'n_dates': len(dates),
        'horizons': horizon_summary,
        'quintile_analysis_17min': quintile_summary,
        'long_short_spread_bps': float(ls_spread),
        'annualized_spread_bps': float(ls_spread * 23 * 252),
        'daily_10s': horizon_results['10s'],
        'daily_17min': horizon_results['17min']
    }
    return summary

if __name__ == '__main__':
    print("=" * 80)
    print("WIDER CNN WALKFORWARD - RAW IC ANALYSIS")
    print("=" * 80)

    insample = analyze_insample()
    if insample:
        print(f"\n--- IN-SAMPLE OOS ({insample['date_range']}, {insample['n_dates']} dates) ---")
        print(f"Mean IC: {insample['mean_ic']:.4f} | Median: {insample['median_ic']:.4f} | ICIR: {insample['icir']:.2f}")
        print(f"IC > 0: {insample['pct_positive']:.0f}% | Range: [{insample['min_ic']:.4f}, {insample['max_ic']:.4f}]")

    oot = analyze_oot()
    if oot:
        print(f"\n--- OUT-OF-TIME ({oot['date_range']}, {oot['n_dates']} dates) ---")
        print(f"\n{'Horizon':>10}  {'Mean IC':>8}  {'ICIR':>6}  {'IC>0%':>6}")
        print("-" * 40)
        for h, s in oot['horizons'].items():
            print(f"{h:>10}  {s['mean_ic']:>8.4f}  {s['icir']:>6.2f}  {s['pct_positive']:>5.0f}%")

        print(f"\nQuintile Analysis (17min horizon):")
        for q in range(1, 6):
            qs = oot['quintile_analysis_17min'][f'Q{q}']
            print(f"  Q{q}: {qs['mean_return_bps']:>+8.4f} bps (n={qs['count']:,})")
        print(f"  L/S spread: {oot['long_short_spread_bps']:.4f} bps/bar = {oot['annualized_spread_bps']:.0f} bps/yr")

    output = {'insample': insample, 'oot': oot}
    outpath = os.path.join(PRED_DIR, 'ic_analysis_results.json')
    with open(outpath, 'w') as f:
        json.dump(output, f, indent=2, default=str)
    print(f"\nResults saved to {outpath}")
