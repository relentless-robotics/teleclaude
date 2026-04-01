#!/usr/bin/env python3
"""Deploy node_api_server.py to a Windows node via SSH."""
import warnings
warnings.filterwarnings('ignore')
import paramiko
import time
import json
import sys
import urllib.request

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


def upload(client, local_path, remote_path):
    sftp = client.open_sftp()
    sftp.put(local_path, remote_path)
    sftp.close()


def check_health(host):
    try:
        with urllib.request.urlopen(f"http://{host}:{PORT}/health", timeout=10) as r:
            body = r.read().decode()
            return json.loads(body)
    except Exception as e:
        return None


def kill_existing(client):
    out, err, rc = runcmd(client, f"netstat -ano | findstr :{PORT}", 15)
    if out:
        pids = set()
        for line in out.splitlines():
            parts = line.split()
            if parts and parts[-1].isdigit() and parts[-1] != '0':
                pids.add(parts[-1])
        for pid in pids:
            runcmd(client, f"taskkill /F /PID {pid} 2>nul", 10)
            print(f"  Killed PID {pid}")
        time.sleep(2)


def deploy_windows(node_name, host, user, password, python_exe, remote_script):
    print(f"\n=== {node_name.upper()} ({host}) ===")
    remote_log = remote_script.replace("node_api_server.py", "node_api.log")
    remote_bat = remote_script.replace("node_api_server.py", "node_api_launch.bat")

    c = connect(host, user, password)

    # Upload script
    print(f"  Uploading node_api_server.py -> {remote_script}")
    upload(c, SERVER_SCRIPT, remote_script)
    print("  Upload OK")

    # Kill existing
    kill_existing(c)

    # Write a .bat launcher using Python on the remote
    bat_content_lines = [
        "@echo off",
        f"set NODE_API_KEY={API_KEY}",
        f"set NODE_API_PORT={PORT}",
        f'"{python_exe}" "{remote_script}" >> "{remote_log}" 2>&1',
    ]
    bat_escaped = "\\n".join(bat_content_lines)

    # Write bat file using Python on the remote node
    write_cmd = (
        f"python -c \""
        f"lines = ['@echo off', 'set NODE_API_KEY={API_KEY}', 'set NODE_API_PORT={PORT}', "
        f"'[QUOTE]{python_exe}[QUOTE] [QUOTE]{remote_script}[QUOTE] >> [QUOTE]{remote_log}[QUOTE] 2>&1'];"
        f"open('{remote_bat.replace(chr(92), '/')}', 'w').write('\\r\\n'.join(lines))"
        f"\""
    )
    # Use PowerShell Set-Content instead - more reliable
    bat_lines = [
        "@echo off",
        f"set NODE_API_KEY={API_KEY}",
        f"set NODE_API_PORT={PORT}",
        f'"{python_exe}" "{remote_script}" >> "{remote_log}" 2>&1',
    ]

    # PowerShell command to write bat file
    ps_write = 'powershell -Command "' + \
        '$lines = @(' + \
        ','.join([f"'{l.replace(chr(39), chr(96))}'" for l in bat_lines]) + \
        '); ' + \
        f'[System.IO.File]::WriteAllText(' + \
        f"'{remote_bat}'," + \
        '$lines -join \"`r`n\")' + \
        '"'

    out, err, rc = runcmd(c, ps_write, 20)
    if rc != 0:
        print(f"  PS write failed (rc={rc}): {err[:200]}")
        # Fallback: use echo
        out2, err2, rc2 = runcmd(c, f'echo @echo off > "{remote_bat}"', 10)
        runcmd(c, f'echo set NODE_API_KEY={API_KEY} >> "{remote_bat}"', 10)
        runcmd(c, f'echo set NODE_API_PORT={PORT} >> "{remote_bat}"', 10)
        runcmd(c, f'echo "{python_exe}" "{remote_script}" ^>^> "{remote_log}" 2^>^&1 >> "{remote_bat}"', 10)
        print(f"  Fallback echo write rc={rc2}")
    else:
        print("  Bat file written OK")

    # Launch using PowerShell Start-Process
    ps_launch = (
        f'powershell -Command "Start-Process -FilePath \'{remote_bat}\' -WindowStyle Hidden"'
    )
    out, err, rc = runcmd(c, ps_launch, 20)
    print(f"  Launch rc={rc}" + (f" err={err[:100]}" if err else ""))

    c.close()

    # Wait and check health
    print(f"  Waiting 6s for server startup...")
    time.sleep(6)

    health = check_health(host)
    if health:
        print(f"  SUCCESS: {node_name} API LIVE | hostname={health.get('hostname')} platform={health.get('platform')} gpus={len(health.get('gpu', []))}")
        return True

    # Retry
    print(f"  Retrying health check in 5s...")
    time.sleep(5)
    health = check_health(host)
    if health:
        print(f"  SUCCESS (retry): {node_name} API LIVE | hostname={health.get('hostname')}")
        return True

    print(f"  FAILED: Could not reach {node_name} API at {host}:{PORT}")

    # Debug: check if process started
    c2 = connect(host, user, password)
    out, _, _ = runcmd(c2, f"netstat -ano | findstr :{PORT}", 15)
    print(f"  netstat: {out or '(nothing)'}")

    # Check log
    log_check, _, _ = runcmd(c2, f'type "{remote_log}" 2>&1', 20)
    print(f"  Log tail: {log_check[-500:] if log_check else '(empty)'}")
    c2.close()

    return False


if __name__ == "__main__":
    results = {}

    # Razer
    ok = deploy_windows(
        "razer",
        "100.102.215.75", "claude", "Pb26116467",
        r"C:\Python311\python.exe",
        r"C:\Users\claude\node_api_server.py",
    )
    results["razer"] = "LIVE" if ok else "FAILED"

    # Uranus
    ok = deploy_windows(
        "uranus",
        "100.100.83.37", "nick", "Pb26116467",
        r"C:\Users\Nick\AppData\Local\Programs\Python\Python311\python.exe",
        r"C:\Users\nick\node_api_server.py",
    )
    results["uranus"] = "LIVE" if ok else "FAILED"

    print("\n=== RESULTS ===")
    for node, status in results.items():
        print(f"  {node}: {status}")
