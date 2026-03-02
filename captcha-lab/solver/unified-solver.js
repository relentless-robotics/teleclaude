/**
 * Unified CAPTCHA Solver
 *
 * Auto-detects and solves various CAPTCHA types:
 * - reCAPTCHA v2 (checkbox + image/audio challenges)
 * - hCaptcha (checkbox + image challenges)
 * - Cloudflare Turnstile ("Verify you are human")
 * - Text/Image CAPTCHAs (OCR-based)
 *
 * This is the main entry point for CAPTCHA solving during web automation.
 */

const recaptchaSolver = require('./recaptcha-solver');
const imageSolver = require('./image-captcha-solver');
const cloudflareSolver = require('./cloudflare-solver');
const audioSolver = require('./audio-solver');
const ocrSolver = require('./ocr-solver');

// Detection selectors for various CAPTCHA types
const CAPTCHA_TYPES = {
  RECAPTCHA_V2: {
    name: 'reCAPTCHA v2',
    selectors: [
      'iframe[src*="recaptcha/api2/anchor"]',
      'iframe[src*="recaptcha/api2/bframe"]',
      '.g-recaptcha',
      '[data-sitekey]'
    ]
  },
  RECAPTCHA_V3: {
    name: 'reCAPTCHA v3',
    selectors: [
      'iframe[src*="recaptcha/api.js"]',
      '.grecaptcha-badge'
    ],
    note: 'v3 is invisible and score-based, cannot be "solved" directly'
  },
  HCAPTCHA: {
    name: 'hCaptcha',
    selectors: [
      'iframe[src*="hcaptcha.com"]',
      '.h-captcha',
      '[data-hcaptcha-widget-id]'
    ]
  },
  CLOUDFLARE_TURNSTILE: {
    name: 'Cloudflare Turnstile',
    selectors: [
      'iframe[src*="challenges.cloudflare.com"]',
      '.cf-turnstile',
      '[data-turnstile-widget]'
    ]
  },
  CLOUDFLARE_INTERSTITIAL: {
    name: 'Cloudflare Interstitial',
    indicators: ['Just a moment...', 'Checking your browser'],
    selectors: [
      '#challenge-running',
      '#challenge-stage',
      '.ray-id'
    ]
  },
  TEXT_CAPTCHA: {
    name: 'Text CAPTCHA',
    selectors: [
      'img[alt*="captcha" i]',
      'img[src*="captcha" i]',
      '.captcha-image',
      '#captcha-image'
    ]
  },
  ARKOSE: {
    name: 'Arkose/FunCaptcha',
    selectors: [
      'iframe[src*="arkoselabs.com"]',
      'iframe[src*="funcaptcha.com"]'
    ],
    note: 'Very difficult, may require user intervention'
  }
};

/**
 * Detect which CAPTCHA type is present on the page
 */
async function detectCaptchaType(page) {
  const detected = [];

  // Check page title for Cloudflare interstitial
  const title = await page.title();
  for (const indicator of CAPTCHA_TYPES.CLOUDFLARE_INTERSTITIAL.indicators || []) {
    if (title.includes(indicator)) {
      detected.push({
        type: 'CLOUDFLARE_INTERSTITIAL',
        ...CAPTCHA_TYPES.CLOUDFLARE_INTERSTITIAL
      });
    }
  }

  // Check for each CAPTCHA type by selectors
  for (const [type, config] of Object.entries(CAPTCHA_TYPES)) {
    if (type === 'CLOUDFLARE_INTERSTITIAL' && detected.some(d => d.type === type)) {
      continue; // Already detected
    }

    for (const selector of config.selectors || []) {
      try {
        const element = await page.$(selector);
        if (element) {
          detected.push({ type, ...config, selector });
          break;
        }
      } catch {}
    }
  }

  return detected;
}

/**
 * Check if any CAPTCHA is present
 */
async function hasCaptcha(page) {
  const detected = await detectCaptchaType(page);
  return detected.length > 0;
}

/**
 * Solve any detected CAPTCHA on the page
 */
