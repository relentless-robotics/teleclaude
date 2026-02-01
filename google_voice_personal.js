const { chromium } = require('playwright');

async function setupGoogleVoice() {
    console.log("[STATUS] Starting browser...");

    const browser = await chromium.launch({
        headless: false,
        slowMo: 100,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // Step 1: Go to Google Account sign-in first
        console.log("[STATUS] Going to Google accounts to sign in first...");
        await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: './screenshots/p01_signin_page.png', fullPage: true });
        console.log("[SCREENSHOT] p01_signin_page.png");

        // Enter email
        console.log("[STATUS] Entering email...");
        await page.waitForSelector('input[type="email"]', { timeout: 30000 });
        await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
        await page.waitForTimeout(500);
        await page.screenshot({ path: './screenshots/p02_email_entered.png' });
        console.log("[SCREENSHOT] p02_email_entered.png");

        // Click Next button
        console.log("[STATUS] Clicking Next...");
        await page.click('#identifierNext');
        await page.waitForTimeout(4000);
        await page.screenshot({ path: './screenshots/p03_after_email.png' });
        console.log("[SCREENSHOT] p03_after_email.png");

        // Enter password
        console.log("[STATUS] Waiting for password field...");
        try {
            await page.waitForSelector('input[type="password"]', { timeout: 15000 });
            console.log("[STATUS] Entering password...");
            await page.fill('input[type="password"]', 'Relaxing41!');
            await page.waitForTimeout(500);
            await page.screenshot({ path: './screenshots/p04_password_entered.png' });
            console.log("[SCREENSHOT] p04_password_entered.png");

            await page.click('#passwordNext');
            await page.waitForTimeout(6000);
            await page.screenshot({ path: './screenshots/p05_after_password.png' });
            console.log("[SCREENSHOT] p05_after_password.png");
        } catch (e) {
            console.log("[WARNING] " + e.message);
            await page.screenshot({ path: './screenshots/p05_error_state.png' });
        }

        // Check current state
        let currentUrl = page.url();
        let pageContent = await page.content();
        console.log("[STATUS] Current URL: " + currentUrl);

        // Handle 2FA if present
        if (pageContent.includes('2-Step') || pageContent.includes('Verify') || pageContent.includes('confirm')) {
            console.log("[2FA] Two-factor authentication required!");
            console.log("[2FA] Please tap 'Yes' on your phone to approve the sign-in.");
            await page.screenshot({ path: './screenshots/p06_2fa.png' });

            // Wait for 2FA approval (up to 90 seconds)
            for (let i = 0; i < 18; i++) {
                await page.waitForTimeout(5000);
                currentUrl = page.url();
                pageContent = await page.content();

                if (!pageContent.includes('2-Step') && !pageContent.includes('Verify it')) {
                    console.log("[2FA] Approved! Continuing...");
                    break;
                }
                if (i === 6) {
                    console.log("[WAITING] Still waiting for 2FA... (30s elapsed)");
                }
                if (i === 12) {
                    console.log("[WAITING] Still waiting for 2FA... (60s elapsed)");
                }
            }
            await page.screenshot({ path: './screenshots/p07_after_2fa.png' });
        }

        // Now navigate to Google Voice personal
        console.log("[STATUS] Navigating to Google Voice...");
        await page.goto('https://voice.google.com/u/0/about', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/p08_voice_about.png', fullPage: true });
        console.log("[SCREENSHOT] p08_voice_about.png");

        // Look for "For personal use" link or sign in
        pageContent = await page.content();

        // Try to find personal use option
        const personalUse = await page.$('text=For personal use');
        if (personalUse) {
            console.log("[STATUS] Found 'For personal use' option, clicking...");
            await personalUse.click();
            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/p09_personal_use.png' });
        }

        // Go directly to voice setup
        console.log("[STATUS] Going to Voice setup page...");
        await page.goto('https://voice.google.com/u/0/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/p10_signup.png', fullPage: true });
        console.log("[SCREENSHOT] p10_signup.png");

        // Try different Voice URLs
        console.log("[STATUS] Checking Voice messages/main page...");
        await page.goto('https://voice.google.com/u/0/messages', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/p11_messages.png', fullPage: true });
        console.log("[SCREENSHOT] p11_messages.png");

        pageContent = await page.content();
        currentUrl = page.url();

        // Check if already have Voice number or need to set one up
        if (pageContent.includes('Get a Google Voice number') || pageContent.includes('Choose') || pageContent.includes('Select a phone number')) {
            console.log("[STATUS] Setup screen detected! Looking for number selection...");

            // Try to find search box or number list
            const searchInput = await page.$('input');
            if (searchInput) {
                console.log("[STATUS] Found search, entering city...");
                await searchInput.fill('Miami');
                await page.keyboard.press('Enter');
                await page.waitForTimeout(3000);
            }
        }

        await page.screenshot({ path: './screenshots/p12_current_state.png', fullPage: true });
        console.log("[SCREENSHOT] p12_current_state.png");

        // Try to click on "Web" tab if available (personal voice)
        const webTab = await page.$('a[href*="/u/0"]') || await page.$('text=Voice');
        if (webTab) {
            await webTab.click().catch(() => {});
            await page.waitForTimeout(2000);
        }

        // Final check on state
        console.log("[STATUS] Taking final screenshot of current state...");
        await page.screenshot({ path: './screenshots/p13_final_state.png', fullPage: true });
        console.log("[SCREENSHOT] p13_final_state.png");

        currentUrl = page.url();
        pageContent = await page.content();
        console.log("[INFO] Final URL: " + currentUrl);

        if (pageContent.includes('calls') || pageContent.includes('messages') || pageContent.includes('voicemail')) {
            console.log("[SUCCESS] Google Voice appears to be set up and accessible!");
        } else if (pageContent.includes('isn\'t available') || pageContent.includes('not available')) {
            console.log("[INFO] Google Voice may not be available in your region.");
        }

        // Keep browser open for manual interaction
        console.log("[STATUS] Keeping browser open for 5 minutes for manual interaction...");
        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("[ERROR] " + error.message);
        await page.screenshot({ path: './screenshots/error_final.png', fullPage: true });
        await page.waitForTimeout(120000);
    } finally {
        await browser.close();
        console.log("[STATUS] Browser closed.");
    }
}

setupGoogleVoice().catch(err => console.log("[FATAL] " + err.message));
