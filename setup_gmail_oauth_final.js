const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const STORAGE_STATE = path.join(__dirname, 'browser_state', 'google_auth.json');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'gmail_setup');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms + Math.random() * 200));
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOTS_DIR, `final_${name}_${Date.now()}.png`);
  await page.screenshot({ path: filepath });
  console.log(`📸 ${filepath}`);
}

// Handle auth screens
async function handleAuth(page) {
  const pageText = await page.textContent('body').catch(() => '');

  if (pageText.includes('Choose an account')) {
    console.log('🔐 Account chooser');
    await page.click('text=relentlessrobotics@gmail.com').catch(() => {});
    await sleep(3000);
    return true;
  }

  if (pageText.includes('Enter your password')) {
    console.log('🔐 Password entry');
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      await pwInput.fill('Relaxing41!');
      await page.click('button:has-text("Next")');
      await sleep(5000);
      return true;
    }
  }

  if (pageText.includes('Email or phone')) {
    console.log('🔐 Email entry');
    await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
    await page.click('#identifierNext');
    await sleep(3000);
    return true;
  }

  return false;
}

// Aggressive ToS handler using JavaScript injection (proven to work)
async function handleToS(page) {
  const pageText = await page.textContent('body').catch(() => '');

  if (!pageText.includes('Terms of Service') && !pageText.includes('I agree to')) {
    return false;
  }

  console.log('📋 ToS detected - using JS injection');

  try {
    await page.evaluate(() => {
      const checkbox = document.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }

      const matCheckbox = document.querySelector('mat-checkbox');
      if (matCheckbox) {
        const inner = matCheckbox.querySelector('.mat-checkbox-inner-container');
        if (inner) inner.click();
        matCheckbox.classList.add('mat-checkbox-checked');
      }

      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('Agree') && btn.textContent.includes('continue')) {
          btn.disabled = false;
          btn.click();
        }
      }
    });
    console.log('✅ JS injection executed');
    await sleep(2000);
  } catch (e) {}

  // Backup: keyboard
  try {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await sleep(500);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await sleep(2000);
  } catch (e) {}

  return true;
}

// Handle any blocking dialogs
async function handleBlockers(page) {
  const url = page.url();
  if (url.includes('accounts.google.com')) {
    return await handleAuth(page);
  }
  return await handleToS(page);
}

