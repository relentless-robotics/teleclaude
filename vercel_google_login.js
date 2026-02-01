const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function loginVercelWithGoogle() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('[INFO] Launching browser with Google auth...');

    const browser = await chromium.launch({
        headless: false,
        channel: 'msedge'
    });

    let context;
    if (fs.existsSync(stateFile)) {
        console.log('[INFO] Loading saved Google auth state...');
        context = await browser.newContext({ storageState: stateFile });
    } else {
        console.log('[WARN] No saved auth state, creating fresh context...');
        context = await browser.newContext();
    }

    const page = await context.newPage();

    try {
        // Go to the Vercel device auth URL
        const authUrl = 'https://vercel.com/oauth/device?user_code=CLKF-CHBB';
        console.log('[INFO] Navigating to Vercel auth URL...');
        await page.goto(authUrl, { waitUntil: 'networkidle', timeout: 30000 });

        await page.screenshot({ path: 'vercel_auth_page.png' });
        console.log('[INFO] Screenshot saved: vercel_auth_page.png');

        // Wait a moment for the page to fully load
        await page.waitForTimeout(2000);

        // Look for "Continue with Google" or similar button
        const googleButton = await page.locator('button:has-text("Google"), a:has-text("Google"), button:has-text("Continue with Google"), [data-testid="oauth-google"]').first();

        if (await googleButton.isVisible()) {
            console.log('[INFO] Found Google login button, clicking...');
            await googleButton.click();
            await page.waitForTimeout(3000);
        } else {
            // Maybe we need to click "Continue" or "Authorize" first
            console.log('[INFO] Looking for authorize/continue button...');

            const authorizeBtn = await page.locator('button:has-text("Authorize"), button:has-text("Continue"), button:has-text("Confirm"), button[type="submit"]').first();
            if (await authorizeBtn.isVisible()) {
                console.log('[INFO] Found authorize button, clicking...');
                await authorizeBtn.click();
                await page.waitForTimeout(3000);
            }
        }

        await page.screenshot({ path: 'vercel_after_click.png' });

        // Check if we're now on a Google login page
        const currentUrl = page.url();
        console.log('[INFO] Current URL:', currentUrl);

        if (currentUrl.includes('accounts.google.com')) {
            console.log('[INFO] On Google login page...');
            // Try to select the account if available
            const accountSelector = await page.locator('[data-email="relentlessrobotics@gmail.com"], div:has-text("relentlessrobotics@gmail.com")').first();
            if (await accountSelector.isVisible()) {
                console.log('[INFO] Found account, clicking...');
                await accountSelector.click();
                await page.waitForTimeout(3000);
            }
        }

        // Wait for success or check page state
        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'vercel_final_state.png' });

        const finalUrl = page.url();
        const pageContent = await page.content();

        console.log('[INFO] Final URL:', finalUrl);

        if (pageContent.includes('success') || pageContent.includes('authorized') || pageContent.includes('You can close this')) {
            console.log('[SUCCESS] Vercel authorization completed!');
        } else {
            console.log('[INFO] Page state unclear, check screenshots');
        }

        // Keep browser open for a bit to ensure auth completes
        await page.waitForTimeout(5000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'vercel_error.png' });
    } finally {
        await browser.close();
    }
}

loginVercelWithGoogle().catch(console.error);
