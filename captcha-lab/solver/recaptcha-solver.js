/**
 * reCAPTCHA Solver
 *
 * Solves reCAPTCHA v2 by using the audio challenge.
 * Works with Playwright browser automation.
 */

const path = require('path');
const fs = require('fs');
const audioSolver = require('./audio-solver');

// Selectors for reCAPTCHA elements
const SELECTORS = {
  // Main checkbox iframe
  anchorFrame: 'iframe[src*="recaptcha/api2/anchor"]',
  checkbox: '#recaptcha-anchor',
  checkboxChecked: '.recaptcha-checkbox-checked',

  // Challenge iframe
  challengeFrame: 'iframe[src*="recaptcha/api2/bframe"]',

  // Audio challenge
  audioButton: '#recaptcha-audio-button',
  audioChallenge: '.rc-audiochallenge-tdownload-link',
  audioDownload: '.rc-audiochallenge-tdownload-link',
  audioPlayButton: '.rc-audiochallenge-play-button',
  audioInput: '#audio-response',

  // Verify button
  verifyButton: '#recaptcha-verify-button',

  // Error/reload
  reloadButton: '#recaptcha-reload-button',
  errorMessage: '.rc-audiochallenge-error-message',

  // Success
  successToken: '#g-recaptcha-response'
};

/**
 * Wait for element with timeout
 */
async function waitForSelector(frame, selector, timeout = 10000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const element = await frame.$(selector);
    if (element) return element;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

/**
 * Solve reCAPTCHA on a Playwright page
 */
async function solveRecaptcha(page, options = {}) {
  const {
    maxAttempts = 5,
    onProgress = () => {}
  } = options;

  try {
    onProgress('Looking for reCAPTCHA...');

    // Find the anchor iframe (checkbox)
    const anchorFrame = await findFrame(page, SELECTORS.anchorFrame);
    if (!anchorFrame) {
      return { success: false, error: 'reCAPTCHA not found on page' };
    }

    // Click the checkbox
    onProgress('Clicking checkbox...');
    const checkbox = await anchorFrame.$(SELECTORS.checkbox);
    if (!checkbox) {
      return { success: false, error: 'Checkbox not found' };
    }
    await checkbox.click();

    // Wait a moment for challenge to appear or auto-pass
    await page.waitForTimeout(2000);

    // Check if already solved (sometimes checkbox just works)
    const isChecked = await anchorFrame.$(SELECTORS.checkboxChecked);
    if (isChecked) {
      onProgress('Auto-passed! No challenge needed.');
      const token = await getToken(page);
      return { success: true, token, method: 'auto' };
    }

    // Find challenge iframe
    onProgress('Looking for challenge...');
    const challengeFrame = await findFrame(page, SELECTORS.challengeFrame);
    if (!challengeFrame) {
      // Might have auto-passed, check again
      const recheckPassed = await anchorFrame.$(SELECTORS.checkboxChecked);
      if (recheckPassed) {
        const token = await getToken(page);
        return { success: true, token, method: 'auto-delayed' };
      }
      return { success: false, error: 'Challenge frame not found' };
    }

    // Switch to audio challenge
    onProgress('Switching to audio challenge...');
    const audioButton = await waitForSelector(challengeFrame, SELECTORS.audioButton, 5000);
    if (!audioButton) {
      return { success: false, error: 'Audio button not found. May be blocked or image-only.' };
    }
    await audioButton.click();
    await page.waitForTimeout(1000);

    // Attempt to solve audio challenges
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      onProgress(`Solving audio challenge (attempt ${attempt}/${maxAttempts})...`);

      // Get audio download link
      const downloadLink = await challengeFrame.$(SELECTORS.audioDownload);
      if (!downloadLink) {
        // Check for error message
        const errorMsg = await challengeFrame.$(SELECTORS.errorMessage);
        if (errorMsg) {
          const errorText = await errorMsg.textContent();
          if (errorText.includes('Try again later')) {
            return { success: false, error: 'Rate limited by reCAPTCHA. Try again later.' };
          }
        }
        return { success: false, error: 'Audio download link not found' };
      }

      const audioUrl = await downloadLink.getAttribute('href');
      if (!audioUrl) {
        return { success: false, error: 'Could not get audio URL' };
      }

      onProgress('Downloading and transcribing audio...');

      // Solve the audio
      const audioResult = await audioSolver.solveAudioUrl(audioUrl);

      if (!audioResult.success) {
        onProgress(`Transcription failed: ${audioResult.error}`);
        // Try to reload challenge
        const reloadBtn = await challengeFrame.$(SELECTORS.reloadButton);
        if (reloadBtn) {
          await reloadBtn.click();
          await page.waitForTimeout(2000);
        }
        continue;
      }

      onProgress(`Transcribed: "${audioResult.solution}"`);

      // Enter the solution
      const audioInput = await challengeFrame.$(SELECTORS.audioInput);
      if (!audioInput) {
        return { success: false, error: 'Audio input field not found' };
      }

      await audioInput.fill(audioResult.solution);
      await page.waitForTimeout(500);

      // Click verify
      const verifyBtn = await challengeFrame.$(SELECTORS.verifyButton);
      if (verifyBtn) {
        await verifyBtn.click();
      } else {
        // Try pressing Enter
        await audioInput.press('Enter');
      }

      await page.waitForTimeout(2000);

      // Check if solved
      const solved = await anchorFrame.$(SELECTORS.checkboxChecked);
      if (solved) {
        onProgress('CAPTCHA solved!');
        const token = await getToken(page);
        return {
          success: true,
          token,
          method: 'audio',
          attempts: attempt,
          solution: audioResult.solution
        };
      }

      // Check for error
      const errorAfterSubmit = await challengeFrame.$(SELECTORS.errorMessage);
      if (errorAfterSubmit) {
        const errorText = await errorAfterSubmit.textContent();
        onProgress(`Incorrect answer: ${errorText}`);

        if (errorText.includes('Multiple correct')) {
          // Need to solve multiple audio challenges
          onProgress('Multiple solutions required, continuing...');
        }
      }

      // Reload for next attempt
      const reloadBtn = await challengeFrame.$(SELECTORS.reloadButton);
      if (reloadBtn && attempt < maxAttempts) {
        await reloadBtn.click();
        await page.waitForTimeout(2000);
      }
    }

    return { success: false, error: 'Max attempts reached' };

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

  const frame = await frameElement.contentFrame();
  return frame;
}

/**
 * Get reCAPTCHA token from page
 */
async function getToken(page) {
  try {
    const token = await page.evaluate(() => {
      const textarea = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
      return textarea?.value || null;
    });
    return token;
  } catch {
    return null;
  }
}

/**
 * Check if reCAPTCHA is present on page
 */
async function hasRecaptcha(page) {
  const frame = await page.$(SELECTORS.anchorFrame);
  return !!frame;
}

/**
 * Check solver dependencies
 */
function checkDependencies() {
  const audioStatus = audioSolver.getStatus();
  return {
    audioSolver: {
      whisper: audioStatus.whisper,
      windowsSpeech: audioStatus.windowsSpeech,
      ffmpeg: audioStatus.ffmpegInstalled
    },
    ready: audioStatus.whisper.installed ||
           audioStatus.windowsSpeech.installed
  };
}

module.exports = {
  solveRecaptcha,
  hasRecaptcha,
  getToken,
  checkDependencies,
  SELECTORS
};
