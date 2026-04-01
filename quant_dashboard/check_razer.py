"""Check status on Razer after training launch."""
import paramiko
import warnings
import time

warnings.filterwarnings('ignore')

HOST = '100.102.215.75'
USER = 'claude'
PASS = 'Pb26116467'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=20)

# Check all running processes
stdin, stdout, stderr = ssh.exec_command('tasklist /fo csv 2>&1')
procs = stdout.read().decode()
print("=== PROCESSES (python/cmd) ===")
for line in procs.splitlines():
    ll = line.lower()
    if 'python' in ll or ('cmd.exe' in ll):
        print(line)

# Check if batch file exists
bat_check_cmd = r'type C:\Users\claude\Lvl3Quant\run_1min_small.bat'
stdin2, stdout2, _ = ssh.exec_command(bat_check_cmd)
print("\n=== BATCH FILE ===")
print(stdout2.read().decode()[:500])

# Check Lvl3Quant dir
dir_cmd = r'dir C:\Users\claude\Lvl3Quant\ 2>&1'
stdin3, stdout3, _ = ssh.exec_command(dir_cmd)
print("\n=== Lvl3Quant DIR ===")
print(stdout3.read().decode()[:1000])

# Check GPU
stdin4, stdout4, _ = ssh.exec_command(
    'nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu --format=csv,noheader'
)
print("\n=== GPU util/mem/temp ===")
print(stdout4.read().decode().strip())

# Try to read log if it exists
log_cmd = r'type C:\Users\claude\Lvl3Quant\logs\1min_cnn_small.log 2>&1'
stdin5, stdout5, _ = ssh.exec_command(log_cmd)
log = stdout5.read().decode()
print("\n=== LOG (last 60 lines) ===")
lines = log.splitlines()
for l in lines[-60:]:
    print(l)

ssh.close()
