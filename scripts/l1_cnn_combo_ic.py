#!/usr/bin/env python3
"""
l1_cnn_combo_ic.py -- L1 imbalance x CNN prediction combo IC test.

Hypothesis: When L1 book imbalance direction AGREES with CNN prediction direction,
does the IC improve vs CNN alone?

Data sources (Neptune):
  - book_tensors: dl_book_cache_oot/*.npz  shape (N, 20, 4)
      axes: [timestep, level, feature]
      features: [bid_price, bid_qty, ask_price, ask_qty]  (assumed)
  - CNN preds: oot_wf_predictions_incremental.npz  shape (N,) per date
  - mid_prices: in book_tensors['mid_prices']  shape (N,)

Outputs: l1_cnn_combo_ic_results.json in this script's directory.
"""

import json
import logging
import os
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from scipy.stats import spearmanr

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("combo_ic")

BASE = Path(os.environ.get("LVL3_ROOT", r"C:\Users\Footb\Documents\Github\Lvl3Quant"))
TENSOR_DIR = BASE / "data" / "processed" / "dl_book_cache_oot"
PRED_FILE  = BASE / "alpha_discovery" / "deep_models" / "results" / "oot_wf_predictions_incremental.npz"
OUT_FILE   = Path(__file__).parent / "l1_cnn_combo_ic_results.json"

# OOT range
OOT_START = date(2025, 12, 1)
OOT_END   = date(2026, 3, 6)

# IC horizons in bars (1 bar = 10s)
HORIZONS = {
    "10s": 1,
    "30s": 3,
    "60s": 6,
    "2min": 12,
    "5min": 30,
}

# Signal thresholds for CNN
CNN_THRESH = 0.05   # abs(pred) > thresh to be "active"
L1_THRESH  = 0.02   # abs(L1_imb) > thresh to be "meaningful"

# Vol regime filter (use vol percentile from mid_price std)
VOL_WINDOW = 390    # bars for rolling vol (65 min)


def compute_l1_imb(book_tensors: np.ndarray) -> np.ndarray:
    """L1 imbalance = (bid_qty_L1 - ask_qty_L1) / (bid_qty_L1 + ask_qty_L1).

    Tensor format: (N, 20, 4)
      feat 0: price offset (normalized, bid=negative)
      feat 1: bid quantity at level
      feat 2: ask quantity at level
      feat 3: derived/other feature
    Level 0 = L1 (top of book).
    """
    bid_qty = book_tensors[:, 0, 1].astype(np.float32)
    ask_qty = book_tensors[:, 0, 2].astype(np.float32)
    denom = bid_qty + ask_qty
    imb = np.where(denom > 0, (bid_qty - ask_qty) / denom, 0.0)
    return imb


def forward_return(mid: np.ndarray, horizon: int) -> np.ndarray:
    """Future mid-price return at horizon bars ahead."""
    fwd = np.empty(len(mid), dtype=np.float32)
    fwd[:] = np.nan
    fwd[:-horizon] = mid[horizon:] - mid[:-horizon]
    return fwd


def ic(signal: np.ndarray, ret: np.ndarray) -> float:
    """Spearman IC, ignoring NaN."""
    mask = np.isfinite(signal) & np.isfinite(ret)
    if mask.sum() < 30:
        return float("nan")
    r, _ = spearmanr(signal[mask], ret[mask])
    return float(r)


def rolling_vol_pct(mid: np.ndarray, window: int = VOL_WINDOW) -> np.ndarray:
    """Rolling std of mid-price changes, expressed as percentile rank."""
    diff = np.abs(np.diff(mid, prepend=mid[0]))
    vol = np.array([
        diff[max(0, i - window):i + 1].std() for i in range(len(diff))
    ], dtype=np.float32)
    # Convert to percentile rank
    order = np.argsort(np.argsort(vol))
    pct = order / (len(vol) - 1) * 100.0
    return pct


