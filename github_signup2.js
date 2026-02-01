const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        headless: false,
        slowMo: 800
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('STEP: Opening GitHub signup page directly...');

    try {
        await page.goto('https://github.com/signup', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        console.log('STEP: Page loaded, looking for email input...');

        // GitHub signup has step-by-step form
        // Step 1: Enter email
        try {
            await page.waitForSelector('#email', { timeout: 10000 });
            await page.fill('#email', 'relentlessrobotics@gmail.com');
            console.log('STEP: Email entered');
            await page.waitForTimeout(1500);

            // Click continue
            const emailContinue = await page.locator('button[data-continue-to="password-container"]');
            if (await emailContinue.count() > 0) {
                await emailContinue.click();
                console.log('STEP: Clicked continue after email');
            } else {
                // Try pressing Enter
                await page.press('#email', 'Enter');
                console.log('STEP: Pressed Enter after email');
            }
            await page.waitForTimeout(2000);
        } catch (e) {
            console.log('EMAIL_ERROR: ' + e.message);
        }

        // Step 2: Enter password
        try {
            await page.waitForSelector('#password', { timeout: 10000 });
            await page.fill('#password', 'Relaxing41!');
            console.log('STEP: Password entered');
            await page.waitForTimeout(1500);

            const passContinue = await page.locator('button[data-continue-to="username-container"]');
            if (await passContinue.count() > 0) {
                await passContinue.click();
                console.log('STEP: Clicked continue after password');
            } else {
                await page.press('#password', 'Enter');
                console.log('STEP: Pressed Enter after password');
            }
            await page.waitForTimeout(2000);
        } catch (e) {
            console.log('PASSWORD_ERROR: ' + e.message);
        }

        // Step 3: Enter username
        try {
            await page.waitForSelector('#login', { timeout: 10000 });
            await page.fill('#login', 'relentlessrobotics');
            console.log('STEP: Username entered');
            await page.waitForTimeout(2000);

            // Check for username availability message
            const usernameError = await page.locator('#login-err').textContent().catch(() => '');
            if (usernameError && usernameError.includes('unavailable')) {
                console.log('USERNAME_TAKEN: relentlessrobotics - trying variation');
                await page.fill('#login', 'relentless-robotics');
                await page.waitForTimeout(2000);
            }

            const userContinue = await page.locator('button[data-continue-to="opt-in-container"]');
            if (await userContinue.count() > 0) {
                await userContinue.click();
                console.log('STEP: Clicked continue after username');
            } else {
                await page.press('#login', 'Enter');
                console.log('STEP: Pressed Enter after username');
            }
            await page.waitForTimeout(2000);
        } catch (e) {
            console.log('USERNAME_ERROR: ' + e.message);
        }

        // Step 4: Email preferences (opt-in)
        try {
            const optInContainer = await page.locator('#opt-in-container');
            if (await optInContainer.isVisible().catch(() => false)) {
                // Usually there's a checkbox and continue button
                const optInContinue = await page.locator('button[data-continue-to="captcha-and-submit-container"]');
                if (await optInContinue.count() > 0) {
                    await optInContinue.click();
                    console.log('STEP: Clicked continue after opt-in');
                }
            }
            await page.waitForTimeout(2000);
        } catch (e) {
            console.log('OPT_IN_ERROR: ' + e.message);
        }

        // Step 5: CAPTCHA / Verification
        console.log('STEP: Checking for CAPTCHA...');
        await page.waitForTimeout(3000);

        // Take screenshot to see current state
        await page.screenshot({ path: 'github_signup_current.png', fullPage: true });
        console.log('SCREENSHOT: Saved current state');

        // Check for CAPTCHA
        const captchaFrame = await page.locator('iframe[title*="puzzle"], iframe[src*="octocaptcha"], iframe[src*="captcha"]');
        if (await captchaFrame.count() > 0) {
            console.log('CAPTCHA_DETECTED: Manual solving may be required');
        }

        // Look for create account button
        const createBtn = await page.locator('button:has-text("Create account"), button[type="submit"]:has-text("Create")');
        if (await createBtn.count() > 0 && await createBtn.isEnabled()) {
            await createBtn.click();
            console.log('STEP: Clicked Create account');
            await page.waitForTimeout(5000);
        }

        // Check current URL and state
        const currentUrl = page.url();
        console.log('CURRENT_URL: ' + currentUrl);

        // Get any visible error messages
        const errors = await page.locator('.flash-error, .error, [role="alert"]').allTextContents();
        if (errors.length > 0) {
            console.log('ERRORS: ' + errors.join('; '));
        }

        // Check if we need email verification
        const pageText = await page.textContent('body');
        if (pageText.includes('verify') || pageText.includes('verification') || pageText.includes('check your email')) {
            console.log('EMAIL_VERIFICATION_REQUIRED: Check email for verification link');
        }

        // Final screenshot
        await page.screenshot({ path: 'github_signup_final.png', fullPage: true });
        console.log('SCREENSHOT: Saved final state');

        // Keep browser open longer to observe
        console.log('STATUS: Keeping browser open for 60 seconds...');
        await page.waitForTimeout(60000);

    } catch (error) {
        console.log('CRITICAL_ERROR: ' + error.message);
        await page.screenshot({ path: 'github_error.png', fullPage: true });
    }

    await browser.close();
    console.log('DONE: Browser closed');
})();
