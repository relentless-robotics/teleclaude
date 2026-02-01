const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const STORAGE_STATE = path.join(__dirname, 'browser_state', 'google_auth.json');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'gmail_setup');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms + Math.random() * 300));
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOTS_DIR, `v6_${name}_${Date.now()}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
  return filepath;
}

// Check if we're on a login page and re-authenticate if needed
async function handleLoginIfNeeded(page) {
  const url = page.url();
  if (!url.includes('accounts.google.com/v3/signin') && !url.includes('accounts.google.com/signin')) {
    return false;
  }

  console.log('Login required, authenticating...');

  try {
    // Check if email field is visible
    const emailField = await page.$('input[type="email"]');
    if (emailField) {
      await emailField.fill('relentlessrobotics@gmail.com');
      await sleep(500);
      await page.click('#identifierNext');
      await sleep(3000);
    }

    // Check if password field is visible
    const passwordField = await page.$('input[type="password"]');
    if (passwordField) {
      await passwordField.fill('Relaxing41!');
      await sleep(500);
      await page.click('#passwordNext');
      await sleep(5000);
    }

    // Wait for redirect
    await sleep(5000);
    return true;
  } catch (e) {
    console.log('Login handling error:', e.message);
    return false;
  }
}

// Handle ToS checkbox with multiple approaches
async function handleToS(page) {
  const pageText = await page.textContent('body').catch(() => '');
  if (!pageText.includes('Terms of Service') || !pageText.includes('I agree')) {
    return false;
  }

  console.log('ToS dialog detected, attempting to accept...');

  // Approach 1: Click the checkbox using bounding box
  try {
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      const box = await checkbox.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        console.log('Clicked checkbox via bounding box');
        await sleep(1000);
      }
    }
  } catch (e) {}

  // Approach 2: Click mat-checkbox component
  try {
    const matCheckbox = await page.$('mat-checkbox');
    if (matCheckbox) {
      await matCheckbox.click({ force: true });
      console.log('Clicked mat-checkbox');
      await sleep(1000);
    }
  } catch (e) {}

  // Approach 3: Use keyboard
  try {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await sleep(100);
    }
    await page.keyboard.press('Space');
    console.log('Used keyboard Tab+Space');
    await sleep(500);
  } catch (e) {}

  // Now click Agree button
  try {
    const agreeBtn = await page.$('button:has-text("Agree and continue")');
    if (agreeBtn) {
      const isEnabled = await agreeBtn.isEnabled();
      if (isEnabled) {
        await agreeBtn.click();
        console.log('Clicked Agree button');
        await sleep(3000);
        return true;
      }
    }
  } catch (e) {}

  return false;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup v6 (Using Saved Auth State) ===\n');

  // Check if storage state exists
  if (!fs.existsSync(STORAGE_STATE)) {
    console.error('ERROR: google_auth.json not found!');
    console.log('Run: node browser_state/google_auth_script.js first');
    return;
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  // Create context WITH the saved storage state
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    storageState: STORAGE_STATE,  // <-- This loads all the saved cookies!
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Anti-detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  try {
    // Go directly to credentials page (we should already be logged in via cookies)
    console.log('Step 1: Going to Cloud Console credentials page...');
    await page.goto('https://console.cloud.google.com/apis/credentials', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(5000);
    await screenshot(page, '01_credentials');

    // Handle login if session expired
    await handleLoginIfNeeded(page);
    await handleToS(page);

    // Check if we need to select/create a project
    const pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('Select a project') || pageText.includes('No project selected')) {
      console.log('\nNeed to select/create project first...');

      // Try clicking project selector
      try {
        await page.click('[aria-label*="Select a project"], button:has-text("Select a project")');
        await sleep(2000);

        // Click New Project or select existing
        const newProjectBtn = await page.$('button:has-text("New Project")');
        if (newProjectBtn) {
          await newProjectBtn.click();
          await sleep(3000);
          await handleToS(page);

          // Fill project name
          const nameInput = await page.$('input[aria-label*="Project name"]');
          if (nameInput) {
            await nameInput.fill('TeleClaude-Gmail');
            await sleep(1000);
            await page.click('button:has-text("Create")');
            await sleep(10000);
          }
        }
      } catch (e) {
        console.log('Project selection error:', e.message);
      }
    }

    await screenshot(page, '02_after_project');

    // Ensure Gmail API is enabled
    console.log('\nStep 2: Checking Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com', {
      waitUntil: 'domcontentloaded'
    });
    await sleep(5000);
    await handleLoginIfNeeded(page);
    await handleToS(page);

    try {
      const enableBtn = await page.$('button:has-text("Enable")');
      if (enableBtn) {
        const isVisible = await enableBtn.isVisible();
        if (isVisible) {
          await enableBtn.click();
          console.log('Enabled Gmail API');
          await sleep(5000);
        }
      }
    } catch (e) {}

    await screenshot(page, '03_gmail_api');

    // Configure OAuth consent if needed
    console.log('\nStep 3: Checking OAuth consent...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent', {
      waitUntil: 'domcontentloaded'
    });
    await sleep(5000);
    await handleLoginIfNeeded(page);
    await handleToS(page);
    await screenshot(page, '04_consent');

    // Check if consent needs setup
    const consentText = await page.textContent('body').catch(() => '');
    if (consentText.includes('External') && consentText.includes('Internal')) {
      console.log('Setting up OAuth consent...');
      await page.click('text=External');
      await sleep(500);
      await page.click('button:has-text("Create")');
      await sleep(3000);

      // Fill form
      const appNameInput = await page.$('input[formcontrolname="displayName"]');
      if (appNameInput) await appNameInput.fill('TeleClaude Gmail');

      const emailInputs = await page.$$('input[type="email"]');
      for (const input of emailInputs) {
        try { await input.fill('relentlessrobotics@gmail.com'); } catch (e) {}
      }

      // Save and continue through steps
      for (let i = 0; i < 5; i++) {
        try {
          await page.click('button:has-text("Save and Continue")');
          await sleep(3000);
        } catch (e) { break; }
      }
    }

    await screenshot(page, '05_after_consent');

    // Now create OAuth credentials
    console.log('\nStep 4: Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials', {
      waitUntil: 'domcontentloaded'
    });
    await sleep(5000);
    await handleLoginIfNeeded(page);
    await handleToS(page);
    await screenshot(page, '06_credentials_page');

    // Click Create Credentials > OAuth client ID
    await page.click('button:has-text("Create credentials")');
    await sleep(1500);
    await page.click('text=OAuth client ID');
    await sleep(3000);
    await screenshot(page, '07_oauth_form');

    // Select Desktop app type
    try {
      await page.click('mat-select');
      await sleep(500);
      await page.click('text=Desktop app');
      await sleep(1000);
    } catch (e) {
      console.log('App type selection error:', e.message);
    }

    // Name it
    const nameInput = await page.$('input[formcontrolname="name"]');
    if (nameInput) {
      await nameInput.fill('TeleClaude Desktop');
      await sleep(500);
    }

    await screenshot(page, '08_oauth_filled');

    // Click Create
    await page.click('button:has-text("Create")');
    await sleep(5000);
    await screenshot(page, '09_oauth_created');

    // Extract credentials from the dialog
    console.log('\nStep 5: Extracting credentials...');
    const bodyText = await page.textContent('body');

    const idMatch = bodyText.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = bodyText.match(/(GOCSPX-[A-Za-z0-9_-]+)/);

    if (idMatch && secretMatch) {
      const clientId = idMatch[1];
      const clientSecret = secretMatch[1];

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
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2));

      console.log('\n========== SUCCESS ==========');
      console.log('Client ID:', clientId);
      console.log('Client Secret:', clientSecret.substring(0, 15) + '...');
      console.log('Credentials saved to:', credPath);
      console.log('\nNext step: node utils/gmail_init.js');
      console.log('==============================');

      await screenshot(page, '10_success');

      // Save updated storage state
      await context.storageState({ path: STORAGE_STATE });
      console.log('Storage state updated');

      return { success: true, clientId };
    }

    console.log('\nCould not extract credentials. Check screenshots.');
    console.log('Browser staying open for manual completion...');
    await screenshot(page, '10_manual_needed');
    await sleep(300000);

  } catch (error) {
    console.error('\nError:', error.message);
    await screenshot(page, 'error');
    console.log('Browser staying open for manual intervention...');
    await sleep(300000);
  } finally {
    await browser.close();
  }
}

setupGmailOAuth().catch(console.error);
