/**
 * Advanced Playwright Helper Utilities
 *
 * This module provides battle-tested patterns for reliable browser automation:
 * - Smart waiting with configurable retries
 * - Multiple fallback strategies for element selection
 * - Anti-timeout patterns with exponential backoff
 * - Anti-detection techniques
 * - Better error recovery
 * - Comprehensive logging and debugging
 *
 * USAGE:
 *   const { safeClick, safeType, smartWait, createRobustContext } = require('./utils/playwright_helpers');
 */

const fs = require('fs');
const path = require('path');

// Configuration defaults
const DEFAULT_CONFIG = {
  // Timeout settings (in milliseconds)
  shortTimeout: 5000,
  mediumTimeout: 15000,
  longTimeout: 30000,
  extraLongTimeout: 60000,

  // Retry settings
  maxRetries: 3,
  retryDelay: 1000,
  retryBackoff: 1.5, // Exponential backoff multiplier

  // Wait settings
  pollingInterval: 500,
  stableWaitTime: 500, // Wait for element to be stable

  // Typing settings
  humanTypingDelayMin: 50,
  humanTypingDelayMax: 150,
  humanPauseMin: 30,
  humanPauseMax: 100,

  // Screenshot settings
  screenshotDir: path.join(__dirname, '..', 'screenshots', 'debug'),
  autoScreenshotOnError: true,

  // Logging
  verbose: true
};

// Ensure screenshot directory exists
if (!fs.existsSync(DEFAULT_CONFIG.screenshotDir)) {
  fs.mkdirSync(DEFAULT_CONFIG.screenshotDir, { recursive: true });
}

/**
 * Logger with timestamp
 */
function log(message, level = 'INFO') {
  if (!DEFAULT_CONFIG.verbose && level === 'DEBUG') return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;
  console.log(`${prefix} ${message}`);
}

/**
 * Sleep utility with jitter for human-like delays
 */
async function sleep(ms, jitter = 0.2) {
  const jitterAmount = ms * jitter * (Math.random() - 0.5);
  const actualDelay = Math.max(0, ms + jitterAmount);
  return new Promise(resolve => setTimeout(resolve, actualDelay));
}

/**
 * Create a browser context with anti-detection measures
 * @param {Browser} browser - Playwright browser instance
 * @param {Object} options - Context options
 * @returns {Promise<BrowserContext>}
 */
async function createRobustContext(browser, options = {}) {
  const contextOptions = {
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: [],
    ...options
  };

  const context = await browser.newContext(contextOptions);

  // Anti-detection: Override webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });

    // Override plugins to appear more legitimate
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    // Chrome-specific properties
    window.chrome = {
      runtime: {}
    };
  });

  log('Created robust browser context with anti-detection measures', 'DEBUG');
  return context;
}

/**
 * Smart wait for page to be ready - better than networkidle
 * @param {Page} page - Playwright page
 * @param {Object} options - Wait options
 */
async function waitForPageReady(page, options = {}) {
  const {
    waitForLoad = true,
    waitForNetwork = false,
    customCondition = null,
    timeout = DEFAULT_CONFIG.longTimeout
  } = options;

  try {
    if (waitForLoad) {
      await page.waitForLoadState('domcontentloaded', { timeout });
      log('Page DOM loaded', 'DEBUG');
    }

    if (waitForNetwork) {
      // Wait for network to be idle (can be slow, use sparingly)
      await page.waitForLoadState('networkidle', { timeout }).catch(() => {
        log('Network idle wait timed out (continuing anyway)', 'DEBUG');
      });
    }

    // Wait for common frameworks to initialize
    await page.evaluate(() => {
      return new Promise((resolve) => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', resolve);
        }
      });
    }).catch(() => {});

    // Custom condition
    if (customCondition) {
      await customCondition(page);
    }

    // Small delay to let dynamic content render
    await sleep(500);

    log('Page ready', 'DEBUG');
  } catch (error) {
    log(`Page ready wait failed: ${error.message}`, 'WARN');
  }
}

