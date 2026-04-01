#!/usr/bin/env python3
"""
l1_cnn_convthresh_fillsim.py -- L1 agree filter on conviction-thresholded CNN signals.

KEY INSIGHT: The previous combo fillsim tested raw CNN output (188K signals/day) which
is too noisy. The paper engine uses conviction thresholds that reduce to ~10-100 trades/day.
This test applies the L1 agree filter ON TOP of conviction-filtered signals.

Tests multiple conviction thresholds + L1 filter combinations.

Data: Neptune OOT book tensors + oot_wf_predictions_incremental.npz
"""

import json
import logging
import os
import subprocess
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("conv_l1_fs")

BASE       = Path(os.environ.get("LVL3_ROOT", r"C:\Users\Footb\Documents\Github\Lvl3Quant"))
TENSOR_DIR = BASE / "data" / "processed" / "dl_book_cache_oot"
PRED_FILE  = BASE / "alpha_discovery" / "deep_models" / "results" / "oot_wf_predictions_incremental.npz"
MBO_DIR    = BASE / "data" / "raw" / "mbo"
FILL_SIM   = BASE / "rust_cache_builder" / "target" / "release" / "fill_sim_cli.exe"
OUT_FILE   = Path(__file__).parent / "l1_cnn_convthresh_fillsim_results.json"

OOT_START = date(2025, 12, 1)
OOT_END   = date(2026, 3, 6)

WORKERS = 8

# Conviction thresholds to test (these reduce 188K signals to ~1K-20K/day)
CONV_THRESHOLDS = [0.05, 0.10, 0.15, 0.20]

# Fill sim configs (simpler set for speed)
FILL_CONFIGS = [
    ("chase_tp8_sl20",  ["--chase-entry", "--take-profit-ticks", "8",  "--stop-loss-ticks", "20", "--prime-hours"]),
    ("chase_tp12_sl30", ["--chase-entry", "--take-profit-ticks", "12", "--stop-loss-ticks", "30", "--prime-hours"]),
]

L1_THRESH = 0.02


def compute_l1_agree_mask(book_tensors, cnn_pred, conv_thresh):
    """Boolean mask: CNN conviction-active AND L1 demeaned direction agrees."""
    bid_qty  = book_tensors[:, 0, 1].astype(np.float32)
    ask_qty  = book_tensors[:, 0, 2].astype(np.float32)
    denom    = bid_qty + ask_qty
    l1_imb   = np.where(denom > 0, (bid_qty - ask_qty) / denom, 0.0)
    l1_dem   = l1_imb - float(np.nanmedian(l1_imb))

    active   = np.abs(cnn_pred) > conv_thresh
    agree    = active & (np.sign(cnn_pred) == np.sign(l1_dem)) & (np.abs(l1_dem) > L1_THRESH)
    return agree, l1_dem


def run_fillsim(mbo_path, pred_npz, out_json, extra_args, signal_threshold):
    cmd = [
        str(FILL_SIM),
        "--mbo-file",       str(mbo_path),
        "--predictions",    str(pred_npz),
        "--output",         str(out_json),
        "--signal-threshold", str(signal_threshold),
        "--latency-ms",     "5",
        "--quiet",
    ] + extra_args
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        return {"error": result.stderr[:200]}
    try:
        with open(out_json) as f:
            return json.load(f)
    except Exception as e:
        return {"error": str(e)}


def process_day(args):
    ds, cnn_pred, book, mbo_path = args
    date_str = ds.strftime("%Y-%m-%d")
    results  = {"date": date_str}

    with tempfile.TemporaryDirectory() as tmpdir:
        for conv_t in CONV_THRESHOLDS:
            agree_mask, l1_dem = compute_l1_agree_mask(book, cnn_pred, conv_t)
            n_active = int((np.abs(cnn_pred) > conv_t).sum())
            n_agree  = int(agree_mask.sum())

            # Baseline: CNN at this conviction threshold (zeroing out below-thresh)
            pred_base  = np.where(np.abs(cnn_pred) > conv_t, cnn_pred, 0.0).astype(np.float32)
            # L1 agree: only keep agree-filtered signals
            pred_agree = np.where(agree_mask, cnn_pred, 0.0).astype(np.float32)

            base_npz  = Path(tmpdir) / f"base_c{conv_t}.npz"
            agree_npz = Path(tmpdir) / f"agree_c{conv_t}.npz"
            np.savez(base_npz,  predictions=pred_base)
            np.savez(agree_npz, predictions=pred_agree)

            results[f"c{conv_t}_n_active"] = n_active
            results[f"c{conv_t}_n_agree"]  = n_agree

            for cfg_name, cfg_args in FILL_CONFIGS:
                for variant, npz_path in [("base", base_npz), ("agree", agree_npz)]:
                    out_json = Path(tmpdir) / f"{date_str}_c{conv_t}_{cfg_name}_{variant}.json"
                    # Use threshold=0 since we already zeroed out below-threshold
                    r = run_fillsim(mbo_path, npz_path, out_json, cfg_args, 0.0)
                    key = f"c{conv_t}_{variant}_{cfg_name}"
                    results[key] = {
                        "pnl":    r.get("total_pnl_dollars"),
                        "n":      r.get("total_trades", r.get("total_filled")),
                        "wr":     r.get("win_rate"),
                        "fill_r": r.get("total_filled", 0) / max(r.get("total_signals", 1), 1),
                        "error":  r.get("error"),
                    }

    return results


