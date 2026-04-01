#!/usr/bin/env python3
"""
l1_cnn_combo_fillsim.py -- L1 imbalance filter fill_sim validation.

Tests: baseline CNN signals vs L1-direction-agree filtered signals.
Both run through Rust fill_sim_cli for realistic execution modeling.

Data (Neptune):
  - OOT book tensors: data/processed/dl_book_cache_oot/YYYY-MM-DD_book_tensors.npz
  - CNN predictions: alpha_discovery/deep_models/results/oot_wf_predictions_incremental.npz
  - MBO data: data/raw/mbo/glbx-mdp3-YYYYMMDD.mbo.dbn.zst
  - fill_sim_cli: rust_cache_builder/target/release/fill_sim_cli.exe

Output: scripts/l1_cnn_combo_fillsim_results.json
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
log = logging.getLogger("combo_fs")

BASE     = Path(os.environ.get("LVL3_ROOT", r"C:\Users\Footb\Documents\Github\Lvl3Quant"))
TENSOR_DIR = BASE / "data" / "processed" / "dl_book_cache_oot"
PRED_FILE  = BASE / "alpha_discovery" / "deep_models" / "results" / "oot_wf_predictions_incremental.npz"
MBO_DIR    = BASE / "data" / "raw" / "mbo"
FILL_SIM   = BASE / "rust_cache_builder" / "target" / "release" / "fill_sim_cli.exe"
OUT_DIR    = BASE / "data" / "processed" / "l1_combo_fillsim"
OUT_FILE   = Path(__file__).parent / "l1_cnn_combo_fillsim_results.json"

OOT_START = date(2025, 12, 1)
OOT_END   = date(2026, 3, 6)

WORKERS = 6  # parallel fill_sim processes

# Fill_sim configs to test
CONFIGS = [
    # name, extra_args
    ("chase_hold300s",      ["--chase-entry", "--hold-ms", "300000"]),
    ("chase_tp8_sl20",      ["--chase-entry", "--take-profit-ticks", "8", "--stop-loss-ticks", "20"]),
    ("chase_tp12_sl30",     ["--chase-entry", "--take-profit-ticks", "12", "--stop-loss-ticks", "30"]),
    ("passive_tp8_sl20",    ["--take-profit-ticks", "8", "--stop-loss-ticks", "20"]),
]

CNN_THRESH = 0.05
L1_THRESH  = 0.02   # abs demean imbalance


def compute_l1_agree_mask(book_tensors: np.ndarray, cnn_pred: np.ndarray) -> np.ndarray:
    """Return boolean mask: True where L1 demeaned imbalance agrees with CNN direction."""
    bid_qty = book_tensors[:, 0, 1].astype(np.float32)
    ask_qty = book_tensors[:, 0, 2].astype(np.float32)
    denom   = bid_qty + ask_qty
    l1_imb  = np.where(denom > 0, (bid_qty - ask_qty) / denom, 0.0)
    l1_dem  = l1_imb - float(np.nanmedian(l1_imb))
    agree   = (np.abs(cnn_pred) > CNN_THRESH) & \
              (np.sign(cnn_pred) == np.sign(l1_dem)) & \
              (np.abs(l1_dem) > L1_THRESH)
    return agree, l1_dem


def run_fillsim(mbo_path: Path, pred_npz: Path, out_json: Path, extra_args: list,
                signal_threshold: float = CNN_THRESH) -> dict:
    """Run fill_sim_cli and return parsed JSON result."""
    cmd = [
        str(FILL_SIM),
        "--mbo-file", str(mbo_path),
        "--predictions", str(pred_npz),
        "--output", str(out_json),
        "--signal-threshold", str(signal_threshold),
        "--latency-ms", "5",
        "--prime-hours",
        "--quiet",
    ] + extra_args

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        return {"error": result.stderr[:200], "cmd": " ".join(cmd[:6])}

    try:
        with open(out_json) as f:
            return json.load(f)
    except Exception as e:
        return {"error": str(e)}


def process_day(args):
    """Process one date: create pred arrays, run fill_sim for all configs."""
    ds, pred_baseline, pred_agree, mbo_path = args
    date_str = ds.strftime("%Y-%m-%d")
    results = {"date": date_str, "n_baseline": int((np.abs(pred_baseline) > CNN_THRESH).sum()),
               "n_agree": int((np.abs(pred_agree) > CNN_THRESH).sum())}

    with tempfile.TemporaryDirectory() as tmpdir:
        # Save baseline pred
        base_npz = Path(tmpdir) / f"{date_str}_base.npz"
        np.savez(base_npz, predictions=pred_baseline)

        # Save agree-filtered pred (zero out non-agree signals)
        agree_npz = Path(tmpdir) / f"{date_str}_agree.npz"
        np.savez(agree_npz, predictions=pred_agree)

        for cfg_name, cfg_args in CONFIGS:
            for variant, npz_path in [("base", base_npz), ("agree", agree_npz)]:
                out_json = Path(tmpdir) / f"{date_str}_{cfg_name}_{variant}.json"
                r = run_fillsim(mbo_path, npz_path, out_json, cfg_args)
                results[f"{variant}_{cfg_name}"] = {
                    "pnl":     r.get("total_pnl_dollars", float("nan")),
                    "sortino": r.get("sortino_ratio",     float("nan")),
                    "wr":      r.get("win_rate",          float("nan")),
                    "n":       r.get("n_trades",          0),
                    "fill_r":  r.get("fill_rate",         float("nan")),
                    "error":   r.get("error"),
                }

    return results


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
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
            tensors    = np.load(tensor_path)
            book       = tensors["book_tensors"]
            cnn_pred   = pred_data[pred_key].astype(np.float32)

            agree_mask, l1_dem = compute_l1_agree_mask(book, cnn_pred)
            pred_agree = np.where(agree_mask, cnn_pred, 0.0).astype(np.float32)

            days_args.append((d, cnn_pred, pred_agree, mbo_path))
        d += timedelta(days=1)

    log.info("Running fill_sim on %d days with %d workers...", len(days_args), WORKERS)

    all_results = []
    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process_day, args): args[0] for args in days_args}
        for fut in as_completed(futures):
            day = futures[fut]
            try:
                r = fut.result()
                all_results.append(r)
                n_base = r.get("n_baseline", 0)
                n_agree = r.get("n_agree", 0)
                # Quick summary of first config
                cfg = CONFIGS[0][0]
                b_pnl = r.get(f"base_{cfg}", {}).get("pnl", float("nan"))
                a_pnl = r.get(f"agree_{cfg}", {}).get("pnl", float("nan"))
                log.info("Day %s: n_base=%d n_agree=%d (%.0f%%) base_pnl=%.0f agree_pnl=%.0f",
                         day.strftime("%Y-%m-%d"), n_base, n_agree,
                         100 * n_agree / max(n_base, 1), b_pnl, a_pnl)
            except Exception as e:
                log.error("Day %s failed: %s", day.strftime("%Y-%m-%d"), e)

    all_results.sort(key=lambda x: x["date"])

    # Aggregate by config
    summary = {}
    for cfg_name, _ in CONFIGS:
        for variant in ["base", "agree"]:
            key = f"{variant}_{cfg_name}"
            pnls = [r[key]["pnl"] for r in all_results if r.get(key) and r[key].get("pnl") is not None and not (isinstance(r[key]["pnl"], float) and np.isnan(r[key]["pnl"]))]
            sortinos = [r[key]["sortino"] for r in all_results if r.get(key) and r[key].get("sortino") is not None and not (isinstance(r[key]["sortino"], float) and np.isnan(r[key]["sortino"]))]
            ns = [r[key]["n"] for r in all_results if r.get(key)]
            wrs = [r[key]["wr"] for r in all_results if r.get(key) and r[key].get("wr") is not None and not (isinstance(r[key]["wr"], float) and np.isnan(r[key]["wr"]))]

            summary[key] = {
                "total_pnl":    float(sum(pnls)) if pnls else float("nan"),
                "pnl_per_day":  float(sum(pnls) / len(pnls)) if pnls else float("nan"),
                "sortino_mean": float(np.mean(sortinos)) if sortinos else float("nan"),
                "wr_mean":      float(np.mean(wrs)) if wrs else float("nan"),
                "n_trades_total": int(sum(ns)),
                "n_trades_per_day": float(np.mean(ns)) if ns else 0.0,
                "n_days":       len(pnls),
            }

    output = {
        "n_days": len(all_results),
        "cnn_thresh": CNN_THRESH,
        "l1_thresh": L1_THRESH,
        "configs": [c[0] for c in CONFIGS],
        "summary": summary,
        "per_day": all_results,
    }

    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    log.info("\n=== COMBO FILL_SIM SUMMARY ===")
    for cfg_name, _ in CONFIGS:
        base_s  = summary.get(f"base_{cfg_name}", {})
        agree_s = summary.get(f"agree_{cfg_name}", {})
        pnl_lift = ((agree_s.get("pnl_per_day", 0) - base_s.get("pnl_per_day", 0)) /
                    max(abs(base_s.get("pnl_per_day", 1)), 1) * 100)
        log.info("CFG=%s | base: $/d=%.0f sortino=%.3f wr=%.1f%% n/d=%.0f | agree: $/d=%.0f sortino=%.3f wr=%.1f%% n/d=%.0f | lift=%.0f%%",
                 cfg_name,
                 base_s.get("pnl_per_day", float("nan")),
                 base_s.get("sortino_mean", float("nan")),
                 (base_s.get("wr_mean", float("nan")) or 0) * 100,
                 base_s.get("n_trades_per_day", 0),
                 agree_s.get("pnl_per_day", float("nan")),
                 agree_s.get("sortino_mean", float("nan")),
                 (agree_s.get("wr_mean", float("nan")) or 0) * 100,
                 agree_s.get("n_trades_per_day", 0),
                 pnl_lift)

    log.info("Results saved to %s", OUT_FILE)


if __name__ == "__main__":
    main()
