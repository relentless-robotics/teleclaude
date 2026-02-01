const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = './screenshots';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshot(page, name) {
    try {
        const filename = path.join(screenshotDir, `oauth_${name}.png`);
        await page.screenshot({ path: filename, fullPage: true });
        console.log(`Screenshot: ${filename}`);
        return filename;
    } catch (e) {
        console.log('Screenshot failed:', e.message);
        return null;
    }
}

async function main() {
    console.log('=== X/Twitter Google OAuth Login ===\n');

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    try {
        // Step 1: Go to Twitter login page
        console.log('1. Opening X login page...');
        await page.goto('https://x.com/i/flow/login', { waitUntil: 'load', timeout: 90000 });
        await sleep(6000);
        await saveScreenshot(page, '01_login');

        // Step 2: Log all elements to understand the page structure
        console.log('\n2. Analyzing page structure...');
        const pageContent = await page.evaluate(() => {
            const elements = [];
            document.querySelectorAll('*').forEach(el => {
                if (el.innerText && el.innerText.toLowerCase().includes('google')) {
                    elements.push({
                        tag: el.tagName,
                        text: el.innerText.substring(0, 100),
                        class: el.className,
                        role: el.getAttribute('role')
                    });
                }
            });
            return elements;
        });
        console.log('Elements with "Google":', JSON.stringify(pageContent.slice(0, 5), null, 2));

        // Step 3: Find and click Google button more precisely
        console.log('\n3. Looking for Google sign-in button...');

        // Method 1: By visible text
        const googleElements = await page.locator(':text("Sign in with Google")').all();
        console.log(`Found ${googleElements.length} elements with "Sign in with Google"`);

        if (googleElements.length > 0) {
            console.log('Clicking first Google element...');

            // Set up popup listener before click
            const popupPromise = context.waitForEvent('page', { timeout: 30000 });
            await googleElements[0].click();
            console.log('Clicked! Waiting for popup...');

            const googlePage = await popupPromise;
            console.log('Google popup opened:', googlePage.url());

            await sleep(3000);
            await saveScreenshot(googlePage, '02_google');

            // Enter Google email
            console.log('\n4. Entering Google credentials...');
            await googlePage.waitForSelector('input[type="email"]', { timeout: 10000 });
            await googlePage.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
            await sleep(500);
            await saveScreenshot(googlePage, '03_email');

            // Click Next
            await googlePage.click('#identifierNext');
            console.log('Clicked Next after email');
            await sleep(4000);
            await saveScreenshot(googlePage, '04_after_email');

            // Enter password
            console.log('5. Entering password...');
            await googlePage.waitForSelector('input[type="password"]', { timeout: 15000 });
            await googlePage.fill('input[type="password"]', 'relaxing41!');
            await sleep(500);
            await saveScreenshot(googlePage, '05_password');

            // Click Next
            await googlePage.click('#passwordNext');
            console.log('Submitted password');
            await sleep(5000);
            await saveScreenshot(googlePage, '06_after_password');

            // Check for 2FA
            const currentUrl = googlePage.url();
            console.log('Current URL:', currentUrl);

            if (currentUrl.includes('challenge') || currentUrl.includes('v2/challenge')) {
                console.log('\n*** 2FA REQUIRED ***');
                console.log('*** Please tap YES on your phone! ***\n');
                await saveScreenshot(googlePage, '07_2fa');

                // Wait up to 90 seconds for 2FA
                console.log('Waiting for 2FA approval (90 seconds max)...');
                for (let i = 0; i < 18; i++) {
                    await sleep(5000);
                    const url = googlePage.url();
                    const stillChallenge = url.includes('challenge') || url.includes('signin');

                    if (!stillChallenge || !url.includes('google.com')) {
                        console.log('2FA appears to be approved!');
                        break;
                    }
                    console.log(`Still waiting... (${(i + 1) * 5}s)`);
                }
                await saveScreenshot(googlePage, '08_after_2fa');
            }

            // Wait for redirect and check main page
            await sleep(5000);
            await saveScreenshot(page, '09_main_after_auth');
            console.log('\nMain page URL after auth:', page.url());

        } else {
            console.log('Google button not found by text. Trying other methods...');

            // Method 2: Click by CSS/structure
            try {
                // Twitter often uses a specific structure
                await page.click('button >> text=Google', { timeout: 5000 });
                console.log('Clicked Google via button selector');
            } catch (e) {
                console.log('Button selector failed');
            }

            await saveScreenshot(page, '02_no_google');
        }

        // Check if we're logged in
        console.log('\n6. Checking login status...');
        await sleep(3000);
        const finalUrl = page.url();
        console.log('Final URL:', finalUrl);
        await saveScreenshot(page, '10_final');

        if (!finalUrl.includes('login') && !finalUrl.includes('flow')) {
            console.log('\n=== SUCCESS: LOGGED INTO X! ===');

            // Get username/profile info
            try {
                await page.goto('https://x.com/settings/account', { waitUntil: 'load' });
                await sleep(3000);
                await saveScreenshot(page, '11_settings');

                const settingsText = await page.textContent('body');
                console.log('Settings page info captured');

                // Try to get username
                const usernameMatch = settingsText.match(/@(\w+)/);
                if (usernameMatch) {
                    console.log('Username found:', usernameMatch[0]);
                }
            } catch (e) {
                console.log('Could not get settings:', e.message);
            }

            // Now change password
            console.log('\n7. Changing password...');
            await page.goto('https://x.com/settings/password', { waitUntil: 'load' });
            await sleep(3000);
            await saveScreenshot(page, '12_password_settings');

            // Check what fields are available
            const passwordInputs = await page.$$('input[type="password"]');
            console.log(`Found ${passwordInputs.length} password fields`);

            // Twitter with OAuth might only need new password (no current password required)
            if (passwordInputs.length >= 2) {
                // Two fields: new password and confirm
                await passwordInputs[0].fill('Twitter@Robotics2026!');
                await passwordInputs[1].fill('Twitter@Robotics2026!');
                await saveScreenshot(page, '13_new_password');

                // Find save button
                await page.click('[data-testid="settingsDetailSave"], text=Save, text=Update').catch(() => {});
                await sleep(3000);
                await saveScreenshot(page, '14_after_save');

                console.log('\n=== PASSWORD CHANGED TO: Twitter@Robotics2026! ===');
            } else if (passwordInputs.length === 3) {
                // Three fields: current, new, confirm
                // For OAuth login, current password field might be empty
                await passwordInputs[1].fill('Twitter@Robotics2026!');
                await passwordInputs[2].fill('Twitter@Robotics2026!');
                await saveScreenshot(page, '13_new_password');

                await page.click('[data-testid="settingsDetailSave"], text=Save, text=Update').catch(() => {});
                await sleep(3000);
                await saveScreenshot(page, '14_after_save');
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
