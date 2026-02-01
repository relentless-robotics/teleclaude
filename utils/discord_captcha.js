/**
 * Discord CAPTCHA Integration
 *
 * Handles CAPTCHA interactions through Discord.
 * Works with the main captcha_handler.js module.
 */

const fs = require('fs');
const path = require('path');
const { saveCaptchaSolution, getPendingCaptchas, CAPTCHA_DIR } = require('./captcha_handler');

// Track CAPTCHA state
let pendingCaptcha = null;
let captchaCallback = null;

/**
 * Check if user message is a CAPTCHA solution
 * Call this when processing incoming Discord messages
 * @param {string} message - The user's message
 * @returns {boolean} - True if message was processed as CAPTCHA solution
 */
function processCaptchaResponse(message) {
  if (!message || typeof message !== 'string') return false;

  const pending = getPendingCaptchas();

  if (pending.length === 0) {
    return false;
  }

  // Clean up the message
  const solution = message.trim();

  // Save the solution
  const saved = saveCaptchaSolution(solution);

  if (saved) {
    console.log(`CAPTCHA solution saved: ${solution}`);

    // Call callback if registered
    if (captchaCallback) {
      captchaCallback(solution);
      captchaCallback = null;
    }

    pendingCaptcha = null;
    return true;
  }

  return false;
}

/**
 * Register a CAPTCHA request
 * @param {string} screenshotPath - Path to the CAPTCHA screenshot
 * @param {Function} callback - Callback when solution is received
 */
function registerCaptchaRequest(screenshotPath, callback) {
  pendingCaptcha = {
    screenshotPath,
    timestamp: Date.now()
  };
  captchaCallback = callback;
}

/**
 * Check if there's a pending CAPTCHA
 * @returns {Object|null} - Pending CAPTCHA info or null
 */
function getPendingCaptcha() {
  return pendingCaptcha;
}

/**
 * Clear pending CAPTCHA (timeout or manual clear)
 */
function clearPendingCaptcha() {
  pendingCaptcha = null;
  captchaCallback = null;
}

/**
 * Format CAPTCHA notification for Discord
 * @param {string} captchaType - Type of CAPTCHA detected
 * @param {string} screenshotPath - Path to screenshot
 * @returns {string} - Formatted Discord message
 */
function formatCaptchaMessage(captchaType, screenshotPath) {
  const filename = path.basename(screenshotPath);

  return `🔐 **CAPTCHA Detected!**

**Type:** ${captchaType}
**Screenshot:** \`${filename}\`

Please solve the CAPTCHA and reply with the answer.
Your next message will be treated as the CAPTCHA solution.

*Waiting for your response...*`;
}

/**
 * Format CAPTCHA success message
 * @param {string} solution - The solution that was entered
 * @returns {string} - Success message
 */
function formatSuccessMessage(solution) {
  return `✅ CAPTCHA solution received: \`${solution}\`
Continuing automation...`;
}

/**
 * Format CAPTCHA timeout message
 * @returns {string} - Timeout message
 */
function formatTimeoutMessage() {
  return `⏰ CAPTCHA timed out. The automation will retry or skip this step.`;
}

/**
 * Check for any orphaned CAPTCHA screenshots (cleanup)
 * Removes screenshots older than 10 minutes without solutions
 */
function cleanupOldCaptchas() {
  const TEN_MINUTES = 10 * 60 * 1000;
  const now = Date.now();

  try {
    if (!fs.existsSync(CAPTCHA_DIR)) return;

    const files = fs.readdirSync(CAPTCHA_DIR);

    for (const file of files) {
      if (!file.endsWith('.png')) continue;

      const filepath = path.join(CAPTCHA_DIR, file);
      const stats = fs.statSync(filepath);
      const age = now - stats.mtimeMs;

      if (age > TEN_MINUTES) {
        // Check if there's a solution file
        const solutionFile = filepath.replace('.png', '_solution.txt');
        if (!fs.existsSync(solutionFile)) {
          // Old screenshot without solution - delete it
          fs.unlinkSync(filepath);
          console.log(`Cleaned up old CAPTCHA: ${file}`);
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning up CAPTCHAs:', error.message);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldCaptchas, 5 * 60 * 1000);

module.exports = {
  processCaptchaResponse,
  registerCaptchaRequest,
  getPendingCaptcha,
  clearPendingCaptcha,
  formatCaptchaMessage,
  formatSuccessMessage,
  formatTimeoutMessage,
  cleanupOldCaptchas
};
