/**
 * OCR-Based CAPTCHA Solver
 *
 * Solves text/image CAPTCHAs using Tesseract OCR and image preprocessing.
 * No paid APIs - runs entirely locally.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tesseract path - check multiple locations
function findTesseractPath() {
  const paths = [
    process.env.TESSERACT_PATH,
    '/usr/bin/tesseract',                          // Linux/Docker
    'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',  // Windows
    'tesseract'                                     // In PATH
  ].filter(Boolean);

  for (const p of paths) {
    try {
      if (p === 'tesseract' || fs.existsSync(p)) {
        return p;
      }
    } catch {}
  }
  return 'tesseract'; // Fallback
}

const TESSERACT_PATH = findTesseractPath();

// Directories
const TEMP_DIR = path.join(__dirname, 'temp');
const TRAINING_DIR = path.join(__dirname, 'training_data');
const MODELS_DIR = path.join(__dirname, 'models');

// Ensure directories exist
[TEMP_DIR, TRAINING_DIR, MODELS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Check if Tesseract is installed
 */
function checkTesseract() {
  try {
    // Try full path first (Windows)
    if (fs.existsSync(TESSERACT_PATH)) {
      const version = execSync(`"${TESSERACT_PATH}" --version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { installed: true, version: version.split('\n')[0], path: TESSERACT_PATH };
    }
    // Try command directly (if in PATH)
    const version = execSync('tesseract --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { installed: true, version: version.split('\n')[0], path: 'tesseract' };
  } catch {
    return { installed: false };
  }
}

/**
 * Check if ImageMagick is installed (for image preprocessing)
 */
function checkImageMagick() {
  try {
    const version = execSync('magick --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { installed: true, version: version.split('\n')[0] };
  } catch {
    try {
      // Try convert command (older ImageMagick)
      const version = execSync('convert --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { installed: true, version: version.split('\n')[0], legacy: true };
    } catch {
      return { installed: false };
    }
  }
}

/**
 * Preprocess image to improve OCR accuracy
 * - Convert to grayscale
 * - Increase contrast
 * - Remove noise
 * - Deskew
 * - Threshold to black/white
 */
async function preprocessImage(inputPath, outputPath) {
  const magick = checkImageMagick();

  if (!magick.installed) {
    // Fallback: just copy the file
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  const cmd = magick.legacy ? 'convert' : 'magick';

  try {
    // ImageMagick preprocessing pipeline
    execSync(`${cmd} "${inputPath}" \
      -colorspace Gray \
      -contrast-stretch 0.1x0.1% \
      -morphology Dilate Disk:1 \
      -morphology Erode Disk:1 \
      -threshold 50% \
      -deskew 40% \
      "${outputPath}"`,
      { stdio: 'pipe' }
    );
    return outputPath;
  } catch (e) {
    // If preprocessing fails, use original
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
}

/**
 * Run Tesseract OCR on an image
 */
async function runTesseract(imagePath, options = {}) {
  const {
    lang = 'eng',
    psm = 7,  // Single text line
    oem = 3,  // Default OCR Engine Mode
    allowlist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  } = options;

  const tesseract = checkTesseract();
  if (!tesseract.installed) {
    throw new Error('Tesseract not installed. Install with: winget install UB-Mannheim.TesseractOCR');
  }

  const outputBase = path.join(TEMP_DIR, `ocr_${Date.now()}`);
  const tesseractCmd = tesseract.path.includes(' ') ? `"${tesseract.path}"` : tesseract.path;

  try {
    // Build Tesseract command
    let cmd = `${tesseractCmd} "${imagePath}" "${outputBase}" -l ${lang} --psm ${psm} --oem ${oem}`;

    if (allowlist) {
      cmd += ` -c tessedit_char_whitelist=${allowlist}`;
    }

    execSync(cmd, { stdio: 'pipe' });

    // Read result
    const resultPath = outputBase + '.txt';
    if (fs.existsSync(resultPath)) {
      const text = fs.readFileSync(resultPath, 'utf-8').trim();
      fs.unlinkSync(resultPath); // Cleanup
      return text;
    }

    return '';
  } catch (e) {
    console.error('Tesseract error:', e.message);
    return '';
  }
}

/**
 * Solve a text CAPTCHA image
 */
async function solveTextCaptcha(imagePath, options = {}) {
  const tempId = crypto.randomBytes(8).toString('hex');
  const preprocessedPath = path.join(TEMP_DIR, `preprocessed_${tempId}.png`);

  try {
    // Preprocess the image
    await preprocessImage(imagePath, preprocessedPath);

    // Try multiple OCR configurations
    const configs = [
      { psm: 7, allowlist: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' }, // Single line, no confusing chars
      { psm: 8, allowlist: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' }, // Single word
      { psm: 6, allowlist: null }, // Block of text
      { psm: 13, allowlist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }, // Raw line
    ];

    const results = [];

    for (const config of configs) {
      const text = await runTesseract(preprocessedPath, config);
      if (text && text.length >= 4) {
        results.push({
          text: text.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
          config
        });
      }
    }

    // Clean up
    if (fs.existsSync(preprocessedPath)) {
      fs.unlinkSync(preprocessedPath);
    }

    // Return best result (longest valid text)
    results.sort((a, b) => b.text.length - a.text.length);

    if (results.length > 0) {
      return {
        success: true,
        solution: results[0].text,
        confidence: results.length > 1 ? 'medium' : 'low',
        alternatives: results.slice(1).map(r => r.text)
      };
    }

    return { success: false, error: 'Could not extract text from image' };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Solve math CAPTCHA from image
 */
async function solveMathCaptcha(imagePath) {
  const result = await solveTextCaptcha(imagePath, {
    allowlist: '0123456789+-×*=?'
  });

  if (!result.success) {
    return result;
  }

  const text = result.solution;

  // Parse math expression
  const match = text.match(/(\d+)\s*([+\-×x*])\s*(\d+)/i);
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
      default: return { success: false, error: 'Unknown operator' };
    }

    return {
      success: true,
      solution: String(answer),
      expression: `${a} ${op} ${b} = ${answer}`
    };
  }

  return { success: false, error: 'Could not parse math expression' };
}

/**
 * Solve CAPTCHA from base64 image data
 */
async function solveBase64(base64Data, options = {}) {
  const tempId = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(TEMP_DIR, `captcha_${tempId}.png`);

  try {
    // Remove data URL prefix if present
    const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Clean, 'base64');

    fs.writeFileSync(tempPath, buffer);

    const result = options.math
      ? await solveMathCaptcha(tempPath)
      : await solveTextCaptcha(tempPath, options);

    // Cleanup
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    return result;

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Solve CAPTCHA from URL
 */
async function solveUrl(imageUrl, options = {}) {
  const tempId = crypto.randomBytes(8).toString('hex');
  const tempPath = path.join(TEMP_DIR, `captcha_${tempId}.png`);

  try {
    // Download image
    const response = await fetch(imageUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    fs.writeFileSync(tempPath, buffer);

    const result = options.math
      ? await solveMathCaptcha(tempPath)
      : await solveTextCaptcha(tempPath, options);

    // Cleanup
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    return result;

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Save CAPTCHA for training data
 */
function saveTrainingData(imagePath, solution) {
  const filename = `${solution}_${Date.now()}.png`;
  const destPath = path.join(TRAINING_DIR, filename);
  fs.copyFileSync(imagePath, destPath);
  return destPath;
}

/**
 * Get solver status
 */
function getStatus() {
  return {
    tesseract: checkTesseract(),
    imageMagick: checkImageMagick(),
    trainingImages: fs.readdirSync(TRAINING_DIR).length,
    tempFiles: fs.readdirSync(TEMP_DIR).length
  };
}

/**
 * Cleanup temp files
 */
function cleanup() {
  const files = fs.readdirSync(TEMP_DIR);
  let cleaned = 0;
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(TEMP_DIR, file));
      cleaned++;
    } catch {}
  }
  return { cleaned };
}

module.exports = {
  // Core solving
  solveTextCaptcha,
  solveMathCaptcha,
  solveBase64,
  solveUrl,

  // Image processing
  preprocessImage,
  runTesseract,

  // Training
  saveTrainingData,

  // Utilities
  getStatus,
  cleanup,
  checkTesseract,
  checkImageMagick,

  // Directories
  TEMP_DIR,
  TRAINING_DIR,
  MODELS_DIR
};
