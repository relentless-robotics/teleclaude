const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function setupClerk() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('[INFO] Launching browser for Clerk setup...');
    console.log('[INFO] If you see a CAPTCHA, please solve it manually!');

    const browser = await chromium.launch({
        headless: false,
        channel: 'msedge',
        slowMo: 500 // Slow down actions so user can see what's happening
    });

    let context;
    if (fs.existsSync(stateFile)) {
        console.log('[INFO] Loading saved Google auth state...');
        context = await browser.newContext({ storageState: stateFile });
    } else {
        context = await browser.newContext();
    }

    const page = await context.newPage();

    try {
        // Go to Clerk signup page
        console.log('[INFO] Navigating to Clerk signup...');
        await page.goto('https://dashboard.clerk.com/sign-up', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Check for CAPTCHA
        const pageContent = await page.content();
        if (pageContent.includes('Verify you are human') || pageContent.includes('cf-turnstile')) {
            console.log('\n========================================');
            console.log('CAPTCHA DETECTED! Please solve it in the browser window.');
            console.log('After solving, the script will continue automatically.');
            console.log('========================================\n');

            // Wait for CAPTCHA to be solved (check every 2 seconds for up to 2 minutes)
            for (let i = 0; i < 60; i++) {
                await page.waitForTimeout(2000);
                const content = await page.content();
                if (!content.includes('Verify you are human') && !content.includes('cf-turnstile')) {
                    console.log('[INFO] CAPTCHA solved! Continuing...');
                    break;
                }
                if (i % 5 === 0) {
                    console.log('[WAITING] Still waiting for CAPTCHA to be solved...');
                }
            }
        }

        // Click Google signup button
        console.log('[INFO] Looking for Google signup button...');
        await page.waitForTimeout(2000);

        const googleBtn = page.locator('button:has-text("Google")');
        if (await googleBtn.count() > 0 && await googleBtn.first().isEnabled()) {
            console.log('[INFO] Clicking Google signup...');
            await googleBtn.first().click();
            await page.waitForTimeout(5000);
        }

        // Handle Google OAuth flow
        let attempts = 0;
        while (attempts < 30) {
            attempts++;
            const url = page.url();

            // Success - reached dashboard
            if (url.includes('dashboard.clerk.com') && !url.includes('sign-in') && !url.includes('sign-up')) {
                console.log('[SUCCESS] Reached Clerk dashboard!');
                break;
            }

            // Google account chooser
            if (url.includes('accounts.google.com/signin/accountchooser') || url.includes('accounts.google.com/v3/signin')) {
                console.log('[AUTH] Selecting Google account...');
                try {
                    await page.click('text=relentlessrobotics@gmail.com');
                    await page.waitForTimeout(3000);
                    continue;
                } catch (e) {
                    // Try clicking any account item
                    const accountItems = page.locator('[data-identifier], .W7Aapd');
                    if (await accountItems.count() > 0) {
                        await accountItems.first().click();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                }
            }

            // Google consent screen
            if (url.includes('oauth/consent') || url.includes('oauth/id')) {
                console.log('[AUTH] Clicking Continue on Google consent...');
                try {
                    await page.click('button:has-text("Continue")');
                    await page.waitForTimeout(3000);
                    continue;
                } catch (e) {
                    console.log('[DEBUG] Continue button not found');
                }
            }

            await page.waitForTimeout(2000);
        }

        // Wait and check final state
        await page.waitForTimeout(5000);
        const finalUrl = page.url();
        console.log('[INFO] Final URL:', finalUrl);

        // Handle onboarding/app creation if needed
        if (finalUrl.includes('prepare-account') || finalUrl.includes('onboarding') || finalUrl.includes('create')) {
            console.log('[INFO] On onboarding page, looking for app creation...');
            await page.waitForTimeout(3000);

            // Look for name input
            const nameInput = page.locator('input[name="name"], input[placeholder*="name"], input[placeholder*="app"]');
            if (await nameInput.count() > 0) {
                console.log('[INFO] Entering app name...');
                await nameInput.first().fill('Period Tracker');
                await page.waitForTimeout(1000);
            }

            // Click create/continue button
            const createBtn = page.locator('button:has-text("Create"), button:has-text("Continue"), button[type="submit"]');
            if (await createBtn.count() > 0) {
                await createBtn.first().click();
                await page.waitForTimeout(5000);
            }
        }

        // Navigate to API keys
        console.log('[INFO] Navigating to API keys page...');
        await page.goto('https://dashboard.clerk.com/last-active?path=api-keys', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'clerk_api_keys_final.png' });

        // Extract API keys
        const pageText = await page.innerText('body');
        console.log('[DEBUG] Page content preview:', pageText.substring(0, 500));

        const pkMatch = pageText.match(/pk_(?:test_|live_)[a-zA-Z0-9_]+/);
        const skMatch = pageText.match(/sk_(?:test_|live_)[a-zA-Z0-9_]+/);

        if (pkMatch) {
            console.log('\n==========================================');
            console.log('PUBLISHABLE KEY:', pkMatch[0]);

            let envContent = `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pkMatch[0]}\n`;

            if (skMatch) {
                console.log('SECRET KEY:', skMatch[0]);
                envContent += `CLERK_SECRET_KEY=${skMatch[0]}\n`;
            } else {
                console.log('SECRET KEY: Not visible (may need to click reveal)');
            }

            console.log('==========================================\n');

            // Save to file
            fs.writeFileSync(path.join(__dirname, 'clerk_keys.env'), envContent);
            console.log('[INFO] Keys saved to clerk_keys.env');
        } else {
            console.log('[WARN] Could not find API keys on page');
            console.log('[INFO] You may need to manually copy them from the dashboard');
        }

        // Keep browser open for user to verify/copy keys
        console.log('\n[INFO] Browser will stay open for 60 seconds.');
        console.log('[INFO] If you need to manually copy API keys, do it now!');
        console.log('[INFO] Look for "API Keys" in the Clerk dashboard sidebar.\n');

        await page.waitForTimeout(60000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'clerk_setup_error.png' });
        console.log('[INFO] Browser will stay open for 30 seconds for debugging...');
        await page.waitForTimeout(30000);
    } finally {
        await browser.close();
    }
}

setupClerk().catch(console.error);
