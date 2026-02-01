const { chromium } = require('playwright');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function typeSlowly(element, text) {
    for (const char of text) {
        await element.type(char, { delay: 50 + Math.random() * 100 });
        await sleep(30 + Math.random() * 70);
    }
}

(async () => {
    console.log('DISCORD_UPDATE: Launching browser to LOG IN with alternate password...');

    const userDataDir = './twitter-browser-data';

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        slowMo: 300,
        viewport: { width: 1366, height: 768 },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox'
        ]
    });

    const page = browser.pages()[0] || await browser.newPage();

    try {
        console.log('DISCORD_UPDATE: Navigating to X.com login page...');
        await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(4000);

        // Enter email/username
        const usernameInput = await page.$('input[autocomplete="username"]');
        if (usernameInput) {
            console.log('DISCORD_UPDATE: Entering email: relentlessrobotics@gmail.com');
            await usernameInput.click();
            await sleep(500);
            await typeSlowly(usernameInput, 'relentlessrobotics@gmail.com');
            await sleep(1500);

            // Click Next
            const nextBtn = await page.$('[role="button"]:has-text("Next")');
            if (nextBtn) {
                console.log('DISCORD_UPDATE: Clicking Next...');
                await nextBtn.click();
                await sleep(4000);
            }
        }

        // Try with alternate password (default from profile)
        const passwordInput = await page.$('input[name="password"]');
        if (passwordInput) {
            console.log('DISCORD_UPDATE: Trying alternate password: Relaxing41!');
            await passwordInput.click();
            await sleep(500);
            await typeSlowly(passwordInput, 'Relaxing41!');
            await sleep(1000);

            // Click Log in
            const loginBtn = await page.$('[data-testid="LoginForm_Login_Button"]');
            if (loginBtn) {
                console.log('DISCORD_UPDATE: Clicking Log in button...');
                await loginBtn.click();
                await sleep(5000);
            }

            await page.screenshot({ path: 'twitter_login_attempt2.png' });
            console.log('DISCORD_UPDATE: Current URL after login: ' + page.url());

            // Check for error message
            const errorMsg = await page.$('text=Wrong password');
            if (errorMsg) {
                console.log('DISCORD_UPDATE: Wrong password - Relaxing41! does not work');
            }

            // Check if logged in
            if (page.url().includes('/home') || page.url() === 'https://x.com/') {
                console.log('DISCORD_UPDATE: SUCCESS! Logged in with Relaxing41!');
                await page.screenshot({ path: 'twitter_logged_in.png' });

                // Navigate to profile to get username
                await page.goto('https://x.com/settings/your_twitter_data/account', { waitUntil: 'domcontentloaded' });
                await sleep(3000);
                await page.screenshot({ path: 'twitter_account_info.png' });
            } else {
                // Maybe we need to verify something
                const visibleText = await page.$$eval('h1, h2, span', els =>
                    els.filter(e => e.offsetParent !== null && e.textContent?.trim())
                       .map(e => e.textContent?.trim())
                       .filter(t => t && t.length > 2 && t.length < 200)
                );
                console.log('DISCORD_UPDATE: Current screen: ' + JSON.stringify([...new Set(visibleText)].slice(0, 25)));

                // Check for verification challenge
                if (visibleText.some(t => t.includes('verify') || t.includes('Verify') || t.includes('code'))) {
                    console.log('DISCORD_UPDATE: VERIFICATION REQUIRED');
                }
            }
        }

        console.log('DISCORD_UPDATE: Final URL: ' + page.url());
        await page.screenshot({ path: 'twitter_final.png' });

        console.log('DISCORD_UPDATE: Browser will stay open for 120 seconds...');
        await sleep(120000);

    } catch (error) {
        console.error('DISCORD_UPDATE: ERROR - ' + error.message);
        await page.screenshot({ path: 'twitter_error.png' });
    } finally {
        await browser.close();
        console.log('DISCORD_UPDATE: Browser closed');
    }
})();
