/**
 * Simple reCAPTCHA Solver Example
 *
 * Shows the easiest way to solve reCAPTCHA with the image solver.
 */

const { chromium } = require('playwright');
const { solveCaptchaOnPage } = require('../solver');

async function main() {
  console.log('🤖 Starting reCAPTCHA solver demo\n');

  // Launch browser
  const browser = await chromium.launch({
    headless: false, // Show browser
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();

  try {
    // Navigate to reCAPTCHA demo page
    console.log('📍 Navigating to reCAPTCHA demo...');
    await page.goto('https://www.google.com/recaptcha/api2/demo');
    await page.waitForTimeout(2000);

    console.log('\n🔍 Solving CAPTCHA...\n');

    // Solve CAPTCHA - that's it!
    const result = await solveCaptchaOnPage(page, {
      onProgress: (msg) => console.log(`   ${msg}`),
      useYOLO: true,
      preferAudio: true, // Try audio first (more reliable)
      maxAttempts: 3
    });

    console.log('\n' + '='.repeat(60));

    if (result.success) {
      console.log('✅ CAPTCHA SOLVED!');
      console.log('Method:', result.method);
      console.log('Attempts:', result.attempts);

      // Try submitting the form
      console.log('\n📤 Submitting form...');
      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForTimeout(3000);

        // Check for success
        const successText = await page.textContent('body');
        if (successText.includes('Verification Success')) {
          console.log('✅ Form submission successful!');
        } else {
          console.log('⚠️  Form submission status unclear');
        }
      }
    } else {
      console.log('❌ CAPTCHA FAILED');
      console.log('Error:', result.error);
    }

    console.log('='.repeat(60));

    // Keep browser open to see results
    console.log('\n👀 Browser will stay open for 15 seconds...');
    await page.waitForTimeout(15000);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    await browser.close();
    console.log('\n✅ Done!');
  }
}

// Run it
main().catch(console.error);
