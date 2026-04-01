"""
Sync book_tensors.npz files from Neptune (local) to Uranus, Jupiter, Saturn.
Only transfers missing files. Reports per-node status.
"""

import os
import sys
import time
import paramiko
import stat
from pathlib import Path

# Local Neptune source
NEPTUNE_SOURCE = r"C:\Users\Footb\Documents\Github\Lvl3Quant\data\processed\dl_book_cache"

# Get all local files
local_files = sorted(f for f in os.listdir(NEPTUNE_SOURCE) if f.endswith("_book_tensors.npz"))
print(f"[Neptune] Source files: {len(local_files)} ({local_files[0]} to {local_files[-1]})")

NODES = [
    {
        "name": "Uranus",
        "host": "100.100.83.37",
        "user": "nick",
        "password": "Pb26116467",
        "remote_path": r"C:\Users\Nick\Documents\Lvl3Quant\data\processed\dl_book_cache",
        "is_windows": True,
    },
    {
        "name": "Jupiter",
        "host": "192.168.0.108",
        "user": "jupiter",
        "password": "Pb26116467",
        "remote_paths": [
            "/home/jupiter/Lvl3Quant/data/processed/dl_book_cache",
            "/home/jupiter/Lvl3Quant/data/processed/dl_book_cache_oot",
        ],
        "is_windows": False,
    },
    {
        "name": "Saturn",
        "host": "192.168.0.108",  # Connect via Jupiter hop
        "user": "jupiter",
        "password": "Pb26116467",
        "jump_host": True,
        "saturn_host": "10.0.0.2",
        "saturn_user": "saturn",
        "saturn_password": "Pb26116467",
        "remote_path": "/home/saturn/Lvl3Quant/data/processed/dl_book_cache",
        "is_windows": False,
    },
]


def connect_ssh(host, user, password, port=22, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=port, username=user, password=password, timeout=timeout)
    return client


def list_remote_files_linux(client, path):
    """List .npz files on a Linux remote."""
    stdin, stdout, stderr = client.exec_command(f'ls "{path}" 2>/dev/null | grep book_tensors.npz | sort')
    files = [line.strip() for line in stdout.readlines() if line.strip()]
    err = stderr.read().decode().strip()
    return files, err


def list_remote_files_windows(client, path):
    """List .npz files on a Windows remote via SSH."""
    # Use PowerShell to list files
    cmd = f'powershell -Command "Get-ChildItem -Path \\"{path}\\" -Filter *book_tensors.npz | Select-Object -ExpandProperty Name | Sort-Object"'
    stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
    stdout.channel.settimeout(30)
    files = [line.strip() for line in stdout.readlines() if line.strip().endswith('.npz')]
    err = stderr.read().decode().strip()
    return files, err


def ensure_remote_dir_linux(client, path):
    client.exec_command(f'mkdir -p "{path}"')
    time.sleep(0.5)


def ensure_remote_dir_windows(client, path):
    cmd = f'powershell -Command "New-Item -ItemType Directory -Force -Path \\"{path}\\" | Out-Null"'
    client.exec_command(cmd)
    time.sleep(0.5)


def transfer_files(sftp, local_dir, remote_dir, missing_files, is_windows=False, sep="/"):
    transferred = 0
    failed = 0
    for i, fname in enumerate(missing_files):
        local_path = os.path.join(local_dir, fname)
        if is_windows:
            remote_path = remote_dir.rstrip("\\") + "\\" + fname
        else:
            remote_path = remote_dir.rstrip("/") + "/" + fname
        try:
            sftp.put(local_path, remote_path)
            transferred += 1
            if (i + 1) % 10 == 0 or i == 0:
                print(f"  [{i+1}/{len(missing_files)}] Transferred {fname}")
        except Exception as e:
            print(f"  ERROR transferring {fname}: {e}")
            failed += 1
    return transferred, failed


def sync_node_linux(node):
    name = node["name"]
    host = node["host"]
    user = node["user"]
    password = node["password"]
    is_jump = node.get("jump_host", False)

    print(f"\n{'='*60}")
    print(f"Syncing to {name}...")

    try:
        if is_jump:
            # Connect to Jupiter first, then tunnel to Saturn
            print(f"  Connecting via Jupiter hop ({host})...")
            jump_client = connect_ssh(host, user, password)
            transport = jump_client.get_transport()
            saturn_host = node["saturn_host"]
            saturn_user = node["saturn_user"]
            saturn_password = node["saturn_password"]
            dest_addr = (saturn_host, 22)
            local_addr = ('127.0.0.1', 0)
            channel = transport.open_channel("direct-tcpip", dest_addr, local_addr)
            saturn_client = paramiko.SSHClient()
            saturn_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            saturn_client.connect(saturn_host, username=saturn_user, password=saturn_password,
                                  sock=channel, timeout=30)
            client = saturn_client
            remote_path = node["remote_path"]
        else:
            client = connect_ssh(host, user, password)
            remote_path = node["remote_path"]

        print(f"  Connected. Checking remote path: {remote_path}")
        ensure_remote_dir_linux(client, remote_path)
        remote_files, err = list_remote_files_linux(client, remote_path)
        before_count = len(remote_files)
        print(f"  Remote files before: {before_count}")

        remote_set = set(remote_files)
        local_set = set(local_files)
        missing = sorted(local_set - remote_set)
        print(f"  Missing files: {len(missing)}")

        if missing:
            sftp = client.open_sftp()
            transferred, failed = transfer_files(sftp, NEPTUNE_SOURCE, remote_path, missing)
            sftp.close()
        else:
            transferred, failed = 0, 0
            print("  Already up to date!")

        # Verify
        remote_files_after, _ = list_remote_files_linux(client, remote_path)
        after_count = len(remote_files_after)
        print(f"  Files after: {after_count} | Transferred: {transferred} | Failed: {failed}")
        client.close()
        if is_jump:
            jump_client.close()
        return {"node": name, "before": before_count, "transferred": transferred, "after": after_count, "failed": failed, "status": "OK"}
    except Exception as e:
        print(f"  ERROR on {name}: {e}")
        return {"node": name, "before": "?", "transferred": 0, "after": "?", "failed": 0, "status": f"ERROR: {e}"}


