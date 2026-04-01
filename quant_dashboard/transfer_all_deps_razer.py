"""Transfer ALL missing dependency files to Razer and relaunch."""
import paramiko
import warnings
import time
import re

warnings.filterwarnings('ignore')

HOST = '100.102.215.75'
USER = 'claude'
PASS = 'Pb26116467'
LOCAL_BASE = r'C:\Users\Footb\Documents\Github\Lvl3Quant\alpha_discovery\deep_models'
REMOTE_BASE = r'C:/Users/claude/Lvl3Quant/alpha_discovery/deep_models'

# All local module files that train_walkforward.py might need
FILES_TO_TRANSFER = [
    'book_spatial_cnn.py',
    'trade_sequence_lstm.py',
    'event_transformer.py',
    '__init__.py',
]

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=30)

sftp = ssh.open_sftp()
for fname in FILES_TO_TRANSFER:
    local = LOCAL_BASE + '\\' + fname
    remote = REMOTE_BASE + '/' + fname
    try:
        sftp.put(local, remote)
        print(f"  Transferred: {fname}")
    except Exception as e:
        print(f"  FAILED {fname}: {e}")
sftp.close()

# Clear old log
stdin, stdout, _ = ssh.exec_command(
    r'del C:\Users\claude\Lvl3Quant\logs\1min_cnn_small.log 2>nul & echo CLEARED'
)
print("Log cleared:", stdout.read().decode().strip())

# Kill existing processes
stdin2, stdout2, _ = ssh.exec_command(
    'taskkill /F /IM python.exe 2>nul & taskkill /F /IM cmd.exe /FI "STATUS eq RUNNING" 2>nul & echo KILLED'
)
time.sleep(2)

# Launch fresh
wmic_cmd = (
    'wmic process call create '
    '"cmd.exe /c C:\\Users\\claude\\Lvl3Quant\\run_1min_small.bat"'
)
stdin3, stdout3, _ = ssh.exec_command(wmic_cmd)
out = stdout3.read().decode()
print("WMIC launch:", out[:200])
pid_match = re.search(r'ProcessId = (\d+)', out)
if pid_match:
    print(f"Launched PID: {pid_match.group(1)}")

print("Waiting 30 seconds for Python startup + imports...")
time.sleep(30)

# Check log
stdin4, stdout4, _ = ssh.exec_command(
    r'type C:\Users\claude\Lvl3Quant\logs\1min_cnn_small.log 2>&1'
)
log = stdout4.read().decode()
print("\n=== LOG (first 4000 chars) ===")
print(log[:4000] if log else "(empty)")

# Check processes
stdin5, stdout5, _ = ssh.exec_command('tasklist /fo csv 2>&1')
procs = stdout5.read().decode()
print("\n=== PROCESSES ===")
for line in procs.splitlines():
    ll = line.lower()
    if 'python' in ll or 'cmd.exe' in ll:
        print(line)

# Check GPU
stdin6, stdout6, _ = ssh.exec_command(
    'nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu --format=csv,noheader'
)
print("\n=== GPU ===")
print(stdout6.read().decode().strip())

ssh.close()
