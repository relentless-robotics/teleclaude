/**
 * CAPTCHA Solver Test Script
 *
 * Tests the captcha_solver module against the local CAPTCHA Lab.
 * Run the lab server first: node server.js
 * Then run this: node test-solver.js
 */

const { chromium } = require('playwright');
const path = require('path');

// Import the solver from parent directory
const solverPath = path.join(__dirname, '..', 'utils', 'captcha_solver.js');
let solver;
try {
  solver = require(solverPath);
} catch (e) {
  console.error('Could not load solver:', e.message);
  console.log('Make sure captcha_solver.js exists in ../utils/');
  process.exit(1);
}

const LAB_URL = process.env.LAB_URL || 'http://localhost:3000';

/**
 * Test reCAPTCHA v2 detection and solving
 */
async function testRecaptchaV2(page) {
  console.log('\n=== Testing reCAPTCHA v2 ===');

  await page.goto(`${LAB_URL}/recaptcha-v2`);
  await page.waitForSelector('.g-recaptcha');

  // Check if solver can detect it
  const hasRecaptcha = await page.$('iframe[src*="recaptcha"]');
  console.log('reCAPTCHA detected:', !!hasRecaptcha);

  // Get site key
  const siteKey = await page.evaluate(() => {
    const elem = document.querySelector('[data-sitekey]');
    return elem?.getAttribute('data-sitekey');
  });
  console.log('Site key:', siteKey);

  if (solver.isConfigured()) {
    console.log('Solver is configured, attempting to solve...');
    try {
      const result = await solver.solveRecaptchaV2(siteKey, page.url());
      console.log('Solution received:', result.solution?.slice(0, 50) + '...');

      // Apply solution
      await solver.applySolution(page, result.solution, 'recaptcha_v2');
      console.log('Solution applied!');

      // Submit form
      await page.click('button[type="submit"]');
      await page.waitForSelector('#result');
      const resultText = await page.$eval('#result', el => el.textContent);
      console.log('Form result:', resultText);
    } catch (e) {
      console.log('Solve error:', e.message);
    }
  } else {
    console.log('Solver not configured (no API key). Skipping solve test.');
    console.log('To test solving, set TWOCAPTCHA_API_KEY or add key to API_KEYS.md');
  }

  return true;
}

/**
 * Test hCaptcha detection
 */
async function testHCaptcha(page) {
  console.log('\n=== Testing hCaptcha ===');

  await page.goto(`${LAB_URL}/hcaptcha`);
  await page.waitForSelector('.h-captcha');

  const hasHCaptcha = await page.$('iframe[src*="hcaptcha"]');
  console.log('hCaptcha detected:', !!hasHCaptcha);

  const siteKey = await page.evaluate(() => {
    const elem = document.querySelector('[data-sitekey]');
    return elem?.getAttribute('data-sitekey');
  });
  console.log('Site key:', siteKey);

  if (solver.isConfigured()) {
    console.log('Attempting to solve hCaptcha...');
    try {
      const result = await solver.solveHCaptcha(siteKey, page.url());
      console.log('Solution received!');
      await solver.applySolution(page, result.solution, 'hcaptcha');
      console.log('Solution applied!');
    } catch (e) {
      console.log('Solve error:', e.message);
    }
  }

  return true;
}

/**
 * Test text CAPTCHA
 */
async function testTextCaptcha(page) {
  console.log('\n=== Testing Text CAPTCHA ===');

  await page.goto(`${LAB_URL}/text-captcha`);

  // Get the CAPTCHA text (in real scenario, this would be an image)
  const captchaText = await page.$eval('.captcha-image', el => el.textContent);
  console.log('CAPTCHA text (raw):', captchaText);

  // Extract just letters/numbers (remove HTML)
  const cleanText = captchaText.replace(/<[^>]*>/g, '').trim();
  console.log('CAPTCHA text (clean):', cleanText);

  // In a real test, we'd send the image to 2captcha
  // For now, just demonstrate the input
  await page.fill('input[name="answer"]', cleanText);
  await page.click('button[type="submit"]');

  await page.waitForSelector('#result');
  const result = await page.$eval('#result', el => el.textContent);
  console.log('Result:', result);

  return result.includes('Correct');
}

/**
 * Test math CAPTCHA
 */
async function testMathCaptcha(page) {
  console.log('\n=== Testing Math CAPTCHA ===');

  await page.goto(`${LAB_URL}/math-captcha`);

  // Get the math problem
  const mathText = await page.$eval('.math', el => el.textContent);
  console.log('Math problem:', mathText);

  // Parse and solve (simple example)
  const match = mathText.match(/(\d+)\s*([+\-×*])\s*(\d+)/);
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

    console.log('Calculated answer:', answer);
    await page.fill('input[name="answer"]', String(answer));
    await page.click('button[type="submit"]');

    await page.waitForSelector('#result');
    const result = await page.$eval('#result', el => el.textContent);
    console.log('Result:', result);

    return result.includes('Correct');
  }

  return false;
}

/**
 * Test auto-detection
 */
async function testAutoDetection(page) {
  console.log('\n=== Testing Auto-Detection ===');

  const testPages = [
    { name: 'reCAPTCHA v2', url: `${LAB_URL}/recaptcha-v2`, expected: 'recaptcha' },
    { name: 'hCaptcha', url: `${LAB_URL}/hcaptcha`, expected: 'hcaptcha' },
    { name: 'Text CAPTCHA', url: `${LAB_URL}/text-captcha`, expected: 'image' }
  ];

  for (const test of testPages) {
    await page.goto(test.url);
    await page.waitForTimeout(1000); // Wait for CAPTCHA to load

    try {
      const detection = await solver.detectAndSolve(page);
      console.log(`${test.name}: Detected as "${detection.type || 'none'}"`,
        detection.success ? '✓' : `(${detection.error || 'not solved'})`);
    } catch (e) {
      console.log(`${test.name}: Detection error - ${e.message}`);
    }
  }
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('CAPTCHA Solver Test Suite');
  console.log('='.repeat(50));
  console.log(`Lab URL: ${LAB_URL}`);
  console.log(`Solver configured: ${solver.isConfigured()}`);

  if (solver.isConfigured()) {
    try {
      const balance = await solver.getBalance();
      console.log(`2captcha balance: $${balance.balance}`);
    } catch (e) {
      console.log('Could not get balance:', e.message);
    }
  }

  const browser = await chromium.launch({
    headless: true // Set to false to see the browser
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Test each CAPTCHA type
    await testRecaptchaV2(page);
    await testHCaptcha(page);
    await testTextCaptcha(page);
    await testMathCaptcha(page);
    await testAutoDetection(page);

    console.log('\n' + '='.repeat(50));
    console.log('Tests completed!');

  } catch (e) {
    console.error('Test error:', e);
  } finally {
    await browser.close();
  }
}

// Check if lab is running
async function checkLabRunning() {
  try {
    const response = await fetch(LAB_URL);
    return response.ok;
  } catch {
    return false;
  }
}

// Main
(async () => {
  const labRunning = await checkLabRunning();

  if (!labRunning) {
    console.error(`CAPTCHA Lab not running at ${LAB_URL}`);
    console.log('\nStart the lab first:');
    console.log('  cd captcha-lab');
    console.log('  npm install');
    console.log('  node server.js');
    console.log('\nOr with Docker:');
    console.log('  docker build -t captcha-lab .');
    console.log('  docker run -p 3000:3000 captcha-lab');
    process.exit(1);
  }

  await runTests();
})();
