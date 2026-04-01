"""
razer_setup_and_train.py
========================
Runs ON Razer (RTX 3070, Windows, user=njlia) via Ray Jobs API.

Steps:
  Phase 1 — Verify environment (GPU, Python, disk space)
  Phase 2 — Ensure directory structure exists at C:/Lvl3Quant
  Phase 3 — Download training script from Neptune HTTP (port 9877)
  Phase 4 — Download all 65 MBO event NPZ files from Neptune HTTP (port 9877)
  Phase 5 — Write a Razer-local training launcher that sets correct paths/env
  Phase 6 — Launch training as background subprocess and report PID

Neptune HTTP server: http://100.109.245.73:9877  (Tailscale) or http://192.168.0.101:9877 (LAN)
Serving root: C:/Users/Footb/Documents/Github/Lvl3Quant

This script is submitted with --entrypoint-num-gpus 0.01 so it lands on Razer.
The training itself is spawned as a separate detached process to avoid Ray job timeout.
"""

import os
import sys
import socket
import subprocess
import shutil
import time
import json
from pathlib import Path
from datetime import datetime
from urllib.request import urlretrieve, urlopen
from urllib.error import URLError
import urllib.request

# ── Constants ────────────────────────────────────────────────────────────────
RAZER_ROOT = Path("C:/Lvl3Quant")
# Ray job working dir is a temp path — use absolute paths everywhere
DEEP_MODELS_DIR = RAZER_ROOT / "alpha_discovery" / "deep_models"
DATA_DIR = RAZER_ROOT / "data" / "processed" / "mbo_events"
RESULTS_DIR = DEEP_MODELS_DIR / "results" / "event_transformer_fast"
SCRIPTS_DIR = RAZER_ROOT / "scripts"
LOGS_DIR = RAZER_ROOT / "logs"

NEPTUNE_TAILSCALE = "100.109.245.73"
NEPTUNE_LAN = "192.168.0.101"
NEPTUNE_HTTP_PORT = 9877  # serves Lvl3Quant root

TRAINING_SCRIPT_NAME = "train_event_transformer_fast.py"
NEPTUNE_SCRIPT_PATH = f"alpha_discovery/deep_models/{TRAINING_SCRIPT_NAME}"

# All 65 MBO event files
MBO_FILES = [
    "20250722_mbo_events.npz", "20250723_mbo_events.npz", "20250724_mbo_events.npz",
    "20250725_mbo_events.npz", "20250728_mbo_events.npz", "20250729_mbo_events.npz",
    "20250730_mbo_events.npz", "20250731_mbo_events.npz", "20250801_mbo_events.npz",
    "20250804_mbo_events.npz", "20250805_mbo_events.npz", "20251201_mbo_events.npz",
    "20251202_mbo_events.npz", "20251203_mbo_events.npz", "20251204_mbo_events.npz",
    "20251205_mbo_events.npz", "20251207_mbo_events.npz", "20251208_mbo_events.npz",
    "20251209_mbo_events.npz", "20251210_mbo_events.npz", "20251211_mbo_events.npz",
    "20251212_mbo_events.npz", "20251214_mbo_events.npz", "20251215_mbo_events.npz",
    "20251216_mbo_events.npz", "20251217_mbo_events.npz", "20251219_mbo_events.npz",
    "20251221_mbo_events.npz", "20251222_mbo_events.npz", "20251223_mbo_events.npz",
    "20251224_mbo_events.npz", "20251225_mbo_events.npz", "20251226_mbo_events.npz",
    "20251228_mbo_events.npz", "20251229_mbo_events.npz", "20251230_mbo_events.npz",
    "20251231_mbo_events.npz", "20260101_mbo_events.npz", "20260102_mbo_events.npz",
    "20260104_mbo_events.npz", "20260105_mbo_events.npz", "20260106_mbo_events.npz",
    "20260107_mbo_events.npz", "20260108_mbo_events.npz", "20260109_mbo_events.npz",
    "20260111_mbo_events.npz", "20260112_mbo_events.npz", "20260113_mbo_events.npz",
    "20260114_mbo_events.npz", "20260115_mbo_events.npz", "20260116_mbo_events.npz",
    "20260118_mbo_events.npz", "20260119_mbo_events.npz", "20260120_mbo_events.npz",
    "20260121_mbo_events.npz", "20260122_mbo_events.npz", "20260123_mbo_events.npz",
    "20260125_mbo_events.npz", "20260126_mbo_events.npz", "20260127_mbo_events.npz",
    "20260128_mbo_events.npz", "20260201_mbo_events.npz", "20260202_mbo_events.npz",
    "20260208_mbo_events.npz", "20260215_mbo_events.npz",
]