/**
 * Smart element finder - tries multiple selectors with fallbacks
 * @param {Page} page - Playwright page
 * @param {string|Array} selectors - Single selector or array of fallback selectors
 * @param {Object} options - Options
 * @returns {Promise<ElementHandle|null>}
 */
async function findElement(page, selectors, options = {}) {
  const {
    timeout = DEFAULT_CONFIG.mediumTimeout,
    mustBeVisible = true,
    mustBeEnabled = true,
    logFailures = true
  } = options;

  const selectorArray = Array.isArray(selectors) ? selectors : [selectors];

  for (const selector of selectorArray) {
    try {
      log(`Trying selector: ${selector}`, 'DEBUG');

      // Wait for element to exist
      await page.waitForSelector(selector, {
        timeout: timeout / selectorArray.length,
        state: mustBeVisible ? 'visible' : 'attached'
      });

      const element = await page.$(selector);

      if (!element) {
        continue;
      }

      // Additional checks
      if (mustBeVisible) {
        const isVisible = await element.isVisible().catch(() => false);
        if (!isVisible) {
          log(`Element not visible: ${selector}`, 'DEBUG');
          continue;
        }
      }

      if (mustBeEnabled) {
        const isEnabled = await element.isEnabled().catch(() => true);
        if (!isEnabled) {
          log(`Element not enabled: ${selector}`, 'DEBUG');
          continue;
        }
      }

      log(`Found element with selector: ${selector}`, 'DEBUG');
      return element;

    } catch (error) {
      if (logFailures) {
        log(`Selector failed: ${selector} - ${error.message}`, 'DEBUG');
      }
      continue;
    }
  }

  log(`Could not find element with any selector: ${selectorArray.join(', ')}`, 'WARN');
  return null;
}

/**
 * Safe click with retries and stability checks
 * @param {Page} page - Playwright page
 * @param {string|Array} selectors - Selector(s) to click
 * @param {Object} options - Click options
 * @returns {Promise<boolean>} - True if clicked successfully
 */
async function safeClick(page, selectors, options = {}) {
  const {
    retries = DEFAULT_CONFIG.maxRetries,
    timeout = DEFAULT_CONFIG.mediumTimeout,
    waitForNavigation = false,
    waitForStability = true,
    scrollIntoView = true,
    forceClick = false,
    delay = 0
  } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(`Click attempt ${attempt}/${retries} on: ${Array.isArray(selectors) ? selectors[0] : selectors}`, 'DEBUG');

      const element = await findElement(page, selectors, {
        timeout: timeout / retries,
        mustBeVisible: !forceClick,
        mustBeEnabled: !forceClick
      });

      if (!element) {
        if (attempt < retries) {
          await sleep(DEFAULT_CONFIG.retryDelay * Math.pow(DEFAULT_CONFIG.retryBackoff, attempt - 1));
          continue;
        }
        return false;
      }

      // Scroll into view
      if (scrollIntoView) {
        await element.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(300);
      }

      // Wait for element to be stable (not moving)
      if (waitForStability) {
        await sleep(DEFAULT_CONFIG.stableWaitTime);
      }

      // Perform click
      if (forceClick) {
        await element.click({ force: true, delay });
      } else {
        await element.click({ delay });
      }

      log(`Successfully clicked element`, 'DEBUG');

      // Wait for navigation if expected
      if (waitForNavigation) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await sleep(1000);
      }

      return true;

    } catch (error) {
      log(`Click attempt ${attempt} failed: ${error.message}`, 'DEBUG');

      if (attempt < retries) {
        await sleep(DEFAULT_CONFIG.retryDelay * Math.pow(DEFAULT_CONFIG.retryBackoff, attempt - 1));
      } else {
        log(`All click attempts failed for: ${Array.isArray(selectors) ? selectors.join(', ') : selectors}`, 'WARN');
        return false;
      }
    }
  }

  return false;
}

