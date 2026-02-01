const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = './screenshots';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshot(page, name) {
    const filename = path.join(screenshotDir, `v2_${name}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot: ${filename}`);
    return filename;
}

async function main() {
    console.log('=== Starting Google OAuth Login for X/Twitter ===\n');

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // Step 1: Go to Twitter login
        console.log('1. Opening X/Twitter login page...');
        await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(3000);
        await saveScreenshot(page, '01_login_page');

        // Step 2: Wait for and click Google sign-in
        console.log('2. Looking for Google Sign In button...');

        // Wait for the button to be visible
        await page.waitForSelector('button, [role="button"]', { timeout: 10000 });
        await sleep(1000);

        // Find all clickable elements and log them
        const buttons = await page.$$eval('button, [role="button"]', els => els.map(el => ({
            text: el.textContent.trim(),
            class: el.className,
            ariaLabel: el.getAttribute('aria-label')
        })));
        console.log('Found buttons:', JSON.stringify(buttons, null, 2));

        // Click Google button using more specific selector
        let googleClicked = false;

        // Try clicking by exact text match
        try {
            await page.click('button:has-text("Sign in with Google")', { timeout: 5000 });
            googleClicked = true;
            console.log('Clicked Google button (method 1)');
        } catch (e) {
            console.log('Method 1 failed:', e.message);
        }

        if (!googleClicked) {
            try {
                // Try finding by role and text content
                const allElements = await page.$$('[role="button"]');
                for (const el of allElements) {
                    const text = await el.textContent();
                    if (text && text.includes('Google')) {
                        await el.click();
                        googleClicked = true;
                        console.log('Clicked Google button (method 2)');
                        break;
                    }
                }
            } catch (e) {
                console.log('Method 2 failed:', e.message);
            }
        }

        if (!googleClicked) {
            // Try by CSS containing "google"
            try {
                await page.click('[data-testid*="google"], [class*="google"], [class*="Google"]', { timeout: 3000 });
                googleClicked = true;
                console.log('Clicked Google button (method 3)');
            } catch (e) {
                console.log('Method 3 failed:', e.message);
            }
        }

        if (!googleClicked) {
            console.log('ERROR: Could not find Google button!');
            await saveScreenshot(page, '02_no_google_button');

            // Let's try the forgot password flow instead
            console.log('\n=== Switching to Forgot Password flow ===');
            await page.click('text=Forgot password?', { timeout: 5000 });
            await sleep(3000);
            await saveScreenshot(page, '03_forgot_password');

            // Enter email
            const input = await page.$('input');
            if (input) {
                await input.fill('relentlessrobotics@gmail.com');
                await sleep(1000);
                await saveScreenshot(page, '04_email_entered');

                // Click Next/Search
                await page.click('text=Search, text=Next, [data-testid="ocfEnterTextNextButton"]');
                await sleep(3000);
                await saveScreenshot(page, '05_after_search');
            }

            console.log('\n=== CHECK YOUR EMAIL FOR RESET LINK ===');
            await sleep(60000);
            return;
        }

        // Wait for Google popup
        console.log('3. Waiting for Google popup...');
        await sleep(2000);
        await saveScreenshot(page, '02_after_google_click');

        // Listen for new page (popup)
        let googlePage = null;
        const pages = context.pages();
        for (const p of pages) {
            if (p.url().includes('accounts.google.com')) {
                googlePage = p;
                break;
            }
        }

        if (!googlePage) {
            console.log('Waiting for Google popup to open...');
            googlePage = await context.waitForEvent('page', { timeout: 15000 });
        }

        console.log('4. Google popup detected:', googlePage.url());
        await googlePage.waitForLoadState('domcontentloaded');
        await sleep(2000);
        await saveScreenshot(googlePage, '03_google_page');

        // Enter email in Google
        console.log('5. Entering Google email...');
        await googlePage.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
        await sleep(500);
        await saveScreenshot(googlePage, '04_google_email');

        // Click Next
        await googlePage.click('#identifierNext, button:has-text("Next")');
        await sleep(4000);
        await saveScreenshot(googlePage, '05_after_email_next');

        // Enter password
        console.log('6. Entering Google password...');
        await googlePage.waitForSelector('input[type="password"]', { timeout: 10000 });
        await googlePage.fill('input[type="password"]', 'relaxing41!');
        await sleep(500);
        await saveScreenshot(googlePage, '06_google_password');

        // Click Next
        await googlePage.click('#passwordNext, button:has-text("Next")');
        await sleep(5000);
        await saveScreenshot(googlePage, '07_after_password');

        // Check for 2FA
        console.log('7. Checking for 2FA...');
        const currentUrl = googlePage.url();
        console.log('Current Google URL:', currentUrl);

        if (currentUrl.includes('challenge') || currentUrl.includes('signin')) {
            console.log('\n*** 2FA REQUIRED - Please tap "Yes" on your phone! ***\n');
            await saveScreenshot(googlePage, '08_2fa');

            // Wait for user to approve
            console.log('Waiting 60 seconds for 2FA approval...');
            await sleep(60000);
            await saveScreenshot(googlePage, '09_after_2fa');
        }

        // Check main page
        await sleep(3000);
        await saveScreenshot(page, '10_main_after_auth');
        console.log('8. Main page URL:', page.url());

        // If we're logged in, change password
        if (!page.url().includes('login')) {
            console.log('\n=== LOGGED IN! Going to password settings ===');

            await page.goto('https://x.com/settings/password', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(3000);
            await saveScreenshot(page, '11_password_settings');

            // Try to change password
            const inputs = await page.$$('input');
            console.log(`Found ${inputs.length} input fields on password page`);

            // Current password might need to be blank or re-entered
            // New password fields
            for (const input of inputs) {
                const name = await input.getAttribute('name');
                const placeholder = await input.getAttribute('placeholder');
                console.log(`Input: name=${name}, placeholder=${placeholder}`);
            }

            // Fill new password
            // Typically: current_password, new_password, confirm_password
        }

        console.log('\n=== Browser staying open - Manual intervention if needed ===');
        await sleep(180000); // 3 minutes

    } catch (error) {
        console.error('ERROR:', error.message);
        await saveScreenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main();
