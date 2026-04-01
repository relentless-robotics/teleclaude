#!/usr/bin/env python3
"""
setup_mlflow_experiments.py — Create canonical MLflow experiment structure.

Creates (or verifies) all experiments used by the quant research pipeline.
Safe to run repeatedly — existing experiments are left untouched.

Usage:
    python scripts/setup_mlflow_experiments.py
    python scripts/setup_mlflow_experiments.py --tracking-uri http://localhost:5000
    python scripts/setup_mlflow_experiments.py --list

Experiments:
    CNN_Training       — WF wider CNN, MFE/MAE CNN fold results
    Fill_Sim_Sweeps    — Fill simulation TP/SL, conviction, hold-time sweeps
    Signal_Research    — L1 imbalance, iceberg, queue position signals
    Execution_Research — Dynamic TP, chase vs limit, time-of-day patterns
    Infrastructure     — Node health, GPU metrics, job queue stats
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from typing import List, Optional

os.environ.setdefault("MLFLOW_TRACKING_URI", "http://localhost:5000")

try:
    import mlflow
    import mlflow.exceptions
except ImportError:
    print("ERROR: mlflow not installed. Run: pip install mlflow", file=sys.stderr)
    sys.exit(1)


# ─── Experiment Definitions ───────────────────────────────────────────────────

@dataclass
class ExperimentDef:
    name: str
    description: str
    tags: dict = field(default_factory=dict)
    aliases: List[str] = field(default_factory=list)


EXPERIMENTS: List[ExperimentDef] = [
    ExperimentDef(
        name="CNN_Training",
        description=(
            "Walk-forward CNN training results. Covers: Wider CNN architecture, "
            "MFE/MAE CNN, WF fold IC tracking, train/val loss curves, "
            "architecture hyperparameter experiments on Neptune and Uranus GPUs."
        ),
        tags={
            "domain":    "machine_learning",
            "nodes":     "neptune,uranus",
            "metrics":   "ic,val_loss,train_loss,sortino",
            "pipeline":  "wf_training",
        },
        aliases=["cnn", "wf", "training"],
    ),
    ExperimentDef(
        name="Fill_Sim_Sweeps",
        description=(
            "Fill simulation optimization sweeps. Covers: TP/SL grid search, "
            "conviction threshold sweeps, hold-time optimization, queue fade, "
            "Optuna-driven hyperparameter search, Monte Carlo validation. "
            "Primary metric: Sortino ratio (maximize). Nodes: Jupiter, Saturn."
        ),
        tags={
            "domain":    "execution",
            "nodes":     "jupiter,saturn",
            "metrics":   "sortino,win_rate,pnl_per_day,max_drawdown",
            "pipeline":  "fill_sim_cli",
        },
        aliases=["fill_sim", "fillsim", "sweep", "optuna"],
    ),
    ExperimentDef(
        name="Signal_Research",
        description=(
            "Signal discovery and validation. Covers: L1 order imbalance signals, "
            "iceberg detection, queue position modeling, LGBM/XGBoost feature IC, "
            "MFE/MAE prediction quality, signal screening and leakage audits. "
            "Primary metric: IC (information coefficient). Node: Razer CPU, Jupiter."
        ),
        tags={
            "domain":    "alpha_research",
            "nodes":     "razer,jupiter",
            "metrics":   "ic,ic_std,feature_importance,leakage_status",
            "pipeline":  "signal_screening",
        },
        aliases=["signal", "lgbm", "gbm", "math", "alpha"],
    ),
    ExperimentDef(
        name="Execution_Research",
        description=(
            "Execution strategy research. Covers: dynamic TP/SL based on signal strength, "
            "chase vs limit order decision, cancel time optimization, queue dynamics, "
            "slippage prediction, adverse selection avoidance, time-of-day patterns, "
            "dynamic position sizing from MFE/MAE model. "
            "Goal: Sortino > 2.0 after realistic fills, Monte Carlo validated."
        ),
        tags={
            "domain":    "execution_research",
            "nodes":     "jupiter,saturn,razer",
            "metrics":   "sortino,win_loss_ratio,fill_rate,cancel_rate",
            "pipeline":  "execution_research",
        },
        aliases=["execution", "chase", "dynamic_tp", "time_of_day"],
    ),
    ExperimentDef(
        name="Infrastructure",
        description=(
            "System monitoring and infrastructure metrics. Covers: GPU utilization "
            "(5-min rolling), training log growth, power draw anomalies, node "
            "reachability, paper engine health, PM2 process status, job queue depth, "
            "dispatch latency. Logged by smart_monitor.js every 5 minutes."
        ),
        tags={
            "domain":    "infrastructure",
            "nodes":     "neptune,uranus,razer,jupiter,saturn",
            "metrics":   "gpu_util,power_draw,log_growth_bytes,queue_depth",
            "pipeline":  "smart_monitor",
        },
        aliases=["infra", "monitor", "health"],
    ),
]


# ─── Core Functions ───────────────────────────────────────────────────────────

def setup_experiment(exp_def: ExperimentDef, tracking_uri: str) -> dict:
    """
    Create or verify a single experiment. Returns status dict.
    """
    mlflow.set_tracking_uri(tracking_uri)

    existing = mlflow.get_experiment_by_name(exp_def.name)

    if existing is not None:
        # Verify it's active (not deleted)
        if existing.lifecycle_stage == "deleted":
            return {
                "name":   exp_def.name,
                "status": "DELETED",
                "id":     existing.experiment_id,
                "action": "skipped (deleted — restore manually or use a new name)",
            }
        # Already exists and active — verify tags are set
        client = mlflow.tracking.MlflowClient(tracking_uri=tracking_uri)
        for k, v in exp_def.tags.items():
            try:
                client.set_experiment_tag(existing.experiment_id, k, v)
            except Exception:
                pass  # Tags already set or read-only
        return {
            "name":   exp_def.name,
            "status": "EXISTS",
            "id":     existing.experiment_id,
            "action": "verified tags",
        }

    # Create new experiment
    client = mlflow.tracking.MlflowClient(tracking_uri=tracking_uri)
    tags_with_desc = dict(exp_def.tags)
    tags_with_desc["description"] = exp_def.description
    tags_with_desc["aliases"]     = ",".join(exp_def.aliases)
    tags_with_desc["created_by"]  = "setup_mlflow_experiments.py"

    exp_id = mlflow.create_experiment(
        name=exp_def.name,
        tags=tags_with_desc,
    )
    return {
        "name":   exp_def.name,
        "status": "CREATED",
        "id":     exp_id,
        "action": "created with tags",
    }


def list_experiments(tracking_uri: str) -> None:
    """Print all experiments in the tracking server."""
    mlflow.set_tracking_uri(tracking_uri)
    client = mlflow.tracking.MlflowClient(tracking_uri=tracking_uri)
    experiments = client.search_experiments()

    print(f"\nMLflow Tracking URI: {tracking_uri}")
    print(f"Total experiments: {len(experiments)}\n")
    print(f"{'ID':<8} {'Stage':<10} {'Name':<30} {'Artifact Location'}")
    print("-" * 80)
    for exp in sorted(experiments, key=lambda e: int(e.experiment_id)):
        print(f"{exp.experiment_id:<8} {exp.lifecycle_stage:<10} {exp.name:<30} {exp.artifact_location}")


def verify_connection(tracking_uri: str) -> bool:
    """Check that the MLflow server is reachable."""
    import urllib.request
    import urllib.error
    try:
        with urllib.request.urlopen(f"{tracking_uri}/api/2.0/mlflow/experiments/search", timeout=5) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        return e.code < 500  # 4xx still means server is up
    except Exception:
        return False


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Create canonical MLflow experiment structure for the quant pipeline."
    )
    parser.add_argument(
        "--tracking-uri",
        default=os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000"),
        help="MLflow tracking server URI (default: http://localhost:5000)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all experiments and exit (no changes made)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be created without making changes",
    )
    args = parser.parse_args()

    print(f"MLflow Tracking URI: {args.tracking_uri}")

    # Verify server is reachable
    if not verify_connection(args.tracking_uri):
        print(
            f"\nERROR: Cannot reach MLflow server at {args.tracking_uri}\n"
            "  Is it running? Start with:\n"
            "    mlflow server --backend-store-uri sqlite:///C:/Users/Footb/Documents/Github/Lvl3Quant/mlflow/mlflow.db "
            "--default-artifact-root C:/Users/Footb/Documents/Github/Lvl3Quant/mlflow/artifacts "
            "--host 0.0.0.0 --port 5000\n"
            "  Or via PM2:\n"
            "    pm2 start compute/mlflow.ecosystem.js",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.list:
        list_experiments(args.tracking_uri)
        return

    if args.dry_run:
        print("\n[DRY RUN] Would create/verify these experiments:")
        for exp_def in EXPERIMENTS:
            print(f"  • {exp_def.name}")
            print(f"    Aliases: {', '.join(exp_def.aliases)}")
            print(f"    Tags: {exp_def.tags}")
        return

    print(f"\nSetting up {len(EXPERIMENTS)} experiments...\n")
    results = []
    for exp_def in EXPERIMENTS:
        try:
            result = setup_experiment(exp_def, args.tracking_uri)
            results.append(result)
            status_icon = {"CREATED": "✓", "EXISTS": "=", "DELETED": "!"}.get(result["status"], "?")
            print(f"  [{status_icon}] {result['name']:<30} (id={result['id']}) — {result['status']}: {result['action']}")
        except Exception as e:
            print(f"  [!] {exp_def.name:<30} — ERROR: {e}", file=sys.stderr)
            results.append({"name": exp_def.name, "status": "ERROR", "error": str(e)})

    # Summary
    created = sum(1 for r in results if r["status"] == "CREATED")
    existing = sum(1 for r in results if r["status"] == "EXISTS")
    errors = sum(1 for r in results if r["status"] == "ERROR")

    print(f"\nDone: {created} created, {existing} already existed, {errors} errors.")
    print(f"\nMLflow UI: {args.tracking_uri}")

    if errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
