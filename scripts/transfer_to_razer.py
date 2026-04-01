#!/usr/bin/env python3
"""
Transfer scripts to Razer and launch experiments sequentially.
"""
import sys
import os
import time
import warnings
warnings.filterwarnings('ignore')

import paramiko

RAZER_HOST = '100.102.215.75'
RAZER_PORT = 22
RAZER_USER = 'claude'
RAZER_PASS = 'Pb26116467'

LOCAL_SCRIPTS_DIR = r'C:\Users\Footb\Documents\Github\teleclaude-main\scripts'
RAZER_SCRIPTS_DIR = r'C:\Users\claude\Lvl3Quant\scripts'
RAZER_HOME = r'C:\Users\claude'

def get_client():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(RAZER_HOST, port=RAZER_PORT, username=RAZER_USER, password=RAZER_PASS,
                   timeout=30, banner_timeout=60, auth_timeout=30)
    return client

def transfer_file(sftp, local_path, remote_path):
    print(f"  Transfer: {os.path.basename(local_path)} -> {remote_path}")
    sftp.put(local_path, remote_path)
    print(f"  OK")

def run_cmd(client, cmd, timeout=30):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

def launch_vbs(client, script_path, log_path, vbs_name):
    """Launch python script via VBS in background (Session 0 Services)."""
    vbs_content = f"""Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "python -X utf8 {script_path} > {log_path} 2>&1", 0, False
"""
    vbs_path = f'{RAZER_HOME}\\{vbs_name}'
    # Write VBS via SFTP
    sftp = client.open_sftp()
    with sftp.file(vbs_path, 'w') as f:
        f.write(vbs_content)
    sftp.close()

    # Launch via wscript
    cmd = f'wscript "{vbs_path}"'
    out, err = run_cmd(client, cmd, timeout=15)
    print(f"  VBS launch: out={out!r} err={err!r}")
    time.sleep(2)

    # Verify launch
    out2, _ = run_cmd(client, 'tasklist /FI "IMAGENAME eq python.exe" /FO CSV', timeout=10)
    print(f"  Python procs: {out2[:300]}")
    return vbs_path


def main():
    print("=== Transfer and Launch Scripts to Razer ===")

    # Files to transfer
    transfers = [
        (
            os.path.join(LOCAL_SCRIPTS_DIR, 'l1_imb_cnn_combo_ic.py'),
            f'{RAZER_SCRIPTS_DIR}\\l1_imb_cnn_combo_ic.py',
        ),
        (
            os.path.join(LOCAL_SCRIPTS_DIR, 'lgbm_reduced_features.py'),
            f'{RAZER_SCRIPTS_DIR}\\lgbm_reduced_features.py',
        ),
        (
            os.path.join(LOCAL_SCRIPTS_DIR, 'qf_iceberg_chase_fillsim.py'),
            f'{RAZER_SCRIPTS_DIR}\\qf_iceberg_chase_fillsim_fixed.py',
        ),
    ]

    print("\n1. Connecting to Razer...")
    client = get_client()
    print("   Connected OK")

    print("\n2. Transferring scripts...")
    sftp = client.open_sftp()
    for local_p, remote_p in transfers:
        if not os.path.exists(local_p):
            print(f"  SKIP (not found): {local_p}")
            continue
        transfer_file(sftp, local_p, remote_p)
    sftp.close()

    print("\n3. Verifying no Python running on Razer...")
    out, _ = run_cmd(client, 'tasklist /FI "IMAGENAME eq python.exe"')
    print(f"   {out[:200]}")

    print("\n4. Launching experiments...")

    # Launch sequence VBS: l1_imb first (fast ~20 min), then lgbm_reduced (slow ~2-3h),
    # then qf_iceberg subset (fast)
    # Use a Python launcher script that runs them sequentially

    launcher_content = r"""#!/usr/bin/env python3
"""
    launcher_content += '''
"""Sequential launcher for Razer experiments."""
import subprocess, sys, time, os

SCRIPTS_DIR = r'C:\\Users\\claude\\Lvl3Quant\\scripts'
LOG_DIR = r'C:\\Users\\claude'

experiments = [
    {
        'name': 'L1 Imbalance IC Study',
        'script': SCRIPTS_DIR + r'\\l1_imb_cnn_combo_ic.py',
        'log': LOG_DIR + r'\\l1_imb_combo_ic.log',
        'args': [],
    },
    {
        'name': 'LGBM Reduced Features',
        'script': SCRIPTS_DIR + r'\\lgbm_reduced_features.py',
        'log': LOG_DIR + r'\\lgbm_reduced_features.log',
        'args': [],
    },
    {
        'name': 'QF Iceberg Chase FIXED Subset',
        'script': SCRIPTS_DIR + r'\\qf_iceberg_chase_fillsim_fixed.py',
        'log': LOG_DIR + r'\\qf_iceberg_chase_fixed_subset.log',
        'args': ['--max-days', '50', '--top-n', '20',
                 '--output', r'C:\\Users\\claude\\qf_chase_fixed_subset_results.json'],
    },
]

for exp in experiments:
    name = exp['name']
    script = exp['script']
    log_path = exp['log']
    args = exp['args']

    print(f"[LAUNCHER] Starting: {name}", flush=True)
    print(f"  Script: {script}", flush=True)
    print(f"  Log:    {log_path}", flush=True)

    if not os.path.exists(script):
        print(f"  SKIP: script not found", flush=True)
        continue

    t0 = time.time()
    cmd = [sys.executable, '-X', 'utf8', script] + args

    with open(log_path, 'w', buffering=1) as lf:
        proc = subprocess.run(cmd, stdout=lf, stderr=lf, text=True, encoding='utf-8', errors='replace')

    elapsed = time.time() - t0
    rc = proc.returncode
    print(f"  Done: returncode={rc}, elapsed={elapsed:.1f}s", flush=True)

    # Read last 5 lines of log
    try:
        with open(log_path, 'r', encoding='utf-8', errors='replace') as lf:
            lines = lf.readlines()
        last = lines[-5:] if len(lines) >= 5 else lines
        print(f"  Last log lines:", flush=True)
        for line in last:
            print(f"    {line.rstrip()}", flush=True)
    except Exception as e:
        print(f"  Could not read log: {e}", flush=True)

    print(f"[LAUNCHER] Completed: {name} (rc={rc})", flush=True)
    print("---", flush=True)

print("[LAUNCHER] All experiments done!", flush=True)
'''

    launcher_path = f'{RAZER_HOME}\\razer_experiment_launcher.py'
    launcher_log = f'{RAZER_HOME}\\razer_experiment_launcher.log'

    sftp = client.open_sftp()
    with sftp.file(launcher_path, 'w') as f:
        f.write(launcher_content)
    sftp.close()
    print(f"   Launcher written to {launcher_path}")

    # Launch via VBS
    vbs_path = launch_vbs(
        client,
        launcher_path,
        launcher_log,
        'launch_experiments.vbs',
    )

    print(f"\n5. Waiting 5 seconds and checking status...")
    time.sleep(5)
    out, _ = run_cmd(client, 'tasklist /FI "IMAGENAME eq python.exe" /FO CSV')
    print(f"   Python procs: {out[:400]}")

    print("\n=== LAUNCH COMPLETE ===")
    print(f"Launcher log: {launcher_log}")
    print("Experiments queued:")
    print("  1. L1 Imbalance IC Study (~20-30 min)")
    print("  2. LGBM Reduced Features (~2-3 hrs)")
    print("  3. QF Iceberg Chase FIXED Subset (50 days, ~30-60 min)")

    client.close()


if __name__ == '__main__':
    main()
