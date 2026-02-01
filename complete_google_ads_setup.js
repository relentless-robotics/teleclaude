const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function completeGoogleAdsSetup() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('Completing Google Ads setup for account 443-992-0694...');

    let browser;
    let context;
    let page;

    try {
        // Load saved Google auth state
        console.log('Loading saved Google authentication...');
        browser = await chromium.launch({
            headless: false,
            args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
        });
        context = await browser.newContext({
            storageState: stateFile,
            viewport: { width: 1920, height: 1080 }
        });
        page = await context.newPage();

        // Navigate to Google Ads account selector
        console.log('Navigating to Google Ads account selector...');
        await page.goto('https://ads.google.com/nav/selectaccount', { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(3000);

        console.log(`Current URL: ${page.url()}`);
        await page.screenshot({ path: 'complete_step1.png', fullPage: true });

        // Click on the account in setup (443-992-0694)
        console.log('Looking for account 443-992-0694...');

        try {
            // Try clicking on the account row
            const accountOption = await page.locator('text=443-992-0694').first();
            if (await accountOption.isVisible()) {
                console.log('Found account, clicking...');
                await accountOption.click();
                await sleep(5000);
            }
        } catch (e) {
            console.log('Direct account click failed, trying alternative...');
        }

        // Also try clicking "Setup in progress" or the entire row
        try {
            const setupRow = await page.locator('text=Setup in progress').first();
            if (await setupRow.isVisible()) {
                console.log('Found "Setup in progress", clicking parent...');
                await setupRow.click();
                await sleep(5000);
            }
        } catch (e) {
            console.log('Setup row click failed');
        }

        // Try clicking the "Finish setting up" option if visible
        try {
            const finishSetup = await page.locator('text=Finish setting up').first();
            if (await finishSetup.isVisible()) {
                console.log('Found "Finish setting up", clicking...');
                await finishSetup.click();
                await sleep(5000);
            }
        } catch (e) {
            console.log('No finish setup option');
        }

        console.log(`URL after account selection: ${page.url()}`);
        await page.screenshot({ path: 'complete_step2.png', fullPage: true });

        // Now we should be in the setup wizard
        // Get page content to understand current state
        let bodyText = await page.evaluate(() => document.body.innerText);
        console.log('\n--- Page content ---');
        console.log(bodyText.substring(0, 3000));
        console.log('--- End content ---\n');

        // Handle setup wizard steps
        let stepCount = 0;
        const maxSteps = 10;

        while (stepCount < maxSteps) {
            stepCount++;
            console.log(`\n=== Processing step ${stepCount} ===`);

            const currentUrl = page.url();
            bodyText = await page.evaluate(() => document.body.innerText);

            // Check if setup is complete (at dashboard)
            if (currentUrl.includes('home') || currentUrl.includes('overview') || currentUrl.includes('campaigns')) {
                console.log('SUCCESS: Reached Google Ads dashboard!');
                break;
            }

            // Step: Campaign Goal selection
            if (bodyText.toLowerCase().includes('goal') || bodyText.toLowerCase().includes('objective')) {
                console.log('At campaign goal step...');

                // Look for "Get more website traffic" or similar simple goals
                const goalOptions = [
                    'text=website traffic',
                    'text=Get more website',
                    'text=sales',
                    'text=Sales',
                    'text=leads',
                    'text=awareness'
                ];

                for (const goal of goalOptions) {
                    try {
                        const goalBtn = await page.locator(goal).first();
                        if (await goalBtn.isVisible()) {
                            console.log(`Selecting goal: ${goal}`);
                            await goalBtn.click();
                            await sleep(2000);
                            break;
                        }
                    } catch (e) {
                        // Continue
                    }
                }
            }

            // Step: Business name
            if (bodyText.toLowerCase().includes('business name') || bodyText.toLowerCase().includes('company name')) {
                console.log('At business name step...');
                try {
                    const nameInput = await page.locator('input[type="text"]').first();
                    if (await nameInput.isVisible()) {
                        await nameInput.fill('Relentless Robotics');
                        console.log('Filled business name: Relentless Robotics');
                        await sleep(1000);
                    }
                } catch (e) {
                    console.log('Could not fill business name');
                }
            }

            // Step: Website URL
            if (bodyText.toLowerCase().includes('website') && (bodyText.toLowerCase().includes('url') || bodyText.toLowerCase().includes('enter'))) {
                console.log('At website step...');
                try {
                    const urlInput = await page.locator('input[type="text"], input[type="url"]').first();
                    if (await urlInput.isVisible()) {
                        const currentValue = await urlInput.inputValue();
                        if (!currentValue) {
                            await urlInput.fill('https://relentlessrobotics.com');
                            console.log('Filled website URL');
                            await sleep(1000);
                        }
                    }
                } catch (e) {
                    console.log('Could not fill website URL');
                }
            }

            // Step: Billing - try to skip
            if (bodyText.toLowerCase().includes('billing') || bodyText.toLowerCase().includes('payment')) {
                console.log('At billing step...');
                // Look for skip option
                try {
                    const skipOptions = [
                        'text=Skip',
                        'text=Set up later',
                        'text=I\'ll do this later',
                        'text=Not now',
                        'button:has-text("Skip")'
                    ];
                    for (const skip of skipOptions) {
                        const skipBtn = await page.locator(skip).first();
                        if (await skipBtn.isVisible()) {
                            console.log(`Clicking: ${skip}`);
                            await skipBtn.click();
                            await sleep(2000);
                            break;
                        }
                    }
                } catch (e) {
                    console.log('No skip option found for billing');
                }
            }

            // Look for Next/Continue/Submit buttons
            const nextSelectors = [
                'button:has-text("Next")',
                'button:has-text("Continue")',
                'button:has-text("Submit")',
                'button:has-text("Save")',
                'button:has-text("Create")',
                'text=Next',
                'text=Continue'
            ];

            let clickedNext = false;
            for (const selector of nextSelectors) {
                try {
                    const nextBtn = await page.locator(selector).first();
                    if (await nextBtn.isVisible() && await nextBtn.isEnabled()) {
                        console.log(`Clicking: ${selector}`);
                        await nextBtn.click();
                        await sleep(3000);
                        clickedNext = true;
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }

            // Take screenshot of current step
            await page.screenshot({ path: `complete_step_${stepCount + 2}.png`, fullPage: true });

            if (!clickedNext) {
                console.log('No next button found, waiting...');
                await sleep(3000);
            }

            // Check for errors or warnings
            try {
                const errorMsg = await page.locator('.error, [role="alert"], .warning').first();
                if (await errorMsg.isVisible()) {
                    const errorText = await errorMsg.textContent();
                    console.log(`Warning/Error on page: ${errorText}`);
                }
            } catch (e) {
                // No errors
            }
        }

        // Final screenshot and state
        await page.screenshot({ path: 'complete_final.png', fullPage: true });
        console.log(`\n=== FINAL STATE ===`);
        console.log(`URL: ${page.url()}`);

        // Try to extract account ID from URL
        const finalUrl = page.url();
        const accountIdMatch = finalUrl.match(/(\d{3}-\d{3}-\d{4})/);
        if (accountIdMatch) {
            console.log(`Account ID: ${accountIdMatch[1]}`);
        }

        // Get final page content
        const finalText = await page.evaluate(() => document.body.innerText);
        console.log('\n--- Final page content ---');
        console.log(finalText.substring(0, 2000));
        console.log('--- End ---');

        // Keep browser open for manual inspection
        console.log('\nKeeping browser open for 180 seconds...');
        await sleep(180000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        if (page) {
            await page.screenshot({ path: 'complete_error.png', fullPage: true });
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

completeGoogleAdsSetup().catch(console.error);
