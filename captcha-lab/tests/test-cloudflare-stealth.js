/**
 * Test Cloudflare Solver with Stealth Capabilities
 *
 * Tests the improved Cloudflare solver against https://nowsecure.nl/
 * with stealth browser configuration.
 */

const path = require('path');
const { launchStealthBrowser, checkBotDetection } = require('../solver/stealth-browser');
const { solveCloudflare } = require('../solver/cloudflare-solver');

async function testCloudflareWithStealth() {
  console.log('🧪 Testing Cloudflare Solver with Stealth Capabilities\n');

  let browser, context, page;

  try {
    // Launch stealth browser
    console.log('🚀 Launching stealth browser...');
    const result = await launchStealthBrowser({
      headless: false, // Must be visible for best results
      persistent: false
    });

    browser = result.browser;
    context = result.context;
    page = result.page;

    console.log('✅ Stealth browser launched\n');

    // Check bot detection signals before test
    console.log('🔍 Checking bot detection signals...');
    const botCheck = await checkBotDetection(page);
    console.log(`Bot likelihood: ${botCheck.isLikelyBot ? '⚠️ HIGH' : '✅ LOW'}`);
    console.log(`Red flags: ${botCheck.redFlags}`);
    console.log('Signals:', botCheck.signals);
    console.log('');

    // Navigate to Cloudflare test page
    const testUrl = 'https://nowsecure.nl/';
    console.log(`🌐 Navigating to ${testUrl}...`);

    await page.goto(testUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('✅ Page loaded\n');

    // Wait a moment to see if challenge appears
    await page.waitForTimeout(2000);

    // Attempt to solve Cloudflare challenge
    console.log('🔓 Attempting to solve Cloudflare challenge...\n');

    const solveResult = await solveCloudflare(page, {
      timeout: 90000,
      onProgress: (msg) => {
        console.log(`   ${msg}`);
      }
    });

    console.log('\n📊 Results:');
    console.log(`Status: ${solveResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    if (solveResult.method) {
      console.log(`Method: ${solveResult.method}`);
    }
    if (solveResult.error) {
      console.log(`Error: ${solveResult.error}`);
    }
    if (solveResult.message) {
      console.log(`Message: ${solveResult.message}`);
    }

    // Take screenshot of final state
    const screenshotPath = path.join(__dirname, '../screenshots/cloudflare-stealth-result.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`\n📸 Screenshot saved: ${screenshotPath}`);

    // Check final URL
    const finalUrl = page.url();
    console.log(`\n🔗 Final URL: ${finalUrl}`);

    // Keep browser open for manual inspection
    console.log('\n⏸️  Browser will remain open for 30 seconds for inspection...');
    await page.waitForTimeout(30000);

  } catch (error) {
    console.error('❌ Error during test:', error.message);
    console.error(error.stack);
  } finally {
    if (browser) {
      console.log('\n🔚 Closing browser...');
      await browser.close();
    }
  }
}

// Run test
testCloudflareWithStealth().catch(console.error);
