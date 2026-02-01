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
        await page.screenshot({ path: 'clerk_step1.png' });

        // Click Google button - use more specific selector
        console.log('[INFO] Looking for Google button...');

        // Try multiple selectors
        const selectors = [
            'button:has-text("Google")',
            '[data-provider="google"]',
            'button >> text=Google',
            'div.cl-socialButtonsIconButton >> nth=1', // Google is usually second after GitHub
        ];

        let clicked = false;
        for (const selector of selectors) {
            try {
                const btn = page.locator(selector);
                if (await btn.count() > 0) {
                    console.log('[INFO] Found button with selector:', selector);
                    await btn.first().click({ force: true });
                    clicked = true;
                    break;
                }
            } catch (e) {
                console.log('[DEBUG] Selector failed:', selector);
            }
        }

        if (!clicked) {
            // Last resort - click by coordinates or use JavaScript
            console.log('[INFO] Trying JavaScript click...');
            await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Google')) {
                        btn.click();
                        return;
                    }
                }
            });
        }

        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'clerk_step2_after_google.png' });

        let currentUrl = page.url();
        console.log('[INFO] URL after Google click:', currentUrl);

        // Handle Google OAuth flow
        let attempts = 0;
        while (attempts < 20 && !currentUrl.includes('dashboard.clerk.com/apps')) {
            attempts++;
            currentUrl = page.url();
            console.log('[AUTH]', attempts, '-', currentUrl.substring(0, 80));

            if (currentUrl.includes('accountchooser') || currentUrl.includes('signin/identifier')) {
                console.log('[AUTH] Selecting account...');
                await page.screenshot({ path: `clerk_google_${attempts}.png` });
                try {
                    // Try clicking the account
                    const accountEmail = page.locator('div:has-text("relentlessrobotics@gmail.com")').first();
                    await accountEmail.click();
                } catch (e) {
                    // Try by data attribute
                    try {
                        await page.click('[data-identifier="relentlessrobotics@gmail.com"]');
                    } catch (e2) {
                        // Click any visible account
                        await page.click('.W7Aapd');
                    }
                }
            }

            if (currentUrl.includes('consent') || currentUrl.includes('oauth/id')) {
                console.log('[AUTH] Clicking Continue on consent...');
                await page.screenshot({ path: `clerk_consent_${attempts}.png` });
                try {
                    await page.click('button:has-text("Continue")');
                } catch (e) {
                    await page.click('#submit_approve_access');
                }
            }

            await page.waitForTimeout(2000);

            // Check if we're back on Clerk
            if (currentUrl.includes('dashboard.clerk.com') && !currentUrl.includes('sign')) {
                console.log('[SUCCESS] Back on Clerk dashboard!');
                break;
            }
        }

        await page.waitForTimeout(5000);
        await page.screenshot({ path: 'clerk_step3_after_auth.png' });
        currentUrl = page.url();
        console.log('[INFO] Final URL:', currentUrl);

        // Handle app creation if needed
        if (currentUrl.includes('prepare-account') || currentUrl.includes('onboarding')) {
            console.log('[INFO] On onboarding page...');
            await page.waitForTimeout(2000);

            // Fill in app name if there's an input
            const nameInput = page.locator('input[name="name"], input[placeholder*="name"]');
            if (await nameInput.count() > 0) {
                await nameInput.fill('Period Tracker');
                await page.waitForTimeout(1000);
            }

            // Click continue/create
            const createBtn = page.locator('button:has-text("Create"), button:has-text("Continue"), button[type="submit"]');
            if (await createBtn.count() > 0) {
                await createBtn.first().click();
                await page.waitForTimeout(5000);
            }
        }

        // Get API keys
        await page.waitForTimeout(3000);
        currentUrl = page.url();

        if (currentUrl.includes('dashboard.clerk.com')) {
            console.log('[INFO] Going to API keys page...');
            await page.goto('https://dashboard.clerk.com/last-active?path=api-keys', { waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);
            await page.screenshot({ path: 'clerk_api_keys_final.png' });

            const pageText = await page.innerText('body');

            // Find keys
            const pkMatch = pageText.match(/pk_(?:test_|live_)[a-zA-Z0-9_]+/);
            const skMatch = pageText.match(/sk_(?:test_|live_)[a-zA-Z0-9_]+/);

            if (pkMatch) {
                console.log('\n==========================================');
                console.log('PUBLISHABLE KEY:', pkMatch[0]);
                console.log('==========================================\n');

                let envContent = `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pkMatch[0]}\n`;
                if (skMatch) {
                    console.log('SECRET KEY:', skMatch[0]);
                    envContent += `CLERK_SECRET_KEY=${skMatch[0]}\n`;
                }

                fs.writeFileSync(path.join(__dirname, 'clerk_keys.env'), envContent);
                console.log('[INFO] Keys saved to clerk_keys.env');
            } else {
                console.log('[WARN] Keys not found. Page text:');
                console.log(pageText.substring(0, 500));
            }
        }

        console.log('[INFO] Waiting 30 seconds for manual verification...');
        await page.waitForTimeout(30000);

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'clerk_error.png' });
    } finally {
        await browser.close();
    }
}

signupClerk().catch(console.error);
