// Master script: Validate keys, update env, deploy to Vercel
const { execSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);

if (args.length !== 2) {
  console.error('❌ Usage: node complete-clerk-deployment.js <publishable_key> <secret_key>');
  console.error('\nExample:');
  console.error('  node complete-clerk-deployment.js pk_test_abc123xyz789 sk_test_def456uvw012');
  process.exit(1);
}

const [publishableKey, secretKey] = args;

console.log('═══════════════════════════════════════════════════════');
console.log('  CLERK SETUP & VERCEL DEPLOYMENT - TELECLAUDE DASHBOARD');
console.log('═══════════════════════════════════════════════════════\n');

try {
  // Step 1: Validate keys
  console.log('Step 1/3: Validating Clerk API keys...');
  execSync(`node validate-clerk-keys.js "${publishableKey}" "${secretKey}"`, {
    stdio: 'inherit',
    cwd: __dirname
  });
  console.log();

  // Step 2: Update environment files
  console.log('Step 2/3: Updating .env.local and API_KEYS.md...');
  execSync(`node update-clerk-env.js "${publishableKey}" "${secretKey}"`, {
    stdio: 'inherit',
    cwd: __dirname
  });
  console.log();

  // Step 3: Deploy to Vercel
  console.log('Step 3/3: Deploying to Vercel...');
  execSync('node deploy-to-vercel.js', {
    stdio: 'inherit',
    cwd: __dirname
  });
  console.log();

  console.log('═══════════════════════════════════════════════════════');
  console.log('  ✅ COMPLETE! Dashboard deployed successfully!');
  console.log('═══════════════════════════════════════════════════════');

} catch (error) {
  console.error('\n═══════════════════════════════════════════════════════');
  console.error('  ❌ DEPLOYMENT FAILED');
  console.error('═══════════════════════════════════════════════════════');
  console.error('\nError:', error.message);
  process.exit(1);
}
