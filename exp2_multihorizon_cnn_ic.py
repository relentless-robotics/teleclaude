#!/usr/bin/env python3
"""
Experiment 2: Multi-Horizon CNN IC Test
========================================
Question: Does the CNN signal predict 20s/30s/60s returns differently than 10s?
Specifically: does IC decay gracefully (useful for wider TP levels) or cliff-drop?

Data:
  - CNN predictions: oot_wf_predictions_incremental.npz (Dec 2025 - Mar 2026, 67 days)
    keys: '2025-12-01_preds', shape (234000,)
  - Book tensors: dl_book_cache_oot/*.npz (same period)
    keys: 'mid_prices', 'book_tensors', 'timestamps'

Horizons: 10s (100 bars), 20s (200), 30s (300), 60s (600), 120s (1200), 5min (3000)
Metrics:
  - Spearman IC per horizon
  - IC decay ratio vs 10s
  - Per-day IC mean/std/% positive
  - Top/bottom quintile return at each horizon (edge sharpness)

Output: C:\\Users\\claude\\Lvl3Quant\\scripts\\exp2_multihorizon_ic_results.json
        C:\\Users\\claude\\Lvl3Quant\\scripts\\exp2_multihorizon_ic_output.log
"""

import os
import sys
import glob
import json
import time
import warnings
import numpy as np
from datetime import datetime

warnings.filterwarnings("ignore")

# ─── Setup ───────────────────────────────────────────────────────────────────
LOG_FILE = r'C:\Users\claude\Lvl3Quant\scripts\exp2_multihorizon_ic_output.log'
ERR_FILE = r'C:\Users\claude\Lvl3Quant\scripts\exp2_multihorizon_ic_stderr.log'
OUT_JSON = r'C:\Users\claude\Lvl3Quant\scripts\exp2_multihorizon_ic_results.json'

