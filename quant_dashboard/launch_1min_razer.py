"""Launch 1-min CNN small WF on Razer via SSH."""
import paramiko
import warnings
import datetime
import io
import time

warnings.filterwarnings('ignore')

HOST = '100.102.215.75'
USER = 'claude'
PASS = 'Pb26116467'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=30)

# Write the batch file via SFTP
bat_lines = [
    "@echo off\r\n",
    "cd /d C:\\Users\\claude\\Lvl3Quant\r\n",
    "python alpha_discovery\\deep_models\\run_1min_cnn_small_wf.py > logs\\1min_cnn_small.log 2>&1\r\n",
]
bat_content = "".join(bat_lines)
bat_remote = "C:/Users/claude/Lvl3Quant/run_1min_small.bat"

sftp = ssh.open_sftp()
with sftp.file(bat_remote, 'w') as f:
    f.write(bat_content)
sftp.close()
print("Batch file written to Razer:", bat_remote)

# Try wmic to launch detached process
wmic_cmd = (
    'wmic process call create '
    '"cmd.exe /c C:\\Users\\claude\\Lvl3Quant\\run_1min_small.bat"'
)
stdin, stdout, stderr = ssh.exec_command(wmic_cmd)
out = stdout.read().decode().strip()
err = stderr.read().decode().strip()
print("WMIC output:", out[:500])
if err:
    print("WMIC err:", err[:200])

# Wait and check
time.sleep(15)

stdin2, stdout2, stderr2 = ssh.exec_command(
    'tasklist /fi "imagename eq python.exe" /fo csv'
)
procs = stdout2.read().decode().strip()
print("Python processes after 15s:", procs)

# Check if log was created
stdin3, stdout3, stderr3 = ssh.exec_command(
    'dir C:\\Users\\claude\\Lvl3Quant\\logs\\ 2>&1'
)
dirs = stdout3.read().decode().strip()
print("Logs dir:", dirs)

ssh.close()
