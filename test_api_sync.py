#!/usr/bin/env python3
"""Run API server synchronously on Windows nodes to capture crash output."""
import warnings
warnings.filterwarnings('ignore')
import paramiko
import time

API_KEY = "qcc_node_api_2026"
PORT = 8765


def connect(host, user, password):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=22, username=user, password=password,
                   timeout=30, allow_agent=False, look_for_keys=False)
    return client


# Test on Razer - run synchronously with 15s timeout to capture output
print("=== RAZER SYNC TEST ===")
c = connect("100.102.215.75", "claude", "Pb26116467")

# Run server synchronously for 10 seconds
cmd = (
    r'set "NODE_API_KEY=qcc_node_api_2026" && '
    r'set "NODE_API_PORT=8765" && '
    r'"C:\Python311\python.exe" "C:\Users\claude\node_api_server.py"'
)
stdin, stdout, stderr = c.exec_command(cmd, timeout=12)
# Read output as it comes
out = stdout.read().decode('utf-8', errors='replace').strip()
err = stderr.read().decode('utf-8', errors='replace').strip()
rc = stdout.channel.recv_exit_status()
print(f"rc={rc}")
print(f"stdout:\n{out}")
print(f"stderr:\n{err}")
c.close()
