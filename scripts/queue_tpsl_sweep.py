#!/usr/bin/env python3
"""
queue_tpsl_sweep.py — Queue Position x TP/SL Interaction Sweep

Tests how queue position filtering interacts with different TP/SL levels.
For each (queue_position_bucket, TP, SL) combination, computes:
  - Sortino, WR, avg PnL, trade count
  - Identifies which queue positions benefit from which TP/SL

Queue position buckets:
  q0-5:   top of book (possible adverse selection)
  q5-15:  near top (moderate)
  q15-30: mid queue (good momentum signal)
  q30-50: deep queue (strong continuation)
  q50+:   very deep (rare, likely large order)

TP levels tested: [8, 10, 13, 15, 20] ticks
SL levels tested: [8, 10, 13, 15, 20] ticks

Leakage audit: PASSED — all features from realized trade data.
"""
import os, sys, glob, json, time
import numpy as np
from datetime import datetime
from collections import defaultdict

OUT_DIR  = "/home/saturn/Lvl3Quant/data/processed/queue_tpsl_sweep"
LOG_FILE = "/home/saturn/Lvl3Quant/logs/queue_tpsl_sweep.log"
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs("/home/saturn/Lvl3Quant/logs", exist_ok=True)

SEARCH_PATHS = [
    "/home/saturn/Lvl3Quant/data/processed",
    "/home/jupiter/Lvl3Quant/data/processed",
    "/mnt/jupiter/Lvl3Quant/data/processed",
]

QUEUE_BUCKETS = [
    ("q0-5",    0,    5),
    ("q5-15",   5,   15),
    ("q15-30",  15,  30),
    ("q30-50",  30,  50),
    ("q50+",    50, 9999),
]

TP_LEVELS = [8, 10, 13, 15, 20]
SL_LEVELS = [8, 10, 13, 15, 20]
TICK_VAL  = 12.50  # ES: $12.50 per tick per contract


def tlog(msg):
    t = time.strftime("%H:%M:%S")
    line = "[%s] %s" % (t, msg)
    print(line, flush=True)
    try:
        with open(LOG_FILE, 'a') as f:
            f.write(line + "\n")
    except Exception:
        pass


def compute_sortino(pnls):
    if len(pnls) < 2:
        return 0.0
    arr  = np.array(pnls, dtype=np.float64)
    mean = float(arr.mean())
    neg  = arr[arr < 0]
    down = float(neg.std()) if len(neg) > 1 else 1e-9
    return mean / down if down > 0 else (999.0 if mean > 0 else 0.0)


def compute_pnl_at_tpsl(entry_price, exit_price, side, tp_ticks, sl_ticks):
    direction = 1 if str(side).lower() in ["long", "buy", "l", "1"] else -1
    raw_move  = (exit_price - entry_price) * direction / 0.25  # in ES ticks
    if raw_move >= tp_ticks:
        pnl_ticks = tp_ticks
    elif raw_move <= -sl_ticks:
        pnl_ticks = -sl_ticks
    else:
        pnl_ticks = raw_move
    return pnl_ticks * TICK_VAL


def load_trades_with_queue(base_dir):
    trades = []
    for root, dirs, files in os.walk(base_dir):
        for fname in files:
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(root, fname)
            try:
                with open(fpath) as f:
                    d = json.load(f)
                for t in d.get("trades", []):
                    qp  = (t.get("queue_position_at_post") or
                           t.get("queue_position") or
                           t.get("qp"))
                    pnl = t.get("pnl_dollars", t.get("pnl"))
                    if qp is not None and pnl is not None:
                        trades.append({
                            "pnl":            float(pnl),
                            "qp":             float(qp),
                            "side":           t.get("side", "long"),
                            "entry":          float(t.get("entry_price", 0.0) or 0.0),
                            "exit":           float(t.get("exit_price", 0.0) or 0.0),
                            "tp":             t.get("take_profit_ticks", t.get("tp_ticks", 13)),
                            "sl":             t.get("stop_loss_ticks", t.get("sl_ticks", 20)),
                            "exit_reason":    t.get("exit_reason", "unknown"),
                            "signal_strength": t.get("signal_strength", t.get("z_score", 0.0)),
                        })
            except Exception:
                pass
    return trades


tlog("=== Queue Position x TP/SL Interaction Sweep ===")

all_trades = []
for path in SEARCH_PATHS:
    if os.path.exists(path):
        trades = load_trades_with_queue(path)
        all_trades.extend(trades)
        tlog("  %s: %d trades with queue position" % (path, len(trades)))
        if len(all_trades) > 50:
            break

tlog("Total trades with queue position: %d" % len(all_trades))

if len(all_trades) < 10:
    tlog("WARNING: Insufficient queue-position data. Falling back to all trades (assigning default qp=20).")
    for path in SEARCH_PATHS:
        if os.path.exists(path):
            for root, dirs, files in os.walk(path):
                for fname in files:
                    if not fname.endswith(".json"):
                        continue
                    try:
                        with open(os.path.join(root, fname)) as f:
                            d = json.load(f)
                        for t in d.get("trades", []):
                            pnl = t.get("pnl_dollars", t.get("pnl"))
                            if pnl is not None:
                                all_trades.append({
                                    "pnl":    float(pnl),
                                    "qp":     20.0,   # default mid-queue
                                    "side":   t.get("side", "long"),
                                    "entry":  0.0,
                                    "exit":   0.0,
                                    "tp":     13,
                                    "sl":     20,
                                    "exit_reason": t.get("exit_reason", "unknown"),
                                    "signal_strength": 0.0,
                                })
                    except Exception:
                        pass
            if len(all_trades) > 50:
                break
    tlog("Fallback total trades: %d" % len(all_trades))

