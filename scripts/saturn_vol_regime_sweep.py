#!/usr/bin/env python3
"""
saturn_vol_regime_sweep.py - Vol regime filter sweep on OOT CNN predictions.

Tests whether vol-filtered predictions (vol50/70/80) improve fill sim results
vs unfiltered, using the best configs from Jupiter sweep (A_tp13_sl40_t050 and lat20).

Runs on Saturn with fill_sim_cli_v2 - 68 OOT dates (Dec2025-Mar2026).
"""

import os
import json
import glob
import subprocess
import numpy as np
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

FILL_SIM = "/home/saturn/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli_v2"
MBO_DIR = Path("/home/saturn/Lvl3Quant/data/raw/mbo")
PRED_DIR = Path("/home/saturn/Lvl3Quant/data/processed/cnn_oot_sim_predictions")
OUT_DIR = Path("/home/saturn/Lvl3Quant/data/processed/vol_regime_sweep_results")
OUT_DIR.mkdir(parents=True, exist_ok=True)

WORKERS = 16  # Saturn has 48 CPUs, use 16 parallel

# Best configs from Jupiter OOT sweep
CONFIGS = {
    # Config A: tp13 sl40 threshold 0.5 (best overall)
    "A_tp13_sl40_t050": "--take-profit-ticks 13 --stop-loss-ticks 40 --hold-ms 1800000 --signal-threshold 0.5",
    # Config A with latency 20ms (2nd best)
    "A_tp13_sl40_lat20": "--take-profit-ticks 13 --stop-loss-ticks 40 --hold-ms 1800000 --signal-threshold 0.5 --latency-ms 20",
    # Config A5: tp10 sl40 (3rd best)
    "A5_tp10_sl40_t100": "--take-profit-ticks 10 --stop-loss-ticks 40 --hold-ms 1800000 --signal-threshold 1.0",
    # New: vol-aware config with tighter TP during high vol
    "A_tp13_sl40_t075": "--take-profit-ticks 13 --stop-loss-ticks 40 --hold-ms 1800000 --signal-threshold 0.75",
}

# Vol filter levels
VOL_LEVELS = ["vol50", "vol70", "vol80"]

# Session filters
SESSION = "morning_afternoon"


def get_all_tasks():
    """Build list of (date, vol_level, config_name, config_flags) tasks."""
    tasks = []
    pred_files = sorted(PRED_DIR.glob("*_%s_%s.npz" % ("*", SESSION)))

    dates = set()
    vol_date_map = {}  # (date, vol) -> pred_file

    for pf in pred_files:
        name = pf.stem  # e.g. 2025-12-01_vol50_morning_afternoon
        parts = name.split("_")
        date = parts[0]
        vol = parts[1]
        dates.add(date)
        vol_date_map[(date, vol)] = pf

    dates = sorted(dates)
    print("Dates: %d (%s -> %s)" % (len(dates), dates[0], dates[-1]))

    for date in dates:
        date8 = date.replace("-", "")
        mbo_file = MBO_DIR / ("glbx-mdp3-%s.mbo.dbn.zst" % date8)
        if not mbo_file.exists():
            continue

        for vol in VOL_LEVELS:
            pred_file = vol_date_map.get((date, vol))
            if pred_file is None:
                continue

            for config_name, config_flags in CONFIGS.items():
                out_file = OUT_DIR / ("%s_%s_%s.json" % (date8, vol, config_name))
                if out_file.exists():
                    continue  # Skip already done
                tasks.append((date, vol, config_name, config_flags, mbo_file, pred_file, out_file))

    return tasks


def run_one(task):
    date, vol, config_name, config_flags, mbo_file, pred_file, out_file = task
    cmd = [FILL_SIM, "--mbo-file", str(mbo_file), "--predictions", str(pred_file),
           "--output", str(out_file)] + config_flags.split()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if out_file.exists():
            with open(out_file) as f:
                d = json.load(f)
            return {
                "date": date, "vol": vol, "config": config_name,
                "pnl": d.get("total_pnl_dollars", 0),
                "trades": d.get("total_trades", 0),
                "win_rate": d.get("win_rate", 0),
                "ok": True
            }
        else:
            return {"date": date, "vol": vol, "config": config_name, "ok": False, "error": "no output"}
    except Exception as e:
        return {"date": date, "vol": vol, "config": config_name, "ok": False, "error": str(e)}