# ── Helpers ──────────────────────────────────────────────────────────────────
def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        log_file = LOGS_DIR / "razer_setup_train.log"
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def find_neptune_ip():
    """Try Tailscale first, then LAN."""
    for ip in [NEPTUNE_TAILSCALE, NEPTUNE_LAN]:
        try:
            url = f"http://{ip}:{NEPTUNE_HTTP_PORT}/"
            req = urllib.request.Request(url, method="HEAD")
            with urlopen(req, timeout=5):
                log(f"Neptune HTTP reachable at {ip}:{NEPTUNE_HTTP_PORT}")
                return ip
        except Exception as e:
            log(f"Neptune {ip}:{NEPTUNE_HTTP_PORT} not reachable: {e}")
    return None


def http_download(url: str, dest: Path, label: str = "") -> bool:
    """Download a file via HTTP with retry."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            urlretrieve(url, str(dest))
            size_kb = dest.stat().st_size // 1024
            log(f"  [OK] {label or dest.name} ({size_kb} KB)")
            return True
        except Exception as e:
            log(f"  [WARN] attempt {attempt+1}/3 failed for {label or dest.name}: {e}")
            time.sleep(2)
    log(f"  [FAIL] {label or dest.name} — giving up after 3 attempts")
    return False


# ── Phase 1: Environment check ───────────────────────────────────────────────
log("=" * 60)
log("Razer Setup + Training Launch")
log(f"Host: {socket.gethostname()}  |  Platform: {sys.platform}")
log(f"Python: {sys.version.split()[0]}")
log("=" * 60)

# GPU check
log("\n--- Phase 1: GPU / environment check ---")
try:
    import torch
    cuda_ok = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if cuda_ok else "none"
    vram_gb = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1) if cuda_ok else 0
    log(f"  torch={torch.__version__}  cuda={cuda_ok}  gpu={gpu_name}  vram={vram_gb}GB")
except ImportError:
    log("  [WARN] torch not installed — will attempt to install")
    cuda_ok = False
    gpu_name = "unknown"

# Disk space check (C: drive)
try:
    import shutil as _sh
    total, used, free = _sh.disk_usage("C:/")
    free_gb = round(free / 1e9, 1)
    log(f"  C: drive free: {free_gb} GB")
    if free_gb < 10:
        log("  [WARN] Less than 10 GB free — data download may fail")
except Exception as e:
    log(f"  Disk check error: {e}")


# ── Phase 2: Directory structure ─────────────────────────────────────────────
log("\n--- Phase 2: Ensure directory structure ---")
REQUIRED_DIRS = [
    DEEP_MODELS_DIR / "results" / "event_transformer_fast",
    DEEP_MODELS_DIR / "checkpoints",
    DATA_DIR,
    SCRIPTS_DIR,
    LOGS_DIR,
    RAZER_ROOT / "config",
]
for d in REQUIRED_DIRS:
    d.mkdir(parents=True, exist_ok=True)
    log(f"  [OK] {d}")

# Try junction C:/Users/claude/Lvl3Quant -> C:/Lvl3Quant for script compatibility
canonical = Path("C:/Users/claude/Lvl3Quant")
try:
    exists = canonical.exists()
except PermissionError:
    exists = False
    log("  Cannot check C:/Users/claude/ (permission denied)")

if not exists:
    rc = subprocess.call(
        f'mklink /J "{canonical}" "{RAZER_ROOT}"',
        shell=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if rc == 0:
        log(f"  [OK] Junction: {canonical} -> {RAZER_ROOT}")
    else:
        log(f"  [WARN] Junction creation failed (rc={rc}) — script paths hardcoded to C:/Users/claude/ will not resolve")
else:
    log(f"  [OK] {canonical} already exists")


# ── Phase 3: Download training script from Neptune ───────────────────────────
log("\n--- Phase 3: Download training script ---")
neptune_ip = find_neptune_ip()

script_ok = False
if neptune_ip:
    script_dest = DEEP_MODELS_DIR / TRAINING_SCRIPT_NAME
    if script_dest.exists():
        log(f"  [SKIP] {TRAINING_SCRIPT_NAME} already exists ({script_dest.stat().st_size // 1024} KB)")
        script_ok = True
    else:
        url = f"http://{neptune_ip}:{NEPTUNE_HTTP_PORT}/{NEPTUNE_SCRIPT_PATH}"
        script_ok = http_download(url, script_dest, TRAINING_SCRIPT_NAME)

    # Also download event_features.py (dependency)
    for dep in ["event_features.py", "event_transformer.py"]:
        dep_dest = DEEP_MODELS_DIR / dep
        if not dep_dest.exists():
            dep_url = f"http://{neptune_ip}:{NEPTUNE_HTTP_PORT}/alpha_discovery/deep_models/{dep}"
            http_download(dep_url, dep_dest, dep)
        else:
            log(f"  [SKIP] {dep} already exists")
else:
    log("  [FAIL] Neptune not reachable — cannot download training script")
    log("  MANUAL ACTION: Copy train_event_transformer_fast.py to C:/Lvl3Quant/alpha_discovery/deep_models/")

log(f"  Training script ready: {script_ok}")


# ── Phase 4: Download MBO event NPZ files ────────────────────────────────────
log("\n--- Phase 4: Download MBO event NPZ files ---")
downloaded = 0
skipped = 0
failed = 0
failed_files = []

if neptune_ip:
    base_url = f"http://{neptune_ip}:{NEPTUNE_HTTP_PORT}/data/processed/mbo_events"
    total_files = len(MBO_FILES)
    log(f"  Downloading {total_files} NPZ files from {base_url}")

    for i, fname in enumerate(MBO_FILES):
        dest = DATA_DIR / fname
        if dest.exists() and dest.stat().st_size > 10_000:  # >10KB means valid
            skipped += 1
            continue
        url = f"{base_url}/{fname}"
        ok = http_download(url, dest, f"[{i+1}/{total_files}] {fname}")
        if ok:
            downloaded += 1
        else:
            failed += 1
            failed_files.append(fname)

    log(f"  Summary: downloaded={downloaded}  skipped={skipped}  failed={failed}")
    if failed_files:
        log(f"  Failed files: {failed_files}")
else:
    log("  [SKIP] Neptune not reachable — no data downloaded")
    log("  MBO files present: " + str(len(list(DATA_DIR.glob("*.npz")))))

total_npz = len(list(DATA_DIR.glob("*.npz")))
log(f"  Total NPZ files in {DATA_DIR}: {total_npz}")


# ── Phase 5: Write training launcher script ───────────────────────────────────
log("\n--- Phase 5: Write training launcher ---")

launcher_path = RAZER_ROOT / "scripts" / "launch_event_transformer_razer.py"

launcher_content = f"""#!/usr/bin/env python3.11
\"\"\"
launch_event_transformer_razer.py
Generated by razer_setup_and_train.py on {datetime.now().isoformat()}

