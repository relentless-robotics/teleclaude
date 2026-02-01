const { chromium } = require('playwright');
const fs = require('fs');

async function getSecret() {
  const browser = await chromium.launch({ headless: false, slowMo: 1000 });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://github.com/settings/developers');
    await page.waitForLoadState('networkidle');

    const needsLogin = await page.locator('input[name="login"]').isVisible({ timeout: 5000 }).catch(() => false);
    if (needsLogin) {
      await page.fill('input[name="login"]', 'relentless-robotics');
      await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
      await page.click('input[type="submit"]');
      await page.waitForTimeout(3000);
    }

    // Click the app
    await page.click('text=TeleClaude Dashboard');
    await page.waitForLoadState('networkidle');

    // Get Client ID from page
    const clientId = await page.locator('text=Client ID').locator('..').locator('..').innerText()
      .then(text => text.match(/Ov[a-zA-Z0-9]+/)[0]);

    console.log('Client ID:', clientId);

    // Click generate secret button - try multiple approaches
    await page.screenshot({ path: 'screenshots/before_generate.png' });

    try {
      // Method 1: Direct button click
      await page.getByRole('button', { name: 'Generate a new client secret' }).click({ timeout: 5000 });
    } catch {
      try {
        // Method 2: Text selector
        await page.click('button:has-text("Generate a new client secret")', { timeout: 5000 });
      } catch {
        // Method 3: Any button with "Generate" text
        await page.click('button:has-text("Generate")', { timeout: 5000 });
      }
    }

    // Wait for the secret to appear
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/after_generate.png' });

    // Try to find the secret in various ways
    let clientSecret = null;

    // Method 1: Look for success flash banner
    try {
      const banner = await page.locator('.flash-success, .flash-full').first().textContent({ timeout: 5000 });
      const match = banner.match(/ghp_[a-zA-Z0-9]{36}|[a-f0-9]{40}/);
      if (match) clientSecret = match[0];
    } catch (e) {}

    // Method 2: Look in Client secrets section for the secret text
    if (!clientSecret) {
      try {
        const secretsSection = await page.locator('text=Client secrets').locator('..').locator('..').textContent();
        const match = secretsSection.match(/ghp_[a-zA-Z0-9]{36}|[a-f0-9]{40}/);
        if (match) clientSecret = match[0];
      } catch (e) {}
    }

    // Method 3: Look for any code/pre elements
    if (!clientSecret) {
      try {
        const codes = await page.locator('code, pre, .blob-code').allTextContents();
        for (const code of codes) {
          const match = code.match(/ghp_[a-zA-Z0-9]{36}|[a-f0-9]{40}/);
          if (match) {
            clientSecret = match[0];
            break;
          }
        }
      } catch (e) {}
    }

    // Method 4: Get entire page text and search
    if (!clientSecret) {
      const bodyText = await page.textContent('body');
      const match = bodyText.match(/ghp_[a-zA-Z0-9]{36}|[a-f0-9]{40}/);
      if (match) clientSecret = match[0];
    }

    if (!clientSecret) {
      console.error('Could not find client secret automatically.');
      console.log('Please check screenshots/after_generate.png');
      console.log('Keeping browser open for 30 seconds...');
      await page.waitForTimeout(30000);
      throw new Error('Client secret not found');
    }

    console.log('Client Secret:', clientSecret.substring(0, 10) + '...');

    const credentials = {
      client_id: clientId,
      client_secret: clientSecret,
      application_name: 'TeleClaude Dashboard',
      homepage_url: 'https://dashboard-app-black-kappa.vercel.app',
      callback_url: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
      created_at: new Date().toISOString()
    };

    fs.writeFileSync('github_oauth_credentials.json', JSON.stringify(credentials, null, 2));
    console.log('\n✅ Success! Credentials saved.');

    await page.waitForTimeout(2000);
    await browser.close();
    return credentials;

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'screenshots/error_final.png' });
    console.log('Browser will stay open for inspection...');
    await page.waitForTimeout(20000);
    await browser.close();
    throw error;
  }
}

getSecret()
  .then(creds => {
    console.log(JSON.stringify(creds, null, 2));
    process.exit(0);
  })
  .catch(() => process.exit(1));
