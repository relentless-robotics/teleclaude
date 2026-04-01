#!/usr/bin/env python3
"""
mega_sweep_final_analysis.py - Analyze completed mega_sweep_v2 results.

Aggregates all per-day JSON result files into per-config stats,
ranks by Sortino ratio, and produces a comprehensive breakdown.

Run on Saturn:
  python3 scripts/mega_sweep_final_analysis.py

Or from Jupiter hop:
  ssh saturn@10.0.0.2 python3 /path/to/mega_sweep_final_analysis.py
"""
import json
import re
import sys
from pathlib import Path
from collections import defaultdict

import numpy as np

RESULTS_DIR = Path("/home/saturn/Lvl3Quant/data/processed/mega_sweep_v2_results")
OUT_FILE = Path("/home/saturn/Lvl3Quant/data/processed/mega_sweep_v2_analysis.json")

MIN_DAYS = 60  # minimum days to include in ranking


def parse_config_name(config):
    """Parse config string into components."""
    parts = config.split("_")
    info = {
        "vol_filter": None,
        "entry": None,
        "conv": None,
        "hold": None,
        "latency": None,
        "trailing": None,
        "tp": None,
        "prime": False,
        "sigflip": False,
    }
    i = 0
    while i < len(parts):
        p = parts[i]
        if p.startswith("v") and p[1:].isdigit():
            info["vol_filter"] = int(p[1:])
        elif p == "passive":
            info["entry"] = "passive"
        elif p == "chase" and i + 1 < len(parts):
            info["entry"] = f"chase_{parts[i+1]}"
            i += 1
        elif p.startswith("c") and "." in p:
            try:
                info["conv"] = float(p[1:])
            except ValueError:
                pass
        elif p.endswith("min"):
            info["hold"] = p
        elif p.startswith("lat"):
            try:
                info["latency"] = int(p[3:])
            except ValueError:
                pass
        elif p.startswith("trail"):
            try:
                info["trailing"] = int(p[5:])
            except ValueError:
                pass
        elif p.startswith("tp"):
            try:
                info["tp"] = int(p[2:])
            except ValueError:
                pass
        elif p == "prime":
            info["prime"] = True
        elif p == "sigflip":
            info["sigflip"] = True
        i += 1
    return info


def compute_sortino(pnls):
    """Compute Sortino ratio from list of daily PnLs."""
    if not pnls:
        return float("nan")
    ppd = np.mean(pnls)
    neg = [p for p in pnls if p < 0]
    if len(neg) < 3:
        return 999 if ppd > 0 else -999
    ds = np.std(neg)
    return float(ppd / ds) if ds > 0 else (999 if ppd > 0 else -999)