/**
 * Safe type with human-like behavior and retries
 * @param {Page} page - Playwright page
 * @param {string|Array} selectors - Selector(s) for input field
 * @param {string} text - Text to type
 * @param {Object} options - Typing options
 * @returns {Promise<boolean>} - True if typed successfully
 */
async function safeType(page, selectors, text, options = {}) {
  const {
    retries = DEFAULT_CONFIG.maxRetries,
    timeout = DEFAULT_CONFIG.mediumTimeout,
    humanLike = true,
    clear = true,
    pressEnter = false,
    verify = true
  } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(`Type attempt ${attempt}/${retries} on: ${Array.isArray(selectors) ? selectors[0] : selectors}`, 'DEBUG');

      const element = await findElement(page, selectors, {
        timeout: timeout / retries,
        mustBeVisible: true,
        mustBeEnabled: true
      });

      if (!element) {
        if (attempt < retries) {
          await sleep(DEFAULT_CONFIG.retryDelay * Math.pow(DEFAULT_CONFIG.retryBackoff, attempt - 1));
          continue;
        }
        return false;
      }

      // Click to focus
      await element.click();
      await sleep(200);

      // Clear existing content
      if (clear) {
        await element.fill(''); // Fast clear
        await sleep(100);
      }

      // Type the text
      if (humanLike) {
        await typeHumanLike(element, text);
      } else {
        await element.type(text);
      }

      log(`Successfully typed text`, 'DEBUG');

      // Verify the value was set
      if (verify) {
        const value = await element.inputValue().catch(() => '');
        if (value !== text) {
          log(`Typed value mismatch. Expected: "${text}", Got: "${value}"`, 'WARN');
          if (attempt < retries) {
            continue;
          }
        }
      }

      // Press Enter if requested
      if (pressEnter) {
        await sleep(300);
        await element.press('Enter');
        await sleep(500);
      }

      return true;

    } catch (error) {
      log(`Type attempt ${attempt} failed: ${error.message}`, 'DEBUG');

      if (attempt < retries) {
        await sleep(DEFAULT_CONFIG.retryDelay * Math.pow(DEFAULT_CONFIG.retryBackoff, attempt - 1));
      } else {
        log(`All type attempts failed`, 'WARN');
        return false;
      }
    }
  }

  return false;
}

/**
 * Type with human-like delays and variation
 * @param {ElementHandle} element - Element to type into
 * @param {string} text - Text to type
 */
async function typeHumanLike(element, text) {
  for (const char of text) {
    await element.type(char, {
      delay: DEFAULT_CONFIG.humanTypingDelayMin +
             Math.random() * (DEFAULT_CONFIG.humanTypingDelayMax - DEFAULT_CONFIG.humanTypingDelayMin)
    });

    // Random pauses between characters
    if (Math.random() < 0.1) { // 10% chance of longer pause
      await sleep(
        DEFAULT_CONFIG.humanPauseMin +
        Math.random() * (DEFAULT_CONFIG.humanPauseMax - DEFAULT_CONFIG.humanPauseMin)
      );
    }
  }
}

/**
 * Wait for element with retries and better error messages
 * @param {Page} page - Playwright page
 * @param {string|Array} selectors - Selector(s) to wait for
 * @param {Object} options - Wait options
 * @returns {Promise<boolean>} - True if found
 */
async function smartWait(page, selectors, options = {}) {
  const {
    timeout = DEFAULT_CONFIG.mediumTimeout,
    checkInterval = DEFAULT_CONFIG.pollingInterval,
    state = 'visible',
    throwOnTimeout = false
  } = options;

  const selectorArray = Array.isArray(selectors) ? selectors : [selectors];
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    for (const selector of selectorArray) {
      try {
        await page.waitForSelector(selector, {
          timeout: checkInterval,
          state
        });

        log(`Element appeared: ${selector}`, 'DEBUG');
        return true;
      } catch (error) {
        // Continue trying
      }
    }

    await sleep(checkInterval);
  }

  const message = `Timeout waiting for element: ${selectorArray.join(', ')}`;
  log(message, 'WARN');

  if (throwOnTimeout) {
    throw new Error(message);
  }

  return false;
}

