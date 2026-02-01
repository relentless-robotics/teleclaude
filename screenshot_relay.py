#!/usr/bin/env python3
"""
Screenshot Relay to Discord
Sends screenshots to Discord when browser automation hits blockers.

Usage:
    python screenshot_relay.py <screenshot_path> --context "What happened"
    python screenshot_relay.py captcha.png --context "CAPTCHA on Gumroad signup"
"""

import os
import sys
import json
import argparse
import http.client
from urllib.parse import urlparse
from datetime import datetime
from pathlib import Path

# Discord webhook URL - set this in environment or pass as argument
DISCORD_WEBHOOK_URL = os.environ.get('DISCORD_WEBHOOK_URL', '')


def send_screenshot_to_discord(
    screenshot_path: str,
    context: str = "",
    webhook_url: str = None,
    title: str = "Browser Screenshot"
) -> bool:
    """
    Send a screenshot to Discord with context.

    Args:
        screenshot_path: Path to screenshot image
        context: What's happening / what help is needed
        webhook_url: Discord webhook URL
        title: Title for the message

    Returns:
        True if sent successfully
    """
    url = webhook_url or DISCORD_WEBHOOK_URL

    if not url:
        print("Error: No Discord webhook URL provided")
        print("Set DISCORD_WEBHOOK_URL env var or pass --webhook")
        return False

    if not os.path.exists(screenshot_path):
        print(f"Error: Screenshot not found: {screenshot_path}")
        return False

    # Read screenshot
    with open(screenshot_path, 'rb') as f:
        image_data = f.read()

    # Format message
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    message = f"""**{title}**

**Time:** {timestamp}
**Context:** {context or 'Browser automation'}

*Reply if action needed*"""

    # Send to Discord
    return _send_webhook_with_file(url, message, image_data, Path(screenshot_path).name)


def _send_webhook_with_file(webhook_url: str, message: str, file_data: bytes, filename: str) -> bool:
    """Send webhook with file attachment."""
    parsed = urlparse(webhook_url)
    boundary = '----WebKitFormBoundary' + datetime.now().strftime('%Y%m%d%H%M%S')

    # Build multipart form
    body_parts = []

    # Message payload
    body_parts.append(f'--{boundary}'.encode())
    body_parts.append(b'Content-Disposition: form-data; name="payload_json"')
    body_parts.append(b'Content-Type: application/json')
    body_parts.append(b'')
    body_parts.append(json.dumps({'content': message}).encode())

    # File attachment
    body_parts.append(f'--{boundary}'.encode())
    body_parts.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode())
    body_parts.append(b'Content-Type: image/png')
    body_parts.append(b'')
    body_parts.append(file_data)

    body_parts.append(f'--{boundary}--'.encode())

    body = b'\r\n'.join(body_parts)

    try:
        conn = http.client.HTTPSConnection(parsed.netloc, timeout=30)
        conn.request(
            'POST',
            parsed.path,
            body=body,
            headers={
                'Content-Type': f'multipart/form-data; boundary={boundary}',
                'Content-Length': str(len(body))
            }
        )
        response = conn.getresponse()
        success = response.status in [200, 204]
        if not success:
            print(f"Discord error: {response.status} {response.reason}")
        return success
    except Exception as e:
        print(f"Error sending to Discord: {e}")
        return False


def send_blocker_alert(
    screenshot_path: str,
    blocker_type: str = "unknown",
    site: str = "",
    action_needed: str = "",
    webhook_url: str = None
) -> bool:
    """
    Send an alert about a blocker (CAPTCHA, error, etc.)

    Args:
        screenshot_path: Path to screenshot
        blocker_type: Type of blocker (captcha, error, login, verification)
        site: Website where blocker occurred
        action_needed: What the user needs to do
        webhook_url: Discord webhook URL
    """
    url = webhook_url or DISCORD_WEBHOOK_URL

    if not url or not os.path.exists(screenshot_path):
        return False

    with open(screenshot_path, 'rb') as f:
        image_data = f.read()

    timestamp = datetime.now().strftime("%H:%M:%S")

    # Format based on blocker type
    type_emoji = {
        'captcha': '🤖',
        'error': '❌',
        'login': '🔐',
        'verification': '✉️',
        '2fa': '🔑',
        'unknown': '⚠️'
    }

    emoji = type_emoji.get(blocker_type.lower(), '⚠️')

    message = f"""{emoji} **HELP NEEDED - {blocker_type.upper()}**

**Site:** {site or 'Unknown'}
**Time:** {timestamp}
**Action Needed:** {action_needed or 'See screenshot'}

*Reply with solution or instructions*"""

    return _send_webhook_with_file(url, message, image_data, f"{blocker_type}_{timestamp.replace(':', '')}.png")


# For use in Playwright scripts
class ScreenshotRelay:
    """Helper class for sending screenshots during automation."""

    def __init__(self, webhook_url: str = None):
        self.webhook_url = webhook_url or DISCORD_WEBHOOK_URL
        self.screenshot_dir = Path("screenshots")
        self.screenshot_dir.mkdir(exist_ok=True)

    async def capture_and_send(self, page, context: str = "", title: str = "Screenshot"):
        """Capture screenshot from Playwright page and send to Discord."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"screenshot_{timestamp}.png"
        filepath = self.screenshot_dir / filename

        await page.screenshot(path=str(filepath))

        return send_screenshot_to_discord(
            str(filepath),
            context=context,
            webhook_url=self.webhook_url,
            title=title
        )

    async def send_captcha_help(self, page, site: str = ""):
        """Capture CAPTCHA and request help."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filepath = self.screenshot_dir / f"captcha_{timestamp}.png"

        await page.screenshot(path=str(filepath))

        return send_blocker_alert(
            str(filepath),
            blocker_type="captcha",
            site=site,
            action_needed="Please solve the CAPTCHA shown",
            webhook_url=self.webhook_url
        )

    async def send_error(self, page, error_msg: str = "", site: str = ""):
        """Capture error state and notify."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filepath = self.screenshot_dir / f"error_{timestamp}.png"

        await page.screenshot(path=str(filepath))

        return send_blocker_alert(
            str(filepath),
            blocker_type="error",
            site=site,
            action_needed=error_msg or "Check screenshot for error",
            webhook_url=self.webhook_url
        )


# CLI
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Send screenshot to Discord')
    parser.add_argument('screenshot', help='Path to screenshot')
    parser.add_argument('--context', '-c', default='', help='Context/description')
    parser.add_argument('--webhook', '-w', help='Discord webhook URL')
    parser.add_argument('--title', '-t', default='Browser Screenshot', help='Message title')
    parser.add_argument('--type', choices=['captcha', 'error', 'login', '2fa', 'verification'],
                        help='If this is a blocker, specify type')
    parser.add_argument('--site', '-s', default='', help='Website name')

    args = parser.parse_args()

    webhook = args.webhook or DISCORD_WEBHOOK_URL

    if args.type:
        success = send_blocker_alert(
            args.screenshot,
            blocker_type=args.type,
            site=args.site,
            action_needed=args.context,
            webhook_url=webhook
        )
    else:
        success = send_screenshot_to_discord(
            args.screenshot,
            context=args.context,
            webhook_url=webhook,
            title=args.title
        )

    if success:
        print("Screenshot sent to Discord!")
    else:
        print("Failed to send screenshot")
        sys.exit(1)
