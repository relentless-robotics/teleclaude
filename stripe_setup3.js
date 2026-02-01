const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const screenshotDir = 'C:/Users/Footb/Documents/Github/teleclaude-main/screenshots';

  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  let context, page;

  try {
    console.log('Launching Edge browser with persistent profile...');
    context = await chromium.launchPersistentContext('./browser_profile_stripe', {
      channel: 'msedge',
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 900 }
    });
    page = context.pages()[0] || await context.newPage();
    console.log('Browser launched');

    console.log('Navigating to Stripe registration...');
    await page.goto('https://dashboard.stripe.com/register', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    console.log('Page loaded: ' + await page.title());

    // First try Google sign up
    console.log('Looking for Google sign up button...');
    const googleBtn = await page.locator('button:has-text("Sign up with Google")').first();
    if (await googleBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Found Google sign up button, clicking...');
      await googleBtn.click();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_google.png'), fullPage: false });
      console.log('Current URL: ' + page.url());

      // Handle Google popup or redirect
      const pages = context.pages();
      console.log('Number of pages: ' + pages.length);

      // Check if a new popup opened
      let googlePage = pages.find(p => p.url().includes('accounts.google.com'));
      if (!googlePage && page.url().includes('accounts.google.com')) {
        googlePage = page;
      }

      if (googlePage) {
        console.log('On Google accounts page');
        await googlePage.screenshot({ path: path.join(screenshotDir, 'google_accounts.png'), fullPage: false });

        // Select account if available
        const accountSelector = await googlePage.locator('div[data-email="relentlessrobotics@gmail.com"]').first();
        if (await accountSelector.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('Clicking on account...');
          await accountSelector.click();
          await page.waitForTimeout(5000);
        } else {
          // Enter email
          const emailInput = await googlePage.locator('input[type="email"]').first();
          if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('Entering email...');
            await emailInput.fill('relentlessrobotics@gmail.com');
            await googlePage.keyboard.press('Enter');
            await page.waitForTimeout(3000);
          }
        }

        await page.screenshot({ path: path.join(screenshotDir, 'stripe_after_google.png'), fullPage: false });
      }
    } else {
      console.log('Google button not visible, using email signup...');

      // Fill email
      const emailField = await page.locator('input[type="email"], input[name="email"]').first();
      if (await emailField.isVisible({ timeout: 3000 })) {
        await emailField.clear();
        await emailField.fill('relentlessrobotics@gmail.com');
        console.log('Email filled');
      }

      // Fill name
      const nameField = await page.locator('input[name="name"]').first();
      if (await nameField.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameField.clear();
        await nameField.fill('Nicholas Liautaud');
        console.log('Name filled');
      }

      // Fill password - use a very strong random password
      // Avoiding common words, names, dates, repetition
      const strongPassword = 'Kx9#mPq2vL$nB7zR!wYc';
      const passwordField = await page.locator('input[type="password"]').first();
      if (await passwordField.isVisible({ timeout: 2000 }).catch(() => false)) {
        await passwordField.clear();
        await passwordField.fill(strongPassword);
        console.log('Strong password filled');
      }

      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_strong_pass.png'), fullPage: false });

      // Check if password is accepted
      const weakMsg = await page.locator('text=too weak').first();
      const isWeak = await weakMsg.isVisible({ timeout: 1000 }).catch(() => false);
      console.log('Password still weak: ' + isWeak);

      if (!isWeak) {
        // Try to click Create account
        const createBtn = await page.locator('button:has-text("Create account")').first();
        const isDisabled = await createBtn.getAttribute('disabled');
        console.log('Button disabled: ' + isDisabled);

        if (isDisabled === null) {
          console.log('Button enabled, clicking...');
          await createBtn.click();
          await page.waitForTimeout(5000);
          await page.screenshot({ path: path.join(screenshotDir, 'stripe_submitted.png'), fullPage: false });
          console.log('Current URL: ' + page.url());
        }
      }
    }

    console.log('Current URL: ' + page.url());
    await page.screenshot({ path: path.join(screenshotDir, 'stripe_current.png'), fullPage: false });

    // Check if we need to verify email
    if (await page.locator('text=verify your email').isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Email verification required');
    }

    // Check if we're on onboarding
    if (page.url().includes('onboarding') || page.url().includes('setup')) {
      console.log('On onboarding page!');
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_onboarding.png'), fullPage: false });
    }

    // Wait for manual inspection
    console.log('Waiting 180 seconds for inspection...');
    await page.waitForTimeout(180000);

    await context.close();
    console.log('Browser closed');
  } catch (error) {
    console.error('Error:', error.message);

    if (page) {
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_error3.png'), fullPage: false });
    }

    if (context) {
      await context.close();
    }
  }
})();
