const { chromium } = require('playwright');
const path = require('path');

async function fullVoiceSetup() {
    console.log("[STATUS] Starting full Voice setup flow...");

    const userDataDir = path.join(__dirname, 'browser-data-stealth2');

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        slowMo: 300,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = browser.pages()[0] || await browser.newPage();

    async function screenshot(name) {
        await page.screenshot({ path: `./screenshots/full_${name}.png`, fullPage: true });
        console.log(`[SCREENSHOT] full_${name}.png`);
    }

    async function delay(ms) {
        await page.waitForTimeout(ms);
    }

    try {
        // Step 1: Navigate to Voice onboarding
        console.log("\n=== STEP 1: Navigate to Voice ===");
        await page.goto('https://voice.google.com/u/0/onboarding', { waitUntil: 'networkidle', timeout: 60000 });
        await delay(3000);
        await screenshot('01_initial');

        let pageText = await page.textContent('body');

        // Step 2: Select a phone number
        console.log("\n=== STEP 2: Select Phone Number ===");
        if (pageText.includes('Choose a phone number')) {
            console.log("[STATUS] On number selection page");

            // Click on the suggested number card using coordinates
            // The number card is roughly at y=290 based on screenshots
            console.log("[STATUS] Clicking on suggested number...");
            await page.mouse.click(640, 285);
            await delay(3000);
            await screenshot('02_after_number_click');

            pageText = await page.textContent('body');
        }

        // Step 3: Click Verify button if present
        console.log("\n=== STEP 3: Click Verify ===");
        pageText = await page.textContent('body');

        if (pageText.includes('You selected') || pageText.includes('Verify')) {
            console.log("[STATUS] Number selected, looking for Verify button...");

            // Try to click Verify button
            try {
                await page.click('button:has-text("Verify")', { timeout: 5000 });
                console.log("[SUCCESS] Clicked Verify button");
            } catch (e) {
                // Click by coordinates (Verify button typically around y=508)
                console.log("[STATUS] Clicking Verify by coordinates...");
                await page.mouse.click(825, 508);
            }

            await delay(3000);
            await screenshot('03_after_verify');
        }

        // Step 4: Enter verification phone number
        console.log("\n=== STEP 4: Enter Verification Phone ===");
        await delay(2000);
        pageText = await page.textContent('body');
        await screenshot('04_verification_screen');

        if (pageText.includes('Enter a phone number') || pageText.includes('verify') || pageText.includes('phone')) {
            console.log("[STATUS] Looking for phone input field...");

            // Find all input fields
            const inputs = await page.$$('input');
            console.log(`[INFO] Found ${inputs.length} input fields`);

            for (const input of inputs) {
                const type = await input.getAttribute('type');
                const placeholder = await input.getAttribute('placeholder') || '';
                console.log(`[INPUT] type="${type}", placeholder="${placeholder}"`);

                if (type === 'tel' || placeholder.toLowerCase().includes('phone') || placeholder.includes('(')) {
                    console.log("[FOUND] Phone input field!");
                    await input.click();
                    await delay(500);
                    await input.fill('');
                    await delay(300);

                    // Type the phone number
                    console.log("[STATUS] Typing verification phone number...");
                    await page.keyboard.type('5618433551', { delay: 150 });
                    await delay(1000);
                    await screenshot('05_phone_entered');
                    break;
                }
            }

            // If no tel input found, try the first text input
            if (inputs.length > 0) {
                const firstInput = inputs[0];
                const type = await firstInput.getAttribute('type');
                if (type !== 'tel') {
                    console.log("[STATUS] Using first input field...");
                    await firstInput.click();
                    await delay(500);
                    await firstInput.fill('5618433551');
                    await delay(1000);
                    await screenshot('05_phone_entered_alt');
                }
            }
        }

        // Step 5: Click Send Code button
        console.log("\n=== STEP 5: Send Verification Code ===");
        await delay(1000);

        const buttons = await page.$$('button');
        console.log(`[INFO] Found ${buttons.length} buttons`);

        for (const btn of buttons) {
            const text = await btn.textContent();
            console.log(`[BUTTON] "${text.trim()}"`);

            if (text.includes('Send code') || text.includes('SEND CODE')) {
                console.log("[STATUS] Clicking 'Send code' button...");
                await btn.click();
                await delay(4000);
                await screenshot('06_after_send_code');
                console.log("\n[SUCCESS] Verification code sent!");
                console.log("[ACTION] Please check your phone for the verification code.");
                break;
            }
        }

        // Step 6: Check current state
        console.log("\n=== STEP 6: Check State ===");
        await screenshot('07_current_state');
        pageText = await page.textContent('body');

        if (pageText.includes('Enter the code') || pageText.includes('verification code') || pageText.includes('6-digit')) {
            console.log("[STATUS] Code entry screen detected!");
            console.log("[WAITING] Waiting for verification code from user...");
        }

        // Final state
        console.log("\n[INFO] Current URL: " + page.url());
        console.log("[INFO] Browser will stay open for 5 minutes.");
        console.log("[INFO] Please provide the verification code when you receive it.");

        await delay(300000);

    } catch (error) {
        console.log("\n[ERROR] " + error.message);
        await screenshot('error');
        await delay(120000);
    } finally {
        await browser.close();
    }
}

fullVoiceSetup();
