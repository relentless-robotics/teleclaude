const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const stateFile = path.join('C:', 'Users', 'Footb', 'Documents', 'Github', 'teleclaude-main', 'browser_state', 'google_auth.json');

  let contextOptions = {
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  if (fs.existsSync(stateFile)) {
    contextOptions.storageState = stateFile;
  }

  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge'
  });

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    console.log('Navigating to GitHub login page...');
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Check if already logged in
    const loggedIn = await page.evaluate(() => {
      return document.querySelector('[data-login]') !== null ||
             document.querySelector('img[alt*="@relentless-robotics"]') !== null;
    });

    if (!loggedIn) {
      console.log('Not logged in. Logging in...');

      // Enter credentials
      const usernameField = page.locator('input#login_field');
      const passwordField = page.locator('input#password');

      await usernameField.fill('relentless-robotics');
      await passwordField.fill('Relentless@Robotics2026!');

      // Click sign in
      await page.locator('input[type="submit"][value="Sign in"]').click();
      await page.waitForTimeout(5000);
    } else {
      console.log('Already logged in');
    }

    // Now check for fork
    console.log('Checking if fork exists...');
    await page.goto('https://github.com/relentless-robotics/nuclei-templates', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    const is404 = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('404') ||
             text.includes('This is not the web page you are looking for');
    });

    if (is404) {
      console.log('Fork does not exist. Creating fork via URL...');

      // Direct fork URL
      await page.goto('https://github.com/projectdiscovery/nuclei-templates/fork', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      // Click create fork button if present
      const createButton = page.locator('button:has-text("Create fork"), button[type="submit"]').first();
      const createVisible = await createButton.isVisible({ timeout: 5000 }).catch(() => false);

      if (createVisible) {
        console.log('Clicking Create fork button...');
        await createButton.click();
        await page.waitForTimeout(10000); // Wait longer for fork creation

        console.log('FORK_CREATED:https://github.com/relentless-robotics/nuclei-templates');
      } else {
        console.log('Create fork button not found. Taking screenshot...');
        await page.screenshot({ path: 'fork_page.png' });
        console.log('Screenshot saved: fork_page.png');
      }
    } else {
      console.log('FORK_EXISTS:https://github.com/relentless-robotics/nuclei-templates');
    }

  } catch (error) {
    console.log('ERROR:' + error.message);
    await page.screenshot({ path: 'fork_error.png' }).catch(() => {});
  }

  await page.waitForTimeout(3000);
  await browser.close();
})();
