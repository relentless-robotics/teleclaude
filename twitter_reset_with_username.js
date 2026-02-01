const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = './screenshots';

// Try these usernames in order
const usernamesToTry = [
    'relentlessrobotics',
    'RelentlessRobotics',
    'relentless_robotics',
    'relentlessrobotics@gmail.com'
];

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshot(page, name) {
    try {
        const filename = path.join(screenshotDir, `reset_${name}.png`);
        await page.screenshot({ path: filename, fullPage: true });
        console.log(`Screenshot: ${filename}`);
        return filename;
    } catch (e) {
        console.log('Screenshot failed:', e.message);
        return null;
    }
}

async function main() {
    console.log('=== X/Twitter Password Reset with Username Verification ===\n');

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    try {
        // Go directly to password reset flow
        console.log('1. Opening password reset page...');
        await page.goto('https://x.com/i/flow/password_reset', { waitUntil: 'load', timeout: 90000 });
        await sleep(5000);
        await saveScreenshot(page, '01_reset_page');

        // Check what we see
        const pageText = await page.textContent('body');
        console.log('Page contains "Find your account":', pageText.includes('Find your'));
        console.log('Page contains "username":', pageText.includes('username'));

        // If we're at the "Find your account" step, enter email first
        if (pageText.includes('Find your') || pageText.includes('email, phone')) {
            console.log('\n2. Entering email to find account...');
            const input = await page.$('input');
            if (input) {
                await input.fill('relentlessrobotics@gmail.com');
                await sleep(500);
                await saveScreenshot(page, '02_email_entered');

                // Click Next/Search
                await page.click('[role="button"]:has-text("Next"), [role="button"]:has-text("Search")');
                await sleep(3000);
                await saveScreenshot(page, '03_after_search');
            }
        }

        // Now check if we need username verification
        const afterSearchText = await page.textContent('body');
        if (afterSearchText.includes('Confirm your username') || afterSearchText.includes('Username')) {
            console.log('\n3. Username verification required. Trying usernames...');

            for (const username of usernamesToTry) {
                console.log(`\nTrying username: ${username}`);

                // Clear and fill username
                const usernameInput = await page.$('input[name="text"], input');
                if (usernameInput) {
                    await usernameInput.fill('');
                    await sleep(200);
                    await usernameInput.fill(username);
                    await sleep(500);
                    await saveScreenshot(page, `04_username_${username.replace('@', '_at_')}`);

                    // Click Next
                    await page.click('[role="button"]:has-text("Next")');
                    await sleep(3000);

                    // Check if it worked (page changed) or error
                    const resultText = await page.textContent('body');
                    await saveScreenshot(page, `05_after_${username.replace('@', '_at_')}`);

                    if (!resultText.includes("doesn't match") && !resultText.includes('try again') && !resultText.includes('Confirm your username')) {
                        console.log(`SUCCESS: Username "${username}" accepted!`);
                        break;
                    } else {
                        console.log(`Username "${username}" didn't work, trying next...`);
                        // Go back and try again
                        await page.goBack();
                        await sleep(2000);
                    }
                }
            }
        }

        // Check current state
        await sleep(2000);
        await saveScreenshot(page, '06_current_state');
        console.log('\nCurrent URL:', page.url());
        const currentText = await page.textContent('body');

        // Look for password reset confirmation options
        if (currentText.includes('Send a confirmation code') || currentText.includes('email')) {
            console.log('\n=== EMAIL RESET CODE OPTION DETECTED ===');
            console.log('Looking for email option...');

            // Try to click on email option
            await page.click('text=Send a confirmation code to, text=email').catch(() => {});
            await sleep(2000);
            await saveScreenshot(page, '07_after_email_option');

            // Click Next to send code
            await page.click('[role="button"]:has-text("Next")').catch(() => {});
            await sleep(3000);
            await saveScreenshot(page, '08_code_sent');

            console.log('\n*** CHECK YOUR EMAIL FOR THE RESET CODE! ***');
        }

        console.log('\n=== Browser staying open for 5 minutes ===');
        console.log('Manual intervention may be needed.');
        await sleep(300000);

    } catch (error) {
        console.error('ERROR:', error.message);
        await saveScreenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main();
