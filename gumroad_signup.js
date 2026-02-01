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

    try {
        console.log('PROGRESS: Navigating to Gumroad...');
        await page.goto('https://gumroad.com', { waitUntil: 'networkidle', timeout: 30000 });
        await page.screenshot({ path: 'gumroad_1_homepage.png' });
        console.log('PROGRESS: Loaded Gumroad homepage');

        // Wait a moment and look for sign up button
        await page.waitForTimeout(2000);

        // Try to find and click sign up or start selling button
        const signUpSelectors = [
            'text=Sign up',
            'text=Start selling',
            'text=Get started',
            'text=Create account',
            'a[href*="signup"]',
            'a[href*="register"]',
            'button:has-text("Sign up")',
            'button:has-text("Start")'
        ];

        let clicked = false;
        for (const selector of signUpSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.click();
                    clicked = true;
                    console.log(`PROGRESS: Clicked signup using selector: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!clicked) {
            // Try navigating directly to signup page
            console.log('PROGRESS: Trying direct navigation to signup page...');
            await page.goto('https://gumroad.com/signup', { waitUntil: 'networkidle', timeout: 30000 });
        }

        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'gumroad_2_signup_page.png' });
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

        // Fill password
        for (const selector of passwordSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.fill('Relaxing41!');
                    console.log('PROGRESS: Filled password field');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        await page.screenshot({ path: 'gumroad_3_filled_form.png' });

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
        await page.screenshot({ path: 'gumroad_4_after_submit.png' });

        // Check current URL and page content
        const currentUrl = page.url();
        console.log(`PROGRESS: Current URL: ${currentUrl}`);

        // Get page content for analysis
        const pageContent = await page.content();

        // Check for common outcomes
        if (currentUrl.includes('dashboard') || currentUrl.includes('home') || currentUrl.includes('settings')) {
            console.log('SUCCESS: Account appears to be created! On dashboard.');
        } else if (pageContent.includes('verify') || pageContent.includes('confirmation') || pageContent.includes('check your email')) {
            console.log('PROGRESS: Email verification may be required. Check inbox.');
        } else if (pageContent.includes('already') || pageContent.includes('exists') || pageContent.includes('taken')) {
            console.log('PROGRESS: Account may already exist. Trying to log in instead...');
            // Try logging in
            await page.goto('https://gumroad.com/login', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(2000);

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
            await page.screenshot({ path: 'gumroad_5_login_attempt.png' });
        }

        // Take final screenshot
        await page.screenshot({ path: 'gumroad_final.png' });
        console.log('PROGRESS: Final screenshot saved');

        // Keep browser open for manual inspection
        console.log('PROGRESS: Keeping browser open for 30 seconds...');
        await page.waitForTimeout(30000);

    } catch (error) {
        console.error('ERROR:', error.message);
        await page.screenshot({ path: 'gumroad_error.png' });
    } finally {
        await browser.close();
        console.log('PROGRESS: Browser closed');
    }
}

createGumroadAccount();