/**
 * Wait for any of multiple conditions
 * @param {Page} page - Playwright page
 * @param {Array} conditions - Array of condition objects
 * @param {Object} options - Options
 * @returns {Promise<Object>} - Matched condition info
 */
async function waitForAny(page, conditions, options = {}) {
  const {
    timeout = DEFAULT_CONFIG.longTimeout,
    checkInterval = DEFAULT_CONFIG.pollingInterval
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i];

      try {
        if (condition.type === 'selector') {
          const exists = await page.$(condition.value) !== null;
          if (exists) {
            log(`Condition met: ${condition.value}`, 'DEBUG');
            return { index: i, condition, matched: true };
          }
        } else if (condition.type === 'url') {
          if (page.url().includes(condition.value)) {
            log(`URL condition met: ${condition.value}`, 'DEBUG');
            return { index: i, condition, matched: true };
          }
        } else if (condition.type === 'text') {
          const text = await page.textContent('body').catch(() => '');
          if (text.includes(condition.value)) {
            log(`Text condition met: ${condition.value}`, 'DEBUG');
            return { index: i, condition, matched: true };
          }
        } else if (condition.type === 'custom') {
          const result = await condition.check(page);
          if (result) {
            log(`Custom condition met`, 'DEBUG');
            return { index: i, condition, matched: true };
          }
        }
      } catch (error) {
        // Continue
      }
    }

    await sleep(checkInterval);
  }

  log(`Timeout: No conditions met`, 'WARN');
  return { matched: false };
}

/**
 * Safe navigation with retry and error handling
 * @param {Page} page - Playwright page
 * @param {string} url - URL to navigate to
 * @param {Object} options - Navigation options
 * @returns {Promise<boolean>} - True if successful
 */
async function safeGoto(page, url, options = {}) {
  const {
    retries = DEFAULT_CONFIG.maxRetries,
    timeout = DEFAULT_CONFIG.extraLongTimeout,
    waitUntil = 'domcontentloaded',
    expectUrl = null
  } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(`Navigation attempt ${attempt}/${retries} to: ${url}`, 'DEBUG');

      await page.goto(url, {
        waitUntil,
        timeout: timeout / retries
      });

      // Wait for page to stabilize
      await waitForPageReady(page);

      // Verify URL if expected
      if (expectUrl && !page.url().includes(expectUrl)) {
        log(`URL mismatch. Expected: ${expectUrl}, Got: ${page.url()}`, 'WARN');
        if (attempt < retries) {
          continue;
        }
      }

      log(`Successfully navigated to: ${page.url()}`, 'DEBUG');
      return true;

    } catch (error) {
      log(`Navigation attempt ${attempt} failed: ${error.message}`, 'DEBUG');

      if (attempt < retries) {
        await sleep(DEFAULT_CONFIG.retryDelay * Math.pow(DEFAULT_CONFIG.retryBackoff, attempt - 1));
      } else {
        log(`All navigation attempts failed to: ${url}`, 'ERROR');
        return false;
      }
    }
  }

  return false;
}

/**
 * Take debug screenshot with automatic naming
 * @param {Page} page - Playwright page
 * @param {string} label - Label for screenshot
 * @param {Object} options - Screenshot options
 * @returns {Promise<string>} - Screenshot path
 */
