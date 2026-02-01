const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sendDiscordUpdate(message) {
    console.log(`[DISCORD UPDATE] ${message}`);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function setupGoogleAds() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    await sendDiscordUpdate('Starting Google Ads setup...');

    let browser;
    let context;
    let page;

    try {
        // Try to load saved Google auth state
        if (fs.existsSync(stateFile)) {
            await sendDiscordUpdate('Loading saved Google authentication...');
            browser = await chromium.launch({
                headless: false,
                args: ['--disable-blink-features=AutomationControlled']
            });
            context = await browser.newContext({ storageState: stateFile });
        } else {
            // Fallback to Edge persistent context
            await sendDiscordUpdate('Auth file not found, using Edge persistent context...');
            context = await chromium.launchPersistentContext('./browser_profile_edge', {
                channel: 'msedge',
                headless: false,
                args: ['--disable-blink-features=AutomationControlled']
            });
        }

        page = await context.newPage();

        // Navigate to Google Ads
        await sendDiscordUpdate('Navigating to ads.google.com...');
        await page.goto('https://ads.google.com', { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(3000);

        // Take screenshot of current state
        await page.screenshot({ path: 'google_ads_initial.png', fullPage: true });
        await sendDiscordUpdate('Screenshot saved: google_ads_initial.png');

        // Check current URL and page content
        const currentUrl = page.url();
        await sendDiscordUpdate(`Current URL: ${currentUrl}`);

        // Get page title
        const pageTitle = await page.title();
        await sendDiscordUpdate(`Page title: ${pageTitle}`);

        // Check if we need to sign in
        if (currentUrl.includes('accounts.google.com')) {
            await sendDiscordUpdate('Need to sign in to Google...');

            // Try to enter email
            const emailInput = await page.$('input[type="email"]');
            if (emailInput) {
                await emailInput.fill('relentlessrobotics@gmail.com');
                await sleep(1000);
                await page.click('#identifierNext');
                await sleep(3000);

                // Enter password
                const passwordInput = await page.$('input[type="password"]');
                if (passwordInput) {
                    await passwordInput.fill('Relaxing41!');
                    await sleep(1000);
                    await page.click('#passwordNext');
                    await sleep(5000);
                }
            }

            // Take screenshot after login attempt
            await page.screenshot({ path: 'google_ads_after_login.png', fullPage: true });
        }

        // Wait for page to load
        await sleep(3000);

        // Check if we're on Google Ads dashboard or setup page
        const currentUrl2 = page.url();
        await sendDiscordUpdate(`URL after login check: ${currentUrl2}`);

        // Look for "Start now" or "Get started" buttons
        await sendDiscordUpdate('Looking for setup buttons...');

        // Try multiple selectors for getting started
        const setupSelectors = [
            'text=Start now',
            'text=Get started',
            'text=Sign up',
            'text=Create account',
            'a[href*="signup"]',
            'button:has-text("Start")',
            'button:has-text("Get started")',
            '[data-action="sign-up"]'
        ];

        let clickedSetup = false;
        for (const selector of setupSelectors) {
            try {
                const element = await page.$(selector);
                if (element && await element.isVisible()) {
                    await sendDiscordUpdate(`Found button: ${selector}`);
                    await element.click();
                    clickedSetup = true;
                    await sleep(3000);
                    break;
                }
            } catch (e) {
                // Continue to next selector
            }
        }

        if (!clickedSetup) {
            await sendDiscordUpdate('No setup button found - checking page content...');
            const pageContent = await page.content();

            // Check if already logged into Google Ads
            if (currentUrl2.includes('home') || currentUrl2.includes('overview') || currentUrl2.includes('dashboard')) {
                await sendDiscordUpdate('Already have Google Ads account - at dashboard!');
            }
        }

        // Take screenshot of current state
        await page.screenshot({ path: 'google_ads_state.png', fullPage: true });
        await sendDiscordUpdate('Screenshot saved: google_ads_state.png');

        // Check for account setup wizard
        await sendDiscordUpdate('Checking for account setup wizard...');

        // Look for business name input
        const businessNameInputs = [
            'input[aria-label*="business"]',
            'input[placeholder*="business"]',
            'input[name*="business"]',
            '#business-name',
            '[data-testid="business-name"]'
        ];

        for (const selector of businessNameInputs) {
            try {
                const input = await page.$(selector);
                if (input && await input.isVisible()) {
                    await sendDiscordUpdate(`Found business name input: ${selector}`);
                    await input.fill('Relentless Robotics');
                    await sleep(1000);
                    break;
                }
            } catch (e) {
                // Continue
            }
        }

        // Look for skip buttons or "next" buttons
        const nextButtons = [
            'text=Next',
            'text=Continue',
            'text=Skip',
            'button:has-text("Next")',
            'button:has-text("Continue")'
        ];

        for (const selector of nextButtons) {
            try {
                const button = await page.$(selector);
                if (button && await button.isVisible()) {
                    await sendDiscordUpdate(`Found button: ${selector}`);
                    break;
                }
            } catch (e) {
                // Continue
            }
        }

        // Get all visible text on page for debugging
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log('Page text preview:', bodyText.substring(0, 2000));

        // Final screenshot
        await page.screenshot({ path: 'google_ads_final.png', fullPage: true });
        await sendDiscordUpdate('Final screenshot saved: google_ads_final.png');

        // Report final state
        const finalUrl = page.url();
        await sendDiscordUpdate(`Final URL: ${finalUrl}`);
        await sendDiscordUpdate('Script completed - check screenshots for current state');

        // Keep browser open for manual intervention if needed
        await sendDiscordUpdate('Keeping browser open for 30 seconds...');
        await sleep(30000);

    } catch (error) {
        await sendDiscordUpdate(`Error: ${error.message}`);
        console.error('Full error:', error);

        if (page) {
            await page.screenshot({ path: 'google_ads_error.png', fullPage: true });
        }
    } finally {
        if (browser) {
            await browser.close();
        } else if (context) {
            await context.close();
        }
    }
}

setupGoogleAds().catch(console.error);
