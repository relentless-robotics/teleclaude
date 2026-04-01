"""Upload a split script to Razer, run it, then launch experiment."""
import paramiko
import time
import os

SPLIT_SCRIPT = '''
import numpy as np
from pathlib import Path

src = Path(r'C:\\Users\\claude\\Lvl3Quant\\alpha_discovery\\deep_models\\results\\wider_cnn\\ckpt_preds_book_20260326_191614.npz')
out_dir = src.parent
data = np.load(str(src), allow_pickle=True)
pred_keys = sorted([k for k in data.keys() if k.endswith('_preds')])
count = 0
for pk in pred_keys:
    date_str = pk.replace('_preds', '').replace('-', '')
    tk = pk.replace('_preds', '_targets')
    preds = data[pk]
    targets = data[tk]
    out_file = out_dir / f'oot_{date_str}.npz'
    np.savez_compressed(str(out_file), predictions=preds, labels=targets, bar_indices=np.arange(len(preds)))
    count += 1
    print(f'Created {out_file.name}: {len(preds)} bars')
data.close()
print(f'DONE: {count} oot files created')
'''

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=10)
print("Connected")

# Upload split script
sftp = ssh.open_sftp()
remote_script = 'C:/Users/claude/Lvl3Quant/scripts/split_ckpt_to_oot.py'
with sftp.open(remote_script, 'w') as f:
    f.write(SPLIT_SCRIPT)
print("Split script uploaded")
sftp.close()

# Run split script
print("Running split script...")
stdin, stdout, stderr = ssh.exec_command(
    r'C:\Python311\python.exe C:\Users\claude\Lvl3Quant\scripts\split_ckpt_to_oot.py'
)
out = stdout.read().decode()
err = stderr.read().decode()
print(out)
if err:
    print(f"STDERR: {err[:500]}")

# Now launch the LGBM experiment
print("\nLaunching CNN z-score LGBM experiment...")
stdin, stdout, stderr = ssh.exec_command(
    r'wmic process call create "C:\Python311\python.exe -X utf8 C:\Users\claude\Lvl3Quant\scripts\cnn_zscore_lgbm_features.py","C:\Users\claude\Lvl3Quant"'
)
out = stdout.read().decode()
if 'ProcessId' in out:
    pid = out.split('ProcessId = ')[1].split(';')[0].strip()
    print(f"Launched with PID: {pid}")
else:
    print(f"Launch output: {out[:300]}")

time.sleep(15)

# Verify running
stdin, stdout, stderr = ssh.exec_command(
    r'powershell -Command "Get-Process python* | Select-Object Id,CPU,WorkingSet64 | Format-Table"'
)
print(f"\nProcesses:\n{stdout.read().decode().strip()}")

ssh.close()
print("\nDone")