def main():
    print(f"Scanning {RESULTS_DIR}...")
    files = list(RESULTS_DIR.glob("*.json"))
    print(f"Found {len(files)} files")

    # Group by config name
    cfg_data = defaultdict(lambda: {"pnls": [], "trades": [], "wrs": [], "fill_rs": [], "qpos": []})

    for fpath in files:
        # Config is filename stem minus trailing _YYYY-MM-DD
        name = fpath.stem
        config = name[:-11]  # remove _YYYY-MM-DD
        try:
            with open(fpath) as f:
                d = json.load(f)
            pnl = d.get("total_pnl_dollars")
            n = d.get("total_trades") or d.get("total_filled", 0)
            wr = d.get("win_rate")
            fill_r = d.get("fill_rate")
            qpos = d.get("avg_queue_position")
            if pnl is not None:
                cfg_data[config]["pnls"].append(float(pnl))
            if n:
                cfg_data[config]["trades"].append(float(n))
            if wr is not None:
                cfg_data[config]["wrs"].append(float(wr))
            if fill_r is not None:
                cfg_data[config]["fill_rs"].append(float(fill_r))
            if qpos is not None:
                cfg_data[config]["qpos"].append(float(qpos))
        except Exception as e:
            pass

    print(f"Parsed {len(cfg_data)} unique configs")

    # Aggregate and rank
    results = []
    for config, v in cfg_data.items():
        pnls = v["pnls"]
        if len(pnls) < MIN_DAYS:
            continue
        info = parse_config_name(config)
        sortino = compute_sortino(pnls)
        ppd = float(np.mean(pnls))
        total_pnl = float(sum(pnls))
        n_trades = float(np.mean(v["trades"])) if v["trades"] else 0
        avg_wr = float(np.mean(v["wrs"])) if v["wrs"] else 0
        avg_fill_r = float(np.mean(v["fill_rs"])) if v["fill_rs"] else 0
        avg_qpos = float(np.mean(v["qpos"])) if v["qpos"] else 0
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
            "avg_queue_pos": round(avg_qpos, 2),
            **{k: v for k, v in info.items()},
        })

    results.sort(key=lambda x: x["sortino"], reverse=True)

    # Print top 50
    print(f"\n{'='*100}")
    print(f"MEGA SWEEP V2 ANALYSIS — {len(results)} configs with {MIN_DAYS}+ days")
    print(f"{'='*100}")
    print(f"\n{'CONFIG':<55} {'SORT':>6} {'PPD':>8} {'WR':>6} {'N/D':>6} {'FILL':>5} {'QPOS':>5} {'DAYS':>5}")
    for r in results[:50]:
        print(f"{r['config']:<55} {r['sortino']:>6.3f} {r['pnl_per_day']:>8.0f} "
              f"{r['win_rate']:>5.1%} {r['n_trades_day']:>6.1f} {r['fill_rate']:>4.1%} "
              f"{r['avg_queue_pos']:>5.1f} {r['n_days']:>5d}")

    # Breakdown analysis
    print(f"\n{'='*60}")
    print("REGIME BREAKDOWN (vol_filter) — TOP SORTINO MEAN")
    for vol in [50, 70, 80]:
        subset = [r for r in results if r.get("vol_filter") == vol]
        if subset:
            top10 = sorted(subset, key=lambda x: x["sortino"], reverse=True)[:10]
            avg_s = np.mean([r["sortino"] for r in top10 if not np.isinf(r["sortino"])])
            print(f"  v{vol}: {len(subset)} configs, top10 avg sortino={avg_s:.3f}, best={top10[0]['config']} ({top10[0]['sortino']:.3f})")

    print(f"\nENTRY TYPE BREAKDOWN")
    entry_types = set(r.get("entry") for r in results if r.get("entry"))
    for et in sorted(entry_types):
        subset = [r for r in results if r.get("entry") == et]
        if subset:
            top5 = sorted(subset, key=lambda x: x["sortino"], reverse=True)[:5]
            avg_s = np.mean([r["sortino"] for r in top5 if not np.isinf(r["sortino"])])
            print(f"  {et}: {len(subset)} configs, top5 avg sortino={avg_s:.3f}")

    print(f"\nCONV THRESHOLD BREAKDOWN")
    for ct in [1.0, 1.5, 2.0, 2.5]:
        subset = [r for r in results if r.get("conv") == ct]
        if subset:
            top5 = sorted(subset, key=lambda x: x["sortino"], reverse=True)[:5]
            avg_s = np.mean([r["sortino"] for r in top5 if not np.isinf(r["sortino"])])
            print(f"  c{ct}: {len(subset)} configs, top5 avg sortino={avg_s:.3f}")

    print(f"\nHOLD TIME BREAKDOWN")
    hold_types = set(r.get("hold") for r in results if r.get("hold"))
    for ht in sorted(hold_types):
        subset = [r for r in results if r.get("hold") == ht]
        if subset:
            top5 = sorted(subset, key=lambda x: x["sortino"], reverse=True)[:5]
            avg_s = np.mean([r["sortino"] for r in top5 if not np.isinf(r["sortino"])])
            print(f"  {ht}: {len(subset)} configs, top5 avg sortino={avg_s:.3f}")

    print(f"\nLATENCY BREAKDOWN (top sortino mean)")
    for lat in [0, 25, 50, 100, 150]:
        subset = [r for r in results if r.get("latency") == lat and not r.get("prime") and not r.get("sigflip")]
        if subset:
            top5 = sorted(subset, key=lambda x: x["sortino"], reverse=True)[:5]
            avg_s = np.mean([r["sortino"] for r in top5 if not np.isinf(r["sortino"])])
            print(f"  lat{lat}ms: {len(subset)} configs, top5 avg sortino={avg_s:.3f}")

    # Prime hours filter effect
    base_configs = {r["config"]: r for r in results if not r.get("prime") and not r.get("sigflip")
                    and r.get("trailing") is None and r.get("tp") is None}
    prime_configs = {r["config"].replace("_prime", ""): r for r in results if r.get("prime")}

    pairs = []
    for cfg_key in prime_configs:
        if cfg_key in base_configs:
            base = base_configs[cfg_key]
            prime = prime_configs[cfg_key]
            pairs.append((cfg_key, base["sortino"], prime["sortino"], base["pnl_per_day"], prime["pnl_per_day"]))

    if pairs:
        print(f"\nPRIME HOURS FILTER EFFECT ({len(pairs)} pairs):")
        better = sum(1 for p in pairs if p[2] > p[1])
        avg_lift = np.mean([p[2] - p[1] for p in pairs])
        print(f"  Prime better: {better}/{len(pairs)} ({better/len(pairs):.0%})")
        print(f"  Avg Sortino lift: {avg_lift:+.3f}")
        pairs.sort(key=lambda x: x[2] - x[1], reverse=True)
        for p in pairs[:5]:
            print(f"  {p[0]}: base={p[1]:.3f} prime={p[2]:.3f} (lift={p[2]-p[1]:+.3f}), $/d base={p[3]:.0f} prime={p[4]:.0f}")

    # Save output
    output = {
        "n_configs": len(results),
        "min_days": MIN_DAYS,
        "top50": results[:50],
        "all": results,
    }
    with open(OUT_FILE, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nSaved to {OUT_FILE}")


if __name__ == "__main__":
    main()