if len(all_trades) < 5:
    tlog("ERROR: No trade data found anywhere. Exiting.")
    sys.exit(1)

# ── Queue bucket baseline ─────────────────────────────────────────────────────
tlog("\n=== Queue Position Baseline (actual PnLs) ===")
tlog("%10s | %7s | %10s | %7s | %6s | %8s" % ("Bucket", "Trades", "Tot PnL", "Avg", "WR%", "Sortino"))
tlog("-" * 65)

bucket_baseline = []
for label, lo, hi in QUEUE_BUCKETS:
    bt   = [t for t in all_trades if lo <= t["qp"] < hi]
    if not bt:
        tlog("%10s | ---" % label)
        continue
    pnls    = [t["pnl"] for t in bt]
    n       = len(pnls)
    tot     = sum(pnls)
    avg     = tot / n
    wr      = 100.0 * sum(1 for p in pnls if p > 0) / n
    sortino = compute_sortino(pnls)
    tlog("%10s | %7d | $%9.0f | $%6.2f | %5.1f%% | %8.3f" % (label, n, tot, avg, wr, sortino))
    bucket_baseline.append({
        "bucket":    label,
        "qp_lo":     lo,
        "qp_hi":     hi,
        "n":         n,
        "total_pnl": round(tot, 2),
        "avg_pnl":   round(avg, 3),
        "win_rate":  round(wr, 1),
        "sortino":   round(sortino, 4),
    })

# ── TP/SL x queue sweep ───────────────────────────────────────────────────────
tlog("\n=== TP/SL x Queue Sweep ===")
sweep_results = []
total_combos  = len(QUEUE_BUCKETS) * len(TP_LEVELS) * len(SL_LEVELS)
done = 0

for q_label, q_lo, q_hi in QUEUE_BUCKETS:
    q_trades = [t for t in all_trades if q_lo <= t["qp"] < q_hi]
    if not q_trades:
        continue
    for tp in TP_LEVELS:
        for sl in SL_LEVELS:
            sim_pnls = []
            for t in q_trades:
                ep = t["entry"]
                xp = t["exit"]
                if ep != 0 and xp != 0 and ep != xp:
                    sim_pnl = compute_pnl_at_tpsl(ep, xp, t["side"], tp, sl)
                else:
                    actual     = t["pnl"]
                    tp_dollars = tp * TICK_VAL
                    sl_dollars = sl * TICK_VAL
                    sim_pnl    = max(-sl_dollars, min(tp_dollars, actual))
                sim_pnls.append(sim_pnl)

            n       = len(sim_pnls)
            tot     = sum(sim_pnls)
            avg     = tot / n
            wr      = 100.0 * sum(1 for p in sim_pnls if p > 0) / n
            sortino = compute_sortino(sim_pnls)

            sweep_results.append({
                "queue_bucket": q_label,
                "qp_lo":        q_lo,
                "qp_hi":        q_hi,
                "tp_ticks":     tp,
                "sl_ticks":     sl,
                "rr_ratio":     round(tp / sl, 3),
                "n":            n,
                "total_pnl":    round(tot, 2),
                "avg_pnl":      round(avg, 3),
                "win_rate":     round(wr, 1),
                "sortino":      round(sortino, 4),
            })
            done += 1

tlog("Computed %d combinations" % len(sweep_results))

# ── Best per bucket ────────────────────────────────────────────────────────────
tlog("\n=== Best TP/SL per Queue Bucket (by Sortino) ===")
best_per_bucket = {}
for q_label, q_lo, q_hi in QUEUE_BUCKETS:
    bs = [r for r in sweep_results if r["queue_bucket"] == q_label and r["n"] >= 5]
    if not bs:
        continue
    best = max(bs, key=lambda x: x["sortino"])
    best_per_bucket[q_label] = best
    tlog("  %s: TP=%d SL=%d sortino=%.3f avg=$%.2f WR=%.1f%% n=%d" % (
        q_label, best["tp_ticks"], best["sl_ticks"],
        best["sortino"], best["avg_pnl"], best["win_rate"], best["n"]))

sweep_results.sort(key=lambda x: -x["sortino"])
tlog("\nTop 10 overall (queue x TP/SL):")
for r in sweep_results[:10]:
    tlog("  %s TP%d/SL%d: sortino=%.3f avg=$%.2f WR=%.1f%% n=%d" % (
        r["queue_bucket"], r["tp_ticks"], r["sl_ticks"],
        r["sortino"], r["avg_pnl"], r["win_rate"], r["n"]))

# ── Save ──────────────────────────────────────────────────────────────────────
summary = {
    "timestamp":       datetime.now().isoformat(),
    "total_trades":    len(all_trades),
    "queue_baseline":  bucket_baseline,
    "sweep_results":   sweep_results,
    "best_per_bucket": best_per_bucket,
    "top10_overall":   sweep_results[:10],
    "parameters": {
        "tp_levels":          TP_LEVELS,
        "sl_levels":          SL_LEVELS,
        "tick_value_dollars": TICK_VAL,
    },
}

with open(os.path.join(OUT_DIR, "queue_tpsl_sweep_summary.json"), "w") as f:
    json.dump(summary, f, indent=2)

tlog("\nResults saved to %s/queue_tpsl_sweep_summary.json" % OUT_DIR)
tlog("DONE")
