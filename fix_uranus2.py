#!/usr/bin/env python3
"""
Fix Uranus: Use pythonw.exe to launch API server without a console window.
pythonw.exe is designed for this - runs Python without a console, stays alive.
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


def write_remote_file(client, python_exe, remote_path, content):
    b64 = base64.b64encode(content.encode()).decode()
    cmd = f'"{python_exe}" -c "import base64; open(r\'{remote_path}\', \'w\').write(base64.b64decode(\'{b64}\').decode())"'
    out, err, rc = runcmd(client, cmd, 20)
    return rc == 0


host = "100.100.83.37"
user = "nick"
password = "Pb26116467"
python_exe = r"C:\Users\Nick\AppData\Local\Programs\Python\Python311\python.exe"
pythonw_exe = r"C:\Users\Nick\AppData\Local\Programs\Python\Python311\pythonw.exe"
script_path = r"C:\Users\nick\node_api_server.py"
log_path = r"C:\Users\nick\node_api_run2.log"

print("=== URANUS Fix v2 ===")
c = connect(host, user, password)

# Check if pythonw.exe exists
out, _, rc = runcmd(c, f'dir "{pythonw_exe}" 2>&1', 10)
print(f"pythonw.exe: {out[:100]}")

# Kill existing
out, _, _ = runcmd(c, f"netstat -ano | findstr :{PORT}", 15)
if out:
    for line in out.splitlines():
        parts = line.split()
        if parts and parts[-1].isdigit() and parts[-1] != '0':
            runcmd(c, f"taskkill /F /PID {parts[-1]} 2>nul", 10)
            print(f"  Killed PID {parts[-1]}")
    time.sleep(2)

# Strategy 1: Use pythonw.exe directly (windowless Python)
# pythonw.exe runs without console window and stays alive properly
launch_cmd = (
    f'set "NODE_API_KEY={API_KEY}" && '
    f'set "NODE_API_PORT={PORT}" && '
    f'start "" "{pythonw_exe}" "{script_path}"'
)
print(f"Strategy 1: pythonw.exe via start...")
out, err, rc = runcmd(c, launch_cmd, 15)
print(f"  rc={rc} out={out[:100]} err={err[:100]}")
c.close()

time.sleep(5)

health = check_health(host, PORT)
if health:
    print(f"SUCCESS via pythonw: hostname={health.get('hostname')}")
else:
    # Strategy 2: Use PowerShell Start-Process with pythonw
    print("Strategy 1 failed. Trying PowerShell Start-Process with pythonw...")
    c2 = connect(host, user, password)

    # Kill again
    out, _, _ = runcmd(c2, f"netstat -ano | findstr :{PORT}", 15)
    if out:
        for line in out.splitlines():
            parts = line.split()
            if parts and parts[-1].isdigit() and parts[-1] != '0':
                runcmd(c2, f"taskkill /F /PID {parts[-1]} 2>nul", 10)
        time.sleep(2)

    # Create a small wrapper bat with env vars set
    bat_content = f"""@echo off
set NODE_API_KEY={API_KEY}
set NODE_API_PORT={PORT}
"{pythonw_exe}" "{script_path}"
"""
    bat_path = r"C:\Users\nick\run_api.bat"
    b64 = base64.b64encode(bat_content.encode()).decode()
    write_cmd = f'"{python_exe}" -c "import base64; open(r\'{bat_path}\', \'wb\').write(base64.b64decode(\'{b64}\'))"'
    out, err, rc = runcmd(c2, write_cmd, 20)
    print(f"  Bat write rc={rc}")

    # PowerShell Start-Process the bat file
    ps_cmd = (
        f'powershell -Command "'
        f"Start-Process -FilePath '{bat_path}' -WindowStyle Hidden"
        f'"'
    )
    out, err, rc = runcmd(c2, ps_cmd, 20)
    print(f"  PS Start-Process rc={rc} out={out[:100]} err={err[:100]}")
    c2.close()

    time.sleep(8)

    health = check_health(host, PORT)
    if health:
        print(f"SUCCESS via PS/bat: hostname={health.get('hostname')}")
    else:
        # Strategy 3: Schedule Task (runs in full user context)
        print("Strategy 2 failed. Trying Scheduled Task...")
        c3 = connect(host, user, password)

        # Create scheduled task that runs once immediately
        task_cmd = (
            f'schtasks /create /tn "NodeAPI_{PORT}" /tr '
            f'"\\"cmd.exe\\" /c \\"set NODE_API_KEY={API_KEY} && '
            f'set NODE_API_PORT={PORT} && '
            f'\\"{pythonw_exe}\\" \\"{script_path}\\"\\"\\" '
            f'/sc once /st 00:00 /ru {user} /f /rl highest 2>&1'
        )

        # Simpler: use SchTasks XML approach
        # Actually, simplest: schtasks /run doesn't work for new tasks
        # Try: create and run

        # Build the schtasks command more carefully
        scht = (
            f'schtasks /create /f /tn "NodeAPIServer" /tr '
            f'"cmd /c set NODE_API_KEY={API_KEY} ^&^& set NODE_API_PORT={PORT} ^&^& '
            f'''"''' + pythonw_exe + f'''" "''' + script_path + f'''"" '''
            f'/sc onstart /ru SYSTEM 2>&1'
        )
        out, err, rc = runcmd(c3, scht, 20)
        print(f"  schtasks create: rc={rc} out={out[:200]} err={err[:100]}")

        out2, err2, rc2 = runcmd(c3, 'schtasks /run /tn "NodeAPIServer" 2>&1', 15)
        print(f"  schtasks run: rc={rc2} out={out2[:100]} err={err2[:100]}")
        c3.close()

        time.sleep(8)
        health = check_health(host, PORT)
        if health:
            print(f"SUCCESS via schtasks: hostname={health.get('hostname')}")
        else:
            # Check netstat
            c4 = connect(host, user, password)
            ns, _, _ = runcmd(c4, f"netstat -ano | findstr :{PORT}", 15)
            print(f"netstat: {ns or '(nothing)'}")
            # Check the actual bind - maybe only loopback is accessible and we need firewall rule
            # Try to access via the LAN IP that Uranus uses
            fw_check, _, _ = runcmd(c4, 'netsh advfirewall show allprofiles state 2>&1', 15)
            print(f"Firewall: {fw_check[:300]}")
            c4.close()
            print("FAILED: Uranus API could not be reached remotely")

# Check what we actually have
print(f"\n=== Final health checks ===")
for node, h in [("razer", "100.102.215.75"), ("uranus", "100.100.83.37"), ("jupiter", "192.168.0.108")]:
    health = check_health(h, PORT)
    if health:
        gpu_count = len(health.get('gpu', []))
        print(f"  [{node}] LIVE: hostname={health.get('hostname')} platform={health.get('platform')} gpus={gpu_count}")
    else:
        print(f"  [{node}] DOWN")
