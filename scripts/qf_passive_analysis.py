#!/usr/bin/env python3
"""
qf_passive_analysis.py - Aggregate qf_passive_lowvol fill_sim results.

Run on Jupiter after qf_passive_lowvol_jupiter.py completes:
  python3 /tmp/qf_passive_analysis.py

Reads per-day JSON files from:
  /home/jupiter/Lvl3Quant/data/processed/qf_passive_lowvol/

Ranks by Sortino ratio, prints top 30.
"""
import json
import re
from pathlib import Path
from collections import defaultdict
import numpy as np

RESULTS_DIR = Path("/home/jupiter/Lvl3Quant/data/processed/qf_passive_lowvol")
OUT_FILE = Path("/home/jupiter/qf_passive_analysis.json")

MIN_DAYS = 30  # minimum days to rank


def compute_sortino(pnls):
    if not pnls:
        return float("nan")
    ppd = np.mean(pnls)
    neg = [p for p in pnls if p < 0]
    if len(neg) < 3:
        return 999 if ppd > 0 else -999
    ds = np.std(neg)
    return float(ppd / ds) if ds > 0 else (999 if ppd > 0 else -999)


def parse_config(name):
    """Parse config from filename stem like hold10s_tp2_sl4_vp33_qf1.5"""
    info = {}
    m = re.search(r'hold(\d+)s', name)
    if m:
        info['hold_s'] = int(m.group(1))
    m = re.search(r'tp(\d+)', name)
    if m:
        info['tp'] = int(m.group(1))
    m = re.search(r'sl(\d+)', name)
    if m:
        info['sl'] = int(m.group(1))
    m = re.search(r'vp(\d+)', name)
    if m:
        info['vol_pct'] = int(m.group(1))
    m = re.search(r'qf([\d.]+)', name)
    if m:
        info['qf_thresh'] = float(m.group(1))
    return info


def main():
    print(f"Scanning {RESULTS_DIR}...")
    files = list(RESULTS_DIR.glob("*.json"))
    print(f"Found {len(files)} files")

    cfg_data = defaultdict(lambda: {"pnls": [], "trades": [], "wrs": [], "fill_rs": []})

    for fpath in files:
        # Config is filename stem minus leading YYYY-MM-DD_
        name = fpath.stem
        # Strip date prefix (first 11 chars: YYYY-MM-DD_)
        config = name[11:]
        try:
            with open(fpath) as f:
                d = json.load(f)
            pnl = d.get("total_pnl_dollars")
            n = d.get("total_trades") or d.get("total_filled", 0)
            wr = d.get("win_rate")
            fill_r = d.get("fill_rate")
            if pnl is not None:
                cfg_data[config]["pnls"].append(float(pnl))
            if n:
                cfg_data[config]["trades"].append(float(n))
            if wr is not None:
                cfg_data[config]["wrs"].append(float(wr))
            if fill_r is not None:
                cfg_data[config]["fill_rs"].append(float(fill_r))
        except Exception:
            pass

    print(f"Parsed {len(cfg_data)} unique configs")

    results = []
    for config, v in cfg_data.items():
        pnls = v["pnls"]
        if len(pnls) < MIN_DAYS:
            continue
        info = parse_config(config)
        sortino = compute_sortino(pnls)
        ppd = float(np.mean(pnls))
        total_pnl = float(sum(pnls))
        n_trades = float(np.mean(v["trades"])) if v["trades"] else 0
        avg_wr = float(np.mean(v["wrs"])) if v["wrs"] else 0
        avg_fill_r = float(np.mean(v["fill_rs"])) if v["fill_rs"] else 0
        pos_pct = float(sum(p > 0 for p in pnls) / len(pnls))
        max_dd = float(min(pnls))

        results.append({
            "config": config,
            "n_days": len(pnls),
            "sortino": round(sortino, 4),
            "pnl_per_day": round(ppd, 2),
            "total_pnl": round(total_pnl, 2),
            "pos_pct": round(pos_pct, 3),
            "max_loss_day": round(max_dd, 2),
            "n_trades_day": round(n_trades, 2),
            "win_rate": round(avg_wr, 4),
            "fill_rate": round(avg_fill_r, 4),
            **info,
        })

    results.sort(key=lambda x: x["sortino"], reverse=True)

    print(f"\n{'='*100}")
    print(f"QF PASSIVE LOWVOL ANALYSIS — {len(results)} configs with {MIN_DAYS}+ days")
    print(f"{'='*100}")
    print(f"\n{'CONFIG':<50} {'SORT':>6} {'PPD':>8} {'WR':>6} {'N/D':>6} {'FILL':>5} {'DAYS':>5}")
    for r in results[:30]:
        print(f"{r['config']:<50} {r['sortino']:>6.3f} {r['pnl_per_day']:>8.0f} "
              f"{r['win_rate']:>5.1%} {r['n_trades_day']:>6.1f} {r['fill_rate']:>4.1%} "
              f"{r['n_days']:>5d}")

    # Breakdown by key params
    print(f"\n{'='*50}")
    print("HOLD TIME BREAKDOWN (top sortino mean)")
    for hold_s in [10, 30, 60]:
        subset = [r for r in results if r.get("hold_s") == hold_s]
        if subset:
            top5 = sorted(subset, key=lambda x: x["sortino"], reverse=True)[:5]
            vals = [r["sortino"] for r in top5 if not np.isinf(r["sortino"])]
            avg_s = np.mean(vals) if vals else float("nan")
            print(f"  hold{hold_s}s: {len(subset)} configs, top5 avg sortino={avg_s:.3f}")

    print(f"\nVOL GATE BREAKDOWN")
    for vp in [33, 50]:
        subset = [r for r in results if r.get("vol_pct") == vp]
        if subset:
            top5 = sorted(subset, key=lambda x: x["sortino"], reverse=True)[:5]
            vals = [r["sortino"] for r in top5 if not np.isinf(r["sortino"])]
            avg_s = np.mean(vals) if vals else float("nan")
            print(f"  vp{vp}: {len(subset)} configs, top5 avg sortino={avg_s:.3f}")

    print(f"\nQF THRESHOLD BREAKDOWN")
    for qf in [1.5, 2.0, 2.5]:
        subset = [r for r in results if r.get("qf_thresh") == qf]
        if subset:
            top5 = sorted(subset, key=lambda x: x["sortino"], reverse=True)[:5]
            vals = [r["sortino"] for r in top5 if not np.isinf(r["sortino"])]
            avg_s = np.mean(vals) if vals else float("nan")
            print(f"  qf{qf}: {len(subset)} configs, top5 avg sortino={avg_s:.3f}")

    output = {
        "n_configs": len(results),
        "min_days": MIN_DAYS,
        "top30": results[:30],
        "all": results,
    }
    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nSaved to {OUT_FILE}")


if __name__ == "__main__":
    main()
