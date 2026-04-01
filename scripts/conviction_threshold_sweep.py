#!/usr/bin/env python3
"""
conviction_threshold_sweep.py — C1 conviction threshold (entry filter) sweep.

HYPOTHESIS: Restricting to top N% conviction signals (high |z-score|) will
dramatically improve Sortino by filtering out weak, noisy signals.

C1 baseline: TP13/SL20, signal_threshold=0.1 → ~21 trades/day, Sortino=1.691

Sweep: test z-score thresholds [0.5, 1.0, 1.5, 2.0, 2.5] as --signal-threshold
  - z>0.5 → ~2952 signals/day input
  - z>1.0 → ~2322 signals/day input
  - z>1.5 → ~1903 signals/day input
  - z>2.0 → ~687 signals/day input
  - z>2.5 → ~300 signals/day input
(fill rate ~1% of signals → actual trades much lower per day)

Runs on Neptune (localhost) using fill_sim_cli.exe
Data: Lvl3Quant root (LVL3_ROOT env or default Neptune path)
  - MBO: data/raw/mbo/
  - Predictions: data/processed/cnn_wf_stacked_predictions/*_book_predstdExit_conv1.5_vol50.npz
  - Output: data/processed/conviction_threshold_sweep/

OOT range: 2025-12-01 to 2026-03-06 (58 trading days available)
"""

import json
import logging
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("conv_thresh_sweep")

# Paths (Neptune / localhost)
BASE = Path(os.environ.get("LVL3_ROOT", r"C:\Users\Footb\Documents\Github\Lvl3Quant"))
MBO_DIR = BASE / "data" / "raw" / "mbo"
PRED_DIR = BASE / "data" / "processed" / "cnn_wf_stacked_predictions"
OUTPUT_DIR = BASE / "data" / "processed" / "conviction_threshold_sweep"
FILL_SIM = BASE / "rust_cache_builder" / "target" / "release" / "fill_sim_cli.exe"

# OOT range
OOT_START = "2025-12-01"
OOT_END = "2026-03-06"

# C1 fixed config (TP13/SL20 — validated best from prior sweep)
C1_CONFIG = {
    "pred_suffix": "book_predstdExit_conv1.5_vol50",
    "tp_ticks": 13,
    "sl_ticks": 20,
    "hold_ms": 3600000,
    "desc": "C1 book_predstdExit conv1.5 vol50 — TP13/SL20",
}

# Conviction threshold sweep variants
# These are the z-score magnitudes passed as --signal-threshold to fill_sim
# Baseline uses 0.1 (the card's current threshold)
THRESHOLDS = [
    {"z": 0.1,  "label": "baseline_z01"},   # baseline — all active signals
    {"z": 0.5,  "label": "z05"},
    {"z": 1.0,  "label": "z10"},
    {"z": 1.5,  "label": "z15"},
    {"z": 2.0,  "label": "z20"},
    {"z": 2.5,  "label": "z25"},
]

WORKERS = 8  # Neptune has 8 workers safe (paper engine running, don't saturate)


def discover_dates():
    """Find all OOT dates where both MBO and C1 prediction files exist."""
    dates = []
    for mbo_file in sorted(MBO_DIR.glob("glbx-mdp3-*.mbo.dbn.zst")):
        m = re.search(r"(\d{8})\.mbo", mbo_file.name)
        if not m:
            continue
        raw = m.group(1)
        date_str = f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
        if not (OOT_START <= date_str <= OOT_END):
            continue
        pred_file = PRED_DIR / f"{date_str}_{C1_CONFIG['pred_suffix']}.npz"
        if pred_file.exists():
            dates.append(date_str)
    return sorted(dates)


def build_task(date_str, threshold_cfg):
    """Build a single fill_sim_cli task dict."""
    date_compact = date_str.replace("-", "")
    mbo_file = MBO_DIR / f"glbx-mdp3-{date_compact}.mbo.dbn.zst"
    pred_file = PRED_DIR / f"{date_str}_{C1_CONFIG['pred_suffix']}.npz"

    if not mbo_file.exists() or not pred_file.exists():
        return None

    label = threshold_cfg["label"]
    out_dir = OUTPUT_DIR / label
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{date_str}.json"

    if out_file.exists():
        return None  # Already completed

    cmd = [
        str(FILL_SIM),
        "--mbo-file", str(mbo_file),
        "--predictions", str(pred_file),
        "--output", str(out_file),
        "--signal-threshold", str(threshold_cfg["z"]),
        "--take-profit-ticks", str(C1_CONFIG["tp_ticks"]),
        "--stop-loss-ticks", str(C1_CONFIG["sl_ticks"]),
        "--hold-ms", str(C1_CONFIG["hold_ms"]),
        "--quiet",
    ]

    return {
        "cmd": cmd,
        "date": date_str,
        "label": label,
        "z": threshold_cfg["z"],
        "out_file": str(out_file),
    }


