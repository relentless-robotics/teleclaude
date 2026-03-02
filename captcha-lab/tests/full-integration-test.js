/**
 * Full CAPTCHA Integration Test Suite
 *
 * Tests all CAPTCHA solvers against real websites:
 * 1. reCAPTCHA v2 Audio
 * 2. Cloudflare Turnstile
 * 3. hCaptcha
 * 4. Text CAPTCHA OCR
 */

const path = require('path');
const { launchStealthBrowser } = require('../solver/stealth-browser');
const { solveCaptcha, detectCaptchaType } = require('../solver/unified-solver');
const { solveCloudflare } = require('../solver/cloudflare-solver');

// Test results storage
const results = [];

/**
 * Send Discord message (using MCP)
 */
async function sendDiscord(message) {
  try {
    // Try to load the Discord MCP module
    const discordModule = require('../../mcp/discord');
    if (discordModule && discordModule.send_to_discord) {
      await discordModule.send_to_discord({ message });
    } else {
      console.log('[Discord]', message);
    }
  } catch (e) {
    // Fallback to console if MCP not available
    console.log('[Discord]', message);
  }
}

/**
 * Format time in seconds
 */
function formatTime(ms) {
  return (ms / 1000).toFixed(2) + 's';
}

/**
 * Test 1: reCAPTCHA v2 Audio Challenge
 */
