const { chromium } = require('playwright');
const path = require('path');

async function setupVoice() {
    console.log("[STATUS] Starting browser...");

    const userDataDir = path.join(__dirname, 'browser-data-v2');

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        slowMo: 150,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York'
    });

    const page = browser.pages()[0] || await browser.newPage();

    async function screenshotWithLog(name) {
        await page.screenshot({ path: `./screenshots/${name}.png`, fullPage: true });
        console.log(`[SCREENSHOT] ${name}.png`);
    }

    try {
        // STEP 1: Log into Google first
        console.log("\n=== STEP 1: Google Sign-In ===");
        await page.goto('https://accounts.google.com', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);

        let url = page.url();
        console.log("[URL] " + url);

        // Check if we need to sign in
        if (url.includes('signin') || await page.$('input[type="email"]')) {
            console.log("[STATUS] Need to sign in...");

            // Enter email
            const emailField = await page.$('input[type="email"]');
            if (emailField) {
                await emailField.click();
                await page.waitForTimeout(300);
                await emailField.fill('relentlessrobotics@gmail.com');
                await screenshotWithLog('c01_email_entered');

                // Click Next
                await page.click('#identifierNext');
                await page.waitForTimeout(4000);
                await screenshotWithLog('c02_after_email_next');
            }

            // Enter password
            const pwdField = await page.$('input[type="password"]');
            if (pwdField) {
                console.log("[STATUS] Entering password...");
                await pwdField.click();
                await page.waitForTimeout(300);
                await pwdField.fill('Relaxing41!');
                await screenshotWithLog('c03_password_entered');

                await page.click('#passwordNext');
                await page.waitForTimeout(6000);
                await screenshotWithLog('c04_after_password');
            }

            // Check for challenges
            url = page.url();
            let pageText = await page.textContent('body');

            // 2FA check
            if (pageText.includes('2-Step') || pageText.includes('Verify it') || pageText.includes('confirm your identity')) {
                console.log("\n[2FA] *** PLEASE TAP 'YES' ON YOUR PHONE ***");
                await screenshotWithLog('c05_2fa_prompt');

                // Wait up to 2 minutes
                for (let i = 0; i < 24; i++) {
                    await page.waitForTimeout(5000);
                    pageText = await page.textContent('body');
                    url = page.url();

                    if (!pageText.includes('2-Step') && !pageText.includes('Verify it')) {
                        console.log("[2FA] Approved!");
                        break;
                    }
                    if (i % 6 === 0 && i > 0) {
                        console.log(`[WAITING] ${i * 5} seconds... still waiting for 2FA`);
                    }
                }
                await screenshotWithLog('c06_after_2fa');
            }
        } else {
            console.log("[STATUS] Already signed in!");
        }

        // Verify we're signed in
        await page.goto('https://myaccount.google.com/', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        url = page.url();

        if (url.includes('myaccount.google.com') && !url.includes('signin')) {
            console.log("[SUCCESS] Confirmed signed in to Google!");
            await screenshotWithLog('c07_signed_in_confirmed');
        } else {
            console.log("[WARNING] May not be signed in. URL: " + url);
            await screenshotWithLog('c07_signin_issue');
        }

        // STEP 2: Navigate to Google Voice
        console.log("\n=== STEP 2: Google Voice ===");

        // Try multiple Voice entry points
        console.log("[STATUS] Going to voice.google.com/signup...");
        await page.goto('https://voice.google.com/signup', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        await screenshotWithLog('c08_voice_signup');

        url = page.url();
        console.log("[URL] " + url);

        // Check if we landed on voice setup
        if (url.includes('workspace.google.com')) {
            console.log("[WARNING] Redirected to Workspace. Trying alternative URL...");

            // Try direct voice URL with /u/0 path
            await page.goto('https://voice.google.com/u/0', { waitUntil: 'networkidle', timeout: 60000 });
            await page.waitForTimeout(3000);
            url = page.url();
            console.log("[URL] " + url);
            await screenshotWithLog('c09_voice_u0');
        }

        // Check page content
        let pageContent = await page.textContent('body');

        if (pageContent.includes('Get a Google Voice number') ||
            pageContent.includes('Select a number') ||
            pageContent.includes('Choose')) {

            console.log("\n=== STEP 3: Number Selection ===");
            console.log("[STATUS] Voice setup wizard found!");

            // Look for search/input for area code
            const allInputs = await page.$$('input');
            console.log(`[INFO] Found ${allInputs.length} input fields`);

            for (let i = 0; i < allInputs.length; i++) {
                const input = allInputs[i];
                const placeholder = await input.getAttribute('placeholder') || '';
                const ariaLabel = await input.getAttribute('aria-label') || '';
                const type = await input.getAttribute('type') || '';

                if (placeholder.toLowerCase().includes('city') ||
                    placeholder.toLowerCase().includes('area') ||
                    ariaLabel.toLowerCase().includes('search') ||
                    ariaLabel.toLowerCase().includes('city')) {

                    console.log(`[FOUND] Search input: placeholder="${placeholder}", aria-label="${ariaLabel}"`);
                    await input.click();
                    await page.waitForTimeout(300);
                    await input.fill('305'); // Miami area code
                    await page.keyboard.press('Enter');
                    await page.waitForTimeout(3000);
                    await screenshotWithLog('c10_searched_numbers');
                    break;
                }
            }

            // Look for phone number options
            await page.waitForTimeout(2000);
            const numberElements = await page.$$('div[role="option"], div[role="listitem"], .phone-number-item, [data-phonenumber]');
            console.log(`[INFO] Found ${numberElements.length} number options`);

            if (numberElements.length > 0) {
                console.log("[STATUS] Clicking first available number...");
                await numberElements[0].click();
                await page.waitForTimeout(2000);
                await screenshotWithLog('c11_number_clicked');

                // Look for Select/Confirm button
                const buttons = await page.$$('button');
                for (const btn of buttons) {
                    const text = await btn.textContent();
                    if (text.includes('Select') || text.includes('Choose') || text.includes('Confirm')) {
                        console.log("[STATUS] Clicking: " + text);
                        await btn.click();
                        await page.waitForTimeout(2000);
                        break;
                    }
                }
                await screenshotWithLog('c12_after_select');
            }
        }

        // STEP 4: Phone verification
        console.log("\n=== STEP 4: Phone Verification ===");
        pageContent = await page.textContent('body');

        const phoneInput = await page.$('input[type="tel"]');
        if (phoneInput) {
            console.log("[STATUS] Phone verification required...");
            console.log("[STATUS] Entering verification phone number...");
            await phoneInput.click();
            await page.waitForTimeout(300);
            await phoneInput.fill('5618433551');
            await page.waitForTimeout(1000);
            await screenshotWithLog('c13_phone_entered');

            // Look for send/verify button
            const buttons = await page.$$('button');
            for (const btn of buttons) {
                const text = await btn.textContent();
                if (text.includes('Send code') || text.includes('Verify') || text.includes('Call') || text.includes('Text')) {
                    console.log("[STATUS] Clicking: " + text);
                    await btn.click();
                    await page.waitForTimeout(3000);
                    break;
                }
            }
            await screenshotWithLog('c14_verification_sent');
            console.log("[ACTION] Verification code sent! Please check your phone for the code.");
        }

        // Final screenshot
        await screenshotWithLog('c15_final_state');
        console.log("\n[STATUS] Current URL: " + page.url());

        // Keep browser open
        console.log("\n[INFO] Browser will stay open for 5 minutes.");
        console.log("[INFO] You can manually complete any remaining steps.");
        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("\n[ERROR] " + error.message);
        await screenshotWithLog('error_state');
        await page.waitForTimeout(60000);
    } finally {
        await browser.close();
    }
}

setupVoice();
