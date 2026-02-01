const { chromium } = require('playwright');

async function tryVoiceURLs() {
    console.log("[STATUS] Starting browser with fresh context...");

    const browser = await chromium.launch({
        headless: false,
        slowMo: 50,
        args: ['--start-maximized']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // Sign in first
        console.log("[STEP 1] Signing in to Google...");
        await page.goto('https://accounts.google.com/signin?continue=https://voice.google.com', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        const emailInput = await page.$('input[type="email"]');
        if (emailInput) {
            await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
            await page.click('#identifierNext');
            await page.waitForTimeout(3000);

            const pwdField = await page.$('input[type="password"]');
            if (pwdField) {
                await page.fill('input[type="password"]', 'Relaxing41!');
                await page.click('#passwordNext');
                await page.waitForTimeout(5000);
            }
        }

        await page.screenshot({ path: './screenshots/direct_01_after_login.png', fullPage: true });
        console.log("[STATUS] Login complete. Current URL: " + page.url());

        // Try different Google Voice URLs
        const voiceURLs = [
            'https://voice.google.com/calls',
            'https://voice.google.com/u/0/calls',
            'https://voice.google.com/u/0',
            'https://voice.google.com/?pli=1',
            'https://voice.google.com/signup',
            'https://voice.google.com/u/0/signup',
            'https://voice.google.com/u/0/voicemail',
            'https://www.google.com/voice',
        ];

        for (let i = 0; i < voiceURLs.length; i++) {
            const url = voiceURLs[i];
            console.log(`[TRYING] URL ${i+1}/${voiceURLs.length}: ${url}`);

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
            await page.waitForTimeout(2000);

            const currentUrl = page.url();
            const pageContent = await page.textContent('body').catch(() => '');

            console.log("[RESULT] Landed on: " + currentUrl);

            // Screenshot
            await page.screenshot({ path: `./screenshots/direct_url_${i+1}.png`, fullPage: true });

            // Check if we found the personal Voice interface
            if (currentUrl.includes('voice.google.com/u/0/calls') ||
                currentUrl.includes('voice.google.com/u/0/messages') ||
                currentUrl.includes('voice.google.com/u/0/voicemail')) {
                console.log("[SUCCESS] Found personal Voice web interface!");

                // Check for setup wizard
                if (pageContent.includes('Get a Google Voice') || pageContent.includes('Choose') || pageContent.includes('Select a phone number')) {
                    console.log("[STATUS] Setup wizard detected!");
                }

                break;
            }

            // Check if redirected to Workspace
            if (currentUrl.includes('workspace.google.com')) {
                console.log("[INFO] Redirected to Workspace page - trying next URL...");
                continue;
            }

            // Check for setup prompt
            if (pageContent.includes('Get started') && !currentUrl.includes('workspace')) {
                console.log("[STATUS] Found setup option!");

                const getStartedBtn = await page.$('button:has-text("Get started")');
                if (getStartedBtn) {
                    await getStartedBtn.click();
                    await page.waitForTimeout(3000);
                }
            }
        }

        // Final check of state
        await page.screenshot({ path: './screenshots/direct_final_state.png', fullPage: true });
        console.log("[FINAL] Current URL: " + page.url());

        // Check for Voice elements
        const voiceIndicators = ['Calls', 'Messages', 'Voicemail', 'Contacts'];
        const hasVoiceUI = await page.evaluate((indicators) => {
            const bodyText = document.body.innerText;
            return indicators.filter(i => bodyText.includes(i));
        }, voiceIndicators);

        if (hasVoiceUI.length >= 2) {
            console.log("[SUCCESS] Voice interface detected with: " + hasVoiceUI.join(', '));

            // Look for existing number or setup
            const existingNumber = await page.$eval('[data-phonenumber]', el => el.getAttribute('data-phonenumber')).catch(() => null);
            if (existingNumber) {
                console.log("[INFO] Existing number found: " + existingNumber);
            }
        }

        // Keep browser open
        console.log("[STATUS] Keeping browser open for 5 minutes for manual interaction...");
        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("[ERROR] " + error.message);
        await page.screenshot({ path: './screenshots/direct_error.png', fullPage: true });
        await page.waitForTimeout(60000);
    } finally {
        await browser.close();
    }
}

tryVoiceURLs();
