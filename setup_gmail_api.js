/**
 * Gmail API Setup Script
 * Uses the new unified browser module to:
 * 1. Navigate to Google Cloud Console
 * 2. Handle account selection
 * 3. Create "TeleClaude Gmail" project
 * 4. Enable Gmail API
 * 5. Configure OAuth consent screen
 * 6. Create OAuth credentials
 * 7. Save credentials
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
    await discordNotify('🚀 Starting Gmail API setup...');

    // Launch browser with Google auth
    await discordNotify('Opening browser with Google authentication...');
    session = await browser.launch({
      stealth: true,
      headless: false,
      auth: 'google'
    });

    console.log('Browser launched successfully');
    await discordNotify('✅ Browser launched with saved Google auth');

    // Navigate to Google Cloud Console
    await discordNotify('Navigating to Google Cloud Console...');
    await session.goto('https://console.cloud.google.com', {
      timeout: 60000,
      waitUntil: 'domcontentloaded'
    });

    console.log('Navigated to Cloud Console');
    await session.page.waitForTimeout(5000);
    await session.screenshot('01_cloud_console_landing');

    // Check if we're on account chooser or signin page
    const currentUrl = session.page.url();
    console.log(`Current URL: ${currentUrl}`);

    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
      await discordNotify('🔐 Handling Google account selection...');
      console.log('On Google account chooser/signin page');

      // Click on the Relentless Robotics account specifically
      const accountClicked = await session.click([
        'div:has-text("relentlessrobotics@gmail.com")',
        'li:has-text("relentlessrobotics@gmail.com")',
        '[data-identifier="relentlessrobotics@gmail.com"]',
        'div[role="button"]:has-text("Relentless Robotics")'
      ], { timeout: 15000, retries: 3 });

      if (!accountClicked) {
        await session.screenshot('02_account_not_clicked');
        await discordNotify('⚠️ Could not click account. May need manual intervention.');
        throw new Error('Could not click account');
      }

      await session.page.waitForTimeout(3000);
      await session.screenshot('02_after_account_click');

      // Wait for navigation away from account chooser
      console.log('Waiting for sign-in to complete...');
      await session.page.waitForURL(url => !url.includes('accountchooser'), { timeout: 30000 }).catch(() => {
        console.log('Still on account chooser after timeout');
      });

      await session.page.waitForTimeout(5000);
      await session.screenshot('02_after_account_selection');
      await discordNotify('✅ Account selected, waiting for console to load...');

      // Check if we need to enter password
      const needsPassword = await session.page.$('input[type="password"]');
      if (needsPassword) {
        await discordNotify('🔑 Password required. Entering password...');
        await session.type('input[type="password"]', 'Relaxing41!', { timeout: 10000 });
        await session.page.waitForTimeout(1000);

        // Click Next
        await session.click([
          'button:has-text("Next")',
          'button[type="submit"]',
          '#passwordNext'
        ], { timeout: 10000 });

        await session.page.waitForTimeout(5000);
        await discordNotify('✅ Password entered');
      }
    }

    // Wait for Cloud Console to fully load
    await session.page.waitForTimeout(8000);
    await session.waitForReady({ waitForNetwork: true, timeout: 30000 });
    await session.screenshot('03_console_loaded');

    await discordNotify('📋 Cloud Console loaded. Creating new project...');

    // Click "Select a project" dropdown
    console.log('Looking for project selector...');
    const projectSelectorClicked = await session.click([
      'button[aria-label*="Select a project"]',
      'button:has-text("Select a project")',
      '[jsname="rZHESd"]',
      '.cfc-project-picker-button',
      'button.p6n-project-picker-button'
    ], { timeout: 15000, retries: 3 });

    if (!projectSelectorClicked) {
      await session.screenshot('04_project_selector_not_found');
      await discordNotify('⚠️ Could not find project selector. Taking screenshot for debugging.');
      throw new Error('Project selector button not found');
    }

    await session.page.waitForTimeout(3000);
    await session.screenshot('05_project_dropdown_open');
    await discordNotify('📂 Project selector opened');

    // Click "NEW PROJECT" button
    console.log('Looking for NEW PROJECT button...');
    const newProjectClicked = await session.click([
      'button:has-text("NEW PROJECT")',
      'a:has-text("NEW PROJECT")',
      'span:has-text("NEW PROJECT")',
      '[aria-label*="New Project"]'
    ], { timeout: 10000, retries: 3 });

    if (!newProjectClicked) {
      await session.screenshot('06_new_project_not_found');
      await discordNotify('⚠️ Could not find NEW PROJECT button. Taking screenshot.');
      throw new Error('NEW PROJECT button not found');
    }

    await session.page.waitForTimeout(3000);
    await session.screenshot('07_new_project_form');
    await discordNotify('📝 New project form opened');

    // Enter project name
    console.log('Entering project name...');
    const nameEntered = await session.type([
      'input[name="projectName"]',
      'input[aria-label*="Project name"]',
      'input#projectName'
    ], 'TeleClaude Gmail', { timeout: 10000, clear: true });

    if (!nameEntered) {
      await session.screenshot('08_project_name_not_entered');
      throw new Error('Could not enter project name');
    }

    await session.page.waitForTimeout(2000);
    await session.screenshot('09_project_name_entered');
    await discordNotify('✏️ Project name entered: "TeleClaude Gmail"');

    // Click CREATE button
    console.log('Clicking CREATE button...');
    const createClicked = await session.click([
      'button:has-text("CREATE")',
      'button[aria-label="Create"]',
      'button.mdc-button--raised:has-text("Create")'
    ], { timeout: 10000, waitForNavigation: true });

    if (!createClicked) {
      await session.screenshot('10_create_button_not_found');
      throw new Error('CREATE button not found');
    }

    await session.page.waitForTimeout(5000);
    await session.screenshot('11_project_creating');
    await discordNotify('⏳ Project creation initiated. Waiting for completion...');

    // Wait for project to be created (notification or URL change)
    console.log('Waiting for project creation...');
    await session.page.waitForTimeout(10000);
    await session.screenshot('12_project_created');

    await discordNotify('✅ Project created! Now enabling Gmail API...');

    // Navigate to API Library
    await discordNotify('📚 Navigating to API Library...');
    await session.goto('https://console.cloud.google.com/apis/library', {
      timeout: 60000
    });
    await session.page.waitForTimeout(5000);
    await session.screenshot('13_api_library');

    // Search for Gmail API
    console.log('Searching for Gmail API...');
    const searchEntered = await session.type([
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      'input[type="search"]'
    ], 'Gmail API', { timeout: 10000, pressEnter: true });

    if (!searchEntered) {
      await session.screenshot('14_search_not_found');
      throw new Error('Search box not found');
    }

    await session.page.waitForTimeout(3000);
    await session.screenshot('15_gmail_api_search_results');
    await discordNotify('🔍 Searched for Gmail API');

    // Click on Gmail API
    console.log('Clicking Gmail API...');
    const gmailApiClicked = await session.click([
      'a:has-text("Gmail API")',
      'div:has-text("Gmail API")',
      '[aria-label*="Gmail API"]'
    ], { timeout: 10000 });

    if (!gmailApiClicked) {
      await session.screenshot('16_gmail_api_not_found');
      throw new Error('Gmail API not found in search results');
    }

    await session.page.waitForTimeout(3000);
    await session.screenshot('17_gmail_api_page');
    await discordNotify('📧 Gmail API page loaded');

    // Click ENABLE button
    console.log('Enabling Gmail API...');
    const enableClicked = await session.click([
      'button:has-text("ENABLE")',
      'button:has-text("Enable")',
      'button[aria-label*="Enable"]'
    ], { timeout: 10000, waitForNavigation: true });

    if (!enableClicked) {
      await session.screenshot('18_enable_button_not_found');
      throw new Error('ENABLE button not found');
    }

    await session.page.waitForTimeout(8000);
    await session.screenshot('19_gmail_api_enabled');
    await discordNotify('✅ Gmail API enabled! Now configuring OAuth consent...');

    // Navigate to OAuth consent screen
    await discordNotify('🔐 Setting up OAuth consent screen...');
    await session.goto('https://console.cloud.google.com/apis/credentials/consent', {
      timeout: 60000
    });
    await session.page.waitForTimeout(5000);
    await session.screenshot('20_oauth_consent');

    // Select External if prompted
    console.log('Checking for user type selection...');
    const externalClicked = await session.click([
      'input[value="EXTERNAL"]',
      'label:has-text("External")',
      'md-radio-button:has-text("External")'
    ], { timeout: 10000, optional: true });

    if (externalClicked) {
      await session.page.waitForTimeout(2000);
      await session.screenshot('21_external_selected');

      // Click CREATE if needed
      await session.click([
        'button:has-text("CREATE")',
        'button:has-text("Create")'
      ], { timeout: 5000, optional: true });

      await session.page.waitForTimeout(3000);
      await discordNotify('✅ External user type selected');
    }

    await session.screenshot('22_oauth_form');

    // Fill in OAuth consent form
    console.log('Filling OAuth consent form...');

    // App name
    await session.type([
      'input[name="displayName"]',
      'input[aria-label*="App name"]'
    ], 'TeleClaude Gmail', { timeout: 10000 });

    await session.page.waitForTimeout(1000);
    await discordNotify('✏️ Entered app name');

    // User support email (should be pre-filled or dropdown)
    await session.click([
      'select[aria-label*="User support email"]',
      'input[aria-label*="User support email"]'
    ], { timeout: 5000, optional: true });
    await session.page.waitForTimeout(1000);

    // Developer contact email
    await session.type([
      'input[name="developerContact"]',
      'input[aria-label*="Developer contact"]'
    ], 'relentlessrobotics@gmail.com', { timeout: 10000 });

    await session.page.waitForTimeout(1000);
    await session.screenshot('23_oauth_form_filled');
    await discordNotify('✏️ OAuth consent form filled');

    // Scroll down and click SAVE AND CONTINUE
    await session.page.evaluate(() => window.scrollBy(0, 500));
    await session.page.waitForTimeout(1000);

    console.log('Saving OAuth consent...');
    await session.click([
      'button:has-text("SAVE AND CONTINUE")',
      'button:has-text("Save and Continue")'
    ], { timeout: 10000, retries: 3 });

    await session.page.waitForTimeout(5000);
    await session.screenshot('24_oauth_scopes_page');
    await discordNotify('✅ OAuth consent saved. Now on scopes page...');

    // Add scopes - click "ADD OR REMOVE SCOPES"
    console.log('Adding Gmail scopes...');
    const addScopesClicked = await session.click([
      'button:has-text("ADD OR REMOVE SCOPES")',
      'button:has-text("Add or Remove Scopes")'
    ], { timeout: 10000, optional: true });

    if (addScopesClicked) {
      await session.page.waitForTimeout(3000);
      await session.screenshot('25_scopes_modal');

      // Check the Gmail scopes we need
      // Look for gmail.modify or gmail.readonly
      await session.type([
        'input[placeholder*="Filter"]',
        'input[type="search"]'
      ], 'gmail', { timeout: 5000, optional: true });

      await session.page.waitForTimeout(2000);

      // Click some Gmail scope checkboxes
      const scopeCheckboxes = await session.page.$$('input[type="checkbox"]');
      if (scopeCheckboxes.length > 0) {
        await scopeCheckboxes[0].click();
        await session.page.waitForTimeout(500);
      }

      await session.screenshot('26_scopes_selected');
      await discordNotify('✅ Gmail scopes selected');

      // Click UPDATE
      await session.click([
        'button:has-text("UPDATE")',
        'button:has-text("Update")'
      ], { timeout: 10000 });

      await session.page.waitForTimeout(3000);
    }

    // Continue to next page
    await session.page.evaluate(() => window.scrollBy(0, 500));
    await session.click([
      'button:has-text("SAVE AND CONTINUE")',
      'button:has-text("Save and Continue")'
    ], { timeout: 10000, optional: true });

    await session.page.waitForTimeout(3000);
    await session.screenshot('27_oauth_complete');
    await discordNotify('✅ OAuth consent screen configured!');

    // Navigate to Credentials to create OAuth client
    await discordNotify('🔑 Creating OAuth credentials...');
    await session.goto('https://console.cloud.google.com/apis/credentials', {
      timeout: 60000
    });
    await session.page.waitForTimeout(5000);
    await session.screenshot('28_credentials_page');

    // Click "CREATE CREDENTIALS"
    console.log('Creating OAuth credentials...');
    await session.click([
      'button:has-text("CREATE CREDENTIALS")',
      'button:has-text("Create Credentials")',
      '[aria-label*="Create credentials"]'
    ], { timeout: 10000 });

    await session.page.waitForTimeout(2000);
    await session.screenshot('29_credentials_menu');

    // Select "OAuth client ID"
    await session.click([
      'span:has-text("OAuth client ID")',
      'a:has-text("OAuth client ID")',
      'button:has-text("OAuth client ID")'
    ], { timeout: 10000 });

    await session.page.waitForTimeout(3000);
    await session.screenshot('30_oauth_client_form');
    await discordNotify('📝 OAuth client ID form loaded');

    // Select application type "Desktop app"
    console.log('Selecting Desktop app type...');
    await session.click([
      'select[aria-label*="Application type"]',
      'md-select[aria-label*="Application type"]'
    ], { timeout: 10000 });

    await session.page.waitForTimeout(1000);

    await session.click([
      'md-option:has-text("Desktop app")',
      'option:has-text("Desktop app")',
      'span:has-text("Desktop app")'
    ], { timeout: 10000 });

    await session.page.waitForTimeout(2000);
    await session.screenshot('31_desktop_app_selected');
    await discordNotify('✅ Application type: Desktop app');

    // Enter name
    await session.type([
      'input[name="displayName"]',
      'input[aria-label*="Name"]'
    ], 'TeleClaude Desktop Client', { timeout: 10000 });

    await session.page.waitForTimeout(1000);
    await session.screenshot('32_client_name_entered');

    // Click CREATE
    console.log('Creating OAuth client...');
    await session.click([
      'button:has-text("CREATE")',
      'button:has-text("Create")'
    ], { timeout: 10000 });

    await session.page.waitForTimeout(5000);
    await session.screenshot('33_oauth_client_created');
    await discordNotify('✅ OAuth client created! Downloading credentials...');

    // Now we should see a modal with client ID and secret
    // Look for download button
    console.log('Looking for download button...');
    const downloadClicked = await session.click([
      'button:has-text("DOWNLOAD JSON")',
      'button:has-text("Download JSON")',
      'a:has-text("DOWNLOAD JSON")',
      '[aria-label*="Download"]'
    ], { timeout: 15000, optional: true });

    await session.page.waitForTimeout(3000);
    await session.screenshot('34_credentials_downloaded');

    if (downloadClicked) {
      await discordNotify('💾 Credentials JSON downloaded to Downloads folder!');
      console.log('Credentials downloaded successfully!');
    } else {
      // Try to copy credentials manually
      await discordNotify('⚠️ Could not auto-download. Trying to extract credentials from page...');

      // Look for client ID and secret on the page
      const bodyText = await session.page.textContent('body');
      console.log('Page text length:', bodyText.length);

      await session.screenshot('35_final_state');
    }

    await discordNotify('✅ Gmail API setup complete! Next steps:\n1. Move downloaded credentials.json to secure/gmail_credentials.json\n2. Run: node gmail_init.js\n\nBrowser will stay open for 30 seconds for you to manually download if needed.');

    // Keep browser open for manual intervention if needed
    console.log('\n=== SETUP COMPLETE ===');
    console.log('Next steps:');
    console.log('1. If credentials downloaded: Move from Downloads to secure/gmail_credentials.json');
    console.log('2. If not downloaded: Click "DOWNLOAD JSON" in the browser manually');
    console.log('3. Run: node gmail_init.js');
    console.log('\nBrowser will stay open for 30 seconds...\n');

    await session.page.waitForTimeout(30000);

  } catch (error) {
    console.error('Error during Gmail API setup:', error);
    await discordNotify(`❌ Error during setup: ${error.message}\n\nCheck console and screenshots for details.`);

    if (session) {
      await session.screenshot('error_state');
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
      console.log('Setup completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Setup failed:', error);
      process.exit(1);
    });
}

module.exports = { setupGmailAPI };
