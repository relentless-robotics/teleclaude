#!/usr/bin/env python3
"""
Transfer MBO event .npz files from Jupiter to Uranus.
Runs ON URANUS via the Flask API /exec endpoint.
Jupiter IP: 100.71.253.30, user: jupiter, password: Pb26116467
"""
import paramiko
import os
import sys
from pathlib import Path

JUPITER_HOST = "100.71.253.30"
JUPITER_USER = "jupiter"
JUPITER_PASS = "Pb26116467"
JUPITER_SRC  = "/home/jupiter/Lvl3Quant/data/processed/mbo_events/"
URANUS_DST   = r"C:\Users\Nick\Lvl3Quant\data\processed\mbo_events"

def main():
    dst = Path(URANUS_DST)
    dst.mkdir(parents=True, exist_ok=True)

    existing = set(f.name for f in dst.glob("*.npz"))
    print(f"[transfer] Existing files on Uranus: {len(existing)}", flush=True)

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(JUPITER_HOST, username=JUPITER_USER, password=JUPITER_PASS, timeout=30)
    print(f"[transfer] Connected to Jupiter {JUPITER_HOST}", flush=True)

    sftp = ssh.open_sftp()
    files = sftp.listdir(JUPITER_SRC)
    npz_files = sorted(f for f in files if f.endswith(".npz"))
    print(f"[transfer] Jupiter has {len(npz_files)} .npz files", flush=True)

    transferred = 0
    skipped = 0
    errors = 0
    for fname in npz_files:
        if fname in existing:
            skipped += 1
            continue
        src_path = JUPITER_SRC + fname
        dst_path = str(dst / fname)
        try:
            stat = sftp.stat(src_path)
            size_mb = stat.st_size / 1024 / 1024
            print(f"[transfer] Downloading {fname} ({size_mb:.1f} MB)...", flush=True)
            sftp.get(src_path, dst_path)
            transferred += 1
        except Exception as e:
            print(f"[transfer] ERROR on {fname}: {e}", flush=True)
            errors += 1

    sftp.close()
    ssh.close()
    print(f"[transfer] DONE. Transferred={transferred}, Skipped={skipped}, Errors={errors}", flush=True)
    total = len(list(dst.glob("*.npz")))
    print(f"[transfer] Uranus now has {total} .npz files", flush=True)

if __name__ == "__main__":
    main()