async function debugScreenshot(page, label, options = {}) {
  const {
    fullPage = false,
    dir = DEFAULT_CONFIG.screenshotDir
  } = options;

  const timestamp = Date.now();
  const filename = `${label}_${timestamp}.png`;
  const filepath = path.join(dir, filename);

  try {
    await page.screenshot({ path: filepath, fullPage });
    log(`Screenshot saved: ${filepath}`, 'DEBUG');
    return filepath;
  } catch (error) {
    log(`Screenshot failed: ${error.message}`, 'ERROR');
    return null;
  }
}

/**
 * Get page state for debugging
 * @param {Page} page - Playwright page
 * @returns {Promise<Object>} - Page state info
 */
async function getPageState(page) {
  try {
    const state = {
      url: page.url(),
      title: await page.title().catch(() => 'N/A'),
      ready: await page.evaluate(() => document.readyState).catch(() => 'unknown'),
      visible: await page.isVisible('body').catch(() => false),
      screenshots: []
    };

    // Take a screenshot
    const screenshotPath = await debugScreenshot(page, 'state');
    if (screenshotPath) {
      state.screenshots.push(screenshotPath);
    }

    return state;
  } catch (error) {
    log(`Could not get page state: ${error.message}`, 'ERROR');
    return { error: error.message };
  }
}

/**
 * Detect and handle common issues
 * @param {Page} page - Playwright page
 * @returns {Promise<Object>} - Issue detection results
 */
async function detectIssues(page) {
  const issues = {
    captcha: false,
    error: false,
    blocked: false,
    rateLimit: false,
    redirect: false
  };

  try {
    const url = page.url();
    const text = await page.textContent('body').catch(() => '');
    const lowerText = text.toLowerCase();

    // CAPTCHA detection
    const captchaSelectors = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'iframe[src*="captcha"]',
      '.captcha',
      '#captcha'
    ];
    for (const sel of captchaSelectors) {
      if (await page.$(sel)) {
        issues.captcha = true;
        break;
      }
    }

    // Error page detection
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

    // Unexpected redirect
    if (url.includes('login') || url.includes('signin')) {
      issues.redirect = true;
    }

  } catch (error) {
    log(`Issue detection failed: ${error.message}`, 'DEBUG');
  }

  return issues;
}

/**
 * Execute function with retry and error recovery
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Retry options
 * @returns {Promise<any>} - Function result
 */
async function withRetry(fn, options = {}) {
  const {
    retries = DEFAULT_CONFIG.maxRetries,
    delay = DEFAULT_CONFIG.retryDelay,
    backoff = DEFAULT_CONFIG.retryBackoff,
    onRetry = null,
    shouldRetry = null
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(`Executing attempt ${attempt}/${retries}`, 'DEBUG');
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error;
      log(`Attempt ${attempt} failed: ${error.message}`, 'DEBUG');

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      if (attempt < retries) {
        const waitTime = delay * Math.pow(backoff, attempt - 1);
        log(`Retrying in ${waitTime}ms...`, 'DEBUG');

        if (onRetry) {
          await onRetry(error, attempt);
        }

        await sleep(waitTime);
      }
    }
  }

  log(`All ${retries} attempts failed`, 'ERROR');
  throw lastError;
}

/**
 * Configure global settings
 * @param {Object} config - Configuration object
 */
function configure(config) {
  Object.assign(DEFAULT_CONFIG, config);
  log('Configuration updated', 'DEBUG');
}

/**
 * Get current configuration
 * @returns {Object} - Current config
 */
function getConfig() {
  return { ...DEFAULT_CONFIG };
}

// Export all utilities
module.exports = {
  // Core utilities
  createRobustContext,
  waitForPageReady,
  safeGoto,

  // Element interaction
  findElement,
  safeClick,
  safeType,
  smartWait,
  waitForAny,

  // Debugging
  debugScreenshot,
  getPageState,
  detectIssues,

  // Helpers
  sleep,
  typeHumanLike,
  withRetry,

  // Configuration
  configure,
  getConfig,

  // Logger
  log,

  // Constants
  DEFAULT_CONFIG
};
