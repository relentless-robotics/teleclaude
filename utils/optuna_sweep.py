"""
optuna_sweep.py — Optuna-driven fill_sim_cli hyperparameter optimization.

Integrates with MLflow so every trial is automatically logged.
Parallelises across N workers using Optuna's SQLite-backed storage.

Usage:
    from utils.optuna_sweep import FillSimOptunaSweep

    sweep = FillSimOptunaSweep(
        study_name="card3_tp_sl_v1",
        card="C3",
        mbo_dir="/home/jupiter/Lvl3Quant/data/raw/mbo",
        pred_dir="/home/jupiter/Lvl3Quant/fill_sim_test/predictions",
        sim_exe="/home/jupiter/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli",
        n_oot_dates=58,
    )
    sweep.run(n_trials=200, n_jobs=8)
    print("Best params:", sweep.study.best_params)
    print("Best Sortino:", sweep.study.best_value)

    # Or run from CLI:
    python utils/optuna_sweep.py \
        --study-name card3_tp_sl_v1 \
        --card C3 \
        --mbo-dir /home/jupiter/Lvl3Quant/data/raw/mbo \
        --pred-dir /home/jupiter/Lvl3Quant/fill_sim_test/predictions \
        --sim-exe /home/jupiter/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli \
        --n-trials 200 --n-jobs 8
"""

from __future__ import annotations

import glob
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

os.environ.setdefault("MLFLOW_TRACKING_URI", "http://localhost:5000")

try:
    import optuna
    from optuna.samplers import TPESampler
    from optuna.pruners import MedianPruner
    _OPTUNA_OK = True
except ImportError:
    _OPTUNA_OK = False
    print("[optuna_sweep] ERROR: optuna not installed. Run: pip install optuna", file=sys.stderr)

try:
    import mlflow
    _MLFLOW_OK = True
except ImportError:
    _MLFLOW_OK = False

try:
    import numpy as np
    _NP_OK = True
except ImportError:
    _NP_OK = False

# ─── Paths ────────────────────────────────────────────────────────────────────

_ROOT = Path(__file__).resolve().parent.parent
_OPTUNA_DB_PATH = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant\optuna\optuna.db")
_MLFLOW_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")


def _optuna_storage() -> str:
    _OPTUNA_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{_OPTUNA_DB_PATH}"


# ─── Search Space ─────────────────────────────────────────────────────────────

# Typical tick sizes for ES (E-mini S&P 500): 1 tick = 0.25 pts = $12.50
# The ranges below are in ticks unless noted.

DEFAULT_SEARCH_SPACE = {
    "tp_ticks":         {"type": "int",         "low": 2,    "high": 20},
    "sl_ticks":         {"type": "int",         "low": 5,    "high": 30},
    "signal_threshold": {"type": "float",       "low": 0.5,  "high": 3.0,  "step": 0.1},
    "hold_ms":          {"type": "categorical", "choices": [10_000, 30_000, 60_000,
                                                              300_000, 600_000, 1_800_000,
                                                              3_600_000]},
    "chase_entry":      {"type": "categorical", "choices": [True, False]},
    "prime_hours":      {"type": "categorical", "choices": [True, False]},
}


def _suggest_param(trial: "optuna.Trial", name: str, spec: dict) -> Any:
    """Dispatch to the right trial.suggest_* method based on spec type."""
    ptype = spec["type"]
    if ptype == "int":
        return trial.suggest_int(name, spec["low"], spec["high"],
                                  step=spec.get("step", 1))
    elif ptype == "float":
        kwargs = {"step": spec["step"]} if "step" in spec else {"log": spec.get("log", False)}
        return trial.suggest_float(name, spec["low"], spec["high"], **kwargs)
    elif ptype == "categorical":
        return trial.suggest_categorical(name, spec["choices"])
    else:
        raise ValueError(f"Unknown param type '{ptype}' for '{name}'")


# ─── Prediction loading ───────────────────────────────────────────────────────

def _load_prediction_dates(pred_dir: str) -> Dict[str, str]:
    """
    Scan pred_dir for *.npz files and build a {date8 -> npz_path} mapping.
    Handles filenames like: 20260101.npz, 2026-01-01.npz, predictions_20260101.npz
    """
    date_to_path: Dict[str, str] = {}
    for npz in sorted(glob.glob(os.path.join(pred_dir, "*.npz"))):
        stem = Path(npz).stem
        # Extract 8-digit date
        import re
        m = re.search(r"(\d{4})[_-]?(\d{2})[_-]?(\d{2})", stem)
        if m:
            date8 = m.group(1) + m.group(2) + m.group(3)
            date_to_path[date8] = npz
    return date_to_path


