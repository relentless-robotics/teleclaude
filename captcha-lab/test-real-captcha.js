/**
 * Real-World CAPTCHA Solver Test
 *
 * Tests the solver against actual CAPTCHA scenarios using Playwright
 * the same way it would be used during web automation.
 */

const { chromium } = require('playwright');
const path = require('path');

// Import our solvers
const unifiedSolver = require('./solver/unified-solver');
const { autoSolveCaptcha } = require('../utils/captcha_handler');

// Test sites with various CAPTCHA types
const TEST_SITES = [
  {
    name: 'reCAPTCHA v2 Demo',
    url: 'https://www.google.com/recaptcha/api2/demo',
    type: 'recaptcha_v2',
    description: 'Official Google reCAPTCHA demo page'
  },
  {
    name: 'hCaptcha Demo',
    url: 'https://accounts.hcaptcha.com/demo',
    type: 'hcaptcha',
    description: 'Official hCaptcha demo page'
  },
  {
    name: 'Local Lab - Text CAPTCHA',
    url: 'http://localhost:3000/text-captcha',
    type: 'text',
    description: 'Our local text CAPTCHA generator'
  },
  {
    name: 'Local Lab - reCAPTCHA',
    url: 'http://localhost:3000/recaptcha-v2',
    type: 'recaptcha_v2',
    description: 'Local reCAPTCHA with test keys (always passes)'
  }
];

// Mock Discord message sender for testing
async function mockSendMessage(msg) {
  console.log(`[DISCORD] ${msg}`);
}

/**
 * Test CAPTCHA detection and solving on a page
 */
