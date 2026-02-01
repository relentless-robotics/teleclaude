const { chromium } = require('playwright');
const path = require('path');

async function signupVercel() {
    const browserDataPath = path.join(__dirname, 'browser-data-vercel');

    console.log('Launching browser...');

    const browser = await chromium.launchPersistentContext(browserDataPath, {
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });

    const page = await browser.newPage();

    try {
        // Step 1: Go to Vercel signup
        console.log('Step 1: Navigating to vercel.com/signup...');
        await page.goto('https://vercel.com/signup', { waitUntil: 'networkidle', timeout: 60000 });
        await page.screenshot({ path: 'vercel_step1_signup.png' });
        await page.waitForTimeout(2000);

        // Step 2: Select Hobby plan (personal projects)
        console.log('Step 2: Selecting Hobby plan...');

        const hobbyOption = await page.$('text=I\'m working on personal projects');
        if (hobbyOption) {
            await hobbyOption.click();
            console.log('Selected Hobby plan');
            await page.waitForTimeout(1500);
        }

        await page.screenshot({ path: 'vercel_step2_hobby_selected.png' });

        // Step 2b: Fill in the "Your Name" field
        console.log('Step 2b: Filling in Your Name field...');

        const nameInputSelectors = [
            'input[placeholder*="Name"]',
            'input[name="name"]',
            'input[type="text"]',
            'input'
        ];

        for (const selector of nameInputSelectors) {
            try {
                const input = await page.$(selector);
                if (input && await input.isVisible()) {
                    await input.fill('Riley Anderson');
                    console.log(`Filled name with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        await page.waitForTimeout(1000);
        await page.screenshot({ path: 'vercel_step2b_name_filled.png' });

        // Step 3: Click Continue button
        console.log('Step 3: Clicking Continue...');
        await page.waitForTimeout(1000);

        try {
            await page.click('button:has-text("Continue")');
            console.log('Clicked Continue');
        } catch (e) {
            console.log('Continue button click failed:', e.message);
            await page.click('button:has-text("Continue")', { force: true });
        }

        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'vercel_step3_after_continue.png' });

        // Step 4: Click Google OAuth and handle popup
        console.log('Step 4: Clicking Google OAuth and handling popup...');

        // Set up popup listener BEFORE clicking
        const popupPromise = browser.waitForEvent('page', { timeout: 30000 });

        // Click Continue with Google
        await page.click('button:has-text("Continue with Google")');
        console.log('Clicked Continue with Google, waiting for popup...');

        // Wait for the popup
        const popup = await popupPromise;
        console.log('Popup opened! URL:', popup.url());

        await popup.waitForLoadState('networkidle');
        await popup.screenshot({ path: 'vercel_step4_google_popup.png' });

        // Step 5: Handle Google login in popup
        console.log('Step 5: Handling Google login in popup...');

        const popupUrl = popup.url();
        console.log('Popup URL:', popupUrl);

        if (popupUrl.includes('accounts.google.com')) {
            // Check if account chooser is shown (already logged in)
            if (popupUrl.includes('accountchooser')) {
                console.log('Account chooser detected - clicking existing account...');
                try {
                    // Click on the account (relentlessrobotics@gmail.com)
                    const accountOption = await popup.$('div[data-identifier="relentlessrobotics@gmail.com"]');
                    if (accountOption) {
                        await accountOption.click();
                        console.log('Clicked existing account');
                    } else {
                        // Try clicking any account button
                        await popup.click('li[data-authuser]');
                        console.log('Clicked first available account');
                    }
                    await popup.waitForTimeout(5000);
                    await popup.screenshot({ path: 'vercel_step5_account_selected.png' });
                } catch (e) {
                    console.log('Error selecting account:', e.message);
                    // Try text-based selector
                    try {
                        await popup.click('text=relentlessrobotics@gmail.com');
                        console.log('Clicked account via text');
                        await popup.waitForTimeout(5000);
                    } catch (e2) {
                        console.log('Also failed text click:', e2.message);
                    }
                }
            } else {
                // Enter email
                console.log('Entering Google email...');

                try {
                    await popup.waitForSelector('input[type="email"]', { timeout: 10000 });
                    await popup.fill('input[type="email"]', 'relentlessrobotics@gmail.com');
                    await popup.waitForTimeout(1000);
                    await popup.screenshot({ path: 'vercel_step5_email_filled.png' });

                    // Click Next
                    await popup.click('button:has-text("Next")');
                    console.log('Clicked Next after email');
                    await popup.waitForTimeout(4000);
                } catch (e) {
                    console.log('Error entering email:', e.message);
                }
            }

            await popup.screenshot({ path: 'vercel_step6_after_email.png' });

            // Enter password
            console.log('Entering Google password...');
            try {
                await popup.waitForSelector('input[type="password"]', { timeout: 15000 });
                await popup.fill('input[type="password"]', 'Relaxing41!');
                await popup.waitForTimeout(1000);
                await popup.screenshot({ path: 'vercel_step7_password_filled.png' });

                // Click Next
                await popup.click('button:has-text("Next")');
                console.log('Clicked Next after password');
            } catch (e) {
                console.log('Error entering password:', e.message);
            }

            await popup.waitForTimeout(5000);
            await popup.screenshot({ path: 'vercel_step8_after_password.png' });

            // Check for OAuth consent screen or 2FA
            const afterPasswordUrl = popup.url();
            console.log('After password URL:', afterPasswordUrl);

            // Handle OAuth consent screen (Continue button)
            if (afterPasswordUrl.includes('signin/oauth')) {
                console.log('OAuth consent screen detected - clicking Continue...');
                try {
                    // Wait for Continue button
                    await popup.waitForSelector('button:has-text("Continue")', { timeout: 10000 });
                    await popup.click('button:has-text("Continue")');
                    console.log('Clicked Continue on OAuth consent');
                    await popup.waitForTimeout(5000);
                    await popup.screenshot({ path: 'vercel_step8b_after_consent.png' });
                } catch (e) {
                    console.log('Could not click Continue on consent screen:', e.message);
                }
            }

            // Check for 2FA
            if (afterPasswordUrl.includes('challenge') || afterPasswordUrl.includes('signin/v2') || afterPasswordUrl.includes('signinchooser')) {
                console.log('2FA or additional verification detected!');
                console.log('>>> PLEASE TAP "YES" ON YOUR PHONE TO APPROVE THE LOGIN <<<');

                // Wait for user to complete 2FA (up to 90 seconds)
                for (let i = 0; i < 18; i++) {
                    await popup.waitForTimeout(5000);

                    // Check if popup is still open
                    if (popup.isClosed()) {
                        console.log('Popup closed - authentication completed!');
                        break;
                    }

                    const checkUrl = popup.url();
                    console.log(`Waiting for 2FA... (${(i+1)*5}s) Current: ${checkUrl}`);

                    if (!checkUrl.includes('accounts.google.com')) {
                        console.log('No longer on Google - authentication may be complete');
                        break;
                    }
                }
            }
        }

        // Wait a bit for main page to update after OAuth
        console.log('Waiting for main page to update after OAuth...');
        await page.waitForTimeout(10000);
        await page.screenshot({ path: 'vercel_step9_after_oauth.png' });

        const mainPageUrl = page.url();
        console.log('Main page URL after OAuth:', mainPageUrl);

        // Step 6: Handle Vercel onboarding
        console.log('Step 6: Checking for Vercel onboarding...');
        await page.screenshot({ path: 'vercel_step10_onboarding.png' });

        const vercelUrl = page.url();
        console.log('Current Vercel URL:', vercelUrl);

        // Check if we need to refresh or we're on dashboard
        if (vercelUrl.includes('vercel.com/new') || vercelUrl.includes('vercel.com/dashboard') || vercelUrl.includes('vercel.com/~')) {
            console.log('Successfully logged in! On Vercel dashboard.');

            // Handle any onboarding steps
            const teamInput = await page.$('input[name="team"]');
            if (teamInput) {
                await teamInput.fill('relentless-robotics');
                await page.waitForTimeout(500);
            }

            // Click any Continue/Skip buttons
            const nextBtns = ['button:has-text("Continue")', 'button:has-text("Skip")', 'button:has-text("Next")'];
            for (const btnSelector of nextBtns) {
                try {
                    const btn = await page.$(btnSelector);
                    if (btn && await btn.isVisible()) {
                        await btn.click();
                        await page.waitForTimeout(2000);
                        await page.screenshot({ path: 'vercel_onboarding_step.png' });
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        // Final: Get account info
        console.log('Final step: Getting account info...');
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'vercel_final.png' });

        const finalUrl = page.url();
        console.log('Final URL:', finalUrl);

        // Navigate to account settings
        try {
            await page.goto('https://vercel.com/account', { waitUntil: 'networkidle', timeout: 30000 });
            await page.screenshot({ path: 'vercel_account_page.png' });
            console.log('Account page title:', await page.title());
        } catch (e) {
            console.log('Could not navigate to account page:', e.message);
        }

        console.log('Script completed. Check screenshots.');

        // Keep browser open for 2 minutes
        console.log('Keeping browser open for 120 seconds...');
        await page.waitForTimeout(120000);

    } catch (error) {
        console.error('Error during signup:', error);
        await page.screenshot({ path: 'vercel_error.png' });
    } finally {
        await browser.close();
    }
}

signupVercel().catch(console.error);
