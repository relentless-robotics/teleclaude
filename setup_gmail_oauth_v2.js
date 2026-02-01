const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const USER_DATA_DIR = path.join(__dirname, 'browser_profile_chrome');
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

async function handleToSDialog(page) {
  // Handle Google Cloud Terms of Service dialog
  const tosSelectors = [
    'button:has-text("I agree")',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("AGREE")',
    '[aria-label*="agree"]',
    '[aria-label*="Accept"]',
    'mat-checkbox:has-text("Terms")',
    'input[type="checkbox"][aria-label*="Terms"]',
    '.tos-agree-button',
    '[data-action="agree"]'
  ];

  for (const selector of tosSelectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        console.log(`Found ToS element with selector: ${selector}`);
        await element.click();
        await sleep(2000);
        return true;
      }
    } catch (e) {
      // Continue to next selector
    }
  }

  // Also check for checkbox + button combo
  try {
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      const isChecked = await checkbox.isChecked();
      if (!isChecked) {
        await checkbox.click();
        await sleep(500);
      }
    }
    const agreeBtn = await page.$('button:has-text("Agree"), button:has-text("Continue")');
    if (agreeBtn) {
      await agreeBtn.click();
      await sleep(2000);
      return true;
    }
  } catch (e) {
    // Continue
  }

  return false;
}

async function clickWithRetry(page, selectors, maxRetries = 3) {
  const selectorArray = Array.isArray(selectors) ? selectors : [selectors];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const selector of selectorArray) {
      try {
        const element = await page.$(selector);
        if (element) {
          await element.click();
          return true;
        }
      } catch (e) {
        // Continue
      }
    }
    await sleep(1000);
  }
  return false;
}

