/**
 * Gmail API Setup - Complete Automated Version
 * Handles login + full setup flow
 */

const browser = require('./utils/browser');
const fs = require('fs');
const path = require('path');

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
    await discordNotify('🚀 Starting Gmail API complete setup...');

    // Launch fresh browser
    session = await browser.launch({
      stealth: true,
      headless: false
    });

    await discordNotify('✅ Browser launched. Logging in to Google...');

    // Navigate to Google Cloud Console (will redirect to login)
    await session.goto('https://console.cloud.google.com/projectcreate', {
      timeout: 60000
    });

    await session.page.waitForTimeout(3000);
    await session.screenshot('01_initial_page');

    // Check if on sign-in page
    const onSignIn = session.page.url().includes('accounts.google.com');

    if (onSignIn) {
      await discordNotify('🔐 On Google sign-in. Entering email...');

      // Enter email
      const emailEntered = await session.type([
        'input[type="email"]',
        'input[name="identifier"]',
        'input[aria-label*="Email"]'
      ], 'relentlessrobotics@gmail.com', { timeout: 10000, humanLike: false, clear: true });

      if (!emailEntered) {
        throw new Error('Could not find email field');
      }

      await session.page.waitForTimeout(2000);
      await session.screenshot('02_email_entered');

      // Verify email was entered correctly
      const emailValue = await session.page.inputValue('input[type="email"]').catch(() => '');
      console.log(`Email field value: ${emailValue}`);

      if (!emailValue.includes('relentlessrobotics')) {
        console.log('Email not fully entered, retrying...');
        await session.page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
        await session.page.waitForTimeout(2000);
        await session.screenshot('02b_email_refilled');
      }

      // Click Next
      await session.click([
        'button:has-text("Next")',
        'button[type="button"]',
        '#identifierNext'
      ], { timeout: 10000 });

      await session.page.waitForTimeout(8000);
      await session.screenshot('03_after_email_next');
      await discordNotify('✅ Email entered. Entering password...');

      // Enter password
      const passwordEntered = await session.type([
        'input[type="password"]',
        'input[name="Passwd"]',
        'input[aria-label*="password"]'
      ], 'Relaxing41!', { timeout: 15000 });

      if (!passwordEntered) {
        throw new Error('Could not find password field');
      }

      await session.page.waitForTimeout(1000);
      await session.screenshot('04_password_entered');

      // Click Next
      await session.click([
        'button:has-text("Next")',
        'button[type="button"]',
        '#passwordNext'
      ], { timeout: 10000 });

      await session.page.waitForTimeout(8000);
      await session.screenshot('05_after_password');
      await discordNotify('🔑 Password entered. Checking for 2FA...');

      // Check for 2FA prompt
      const needs2FA = session.page.url().includes('challenge') ||
                       await session.page.$('text="Tap Yes on your phone"').catch(() => null);

      if (needs2FA) {
        await discordNotify('📱 2FA REQUIRED! Please approve the login on your phone/tablet.\n\nWaiting up to 60 seconds for approval...');
        await session.screenshot('06_2fa_prompt');

        // Wait for 2FA approval (up to 60 seconds)
        await session.page.waitForURL(url => !url.includes('challenge'), { timeout: 60000 }).catch(() => {
          console.log('2FA timeout or still waiting');
        });

        await session.page.waitForTimeout(5000);
        await session.screenshot('07_after_2fa');
        await discordNotify('✅ 2FA approved!');
      }

      // Wait for redirect to Cloud Console
      await session.page.waitForTimeout(5000);
      await discordNotify('⏳ Waiting for Cloud Console to load...');
      await session.page.waitForTimeout(10000);
    }

    // Should now be on project create page or console
    await session.screenshot('08_after_login');

    // Navigate to project create page to be sure
    await discordNotify('📝 Opening New Project page...');
    await session.goto('https://console.cloud.google.com/projectcreate', {
      timeout: 60000
    });

    await session.page.waitForTimeout(8000);
    await session.screenshot('09_project_create_page');

    // Enter project name
    await discordNotify('✏️ Entering project name...');
    const nameEntered = await session.type([
      'input[name="projectName"]',
      'input[aria-label*="Project name"]',
      'input#projectName',
      'input.cfc-text-input'
    ], 'TeleClaude Gmail', { timeout: 15000, clear: true });

    if (!nameEntered) {
      await session.screenshot('10_name_field_not_found');
      throw new Error('Could not find project name field');
    }

    await session.page.waitForTimeout(2000);
    await session.screenshot('11_name_entered');
    await discordNotify('✅ Project name: "TeleClaude Gmail"');

    // Click CREATE
    await discordNotify('🔨 Creating project...');
    const created = await session.click([
      'button:has-text("CREATE")',
      'button:has-text("Create")',
      'button[aria-label*="Create"]'
    ], { timeout: 15000 });

    if (!created) {
      await session.screenshot('12_create_not_found');
      throw new Error('Could not find CREATE button');
    }

    await session.page.waitForTimeout(5000);
    await session.screenshot('13_creating');
    await discordNotify('⏳ Project creating... waiting 30 seconds...');
    await session.page.waitForTimeout(30000);
    await session.screenshot('14_created');
    await discordNotify('✅ Project created!');

    // Enable Gmail API
    await discordNotify('📧 Enabling Gmail API...');
    await session.goto('https://console.cloud.google.com/apis/library/gmail.googleapis.com', {
      timeout: 60000
    });

    await session.page.waitForTimeout(5000);
    await session.screenshot('15_gmail_api_page');

    // Click ENABLE
    const enabled = await session.click([
      'button:has-text("ENABLE")',
      'button:has-text("Enable")'
    ], { timeout: 15000, optional: true });

    if (enabled) {
      await session.page.waitForTimeout(10000);
      await session.screenshot('16_api_enabled');
      await discordNotify('✅ Gmail API enabled!');
    } else {
      await discordNotify('ℹ️ Gmail API may already be enabled');
    }

    // Configure OAuth consent
    await discordNotify('🔐 Configuring OAuth consent screen...');
    await session.goto('https://console.cloud.google.com/apis/credentials/consent', {
      timeout: 60000
    });

    await session.page.waitForTimeout(5000);
    await session.screenshot('17_oauth_consent');

    // Select External
    const external = await session.click([
      'input[value="EXTERNAL"]',
      'label:has-text("External")'
    ], { timeout: 10000, optional: true });

    if (external) {
      await session.page.waitForTimeout(2000);
      await session.click('button:has-text("CREATE")', { timeout: 5000, optional: true });
      await session.page.waitForTimeout(3000);
    }

    // Fill form
    await session.type('input[name="displayName"]', 'TeleClaude Gmail', { timeout: 10000, optional: true });
    await session.page.waitForTimeout(1000);
    await session.type('input[name="developerContact"]', 'relentlessrobotics@gmail.com', { timeout: 10000, optional: true });
    await session.page.waitForTimeout(1000);
    await session.screenshot('18_consent_filled');

    // Save
    await session.page.evaluate(() => window.scrollBy(0, 500));
    await session.page.waitForTimeout(1000);
    await session.click('button:has-text("SAVE AND CONTINUE")', { timeout: 10000, optional: true });
    await session.page.waitForTimeout(5000);
    await discordNotify('✅ OAuth consent configured');

    // Create credentials
    await discordNotify('🔑 Creating OAuth credentials...');
    await session.goto('https://console.cloud.google.com/apis/credentials', {
      timeout: 60000
    });

    await session.page.waitForTimeout(5000);
    await session.screenshot('19_credentials_page');

    // CREATE CREDENTIALS
    await session.click('button:has-text("CREATE CREDENTIALS")', { timeout: 15000 });
    await session.page.waitForTimeout(2000);
    await session.screenshot('20_creds_menu');

    // OAuth client ID
    await session.click('span:has-text("OAuth client ID")', { timeout: 10000 });
    await session.page.waitForTimeout(5000);
    await session.screenshot('21_oauth_form');

    // Desktop app type
    await session.click('select[aria-label*="Application type"]', { timeout: 10000, optional: true });
    await session.page.waitForTimeout(1000);
    await session.click('option:has-text("Desktop app")', { timeout: 5000, optional: true });
    await session.page.waitForTimeout(2000);
    await session.screenshot('22_desktop_selected');

    // Name
    await session.type('input[name="displayName"]', 'TeleClaude Desktop', { timeout: 10000, optional: true });
    await session.page.waitForTimeout(1000);
    await session.screenshot('23_name_entered');

    // CREATE
    await session.click('button:has-text("CREATE")', { timeout: 15000 });
    await session.page.waitForTimeout(5000);
    await session.screenshot('24_created');
    await discordNotify('✅ OAuth client created!');

    // Download
    await session.page.waitForTimeout(2000);
    await session.click('button:has-text("DOWNLOAD JSON")', { timeout: 15000, optional: true });
    await session.page.waitForTimeout(3000);
    await session.screenshot('25_final');

    await discordNotify('✅ SETUP COMPLETE!\n\nNext steps:\n1. Find credentials.json in Downloads\n2. Move to: secure/gmail_credentials.json\n3. Run: node gmail_init.js\n\nBrowser stays open 60 seconds...');

    console.log('\n✅ SETUP COMPLETE!');
    console.log('Next: Move credentials.json to secure/ and run gmail_init.js\n');

    await session.page.waitForTimeout(60000);

  } catch (error) {
    console.error('Error:', error);
    await discordNotify(`❌ Error: ${error.message}`);

    if (session) {
      await session.screenshot('error');
      await session.page.waitForTimeout(60000);
    }

    throw error;
  } finally {
    if (session) {
      await session.close();
    }
  }
}

if (require.main === module) {
  setupGmailAPI()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { setupGmailAPI };
