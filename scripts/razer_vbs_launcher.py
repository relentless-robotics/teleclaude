#!/usr/bin/env python3
"""
Simple: write VBS files to Razer via paramiko SFTP, then launch via QCC API.
"""
import sys, os, time, json, warnings
warnings.filterwarnings('ignore')

import paramiko
import urllib.request

RAZER_HOST = '100.102.215.75'
RAZER_PORT = 22
RAZER_USER = 'claude'
RAZER_PASS = 'Pb26116467'
PYTHON_EXE = r'C:\Python311\python.exe'
SCRIPTS_DIR = r'C:\Users\claude\Lvl3Quant\scripts'
HOME = r'C:\Users\claude'
QCC = 'http://localhost:3456/api/ssh/exec'


def qcc_exec(cmd, timeout=20):
    payload = json.dumps({'node': 'razer', 'command': cmd}).encode()
    req = urllib.request.Request(QCC, data=payload,
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout+5) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {'error': str(e), 'stdout': '', 'stderr': '', 'exitCode': -1}


def connect_sftp():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(RAZER_HOST, port=RAZER_PORT, username=RAZER_USER,
                   password=RAZER_PASS, timeout=30, banner_timeout=60)
    return client, client.open_sftp()


def upload(sftp, content, remote_path):
    with sftp.file(remote_path, 'w') as f:
        f.write(content)
    print(f"  Uploaded: {remote_path}")


def make_vbs(script_path, log_path, extra_args=''):
    cmd_line = f'{PYTHON_EXE} -u {script_path} {extra_args}'.strip()
    return (
        'Set oShell = CreateObject("WScript.Shell")\n'
        f'oShell.Run "cmd /c {cmd_line} >> {log_path} 2>&1", 0, False\n'
    )


def launch_vbs(vbs_path):
    r = qcc_exec(f'wscript "{vbs_path}"', timeout=15)
    print(f"  wscript result: {r}")
    time.sleep(3)
    r2 = qcc_exec('tasklist /FI "IMAGENAME eq python.exe" /FO CSV', timeout=10)
    print(f"  Python procs: {r2.get('stdout','')[:300]}")
    return 'python' in r2.get('stdout', '').lower()


def main():
    print("=== Razer VBS Launcher ===")

    # 1. Connect via SFTP to write VBS files
    print("Connecting SFTP...")
    client, sftp = connect_sftp()
    print("Connected")

    # 2. Write all VBS files
    experiments = [
        {
            'name': 'Task 1: L1 Imbalance IC',
            'script': fr'{SCRIPTS_DIR}\l1_imb_cnn_combo_ic.py',
            'log':    fr'{HOME}\l1_imb_combo_ic.log',
            'vbs':    fr'{HOME}\run_l1_imb.vbs',
            'args':   '',
        },
        {
            'name': 'Task 2: QF Iceberg Chase Fixed Subset',
            'script': fr'{SCRIPTS_DIR}\qf_iceberg_chase_fillsim_fixed.py',
            'log':    fr'{HOME}\qf_chase_fixed_subset.log',
            'vbs':    fr'{HOME}\run_qf_fixed.vbs',
            'args':   fr'--max-days 50 --top-n 20 --output {HOME}\qf_chase_fixed_subset_results.json',
        },
        {
            'name': 'Task 4: LGBM Reduced Features',
            'script': fr'{SCRIPTS_DIR}\lgbm_reduced_features.py',
            'log':    fr'{HOME}\lgbm_reduced_features.log',
            'vbs':    fr'{HOME}\run_lgbm_reduced.vbs',
            'args':   '',
        },
    ]

    # Write a sequential launcher script on Razer that calls all 3 in order
    seq_launcher = fr'{HOME}\run_all_sequential.py'
    seq_launcher_log = fr'{HOME}\run_all_sequential.log'
    seq_vbs = fr'{HOME}\run_all_sequential.vbs'

    seq_content = f'''#!/usr/bin/env python3
"""Sequential experiment launcher."""
import subprocess, sys, time, os

PYTHON = r"{PYTHON_EXE}"

experiments = [
    {{
        "name": "L1 Imbalance IC Study",
        "script": r"{SCRIPTS_DIR}\\l1_imb_cnn_combo_ic.py",
        "log": r"{HOME}\\l1_imb_combo_ic.log",
        "args": [],
    }},
    {{
        "name": "QF Iceberg Chase Fixed Subset",
        "script": r"{SCRIPTS_DIR}\\qf_iceberg_chase_fillsim_fixed.py",
        "log": r"{HOME}\\qf_chase_fixed_subset.log",
        "args": ["--max-days", "50", "--top-n", "20",
                 "--output", r"{HOME}\\qf_chase_fixed_subset_results.json"],
    }},
    {{
        "name": "LGBM Reduced Features",
        "script": r"{SCRIPTS_DIR}\\lgbm_reduced_features.py",
        "log": r"{HOME}\\lgbm_reduced_features.log",
        "args": [],
    }},
]

for exp in experiments:
    name = exp["name"]
    script = exp["script"]
    log_path = exp["log"]
    args = exp["args"]
    print(f"[{{time.strftime('%H:%M:%S')}}] STARTING: {{name}}", flush=True)
    print(f"  Script: {{script}}", flush=True)
    if not os.path.exists(script):
        print(f"  SKIP: not found", flush=True)
        continue
    t0 = time.time()
    cmd = [PYTHON, "-u", script] + args
    with open(log_path, "w", buffering=1) as lf:
        proc = subprocess.run(cmd, stdout=lf, stderr=lf)
    elapsed = time.time() - t0
    print(f"[{{time.strftime('%H:%M:%S')}}] DONE: {{name}} rc={{proc.returncode}} elapsed={{elapsed:.0f}}s", flush=True)

print("ALL DONE", flush=True)
'''

    upload(sftp, seq_content, seq_launcher)

    # Write VBS for sequential launcher
    seq_vbs_content = (
        'Set oShell = CreateObject("WScript.Shell")\n'
        f'oShell.Run "cmd /c {PYTHON_EXE} -u {seq_launcher} >> {seq_launcher_log} 2>&1", 0, False\n'
    )
    upload(sftp, seq_vbs_content, seq_vbs)
    sftp.close()
    client.close()
    print("SFTP done, files uploaded")

    # 3. Verify scripts exist on Razer
    print("\nVerifying scripts on Razer...")
    for exp in experiments:
        sp = exp['script']
        check_cmd = f"python -c \"import os; print(os.path.exists(r'{sp}'))\""
        r = qcc_exec(check_cmd, timeout=10)
        exists = r.get('stdout', '').strip()
        print(f"  {exp['name']}: {exists}")

    # 4. Launch via VBS
    print("\nLaunching sequential experiment runner via VBS...")
    launched = launch_vbs(seq_vbs)
    print(f"  Python detected: {launched}")

    if not launched:
        # Try direct wmic as fallback
        print("  Trying wmic fallback...")
        wmic_cmd = f'wmic process call create "{PYTHON_EXE} -u {seq_launcher} >> {seq_launcher_log} 2>&1"'
        r = qcc_exec(wmic_cmd, timeout=15)
        print(f"  wmic result: {r}")
        time.sleep(4)
        r2 = qcc_exec('tasklist /FI "IMAGENAME eq python.exe" /FO CSV', timeout=10)
        print(f"  Python procs: {r2.get('stdout','')[:300]}")

    print(f"\nSequential launcher log: {seq_launcher_log}")
    print("Monitor with: tasklist /FI IMAGENAME eq python.exe")


if __name__ == '__main__':
    main()
