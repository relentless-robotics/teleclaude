const { chromium } = require('playwright');

async function setupGoogleVoice() {
    console.log("[STATUS] Starting browser...");

    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // Step 1: Go to Google Voice
        console.log("[STATUS] Navigating to Google Voice...");
        await page.goto('https://voice.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/01_initial_page.png', fullPage: true });
        console.log("[SCREENSHOT] 01_initial_page.png saved");

        // Check URL - might redirect to sign-in
        let currentUrl = page.url();
        console.log(`[STATUS] Current URL: ${currentUrl}`);

        // If we need to sign in
        if (currentUrl.includes('accounts.google.com') || await page.$('input[type="email"]')) {
            console.log("[STATUS] Login required. Entering email...");

            // Wait for email input
            await page.waitForSelector('input[type="email"]', { timeout: 30000 });
            await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
            await page.screenshot({ path: './screenshots/02_email_entered.png' });
            console.log("[SCREENSHOT] 02_email_entered.png saved");

            // Click Next
            await page.waitForTimeout(500);
            await page.click('#identifierNext');
            await page.waitForTimeout(4000);
            await page.screenshot({ path: './screenshots/03_after_email_next.png' });
            console.log("[SCREENSHOT] 03_after_email_next.png saved");

            // Check for password field
            try {
                await page.waitForSelector('input[type="password"]', { timeout: 15000 });
                console.log("[STATUS] Entering password...");
                await page.fill('input[type="password"]', 'Relaxing41!');
                await page.screenshot({ path: './screenshots/04_password_entered.png' });
                console.log("[SCREENSHOT] 04_password_entered.png saved");

                await page.waitForTimeout(500);
                await page.click('#passwordNext');
                await page.waitForTimeout(5000);
                await page.screenshot({ path: './screenshots/05_after_password.png' });
                console.log("[SCREENSHOT] 05_after_password.png saved");
            } catch (e) {
                console.log("[STATUS] Password field not found - checking for other screens");
                await page.screenshot({ path: './screenshots/05_unexpected_state.png' });
            }
        }

        // Check for 2FA
        currentUrl = page.url();
        const pageContent = await page.content();

        if (pageContent.includes('2-Step') || pageContent.includes('Verify it') || pageContent.includes('Confirm your identity')) {
            console.log("[2FA] 2-Step verification detected! User needs to tap Yes on phone.");
            console.log("[WAITING] Waiting 60 seconds for 2FA approval...");
            await page.screenshot({ path: './screenshots/06_2fa_prompt.png' });

            // Wait up to 90 seconds for 2FA
            for (let i = 0; i < 18; i++) {
                await page.waitForTimeout(5000);
                currentUrl = page.url();

                if (currentUrl.includes('voice.google.com') && !currentUrl.includes('accounts.google.com')) {
                    console.log("[STATUS] 2FA approved! Continuing...");
                    break;
                }

                const stillWaiting = await page.content();
                if (!stillWaiting.includes('2-Step') && !stillWaiting.includes('Verify')) {
                    console.log("[STATUS] 2FA completed!");
                    break;
                }

                if (i === 6) {
                    console.log("[WAITING] Still waiting for 2FA approval... (30 seconds elapsed)");
                }
            }
        }

        // Now on Google Voice - take screenshot
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/07_google_voice_main.png', fullPage: true });
        console.log("[SCREENSHOT] 07_google_voice_main.png saved");
        console.log("[STATUS] On Google Voice page. Looking for setup options...");

        // Check if already has a number or needs setup
        currentUrl = page.url();
        const voiceContent = await page.content();

        // Look for setup prompts or existing number indicators
        if (voiceContent.includes('Get started') || voiceContent.includes('Choose a Google Voice number')) {
            console.log("[STATUS] Found setup option. Clicking Get Started...");

            try {
                // Try clicking "Get started" or similar
                const getStarted = await page.$('text=Get started');
                if (getStarted) {
                    await getStarted.click();
                    await page.waitForTimeout(3000);
                }
            } catch (e) {
                console.log("[STATUS] Trying alternative navigation...");
            }
        }

        // Look for the number search/selection screen
        await page.screenshot({ path: './screenshots/08_looking_for_setup.png', fullPage: true });
        console.log("[SCREENSHOT] 08_looking_for_setup.png saved");

        // Try to access setup directly
        await page.goto('https://voice.google.com/u/0/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/09_signup_page.png', fullPage: true });
        console.log("[SCREENSHOT] 09_signup_page.png saved");

        // Search for numbers
        const searchBox = await page.$('input[aria-label*="Search"]') || await page.$('input[placeholder*="city"]') || await page.$('input[type="text"]');
        if (searchBox) {
            console.log("[STATUS] Found search box. Searching for Miami numbers...");
            await searchBox.fill('Miami');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(4000);
            await page.screenshot({ path: './screenshots/10_search_results.png', fullPage: true });
            console.log("[SCREENSHOT] 10_search_results.png saved");
        }

        // Look for available numbers to select
        const numbers = await page.$$('div[data-number]') || await page.$$('[role="option"]') || await page.$$('[role="listitem"]');
        console.log(`[STATUS] Found ${numbers.length} number options`);

        if (numbers.length > 0) {
            console.log("[STATUS] Selecting first available number...");
            await numbers[0].click();
            await page.waitForTimeout(2000);
            await page.screenshot({ path: './screenshots/11_number_selected.png', fullPage: true });
            console.log("[SCREENSHOT] 11_number_selected.png saved");
        }

        // Look for select/verify button
        const selectButton = await page.$('button:has-text("Select")') ||
                            await page.$('button:has-text("Choose")') ||
                            await page.$('button:has-text("Verify")');

        if (selectButton) {
            console.log("[STATUS] Clicking select/verify button...");
            await selectButton.click();
            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/12_after_select.png', fullPage: true });
            console.log("[SCREENSHOT] 12_after_select.png saved");
        }

        // Handle phone verification
        const phoneInput = await page.$('input[type="tel"]');
        if (phoneInput) {
            console.log("[STATUS] Phone verification required. Entering verification number...");
            await phoneInput.fill('5618433551');
            await page.waitForTimeout(1000);
            await page.screenshot({ path: './screenshots/13_phone_entered.png' });
            console.log("[SCREENSHOT] 13_phone_entered.png saved");

            // Send verification code
            const sendCodeBtn = await page.$('button:has-text("Send code")') ||
                               await page.$('button:has-text("Verify")') ||
                               await page.$('button:has-text("Next")');

            if (sendCodeBtn) {
                console.log("[STATUS] Sending verification code...");
                await sendCodeBtn.click();
                await page.waitForTimeout(3000);
                await page.screenshot({ path: './screenshots/14_code_sent.png' });
                console.log("[SCREENSHOT] 14_code_sent.png saved");
                console.log("[ACTION_NEEDED] Verification code sent! User needs to provide the code from their phone.");
            }
        }

        // Check for CAPTCHA
        const hasCaptcha = await page.$('iframe[src*="recaptcha"]') || await page.$('[class*="captcha"]');
        if (hasCaptcha) {
            console.log("[CAPTCHA] CAPTCHA detected! Check screenshots folder.");
            await page.screenshot({ path: `./screenshots/captcha_googlevoice_${Date.now()}.png` });
        }

        // Final state screenshot
        await page.screenshot({ path: './screenshots/15_final_state.png', fullPage: true });
        console.log("[SCREENSHOT] 15_final_state.png saved");
        console.log("[STATUS] Automation paused. Browser staying open for 3 minutes for manual review.");

        // Keep browser open
        await page.waitForTimeout(180000);

    } catch (error) {
        console.log(`[ERROR] ${error.message}`);
        await page.screenshot({ path: './screenshots/error_screenshot.png', fullPage: true });
        console.log("[SCREENSHOT] error_screenshot.png saved");

        // Keep open briefly on error
        await page.waitForTimeout(60000);
    } finally {
        await browser.close();
        console.log("[STATUS] Browser closed.");
    }
}

setupGoogleVoice().catch(err => console.log(`[FATAL] ${err.message}`));
