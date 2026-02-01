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

  let browser, context, page;

  try {
    // Use Edge with persistent profile for better compatibility
    console.log('Launching Edge browser with persistent profile...');
    context = await chromium.launchPersistentContext('./browser_profile_stripe', {
      channel: 'msedge',
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 800 }
    });
    page = context.pages()[0] || await context.newPage();
    console.log('Browser launched with Edge persistent profile');

    console.log('Navigating to Stripe registration...');
    await page.goto('https://dashboard.stripe.com/register', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    console.log('Page loaded: ' + await page.title());
    await page.screenshot({ path: path.join(screenshotDir, 'stripe_register.png'), fullPage: false });
    console.log('Screenshot saved to stripe_register.png');

    // Check for "Sign up with Google" button first
    const googleBtn = await page.locator('button:has-text("Sign up with Google"), button:has-text("Continue with Google")').first();
    if (await googleBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Found Google sign up button, clicking it...');
      await googleBtn.click();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_google_auth.png'), fullPage: false });
      console.log('Screenshot saved to stripe_google_auth.png');
      console.log('Current URL: ' + page.url());

      // If we're on Google accounts page, select the account
      if (page.url().includes('accounts.google.com')) {
        console.log('On Google accounts page, looking for account to select...');

        // Look for the account
        const accountDiv = await page.locator('div[data-email="relentlessrobotics@gmail.com"], div:has-text("relentlessrobotics@gmail.com")').first();
        if (await accountDiv.isVisible({ timeout: 5000 }).catch(() => false)) {
          console.log('Found account, clicking...');
          await accountDiv.click();
          await page.waitForTimeout(5000);
        } else {
          console.log('Account not found, may need to sign in...');
          // Try to fill in email
          const emailInput = await page.locator('input[type="email"]').first();
          if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await emailInput.fill('relentlessrobotics@gmail.com');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);
          }
        }

        await page.screenshot({ path: path.join(screenshotDir, 'stripe_google_progress.png'), fullPage: false });
        console.log('Screenshot saved');
      }
    } else {
      // Fill out the form manually
      console.log('Google button not found, filling form manually...');

      // Fill email
      const emailField = await page.locator('input[type="email"], input[name="email"]').first();
      if (await emailField.isVisible({ timeout: 3000 })) {
        await emailField.fill('relentlessrobotics@gmail.com');
        console.log('Email filled');
      }

      // Fill name
      const nameField = await page.locator('input[name="name"], input[placeholder*="name"]').first();
      if (await nameField.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameField.fill('Nicholas Liautaud');
        console.log('Name filled');
      }

      // Fill password
      const passwordField = await page.locator('input[type="password"], input[name="password"]').first();
      if (await passwordField.isVisible({ timeout: 2000 }).catch(() => false)) {
        await passwordField.fill('Stripe@Robotics2026!');
        console.log('Password filled');
      }

      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_form_ready.png'), fullPage: false });

      // Wait for button to become enabled and click
      console.log('Waiting for Create account button to become enabled...');
      const createBtn = await page.locator('button[data-testid="register-submit-button"], button:has-text("Create account")').first();

      // Check if button is enabled
      await page.waitForTimeout(2000);
      const isDisabled = await createBtn.getAttribute('disabled');
      console.log('Button disabled attribute: ' + isDisabled);

      if (isDisabled === null || isDisabled === undefined) {
        console.log('Button appears enabled, clicking...');
        await createBtn.click({ force: true });
        await page.waitForTimeout(5000);
      } else {
        console.log('Button still disabled, trying force click...');
        await createBtn.click({ force: true });
        await page.waitForTimeout(5000);
      }
    }

    await page.screenshot({ path: path.join(screenshotDir, 'stripe_after_submit.png'), fullPage: false });
    console.log('Screenshot saved to stripe_after_submit.png');
    console.log('Current URL: ' + page.url());
    console.log('Page title: ' + await page.title());

    // Check if we're on a verification page or onboarding
    if (page.url().includes('verify') || page.url().includes('onboarding') || page.url().includes('dashboard')) {
      console.log('Progressed to next step!');

      // Look for business type selection
      const businessTypeSelectors = [
        'label:has-text("Individual")',
        'button:has-text("Individual")',
        'input[value="individual"]',
        'label:has-text("Sole proprietor")'
      ];

      for (const selector of businessTypeSelectors) {
        try {
          const elem = await page.locator(selector).first();
          if (await elem.isVisible({ timeout: 2000 })) {
            console.log('Found business type option: ' + selector);
            await elem.click();
            await page.waitForTimeout(2000);
            break;
          }
        } catch (e) {}
      }

      await page.screenshot({ path: path.join(screenshotDir, 'stripe_business_type.png'), fullPage: false });
    }

    // Wait for manual interaction
    console.log('Waiting 180 seconds for inspection and manual steps if needed...');
    await page.waitForTimeout(180000);

    await context.close();
    console.log('Browser closed');
  } catch (error) {
    console.error('Error:', error.message);

    if (page) {
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_error2.png'), fullPage: false });
      console.log('Error screenshot saved');
    }

    if (context) {
      await context.close();
    }
  }
})();
