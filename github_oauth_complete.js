/**
 * Complete GitHub OAuth App Setup
 *
 * This script handles the entire flow:
 * 1. Login to GitHub with saved credentials
 * 2. Navigate to OAuth Apps
 * 3. Check if TeleClaude Dashboard already exists
 * 4. If not, create it
 * 5. Extract Client ID and Secret
 * 6. Save to file
 */

const { launchStealthBrowser } = require('./captcha-lab/solver/stealth-browser.js');
const fs = require('fs');
const path = require('path');

async function completeGitHubOAuthSetup() {
  const { browser, context, page } = await launchStealthBrowser({ headless: false });

  try {
    console.log('\n=== GitHub OAuth App Complete Setup ===\n');

    // Step 1: Login to GitHub
    console.log('Step 1: Logging into GitHub...');
    await page.goto('https://github.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(2000);

    // Fill login form
    await page.fill('input#login_field', 'relentless-robotics');
    await page.waitForTimeout(500);
    await page.fill('input#password', 'Relentless@Robotics2026!');
    await page.waitForTimeout(500);

    // Click Sign In
    await page.click('input[type="submit"][value="Sign in"]');
    await page.waitForTimeout(4000);

    // Check for 2FA
    const has2FA = await page.locator('input#app_otp, input#otp').isVisible().catch(() => false);

    if (has2FA) {
      console.log('\n⚠️  2FA Required!');
      console.log('Please approve on your phone/device...');
      console.log('Waiting up to 2 minutes...\n');

      // Wait for navigation after 2FA
      await page.waitForNavigation({ timeout: 120000 }).catch(() => {
        console.log('2FA timeout - continuing anyway...');
      });
      await page.waitForTimeout(2000);
    }

    console.log('✅ Logged in successfully\n');

    // Step 2: Navigate to OAuth Apps
    console.log('Step 2: Navigating to OAuth Apps...');
    await page.goto('https://github.com/settings/developers', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(3000);

    // Take screenshot
    const screenshotDir = path.join(__dirname, 'screenshots', 'oauth');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const beforeScreenshot = path.join(screenshotDir, `oauth_apps_page_${Date.now()}.png`);
    await page.screenshot({ path: beforeScreenshot, fullPage: true });
    console.log('Screenshot saved:', beforeScreenshot);

    // Step 3: Check if TeleClaude Dashboard already exists
    console.log('\nStep 3: Checking for existing TeleClaude Dashboard app...');

    const appLinkSelector = 'a[href*="/settings/applications/"]:has-text("TeleClaude Dashboard")';
    const appExists = await page.locator(appLinkSelector).count() > 0;

    let appUrl = null;

    if (appExists) {
      console.log('✅ TeleClaude Dashboard app found!');
      console.log('Navigating to existing app...');

      // Click on the app
      await page.click(appLinkSelector);
      await page.waitForTimeout(3000);

      appUrl = page.url();
    } else {
      console.log('❌ TeleClaude Dashboard app not found');
      console.log('Creating new OAuth app...\n');

      // Step 4: Create new OAuth App
      console.log('Step 4: Creating OAuth App...');

      // Click "New OAuth App"
      await page.click('a:has-text("New OAuth App"), button:has-text("New OAuth App")');
      await page.waitForTimeout(2000);

      // Fill in the form
      console.log('Filling out form...');
      await page.fill('input#oauth_application_name', 'TeleClaude Dashboard');
      await page.waitForTimeout(300);

      await page.fill('input#oauth_application_url', 'https://dashboard-app-black-kappa.vercel.app');
      await page.waitForTimeout(300);

      // Description (if available)
      const descExists = await page.locator('textarea#oauth_application_description').isVisible().catch(() => false);
      if (descExists) {
        await page.fill('textarea#oauth_application_description', 'Authentication for TeleClaude Dashboard');
        await page.waitForTimeout(300);
      }

      await page.fill('input#oauth_application_callback_url', 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github');
      await page.waitForTimeout(300);

      // Take screenshot of filled form
      const formScreenshot = path.join(screenshotDir, `form_filled_${Date.now()}.png`);
      await page.screenshot({ path: formScreenshot, fullPage: true });
      console.log('Form screenshot:', formScreenshot);

      // Submit
      await page.click('button[type="submit"]:has-text("Register application")');
      await page.waitForTimeout(4000);

      // Wait for redirect to app page
      await page.waitForURL('**/settings/applications/**', { timeout: 15000 });

      appUrl = page.url();
      console.log('✅ OAuth app created!\n');
    }

    // Step 5: Extract Client ID
    console.log('Step 5: Extracting Client ID...');
    await page.waitForTimeout(2000);

    // Take screenshot of app details page
    const detailsScreenshot = path.join(screenshotDir, `app_details_${Date.now()}.png`);
    await page.screenshot({ path: detailsScreenshot, fullPage: true });
    console.log('Details screenshot:', detailsScreenshot);

    // Try multiple selectors for Client ID
    let clientId = null;
    const clientIdSelectors = [
      'code:has-text("Ov")',
      '[data-targets*="client-id"]',
      'input[readonly][value^="Ov"]',
      'dd code',
      '.application-id code'
    ];

    for (const selector of clientIdSelectors) {
      try {
        const element = page.locator(selector).first();
        const isVisible = await element.isVisible({ timeout: 2000 });
        if (isVisible) {
          clientId = await element.innerText().catch(() => element.inputValue());
          if (clientId && clientId.startsWith('Ov')) {
            console.log('✅ Found Client ID with selector:', selector);
            break;
          }
        }
      } catch (e) {
        // Try next selector
      }
    }

    if (!clientId) {
      console.log('\n⚠️  Could not automatically extract Client ID');
      console.log('Please look at the browser window and find the Client ID (starts with "Ov")');
      console.log('Screenshot saved to:', detailsScreenshot);
      console.log('\nPress Ctrl+C and use the manual script instead.\n');

      // Keep browser open
      console.log('Keeping browser open for 5 minutes...');
      await page.waitForTimeout(300000);
      await browser.close();
      return null;
    }

    console.log('Client ID:', clientId);

    // Step 6: Generate Client Secret (if needed)
    console.log('\nStep 6: Checking for Client Secret...');

    // Check if we need to generate a new secret
    const generateButton = page.locator('button:has-text("Generate a new client secret")');
    const hasGenerateButton = await generateButton.isVisible().catch(() => false);

    let clientSecret = null;

    if (hasGenerateButton) {
      console.log('Generating new client secret...');
      await generateButton.click();
      await page.waitForTimeout(3000);

      // Try to find the secret
      const secretSelectors = [
        'input[type="text"][value^="gho_"]',
        'code:has-text("gho_")',
        '.client-secret-value',
        '[data-target*="client-secret"]'
      ];

      for (const selector of secretSelectors) {
        try {
          const element = page.locator(selector).first();
          const isVisible = await element.isVisible({ timeout: 2000 });
          if (isVisible) {
            clientSecret = await element.inputValue().catch(() => element.innerText());
            if (clientSecret && clientSecret.startsWith('gho_')) {
              console.log('✅ Found Client Secret');
              break;
            }
          }
        } catch (e) {
          // Try next selector
        }
      }

      // Take screenshot with secret visible
      const secretScreenshot = path.join(screenshotDir, `secret_generated_${Date.now()}.png`);
      await page.screenshot({ path: secretScreenshot, fullPage: true });
      console.log('Secret screenshot:', secretScreenshot);

      if (!clientSecret) {
        console.log('\n⚠️  Could not automatically extract Client Secret');
        console.log('Please copy it from the browser window (starts with "gho_")');
        console.log('Screenshot saved to:', secretScreenshot);
        console.log('\nKeeping browser open for 5 minutes...');
        await page.waitForTimeout(300000);
        await browser.close();
        return null;
      }
    } else {
      console.log('\n⚠️  No "Generate" button found');
      console.log('You may need to manually generate a client secret');
      console.log('Look in the browser window and click "Generate a new client secret"');
      console.log('\nKeeping browser open for 5 minutes...');
      await page.waitForTimeout(300000);
      await browser.close();
      return null;
    }

    // Step 7: Save credentials
    console.log('\nStep 7: Saving credentials...');

    const credentialsFile = path.join(__dirname, 'github_oauth_credentials.json');
    const credentials = {
      clientId,
      clientSecret,
      appName: 'TeleClaude Dashboard',
      homepageUrl: 'https://dashboard-app-black-kappa.vercel.app',
      callbackUrl: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
      appUrl,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2));
    console.log('✅ Credentials saved to:', credentialsFile);

    console.log('\n' + '='.repeat(60));
    console.log('SUCCESS! GitHub OAuth App Setup Complete');
    console.log('='.repeat(60));
    console.log('\nClient ID:', clientId);
    console.log('Client Secret:', clientSecret.substring(0, 20) + '...(hidden)');
    console.log('\nNext: Run configure_vercel_only.js to deploy\n');

    await browser.close();
    return credentials;

  } catch (error) {
    console.error('\n❌ Error:', error);
    console.log('\nTaking error screenshot...');

    try {
      const errorScreenshot = path.join(__dirname, 'screenshots', 'oauth', `error_${Date.now()}.png`);
      await page.screenshot({ path: errorScreenshot, fullPage: true });
      console.log('Error screenshot:', errorScreenshot);
    } catch (e) {
      // Ignore screenshot error
    }

    console.log('\nKeeping browser open for inspection...');
    await page.waitForTimeout(60000);
    await browser.close();
    throw error;
  }
}

async function main() {
  try {
    const credentials = await completeGitHubOAuthSetup();

    if (credentials) {
      console.log('\n✅ All done! Now run:');
      console.log(`\nnode configure_vercel_only.js ${credentials.clientId} ${credentials.clientSecret}\n`);
    } else {
      console.log('\n⚠️  Manual intervention needed. Check browser window.\n');
    }
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { completeGitHubOAuthSetup };
