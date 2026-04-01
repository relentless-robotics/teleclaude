#!/usr/bin/env python3
"""
Deploy all 5 experiment scripts to Jupiter and launch them as background jobs.
Also syncs z20 data from Neptune to Jupiter for queue position analysis.
"""
import warnings
warnings.filterwarnings('ignore')

import paramiko, json, os, sys, glob, time
from pathlib import Path

CONFIG_FILE = os.path.join(os.path.dirname(__file__), '..', 'config', 'remote_servers.json')
with open(CONFIG_FILE) as f:
    config = json.load(f)

JUPITER = config['servers']['jupiter']

def connect():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        JUPITER['host'], port=JUPITER.get('port', 22),
        username=JUPITER['user'], password=JUPITER['password'],
        timeout=30, allow_agent=False, look_for_keys=False
    )
    return client

def run(client, cmd, timeout=60):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err, exit_code

def upload_file(client, local_path, remote_path):
    sftp = client.open_sftp()
    try:
        sftp.put(local_path, remote_path)
        print(f"  Uploaded: {os.path.basename(local_path)} -> {remote_path}")
    finally:
        sftp.close()

def upload_data(client, local_path, remote_path):
    """Upload a file's content."""
    sftp = client.open_sftp()
    try:
        sftp.put(local_path, remote_path)
    finally:
        sftp.close()

print("Connecting to Jupiter...")
client = connect()
print("Connected!")

# 1. Create remote directories
dirs_to_create = [
    "/home/jupiter/Lvl3Quant/scripts",
    "/home/jupiter/Lvl3Quant/data/processed/conviction_threshold_sweep/z20",
    "/home/jupiter/Lvl3Quant/data/processed/c5_diagnosis",
    "/home/jupiter/Lvl3Quant/data/processed/multi_card_conviction_sweep",
    "/home/jupiter/Lvl3Quant/data/processed/hold_time_optimization",
    "/home/jupiter/Lvl3Quant/data/processed/time_of_day_analysis",
    "/home/jupiter/Lvl3Quant/data/processed/queue_position_analysis",
    "/home/jupiter/Lvl3Quant/logs",
]
print("\nCreating remote directories...")
for d in dirs_to_create:
    out, err, rc = run(client, f"mkdir -p {d}")
print("Directories created.")

# 2. Upload experiment scripts
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
scripts_to_upload = [
    "c5_diagnosis.py",
    "multi_card_conviction_sweep.py",
    "hold_time_optimization.py",
    "time_of_day_analysis.py",
    "queue_position_analysis.py",
]
print("\nUploading experiment scripts...")
for script in scripts_to_upload:
    local = os.path.join(SCRIPTS_DIR, script)
    remote = f"/home/jupiter/Lvl3Quant/scripts/{script}"
    if os.path.exists(local):
        upload_file(client, local, remote)
    else:
        print(f"  WARNING: {local} not found!")

# 3. Sync z20 data from Neptune to Jupiter (for queue position analysis)
# Neptune z20 dir is local: C:\Users\Footb\Documents\Github\Lvl3Quant\data\processed\conviction_threshold_sweep\z20\
print("\nUploading z20 conviction sweep data to Jupiter...")
z20_local_dir = r"C:\Users\Footb\Documents\Github\Lvl3Quant\data\processed\conviction_threshold_sweep\z20"
z20_files = sorted(glob.glob(os.path.join(z20_local_dir, "*.json")))
print(f"  Found {len(z20_files)} z20 files locally")

sftp = client.open_sftp()
uploaded = 0
for local_file in z20_files:
    fname = os.path.basename(local_file)
    remote_file = f"/home/jupiter/Lvl3Quant/data/processed/conviction_threshold_sweep/z20/{fname}"
    try:
        # Check if file already exists on Jupiter
        try:
            sftp.stat(remote_file)
            continue  # already exists
        except FileNotFoundError:
            pass
        sftp.put(local_file, remote_file)
        uploaded += 1
        if uploaded % 10 == 0:
            print(f"  Uploaded {uploaded}/{len(z20_files)} z20 files...")
    except Exception as e:
        print(f"  Error uploading {fname}: {e}")
sftp.close()
print(f"  Done! Uploaded {uploaded} new files ({len(z20_files)} total)")

# 4. Launch all experiments as background nohup jobs
print("\nLaunching experiments on Jupiter...")

PYTHON = "python3"
LOG_DIR = "/home/jupiter/Lvl3Quant/logs"
SCRIPTS_REMOTE = "/home/jupiter/Lvl3Quant/scripts"

experiments = [
    ("c5_diagnosis", "c5_diagnosis.py"),
    ("multi_card_conviction", "multi_card_conviction_sweep.py"),
    ("hold_time_opt", "hold_time_optimization.py"),
    ("time_of_day", "time_of_day_analysis.py"),
    ("queue_position", "queue_position_analysis.py"),
]

pids = {}
for (name, script) in experiments:
    log_file = f"{LOG_DIR}/{name}.log"
    cmd = f"nohup {PYTHON} {SCRIPTS_REMOTE}/{script} > {log_file} 2>&1 & echo $!"
    out, err, rc = run(client, cmd, timeout=10)
    pid = out.strip().split('\n')[-1] if out.strip() else "?"
    print(f"  [{name}] PID={pid} log={log_file}")
    pids[name] = {"pid": pid, "log": log_file, "script": script}

# 5. Verify processes are running
time.sleep(2)
print("\nVerifying processes...")
out, err, rc = run(client, "ps aux | grep 'python3.*\.py' | grep -v grep")
print(out if out else "(no python processes found)")

# Save deployment record
deploy_record = {
    "deployed_at": __import__('datetime').datetime.now().isoformat(),
    "jupiter_host": JUPITER['host'],
    "experiments": pids,
    "z20_files_synced": len(z20_files),
}
record_file = os.path.join(SCRIPTS_DIR, ".jupiter_deployment.json")
with open(record_file, "w") as f:
    json.dump(deploy_record, f, indent=2)

print(f"\n{'='*60}")
print("DEPLOYMENT COMPLETE")
print(f"{'='*60}")
for name, info in pids.items():
    print(f"  {name}: PID={info['pid']} log={info['log']}")
print(f"\nDeployment record saved to: {record_file}")
print(f"\nTo check progress:")
print(f"  python utils/ssh_exec.py --server jupiter 'tail -20 /home/jupiter/Lvl3Quant/logs/c5_diagnosis.log'")
print(f"  python utils/ssh_exec.py --server jupiter 'tail -20 /home/jupiter/Lvl3Quant/logs/multi_card_conviction.log'")
print(f"  python utils/ssh_exec.py --server jupiter 'ps aux | grep python3 | grep -v grep'")

client.close()
print("\nDONE")
