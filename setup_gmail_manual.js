const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_STATE = 'C:/Users/Footb/Documents/Github/teleclaude-main/browser_state/google_auth.json';
const CREDENTIALS_PATH = 'C:/Users/Footb/Documents/Github/teleclaude-main/secure/gmail_credentials.json';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function manualGmailOAuthSetup() {
  let browser, context, page;

  try {
    console.log('🚀 Opening browser with saved Google auth...\n');

    browser = await chromium.launch({
      headless: false,
      channel: 'msedge'
    });

    if (fs.existsSync(AUTH_STATE)) {
      context = await browser.newContext({
        storageState: AUTH_STATE
      });
      console.log('✅ Loaded saved Google authentication\n');
    } else {
      context = await browser.newContext();
      console.log('⚠️ No saved auth - will need manual login\n');
    }

    page = await context.newPage();
    page.setDefaultTimeout(60000);

    // Step 1: Open Google Cloud Console
    console.log('📍 STEP 1: Opening Google Cloud Console...');
    await page.goto('https://console.cloud.google.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    await askQuestion('\nPress ENTER when the Cloud Console has loaded...');

    // Step 2: Create or select project
    console.log('\n📍 STEP 2: Creating project...');
    console.log('Opening project creation page...');
    await page.goto('https://console.cloud.google.com/projectcreate', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    console.log('\n📝 INSTRUCTIONS:');
    console.log('1. Enter project name: TeleClaude Gmail');
    console.log('2. Click CREATE');
    console.log('3. Wait for project to be created');
    console.log('4. Make sure the new project is selected (top dropdown)');

    await askQuestion('\nPress ENTER when project is created and selected...');

    // Step 3: Enable Gmail API
    console.log('\n📍 STEP 3: Enabling Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    console.log('\n📝 INSTRUCTIONS:');
    console.log('1. Click the ENABLE button');
    console.log('2. Wait for the API to be enabled');

    await askQuestion('\nPress ENTER when Gmail API is enabled...');

    // Step 4: Configure OAuth Consent
    console.log('\n📍 STEP 4: Configuring OAuth consent screen...');
    await page.goto('https://console.cloud.google.com/apis/credentials/consent', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    console.log('\n📝 INSTRUCTIONS:');
    console.log('1. If asked, select "External" user type and click CREATE');
    console.log('2. Fill in the form:');
    console.log('   - App name: TeleClaude Gmail');
    console.log('   - User support email: relentlessrobotics@gmail.com (should auto-select)');
    console.log('   - Developer contact email: relentlessrobotics@gmail.com');
    console.log('3. Click SAVE AND CONTINUE');
    console.log('4. On Scopes page: Click SAVE AND CONTINUE (skip adding scopes)');
    console.log('5. On Test users page: Add relentlessrobotics@gmail.com');
    console.log('6. Click SAVE AND CONTINUE until done');

    await askQuestion('\nPress ENTER when OAuth consent screen is configured...');

    // Step 5: Create OAuth Credentials
    console.log('\n📍 STEP 5: Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials/oauthclient', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    console.log('\n📝 INSTRUCTIONS:');
    console.log('1. Application type: Select "Desktop app"');
    console.log('2. Name: TeleClaude Desktop');
    console.log('3. Click CREATE');
    console.log('4. A modal will show your Client ID and Client Secret');
    console.log('5. Keep that modal open - I will extract the credentials');

    await askQuestion('\nPress ENTER when the credentials modal is showing...');

    // Step 6: Extract credentials
    console.log('\n📍 STEP 6: Extracting credentials from page...');

    // Try to find client ID and secret on the page
    let clientId = null;
    let clientSecret = null;

    try {
      // Wait for the modal to be present
      await page.waitForSelector('code, pre, input[readonly]', { timeout: 5000 });

      // Extract client ID (looks like: xxx.apps.googleusercontent.com)
      const pageContent = await page.content();

      const idMatch = pageContent.match(/([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
      if (idMatch) {
        clientId = idMatch[1];
        console.log(`\n✅ Found Client ID: ${clientId.substring(0, 30)}...`);
      }

      // Extract client secret
      const secretMatch = pageContent.match(/GOCSPX-[a-zA-Z0-9_-]+/);
      if (secretMatch) {
        clientSecret = secretMatch[0];
        console.log(`✅ Found Client Secret: ${clientSecret.substring(0, 15)}...`);
      }

      // Alternative: try to get from code elements
      if (!clientId || !clientSecret) {
        const codeElements = await page.$$('code');
        for (const el of codeElements) {
          const text = await el.textContent();
          if (text && text.includes('.apps.googleusercontent.com')) {
            clientId = text.trim();
          }
          if (text && text.startsWith('GOCSPX-')) {
            clientSecret = text.trim();
          }
        }
      }

      // Alternative: try input fields
      if (!clientId || !clientSecret) {
        const inputs = await page.$$('input[readonly], input[type="text"]');
        for (const input of inputs) {
          const value = await input.getAttribute('value');
          if (value && value.includes('.apps.googleusercontent.com')) {
            clientId = value;
          }
          if (value && value.startsWith('GOCSPX-')) {
            clientSecret = value;
          }
        }
      }

    } catch (e) {
      console.log('⚠️ Could not automatically extract credentials');
    }

    // Manual entry if extraction failed
    if (!clientId) {
      console.log('\n⚠️ Could not find Client ID automatically.');
      clientId = await askQuestion('Please enter the Client ID: ');
    }

    if (!clientSecret) {
      console.log('\n⚠️ Could not find Client Secret automatically.');
      clientSecret = await askQuestion('Please enter the Client Secret: ');
    }

    // Create credentials JSON
    const credentials = {
      installed: {
        client_id: clientId.trim(),
        project_id: "teleclaude-gmail",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_secret: clientSecret.trim(),
        redirect_uris: ["http://localhost"]
      }
    };

    // Save credentials
    const secureDir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(secureDir)) {
      fs.mkdirSync(secureDir, { recursive: true });
    }

    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
    console.log(`\n✅ Credentials saved to: ${CREDENTIALS_PATH}`);

    // Verify file
    const saved = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    console.log('\n✅ Verification:');
    console.log(`   Client ID: ${saved.installed.client_id.substring(0, 30)}...`);
    console.log(`   Client Secret: ${saved.installed.client_secret.substring(0, 15)}...`);

    console.log('\n🎉 Setup complete!');
    console.log('\n📝 Next step: Run this command to complete OAuth flow:');
    console.log('   node utils/gmail_init.js');

    rl.close();
    await browser.close();
    return true;

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    rl.close();
    if (browser) await browser.close();
    return false;
  }
}

manualGmailOAuthSetup().then(success => {
  process.exit(success ? 0 : 1);
});
