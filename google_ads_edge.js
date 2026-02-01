const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function setupWithEdge() {
    console.log('Google Ads setup with Microsoft Edge...');

    let context;
    let page;

    try {
        // Use Edge with persistent context
        console.log('Launching Edge with persistent profile...');
        context = await chromium.launchPersistentContext(
            path.join(__dirname, 'browser_profile_edge'),
            {
                channel: 'msedge',
                headless: false,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-extensions',
                    '--start-maximized'
                ],
                viewport: { width: 1920, height: 1080 }
            }
        );

        page = await context.newPage();

        // First sign in to Google if needed
        console.log('Checking Google sign-in status...');
        await page.goto('https://accounts.google.com', { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(3000);

        const signedIn = await page.url().includes('myaccount') || await page.locator('img[data-profile-identifier]').isVisible().catch(() => false);

        if (!signedIn) {
            console.log('Need to sign in to Google...');

            // Go to Google sign in
            await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle', timeout: 60000 });
            await sleep(2000);

            // Enter email
            try {
                const emailInput = await page.locator('input[type="email"]').first();
                if (await emailInput.isVisible()) {
                    await emailInput.fill('relentlessrobotics@gmail.com');
                    await sleep(500);
                    await page.click('#identifierNext');
                    await sleep(3000);
                }
            } catch (e) {
                console.log('Email input not found, might already be signed in');
            }

            // Enter password
            try {
                const passwordInput = await page.locator('input[type="password"]').first();
                if (await passwordInput.isVisible()) {
                    await passwordInput.fill('Relaxing41!');
                    await sleep(500);
                    await page.click('#passwordNext');
                    await sleep(5000);
                }
            } catch (e) {
                console.log('Password input not found');
            }

            console.log(`After sign in: ${page.url()}`);
            await page.screenshot({ path: 'edge_signin.png', fullPage: true });
        } else {
            console.log('Already signed in to Google');
        }

        // Navigate to Google Ads
        console.log('\nNavigating to Google Ads...');
        await page.goto('https://ads.google.com/nav/selectaccount', { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(5000);

        console.log(`Current URL: ${page.url()}`);
        await page.screenshot({ path: 'edge_step1.png', fullPage: true });

        // Click on the account to continue setup
        try {
            const accountRow = await page.locator('text=443-992-0694').first();
            if (await accountRow.isVisible()) {
                console.log('Found account 443-992-0694, clicking...');
                await accountRow.click();
                await sleep(5000);
            }
        } catch (e) {
            console.log('Account row not found');
        }

        console.log(`URL after account click: ${page.url()}`);
        await page.screenshot({ path: 'edge_step2.png', fullPage: true });

        // Now on setup page - fill the form
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log('Page content preview:', bodyText.substring(0, 1000));

        // Check if there's ad blocker warning
        if (bodyText.includes('ad blocker')) {
            console.log('Ad blocker warning present - Edge should not have this issue');
        }

        // Fill business name
        console.log('\nFilling form fields...');
        const inputs = await page.$$('input');
        console.log(`Found ${inputs.length} inputs`);

        if (inputs.length >= 1) {
            // First input - business name
            await inputs[0].click();
            await sleep(200);
            await inputs[0].fill('Relentless Robotics');
            console.log('Filled business name');
        }

        if (inputs.length >= 2) {
            // Second input - website URL
            await inputs[1].click();
            await sleep(200);
            await inputs[1].fill('https://www.example.com');
            console.log('Filled website URL');
        }

        await sleep(1000);
        await page.screenshot({ path: 'edge_step3.png', fullPage: true });

        // Click Next button - try multiple approaches
        console.log('\nClicking Next...');
        try {
            // First try standard button click
            const nextBtn = await page.locator('button:visible:has-text("Next")').first();
            if (await nextBtn.isVisible()) {
                await nextBtn.click({ force: true });
                console.log('Clicked Next button');
                await sleep(5000);
            }
        } catch (e) {
            console.log('Standard click failed, trying alternatives...');

            // Try pressing Enter
            await page.keyboard.press('Enter');
            await sleep(3000);
        }

        console.log(`URL after Next: ${page.url()}`);
        await page.screenshot({ path: 'edge_step4.png', fullPage: true });

        // Continue with setup steps
        let stepNum = 0;
        while (stepNum < 20) {
            stepNum++;
            console.log(`\n=== Setup Step ${stepNum} ===`);

            const currentUrl = page.url();
            const pageText = await page.evaluate(() => document.body.innerText);

            // Check if we're at dashboard
            if (currentUrl.includes('/aw/overview') || currentUrl.includes('/aw/campaigns') || currentUrl.includes('/home')) {
                console.log('SUCCESS: Reached Google Ads dashboard!');
                break;
            }

            // Print brief page state
            console.log('Page URL:', currentUrl);
            console.log('Page preview:', pageText.substring(0, 500));

            // Handle different steps
            // Keywords step
            if (pageText.includes('keyword') || pageText.includes('Keyword')) {
                console.log('At keywords step...');
                // Try to proceed without adding keywords
            }

            // Budget step
            if (pageText.includes('budget') || pageText.includes('Budget')) {
                console.log('At budget step...');
            }

            // Ad creation step
            if (pageText.includes('Write your ad') || pageText.includes('ad text')) {
                console.log('At ad creation step...');
            }

            // Billing step
            if (pageText.includes('billing') || pageText.includes('payment') || pageText.includes('Billing')) {
                console.log('At billing step...');
                // Look for skip options
                const skipSelectors = ['text=Skip', 'text=Set up later', 'text=Not now'];
                for (const sel of skipSelectors) {
                    try {
                        const skipBtn = await page.locator(sel).first();
                        if (await skipBtn.isVisible()) {
                            await skipBtn.click();
                            console.log(`Clicked: ${sel}`);
                            await sleep(3000);
                            continue;
                        }
                    } catch (e) {
                        // Continue
                    }
                }
            }

            // Try to click Next/Continue
            const nextSelectors = [
                'button:has-text("Next")',
                'button:has-text("Continue")',
                'button:has-text("Skip")',
                'button:has-text("Submit")',
                'button:has-text("Create")',
                'button:has-text("Save")'
            ];

            let clicked = false;
            for (const sel of nextSelectors) {
                try {
                    const btn = await page.locator(sel).first();
                    if (await btn.isVisible() && await btn.isEnabled()) {
                        await btn.click({ force: true });
                        console.log(`Clicked: ${sel}`);
                        clicked = true;
                        await sleep(5000);
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }

            if (!clicked) {
                console.log('No button found to click, waiting...');
                await sleep(3000);
            }

            await page.screenshot({ path: `edge_setup_${stepNum}.png`, fullPage: true });
        }

        // Final state
        console.log('\n=== FINAL STATE ===');
        console.log(`URL: ${page.url()}`);
        await page.screenshot({ path: 'edge_final.png', fullPage: true });

        const finalText = await page.evaluate(() => document.body.innerText);
        console.log('Final page preview:', finalText.substring(0, 2000));

        // Check for account ID in URL
        const accountMatch = page.url().match(/(\d{3}-\d{3}-\d{4})/);
        if (accountMatch) {
            console.log(`Account ID: ${accountMatch[1]}`);
        }

        console.log('\nKeeping browser open for 300 seconds...');
        await sleep(300000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        console.error(error);
        if (page) {
            await page.screenshot({ path: 'edge_error.png', fullPage: true });
        }
    } finally {
        if (context) {
            await context.close();
        }
    }
}

setupWithEdge().catch(console.error);
