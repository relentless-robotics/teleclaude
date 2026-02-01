const { chromium } = require('playwright');

async function createGumroadAccount() {
    const browser = await chromium.launch({
        headless: false,
        slowMo: 500
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // Use a stronger password that's not in breach databases
    const newPassword = 'GumRd#2026$Secure!';

    try {
        console.log('PROGRESS: Navigating to Gumroad signup...');
        await page.goto('https://gumroad.com/signup', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'gumroad_v2_1_signup.png' });
        console.log('PROGRESS: On signup page');

        // Look for email and password fields
        const emailSelectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[placeholder*="email"]',
            '#email',
            'input[id*="email"]'
        ];

        const passwordSelectors = [
            'input[type="password"]',
            'input[name="password"]',
            'input[placeholder*="password"]',
            '#password',
            'input[id*="password"]'
        ];

        // Fill email
        for (const selector of emailSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.fill('relentlessrobotics@gmail.com');
                    console.log('PROGRESS: Filled email field');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        // Fill password with new secure password
        for (const selector of passwordSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.fill(newPassword);
                    console.log('PROGRESS: Filled password field with secure password');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        await page.screenshot({ path: 'gumroad_v2_2_filled.png' });

        // Look for submit button
        const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:has-text("Sign up")',
            'button:has-text("Create")',
            'button:has-text("Continue")',
            'button:has-text("Start")'
        ];

        for (const selector of submitSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.click();
                    console.log(`PROGRESS: Clicked submit button: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        // Wait for response
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'gumroad_v2_3_after_submit.png' });

        // Check current URL and page content
        const currentUrl = page.url();
        console.log(`PROGRESS: Current URL: ${currentUrl}`);

        const pageContent = await page.content();

        // Check for various outcomes
        if (currentUrl.includes('dashboard') || currentUrl.includes('home') || currentUrl.includes('settings') || currentUrl.includes('onboarding')) {
            console.log('SUCCESS: Account created! Reached dashboard/onboarding.');
            await page.screenshot({ path: 'gumroad_v2_success.png' });
        } else if (pageContent.includes('verify') || pageContent.includes('confirmation') || pageContent.includes('check your email')) {
            console.log('PROGRESS: Email verification required. Check inbox.');
        } else if (pageContent.includes('already') || pageContent.includes('exists') || pageContent.includes('taken')) {
            console.log('PROGRESS: Account already exists with this email. Attempting login...');
            await page.goto('https://gumroad.com/login', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(2000);

            // Try login with original password first
            for (const selector of emailSelectors) {
                try {
                    const element = await page.$(selector);
                    if (element) {
                        await element.fill('relentlessrobotics@gmail.com');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            for (const selector of passwordSelectors) {
                try {
                    const element = await page.$(selector);
                    if (element) {
                        await element.fill('Relaxing41!');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            for (const selector of submitSelectors) {
                try {
                    const element = await page.$(selector);
                    if (element) {
                        await element.click();
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            await page.waitForTimeout(5000);
            await page.screenshot({ path: 'gumroad_v2_login_attempt.png' });
            console.log(`PROGRESS: After login attempt, URL: ${page.url()}`);
        }

        // Wait longer to see results and handle any redirects
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'gumroad_v2_final.png' });
        console.log(`PROGRESS: Final URL: ${page.url()}`);

        // Output new password for user
        console.log(`NEW_PASSWORD: ${newPassword}`);

        // Keep browser open for inspection
        console.log('PROGRESS: Keeping browser open for 30 seconds...');
        await page.waitForTimeout(30000);

    } catch (error) {
        console.error('ERROR:', error.message);
        await page.screenshot({ path: 'gumroad_v2_error.png' });
    } finally {
        await browser.close();
        console.log('PROGRESS: Browser closed');
    }
}

createGumroadAccount();
