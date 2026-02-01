const { chromium } = require('playwright');

async function createPinterestAccount() {
    const browser = await chromium.launch({
        headless: false,
        slowMo: 500 // Slow down actions to avoid detection
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    try {
        console.log('PROGRESS: Navigating to Pinterest.com...');
        await page.goto('https://www.pinterest.com', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);

        // Look for sign up button
        console.log('PROGRESS: Looking for Sign Up button...');

        // Try different selectors for signup
        const signupSelectors = [
            'button:has-text("Sign up")',
            '[data-test-id="simple-signup-button"]',
            'a:has-text("Sign up")',
            'text=Sign up'
        ];

        let signupClicked = false;
        for (const selector of signupSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 5000 });
                if (element) {
                    await element.click();
                    signupClicked = true;
                    console.log('PROGRESS: Clicked Sign Up button');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!signupClicked) {
            // Maybe we're already on a signup form or need to click a different element
            console.log('PROGRESS: Trying alternative signup approach...');
            await page.goto('https://www.pinterest.com/signup/', { waitUntil: 'networkidle', timeout: 60000 });
        }

        await page.waitForTimeout(2000);

        // Check if there's a "Continue with email" option (vs Google/Facebook)
        console.log('PROGRESS: Looking for email signup option...');
        const emailSignupSelectors = [
            'button:has-text("Continue with email")',
            'text=Continue with email',
            '[data-test-id="emailContinueButton"]'
        ];

        for (const selector of emailSignupSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 3000 });
                if (element) {
                    await element.click();
                    console.log('PROGRESS: Selected email signup option');
                    await page.waitForTimeout(1000);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        // Fill in the email
        console.log('PROGRESS: Entering email address...');
        const emailSelectors = [
            'input[name="id"]',
            'input[type="email"]',
            'input[placeholder*="Email"]',
            '#email',
            '[data-test-id="emailInputField"]'
        ];

        let emailFilled = false;
        for (const selector of emailSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 3000 });
                if (element) {
                    await element.fill('relentlessrobotics@gmail.com');
                    emailFilled = true;
                    console.log('PROGRESS: Email entered');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!emailFilled) {
            console.log('ERROR: Could not find email field');
            await page.screenshot({ path: 'pinterest_email_error.png' });
        }

        await page.waitForTimeout(1000);

        // Fill in the password
        console.log('PROGRESS: Entering password...');
        const passwordSelectors = [
            'input[name="password"]',
            'input[type="password"]',
            '#password',
            '[data-test-id="passwordInputField"]'
        ];

        let passwordFilled = false;
        for (const selector of passwordSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 3000 });
                if (element) {
                    await element.fill('Pinterest@Robotics2026!');
                    passwordFilled = true;
                    console.log('PROGRESS: Password entered');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        await page.waitForTimeout(1000);

        // Fill birthdate - Pinterest usually has separate fields
        console.log('PROGRESS: Entering birthdate...');

        // Try to find and fill date of birth fields
        const monthSelectors = ['select[name="month"]', '#month', '[data-test-id="month"]'];
        const daySelectors = ['select[name="day"]', '#day', '[data-test-id="day"]'];
        const yearSelectors = ['select[name="year"]', '#year', '[data-test-id="year"]'];

        // Month
        for (const selector of monthSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 2000 });
                if (element) {
                    await element.selectOption({ label: 'January' });
                    console.log('PROGRESS: Selected birth month');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        // Day
        for (const selector of daySelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 2000 });
                if (element) {
                    await element.selectOption('15');
                    console.log('PROGRESS: Selected birth day');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        // Year
        for (const selector of yearSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 2000 });
                if (element) {
                    await element.selectOption('2000');
                    console.log('PROGRESS: Selected birth year');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        await page.waitForTimeout(1000);

        // Take screenshot before submitting
        await page.screenshot({ path: 'pinterest_before_submit.png' });
        console.log('PROGRESS: Screenshot saved before submission');

        // Look for Continue/Submit/Sign up button
        console.log('PROGRESS: Looking for submit button...');
        const submitSelectors = [
            'button:has-text("Continue")',
            'button:has-text("Sign up")',
            'button[type="submit"]',
            '[data-test-id="registerFormSubmitButton"]'
        ];

        for (const selector of submitSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 3000 });
                if (element) {
                    await element.click();
                    console.log('PROGRESS: Clicked submit button');
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        // Wait for page response
        await page.waitForTimeout(5000);

        // Take screenshot of result
        await page.screenshot({ path: 'pinterest_result.png' });
        console.log('PROGRESS: Screenshot saved of result');

        // Check for common outcomes
        const pageContent = await page.content();

        if (pageContent.includes('already has an account') || pageContent.includes('already registered')) {
            console.log('RESULT: Account already exists for this email. Trying to log in instead...');

            // Try to navigate to login
            await page.goto('https://www.pinterest.com/login/', { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForTimeout(2000);

            // Fill login credentials
            for (const selector of emailSelectors) {
                try {
                    const element = await page.waitForSelector(selector, { timeout: 3000 });
                    if (element) {
                        await element.fill('relentlessrobotics@gmail.com');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            await page.waitForTimeout(500);

            for (const selector of passwordSelectors) {
                try {
                    const element = await page.waitForSelector(selector, { timeout: 3000 });
                    if (element) {
                        await element.fill('Pinterest@Robotics2026!');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            await page.waitForTimeout(500);

            // Click login button
            const loginSelectors = [
                'button:has-text("Log in")',
                'button[type="submit"]',
                '[data-test-id="registerFormSubmitButton"]'
            ];

            for (const selector of loginSelectors) {
                try {
                    const element = await page.waitForSelector(selector, { timeout: 3000 });
                    if (element) {
                        await element.click();
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            await page.waitForTimeout(5000);
            await page.screenshot({ path: 'pinterest_login_result.png' });
        }

        if (pageContent.includes('verify') || pageContent.includes('verification') || pageContent.includes('confirm')) {
            console.log('RESULT: Email verification may be required. Please check your email inbox.');
        }

        // Try to get current URL (which might include profile info)
        const currentUrl = page.url();
        console.log('RESULT: Current URL: ' + currentUrl);

        // Keep browser open for 30 seconds to allow manual intervention if needed
        console.log('PROGRESS: Keeping browser open for 30 seconds for any manual steps...');
        await page.waitForTimeout(30000);

        console.log('COMPLETE: Browser automation finished');

    } catch (error) {
        console.log('ERROR: ' + error.message);
        await page.screenshot({ path: 'pinterest_error.png' });
    } finally {
        await browser.close();
    }
}

createPinterestAccount();
