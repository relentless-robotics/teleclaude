# setup_razer.py -- Bootstrap Lvl3Quant on Razer (Christian-Razer14, 100.102.215.75)
#
# Phases:
#   1. Verify we are running on Razer
#   2. Create full Lvl3Quant directory structure
#   3. Pull code tree from Neptune (100.109.245.73) via SCP/robocopy
#   4. Create data directories (data sync handled separately -- files are too large for Ray)
#   5. Install Python dependencies
#   6. Verify setup and write a status report
#   7. Attempt to create junction C:/Users/claude/Lvl3Quant -> C:/Lvl3Quant
#
# Neptune Tailscale IP: 100.109.245.73
# Neptune LAN IP: 192.168.0.101
# Razer Tailscale IP: 100.102.215.75
# Razer Ray worker user: christian-razer/njlia
# Lvl3Quant canonical path: C:/Users/claude/Lvl3Quant
# Accessible working path: C:/Lvl3Quant (root drive, writable by njlia)
#
# NOTE: Ray worker runs as njlia which cannot write to C:/Users/claude/.
# We create at C:/Lvl3Quant and try to create a junction for compatibility.

import os
import sys
import socket
import subprocess
import shutil
import time
import json
from pathlib import Path
from datetime import datetime

# ── Config ──────────────────────────────────────────────────────────────────
# Ray worker (njlia) can write here; C:\Users\claude\ is access-denied
RAZER_ROOT = Path("C:/Lvl3Quant")
RAZER_CANONICAL = Path("C:/Users/claude/Lvl3Quant")  # desired canonical path
NEPTUNE_TAILSCALE = "100.109.245.73"
NEPTUNE_LAN = "192.168.0.101"
NEPTUNE_ROOT_UNC = r"\\100.109.245.73\lvl3quant_share"  # fallback — may not exist
NEPTUNE_WINSHARE = r"\\192.168.0.101\lvl3quant_share"
NEPTUNE_SSH_USER = "Footb"  # Neptune Windows SSH user
NEPTUNE_LVL3 = "C:/Users/Footb/Documents/Github/Lvl3Quant"

LOG_FILE = RAZER_ROOT / "setup_razer.log"

# Directories to create even if robocopy fails
REQUIRED_DIRS = [
    "alpha_discovery/deep_models/checkpoints/book",
    "alpha_discovery/deep_models/checkpoints/1min_cnn_wf",
    "alpha_discovery/deep_models/results",
    "alpha_discovery/data",
    "alpha_discovery/experiments",
    "data/processed/mbo_events",
    "data/processed/dl_book_cache",
    "data/processed/dl_events_cache",
    "data/processed/dl_trades_cache",
    "data/processed/mbo_features_cache",
    "data/processed/event_predictions",
    "data/processed/cnn_wf_stacked_predictions",
    "data/processed/cnn_wf_stacked_results",
    "data/raw",
    "data/spy",
    "config",
    "scripts",
    "utils",
    "models/1min_cnn_wf",
    "models/wider_cnn_wf",
    "models/hybrid_v3_wf",
    "fill_sim_test/event_preds",
    "fill_sim_test/event_results",
    "fill_sim_test/event_model_preds",
    "live_trading/logs",
    "live_trading/data",
    "analysis",
    "logs",
]

# Python packages needed for training
REQUIRED_PACKAGES = [
    "torch",
    "numpy",
    "pandas",
    "scikit-learn",
    "mlflow",
    "optuna",
    "lightgbm",
    "ray[default]",
    "psutil",
    "tqdm",
    "scipy",
]


def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def run(cmd, check=True, timeout=300, capture=False):
    """Run a shell command, return (returncode, stdout, stderr)."""
    log(f"  RUN: {cmd}")
    result = subprocess.run(
        cmd, shell=True, capture_output=capture,
        text=True, timeout=timeout
    )
    if capture:
        return result.returncode, result.stdout, result.stderr
    return result.returncode, "", ""


