/**
 * hCaptcha Solver
 *
 * Solves hCaptcha using accessibility features (audio/text challenges).
 * Works with Playwright browser automation.
 */

const audioSolver = require('./audio-solver');

// Selectors for hCaptcha elements
const SELECTORS = {
  // Main checkbox
  checkbox: 'iframe[src*="hcaptcha.com/captcha"]',
  checkboxInner: '#checkbox',
  checkboxChecked: '[aria-checked="true"]',

  // Challenge
  challengeFrame: 'iframe[src*="hcaptcha.com/captcha"]',
  challengeContainer: '.challenge-container',

  // Accessibility cookie (enables text/audio challenges)
  accessibilityCookie: 'hc_accessibility',

  // Task text
  taskText: '.prompt-text',

  // Image grid
  imageGrid: '.task-image',
  imageCell: '.task-image .image',

  // Verify/Skip
  verifyButton: '.button-submit',
  refreshButton: '.refresh-button',

  // Response
  responseInput: '[name="h-captcha-response"]'
};

/**
 * Set accessibility cookie to get easier challenges
 */
async function setAccessibilityCookie(page, siteUrl) {
  const url = new URL(siteUrl);
  await page.context().addCookies([{
    name: 'hc_accessibility',
    value: 'true',
    domain: '.hcaptcha.com',
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'None'
  }]);
}

/**
 * Solve hCaptcha on a Playwright page
 *
 * Note: hCaptcha is challenging to solve automatically because:
 * 1. Image challenges require visual understanding
 * 2. Audio challenges are not always available
 * 3. Rate limiting is aggressive
 *
 * This solver attempts to use accessibility features when available.
 */
async function solveHCaptcha(page, options = {}) {
  const {
    maxAttempts = 3,
    onProgress = () => {}
  } = options;

  try {
    onProgress('Looking for hCaptcha...');

    // Set accessibility cookie for potentially easier challenges
    await setAccessibilityCookie(page, page.url());

    // Find the hCaptcha iframe
    const hcaptchaFrame = await findHCaptchaFrame(page);
    if (!hcaptchaFrame) {
      return { success: false, error: 'hCaptcha not found on page' };
    }

    // Click the checkbox
    onProgress('Clicking hCaptcha checkbox...');
    const checkbox = await hcaptchaFrame.$('#checkbox');
    if (!checkbox) {
      return { success: false, error: 'hCaptcha checkbox not found' };
    }

    await checkbox.click();
    await page.waitForTimeout(2000);

    // Check if auto-passed
    const autoPass = await checkHCaptchaSolved(page);
    if (autoPass) {
      onProgress('hCaptcha auto-passed!');
      const token = await getHCaptchaToken(page);
      return { success: true, token, method: 'auto' };
    }

    // hCaptcha image challenges are difficult to solve automatically
    // We'll attempt to detect if there's an accessibility/audio option

    onProgress('Looking for accessibility options...');

    // Wait for challenge to load
    await page.waitForTimeout(2000);

    // Look for challenge iframe
    const challengeFrame = await findHCaptchaChallengeFrame(page);
    if (!challengeFrame) {
      // Maybe auto-passed with delay
      const delayedPass = await checkHCaptchaSolved(page);
      if (delayedPass) {
        const token = await getHCaptchaToken(page);
        return { success: true, token, method: 'auto-delayed' };
      }
      return { success: false, error: 'Challenge frame not found' };
    }

    // Check what type of challenge we got
    const challengeInfo = await analyzeHCaptchaChallenge(challengeFrame);
    onProgress(`Challenge type: ${challengeInfo.type}`);

    if (challengeInfo.type === 'image-select') {
      // Image challenges are hard to solve without ML/vision
      return {
        success: false,
        error: 'Image selection challenge detected. Requires manual solving or ML model.',
        challengeType: 'image-select',
        taskText: challengeInfo.taskText
      };
    }

    if (challengeInfo.type === 'text') {
      // Text challenge (rare, accessibility mode)
      onProgress('Text challenge detected, attempting OCR...');
      // Would need to implement text challenge solving
      return {
        success: false,
        error: 'Text challenge solving not yet implemented',
        challengeType: 'text'
      };
    }

    return {
      success: false,
      error: 'Unable to solve hCaptcha challenge automatically',
      challengeType: challengeInfo.type
    };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Find hCaptcha checkbox frame
 */
async function findHCaptchaFrame(page) {
  const frames = await page.frames();
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes('hcaptcha.com') && url.includes('checkbox')) {
      return frame;
    }
  }

  // Try via element
  const frameElement = await page.$('iframe[src*="hcaptcha"]');
  if (frameElement) {
    return await frameElement.contentFrame();
  }

  return null;
}

/**
 * Find hCaptcha challenge frame
 */
async function findHCaptchaChallengeFrame(page) {
  const frames = await page.frames();
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes('hcaptcha.com') && url.includes('getcaptcha')) {
      return frame;
    }
  }

  // Look for challenge container in any hcaptcha frame
  for (const frame of frames) {
    if (frame.url().includes('hcaptcha')) {
      const challenge = await frame.$('.challenge-container');
      if (challenge) return frame;
    }
  }

  return null;
}

/**
 * Check if hCaptcha is solved
 */
async function checkHCaptchaSolved(page) {
  try {
    const token = await getHCaptchaToken(page);
    return token && token.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get hCaptcha response token
 */
async function getHCaptchaToken(page) {
  try {
    const token = await page.evaluate(() => {
      const input = document.querySelector('[name="h-captcha-response"], [name="g-recaptcha-response"]');
      return input?.value || null;
    });
    return token;
  } catch {
    return null;
  }
}

/**
 * Analyze what type of hCaptcha challenge we're facing
 */
async function analyzeHCaptchaChallenge(frame) {
  try {
    // Get task text
    const taskText = await frame.$eval('.prompt-text', el => el.textContent).catch(() => null);

    // Check for image grid
    const imageGrid = await frame.$('.task-image');

    if (imageGrid) {
      return {
        type: 'image-select',
        taskText
      };
    }

    // Check for text input
    const textInput = await frame.$('input[type="text"]');
    if (textInput) {
      return {
        type: 'text',
        taskText
      };
    }

    return {
      type: 'unknown',
      taskText
    };

  } catch (e) {
    return { type: 'error', error: e.message };
  }
}

/**
 * Check if hCaptcha is present on page
 */
async function hasHCaptcha(page) {
  const frame = await page.$('iframe[src*="hcaptcha"]');
  return !!frame;
}

/**
 * Get solver status
 */
function getStatus() {
  return {
    supported: ['auto-pass', 'text-challenge'],
    unsupported: ['image-select (requires ML)'],
    audioSolver: audioSolver.getStatus()
  };
}

module.exports = {
  solveHCaptcha,
  hasHCaptcha,
  getHCaptchaToken,
  checkHCaptchaSolved,
  setAccessibilityCookie,
  getStatus,
  SELECTORS
};
