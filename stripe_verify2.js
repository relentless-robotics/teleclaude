const { chromium } = require('playwright');

(async () => {
    console.log('Starting browser...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 300
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('Navigating to Stripe verification link...');
        await page.goto('https://dashboard.stripe.com/confirm_email?t=EgzvM2fzHIgOQLDbWLf4oASYJBGFFc2s', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        // Wait for page to fully load
        await page.waitForTimeout(3000);
        console.log('Page title:', await page.title());

        // Wait for the password input to be visible
        console.log('Looking for password field...');
        await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 15000 });

        // Enter password
        console.log('Entering password...');
        await page.fill('input[type="password"]', 'Kx9#mPq2vL$nB7zR!wYc');
        await page.screenshot({ path: 'stripe_password_entered.png' });
        console.log('Password entered successfully');

        // Click the Continue button
        console.log('Looking for Continue button...');
        await page.waitForSelector('button:has-text("Continue")', { state: 'visible', timeout: 10000 });
        console.log('Clicking Continue...');
        await page.click('button:has-text("Continue")');

        // Wait for response
        console.log('Waiting for verification to complete...');
        await page.waitForTimeout(8000);
        await page.screenshot({ path: 'stripe_after_continue.png' });

        // Check current URL and page state
        console.log('Current URL:', page.url());
        console.log('Page title:', await page.title());

        // Get page text to check for success/error messages
        const bodyText = await page.textContent('body');
        console.log('Page contains text (first 500 chars):', bodyText.substring(0, 500));

        if (bodyText.toLowerCase().includes('verified') || bodyText.toLowerCase().includes('confirmed') || bodyText.toLowerCase().includes('success') || page.url().includes('dashboard')) {
            console.log('SUCCESS: Email verification appears complete!');
        } else if (bodyText.toLowerCase().includes('error') || bodyText.toLowerCase().includes('incorrect') || bodyText.toLowerCase().includes('wrong')) {
            console.log('ERROR: There seems to be an issue with verification');
        }

        // Keep browser open briefly
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'stripe_final_state.png' });

    } catch (error) {
        console.error('Error:', error.message);
        await page.screenshot({ path: 'stripe_error.png' });
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
})();