def run_task(task):
    """Execute a single fill_sim task."""
    try:
        result = subprocess.run(
            task["cmd"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            return {"status": "FAIL", **task, "error": result.stderr[:300]}
        return {"status": "OK", **task}
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT", **task}
    except Exception as e:
        return {"status": "ERROR", **task, "error": str(e)[:200]}


def compute_sortino(daily_pnls):
    """Compute annualized Sortino ratio from daily P&L array."""
    arr = np.array(daily_pnls)
    mean_daily = np.mean(arr)
    downside = arr[arr < 0]
    if len(downside) < 2:
        return float("inf") if mean_daily > 0 else 0.0
    downside_std = np.std(downside, ddof=1)
    if downside_std == 0:
        return float("inf") if mean_daily > 0 else 0.0
    return float(mean_daily / downside_std * np.sqrt(252))


def aggregate_results(label):
    """Aggregate per-date results for a threshold variant."""
    result_dir = OUTPUT_DIR / label
    if not result_dir.exists():
        return None

    all_trades = []
    daily_pnls = []
    n_days = 0

    for f in sorted(result_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            n_days += 1
            pnl = data.get("total_pnl_dollars", 0)
            daily_pnls.append(pnl)
            trades = data.get("trades", [])
            all_trades.extend(trades)
        except Exception:
            continue

    if n_days == 0:
        return None

    total_pnl = sum(daily_pnls)
    n_trades = len(all_trades)

    if n_trades == 0:
        return {
            "label": label,
            "n_days": n_days,
            "n_trades": 0,
            "trades_per_day": 0.0,
            "total_pnl": 0.0,
            "sortino": 0.0,
            "sharpe": 0.0,
            "win_rate": 0.0,
            "avg_win": 0.0,
            "avg_loss": 0.0,
            "profit_factor": 0.0,
            "max_drawdown": 0.0,
            "pos_days": 0,
            "neg_days": 0,
        }

    wins = [t for t in all_trades if t.get("pnl_dollars", 0) > 0]
    losses = [t for t in all_trades if t.get("pnl_dollars", 0) <= 0]

    arr = np.array(daily_pnls)
    sharpe = float(np.mean(arr) / np.std(arr) * np.sqrt(252)) if np.std(arr) > 0 else 0.0
    sortino = compute_sortino(daily_pnls)

    # Max drawdown
    cumulative = np.cumsum(arr)
    running_max = np.maximum.accumulate(cumulative)
    drawdowns = running_max - cumulative
    max_dd = float(np.max(drawdowns)) if len(drawdowns) > 0 else 0.0

    # Profit factor
    gross_wins = sum(t.get("pnl_dollars", 0) for t in wins)
    gross_losses = abs(sum(t.get("pnl_dollars", 0) for t in losses))
    profit_factor = gross_wins / gross_losses if gross_losses > 0 else float("inf")

    return {
        "label": label,
        "n_days": n_days,
        "n_trades": n_trades,
        "trades_per_day": round(n_trades / n_days, 1),
        "total_pnl": round(total_pnl, 2),
        "sortino": round(sortino, 3),
        "sharpe": round(sharpe, 3),
        "win_rate": round(len(wins) / n_trades * 100, 1) if n_trades > 0 else 0.0,
        "avg_win": round(gross_wins / len(wins), 2) if wins else 0.0,
        "avg_loss": round(-gross_losses / len(losses), 2) if losses else 0.0,
        "profit_factor": round(profit_factor, 3),
        "max_drawdown": round(max_dd, 2),
        "pos_days": sum(1 for p in daily_pnls if p > 0),
        "neg_days": sum(1 for p in daily_pnls if p <= 0),
    }


def print_results_table(summary):
    """Print comparison table sorted by Sortino."""
    print()
    print("=" * 110)
    print("C1 CONVICTION THRESHOLD SWEEP — OOT RESULTS")
    print(f"Config: TP13/SL20, pred=book_predstdExit_conv1.5_vol50")
    print(f"Baseline (z>0.1): Sortino=1.691, ~21 trades/day (reference)")
    print("=" * 110)

    # Sort by Sortino descending
    ranked = sorted(summary, key=lambda x: x["sortino"], reverse=True)

    header = (
        f"{'Rank':>4} {'Threshold':>12} | {'Days':>4} {'Trades':>6} {'T/Day':>6} "
        f"{'PnL':>10} {'Sortino':>8} {'Sharpe':>7} {'WR%':>5} "
        f"{'AvgW':>8} {'AvgL':>8} {'PF':>6} {'MaxDD':>8} | {'Pos':>3}/{' Neg':>3}"
    )
    print(header)
    print("-" * 110)

    for rank, s in enumerate(ranked, 1):
        marker = " ***" if rank == 1 else "  **" if rank == 2 else "   *" if rank == 3 else ""
        pf_str = f"{s['profit_factor']:>6.2f}" if s["profit_factor"] < 999 else "   inf"
        print(
            f"{rank:>4} {s['label']:>12} | {s['n_days']:>4} {s['n_trades']:>6} {s['trades_per_day']:>6.1f} "
            f"{s['total_pnl']:>10.2f} {s['sortino']:>8.3f} {s['sharpe']:>7.3f} {s['win_rate']:>5.1f} "
            f"{s['avg_win']:>8.2f} {s['avg_loss']:>8.2f} {pf_str} {s['max_drawdown']:>8.2f} | "
            f"{s['pos_days']:>3}/{s['neg_days']:>3}{marker}"
        )

    print()
    if ranked:
        best = ranked[0]
        print(
            f"BEST: {best['label']} — Sortino={best['sortino']:.3f}, "
            f"Trades/Day={best['trades_per_day']:.1f}, WR={best['win_rate']:.1f}%, "
            f"PnL=${best['total_pnl']:.0f}"
        )


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    log.info(f"C1 Conviction Threshold Sweep")
    log.info(f"Config: {C1_CONFIG['desc']}")
    log.info(f"Thresholds: {[t['z'] for t in THRESHOLDS]}")
    log.info(f"Workers: {WORKERS}")

    dates = discover_dates()
    if not dates:
        log.error("No OOT dates found with both MBO + prediction files!")
        sys.exit(1)
    log.info(f"Found {len(dates)} OOT dates: {dates[0]} to {dates[-1]}")

    # Build all tasks
    tasks = []
    skipped = 0
    for thresh_cfg in THRESHOLDS:
        for date_str in dates:
            task = build_task(date_str, thresh_cfg)
            if task is not None:
                tasks.append(task)
            else:
                skipped += 1

    total_possible = len(THRESHOLDS) * len(dates)
    log.info(
        f"Tasks: {len(tasks)} new + {skipped} already done = {total_possible} total possible"
        f" ({len(THRESHOLDS)} variants x {len(dates)} dates)"
    )

    if tasks:
        t0 = time.time()
        ok = fail = 0

        with ProcessPoolExecutor(max_workers=WORKERS) as pool:
            futures = {pool.submit(run_task, t): t for t in tasks}
            for i, future in enumerate(as_completed(futures)):
                result = future.result()
                if result["status"] == "OK":
                    ok += 1
                else:
                    fail += 1
                    log.warning(
                        f"  FAIL: {result['label']} {result['date']}: "
                        f"{result.get('error', '')[:100]}"
                    )

                if (i + 1) % 30 == 0 or (i + 1) == len(tasks):
                    elapsed = time.time() - t0
                    rate = (i + 1) / elapsed * 60 if elapsed > 0 else 0
                    eta_min = (len(tasks) - i - 1) / rate if rate > 0 else 0
                    log.info(
                        f"Progress: {i+1}/{len(tasks)} ({ok} OK, {fail} FAIL) | "
                        f"{rate:.0f}/min | ETA: {eta_min:.1f}min"
                    )

        log.info(
            f"Execution complete: {ok} OK, {fail} FAIL in {(time.time()-t0)/60:.1f}min"
        )
    else:
        log.info("All tasks already completed!")

    # Aggregate and display results
    summary = []
    for thresh_cfg in THRESHOLDS:
        agg = aggregate_results(thresh_cfg["label"])
        if agg:
            agg["z_threshold"] = thresh_cfg["z"]
            summary.append(agg)

    if summary:
        print_results_table(summary)

        # Save summary JSON
        summary_file = OUTPUT_DIR / "conviction_threshold_sweep_summary.json"
        with open(summary_file, "w") as f:
            json.dump(
                {
                    "timestamp": datetime.now().isoformat(),
                    "card": "C1",
                    "config": C1_CONFIG,
                    "thresholds_tested": [t["z"] for t in THRESHOLDS],
                    "n_oot_days": len(dates),
                    "oot_range": f"{dates[0]} to {dates[-1]}",
                    "results": summary,
                },
                f,
                indent=2,
            )
        log.info(f"Summary saved: {summary_file}")
    else:
        log.warning("No results to aggregate!")


if __name__ == "__main__":
    main()
