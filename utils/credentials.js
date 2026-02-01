/**
 * Credential Helper for Browser Automation
 *
 * Reads credentials from ACCOUNTS.md and provides auto-fill capabilities.
 * Used by Playwright scripts to automatically fill login forms.
 */

const fs = require('fs');
const path = require('path');

// Known login selectors for common sites
const LOGIN_SELECTORS = {
  'google.com': {
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
    // Uses Google OAuth - no direct login
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

// Credentials mapping (domain -> credentials)
const CREDENTIALS = {
  'google.com': {
    email: 'relentlessrobotics@gmail.com',
    password: 'Relaxing41!'
  },
  'accounts.google.com': {
    email: 'relentlessrobotics@gmail.com',
    password: 'Relaxing41!'
  },
  'github.com': {
    email: 'relentlessrobotics@gmail.com',
    password: 'Relentless@Robotics2026!'
  },
  'gumroad.com': {
    email: 'relentlessrobotics@gmail.com',
    password: 'GumRd#2026$Secure!'
  },
  'pinterest.com': {
    useGoogleOAuth: true,
    email: 'relentlessrobotics@gmail.com'
  },
  'vercel.com': {
    useGoogleOAuth: true,
    email: 'relentlessrobotics@gmail.com'
  }
};

/**
 * Get credentials for a domain
 */
function getCredentials(url) {
  const hostname = new URL(url).hostname.replace('www.', '');

  // Check exact match first
  if (CREDENTIALS[hostname]) {
    return CREDENTIALS[hostname];
  }

  // Check parent domain
  const parts = hostname.split('.');
  if (parts.length > 2) {
    const parentDomain = parts.slice(-2).join('.');
    if (CREDENTIALS[parentDomain]) {
      return CREDENTIALS[parentDomain];
    }
  }

  return null;
}

/**
 * Get login selectors for a domain
 */
function getSelectors(url) {
  const hostname = new URL(url).hostname.replace('www.', '');
  return LOGIN_SELECTORS[hostname] || null;
}

/**
 * Auto-fill login form on a page
 */
async function autoFillLogin(page) {
  const url = page.url();
  const creds = getCredentials(url);
  const selectors = getSelectors(url);

  if (!creds) {
    console.log(`No credentials found for: ${url}`);
    return false;
  }

  if (creds.useGoogleOAuth) {
    console.log(`Site uses Google OAuth: ${url}`);
    return { useGoogleOAuth: true, email: creds.email };
  }

  if (!selectors) {
    console.log(`No selectors defined for: ${url}`);
    return false;
  }

  try {
    // Fill email
    if (selectors.email && creds.email) {
      await page.waitForSelector(selectors.email, { timeout: 5000 });
      await page.fill(selectors.email, creds.email);
      console.log(`Filled email for: ${url}`);
    }

    // Fill password
    if (selectors.password && creds.password) {
      await page.waitForSelector(selectors.password, { timeout: 5000 });
      await page.fill(selectors.password, creds.password);
      console.log(`Filled password for: ${url}`);
    }

    return true;
  } catch (error) {
    console.error(`Auto-fill failed for ${url}:`, error.message);
    return false;
  }
}

/**
 * Create a browser context with persistent profile
 */
async function createPersistentContext(chromium, options = {}) {
  const userDataDir = path.join(__dirname, '..', 'browser_profile');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless || false,
    viewport: { width: 1280, height: 720 },
    ...options
  });

  return context;
}

/**
 * Create a context with saved storage state (Google auth)
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

module.exports = {
  getCredentials,
  getSelectors,
  autoFillLogin,
  createPersistentContext,
  createAuthenticatedContext,
  CREDENTIALS,
  LOGIN_SELECTORS
};
