const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise(resolve => {
        rl.question(prompt, resolve);
    });
}

async function setupWithManualAssist() {
    let browser;

    try {
        console.log('[DISCORD] 🌐 Launching browser...');

        browser = await chromium.launch({
            headless: false,
            channel: 'msedge'
        });

        const context = await browser.newContext();

        // ===== CLERK SETUP =====
        console.log('[DISCORD] 🔐 Opening Clerk dashboard...');
        const clerkPage = await context.newPage();
        await clerkPage.goto('https://dashboard.clerk.com', { waitUntil: 'networkidle' });
        await clerkPage.waitForTimeout(3000);

        console.log('[DISCORD] ⏸️  Please sign into Clerk manually in the browser if needed.');
        console.log('[DISCORD] ⏸️  Then navigate to: API Keys section');
        await question('Press ENTER when you are on the API Keys page and can see the keys...');

        console.log('[DISCORD] 🔑 Extracting API keys from page...');
        await clerkPage.waitForTimeout(2000);

        // Take screenshot
        await clerkPage.screenshot({ path: 'clerk_manual_api_keys.png', fullPage: true });

        // Try to extract keys
        let clerkPublishableKey = '';
        let clerkSecretKey = '';

        // Get all text on page and search for keys
        const pageContent = await clerkPage.content();

        // Look for pk_ pattern
        const pkMatch = pageContent.match(/pk_[a-zA-Z0-9_-]+/);
        if (pkMatch) {
            clerkPublishableKey = pkMatch[0];
            console.log('[DISCORD] ✅ Found Publishable Key: ' + clerkPublishableKey.substring(0, 30) + '...');
        }

        // Look for sk_ pattern
        const skMatch = pageContent.match(/sk_[a-zA-Z0-9_-]+/);
        if (skMatch) {
            clerkSecretKey = skMatch[0];
            console.log('[DISCORD] ✅ Found Secret Key: ' + clerkSecretKey.substring(0, 30) + '...');
        }

        // If not found, try to get from code elements
        if (!clerkPublishableKey || !clerkSecretKey) {
            const codeElements = await clerkPage.locator('code, pre, input[readonly], [class*="key"]').all();

            for (const element of codeElements) {
                const text = await element.textContent().catch(() => '') || await element.inputValue().catch(() => '');

                if (text.startsWith('pk_') && !clerkPublishableKey) {
                    clerkPublishableKey = text.trim();
                    console.log('[DISCORD] ✅ Found Publishable Key from element: ' + clerkPublishableKey.substring(0, 30) + '...');
                }
                if (text.startsWith('sk_') && !clerkSecretKey) {
                    clerkSecretKey = text.trim();
                    console.log('[DISCORD] ✅ Found Secret Key from element: ' + clerkSecretKey.substring(0, 30) + '...');
                }
            }
        }

        // Manual fallback
        if (!clerkPublishableKey) {
            console.log('[DISCORD] ⚠️ Could not auto-extract publishable key');
            clerkPublishableKey = await question('Please paste the NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (starts with pk_): ');
        }

        if (!clerkSecretKey) {
            console.log('[DISCORD] ⚠️ Could not auto-extract secret key');
            clerkSecretKey = await question('Please paste the CLERK_SECRET_KEY (starts with sk_): ');
        }

        // Save to API_KEYS.md
        if (clerkPublishableKey && clerkSecretKey) {
            console.log('[DISCORD] 💾 Saving API keys to API_KEYS.md...');

            const apiKeysFile = 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\API_KEYS.md';
            let apiKeysContent = '';

            if (fs.existsSync(apiKeysFile)) {
                apiKeysContent = fs.readFileSync(apiKeysFile, 'utf-8');
            } else {
                apiKeysContent = '# API_KEYS.md - Stored API Keys\n\n';
            }

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

**Notes:** Keys for period tracker app authentication.

---
`;
                apiKeysContent += clerkEntry;
                fs.writeFileSync(apiKeysFile, apiKeysContent);
                console.log('[DISCORD] ✅ Clerk API keys saved!');
            }
        }

        // ===== VERCEL SETUP =====
        console.log('[DISCORD] 🚀 Opening Vercel import page...');
        const vercelPage = await context.newPage();
        await vercelPage.goto('https://vercel.com/new', { waitUntil: 'networkidle' });
        await vercelPage.waitForTimeout(3000);

        console.log('[DISCORD] ⏸️  Please sign into Vercel and import the period-tracker repository.');
        console.log('[DISCORD] ⏸️  Add these environment variables:');
        console.log('[DISCORD]      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = ' + clerkPublishableKey);
        console.log('[DISCORD]      CLERK_SECRET_KEY = ' + clerkSecretKey);

        await question('Press ENTER when you have configured the environment variables and are ready to deploy...');

        console.log('[DISCORD] ⏸️  Click Deploy button in Vercel now.');
        await question('Press ENTER after deployment starts...');

        console.log('[DISCORD] ⏳ Waiting for deployment to complete...');
        console.log('[DISCORD] ⏳ I\'ll check every 30 seconds for up to 5 minutes...');

        let vercelUrl = '';
        let deployed = false;

        for (let i = 0; i < 10; i++) {
            await vercelPage.waitForTimeout(30000); // Wait 30 seconds

            console.log('[DISCORD] ⏳ Checking deployment status... (' + ((i+1) * 30) + ' seconds elapsed)');

            // Check for success
            const pageText = await vercelPage.textContent('body');

            if (pageText.includes('Congratulations') || pageText.includes('deployed successfully') || pageText.includes('Visit')) {
                deployed = true;
                console.log('[DISCORD] ✅ Deployment appears complete!');

                // Try to extract URL
                const urlMatch = pageText.match(/https?:\/\/[a-z0-9-]+\.vercel\.app/);
                if (urlMatch) {
                    vercelUrl = urlMatch[0];
                    console.log('[DISCORD] 🌐 Found URL: ' + vercelUrl);
                }

                // Also try from href
                const urlLinks = await vercelPage.locator('a[href*=".vercel.app"]').all();
                for (const link of urlLinks) {
                    const href = await link.getAttribute('href');
                    if (href && href.includes('.vercel.app')) {
                        vercelUrl = href.startsWith('http') ? href : 'https://' + href;
                        console.log('[DISCORD] 🌐 Production URL: ' + vercelUrl);
                        break;
                    }
                }

                break;
            }
        }

        if (!deployed) {
            console.log('[DISCORD] ⚠️ Still deploying or deployment status unclear.');
            await vercelPage.screenshot({ path: 'vercel_status.png', fullPage: true });
            console.log('[DISCORD] 📸 Screenshot saved: vercel_status.png');
        }

        if (!vercelUrl) {
            vercelUrl = await question('Please paste the Vercel deployment URL (e.g., https://period-tracker-xyz.vercel.app): ');
        }

        await vercelPage.screenshot({ path: 'vercel_final.png', fullPage: true });

        // ===== UPDATE CLERK WITH VERCEL URL =====
        if (vercelUrl) {
            console.log('[DISCORD] 🔧 Adding Vercel URL to Clerk...');

            await clerkPage.bringToFront();
            console.log('[DISCORD] ⏸️  Please add this URL to Clerk allowed domains: ' + vercelUrl);
            console.log('[DISCORD] ⏸️  Navigate to: Domains or Settings in Clerk dashboard');

            await question('Press ENTER after you\'ve added the Vercel URL to Clerk...');

            console.log('[DISCORD] ✅ Clerk domain configuration complete!');
        }

        // ===== FINAL SUMMARY =====
        console.log('[DISCORD] ');
        console.log('[DISCORD] 🎉 ===== SETUP COMPLETE ===== 🎉');
        console.log('[DISCORD] ');
        console.log('[DISCORD] ✅ Clerk API Keys: Configured and saved');
        console.log('[DISCORD]    - Publishable: ' + clerkPublishableKey.substring(0, 35) + '...');
        console.log('[DISCORD]    - Secret: ' + clerkSecretKey.substring(0, 35) + '...');
        console.log('[DISCORD] ');
        console.log('[DISCORD] ✅ Vercel Deployment: ' + vercelUrl);
        console.log('[DISCORD] ');
        console.log('[DISCORD] 🔗 Your period tracker app is live!');
        console.log('[DISCORD] 👉 Visit: ' + vercelUrl);
        console.log('[DISCORD] 👉 Sign in with Google to test authentication');
        console.log('[DISCORD] ');
        console.log('[DISCORD] Browser will close in 10 seconds...');

        await clerkPage.waitForTimeout(10000);

    } catch (error) {
        console.log('[DISCORD] ❌ Error: ' + error.message);
        console.error(error);
    } finally {
        rl.close();
        if (browser) {
            await browser.close();
        }
    }
}

setupWithManualAssist();