def _match_mbo_dates(mbo_dir: str, pred_dates: Dict[str, str]) -> List[Tuple[str, str]]:
    """
    Return list of (mbo_file_path, date8) for dates that have both MBO data and predictions.
    """
    import re
    matched = []
    for mbo_file in sorted(glob.glob(os.path.join(mbo_dir, "*.dbn.zst")) +
                            glob.glob(os.path.join(mbo_dir, "*.dbn"))):
        fname = Path(mbo_file).stem.replace(".dbn", "")
        m = re.search(r"(\d{4})[_-]?(\d{2})[_-]?(\d{2})", fname)
        if m:
            date8 = m.group(1) + m.group(2) + m.group(3)
            if date8 in pred_dates:
                matched.append((mbo_file, date8))
    return matched


# ─── Metric aggregation ───────────────────────────────────────────────────────

def _safe_float(val: Any) -> Optional[float]:
    try:
        f = float(val)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _aggregate_results(results: List[dict]) -> dict:
    """
    Aggregate a list of per-date fill_sim JSON outputs into a single metrics dict.
    Primary objective: mean Sortino. Secondary: total PnL, win rate.
    """
    if not results:
        return {"sortino": float("-inf"), "n_days": 0}

    sortinos  = [_safe_float(r.get("sortino")) for r in results]
    pnls      = [_safe_float(r.get("total_pnl_dollars") or r.get("total_pnl")) for r in results]
    wrs       = [_safe_float(r.get("win_rate") or r.get("wr_mean")) for r in results]
    trades    = [_safe_float(r.get("total_trades") or r.get("n_trades_total")) for r in results]

    sortinos  = [s for s in sortinos  if s is not None]
    pnls      = [p for p in pnls      if p is not None]
    wrs       = [w for w in wrs       if w is not None]
    trades    = [t for t in trades    if t is not None]

    agg: dict = {
        "n_days":         len(results),
        "n_days_success": len(sortinos),
    }
    if sortinos:
        agg["sortino"]       = statistics.mean(sortinos)
        agg["sortino_std"]   = statistics.stdev(sortinos) if len(sortinos) > 1 else 0.0
        agg["sortino_min"]   = min(sortinos)
        agg["sortino_max"]   = max(sortinos)
    else:
        agg["sortino"] = float("-inf")
    if pnls:
        agg["total_pnl_dollars"] = sum(pnls)
        agg["pnl_per_day"]       = statistics.mean(pnls)
    if wrs:
        agg["win_rate"] = statistics.mean(wrs)
    if trades:
        agg["n_trades_total"] = sum(trades)
        agg["n_trades_per_day"] = statistics.mean(trades)

    return agg


# ─── Main Class ───────────────────────────────────────────────────────────────

