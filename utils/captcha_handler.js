/**
 * Advanced CAPTCHA Handler for Browser Automation
 *
 * Features:
 * - Comprehensive detection for all major CAPTCHA types
 * - Automatic Cloudflare challenge waiting
 * - Smart screenshot cropping
 * - Interactive user-assisted solving via Discord/Telegram
 * - Retry logic with exponential backoff
 * - reCAPTCHA audio challenge support (accessibility)
 * - Progress tracking and status updates
 */

const fs = require('fs');
const path = require('path');

// Import unified solver from captcha-lab
let unifiedSolver = null;
try {
  unifiedSolver = require('../captcha-lab/solver/unified-solver');
} catch (e) {
  console.log('Unified CAPTCHA solver not available:', e.message);
}

// Directory for CAPTCHA screenshots
const CAPTCHA_DIR = path.join(__dirname, '..', 'screenshots', 'captchas');
const CAPTCHA_LOG = path.join(__dirname, '..', 'logs', 'captcha_log.json');

// Ensure directories exist
if (!fs.existsSync(CAPTCHA_DIR)) {
  fs.mkdirSync(CAPTCHA_DIR, { recursive: true });
}
if (!fs.existsSync(path.dirname(CAPTCHA_LOG))) {
  fs.mkdirSync(path.dirname(CAPTCHA_LOG), { recursive: true });
}

// Comprehensive CAPTCHA selectors
const CAPTCHA_SELECTORS = {
  recaptcha_v2: [
    'iframe[src*="recaptcha/api2"]',
    'iframe[src*="recaptcha/enterprise"]',
    '.g-recaptcha',
    '#g-recaptcha',
    '[data-sitekey]',
    'iframe[title*="reCAPTCHA"]'
  ],
  recaptcha_v3: [
    '.grecaptcha-badge',
    '[data-sitekey][data-size="invisible"]'
  ],
  hcaptcha: [
    'iframe[src*="hcaptcha.com"]',
    '.h-captcha',
    '[data-hcaptcha-sitekey]',
    'iframe[title*="hCaptcha"]'
  ],
  cloudflare_turnstile: [
    'iframe[src*="challenges.cloudflare.com/turnstile"]',
    '#cf-turnstile',
    '.cf-turnstile',
    '[data-turnstile-sitekey]'
  ],
  cloudflare_challenge: [
    '#challenge-running',
    '#challenge-form',
    '.cf-browser-verification',
    '#cf-content',
    'div[id*="challenge"]'
  ],
  arkose_funcaptcha: [
    'iframe[src*="arkoselabs.com"]',
    'iframe[src*="funcaptcha.com"]',
    '#arkose',
    '[data-callback*="arkose"]',
    '#FunCaptcha'
  ],
  text_captcha: [
    'img[src*="captcha"]',
    'img[alt*="captcha"]',
    '.captcha-image',
    '#captcha-image',
    'img[id*="captcha"]',
    'canvas[id*="captcha"]'
  ],
  geetest: [
    '.geetest_holder',
    '.geetest_panel',
    '#geetest',
    '[data-gt]'
  ],
  aws_waf: [
    '#aws-waf-token',
    'iframe[src*="awswaf"]'
  ],
  datadome: [
    'iframe[src*="datadome"]',
    '#datadome'
  ],
  perimeterx: [
    '#px-captcha',
    'iframe[src*="perimeterx"]'
  ]
};

// Keywords that indicate CAPTCHA presence
const CAPTCHA_KEYWORDS = [
  'verify you are human',
  'prove you are not a robot',
  'i\'m not a robot',
  'security check',
  'confirm you are not a bot',
  'please complete the security check',
  'checking your browser',
  'just a moment',
  'verifying you are human',
  'human verification',
  'bot protection',
  'please verify',
  'ddos protection',
  'access denied',
  'unusual traffic'
];

// Cloudflare-specific text patterns
const CLOUDFLARE_PATTERNS = [
  'checking your browser before accessing',
  'this process is automatic',
  'please wait',
  'ray id',
  'cloudflare',
  'performance & security by cloudflare'
];

/**
 * Initialize CAPTCHA log
 */
