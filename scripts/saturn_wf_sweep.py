#!/usr/bin/env python3
"""
saturn_wf_sweep.py
Saturn complementary parameter sweep - different configs from Jupiter to maximize coverage.

SATURN SWEEP DIMENSIONS (~24 configs x 68 days = 1632 jobs):

1. Fine TP/SL asymmetry grid:
   - TP 13-18, SL 8-30 tick sweep (asymmetric: wider SL than TP to catch momentum)

2. Multi-timeframe hold sweep (prime+chase base):
   - 5min, 10min, 20min, 30min, 45min, 60min, 90min, 120min

3. Conviction exit bars sweep:
   - 10, 30, 60, 100, 200, 500 bars (1s to 50s delay before flip exit)

4. Queue position filter:
   - Top 10, top 20, top 30, top 50 queue position filter

5. Latency + exit slippage combos (realistic execution cost model):
   - (5ms, 0.0t), (10ms, 0.1t), (20ms, 0.2t), (50ms, 0.3t)

6. Combined: best expected config candidates
   - TP15 prime+chase no SL (hold to MFE), TP18 prime+chase SL20, etc.

Runs on Saturn's 48 CPUs. Uses fill_sim_cli Rust binary.
Predictions synced from Jupiter via rsync.

Run:  nohup python3 saturn_wf_sweep.py > /tmp/saturn_sweep.log 2>&1 &
"""

import os
import json
import math
import time
import logging
import subprocess
import numpy as np
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

FILL_SIM    = "/home/saturn/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli"
MBO_DIR     = Path("/home/saturn/Lvl3Quant/data/raw/mbo")
PER_DAY_DIR = Path("/home/saturn/Lvl3Quant/data/processed/wider_cnn_preds/per_day_oos")
OUTPUT_DIR  = Path("/home/saturn/Lvl3Quant/data/processed/oos_wf_fill_sim/saturn_sweep")
SUMMARY_FILE = Path("/home/saturn/Lvl3Quant/data/processed/oos_wf_fill_sim/saturn_sweep_summary.json")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Saturn: 48 CPUs, current load ~8 -> 40 workers is safe
WORKERS = 40

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.FileHandler("/tmp/saturn_sweep.log"),
        logging.StreamHandler(),
    ]
)
log = logging.getLogger("saturn_sweep")


def _mbo_path(date_str):
    d = date_str.replace("-", "")
    return MBO_DIR / f"glbx-mdp3-{d}.mbo.dbn.zst"

def _pred_path(date_str):
    return PER_DAY_DIR / f"{date_str}_preds.npz"

def _available_dates():
    dates = []
    for p in sorted(PER_DAY_DIR.glob("*_preds.npz")):
        d = p.name.replace("_preds.npz", "")
        if _mbo_path(d).exists():
            dates.append(d)
    return dates


