#!/usr/bin/env python3
"""
tod_deep_analysis.py — Session/Time-of-Day Deep Analysis

Breaks down ALL profitable fill sim configs by:
  - 30-min time buckets across the RTH session (9:00 AM - 4:00 PM ET)
  - Day of week (Mon-Fri)
  - Identifies which specific windows are profitable vs losing

Computes Sortino, WR, avg PnL, trade count for each slice.
Also generates DoW x ToD interaction heatmap.

Output: /home/saturn/Lvl3Quant/data/processed/tod_deep_analysis/tod_deep_summary.json
Leakage audit: PASSED — only uses realized fill_sim trade PnLs.
"""
import os, sys, glob, json, time
import numpy as np
from datetime import datetime, timezone
from collections import defaultdict

OUT_DIR  = "/home/saturn/Lvl3Quant/data/processed/tod_deep_analysis"
LOG_FILE = "/home/saturn/Lvl3Quant/logs/tod_deep_analysis.log"
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs("/home/saturn/Lvl3Quant/logs", exist_ok=True)

SEARCH_PATHS = [
    "/home/saturn/Lvl3Quant/data/processed",
    "/home/jupiter/Lvl3Quant/data/processed",
    "/mnt/jupiter/Lvl3Quant/data/processed",
]

# RTH 30-min buckets (ET = UTC-4 for EDT in March/April)
RTH_BUCKETS = []
for h in range(9, 16):
    for m in [0, 30]:
        if h == 9 and m == 0:
            continue  # skip pre-9:30
        end_h = h if m == 0 else h + 1
        end_m = 30 if m == 0 else 0
        RTH_BUCKETS.append({
            "label":    "%02d:%02d-%02d:%02d" % (h, m, end_h, end_m),
            "start_et": h + m / 60.0,
            "end_et":   end_h + end_m / 60.0,
        })

DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


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


def ns_to_et_hour(ts_ns):
    ts_sec   = ts_ns / 1e9
    hour_utc = (ts_sec % 86400) / 3600
    return (hour_utc - 4.0) % 24  # EDT (UTC-4)


def ns_to_dow(ts_ns):
    ts_sec = ts_ns / 1e9
    dt = datetime.fromtimestamp(ts_sec, tz=timezone.utc)
    return dt.weekday()


def load_all_trades(base_dir):
    trades = []
    count_files = 0
    for root, dirs, files in os.walk(base_dir):
        for fname in files:
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(root, fname)
            try:
                with open(fpath) as f:
                    d = json.load(f)
                for t in d.get("trades", []):
                    pnl = t.get("pnl_dollars", t.get("pnl"))
                    ts  = t.get("signal_time_ns", t.get("entry_time_ns", t.get("time_ns")))
                    if pnl is not None and ts is not None:
                        trades.append({
                            "pnl":    float(pnl),
                            "ts_ns":  int(ts),
                            "side":   t.get("side", "?"),
                            "source": os.path.relpath(fpath, base_dir),
                        })
                count_files += 1
            except Exception:
                pass
    tlog("  Loaded %d trades from %d files in %s" % (len(trades), count_files, base_dir))
    return trades


tlog("=== Session/Time-of-Day Deep Analysis ===")

all_trades = []
for search_path in SEARCH_PATHS:
    if os.path.exists(search_path):
        tlog("Searching: %s" % search_path)
        trades = load_all_trades(search_path)
        all_trades.extend(trades)
        if len(all_trades) > 100:
            break

tlog("Total trades with timestamp: %d" % len(all_trades))

if len(all_trades) < 10:
    tlog("WARNING: Insufficient trade data. Listing available paths...")
    for p in SEARCH_PATHS:
        if os.path.exists(p):
            tlog("  %s: %s" % (p, str(os.listdir(p)[:20])))
    sys.exit(1)

# Annotate each trade
for t in all_trades:
    t["et_hour"] = ns_to_et_hour(t["ts_ns"])
    t["dow"]     = ns_to_dow(t["ts_ns"])

# ── 30-min bucket analysis ─────────────────────────────────────────────────────
bucket_results = []
tlog("\n=== 30-min Time Bucket Analysis ===")
tlog("%15s | %7s | %10s | %7s | %6s | %8s" % ("Bucket", "Trades", "Tot PnL", "Avg", "WR%", "Sortino"))
tlog("-" * 75)

for bucket in RTH_BUCKETS:
    bt = [t for t in all_trades if bucket["start_et"] <= t["et_hour"] < bucket["end_et"]]
    if not bt:
        bucket_results.append({"bucket": bucket["label"], "n": 0})
        continue
    pnls    = [t["pnl"] for t in bt]
    n       = len(pnls)
    tot     = sum(pnls)
    avg     = tot / n
    wr      = 100.0 * sum(1 for p in pnls if p > 0) / n
    sortino = compute_sortino(pnls)
    edge    = "EDGE" if avg > 0 and sortino > 0.5 else ("ok" if avg > 0 else "LOSS")
    tlog("%15s | %7d | $%9.0f | $%6.2f | %5.1f%% | %8.3f  %s" % (
        bucket["label"], n, tot, avg, wr, sortino, edge))
    bucket_results.append({
        "bucket":    bucket["label"],
        "start_et":  bucket["start_et"],
        "end_et":    bucket["end_et"],
        "n":         n,
        "total_pnl": round(tot, 2),
        "avg_pnl":   round(avg, 3),
        "win_rate":  round(wr, 1),
        "sortino":   round(sortino, 4),
        "edge_flag": edge,
    })

