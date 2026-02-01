const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function setupGoogleVoiceWithPersistentContext() {
    console.log("[STATUS] Starting browser with persistent context...");

    // Use a persistent context to maintain login state
    const userDataDir = path.join(__dirname, 'browser-data');

    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        slowMo: 100,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-web-security'
        ]
    });

    const page = browser.pages()[0] || await browser.newPage();

    try {
        // First check if already logged in
        console.log("[STEP 1] Checking Google account status...");
        await page.goto('https://myaccount.google.com/', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);

        let url = page.url();
        let loggedIn = !url.includes('accounts.google.com/signin');

        if (!loggedIn) {
            console.log("[STATUS] Not logged in. Starting login process...");
            console.log("[INFO] Google sign-in page loaded. Browser is ready for manual login if needed.");

            // Try to enter email
            const emailInput = await page.$('input[type="email"]');
            if (emailInput) {
                console.log("[STATUS] Entering email...");
                await page.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
                await page.waitForTimeout(500);
                await page.screenshot({ path: './screenshots/persist_01_email.png' });

                // Click next
                const nextBtn = await page.$('#identifierNext');
                if (nextBtn) {
                    await nextBtn.click();
                    await page.waitForTimeout(4000);
                }
            }

            await page.screenshot({ path: './screenshots/persist_02_after_email.png' });

            // Check for CAPTCHA or challenge
            const pageContent = await page.content();
            if (pageContent.includes('CAPTCHA') || pageContent.includes('verify') || pageContent.includes('challenge')) {
                console.log("[CAPTCHA/CHALLENGE] Security challenge detected!");
                console.log("[ACTION] Please complete the challenge in the browser window.");
                console.log("[WAITING] Waiting 60 seconds for manual intervention...");
                await page.screenshot({ path: './screenshots/persist_challenge.png' });
                await page.waitForTimeout(60000);
            }

            // Try to enter password
            const pwdInput = await page.$('input[type="password"]');
            if (pwdInput) {
                console.log("[STATUS] Entering password...");
                await page.fill('input[type="password"]', 'Relaxing41!');
                await page.waitForTimeout(500);

                const pwdNext = await page.$('#passwordNext');
                if (pwdNext) {
                    await pwdNext.click();
                    await page.waitForTimeout(5000);
                }
            }

            await page.screenshot({ path: './screenshots/persist_03_after_pwd.png' });

            // Check for 2FA
            const twoFAContent = await page.textContent('body').catch(() => '');
            if (twoFAContent.includes('2-Step') || twoFAContent.includes('Verify')) {
                console.log("[2FA] Two-factor authentication required!");
                console.log("[ACTION] Please tap 'Yes' on your phone to approve.");
                console.log("[WAITING] Waiting up to 90 seconds...");

                for (let i = 0; i < 18; i++) {
                    await page.waitForTimeout(5000);
                    url = page.url();
                    if (url.includes('myaccount.google.com') || !url.includes('signin')) {
                        console.log("[SUCCESS] 2FA approved!");
                        break;
                    }
                    if (i === 6) console.log("[WAITING] 30 seconds elapsed, still waiting for 2FA...");
                    if (i === 12) console.log("[WAITING] 60 seconds elapsed, still waiting for 2FA...");
                }
            }

            await page.screenshot({ path: './screenshots/persist_04_login_result.png' });
        }

        // Now try to access Google Voice
        console.log("[STEP 2] Navigating to Google Voice...");

        // Try the signup URL first
        await page.goto('https://voice.google.com/signup', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/persist_05_voice_signup.png', fullPage: true });

        url = page.url();
        console.log("[STATUS] Voice signup URL: " + url);

        // Check if we landed on the actual Voice app
        if (url.includes('voice.google.com') && !url.includes('workspace')) {
            console.log("[SUCCESS] Reached Google Voice!");

            // Check for number selection interface
            const pageText = await page.textContent('body');

            if (pageText.includes('Select') || pageText.includes('Choose') || pageText.includes('Get a Google Voice')) {
                console.log("[STATUS] Number selection interface found!");

                // Look for area code/city search
                const searchInput = await page.$('input');
                if (searchInput) {
                    console.log("[STATUS] Searching for Miami area numbers...");
                    await searchInput.fill('Miami');
                    await page.keyboard.press('Enter');
                    await page.waitForTimeout(3000);
                    await page.screenshot({ path: './screenshots/persist_06_search.png' });

                    // Click on first available number
                    const numbers = await page.$$('[role="option"]');
                    if (numbers.length > 0) {
                        console.log("[STATUS] Found " + numbers.length + " numbers. Selecting first...");
                        await numbers[0].click();
                        await page.waitForTimeout(2000);

                        // Click select/verify
                        const selectBtn = await page.$('button:has-text("Select")');
                        if (selectBtn) {
                            await selectBtn.click();
                            await page.waitForTimeout(2000);
                        }
                    }
                }

                // Handle phone verification
                const phoneInput = await page.$('input[type="tel"]');
                if (phoneInput) {
                    console.log("[STATUS] Phone verification required. Entering number...");
                    await phoneInput.fill('5618433551');
                    await page.waitForTimeout(1000);

                    const sendCodeBtn = await page.$('button:has-text("Send code")');
                    if (sendCodeBtn) {
                        await sendCodeBtn.click();
                        await page.waitForTimeout(3000);
                        console.log("[ACTION] Verification code sent! Please check your phone.");
                    }
                }
            }
        } else if (url.includes('workspace')) {
            console.log("[WARNING] Redirected to Workspace. Google Voice for personal use may not be available.");
            console.log("[INFO] This could be because:");
            console.log("  - The account region doesn't support free Voice");
            console.log("  - The account already has Voice set up elsewhere");
            console.log("  - Google is requiring Workspace subscription");
        }

        await page.screenshot({ path: './screenshots/persist_07_final.png', fullPage: true });

        console.log("[STATUS] Keeping browser open for 5 minutes...");
        console.log("[INFO] You can interact with the browser manually if needed.");

        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("[ERROR] " + error.message);
        await page.screenshot({ path: './screenshots/persist_error.png', fullPage: true });
        await page.waitForTimeout(60000);
    } finally {
        await browser.close();
    }
}

setupGoogleVoiceWithPersistentContext();
