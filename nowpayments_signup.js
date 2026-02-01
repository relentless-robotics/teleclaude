const { chromium } = require('playwright');
const fs = require('fs');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized']
    });

    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 }
    });

    const page = await context.newPage();

    try {
        // Go directly to create account page
        console.log('[STEP] Navigating to NOWPayments create account page...');
        await page.goto('https://account.nowpayments.io/create-account', { waitUntil: 'networkidle', timeout: 60000 });
        await delay(2000);

        // Accept cookies if present
        try {
            const acceptBtn = await page.locator('button:has-text("Accept")').first();
            if (await acceptBtn.isVisible({ timeout: 2000 })) {
                await acceptBtn.click();
                console.log('[STEP] Accepted cookies');
                await delay(1000);
            }
        } catch (e) {}

        await page.screenshot({ path: 'nowpayments_01_create_account.png', fullPage: false });
        console.log('[STEP] On create account page');

        // Fill email field
        console.log('[STEP] Filling email...');
        const emailField = await page.locator('input[placeholder*="mail"], input[name*="email"], input[type="email"]').first();
        if (await emailField.count() > 0) {
            await emailField.fill('relentlessrobotics@gmail.com');
            console.log('[STEP] Filled email');
        }

        // Fill password fields
        console.log('[STEP] Filling password...');
        const passwordField = await page.locator('input[placeholder="Password"]').first();
        if (await passwordField.count() > 0) {
            await passwordField.fill('Relaxing41!');
            console.log('[STEP] Filled password');
        }

        await delay(500);

        const confirmPasswordField = await page.locator('input[placeholder="Confirm password"]').first();
        if (await confirmPasswordField.count() > 0) {
            await confirmPasswordField.fill('Relaxing41!');
            console.log('[STEP] Filled confirm password');
        }

        await delay(500);

        // Check the terms checkbox using JavaScript
        console.log('[STEP] Checking terms checkbox...');
        await page.evaluate(() => {
            const checkbox = document.querySelector('#isAgreeTermsCheckbox');
            if (checkbox && !checkbox.checked) {
                checkbox.click();
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        console.log('[STEP] Checked terms via JavaScript');

        // Also click the label
        try {
            await page.click('label[for="isAgreeTermsCheckbox"]', { force: true });
        } catch (e) {}

        await delay(1000);
        await page.screenshot({ path: 'nowpayments_02_form_filled.png', fullPage: false });

        // Click Next step - this will trigger CAPTCHA
        console.log('[STEP] Clicking Next step...');
        await page.click('button:has-text("Next step")');
        console.log('[STEP] Clicked Next step - CAPTCHA may appear');
        await delay(3000);

        await page.screenshot({ path: 'nowpayments_03_captcha.png', fullPage: true });

        // Wait for CAPTCHA to be solved manually
        console.log('');
        console.log('========================================');
        console.log('[CAPTCHA] PLEASE SOLVE THE CAPTCHA NOW!');
        console.log('[CAPTCHA] Select all images with the requested object');
        console.log('[CAPTCHA] Then click VERIFY');
        console.log('[WAITING] Waiting up to 120 seconds for CAPTCHA...');
        console.log('========================================');
        console.log('');

        // Poll for page change (indicates CAPTCHA solved and form submitted)
        let captchaSolved = false;
        for (let i = 0; i < 60; i++) {
            await delay(2000);
            const currentUrl = page.url();
            const bodyText = await page.textContent('body');

            // Check if we've moved past the signup page
            if (!currentUrl.includes('create-account') || bodyText.includes('verify your email') || bodyText.includes('verification')) {
                captchaSolved = true;
                console.log('[SUCCESS] CAPTCHA solved and form submitted!');
                break;
            }

            // Check if CAPTCHA is still visible
            const captchaFrame = await page.locator('iframe[title*="challenge"]').count();
            if (captchaFrame === 0 && i > 5) {
                // CAPTCHA frame gone, check if we're still on form
                const stillOnForm = await page.locator('button:has-text("Next step")').count();
                if (stillOnForm === 0) {
                    captchaSolved = true;
                    console.log('[SUCCESS] Form submitted!');
                    break;
                }
            }

            if (i % 5 === 0) {
                console.log('[WAITING] Still waiting for CAPTCHA... ' + (120 - i*2) + ' seconds remaining');
            }
        }

        await page.screenshot({ path: 'nowpayments_04_after_captcha.png', fullPage: false });
        console.log('[STEP] After CAPTCHA, URL: ' + page.url());

        // Check for email verification
        const pageContent = await page.textContent('body');
        if (pageContent.toLowerCase().includes('verify') || pageContent.toLowerCase().includes('email') || pageContent.toLowerCase().includes('confirm')) {
            console.log('[INFO] Email verification may be required');
            console.log('[INFO] Please check relentlessrobotics@gmail.com');
            console.log('[WAITING] Waiting 180 seconds for email verification...');
            await page.screenshot({ path: 'nowpayments_05_verify_email.png', fullPage: false });
            await delay(180000);
        }

        // Try to login
        console.log('[STEP] Attempting login...');
        await page.goto('https://account.nowpayments.io/sign-in', { waitUntil: 'networkidle', timeout: 60000 });
        await delay(2000);

        await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
        await page.fill('input[type="password"]', 'Relaxing41!');
        await page.screenshot({ path: 'nowpayments_06_login.png', fullPage: false });

        await page.click('button:has-text("Sign in")');
        await delay(5000);

        await page.screenshot({ path: 'nowpayments_07_after_login.png', fullPage: false });
        const loginUrl = page.url();
        console.log('[STEP] After login, URL: ' + loginUrl);

        if (!loginUrl.includes('sign-in')) {
            console.log('[SUCCESS] Logged in!');

            // Navigate to API keys
            console.log('[STEP] Navigating to API keys...');
            await page.goto('https://account.nowpayments.io/api-keys', { waitUntil: 'networkidle', timeout: 30000 });
            await delay(3000);
            await page.screenshot({ path: 'nowpayments_08_api_keys.png', fullPage: false });

            // Check for existing keys
            const apiPageContent = await page.textContent('body');
            console.log('[INFO] API page loaded');

            // Navigate to store settings for wallet
            console.log('[STEP] Navigating to store settings...');
            await page.goto('https://account.nowpayments.io/store-settings', { waitUntil: 'networkidle', timeout: 30000 });
            await delay(3000);
            await page.screenshot({ path: 'nowpayments_09_store.png', fullPage: false });
        } else {
            console.log('[INFO] Still on login page - may need email verification');
        }

        // Final status
        console.log('[FINAL] Final URL: ' + page.url());
        await page.screenshot({ path: 'nowpayments_final.png', fullPage: true });

        // Keep browser open
        console.log('[INFO] Keeping browser open for 300 seconds...');
        await delay(300000);

    } catch (error) {
        console.log('[ERROR] ' + error.message);
        await page.screenshot({ path: 'nowpayments_error.png', fullPage: true });
        console.log('[INFO] Keeping browser open despite error...');
        await delay(180000);
    } finally {
        await browser.close();
        console.log('[DONE] Browser closed');
    }
}

main().catch(console.error);