def build_configs():
    configs = []

    # ── 1. ASYMMETRIC TP/SL GRID ──────────────────────────────────────
    # Key insight: SL wider than TP exploits positive skew / conviction
    for tp in [12, 13, 15, 18]:
        for sl in [8, 12, 18, 25, 30]:
            for style, extra in [
                ("h2h",         []),
                ("prime_chase", ["--prime-hours", "--chase-entry"]),
            ]:
                if sl == tp:  # skip symmetric (already covered by Jupiter)
                    continue
                configs.append({
                    "name":     f"asym_tp{tp}_sl{sl}_{style}",
                    "tp":       tp,
                    "sl":       sl,
                    "sig":      0.1,
                    "latency":  10,
                    "hold_ms":  7_200_000,
                    "extra":    extra,
                    "group":    "asym_tpsl",
                })

    # ── 2. MULTI-TIMEFRAME HOLD SWEEP ─────────────────────────────────
    hold_seconds = [300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200]
    for hold_s in hold_seconds:
        configs.append({
            "name":     f"hold_{hold_s}s_prime_chase_tp15",
            "tp":       15,
            "sl":       20,
            "sig":      0.1,
            "latency":  10,
            "hold_ms":  hold_s * 1000,
            "extra":    ["--prime-hours", "--chase-entry"],
            "group":    "hold_sweep",
        })

    # ── 3. CONVICTION EXIT BARS SWEEP ─────────────────────────────────
    # How long must signal be reversed before we exit?
    for bars in [10, 30, 60, 100, 200, 500]:
        for mag in [0.0, 0.3]:
            label_mag = f"_mag{int(mag*10)}" if mag > 0 else ""
            configs.append({
                "name":     f"conviction_{bars}b{label_mag}_tp15_prime",
                "tp":       15,
                "sl":       20,
                "sig":      0.1,
                "latency":  10,
                "hold_ms":  7_200_000,
                "extra":    [
                    "--prime-hours", "--chase-entry",
                    f"--conviction-exit-bars {bars}",
                    f"--conviction-exit-mag {mag}",
                ],
                "group":    "conviction_exit",
            })

    # ── 4. QUEUE POSITION FILTER ──────────────────────────────────────
    # Only trade when we have a good queue position
    for max_q in [5, 10, 20, 30, 50]:
        configs.append({
            "name":     f"qpos_max{max_q}_tp15_prime",
            "tp":       15,
            "sl":       20,
            "sig":      0.1,
            "latency":  10,
            "hold_ms":  7_200_000,
            "extra":    [
                "--prime-hours", "--chase-entry",
                f"--max-queue-pos {max_q}",
            ],
            "group":    "queue_filter",
        })

    # ── 5. LATENCY + EXIT SLIPPAGE COMBOS ─────────────────────────────
    lat_slip_combos = [
        (0,  0.0,  "retail_fast"),
        (5,  0.0,  "colocated"),
        (10, 0.1,  "standard"),
        (20, 0.15, "moderate"),
        (50, 0.25, "slow"),
        (100, 0.4, "very_slow"),
    ]
    for lat_ms, slip, label in lat_slip_combos:
        configs.append({
            "name":     f"exec_{label}_tp15_prime",
            "tp":       15,
            "sl":       20,
            "sig":      0.1,
            "latency":  lat_ms,
            "hold_ms":  7_200_000,
            "extra":    [
                "--prime-hours", "--chase-entry",
                f"--exit-slippage {slip}",
            ],
            "group":    "exec_cost",
        })

    # ── 6. COMBINED CANDIDATES ────────────────────────────────────────
    # Best-guess combos based on theory and initial results
    # No-SL (hold until TP): relies entirely on signal quality
    configs.append({
        "name":     "no_sl_tp15_prime_chase",
        "tp":       15,
        "sl":       0,
        "sig":      0.1,
        "latency":  10,
        "hold_ms":  7_200_000,
        "extra":    ["--prime-hours", "--chase-entry"],
        "group":    "combined_candidates",
    })
    configs.append({
        "name":     "no_sl_tp13_prime_chase",
        "tp":       13,
        "sl":       0,
        "sig":      0.1,
        "latency":  10,
        "hold_ms":  7_200_000,
        "extra":    ["--prime-hours", "--chase-entry"],
        "group":    "combined_candidates",
    })
    # Ratchet stop with no fixed SL (lock in profits only)
    configs.append({
        "name":     "ratchet_no_sl_tp15_prime",
        "tp":       15,
        "sl":       0,
        "sig":      0.1,
        "latency":  10,
        "hold_ms":  7_200_000,
        "extra":    ["--prime-hours", "--chase-entry", "--ratchet-stop"],
        "group":    "combined_candidates",
    })
    # Aggressive TP with tight SL
    configs.append({
        "name":     "tp20_sl10_prime_chase",
        "tp":       20,
        "sl":       10,
        "sig":      0.1,
        "latency":  10,
        "hold_ms":  7_200_000,
        "extra":    ["--prime-hours", "--chase-entry"],
        "group":    "combined_candidates",
    })
    # Higher threshold with bigger TP
    configs.append({
        "name":     "tp18_sl15_z20_prime_chase",
        "tp":       18,
        "sl":       15,
        "sig":      0.2,
        "latency":  10,
        "hold_ms":  7_200_000,
        "extra":    ["--prime-hours", "--chase-entry"],
        "group":    "combined_candidates",
    })

    return configs