async function setupGmailOAuth() {
  console.log('=== Gmail OAuth Setup v2 (Edge + ToS Handler) ===');
  console.log('Using Microsoft Edge browser with persistent profile');
  console.log('If 2FA is needed, approve on your phone');
  console.log('');

  // Launch with persistent context using Edge
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'msedge',  // Use Edge instead of Chrome
    viewport: { width: 1400, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  const page = await context.newPage();

  // Remove webdriver flag
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

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
    let url = page.url();
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
    url = page.url();
    console.log('After login URL:', url);

    if (!url.includes('console.cloud.google.com')) {
      console.log('Not on Cloud Console yet. Waiting longer...');
      try {
        await page.waitForURL('**/console.cloud.google.com/**', { timeout: 120000 });
      } catch (e) {
        console.log('Timeout waiting for Cloud Console - checking current state');
      }
    }

    await screenshot(page, '07_cloud_console');
    console.log('Reached Cloud Console or similar page');

    // Handle Terms of Service dialog if present
    console.log('Checking for Terms of Service dialog...');
    await sleep(3000);

    // Try multiple times to handle ToS
    for (let i = 0; i < 3; i++) {
      const handled = await handleToSDialog(page);
      if (handled) {
        console.log('ToS dialog handled');
        await screenshot(page, '07b_tos_handled');
        break;
      }
      await sleep(2000);
    }

    // Also try pressing Enter or Escape if stuck
    try {
      await page.keyboard.press('Escape');
      await sleep(500);
    } catch (e) {}

    await sleep(2000);
    await screenshot(page, '08_after_tos');

    // Step 2: Navigate directly to create new project page
    console.log('Step 2: Creating project...');
    await page.goto('https://console.cloud.google.com/projectcreate', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(5000);
    await screenshot(page, '09_project_create_page');

    // Handle ToS again if needed
    await handleToSDialog(page);
    await sleep(2000);

    // Find and fill project name
    const projectNameSelectors = [
      'input[aria-label*="Project name"]',
      'input[formcontrolname="projectName"]',
      '#p6n-name-input',
      'input[name="projectName"]',
      'input.ng-pristine'
    ];

    let projectNameFilled = false;
    for (const selector of projectNameSelectors) {
      try {
        const input = await page.$(selector);
        if (input) {
          await input.click();
          await input.fill('');  // Clear first
          await sleep(300);

          // Type project name character by character
          const projectName = 'TeleClaude-Gmail';
          for (const char of projectName) {
            await page.keyboard.type(char, { delay: 50 + Math.random() * 50 });
          }

          projectNameFilled = true;
          console.log('Project name filled using:', selector);
          await screenshot(page, '10_project_name');
          break;
        }
      } catch (e) {
        console.log('Selector failed:', selector);
      }
    }

    if (!projectNameFilled) {
      console.log('Could not find project name input - taking screenshot for review');
      await screenshot(page, '10_project_input_not_found');
    }

    // Click Create button
    await sleep(2000);
    const createSuccess = await clickWithRetry(page, [
      'button:has-text("Create")',
      'button[type="submit"]',
      '.create-button'
    ]);

    if (createSuccess) {
      console.log('Clicked Create button');
      await sleep(8000);
      await screenshot(page, '11_project_created');
    } else {
      console.log('Could not find Create button');
    }

    // Step 3: Enable Gmail API
    console.log('Step 3: Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(5000);
    await screenshot(page, '12_gmail_api_page');

    // Handle ToS again
    await handleToSDialog(page);
    await sleep(2000);

    // Click Enable
    const enableSuccess = await clickWithRetry(page, [
      'button:has-text("Enable")',
      'button:has-text("ENABLE")',
      '[aria-label*="Enable"]'
    ]);

    if (enableSuccess) {
      console.log('Clicked Enable button');
    }
    await sleep(5000);
    await screenshot(page, '13_gmail_enabled');

    // Step 4: OAuth Consent Screen
    console.log('Step 4: Configuring OAuth consent...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(5000);
    await screenshot(page, '14_consent_screen');

    // Handle ToS
    await handleToSDialog(page);
    await sleep(2000);

    // Select External user type
    await clickWithRetry(page, [
      'text=External',
      '[value="EXTERNAL"]',
      'mat-radio-button:has-text("External")'
    ]);
    await sleep(1000);

    await clickWithRetry(page, [
      'button:has-text("Create")',
      'button:has-text("CREATE")'
    ]);
    await sleep(3000);
    await screenshot(page, '15_consent_type');

    // Fill App Name
    const appNameSelectors = [
      'input[formcontrolname="displayName"]',
      'input[aria-label*="App name"]',
      '#appName'
    ];

    for (const selector of appNameSelectors) {
      try {
        const input = await page.$(selector);
        if (input) {
          await input.fill('TeleClaude Gmail');
          console.log('App name filled');
          break;
        }
      } catch (e) {}
    }
    await sleep(1000);

    // Fill Support Email
    const emailSelectors = [
      'input[formcontrolname="email"]',
      'input[aria-label*="support email"]',
      'input[aria-label*="User support email"]'
    ];

    for (const selector of emailSelectors) {
      try {
        const input = await page.$(selector);
        if (input) {
          await input.fill('relentlessrobotics@gmail.com');
          console.log('Support email filled');
          break;
        }
      } catch (e) {}
    }
    await sleep(1000);

    // Also try to fill developer contact email (sometimes a separate field)
    try {
      const devEmailInputs = await page.$$('input[type="email"]');
      for (const input of devEmailInputs) {
        const value = await input.inputValue();
        if (!value) {
          await input.fill('relentlessrobotics@gmail.com');
        }
      }
    } catch (e) {}

    await screenshot(page, '16_consent_filled');

    // Save and continue through screens
    for (let i = 0; i < 5; i++) {
      const saved = await clickWithRetry(page, [
        'button:has-text("Save and Continue")',
        'button:has-text("SAVE AND CONTINUE")',
        'button:has-text("Save")',
        'button:has-text("Continue")'
      ]);
      if (saved) {
        console.log(`Save and Continue clicked (${i + 1})`);
      }
      await sleep(3000);
    }
    await screenshot(page, '17_consent_done');

    // Step 5: Create OAuth Credentials
    console.log('Step 5: Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await sleep(5000);
    await screenshot(page, '18_credentials_page');

    // Handle ToS
    await handleToSDialog(page);
    await sleep(2000);

    // Click Create Credentials dropdown
    await clickWithRetry(page, [
      'button:has-text("Create credentials")',
      'button:has-text("CREATE CREDENTIALS")'
    ]);
    await sleep(2000);

    // Select OAuth client ID
    await clickWithRetry(page, [
      'text=OAuth client ID',
      '[aria-label*="OAuth client ID"]'
    ]);
    await sleep(3000);
    await screenshot(page, '19_create_oauth');

    // Select application type - Desktop
    await clickWithRetry(page, [
      'mat-select',
      '[role="listbox"]',
      '[aria-label*="Application type"]'
    ]);
    await sleep(1000);

    await clickWithRetry(page, [
      'text=Desktop app',
      'mat-option:has-text("Desktop")'
    ]);
    await sleep(1000);

    // Name it
    const nameSelectors = [
      'input[formcontrolname="name"]',
      'input[aria-label*="Name"]'
    ];

    for (const selector of nameSelectors) {
      try {
        const input = await page.$(selector);
        if (input) {
          await input.fill('TeleClaude Desktop');
          console.log('OAuth client name filled');
          break;
        }
      } catch (e) {}
    }
    await sleep(1000);
    await screenshot(page, '20_oauth_config');

    // Click Create
    await clickWithRetry(page, [
      'button:has-text("Create")',
      'button:has-text("CREATE")'
    ]);
    await sleep(5000);
    await screenshot(page, '21_oauth_created');

    // Get the credentials from the dialog
    console.log('Step 6: Extracting credentials...');
    await sleep(2000);

    // Get page text to find credentials
    const pageText = await page.textContent('body');

    let clientId = '';
    let clientSecret = '';

    // Try regex patterns to find credentials
    const idMatch = pageText.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = pageText.match(/(GOCSPX-[A-Za-z0-9_-]+)/);

    if (idMatch) {
      clientId = idMatch[1];
      console.log('Client ID found:', clientId);
    }

    if (secretMatch) {
      clientSecret = secretMatch[1];
      console.log('Client Secret found:', clientSecret.substring(0, 15) + '...');
    }

    // Try clicking Download JSON
    try {
      await page.click('button:has-text("Download JSON"), button[aria-label*="Download"]');
      console.log('Download button clicked');
      await sleep(3000);
    } catch (e) {
      console.log('Could not click download button');
    }

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
      console.log('\n=== SUCCESS ===');
      console.log('Credentials saved to:', credPath);
      console.log('Run: node utils/gmail_init.js to complete authorization');

      return { success: true, clientId, clientSecret };
    } else {
      console.log('\nCould not extract credentials automatically.');
      console.log('Check the screenshots and browser for the Client ID and Secret.');
      console.log('Screenshots saved in:', SCREENSHOTS_DIR);
    }

    // Keep browser open for manual inspection
    console.log('\nBrowser will stay open for 2 minutes for manual verification...');
    console.log('Press Ctrl+C to exit earlier.');
    await sleep(120000);

  } catch (error) {
    console.error('Error:', error.message);
    await screenshot(page, 'error');

    console.log('\nBrowser staying open for manual completion...');
    console.log('Please complete the setup manually if automation failed.');
    console.log('Screenshots saved in:', SCREENSHOTS_DIR);
    await sleep(300000); // 5 minutes
  } finally {
    await context.close();
  }
}

setupGmailOAuth().catch(console.error);
