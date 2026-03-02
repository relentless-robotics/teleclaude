/**
 * hCaptcha Solver Example
 *
 * Shows how to solve hCaptcha image challenges with YOLO.
 */

const { chromium } = require('playwright');
const { solveHCaptchaImages } = require('../solver');

async function main() {
  console.log('🤖 Starting hCaptcha solver demo\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();

  try {
    // Navigate to hCaptcha demo
    // Note: Replace with actual site that uses hCaptcha
    console.log('📍 Navigating to hCaptcha demo...');
    await page.goto('https://accounts.hcaptcha.com/demo');
    await page.waitForTimeout(2000);

    // Click the hCaptcha checkbox to trigger challenge
    console.log('🔘 Clicking hCaptcha checkbox...');
    const checkboxFrame = await page.frame({ url: /hcaptcha\.com\/checkbox/ });
    if (checkboxFrame) {
      const checkbox = await checkboxFrame.$('#checkbox');
      if (checkbox) {
        await checkbox.click();
        await page.waitForTimeout(2000);
      }
    }

    console.log('\n🔍 Solving hCaptcha...\n');

    // Solve the image challenge
    const result = await solveHCaptchaImages(page, {
      onProgress: (msg) => console.log(`   ${msg}`),
      useYOLO: true,
      maxAttempts: 3
    });

    console.log('\n' + '='.repeat(60));

    if (result.success) {
      console.log('✅ HCAPTCHA SOLVED!');
      console.log('Method:', result.method);
      console.log('Images clicked:', result.imagesClicked);
      console.log('Attempts:', result.attempts);
    } else {
      console.log('❌ HCAPTCHA FAILED');
      console.log('Error:', result.error);
    }

    console.log('='.repeat(60));

    console.log('\n👀 Browser will stay open for 15 seconds...');
    await page.waitForTimeout(15000);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    await browser.close();
    console.log('\n✅ Done!');
  }
}

main().catch(console.error);
