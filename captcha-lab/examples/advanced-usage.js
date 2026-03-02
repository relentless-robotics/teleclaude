/**
 * Advanced CAPTCHA Solver Usage
 *
 * Shows advanced features like:
 * - Custom error handling
 * - Retry logic
 * - Progress tracking
 * - Status checking
 */

const { chromium } = require('playwright');
const {
  solveCaptchaOnPage,
  getStatus,
  initializeYOLO
} = require('../solver');

async function main() {
  console.log('🚀 Advanced CAPTCHA Solver Demo\n');

  // 1. Check solver status first
  console.log('1️⃣  Checking solver status...\n');
  const status = getStatus();

  console.log('Image Classification:', status.imageClassification.preferred);
  console.log('Recommendations:', status.recommendations.join(', '));
  console.log('');

  if (!status.imageClassification.ready) {
    console.error('❌ Image classification not available!');
    console.log('\nInstall YOLO: pip install ultralytics');
    return;
  }

  // 2. Pre-initialize YOLO (optional but faster)
  if (status.imageClassification.yolo.installed) {
    console.log('2️⃣  Pre-initializing YOLO model...\n');
    try {
      await initializeYOLO();
      console.log('✅ YOLO initialized\n');
    } catch (e) {
      console.warn('⚠️  YOLO init warning:', e.message);
    }
  }

  // 3. Launch browser with anti-detection
  console.log('3️⃣  Launching browser...\n');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  const page = await context.newPage();

  // 4. Add stealth scripts
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    // 5. Navigate to target
    console.log('4️⃣  Navigating to reCAPTCHA demo...\n');
    await page.goto('https://www.google.com/recaptcha/api2/demo', {
      waitUntil: 'networkidle'
    });

    // 6. Solve with retry logic
    console.log('5️⃣  Solving CAPTCHA with retry logic...\n');

    let solved = false;
    let totalAttempts = 0;
    const maxRetries = 3;
    const progressLog = [];

    for (let retry = 0; retry < maxRetries && !solved; retry++) {
      if (retry > 0) {
        console.log(`\n🔄 Retry ${retry}/${maxRetries - 1}...\n`);
        await page.reload();
        await page.waitForTimeout(2000);
      }

      const result = await solveCaptchaOnPage(page, {
        onProgress: (msg) => {
          const logMsg = `[${new Date().toLocaleTimeString()}] ${msg}`;
          console.log(`   ${logMsg}`);
          progressLog.push(logMsg);
        },
        useYOLO: true,
        preferAudio: true,
        maxAttempts: 2 // Per solve attempt
      });

      totalAttempts++;

      if (result.success) {
        solved = true;
        console.log('\n' + '='.repeat(60));
        console.log('✅ SUCCESS!');
        console.log('='.repeat(60));
        console.log('Method:', result.method);
        console.log('Total retries:', retry);
        console.log('Total attempts:', totalAttempts);

        // 7. Submit form
        console.log('\n6️⃣  Submitting form...\n');
        const submitBtn = await page.$('button[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          await page.waitForTimeout(3000);

          const body = await page.textContent('body');
          if (body.includes('Verification Success')) {
            console.log('✅ Form submission verified!');
          }
        }

      } else {
        console.log('\n❌ Attempt failed:', result.error);

        if (retry < maxRetries - 1) {
          console.log('Will retry...');
        } else {
          console.log('\n' + '='.repeat(60));
          console.log('❌ ALL ATTEMPTS FAILED');
          console.log('='.repeat(60));
          console.log('Last error:', result.error);
        }
      }
    }

    // 8. Save progress log
    console.log('\n7️⃣  Progress log:\n');
    progressLog.forEach(log => console.log(`   ${log}`));

    // Keep browser open
    console.log('\n👀 Browser will stay open for 20 seconds...');
    await page.waitForTimeout(20000);

  } catch (error) {
    console.error('\n💥 Exception:', error.message);
    console.error(error.stack);
  } finally {
    await browser.close();
    console.log('\n✅ Demo complete!');
  }
}

main().catch(console.error);
