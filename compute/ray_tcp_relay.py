#!/usr/bin/env python3
"""
Ray TCP Relay — Bridges Tailscale and LAN networks for Ray cluster.

Neptune (this PC) sits on both networks:
  - LAN: 192.168.0.101 (can reach Jupiter/Saturn)
  - Tailscale: 100.109.245.73 (can reach Uranus/Razer)

Ray head runs on Neptune's LAN IP (192.168.0.101:6379).
This relay forwards Tailscale traffic to LAN so remote nodes can connect.

Forwarded ports:
  - 6379  (GCS server — required for cluster join)
  - 8265  (Dashboard)
  - 10001 (Ray Client)

Usage:
  python compute/ray_tcp_relay.py
  python compute/ray_tcp_relay.py --stop   (kills existing relay)
"""

import asyncio
import sys
import os
import signal
import json
import logging

# Configuration
TAILSCALE_IP = '100.109.245.73'   # Neptune's Tailscale IP (listen)
RAY_HEAD_IP = '192.168.0.108'     # Jupiter's LAN IP (Ray head)
PORTS = [6379, 8265, 10001]

PID_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ray_tcp_relay.pid')
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ray_tcp_relay.log')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler()
    ]
)
log = logging.getLogger('ray_relay')


async def relay(reader, writer, label):
    """Forward data between two connections."""
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
        pass
    except Exception as e:
        log.debug(f'{label}: {e}')
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def handle_client(client_reader, client_writer, target_host, target_port, listen_port):
    """Handle a single connection: connect to target and relay bidirectionally."""
    peer = client_writer.get_extra_info('peername')
    log.info(f'[:{listen_port}] New connection from {peer} -> {target_host}:{target_port}')

    try:
        target_reader, target_writer = await asyncio.wait_for(
            asyncio.open_connection(target_host, target_port),
            timeout=10
        )
    except Exception as e:
        log.error(f'[:{listen_port}] Cannot connect to {target_host}:{target_port}: {e}')
        client_writer.close()
        return

    task1 = asyncio.create_task(relay(client_reader, target_writer, f'{peer}->target'))
    task2 = asyncio.create_task(relay(target_reader, client_writer, f'target->{peer}'))

    done, pending = await asyncio.wait([task1, task2], return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()

    log.info(f'[:{listen_port}] Connection from {peer} closed')


async def start_relay():
    """Start TCP relay servers for all configured ports."""
    servers = []

    for port in PORTS:
        try:
            server = await asyncio.start_server(
                lambda r, w, p=port: handle_client(r, w, RAY_HEAD_IP, p, p),
                host=TAILSCALE_IP,
                port=port,
            )
            servers.append(server)
            log.info(f'Relay: {TAILSCALE_IP}:{port} -> {RAY_HEAD_IP}:{port}')
        except OSError as e:
            log.error(f'Cannot bind {TAILSCALE_IP}:{port}: {e}')
            # If GCS port fails, abort
            if port == 6379:
                log.error('GCS port relay failed, aborting.')
                for s in servers:
                    s.close()
                return

    if not servers:
        log.error('No relay servers started.')
        return

    # Write PID file
    with open(PID_FILE, 'w') as f:
        json.dump({'pid': os.getpid(), 'ports': PORTS, 'ts_ip': TAILSCALE_IP, 'lan_ip': RAY_HEAD_IP}, f)

    log.info(f'Ray TCP relay running (PID {os.getpid()}). Forwarding {len(servers)} ports.')

    try:
        await asyncio.gather(*[s.serve_forever() for s in servers])
    except asyncio.CancelledError:
        pass
    finally:
        for s in servers:
            s.close()
        try:
            os.remove(PID_FILE)
        except OSError:
            pass
        log.info('Relay stopped.')


def stop_relay():
    """Stop existing relay by reading PID file."""
    if not os.path.exists(PID_FILE):
        print('No relay running (no PID file).')
        return

    with open(PID_FILE) as f:
        info = json.load(f)

    pid = info.get('pid')
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
            print(f'Sent SIGTERM to relay PID {pid}')
        except ProcessLookupError:
            print(f'Relay PID {pid} not running.')
        except Exception as e:
            print(f'Error stopping relay: {e}')

    try:
        os.remove(PID_FILE)
    except OSError:
        pass


if __name__ == '__main__':
    if '--stop' in sys.argv:
        stop_relay()
        sys.exit(0)

    if os.path.exists(PID_FILE):
        with open(PID_FILE) as f:
            info = json.load(f)
        print(f'Warning: Relay may already be running (PID {info.get("pid")}). Use --stop first.')

    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    try:
        asyncio.run(start_relay())
    except KeyboardInterrupt:
        log.info('Interrupted.')
