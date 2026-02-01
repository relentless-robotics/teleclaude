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
        const authUrl = 'https://vercel.com/oauth/device?user_code=ZZND-TPWB';
        console.log('[INFO] Navigating to Vercel auth URL...');
        await page.goto(authUrl, { waitUntil: 'networkidle', timeout: 60000 });

        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'vercel_step1.png' });

        // Click "Continue with Google"
        console.log('[INFO] Clicking Continue with Google...');
        await page.click('text=Continue with Google');

        // Wait for navigation to Google
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'vercel_step2_google.png' });

        const currentUrl = page.url();
        console.log('[INFO] Current URL after Google click:', currentUrl);

        // If on Google account chooser
        if (currentUrl.includes('accounts.google.com')) {
            console.log('[INFO] On Google page, looking for account to select...');

            // Try to find and click our account
            try {
                // Look for the email in account list
                const emailDiv = page.locator('div[data-email="relentlessrobotics@gmail.com"]');
                if (await emailDiv.count() > 0) {
                    console.log('[INFO] Found account by data-email, clicking...');
                    await emailDiv.click();
                } else {
                    // Try text matching
                    const accountText = page.locator('text=relentlessrobotics@gmail.com');
                    if (await accountText.count() > 0) {
                        console.log('[INFO] Found account by text, clicking...');
                        await accountText.first().click();
                    } else {
                        console.log('[INFO] Account not found in list, may need manual login');
                        await page.screenshot({ path: 'google_account_chooser.png' });
                    }
                }
            } catch (e) {
                console.log('[WARN] Error selecting account:', e.message);
            }

            await page.waitForTimeout(3000);
            await page.screenshot({ path: 'vercel_step3_after_account.png' });
        }

        // Wait for redirect back to Vercel or for authorization page
        await page.waitForTimeout(5000);
        const newUrl = page.url();
        console.log('[INFO] URL after account selection:', newUrl);

        await page.screenshot({ path: 'vercel_step4.png' });

        // Check if there's an "Authorize" or "Allow" button
        const authButton = page.locator('button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Continue"), button:has-text("Confirm")');
        if (await authButton.count() > 0) {
            console.log('[INFO] Found authorization button, clicking...');
            await authButton.first().click();
            await page.waitForTimeout(3000);
        }

        await page.screenshot({ path: 'vercel_step5_final.png' });

        // Check for success
        const pageContent = await page.content();
        const finalUrl = page.url();
        console.log('[INFO] Final URL:', finalUrl);

        if (pageContent.toLowerCase().includes('success') ||
            pageContent.toLowerCase().includes('authorized') ||
            pageContent.toLowerCase().includes('device authorized') ||
            pageContent.toLowerCase().includes('you can close')) {
            console.log('[SUCCESS] Vercel authorization completed!');
        } else if (pageContent.includes('Welcome to Vercel') || finalUrl.includes('vercel.com/dashboard')) {
            console.log('[SUCCESS] Logged into Vercel!');
        } else {
            console.log('[INFO] Auth may still be in progress, keeping browser open...');
        }

        // Wait longer to ensure token is saved
        console.log('[INFO] Waiting for CLI to receive auth token...');
        await page.waitForTimeout(10000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'vercel_error_final.png' });
    } finally {
        console.log('[INFO] Closing browser...');
        await browser.close();
    }
}

loginVercelWithGoogle().catch(console.error);
