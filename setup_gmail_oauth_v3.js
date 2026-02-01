const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.join(__dirname, 'browser_profile_chrome');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'gmail_setup');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms + Math.random() * 500));
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOTS_DIR, `v3_${name}_${Date.now()}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
  return filepath;
}

// Specifically handle the Google Cloud welcome ToS dialog
async function handleWelcomeToS(page) {
  console.log('Looking for Welcome ToS dialog...');

  // Check if the dialog is present
  const dialogText = await page.textContent('body').catch(() => '');
  if (!dialogText.includes('Welcome') || !dialogText.includes('Terms of Service')) {
    console.log('No Welcome ToS dialog found');
    return false;
  }

  console.log('Welcome ToS dialog detected!');

  // Strategy 1: Click the checkbox by its label text
  const checkboxSelectors = [
    // Material checkbox container
    'mat-checkbox',
    // The checkbox input itself
    'input[type="checkbox"]',
    // Click on the label/text area
    'label:has-text("I agree")',
    // The clickable area of mat-checkbox
    '.mat-checkbox-inner-container',
    '.mat-checkbox-frame',
    // Generic checkbox containers
    '[role="checkbox"]',
    '.mdc-checkbox',
    // Click the entire row containing the checkbox
    'div:has(input[type="checkbox"])',
  ];

  for (const selector of checkboxSelectors) {
    try {
      const elements = await page.$$(selector);
      for (const el of elements) {
        const text = await el.textContent().catch(() => '');
        const isVisible = await el.isVisible().catch(() => false);

        if (isVisible && (text.includes('agree') || text.includes('Terms') || selector.includes('checkbox'))) {
          console.log(`Trying to click: ${selector}`);

          // Try clicking
          await el.click({ force: true }).catch(() => {});
          await sleep(500);

          // Check if checkbox is now checked
          const checkbox = await page.$('input[type="checkbox"]');
          if (checkbox) {
            const isChecked = await checkbox.isChecked().catch(() => false);
            console.log(`Checkbox checked: ${isChecked}`);
            if (isChecked) {
              await sleep(500);
              break;
            }
          }
        }
      }
    } catch (e) {
      console.log(`Selector ${selector} failed: ${e.message}`);
    }
  }

  // Strategy 2: Use JavaScript to check the checkbox
  try {
    await page.evaluate(() => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => {
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('click', { bubbles: true }));
        }
      });

      // Also try clicking mat-checkbox
      const matCheckboxes = document.querySelectorAll('mat-checkbox');
      matCheckboxes.forEach(mc => mc.click());
    });
    console.log('Tried JavaScript checkbox check');
    await sleep(1000);
  } catch (e) {
    console.log('JS checkbox approach failed:', e.message);
  }

  // Strategy 3: Use keyboard to tab to checkbox and space to check it
  try {
    // Press Tab multiple times to reach the checkbox
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      await sleep(200);

      // Check if we're on the checkbox (focused element is checkbox)
      const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
      const focusedType = await page.evaluate(() => document.activeElement?.type);

      if (focusedType === 'checkbox' || focusedTag === 'MAT-CHECKBOX') {
        console.log('Focused on checkbox, pressing Space');
        await page.keyboard.press('Space');
        await sleep(500);
        break;
      }
    }
  } catch (e) {
    console.log('Keyboard navigation failed:', e.message);
  }

  await sleep(1000);

  // Now try to click "Agree and continue"
  const buttonSelectors = [
    'button:has-text("Agree and continue")',
    'button:has-text("AGREE AND CONTINUE")',
    'button:has-text("Agree")',
    'button:enabled:has-text("continue")',
  ];

  for (const selector of buttonSelectors) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        const isEnabled = await btn.isEnabled().catch(() => false);
        console.log(`Button ${selector} - enabled: ${isEnabled}`);
        if (isEnabled) {
          await btn.click();
          console.log('Clicked Agree button!');
          await sleep(3000);
          return true;
        }
      }
    } catch (e) {}
  }

  // Last resort: Press Enter if button might be focused
  try {
    await page.keyboard.press('Tab');
    await sleep(200);
    await page.keyboard.press('Enter');
    console.log('Tried pressing Enter');
    await sleep(2000);
  } catch (e) {}

  return false;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup v3 (Better ToS Handler) ===\n');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    // channel: 'msedge', // REMOVED - causing "existing session" issue on Windows
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    // Step 1: Navigate to OAuth consent screen directly (we know login works)
    console.log('Step 1: Going to OAuth consent screen...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(5000);
    await screenshot(page, '01_initial');

    // Handle login if needed
    if (page.url().includes('accounts.google.com')) {
      console.log('Login required...');
      await page.waitForSelector('input[type="email"]', { timeout: 30000 });
      await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
      await page.click('#identifierNext');
      await sleep(3000);

      await page.waitForSelector('input[type="password"]', { timeout: 15000 });
      await page.fill('input[type="password"]', 'Relaxing41!');
      await page.click('#passwordNext');
      await sleep(8000);
      console.log('Login completed');
    }

    await screenshot(page, '02_after_login');

    // Handle Welcome ToS dialog
    console.log('\nStep 2: Handling ToS dialog...');
    for (let attempt = 0; attempt < 5; attempt++) {
      console.log(`\nToS attempt ${attempt + 1}...`);
      const handled = await handleWelcomeToS(page);
      await screenshot(page, `03_tos_attempt_${attempt}`);

      if (handled) {
        console.log('ToS handled successfully!');
        break;
      }

      // Check if we're past the dialog
      const currentUrl = page.url();
      const pageContent = await page.textContent('body').catch(() => '');
      if (!pageContent.includes('Welcome Relentless') && !pageContent.includes('Terms of Service')) {
        console.log('ToS dialog no longer visible');
        break;
      }

      await sleep(2000);
    }

    await sleep(3000);
    await screenshot(page, '04_after_tos');

    // Check if we need to select a project first
    console.log('\nStep 3: Checking project status...');
    const needsProject = await page.textContent('body').then(t => t.includes('Select a project'));

    if (needsProject) {
      console.log('Need to create/select project first...');
      await page.goto('https://console.cloud.google.com/projectcreate');
      await sleep(5000);
      await handleWelcomeToS(page);

      // Fill project name
      const nameInput = await page.$('input[aria-label*="Project name"], input#p6ntest-name-input');
      if (nameInput) {
        await nameInput.fill('TeleClaude-Gmail');
        await sleep(1000);
        await page.click('button:has-text("Create")');
        await sleep(8000);
      }
    }

    // Now go to OAuth consent
    console.log('\nStep 4: Configuring OAuth consent...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent');
    await sleep(5000);
    await handleWelcomeToS(page);
    await screenshot(page, '05_consent_page');

    // Select External
    try {
      await page.click('text=External', { timeout: 5000 });
      await sleep(500);
      await page.click('button:has-text("Create")');
      await sleep(3000);
    } catch (e) {
      console.log('External selection skipped (may already be configured)');
    }

    // Fill consent form
    const appNameInput = await page.$('input[formcontrolname="displayName"]');
    if (appNameInput) {
      await appNameInput.fill('TeleClaude Gmail');
    }

    // Fill all email fields
    const emailInputs = await page.$$('input[type="email"], input[formcontrolname*="email"]');
    for (const input of emailInputs) {
      try {
        await input.fill('relentlessrobotics@gmail.com');
      } catch (e) {}
    }

    await screenshot(page, '06_consent_filled');

    // Save and continue
    for (let i = 0; i < 5; i++) {
      try {
        await page.click('button:has-text("Save and Continue")');
        console.log(`Clicked Save and Continue (${i + 1})`);
        await sleep(3000);
      } catch (e) {
        break;
      }
    }

    // Step 5: Enable Gmail API
    console.log('\nStep 5: Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    await sleep(5000);
    await handleWelcomeToS(page);

    try {
      await page.click('button:has-text("Enable")', { timeout: 10000 });
      console.log('Gmail API enabled');
      await sleep(5000);
    } catch (e) {
      console.log('Enable button not found (may already be enabled)');
    }

    await screenshot(page, '07_api_enabled');

    // Step 6: Create OAuth credentials
    console.log('\nStep 6: Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials');
    await sleep(5000);
    await handleWelcomeToS(page);
    await screenshot(page, '08_credentials_page');

    // Click Create Credentials
    await page.click('button:has-text("Create credentials")');
    await sleep(1000);
    await page.click('text=OAuth client ID');
    await sleep(3000);

    // Select Desktop app
    try {
      await page.click('mat-select, [role="listbox"]');
      await sleep(500);
      await page.click('text=Desktop app, mat-option:has-text("Desktop")');
      await sleep(1000);
    } catch (e) {
      console.log('App type selection failed, trying alternative');
    }

    // Name
    const nameInputOAuth = await page.$('input[formcontrolname="name"]');
    if (nameInputOAuth) {
      await nameInputOAuth.fill('TeleClaude Desktop');
    }

    await screenshot(page, '09_oauth_form');

    // Create
    await page.click('button:has-text("Create")');
    await sleep(5000);
    await screenshot(page, '10_oauth_created');

    // Extract credentials
    console.log('\nStep 7: Extracting credentials...');
    const pageText = await page.textContent('body');

    const idMatch = pageText.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = pageText.match(/(GOCSPX-[A-Za-z0-9_-]+)/);

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

      console.log('\n=== SUCCESS ===');
      console.log('Client ID:', idMatch[1]);
      console.log('Client Secret:', secretMatch[1].substring(0, 15) + '...');
      console.log('Saved to:', credPath);
      console.log('\nRun: node utils/gmail_init.js to complete authorization');

      return { success: true };
    }

    console.log('Could not extract credentials - check screenshots');
    console.log('Browser staying open for manual completion...');
    await sleep(300000);

  } catch (error) {
    console.error('Error:', error.message);
    await screenshot(page, 'error');
    console.log('Browser staying open...');
    await sleep(300000);
  } finally {
    await context.close();
  }
}

setupGmailOAuth().catch(console.error);
