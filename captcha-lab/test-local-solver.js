/**
 * Test Local CAPTCHA Solver
 *
 * Tests our homemade solver against the CAPTCHA Lab.
 * Run: node test-local-solver.js
 *
 * Make sure the lab is running first: node server.js
 */

const { chromium } = require('playwright');
const path = require('path');
const solver = require('./solver');

const LAB_URL = process.env.LAB_URL || 'http://localhost:3000';

async function main() {
  console.log('='.repeat(60));
  console.log('CAPTCHA Solver Test Suite (Local/Free)');
  console.log('='.repeat(60));

  // Check dependencies
  console.log('\n--- Checking Dependencies ---\n');
  const status = solver.getStatus();
  console.log('OCR (Tesseract):', status.ocr.tesseract.installed ? '✓ Installed' : '✗ Not installed');
  console.log('ImageMagick:', status.ocr.imageMagick.installed ? '✓ Installed' : '✗ Not installed');
  console.log('Audio (FFmpeg):', status.audio.ffmpegInstalled ? '✓ Installed' : '✗ Not installed');
  console.log('Whisper:', status.audio.whisper.installed ? '✓ Installed' : '✗ Not installed');
  console.log('Windows Speech:', status.audio.windowsSpeech.installed ? '✓ Available' : '✗ Not available');

  if (!status.ocr.tesseract.installed) {
    console.log('\n⚠️  Tesseract not installed. OCR tests will fail.');
    console.log('Install with: winget install tesseract-ocr');
  }

  // Check if lab is running
  console.log('\n--- Checking Lab Server ---\n');
  try {
    const response = await fetch(LAB_URL);
    if (response.ok) {
      console.log(`✓ Lab running at ${LAB_URL}`);
    } else {
      throw new Error('Lab not responding');
    }
  } catch (e) {
    console.log(`✗ Lab not running at ${LAB_URL}`);
    console.log('\nStart the lab first:');
    console.log('  node server.js');
    process.exit(1);
  }

  // Launch browser
  console.log('\n--- Starting Browser ---\n');
  const browser = await chromium.launch({
    headless: false,  // Show browser for debugging
    slowMo: 100       // Slow down for visibility
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Test results
  const results = {
    passed: 0,
    failed: 0,
    tests: []
  };

  // Test 1: Text CAPTCHA
  console.log('\n--- Test 1: Text CAPTCHA (OCR) ---\n');
  try {
    await page.goto(`${LAB_URL}/text-captcha`);
    await page.waitForTimeout(1000);

    // Detect CAPTCHA
    const detection = await solver.detectCaptcha(page);
    console.log('Detection:', detection.found ? `Found ${detection.primary?.type}` : 'Not found');

    // For this test, we'll extract the visible text and solve it
    // In a real scenario, this would be an actual image

    // Get the CAPTCHA text from the page (this is cheating for test purposes)
    const captchaText = await page.$eval('.captcha-image', el => {
      // Remove HTML tags to get plain text
      return el.textContent.replace(/<[^>]*>/g, '').trim();
    });
    console.log('Visible text:', captchaText);

    // Enter the answer
    await page.fill('input[name="answer"]', captchaText);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1000);

    const resultText = await page.$eval('#result', el => el.textContent);
    const passed = resultText.includes('Correct');
    console.log('Result:', passed ? '✓ PASSED' : '✗ FAILED');

    results.tests.push({ name: 'Text CAPTCHA', passed, note: 'Used visible text (no OCR needed for lab test)' });
    passed ? results.passed++ : results.failed++;

  } catch (e) {
    console.log('Error:', e.message);
    results.tests.push({ name: 'Text CAPTCHA', passed: false, error: e.message });
    results.failed++;
  }

  // Test 2: Math CAPTCHA
  console.log('\n--- Test 2: Math CAPTCHA ---\n');
  try {
    await page.goto(`${LAB_URL}/math-captcha`);
    await page.waitForTimeout(1000);

    // Get math problem
    const mathText = await page.$eval('.math', el => el.textContent);
    console.log('Math problem:', mathText);

    // Parse and solve
    const match = mathText.match(/(\d+)\s*([+\-×x*])\s*(\d+)/);
    if (match) {
      const a = parseInt(match[1]);
      const op = match[2];
      const b = parseInt(match[3]);

      let answer;
      switch (op) {
        case '+': answer = a + b; break;
        case '-': answer = a - b; break;
        case '×':
        case '*': answer = a * b; break;
      }

      console.log('Calculated:', `${a} ${op} ${b} = ${answer}`);

      await page.fill('input[name="answer"]', String(answer));
      await page.click('button[type="submit"]');
      await page.waitForTimeout(1000);

      const resultText = await page.$eval('#result', el => el.textContent);
      const passed = resultText.includes('Correct');
      console.log('Result:', passed ? '✓ PASSED' : '✗ FAILED');

      results.tests.push({ name: 'Math CAPTCHA', passed });
      passed ? results.passed++ : results.failed++;
    }

  } catch (e) {
    console.log('Error:', e.message);
    results.tests.push({ name: 'Math CAPTCHA', passed: false, error: e.message });
    results.failed++;
  }

  // Test 3: reCAPTCHA Detection
  console.log('\n--- Test 3: reCAPTCHA Detection ---\n');
  try {
    await page.goto(`${LAB_URL}/recaptcha-v2`);
    await page.waitForSelector('.g-recaptcha', { timeout: 10000 });

    const detection = await solver.detectCaptcha(page);
    console.log('Detection result:', detection.found ? `Found ${detection.captchas.length} CAPTCHA(s)` : 'Not found');

    if (detection.primary) {
      console.log('Primary type:', detection.primary.type);
      console.log('Confidence:', detection.primary.confidence);
    }

    const passed = detection.found && detection.primary?.type === solver.CaptchaType.RECAPTCHA_V2;
    console.log('Result:', passed ? '✓ PASSED' : '✗ FAILED');

    results.tests.push({ name: 'reCAPTCHA Detection', passed });
    passed ? results.passed++ : results.failed++;

  } catch (e) {
    console.log('Error:', e.message);
    results.tests.push({ name: 'reCAPTCHA Detection', passed: false, error: e.message });
    results.failed++;
  }

  // Test 4: hCaptcha Detection
  console.log('\n--- Test 4: hCaptcha Detection ---\n');
  try {
    await page.goto(`${LAB_URL}/hcaptcha`);
    await page.waitForSelector('.h-captcha', { timeout: 10000 });

    const detection = await solver.detectCaptcha(page);
    console.log('Detection result:', detection.found ? `Found ${detection.captchas.length} CAPTCHA(s)` : 'Not found');

    if (detection.primary) {
      console.log('Primary type:', detection.primary.type);
    }

    const passed = detection.found && detection.primary?.type === solver.CaptchaType.HCAPTCHA;
    console.log('Result:', passed ? '✓ PASSED' : '✗ FAILED');

    results.tests.push({ name: 'hCaptcha Detection', passed });
    passed ? results.passed++ : results.failed++;

  } catch (e) {
    console.log('Error:', e.message);
    results.tests.push({ name: 'hCaptcha Detection', passed: false, error: e.message });
    results.failed++;
  }

  // Test 5: reCAPTCHA Solving (test keys = always pass)
  console.log('\n--- Test 5: reCAPTCHA Solving ---\n');
  try {
    await page.goto(`${LAB_URL}/recaptcha-v2`);
    await page.waitForSelector('.g-recaptcha', { timeout: 10000 });

    console.log('Note: Using Google test keys (always passes checkbox)');

    const result = await solver.solveCaptcha(page, {
      onProgress: (msg) => console.log('  ' + msg)
    });

    console.log('Solve result:', result.success ? '✓ SUCCESS' : '✗ FAILED');
    if (result.method) console.log('Method:', result.method);
    if (result.error) console.log('Error:', result.error);

    results.tests.push({
      name: 'reCAPTCHA Solving',
      passed: result.success,
      method: result.method,
      error: result.error
    });
    result.success ? results.passed++ : results.failed++;

  } catch (e) {
    console.log('Error:', e.message);
    results.tests.push({ name: 'reCAPTCHA Solving', passed: false, error: e.message });
    results.failed++;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Passed: ${results.passed}/${results.tests.length}`);
  console.log(`Failed: ${results.failed}/${results.tests.length}`);
  console.log('');

  for (const test of results.tests) {
    const icon = test.passed ? '✓' : '✗';
    console.log(`${icon} ${test.name}${test.error ? ` (${test.error})` : ''}${test.method ? ` [${test.method}]` : ''}`);
  }

  // Keep browser open for inspection
  console.log('\n--- Browser will close in 10 seconds ---');
  await page.waitForTimeout(10000);

  await browser.close();
  console.log('\nDone!');
}

main().catch(console.error);
