#!/usr/bin/env python3
"""
log_to_mlflow.py — Thin CLI wrapper called by queue_watcher.js when a job completes.

Usage:
    python compute/log_to_mlflow.py \
        --experiment "Fill_Sim_Sweeps" \
        --run-name "hold_time_test_job_abc123" \
        --params '{"node":"jupiter","card":"C3","tp_ticks":13}' \
        --metrics '{"sortino":2.4,"win_rate":0.56}' \
        --artifact "/path/to/results.json" \
        --tags '{"node":"jupiter","job_id":"abc123"}'

    # Or with a fill_sim JSON that gets auto-parsed:
    python compute/log_to_mlflow.py \
        --experiment "Fill_Sim_Sweeps" \
        --fill-sim-result "/path/to/fill_sim_output.json" \
        --params '{"card":"C3"}' \
        --tags '{"node":"saturn"}'

Exits 0 on success, 1 on error. Prints run_id to stdout on success.
"""

import sys
import os

# Resolve path to the teleclaude root so we can import utils
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)

# Delegate entirely to experiment_logger's CLI
from utils.experiment_logger import _cli_main

if __name__ == "__main__":
    _cli_main()