def sync_node_windows(node):
    name = node["name"]
    host = node["host"]
    user = node["user"]
    password = node["password"]
    remote_path = node["remote_path"]

    print(f"\n{'='*60}")
    print(f"Syncing to {name} (Windows)...")

    try:
        client = connect_ssh(host, user, password)
        print(f"  Connected. Checking remote path: {remote_path}")
        ensure_remote_dir_windows(client, remote_path)
        remote_files, err = list_remote_files_windows(client, remote_path)
        if err:
            print(f"  Warning: {err}")
        before_count = len(remote_files)
        print(f"  Remote files before: {before_count}")

        remote_set = set(remote_files)
        local_set = set(local_files)
        missing = sorted(local_set - remote_set)
        print(f"  Missing files: {len(missing)}")

        if missing:
            sftp = client.open_sftp()
            # On Windows SFTP, use forward slashes
            remote_sftp_path = remote_path.replace("\\", "/")
            # Ensure dir exists via SFTP
            try:
                sftp.stat(remote_sftp_path)
            except FileNotFoundError:
                sftp.mkdir(remote_sftp_path)
            transferred, failed = transfer_files(sftp, NEPTUNE_SOURCE, remote_sftp_path, missing, is_windows=False, sep="/")
            sftp.close()
        else:
            transferred, failed = 0, 0
            print("  Already up to date!")

        # Verify
        remote_files_after, _ = list_remote_files_windows(client, remote_path)
        after_count = len(remote_files_after)
        print(f"  Files after: {after_count} | Transferred: {transferred} | Failed: {failed}")
        client.close()
        return {"node": name, "before": before_count, "transferred": transferred, "after": after_count, "failed": failed, "status": "OK"}
    except Exception as e:
        print(f"  ERROR on {name}: {e}")
        return {"node": name, "before": "?", "transferred": 0, "after": "?", "failed": 0, "status": f"ERROR: {e}"}


def sync_jupiter(node):
    """Jupiter: try both candidate paths, use whichever exists or create primary."""
    name = node["name"]
    host = node["host"]
    user = node["user"]
    password = node["password"]
    candidate_paths = node["remote_paths"]

    print(f"\n{'='*60}")
    print(f"Syncing to {name} (Linux)...")

    try:
        client = connect_ssh(host, user, password)
        print(f"  Connected.")

        # Find which path exists
        chosen_path = None
        for p in candidate_paths:
            stdin, stdout, stderr = client.exec_command(f'test -d "{p}" && echo EXISTS || echo MISSING')
            result = stdout.read().decode().strip()
            print(f"  Path {p}: {result}")
            if result == "EXISTS":
                chosen_path = p
                break

        if chosen_path is None:
            # Create the primary path
            chosen_path = candidate_paths[0]
            print(f"  Neither path exists, creating: {chosen_path}")
            ensure_remote_dir_linux(client, chosen_path)

        remote_files, err = list_remote_files_linux(client, chosen_path)
        before_count = len(remote_files)
        print(f"  Using path: {chosen_path}")
        print(f"  Remote files before: {before_count}")

        remote_set = set(remote_files)
        local_set = set(local_files)
        missing = sorted(local_set - remote_set)
        print(f"  Missing files: {len(missing)}")

        if missing:
            sftp = client.open_sftp()
            transferred, failed = transfer_files(sftp, NEPTUNE_SOURCE, chosen_path, missing)
            sftp.close()
        else:
            transferred, failed = 0, 0
            print("  Already up to date!")

        remote_files_after, _ = list_remote_files_linux(client, chosen_path)
        after_count = len(remote_files_after)
        print(f"  Files after: {after_count} | Transferred: {transferred} | Failed: {failed}")
        client.close()
        return {"node": name, "path": chosen_path, "before": before_count, "transferred": transferred, "after": after_count, "failed": failed, "status": "OK"}
    except Exception as e:
        print(f"  ERROR on {name}: {e}")
        return {"node": name, "before": "?", "transferred": 0, "after": "?", "failed": 0, "status": f"ERROR: {e}"}


if __name__ == "__main__":
    results = []

    # Uranus (Windows)
    results.append(sync_node_windows(NODES[0]))

    # Jupiter (Linux, multi-path check)
    results.append(sync_jupiter(NODES[1]))

    # Saturn (Linux via Jupiter hop)
    results.append(sync_node_linux(NODES[2]))

    print("\n" + "="*60)
    print("SYNC SUMMARY")
    print("="*60)
    for r in results:
        path_info = f" [{r.get('path', '')}]" if r.get('path') else ""
        print(f"{r['node']}{path_info}: before={r['before']}, transferred={r['transferred']}, after={r['after']}, status={r['status']}")
