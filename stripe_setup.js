const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const stateFile = 'C:/Users/Footb/Documents/Github/teleclaude-main/browser_state/google_auth.json';
  const screenshotDir = 'C:/Users/Footb/Documents/Github/teleclaude-main/screenshots';

  // Ensure screenshot directory exists
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  // Check if state file exists
  let useGoogleAuth = false;
  if (fs.existsSync(stateFile)) {
    console.log('Google auth state file found, attempting to use it...');
    useGoogleAuth = true;
  } else {
    console.log('Google auth state file NOT found, will use Edge profile instead');
  }

  let browser, context, page;

  try {
    if (useGoogleAuth) {
      browser = await chromium.launch({ headless: false });
      context = await browser.newContext({ storageState: stateFile });
      page = await context.newPage();
      console.log('Browser launched with Google auth state');
    } else {
      // Use Edge with persistent profile
      context = await chromium.launchPersistentContext('./browser_profile_stripe', {
        channel: 'msedge',
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
      });
      page = context.pages()[0] || await context.newPage();
      console.log('Browser launched with Edge persistent profile');
    }

    console.log('Navigating to stripe.com...');
    await page.goto('https://stripe.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    console.log('Page loaded: ' + await page.title());
    await page.screenshot({ path: path.join(screenshotDir, 'stripe_home.png'), fullPage: false });
    console.log('Screenshot saved to stripe_home.png');

    // Look for sign up button
    console.log('Looking for signup button...');
    let clicked = false;

    // Try different selectors for signup
    const signupSelectors = [
      'a:has-text("Start now")',
      'a:has-text("Get started")',
      'a:has-text("Create account")',
      'a:has-text("Sign up")',
      'button:has-text("Start now")',
      '[data-testid="home-signup-cta"]',
      'a[href*="/register"]',
      'a[href*="/login"]'
    ];

    for (const selector of signupSelectors) {
      try {
        const btn = await page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          console.log('Found button with selector: ' + selector);
          await btn.click();
          clicked = true;
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!clicked) {
      console.log('No signup button found, trying to navigate directly to register page...');
      await page.goto('https://dashboard.stripe.com/register', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(screenshotDir, 'stripe_signup.png'), fullPage: false });
    console.log('Screenshot saved to stripe_signup.png');
    console.log('Current URL: ' + page.url());
    console.log('Page title: ' + await page.title());

    // Check for Google sign in option
    const googleSelectors = [
      'button:has-text("Continue with Google")',
      'button:has-text("Sign in with Google")',
      '[data-testid="google-button"]',
      'button[aria-label*="Google"]',
      '.google-button',
      '#google-signin'
    ];

    let googleFound = false;
    for (const selector of googleSelectors) {
      try {
        const btn = await page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          console.log('Found Google button with selector: ' + selector);
          googleFound = true;
          console.log('Clicking Google sign in...');
          await btn.click();
          await page.waitForTimeout(5000);
          break;
        }
      } catch (e) {
        // Continue
      }
    }

    if (!googleFound) {
      console.log('Google sign in not found, will use email signup');

      // Look for email field
      const emailField = await page.locator('input[type="email"], input[name="email"], input[placeholder*="email"]').first();
      if (await emailField.isVisible({ timeout: 3000 })) {
        console.log('Found email field, entering email...');
        await emailField.fill('relentlessrobotics@gmail.com');
        await page.waitForTimeout(1000);

        // Look for password field
        const passwordField = await page.locator('input[type="password"], input[name="password"]').first();
        if (await passwordField.isVisible({ timeout: 2000 })) {
          console.log('Found password field, entering password...');
          await passwordField.fill('Stripe@Robotics2026!');
        }

        // Look for name field
        const nameField = await page.locator('input[name="name"], input[placeholder*="name"]').first();
        if (await nameField.isVisible({ timeout: 2000 })) {
          console.log('Found name field, entering name...');
          await nameField.fill('Nicholas Liautaud');
        }

        await page.screenshot({ path: path.join(screenshotDir, 'stripe_form_filled.png'), fullPage: false });
        console.log('Screenshot saved to stripe_form_filled.png');

        // Look for submit/create account button
        const submitBtn = await page.locator('button[type="submit"], button:has-text("Create account"), button:has-text("Sign up"), button:has-text("Continue")').first();
        if (await submitBtn.isVisible({ timeout: 2000 })) {
          console.log('Found submit button, clicking...');
          await submitBtn.click();
          await page.waitForTimeout(5000);
        }
      }
    }

    await page.screenshot({ path: path.join(screenshotDir, 'stripe_after_signup.png'), fullPage: false });
    console.log('Screenshot saved to stripe_after_signup.png');
    console.log('Current URL: ' + page.url());

    // Wait for user to see the browser state
    console.log('Waiting 120 seconds for inspection and manual interaction if needed...');
    await page.waitForTimeout(120000);

    if (browser) {
      await browser.close();
    } else {
      await context.close();
    }
    console.log('Browser closed');
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);

    // Take error screenshot
    if (page) {
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_error.png'), fullPage: false });
      console.log('Error screenshot saved');
    }

    if (browser) {
      await browser.close();
    } else if (context) {
      await context.close();
    }
  }
})();
