const { chromium } = require('playwright');
const path = require('path');

async function setupVoiceWithStealth() {
    console.log("[STATUS] Launching browser with stealth settings...");

    // Use a fresh user data directory
    const userDataDir = path.join(__dirname, 'browser-data-stealth2');

    // Launch without channel to use Playwright's Chromium
    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        slowMo: 200,
        viewport: { width: 1280, height: 800 },
        args: [
            '--start-maximized',
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = browser.pages()[0] || await browser.newPage();

    // Remove automation indicators
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    async function screenshot(name) {
        await page.screenshot({ path: `./screenshots/s2_${name}.png`, fullPage: true });
        console.log(`[SCREENSHOT] s2_${name}.png`);
    }

    try {
        // Go directly to Google sign-in
        console.log("[STEP 1] Navigating to Google Sign-In...");
        await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        await screenshot('01_signin');

        // Check for email input
        const emailInput = await page.$('input[type="email"]');
        if (emailInput) {
            console.log("[STATUS] Entering email...");
            await emailInput.click();
            await page.waitForTimeout(500);

            // Type email character by character
            const email = 'relentlessrobotics@gmail.com';
            for (const char of email) {
                await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
            }

            await page.waitForTimeout(1000);
            await screenshot('02_email');

            // Click next
            await page.click('#identifierNext');
            await page.waitForTimeout(5000);
            await screenshot('03_after_email');
        }

        // Check for password
        let pageText = await page.textContent('body');

        // Handle blocked state
        if (pageText.includes("Couldn't sign you in") || pageText.includes('browser or app may not be secure')) {
            console.log("\n[BLOCKED] Google blocked automated sign-in.");
            console.log("[INFO] Please sign in manually in the browser window.");
            console.log("[WAITING] Waiting 2 minutes for you to sign in...");
            await screenshot('blocked');

            // Wait for manual sign-in
            for (let i = 0; i < 24; i++) {
                await page.waitForTimeout(5000);
                const url = page.url();

                if (url.includes('myaccount.google.com') || url.includes('voice.google.com')) {
                    console.log("[SUCCESS] Sign-in detected!");
                    break;
                }

                // Refresh page content check
                try {
                    pageText = await page.textContent('body');
                    if (!pageText.includes("Couldn't sign you in")) {
                        console.log("[STATUS] Page changed, checking...");
                    }
                } catch (e) {}

                if (i % 6 === 0 && i > 0) {
                    console.log(`[WAITING] ${i * 5}s elapsed... please sign in manually`);
                }
            }
        }

        // Try to enter password if we got past email
        const pwdInput = await page.$('input[type="password"]');
        if (pwdInput) {
            console.log("[STATUS] Entering password...");
            await pwdInput.click();
            await page.waitForTimeout(500);

            const password = 'Relaxing41!';
            for (const char of password) {
                await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
            }

            await page.waitForTimeout(1000);
            await screenshot('04_password');

            await page.click('#passwordNext');
            await page.waitForTimeout(6000);
            await screenshot('05_after_pass');
        }

        // Check for 2FA
        pageText = await page.textContent('body');
        if (pageText.includes('2-Step') || pageText.includes('Verify it')) {
            console.log("\n[2FA] Please tap 'Yes' on your phone!");
            await screenshot('2fa');

            for (let i = 0; i < 24; i++) {
                await page.waitForTimeout(5000);
                pageText = await page.textContent('body');
                if (!pageText.includes('2-Step') && !pageText.includes('Verify it')) {
                    console.log("[SUCCESS] 2FA approved!");
                    break;
                }
            }
        }

        // Navigate to Voice
        console.log("\n[STEP 2] Going to Google Voice...");
        await page.goto('https://voice.google.com/signup', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);
        await screenshot('06_voice');

        const voiceUrl = page.url();
        console.log("[URL] " + voiceUrl);

        // If still need to sign in for Voice specifically
        if (voiceUrl.includes('accounts.google.com/signin')) {
            console.log("[INFO] Need to complete sign-in for Voice access.");
            console.log("[INFO] Please complete sign-in in the browser window.");
        }

        if (voiceUrl.includes('voice.google.com') && !voiceUrl.includes('workspace')) {
            console.log("[SUCCESS] Reached Google Voice!");

            pageText = await page.textContent('body');
            if (pageText.includes('Select') || pageText.includes('Choose') || pageText.includes('Get')) {
                console.log("[STATUS] Number selection available!");

                // Look for search input
                const searchInputs = await page.$$('input');
                for (const input of searchInputs) {
                    const ph = await input.getAttribute('placeholder') || '';
                    const al = await input.getAttribute('aria-label') || '';

                    if (ph.toLowerCase().includes('city') || ph.toLowerCase().includes('area') ||
                        al.toLowerCase().includes('search') || al.toLowerCase().includes('city')) {

                        console.log("[FOUND] Search input!");
                        await input.click();
                        await input.fill('305');
                        await page.keyboard.press('Enter');
                        await page.waitForTimeout(3000);
                        await screenshot('07_search');
                        break;
                    }
                }

                // Look for number options
                const options = await page.$$('[role="option"], [role="listitem"]');
                console.log(`[INFO] Found ${options.length} number options`);

                if (options.length > 0) {
                    console.log("[STATUS] Selecting first number...");
                    await options[0].click();
                    await page.waitForTimeout(2000);

                    // Click select button
                    const selectBtn = await page.$('button:has-text("Select")');
                    if (selectBtn) {
                        await selectBtn.click();
                        await page.waitForTimeout(2000);
                    }
                    await screenshot('08_selected');
                }

                // Handle phone verification
                const phoneInput = await page.$('input[type="tel"]');
                if (phoneInput) {
                    console.log("[STATUS] Entering verification phone...");
                    await phoneInput.fill('5618433551');

                    const sendBtn = await page.$('button:has-text("Send code")');
                    if (sendBtn) {
                        await sendBtn.click();
                        await page.waitForTimeout(3000);
                        console.log("[ACTION] Verification code sent! Check your phone.");
                    }
                    await screenshot('09_verification');
                }
            }
        }

        await screenshot('10_final');
        console.log("\n[INFO] Browser staying open for 5 minutes...");
        await page.waitForTimeout(300000);

    } catch (error) {
        console.log("\n[ERROR] " + error.message);
        await screenshot('error');
        await page.waitForTimeout(120000);
    } finally {
        await browser.close();
    }
}

setupVoiceWithStealth();
