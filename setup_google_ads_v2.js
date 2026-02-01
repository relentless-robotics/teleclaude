const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function setupGoogleAds() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('Starting Google Ads setup v2...');

    let browser;
    let context;
    let page;

    try {
        // Load saved Google auth state
        console.log('Loading saved Google authentication...');
        browser = await chromium.launch({
            headless: false,
            args: ['--disable-blink-features=AutomationControlled']
        });
        context = await browser.newContext({ storageState: stateFile });
        page = await context.newPage();

        // Navigate to Google Ads
        console.log('Navigating to ads.google.com...');
        await page.goto('https://ads.google.com', { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(3000);

        console.log(`Current URL: ${page.url()}`);

        // Click "Start now" button to begin signup
        console.log('Looking for Start now button...');

        // Try multiple approaches
        try {
            // First try the main "Start now" button
            const startButton = await page.locator('text=Start now').first();
            if (await startButton.isVisible()) {
                console.log('Clicking Start now button...');
                await startButton.click();
                await sleep(5000);
            }
        } catch (e) {
            console.log('Start now button click failed:', e.message);
        }

        console.log(`URL after clicking Start now: ${page.url()}`);
        await page.screenshot({ path: 'google_ads_step1.png', fullPage: true });

        // Check if we're at a signup flow
        const url = page.url();

        // If we're still on the landing page, try "Claim Now" or another button
        if (url.includes('business.google.com')) {
            console.log('Still on landing page, trying alternative signup paths...');

            // Try clicking "Claim Now" or selecting an offer first
            try {
                // Look for offer selection
                const offerA = await page.locator('text=OFFER A').first();
                if (await offerA.isVisible()) {
                    console.log('Clicking OFFER A...');
                    await offerA.click();
                    await sleep(2000);
                }
            } catch (e) {
                console.log('No offer selection found');
            }

            try {
                const claimButton = await page.locator('text=Claim Now').first();
                if (await claimButton.isVisible()) {
                    console.log('Clicking Claim Now button...');
                    await claimButton.click();
                    await sleep(5000);
                }
            } catch (e) {
                console.log('Claim Now button not found');
            }

            // Try direct signup URL
            console.log('Navigating to direct signup URL...');
            await page.goto('https://ads.google.com/intl/en_us/getstarted/', { waitUntil: 'networkidle', timeout: 60000 });
            await sleep(3000);
        }

        console.log(`URL now: ${page.url()}`);
        await page.screenshot({ path: 'google_ads_step2.png', fullPage: true });

        // Try to find and fill business name
        console.log('Looking for business setup form...');

        // Check for various input fields
        const inputSelectors = [
            'input[aria-label*="business"]',
            'input[placeholder*="business"]',
            'input[name*="business"]',
            'input[type="text"]:visible'
        ];

        for (const selector of inputSelectors) {
            try {
                const inputs = await page.locator(selector).all();
                for (const input of inputs) {
                    if (await input.isVisible()) {
                        console.log(`Found input: ${selector}`);
                        // Don't fill yet, just report
                    }
                }
            } catch (e) {
                // Continue
            }
        }

        // Look for campaign goal selection
        console.log('Looking for goal selection...');
        const goalKeywords = ['sales', 'leads', 'traffic', 'awareness', 'app'];
        for (const keyword of goalKeywords) {
            try {
                const goalOption = await page.locator(`text=${keyword}`).first();
                if (await goalOption.isVisible()) {
                    console.log(`Found goal option: ${keyword}`);
                }
            } catch (e) {
                // Continue
            }
        }

        // Get all visible buttons
        const buttons = await page.locator('button').all();
        console.log(`Found ${buttons.length} buttons on page`);

        for (let i = 0; i < Math.min(buttons.length, 10); i++) {
            try {
                const text = await buttons[i].textContent();
                if (text && text.trim()) {
                    console.log(`Button ${i}: ${text.trim().substring(0, 50)}`);
                }
            } catch (e) {
                // Continue
            }
        }

        // Get page text for analysis
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log('\n--- Page content preview ---');
        console.log(bodyText.substring(0, 3000));
        console.log('--- End preview ---\n');

        // Final screenshot
        await page.screenshot({ path: 'google_ads_final_v2.png', fullPage: true });
        console.log(`Final URL: ${page.url()}`);

        // Keep browser open longer for manual observation
        console.log('Keeping browser open for 60 seconds...');
        await sleep(60000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        console.error('Full error:', error);

        if (page) {
            await page.screenshot({ path: 'google_ads_error_v2.png', fullPage: true });
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

setupGoogleAds().catch(console.error);