Launches train_event_transformer_fast.py on Razer with correct paths/env.
Run this directly:  python3.11 C:/Lvl3Quant/scripts/launch_event_transformer_razer.py
\"\"\"

import os
import sys
import subprocess
from pathlib import Path

RAZER_ROOT = Path("C:/Lvl3Quant")
SCRIPT = RAZER_ROOT / "alpha_discovery" / "deep_models" / "train_event_transformer_fast.py"
DATA_DIR = RAZER_ROOT / "data" / "processed" / "mbo_events"
OUTPUT_DIR = RAZER_ROOT / "alpha_discovery" / "deep_models" / "results" / "event_transformer_fast"

if not SCRIPT.exists():
    print(f"ERROR: Training script not found: {{SCRIPT}}")
    sys.exit(1)

npz_count = len(list(DATA_DIR.glob("*.npz")))
if npz_count < 10:
    print(f"WARNING: Only {{npz_count}} NPZ files found in {{DATA_DIR}}. Expected 65.")
    print("Training will proceed but may have fewer folds than expected.")

env = dict(os.environ)
env["MLFLOW_TRACKING_URI"] = "http://{NEPTUNE_TAILSCALE}:5000"
env["CUDA_VISIBLE_DEVICES"] = "0"
env["PYTHONPATH"] = str(RAZER_ROOT)

cmd = [
    sys.executable,
    str(SCRIPT),
    "--data-dir", str(DATA_DIR),
    "--output-dir", str(OUTPUT_DIR),
    "--n-folds", "5",
    "--device", "cuda",
]

print(f"Launching: {{' '.join(cmd)}}")
print(f"MLflow: {{env['MLFLOW_TRACKING_URI']}}")
print(f"Data: {{npz_count}} NPZ files")
print(f"Output: {{OUTPUT_DIR}}")
print()

proc = subprocess.Popen(
    cmd,
    env=env,
    cwd=str(RAZER_ROOT / "alpha_discovery" / "deep_models"),
    stdout=open(str(RAZER_ROOT / "logs" / "event_transformer_train.log"), "w", encoding="utf-8"),
    stderr=subprocess.STDOUT,
    creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
)