def main():
    log.info("Loading CNN predictions from %s", PRED_FILE)
    pred_data = np.load(PRED_FILE, allow_pickle=True)

    results_per_day = []
    dates_processed = []

    d = OOT_START
    while d <= OOT_END:
        ds = d.strftime("%Y-%m-%d")
        tensor_path = TENSOR_DIR / f"{ds}_book_tensors.npz"
        pred_key = f"{ds}_preds"

        if not tensor_path.exists() or pred_key not in pred_data:
            d += timedelta(days=1)
            continue

        # Load data
        tensors = np.load(tensor_path)
        book = tensors["book_tensors"]    # (N, 20, 4)
        mid  = tensors["mid_prices"].astype(np.float32)  # (N,)
        cnn_pred = pred_data[pred_key].astype(np.float32)  # (N,)

        if len(mid) != len(cnn_pred):
            log.warning("%s: length mismatch mid=%d pred=%d — skip", ds, len(mid), len(cnn_pred))
            d += timedelta(days=1)
            continue

        # Compute L1 imbalance
        l1_imb = compute_l1_imb(book)

        # Compute vol regime
        vol_pct = rolling_vol_pct(mid)
        low_vol_mask  = vol_pct < 33.0
        high_vol_mask = vol_pct > 67.0

        day_result = {"date": ds}

        # Demean L1 imbalance (remove the positive bias) so sign reflects relative state
        l1_imb_demeaned = l1_imb - np.nanmedian(l1_imb)
        # L1 imbalance magnitude percentile (top quartile = strong imbalance)
        l1_abs = np.abs(l1_imb_demeaned)
        l1_strong = l1_abs > np.nanpercentile(l1_abs, 75)  # top 25% magnitude

        for h_name, h_bars in HORIZONS.items():
            fwd = forward_return(mid, h_bars)

            # CNN active signals (above threshold)
            cnn_active = np.abs(cnn_pred) > CNN_THRESH

            # 1. Direction agreement using DEMEANED L1 (removes bias)
            combo_agree   = cnn_active & (np.sign(cnn_pred) == np.sign(l1_imb_demeaned)) & (l1_abs > L1_THRESH)
            combo_disagree= cnn_active & (np.sign(cnn_pred) != np.sign(l1_imb_demeaned)) & (l1_abs > L1_THRESH)

            # 2. L1 MAGNITUDE filter: CNN signal when L1 imb is STRONG (top 25%)
            combo_strong_l1 = cnn_active & l1_strong

            # 3. Low-vol + L1 strong
            combo_lowvol_strong = cnn_active & l1_strong & low_vol_mask

            # 4. Raw L1 standalone (demeaned)
            # IC computations
            ic_cnn_all        = ic(cnn_pred, fwd)
            ic_cnn_active     = ic(np.where(cnn_active, cnn_pred, np.nan), fwd)
            ic_l1_raw         = ic(l1_imb, fwd)
            ic_l1_demeaned    = ic(l1_imb_demeaned, fwd)
            ic_combo_agree    = ic(np.where(combo_agree, cnn_pred, np.nan), fwd)
            ic_combo_disagree = ic(np.where(combo_disagree, cnn_pred, np.nan), fwd)
            ic_combo_strong   = ic(np.where(combo_strong_l1, cnn_pred, np.nan), fwd)
            ic_combo_lv_strong= ic(np.where(combo_lowvol_strong, cnn_pred, np.nan), fwd)

            n_cnn_active      = int(cnn_active.sum())
            n_agree           = int(combo_agree.sum())
            n_disagree        = int(combo_disagree.sum())
            n_strong          = int(combo_strong_l1.sum())

            day_result[h_name] = {
                "ic_cnn_all":        ic_cnn_all,
                "ic_cnn_active":     ic_cnn_active,
                "ic_l1_raw":         ic_l1_raw,
                "ic_l1_demeaned":    ic_l1_demeaned,
                "ic_combo_agree":    ic_combo_agree,
                "ic_combo_disagree": ic_combo_disagree,
                "ic_combo_strong_l1":ic_combo_strong,
                "ic_combo_lv_strong":ic_combo_lv_strong,
                "n_cnn_active":      n_cnn_active,
                "n_agree":           n_agree,
                "n_disagree":        n_disagree,
                "n_strong_l1":       n_strong,
                "agree_rate":        float(n_agree / n_cnn_active) if n_cnn_active > 0 else 0.0,
                "l1_pos_pct":        float((l1_imb > 0).mean()),
                "l1_median":         float(np.nanmedian(l1_imb)),
            }

        results_per_day.append(day_result)
        dates_processed.append(ds)
        log.info("Processed %s | 10s: cnn=%.4f agree=%.4f strong=%.4f l1_dem=%.4f l1pos=%.0f%% n=%d",
                 ds,
                 day_result["10s"]["ic_cnn_active"],
                 day_result["10s"]["ic_combo_agree"],
                 day_result["10s"]["ic_combo_strong_l1"],
                 day_result["10s"]["ic_l1_demeaned"],
                 day_result["10s"]["l1_pos_pct"] * 100,
                 day_result["10s"]["n_strong_l1"])

        d += timedelta(days=1)

    if not results_per_day:
        log.error("No dates processed — check paths")
        return

    # Aggregate across days
    summary = {}
    for h_name in HORIZONS:
        metrics = ["ic_cnn_all", "ic_cnn_active", "ic_l1_raw", "ic_l1_demeaned", "ic_combo_agree", "ic_combo_disagree", "ic_combo_strong_l1", "ic_combo_lv_strong"]
        agg = {}
        for m in metrics:
            vals = [r[h_name][m] for r in results_per_day if not np.isnan(r[h_name][m])]
            if vals:
                agg[m] = {
                    "mean":    float(np.mean(vals)),
                    "std":     float(np.std(vals)),
                    "ir":      float(np.mean(vals) / np.std(vals)) if np.std(vals) > 0 else 0.0,
                    "pos_pct": float(sum(1 for v in vals if v > 0) / len(vals) * 100),
                    "n_days":  len(vals),
                }
            else:
                agg[m] = None
        # Average ancillary stats
        for stat in ["agree_rate", "l1_pos_pct", "l1_median"]:
            vals_s = [r[h_name][stat] for r in results_per_day]
            agg["mean_" + stat] = float(np.mean(vals_s))
        for stat in ["n_cnn_active", "n_agree", "n_disagree", "n_strong_l1"]:
            vals_s = [r[h_name][stat] for r in results_per_day]
            agg["mean_" + stat] = float(np.mean(vals_s))
        summary[h_name] = agg

    output = {
        "n_days": len(results_per_day),
        "dates": dates_processed,
        "cnn_thresh": CNN_THRESH,
        "l1_thresh": L1_THRESH,
        "summary": summary,
        "per_day": results_per_day,
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    log.info("=== COMBO IC SUMMARY ===")
    for h_name, agg in summary.items():
        cnn  = agg.get("ic_cnn_active") or {}
        agree= agg.get("ic_combo_agree") or {}
        strong= agg.get("ic_combo_strong_l1") or {}
        lv   = agg.get("ic_combo_lv_strong") or {}
        l1r  = agg.get("ic_l1_raw") or {}
        l1d  = agg.get("ic_l1_demeaned") or {}
        lift_agree  = ((agree.get("mean", 0) - cnn.get("mean", 0)) / abs(cnn.get("mean", 1e-9)) * 100) if cnn.get("mean") else 0
        lift_strong = ((strong.get("mean", 0) - cnn.get("mean", 0)) / abs(cnn.get("mean", 1e-9)) * 100) if cnn.get("mean") else 0
        log.info("H=%s cnn=%.4f agree=%.4f(%.0f%%) strong=%.4f(%.0f%%) lv_strong=%.4f l1_raw=%.4f l1_dem=%.4f n_active=%.0f",
                 h_name,
                 cnn.get("mean", float("nan")),
                 agree.get("mean", float("nan")), lift_agree,
                 strong.get("mean", float("nan")), lift_strong,
                 lv.get("mean", float("nan")),
                 l1r.get("mean", float("nan")),
                 l1d.get("mean", float("nan")),
                 agg.get("mean_n_cnn_active", 0))

    log.info("Results saved to %s", OUT_FILE)


if __name__ == "__main__":
    main()