async function solveCaptcha(page, options = {}) {
  const {
    preferAudio = true,      // Prefer audio challenge over image for reCAPTCHA
    maxAttempts = 3,
    timeout = 60000,
    onProgress = () => {},
    onCaptchaRequest = null  // Callback for user intervention
  } = options;

  try {
    // Detect what we're dealing with
    onProgress('Detecting CAPTCHA type...');
    const detected = await detectCaptchaType(page);

    if (detected.length === 0) {
      return { success: true, message: 'No CAPTCHA detected' };
    }

    const captcha = detected[0]; // Primary CAPTCHA
    onProgress(`Detected: ${captcha.name}`);

    // Route to appropriate solver
    switch (captcha.type) {
      case 'CLOUDFLARE_INTERSTITIAL':
      case 'CLOUDFLARE_TURNSTILE':
        return await cloudflareSolver.solveCloudflare(page, { onProgress, timeout });

      case 'RECAPTCHA_V2':
        return await solveRecaptchaV2(page, { preferAudio, maxAttempts, onProgress, onCaptchaRequest });

      case 'HCAPTCHA':
        return await solveHCaptcha(page, { maxAttempts, onProgress, onCaptchaRequest });

      case 'RECAPTCHA_V3':
        return { success: false, error: 'reCAPTCHA v3 is score-based and cannot be directly solved' };

      case 'TEXT_CAPTCHA':
        return await solveTextCaptcha(page, captcha.selector, { onProgress });

      case 'ARKOSE':
        // Arkose is extremely difficult, request user help
        if (onCaptchaRequest) {
          return await requestUserHelp(page, captcha, onCaptchaRequest);
        }
        return { success: false, error: 'Arkose/FunCaptcha requires user intervention' };

      default:
        return { success: false, error: `Unknown CAPTCHA type: ${captcha.type}` };
    }

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Solve reCAPTCHA v2 with fallback strategies
 */
async function solveRecaptchaV2(page, options = {}) {
  const { preferAudio, maxAttempts, onProgress, onCaptchaRequest } = options;

  // First, try clicking the checkbox (might auto-pass)
  onProgress('Attempting reCAPTCHA...');

  // Try audio method first if preferred
  if (preferAudio) {
    onProgress('Trying audio challenge method...');
    const audioResult = await recaptchaSolver.solveRecaptcha(page, {
      maxAttempts,
      onProgress
    });

    if (audioResult.success) {
      return audioResult;
    }

    // If audio blocked, try images
    if (audioResult.error?.includes('blocked') || audioResult.error?.includes('Rate limited')) {
      onProgress('Audio blocked, trying image method...');
    }
  }

  // Try image classification method
  onProgress('Trying image classification method...');
  const imageResult = await imageSolver.solveRecaptchaImages(page, {
    onProgress,
    maxAttempts
  });

  if (imageResult.success) {
    return imageResult;
  }

  // If both methods failed and we have user callback
  if (onCaptchaRequest) {
    onProgress('Automated solving failed, requesting user help...');
    return await requestUserHelp(page, { type: 'RECAPTCHA_V2', name: 'reCAPTCHA' }, onCaptchaRequest);
  }

  return { success: false, error: 'All solving methods failed' };
}

/**
 * Solve hCaptcha
 */
async function solveHCaptcha(page, options = {}) {
  const { maxAttempts, onProgress, onCaptchaRequest } = options;

  try {
    onProgress('Attempting hCaptcha...');

    // Find hCaptcha iframe
    const frame = await findFrame(page, 'iframe[src*="hcaptcha.com/captcha"]');
    if (!frame) {
      // Try clicking the checkbox first
      const checkbox = await page.$('.h-captcha iframe');
      if (checkbox) {
        const checkboxFrame = await checkbox.contentFrame();
        if (checkboxFrame) {
          const checkboxEl = await checkboxFrame.$('#checkbox');
          if (checkboxEl) {
            await checkboxEl.click();
            await page.waitForTimeout(2000);
          }
        }
      }
    }

    // hCaptcha uses similar image challenges to reCAPTCHA
    // We can try image classification
    onProgress('Trying image classification...');
    const imageResult = await solveHCaptchaImages(page, { onProgress, maxAttempts });

    if (imageResult.success) {
      return imageResult;
    }

    // Request user help
    if (onCaptchaRequest) {
      return await requestUserHelp(page, { type: 'HCAPTCHA', name: 'hCaptcha' }, onCaptchaRequest);
    }

    return { success: false, error: 'hCaptcha solving failed' };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Solve hCaptcha image challenges
 */
async function solveHCaptchaImages(page, options = {}) {
  const { onProgress = () => {}, maxAttempts = 3 } = options;

  // Similar to reCAPTCHA image solving
  // hCaptcha uses different selectors
  const HCAPTCHA_SELECTORS = {
    challengeFrame: 'iframe[src*="hcaptcha.com/captcha"]',
    instructions: '.prompt-text',
    tiles: '.task-image',
    submitButton: '.verify-button'
  };

  try {
    const frame = await findFrame(page, HCAPTCHA_SELECTORS.challengeFrame);
    if (!frame) {
      return { success: false, error: 'hCaptcha challenge frame not found' };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      onProgress(`hCaptcha attempt ${attempt}/${maxAttempts}`);

      // Get instructions
      const instructionEl = await frame.$(HCAPTCHA_SELECTORS.instructions);
      if (!instructionEl) {
        return { success: false, error: 'Could not find challenge instructions' };
      }

      const instructions = await instructionEl.textContent();
      onProgress(`Challenge: ${instructions}`);

      // Parse target
      const targetCategory = imageSolver.parseTargetFromInstructions(instructions);
      if (!targetCategory) {
        return { success: false, error: 'Could not understand challenge' };
      }

      // Get tiles
      const tiles = await frame.$$(HCAPTCHA_SELECTORS.tiles);
      onProgress(`Found ${tiles.length} tiles`);

      // Classify and click matching tiles
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        const tempPath = require('path').join(__dirname, 'temp', `hcaptcha_${Date.now()}_${i}.png`);

        await tile.screenshot({ path: tempPath });

        try {
          const matches = await imageSolver.classifyImage(tempPath, targetCategory);
          if (matches) {
            await tile.click();
            await page.waitForTimeout(200);
            onProgress(`Tile ${i + 1}: selected`);
          }
        } catch {}

        // Cleanup
        const fs = require('fs');
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }

      // Submit
      const submitBtn = await frame.$(HCAPTCHA_SELECTORS.submitButton);
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForTimeout(2000);
      }

      // Check if solved
      const stillPresent = await page.$('iframe[src*="hcaptcha.com/captcha"]');
      if (!stillPresent) {
        return { success: true, method: 'image-classification' };
      }
    }

    return { success: false, error: 'Max attempts reached' };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Solve text/image CAPTCHA using OCR
 */
async function solveTextCaptcha(page, selector, options = {}) {
  const { onProgress = () => {} } = options;

  try {
    onProgress('Finding CAPTCHA image...');

    const captchaImg = await page.$(selector);
    if (!captchaImg) {
      return { success: false, error: 'CAPTCHA image not found' };
    }

    // Screenshot the CAPTCHA
    const tempPath = require('path').join(__dirname, 'temp', `captcha_${Date.now()}.png`);
    await captchaImg.screenshot({ path: tempPath });

    onProgress('Running OCR...');
    const result = await ocrSolver.solveTextCaptcha(tempPath);

    // Cleanup
    const fs = require('fs');
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    if (!result.success) {
      return { success: false, error: 'OCR failed: ' + result.error };
    }

    onProgress(`OCR result: ${result.solution}`);

    // Find and fill input field - ordered by specificity
    const inputSelectors = [
      'input[name="answer"]',           // Common CAPTCHA answer field
      'input[name*="captcha" i]',
      'input[id*="captcha" i]',
      'input[placeholder*="captcha" i]',
      'input[placeholder*="enter" i]',
      '#captcha-input',
      '.captcha-input',
      '#audio-response',                // reCAPTCHA audio
      'form input[type="text"]:not([type="hidden"])',
      'input[autocomplete="off"][type="text"]'
    ];

    for (const inputSel of inputSelectors) {
      try {
        const inputs = await page.$$(inputSel);
        for (const input of inputs) {
          const visible = await input.isVisible().catch(() => false);
          const editable = await input.isEditable().catch(() => false);
          if (visible && editable) {
            await input.fill(result.solution);
            // Try to submit
            await input.press('Enter').catch(() => {});
            onProgress('Entered CAPTCHA solution');
            return { success: true, solution: result.solution, method: 'ocr' };
          }
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    return {
      success: true,
      solution: result.solution,
      method: 'ocr',
      note: 'Solution found but input field not auto-filled'
    };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Request user help for unsolvable CAPTCHAs
 */
async function requestUserHelp(page, captcha, onCaptchaRequest) {
  try {
    // Take screenshot
    const screenshotPath = require('path').join(__dirname, 'temp', `captcha_help_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });

    // Call the user callback
    const solution = await onCaptchaRequest({
      type: captcha.type,
      name: captcha.name,
      screenshotPath,
      message: `Please solve this ${captcha.name} CAPTCHA manually.`
    });

    if (solution === 'solved' || solution === true) {
      return { success: true, method: 'user-solved' };
    } else if (solution) {
      // User provided a solution to enter
      return { success: true, solution, method: 'user-provided' };
    }

    return { success: false, error: 'User did not solve CAPTCHA' };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Find iframe by selector
 */
async function findFrame(page, selector) {
  const frameElement = await page.$(selector);
  if (!frameElement) return null;
  return await frameElement.contentFrame();
}

/**
 * Get status of all solvers
 */
function getStatus() {
  return {
    audio: audioSolver.getStatus(),
    image: imageSolver.getStatus(),
    cloudflare: cloudflareSolver.getStatus(),
    ocr: ocrSolver.getStatus(),
    ready: {
      audio: audioSolver.getStatus().whisper?.installed || audioSolver.getStatus().windowsSpeech?.installed,
      image: imageSolver.getStatus().ready,
      cloudflare: true,
      ocr: ocrSolver.getStatus().tesseract?.installed
    }
  };
}

module.exports = {
  // Main API
  solveCaptcha,
  detectCaptchaType,
  hasCaptcha,

  // Individual solvers
  solveRecaptchaV2,
  solveHCaptcha,
  solveTextCaptcha,

  // Status
  getStatus,

  // Types
  CAPTCHA_TYPES
};
