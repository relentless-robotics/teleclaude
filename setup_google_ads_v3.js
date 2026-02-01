const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function setupGoogleAds() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('Starting Google Ads setup v3...');

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

        // Navigate to Google Ads signup directly
        console.log('Navigating to Google Ads signup...');
        await page.goto('https://ads.google.com/um/StartNow', { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(5000);

        console.log(`Current URL: ${page.url()}`);
        await page.screenshot({ path: 'gads_v3_step1.png', fullPage: true });

        // Check for account picker modal/dialog
        console.log('Checking for dialogs or popups...');

        // Look for "Create new Google Ads account" option
        try {
            const createNewOption = await page.locator('text=Create new Google Ads').first();
            if (await createNewOption.isVisible()) {
                console.log('Found "Create new Google Ads" option, clicking...');
                await createNewOption.click();
                await sleep(3000);
            }
        } catch (e) {
            console.log('No create new option visible');
        }

        // Also try looking for any "New" or "Add" buttons
        try {
            const addButton = await page.locator('[aria-label*="add"], [aria-label*="new"], button:has-text("Add"), button:has-text("New")').first();
            if (await addButton.isVisible()) {
                console.log('Found Add/New button, clicking...');
                await addButton.click();
                await sleep(3000);
            }
        } catch (e) {
            console.log('No add/new button visible');
        }

        await page.screenshot({ path: 'gads_v3_step2.png', fullPage: true });
        console.log(`URL after dialog check: ${page.url()}`);

        // If still on landing/marketing page, go directly to signup
        if (page.url().includes('business.google.com') || page.url().includes('google-ads')) {
            console.log('Trying alternate signup URL...');
            await page.goto('https://ads.google.com/nav/selectaccount', { waitUntil: 'networkidle', timeout: 60000 });
            await sleep(3000);
            console.log(`URL at selectaccount: ${page.url()}`);
            await page.screenshot({ path: 'gads_v3_selectaccount.png', fullPage: true });
        }

        // Try to create new account from account selector
        try {
            // Look for "+ New Google Ads account" or similar
            const newAccountSelectors = [
                'text=New Google Ads account',
                'text=Create new',
                'text=+ New',
                '[role="button"]:has-text("New")',
                'a:has-text("New account")'
            ];

            for (const selector of newAccountSelectors) {
                try {
                    const elem = await page.locator(selector).first();
                    if (await elem.isVisible()) {
                        console.log(`Found new account option: ${selector}`);
                        await elem.click();
                        await sleep(3000);
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }
        } catch (e) {
            console.log('No new account option found');
        }

        await page.screenshot({ path: 'gads_v3_step3.png', fullPage: true });
        console.log(`URL after account selection: ${page.url()}`);

        // Get current page content
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log('\n--- Page content ---');
        console.log(bodyText.substring(0, 4000));
        console.log('--- End content ---\n');

        // If we have an existing account, we might already be in dashboard
        if (page.url().includes('home') || page.url().includes('overview') || page.url().includes('campaigns')) {
            console.log('SUCCESS: Already have Google Ads account!');
            console.log('Checking account details...');

            // Try to get account ID
            try {
                // Account ID usually in URL or settings
                const urlMatch = page.url().match(/(\d{3}-\d{3}-\d{4})/);
                if (urlMatch) {
                    console.log(`Account ID: ${urlMatch[1]}`);
                }

                // Or try clicking on account settings
                const settingsIcon = await page.locator('[aria-label*="settings"], [aria-label*="Settings"], text=Settings').first();
                if (await settingsIcon.isVisible()) {
                    await settingsIcon.click();
                    await sleep(2000);
                }
            } catch (e) {
                console.log('Could not get account details from settings');
            }

            await page.screenshot({ path: 'gads_v3_dashboard.png', fullPage: true });
        }

        // Check if we need to set up new account wizard
        if (page.url().includes('signup') || page.url().includes('setup') || page.url().includes('wizard') || page.url().includes('StartNow')) {
            console.log('In account setup wizard...');

            // Fill business name if visible
            try {
                const businessInput = await page.locator('input').first();
                if (await businessInput.isVisible()) {
                    await businessInput.fill('Relentless Robotics');
                    console.log('Filled business name');
                    await sleep(1000);
                }
            } catch (e) {
                console.log('No business input found');
            }

            // Look for Next/Continue button
            try {
                const nextBtn = await page.locator('button:has-text("Next"), button:has-text("Continue"), button:has-text("Submit")').first();
                if (await nextBtn.isVisible()) {
                    console.log('Found Next/Continue button');
                    await nextBtn.click();
                    await sleep(3000);
                }
            } catch (e) {
                console.log('No next button found');
            }
        }

        // Final state
        await page.screenshot({ path: 'gads_v3_final.png', fullPage: true });
        console.log(`\nFinal URL: ${page.url()}`);

        // Extract any visible account info
        console.log('\nLooking for account information...');
        try {
            const accountIdMatch = page.url().match(/(\d{3}-\d{3}-\d{4})/);
            if (accountIdMatch) {
                console.log(`ACCOUNT ID FOUND: ${accountIdMatch[1]}`);
            }
        } catch (e) {
            // No account ID in URL
        }

        // Keep browser open for manual completion if needed
        console.log('\nKeeping browser open for 120 seconds for manual completion...');
        console.log('You can manually complete the signup if needed.');
        await sleep(120000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        console.error('Full error:', error);

        if (page) {
            await page.screenshot({ path: 'gads_v3_error.png', fullPage: true });
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

setupGoogleAds().catch(console.error);
