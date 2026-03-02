/**
 * Security Manager for Memory System v4
 *
 * Provides enterprise-grade security features:
 * - Input sanitization (SQL injection, XSS prevention)
 * - Optional AES-256-GCM encryption at rest
 * - Rate limiting per operation
 * - Audit logging with tamper detection
 * - Secure deletion (crypto-shred)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const SECURITY_CONFIG_FILE = path.join(CONFIG_DIR, 'security.json');

// Default security configuration
const DEFAULT_CONFIG = {
  // Encryption settings
  encryption: {
    enabled: false,
    algorithm: 'aes-256-gcm',
    keyDerivation: 'pbkdf2',
    iterations: 100000,
    saltLength: 32,
    ivLength: 16,
    tagLength: 16
  },

  // Rate limiting (requests per minute)
  rateLimits: {
    remember: 60,
    recall: 120,
    update: 60,
    delete: 30,
    default: 100
  },

  // Audit settings
  audit: {
    enabled: true,
    logSensitiveData: false,
    retentionDays: 90
  },

  // Sanitization
  sanitization: {
    maxContentLength: 100000,  // 100KB max content
    maxTagLength: 50,
    maxTagCount: 20,
    stripHtml: true,
    preventSqlInjection: true
  }
};

/**
 * Load security configuration
 */
function loadConfig() {
  try {
    if (fs.existsSync(SECURITY_CONFIG_FILE)) {
      const custom = JSON.parse(fs.readFileSync(SECURITY_CONFIG_FILE, 'utf8'));
      return { ...DEFAULT_CONFIG, ...custom };
    }
  } catch (e) {
    console.error('[Security] Failed to load config:', e.message);
  }
  return DEFAULT_CONFIG;
}

/**
 * Encryption Key Manager
 */
class KeyManager {
  constructor() {
    this.keyCache = new Map();
    this.masterKey = null;
  }

  /**
   * Derive encryption key from password using PBKDF2
   */
  deriveKey(password, salt, config = DEFAULT_CONFIG.encryption) {
    return crypto.pbkdf2Sync(
      password,
      salt,
      config.iterations,
      32, // 256 bits for AES-256
      'sha256'
    );
  }

  /**
   * Generate random salt
   */
  generateSalt(length = 32) {
    return crypto.randomBytes(length);
  }

  /**
   * Set master key from password
   */
  setMasterKey(password) {
    // Generate or retrieve salt
    const saltFile = path.join(CONFIG_DIR, '.encryption-salt');
    let salt;

    if (fs.existsSync(saltFile)) {
      salt = fs.readFileSync(saltFile);
    } else {
      salt = this.generateSalt();
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      fs.writeFileSync(saltFile, salt);
    }

    this.masterKey = this.deriveKey(password, salt);
  }

  /**
   * Get master key (must be set first)
   */
  getMasterKey() {
    if (!this.masterKey) {
      throw new Error('Master key not set. Call setMasterKey() first.');
    }
    return this.masterKey;
  }

  /**
   * Clear master key from memory
   */
  clearMasterKey() {
    if (this.masterKey) {
      crypto.randomFillSync(this.masterKey);
      this.masterKey = null;
    }
    this.keyCache.clear();
  }
}

/**
 * Encryption Service
 */
class EncryptionService {
  constructor(keyManager, config = DEFAULT_CONFIG.encryption) {
    this.keyManager = keyManager;
    this.config = config;
  }

  /**
   * Encrypt data
   */
  encrypt(plaintext) {
    if (!this.config.enabled) {
      return { encrypted: false, data: plaintext };
    }

    const key = this.keyManager.getMasterKey();
    const iv = crypto.randomBytes(this.config.ivLength);

    const cipher = crypto.createCipheriv(this.config.algorithm, key, iv, {
      authTagLength: this.config.tagLength
    });

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    return {
      encrypted: true,
      data: Buffer.concat([
        iv,
        authTag,
        Buffer.from(encrypted, 'base64')
      ]).toString('base64')
    };
  }

