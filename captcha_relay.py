#!/usr/bin/env python3
"""
CAPTCHA Relay System
Screenshots CAPTCHAs and sends them to Discord for human solving.

Flow:
1. Browser encounters CAPTCHA
2. This script takes screenshot
3. Sends to Discord with instructions
4. User replies with solution
5. Script returns solution to browser automation

Usage:
    from captcha_relay import CaptchaRelay

    relay = CaptchaRelay(webhook_url="your-discord-webhook")
    solution = relay.request_solve(screenshot_path="captcha.png", captcha_type="image")
"""

import os
import sys
import json
import time
import base64
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any
import urllib.request
import urllib.error

# Configuration
DISCORD_WEBHOOK_URL = os.environ.get('DISCORD_WEBHOOK_URL', '')
CAPTCHA_TIMEOUT = 300  # 5 minutes to solve


class CaptchaRelay:
    """Relays CAPTCHAs to Discord for human solving."""

    def __init__(self, webhook_url: str = None):
        self.webhook_url = webhook_url or DISCORD_WEBHOOK_URL
        self.pending_captchas: Dict[str, Dict[str, Any]] = {}

    def send_captcha_to_discord(
        self,
        screenshot_path: str,
        captcha_type: str = "image",
        context: str = "",
        captcha_id: str = None
    ) -> str:
        """
        Send CAPTCHA screenshot to Discord for solving.

        Args:
            screenshot_path: Path to CAPTCHA screenshot
            captcha_type: Type of CAPTCHA (image, recaptcha, hcaptcha, text)
            context: Additional context (what site, what action)
            captcha_id: Unique ID for this CAPTCHA request

        Returns:
            captcha_id for tracking
        """
        if not self.webhook_url:
            print("Error: No Discord webhook URL configured")
            return None

        captcha_id = captcha_id or f"captcha_{int(time.time())}"

        # Read screenshot
        try:
            with open(screenshot_path, 'rb') as f:
                image_data = f.read()
        except Exception as e:
            print(f"Error reading screenshot: {e}")
            return None

        # Create message
        message = self._format_captcha_message(captcha_type, context, captcha_id)

        # Send to Discord with image
        success = self._send_webhook_with_image(
            message=message,
            image_data=image_data,
            filename=f"{captcha_id}.png"
        )

        if success:
            self.pending_captchas[captcha_id] = {
                'type': captcha_type,
                'context': context,
                'timestamp': datetime.now().isoformat(),
                'status': 'pending'
            }
            return captcha_id
        return None

    def _format_captcha_message(self, captcha_type: str, context: str, captcha_id: str) -> str:
        """Format the Discord message for CAPTCHA request."""
        type_instructions = {
            'image': "Select all matching images or type what you see",
            'recaptcha': "Click 'I am not a robot' or select matching images",
            'hcaptcha': "Select all matching images",
            'text': "Type the text/numbers shown in the image",
            'math': "Solve the math problem shown"
        }

        instruction = type_instructions.get(captcha_type, "Solve the CAPTCHA shown")

        return f"""**🤖 CAPTCHA HELP NEEDED**

**ID:** `{captcha_id}`
**Type:** {captcha_type.upper()}
**Context:** {context or 'Browser automation'}

**Instructions:** {instruction}

**Reply with:** The solution text/numbers, or describe what to click.

⏱️ *Expires in 5 minutes*"""

    def _send_webhook_with_image(self, message: str, image_data: bytes, filename: str) -> bool:
        """Send webhook message with image attachment."""
        import http.client
        import mimetypes
        from urllib.parse import urlparse

        parsed = urlparse(self.webhook_url)

        boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'

        # Build multipart form data
        body = []

        # Add message payload
        body.append(f'--{boundary}'.encode())
        body.append(b'Content-Disposition: form-data; name="payload_json"')
        body.append(b'Content-Type: application/json')
        body.append(b'')
        body.append(json.dumps({'content': message}).encode())

        # Add image file
        body.append(f'--{boundary}'.encode())
        body.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode())
        body.append(b'Content-Type: image/png')
        body.append(b'')
        body.append(image_data)

        body.append(f'--{boundary}--'.encode())

        body_bytes = b'\r\n'.join(body)

        try:
            conn = http.client.HTTPSConnection(parsed.netloc)
            conn.request(
                'POST',
                parsed.path,
                body=body_bytes,
                headers={
                    'Content-Type': f'multipart/form-data; boundary={boundary}',
                    'Content-Length': str(len(body_bytes))
                }
            )
            response = conn.getresponse()
            return response.status in [200, 204]
        except Exception as e:
            print(f"Error sending webhook: {e}")
            return False

    def check_for_solution(self, captcha_id: str) -> Optional[str]:
        """
        Check if a solution has been provided.

        In practice, this would poll a response channel or use Discord bot.
        For now, this is a placeholder for manual input.
        """
        # This would need a Discord bot or response mechanism
        # For simple setup, user can call set_solution()
        captcha = self.pending_captchas.get(captcha_id)
        if captcha and 'solution' in captcha:
            return captcha['solution']
        return None

    def set_solution(self, captcha_id: str, solution: str):
        """Manually set solution for a CAPTCHA."""
        if captcha_id in self.pending_captchas:
            self.pending_captchas[captcha_id]['solution'] = solution
            self.pending_captchas[captcha_id]['status'] = 'solved'

    def wait_for_solution(self, captcha_id: str, timeout: int = CAPTCHA_TIMEOUT) -> Optional[str]:
        """
        Wait for a CAPTCHA solution with timeout.

        This polls for solution. In production, would use webhooks/websockets.
        """
        start_time = time.time()
        while time.time() - start_time < timeout:
            solution = self.check_for_solution(captcha_id)
            if solution:
                return solution
            time.sleep(2)
        return None


def send_captcha_alert(
    screenshot_path: str,
    webhook_url: str = None,
    context: str = ""
) -> bool:
    """
    Simple function to send CAPTCHA screenshot to Discord.

    Args:
        screenshot_path: Path to the CAPTCHA screenshot
        webhook_url: Discord webhook URL
        context: What site/action needs the CAPTCHA

    Returns:
        True if sent successfully
    """
    relay = CaptchaRelay(webhook_url=webhook_url)
    captcha_id = relay.send_captcha_to_discord(
        screenshot_path=screenshot_path,
        context=context
    )
    return captcha_id is not None


# CLI interface
if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='CAPTCHA Relay to Discord')
    parser.add_argument('screenshot', help='Path to CAPTCHA screenshot')
    parser.add_argument('--webhook', help='Discord webhook URL')
    parser.add_argument('--context', default='', help='Context for the CAPTCHA')
    parser.add_argument('--type', default='image', help='CAPTCHA type')

    args = parser.parse_args()

    webhook = args.webhook or DISCORD_WEBHOOK_URL
    if not webhook:
        print("Error: Provide webhook URL via --webhook or DISCORD_WEBHOOK_URL env var")
        sys.exit(1)

    relay = CaptchaRelay(webhook_url=webhook)
    captcha_id = relay.send_captcha_to_discord(
        screenshot_path=args.screenshot,
        captcha_type=args.type,
        context=args.context
    )

    if captcha_id:
        print(f"CAPTCHA sent! ID: {captcha_id}")
        print("Waiting for solution...")
        # In real use, would wait for Discord bot response
    else:
        print("Failed to send CAPTCHA")
        sys.exit(1)