def run_one(date_str, cfg):
    mbo  = _mbo_path(date_str)
    pred = _pred_path(date_str)
    name = cfg["name"]
    out  = OUTPUT_DIR / f"{date_str}_{name}.json"

    if out.exists():
        try:
            with open(out) as f:
                r = json.load(f)
            r["config"] = name
            r["date"]   = date_str
            r["group"]  = cfg.get("group", "")
            return r
        except Exception:
            out.unlink(missing_ok=True)

    if not mbo.exists() or not pred.exists():
        return {"error": "missing_files", "date": date_str, "config": name}

    cmd = [
        FILL_SIM,
        "--mbo-file",          str(mbo),
        "--predictions",       str(pred),
        "--output",            str(out),
        "--signal-threshold",  str(cfg["sig"]),
        "--latency-ms",        str(cfg["latency"]),
        "--hold-ms",           str(cfg["hold_ms"]),
        "--quiet",
    ]
    if cfg.get("tp", 0) > 0:
        cmd += ["--take-profit-ticks", str(cfg["tp"])]
    if cfg.get("sl", 0) > 0:
        cmd += ["--stop-loss-ticks", str(cfg["sl"])]
    for flag in cfg.get("extra", []):
        cmd.extend(flag.split())

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if res.returncode != 0:
            return {"error": "fill_sim_failed", "exitcode": res.returncode,
                    "stderr": res.stderr[-300:], "date": date_str, "config": name}
        if out.exists():
            with open(out) as f:
                r = json.load(f)
            r["config"] = name
            r["date"]   = date_str
            r["group"]  = cfg.get("group", "")
            return r
        return {"error": "no_output", "date": date_str, "config": name}
    except subprocess.TimeoutExpired:
        return {"error": "timeout", "date": date_str, "config": name}
    except Exception as e:
        return {"error": str(e), "date": date_str, "config": name}


def _pnl(r):
    for k in ("total_pnl_dollars", "total_pnl", "net_pnl", "pnl"):
        v = r.get(k)
        if v is not None:
            try:
                f = float(v)
                if not (math.isnan(f) or math.isinf(f)):
                    return f
            except Exception:
                pass
    return 0.0

def _trades(r):
    for k in ("total_trades", "total_filled", "n_trades"):
        v = r.get(k)
        if isinstance(v, (int, float)) and v >= 0:
            return int(v)
    return 0

def _wr(r):
    for k in ("win_rate", "wr"):
        v = r.get(k)
        if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
            return float(v)
    t = _trades(r)
    if t > 0:
        for k in ("total_wins", "n_wins", "wins"):
            w = r.get(k)
            if w is not None:
                return int(w) / t
    return 0.0

def _fill_rate(r):
    for k in ("fill_rate", "fill_rate_pct"):
        v = r.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    sig = r.get("total_signals") or r.get("total_posted", 0)
    fil = r.get("total_filled", 0)
    return fil / sig if sig else 0.0


