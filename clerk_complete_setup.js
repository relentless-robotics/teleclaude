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

    try {
        // Go directly to Clerk dashboard
        console.log('[INFO] Navigating to Clerk dashboard...');
        await page.goto('https://dashboard.clerk.com', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);

        let currentUrl = page.url();
        console.log('[INFO] Current URL:', currentUrl);

        // If redirected to login, handle it
        if (currentUrl.includes('accounts.clerk.com') || currentUrl.includes('clerk.com/sign')) {
            console.log('[INFO] On login page, clicking Continue with Google...');
            await page.screenshot({ path: 'clerk_login.png' });

            const googleBtn = page.locator('button:has-text("Google"), button:has-text("Continue with Google")');
            if (await googleBtn.count() > 0) {
                await googleBtn.first().click();
                await page.waitForTimeout(5000);
            }
        }

        // Handle Google consent screen - click Continue
        currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com')) {
            console.log('[INFO] On Google consent screen...');
            await page.screenshot({ path: 'google_consent.png' });

            // Click Continue button
            const continueBtn = page.locator('button:has-text("Continue"), span:has-text("Continue")');
            if (await continueBtn.count() > 0) {
                console.log('[INFO] Clicking Continue on Google consent...');
                await continueBtn.first().click();
                await page.waitForTimeout(5000);
            }
        }

        // Wait for redirect back to Clerk
        await page.waitForTimeout(3000);
        currentUrl = page.url();
        console.log('[INFO] After Google auth, URL:', currentUrl);
        await page.screenshot({ path: 'clerk_after_google.png' });

        // If we're in the dashboard, navigate to API keys
        if (currentUrl.includes('dashboard.clerk.com')) {
            console.log('[INFO] In Clerk dashboard!');

            // Go to API keys page
            await page.goto('https://dashboard.clerk.com/last-active?path=api-keys', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(3000);
            await page.screenshot({ path: 'clerk_api_keys_page.png' });

            // Extract keys from the page
            const pageContent = await page.content();
            const pageText = await page.innerText('body');

            // Look for publishable key
            const pkMatch = pageText.match(/pk_(?:test_|live_)[a-zA-Z0-9]+/);
            const skMatch = pageText.match(/sk_(?:test_|live_)[a-zA-Z0-9]+/);

            let publishableKey = null;
            let secretKey = null;

            if (pkMatch) {
                publishableKey = pkMatch[0];
                console.log('[SUCCESS] Found Publishable Key:', publishableKey);
            }

            // Try to copy secret key
            const copyButtons = page.locator('button:has-text("Copy"), [aria-label*="copy"], [title*="Copy"]');
            const copyCount = await copyButtons.count();
            console.log('[INFO] Found', copyCount, 'copy buttons');

            // Click each copy button and try to get the key
            for (let i = 0; i < copyCount; i++) {
                try {
                    await copyButtons.nth(i).click();
                    await page.waitForTimeout(500);
                } catch (e) {
                    // Ignore click errors
                }
            }

            // Try to find secret key input or display
            const secretInputs = page.locator('input[type="password"], input[readonly], [class*="secret"]');
            const secretCount = await secretInputs.count();
            for (let i = 0; i < secretCount; i++) {
                const value = await secretInputs.nth(i).inputValue().catch(() => '');
                if (value.includes('sk_')) {
                    secretKey = value;
                    console.log('[SUCCESS] Found Secret Key:', secretKey);
                    break;
                }
            }

            // Also check for any sk_ pattern in all text content
            const allText = await page.locator('body').allInnerTexts();
            for (const text of allText) {
                const match = text.match(/sk_(?:test_|live_)[a-zA-Z0-9]+/);
                if (match && !secretKey) {
                    secretKey = match[0];
                    console.log('[SUCCESS] Found Secret Key from text:', secretKey);
                }
            }

            // Output the keys
            console.log('\n=== CLERK API KEYS ===');
            console.log('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' + (publishableKey || 'NOT FOUND'));
            console.log('CLERK_SECRET_KEY=' + (secretKey || 'NOT FOUND'));
            console.log('======================\n');

            // Save keys to a file
            if (publishableKey) {
                const keysContent = `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${publishableKey}\nCLERK_SECRET_KEY=${secretKey || 'NEED_TO_COPY_MANUALLY'}`;
                fs.writeFileSync(path.join(__dirname, 'clerk_keys.txt'), keysContent);
                console.log('[INFO] Keys saved to clerk_keys.txt');
            }

        } else {
            console.log('[INFO] Not in dashboard, current URL:', currentUrl);
            await page.screenshot({ path: 'clerk_current_state.png' });
        }

        // Keep browser open briefly
        console.log('[INFO] Waiting 10 seconds...');
        await page.waitForTimeout(10000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'clerk_error_final.png' });
    } finally {
        await browser.close();
    }
}

setupClerk().catch(console.error);