class FillSimOptunaSweep:
    """
    Optuna-driven optimization of fill_sim_cli hyperparameters.

    Runs N trials across OOT dates and maximises Sortino ratio.
    Each trial is logged to MLflow "Fill_Sim_Sweeps" experiment.

    Parameters
    ----------
    study_name : str
        Unique name for the Optuna study (persisted in SQLite).
    card : str
        Card identifier (e.g. "C3") — used as a tag in MLflow.
    mbo_dir : str
        Directory containing *.dbn.zst MBO data files.
    pred_dir : str
        Directory containing *.npz prediction files (one per date).
    sim_exe : str
        Path to the fill_sim_cli executable.
    n_oot_dates : int
        Maximum number of OOT dates to evaluate per trial.
    search_space : dict, optional
        Override the default search space (see DEFAULT_SEARCH_SPACE).
    mlflow_experiment : str
        MLflow experiment to log trials to.
    single_pred_dir : str, optional
        Scratch dir for per-date NPZ files (default: temp dir).
    timeout_per_date : int
        Seconds to wait for each fill_sim_cli call (default: 120).
    """

    def __init__(
        self,
        study_name: str,
        card: str,
        mbo_dir: str,
        pred_dir: str,
        sim_exe: str,
        n_oot_dates: int = 58,
        search_space: Optional[dict] = None,
        mlflow_experiment: str = "Fill_Sim_Sweeps",
        single_pred_dir: Optional[str] = None,
        timeout_per_date: int = 120,
    ):
        if not _OPTUNA_OK:
            raise RuntimeError("optuna is required. pip install optuna")

        self.study_name        = study_name
        self.card              = card
        self.mbo_dir           = mbo_dir
        self.pred_dir          = pred_dir
        self.sim_exe           = sim_exe
        self.n_oot_dates       = n_oot_dates
        self.search_space      = search_space or DEFAULT_SEARCH_SPACE
        self.mlflow_experiment = mlflow_experiment
        self.timeout_per_date  = timeout_per_date

        # Resolve matched dates (done once, reused across all trials)
        pred_dates = _load_prediction_dates(pred_dir)
        matched    = _match_mbo_dates(mbo_dir, pred_dates)
        if not matched:
            raise RuntimeError(
                f"No matching MBO/prediction dates found.\n"
                f"  MBO dir:  {mbo_dir}\n"
                f"  Pred dir: {pred_dir}\n"
                f"  Pred dates found: {len(pred_dates)}"
            )
        # Use the last N dates (out-of-sample)
        self._matched   = matched[-n_oot_dates:]
        self._pred_dates = pred_dates
        print(f"[optuna_sweep] {len(self._matched)} OOT dates matched "
              f"(showing up to {n_oot_dates} from {len(matched)} total)")

        # Scratch dir for per-date NPZ files
        self._tmp_dir = single_pred_dir or tempfile.mkdtemp(prefix="optuna_preds_")
        os.makedirs(self._tmp_dir, exist_ok=True)

        # Pre-write per-date NPZ files (needed by fill_sim_cli)
        self._write_single_npzs()

        # Optuna study (resumed if exists)
        optuna.logging.set_verbosity(optuna.logging.WARNING)
        self.study = optuna.create_study(
            study_name=study_name,
            direction="maximize",
            storage=_optuna_storage(),
            load_if_exists=True,
            sampler=TPESampler(seed=42, n_startup_trials=20),
            pruner=MedianPruner(n_startup_trials=15, n_warmup_steps=0),
        )
        print(f"[optuna_sweep] Study '{study_name}' ready — "
              f"{len(self.study.trials)} existing trials")

        # MLflow setup
        if _MLFLOW_OK:
            mlflow.set_tracking_uri(_MLFLOW_URI)
            exp = mlflow.get_experiment_by_name(mlflow_experiment)
            if exp is None:
                mlflow.create_experiment(mlflow_experiment)

    def _write_single_npzs(self) -> None:
        """
        Pre-write per-date NPZ files to self._tmp_dir.
        fill_sim_cli expects a single 'predictions' array per file.
        """
        if not _NP_OK:
            print("[optuna_sweep] WARNING: numpy not installed; NPZ rewriting skipped.", file=sys.stderr)
            return

        written = 0
        for mbo_path, date8 in self._matched:
            out_path = os.path.join(self._tmp_dir, f"{date8}.npz")
            if os.path.exists(out_path):
                continue  # Already written

            src_path = self._pred_dates.get(date8)
            if not src_path or not os.path.exists(src_path):
                continue

            try:
                d = np.load(src_path, allow_pickle=False)
                # Standardise: fill_sim_cli wants a key called 'predictions'
                if "predictions" in d:
                    preds = d["predictions"]
                else:
                    # Try first array key, or keys ending in _preds
                    keys = list(d.keys())
                    pred_key = next((k for k in keys if k.endswith("_preds")), keys[0] if keys else None)
                    if pred_key is None:
                        continue
                    preds = d[pred_key]
                np.savez(out_path, predictions=preds)
                written += 1
            except Exception as e:
                print(f"[optuna_sweep] WARNING: Failed to write NPZ for {date8}: {e}", file=sys.stderr)

        if written > 0:
            print(f"[optuna_sweep] Wrote {written} per-date NPZ files to {self._tmp_dir}")

    # ── Search space definition ───────────────────────────────────────────────

    def define_search_space(self, trial: "optuna.Trial") -> dict:
        """
        Sample hyperparameters from the search space for a single trial.

        Returns
        -------
        dict
            {param_name: sampled_value}
        """
        return {
            name: _suggest_param(trial, name, spec)
            for name, spec in self.search_space.items()
        }

    # ── Objective ─────────────────────────────────────────────────────────────

    def objective(self, trial: "optuna.Trial") -> float:
        """
        Run fill_sim_cli with the trial's hyperparameters across all OOT dates.

        Returns the mean Sortino ratio across all dates.
        Raises optuna.TrialPruned if the run is clearly unpromising.
        """
        params = self.define_search_space(trial)

        # Sanity check: TP must be less than SL (we lose more on stops than wins)
        tp = params.get("tp_ticks", 10)
        sl = params.get("sl_ticks", 20)
        if tp >= sl:
            raise optuna.TrialPruned()  # Skip bad TP/SL ratios early

        results = []
        failed_dates = 0

        for mbo_path, date8 in self._matched:
            pred_path   = os.path.join(self._tmp_dir, f"{date8}.npz")
            result_path = os.path.join(self._tmp_dir, f"result_{trial.number}_{date8}.json")

            if not os.path.exists(pred_path):
                failed_dates += 1
                continue

            cmd = self._build_command(mbo_path, pred_path, result_path, params)

            try:
                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=self.timeout_per_date,
                )
                if proc.returncode == 0 and os.path.exists(result_path):
                    with open(result_path, "r") as f:
                        data = json.load(f)
                    results.append(data)
                else:
                    failed_dates += 1
            except subprocess.TimeoutExpired:
                failed_dates += 1
            except Exception:
                failed_dates += 1
            finally:
                # Clean up per-trial result files immediately to save disk
                try:
                    if os.path.exists(result_path):
                        os.unlink(result_path)
                except OSError:
                    pass

        # Prune if too many failures (>50% of dates failed)
        if failed_dates > len(self._matched) * 0.5:
            raise optuna.TrialPruned()

        agg = _aggregate_results(results)
        sortino = agg.get("sortino", float("-inf"))

        # Prune clearly bad trials early (Sortino < -5)
        if sortino < -5.0:
            raise optuna.TrialPruned()

        # Log to MLflow
        if _MLFLOW_OK:
            self._log_trial_to_mlflow(trial, params, agg)

        return sortino if sortino != float("-inf") else float("-inf")

    def _build_command(
        self,
        mbo_path: str,
        pred_path: str,
        result_path: str,
        params: dict,
    ) -> List[str]:
        """Build the fill_sim_cli command for one date."""
        cmd = [
            self.sim_exe,
            "--mbo-file",          mbo_path,
            "--predictions",        pred_path,
            "--output",             result_path,
            "--take-profit-ticks",  str(params.get("tp_ticks", 10)),
            "--stop-loss-ticks",    str(params.get("sl_ticks", 20)),
            "--signal-threshold",   str(params.get("signal_threshold", 1.0)),
            "--hold-ms",            str(params.get("hold_ms", 300_000)),
        ]
        if params.get("chase_entry", False):
            cmd.append("--chase-entry")
        if params.get("prime_hours", True):
            cmd.append("--prime-hours")
        return cmd

    def _log_trial_to_mlflow(
        self,
        trial: "optuna.Trial",
        params: dict,
        agg: dict,
    ) -> None:
        """Log a single Optuna trial result to MLflow."""
        try:
            mlflow.set_tracking_uri(_MLFLOW_URI)
            mlflow.set_experiment(self.mlflow_experiment)
            with mlflow.start_run(
                run_name=f"{self.study_name}_trial_{trial.number}",
                tags={
                    "study":       self.study_name,
                    "card":        self.card,
                    "trial":       str(trial.number),
                    "source":      "optuna",
                },
                nested=False,
            ) as run:
                # Log params
                log_params = {str(k): str(v) for k, v in params.items()}
                log_params["card"]        = self.card
                log_params["n_oot_dates"] = str(len(self._matched))
                log_params["study_name"]  = self.study_name
                mlflow.log_params(log_params)

                # Log metrics (skip NaN/Inf)
                metrics = {}
                for k, v in agg.items():
                    fv = _safe_float(v)
                    if fv is not None:
                        metrics[k] = fv
                if metrics:
                    mlflow.log_metrics(metrics, step=trial.number)
        except Exception as e:
            print(f"[optuna_sweep] WARNING: MLflow log failed for trial {trial.number}: {e}",
                  file=sys.stderr)

    # ── Run ───────────────────────────────────────────────────────────────────

    def run(
        self,
        n_trials: int = 200,
        n_jobs: int = 8,
        show_progress: bool = True,
        timeout_seconds: Optional[int] = None,
    ) -> "optuna.Study":
        """
        Run the optimization.

        Parameters
        ----------
        n_trials : int
            Total number of trials to run.
        n_jobs : int
            Parallel workers. Each worker runs fill_sim_cli on individual dates
            sequentially; workers run different trials in parallel.
        show_progress : bool
            Show tqdm progress bar.
        timeout_seconds : int, optional
            Stop after this many seconds regardless of n_trials.

        Returns
        -------
        optuna.Study
            The completed study with best_params and best_value.
        """
        if not _OPTUNA_OK:
            raise RuntimeError("optuna is required")

        print(f"\n[optuna_sweep] Starting study '{self.study_name}'")
        print(f"  Card:         {self.card}")
        print(f"  OOT dates:    {len(self._matched)}")
        print(f"  Trials:       {n_trials}")
        print(f"  Workers:      {n_jobs}")
        print(f"  Storage:      {_OPTUNA_DB_PATH}")
        print(f"  MLflow:       {_MLFLOW_URI}/{self.mlflow_experiment}")
        print(f"  Search space: {list(self.search_space.keys())}\n")

        t0 = time.time()

        self.study.optimize(
            self.objective,
            n_trials=n_trials,
            n_jobs=n_jobs,
            show_progress_bar=show_progress,
            timeout=timeout_seconds,
            catch=(Exception,),  # Don't crash on individual trial errors
        )

        elapsed = time.time() - t0
        completed = [t for t in self.study.trials if t.state.name == "COMPLETE"]
        pruned    = [t for t in self.study.trials if t.state.name == "PRUNED"]
        failed    = [t for t in self.study.trials if t.state.name == "FAIL"]

        print(f"\n[optuna_sweep] Study '{self.study_name}' complete in {elapsed:.1f}s")
        print(f"  Completed: {len(completed)}  Pruned: {len(pruned)}  Failed: {len(failed)}")
        if self.study.best_trial:
            print(f"  Best Sortino: {self.study.best_value:.4f}")
            print(f"  Best params:  {self.study.best_params}")

        # Log best result as a summary MLflow run
        if _MLFLOW_OK and self.study.best_trial:
            self._log_best_result()

        return self.study

    def _log_best_result(self) -> None:
        """Log the best trial as a dedicated 'BEST' MLflow run for easy filtering."""
        try:
            mlflow.set_tracking_uri(_MLFLOW_URI)
            mlflow.set_experiment(self.mlflow_experiment)
            with mlflow.start_run(
                run_name=f"{self.study_name}_BEST",
                tags={
                    "study":    self.study_name,
                    "card":     self.card,
                    "is_best":  "true",
                    "source":   "optuna_summary",
                },
            ):
                best = self.study.best_trial
                params = {str(k): str(v) for k, v in best.params.items()}
                params["card"]        = self.card
                params["study_name"]  = self.study_name
                params["n_oot_dates"] = str(len(self._matched))
                params["best_trial"]  = str(best.number)
                params["n_trials"]    = str(len(self.study.trials))
                mlflow.log_params(params)
                mlflow.log_metric("best_sortino", self.study.best_value)

                # Also log search space boundaries as params
                for name, spec in self.search_space.items():
                    if spec["type"] in ("int", "float"):
                        mlflow.log_param(f"space_{name}_low",  str(spec["low"]))
                        mlflow.log_param(f"space_{name}_high", str(spec["high"]))
        except Exception as e:
            print(f"[optuna_sweep] WARNING: Failed to log best result: {e}", file=sys.stderr)

    def get_best_command(self) -> Optional[str]:
        """Return a fill_sim_cli command string with the best parameters found."""
        if not self.study.best_trial:
            return None
        params = self.study.best_params
        dummy_mbo    = "/path/to/mbo_file.dbn.zst"
        dummy_pred   = "/path/to/predictions.npz"
        dummy_output = "/path/to/output.json"
        cmd = self._build_command(dummy_mbo, dummy_pred, dummy_output, params)
        return " ".join(str(c) for c in cmd)


