const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'msedge' });
  const page = await browser.newPage();

  try {
    // Login
    console.log('Logging in...');
    await page.goto('https://github.com/login');
    await page.fill('input#login_field', 'relentless-robotics');
    await page.fill('input#password', 'Relentless@Robotics2026!');
    await page.click('input[type="submit"]');
    await page.waitForTimeout(5000);

    // Go directly to classic token page (fine-grained tokens are more complex)
    console.log('Creating PAT...');
    await page.goto('https://github.com/settings/tokens/new');
    await page.waitForTimeout(3000);

    // Fill note
    await page.fill('input#oauth_access_description', 'TeleClaude Nuclei PR');

    // Select repo scope
    await page.check('input[value="repo"]');
    await page.waitForTimeout(1000);

    // Generate token
    await page.click('button:has-text("Generate token")');
    await page.waitForTimeout(3000);

    // Copy token - it should be visible and selected
    const tokenText = await page.locator('#new-oauth-token').inputValue();

    if (tokenText) {
      console.log('TOKEN:' + tokenText);
      fs.writeFileSync('github_token.txt', tokenText);
      console.log('Saved to github_token.txt');
    } else {
      console.log('ERROR: Could not get token');
      await page.screenshot({ path: 'token_page.png' });
    }

  } catch (error) {
    console.log('ERROR:' + error.message);
  }

  await page.waitForTimeout(3000);
  await browser.close();
})();
