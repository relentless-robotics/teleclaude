"""Transfer WF data to Razer and launch CNN z-score LGBM experiment."""
import paramiko
import os
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=10)
print("Connected to Razer")

# Create target dir
ssh.exec_command('cmd /c mkdir C:\\Users\\claude\\Lvl3Quant\\alpha_discovery\\deep_models\\results\\wider_cnn')
time.sleep(2)

# Transfer WF predictions
sftp = ssh.open_sftp()
local = r'C:\Users\Footb\Documents\Github\Lvl3Quant\alpha_discovery\deep_models\results\wider_cnn\ckpt_preds_book_20260326_191614.npz'
remote = 'C:/Users/claude/Lvl3Quant/alpha_discovery/deep_models/results/wider_cnn/ckpt_preds_book_20260326_191614.npz'
print(f"Transferring {os.path.getsize(local)/1e6:.1f}MB...")
sftp.put(local, remote)
print("Transfer complete!")
sftp.close()

# Launch experiment via schtasks (most reliable on Windows)
schtask_cmd = (
    'schtasks /create /tn "cnn_lgbm_exp" '
    '/tr "C:\\Python311\\python.exe -X utf8 C:\\Users\\claude\\Lvl3Quant\\scripts\\cnn_zscore_lgbm_features.py" '
    '/sc once /st 00:00 /f /ru claude /rp Pb26116467'
)
stdin, stdout, stderr = ssh.exec_command(schtask_cmd)
print(f"Create task: {stdout.read().decode().strip()}")

stdin, stdout, stderr = ssh.exec_command('schtasks /run /tn "cnn_lgbm_exp"')
print(f"Run task: {stdout.read().decode().strip()}")

time.sleep(5)

# Verify
stdin, stdout, stderr = ssh.exec_command('powershell -Command "Get-Process python* | Select-Object Id,CPU"')
print(f"Python processes: {stdout.read().decode().strip()}")

ssh.close()
print("Done")