def summarize(results):
    from collections import defaultdict
    by_cfg = defaultdict(list)
    for r in results:
        if "error" not in r:
            by_cfg[r["config"]].append(r)
    summary = {}
    for cfg_name in sorted(by_cfg):
        runs = by_cfg[cfg_name]
        pnls   = [_pnl(r) for r in runs]
        trades = [_trades(r) for r in runs]
        wrs    = [_wr(r) for r in runs]
        fills  = [_fill_rate(r) for r in runs]
        total_pnl    = sum(pnls)
        total_trades = sum(trades)
        days         = len(runs)
        avg_daily    = total_pnl / days if days > 0 else 0.0
        total_t      = sum(trades)
        avg_wr       = sum(w * t for w, t in zip(wrs, trades)) / total_t if total_t > 0 else 0.0
        avg_fill     = sum(fills) / len(fills) if fills else 0.0
        arr = np.array(pnls)
        sharpe = sortino = 0.0
        if len(arr) > 1 and arr.std() > 1e-9:
            sharpe = float(arr.mean() / arr.std() * 252 ** 0.5)
        neg = arr[arr < 0]
        if len(neg) > 1 and neg.std() > 1e-9:
            sortino = float(arr.mean() / neg.std() * 252 ** 0.5)
        summary[cfg_name] = {
            "total_pnl_dollars":  round(total_pnl, 2),
            "avg_daily_pnl":      round(avg_daily, 2),
            "sharpe_annual":      round(sharpe, 3),
            "sortino_annual":     round(sortino, 3),
            "pct_profitable_days": round(float((arr > 0).mean()), 3),
            "total_trades":       total_trades,
            "avg_win_rate":       round(avg_wr, 4),
            "avg_fill_rate_pct":  round(avg_fill * 100, 1),
            "days":               days,
            "group":              runs[0].get("group", ""),
        }
    return summary


def main():
    start   = time.time()
    dates   = _available_dates()
    configs = build_configs()

    log.info(f"Dates: {len(dates)}  Configs: {len(configs)}")
    log.info(f"Total jobs: {len(dates) * len(configs)}")
    log.info(f"Dates range: {dates[0]} — {dates[-1]}")
    log.info(f"Workers: {WORKERS}")

    if len(dates) == 0:
        log.error("No dates found! Check that predictions were synced from Jupiter.")
        log.error(f"  PER_DAY_DIR: {PER_DAY_DIR}")
        return

    jobs = []
    skipped = 0
    for date in dates:
        for cfg in configs:
            out = OUTPUT_DIR / f"{date}_{cfg['name']}.json"
            if not out.exists():
                jobs.append((date, cfg))
            else:
                skipped += 1

    log.info(f"Jobs queued: {len(jobs)}  (skipped: {skipped})")

    results = []
    for date in dates:
        for cfg in configs:
            out = OUTPUT_DIR / f"{date}_{cfg['name']}.json"
            if out.exists():
                try:
                    with open(out) as f:
                        r = json.load(f)
                    r["config"] = cfg["name"]
                    r["date"]   = date
                    r["group"]  = cfg.get("group", "")
                    results.append(r)
                except Exception:
                    pass

    done = errors = 0
    total = len(jobs)
    t_report = time.time()

    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(run_one, d, c): (d, c) for d, c in jobs}
        for fut in as_completed(futs):
            result = fut.result()
            results.append(result)
            if "error" in result:
                errors += 1
            done += 1
            if time.time() - t_report > 60 or done % 500 == 0:
                pct = done / total * 100 if total > 0 else 100
                ela = time.time() - start
                eta = (ela / done * (total - done)) / 60 if done > 0 and total > done else 0
                log.info(f"Progress: {done}/{total} ({pct:.0f}%)  err={errors}  "
                         f"elapsed={ela/60:.1f}min  ETA={eta:.0f}min")
                t_report = time.time()

    log.info(f"Complete. Results={len(results)}  errors={errors}")
    summary = summarize(results)

    with open(SUMMARY_FILE, "w") as f:
        json.dump({"summary": summary, "results": results}, f, indent=2)
    log.info(f"Summary saved to {SUMMARY_FILE}")

    ranked = sorted(summary.items(), key=lambda x: x[1]["sortino_annual"], reverse=True)
    log.info("\n=== TOP 20 BY SORTINO ===")
    for name, s in ranked[:20]:
        log.info(f"  [{s['group']:<22}] {name:<48} "
                 f"Sortino={s['sortino_annual']:>7.3f}  "
                 f"PnL=${s['total_pnl_dollars']:>10,.0f}  "
                 f"WR={s['avg_win_rate']:.1%}  "
                 f"Fill={s['avg_fill_rate_pct']:>5.1f}%")

    log.info(f"\nTotal time: {(time.time()-start)/60:.1f} min")


if __name__ == "__main__":
    main()
