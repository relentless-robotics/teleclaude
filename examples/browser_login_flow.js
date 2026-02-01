/**
 * Complete Login Flow Example
 *
 * Demonstrates a full login automation with:
 * - Auto-fill credentials
 * - Human-like interactions
 * - Error detection
 * - Auth state saving
 */

const browser = require('../utils/browser');
const browserProfiles = require('../utils/browser_profiles');

async function loginToGitHub() {
  console.log('Starting GitHub login automation...\n');

  // Launch browser with CAPTCHA detection
  const session = await browser.launch({
    headless: false,
    stealth: true,
    onCaptcha: async (page, captchaInfo) => {
      console.log(`⚠️  CAPTCHA detected: ${captchaInfo.type}`);
      await session.screenshot('captcha_detected');
      console.log('Screenshot saved. Please solve CAPTCHA manually...');
      // In production, this would notify user via Discord/Telegram
    }
  });

  try {
    // Navigate to GitHub login
    console.log('Navigating to GitHub login page...');
    await session.goto('https://github.com/login');

    // Wait for login form
    await session.waitForReady();

    // Get credentials for GitHub
    const creds = browserProfiles.getCredentials('github');
    if (!creds) {
      throw new Error('No GitHub credentials found!');
    }

    console.log('Filling login form with human-like typing...');

    // Fill email with human-like behavior
    await session.type('#login_field', creds.email, {
      humanLike: true,
      clear: true
    });

    await browser.humanDelay(500);

    // Fill password
    await session.type('#password', creds.password, {
      humanLike: true,
      clear: true
    });

    await browser.humanDelay(500);

    // Take screenshot before submit
    await session.screenshot('github_before_submit');

    // Click login button
    console.log('Submitting login form...');
    await session.click('input[type="submit"]', {
      humanLike: true,
      waitForNavigation: true
    });

    // Wait for one of multiple possible outcomes
    console.log('Waiting for login result...');
    const result = await session.waitForAny([
      { type: 'url', value: 'https://github.com' },
      { type: 'selector', value: '.avatar' },
      { type: 'text', value: 'Incorrect username or password' },
      { type: 'text', value: 'Two-factor authentication' }
    ], { timeout: 15000 });

    if (result.matched) {
      if (result.condition.value.includes('Incorrect') ||
          result.condition.value.includes('Two-factor')) {
        console.log('❌ Login failed or requires 2FA');
        await session.screenshot('github_login_failed');
      } else {
        console.log('✅ Login successful!');
        await session.screenshot('github_logged_in');

        // Save auth state for future use
        console.log('Saving GitHub auth state...');
        await session.saveAuthState('github');

        console.log('\nAuth state saved! Next time, use:');
        console.log('  const session = await browser.withGitHubAuth();');
      }
    } else {
      console.log('⏱️  Timeout waiting for login result');
      await session.screenshot('github_timeout');
    }

  } catch (error) {
    console.error('Error during login:', error.message);
    await session.screenshot('github_error');
  } finally {
    // Keep browser open for a moment to see result
    await browser.humanDelay(3000);
    await session.close();
  }
}

loginToGitHub().catch(console.error);
