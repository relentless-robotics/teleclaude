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
        // Use domcontentloaded instead of networkidle for faster initial load
        await page.goto('https://dashboard.stripe.com/confirm_email?t=EgzvM2fzHIgOQLDbWLf4oASYJBGFFc2s', {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });

        // Wait for page to settle
        console.log('Page loaded, waiting for content...');
        await page.waitForTimeout(5000);
        console.log('Page title:', await page.title());
        await page.screenshot({ path: 'stripe_loaded.png' });

        // Wait for the password input to be visible
        console.log('Looking for password field...');
        try {
            await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 20000 });
            console.log('Password field found!');
        } catch (e) {
            console.log('Could not find password field, checking page state...');
            await page.screenshot({ path: 'stripe_no_password_field.png' });
            const content = await page.content();
            console.log('Page HTML snippet:', content.substring(0, 1000));
        }

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
        await page.waitForTimeout(10000);
        await page.screenshot({ path: 'stripe_after_continue.png' });

        // Check current URL and page state
        console.log('Current URL:', page.url());
        console.log('Page title:', await page.title());

        // Get page text to check for success/error messages
        const bodyText = await page.textContent('body');
        console.log('Page body text (first 800 chars):', bodyText.substring(0, 800));

        if (bodyText.toLowerCase().includes('verified') || bodyText.toLowerCase().includes('confirmed') || bodyText.toLowerCase().includes('success') || page.url().includes('dashboard.stripe.com') && !page.url().includes('confirm_email')) {
            console.log('SUCCESS: Email verification appears complete!');
        } else if (bodyText.toLowerCase().includes('error') || bodyText.toLowerCase().includes('incorrect') || bodyText.toLowerCase().includes('wrong')) {
            console.log('ERROR: There seems to be an issue with verification');
        }

        // Final screenshot
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'stripe_final_state.png' });

    } catch (error) {
        console.error('Error:', error.message);
        try {
            await page.screenshot({ path: 'stripe_error.png' });
        } catch (e) {}
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
})();
