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
        slowMo: 200
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    try {
        // First sign into Gmail to establish Google session
        console.log('Step 1: Signing into Google via Gmail...');
        await page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);

        let currentUrl = page.url();
        console.log('Current URL:', currentUrl);

        // Handle sign in
        if (currentUrl.includes('accounts.google.com')) {
            console.log('On sign-in page. Entering credentials...');

            // Wait for and enter email
            try {
                await page.waitForSelector('input[type="email"]', { timeout: 10000 });
                console.log('Entering email...');
                await page.fill('input[type="email"]', EMAIL);

                // Click Next button
                await page.click('#identifierNext, button[type="submit"]');
                await sleep(4000);
            } catch (e) {
                console.log('Email input issue:', e.message);
            }

            // Wait for password field
            try {
                console.log('Waiting for password field...');
                await page.waitForSelector('input[type="password"]', { timeout: 15000 });
                await sleep(1000);
                console.log('Entering password...');
                await page.fill('input[type="password"]', PASSWORD);

                // Click Next button
                await page.click('#passwordNext, button[type="submit"]');
                await sleep(5000);
            } catch (e) {
                console.log('Password input issue:', e.message);
            }

            // Check for 2FA
            currentUrl = page.url();
            console.log('After password, URL:', currentUrl);

            if (currentUrl.includes('challenge') || currentUrl.includes('signin')) {
                console.log('2FA or additional verification needed!');
                console.log('Please check your phone for Google prompt...');

                // Wait for user to complete 2FA
                for (let i = 0; i < 24; i++) {
                    await sleep(5000);
                    currentUrl = page.url();
                    console.log(`Waiting for 2FA... (${i+1}/24) URL: ${currentUrl}`);
                    if (currentUrl.includes('mail.google.com') && !currentUrl.includes('accounts.google.com')) {
                        console.log('2FA completed - now in Gmail!');
                        break;
                    }
                }
            }
        }

        // Take screenshot
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_step1.png' });
        console.log('Screenshot saved: gvoice_step1.png');

        // Now navigate to Google Voice
        console.log('Step 2: Navigating to Google Voice...');
        await page.goto('https://voice.google.com/u/0/calls', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000);

        currentUrl = page.url();
        console.log('Google Voice URL:', currentUrl);

        // Take screenshot
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_step2.png' });
        console.log('Screenshot saved: gvoice_step2.png');

        // If on workspace page, click Sign in button
        if (currentUrl.includes('workspace.google.com')) {
            console.log('Still on workspace page, clicking Sign in...');
            try {
                // The Sign in button should be visible
                await page.click('a:has-text("Sign in")');
                await sleep(5000);
                currentUrl = page.url();
                console.log('After Sign in click:', currentUrl);
            } catch (e) {
                console.log('Could not click Sign in:', e.message);
            }
        }

        // Check if we're in Voice setup flow
        console.log('Step 3: Looking for verification input...');
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_step3.png' });

        // Log all visible inputs
        const inputs = await page.$$('input:visible');
        console.log('Visible inputs:', inputs.length);
        for (let i = 0; i < inputs.length; i++) {
            const type = await inputs[i].getAttribute('type');
            const name = await inputs[i].getAttribute('name');
            const id = await inputs[i].getAttribute('id');
            const placeholder = await inputs[i].getAttribute('placeholder');
            const ariaLabel = await inputs[i].getAttribute('aria-label');
            console.log(`  Input ${i}: type=${type}, name=${name}, id=${id}, placeholder=${placeholder}, aria-label=${ariaLabel}`);
        }

        // Try to find and fill verification code
        const codeSelectors = [
            'input[type="tel"]',
            'input[maxlength="6"]',
            'input[aria-label*="verification" i]',
            'input[aria-label*="code" i]',
            'input[placeholder*="code" i]',
            'input[name*="verificationCode"]',
            'input[type="number"]'
        ];

        for (const selector of codeSelectors) {
            const input = await page.$(selector);
            if (input) {
                const isVisible = await input.isVisible();
                if (isVisible) {
                    console.log('Found visible code input with selector:', selector);
                    await input.fill(VERIFICATION_CODE);
                    console.log('Entered code:', VERIFICATION_CODE);
                    await sleep(2000);

                    // Look for submit button
                    const buttons = await page.$$('button:visible');
                    for (const btn of buttons) {
                        const text = await btn.textContent();
                        console.log('Button:', text.trim());
                    }

                    await page.click('button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Next")').catch(() => null);
                    break;
                }
            }
        }

        // Final screenshot
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_final.png' });
        console.log('Final screenshot saved');

        // Keep browser open for manual inspection
        console.log('Browser staying open for 180 seconds for manual inspection...');
        console.log('You can manually navigate and enter the code if needed.');
        await sleep(180000);

    } catch (error) {
        console.error('Error:', error.message);
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_error.png' });
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
