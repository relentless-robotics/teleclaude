// Script to deploy dashboard to Vercel
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Starting Vercel deployment...\n');

// Check that .env.local has real keys
const envPath = path.join(__dirname, 'dashboard-app', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');

if (envContent.includes('REPLACE_WITH_YOUR_KEY')) {
  console.error('❌ Error: .env.local still contains placeholder keys');
  console.error('Please run update-clerk-env.js first with your actual Clerk keys');
  process.exit(1);
}

// Extract keys from .env.local
const publishableKeyMatch = envContent.match(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=(pk_[^\s]+)/);
const secretKeyMatch = envContent.match(/CLERK_SECRET_KEY=(sk_[^\s]+)/);
const allowedEmailMatch = envContent.match(/ALLOWED_EMAIL=([^\s]+)/);
const dataRootMatch = envContent.match(/DATA_ROOT=([^\s]+)/);

if (!publishableKeyMatch || !secretKeyMatch) {
  console.error('❌ Error: Could not extract Clerk keys from .env.local');
  process.exit(1);
}

const publishableKey = publishableKeyMatch[1];
const secretKey = secretKeyMatch[1];
const allowedEmail = allowedEmailMatch ? allowedEmailMatch[1] : 'football2nick@gmail.com';
const dataRoot = dataRootMatch ? dataRootMatch[1] : 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main';

console.log('✅ Found Clerk keys in .env.local');
console.log(`   Publishable: ${publishableKey.substring(0, 20)}...`);
console.log(`   Secret: ${secretKey.substring(0, 15)}...`);
console.log(`   Allowed Email: ${allowedEmail}`);
console.log(`   Data Root: ${dataRoot}\n`);

try {
  // Change to dashboard directory
  process.chdir(path.join(__dirname, 'dashboard-app'));

  console.log('📦 Running build test first...');
  try {
    execSync('npm run build', { stdio: 'inherit' });
    console.log('✅ Build successful!\n');
  } catch (buildError) {
    console.error('❌ Build failed. Please fix errors before deploying.');
    process.exit(1);
  }

  console.log('🚀 Deploying to Vercel...');
  console.log('This will:');
  console.log('  1. Deploy the application');
  console.log('  2. Set environment variables');
  console.log('  3. Return deployment URL\n');

  // Deploy with environment variables
  const deployCmd = `vercel --prod --yes ` +
    `-e NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${publishableKey}" ` +
    `-e CLERK_SECRET_KEY="${secretKey}" ` +
    `-e NEXT_PUBLIC_CLERK_SIGN_IN_URL="/sign-in" ` +
    `-e NEXT_PUBLIC_CLERK_SIGN_UP_URL="/sign-up" ` +
    `-e NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL="/" ` +
    `-e NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL="/" ` +
    `-e ALLOWED_EMAIL="${allowedEmail}" ` +
    `-e DATA_ROOT="${dataRoot}"`;

  console.log('Running deployment command...\n');
  const output = execSync(deployCmd, { encoding: 'utf-8' });
  console.log(output);

  // Extract deployment URL from output
  const urlMatch = output.match(/https:\/\/[^\s]+\.vercel\.app/);
  if (urlMatch) {
    console.log('\n✅ DEPLOYMENT SUCCESSFUL!');
    console.log(`🌐 Your dashboard is live at: ${urlMatch[0]}`);
    console.log('\nNext steps:');
    console.log('1. Visit the URL and test the login');
    console.log('2. Only the email in ALLOWED_EMAIL can access');
    console.log(`3. Configure Clerk redirect URLs to point to ${urlMatch[0]}`);

    // Save deployment URL to file
    const deployInfoPath = path.join(__dirname, 'dashboard-app', 'DEPLOYMENT.txt');
    fs.writeFileSync(deployInfoPath, `Deployed: ${new Date().toISOString()}\nURL: ${urlMatch[0]}\n`);
  } else {
    console.log('\n⚠️  Deployment completed but could not extract URL from output');
    console.log('Check your Vercel dashboard at: https://vercel.com/dashboard');
  }

} catch (error) {
  console.error('\n❌ Deployment failed:', error.message);
  process.exit(1);
}
