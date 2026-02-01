const { chromium } = require('playwright');

(async () => {
    console.log('Starting browser...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 500
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('Navigating to Stripe verification link...');
        await page.goto('https://dashboard.stripe.com/confirm_email?t=EgzvM2fzHIgOQLDbWLf4oASYJBGFFc2s', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        // Wait a moment for page to fully load
        await page.waitForTimeout(3000);

        // Take screenshot
        await page.screenshot({ path: 'stripe_step1.png' });
        console.log('Screenshot saved: stripe_step1.png');

        // Check page content
        const pageContent = await page.content();
        console.log('Page title:', await page.title());

        // Look for email input field
        const emailInput = await page.$('input[type="email"], input[name="email"], input[autocomplete="email"]');
        if (emailInput) {
            console.log('Found email input, entering email...');
            await emailInput.fill('relentlessrobotics@gmail.com');
            await page.screenshot({ path: 'stripe_step2_email.png' });
        }

        // Look for password input field
        const passwordInput = await page.$('input[type="password"], input[name="password"]');
        if (passwordInput) {
            console.log('Found password input, entering password...');
            await passwordInput.fill('Kx9#mPq2vL$nB7zR!wYc');
            await page.screenshot({ path: 'stripe_step3_password.png' });
        }

        // Look for submit/continue button
        const submitButton = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Log in")');
        if (submitButton) {
            console.log('Found submit button, clicking...');
            await submitButton.click();
            await page.waitForTimeout(5000);
            await page.screenshot({ path: 'stripe_step4_after_submit.png' });
        }

        // Wait for any redirects or verification completion
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'stripe_final.png' });

        console.log('Final URL:', page.url());
        console.log('Final page title:', await page.title());

        // Check for success indicators
        const bodyText = await page.textContent('body');
        if (bodyText.includes('verified') || bodyText.includes('confirmed') || bodyText.includes('success')) {
            console.log('SUCCESS: Email appears to be verified!');
        }

        // Keep browser open for 10 seconds to observe
        await page.waitForTimeout(10000);

    } catch (error) {
        console.error('Error:', error.message);
        await page.screenshot({ path: 'stripe_error.png' });
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
})();
