#!/usr/bin/env python3
"""
deploy_saturn_jobs.py — Upload and launch Saturn research jobs.

Uploads tod_deep_analysis.py and queue_tpsl_sweep.py to Saturn
via ProxyJump through Jupiter, then launches them in tmux sessions.

Uses config from remote_servers.json for credentials.
"""
import warnings
warnings.filterwarnings('ignore')

import json, os, sys, time, base64
import paramiko

# ── Config ────────────────────────────────────────────────────────────────────
CONFIG_FILE = os.path.join(os.path.dirname(__file__), '..', 'config', 'remote_servers.json')
SCRIPTS_DIR = os.path.dirname(__file__)

with open(CONFIG_FILE) as f:
    config = json.load(f)

JUPITER = config['servers']['jupiter']
SATURN  = config['servers']['saturn']


def log(msg):
    t = time.strftime("%H:%M:%S")
    print("[%s] %s" % (t, msg), flush=True)


def connect_jupiter():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        JUPITER['host'], port=JUPITER.get('port', 22),
        username=JUPITER['user'], password=JUPITER['password'],
        timeout=30, allow_agent=False, look_for_keys=False
    )
    return c


def connect_saturn_via_jupiter(jc):
    """Connect to Saturn using Jupiter as jump host."""
    sat_host = SATURN['host']
    sat_port = SATURN.get('port', 22)

    # Open a forwarding channel through Jupiter
    transport = jc.get_transport()
    dest_addr  = (sat_host, sat_port)
    local_addr = ('127.0.0.1', 0)
    channel = transport.open_channel("direct-tcpip", dest_addr, local_addr)

    sc = paramiko.SSHClient()
    sc.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    sc.connect(
        sat_host, port=sat_port,
        username=SATURN['user'], password=SATURN['password'],
        timeout=30, allow_agent=False, look_for_keys=False,
        sock=channel
    )
    return sc


def run(client, cmd, timeout=30):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err, exit_code


def upload_file(client, local_path, remote_path):
    """Upload file via SFTP."""
    sftp = client.open_sftp()
    try:
        # Ensure remote dir exists
        remote_dir = '/'.join(remote_path.split('/')[:-1])
        try:
            sftp.mkdir(remote_dir)
        except Exception:
            pass  # already exists

        sftp.put(local_path, remote_path)
        log("  Uploaded: %s -> %s" % (os.path.basename(local_path), remote_path))
    finally:
        sftp.close()


def main():
    log("=== Saturn Deployment ===")

    # Connect Jupiter
    log("Connecting to Jupiter...")
    jc = connect_jupiter()
    log("Jupiter connected.")

    # Quick Jupiter verification
    out, err, code = run(jc, 'echo JUPITER_OK && nproc')
    log("Jupiter: %s" % out)

    # Connect Saturn via Jupiter
    log("Connecting to Saturn via Jupiter...")
    sc = connect_saturn_via_jupiter(jc)
    log("Saturn connected.")

    out, err, code = run(sc, 'echo SATURN_OK && nproc && free -h | grep Mem | head -1')
    log("Saturn: %s" % out)

    # Data probe on Saturn
    out, err, code = run(sc, 'ls /home/saturn/Lvl3Quant/data/processed/ 2>/dev/null | head -20')
    log("Saturn data/processed:\n%s" % out[:400])

    # Create remote directories
    dirs = [
        '/home/saturn/Lvl3Quant/scripts',
        '/home/saturn/Lvl3Quant/data/processed/tod_deep_analysis',
        '/home/saturn/Lvl3Quant/data/processed/queue_tpsl_sweep',
        '/home/saturn/Lvl3Quant/logs',
    ]
    run(sc, 'mkdir -p ' + ' '.join(dirs))
    log("Remote dirs created.")

    # Upload scripts
    scripts = [
        (os.path.join(SCRIPTS_DIR, 'tod_deep_analysis.py'),
         '/home/saturn/Lvl3Quant/scripts/tod_deep_analysis.py'),
        (os.path.join(SCRIPTS_DIR, 'queue_tpsl_sweep.py'),
         '/home/saturn/Lvl3Quant/scripts/queue_tpsl_sweep.py'),
    ]

    for local_path, remote_path in scripts:
        if not os.path.exists(local_path):
            log("ERROR: Local script not found: %s" % local_path)
            sys.exit(1)
        upload_file(sc, local_path, remote_path)

    # Verify uploads
    out, err, code = run(sc, 'ls -la /home/saturn/Lvl3Quant/scripts/*.py')
    log("Verify scripts: %s" % out)

    # Kill stale tmux sessions
    run(sc, 'tmux kill-session -t tod_deep 2>/dev/null; true')
    run(sc, 'tmux kill-session -t queue_tpsl 2>/dev/null; true')

    # Launch ToD analysis
    launch_tod = (
        'tmux new-session -d -s tod_deep '
        '"cd /home/saturn/Lvl3Quant && python3 scripts/tod_deep_analysis.py '
        '2>&1 | tee logs/tod_deep_analysis.log; echo EXIT:$?" && echo LAUNCHED_TOD'
    )
    out, err, code = run(sc, launch_tod, timeout=15)
    log("ToD launch: %s (exit=%d)" % (out, code))
    if err:
        log("  stderr: %s" % err[:100])

    # Launch queue_tpsl sweep
    launch_qt = (
        'tmux new-session -d -s queue_tpsl '
        '"cd /home/saturn/Lvl3Quant && python3 scripts/queue_tpsl_sweep.py '
        '2>&1 | tee logs/queue_tpsl_sweep.log; echo EXIT:$?" && echo LAUNCHED_QTPSL'
    )
    out, err, code = run(sc, launch_qt, timeout=15)
    log("Queue sweep launch: %s (exit=%d)" % (out, code))
    if err:
        log("  stderr: %s" % err[:100])

    # Wait for initial output
    log("Waiting 10s for initial output...")
    time.sleep(10)

    out, err, code = run(sc, 'tail -15 /home/saturn/Lvl3Quant/logs/tod_deep_analysis.log 2>/dev/null || echo "(no output)"')
    log("\n[Saturn] tod_deep_analysis.log:\n%s" % out)

    out, err, code = run(sc, 'tail -15 /home/saturn/Lvl3Quant/logs/queue_tpsl_sweep.log 2>/dev/null || echo "(no output)"')
    log("\n[Saturn] queue_tpsl_sweep.log:\n%s" % out)

    out, err, code = run(sc, 'tmux ls 2>/dev/null || echo "no sessions"')
    log("Saturn tmux sessions: %s" % out)

    sc.close()
    jc.close()
    log("=== Saturn deployment complete ===")
    log("Monitor:")
    log("  tod:  tail -f /home/saturn/Lvl3Quant/logs/tod_deep_analysis.log")
    log("  queue: tail -f /home/saturn/Lvl3Quant/logs/queue_tpsl_sweep.log")
    log("Results:")
    log("  /home/saturn/Lvl3Quant/data/processed/tod_deep_analysis/tod_deep_summary.json")
    log("  /home/saturn/Lvl3Quant/data/processed/queue_tpsl_sweep/queue_tpsl_sweep_summary.json")


if __name__ == '__main__':
    main()
