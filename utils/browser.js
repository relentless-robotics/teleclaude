/**
 * Unified Browser Automation Module
 *
 * THE definitive module for all browser automation tasks.
 * Consolidates stealth, retries, auth management, and smart interactions.
 *
 * @module utils/browser
 *
 * USAGE:
 *
 * Simple:
 *   const browser = require('./utils/browser');
 *   const session = await browser.launch({ stealth: true, auth: 'google' });
 *   await session.goto('https://example.com');
 *   await session.click('button.submit');
 *   await session.type('#email', 'test@example.com');
 *   await session.close();
 *
 * Advanced:
 *   const session = await browser.launch({
 *     headless: false,
 *     stealth: true,
 *     auth: 'google',
 *     profile: 'default',
 *     onCaptcha: async (page, captchaInfo) => {
 *       // Handle CAPTCHA
 *     }
 *   });
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const browserProfiles = require('./browser_profiles');

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG = {
  // Browser settings
  headless: false,
  channel: 'msedge', // Use Edge for better fingerprinting
  slowMo: 0,

  // Timeouts (milliseconds)
  shortTimeout: 5000,
  mediumTimeout: 15000,
  longTimeout: 30000,
  extraLongTimeout: 60000,

  // Retry settings
  maxRetries: 3,
  retryDelay: 1000,
  retryBackoff: 1.5,

  // Human behavior simulation
  humanTypingDelayMin: 50,
  humanTypingDelayMax: 150,
  humanPauseMin: 30,
  humanPauseMax: 100,
  mouseMovementSteps: 15,

  // Stealth mode
  stealth: true,

  // Screenshots
  screenshotDir: path.join(__dirname, '..', 'screenshots', 'browser'),
  autoScreenshotOnError: true,

  // Logging
  verbose: true
};

// Ensure directories exist
const dirs = [DEFAULT_CONFIG.screenshotDir];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Global config
let globalConfig = { ...DEFAULT_CONFIG };

// ============================================================================
// LOGGING
// ============================================================================

function log(message, level = 'INFO') {
  if (!globalConfig.verbose && level === 'DEBUG') return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Browser] [${level}]`;
  console.log(`${prefix} ${message}`);
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Sleep with optional jitter for human-like delays
 */
async function sleep(ms, jitter = 0.2) {
  const jitterAmount = ms * jitter * (Math.random() - 0.5);
  const actualDelay = Math.max(0, ms + jitterAmount);
  return new Promise(resolve => setTimeout(resolve, actualDelay));
}

/**
 * Human-like random delay
 */
async function humanDelay(baseMs = 1000) {
  const variation = baseMs * 0.3;
  const delay = baseMs + (Math.random() * variation * 2 - variation);
  await sleep(delay, 0);
}

/**
 * Get realistic viewport dimensions
 */
function getRealisticViewport() {
  const resolutions = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 2560, height: 1440 }
  ];
  return resolutions[Math.floor(Math.random() * resolutions.length)];
}

/**
 * Get realistic user agent
 */
function getRealisticUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// ============================================================================
// STEALTH SCRIPTS
// ============================================================================

/**
 * Apply stealth scripts to context to evade detection
 */
async function applyStealthScripts(context) {
  await context.addInitScript(() => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });

    // Chrome object
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };

    // Permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // Plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        {
          0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format" },
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
          name: "Chrome PDF Plugin"
        }
      ]
    });

    // Languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    // WebGL vendor
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter(parameter);
    };

    // Canvas fingerprint randomization (minimal noise)
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const context = this.getContext('2d');
      if (context) {
        const imageData = context.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] = imageData.data[i] + Math.floor(Math.random() * 3) - 1;
        }
        context.putImageData(imageData, 0, 0);
      }
      return originalToDataURL.apply(this, arguments);
    };

    // Hardware concurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8
    });

    // Device memory
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8
    });

    // Connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 100,
        downlink: 10,
        saveData: false
      })
    });
  });
}

/**
 * Apply page-level stealth
 */
async function applyPageStealth(page) {
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1'
  });
}

// ============================================================================
// DETECTION & DIAGNOSTICS
// ============================================================================

/**
 * Detect CAPTCHA on page
 */
