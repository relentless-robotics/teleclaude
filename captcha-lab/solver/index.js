/**
 * Unified CAPTCHA Solver
 *
 * Auto-detects and solves various CAPTCHA types.
 * Runs entirely locally - no paid APIs.
 *
 * Supported:
 * - reCAPTCHA v2 (via audio challenge)
 * - hCaptcha (auto-pass, limited)
 * - Text/Image CAPTCHAs (via OCR)
 * - Math CAPTCHAs
 * - Audio CAPTCHAs
 */

const ocrSolver = require('./ocr-solver');
const audioSolver = require('./audio-solver');
const recaptchaSolver = require('./recaptcha-solver');
const hcaptchaSolver = require('./hcaptcha-solver');
const imageSolver = require('./image-captcha-solver');

/**
 * CAPTCHA Types
 */
const CaptchaType = {
  RECAPTCHA_V2: 'recaptcha_v2',
  RECAPTCHA_V3: 'recaptcha_v3',
  HCAPTCHA: 'hcaptcha',
  TURNSTILE: 'turnstile',
  TEXT_IMAGE: 'text_image',
  MATH: 'math',
  AUDIO: 'audio',
  UNKNOWN: 'unknown'
};

/**
 * Detect CAPTCHA type on a Playwright page
 */
async function detectCaptcha(page) {
  const detections = [];

  // Check for reCAPTCHA
  const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
  if (recaptchaFrame) {
    const src = await recaptchaFrame.getAttribute('src');
    if (src.includes('anchor')) {
      detections.push({
        type: CaptchaType.RECAPTCHA_V2,
        element: recaptchaFrame,
        confidence: 'high'
      });
    }
  }

  // Check for reCAPTCHA v3 (invisible, script-based)
  const recaptchaV3 = await page.$('[data-sitekey][data-size="invisible"]');
  if (recaptchaV3) {
    detections.push({
      type: CaptchaType.RECAPTCHA_V3,
      element: recaptchaV3,
      confidence: 'high'
    });
  }

  // Check for hCaptcha
  const hcaptchaFrame = await page.$('iframe[src*="hcaptcha"]');
  if (hcaptchaFrame) {
    detections.push({
      type: CaptchaType.HCAPTCHA,
      element: hcaptchaFrame,
      confidence: 'high'
    });
  }

  // Check for Cloudflare Turnstile
  const turnstileFrame = await page.$('iframe[src*="challenges.cloudflare.com"]');
  if (turnstileFrame) {
    detections.push({
      type: CaptchaType.TURNSTILE,
      element: turnstileFrame,
      confidence: 'high'
    });
  }

  // Check for text/image CAPTCHA
  const captchaImage = await page.$('img[src*="captcha"], img[alt*="captcha"], .captcha-image, #captcha-image');
  if (captchaImage) {
    detections.push({
      type: CaptchaType.TEXT_IMAGE,
      element: captchaImage,
      confidence: 'medium'
    });
  }

  // Check for math CAPTCHA
  const mathCaptcha = await page.$('.math-captcha, [id*="math-captcha"]');
  if (mathCaptcha) {
    detections.push({
      type: CaptchaType.MATH,
      element: mathCaptcha,
      confidence: 'medium'
    });
  }

  // Check by keywords in page content
  const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
  if (bodyText.includes('verify you are human') || bodyText.includes('prove you are not a robot')) {
    if (detections.length === 0) {
      detections.push({
        type: CaptchaType.UNKNOWN,
        confidence: 'low',
        hint: 'Page contains CAPTCHA-related text'
      });
    }
  }

  return {
    found: detections.length > 0,
    captchas: detections,
    primary: detections[0] || null
  };
}

/**
 * Solve CAPTCHA automatically
 */
