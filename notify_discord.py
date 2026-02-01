#!/usr/bin/env python3
"""
Non-LLM Discord Notification Script
Sends messages to Discord independently of Claude Code.
Use this when Claude runs out of usage or for system alerts.

Usage:
    python notify_discord.py "Your message here"
    python notify_discord.py --status  # Send current system status
    python notify_discord.py --usage-alert  # Send usage limit alert
"""

import sys
import os
import json
import argparse
from datetime import datetime

# Discord webhook or bot configuration
# This uses a simple webhook - no LLM required
DISCORD_WEBHOOK_URL = os.environ.get('DISCORD_WEBHOOK_URL', '')

# Alternative: Use Discord bot token directly
DISCORD_BOT_TOKEN = os.environ.get('DISCORD_BOT_TOKEN', '')
DISCORD_CHANNEL_ID = os.environ.get('DISCORD_CHANNEL_ID', '')


def send_webhook_message(message: str, webhook_url: str = None) -> bool:
    """Send message via Discord webhook (simplest method)."""
    import urllib.request
    import urllib.error

    url = webhook_url or DISCORD_WEBHOOK_URL
    if not url:
        print("Error: No webhook URL configured")
        print("Set DISCORD_WEBHOOK_URL environment variable or pass webhook_url")
        return False

    data = json.dumps({
        'content': message,
        'username': 'Claude System Alert'
    }).encode('utf-8')

    req = urllib.request.Request(
        url,
        data=data,
        headers={'Content-Type': 'application/json'}
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status == 204
    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code} - {e.reason}")
        return False
    except Exception as e:
        print(f"Error sending webhook: {e}")
        return False


def send_bot_message(message: str, channel_id: str = None, token: str = None) -> bool:
    """Send message via Discord bot (requires bot token)."""
    import urllib.request
    import urllib.error

    token = token or DISCORD_BOT_TOKEN
    channel = channel_id or DISCORD_CHANNEL_ID

    if not token or not channel:
        print("Error: Bot token or channel ID not configured")
        return False

    url = f'https://discord.com/api/v10/channels/{channel}/messages'
    data = json.dumps({'content': message}).encode('utf-8')

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bot {token}'
        }
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status in [200, 201]
    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code} - {e.reason}")
        return False
    except Exception as e:
        print(f"Error sending message: {e}")
        return False


def get_system_status() -> str:
    """Get current system status for reporting."""
    import platform
    import shutil

    status_lines = [
        "**System Status Report**",
        f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Platform: {platform.system()} {platform.release()}",
    ]

    # Disk usage
    try:
        total, used, free = shutil.disk_usage('/')
        status_lines.append(f"Disk: {free // (1024**3)}GB free of {total // (1024**3)}GB")
    except Exception:
        pass

    # Python version
    status_lines.append(f"Python: {platform.python_version()}")

    return '\n'.join(status_lines)


def send_usage_alert() -> bool:
    """Send alert that Claude Code usage limit was hit."""
    message = f"""**Claude Code Usage Limit Alert**

Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

Claude Code has hit its usage limit and cannot process requests.
The limit typically resets at 11pm Eastern Time.

**What you can do:**
- Wait for the limit to reset
- Check console.anthropic.com for usage details
- Consider upgrading if this happens frequently

This is an automated message sent independently of Claude."""

    return send_message(message)


def send_message(message: str) -> bool:
    """Send message using available method (webhook preferred)."""
    if DISCORD_WEBHOOK_URL:
        return send_webhook_message(message)
    elif DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID:
        return send_bot_message(message)
    else:
        print("No Discord notification method configured!")
        print("Set one of:")
        print("  - DISCORD_WEBHOOK_URL (easiest)")
        print("  - DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID")
        return False


def main():
    parser = argparse.ArgumentParser(description='Send Discord notifications without LLM')
    parser.add_argument('message', nargs='?', help='Message to send')
    parser.add_argument('--status', action='store_true', help='Send system status')
    parser.add_argument('--usage-alert', action='store_true', help='Send usage limit alert')
    parser.add_argument('--webhook', help='Discord webhook URL (overrides env)')
    parser.add_argument('--test', action='store_true', help='Send test message')

    args = parser.parse_args()

    # Override webhook if provided
    global DISCORD_WEBHOOK_URL
    if args.webhook:
        DISCORD_WEBHOOK_URL = args.webhook

    if args.usage_alert:
        success = send_usage_alert()
    elif args.status:
        success = send_message(get_system_status())
    elif args.test:
        success = send_message(f"Test message from notify_discord.py at {datetime.now()}")
    elif args.message:
        success = send_message(args.message)
    else:
        parser.print_help()
        return 1

    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