async function detectCaptcha(page) {
  const captchaSelectors = [
    { type: 'recaptcha', selector: 'iframe[src*="recaptcha"]' },
    { type: 'hcaptcha', selector: 'iframe[src*="hcaptcha"]' },
    { type: 'cloudflare', selector: 'iframe[src*="challenges.cloudflare"]' },
    { type: 'generic', selector: '.captcha, #captcha' }
  ];

  for (const { type, selector } of captchaSelectors) {
    const element = await page.$(selector);
    if (element) {
      log(`CAPTCHA detected: ${type}`, 'WARN');
      return { detected: true, type, element };
    }
  }

  return { detected: false };
}

/**
 * Detect if auth has expired
 */
async function detectAuthExpired(page) {
  const url = page.url();
  const text = await page.textContent('body').catch(() => '');

  const indicators = [
    url.includes('login'),
    url.includes('signin'),
    url.includes('auth'),
    text.toLowerCase().includes('sign in'),
    text.toLowerCase().includes('log in'),
    text.toLowerCase().includes('session expired'),
    text.toLowerCase().includes('authentication required')
  ];

  const expired = indicators.filter(Boolean).length >= 2;
  if (expired) {
    log('Auth appears to be expired', 'WARN');
  }

  return expired;
}

/**
 * Detect common page issues
 */
async function detectIssues(page) {
  const issues = {
    captcha: false,
    error: false,
    blocked: false,
    rateLimit: false,
    authExpired: false
  };

  try {
    const url = page.url();
    const text = await page.textContent('body').catch(() => '');
    const lowerText = text.toLowerCase();

    // CAPTCHA
    const captchaResult = await detectCaptcha(page);
    issues.captcha = captchaResult.detected;

    // Error page
    if (lowerText.includes('error') ||
        lowerText.includes('something went wrong') ||
        lowerText.includes('page not found') ||
        url.includes('error')) {
      issues.error = true;
    }

    // Access blocked
    if (lowerText.includes('access denied') ||
        lowerText.includes('blocked') ||
        lowerText.includes('forbidden')) {
      issues.blocked = true;
    }

    // Rate limit
    if (lowerText.includes('rate limit') ||
        lowerText.includes('too many requests') ||
        lowerText.includes('429')) {
      issues.rateLimit = true;
    }

    // Auth expired
    issues.authExpired = await detectAuthExpired(page);

  } catch (error) {
    log(`Issue detection failed: ${error.message}`, 'DEBUG');
  }

  return issues;
}

// ============================================================================
// BROWSER SESSION CLASS
// ============================================================================