async function solveCaptcha(page, options = {}) {
  const {
    type = null,  // Override type detection
    onProgress = (msg) => console.log(`[Solver] ${msg}`),
    maxAttempts = 5
  } = options;

  // Detect CAPTCHA if type not specified
  let captchaType = type;
  if (!captchaType) {
    onProgress('Detecting CAPTCHA type...');
    const detection = await detectCaptcha(page);

    if (!detection.found) {
      return { success: false, error: 'No CAPTCHA detected on page' };
    }

    captchaType = detection.primary.type;
    onProgress(`Detected: ${captchaType}`);
  }

  // Solve based on type
  switch (captchaType) {
    case CaptchaType.RECAPTCHA_V2:
      // Try audio first, fall back to image challenge
      const recaptchaAudioResult = await recaptchaSolver.solveRecaptcha(page, { onProgress, maxAttempts });
      if (recaptchaAudioResult.success) {
        return recaptchaAudioResult;
      }

      // If audio failed, try image challenge with AI
      onProgress('Audio challenge failed, trying image challenge...');
      return await imageSolver.solveRecaptchaImages(page, {
        onProgress,
        maxAttempts,
        useYOLO: true
      });

    case CaptchaType.RECAPTCHA_V3:
      // v3 is score-based and invisible, can't really "solve" it
      return {
        success: false,
        error: 'reCAPTCHA v3 is invisible/score-based. Cannot solve directly.',
        type: captchaType
      };

    case CaptchaType.HCAPTCHA:
      // Use enhanced image solver for hCaptcha
      return await imageSolver.solveHCaptchaImages(page, {
        onProgress,
        maxAttempts,
        useYOLO: true
      });

    case CaptchaType.TURNSTILE:
      // Turnstile often auto-passes for real browsers
      onProgress('Turnstile detected. Waiting for auto-pass...');
      await page.waitForTimeout(5000);

      // Check if passed
      const turnstileToken = await page.evaluate(() => {
        const input = document.querySelector('[name="cf-turnstile-response"]');
        return input?.value || null;
      });

      if (turnstileToken) {
        return { success: true, token: turnstileToken, method: 'auto' };
      }

      return {
        success: false,
        error: 'Turnstile did not auto-pass. May require real browser fingerprint.',
        type: captchaType
      };

    case CaptchaType.TEXT_IMAGE:
      return await solveImageCaptcha(page, options);

    case CaptchaType.MATH:
      return await solveMathCaptchaOnPage(page, options);

    default:
      return {
        success: false,
        error: `Unknown CAPTCHA type: ${captchaType}`,
        type: captchaType
      };
  }
}

/**
 * Solve image/text CAPTCHA on page
 */
async function solveImageCaptcha(page, options = {}) {
  const { onProgress = () => {} } = options;

  onProgress('Looking for CAPTCHA image...');

  // Find image
  const captchaImage = await page.$('img[src*="captcha"], img[alt*="captcha"], .captcha-image, #captcha-image');
  if (!captchaImage) {
    return { success: false, error: 'CAPTCHA image not found' };
  }

  // Get image source
  const imgSrc = await captchaImage.getAttribute('src');

  let result;
  if (imgSrc.startsWith('data:')) {
    // Base64 image
    const base64 = imgSrc.split(',')[1];
    result = await ocrSolver.solveBase64(base64);
  } else {
    // URL
    const fullUrl = new URL(imgSrc, page.url()).href;
    result = await ocrSolver.solveUrl(fullUrl);
  }

  if (!result.success) {
    return result;
  }

  onProgress(`OCR result: ${result.solution}`);

  // Find input field and enter solution
  const inputField = await page.$('input[name*="captcha"], input[id*="captcha"], input[placeholder*="captcha"]');
  if (inputField) {
    await inputField.fill(result.solution);
    onProgress('Entered solution into input field');
  }

  return result;
}

/**
 * Solve math CAPTCHA on page
 */
async function solveMathCaptchaOnPage(page, options = {}) {
  const { onProgress = () => {} } = options;

  onProgress('Looking for math CAPTCHA...');

  // Try to find math expression
  const mathElement = await page.$('.math-captcha, .math, [class*="math"]');
  if (mathElement) {
    const mathText = await mathElement.textContent();
    const match = mathText.match(/(\d+)\s*([+\-×x*])\s*(\d+)/);

    if (match) {
      const a = parseInt(match[1]);
      const op = match[2];
      const b = parseInt(match[3]);

      let answer;
      switch (op.toLowerCase()) {
        case '+': answer = a + b; break;
        case '-': answer = a - b; break;
        case '×':
        case 'x':
        case '*': answer = a * b; break;
      }

      onProgress(`Math: ${a} ${op} ${b} = ${answer}`);

      // Find input and enter answer
      const inputField = await page.$('input[name*="captcha"], input[name*="answer"], input[type="number"]');
      if (inputField) {
        await inputField.fill(String(answer));
      }

      return { success: true, solution: String(answer), expression: `${a} ${op} ${b}` };
    }
  }

  return { success: false, error: 'Could not find/parse math CAPTCHA' };
}

