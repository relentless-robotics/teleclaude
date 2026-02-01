#!/usr/bin/env python3
"""
Usage Watcher for Claude Code
Monitors for usage limit errors and sends Discord alerts.

This script runs independently and watches log files or process output
for signs that Claude Code has hit its usage limit.

Usage:
    python usage_watcher.py --watch-logs
    python usage_watcher.py --watch-process <pid>
"""

import os
import sys
import time
import re
import argparse
import subprocess
from datetime import datetime
from pathlib import Path

# Import our notification module
try:
    from notify_discord import send_message, send_usage_alert
except ImportError:
    # Fallback if module not found
    def send_message(msg):
        print(f"[ALERT] {msg}")
        return True
    def send_usage_alert():
        return send_message("Usage limit hit!")


# Patterns that indicate usage limit
LIMIT_PATTERNS = [
    r"You've hit your limit",
    r"rate.?limit",
    r"usage.?limit",
    r"quota.?exceeded",
    r"too.?many.?requests",
    r"resets?\s+\d+[ap]m",
]

COMPILED_PATTERNS = [re.compile(p, re.IGNORECASE) for p in LIMIT_PATTERNS]


def check_for_limit_message(text: str) -> bool:
    """Check if text contains usage limit message."""
    for pattern in COMPILED_PATTERNS:
        if pattern.search(text):
            return True
    return False


def watch_log_file(log_path: str, check_interval: int = 5):
    """Watch a log file for usage limit messages."""
    print(f"Watching log file: {log_path}")
    print(f"Check interval: {check_interval}s")
    print("Press Ctrl+C to stop")

    last_position = 0
    last_alert_time = 0
    alert_cooldown = 300  # Don't spam alerts - 5 min cooldown

    while True:
        try:
            if os.path.exists(log_path):
                with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                    f.seek(last_position)
                    new_content = f.read()
                    last_position = f.tell()

                    if new_content and check_for_limit_message(new_content):
                        current_time = time.time()
                        if current_time - last_alert_time > alert_cooldown:
                            print(f"[{datetime.now()}] Usage limit detected!")
                            send_usage_alert()
                            last_alert_time = current_time

            time.sleep(check_interval)

        except KeyboardInterrupt:
            print("\nStopping watcher...")
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(check_interval)


def watch_directory(dir_path: str, check_interval: int = 5):
    """Watch a directory of log files."""
    print(f"Watching directory: {dir_path}")

    log_dir = Path(dir_path)
    file_positions = {}

    while True:
        try:
            for log_file in log_dir.glob('*.log'):
                if log_file not in file_positions:
                    file_positions[log_file] = 0

                with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
                    f.seek(file_positions[log_file])
                    new_content = f.read()
                    file_positions[log_file] = f.tell()

                    if new_content and check_for_limit_message(new_content):
                        print(f"[{datetime.now()}] Limit in {log_file.name}")
                        send_usage_alert()

            time.sleep(check_interval)

        except KeyboardInterrupt:
            print("\nStopping watcher...")
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(check_interval)


def find_claude_logs() -> list:
    """Try to find Claude Code log files."""
    potential_paths = [
        Path.home() / '.claude' / 'logs',
        Path.home() / 'AppData' / 'Local' / 'claude-code' / 'logs',
        Path.cwd() / 'logs',
    ]

    found = []
    for path in potential_paths:
        if path.exists():
            found.append(str(path))

    return found


def main():
    parser = argparse.ArgumentParser(description='Watch for Claude Code usage limits')
    parser.add_argument('--watch-file', help='Specific log file to watch')
    parser.add_argument('--watch-dir', help='Directory of log files to watch')
    parser.add_argument('--interval', type=int, default=5, help='Check interval in seconds')
    parser.add_argument('--find-logs', action='store_true', help='Find potential log locations')
    parser.add_argument('--test-alert', action='store_true', help='Send test alert')

    args = parser.parse_args()

    if args.test_alert:
        print("Sending test alert...")
        send_usage_alert()
        return 0

    if args.find_logs:
        logs = find_claude_logs()
        if logs:
            print("Found potential log locations:")
            for log in logs:
                print(f"  - {log}")
        else:
            print("No log directories found")
        return 0

    if args.watch_file:
        watch_log_file(args.watch_file, args.interval)
    elif args.watch_dir:
        watch_directory(args.watch_dir, args.interval)
    else:
        # Try to find logs automatically
        logs = find_claude_logs()
        if logs:
            print(f"Auto-detected log directory: {logs[0]}")
            watch_directory(logs[0], args.interval)
        else:
            print("No log directory specified or found.")
            print("Use --watch-file or --watch-dir, or --find-logs to search")
            return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
