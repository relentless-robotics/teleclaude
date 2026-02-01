const { chromium } = require('playwright');

async function openBrowserForManualSecret() {
  console.log('Opening browser to GitHub OAuth app page...');
  console.log('You will need to:');
  console.log('1. Click "Generate a new client secret"');
  console.log('2. Copy the secret that appears (SHOWN ONLY ONCE!)');
  console.log('3. Paste it when prompted\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 500
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Login and navigate
  await page.goto('https://github.com/login');
  await page.fill('input[name="login"]', 'relentless-robotics');
  await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
  await page.click('input[type="submit"]');

  console.log('Waiting for login to complete...');
  await page.waitForTimeout(5000);

  // Navigate to the app
  await page.goto('https://github.com/settings/applications');
  await page.waitForTimeout(2000);

  console.log('\n===========================================');
  console.log('Browser is open at GitHub OAuth Apps page');
  console.log('===========================================');
  console.log('\nManual steps:');
  console.log('1. Find "TeleClaude Dashboard" and click it');
  console.log('2. Click "Generate a new client secret"');
  console.log('3. IMMEDIATELY copy the secret (40-character hex string)');
  console.log('4. Come back here and paste it');
  console.log('\nPress Ctrl+C when done to close browser\n');

  // Keep browser open
  await new Promise(() => {}); // Never resolves - keeps running
}

openBrowserForManualSecret().catch(console.error);
