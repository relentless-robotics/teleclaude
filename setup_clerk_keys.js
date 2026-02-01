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
        // Go to Clerk dashboard
        console.log('[INFO] Navigating to Clerk...');
        await page.goto('https://clerk.com', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'clerk_home.png' });

        // Click Sign In or Get Started
        const signInBtn = page.locator('a:has-text("Sign in"), a:has-text("Sign In"), button:has-text("Sign in")');
        if (await signInBtn.count() > 0) {
            console.log('[INFO] Clicking Sign In...');
            await signInBtn.first().click();
            await page.waitForTimeout(3000);
        } else {
            // Try Get Started or Start Building
            const getStartedBtn = page.locator('a:has-text("Get started"), a:has-text("Start building"), button:has-text("Get started")');
            if (await getStartedBtn.count() > 0) {
                console.log('[INFO] Clicking Get Started...');
                await getStartedBtn.first().click();
                await page.waitForTimeout(3000);
            }
        }

        await page.screenshot({ path: 'clerk_login_page.png' });

        // Look for Continue with Google
        const googleBtn = page.locator('button:has-text("Google"), button:has-text("Continue with Google")');
        if (await googleBtn.count() > 0) {
            console.log('[INFO] Clicking Continue with Google...');
            await googleBtn.first().click();
            await page.waitForTimeout(5000);

            // Handle Google account selection
            const currentUrl = page.url();
            if (currentUrl.includes('accounts.google.com')) {
                console.log('[INFO] On Google page, selecting account...');
                try {
                    await page.click('text=relentlessrobotics@gmail.com');
                    await page.waitForTimeout(3000);
                } catch (e) {
                    console.log('[WARN] Could not click account');
                }
            }
        }

        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'clerk_after_login.png' });

        // Now we should be in the dashboard
        // Check if we need to create an application
        const currentUrl = page.url();
        console.log('[INFO] Current URL:', currentUrl);

        // Navigate to API Keys
        if (currentUrl.includes('dashboard.clerk.com')) {
            console.log('[INFO] In Clerk dashboard!');

            // Look for API Keys link
            const apiKeysLink = page.locator('a:has-text("API Keys"), button:has-text("API Keys")');
            if (await apiKeysLink.count() > 0) {
                console.log('[INFO] Clicking API Keys...');
                await apiKeysLink.first().click();
                await page.waitForTimeout(3000);
            } else {
                // Navigate directly to API keys
                console.log('[INFO] Navigating to API keys page...');
                await page.goto('https://dashboard.clerk.com/last-active?path=api-keys', { waitUntil: 'networkidle' });
                await page.waitForTimeout(3000);
            }

            await page.screenshot({ path: 'clerk_api_keys.png' });

            // Try to extract the keys from the page
            const pageContent = await page.content();

            // Look for publishable key (starts with pk_)
            const pkMatch = pageContent.match(/pk_[a-zA-Z0-9_]+/);
            const skMatch = pageContent.match(/sk_[a-zA-Z0-9_]+/);

            if (pkMatch) {
                console.log('[INFO] Found Publishable Key:', pkMatch[0]);
            }
            if (skMatch) {
                console.log('[INFO] Found Secret Key:', skMatch[0]);
            }

            // Try to reveal the secret key if hidden
            const revealBtn = page.locator('button:has-text("Reveal"), button:has-text("Show"), button:has-text("Copy")');
            if (await revealBtn.count() > 0) {
                console.log('[INFO] Clicking reveal button...');
                await revealBtn.first().click();
                await page.waitForTimeout(2000);
                await page.screenshot({ path: 'clerk_keys_revealed.png' });
            }

            // Get text content from key elements
            const keyElements = await page.locator('[class*="key"], [class*="secret"], code, pre').allTextContents();
            console.log('[INFO] Key elements found:', keyElements.filter(k => k.includes('pk_') || k.includes('sk_')));

        } else {
            console.log('[INFO] Not in dashboard yet, may need to create account or app');
            await page.screenshot({ path: 'clerk_state.png' });
        }

        // Keep browser open for manual verification
        console.log('[INFO] Browser will stay open for 30 seconds for manual verification...');
        await page.waitForTimeout(30000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'clerk_error.png' });
    } finally {
        await browser.close();
    }
}

setupClerk().catch(console.error);