class BrowserSession {
  constructor(browser, context, page, options = {}) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.options = options;
    this.profileName = options.profile || null;
    this.authProfile = options.auth || null;
  }

  /**
   * Navigate to URL with retry and smart waiting
   */
  async goto(url, options = {}) {
    const {
      retries = globalConfig.maxRetries,
      timeout = globalConfig.longTimeout,
      waitUntil = 'domcontentloaded'
    } = options;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log(`Navigation attempt ${attempt}/${retries} to: ${url}`, 'DEBUG');

        await this.page.goto(url, { waitUntil, timeout: timeout / retries });
        await this.waitForReady();

        log(`Successfully navigated to: ${this.page.url()}`, 'DEBUG');
        return true;

      } catch (error) {
        log(`Navigation attempt ${attempt} failed: ${error.message}`, 'DEBUG');

        if (attempt < retries) {
          await sleep(globalConfig.retryDelay * Math.pow(globalConfig.retryBackoff, attempt - 1));
        } else {
          log(`All navigation attempts failed`, 'ERROR');
          if (globalConfig.autoScreenshotOnError) {
            await this.screenshot('navigation_failed');
          }
          throw error;
        }
      }
    }
  }

  /**
   * Wait for page to be ready
   */
  async waitForReady(options = {}) {
    const {
      waitForLoad = true,
      waitForNetwork = false,
      timeout = globalConfig.longTimeout
    } = options;

    try {
      if (waitForLoad) {
        await this.page.waitForLoadState('domcontentloaded', { timeout });
      }

      if (waitForNetwork) {
        await this.page.waitForLoadState('networkidle', { timeout }).catch(() => {
          log('Network idle wait timed out (continuing)', 'DEBUG');
        });
      }

      await this.page.evaluate(() => {
        return new Promise((resolve) => {
          if (document.readyState === 'complete') {
            resolve();
          } else {
            window.addEventListener('load', resolve);
          }
        });
      }).catch(() => {});

      await sleep(500);
      log('Page ready', 'DEBUG');
    } catch (error) {
      log(`Wait for ready failed: ${error.message}`, 'WARN');
    }
  }

  /**
   * Find element with multiple selector fallbacks
   */
  async findElement(selectors, options = {}) {
    const {
      timeout = globalConfig.mediumTimeout,
      mustBeVisible = true,
      mustBeEnabled = true
    } = options;

    const selectorArray = Array.isArray(selectors) ? selectors : [selectors];

    for (const selector of selectorArray) {
      try {
        await this.page.waitForSelector(selector, {
          timeout: timeout / selectorArray.length,
          state: mustBeVisible ? 'visible' : 'attached'
        });

        const element = await this.page.$(selector);
        if (!element) continue;

        if (mustBeVisible) {
          const isVisible = await element.isVisible().catch(() => false);
          if (!isVisible) continue;
        }

        if (mustBeEnabled) {
          const isEnabled = await element.isEnabled().catch(() => true);
          if (!isEnabled) continue;
        }

        log(`Found element: ${selector}`, 'DEBUG');
        return element;

      } catch (error) {
        continue;
      }
    }

    log(`Could not find element: ${selectorArray.join(', ')}`, 'WARN');
    return null;
  }

  /**
   * Click element with retries and human-like behavior
   */
  async click(selectors, options = {}) {
    const {
      retries = globalConfig.maxRetries,
      timeout = globalConfig.mediumTimeout,
      humanLike = true,
      waitForNavigation = false
    } = options;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const element = await this.findElement(selectors, { timeout: timeout / retries });
        if (!element) {
          if (attempt < retries) {
            await sleep(globalConfig.retryDelay * Math.pow(globalConfig.retryBackoff, attempt - 1));
            continue;
          }
          return false;
        }

        // Scroll into view
        await element.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(300);

        // Human-like mouse movement
        if (humanLike) {
          const box = await element.boundingBox();
          if (box) {
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await this.moveMouseHumanLike(x, y);
            await sleep(100 + Math.random() * 200);
          }
        }

        await element.click();
        log('Successfully clicked element', 'DEBUG');

        if (waitForNavigation) {
          await this.page.waitForLoadState('domcontentloaded').catch(() => {});
          await sleep(1000);
        }

        return true;

      } catch (error) {
        log(`Click attempt ${attempt} failed: ${error.message}`, 'DEBUG');

        if (attempt < retries) {
          await sleep(globalConfig.retryDelay * Math.pow(globalConfig.retryBackoff, attempt - 1));
        } else {
          log('All click attempts failed', 'WARN');
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Type text with human-like behavior
   */
  async type(selectors, text, options = {}) {
    const {
      retries = globalConfig.maxRetries,
      timeout = globalConfig.mediumTimeout,
      humanLike = true,
      clear = true,
      pressEnter = false
    } = options;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const element = await this.findElement(selectors, { timeout: timeout / retries });
        if (!element) {
          if (attempt < retries) {
            await sleep(globalConfig.retryDelay * Math.pow(globalConfig.retryBackoff, attempt - 1));
            continue;
          }
          return false;
        }

        await element.click();
        await sleep(200);

        if (clear) {
          await element.fill('');
          await sleep(100);
        }

        if (humanLike) {
          await this.typeHumanLike(element, text);
        } else {
          await element.type(text);
        }

        log('Successfully typed text', 'DEBUG');

        if (pressEnter) {
          await sleep(300);
          await element.press('Enter');
          await sleep(500);
        }

        return true;

      } catch (error) {
        log(`Type attempt ${attempt} failed: ${error.message}`, 'DEBUG');

        if (attempt < retries) {
          await sleep(globalConfig.retryDelay * Math.pow(globalConfig.retryBackoff, attempt - 1));
        } else {
          log('All type attempts failed', 'WARN');
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Type with human-like delays
   */
  async typeHumanLike(element, text) {
    for (const char of text) {
      await element.type(char, {
        delay: globalConfig.humanTypingDelayMin +
               Math.random() * (globalConfig.humanTypingDelayMax - globalConfig.humanTypingDelayMin)
      });

      if (Math.random() < 0.1) {
        await sleep(
          globalConfig.humanPauseMin +
          Math.random() * (globalConfig.humanPauseMax - globalConfig.humanPauseMin)
        );
      }
    }
  }

  /**
   * Move mouse in human-like manner
   */
  async moveMouseHumanLike(targetX, targetY) {
    const steps = globalConfig.mouseMovementSteps;
    const currentPos = await this.page.evaluate(() => {
      return { x: 0, y: 0 };
    });

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      const easeProgress = this.easeInOutCubic(progress);

      const x = currentPos.x + (targetX - currentPos.x) * easeProgress;
      const y = currentPos.y + (targetY - currentPos.y) * easeProgress;

      await this.page.mouse.move(x, y);
      await sleep(10 + Math.random() * 20, 0);
    }
  }

  /**
   * Easing function for smooth mouse movement
   */
  easeInOutCubic(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /**
   * Wait for any of multiple conditions
   */
  async waitForAny(conditions, options = {}) {
    const {
      timeout = globalConfig.longTimeout,
      checkInterval = 500
    } = options;

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      for (let i = 0; i < conditions.length; i++) {
        const condition = conditions[i];

        try {
          if (condition.type === 'selector') {
            const exists = await this.page.$(condition.value) !== null;
            if (exists) {
              log(`Condition met: ${condition.value}`, 'DEBUG');
              return { index: i, condition, matched: true };
            }
          } else if (condition.type === 'url') {
            if (this.page.url().includes(condition.value)) {
              log(`URL condition met: ${condition.value}`, 'DEBUG');
              return { index: i, condition, matched: true };
            }
          } else if (condition.type === 'text') {
            const text = await this.page.textContent('body').catch(() => '');
            if (text.includes(condition.value)) {
              log(`Text condition met: ${condition.value}`, 'DEBUG');
              return { index: i, condition, matched: true };
            }
          } else if (condition.type === 'custom') {
            const result = await condition.check(this.page);
            if (result) {
              log('Custom condition met', 'DEBUG');
              return { index: i, condition, matched: true };
            }
          }
        } catch (error) {
          continue;
        }
      }

      await sleep(checkInterval);
    }

    log('Timeout: No conditions met', 'WARN');
    return { matched: false };
  }

  /**
   * Take screenshot
   */
  async screenshot(label, options = {}) {
    const {
      fullPage = false,
      dir = globalConfig.screenshotDir
    } = options;

    const timestamp = Date.now();
    const filename = `${label}_${timestamp}.png`;
    const filepath = path.join(dir, filename);

    try {
      await this.page.screenshot({ path: filepath, fullPage });
      log(`Screenshot saved: ${filepath}`, 'DEBUG');
      return filepath;
    } catch (error) {
      log(`Screenshot failed: ${error.message}`, 'ERROR');
      return null;
    }
  }

  /**
   * Get page state for debugging
   */
  async getState() {
    try {
      const state = {
        url: this.page.url(),
        title: await this.page.title().catch(() => 'N/A'),
        ready: await this.page.evaluate(() => document.readyState).catch(() => 'unknown'),
        issues: await detectIssues(this.page)
      };

      return state;
    } catch (error) {
      log(`Could not get page state: ${error.message}`, 'ERROR');
      return { error: error.message };
    }
  }

  /**
   * Auto-fill login form
   */
  async autoFillLogin(options = {}) {
    const { profile = this.authProfile } = options;

    if (!profile) {
      log('No auth profile specified', 'WARN');
      return false;
    }

    try {
      const result = await browserProfiles.autoFillLogin(this.page, profile);
      if (result) {
        log(`Auto-filled login for profile: ${profile}`, 'DEBUG');
      }
      return result;
    } catch (error) {
      log(`Auto-fill failed: ${error.message}`, 'ERROR');
      return false;
    }
  }

  /**
   * Save current auth state
   */
  async saveAuthState(profileName = null) {
    const name = profileName || this.profileName || 'default';

    try {
      await browserProfiles.saveAuthState(this.context, name);
      log(`Auth state saved for profile: ${name}`, 'DEBUG');
      return true;
    } catch (error) {
      log(`Failed to save auth state: ${error.message}`, 'ERROR');
      return false;
    }
  }

  /**
   * Simulate human behavior (mouse movements, scrolling)
   */
  async simulateHumanBehavior(duration = 5000) {
    const startTime = Date.now();

    // Random mouse movements
    const moveCount = 5 + Math.floor(Math.random() * 10);
    for (let i = 0; i < moveCount && Date.now() - startTime < duration; i++) {
      const x = Math.random() * 1200;
      const y = Math.random() * 800;
      await this.moveMouseHumanLike(x, y);
      await sleep(200 + Math.random() * 500);
    }

    // Random scrolling
    const scrollCount = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < scrollCount && Date.now() - startTime < duration; i++) {
      const scrollY = Math.random() * 500 - 250;
      await this.page.evaluate((y) => {
        window.scrollBy({ top: y, behavior: 'smooth' });
      }, scrollY);
      await sleep(500 + Math.random() * 1000);
    }

    log('Simulated human behavior', 'DEBUG');
  }

  /**
   * Close browser session
   */
  async close() {
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
      log('Browser session closed', 'DEBUG');
    } catch (error) {
      log(`Error closing browser: ${error.message}`, 'ERROR');
    }
  }
}

