const { chromium } = require('playwright');
const path = require('path');

async function verifyPhone() {
    console.log("[STATUS] Opening browser...");

    const userDataDir = path.join(__dirname, 'browser-data-stealth2');

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        slowMo: 200,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = browser.pages()[0] || await browser.newPage();

    async function screenshot(name) {
        await page.screenshot({ path: `./screenshots/verify_${name}.png`, fullPage: true });
        console.log(`[SCREENSHOT] verify_${name}.png`);
    }

    try {
        // Navigate to onboarding
        console.log("[STATUS] Going to Voice onboarding...");
        await page.goto('https://voice.google.com/u/0/onboarding', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        await screenshot('01_page');

        let pageText = await page.textContent('body');
        console.log("[INFO] Page state - contains 'Verify': " + pageText.includes('Verify'));
        console.log("[INFO] Page state - contains 'selected': " + pageText.includes('selected'));

        // If we see "You selected" and "Verify" button
        if (pageText.includes('You selected') || pageText.includes('(321)')) {
            console.log("[STATUS] On verification screen with selected number!");

            // Click the Verify button
            console.log("[STATUS] Clicking Verify button...");
            try {
                await page.click('button:has-text("Verify")', { timeout: 5000 });
                console.log("[SUCCESS] Clicked Verify button");
                await page.waitForTimeout(3000);
                await screenshot('02_after_verify_click');
            } catch (e) {
                // Try clicking by coordinates (Verify button is near bottom center)
                console.log("[STATUS] Trying coordinate click for Verify...");
                await page.mouse.click(825, 508);
                await page.waitForTimeout(3000);
                await screenshot('02_after_verify_coord');
            }
        }

        // Check for phone input
        await page.waitForTimeout(2000);
        pageText = await page.textContent('body');
        await screenshot('03_current_state');

        if (pageText.includes('phone number') || pageText.includes('Enter a')) {
            console.log("[STATUS] Phone number entry screen!");

            // Look for phone input
            const phoneInput = await page.$('input[type="tel"]') || await page.$('input');
            if (phoneInput) {
                console.log("[STATUS] Found phone input, entering verification number...");
                await phoneInput.click();
                await page.waitForTimeout(500);
                await phoneInput.fill('');
                await page.waitForTimeout(300);

                // Type phone number
                const phone = '5618433551';
                for (const char of phone) {
                    await page.keyboard.type(char, { delay: 100 });
                }

                await page.waitForTimeout(1000);
                await screenshot('04_phone_entered');

                // Look for Send code button
                console.log("[STATUS] Looking for Send code button...");
                try {
                    await page.click('button:has-text("Send code")', { timeout: 5000 });
                    console.log("[SUCCESS] Clicked Send code");
                } catch (e) {
                    console.log("[STATUS] Trying Next/Verify button...");
                    try {
                        await page.click('button:has-text("Next")', { timeout: 3000 });
                    } catch (e2) {
                        await page.click('button:has-text("Verify")', { timeout: 3000 });
                    }
                }

                await page.waitForTimeout(4000);
                await screenshot('05_after_send');
                console.log("\n[ACTION] Verification code should be sent to your phone!");
                console.log("[ACTION] Please check your phone for a text/call with the code.");

                // Check for code entry screen
                pageText = await page.textContent('body');
                if (pageText.includes('Enter the code') || pageText.includes('verification code') || pageText.includes('6-digit')) {
                    console.log("\n[WAITING] Now waiting for you to provide the verification code...");
                    console.log("[INFO] Once you receive the code, let me know and I'll enter it.");
                }
            }
        }

        // Final screenshot
        await screenshot('06_final_state');
        console.log("\n[STATUS] Current URL: " + page.url());
        console.log("[INFO] Browser staying open for 5 minutes. Please provide the verification code if received.");

        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("\n[ERROR] " + error.message);
        await screenshot('error');
        await page.waitForTimeout(120000);
    } finally {
        await browser.close();
    }
}

verifyPhone();