def main():
    log.info("Loading CNN predictions...")
    pred_data = np.load(PRED_FILE, allow_pickle=True)

    days_args = []
    d = OOT_START
    while d <= OOT_END:
        ds = d.strftime("%Y-%m-%d")
        tensor_path = TENSOR_DIR / f"{ds}_book_tensors.npz"
        mbo_path    = MBO_DIR / f"glbx-mdp3-{d.strftime('%Y%m%d')}.mbo.dbn.zst"
        pred_key    = f"{ds}_preds"
        if tensor_path.exists() and mbo_path.exists() and pred_key in pred_data:
            tensors  = np.load(tensor_path)
            book     = tensors["book_tensors"]
            cnn_pred = pred_data[pred_key].astype(np.float32)
            days_args.append((d, cnn_pred, book, mbo_path))
        d += timedelta(days=1)

    log.info("Running on %d days, %d workers, %d conv thresholds...",
             len(days_args), WORKERS, len(CONV_THRESHOLDS))

    all_results = []
    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process_day, args): args[0] for args in days_args}
        for fut in as_completed(futures):
            day = futures[fut]
            try:
                r = fut.result()
                all_results.append(r)
                # Quick log for c0.1 threshold
                c = 0.1
                n_a = r.get(f"c{c}_n_active", 0)
                n_ag = r.get(f"c{c}_n_agree", 0)
                b_pnl = (r.get(f"c{c}_base_chase_tp8_sl20") or {}).get("pnl", float("nan"))
                a_pnl = (r.get(f"c{c}_agree_chase_tp8_sl20") or {}).get("pnl", float("nan"))
                log.info("Day %s c0.1: n_active=%d n_agree=%d(%.0f%%) base_pnl=%.0f agree_pnl=%.0f",
                         day.strftime("%Y-%m-%d"), n_a, n_ag,
                         100 * n_ag / max(n_a, 1), b_pnl or 0, a_pnl or 0)
            except Exception as e:
                log.error("Day %s failed: %s", day.strftime("%Y-%m-%d"), e)

    all_results.sort(key=lambda x: x["date"])

    # Aggregate by conv_thresh x cfg x variant
    summary = {}
    for conv_t in CONV_THRESHOLDS:
        for cfg_name, _ in FILL_CONFIGS:
            for variant in ["base", "agree"]:
                key = f"c{conv_t}_{variant}_{cfg_name}"
                pnls  = [r[key]["pnl"] for r in all_results
                         if r.get(key) and r[key].get("pnl") is not None]
                ns    = [r[key]["n"] for r in all_results if r.get(key) and r[key].get("n")]
                wrs   = [r[key]["wr"] for r in all_results if r.get(key) and r[key].get("wr")]
                n_active_mean = float(np.mean([r.get(f"c{conv_t}_n_active", 0) for r in all_results]))
                n_agree_mean  = float(np.mean([r.get(f"c{conv_t}_n_agree", 0) for r in all_results]))
                summary[key] = {
                    "conv_thresh":  conv_t,
                    "variant":      variant,
                    "cfg":          cfg_name,
                    "pnl_per_day":  float(sum(pnls) / len(pnls)) if pnls else float("nan"),
                    "total_pnl":    float(sum(pnls)) if pnls else float("nan"),
                    "n_trades_day": float(np.mean(ns)) if ns else 0.0,
                    "wr":           float(np.mean(wrs)) if wrs else float("nan"),
                    "n_signal_day": n_active_mean if variant == "base" else n_agree_mean,
                    "n_days":       len(pnls),
                }

    output = {
        "n_days": len(all_results),
        "l1_thresh": L1_THRESH,
        "conv_thresholds": CONV_THRESHOLDS,
        "summary": summary,
        "per_day": all_results,
    }

    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    log.info("\n=== CONV THRESH + L1 FILTER SUMMARY ===")
    log.info("%-8s %-10s %-20s %8s %8s %8s %8s %10s",
             "CONV", "VARIANT", "CONFIG", "PNL/DAY", "WR", "N/DAY", "SIG/DAY", "DAYS")
    for conv_t in CONV_THRESHOLDS:
        for cfg_name, _ in FILL_CONFIGS:
            for variant in ["base", "agree"]:
                key = f"c{conv_t}_{variant}_{cfg_name}"
                s = summary.get(key, {})
                log.info("%-8s %-10s %-20s %8.0f %8.1f%% %8.0f %10.0f %8d",
                         str(conv_t), variant, cfg_name,
                         s.get("pnl_per_day", float("nan")),
                         (s.get("wr", 0) or 0) * 100,
                         s.get("n_trades_day", 0),
                         s.get("n_signal_day", 0),
                         s.get("n_days", 0))

    log.info("Results saved to %s", OUT_FILE)


if __name__ == "__main__":
    main()
