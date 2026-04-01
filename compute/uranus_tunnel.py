#!/usr/bin/env python3
"""Persistent SSH tunnel to Uranus Flask API (port 8765).
Runs as PM2 process. Exposes localhost:8767 -> uranus:8765.
Needed because Tailscale ACL blocks port 8765 directly."""

import paramiko
import threading
import socket
import time
import sys

URANUS_HOST = '100.100.83.37'
URANUS_USER = 'nick'
URANUS_PASS = 'Pb26116467'
LOCAL_PORT = 8767
REMOTE_PORT = 8765

def create_tunnel():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(URANUS_HOST, username=URANUS_USER, password=URANUS_PASS, timeout=10)
    transport = ssh.get_transport()
    transport.set_keepalive(30)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', LOCAL_PORT))
    server.listen(10)
    server.settimeout(30)
    print(f'Tunnel listening on localhost:{LOCAL_PORT} -> {URANUS_HOST}:{REMOTE_PORT}', flush=True)

    def handle(cs):
        try:
            chan = transport.open_channel('direct-tcpip', ('127.0.0.1', REMOTE_PORT), cs.getpeername())
            import select
            while True:
                r, _, _ = select.select([cs, chan], [], [], 10)
                if cs in r:
                    d = cs.recv(8192)
                    if not d: break
                    chan.sendall(d)
                if chan in r:
                    d = chan.recv(8192)
                    if not d: break
                    cs.sendall(d)
        except:
            pass
        finally:
            cs.close()
            try: chan.close()
            except: pass

    while True:
        try:
            c, _ = server.accept()
            threading.Thread(target=handle, args=(c,), daemon=True).start()
        except socket.timeout:
            # Check SSH is still alive
            if not transport.is_active():
                print('SSH transport died, reconnecting...', flush=True)
                raise ConnectionError('Transport dead')
        except Exception as e:
            print(f'Tunnel error: {e}', flush=True)
            break

    server.close()
    ssh.close()

if __name__ == '__main__':
    while True:
        try:
            create_tunnel()
        except Exception as e:
            print(f'Tunnel crashed: {e}. Reconnecting in 10s...', flush=True)
            time.sleep(10)
