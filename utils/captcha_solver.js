/**
 * CAPTCHA Auto-Solver Integration
 *
 * Integrates with 2captcha API for automated CAPTCHA solving.
 * Supports: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, image/text CAPTCHAs
 *
 * Setup:
 * 1. Get API key from https://2captcha.com
 * 2. Add to API_KEYS.md or set TWOCAPTCHA_API_KEY env var
 * 3. Fund account (~$3 per 1000 solves)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const API_BASE = 'https://2captcha.com';
const POLL_INTERVAL = 5000; // 5 seconds between status checks
const MAX_WAIT_TIME = 180000; // 3 minutes max wait
const API_KEYS_FILE = path.join(__dirname, '..', 'API_KEYS.md');
const LOGS_DIR = path.join(__dirname, '..', 'logs');

/**
 * Get 2captcha API key from environment or API_KEYS.md
 */
function getApiKey() {
  // Check environment first
  if (process.env.TWOCAPTCHA_API_KEY) {
    return process.env.TWOCAPTCHA_API_KEY;
  }

  // Try to read from API_KEYS.md
  try {
    if (fs.existsSync(API_KEYS_FILE)) {
      const content = fs.readFileSync(API_KEYS_FILE, 'utf-8');
      // Look for 2captcha key pattern
      const match = content.match(/2captcha[^`]*`([^`]+)`/i) ||
                    content.match(/TWOCAPTCHA[^`]*`([^`]+)`/i);
      if (match) {
        return match[1];
      }
    }
  } catch (e) {
    // Ignore read errors
  }

  return null;
}

/**
 * Log solver activity
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}`;
  console.log(`[CaptchaSolver] ${message}`);

  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    fs.appendFileSync(path.join(LOGS_DIR, 'captcha_solver.log'), entry + '\n');
  } catch (e) {
    // Ignore log errors
  }
}

/**
 * Make HTTP request to 2captcha API
 */
function apiRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, value);
      }
    });

    https.get(url.toString(), (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // 2captcha returns either JSON or pipe-separated text
          if (data.startsWith('{')) {
            resolve(JSON.parse(data));
          } else {
            const [status, value] = data.split('|');
            resolve({ status: status === 'OK' ? 1 : 0, request: value || status });
          }
        } catch (e) {
          resolve({ status: 0, request: data });
        }
      });
    }).on('error', reject);
  });
}

/**
 * Submit CAPTCHA for solving and wait for result
 */
async function submitAndWait(submitParams) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No 2captcha API key configured. Set TWOCAPTCHA_API_KEY or add to API_KEYS.md');
  }

  // Submit CAPTCHA
  log(`Submitting CAPTCHA: ${submitParams.method || 'unknown type'}`);
  const submitResult = await apiRequest('/in.php', {
    key: apiKey,
    json: 1,
    ...submitParams
  });

  if (submitResult.status !== 1) {
    throw new Error(`Submit failed: ${submitResult.request}`);
  }

  const taskId = submitResult.request;
  log(`CAPTCHA submitted, task ID: ${taskId}`);

  // Poll for result
  const startTime = Date.now();
  while (Date.now() - startTime < MAX_WAIT_TIME) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const result = await apiRequest('/res.php', {
      key: apiKey,
      action: 'get',
      id: taskId,
      json: 1
    });

    if (result.status === 1) {
      log(`CAPTCHA solved: ${taskId}`);
      return {
        success: true,
        solution: result.request,
        taskId
      };
    }

    if (result.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`Solve failed: ${result.request}`);
    }

    log(`Waiting for solution... (${Math.round((Date.now() - startTime) / 1000)}s)`);
  }

  throw new Error('Timeout waiting for CAPTCHA solution');
}

/**
 * Solve reCAPTCHA v2
 */
async function solveRecaptchaV2(siteKey, pageUrl, options = {}) {
  return submitAndWait({
    method: 'userrecaptcha',
    googlekey: siteKey,
    pageurl: pageUrl,
    invisible: options.invisible ? 1 : 0,
    'data-s': options.dataS,
    enterprise: options.enterprise ? 1 : 0
  });
}

