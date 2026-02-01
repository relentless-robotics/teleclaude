const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 500
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });

  const page = await context.newPage();

  // Increase default timeout
  page.setDefaultTimeout(60000);

  console.log('PROGRESS: Navigating to algora.io...');
  await page.goto('https://algora.io');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Go directly to signup page
  console.log('PROGRESS: Navigating to signup page...');
  await page.goto('https://algora.io/auth/signup');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  await page.screenshot({ path: 'algora_signup_page.png' });
  console.log('PROGRESS: On signup page');

  // Click Developer button
  console.log('PROGRESS: Clicking Developer button...');
  try {
    await page.click('text=Developer');
    console.log('PROGRESS: Clicked Developer');
  } catch (e) {
    console.log('PROGRESS: Could not click Developer');
  }

  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'algora_after_developer_click.png' });

  // Check if we're on onboarding page
  const currentUrl = page.url();
  console.log('PROGRESS: Current URL:', currentUrl);

  if (currentUrl.includes('onboarding')) {
    console.log('PROGRESS: On onboarding page, filling out form...');

    // Click "Solve Bounties" checkbox if not already selected
    try {
      await page.click('text=Solve Bounties');
      console.log('PROGRESS: Clicked Solve Bounties');
    } catch (e) {
      console.log('PROGRESS: Solve Bounties may already be selected');
    }

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'algora_onboarding_filled.png' });

    // Click Next button
    console.log('PROGRESS: Clicking Next button...');
    try {
      await page.click('text=Next');
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('PROGRESS: Could not click Next');
    }

    await page.screenshot({ path: 'algora_after_next.png' });
    console.log('PROGRESS: After clicking Next');
  }

  // Check for GitHub connection step
  const currentUrl2 = page.url();
  console.log('PROGRESS: Current URL after Next:', currentUrl2);

  // Look for GitHub connect button
  console.log('PROGRESS: Looking for GitHub connection option...');

  let githubClicked = false;

  // Try various selectors for GitHub
  const githubSelectors = [
    'text=Continue with GitHub',
    'text=Connect GitHub',
    'text=Sign in with GitHub',
    'button:has-text("GitHub")',
    'a:has-text("GitHub")',
  ];

  for (const selector of githubSelectors) {
    if (!githubClicked) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 2000 })) {
          console.log('PROGRESS: Found GitHub element with selector:', selector);
          await element.click();
          githubClicked = true;
          break;
        }
      } catch (e) {
        // Try next selector
      }
    }
  }

  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'algora_github_redirect.png' });

  // Check if we're on GitHub login page
  const currentUrl3 = page.url();
  console.log('PROGRESS: Current URL:', currentUrl3);

  if (currentUrl3.includes('github.com')) {
    console.log('PROGRESS: On GitHub, attempting login...');

    // Check if there's a login form
    const loginInput = await page.$('input[name="login"]');
    if (loginInput) {
      await loginInput.fill('relentless-robotics');
      const passwordInput = await page.$('input[name="password"]');
      if (passwordInput) {
        await passwordInput.fill('Relentless@Robotics2026!');
      }

      await page.screenshot({ path: 'github_login_filled.png' });
      console.log('PROGRESS: Filled login form, submitting...');

      // Click Sign in button and wait for navigation
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
        page.click('input[type="submit"], button[type="submit"], .btn-primary')
      ]);

      await page.waitForTimeout(5000);
      await page.screenshot({ path: 'github_after_login.png' });
      console.log('PROGRESS: Screenshot saved - github_after_login.png');
    }

    // Handle 2FA if needed
    const currentUrl4 = page.url();
    console.log('PROGRESS: After login URL:', currentUrl4);

    // Check for device verification or 2FA
    if (currentUrl4.includes('sessions/two-factor') || currentUrl4.includes('login/device') || currentUrl4.includes('sessions/verified-device')) {
      console.log('PROGRESS: 2FA/Device verification required');
      await page.screenshot({ path: 'github_2fa.png' });
      console.log('PROGRESS: Waiting for 2FA/device verification (60 seconds)...');

      // Wait for navigation away from 2FA page
      try {
        await page.waitForURL(/.*(?<!two-factor|device|verified).*/, { timeout: 60000 });
        console.log('PROGRESS: 2FA completed');
      } catch (e) {
        console.log('PROGRESS: 2FA timeout - may need manual intervention');
      }

      await page.screenshot({ path: 'github_after_2fa.png' });
    }

    // Check for authorization screen
    const currentUrl5 = page.url();
    console.log('PROGRESS: Current URL:', currentUrl5);

    if (currentUrl5.includes('github.com/login/oauth/authorize')) {
      console.log('PROGRESS: On OAuth authorization page');
      await page.screenshot({ path: 'github_oauth_authorize.png' });

      // Look specifically for the green "Authorize Algora PBC" button
      // The button text is "Authorize Algora PBC" in the green button
      try {
        // Use a more specific selector - the green button with "Authorize" text
        // It's a button with class that makes it green and contains "Authorize"
        const authButton = await page.locator('button:has-text("Authorize Algora")').first();
        if (await authButton.isVisible({ timeout: 5000 })) {
          console.log('PROGRESS: Found "Authorize Algora PBC" button, clicking...');
          await authButton.click();
          await page.waitForTimeout(5000);
        }
      } catch (e) {
        console.log('PROGRESS: First attempt failed, trying alternative selectors');

        // Try other selectors
        try {
          // Look for the submit button with name="authorize"
          const authBtn2 = await page.locator('button[type="submit"][name="authorize"], button.js-oauth-authorize-btn').first();
          if (await authBtn2.isVisible({ timeout: 3000 })) {
            console.log('PROGRESS: Found authorize button via form selector');
            await authBtn2.click();
            await page.waitForTimeout(5000);
          }
        } catch (e2) {
          console.log('PROGRESS: Second attempt failed');

          // Last resort - click the button that's NOT the cancel button
          try {
            const buttons = await page.locator('button').all();
            for (const btn of buttons) {
              const text = await btn.textContent();
              console.log('PROGRESS: Found button:', text);
              if (text && text.includes('Authorize') && !text.includes('Cancel')) {
                console.log('PROGRESS: Clicking button with text:', text);
                await btn.click();
                await page.waitForTimeout(5000);
                break;
              }
            }
          } catch (e3) {
            console.log('PROGRESS: All attempts failed');
          }
        }
      }

      await page.screenshot({ path: 'algora_after_auth_click.png' });
    }

    await page.screenshot({ path: 'algora_after_auth.png' });
  }

  // Final status
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'algora_final.png' });
  const finalUrl = page.url();
  console.log('PROGRESS: Final URL:', finalUrl);

  // Check for error in URL
  if (finalUrl.includes('error=access_denied')) {
    console.log('PROGRESS: ERROR - Access was denied. Authorization failed.');
  }

  // If we're back on Algora, navigate to bounties
  if (finalUrl.includes('algora.io') && !finalUrl.includes('error')) {
    console.log('PROGRESS: On Algora, navigating to bounties...');

    // First check if there are more onboarding steps
    if (finalUrl.includes('onboarding')) {
      console.log('PROGRESS: Still in onboarding, completing...');
      await page.screenshot({ path: 'algora_onboarding_continue.png' });

      // Try clicking Next or Skip buttons
      try {
        const nextBtn = await page.locator('text=Next').first();
        if (await nextBtn.isVisible({ timeout: 2000 })) {
          await nextBtn.click();
          await page.waitForTimeout(2000);
        }
      } catch (e) {}

      try {
        const skipBtn = await page.locator('text=Skip').first();
        if (await skipBtn.isVisible({ timeout: 2000 })) {
          await skipBtn.click();
          await page.waitForTimeout(2000);
        }
      } catch (e) {}
    }

    await page.goto('https://algora.io/bounties');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'algora_bounties_page.png' });
    console.log('PROGRESS: Bounties page screenshot saved');
  }

  // Keep browser open for inspection
  console.log('PROGRESS: Browser staying open for 120 seconds...');
  await page.waitForTimeout(120000);

  await browser.close();
})();
