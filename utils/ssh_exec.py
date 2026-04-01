"""
ssh_exec.py — Pooled SSH command execution for remote servers.

IMPORTANT: ALL SSH access MUST go through this module. Never use raw paramiko.
The connection pool reuses connections to prevent sshd saturation.

Usage (CLI):
    python utils/ssh_exec.py "hostname && uptime"
    python utils/ssh_exec.py --server uranus "nvidia-smi"
    python utils/ssh_exec.py --server saturn "uptime"

Usage (Python):
    from utils.ssh_exec import run, run_on
    out = run('uranus', 'nvidia-smi')           # Returns stdout string
    result = run_on('jupiter', 'uptime')        # Returns dict with full details
"""

import warnings
warnings.filterwarnings('ignore')  # Suppress paramiko TripleDES deprecation

import argparse
import json
import os
import sys
import threading
import time

import paramiko

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

CONFIG_FILE = os.path.join(os.path.dirname(__file__), '..', 'config', 'remote_servers.json')

import warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)

# ── Connection Pool ──────────────────────────────────────────────
_pool = {}          # server_name -> paramiko.SSHClient
_pool_lock = threading.Lock()
MAX_CONNECTIONS_PER_SERVER = 2


def load_config():
    with open(CONFIG_FILE) as f:
        config = json.load(f)
    for name, server in config.get('servers', {}).items():
        if 'password_env' in server and 'password' not in server:
            server['password'] = os.environ.get(server['password_env'], '')
        elif 'password' not in server:
            env_key = f"{name.upper()}_PASS"
            server['password'] = os.environ.get(env_key, '')
    return config


def _is_alive(client):
    """Check if an SSH connection is still usable."""
    try:
        transport = client.get_transport()
        if transport is None or not transport.is_active():
            return False
        transport.send_ignore()
        return True
    except Exception:
        return False


def _resolve_key_path(key_file):
    """Expand ~ and resolve key file path."""
    if not key_file:
        return None
    expanded = os.path.expanduser(key_file)
    if os.path.exists(expanded):
        return expanded
    return None


def get_connection(server_name):
    """Get or create a pooled SSH connection to a named server."""
    with _pool_lock:
        if server_name in _pool and _is_alive(_pool[server_name]):
            return _pool[server_name]
        # Close stale connection if exists
        if server_name in _pool:
            try:
                _pool[server_name].close()
            except Exception:
                pass
            del _pool[server_name]

    config = load_config()
    server = config['servers'].get(server_name)
    if not server:
        raise ValueError(f"Unknown server: {server_name}. Available: {list(config['servers'].keys())}")

    # Handle jump host (e.g., Saturn via Jupiter)
    jump_host = server.get('jump_host')
    if jump_host:
        return _get_jump_connection(server_name, server, jump_host, config)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connect_kwargs = {
        'hostname': server['host'],
        'port': server.get('port', 22),
        'username': server.get('user') or server.get('username'),
        'timeout': 30,
        'banner_timeout': 30,
        'allow_agent': False,
        'look_for_keys': False,
    }

    # Try key-based auth first, fall back to password
    key_path = _resolve_key_path(server.get('key_file'))
    if key_path:
        try:
            connect_kwargs['key_filename'] = key_path
            client.connect(**connect_kwargs)
            with _pool_lock:
                _pool[server_name] = client
            return client
        except paramiko.ssh_exception.AuthenticationException:
            # Key rejected, try password
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            del connect_kwargs['key_filename']

    # Password auth
    if server.get('password'):
        connect_kwargs['password'] = server['password']

    client.connect(**connect_kwargs)

    with _pool_lock:
        _pool[server_name] = client
    return client


def _get_jump_connection(server_name, server, jump_host_name, config):
    """Connect to a server via a jump host (SSH tunneling)."""
    jump_client = get_connection(jump_host_name)
    jump_transport = jump_client.get_transport()

    dest_addr = (server['host'], server.get('port', 22))
    jump_config = config['servers'][jump_host_name]
    local_addr = (jump_config['host'], jump_config.get('port', 22))

    channel = jump_transport.open_channel('direct-tcpip', dest_addr, local_addr)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        server['host'],
        port=server.get('port', 22),
        username=server.get('user') or server.get('username'),
        password=server.get('password'),
        sock=channel,
        timeout=30,
        banner_timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )

    with _pool_lock:
        _pool[server_name] = client
    return client


def close_connection(server_name):
    """Explicitly close a pooled connection."""
    with _pool_lock:
        if server_name in _pool:
            try:
                _pool[server_name].close()
            except Exception:
                pass
            del _pool[server_name]


def close_all():
    """Close all pooled connections."""
    with _pool_lock:
        for name, client in _pool.items():
            try:
                client.close()
            except Exception:
                pass
        _pool.clear()


import atexit
atexit.register(close_all)


def ssh_exec(host, user, password, command, port=22, timeout=30):
    """Execute command via SSH, return (stdout, stderr, exit_code).
    Legacy API — creates a one-off connection. Prefer run() or run_on() instead.
    """
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


def run(server_name, command, timeout=60):
    """Execute command on a named server using the connection pool.
    Returns stdout as a string. Raises on failure.
    """
    client = get_connection(server_name)
    try:
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        if exit_code != 0:
            raise RuntimeError(f"[{server_name}] Command failed (exit {exit_code}): {err.strip()}")
        return out.strip()
    except (paramiko.SSHException, OSError):
        # Connection went stale mid-command, reconnect and retry once
        close_connection(server_name)
        client = get_connection(server_name)
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode('utf-8', errors='replace')
        return out.strip()


def run_on(server_name, command, timeout=60):
    """Execute command on a named server. Returns a result dict."""
    try:
        client = get_connection(server_name)
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        return {
            'success': exit_code == 0,
            'stdout': out.strip(),
            'stderr': err.strip(),
            'exit_code': exit_code,
            'server': server_name,
        }
    except Exception as e:
        close_connection(server_name)
        return {
            'success': False,
            'error': str(e),
            'server': server_name,
        }


def connect_jupiter(command, prefer='both', timeout=30):
    """Connect to Jupiter server and execute command. Legacy wrapper — prefer run_on('jupiter', cmd)."""
    return run_on('jupiter', command, timeout=timeout)


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
    parser = argparse.ArgumentParser(description='Pooled SSH execution for remote servers')
    parser.add_argument('command', type=str, help='Command to execute')
    parser.add_argument('--server', '-s', type=str, default='jupiter',
                        help='Server name (jupiter, uranus, saturn)')
    parser.add_argument('--timeout', type=int, default=60, help='Timeout in seconds')
    args = parser.parse_args()

    result = run_on(args.server, args.command, timeout=args.timeout)

    if result['success']:
        print(f"[{args.server}]")
        if result['stdout']:
            sys.stdout.buffer.write(result['stdout'].encode('utf-8', errors='replace'))
            sys.stdout.buffer.flush()
        if result.get('stderr'):
            sys.stderr.buffer.write(result['stderr'].encode('utf-8', errors='replace'))
            sys.stderr.buffer.flush()
        sys.exit(result.get('exit_code', 0))
    else:
        print(f"FAILED [{args.server}]: {result.get('error', 'unknown')}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
