const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const email = 'relentlessrobotics@gmail.com';
  // Password needs 12+ characters
  const password = 'Relaxing41!X';

  try {
    console.log('Navigating to Lemon Squeezy registration page...');
    await page.goto('https://auth.lemonsqueezy.com/register');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    console.log('Filling registration form...');

    // Fill Name field
    const nameField = await page.locator('input[placeholder="Name"]').first();
    await nameField.fill('Relentless Robotics');
    console.log('Filled name field');
    await page.waitForTimeout(500);

    // Fill Email field
    const emailField = await page.locator('input[placeholder="Email address"]').first();
    await emailField.fill(email);
    console.log('Filled email field');
    await page.waitForTimeout(500);

    // Fill Password field (needs 12+ characters)
    const passwordField = await page.locator('input[type="password"]').first();
    await passwordField.fill(password);
    console.log('Filled password field with 12+ character password');
    await page.waitForTimeout(500);

    // Take screenshot before CAPTCHA
    await page.screenshot({ path: 'lemon_before_captcha.png' });
    console.log('Screenshot saved: lemon_before_captcha.png');

    // Try to click the reCAPTCHA checkbox
    console.log('Attempting to click reCAPTCHA...');

    // reCAPTCHA is usually in an iframe
    const recaptchaFrame = page.frameLocator('iframe[src*="recaptcha"]').first();
    const checkbox = recaptchaFrame.locator('.recaptcha-checkbox-border, #recaptcha-anchor');

    try {
      await checkbox.click({ timeout: 5000 });
      console.log('Clicked reCAPTCHA checkbox');
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('Could not click reCAPTCHA directly, may need manual intervention');
    }

    await page.screenshot({ path: 'lemon_after_captcha_attempt.png' });
    console.log('Screenshot saved: lemon_after_captcha_attempt.png');

    // Check if submit button is now enabled
    const submitBtn = await page.locator('button[type="submit"]').first();
    const isDisabled = await submitBtn.getAttribute('disabled');
    console.log('Submit button disabled:', isDisabled !== null);

    if (isDisabled === null) {
      console.log('Submit button is enabled, clicking...');
      await submitBtn.click();
      await page.waitForTimeout(5000);
      console.log('Current URL:', page.url());
    } else {
      console.log('Submit button still disabled - CAPTCHA may need manual solving');
      console.log('Please solve the CAPTCHA in the browser window');
    }

    await page.screenshot({ path: 'lemon_result.png' });
    console.log('Screenshot saved: lemon_result.png');

    // Keep browser open for manual intervention
    console.log('Browser will stay open. If CAPTCHA needs solving, please do it manually.');
    console.log('Waiting 5 minutes...');
    await page.waitForTimeout(300000);

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'lemon_error.png' });
  }
})();
