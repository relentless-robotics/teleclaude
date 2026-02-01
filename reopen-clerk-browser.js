// Quick script to re-open Clerk dashboard in browser
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('Opening Clerk dashboard...');

  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge'
  });

  const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');
  const hasGoogleAuth = fs.existsSync(stateFile);

  const context = await browser.newContext({
    storageState: hasGoogleAuth ? stateFile : undefined
  });

  const page = await context.newPage();

  // Go directly to Clerk dashboard
  await page.goto('https://dashboard.clerk.com', { waitUntil: 'domcontentloaded' });

  console.log('\n═══════════════════════════════════════════');
  console.log('  CLERK DASHBOARD OPENED');
  console.log('═══════════════════════════════════════════\n');
  console.log('Steps to get your API keys:');
  console.log('1. Sign in if prompted (use relentlessrobotics@gmail.com)');
  console.log('2. Look for "TeleClaude Dashboard" application');
  console.log('   (If it doesn\'t exist, create it)');
  console.log('3. Go to API Keys section');
  console.log('4. Copy both keys:');
  console.log('   - Publishable Key (pk_test_...)');
  console.log('   - Secret Key (sk_test_...)');
  console.log('\nBrowser will stay open for 10 minutes.');
  console.log('Close this script when you\'ve copied the keys.\n');

  await page.waitForTimeout(600000); // 10 minutes

  await browser.close();
})();
