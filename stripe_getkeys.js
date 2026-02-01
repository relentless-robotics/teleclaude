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

    // Navigate to API keys page
    console.log('Navigating to API keys page...');
    await page.goto('https://dashboard.stripe.com/test/apikeys', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    console.log('Page loaded: ' + await page.title());
    console.log('Current URL: ' + page.url());
    await page.screenshot({ path: path.join(screenshotDir, 'stripe_apikeys.png'), fullPage: false });

    // Try to get publishable key
    const publishableKey = await page.locator('text=pk_test_').first();
    if (await publishableKey.isVisible({ timeout: 3000 }).catch(() => false)) {
      const keyText = await publishableKey.textContent();
      console.log('Publishable key found: ' + keyText);
    }

    // Look for reveal secret key button
    const revealBtn = await page.locator('button:has-text("Reveal test key"), button:has-text("Reveal")').first();
    if (await revealBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Found reveal button, clicking...');
      await revealBtn.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_apikeys_revealed.png'), fullPage: false });
    }

    // Wait for inspection
    console.log('Waiting 60 seconds for inspection...');
    await page.waitForTimeout(60000);

    await context.close();
    console.log('Browser closed');
  } catch (error) {
    console.error('Error:', error.message);

    if (page) {
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_keys_error.png'), fullPage: false });
    }

    if (context) {
      await context.close();
    }
  }
})();