// ============================================================================
// MAIN LAUNCH FUNCTION
// ============================================================================

/**
 * Launch browser session
 *
 * @param {Object} options - Launch options
 * @param {boolean} options.headless - Run headless
 * @param {boolean} options.stealth - Enable stealth mode
 * @param {string} options.auth - Auth profile to load ('google', 'github', etc.)
 * @param {string} options.profile - Named profile for persistent storage
 * @param {Function} options.onCaptcha - Callback when CAPTCHA detected
 * @returns {Promise<BrowserSession>}
 */
async function launch(options = {}) {
  const {
    headless = globalConfig.headless,
    stealth = globalConfig.stealth,
    auth = null,
    profile = null,
    onCaptcha = null,
    ...otherOptions
  } = options;

  log('Launching browser session...', 'INFO');

  // Browser launch args
  const launchArgs = {
    headless,
    channel: globalConfig.channel,
    args: stealth ? [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ] : []
  };

  const browser = await chromium.launch(launchArgs);

  // Context options
  const contextOptions = {
    viewport: getRealisticViewport(),
    userAgent: getRealisticUserAgent(),
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation', 'notifications'],
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    ...otherOptions
  };

  // Load auth state if specified
  if (auth) {
    const authState = browserProfiles.loadAuthState(auth);
    if (authState) {
      contextOptions.storageState = authState;
      log(`Loaded auth state for: ${auth}`, 'INFO');
    } else {
      log(`No saved auth state found for: ${auth}`, 'WARN');
    }
  }

  const context = await browser.newContext(contextOptions);

  // Apply stealth
  if (stealth) {
    await applyStealthScripts(context);
    log('Stealth mode enabled', 'DEBUG');
  }

  const page = await context.newPage();

  if (stealth) {
    await applyPageStealth(page);
  }

  // CAPTCHA detection hook
  if (onCaptcha) {
    page.on('load', async () => {
      const captchaResult = await detectCaptcha(page);
      if (captchaResult.detected) {
        await onCaptcha(page, captchaResult);
      }
    });
  }

  log('Browser session launched successfully', 'INFO');

  return new BrowserSession(browser, context, page, { ...options, profile, auth });
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Launch with Google auth
 */
async function withGoogleAuth(options = {}) {
  return launch({ ...options, auth: 'google' });
}

/**
 * Launch with GitHub auth
 */
async function withGitHubAuth(options = {}) {
  return launch({ ...options, auth: 'github' });
}

/**
 * Save auth state
 */
async function saveAuthState(context, profileName) {
  return browserProfiles.saveAuthState(context, profileName);
}

/**
 * Load auth state
 */
function loadAuthState(profileName) {
  return browserProfiles.loadAuthState(profileName);
}

/**
 * Check if auth state exists and is fresh
 */
function hasValidAuth(profileName) {
  return browserProfiles.hasValidAuth(profileName);
}

/**
 * Configure global settings
 */
function configure(config) {
  Object.assign(globalConfig, config);
  log('Configuration updated', 'DEBUG');
}

/**
 * Get current configuration
 */
function getConfig() {
  return { ...globalConfig };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main entry
  launch,

  // Session class
  BrowserSession,

  // Utilities
  saveAuthState,
  loadAuthState,
  hasValidAuth,

  // Pre-configured launchers
  withGoogleAuth,
  withGitHubAuth,

  // Helpers
  detectCaptcha,
  detectAuthExpired,
  detectIssues,
  humanDelay,
  sleep,

  // Config
  configure,
  getConfig
};
