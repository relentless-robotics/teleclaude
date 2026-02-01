const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function setupGmailOAuth() {
  const stateFile = path.join(__dirname, '../browser_state', 'google_auth.json');

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });

  let context;
  if (fs.existsSync(stateFile)) {
    console.log('Loading Google authentication state...');
    context = await browser.newContext({ storageState: stateFile });
  } else {
    console.log('No saved auth state - will need to login...');
    context = await browser.newContext();
  }

  const page = await context.newPage();

  try {
    // Step 1: Go to Google Cloud Console
    console.log('Navigating to Google Cloud Console...');
    await page.goto('https://console.cloud.google.com');
    await page.waitForTimeout(3000);

    // Check if we need to login
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com')) {
      console.log('Need to login to Google...');
      await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
      await page.click('button:has-text("Next")');
      await page.waitForTimeout(2000);

      await page.fill('input[type="password"]', 'Relaxing41!');
      await page.click('button:has-text("Next")');
      await page.waitForTimeout(5000);

      // Handle potential 2FA
      if (page.url().includes('challenge')) {
        console.log('2FA required - please approve on your device...');
        await page.waitForTimeout(30000); // Wait for user to approve
      }
    }

    // Step 2: Create new project
    console.log('Creating new project...');
    await page.goto('https://console.cloud.google.com/projectcreate');
    await page.waitForTimeout(3000);

    // Fill in project name
    const projectNameInput = await page.locator('input[aria-label*="Project name"]').first();
    await projectNameInput.fill('TeleClaude Gmail API');
    await page.waitForTimeout(1000);

    // Click Create
    const createButton = await page.locator('button:has-text("Create")').first();
    await createButton.click();
    console.log('Project creation initiated...');
    await page.waitForTimeout(10000); // Wait for project creation

    // Step 3: Enable Gmail API
    console.log('Navigating to Gmail API...');
    await page.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com');
    await page.waitForTimeout(3000);

    // Select the project if needed
    const projectSelector = await page.locator('[aria-label*="Select a project"]').first();
    if (await projectSelector.isVisible().catch(() => false)) {
      await projectSelector.click();
      await page.waitForTimeout(1000);
      await page.locator('text=TeleClaude Gmail API').click();
      await page.waitForTimeout(2000);
    }

    // Enable API
    const enableButton = await page.locator('button:has-text("Enable")').first();
    if (await enableButton.isVisible().catch(() => false)) {
      console.log('Enabling Gmail API...');
      await enableButton.click();
      await page.waitForTimeout(5000);
    } else {
      console.log('Gmail API already enabled');
    }

    // Step 4: Create OAuth credentials
    console.log('Creating OAuth credentials...');
    await page.goto('https://console.cloud.google.com/apis/credentials');
    await page.waitForTimeout(3000);

    // Click "Create Credentials" -> "OAuth client ID"
    const createCredButton = await page.locator('button:has-text("Create Credentials")').first();
    await createCredButton.click();
    await page.waitForTimeout(1000);

    await page.locator('text=OAuth client ID').click();
    await page.waitForTimeout(2000);

    // Configure OAuth consent screen if needed
    const configureButton = await page.locator('button:has-text("Configure Consent Screen")').first();
    if (await configureButton.isVisible().catch(() => false)) {
      console.log('Configuring OAuth consent screen...');
      await configureButton.click();
      await page.waitForTimeout(2000);

      // Select External
      await page.locator('input[value="EXTERNAL"]').click();
      await page.locator('button:has-text("Create")').click();
      await page.waitForTimeout(2000);

      // Fill in app name
      await page.fill('input[aria-label*="App name"]', 'TeleClaude Gmail');
      await page.fill('input[aria-label*="User support email"]', 'relentlessrobotics@gmail.com');
      await page.fill('input[aria-label*="Developer contact"]', 'relentlessrobotics@gmail.com');

      // Save and continue through steps
      await page.locator('button:has-text("Save and Continue")').click();
      await page.waitForTimeout(2000);

      // Skip scopes
      await page.locator('button:has-text("Save and Continue")').click();
      await page.waitForTimeout(2000);

      // Skip test users
      await page.locator('button:has-text("Save and Continue")').click();
      await page.waitForTimeout(2000);

      // Back to credentials
      await page.goto('https://console.cloud.google.com/apis/credentials');
      await page.waitForTimeout(2000);
    }

    // Now create OAuth client ID
    await page.locator('button:has-text("Create Credentials")').first().click();
    await page.waitForTimeout(1000);
    await page.locator('text=OAuth client ID').click();
    await page.waitForTimeout(2000);

    // Select Desktop app
    await page.selectOption('select[aria-label*="Application type"]', 'Desktop app');
    await page.waitForTimeout(1000);

    // Name it
    await page.fill('input[aria-label*="Name"]', 'TeleClaude Desktop');

    // Create
    await page.locator('button:has-text("Create")').click();
    await page.waitForTimeout(3000);

    // Download credentials
    console.log('Downloading credentials...');
    const downloadButton = await page.locator('button:has-text("Download JSON")').first();

    // Set up download handling
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click()
    ]);

    const credPath = path.join(__dirname, '../secure/gmail_credentials.json');
    await download.saveAs(credPath);
    console.log(`Credentials saved to: ${credPath}`);

    // Close dialog
    await page.locator('button:has-text("OK")').click();

    console.log('\n✅ Setup complete!');
    console.log('Next steps:');
    console.log('1. Run: node utils/gmail_init.js');
    console.log('2. Approve OAuth consent in browser');
    console.log('3. Copy the authorization code back to terminal');

  } catch (error) {
    console.error('Error during setup:', error.message);
    console.log('Taking screenshot for debugging...');
    await page.screenshot({ path: './screenshots/gmail_oauth_error.png', fullPage: true });
    throw error;
  } finally {
    console.log('\nPress Enter to close browser...');
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
    await browser.close();
  }
}

setupGmailOAuth().catch(console.error);