# ─── MLflow Optuna Callback ───────────────────────────────────────────────────

class MLflowOptunaCallback:
    """
    Optuna callback that logs each trial to MLflow.
    Can be used with any Optuna study, not just FillSimOptunaSweep.

    Usage:
        callback = MLflowOptunaCallback("Fill_Sim_Sweeps", study_name="my_study")
        study.optimize(objective, n_trials=100, callbacks=[callback])
    """

    def __init__(self, experiment_name: str, study_name: str = "optuna_study"):
        self.experiment_name = experiment_name
        self.study_name      = study_name
        if _MLFLOW_OK:
            mlflow.set_tracking_uri(_MLFLOW_URI)
            exp = mlflow.get_experiment_by_name(experiment_name)
            if exp is None:
                mlflow.create_experiment(experiment_name)

    def __call__(self, study: "optuna.Study", trial: "optuna.FrozenTrial") -> None:
        if not _MLFLOW_OK:
            return
        if trial.state.name != "COMPLETE":
            return

        try:
            mlflow.set_tracking_uri(_MLFLOW_URI)
            mlflow.set_experiment(self.experiment_name)
            with mlflow.start_run(
                run_name=f"{self.study_name}_trial_{trial.number}",
                tags={
                    "study":  self.study_name,
                    "trial":  str(trial.number),
                    "source": "optuna_callback",
                },
            ):
                if trial.params:
                    mlflow.log_params({str(k): str(v) for k, v in trial.params.items()})
                if trial.value is not None:
                    fv = _safe_float(trial.value)
                    if fv is not None:
                        mlflow.log_metric("objective", fv, step=trial.number)
                # Log user attributes as metrics
                for k, v in (trial.user_attrs or {}).items():
                    fv = _safe_float(v)
                    if fv is not None:
                        mlflow.log_metric(str(k), fv, step=trial.number)
        except Exception as e:
            print(f"[MLflowOptunaCallback] WARNING: {e}", file=sys.stderr)


