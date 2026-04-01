#!/usr/bin/env python3
"""
Launch API server and verify it's reachable from the node itself.
Uses background=True and then curls localhost from within the node.
"""
import warnings
warnings.filterwarnings('ignore')
import paramiko
import time
import json
import urllib.request
import base64

API_KEY = "qcc_node_api_2026"
PORT = 8765
SERVER_SCRIPT = r"C:\Users\Footb\Documents\Github\teleclaude-main\compute\node_api_server.py"


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


def check_health(host, port=8765, timeout=10):
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/health", timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return None


def upload_file(client, local_path, remote_path):
    sftp = client.open_sftp()
    sftp.put(local_path, remote_path)
    sftp.close()


def kill_port(client, port):
    out, _, _ = runcmd(client, f"netstat -ano | findstr :{port}", 15)
    if out:
        for line in out.splitlines():
            parts = line.split()
            if parts and parts[-1].isdigit() and parts[-1] != '0':
                runcmd(client, f"taskkill /F /PID {parts[-1]} 2>nul", 10)
                print(f"  Killed PID {parts[-1]}")
        time.sleep(2)


def write_remote_file(client, python_exe, remote_path, content):
    """Write a file on the remote using base64."""
    b64 = base64.b64encode(content.encode()).decode()
    cmd = f'"{python_exe}" -c "import base64; open(r\'{remote_path}\', \'w\').write(base64.b64decode(\'{b64}\').decode())"'
    out, err, rc = runcmd(client, cmd, 20)
    return rc == 0


def deploy_windows(node_name, host, user, password, python_exe, remote_script_path):
    print(f"\n{'='*60}")
    print(f"Deploying {node_name.upper()} ({host})")
    print(f"{'='*60}")

    c = connect(host, user, password)

    # 1. Upload server script
    print(f"  Uploading node_api_server.py...")
    upload_file(c, SERVER_SCRIPT, remote_script_path)

    # 2. Kill existing server
    kill_port(c, PORT)

    # 3. Write a launcher script that uses subprocess.Popen with CREATE_NO_WINDOW
    # The key insight: we need to run it as a regular (not fully detached) background process
    # so Windows doesn't kill it. Use CREATE_NO_WINDOW only (0x08000000).
    log_path = remote_script_path.replace("node_api_server.py", "node_api_run.log")
    launcher_content = f"""import subprocess, os, sys, time

env = dict(os.environ)
env['NODE_API_KEY'] = '{API_KEY}'
env['NODE_API_PORT'] = '{PORT}'

log = open(r'{log_path}', 'w', buffering=1)
log.write('Launcher starting...\\n')
log.flush()

try:
    CREATE_NO_WINDOW = 0x08000000
    p = subprocess.Popen(
        [r'{python_exe}', r'{remote_script_path}'],
        env=env,
        stdout=log,
        stderr=log,
        creationflags=CREATE_NO_WINDOW,
    )
    log.write(f'Server started PID={{p.pid}}\\n')
    log.flush()
    # Keep launcher alive so SSH channel doesn't kill child
    # Check for 30s then exit
    for _ in range(30):
        rc = p.poll()
        if rc is not None:
            log.write(f'Server exited rc={{rc}}\\n')
            log.flush()
            break
        time.sleep(1)
    else:
        log.write('Server still running after 30s - launcher detaching\\n')
        log.flush()
except Exception as ex:
    log.write(f'ERROR: {{ex}}\\n')
    log.flush()
log.close()
"""

    launcher_path = remote_script_path.replace("node_api_server.py", "node_api_launcher2.py")
    print(f"  Writing launcher to {launcher_path}...")
    if not write_remote_file(c, python_exe, launcher_path, launcher_content):
        print("  Failed to write launcher!")
        c.close()
        return False

    # 4. Run launcher (it'll run for 30s keeping server alive)
    # We run it with a 35s timeout - the launcher will exit after 30s but server stays up
    print(f"  Launching server (30s bootstrap window)...")
    launcher_cmd = f'"{python_exe}" "{launcher_path}"'
    stdin, stdout, stderr = c.exec_command(launcher_cmd, timeout=35)

    # Poll for health while launcher is running
    print(f"  Waiting for Flask to bind on port {PORT}...")
    start = time.time()
    health = None
    while time.time() - start < 25:
        time.sleep(3)
        health = check_health(host, PORT)
        if health:
            break
        # Check log
        log_out, _, _ = runcmd(c, f'type "{log_path}" 2>&1', 10)
        if log_out:
            last_lines = log_out.splitlines()[-3:]
            print(f"    log: {' | '.join(last_lines)}")
        elapsed = int(time.time() - start)
        print(f"    {elapsed}s: still waiting...")

    # Read launcher output
    try:
        stdout.channel.settimeout(5)
        out = stdout.read().decode('utf-8', errors='replace').strip()
        err = stderr.read().decode('utf-8', errors='replace').strip()
        if out: print(f"  Launcher stdout: {out[:200]}")
        if err: print(f"  Launcher stderr: {err[:200]}")
    except Exception:
        pass

    c.close()

    if health:
        gpu_info = ""
        if health.get('gpu'):
            g = health['gpu'][0]
            gpu_info = f" | GPU: {g.get('name','?')} {g.get('util_pct',0)}% {g.get('mem_used_mb',0)}/{g.get('mem_total_mb',0)}MB"
        ram = health.get('ram', {})
        print(f"  SUCCESS: {node_name} API LIVE | hostname={health.get('hostname')}{gpu_info} RAM={ram.get('percent','?')}%")
        return True

    # Final debug
    c2 = connect(host, user, password)
    netstat, _, _ = runcmd(c2, f"netstat -ano | findstr :{PORT}", 15)
    print(f"  netstat: {netstat or '(nothing)'}")
    log_final, _, _ = runcmd(c2, f'type "{log_path}" 2>&1', 20)
    print(f"  Final log:\n{log_final[-600:]}")

    # Test curl from within Windows node
    curl_test, _, _ = runcmd(c2, f'powershell -Command "Invoke-WebRequest -Uri http://localhost:{PORT}/health -UseBasicParsing -TimeoutSec 5 2>&1"', 15)
    print(f"  Local curl: {curl_test[:300]}")
    c2.close()
    return False


if __name__ == "__main__":
    results = {}

    ok = deploy_windows(
        "razer", "100.102.215.75", "claude", "Pb26116467",
        r"C:\Python311\python.exe",
        r"C:\Users\claude\node_api_server.py",
    )
    results["razer"] = "LIVE" if ok else "FAILED"

    ok = deploy_windows(
        "uranus", "100.100.83.37", "nick", "Pb26116467",
        r"C:\Users\Nick\AppData\Local\Programs\Python\Python311\python.exe",
        r"C:\Users\nick\node_api_server.py",
    )
    results["uranus"] = "LIVE" if ok else "FAILED"

    print(f"\n{'='*60}")
    print("FINAL RESULTS")
    print(f"{'='*60}")
    for node, status in results.items():
        icon = "OK" if status == "LIVE" else "FAIL"
        print(f"  [{icon}] {node}: {status}")