function initCaptchaLog() {
  if (!fs.existsSync(CAPTCHA_LOG)) {
    fs.writeFileSync(CAPTCHA_LOG, JSON.stringify({ captchas: [], stats: { total: 0, solved: 0, failed: 0, timeout: 0 } }, null, 2));
  }
}

/**
 * Log CAPTCHA event
 */
function logCaptchaEvent(event) {
  initCaptchaLog();
  const log = JSON.parse(fs.readFileSync(CAPTCHA_LOG, 'utf-8'));
  log.captchas.push({
    ...event,
    timestamp: new Date().toISOString()
  });

  // Update stats
  log.stats.total++;
  if (event.status === 'solved') log.stats.solved++;
  if (event.status === 'failed') log.stats.failed++;
  if (event.status === 'timeout') log.stats.timeout++;

  fs.writeFileSync(CAPTCHA_LOG, JSON.stringify(log, null, 2));
}

/**
 * Detect CAPTCHA type and presence
 * @param {Page} page - Playwright page object
 * @returns {Object|null} - Detailed CAPTCHA info or null
 */
async function detectCaptcha(page) {
  const result = {
    detected: false,
    type: null,
    subtype: null,
    selector: null,
    element: null,
    isCloudflare: false,
    requiresInteraction: true,
    confidence: 0
  };

  // Check URL for Cloudflare challenge
  const url = page.url();
  if (url.includes('challenge') || url.includes('cdn-cgi')) {
    result.isCloudflare = true;
  }

  // Check selectors by type
  for (const [type, selectors] of Object.entries(CAPTCHA_SELECTORS)) {
    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const visible = await element.isVisible().catch(() => true);
          const box = await element.boundingBox().catch(() => null);

          if (visible || box) {
            result.detected = true;
            result.type = type.split('_')[0]; // e.g., 'recaptcha' from 'recaptcha_v2'
            result.subtype = type;
            result.selector = selector;
            result.element = element;
            result.confidence = 0.9;

            // Check if it's a Cloudflare challenge page
            if (type.includes('cloudflare')) {
              result.isCloudflare = true;
              result.requiresInteraction = type !== 'cloudflare_challenge'; // Challenge pages often auto-resolve
            }

            return result;
          }
        }
      } catch (e) {
        // Continue
      }
    }
  }

  // Check page text for keywords
  try {
    const pageText = await page.textContent('body').catch(() => '');
    const lowerText = pageText.toLowerCase();

    // Check Cloudflare patterns first
    for (const pattern of CLOUDFLARE_PATTERNS) {
      if (lowerText.includes(pattern)) {
        result.detected = true;
        result.type = 'cloudflare';
        result.subtype = 'cloudflare_wait';
        result.isCloudflare = true;
        result.requiresInteraction = false; // Usually auto-resolves
        result.confidence = 0.7;
        return result;
      }
    }

    // Check general CAPTCHA keywords
    for (const keyword of CAPTCHA_KEYWORDS) {
      if (lowerText.includes(keyword)) {
        result.detected = true;
        result.type = 'generic';
        result.subtype = 'keyword_detected';
        result.keyword = keyword;
        result.confidence = 0.5;
        return result;
      }
    }
  } catch (e) {
    // Continue
  }

  return result.detected ? result : null;
}

/**
 * Wait for Cloudflare challenge to auto-resolve
 * @param {Page} page - Playwright page object
 * @param {number} maxWait - Maximum wait time in ms
 * @returns {boolean} - True if resolved, false if still blocked
 */
async function waitForCloudflare(page, maxWait = 30000) {
  console.log('Waiting for Cloudflare challenge to resolve...');
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    await page.waitForTimeout(2000);

    // Check if challenge is gone
    const captcha = await detectCaptcha(page);
    if (!captcha || !captcha.isCloudflare) {
      console.log('Cloudflare challenge resolved!');
      return true;
    }

    // Check for interactive Turnstile that appeared
    if (captcha.subtype === 'cloudflare_turnstile') {
      console.log('Cloudflare Turnstile requires interaction');
      return false;
    }

    console.log('Still waiting for Cloudflare...');
  }

  console.log('Cloudflare wait timeout');
  return false;
}

/**
 * Take optimized screenshot of CAPTCHA
 * @param {Page} page - Playwright page object
 * @param {Object} captchaInfo - Detection result
 * @returns {string} - Path to screenshot
 */