def ping(host, count=2):
    """Returns True if host is reachable."""
    rc, _, _ = run(f"ping -n {count} -w 1000 {host}", check=False, capture=True)
    return rc == 0


# ── Phase 0: Verify we're on Razer ─────────────────────────────────────────
log("=" * 60)
log("Razer Setup Script — Lvl3Quant Bootstrap")
log("=" * 60)
hostname = socket.gethostname()
log(f"Hostname: {hostname}")
log(f"Platform: {sys.platform}")
log(f"Python: {sys.version}")

if "razer" not in hostname.lower() and "christian" not in hostname.lower():
    log(f"WARNING: Hostname '{hostname}' doesn't look like Razer. Proceeding anyway.")

# ── Phase 1: Create root directory ─────────────────────────────────────────
log("\n--- Phase 1: Create directory structure ---")
RAZER_ROOT.mkdir(parents=True, exist_ok=True)
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)  # ensure log works

for rel in REQUIRED_DIRS:
    d = RAZER_ROOT / rel
    d.mkdir(parents=True, exist_ok=True)
    log(f"  [OK] {rel}")

log("Directory structure created.")

# Try to create junction C:/Users/claude/Lvl3Quant -> C:/Lvl3Quant
# so that scripts hardcoded to C:/Users/claude/ still work
log("\n  Attempting junction: C:/Users/claude/Lvl3Quant -> C:/Lvl3Quant")
try:
    canonical_exists = RAZER_CANONICAL.exists()
except PermissionError:
    canonical_exists = False
    log("  Cannot check C:/Users/claude/ (permission denied) — will attempt mklink anyway")

if not canonical_exists:
    rc, out, err = run(
        f'mklink /J "{str(RAZER_CANONICAL)}" "{str(RAZER_ROOT)}"',
        check=False, capture=True, timeout=10
    )
    if rc == 0:
        log("  [OK] Junction created: C:/Users/claude/Lvl3Quant -> C:/Lvl3Quant")
    else:
        log(f"  [WARN] Junction failed (rc={rc}): {err[:200]}")
        log("  Paths hardcoded to C:/Users/claude/Lvl3Quant will not resolve via njlia account.")
        log("  ACTION REQUIRED: Log in as user 'claude' on Razer and run:")
        log("    mklink /J C:\\Users\\claude\\Lvl3Quant C:\\Lvl3Quant")
else:
    log("  [SKIP] C:/Users/claude/Lvl3Quant already exists")

# ── Phase 2: Network reachability check ────────────────────────────────────
log("\n--- Phase 2: Check network connectivity to Neptune ---")
neptune_ip = None
for ip in [NEPTUNE_TAILSCALE, NEPTUNE_LAN]:
    if ping(ip):
        neptune_ip = ip
        log(f"  Neptune reachable at {ip}")
        break
    else:
        log(f"  Neptune NOT reachable at {ip}")

if not neptune_ip:
    log("WARNING: Neptune is not reachable via ping. Will still attempt robocopy/scp.")
    neptune_ip = NEPTUNE_TAILSCALE  # best guess

# ── Phase 3: Copy code tree from Neptune ───────────────────────────────────
log("\n--- Phase 3: Copy code from Neptune via SCP (SSH) ---")

# Try SCP via SSH (assumes SSH server running on Neptune port 22)
# Neptune Windows SSH: user 'Footb', key-based auth expected
# We copy only code files (no large data dirs)

SSH_CMD = f"ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 {NEPTUNE_SSH_USER}@{neptune_ip}"

# Test SSH connection first
log(f"  Testing SSH to {NEPTUNE_SSH_USER}@{neptune_ip}...")
rc, out, err = run(f'{SSH_CMD} "echo SSH_OK"', check=False, capture=True, timeout=20)
ssh_ok = rc == 0 and "SSH_OK" in out

