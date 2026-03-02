/**
 * Centralized Credentials Loader
 *
 * ALL credentials should be loaded through this module.
 * Credentials are stored in .env file (gitignored).
 *
 * Usage:
 *   const creds = require('./utils/credentials');
 *
 *   // Get specific credentials
 *   const email = creds.get('DEFAULT_EMAIL');
 *   const password = creds.get('DEFAULT_PASSWORD');
 *
 *   // Get credentials for a service
 *   const github = creds.getService('github');
 *   // Returns: { pat: '...', username: '...' }
 *
 *   // Get login credentials for browser automation
 *   const login = creds.getLogin();
 *   // Returns: { email: '...', password: '...' }
 *
 *   // Check if credential exists
 *   if (creds.has('OPENAI_API_KEY')) { ... }
 */

const path = require('path');
const fs = require('fs');

// Load dotenv from project root
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  console.warn('Warning: .env file not found. Copy .env.example to .env and configure your credentials.');
}

// Known login selectors for common sites (no credentials here!)
const LOGIN_SELECTORS = {
  'google.com': {
    email: 'input[type="email"]',
    password: 'input[type="password"]',
    submit: '#identifierNext, #passwordNext'
  },
  'accounts.google.com': {
    email: 'input[type="email"]',
    password: 'input[type="password"]',
    submit: '#identifierNext, #passwordNext'
  },
  'github.com': {
    email: '#login_field',
    password: '#password',
    submit: 'input[type="submit"]'
  },
  'twitter.com': {
    email: 'input[autocomplete="username"]',
    password: 'input[type="password"]',
    submit: '[data-testid="LoginForm_Login_Button"]'
  },
  'x.com': {
    email: 'input[autocomplete="username"]',
    password: 'input[type="password"]',
    submit: '[data-testid="LoginForm_Login_Button"]'
  },
  'vercel.com': {
    useGoogleOAuth: true
  },
  'pinterest.com': {
    email: '#email',
    password: '#password',
    submit: 'button[type="submit"]'
  },
  'gumroad.com': {
    email: '#email',
    password: '#password',
    submit: 'button[type="submit"]'
  }
};

/**
 * Get a credential by key
 * @param {string} key - Environment variable name
 * @param {string} defaultValue - Default if not set
 * @returns {string|undefined}
 */
function get(key, defaultValue = undefined) {
  return process.env[key] || defaultValue;
}

/**
 * Check if a credential exists and is not a placeholder
 * @param {string} key - Environment variable name
 * @returns {boolean}
 */
function has(key) {
  const value = process.env[key];
  if (!value) return false;

  // Check for placeholder patterns
  const placeholders = [
    'your_', 'xxx', 'yyy', 'placeholder', 'example',
    'sk-your', 'ghp_your', 'gsk_your', '_here'
  ];

  const lowerValue = value.toLowerCase();
  return !placeholders.some(p => lowerValue.includes(p));
}

/**
 * Get all credentials for a service
 * @param {string} service - Service name
 * @returns {object}
 */
function getService(service) {
  const services = {
    // Default login
    default: {
      email: get('DEFAULT_EMAIL'),
      password: get('DEFAULT_PASSWORD')
    },

    // GitHub
    github: {
      pat: get('GITHUB_PAT'),
      username: get('GITHUB_USERNAME'),
      token: get('GITHUB_PAT') // alias
    },

    // AI Providers
    openai: {
      apiKey: get('OPENAI_API_KEY')
    },
    anthropic: {
      apiKey: get('ANTHROPIC_API_KEY')
    },
    kimi: {
      apiKey: get('KIMI_API_KEY')
    },
    groq: {
      apiKey: get('GROQ_API_KEY')
    },

    // Google
    google: {
      email: get('DEFAULT_EMAIL'),
      appPassword: get('GMAIL_APP_PASSWORD'),
      clientId: get('GOOGLE_CLIENT_ID'),
      clientSecret: get('GOOGLE_CLIENT_SECRET'),
      refreshToken: get('GOOGLE_REFRESH_TOKEN')
    },
    gmail: {
      email: get('DEFAULT_EMAIL'),
      appPassword: get('GMAIL_APP_PASSWORD')
    },

    // Trading
    alpaca: {
      apiKey: get('ALPACA_API_KEY'),
      secretKey: get('ALPACA_SECRET_KEY'),
      paper: get('ALPACA_PAPER', 'true') === 'true'
    },
    kalshi: {
      apiKey: get('KALSHI_API_KEY'),
      privateKey: get('KALSHI_PRIVATE_KEY')
    },
    polymarket: {
      apiKey: get('POLYMARKET_API_KEY'),
      privateKey: get('POLYMARKET_PRIVATE_KEY')
    },

    // Other services
    stripe: {
      secretKey: get('STRIPE_SECRET_KEY'),
      publishableKey: get('STRIPE_PUBLISHABLE_KEY')
    },
    clerk: {
      secretKey: get('CLERK_SECRET_KEY'),
      publishableKey: get('CLERK_PUBLISHABLE_KEY')
    },
    vercel: {
      token: get('VERCEL_TOKEN')
    },

    // Messaging
    telegram: {
      token: get('TELEGRAM_TOKEN'),
      allowedUsers: (get('ALLOWED_USERS') || '').split(',').filter(Boolean)
    },
    discord: {
      token: get('DISCORD_TOKEN'),
      webhookUrl: get('DISCORD_WEBHOOK_URL'),
      allowedUsers: (get('ALLOWED_USERS') || '').split(',').filter(Boolean)
    },

    // Security
    keepass: {
      password: get('KEEPASS_PASSWORD')
    }
  };

  return services[service.toLowerCase()] || {};
}

