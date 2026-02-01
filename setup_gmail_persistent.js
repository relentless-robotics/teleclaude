const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.join(__dirname, 'browser_profile_google');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'gmail_setup');

// Ensure directories exist
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms + Math.random() * 500));
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOTS_DIR, `${name}_${Date.now()}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
  return filepath;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup with Persistent Profile ===');
  console.log('Using Edge browser with persistent profile');
  console.log('If 2FA is needed, approve on your phone');
  console.log('');

  // Launch with persistent context - like a real browser profile
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'msedge',
    viewport: { width: 1400, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
    ]
  });

  const page = await context.newPage();

  try {
    // Step 1: Go to Google Cloud Console
    console.log('Step 1: Navigating to Google Cloud Console...');
    await page.goto('https://console.cloud.google.com', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(3000);
    await screenshot(page, '01_initial');

    // Check current state
    const url = page.url();
    console.log('Current URL:', url);

    // If on login page, handle login
    if (url.includes('accounts.google.com') || url.includes('signin')) {
      console.log('Login required. Attempting to log in...');

      // Wait for email input
      await page.waitForSelector('input[type="email"]', { timeout: 30000 });
      await sleep(1000);

      // Type email slowly like a human
      const email = 'relentlessrobotics@gmail.com';
      await page.click('input[type="email"]');
      await sleep(500);

      for (const char of email) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
      }
      await sleep(1000);
      await screenshot(page, '02_email_entered');

      // Click Next
      await page.click('#identifierNext');
      await sleep(3000);
      await screenshot(page, '03_after_email_next');

      // Wait for password field
      try {
        await page.waitForSelector('input[type="password"]', { timeout: 15000 });
        await sleep(1000);

        // Type password slowly
        const password = 'Relaxing41!';
        await page.click('input[type="password"]');
        await sleep(500);

        for (const char of password) {
          await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
        }
        await sleep(1000);
        await screenshot(page, '04_password_entered');

        // Click Sign In
        await page.click('#passwordNext');
        await sleep(5000);
        await screenshot(page, '05_after_password');

      } catch (e) {
        console.log('Password field not found - may need different flow or 2FA');
        await screenshot(page, '04_alt_flow');
      }

      // Wait for potential 2FA or redirect
      console.log('Waiting for login to complete (check phone for 2FA if prompted)...');
      await sleep(10000);
      await screenshot(page, '06_after_login_wait');
    }

    // Check if we made it to Cloud Console
    const currentUrl = page.url();
    console.log('After login URL:', currentUrl);

    if (!currentUrl.includes('console.cloud.google.com')) {
      console.log('Not on Cloud Console yet. Waiting longer...');
      await page.waitForURL('**/console.cloud.google.com/**', { timeout: 120000 });
    }

    await screenshot(page, '07_cloud_console');
    console.log('Successfully reached Cloud Console!');

    // Step 2: Create Project
    console.log('Step 2: Creating project...');
    // Click project dropdown
    await page.click('[aria-label*="Select a project"], [data-name="Projects"]', { timeout: 10000 }).catch(() => {});
    await sleep(2000);
    await screenshot(page, '08_project_dropdown');

    // Click New Project
    await page.click('text=New Project', { timeout: 10000 }).catch(() => {});
    await sleep(2000);
    await screenshot(page, '09_new_project');

    // Fill project name
    const projectNameInput = await page.$('input[aria-label*="Project name"], #projectName');
    if (projectNameInput) {
      await projectNameInput.fill('TeleClaude-Gmail');
      await sleep(1000);
      await screenshot(page, '10_project_name');

      // Click Create
      await page.click('button:has-text("Create")');
      await sleep(5000);
      await screenshot(page, '11_project_created');
    }

    // Step 3: Enable Gmail API
    console.log('Step 3: Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    await sleep(3000);
    await screenshot(page, '12_gmail_api_page');

    // Click Enable
    await page.click('button:has-text("Enable")').catch(() => {});
    await sleep(5000);
    await screenshot(page, '13_gmail_enabled');

    // Step 4: OAuth Consent Screen
    console.log('Step 4: Configuring OAuth consent...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent');
    await sleep(3000);
    await screenshot(page, '14_consent_screen');

    // Select External (or Internal if available)
    await page.click('text=External').catch(() => page.click('text=Internal'));
    await sleep(1000);
    await page.click('button:has-text("Create")').catch(() => {});
    await sleep(3000);
    await screenshot(page, '15_consent_type');

    // Fill App Name
    await page.fill('input[formcontrolname="displayName"], input[aria-label*="App name"]', 'TeleClaude Gmail').catch(() => {});
    await sleep(500);

    // Fill Support Email
    await page.fill('input[formcontrolname="email"], input[aria-label*="email"]', 'relentlessrobotics@gmail.com').catch(() => {});
    await sleep(500);
    await screenshot(page, '16_consent_filled');

    // Save and continue through screens
    for (let i = 0; i < 4; i++) {
      await page.click('button:has-text("Save and Continue"), button:has-text("Save")').catch(() => {});
      await sleep(2000);
    }
    await screenshot(page, '17_consent_done');

    // Step 5: Create OAuth Credentials
    console.log('Step 5: Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials');
    await sleep(3000);
    await screenshot(page, '18_credentials_page');

    // Click Create Credentials
    await page.click('button:has-text("Create credentials")');
    await sleep(1000);
    await page.click('text=OAuth client ID');
    await sleep(2000);
    await screenshot(page, '19_create_oauth');

    // Select Desktop app
    await page.click('mat-select, [role="listbox"]').catch(() => {});
    await sleep(500);
    await page.click('text=Desktop app').catch(() => {});
    await sleep(1000);

    // Name it
    await page.fill('input[formcontrolname="name"], input[aria-label*="Name"]', 'TeleClaude Desktop').catch(() => {});
    await sleep(500);
    await screenshot(page, '20_oauth_config');

    // Click Create
    await page.click('button:has-text("Create")');
    await sleep(3000);
    await screenshot(page, '21_oauth_created');

    // Get the credentials
    console.log('Step 6: Extracting credentials...');
    const clientIdElement = await page.$('text=/[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com/');
    const clientSecretElement = await page.$('text=/GOCSPX-[A-Za-z0-9_-]+/');

    let clientId = '';
    let clientSecret = '';

    if (clientIdElement) {
      clientId = await clientIdElement.textContent();
      console.log('Client ID:', clientId);
    }

    if (clientSecretElement) {
      clientSecret = await clientSecretElement.textContent();
      console.log('Client Secret:', clientSecret.substring(0, 10) + '...');
    }

    // Try clicking Download JSON
    await page.click('button:has-text("Download JSON"), button[aria-label*="Download"]').catch(async () => {
      console.log('Could not click download, trying to copy credentials manually...');

      // Get all text on page to find credentials
      const pageText = await page.textContent('body');
      const idMatch = pageText.match(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/);
      const secretMatch = pageText.match(/GOCSPX-[A-Za-z0-9_-]+/);

      if (idMatch) clientId = idMatch[0];
      if (secretMatch) clientSecret = secretMatch[0];
    });

    await screenshot(page, '22_final');

    // Save credentials
    if (clientId && clientSecret) {
      const credentials = {
        installed: {
          client_id: clientId,
          project_id: 'teleclaude-gmail',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
          auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
          client_secret: clientSecret,
          redirect_uris: ['http://localhost']
        }
      };

      const credPath = path.join(__dirname, 'secure', 'gmail_credentials.json');
      if (!fs.existsSync(path.dirname(credPath))) {
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
      }
      fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2));
      console.log('Credentials saved to:', credPath);

      // Notify Discord
      console.log('\n=== SUCCESS ===');
      console.log('Gmail OAuth credentials saved!');
      console.log('Run: node utils/gmail_init.js to complete authorization');
    } else {
      console.log('Could not extract credentials automatically.');
      console.log('Check the screenshots and browser for the Client ID and Secret.');
    }

    // Keep browser open for manual inspection
    console.log('\nBrowser will stay open for 2 minutes for manual verification...');
    await sleep(120000);

  } catch (error) {
    console.error('Error:', error.message);
    await screenshot(page, 'error');

    console.log('\nBrowser staying open for manual completion...');
    console.log('Please complete the setup manually if automation failed.');
    await sleep(300000); // 5 minutes
  } finally {
    await context.close();
  }
}

setupGmailOAuth();