print(f"Training launched! PID={{proc.pid}}")
print(f"Monitor: C:/Lvl3Quant/logs/event_transformer_train.log")
print(f"Results: {{OUTPUT_DIR}}")

pid_file = RAZER_ROOT / "logs" / "event_transformer_pid.txt"
pid_file.write_text(str(proc.pid))
print(f"PID saved to: {{pid_file}}")
"""

with open(launcher_path, "w", encoding="utf-8") as f:
    f.write(launcher_content)
log(f"  [OK] Launcher written: {launcher_path}")


# ── Phase 6: Launch training ──────────────────────────────────────────────────
log("\n--- Phase 6: Launch training ---")

training_script = DEEP_MODELS_DIR / TRAINING_SCRIPT_NAME
npz_count = len(list(DATA_DIR.glob("*.npz")))

if not training_script.exists():
    log(f"  [FAIL] Training script not found: {training_script}")
    log("  Cannot launch training. Run Phase 3 manually.")
elif npz_count < 5:
    log(f"  [FAIL] Only {npz_count} NPZ files — need at least 5 to train")
    log(f"  Run: python3.11 {launcher_path}")
else:
    log(f"  Training script: {training_script}")
    log(f"  Data files: {npz_count}")
    log("  Launching training as background process...")

    output_dir = DEEP_MODELS_DIR / "results" / "event_transformer_fast"
    output_dir.mkdir(parents=True, exist_ok=True)
    train_log = LOGS_DIR / "event_transformer_train.log"

    env = dict(os.environ)
    env["MLFLOW_TRACKING_URI"] = f"http://{NEPTUNE_TAILSCALE}:5000"
    env["CUDA_VISIBLE_DEVICES"] = "0"
    env["PYTHONPATH"] = str(RAZER_ROOT)

    cmd = [
        sys.executable,
        str(training_script),
        "--data-dir", str(DATA_DIR),
        "--output-dir", str(output_dir),
        "--n-folds", "5",
        "--device", "cuda",
    ]

    log(f"  CMD: {' '.join(cmd)}")
    log(f"  MLFLOW_TRACKING_URI: {env['MLFLOW_TRACKING_URI']}")
    log(f"  Log: {train_log}")

    try:
        proc = subprocess.Popen(
            cmd,
            env=env,
            cwd=str(DEEP_MODELS_DIR),
            stdout=open(str(train_log), "w", encoding="utf-8"),
            stderr=subprocess.STDOUT,
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        pid = proc.pid
        log(f"  [OK] Training launched! PID={pid}")

        # Save PID for monitoring
        pid_file = LOGS_DIR / "event_transformer_pid.txt"
        pid_file.write_text(str(pid))
        log(f"  PID saved: {pid_file}")

    except Exception as e:
        log(f"  [FAIL] Could not launch training: {e}")
        pid = None


# ── Summary ───────────────────────────────────────────────────────────────────
log("\n" + "=" * 60)
log("SETUP SUMMARY")
log("=" * 60)
log(f"Host:              {socket.gethostname()}")
log(f"GPU:               {gpu_name}")
log(f"CUDA available:    {cuda_ok}")
log(f"Neptune reachable: {neptune_ip is not None} ({neptune_ip})")
log(f"Training script:   {training_script.exists()}")
log(f"NPZ files:         {npz_count} / {len(MBO_FILES)}")
log(f"Razer root:        {RAZER_ROOT}")
log(f"Results dir:       {RESULTS_DIR}")
log(f"MLflow URI:        http://{NEPTUNE_TAILSCALE}:5000")

status = {
    "timestamp": datetime.now().isoformat(),
    "hostname": socket.gethostname(),
    "gpu": gpu_name,
    "cuda": cuda_ok,
    "neptune_ip": neptune_ip,
    "script_ready": training_script.exists(),
    "npz_files": npz_count,
    "training_launched": npz_count >= 5 and training_script.exists(),
    "training_pid": locals().get("pid"),
    "log_path": str(LOGS_DIR / "event_transformer_train.log"),
    "results_dir": str(RESULTS_DIR),
    "mlflow_uri": f"http://{NEPTUNE_TAILSCALE}:5000",
}

report_path = RAZER_ROOT / "setup_train_report.json"
with open(report_path, "w") as f:
    json.dump(status, f, indent=2)
log(f"Report: {report_path}")

print("\n=== STATUS JSON ===")
print(json.dumps(status, indent=2))
