"""
server_creds.py — Load server credentials from .env file.

All scripts that need Jupiter/Saturn credentials should import from here:

    from utils.server_creds import JUPITER_HOST, JUPITER_USER, JUPITER_PASS, \
        SATURN_HOST, SATURN_USER, SATURN_PASS

Or if running from the repo root:
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    # ... then use the module-level constants below
"""

import os

# Try loading .env from multiple likely locations
_loaded = False
try:
    from dotenv import load_dotenv
    # Try repo root (when running from anywhere inside the repo)
    for candidate in [
        os.path.join(os.path.dirname(__file__), '..', '.env'),
        os.path.join(os.getcwd(), '.env'),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env'),
    ]:
        if os.path.isfile(candidate):
            load_dotenv(candidate)
            _loaded = True
            break
except ImportError:
    pass  # python-dotenv not installed; rely on env vars being set

JUPITER_HOST = os.environ.get('JUPITER_HOST', '192.168.137.2')
JUPITER_HOST_TAILSCALE = os.environ.get('JUPITER_HOST_TAILSCALE', '100.71.253.30')
JUPITER_USER = os.environ.get('JUPITER_USER', 'jupiter')
JUPITER_PASS = os.environ.get('JUPITER_PASS', '')

SATURN_HOST = os.environ.get('SATURN_HOST', '10.0.0.2')
SATURN_USER = os.environ.get('SATURN_USER', 'saturn')
SATURN_PASS = os.environ.get('SATURN_PASS', '')

if not JUPITER_PASS and not _loaded:
    import warnings
    warnings.warn(
        "JUPITER_PASS not found in environment. "
        "Ensure .env file exists in the repo root or set env vars manually.",
        RuntimeWarning,
        stacklevel=2
    )
