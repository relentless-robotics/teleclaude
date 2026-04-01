#!/usr/bin/env python3
"""
ray_tasks.py — Ray task definitions with automatic MLflow logging.

Every Ray task submitted through this module auto-logs params, metrics,
and artifacts to MLflow on the Neptune tracking server.

MLflow URI for remote nodes: http://100.109.245.73:5000  (Neptune Tailscale)
MLflow URI for Neptune local: http://localhost:5000

Usage:
    from compute.ray_tasks import run_fill_sim, train_cnn_fold, test_feature_ic
    from compute.ray_tasks import with_mlflow, log_ray_result

    # Decorator approach — wraps any function as a Ray remote + MLflow task:
    @with_mlflow("My_Experiment")
    def my_task(config):
        ...
        return {"sortino": 2.4, "win_rate": 0.56}

    # Submit via Ray Jobs API instead of ray.remote() — preferred for cross-node:
    from compute.ray_orchestrator import submit_ray_job
    submit_ray_job("my_job_001", "compute/ray_tasks.py", args=["--task", "fill_sim", ...])

    # Direct log helper for scripts that want to log their own results:
    log_ray_result("Fill_Sim_Sweeps", params={"tp": 13, "sl": 40}, metrics={"sortino": 2.1})
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# ── Path setup ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent  # teleclaude-main/
sys.path.insert(0, str(ROOT))

# ── MLflow config ─────────────────────────────────────────────────────────────
# Neptune Tailscale IP — accessible from all nodes (Jupiter, Saturn, Razer, Uranus).
# For Neptune-local scripts, MLFLOW_TRACKING_URI env var can override to localhost:5000.
MLFLOW_URI_REMOTE = "http://100.109.245.73:5000"   # Neptune Tailscale (Razer/Uranus)
MLFLOW_URI_LAN    = "http://192.168.0.101:5000"     # Neptune LAN IP (Jupiter/Saturn — Tailscale not connected)
MLFLOW_URI_LOCAL  = "http://localhost:5000"          # Neptune local (always works on Neptune)

# Prefer env var (set by orchestrator when dispatching jobs), then localhost.
# Remote node scripts get MLFLOW_TRACKING_URI=http://100.109.245.73:5000 injected as env var.
# On Neptune itself, use localhost to avoid Host header DNS rebinding rejection.
MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", MLFLOW_URI_LOCAL)

# ── Experiment name constants (match MLflow setup) ────────────────────────────
EXP_FILL_SIM    = "Fill_Sim_Sweeps"
EXP_CNN         = "CNN_Training"
EXP_SIGNAL      = "Signal_Research"
EXP_EXECUTION   = "Execution_Research"
EXP_INFRA       = "Infrastructure"

# ── Ray availability ──────────────────────────────────────────────────────────
try:
    import ray
    _RAY_AVAILABLE = True
except ImportError:
    _RAY_AVAILABLE = False

# ── MLflow availability ───────────────────────────────────────────────────────
try:
    import mlflow
    _MLFLOW_AVAILABLE = True
except ImportError:
    _MLFLOW_AVAILABLE = False
    print("[ray_tasks] WARNING: mlflow not installed. Logging disabled.", file=sys.stderr)


# ═══════════════════════════════════════════════════════════════════════════════
# Core MLflow helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _configure_mlflow(uri: str = None):
    """Point mlflow at the tracking server. Called before every run."""
    if not _MLFLOW_AVAILABLE:
        return
    effective_uri = uri or MLFLOW_TRACKING_URI
    mlflow.set_tracking_uri(effective_uri)


def _safe_float(val: Any) -> Optional[float]:
    """Coerce to float, returning None for non-numeric/NaN/Inf."""
    import math
    try:
        f = float(val)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _extract_metrics(result: Any) -> Dict[str, float]:
    """Pull numeric values from a task result dict."""
    if not isinstance(result, dict):
        return {}
    metrics = {}
    for k, v in result.items():
        fv = _safe_float(v)
        if fv is not None:
            metrics[str(k)] = fv
    return metrics


def _get_ray_task_id() -> str:
    """Return a short task ID string if Ray context is available."""
    if not _RAY_AVAILABLE:
        return f"local_{int(time.time())}"
    try:
        ctx = ray.get_runtime_context()
        tid = ctx.get_task_id()
        return tid[:12] if tid else f"task_{int(time.time())}"
    except Exception:
        return f"task_{int(time.time())}"


# ═══════════════════════════════════════════════════════════════════════════════
# MLflow decorator
# ═══════════════════════════════════════════════════════════════════════════════

def with_mlflow(experiment_name: str, tracking_uri: str = None):
    """
    Decorator that wraps a function (Ray task or plain function) with MLflow logging.

    - Sets up tracking URI and experiment before calling func
    - Logs all kwargs as MLflow params
    - Logs any numeric values in the return dict as MLflow metrics
    - Ends the run cleanly whether func succeeds or raises

    Usage:
        @with_mlflow("Fill_Sim_Sweeps")
        def run_fill_sim(config):
            ...
            return {"sortino": 2.4, "win_rate": 0.56}

        # To also make it a Ray remote:
        @with_mlflow("CNN_Training")
        @ray.remote(num_cpus=8)
        def train_fold(fold_config):
            ...

    Note: The decorator does NOT call ray.remote() itself — this allows
    the same function to be tested locally without a Ray cluster. Wrap
    with @ray.remote separately when submitting to the distributed cluster.
    """
    def decorator(func: Callable) -> Callable:
        def wrapper(*args, **kwargs):
            if not _MLFLOW_AVAILABLE:
                return func(*args, **kwargs)

            _configure_mlflow(tracking_uri)
            try:
                mlflow.set_experiment(experiment_name)
            except Exception as e:
                print(f"[ray_tasks] WARNING: set_experiment failed: {e}", file=sys.stderr)

            task_id  = _get_ray_task_id()
            run_name = f"{func.__name__}_{task_id}"

            run_ctx = None
            try:
                run_ctx = mlflow.start_run(run_name=run_name)
            except Exception as e:
                print(f"[ray_tasks] WARNING: start_run failed: {e}", file=sys.stderr)
                return func(*args, **kwargs)

            try:
                # Log kwargs as params
                if kwargs:
                    flat_kwargs: Dict[str, str] = {}
                    for k, v in kwargs.items():
                        flat_kwargs[str(k)] = json.dumps(v) if isinstance(v, (dict, list)) else str(v)
                    try:
                        mlflow.log_params(flat_kwargs)
                    except Exception:
                        pass

                # Also log first positional arg if it's a config dict
                if args and isinstance(args[0], dict):
                    flat_arg: Dict[str, str] = {}
                    for k, v in args[0].items():
                        flat_arg[str(k)] = json.dumps(v) if isinstance(v, (dict, list)) else str(v)
                    try:
                        mlflow.log_params(flat_arg)
                    except Exception:
                        pass

                # Tag with source info
                try:
                    mlflow.set_tags({
                        "source":    "ray_task",
                        "func":      func.__name__,
                        "task_id":   task_id,
                        "node":      os.environ.get("NODE_NAME", "unknown"),
                    })
                except Exception:
                    pass

                # Run the actual task
                result = func(*args, **kwargs)

                # Log numeric results as metrics
                metrics = _extract_metrics(result)
                if metrics:
                    try:
                        mlflow.log_metrics(metrics)
                    except Exception as e:
                        print(f"[ray_tasks] WARNING: log_metrics failed: {e}", file=sys.stderr)

                mlflow.end_run(status="FINISHED")
                return result

            except Exception as exc:
                try:
                    mlflow.set_tag("error", str(exc)[:500])
                    mlflow.end_run(status="FAILED")
                except Exception:
                    pass
                raise

        wrapper.__name__ = func.__name__
        wrapper.__doc__  = func.__doc__
        return wrapper

    return decorator


# ═══════════════════════════════════════════════════════════════════════════════
# Standalone log helper (for scripts that manage their own execution)
# ═══════════════════════════════════════════════════════════════════════════════

def log_ray_result(
    experiment_name: str,
    params: Dict[str, Any],
    metrics: Dict[str, Any],
    run_name: str = None,
    tags: Dict[str, str] = None,
    artifacts: List[str] = None,
    tracking_uri: str = None,
) -> Optional[str]:
    """
    One-shot helper: log a completed task's results to MLflow.

    Called by ray_orchestrator when a Ray Jobs API job completes, or
    by any script that wants to record its own results without using
    the @with_mlflow decorator.

    Parameters
    ----------
    experiment_name : str
    params : dict  — hyperparameters / config
    metrics : dict — numeric metrics (non-numeric values silently skipped)
    run_name : str, optional
    tags : dict, optional
    artifacts : list of file paths, optional
    tracking_uri : str, optional — overrides MLFLOW_TRACKING_URI env var

    Returns
    -------
    str or None — MLflow run_id, or None on failure
    """
    if not _MLFLOW_AVAILABLE:
        return None

    _configure_mlflow(tracking_uri)

    try:
        mlflow.set_experiment(experiment_name)
    except Exception as e:
        print(f"[ray_tasks] set_experiment failed: {e}", file=sys.stderr)
        return None

    run_id = None
    try:
        with mlflow.start_run(run_name=run_name or f"ray_{int(time.time())}") as run:
            run_id = run.info.run_id

            # Params
            if params:
                flat: Dict[str, str] = {}
                for k, v in params.items():
                    flat[str(k)] = json.dumps(v) if isinstance(v, (dict, list)) else str(v)
                mlflow.log_params({k: v[:6000] for k, v in flat.items()})

            # Metrics
            valid_metrics = {k: v for k, v in
                             {k: _safe_float(v) for k, v in metrics.items()}.items()
                             if v is not None}
            if valid_metrics:
                mlflow.log_metrics(valid_metrics)

            # Tags
            if tags:
                mlflow.set_tags({str(k): str(v) for k, v in tags.items()})

            # Artifacts
            for artifact_path in (artifacts or []):
                fp = Path(artifact_path)
                if fp.exists():
                    try:
                        mlflow.log_artifact(str(fp))
                    except Exception as e:
                        print(f"[ray_tasks] artifact upload failed {fp}: {e}", file=sys.stderr)
                        try:
                            mlflow.set_tag(f"artifact_path_{fp.name}", str(fp))
                        except Exception:
                            pass

    except Exception as e:
        print(f"[ray_tasks] log_ray_result failed: {e}", file=sys.stderr)

    return run_id


# ═══════════════════════════════════════════════════════════════════════════════
# Canonical task definitions
# (These are plain Python functions; wrap with @ray.remote at the call site
#  or submit via the Ray Jobs API to avoid Python version constraints.)
# ═══════════════════════════════════════════════════════════════════════════════

@with_mlflow(EXP_FILL_SIM)
def run_fill_sim(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run a fill simulation on Jupiter/Saturn.

    config keys (subset):
        card, tp_ticks, sl_ticks, hold_bars, entry_z_thresh,
        cancel_secs, script, node, cwd
    """
    import subprocess

    script = config.get("script", "")
    args   = config.get("args", [])
    cwd    = config.get("cwd", "")

    if not script:
        return {"error": "no script specified", "exitCode": -1}

    cmd = ["python3", script] + [str(a) for a in args]
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd or None,
            capture_output=True,
            text=True,
            timeout=config.get("timeout", 3600),
        )
        # Try to parse JSON output from the fill sim
        metrics: Dict[str, Any] = {}
        try:
            # Last line that is valid JSON wins
            for line in reversed(result.stdout.splitlines()):
                line = line.strip()
                if line.startswith("{"):
                    metrics = json.loads(line)
                    break
        except Exception:
            pass

        metrics["exitCode"] = result.returncode
        metrics["node"]     = config.get("node", os.environ.get("NODE_NAME", "?"))
        return metrics

    except subprocess.TimeoutExpired:
        return {"error": "timeout", "exitCode": -1}
    except Exception as e:
        return {"error": str(e), "exitCode": -1}


