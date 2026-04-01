#!/usr/bin/env python3
"""Fix Uranus deployment - server is running but bound to 127.0.0.1."""
import warnings
warnings.filterwarnings('ignore')
import paramiko
import time
import json
import urllib.request
import base64

API_KEY = "qcc_node_api_2026"
PORT = 8765


def connect(host, user, password):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=22, username=user, password=password,
                   timeout=30, allow_agent=False, look_for_keys=False)
    return client


def runcmd(client, cmd, timeout=30):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    rc = stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err, rc


def check_health(host, port=8765):
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/health", timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return None


def write_remote_file(client, python_exe, remote_path, content):
    b64 = base64.b64encode(content.encode()).decode()
    cmd = f'"{python_exe}" -c "import base64; open(r\'{remote_path}\', \'w\').write(base64.b64decode(\'{b64}\').decode())"'
    out, err, rc = runcmd(client, cmd, 20)
    return rc == 0


host = "100.100.83.37"
user = "nick"
password = "Pb26116467"
python_exe = r"C:\Users\Nick\AppData\Local\Programs\Python\Python311\python.exe"
script_path = r"C:\Users\nick\node_api_server.py"
log_path = r"C:\Users\nick\node_api_run.log"

c = connect(host, user, password)

# Check what's currently listening
print("=== Uranus investigation ===")
out, _, _ = runcmd(c, "netstat -ano | findstr LISTEN", 20)
print(f"All LISTEN:\n{out}\n")

# Check if port is bound to all interfaces or just localhost
out, _, _ = runcmd(c, f"netstat -ano | findstr :{PORT}", 20)
print(f"Port {PORT} bindings:\n{out}\n")

# Kill existing server
if out:
    for line in out.splitlines():
        parts = line.split()
        if parts and parts[-1].isdigit() and parts[-1] != '0':
            pid = parts[-1]
            runcmd(c, f"taskkill /F /PID {pid} 2>nul", 10)
            print(f"Killed PID {pid}")
    time.sleep(2)

# Test if port 8765 is accessible from outside using raw socket test
test_bind_content = """import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(('0.0.0.0', 8765))
    print('BIND_OK: 0.0.0.0:8765 bound successfully')
    s.close()
except Exception as e:
    print(f'BIND_FAIL: {e}')
    s.close()
"""
test_path = r"C:\Users\nick\test_bind.py"
if write_remote_file(c, python_exe, test_path, test_bind_content):
    out, err, rc = runcmd(c, f'"{python_exe}" "{test_path}"', 15)
    print(f"Bind test: {out} {err}")

# Write launcher that uses port 8765 and 0.0.0.0 explicitly
launcher_content = f"""import subprocess, os, sys, time

env = dict(os.environ)
env['NODE_API_KEY'] = '{API_KEY}'
env['NODE_API_PORT'] = '8765'
env['NODE_API_HOST'] = '0.0.0.0'

log = open(r'{log_path}', 'w', buffering=1)
log.write('Launcher v2 starting...\\n')
log.flush()

try:
    CREATE_NO_WINDOW = 0x08000000
    p = subprocess.Popen(
        [r'{python_exe}', r'{script_path}'],
        env=env,
        stdout=log,
        stderr=log,
        creationflags=CREATE_NO_WINDOW,
    )
    log.write(f'Server PID={{p.pid}}\\n')
    log.flush()
    for i in range(60):
        rc = p.poll()
        if rc is not None:
            log.write(f'Server exited rc={{rc}}\\n')
            break
        time.sleep(1)
    else:
        log.write('Server still alive after 60s\\n')
except Exception as ex:
    log.write(f'ERROR: {{ex}}\\n')
log.flush()
log.close()
"""

launcher_path = r"C:\Users\nick\node_api_launcher3.py"
print(f"\nWriting launcher v3...")
if write_remote_file(c, python_exe, launcher_path, launcher_content):
    print("Launcher written OK")
else:
    print("Launcher write FAILED")
    c.close()
    exit(1)

c.close()

# Launch with 65s timeout - will keep server alive and we wait on it
print("Launching server (65s window)...")
c2 = connect(host, user, password)
stdin, stdout, stderr = c2.exec_command(f'"{python_exe}" "{launcher_path}"', timeout=65)

# Poll health
print("Polling health endpoint...")
start = time.time()
health = None
while time.time() - start < 55:
    time.sleep(3)
    health = check_health(host, PORT)
    if health:
        break
    elapsed = int(time.time() - start)
    # Check log
    c3 = connect(host, user, password)
    log_out, _, _ = runcmd(c3, f'type "{log_path}" 2>&1', 10)
    c3.close()
    last = (log_out.splitlines()[-3:] if log_out else ['(empty)'])
    print(f"  {elapsed}s: {' | '.join(last)}")

try:
    stdout.channel.settimeout(3)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    if out: print(f"Launcher out: {out[:200]}")
except Exception:
    pass
c2.close()

if health:
    gpu_info = ""
    if health.get('gpu'):
        g = health['gpu'][0]
        gpu_info = f" GPU:{g.get('name','?')} {g.get('util_pct',0)}%"
    print(f"\nSUCCESS: Uranus API LIVE | hostname={health.get('hostname')}{gpu_info}")
else:
    # Check if server is now bound to 0.0.0.0
    c4 = connect(host, user, password)
    out, _, _ = runcmd(c4, f"netstat -ano | findstr :{PORT}", 15)
    print(f"\nnetstat: {out}")
    log_final, _, _ = runcmd(c4, f'type "{log_path}" 2>&1', 15)
    print(f"Log: {log_final[-600:]}")
    # Try via Tailscale IP too
    print("Checking health via Tailscale IP (100.100.83.37)...")
    h2 = check_health("100.100.83.37", PORT)
    print(f"Tailscale health: {h2}")
    c4.close()
