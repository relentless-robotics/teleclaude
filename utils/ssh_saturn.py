"""
ssh_saturn.py — SSH command execution for Saturn server.

Saturn: Dell PowerEdge R810, 48-core Xeon E7540, 62GB RAM, 199GB disk, Ubuntu 22.04
Local IP: YOUR_SATURN_IP (only reachable via Jupiter LAN hop)
Tailscale: TBD (NeedsLogin as of 2026-02-25)

Connection methods:
  1. Two-hop: PC -> Jupiter (YOUR_JUPITER_LAN_IP) -> Saturn (YOUR_SATURN_IP)  [PRIMARY]
  2. Direct Tailscale: PC -> Saturn (tailscale IP)                 [when auth approved]

Usage:
    python utils/ssh_saturn.py "hostname; uname -a; free -h; df -h; nproc"
    python utils/ssh_saturn.py --tailscale 100.x.x.x "hostname"
    python utils/ssh_saturn.py --via-jupiter "ls ~/lvl3quant/"
"""

import sys
import warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)

import paramiko

# ── Server constants ──────────────────────────────────────────────────────────

JUPITER_HOST = 'YOUR_JUPITER_LAN_IP'
JUPITER_USER = 'jupiter'
JUPITER_PASS = 'YOUR_SERVER_PASSWORD'

SATURN_HOST  = 'YOUR_SATURN_IP'
SATURN_USER  = 'saturn'
SATURN_PASS  = 'YOUR_SERVER_PASSWORD'

# Set once Tailscale auth is approved:
SATURN_TAILSCALE_IP = None  # e.g. '100.x.x.x'


# ── Core two-hop connection ───────────────────────────────────────────────────

def run_on_saturn(command, timeout=30):
    """Execute command on Saturn server via Jupiter hop (PC -> Jupiter -> Saturn).

    Returns (output, error) as strings.
    Raises on connection failure.
    """
    # Connect to Jupiter
    jump = paramiko.SSHClient()
    jump.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    jump.connect(
        JUPITER_HOST,
        username=JUPITER_USER,
        password=JUPITER_PASS,
        timeout=10,
        allow_agent=False,
        look_for_keys=False,
    )

    try:
        # Open tunnel through Jupiter to Saturn
        jump_transport = jump.get_transport()
        jump_channel = jump_transport.open_channel(
            'direct-tcpip',
            (SATURN_HOST, 22),
            (JUPITER_HOST, 0),
        )

        # Connect to Saturn through the tunnel
        saturn = paramiko.SSHClient()
        saturn.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        saturn.connect(
            SATURN_HOST,
            username=SATURN_USER,
            password=SATURN_PASS,
            sock=jump_channel,
            timeout=timeout,
        )

        try:
            stdin, stdout, stderr = saturn.exec_command(command, timeout=timeout)
            output = stdout.read().decode('utf-8', errors='replace')
            error  = stderr.read().decode('utf-8', errors='replace')
            return output, error
        finally:
            saturn.close()
    finally:
        jump.close()