async function screenshotCaptcha(page, captchaInfo = null) {
  const timestamp = Date.now();
  const type = captchaInfo?.type || 'unknown';
  const filename = `captcha_${type}_${timestamp}.png`;
  const filepath = path.join(CAPTCHA_DIR, filename);

  try {
    if (captchaInfo?.element) {
      // Try element screenshot with padding
      const box = await captchaInfo.element.boundingBox();
      if (box) {
        // Add padding around the CAPTCHA
        const padding = 20;
        await page.screenshot({
          path: filepath,
          clip: {
            x: Math.max(0, box.x - padding),
            y: Math.max(0, box.y - padding),
            width: box.width + (padding * 2),
            height: box.height + (padding * 2)
          }
        });
        console.log(`CAPTCHA element screenshot saved: ${filepath}`);
        return filepath;
      }
    }

    // Fallback: viewport screenshot
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`CAPTCHA page screenshot saved: ${filepath}`);
    return filepath;

  } catch (error) {
    console.error('Screenshot error:', error.message);
    // Ultimate fallback
    await page.screenshot({ path: filepath });
    return filepath;
  }
}

/**
 * Attempt reCAPTCHA audio challenge (accessibility feature)
 * @param {Page} page - Playwright page object
 * @returns {boolean} - True if audio challenge started
 */
async function tryRecaptchaAudio(page) {
  try {
    // Find reCAPTCHA iframe
    const frame = page.frameLocator('iframe[src*="recaptcha"]').first();

    // Click the audio button
    const audioButton = frame.locator('#recaptcha-audio-button, .rc-button-audio');
    if (await audioButton.isVisible({ timeout: 3000 })) {
      await audioButton.click();
      console.log('Switched to reCAPTCHA audio challenge');
      return true;
    }
  } catch (e) {
    console.log('Could not switch to audio challenge:', e.message);
  }
  return false;
}

/**
 * Wait for user to solve CAPTCHA
 * @param {string} screenshotPath - Path to screenshot
 * @param {number} timeout - Max wait in ms (default 5 min)
 * @returns {Promise<string|null>} - Solution or null
 */
async function waitForCaptchaSolution(screenshotPath, timeout = 300000) {
  const solutionFile = screenshotPath.replace('.png', '_solution.txt');
  const startTime = Date.now();

  console.log(`Waiting for CAPTCHA solution...`);
  console.log(`Solution file: ${solutionFile}`);

  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (fs.existsSync(solutionFile)) {
        const solution = fs.readFileSync(solutionFile, 'utf-8').trim();
        clearInterval(checkInterval);

        // Clean up
        try { fs.unlinkSync(solutionFile); } catch (e) {}

        console.log(`CAPTCHA solution received`);
        resolve(solution);
      }

      if (Date.now() - startTime > timeout) {
        clearInterval(checkInterval);
        console.log('CAPTCHA solution timeout');
        resolve(null);
      }
    }, 1000);
  });
}

/**
 * Complete CAPTCHA handling flow with messaging integration
 * @param {Page} page - Playwright page object
 * @param {Function} sendMessage - Function to send message to user (receives string)
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} - Result object
 */
