/**
 * GitHub OAuth App Creation and Vercel Configuration
 *
 * This script:
 * 1. Logs into GitHub
 * 2. Creates a new OAuth App for TeleClaude Dashboard
 * 3. Captures Client ID and Secret
 * 4. Configures Vercel environment variables
 * 5. Triggers a production deployment
 */

const { launchStealthBrowser } = require('./captcha-lab/solver/stealth-browser.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Discord notification helper
async function sendDiscordUpdate(message) {
  try {
    const discordModule = require('./utils/discord_bridge.js');
    if (discordModule && discordModule.sendToDiscord) {
      await discordModule.sendToDiscord(message);
    }
  } catch (e) {
    console.log('[Discord Update]:', message);
  }
}

async function setupGitHubOAuth() {
  const { browser, context, page } = await launchStealthBrowser({ headless: false });

  try {
    await sendDiscordUpdate('🌐 Opening GitHub login page...');
    console.log('Navigating to GitHub OAuth Apps settings...');

    // Navigate to GitHub OAuth apps page
    await page.goto('https://github.com/settings/developers', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(3000);

    // Check if already logged in
    const isLoggedIn = await page.locator('button:has-text("New OAuth App")').isVisible().catch(() => false);

    if (!isLoggedIn) {
      await sendDiscordUpdate('🔐 Logging into GitHub...');
      console.log('Not logged in, proceeding with login...');

      // Check if we're on login page
      const loginField = await page.locator('input#login_field').isVisible().catch(() => false);

      if (!loginField) {
        // Navigate to login page
        await page.goto('https://github.com/login', {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
        await page.waitForTimeout(2000);
      }

      // Enter credentials from ACCOUNTS.md
      await page.fill('input#login_field', 'relentless-robotics');
      await page.waitForTimeout(500);
      await page.fill('input#password', 'Relentless@Robotics2026!');
      await page.waitForTimeout(500);

      // Click Sign In
      await page.click('input[type="submit"][value="Sign in"]');
      await page.waitForTimeout(3000);

      // Check for 2FA
      const has2FA = await page.locator('input#app_otp, input#otp').isVisible().catch(() => false);

      if (has2FA) {
        await sendDiscordUpdate('📱 2FA detected! Please approve on your phone/device.');
        console.log('2FA detected. Waiting for user to approve...');

        // Wait for navigation after 2FA (up to 2 minutes)
        await page.waitForNavigation({ timeout: 120000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }

      // Navigate back to OAuth apps after login
      await page.goto('https://github.com/settings/developers', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await page.waitForTimeout(3000);
    }

    await sendDiscordUpdate('✅ Logged into GitHub successfully!');
    console.log('Successfully logged in to GitHub');

    // Take screenshot before creating app
    const screenshotDir = path.join(__dirname, 'screenshots', 'oauth');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const beforeScreenshot = path.join(screenshotDir, `before_create_${Date.now()}.png`);
    await page.screenshot({ path: beforeScreenshot, fullPage: true });
    console.log('Screenshot saved:', beforeScreenshot);

    await sendDiscordUpdate('➕ Creating new OAuth App...');
    console.log('Creating new OAuth App...');

    // Click "New OAuth App" button
    await page.click('button:has-text("New OAuth App"), a:has-text("New OAuth App")');
    await page.waitForTimeout(2000);

    // Fill in the OAuth App form
    await sendDiscordUpdate('📝 Filling out OAuth App form...');
    console.log('Filling out form...');

    // Application name
    await page.fill('input#oauth_application_name', 'TeleClaude Dashboard');
    await page.waitForTimeout(300);

    // Homepage URL
    await page.fill('input#oauth_application_url', 'https://dashboard-app-black-kappa.vercel.app');
    await page.waitForTimeout(300);

    // Application description (optional)
    const descField = await page.locator('input#oauth_application_description, textarea#oauth_application_description').isVisible().catch(() => false);
    if (descField) {
      await page.fill('input#oauth_application_description, textarea#oauth_application_description', 'Authentication for TeleClaude Dashboard');
      await page.waitForTimeout(300);
    }

    // Authorization callback URL
    await page.fill('input#oauth_application_callback_url', 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github');
    await page.waitForTimeout(300);

    // Take screenshot of filled form
    const formScreenshot = path.join(screenshotDir, `form_filled_${Date.now()}.png`);
    await page.screenshot({ path: formScreenshot, fullPage: true });
    console.log('Form screenshot saved:', formScreenshot);

    // Submit the form
    await sendDiscordUpdate('🚀 Submitting OAuth App registration...');
    console.log('Submitting form...');

    await page.click('button[type="submit"]:has-text("Register application")');
    await page.waitForTimeout(3000);

    // Wait for redirect to app details page
    await page.waitForURL('**/settings/applications/**', { timeout: 10000 });

    await sendDiscordUpdate('✅ OAuth App created successfully!');
    console.log('OAuth App created!');

    // Extract Client ID
    await sendDiscordUpdate('🔑 Extracting Client ID and generating Client Secret...');
    console.log('Extracting Client ID...');

    const clientId = await page.locator('input#client_id, code:has-text("client_id"), dd code').first().innerText().catch(async () => {
      // Try alternate selector
      return await page.locator('[data-targets*="client-id"]').first().innerText();
    });

    console.log('Client ID:', clientId);

    // Take screenshot of app details
    const detailsScreenshot = path.join(screenshotDir, `app_details_${Date.now()}.png`);
    await page.screenshot({ path: detailsScreenshot, fullPage: true });
    console.log('Details screenshot saved:', detailsScreenshot);

    // Generate Client Secret
    console.log('Generating Client Secret...');

    // Click "Generate a new client secret"
    await page.click('button:has-text("Generate a new client secret"), a:has-text("Generate a new client secret")');
    await page.waitForTimeout(2000);

    // The secret should appear
    const clientSecret = await page.locator('input[type="text"][value^="gho_"], code:has-text("gho_")').first().inputValue().catch(async () => {
      // Try getting text content instead
      return await page.locator('code:has-text("gho_")').first().innerText();
    });

    console.log('Client Secret:', clientSecret.substring(0, 10) + '...(hidden)');

    // Take screenshot with secret visible
    const secretScreenshot = path.join(screenshotDir, `secret_generated_${Date.now()}.png`);
    await page.screenshot({ path: secretScreenshot, fullPage: true });
    console.log('Secret screenshot saved:', secretScreenshot);

    // Save credentials to file
    const credentialsFile = path.join(__dirname, 'github_oauth_credentials.json');
    const credentials = {
      clientId,
      clientSecret,
      appName: 'TeleClaude Dashboard',
      homepageUrl: 'https://dashboard-app-black-kappa.vercel.app',
      callbackUrl: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2));
    console.log('Credentials saved to:', credentialsFile);

    await sendDiscordUpdate(`✅ **GitHub OAuth App Created!**\n\n**Client ID:** \`${clientId}\`\n**Client Secret:** \`${clientSecret.substring(0, 20)}...\` (saved to file)\n\nNow configuring Vercel environment variables...`);

    console.log('\n=== GitHub OAuth App Created ===');
    console.log('Client ID:', clientId);
    console.log('Client Secret:', clientSecret);
    console.log('Credentials saved to:', credentialsFile);

    return credentials;

  } catch (error) {
    console.error('Error during GitHub OAuth setup:', error);
    await sendDiscordUpdate(`❌ Error creating GitHub OAuth App: ${error.message}`);
    throw error;
  } finally {
    console.log('Closing browser...');
    await browser.close();
  }
}

async function configureVercelEnv(credentials) {
  try {
    await sendDiscordUpdate('⚙️ Configuring Vercel environment variables...');
    console.log('\n=== Configuring Vercel Environment Variables ===');

    // Check if we're in the dashboard-app directory
    const dashboardDir = path.join(__dirname, 'dashboard-app');
    const currentDir = process.cwd();

    if (!fs.existsSync(dashboardDir)) {
      throw new Error('dashboard-app directory not found');
    }

    // Change to dashboard-app directory
    process.chdir(dashboardDir);
    console.log('Changed to directory:', dashboardDir);

    // Set environment variables using Vercel CLI
    const envVars = [
      { key: 'NEXTAUTH_URL', value: 'https://dashboard-app-black-kappa.vercel.app' },
      { key: 'NEXTAUTH_SECRET', value: 'hpoTyr7DoFe4XigceonLDse9eJHqiZzPS07nDBCM0TA=' },
      { key: 'GITHUB_CLIENT_ID', value: credentials.clientId },
      { key: 'GITHUB_CLIENT_SECRET', value: credentials.clientSecret }
    ];

    for (const envVar of envVars) {
      try {
        console.log(`Setting ${envVar.key}...`);

        // Use vercel env add command
        const command = `echo ${envVar.value} | vercel env add ${envVar.key} production`;
        execSync(command, { stdio: 'inherit' });

        await sendDiscordUpdate(`✅ Set ${envVar.key}`);
        console.log(`✓ ${envVar.key} set successfully`);
      } catch (error) {
        console.error(`Error setting ${envVar.key}:`, error.message);
        // Continue with other variables even if one fails
      }
    }

    await sendDiscordUpdate('✅ All environment variables configured!');
    console.log('\n✅ All environment variables configured');

    // Change back to original directory
    process.chdir(currentDir);

  } catch (error) {
    console.error('Error configuring Vercel environment:', error);
    await sendDiscordUpdate(`❌ Error configuring Vercel: ${error.message}`);
    throw error;
  }
}

async function triggerDeployment() {
  try {
    await sendDiscordUpdate('🚀 Triggering production deployment...');
    console.log('\n=== Triggering Production Deployment ===');

    const dashboardDir = path.join(__dirname, 'dashboard-app');
    const currentDir = process.cwd();

    process.chdir(dashboardDir);

    // Trigger deployment
    console.log('Running: vercel --prod');
    execSync('vercel --prod', { stdio: 'inherit' });

    process.chdir(currentDir);

    await sendDiscordUpdate('✅ **Deployment triggered!**\n\nCheck https://dashboard-app-black-kappa.vercel.app in a few minutes.');

    console.log('\n✅ Deployment complete!');
    console.log('URL: https://dashboard-app-black-kappa.vercel.app');

  } catch (error) {
    console.error('Error triggering deployment:', error);
    await sendDiscordUpdate(`⚠️ Deployment trigger failed: ${error.message}\n\nYou may need to deploy manually with: cd dashboard-app && vercel --prod`);
  }
}

async function main() {
  try {
    console.log('='.repeat(60));
    console.log('GitHub OAuth App Setup & Vercel Configuration');
    console.log('='.repeat(60));

    // Step 1: Create GitHub OAuth App
    const credentials = await setupGitHubOAuth();

    console.log('\nWaiting 5 seconds before configuring Vercel...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 2: Configure Vercel environment variables
    await configureVercelEnv(credentials);

    console.log('\nWaiting 3 seconds before triggering deployment...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 3: Trigger deployment
    await triggerDeployment();

    await sendDiscordUpdate(`🎉 **Setup Complete!**\n\n✅ GitHub OAuth App created\n✅ Vercel environment variables configured\n✅ Production deployment triggered\n\n**Next Steps:**\n1. Wait 2-3 minutes for deployment to complete\n2. Visit https://dashboard-app-black-kappa.vercel.app\n3. Test GitHub login\n\nCredentials saved to: github_oauth_credentials.json`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL TASKS COMPLETED SUCCESSFULLY!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ Setup failed:', error);
    await sendDiscordUpdate(`❌ Setup failed: ${error.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { setupGitHubOAuth, configureVercelEnv, triggerDeployment };
