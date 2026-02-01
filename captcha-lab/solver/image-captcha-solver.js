/**
 * Image CAPTCHA Solver
 *
 * Solves image selection CAPTCHAs like:
 * - reCAPTCHA v2 "Select all images with X"
 * - hCaptcha image selection
 *
 * Uses AI image classification to identify objects in images.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Common object categories in CAPTCHAs
const CAPTCHA_CATEGORIES = {
  'traffic_light': ['traffic light', 'traffic signal', 'stoplight', 'signal'],
  'crosswalk': ['crosswalk', 'pedestrian crossing', 'zebra crossing', 'crossing'],
  'bus': ['bus', 'buses', 'transit bus', 'school bus'],
  'bicycle': ['bicycle', 'bike', 'cycling', 'cyclist'],
  'motorcycle': ['motorcycle', 'motorbike', 'scooter'],
  'car': ['car', 'vehicle', 'automobile', 'sedan', 'suv'],
  'truck': ['truck', 'lorry', 'pickup truck'],
  'fire_hydrant': ['fire hydrant', 'hydrant', 'fireplug'],
  'parking_meter': ['parking meter', 'meter'],
  'bridge': ['bridge', 'overpass', 'viaduct'],
  'boat': ['boat', 'ship', 'vessel', 'ferry'],
  'airplane': ['airplane', 'plane', 'aircraft', 'jet'],
  'stairs': ['stairs', 'staircase', 'steps', 'stairway'],
  'chimney': ['chimney', 'smokestack', 'stack'],
  'palm_tree': ['palm tree', 'palm', 'coconut tree'],
  'mountain': ['mountain', 'mountains', 'hill', 'peak'],
  'taxi': ['taxi', 'cab', 'taxicab', 'yellow cab']
};

/**
 * Download image from URL
 */
async function downloadImage(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outputPath);

    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        downloadImage(response.headers.location, outputPath)
          .then(resolve)
          .catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

/**
 * Classify image using OpenAI Vision API
 * Requires OPENAI_API_KEY environment variable
 */
async function classifyWithOpenAI(imagePath, targetCategory) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set. Cannot use OpenAI Vision.');
  }

  const imageData = fs.readFileSync(imagePath);
  const base64Image = imageData.toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const categoryTerms = CAPTCHA_CATEGORIES[targetCategory] || [targetCategory];
  const prompt = `Look at this image and determine if it contains any of the following: ${categoryTerms.join(', ')}.
Answer with ONLY "yes" or "no". Nothing else.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',  // Cheaper vision model
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
        ]
      }],
      max_tokens: 10
    })
  });

  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content?.toLowerCase().trim();

  return answer === 'yes';
}

/**
 * Ensure YOLO model is downloaded
 */
async function ensureYOLOModel() {
  const { execSync } = require('child_process');

  try {
    const pythonScript = `
import os
from pathlib import Path
from ultralytics import YOLO

# Download yolov8n if not present
model_path = Path.home() / '.cache' / 'ultralytics' / 'yolov8n.pt'
if not model_path.exists():
    print('Downloading YOLOv8n model...')
    model = YOLO('yolov8n.pt')  # Auto-downloads
    print('Model downloaded successfully')
else:
    print('Model already exists')
`;

    execSync(`python -c "${pythonScript}"`, {
      encoding: 'utf-8',
      timeout: 120000, // 2 minutes for download
      stdio: 'inherit'
    });
    return true;
  } catch (e) {
    console.error('Failed to ensure YOLO model:', e.message);
    return false;
  }
}

/**
 * Classify image using local YOLO model (if available)
 * Requires Python with ultralytics installed
 */
async function classifyWithYOLO(imagePath, targetCategory) {
  const { execSync } = require('child_process');

  try {
    const pythonScript = `
import sys
from ultralytics import YOLO
import json

try:
    model = YOLO('yolov8n.pt')
    results = model('${imagePath.replace(/\\/g, '/')}', verbose=False)

    detections = []
    for r in results:
        for box in r.boxes:
            cls_name = model.names[int(box.cls)]
            conf = float(box.conf)
            detections.append({'class': cls_name, 'confidence': conf})

    print(json.dumps(detections))
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
    sys.exit(1)
