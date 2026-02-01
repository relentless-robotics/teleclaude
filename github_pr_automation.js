const { chromium } = require('playwright');

async function openGitHubForManualFork() {
    const browser = await chromium.launch({
        headless: false,
        slowMo: 500
    });

    try {
        const context = await browser.newContext();
        const page = await context.newPage();

        console.log('\n=== MANUAL GITHUB WORKFLOW ===\n');
        console.log('Opening browser for you to:');
        console.log('1. Login to GitHub (relentless-robotics)');
        console.log('2. Fork nuclei-templates');
        console.log('3. Check if teleclaude-main is private\n');
        console.log('Browser will stay open for 5 minutes...\n');

        // Open login page
        await page.goto('https://github.com/login', { timeout: 60000 });

        // Fill in credentials
        await page.fill('input[name="login"]', 'relentless-robotics');
        await page.fill('input[name="password"]', 'Relentless@Robotics2026!');

        console.log('Credentials filled. Please:');
        console.log('1. Click "Sign in"');
        console.log('2. Complete 2FA if needed');
        console.log('3. Go to: https://github.com/projectdiscovery/nuclei-templates');
        console.log('4. Click "Fork" button');
        console.log('5. After fork is created, go to: https://github.com/relentless-robotics/teleclaude-main/settings');
        console.log('6. Make sure it is set to PRIVATE\n');

        // Keep browser open for 5 minutes
        await page.waitForTimeout(300000);

        console.log('\nClosing browser...');
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await browser.close();
    }
}

openGitHubForManualFork();