def log(msg):
    ts = datetime.now().strftime('%H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line, flush=True)

log("=" * 60)
log("Experiment 2: Multi-Horizon CNN IC Test")
log("=" * 60)

from scipy.stats import spearmanr

# ─── Config ──────────────────────────────────────────────────────────────────
CNN_PREDS_FILE = r'C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models\results\oot_wf_predictions_incremental.npz'
BOOK_CACHE_OOT = r'C:\Users\claude\Documents\Lvl3Quant\data\processed\dl_book_cache_oot'
TICK_SIZE      = 0.25

# Horizons to test: (label, forward_bars)
HORIZONS = [
    ("10s",  100),
    ("20s",  200),
    ("30s",  300),
    ("60s",  600),
    ("120s", 1200),
    ("5min", 3000),
]

SUBSAMPLE = 5  # Use every 5th bar to reduce memory


# ─── Load CNN Predictions ────────────────────────────────────────────────────

def load_cnn_preds():
    """Load all CNN OOT predictions. Returns dict: date_str -> np.array (234000,)"""
    log(f"Loading CNN predictions from: {CNN_PREDS_FILE}")
    d = np.load(CNN_PREDS_FILE, allow_pickle=True)
    ks = list(d.keys())
    preds_keys = sorted([k for k in ks if k.endswith('_preds')])
    log(f"  Found {len(preds_keys)} dates: {preds_keys[0][:10]} to {preds_keys[-1][:10]}")

    preds_dict = {}
    for k in preds_keys:
        date_str = k[:10]
        preds_dict[date_str] = d[k].astype(np.float32)
    return preds_dict


# ─── Load Book Tensors ────────────────────────────────────────────────────────

def load_book_files():
    """Returns dict: date_str -> file_path"""
    files = sorted(glob.glob(os.path.join(BOOK_CACHE_OOT, "*_book_tensors.npz")))
    book_dict = {}
    for f in files:
        date_str = os.path.basename(f)[:10]
        book_dict[date_str] = f
    log(f"Found {len(book_dict)} book tensor files")
    return book_dict


# ─── Target computation ───────────────────────────────────────────────────────

def compute_multi_horizon_targets(mid: np.ndarray) -> dict:
    """
    Compute signed returns at multiple horizons.
    Returns: dict horizon_label -> np.array (N,) in ticks
    """
    N = len(mid)
    targets = {}
    for label, fwd in HORIZONS:
        t = np.full(N, np.nan, dtype=np.float32)
        t[:N-fwd] = (mid[fwd:] - mid[:N-fwd]) / TICK_SIZE
        targets[label] = t
    return targets


# ─── Per-day IC computation ───────────────────────────────────────────────────

def compute_ic_for_day(preds: np.ndarray, mid: np.ndarray, date_str: str) -> dict:
    """
    Compute IC between CNN preds and multi-horizon returns for one day.
    Returns: dict with IC for each horizon.
    """
    N = min(len(preds), len(mid))
    preds = preds[:N]
    mid = mid[:N]

    # Subsample to reduce noise / memory
    idx = np.arange(0, N, SUBSAMPLE)
    preds_sub = preds[idx]

    # Compute targets
    targets = compute_multi_horizon_targets(mid)

    result = {"date": date_str}
    for label, fwd in HORIZONS:
        t = targets[label][idx]
        # Valid indices (not nan and CNN pred is finite)
        valid = ~np.isnan(t) & np.isfinite(preds_sub)
        n_valid = valid.sum()
        if n_valid < 500:
            result[f"ic_{label}"] = None
            result[f"n_{label}"] = int(n_valid)
            continue

        ic, pval = spearmanr(preds_sub[valid], t[valid])
        result[f"ic_{label}"] = float(ic)
        result[f"n_{label}"] = int(n_valid)

        # Quintile analysis for 10s and 60s
        if label in ("10s", "60s", "120s"):
            p_valid = preds_sub[valid]
            t_valid = t[valid]
            q_bins = np.percentile(p_valid, [0, 20, 40, 60, 80, 100])
            q_rets = []
            for qi in range(5):
                q_mask = (p_valid >= q_bins[qi]) & (p_valid < q_bins[qi+1])
                if q_mask.sum() >= 50:
                    q_rets.append(float(t_valid[q_mask].mean()))
                else:
                    q_rets.append(None)
            result[f"quintile_rets_{label}"] = q_rets

    return result


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    start_time = time.time()
    log(f"START: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # Load data
    preds_dict = load_cnn_preds()
    book_dict  = load_book_files()

    # Find overlapping dates
    common_dates = sorted(set(preds_dict.keys()) & set(book_dict.keys()))
    log(f"Overlapping dates: {len(common_dates)} | {common_dates[0]} to {common_dates[-1]}")

    if len(common_dates) == 0:
        log("ERROR: No common dates between CNN preds and book data!")
        sys.exit(1)

    # Process each day
    daily_results = []
    for date_str in common_dates:
        try:
            # Load book
            d = np.load(book_dict[date_str], allow_pickle=True)
            mid = d["mid_prices"].astype(np.float64)
            preds = preds_dict[date_str]

            day_result = compute_ic_for_day(preds, mid, date_str)
            daily_results.append(day_result)

            # Log progress every 5 days
            if len(daily_results) % 5 == 0 or len(daily_results) <= 3:
                ic_10s = day_result.get("ic_10s")
                ic_60s = day_result.get("ic_60s")
                ic_10s_str = f"{ic_10s:.4f}" if ic_10s is not None else "N/A"
                ic_60s_str = f"{ic_60s:.4f}" if ic_60s is not None else "N/A"
                log(f"  {date_str}: IC_10s={ic_10s_str}, IC_60s={ic_60s_str}")

        except Exception as e:
            log(f"  WARN: {date_str} failed: {e}")
            continue

    log(f"\nProcessed {len(daily_results)} days")

    # Aggregate results per horizon
    log("\n=== Multi-Horizon IC Summary ===")
    horizon_summary = {}
    for label, _ in HORIZONS:
        ic_key = f"ic_{label}"
        ics = [r[ic_key] for r in daily_results if r.get(ic_key) is not None]
        if not ics:
            log(f"  {label}: NO DATA")
            continue
        ics = np.array(ics)
        horizon_summary[label] = {
            "ic_mean": float(ics.mean()),
            "ic_std": float(ics.std()),
            "ic_median": float(np.median(ics)),
            "ic_pct_positive": float((ics > 0).mean()),
            "n_days": int(len(ics)),
            "ic_min": float(ics.min()),
            "ic_max": float(ics.max()),
        }
        log(f"  {label:5s}: mean={ics.mean():.4f} ± {ics.std():.4f} | "
            f"median={np.median(ics):.4f} | "
            f"pct+={( ics > 0).mean()*100:.1f}% ({len(ics)} days)")

    # IC decay ratios
    log("\n=== IC Decay Ratios (vs 10s) ===")
    if "10s" in horizon_summary:
        base_ic = horizon_summary["10s"]["ic_mean"]
        for label in [h[0] for h in HORIZONS[1:]]:
            if label in horizon_summary:
                ratio = horizon_summary[label]["ic_mean"] / (base_ic + 1e-8)
                log(f"  {label:5s}: {ratio:.3f}x 10s IC")
                horizon_summary[label]["decay_ratio_vs_10s"] = float(ratio)

    # Quintile analysis for 10s
    log("\n=== Quintile Analysis (10s horizon) ===")
    q10_all = [r.get("quintile_rets_10s") for r in daily_results if r.get("quintile_rets_10s")]
    if q10_all:
        q10_mean = np.nanmean(q10_all, axis=0)
        log(f"  Q1(bot 20%): {q10_mean[0]:.3f}t | Q3(mid): {q10_mean[2]:.3f}t | Q5(top 20%): {q10_mean[4]:.3f}t")
        log(f"  Q5 - Q1 spread: {q10_mean[4] - q10_mean[0]:.3f} ticks")
        horizon_summary["10s"]["quintile_mean_rets"] = q10_mean.tolist()

    log("\n=== Quintile Analysis (60s horizon) ===")
    q60_all = [r.get("quintile_rets_60s") for r in daily_results if r.get("quintile_rets_60s")]
    if q60_all:
        q60_mean = np.nanmean(q60_all, axis=0)
        log(f"  Q1(bot 20%): {q60_mean[0]:.3f}t | Q3(mid): {q60_mean[2]:.3f}t | Q5(top 20%): {q60_mean[4]:.3f}t")
        log(f"  Q5 - Q1 spread: {q60_mean[4] - q60_mean[0]:.3f} ticks")
        horizon_summary["60s"]["quintile_mean_rets"] = q60_mean.tolist()

    # Save results
    results = {
        "experiment": "exp2_multihorizon_cnn_ic",
        "timestamp": datetime.now().isoformat(),
        "config": {
            "cnn_preds_file": CNN_PREDS_FILE,
            "book_cache_dir": BOOK_CACHE_OOT,
            "n_dates": len(common_dates),
            "date_range": f"{common_dates[0]} to {common_dates[-1]}",
            "subsample": SUBSAMPLE,
            "horizons": {label: fwd for label, fwd in HORIZONS},
        },
        "horizon_summary": horizon_summary,
        "daily_results": daily_results,
        "total_elapsed": float(time.time() - start_time),
    }

    with open(OUT_JSON, 'w') as f:
        json.dump(results, f, indent=2)
    log(f"\nResults saved to: {OUT_JSON}")
    log(f"Total time: {(time.time()-start_time)/60:.1f} min")
    log("DONE")


if __name__ == '__main__':
    main()
