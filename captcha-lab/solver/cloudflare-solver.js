/**
 * Cloudflare Turnstile Solver
 *
 * Handles Cloudflare's "Verify you are human" challenges.
 * Uses behavioral simulation and waiting strategies with stealth capabilities.
 */

const path = require('path');
const {
  simulateHumanBehavior,
  humanDelay,
  checkBotDetection
} = require('./stealth-browser');

// Selectors for Cloudflare challenges
const SELECTORS = {
  // Turnstile widget
  turnstileIframe: 'iframe[src*="challenges.cloudflare.com"]',
  turnstileCheckbox: '#challenge-stage input[type="checkbox"]',
  turnstileWidget: '.cf-turnstile',

  // Challenge page (full-page block)
  challengePage: '#challenge-running, #challenge-stage',
  challengeForm: '#challenge-form',
  challengeSuccess: '.cf-challenge-success',

  // Interstitial page
  interstitialTitle: 'title:has-text("Just a moment")',
  rayId: '.ray-id',

  // Managed challenge
  managedChallenge: '[data-translate="managed_checking_msg"]'
};

/**
 * Wait for element with human-like delay
 */
async function waitHuman(page, ms) {
  // Add some randomness to delays
  const delay = ms + Math.random() * 500;
  await page.waitForTimeout(delay);
}

/**
 * Move mouse like a human
 */
async function humanMouseMove(page, x, y) {
  const steps = 10 + Math.floor(Math.random() * 10);
  const startX = Math.random() * 100;
  const startY = Math.random() * 100;

  // Move in steps with slight randomness
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    // Use easing function
    const eased = 1 - Math.pow(1 - progress, 3);

    const currentX = startX + (x - startX) * eased + (Math.random() - 0.5) * 5;
    const currentY = startY + (y - startY) * eased + (Math.random() - 0.5) * 5;

    await page.mouse.move(currentX, currentY);
    await page.waitForTimeout(10 + Math.random() * 20);
  }
}

/**
 * Human-like click
 */
async function humanClick(element) {
  const box = await element.boundingBox();
  if (!box) return false;

  // Click at random position within element
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);

  const page = element.page();
  await humanMouseMove(page, x, y);
  await page.waitForTimeout(50 + Math.random() * 100);
  await page.mouse.click(x, y);

  return true;
}

/**
 * Check if Cloudflare challenge is present
 */
async function hasCloudflareChallenge(page) {
  // Check for various Cloudflare indicators
  const indicators = [
    SELECTORS.turnstileIframe,
    SELECTORS.turnstileWidget,
    SELECTORS.challengePage,
    SELECTORS.managedChallenge
  ];

  for (const selector of indicators) {
    try {
      const element = await page.$(selector);
      if (element) return true;
    } catch {}
  }

  // Check page title
  const title = await page.title();
  if (title.includes('Just a moment') || title.includes('Checking your browser')) {
    return true;
  }

  // Check for Ray ID (Cloudflare signature)
  const rayId = await page.$(SELECTORS.rayId);
  if (rayId) return true;

  return false;
}

/**
 * Wait for Cloudflare challenge to complete naturally
 * Many Cloudflare challenges auto-solve with good browser fingerprint
 */
async function waitForAutoSolve(page, timeout = 90000) {
  const startTime = Date.now();

  // Perform human behavior simulation while waiting
  const behaviorPromise = simulateHumanBehavior(page, Math.min(timeout, 10000));

  while (Date.now() - startTime < timeout) {
    // Check if challenge is gone
    const hasChallenge = await hasCloudflareChallenge(page);
    if (!hasChallenge) {
      return { success: true, method: 'auto-solve' };
    }

    // Check for success indicators
    const success = await page.$(SELECTORS.challengeSuccess);
    if (success) {
      await page.waitForTimeout(1000);
      return { success: true, method: 'challenge-passed' };
    }

    // Wait with human-like timing before checking again
    await humanDelay(page, 500);
  }

  return { success: false, error: 'Auto-solve timeout' };
}

/**
 * Solve Turnstile widget (checkbox style)
 */