/**
 * Solve reCAPTCHA v3
 */
async function solveRecaptchaV3(siteKey, pageUrl, options = {}) {
  return submitAndWait({
    method: 'userrecaptcha',
    googlekey: siteKey,
    pageurl: pageUrl,
    version: 'v3',
    action: options.action || 'verify',
    min_score: options.minScore || 0.3,
    enterprise: options.enterprise ? 1 : 0
  });
}

/**
 * Solve hCaptcha
 */
async function solveHCaptcha(siteKey, pageUrl, options = {}) {
  return submitAndWait({
    method: 'hcaptcha',
    sitekey: siteKey,
    pageurl: pageUrl,
    invisible: options.invisible ? 1 : 0,
    data: options.data
  });
}

/**
 * Solve Cloudflare Turnstile
 */
async function solveTurnstile(siteKey, pageUrl, options = {}) {
  return submitAndWait({
    method: 'turnstile',
    sitekey: siteKey,
    pageurl: pageUrl,
    action: options.action,
    data: options.data
  });
}

/**
 * Solve image CAPTCHA (text from image)
 */
async function solveImageCaptcha(imageBase64, options = {}) {
  return submitAndWait({
    method: 'base64',
    body: imageBase64,
    numeric: options.numeric, // 1 = only numbers
    minLength: options.minLength,
    maxLength: options.maxLength,
    phrase: options.phrase ? 1 : 0, // 1 = multiple words
    caseSensitive: options.caseSensitive ? 1 : 0,
    calc: options.calc ? 1 : 0, // 1 = math expression
    lang: options.lang // language code
  });
}

/**
 * Solve image CAPTCHA from file
 */
async function solveImageFile(filePath, options = {}) {
  const imageData = fs.readFileSync(filePath);
  const base64 = imageData.toString('base64');
  return solveImageCaptcha(base64, options);
}

/**
 * Solve image CAPTCHA from URL
 */
async function solveImageUrl(imageUrl, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No 2captcha API key configured');
  }

  return submitAndWait({
    method: 'get',
    url: imageUrl,
    ...options
  });
}

/**
 * Get account balance
 */
async function getBalance() {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No 2captcha API key configured');
  }

  const result = await apiRequest('/res.php', {
    key: apiKey,
    action: 'getbalance',
    json: 1
  });

  return {
    balance: parseFloat(result.request),
    currency: 'USD'
  };
}

/**
 * Report incorrect solution (get refund)
 */
async function reportIncorrect(taskId) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No 2captcha API key configured');
  }

  const result = await apiRequest('/res.php', {
    key: apiKey,
    action: 'reportbad',
    id: taskId,
    json: 1
  });

  return result.status === 1;
}

/**
 * Detect CAPTCHA type from page and solve it
 * Works with Playwright page object
 */
