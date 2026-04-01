#!/usr/bin/env python3
"""Fix and re-launch API server on Windows nodes using a Python-written launcher."""
import warnings
warnings.filterwarnings('ignore')
import paramiko
import time
import json
import urllib.request

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


def check_health(host, retries=3, delay=5):
    for i in range(retries):
        try:
            with urllib.request.urlopen(f"http://{host}:{PORT}/health", timeout=10) as r:
                return json.loads(r.read().decode())
        except Exception:
            if i < retries - 1:
                time.sleep(delay)
    return None


def kill_port(client):
    out, _, _ = runcmd(client, f"netstat -ano | findstr :{PORT}", 15)
    if out:
        for line in out.splitlines():
            parts = line.split()
            if parts and parts[-1].isdigit() and parts[-1] != '0':
                pid = parts[-1]
                runcmd(client, f"taskkill /F /PID {pid} 2>nul", 10)
                print(f"  Killed PID {pid}")
        time.sleep(2)


def launch_via_python_launcher(client, python_exe, script_path, log_path, node_name):
    """
    Write a tiny Python launcher script on the remote, then use
    'pythonw' (windowless) or a scheduled task style to run it detached.
    """
    # Write a launcher .py that uses subprocess to detach the real server
    launcher_path = script_path.replace("node_api_server.py", "node_api_launcher.py")
    launcher_py_content = (
        "import subprocess, os, sys\n"
        f"env = dict(os.environ)\n"
        f"env['NODE_API_KEY'] = '{API_KEY}'\n"
        f"env['NODE_API_PORT'] = '{PORT}'\n"
        f"log = open(r'{log_path}', 'a')\n"
        f"p = subprocess.Popen(\n"
        f"    [r'{python_exe}', r'{script_path}'],\n"
        f"    env=env, stdout=log, stderr=log,\n"
        f"    creationflags=0x00000008|0x00000200|0x08000000,\n"
        f"    close_fds=True\n"
        f")\n"
        f"print('Launched PID', p.pid)\n"
    )

    # Write launcher via Python on remote
    # Encode content as base64 to avoid quoting issues
    import base64
    b64 = base64.b64encode(launcher_py_content.encode()).decode()

    write_cmd = (
        f'python -c "import base64; '
        f'open(r\'{launcher_path}\', \'w\').write(base64.b64decode(\'{b64}\').decode())"'
    )
    out, err, rc = runcmd(client, write_cmd, 20)
    if rc != 0:
        print(f"  Write launcher failed: {err[:200]}")
        return False
    print(f"  Launcher written to {launcher_path}")

    # Run the launcher synchronously (it launches the server and exits)
    run_launcher = f'"{python_exe}" "{launcher_path}"'
    out, err, rc = runcmd(client, run_launcher, 20)
    print(f"  Launcher run rc={rc} out={out[:100]}" + (f" err={err[:100]}" if err else ""))
    return rc == 0


def deploy_node(node_name, host, user, password, python_exe, script_path):
    print(f"\n=== {node_name.upper()} ({host}) ===")
    log_path = script_path.replace("node_api_server.py", "node_api.log")

    c = connect(host, user, password)

    # Kill existing
    kill_port(c)

    # Try launching
    ok = launch_via_python_launcher(c, python_exe, script_path, log_path, node_name)
    c.close()

    if not ok:
        print(f"  Launch failed, checking anyway...")

    time.sleep(6)
    health = check_health(host, retries=3, delay=5)
    if health:
        gpu_count = len(health.get('gpu', []))
        gpu_info = ""
        if health.get('gpu'):
            g = health['gpu'][0]
            gpu_info = f" | GPU: {g.get('name','?')} {g.get('util_pct',0)}% {g.get('mem_used_mb',0)}/{g.get('mem_total_mb',0)}MB"
        print(f"  SUCCESS: {node_name} API LIVE | hostname={health.get('hostname')} {gpu_info}")
        return True

    # Debug
    print(f"  Health check failed. Checking log...")
    c2 = connect(host, user, password)
    log_tail, _, _ = runcmd(c2, f'type "{log_path}" 2>&1', 20)
    print(f"  Log: {log_tail[-600:] if log_tail else '(empty)'}")
    netstat, _, _ = runcmd(c2, f"netstat -ano | findstr :{PORT}", 15)
    print(f"  netstat: {netstat or '(nothing)'}")
    c2.close()
    return False


if __name__ == "__main__":
    results = {}

    # Razer
    ok = deploy_node(
        "razer", "100.102.215.75", "claude", "Pb26116467",
        r"C:\Python311\python.exe",
        r"C:\Users\claude\node_api_server.py",
    )
    results["razer"] = "LIVE" if ok else "FAILED"

    # Uranus
    ok = deploy_node(
        "uranus", "100.100.83.37", "nick", "Pb26116467",
        r"C:\Users\Nick\AppData\Local\Programs\Python\Python311\python.exe",
        r"C:\Users\nick\node_api_server.py",
    )
    results["uranus"] = "LIVE" if ok else "FAILED"

    print("\n=== DEPLOYMENT RESULTS ===")
    for node, status in results.items():
        icon = "OK" if status == "LIVE" else "FAIL"
        print(f"  [{icon}] {node}: {status}")
