"""
Input Sanitization Module
Protects against prompt injection and malicious inputs
"""

import re
import html
from typing import Optional, List, Dict, Any


class InputSanitizer:
    """Sanitizes user inputs to prevent prompt injection and other attacks."""

    # Patterns that might indicate prompt injection attempts
    INJECTION_PATTERNS = [
        r'ignore\s+(previous|above|all)\s+instructions?',
        r'disregard\s+(previous|above|all)',
        r'forget\s+(everything|all|previous)',
        r'you\s+are\s+now\s+',
        r'act\s+as\s+(if|a|an)',
        r'pretend\s+(you|to\s+be)',
        r'new\s+instructions?:',
        r'system\s*:\s*',
        r'\[INST\]',
        r'\[/INST\]',
        r'<\|.*?\|>',
        r'###\s*(instruction|system|user)',
        r'ADMIN\s*MODE',
        r'DEBUG\s*MODE',
        r'sudo\s+',
        r'rm\s+-rf',
        r'eval\s*\(',
        r'exec\s*\(',
        r'__import__',
        r'subprocess',
        r'os\.system',
    ]

    # Dangerous shell patterns
    SHELL_DANGEROUS_PATTERNS = [
        r';\s*rm\s',
        r'\|\s*rm\s',
        r'`[^`]*rm[^`]*`',
        r'\$\([^)]*rm[^)]*\)',
        r'>\s*/dev/sd',
        r'dd\s+if=',
        r'mkfs\.',
        r'format\s+[a-z]:',
        r'del\s+/[fsq]',
        r'rd\s+/s',
    ]

    def __init__(self, strict_mode: bool = True):
        self.strict_mode = strict_mode
        self._compiled_injection = [re.compile(p, re.IGNORECASE) for p in self.INJECTION_PATTERNS]
        self._compiled_shell = [re.compile(p, re.IGNORECASE) for p in self.SHELL_DANGEROUS_PATTERNS]

    def check_prompt_injection(self, text: str) -> Dict[str, Any]:
        """
        Check for potential prompt injection attempts.

        Returns:
            Dict with 'safe' boolean and 'matches' list of detected patterns
        """
        matches = []
        for i, pattern in enumerate(self._compiled_injection):
            if pattern.search(text):
                matches.append(self.INJECTION_PATTERNS[i])

        return {
            'safe': len(matches) == 0,
            'matches': matches,
            'risk_level': 'high' if matches else 'low'
        }

    def check_shell_command(self, command: str) -> Dict[str, Any]:
        """
        Check shell command for dangerous patterns.

        Returns:
            Dict with 'safe' boolean and 'matches' list
        """
        matches = []
        for i, pattern in enumerate(self._compiled_shell):
            if pattern.search(command):
                matches.append(self.SHELL_DANGEROUS_PATTERNS[i])

        return {
            'safe': len(matches) == 0,
            'matches': matches,
            'risk_level': 'critical' if matches else 'low'
        }

    def sanitize_for_shell(self, text: str) -> str:
        """Escape special characters for safe shell usage."""
        # Remove null bytes
        text = text.replace('\x00', '')
        # Escape shell metacharacters
        dangerous_chars = ['`', '$', '!', '&', '|', ';', '>', '<', '(', ')', '{', '}', '[', ']', '\\', '"', "'", '\n']
        for char in dangerous_chars:
            text = text.replace(char, '\\' + char)
        return text

    def sanitize_html(self, text: str) -> str:
        """Escape HTML entities to prevent XSS."""
        return html.escape(text)

    def sanitize_path(self, path: str) -> Optional[str]:
        """
        Sanitize file path to prevent directory traversal.

        Returns None if path is dangerous.
        """
        # Normalize path
        path = path.replace('\\', '/')

        # Check for directory traversal
        if '..' in path:
            return None

        # Check for absolute paths to sensitive locations
        sensitive_patterns = [
            r'^/etc/',
            r'^/root/',
            r'^/var/log/',
            r'^C:\\Windows\\',
            r'^C:\\Program Files',
            r'\.ssh/',
            r'\.gnupg/',
            r'\.aws/',
        ]

        for pattern in sensitive_patterns:
            if re.match(pattern, path, re.IGNORECASE):
                return None

        return path

    def validate_url(self, url: str) -> Dict[str, Any]:
        """
        Validate URL for security concerns.
        """
        result = {
            'safe': True,
            'warnings': [],
            'blocked': False
        }

        # Check for localhost/internal IPs (SSRF protection)
        internal_patterns = [
            r'localhost',
            r'127\.0\.0\.',
            r'192\.168\.',
            r'10\.\d+\.',
            r'172\.(1[6-9]|2\d|3[01])\.',
            r'0\.0\.0\.0',
            r'\[::1\]',
        ]

        for pattern in internal_patterns:
            if re.search(pattern, url, re.IGNORECASE):
                result['safe'] = False
                result['blocked'] = True
                result['warnings'].append(f'Internal/localhost URL detected: {pattern}')

        # Check for suspicious protocols
        if not url.startswith(('http://', 'https://')):
            if url.startswith(('file://', 'ftp://', 'data:')):
                result['safe'] = False
                result['blocked'] = True
                result['warnings'].append('Potentially dangerous protocol')

        return result


class RateLimiter:
    """Simple rate limiter to prevent abuse."""

    def __init__(self, max_requests: int = 100, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests: Dict[str, List[float]] = {}

    def is_allowed(self, identifier: str) -> bool:
        """Check if request is allowed under rate limit."""
        import time
        now = time.time()

        if identifier not in self.requests:
            self.requests[identifier] = []

        # Clean old requests
        self.requests[identifier] = [
            t for t in self.requests[identifier]
            if now - t < self.window_seconds
        ]

        if len(self.requests[identifier]) >= self.max_requests:
            return False

        self.requests[identifier].append(now)
        return True


# Singleton instance
sanitizer = InputSanitizer()


def is_safe_input(text: str) -> bool:
    """Quick check if input is safe."""
    result = sanitizer.check_prompt_injection(text)
    return result['safe']


def is_safe_command(command: str) -> bool:
    """Quick check if shell command is safe."""
    result = sanitizer.check_shell_command(command)
    return result['safe']
