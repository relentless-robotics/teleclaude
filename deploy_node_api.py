#!/usr/bin/env python3
"""
deploy_node_api.py — Deploy node_api_server.py to Razer, Uranus, Jupiter.

Steps per node:
1. Upload node_api_server.py via SFTP
2. Install flask/psutil if missing
3. Kill any old instance
4. Launch server with NODE_API_KEY set
5. Verify health endpoint responds
"""
import os
import sys
import time
import json
import socket
import urllib.request
import urllib.error

# Add project root to path
sys.path.insert(0, os.path.dirname(__file__))

import warnings
warnings.filterwarnings('ignore')
import paramiko

CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config', 'remote_servers.json')
SERVER_SCRIPT = os.path.join(os.path.dirname(__file__), 'compute', 'node_api_server.py')
API_KEY = "qcc_node_api_2026"
PORT = 8765

with open(CONFIG_FILE) as f:
    config = json.load(f)


def ssh_connect(server_name):
    srv = config['servers'][server_name]
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        srv['host'],
        port=srv.get('port', 22),
        username=srv.get('user') or srv.get('username'),
        password=srv.get('password', ''),
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run_cmd(client, cmd, timeout=60):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    rc = stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err, rc


def upload_file(client, local_path, remote_path):
    sftp = client.open_sftp()
    sftp.put(local_path, remote_path)
    sftp.close()
    print(f"  Uploaded {local_path} -> {remote_path}")


def check_http(host, port, path="/health", timeout=8):
    url = f"http://{host}:{port}{path}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            body = r.read().decode('utf-8')
            return True, body
    except Exception as e:
        return False, str(e)


def deploy_windows(server_name, remote_path, python_exe=None):
    print(f"\n{'='*60}")
    print(f"Deploying to {server_name.upper()} (Windows)")
    print(f"{'='*60}")
    srv = config['servers'][server_name]
    host = srv['host']

    client = ssh_connect(server_name)

    if python_exe is None:
        out, _, rc = run_cmd(client, 'where python', timeout=10)
        python_exe = out.splitlines()[0].strip() if rc == 0 and out else 'python'
    print(f"  Python: {python_exe}")

    # Upload the server script
    print(f"  Uploading node_api_server.py to {remote_path}...")
    upload_file(client, SERVER_SCRIPT, remote_path)

    # Install deps
    print("  Installing flask psutil (if needed)...")
    out, err, rc = run_cmd(client, f'"{python_exe}" -m pip install flask psutil -q', timeout=120)
    if rc != 0:
        print(f"  WARNING: pip install returned {rc}: {err[:200]}")
    else:
        print("  Dependencies OK")

    # Kill any existing instance on port 8765
    print(f"  Killing existing process on port {PORT}...")
    kill_cmd = (
        f'FOR /F "tokens=5" %a IN (\'netstat -ano ^| findstr :{PORT}\') '
        f'DO taskkill /F /PID %a 2>nul'
    )
    run_cmd(client, kill_cmd, timeout=15)
    time.sleep(1)

    # Also kill by script name
    run_cmd(client, 'taskkill /F /IM python.exe /FI "WINDOWTITLE eq node_api*" 2>nul', timeout=10)

    # Launch in background using start /B
    env_prefix = f'set NODE_API_KEY={API_KEY}&& set NODE_API_PORT={PORT}&&'
    launch_cmd = (
        f'start "node_api_{server_name}" /B '
        f'{env_prefix} '
        f'"{python_exe}" "{remote_path}" > '
        f'C:\\Users\\{srv.get("user","user")}\\node_api_server_stdout.log 2>&1'
    )
    print(f"  Launching API server on port {PORT}...")
    out, err, rc = run_cmd(client, launch_cmd, timeout=20)
    if err and 'error' in err.lower():
        print(f"  Launch stderr: {err[:200]}")

    client.close()
    time.sleep(3)

    # Verify
    print(f"  Checking health at http://{host}:{PORT}/health ...")
    ok, body = check_http(host, PORT)
    if ok:
        try:
            data = json.loads(body)
            print(f"  SUCCESS: {server_name} API live | hostname={data.get('hostname')} platform={data.get('platform')} gpu_count={len(data.get('gpu',[]))}")
            return True
        except Exception:
            print(f"  SUCCESS (raw): {body[:200]}")
            return True
    else:
        print(f"  HEALTH CHECK FAILED: {body}")
        return False


