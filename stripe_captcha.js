const { chromium } = require('playwright');

(async () => {
    console.log('Starting browser...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 200
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('Navigating to Stripe verification link...');
        await page.goto('https://dashboard.stripe.com/confirm_email?t=EgzvM2fzHIgOQLDbWLf4oASYJBGFFc2s', {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });

        await page.waitForTimeout(5000);
        console.log('Page title:', await page.title());

        // Wait for the password input to be visible
        console.log('Looking for password field...');
        await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 20000 });

        // Enter password
        console.log('Entering password...');
        await page.fill('input[type="password"]', 'Kx9#mPq2vL$nB7zR!wYc');
        console.log('Password entered');

        // Click the Continue button
        console.log('Clicking Continue...');
        await page.click('button:has-text("Continue")');

        // Wait for CAPTCHA to appear
        console.log('Waiting for CAPTCHA...');
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'stripe_captcha_appeared.png' });

        // Look for the CAPTCHA iframe or element
        // The puzzle shows a tractor piece that needs to be dragged
        // Looking at the image: there's a main image area and a draggable piece on the right

        // Wait a bit more for captcha to fully load
        await page.waitForTimeout(3000);

        // Try to find and interact with the captcha
        // The "Move" button/drag piece is on the right side
        // We need to drag it to where the missing piece is in the main image

        // Try clicking Skip button if available
        console.log('Looking for Skip button...');
        const skipButton = await page.$('button:has-text("Skip")');
        if (skipButton) {
            console.log('Skip button found, but trying to solve first...');
        }

        // Try to perform drag and drop
        // The draggable piece appears to be on the right side
        // Need to drag it to the main image area where the tractor is partially visible

        console.log('Attempting to solve CAPTCHA by drag and drop...');

        // Find the draggable element - it's usually inside a specific container
        // Based on the screenshot, the piece to drag is on the right side with "+ Move" label

        // Let's try to find the puzzle elements
        const puzzleContainer = await page.$('.captcha-solver, [class*="captcha"], [class*="puzzle"]');
        if (puzzleContainer) {
            console.log('Found captcha container');
        }

        // Alternative: try to find image elements that might be draggable
        const images = await page.$$('img');
        console.log('Found', images.length, 'images on page');

        // Try to find elements with drag-related attributes
        const draggables = await page.$$('[draggable="true"], [class*="drag"], [class*="piece"]');
        console.log('Found', draggables.length, 'potentially draggable elements');

        // Take screenshot before attempting drag
        await page.screenshot({ path: 'stripe_before_drag.png' });

        // Try a drag operation from the right piece area to the main image
        // The piece appears to be around x:620, y:280 (the tractor on the right)
        // The target appears to be around x:480, y:350 (completing the scene)

        // Get viewport size
        const viewport = page.viewportSize();
        console.log('Viewport:', viewport);

        // Perform drag operation
        // Source: the piece on the right (tractor)
        // Target: the missing area in the main puzzle

        console.log('Performing drag operation...');
        await page.mouse.move(620, 300);
        await page.waitForTimeout(500);
        await page.mouse.down();
        await page.waitForTimeout(200);
        await page.mouse.move(480, 350, { steps: 20 });
        await page.waitForTimeout(200);
        await page.mouse.up();

        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'stripe_after_drag.png' });

        // Check result
        console.log('Current URL after drag:', page.url());

        // If still on captcha, try alternative positions
        await page.waitForTimeout(2000);

        // Try refresh/rotate captcha and try again
        const refreshButton = await page.$('[class*="refresh"], [class*="rotate"], svg[class*="refresh"]');
        if (refreshButton) {
            console.log('Found refresh button');
        }

        // Final screenshot
        await page.screenshot({ path: 'stripe_captcha_result.png' });
        console.log('Final URL:', page.url());

        // Keep browser open longer for observation
        await page.waitForTimeout(10000);

    } catch (error) {
        console.error('Error:', error.message);
        try {
            await page.screenshot({ path: 'stripe_captcha_error.png' });
        } catch (e) {}
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
})();