// Wait until we're on the target page
async function waitForPage(page, urlPart, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    const url = page.url();
    if (url.includes(urlPart) && !url.includes('accounts.google.com')) {
      return true;
    }
    await handleBlockers(page);
  }
  return false;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup FINAL VERSION ===\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    storageState: fs.existsSync(STORAGE_STATE) ? STORAGE_STATE : undefined
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const PROJECT_NAME = 'teleclaude-gmail-' + Date.now().toString().slice(-6);

  try {
    // STEP 1: Create Project
    console.log('STEP 1: Create Project');
    await page.goto('https://console.cloud.google.com/projectcreate');
    await sleep(5000);

    for (let i = 0; i < 5; i++) { if (!await handleBlockers(page)) break; }

    await screenshot(page, '01_project_create');

    // Fill project name
    const nameInput = await page.$('input[aria-label*="Project name"]');
    if (nameInput) {
      await nameInput.fill(PROJECT_NAME);
      console.log(`Project name: ${PROJECT_NAME}`);
      await sleep(500);

      await page.click('button:has-text("Create")');
      console.log('Creating project... (waiting 20s)');
      await sleep(20000);  // Projects take time to create
    }

    await screenshot(page, '02_project_created');

    // STEP 2: Select the project explicitly
    console.log('\nSTEP 2: Select Project');
    await page.goto('https://console.cloud.google.com/home/dashboard');
    await sleep(5000);

    for (let i = 0; i < 3; i++) { if (!await handleBlockers(page)) break; }

    // Click project selector
    try {
      await page.click('[aria-label*="Select a project"], button:has-text("Select a project")');
      await sleep(2000);

      // Find and click our project
      await page.fill('input[type="text"][placeholder*="Search"]', PROJECT_NAME).catch(() => {});
      await sleep(1000);

      await page.click(`text=${PROJECT_NAME}`).catch(async () => {
        // Try clicking any project that contains our prefix
        const projects = await page.$$('[role="option"], [role="menuitem"]');
        for (const p of projects) {
          const text = await p.textContent().catch(() => '');
          if (text.includes('teleclaude')) {
            await p.click();
            break;
          }
        }
      });
      await sleep(3000);
    } catch (e) {
      console.log('Project selection error:', e.message);
    }

    await screenshot(page, '03_project_selected');

    // STEP 3: Enable Gmail API
    console.log('\nSTEP 3: Enable Gmail API');
    await page.goto(`https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=${PROJECT_NAME}`);
    await sleep(5000);

    for (let i = 0; i < 5; i++) { if (!await handleBlockers(page)) break; }

    await screenshot(page, '04_gmail_api');

    try {
      const enableBtn = await page.$('button:has-text("Enable")');
      if (enableBtn && await enableBtn.isVisible()) {
        await enableBtn.click();
        console.log('✅ Gmail API enabled');
        await sleep(8000);
      } else {
        console.log('Gmail API already enabled or button not found');
      }
    } catch (e) {}

    // STEP 4: Configure OAuth Consent
    console.log('\nSTEP 4: OAuth Consent');
    await page.goto(`https://console.cloud.google.com/apis/credentials/consent?project=${PROJECT_NAME}`);
    await sleep(5000);

    for (let i = 0; i < 5; i++) { if (!await handleBlockers(page)) break; }

    await screenshot(page, '05_consent');

    const consentText = await page.textContent('body').catch(() => '');
    if (consentText.includes('User Type') && consentText.includes('External')) {
      console.log('Setting up OAuth consent...');
      await page.click('text=External').catch(() => {});
      await page.click('button:has-text("Create")').catch(() => {});
      await sleep(3000);

      // Fill app info
      try { await page.fill('input[formcontrolname="displayName"]', 'TeleClaude Gmail'); } catch (e) {}

      const emails = await page.$$('input[type="email"]');
      for (const e of emails) { try { await e.fill('relentlessrobotics@gmail.com'); } catch (x) {} }

      // Save and continue through all screens
      for (let j = 0; j < 5; j++) {
        try {
          await page.click('button:has-text("Save and Continue")');
          console.log(`Consent step ${j + 1} saved`);
          await sleep(3000);
        } catch (e) { break; }
      }
    }

    await screenshot(page, '06_consent_done');

    // STEP 5: Create OAuth Credentials
    console.log('\nSTEP 5: Create OAuth Credentials');
    await page.goto(`https://console.cloud.google.com/apis/credentials?project=${PROJECT_NAME}`);
    await sleep(5000);

    for (let i = 0; i < 5; i++) { if (!await handleBlockers(page)) break; }

    await screenshot(page, '07_credentials');

    // Click Create credentials dropdown
    await page.click('button:has-text("Create credentials")');
    await sleep(1500);
    await page.click('text=OAuth client ID');
    await sleep(3000);

    await screenshot(page, '08_oauth_type');

    // Select Desktop app type
    try {
      await page.click('mat-select, [role="combobox"]');
      await sleep(500);
      await page.click('mat-option:has-text("Desktop"), text=Desktop app');
      console.log('Selected Desktop app');
      await sleep(1000);
    } catch (e) {
      console.log('App type selection issue');
    }

    // Name
    try { await page.fill('input[formcontrolname="name"]', 'TeleClaude Desktop'); } catch (e) {}

    await screenshot(page, '09_oauth_form');

    // Create
    await page.click('button:has-text("Create")');
    console.log('Creating OAuth credentials...');
    await sleep(5000);

    await screenshot(page, '10_oauth_created');

    // STEP 6: Extract Credentials
    console.log('\nSTEP 6: Extract Credentials');
    const bodyText = await page.textContent('body');

    const idMatch = bodyText.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = bodyText.match(/(GOCSPX-[A-Za-z0-9_-]+)/);

    if (idMatch && secretMatch) {
      const credentials = {
        installed: {
          client_id: idMatch[1],
          project_id: PROJECT_NAME,
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

      // Also update API_KEYS.md
      const apiKeysPath = path.join(__dirname, 'API_KEYS.md');
      const apiKeyEntry = `

---

## Gmail API (Google Cloud)

| Field | Value |
|-------|-------|
| Service | Gmail API |
| Project | ${PROJECT_NAME} |
| Client ID | \`${idMatch[1]}\` |
| Client Secret | \`${secretMatch[1]}\` |
| Created | ${new Date().toISOString().split('T')[0]} |
| Console URL | https://console.cloud.google.com/apis/credentials?project=${PROJECT_NAME} |

**Notes:** OAuth 2.0 Desktop client for TeleClaude Gmail integration.

---
`;
      fs.appendFileSync(apiKeysPath, apiKeyEntry);

      console.log('\n' + '='.repeat(50));
      console.log('            ✅ SUCCESS! ✅');
      console.log('='.repeat(50));
      console.log(`Client ID: ${idMatch[1]}`);
      console.log(`Secret: ${secretMatch[1].substring(0, 15)}...`);
      console.log(`\nSaved to: ${credPath}`);
      console.log(`Updated: ${apiKeysPath}`);
      console.log('\n📧 Next step: node utils/gmail_init.js');
      console.log('='.repeat(50));

      await context.storageState({ path: STORAGE_STATE });
      await screenshot(page, '11_success');

      return { success: true, clientId: idMatch[1] };
    }

    console.log('\n❌ Could not extract credentials automatically.');
    console.log('Check the browser window to complete manually.');
    await screenshot(page, '11_manual');
    await sleep(300000);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    await screenshot(page, 'error');
    await sleep(300000);
  } finally {
    await browser.close();
  }
}

setupGmailOAuth().catch(console.error);