def deploy_linux(server_name, remote_path):
    print(f"\n{'='*60}")
    print(f"Deploying to {server_name.upper()} (Linux/WSL)")
    print(f"{'='*60}")
    srv = config['servers'][server_name]
    host = srv['host']

    client = ssh_connect(server_name)

    print(f"  Uploading node_api_server.py to {remote_path}...")
    upload_file(client, SERVER_SCRIPT, remote_path)

    # Install deps
    print("  Installing flask psutil (if needed)...")
    out, err, rc = run_cmd(client, 'pip3 install flask psutil -q 2>&1', timeout=120)
    if rc != 0:
        print(f"  WARNING: pip3 install returned {rc}: {err[:200]}")
    else:
        print("  Dependencies OK")

    # Kill existing
    print(f"  Killing existing process on port {PORT}...")
    run_cmd(client, f'fuser -k {PORT}/tcp 2>/dev/null || true', timeout=10)
    run_cmd(client, 'pkill -f node_api_server 2>/dev/null || true', timeout=10)
    time.sleep(1)

    # Launch with nohup
    log_file = f"/home/{srv.get('user','ubuntu')}/node_api_server.log"
    launch_cmd = (
        f'NODE_API_KEY={API_KEY} NODE_API_PORT={PORT} '
        f'nohup python3 {remote_path} > {log_file} 2>&1 &'
    )
    print(f"  Launching API server on port {PORT}...")
    out, err, rc = run_cmd(client, launch_cmd, timeout=20)

    client.close()
    time.sleep(3)

    # Verify
    print(f"  Checking health at http://{host}:{PORT}/health ...")
    ok, body = check_http(host, PORT)
    if ok:
        try:
            data = json.loads(body)
            print(f"  SUCCESS: {server_name} API live | hostname={data.get('hostname')} platform={data.get('platform')} gpu_count={len(data.get('gpu',[]))}")
            return True
        except Exception:
            print(f"  SUCCESS (raw): {body[:200]}")
            return True
    else:
        # Wait a bit more and retry
        print(f"  Waiting 5s and retrying...")
        time.sleep(5)
        ok, body = check_http(host, PORT, timeout=10)
        if ok:
            print(f"  SUCCESS on retry: {body[:200]}")
            return True
        print(f"  HEALTH CHECK FAILED: {body}")
        return False


results = {}

# --- Razer ---
try:
    razer_remote = r'C:\Users\claude\node_api_server.py'
    ok = deploy_windows('razer', razer_remote, python_exe=r'C:\Python311\python.exe')
    results['razer'] = 'LIVE' if ok else 'FAILED'
except Exception as e:
    print(f"  EXCEPTION: {e}")
    results['razer'] = f'ERROR: {e}'

# --- Uranus ---
try:
    uranus_remote = r'C:\Users\nick\node_api_server.py'
    ok = deploy_windows('uranus', uranus_remote,
                        python_exe=r'C:\Users\Nick\AppData\Local\Programs\Python\Python311\python.exe')
    results['uranus'] = 'LIVE' if ok else 'FAILED'
except Exception as e:
    print(f"  EXCEPTION: {e}")
    results['uranus'] = f'ERROR: {e}'

# --- Jupiter ---
try:
    jupiter_remote = '/home/jupiter/node_api_server.py'
    ok = deploy_linux('jupiter', jupiter_remote)
    results['jupiter'] = 'LIVE' if ok else 'FAILED'
except Exception as e:
    print(f"  EXCEPTION: {e}")
    results['jupiter'] = f'ERROR: {e}'

print(f"\n{'='*60}")
print("DEPLOYMENT SUMMARY")
print(f"{'='*60}")
for node, status in results.items():
    icon = "OK" if status == 'LIVE' else "FAIL"
    print(f"  [{icon}] {node}: {status}")

print(json.dumps(results))