`;

    const result = execSync(`python -c "${pythonScript}"`, {
      encoding: 'utf-8',
      timeout: 30000
    });

    const detections = JSON.parse(result.trim());

    if (detections.error) {
      throw new Error(detections.error);
    }

    const categoryTerms = CAPTCHA_CATEGORIES[targetCategory] || [targetCategory];

    // Check if any detection matches the target
    return detections.some(d =>
      categoryTerms.some(term =>
        d.class.toLowerCase().includes(term.toLowerCase()) && d.confidence > 0.3
      )
    );
  } catch (e) {
    throw new Error('YOLO classification failed: ' + e.message);
  }
}

/**
 * Check if YOLO is available
 */
function checkYOLO() {
  const { execSync } = require('child_process');
  try {
    execSync('python -c "from ultralytics import YOLO"', { stdio: 'pipe' });
    return { installed: true, note: 'YOLO is available' };
  } catch (e) {
    return {
      installed: false,
      note: 'Install with: pip install ultralytics'
    };
  }
}

/**
 * Initialize YOLO (download model if needed)
 */
async function initYOLO() {
  const status = checkYOLO();
  if (!status.installed) {
    console.log('YOLO not installed. Install with: pip install ultralytics');
    return false;
  }

  console.log('Ensuring YOLO model is downloaded...');
  const modelReady = await ensureYOLOModel();
  return modelReady;
}

/**
 * Check if OpenAI Vision is available
 */
function checkOpenAI() {
  return {
    installed: !!process.env.OPENAI_API_KEY,
    note: process.env.OPENAI_API_KEY ? 'API key found' : 'Set OPENAI_API_KEY env var'
  };
}

/**
 * Classify image using available method with fallback chain
 */
async function classifyImage(imagePath, targetCategory, options = {}) {
  const { preferYOLO = true, onError = null } = options;
  const errors = [];

  // Method order based on preference
  const methods = preferYOLO
    ? ['YOLO', 'OpenAI']
    : ['OpenAI', 'YOLO'];

  for (const method of methods) {
    try {
      if (method === 'YOLO' && checkYOLO().installed) {
        const result = await classifyWithYOLO(imagePath, targetCategory);
        return { match: result, method: 'YOLO' };
      } else if (method === 'OpenAI' && checkOpenAI().installed) {
        const result = await classifyWithOpenAI(imagePath, targetCategory);
        return { match: result, method: 'OpenAI' };
      }
    } catch (e) {
      const errorMsg = `${method} failed: ${e.message}`;
      errors.push(errorMsg);
      if (onError) onError(errorMsg);
    }
  }

  throw new Error(
    'No image classification available.\n' +
    'Errors: ' + errors.join('; ') + '\n' +
    'Install YOLO (pip install ultralytics) or set OPENAI_API_KEY.'
  );
}

/**
 * Solve reCAPTCHA image challenge
 * @param {Page} page - Playwright page
 * @param {object} options - Configuration options
 */
async function solveRecaptchaImages(page, options = {}) {
  const {
    onProgress = () => {},
    maxAttempts = 3,
    maxRounds = 5, // Max rounds of new tiles appearing
    confidenceThreshold = 0.3,
    useYOLO = true
  } = options;

  try {
    // Find challenge iframe
    const challengeFrame = await findFrame(page, 'iframe[src*="recaptcha/api2/bframe"]');
    if (!challengeFrame) {
      return { success: false, error: 'Challenge frame not found' };
    }

    // Initialize YOLO if requested
    if (useYOLO && checkYOLO().installed) {
      onProgress('Initializing YOLO model...');
      const yoloReady = await initYOLO();
      if (!yoloReady) {
        onProgress('YOLO init failed, will use fallback');
      }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      onProgress(`Attempt ${attempt}/${maxAttempts}`);

      // Get the challenge instructions
      const instructionEl = await challengeFrame.$('.rc-imageselect-desc-no-canonical, .rc-imageselect-desc');
      if (!instructionEl) {
        return { success: false, error: 'Could not find challenge instructions' };
      }

      const instructions = await instructionEl.textContent();
      onProgress(`Challenge: ${instructions}`);

      // Parse what we're looking for
      const targetCategory = parseTargetFromInstructions(instructions);
      if (!targetCategory) {
        return { success: false, error: 'Could not understand challenge target' };
      }

      onProgress(`Looking for: ${targetCategory}`);

      // Process multiple rounds (tiles may refresh)
      let roundsProcessed = 0;
      while (roundsProcessed < maxRounds) {
        roundsProcessed++;

        // Get all image tiles
        const tiles = await challengeFrame.$$('.rc-imageselect-tile');
        if (!tiles.length) {
          onProgress('No tiles found, challenge may be complete');
          break;
        }

        onProgress(`Round ${roundsProcessed}: Analyzing ${tiles.length} tiles`);

        // Track previous state to detect changes
        const currentlySelected = await challengeFrame.$$('.rc-imageselect-tile.rc-imageselect-tileselected');
        const previouslySelectedCount = currentlySelected.length;

        // Analyze each tile
        const tilesToClick = [];
        for (let i = 0; i < tiles.length; i++) {
          const tile = tiles[i];

          // Skip already selected tiles
          const isSelected = await tile.evaluate(el => el.classList.contains('rc-imageselect-tileselected'));
          if (isSelected) continue;

          // Take screenshot of tile
          const tempPath = path.join(TEMP_DIR, `tile_${crypto.randomBytes(4).toString('hex')}.png`);

          try {
            await tile.screenshot({ path: tempPath });

            const result = await classifyImage(tempPath, targetCategory, {
              preferYOLO: useYOLO,
              onError: (err) => onProgress(`Tile ${i + 1}: ${err}`)
            });

            if (result.match) {
              tilesToClick.push({ index: i, tile, method: result.method });
              onProgress(`Tile ${i + 1}: MATCH (${result.method})`);
            } else {
              onProgress(`Tile ${i + 1}: no match`);
            }
          } catch (e) {
            onProgress(`Tile ${i + 1}: error - ${e.message}`);
          } finally {
            // Cleanup
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
          }
        }

        // Click matching tiles
        if (tilesToClick.length > 0) {
          onProgress(`Clicking ${tilesToClick.length} matching tiles`);
          for (const { tile, index } of tilesToClick) {
            await tile.click();
            await page.waitForTimeout(150);
          }
        } else {
          onProgress('No new matches found');
        }

        // Wait for tiles to potentially refresh
        await page.waitForTimeout(1000);

        // Check if tiles refreshed
        const newTiles = await challengeFrame.$$('.rc-imageselect-tile');
        if (newTiles.length === 0) {
          // Challenge complete
          break;
        }

        // Check if any tiles changed (new images loaded)
        const tilesChanged = await detectTileChanges(challengeFrame, tiles);
        if (!tilesChanged && tilesToClick.length === 0) {
          // No changes and no new selections - done with this round
          break;
        }
      }

      // Click verify
      onProgress('Clicking verify button...');
      await page.waitForTimeout(500);
      const verifyBtn = await challengeFrame.$('#recaptcha-verify-button');
      if (verifyBtn) {
        await verifyBtn.click();
      }

      await page.waitForTimeout(2000);

      // Check if solved
      const anchorFrame = await findFrame(page, 'iframe[src*="recaptcha/api2/anchor"]');
      if (anchorFrame) {
        const solved = await anchorFrame.$('.recaptcha-checkbox-checked');
        if (solved) {
          onProgress('CAPTCHA solved!');
          return {
            success: true,
            method: 'image-classification',
            attempts: attempt,
            rounds: roundsProcessed
          };
        }
      }

      // Check if challenge still present
      const stillHasChallenge = await challengeFrame.$('.rc-imageselect-tile');
      if (stillHasChallenge) {
        onProgress('Verification failed, retrying...');
        continue;
      }
    }

    return { success: false, error: 'Max attempts reached' };

  } catch (e) {
    return { success: false, error: e.message, stack: e.stack };
  }
}

/**
 * Detect if tiles have changed (new images loaded)
 */
async function detectTileChanges(frame, previousTiles) {
  try {
    const currentTiles = await frame.$$('.rc-imageselect-tile');
    if (currentTiles.length !== previousTiles.length) {
      return true;
    }

    // Check if images have the dynamic class that indicates loading
    const loadingTiles = await frame.$$('.rc-imageselect-dynamic-selected');
    return loadingTiles.length > 0;
  } catch {
    return false;
  }
}

/**
 * Solve hCaptcha image challenge
 * @param {Page} page - Playwright page
 * @param {object} options - Configuration options
 */
async function solveHCaptchaImages(page, options = {}) {
  const {
    onProgress = () => {},
    maxAttempts = 3,
    useYOLO = true
  } = options;

  try {
    // Find hCaptcha iframe
    const challengeFrame = await findFrame(page, 'iframe[src*="hcaptcha.com/captcha"]');
    if (!challengeFrame) {
      return { success: false, error: 'hCaptcha challenge frame not found' };
    }

    // Initialize YOLO if requested
    if (useYOLO && checkYOLO().installed) {
      onProgress('Initializing YOLO model...');
      await initYOLO();
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      onProgress(`Attempt ${attempt}/${maxAttempts}`);

      // Wait for challenge to load
      await page.waitForTimeout(1000);

      // Get challenge instructions
      const instructionEl = await challengeFrame.$('.prompt-text, .challenge-prompt');
      if (!instructionEl) {
        return { success: false, error: 'Could not find challenge instructions' };
      }

      const instructions = await instructionEl.textContent();
      onProgress(`Challenge: ${instructions}`);

      // Parse target
      const targetCategory = parseTargetFromInstructions(instructions);
      if (!targetCategory) {
        return { success: false, error: 'Could not understand challenge target' };
      }

      onProgress(`Looking for: ${targetCategory}`);

      // Get all task images
      const taskImages = await challengeFrame.$$('.task-image, .challenge-image');
      if (!taskImages.length) {
        return { success: false, error: 'No task images found' };
      }

      onProgress(`Found ${taskImages.length} images to analyze`);

      // Analyze and click matching images
      const clickedIndices = [];
      for (let i = 0; i < taskImages.length; i++) {
        const img = taskImages[i];

        // Take screenshot
        const tempPath = path.join(TEMP_DIR, `hcaptcha_${crypto.randomBytes(4).toString('hex')}.png`);

        try {
          await img.screenshot({ path: tempPath });

          const result = await classifyImage(tempPath, targetCategory, {
            preferYOLO: useYOLO
          });

          if (result.match) {
            clickedIndices.push(i);
            await img.click();
            await page.waitForTimeout(150);
            onProgress(`Image ${i + 1}: MATCH - clicked`);
          } else {
            onProgress(`Image ${i + 1}: no match`);
          }
        } catch (e) {
          onProgress(`Image ${i + 1}: error - ${e.message}`);
        } finally {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        }
      }

      // Click submit button
      onProgress('Submitting answers...');
      await page.waitForTimeout(500);
      const submitBtn = await challengeFrame.$('.button-submit, [type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
      }

      await page.waitForTimeout(2000);

      // Check if solved (checkbox frame should be checked)
      const checkboxFrame = await findFrame(page, 'iframe[src*="hcaptcha.com/checkbox"]');
      if (checkboxFrame) {
        const solved = await checkboxFrame.$('.check, [aria-checked="true"]');
        if (solved) {
          onProgress('hCaptcha solved!');
          return {
            success: true,
            method: 'hcaptcha-image',
            attempts: attempt,
            imagesClicked: clickedIndices.length
          };
        }
      }

      // Check for error or retry
      const errorMsg = await challengeFrame.$('.error-text, .challenge-error');
      if (errorMsg) {
        const errorText = await errorMsg.textContent();
        onProgress(`Error: ${errorText}`);
      }
    }

    return { success: false, error: 'Max attempts reached' };

  } catch (e) {
    return { success: false, error: e.message, stack: e.stack };
  }
}

/**
 * Parse target category from CAPTCHA instructions
 */
function parseTargetFromInstructions(text) {
  const textLower = text.toLowerCase();

  for (const [category, terms] of Object.entries(CAPTCHA_CATEGORIES)) {
    if (terms.some(term => textLower.includes(term))) {
      return category;
    }
  }

  // Try to extract noun after "with" or "containing"
  const match = textLower.match(/(?:with|containing|showing|select|please click)\s+(?:all\s+)?(?:images?\s+)?(?:with\s+)?(?:a\s+)?(\w+(?:\s+\w+)?)/);
  if (match) {
    const extracted = match[1].replace(/s$/, ''); // Remove trailing 's'
    return extracted;
  }

  return null;
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
 * Auto-detect and solve image CAPTCHA on page
 * @param {Page} page - Playwright page
 * @param {object} options - Configuration options
 */
async function solveImageCaptcha(page, options = {}) {
  const { onProgress = () => {} } = options;

  // Detect which type of CAPTCHA is present
  const hasRecaptcha = await page.$('iframe[src*="recaptcha/api2/bframe"]');
  const hasHCaptcha = await page.$('iframe[src*="hcaptcha.com/captcha"]');

  if (hasRecaptcha) {
    onProgress('Detected reCAPTCHA image challenge');
    return await solveRecaptchaImages(page, options);
  } else if (hasHCaptcha) {
    onProgress('Detected hCaptcha image challenge');
    return await solveHCaptchaImages(page, options);
  } else {
    return {
      success: false,
      error: 'No supported image CAPTCHA detected on page'
    };
  }
}

/**
 * Get solver status and dependencies
 */
function getStatus() {
  const yolo = checkYOLO();
  const openai = checkOpenAI();

  return {
    yolo,
    openai,
    ready: yolo.installed || openai.installed,
    preferred: yolo.installed ? 'YOLO (local, free)' : openai.installed ? 'OpenAI Vision (API, paid)' : 'None available'
  };
}

module.exports = {
  // Main solver functions
  solveImageCaptcha,
  solveRecaptchaImages,
  solveHCaptchaImages,

  // Classification
  classifyImage,
  classifyWithYOLO,
  classifyWithOpenAI,

  // Utilities
  parseTargetFromInstructions,
  getStatus,
  checkYOLO,
  checkOpenAI,
  initYOLO,
  ensureYOLOModel,

  // Constants
  CAPTCHA_CATEGORIES
};
