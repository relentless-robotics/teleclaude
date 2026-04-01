"""Setup Lvl3Quant directory on a GPU node and download training files from Neptune."""
import os
import socket
import subprocess
import sys
import urllib.request

NEPTUNE_HTTP = "http://100.109.245.73:9877"
hostname = socket.gethostname()

# Determine root based on hostname
home = os.path.expanduser("~")
ROOT = os.path.join(home, "Lvl3Quant")

print(f"Hostname: {hostname}, Root: {ROOT}")

# Create directories
dirs = [
    f"{ROOT}/alpha_discovery/deep_models/results/event_transformer_fast",
    f"{ROOT}/data/processed/mbo_events",
    f"{ROOT}/scripts",
]
for d in dirs:
    os.makedirs(d, exist_ok=True)
    print(f"Created: {d}")

# Download training script
script_url = f"{NEPTUNE_HTTP}/alpha_discovery/deep_models/train_event_transformer_fast.py"
script_dest = f"{ROOT}/alpha_discovery/deep_models/train_event_transformer_fast.py"
print(f"Downloading training script...")
urllib.request.urlretrieve(script_url, script_dest)
print(f"Saved: {script_dest}")

# Download event_transformer.py (model definition, may be imported)
model_url = f"{NEPTUNE_HTTP}/alpha_discovery/deep_models/event_transformer.py"
model_dest = f"{ROOT}/alpha_discovery/deep_models/event_transformer.py"
try:
    urllib.request.urlretrieve(model_url, model_dest)
    print(f"Saved: {model_dest}")
except:
    print("event_transformer.py not found on server (may not be needed)")

# Download event data files
print("Listing event data files...")
# Get file listing from server
import json
try:
    # Try to get directory listing
    data_url = f"{NEPTUNE_HTTP}/data/processed/mbo_events/"
    resp = urllib.request.urlopen(data_url)
    html = resp.read().decode()
    # Parse links from directory listing
    import re
    files = re.findall(r'href="([^"]*_mbo_events\.npz)"', html)
    print(f"Found {len(files)} data files to download")

    for i, f in enumerate(files):
        dest = f"{ROOT}/data/processed/mbo_events/{f}"
        if os.path.exists(dest):
            continue
        url = f"{NEPTUNE_HTTP}/data/processed/mbo_events/{f}"
        urllib.request.urlretrieve(url, dest)
        if i % 10 == 0:
            print(f"  [{i+1}/{len(files)}] {f}")

    print(f"All {len(files)} data files downloaded")
except Exception as e:
    print(f"Error downloading data: {e}")
    # Fallback: download just the key dates we know about
    key_dates = ["20260128", "20260202"]
    for d in key_dates:
        f = f"{d}_mbo_events.npz"
        dest = f"{ROOT}/data/processed/mbo_events/{f}"
        url = f"{NEPTUNE_HTTP}/data/processed/mbo_events/{f}"
        try:
            urllib.request.urlretrieve(url, dest)
            print(f"Downloaded: {f}")
        except:
            print(f"Failed: {f}")

# Count files
data_dir = f"{ROOT}/data/processed/mbo_events"
n = len([f for f in os.listdir(data_dir) if f.endswith('.npz')])
print(f"\nTotal data files on this node: {n}")

# Check GPU
try:
    import torch
    print(f"GPU available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
except:
    print("PyTorch not available")

print("\nSETUP COMPLETE")
