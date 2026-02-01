const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function setupClerk() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('[INFO] Launching browser...');

    const browser = await chromium.launch({
        headless: false,
        channel: 'msedge'
    });

    // Create context WITH Google auth state
    let context;
    if (fs.existsSync(stateFile)) {
        console.log('[INFO] Loading Google auth state...');
        context = await browser.newContext({ storageState: stateFile });
    } else {
        context = await browser.newContext();
    }

    const page = await context.newPage();

    // Handle popups for OAuth
    context.on('page', async (popup) => {
        console.log('[POPUP] New page opened:', popup.url());

        // If it's a Google auth popup, handle it
        if (popup.url().includes('accounts.google.com')) {
            console.log('[POPUP] Google OAuth popup detected, handling...');
            await popup.waitForTimeout(2000);

            try {
                // Try to select account
                await popup.click('text=relentlessrobotics@gmail.com');
                await popup.waitForTimeout(2000);
            } catch (e) {
                console.log('[POPUP] Could not click account');
            }

            // Try to click Continue/Allow
            try {
                await popup.click('button:has-text("Continue")');
            } catch (e) {
                try {
                    await popup.click('button:has-text("Allow")');
                } catch (e2) {
                    console.log('[POPUP] No Continue/Allow button found');
                }
            }
        }
    });

    try {
        // First, let's try going to Google and ensuring we're logged in
        console.log('[INFO] Verifying Google login...');
        await page.goto('https://accounts.google.com', { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const googleUrl = page.url();
        if (googleUrl.includes('SignOutOptions') || googleUrl.includes('myaccount')) {
            console.log('[INFO] Already logged into Google!');
        }

        // Now go to Clerk
        console.log('[INFO] Navigating to Clerk signup...');
        await page.goto('https://dashboard.clerk.com/sign-up', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        await page.screenshot({ path: 'clerk_step1.png' });

        // Check for and handle Cloudflare CAPTCHA
        let pageContent = await page.content();
        if (pageContent.includes('cf-turnstile') || pageContent.includes('Verify you are human')) {
            console.log('[INFO] CAPTCHA detected, waiting for it to auto-solve or timeout...');

            // Cloudflare Turnstile sometimes auto-solves, wait for it
            for (let i = 0; i < 30; i++) {
                await page.waitForTimeout(2000);
                pageContent = await page.content();

                // Check if CAPTCHA checkbox appeared and click it
                const checkbox = page.frameLocator('iframe[src*="turnstile"]').locator('input[type="checkbox"]');
                try {
                    if (await checkbox.count() > 0) {
                        console.log('[INFO] Found CAPTCHA checkbox, clicking...');
                        await checkbox.click();
                        await page.waitForTimeout(3000);
                    }
                } catch (e) {
                    // Ignore
                }

                // Check if CAPTCHA is gone
                if (!pageContent.includes('cf-turnstile') && !pageContent.includes('Verify you are human')) {
                    console.log('[INFO] CAPTCHA cleared!');
                    break;
                }

                // Check if buttons are now enabled
                const googleBtn = page.locator('button:has-text("Google")');
                if (await googleBtn.count() > 0 && await googleBtn.first().isEnabled()) {
                    console.log('[INFO] Google button is now enabled!');
                    break;
                }
            }
        }

        await page.screenshot({ path: 'clerk_step2.png' });

        // Click Google button using JavaScript to bypass any issues
        console.log('[INFO] Clicking Google signup button...');

        // Try multiple methods to click the button
        let clicked = false;

        // Method 1: Standard click
        try {
            const btn = page.locator('button:has-text("Google")');
            if (await btn.count() > 0) {
                await btn.first().click({ timeout: 5000 });
                clicked = true;
                console.log('[INFO] Clicked via standard method');
            }
        } catch (e) {
            console.log('[DEBUG] Standard click failed');
        }

        // Method 2: JavaScript click
        if (!clicked) {
            try {
                await page.evaluate(() => {
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        if (btn.textContent && btn.textContent.includes('Google')) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                });
                clicked = true;
                console.log('[INFO] Clicked via JavaScript');
            } catch (e) {
                console.log('[DEBUG] JS click failed');
            }
        }

        // Wait for navigation or popup
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'clerk_step3.png' });

        let currentUrl = page.url();
        console.log('[INFO] Current URL:', currentUrl);

        // Handle Google OAuth in same tab
        for (let attempt = 0; attempt < 20; attempt++) {
            currentUrl = page.url();
            console.log('[AUTH] Attempt', attempt + 1, '- URL:', currentUrl.substring(0, 80));

            // Success - reached dashboard
            if (currentUrl.includes('dashboard.clerk.com') &&
                !currentUrl.includes('sign-in') &&
                !currentUrl.includes('sign-up')) {
                console.log('[SUCCESS] Reached Clerk dashboard!');
                break;
            }

            // Handle Google account chooser
            if (currentUrl.includes('accounts.google.com')) {
                await page.screenshot({ path: `google_step_${attempt}.png` });

                // Account chooser
                if (currentUrl.includes('accountchooser') || currentUrl.includes('signin/identifier') || currentUrl.includes('v3/signin')) {
                    console.log('[AUTH] On account chooser...');
                    try {
                        // Click the account
                        const accountSelectors = [
                            'div[data-email="relentlessrobotics@gmail.com"]',
                            'div[data-identifier="relentlessrobotics@gmail.com"]',
                            'text=relentlessrobotics@gmail.com'
                        ];

                        for (const sel of accountSelectors) {
                            try {
                                const elem = page.locator(sel);
                                if (await elem.count() > 0) {
                                    await elem.first().click();
                                    console.log('[AUTH] Clicked account with selector:', sel);
                                    break;
                                }
                            } catch (e) {}
                        }
                    } catch (e) {
                        console.log('[AUTH] Failed to select account');
                    }
                }

                // Consent screen
                if (currentUrl.includes('consent') || currentUrl.includes('oauth/id')) {
                    console.log('[AUTH] On consent screen...');
                    try {
                        const continueBtn = page.locator('button:has-text("Continue"), #submit_approve_access');
                        if (await continueBtn.count() > 0) {
                            await continueBtn.first().click();
                            console.log('[AUTH] Clicked Continue');
                        }
                    } catch (e) {
                        console.log('[AUTH] Failed to click Continue');
                    }
                }
            }

            await page.waitForTimeout(2000);
        }

        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'clerk_step4.png' });
        currentUrl = page.url();
        console.log('[INFO] After auth, URL:', currentUrl);

        // Handle onboarding/app creation
        if (currentUrl.includes('dashboard.clerk.com')) {
            // Check if we need to create an app
            await page.waitForTimeout(2000);

            const nameInput = page.locator('input[name="name"], input[placeholder*="name"], input[placeholder*="application"]');
            if (await nameInput.count() > 0) {
                console.log('[INFO] Creating new application...');
                await nameInput.first().fill('Period Tracker');
                await page.waitForTimeout(1000);

                // Click create button
                const createBtn = page.locator('button:has-text("Create"), button[type="submit"]');
                if (await createBtn.count() > 0) {
                    await createBtn.first().click();
                    await page.waitForTimeout(5000);
                }
            }

            // Navigate to API keys
            console.log('[INFO] Going to API keys...');
            await page.goto('https://dashboard.clerk.com/last-active?path=api-keys', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(3000);
            await page.screenshot({ path: 'clerk_api_keys.png' });

            // Get the keys
            const pageText = await page.innerText('body');

            const pkMatch = pageText.match(/pk_(?:test_|live_)[a-zA-Z0-9_]+/);
            let skMatch = pageText.match(/sk_(?:test_|live_)[a-zA-Z0-9_]+/);

            // If secret key not visible, try to reveal it
            if (!skMatch) {
                const eyeIcons = page.locator('button[aria-label*="show"], button[aria-label*="reveal"], svg[class*="eye"]');
                if (await eyeIcons.count() > 0) {
                    console.log('[INFO] Trying to reveal secret key...');
                    await eyeIcons.first().click();
                    await page.waitForTimeout(2000);

                    const newPageText = await page.innerText('body');
                    skMatch = newPageText.match(/sk_(?:test_|live_)[a-zA-Z0-9_]+/);
                }
            }

            if (pkMatch) {
                console.log('\n========================================');
                console.log('SUCCESS! API KEYS FOUND:');
                console.log('PUBLISHABLE KEY:', pkMatch[0]);
                if (skMatch) {
                    console.log('SECRET KEY:', skMatch[0]);
                }
                console.log('========================================\n');

                // Save keys
                let envContent = `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pkMatch[0]}\n`;
                if (skMatch) {
                    envContent += `CLERK_SECRET_KEY=${skMatch[0]}\n`;
                }
                fs.writeFileSync(path.join(__dirname, 'clerk_keys.env'), envContent);
                console.log('[INFO] Keys saved to clerk_keys.env');
            } else {
                console.log('[WARN] Could not extract API keys');
                console.log('[DEBUG] Page text:', pageText.substring(0, 1000));
            }
        }

        // Keep browser open briefly
        console.log('[INFO] Keeping browser open for 30 seconds...');
        await page.waitForTimeout(30000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'clerk_error.png' });
    } finally {
        await browser.close();
    }
}

setupClerk().catch(console.error);
