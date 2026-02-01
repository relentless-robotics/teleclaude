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
  const filepath = path.join(SCREENSHOTS_DIR, `v8_${name}_${Date.now()}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
  return filepath;
}

// Comprehensive Google auth handler
async function handleAuth(page) {
  const url = page.url();
  const pageText = await page.textContent('body').catch(() => '');

  // Check various states
  console.log(`Auth check - URL: ${url.substring(0, 60)}...`);

  // State 1: Choose an account
  if (pageText.includes('Choose an account')) {
    console.log('>>> Account chooser detected');
    try {
      // Click on the account with relentlessrobotics email
      const accountItems = await page.$$('[data-email], [role="link"]');
      for (const item of accountItems) {
        const text = await item.textContent().catch(() => '');
        if (text.includes('relentlessrobotics')) {
          await item.click();
          console.log('Clicked account');
          await sleep(3000);
          return 'account_selected';
        }
      }
      // Fallback: click text directly
      await page.click('text=relentlessrobotics@gmail.com');
      await sleep(3000);
      return 'account_selected';
    } catch (e) {
      console.log('Account click error:', e.message);
    }
  }

  // State 2: Password entry (Hi [Name] / Enter your password)
  if (pageText.includes('Enter your password') || pageText.includes('Hi ') && url.includes('accounts.google.com')) {
    console.log('>>> Password screen detected');
    try {
      // Find the password input - it should be visible
      const passwordInput = await page.$('input[type="password"], input[name="Passwd"], input[aria-label*="password"]');
      if (passwordInput) {
        const isVisible = await passwordInput.isVisible();
        console.log(`Password input visible: ${isVisible}`);
        if (isVisible) {
          await passwordInput.fill('Relaxing41!');
          console.log('Password entered');
          await sleep(500);

          // Click Next
          await page.click('button:has-text("Next"), #passwordNext');
          console.log('Clicked Next');
          await sleep(5000);
          return 'password_entered';
        }
      }
    } catch (e) {
      console.log('Password entry error:', e.message);
    }
  }

  // State 3: Email entry
  if (url.includes('accounts.google.com/v3/signin/identifier') || pageText.includes('Sign in') && pageText.includes('Email or phone')) {
    console.log('>>> Email entry screen detected');
    try {
      await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
      await sleep(500);
      await page.click('#identifierNext');
      await sleep(3000);
      return 'email_entered';
    } catch (e) {
      console.log('Email entry error:', e.message);
    }
  }

  // State 4: 2FA prompt
  if (pageText.includes('2-Step Verification') || pageText.includes('Verify it')) {
    console.log('>>> 2FA REQUIRED - Waiting for user approval...');
    return '2fa_needed';
  }

  return null;
}

// Handle ToS
async function handleToS(page) {
  const pageText = await page.textContent('body').catch(() => '');
  if (!pageText.includes('Terms of Service') || !pageText.includes('I agree')) {
    return false;
  }

  console.log('>>> ToS dialog detected');

  try {
    // Click checkbox
    await page.click('mat-checkbox', { force: true });
    await sleep(500);
  } catch (e) {}

  try {
    await page.click('button:has-text("Agree and continue"):not([disabled])');
    await sleep(3000);
    return true;
  } catch (e) {}

  return false;
}

// Main navigation loop
async function navigateWithAuth(page, targetUrl, targetIndicator) {
  console.log(`\nNavigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(2000);

    const currentUrl = page.url();
    const pageText = await page.textContent('body').catch(() => '');

    // Check if we reached target
    if (currentUrl.includes(targetIndicator) && !currentUrl.includes('accounts.google.com')) {
      console.log('Reached target page');
      return true;
    }

    // Handle auth
    if (currentUrl.includes('accounts.google.com')) {
      const result = await handleAuth(page);
      if (result === '2fa_needed') {
        console.log('WAITING FOR 2FA APPROVAL...');
        await sleep(30000);  // Wait 30 sec for 2FA
      }
      continue;
    }

    // Handle ToS
    if (pageText.includes('Terms of Service') && pageText.includes('I agree')) {
      await handleToS(page);
      continue;
    }

    // No action needed
    break;
  }

  return false;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup v8 (Robust Auth Handling) ===\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    storageState: fs.existsSync(STORAGE_STATE) ? STORAGE_STATE : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    // Step 1: Go to credentials page
    console.log('STEP 1: Navigate to Cloud Console');
    await navigateWithAuth(page, 'https://console.cloud.google.com/apis/credentials', 'apis/credentials');
    await screenshot(page, '01_credentials');

    // Check if we need to create/select project
    let pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('Select a project') || !pageText.includes('Create credentials')) {
      console.log('\nSTEP 1b: Setting up project...');
      await navigateWithAuth(page, 'https://console.cloud.google.com/projectcreate', 'projectcreate');
      await screenshot(page, '02_project');

      const nameInput = await page.$('input[aria-label*="Project name"]');
      if (nameInput) {
        await nameInput.fill('TeleClaude-Gmail');
        await page.click('button:has-text("Create")');
        console.log('Project creation started');
        await sleep(15000);
      }
    }

    // Step 2: Enable Gmail API
    console.log('\nSTEP 2: Enable Gmail API');
    await navigateWithAuth(page, 'https://console.cloud.google.com/apis/library/gmail.googleapis.com', 'gmail.googleapis');
    await screenshot(page, '03_gmail_api');

    try {
      const enableBtn = await page.$('button:has-text("Enable")');
      if (enableBtn && await enableBtn.isVisible()) {
        await enableBtn.click();
        console.log('Gmail API enabled');
        await sleep(5000);
      }
    } catch (e) {}

    // Step 3: OAuth consent
    console.log('\nSTEP 3: OAuth Consent Screen');
    await navigateWithAuth(page, 'https://console.cloud.google.com/apis/credentials/consent', 'credentials/consent');
    await screenshot(page, '04_consent');

    pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('External') && pageText.includes('Internal') && pageText.includes('User Type')) {
      await page.click('text=External');
      await page.click('button:has-text("Create")');
      await sleep(3000);

      // Fill form
      try { await page.fill('input[formcontrolname="displayName"]', 'TeleClaude Gmail'); } catch (e) {}

      const emailInputs = await page.$$('input[type="email"]');
      for (const i of emailInputs) { try { await i.fill('relentlessrobotics@gmail.com'); } catch (e) {} }

      for (let i = 0; i < 5; i++) {
        try { await page.click('button:has-text("Save and Continue")'); await sleep(3000); } catch (e) { break; }
      }
    }
    await screenshot(page, '05_consent_done');

    // Step 4: Create credentials
    console.log('\nSTEP 4: Create OAuth Credentials');
    await navigateWithAuth(page, 'https://console.cloud.google.com/apis/credentials', 'apis/credentials');
    await screenshot(page, '06_credentials_page');

    await page.click('button:has-text("Create credentials")');
    await sleep(1500);
    await page.click('text=OAuth client ID');
    await sleep(3000);
    await screenshot(page, '07_oauth_type');

    // Select Desktop app
    try {
      await page.click('mat-select');
      await sleep(500);
      await page.click('text=Desktop app');
      await sleep(1000);
    } catch (e) {}

    try { await page.fill('input[formcontrolname="name"]', 'TeleClaude Desktop'); } catch (e) {}

    await page.click('button:has-text("Create")');
    await sleep(5000);
    await screenshot(page, '08_created');

    // Extract credentials
    console.log('\nSTEP 5: Extract Credentials');
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

      console.log('\n============= SUCCESS =============');
      console.log('Client ID:', idMatch[1]);
      console.log('Secret:', secretMatch[1].substring(0, 15) + '...');
      console.log('Saved to:', credPath);
      console.log('\nRun next: node utils/gmail_init.js');
      console.log('====================================');

      await context.storageState({ path: STORAGE_STATE });
      await screenshot(page, '09_success');
      return { success: true };
    }

    console.log('\nCould not extract credentials. Check browser.');
    await screenshot(page, '09_manual');
    await sleep(300000);

  } catch (error) {
    console.error('\nError:', error.message);
    await screenshot(page, 'error');
    await sleep(300000);
  } finally {
    await browser.close();
  }
}

setupGmailOAuth().catch(console.error);
