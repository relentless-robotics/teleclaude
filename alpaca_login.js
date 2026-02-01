const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating to Alpaca...');
  await page.goto('https://app.alpaca.markets/');

  // Wait for page to load
  await page.waitForLoadState('networkidle');
  console.log('Page loaded, current URL:', page.url());

  // Take screenshot
  await page.screenshot({ path: 'alpaca_step1.png' });

  // Check if we need to log in
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  // Look for login form or sign in button
  try {
    // Wait a bit for any redirects
    await page.waitForTimeout(3000);

    // Check for sign in button or login form
    const signInBtn = await page.$('text=Sign In');
    const loginBtn = await page.$('text=Log In');
    const emailInput = await page.$('input[type="email"]');
    const emailField = await page.$('input[name="email"]');

    console.log('Sign In button found:', !!signInBtn);
    console.log('Log In button found:', !!loginBtn);
    console.log('Email input found:', !!emailInput);
    console.log('Email field found:', !!emailField);

    await page.screenshot({ path: 'alpaca_step2.png' });

    // Click sign in if needed
    if (signInBtn) {
      console.log('Clicking Sign In button...');
      await signInBtn.click();
      await page.waitForTimeout(2000);
    } else if (loginBtn) {
      console.log('Clicking Log In button...');
      await loginBtn.click();
      await page.waitForTimeout(2000);
    }

    await page.screenshot({ path: 'alpaca_step3.png' });
    console.log('After click URL:', page.url());

    // Now try to find email field
    await page.waitForTimeout(2000);
    const email = await page.$('input[type="email"], input[name="email"], input[name="username"]');
    if (email) {
      console.log('Found email field, entering credentials...');
      await email.fill('njliautaud@gmail.com');
      await page.screenshot({ path: 'alpaca_step4.png' });

      const password = await page.$('input[type="password"], input[name="password"]');
      if (password) {
        console.log('Found password field...');
        await password.fill('6rrwY$hrjn7u');
        await page.screenshot({ path: 'alpaca_step5.png' });

        // Find and click submit button
        const submitBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Continue")');
        if (submitBtn) {
          console.log('Clicking submit...');
          await submitBtn.click();
          await page.waitForTimeout(5000);
          await page.screenshot({ path: 'alpaca_step6.png' });
          console.log('After login URL:', page.url());
        }
      }
    }

    // Check for 2FA
    const twoFA = await page.$('input[name="code"], input[placeholder*="code"], input[placeholder*="Code"]');
    if (twoFA) {
      console.log('2FA DETECTED - Need verification code');
      await page.screenshot({ path: 'alpaca_2fa.png' });
    }

    // Wait to see results
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'alpaca_final.png' });
    console.log('Final URL:', page.url());

    // Keep browser open for manual inspection
    console.log('Browser will stay open for 60 seconds...');
    await page.waitForTimeout(60000);

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'alpaca_error.png' });
  }

  await browser.close();
})();
