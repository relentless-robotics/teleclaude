"""
Fix Razer: The cnn_zscore_lgbm_features.py script expects oot_*.npz files
but we transferred ckpt_preds_book_*.npz.
Extract per-date oot_ files from the combined predictions file.
"""
import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=10)
print("Connected")

# Run a Python script on Razer to split the combined npz into per-date oot_ files
split_script = r"""
import numpy as np
from pathlib import Path
import os

src = Path(r'C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models\results\wider_cnn\ckpt_preds_book_20260326_191614.npz')
out_dir = src.parent
data = np.load(str(src), allow_pickle=True)
pred_keys = sorted([k for k in data.keys() if k.endswith('_preds')])
count = 0
for pk in pred_keys:
    date_str = pk.replace('_preds', '').replace('-', '')  # 2025-09-10 -> 20250910
    tk = pk.replace('_preds', '_targets')
    preds = data[pk]
    targets = data[tk]
    out_file = out_dir / f'oot_{date_str}.npz'
    np.savez_compressed(str(out_file), predictions=preds, labels=targets, bar_indices=np.arange(len(preds)))
    count += 1
    print(f'  Created {out_file.name}: {len(preds)} bars')
data.close()
print(f'Done: {count} oot files created')
"""

cmd = f'C:\\Python311\\python.exe -c "{split_script}"'
stdin, stdout, stderr = ssh.exec_command(cmd)
print(stdout.read().decode())
err = stderr.read().decode()
if err:
    print(f"ERR: {err[:500]}")

# Now relaunch the experiment
time.sleep(2)
launch = (
    r'wmic process call create '
    r'"C:\Python311\python.exe -X utf8 C:\Users\claude\Lvl3Quant\scripts\cnn_zscore_lgbm_features.py"'
    r',"C:\Users\claude\Lvl3Quant"'
)
stdin, stdout, stderr = ssh.exec_command(launch)
out = stdout.read().decode()
print(f"Launch: {out[:200]}")

time.sleep(10)

# Verify
stdin, stdout, stderr = ssh.exec_command(
    r'powershell -Command "Get-Process python* | Select-Object Id,CPU,WorkingSet64 | Format-Table"'
)
print(f"Processes:\n{stdout.read().decode().strip()}")

ssh.close()
print("Done")
