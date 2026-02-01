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

        await page.waitForTimeout(4000);

        // Enter password if prompted
        const passwordField = await page.$('input[type="password"]');
        if (passwordField && await passwordField.isVisible()) {
            console.log('Entering password...');
            await page.fill('input[type="password"]', 'Kx9#mPq2vL$nB7zR!wYc');
            await page.click('button:has-text("Continue")');
            await page.waitForTimeout(5000);
        }

        await page.screenshot({ path: 'drag_solve_initial.png' });

        // Try to solve drag puzzles multiple times
        for (let attempt = 1; attempt <= 20; attempt++) {
            console.log(`\n=== Drag puzzle attempt ${attempt}/20 ===`);

            await page.screenshot({ path: `drag_attempt_${attempt}_before.png` });

            // Check if we've passed
            const url = page.url();
            if (!url.includes('confirm_email')) {
                console.log('SUCCESS! Moved past confirmation page.');
                break;
            }

            // Get the visible page content
            const hasPageContent = await page.isVisible('body');
            if (!hasPageContent) {
                await page.waitForTimeout(2000);
                continue;
            }

            // Check for captcha challenge
            const challengeVisible = await page.isVisible('text="Please drag"').catch(() => false) ||
                                    await page.isVisible('text="Tap on"').catch(() => false) ||
                                    await page.isVisible('text="Pick"').catch(() => false) ||
                                    await page.isVisible('text="Choose"').catch(() => false);

            if (!challengeVisible) {
                console.log('No challenge visible, waiting...');
                await page.waitForTimeout(3000);

                // Check for success indicators
                const bodyText = await page.textContent('body');
                if (bodyText.includes('Email verified') || bodyText.includes('verification complete')) {
                    console.log('SUCCESS: Verification complete!');
                    break;
                }
                continue;
            }

            // Determine captcha type by looking for specific elements
            const isDragPuzzle = await page.isVisible('text="Please drag the correct image"').catch(() => false);
            const isTapChallenge = await page.isVisible('text="Tap on"').catch(() => false);
            const isPickChallenge = await page.isVisible('text="Pick"').catch(() => false);
            const isChooseChallenge = await page.isVisible('text="Choose"').catch(() => false);

            if (isDragPuzzle) {
                console.log('Found drag puzzle');

                // The puzzle has:
                // - Main image area on the left (with missing piece slot)
                // - Draggable pieces on the right side

                // Positions based on centered 1280x720 viewport:
                // The puzzle dialog is roughly centered
                // Draggable piece starts around x=615-625, y=220-280
                // Target area varies but is in the left portion of the image

                // Try different target X positions
                const sourceX = 620;
                const sourceY = 260;
                const targetYs = [250, 280, 310, 340];
                const targetXs = [350, 380, 410, 440, 470];

                const targetX = targetXs[attempt % targetXs.length];
                const targetY = targetYs[Math.floor((attempt / targetXs.length)) % targetYs.length];

                console.log(`Dragging from (${sourceX}, ${sourceY}) to (${targetX}, ${targetY})`);

                // Perform the drag with human-like movement
                await page.mouse.move(sourceX, sourceY);
                await page.waitForTimeout(200);
                await page.mouse.down();
                await page.waitForTimeout(150);

                // Move in steps with slight randomness
                const steps = 25;
                for (let i = 1; i <= steps; i++) {
                    const progress = i / steps;
                    const x = sourceX + (targetX - sourceX) * progress + (Math.random() - 0.5) * 2;
                    const y = sourceY + (targetY - sourceY) * progress + (Math.random() - 0.5) * 2;
                    await page.mouse.move(x, y);
                    await page.waitForTimeout(15 + Math.random() * 10);
                }

                await page.mouse.up();
                console.log('Drag completed');

            } else if (isTapChallenge || isPickChallenge || isChooseChallenge) {
                console.log('Found selection challenge');

                // Click on grid positions
                const gridPositions = [
                    { x: 405, y: 205 }, { x: 485, y: 205 }, { x: 565, y: 205 },
                    { x: 405, y: 285 }, { x: 485, y: 285 }, { x: 565, y: 285 },
                    { x: 405, y: 365 }, { x: 485, y: 365 }, { x: 565, y: 365 }
                ];

                // Try clicking different positions each attempt
                const posToClick = gridPositions[(attempt * 2) % gridPositions.length];
                await page.mouse.click(posToClick.x, posToClick.y);
                console.log(`Clicked position (${posToClick.x}, ${posToClick.y})`);
            }

            await page.waitForTimeout(3000);
            await page.screenshot({ path: `drag_attempt_${attempt}_after.png` });
        }

        // Final check
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'drag_solve_final.png' });
        console.log('\n=== FINAL STATUS ===');
        console.log('URL:', page.url());

        const finalBody = await page.textContent('body');
        if (finalBody.toLowerCase().includes('verified') ||
            finalBody.toLowerCase().includes('confirmed') ||
            !page.url().includes('confirm_email')) {
            console.log('EMAIL VERIFICATION SUCCESSFUL!');
        } else {
            console.log('Verification may require manual completion');
        }

        await page.waitForTimeout(10000);

    } catch (error) {
        console.error('Error:', error.message);
        await page.screenshot({ path: 'drag_solve_error.png' }).catch(() => {});
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
})();
