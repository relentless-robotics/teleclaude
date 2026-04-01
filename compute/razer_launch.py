#!/usr/bin/env python3
"""Launch research jobs on Razer via node API."""
import urllib.request
import json
import time

RAZER_API = "http://100.102.215.75:8765"
API_KEY = "qcc_node_api_2026"
RAZER_LVL3 = r"C:\Users\claude\Lvl3Quant"
PYTHON_BIN = r"C:\Python311\python.exe"

def razer_exec(cmd, timeout=20):
    url = f"{RAZER_API}/exec"
    payload = {"command": cmd, "timeout": timeout}
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-API-Key": API_KEY},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout+5) as r:
        return json.loads(r.read())

def launch_razer_job(name, script_path):
    """Launch a background job on Razer via cmd /c start."""
    log_path = f"{RAZER_LVL3}\\logs\\{name}.log"
    # Use start /B for background execution on Windows
    cmd = f'start /B cmd /c "{PYTHON_BIN} {RAZER_LVL3}\\{script_path} > {log_path} 2>&1"'
    r = razer_exec(cmd, 15)
    return r.get("exitCode", "?"), r.get("stdout", ""), r.get("stderr", "")

# Ensure logs directory exists
razer_exec(f'if not exist {RAZER_LVL3}\\logs mkdir {RAZER_LVL3}\\logs', 10)

# Jobs to launch (Razer CPU/math research - NO deep learning)
jobs = [
    # Feature importance analysis (already running razer_q2_001/002 - check first)
    ("lgbm_feature_importance", r"scripts\feature_ablation_razer.py"),
    ("regime_classifier_lgbm",  r"scripts\regime_classifier_lgbm.py"),
    ("queue_dynamics_lgbm",     r"scripts\queue_dynamics_lgbm.py"),
    ("mfe_mae_lgbm",            r"scripts\lgbm_mfe_mae.py"),
    ("l1_imb_cnn_combo_ic",     r"scripts\l1_imb_cnn_combo_ic.py"),
    ("comprehensive_features",  r"scripts\comprehensive_feature_engineering.py"),
    ("confluence_strategy",     r"scripts\confluence_strategy.py"),
]

print("Launching Razer jobs:")
for name, script in jobs:
    ec, out, err = launch_razer_job(name, script)
    print(f"  {name}: exitCode={ec}")
    if err:
        print(f"    stderr: {err[:100]}")

# Verify processes started
import time
time.sleep(5)
print("\nVerifying Razer processes:")
r = razer_exec('tasklist /FI "IMAGENAME eq python.exe" /FO CSV', 10)
lines = r.get("stdout","").strip().split("\n")
print(f"  Python processes running: {len(lines)-1}")  # -1 for header
