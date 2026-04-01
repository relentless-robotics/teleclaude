#!/usr/bin/env python3
"""
MLflow Tracking Server — Neptune head node
Starts MLflow with SQLite backend and local artifact store.
Run via PM2 using compute/mlflow.ecosystem.js

Dashboard: http://localhost:5000
"""

import subprocess
import sys
import os
from pathlib import Path

BACKEND_STORE = r"C:\Users\Footb\Documents\Github\Lvl3Quant\mlflow\mlflow.db"
ARTIFACT_ROOT = r"C:\Users\Footb\Documents\Github\Lvl3Quant\mlflow\artifacts"
HOST = "0.0.0.0"
PORT = 5000

def main():
    # Ensure dirs exist
    Path(BACKEND_STORE).parent.mkdir(parents=True, exist_ok=True)
    Path(ARTIFACT_ROOT).mkdir(parents=True, exist_ok=True)

    backend_uri = f"sqlite:///{BACKEND_STORE}"

    # --allowed-hosts: use "all" to bypass DNS-rebinding check for ALL hosts.
    # This is needed because Tailscale IPs (e.g. 100.109.245.73) are rejected
    # with "Invalid Host header - DNS rebinding attack" unless explicitly allowed.
    # "all" is the safest fix since MLflow is LAN/VPN-only (not exposed to internet).
    # Set env vars BEFORE exec to ensure they're inherited by the mlflow server process.
    # MLFLOW_SERVER_ALLOWED_HOSTS=* allows all Host headers (needed for Tailscale IPs like 100.109.245.73).
    # Without this, Uranus training gets 403 "Invalid Host header - DNS rebinding attack detected".
    os.environ['MLFLOW_SERVER_ALLOWED_HOSTS'] = '*'
    os.environ['MLFLOW_SERVER_DISABLE_SECURITY_MIDDLEWARE'] = 'false'  # Keep security but allow all hosts

    cmd = [
        sys.executable, "-m", "mlflow", "server",
        "--backend-store-uri", backend_uri,
        "--default-artifact-root", ARTIFACT_ROOT,
        "--host", HOST,
        "--port", str(PORT),
        "--workers", "2",
        "--allowed-hosts", "*",
    ]

    print(f"[MLflow] Starting server on {HOST}:{PORT}")
    print(f"[MLflow] Backend store: {backend_uri}")
    print(f"[MLflow] Artifact root: {ARTIFACT_ROOT}")
    print(f"[MLflow] Dashboard: http://localhost:{PORT}")
    print(f"[MLflow] Allowed hosts: * (Tailscale/LAN access enabled)")

    os.execv(sys.executable, cmd)


if __name__ == "__main__":
    main()