  /**
   * Decrypt data
   */
  decrypt(encryptedData, isEncrypted = true) {
    if (!isEncrypted || !this.config.enabled) {
      return encryptedData;
    }

    const key = this.keyManager.getMasterKey();
    const buffer = Buffer.from(encryptedData, 'base64');

    const iv = buffer.slice(0, this.config.ivLength);
    const authTag = buffer.slice(this.config.ivLength, this.config.ivLength + this.config.tagLength);
    const ciphertext = buffer.slice(this.config.ivLength + this.config.tagLength);

    const decipher = crypto.createDecipheriv(this.config.algorithm, key, iv, {
      authTagLength: this.config.tagLength
    });

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, null, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Check if encryption is enabled
   */
  isEnabled() {
    return this.config.enabled;
  }
}

/**
 * Input Sanitizer
 */
class Sanitizer {
  constructor(config = DEFAULT_CONFIG.sanitization) {
    this.config = config;
  }

  /**
   * Sanitize text content
   */
  sanitizeContent(content) {
    if (!content || typeof content !== 'string') {
      return '';
    }

    let sanitized = content;

    // Length limit
    if (sanitized.length > this.config.maxContentLength) {
      sanitized = sanitized.slice(0, this.config.maxContentLength);
    }

    // Strip HTML if enabled
    if (this.config.stripHtml) {
      sanitized = this.stripHtml(sanitized);
    }

    // Prevent SQL injection patterns
    if (this.config.preventSqlInjection) {
      sanitized = this.neutralizeSqlInjection(sanitized);
    }

    return sanitized.trim();
  }

  /**
   * Sanitize tag
   */
  sanitizeTag(tag) {
    if (!tag || typeof tag !== 'string') {
      return '';
    }

    // Remove special characters, keep alphanumeric, hyphens, underscores
    let sanitized = tag
      .toLowerCase()
      .replace(/[^a-z0-9\-_]/g, '')
      .slice(0, this.config.maxTagLength);

    return sanitized;
  }

  /**
   * Sanitize array of tags
   */
  sanitizeTags(tags) {
    if (!Array.isArray(tags)) {
      return [];
    }

    return tags
      .map(t => this.sanitizeTag(t))
      .filter(t => t.length > 0)
      .slice(0, this.config.maxTagCount);
  }

  /**
   * Sanitize ID
   */
  sanitizeId(id) {
    if (!id || typeof id !== 'string') {
      return '';
    }

    // IDs should only contain alphanumeric and certain safe characters
    return id.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64);
  }

  /**
   * Strip HTML tags
   */
  stripHtml(text) {
    return text
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'");
  }

  /**
   * Neutralize SQL injection patterns (for display, not execution)
   * Note: We use parameterized queries, this is extra defense
   */
  neutralizeSqlInjection(text) {
    // Escape single quotes
    return text.replace(/'/g, "''");
  }

  /**
   * Validate priority value
   */
  validatePriority(priority) {
    const valid = ['URGENT', 'DAILY', 'WEEKLY', 'ARCHIVE'];
    return valid.includes(priority) ? priority : 'DAILY';
  }

  /**
   * Validate status value
   */
  validateStatus(status, type = 'memory') {
    const memoryStatuses = ['active', 'completed', 'deleted'];
    const projectStatuses = ['planning', 'in_progress', 'blocked', 'completed', 'abandoned'];
    const stepStatuses = ['pending', 'in_progress', 'completed', 'skipped'];

    const valid = type === 'memory' ? memoryStatuses :
                  type === 'project' ? projectStatuses :
                  type === 'step' ? stepStatuses : memoryStatuses;

    return valid.includes(status) ? status : valid[0];
  }

  /**
   * Sanitize full memory input
   */
  sanitizeMemoryInput(input) {
    return {
      content: this.sanitizeContent(input.content || ''),
      priority: this.validatePriority(input.priority),
      tags: this.sanitizeTags(input.tags || []),
      expires_days: typeof input.expires_days === 'number' && input.expires_days > 0
        ? Math.min(input.expires_days, 365 * 10) // Max 10 years
        : null
    };
  }

  /**
   * Sanitize project input
   */
  sanitizeProjectInput(input) {
    return {
      name: this.sanitizeContent(input.name || '').slice(0, 200),
      description: this.sanitizeContent(input.description || '').slice(0, 5000),
      priority: this.validatePriority(input.priority),
      tags: this.sanitizeTags(input.tags || []),
      steps: Array.isArray(input.steps)
        ? input.steps.slice(0, 100).map(s =>
            typeof s === 'string'
              ? this.sanitizeContent(s).slice(0, 500)
              : { ...s, task: this.sanitizeContent(s.task || '').slice(0, 500) }
          )
        : []
    };
  }
}

/**
 * Rate Limiter
 */
class RateLimiter {
  constructor(config = DEFAULT_CONFIG.rateLimits) {
    this.config = config;
    this.requests = new Map(); // operation -> { count, resetTime }
  }

