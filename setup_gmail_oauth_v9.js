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
  const filepath = path.join(SCREENSHOTS_DIR, `v9_${name}_${Date.now()}.png`);
  await page.screenshot({ path: filepath });
  console.log(`Screenshot: ${filepath}`);
}

// Handle auth
async function handleAuth(page) {
  const url = page.url();
  const pageText = await page.textContent('body').catch(() => '');

  if (pageText.includes('Choose an account')) {
    console.log('>>> Account chooser');
    await page.click('text=relentlessrobotics@gmail.com').catch(() => {});
    await sleep(3000);
    return true;
  }

  if (pageText.includes('Enter your password')) {
    console.log('>>> Password entry');
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      await pwInput.fill('Relaxing41!');
      await page.click('button:has-text("Next")');
      await sleep(5000);
      return true;
    }
  }

  if (pageText.includes('Email or phone')) {
    console.log('>>> Email entry');
    await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
    await page.click('#identifierNext');
    await sleep(3000);
    return true;
  }

  return false;
}

// AGGRESSIVE ToS handler using JavaScript injection
async function handleToSAggressive(page) {
  const pageText = await page.textContent('body').catch(() => '');

  if (!pageText.includes('Terms of Service') && !pageText.includes('I agree to')) {
    return false;
  }

  console.log('>>> ToS detected - using aggressive JS approach');

  // Method 1: JavaScript to check the checkbox and enable button
  try {
    const result = await page.evaluate(() => {
      // Find and check checkbox
      const checkbox = document.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        checkbox.dispatchEvent(new Event('input', { bubbles: true }));

        // Also trigger click event
        const clickEvent = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true
        });
        checkbox.dispatchEvent(clickEvent);
      }

      // Find mat-checkbox and click its inner container
      const matCheckbox = document.querySelector('mat-checkbox');
      if (matCheckbox) {
        const inner = matCheckbox.querySelector('.mat-checkbox-inner-container');
        if (inner) inner.click();
        matCheckbox.classList.add('mat-checkbox-checked');
      }

      // Find and click agree button
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('Agree') && btn.textContent.includes('continue')) {
          btn.disabled = false;
          btn.click();
          return 'clicked_button';
        }
      }

      return 'checkbox_toggled';
    });
    console.log('JS result:', result);
    await sleep(2000);
  } catch (e) {
    console.log('JS approach error:', e.message);
  }

  // Method 2: Direct mouse click on checkbox coordinates
  try {
    // Find the checkbox's bounding box
    const checkbox = await page.$('mat-checkbox, input[type="checkbox"]');
    if (checkbox) {
      const box = await checkbox.boundingBox();
      if (box) {
        // Click the center of the checkbox
        await page.mouse.click(box.x + 10, box.y + 10);
        console.log(`Clicked at (${box.x + 10}, ${box.y + 10})`);
        await sleep(1000);
      }
    }
  } catch (e) {}

  // Method 3: Keyboard navigation
  try {
    // Tab to checkbox and press space
    await page.keyboard.press('Tab');
    await sleep(100);
    await page.keyboard.press('Tab');
    await sleep(100);
    await page.keyboard.press('Space');
    console.log('Tab+Space pressed');
    await sleep(500);

    // Tab to button and press Enter
    await page.keyboard.press('Tab');
    await sleep(100);
    await page.keyboard.press('Enter');
    console.log('Enter pressed');
    await sleep(2000);
  } catch (e) {}

  // Method 4: Click the text label area
  try {
    await page.click('text=I agree to the', { force: true });
    await sleep(500);
  } catch (e) {}

  // Now try clicking the Agree button
  try {
    await page.click('button:has-text("Agree and continue")', { force: true });
    await sleep(3000);
    return true;
  } catch (e) {}

  return false;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup v9 (Aggressive ToS Handler) ===\n');

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

  try {
    // Step 1: Go to Cloud Console
    console.log('STEP 1: Cloud Console');
    await page.goto('https://console.cloud.google.com');
    await sleep(5000);

    // Handle auth and ToS loop
    for (let i = 0; i < 10; i++) {
      const url = page.url();
      if (url.includes('console.cloud.google.com') && !url.includes('accounts.google.com')) {
        const tosHandled = await handleToSAggressive(page);
        if (!tosHandled) break;  // No ToS, we're good
      }
      if (url.includes('accounts.google.com')) {
        await handleAuth(page);
      }
      await sleep(2000);
    }

    await screenshot(page, '01_console');

    // Step 2: Create project if needed
    console.log('\nSTEP 2: Project setup');
    await page.goto('https://console.cloud.google.com/projectcreate');
    await sleep(5000);

    for (let i = 0; i < 5; i++) {
      if (await handleAuth(page)) continue;
      if (await handleToSAggressive(page)) continue;
      break;
    }

    const nameInput = await page.$('input[aria-label*="Project name"]');
    if (nameInput) {
      await nameInput.fill('TeleClaude-Gmail-' + Date.now().toString().slice(-4));
      await page.click('button:has-text("Create")').catch(() => {});
      console.log('Creating project...');
      await sleep(12000);
    }

    await screenshot(page, '02_project');

    // Step 3: Enable Gmail API
    console.log('\nSTEP 3: Gmail API');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    await sleep(5000);

    for (let i = 0; i < 5; i++) {
      if (await handleAuth(page)) continue;
      if (await handleToSAggressive(page)) continue;
      break;
    }

    try {
      await page.click('button:has-text("Enable")', { timeout: 5000 });
      console.log('Gmail API enabled');
      await sleep(5000);
    } catch (e) {}

    await screenshot(page, '03_api');

    // Step 4: OAuth consent (skip if already configured)
    console.log('\nSTEP 4: OAuth Consent');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent');
    await sleep(5000);

    for (let i = 0; i < 5; i++) {
      if (await handleAuth(page)) continue;
      if (await handleToSAggressive(page)) continue;
      break;
    }

    const consentText = await page.textContent('body').catch(() => '');
    if (consentText.includes('User Type') && consentText.includes('External')) {
      await page.click('text=External').catch(() => {});
      await page.click('button:has-text("Create")').catch(() => {});
      await sleep(3000);

      try { await page.fill('input[formcontrolname="displayName"]', 'TeleClaude'); } catch (e) {}

      const emails = await page.$$('input[type="email"]');
      for (const e of emails) { try { await e.fill('relentlessrobotics@gmail.com'); } catch (x) {} }

      for (let j = 0; j < 5; j++) {
        try { await page.click('button:has-text("Save and Continue")'); await sleep(2000); } catch (e) { break; }
      }
    }

    await screenshot(page, '04_consent');

    // Step 5: Create OAuth credentials
    console.log('\nSTEP 5: Create Credentials');
    await page.goto('https://console.cloud.google.com/apis/credentials');
    await sleep(5000);

    for (let i = 0; i < 5; i++) {
      if (await handleAuth(page)) continue;
      if (await handleToSAggressive(page)) continue;
      break;
    }

    await screenshot(page, '05_creds_page');

    await page.click('button:has-text("Create credentials")');
    await sleep(1500);
    await page.click('text=OAuth client ID');
    await sleep(3000);

    try {
      await page.click('mat-select');
      await sleep(500);
      await page.click('text=Desktop app');
      await sleep(1000);
    } catch (e) {}

    try { await page.fill('input[formcontrolname="name"]', 'TeleClaude'); } catch (e) {}

    await screenshot(page, '06_oauth_form');

    await page.click('button:has-text("Create")');
    await sleep(5000);

    await screenshot(page, '07_created');

    // Extract
    console.log('\nSTEP 6: Extract Credentials');
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

      console.log('\n========== SUCCESS ==========');
      console.log('Client ID:', idMatch[1]);
      console.log('Secret:', secretMatch[1].substring(0, 15) + '...');
      console.log('Saved:', credPath);
      console.log('Next: node utils/gmail_init.js');
      console.log('==============================');

      await context.storageState({ path: STORAGE_STATE });
      return { success: true };
    }

    console.log('\nManual completion needed.');
    await screenshot(page, '08_manual');
    await sleep(300000);

  } catch (error) {
    console.error('Error:', error.message);
    await screenshot(page, 'error');
    await sleep(300000);
  } finally {
    await browser.close();
  }
}

setupGmailOAuth().catch(console.error);
