#!/usr/bin/env python3
"""Deploy and launch card analysis scripts on Jupiter via SSH."""
import sys
import os
sys.stdout.reconfigure(encoding='utf-8')
os.environ['PYTHONIOENCODING'] = 'utf-8'

import paramiko
import time

JUPITER_HOST = "192.168.0.108"
JUPITER_USER = "jupiter"
JUPITER_PASS = "Pb26116467"

SCRIPTS = [
    ("scripts/full_card_optimization.py", "/home/jupiter/Lvl3Quant/scripts/full_card_optimization.py"),
    ("scripts/targeted_card_optimizations.py", "/home/jupiter/Lvl3Quant/scripts/targeted_card_optimizations.py"),
]

LOCAL_BASE = r"C:\Users\Footb\Documents\Github\teleclaude-main"


def main():
    print("Connecting to Jupiter...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(JUPITER_HOST, username=JUPITER_USER, password=JUPITER_PASS, timeout=15)
    print("Connected!")

    sftp = ssh.open_sftp()

    # Ensure scripts directory exists
    stdin, stdout, stderr = ssh.exec_command("mkdir -p /home/jupiter/Lvl3Quant/scripts")
    stdout.read()

    # Upload scripts
    for local_rel, remote_path in SCRIPTS:
        local_path = os.path.join(LOCAL_BASE, local_rel)
        print(f"Uploading {local_rel} -> {remote_path}")
        sftp.put(local_path, remote_path)
        sftp.chmod(remote_path, 0o755)
        print(f"  Uploaded OK")

    sftp.close()

    # Create output directory
    stdin, stdout, stderr = ssh.exec_command("mkdir -p /home/jupiter/Lvl3Quant/data/processed/card_deep_analysis")
    stdout.read()

    # Check if fill_sim exists
    stdin, stdout, stderr = ssh.exec_command("ls -la /home/jupiter/Lvl3Quant/rust_cache_builder/target/release/fill_sim_cli")
    out = stdout.read().decode()
    print(f"fill_sim_cli: {out.strip()}")

    # Check MBO data count
    stdin, stdout, stderr = ssh.exec_command("ls /home/jupiter/Lvl3Quant/data/raw/mbo/glbx-mdp3-*.mbo.dbn.zst 2>/dev/null | wc -l")
    out = stdout.read().decode().strip()
    print(f"MBO files found: {out}")

    # Check prediction files count
    stdin, stdout, stderr = ssh.exec_command("ls /home/jupiter/Lvl3Quant/data/processed/cnn_wf_stacked_predictions/*.npz 2>/dev/null | wc -l")
    out = stdout.read().decode().strip()
    print(f"Prediction files found: {out}")

    # Check what's already running
    stdin, stdout, stderr = ssh.exec_command("ps aux | grep -E 'full_card|targeted_card' | grep -v grep")
    out = stdout.read().decode().strip()
    if out:
        print(f"\nWARNING: Analysis scripts already running:\n{out}")
        print("Not launching again. Kill existing processes first if you want to restart.")
        ssh.close()
        return

    # Check CPU load
    stdin, stdout, stderr = ssh.exec_command("uptime")
    out = stdout.read().decode().strip()
    print(f"Jupiter load: {out}")

    # Launch the deep analysis script
    print(f"\nLaunching full_card_optimization.py with 14 workers...")
    launch_cmd = (
        "cd /home/jupiter/Lvl3Quant && "
        "nohup python3 scripts/full_card_optimization.py "
        "> data/processed/card_deep_analysis/analysis.log 2>&1 &"
    )
    stdin, stdout, stderr = ssh.exec_command(launch_cmd)
    time.sleep(2)

    # Verify it started
    stdin, stdout, stderr = ssh.exec_command("ps aux | grep full_card_optimization | grep -v grep")
    out = stdout.read().decode().strip()
    if out:
        print(f"LAUNCHED SUCCESSFULLY!")
        print(f"  Process: {out}")
        print(f"\nMonitor with:")
        print(f"  ssh jupiter@{JUPITER_HOST} 'tail -f /home/jupiter/Lvl3Quant/data/processed/card_deep_analysis/analysis.log'")
    else:
        print("WARNING: Process may not have started. Check manually.")
        # Check for immediate errors
        stdin, stdout, stderr = ssh.exec_command("cat /home/jupiter/Lvl3Quant/data/processed/card_deep_analysis/analysis.log 2>/dev/null | head -20")
        out = stdout.read().decode().strip()
        if out:
            print(f"Log output:\n{out}")

    ssh.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
