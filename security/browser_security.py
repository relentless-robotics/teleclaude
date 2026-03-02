"""
Browser Security Module
Protects against ads, popups, malicious JavaScript, and other threats.
"""

import re
from typing import List, Dict, Any, Optional


class BrowserSecurity:
    """Security configuration for browser automation."""

    # Common ad/tracking domains to block
    AD_DOMAINS = [
        'doubleclick.net',
        'googlesyndication.com',
        'googleadservices.com',
        'google-analytics.com',
        'googletagmanager.com',
        'facebook.net',
        'fbcdn.net',
        'analytics.',
        'tracker.',
        'tracking.',
        'ad.',
        'ads.',
        'adserver.',
        'advertising.',
        'banner.',
        'pixel.',
        'beacon.',
        'telemetry.',
        'metrics.',
        'taboola.com',
        'outbrain.com',
        'criteo.com',
        'adnxs.com',
        'pubmatic.com',
        'rubiconproject.com',
        'openx.net',
        'bidswitch.net',
        'casalemedia.com',
        'quantserve.com',
        'scorecardresearch.com',
        'amazon-adsystem.com',
    ]

    # Malicious popup patterns
    POPUP_PATTERNS = [
        r'window\.open\s*\(',
        r'window\.alert\s*\(',
        r'window\.confirm\s*\(',
        r'window\.prompt\s*\(',
        r'document\.write\s*\(',
        r'eval\s*\(',
        r'setTimeout\s*\(\s*["\']',
        r'setInterval\s*\(\s*["\']',
    ]

    # Suspicious URL patterns
    SUSPICIOUS_URLS = [
        r'\.exe$',
        r'\.scr$',
        r'\.bat$',
        r'\.cmd$',
        r'\.msi$',
        r'download.*\?.*redirect',
        r'click.*track',
        r'redirect\.',
        r'bit\.ly',
        r'tinyurl\.com',
        r'goo\.gl',
    ]

    # Elements that are often malicious/annoying
    BLOCK_SELECTORS = [
        '[class*="popup"]',
        '[class*="modal"]',
        '[class*="overlay"]',
        '[id*="popup"]',
        '[id*="modal"]',
        '[id*="overlay"]',
        '[class*="newsletter"]',
        '[class*="subscribe"]',
        '[class*="cookie-banner"]',
        '[class*="gdpr"]',
        '[class*="consent"]',
        'iframe[src*="ad"]',
        'iframe[src*="banner"]',
        'div[class*="ad-"]',
        'div[id*="ad-"]',
    ]

    def __init__(self):
        self._compiled_popup_patterns = [re.compile(p, re.IGNORECASE) for p in self.POPUP_PATTERNS]
        self._compiled_url_patterns = [re.compile(p, re.IGNORECASE) for p in self.SUSPICIOUS_URLS]

    def get_blocked_domains(self) -> List[str]:
        """Get list of domains to block."""
        return self.AD_DOMAINS.copy()

    def should_block_url(self, url: str) -> bool:
        """Check if URL should be blocked."""
        url_lower = url.lower()

        # Check against ad domains
        for domain in self.AD_DOMAINS:
            if domain in url_lower:
                return True

        # Check suspicious patterns
        for pattern in self._compiled_url_patterns:
            if pattern.search(url):
                return True

        return False

    def get_content_security_headers(self) -> Dict[str, str]:
        """Get secure headers to inject."""
        return {
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'X-XSS-Protection': '1; mode=block',
        }

    def get_ad_block_script(self) -> str:
        """JavaScript to inject for blocking ads and popups."""
        return '''
        (function() {
            // Block popups
            window.open = function() { console.log('Popup blocked'); return null; };

            // Block alerts/confirms/prompts (optional - can be annoying)
            // window.alert = function() { console.log('Alert blocked'); };
            // window.confirm = function() { console.log('Confirm blocked'); return false; };
            // window.prompt = function() { console.log('Prompt blocked'); return null; };

            // Remove annoying elements
            const selectors = [
                '[class*="popup"]',
                '[class*="modal"]:not([class*="login"])',
                '[class*="overlay"]:not([class*="login"])',
                '[class*="newsletter"]',
                '[class*="subscribe"]',
                '[class*="cookie"]',
                '[class*="gdpr"]',
                '[class*="consent"]',
                'iframe[src*="ad"]',
                'div[class*="ad-"]'
            ];

            function removeElements() {
                selectors.forEach(selector => {
                    try {
                        document.querySelectorAll(selector).forEach(el => {
                            // Don't remove if it's the main content
                            if (el.offsetWidth < window.innerWidth * 0.9) {
                                el.style.display = 'none';
                            }
                        });
                    } catch(e) {}
                });
            }

            // Run on load and periodically
            removeElements();
            setInterval(removeElements, 2000);

            // Block document.write after load
            window.addEventListener('load', function() {
                document.write = function() { console.log('document.write blocked'); };
            });

            console.log('Ad/popup blocker active');
        })();
        '''

    def get_playwright_route_handler(self):
        """Get a route handler function for Playwright to block ads."""
        blocked_domains = self.get_blocked_domains()

        async def route_handler(route):
            url = route.request.url.lower()

            # Check if should block
            for domain in blocked_domains:
                if domain in url:
                    await route.abort()
                    return

            # Allow everything else
            await route.continue_()

        return route_handler

    def get_safe_browser_args(self) -> List[str]:
        """Get browser arguments for security."""
        return [
            '--disable-popup-blocking',  # We handle it ourselves
            '--disable-notifications',
            '--disable-infobars',
            '--disable-extensions',
            '--disable-plugins',
            '--disable-translate',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-default-apps',
            '--no-first-run',
            '--disable-client-side-phishing-detection',
            '--safebrowsing-disable-auto-update',
            # Security
            '--disable-webgl',  # Can be used for fingerprinting
            '--disable-reading-from-canvas',  # Fingerprinting
        ]


def get_playwright_security_config() -> Dict[str, Any]:
    """Get complete Playwright configuration with security settings."""
    security = BrowserSecurity()

    return {
        'browser_args': security.get_safe_browser_args(),
        'blocked_domains': security.get_blocked_domains(),
        'inject_script': security.get_ad_block_script(),
        'block_selectors': security.BLOCK_SELECTORS,
    }


async def setup_secure_browser_context(browser, security: BrowserSecurity = None):
    """
    Set up a secure browser context with ad blocking.

    Usage with Playwright:
        browser = await playwright.chromium.launch()
        context = await setup_secure_browser_context(browser)
        page = await context.new_page()
    """
    security = security or BrowserSecurity()

    context = await browser.new_context(
        java_script_enabled=True,
        bypass_csp=False,  # Don't bypass Content Security Policy
        extra_http_headers=security.get_content_security_headers(),
    )

    # Set up request interception for ad blocking
    await context.route('**/*', security.get_playwright_route_handler())

    # Inject ad-blocking script on every page
    await context.add_init_script(security.get_ad_block_script())

    return context


# Export singleton
browser_security = BrowserSecurity()