if ssh_ok:
    log("  SSH connection: SUCCESS")

    # SCP the code directories (excluding large data)
    # Use rsync-style SCP with exclusions via a tar pipe
    CODE_DIRS = [
        "alpha_discovery",
        "analysis",
        "config",
        "scripts",
        "utils",
        "fill_sim_test",
        "live_trading",
        "docs",
    ]

    RAZER_ROOT_WIN = str(RAZER_ROOT).replace("/", "\\")

    for code_dir in CODE_DIRS:
        src = f"{NEPTUNE_LVL3}/{code_dir}"
        dst = str(RAZER_ROOT).replace("\\", "/")
        log(f"  SCP: {code_dir} -> {dst}/")

        # Use scp -r to copy directory recursively
        # Exclude large binary dirs inside alpha_discovery
        scp_cmd = (
            f'scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 -r '
            f'{NEPTUNE_SSH_USER}@{neptune_ip}:"{src}" "{dst}/"'
        )
        rc, out, err = run(scp_cmd, check=False, capture=True, timeout=600)
        if rc == 0:
            log(f"  [OK] {code_dir} copied")
        else:
            log(f"  [FAIL] {code_dir}: rc={rc} err={err[:200]}")

    # Copy top-level Python scripts (glob won't work over SCP, use SSH+tar)
    log("  Copying top-level .py scripts via SSH tar pipe...")
    tar_cmd = (
        f'{SSH_CMD} "cd \\"{NEPTUNE_LVL3}\\" && tar czf - --include=*.py *.py 2>/dev/null" '
        f'| tar xzf - -C "{str(RAZER_ROOT)}"'
    )
    rc, out, err = run(tar_cmd, check=False, capture=True, timeout=120)
    if rc == 0:
        log("  [OK] Top-level .py scripts copied")
    else:
        log(f"  [WARN] tar pipe rc={rc} (may be unsupported on Windows SSH) err={err[:200]}")

    # Copy config json files
    for fname in ["training_standard.json", "card_overrides.json"]:
        for search_path in [f"{NEPTUNE_LVL3}/config/{fname}", f"{NEPTUNE_LVL3}/{fname}"]:
            scp_cmd = (
                f'scp -o StrictHostKeyChecking=no {NEPTUNE_SSH_USER}@{neptune_ip}:'
                f'"{search_path}" "{str(RAZER_ROOT / "config" / fname)}"'
            )
            rc, _, _ = run(scp_cmd, check=False, capture=True, timeout=30)
            if rc == 0:
                log(f"  [OK] {fname}")
                break

else:
    log(f"  SSH connection FAILED (rc={rc}): {err[:300]}")
    log("  Falling back to robocopy over UNC path (requires Windows file share)...")

    # Try robocopy over UNC share — only works if Neptune has a share set up
    # Share name: lvl3quant_share -> C:\Users\Footb\Documents\Github\Lvl3Quant
    unc_accessible = False
    for unc_base in [NEPTUNE_WINSHARE, NEPTUNE_ROOT_UNC]:
        log(f"  Trying UNC: {unc_base}")
        # Use a very short timeout — if the share doesn't exist it hangs
        try:
            rc, out, err = run(
                f'dir "{unc_base}" 2>&1', check=False, capture=True, timeout=5
            )
        except Exception as e:
            log(f"  UNC check timed out or errored: {e}")
            rc = 1
        if rc == 0 and "File Not Found" not in out and "cannot find" not in out.lower():
            log(f"  UNC share accessible: {unc_base}")
            unc_accessible = True
            # Robocopy code dirs
            for code_dir in ["alpha_discovery", "analysis", "config", "scripts", "utils", "fill_sim_test"]:
                src_unc = f"{unc_base}\\{code_dir}"
                dst_win = str(RAZER_ROOT / code_dir)
                rc2, _, _ = run(
                    f'robocopy "{src_unc}" "{dst_win}" /E /NFL /NDL /NP /MT:8 /XD __pycache__ .git',
                    check=False, capture=True, timeout=300
                )
                log(f"  robocopy {code_dir}: rc={rc2} (1=OK 3=OK)")
            break
        else:
            log(f"  UNC {unc_base}: not accessible (rc={rc})")

    if not unc_accessible:
        log("  No network share or SSH accessible. Code sync skipped.")
        log("  ACTIONS REQUIRED to sync code from Neptune:")
        log("    Option A: Enable OpenSSH server on Neptune (Windows Settings > Apps > Optional Features)")
        log(f"    Option B: Create a Windows share on Neptune: net share lvl3quant_share={NEPTUNE_LVL3}")
        log("    Option C: Manually robocopy from Neptune when on same network")
        log("  Directory structure is created and ready. Re-run after network access is set up.")