@with_mlflow(EXP_CNN)
def train_cnn_fold(fold_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Train one CNN walk-forward fold on a GPU node (Uranus RTX 5090 / Neptune RTX 3090).

    fold_config keys:
        fold, script, cwd, args, node, timeout
    """
    import subprocess

    script = fold_config.get("script", "")
    args   = fold_config.get("args", [])
    cwd    = fold_config.get("cwd", "")

    if not script:
        return {"error": "no script", "exitCode": -1}

    cmd = ["python3", script] + [str(a) for a in args]
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd or None,
            capture_output=True,
            text=True,
            timeout=fold_config.get("timeout", 7200),
        )
        # Parse IC from output
        metrics: Dict[str, Any] = {"exitCode": result.returncode}
        import re
        ic_match = re.search(r"IC[=:\s]+([-+]?\d*\.?\d+)", result.stdout)
        if ic_match:
            metrics["ic"] = float(ic_match.group(1))
        loss_match = re.search(r"val_loss[=:\s]+([-+]?\d*\.?\d+)", result.stdout)
        if loss_match:
            metrics["val_loss"] = float(loss_match.group(1))
        metrics["fold"] = fold_config.get("fold", -1)
        return metrics

    except subprocess.TimeoutExpired:
        return {"error": "timeout", "exitCode": -1}
    except Exception as e:
        return {"error": str(e), "exitCode": -1}


@with_mlflow(EXP_SIGNAL)
def test_feature_ic(feature_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Test a feature's IC on Razer (math strategy / LGBM research).

    feature_config keys:
        feature_name, script, args, cwd, timeout
    """
    import subprocess

    script = feature_config.get("script", "")
    args   = feature_config.get("args", [])
    cwd    = feature_config.get("cwd", "")

    if not script:
        return {"error": "no script", "exitCode": -1}

    cmd = ["python", script] + [str(a) for a in args]
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd or None,
            capture_output=True,
            text=True,
            timeout=feature_config.get("timeout", 3600),
        )
        # Parse IC from output
        metrics: Dict[str, Any] = {"exitCode": result.returncode}
        import re
        ic_match = re.search(r"IC[=:\s]+([-+]?\d*\.?\d+)", result.stdout)
        if ic_match:
            metrics["ic"] = float(ic_match.group(1))
        metrics["feature"] = feature_config.get("feature_name", "unknown")
        return metrics

    except subprocess.TimeoutExpired:
        return {"error": "timeout", "exitCode": -1}
    except Exception as e:
        return {"error": str(e), "exitCode": -1}


