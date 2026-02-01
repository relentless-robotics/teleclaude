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
        headless: false,  // Visible browser for manual intervention if needed
        args: ['--start-maximized']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // Step 1: Go to X.com
        console.log('Navigating to x.com...');
        await page.goto('https://x.com', { waitUntil: 'networkidle', timeout: 60000 });
        await sleep(3000);
        await saveScreenshot(page, 'step1-homepage');

        // Look for Sign In button
        console.log('Looking for Sign In button...');

        // Try different selectors for sign in
        const signInSelectors = [
            'a[href="/login"]',
            'a[href*="login"]',
            '[data-testid="loginButton"]',
            'text=Sign in',
            'text=Log in',
            'a:has-text("Sign in")',
            'a:has-text("Log in")'
        ];

        let clicked = false;
        for (const selector of signInSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.click();
                    clicked = true;
                    console.log(`Clicked sign in with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                // Continue trying
            }
        }

        if (!clicked) {
            // Navigate directly to login page
            console.log('Navigating directly to login page...');
            await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle', timeout: 60000 });
        }

        await sleep(3000);
        await saveScreenshot(page, 'step2-login-page');

        // Look for "Sign in with Google" option first
        console.log('Looking for Google Sign In option...');
        const googleSelectors = [
            'text=Sign in with Google',
            'text=Continue with Google',
            '[data-provider="google"]',
            'button:has-text("Google")',
            'div:has-text("Google")'
        ];

        let googleFound = false;
        for (const selector of googleSelectors) {
            try {
                const element = await page.$(selector);
                if (element && await element.isVisible()) {
                    console.log(`Found Google option with selector: ${selector}`);
                    googleFound = true;
                    await element.click();
                    await sleep(5000);
                    break;
                }
            } catch (e) {
                // Continue
            }
        }

        if (googleFound) {
            console.log('Google sign-in popup should appear...');
            await saveScreenshot(page, 'step3-google-popup');

            // Handle Google sign-in popup
            const pages = context.pages();
            let googlePage = pages.find(p => p.url().includes('accounts.google.com'));

            if (!googlePage) {
                // Wait for new page to open
                googlePage = await context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
            }

            if (googlePage) {
                console.log('Google sign-in page detected...');
                await googlePage.waitForLoadState('networkidle');
                await saveScreenshot(googlePage, 'step4-google-signin');

                // Enter email
                const emailInput = await googlePage.$('input[type="email"]');
                if (emailInput) {
                    await emailInput.fill('relentlessrobotics@gmail.com');
                    await sleep(1000);
                    await googlePage.click('button:has-text("Next")');
                    await sleep(3000);
                    await saveScreenshot(googlePage, 'step5-google-email-entered');

                    // Enter password
                    const passwordInput = await googlePage.$('input[type="password"]');
                    if (passwordInput) {
                        await passwordInput.fill('relaxing41!');
                        await sleep(1000);
                        await googlePage.click('button:has-text("Next")');
                        await sleep(5000);
                        await saveScreenshot(googlePage, 'step6-google-password-entered');
                    }
                }
            }
        } else {
            // Standard login flow
            console.log('No Google option found. Using standard login flow...');

            // Enter email/username
            const emailInputSelectors = [
                'input[name="text"]',
                'input[autocomplete="username"]',
                'input[type="text"]'
            ];

            for (const selector of emailInputSelectors) {
                try {
                    const input = await page.$(selector);
                    if (input && await input.isVisible()) {
                        await input.fill('relentlessrobotics@gmail.com');
                        console.log('Email entered');
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }

            await sleep(1000);
            await saveScreenshot(page, 'step3-email-entered');

            // Click Next
            const nextSelectors = [
                'text=Next',
                '[role="button"]:has-text("Next")',
                'button:has-text("Next")',
                'div[role="button"]:has-text("Next")'
            ];

            for (const selector of nextSelectors) {
                try {
                    const btn = await page.$(selector);
                    if (btn && await btn.isVisible()) {
                        await btn.click();
                        console.log('Clicked Next');
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }

            await sleep(3000);
            await saveScreenshot(page, 'step4-after-email-next');

            // Look for "Forgot password?" link
            console.log('Looking for Forgot password option...');
            const forgotSelectors = [
                'text=Forgot password?',
                'a:has-text("Forgot password")',
                'span:has-text("Forgot password")',
                '[href*="password_reset"]'
            ];

            let forgotFound = false;
            for (const selector of forgotSelectors) {
                try {
                    const element = await page.$(selector);
                    if (element && await element.isVisible()) {
                        await element.click();
                        forgotFound = true;
                        console.log('Clicked Forgot password');
                        break;
                    }
                } catch (e) {
                    // Continue
                }
            }

            if (forgotFound) {
                await sleep(3000);
                await saveScreenshot(page, 'step5-forgot-password');
                console.log('PASSWORD RESET: User will need to check their email for reset link');
            }
        }

        // Wait and take final screenshot
        await sleep(5000);
        await saveScreenshot(page, 'final-state');

        console.log('\n=== CURRENT STATE ===');
        console.log('URL:', page.url());
        console.log('Please check screenshots folder for current state');
        console.log('Browser will stay open for 60 seconds for manual intervention if needed...');

        await sleep(60000);

    } catch (error) {
        console.error('Error:', error.message);
        await saveScreenshot(page, 'error-state');
    } finally {
        await browser.close();
    }
}

main();
