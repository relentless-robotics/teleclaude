"""Launch 1-min CNN small WF on Razer - v2 with proper dir creation."""
import paramiko
import warnings
import time

warnings.filterwarnings('ignore')

HOST = '100.102.215.75'
USER = 'claude'
PASS = 'Pb26116467'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=30)

# First check what's in alpha_discovery on Razer
stdin, stdout, _ = ssh.exec_command(
    r'dir C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models\ 2>&1'
)
print("=== alpha_discovery/deep_models ===")
print(stdout.read().decode()[:2000])

# Check if logs dir exists, create it
stdin2, stdout2, _ = ssh.exec_command(
    r'mkdir C:\Users\claude\Lvl3Quant\logs 2>nul & echo LOGS_OK'
)
print("Logs dir:", stdout2.read().decode().strip())

# Write improved batch file with explicit mkdir
bat_lines = [
    "@echo off\r\n",
    "mkdir C:\\Users\\claude\\Lvl3Quant\\logs 2>nul\r\n",
    "cd /d C:\\Users\\claude\\Lvl3Quant\r\n",
    "echo Starting 1min CNN training... >> logs\\1min_cnn_small.log\r\n",
    "python alpha_discovery\\deep_models\\run_1min_cnn_small_wf.py >> logs\\1min_cnn_small.log 2>&1\r\n",
    "echo Exit code: %ERRORLEVEL% >> logs\\1min_cnn_small.log\r\n",
]
bat_content = "".join(bat_lines)
bat_remote = "C:/Users/claude/Lvl3Quant/run_1min_small.bat"

sftp = ssh.open_sftp()
with sftp.file(bat_remote, 'w') as f:
    f.write(bat_content)
sftp.close()
print("Updated batch file written")

# Kill any existing cmd.exe from previous attempt
stdin3, stdout3, _ = ssh.exec_command(
    'taskkill /F /PID 24256 2>nul & echo KILLED'
)
print("Kill old:", stdout3.read().decode().strip())

time.sleep(2)

# Launch via wmic again
wmic_cmd = (
    'wmic process call create '
    '"cmd.exe /c C:\\Users\\claude\\Lvl3Quant\\run_1min_small.bat"'
)
stdin4, stdout4, _ = ssh.exec_command(wmic_cmd)
out = stdout4.read().decode()
print("WMIC launch:", out[:300])

# Extract PID
import re
pid_match = re.search(r'ProcessId = (\d+)', out)
if pid_match:
    pid = pid_match.group(1)
    print(f"Launched PID: {pid}")

time.sleep(20)

# Check processes
stdin5, stdout5, _ = ssh.exec_command('tasklist /fo csv 2>&1')
procs = stdout5.read().decode()
print("\n=== PROCESSES (python/cmd) ===")
for line in procs.splitlines():
    ll = line.lower()
    if 'python' in ll or 'cmd.exe' in ll:
        print(line)

# Check log
stdin6, stdout6, _ = ssh.exec_command(
    r'type C:\Users\claude\Lvl3Quant\logs\1min_cnn_small.log 2>&1'
)
log = stdout6.read().decode()
print("\n=== LOG ===")
print(log[:3000] if log else "(empty)")

# Check GPU
stdin7, stdout7, _ = ssh.exec_command(
    'nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader'
)
print("\n=== GPU ===")
print(stdout7.read().decode().strip())

ssh.close()
