const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating to Alpaca...');
  await page.goto('https://app.alpaca.markets/');
  await page.waitForLoadState('networkidle');

  // Enter credentials quickly
  const email = await page.$('input[type="email"], input[name="email"]');
  if (email) {
    await email.fill('njliautaud@gmail.com');
    const password = await page.$('input[type="password"]');
    if (password) {
      await password.fill('6rrwY$hrjn7u');
      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForTimeout(3000);
      }
    }
  }

  console.log('Entering MFA code...');
  await page.screenshot({ path: 'mfa_before.png' });

  // Enter the 6-digit MFA code
  const mfaCode = '831652';

  // Try to find the MFA input fields
  const mfaInputs = await page.$$('input[type="text"], input[type="number"], input[type="tel"]');
  console.log('Found', mfaInputs.length, 'potential MFA inputs');

  // Method 1: Type into focused element or first input
  try {
    // Click on the first MFA box to focus
    const firstBox = await page.$('input');
    if (firstBox) {
      await firstBox.click();
      await page.waitForTimeout(200);
      // Type the code - it should auto-advance
      await page.keyboard.type(mfaCode, { delay: 50 });
      console.log('Typed MFA code');
    }
  } catch (e) {
    console.log('Method 1 failed:', e.message);
  }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'mfa_after_type.png' });

  // Click Verify button
  const verifyBtn = await page.$('button:has-text("Verify")');
  if (verifyBtn) {
    console.log('Clicking Verify...');
    await verifyBtn.click();
    await page.waitForTimeout(5000);
  }

  await page.screenshot({ path: 'after_verify.png' });
  console.log('After verify URL:', page.url());

  // Wait for dashboard to load
  await page.waitForTimeout(3000);

  // Now navigate to API Keys
  console.log('Looking for API Keys section...');
  await page.screenshot({ path: 'dashboard.png' });

  // Try to find API Keys link or settings
  const apiKeysLink = await page.$('a:has-text("API Keys"), a[href*="api"], button:has-text("API")');
  if (apiKeysLink) {
    console.log('Found API Keys link');
    await apiKeysLink.click();
    await page.waitForTimeout(3000);
  } else {
    // Try clicking on account/settings menu
    const accountMenu = await page.$('[data-testid="account-menu"], button:has-text("Account"), a:has-text("Account")');
    if (accountMenu) {
      await accountMenu.click();
      await page.waitForTimeout(1000);
    }
  }

  await page.screenshot({ path: 'looking_for_api.png' });

  // Try direct navigation to paper trading API keys
  console.log('Navigating directly to paper trading...');
  await page.goto('https://app.alpaca.markets/paper/dashboard/overview');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'paper_dashboard.png' });
  console.log('Paper dashboard URL:', page.url());

  // Look for API Keys in paper trading
  const paperApiLink = await page.$('a:has-text("API Keys"), [href*="api-keys"]');
  if (paperApiLink) {
    await paperApiLink.click();
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: 'api_keys_page.png' });

  // Try to get the API keys displayed on screen
  const pageContent = await page.content();
  console.log('Page contains "API":', pageContent.includes('API'));
  console.log('Page contains "Key":', pageContent.includes('Key'));
  console.log('Page contains "Secret":', pageContent.includes('Secret'));

  // Look for visible API key elements
  const keyElements = await page.$$('text=/PK[A-Z0-9]+/');
  console.log('Found', keyElements.length, 'potential API key elements');

  // Get all text that looks like API keys
  const allText = await page.evaluate(() => document.body.innerText);
  const keyMatches = allText.match(/PK[A-Z0-9]{16,}/g);
  if (keyMatches) {
    console.log('Found API Key patterns:', keyMatches);
  }

  await page.screenshot({ path: 'final_state.png' });
  console.log('Final URL:', page.url());

  // Keep browser open
  console.log('Browser staying open for 120 seconds for inspection...');
  await page.waitForTimeout(120000);

  await browser.close();
})();
