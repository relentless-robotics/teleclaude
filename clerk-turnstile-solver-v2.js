const { chromium } = require('playwright');
const stealthBrowser = require('./captcha-lab/solver/stealth-browser');

async function findAndClickTurnstile(page) {
  console.log('Searching for Turnstile widget...');

  // Multiple selectors to find Turnstile
  const selectors = [
    '.cf-turnstile',
    'div[data-turnstile-callback]',
    'iframe[src*="challenges.cloudflare.com"]',
    'div:has(iframe[src*="cloudflare"])',
    'div:has-text("Verify you are human")',
    '[data-callback]'
  ];

  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        console.log('Found Turnstile with selector:', selector);
        const box = await element.boundingBox();
        if (box) {
          return { element, box };
        }
      }
    } catch (e) {
      // Continue to next selector
    }
  }

  // Try finding by visual position - look for any clickable area in center
  console.log('Trying to find by text content...');
  const verifyText = await page.locator('text="Verify you are human"').first();
  if (await verifyText.count() > 0) {
    const box = await verifyText.boundingBox();
    if (box) {
      // Checkbox is typically to the left of the text
      return { element: verifyText, box: { ...box, x: box.x - 50 } };
    }
  }

  return null;
}

async function solveTurnstilePersistent(page, maxWait = 90000) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    // Check if we made it through
    const url = page.url();
    if (url.includes('dashboard.clerk.com') && !url.includes('sign') && !url.includes('callback') && !url.includes('prepare')) {
      console.log('SUCCESS! Made it to dashboard!');
      return true;
    }

    // Find Turnstile
    const turnstileInfo = await findAndClickTurnstile(page);

    if (!turnstileInfo) {
      console.log('No Turnstile found yet, waiting...');
      await page.waitForTimeout(2000);
      continue;
    }

    const { box } = turnstileInfo;
    console.log('Turnstile box:', box);

    // Wait for widget to load
    await page.waitForTimeout(2000);

    // Click position - checkbox area
    const clickX = box.x + 20;
    const clickY = box.y + box.height / 2;

    console.log('Clicking at:', clickX, clickY);

    // Move mouse naturally
    const startX = Math.random() * 300 + 100;
    const startY = Math.random() * 200 + 100;
    await page.mouse.move(startX, startY);
    await page.waitForTimeout(200);

    // Bezier curve movement
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const eased = t * t * (3 - 2 * t); // smoothstep
      const x = startX + (clickX - startX) * eased + (Math.random() - 0.5) * 2;
      const y = startY + (clickY - startY) * eased + (Math.random() - 0.5) * 2;
      await page.mouse.move(x, y);
      await page.waitForTimeout(15 + Math.random() * 25);
    }

    await page.waitForTimeout(100 + Math.random() * 200);

    // Click with realistic timing
    await page.mouse.down();
    await page.waitForTimeout(80 + Math.random() * 50);
    await page.mouse.up();

    console.log('Clicked! Waiting for verification...');
    await page.screenshot({ path: 'turnstile_clicked_' + Date.now() + '.png' });

    // Wait for verification
    await page.waitForTimeout(8000);

    // Check URL again
    const newUrl = page.url();
    console.log('URL after click:', newUrl);

    if (newUrl !== url) {
      console.log('URL changed! Checking if we passed...');
      if (!newUrl.includes('callback')) {
        return true;
      }
    }
  }

  return false;
}

(async () => {
  console.log('=== CLERK TURNSTILE SOLVER V2 ===');
  console.log('Time:', new Date().toISOString());

  const { browser, context, page } = await stealthBrowser.launchStealthBrowser({ headless: false });

  // Brief warm-up
  console.log('Quick browser warm-up...');
  await page.goto('https://www.google.com/search?q=clerk+authentication');
  await page.waitForTimeout(2000);

  // Go to Clerk sign-in
  console.log('Navigating to Clerk...');
  await page.goto('https://dashboard.clerk.com/sign-in');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'clerk_signin_page.png' });

  // Click GitHub
  console.log('Looking for GitHub button...');
  const githubBtn = await page.$('button:has-text("GitHub")');
  if (githubBtn) {
    console.log('Clicking GitHub...');
    await githubBtn.click();
    await page.waitForTimeout(5000);

    if (page.url().includes('github.com')) {
      console.log('On GitHub login page...');
      const loginInput = await page.$('input[name="login"]');
      if (loginInput) {
        await loginInput.fill('relentless-robotics');
        await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
        await page.click('input[type="submit"]');
        console.log('Submitted GitHub login');
        await page.waitForTimeout(5000);

        // Check for authorize button
        const authBtn = await page.$('button:has-text("Authorize")');
        if (authBtn) {
          console.log('Clicking authorize...');
          await authBtn.click();
          await page.waitForTimeout(5000);
        }
      }
    }
  }

  console.log('After GitHub OAuth, URL:', page.url());
  await page.screenshot({ path: 'after_github_oauth.png' });

  // Attempt Turnstile solve
  console.log('Starting Turnstile solver...');
  const solved = await solveTurnstilePersistent(page, 120000);

  if (solved) {
    console.log('=== SUCCESS! ===');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'clerk_dashboard_success.png' });

    // Get API keys
    const bodyText = await page.textContent('body');
    const pkMatch = bodyText.match(/pk_test_[A-Za-z0-9_-]+/);
    const skMatch = bodyText.match(/sk_test_[A-Za-z0-9_-]+/);

    if (pkMatch) {
      console.log('===================');
      console.log('PUBLISHABLE_KEY:', pkMatch[0]);
      console.log('===================');
    }
    if (skMatch) {
      console.log('===================');
      console.log('SECRET_KEY:', skMatch[0]);
      console.log('===================');
    }

    // Try to navigate to API keys page
    const apiLink = await page.$('a:has-text("API"), a[href*="api-key"]');
    if (apiLink) {
      await apiLink.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'clerk_api_keys.png' });

      const keysText = await page.textContent('body');
      const pk2 = keysText.match(/pk_test_[A-Za-z0-9_-]+/);
      const sk2 = keysText.match(/sk_test_[A-Za-z0-9_-]+/);
      if (pk2) console.log('PK from keys page:', pk2[0]);
      if (sk2) console.log('SK from keys page:', sk2[0]);
    }
  } else {
    console.log('Could not solve Turnstile within timeout');
    await page.screenshot({ path: 'clerk_failed.png' });
  }

  console.log('Browser staying open 60 seconds...');
  await page.waitForTimeout(60000);

  await browser.close();
  console.log('Done');
})().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
