"""
MLflow backfill script — logs all 2026-03-27 experiment results.
Tracking URI: http://localhost:5000
"""

import json
import mlflow
from mlflow.tracking import MlflowClient

TRACKING_URI = "http://localhost:5000"
mlflow.set_tracking_uri(TRACKING_URI)
client = MlflowClient(tracking_uri=TRACKING_URI)

# ─────────────────────────────────────────────────────────────────────────────
# Helper
# ─────────────────────────────────────────────────────────────────────────────

def get_or_create_experiment(name: str) -> str:
    exp = client.get_experiment_by_name(name)
    if exp is None:
        exp_id = client.create_experiment(name)
        print(f"  Created experiment '{name}' id={exp_id}")
    else:
        exp_id = exp.experiment_id
        print(f"  Using existing experiment '{name}' id={exp_id}")
    return exp_id


# ─────────────────────────────────────────────────────────────────────────────
# 1. Conviction_Threshold_Sweep
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== Conviction_Threshold_Sweep ===")
exp_id = get_or_create_experiment("Conviction_Threshold_Sweep")

runs = [
    {
        "name": "C1_z0.1_baseline",
        "tags": {"card": "C1", "note": "baseline"},
        "params": {
            "card": "C1",
            "threshold": "0.1",
            "tp": "13",
            "sl": "20",
            "hold_ms": "3600000",
            "entry": "limit",
            "hours": "all",
        },
        "metrics": {
            "sortino": -1.629,
            "pnl": -3138.0,
            "trades": 1201.0,
            "trades_per_day": 20.7,
            "win_rate": 61.5,
            "oot_days": 58.0,
        },
    },
    {
        "name": "C1_z2.0_BEST",
        "tags": {"card": "C1", "note": "BEST_C1"},
        "params": {
            "card": "C1",
            "threshold": "2.0",
            "tp": "13",
            "sl": "20",
            "hold_ms": "3600000",
            "entry": "limit",
            "hours": "all",
        },
        "metrics": {
            "sortino": 2.046,
            "pnl": 3552.0,
            "trades": 876.0,
            "trades_per_day": 15.1,
            "win_rate": 63.2,
            "oot_days": 58.0,
        },
    },
    {
        "name": "C1_z2.5",
        "tags": {"card": "C1"},
        "params": {
            "card": "C1",
            "threshold": "2.5",
            "tp": "13",
            "sl": "20",
            "hold_ms": "3600000",
            "entry": "limit",
            "hours": "all",
        },
        "metrics": {
            "sortino": 1.363,
            "pnl": 2808.0,
            "trades": 473.0,
            "trades_per_day": 8.2,
            "win_rate": 63.6,
            "oot_days": 58.0,
        },
    },
    {
        "name": "C1_z2.0_chase_prime",
        "tags": {"card": "C1", "note": "chase_entry_prime_hours"},
        "params": {
            "card": "C1",
            "threshold": "2.0",
            "tp": "13",
            "sl": "20",
            "hold_ms": "3600000",
            "entry": "chase",
            "hours": "prime",
        },
        "metrics": {
            "sortino": -0.957,
            "pnl": -2836.0,
            "trades": 521.0,
            "trades_per_day": 9.0,
            "win_rate": 60.8,
            "oot_days": 58.0,
        },
    },
    {
        "name": "C4_z2.5_BEST",
        "tags": {"card": "C4", "note": "BEST_C4"},
        "params": {
            "card": "C4",
            "threshold": "2.5",
            "tp": "13",
            "sl": "20",
            "hold_ms": "3600000",
            "entry": "limit",
            "hours": "all",
        },
        "metrics": {
            "sortino": 4.339,
            "pnl": 4594.0,
            "trades": 190.0,
            "trades_per_day": 3.5,
            "win_rate": 66.8,
            "oot_days": 54.0,
        },
    },
    {
        "name": "C4_z0.1_baseline",
        "tags": {"card": "C4", "note": "baseline"},
        "params": {
            "card": "C4",
            "threshold": "0.1",
            "tp": "13",
            "sl": "20",
            "hold_ms": "3600000",
            "entry": "limit",
            "hours": "all",
        },
        "metrics": {
            "sortino": 1.661,
            "pnl": 3068.0,
            "trades": 286.0,
            "trades_per_day": 5.3,
            "win_rate": 65.7,
            "oot_days": 54.0,
        },
    },
]

for r in runs:
    with mlflow.start_run(experiment_id=exp_id, run_name=r["name"]):
        mlflow.set_tags(r["tags"])
        mlflow.log_params(r["params"])
        mlflow.log_metrics(r["metrics"])
    print(f"  Logged run: {r['name']}")

