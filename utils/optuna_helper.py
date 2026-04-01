"""
Optuna Helper — Persistent SQLite-backed study management.

Storage: C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\optuna\\optuna.db

Usage:
    from utils.optuna_helper import create_study, get_study

    # Create or resume a study
    study = create_study("fill_sim_tp_sl", direction="maximize")
    study.optimize(my_objective, n_trials=100)

    # Resume later
    study = get_study("fill_sim_tp_sl")
    print(study.best_params)
"""

import os
import optuna
from pathlib import Path

# ─── Storage ─────────────────────────────────────────────────────────────────

OPTUNA_DB_PATH = r"C:\Users\Footb\Documents\Github\Lvl3Quant\optuna\optuna.db"

def _storage_url() -> str:
    """Return SQLite storage URL, creating the directory if needed."""
    Path(OPTUNA_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{OPTUNA_DB_PATH}"


# ─── Public API ───────────────────────────────────────────────────────────────

def create_study(
    name: str,
    direction: str = "maximize",
    sampler=None,
    pruner=None,
    load_if_exists: bool = True,
) -> optuna.Study:
    """
    Create (or resume) a named Optuna study backed by SQLite.

    Parameters
    ----------
    name : str
        Unique study name (e.g. 'fill_sim_v1_tp_sl').
    direction : str
        'maximize' or 'minimize'.
    sampler : optuna.samplers.BaseSampler, optional
        Defaults to TPESampler.
    pruner : optuna.pruners.BasePruner, optional
        Defaults to MedianPruner.
    load_if_exists : bool
        If True (default), resume study if it already exists in DB.

    Returns
    -------
    optuna.Study
    """
    storage = _storage_url()
    study = optuna.create_study(
        study_name=name,
        direction=direction,
        storage=storage,
        load_if_exists=load_if_exists,
        sampler=sampler or optuna.samplers.TPESampler(seed=42),
        pruner=pruner or optuna.pruners.MedianPruner(n_startup_trials=10),
    )
    print(f"[optuna_helper] Study '{name}' ready — {len(study.trials)} existing trials")
    return study


def get_study(name: str) -> optuna.Study:
    """
    Load an existing study by name. Raises KeyError if not found.
    """
    storage = _storage_url()
    return optuna.load_study(study_name=name, storage=storage)


def list_studies() -> list[str]:
    """Return names of all studies in the SQLite database."""
    storage = _storage_url()
    summaries = optuna.get_all_study_summaries(storage=storage)
    return [s.study_name for s in summaries]


def delete_study(name: str) -> None:
    """Permanently delete a study from the database."""
    storage = _storage_url()
    optuna.delete_study(study_name=name, storage=storage)
    print(f"[optuna_helper] Study '{name}' deleted.")


# ─── Example objective template ───────────────────────────────────────────────
#
# This shows how to optimize fill_sim_cli parameters via Optuna.
# Replace the subprocess call with your actual fill_sim_cli invocation.
#
# def fill_sim_objective(trial: optuna.Trial) -> float:
#     """
#     Example: optimize TP/SL and cancel_time for fill_sim_cli.
#     Returns Sortino ratio (maximize).
#     """
#     import subprocess, json, tempfile, os
#
#     tp_ticks    = trial.suggest_float("tp_ticks",    1.0, 8.0, step=0.25)
#     sl_ticks    = trial.suggest_float("sl_ticks",    1.0, 8.0, step=0.25)
#     cancel_time = trial.suggest_int(  "cancel_time", 1,   30)
#     entry_side  = trial.suggest_categorical("entry_side", ["long", "short", "both"])
#
#     result_file = tempfile.mktemp(suffix=".json")
#     cmd = [
#         "python", "scripts/fill_sim_cli.py",
#         "--tp", str(tp_ticks),
#         "--sl", str(sl_ticks),
#         "--cancel-time", str(cancel_time),
#         "--side", entry_side,
#         "--output", result_file,
#     ]
#
#     proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
#     if proc.returncode != 0 or not os.path.exists(result_file):
#         raise optuna.TrialPruned()  # prune bad runs instead of crashing
#
#     with open(result_file) as f:
#         result = json.load(f)
#
#     os.unlink(result_file)
#     return result.get("sortino", float("-inf"))
#
#
# if __name__ == "__main__":
#     study = create_study("fill_sim_tp_sl_v1", direction="maximize")
#     study.optimize(fill_sim_objective, n_trials=200, n_jobs=4, show_progress_bar=True)
#     print("Best params:", study.best_params)
#     print("Best Sortino:", study.best_value)