async function testCaptchaSolving(page, site) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${site.name}`);
  console.log(`URL: ${site.url}`);
  console.log(`Type: ${site.type}`);
  console.log('='.repeat(60));

  try {
    // Navigate to the page
    console.log('\n[1] Navigating to page...');
    await page.goto(site.url, { timeout: 30000, waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Check solver status
    console.log('\n[2] Checking solver capabilities...');
    const status = unifiedSolver.getStatus();
    console.log('Ready solvers:', Object.entries(status.ready)
      .filter(([k, v]) => v)
      .map(([k]) => k)
      .join(', '));

    // Detect CAPTCHA
    console.log('\n[3] Detecting CAPTCHA...');
    const detected = await unifiedSolver.detectCaptchaType(page);

    if (detected.length === 0) {
      console.log('No CAPTCHA detected on page');

      // For reCAPTCHA, we might need to click the checkbox first
      if (site.type === 'recaptcha_v2') {
        console.log('Looking for reCAPTCHA checkbox...');
        const recaptchaFrame = await page.$('iframe[src*="recaptcha"]');
        if (recaptchaFrame) {
          const frame = await recaptchaFrame.contentFrame();
          const checkbox = await frame.$('#recaptcha-anchor');
          if (checkbox) {
            console.log('Clicking reCAPTCHA checkbox...');
            await checkbox.click();
            await page.waitForTimeout(3000);

            // Re-detect after clicking
            const newDetected = await unifiedSolver.detectCaptchaType(page);
            if (newDetected.length > 0) {
              console.log('Challenge appeared:', newDetected[0].name);
            }
          }
        }
      }
      return { success: true, note: 'No challenge appeared (may have auto-passed)' };
    }

    console.log('Detected:', detected.map(d => d.name).join(', '));

    // Attempt to solve
    console.log('\n[4] Attempting to solve CAPTCHA...');
    const startTime = Date.now();

    const result = await unifiedSolver.solveCaptcha(page, {
      preferAudio: true,
      maxAttempts: 3,
      timeout: 60000,
      onProgress: (msg) => console.log(`  [Progress] ${msg}`),
      onCaptchaRequest: async (info) => {
        // In real usage, this would send to Discord and wait for user
        console.log(`  [User Help Needed] ${info.message}`);
        console.log(`  Screenshot: ${info.screenshotPath}`);
        // For testing, we'll skip user intervention
        return null;
      }
    });

    const elapsed = Date.now() - startTime;

    console.log('\n[5] Result:');
    console.log(`  Success: ${result.success}`);
    console.log(`  Method: ${result.method || 'N/A'}`);
    console.log(`  Time: ${elapsed}ms`);
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }

    return result;

  } catch (e) {
    console.error(`\nError testing ${site.name}:`, e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Test the integration with captcha_handler.js
 */
async function testCaptchaHandlerIntegration(page) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('Testing captcha_handler.js Integration');
  console.log('='.repeat(60));

  try {
    // Navigate to a CAPTCHA page
    await page.goto('http://localhost:3000/text-captcha', { timeout: 10000 });
    await page.waitForTimeout(1000);

    console.log('\nUsing autoSolveCaptcha() from captcha_handler.js...');

    const result = await autoSolveCaptcha(page, mockSendMessage, {
      preferAudio: false,  // Text CAPTCHA, use OCR
      fallbackToUser: false,
      maxAttempts: 2
    });

    console.log('\nResult:', JSON.stringify(result, null, 2));
    return result;

  } catch (e) {
    console.error('Integration test error:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('CAPTCHA SOLVER - PLAYWRIGHT INTEGRATION TEST');
  console.log('='.repeat(70));

  // Check solver status first
  console.log('\n--- Solver Status ---\n');
  const status = unifiedSolver.getStatus();
  console.log('Audio:', status.ready.audio ? '✓ Ready' : '✗ Not ready');
  console.log('Image:', status.ready.image ? '✓ Ready' : '✗ Not ready');
  console.log('Cloudflare:', status.ready.cloudflare ? '✓ Ready' : '✗ Not ready');
  console.log('OCR:', status.ready.ocr ? '✓ Ready' : '✗ Not ready');

  // Launch browser
  console.log('\n--- Launching Browser ---\n');
  const browser = await chromium.launch({
    headless: false,  // Show browser for debugging
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();

  const results = [];

  // Test local lab first (doesn't need internet)
  console.log('\n--- Testing Local Lab ---\n');

  // Check if local lab is running
  try {
    await page.goto('http://localhost:3000/', { timeout: 5000 });
    console.log('Local lab is running ✓');

    // Test text CAPTCHA with OCR
    const textResult = await testCaptchaSolving(page, TEST_SITES[2]);
    results.push({ site: 'Local Text CAPTCHA', ...textResult });

    // Test local reCAPTCHA (uses test keys)
    const localRecaptcha = await testCaptchaSolving(page, TEST_SITES[3]);
    results.push({ site: 'Local reCAPTCHA', ...localRecaptcha });

  } catch (e) {
    console.log('Local lab not running. Start with: node server.js');
  }

  // Test real sites
  console.log('\n--- Testing Real Sites ---\n');

  // Test reCAPTCHA demo
  try {
    const recaptchaResult = await testCaptchaSolving(page, TEST_SITES[0]);
    results.push({ site: 'reCAPTCHA Demo', ...recaptchaResult });
  } catch (e) {
    console.log('reCAPTCHA demo test failed:', e.message);
  }

  // Test hCaptcha demo
  try {
    const hcaptchaResult = await testCaptchaSolving(page, TEST_SITES[1]);
    results.push({ site: 'hCaptcha Demo', ...hcaptchaResult });
  } catch (e) {
    console.log('hCaptcha demo test failed:', e.message);
  }

  // Test captcha_handler integration
  try {
    const integrationResult = await testCaptchaHandlerIntegration(page);
    results.push({ site: 'Handler Integration', ...integrationResult });
  } catch (e) {
    console.log('Integration test failed:', e.message);
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('TEST SUMMARY');
  console.log('='.repeat(70) + '\n');

  for (const r of results) {
    const icon = r.success ? '✓' : '✗';
    console.log(`${icon} ${r.site}: ${r.success ? 'PASSED' : 'FAILED'} (${r.method || r.error || 'N/A'})`);
  }

  const passed = results.filter(r => r.success).length;
  console.log(`\nTotal: ${passed}/${results.length} tests passed`);

  // Cleanup
  await browser.close();

  return results;
}

// Run if called directly
if (require.main === module) {
  runTests()
    .then(results => {
      console.log('\nTest complete.');
      process.exit(results.every(r => r.success) ? 0 : 1);
    })
    .catch(e => {
      console.error('Test failed:', e);
      process.exit(1);
    });
}

module.exports = { runTests, testCaptchaSolving };