print(f"  Total runs logged: {len(runs)}")


# ─────────────────────────────────────────────────────────────────────────────
# 2. Dynamic_TP_Sweep  — read from sweep_summary_v2.json
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== Dynamic_TP_Sweep ===")
exp_id = get_or_create_experiment("Dynamic_TP_Sweep")

SWEEP_JSON = (
    r"C:\Users\Footb\Documents\Github\Lvl3Quant"
    r"\data\processed\dynamic_tp_sweep\sweep_summary_v2.json"
)

with open(SWEEP_JSON) as f:
    sweep_data = json.load(f)

sweep_params_global = sweep_data["sweep_params"]
ranked_combos = sweep_data["ranked_combos"]

for combo in ranked_combos:
    dtp = combo["dtp"]
    sl  = combo["sl"]
    run_name = f"dtp{dtp:.2f}_sl{sl}"

    params = {
        "dynamic_tp_pct": str(dtp),
        "stop_loss_ticks": str(sl),
        "signal_threshold": str(sweep_params_global.get("signal_threshold", 2.0)),
        "entry": "chase",
        "hours": "prime",
        "key": combo["key"],
    }

    metrics = {
        "sortino":          combo["sortino"],
        "net_pnl":          combo["net_pnl"],
        "mean_daily_pnl":   combo["mean_daily_pnl"],
        "pnl_per_trade":    combo["pnl_per_trade"],
        "win_rate":         combo["win_rate"],
        "fill_rate":        combo["fill_rate"],
        "total_trades":     float(combo["total_trades"]),
        "trades_per_day":   combo["trades_per_day"],
        "dates_with_trades": float(combo["dates_with_trades"]),
        "n_dates":           float(combo["n_dates"]),
        "profit_factor":     combo["profit_factor"],
    }

    tags = {
        "sweep": "Dynamic_TP_Sweep",
        "result": "NEGATIVE",
        "is_best": str(combo["key"] == sweep_data.get("best_combo", {}).get("key", "")),
    }

    with mlflow.start_run(experiment_id=exp_id, run_name=run_name):
        mlflow.set_tags(tags)
        mlflow.log_params(params)
        mlflow.log_metrics(metrics)

    print(f"  Logged run: {run_name}  sortino={combo['sortino']:.3f}  pnl={combo['net_pnl']:.0f}")

print(f"  Total runs logged: {len(ranked_combos)}")


# ─────────────────────────────────────────────────────────────────────────────
# 3. Leakage_Audits
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== Leakage_Audits ===")
exp_id = get_or_create_experiment("Leakage_Audits")

with mlflow.start_run(experiment_id=exp_id, run_name="qf_iceberg_chase_audit"):
    mlflow.set_tags({
        "verdict": "FAILED",
        "issue_1": "global_vol_percentile",
        "issue_2": "same_bar_entry",
        "auditor": "Claude_Sonnet",
        "date": "2026-03-27",
    })
    mlflow.log_params({
        "script": "qf_iceberg_chase_fillsim.py",
        "audit_type": "leakage",
    })
    # Encode verdict as metric (1=FAILED, 0=PASSED) for dashboard filtering
    mlflow.log_metrics({"audit_passed": 0.0, "n_issues_found": 2.0})

print("  Logged run: qf_iceberg_chase_audit  verdict=FAILED")
print("  Total runs logged: 1")


# ─────────────────────────────────────────────────────────────────────────────
# 4. Queue_Position_Analysis
# ─────────────────────────────────────────────────────────────────────────────
print("\n=== Queue_Position_Analysis ===")
exp_id = get_or_create_experiment("Queue_Position_Analysis")

with mlflow.start_run(experiment_id=exp_id, run_name="C1_z2.0_queue_buckets"):
    mlflow.set_tags({
        "card": "C1",
        "threshold": "2.0",
        "analysis_type": "queue_position_bucketing",
        "date": "2026-03-27",
    })
    mlflow.log_params({
        "card": "C1",
        "threshold": "2.0",
        "total_trades": "876",
    })
    mlflow.log_metrics({
        "q0_10_pnl":        -4.47,
        "q10_20_pnl":       13.58,
        "q20_30_pnl":       -0.88,
        "q50plus_pnl":      18.51,
        "optimal_min_queue": 15.0,
    })

print("  Logged run: C1_z2.0_queue_buckets")
print("  Total runs logged: 1")


# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
print("\n" + "="*60)
print("BACKFILL COMPLETE")
print("="*60)
total = len(runs) + len(ranked_combos) + 1 + 1
print(f"  Experiments created/updated : 4")
print(f"  Runs logged                 : {total}")
print(f"  MLflow UI                   : {TRACKING_URI}")
print("="*60)
