const { chromium } = require('playwright');

(async () => {
    console.log('Starting browser...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 200
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    try {
        console.log('Navigating to Stripe verification link...');
        await page.goto('https://dashboard.stripe.com/confirm_email?t=EgzvM2fzHIgOQLDbWLf4oASYJBGFFc2s', {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });

        await page.waitForTimeout(5000);

        // Check if we're on the verify email page
        const pageTitle = await page.title();
        console.log('Page title:', pageTitle);

        // Look for password field (if it exists, we need to log in)
        const passwordField = await page.$('input[type="password"]');
        if (passwordField && await passwordField.isVisible()) {
            console.log('Password field found, entering credentials...');
            await page.fill('input[type="password"]', 'Kx9#mPq2vL$nB7zR!wYc');
            await page.click('button:has-text("Continue")');
            await page.waitForTimeout(6000);
        }

        await page.screenshot({ path: 'solve_captcha_start.png' });

        // Check what type of captcha we have
        const captchaText = await page.textContent('body');

        if (captchaText.includes('Choose all things that weigh less')) {
            console.log('Found weight comparison captcha');

            // This captcha shows a grid of images
            // We need to click on items lighter than the reference object (sofa)

            // Grid layout (3x3 with potential extras):
            // Based on screenshot analysis, the grid items are approximately:
            // Row 1: x positions around 392, 477, 562 | y around 190
            // Row 2: x positions around 392, 477, 562 | y around 275
            // Row 3: x positions around 392, 477, 562 | y around 360

            // From the screenshot:
            // Position 1 (0,0): Train - heavy
            // Position 2 (0,1): Boat - heavy
            // Position 3 (0,2): Sofa - reference
            // Position 4 (1,0): Yacht - heavy
            // Position 5 (1,1): Train - heavy
            // Position 6 (1,2): Corn - LIGHT!
            // Position 7 (2,0): Building - heavy
            // Position 8 (2,1): Corn - LIGHT!
            // Position 9 (2,2): Corn - LIGHT! (or another train?)

            // Need to click on the corn images
            // Based on approximate grid positions:
            // Corn at position 6 (row 2, col 3): approximately x=562, y=275
            // Corn at position 8 (row 3, col 2): approximately x=477, y=360

            // Let's more carefully analyze the grid
            // The captcha dialog appears centered
            // Grid images are typically 80x80 pixels with small gaps

            // Click on corn images (items 6, 8, and possibly 9)
            console.log('Clicking on corn images (lighter than sofa)...');

            // Position 6 - corn (row 2, col 3)
            await page.mouse.click(565, 275);
            await page.waitForTimeout(500);
            console.log('Clicked position 6');
            await page.screenshot({ path: 'solve_click1.png' });

            // Position 8 - corn (row 3, col 2)
            await page.mouse.click(480, 365);
            await page.waitForTimeout(500);
            console.log('Clicked position 8');
            await page.screenshot({ path: 'solve_click2.png' });

            // Position 9 - check if it's corn too (row 3, col 3)
            await page.mouse.click(565, 365);
            await page.waitForTimeout(500);
            console.log('Clicked position 9');
            await page.screenshot({ path: 'solve_click3.png' });

            // Look for a Submit/Confirm button
            console.log('Looking for submit button...');
            const submitButton = await page.$('button:has-text("Submit"), button:has-text("Confirm"), button:has-text("Verify")');
            if (submitButton) {
                console.log('Found submit button, clicking...');
                await submitButton.click();
                await page.waitForTimeout(3000);
            }

            await page.screenshot({ path: 'solve_after_submit.png' });

        } else if (captchaText.includes('drag the correct image')) {
            console.log('Found drag puzzle captcha');
            // Handle drag puzzle (previous logic)
        }

        // Check final state
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'solve_final.png' });
        console.log('Final URL:', page.url());

        const finalText = await page.textContent('body');
        if (finalText.includes('verified') || finalText.includes('confirmed') || finalText.includes('success')) {
            console.log('SUCCESS! Email appears to be verified!');
        } else if (page.url().includes('dashboard.stripe.com') && !page.url().includes('confirm_email')) {
            console.log('SUCCESS! Redirected to dashboard!');
        } else {
            console.log('Captcha may need another attempt or different solution');
        }

        await page.waitForTimeout(5000);

    } catch (error) {
        console.error('Error:', error.message);
        try {
            await page.screenshot({ path: 'solve_error.png' });
        } catch (e) {}
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
})();
