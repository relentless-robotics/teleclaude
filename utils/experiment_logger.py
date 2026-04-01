"""
ExperimentLogger — Universal MLflow logger for the quant research pipeline.

Auto-connects to MLflow at http://localhost:5000.
Handles CNN training folds, fill sim results, Optuna sweeps, and arbitrary experiments.

Usage:
    from utils.experiment_logger import ExperimentLogger, log_experiment

    # Full API
    with ExperimentLogger("CNN_Training", run_name="wider_cnn_fold_42") as exp:
        exp.log_params({"model": "wider_cnn", "fold": 42, "lr": 1e-4})
        exp.log_metrics({"ic": 0.178, "val_loss": 0.021}, step=42)
        exp.log_artifact("/path/to/fold42_weights.pt")

    # One-liner
    log_experiment("Fill_Sim_Sweeps", params, metrics, artifacts=["results.json"])
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

# ─── Auto-configure tracking URI ──────────────────────────────────────────────
os.environ.setdefault("MLFLOW_TRACKING_URI", "http://localhost:5000")

# Fix Windows console encoding so MLflow's emoji output doesn't crash.
# PYTHONUTF8=1 or PYTHONIOENCODING=utf-8 tells Python to use UTF-8 for stdio.
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

try:
    import mlflow
    import mlflow.exceptions
    _MLFLOW_AVAILABLE = True
except ImportError:
    _MLFLOW_AVAILABLE = False
    print("[experiment_logger] WARNING: mlflow not installed. Logging is a no-op.", file=sys.stderr)


# ─── Constants ────────────────────────────────────────────────────────────────

TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")

# Canonical experiment names — must match setup_mlflow_experiments.py
EXPERIMENTS = {
    "cnn":       "CNN_Training",
    "fill_sim":  "Fill_Sim_Sweeps",
    "signal":    "Signal_Research",
    "execution": "Execution_Research",
    "infra":     "Infrastructure",
}

# Fill-sim JSON keys we care about and their MLflow metric names
_FILL_SIM_METRIC_MAP: Dict[str, str] = {
    "sortino":                  "sortino",
    "sortino_mean":             "sortino",
    "sharpe":                   "sharpe",
    "sharpe_mean":              "sharpe",
    "total_pnl":                "total_pnl",
    "total_pnl_dollars":        "total_pnl_dollars",
    "pnl_per_day":              "pnl_per_day",
    "win_rate":                 "win_rate",
    "wr_mean":                  "win_rate",
    "win_loss_ratio":           "win_loss_ratio",
    "n_trades_total":           "n_trades_total",
    "n_trades_per_day":         "n_trades_per_day",
    "n_days":                   "n_days",
    "total_trades":             "total_trades",
    "total_filled":             "total_filled",
    "fill_rate":                "fill_rate",
    "avg_pnl_per_trade":        "avg_pnl_per_trade",
    "max_drawdown":             "max_drawdown",
    "max_drawdown_dollars":     "max_drawdown_dollars",
    "profit_factor":            "profit_factor",
    "ic":                       "ic",
    "ic_mean":                  "ic_mean",
    "ic_std":                   "ic_std",
    "signal_count":             "signal_count",
    "avg_signal":               "avg_signal",
    "cancel_rate":              "cancel_rate",
    "avg_queue_position":       "avg_queue_position",
    "monte_carlo_sortino_p10":  "mc_sortino_p10",
    "monte_carlo_sortino_p50":  "mc_sortino_p50",
    "monte_carlo_sortino_p90":  "mc_sortino_p90",
    "mc_sortino_p10":           "mc_sortino_p10",
    "mc_sortino_p50":           "mc_sortino_p50",
    "mc_sortino_p90":           "mc_sortino_p90",
}


def _safe_float(val: Any) -> Optional[float]:
    """Convert value to float, returning None for NaN/Inf/non-numeric."""
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _ensure_experiment(name: str) -> str:
    """Get or create an MLflow experiment by name. Returns experiment_id."""
    if not _MLFLOW_AVAILABLE:
        return "0"
    mlflow.set_tracking_uri(TRACKING_URI)
    exp = mlflow.get_experiment_by_name(name)
    if exp is None:
        exp_id = mlflow.create_experiment(name)
    else:
        exp_id = exp.experiment_id
    return exp_id


# ─── Main Class ───────────────────────────────────────────────────────────────

class ExperimentLogger:
    """
    Context-manager and manual-control interface for MLflow run logging.

    Parameters
    ----------
    experiment_name : str
        MLflow experiment name. Created automatically if it doesn't exist.
    run_name : str, optional
        Human-readable run name shown in the MLflow UI.
    tags : dict, optional
        Key-value string tags attached to the run.
    nested : bool
        If True, create a nested child run under an existing active run.
    """

    def __init__(
        self,
        experiment_name: str,
        run_name: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None,
        nested: bool = False,
    ):
        self.experiment_name = experiment_name
        self.run_name = run_name
        self.tags = tags or {}
        self.nested = nested
        self._run = None
        self._active = False

    # ── Context manager ───────────────────────────────────────────────────────

    def __enter__(self) -> "ExperimentLogger":
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        if exc_type is not None:
            self.finish("FAILED")
        else:
            self.finish("FINISHED")
        return False  # never suppress exceptions

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> "ExperimentLogger":
        """Explicitly start the MLflow run (called automatically by __enter__)."""
        if not _MLFLOW_AVAILABLE or self._active:
            return self
        try:
            _ensure_experiment(self.experiment_name)
            mlflow.set_tracking_uri(TRACKING_URI)
            mlflow.set_experiment(self.experiment_name)
            self._run = mlflow.start_run(
                run_name=self.run_name,
                tags=self.tags,
                nested=self.nested,
            )
            self._active = True
        except Exception as e:
            print(f"[experiment_logger] WARNING: Failed to start MLflow run: {e}", file=sys.stderr)
        return self

    def finish(self, status: str = "FINISHED") -> None:
        """
        End the run.

        Parameters
        ----------
        status : str
            'FINISHED', 'FAILED', or 'KILLED'
        """
        if not _MLFLOW_AVAILABLE or not self._active:
            return
        try:
            mlflow.end_run(status=status)
        except UnicodeEncodeError:
            # Windows consoles with non-UTF-8 codepage emit UnicodeEncodeError when
            # MLflow prints emoji (e.g. 🏃) to stdout. The run WAS ended — ignore.
            pass
        except Exception as e:
            print(f"[experiment_logger] WARNING: Failed to end run: {e}", file=sys.stderr)
        finally:
            self._active = False
            self._run = None

    # ── Core logging ──────────────────────────────────────────────────────────

    def log_params(self, params_dict: Dict[str, Any]) -> None:
        """
        Log all experiment parameters (hyperparameters, config values).
        Values are coerced to strings; dicts/lists are JSON-serialised.
        """
        if not _MLFLOW_AVAILABLE or not self._active:
            return
        cleaned: Dict[str, str] = {}
        for k, v in params_dict.items():
            if isinstance(v, (dict, list)):
                cleaned[str(k)] = json.dumps(v)
            else:
                cleaned[str(k)] = str(v)
        try:
            # MLflow caps param values at 6000 chars
            mlflow.log_params({k: v[:6000] for k, v in cleaned.items()})
        except Exception as e:
            print(f"[experiment_logger] WARNING: log_params failed: {e}", file=sys.stderr)

    def log_metrics(
        self,
        metrics_dict: Dict[str, Any],
        step: Optional[int] = None,
    ) -> None:
        """
        Log numeric metrics. NaN/Inf values are silently skipped.

        Parameters
        ----------
        metrics_dict : dict
            Metric name → float value.
        step : int, optional
            Step (epoch/fold) for time-series metrics.
        """
        if not _MLFLOW_AVAILABLE or not self._active:
            return
        valid: Dict[str, float] = {}
        for k, v in metrics_dict.items():
            fv = _safe_float(v)
            if fv is not None:
                valid[str(k)] = fv
        if not valid:
            return
        try:
            mlflow.log_metrics(valid, step=step)
        except Exception as e:
            print(f"[experiment_logger] WARNING: log_metrics failed: {e}", file=sys.stderr)

    def log_artifact(self, file_path: Union[str, Path]) -> None:
        """
        Upload a local file as an MLflow artifact.

        Parameters
        ----------
        file_path : str or Path
            Must exist on the local filesystem.
        """
        if not _MLFLOW_AVAILABLE or not self._active:
            return
        fp = Path(file_path).resolve()
        if not fp.exists():
            print(f"[experiment_logger] WARNING: artifact not found: {fp}", file=sys.stderr)
            return
        try:
            # Use absolute POSIX-style path string; MLflow on Windows needs
            # forward slashes when the tracking URI is HTTP (not local file://)
            mlflow.log_artifact(str(fp))
        except Exception as e:
            # Artifact upload can fail with path-scheme issues in some MLflow versions.
            # Log the file path as a tag instead so the location isn't lost.
            print(f"[experiment_logger] WARNING: log_artifact failed ({e}); tagging path instead",
                  file=sys.stderr)
            try:
                mlflow.set_tag("artifact_path", str(fp))
            except Exception:
                pass

    def set_tag(self, key: str, value: str) -> None:
        """Set a single string tag on the active run."""
        if not _MLFLOW_AVAILABLE or not self._active:
            return
        try:
            mlflow.set_tag(str(key), str(value))
        except Exception as e:
            print(f"[experiment_logger] WARNING: set_tag failed: {e}", file=sys.stderr)

    # ── Domain-specific helpers ───────────────────────────────────────────────

    def log_fill_sim_result(self, result_json_path: Union[str, Path]) -> None:
        """
        Parse fill_sim_cli JSON output and auto-log all known metrics.

        Handles both single-config outputs (flat dict) and multi-config
        summary dicts (nested under config names).

        Parameters
        ----------
        result_json_path : str or Path
            Path to the JSON file produced by fill_sim_cli.
        """
        if not _MLFLOW_AVAILABLE or not self._active:
            return
        fp = Path(result_json_path)
        if not fp.exists():
            print(f"[experiment_logger] WARNING: fill_sim result not found: {fp}", file=sys.stderr)
            return

        try:
            with open(fp, "r") as f:
                data = json.load(f)
        except Exception as e:
            print(f"[experiment_logger] WARNING: Failed to parse {fp}: {e}", file=sys.stderr)
            return

        # Log the raw file as artifact
        self.log_artifact(fp)

        # Determine structure
        if isinstance(data, dict):
            # Check if it's a summary wrapper (has a "summary" key)
            if "summary" in data and isinstance(data["summary"], dict):
                # Multi-config summary
                self._log_fill_sim_summary(data)
            else:
                # Flat single-config result
                self._log_fill_sim_flat(data)
        elif isinstance(data, list) and data:
            # List of per-date results — aggregate
            self._log_fill_sim_list(data)

    def _log_fill_sim_flat(self, data: dict) -> None:
        """Log a flat fill_sim result dict."""
        metrics: Dict[str, float] = {}
        for src_key, dst_key in _FILL_SIM_METRIC_MAP.items():
            if src_key in data:
                fv = _safe_float(data[src_key])
                if fv is not None:
                    metrics[dst_key] = fv
        # Also log any numeric keys we don't have in the map
        for k, v in data.items():
            if k not in _FILL_SIM_METRIC_MAP and isinstance(v, (int, float)):
                fv = _safe_float(v)
                if fv is not None:
                    metrics[f"raw_{k}"] = fv
        self.log_metrics(metrics)

    def _log_fill_sim_summary(self, data: dict) -> None:
        """Log multi-config fill_sim summary. Logs top-level params + per-config metrics."""
        # Top-level params
        params = {k: v for k, v in data.items()
                  if k != "summary" and not isinstance(v, (dict, list))}
        self.log_params(params)

        summary = data["summary"]
        # Find best config by sortino
        best_sortino = float("-inf")
        best_config = None

        for config_name, config_data in summary.items():
            if not isinstance(config_data, dict):
                continue
            metrics: Dict[str, float] = {}
            for src_key, dst_key in _FILL_SIM_METRIC_MAP.items():
                if src_key in config_data:
                    fv = _safe_float(config_data[src_key])
                    if fv is not None:
                        metrics[f"{config_name}/{dst_key}"] = fv
            self.log_metrics(metrics)

            sortino = _safe_float(config_data.get("sortino") or config_data.get("sortino_mean"))
            if sortino is not None and sortino > best_sortino:
                best_sortino = sortino
                best_config = config_name

        if best_config:
            self.set_tag("best_config", best_config)
            if best_sortino > float("-inf"):
                self.log_metrics({"best_sortino": best_sortino})

    def _log_fill_sim_list(self, data: list) -> None:
        """Log a list of per-date fill_sim results by aggregating."""
        import statistics
        pnls = [_safe_float(r.get("total_pnl_dollars", r.get("total_pnl"))) for r in data]
        pnls = [p for p in pnls if p is not None]

        sortinos = [_safe_float(r.get("sortino")) for r in data]
        sortinos = [s for s in sortinos if s is not None]

        trades = [_safe_float(r.get("total_trades", r.get("n_trades_total"))) for r in data]
        trades = [t for t in trades if t is not None]

        metrics: Dict[str, float] = {"n_days": float(len(data))}
        if pnls:
            metrics["total_pnl_dollars"] = sum(pnls)
            metrics["pnl_per_day"] = statistics.mean(pnls)
        if sortinos:
            metrics["sortino_mean"] = statistics.mean(sortinos)
        if trades:
            metrics["n_trades_total"] = sum(trades)
            metrics["n_trades_per_day"] = statistics.mean(trades)

        self.log_metrics(metrics)

    def log_training_fold(
        self,
        fold_num: int,
        metrics: Dict[str, Any],
    ) -> None:
        """
        Log a single WF training fold result.

        Parameters
        ----------
        fold_num : int
            Fold index (used as the MLflow step).
        metrics : dict
            Fold metrics: ic, val_loss, train_loss, epoch, etc.
        """
        self.log_metrics(metrics, step=fold_num)
        # Also tag the latest fold for quick reference
        self.set_tag("latest_fold", str(fold_num))
        ic = _safe_float(metrics.get("ic") or metrics.get("ic_val"))
        if ic is not None:
            self.set_tag("latest_ic", f"{ic:.4f}")


# ─── Convenience one-liner ────────────────────────────────────────────────────

def log_experiment(
    name: str,
    params: Dict[str, Any],
    metrics: Dict[str, Any],
    artifacts: Optional[List[Union[str, Path]]] = None,
    tags: Optional[Dict[str, str]] = None,
    run_name: Optional[str] = None,
) -> Optional[str]:
    """
    One-liner to log a complete experiment and return the MLflow run_id.

    Parameters
    ----------
    name : str
        Experiment name (created if not exists).
    params : dict
        Hyperparameters and config.
    metrics : dict
        Numeric metrics to record.
    artifacts : list, optional
        File paths to upload as artifacts.
    tags : dict, optional
        String tags.
    run_name : str, optional
        Display name in MLflow UI.

    Returns
    -------
    str or None
        MLflow run_id, or None if MLflow unavailable.

    Example
    -------
    >>> run_id = log_experiment(
    ...     "Fill_Sim_Sweeps",
    ...     params={"tp_ticks": 13, "sl_ticks": 40, "card": "C3"},
    ...     metrics={"sortino": 2.4, "win_rate": 0.56, "pnl_per_day": 1250.0},
    ...     run_name="tp13_sl40_card3",
    ... )
    """
    exp = ExperimentLogger(name, run_name=run_name, tags=tags or {})
    exp.start()
    run_id = None
    try:
        exp.log_params(params)
        exp.log_metrics(metrics)
        for artifact in (artifacts or []):
            exp.log_artifact(artifact)
        if _MLFLOW_AVAILABLE and exp._run:
            run_id = exp._run.info.run_id
    finally:
        exp.finish("FINISHED")
    return run_id


# ─── CLI interface (called by log_to_mlflow.py) ───────────────────────────────

def _cli_main():
    """
    Entry point when called as a script.
    Usage mirrors compute/log_to_mlflow.py but can be used standalone.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Log an experiment to MLflow")
    parser.add_argument("--experiment",  required=True, help="MLflow experiment name")
    parser.add_argument("--run-name",    default=None,  help="Run display name")
    parser.add_argument("--params",      default="{}", help="JSON dict of params")
    parser.add_argument("--metrics",     default="{}", help="JSON dict of metrics")
    parser.add_argument("--artifact",    action="append", default=[], dest="artifacts",
                        help="File path to log as artifact (repeatable)")
    parser.add_argument("--tags",        default="{}", help="JSON dict of string tags")
    parser.add_argument("--fill-sim-result", default=None,
                        help="Path to fill_sim JSON output (auto-parses metrics)")
    args = parser.parse_args()

    params   = json.loads(args.params)
    metrics  = json.loads(args.metrics)
    tags     = json.loads(args.tags)

    exp = ExperimentLogger(args.experiment, run_name=args.run_name, tags=tags)
    exp.start()
    try:
        exp.log_params(params)
        exp.log_metrics(metrics)
        if args.fill_sim_result:
            exp.log_fill_sim_result(args.fill_sim_result)
        for artifact in args.artifacts:
            exp.log_artifact(artifact)
        run_id = exp._run.info.run_id if exp._run else None
        print(f"[experiment_logger] Logged to '{args.experiment}' run_id={run_id}")
    finally:
        exp.finish("FINISHED")


if __name__ == "__main__":
    _cli_main()