# ═══════════════════════════════════════════════════════════════════════════════
# CLI — called by ray_orchestrator via Jobs API when MLflow logging is needed
# ═══════════════════════════════════════════════════════════════════════════════

def _cli_log():
    """
    CLI entry point for post-hoc MLflow logging from completed Ray jobs.

    Usage:
        python compute/ray_tasks.py log \
            --experiment Fill_Sim_Sweeps \
            --run-name hold_time_test_job123 \
            --params '{"tp":13,"sl":40}' \
            --metrics '{"sortino":2.4,"win_rate":0.56}' \
            --tags '{"node":"jupiter","job_id":"abc"}' \
            [--artifact /path/to/results.json]
    """
    import argparse

    parser = argparse.ArgumentParser(description="Log a completed Ray task to MLflow")
    parser.add_argument("action", choices=["log", "test"],
                        help="'log' to record results; 'test' to submit a test task")
    parser.add_argument("--experiment",  required=False, default="Infrastructure")
    parser.add_argument("--run-name",    default=None)
    parser.add_argument("--params",      default="{}")
    parser.add_argument("--metrics",     default="{}")
    parser.add_argument("--tags",        default="{}")
    parser.add_argument("--artifact",    action="append", default=[], dest="artifacts")
    parser.add_argument("--uri",         default=None, help="Override MLflow tracking URI")
    args = parser.parse_args()

    if args.action == "test":
        _run_test()
        return

    run_id = log_ray_result(
        experiment_name=args.experiment,
        params=json.loads(args.params),
        metrics=json.loads(args.metrics),
        run_name=args.run_name,
        tags=json.loads(args.tags),
        artifacts=args.artifacts,
        tracking_uri=args.uri,
    )
    if run_id:
        print(f"[ray_tasks] Logged to '{args.experiment}' run_id={run_id}")
        sys.exit(0)
    else:
        print("[ray_tasks] Logging failed or MLflow unavailable")
        sys.exit(1)


def _run_test():
    """Submit a lightweight test log to MLflow and verify it appears."""
    print(f"[ray_tasks] Test: logging to {MLFLOW_TRACKING_URI} ...")
    run_id = log_ray_result(
        experiment_name="Infrastructure",
        params={"test": "ray_tasks_wiring", "node": "neptune"},
        metrics={"test_metric": 1.0, "ping": 42.0},
        run_name=f"ray_tasks_test_{int(time.time())}",
        tags={"source": "ray_tasks_test"},
    )
    if run_id:
        print(f"[ray_tasks] Test PASSED. run_id={run_id}")
        print(f"[ray_tasks] View at: {MLFLOW_TRACKING_URI}/#/experiments")
        sys.exit(0)
    else:
        print("[ray_tasks] Test FAILED — check MLflow server")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("log", "test"):
        _cli_log()
    else:
        print(__doc__)
