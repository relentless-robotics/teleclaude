const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const screenshotDir = './screenshots';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshot(page, name) {
    const filename = path.join(screenshotDir, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot saved: ${filename}`);
    return filename;
}

async function main() {
    console.log('Launching browser...');

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
        // Go directly to login flow
        console.log('Navigating to X login flow...');
        await page.goto('https://twitter.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await sleep(5000);
        await saveScreenshot(page, 'login-page');

        console.log('Current URL:', page.url());

        // Wait for page content
        await page.waitForSelector('input', { timeout: 30000 }).catch(() => console.log('No input found yet...'));

        await sleep(2000);
        await saveScreenshot(page, 'login-loaded');

        // Try to find and enter email
        console.log('Looking for email input...');

        // Try various input selectors
        let emailEntered = false;
        const inputs = await page.$$('input');
        console.log(`Found ${inputs.length} input fields`);

        for (const input of inputs) {
            const type = await input.getAttribute('type');
            const name = await input.getAttribute('name');
            const autocomplete = await input.getAttribute('autocomplete');
            console.log(`Input: type=${type}, name=${name}, autocomplete=${autocomplete}`);

            if (type === 'text' || name === 'text' || autocomplete === 'username') {
                await input.fill('relentlessrobotics@gmail.com');
                emailEntered = true;
                console.log('Email entered!');
                break;
            }
        }

        await sleep(1000);
        await saveScreenshot(page, 'after-email');

        // Click Next button
        console.log('Looking for Next button...');
        const buttons = await page.$$('[role="button"], button');
        console.log(`Found ${buttons.length} buttons`);

        for (const btn of buttons) {
            const text = await btn.textContent();
            console.log(`Button text: ${text}`);
            if (text && text.toLowerCase().includes('next')) {
                await btn.click();
                console.log('Clicked Next!');
                break;
            }
        }

        await sleep(3000);
        await saveScreenshot(page, 'after-next');

        // Check what's on screen now
        console.log('Current URL:', page.url());
        const pageContent = await page.content();

        // Look for password field or verification
        const passwordInputs = await page.$$('input[type="password"]');
        if (passwordInputs.length > 0) {
            console.log('Password field found - need to use forgot password');

            // Look for forgot password link
            const links = await page.$$('a, span[role="link"], [role="button"]');
            for (const link of links) {
                const text = await link.textContent();
                if (text && text.toLowerCase().includes('forgot')) {
                    console.log('Found forgot password link:', text);
                    await link.click();
                    break;
                }
            }
        }

        await sleep(3000);
        await saveScreenshot(page, 'after-forgot');

        // Check for verification or username prompt
        const verificationText = await page.$('text=Verify your identity');
        const usernameText = await page.$('text=Enter your phone number or username');

        if (usernameText) {
            console.log('Twitter asking for username/phone verification...');
            // Try entering email again or look for alternatives
        }

        await sleep(3000);
        await saveScreenshot(page, 'current-state');

        console.log('\n=== STATUS ===');
        console.log('URL:', page.url());
        console.log('Browser staying open for manual intervention...');
        console.log('Check screenshots folder for current state');

        // Keep browser open for manual intervention
        await sleep(120000);

    } catch (error) {
        console.error('Error:', error.message);
        await saveScreenshot(page, 'error');
    } finally {
        await browser.close();
    }
}

main();
