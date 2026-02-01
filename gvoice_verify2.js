const { chromium } = require('playwright');

const VERIFICATION_CODE = '788494';
const TARGET_NUMBER = '(407) 308-5584';
const EMAIL = 'relentlessrobotics@gmail.com';
const PASSWORD = 'Relaxing41!';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('Starting Google Voice verification...');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 300
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    try {
        // Go directly to Google Voice console (this will redirect to sign in if needed)
        console.log('Navigating to Google Voice console...');
        await page.goto('https://voice.google.com/u/0/calls', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);

        let currentUrl = page.url();
        console.log('Current URL:', currentUrl);

        // Handle sign in if needed
        if (currentUrl.includes('accounts.google.com')) {
            console.log('Need to sign in...');

            // Wait for and enter email
            await page.waitForSelector('input[type="email"]', { timeout: 10000 });
            console.log('Entering email...');
            await page.fill('input[type="email"]', EMAIL);
            await page.click('#identifierNext');
            await sleep(4000);

            // Wait for password field
            console.log('Waiting for password field...');
            await page.waitForSelector('input[type="password"]:visible', { timeout: 15000 });
            console.log('Entering password...');
            await page.fill('input[type="password"]', PASSWORD);
            await page.click('#passwordNext');
            await sleep(5000);

            // Check current URL
            currentUrl = page.url();
            console.log('After password URL:', currentUrl);

            // Handle 2FA if present
            if (currentUrl.includes('challenge') || currentUrl.includes('signin/v2/challenge')) {
                console.log('2FA challenge detected - please approve on your device!');
                // Wait up to 60 seconds for 2FA approval
                for (let i = 0; i < 12; i++) {
                    await sleep(5000);
                    currentUrl = page.url();
                    console.log('Waiting for 2FA... URL:', currentUrl);
                    if (!currentUrl.includes('challenge')) {
                        console.log('2FA approved!');
                        break;
                    }
                }
            }
        }

        // Now check if we're on Google Voice
        await sleep(3000);
        currentUrl = page.url();
        console.log('After login URL:', currentUrl);

        // Take screenshot
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_after_login.png' });
        console.log('Screenshot saved: gvoice_after_login.png');

        // If we're on the workspace marketing page, click Sign in
        if (currentUrl.includes('workspace.google.com')) {
            console.log('On workspace page, looking for Sign in button...');
            const signInBtn = await page.$('a:has-text("Sign in"), button:has-text("Sign in")');
            if (signInBtn) {
                await signInBtn.click();
                await sleep(5000);
                currentUrl = page.url();
                console.log('After clicking Sign in:', currentUrl);
            }
        }

        // Look for verification code field
        console.log('Looking for verification code input...');

        // Try various selectors for the code input
        const codeSelectors = [
            'input[type="tel"]',
            'input[maxlength="6"]',
            'input[aria-label*="code" i]',
            'input[placeholder*="code" i]',
            'input[name*="code" i]',
            'input[id*="code" i]'
        ];

        let codeInput = null;
        for (const selector of codeSelectors) {
            codeInput = await page.$(selector);
            if (codeInput) {
                console.log('Found code input with selector:', selector);
                break;
            }
        }

        if (codeInput) {
            console.log('Entering verification code:', VERIFICATION_CODE);
            await codeInput.fill(VERIFICATION_CODE);
            await sleep(1000);

            // Look for verify button
            const verifyBtn = await page.$('button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Next")');
            if (verifyBtn) {
                console.log('Clicking verify button...');
                await verifyBtn.click();
                await sleep(5000);
            }
        } else {
            console.log('No code input found. Current page content:');
            // List all visible input elements
            const inputs = await page.$$('input:visible');
            console.log('Found', inputs.length, 'visible inputs');
            for (const input of inputs) {
                const type = await input.getAttribute('type');
                const name = await input.getAttribute('name');
                const placeholder = await input.getAttribute('placeholder');
                console.log('  Input:', { type, name, placeholder });
            }
        }

        // Final screenshot
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_final.png' });
        console.log('Final screenshot saved');

        // Keep browser open
        console.log('Keeping browser open for 120 seconds for manual inspection...');
        await sleep(120000);

    } catch (error) {
        console.error('Error:', error.message);
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_error.png' });
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