  /**
   * Check if operation is allowed
   */
  isAllowed(operation) {
    const limit = this.config[operation] || this.config.default;
    const now = Date.now();

    let entry = this.requests.get(operation);

    // Reset if minute has passed
    if (!entry || now >= entry.resetTime) {
      entry = { count: 0, resetTime: now + 60000 };
      this.requests.set(operation, entry);
    }

    if (entry.count >= limit) {
      return {
        allowed: false,
        retryAfter: Math.ceil((entry.resetTime - now) / 1000),
        limit,
        remaining: 0
      };
    }

    entry.count++;
    return {
      allowed: true,
      remaining: limit - entry.count,
      limit
    };
  }

  /**
   * Get current status for operation
   */
  getStatus(operation) {
    const limit = this.config[operation] || this.config.default;
    const entry = this.requests.get(operation);
    const now = Date.now();

    if (!entry || now >= entry.resetTime) {
      return { remaining: limit, limit, resetIn: 0 };
    }

    return {
      remaining: Math.max(0, limit - entry.count),
      limit,
      resetIn: Math.ceil((entry.resetTime - now) / 1000)
    };
  }

  /**
   * Reset limits for an operation
   */
  reset(operation) {
    this.requests.delete(operation);
  }

  /**
   * Reset all limits
   */
  resetAll() {
    this.requests.clear();
  }
}

/**
 * Secure Deletion
 */
class SecureDeletion {
  /**
   * Securely overwrite string in memory
   */
  static shredString(str) {
    if (!str || typeof str !== 'string') return;

    // In JavaScript, strings are immutable, but we can try to overwrite Buffer
    try {
      const buf = Buffer.from(str, 'utf8');
      crypto.randomFillSync(buf);
    } catch (e) {
      // Best effort
    }
  }

