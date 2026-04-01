"""Launch CNN z-score LGBM experiment on Razer with correct paths."""
import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=10)
print("Connected to Razer")

# First test that the data file was transferred correctly
stdin, stdout, stderr = ssh.exec_command(
    r'C:\Python311\python.exe -c "'
    r'import numpy as np; '
    r"d=np.load(r'C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models\results\wider_cnn\ckpt_preds_book_20260326_191614.npz'); "
    r"print(f'Keys: {len(d.keys())}, first: {list(d.keys())[:2]}'); "
    r"d.close(); print('DATA OK')"
    r'"'
)
print(f"Data check: {stdout.read().decode().strip()}")

# Create logs dir
ssh.exec_command(r'cmd /c mkdir C:\Users\claude\Lvl3Quant\logs 2>nul')
time.sleep(1)

# Launch via wmic with full path and log redirect
# The script expects OOT_CNN_DIR - let's check what path it uses
stdin, stdout, stderr = ssh.exec_command(
    r'C:\Python311\python.exe -c "'
    r'with open(r\"C:\Users\claude\Lvl3Quant\scripts\cnn_zscore_lgbm_features.py\") as f: '
    r'    lines = f.readlines(); '
    r'[print(l.strip()) for l in lines if \"OOT_CNN_DIR\" in l or \"oot\" in l.lower()]'
    r'"'
)
print(f"Script OOT paths: {stdout.read().decode().strip()}")

# Launch the script directly
launch = (
    r'wmic process call create '
    r'"C:\Python311\python.exe -X utf8 C:\Users\claude\Lvl3Quant\scripts\cnn_zscore_lgbm_features.py"'
    r',"C:\Users\claude\Lvl3Quant"'
)
stdin, stdout, stderr = ssh.exec_command(launch)
out = stdout.read().decode().strip()
print(f"Launch: {out[:300]}")

time.sleep(10)

# Check if running
stdin, stdout, stderr = ssh.exec_command(
    r'powershell -Command "Get-Process python* | Select-Object Id,CPU,WorkingSet64 | Format-Table"'
)
print(f"Processes after launch:\n{stdout.read().decode().strip()}")

ssh.close()
print("Done")
