const { chromium } = require('playwright');

async function main() {
    console.log('Launching browser...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 300
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('Navigating to console.anthropic.com...');
    await page.goto('https://console.anthropic.com');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    console.log('Current URL:', page.url());
    console.log('Page title:', await page.title());
    await page.screenshot({ path: 'step1_initial.png' });

    // Click on "Continue with email" button
    try {
        console.log('Looking for "Continue with email" button...');
        const emailButton = await page.getByRole('button', { name: /continue with email/i });
        if (await emailButton.isVisible({ timeout: 5000 })) {
            console.log('Clicking "Continue with email"...');
            await emailButton.click();
            await page.waitForTimeout(2000);
            await page.screenshot({ path: 'step2_email_form.png' });
        }
    } catch (e) {
        console.log('Could not find continue with email button, looking for alternatives...');
        // Try other selectors
        const altButton = await page.locator('button:has-text("email")').first();
        if (await altButton.isVisible({ timeout: 3000 })) {
            await altButton.click();
            await page.waitForTimeout(2000);
        }
    }

    // Find and fill email input
    console.log('Looking for email input field...');
    await page.screenshot({ path: 'step2b_before_email.png' });

    // Try multiple selectors for email input
    let emailFilled = false;
    const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[placeholder*="email" i]',
        'input[autocomplete="email"]',
        '#email',
        'input'
    ];

    for (const selector of emailSelectors) {
        try {
            const emailInput = await page.locator(selector).first();
            if (await emailInput.isVisible({ timeout: 2000 })) {
                console.log(`Found email input with selector: ${selector}`);
                await emailInput.click();
                await emailInput.fill('football2nick@gmail.com');
                emailFilled = true;
                await page.screenshot({ path: 'step3_email_filled.png' });
                break;
            }
        } catch (e) {
            continue;
        }
    }

    if (!emailFilled) {
        console.log('Could not find email input field!');
        const content = await page.content();
        console.log('Page HTML snippet:', content.substring(0, 2000));
    }

    // Click submit/continue button
    console.log('Looking for submit button...');
    await page.waitForTimeout(1000);

    const submitSelectors = [
        'button[type="submit"]',
        'button:has-text("Continue")',
        'button:has-text("Send")',
        'button:has-text("Sign in")',
        'button:has-text("Submit")',
        'input[type="submit"]'
    ];

    for (const selector of submitSelectors) {
        try {
            const submitBtn = await page.locator(selector).first();
            if (await submitBtn.isVisible({ timeout: 2000 })) {
                console.log(`Found submit button with selector: ${selector}`);
                await submitBtn.click();
                await page.waitForTimeout(3000);
                await page.screenshot({ path: 'step4_after_submit.png' });
                console.log('MAGIC_LINK_SENT');
                break;
            }
        } catch (e) {
            continue;
        }
    }

    console.log('Current URL after submit:', page.url());
    console.log('Page content after submit...');
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('Page text (first 500 chars):', pageText.substring(0, 500));

    // Signal that we're waiting for magic link
    console.log('WAITING_FOR_MAGIC_LINK');

    // Wait for login to complete - poll for up to 10 minutes
    console.log('Polling for login completion...');
    let loggedIn = false;
    const startTime = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes
    let lastUrl = '';

    while (!loggedIn && (Date.now() - startTime) < timeout) {
        await page.waitForTimeout(5000); // Check every 5 seconds

        const currentUrl = page.url();
        if (currentUrl !== lastUrl) {
            console.log('URL changed to:', currentUrl);
            lastUrl = currentUrl;
            await page.screenshot({ path: 'step5_checking.png' });
        }

        // Check if we're no longer on login page
        const isLoginPage = currentUrl.includes('/login') ||
                           currentUrl.includes('signin') ||
                           currentUrl.includes('sign-in');

        if (!isLoginPage && (currentUrl.includes('console') || currentUrl.includes('platform.claude.com'))) {
            // Double-check by looking for dashboard elements
            try {
                const dashboardElements = await page.locator('[class*="dashboard"], [class*="sidebar"], nav, [class*="workspace"]').first();
                if (await dashboardElements.isVisible({ timeout: 2000 })) {
                    console.log('LOGIN_COMPLETE');
                    loggedIn = true;
                    break;
                }
            } catch (e) {
                // Check page content for logged-in indicators
                const bodyText = await page.evaluate(() => document.body.innerText);
                if (bodyText.includes('API Keys') ||
                    bodyText.includes('Workspaces') ||
                    bodyText.includes('Usage') ||
                    bodyText.includes('Settings') ||
                    bodyText.includes('Welcome')) {
                    console.log('LOGIN_COMPLETE');
                    loggedIn = true;
                    break;
                }
            }
        }

        // Check every 30 seconds for status update
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed % 30 === 0) {
            console.log(`Still waiting for magic link... (${elapsed}s elapsed)`);
        }
    }

    if (!loggedIn) {
        console.log('LOGIN_TIMEOUT');
        await page.screenshot({ path: 'step_timeout.png' });
        await browser.close();
        return;
    }

    // We're logged in! Now get usage data
    console.log('Successfully logged in! Fetching usage data...');
    await page.screenshot({ path: 'step6_logged_in.png' });
    await page.waitForTimeout(2000);

    // Try to navigate to usage page
    const usageUrls = [
        'https://console.anthropic.com/settings/usage',
        'https://platform.claude.com/settings/usage',
        'https://console.anthropic.com/settings/billing',
        'https://platform.claude.com/settings/billing'
    ];

    for (const url of usageUrls) {
        try {
            console.log(`Trying to navigate to: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 });
            await page.waitForTimeout(3000);

            const pageText = await page.evaluate(() => document.body.innerText);
            if (!pageText.includes('Sign in') && !pageText.includes('Continue with email')) {
                console.log('Found valid page at:', url);
                await page.screenshot({ path: `usage_page_${url.split('/').pop()}.png` });

                console.log('USAGE_DATA_START');
                console.log(pageText);
                console.log('USAGE_DATA_END');
                break;
            }
        } catch (e) {
            console.log(`Could not access ${url}:`, e.message);
        }
    }

    // Also try clicking on settings/usage links if available
    try {
        const settingsLink = await page.locator('a:has-text("Settings"), button:has-text("Settings")').first();
        if (await settingsLink.isVisible({ timeout: 3000 })) {
            await settingsLink.click();
            await page.waitForTimeout(2000);
            await page.screenshot({ path: 'settings_page.png' });
        }
    } catch (e) {
        console.log('Could not find settings link');
    }

    // Get current page data
    console.log('FINAL_PAGE_DATA_START');
    const finalData = await page.evaluate(() => {
        return {
            url: window.location.href,
            title: document.title,
            text: document.body.innerText
        };
    });
    console.log(JSON.stringify(finalData, null, 2));
    console.log('FINAL_PAGE_DATA_END');

    console.log('SCRIPT_COMPLETE');

    // Keep browser open for a bit so user can see
    await page.waitForTimeout(5000);
    await browser.close();
}

main().catch(console.error);