# ── Phase 4: Patch hardcoded paths in config ───────────────────────────────
log("\n--- Phase 4: Patch config for Razer paths ---")
config_file = RAZER_ROOT / "config" / "training_standard.json"
if config_file.exists():
    with open(config_file) as f:
        cfg = json.load(f)

    # Add Razer node entry
    if "nodes" not in cfg:
        cfg["nodes"] = {}
    cfg["nodes"]["razer"] = {
        "host": "100.102.215.75",
        "tailscale_ip": "100.102.215.75",
        "ray_worker_user": "njlia",
        "gpu": "RTX 3070",
        "vram_gb": 8,
        "lvl3_root": "C:/Lvl3Quant",
        "lvl3_root_canonical": "C:/Users/claude/Lvl3Quant",
        "book_cache": "data/processed/dl_book_cache",
        "events_cache": "data/processed/mbo_events",
        "results_dir": "alpha_discovery/deep_models/results",
        "role": "next_gen_architecture_research",
        "note": "Ray worker runs as njlia. Working path is C:/Lvl3Quant. Junction to C:/Users/claude/Lvl3Quant attempted.",
    }

    with open(config_file, "w") as f:
        json.dump(cfg, f, indent=4)
    log("  [OK] Added razer node to training_standard.json")
else:
    log("  [SKIP] config/training_standard.json not found (code sync may have failed)")
    # Write a minimal razer config
    razer_cfg = {
        "_comment": "Razer node config — generated by setup_razer.py",
        "nodes": {
            "razer": {
                "host": "100.102.215.75",
                "tailscale_ip": "100.102.215.75",
                "ray_worker_user": "njlia",
                "gpu": "RTX 3070",
                "vram_gb": 8,
                "lvl3_root": "C:/Lvl3Quant",
                "lvl3_root_canonical": "C:/Users/claude/Lvl3Quant",
                "book_cache": "data/processed/dl_book_cache",
                "events_cache": "data/processed/mbo_events",
                "results_dir": "alpha_discovery/deep_models/results",
                "role": "next_gen_architecture_research",
                "note": "Ray worker runs as njlia. Working path is C:/Lvl3Quant.",
            }
        },
    }
    with open(RAZER_ROOT / "config" / "razer_node.json", "w") as f:
        json.dump(razer_cfg, f, indent=4)
    log("  [OK] Wrote config/razer_node.json")

# ── Phase 5: Install Python packages ───────────────────────────────────────
log("\n--- Phase 5: Install Python packages ---")

# Check what's already installed
rc, out, err = run("python3.11 -m pip list 2>&1", check=False, capture=True, timeout=30)
installed = out.lower()

packages_to_install = []
for pkg in REQUIRED_PACKAGES:
    pkg_name = pkg.split("[")[0].lower()
    if pkg_name not in installed:
        packages_to_install.append(pkg)
    else:
        log(f"  [OK] {pkg} already installed")

if packages_to_install:
    log(f"  Installing: {packages_to_install}")
    pkg_str = " ".join(f'"{p}"' for p in packages_to_install)
    rc, out, err = run(
        f"python3.11 -m pip install {pkg_str} --quiet 2>&1",
        check=False, capture=True, timeout=600
    )
    if rc == 0:
        log("  [OK] Packages installed")
    else:
        log(f"  [WARN] pip install rc={rc}: {err[:300]}")

