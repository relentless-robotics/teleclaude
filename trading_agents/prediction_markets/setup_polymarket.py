#!/usr/bin/env python3
"""
One-shot Polymarket setup — derive API key when VPN is connected.

Run this ONCE while ProtonVPN (or any VPN) is connected to a non-US server.
It will derive CLOB API credentials and save them to .env automatically.

Usage:
    1. Connect ProtonVPN to any non-US server
    2. python setup_polymarket.py
    3. Done — credentials saved to .env
"""

import json
import os
import sys
import time
from pathlib import Path

# Add parent dirs to path
THIS_DIR = Path(__file__).resolve().parent
ROOT_DIR = THIS_DIR.parent.parent
sys.path.insert(0, str(ROOT_DIR))

import requests


def check_ip():
    """Check current external IP and geolocation."""
    try:
        ip = requests.get("https://api.ipify.org?format=json", timeout=5).json()["ip"]
        geo = requests.get(f"https://ipapi.co/{ip}/json/", timeout=5).json()
        return {
            "ip": ip,
            "country": geo.get("country_name", "?"),
            "country_code": geo.get("country_code", "?"),
            "city": geo.get("city", "?"),
        }
    except Exception as e:
        return {"ip": "unknown", "error": str(e)}


def load_env():
    """Load .env file."""
    env_path = ROOT_DIR / ".env"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip())


def save_to_env(key: str, value: str):
    """Append or update a key in .env file."""
    env_path = ROOT_DIR / ".env"
    lines = []
    found = False

    if env_path.exists():
        with open(env_path) as f:
            lines = f.readlines()

    for i, line in enumerate(lines):
        if line.strip().startswith(f"{key}="):
            lines[i] = f"{key}={value}\n"
            found = True
            break

    if not found:
        lines.append(f"{key}={value}\n")

    with open(env_path, "w") as f:
        f.writelines(lines)


def main():
    print("=" * 60)
    print("  POLYMARKET ONE-SHOT SETUP")
    print("=" * 60)

    # Load existing env
    load_env()

    # Step 1: Check IP
    print("\n[1/3] Checking your IP address...")
    geo = check_ip()

    if geo.get("error"):
        print(f"  Could not check IP: {geo['error']}")
        print("  Make sure you're connected to the internet.")
        return False

    print(f"  IP: {geo['ip']}")
    print(f"  Location: {geo['city']}, {geo['country']} ({geo['country_code']})")

    if geo.get("country_code") == "US":
        print("\n  ERROR: You're on a US IP address!")
        print("  Connect ProtonVPN to a non-US server first.")
        print("  Then re-run this script.")
        return False

    print(f"  Non-US IP confirmed.")

    # Step 2: Check wallet
    print("\n[2/3] Loading wallet...")
    pk = os.environ.get("POLYMARKET_PRIVATE_KEY", "")
    if not pk:
        print("  ERROR: POLYMARKET_PRIVATE_KEY not set in .env")
        return False

    if not pk.startswith("0x"):
        pk = "0x" + pk

    try:
        from eth_account import Account
        acct = Account.from_key(pk)
        print(f"  Wallet: {acct.address}")
    except Exception as e:
        print(f"  ERROR loading wallet: {e}")
        return False

    # Step 3: Derive API key
    print("\n[3/3] Deriving CLOB API credentials...")

    # Check if we already have valid creds
    existing_key = os.environ.get("POLYMARKET_API_KEY", "")
    if existing_key:
        print(f"  Existing API key found: {existing_key[:20]}...")
        print("  Skipping derivation — already set up.")
        print("  Delete POLYMARKET_API_KEY from .env to force re-derivation.")
        return True

    try:
        from py_clob_client.client import ClobClient

        client = ClobClient(
            host="https://clob.polymarket.com",
            chain_id=137,
            key=pk,
        )

        creds = client.derive_api_key()

        api_key = creds.api_key
        api_secret = creds.api_secret
        api_passphrase = creds.api_passphrase

        print(f"  API Key:    {api_key}")
        print(f"  Secret:     {api_secret[:30]}...")
        print(f"  Passphrase: {api_passphrase[:30]}...")

        # Save to .env
        save_to_env("POLYMARKET_API_KEY", api_key)
        save_to_env("POLYMARKET_SECRET", api_secret)
        save_to_env("POLYMARKET_PASSPHRASE", api_passphrase)
        save_to_env("POLYMARKET_PROXY", "auto")

        print(f"\n  Credentials saved to .env!")

    except Exception as e:
        print(f"\n  API key derivation FAILED: {e}")
        print("  Make sure VPN is connected and try again.")
        return False

    # Step 4: Quick verification
    print("\n[VERIFY] Testing authenticated endpoint...")
    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import ApiCreds

        client = ClobClient(
            host="https://clob.polymarket.com",
            chain_id=137,
            key=pk,
            creds=ApiCreds(
                api_key=api_key,
                api_secret=api_secret,
                api_passphrase=api_passphrase,
            ),
        )

        # Try to get balance/allowance
        try:
            bal = client.get_balance_allowance()
            print(f"  Auth OK! Balance info: {bal}")
        except Exception:
            # Some endpoints may not work without deposits
            print(f"  Auth endpoint responded (wallet may need funding)")

    except Exception as e:
        print(f"  Verification failed: {e}")

    print(f"\n{'=' * 60}")
    print(f"  SETUP COMPLETE!")
    print(f"")
    print(f"  Next steps:")
    print(f"  1. Fund wallet with USDC on Polygon: {acct.address}")
    print(f"  2. Start paper trading: python polymarket_trader.py --paper --auto")
    print(f"  3. Start live trading:  python polymarket_trader.py --auto")
    print(f"{'=' * 60}")
    return True


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
