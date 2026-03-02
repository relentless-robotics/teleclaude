/**
 * Test script for Cloudflare CAPTCHA solver
 *
 * Tests the unified-solver against a real Cloudflare-protected website
 */

const { chromium } = require('playwright');
const path = require('path');
const { solveCaptcha, detectCaptchaType, hasCaptcha } = require('./solver/unified-solver');

// Test target - known Cloudflare-protected site
const TEST_URL = 'https://nowsecure.nl/';

async function testCloudflareSolver() {
  console.log('='.repeat(60));
  console.log('Cloudflare CAPTCHA Solver Test');
  console.log('='.repeat(60));
  console.log(`Target: ${TEST_URL}`);
  console.log('');

  const browser = await chromium.launch({
    headless: false, // Show browser so we can see what's happening
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

  // Add extra headers to look more like a real browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
  });

  try {
    console.log('[+] Navigating to target...');
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('[+] Page loaded, waiting 2 seconds...');
    await page.waitForTimeout(2000);

    // Take initial screenshot
    const screenshotPath = path.join(__dirname, 'temp', `cf_test_initial_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });
    console.log(`[+] Initial screenshot: ${screenshotPath}`);

    // Check current page title
    const title = await page.title();
    console.log(`[+] Page title: "${title}"`);

    // Detect if Cloudflare challenge is present
    console.log('\n[*] Detecting CAPTCHA...');
    const captchaPresent = await hasCaptcha(page);

    if (!captchaPresent) {
      console.log('[✓] No CAPTCHA detected! Page loaded directly.');
      console.log('[+] This could mean:');
      console.log('    - Site is not currently using Cloudflare protection');
      console.log('    - Our browser fingerprint passed automatically');
      console.log('    - Cloudflare allowed us based on IP/reputation');

      // Take success screenshot
      const successPath = path.join(__dirname, 'temp', `cf_test_success_${Date.now()}.png`);
      await page.screenshot({ path: successPath, fullPage: true });
      console.log(`[+] Success screenshot: ${successPath}`);

      return { success: true, method: 'no-challenge' };
    }

    console.log('[!] CAPTCHA detected!');

    // Get detailed CAPTCHA type info
    const captchaTypes = await detectCaptchaType(page);
    console.log(`[+] Detected ${captchaTypes.length} CAPTCHA type(s):`);
    for (const captcha of captchaTypes) {
      console.log(`    - ${captcha.name} (${captcha.type})`);
      if (captcha.note) {
        console.log(`      Note: ${captcha.note}`);
      }
    }

    // Take pre-solve screenshot
    const preSolvePath = path.join(__dirname, 'temp', `cf_test_pre_solve_${Date.now()}.png`);
    await page.screenshot({ path: preSolvePath, fullPage: true });
    console.log(`[+] Pre-solve screenshot: ${preSolvePath}`);

    // Attempt to solve
    console.log('\n[*] Attempting to solve CAPTCHA...');
    console.log('');

    const startTime = Date.now();
    const result = await solveCaptcha(page, {
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

      // Wait a moment for page to finish loading
      await page.waitForTimeout(2000);

      // Take final screenshot
      const finalPath = path.join(__dirname, 'temp', `cf_test_final_${Date.now()}.png`);
      await page.screenshot({ path: finalPath, fullPage: true });
      console.log(`[+] Final screenshot: ${finalPath}`);

      // Check final page title
      const finalTitle = await page.title();
      console.log(`[+] Final page title: "${finalTitle}"`);

    } else {
      console.log(`✗ Error: ${result.error}`);

      // Take failure screenshot
      const failPath = path.join(__dirname, 'temp', `cf_test_fail_${Date.now()}.png`);
      await page.screenshot({ path: failPath, fullPage: true });
      console.log(`[+] Failure screenshot: ${failPath}`);
    }

    console.log('='.repeat(60));

    return result;

  } catch (error) {
    console.error('[!] Test error:', error);

    // Take error screenshot
    const errorPath = path.join(__dirname, 'temp', `cf_test_error_${Date.now()}.png`);
    await page.screenshot({ path: errorPath }).catch(() => {});
    console.log(`[+] Error screenshot: ${errorPath}`);

    return { success: false, error: error.message };

  } finally {
    console.log('\n[*] Keeping browser open for 10 seconds for manual inspection...');
    await page.waitForTimeout(10000);

    console.log('[*] Closing browser...');
    await browser.close();
  }
}

// Run the test
if (require.main === module) {
  testCloudflareSolver()
    .then((result) => {
      console.log('\n[*] Test complete.');
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('\n[!] Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { testCloudflareSolver };
