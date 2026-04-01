#!/usr/bin/env python3
"""Runner that executes deploy_node_api.py and captures output."""
import subprocess, sys, os

result = subprocess.run(
    [sys.executable, os.path.join(os.path.dirname(__file__), 'deploy_node_api.py')],
    capture_output=False,
    timeout=300,
)
sys.exit(result.returncode)
