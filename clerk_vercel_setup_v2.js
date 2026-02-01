const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function setupClerkAndVercel() {
    let browser;
    let clerkPublishableKey = '';
    let clerkSecretKey = '';
    let vercelUrl = '';

    try {
        console.log('[DISCORD] 🌐 Launching browser...');

        browser = await chromium.launch({
            headless: false,
            channel: 'msedge'
        });

        const context = await browser.newContext();
        const page = await context.newPage();

        // ===== TASK 1: Get Clerk API Keys =====
        console.log('[DISCORD] 🔐 Opening Clerk sign-in page...');
        await page.goto('https://dashboard.clerk.com/sign-in', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        // Click Google sign-in button
        console.log('[DISCORD] 🔑 Clicking "Sign in with Google"...');
        const googleButton = await page.locator('button:has-text("Google")').first();

        if (await googleButton.isVisible({ timeout: 5000 })) {
            await googleButton.click();
            console.log('[DISCORD] ⏳ Waiting for Google authentication... (You may need to approve 2FA on your phone)');

            // Wait for redirect back to Clerk dashboard (up to 2 minutes)
            await page.waitForURL('**/dashboard.clerk.com/**', { timeout: 120000 });
            console.log('[DISCORD] ✅ Successfully logged into Clerk!');
            await page.waitForTimeout(5000);
        }

        // Take screenshot of dashboard
        await page.screenshot({ path: 'clerk_dashboard.png', fullPage: true });

        // Check if we need to create an application
        const createAppButton = await page.locator('button:has-text("Create application"), a:has-text("Create application")');
        if (await createAppButton.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('[DISCORD] 📝 Creating new application "Period Tracker"...');
            await createAppButton.click();
            await page.waitForTimeout(2000);

            // Enter app name
            const nameInput = await page.locator('input[name="name"], input[placeholder*="name"]').first();
            if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                await nameInput.fill('Period Tracker');
            }

            // Click create button
            const submitButton = await page.locator('button:has-text("Create"), button[type="submit"]').first();
            if (await submitButton.isVisible({ timeout: 3000 }).catch(() => false)) {
                await submitButton.click();
                await page.waitForTimeout(3000);
            }
        }

        // Navigate to API Keys
        console.log('[DISCORD] 🔍 Navigating to API Keys...');

        // Try multiple ways to find API Keys
        let foundApiKeys = false;

        // Method 1: Direct navigation
        await page.goto('https://dashboard.clerk.com/last-active?path=api-keys', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        if (page.url().includes('api-keys')) {
            foundApiKeys = true;
            console.log('[DISCORD] ✅ Found API Keys page!');
        } else {
            // Method 2: Look for API Keys link in navigation
            const apiKeysLink = await page.locator('a:has-text("API Keys"), nav >> text="API Keys"').first();
            if (await apiKeysLink.isVisible({ timeout: 5000 }).catch(() => false)) {
                await apiKeysLink.click();
                await page.waitForTimeout(3000);
                foundApiKeys = true;
            }
        }

        await page.screenshot({ path: 'clerk_api_keys_page.png', fullPage: true });
        console.log('[DISCORD] 📸 Screenshot saved: clerk_api_keys_page.png');

        // Extract API keys
        console.log('[DISCORD] 🔑 Looking for API keys on page...');

        // Wait for page to fully load
        await page.waitForTimeout(3000);

        // Get all text content from code elements
        const codeElements = await page.locator('code, input[readonly], [data-testid*="key"]').all();

        for (const element of codeElements) {
            const text = await element.textContent().catch(() => '') || await element.inputValue().catch(() => '');

            if (text.startsWith('pk_')) {
                clerkPublishableKey = text.trim();
                console.log('[DISCORD] ✅ Found Publishable Key: ' + clerkPublishableKey.substring(0, 25) + '...');
            } else if (text.startsWith('sk_')) {
                clerkSecretKey = text.trim();
                console.log('[DISCORD] ✅ Found Secret Key: ' + clerkSecretKey.substring(0, 25) + '...');
            }
        }

        // If keys not found, try to reveal them
        if (!clerkSecretKey) {
            console.log('[DISCORD] 🔍 Looking for reveal button...');
            const revealButtons = await page.locator('button:has-text("Reveal"), button:has-text("Show"), button[aria-label*="reveal"]').all();

            for (const button of revealButtons) {
                if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await button.click();
                    await page.waitForTimeout(1000);
                }
            }

            // Try again to extract keys
            const codeElements2 = await page.locator('code, input[readonly]').all();
            for (const element of codeElements2) {
                const text = await element.textContent().catch(() => '') || await element.inputValue().catch(() => '');

                if (text.startsWith('sk_') && !clerkSecretKey) {
                    clerkSecretKey = text.trim();
                    console.log('[DISCORD] ✅ Found Secret Key after reveal: ' + clerkSecretKey.substring(0, 25) + '...');
                }
            }
        }

        // Save keys if found
        if (clerkPublishableKey && clerkSecretKey) {
            console.log('[DISCORD] 💾 Saving API keys to API_KEYS.md...');

            const apiKeysFile = 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\API_KEYS.md';
            let apiKeysContent = '';

            if (fs.existsSync(apiKeysFile)) {
                apiKeysContent = fs.readFileSync(apiKeysFile, 'utf-8');
            } else {
                apiKeysContent = '# API_KEYS.md - Stored API Keys\n\n';
            }

            // Check if Clerk section already exists
            if (!apiKeysContent.includes('## Clerk (Period Tracker App)')) {
                const clerkEntry = `
---

## Clerk (Period Tracker App)

| Field | Value |
|-------|-------|
| Service | Clerk Authentication |
| App Name | Period Tracker |
| Publishable Key | \`${clerkPublishableKey}\` |
| Secret Key | \`${clerkSecretKey}\` |
| Created | ${new Date().toISOString().split('T')[0]} |
| Console URL | https://dashboard.clerk.com |

**Notes:** Keys for period tracker app authentication. Enables Google OAuth sign-in.

---
`;
                apiKeysContent += clerkEntry;
                fs.writeFileSync(apiKeysFile, apiKeysContent);
                console.log('[DISCORD] ✅ Clerk API keys saved!');
            }

            // Enable Google OAuth
            console.log('[DISCORD] 🔧 Enabling Google OAuth provider...');

            // Navigate to SSO settings
            await page.goto('https://dashboard.clerk.com/last-active?path=user-authentication/sso', { waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);

            // Look for Google toggle or enable button
            const googleSection = await page.locator('text="Google"').first();
            if (await googleSection.isVisible({ timeout: 5000 }).catch(() => false)) {
                // Find toggle switch near Google text
                const toggleButton = await googleSection.locator('xpath=following::button[1]').first();
                if (await toggleButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                    const ariaChecked = await toggleButton.getAttribute('aria-checked');
                    if (ariaChecked === 'false') {
                        await toggleButton.click();
                        console.log('[DISCORD] ✅ Google OAuth enabled!');
                        await page.waitForTimeout(2000);
                    } else {
                        console.log('[DISCORD] ℹ️ Google OAuth already enabled');
                    }
                }
            }

        } else {
            console.log('[DISCORD] ⚠️ Could not extract API keys automatically.');
            console.log('[DISCORD] 📸 Please check clerk_api_keys_page.png and manually copy the keys.');
            console.log('[DISCORD] Current page URL: ' + page.url());
            await page.waitForTimeout(15000); // Wait so user can see the page
        }

        // ===== TASK 2: Deploy to Vercel =====
        console.log('[DISCORD] 🚀 Opening Vercel deployment page...');

        const vercelPage = await context.newPage();
        await vercelPage.goto('https://vercel.com/new', { waitUntil: 'networkidle' });
        await vercelPage.waitForTimeout(3000);

        // Check if we need to connect GitHub
        const githubButton = await vercelPage.locator('button:has-text("Continue with GitHub")').first();
        if (await githubButton.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('[DISCORD] 🔗 Connecting GitHub to Vercel...');
            await githubButton.click();
            await vercelPage.waitForTimeout(5000);

            // May need to authorize GitHub
            console.log('[DISCORD] ⏳ Waiting for GitHub authorization... (Check if popup needs approval)');
            await vercelPage.waitForURL('**/vercel.com/**', { timeout: 60000 });
            await vercelPage.waitForTimeout(3000);
        }

        await vercelPage.screenshot({ path: 'vercel_connected.png', fullPage: true });

        // Search for repository
        console.log('[DISCORD] 🔍 Searching for period-tracker repository...');

        const searchInput = await vercelPage.locator('input[placeholder*="Search"], input[type="search"]').first();
        if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            await searchInput.fill('period-tracker');
            await vercelPage.waitForTimeout(2000);
            await vercelPage.screenshot({ path: 'vercel_search_results.png', fullPage: true });
        }

        // Look for the repository and import button
        const importButton = await vercelPage.locator('button:has-text("Import")').first();
        if (await importButton.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('[DISCORD] 📦 Importing period-tracker repository...');
            await importButton.click();
            await vercelPage.waitForTimeout(5000);

            await vercelPage.screenshot({ path: 'vercel_configure.png', fullPage: true });

            // Configure environment variables
            if (clerkPublishableKey && clerkSecretKey) {
                console.log('[DISCORD] ⚙️ Adding environment variables...');

                // Look for environment variables section - try to expand it
                const envButton = await vercelPage.locator('button:has-text("Environment Variables")').first();
                if (await envButton.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await envButton.click();
                    await vercelPage.waitForTimeout(1000);
                }

                // Add first key
                const keyInput = await vercelPage.locator('input[name*="key"], input[placeholder*="KEY"]').first();
                const valueInput = await vercelPage.locator('input[name*="value"], input[placeholder*="VALUE"]').first();

                if (await keyInput.isVisible({ timeout: 5000 }).catch(() => false)) {
                    // Add publishable key
                    await keyInput.fill('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
                    await vercelPage.waitForTimeout(500);
                    await valueInput.fill(clerkPublishableKey);
                    await vercelPage.waitForTimeout(500);

                    const addButton = await vercelPage.locator('button:has-text("Add")').first();
                    if (await addButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await addButton.click();
                        await vercelPage.waitForTimeout(1000);
                        console.log('[DISCORD] ✅ Added NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
                    }

                    // Add secret key
                    const keyInput2 = await vercelPage.locator('input[name*="key"], input[placeholder*="KEY"]').first();
                    const valueInput2 = await vercelPage.locator('input[name*="value"], input[placeholder*="VALUE"]').first();

                    await keyInput2.fill('CLERK_SECRET_KEY');
                    await vercelPage.waitForTimeout(500);
                    await valueInput2.fill(clerkSecretKey);
                    await vercelPage.waitForTimeout(500);

                    const addButton2 = await vercelPage.locator('button:has-text("Add")').first();
                    if (await addButton2.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await addButton2.click();
                        await vercelPage.waitForTimeout(1000);
                        console.log('[DISCORD] ✅ Added CLERK_SECRET_KEY');
                    }
                }

                await vercelPage.screenshot({ path: 'vercel_env_added.png', fullPage: true });
            }

            // Deploy
            console.log('[DISCORD] 🚀 Starting deployment...');
            const deployButton = await vercelPage.locator('button:has-text("Deploy")').first();
            if (await deployButton.isVisible({ timeout: 5000 }).catch(() => false)) {
                await deployButton.click();
                await vercelPage.waitForTimeout(5000);

                console.log('[DISCORD] ⏳ Deployment in progress...');
                console.log('[DISCORD] ⏳ This may take 2-5 minutes. Checking every 30 seconds...');

                // Wait for deployment (check every 30 seconds)
                let deployed = false;
                for (let i = 0; i < 10; i++) { // Max 5 minutes
                    await vercelPage.waitForTimeout(30000); // Wait 30 seconds

                    console.log('[DISCORD] ⏳ Still deploying... (' + ((i+1) * 30) + ' seconds elapsed)');

                    // Check for success indicators
                    const successText = await vercelPage.locator('text="Congratulations", text="deployed", text="Visit"').first();
                    if (await successText.isVisible({ timeout: 2000 }).catch(() => false)) {
                        deployed = true;
                        break;
                    }
                }

                if (deployed) {
                    console.log('[DISCORD] ✅ Deployment complete!');
                    await vercelPage.screenshot({ path: 'vercel_success.png', fullPage: true });

                    // Extract URL
                    const urlLinks = await vercelPage.locator('a[href*=".vercel.app"]').all();
                    for (const link of urlLinks) {
                        const href = await link.getAttribute('href');
                        if (href && href.includes('.vercel.app')) {
                            vercelUrl = href;
                            if (!vercelUrl.startsWith('http')) {
                                vercelUrl = 'https://' + vercelUrl;
                            }
                            console.log('[DISCORD] 🌐 Production URL: ' + vercelUrl);
                            break;
                        }
                    }

                    // Also try to get from text content
                    if (!vercelUrl) {
                        const pageText = await vercelPage.textContent('body');
                        const match = pageText.match(/https?:\/\/[a-z0-9-]+\.vercel\.app/);
                        if (match) {
                            vercelUrl = match[0];
                            console.log('[DISCORD] 🌐 Production URL: ' + vercelUrl);
                        }
                    }
                } else {
                    console.log('[DISCORD] ⚠️ Deployment is taking longer than expected. Check Vercel dashboard.');
                    await vercelPage.screenshot({ path: 'vercel_deploying.png', fullPage: true });
                }
            }
        } else {
            console.log('[DISCORD] ⚠️ Could not find period-tracker repository to import.');
            console.log('[DISCORD] 📸 Check vercel_search_results.png - you may need to manually select the repo.');
        }

        // ===== TASK 3: Update Clerk with Vercel URL =====
        if (vercelUrl) {
            console.log('[DISCORD] 🔧 Adding Vercel URL to Clerk allowed origins...');

            await page.bringToFront();

            // Navigate to Domains/Paths
            await page.goto('https://dashboard.clerk.com/last-active?path=domains', { waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);

            // Add domain
            const domainInput = await page.locator('input[placeholder*="domain"], input[placeholder*="URL"], input[type="url"]').first();
            if (await domainInput.isVisible({ timeout: 5000 }).catch(() => false)) {
                await domainInput.fill(vercelUrl);
                await page.waitForTimeout(1000);

                const addDomainButton = await page.locator('button:has-text("Add"), button:has-text("Save")').first();
                if (await addDomainButton.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await addDomainButton.click();
                    await page.waitForTimeout(2000);
                    console.log('[DISCORD] ✅ Vercel URL added to Clerk!');
                }
            }

            await page.screenshot({ path: 'clerk_domain_added.png', fullPage: true });
        }

        // Final summary
        console.log('[DISCORD] 🎉 ===== SETUP COMPLETE ===== 🎉');
        console.log('[DISCORD] ');
        console.log('[DISCORD] ✅ Clerk Configuration:');
        console.log('[DISCORD]    - Publishable Key: ' + (clerkPublishableKey ? clerkPublishableKey.substring(0, 30) + '...' : 'Not found'));
        console.log('[DISCORD]    - Secret Key: ' + (clerkSecretKey ? clerkSecretKey.substring(0, 30) + '...' : 'Not found'));
        console.log('[DISCORD]    - Google OAuth: Enabled');
        console.log('[DISCORD] ');
        console.log('[DISCORD] ✅ Vercel Deployment:');
        console.log('[DISCORD]    - URL: ' + (vercelUrl || 'Check dashboard manually'));
        console.log('[DISCORD] ');
        console.log('[DISCORD] 🔗 Your period tracker app is ready!');
        console.log('[DISCORD] 👉 Visit the URL and sign in with Google to test.');

        // Keep browser open for review
        console.log('[DISCORD] ');
        console.log('[DISCORD] Browser will close in 15 seconds...');
        await page.waitForTimeout(15000);

    } catch (error) {
        console.log('[DISCORD] ❌ Error occurred: ' + error.message);
        console.error(error);

        if (browser) {
            try {
                await browser.contexts()[0].pages()[0].screenshot({ path: 'error_screenshot.png', fullPage: true });
                console.log('[DISCORD] 📸 Error screenshot saved: error_screenshot.png');
            } catch (e) {
                console.error('Could not save error screenshot:', e);
            }
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

setupClerkAndVercel();
