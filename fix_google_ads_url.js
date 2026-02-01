const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fixGoogleAdsSetup() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('Fixing Google Ads URL input...');

    let browser;
    let context;
    let page;

    try {
        browser = await chromium.launch({
            headless: false,
            args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
        });
        context = await browser.newContext({
            storageState: stateFile,
            viewport: { width: 1920, height: 1080 }
        });
        page = await context.newPage();

        // Go directly to the setup page for this account
        console.log('Navigating to account setup...');
        await page.goto('https://ads.google.com/aw/signup/aboutyourbusiness?ocid=7987879904&euid=1615163210&__u=3072615290&uscid=7987879904&__c=6128758496&authuser=0', {
            waitUntil: 'networkidle',
            timeout: 60000
        });
        await sleep(5000);

        console.log(`Current URL: ${page.url()}`);
        await page.screenshot({ path: 'fix_step1.png', fullPage: true });

        // Get all input elements
        const inputs = await page.locator('input').all();
        console.log(`Found ${inputs.length} input elements`);

        for (let i = 0; i < inputs.length; i++) {
            try {
                const inputType = await inputs[i].getAttribute('type');
                const inputPlaceholder = await inputs[i].getAttribute('placeholder');
                const inputAriaLabel = await inputs[i].getAttribute('aria-label');
                const inputName = await inputs[i].getAttribute('name');
                console.log(`Input ${i}: type=${inputType}, placeholder=${inputPlaceholder}, aria-label=${inputAriaLabel}, name=${inputName}`);
            } catch (e) {
                console.log(`Input ${i}: could not get attributes`);
            }
        }

        // Fill business name first
        console.log('\nFilling business name...');
        try {
            // Find the business name input - should be first text input
            const businessInputs = await page.locator('input[type="text"]').all();
            if (businessInputs.length > 0) {
                await businessInputs[0].clear();
                await businessInputs[0].fill('Relentless Robotics');
                console.log('Filled business name');
            }
        } catch (e) {
            console.log('Error filling business name:', e.message);
        }

        await sleep(1000);

        // Now fill the URL field - need to find it specifically
        console.log('\nFilling website URL...');
        try {
            // Look for URL input with various selectors
            const urlSelectors = [
                'input[type="url"]',
                'input[inputmode="url"]',
                'input[placeholder*="URL"]',
                'input[placeholder*="url"]',
                'input[aria-label*="URL"]',
                'input[aria-label*="url"]',
                'input[aria-label*="website"]',
                'input[aria-label*="Website"]',
                'input[name*="url"]',
                'input[name*="website"]'
            ];

            let urlInputFound = false;
            for (const selector of urlSelectors) {
                try {
                    const urlInput = await page.locator(selector).first();
                    if (await urlInput.isVisible()) {
                        console.log(`Found URL input with: ${selector}`);
                        await urlInput.clear();
                        await urlInput.type('https://www.example.com', { delay: 50 });
                        console.log('Typed website URL');
                        urlInputFound = true;
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }

            if (!urlInputFound) {
                // Try finding by looking at the label
                console.log('Trying to find URL input by nearby text...');
                const allTextInputs = await page.locator('input').all();
                for (let i = 0; i < allTextInputs.length; i++) {
                    try {
                        const val = await allTextInputs[i].inputValue();
                        console.log(`Input ${i} value: "${val}"`);

                        // Second input is usually the URL
                        if (i === 1) {
                            await allTextInputs[i].clear();
                            await allTextInputs[i].type('https://www.example.com', { delay: 100 });
                            console.log(`Filled input ${i} with URL`);
                            urlInputFound = true;
                            break;
                        }
                    } catch (e) {
                        // Continue
                    }
                }
            }

        } catch (e) {
            console.log('Error filling URL:', e.message);
        }

        await sleep(2000);
        await page.screenshot({ path: 'fix_step2.png', fullPage: true });

        // Click Next
        console.log('\nClicking Next...');
        try {
            const nextBtn = await page.locator('button:has-text("Next")').first();
            if (await nextBtn.isVisible()) {
                await nextBtn.click();
                console.log('Clicked Next');
                await sleep(5000);
            }
        } catch (e) {
            console.log('Error clicking Next:', e.message);
        }

        await page.screenshot({ path: 'fix_step3.png', fullPage: true });
        console.log(`URL after Next: ${page.url()}`);

        // Continue with setup steps
        let stepNum = 0;
        while (stepNum < 15) {
            stepNum++;
            console.log(`\n=== Step ${stepNum} ===`);

            const currentUrl = page.url();
            const bodyText = await page.evaluate(() => document.body.innerText);
            console.log('Page preview:', bodyText.substring(0, 500));

            // Check if we reached dashboard
            if (currentUrl.includes('/aw/overview') || currentUrl.includes('/aw/campaigns') || currentUrl.includes('/home')) {
                console.log('SUCCESS: Reached dashboard!');
                break;
            }

            // Handle different steps based on content
            if (bodyText.includes('Skip for now') || bodyText.includes('Skip campaign creation')) {
                console.log('Found skip option...');
                try {
                    const skipBtn = await page.locator('text=Skip').first();
                    if (await skipBtn.isVisible()) {
                        await skipBtn.click();
                        console.log('Clicked Skip');
                        await sleep(3000);
                        continue;
                    }
                } catch (e) {
                    // Continue
                }
            }

            // Check for billing skip
            if (bodyText.toLowerCase().includes('billing') || bodyText.toLowerCase().includes('payment')) {
                console.log('At billing step...');
                try {
                    const skipBilling = await page.locator('text=Set up later, text=Skip, text=I\'ll do this later').first();
                    if (await skipBilling.isVisible()) {
                        await skipBilling.click();
                        console.log('Skipped billing');
                        await sleep(3000);
                        continue;
                    }
                } catch (e) {
                    // Continue with next button
                }
            }

            // Try Next/Continue
            try {
                const nextBtns = ['button:has-text("Next")', 'button:has-text("Continue")', 'button:has-text("Submit")', 'button:has-text("Create campaign")'];
                for (const selector of nextBtns) {
                    const btn = await page.locator(selector).first();
                    if (await btn.isVisible() && await btn.isEnabled()) {
                        console.log(`Clicking: ${selector}`);
                        await btn.click();
                        await sleep(5000);
                        break;
                    }
                }
            } catch (e) {
                console.log('No next button clickable');
            }

            await page.screenshot({ path: `fix_step${stepNum + 3}.png`, fullPage: true });
        }

        // Final state
        console.log('\n=== FINAL STATE ===');
        console.log(`URL: ${page.url()}`);
        await page.screenshot({ path: 'fix_final.png', fullPage: true });

        const finalText = await page.evaluate(() => document.body.innerText);
        console.log('Final page:', finalText.substring(0, 2000));

        console.log('\nKeeping browser open for 300 seconds...');
        await sleep(300000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        if (page) {
            await page.screenshot({ path: 'fix_error.png', fullPage: true });
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

fixGoogleAdsSetup().catch(console.error);
