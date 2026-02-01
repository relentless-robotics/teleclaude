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
  const filepath = path.join(SCREENSHOTS_DIR, `v7_${name}_${Date.now()}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
  return filepath;
}

// Handle various Google auth screens
async function handleGoogleAuth(page) {
  const url = page.url();
  const pageText = await page.textContent('body').catch(() => '');

  // Account chooser screen
  if (pageText.includes('Choose an account') || pageText.includes('Use another account')) {
    console.log('Account chooser detected...');

    // Click on the relentlessrobotics account
    try {
      await page.click('text=relentlessrobotics@gmail.com');
      console.log('Clicked on account');
      await sleep(3000);
      return true;
    } catch (e) {
      // Try clicking the first account option
      try {
        const accounts = await page.$$('[data-identifier], [data-email]');
        if (accounts.length > 0) {
          await accounts[0].click();
          console.log('Clicked first account');
          await sleep(3000);
          return true;
        }
      } catch (e2) {}
    }
  }

  // Email input screen
  if (url.includes('accounts.google.com') && await page.$('input[type="email"]')) {
    console.log('Email input detected...');
    await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
    await sleep(500);
    await page.click('#identifierNext');
    await sleep(3000);
    return true;
  }

  // Password input screen
  if (await page.$('input[type="password"]:visible')) {
    console.log('Password input detected...');
    await page.fill('input[type="password"]', 'Relaxing41!');
    await sleep(500);
    await page.click('#passwordNext');
    await sleep(5000);
    return true;
  }

  return false;
}

// Handle ToS checkbox
async function handleToS(page) {
  const pageText = await page.textContent('body').catch(() => '');
  if (!pageText.includes('Terms of Service') || !pageText.includes('I agree')) {
    return false;
  }

  console.log('ToS dialog detected...');

  // Click checkbox using bounding box
  try {
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      const box = await checkbox.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(1000);
      }
    }
  } catch (e) {}

  // Click mat-checkbox
  try {
    await page.click('mat-checkbox', { force: true });
    await sleep(500);
  } catch (e) {}

  // Click agree button
  try {
    await page.click('button:has-text("Agree and continue"):not([disabled])');
    await sleep(3000);
    return true;
  } catch (e) {}

  return false;
}

// Wait for page to stabilize and handle any auth/ToS screens
async function waitAndHandle(page, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);

    const url = page.url();
    console.log(`Check ${i + 1}: ${url.substring(0, 80)}...`);

    // If we're on the target page, we're done
    if (url.includes('console.cloud.google.com/apis')) {
      return true;
    }

    // Handle auth screens
    if (url.includes('accounts.google.com')) {
      const handled = await handleGoogleAuth(page);
      if (handled) continue;
    }

    // Handle ToS
    const tosHandled = await handleToS(page);
    if (tosHandled) continue;
  }
  return false;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup v7 (With Account Chooser) ===\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    storageState: fs.existsSync(STORAGE_STATE) ? STORAGE_STATE : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    // Step 1: Navigate to credentials page
    console.log('Step 1: Navigating to Google Cloud Console...');
    await page.goto('https://console.cloud.google.com/apis/credentials', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await screenshot(page, '01_initial');

    // Handle auth flow
    console.log('Handling authentication...');
    const reachedTarget = await waitAndHandle(page);
    await screenshot(page, '02_after_auth');

    if (!reachedTarget) {
      console.log('Still not on target page, continuing anyway...');
    }

    // Check for project selection
    const pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('Select a project') || !pageText.includes('Create credentials')) {
      console.log('\nNeed to set up project...');

      // Go to project creation
      await page.goto('https://console.cloud.google.com/projectcreate');
      await sleep(5000);
      await waitAndHandle(page, 5);
      await screenshot(page, '03_project_create');

      // Fill project name
      const nameInput = await page.$('input[aria-label*="Project name"], input[placeholder*="project name"]');
      if (nameInput) {
        await nameInput.fill('TeleClaude-Gmail');
        await sleep(500);

        await page.click('button:has-text("Create")');
        console.log('Creating project...');
        await sleep(15000);  // Project creation takes time
      }
      await screenshot(page, '04_project_created');
    }

    // Enable Gmail API
    console.log('\nStep 2: Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    await sleep(5000);
    await waitAndHandle(page, 5);
    await screenshot(page, '05_gmail_api');

    try {
      const enableBtn = await page.$('button:has-text("Enable")');
      if (enableBtn && await enableBtn.isVisible()) {
        await enableBtn.click();
        console.log('Enabled Gmail API');
        await sleep(5000);
      }
    } catch (e) {}

    // OAuth consent screen
    console.log('\nStep 3: Setting up OAuth consent...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent');
    await sleep(5000);
    await waitAndHandle(page, 5);
    await screenshot(page, '06_consent');

    const consentText = await page.textContent('body').catch(() => '');
    if (consentText.includes('External') && consentText.includes('Internal') && consentText.includes('User Type')) {
      await page.click('text=External');
      await sleep(500);
      await page.click('button:has-text("Create")');
      await sleep(3000);

      // Fill app info
      try {
        await page.fill('input[formcontrolname="displayName"]', 'TeleClaude Gmail');
      } catch (e) {}

      const emailInputs = await page.$$('input[type="email"]');
      for (const input of emailInputs) {
        try { await input.fill('relentlessrobotics@gmail.com'); } catch (e) {}
      }

      // Save and continue
      for (let i = 0; i < 5; i++) {
        try {
          await page.click('button:has-text("Save and Continue")');
          await sleep(3000);
        } catch (e) { break; }
      }
    }
    await screenshot(page, '07_consent_done');

    // Create OAuth credentials
    console.log('\nStep 4: Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials');
    await sleep(5000);
    await waitAndHandle(page, 5);
    await screenshot(page, '08_credentials');

    // Click Create credentials
    await page.click('button:has-text("Create credentials")');
    await sleep(1500);
    await page.click('text=OAuth client ID');
    await sleep(3000);
    await screenshot(page, '09_oauth_form');

    // Select Desktop app
    try {
      await page.click('mat-select, [role="combobox"]');
      await sleep(500);
      await page.click('mat-option:has-text("Desktop"), text=Desktop app');
      await sleep(1000);
    } catch (e) {
      console.log('App type selection issue:', e.message);
    }

    // Name
    try {
      await page.fill('input[formcontrolname="name"]', 'TeleClaude Desktop');
    } catch (e) {}

    await screenshot(page, '10_oauth_filled');

    // Create
    await page.click('button:has-text("Create")');
    await sleep(5000);
    await screenshot(page, '11_oauth_created');

    // Extract credentials
    console.log('\nStep 5: Extracting credentials...');
    const bodyText = await page.textContent('body');

    const idMatch = bodyText.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = bodyText.match(/(GOCSPX-[A-Za-z0-9_-]+)/);

    if (idMatch && secretMatch) {
      const credentials = {
        installed: {
          client_id: idMatch[1],
          project_id: 'teleclaude-gmail',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
          auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
          client_secret: secretMatch[1],
          redirect_uris: ['http://localhost']
        }
      };

      const credPath = path.join(__dirname, 'secure', 'gmail_credentials.json');
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2));

      console.log('\n============ SUCCESS ============');
      console.log('Client ID:', idMatch[1]);
      console.log('Client Secret:', secretMatch[1].substring(0, 15) + '...');
      console.log('Saved to:', credPath);
      console.log('\nNext: node utils/gmail_init.js');
      console.log('==================================');

      // Save updated storage state
      await context.storageState({ path: STORAGE_STATE });

      await screenshot(page, '12_success');
      return { success: true };
    }

    console.log('\nCredentials not found on page.');
    console.log('Browser staying open for manual completion...');
    await screenshot(page, '12_manual');
    await sleep(300000);

  } catch (error) {
    console.error('\nError:', error.message);
    await screenshot(page, 'error');
    console.log('Browser staying open...');
    await sleep(300000);
  } finally {
    await browser.close();
  }
}

setupGmailOAuth().catch(console.error);
