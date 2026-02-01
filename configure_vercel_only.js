/**
 * Configure Vercel Environment Variables Only
 *
 * Usage: node configure_vercel_only.js <CLIENT_ID> <CLIENT_SECRET>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function configureVercelEnv(clientId, clientSecret) {
  try {
    console.log('\n=== Configuring Vercel Environment Variables ===\n');

    const dashboardDir = path.join(__dirname, 'dashboard-app');
    const currentDir = process.cwd();

    if (!fs.existsSync(dashboardDir)) {
      throw new Error('dashboard-app directory not found at: ' + dashboardDir);
    }

    console.log('Dashboard directory:', dashboardDir);

    // Save credentials first
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
    console.log('✅ Credentials saved to:', credentialsFile);

    // Change to dashboard-app directory
    process.chdir(dashboardDir);
    console.log('Working directory:', process.cwd());

    // Environment variables to set
    const envVars = {
      'NEXTAUTH_URL': 'https://dashboard-app-black-kappa.vercel.app',
      'NEXTAUTH_SECRET': 'hpoTyr7DoFe4XigceonLDse9eJHqiZzPS07nDBCM0TA=',
      'GITHUB_CLIENT_ID': clientId,
      'GITHUB_CLIENT_SECRET': clientSecret
    };

    console.log('\n📝 Setting environment variables...\n');

    for (const [key, value] of Object.entries(envVars)) {
      try {
        console.log(`Setting ${key}...`);

        // Create temp file with value
        const tmpFile = path.join(__dirname, `tmp_env_${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, value);

        try {
          // Try to use vercel env add
          const command = `type "${tmpFile}" | vercel env add ${key} production`;
          execSync(command, { stdio: 'inherit', shell: 'cmd.exe' });
          console.log(`✅ ${key} set`);
        } catch (e) {
          console.log(`⚠️ May already exist or error: ${e.message}`);
        }

        // Clean up temp file
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }

      } catch (error) {
        console.error(`❌ Error with ${key}:`, error.message);
      }
    }

    // Change back
    process.chdir(currentDir);

    console.log('\n✅ Environment variables configured!');

    return credentials;

  } catch (error) {
    console.error('\n❌ Error:', error);
    throw error;
  }
}

async function triggerDeployment() {
  try {
    console.log('\n=== Triggering Production Deployment ===\n');

    const dashboardDir = path.join(__dirname, 'dashboard-app');
    const currentDir = process.cwd();

    process.chdir(dashboardDir);

    console.log('Running: vercel --prod');
    console.log('This may take a few minutes...\n');

    execSync('vercel --prod', { stdio: 'inherit' });

    process.chdir(currentDir);

    console.log('\n✅ Deployment triggered successfully!');
    console.log('🌐 URL: https://dashboard-app-black-kappa.vercel.app');
    console.log('\nWait 2-3 minutes for deployment to complete, then test GitHub login.');

  } catch (error) {
    console.error('❌ Deployment error:', error.message);
    console.log('\n⚠️ You can deploy manually with:');
    console.log('   cd dashboard-app');
    console.log('   vercel --prod');
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('\nUsage: node configure_vercel_only.js <CLIENT_ID> <CLIENT_SECRET>');
    console.error('\nExample:');
    console.error('  node configure_vercel_only.js Ov23li... gho_abc123...\n');
    process.exit(1);
  }

  const clientId = args[0].trim();
  const clientSecret = args[1].trim();

  console.log('='.repeat(60));
  console.log('Vercel Configuration & Deployment');
  console.log('='.repeat(60));
  console.log('\nClient ID:', clientId);
  console.log('Client Secret:', clientSecret.substring(0, 10) + '...(hidden)');

  try {
    // Configure Vercel
    await configureVercelEnv(clientId, clientSecret);

    console.log('\nWaiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Trigger deployment
    await triggerDeployment();

    console.log('\n' + '='.repeat(60));
    console.log('✅ SETUP COMPLETE!');
    console.log('='.repeat(60));
    console.log('\nNext steps:');
    console.log('1. Wait 2-3 minutes for deployment');
    console.log('2. Visit https://dashboard-app-black-kappa.vercel.app');
    console.log('3. Test GitHub OAuth login\n');

  } catch (error) {
    console.error('\n❌ Failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { configureVercelEnv, triggerDeployment };
