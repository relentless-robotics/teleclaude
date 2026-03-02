"""
ssh_exec.py — Non-interactive SSH command execution for Jupiter server.

Usage:
    python utils/ssh_exec.py "hostname && uptime"
    python utils/ssh_exec.py --tailscale "ls -la ~/lvl3quant"
    python utils/ssh_exec.py --both "hostname"  # Try both, use first that works
"""

import argparse
import json
import os
import sys

import paramiko


CONFIG_FILE = os.path.join(os.path.dirname(__file__), '..', 'config', 'remote_servers.json')

# Suppress CryptographyDeprecationWarning
import warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)


def load_config():
    with open(CONFIG_FILE) as f:
        return json.load(f)


def ssh_exec(host, user, password, command, port=22, timeout=30):
    """Execute command via SSH, return (stdout, stderr, exit_code)."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(host, port=port, username=user, password=password,
                       timeout=timeout, allow_agent=False, look_for_keys=False)
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        return out, err, exit_code
    finally:
        client.close()


def connect_jupiter(command, prefer='both', timeout=30):
    """Connect to Jupiter server and execute command.

    prefer: 'tailscale', 'ethernet', or 'both' (try both, use first that works)
    """
    config = load_config()
    server = config['servers']['jupiter']
    user = server['username']
    password = server['password']

    hosts = []
    # Prefer Ethernet (direct LAN, <1ms) over Tailscale (3ms, goes through relay)
    if prefer in ('both', 'ethernet'):
        hosts.append(('ethernet', server['host']))
    if prefer in ('both', 'tailscale'):
        hosts.append(('tailscale', server['host_tailscale']))

    last_error = None
    for name, host in hosts:
        try:
            out, err, code = ssh_exec(host, user, password, command, timeout=timeout)
            return {
                'success': True,
                'connection': name,
                'host': host,
                'stdout': out,
                'stderr': err,
                'exit_code': code,
            }
        except Exception as e:
            last_error = f"{name} ({host}): {e}"
            continue

    return {
        'success': False,
        'error': last_error,
    }


def sftp_upload(local_path, remote_path, prefer='both'):
    """Upload a file to Jupiter server via SFTP."""
    config = load_config()
    server = config['servers']['jupiter']
    user = server['username']
    password = server['password']

    hosts = []
    if prefer in ('both', 'ethernet'):
        hosts.append(('ethernet', server['host']))
    if prefer in ('both', 'tailscale'):
        hosts.append(('tailscale', server['host_tailscale']))

    for name, host in hosts:
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(host, port=22, username=user, password=password,
                           timeout=10, allow_agent=False, look_for_keys=False)
            sftp = client.open_sftp()
            sftp.put(local_path, remote_path)
            sftp.close()
            client.close()
            return {'success': True, 'connection': name, 'host': host}
        except Exception as e:
            continue
    return {'success': False}


def sftp_download(remote_path, local_path, prefer='both'):
    """Download a file from Jupiter server via SFTP."""
    config = load_config()
    server = config['servers']['jupiter']
    user = server['username']
    password = server['password']

    hosts = []
    if prefer in ('both', 'ethernet'):
        hosts.append(('ethernet', server['host']))
    if prefer in ('both', 'tailscale'):
        hosts.append(('tailscale', server['host_tailscale']))

    for name, host in hosts:
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(host, port=22, username=user, password=password,
                           timeout=10, allow_agent=False, look_for_keys=False)
            sftp = client.open_sftp()
            sftp.get(remote_path, local_path)
            sftp.close()
            client.close()
            return {'success': True, 'connection': name, 'host': host}
        except Exception as e:
            continue
    return {'success': False}


def main():
    parser = argparse.ArgumentParser(description='SSH command execution for Jupiter server')
    parser.add_argument('command', type=str, help='Command to execute on server')
    parser.add_argument('--tailscale', action='store_true', help='Use Tailscale IP only')
    parser.add_argument('--ethernet', action='store_true', help='Use Ethernet IP only')
    parser.add_argument('--both', action='store_true', default=True, help='Try both (default)')
    parser.add_argument('--timeout', type=int, default=30, help='Timeout in seconds')
    args = parser.parse_args()

    prefer = 'both'
    if args.tailscale:
        prefer = 'tailscale'
    elif args.ethernet:
        prefer = 'ethernet'

    result = connect_jupiter(args.command, prefer=prefer, timeout=args.timeout)

    if result['success']:
        print(f"[Connected via {result['connection']} @ {result['host']}]")
        if result['stdout']:
            print(result['stdout'], end='')
        if result['stderr']:
            print(result['stderr'], end='', file=sys.stderr)
        sys.exit(result['exit_code'])
    else:
        print(f"FAILED: {result['error']}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