# ─── CLI ──────────────────────────────────────────────────────────────────────

def _cli_main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Run an Optuna fill_sim_cli sweep with MLflow logging."
    )
    parser.add_argument("--study-name",  required=True, help="Optuna study name")
    parser.add_argument("--card",        required=True, help="Card ID (e.g. C3)")
    parser.add_argument("--mbo-dir",     required=True, help="MBO data directory")
    parser.add_argument("--pred-dir",    required=True, help="Predictions NPZ directory")
    parser.add_argument("--sim-exe",     required=True, help="Path to fill_sim_cli executable")
    parser.add_argument("--n-oot-dates", type=int, default=58,  help="OOT dates to evaluate")
    parser.add_argument("--n-trials",    type=int, default=200,  help="Number of Optuna trials")
    parser.add_argument("--n-jobs",      type=int, default=8,    help="Parallel workers")
    parser.add_argument("--timeout",     type=int, default=None, help="Max seconds to run")
    parser.add_argument(
        "--tp-range",
        nargs=2, type=int, default=[2, 20], metavar=("LOW", "HIGH"),
        help="TP ticks search range (default: 2 20)",
    )
    parser.add_argument(
        "--sl-range",
        nargs=2, type=int, default=[5, 30], metavar=("LOW", "HIGH"),
        help="SL ticks search range (default: 5 30)",
    )
    parser.add_argument(
        "--experiment",
        default="Fill_Sim_Sweeps",
        help="MLflow experiment name",
    )
    args = parser.parse_args()

    # Build custom search space if range overrides given
    search_space = dict(DEFAULT_SEARCH_SPACE)
    search_space["tp_ticks"] = {"type": "int", "low": args.tp_range[0], "high": args.tp_range[1]}
    search_space["sl_ticks"] = {"type": "int", "low": args.sl_range[0], "high": args.sl_range[1]}

    sweep = FillSimOptunaSweep(
        study_name=args.study_name,
        card=args.card,
        mbo_dir=args.mbo_dir,
        pred_dir=args.pred_dir,
        sim_exe=args.sim_exe,
        n_oot_dates=args.n_oot_dates,
        search_space=search_space,
        mlflow_experiment=args.experiment,
    )
    study = sweep.run(
        n_trials=args.n_trials,
        n_jobs=args.n_jobs,
        timeout_seconds=args.timeout,
    )

    print("\nBest fill_sim_cli command:")
    print(sweep.get_best_command())


if __name__ == "__main__":
    _cli_main()
