#!/usr/bin/env python3
"""Debug Razer specifically."""
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
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=22, username=user, password=password,
              timeout=30, allow_agent=False, look_for_keys=False)
    return c


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


def write_remote(client, python_exe, path, content):
    b64 = base64.b64encode(content.encode()).decode()
    out, err, rc = runcmd(client,
        f'"{python_exe}" -c "import base64; open(r\'{path}\', \'wb\').write(base64.b64decode(\'{b64}\'))"',
        20)
    return rc == 0


host = "100.102.215.75"
user = "claude"
password = "Pb26116467"
python_exe = r"C:\Python311\python.exe"
pythonw_exe = r"C:\Python311\pythonw.exe"
script_path = r"C:\Users\claude\node_api_server.py"
log_path = r"C:\Users\claude\node_api_debug.log"
task_name = "NodeAPI8765"

c = connect(host, user, password)

# Check logged-on users
print("=== Razer Debug ===")
out, _, _ = runcmd(c, "query user 2>&1", 15)
print(f"Logged on users:\n{out}")

# Check task details
out, _, _ = runcmd(c, f'schtasks /query /tn "{task_name}" /fo list /v 2>&1', 15)
print(f"\nTask details:\n{out[:600]}")

# Check task history
out, _, _ = runcmd(c, f'schtasks /query /tn "{task_name}" /fo list 2>&1', 15)
print(f"\nTask status: {out[:200]}")

# Write a test script that explicitly logs to file
test_content = f"""import sys, os, socket, time
with open(r'{log_path}', 'w') as f:
    f.write('Script started\\n')
    f.flush()

    # Test socket binding
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('0.0.0.0', {PORT}))
        s.listen(5)
        f.write(f'Socket bound OK to 0.0.0.0:{PORT}\\n')
        f.flush()
        s.close()
    except Exception as e:
        f.write(f'Socket bind failed: {{e}}\\n')
        f.flush()

    f.write('Done\\n')
    f.flush()
print('DONE')
"""
test_path = r"C:\Users\claude\test_socket.py"
write_remote(c, python_exe, test_path, test_content)

# Run test synchronously
out, err, rc = runcmd(c, f'"{python_exe}" "{test_path}"', 15)
print(f"\nSocket test rc={rc} out={out} err={err}")

# Read the log
log_out, _, _ = runcmd(c, f'type "{log_path}" 2>&1', 10)
print(f"Socket test log:\n{log_out}")

# Check current python processes on Razer
out, _, _ = runcmd(c, "tasklist /FI \"IMAGENAME eq python.exe\" /FO CSV 2>&1", 15)
print(f"\nPython procs: {out[:200]}")
out2, _, _ = runcmd(c, "tasklist /FI \"IMAGENAME eq pythonw.exe\" /FO CSV 2>&1", 15)
print(f"Pythonw procs: {out2[:200]}")

# Check netstat for port 8765
ns, _, _ = runcmd(c, f"netstat -ano | findstr :{PORT}", 15)
print(f"netstat {PORT}: {ns or '(nothing)'}")

c.close()

# Now try the actual deployment - but first check if Razer has a user logged in
# If "Interactive only" means no interactive session = task won't run
# Solution: change to /ru SYSTEM but with proper network access

c2 = connect(host, user, password)

# Delete old task
runcmd(c2, f'schtasks /delete /tn "{task_name}" /f 2>nul', 10)

# Create bat with fresh log
bat_content = f"""@echo off
echo Starting at %date% %time% > "{log_path}"
set NODE_API_KEY={API_KEY}
set NODE_API_PORT={PORT}
echo Env set >> "{log_path}"
"{pythonw_exe}" "{script_path}" >> "{log_path}" 2>&1
echo Exited with %errorlevel% >> "{log_path}"
"""
bat_path = r"C:\Users\claude\run_api.bat"
write_remote(c2, python_exe, bat_path, bat_content)
print(f"\nBat written to {bat_path}")

# Try creating task with /ru SYSTEM /sc onstart
# SYSTEM can bind to all interfaces
create_sys = (
    f'schtasks /create /f /tn "{task_name}" '
    f'/tr "\\"{bat_path}\\"" '
    f'/sc once /st 00:00 '
    f'/ru SYSTEM 2>&1'
)
out, err, rc = runcmd(c2, create_sys, 20)
print(f"Create SYSTEM task: rc={rc} {out[:100]}")

out2, err2, rc2 = runcmd(c2, f'schtasks /run /tn "{task_name}" 2>&1', 15)
print(f"Run task: rc={rc2} {out2[:100]}")
c2.close()

time.sleep(8)

# Check
c3 = connect(host, user, password)
ns, _, _ = runcmd(c3, f"netstat -ano | findstr :{PORT}", 15)
print(f"netstat after SYSTEM task: {ns or '(nothing)'}")

log_out, _, _ = runcmd(c3, f'type "{log_path}" 2>&1', 10)
print(f"Log:\n{log_out}")

# Check health
c3.close()
health = check_health(host, PORT)
if health:
    print(f"\nSUCCESS: Razer API LIVE | hostname={health.get('hostname')}")
else:
    print("\nStill failed")
    # Try direct nssm / sc.exe approach
    c4 = connect(host, user, password)
    # Check if sc.exe can create a service (needs SYSTEM-level)
    # Actually use nssm if available
    nssm_check, _, _ = runcmd(c4, "where nssm 2>&1", 10)
    print(f"nssm: {nssm_check}")
    c4.close()