# Verify torch + CUDA
log("  Verifying torch + CUDA...")
rc, out, err = run(
    'python3.11 -c "import torch; print(f\'torch={torch.__version__} cuda={torch.cuda.is_available()} gpu={torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}\')"',
    check=False, capture=True, timeout=30
)
if rc == 0:
    log(f"  [OK] {out.strip()}")
else:
    log(f"  [WARN] torch check failed: {err[:200]}")

# ── Phase 6: Data sync launcher ────────────────────────────────────────────
log("\n--- Phase 6: Launch background data sync from Neptune ---")
log("  MBO events: ~3.7 GB (65 files)")
log("  DL book cache: ~3.6 GB")
log("  Initiating async SCP transfers in background...")

# Write a data sync script that Razer can run independently
# Use RAZER_ROOT (C:\Lvl3Quant) for the sync script path — njlia can write here
DATA_SYNC_SCRIPT = RAZER_ROOT / "scripts" / "sync_data_from_neptune.py"
DATA_SYNC_SCRIPT.parent.mkdir(parents=True, exist_ok=True)

sync_script_content = f'''"""
sync_data_from_neptune.py — Pull large data files from Neptune to Razer
Run this script directly on Razer after SSH keys are configured.
Neptune: {NEPTUNE_SSH_USER}@{neptune_ip}
"""
import subprocess, os, sys, time
from pathlib import Path

NEPTUNE_USER = "{NEPTUNE_SSH_USER}"
NEPTUNE_IP = "{neptune_ip}"
NEPTUNE_ROOT = "{NEPTUNE_LVL3}"
LOCAL_ROOT = r"{str(RAZER_ROOT)}"

SSH_OPTS = "-o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=30"

DATA_TRANSFERS = [
    # (remote_path, local_path, description)
    (
        f"{{NEPTUNE_ROOT}}/data/processed/mbo_events",
        f"{{LOCAL_ROOT}}/data/processed/mbo_events",
        "MBO events (~3.7GB)"
    ),
    (
        f"{{NEPTUNE_ROOT}}/data/processed/dl_book_cache",
        f"{{LOCAL_ROOT}}/data/processed/dl_book_cache",
        "DL book cache (~3.6GB)"
    ),
    (
        f"{{NEPTUNE_ROOT}}/data/processed/dl_events_cache",
        f"{{LOCAL_ROOT}}/data/processed/dl_events_cache",
        "DL events cache"
    ),
    (
        f"{{NEPTUNE_ROOT}}/data/processed/mbo_features_cache",
        f"{{LOCAL_ROOT}}/data/processed/mbo_features_cache",
        "MBO features cache"
    ),
]

for remote, local, desc in DATA_TRANSFERS:
    os.makedirs(local, exist_ok=True)
    print(f"Syncing {{desc}}...")
    print(f"  From: {{NEPTUNE_USER}}@{{NEPTUNE_IP}}:{{remote}}")
    print(f"  To:   {{local}}")
    cmd = (
        f"scp {{SSH_OPTS}} -r "
        f"{{NEPTUNE_USER}}@{{NEPTUNE_IP}}:\\"{{remote}}\\" \\"{{local}}\\""
    )
    print(f"  CMD: {{cmd}}")
    rc = subprocess.call(cmd, shell=True)
    if rc == 0:
        files = list(Path(local).glob("*"))
        print(f"  OK — {{len(files)}} items in {{local}}")
    else:
        print(f"  FAILED rc={{rc}}")
    print()

print("Data sync complete.")
'''

with open(DATA_SYNC_SCRIPT, "w") as f:
    f.write(sync_script_content)
log(f"  [OK] Data sync script written: {DATA_SYNC_SCRIPT}")

