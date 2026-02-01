const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = './screenshots';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshot(page, name) {
    try {
        const filename = path.join(screenshotDir, `fast_${name}.png`);
        await page.screenshot({ path: filename, fullPage: true });
        console.log(`Screenshot: ${filename}`);
        return filename;
    } catch (e) {
        console.log('Screenshot failed:', e.message);
        return null;
    }
}

async function main() {
    console.log('=== X/Twitter Login - Fast Mode ===\n');

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    // Don't wait for full load
    page.setDefaultTimeout(30000);

    try {
        // Step 1: Go to Twitter login (don't wait for networkidle)
        console.log('1. Opening X/Twitter login page (fast mode)...');
        await page.goto('https://x.com/i/flow/login', { waitUntil: 'load', timeout: 90000 });
        console.log('Page loaded, waiting for content...');
        await sleep(8000);  // Wait for JS to render
        await saveScreenshot(page, '01_loaded');

        // Check page content
        const content = await page.content();
        console.log('Page has Sign in with Google:', content.includes('Google'));

        // Step 2: Click Google sign-in
        console.log('\n2. Looking for Google button...');

        // Wait for interactive elements
        await page.waitForSelector('[role="button"]', { state: 'visible', timeout: 15000 }).catch(() => {});
        await sleep(2000);

        // Get all buttons text
        const buttons = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[role="button"], button')).map(b => b.innerText);
        });
        console.log('Buttons on page:', buttons.filter(b => b.length < 50));

        // Try clicking Google
        let googleClicked = false;
        const googleBtn = await page.$('button:has-text("Google"), [role="button"]:has-text("Google")');
        if (googleBtn) {
            // Set up popup handler BEFORE clicking
            const popupPromise = context.waitForEvent('page');
            await googleBtn.click();
            googleClicked = true;
            console.log('Clicked Google button!');

            // Wait for popup
            console.log('3. Waiting for Google popup...');
            const googlePage = await popupPromise;
            console.log('Google popup opened:', googlePage.url());
            await googlePage.waitForLoadState('load');
            await sleep(3000);
            await saveScreenshot(googlePage, '02_google_popup');

            // Enter email
            console.log('\n4. Entering Google credentials...');
            try {
                await googlePage.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
                await sleep(500);
                await saveScreenshot(googlePage, '03_email');

                // Click Next
                await googlePage.click('#identifierNext');
                await sleep(4000);
                await saveScreenshot(googlePage, '04_after_email');

                // Enter password
                await googlePage.waitForSelector('input[type="password"]', { timeout: 10000 });
                await googlePage.fill('input[type="password"]', 'relaxing41!');
                await sleep(500);
                await saveScreenshot(googlePage, '05_password');

                // Click Next
                await googlePage.click('#passwordNext');
                console.log('Submitted password, checking for 2FA...');
                await sleep(5000);
                await saveScreenshot(googlePage, '06_after_password');

                // Check for 2FA prompt
                const url = googlePage.url();
                console.log('Current URL:', url);

                if (url.includes('challenge') || url.includes('signin/v2')) {
                    console.log('\n*** 2FA PROMPT DETECTED ***');
                    console.log('Please tap "Yes" on your phone/device!');
                    await saveScreenshot(googlePage, '07_2fa_prompt');

                    // Wait for approval
                    console.log('Waiting up to 60 seconds for 2FA...');
                    for (let i = 0; i < 12; i++) {
                        await sleep(5000);
                        const currentUrl = googlePage.url();
                        console.log(`Checking... URL: ${currentUrl.substring(0, 60)}...`);
                        if (!currentUrl.includes('google.com')) {
                            console.log('2FA approved! Redirecting...');
                            break;
                        }
                        if (!currentUrl.includes('challenge') && !currentUrl.includes('signin')) {
                            console.log('Authentication complete!');
                            break;
                        }
                    }
                    await saveScreenshot(googlePage, '08_after_2fa');
                }

            } catch (e) {
                console.log('Google auth error:', e.message);
                await saveScreenshot(googlePage, 'google_error');
            }
        }

        if (!googleClicked) {
            console.log('\nGoogle button not found, trying Forgot Password flow...');

            // Click Forgot Password
            await page.click('text=Forgot password?');
            await sleep(3000);
            await saveScreenshot(page, '02_forgot');

            // Enter email
            await page.fill('input', 'relentlessrobotics@gmail.com');
            await sleep(500);
            await saveScreenshot(page, '03_email_forgot');

            // Submit
            await page.keyboard.press('Enter');
            await sleep(3000);
            await saveScreenshot(page, '04_after_submit');

            console.log('\n=== CHECK EMAIL FOR PASSWORD RESET LINK ===');
        }

        // Check main page status
        await sleep(5000);
        console.log('\n5. Checking login status...');
        console.log('Main page URL:', page.url());
        await saveScreenshot(page, '09_main_page');

        // If logged in (not on login page anymore)
        if (!page.url().includes('login') && !page.url().includes('flow')) {
            console.log('\n=== SUCCESS: LOGGED INTO X ===');

            // Navigate to password change
            console.log('6. Going to password settings...');
            await page.goto('https://x.com/settings/password', { waitUntil: 'load' });
            await sleep(3000);
            await saveScreenshot(page, '10_password_settings');

            // Fill password change form
            const inputs = await page.$$('input[type="password"]');
            console.log(`Found ${inputs.length} password fields`);

            if (inputs.length >= 2) {
                // Typically: new password, confirm password (if logged in via OAuth, might not need current)
                await inputs[0].fill('Twitter@Robotics2026!');
                if (inputs.length >= 2) {
                    await inputs[1].fill('Twitter@Robotics2026!');
                }
                await sleep(500);
                await saveScreenshot(page, '11_new_password');

                // Find and click save/update button
                await page.click('text=Save, text=Update password, [data-testid="settingsDetailSave"]');
                await sleep(3000);
                await saveScreenshot(page, '12_after_save');

                console.log('\n=== PASSWORD CHANGED TO: Twitter@Robotics2026! ===');
            }
        }

        console.log('\n=== Browser staying open for 3 minutes ===');
        await sleep(180000);

    } catch (error) {
        console.error('ERROR:', error.message);
        await saveScreenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main();
