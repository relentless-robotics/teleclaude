#!/usr/bin/env python3
"""
Ray Cluster Startup — Starts the full Ray cluster across all nodes.

Architecture:
  - Jupiter (192.168.0.108) = HEAD node — runs Ray GCS, dashboard
  - Neptune (192.168.0.101) = Worker — Windows, RTX 3090 GPU
  - Saturn  (10.0.0.2)      = Worker — Linux, CPU only (via Jupiter SSH)
  - Uranus  (192.168.1.178)  = Worker — Windows, RTX 5090 GPU  [DIFF SUBNET]
  - Razer   (192.168.0.103)  = Worker — Windows, RTX 3070 GPU  [LAN]

Network topology:
  LAN (192.168.0.x): Jupiter, Neptune, Saturn (via Jupiter 10.0.0.1), Razer (Wi-Fi)
  Different subnet (192.168.1.x): Uranus (Ethernet)
  Tailscale (100.x.x.x): Neptune, Uranus, Razer (fallback)

  Razer is on the same 192.168.0.x LAN as Jupiter — direct connection works.
  Uranus is on 192.168.1.x (different subnet, cannot reach 192.168.0.x).
  Uranus requires Tailscale on Jupiter OR routing through Neptune.

  To enable Tailscale on Jupiter (needed for Uranus):
    ssh jupiter@192.168.0.108
    sudo tailscale up
    # Click the auth URL in your browser

Requirements:
  All nodes: Ray 2.54.1, Python 3.11.x
  Env vars: RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 (Windows nodes)
            RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor (all nodes)

Usage:
  python compute/ray_cluster_start.py              # Start full cluster
  python compute/ray_cluster_start.py --status      # Check cluster status
  python compute/ray_cluster_start.py --stop        # Stop all nodes
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

# ─── Configuration ──────────────────────────────────────────────────────────
RAY_HEAD_IP = '192.168.0.108'
RAY_HEAD_PORT = 6379
RAY_DASHBOARD_PORT = 8265
NODE_API_KEY = 'qcc_node_api_2026'
NODE_API_PORT = 8765

NODES = {
    'jupiter': {
        'role': 'head',
        'ip': '192.168.0.108',
        'os': 'linux',
        'ray_bin': '/home/jupiter/miniconda3/envs/ray311/bin/ray',
        'api_port': 8765,
        'gpu': 0,
        'resources': {},
    },
    'neptune': {
        'role': 'worker',
        'ip': 'localhost',  # This machine
        'os': 'windows',
        'ray_bin': 'python -m ray.scripts.scripts',
        'api_port': None,  # Local
        'gpu': 1,
        'resources': {'GPU_RTX3090': 1},
    },
    'saturn': {
        'role': 'worker',
        'ip': '10.0.0.2',
        'os': 'linux',
        'ray_bin': '/home/saturn/miniconda3/envs/ray311/bin/ray',
        'api_port': None,  # Via Jupiter SSH
        'gpu': 0,
        'resources': {},
        'ssh_via': 'jupiter',  # Hop through Jupiter
        'ssh_user': 'saturn',
    },
    'uranus': {
        'role': 'worker',
        'ip': '192.168.1.178',       # LAN IP (different subnet from Jupiter)
        'ip_tailscale': '100.100.83.37',  # Tailscale fallback
        'os': 'windows',
        'ray_bin': 'python -m ray.scripts.scripts',
        'api_port': 8765,
        'api_ip': '100.100.83.37',   # Flask API reachable via Tailscale
        'gpu': 1,
        'resources': {'GPU_RTX5090': 1},
        'network': 'tailscale',       # Needs Tailscale on Jupiter to reach head
        'ssh_user': 'nick',
    },
    'razer': {
        'role': 'worker',
        'ip': '192.168.0.103',       # LAN IP (same subnet as Jupiter)
        'ip_tailscale': '100.102.215.75',  # Tailscale fallback
        'os': 'windows',
        'ray_bin': r'C:\Python311\python.exe -m ray.scripts.scripts',
        'api_port': 8765,
        'api_ip': '100.102.215.75',  # Flask API reachable via Tailscale
        'gpu': 1,
        'resources': {'GPU_RTX3070': 1},
        'network': 'lan',
    },
}


# ─── Helpers ────────────────────────────────────────────────────────────────

def node_api_exec(host, cmd, timeout=60):
    """Execute command on a node via its Flask NodeAPI."""
    payload = json.dumps({'command': cmd, 'timeout': timeout}).encode()
    req = urllib.request.Request(
        f'http://{host}:{NODE_API_PORT}/exec',
        data=payload,
        headers={'Content-Type': 'application/json', 'X-API-Key': NODE_API_KEY}
    )
    try:
        r = urllib.request.urlopen(req, timeout=timeout + 10)
        return json.loads(r.read())
    except Exception as e:
        return {'error': str(e), 'exitCode': -1}


def get_cluster_status():
    """Get current Ray cluster node status via dashboard API."""
    try:
        r = urllib.request.urlopen(
            f'http://{RAY_HEAD_IP}:{RAY_DASHBOARD_PORT}/nodes?view=summary',
            timeout=10
        )
        data = json.loads(r.read())
        return data.get('data', {}).get('summary', [])
    except Exception:
        return []


def print_status():
    """Print cluster status."""
    nodes = get_cluster_status()
    if not nodes:
        print('  Cluster unreachable or no nodes.')
        return
    print(f'  {len(nodes)} nodes in cluster:')
    for n in nodes:
        raylet = n.get('raylet', {})
        res = raylet.get('resourcesTotal', {})
        cpu = res.get('CPU', 0)
        gpu = res.get('GPU', 0)
        mem_gb = res.get('memory', 0) / 1e9
        state = raylet.get('state', '?')
        name = raylet.get('nodeName', n.get('hostname', '?'))
        print(f'    {name:20s} IP={n.get("ip"):16s} CPU={int(cpu):2d}  GPU={int(gpu)}  RAM={mem_gb:.0f}GB  state={state}')


# ─── Start Functions ────────────────────────────────────────────────────────

def start_head():
    """Start Ray head on Jupiter."""
    print('[Jupiter] Starting Ray head...')
    cmd = (
        f'rm -rf /tmp/ray/ 2>/dev/null; '
        f'RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor '
        f'{NODES["jupiter"]["ray_bin"]} start --head '
        f'--port={RAY_HEAD_PORT} '
        f'--dashboard-host=0.0.0.0 '
        f'--dashboard-port={RAY_DASHBOARD_PORT} '
        f'--node-name=jupiter-head '
        f'2>&1'
    )
    result = node_api_exec(RAY_HEAD_IP, cmd, timeout=60)
    stdout = result.get('stdout', '')
    if 'Ray runtime started' in stdout:
        print('[Jupiter] Head started successfully.')
        return True
    else:
        print(f'[Jupiter] FAILED: {stdout[-300:]}')
        return False


def start_neptune():
    """Start Neptune worker (this machine)."""
    print('[Neptune] Starting Ray worker...')
    env = os.environ.copy()
    env['RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER'] = '1'
    env['RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL'] = 'minor'

    args = [
        'python', '-m', 'ray.scripts.scripts', 'start',
        f'--address={RAY_HEAD_IP}:{RAY_HEAD_PORT}',
        '--node-name=neptune-win',
        '--num-gpus=1',
        '--resources={"GPU_RTX3090": 1}',
    ]

    result = subprocess.run(args, capture_output=True, text=True, timeout=60, env=env)
    if result.returncode == 0:
        print('[Neptune] Worker connected.')
        return True
    else:
        print(f'[Neptune] FAILED: {result.stderr[-300:]}')
        return False


def start_saturn():
    """Start Saturn worker via Jupiter SSH hop."""
    print('[Saturn] Starting Ray worker...')
    cmd = (
        'ssh saturn@10.0.0.2 "'
        'rm -rf /tmp/ray/; '
        'RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor '
        '/home/saturn/miniconda3/envs/ray311/bin/ray start '
        f'--address={RAY_HEAD_IP}:{RAY_HEAD_PORT} '
        '--node-name=saturn-worker'
        '" 2>&1'
    )
    result = node_api_exec(RAY_HEAD_IP, cmd, timeout=90)
    stdout = result.get('stdout', '')
    if 'Ray runtime started' in stdout:
        print('[Saturn] Worker connected.')
        return True
    else:
        print(f'[Saturn] FAILED: {stdout[-300:]}')
        return False


def start_uranus():
    """Start Uranus worker.

    Uranus is on 192.168.1.x (different subnet from Jupiter 192.168.0.x).
    It needs Tailscale on Jupiter to reach the head node, OR the user must
    configure routing between subnets.  We try multiple paths:
      1. LAN direct (192.168.0.108) — works if subnets are bridged
      2. Jupiter's Tailscale IP — works if Jupiter has Tailscale enabled
    """
    uranus_api = NODES['uranus'].get('api_ip', NODES['uranus']['ip_tailscale'])
    uranus_lan = NODES['uranus']['ip']  # 192.168.1.178

    print(f'[Uranus] Starting Ray worker (LAN IP: {uranus_lan})...')

    # Try direct LAN first
    result = node_api_exec(uranus_api,
        f'ping -n 1 -w 2000 {RAY_HEAD_IP} 2>&1', timeout=10)
    head_reachable = 'TTL=' in result.get('stdout', '')

    if not head_reachable:
        # Try Jupiter's Tailscale IP if available
        print('[Uranus] Cannot reach Jupiter on LAN (different subnet).')
        print('[Uranus] Checking if Jupiter has Tailscale...')
        # Check Jupiter's Tailscale status
        ts_result = node_api_exec(RAY_HEAD_IP, 'tailscale ip -4 2>&1', timeout=5)
        jupiter_ts_ip = ts_result.get('stdout', '').strip()
        if jupiter_ts_ip and jupiter_ts_ip.startswith('100.'):
            result = node_api_exec(uranus_api,
                f'ping -n 1 -w 2000 {jupiter_ts_ip} 2>&1', timeout=10)
            if 'TTL=' in result.get('stdout', ''):
                print(f'[Uranus] Reachable via Jupiter Tailscale IP {jupiter_ts_ip}')
                head_reachable = True
                # Use Tailscale IP for Ray address
                ray_address = f'{jupiter_ts_ip}:{RAY_HEAD_PORT}'
            else:
                print(f'[Uranus] Cannot reach Jupiter Tailscale IP either.')
        if not head_reachable:
            print('[Uranus] CANNOT reach Jupiter. Options:')
            print('         1. Enable Tailscale on Jupiter: sudo tailscale up')
            print('         2. Bridge the 192.168.0.x and 192.168.1.x subnets')
            return False
    else:
        ray_address = f'{RAY_HEAD_IP}:{RAY_HEAD_PORT}'

    cmd = (
        f'set RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1&& '
        f'set RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor&& '
        f'python -m ray.scripts.scripts start '
        f'--address={ray_address} '
        f'--node-name=uranus-win --num-gpus=1 '
        f'--node-ip-address={uranus_lan}'
    )
    result = node_api_exec(uranus_api, cmd, timeout=90)
    stdout = result.get('stdout', '')
    if 'Ray runtime started' in stdout:
        print('[Uranus] Worker connected.')
        return True
    else:
        print(f'[Uranus] FAILED: {stdout[-300:]}')
        return False


def start_razer():
    """Start Razer worker (LAN — same 192.168.0.x subnet as Jupiter)."""
    razer_api = NODES['razer'].get('api_ip', NODES['razer']['ip'])
    razer_lan = NODES['razer']['ip']  # 192.168.0.103

    print(f'[Razer] Starting Ray worker (LAN IP: {razer_lan})...')
    result = node_api_exec(razer_api,
        f'ping -n 1 -w 2000 {RAY_HEAD_IP} 2>&1', timeout=10)
    if 'TTL=' not in result.get('stdout', ''):
        print('[Razer] CANNOT reach Jupiter on LAN.')
        return False

    cmd = (
        f'set RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1&& '
        f'set RAY_DEFAULT_PYTHON_VERSION_MATCH_LEVEL=minor&& '
        r'C:\Python311\python.exe -m ray.scripts.scripts start '
        f'--address={RAY_HEAD_IP}:{RAY_HEAD_PORT} '
        f'--node-name=razer-win --num-gpus=1 '
        f'--node-ip-address={razer_lan}'
    )
    result = node_api_exec(razer_api, cmd, timeout=90)
    stdout = result.get('stdout', '')
    if 'Ray runtime started' in stdout:
        print('[Razer] Worker connected via LAN.')
        return True
    else:
        print(f'[Razer] FAILED: {stdout[-300:]}')
        return False


def stop_all():
    """Stop Ray on all nodes."""
    print('Stopping Ray on all nodes...')

    # Neptune (local)
    env = os.environ.copy()
    env['RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER'] = '1'
    subprocess.run(['python', '-m', 'ray.scripts.scripts', 'stop', '--force'],
                   capture_output=True, text=True, timeout=30, env=env)
    print('  Neptune: stopped')

    # Jupiter
    result = node_api_exec(RAY_HEAD_IP,
        '/home/jupiter/miniconda3/envs/ray311/bin/ray stop --force 2>&1', timeout=30)
    print(f'  Jupiter: stopped')

    # Saturn
    node_api_exec(RAY_HEAD_IP,
        'ssh saturn@10.0.0.2 "/home/saturn/miniconda3/envs/ray311/bin/ray stop --force" 2>&1',
        timeout=30)
    print(f'  Saturn: stopped')

    # Uranus (via Tailscale API)
    uranus_api = NODES['uranus'].get('api_ip', NODES['uranus'].get('ip_tailscale', '100.100.83.37'))
    try:
        node_api_exec(uranus_api,
            'python -m ray.scripts.scripts stop --force 2>&1', timeout=15)
        print(f'  Uranus: stopped')
    except Exception:
        print(f'  Uranus: unreachable')

    # Razer (via Tailscale API)
    razer_api = NODES['razer'].get('api_ip', NODES['razer'].get('ip_tailscale', '100.102.215.75'))
    try:
        node_api_exec(razer_api,
            r'C:\Python311\python.exe -m ray.scripts.scripts stop --force 2>&1', timeout=15)
        print(f'  Razer: stopped')
    except Exception:
        print(f'  Razer: unreachable')


# ─── Main ───────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if '--status' in sys.argv:
        print('Ray Cluster Status:')
        print_status()
        sys.exit(0)

    if '--stop' in sys.argv:
        stop_all()
        sys.exit(0)

    print('=' * 60)
    print('Ray Cluster Startup')
    print('=' * 60)

    # Step 1: Start head
    if not start_head():
        print('FATAL: Could not start Ray head. Aborting.')
        sys.exit(1)
    time.sleep(3)

    # Step 2: Start LAN workers
    results = {}
    results['neptune'] = start_neptune()
    results['saturn'] = start_saturn()

    # Step 3: Try Tailscale workers
    results['uranus'] = start_uranus()
    results['razer'] = start_razer()

    # Step 4: Final status
    print()
    print('=' * 60)
    print('Cluster Status:')
    print_status()

    connected = sum(1 for v in results.values() if v)
    total = len(results)
    print(f'\n{connected}/{total} workers connected (+ head)')

    if not results.get('uranus') or not results.get('razer'):
        print('\nTo connect Tailscale nodes, enable Tailscale on Jupiter:')
        print('  1. SSH to Jupiter: ssh jupiter@192.168.0.108')
        print('  2. Run: sudo tailscale up')
        print('  3. Click the auth URL in your browser')
        print('  4. Re-run this script')

    print('=' * 60)
