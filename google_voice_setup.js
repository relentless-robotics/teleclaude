const { chromium } = require('playwright');

async function sendDiscordUpdate(message) {
    console.log(`[DISCORD_UPDATE] ${message}`);
}

async function setupGoogleVoice() {
    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }
    });

    const page = await context.newPage();

    try {
        await sendDiscordUpdate("Opening Google Voice website...");
        await page.goto('https://voice.google.com', { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        // Take screenshot of current state
        await page.screenshot({ path: './screenshots/step1_initial.png' });

        // Check if we need to sign in
        const signInButton = await page.$('a[href*="accounts.google.com"]');
        const signInLink = await page.$('text=Sign in');

        if (signInButton || signInLink) {
            await sendDiscordUpdate("Sign-in required. Navigating to Google login...");

            // Click sign in or go directly to accounts
            if (signInButton) {
                await signInButton.click();
            } else if (signInLink) {
                await signInLink.click();
            } else {
                await page.goto('https://accounts.google.com/signin');
            }

            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/step2_login_page.png' });
        }

        // Enter email
        const emailInput = await page.$('input[type="email"]');
        if (emailInput) {
            await sendDiscordUpdate("Entering email address...");
            await emailInput.fill('relentlessrobotics@gmail.com');
            await page.waitForTimeout(500);

            // Click Next
            const nextButton = await page.$('#identifierNext');
            if (nextButton) {
                await nextButton.click();
            } else {
                await page.keyboard.press('Enter');
            }
            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/step3_after_email.png' });
        }

        // Enter password
        const passwordInput = await page.$('input[type="password"]');
        if (passwordInput) {
            await sendDiscordUpdate("Entering password...");
            await passwordInput.fill('Relaxing41!');
            await page.waitForTimeout(500);

            // Click Next
            const passwordNext = await page.$('#passwordNext');
            if (passwordNext) {
                await passwordNext.click();
            } else {
                await page.keyboard.press('Enter');
            }
            await page.waitForTimeout(5000);
            await page.screenshot({ path: './screenshots/step4_after_password.png' });
        }

        // Check for 2FA
        const twoFactorPrompt = await page.$('text=2-Step Verification');
        const tapYes = await page.$('text=Tap Yes on your phone');
        const securityKey = await page.$('text=Use your Security Key');

        if (twoFactorPrompt || tapYes || securityKey) {
            await sendDiscordUpdate("2FA REQUIRED: Please tap 'Yes' on your phone/tablet to approve sign-in. Waiting up to 60 seconds...");
            await page.screenshot({ path: './screenshots/step5_2fa_prompt.png' });

            // Wait for 2FA to complete (up to 60 seconds)
            let twoFactorComplete = false;
            for (let i = 0; i < 12; i++) {
                await page.waitForTimeout(5000);

                // Check if we're past 2FA
                const currentUrl = page.url();
                if (currentUrl.includes('voice.google.com') || currentUrl.includes('myaccount.google.com')) {
                    twoFactorComplete = true;
                    await sendDiscordUpdate("2FA approved! Continuing...");
                    break;
                }

                // Still on 2FA page
                const stillOn2FA = await page.$('text=2-Step Verification');
                const stillTapYes = await page.$('text=Tap Yes');
                if (!stillOn2FA && !stillTapYes) {
                    twoFactorComplete = true;
                    await sendDiscordUpdate("2FA approved! Continuing...");
                    break;
                }

                if (i === 5) {
                    await sendDiscordUpdate("Still waiting for 2FA approval... Please tap Yes on your phone.");
                }
            }

            if (!twoFactorComplete) {
                await sendDiscordUpdate("2FA timeout - please try again and approve faster.");
                await browser.close();
                return;
            }
        }

        // Navigate to Google Voice after login
        await page.waitForTimeout(2000);
        await page.goto('https://voice.google.com', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/step6_voice_page.png' });

        await sendDiscordUpdate("On Google Voice page. Looking for setup options...");

        // Look for "Get a Google Voice number" or setup prompts
        const getNumberButton = await page.$('text=Get started');
        const chooseNumber = await page.$('text=Choose');
        const searchCity = await page.$('input[placeholder*="city"]');
        const selectNumber = await page.$('text=Select');

        // Try different setup paths
        if (getNumberButton) {
            await sendDiscordUpdate("Found 'Get started' button. Clicking...");
            await getNumberButton.click();
            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/step7_after_get_started.png' });
        }

        // Look for number selection screen
        await page.waitForTimeout(2000);

        // Search for available numbers
        const searchInput = await page.$('input[type="text"]');
        if (searchInput) {
            await sendDiscordUpdate("Searching for available numbers in Miami area...");
            await searchInput.fill('Miami');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/step8_number_search.png' });
        }

        // Look for number options
        await page.waitForTimeout(3000);
        await page.screenshot({ path: './screenshots/step9_number_options.png' });

        // Try to find and select a number
        const numberOptions = await page.$$('div[role="listitem"]');
        if (numberOptions.length > 0) {
            await sendDiscordUpdate(`Found ${numberOptions.length} available numbers. Selecting first option...`);
            await numberOptions[0].click();
            await page.waitForTimeout(2000);
        }

        // Look for Select/Choose button
        const selectBtn = await page.$('button:has-text("Select")');
        const chooseBtn = await page.$('button:has-text("Choose")');
        const verifyBtn = await page.$('button:has-text("Verify")');

        if (selectBtn) {
            await selectBtn.click();
            await page.waitForTimeout(2000);
        } else if (chooseBtn) {
            await chooseBtn.click();
            await page.waitForTimeout(2000);
        }

        await page.screenshot({ path: './screenshots/step10_after_select.png' });

        // Handle phone verification
        const phoneInput = await page.$('input[type="tel"]');
        if (phoneInput) {
            await sendDiscordUpdate("Phone verification required. Entering verification phone number...");
            await phoneInput.fill('5618433551');
            await page.waitForTimeout(1000);

            // Click send code or verify
            const sendCodeBtn = await page.$('button:has-text("Send code")');
            const verifyPhoneBtn = await page.$('button:has-text("Verify")');

            if (sendCodeBtn) {
                await sendCodeBtn.click();
            } else if (verifyPhoneBtn) {
                await verifyPhoneBtn.click();
            }

            await page.waitForTimeout(3000);
            await page.screenshot({ path: './screenshots/step11_verification_sent.png' });

            await sendDiscordUpdate("Verification code sent to your phone. Please check your messages and tell me the code.");
        }

        // Check for CAPTCHA
        const captcha = await page.$('iframe[src*="recaptcha"]');
        const captchaImg = await page.$('img[alt*="CAPTCHA"]');

        if (captcha || captchaImg) {
            const timestamp = Date.now();
            await page.screenshot({ path: `./screenshots/captcha_googlevoice_${timestamp}.png` });
            await sendDiscordUpdate("CAPTCHA detected! Check ./screenshots/ folder and reply with the solution.");
        }

        // Keep browser open for manual intervention if needed
        await sendDiscordUpdate("Browser automation paused. Please check screenshots folder for current state. Keeping browser open for 5 minutes for manual intervention if needed.");

        // Wait 5 minutes
        await page.waitForTimeout(300000);

    } catch (error) {
        await sendDiscordUpdate(`Error encountered: ${error.message}`);
        await page.screenshot({ path: './screenshots/error_state.png' });
    } finally {
        await browser.close();
    }
}

setupGoogleVoice().catch(console.error);
