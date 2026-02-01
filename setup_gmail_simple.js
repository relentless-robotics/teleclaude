const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_STATE = 'C:/Users/Footb/Documents/Github/teleclaude-main/browser_state/google_auth.json';
const CREDENTIALS_PATH = 'C:/Users/Footb/Documents/Github/teleclaude-main/secure/gmail_credentials.json';

async function log(message) {
  console.log(message);
}

async function waitAndClick(page, selector, description, timeout = 10000) {
  try {
    await log(`Waiting for: ${description}...`);
    await page.waitForSelector(selector, { timeout });
    await page.click(selector);
    await log(`✅ Clicked: ${description}`);
    return true;
  } catch (e) {
    await log(`⚠️ Could not click: ${description}`);
    return false;
  }
}

async function simpleGmailSetup() {
  let browser, context, page;

  try {
    await log('🚀 Launching browser...');

    browser = await chromium.launch({
      headless: false,
      channel: 'msedge'
    });

    context = await browser.newContext({
      storageState: fs.existsSync(AUTH_STATE) ? AUTH_STATE : undefined,
      viewport: { width: 1920, height: 1080 }
    });

    page = await context.newPage();
    page.setDefaultTimeout(30000);

    // Go directly to OAuth client creation page (bypasses most setup)
    await log('📍 Navigating directly to OAuth client creation...');
    await page.goto('https://console.cloud.google.com/apis/credentials/oauthclient', {
      waitUntil: 'domcontentloaded'
    });

    // Handle account chooser
    await page.waitForTimeout(3000);
    let pageUrl = page.url();

    if (pageUrl.includes('accounts.google.com')) {
      await log('Handling Google account chooser...');

      // Click on the relentlessrobotics account
      const clicked = await waitAndClick(
        page,
        'div:has-text("relentlessrobotics@gmail.com")',
        'Account selection',
        5000
      );

      if (clicked) {
        await page.waitForTimeout(5000);
      }
    }

    // Take screenshot to see current state
    await page.screenshot({ path: './screenshots/current_state.png', fullPage: true });

    pageUrl = page.url();
    const pageText = await page.textContent('body');

    await log(`Current URL: ${pageUrl}`);

    // Check what page we're on
    if (pageUrl.includes('projectcreate') || pageText.includes('Create a project') || pageText.includes('Select a project')) {
      await log('📍 Need to create/select project first...');

      // Try to find and click on existing project
      const projectNames = await page.$$('text=/TeleClaude|teleclaude|Gmail/i');

      if (projectNames.length > 0) {
        await log('✅ Found existing project, clicking...');
        await projectNames[0].click();
        await page.waitForTimeout(3000);
      } else {
        await log('Creating new project via API library instead...');

        // Go to API library first, which will help create project
        await page.goto('https://console.cloud.google.com/apis/library', {
          waitUntil: 'domcontentloaded'
        });
        await page.waitForTimeout(5000);

        // Accept the project creation prompt if it appears
        const createProjectButton = await page.$('button:has-text("Create"), button:has-text("CREATE")');
        if (createProjectButton) {
          await createProjectButton.click();
          await page.waitForTimeout(2000);

          // Fill in form
          const inputs = await page.$$('input[type="text"]');
          if (inputs.length > 0) {
            await inputs[0].fill('TeleClaude-Gmail');
            await page.waitForTimeout(1000);

            const submitButton = await page.$('button:has-text("Create"), button[type="submit"]');
            if (submitButton) {
              await submitButton.click();
              await log('⏳ Waiting 20s for project creation...');
              await page.waitForTimeout(20000);
            }
          }
        }
      }
    }

    // Now enable Gmail API
    await log('📍 Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com', {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(5000);

    await waitAndClick(page, 'button:has-text("ENABLE"), button:has-text("Enable")', 'Enable API button', 5000);
    await page.waitForTimeout(10000);

    // Set up OAuth consent (if needed)
    await log('📍 Checking OAuth consent screen...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent', {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: './screenshots/consent_screen.png', fullPage: true });

    const consentText = await page.textContent('body');

    if (consentText.includes('User Type') || consentText.includes('EXTERNAL') || consentText.includes('INTERNAL')) {
      await log('Setting up OAuth consent screen...');

      // Select External if available
      await waitAndClick(page, 'input[value="EXTERNAL"]', 'External user type', 3000);
      await page.waitForTimeout(1000);
      await waitAndClick(page, 'button:has-text("CREATE"), button:has-text("Create")', 'Create consent', 3000);
      await page.waitForTimeout(3000);

      // Fill in app name
      const appNameInput = await page.$('input[type="text"]');
      if (appNameInput) {
        await appNameInput.fill('TeleClaude');
        await log('✅ Entered app name');
      }

      await page.waitForTimeout(2000);

      // Click through the form
      for (let i = 0; i < 4; i++) {
        const clicked = await waitAndClick(
          page,
          'button:has-text("SAVE AND CONTINUE"), button:has-text("Save and Continue")',
          `Consent form step ${i + 1}`,
          3000
        );
        if (clicked) {
          await page.waitForTimeout(2000);
        } else {
          break;
        }
      }
    }

    // Now create OAuth credentials
    await log('📍 Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials/oauthclient', {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: './screenshots/oauth_creation.png', fullPage: true });

    // Fill the form
    // 1. Select Desktop app from dropdown
    const selects = await page.$$('select');
    for (const select of selects) {
      try {
        await select.selectOption({ label: 'Desktop app' });
        await log('✅ Selected Desktop app');
        break;
      } catch (e) {
        // Try next select
      }
    }

    await page.waitForTimeout(1000);

    // 2. Enter name
    const nameInputs = await page.$$('input[type="text"]');
    for (const input of nameInputs) {
      try {
        await input.fill('TeleClaude-Desktop');
        await log('✅ Entered name');
        break;
      } catch (e) {
        // Try next input
      }
    }

    await page.waitForTimeout(1000);
    await page.screenshot({ path: './screenshots/oauth_filled.png', fullPage: true });

    // 3. Click Create
    await waitAndClick(page, 'button:has-text("CREATE"), button:has-text("Create")', 'Create credentials', 5000);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: './screenshots/oauth_created.png', fullPage: true });

    // Extract credentials
    await log('📍 Extracting credentials...');

    const html = await page.content();

    const clientIdMatch = html.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const clientSecretMatch = html.match(/GOCSPX-[a-zA-Z0-9_-]+/);

    let clientId = clientIdMatch ? clientIdMatch[1] : null;
    let clientSecret = clientSecretMatch ? clientSecretMatch[0] : null;

    // Alternative: extract from visible elements
    if (!clientId || !clientSecret) {
      const elements = await page.$$('code, pre, input[readonly], span, div');
      for (const el of elements) {
        const text = await el.textContent();
        if (text && text.includes('.apps.googleusercontent.com') && !clientId) {
          const match = text.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
          if (match) clientId = match[1];
        }
        if (text && text.includes('GOCSPX-') && !clientSecret) {
          const match = text.match(/GOCSPX-[a-zA-Z0-9_-]+/);
          if (match) clientSecret = match[0];
        }
      }
    }

    if (clientId && clientSecret) {
      await log(`\n✅ Successfully extracted credentials!`);
      await log(`   Client ID: ${clientId.substring(0, 30)}...`);
      await log(`   Client Secret: ${clientSecret.substring(0, 15)}...`);

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

      const secureDir = path.dirname(CREDENTIALS_PATH);
      if (!fs.existsSync(secureDir)) {
        fs.mkdirSync(secureDir, { recursive: true });
      }

      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
      await log(`\n✅ Saved credentials to: ${CREDENTIALS_PATH}\n`);

      await page.waitForTimeout(2000);
      await browser.close();
      return true;

    } else {
      await log('\n⚠️ Could not extract credentials from page');
      await log('Please check screenshots and manually create the file');
      await log('Browser will stay open for 60 seconds...');
      await page.waitForTimeout(60000);
      await browser.close();
      return false;
    }

  } catch (error) {
    await log(`\n❌ Error: ${error.message}`);
    console.error(error.stack);

    if (page) {
      await page.screenshot({ path: './screenshots/final_error.png', fullPage: true });
    }

    if (browser) {
      await log('Browser staying open for inspection...');
      await page.waitForTimeout(60000);
      await browser.close();
    }

    return false;
  }
}

simpleGmailSetup().then(success => {
  if (success) {
    console.log('\n🎉 SUCCESS! Credentials saved.');
    console.log('\n📝 Next step: Run this command:');
    console.log('   node utils/gmail_init.js\n');
  } else {
    console.log('\n❌ Setup incomplete. Check screenshots for details.\n');
  }
  process.exit(success ? 0 : 1);
});
