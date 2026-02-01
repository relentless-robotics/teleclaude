const { chromium } = require('playwright');

(async () => {
    // Launch Playwright's bundled Chromium browser
    const browser = await chromium.launch({
        headless: false,
        slowMo: 100
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    try {
        console.log('Navigating to Anthropic console...');
        await page.goto('https://console.anthropic.com/', { waitUntil: 'networkidle', timeout: 60000 });

        // Wait for page to fully load
        await page.waitForTimeout(3000);

        // Check current URL to see if we're logged in
        const currentUrl = page.url();
        console.log('Current URL: ' + currentUrl);

        // Get page content for debugging
        const bodyText = await page.textContent('body');

        // Check if we need to log in
        if (currentUrl.includes('login') || bodyText.includes('Sign in') || bodyText.includes('Log in') || bodyText.includes('Continue with Google')) {
            console.log('LOGIN REQUIRED - Attempting to log in with email...');

            // Look for email login option first
            const emailButton = await page.$('button:has-text("Continue with email"), a:has-text("Continue with email")');
            if (emailButton) {
                console.log('Clicking Continue with email...');
                await emailButton.click();
                await page.waitForTimeout(2000);
            }

            // Enter email
            const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
            if (emailInput) {
                console.log('Entering email address...');
                await emailInput.fill('relentlessrobotics@gmail.com');
                await page.waitForTimeout(500);

                // Look for Continue/Submit button
                const continueBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")');
                if (continueBtn) {
                    console.log('Clicking continue button...');
                    await continueBtn.click();
                    await page.waitForTimeout(3000);
                }
            }

            // Check if we need password
            const passwordInput = await page.$('input[type="password"], input[name="password"]');
            if (passwordInput) {
                console.log('Entering password...');
                await passwordInput.fill('Relaxing41!');
                await page.waitForTimeout(500);

                // Look for Sign in button
                const signInBtn = await page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Continue"), button:has-text("Log in")');
                if (signInBtn) {
                    console.log('Clicking sign in button...');
                    await signInBtn.click();
                    await page.waitForTimeout(5000);
                }
            }

            await page.screenshot({ path: 'anthropic_after_login.png', fullPage: true });
            console.log('Screenshot after login attempt saved');

            // Check current state
            const newUrl = page.url();
            console.log('URL after login attempt: ' + newUrl);
            const newBodyText = await page.textContent('body');
            console.log('Page content after login: ' + newBodyText.substring(0, 1500));

            // Check if login was successful
            if (newUrl.includes('login') || newBodyText.includes('Sign in') || newBodyText.includes('error') || newBodyText.includes('Invalid')) {
                console.log('\nLOGIN FAILED - May need 2FA or different credentials');
            } else {
                console.log('\nLOGIN APPEARS SUCCESSFUL - Proceeding to get usage data...');
            }
        }

        // Wait a moment then try to get usage data
        await page.waitForTimeout(2000);

        // Navigate directly to usage page
        console.log('\nNavigating directly to usage page...');
        await page.goto('https://console.anthropic.com/settings/usage', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        console.log('Current URL: ' + page.url());
        await page.screenshot({ path: 'anthropic_usage.png', fullPage: true });

        // Get usage page content
        const usageText = await page.textContent('body');
        console.log('\n=== USAGE PAGE CONTENT ===\n');
        console.log(usageText.substring(0, 5000));

        // Navigate to billing/limits
        console.log('\nNavigating to limits page...');
        await page.goto('https://console.anthropic.com/settings/limits', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        await page.screenshot({ path: 'anthropic_limits.png', fullPage: true });
        const limitsText = await page.textContent('body');
        console.log('\n=== LIMITS PAGE CONTENT ===\n');
        console.log(limitsText.substring(0, 5000));

        // Navigate to billing page
        console.log('\nNavigating to billing page...');
        await page.goto('https://console.anthropic.com/settings/billing', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        await page.screenshot({ path: 'anthropic_billing.png', fullPage: true });
        const billingText = await page.textContent('body');
        console.log('\n=== BILLING PAGE CONTENT ===\n');
        console.log(billingText.substring(0, 5000));

        // Navigate to plans page
        console.log('\nNavigating to plans page...');
        await page.goto('https://console.anthropic.com/settings/plans', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        await page.screenshot({ path: 'anthropic_plans.png', fullPage: true });
        const plansText = await page.textContent('body');
        console.log('\n=== PLANS PAGE CONTENT ===\n');
        console.log(plansText.substring(0, 5000));

    } catch (error) {
        console.log('Error: ' + error.message);
        await page.screenshot({ path: 'anthropic_error.png', fullPage: true });
    } finally {
        await browser.close();
    }
})();
