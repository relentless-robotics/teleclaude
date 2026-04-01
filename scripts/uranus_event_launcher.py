#!/usr/bin/env python3
"""
uranus_event_launcher.py
Runs on Uranus. Sequence:
  1. Transfer MBO data from Jupiter
  2. Launch Architecture 1: EventSSM (runs while MFE/MAE finishes if needed)
  3. After Arch 1 completes, launch Architecture 2: HierarchicalEventModel

This script is the master orchestrator for event-driven experiment pipeline.
"""
import subprocess
import time
import logging
import sys
from pathlib import Path

LVL3 = Path(r"C:\Users\Nick\Lvl3Quant")
SCRIPTS_DIR = LVL3 / "scripts" / "event_models"
LOG_DIR = LVL3 / "results"

LOG_DIR.mkdir(parents=True, exist_ok=True)
SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [event_launcher] %(message)s",
    handlers=[
        logging.FileHandler(str(LOG_DIR / "event_launcher.log"), mode="a"),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger("event_launcher")

TRANSFER_SCRIPT    = str(SCRIPTS_DIR / "transfer_mbo_data.py")
SSM_SCRIPT         = str(SCRIPTS_DIR / "event_ssm_v1.py")
HIERARCHICAL_SCRIPT = str(SCRIPTS_DIR / "event_hierarchical_v1.py")
SSM_LOG            = str(LOG_DIR / "event_mamba_v1.log")
HIERARCHICAL_LOG   = str(LOG_DIR / "event_hierarchical_v1.log")

DATA_DIR = LVL3 / "data" / "processed" / "mbo_events"


def count_data_files():
    return len(list(DATA_DIR.glob("*.npz")))


def is_process_running(script_name: str) -> bool:
    """Check if a Python process matching script_name is running."""
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"Get-WmiObject Win32_Process | Where-Object {{$_.CommandLine -like '*{script_name}*'}} | "
         f"Select-Object -ExpandProperty ProcessId"],
        capture_output=True, text=True
    )
    return bool(result.stdout.strip())


def wait_for_process(script_name: str, check_interval: int = 60):
    """Block until named process completes."""
    while is_process_running(script_name):
        log.info(f"{script_name} still running... checking in {check_interval}s")
        time.sleep(check_interval)


def run_hidden(cmd: list, log_path: str):
    """Launch process with no window, redirect output to log."""
    log.info(f"Launching: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        stdout=open(log_path, "a"),
        stderr=subprocess.STDOUT,
        creationflags=0x08000000,  # CREATE_NO_WINDOW
        cwd=str(LVL3),
    )
    return proc


def main():
    log.info("=" * 60)
    log.info("Uranus Event Model Launcher starting")
    log.info("Pipeline: Transfer → SSM (Arch 1) → Hierarchical (Arch 2)")
    log.info("=" * 60)

    # Step 1: Transfer data if needed
    n_files = count_data_files()
    log.info(f"Current data files on Uranus: {n_files}")
    if n_files < 30:
        log.info("Need more data files. Running transfer from Jupiter...")
        result = subprocess.run(
            ["python", TRANSFER_SCRIPT],
            capture_output=True, text=True, timeout=3600
        )
        log.info(f"Transfer stdout: {result.stdout[-500:]}")
        if result.returncode != 0:
            log.error(f"Transfer failed: {result.stderr[-200:]}")
        n_files = count_data_files()
        log.info(f"After transfer: {n_files} data files")
    else:
        log.info(f"Sufficient data ({n_files} files). Skipping transfer.")

    if n_files < 5:
        log.error("Not enough data files to train. Exiting.")
        sys.exit(1)

    # Step 2: Launch Architecture 1 (SSM)
    log.info("\nLaunching Architecture 1: EventSSM (S4-style State Space Model)")
    log.info(f"Window: 5000 events | Layers: 6 | d_model: 256 | d_state: 64")
    log.info(f"Log: {SSM_LOG}")

    ssm_proc = run_hidden(["python", SSM_SCRIPT], SSM_LOG)
    log.info(f"SSM launched, PID={ssm_proc.pid}")

    # Wait for SSM to complete
    log.info("Waiting for Architecture 1 (SSM) to complete...")
    ssm_proc.wait()
    log.info(f"Architecture 1 (SSM) complete, returncode={ssm_proc.returncode}")

    # Step 3: Launch Architecture 2 (Hierarchical)
    log.info("\nLaunching Architecture 2: HierarchicalEventModel")
    log.info(f"Level 1: {30} chunks x 1s | Micro d=64, 4L | Macro d=128, 4L")
    log.info(f"Log: {HIERARCHICAL_LOG}")

    hier_proc = run_hidden(["python", HIERARCHICAL_SCRIPT], HIERARCHICAL_LOG)
    log.info(f"Hierarchical launched, PID={hier_proc.pid}")

    # Wait for Hierarchical to complete
    log.info("Waiting for Architecture 2 (Hierarchical) to complete...")
    hier_proc.wait()
    log.info(f"Architecture 2 (Hierarchical) complete, returncode={hier_proc.returncode}")

    log.info("\nAll event model experiments complete!")
    log.info(f"Results in: {LOG_DIR}")


if __name__ == "__main__":
    main()
