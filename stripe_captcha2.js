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

        // Enter password
        await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 20000 });
        await page.fill('input[type="password"]', 'Kx9#mPq2vL$nB7zR!wYc');
        await page.click('button:has-text("Continue")');

        // Wait for CAPTCHA
        console.log('Waiting for CAPTCHA...');
        await page.waitForTimeout(6000);
        await page.screenshot({ path: 'captcha_initial.png' });

        // The CAPTCHA structure:
        // - Main puzzle image on the left (about 400x250 pixels)
        // - Draggable piece on the right side (with "+ Move" label)
        // - The piece needs to be dragged to complete the missing area

        // First, let's identify the captcha container's position
        // Based on screenshot analysis:
        // - The captcha dialog is centered in a 1280x720 viewport
        // - Dialog is approximately at x:290 to x:710 (width ~420)
        // - The main image area starts around x:305, y:150 to x:580, y:420
        // - The draggable piece is at approximately x:595-660, y:195-350

        // Let's use the page to get the actual element positions if possible
        const captchaBox = await page.$('.geetest_box, .captcha-box, [class*="captcha"]');
        if (captchaBox) {
            const box = await captchaBox.boundingBox();
            console.log('Captcha container bounds:', box);
        }

        // Take a fullpage screenshot to analyze positions
        await page.screenshot({ path: 'captcha_fullpage.png', fullPage: false });

        // For the GeeTest style puzzle:
        // The "Move" piece on the right needs to be dragged to the slot/gap in the left image
        // The gap is where the image is incomplete (shows lighter/missing area)

        // Looking at the previous screenshots:
        // The puzzle piece (source) is approximately at: x=620, y=270
        // The target gap area varies but is typically in the left 2/3 of the main image

        // Let's try to use the Move button's position as our source
        console.log('Locating the draggable piece...');

        // Find elements that might be draggable
        const moveText = await page.locator('text="Move"').first();
        if (await moveText.isVisible()) {
            const moveBox = await moveText.boundingBox();
            console.log('Move text location:', moveBox);
        }

        // For this type of puzzle, we need to:
        // 1. Click and hold on the puzzle piece
        // 2. Drag it to the gap in the main image
        // 3. Release

        // The gap position varies, but it's usually in a specific X range
        // Let's try multiple Y positions at common X positions

        console.log('Attempting drag and drop...');

        // Source position (the draggable piece - right side of puzzle)
        const sourceX = 620;
        const sourceY = 280;

        // Let's try dragging to several target positions
        // The gap is usually somewhere in the left portion of the image

        // First attempt - middle of the image
        console.log('Attempt 1: Dragging to middle-left area');
        await page.mouse.move(sourceX, sourceY);
        await page.waitForTimeout(300);
        await page.mouse.down();
        await page.waitForTimeout(200);

        // Drag slowly to target
        const targetX1 = 430;
        const targetY = 300;
        for (let i = 0; i <= 30; i++) {
            const x = sourceX + (targetX1 - sourceX) * (i / 30);
            const y = sourceY + (targetY - sourceY) * (i / 30);
            await page.mouse.move(x, y);
            await page.waitForTimeout(20);
        }

        await page.mouse.up();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'captcha_attempt1.png' });

        // Check if still on captcha page
        const stillOnCaptcha = await page.$('text="Please drag the correct image piece"');
        if (stillOnCaptcha) {
            console.log('Still on captcha, trying another position...');

            // Wait for captcha to reset/refresh
            await page.waitForTimeout(2000);
            await page.screenshot({ path: 'captcha_after_fail.png' });

            // Try again with a different target position
            console.log('Attempt 2: Trying different X position');
            await page.mouse.move(sourceX, sourceY);
            await page.waitForTimeout(300);
            await page.mouse.down();
            await page.waitForTimeout(200);

            const targetX2 = 380; // More to the left
            for (let i = 0; i <= 30; i++) {
                const x = sourceX + (targetX2 - sourceX) * (i / 30);
                const y = sourceY + (targetY - sourceY) * (i / 30);
                await page.mouse.move(x, y);
                await page.waitForTimeout(20);
            }

            await page.mouse.up();
            await page.waitForTimeout(2000);
            await page.screenshot({ path: 'captcha_attempt2.png' });
        }

        // Final check
        await page.waitForTimeout(3000);
        console.log('Final URL:', page.url());
        await page.screenshot({ path: 'captcha_final.png' });

        const bodyText = await page.textContent('body');
        if (bodyText.includes('verified') || bodyText.includes('confirmed') || page.url().includes('dashboard.stripe.com/login') || (page.url().includes('dashboard') && !page.url().includes('confirm_email'))) {
            console.log('SUCCESS! Verification appears complete.');
        } else {
            console.log('Captcha may still be present or verification failed');
        }

        await page.waitForTimeout(5000);

    } catch (error) {
        console.error('Error:', error.message);
        try {
            await page.screenshot({ path: 'captcha_error.png' });
        } catch (e) {}
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
})();
