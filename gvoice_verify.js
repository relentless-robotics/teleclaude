const { chromium } = require('playwright');

const VERIFICATION_CODE = '788494';
const TARGET_NUMBER = '(407) 308-5584';
const EMAIL = 'relentlessrobotics@gmail.com';
const PASSWORD = 'Relaxing41!';

async function sendDiscordUpdate(message) {
    console.log('[UPDATE]', message);
}

async function main() {
    console.log('Starting Google Voice verification...');
    await sendDiscordUpdate('Launching browser...');

    const browser = await chromium.launch({
        headless: false,
        slowMo: 500
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    try {
        // First go to Google accounts to sign in
        console.log('Navigating to Google Sign In...');
        await sendDiscordUpdate('Navigating to Google Sign In...');
        await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        let currentUrl = page.url();
        console.log('Current URL:', currentUrl);

        // Check if already signed in or need to sign in
        if (currentUrl.includes('accounts.google.com')) {
            console.log('On sign in page...');
            await sendDiscordUpdate('Signing into Google account...');

            // Enter email
            const emailInput = await page.$('input[type="email"]');
            if (emailInput) {
                await emailInput.fill(EMAIL);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(3000);
            }

            // Enter password
            await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => null);
            const passwordInput = await page.$('input[type="password"]');
            if (passwordInput) {
                await passwordInput.fill(PASSWORD);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(5000);
            }

            // Check for 2FA
            currentUrl = page.url();
            if (currentUrl.includes('challenge') || currentUrl.includes('signin/v2')) {
                await sendDiscordUpdate('2FA may be required - please tap YES on your phone/tablet if prompted!');
                console.log('Waiting for potential 2FA approval...');
                await page.waitForTimeout(15000);
            }
        }

        // Now navigate to Google Voice
        console.log('Navigating to Google Voice app...');
        await sendDiscordUpdate('Navigating to Google Voice app...');
        await page.goto('https://voice.google.com/u/0/about', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        currentUrl = page.url();
        console.log('Current URL:', currentUrl);

        // Check if we need to sign in
        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
            console.log('Need to sign in...');
            await sendDiscordUpdate('Signing into Google account...');

            // Enter email
            const emailInput = await page.$('input[type="email"]');
            if (emailInput) {
                await emailInput.fill(EMAIL);
                await page.click('button:has-text("Next"), #identifierNext');
                await page.waitForTimeout(3000);
            }

            // Enter password
            const passwordInput = await page.$('input[type="password"]');
            if (passwordInput) {
                await passwordInput.fill(PASSWORD);
                await page.click('button:has-text("Next"), #passwordNext');
                await page.waitForTimeout(5000);
            }

            // Check for 2FA
            const twoFactorPage = await page.$('text="2-Step Verification"');
            if (twoFactorPage) {
                await sendDiscordUpdate('2FA required - please tap YES on your phone/tablet!');
                console.log('Waiting for 2FA approval...');
                await page.waitForTimeout(30000);
            }
        }

        // Now we should be on Google Voice
        console.log('Checking for verification code input...');
        await sendDiscordUpdate('Looking for verification code input field...');
        await page.waitForTimeout(3000);

        // Take a screenshot to see current state
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_screenshot.png' });
        console.log('Screenshot saved');

        // Look for verification code input
        const codeInput = await page.$('input[type="tel"], input[type="text"][maxlength="6"], input[aria-label*="code"], input[placeholder*="code"]');
        if (codeInput) {
            console.log('Found code input, entering verification code...');
            await sendDiscordUpdate('Entering verification code: ' + VERIFICATION_CODE);
            await codeInput.fill(VERIFICATION_CODE);
            await page.waitForTimeout(1000);

            // Click verify/confirm button
            const verifyBtn = await page.$('button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit")');
            if (verifyBtn) {
                await verifyBtn.click();
                await page.waitForTimeout(5000);
                await sendDiscordUpdate('Clicked verify button, waiting for confirmation...');
            }
        } else {
            console.log('No code input found on page, checking page content...');
            const pageContent = await page.content();

            // Try alternative selectors
            const allInputs = await page.$$('input');
            console.log('Found', allInputs.length, 'input fields');

            for (let i = 0; i < allInputs.length; i++) {
                const type = await allInputs[i].getAttribute('type');
                const placeholder = await allInputs[i].getAttribute('placeholder');
                console.log(`Input ${i}: type=${type}, placeholder=${placeholder}`);
            }
        }

        // Check if setup completed
        await page.waitForTimeout(5000);
        const successIndicator = await page.$('text="' + TARGET_NUMBER + '"');
        if (successIndicator) {
            await sendDiscordUpdate('SUCCESS! Google Voice number ' + TARGET_NUMBER + ' is now active!');
        }

        // Keep browser open for inspection
        console.log('Keeping browser open for 60 seconds...');
        await page.waitForTimeout(60000);

    } catch (error) {
        console.error('Error:', error.message);
        await sendDiscordUpdate('Error occurred: ' + error.message);
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gvoice_error.png' });
    } finally {
        await browser.close();
    }
}

main().catch(console.error);
