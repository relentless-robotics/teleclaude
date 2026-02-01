const { chromium } = require('playwright');
const path = require('path');

async function clickNumber() {
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
        await page.screenshot({ path: `./screenshots/click_${name}.png`, fullPage: true });
        console.log(`[SCREENSHOT] click_${name}.png`);
    }

    try {
        // Navigate to onboarding
        console.log("[STATUS] Going to Voice onboarding...");
        await page.goto('https://voice.google.com/u/0/onboarding', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        await screenshot('01_page');

        // Try different approaches to click the number
        console.log("[STATUS] Looking for number element to click...");

        // Method 1: Click by exact text
        try {
            await page.click('text=(407)', { timeout: 5000 });
            console.log("[SUCCESS] Clicked via text=(407)");
            await page.waitForTimeout(2000);
            await screenshot('02_after_click_m1');
        } catch (e) {
            console.log("[METHOD 1] Failed: " + e.message.split('\n')[0]);
        }

        // Method 2: Click by aria or role
        try {
            const listItems = await page.$$('[role="button"], [role="listitem"], [role="option"]');
            console.log(`[INFO] Found ${listItems.length} clickable items`);
            if (listItems.length > 0) {
                await listItems[0].click({ force: true });
                console.log("[SUCCESS] Clicked via role selector");
                await page.waitForTimeout(2000);
                await screenshot('02_after_click_m2');
            }
        } catch (e) {
            console.log("[METHOD 2] Failed: " + e.message.split('\n')[0]);
        }

        // Method 3: Click by CSS - the number card
        try {
            await page.click('div[class*="number"]', { timeout: 5000 });
            console.log("[SUCCESS] Clicked via div[class*=number]");
            await page.waitForTimeout(2000);
            await screenshot('02_after_click_m3');
        } catch (e) {
            console.log("[METHOD 3] Failed: " + e.message.split('\n')[0]);
        }

        // Method 4: Click using coordinates (the number card should be around this area)
        try {
            // The number card is roughly in the center of the page
            await page.mouse.click(640, 290);
            console.log("[SUCCESS] Clicked via coordinates");
            await page.waitForTimeout(2000);
            await screenshot('02_after_click_m4');
        } catch (e) {
            console.log("[METHOD 4] Failed: " + e.message.split('\n')[0]);
        }

        // Method 5: Use evaluate to find and click
        try {
            await page.evaluate(() => {
                // Find all elements containing the phone number
                const elements = document.querySelectorAll('*');
                for (const el of elements) {
                    if (el.textContent && el.textContent.includes('(407)') && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
                        // Find clickable parent
                        let clickable = el;
                        while (clickable && !clickable.onclick && clickable.tagName !== 'A' && clickable.tagName !== 'BUTTON') {
                            clickable = clickable.parentElement;
                        }
                        if (clickable) {
                            clickable.click();
                            return 'clicked parent';
                        } else {
                            el.click();
                            return 'clicked element';
                        }
                    }
                }
                return 'not found';
            });
            console.log("[SUCCESS] Clicked via evaluate");
            await page.waitForTimeout(2000);
            await screenshot('02_after_click_m5');
        } catch (e) {
            console.log("[METHOD 5] Failed: " + e.message.split('\n')[0]);
        }

        // Check current state
        await screenshot('03_current_state');
        console.log("[URL] " + page.url());

        let pageText = await page.textContent('body');
        console.log("[INFO] Page contains 'Verify': " + pageText.includes('Verify'));
        console.log("[INFO] Page contains 'link': " + pageText.includes('link'));

        // If we're now on verification page
        if (pageText.includes('Verify') || pageText.includes('link') || pageText.includes('forwarding')) {
            console.log("[SUCCESS] Moved to verification step!");

            // Enter phone number
            const phoneInput = await page.$('input[type="tel"]');
            if (phoneInput) {
                console.log("[STATUS] Entering verification phone...");
                await phoneInput.click();
                await phoneInput.fill('5618433551');
                await page.waitForTimeout(1000);
                await screenshot('04_phone_entered');

                // Click verify/send button
                const verifyBtn = await page.$('button:has-text("Send code")') ||
                                 await page.$('button:has-text("Verify")') ||
                                 await page.$('button:has-text("Next")');
                if (verifyBtn) {
                    await verifyBtn.click();
                    await page.waitForTimeout(3000);
                    console.log("[ACTION] Code sent! Check your phone.");
                    await screenshot('05_code_sent');
                }
            }
        }

        // Keep browser open
        console.log("\n[INFO] Browser staying open for 5 minutes...");
        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("\n[ERROR] " + error.message);
        await screenshot('error');
        await page.waitForTimeout(60000);
    } finally {
        await browser.close();
    }
}

clickNumber();
