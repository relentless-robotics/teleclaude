"""
check_razer_training.py
Check if event transformer training is running on Razer.
"""
import os
import subprocess
import sys
from pathlib import Path

LOG = Path("C:/Lvl3Quant/logs/event_transformer_train.log")
PID_FILE = Path("C:/Lvl3Quant/logs/event_transformer_pid.txt")
RESULTS = Path("C:/Lvl3Quant/alpha_discovery/deep_models/results/event_transformer_fast")

print("=== Razer Training Status Check ===", flush=True)

# PID check
if PID_FILE.exists():
    pid = PID_FILE.read_text().strip()
    print(f"Saved PID: {pid}", flush=True)
    result = subprocess.run(
        ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
        capture_output=True, text=True
    )
    alive = pid in result.stdout
    print(f"Process alive: {alive}", flush=True)
    if result.stdout.strip():
        print(f"Tasklist: {result.stdout.strip()[:300]}", flush=True)
else:
    print("PID file not found", flush=True)

# Training log
if LOG.exists():
    lines = LOG.read_text(encoding="utf-8", errors="replace").splitlines()
    print(f"\nTraining log: {len(lines)} lines", flush=True)
    print("--- LAST 40 LINES ---", flush=True)
    for line in lines[-40:]:
        print(line, flush=True)
else:
    print(f"\nTraining log not found: {LOG}", flush=True)

# Results directory
if RESULTS.exists():
    items = sorted(RESULTS.iterdir())
    print(f"\nResults dir ({len(items)} items):", flush=True)
    for item in items[:15]:
        size = item.stat().st_size if item.is_file() else 0
        print(f"  {item.name}  ({size // 1024} KB)" if item.is_file() else f"  {item.name}/", flush=True)
else:
    print(f"\nResults dir not found: {RESULTS}", flush=True)

# GPU utilization check via nvidia-smi
print("\n--- GPU status ---", flush=True)
result = subprocess.run(
    ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,power.draw",
     "--format=csv,noheader,nounits"],
    capture_output=True, text=True
)
if result.returncode == 0:
    print(f"GPU util, mem_used, mem_total, power: {result.stdout.strip()}", flush=True)
else:
    print(f"nvidia-smi failed: {result.stderr[:200]}", flush=True)

print("\n=== END CHECK ===", flush=True)
