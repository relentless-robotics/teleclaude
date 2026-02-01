/**
 * Test script for image CAPTCHA solver
 *
 * Tests the production-ready image solver with reCAPTCHA and hCaptcha
 */

const { chromium } = require('playwright');
const { solveCaptchaOnPage, getStatus, initializeYOLO } = require('./solver');

async function testImageSolver() {
  console.log('='.repeat(60));
  console.log('CAPTCHA Image Solver Test');
  console.log('='.repeat(60));

  // Check status
  console.log('\n1. Checking dependencies...\n');
  const status = getStatus();
  console.log('Status:', JSON.stringify(status, null, 2));

  if (!status.imageClassification.ready) {
    console.log('\n⚠️  Image classification not available!');
    console.log('\nInstall YOLO:');
    console.log('  pip install ultralytics torch torchvision');
    console.log('\nOR set OpenAI API key:');
    console.log('  set OPENAI_API_KEY=sk-...');
    return;
  }

  // Initialize YOLO if available
  if (status.imageClassification.yolo.installed) {
    console.log('\n2. Initializing YOLO model...\n');
    try {
      await initializeYOLO();
      console.log('✅ YOLO ready!');
    } catch (e) {
      console.log('⚠️  YOLO init failed:', e.message);
    }
  }

  // Launch browser
  console.log('\n3. Launching browser...\n');
  const browser = await chromium.launch({
    headless: false, // Show browser for debugging
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    // Test reCAPTCHA image challenge
    console.log('\n4. Testing reCAPTCHA image challenge...\n');
    console.log('Navigate to: https://www.google.com/recaptcha/api2/demo');

    await page.goto('https://www.google.com/recaptcha/api2/demo', {
      waitUntil: 'networkidle'
    });

    console.log('Page loaded. Solving CAPTCHA...\n');

    const result = await solveCaptchaOnPage(page, {
      onProgress: (msg) => console.log(`  [SOLVER] ${msg}`),
      preferAudio: false, // Test image solver specifically
      useYOLO: true,
      maxAttempts: 3
    });

    console.log('\n' + '='.repeat(60));
    console.log('RESULT:', JSON.stringify(result, null, 2));
    console.log('='.repeat(60));

    if (result.success) {
      console.log('\n✅ CAPTCHA solved successfully!');

      // Try to submit the form
      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        console.log('\nSubmitting form...');
        await submitBtn.click();
        await page.waitForTimeout(2000);

        // Check if submission was successful
        const successMsg = await page.$('text=Verification Success');
        if (successMsg) {
          console.log('✅ Form submission verified!');
        }
      }
    } else {
      console.log('\n❌ CAPTCHA solving failed:', result.error);
    }

    // Keep browser open for inspection
    console.log('\nBrowser will stay open for 30 seconds for inspection...');
    await page.waitForTimeout(30000);

  } catch (e) {
    console.error('\n❌ Error during test:', e.message);
    console.error(e.stack);
  } finally {
    await browser.close();
  }
}

// Run test if called directly
if (require.main === module) {
  testImageSolver()
    .then(() => {
      console.log('\n✅ Test complete!');
      process.exit(0);
    })
    .catch((e) => {
      console.error('\n❌ Test failed:', e);
      process.exit(1);
    });
}

module.exports = { testImageSolver };
