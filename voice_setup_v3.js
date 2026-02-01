const { chromium } = require('playwright');

async function setupGoogleVoice() {
    console.log("[STATUS] Starting browser...");

    const browser = await chromium.launch({
        headless: false,
        slowMo: 50,
        args: ['--start-maximized']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        // First, sign in to Google
        console.log("[STEP 1] Signing into Google account...");
        await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);

        // Check if already signed in
        const emailInput = await page.$('input[type="email"]');
        if (emailInput) {
            await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
            await page.click('#identifierNext');
            await page.waitForTimeout(3000);

            // Password
            await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => null);
            const pwdField = await page.$('input[type="password"]');
            if (pwdField) {
                await page.fill('input[type="password"]', 'Relaxing41!');
                await page.click('#passwordNext');
                await page.waitForTimeout(5000);
            }

            // Check for 2FA
            const pageText = await page.textContent('body');
            if (pageText.includes('2-Step') || pageText.includes('Verify')) {
                console.log("[2FA] Tap YES on your phone to approve!");
                for (let i = 0; i < 12; i++) {
                    await page.waitForTimeout(5000);
                    if (!page.url().includes('signin')) break;
                }
            }
        }

        console.log("[STEP 2] Signed in. Going to Google Voice about page...");
        await page.screenshot({ path: './screenshots/v3_01_signed_in.png' });

        // Go to Google Voice About page (the one with personal/business options)
        await page.goto('https://voice.google.com/about', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/v3_02_voice_about.png', fullPage: true });

        // Look for "For personal use" link
        console.log("[STEP 3] Looking for personal use option...");
        const personalLink = await page.$('a:has-text("For personal use")');
        if (personalLink) {
            console.log("[STATUS] Found 'For personal use' link, clicking...");
            await personalLink.click();
            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/v3_03_personal_clicked.png', fullPage: true });
        } else {
            console.log("[STATUS] No 'For personal use' link found. Trying direct URL...");
        }

        // Try the direct personal voice signup
        console.log("[STEP 4] Navigating to personal Voice setup...");
        await page.goto('https://voice.google.com/u/0/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/v3_04_voice_main.png', fullPage: true });

        // Check current URL and page state
        let url = page.url();
        console.log("[INFO] Current URL: " + url);

        // Look for setup wizard elements
        const getNumberBtn = await page.$('button:has-text("Get a Google Voice number")');
        const continueBtn = await page.$('button:has-text("Continue")');
        const searchBox = await page.$('input[aria-label*="Search"]');
        const citySearch = await page.$('input[placeholder*="city"]');

        console.log("[STATUS] Checking for setup elements...");
        console.log("  - Get number button: " + (getNumberBtn ? "found" : "not found"));
        console.log("  - Continue button: " + (continueBtn ? "found" : "not found"));
        console.log("  - Search box: " + (searchBox ? "found" : "not found"));
        console.log("  - City search: " + (citySearch ? "found" : "not found"));

        // If we see setup elements, interact with them
        if (getNumberBtn) {
            await getNumberBtn.click();
            await page.waitForTimeout(2000);
            await page.screenshot({ path: './screenshots/v3_05_after_get_number.png' });
        } else if (continueBtn) {
            await continueBtn.click();
            await page.waitForTimeout(2000);
        }

        // Look for number selection UI
        await page.screenshot({ path: './screenshots/v3_05_looking_for_numbers.png', fullPage: true });

        // Try searching for area
        const searchInput = await page.$('input[aria-label*="Search"]') ||
                           await page.$('input[aria-label*="city"]') ||
                           await page.$('input[aria-label*="area"]');

        if (searchInput) {
            console.log("[STATUS] Found search input, searching for numbers...");
            await searchInput.click();
            await searchInput.fill('305'); // Miami area code
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/v3_06_search_results.png', fullPage: true });

            // Look for number options
            const numberList = await page.$$('[role="option"]') ||
                              await page.$$('[role="listitem"]') ||
                              await page.$$('.phone-number');

            if (numberList.length > 0) {
                console.log("[STATUS] Found " + numberList.length + " numbers. Selecting first one...");
                await numberList[0].click();
                await page.waitForTimeout(2000);

                // Look for select/confirm button
                const selectBtn = await page.$('button:has-text("Select")') ||
                                 await page.$('button:has-text("Choose")') ||
                                 await page.$('button:has-text("Continue")');
                if (selectBtn) {
                    await selectBtn.click();
                    await page.waitForTimeout(2000);
                }
            }
        }

        // Check for phone verification
        const phoneVerify = await page.$('input[type="tel"]');
        if (phoneVerify) {
            console.log("[STATUS] Phone verification needed. Entering verification number...");
            await phoneVerify.fill('5618433551');
            await page.waitForTimeout(1000);

            const verifyBtn = await page.$('button:has-text("Send code")') ||
                             await page.$('button:has-text("Verify")');
            if (verifyBtn) {
                await verifyBtn.click();
                await page.waitForTimeout(3000);
                console.log("[ACTION] Verification code sent! Check your phone for the code.");
            }
        }

        await page.screenshot({ path: './screenshots/v3_07_current_state.png', fullPage: true });

        // Read page content to understand current state
        const pageText = await page.textContent('body');
        if (pageText.includes('calls') || pageText.includes('Messages') || pageText.includes('Voicemail')) {
            console.log("[STATUS] Google Voice interface visible - may already have a number or be set up!");
        }

        // Check for any error messages
        if (pageText.includes("isn't available") || pageText.includes('not available')) {
            console.log("[WARNING] Google Voice may not be available for this account/region");
        }

        console.log("[STATUS] Current state saved. Keeping browser open for 5 minutes...");
        console.log("[INFO] You can manually interact with the browser if needed.");

        // Keep open
        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("[ERROR] " + error.message);
        await page.screenshot({ path: './screenshots/v3_error.png', fullPage: true });
        await page.waitForTimeout(60000);
    } finally {
        await browser.close();
    }
}

setupGoogleVoice();
