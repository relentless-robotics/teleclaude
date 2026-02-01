/**
 * Example: Improved Playwright Script
 *
 * This demonstrates using the playwright_helpers module to create
 * a reliable, production-ready browser automation script.
 *
 * Compare this to older scripts in the root directory to see the improvements.
 */

const { chromium } = require('playwright');
const {
  createRobustContext,
  safeGoto,
  waitForPageReady,
  safeClick,
  safeType,
  smartWait,
  waitForAny,
  debugScreenshot,
  getPageState,
  detectIssues,
  withRetry,
  sleep,
  configure
} = require('./playwright_helpers');

// Optional: Load other utilities
const { handleCaptcha } = require('./captcha_handler');
const { autoFillLogin, createAuthenticatedContext } = require('./credentials');
const { hasValidGoogleAuth } = require('../browser_state/load_google_auth');

/**
 * Example: GitHub Login with Best Practices
 */
async function exampleGitHubLogin(sendMessage) {
  // Configure if needed (optional)
  configure({
    verbose: true,
    maxRetries: 3,
    longTimeout: 30000
  });

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });

  let context;

  try {
    // Create robust context with anti-detection
    if (sendMessage) {
      await sendMessage('Creating browser context with anti-detection...');
    }

    context = await createRobustContext(browser, {
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // Step 1: Navigate with retry
    if (sendMessage) {
      await sendMessage('Navigating to GitHub login...');
    }

    const navSuccess = await safeGoto(page, 'https://github.com/login', {
      retries: 3,
      timeout: 30000,
      expectUrl: 'login'
    });

    if (!navSuccess) {
      throw new Error('Failed to navigate to GitHub login');
    }

    await waitForPageReady(page);
    await debugScreenshot(page, 'github_login_page');

    // Step 2: Check for issues
    const issues = await detectIssues(page);

    if (issues.captcha) {
      if (sendMessage) {
        await sendMessage('CAPTCHA detected! Attempting to handle...');
      }

      const captchaResult = await handleCaptcha(page, sendMessage, {
        autoWaitCloudflare: true,
        maxRetries: 3
      });

      if (!captchaResult.success) {
        throw new Error('CAPTCHA failed');
      }
    }

    if (issues.rateLimit) {
      if (sendMessage) {
        await sendMessage('Rate limit detected. Waiting 60 seconds...');
      }
      await sleep(60000);
    }

    // Step 3: Try auto-fill first (uses credentials.js)
    if (sendMessage) {
      await sendMessage('Attempting auto-fill login...');
    }

    const autoFilled = await autoFillLogin(page);

    if (!autoFilled) {
      // Manual fill with robust helpers
      if (sendMessage) {
        await sendMessage('Auto-fill not available, filling manually...');
      }

      // Fill username/email - multiple fallback selectors
      const emailSuccess = await safeType(page, [
        '#login_field',
        'input[name="login"]',
        'input[type="text"]',
        'input[autocomplete="username"]'
      ], 'relentlessrobotics@gmail.com', {
        humanLike: true,
        clear: true,
        verify: true,
        retries: 3
      });

      if (!emailSuccess) {
        await debugScreenshot(page, 'email_field_not_found');
        throw new Error('Could not find email field');
      }

      // Small human-like delay
      await sleep(800, 0.3);

      // Fill password
      const passwordSuccess = await safeType(page, [
        '#password',
        'input[name="password"]',
        'input[type="password"]'
      ], 'Relentless@Robotics2026!', {
        humanLike: true,
        clear: true,
        retries: 3
      });

      if (!passwordSuccess) {
        await debugScreenshot(page, 'password_field_not_found');
        throw new Error('Could not find password field');
      }
    }

    // Step 4: Submit with retry
    if (sendMessage) {
      await sendMessage('Submitting login form...');
    }

    await sleep(500); // Small delay before clicking

    const submitSuccess = await safeClick(page, [
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Sign in")',
      '.btn-primary'
    ], {
      waitForNavigation: true,
      retries: 3,
      scrollIntoView: true,
      waitForStability: true
    });

    if (!submitSuccess) {
      await debugScreenshot(page, 'submit_button_not_found');
      throw new Error('Could not click submit button');
    }

    // Step 5: Wait for result - success or error
    if (sendMessage) {
      await sendMessage('Waiting for login result...');
    }

    const result = await waitForAny(page, [
      // Success conditions
      { type: 'url', value: 'github.com/dashboard' },
      { type: 'url', value: 'github.com/?return_to=' },
      { type: 'selector', value: '[data-id="dashboard"]' },

      // Error conditions
      { type: 'selector', value: '.flash-error' },
      { type: 'text', value: 'Incorrect username or password' },

      // 2FA
      { type: 'selector', value: '#otp' },
      { type: 'text', value: 'Two-factor authentication' }
    ], {
      timeout: 20000,
      checkInterval: 500
    });

    if (!result.matched) {
      if (sendMessage) {
        await sendMessage('Login timeout - unclear result');
      }
      await debugScreenshot(page, 'login_timeout');
      const state = await getPageState(page);
      console.log('Page state:', state);
      throw new Error('Login timeout');
    }

    // Step 6: Handle result
    if (result.condition.value.includes('dashboard') || result.condition.value.includes('return_to')) {
      // Success!
      if (sendMessage) {
        await sendMessage('Login successful!');
      }
      await debugScreenshot(page, 'github_logged_in');

      // Navigate to profile to confirm
      await safeGoto(page, 'https://github.com/settings/profile');
      await waitForPageReady(page);
      await debugScreenshot(page, 'github_profile');

      return { success: true, page, context, browser };

    } else if (result.condition.value === '#otp' || result.condition.value.includes('Two-factor')) {
      // 2FA required
      if (sendMessage) {
        await sendMessage('2FA required! Please check your authenticator app...');
      }
      await debugScreenshot(page, 'github_2fa_required');

      // Wait for user to complete 2FA (or handle programmatically)
      if (sendMessage) {
        await sendMessage('Waiting 60 seconds for manual 2FA completion...');
      }
      await sleep(60000);

      // Check if we're logged in now
      if (page.url().includes('dashboard') || page.url().includes('github.com/settings')) {
        if (sendMessage) {
          await sendMessage('2FA completed successfully!');
        }
        return { success: true, twoFactorCompleted: true, page, context, browser };
      }

      throw new Error('2FA not completed in time');

    } else {
      // Error
      const errorText = await page.textContent('body').catch(() => 'Unknown error');
      if (sendMessage) {
        await sendMessage(`Login failed: ${errorText.substring(0, 200)}`);
      }
      await debugScreenshot(page, 'github_login_error');
      throw new Error('Login failed');
    }

  } catch (error) {
    console.error('Login error:', error.message);

    if (sendMessage) {
      await sendMessage(`Error during GitHub login: ${error.message}`);
    }

    // Take final debug screenshot
    if (context) {
      const page = context.pages()[0];
      if (page) {
        await debugScreenshot(page, 'final_error_state');
        const state = await getPageState(page);
        console.log('Final page state:', state);
      }
    }

    throw error;

  } finally {
    // Uncomment to auto-close (usually leave open for debugging)
    // if (browser) {
    //   await browser.close();
    // }
  }
}

/**
 * Example: Using withRetry wrapper
 */
async function exampleWithRetry(sendMessage) {
  const browser = await chromium.launch({ headless: false });
  const context = await createRobustContext(browser);
  const page = await context.newPage();

  try {
    // Wrap entire operation in retry logic
    const result = await withRetry(async () => {
      // Navigate
      await safeGoto(page, 'https://github.com/login');

      // Fill and submit
      await safeType(page, '#login_field', 'user@example.com');
      await safeType(page, '#password', 'password123');
      await safeClick(page, 'input[type="submit"]');

      // Wait for success
      const success = await smartWait(page, '[data-id="dashboard"]', {
        timeout: 10000
      });

      if (!success) {
        throw new Error('Login failed');
      }

      return { success: true };

    }, {
      retries: 3,
      delay: 2000,
      backoff: 2,
      onRetry: async (error, attempt) => {
        console.log(`Retry ${attempt} after: ${error.message}`);
        if (sendMessage) {
          await sendMessage(`Login attempt ${attempt} failed, retrying...`);
        }
        // Could reload page or take other recovery action here
        await page.reload();
      },
      shouldRetry: (error) => {
        // Only retry certain errors
        return !error.message.includes('CAPTCHA');
      }
    });

    return result;

  } finally {
    // await browser.close();
  }
}

/**
 * Example: Form automation with comprehensive error handling
 */
async function exampleFormAutomation(sendMessage) {
  const browser = await chromium.launch({ headless: false });
  const context = await createRobustContext(browser);
  const page = await context.newPage();

  try {
    // Navigate
    await safeGoto(page, 'https://example.com/signup');
    await waitForPageReady(page);

    // Check for issues early
    let issues = await detectIssues(page);
    if (issues.captcha) {
      await handleCaptcha(page, sendMessage);
    }

    // Fill form fields with retry
    const fields = [
      { selectors: ['#name', 'input[name="name"]'], value: 'John Doe' },
      { selectors: ['#email', 'input[type="email"]'], value: 'john@example.com' },
      { selectors: ['#password', 'input[type="password"]'], value: 'SecurePass123!' }
    ];

    for (const field of fields) {
      const success = await safeType(page, field.selectors, field.value, {
        humanLike: true,
        verify: true,
        retries: 3
      });

      if (!success) {
        throw new Error(`Failed to fill field: ${field.selectors[0]}`);
      }

      await sleep(500, 0.3); // Human-like delay between fields
    }

    // Handle checkboxes
    await safeClick(page, [
      '#terms',
      'input[name="terms"]',
      'input[type="checkbox"]'
    ]);

    // Submit
    await safeClick(page, [
      'button[type="submit"]',
      'button:has-text("Sign up")',
      'input[type="submit"]'
    ], {
      waitForNavigation: true
    });

    // Wait for success or error
    const result = await waitForAny(page, [
      { type: 'url', value: '/welcome' },
      { type: 'selector', value: '.success' },
      { type: 'selector', value: '.error' }
    ]);

    if (result.matched && result.condition.value.includes('success') || result.condition.value.includes('welcome')) {
      if (sendMessage) {
        await sendMessage('Form submitted successfully!');
      }
      return { success: true };
    } else {
      throw new Error('Form submission failed');
    }

  } catch (error) {
    console.error('Form error:', error);
    if (sendMessage) {
      await sendMessage(`Form automation failed: ${error.message}`);
    }
    throw error;
  }
}

// Export examples
module.exports = {
  exampleGitHubLogin,
  exampleWithRetry,
  exampleFormAutomation
};

// Run if executed directly
if (require.main === module) {
  (async () => {
    console.log('Running example GitHub login...');

    // Mock send function
    const mockSend = async (msg) => console.log(`[SEND] ${msg}`);

    try {
      await exampleGitHubLogin(mockSend);
      console.log('Example completed successfully!');
    } catch (error) {
      console.error('Example failed:', error.message);
      process.exit(1);
    }
  })();
}
