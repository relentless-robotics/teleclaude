/**
 * Secure Credentials Module
 *
 * Central module for loading credentials from the encrypted vault.
 * All automation scripts should import credentials from here instead of hardcoding them.
 *
 * Usage:
 *   const creds = require('./utils/secure_creds');
 *   await page.fill('input[name="password"]', creds.github.password);
 */

const path = require('path');

// Cache for credentials to avoid repeated vault initialization
let _credentials = null;
let _initialized = false;

/**
 * Initialize and load all credentials from vault
 */
function initCredentials() {
  if (_initialized) return _credentials;

  try {
    const { vault } = require('../security/vault');
    const masterKey = process.env.VAULT_MASTER_KEY;

    if (!masterKey) {
      console.warn('[secure_creds] VAULT_MASTER_KEY not set - using placeholders');
      return getPlaceholders();
    }

    vault.init(masterKey);

    _credentials = {
      alpaca: {
        email: vault.getInternal('ALPACA_EMAIL'),
        altEmail: vault.getInternal('ALPACA_ALT_EMAIL'),
        password: vault.getInternal('ALPACA_PASSWORD')
      },
      github: {
        email: vault.getInternal('GITHUB_EMAIL'),
        password: vault.getInternal('GITHUB_PASSWORD'),
        pat: vault.getInternal('GITHUB_PAT'),
        username: 'relentless-robotics' // Username is not a secret
      },
      google: {
        email: vault.getInternal('GOOGLE_EMAIL'),
        password: vault.getInternal('GOOGLE_PASSWORD')
      },
      system: {
        wslPassword: vault.getInternal('WSL_PASSWORD')
      }
    };

    _initialized = true;
    return _credentials;
  } catch (e) {
    console.error('[secure_creds] Failed to load vault:', e.message);
    return getPlaceholders();
  }
}

/**
 * Return placeholder values when vault is unavailable
 */
function getPlaceholders() {
  return {
    alpaca: {
      email: '[SECURED:ALPACA_EMAIL]',
      altEmail: '[SECURED:ALPACA_ALT_EMAIL]',
      password: '[SECURED:ALPACA_PASSWORD]'
    },
    github: {
      email: '[SECURED:GITHUB_EMAIL]',
      password: '[SECURED:GITHUB_PASSWORD]',
      pat: '[SECURED:GITHUB_PAT]',
      username: 'relentless-robotics'
    },
    google: {
      email: '[SECURED:GOOGLE_EMAIL]',
      password: '[SECURED:GOOGLE_PASSWORD]'
    },
    system: {
      wslPassword: '[SECURED:WSL_PASSWORD]'
    }
  };
}

// Initialize on module load
const credentials = initCredentials();

// Export both the credentials object and individual getters
module.exports = {
  // Direct access (cached)
  ...credentials,

  // Re-initialize (useful if env var set after module load)
  reload: () => {
    _initialized = false;
    _credentials = null;
    return initCredentials();
  },

  // Check if vault is available
  isSecure: () => _initialized && _credentials !== null,

  // Get a specific credential by path (e.g., 'github.password')
  get: (path) => {
    const parts = path.split('.');
    let value = credentials;
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }
};
