const { chromium } = require('playwright');

async function main() {
    console.log('Launching browser...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 300
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Go to the console - should still be logged in
    console.log('Checking Cost page...');
    await page.goto('https://console.anthropic.com/settings/cost');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    let costData = await page.evaluate(() => document.body.innerText);
    console.log('COST_DATA_START');
    console.log(costData);
    console.log('COST_DATA_END');
    await page.screenshot({ path: 'cost_page.png' });

    // Get limits data
    console.log('Checking Limits page...');
    await page.goto('https://console.anthropic.com/settings/limits');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    let limitsData = await page.evaluate(() => document.body.innerText);
    console.log('LIMITS_DATA_START');
    console.log(limitsData);
    console.log('LIMITS_DATA_END');
    await page.screenshot({ path: 'limits_page.png' });

    // Get Settings/Billing page
    console.log('Checking Settings page...');
    await page.goto('https://console.anthropic.com/settings/organization');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    let settingsData = await page.evaluate(() => document.body.innerText);
    console.log('SETTINGS_DATA_START');
    console.log(settingsData);
    console.log('SETTINGS_DATA_END');
    await page.screenshot({ path: 'settings_page.png' });

    console.log('SCRIPT_COMPLETE');
    await browser.close();
}

main().catch(console.error);
