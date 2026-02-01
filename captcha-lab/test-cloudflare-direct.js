/**
 * Direct test of Cloudflare solver (bypassing unified-solver)
 *
 * This test directly invokes the cloudflare-solver module
 * to avoid priority issues with the unified solver
 */

const { chromium } = require('playwright');
const path = require('path');
const {
  solveCloudflare,
  hasCloudflareChallenge,
  waitForAutoSolve
} = require('./solver/cloudflare-solver');

// Test target - known Cloudflare-protected site
const TEST_URL = 'https://nowsecure.nl/';

async function testCloudflareDirectly() {
  console.log('='.repeat(60));
  console.log('Cloudflare Solver Direct Test');
  console.log('='.repeat(60));
  console.log(`Target: ${TEST_URL}`);
  console.log('');

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['notifications']
  });

  const page = await context.newPage();

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
  });

  try {
    console.log('[+] Navigating to target...');
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('[+] Page loaded, waiting 2 seconds for challenge to appear...');
    await page.waitForTimeout(2000);

    const screenshotPath = path.join(__dirname, 'temp', `cf_direct_initial_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });
    console.log(`[+] Initial screenshot: ${screenshotPath}`);

    const title = await page.title();
    console.log(`[+] Page title: "${title}"`);

    // Check if Cloudflare challenge is present
    console.log('\n[*] Checking for Cloudflare challenge...');
    const hasChallenge = await hasCloudflareChallenge(page);

    if (!hasChallenge) {
      console.log('[✓] No Cloudflare challenge detected!');
      console.log('[+] Possible reasons:');
      console.log('    - Browser fingerprint passed automatically');
      console.log('    - IP/reputation allowed direct access');
      console.log('    - Site temporarily not using Cloudflare protection');

      const successPath = path.join(__dirname, 'temp', `cf_direct_success_${Date.now()}.png`);
      await page.screenshot({ path: successPath, fullPage: true });
      console.log(`[+] Success screenshot: ${successPath}`);

      return { success: true, method: 'no-challenge' };
    }

    console.log('[!] Cloudflare challenge detected!');

    // Get challenge info
    const challengeInfo = [];
    const selectors = {
      'Turnstile iframe': 'iframe[src*="challenges.cloudflare.com"]',
      'Turnstile widget': '.cf-turnstile',
      'Challenge page': '#challenge-running, #challenge-stage',
      'Managed challenge': '[data-translate="managed_checking_msg"]'
    };

    for (const [name, selector] of Object.entries(selectors)) {
      try {
        const element = await page.$(selector);
        if (element) {
          challengeInfo.push(name);
        }
      } catch {}
    }

    if (challengeInfo.length > 0) {
      console.log(`[+] Challenge indicators found: ${challengeInfo.join(', ')}`);
    }

    // Take pre-solve screenshot
    const preSolvePath = path.join(__dirname, 'temp', `cf_direct_pre_solve_${Date.now()}.png`);
    await page.screenshot({ path: preSolvePath, fullPage: true });
    console.log(`[+] Pre-solve screenshot: ${preSolvePath}`);

    // Attempt to solve
    console.log('\n[*] Attempting to solve Cloudflare challenge...');
    console.log('[+] Using behavioral simulation and auto-solve wait strategy');
    console.log('');

    const startTime = Date.now();
    const result = await solveCloudflare(page, {
      timeout: 45000,
      onProgress: (msg) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`    [${elapsed}s] ${msg}`);
      }
    });

    const solveTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('');
    console.log('='.repeat(60));
    console.log('RESULT:');
    console.log('='.repeat(60));
    console.log(`Time: ${solveTime}s`);
    console.log(`Success: ${result.success}`);

    if (result.success) {
      console.log(`✓ Method: ${result.method || 'unknown'}`);
      if (result.message) {
        console.log(`  Message: ${result.message}`);
      }

      // Wait for page to fully load
      console.log('\n[+] Waiting for page to finish loading...');
      await page.waitForTimeout(3000);

      // Take final screenshot
      const finalPath = path.join(__dirname, 'temp', `cf_direct_final_${Date.now()}.png`);
      await page.screenshot({ path: finalPath, fullPage: true });
      console.log(`[+] Final screenshot: ${finalPath}`);

      // Check final state
      const finalTitle = await page.title();
      console.log(`[+] Final page title: "${finalTitle}"`);

      const stillHasChallenge = await hasCloudflareChallenge(page);
      if (!stillHasChallenge) {
        console.log('[✓] Challenge successfully bypassed! Page is now accessible.');
      } else {
        console.log('[!] Challenge still present - may have only partially solved.');
      }

    } else {
      console.log(`✗ Error: ${result.error}`);

      const failPath = path.join(__dirname, 'temp', `cf_direct_fail_${Date.now()}.png`);
      await page.screenshot({ path: failPath, fullPage: true });
      console.log(`[+] Failure screenshot: ${failPath}`);
    }

    console.log('='.repeat(60));

    return result;

  } catch (error) {
    console.error('[!] Test error:', error);

    const errorPath = path.join(__dirname, 'temp', `cf_direct_error_${Date.now()}.png`);
    await page.screenshot({ path: errorPath }).catch(() => {});
    console.log(`[+] Error screenshot: ${errorPath}`);

    return { success: false, error: error.message };

  } finally {
    console.log('\n[*] Keeping browser open for 15 seconds for manual inspection...');
    await page.waitForTimeout(15000);

    console.log('[*] Closing browser...');
    await browser.close();
  }
}

// Run the test
if (require.main === module) {
  testCloudflareDirectly()
    .then((result) => {
      console.log('\n[*] Test complete.');
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('\n[!] Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { testCloudflareDirectly };
