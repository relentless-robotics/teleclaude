#!/usr/bin/env python3
"""Check Razer status and launch jobs."""
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

# Check running processes
print("=== Razer Running Python processes ===")
r = razer_exec('tasklist /FI "IMAGENAME eq python.exe" /FO CSV', 15)
print(r.get("stdout", "")[:500] or "none")

# Check scripts
print("\n=== Razer scripts/  ===")
r2 = razer_exec(r'dir C:\Users\claude\Lvl3Quant\scripts\ /B 2>&1 | findstr .py', 15)
print(r2.get("stdout", "")[:1000])

print("\n=== Razer root .py ===")
r3 = razer_exec(r'dir C:\Users\claude\Lvl3Quant\ /B 2>&1 | findstr .py', 15)
print(r3.get("stdout", "")[:800])

# GPU status
print("\n=== Razer GPU ===")
r4 = razer_exec(r'nvidia-smi --query-gpu=utilization.gpu,power.draw,memory.used --format=csv,noheader 2>&1', 10)
print(r4.get("stdout", ""))