def run_on_saturn_via_jupiter_ssh(command, timeout=120):
    """Execute command on Saturn by having Jupiter SSH into Saturn natively.

    Useful for long-running commands (apt, builds) where paramiko two-hop
    may time out on stdout.read(). Jupiter has a fast LAN link to Saturn.

    Returns (output, error, exit_code).
    """
    jump = paramiko.SSHClient()
    jump.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    jump.connect(
        JUPITER_HOST,
        username=JUPITER_USER,
        password=JUPITER_PASS,
        timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    try:
        # Jupiter runs: ssh saturn@YOUR_SATURN_IP '<command>'
        wrapped = (
            f"ssh -o StrictHostKeyChecking=no "
            f"{SATURN_USER}@{SATURN_HOST} {_shell_quote(command)}"
        )
        stdin, stdout, stderr = jump.exec_command(wrapped, timeout=timeout)
        out  = stdout.read().decode('utf-8', errors='replace')
        err  = stderr.read().decode('utf-8', errors='replace')
        code = stdout.channel.recv_exit_status()
        return out, err, code
    finally:
        jump.close()


def _shell_quote(cmd):
    """Wrap command in single quotes, escaping any single quotes inside."""
    return "'" + cmd.replace("'", "'\\''") + "'"


# ── Direct Tailscale connection ───────────────────────────────────────────────

def run_on_saturn_direct(command, tailscale_ip=None, timeout=30):
    """Execute command on Saturn via Tailscale (direct, no hop).

    Requires Tailscale to be authenticated on Saturn.
    If tailscale_ip is None, falls back to SATURN_TAILSCALE_IP constant.
    """
    ip = tailscale_ip or SATURN_TAILSCALE_IP
    if not ip:
        raise ValueError(
            "Saturn Tailscale IP not set. Pass tailscale_ip= or update "
            "SATURN_TAILSCALE_IP in utils/ssh_saturn.py once auth is approved."
        )
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(ip, username=SATURN_USER, password=SATURN_PASS, timeout=timeout)
    try:
        stdin, stdout, stderr = ssh.exec_command(command, timeout=timeout)
        output = stdout.read().decode('utf-8', errors='replace')
        error  = stderr.read().decode('utf-8', errors='replace')
        return output, error
    finally:
        ssh.close()


# ── Sudo helper ───────────────────────────────────────────────────────────────

def run_sudo_on_saturn(command, timeout=60):
    """Run a sudo command on Saturn (saturn has NOPASSWD sudo configured)."""
    return run_on_saturn(f'sudo {command}', timeout=timeout)


# ── SFTP helpers ──────────────────────────────────────────────────────────────

def upload_to_saturn(local_path, remote_path):
    """Upload a file to Saturn via SFTP through Jupiter tunnel."""
    jump = paramiko.SSHClient()
    jump.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    jump.connect(
        JUPITER_HOST,
        username=JUPITER_USER,
        password=JUPITER_PASS,
        timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    try:
        jt = jump.get_transport()
        jc = jt.open_channel('direct-tcpip', (SATURN_HOST, 22), (JUPITER_HOST, 0))
        saturn = paramiko.SSHClient()
        saturn.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        saturn.connect(SATURN_HOST, username=SATURN_USER, password=SATURN_PASS, sock=jc, timeout=15)
        try:
            sftp = saturn.open_sftp()
            sftp.put(local_path, remote_path)
            sftp.close()
            return {'success': True, 'local': local_path, 'remote': remote_path}
        finally:
            saturn.close()
    finally:
        jump.close()


def download_from_saturn(remote_path, local_path):
    """Download a file from Saturn via SFTP through Jupiter tunnel."""
    jump = paramiko.SSHClient()
    jump.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    jump.connect(
        JUPITER_HOST,
        username=JUPITER_USER,
        password=JUPITER_PASS,
        timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    try:
        jt = jump.get_transport()
        jc = jt.open_channel('direct-tcpip', (SATURN_HOST, 22), (JUPITER_HOST, 0))
        saturn = paramiko.SSHClient()
        saturn.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        saturn.connect(SATURN_HOST, username=SATURN_USER, password=SATURN_PASS, sock=jc, timeout=15)
        try:
            sftp = saturn.open_sftp()
            sftp.get(remote_path, local_path)
            sftp.close()
            return {'success': True, 'remote': remote_path, 'local': local_path}
        finally:
            saturn.close()
    finally:
        jump.close()


# ── Tailscale auth helper ─────────────────────────────────────────────────────

def get_tailscale_status():
    """Check Tailscale status on Saturn. Returns dict with status and IP if available."""
    out, err = run_on_saturn('tailscale status 2>&1; tailscale ip 2>&1')
    lines = out.strip().splitlines()
    ip = None
    authenticated = False
    auth_url = None

    for line in lines:
        if line.startswith('100.'):
            ip = line.strip()
            authenticated = True
        if 'login.tailscale.com' in line:
            # Extract URL
            parts = line.split()
            for p in parts:
                if p.startswith('https://'):
                    auth_url = p

    return {
        'authenticated': authenticated,
        'ip': ip,
        'auth_url': auth_url,
        'raw': out,
    }


# ── CLI entry point ───────────────────────────────────────────────────────────

if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(
        description='Run commands on Saturn server via Jupiter hop or Tailscale direct'
    )
    parser.add_argument('command', nargs='*', help='Command to run on Saturn')
    parser.add_argument('--tailscale', metavar='IP', help='Use Tailscale direct (provide IP)')
    parser.add_argument('--via-jupiter', action='store_true', help='Use Jupiter native SSH relay (better for long commands)')
    parser.add_argument('--tailscale-status', action='store_true', help='Check Tailscale status on Saturn')
    parser.add_argument('--timeout', type=int, default=30, help='Timeout in seconds (default 30)')
    args = parser.parse_args()

    if args.tailscale_status:
        status = get_tailscale_status()
        if status['authenticated']:
            print(f"Tailscale: AUTHENTICATED  IP: {status['ip']}")
        else:
            print(f"Tailscale: NOT authenticated")
            if status['auth_url']:
                print(f"Auth URL: {status['auth_url']}")
        sys.exit(0)

    cmd = ' '.join(args.command) if args.command else 'hostname; uname -a; free -h; df -h; nproc'
    print(f"Running on Saturn: {cmd}")
    print(f"Method: {'Tailscale direct' if args.tailscale else 'Jupiter relay SSH' if args.via_jupiter else 'Two-hop paramiko'}")
    print()

    try:
        if args.tailscale:
            out, err = run_on_saturn_direct(cmd, tailscale_ip=args.tailscale, timeout=args.timeout)
            exit_code = 0
        elif args.via_jupiter:
            out, err, exit_code = run_on_saturn_via_jupiter_ssh(cmd, timeout=args.timeout)
        else:
            out, err = run_on_saturn(cmd, timeout=args.timeout)
            exit_code = 0

        if out:
            print(out, end='')
        if err:
            print(f"STDERR: {err}", end='', file=sys.stderr)
        sys.exit(exit_code)

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