async function handleCaptcha(page, sendMessage, options = {}) {
  const {
    autoWaitCloudflare = true,
    tryAudioFirst = false,
    maxRetries = 3,
    timeout = 300000
  } = options;

  const result = {
    success: false,
    type: null,
    attempts: 0,
    error: null
  };

  // Detect CAPTCHA
  const captchaInfo = await detectCaptcha(page);

  if (!captchaInfo) {
    result.success = true;
    result.type = 'none';
    return result;
  }

  result.type = captchaInfo.type;
  console.log(`CAPTCHA detected: ${captchaInfo.type} (${captchaInfo.subtype})`);

  // Handle Cloudflare auto-wait
  if (captchaInfo.isCloudflare && autoWaitCloudflare && !captchaInfo.requiresInteraction) {
    if (sendMessage) {
      await sendMessage(`⏳ Cloudflare challenge detected. Waiting for auto-resolution...`);
    }

    const resolved = await waitForCloudflare(page);
    if (resolved) {
      result.success = true;
      logCaptchaEvent({ type: 'cloudflare', status: 'auto_resolved' });
      if (sendMessage) {
        await sendMessage(`✅ Cloudflare challenge resolved automatically!`);
      }
      return result;
    }

    // Re-detect after wait
    const newInfo = await detectCaptcha(page);
    if (!newInfo) {
      result.success = true;
      return result;
    }
  }

  // Try audio challenge for reCAPTCHA if enabled
  if (tryAudioFirst && captchaInfo.type === 'recaptcha') {
    const audioStarted = await tryRecaptchaAudio(page);
    if (audioStarted && sendMessage) {
      await sendMessage(`🔊 Switched to audio CAPTCHA. Listen and type what you hear.`);
    }
  }

  // Take screenshot
  const screenshotPath = await screenshotCaptcha(page, captchaInfo);

  // Notify user
  if (sendMessage) {
    const typeDisplay = captchaInfo.subtype || captchaInfo.type;
    await sendMessage(
      `🔐 **CAPTCHA Detected: ${typeDisplay}**\n` +
      `Screenshot saved. Please solve and reply with the answer.\n` +
      `(Or reply "skip" to abort, "retry" to refresh)`
    );
  }

  // Wait for solution with retry logic
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    result.attempts = attempt;

    const solution = await waitForCaptchaSolution(screenshotPath, timeout);

    if (!solution) {
      result.error = 'timeout';
      logCaptchaEvent({ type: captchaInfo.type, status: 'timeout', attempts: attempt });
      if (sendMessage) {
        await sendMessage(`⏱️ CAPTCHA timeout. No solution received.`);
      }
      return result;
    }

    // Handle special commands
    if (solution.toLowerCase() === 'skip') {
      result.error = 'skipped';
      logCaptchaEvent({ type: captchaInfo.type, status: 'skipped', attempts: attempt });
      if (sendMessage) {
        await sendMessage(`⏭️ CAPTCHA skipped by user.`);
      }
      return result;
    }

    if (solution.toLowerCase() === 'retry') {
      if (sendMessage) {
        await sendMessage(`🔄 Refreshing CAPTCHA...`);
      }
      await page.reload();
      await page.waitForTimeout(2000);

      // Recursively handle new CAPTCHA
      return handleCaptcha(page, sendMessage, { ...options, maxRetries: maxRetries - 1 });
    }

    // Enter solution
    const entered = await enterCaptchaSolution(page, solution, captchaInfo);

    if (entered) {
      // Wait for page change
      await page.waitForTimeout(2000);

      // Check if CAPTCHA is still there
      const stillThere = await detectCaptcha(page);
      if (!stillThere) {
        result.success = true;
        logCaptchaEvent({ type: captchaInfo.type, status: 'solved', attempts: attempt });
        if (sendMessage) {
          await sendMessage(`✅ CAPTCHA solved successfully!`);
        }
        return result;
      }

      // CAPTCHA still present - wrong solution
      if (attempt < maxRetries && sendMessage) {
        await sendMessage(`❌ Solution incorrect. Please try again (attempt ${attempt + 1}/${maxRetries})`);
        // Take new screenshot
        await screenshotCaptcha(page, await detectCaptcha(page));
      }
    } else {
      result.error = 'input_not_found';
      if (sendMessage) {
        await sendMessage(`⚠️ Could not find CAPTCHA input field. May need manual intervention.`);
      }
    }
  }

  result.error = 'max_retries';
  logCaptchaEvent({ type: captchaInfo.type, status: 'failed', attempts: result.attempts });
  if (sendMessage) {
    await sendMessage(`❌ CAPTCHA failed after ${maxRetries} attempts.`);
  }

  return result;
}

/**
 * Enter CAPTCHA solution
 * @param {Page} page - Playwright page object
 * @param {string} solution - Solution text
 * @param {Object} captchaInfo - Detection info
 * @returns {boolean} - Success
 */
