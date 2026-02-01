const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function getGitHubClientSecret() {
  console.log('Getting GitHub OAuth Client Secret...');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 1000
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate directly to the OAuth app page
    console.log('Navigating to TeleClaude Dashboard OAuth app...');
    await page.goto('https://github.com/settings/developers');
    await page.waitForTimeout(2000);

    // Check if we need to login
    const needsLogin = await page.locator('input[name="login"]').isVisible({ timeout: 5000 }).catch(() => false);

    if (needsLogin) {
      console.log('Login required, entering credentials...');
      await page.fill('input[name="login"]', 'relentless-robotics');
      await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
      await page.click('input[type="submit"][value="Sign in"]');
      await page.waitForTimeout(3000);

      const has2FA = await page.locator('input[name="otp"]').isVisible({ timeout: 3000 }).catch(() => false);
      if (has2FA) {
        console.log('⚠️ 2FA required! Please complete authentication...');
        await page.waitForURL('**/settings/developers', { timeout: 60000 });
      }
    }

    // Click on "TeleClaude Dashboard" link
    console.log('Finding TeleClaude Dashboard app...');
    const appLink = page.locator('a:has-text("TeleClaude Dashboard")').first();
    await appLink.click();
    await page.waitForTimeout(2000);

    await page.screenshot({ path: 'screenshots/github_oauth_app_page.png' });

    // Extract Client ID from the page
    console.log('Extracting Client ID...');
    const clientIdText = await page.locator('text=Client ID').locator('..').locator('..').textContent();
    const clientId = clientIdText.match(/Ov[a-zA-Z0-9]+/)[0];
    console.log(`Client ID: ${clientId}`);

    // Click "Generate a new client secret"
    console.log('Clicking "Generate a new client secret"...');
    const generateButton = page.locator('button:has-text("Generate a new client secret")');
    await generateButton.click();
    await page.waitForTimeout(2000);

    await page.screenshot({ path: 'screenshots/github_oauth_secret_generated.png' });

    // The secret appears in a flash message or in the client secrets section
    console.log('⚠️ CRITICAL: Extracting Client Secret (only shown once!)...');

    // Try multiple selectors to find the secret
    let clientSecret = null;

    // Method 1: Look for a flash message with the secret
    try {
      const flashMessage = await page.locator('.flash-full, .flash-success').first();
      const flashText = await flashMessage.textContent({ timeout: 5000 });
      const secretMatch = flashText.match(/[a-f0-9]{40}/);
      if (secretMatch) {
        clientSecret = secretMatch[0];
      }
    } catch (e) {
      console.log('Flash message method failed, trying alternative...');
    }

    // Method 2: Look in the client secrets section
    if (!clientSecret) {
      try {
        const secretElement = await page.locator('.client-secret-value, [data-secret-value], code').first();
        clientSecret = await secretElement.textContent({ timeout: 5000 });
      } catch (e) {
        console.log('Client secret element method failed...');
      }
    }

    // Method 3: Look for any text that looks like a secret (40 hex characters)
    if (!clientSecret) {
      const pageText = await page.textContent('body');
      const secretMatch = pageText.match(/\b[a-f0-9]{40}\b/);
      if (secretMatch) {
        clientSecret = secretMatch[0];
      }
    }

    if (!clientSecret) {
      throw new Error('Could not find client secret on the page. Please check the screenshot.');
    }

    console.log(`Client Secret captured: ${clientSecret.substring(0, 10)}...`);

    // Save credentials
    const credentials = {
      client_id: clientId,
      client_secret: clientSecret,
      application_name: 'TeleClaude Dashboard',
      homepage_url: 'https://dashboard-app-black-kappa.vercel.app',
      callback_url: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
      created_at: new Date().toISOString()
    };

    const credentialsPath = path.join(__dirname, 'github_oauth_credentials.json');
    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));

    console.log(`✅ Credentials saved to: ${credentialsPath}`);
    console.log('\nCredentials:');
    console.log(JSON.stringify(credentials, null, 2));

    await page.waitForTimeout(3000);
    await browser.close();

    return credentials;

  } catch (error) {
    console.error('❌ Error:', error);
    await page.screenshot({ path: 'screenshots/github_oauth_secret_error.png' });
    await browser.close();
    throw error;
  }
}

// Run the script
getGitHubClientSecret()
  .then(credentials => {
    console.log('\n✅ SUCCESS! Credentials obtained.');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ FAILED:', error.message);
    process.exit(1);
  });
