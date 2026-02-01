const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function signupClerk() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('[INFO] Launching browser for Clerk signup...');

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
        while (attempts < 15) {
            attempts++;
            await page.waitForTimeout(2000);
            const url = page.url();
            console.log('[AUTH] Attempt', attempts, '- URL:', url.substring(0, 100));

            // Success conditions
            if (url.includes('dashboard.clerk.com') && !url.includes('sign')) {
                console.log('[SUCCESS] Reached Clerk dashboard!');
                return true;
            }

            // Account chooser
            if (url.includes('accountchooser') || url.includes('signin/identifier')) {
                console.log('[AUTH] Selecting Google account...');
                try {
                    await page.click('text=relentlessrobotics@gmail.com');
                    continue;
                } catch (e) {
                    const accountDiv = page.locator('div[data-identifier="relentlessrobotics@gmail.com"]');
                    if (await accountDiv.count() > 0) {
                        await accountDiv.click();
                        continue;
                    }
                }
            }

            // Consent screen
            if (url.includes('consent') || url.includes('oauth/id')) {
                console.log('[AUTH] Clicking Continue on consent...');
                try {
                    await page.click('button:has-text("Continue")');
                    continue;
                } catch (e) {
                    // Try other selectors
                    const btns = page.locator('button, div[role="button"]');
                    const count = await btns.count();
                    for (let i = 0; i < count; i++) {
                        const text = await btns.nth(i).textContent();
                        if (text && text.toLowerCase().includes('continue')) {
                            await btns.nth(i).click();
                            break;
                        }
                    }
                }
            }
        }
        return false;
    }

    try {
        // Go to Clerk signup page
        console.log('[INFO] Navigating to Clerk signup...');
        await page.goto('https://dashboard.clerk.com/sign-up', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'clerk_signup_page.png' });

        let currentUrl = page.url();
        console.log('[INFO] Initial URL:', currentUrl);

        // Click sign up with Google
        console.log('[INFO] Clicking Google signup...');
        const googleBtn = page.locator('button:has-text("Google")');
        if (await googleBtn.count() > 0) {
            await googleBtn.first().click();
            await page.waitForTimeout(3000);
        }

        // Handle Google OAuth
        await handleGoogleAuth();

        // Wait and check current state
        await page.waitForTimeout(5000);
        currentUrl = page.url();
        console.log('[INFO] After auth URL:', currentUrl);
        await page.screenshot({ path: 'clerk_after_signup.png' });

        // If there's a "Create" or setup flow, handle it
        if (currentUrl.includes('prepare-account') || currentUrl.includes('create')) {
            console.log('[INFO] On account setup page...');
            await page.waitForTimeout(3000);

            // Look for "Create application" or similar
            const createBtn = page.locator('button:has-text("Create"), button:has-text("Continue"), button:has-text("Get started")');
            if (await createBtn.count() > 0) {
                console.log('[INFO] Clicking create/continue...');
                await createBtn.first().click();
                await page.waitForTimeout(3000);
            }
        }

        // Check for application creation flow
        await page.waitForTimeout(3000);
        currentUrl = page.url();
        await page.screenshot({ path: 'clerk_post_setup.png' });

        // If we need to name the app
        const appNameInput = page.locator('input[name="name"], input[placeholder*="name"], input[placeholder*="app"]');
        if (await appNameInput.count() > 0) {
            console.log('[INFO] Entering app name...');
            await appNameInput.first().fill('Period Tracker');
            await page.waitForTimeout(1000);

            const submitBtn = page.locator('button[type="submit"], button:has-text("Create"), button:has-text("Continue")');
            if (await submitBtn.count() > 0) {
                await submitBtn.first().click();
                await page.waitForTimeout(5000);
            }
        }

        // Now try to get API keys
        await page.waitForTimeout(3000);
        currentUrl = page.url();
        console.log('[INFO] Current URL:', currentUrl);

        if (currentUrl.includes('dashboard.clerk.com')) {
            console.log('[INFO] Navigating to API keys...');
            await page.goto('https://dashboard.clerk.com/last-active?path=api-keys', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(3000);
            await page.screenshot({ path: 'clerk_api_keys.png' });

            // Extract keys
            const pageText = await page.innerText('body');
            console.log('[DEBUG] Page text:', pageText.substring(0, 1000));

            const pkMatch = pageText.match(/pk_(?:test_|live_)[a-zA-Z0-9_]+/);
            if (pkMatch) {
                console.log('\n========================================');
                console.log('[SUCCESS] PUBLISHABLE KEY:', pkMatch[0]);
                console.log('========================================\n');

                // Save to file
                fs.writeFileSync(path.join(__dirname, 'clerk_keys.env'),
                    `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pkMatch[0]}\n`);
            }

            // Try to get secret key
            const skMatch = pageText.match(/sk_(?:test_|live_)[a-zA-Z0-9_]+/);
            if (skMatch) {
                console.log('\n========================================');
                console.log('[SUCCESS] SECRET KEY:', skMatch[0]);
                console.log('========================================\n');

                fs.appendFileSync(path.join(__dirname, 'clerk_keys.env'),
                    `CLERK_SECRET_KEY=${skMatch[0]}\n`);
            }
        }

        console.log('[INFO] Keeping browser open for 20 seconds for verification...');
        await page.waitForTimeout(20000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'clerk_error.png' });
    } finally {
        await browser.close();
    }
}

signupClerk().catch(console.error);