async function testRecaptchaAudio() {
  const testName = 'reCAPTCHA v2 Audio';
  const testUrl = 'https://www.google.com/recaptcha/api2/demo';

  await sendDiscord(`\n🧪 **Test 1: ${testName}**\nURL: ${testUrl}\nStarting...`);

  const startTime = Date.now();
  let browser, context, page;

  try {
    // Launch stealth browser
    ({ browser, context, page } = await launchStealthBrowser({ headless: false }));

    await sendDiscord('Browser launched. Navigating to demo site...');

    // Navigate to demo
    await page.goto(testUrl, { waitUntil: 'networkidle' });

    await sendDiscord('Page loaded. Detecting CAPTCHA type...');

    // Detect CAPTCHA
    const detected = await detectCaptchaType(page);
    await sendDiscord(`Detected: ${detected.map(d => d.name).join(', ')}`);

    // Solve with audio preference
    await sendDiscord('Attempting to solve with audio method...');

    const result = await solveCaptcha(page, {
      preferAudio: true,
      timeout: 120000,
      onProgress: (msg) => {
        console.log(`[reCAPTCHA Audio] ${msg}`);
      }
    });

    const duration = Date.now() - startTime;

    // Record result
    results.push({
      test: testName,
      url: testUrl,
      success: result.success,
      method: result.method || 'unknown',
      duration: formatTime(duration),
      error: result.error || null
    });

    if (result.success) {
      await sendDiscord(`✅ **SUCCESS**\nMethod: ${result.method}\nTime: ${formatTime(duration)}`);
    } else {
      await sendDiscord(`❌ **FAILED**\nError: ${result.error}\nTime: ${formatTime(duration)}`);
    }

  } catch (e) {
    const duration = Date.now() - startTime;
    results.push({
      test: testName,
      url: testUrl,
      success: false,
      method: 'N/A',
      duration: formatTime(duration),
      error: e.message
    });

    await sendDiscord(`❌ **FAILED**\nError: ${e.message}\nTime: ${formatTime(duration)}`);

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Test 2: Cloudflare Turnstile
 */
async function testCloudflareTurnstile() {
  const testName = 'Cloudflare Turnstile';
  const testUrl = 'https://nowsecure.nl/';

  await sendDiscord(`\n🧪 **Test 2: ${testName}**\nURL: ${testUrl}\nStarting...`);

  const startTime = Date.now();
  let browser, context, page;

  try {
    // Launch stealth browser
    ({ browser, context, page } = await launchStealthBrowser({ headless: false }));

    await sendDiscord('Browser launched. Navigating to test site...');

    // Navigate to site with Cloudflare
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await sendDiscord('Page loaded. Checking for Cloudflare challenge...');

    // Wait a moment for challenge to appear
    await page.waitForTimeout(2000);

    // Solve Cloudflare
    await sendDiscord('Attempting to bypass Cloudflare...');

    const result = await solveCloudflare(page, {
      timeout: 120000,
      onProgress: (msg) => {
        console.log(`[Cloudflare] ${msg}`);
      }
    });

    const duration = Date.now() - startTime;

    // Record result
    results.push({
      test: testName,
      url: testUrl,
      success: result.success,
      method: result.method || 'unknown',
      duration: formatTime(duration),
      error: result.error || null
    });

    if (result.success) {
      await sendDiscord(`✅ **SUCCESS**\nMethod: ${result.method}\nTime: ${formatTime(duration)}`);

      // Take screenshot of success
      const screenshotPath = path.join(__dirname, '../temp', 'cloudflare_success.png');
      await page.screenshot({ path: screenshotPath });
      await sendDiscord(`Screenshot saved: ${screenshotPath}`);

    } else {
      await sendDiscord(`❌ **FAILED**\nError: ${result.error}\nTime: ${formatTime(duration)}`);
    }

  } catch (e) {
    const duration = Date.now() - startTime;
    results.push({
      test: testName,
      url: testUrl,
      success: false,
      method: 'N/A',
      duration: formatTime(duration),
      error: e.message
    });

    await sendDiscord(`❌ **FAILED**\nError: ${e.message}\nTime: ${formatTime(duration)}`);

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Test 3: hCaptcha
 */
async function testHCaptcha() {
  const testName = 'hCaptcha';
  const testUrl = 'https://accounts.hcaptcha.com/demo';

  await sendDiscord(`\n🧪 **Test 3: ${testName}**\nURL: ${testUrl}\nStarting...`);

  const startTime = Date.now();
  let browser, context, page;

  try {
    // Launch stealth browser
    ({ browser, context, page } = await launchStealthBrowser({ headless: false }));

    await sendDiscord('Browser launched. Navigating to demo site...');

    // Navigate to demo
    await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 60000 });

    await sendDiscord('Page loaded. Detecting CAPTCHA...');

    // Detect CAPTCHA
    const detected = await detectCaptchaType(page);
    await sendDiscord(`Detected: ${detected.map(d => d.name).join(', ')}`);

    // Solve hCaptcha
    await sendDiscord('Attempting to solve hCaptcha...');

    const result = await solveCaptcha(page, {
      timeout: 120000,
      onProgress: (msg) => {
        console.log(`[hCaptcha] ${msg}`);
      }
    });

    const duration = Date.now() - startTime;

    // Record result
    results.push({
      test: testName,
      url: testUrl,
      success: result.success,
      method: result.method || 'unknown',
      duration: formatTime(duration),
      error: result.error || null
    });

    if (result.success) {
      await sendDiscord(`✅ **SUCCESS**\nMethod: ${result.method}\nTime: ${formatTime(duration)}`);
    } else {
      await sendDiscord(`❌ **FAILED**\nError: ${result.error}\nTime: ${formatTime(duration)}`);
    }

  } catch (e) {
    const duration = Date.now() - startTime;
    results.push({
      test: testName,
      url: testUrl,
      success: false,
      method: 'N/A',
      duration: formatTime(duration),
      error: e.message
    });

    await sendDiscord(`❌ **FAILED**\nError: ${e.message}\nTime: ${formatTime(duration)}`);

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Test 4: Text CAPTCHA OCR
 */
async function testTextCaptchaOCR() {
  const testName = 'Text CAPTCHA OCR';

  await sendDiscord(`\n🧪 **Test 4: ${testName}**\nSkipped (no public test site available)`);

  // Record skipped result
  results.push({
    test: testName,
    url: 'N/A',
    success: null,
    method: 'N/A',
    duration: '0s',
    error: 'Skipped - no public test site'
  });
}

/**
 * Generate summary table
 */
function generateSummary() {
  const successCount = results.filter(r => r.success === true).length;
  const failCount = results.filter(r => r.success === false).length;
  const skippedCount = results.filter(r => r.success === null).length;

  let summary = '\n**📊 CAPTCHA INTEGRATION TEST RESULTS**\n\n';
  summary += `**Summary:**\n`;
  summary += `✅ Passed: ${successCount}\n`;
  summary += `❌ Failed: ${failCount}\n`;
  summary += `⏭️ Skipped: ${skippedCount}\n`;
  summary += `📝 Total: ${results.length}\n\n`;

  summary += '**Detailed Results:**\n';
  summary += '```\n';
  summary += 'Test                      | Result  | Method              | Time\n';
  summary += '--------------------------|---------|---------------------|-------\n';

  for (const result of results) {
    const status = result.success === true ? '✅ PASS' :
                   result.success === false ? '❌ FAIL' :
                   '⏭️ SKIP';

    const testNamePadded = result.test.padEnd(25, ' ');
    const statusPadded = status.padEnd(7, ' ');
    const methodPadded = (result.method || 'N/A').padEnd(19, ' ');
    const timePadded = result.duration.padEnd(6, ' ');

    summary += `${testNamePadded} | ${statusPadded} | ${methodPadded} | ${timePadded}\n`;

    if (result.error) {
      summary += `  Error: ${result.error}\n`;
    }
  }

  summary += '```\n';

  return summary;
}

/**
 * Main test runner
 */
async function runAllTests() {
  await sendDiscord('🚀 **Starting CAPTCHA Integration Test Suite**\n\nRunning 4 tests against real websites...');

  // Test 1: reCAPTCHA v2 Audio
  await testRecaptchaAudio();
  await new Promise(resolve => setTimeout(resolve, 3000)); // Pause between tests

  // Test 2: Cloudflare Turnstile
  await testCloudflareTurnstile();
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Test 3: hCaptcha
  await testHCaptcha();
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Test 4: Text CAPTCHA OCR (skipped)
  await testTextCaptchaOCR();

  // Generate and send summary
  const summary = generateSummary();
  await sendDiscord(summary);

  console.log('\n' + summary);
  console.log('\n✅ All tests complete!');
}

// Run tests
runAllTests().catch(async (e) => {
  await sendDiscord(`❌ **Test suite crashed:** ${e.message}`);
  console.error('Test suite error:', e);
  process.exit(1);
});
