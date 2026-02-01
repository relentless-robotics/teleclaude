const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const EMAIL = 'njliautaud@gmail.com';
  const PASSWORD = '6rrwY$hrjn7u';
  const TWO_FA_CODE = '187152';

  console.log('Navigating to Alpaca...');
  await page.goto('https://app.alpaca.markets/');
  await page.waitForLoadState('networkidle');
  console.log('Page loaded, URL:', page.url());

  // Look for sign in button
  try {
    await page.waitForTimeout(2000);

    // Click Sign In if present
    const signInBtn = await page.$('text=Sign In');
    const loginBtn = await page.$('text=Log In');

    if (signInBtn) {
      console.log('Clicking Sign In...');
      await signInBtn.click();
      await page.waitForTimeout(2000);
    } else if (loginBtn) {
      console.log('Clicking Log In...');
      await loginBtn.click();
      await page.waitForTimeout(2000);
    }

    // Enter email
    console.log('Looking for email field...');
    await page.waitForSelector('input[type="email"], input[name="email"], input[name="username"]', { timeout: 10000 });
    const email = await page.$('input[type="email"], input[name="email"], input[name="username"]');
    if (email) {
      console.log('Entering email...');
      await email.fill(EMAIL);
    }

    // Enter password
    const password = await page.$('input[type="password"], input[name="password"]');
    if (password) {
      console.log('Entering password...');
      await password.fill(PASSWORD);
    }

    // Click submit
    const submitBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Continue")');
    if (submitBtn) {
      console.log('Clicking submit...');
      await submitBtn.click();
      await page.waitForTimeout(3000);
    }

    console.log('After login submit, URL:', page.url());

    // Look for 2FA field
    console.log('Looking for 2FA field...');
    await page.waitForTimeout(2000);

    const twoFASelectors = [
      'input[name="code"]',
      'input[placeholder*="code"]',
      'input[placeholder*="Code"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]',
      'input[autocomplete="one-time-code"]'
    ];

    let twoFAInput = null;
    for (const selector of twoFASelectors) {
      twoFAInput = await page.$(selector);
      if (twoFAInput) {
        console.log('Found 2FA input with selector:', selector);
        break;
      }
    }

    if (twoFAInput) {
      console.log('ENTERING 2FA CODE NOW:', TWO_FA_CODE);
      await twoFAInput.fill(TWO_FA_CODE);
      await page.waitForTimeout(500);

      // Look for verify/submit button
      const verifyBtn = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")');
      if (verifyBtn) {
        console.log('Clicking verify...');
        await verifyBtn.click();
      }

      await page.waitForTimeout(5000);
    } else {
      console.log('No 2FA field found - may be logged in already or different flow');
    }

    console.log('After 2FA, URL:', page.url());
    await page.screenshot({ path: 'alpaca_after_login.png' });

    // Now navigate to API keys
    console.log('Looking for API keys section...');
    await page.waitForTimeout(3000);

    // Try to find API keys in menu or settings
    const apiKeyLinks = [
      'text=API Keys',
      'text=API',
      'a[href*="api"]',
      'a[href*="keys"]'
    ];

    for (const selector of apiKeyLinks) {
      const link = await page.$(selector);
      if (link) {
        console.log('Found API link:', selector);
        await link.click();
        await page.waitForTimeout(3000);
        break;
      }
    }

    // Take screenshot of current state
    await page.screenshot({ path: 'alpaca_current.png' });
    console.log('Current URL:', page.url());

    // Look for API key values on page
    const pageContent = await page.content();
    console.log('Page content includes "Key":', pageContent.includes('Key'));
    console.log('Page content includes "Secret":', pageContent.includes('Secret'));

    // Try to find API key display
    const keyElements = await page.$$('text=/[A-Z0-9]{20}/');
    console.log('Found potential key elements:', keyElements.length);

    // Keep browser open
    console.log('Keeping browser open for 120 seconds for manual inspection...');
    await page.waitForTimeout(120000);

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'alpaca_error.png' });
  }

  await browser.close();
})();
