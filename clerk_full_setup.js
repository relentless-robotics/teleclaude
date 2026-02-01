const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function setupClerk() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('[INFO] Launching browser for Clerk setup...');

    const browser = await chromium.launch({
        headless: false,
        channel: 'msedge'
    });

    let context;
    if (fs.existsSync(stateFile)) {
        console.log('[INFO] Loading saved Google auth state...');
        context = await browser.newContext({ storageState: stateFile });
    } else {
        context = await browser.newContext();
    }

    const page = await context.newPage();

    async function handleGoogleAuth() {
        let attempts = 0;
        while (attempts < 10) {
            attempts++;
            const url = page.url();
            console.log('[GOOGLE] Attempt', attempts, '- URL:', url.substring(0, 80) + '...');

            if (url.includes('dashboard.clerk.com')) {
                console.log('[GOOGLE] Successfully reached Clerk dashboard!');
                return true;
            }

            // Account chooser - select account
            if (url.includes('accountchooser') || url.includes('signin/identifier')) {
                console.log('[GOOGLE] On account chooser, selecting account...');
                try {
                    // Click on the account email
                    const accountDiv = page.locator('div[data-email="relentlessrobotics@gmail.com"]');
                    if (await accountDiv.count() > 0) {
                        await accountDiv.click();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                    // Or click by text
                    const emailText = page.locator('text=relentlessrobotics@gmail.com');
                    if (await emailText.count() > 0) {
                        await emailText.first().click();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                } catch (e) {
                    console.log('[GOOGLE] Error selecting account:', e.message);
                }
            }

            // Consent screen - click Continue
            if (url.includes('oauth/consent') || url.includes('signin/oauth')) {
                console.log('[GOOGLE] On consent screen, clicking Continue...');
                await page.screenshot({ path: 'google_consent_screen.png' });
                try {
                    const continueBtn = page.locator('button:has-text("Continue"), div[role="button"]:has-text("Continue")');
                    if (await continueBtn.count() > 0) {
                        await continueBtn.first().click();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                } catch (e) {
                    console.log('[GOOGLE] Error clicking continue:', e.message);
                }
            }

            await page.waitForTimeout(2000);
        }
        return false;
    }

    try {
        // Go to Clerk sign-in with Google directly
        console.log('[INFO] Navigating to Clerk...');
        await page.goto('https://dashboard.clerk.com', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);

        let currentUrl = page.url();
        console.log('[INFO] Initial URL:', currentUrl);

        // If on sign-in page, click Google
        if (currentUrl.includes('sign-in') || currentUrl.includes('accounts.clerk.com')) {
            console.log('[INFO] On sign-in page...');
            await page.screenshot({ path: 'clerk_signin.png' });

            // Click Continue with Google
            const googleBtn = page.locator('button:has-text("Continue with Google"), button:has-text("Google")');
            if (await googleBtn.count() > 0) {
                console.log('[INFO] Clicking Google sign-in...');
                await googleBtn.first().click();
                await page.waitForTimeout(3000);
            }
        }

        // Handle Google OAuth flow
        const success = await handleGoogleAuth();

        if (!success) {
            console.log('[WARN] Google auth may not have completed, checking current state...');
        }

        await page.waitForTimeout(3000);
        currentUrl = page.url();
        console.log('[INFO] Current URL after auth:', currentUrl);
        await page.screenshot({ path: 'clerk_after_auth.png' });

        // Navigate to API keys
        if (currentUrl.includes('dashboard.clerk.com')) {
            console.log('[INFO] In Clerk dashboard! Getting API keys...');

            // Check if we need to create an app first
            if (currentUrl.includes('apps') || currentUrl.includes('create')) {
                console.log('[INFO] May need to create an app...');
                // Look for create app button or existing apps
            }

            // Go to API keys
            await page.goto('https://dashboard.clerk.com/last-active?path=api-keys', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(3000);
            await page.screenshot({ path: 'clerk_api_page.png' });

            // Get page text
            const pageText = await page.innerText('body');

            // Find publishable key
            const pkMatch = pageText.match(/pk_(?:test_|live_)[a-zA-Z0-9_]+/);
            if (pkMatch) {
                console.log('[SUCCESS] Publishable Key:', pkMatch[0]);

                // Save to file
                const envContent = `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pkMatch[0]}`;
                fs.writeFileSync(path.join(__dirname, 'clerk_keys.env'), envContent);
                console.log('[INFO] Key saved to clerk_keys.env');

                // Now let's try to get the secret key - may need to click reveal
                // The secret key is usually hidden

                // Look for reveal/show button near secret key
                const showSecretBtn = page.locator('button:has-text("Show"), button:has-text("Reveal"), button[aria-label*="reveal"], button[aria-label*="show"]');
                if (await showSecretBtn.count() > 0) {
                    console.log('[INFO] Clicking show secret key button...');
                    await showSecretBtn.first().click();
                    await page.waitForTimeout(2000);
                }

                // Get page text again
                const newPageText = await page.innerText('body');
                const skMatch = newPageText.match(/sk_(?:test_|live_)[a-zA-Z0-9_]+/);
                if (skMatch) {
                    console.log('[SUCCESS] Secret Key:', skMatch[0]);
                    const fullEnvContent = `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pkMatch[0]}\nCLERK_SECRET_KEY=${skMatch[0]}`;
                    fs.writeFileSync(path.join(__dirname, 'clerk_keys.env'), fullEnvContent);
                }

                await page.screenshot({ path: 'clerk_keys_final.png' });
            } else {
                console.log('[WARN] Could not find publishable key on page');
                console.log('[INFO] Page text preview:', pageText.substring(0, 500));
            }
        }

        console.log('[INFO] Keeping browser open for 15 seconds...');
        await page.waitForTimeout(15000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'clerk_error.png' });
    } finally {
        await browser.close();
    }
}

setupClerk().catch(console.error);