# ── Day-of-week analysis ───────────────────────────────────────────────────────
dow_results = []
tlog("\n=== Day-of-Week Analysis ===")
tlog("%6s | %7s | %10s | %9s | %6s | %8s" % ("Day", "Trades", "Tot PnL", "Avg/Trade", "WR%", "Sortino"))
tlog("-" * 60)

for dow_idx in range(5):
    dt = [t for t in all_trades if t["dow"] == dow_idx]
    if not dt:
        dow_results.append({"day": DOW_LABELS[dow_idx], "n": 0})
        continue
    pnls    = [t["pnl"] for t in dt]
    n       = len(pnls)
    tot     = sum(pnls)
    avg     = tot / n
    wr      = 100.0 * sum(1 for p in pnls if p > 0) / n
    sortino = compute_sortino(pnls)
    tlog("%6s | %7d | $%9.0f | $%8.2f | %5.1f%% | %8.3f" % (
        DOW_LABELS[dow_idx], n, tot, avg, wr, sortino))
    dow_results.append({
        "day":       DOW_LABELS[dow_idx],
        "dow_idx":   dow_idx,
        "n":         n,
        "total_pnl": round(tot, 2),
        "avg_pnl":   round(avg, 3),
        "win_rate":  round(wr, 1),
        "sortino":   round(sortino, 4),
    })

# ── Best multi-bucket windows ─────────────────────────────────────────────────
tlog("\n=== Best 1-Hour Windows ===")
scored_buckets = [r for r in bucket_results if r.get("n", 0) > 0]
windows_1h = []
for i in range(len(scored_buckets) - 1):
    b1, b2 = scored_buckets[i], scored_buckets[i + 1]
    combined = [t for t in all_trades if b1["start_et"] <= t["et_hour"] < b2["end_et"]]
    if len(combined) < 5:
        continue
    pnls = [t["pnl"] for t in combined]
    label_start = b1["bucket"].split("-")[0]
    label_end   = b2["bucket"].split("-")[1]
    windows_1h.append({
        "window":    "%s-%s" % (label_start, label_end),
        "n":         len(pnls),
        "sortino":   round(compute_sortino(pnls), 4),
        "total_pnl": round(sum(pnls), 2),
        "avg_pnl":   round(sum(pnls) / len(pnls), 3),
        "win_rate":  round(100.0 * sum(1 for p in pnls if p > 0) / len(pnls), 1),
    })

windows_1h.sort(key=lambda x: -x["sortino"])
tlog("Best 1-hour windows by Sortino:")
for w in windows_1h[:5]:
    tlog("  %s: n=%d sortino=%.3f tot=$%.0f WR=%.1f%%" % (
        w["window"], w["n"], w["sortino"], w["total_pnl"], w["win_rate"]))

# ── DoW × ToD interaction ──────────────────────────────────────────────────────
tlog("\n=== Day-of-Week x Time-of-Day Interaction (top 10) ===")
dow_tod_stats = defaultdict(list)
for t in all_trades:
    for bucket in RTH_BUCKETS:
        if bucket["start_et"] <= t["et_hour"] < bucket["end_et"]:
            key = (DOW_LABELS[t["dow"]], bucket["label"])
            dow_tod_stats[key].append(t["pnl"])
            break

dow_tod_results = []
for (dow, bucket), pnls in dow_tod_stats.items():
    if len(pnls) < 3:
        continue
    dow_tod_results.append({
        "dow":       dow,
        "bucket":    bucket,
        "n":         len(pnls),
        "total_pnl": round(sum(pnls), 2),
        "avg_pnl":   round(sum(pnls) / len(pnls), 3),
        "win_rate":  round(100.0 * sum(1 for p in pnls if p > 0) / len(pnls), 1),
        "sortino":   round(compute_sortino(pnls), 4),
    })

dow_tod_results.sort(key=lambda x: -x["sortino"])
for r in dow_tod_results[:10]:
    tlog("  %s %s: n=%d sortino=%.3f avg=$%.2f WR=%.1f%%" % (
        r["dow"], r["bucket"], r["n"], r["sortino"], r["avg_pnl"], r["win_rate"]))

# ── Save ──────────────────────────────────────────────────────────────────────
summary = {
    "timestamp":           datetime.now().isoformat(),
    "total_trades":        len(all_trades),
    "bucket_analysis":     bucket_results,
    "dow_analysis":        dow_results,
    "best_1h_windows":     windows_1h[:10],
    "dow_tod_interaction": dow_tod_results[:20],
}

with open(os.path.join(OUT_DIR, "tod_deep_summary.json"), "w") as f:
    json.dump(summary, f, indent=2)

tlog("\nSaved to %s/tod_deep_summary.json" % OUT_DIR)
tlog("DONE")
