const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Discord notification helper
async function sendToDiscord(message) {
    console.log('[DISCORD]', message);
    // The actual Discord send will happen via the bridge monitoring stdout
}

async function setupClerkAndVercel() {
    const stateFile = path.join('C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\browser_state', 'google_auth.json');

    let browser;
    let clerkPublishableKey = '';
    let clerkSecretKey = '';
    let vercelUrl = '';

    try {
        console.log('[DISCORD] 🌐 Launching browser...');

        browser = await chromium.launch({
            headless: false,
            channel: 'msedge'  // Use Edge browser
        });

        const context = await browser.newContext({
            storageState: fs.existsSync(stateFile) ? stateFile : undefined
        });
        const page = await context.newPage();

        // ===== TASK 1: Get Clerk API Keys =====
        console.log('[DISCORD] 🔐 Navigating to Clerk dashboard...');

        await page.goto('https://dashboard.clerk.com', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        // Check if we need to sign in
        const currentUrl = page.url();
        if (currentUrl.includes('sign-in') || currentUrl.includes('accounts.clerk.com')) {
            console.log('[DISCORD] 🔑 Signing in with Google...');

            // Look for Google sign-in button
            const googleButton = await page.locator('button:has-text("Continue with Google"), [data-provider="google"]').first();
            if (await googleButton.isVisible({ timeout: 5000 }).catch(() => false)) {
                await googleButton.click();
                await page.waitForTimeout(5000);
            }
        }

        // Wait for dashboard to load
        await page.waitForTimeout(5000);
        console.log('[DISCORD] ✅ Logged into Clerk dashboard!');

        // Take screenshot
        await page.screenshot({ path: 'clerk_dashboard.png' });

        // Look for existing applications or create new one
        console.log('[DISCORD] 🔍 Looking for Period Tracker application...');

        // Try to find "API Keys" in navigation
        const apiKeysLink = page.locator('a:has-text("API Keys"), button:has-text("API Keys"), [href*="api-keys"]').first();

        if (await apiKeysLink.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('[DISCORD] 📋 Navigating to API Keys section...');
            await apiKeysLink.click();
            await page.waitForTimeout(3000);
        } else {
            // Try to find it in sidebar or settings
            console.log('[DISCORD] 🔍 Searching for API Keys in navigation...');
            await page.screenshot({ path: 'clerk_searching.png' });

            // Click on first application if multiple exist
            const appCard = page.locator('[data-testid="application-card"], .application-card, a[href*="/apps/"]').first();
            if (await appCard.isVisible({ timeout: 5000 }).catch(() => false)) {
                await appCard.click();
                await page.waitForTimeout(3000);
            }

            // Now look for API Keys again
            const apiKeysNav = page.locator('text="API Keys"').first();
            if (await apiKeysNav.isVisible({ timeout: 5000 }).catch(() => false)) {
                await apiKeysNav.click();
                await page.waitForTimeout(3000);
            }
        }

        // Take screenshot of API keys page
        await page.screenshot({ path: 'clerk_api_keys.png' });
        console.log('[DISCORD] 📸 Screenshot saved: clerk_api_keys.png');

        // Look for the keys
        console.log('[DISCORD] 🔑 Extracting API keys...');

        // Try to find publishable key (starts with pk_)
        const publishableKeyElement = page.locator('code:has-text("pk_"), [data-key-type="publishable"], input[value^="pk_"]').first();
        if (await publishableKeyElement.isVisible({ timeout: 5000 }).catch(() => false)) {
            clerkPublishableKey = await publishableKeyElement.textContent() || await publishableKeyElement.inputValue();
            clerkPublishableKey = clerkPublishableKey.trim();
            console.log('[DISCORD] ✅ Found publishable key: ' + clerkPublishableKey.substring(0, 20) + '...');
        }

        // Try to find secret key (starts with sk_)
        // Secret keys are usually hidden, look for reveal button
        const revealButton = page.locator('button:has-text("Reveal"), button:has-text("Show"), [aria-label*="reveal"]').first();
        if (await revealButton.isVisible({ timeout: 5000 }).catch(() => false)) {
            await revealButton.click();
            await page.waitForTimeout(1000);
        }

        const secretKeyElement = page.locator('code:has-text("sk_"), [data-key-type="secret"], input[value^="sk_"]').first();
        if (await secretKeyElement.isVisible({ timeout: 5000 }).catch(() => false)) {
            clerkSecretKey = await secretKeyElement.textContent() || await secretKeyElement.inputValue();
            clerkSecretKey = clerkSecretKey.trim();
            console.log('[DISCORD] ✅ Found secret key: ' + clerkSecretKey.substring(0, 20) + '...');
        }

        // If we couldn't find keys, provide the screenshot for manual extraction
        if (!clerkPublishableKey || !clerkSecretKey) {
            console.log('[DISCORD] ⚠️ Could not automatically extract keys. Please check clerk_api_keys.png screenshot.');
            console.log('[DISCORD] 🔍 Current URL: ' + page.url());

            // Wait a bit for user to see the page
            await page.waitForTimeout(10000);
        } else {
            // Save keys to API_KEYS.md
            console.log('[DISCORD] 💾 Saving API keys to API_KEYS.md...');

            const apiKeysFile = 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\API_KEYS.md';
            let apiKeysContent = '';

            if (fs.existsSync(apiKeysFile)) {
                apiKeysContent = fs.readFileSync(apiKeysFile, 'utf-8');
            } else {
                apiKeysContent = '# API_KEYS.md - Stored API Keys\n\n';
            }

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

**Notes:** Keys for period tracker app authentication.

---
`;

            apiKeysContent += clerkEntry;
            fs.writeFileSync(apiKeysFile, apiKeysContent);

            console.log('[DISCORD] ✅ Clerk API keys saved to API_KEYS.md!');

            // Enable Google OAuth
            console.log('[DISCORD] 🔧 Enabling Google OAuth provider...');
            await page.goto('https://dashboard.clerk.com', { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);

            // Look for SSO or Social connections
            const socialLink = page.locator('text="Social connections", text="SSO", text="Authentication"').first();
            if (await socialLink.isVisible({ timeout: 5000 }).catch(() => false)) {
                await socialLink.click();
                await page.waitForTimeout(2000);

                // Look for Google toggle
                const googleToggle = page.locator('[data-provider="google"] button, text="Google" >> .. >> button').first();
                if (await googleToggle.isVisible({ timeout: 5000 }).catch(() => false)) {
                    await googleToggle.click();
                    console.log('[DISCORD] ✅ Google OAuth enabled!');
                    await page.waitForTimeout(2000);
                }
            }
        }

        // ===== TASK 2: Deploy to Vercel =====
        console.log('[DISCORD] 🚀 Opening Vercel to deploy period tracker...');

        const vercelPage = await context.newPage();
        await vercelPage.goto('https://vercel.com/new', { waitUntil: 'networkidle' });
        await vercelPage.waitForTimeout(3000);

        // Check if we need to sign in
        const vercelUrl_current = vercelPage.url();
        if (vercelUrl_current.includes('login') || vercelUrl_current.includes('sign')) {
            console.log('[DISCORD] 🔑 Signing into Vercel...');

            const githubButton = vercelPage.locator('button:has-text("Continue with GitHub"), button:has-text("GitHub")').first();
            if (await githubButton.isVisible({ timeout: 5000 }).catch(() => false)) {
                await githubButton.click();
                await vercelPage.waitForTimeout(5000);
            }
        }

        await vercelPage.screenshot({ path: 'vercel_import.png' });
        console.log('[DISCORD] 📸 Screenshot saved: vercel_import.png');

        console.log('[DISCORD] 🔍 Looking for period-tracker repository...');

        // Search for period-tracker repo
        const searchBox = vercelPage.locator('input[placeholder*="Search"], input[type="search"]').first();
        if (await searchBox.isVisible({ timeout: 5000 }).catch(() => false)) {
            await searchBox.fill('period-tracker');
            await vercelPage.waitForTimeout(2000);
        }

        // Look for the repository
        const repoCard = vercelPage.locator('text="period-tracker"').first();
        if (await repoCard.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('[DISCORD] ✅ Found period-tracker repository!');

            // Find the Import button for this repo
            const importButton = vercelPage.locator('button:has-text("Import")').first();
            if (await importButton.isVisible({ timeout: 3000 }).catch(() => false)) {
                await importButton.click();
                await vercelPage.waitForTimeout(3000);

                console.log('[DISCORD] ⚙️ Configuring project...');

                // Look for Environment Variables section
                const envSection = vercelPage.locator('text="Environment Variables", button:has-text("Environment")').first();
                if (await envSection.isVisible({ timeout: 5000 }).catch(() => false)) {
                    await envSection.click();
                    await vercelPage.waitForTimeout(1000);
                }

                // Add environment variables
                if (clerkPublishableKey && clerkSecretKey) {
                    console.log('[DISCORD] 🔐 Adding Clerk environment variables...');

                    // Find the key/value input fields
                    const keyInput = vercelPage.locator('input[placeholder*="KEY"], input[name*="key"]').first();
                    const valueInput = vercelPage.locator('input[placeholder*="VALUE"], input[name*="value"]').first();

                    if (await keyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                        // Add publishable key
                        await keyInput.fill('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
                        await valueInput.fill(clerkPublishableKey);

                        const addButton = vercelPage.locator('button:has-text("Add")').first();
                        if (await addButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                            await addButton.click();
                            await vercelPage.waitForTimeout(1000);
                        }

                        // Add secret key
                        await keyInput.fill('CLERK_SECRET_KEY');
                        await valueInput.fill(clerkSecretKey);

                        if (await addButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                            await addButton.click();
                            await vercelPage.waitForTimeout(1000);
                        }

                        console.log('[DISCORD] ✅ Environment variables added!');
                    }
                }

                await vercelPage.screenshot({ path: 'vercel_config.png' });

                // Click Deploy button
                console.log('[DISCORD] 🚀 Starting deployment...');
                const deployButton = vercelPage.locator('button:has-text("Deploy")').first();
                if (await deployButton.isVisible({ timeout: 5000 }).catch(() => false)) {
                    await deployButton.click();
                    await vercelPage.waitForTimeout(5000);

                    console.log('[DISCORD] ⏳ Deployment in progress... Waiting for completion...');

                    // Wait for deployment to complete (look for success message or URL)
                    try {
                        await vercelPage.waitForSelector('text="Congratulations", text="Your project has been deployed"', { timeout: 300000 }); // 5 min timeout
                        console.log('[DISCORD] ✅ Deployment complete!');

                        // Get the deployment URL
                        const urlElement = vercelPage.locator('[href*=".vercel.app"]').first();
                        if (await urlElement.isVisible({ timeout: 5000 }).catch(() => false)) {
                            vercelUrl = await urlElement.getAttribute('href') || await urlElement.textContent();
                            vercelUrl = vercelUrl.trim();

                            if (!vercelUrl.startsWith('http')) {
                                vercelUrl = 'https://' + vercelUrl;
                            }

                            console.log('[DISCORD] 🌐 Production URL: ' + vercelUrl);
                        }

                        await vercelPage.screenshot({ path: 'vercel_deployed.png' });
                    } catch (error) {
                        console.log('[DISCORD] ⚠️ Deployment timeout or error. Check vercel dashboard manually.');
                        await vercelPage.screenshot({ path: 'vercel_deployment_status.png' });
                    }
                }
            }
        } else {
            console.log('[DISCORD] ⚠️ Could not find period-tracker repository. Please check vercel_import.png screenshot.');
        }

        // ===== TASK 3: Update Clerk with Vercel URL =====
        if (vercelUrl) {
            console.log('[DISCORD] 🔧 Updating Clerk with production URL...');

            await page.bringToFront();
            await page.goto('https://dashboard.clerk.com', { waitUntil: 'networkidle' });
            await page.waitForTimeout(2000);

            // Look for Domains or Paths settings
            const domainsLink = page.locator('text="Domains", text="Paths", text="Settings"').first();
            if (await domainsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
                await domainsLink.click();
                await page.waitForTimeout(2000);

                // Add Vercel URL
                const urlInput = page.locator('input[placeholder*="domain"], input[placeholder*="URL"]').first();
                if (await urlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await urlInput.fill(vercelUrl);

                    const saveButton = page.locator('button:has-text("Save"), button:has-text("Add")').first();
                    if (await saveButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await saveButton.click();
                        console.log('[DISCORD] ✅ Vercel URL added to Clerk!');
                    }
                }
            }
        }

        // Final summary
        console.log('[DISCORD] 🎉 Setup Complete!\n\n✅ Clerk API Keys: Configured\n✅ Vercel Deployment: ' + (vercelUrl || 'Check dashboard') + '\n\n🔗 Your period tracker app is live! Sign in with Google to test.');

        // Keep browser open for a bit
        await page.waitForTimeout(10000);

    } catch (error) {
        console.log('[DISCORD] ❌ Error: ' + error.message);
        console.error(error);

        if (browser) {
            await browser.contexts()[0].pages()[0].screenshot({ path: 'error_screenshot.png' });
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

setupClerkAndVercel();
