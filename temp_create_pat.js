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
    // Login first
    console.log('Logging into GitHub...');
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const loggedIn = await page.evaluate(() => {
      return document.querySelector('[data-login]') !== null;
    });

    if (!loggedIn) {
      await page.locator('input#login_field').fill('relentless-robotics');
      await page.locator('input#password').fill('Relentless@Robotics2026!');
      await page.locator('input[type="submit"][value="Sign in"]').click();
      await page.waitForTimeout(5000);
    }

    // Go to PAT creation page
    console.log('Navigating to PAT creation page...');
    await page.goto('https://github.com/settings/tokens/new', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Fill in PAT details
    console.log('Creating new Personal Access Token...');

    // Note field
    await page.locator('input#oauth_access_description').fill('TeleClaude Nuclei PR');

    // Select repo scope (needed for pushing)
    const repoCheckbox = page.locator('input[name="oauth_access[scopes][]"][value="repo"]');
    const isChecked = await repoCheckbox.isChecked().catch(() => false);
    if (!isChecked) {
      await repoCheckbox.check();
    }

    await page.waitForTimeout(1000);

    // Generate token
    const generateButton = page.locator('button[type="submit"]:has-text("Generate token")');
    await generateButton.click();
    await page.waitForTimeout(3000);

    // Get the token
    const tokenElement = page.locator('input#oauth_access_token, input.js-oauth-token-value');
    const token = await tokenElement.inputValue().catch(() => null);

    if (token) {
      console.log('PAT_CREATED:' + token);

      // Save to file
      fs.writeFileSync('github_pat.txt', token, 'utf-8');
      console.log('Token saved to github_pat.txt');
    } else {
      console.log('ERROR:Could not extract token');
      await page.screenshot({ path: 'pat_page.png' });
    }

  } catch (error) {
    console.log('ERROR:' + error.message);
    await page.screenshot({ path: 'pat_error.png' }).catch(() => {});
  }

  await page.waitForTimeout(3000);
  await browser.close();
})();
