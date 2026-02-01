const { chromium } = require('playwright');

async function main() {
    console.log('Launching browser...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 500
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('Navigating to console.anthropic.com...');
    await page.goto('https://console.anthropic.com');
    await page.waitForLoadState('networkidle');

    // Take a screenshot to see what we have
    await page.screenshot({ path: 'anthropic_step1.png' });
    console.log('Screenshot saved: anthropic_step1.png');
    console.log('Current URL:', page.url());

    // Look for login options
    const pageContent = await page.content();
    console.log('Page title:', await page.title());

    // Try to find and click email login option
    try {
        // Look for various possible email login buttons
        const emailButton = await page.locator('text=/continue with email|sign in with email|email/i').first();
        if (await emailButton.isVisible({ timeout: 5000 })) {
            console.log('Found email login option, clicking...');
            await emailButton.click();
            await page.waitForLoadState('networkidle');
        }
    } catch (e) {
        console.log('Looking for other login elements...');
    }

    await page.screenshot({ path: 'anthropic_step2.png' });
    console.log('Screenshot saved: anthropic_step2.png');

    // Try to find email input field
    try {
        const emailInput = await page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
        if (await emailInput.isVisible({ timeout: 5000 })) {
            console.log('Found email input, entering email...');
            await emailInput.fill('football2nick@gmail.com');
            await page.screenshot({ path: 'anthropic_step3.png' });
            console.log('Screenshot saved: anthropic_step3.png');

            // Look for submit/continue button
            const submitButton = await page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Send"), button:has-text("Submit")').first();
            if (await submitButton.isVisible({ timeout: 3000 })) {
                console.log('Clicking submit button...');
                await submitButton.click();
                await page.waitForTimeout(2000);
            }
        }
    } catch (e) {
        console.log('Error with email input:', e.message);
    }

    await page.screenshot({ path: 'anthropic_step4.png' });
    console.log('Screenshot saved: anthropic_step4.png');
    console.log('MAGIC_LINK_SENT');

    // Now wait for login to complete - poll for up to 5 minutes
    console.log('Waiting for magic link login to complete...');
    let loggedIn = false;
    const startTime = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

    while (!loggedIn && (Date.now() - startTime) < timeout) {
        await page.waitForTimeout(5000); // Check every 5 seconds

        // Check if we're on the dashboard/logged in
        const currentUrl = page.url();
        console.log('Checking login status... URL:', currentUrl);

        // Look for dashboard elements
        try {
            const dashboardIndicators = await page.locator('text=/dashboard|usage|api keys|workspaces|settings/i').first();
            if (await dashboardIndicators.isVisible({ timeout: 1000 })) {
                console.log('LOGIN_COMPLETE');
                loggedIn = true;
                break;
            }
        } catch (e) {
            // Continue polling
        }

        // Also check URL for dashboard path
        if (currentUrl.includes('/dashboard') || currentUrl.includes('/workspaces') || currentUrl.includes('/settings')) {
            console.log('LOGIN_COMPLETE');
            loggedIn = true;
            break;
        }
    }

    if (!loggedIn) {
        console.log('Login timeout - user may not have clicked magic link');
        await browser.close();
        return;
    }

    // Navigate to usage page
    console.log('Navigating to usage page...');
    await page.screenshot({ path: 'anthropic_logged_in.png' });

    // Try to find and click usage/billing link
    try {
        const usageLink = await page.locator('a:has-text("Usage"), a:has-text("Billing"), text=/usage|billing/i').first();
        if (await usageLink.isVisible({ timeout: 3000 })) {
            await usageLink.click();
            await page.waitForLoadState('networkidle');
        } else {
            // Try direct navigation
            await page.goto('https://console.anthropic.com/settings/usage');
            await page.waitForLoadState('networkidle');
        }
    } catch (e) {
        console.log('Navigating directly to usage page...');
        await page.goto('https://console.anthropic.com/settings/usage');
        await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'anthropic_usage.png' });
    console.log('Screenshot saved: anthropic_usage.png');

    // Extract usage data
    console.log('Extracting usage data...');
    const usageData = await page.evaluate(() => {
        const data = {};

        // Get all text content that might contain usage info
        const allText = document.body.innerText;
        data.pageText = allText;

        // Try to find specific elements
        const tables = document.querySelectorAll('table');
        data.tables = [];
        tables.forEach((table, i) => {
            data.tables.push(table.innerText);
        });

        // Look for cards or sections with numbers
        const cards = document.querySelectorAll('[class*="card"], [class*="metric"], [class*="stat"]');
        data.cards = [];
        cards.forEach((card) => {
            data.cards.push(card.innerText);
        });

        return data;
    });

    console.log('USAGE_DATA_START');
    console.log(JSON.stringify(usageData, null, 2));
    console.log('USAGE_DATA_END');

    // Also try the billing page
    try {
        await page.goto('https://console.anthropic.com/settings/billing');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'anthropic_billing.png' });

        const billingData = await page.evaluate(() => {
            return {
                pageText: document.body.innerText
            };
        });

        console.log('BILLING_DATA_START');
        console.log(JSON.stringify(billingData, null, 2));
        console.log('BILLING_DATA_END');
    } catch (e) {
        console.log('Could not get billing data:', e.message);
    }

    // Try rate limits page
    try {
        await page.goto('https://console.anthropic.com/settings/limits');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'anthropic_limits.png' });

        const limitsData = await page.evaluate(() => {
            return {
                pageText: document.body.innerText
            };
        });

        console.log('LIMITS_DATA_START');
        console.log(JSON.stringify(limitsData, null, 2));
        console.log('LIMITS_DATA_END');
    } catch (e) {
        console.log('Could not get limits data:', e.message);
    }

    console.log('SCRIPT_COMPLETE');
    await browser.close();
}

main().catch(console.error);
