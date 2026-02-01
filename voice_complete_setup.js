const { chromium } = require('playwright');
const path = require('path');

async function completeVoiceSetup() {
    console.log("[STATUS] Reconnecting to browser session...");

    // Reuse the same user data directory
    const userDataDir = path.join(__dirname, 'browser-data-stealth2');

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        slowMo: 200,
        viewport: { width: 1280, height: 800 },
        args: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = browser.pages()[0] || await browser.newPage();

    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    async function screenshot(name) {
        await page.screenshot({ path: `./screenshots/complete_${name}.png`, fullPage: true });
        console.log(`[SCREENSHOT] complete_${name}.png`);
    }

    try {
        // Go to Voice onboarding
        console.log("[STATUS] Navigating to Voice onboarding...");
        await page.goto('https://voice.google.com/u/0/onboarding', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        await screenshot('01_onboarding');

        const url = page.url();
        console.log("[URL] " + url);

        let pageText = await page.textContent('body');

        // Check if we're on number selection
        if (pageText.includes('Choose a phone number') || pageText.includes('suggested a number')) {
            console.log("[STATUS] On number selection page!");

            // Look for the suggested number (Orlando, FL one)
            const suggestedNumber = await page.$('text=(407) 374-9472');
            if (suggestedNumber) {
                console.log("[STATUS] Clicking on suggested number (407) 374-9472...");
                await suggestedNumber.click();
                await page.waitForTimeout(2000);
                await screenshot('02_clicked_number');
            } else {
                // Try clicking the first number option (the div with the number)
                const numberOption = await page.$('div:has-text("(407)")');
                if (numberOption) {
                    console.log("[STATUS] Clicking number option...");
                    await numberOption.click();
                    await page.waitForTimeout(2000);
                    await screenshot('02_clicked_number');
                }
            }
        }

        // Check for verify/link phone screen
        await page.waitForTimeout(2000);
        pageText = await page.textContent('body');
        await screenshot('03_after_select');
        console.log("[URL] " + page.url());

        if (pageText.includes('Verify') || pageText.includes('link') || pageText.includes('forwarding') || pageText.includes('phone number')) {
            console.log("[STATUS] On verification screen!");

            // Look for phone input
            const phoneInput = await page.$('input[type="tel"]');
            if (phoneInput) {
                console.log("[STATUS] Entering verification phone number...");
                await phoneInput.click();
                await page.waitForTimeout(500);
                await phoneInput.fill('');  // Clear first
                await phoneInput.fill('5618433551');
                await page.waitForTimeout(1000);
                await screenshot('04_phone_entered');

                // Look for send code button
                const buttons = await page.$$('button');
                let clicked = false;
                for (const btn of buttons) {
                    const btnText = await btn.textContent();
                    if (btnText.includes('Send code') || btnText.includes('Verify') || btnText.includes('Next') || btnText.includes('Continue')) {
                        console.log(`[STATUS] Clicking button: "${btnText.trim()}"`);
                        await btn.click();
                        clicked = true;
                        await page.waitForTimeout(4000);
                        break;
                    }
                }

                if (clicked) {
                    await screenshot('05_after_send_code');
                    console.log("[ACTION] Code sent! Please check your phone and tell me the verification code.");

                    // Wait for code input screen
                    await page.waitForTimeout(2000);
                    pageText = await page.textContent('body');

                    if (pageText.includes('Enter code') || pageText.includes('verification code')) {
                        console.log("[STATUS] Waiting for verification code from user...");
                        console.log("[INFO] Please check your phone for the code and tell me what it is.");
                    }
                }
            }
        }

        // Check if we need to select the number first
        const selectNumberBtn = await page.$('button:has-text("Select")');
        if (selectNumberBtn) {
            console.log("[STATUS] Found Select button, clicking...");
            await selectNumberBtn.click();
            await page.waitForTimeout(2000);
            await screenshot('select_clicked');
        }

        // Final state
        await screenshot('06_current_state');
        console.log("[STATUS] Current URL: " + page.url());

        // Keep browser open
        console.log("\n[INFO] Browser staying open for 5 minutes.");
        console.log("[INFO] If a verification code was sent, please tell me the code.");
        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("\n[ERROR] " + error.message);
        await screenshot('error');
        await page.waitForTimeout(120000);
    } finally {
        await browser.close();
    }
}

completeVoiceSetup();
