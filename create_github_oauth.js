const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function createGitHubOAuthApp() {
  console.log('Starting GitHub OAuth App creation...');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 1000 // Slow down actions so we can see what's happening
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Step 1: Navigate to GitHub OAuth Apps settings
    console.log('Navigating to GitHub OAuth Apps settings...');
    await page.goto('https://github.com/settings/developers');

    // Check if we need to login
    const needsLogin = await page.locator('input[name="login"]').isVisible({ timeout: 5000 }).catch(() => false);

    if (needsLogin) {
      console.log('Login required, entering credentials...');
      await page.fill('input[name="login"]', 'relentless-robotics');
      await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
      await page.click('input[type="submit"][value="Sign in"]');

      // Wait for potential 2FA or redirect
      await page.waitForTimeout(3000);

      // Check if 2FA is required
      const has2FA = await page.locator('input[name="otp"]').isVisible({ timeout: 3000 }).catch(() => false);
      if (has2FA) {
        console.log('⚠️ 2FA required! Please complete authentication in the browser...');
        // Wait up to 60 seconds for user to complete 2FA
        await page.waitForURL('**/settings/developers', { timeout: 60000 });
      }
    }

    console.log('Taking screenshot of developers page...');
    await page.screenshot({ path: 'screenshots/github_oauth_1_developers_page.png' });

    // Step 2: Click "New OAuth App" button
    console.log('Clicking "New OAuth App" button...');

    // Try different selectors for the New OAuth App button
    const newAppButton = page.locator('a[href="/settings/applications/new"], a:has-text("New OAuth App")').first();
    await newAppButton.click();

    await page.waitForTimeout(2000);
    console.log('Taking screenshot of new OAuth app form...');
    await page.screenshot({ path: 'screenshots/github_oauth_2_new_app_form.png' });

    // Step 3: Fill in the form
    console.log('Filling in OAuth App form...');

    await page.fill('input[name="oauth_application[name]"]', 'TeleClaude Dashboard');
    await page.fill('input[name="oauth_application[url]"]', 'https://dashboard-app-black-kappa.vercel.app');
    await page.fill('input[name="oauth_application[callback_url]"]', 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github');

    // Optional: Fill description
    const descriptionField = page.locator('textarea[name="oauth_application[description]"]');
    if (await descriptionField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await descriptionField.fill('OAuth authentication for TeleClaude Dashboard - AI-powered Telegram/Discord bridge interface');
    }

    console.log('Taking screenshot of filled form...');
    await page.screenshot({ path: 'screenshots/github_oauth_3_filled_form.png' });

    // Step 4: Submit the form
    console.log('Submitting form...');
    await page.click('button[type="submit"]:has-text("Register application")');

    await page.waitForTimeout(3000);
    console.log('Taking screenshot of OAuth app page...');
    await page.screenshot({ path: 'screenshots/github_oauth_4_app_created.png' });

    // Step 5: Extract Client ID
    console.log('Extracting Client ID...');
    const clientIdElement = await page.locator('input[name="oauth_application[client_id]"], code:has-text("client_id")').first();
    let clientId = await clientIdElement.inputValue().catch(async () => {
      // If it's not an input, try to get text content
      return await clientIdElement.textContent();
    });

    // Alternative: look for the Client ID in a specific section
    if (!clientId || clientId.length < 10) {
      const clientIdText = await page.locator('dt:has-text("Client ID")').locator('..').locator('dd').first().textContent();
      clientId = clientIdText.trim();
    }

    console.log(`Client ID found: ${clientId}`);

    // Step 6: Generate Client Secret
    console.log('Generating Client Secret...');

    // Click "Generate a new client secret" button
    const generateSecretButton = page.locator('button:has-text("Generate a new client secret"), a:has-text("Generate a new client secret")').first();
    await generateSecretButton.click();

    await page.waitForTimeout(2000);
    console.log('Taking screenshot of generated secret...');
    await page.screenshot({ path: 'screenshots/github_oauth_5_secret_generated.png' });

    // Step 7: Copy the Client Secret IMMEDIATELY (only shown once!)
    console.log('⚠️ CRITICAL: Copying Client Secret (only shown once!)...');

    // The secret is usually shown in a flash message or a specific element
    const clientSecretElement = await page.locator('input[name="oauth_application[client_secret]"], code.oauth-secret, div.flash-full code').first();
    const clientSecret = await clientSecretElement.textContent().catch(async () => {
      return await clientSecretElement.inputValue();
    });

    console.log(`Client Secret captured: ${clientSecret.substring(0, 10)}...`);

    // Step 8: Save credentials to file
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

    // Wait a bit before closing so user can see the result
    await page.waitForTimeout(3000);

    await browser.close();

    return credentials;

  } catch (error) {
    console.error('❌ Error creating OAuth App:', error);
    await page.screenshot({ path: 'screenshots/github_oauth_error.png' });
    await browser.close();
    throw error;
  }
}

// Run the script
createGitHubOAuthApp()
  .then(credentials => {
    console.log('\n✅ SUCCESS! GitHub OAuth App created.');
    console.log('\nNext steps:');
    console.log('1. Configure Vercel environment variables');
    console.log('2. Deploy to production');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ FAILED:', error.message);
    process.exit(1);
  });
