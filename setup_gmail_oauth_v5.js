const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.join(__dirname, 'browser_profile_v5');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots', 'gmail_setup');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms + Math.random() * 300));
}

async function screenshot(page, name) {
  const filepath = path.join(SCREENSHOTS_DIR, `v5_${name}_${Date.now()}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
  return filepath;
}

// Click the ToS checkbox using bounding box coordinates
async function clickToSCheckbox(page) {
  console.log('Attempting to click ToS checkbox...');

  // Find all checkboxes and click them using bounding box
  const checkboxes = await page.$$('input[type="checkbox"], mat-checkbox, [role="checkbox"]');

  for (const checkbox of checkboxes) {
    try {
      const box = await checkbox.boundingBox();
      if (box) {
        // Click in the center of the checkbox
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        console.log(`Found checkbox at (${x}, ${y}), clicking...`);

        await page.mouse.click(x, y);
        await sleep(500);

        // Check if it worked
        const isChecked = await checkbox.isChecked().catch(() => null);
        console.log(`After click, checked: ${isChecked}`);

        if (isChecked === true) {
          return true;
        }
      }
    } catch (e) {
      console.log('Checkbox click error:', e.message);
    }
  }

  // Also try clicking on the mat-checkbox-inner-container
  const innerContainers = await page.$$('.mat-checkbox-inner-container, .mdc-checkbox__background');
  for (const container of innerContainers) {
    try {
      const box = await container.boundingBox();
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        console.log(`Found inner container at (${x}, ${y}), clicking...`);
        await page.mouse.click(x, y);
        await sleep(500);
        return true;
      }
    } catch (e) {}
  }

  // Try clicking by text label
  try {
    const label = await page.$('text=I agree to the');
    if (label) {
      const box = await label.boundingBox();
      if (box) {
        // Click slightly to the left of the text (where checkbox is)
        const x = box.x - 30;
        const y = box.y + box.height / 2;
        console.log(`Clicking left of label at (${x}, ${y})...`);
        await page.mouse.click(x, y);
        await sleep(500);
      }
    }
  } catch (e) {}

  return false;
}

async function handleWelcomeDialog(page) {
  const pageText = await page.textContent('body').catch(() => '');

  if (!pageText.includes('Welcome') || !pageText.includes('Terms of Service')) {
    return false;
  }

  console.log('\n=== Welcome ToS Dialog Detected ===');

  // First, try clicking the checkbox multiple times with delays
  for (let attempt = 0; attempt < 3; attempt++) {
    console.log(`\nCheckbox attempt ${attempt + 1}...`);
    await clickToSCheckbox(page);
    await sleep(1000);
  }

  // Wait a bit for UI to update
  await sleep(1000);

  // Now click the Agree button
  const agreeButton = await page.$('button:has-text("Agree and continue")');
  if (agreeButton) {
    const isDisabled = await agreeButton.getAttribute('disabled');
    console.log(`Agree button disabled: ${isDisabled}`);

    if (!isDisabled) {
      const box = await agreeButton.boundingBox();
      if (box) {
        console.log('Clicking Agree button...');
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(3000);
        return true;
      }
    }
  }

  // If button still disabled, try one more time with force click on checkbox
  console.log('Button still disabled, trying force click...');

  try {
    // Use page.evaluate to directly manipulate the checkbox
    await page.evaluate(() => {
      // Find the mat-checkbox component
      const matCheckbox = document.querySelector('mat-checkbox');
      if (matCheckbox) {
        // Trigger a click event on it
        matCheckbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }

      // Also try the native checkbox
      const checkbox = document.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.checked) {
        checkbox.click();
      }
    });
    await sleep(1000);
  } catch (e) {}

  // Final attempt to click Agree
  try {
    await page.click('button:has-text("Agree and continue"):not([disabled])');
    await sleep(3000);
    return true;
  } catch (e) {
    console.log('Could not click Agree button');
  }

  return false;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup v5 (Mouse Click Approach) ===\n');

  // Use a fresh profile to avoid session conflicts
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Anti-detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  try {
    // Step 1: Login to Google
    console.log('Step 1: Logging into Google...');
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle' });
    await sleep(2000);
    await screenshot(page, '01_login');

    // Enter email
    await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
    await sleep(500);
    await page.click('#identifierNext');
    await sleep(3000);
    await screenshot(page, '02_after_email');

    // Enter password
    try {
      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await page.fill('input[type="password"]', 'Relaxing41!');
      await sleep(500);
      await page.click('#passwordNext');
      await sleep(5000);
      await screenshot(page, '03_after_password');
    } catch (e) {
      console.log('Password field not found - checking for 2FA or other flow');
      await screenshot(page, '03_alt_flow');
    }

    console.log('Waiting for login to complete...');
    await sleep(5000);

    // Step 2: Navigate to Cloud Console
    console.log('\nStep 2: Going to Cloud Console...');
    await page.goto('https://console.cloud.google.com', { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    await screenshot(page, '04_cloud_console');

    // Handle ToS dialog
    console.log('\nStep 3: Handling ToS dialog...');
    for (let i = 0; i < 5; i++) {
      const handled = await handleWelcomeDialog(page);
      await screenshot(page, `05_tos_attempt_${i}`);

      if (handled) {
        console.log('ToS handled!');
        break;
      }

      // Check if dialog is gone
      const pageText = await page.textContent('body').catch(() => '');
      if (!pageText.includes('Welcome Relentless') && !pageText.includes('You must accept')) {
        console.log('ToS dialog no longer visible');
        break;
      }

      await sleep(2000);
    }

    await sleep(3000);
    await screenshot(page, '06_after_tos');

    // Step 4: Create or select project
    console.log('\nStep 4: Setting up project...');
    await page.goto('https://console.cloud.google.com/projectcreate', { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    await handleWelcomeDialog(page);
    await screenshot(page, '07_project_page');

    // Fill project name if visible
    const projectInput = await page.$('input[aria-label*="Project name"], #p6ntest-name-input, input[formcontrolname="projectName"]');
    if (projectInput) {
      await projectInput.fill('TeleClaude-Gmail-' + Date.now().toString().slice(-4));
      await sleep(1000);

      // Click Create
      const createBtn = await page.$('button:has-text("Create")');
      if (createBtn) {
        await createBtn.click();
        console.log('Project creation initiated');
        await sleep(10000);
      }
    }

    await screenshot(page, '08_after_project');

    // Step 5: Enable Gmail API
    console.log('\nStep 5: Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com', { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    await handleWelcomeDialog(page);
    await screenshot(page, '09_gmail_api');

    try {
      await page.click('button:has-text("Enable")', { timeout: 10000 });
      console.log('Gmail API enabled');
      await sleep(5000);
    } catch (e) {
      console.log('Enable button not found (may already be enabled)');
    }

    // Step 6: Configure OAuth consent
    console.log('\nStep 6: Configuring OAuth consent...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent', { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    await handleWelcomeDialog(page);
    await screenshot(page, '10_consent');

    // Select External
    try {
      await page.click('text=External');
      await sleep(500);
      await page.click('button:has-text("Create")');
      await sleep(3000);
    } catch (e) {}

    // Fill form
    const appNameInput = await page.$('input[formcontrolname="displayName"]');
    if (appNameInput) await appNameInput.fill('TeleClaude Gmail');

    const emailInputs = await page.$$('input[type="email"]');
    for (const input of emailInputs) {
      try { await input.fill('relentlessrobotics@gmail.com'); } catch (e) {}
    }

    await screenshot(page, '11_consent_filled');

    // Save and continue
    for (let i = 0; i < 5; i++) {
      try {
        await page.click('button:has-text("Save and Continue")');
        await sleep(3000);
      } catch (e) { break; }
    }

    // Step 7: Create OAuth credentials
    console.log('\nStep 7: Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials', { waitUntil: 'domcontentloaded' });
    await sleep(5000);
    await handleWelcomeDialog(page);
    await screenshot(page, '12_credentials');

    await page.click('button:has-text("Create credentials")');
    await sleep(1000);
    await page.click('text=OAuth client ID');
    await sleep(3000);

    // Select Desktop app
    try {
      await page.click('mat-select');
      await sleep(500);
      await page.click('text=Desktop app');
      await sleep(1000);
    } catch (e) {}

    // Name
    const nameInput = await page.$('input[formcontrolname="name"]');
    if (nameInput) await nameInput.fill('TeleClaude Desktop');

    await page.click('button:has-text("Create")');
    await sleep(5000);
    await screenshot(page, '13_oauth_created');

    // Extract credentials
    console.log('\nStep 8: Extracting credentials...');
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
      return { success: true, clientId: idMatch[1] };
    }

    console.log('\nCould not extract credentials automatically.');
    console.log('Browser will stay open for manual completion...');
    await screenshot(page, '14_final');
    await sleep(300000);

  } catch (error) {
    console.error('Error:', error.message);
    await screenshot(page, 'error');
    console.log('Browser staying open for manual intervention...');
    await sleep(300000);
  } finally {
    await browser.close();
  }
}

setupGmailOAuth().catch(console.error);
