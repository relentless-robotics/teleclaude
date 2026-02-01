const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = './screenshots';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshot(page, name) {
    const filename = path.join(screenshotDir, `google_${name}-${Date.now()}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot saved: ${filename}`);
    return filename;
}

async function main() {
    console.log('Launching browser for Google Sign In...');

    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // Go to Twitter login
        console.log('Step 1: Navigating to X login...');
        await page.goto('https://twitter.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await sleep(5000);
        await saveScreenshot(page, 'step1_login');

        // Click "Sign in with Google"
        console.log('Step 2: Looking for Google Sign In button...');
        const googleButton = await page.locator('text=Sign in with Google').first();
        if (await googleButton.isVisible()) {
            console.log('Found Google button, clicking...');

            // Listen for popup before clicking
            const [popup] = await Promise.all([
                context.waitForEvent('page'),
                googleButton.click()
            ]);

            console.log('Step 3: Google popup opened');
            await popup.waitForLoadState('domcontentloaded');
            await sleep(2000);
            await saveScreenshot(popup, 'step3_google_popup');

            console.log('Google URL:', popup.url());

            // Enter email
            console.log('Step 4: Entering email...');
            await popup.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
            await sleep(1000);
            await saveScreenshot(popup, 'step4_email_entered');

            // Click Next
            await popup.click('button:has-text("Next"), #identifierNext');
            console.log('Clicked Next after email');
            await sleep(4000);
            await saveScreenshot(popup, 'step5_after_email_next');

            // Check current state
            console.log('Current Google URL:', popup.url());

            // Enter password
            console.log('Step 6: Looking for password field...');
            const passwordField = await popup.$('input[type="password"]');
            if (passwordField) {
                console.log('Password field found, entering password...');
                await passwordField.fill('relaxing41!');
                await sleep(1000);
                await saveScreenshot(popup, 'step6_password_entered');

                // Click Next for password
                await popup.click('button:has-text("Next"), #passwordNext');
                console.log('Clicked Next after password');
                await sleep(5000);
                await saveScreenshot(popup, 'step7_after_password');

                // Check for 2FA
                const tfaCheck = await popup.$('text=2-Step Verification');
                if (tfaCheck) {
                    console.log('2FA REQUIRED - User needs to approve on phone!');
                    await saveScreenshot(popup, 'step8_2fa_required');
                    console.log('Waiting 30 seconds for 2FA approval...');
                    await sleep(30000);
                    await saveScreenshot(popup, 'step9_after_2fa_wait');
                }
            } else {
                console.log('No password field found - checking for other prompts');
                await saveScreenshot(popup, 'step6_no_password');
            }

            // Wait for redirect back to Twitter
            console.log('Waiting for redirect to Twitter...');
            await sleep(5000);

            // Check main page status
            await saveScreenshot(page, 'step10_main_page');
            console.log('Main page URL:', page.url());

        } else {
            console.log('Google button not found!');
            await saveScreenshot(page, 'error_no_google');
        }

        // Check if logged in
        await sleep(5000);
        await saveScreenshot(page, 'final_state');
        console.log('Final URL:', page.url());

        // If logged in, go to password settings
        if (page.url().includes('home') || page.url().includes('x.com/')) {
            console.log('SUCCESS: Logged into Twitter!');

            // Navigate to settings
            console.log('Navigating to password settings...');
            await page.goto('https://twitter.com/settings/password', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(3000);
            await saveScreenshot(page, 'settings_password');
        }

        console.log('\n=== BROWSER STAYING OPEN FOR 2 MINUTES ===');
        console.log('If 2FA is needed, approve on phone!');
        await sleep(120000);

    } catch (error) {
        console.error('Error:', error.message);
        await saveScreenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main();
