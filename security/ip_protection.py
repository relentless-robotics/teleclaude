"""
IP Protection Module
Helps protect against IP exposure during web browsing
"""

import subprocess
import platform
import json
from typing import Optional, Dict, Any


class IPProtection:
    """Manages IP protection for browser automation."""

    def __init__(self):
        self.system = platform.system().lower()

    def get_current_ip(self) -> Optional[str]:
        """Get current public IP address."""
        try:
            import urllib.request
            with urllib.request.urlopen('https://api.ipify.org?format=json', timeout=5) as response:
                data = json.loads(response.read().decode())
                return data.get('ip')
        except Exception:
            return None

    def check_tor_available(self) -> bool:
        """Check if Tor is available on the system."""
        try:
            if self.system == 'windows':
                result = subprocess.run(['where', 'tor'], capture_output=True, text=True)
            else:
                result = subprocess.run(['which', 'tor'], capture_output=True, text=True)
            return result.returncode == 0
        except Exception:
            return False

    def get_proxy_config_for_playwright(self, proxy_type: str = 'none') -> Optional[Dict[str, str]]:
        """
        Get proxy configuration for Playwright browser.

        Args:
            proxy_type: 'none', 'tor', 'custom'

        Returns:
            Proxy config dict for Playwright or None
        """
        if proxy_type == 'none':
            return None

        if proxy_type == 'tor':
            # Default Tor SOCKS5 proxy
            return {
                'server': 'socks5://127.0.0.1:9050'
            }

        return None

    def get_browser_args_for_privacy(self) -> list:
        """Get browser arguments for enhanced privacy."""
        return [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-gpu',
            '--disable-infobars',
            '--disable-notifications',
            '--disable-popup-blocking',
            '--disable-save-password-bubble',
            '--disable-translate',
            '--no-first-run',
            '--no-sandbox',
            '--start-maximized',
            # Privacy-specific
            '--disable-background-networking',
            '--disable-client-side-phishing-detection',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-sync',
            '--metrics-recording-only',
            '--safebrowsing-disable-auto-update',
        ]

    def get_stealth_context_options(self) -> Dict[str, Any]:
        """Get context options to make browser appear more human-like."""
        return {
            'viewport': {'width': 1920, 'height': 1080},
            'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'locale': 'en-US',
            'timezone_id': 'America/New_York',
            'geolocation': None,
            'permissions': [],
            'extra_http_headers': {
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }


class NetworkSecurity:
    """Network security utilities."""

    @staticmethod
    def is_internal_ip(ip: str) -> bool:
        """Check if IP is internal/private."""
        import ipaddress
        try:
            ip_obj = ipaddress.ip_address(ip)
            return ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_reserved
        except ValueError:
            return False

    @staticmethod
    def validate_outbound_url(url: str) -> Dict[str, Any]:
        """
        Validate if URL is safe for outbound request.
        Prevents SSRF attacks.
        """
        from urllib.parse import urlparse
        import socket

        result = {
            'safe': True,
            'reason': None
        }

        try:
            parsed = urlparse(url)
            hostname = parsed.hostname

            if not hostname:
                result['safe'] = False
                result['reason'] = 'No hostname found'
                return result

            # Check for internal hostnames
            internal_hosts = ['localhost', 'internal', 'intranet', '127.0.0.1', '0.0.0.0']
            if any(h in hostname.lower() for h in internal_hosts):
                result['safe'] = False
                result['reason'] = 'Internal hostname detected'
                return result

            # Resolve and check IP
            try:
                ip = socket.gethostbyname(hostname)
                if NetworkSecurity.is_internal_ip(ip):
                    result['safe'] = False
                    result['reason'] = f'Hostname resolves to internal IP: {ip}'
                    return result
            except socket.gaierror:
                # Can't resolve - might be okay, let it through with warning
                result['warning'] = 'Could not resolve hostname'

        except Exception as e:
            result['safe'] = False
            result['reason'] = f'URL parsing error: {str(e)}'

        return result


# Utility functions
ip_protection = IPProtection()
network_security = NetworkSecurity()


def get_safe_browser_config() -> Dict[str, Any]:
    """Get a safe browser configuration for Playwright."""
    return {
        'args': ip_protection.get_browser_args_for_privacy(),
        'context_options': ip_protection.get_stealth_context_options()
    }
