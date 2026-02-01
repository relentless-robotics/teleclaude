/**
 * Gmail API Setup Script - Manual Login Version
 *
 * This version assumes you've already logged into Google manually.
 * Just start at Cloud Console and automate the project creation.
 */

const browser = require('./utils/browser');
const fs = require('fs');
const path = require('path');

// Discord notification helper
const discordNotify = async (message) => {
  try {
    const { mcp__discord__send_to_discord } = require('./mcp/discord');
    if (typeof mcp__discord__send_to_discord === 'function') {
      await mcp__discord__send_to_discord({ message });
    } else {
      console.log(`[Discord] ${message}`);
    }
  } catch (error) {
    console.log(`[Discord] ${message}`);
  }
};

async function setupGmailAPI() {
  let session = null;

  try {
    await discordNotify('🚀 Starting Gmail API setup (manual login version)...');

    // Launch browser WITHOUT auth - fresh start
    await discordNotify('Opening browser... Please log in to Google manually if prompted.');
    session = await browser.launch({
      stealth: true,
      headless: false,
      // No auth parameter - fresh browser
    });

    console.log('Browser launched successfully');
    await discordNotify('✅ Browser launched. Opening Cloud Console...');

    // Navigate to Google Cloud Console
    await discordNotify('Navigating to Google Cloud Console...');
    await session.goto('https://console.cloud.google.com', {
      timeout: 60000,
      waitUntil: 'domcontentloaded'
    });

    console.log('Navigated to Cloud Console');
    await session.page.waitForTimeout(10000); // Give time for manual login if needed
    await session.screenshot('01_cloud_console_initial');

    await discordNotify('⏸️ Please ensure you are logged in. Script will continue in 10 seconds...');
    await session.page.waitForTimeout(10000);

    await session.screenshot('02_before_project_creation');
    await discordNotify('📋 Proceeding with project creation...');

    // Go directly to new project page
    await discordNotify('📝 Opening "New Project" page directly...');
    await session.goto('https://console.cloud.google.com/projectcreate', {
      timeout: 60000
    });

    await session.page.waitForTimeout(5000);
    await session.screenshot('03_new_project_page');
    await discordNotify('✏️ New project form opened');

    // Enter project name
    console.log('Entering project name...');
    const nameEntered = await session.type([
      'input[name="projectName"]',
      'input[aria-label*="Project name"]',
      'input#projectName',
      'input[placeholder*="project name"]'
    ], 'TeleClaude Gmail', { timeout: 15000, clear: true });

    if (!nameEntered) {
      await session.screenshot('04_project_name_field_not_found');
      await discordNotify('⚠️ Could not find project name field. See screenshot.');
      throw new Error('Could not enter project name');
    }

    await session.page.waitForTimeout(2000);
    await session.screenshot('05_project_name_entered');
    await discordNotify('✏️ Project name entered: "TeleClaude Gmail"');

    // Click CREATE button
    console.log('Clicking CREATE button...');
    const createClicked = await session.click([
      'button:has-text("CREATE")',
      'button:has-text("Create")',
      'button[aria-label*="Create"]',
      'button.mdc-button--raised'
    ], { timeout: 15000, retries: 3 });

    if (!createClicked) {
      await session.screenshot('06_create_button_not_found');
      await discordNotify('⚠️ Could not find CREATE button. See screenshot.');
      throw new Error('CREATE button not found');
    }

    await session.page.waitForTimeout(3000);
    await session.screenshot('07_project_creating');
    await discordNotify('⏳ Project creation initiated. Waiting for completion...');

    // Wait for project to be created
    console.log('Waiting for project creation (30 seconds)...');
    await session.page.waitForTimeout(30000);
    await session.screenshot('08_project_created');
    await discordNotify('✅ Project should be created. Now enabling Gmail API...');

    // Navigate to API Library with project context
    await discordNotify('📚 Navigating to API Library...');
    await session.goto('https://console.cloud.google.com/apis/library', {
      timeout: 60000
    });
    await session.page.waitForTimeout(5000);
    await session.screenshot('09_api_library');

    // Search for Gmail API
    console.log('Searching for Gmail API...');
    const searchEntered = await session.type([
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      'input[type="search"]',
      'input.p6n-search-input'
    ], 'Gmail API', { timeout: 15000, clear: true, pressEnter: false });

    if (searchEntered) {
      await session.page.waitForTimeout(1000);
      await session.page.keyboard.press('Enter');
      await session.page.waitForTimeout(3000);
      await session.screenshot('10_gmail_api_search_results');
      await discordNotify('🔍 Searched for Gmail API');
    }

    // Click on Gmail API result
    console.log('Clicking Gmail API...');
    const gmailApiClicked = await session.click([
      'a:has-text("Gmail API")',
      'div:has-text("Gmail API")',
      'span:has-text("Gmail API")'
    ], { timeout: 15000, retries: 3 });

    if (!gmailApiClicked) {
      await session.screenshot('11_gmail_api_not_found');
      await discordNotify('⚠️ Could not find Gmail API in results. See screenshot.');
      throw new Error('Gmail API not found in search results');
    }

    await session.page.waitForTimeout(5000);
    await session.screenshot('12_gmail_api_page');
    await discordNotify('📧 Gmail API page loaded');

    // Click ENABLE button
    console.log('Enabling Gmail API...');
    const enableClicked = await session.click([
      'button:has-text("ENABLE")',
      'button:has-text("Enable")',
      'button[aria-label*="Enable"]'
    ], { timeout: 15000, retries: 3 });

    if (!enableClicked) {
      await session.screenshot('13_enable_button_not_found');
      await discordNotify('⚠️ Could not find ENABLE button. API may already be enabled.');
    } else {
      await session.page.waitForTimeout(10000);
      await session.screenshot('14_gmail_api_enabled');
      await discordNotify('✅ Gmail API enabled!');
    }

    // Navigate to OAuth consent screen
    await discordNotify('🔐 Setting up OAuth consent screen...');
    await session.goto('https://console.cloud.google.com/apis/credentials/consent', {
      timeout: 60000
    });
    await session.page.waitForTimeout(5000);
    await session.screenshot('15_oauth_consent');

    // Check if we need to configure consent screen
    const needsConfig = await session.page.$('button:has-text("CONFIGURE CONSENT SCREEN")').catch(() => null);

    if (needsConfig) {
      await discordNotify('📝 Configuring OAuth consent screen...');

      // Select External
      const externalClicked = await session.click([
        'input[value="EXTERNAL"]',
        'label:has-text("External")'
      ], { timeout: 10000, optional: true });

      if (externalClicked) {
        await session.page.waitForTimeout(2000);
        await session.click([
          'button:has-text("CREATE")',
          'button:has-text("Create")'
        ], { timeout: 10000, optional: true });
        await session.page.waitForTimeout(3000);
      }

      // Fill OAuth form
      await session.type([
        'input[name="displayName"]',
        'input[aria-label*="App name"]'
      ], 'TeleClaude Gmail', { timeout: 10000, optional: true });

      await session.page.waitForTimeout(1000);

      await session.type([
        'input[name="developerContact"]',
        'input[aria-label*="Developer contact"]'
      ], 'relentlessrobotics@gmail.com', { timeout: 10000, optional: true });

      await session.page.waitForTimeout(1000);
      await session.screenshot('16_oauth_form_filled');

      // Save and continue
      await session.page.evaluate(() => window.scrollBy(0, 500));
      await session.page.waitForTimeout(1000);

      await session.click([
        'button:has-text("SAVE AND CONTINUE")',
        'button:has-text("Save and Continue")'
      ], { timeout: 15000, optional: true });

      await session.page.waitForTimeout(5000);
      await discordNotify('✅ OAuth consent configured');
    }

    // Navigate to Credentials page
    await discordNotify('🔑 Creating OAuth credentials...');
    await session.goto('https://console.cloud.google.com/apis/credentials', {
      timeout: 60000
    });
    await session.page.waitForTimeout(5000);
    await session.screenshot('17_credentials_page');

    // Click "CREATE CREDENTIALS"
    console.log('Creating OAuth credentials...');
    const createCredsClicked = await session.click([
      'button:has-text("CREATE CREDENTIALS")',
      'button:has-text("Create Credentials")',
      'button[aria-label*="Create credentials"]'
    ], { timeout: 15000, retries: 3 });

    if (!createCredsClicked) {
      await session.screenshot('18_create_creds_not_found');
      await discordNotify('⚠️ Could not find CREATE CREDENTIALS button.');
      throw new Error('CREATE CREDENTIALS button not found');
    }

    await session.page.waitForTimeout(2000);
    await session.screenshot('19_credentials_menu');

    // Select "OAuth client ID"
    const oauthClicked = await session.click([
      'span:has-text("OAuth client ID")',
      'a:has-text("OAuth client ID")',
      'div:has-text("OAuth client ID")'
    ], { timeout: 15000, retries: 3 });

    if (!oauthClicked) {
      await session.screenshot('20_oauth_option_not_found');
      await discordNotify('⚠️ Could not find OAuth client ID option.');
      throw new Error('OAuth client ID option not found');
    }

    await session.page.waitForTimeout(5000);
    await session.screenshot('21_oauth_client_form');
    await discordNotify('📝 OAuth client ID form loaded');

    // Select application type "Desktop app"
    console.log('Selecting Desktop app type...');
    const typeDropdown = await session.click([
      'select[aria-label*="Application type"]',
      'md-select[aria-label*="Application type"]',
      'div[aria-label*="Application type"]'
    ], { timeout: 15000, optional: true });

    if (typeDropdown) {
      await session.page.waitForTimeout(1000);

      await session.click([
        'md-option:has-text("Desktop app")',
        'option:has-text("Desktop app")',
        'div:has-text("Desktop app")'
      ], { timeout: 10000, optional: true });

      await session.page.waitForTimeout(2000);
      await session.screenshot('22_desktop_app_selected');
      await discordNotify('✅ Application type: Desktop app');
    }

    // Enter name
    await session.type([
      'input[name="displayName"]',
      'input[aria-label*="Name"]',
      'input[placeholder*="name"]'
    ], 'TeleClaude Desktop Client', { timeout: 15000, optional: true });

    await session.page.waitForTimeout(1000);
    await session.screenshot('23_client_name_entered');

    // Click CREATE
    console.log('Creating OAuth client...');
    const finalCreateClicked = await session.click([
      'button:has-text("CREATE")',
      'button:has-text("Create")',
      'button[type="submit"]'
    ], { timeout: 15000, retries: 3 });

    if (!finalCreateClicked) {
      await session.screenshot('24_final_create_not_found');
      await discordNotify('⚠️ Could not find final CREATE button.');
      throw new Error('Final CREATE button not found');
    }

    await session.page.waitForTimeout(5000);
    await session.screenshot('25_oauth_client_created');
    await discordNotify('✅ OAuth client created! Looking for download button...');

    // Download credentials
    console.log('Looking for download button...');
    await session.page.waitForTimeout(2000);

    const downloadClicked = await session.click([
      'button:has-text("DOWNLOAD JSON")',
      'button:has-text("Download JSON")',
      'a:has-text("DOWNLOAD")',
      'button[aria-label*="Download"]'
    ], { timeout: 15000, optional: true });

    await session.page.waitForTimeout(3000);
    await session.screenshot('26_final_state');

    if (downloadClicked) {
      await discordNotify('💾 Credentials JSON downloaded! Check your Downloads folder.');
    } else {
      await discordNotify('⚠️ Could not auto-download. Please click DOWNLOAD JSON manually in the browser.');
    }

    await discordNotify('✅ Setup complete! Next steps:\n1. Find the downloaded credentials.json in your Downloads folder\n2. Move it to: C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\secure\\gmail_credentials.json\n3. Run: node gmail_init.js\n\nBrowser will stay open for 60 seconds for manual actions...');

    console.log('\n=== SETUP COMPLETE ===');
    console.log('Next steps:');
    console.log('1. Move downloaded credentials.json to: secure/gmail_credentials.json');
    console.log('2. Run: node gmail_init.js');
    console.log('\nBrowser staying open for 60 seconds...\n');

    await session.page.waitForTimeout(60000);

  } catch (error) {
    console.error('Error during Gmail API setup:', error);
    await discordNotify(`❌ Error: ${error.message}\n\nCheck screenshots in: screenshots/browser/`);

    if (session) {
      await session.screenshot('error_final');
    }

    // Keep browser open on error
    console.log('\nError occurred. Browser will stay open for 60 seconds for inspection...');
    if (session) {
      await session.page.waitForTimeout(60000);
    }

    throw error;

  } finally {
    if (session) {
      console.log('Closing browser...');
      await session.close();
    }
  }
}

// Run if called directly
if (require.main === module) {
  setupGmailAPI()
    .then(() => {
      console.log('Setup completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Setup failed:', error.message);
      process.exit(1);
    });
}

module.exports = { setupGmailAPI };