async function enterCaptchaSolution(page, solution, captchaInfo = null) {
  // Common input selectors
  const inputSelectors = [
    'input[name*="captcha"]',
    'input[id*="captcha"]',
    'input[placeholder*="captcha"]',
    'input[aria-label*="captcha"]',
    '#captcha-input',
    '.captcha-input',
    '#captcha',
    'input[type="text"]:visible',
    '#audio-response', // reCAPTCHA audio
    '#recaptcha-audio-input'
  ];

  for (const selector of inputSelectors) {
    try {
      const input = await page.$(selector);
      if (input) {
        const visible = await input.isVisible().catch(() => false);
        const editable = await input.isEditable().catch(() => false);

        if (visible && editable) {
          await input.fill(solution);

          // Try to submit
          await input.press('Enter').catch(() => {});

          // Also try clicking submit buttons
          const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            '#captcha-submit',
            '.captcha-submit',
            '#recaptcha-verify-button',
            'button:has-text("Verify")',
            'button:has-text("Submit")'
          ];

          for (const submitSel of submitSelectors) {
            try {
              const btn = await page.$(submitSel);
              if (btn && await btn.isVisible()) {
                await btn.click();
                break;
              }
            } catch (e) {}
          }

          console.log(`Entered CAPTCHA solution via ${selector}`);
          return true;
        }
      }
    } catch (e) {
      // Continue
    }
  }

  // Try within iframes
  try {
    const frames = page.frames();
    for (const frame of frames) {
      for (const selector of inputSelectors) {
        try {
          const input = await frame.$(selector);
          if (input && await input.isVisible()) {
            await input.fill(solution);
            await input.press('Enter').catch(() => {});
            console.log(`Entered CAPTCHA in iframe via ${selector}`);
            return true;
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  console.log('Could not find CAPTCHA input');
  return false;
}

/**
 * Save solution for pending CAPTCHA
 * @param {string} solution - Solution text
 * @param {string} captchaId - Optional specific ID
 */
function saveCaptchaSolution(solution, captchaId = null) {
  const files = fs.readdirSync(CAPTCHA_DIR)
    .filter(f => f.endsWith('.png'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log('No pending CAPTCHAs');
    return false;
  }

  const targetFile = captchaId
    ? files.find(f => f.includes(captchaId))
    : files[0];

  if (!targetFile) {
    console.log('Target CAPTCHA not found');
    return false;
  }

  const solutionFile = path.join(CAPTCHA_DIR, targetFile.replace('.png', '_solution.txt'));
  fs.writeFileSync(solutionFile, solution);
  console.log(`Saved solution: ${solutionFile}`);
  return true;
}

/**
 * Get pending CAPTCHAs
 */
function getPendingCaptchas() {
  const files = fs.readdirSync(CAPTCHA_DIR);
  const screenshots = files.filter(f => f.endsWith('.png'));
  const solutions = files.filter(f => f.endsWith('_solution.txt'));

  return screenshots
    .filter(s => !solutions.includes(s.replace('.png', '_solution.txt')))
    .map(s => ({
      path: path.join(CAPTCHA_DIR, s),
      timestamp: s.match(/captcha_\w+_(\d+)\.png/)?.[1],
      type: s.match(/captcha_(\w+)_\d+\.png/)?.[1] || 'unknown'
    }));
}

/**
 * Get CAPTCHA statistics
 */
function getCaptchaStats() {
  initCaptchaLog();
  const log = JSON.parse(fs.readFileSync(CAPTCHA_LOG, 'utf-8'));
  return {
    ...log.stats,
    successRate: log.stats.total > 0 ? (log.stats.solved / log.stats.total * 100).toFixed(1) + '%' : 'N/A',
    recentCaptchas: log.captchas.slice(-10)
  };
}

/**
 * Clean old CAPTCHA files
 * @param {number} maxAge - Max age in hours (default 24)
 */
function cleanOldCaptchas(maxAge = 24) {
  const maxAgeMs = maxAge * 60 * 60 * 1000;
  const now = Date.now();

  const files = fs.readdirSync(CAPTCHA_DIR);
  let cleaned = 0;

  for (const file of files) {
    const filepath = path.join(CAPTCHA_DIR, file);
    const stats = fs.statSync(filepath);

    if (now - stats.mtimeMs > maxAgeMs) {
      fs.unlinkSync(filepath);
      cleaned++;
    }
  }

  console.log(`Cleaned ${cleaned} old CAPTCHA files`);
  return cleaned;
}

/**
 * Attempt automatic CAPTCHA solving before requesting user help
 * Uses AI-powered solvers for image CAPTCHAs and audio transcription
 *
 * @param {Page} page - Playwright page object
 * @param {Function} sendMessage - Function to send status updates
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} - Result object
 */
async function autoSolveCaptcha(page, sendMessage, options = {}) {
  const {
    preferAudio = true,      // Prefer audio challenge (more reliable)
    fallbackToUser = true,   // Ask user if auto-solve fails
    maxAttempts = 3,
    timeout = 60000
  } = options;

  const result = {
    success: false,
    method: null,
    attempts: 0,
    error: null
  };

  // Check if unified solver is available
  if (!unifiedSolver) {
    if (sendMessage) {
      await sendMessage('⚠️ Auto-solver not available. Falling back to manual solving.');
    }
    return handleCaptcha(page, sendMessage, options);
  }

  try {
    // Get solver status
    const status = unifiedSolver.getStatus();
    if (sendMessage) {
      await sendMessage(`🤖 Attempting automatic CAPTCHA solving...`);
    }

    // Log available solving methods
    const methods = [];
    if (status.ready.audio) methods.push('audio');
    if (status.ready.image) methods.push('image-AI');
    if (status.ready.cloudflare) methods.push('cloudflare');
    if (status.ready.ocr) methods.push('OCR');

    console.log('Available solving methods:', methods.join(', '));

    // Attempt auto-solve
    const solveResult = await unifiedSolver.solveCaptcha(page, {
      preferAudio,
      maxAttempts,
      timeout,
      onProgress: async (msg) => {
        console.log('CAPTCHA progress:', msg);
        // Optionally send progress updates
      },
      onCaptchaRequest: fallbackToUser ? async (info) => {
        // User intervention callback
        if (sendMessage) {
          await sendMessage(
            `🔐 **${info.name} requires manual help**\n` +
            `${info.message}\n` +
            `Reply with the solution or "skip" to abort.`
          );
        }

        // Wait for user solution
        const solution = await waitForCaptchaSolution(info.screenshotPath, timeout);
        return solution;
      } : null
    });

    result.success = solveResult.success;
    result.method = solveResult.method;
    result.attempts = solveResult.attempts || 1;
    result.error = solveResult.error;

    if (solveResult.success) {
      logCaptchaEvent({
        type: 'auto_solve',
        method: solveResult.method,
        status: 'solved',
        attempts: result.attempts
      });

      if (sendMessage) {
        await sendMessage(`✅ CAPTCHA solved automatically using ${solveResult.method}!`);
      }
    } else if (fallbackToUser) {
      if (sendMessage) {
        await sendMessage(`⚠️ Auto-solve failed: ${solveResult.error}. Requesting manual help...`);
      }
      return handleCaptcha(page, sendMessage, options);
    } else {
      logCaptchaEvent({
        type: 'auto_solve',
        method: 'failed',
        status: 'failed',
        error: solveResult.error
      });

      if (sendMessage) {
        await sendMessage(`❌ CAPTCHA auto-solve failed: ${solveResult.error}`);
      }
    }

    return result;

  } catch (e) {
    result.error = e.message;

    if (fallbackToUser) {
      if (sendMessage) {
        await sendMessage(`⚠️ Auto-solver error: ${e.message}. Falling back to manual...`);
      }
      return handleCaptcha(page, sendMessage, options);
    }

    return result;
  }
}

/**
 * Get auto-solver status
 */
function getAutoSolverStatus() {
  if (!unifiedSolver) {
    return { available: false, error: 'Unified solver not loaded' };
  }

  const status = unifiedSolver.getStatus();
  return {
    available: true,
    audio: status.audio,
    image: status.image,
    cloudflare: status.cloudflare,
    ocr: status.ocr,
    ready: status.ready
  };
}

module.exports = {
  // Detection
  detectCaptcha,
  screenshotCaptcha,

  // Manual solving
  waitForCaptchaSolution,
  handleCaptcha,
  enterCaptchaSolution,
  saveCaptchaSolution,

  // Auto solving (NEW)
  autoSolveCaptcha,
  getAutoSolverStatus,

  // Utilities
  getPendingCaptchas,
  getCaptchaStats,
  cleanOldCaptchas,
  waitForCloudflare,
  tryRecaptchaAudio,

  // Constants
  CAPTCHA_DIR,
  CAPTCHA_SELECTORS,
  CAPTCHA_KEYWORDS
};
