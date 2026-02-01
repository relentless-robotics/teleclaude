/**
 * Check existing GitHub OAuth Apps
 */

const { launchStealthBrowser } = require('./captcha-lab/solver/stealth-browser.js');
const fs = require('fs');
const path = require('path');

async function checkExistingOAuthApps() {
  const { browser, context, page } = await launchStealthBrowser({ headless: false });

  try {
    console.log('Navigating to GitHub OAuth Apps...');

    await page.goto('https://github.com/settings/developers', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    // Take screenshot
    const screenshotDir = path.join(__dirname, 'screenshots', 'oauth');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const screenshot = path.join(screenshotDir, `current_apps_${Date.now()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log('Screenshot saved:', screenshot);

    // Check if TeleClaude Dashboard app exists
    const appExists = await page.locator('text=TeleClaude Dashboard').isVisible().catch(() => false);

    if (appExists) {
      console.log('\n✅ TeleClaude Dashboard OAuth app EXISTS!');
      console.log('Click on it in the browser to see the Client ID');
      console.log('Then click "Generate a new client secret" to get the secret');

      // Wait for user to manually interact
      console.log('\nKeeping browser open for 5 minutes...');
      console.log('Press Ctrl+C when you have the credentials');

      await page.waitForTimeout(300000); // 5 minutes
    } else {
      console.log('\n❌ TeleClaude Dashboard OAuth app NOT FOUND');
      console.log('You may need to create it manually');
    }

    await browser.close();

  } catch (error) {
    console.error('Error:', error);
    await browser.close();
  }
}

checkExistingOAuthApps();
