#!/usr/bin/env python3
"""Debug why node_api_server.py isn't staying up on Windows nodes."""
import warnings
warnings.filterwarnings('ignore')
import paramiko
import time
import base64

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


API_KEY = "qcc_node_api_2026"
PORT = 8765

for node_name, host, user, pwd, python_exe, script_path in [
    ("razer", "100.102.215.75", "claude", "Pb26116467",
     r"C:\Python311\python.exe",
     r"C:\Users\claude\node_api_server.py"),
    ("uranus", "100.100.83.37", "nick", "Pb26116467",
     r"C:\Users\Nick\AppData\Local\Programs\Python\Python311\python.exe",
     r"C:\Users\nick\node_api_server.py"),
]:
    print(f"\n=== DEBUG {node_name.upper()} ===")
    c = connect(host, user, pwd)
    log_path = script_path.replace("node_api_server.py", "node_api_new.log")

    # Write a fresh log file, run the server synchronously for 5 seconds to capture output
    # Use a wrapper that captures startup errors
    debug_launcher = f"""import subprocess, os, sys, time
env = dict(os.environ)
env['NODE_API_KEY'] = '{API_KEY}'
env['NODE_API_PORT'] = '{PORT}'
log = open(r'{log_path}', 'w', buffering=1)
log.write('Starting server...\\n')
log.flush()
try:
    p = subprocess.Popen(
        [r'{python_exe}', r'{script_path}'],
        env=env, stdout=log, stderr=log,
        creationflags=0x00000008|0x00000200|0x08000000,
        close_fds=True
    )
    log.write(f'PID={{p.pid}}\\n')
    log.flush()
    time.sleep(3)
    rc = p.poll()
    log.write(f'Still running: {{rc is None}}\\n')
    log.flush()
except Exception as ex:
    log.write(f'ERROR: {{ex}}\\n')
    log.flush()
log.close()
"""

    b64 = base64.b64encode(debug_launcher.encode()).decode()
    launcher_path = script_path.replace("node_api_server.py", "debug_launcher.py")
    write_cmd = f'python -c "import base64; open(r\'{launcher_path}\', \'w\').write(base64.b64decode(\'{b64}\').decode())"'
    out, err, rc = runcmd(c, write_cmd, 20)
    print(f"  Write debug launcher rc={rc}" + (f" err={err[:100]}" if err else ""))

    # Kill any existing
    out_n, _, _ = runcmd(c, f"netstat -ano | findstr :{PORT}", 15)
    if out_n:
        for line in out_n.splitlines():
            parts = line.split()
            if parts and parts[-1].isdigit() and parts[-1] != '0':
                runcmd(c, f"taskkill /F /PID {parts[-1]} 2>nul", 10)

    # Run launcher synchronously and wait
    out, err, rc = runcmd(c, f'"{python_exe}" "{launcher_path}"', 20)
    print(f"  Debug launcher rc={rc} out={out} err={err[:200]}")

    # Wait a moment then read log
    time.sleep(5)
    log_content, _, _ = runcmd(c, f'type "{log_path}"', 20)
    print(f"  Debug log:\n{log_content}")

    # Check if still running
    netstat, _, _ = runcmd(c, f"netstat -ano | findstr :{PORT}", 15)
    print(f"  netstat: {netstat or '(nothing)'}")

    c.close()