/**
 * Get status of all solvers
 */
function getStatus() {
  const imageStatus = imageSolver.getStatus();

  return {
    ocr: ocrSolver.getStatus(),
    audio: audioSolver.getStatus(),
    recaptcha: recaptchaSolver.checkDependencies(),
    hcaptcha: hcaptchaSolver.getStatus(),
    imageClassification: imageStatus,
    supported: [
      'reCAPTCHA v2 (audio + image AI)',
      'hCaptcha (image AI)',
      'Text/Image CAPTCHA (OCR)',
      'Math CAPTCHA',
      'Turnstile (auto-pass)'
    ],
    limited: [
      'reCAPTCHA v3 (invisible)'
    ],
    recommendations: imageStatus.ready
      ? ['All image solvers ready!']
      : ['Install YOLO: pip install ultralytics', 'OR set OPENAI_API_KEY for OpenAI Vision']
  };
}

/**
 * Install required dependencies
 */
function getInstallInstructions() {
  return `
CAPTCHA Solver Dependencies
============================

Required:
---------
1. Tesseract OCR (for text CAPTCHAs)
   Windows: winget install tesseract-ocr
   Linux: sudo apt install tesseract-ocr

2. FFmpeg (for audio CAPTCHAs)
   Windows: winget install ffmpeg
   Linux: sudo apt install ffmpeg

Highly Recommended (for image challenges):
------------------------------------------
3. YOLO (local AI image classification - FREE!)
   pip install ultralytics torch torchvision

   Note: Model downloads automatically on first use (~6 MB)

Optional (better audio solving):
--------------------------------
4. OpenAI Whisper (better audio transcription)
   pip install openai-whisper

Optional (alternative to YOLO):
-------------------------------
5. OpenAI Vision API (paid, but very accurate)
   Set environment variable: OPENAI_API_KEY=sk-...

Optional (better image preprocessing):
--------------------------------------
6. ImageMagick
   Windows: winget install ImageMagick
   Linux: sudo apt install imagemagick

GPU Acceleration (recommended for YOLO):
----------------------------------------
- NVIDIA GPU: CUDA-enabled PyTorch (automatically used if available)
- CPU-only: Works but slower
`;
}

/**
 * Initialize YOLO model (downloads if needed)
 */
async function initializeYOLO() {
  const status = imageSolver.checkYOLO();
  if (!status.installed) {
    throw new Error('YOLO not installed. Run: pip install ultralytics');
  }

  console.log('Initializing YOLO model...');
  await imageSolver.initYOLO();
  console.log('YOLO ready!');
}

/**
 * Unified helper for Playwright scripts
 */
async function solveCaptchaOnPage(page, options = {}) {
  const {
    onProgress = (msg) => console.log(`[CAPTCHA] ${msg}`),
    preferAudio = true, // For reCAPTCHA, try audio first
    useYOLO = true,     // Use YOLO for image classification
    maxAttempts = 3
  } = options;

  return await solveCaptcha(page, {
    onProgress,
    maxAttempts,
    preferAudio,
    useYOLO
  });
}

module.exports = {
  // Main unified solver (recommended)
  solveCaptchaOnPage,

  // Auto-detection
  detectCaptcha,
  solveCaptcha,

  // Type-specific solvers
  solveRecaptcha: recaptchaSolver.solveRecaptcha,
  solveRecaptchaImages: imageSolver.solveRecaptchaImages,
  solveHCaptchaImages: imageSolver.solveHCaptchaImages,
  solveImageCaptcha,
  solveMathCaptchaOnPage,

  // Sub-modules (for advanced usage)
  ocr: ocrSolver,
  audio: audioSolver,
  recaptcha: recaptchaSolver,
  hcaptcha: hcaptchaSolver,
  image: imageSolver,

  // Setup and status
  getStatus,
  getInstallInstructions,
  initializeYOLO,

  // Constants
  CaptchaType,
  CAPTCHA_CATEGORIES: imageSolver.CAPTCHA_CATEGORIES
};