async function detectAndSolve(page) {
  const url = page.url();

  // Check for reCAPTCHA
  const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
  if (recaptchaFrame) {
    const siteKey = await page.evaluate(() => {
      const elem = document.querySelector('[data-sitekey]');
      return elem?.getAttribute('data-sitekey');
    });

    if (siteKey) {
      log('Detected reCAPTCHA v2');
      const result = await solveRecaptchaV2(siteKey, url);
      return { type: 'recaptcha_v2', ...result };
    }
  }

  // Check for hCaptcha
  const hcaptchaFrame = await page.$('iframe[src*="hcaptcha"]');
  if (hcaptchaFrame) {
    const siteKey = await page.evaluate(() => {
      const elem = document.querySelector('[data-sitekey]');
      return elem?.getAttribute('data-sitekey');
    });

    if (siteKey) {
      log('Detected hCaptcha');
      const result = await solveHCaptcha(siteKey, url);
      return { type: 'hcaptcha', ...result };
    }
  }

  // Check for Cloudflare Turnstile
  const turnstileFrame = await page.$('iframe[src*="challenges.cloudflare.com"]');
  if (turnstileFrame) {
    const siteKey = await page.evaluate(() => {
      const elem = document.querySelector('[data-sitekey]');
      return elem?.getAttribute('data-sitekey');
    });

    if (siteKey) {
      log('Detected Cloudflare Turnstile');
      const result = await solveTurnstile(siteKey, url);
      return { type: 'turnstile', ...result };
    }
  }

  // Check for image CAPTCHA
  const captchaImage = await page.$('img[src*="captcha"], img[alt*="captcha"], .captcha-image');
  if (captchaImage) {
    log('Detected image CAPTCHA');
    const imageSrc = await captchaImage.getAttribute('src');

    if (imageSrc.startsWith('data:image')) {
      // Base64 encoded
      const base64 = imageSrc.split(',')[1];
      const result = await solveImageCaptcha(base64);
      return { type: 'image', ...result };
    } else {
      // URL
      const result = await solveImageUrl(imageSrc);
      return { type: 'image', ...result };
    }
  }

  return { success: false, error: 'No CAPTCHA detected' };
}

/**
 * Apply solution to page
 * Works with Playwright page object
 */
async function applySolution(page, solution, captchaType) {
  switch (captchaType) {
    case 'recaptcha_v2':
    case 'recaptcha_v3':
      // Set the g-recaptcha-response
      await page.evaluate((token) => {
        document.querySelector('[name="g-recaptcha-response"]').value = token;
        // Try to find and call callback
        if (typeof window.captchaCallback === 'function') {
          window.captchaCallback(token);
        }
        // Also try grecaptcha callback
        if (typeof window.grecaptcha !== 'undefined') {
          const widgetId = window.grecaptcha.getWidgetId?.() || 0;
          window.grecaptcha.getResponse(widgetId);
        }
      }, solution);
      break;

    case 'hcaptcha':
      await page.evaluate((token) => {
        document.querySelector('[name="h-captcha-response"]').value = token;
        document.querySelector('[name="g-recaptcha-response"]').value = token; // hCaptcha also uses this
        if (typeof window.hcaptcha !== 'undefined') {
          // Trigger callback
          const iframe = document.querySelector('iframe[src*="hcaptcha"]');
          if (iframe) {
            iframe.contentWindow.postMessage({ type: 'captcha-response', response: token }, '*');
          }
        }
      }, solution);
      break;

    case 'turnstile':
      await page.evaluate((token) => {
        const input = document.querySelector('[name="cf-turnstile-response"]');
        if (input) input.value = token;
        // Trigger turnstile callback
        if (typeof window.turnstile !== 'undefined') {
          window.turnstile.getResponse();
        }
      }, solution);
      break;

    case 'image':
      // Find the text input for CAPTCHA and fill it
      const captchaInput = await page.$('input[name*="captcha"], input[id*="captcha"], input[placeholder*="captcha"]');
      if (captchaInput) {
        await captchaInput.fill(solution);
      }
      break;
  }

  log(`Applied ${captchaType} solution to page`);
}

/**
 * Full auto-solve: detect, solve, and apply
 */
async function autoSolve(page) {
  const detection = await detectAndSolve(page);

  if (!detection.success) {
    return detection;
  }

  await applySolution(page, detection.solution, detection.type);

  return {
    success: true,
    type: detection.type,
    taskId: detection.taskId
  };
}

/**
 * Check if API is configured
 */
function isConfigured() {
  return !!getApiKey();
}

module.exports = {
  // Main functions
  autoSolve,
  detectAndSolve,
  applySolution,

  // Individual solvers
  solveRecaptchaV2,
  solveRecaptchaV3,
  solveHCaptcha,
  solveTurnstile,
  solveImageCaptcha,
  solveImageFile,
  solveImageUrl,

  // Account management
  getBalance,
  reportIncorrect,

  // Utilities
  isConfigured,
  getApiKey
};
