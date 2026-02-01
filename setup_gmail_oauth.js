const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_STATE = 'C:/Users/Footb/Documents/Github/teleclaude-main/browser_state/google_auth.json';
const CREDENTIALS_PATH = 'C:/Users/Footb/Documents/Github/teleclaude-main/secure/gmail_credentials.json';

// Discord notification helper
async function notifyDiscord(message) {
  console.log(`[DISCORD] ${message}`);
  // The send_to_discord calls will be made by the main bridge
  // This script just logs progress
}

async function setupGmailOAuth() {
  let browser, context, page;

  try {
    await notifyDiscord('🚀 Launching browser with saved Google auth...');

    // Launch browser
    browser = await chromium.launch({
      headless: false,
      channel: 'msedge'
    });

    // Create context with saved auth
    if (fs.existsSync(AUTH_STATE)) {
      context = await browser.newContext({
        storageState: AUTH_STATE
      });
      await notifyDiscord('✅ Loaded saved Google authentication');
    } else {
      context = await browser.newContext();
      await notifyDiscord('⚠️ No saved auth found, will need to login');
    }

    page = await context.newPage();
    page.setDefaultTimeout(60000); // 60 second timeout

    // Step 1: Navigate to Google Cloud Console
    await notifyDiscord('📍 Step 1/6: Navigating to Google Cloud Console...');
    await page.goto('https://console.cloud.google.com', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000); // Let page fully load

    // Take screenshot
    await page.screenshot({ path: './screenshots/gcp_1_console.png' });

    // Step 2: Create new project
    await notifyDiscord('📍 Step 2/6: Creating new project "TeleClaude Gmail"...');

    // Click on project dropdown - try multiple selectors
    const projectSelectors = [
      'button[aria-label*="Select a project"]',
      '[data-ng-if="showProjectPicker"]',
      'button:has-text("Select a project")',
      '.cfc-project-picker-button'
    ];

    let projectDropdownClicked = false;
    for (const selector of projectSelectors) {
      try {
        await page.click(selector, { timeout: 10000 });
        projectDropdownClicked = true;
        await notifyDiscord('✅ Opened project dropdown');
        break;
      } catch (e) {
        console.log(`Selector failed: ${selector}`);
      }
    }

    if (!projectDropdownClicked) {
      // Try direct navigation to new project page
      await notifyDiscord('⚠️ Dropdown failed, using direct URL...');
      await page.goto('https://console.cloud.google.com/projectcreate', { waitUntil: 'networkidle' });
    } else {
      await page.waitForTimeout(2000);

      // Click "New Project"
      const newProjectSelectors = [
        'text=New Project',
        'button:has-text("New Project")',
        'a:has-text("New Project")',
        '[aria-label="New Project"]'
      ];

      for (const selector of newProjectSelectors) {
        try {
          await page.click(selector, { timeout: 5000 });
          await notifyDiscord('✅ Clicked New Project');
          break;
        } catch (e) {
          console.log(`New Project selector failed: ${selector}`);
        }
      }
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: './screenshots/gcp_2_new_project.png' });

    // Fill in project name
    const projectNameSelectors = [
      'input[name="projectId"]',
      'input[aria-label*="Project name"]',
      'input[placeholder*="project name"]',
      '#projectname'
    ];

    for (const selector of projectNameSelectors) {
      try {
        await page.fill(selector, 'TeleClaude Gmail', { timeout: 5000 });
        await notifyDiscord('✅ Entered project name');
        break;
      } catch (e) {
        console.log(`Project name selector failed: ${selector}`);
      }
    }

    await page.waitForTimeout(2000);

    // Click Create
    const createSelectors = [
      'button:has-text("Create")',
      'button[aria-label="Create"]',
      'button[type="submit"]'
    ];

    for (const selector of createSelectors) {
      try {
        await page.click(selector, { timeout: 5000 });
        await notifyDiscord('✅ Clicked Create project button');
        break;
      } catch (e) {
        console.log(`Create button selector failed: ${selector}`);
      }
    }

    // Wait for project creation
    await notifyDiscord('⏳ Waiting for project creation (may take 30-60 seconds)...');
    await page.waitForTimeout(15000);
    await page.screenshot({ path: './screenshots/gcp_3_project_creating.png' });

    // Step 3: Enable Gmail API
    await notifyDiscord('📍 Step 3/6: Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: './screenshots/gcp_4_gmail_api.png' });

    // Click Enable
    const enableSelectors = [
      'button:has-text("Enable")',
      'button[aria-label="Enable"]',
      '[aria-label*="Enable"]'
    ];

    for (const selector of enableSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click();
          await notifyDiscord('✅ Clicked Enable Gmail API');
          break;
        }
      } catch (e) {
        console.log(`Enable button selector failed: ${selector}`);
      }
    }

    await page.waitForTimeout(10000); // Wait for API to enable
    await page.screenshot({ path: './screenshots/gcp_5_api_enabled.png' });

    // Step 4: Configure OAuth Consent Screen
    await notifyDiscord('📍 Step 4/6: Configuring OAuth consent screen...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: './screenshots/gcp_6_consent_screen.png' });

    // Select External user type (if not already configured)
    try {
      const externalRadio = await page.$('input[value="EXTERNAL"]');
      if (externalRadio) {
        await externalRadio.click();
        await notifyDiscord('✅ Selected External user type');
      }

      // Click Create
      await page.click('button:has-text("Create")', { timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {
      await notifyDiscord('ℹ️ OAuth consent may already be configured, continuing...');
    }

    await page.screenshot({ path: './screenshots/gcp_7_consent_form.png' });

    // Fill in OAuth consent form
    const appNameSelectors = [
      'input[name="displayName"]',
      'input[aria-label*="App name"]',
      '#appName'
    ];

    for (const selector of appNameSelectors) {
      try {
        await page.fill(selector, 'TeleClaude Gmail', { timeout: 5000 });
        await notifyDiscord('✅ Entered app name');
        break;
      } catch (e) {
        console.log(`App name selector failed: ${selector}`);
      }
    }

    // Fill in support email (should auto-fill with logged in account)
    const supportEmailSelectors = [
      'input[name="supportEmail"]',
      'select[aria-label*="support email"]'
    ];

    for (const selector of supportEmailSelectors) {
      try {
        const field = await page.$(selector);
        if (field) {
          const tagName = await field.evaluate(el => el.tagName);
          if (tagName === 'SELECT') {
            await page.selectOption(selector, { index: 0 });
          } else {
            await page.fill(selector, 'relentlessrobotics@gmail.com');
          }
          await notifyDiscord('✅ Set support email');
          break;
        }
      } catch (e) {
        console.log(`Support email selector failed: ${selector}`);
      }
    }

    // Fill in developer contact email
    const devEmailSelectors = [
      'input[name="developerEmail"]',
      'input[aria-label*="developer contact"]'
    ];

    for (const selector of devEmailSelectors) {
      try {
        await page.fill(selector, 'relentlessrobotics@gmail.com', { timeout: 5000 });
        await notifyDiscord('✅ Set developer contact email');
        break;
      } catch (e) {
        console.log(`Developer email selector failed: ${selector}`);
      }
    }

    await page.waitForTimeout(2000);
    await page.screenshot({ path: './screenshots/gcp_8_consent_filled.png' });

    // Click Save and Continue
    const saveSelectors = [
      'button:has-text("Save and Continue")',
      'button:has-text("Save")',
      'button[type="submit"]'
    ];

    for (const selector of saveSelectors) {
      try {
        await page.click(selector, { timeout: 5000 });
        await notifyDiscord('✅ Saved OAuth consent screen');
        break;
      } catch (e) {
        console.log(`Save button selector failed: ${selector}`);
      }
    }

    await page.waitForTimeout(5000);

    // Click through scopes page (Save and Continue)
    try {
      await page.click('button:has-text("Save and Continue")', { timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('No scopes page or already passed');
    }

    // Add test user
    try {
      await page.click('button:has-text("Add Users")', { timeout: 5000 });
      await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
      await page.click('button:has-text("Add")');
      await notifyDiscord('✅ Added test user');
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log('Test user section not found or already configured');
    }

    // Final save
    try {
      await page.click('button:has-text("Save and Continue")', { timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('Final save not needed');
    }

    await page.screenshot({ path: './screenshots/gcp_9_consent_complete.png' });

    // Step 5: Create OAuth Credentials
    await notifyDiscord('📍 Step 5/6: Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: './screenshots/gcp_10_credentials_page.png' });

    // Click Create Credentials
    await page.click('button:has-text("Create Credentials")', { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Click OAuth client ID
    await page.click('text=OAuth client ID', { timeout: 5000 });
    await notifyDiscord('✅ Selected OAuth client ID');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: './screenshots/gcp_11_oauth_type.png' });

    // Select Desktop app
    const appTypeSelectors = [
      'select[aria-label*="Application type"]',
      'select[name="applicationType"]',
      '#application-type'
    ];

    for (const selector of appTypeSelectors) {
      try {
        await page.selectOption(selector, { label: 'Desktop app' });
        await notifyDiscord('✅ Selected Desktop app type');
        break;
      } catch (e) {
        console.log(`App type selector failed: ${selector}`);
      }
    }

    await page.waitForTimeout(2000);

    // Enter name
    const credNameSelectors = [
      'input[name="displayName"]',
      'input[aria-label*="Name"]',
      'input[placeholder*="name"]'
    ];

    for (const selector of credNameSelectors) {
      try {
        await page.fill(selector, 'TeleClaude Desktop', { timeout: 5000 });
        await notifyDiscord('✅ Entered credential name');
        break;
      } catch (e) {
        console.log(`Credential name selector failed: ${selector}`);
      }
    }

    await page.waitForTimeout(2000);
    await page.screenshot({ path: './screenshots/gcp_12_oauth_form.png' });

    // Click Create
    await page.click('button:has-text("Create")', { timeout: 5000 });
    await notifyDiscord('✅ Creating OAuth credentials...');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: './screenshots/gcp_13_oauth_created.png' });

    // Step 6: Download or extract credentials
    await notifyDiscord('📍 Step 6/6: Extracting OAuth credentials...');

    // Try to extract from the modal
    let clientId = null;
    let clientSecret = null;

    try {
      // Look for client ID in the page
      const idElements = await page.$$('text=/[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com/');
      if (idElements.length > 0) {
        clientId = await idElements[0].textContent();
        await notifyDiscord(`✅ Found Client ID: ${clientId.substring(0, 20)}...`);
      }

      // Look for client secret
      const secretElements = await page.$$('code');
      for (const el of secretElements) {
        const text = await el.textContent();
        if (text && text.length > 20 && text.includes('-')) {
          clientSecret = text;
          await notifyDiscord(`✅ Found Client Secret: ${clientSecret.substring(0, 10)}...`);
          break;
        }
      }
    } catch (e) {
      console.log('Could not extract credentials from modal');
    }

    // If extraction failed, try downloading
    if (!clientId || !clientSecret) {
      await notifyDiscord('⚠️ Extraction failed, attempting download...');

      try {
        // Click download button
        const downloadSelectors = [
          'button[aria-label*="Download"]',
          'a[download]',
          'text=Download JSON'
        ];

        for (const selector of downloadSelectors) {
          try {
            await page.click(selector, { timeout: 5000 });
            await notifyDiscord('✅ Clicked download button');
            break;
          } catch (e) {
            console.log(`Download selector failed: ${selector}`);
          }
        }

        await page.waitForTimeout(5000);
      } catch (e) {
        console.log('Download failed');
      }
    }

    // Create credentials JSON manually if we got the values
    if (clientId && clientSecret) {
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

      // Ensure secure directory exists
      const secureDir = path.dirname(CREDENTIALS_PATH);
      if (!fs.existsSync(secureDir)) {
        fs.mkdirSync(secureDir, { recursive: true });
      }

      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
      await notifyDiscord(`✅ Saved credentials to ${CREDENTIALS_PATH}`);
    }

    await page.screenshot({ path: './screenshots/gcp_14_final.png' });

    await notifyDiscord('✅ Google Cloud Console setup complete!');

    // Check if credentials file exists
    if (fs.existsSync(CREDENTIALS_PATH)) {
      await notifyDiscord('✅ Credentials file verified!');
      await notifyDiscord('📝 Next step: Run gmail_init.js to complete OAuth flow');
      return true;
    } else {
      await notifyDiscord('⚠️ Credentials file not found. Please check screenshots and extract manually.');
      await notifyDiscord('📸 Screenshots saved to ./screenshots/gcp_*.png');
      return false;
    }

  } catch (error) {
    await notifyDiscord(`❌ Error: ${error.message}`);
    console.error(error);

    if (page) {
      await page.screenshot({ path: './screenshots/gcp_error.png' });
      await notifyDiscord('📸 Error screenshot saved to ./screenshots/gcp_error.png');
    }

    return false;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run the setup
setupGmailOAuth().then(success => {
  console.log(success ? 'Setup completed successfully' : 'Setup failed');
  process.exit(success ? 0 : 1);
});
