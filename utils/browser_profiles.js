/**
 * Browser Profile Manager
 *
 * Manages multiple browser auth profiles for different services.
 * Handles saving, loading, and validating authentication states.
 *
 * @module utils/browser_profiles
 */

const fs = require('fs');
const creds = require('./secure_creds');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const BROWSER_STATE_DIR = path.join(__dirname, '..', 'browser_state');
const PROFILE_METADATA_FILE = path.join(BROWSER_STATE_DIR, 'profiles.json');

// Auth expiry time (30 days)
const AUTH_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

// Ensure directory exists
if (!fs.existsSync(BROWSER_STATE_DIR)) {
  fs.mkdirSync(BROWSER_STATE_DIR, { recursive: true });
}

// ============================================================================
// CREDENTIAL MAPPINGS
// ============================================================================

// Load credentials from vault at runtime
function loadCredentialsFromVault() {
  const { getInternal } = require('../security/vault');

  return {
    google: {
      email: creds.google.email,
      password: getInternal('GOOGLE_MASTER_PASSWORD'),
      domains: ['google.com', 'accounts.google.com', 'gmail.com']
    },
    github: {
      email: creds.google.email,
      password: getInternal('GITHUB_PASSWORD'),
      domains: ['github.com']
    },
    gumroad: {
      email: creds.google.email,
      password: getInternal('GUMROAD_PASSWORD'),
      domains: ['gumroad.com']
    },
    pinterest: {
      useGoogleOAuth: true,
      email: creds.google.email,
      domains: ['pinterest.com']
    },
    vercel: {
      useGoogleOAuth: true,
      email: creds.google.email,
      domains: ['vercel.com']
    },
    twitter: {
      email: creds.google.email,
      password: getInternal('TWITTER_PASSWORD'),
      domains: ['twitter.com', 'x.com']
    }
  };
}

const CREDENTIALS = loadCredentialsFromVault();

// ============================================================================
// LOGIN SELECTORS
// ============================================================================

const LOGIN_SELECTORS = {
  google: {
    email: 'input[type="email"]',
    emailNext: '#identifierNext',
    password: 'input[type="password"]',
    passwordNext: '#passwordNext',
    submit: 'button[type="submit"]'
  },
  github: {
    email: '#login_field',
    password: '#password',
    submit: 'input[type="submit"], button[type="submit"]'
  },
  twitter: {
    email: 'input[autocomplete="username"]',
    password: 'input[type="password"]',
    submit: '[data-testid="LoginForm_Login_Button"]'
  },
  gumroad: {
    email: '#email',
    password: '#password',
    submit: 'button[type="submit"]'
  },
  pinterest: {
    email: '#email',
    password: '#password',
    submit: 'button[type="submit"]'
  }
};

// ============================================================================
// PROFILE METADATA MANAGEMENT
// ============================================================================

/**
 * Load profile metadata
 */
