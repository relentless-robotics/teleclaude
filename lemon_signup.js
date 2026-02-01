const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const email = 'relentlessrobotics@gmail.com';
  const password = 'Relaxing41!';

  try {
    console.log('Navigating to Lemon Squeezy registration page...');
    await page.goto('https://auth.lemonsqueezy.com/register');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    console.log('Looking for registration form fields...');

    // Take screenshot to see current state
    await page.screenshot({ path: 'lemon_signup_1.png' });
    console.log('Screenshot saved: lemon_signup_1.png');

    // Try to find and fill form fields
    // Look for email field
    const emailField = await page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    if (await emailField.isVisible()) {
      await emailField.fill(email);
      console.log('Filled email field');
    } else {
      console.log('Email field not found, checking page structure...');
      const inputs = await page.locator('input').all();
      console.log(`Found ${inputs.length} input fields`);
    }

    // Look for password field
    const passwordField = await page.locator('input[type="password"], input[name="password"]').first();
    if (await passwordField.isVisible()) {
      await passwordField.fill(password);
      console.log('Filled password field');
    }

    // Look for name field if present
    const nameField = await page.locator('input[name="name"], input[placeholder*="name" i]').first();
    if (await nameField.isVisible()) {
      await nameField.fill('Relentless Robotics');
      console.log('Filled name field');
    }

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'lemon_signup_2.png' });
    console.log('Screenshot saved after filling form: lemon_signup_2.png');

    // Look for submit button
    const submitBtn = await page.locator('button[type="submit"], button:has-text("Sign up"), button:has-text("Create account"), button:has-text("Register")').first();
    if (await submitBtn.isVisible()) {
      console.log('Found submit button, clicking...');
      await submitBtn.click();
      console.log('Clicked submit button');
    }

    await page.waitForTimeout(5000);
    console.log('Current URL after submit:', page.url());
    await page.screenshot({ path: 'lemon_signup_3.png' });
    console.log('Screenshot saved after submit: lemon_signup_3.png');

    // Check for any error messages
    const errorMsg = await page.locator('.error, .alert-error, [class*="error"], [role="alert"]').first();
    if (await errorMsg.isVisible()) {
      const errorText = await errorMsg.textContent();
      console.log('Error message found:', errorText);
    }

    // Keep browser open for manual intervention if needed
    console.log('Keeping browser open for 5 minutes...');
    await page.waitForTimeout(300000);

  } catch (error) {
    console.error('Error during signup:', error.message);
    await page.screenshot({ path: 'lemon_signup_error.png' });
  }
})();