  /**
   * Securely delete file (overwrite then delete)
   */
  static async shredFile(filePath, passes = 3) {
    if (!fs.existsSync(filePath)) return;

    try {
      const stat = fs.statSync(filePath);
      const size = stat.size;

      const fd = fs.openSync(filePath, 'r+');

      for (let pass = 0; pass < passes; pass++) {
        const randomData = crypto.randomBytes(size);
        fs.writeSync(fd, randomData, 0, size, 0);
        fs.fsyncSync(fd);
      }

      // Final pass with zeros
      const zeros = Buffer.alloc(size, 0);
      fs.writeSync(fd, zeros, 0, size, 0);
      fs.fsyncSync(fd);

      fs.closeSync(fd);
      fs.unlinkSync(filePath);
    } catch (e) {
      // Fall back to regular delete
      fs.unlinkSync(filePath);
    }
  }
}

/**
 * Audit Logger
 */
class AuditLogger {
  constructor(config = DEFAULT_CONFIG.audit) {
    this.config = config;
    this.logDir = path.join(__dirname, '..', 'logs', 'audit');

    if (this.config.enabled && !fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Log an audit event
   */
  log(event) {
    if (!this.config.enabled) return;

    const entry = {
      timestamp: new Date().toISOString(),
      eventId: crypto.randomBytes(8).toString('hex'),
      ...event
    };

    // Remove sensitive data if configured
    if (!this.config.logSensitiveData) {
      if (entry.content) {
        entry.content = `[REDACTED - ${entry.content.length} chars]`;
      }
    }

    // Add integrity hash
    entry.hash = this._computeHash(entry);

    // Write to daily log file
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.logDir, `audit-${date}.jsonl`);

    try {
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.error('[AuditLogger] Failed to write:', e.message);
    }
  }

  /**
   * Compute integrity hash for audit entry
   */
  _computeHash(entry) {
    const data = JSON.stringify({
      timestamp: entry.timestamp,
      eventId: entry.eventId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId
    });

    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  }

  /**
   * Verify audit log integrity
   */
  verifyIntegrity(logFile) {
    if (!fs.existsSync(logFile)) return { valid: false, error: 'File not found' };

    try {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      const results = [];

      for (let i = 0; i < lines.length; i++) {
        const entry = JSON.parse(lines[i]);
        const expectedHash = entry.hash;
        delete entry.hash;
        const actualHash = this._computeHash(entry);

        results.push({
          line: i + 1,
          valid: expectedHash === actualHash,
          eventId: entry.eventId
        });
      }

      const allValid = results.every(r => r.valid);
      const invalidCount = results.filter(r => !r.valid).length;

      return {
        valid: allValid,
        totalEntries: lines.length,
        invalidEntries: invalidCount,
        details: results.filter(r => !r.valid)
      };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  /**
   * Clean up old audit logs
   */
  cleanup() {
    if (!fs.existsSync(this.logDir)) return;

    const cutoff = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);

    const files = fs.readdirSync(this.logDir);
    for (const file of files) {
      if (!file.startsWith('audit-')) continue;

      const filePath = path.join(this.logDir, file);
      const stat = fs.statSync(filePath);

      if (stat.mtime.getTime() < cutoff) {
        SecureDeletion.shredFile(filePath);
      }
    }
  }
}

/**
 * Security Manager - Main Interface
 */
class SecurityManager {
  constructor(config = null) {
    this.config = config || loadConfig();
    this.keyManager = new KeyManager();
    this.encryptionService = new EncryptionService(this.keyManager, this.config.encryption);
    this.sanitizer = new Sanitizer(this.config.sanitization);
    this.rateLimiter = new RateLimiter(this.config.rateLimits);
    this.auditLogger = new AuditLogger(this.config.audit);
  }

  /**
   * Initialize with encryption key (if encryption enabled)
   */
  init(password = null) {
    if (this.config.encryption.enabled && password) {
      this.keyManager.setMasterKey(password);
    }
  }

  /**
   * Check rate limit for operation
   */
  checkRateLimit(operation) {
    return this.rateLimiter.isAllowed(operation);
  }

  /**
   * Sanitize memory input
   */
  sanitizeMemory(input) {
    return this.sanitizer.sanitizeMemoryInput(input);
  }

  /**
   * Sanitize project input
   */
  sanitizeProject(input) {
    return this.sanitizer.sanitizeProjectInput(input);
  }

  /**
   * Sanitize ID
   */
  sanitizeId(id) {
    return this.sanitizer.sanitizeId(id);
  }

  /**
   * Encrypt content
   */
  encrypt(content) {
    return this.encryptionService.encrypt(content);
  }

  /**
   * Decrypt content
   */
  decrypt(content, isEncrypted) {
    return this.encryptionService.decrypt(content, isEncrypted);
  }

  /**
   * Log audit event
   */
  audit(action, entityType, entityId, details = {}) {
    this.auditLogger.log({
      action,
      entityType,
      entityId,
      ...details
    });
  }

  /**
   * Securely delete sensitive data
   */
  secureDelete(data) {
    SecureDeletion.shredString(data);
  }

  /**
   * Clean up old audit logs
   */
  cleanupAuditLogs() {
    this.auditLogger.cleanup();
  }

  /**
   * Verify audit log integrity
   */
  verifyAuditIntegrity(date = null) {
    const d = date || new Date().toISOString().split('T')[0];
    const logFile = path.join(this.auditLogger.logDir, `audit-${d}.jsonl`);
    return this.auditLogger.verifyIntegrity(logFile);
  }

  /**
   * Get security status
   */
  getStatus() {
    return {
      encryptionEnabled: this.config.encryption.enabled,
      auditEnabled: this.config.audit.enabled,
      rateLimits: { ...this.config.rateLimits }
    };
  }

  /**
   * Save configuration
   */
  saveConfig() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(SECURITY_CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  /**
   * Shutdown - clear sensitive data from memory
   */
  shutdown() {
    this.keyManager.clearMasterKey();
  }
}

// Singleton instance
let instance = null;

/**
 * Get security manager instance
 */
function getSecurityManager(config = null) {
  if (!instance || config) {
    instance = new SecurityManager(config);
  }
  return instance;
}

module.exports = {
  SecurityManager,
  KeyManager,
  EncryptionService,
  Sanitizer,
  RateLimiter,
  SecureDeletion,
  AuditLogger,
  getSecurityManager,
  loadConfig,
  DEFAULT_CONFIG,
  SECURITY_CONFIG_FILE
};