/**
 * Get login credentials for browser automation
 * All sites use the default credentials from .env
 * @returns {object} { email, password }
 */
function getLogin() {
  return {
    email: get('DEFAULT_EMAIL'),
    password: get('DEFAULT_PASSWORD')
  };
}

/**
 * Get login selectors for a domain
 * @param {string} url - Page URL
 * @returns {object|null}
 */
function getSelectors(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return LOGIN_SELECTORS[hostname] || null;
  } catch {
    return null;
  }
}

/**
 * Auto-fill login form on a page using credentials from .env
 * @param {object} page - Playwright page object
 * @returns {Promise<boolean>}
 */
async function autoFillLogin(page) {
  const url = page.url();
  const selectors = getSelectors(url);
  const login = getLogin();

  if (!login.email || !login.password) {
    console.log('No credentials configured in .env file');
    return false;
  }

  if (!selectors) {
    console.log(`No selectors defined for: ${url}`);
    return false;
  }

  if (selectors.useGoogleOAuth) {
    console.log(`Site uses Google OAuth: ${url}`);
    return { useGoogleOAuth: true, email: login.email };
  }

  try {
    // Fill email
    if (selectors.email) {
      await page.waitForSelector(selectors.email, { timeout: 5000 });
      await page.fill(selectors.email, login.email);
      console.log(`Filled email for: ${url}`);
    }

    // Fill password
    if (selectors.password) {
      await page.waitForSelector(selectors.password, { timeout: 5000 });
      await page.fill(selectors.password, login.password);
      console.log(`Filled password for: ${url}`);
    }

    return true;
  } catch (error) {
    console.error(`Auto-fill failed for ${url}:`, error.message);
    return false;
  }
}

/**
 * Create a browser context with saved storage state (Google auth)
 * @param {object} browser - Playwright browser object
 * @param {object} options - Context options
 * @returns {Promise<object>}
 */
async function createAuthenticatedContext(browser, options = {}) {
  const storageStatePath = path.join(__dirname, '..', 'browser_state', 'google_auth.json');

  const contextOptions = {
    viewport: { width: 1280, height: 720 },
    ...options
  };

  // Load storage state if it exists
  if (fs.existsSync(storageStatePath)) {
    contextOptions.storageState = storageStatePath;
    console.log('Loaded saved Google auth state');
  }

  return await browser.newContext(contextOptions);
}

/**
 * Check if credentials are configured
 * @returns {object} Status of each service
 */
function checkStatus() {
  return {
    default: has('DEFAULT_EMAIL') && has('DEFAULT_PASSWORD'),
    github: has('GITHUB_PAT'),
    openai: has('OPENAI_API_KEY'),
    anthropic: has('ANTHROPIC_API_KEY'),
    kimi: has('KIMI_API_KEY'),
    groq: has('GROQ_API_KEY'),
    gmail: has('GMAIL_APP_PASSWORD'),
    alpaca: has('ALPACA_API_KEY'),
    telegram: has('TELEGRAM_TOKEN'),
    discord: has('DISCORD_TOKEN')
  };
}

/**
 * Print credential status (for debugging)
 */
function printStatus() {
  console.log('\n=== Credential Status ===\n');
  const status = checkStatus();
  for (const [service, configured] of Object.entries(status)) {
    const icon = configured ? '✓' : '✗';
    const color = configured ? '\x1b[32m' : '\x1b[31m';
    console.log(`${color}${icon}\x1b[0m ${service}`);
  }
  console.log('\nConfigure in .env file (copy from .env.example)\n');
}

/**
 * Validate that required credentials exist
 * @param {string[]} required - List of required credential keys
 * @throws {Error} If any required credential is missing
 */
function requireCredentials(required) {
  const missing = required.filter(key => !has(key));
  if (missing.length > 0) {
    throw new Error(
      `Missing required credentials: ${missing.join(', ')}\n` +
      `Configure them in .env file (see .env.example)`
    );
  }
}

module.exports = {
  // Core functions
  get,
  has,
  getService,
  getLogin,
  getSelectors,
  checkStatus,
  printStatus,
  requireCredentials,

  // Browser automation
  autoFillLogin,
  createAuthenticatedContext,
  LOGIN_SELECTORS
};

// If run directly, print status
if (require.main === module) {
  printStatus();
}
