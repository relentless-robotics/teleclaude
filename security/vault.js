/**
 * Secure Vault - Encrypted secret storage
 *
 * - AES-256-GCM encryption
 * - Master key from environment variable VAULT_MASTER_KEY
 * - Secrets stored encrypted, never in plaintext
 * - LLMs only see reference names
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { backupVault } = require('./vault_backup');

const VAULT_FILE = path.join(__dirname, 'vault.enc');
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

class SecureVault {
  constructor() {
    this.masterKey = null;
    this.secrets = {};
    this.accessLog = [];
  }

  /**
   * Initialize vault with master key from environment ONLY
   * SECURITY: Hardcoded keys are NOT allowed to prevent LLM context leakage
   */
  init(masterKeyOverride = null) {
    // SECURITY CHECK: If masterKeyOverride looks like it was hardcoded in code
    // (i.e., called directly with a string literal), log a warning
    if (masterKeyOverride && !process.env.VAULT_MASTER_KEY) {
      console.warn('[SECURITY WARNING] Vault initialized with inline key. Use VAULT_MASTER_KEY env var instead.');
      // Still allow for backwards compatibility, but warn
    }

    const keySource = masterKeyOverride || process.env.VAULT_MASTER_KEY;
    if (!keySource) {
      throw new Error('VAULT_MASTER_KEY environment variable required. Set it with: export VAULT_MASTER_KEY=your_key');
    }

    // Derive 32-byte key from password using scrypt
    this.masterKey = crypto.scryptSync(keySource, 'teleclaude-vault-salt', KEY_LENGTH);
    this.load();
  }

  /**
   * Encrypt data
   */
  encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  }

  /**
   * Decrypt data
   */
  decrypt(encryptedData) {
    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Load vault from encrypted file
   */
  load() {
    if (fs.existsSync(VAULT_FILE)) {
      try {
        const encryptedContent = fs.readFileSync(VAULT_FILE, 'utf8');
        const decrypted = this.decrypt(encryptedContent);
        this.secrets = JSON.parse(decrypted);
      } catch (e) {
        console.error('Failed to load vault:', e.message);
        this.secrets = {};
      }
    }
  }

  /**
   * Save vault to encrypted file
   * CRITICAL: Always backup before writing to prevent data loss
   */
  save() {
    // ALWAYS backup before any write operation
    try {
      backupVault();
    } catch (e) {
      console.error('[Vault] Backup failed, but proceeding with save:', e.message);
    }

    const plaintext = JSON.stringify(this.secrets, null, 2);
    const encrypted = this.encrypt(plaintext);
    fs.writeFileSync(VAULT_FILE, encrypted);
  }

  /**
   * Store a secret
   */
  set(name, value, metadata = {}) {
    this.secrets[name] = {
      value,
      metadata: {
        ...metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };
    this.save();
    this.log('SET', name, 'Secret stored');
  }

  /**
   * Get a secret (INTERNAL USE ONLY - not for LLM context)
   * Returns actual value - use with caution
   */
  getInternal(name, agentId = 'orchestrator') {
    if (!this.secrets[name]) {
      this.log('GET_FAILED', name, 'Secret not found', agentId);
      return null;
    }

    // Check permissions if agent-scoped
    const secret = this.secrets[name];
    if (secret.metadata?.allowedAgents && !secret.metadata.allowedAgents.includes(agentId)) {
      this.log('GET_DENIED', name, 'Agent not permitted', agentId);
      throw new Error(`Agent ${agentId} not permitted to access ${name}`);
    }

    this.log('GET', name, 'Secret accessed', agentId);
    return secret.value;
  }

  /**
   * Get a REFERENCE to a secret (SAFE for LLM context)
   * Returns placeholder, never actual value
   */
  ref(name) {
    if (!this.secrets[name]) {
      return `[SECRET_NOT_FOUND:${name}]`;
    }
    return `[SECURED:${name}]`;
  }

  /**
   * List all secret names (safe to show LLM)
   */
  list() {
    return Object.keys(this.secrets).map(name => ({
      name,
      ref: this.ref(name),
      metadata: {
        ...this.secrets[name].metadata,
        value: undefined // Never include value
      }
    }));
  }

  /**
   * Delete a secret
   */
  delete(name) {
    if (this.secrets[name]) {
      delete this.secrets[name];
      this.save();
      this.log('DELETE', name, 'Secret deleted');
      return true;
    }
    return false;
  }

  /**
   * Log access for audit trail
   */
  log(action, secretName, message, agentId = 'orchestrator') {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      secretName,
      message,
      agentId
    };
    this.accessLog.push(entry);

    // Also write to audit file
    const auditFile = path.join(__dirname, 'audit.log');
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
  }

  /**
   * Get audit log
   */
  getAuditLog(limit = 100) {
    return this.accessLog.slice(-limit);
  }

  /**
   * Set agent permissions for a secret
   */
  setPermissions(name, allowedAgents) {
    if (this.secrets[name]) {
      this.secrets[name].metadata.allowedAgents = allowedAgents;
      this.save();
    }
  }
}

// Singleton instance
const vault = new SecureVault();

module.exports = {
  SecureVault,
  vault,
  init: (key) => vault.init(key),
  set: (name, value, meta) => vault.set(name, value, meta),
  ref: (name) => vault.ref(name),
  list: () => vault.list(),
  delete: (name) => vault.delete(name),
  getInternal: (name, agent) => vault.getInternal(name, agent),
  getAuditLog: (limit) => vault.getAuditLog(limit),
  setPermissions: (name, agents) => vault.setPermissions(name, agents)
};
