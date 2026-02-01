const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_STATE = 'C:/Users/Footb/Documents/Github/teleclaude-main/browser_state/google_auth.json';
const CREDENTIALS_PATH = 'C:/Users/Footb/Documents/Github/teleclaude-main/secure/gmail_credentials.json';

async function log(message) {
  console.log(message);
}

async function setupGmailOAuthAuto() {
  let browser, context, page;

  try {
    await log('🚀 Launching browser...');

    browser = await chromium.launch({
      headless: false,
      channel: 'msedge',
      args: ['--start-maximized']
    });

    // Create context with saved auth
    if (fs.existsSync(AUTH_STATE)) {
      context = await browser.newContext({
        storageState: AUTH_STATE,
        viewport: null
      });
      await log('✅ Loaded saved Google authentication');
    } else {
      context = await browser.newContext({ viewport: null });
      await log('⚠️ No saved auth found');
    }

    page = await context.newPage();
    page.setDefaultTimeout(30000);

    // Step 1: Navigate to GCP
    await log('📍 Step 1: Navigating to Google Cloud Console...');
    await page.goto('https://console.cloud.google.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // Handle account chooser if it appears
    try {
      const accountButton = await page.waitForSelector('text=relentlessrobotics@gmail.com', { timeout: 5000 });
      if (accountButton) {
        await log('✅ Clicking account: relentlessrobotics@gmail.com');
        await accountButton.click();
        await page.waitForTimeout(5000);
      }
    } catch (e) {
      await log('ℹ️ No account chooser or already logged in');
    }

    // Wait for console to load
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: './screenshots/gcp_console.png', fullPage: true });

    // Step 2: Check if project already exists, or create new one
    await log('📍 Step 2: Checking for existing project...');

    // Try to go directly to credentials page - if it works, project exists
    try {
      await page.goto('https://console.cloud.google.com/apis/credentials', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(3000);

      const pageText = await page.textContent('body');
      if (pageText.includes('TeleClaude') || pageText.includes('Gmail')) {
        await log('✅ Found existing project!');
      } else {
        throw new Error('No project found, will create');
      }
    } catch (e) {
      await log('Creating new project...');

      await page.goto('https://console.cloud.google.com/projectcreate', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      // Find and fill project name field
      const projectNameInput = await page.waitForSelector('input[type="text"]', { timeout: 10000 });
      await projectNameInput.fill('TeleClaude-Gmail-' + Date.now());
      await log('✅ Entered project name');

      await page.waitForTimeout(1000);

      // Click create button
      const createButton = await page.waitForSelector('button[type="submit"], button:has-text("Create")', { timeout: 5000 });
      await createButton.click();
      await log('✅ Clicked Create');

      // Wait for project creation (this can take a while)
      await log('⏳ Waiting for project creation (30 seconds)...');
      await page.waitForTimeout(30000);
    }

    // Step 3: Enable Gmail API
    await log('📍 Step 3: Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    try {
      const enableButton = await page.waitForSelector('button:has-text("Enable"), button:has-text("ENABLE")', { timeout: 5000 });
      await enableButton.click();
      await log('✅ Clicked Enable');
      await page.waitForTimeout(10000); // Wait for API to enable
    } catch (e) {
      await log('ℹ️ Gmail API may already be enabled');
    }

    await page.screenshot({ path: './screenshots/gcp_api_enabled.png', fullPage: true });

    // Step 4: Configure OAuth Consent Screen
    await log('📍 Step 4: Configuring OAuth consent screen...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    const pageText = await page.textContent('body');

    if (pageText.includes('External') && pageText.includes('Internal')) {
      // Need to configure consent screen
      await log('Setting up OAuth consent for first time...');

      try {
        // Select External
        const externalRadio = await page.waitForSelector('input[value="EXTERNAL"]', { timeout: 5000 });
        await externalRadio.click();
        await page.waitForTimeout(1000);

        const createButton = await page.waitForSelector('button:has-text("Create")', { timeout: 5000 });
        await createButton.click();
        await page.waitForTimeout(3000);

        // Fill in app name
        const inputs = await page.$$('input[type="text"]');
        for (const input of inputs) {
          const label = await input.evaluate(el => {
            const labels = el.labels;
            return labels && labels[0] ? labels[0].textContent : '';
          });

          if (label.toLowerCase().includes('app name') || label.toLowerCase().includes('application name')) {
            await input.fill('TeleClaude Gmail');
            await log('✅ Filled app name');
            break;
          }
        }

        await page.waitForTimeout(2000);
        await page.screenshot({ path: './screenshots/gcp_consent_form.png', fullPage: true });

        // Click Save and Continue
        const saveButtons = await page.$$('button:has-text("Save"), button:has-text("Continue")');
        if (saveButtons.length > 0) {
          await saveButtons[0].click();
          await log('✅ Saved consent screen');
          await page.waitForTimeout(3000);
        }

        // Skip through remaining pages
        for (let i = 0; i < 3; i++) {
          try {
            const nextButton = await page.waitForSelector('button:has-text("Save and Continue"), button:has-text("Continue")', { timeout: 3000 });
            await nextButton.click();
            await page.waitForTimeout(2000);
          } catch (e) {
            break;
          }
        }

      } catch (e) {
        await log(`⚠️ Consent screen setup issue: ${e.message}`);
      }
    } else {
      await log('✅ OAuth consent screen already configured');
    }

    // Step 5: Create OAuth Credentials
    await log('📍 Step 5: Creating OAuth client ID...');
    await page.goto('https://console.cloud.google.com/apis/credentials/oauthclient', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: './screenshots/gcp_oauth_page.png', fullPage: true });

    // Select application type (Desktop app)
    try {
      const appTypeSelect = await page.waitForSelector('select, [role="combobox"]', { timeout: 5000 });
      await appTypeSelect.click();
      await page.waitForTimeout(1000);

      // Try to find Desktop app option
      const desktopOption = await page.waitForSelector('text="Desktop app", [data-value="Desktop"], option:has-text("Desktop")', { timeout: 5000 });
      await desktopOption.click();
      await log('✅ Selected Desktop app type');
      await page.waitForTimeout(1000);
    } catch (e) {
      await log(`⚠️ Could not select app type: ${e.message}`);
    }

    // Enter name
    try {
      const nameInputs = await page.$$('input[type="text"]');
      for (const input of nameInputs) {
        const value = await input.inputValue();
        if (!value || value === '') {
          await input.fill('TeleClaude Desktop');
          await log('✅ Entered credential name');
          break;
        }
      }
      await page.waitForTimeout(1000);
    } catch (e) {
      await log(`⚠️ Could not enter name: ${e.message}`);
    }

    await page.screenshot({ path: './screenshots/gcp_oauth_filled.png', fullPage: true });

    // Click Create
    try {
      const createButton = await page.waitForSelector('button:has-text("Create"), button[type="submit"]', { timeout: 5000 });
      await createButton.click();
      await log('✅ Clicked Create credentials');
      await page.waitForTimeout(5000);
    } catch (e) {
      await log(`⚠️ Could not click create: ${e.message}`);
    }

    // Step 6: Extract credentials from modal
    await log('📍 Step 6: Extracting credentials...');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: './screenshots/gcp_credentials_modal.png', fullPage: true });

    // Get page content
    const htmlContent = await page.content();

    // Extract client ID
    const clientIdMatch = htmlContent.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const clientId = clientIdMatch ? clientIdMatch[1] : null;

    // Extract client secret (format: GOCSPX-...)
    const clientSecretMatch = htmlContent.match(/GOCSPX-[a-zA-Z0-9_-]+/);
    const clientSecret = clientSecretMatch ? clientSecretMatch[0] : null;

    if (!clientId || !clientSecret) {
      // Try alternative extraction from elements
      const codeElements = await page.$$('code, pre, input[readonly], div[role="textbox"]');
      for (const el of codeElements) {
        const text = await el.textContent();

        if (text && text.includes('.apps.googleusercontent.com') && !clientId) {
          clientId = text.trim();
        }
        if (text && text.startsWith('GOCSPX-') && !clientSecret) {
          clientSecret = text.trim();
        }
      }
    }

    if (clientId && clientSecret) {
      await log(`✅ Client ID: ${clientId.substring(0, 30)}...`);
      await log(`✅ Client Secret: ${clientSecret.substring(0, 15)}...`);

      // Create credentials JSON
      const credentials = {
        installed: {
          client_id: clientId,
          project_id: "teleclaude-gmail",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
          auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
          client_secret: clientSecret,
          redirect_uris: ["http://localhost"]
        }
      };

      // Save credentials
      const secureDir = path.dirname(CREDENTIALS_PATH);
      if (!fs.existsSync(secureDir)) {
        fs.mkdirSync(secureDir, { recursive: true });
      }

      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
      await log(`\n✅ Credentials saved to: ${CREDENTIALS_PATH}`);

      await log('\n🎉 Setup complete!');
      await log('\n📝 Next step: Run gmail_init.js to complete OAuth flow');

      await page.waitForTimeout(3000);
      await browser.close();
      return true;

    } else {
      await log('\n⚠️ Could not extract credentials automatically');
      await log('📸 Check screenshots in ./screenshots/gcp_*.png');
      await log('\nPlease manually extract Client ID and Client Secret from the modal');

      // Keep browser open for manual extraction
      await log('\nBrowser will stay open. Press Ctrl+C when done.');
      await page.waitForTimeout(300000); // Wait 5 minutes

      return false;
    }

  } catch (error) {
    await log(`\n❌ Error: ${error.message}`);
    console.error(error);

    if (page) {
      await page.screenshot({ path: './screenshots/gcp_final_error.png', fullPage: true });
    }

    return false;
  }
}

setupGmailOAuthAuto().then(success => {
  console.log(success ? '\n✅ Automation completed' : '\n❌ Automation failed');
  process.exit(success ? 0 : 1);
});
