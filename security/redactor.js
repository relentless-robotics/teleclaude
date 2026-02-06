/**
 * Redaction Engine
 *
 * Automatically scrubs sensitive data from any output
 * before it reaches LLM context or logs
 */

const path = require('path');

class Redactor {
  constructor() {
    this.patterns = [];
    this.customPatterns = [];
    this.vaultRef = null;
  }

  /**
   * Lazy-load vault to avoid circular dependency
   */
  getVault() {
    if (!this.vaultRef) {
      this.vaultRef = require('./vault').vault;
    }
    return this.vaultRef;
  }

  /**
   * Build regex patterns from vault secrets
   */
  buildPatterns() {
    this.patterns = [];

    // Get all secret values and create patterns
    try {
      const vault = this.getVault();
      const secrets = vault.list();
      for (const secret of secrets) {
        try {
          const value = vault.getInternal(secret.name, 'redactor');
          if (value && value.length > 4) {
            // Escape regex special chars
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            this.patterns.push({
              name: secret.name,
              regex: new RegExp(escaped, 'g'),
              replacement: `[REDACTED:${secret.name}]`
            });
          }
        } catch (e) {
          // Skip if can't access
        }
      }
    } catch (e) {
      // Vault not initialized yet
    }

    // Add common patterns for things that look like secrets
    this.patterns.push(
      { name: 'api_key', regex: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED:API_KEY]' },
      { name: 'bearer', regex: /Bearer\s+[a-zA-Z0-9\-_.]+/gi, replacement: '[REDACTED:BEARER_TOKEN]' },
      { name: 'password', regex: /password['":\s=]+['"]?[^'"\s,}]{8,}['"]?/gi, replacement: 'password=[REDACTED]' },
      { name: 'secret', regex: /secret['":\s=]+['"]?[^'"\s,}]{8,}['"]?/gi, replacement: 'secret=[REDACTED]' },
      { name: 'aws_key', regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED:AWS_KEY]' },
      { name: 'private_key', regex: /-----BEGIN [A-Z]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z]+ PRIVATE KEY-----/g, replacement: '[REDACTED:PRIVATE_KEY]' },
      { name: 'jwt', regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g, replacement: '[REDACTED:JWT_TOKEN]' },
      { name: 'github_token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g, replacement: '[REDACTED:GITHUB_TOKEN]' },
      { name: 'slack_token', regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/g, replacement: '[REDACTED:SLACK_TOKEN]' },
      { name: 'credit_card', regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '[REDACTED:CREDIT_CARD]' },
      { name: 'email_password', regex: /(password|passwd|pwd)[\s:=]+[^\s]{6,}/gi, replacement: '$1=[REDACTED]' }
    );

    // Add custom patterns
    this.patterns.push(...this.customPatterns);
  }

  /**
   * Add custom redaction pattern
   */
  addPattern(name, regex, replacement) {
    this.customPatterns.push({ name, regex, replacement });
  }

  /**
   * Redact sensitive data from text
   */
  redact(text) {
    if (!text || typeof text !== 'string') return text;

    this.buildPatterns();

    let redacted = text;
    const redactions = [];

    for (const pattern of this.patterns) {
      const matches = redacted.match(pattern.regex);
      if (matches) {
        redactions.push({ pattern: pattern.name, count: matches.length });
        redacted = redacted.replace(pattern.regex, pattern.replacement);
      }
    }

    return {
      text: redacted,
      redactions,
      wasRedacted: redactions.length > 0
    };
  }

  /**
   * Redact and return just the text
   */
  clean(text) {
    return this.redact(text).text;
  }

  /**
   * Create a safe logger that auto-redacts
   */
  createSafeLogger(baseLogger = console) {
    const self = this;
    return {
      log: (...args) => baseLogger.log(...args.map(a => typeof a === 'string' ? self.clean(a) : a)),
      error: (...args) => baseLogger.error(...args.map(a => typeof a === 'string' ? self.clean(a) : a)),
      warn: (...args) => baseLogger.warn(...args.map(a => typeof a === 'string' ? self.clean(a) : a)),
      info: (...args) => baseLogger.info(...args.map(a => typeof a === 'string' ? self.clean(a) : a)),
    };
  }
}

const redactor = new Redactor();

module.exports = {
  Redactor,
  redactor,
  redact: (text) => redactor.redact(text),
  clean: (text) => redactor.clean(text),
  addPattern: (name, regex, replacement) => redactor.addPattern(name, regex, replacement),
  createSafeLogger: (logger) => redactor.createSafeLogger(logger)
};