def aggregate_results():
    """Aggregate results by (vol_level, config) and print summary."""
    from collections import defaultdict
    summary = defaultdict(lambda: {"pnls": [], "trades": 0, "dates": 0})

    for f in sorted(OUT_DIR.glob("*.json")):
        try:
            with open(f) as fp:
                d = json.load(fp)
            name = f.stem  # e.g. 20251201_vol50_A_tp13_sl40_t050
            parts = name.split("_", 2)
            if len(parts) < 3:
                continue
            date8, vol = parts[0], parts[1]
            config = parts[2]
            key = (vol, config)
            summary[key]["pnls"].append(d.get("total_pnl_dollars", 0))
            summary[key]["trades"] += d.get("total_trades", 0)
            summary[key]["dates"] += 1
        except:
            pass

    print("\n=== VOL REGIME SWEEP RESULTS ===")
    print("%-10s %-30s %8s %8s %6s %6s" % ("VOL", "CONFIG", "TOTAL", "AVG/DAY", "DATES", "TRADES"))
    print("-" * 75)

    rows = []
    for (vol, config), data in summary.items():
        pnls = data["pnls"]
        if not pnls:
            continue
        total = sum(pnls)
        avg = np.mean(pnls)
        rows.append((total, vol, config, avg, data["dates"], data["trades"]))

    rows.sort(key=lambda x: -x[0])
    for total, vol, config, avg, dates, trades in rows:
        print("%-10s %-30s %8.0f %8.0f %6d %6d" % (vol, config, total, avg, dates, trades))


def main():
    tasks = get_all_tasks()
    print("Total tasks to run: %d" % len(tasks))

    if not tasks:
        print("All tasks already complete. Aggregating...")
        aggregate_results()
        return

    done = 0
    failed = 0
    with ProcessPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(run_one, t): t for t in tasks}
        for future in as_completed(futures):
            r = future.result()
            done += 1
            if r.get("ok"):
                if done % 50 == 0:
                    print("[%d/%d] %s %s %s PnL=%.0f" % (done, len(tasks), r["date"], r["vol"], r["config"], r["pnl"]))
            else:
                failed += 1
                if failed <= 5:
                    print("FAIL: %s %s %s - %s" % (r["date"], r["vol"], r["config"], r.get("error", "?")))

    print("\nDone: %d/%d (failed: %d)" % (done - failed, len(tasks), failed))
    aggregate_results()

    # Save summary JSON
    summary_data = {}
    from collections import defaultdict
    per_key = defaultdict(list)
    for f in sorted(OUT_DIR.glob("*.json")):
        try:
            with open(f) as fp:
                d = json.load(fp)
            name = f.stem
            parts = name.split("_", 2)
            if len(parts) < 3:
                continue
            date8, vol = parts[0], parts[1]
            config = parts[2]
            per_key["%s_%s" % (vol, config)].append(d.get("total_pnl_dollars", 0))
        except:
            pass

    for key, pnls in per_key.items():
        neg = [p for p in pnls if p < 0]
        sortino = np.mean(pnls) / np.std(neg) if neg else 0
        summary_data[key] = {
            "total_pnl": sum(pnls),
            "avg_daily_pnl": float(np.mean(pnls)),
            "sortino": float(sortino),
            "win_rate": sum(1 for p in pnls if p > 0) / len(pnls),
            "n_days": len(pnls)
        }

    out_summary = str(OUT_DIR / "vol_regime_summary.json")
    with open(out_summary, "w") as f:
        json.dump(summary_data, f, indent=2)
    print("\nSummary saved to:", out_summary)


if __name__ == "__main__":
    main()