function loadMetadata() {
  if (!fs.existsSync(PROFILE_METADATA_FILE)) {
    return {};
  }

  try {
    const data = fs.readFileSync(PROFILE_METADATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Failed to load profile metadata:', error.message);
    return {};
  }
}

/**
 * Save profile metadata
 */
function saveMetadata(metadata) {
  try {
    fs.writeFileSync(PROFILE_METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save profile metadata:', error.message);
  }
}

/**
 * Update profile metadata entry
 */
function updateProfileMetadata(profileName, updates) {
  const metadata = loadMetadata();

  if (!metadata[profileName]) {
    metadata[profileName] = {
      created: new Date().toISOString(),
      lastUsed: null,
      lastSaved: null,
      domains: []
    };
  }

  Object.assign(metadata[profileName], updates);
  saveMetadata(metadata);
}

// ============================================================================
// AUTH STATE MANAGEMENT
// ============================================================================

/**
 * Get auth state file path for a profile
 */
function getAuthStatePath(profileName) {
  return path.join(BROWSER_STATE_DIR, `${profileName}_auth.json`);
}

/**
 * Save auth state from context
 */
async function saveAuthState(context, profileName) {
  const filepath = getAuthStatePath(profileName);

  try {
    const state = await context.storageState();
    fs.writeFileSync(filepath, JSON.stringify(state, null, 2), 'utf-8');

    updateProfileMetadata(profileName, {
      lastSaved: new Date().toISOString(),
      lastUsed: new Date().toISOString()
    });

    console.log(`Auth state saved for profile: ${profileName}`);
    return true;
  } catch (error) {
    console.error(`Failed to save auth state for ${profileName}:`, error.message);
    return false;
  }
}

/**
 * Load auth state for a profile
 */
function loadAuthState(profileName) {
  const filepath = getAuthStatePath(profileName);

  if (!fs.existsSync(filepath)) {
    console.log(`No auth state found for profile: ${profileName}`);
    return null;
  }

  try {
    const data = fs.readFileSync(filepath, 'utf-8');
    const state = JSON.parse(data);

    updateProfileMetadata(profileName, {
      lastUsed: new Date().toISOString()
    });

    console.log(`Auth state loaded for profile: ${profileName}`);
    return state;
  } catch (error) {
    console.error(`Failed to load auth state for ${profileName}:`, error.message);
    return null;
  }
}

/**
 * Check if auth state exists and is fresh
 */
function hasValidAuth(profileName) {
  const filepath = getAuthStatePath(profileName);

  if (!fs.existsSync(filepath)) {
    return false;
  }

  try {
    const stats = fs.statSync(filepath);
    const age = Date.now() - stats.mtimeMs;

    if (age > AUTH_EXPIRY_MS) {
      console.log(`Auth state for ${profileName} is expired (${Math.floor(age / (24 * 60 * 60 * 1000))} days old)`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Failed to check auth state for ${profileName}:`, error.message);
    return false;
  }
}

/**
 * Delete auth state for a profile
 */
function deleteAuthState(profileName) {
  const filepath = getAuthStatePath(profileName);

  if (fs.existsSync(filepath)) {
    try {
      fs.unlinkSync(filepath);
      console.log(`Auth state deleted for profile: ${profileName}`);
      return true;
    } catch (error) {
      console.error(`Failed to delete auth state for ${profileName}:`, error.message);
      return false;
    }
  }

  return false;
}

/**
 * List all saved profiles
 */
function listProfiles() {
  const files = fs.readdirSync(BROWSER_STATE_DIR);
  const authFiles = files.filter(f => f.endsWith('_auth.json'));
  const profiles = authFiles.map(f => f.replace('_auth.json', ''));

  const metadata = loadMetadata();

  return profiles.map(profileName => {
    const meta = metadata[profileName] || {};
    const filepath = getAuthStatePath(profileName);
    const stats = fs.existsSync(filepath) ? fs.statSync(filepath) : null;

    return {
      name: profileName,
      valid: hasValidAuth(profileName),
      created: meta.created || null,
      lastSaved: meta.lastSaved || null,
      lastUsed: meta.lastUsed || null,
      ageInDays: stats ? Math.floor((Date.now() - stats.mtimeMs) / (24 * 60 * 60 * 1000)) : null
    };
  });
}

// ============================================================================
// CREDENTIAL HELPERS
// ============================================================================

/**
 * Get credentials for a profile
 */
function getCredentials(profileName) {
  return CREDENTIALS[profileName] || null;
}

/**
 * Get login selectors for a profile
 */
function getSelectors(profileName) {
  return LOGIN_SELECTORS[profileName] || null;
}

/**
 * Get profile name from URL
 */
function getProfileFromUrl(url) {
  const hostname = new URL(url).hostname.replace('www.', '');

  for (const [profileName, creds] of Object.entries(CREDENTIALS)) {
    if (creds.domains && creds.domains.some(d => hostname.includes(d))) {
      return profileName;
    }
  }

  return null;
}

// ============================================================================
// AUTO-FILL LOGIN
// ============================================================================

/**
 * Auto-fill login form on a page
 */
async function autoFillLogin(page, profileName = null) {
  const url = page.url();

  // Determine profile from URL if not specified
  const profile = profileName || getProfileFromUrl(url);

  if (!profile) {
    console.log(`No profile found for URL: ${url}`);
    return false;
  }

  const creds = getCredentials(profile);
  const selectors = getSelectors(profile);

  if (!creds) {
    console.log(`No credentials found for profile: ${profile}`);
    return false;
  }

  if (creds.useGoogleOAuth) {
    console.log(`Profile ${profile} uses Google OAuth`);
    return { useGoogleOAuth: true, email: creds.email, profile: 'google' };
  }

  if (!selectors) {
    console.log(`No selectors defined for profile: ${profile}`);
    return false;
  }

  try {
    // Fill email
    if (selectors.email && creds.email) {
      await page.waitForSelector(selectors.email, { timeout: 5000 });
      await page.fill(selectors.email, creds.email);
      console.log(`Filled email for profile: ${profile}`);

      // Click "Next" button if it exists (Google-style login)
      if (selectors.emailNext) {
        const nextBtn = await page.$(selectors.emailNext);
        if (nextBtn) {
          await nextBtn.click();
          await page.waitForTimeout(1000);
        }
      }
    }

    // Fill password
    if (selectors.password && creds.password) {
      await page.waitForSelector(selectors.password, { timeout: 5000 });
      await page.fill(selectors.password, creds.password);
      console.log(`Filled password for profile: ${profile}`);

      // Click password "Next" button if it exists
      if (selectors.passwordNext) {
        const nextBtn = await page.$(selectors.passwordNext);
        if (nextBtn) {
          await nextBtn.click();
          await page.waitForTimeout(1000);
        }
      }
    }

    return { profile, filled: true };
  } catch (error) {
    console.error(`Auto-fill failed for ${profile}:`, error.message);
    return false;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Auth state management
  saveAuthState,
  loadAuthState,
  hasValidAuth,
  deleteAuthState,
  listProfiles,

  // Credentials
  getCredentials,
  getSelectors,
  getProfileFromUrl,

  // Auto-fill
  autoFillLogin,

  // Metadata
  loadMetadata,
  updateProfileMetadata,

  // Constants
  CREDENTIALS,
  LOGIN_SELECTORS,
  BROWSER_STATE_DIR
};
