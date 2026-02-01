const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        headless: false,
        slowMo: 500
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('STEP: Opening GitHub signup page...');

    try {
        await page.goto('https://github.com/signup', { waitUntil: 'networkidle', timeout: 60000 });

        // Wait for the page to load
        await page.waitForTimeout(2000);

        // Check if we're on the signup page
        const pageContent = await page.content();

        if (pageContent.includes('Welcome to GitHub') || pageContent.includes('Enter your email')) {
            console.log('STEP: On signup page, entering email...');

            // GitHub's signup is a multi-step form
            // Step 1: Email
            const emailInput = await page.locator('input[type="email"], input[name="email"], #email');
            if (await emailInput.count() > 0) {
                await emailInput.first().fill('relentlessrobotics@gmail.com');
                console.log('STEP: Email entered, looking for continue button...');
                await page.waitForTimeout(1000);

                // Look for continue button
                const continueBtn = await page.locator('button:has-text("Continue"), button[type="submit"]');
                if (await continueBtn.count() > 0) {
                    await continueBtn.first().click();
                    console.log('STEP: Clicked continue after email');
                    await page.waitForTimeout(2000);
                }
            }

            // Step 2: Password
            const passwordInput = await page.locator('input[type="password"], input[name="password"], #password');
            if (await passwordInput.count() > 0) {
                await passwordInput.first().fill('Relaxing41!');
                console.log('STEP: Password entered');
                await page.waitForTimeout(1000);

                const continueBtn = await page.locator('button:has-text("Continue"), button[type="submit"]');
                if (await continueBtn.count() > 0) {
                    await continueBtn.first().click();
                    console.log('STEP: Clicked continue after password');
                    await page.waitForTimeout(2000);
                }
            }

            // Step 3: Username
            const usernameInput = await page.locator('input[name="login"], input[name="username"], #login');
            if (await usernameInput.count() > 0) {
                await usernameInput.first().fill('relentlessrobotics');
                console.log('STEP: Username entered');
                await page.waitForTimeout(1000);

                const continueBtn = await page.locator('button:has-text("Continue"), button[type="submit"]');
                if (await continueBtn.count() > 0) {
                    await continueBtn.first().click();
                    console.log('STEP: Clicked continue after username');
                    await page.waitForTimeout(2000);
                }
            }

            // Check for CAPTCHA or verification
            const captchaPresent = await page.locator('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]').count() > 0;
            if (captchaPresent) {
                console.log('STATUS: CAPTCHA detected - manual intervention may be required');
            }

            // Take a screenshot to see current state
            await page.screenshot({ path: 'github_signup_state.png', fullPage: true });
            console.log('STEP: Screenshot saved to github_signup_state.png');

            // Wait to see what happens
            await page.waitForTimeout(5000);

            // Check current URL
            const currentUrl = page.url();
            console.log('CURRENT_URL: ' + currentUrl);

            // Get any error messages
            const errorText = await page.locator('.flash-error, [class*="error"], [role="alert"]').allTextContents();
            if (errorText.length > 0) {
                console.log('ERRORS: ' + errorText.join('; '));
            }

        } else if (pageContent.includes('Sign in') || pageContent.includes('already have an account')) {
            console.log('STATUS: May need to sign in - account might already exist');

            // Try logging in instead
            await page.goto('https://github.com/login', { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);

            const loginField = await page.locator('input[name="login"], #login_field');
            if (await loginField.count() > 0) {
                await loginField.first().fill('relentlessrobotics@gmail.com');
            }

            const passField = await page.locator('input[name="password"], #password');
            if (await passField.count() > 0) {
                await passField.first().fill('Relaxing41!');
            }

            const signInBtn = await page.locator('input[type="submit"], button[type="submit"]');
            if (await signInBtn.count() > 0) {
                await signInBtn.first().click();
            }

            await page.waitForTimeout(5000);
            console.log('LOGIN_URL: ' + page.url());

            await page.screenshot({ path: 'github_login_state.png', fullPage: true });
        }

        // Keep browser open for 30 seconds to allow manual intervention if needed
        console.log('STATUS: Browser staying open for 30 seconds for any manual steps needed...');
        await page.waitForTimeout(30000);

    } catch (error) {
        console.log('ERROR: ' + error.message);
        await page.screenshot({ path: 'github_error_state.png', fullPage: true });
    }

    await browser.close();
    console.log('DONE: Browser closed');
})();
