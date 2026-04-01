#!/usr/bin/env python3
"""
Launch all 4 experiments on Razer sequentially.
Uses the proven VBS + wscript method with C:\Python311\python.exe.

Since VBS launches background processes, we use a sequential Python launcher
that calls each script in order and waits for completion.
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
PYTHON_EXE = r'C:\Python311\python.exe'
SCRIPTS_DIR = r'C:\Users\claude\Lvl3Quant\scripts'
HOME = r'C:\Users\claude'

def get_client():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(RAZER_HOST, port=RAZER_PORT, username=RAZER_USER, password=RAZER_PASS,
                   timeout=30, banner_timeout=60, auth_timeout=30)
    return client

def run_cmd(client, cmd, timeout=30):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

def upload_file(sftp, content_str, remote_path):
    with sftp.file(remote_path, 'w') as f:
        f.write(content_str)

def create_vbs(python_exe, script_path, log_path, extra_args=''):
    """Create VBS content that launches python script in background."""
    cmd = f'cmd /c {python_exe} -u {script_path} {extra_args} >> {log_path} 2>&1'
    return f'Set oShell = CreateObject("WScript.Shell")\noShell.Run "{cmd}", 0, False\n'

def launch_and_wait(client, sftp, script_path, log_path, vbs_name, extra_args='', timeout_minutes=180):
    """Write VBS, launch it, then poll until python process is gone."""
    vbs_content = create_vbs(PYTHON_EXE, script_path, log_path, extra_args)
    vbs_path = f'{HOME}\\{vbs_name}'
    upload_file(sftp, vbs_content, vbs_path)

    # Clear old log
    run_cmd(client, f'del /f /q "{log_path}" 2>nul', timeout=5)

    # Launch VBS
    out, err = run_cmd(client, f'wscript "{vbs_path}"', timeout=15)
    time.sleep(3)

    # Verify python started
    out2, _ = run_cmd(client, 'tasklist /FI "IMAGENAME eq python.exe" /FO CSV', timeout=10)
    if 'python' in out2.lower():
        print(f"  Python started OK: {out2[:200]}")
    else:
        print(f"  WARNING: Python not detected in tasklist. Trying direct wmic launch...")
        # Fallback: wmic
        wmic_cmd = f'wmic process call create "{PYTHON_EXE} -u {script_path} {extra_args}"'
        run_cmd(client, wmic_cmd, timeout=10)
        time.sleep(3)
        out3, _ = run_cmd(client, 'tasklist /FI "IMAGENAME eq python.exe" /FO CSV', timeout=10)
        print(f"  After wmic: {out3[:200]}")

    # Poll every 30 seconds
    t0 = time.time()
    deadline = t0 + timeout_minutes * 60
    last_log_check = 0

    print(f"  Waiting for completion (max {timeout_minutes} min)...")
    while time.time() < deadline:
        time.sleep(30)
        out, _ = run_cmd(client, 'tasklist /FI "IMAGENAME eq python.exe" /FO CSV', timeout=10)
        elapsed = (time.time() - t0) / 60

        if 'python' not in out.lower():
            print(f"  Python process done! ({elapsed:.1f} min)")
            break

        # Tail log every 2 min
        if time.time() - last_log_check > 120:
            log_out, _ = run_cmd(client, f'python -c "f=open(r\'{log_path}\'); lines=f.readlines(); f.close(); [print(l.rstrip()) for l in lines[-5:]]"', timeout=10)
            if log_out:
                print(f"  [{elapsed:.1f}min] Log tail: {log_out[:400]}")
            last_log_check = time.time()
    else:
        print(f"  TIMEOUT after {timeout_minutes} min")

    # Read final log
    log_tail, _ = run_cmd(client, f'python -c "f=open(r\'{log_path}\'); lines=f.readlines(); f.close(); [print(l.rstrip()) for l in lines[-10:]]"', timeout=10)
    if log_tail:
        print(f"  Final log:\n    " + '\n    '.join(log_tail.split('\n')))


def main():
    print("=== Razer Experiment Launcher ===")
    print(f"Host: {RAZER_HOST}, User: {RAZER_USER}")

    client = get_client()
    sftp = client.open_sftp()
    print("Connected OK")

    # Verify no Python running
    out, _ = run_cmd(client, 'tasklist /FI "IMAGENAME eq python.exe"')
    print(f"Pre-check: {out[:200]}")

    experiments = [
        {
            'name': 'Task 1: L1 Imbalance IC Study',
            'script': fr'{SCRIPTS_DIR}\l1_imb_cnn_combo_ic.py',
            'log': fr'{HOME}\l1_imb_combo_ic.log',
            'vbs': 'run_l1_imb.vbs',
            'args': '',
            'timeout': 60,  # minutes
        },
        {
            'name': 'Task 2: QF Iceberg Chase FIXED (50 days subset)',
            'script': fr'{SCRIPTS_DIR}\qf_iceberg_chase_fillsim_fixed.py',
            'log': fr'{HOME}\qf_chase_fixed_subset.log',
            'vbs': 'run_qf_fixed.vbs',
            'args': f'--max-days 50 --top-n 20 --output {HOME}\\qf_chase_fixed_subset_results.json',
            'timeout': 90,
        },
        {
            'name': 'Task 4: LGBM Reduced Features',
            'script': fr'{SCRIPTS_DIR}\lgbm_reduced_features.py',
            'log': fr'{HOME}\lgbm_reduced_features.log',
            'vbs': 'run_lgbm_reduced.vbs',
            'args': '',
            'timeout': 240,
        },
    ]

    for i, exp in enumerate(experiments):
        print(f"\n{'='*60}")
        print(f"Starting {exp['name']}")
        print(f"  Script: {exp['script']}")
        print(f"  Log:    {exp['log']}")
        print(f"  Args:   {exp['args']}")
        print(f"{'='*60}")

        # Verify script exists on Razer
        script_path = exp['script']
        check_cmd = f"python -c \"import os; print(os.path.exists(r'{script_path}'))\""
        check, _ = run_cmd(client, check_cmd, timeout=10)
        if check.strip() != 'True':
            print(f"  Script NOT found on Razer: {exp['script']}")
            continue

        launch_and_wait(
            client, sftp,
            exp['script'], exp['log'], exp['vbs'],
            extra_args=exp['args'],
            timeout_minutes=exp['timeout'],
        )

    sftp.close()
    client.close()
    print("\n=== ALL EXPERIMENTS COMPLETE ===")


if __name__ == '__main__':
    main()