async function solveTurnstile(page, options = {}) {
  const { onProgress = () => {}, timeout = 90000 } = options;

  try {
    onProgress('Looking for Turnstile widget...');

    // Perform pre-challenge behavioral simulation
    onProgress('Simulating human behavior...');
    await simulateHumanBehavior(page, 3000);

    // Check if widget exists on page
    const widget = await page.$(SELECTORS.turnstileWidget);
    if (!widget) {
      return { success: false, error: 'Turnstile widget not found' };
    }

    // Wait a moment (Turnstile does behavior analysis)
    onProgress('Waiting for widget to load...');
    await humanDelay(page, 2000);

    // Turnstile renders the checkbox in a separate iframe with challenges.cloudflare.com
    // NOT as a child of the widget div, but as a top-level frame
    onProgress('Looking for Turnstile challenge iframe...');

    // Turnstile performs behavioral analysis BEFORE showing checkbox
    // The checkbox is rendered inside a cross-origin iframe with CSP
    // We cannot access the content directly, must click the iframe element itself

    onProgress('Waiting for Turnstile to finish behavioral analysis...');

    const startTime = Date.now();
    const maxWaitForCheckbox = 30000;

    // Wait and periodically check if challenge is gone (auto-solved)
    while (Date.now() - startTime < maxWaitForCheckbox) {
      // Check if page already auto-solved
      const stillHasChallenge = await hasCloudflareChallenge(page);
      if (!stillHasChallenge) {
        onProgress('Challenge auto-solved during behavioral analysis!');
        return { success: true, method: 'auto-solve-during-analysis' };
      }

      await humanDelay(page, 1000);
    }

    // After behavioral analysis, the iframe is injected into the widget
    // We should click on the widget div itself, where the checkbox appears
    onProgress('Behavioral analysis complete, attempting to click widget...');

    // Try to find the widget element (the div, not iframe)
    const widgetElement = await page.$('.cf-turnstile');

    if (widgetElement) {
      const box = await widgetElement.boundingBox();

      if (box) {
        onProgress(`Found widget at: x=${Math.round(box.x)}, y=${Math.round(box.y)}, w=${Math.round(box.width)}, h=${Math.round(box.height)}`);

        // Click in the typical checkbox area (left side, centered vertically)
        const clickX = box.x + 30; // Checkbox is usually ~30px from left
        const clickY = box.y + (box.height / 2);

        onProgress(`Clicking widget at: (${Math.round(clickX)}, ${Math.round(clickY)})`);

        // Pre-click delay
        await humanDelay(page, 800);

        // Move mouse and click
        await humanMouseMove(page, clickX, clickY);
        await page.waitForTimeout(300);
        await page.mouse.click(clickX, clickY);

        onProgress('Clicked widget! Waiting for response...');

        // Wait for verification
        await humanDelay(page, 3000);
      } else {
        onProgress('Warning: Could not get widget bounding box');
      }
    } else {
      onProgress('No Turnstile widget found on page');
    }

    // Wait for verification with continued human behavior
    onProgress('Waiting for verification...');
    const result = await waitForAutoSolve(page, timeout);

    if (result.success) {
      onProgress('Turnstile solved!');
    }

    return result;

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Handle Cloudflare interstitial page
 * The "Just a moment..." page that appears before site access
 */
async function handleInterstitial(page, options = {}) {
  const { onProgress = () => {}, timeout = 90000 } = options;

  try {
    onProgress('Detected Cloudflare interstitial...');

    // Check for bot detection signals
    const botCheck = await checkBotDetection(page);
    if (botCheck.isLikelyBot) {
      onProgress(`Warning: ${botCheck.redFlags} bot detection signals found`);
    }

    // Perform behavioral simulation before challenge
    onProgress('Simulating human behavior...');
    await simulateHumanBehavior(page, 5000);

    // First, try waiting for auto-solve
    onProgress('Waiting for automatic verification...');
    const autoResult = await waitForAutoSolve(page, timeout);

    if (autoResult.success) {
      onProgress('Page loaded automatically!');
      return autoResult;
    }

    // Check if there's a manual action required
    const turnstile = await page.$(SELECTORS.turnstileIframe);
    if (turnstile) {
      onProgress('Manual Turnstile verification required...');
      return await solveTurnstile(page, options);
    }

    // If still stuck, the browser fingerprint might be flagged
    return {
      success: false,
      error: 'Cloudflare blocked - may need different browser profile'
    };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Main solver entry point
 */
async function solveCloudflare(page, options = {}) {
  const { onProgress = () => {}, timeout = 90000 } = options;

  try {
    onProgress('Checking for Cloudflare protection...');

    // First check what type of challenge we have
    const hasChallenge = await hasCloudflareChallenge(page);
    if (!hasChallenge) {
      return { success: true, message: 'No Cloudflare challenge detected' };
    }

    // Perform initial bot detection check
    const botCheck = await checkBotDetection(page);
    if (botCheck.isLikelyBot) {
      onProgress(`Warning: Bot detection signals found (${botCheck.redFlags} red flags)`);
      onProgress('Signals: ' + JSON.stringify(botCheck.signals));
    }

    // Check page title to determine challenge type
    const title = await page.title();

    if (title.includes('Just a moment')) {
      return await handleInterstitial(page, options);
    }

    // Check for Turnstile widget (iframe or direct widget)
    const turnstileIframe = await page.$(SELECTORS.turnstileIframe);
    const turnstileWidget = await page.$(SELECTORS.turnstileWidget);

    if (turnstileIframe || turnstileWidget) {
      return await solveTurnstile(page, options);
    }

    // Try generic wait for auto-solve
    return await waitForAutoSolve(page, timeout);

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Get solver status
 */
function getStatus() {
  return {
    ready: true,
    note: 'Cloudflare solver uses behavioral simulation. Works best with persistent browser profiles.'
  };
}

/**
 * Tips for better Cloudflare bypass
 */
const TIPS = [
  'Use the stealth-browser module for automatic stealth configuration',
  'Use a persistent browser context with saved cookies/state',
  'Enable JavaScript and modern browser features',
  'Use a residential IP address if possible',
  'Avoid headless mode - always use headed browser (headless: false)',
  'Add realistic browser fingerprint (timezone, language, etc.)',
  'Allow sufficient timeout (90 seconds recommended)',
  'Perform behavioral simulation before challenges appear',
  'Use realistic viewport sizes and user agents',
  'Enable WebGL and canvas fingerprinting protection'
];

module.exports = {
  solveCloudflare,
  solveTurnstile,
  handleInterstitial,
  hasCloudflareChallenge,
  waitForAutoSolve,
  humanMouseMove,
  humanClick,
  getStatus,
  SELECTORS,
  TIPS
};
