/**
 * Vault Loader - Secure Key Management
 *
 * Loads vault master key from secure storage and initializes vault.
 * The key is loaded at runtime and never exposed to LLM context.
 *
 * Usage:
 *   const { initVaultFromSecure, getVault } = require('./security/vault_loader');
 *   await initVaultFromSecure();
 *   const apiKey = getVault().getInternal('ALPACA_API_KEY', 'trading-agent');
 */

const fs = require('fs');
const path = require('path');
const { vault } = require('./vault');

const SECURE_KEY_FILE = path.join(__dirname, '..', 'secure', 'vault_master.key');

let initialized = false;

/**
 * Initialize vault from secure key file
 * Key is loaded and used but never returned/logged
 */
function initVaultFromSecure() {
  if (initialized) {
    return true;
  }

  // Check for env var first (highest priority)
  if (process.env.VAULT_MASTER_KEY) {
    vault.init(process.env.VAULT_MASTER_KEY);
    initialized = true;
    return true;
  }

  // Load from secure file
  if (!fs.existsSync(SECURE_KEY_FILE)) {
    throw new Error('Vault master key not found. Set VAULT_MASTER_KEY env var or create secure/vault_master.key');
  }

  const key = fs.readFileSync(SECURE_KEY_FILE, 'utf8').trim();

  if (!key) {
    throw new Error('Vault master key file is empty');
  }

  vault.init(key);
  initialized = true;

  // Log initialization (without exposing key)
  console.log('[Vault] Initialized from secure key file');

  return true;
}

/**
 * Get initialized vault instance
 */
function getVault() {
  if (!initialized) {
    initVaultFromSecure();
  }
  return vault;
}

/**
 * Check if vault is initialized
 */
function isInitialized() {
  return initialized;
}

/**
 * Get a secret value (internal use - for code execution, not LLM context)
 */
function getSecret(name, agentId = 'orchestrator') {
  return getVault().getInternal(name, agentId);
}

/**
 * List available secrets (safe - shows refs only)
 */
function listSecrets() {
  return getVault().list();
}

/**
 * Set environment variables from vault secrets
 * Useful for subprocess execution
 */
function setEnvFromVault(secretNames) {
  const v = getVault();
  for (const name of secretNames) {
    try {
      process.env[name] = v.getInternal(name, 'vault_loader');
    } catch (e) {
      // Skip if not accessible
    }
  }
}

module.exports = {
  initVaultFromSecure,
  getVault,
  isInitialized,
  getSecret,
  listSecrets,
  setEnvFromVault,
  SECURE_KEY_FILE
};