# Try to kick off data sync in background if SSH works
if ssh_ok:
    log("  SSH is working — launching background data sync...")
    # Start SCP for mbo_events in background
    mbo_dst = str(RAZER_ROOT / "data/processed/mbo_events")
    mbo_src = f"{NEPTUNE_LVL3}/data/processed/mbo_events"
    bg_cmd = (
        f"scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -r "
        f"{NEPTUNE_SSH_USER}@{neptune_ip}:\"{mbo_src}\" \"{mbo_dst}\" "
        f"> \"{str(RAZER_ROOT / 'logs/sync_mbo_events.log')}\" 2>&1"
    )
    # Launch as detached background process
    subprocess.Popen(
        bg_cmd, shell=True,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        if sys.platform == "win32" else 0,
        close_fds=True,
    )
    log("  [LAUNCHED] mbo_events SCP in background — check logs/sync_mbo_events.log")

    # Start DL book cache sync
    book_dst = str(RAZER_ROOT / "data/processed/dl_book_cache")
    book_src = f"{NEPTUNE_LVL3}/data/processed/dl_book_cache"
    bg_cmd2 = (
        f"scp -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -r "
        f"{NEPTUNE_SSH_USER}@{neptune_ip}:\"{book_src}\" \"{book_dst}\" "
        f"> \"{str(RAZER_ROOT / 'logs/sync_dl_book_cache.log')}\" 2>&1"
    )
    subprocess.Popen(
        bg_cmd2, shell=True,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        if sys.platform == "win32" else 0,
        close_fds=True,
    )
    log("  [LAUNCHED] dl_book_cache SCP in background — check logs/sync_dl_book_cache.log")
else:
    log("  SSH not available — skipping background data sync.")
    log("  ACTION REQUIRED: Run scripts/sync_data_from_neptune.py on Razer manually after SSH setup.")

# ── Phase 7: Write status report ───────────────────────────────────────────
log("\n--- Phase 7: Status report ---")

status = {
    "timestamp": datetime.now().isoformat(),
    "hostname": hostname,
    "razer_root": str(RAZER_ROOT),
    "razer_root_exists": RAZER_ROOT.exists(),
    "neptune_ip_used": neptune_ip,
    "neptune_reachable": neptune_ip is not None,
    "ssh_ok": ssh_ok,
    "dirs_created": [str(RAZER_ROOT / d) for d in REQUIRED_DIRS],
    "data_sync_launched": ssh_ok,
    "data_sync_script": str(DATA_SYNC_SCRIPT),
    "next_steps": [],
}

if not ssh_ok:
    status["next_steps"].append("Set up SSH key auth from Razer to Neptune (user: Footb@100.109.245.73)")
    status["next_steps"].append(f"Run: python3.11 {DATA_SYNC_SCRIPT}")
    status["next_steps"].append("Or set up Windows file share: net share lvl3quant_share=C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant")

# Count what actually landed
code_files = list(RAZER_ROOT.rglob("*.py"))
status["python_files_on_razer"] = len(code_files)
mbo_files = list((RAZER_ROOT / "data/processed/mbo_events").glob("*.npz"))
status["mbo_event_files"] = len(mbo_files)

report_path = RAZER_ROOT / "setup_report.json"
with open(report_path, "w") as f:
    json.dump(status, f, indent=2)

log(f"\n{'='*60}")
log("SETUP COMPLETE")
log(f"{'='*60}")
log(f"Razer root:    {RAZER_ROOT}")
log(f"Python files:  {status['python_files_on_razer']}")
log(f"MBO files:     {status['mbo_event_files']} / 65 expected")
log(f"SSH to Neptune: {'OK' if ssh_ok else 'FAILED — manual intervention needed'}")
log(f"Data sync:      {'LAUNCHED in background' if ssh_ok else 'PENDING — run sync script manually'}")
log(f"Report:         {report_path}")
log(f"Log:            {LOG_FILE}")

if status["next_steps"]:
    log("\nNEXT STEPS:")
    for s in status["next_steps"]:
        log(f"  - {s}")

# Print the JSON so Ray job output captures it
print("\n=== STATUS JSON ===")
print(json.dumps(status, indent=2))
