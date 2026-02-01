const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const screenshotDir = 'C:/Users/Footb/Documents/Github/teleclaude-main/screenshots';

  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  let context, page;

  // Personal info from instructions (NOT to be shared in Discord messages)
  const personalInfo = {
    fullName: 'Nicholas Liautaud',
    dob: { month: '11', day: '12', year: '2000' },
    address: '336 Canoe Trail Lane',
    city: 'Orlando',
    state: 'FL',
    zip: '32825',
    ssn4: '4335',
    phone: '5618433551',
    email: 'relentlessrobotics@gmail.com'
  };

  try {
    console.log('Launching Edge browser with persistent profile...');
    context = await chromium.launchPersistentContext('./browser_profile_stripe', {
      channel: 'msedge',
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 900 }
    });
    page = context.pages()[0] || await context.newPage();
    console.log('Browser launched');

    // Navigate to dashboard
    console.log('Navigating to Stripe dashboard...');
    await page.goto('https://dashboard.stripe.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    console.log('Page loaded: ' + await page.title());
    console.log('Current URL: ' + page.url());
    await page.screenshot({ path: path.join(screenshotDir, 'stripe_dashboard.png'), fullPage: false });

    // Look for onboarding or activate account buttons
    const activateBtns = [
      'text=Activate your account',
      'text=Complete your profile',
      'text=Get started',
      'text=Start setup',
      'a:has-text("Activate")',
      'button:has-text("Activate")'
    ];

    let foundActivate = false;
    for (const selector of activateBtns) {
      try {
        const btn = await page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          console.log('Found: ' + selector);
          await btn.click();
          await page.waitForTimeout(3000);
          foundActivate = true;
          break;
        }
      } catch (e) {}
    }

    if (!foundActivate) {
      // Try navigating directly to settings/account
      console.log('No activate button found, checking settings...');
      await page.goto('https://dashboard.stripe.com/settings/account', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: path.join(screenshotDir, 'stripe_setup_page.png'), fullPage: false });
    console.log('Current URL: ' + page.url());

    // Helper function to fill field if visible
    async function fillIfVisible(selectors, value, fieldName) {
      for (const selector of (Array.isArray(selectors) ? selectors : [selectors])) {
        try {
          const field = await page.locator(selector).first();
          if (await field.isVisible({ timeout: 1500 })) {
            await field.clear();
            await field.fill(value);
            console.log(fieldName + ' filled');
            return true;
          }
        } catch (e) {}
      }
      return false;
    }

    // Helper to click if visible
    async function clickIfVisible(selectors, btnName) {
      for (const selector of (Array.isArray(selectors) ? selectors : [selectors])) {
        try {
          const btn = await page.locator(selector).first();
          if (await btn.isVisible({ timeout: 1500 })) {
            await btn.click();
            console.log(btnName + ' clicked');
            await page.waitForTimeout(2000);
            return true;
          }
        } catch (e) {}
      }
      return false;
    }

    // Look for business type selection
    console.log('Looking for business type selection...');
    await clickIfVisible([
      'label:has-text("Individual")',
      'button:has-text("Individual")',
      'div:has-text("Individual / Sole proprietor"):not(:has(*))',
      'text=Individual / Sole proprietor',
      '[data-testid="individual"]'
    ], 'Business type Individual');

    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(screenshotDir, 'stripe_business_selected.png'), fullPage: false });

    // Fill business name if present
    await fillIfVisible([
      'input[name="businessName"]',
      'input[placeholder*="business name"]',
      'input[label*="business name"]'
    ], 'Relentless Robotics', 'Business name');

    // Look for personal info section
    console.log('Looking for personal info fields...');

    // First name
    await fillIfVisible([
      'input[name="firstName"]',
      'input[placeholder*="First name"]',
      'input[id*="firstName"]'
    ], 'Nicholas', 'First name');

    // Last name
    await fillIfVisible([
      'input[name="lastName"]',
      'input[placeholder*="Last name"]',
      'input[id*="lastName"]'
    ], 'Liautaud', 'Last name');

    // Date of birth
    await fillIfVisible([
      'input[name="dob-month"]',
      'input[placeholder="MM"]',
      'input[aria-label*="month"]'
    ], personalInfo.dob.month, 'DOB month');

    await fillIfVisible([
      'input[name="dob-day"]',
      'input[placeholder="DD"]',
      'input[aria-label*="day"]'
    ], personalInfo.dob.day, 'DOB day');

    await fillIfVisible([
      'input[name="dob-year"]',
      'input[placeholder="YYYY"]',
      'input[aria-label*="year"]'
    ], personalInfo.dob.year, 'DOB year');

    // Address
    await fillIfVisible([
      'input[name="address.line1"]',
      'input[name="addressLine1"]',
      'input[placeholder*="Address"]',
      'input[id*="line1"]'
    ], personalInfo.address, 'Address');

    // City
    await fillIfVisible([
      'input[name="address.city"]',
      'input[name="city"]',
      'input[placeholder*="City"]'
    ], personalInfo.city, 'City');

    // State dropdown or input
    const stateField = await fillIfVisible([
      'input[name="address.state"]',
      'input[name="state"]',
      'select[name="state"]'
    ], personalInfo.state, 'State');

    if (!stateField) {
      // Try clicking state dropdown
      await clickIfVisible([
        'button[aria-label*="State"]',
        '[data-testid="state-select"]'
      ], 'State dropdown');

      // Select Florida
      await clickIfVisible([
        'option[value="FL"]',
        'li:has-text("Florida")',
        'div:has-text("Florida"):not(:has(*))'
      ], 'Florida option');
    }

    // ZIP
    await fillIfVisible([
      'input[name="address.postal_code"]',
      'input[name="postalCode"]',
      'input[name="zip"]',
      'input[placeholder*="ZIP"]'
    ], personalInfo.zip, 'ZIP');

    // Phone
    await fillIfVisible([
      'input[name="phone"]',
      'input[type="tel"]',
      'input[placeholder*="phone"]'
    ], personalInfo.phone, 'Phone');

    // SSN last 4
    await fillIfVisible([
      'input[name="ssn_last_4"]',
      'input[name="ssnLast4"]',
      'input[placeholder*="SSN"]',
      'input[placeholder*="last 4"]'
    ], personalInfo.ssn4, 'SSN last 4');

    await page.screenshot({ path: path.join(screenshotDir, 'stripe_personal_filled.png'), fullPage: false });

    // Click continue/next/submit
    console.log('Looking for continue button...');
    await clickIfVisible([
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Save")',
      'button[type="submit"]'
    ], 'Continue button');

    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(screenshotDir, 'stripe_after_continue.png'), fullPage: false });
    console.log('Current URL: ' + page.url());

    // Look for bank account section and skip
    console.log('Looking for bank account section to skip...');
    await clickIfVisible([
      'text=Skip for now',
      'text=Set up later',
      'text=Skip',
      'button:has-text("Skip")',
      'a:has-text("Skip")'
    ], 'Skip bank account');

    await page.screenshot({ path: path.join(screenshotDir, 'stripe_final.png'), fullPage: false });
    console.log('Final URL: ' + page.url());

    // Wait for manual review
    console.log('Waiting 300 seconds for manual review and additional steps...');
    await page.waitForTimeout(300000);

    await context.close();
    console.log('Browser closed');
  } catch (error) {
    console.error('Error:', error.message);

    if (page) {
      await page.screenshot({ path: path.join(screenshotDir, 'stripe_onboard_error.png'), fullPage: false });
    }

    if (context) {
      await context.close();
    }
  }
})();
