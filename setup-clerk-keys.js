const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('Starting Clerk setup automation...');

  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge',
    slowMo: 500
  });

  // Load saved Google auth if available
  const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');
  const hasGoogleAuth = fs.existsSync(stateFile);

  console.log(`Google auth state ${hasGoogleAuth ? 'found' : 'not found'}`);

  const context = await browser.newContext({
    storageState: hasGoogleAuth ? stateFile : undefined
  });

  const page = await context.newPage();

  try {
    console.log('Navigating to Clerk...');
    await page.goto('https://clerk.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Look for sign up / get started button
    console.log('Looking for sign up button...');
    const signupSelectors = [
      'text="Start building"',
      'text="Get started for free"',
      'text="Get started"',
      'text="Sign up"',
      'a[href*="sign-up"]',
      'button:has-text("Start")',
      'a:has-text("Dashboard")'
    ];

    let clickedSignup = false;
    for (const selector of signupSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 2000 })) {
          console.log(`Found signup button: ${selector}`);
          await element.click();
          clickedSignup = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!clickedSignup) {
      console.log('Could not find signup button, trying direct URL...');
      await page.goto('https://dashboard.clerk.com/sign-up', { waitUntil: 'domcontentloaded' });
    }

    await page.waitForTimeout(3000);

    // Look for Google sign-in button
    console.log('Looking for Google OAuth button...');
    const googleSelectors = [
      'button:has-text("Continue with Google")',
      'button:has-text("Sign up with Google")',
      'button:has-text("Google")',
      '[data-clerk-oauth="oauth_google"]',
      'button[data-provider="google"]'
    ];

    let clickedGoogle = false;
    for (const selector of googleSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 2000 })) {
          console.log(`Found Google button: ${selector}`);
          await element.click();
          clickedGoogle = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!clickedGoogle) {
      console.log('WARNING: Could not find Google OAuth button. Please complete signup manually.');
      console.log('Current URL:', page.url());
    } else {
      console.log('Clicked Google OAuth. Waiting for authentication...');
      await page.waitForTimeout(5000);

      // If Google auth state was loaded, we might be auto-logged in
      // Otherwise, user needs to complete login manually
      console.log('Current URL:', page.url());
    }

    // Wait for dashboard to load (this might take a while if manual login needed)
    console.log('\n=== MANUAL STEPS REQUIRED ===');
    console.log('1. Complete Google login if prompted');
    console.log('2. Complete any Clerk onboarding steps');
    console.log('3. Create application named "TeleClaude Dashboard"');
    console.log('4. Navigate to API Keys section');
    console.log('5. Copy the Publishable Key (pk_test_...)');
    console.log('6. Copy the Secret Key (sk_test_...)');
    console.log('\nWaiting 120 seconds for you to complete these steps...');
    console.log('The browser will stay open. When you have the keys, you can close this script.\n');

    await page.waitForTimeout(120000); // 2 minutes

    console.log('\nAttempting to find API keys on the page...');

    // Try to extract keys from the page
    const pageContent = await page.content();
    const publishableKeyMatch = pageContent.match(/pk_test_[a-zA-Z0-9]+/);
    const secretKeyMatch = pageContent.match(/sk_test_[a-zA-Z0-9]+/);

    if (publishableKeyMatch && secretKeyMatch) {
      console.log('\n=== FOUND KEYS ===');
      console.log('Publishable Key:', publishableKeyMatch[0]);
      console.log('Secret Key:', secretKeyMatch[0]);

      // Save to file
      const keysFile = path.join(__dirname, 'dashboard-app', '.clerk-keys.txt');
      fs.writeFileSync(keysFile, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${publishableKeyMatch[0]}\nCLERK_SECRET_KEY=${secretKeyMatch[0]}\n`);
      console.log(`\nKeys saved to: ${keysFile}`);
    } else {
      console.log('\nCould not auto-extract keys. Please copy them manually from the Clerk dashboard.');
      console.log('Look for:');
      console.log('- Publishable Key (starts with pk_test_)');
      console.log('- Secret Key (starts with sk_test_)');
    }

    console.log('\nBrowser will remain open. Close manually when done.');
    await page.waitForTimeout(300000); // 5 more minutes

  } catch (error) {
    console.error('Error during Clerk setup:', error.message);
    console.log('\nBrowser will remain open for manual completion.');
    await page.waitForTimeout(180000); // 3 minutes
  } finally {
    console.log('\nClosing browser...');
    await browser.close();
  }
})();
