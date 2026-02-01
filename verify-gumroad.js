const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('Starting browser automation for Gumroad email verification...');

  // Create a separate user data dir to avoid conflicts with running Edge
  const tempUserDataDir = path.join(__dirname, 'playwright-edge-data');

  // Copy cookies/session from Edge if we haven't already
  const edgeUserDataDir = 'C:\\Users\\Footb\\AppData\\Local\\Microsoft\\Edge\\User Data';

  let browser;
  let context;

  try {
    // Launch Edge using channel option which should use the installed Edge
    context = await chromium.launchPersistentContext(tempUserDataDir, {
      headless: false,
      channel: 'msedge',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });
    console.log('Launched Edge browser');
  } catch (e) {
    console.log('Could not launch Edge, trying Chromium...', e.message);
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled'
      ]
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
  }

  const page = await context.newPage();

  try {
    // Navigate to Gmail
    console.log('Navigating to Gmail...');
    await page.goto('https://mail.google.com/', { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for either inbox or login page
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    // Check if we need to log in
    if (currentUrl.includes('accounts.google.com')) {
      console.log('Need to log in to Google...');

      // Enter email
      const emailInput = page.locator('input[type="email"]');
      if (await emailInput.isVisible()) {
        await emailInput.fill('relentlessrobotics@gmail.com');
        await page.click('#identifierNext');
        await page.waitForTimeout(3000);
      }

      // Enter password
      const passwordInput = page.locator('input[type="password"]');
      if (await passwordInput.isVisible()) {
        await passwordInput.fill('Relaxing41!');
        await page.click('#passwordNext');
        await page.waitForTimeout(5000);
      }

      // Check for 2FA prompt
      const twoFactorPrompt = page.locator('text=2-Step Verification');
      if (await twoFactorPrompt.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('2FA required - waiting for user to approve on phone...');
        // Wait up to 60 seconds for 2FA approval
        await page.waitForNavigation({ timeout: 60000 });
      }
    }

    // Wait for Gmail to load
    console.log('Waiting for Gmail inbox to load...');
    await page.waitForTimeout(5000);

    // Search for Gumroad confirmation email
    console.log('Searching for Gumroad confirmation email...');

    // Look for search bar and search
    const searchBox = page.locator('input[aria-label="Search mail"]');
    if (await searchBox.isVisible({ timeout: 5000 }).catch(() => false)) {
      await searchBox.click();
      await searchBox.fill('from:gumroad "Confirmation instructions"');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }

    // Click on the first email result
    console.log('Looking for the Gumroad email...');
    const emailSubject = page.locator('text=Confirmation instructions').first();
    if (await emailSubject.isVisible({ timeout: 5000 }).catch(() => false)) {
      await emailSubject.click();
      await page.waitForTimeout(3000);

      // Look for the confirmation link
      console.log('Email opened, looking for confirmation link...');
      const confirmLink = page.locator('a:has-text("Confirm my account")').first();
      if (await confirmLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        const href = await confirmLink.getAttribute('href');
        console.log('Found confirmation link:', href);

        // Click the confirmation link
        await confirmLink.click();
        console.log('Clicked confirmation link');

        // Wait for new page/tab
        await page.waitForTimeout(5000);

        // Check if verification was successful
        const pages = context.pages();
        const lastPage = pages[pages.length - 1];
        console.log('Verification page URL:', lastPage.url());

        // Take a screenshot
        await lastPage.screenshot({ path: 'gumroad-verification-result.png' });
        console.log('Screenshot saved to gumroad-verification-result.png');

        // Check for success message
        const successText = await lastPage.textContent('body');
        if (successText.toLowerCase().includes('confirmed') ||
            successText.toLowerCase().includes('verified') ||
            successText.toLowerCase().includes('success')) {
          console.log('SUCCESS: Gumroad email appears to be verified!');
        } else {
          console.log('Page content (first 500 chars):', successText.substring(0, 500));
        }
      } else {
        console.log('Could not find confirmation link in email');
        // Try alternative link text
        const altLink = page.locator('a').filter({ hasText: /confirm/i }).first();
        if (await altLink.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('Found alternative confirm link');
          await altLink.click();
          await page.waitForTimeout(5000);
        }
      }
    } else {
      console.log('Could not find Gumroad confirmation email');

      // Take screenshot of current state
      await page.screenshot({ path: 'gmail-search-result.png' });
      console.log('Screenshot saved to gmail-search-result.png');
    }

  } catch (error) {
    console.error('Error during automation:', error.message);
    await page.screenshot({ path: 'error-screenshot.png' });
    console.log('Error screenshot saved');
  } finally {
    // Keep browser open for 10 seconds to see results
    await page.waitForTimeout(10000);
    await context.close();
    if (browser) await browser.close();
  }

  console.log('Browser automation completed.');
})();
