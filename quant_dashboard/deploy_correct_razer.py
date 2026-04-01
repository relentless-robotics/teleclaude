"""Deploy 1-min CNN to the CORRECT path on Razer and launch."""
import paramiko
import warnings
import time
import re

warnings.filterwarnings('ignore')

HOST = '100.102.215.75'
USER = 'claude'
PASS = 'Pb26116467'

# Correct paths
LOCAL_BASE = r'C:\Users\Footb\Documents\Github\Lvl3Quant\alpha_discovery\deep_models'
REMOTE_BASE = r'C:/Users/claude/Documents/Lvl3Quant/alpha_discovery/deep_models'
REMOTE_PROJ = r'C:\Users\claude\Documents\Lvl3Quant'
PYTHON_EXE = r'C:\Python311\python.exe'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=30)

# Verify the Documents/Lvl3Quant structure
stdin, stdout, _ = ssh.exec_command(
    r'dir C:\Users\claude\Documents\Lvl3Quant\alpha_discovery\deep_models\ /b 2>&1'
)
print("=== Documents/Lvl3Quant/deep_models ===")
print(stdout.read().decode()[:1000])

# Check data dir
stdin2, stdout2, _ = ssh.exec_command(
    r'dir C:\Users\claude\Documents\Lvl3Quant\data\processed\ /b 2>&1'
)
print("\n=== data/processed ===")
print(stdout2.read().decode()[:500])

# Transfer the launcher script to the CORRECT path
sftp = ssh.open_sftp()
files_to_transfer = [
    'run_1min_cnn_small_wf.py',
    'book_spatial_cnn.py',
    'trade_sequence_lstm.py',
    'event_transformer.py',
]
for fname in files_to_transfer:
    local = LOCAL_BASE + '\\' + fname
    remote = REMOTE_BASE + '/' + fname
    try:
        sftp.put(local, remote)
        print(f"  Transferred: {fname}")
    except Exception as e:
        print(f"  FAILED {fname}: {e}")
sftp.close()

# Create logs dir under Documents project
stdin3, stdout3, _ = ssh.exec_command(
    r'mkdir C:\Users\claude\Documents\Lvl3Quant\logs 2>nul & echo LOGS_OK'
)
print("Logs dir:", stdout3.read().decode().strip())

# Create output dir
stdin4, stdout4, _ = ssh.exec_command(
    r'mkdir C:\Users\claude\Documents\Lvl3Quant\alpha_discovery\deep_models\results\cnn_wf_1min_small 2>nul & echo OUT_OK'
)
print("Output dir:", stdout4.read().decode().strip())

# Write the correct batch file
bat_lines = [
    "@echo off\r\n",
    "mkdir C:\\Users\\claude\\Documents\\Lvl3Quant\\logs 2>nul\r\n",
    "cd /d C:\\Users\\claude\\Documents\\Lvl3Quant\r\n",
    "echo Starting 1min CNN small training... >> logs\\1min_cnn_small.log\r\n",
    "C:\\Python311\\python.exe alpha_discovery\\deep_models\\run_1min_cnn_small_wf.py >> logs\\1min_cnn_small.log 2>&1\r\n",
    "echo Exit code: %ERRORLEVEL% >> logs\\1min_cnn_small.log\r\n",
]
bat_content = "".join(bat_lines)
bat_remote = "C:/Users/claude/Documents/Lvl3Quant/run_1min_small.bat"

sftp2 = ssh.open_sftp()
with sftp2.file(bat_remote, 'w') as f:
    f.write(bat_content)
sftp2.close()
print("Batch file written to correct location")

# Kill any existing attempts
stdin5, stdout5, _ = ssh.exec_command(
    'taskkill /F /IM python.exe 2>nul & echo OK'
)
time.sleep(2)

# Launch via wmic
wmic_cmd = (
    'wmic process call create '
    '"cmd.exe /c C:\\Users\\claude\\Documents\\Lvl3Quant\\run_1min_small.bat"'
)
stdin6, stdout6, _ = ssh.exec_command(wmic_cmd)
out = stdout6.read().decode()
print("WMIC launch:", out[:200])
pid_match = re.search(r'ProcessId = (\d+)', out)
if pid_match:
    pid = pid_match.group(1)
    print(f"Launched PID: {pid}")

print("Waiting 35 seconds for startup...")
time.sleep(35)

# Check log
log_cmd = r'type C:\Users\claude\Documents\Lvl3Quant\logs\1min_cnn_small.log 2>&1'
stdin7, stdout7, _ = ssh.exec_command(log_cmd)
log = stdout7.read().decode()
print("\n=== LOG ===")
print(log[:5000] if log else "(empty)")

# Check processes
stdin8, stdout8, _ = ssh.exec_command('tasklist /fo csv 2>&1')
procs = stdout8.read().decode()
print("\n=== PYTHON PROCESSES ===")
for line in procs.splitlines():
    if 'python' in line.lower():
        print(line)

# Check GPU
stdin9, stdout9, _ = ssh.exec_command(
    'nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu --format=csv,noheader'
)
print("\n=== GPU ===")
print(stdout9.read().decode().strip())

ssh.close()
