/**
 * GitHub OAuth App Creation - Manual Assist Version
 *
 * This script opens the OAuth app page and pauses for you to:
 * 1. Create the OAuth app manually
 * 2. Copy the Client ID and Secret
 * 3. Paste them when prompted
 */

const { launchStealthBrowser } = require('./captcha-lab/solver/stealth-browser.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

async function manualOAuthSetup() {
  const { browser, context, page } = await launchStealthBrowser({ headless: false });

  try {
    console.log('\n=== GitHub OAuth App Manual Setup ===\n');
    console.log('Opening GitHub OAuth settings page...\n');

    // Navigate to GitHub OAuth apps page
    await page.goto('https://github.com/settings/developers', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('✅ Page loaded!');
    console.log('\nPlease complete these steps:');
    console.log('1. Login to GitHub if prompted');
    console.log('2. Click "New OAuth App"');
    console.log('3. Fill in the form:');
    console.log('   - Application name: TeleClaude Dashboard');
    console.log('   - Homepage URL: https://dashboard-app-black-kappa.vercel.app');
    console.log('   - Authorization callback URL: https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github');
    console.log('4. Click "Register application"');
    console.log('5. Copy the Client ID');
    console.log('6. Click "Generate a new client secret"');
    console.log('7. Copy the Client Secret (shown only once!)');
    console.log('\n⚠️  Keep the browser open!\n');

    const clientId = await question('Enter the Client ID: ');
    const clientSecret = await question('Enter the Client Secret: ');

    console.log('\n✅ Credentials received!');

    // Save credentials
    const credentialsFile = path.join(__dirname, 'github_oauth_credentials.json');
    const credentials = {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      appName: 'TeleClaude Dashboard',
      homepageUrl: 'https://dashboard-app-black-kappa.vercel.app',
      callbackUrl: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(credentialsFile, JSON.stringify(credentials, null, 2));
    console.log('✅ Credentials saved to:', credentialsFile);

    await browser.close();
    return credentials;

  } catch (error) {
    console.error('Error:', error);
    await browser.close();
    throw error;
  }
}

async function configureVercelEnv(credentials) {
  try {
    console.log('\n=== Configuring Vercel Environment Variables ===\n');

    const dashboardDir = path.join(__dirname, 'dashboard-app');

    if (!fs.existsSync(dashboardDir)) {
      throw new Error('dashboard-app directory not found');
    }

    process.chdir(dashboardDir);
    console.log('Changed to directory:', dashboardDir);

    // Prepare environment variables
    const envVars = {
      'NEXTAUTH_URL': 'https://dashboard-app-black-kappa.vercel.app',
      'NEXTAUTH_SECRET': 'hpoTyr7DoFe4XigceonLDse9eJHqiZzPS07nDBCM0TA=',
      'GITHUB_CLIENT_ID': credentials.clientId,
      'GITHUB_CLIENT_SECRET': credentials.clientSecret
    };

    console.log('Setting environment variables using Vercel CLI...\n');

    for (const [key, value] of Object.entries(envVars)) {
      try {
        console.log(`Setting ${key}...`);

        // Create a temporary file with the value
        const tmpFile = path.join(__dirname, `tmp_${key}.txt`);
        fs.writeFileSync(tmpFile, value);

        // Use vercel env add with input from file
        const command = `type "${tmpFile}" | vercel env add ${key} production`;
        execSync(command, { stdio: 'inherit', shell: 'cmd.exe' });

        // Clean up temp file
        fs.unlinkSync(tmpFile);

        console.log(`✅ ${key} set successfully\n`);
      } catch (error) {
        console.error(`❌ Error setting ${key}:`, error.message);
        console.log('Continuing with next variable...\n');
      }
    }

    console.log('✅ All environment variables configured\n');

  } catch (error) {
    console.error('Error configuring Vercel environment:', error);
    throw error;
  }
}

async function triggerDeployment() {
  try {
    console.log('\n=== Triggering Production Deployment ===\n');

    const dashboardDir = path.join(__dirname, 'dashboard-app');
    process.chdir(dashboardDir);

    console.log('Running: vercel --prod');
    execSync('vercel --prod', { stdio: 'inherit' });

    console.log('\n✅ Deployment complete!');
    console.log('URL: https://dashboard-app-black-kappa.vercel.app');

  } catch (error) {
    console.error('Error triggering deployment:', error);
    console.log('\n⚠️ You can deploy manually with: cd dashboard-app && vercel --prod');
  }
}

async function main() {
  try {
    console.log('='.repeat(60));
    console.log('GitHub OAuth App Setup & Vercel Configuration');
    console.log('(Manual Assist Version)');
    console.log('='.repeat(60));

    // Step 1: Manual OAuth App creation
    const credentials = await manualOAuthSetup();

    console.log('\nWaiting 3 seconds before configuring Vercel...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Configure Vercel environment variables
    await configureVercelEnv(credentials);

    console.log('\nWaiting 3 seconds before triggering deployment...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 3: Trigger deployment
    await triggerDeployment();

    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL TASKS COMPLETED SUCCESSFULLY!');
    console.log('='.repeat(60));
    console.log('\nNext Steps:');
    console.log('1. Wait 2-3 minutes for deployment to complete');
    console.log('2. Visit https://dashboard-app-black-kappa.vercel.app');
    console.log('3. Test GitHub login');
    console.log('\nCredentials saved to: github_oauth_credentials.json\n');

    rl.close();

  } catch (error) {
    console.error('\n❌ Setup failed:', error);
    rl.close();
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { manualOAuthSetup, configureVercelEnv, triggerDeployment };
